// Test deploy: should see this in logs!

import express from 'express';
import expressWs from 'express-ws';
import WebSocket from 'ws';
import axios from 'axios';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import plivo from 'plivo';
import dotenv from 'dotenv';
import http from 'http';
dotenv.config();

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
const server = http.createServer(app);
// Attach express-ws to both app and server for ESM + custom server compatibility
expressWs(app, server);
server.setTimeout(120000); // Set server timeout to 2 minutes

// Add middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add middleware logging
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  next();
});

const port = process.env.PORT || 3000;
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 50;
const requestTimestamps = [];

// Update the system prompt to be more focused on voice interaction
const SYSTEM_PROMPT = `You are a voice-based AI assistant on a phone call. You can hear the caller through speech recognition and respond verbally. Keep responses brief, natural, and focused. You should be professional but conversational. Never say you are a text-based assistant or that you cannot hear – you CAN hear through speech recognition.`;

// Supabase client
const supabase = createSupabaseClient(
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

// Conversation context management
class ConversationManager {
  constructor() {
    this.contexts = new Map();
    this.metrics = new Map();
  }

  async initializeContext(callId) {
    console.log("🎯 Initializing context for call:", callId);
    const context = {
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
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
      responseTimes: [],
      lastMetricUpdate: Date.now()
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
        await supabase.from('conversations')
          .update({ end_time: new Date().toISOString(), status: 'completed' })
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
      }
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

  async saveTranscript(callId, transcript) {
    try {
      if (!transcript.is_final) return null;
      const { data: callExists, error: callCheckError } = await supabase
        .from('calls')
        .select('call_uuid')
        .eq('call_uuid', callId)
        .single();
      if (callCheckError || !callExists) {
        console.error(`❌ Call ${callId} not found in database`);
        return null;
      }
      const formattedConfidence = Number(transcript.confidence).toFixed(3);
      const { data, error } = await supabase
        .from('transcripts')
        .insert([{
          call_uuid: callId,
          transcript: transcript.text,
          speaker: transcript.speaker || 'user',
          confidence: formattedConfidence,
          is_processed: true,
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
      return null;
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
}

const transcriptManager = new TranscriptManager();

// Enhanced text processing utilities
const textUtils = {
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
      .replace(/(\w)dunno(\w)?/g, '$1don\'t know$2');
  },

  // Accept very short utterances such as "Yes" or "No".
  hasMinimumQuality: (text) => {
    return text.trim().length >= 2;
  }
};

// Add rate limiting function
function checkRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length < MAX_REQUESTS_PER_WINDOW) {
    requestTimestamps.push(now);
    return true;
  }
  return false;
}

// Initialize Plivo client
const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// Add endpoint to list Plivo applications
app.get('/api/plivo/list-apps', async (req, res) => {
  try {
    const applications = await plivoClient.applications.list();
    console.log('📱 Plivo applications:', applications);
    res.json({
      success: true,
      applications: applications
    });
  } catch (error) {
    console.error('❌ Error listing applications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list applications',
      details: error.message
    });
  }
});

// Add endpoint to create a new AI assistant application
app.post('/api/plivo/create-ai-assistant', async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const appName = "AI_Voice_Assistant"; // No spaces allowed
    const answerUrl = `${baseUrl}/plivo-xml`;

    console.log('Creating application with name:', appName, 'and URL:', answerUrl);

    // Correct invocation: first argument is the string appName, second is an options object
    const application = await plivoClient.applications.create(
      appName,
      {
        answerUrl:    answerUrl,
        answerMethod: "GET"
      }
    );

    console.log('✅ AI Assistant application created:', application);

    res.json({
      success:       true,
      applicationId: application.appId,
      message:       'AI Assistant application created successfully'
    });
  } catch (error) {
    console.error('❌ Error creating AI assistant application:', error);
    res.status(500).json({
      success: false,
      error:   'Failed to create AI assistant application',
      details: error.message
    });
  }
});

// Refactored TTS using Deepgram REST API with streaming
const sendTTSResponse = async (plivoWs, text) => {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const deepgram = createClient(deepgramApiKey);
  try {
    const response = await deepgram.speak.request(
      { text },
      {
        model: 'aura-2-thalia-en',
        encoding: 'mulaw',
        sample_rate: 8000,
        container: 'none'
      }
    );
    const stream = await response.getStream();
    if (stream) {
      stream.on('data', (chunk) => {
        plivoWs.send(JSON.stringify({
          event: 'media',
          media: { payload: Buffer.from(chunk).toString('base64') }
        }));
        console.log('🔊 [TTS-REST] Sent mulaw/8kHz audio chunk to Plivo, length:', chunk.length);
      });
      stream.on('end', () => {
        console.log('🔊 [TTS-REST] Deepgram TTS audio stream ended');
      });
      stream.on('error', (err) => {
        console.error('❌ [TTS-REST] Deepgram TTS stream error:', err);
      });
    } else {
      console.error('❌ [TTS-REST] Error generating audio: stream is null');
    }
  } catch (err) {
    console.error('❌ [TTS-REST] Error in sendTTSResponse:', err);
  }
};

// Enhanced ChatGPT integration
async function generateAIResponse(callId, userMessage) {
  const context = conversationManager.getContext(callId);
  if (!context) return null;

  const startTime = Date.now();

  try {
    if (!checkRateLimit()) {
      console.log("⚠️ Rate limit reached, using fallback response");
      return "I apologize, but I'm receiving too many requests right now. Could you please repeat that?";
    }

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
      conversationManager.updateMetrics(callId, 'response_time', responseTime);
      
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

// Deepgram Voice Agent settings
const DEEPGRAM_SETTINGS = {
  audio: {
    input: { 
      encoding: "mulaw", 
      sample_rate: 8000 
    },
    output: { 
      encoding: "mulaw", 
      sample_rate: 8000 
    }
  },
  agent: {
    listen: { 
      provider: { 
        model: "nova-3" 
      } 
    },
    think: {
      provider: { 
        model: "gpt-4o-mini" 
      },
      prompt: "You are a helpful and friendly AI assistant who loves to chat about anything the user is interested in. Keep responses brief and natural."
    },
    speak: { 
      provider: { 
        model: "aura-2-andromeda-en" 
      } 
    }
  }
};

// ✅ For Railway status check
app.get('/', (req, res) => {
  res.send('✅ Deepgram Voice Agent is running');
});

// WebSocket route for Plivo audio streaming
// Plivo should connect via WebSocket, not HTTP GET. 404s for GET /listen are normal.
app.ws('/listen', async (plivoWs, req) => {
  const callId = req.query.call_uuid;
  if (!callId) {
    console.error('❌ No call_uuid provided in WebSocket connection');
    plivoWs.close();
    return;
  }

  console.log('📞 WebSocket /listen connected for call:', callId);
  let keepAliveInterval;
  let streamId = '';

  // Initialize conversation in database
  try {
    const { data: existingCall, error: checkError } = await supabase
      .from('calls')
      .select('call_uuid')
      .eq('call_uuid', callId)
      .single();

    if (!existingCall) {
      const { error: createError } = await supabase
        .from('calls')
        .insert([{
          call_uuid: callId,
          status: 'connected',
          call_type: 'outbound',
          direction: 'OUTBOUND',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]);

      if (createError) {
        console.error('❌ Failed to create call record:', createError);
        plivoWs.close();
        return;
      }
    }
  } catch (err) {
    console.error('❌ Failed to setup call:', err);
    plivoWs.close();
    return;
  }

  // Send initial greeting with explicit logging and error handling
  console.log('🔊 Sending initial greeting TTS...');
  try {
    await sendTTSResponse(plivoWs, 'Hello, this is your AI assistant. How may I help you?');
    console.log('✅ Initial greeting TTS sent');
  } catch (err) {
    console.error('❌ Failed to send initial greeting TTS:', err);
  }

  // Initialize Deepgram SDK client for live transcription
  const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  const dgConnection = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    smart_format: true,
    encoding: 'mulaw',
    sample_rate: 8000
  });

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram transcription connection opened');
  });

  dgConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript = data.channel.alternatives[0].transcript;
    const isFinal = data.is_final;
    if (transcript && isFinal) {
      console.log('📝 Final transcript:', transcript);
      // Save transcript to DB
      try {
        await supabase.from('transcripts').insert([{
          call_uuid: callId,
          transcript,
          speaker: 'user',
          confidence: data.channel.alternatives[0].confidence || 1.0,
          is_processed: true,
          timestamp: new Date().toISOString()
        }]);
      } catch (dbErr) {
        console.error('❌ Error saving transcript to DB:', dbErr);
      }
      // Generate AI response and send TTS
      const aiText = await generateAIResponse(callId, transcript);
      console.log('🤖 AI:', aiText);
      await sendTTSResponse(plivoWs, aiText);
    } else if (transcript) {
      console.log('📝 Interim transcript:', transcript);
    }
  });

  dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('❌ Deepgram transcription error:', err);
  });

  dgConnection.on(LiveTranscriptionEvents.Close, () => {
    console.log('🔌 Deepgram transcription connection closed');
  });

  // Handle Plivo messages
  plivoWs.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media' && data.media?.payload) {
        // Forward audio to Deepgram
        dgConnection.send(Buffer.from(data.media.payload, 'base64'));
      }
      console.log('📥 Received message from Plivo:', data.event, JSON.stringify(data));
      switch (data.event) {
        case 'media':
          break;
        case 'start':
          console.log('🎬 Stream started');
          streamId = data.start.streamId;
          console.log('📝 Stream ID:', streamId);
          break;
        default:
          console.log('📥 Other Plivo event:', data.event);
      }
    } catch (error) {
      console.error('❌ Failed to process Plivo message:', error);
    }
  });

  plivoWs.on('error', (error) => {
    console.error('❌ Plivo WebSocket error:', error);
  });

  plivoWs.on('close', () => {
    console.log('📞 Plivo WebSocket closed, initiating cleanup');
    cleanup();
  });

  // Clean up
  const cleanup = async () => {
    console.log('🧹 Starting cleanup for call:', callId);
    try {
      if (keepAliveInterval) {
        console.log('Clearing keepAlive interval');
        clearInterval(keepAliveInterval);
      }
      dgConnection.finish();
      await supabase
        .from('calls')
        .update({ 
          status: 'completed',
          end_time: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('call_uuid', callId);
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
});

// Start server
server.listen(port, () => {
  console.log(`✅ Deepgram Voice Agent running on port ${port}...`);
});

// Add API endpoints for transcript retrieval
app.get('/api/calls/:callId/transcripts', async (req, res) => {
  try {
    const { callId } = req.params;
    const { data, error } = await supabase
      .from('transcripts')
      .select('*')
      .eq('call_uuid', callId)
      .order('timestamp', { ascending: true });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching transcripts:', error);
    res.status(500).json({ error: 'Failed to fetch transcripts' });
  }
});

// Add error handling to call initiation
app.post('/api/calls/initiate', async (req, res) => {
  console.log('🔥 initiate endpoint hit, body:', req.body);
  try {
    const { from, to, appId } = req.body;
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'Missing required parameters: from and to numbers' });
    }
    const formattedFrom = from.startsWith('+') ? from : `+${from}`;
    const formattedTo = to.startsWith('+') ? to : `+${to}`;
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const answerUrl = `${baseUrl}/plivo-xml`;
    console.log('📞 Initiating call from', formattedFrom, 'to', formattedTo);
    console.log('📞 Answer URL:', answerUrl);
    const callOptions = {
      answerMethod: 'GET',
      statusCallbackUrl: `${baseUrl}/api/calls/status`,
      statusCallbackMethod: 'POST'
    };
    if (appId) {
      callOptions.applicationId = appId;
    }
    try {
      const response = await plivoClient.calls.create(
        formattedFrom,
        formattedTo,
        answerUrl,
        callOptions
      );
      console.log('✅ Call initiated successfully:', response.requestUuid);
      res.json({
        success: true,
        requestId: response.requestUuid,
        message: 'Call initiated successfully'
      });
    } catch (plivoErr) {
      console.error('❌ Error initiating call with Plivo:', plivoErr);
      res.status(500).json({
        success: false,
        error: 'Failed to initiate call',
        details: plivoErr.message || 'Unknown error occurred'
      });
    }
  } catch (error) {
    console.error('❌ Error in /api/calls/initiate:', error);
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

    // Update call record
    await supabase
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

    res.status(200).send('Status updated');
  } catch (error) {
    console.error('❌ Error updating call status:', error);
    res.status(500).json({ error: 'Failed to update call status' });
  }
});

// Add error handling to /api/stream-status
app.post('/api/stream-status', async (req, res) => {
  console.log('🔄 Raw /api/stream-status body:', req.body);
  console.log('🔄 Headers:', req.headers);
  if (!req.body || Object.keys(req.body).length === 0) {
    console.error('❌ /api/stream-status: Empty or malformed request body');
    return res.status(400).json({ error: 'Empty or malformed request body' });
  }
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
    const insertData = {
      call_uuid: CallUUID,
      status: StreamStatus,
      error_code: ErrorCode,
      error_message: ErrorMessage,
      timestamp: new Date().toISOString()
    };
    console.log('🔄 Attempting to insert into stream_status:', insertData);
    const { error } = await supabase
      .from('stream_status')
      .insert([insertData]);
    if (error) {
      console.error('❌ Supabase insert error:', error);
      throw error;
    }
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

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: err.message
  });
});

// Add 404 handler
app.use((req, res) => {
  console.log('❌ Route not found:', req.method, req.path);
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.path
  });
});

// Confirm Plivo XML is generating the correct WebSocket URL
const plivoXmlHandler = (req, res) => {
  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
  const callUUID = req.query.CallUUID || req.body.CallUUID || '';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const wsUrl = `wss://${wsHost}/listen?call_uuid=${callUUID}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Stream\n    streamTimeout="3600"\n    keepCallAlive="true"\n    bidirectional="true"\n    contentType="audio/x-mulaw;rate=8000"\n    audioTrack="inbound"\n    statusCallbackUrl="${baseUrl}/api/stream-status"\n  >${wsUrl}</Stream>\n</Response>`;
  console.log('📝 Generated XML for Plivo, WebSocket URL:', wsUrl);
  res.set('Content-Type', 'text/xml');
  res.send(xml);
};
app.get('/plivo-xml', plivoXmlHandler);
app.post('/plivo-xml', plivoXmlHandler);

// Reminder: If Plivo is not connecting via WebSocket, double-check your Plivo application config and the generated XML above.
