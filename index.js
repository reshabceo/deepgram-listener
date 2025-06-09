// index.js
import 'dotenv/config';
import express from 'express';
import { createClient } from '@deepgram/sdk';
import { WebSocketServer } from 'ws';   // ← import the server class
import WebSocket from 'ws';             // ← import the client/websocket class
import axios from 'axios';

const app = express();
const port = process.env.PORT || 3000;

// ————————————————————————————————————————————————————————————————
// 1) Deepgram STT WebSocket server
// ————————————————————————————————————————————————————————————————
const server = app.listen(port, () => {
  console.log(`✅ Deepgram STT listener running on ws://localhost:${port}/`);
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🔗 STT WebSocket connected');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.channel?.alternatives?.length) {
        console.log('📝 Transcript:', msg.channel.alternatives[0].transcript);
      }
    } catch (err) {
      console.error('❌ STT parse error:', err);
    }
  });

  ws.on('close', () => console.log('❌ STT WebSocket disconnected'));
});

// keep alive
setInterval(() => {}, 1e6);



// ————————————————————————————————————————————————————————————————
// 2) Test Deepgram streaming TTS
// ————————————————————————————————————————————————————————————————
async function testStreamingTTS() {
  const DG_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DG_KEY) {
    console.error('❌ Please set DEEPGRAM_API_KEY in your .env');
    process.exit(1);
  }

  console.log('🔌 Connecting to Deepgram TTS WebSocket…');
  const dg = createClient(DG_KEY);
  const resp = await dg.speak.request(
    { text: 'Hello, this is a low-latency TTS test.' },
    { model: 'aura-2-thalia-en', streaming: true }
  );

  const stream = await resp.getStream();
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      console.log(`▶️ Got ${chunk.length} bytes (total ${total})`);
    }
    console.log('✅ Stream ended, total bytes:', total);
  } catch (err) {
    console.error('🚨 Stream error:', err);
  }
}

testStreamingTTS().catch(console.error);
