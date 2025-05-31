const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
expressWs(app); // enable WebSocket on Express

const port = process.env.PORT || 3000;

// ✅ For Railway to show running status
app.get('/', (req, res) => {
  res.send('✅ Deepgram listener is running');
});

// ✅ Serve Plivo XML from here
app.get('/plivo-xml', (req, res) => {
  const xml = `
  <Response>
    <Record 
      action="https://bms123.app.n8n.cloud/webhook/recording"
      redirect="false"
      recordSession="true"
      maxLength="3600" />
    <Stream 
      streamTimeout="3600"
      keepCallAlive="true"
      bidirectional="true"
      contentType="audio/x-mulaw;rate=8000"
      statusCallbackUrl="https://bms123.app.n8n.cloud/webhook/stream-status">
      wss://triumphant-victory-production.up.railway.app/listen
    </Stream>
  </Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(xml.trim());
});

// ✅ Start listener
app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});

// ✅ WebSocket logic
app.ws('/listen', (ws, req) => {
  console.log('📞 WebSocket /listen connected');

  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      console.log('📦 Raw Deepgram Message:', parsed); // 🧪 Log entire payload for debugging

      if (parsed.channel && parsed.channel.alternatives) {
        const transcript = parsed.channel.alternatives[0].transcript;
        if (transcript) {
          console.log(`💬 Transcript: ${transcript}`);

          const n8n_webhook_url = "https://bms123.app.n8n.cloud/webhook/deepgram-transcript";

          await axios.post(n8n_webhook_url, {
            transcript,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.error('❌ Error parsing or sending data:', err);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket /listen disconnected');
  });
});

// ✅ Keep container alive on Railway
setInterval(() => {}, 1000);
