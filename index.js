require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = express();
const wsInstance = expressWs(app);

const port = process.env.PORT || 3000;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 50;
const requestTimestamps = [];

// System prompt for AI
const SYSTEM_PROMPT = `You are a helpful phone assistant. Keep responses brief, natural, and focused. You should be professional but conversational.`;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Fallback responses in case OpenAI or rate-limit kicks in
const FALLBACK_RESPONSES = [
  "Hello, I can hear you.",
  "Yes, I'm listening.",
  "Please go ahead.",
  "I understand.",
  "Please continue.",
  "I'm here to help.",
  "Tell me more.",
  "I'm following."
];

// Conversation manager to track context + metrics
class ConversationManager {
  constructor() {
    this.contexts = new Map();
    this.metrics = new Map();
  }

  async initializeContext(callId) {
    console.log("🎯 Initializing context for call:", callId);
    const context = {
      messages: [{
        role: "system",
        content: "You are a helpful phone assistant. Keep responses brief and natural. Be professional and focused."
      }],
      transcriptBuffer: '',
      startTime: Date.now()
    };
    this.contexts.set(callId, context);

    this.metrics.set(callId, {
      startTime: Date.now(),
      userSpeakingTime: 0,
      aiResponseTime: 0,
      silenceTime: 0,
      turnCount: 0,
      responseTimes: []
    });

    try {
      await supabase.from('conversations').insert([{
        call_id: callId,
        start_time: new Date().toISOString(),
        status: 'active'
      }]);
      console.log("💾 Initialized conversation in database");
    } catch (error) {
      console.error('❌ Failed to initialize conversation in database:', error);
      throw error;
    }
  }

  getContext(callId) {
    return this.contexts.get(callId);
  }

  async updateContext(callId, message) {
    const ctx = this.getContext(callId);
    if (!ctx) return;
    ctx.messages.push(message);
    // keep only last 10 messages
    if (ctx.messages.length > 10) {
      ctx.messages = [
        ctx.messages[0],
        ...ctx.messages.slice(-9)
      ];
    }
  }

  updateMetrics(callId, type, duration) {
    const m = this.metrics.get(callId);
    if (!m) return;
    switch (type) {
      case 'user_speaking': m.userSpeakingTime += duration; break;
      case 'ai_response': m.aiResponseTime += duration; break;
      case 'silence': m.silenceTime += duration; break;
      case 'response_time':
        m.responseTimes.push(duration);
        m.turnCount++;
        break;
    }
  }

  async endConversation(callId) {
    const m = this.metrics.get(callId);
    if (!m) return;
    const endTime = Date.now();
    const totalDuration = endTime - m.startTime;
    const avgResponseTime = m.responseTimes.length
      ? m.responseTimes.reduce((a,b) => a + b, 0) / m.responseTimes.length
      : 0;

    try {
      await supabase.from('conversations')
        .update({
          end_time: new Date().toISOString(),
          status: 'completed'
        })
        .eq('call_id', callId);

      await supabase.from('call_metrics').insert([{
        call_id: callId,
        total_duration: totalDuration,
        user_speaking_time: m.userSpeakingTime,
        ai_response_time: m.aiResponseTime,
        silence_time: m.silenceTime,
        turn_count: m.turnCount,
        average_response_time: avgResponseTime
      }]);
      console.log("💾 Stored final metrics in database");
    } catch (err) {
      console.error('❌ Error storing final metrics:', err);
    }

    this.contexts.delete(callId);
    this.metrics.delete(callId);
  }
}

const conversationManager = new ConversationManager();

// Simple text utilities to detect end of utterance, filler words, etc.
const textUtils = {
  isFiller: (t) => {
    const set = new Set(['uh','umm','hmm','ah','eh','like','you know','well','so','basically','actually','literally']);
    return set.has(t.toLowerCase().trim());
  },
  isEndOfThought: (text, sinceMs) => {
    if (sinceMs > 1500) return true;
    if (/[.!?]$/.test(text.trim())) return true;
    const endings = ['okay','right','you see','you know what i mean','thank you'];
    return endings.some(e => text.toLowerCase().trim().endsWith(e));
  },
  cleanTranscript: (t) => {
    return t
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(\w)gonna(\w)?/g, '$1going to$2')
      .replace(/(\w)wanna(\w)?/g, '$1want to$2')
      .replace(/(\w)dunno(\w)?/g, `$1don't know$2`);
  },
  hasMinimumQuality: (t) => {
    const words = t.split(/\s+/);
    return words.length >= 2 && t.length >= 5;
  }
};

// Rate limiter
function checkRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
    requestTimestamps.push(now);
    return true;
  }
  return false;
}

// Send TTS back to Plivo (JSON format!)
const sendTTSResponse = async (ws, text) => {
  try {
    const cleanText = text.replace(/[<>]/g, '').trim();
    const speakEvent = {
      event: "speak",
      text: cleanText,
      voice: "Polly.Joanna",
      language: "en-US"
    };

    console.log("🎯 WebSocket State:", ws.readyState);
    console.log("📝 TTS JSON payload:", JSON.stringify(speakEvent, null, 2));

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(speakEvent));
    } else {
      throw new Error(`WebSocket not open (State: ${ws.readyState})`);
    }
  } catch (error) {
    console.error("❌ Error sending TTS response:", error);
  }
};

// Call OpenAI to generate a response
async function generateAIResponse(callId, userMessage) {
  const ctx = conversationManager.getContext(callId);
  if (!ctx) return null;
  const start = Date.now();

  if (!checkRateLimit()) {
    console.log("⚠️ Rate limit reached, using fallback");
    return "I apologize, but I'm receiving too many requests. Could you please repeat?";
  }

  await conversationManager.updateContext(callId, { role: "user", content: userMessage });

  try {
    console.log("🤖 Calling OpenAI API...");
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 100,
        top_p: 0.9
      })
    });

    if (!resp.ok) {
      throw new Error(`OpenAI API error: ${resp.status} - ${await resp.text()}`);
    }

    const r = await resp.json();
    const aiReply = r.choices[0]?.message?.content || FALLBACK_RESPONSES[0];
    console.log("🤖 AI Response:", aiReply);

    const rt = Date.now() - start;
    conversationManager.updateMetrics(callId, 'response_time', rt);
    await conversationManager.updateContext(callId, { role: "assistant", content: aiReply });

    try {
      await supabase.from('conversation_turns').insert([{
        call_id: callId,
        user_message: userMessage,
        ai_response: aiReply,
        is_openai: true,
        timestamp: new Date().toISOString()
      }]);
    } catch (dbErr) {
      console.error('❌ Failed to store conversation turn:', dbErr);
    }

    return aiReply;
  } catch (err) {
    console.error('❌ OpenAI API error:', err);
    return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
  }
}

// Health‐check
app.get('/', (req, res) => {
  res.send('✅ Deepgram Listener is running');
});

// Always return Plivo XML at /plivo-xml
app.all('/plivo-xml', (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record
    action="https://bms123.app.n8n.cloud/webhook/recording"
    redirect="false"
    recordSession="true"
    maxLength="3600" />
  <Stream
    url="wss://triumphant-victory-production.up.railway.app/listen"
    transport="websocket"
    track="both"
    encoding="mulaw"
    sampleRate="8000"
    statusCallbackUrl="https://bms123.app.n8n.cloud/webhook/stream-status" />
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// Deepgram WebSocket config
const DEEPGRAM_CONFIG = {
  encoding: 'mulaw',
  sample_rate: 8000,
  channels: 1,
  model: 'general',
  language: 'en-US',
  punctuate: true
};

async function initializeDeepgramWebSocket() {
  return new Promise((resolve, reject) => {
    console.log('🎙️ Initializing Deepgram connection...');
    const wsUrl = `wss://api.deepgram.com/v1/listen?${new URLSearchParams(DEEPGRAM_CONFIG).toString()}`;
    console.log('🔗 Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.error('❌ Deepgram connection timeout');
        ws.close();
        reject(new Error('Connection timeout'));
      }
    }, 5000);

    ws.on('open', () => {
      console.log('✅ Deepgram WebSocket connected');
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.on('error', (e) => {
      console.error('❌ Deepgram WebSocket error:', e);
      reject(e);
    });

    ws.on('close', () => {
      console.log('🔌 Deepgram WebSocket closed');
    });
  });
}

// A simple buffer for audio chunks until Deepgram is ready
class AudioBuffer {
  constructor() {
    this.buffer = [];
    this.isConnecting = false;
  }
  add(data) { this.buffer.push(data); }
  clear() { this.buffer = []; }
  get data() { return this.buffer; }
}

app.ws('/listen', async (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');
  let deepgramWs = null;
  const audioBuffer = new AudioBuffer();
  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  await conversationManager.initializeContext(callId).catch(err => {
    console.error('❌ Failed to initialize conversation:', err);
    plivoWs.close();
  });

  const connectToDeepgram = async () => {
    if (audioBuffer.isConnecting) return;
    audioBuffer.isConnecting = true;
    try {
      deepgramWs = await initializeDeepgramWebSocket();

      // Flush any buffered audio
      if (audioBuffer.data.length) {
        console.log('📤 Sending buffered audio data...');
        for (const chunk of audioBuffer.data) {
          if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.send(chunk);
        }
        audioBuffer.clear();
      }

      deepgramWs.on('message', async (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.type === 'Results' && parsed.channel?.alternatives?.length) {
            const transcript = parsed.channel.alternatives[0].transcript;
            if (!transcript?.trim()) return;
            console.log("🗣️ Transcribed:", transcript);

            const ctx = conversationManager.getContext(callId);
            if (!ctx) return;
            ctx.transcriptBuffer += ' ' + transcript;

            if (textUtils.isEndOfThought(transcript, 1000)) {
              const fullTxt = textUtils.cleanTranscript(ctx.transcriptBuffer);
              ctx.transcriptBuffer = '';

              if (textUtils.hasMinimumQuality(fullTxt)) {
                console.log("🤖 Processing utterance:", fullTxt);
                try {
                  const aiReply = await generateAIResponse(callId, fullTxt);
                  console.log("🤖 AI Response:", aiReply);
                  await sendTTSResponse(plivoWs, aiReply);
                } catch (err) {
                  console.error("❌ AI/TTS error:", err);
                  const fallback = FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
                  console.log("⚠️ Using fallback:", fallback);
                  await sendTTSResponse(plivoWs, fallback);
                }
              }
            }
          }
        } catch (e) {
          console.error('❌ Error processing Deepgram message:', e);
        }
      });
    } catch (e) {
      console.error('❌ Failed to connect to Deepgram:', e);
    } finally {
      audioBuffer.isConnecting = false;
    }
  };

  await connectToDeepgram();

  plivoWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.event === 'media' && parsed.media?.payload) {
        const audioData = Buffer.from(parsed.media.payload, 'base64');
        if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
          console.log('⏳ Buffering audio while connecting...');
          audioBuffer.add(audioData);
          if (!audioBuffer.isConnecting) connectToDeepgram();
        } else {
          try {
            deepgramWs.send(audioData);
          } catch (err) {
            console.error("❌ Error sending audio to Deepgram:", err);
            audioBuffer.add(audioData);
            connectToDeepgram();
          }
        }
      }
    } catch (err) {
      console.error('❌ Failed to process Plivo message:', err);
    }
  });

  const cleanup = async () => {
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
    await conversationManager.endConversation(callId);
  };
  plivoWs.on('close', cleanup);
});

// Keep Railway container alive
let keepAliveInterval = setInterval(() => {}, 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  clearInterval(keepAliveInterval);
  wsInstance.getWss().clients.forEach((c) => c.close());
  process.exit(0);
});

// Start server
app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});
