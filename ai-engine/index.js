// index.js — Audio → (Groq STT turbo) → (Groq Chat instant) → ElevenLabs (your voice) → WAV
// Node 18+  |  Vercel-ready (exports app; no listen() on Vercel)
// deps:  npm i express cors multer dotenv

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

const app = express();
app.use(express.json({ limit: '1mb', type: ['application/json', 'text/json'] }));
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Accept', 'Accept-Charset'] }));

const GROQ_KEY   = process.env.GROQ_API_KEY;
const ELEVEN_URL = process.env.VOICE_BACKEND_BASE || 'https://virtual-me-backend.vercel.app';
const VOICE_ID   = process.env.VOICE_ID || 'FXeTfnSWNOAh4GQOUctK';

// ✅ Speed models you requested:
const STT_MODEL   = process.env.GROQ_STT_MODEL   || 'whisper-large-v3-turbo';
const CHAT_MODEL  = process.env.GROQ_CHAT_MODEL  || 'llama-3.1-8b-instant';
const MAX_TOKENS  = Number(process.env.MAX_TOKENS || 768); // bigger outputs than 138

const isVercel = process.env.VERCEL === '1';

if (!GROQ_KEY) console.warn('⚠️ Missing GROQ_API_KEY');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error(`Unsupported audio type: ${file.mimetype}`), ok);
  },
});

app.get('/', (_req, res) => {
  res
    .type('text/plain; charset=utf-8')
    .send(`Voice API up.

POST /voice  (multipart form field: audio)
Models:
  STT: ${STT_MODEL}
  Chat: ${CHAT_MODEL}  (max_tokens=${MAX_TOKENS})
`);
});

app.get('/healthz', (_req, res) => res.type('application/json; charset=utf-8').send(JSON.stringify({ ok: true })));

// ---- Core endpoint: audio in → text → chat → TTS ----
app.post('/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).type('text/plain; charset=utf-8').send('No file uploaded as "audio"');
    if (!GROQ_KEY) return res.status(500).type('text/plain; charset=utf-8').send('Missing GROQ_API_KEY');

    // 1) STT (Groq) — turbo, multilingual (no translation)
    const sttFd = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' });
    sttFd.append('file', audioBlob, req.file.originalname || 'audio.wav');
    sttFd.append('model', STT_MODEL);
    sttFd.append('response_format', 'json');

    const sttResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: sttFd,
    });
    if (!sttResp.ok) {
      const errTxt = await sttResp.text();
      return res.status(502).type('application/json; charset=utf-8').send(JSON.stringify({ error: 'STT failed', detail: errTxt }));
    }
    const { text: transcript = '' } = await sttResp.json();

    // 2) Chat (Groq) — instant model; reply in same language; allow bigger outputs
    const systemMsg =
      'You are a friendly, concise voice assistant. Detect the user language and reply in that language. Prefer 1–3 sentences unless a longer answer is necessary.';

    const chatResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept-Charset': 'utf-8',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0.7,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: transcript || 'Greet politely.' },
        ],
      }),
    });
    if (!chatResp.ok) {
      const errTxt = await chatResp.text();
      return res.status(502).type('application/json; charset=utf-8').send(JSON.stringify({ error: 'Chat failed', detail: errTxt, transcript }));
    }
    const chatJson = await chatResp.json();
    const replyText = (chatJson?.choices?.[0]?.message?.content || '').trim()
      || (transcript ? `OK: ${transcript}` : 'Hello!');

    // 3) ElevenLabs proxy — your cloned voice
    const ttsResp = await fetch(`${ELEVEN_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'audio/wav' },
      body: JSON.stringify({ voiceId: VOICE_ID, text: replyText }),
    });
    if (!ttsResp.ok) {
      const t = await ttsResp.text();
      return res.status(ttsResp.status).type('application/json; charset=utf-8')
        .send(JSON.stringify({ error: 'TTS proxy failed', detail: t, replyText, transcript }));
    }

    const audioBuf = Buffer.from(await ttsResp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-Reply-Text', encodeURIComponent(replyText));
    res.setHeader('X-Transcript', encodeURIComponent((transcript || '').slice(0, 800)));
    return res.status(200).send(audioBuf);
  } catch (err) {
    console.error(err);
    return res.status(500).type('application/json; charset=utf-8').send(JSON.stringify({ error: 'Server error' }));
  }
});

// Local dev: listen. Vercel: export default app.
if (!isVercel) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Voice API listening on http://localhost:${PORT}`));
}

export default app;
