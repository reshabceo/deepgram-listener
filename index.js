const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js'); // ✅ Supabase

const app = express();
expressWs(app);

const port = process.env.PORT || 3000;

// ✅ Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

  const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000', {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });

  // 🧠 Smart Grouping Variables
  let transcriptBuffer = '';
  let lastTranscriptTime = Date.now();

  function isFiller(text) {
    return ['uh', 'umm', 'hmm', 'ah', 'eh', 'like', 'you know'].includes(text.toLowerCase().trim());
  }

  function isEndOfSentence(text) {
    return /[.?!]$/.test(text.trim()) || text.toLowerCase().endsWith("okay") || text.toLowerCase().endsWith("right");
  }

  function sendToChatGPT(utterance) {
    // 🔁 Placeholder for GPT call
    console.log("🤖 GPT input:", utterance);
  }

  // ✅ Receive message from Deepgram
  deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.channel?.alternatives) {
        const spokenText = parsed.channel.alternatives[0].transcript;
        if (spokenText) {
          const now = Date.now();
          const timeSinceLast = now - lastTranscriptTime;
          lastTranscriptTime = now;

          console.log("🗣️ Live:", spokenText);

          if (!isFiller(spokenText)) {
            transcriptBuffer += ' ' + spokenText;

            if (timeSinceLast > 1000 || isEndOfSentence(spokenText)) {
              const fullUtterance = transcriptBuffer.trim();
              transcriptBuffer = ''; // Reset buffer

              // ✅ Send to GPT (placeholder)
              sendToChatGPT(fullUtterance);
            }
          }

          // ✅ Send to n8n
          await axios.post("https://bms123.app.n8n.cloud/webhook/deepgram-transcript", {
            transcript: spokenText,
            timestamp: new Date().toISOString()
          });

          // ✅ Store in Supabase
          const { error } = await supabase.from('transcripts').insert([
            {
              transcript: spokenText,
              timestamp: new Date().toISOString(),
              call_id: 'test-call-id'
            }
          ]);
          if (error) console.error('❌ Supabase insert error:', error);
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
