import express from 'express';
import dotenv from 'dotenv';
import plivo from 'plivo';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import expressWs from 'express-ws';
import http from 'http';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const server = http.createServer(app);
expressWs(app, server);

app.use(express.json());

const TTS_DIR = path.join(__dirname, 'tts-audio');
await fs.mkdir(TTS_DIR, { recursive: true });

const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID;
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
const PLIVO_FROM_NUMBER = process.env.PLIVO_FROM_NUMBER;
const PLIVO_TO_NUMBER = process.env.PLIVO_TO_NUMBER;
const BASE_URL = process.env.BASE_URL;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const plivoClient = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);

const GREETING_TEXT = "Hello, this is your AI assistant. How may I help you?";

// Generate greeting file if not present
const greetingFile = path.join(TTS_DIR, 'greeting.mp3');

// Utility functions
async function fileExists(f) {
  try { 
    await fs.access(f); 
    return true; 
  } catch { 
    return false; 
  }
}

// Pre-buffer the greeting audio
let greetingBuffer = null;

// Optimized TTS generation with balanced speed
async function generateGreeting() {
  if (await fileExists(greetingFile)) return;
  
  // Optimized parameters for quality and latency
  const url = new URL('https://api.deepgram.com/v1/speak');
  url.searchParams.append('encoding', 'mp3');
  url.searchParams.append('model', 'aura-asteria-en');
  url.searchParams.append('voice', 'asteria');
  url.searchParams.append('speed', '1.1');  // Balanced speed
  url.searchParams.append('sample_rate', '16000');  // Reduced for faster transfer

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip, deflate'  // Enable compression
    },
    body: JSON.stringify({
      text: GREETING_TEXT
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    console.error("❌ Deepgram TTS error:", resp.status, errorText);
    throw new Error("Deepgram TTS failed: " + errorText);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length < 1000) {
    console.error("❌ TTS audio is too short!");
    throw new Error("Invalid audio generated");
  }

  greetingBuffer = buffer;
  await fs.writeFile(greetingFile, buffer);
  console.log("✅ Greeting TTS MP3 generated, size:", buffer.length, "bytes");
}

// Optimized audio serving with compression
app.get('/tts-audio/greeting.mp3', async (req, res) => {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    if (greetingBuffer) {
      res.setHeader('Content-Length', greetingBuffer.length);
      res.send(greetingBuffer);
      return;
    }
    greetingBuffer = await fs.readFile(greetingFile);
    res.setHeader('Content-Length', greetingBuffer.length);
    res.send(greetingBuffer);
  } catch (error) {
    console.error('❌ Error serving greeting audio:', error);
    res.status(500).send('Error serving audio');
  }
});

// Track call states
const callStates = new Map();

// Optimized Plivo XML with immediate play
app.all('/plivo-xml', (req, res) => {
  const callUUID = req.query.CallUUID || 'call_' + Date.now();
  console.log('📞 New call initiated:', callUUID);
  
  const playUrl = `${BASE_URL}/tts-audio/greeting.mp3`;
  
  // Send headers for faster response
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
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
  
  console.log('📝 Generated Plivo XML');
  res.type('text/xml').send(xml);
});

// Stream status endpoint with enhanced logging
app.post('/api/stream-status', (req, res) => {
  const status = req.body;
  console.log('📊 Stream status update:', {
    callUUID: status.CallUUID,
    status: status.Status,
    timestamp: new Date().toISOString()
  });
  res.sendStatus(200);
});

// Call trigger endpoint
app.post('/api/call', async (req, res) => {
  try {
    const resp = await plivoClient.calls.create(
      PLIVO_FROM_NUMBER,
      PLIVO_TO_NUMBER,
      `${BASE_URL}/plivo-xml`,
      { answerMethod: "GET" }
    );
    res.json({ ok: true, resp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Enhanced WebSocket handling
app.ws('/listen', (ws, req) => {
  const callId = req.query.call_uuid;
  if (!callId) {
    console.log('❌ No call UUID provided for WebSocket');
    return ws.close();
  }
  
  console.log('🔌 WebSocket connected for call:', callId);
  let isAlive = true;
  
  const keepAlive = setInterval(() => {
    if (!isAlive) {
      console.log('💔 Connection dead for call:', callId);
      clearInterval(keepAlive);
      return ws.terminate();
    }
    isAlive = false;
    ws.ping();
  }, 15000);
  
  ws.on('pong', () => {
    isAlive = true;
    console.log('💓 Connection alive for call:', callId);
  });
  
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === 'media' && data.media?.payload) {
        console.log('🎤 Received audio data for call:', callId);
      }
    } catch (e) {
      console.error('❌ Error processing WebSocket message:', e);
    }
  });
  
  ws.on('close', () => {
    console.log('👋 WebSocket closed for call:', callId);
    clearInterval(keepAlive);
  });

  ws.on('error', (error) => {
    console.error('💥 WebSocket error for call:', callId, error);
    clearInterval(keepAlive);
  });
});

// Initialize server with pre-warming
const port = process.env.PORT || 3000;

async function initServer() {
  try {
    // Pre-generate and load greeting
    await generateGreeting();
    if (await fileExists(greetingFile)) {
      greetingBuffer = await fs.readFile(greetingFile);
      console.log('✅ Greeting audio pre-loaded:', greetingBuffer.length, 'bytes');
    }
    
    // Start server
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('❌ Error during initialization:', error);
    // Still start server even if greeting fails
    server.listen(port, () => {
      console.log(`Server running on port ${port} (with errors)`);
    });
  }
}

initServer();
