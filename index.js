import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import expressWs from 'express-ws';
import { createClient as createDG } from '@deepgram/sdk';
import WebSocket from 'ws';

const PORT = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;

if (!DG_KEY) {
  console.error('❌ ERROR: set DEEPGRAM_API_KEY in your .env or Railway settings');
  process.exit(1);
}

// ——— 1) Set up Express + express-ws ——————————————————
const app = express();
expressWs(app);

// ——— 2) Deepgram STT listener endpoint —————————————————
app.ws('/listen', (ws, req) => {
  console.log('🔗 STT WebSocket connected');
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg.channel?.alternatives;
      if (alt && alt.length) {
        console.log(`📝 Transcript: "${alt[0].transcript}"`);
      }
    } catch (e) {
      console.error('❌ STT parse error:', e);
    }
  });
  ws.on('close', () => console.log('❌ STT WebSocket disconnected'));
});

// ——— 3) Low-latency Deepgram TTS test on startup —————————
(async function testTTS() {
  console.log('🔌 Connecting to Deepgram TTS WebSocket…');
  const dg = createDG(DG_KEY);

  // streaming:true gives you micro-sized mu-law chunks immediately
  const response = await dg.speak.request(
    { text: 'Hello! This is a low-latency TTS test.' },
    { model: 'aura-2-thalia-en', streaming: true }
  );
  const stream = await response.getStream();

  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    console.log(`▶️  Received TTS chunk: ${chunk.length} bytes  (total ${totalBytes})`);
  }
  console.log('✅ TTS stream ended, total bytes:', totalBytes);
})().catch(err => console.error('🚨 TTS error:', err));

// ——— 4) Start HTTP server ——————————————————————————
app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`    • STT WS at ws://localhost:${PORT}/listen`);
});
