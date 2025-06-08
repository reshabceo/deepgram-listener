// index.js
import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';
import plivo from 'plivo';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

// Setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TTS_DIR = path.join(__dirname, 'tts-audio');
await fs.mkdir(TTS_DIR, { recursive: true });

const app = express();
const server = app.listen(process.env.PORT || 8080, () => {
  console.log('✅ Turn-based Voice Agent running');
});
expressWs(app, server);

// In-memory call state (replace with DB for prod)
const conversationState = {}; // { [callId]: { turn: n, ttsByTurn: { turn: filename } } }

// ENV checks
['PLIVO_AUTH_ID','PLIVO_AUTH_TOKEN','DEEPGRAM_API_KEY','BASE_URL'].forEach(key => {
  if (!process.env[key]) throw new Error('Missing env: ' + key);
});

const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// TTS utility
async function generateTTSFile(text, callId, turn) {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);
  const filename = `${callId}-turn${turn}.wav`;
  const filepath = path.join(TTS_DIR, filename);
  const response = await dg.speak.request({ text }, { model: 'aura-2-thalia-en', encoding: 'mulaw', sample_rate: 8000, container: 'wav' });
  const audioData = await response.arrayBuffer();
  await fs.writeFile(filepath, Buffer.from(audioData));
  return filename;
}

// Serve TTS files
app.get('/tts-audio/:filename', (req, res) => {
  const filepath = path.join(TTS_DIR, req.params.filename);
  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(filepath);
});

// Plivo XML TURN-BY-TURN: /plivo-xml?call_uuid=...&turn=...
app.all('/plivo-xml', async (req, res) => {
  const callId = req.query.call_uuid || req.body.CallUUID;
  let turn = parseInt(req.query.turn || '1');
  if (!callId) return res.status(400).send('Missing call_uuid');
  if (!conversationState[callId]) conversationState[callId] = { turn: 1, ttsByTurn: {} };
  const ttsFile = conversationState[callId].ttsByTurn[turn - 1]; // previous AI reply for this turn
  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');

  if (ttsFile) {
    // Play AI's reply, then redirect to listen for next user turn
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Play>${baseUrl}/tts-audio/${ttsFile}</Play>
        <Redirect>${baseUrl}/plivo-xml?call_uuid=${callId}&turn=${turn + 1}</Redirect>
      </Response>
    `);
    conversationState[callId].turn = turn + 1;
  } else {
    // Listen for user
    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Stream bidirectional="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000">
          wss://${baseUrl.replace(/^https?:\/\//,'')}/listen?call_uuid=${callId}&turn=${turn}
        </Stream>
      </Response>
    `);
  }
});

// WebSocket for Plivo to send user audio, Deepgram does STT
app.ws('/listen', async (ws, req) => {
  const callId = req.query.call_uuid;
  const turn = parseInt(req.query.turn || '1');
  if (!callId) return ws.close();
  if (!conversationState[callId]) conversationState[callId] = { turn: 1, ttsByTurn: {} };

  const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
  const dgConn = dgClient.listen.live({ model: 'nova-3', language: 'en-US', encoding: 'mulaw', sample_rate: 8000 });

  let userTranscript = '';
  let lastTranscriptTime = Date.now();

  dgConn.on(LiveTranscriptionEvents.Transcript, async data => {
    if (!data.is_final) return;
    const txt = (data.channel.alternatives[0].transcript || '').trim();
    if (!txt) return;
    userTranscript += txt + ' ';
    lastTranscriptTime = Date.now();
    // After transcript received, close WebSocket to end user turn
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      dgConn.finish();
    }, 500); // Give a short pause before closing
    // Generate AI reply (use GPT or canned text)
    const aiReply = await generateAIReply(callId, turn, userTranscript.trim());
    const ttsFile = await generateTTSFile(aiReply, callId, turn);
    conversationState[callId].ttsByTurn[turn] = ttsFile;
  });

  ws.on('message', msg => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.event === 'media' && d.media?.payload) {
        dgConn.send(Buffer.from(d.media.payload, 'base64'));
      }
    } catch (e) {}
  });
  ws.on('close', () => { dgConn.finish(); });
});

// AI reply (replace with OpenAI if you want)
async function generateAIReply(callId, turn, userText) {
  // You can replace this section with OpenAI fetch if you want
  return `You said: ${userText}. This is turn ${turn}.`;
}

// Clean up old TTS files every hour
setInterval(async () => {
  const files = await fs.readdir(TTS_DIR);
  const now = Date.now();
  for (const file of files) {
    const filepath = path.join(TTS_DIR, file);
    const stats = await fs.stat(filepath);
    if (now - stats.mtimeMs > 3600000) await fs.unlink(filepath);
  }
}, 3600000);

// Health
app.get('/', (req, res) => res.send('Turn-based Voice Agent running.'));

// --- Initiate call (optional utility for testing) ---
app.post('/api/calls/initiate', async (req, res) => {
  try {
    const { from, to, appId } = req.body;
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const answerUrl = `${baseUrl}/plivo-xml`;
    const opts = { answerMethod: 'GET' };
    if (appId) opts.applicationId = appId;
    const result = await plivoClient.calls.create(from, to, answerUrl, opts);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
