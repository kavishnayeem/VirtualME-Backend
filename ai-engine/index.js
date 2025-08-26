// index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

// Node 18+ has global fetch/Blob/FormData (undici).
// If you're on older Node, install undici or form-data & cross-blob.

const app = express();
app.use(express.json({ limit: '1mb', type: ['application/json', 'text/json'] }));
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Accept', 'Accept-Charset'] }));

const GROQ_KEY   = process.env.GROQ_API_KEY;
const ELEVEN_URL = process.env.VOICE_BACKEND_BASE || 'https://virtual-me-backend.vercel.app';
const DEFAULT_VOICE_ID = process.env.VOICE_ID || 'FXeTfnSWNOAh4GQOUctK';

// Speedy models you requested
const STT_MODEL  = process.env.GROQ_STT_MODEL  || 'whisper-large-v3-turbo';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 768);

const isVercel = process.env.VERCEL === '1';
if (!GROQ_KEY) console.warn('⚠️ Missing GROQ_API_KEY');

/** ──────────────────────────────────────────────────────────────
 * Conversation memory (in-memory LRU per conversationId)
 * - Frontend should send a stable conversationId (e.g., device/session UUID).
 * - We keep last 10 turns, TTL 30 minutes.
 * - NOTE: Will reset on server restart / scale.
 * ────────────────────────────────────────────────────────────── */
const CONVO_TTL_MS = 30 * 60 * 1000;
const CONVO_MAX_TURNS = 10;
const conversations = new Map(); // cid -> { messages: [ {role, content} ], updatedAt }

function getHistory(cid) {
  if (!cid) return [];
  const slot = conversations.get(cid);
  if (!slot) return [];
  if (Date.now() - slot.updatedAt > CONVO_TTL_MS) {
    conversations.delete(cid);
    return [];
  }
  return slot.messages || [];
}

function appendToHistory(cid, msgs) {
  if (!cid) return;
  const prev = getHistory(cid);
  const merged = [...prev, ...msgs].slice(-CONVO_MAX_TURNS * 2); // roughly user+assistant pairs
  conversations.set(cid, { messages: merged, updatedAt: Date.now() });
}

// periodic GC
setInterval(() => {
  const now = Date.now();
  for (const [cid, slot] of conversations.entries()) {
    if (now - slot.updatedAt > CONVO_TTL_MS) conversations.delete(cid);
  }
}, 5 * 60 * 1000).unref();

/** ──────────────────────────────────────────────────────────────
 * Multer for audio
 * ────────────────────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error(`Unsupported audio type: ${file.mimetype}`), ok);
  },
});

/** ──────────────────────────────────────────────────────────────
 * KV (Upstash/@vercel/kv) optional + in-memory fallback
 * ────────────────────────────────────────────────────────────── */
let kv = null;
try {
  // npm i @vercel/kv  (optional)
  // Top-level await requires "type":"module" in package.json (you likely have it already).
  const mod = await import('@vercel/kv').catch(() => null);
  if (mod?.kv) kv = mod.kv;
} catch { /* ignore */ }

// Simple in-memory fallback (dev only; resets on redeploy)
const mem = Object.create(null);

async function storeSet(key, value) {
  if (kv) { await kv.set(key, value); return; }
  mem[key] = value;
}
async function storeGet(key) {
  if (kv) return await kv.get(key);
  return mem[key] ?? null;
}

/** ──────────────────────────────────────────────────────────────
 * Reverse geocoding helper (optional, best-effort; cache if needed)
 * ────────────────────────────────────────────────────────────── */
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'VirtualMe/1.0' } });
    if (!resp.ok) return null;
    const j = await resp.json();
    return j?.display_name || null;
  } catch {
    return null;
  }
}

/** ──────────────────────────────────────────────────────────────
 * Root + health
 * ────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  res
    .type('text/plain; charset=utf-8')
    .send(`Voice API up.

POST /voice  (multipart form-data: audio=<file>, optional: profileName, preferredName, voiceId, conversationId, hints)

Location:
POST /location/update   { payload: { latitude, longitude, timestamp, accuracy?, speed?, heading?, altitude? } }
GET  /location/latest?userId=kavish

Models:
  STT:  ${STT_MODEL}
  Chat: ${CHAT_MODEL}  (max_tokens=${MAX_TOKENS})
`);
});

app.get('/healthz', (_req, res) =>
  res.type('application/json; charset=utf-8').send(JSON.stringify({ ok: true }))
);

/** ──────────────────────────────────────────────────────────────
 * Language + persona helpers
 * ────────────────────────────────────────────────────────────── */
function coalesceName(profileName, preferredName) {
  const full = (profileName || 'Kavish Nayeem').trim();
  const short = (preferredName || 'Kavish').trim();
  return { full, short };
}

function sanitizeVoiceId(voiceId) {
  if (!voiceId) return DEFAULT_VOICE_ID;
  if (!/^[A-Za-z0-9\-_]{6,64}$/.test(voiceId)) return DEFAULT_VOICE_ID;
  return voiceId;
}

function languageLabel(code) {
  if (!code) return 'the same language as the user';
  const m = code.toLowerCase();
  const map = {
    'en': 'English', 'en-us': 'English', 'en-gb': 'English',
    'fr': 'French',  'es': 'Spanish',  'de': 'German', 'it': 'Italian',
    'hi': 'Hindi',   'ur': 'Urdu',     'pt': 'Portuguese', 'ar': 'Arabic',
    'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean',
  };
  return map[m] || code;
}

function buildSystemPrompt({ full, short }, languageName) {
  return [
    `You are the person "${full}" (preferred name: "${short}").`,
    `Speak **in first person** as ${short}. Do not say you're an assistant, AI, or a bot.`,
    `Keep replies natural, helpful, and concise (usually 1–3 sentences unless more detail is needed).`,
    `Reply **only in ${languageName}**, matching the user's language. Do not translate, do not mix languages.`,
    `If you are unsure, ask a brief clarifying question. If asked who you are, respond as ${short}.`,
    `Avoid making commitments you can't keep (scheduling, promises).`,
    `Context like calendar/location may be integrated later; don't invent details—be honest and brief.`,
  ].join(' ');
}

/** ──────────────────────────────────────────────────────────────
 * LOCATION ENDPOINTS (no auth for now, per your request)
 * Phone pushes latest location → Server stores → Any client fetches latest
 * ────────────────────────────────────────────────────────────── */

// Phone → Server: update latest location
// Body: { payload: { latitude, longitude, timestamp, accuracy?, speed?, heading?, altitude? } }
app.post('/location/update', async (req, res) => {
  try {
    const { payload } = req.body || {};
    if (
      !payload ||
      typeof payload.latitude !== 'number' ||
      typeof payload.longitude !== 'number' ||
      typeof payload.timestamp !== 'number'
    ) {
      return res.status(400).json({ error: 'invalid payload' });
    }

    // For now, single-user "kavish". Later, derive from auth.
    const key = `loc:kavish`;
    const doc = { ...payload, updatedAt: Date.now() };
    await storeSet(key, doc);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e?.message || e) });
  }
});

// Any client → Server: read latest location
// Query: ?userId=kavish
app.get('/location/latest', async (req, res) => {
  try {
    const userId = String(req.query.userId || 'kavish');
    const key = `loc:${userId}`;
    const data = await storeGet(key);
    if (!data) return res.json({ found: false });

    const ageMs = Date.now() - (data.updatedAt ?? data.timestamp ?? 0);
    let place = null;
    if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
      place = await reverseGeocode(data.latitude, data.longitude).catch(() => null);
    }

    return res.json({
      found: true,
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: data.accuracy ?? null,
      updatedAt: data.updatedAt ?? data.timestamp,
      ageMs,
      place // e.g., "Corpus Christi, Texas, United States"
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e?.message || e) });
  }
});

/** ──────────────────────────────────────────────────────────────
 * VOICE: audio → STT → chat → TTS
 * ────────────────────────────────────────────────────────────── */
app.post('/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).type('text/plain; charset=utf-8').send('No file uploaded as "audio"');
    if (!GROQ_KEY) return res.status(500).type('text/plain; charset=utf-8').send('Missing GROQ_API_KEY');

    const {
      profileName,
      preferredName,
      voiceId: voiceIdRaw,
      conversationId,
      hints,
    } = req.body || {};

    const persona = coalesceName(profileName, preferredName);
    const voiceId = sanitizeVoiceId(voiceIdRaw);

    // 1) STT (Groq) — ask for verbose_json to get detected language
    const sttFd = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' });
    sttFd.append('file', audioBlob, req.file.originalname || 'audio.wav');
    sttFd.append('model', STT_MODEL);
    sttFd.append('response_format', 'verbose_json'); // includes "language"

    const sttResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: sttFd,
    });

    if (!sttResp.ok) {
      const errTxt = await sttResp.text();
      return res.status(502).type('application/json; charset=utf-8')
        .send(JSON.stringify({ error: 'STT failed', detail: errTxt }));
    }

    const sttJson = await sttResp.json();
    const transcript = (sttJson?.text || '').trim();
    const langCode = (sttJson?.language || '').trim();
    const langName = languageLabel(langCode || '');

    // 2) Messages with history
    const history = getHistory(conversationId);
    const systemMsg = buildSystemPrompt(persona, langName);

    const messages = [
      { role: 'system', content: systemMsg },
      ...history,
      ...(hints ? [{ role: 'system', content: `Context/hints from user: ${hints}` }] : []),
      { role: 'user', content: transcript || 'Greet politely.' },
    ];

    // 3) Chat (Groq)
    const chatResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept-Charset': 'utf-8',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0.4,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    });

    if (!chatResp.ok) {
      const errTxt = await chatResp.text();
      return res.status(502).type('application/json; charset=utf-8')
        .send(JSON.stringify({ error: 'Chat failed', detail: errTxt, transcript, messages }));
    }

    const chatJson = await chatResp.json();
    const replyText = (chatJson?.choices?.[0]?.message?.content || '').trim()
      || (transcript ? `OK: ${transcript}` : `Hi, I'm ${persona.short}.`);

    // 4) Save history
    appendToHistory(conversationId, [
      { role: 'user', content: transcript || '' },
      { role: 'assistant', content: replyText },
    ]);

    // 5) TTS proxy
    const ttsResp = await fetch(`${ELEVEN_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'audio/wav' },
      body: JSON.stringify({ voiceId, text: replyText }),
    });

    if (!ttsResp.ok) {
      const t = await ttsResp.text();
      return res.status(ttsResp.status).type('application/json; charset=utf-8')
        .send(JSON.stringify({ error: 'TTS proxy failed', detail: t, replyText, transcript, voiceId }));
    }

    const audioBuf = Buffer.from(await ttsResp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('X-Reply-Text', encodeURIComponent(replyText));
    res.setHeader('X-Transcript', encodeURIComponent((transcript || '').slice(0, 800)));
    res.setHeader('X-Language', encodeURIComponent(langCode || 'unknown'));
    res.setHeader('X-Voice-Id', encodeURIComponent(voiceId));
    res.setHeader('X-Conversation-Id', encodeURIComponent(conversationId || ''));
    return res.status(200).send(audioBuf);
  } catch (err) {
    console.error(err);
    return res.status(500).type('application/json; charset=utf-8')
      .send(JSON.stringify({ error: 'Server error', detail: String(err?.message || err) }));
  }
});

// Local dev: listen. Vercel: export default app.
if (!isVercel) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Voice API listening on http://localhost:${PORT}`));
}

export default app;
