import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import fetch from 'node-fetch';
import plivo from 'plivo';
import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Dir helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TTS_DIR = path.join(__dirname, 'tts-audio');
await fs.mkdir(TTS_DIR, { recursive: true });

dotenv.config();

const requiredEnvVars = [
  'DEEPGRAM_API_KEY', 'OPENAI_API_KEY',
  'PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN',
  'BASE_URL'
];
for (const v of requiredEnvVars) {
  if (!process.env[v]) {
    console.error(`Missing env var: ${v}`);
    process.exit(1);
  }
}

const app = express();
const server = http.createServer(app);
expressWs(app, server);
const port = process.env.PORT || 8080;

// In-memory context (if you want DB, wire up here)
const conversations = {};

function getTurnState(callId) {
  if (!conversations[callId]) conversations[callId] = { turn: 1, lastUtterance: "" };
  return conversations[callId];
}

async function generateTTSFile(text, callId, turn) {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);
  const filename = `${callId}-turn${turn}.wav`;
  const filepath = path.join(TTS_DIR, filename);

  const response = await dg.speak.request({ text }, {
    model: 'aura-2-thalia-en',
    encoding: 'mulaw',
    sample_rate: 8000,
    container: 'wav'
  });
  const audioData = await response.arrayBuffer();
  await fs.writeFile(filepath, Buffer.from(audioData));
  return filename;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve TTS audio
app.get('/tts-audio/:filename', async (req, res) => {
  try {
    const filepath = path.join(TTS_DIR, req.params.filename);
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(filepath);
  } catch (e) {
    res.status(500).send('Error serving file');
  }
});

// Plivo XML Handler
app.all('/plivo-xml', async (req, res) => {
  const callId = req.query.call_uuid || req.body.CallUUID || "";
  const turn = parseInt(req.query.turn || "1");
  const state = req.query.state || "listen"; // listen OR play
  const filename = req.query.audio || "";

  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');

  let xml = "";

  if (state === "play" && filename) {
    // Play TTS and redirect to listen
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts-audio/${filename}</Play>
  <Redirect>${baseUrl}/plivo-xml?call_uuid=${callId}&turn=${turn+1}&state=listen</Redirect>
</Response>`;
  } else {
    // Listen (default)
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000">
    wss://${baseUrl.replace(/^https?:\/\//, '')}/listen?call_uuid=${callId}&turn=${turn}
  </Stream>
</Response>`;
  }
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// Plivo WebSocket "listen" endpoint for user speech
app.ws('/listen', async (plivoWs, req) => {
  const callId = req.query.call_uuid;
  let turn = parseInt(req.query.turn || "1");
  if (!callId) return plivoWs.close();

  // Start Deepgram Live Transcription
  const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
  const dgConn = dgClient.listen.live({ model: 'nova-3', language: 'en-US', encoding: 'mulaw', sample_rate: 8000 });

  let userUtterance = "";

  dgConn.on(LiveTranscriptionEvents.Transcript, async data => {
    if (data.is_final) {
      userUtterance += (data.channel.alternatives[0].transcript + " ");
      // End of turn: close ws to Plivo to move forward
      plivoWs.close();
    }
  });

  plivoWs.on('message', msg => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.event === 'media' && d.media?.payload) {
        dgConn.send(Buffer.from(d.media.payload, 'base64'));
      }
    } catch {}
  });

  plivoWs.on('close', async () => {
    dgConn.finish();
    // On stream close, save and respond to user utterance (if any)
    userUtterance = userUtterance.trim();
    if (!userUtterance) userUtterance = "I didn't hear anything. How can I help?";
    conversations[callId] = { turn, lastUtterance: userUtterance };

    // Call OpenAI for AI response
    const messages = [
      { role: "system", content: "You are a professional, friendly AI assistant for phone calls." },
      { role: "user", content: userUtterance }
    ];
    let aiText = "Sorry, I didn't get that. Can you repeat?";
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: "gpt-3.5-turbo", messages, max_tokens: 80 })
      });
      const data = await res.json();
      aiText = (data.choices?.[0]?.message?.content || aiText).trim();
    } catch (e) {}

    // Generate TTS file
    const ttsFile = await generateTTSFile(aiText, callId, turn);

    // Instruct Plivo (via <Redirect>) to /plivo-xml with state=play and the audio filename
    // You must trigger this as the next XML when Plivo hits the redirect.
    // Nothing to send here, just wait for the <Redirect> flow.
  });
});

// Call Initiation (use this to start a call)
app.post('/api/calls/initiate', async (req, res) => {
  try {
    const { from, to, appId } = req.body;
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const answerUrl = `${baseUrl}/plivo-xml`;
    const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

    const resp = await plivoClient.calls.create(
      from, to, answerUrl, { answerMethod: "GET", applicationId: appId }
    );
    res.json({ success: true, requestId: resp.requestUuid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/', (req, res) => res.send('OK'));

server.listen(port, () => console.log(`✅ AI Voice Agent running on port ${port}`));
