const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', function connection(ws) {
  console.log('🔗 WebSocket connected');

  ws.on('message', async function incoming(data) {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.channel && parsed.channel.alternatives) {
        const transcript = parsed.channel.alternatives[0].transcript;
        if (transcript) {
          console.log(`📝 Transcript: ${transcript}`);

          // Send to n8n
          const n8n_webhook_url = "https://bms123.app.n8n.cloud/webhook/deepgram-transcript";

          await axios.post(n8n_webhook_url, {
            transcript: transcript,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      console.error('❌ Error parsing or sending data:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket disconnected');
  });
});

// Keep alive
setInterval(() => {}, 1000);
