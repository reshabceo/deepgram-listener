import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { createClient as createDeepgramClient } from '@deepgram/sdk';
import plivo from 'plivo';
import fetch from 'node-fetch';

// --- Configuration & Setup --------------------------------
const {
  PLIVO_AUTH_ID,
  PLIVO_AUTH_TOKEN,
  PLIVO_FROM_NUMBER,
  PLIVO_TO_NUMBER,
  BASE_URL,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !DEEPGRAM_API_KEY || !OPENAI_API_KEY || !BASE_URL) {
  console.error('❌ Missing one of required env vars: PLIVO_*, DEEPGRAM_API_KEY, OPENAI_API_KEY, BASE_URL');
  process.exit(1);
}

// HTTP + WebSocket server
const app = express();
const server = http.createServer(app);
expressWs(app, server);
app.use(express.json());

// Public TTS directory
const TTS_DIR = path.resolve('public', 'tts');
await fs.mkdir(TTS_DIR, { recursive: true });
app.use('/tts', express.static(path.resolve('public', 'tts')));

// Deepgram & Plivo clients
const dg = createDeepgramClient(DEEPGRAM_API_KEY);
const plivoClient = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);

// --- 1) Pre-generate & cache greeting ----------------------
const GREETING_TEXT = 'Hello, this is your AI assistant. How may I help you today?';
const GREETING_FILE = path.join(TTS_DIR, 'greeting.wav');
async function generateGreeting() {
  try {
    await fs.access(GREETING_FILE);
    console.log('✅ Greeting already cached');
  } catch {
    console.log('🔊 Generating greeting via Deepgram WS TTS...');
    const response = await dg.speak.request(
      { text: GREETING_TEXT },
      { model: 'aura-2-thalia-en', streaming: true }
    );
    const stream = await response.getStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    await fs.writeFile(GREETING_FILE, Buffer.concat(chunks));
    console.log('✅ Greeting saved to', GREETING_FILE);
  }
}
generateGreeting();

// --- 2) Plivo XML: play greeting, then switch to inbound stream ---
app.all('/plivo-xml', (req, res) => {
  const callUUID = req.query.CallUUID;
  const playUrl = `${BASE_URL}/tts/greeting.wav`;
  const wsUrl = `${BASE_URL.replace(/^https?:\/\//, 'wss://')}/listen?call_uuid=${callUUID}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${playUrl}</Play>
  <Stream bidirectional="false" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000" statusCallbackUrl="${BASE_URL}/api/stream-status">
    ${wsUrl}
  </Stream>
</Response>`;
  res.type('text/xml').send(xml);
});

// --- 3) Stream-status logging --------------------------------
app.post('/api/stream-status', express.urlencoded({ extended: true }), (req, res) => {
  console.log('📊 Stream status:', req.body);
  res.sendStatus(200);
});

// --- 4) Initiate outbound call --------------------------------
app.post('/api/call', async (req, res) => {
  try {
    const resp = await plivoClient.calls.create(
      PLIVO_FROM_NUMBER,
      PLIVO_TO_NUMBER,
      `${BASE_URL}/plivo-xml`,
      { answerMethod: 'GET' }
    );
    res.json({ ok: true, resp });
  } catch (err) {
    console.error('❌ Call failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- 5) Listen WS: receive user audio → STT → AI → TTS reply ---
app.ws('/listen', async (ws, req) => {
  const callId = req.query.call_uuid;
  console.log('🔌 WebSocket /listen open for call:', callId);

  // Start Deepgram live STT
  const sttConn = dg.transcription.live({
    model: 'nova-2', language: 'en-US', encoding: 'mulaw', sample_rate: 8000
  });
  sttConn.open();

  sttConn.on('transcript', async data => {
    if (!data.is_final) return;
    const userText = data.channel.alternatives[0].transcript;
    console.log('📝 User said:', userText);

    // 1. Send to OpenAI
    const aiText = await generateAIResponse(userText);
    console.log('🤖 AI will reply:', aiText);

    // 2. Stream TTS reply back to caller via Deepgram WS
    const response = await dg.speak.request(
      { text: aiText },
      { model: 'aura-2-thalia-en', streaming: true }
    );
    const stream = await response.getStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);

    // 3. Save reply file and point Plivo at it
    const filename = `${callId}-${Date.now()}.wav`;
    const filepath = path.join(TTS_DIR, filename);
    await fs.writeFile(filepath, Buffer.concat(chunks));
    await plivoClient.calls.update(callId, {
      answerUrl: `${BASE_URL}/tts/${filename}`,
      answerMethod: 'GET'
    });
  });

  sttConn.on('error', e => console.error('🔴 STT error:', e));
  sttConn.on('close', () => console.log('🔴 STT closed'));

  ws.on('message', msg => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media' && data.media.payload) {
      sttConn.send(Buffer.from(data.media.payload, 'base64'));
    }
  });
  ws.on('close', () => { sttConn.finish(); console.log('🔌 /listen closed'); });
});

// --- 6) OpenAI helper ----------------------------------------
async function generateAIResponse(text) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: text }] })
  });
  const js = await res.json();
  return js.choices[0].message.content;
}

// --- Start server -------------------------------------------
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
