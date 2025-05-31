const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
expressWs(app);

const port = process.env.PORT || 3000;

// ✅ For Railway status check
app.get('/', (req, res) => {
  res.send('✅ Deepgram Listener is running');
});

// ✅ Serve Plivo XML
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

// ✅ WebSocket listener from Plivo
app.ws('/listen', (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');

  // 1️⃣ Open WebSocket to Deepgram
  const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000', {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });

  // 2️⃣ When Deepgram returns a transcript
  deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      // ✅ ADD THIS: Raw message debug
      console.log('📦 Raw Deepgram Message:', parsed);

      const transcript = parsed.channel?.alternatives?.[0]?.transcript;
      if (transcript) {
        console.log(`🗣️ Transcript: ${transcript}`);
        await axios.post("https://bms123.app.n8n.cloud/webhook/deepgram-transcript", {
          transcript,
          timestamp: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error('❌ Deepgram parse error:', e);
    }
  });

  // 3️⃣ Forward Plivo's audio to Deepgram
  plivoWs.on('message', (audioChunk) => {
    if (deepgramWs.readyState === 1) {
      deepgramWs.send(audioChunk);
    }
  });

  plivoWs.on('close', () => {
    console.log('❌ Plivo WebSocket disconnected');
    deepgramWs.close();
  });

  deepgramWs.on('close', () => {
    console.log('❌ Deepgram WebSocket closed');
  });
});

// ✅ Keep Railway container alive
setInterval(() => {}, 1000);

app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});
