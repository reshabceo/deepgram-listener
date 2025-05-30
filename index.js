const WebSocket = require('ws');
const axios = require('axios');

const DEEPGRAM_API_KEY = 'c522bf04a9f8242b2275fb39f51c8723026ffa62';
const TRANSCRIPT_WEBHOOK = 'https://bms123.app.n8n.cloud/webhook/deepgram-transcript';
const STATUS_WEBHOOK = 'https://bms123.app.n8n.cloud/webhook/stream-status';

const deepgramSocket = new WebSocket(
  `wss://api.deepgram.com/v1/listen?access_token=${DEEPGRAM_API_KEY}`,
  {
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
    },
  }
);

deepgramSocket.on('open', () => {
  console.log('🟢 Connected to Deepgram WebSocket');
});

deepgramSocket.on('message', async (message) => {
  if (!message.data) {
    console.log('🟠 No data received from Deepgram');
    return;
  }

  try {
    const data = JSON.parse(message.data);
    const transcript = data.channel?.alternatives[0]?.transcript;

    if (transcript && transcript.length > 0) {
      console.log('🧠 Final Transcript:', transcript);
      await axios.post(TRANSCRIPT_WEBHOOK, { transcript });
    }
  } catch (err) {
    console.error('❌ Error parsing message:', err.message);
  }
});

deepgramSocket.on('close', async () => {
  console.log('🔴 Deepgram WebSocket closed');
  try {
    await axios.post(STATUS_WEBHOOK, {
      status: 'disconnected',
      event: 'close',
    });
    console.log('📬 Posted stream-status to n8n');
  } catch (err) {
    console.error('❌ Failed to post stream-status:', err.message);
  }
});

// 🛑 Prevent process from exiting
setInterval(() => {}, 1000);
