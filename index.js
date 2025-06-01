require('dotenv').config();

const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DEEPGRAM_API_KEY'
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
const WEBSOCKET_PING_INTERVAL = 30000; // 30 seconds

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Conversation context management
class ConversationManager {
  constructor() {
    this.contexts = new Map();
    this.metrics = new Map();
  }

  async initializeContext(callId) {
    const context = {
      messages: [{
        role: "system",
        content: `You are a helpful AI assistant on a phone call. 
                  - Keep responses concise and natural
                  - Be empathetic and professional
                  - Ask clarifying questions when needed
                  - Stay focused on the caller's needs`
      }],
      lastProcessedTime: Date.now(),
      transcriptBuffer: '',
      silenceCount: 0,
      startTime: Date.now()
    };
    this.contexts.set(callId, context);
    
    // Initialize metrics
    this.metrics.set(callId, {
      startTime: Date.now(),
      userSpeakingTime: 0,
      aiResponseTime: 0,
      silenceTime: 0,
      turnCount: 0,
      responseTimes: []
    });
    
    // Store conversation start in Supabase
    await supabase.from('conversations').insert([{
      call_id: callId,
      start_time: new Date().toISOString(),
      status: 'active'
    }]);
  }

  getContext(callId) {
    return this.contexts.get(callId);
  }

  async updateContext(callId, message) {
    const context = this.getContext(callId);
    if (context) {
      context.messages.push(message);
      // Keep context window manageable
      if (context.messages.length > 10) {
        context.messages = [
          context.messages[0],
          ...context.messages.slice(-9)
        ];
      }
    }
  }

  async endConversation(callId) {
    try {
      const metrics = this.metrics.get(callId);
      const endTime = Date.now();
      
      // Update conversation status
      await supabase.from('conversations')
        .update({
          end_time: new Date().toISOString(),
          status: 'completed'
        })
        .eq('call_id', callId);

      // Store call metrics
      if (metrics) {
        const totalDuration = endTime - metrics.startTime;
        const avgResponseTime = metrics.responseTimes.length > 0 
          ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length 
          : 0;

        await supabase.from('call_metrics').insert([{
          call_id: callId,
          total_duration: totalDuration,
          user_speaking_time: metrics.userSpeakingTime,
          ai_response_time: metrics.aiResponseTime,
          silence_time: metrics.silenceTime,
          turn_count: metrics.turnCount,
          average_response_time: avgResponseTime
        }]);
      }

      // Clean up
      this.contexts.delete(callId);
      this.metrics.delete(callId);
    } catch (error) {
      console.error('❌ Error ending conversation:', error);
    }
  }

  updateMetrics(callId, type, duration) {
    const metrics = this.metrics.get(callId);
    if (metrics) {
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
  }
}

const conversationManager = new ConversationManager();

// Enhanced text processing utilities
const textUtils = {
  isFiller: (text) => {
    const fillerWords = new Set([
      'uh', 'umm', 'hmm', 'ah', 'eh', 'like', 'you know', 
      'well', 'so', 'basically', 'actually', 'literally'
    ]);
    return fillerWords.has(text.toLowerCase().trim());
  },

  isEndOfThought: (text, timeSinceLast) => {
    // Natural pauses
    if (timeSinceLast > 1500) return true;
    
    // Punctuation
    if (/[.!?]$/.test(text.trim())) return true;
    
    // Common ending phrases
    const endPhrases = ['okay', 'right', 'you see', 'you know what i mean', 'thank you'];
    return endPhrases.some(phrase => text.toLowerCase().trim().endsWith(phrase));
  },

  cleanTranscript: (text) => {
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(\w)gonna(\w)?/g, '$1going to$2')
      .replace(/(\w)wanna(\w)?/g, '$1want to$2')
      .replace(/(\w)dunno(\w)?/g, '$1don\'t know$2');
  },

  hasMinimumQuality: (text) => {
    const words = text.split(/\s+/);
    return words.length >= 2 && text.length >= 5;
  }
};

// Enhanced ChatGPT integration
async function generateAIResponse(callId, userMessage) {
  const context = conversationManager.getContext(callId);
  if (!context) return null;

  const startTime = Date.now();

  try {
    // Add user message to context
    await conversationManager.updateContext(callId, {
      role: "user",
      content: userMessage
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: context.messages,
      temperature: 0.7,
      max_tokens: 150,
      presence_penalty: 0.6
    });

    const aiResponse = completion.choices[0].message;
    const responseTime = Date.now() - startTime;
    
    // Update metrics
    conversationManager.updateMetrics(callId, 'response_time', responseTime);
    
    // Add AI response to context
    await conversationManager.updateContext(callId, {
      role: "assistant",
      content: aiResponse.content
    });

    // Store in conversation_turns
    await supabase.from('conversation_turns').insert([{
      call_id: callId,
      user_message: userMessage,
      ai_response: aiResponse.content,
      timestamp: new Date().toISOString()
    }]);

    return aiResponse.content;

  } catch (error) {
    console.error('❌ ChatGPT API error:', error);
    return null;
  }
}

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

// WebSocket listener from Plivo
app.ws('/listen', (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');
  
  // Generate unique call ID
  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Initialize conversation context
  conversationManager.initializeContext(callId).catch(err => {
    console.error('❌ Failed to initialize conversation:', err);
    plivoWs.close();
    return;
  });

  // Initialize Deepgram WebSocket
  const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000', {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
  });

  // Set up WebSocket ping interval to keep connection alive
  const pingInterval = setInterval(() => {
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.ping();
    }
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.ping();
    }
  }, WEBSOCKET_PING_INTERVAL);

  // Handle Deepgram connection
  deepgramWs.on('open', () => {
    console.log('🎙️ Deepgram WebSocket connected');
  });

  deepgramWs.on('error', (error) => {
    console.error('❌ Deepgram WebSocket error:', error);
  });

  // Handle Plivo connection
  plivoWs.on('error', (error) => {
    console.error('❌ Plivo WebSocket error:', error);
  });

  // Clean up function
  const cleanup = async () => {
    clearInterval(pingInterval);
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.close();
    }
    await conversationManager.endConversation(callId);
  };

  // Handle Plivo messages
  plivoWs.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.event === 'media' && parsed.media?.payload) {
        const audioBuffer = Buffer.from(parsed.media.payload, 'base64');
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioBuffer);
        }
      }
    } catch (e) {
      console.error('❌ Failed to forward audio to Deepgram:', e);
    }
  });

  // Handle Deepgram messages
  deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

      if (parsed.channel?.alternatives) {
        const context = conversationManager.getContext(callId);
        if (!context) {
          console.error('❌ No context found for call:', callId);
          return;
        }

        const spokenText = parsed.channel.alternatives[0].transcript;
        const confidence = parsed.channel.alternatives[0].confidence;
        
        if (!spokenText) return;

        const now = Date.now();
        const timeSinceLast = now - context.lastProcessedTime;
        context.lastProcessedTime = now;

        console.log("🗣️ Live:", spokenText);

        if (!textUtils.isFiller(spokenText)) {
          // Update metrics for user speaking time
          conversationManager.updateMetrics(callId, 'user_speaking', timeSinceLast);
          
          context.transcriptBuffer += ' ' + spokenText;
          
          if (textUtils.isEndOfThought(spokenText, timeSinceLast)) {
            const fullUtterance = textUtils.cleanTranscript(context.transcriptBuffer);
            context.transcriptBuffer = '';

            if (textUtils.hasMinimumQuality(fullUtterance)) {
              console.log("🤖 Processing utterance:", fullUtterance);
              
              try {
                const aiResponse = await generateAIResponse(callId, fullUtterance);
                if (aiResponse) {
                  console.log("🤖 AI Response:", aiResponse);
                  
                  // Send TTS response using Plivo's Speak XML
                  const ttsResponse = `
                    <Response>
                      <Speak language="en-US" voice="Polly.Joanna">
                        ${aiResponse}
                      </Speak>
                    </Response>
                  `;
                  
                  // Send the TTS response back through the WebSocket
                  if (plivoWs.readyState === WebSocket.OPEN) {
                    plivoWs.send(JSON.stringify({
                      event: 'tts',
                      payload: ttsResponse
                    }));
                  }
                }
              } catch (error) {
                console.error('❌ Failed to generate AI response:', error);
              }
            }
          }

          // Store in transcripts
          try {
            await supabase.from('transcripts').insert([{
              call_id: callId,
              transcript: spokenText,
              timestamp: new Date().toISOString(),
              is_processed: true,
              confidence: confidence
            }]);
          } catch (error) {
            console.error('❌ Supabase insert error:', error);
          }
        } else {
          // Update metrics for silence time
          conversationManager.updateMetrics(callId, 'silence', timeSinceLast);
        }
      } else if (parsed.type === 'Error') {
        console.error('❌ Deepgram Error:', parsed.description);
      }
    } catch (e) {
      console.error('❌ Processing error:', e);
    }
  });

  // Handle connection closures
  plivoWs.on('close', () => {
    console.log('❌ Plivo WebSocket disconnected');
    cleanup();
  });

  deepgramWs.on('close', () => {
    console.log('❌ Deepgram WebSocket closed');
    cleanup();
  });
});

// Keep Railway container alive with proper interval cleanup
let keepAliveInterval = setInterval(() => {}, 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  clearInterval(keepAliveInterval);
  wsInstance.getWss().clients.forEach(client => {
    client.close();
  });
  process.exit(0);
});

// Start server
app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});
