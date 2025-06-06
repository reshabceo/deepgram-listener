const express = require('express');
const expressWs = require('express-ws');
const WebSocket = require('ws');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const plivo = require('plivo');

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

const app = express();
const wsInstance = expressWs(app);

// Add middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const PROCESSING_TIMEOUT = 60000; // 60 seconds
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 50;
const requestTimestamps = [];
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000; // 2 seconds
const CONNECTION_TIMEOUT = 5000; // 5 seconds

// Update the system prompt to be more focused
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

// Update FALLBACK_RESPONSES to be clear and natural
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
        content: `You are a helpful phone assistant. Keep responses brief and natural. Be professional and focused.`
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

// Transcript management
class TranscriptManager {
  constructor() {
    this.pendingTranscripts = new Map();
  }

  async saveTranscript(callId, transcript, isFinal = true) {
    try {
      // First verify call exists
      const { data: callExists, error: callCheckError } = await supabase
        .from('calls')
        .select('call_uuid')
        .eq('call_uuid', callId)
        .single();

      if (callCheckError || !callExists) {
        console.error(`❌ Call ${callId} not found in database`);
        return null;
      }

      // Format confidence to numeric(4,3) precision
      const formattedConfidence = Number(transcript.confidence).toFixed(3);
      
      const { data, error } = await supabase
        .from('transcripts')
        .insert([{
          call_uuid: callId,
          transcript: transcript.text,
          speaker: transcript.speaker || 'user',
          confidence: formattedConfidence,
          is_processed: isFinal,
          timestamp: new Date().toISOString()
        }]);

      if (error) {
        console.error('❌ Error inserting transcript:', error);
        return null;
      }
      
      console.log(`💾 Saved transcript for call ${callId}`);
      return data;
    } catch (error) {
      console.error('❌ Error saving transcript:', error);
      return null;  // Return null instead of throwing to prevent cascade failures
    }
  }

  async getTranscripts(callId) {
    try {
      const { data, error } = await supabase
        .from('transcripts')
        .select('*')
        .eq('call_uuid', callId)
        .order('timestamp', { ascending: true });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error fetching transcripts:', error);
      throw error;
    }
  }

  updatePendingTranscript(callId, text, speaker) {
    this.pendingTranscripts.set(callId, {
      text,
      speaker,
      timestamp: new Date()
    });
  }

  getPendingTranscript(callId) {
    return this.pendingTranscripts.get(callId);
  }

  clearPendingTranscript(callId) {
    this.pendingTranscripts.delete(callId);
  }
}

const transcriptManager = new TranscriptManager();

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

// Add rate limiting function
function checkRateLimit() {
  const now = Date.now();
  // Remove timestamps older than the window
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  // Check if we're under the limit
  if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
    requestTimestamps.push(now);
    return true;
  }
  return false;
}

// Update the TTS response format using Plivo SDK
const sendTTSResponse = async (ws, text) => {
  try {
    // Clean and format the text for TTS
    const cleanText = text.replace(/[<>]/g, '').trim();
    
    // Create simple Plivo Response XML
    const ttsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Joanna" language="en-US">${cleanText}</Speak>
</Response>`;
    
    // Format the speak event
    const speakEvent = {
      event: 'speak',
      payload: ttsXml
    };
    
    console.log("🎯 WebSocket State:", ws.readyState);
    console.log("📝 TTS XML:", ttsXml);
    
    if (ws.readyState === WebSocket.OPEN) {
      console.log("📤 Sending speak event:", JSON.stringify(speakEvent, null, 2));
      
      // Send the speak event and wait for confirmation
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('TTS response timeout'));
        }, 5000);

        const messageHandler = (response) => {
          try {
            const parsed = JSON.parse(response.toString());
            
            if (parsed.event === 'media') {
              console.log("🎵 Media chunk received");
            } else if (parsed.event === 'speak') {
              console.log("🔊 Speak event received:", parsed);
              clearTimeout(timeout);
              resolve();
            } else if (parsed.event === 'error') {
              console.error("❌ TTS error:", parsed);
              clearTimeout(timeout);
              reject(new Error('TTS error: ' + JSON.stringify(parsed)));
            } else {
              console.log("📥 Other Plivo event:", parsed.event);
            }
          } catch (err) {
            console.error("❌ Error parsing Plivo response:", err);
            console.error("Raw response:", response.toString().substring(0, 100));
          }
        };

        // Send the event
        ws.send(JSON.stringify(speakEvent));

        // Listen for response
        ws.once('message', messageHandler);
      });
    } else {
      throw new Error(`WebSocket not open (State: ${ws.readyState})`);
    }
  } catch (error) {
    console.error("❌ Error sending TTS response:", error);
    throw error;
  }
};

// Enhanced ChatGPT integration
async function generateAIResponse(callId, userMessage) {
  const context = conversationManager.getContext(callId);
  if (!context) return null;

  const startTime = Date.now();

  try {
    // Check rate limit before making API call
    if (!checkRateLimit()) {
      console.log("⚠️ Rate limit reached, using fallback response");
      return "I apologize, but I'm receiving too many requests right now. Could you please repeat that?";
    }

    // Add user message to context
    await conversationManager.updateContext(callId, {
      role: "user",
      content: userMessage
    });

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
          messages: context.messages,
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
      
      // Update metrics
      conversationManager.updateMetrics(callId, 'response_time', responseTime);
      
      // Add AI response to context
      await conversationManager.updateContext(callId, {
        role: "assistant",
        content: aiResponse
      });

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

  } catch (error) {
    console.error('❌ General error in generateAIResponse:', error);
    return "I apologize, but I'm experiencing technical difficulties. Please try again.";
  }
}

// ✅ For Railway status check
app.get('/', (req, res) => {
  res.send('✅ Deepgram Listener is running');
});

// ✅ Serve Plivo XML for both GET and POST
app.all('/plivo-xml', (req, res) => {
  console.log('📞 Generating Plivo XML response');
  const baseUrl = process.env.BASE_URL.replace(/\/$/, ''); // Remove trailing slash if present
  
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Speak>Hello! I am your AI assistant. How can I help you today?</Speak>
    <Record 
        action="${baseUrl}/api/recording"
        redirect="false"
        recordSession="true"
        maxLength="3600" 
        startOnDialAnswer="true"
        silenceTimeout="3600"/>
    <Stream 
      streamTimeout="3600"
      keepCallAlive="true"
      bidirectional="true"
      contentType="audio/x-mulaw;rate=8000"
      track="inbound"
      statusCallbackUrl="${baseUrl}/api/stream-status"
      >wss://${baseUrl.replace('https://', '')}/listen</Stream>
  </Response>`;
  
  console.log('📝 Generated XML:', xml);
  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// Constants for API configuration
const DEEPGRAM_CONFIG = {
  encoding: 'mulaw',
  sample_rate: 8000,
  channels: 1,
  model: 'general',
  language: 'en-US',
  punctuate: true,
  diarize: true,
  interim_results: true,
  utterance_end_ms: 1000,
  vad_turnoff: 500
};

// Initialize Deepgram WebSocket with connection handling
async function initializeDeepgramWebSocket() {
  return new Promise((resolve, reject) => {
    console.log('🎙️ Initializing Deepgram connection...');
    const wsUrl = `wss://api.deepgram.com/v1/listen?${new URLSearchParams(DEEPGRAM_CONFIG).toString()}`;
    console.log('🔗 Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
    }
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

// Buffer for audio data while connecting
class AudioBuffer {
  constructor() {
    this.buffer = [];
    this.isConnecting = false;
  }

  add(data) {
    this.buffer.push(data);
  }

  clear() {
    this.buffer = [];
  }

  get data() {
    return this.buffer;
  }
}

// Update the WebSocket listener section
app.ws('/listen', async (plivoWs, req) => {
  console.log('📞 WebSocket /listen connected');
  let keepAliveInterval;
  let processingTimeout;
  let deepgramWs = null;
  const audioBuffer = new AudioBuffer();
  
  // Generate unique call ID
  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Initialize conversation context
  try {
    // First, ensure call record exists or create it
    const { data: existingCall, error: checkError } = await supabase
      .from('calls')
      .select('call_uuid')
      .eq('call_uuid', callId)
      .single();

    if (!existingCall) {
      // Create call record if it doesn't exist
      const { error: createError } = await supabase
        .from('calls')
        .insert([{
          call_uuid: callId,
          status: 'connected',
          call_type: 'inbound',
          direction: 'INBOUND',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);

      if (createError) {
        console.error('❌ Failed to create call record:', createError);
        plivoWs.close();
        return;
      }
    }

    await conversationManager.initializeContext(callId).catch(err => {
      console.error('❌ Failed to initialize conversation:', err);
      plivoWs.close();
      return;
    });
  } catch (err) {
    console.error('❌ Failed to setup call:', err);
    plivoWs.close();
    return;
  }

  // Function to connect to Deepgram
  const connectToDeepgram = async () => {
    if (audioBuffer.isConnecting) return;
    audioBuffer.isConnecting = true;

    try {
      deepgramWs = await initializeDeepgramWebSocket();
      
      // Send buffered audio
      if (audioBuffer.data.length > 0) {
        console.log('📤 Sending buffered audio data...');
        for (const data of audioBuffer.data) {
          if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(data);
          }
        }
        audioBuffer.clear();
      }
      
      // Set up Deepgram message handler
      deepgramWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());

          if (parsed.type === 'Results') {
            const transcript = parsed.channel?.alternatives?.[0];
            if (!transcript) return;

            const transcriptText = transcript.transcript;
            if (!transcriptText || transcriptText.trim() === '') return;
            
            console.log("🗣️ Transcribed:", transcriptText);
            
            // Save transcript
            const savedTranscript = await transcriptManager.saveTranscript(callId, {
              text: transcriptText,
              confidence: transcript.confidence,
              speaker: parsed.speaker || 'user',
              is_final: !parsed.is_final
            });

            const context = conversationManager.getContext(callId);
            if (!context) {
              console.error('❌ No context found for call:', callId);
              return;
            }

            context.transcriptBuffer += ' ' + transcriptText;
            
            if (textUtils.isEndOfThought(transcriptText, 1000)) {
              const fullUtterance = textUtils.cleanTranscript(context.transcriptBuffer);
              context.transcriptBuffer = '';

              if (textUtils.hasMinimumQuality(fullUtterance)) {
                console.log("🤖 Processing utterance:", fullUtterance);
                
                try {
                  // Generate AI response
                  const aiResponse = await generateAIResponse(callId, fullUtterance);
                  if (aiResponse) {
                    console.log("🤖 AI Response:", aiResponse);
                    
                    // Save agent's response transcript
                    await transcriptManager.saveTranscript(callId, {
                      text: aiResponse,
                      speaker: 'agent',
                      confidence: 1.0
                    });

                    // Send TTS response with retries
                    let retryCount = 0;
                    const maxRetries = 3;
                    
                    while (retryCount < maxRetries) {
                      try {
                        await sendTTSResponse(plivoWs, aiResponse);
                        console.log("✅ TTS response sent successfully");
                        break;
                      } catch (ttsError) {
                        console.error(`❌ TTS error (attempt ${retryCount + 1}/${maxRetries}):`, ttsError);
                        retryCount++;
                        if (retryCount === maxRetries) {
                          console.error("❌ Max TTS retries reached, using fallback");
                          const fallbackResponse = FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
                          await sendTTSResponse(plivoWs, fallbackResponse);
                        } else {
                          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
                        }
                      }
                    }
                  }
                } catch (error) {
                  console.error("❌ AI/TTS error:", error);
                  const fallbackResponse = FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
                  console.log("⚠️ Using fallback response:", fallbackResponse);
                  
                  await transcriptManager.saveTranscript(callId, {
                    text: fallbackResponse,
                    speaker: 'agent',
                    confidence: 1.0
                  });
                  
                  try {
                    await sendTTSResponse(plivoWs, fallbackResponse);
                  } catch (ttsError) {
                    console.error("❌ Failed to send fallback response:", ttsError);
                  }
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

  // Initial connection attempt
  await connectToDeepgram();

  // Handle Plivo messages
  plivoWs.on('message', async (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      
      if (parsed.event === 'media' && parsed.media?.payload) {
        const audioData = Buffer.from(parsed.media.payload, 'base64');
        
        if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
          console.log('⏳ Buffering audio while connecting...');
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

  // Clean up
  const cleanup = async () => {
    console.log('🧹 Starting cleanup for call:', callId);
    try {
      if (keepAliveInterval) {
        console.log('Clearing keepAlive interval');
        clearInterval(keepAliveInterval);
      }
      if (processingTimeout) {
        console.log('Clearing processing timeout');
        clearTimeout(processingTimeout);
      }
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        console.log('Closing Deepgram WebSocket');
        deepgramWs.close();
      }
      console.log('Ending conversation');
      await conversationManager.endConversation(callId);
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
    }
  };

  // Set up keepalive
  keepAliveInterval = setInterval(() => {
    if (plivoWs.readyState === WebSocket.OPEN) {
      console.log('💓 Sending keepalive ping');
      plivoWs.ping();
    }
  }, KEEP_ALIVE_INTERVAL);

  // Only cleanup on explicit close
  plivoWs.on('close', () => {
    console.log('📞 Plivo WebSocket closed, initiating cleanup');
    cleanup();
  });

  plivoWs.on('error', (error) => {
    console.error('❌ Plivo WebSocket error:', error);
  });
});

// Start server
app.listen(port, () => {
  console.log(`✅ Deepgram WebSocket listener running on port ${port}...`);
});

// Add API endpoints for transcript retrieval
app.get('/api/calls/:callId/transcripts', async (req, res) => {
  try {
    const { callId } = req.params;
    const transcripts = await transcriptManager.getTranscripts(callId);
    res.json(transcripts);
  } catch (error) {
    console.error('Error fetching transcripts:', error);
    res.status(500).json({ error: 'Failed to fetch transcripts' });
  }
});

// Get live transcript updates (WebSocket endpoint)
app.ws('/api/calls/:callId/live-transcript', async (ws, req) => {
  const { callId } = req.params;
  
  // Send initial transcripts
  try {
    const transcripts = await transcriptManager.getTranscripts(callId);
    ws.send(JSON.stringify({ type: 'initial', transcripts }));
  } catch (error) {
    console.error('Error sending initial transcripts:', error);
  }

  // Set up event listener for new transcripts
  const transcriptHandler = (transcript) => {
    if (transcript.call_uuid === callId) {
      ws.send(JSON.stringify({ type: 'update', transcript }));
    }
  };

  ws.on('close', () => {
    // Clean up
  });
});

// Initialize Plivo client
const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// Call initiation endpoint
app.post('/api/calls/initiate', async (req, res) => {
  try {
    const { from, to } = req.body;
    
    if (!from || !to) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: from and to numbers' 
      });
    }

    // Format the phone numbers to ensure E.164 format
    const formattedFrom = from.startsWith('+') ? from : `+${from}`;
    const formattedTo = to.startsWith('+') ? to : `+${to}`;

    // Ensure BASE_URL is properly formatted
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const answerUrl = `${baseUrl}/plivo-xml`;
    
    console.log('📞 Initiating call from', formattedFrom, 'to', formattedTo);
    console.log('📞 Answer URL:', answerUrl);

    // Create call using Plivo
    const response = await plivoClient.calls.create(
      formattedFrom,
      formattedTo,
      answerUrl,
      {
        answerMethod: 'GET',
        statusCallbackUrl: `${baseUrl}/api/calls/status`,
        statusCallbackMethod: 'POST'
      }
    ).catch(error => {
      console.error('❌ Plivo API Error:', error.response ? error.response.body : error.message);
      throw new Error(error.response ? error.response.body : error.message);
    });

    console.log('✅ Plivo Response:', response);

    // Store call details in Supabase - using requestUuid as call_uuid
    const { data, error } = await supabase
      .from('calls')
      .insert([{
        call_uuid: response.requestUuid,
        from_number: formattedFrom,
        to_number: formattedTo,
        status: 'initiated',
        call_type: 'inbound',
        direction: 'INBOUND',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();

    if (error) {
      console.error('❌ Database Error:', error);
      throw error;
    }

    console.log('✅ Call initiated successfully:', response.requestUuid);

    res.json({
      success: true,
      callId: response.requestUuid,
      message: 'Call initiated successfully'
    });

  } catch (error) {
    console.error('❌ Error initiating call:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate call',
      details: error.message || 'Unknown error occurred'
    });
  }
});

// Call status webhook
app.post('/api/calls/status', async (req, res) => {
  try {
    const {
      CallUUID,
      CallStatus,
      Duration,
      TotalCost,
      From,
      To,
      EndTime,
      StartTime,
      AnswerTime
    } = req.body;

    console.log(`📞 Call ${CallUUID} status update:`, CallStatus);

    // Update call status in Supabase
    const { error } = await supabase
      .from('calls')
      .update({
        status: CallStatus,
        duration: Duration,
        cost: TotalCost,
        end_time: EndTime,
        start_time: StartTime,
        answer_time: AnswerTime,
        updated_at: new Date().toISOString()
      })
      .eq('call_uuid', CallUUID);

    if (error) throw error;

    res.status(200).send('Status updated');
  } catch (error) {
    console.error('❌ Error updating call status:', error);
    res.status(500).json({ error: 'Failed to update call status' });
  }
});

// Recording webhook
app.post('/api/recording', async (req, res) => {
  try {
    const {
      CallUUID,
      RecordingURL,
      RecordingID,
      RecordingDuration,
      RecordingStartTime,
      RecordingEndTime
    } = req.body;

    console.log(`📝 Recording received for call ${CallUUID}`);

    // Store recording details in Supabase
    const { error } = await supabase
      .from('call_recordings')
      .insert([{
        call_uuid: CallUUID,
        recording_url: RecordingURL,
        recording_id: RecordingID,
        duration: RecordingDuration,
        start_time: RecordingStartTime,
        end_time: RecordingEndTime
      }]);

    if (error) throw error;

    res.json({ message: 'Recording processed successfully' });
  } catch (error) {
    console.error('❌ Error processing recording:', error);
    res.status(500).json({ error: 'Failed to process recording' });
  }
});

// Stream status webhook
app.post('/api/stream-status', async (req, res) => {
  try {
    const {
      CallUUID,
      StreamStatus,
      ErrorCode,
      ErrorMessage
    } = req.body;

    console.log(`🔄 Stream status for call ${CallUUID}: ${StreamStatus}`);
    
    if (ErrorCode) {
      console.error(`❌ Stream error: ${ErrorCode} - ${ErrorMessage}`);
    }

    // Store stream status in Supabase
    const { error } = await supabase
      .from('stream_status')
      .insert([{
        call_uuid: CallUUID,
        status: StreamStatus,
        error_code: ErrorCode,
        error_message: ErrorMessage,
        timestamp: new Date().toISOString()
      }]);

    if (error) throw error;

    res.json({ message: 'Stream status updated' });
  } catch (error) {
    console.error('❌ Error updating stream status:', error);
    res.status(500).json({ error: 'Failed to update stream status' });
  }
});

// Add test endpoint for Plivo credentials
app.get('/api/plivo/test', async (req, res) => {
  try {
    // Test Plivo credentials by getting account details
    const account = await plivoClient.accounts.get(process.env.PLIVO_AUTH_ID);
    console.log('✅ Plivo account verified:', account.accountType);
    
    // Get available numbers
    const numbers = await plivoClient.numbers.list();
    console.log('📱 Available Plivo numbers:', numbers);

    res.json({
      success: true,
      account: {
        type: account.accountType,
        status: account.status,
        numbers: numbers
      }
    });
  } catch (error) {
    console.error('❌ Plivo test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify Plivo credentials',
      details: error.message
    });
  }
});

