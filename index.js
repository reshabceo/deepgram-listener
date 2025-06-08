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
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create TTS audio directory if it doesn't exist
const TTS_DIR = path.join(__dirname, 'tts-audio');
try {
  await fs.mkdir(TTS_DIR, { recursive: true });
  console.log('✅ TTS directory created/verified');
} catch (error) {
  console.error('❌ Error creating TTS directory:', error);
}

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

// Express and WebSocket server setup
const app = express();
const server = http.createServer(app);
expressWs(app, server);
server.setTimeout(120000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  next();
});

const port = process.env.PORT || 3000;
const KEEP_ALIVE_INTERVAL = 30000;
const RATE_LIMIT_WINDOW = 60000;
const MAX_REQUESTS_PER_WINDOW = 50;
const requestTimestamps = [];

// System prompt
const SYSTEM_PROMPT = `You are a voice-based AI assistant on a phone call. You can hear the caller through speech recognition and respond verbally. Keep responses brief, natural, and focused. You should be professional but conversational.`;

// Supabase client
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
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

// Rate limiting
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

// Conversation manager
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
      startTime: Date.now(),
      lastTranscriptTime: Date.now()
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
    await supabase.from('conversations').insert([{ call_id: callId, start_time: new Date().toISOString(), status: 'active' }]);
  }

  getContext(callId) {
    return this.contexts.get(callId);
  }

  updateContext(callId, message) {
    const ctx = this.contexts.get(callId);
    if (ctx) {
      ctx.messages.push(message);
      if (ctx.messages.length > 10) {
        ctx.messages = [ctx.messages[0], ...ctx.messages.slice(-9)];
      }
    }
  }

  updateMetrics(callId, type, duration) {
    const m = this.metrics.get(callId);
    if (!m) return;
    switch (type) {
      case 'user_speaking': m.userSpeakingTime += duration; break;
      case 'ai_response': m.aiResponseTime += duration; break;
      case 'silence': m.silenceTime += duration; break;
      case 'response_time': m.responseTimes.push(duration); m.turnCount++; break;
    }
    m.lastMetricUpdate = Date.now();
  }

  async endConversation(callId) {
    console.log(`🔚 Ending conversation for ${callId}`);
    const m = this.metrics.get(callId);
    if (m) {
      const totalDuration = Date.now() - m.startTime;
      const avgResponseTime = m.responseTimes.length ? m.responseTimes.reduce((a, b) => a + b) / m.responseTimes.length : 0;
      await supabase.from('conversations').update({ end_time: new Date().toISOString(), status: 'completed' }).eq('call_id', callId);
      await supabase.from('call_metrics').insert([{ call_id: callId, total_duration: totalDuration, user_speaking_time: m.userSpeakingTime, ai_response_time: m.aiResponseTime, silence_time: m.silenceTime, turn_count: m.turnCount, average_response_time: avgResponseTime }]);
      console.log(`📊 Metrics for ${callId}: total=${totalDuration} avgResponse=${avgResponseTime}`);
    }
    this.contexts.delete(callId);
    this.metrics.delete(callId);
  }
}
const conversationManager = new ConversationManager();

// Transcript manager
class TranscriptManager {
  async saveTranscript(callId, transcript) {
    if (!transcript.is_final) return;
    try {
      const confidence = Number(transcript.confidence || 1.0).toFixed(3);
      const { error } = await supabase.from('transcripts').insert([{ call_uuid: callId, transcript: transcript.text, speaker: 'user', confidence, is_processed: true, timestamp: new Date().toISOString() }]);
      if (error) console.error('❌ Error saving transcript:', error);
    } catch (e) {
      console.error('❌ saveTranscript error:', e);
    }
  }
}
const transcriptManager = new TranscriptManager();

// Text utilities
const textUtils = {
  isEndOfThought: (text, elapsed) => {
    if (elapsed > 1500) return true;
    if (/[.!?]$/.test(text.trim())) return true;
    const endPhrases = ['okay', 'right', 'you see', 'you know what i mean', 'thank you'];
    return endPhrases.some(p => text.toLowerCase().trim().endsWith(p));
  },
  cleanTranscript: text => text.replace(/\s+/g, ' ').trim()
    .replace(/(\w)gonna(\w)?/g, '$1going to$2')
    .replace(/(\w)wanna(\w)?/g, '$1want to$2')
    .replace(/(\w)dunno(\w)?/g, '$1don\'t know$2'),
};

// Plivo client
const plivoClient = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

// Deepgram TTS - FIXED STREAMING (use async iteration)
const sendTTSResponse = async (plivoWs, text) => {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);
  console.log('🔊 TTS: Sending text:', text);
  try {
    console.log('🎵 Requesting TTS from Deepgram...');
    const response = await dg.speak.request({ text }, { 
      model: 'aura-2-thalia-en', 
      encoding: 'mulaw', 
      sample_rate: 8000, 
      container: 'none',
      streaming: true 
    });
    
    console.log('🎵 Got TTS response, getting stream...');
    const stream = await response.getStream();
    if (!stream) throw new Error('No TTS stream available');

    let totalBytes = 0;
    let totalChunks = 0;
    
    // Start real-time streaming
    console.log('🎵 Starting real-time audio streaming...');
    
    // Send speak event to initialize audio stream
    plivoWs.send(JSON.stringify({ event: 'speak' }));
    
    for await (const chunk of stream) {
      if (plivoWs.readyState !== WebSocket.OPEN) {
        console.log('⚠️ WebSocket closed during streaming');
        break;
      }

      // Send audio chunk immediately
      plivoWs.send(JSON.stringify({ 
        event: 'media', 
        media: { 
          payload: Buffer.from(chunk).toString('base64'),
          timestamp: Date.now()
        }
      }));
      
      totalBytes += chunk.length;
      totalChunks++;
    }
    
    // Send flush event to ensure all audio is played
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.send(JSON.stringify({ event: 'flush' }));
    }
    
    console.log(`🎵 Audio streaming complete: ${totalChunks} chunks, ${totalBytes} bytes sent`);
    console.log('🔊 TTS stream ended');
  } catch (err) {
    console.error('❌ sendTTSResponse error:', err);
  }
};

// OpenAI response generation
async function generateAIResponse(callId, userMessage) {
  const context = conversationManager.getContext(callId);
  if (!context) return FALLBACK_RESPONSES[0];
  if (!checkRateLimit()) return FALLBACK_RESPONSES[0];

  conversationManager.updateContext(callId, { role: 'user', content: userMessage });
  try {
    console.log('🤖 Calling OpenAI...');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: context.messages, temperature: 0.7, max_tokens: 100, top_p: 0.9 })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const aiText = data.choices[0].message.content || FALLBACK_RESPONSES[0];
    conversationManager.updateMetrics(callId, 'response_time', Date.now() - context.startTime);
    conversationManager.updateContext(callId, { role: 'assistant', content: aiText });
    await supabase.from('conversation_turns').insert([{ call_id: callId, user_message: userMessage, ai_response: aiText, is_openai: true, timestamp: new Date().toISOString() }]);
    return aiText;
  } catch (err) {
    console.error('❌ OpenAI error:', err);
    return FALLBACK_RESPONSES[Math.floor(Math.random() * FALLBACK_RESPONSES.length)];
  }
}

// Plivo XML handler
const plivoXmlHandler = async (req, res) => {
  const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
  const callUUID = req.query.CallUUID || req.body.CallUUID || '';
  const state = req.query.state || 'listen';
  const turn = parseInt(req.query.turn || '1');
  const audioFile = req.query.audio_file;
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const wsUrl = `wss://${wsHost}/listen?call_uuid=${callUUID}`;
  
  let xml;
  
  switch (state) {
    case 'play':
      if (!audioFile) {
        console.error('❌ No audio file specified for play state');
        // Fallback to listen state if no audio file
        xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Redirect>${baseUrl}/plivo-xml?state=listen&amp;call_uuid=${callUUID}&amp;turn=${turn}</Redirect>
</Response>`;
        break;
      }
      
      // First play the audio, then redirect back to listen state
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play>${baseUrl}/tts-audio/${audioFile}</Play>
    <Redirect>${baseUrl}/plivo-xml?state=listen&amp;call_uuid=${callUUID}&amp;turn=${turn + 1}</Redirect>
</Response>`;
      break;
      
    case 'redirect_to_play':
      // Used by WebSocket handler to transition to play state
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Redirect>${baseUrl}/plivo-xml?state=play&amp;call_uuid=${callUUID}&amp;turn=${turn}&amp;audio_file=${audioFile}</Redirect>
</Response>`;
      break;
      
    case 'listen':
    default:
      // Default streaming state for listening
      xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Stream
        bidirectional="true"
        audioTrack="inbound"
        contentType="audio/x-mulaw;rate=8000"
        statusCallbackUrl="${baseUrl}/api/stream-status"
    >${wsUrl}</Stream>
</Response>`;
      break;
  }
  
  console.log('📝 Generated Plivo XML:', xml);
  res.set('Content-Type', 'text/xml');
  res.send(xml);
};
app.get('/plivo-xml', plivoXmlHandler);
app.post('/plivo-xml', plivoXmlHandler);

// WebSocket for Plivo streaming
app.ws('/listen', async (plivoWs, req) => {
  const callId = req.query.call_uuid;
  if (!callId) return plivoWs.close();
  console.log('📞 WS /listen connected:', callId);

  // Make sure a 'calls' row exists for this callId (foreign key for transcripts)
  try {
    const { data: existing, error: checkError } = await supabase
      .from('calls')
      .select('call_uuid')
      .eq('call_uuid', callId)
      .single();
    if (checkError || !existing) {
      await supabase.from('calls').insert([{
        call_uuid: callId,
        status: 'connected',
        call_type: 'outbound',
        direction: 'OUTBOUND',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
    }
  } catch (e) { console.error('Error creating call record:', e); }

  // Keep-alive ping
  plivoWs.ping();
  const keepAlive = setInterval(() => { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.ping(); }, KEEP_ALIVE_INTERVAL);

  // Initialize context
  await conversationManager.initializeContext(callId);

  // Send greeting
  try {
    const greetingText = 'Hello, this is your AI assistant. How may I help?';
    const audioFile = await generateTTSFile(greetingText, callId);
    // Instead of calls.update, we'll respond with XML that includes <Redirect>
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Redirect>${baseUrl}/plivo-xml?state=play&amp;call_uuid=${callId}&amp;turn=1&amp;audio_file=${audioFile}</Redirect>
</Response>`;
    plivoWs.send(JSON.stringify({ event: 'redirect', xml }));
  } catch (e) {
    console.error('❌ Greeting error:', e);
  }

  // Setup Deepgram
  const dgClient = createClient(process.env.DEEPGRAM_API_KEY);
  const dgConn = dgClient.listen.live({ model: 'nova-3', language: 'en-US', encoding: 'mulaw', sample_rate: 8000 });
  dgConn.on(LiveTranscriptionEvents.Open, () => console.log('✅ Deepgram open'));
  dgConn.on(LiveTranscriptionEvents.Error, err => console.error('❌ DG error:', err));
  dgConn.on(LiveTranscriptionEvents.Close, () => console.log('🔌 DG closed'));

  dgConn.on(LiveTranscriptionEvents.Transcript, async data => {
    const raw = data.channel.alternatives[0].transcript || '';
    console.log(`📝 [${data.is_final ? 'final' : 'interim'}]`, raw);
    const cleaned = textUtils.cleanTranscript(raw);
    const ctx = conversationManager.getContext(callId);
    const now = Date.now();
    const elapsed = now - ctx.lastTranscriptTime;
    ctx.lastTranscriptTime = now;
    ctx.transcriptBuffer += cleaned + ' ';
    
    if (data.is_final && textUtils.isEndOfThought(ctx.transcriptBuffer, elapsed)) {
      const userUtterance = ctx.transcriptBuffer.trim();
      ctx.transcriptBuffer = '';
      console.log('🗣️ EOT:', userUtterance);
      
      // Save transcript
      transcriptManager.saveTranscript(callId, { 
        is_final: true, 
        text: userUtterance, 
        confidence: data.channel.alternatives[0].confidence 
      });
      
      // Generate AI response
      const aiText = await generateAIResponse(callId, userUtterance);
      
      // Generate TTS audio file and send redirect XML
      try {
        const audioFile = await generateTTSFile(aiText, callId);
        const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Redirect>${baseUrl}/plivo-xml?state=play&amp;call_uuid=${callId}&amp;turn=${ctx.turnCount + 1}&amp;audio_file=${audioFile}</Redirect>
</Response>`;
        plivoWs.send(JSON.stringify({ event: 'redirect', xml }));
      } catch (error) {
        console.error('❌ TTS/Redirect error:', error);
      }
    }
  });

  plivoWs.on('message', msg => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.event === 'media' && d.media?.payload) {
        dgConn.send(Buffer.from(d.media.payload, 'base64'));
      }
    } catch (e) {
      console.error('❌ WS msg error:', e);
    }
  });

  plivoWs.on('close', () => {
    console.log('📞 WS closed');
    clearInterval(keepAlive);
    dgConn.finish();
    conversationManager.endConversation(callId);
  });
});

// Plivo list applications
app.get('/api/plivo/list-apps', async (req, res) => {
  try {
    const applications = await plivoClient.applications.list();
    res.json({ success: true, applications });
  } catch (error) {
    console.error('❌ list-apps error:', error);
    res.status(500).json({ success: false, error: 'Failed to list applications', details: error.message });
  }
});

// Create AI assistant application
app.post('/api/plivo/create-ai-assistant', async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const appName = 'AI_Voice_Assistant';
    const answerUrl = `${baseUrl}/plivo-xml`;
    const application = await plivoClient.applications.create(appName, { answerUrl, answerMethod: 'GET' });
    res.json({ success: true, applicationId: application.appId, message: 'Created AI Assistant app' });
  } catch (error) {
    console.error('❌ create-app error:', error);
    res.status(500).json({ success: false, error: 'Failed to create app', details: error.message });
  }
});

// Initiate call
app.post('/api/calls/initiate', async (req, res) => {
  try {
    const { from, to, appId } = req.body;
    if (!from || !to) return res.status(400).json({ success: false, error: 'Missing from/to' });
    
    const f = from.startsWith('+') ? from : `+${from}`;
    const t = to.startsWith('+') ? to : `+${to}`;
    const baseUrl = process.env.BASE_URL.replace(/\/$/, '');
    const answerUrl = `${baseUrl}/plivo-xml`;
    
    // Add retry logic with delay
    const makeCall = async (attempt = 1) => {
      try {
        const options = { 
          answerMethod: 'GET',
          statusCallbackUrl: `${baseUrl}/api/calls/status`,
          statusCallbackMethod: 'POST',
          // Add ring timeout
          ringTimeout: 60,
          // Add machine detection
          machineDetection: true,
          machineDetectionTime: 5000,
          // Add fallback URL in case primary fails
          fallbackMethod: 'GET',
          fallbackUrl: `${baseUrl}/plivo-xml`
        };
        
        if (appId) options.applicationId = appId;
        
        console.log(`📞 Attempting call (try ${attempt})...`);
        const response = await plivoClient.calls.create(f, t, answerUrl, options);
        return response;
      } catch (error) {
        if (attempt < 2) {
          console.log(`⏳ Call attempt ${attempt} failed, retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          return makeCall(attempt + 1);
        }
        throw error;
      }
    };
    
    // Wait a bit for the server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const response = await makeCall();
    res.json({ success: true, requestId: response.requestUuid });
  } catch (error) {
    console.error('❌ initiate error:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate call', details: error.message });
  }
});

// Call status webhook
app.post('/api/calls/status', async (req, res) => {
  try {
    const { CallUUID, CallStatus, Duration, TotalCost, From, To, EndTime, StartTime, AnswerTime } = req.body;
    await supabase.from('calls').update({ status: CallStatus, duration: Duration, cost: TotalCost, end_time: EndTime, start_time: StartTime, answer_time: AnswerTime, updated_at: new Date().toISOString() }).eq('call_uuid', CallUUID);
    res.send('OK');
  } catch (error) {
    console.error('❌ status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Stream status webhook
app.post('/api/stream-status', async (req, res) => {
  try {
    if (!req.body || Object.keys(req.body).length === 0) return res.status(400).json({ error: 'Empty body' });
    const { CallUUID, StreamStatus, ErrorCode, ErrorMessage } = req.body;
    await supabase.from('stream_status').insert([{ call_uuid: CallUUID, status: StreamStatus, error_code: ErrorCode, error_message: ErrorMessage, timestamp: new Date().toISOString() }]);
    res.json({ message: 'Stream status recorded' });
  } catch (error) {
    console.error('❌ stream-status error:', error);
    res.status(500).json({ error: 'Failed to record stream status' });
  }
});

// Test Plivo credentials
app.get('/api/plivo/test', async (req, res) => {
  try {
    const account = await plivoClient.accounts.get(process.env.PLIVO_AUTH_ID);
    const numbers = await plivoClient.numbers.list();
    res.json({ success: true, account: { type: account.accountType, status: account.status }, numbers });
  } catch (error) {
    console.error('❌ plivo test error:', error);
    res.status(500).json({ success: false, error: 'Test failed', details: error.message });
  }
});

// Health check
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TTS file generation
async function generateTTSFile(text, callId) {
  const dg = createClient(process.env.DEEPGRAM_API_KEY);
  console.log('🔊 TTS: Generating audio file for:', text);
  
  try {
    const filename = `${callId}-${Date.now()}.wav`;
    const filepath = path.join(TTS_DIR, filename);
    
    const response = await dg.speak.request({ text }, { 
      model: 'aura-2-thalia-en',
      encoding: 'mulaw',
      sample_rate: 8000,
      container: 'wav'  // Changed to WAV for better compatibility
    });
    
    const audioData = await response.arrayBuffer();
    await fs.writeFile(filepath, Buffer.from(audioData));
    
    console.log(`💾 TTS audio saved: ${filename}`);
    return filename;
  } catch (err) {
    console.error('❌ TTS generation error:', err);
    throw err;
  }
}

// Serve TTS audio files
app.get('/tts-audio/:filename', async (req, res) => {
  try {
    const filepath = path.join(TTS_DIR, req.params.filename);
    res.setHeader('Content-Type', 'audio/wav');
    res.sendFile(filepath);
  } catch (error) {
    console.error('❌ Error serving TTS file:', error);
    res.status(500).send('Error serving audio file');
  }
});

// Cleanup old TTS files (run every hour)
setInterval(async () => {
  try {
    const files = await fs.readdir(TTS_DIR);
    const now = Date.now();
    for (const file of files) {
      const filepath = path.join(TTS_DIR, file);
      const stats = await fs.stat(filepath);
      // Delete files older than 1 hour
      if (now - stats.mtimeMs > 3600000) {
        await fs.unlink(filepath);
        console.log(`🗑️ Deleted old TTS file: ${file}`);
      }
    }
  } catch (error) {
    console.error('❌ TTS cleanup error:', error);
  }
}, 3600000);

// Error and 404 handlers
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
});
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found', path: req.path });
});

// Start server
server.listen(port, () => console.log(`✅ AI Voice Agent running on port ${port}`));
