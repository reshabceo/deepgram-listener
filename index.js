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
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const PROCESSING_TIMEOUT = 60000; // 60 seconds

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
    console.log("🎯 Initializing context for call:", callId);
    
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
    
    // Initialize metrics with timestamps
    this.metrics.set(callId, {
      startTime: Date.now(),
      userSpeakingTime: 0,
      aiResponseTime: 0,
      silenceTime: 0,
      turnCount: 0,
      responseTimes: [],
      lastMetricUpdate: Date.now()
    });
    
    try {
      // Store conversation start in Supabase
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
      // Keep context window manageable
      if (context.messages.length > 10) {
        context.messages = [
          context.messages[0],
          ...context.messages.slice(-9)
        ];
      }
    }
  }

  updateMetrics(callId, type, duration) {
    console.log(`📊 Updating metrics for ${callId} - Type: ${type}, Duration: ${duration}ms`);
    
    const metrics = this.metrics.get(callId);
    if (metrics) {
      const now = Date.now();
      
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
      
      metrics.lastMetricUpdate = now;
      console.log(`📊 Updated metrics for ${callId}:`, metrics);
    } else {
      console.error(`❌ No metrics found for call: ${callId}`);
    }
  }

  async endConversation(callId) {
    console.log(`🔚 Ending conversation for call: ${callId}`);
    
    try {
      const metrics = this.metrics.get(callId);
      const endTime = Date.now();
      
      if (metrics) {
        const totalDuration = endTime - metrics.startTime;
        const avgResponseTime = metrics.responseTimes.length > 0 
          ? metrics.responseTimes.reduce((a, b) => a + b, 0) / metrics.responseTimes.length 
          : 0;

        console.log(`📊 Final metrics for ${callId}:`, {
          totalDuration,
          userSpeakingTime: metrics.userSpeakingTime,
          aiResponseTime: metrics.aiResponseTime,
          silenceTime: metrics.silenceTime,
          turnCount: metrics.turnCount,
          avgResponseTime
        });

        // Update conversation status
        await supabase.from('conversations')
          .update({
            end_time: new Date().toISOString(),
            status: 'completed'
          })
          .eq('call_id', callId);

        // Store call metrics
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
      }

      // Clean up
      this.contexts.delete(callId);
      this.metrics.delete(callId);
    } catch (error) {
      console.error('❌ Error ending conversation:', error);
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
      model: "gpt-3.5-turbo",
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
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Record 
      action="https://bms123.app.n8n.cloud/webhook/recording"
      redirect="false"
      recordSession="true"
      maxLength="7200"
      startOnDialAnswer="true" />
    <Stream 
      streamTimeout="7200"
      keepCallAlive="true"
      bidirectional="true"
      contentType="audio/x-mulaw;rate=8000"
      statusCallbackUrl="https://bms123.app.n8n.cloud/webhook/stream-status">
      wss://triumphant-victory-production.up.railway.app/listen
    </Stream>
  </Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// WebSocket listener from Plivo
app.ws('/listen', (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');
  let keepAliveInterval;
  let processingTimeout;
  
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

  // Set up keep-alive for both WebSocket connections
  keepAliveInterval = setInterval(() => {
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.ping();
      console.log('🏓 Sent ping to Plivo');
    }
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.ping();
      console.log('🏓 Sent ping to Deepgram');
    }
  }, KEEP_ALIVE_INTERVAL);

  // Reset processing timeout
  const resetProcessingTimeout = () => {
    if (processingTimeout) clearTimeout(processingTimeout);
    processingTimeout = setTimeout(() => {
      console.log('⏰ Processing timeout - keeping connection alive');
    }, PROCESSING_TIMEOUT);
  };

  // Handle Plivo messages
  plivoWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      console.log("📥 Received Plivo message:", parsed.event);
      resetProcessingTimeout();

      if (parsed.event === 'media' && parsed.media?.payload) {
        console.log("🎵 Received audio data, length:", parsed.media.payload.length);
        const audioBuffer = Buffer.from(parsed.media.payload, 'base64');
        console.log("🎵 Decoded audio buffer size:", audioBuffer.length);
        
        if (deepgramWs.readyState === WebSocket.OPEN) {
          try {
            deepgramWs.send(audioBuffer);
            console.log("✈️ Sent audio data to Deepgram, size:", audioBuffer.length);
          } catch (error) {
            console.error("❌ Failed to send audio to Deepgram:", error);
          }
        } else {
          console.error("❌ Deepgram WebSocket not open. State:", deepgramWs.readyState);
        }
      } else if (parsed.event === 'speak_ended') {
        console.log("🔊 TTS playback completed");
      } else if (parsed.event === 'speak_started') {
        console.log("🔊 TTS playback started");
      } else {
        console.log("ℹ️ Other Plivo event:", parsed.event);
      }
    } catch (e) {
      console.error('❌ Failed to process Plivo message:', e);
      console.error('Message was:', msg.toString().substring(0, 100) + '...');
    }
  });

  // WebSocket health check
  const healthCheck = setInterval(() => {
    if (plivoWs.readyState !== WebSocket.OPEN) {
      console.error('❌ Plivo WebSocket disconnected, state:', plivoWs.readyState);
      cleanup();
    }
    if (deepgramWs.readyState !== WebSocket.OPEN) {
      console.error('❌ Deepgram WebSocket disconnected, state:', deepgramWs.readyState);
      cleanup();
    }
  }, 5000);

  // Clean up function
  const cleanup = async () => {
    console.log('🧹 Cleaning up connections');
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (processingTimeout) clearTimeout(processingTimeout);
    if (healthCheck) clearInterval(healthCheck);
    
    if (deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.close();
    }
    await conversationManager.endConversation(callId);
  };

  // Add error event handlers with more detail
  plivoWs.on('error', (error) => {
    console.error('❌ Plivo WebSocket error:', error.message || error);
    console.error('Stack:', error.stack);
  });

  deepgramWs.on('error', (error) => {
    console.error('❌ Deepgram WebSocket error:', error.message || error);
    console.error('Stack:', error.stack);
  });

  // Add connection close handlers with more detail
  plivoWs.on('close', (code, reason) => {
    console.log(`❌ Plivo WebSocket disconnected. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    console.log('Current state:', plivoWs.readyState);
    cleanup();
  });

  deepgramWs.on('close', (code, reason) => {
    console.log(`❌ Deepgram WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    console.log('Current state:', deepgramWs.readyState);
    cleanup();
  });

  // Handle Deepgram connection
  deepgramWs.on('open', () => {
    console.log('🎙️ Deepgram WebSocket connected');
    resetProcessingTimeout();
    
    // Send initial configuration
    const config = {
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      model: 'nova-2',
      language: 'en',
      punctuate: true,
      interim_results: false
    };
    
    try {
      deepgramWs.send(JSON.stringify(config));
      console.log('📝 Sent configuration to Deepgram:', config);
    } catch (error) {
      console.error('❌ Failed to send config to Deepgram:', error);
    }
  });

  // Enhanced Deepgram message handling
  deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      console.log("📥 Received Deepgram message type:", parsed.type || 'unknown');
      
      const startTime = Date.now();

      if (parsed.type === 'Results') {
        console.log("📊 Deepgram results received");
      }

      if (parsed.channel?.alternatives) {
        const context = conversationManager.getContext(callId);
        if (!context) {
          console.error('❌ No context found for call:', callId);
          return;
        }

        const spokenText = parsed.channel.alternatives[0].transcript;
        const confidence = parsed.channel.alternatives[0].confidence;
        
        if (!spokenText) {
          console.log("ℹ️ Empty transcript received");
          return;
        }

        const now = Date.now();
        const timeSinceLast = now - context.lastProcessedTime;
        context.lastProcessedTime = now;

        console.log("🗣️ Live:", spokenText, "(confidence:", confidence, ")");

        // Update metrics for user speaking time
        conversationManager.updateMetrics(callId, 'user_speaking', timeSinceLast);

        if (!textUtils.isFiller(spokenText)) {
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
                  
                  // Format the Speak XML properly with SSML tags
                  const ttsResponse = `<?xml version="1.0" encoding="UTF-8"?>
                    <Response>
                      <Speak voice="Polly.Joanna">
                        <prosody rate="95%" pitch="+0%">${aiResponse}</prosody>
                      </Speak>
                    </Response>`;
                  
                  console.log("🔊 Preparing TTS response:", ttsResponse);
                  
                  // Send the TTS response back through the WebSocket
                  if (plivoWs.readyState === WebSocket.OPEN) {
                    const wsMessage = {
                      event: 'speak',
                      payload: ttsResponse
                    };
                    console.log("📤 Sending WebSocket message to Plivo:", JSON.stringify(wsMessage));
                    plivoWs.send(JSON.stringify(wsMessage));
                    console.log("✅ Message sent to Plivo successfully");
                    
                    // Update metrics for AI response time
                    const responseEndTime = Date.now();
                    conversationManager.updateMetrics(callId, 'ai_response', responseEndTime - startTime);
                  } else {
                    console.error("❌ WebSocket not open for TTS response. State:", plivoWs.readyState);
                  }
                } else {
                  console.error("❌ No AI response generated");
                }
              } catch (error) {
                console.error("❌ Error generating AI response:", error);
              }
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
      } else if (parsed.type === 'Error') {
        console.error('❌ Deepgram Error:', parsed.description);
      }
    } catch (error) {
      console.error('❌ Error processing Deepgram message:', error);
    }
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
