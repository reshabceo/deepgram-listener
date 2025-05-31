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

  // 🔐 Deepgram connection
  const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000', {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });

  // ✅ Receive message from Deepgram
  deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      // ✅ Only process transcription messages
      if (parsed.channel && parsed.channel.alternatives) {
        const transcript = parsed.channel.alternatives[0].transcript;
        if (transcript) {
          console.log(`🗣️ Transcript: ${transcript}`);
          await axios.post("https://bms123.app.n8n.cloud/webhook/deepgram-transcript", {
            transcript,
            timestamp: new Date().toISOString()
          });
        }
      } else if (parsed.type === 'Error') {
        console.error('❌ Deepgram Error:', parsed.description);
      } else {
        console.log('ℹ️ Ignored non-transcript message from Deepgram');
      }

    } catch (e) {
      console.error('❌ JSON parse failed from Deepgram:', e);
    }
  });

  // 🔁 Forward audio from Plivo to Deepgram
  plivoWs.on('message', (msg) => {
  try {
    const parsed = JSON.parse(msg.toString());
    if (parsed.event === 'media' && parsed.media?.payload) {
      const audioBuffer = Buffer.from(parsed.media.payload, 'base64');
      if (deepgramWs.readyState === 1) {
        deepgramWs.send(audioBuffer);
      }
    }
  } catch (e) {
    console.error('❌ Failed to forward audio to Deepgram:', e);
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
