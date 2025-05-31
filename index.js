const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
expressWs(app); // ⬅️ this attaches WebSocket support to Express

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});

app.ws('/listen', (ws, req) => {
  console.log('🔗 WebSocket /listen connected');

  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.channel && parsed.channel.alternatives) {
        const transcript = parsed.channel.alternatives[0].transcript;
        if (transcript) {
          console.log(`💬 Transcript: ${transcript}`);

          // Send to n8n
          const n8n_webhook_url = "https://bms123.app.n8n.cloud/webhook/deepgram-transcript";

          await axios.post(n8n_webhook_url, {
            transcript: transcript,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      console.error('❌ Error parsing or sending data:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket /listen disconnected');
  });
});

// 🔁 Prevent Railway from shutting down due to idling
setInterval(() => {}, 1000);
