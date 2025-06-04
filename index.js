require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
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
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const PROCESSING_TIMEOUT = 60000;   // 60 seconds
const RATE_LIMIT_WINDOW = 60000;    // 1 minute
const MAX_REQUESTS_PER_WINDOW = 50;
const requestTimestamps = [];
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;       // 2 seconds
const CONNECTION_TIMEOUT = 5000;    // 5 seconds

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

// Fallback responses
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

// Conversation manager
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
        content: `You are a helpful phone assistant. Keep responses brief and natural. Be professional and focused.`
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
    const context = this.getContext(callId);
    if (context) {
      context.messages.push(message);
      if (context.messages.length > 10) {
        context.messages = [
          context.messages[0],
          ...context.messages.slice(-9)
        ];
      }
    }
  }

  updateMetrics(callId, type, duration) {
    const metrics = this.metrics.get(callId);
    if (!metrics) return;
    switch (type) {
      case 'user_speaking':
        metrics.userSpeakingTime += duration;
        break;
      case 'ai_response':
        metrics.aiResponseTime += duration;
        break;
      case 'silence':
        metrics.silenceTime += duration;
        break;
      case 'response_time':
        metrics.responseTimes.push(duration);
        metrics.turnCount++;
        break;
    }
  }

  async endConversation(callId) {
    const metrics = this.metrics.get(callId);
    if (!metrics) return;
    const endTime = Date.now();
    const totalDuration = endTime - metrics.startTime;
    const avgResponseTime = metrics.responseTimes.length
      ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length
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
        user_speaking_time: metrics.userSpeakingTime,
        ai_response_time: metrics.aiResponseTime,
        silence_time: metrics.silenceTime,
        turn_count: metrics.turnCount,
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

// Text processing utilities
const textUtils = {
  isFiller: (text) => {
    const fillerWords = new Set([
      'uh', 'umm', 'hmm', 'ah', 'eh', 'like', 'you know',
      'well', 'so', 'basically', 'actually', 'literally'
    ]);
    return fillerWords.has(text.toLowerCase().trim());
  },

  isEndOfThought: (text, timeSinceLast) => {
    if (timeSinceLast > 1500) return true;
    if (/[.!?]$/.test(text.trim())) return true;
    const endPhrases = ['okay', 'right', 'you see', 'you know what i mean', 'thank you'];
    return endPhrases.some(phrase => text.toLowerCase().trim().endsWith(phrase));
  },

  cleanTranscript: (text) => {
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(\w)gonna(\w)?/g, '$1going to$2')
      .replace(/(\w)wanna(\w)?/g, '$1want to$2')
      .replace(/(\w)dunno(\w)?/g, `$1don't know$2`);
  },

  hasMinimumQuality: (text) => {
    const words = text.split(/\s+/);
    return words.length >= 2 && text.length >= 5;
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

// Send TTS response (default voice) over Plivo WebSocket
async function sendTTSResponse(plivoWs, text) {
  try {
    const cleanText = text.replace(/[<>]/g, '').trim();
    const ttsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${cleanText}</Speak>
</Response>`;

    const speakEvent = {
      event: 'speak',
      payload: ttsXml,
      content_type: 'application/xml'
    };

    console.log("📝 TTS XML:", ttsXml);
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.send(JSON.stringify(speakEvent));
    } else {
      console.error(`❌ WebSocket not open (State: ${plivoWs.readyState})`);
    }
  } catch (error) {
    console.error("❌ Error sending TTS response:", error);
  }
}

// Generate an AI response using OpenAI
async function generateAIResponse(callId, userMessage) {
  const context = conversationManager.getContext(callId);
  if (!context) return null;
  const startTime = Date.now();

  if (!checkRateLimit()) {
    console.log("⚠️ Rate limit reached, using fallback response");
    return "I apologize, but I'm receiving too many requests right now. Could you please repeat that?";
  }

  await conversationManager.updateContext(callId, { role: "user", content: userMessage });

  try {
    console.log("🤖 Calling OpenAI API...");
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} - ${await response.text()}`);
    }

    const result = await response.json();
    const aiResponse = result.choices[0]?.message?.content || FALLBACK_RESPONSES[0];
    console.log("🤖 AI Response:", aiResponse);

    const responseTime = Date.now() - startTime;
    conversationManager.updateMetrics(callId, 'response_time', responseTime);
    await conversationManager.updateContext(callId, { role: "assistant", content: aiResponse });

    try {
      await supabase.from('conversation_turns').insert([{
        call_id: callId,
        user_message: userMessage,
        ai_response: aiResponse,
        is_openai: true,
        timestamp: new Date().toISOString()
      }]);
    } catch (dbError) {
      console.error('❌ Failed to store conversation turn:', dbError);
    }

    return aiResponse;
  } catch (error) {
    console.error('❌ OpenAI API error:', error);
    return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
  }
}

// Health‐check
app.get('/', (req, res) => {
  res.send('✅ Deepgram WebSocket listener running on port ' + port);
});

// Serve Plivo XML
app.all('/plivo-xml', (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record
    action="https://bms123.app.n8n.cloud/webhook/recording"
    redirect="false"
    recordSession="true"
    maxLength="3600"
  />
  <Stream
    url="wss://triumphant-victory-production.up.railway.app/listen"
    transport="websocket"
    track="inbound"
    contentType="audio/x-mulaw;rate=8000"
    statusCallbackUrl="https://bms123.app.n8n.cloud/webhook/stream-status"
  />
</Response>`;

  res.set('Content-Type', 'application/xml; charset=utf-8');
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

    const connectionTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.error('❌ Deepgram connection timeout');
        ws.close();
        reject(new Error('Connection timeout'));
      }
    }, 5000);

    ws.on('open', () => {
      console.log('✅ Deepgram WebSocket connected');
      clearTimeout(connectionTimeout);
      resolve(ws);
    });

    ws.on('error', (error) => {
      console.error('❌ Deepgram WebSocket error:', error);
      reject(error);
    });

    ws.on('close', () => {
      console.log('🔌 Deepgram WebSocket closed');
    });
  });
}

// Simple buffer for audio chunks
class AudioBuffer {
  constructor() {
    this.buffer = [];
    this.isConnecting = false;
  }
  add(data) { this.buffer.push(data); }
  clear() { this.buffer = []; }
  get data() { return this.buffer; }
}

// Plivo WebSocket endpoint
app.ws('/listen', async (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');
  let deepgramWs = null;
  const audioBuffer = new AudioBuffer();

  // Generate callId
  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize conversation context
  await conversationManager.initializeContext(callId).catch(err => {
    console.error('❌ Failed to initialize conversation:', err);
    plivoWs.close();
    return;
  });

  // As soon as the Plivo WebSocket is open, send an initial <Speak>
  const initialXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>
    Hi there—I’m listening. Please say something.
  </Speak>
</Response>`;
  const initialSpeakEvent = {
    event: "speak",
    payload: initialXml,
    content_type: "application/xml"
  };

  if (plivoWs.readyState === WebSocket.OPEN) {
    console.log("▶ Sending initial TTS to Plivo WS");
    plivoWs.send(JSON.stringify(initialSpeakEvent));
  } else {
    plivoWs.once('open', () => {
      console.log("▶ (On open) sending initial TTS");
      plivoWs.send(JSON.stringify(initialSpeakEvent));
    });
  }

  // Function to connect to Deepgram
  const connectToDeepgram = async () => {
    if (audioBuffer.isConnecting) return;
    audioBuffer.isConnecting = true;

    try {
      deepgramWs = await initializeDeepgramWebSocket();

      // Flush buffered audio
      if (audioBuffer.data.length > 0) {
        console.log('📤 Sending buffered audio to Deepgram...');
        for (const chunk of audioBuffer.data) {
          if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(chunk);
          }
        }
        audioBuffer.clear();
      }

      // Handle Deepgram messages
      deepgramWs.on('message', async (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.type === 'Results' && parsed.channel?.alternatives?.length > 0) {
            const transcript = parsed.channel.alternatives[0].transcript;
            if (!transcript?.trim()) return;

            console.log("🗣️ Transcribed:", transcript);
            const ctx = conversationManager.getContext(callId);
            if (!ctx) return;
            ctx.transcriptBuffer += ' ' + transcript;

            if (textUtils.isEndOfThought(transcript, 1000)) {
              const fullUtterance = textUtils.cleanTranscript(ctx.transcriptBuffer);
              ctx.transcriptBuffer = '';

              if (textUtils.hasMinimumQuality(fullUtterance)) {
                console.log("🤖 Processing utterance:", fullUtterance);
                try {
                  const aiResponse = await generateAIResponse(callId, fullUtterance);
                  console.log("🤖 AI Response:", aiResponse);
                  await sendTTSResponse(plivoWs, aiResponse);
                } catch (error) {
                  console.error("❌ AI/TTS error:", error);
                  const fallbackResponse = FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
                  console.log("⚠️ Using fallback response:", fallbackResponse);
                  await sendTTSResponse(plivoWs, fallbackResponse);
                }
              }
            }
          }
        } catch (error) {
          console.error('❌ Error processing Deepgram message:', error);
        }
      });
    } catch (error) {
      console.error('❌ Failed to connect to Deepgram:', error);
    } finally {
      audioBuffer.isConnecting = false;
    }
  };

  // Attempt to connect to Deepgram immediately
  await connectToDeepgram();

  // Handle incoming Plivo media
  plivoWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.event === 'media' && parsed.media?.payload) {
        const audioData = Buffer.from(parsed.media.payload, 'base64');
        if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
          console.log('⏳ Buffering audio while Deepgram connects...');
          audioBuffer.add(audioData);
          if (!audioBuffer.isConnecting) {
            connectToDeepgram();
          }
        } else {
          try {
            deepgramWs.send(audioData);
          } catch (error) {
            console.error("❌ Error sending audio to Deepgram:", error);
            audioBuffer.add(audioData);
            connectToDeepgram();
          }
        }
      }
    } catch (error) {
      console.error('❌ Failed to process Plivo message:', error);
    }
  });

  // Cleanup when Plivo WS closes
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
  wsInstance.getWss().clients.forEach(client => client.close());
  process.exit(0);
});

// Start server
app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});
