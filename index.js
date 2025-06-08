// Test deploy: should see this in logs!
require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const { Deepgram } = require('@deepgram/sdk');
const plivo = require('plivo');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const axios = require('axios');

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY',
  'PLIVO_AUTH_ID',
  'PLIVO_AUTH_TOKEN',
  'BASE_URL'
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Express + WebSocket
const app = express();
const wsInstance = expressWs(app);

// Body parser + request log
app.use(express.json());
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  next();
});

const port = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Plivo client
const plivoClient = new plivo.Client(
  process.env.PLIVO_AUTH_ID,
  process.env.PLIVO_AUTH_TOKEN
);

// Deepgram client
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);

// System prompt
const SYSTEM_PROMPT = `You are a voice-based AI assistant. Keep responses brief, natural, and professional.`;

// Fallbacks
const FALLBACK_RESPONSES = [
  "Hello, I can hear you.",
  "Yes, I'm listening.",
  "Please go ahead.",
  "I understand."
];

// --- Conversation Manager ---
class ConversationManager {
  constructor() { this.contexts = new Map(); }
  async init(callId) {
    this.contexts.set(callId, [{ role: 'system', content: SYSTEM_PROMPT }]);
    await supabase.from('conversations').insert([{ call_id: callId, start_time: new Date().toISOString(), status: 'active' }]);
    console.log('🎯 Context initialized for', callId);
  }
  get(callId) { return this.contexts.get(callId); }
  async add(callId, role, content) {
    const ctx = this.get(callId);
    if (!ctx) return;
    ctx.push({ role, content });
    if (ctx.length > 10) ctx.splice(1, ctx.length - 10);
  }
}
const conversationManager = new ConversationManager();

// --- AI & TTS Helpers ---
async function generateAIResponse(callId, userText) {
  await conversationManager.add(callId, 'user', userText);
  const messages = conversationManager.get(callId);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: 'gpt-3.5-turbo', messages, max_tokens:100, temperature:0.7 })
    });
    const json = await res.json();
    const aiText = json.choices?.[0]?.message?.content?.trim() || FALLBACK_RESPONSES[0];
    await conversationManager.add(callId, 'assistant', aiText);
    return aiText;
  } catch (e) {
    console.error('❌ OpenAI error:', e);
    return FALLBACK_RESPONSES[0];
  }
}

async function sendTTS(plivoWs, text) {
  try {
    // HTTP TTS from Deepgram
    const [{ data: audioBuffer }] = await Promise.all([
      axios.post('https://api.deepgram.com/v1/text-to-speech', { model:'aura-2-thalia-en', text }, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
        responseType: 'arraybuffer'
      })
    ]);
    // Stream to Plivo
    const chunk = audioBuffer.toString('base64');
    plivoWs.send(JSON.stringify({ event:'media', media:{ payload:chunk } }));
    console.log('🔊 Sent TTS to Plivo');
  } catch (e) {
    console.error('❌ TTS error:', e);
  }
}

// --- WebSocket /listen Handler ---
app.ws('/listen', async (plivoWs, req) => {
  const callId = req.query.call_uuid;
  if (!callId) return plivoWs.close();
  console.log('📞 /listen connected for', callId);

  // Init context & send greeting
  await conversationManager.init(callId);
  await sendTTS(plivoWs, 'Hello, this is your AI assistant. How may I help you?');

  // Open Deepgram live transcription
  const dgSocket = deepgram.transcription.live({
    encoding:'mulaw', sample_rate:8000, punctuate:true, model:'general', language:'en-US'
  });

  dgSocket.addListener('open', () => console.log('✅ Deepgram connected'));

  dgSocket.addListener('transcriptReceived', async (socketRes) => {
    const text = socketRes.alternatives?.[0]?.transcript?.trim();
    if (!text) return;
    console.log('🗣️ Transcript:', text);
    const aiText = await generateAIResponse(callId, text);
    console.log('🤖 AI:', aiText);
    await sendTTS(plivoWs, aiText);
  });

  dgSocket.addListener('error', e => console.error('❌ Deepgram WS error:', e));
  dgSocket.addListener('close', () => console.log('🔌 Deepgram WS closed'));

  // Forward incoming audio
  plivoWs.on('message', msg => {
    const data = JSON.parse(msg.toString());
    if (data.event === 'media' && data.media?.payload) {
      dgSocket.send(Buffer.from(data.media.payload, 'base64'));
    }
  });

  plivoWs.on('close', () => {
    console.log('📞 Plivo WS closed');
    dgSocket.close();
    supabase.from('conversations').update({ status:'completed' }).eq('call_id', callId).then();
  });
});

// --- HTTP Routes ---
app.post('/api/calls/initiate', async (req, res) => {
  console.log('🔥 POST /api/calls/initiate', req.body);
  const { from, to, appId } = req.body;
  if (!from || !to) return res.status(400).json({ error:'Missing from/to' });
  const fFrom = from.startsWith('+')?from:`+${from}`;
  const fTo   = to.startsWith('+')?to:`+${to}`;
  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
  try {
    const resp = await plivoClient.calls.create(fFrom, fTo, `${baseUrl}/plivo-xml`, { answerMethod:'GET' });
    console.log('✅ Call started', resp.requestUuid);
    res.json({ success:true, uuid:resp.requestUuid });
  } catch (e) {
    console.error('❌ Plivo call error:', e);
    res.status(500).json({ error:'Call failed' });
  }
});

app.all('/plivo-xml', (req, res) => {
  const callUUID = req.query.CallUUID;
  const host = process.env.BASE_URL.replace(/https?:\/\//, '').replace(/\/$/, '');
  const xml = `<?xml version="1.0"?>
<Response>
  <Stream
    contentType="audio/x-mulaw;rate=8000"
    bidirectional="true"
    statusCallbackUrl="${process.env.BASE_URL}/api/stream-status"
  >wss://${host}/listen?call_uuid=${callUUID}</Stream>
</Response>`;
  res.set('Content-Type','text/xml').send(xml);
});

app.post('/api/stream-status', (req, res) => {
  console.log('🔄 STREAM STATUS', req.body);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('✅ Server alive'));

// 404 & error
app.use((req,res)=>res.status(404).send('Not found'));
app.use((err,req,res,next)=>{ console.error(err); res.status(500).send('Server error'); });

app.listen(port, () => console.log(`🚀 Listening on port ${port}`));
