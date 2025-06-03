# AI Voice Call Agent

An AI-powered voice call agent using Plivo for voice calls, Deepgram for transcription, and OpenAI for responses.

## Setup

1. Clone the repository
```bash
git clone <your-repo-url>
cd <repo-name>
```

2. Install dependencies
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_key
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_key
```

4. Start the server
```bash
npm start
```

## Features

- Real-time speech transcription using Deepgram
- AI responses using OpenAI GPT-3.5
- Text-to-Speech using Plivo
- Call metrics and conversation storage using Supabase

## Environment Variables

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_KEY`: Your Supabase service role key
- `DEEPGRAM_API_KEY`: Your Deepgram API key
- `OPENAI_API_KEY`: Your OpenAI API key

## Dependencies

- express
- express-ws
- plivo
- @supabase/supabase-js
- dotenv
- node-fetch
- ws

## Note

Make sure to never commit your `.env` file or any API keys to version control. 