// tts-test.js
import dotenv from 'dotenv';
import { createClient } from '@deepgram/sdk';

dotenv.config();

async function testStreamingTTS() {
  const DG_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DG_KEY) throw new Error('Please set DEEPGRAM_API_KEY in .env');

  const dg = createClient(DG_KEY);
  console.log('🔌 Connecting to Deepgram TTS WebSocket…');

  // Kick off a streaming-TTS request
  const response = await dg.speak.request(
    { text: 'Hello, this is a low-latency test.' },
    {
      model: 'aura-2-thalia-en',   // or 'aura-asteria-en'
      encoding: 'mulaw',
      sample_rate: 8000,
      streaming: true
    }
  );

  const stream = await response.getStream();
  let totalBytes = 0;

  // This is the key change — async-iterate the chunks:
  for await (const chunk of stream) {
    totalBytes += chunk.length;
    console.log(`▶️ Got ${chunk.length} bytes (total ${totalBytes})`);
  }

  console.log('✅ Stream ended, total bytes:', totalBytes);
}

testStreamingTTS().catch(console.error);
