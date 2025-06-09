import { createClient } from '@deepgram/sdk';

async function testStreamingTTS() {
  const DG_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DG_KEY) throw new Error('Set DEEPGRAM_API_KEY in .env');
  const dg = createClient(DG_KEY);

  console.log('🔌 Connecting to Deepgram TTS WebSocket…');
  // streaming:true gives you real-time audio chunks
  const response = await dg.speak.request(
    { text: 'Hello, this is a low-latency test.' },
    {
      model: 'aura-asteria-en',
      streaming: true
    }
  );

  const stream = await response.getStream();
  let total = 0;
  stream.on('data', (chunk) => {
    total += chunk.length;
    console.log(`▶️  Got ${chunk.length} bytes; total so far: ${total}`);
  });
  stream.on('end', () => console.log('✅  Stream ended, total bytes:', total));
  stream.on('error', (err) => console.error('🚨 Stream error:', err));
}

testStreamingTTS().catch(console.error);
