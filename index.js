// index.js
import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import http from 'http';
import { createClient as createDG } from '@deepgram/sdk';

const {
  DEEPGRAM_API_KEY,
  PORT = 3000,
  // you’ll wire in PLIVO_WS_URL when you switch to half-duplex
} = process.env;

if (!DEEPGRAM_API_KEY) {
  console.error('❌ Missing DEEPGRAM_API_KEY');
  process.exit(1);
}

// — Express + WebSocket setup —
const app = express();
const server = http.createServer(app);
expressWs(app, server);

// — 1) STT listener for inbound audio —
// Plivo will connect here with your caller’s audio
app.ws('/listen', (plivoWs) => {
  console.log('🔗 STT WebSocket connected');

  // As soon as you want to speak back, call sendTTS(plivoWs, text)
  // e.g. in response to an STT-turn-complete event

  plivoWs.on('message', msg => {
    // parse Deepgram STT messages if you forward them here
  });

  plivoWs.on('close', () => console.log('❌ STT WebSocket disconnected'));
});

// — 2) sendTTS helper — streams Deepgram TTS chunks into Plivo WS —
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
  }
  // once done, you may send a 'flush' event if Plivo needs it:
  plivoWs.send(JSON.stringify({ event: 'flush' }));
}

// — 3) Demo TTS on startup to prove low latency — remove once integrated —
async function testTTS() {
  console.log('🔌 Connecting to Deepgram TTS test…');
  // we won’t pipe that into Plivo here, just log
  const dg = createDG(DEEPGRAM_API_KEY);
  const res = await dg.speak.request(
    { text: 'Hello, low latency test.' },
    { model: 'aura-2-thalia-en', streaming: true }
  );
  let total = 0;
  for await (const chunk of await res.getStream()) {
    total += chunk.length;
    console.log(`▶️  Chunk: ${chunk.length} bytes (total ${total})`);
  }
  console.log('✅ Test stream ended');
}
testTTS().catch(console.error);

// — 4) Start server —
server.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`   • STT WS at ws://localhost:${PORT}/listen`);
});
