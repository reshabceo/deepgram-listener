// index.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import expressWs from 'express-ws';
import plivo from 'plivo';
import { createClient as createDG } from '@deepgram/sdk';

const {
  PLIVO_AUTH_ID,
  PLIVO_AUTH_TOKEN,
  PLIVO_FROM_NUMBER,
  PLIVO_TO_NUMBER,
  BASE_URL,
  DEEPGRAM_API_KEY
} = process.env;

// — initialize Plivo & Express+WebSocket —
const plivoClient = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);
const app = express();
const server = http.createServer(app);
expressWs(app, server);

app.use(express.json());

// — 1) Trigger a call via Plivo —
app.post('/api/call', async (req, res) => {
  try {
    const resp = await plivoClient.calls.create(
      PLIVO_FROM_NUMBER,
      PLIVO_TO_NUMBER,
      `${BASE_URL}/plivo-xml`,
      { answerMethod: 'GET' }
    );
    res.json({ ok: true, resp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// — 2) Plivo fetches this first: play greeting, then stream inbound —
app.all('/plivo-xml', (req, res) => {
  const callUUID = req.query.CallUUID || `call_${Date.now()}`;
  console.log('📞 New call:', callUUID);

  const playUrl = `${BASE_URL}/tts-audio/greeting.mp3`;  // if you still want a pre-buffered MP3
  // Or you could inline your WebSocket TTS right here…

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Stream
    bidirectional="false"
    audioTrack="inbound"
    contentType="audio/x-mulaw;rate=8000"
    statusCallbackUrl="${BASE_URL}/api/stream-status"
  >wss://${BASE_URL.replace(/^https?:\/\//, '')}/listen?call_uuid=${callUUID}</Stream>
</Response>`;
  res.type('text/xml').send(xml);
});

// — 3) Receive stream status callbacks if you care —
app.post('/api/stream-status', (req, res) => {
  console.log('🎵 Stream status:', req.body);
  res.sendStatus(200);
});

// — 4) Handle the incoming Plivo WebSocket at /listen —
app.ws('/listen', (ws, req) => {
  const callId = req.query.call_uuid;
  console.log('🔗 WebSocket connected for call:', callId);

  // When Plivo sends us caller’s audio:
  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media') {
      // Here you’d forward to Deepgram STT, etc.
      console.log('🎤 got inbound chunk for STT');
    }
  });

  ws.on('close', () => console.log('❌ WS closed for call:', callId));
  ws.on('error', (err) => console.error('💥 WS error:', err));
});

// — 5) Helper to stream Deepgram TTS back into Plivo WS —
async function sendTTS(plivoWs, text) {
  const dg = createDG(DEEPGRAM_API_KEY);
  const response = await dg.speak.request(
    { text },
    { model: 'aura-2-thalia-en', streaming: true }
  );
  const stream = await response.getStream();
  for await (const chunk of stream) {
    plivoWs.send(JSON.stringify({
      event: 'media',
      media: { payload: Buffer.from(chunk).toString('base64') }
    }));
    // you can throttle here if needed
  }
}

// — 6) Launch server —
const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`✅ Server listening on http://0.0.0.0:${port}/`);
});
