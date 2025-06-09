// index.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient as createDGClient } from '@deepgram/sdk';

const PORT = process.env.PORT || 3000;
const DG_KEY = process.env.DEEPGRAM_API_KEY;
if (!DG_KEY) {
  console.error('❌  Missing DEEPGRAM_API_KEY in .env');
  process.exit(1);
}

// 1) Stand up Express + HTTP server
const app = express();
const server = http.createServer(app);

// 2) Deepgram STT WebSocket endpoint (/listen)
const sttWSS = new WebSocketServer({ server, path: '/listen' });

sttWSS.on('connection', (plivoWs) => {
  console.log('🔗  /listen WebSocket connected (awaiting inbound μ-law)');

  // Create Deepgram STT live stream
  const dgClient = createDGClient(DG_KEY);
  const dgStream = dgClient.transcription.live({
    model: 'nova-2',
    language: 'en-US',
    encoding: 'mulaw',
    sample_rate: 8000
  });

  dgStream.on('open',       () => console.log('✅  Deepgram STT open'));
  dgStream.on('close',      () => console.log('🔌  Deepgram STT closed'));
  dgStream.on('error',      (err) => console.error('🚨  Deepgram STT error:', err));
  dgStream.on('transcript', (data) => {
    const alt = data.channel.alternatives[0];
    if (alt.transcript) console.log(`📝 Transcript: "${alt.transcript}"`);
  });

  // Forward incoming Plivo audio → Deepgram STT
  plivoWs.on('message', (msg) => {
    try {
      const pkt = JSON.parse(msg);
      if (pkt.event === 'media' && pkt.media?.payload) {
        const audio = Buffer.from(pkt.media.payload, 'base64');
        dgStream.send(audio);
      }
    } catch (e) {
      console.error('❌  WS parse error:', e);
    }
  });

  plivoWs.on('close', () => {
    dgStream.finish();
    console.log('❌  /listen WS disconnected');
  });
});

// 3) Test Deepgram streaming TTS immediately
(async () => {
  const dg = createDGClient(DG_KEY);
  console.log('🔌  Connecting to Deepgram TTS WebSocket…');
  const response = await dg.speak.request(
    { text: 'Hello, this is a low-latency TTS test.' },
    {
      model: 'aura-2-thalia-en',
      streaming: true,
      encoding: 'mulaw',
      sample_rate: 8000
    }
  );

  const stream = await response.getStream();
  let total = 0;
  stream.on('data', (chunk) => {
    total += chunk.length;
    console.log(`▶️  Got ${chunk.length} bytes  (total ${total})`);
  });
  stream.on('end', () => console.log('✅  TTS stream ended, total bytes:', total));
  stream.on('error', (err) => console.error('🚨  TTS WebSocket error:', err));
})();

// 4) Launch server
server.listen(PORT, () => {
  console.log(`✅  Server listening on http://localhost:${PORT}/`);
  console.log(`    ▶  STT WS at ws://localhost:${PORT}/listen`);
});
