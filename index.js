import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { createClient } from '@deepgram/sdk';

const DG = createClient(process.env.DEEPGRAM_API_KEY);
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

// 1) HTTP endpoint for Plivo to fetch your call-control XML
app.get('/answer', (_req, res) => {
  // This XML tells Plivo to first open a TTS stream, then an STT stream.
  res.type('application/xml').send(`
<Response>
  <!-- outbound = send us "media" events over /tts -->
  <Stream url="wss://${process.env.RAILWAY_STATIC_URL}/tts" track="outbound"/>
  <!-- inbound = Plivo will send caller audio as base64 over /listen -->
  <Stream url="wss://${process.env.RAILWAY_STATIC_URL}/listen" track="inbound"/>
</Response>
  `.trim());
});

// 2) WebSocket server for both TTS and STT, routed by path
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (socket, req) => {
  if (req.url === '/tts') {
    console.log('🔊 Plivo connected for TTS');
    // Kick off a Deepgram streaming-TTS request for your greeting
    const resp = await DG.speak.request(
      { text: 'Hello! Please say something after the beep.' },
      { model: 'aura-2-thalia-en', streaming: true, encoding: 'mulaw', sample_rate: 8000, voice: 'asteria' }
    );
    const stream = await resp.getStream();
    for await (const chunk of stream) {
      // wrap each mulaw buffer in Plivo’s expected JSON:
      socket.send(JSON.stringify({
        event: 'media',
        media: { payload: Buffer.from(chunk).toString('base64') }
      }));
    }
    socket.close();
    console.log('✅ TTS stream complete');
  }

  else if (req.url === '/listen') {
    console.log('🎙️ Plivo connected for STT');
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel?.alternatives?.[0]?.transcript) {
          console.log('📝 Transcript:', msg.channel.alternatives[0].transcript);
        }
      } catch (e) {
        console.error('STT parse error:', e);
      }
    });
    socket.on('close', () => console.log('❌ STT connection closed'));
  }

  else {
    socket.destroy();
  }
});

// route HTTP→WebSocket upgrade events
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (socket) => {
    wss.emit('connection', socket, req);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on http://0.0.0.0:${PORT}/`);
  console.log(`   • STT WS at ws://<host>:${PORT}/listen`);
  console.log(`   • TTS WS at ws://<host>:${PORT}/tts`);
});
