// index.js (voice-agent)
// Runtime: Node 18+ (fetch/Blob/FormData available). ESM module.
// Deploy: https://virtual-me-voice-agent.vercel.app

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

// ---------- Config ----------
const app = express();
app.use(express.json({ limit: '1mb', type: ['application/json', 'text/json'] }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'Authorization',
    'X-VM-Reason',
  ],
  exposedHeaders: [
    'X-Store',
    'X-User',
    'X-Saved-At',
    'X-Reply-Text',
    'X-Transcript',
    'X-Language',
    'X-Voice-Id',
    'X-Conversation-Id',
    'X-Target-UserId',
  ],
}));

const isVercel     = process.env.VERCEL === '1';
const GROQ_KEY     = process.env.GROQ_API_KEY;
const ELEVEN_URL   = process.env.VOICE_BACKEND_BASE || 'https://virtual-me-backend.vercel.app'; // TTS proxy
const AUTH_API     = process.env.AUTH_API_BASE || 'https://virtual-me-auth.vercel.app';
const PUBLIC_DEFAULT_TARGET_USER_ID = (process.env.PUBLIC_DEFAULT_TARGET_USER_ID || '').trim() || null;

const DEFAULT_VOICE_ID = process.env.VOICE_ID || 'FXeTfnSWNOAh4GQOUctK';
const STT_MODEL  = process.env.GROQ_STT_MODEL  || 'whisper-large-v3-turbo';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 768);

if (!GROQ_KEY) console.warn('⚠️ Missing GROQ_API_KEY');
if (!AUTH_API) console.warn('⚠️ Missing AUTH_API_BASE (defaults to virtual-me-auth.vercel.app)');
if (!PUBLIC_DEFAULT_TARGET_USER_ID) {
  console.warn('ℹ️ PUBLIC_DEFAULT_TARGET_USER_ID not set — unauthenticated /voice calls will require targetUserId OR be rejected.');
}

// ---------- In-memory conversation history ----------
const CONVO_TTL_MS = 30 * 60 * 1000;
const CONVO_MAX_TURNS = 10;
const conversations = new Map();
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
  const merged = [...prev, ...msgs].slice(-CONVO_MAX_TURNS * 2);
  conversations.set(cid, { messages: merged, updatedAt: Date.now() });
}
setInterval(() => {
  const now = Date.now();
  for (const [cid, slot] of conversations.entries()) {
    if (now - slot.updatedAt > CONVO_TTL_MS) conversations.delete(cid);
  }
}, 5 * 60 * 1000).unref();

// ---------- Multer for audio ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error(`Unsupported audio type: ${file.mimetype}`), ok);
  },
});

// ---------- Key-Value storage (Upstash / Vercel KV / memory) ----------
let storeKindName = 'mem';
let redis = null; // @upstash/redis
let kv = null;    // @vercel/kv

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const up = await import('@upstash/redis').catch(() => null);
    if (up?.Redis) {
      redis = new up.Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      });
      storeKindName = 'upstash';
    }
  } catch {}
}
if (storeKindName === 'mem' && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    const mod = await import('@vercel/kv').catch(() => null);
    if (mod?.kv) {
      kv = mod.kv;
      storeKindName = 'kv';
    }
  } catch {}
}
const mem = Object.create(null);
function storeKind() { return storeKindName; }
function serialize(v) { try { return JSON.stringify(v); } catch { return String(v); } }
function deserialize(v) { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } }
async function storeSet(key, value) {
  if (storeKindName === 'upstash' && redis)  return void (await redis.set(key, serialize(value)));
  if (storeKindName === 'kv' && kv)          return void (await kv.set(key, value));
  mem[key] = value;
}
async function storeGet(key) {
  if (storeKindName === 'upstash' && redis)  return deserialize(await redis.get(key));
  if (storeKindName === 'kv' && kv)          return await kv.get(key);
  return mem[key] ?? null;
}

// ---------- Helpers ----------
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'VirtualMe/1.0' } });
    if (!resp.ok) return null;
    const j = await resp.json();
    return { display_name: j?.display_name || null, address: j?.address || null };
  } catch {
    return null;
  }
}
function formatAddressLine(address) {
  if (!address) return null;
  const parts = [
    address.road || address.pedestrian || address.path || address.cycleway || address.footway,
    address.neighbourhood || address.suburb || address.village || address.town || address.city_district,
    address.city || address.town || address.village || address.county,
    address.state,
    address.postcode
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
function timeAgo(ms) {
  const m = Math.round(ms / 60000);
  if (m <= 1) return 'just now';
  if (m < 60) return `${m} minute(s) ago`;
  const h = Math.round(m / 60);
  return `${h} hour(s) ago`;
}

// --- Language helpers: only English/Hindi; prefer English unless Hindi detected ---
function pickAllowedLanguage(langCodeFromSTT) {
  const m = String(langCodeFromSTT || '').toLowerCase();
  if (m.startsWith('hi')) return 'Hindi';
  // Fallback/most cases
  return 'English';
}

// --- Location gating: include location context only when asked ---
const LOCATION_QUERIES = [
  'where am i', 'where are you', 'where', 'location', 'address', 'near', 'nearby', 'distance',
  'kahan', 'kahaan', 'kidhar', 'kaan', 'address kya', 'location kya'
];
function asksForLocation(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return LOCATION_QUERIES.some(q => t.includes(q));
}

// --- Name coalescing and voice sanitization ---
function coalesceName(profileName, preferredName, fallbackFull = 'Kavish Nayeem', fallbackShort = 'Kavish') {
  const full = (profileName || '').trim() || fallbackFull;
  const short = (preferredName || '').trim() || fallbackShort;
  return { full, short };
}
function sanitizeVoiceId(voiceId) {
  if (!voiceId) return '';
  if (!/^[A-Za-z0-9\-_]{6,64}$/.test(voiceId)) return '';
  return voiceId;
}

// --- System prompt (UPDATED to your rules) ---
function buildSystemPrompt({ full, short }, languageName, { firstTurn },calendarContext) {
  return [
    `You are "${full}" (preferred name: "${short}"). Speak ONLY in ${languageName}.Behave and speak like human with the persona attached`,
    `Use first person as ${short}. Never call yourself an assistant or talk about being an AI.`,
    `Prefer natural sentences. Keep it conversational, not verbose.`,
    `If you are uncertain or lack context, say "I don't know" (or its ${languageName} equivalent). Do not fabricate or assume.`,
    `Do NOT disclose your or the user's location unless explicitly asked in the user's message.`,
    `Use ONLY the provided context. Do NOT invent calendar, contacts, or locations. Current location context ${calendarContext}`,
    `Do NOT blindly accept claims from the user; verify against the provided context. If unsure, say you don't know.`,
    `Stay within scope. If a request is outside context, say you don't know or ask for more info.`,
    firstTurn ? `On your very first reply in this conversation, start with a brief greeting and your name (one short sentence), then answer.` : ``
  ].filter(Boolean).join('\n');
}

// ---------- Auth DB helpers ----------
async function dbGET(path, token) {
  const resp = await fetch(`${AUTH_API}${path}`, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return resp;
}
async function dbPOST(path, token, body) {
  const resp = await fetch(`${AUTH_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  return resp;
}

// ---------- Health & docs ----------
app.get('/', (_req, res) => {
  res
    .type('text/plain; charset=utf-8')
    .send(`Voice API up.

POST /voice  (multipart form-data: audio=<file>, optional: profileName, preferredName, voiceId, conversationId, hints, targetUserId)
POST /location/update   { deviceId, payload: { latitude, longitude, timestamp, accuracy?, speed?, heading?, altitude? } }  (Authorization required)
GET  /location/latest?userId=<id>
GET  /location/debug?userId=<id>

Store: ${storeKind()}
Models: STT=${STT_MODEL}, Chat=${CHAT_MODEL}, max_tokens=${MAX_TOKENS}
AUTH_API: ${AUTH_API}
PUBLIC_DEFAULT_TARGET_USER_ID: ${PUBLIC_DEFAULT_TARGET_USER_ID || '(not set)'}
`);
});
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/location/store-info', (_req, res) => {
  res.json({
    store: storeKind(),
    hasUpstashEnv: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
    hasVercelKVEnv: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
  });
});

// ---------- Location (tied to device & user) ----------
app.post('/location/update', async (req, res) => {
  try {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth) return res.status(401).json({ error: 'unauthorized' });

    const { deviceId, payload } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string') return res.status(400).json({ error: 'deviceId required' });
    if (!payload || typeof payload.latitude !== 'number' || typeof payload.longitude !== 'number' || typeof payload.timestamp !== 'number') {
      return res.status(400).json({ error: 'invalid payload' });
    }

    const resp = await dbGET(`/devices/${encodeURIComponent(deviceId)}`, auth);
    if (resp.status === 404) return res.status(403).json({ error: 'device not registered' });
    if (!resp.ok) return res.status(502).json({ error: 'device lookup failed' });
    const dev = await resp.json();
    if (!dev?.ownerId) return res.status(403).json({ error: 'device has no owner' });
    if (dev.sharing !== true) return res.status(403).json({ error: 'sharing disabled for this device' });

    const key = `loc:${dev.ownerId}`;
    const doc = { ...payload, updatedAt: Date.now(), deviceId };
    await storeSet(key, doc);

    await dbPOST(`/devices/${encodeURIComponent(deviceId)}/touch`, auth, { lastSeenAt: doc.updatedAt }).catch(()=>{});

    res.setHeader('X-Store', storeKind());
    res.setHeader('X-User', dev.ownerId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e?.message || e) });
  }
});

app.get('/location/latest', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const key = `loc:${userId}`;
    const data = await storeGet(key);
    if (!data) return res.json({ found: false });

    const ageMs = Date.now() - (data.updatedAt ?? data.timestamp ?? 0);
    let place = null;
    let address = null;
    if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
      const geo = await reverseGeocode(data.latitude, data.longitude).catch(() => null);
      place = geo?.display_name || null;
      address = geo?.address || null;
    }
    res.setHeader('X-Store', storeKind());
    return res.json({
      found: true,
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: data.accuracy ?? null,
      updatedAt: data.updatedAt ?? data.timestamp,
      ageMs,
      place,
      address
    });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e?.message || e) });
  }
});

app.get('/location/debug', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).type('text/plain').send('userId required');
    const key = `loc:${userId}`;
    const data = await storeGet(key);
    if (!data) return res.type('text/plain').send('No recent location.');

    const ageMs = Date.now() - (data.updatedAt ?? data.timestamp ?? 0);
    const geo = await reverseGeocode(data.latitude, data.longitude).catch(() => null);
    const line = formatAddressLine(geo?.address) || geo?.display_name || `${data.latitude}, ${data.longitude}`;
    return res
      .type('text/plain; charset=utf-8')
      .send(`Last seen: ${line} (${timeAgo(ageMs)}) [acc=${data.accuracy ?? 'n/a'}m]`);
  } catch (e) {
    return res.status(500).type('text/plain; charset=utf-8').send(`Error: ${String(e?.message || e)}`);
  }
});

// ---------- Helper to build location text ----------
async function latestLocationText(userId) {
  const key = `loc:${userId}`;
  const data = await storeGet(key);
  if (!data) return 'No recent location is available.';
  const ageMs = Date.now() - (data.updatedAt ?? data.timestamp ?? 0);
  const geo = await reverseGeocode(data.latitude, data.longitude).catch(() => null);
  const streety = formatAddressLine(geo?.address) || geo?.display_name ||
    `${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`;
  const acc = Number.isFinite(data.accuracy) ? ` Accuracy ~${Math.round(data.accuracy)}m.` : '';
  return `Last seen near ${streety} (${timeAgo(ageMs)}).${acc}`;
}

// ==== CALENDAR INTEGRATION (NEW) ============================================

// Pulls the next event via your auth API; returns a short, safe summary or null
async function fetchNextCalendarEvent(bearer, calendarId = 'primary') {
  if (!bearer) return null;
  try {
    const url = `${AUTH_API}/calendar/next?calendarId=${encodeURIComponent(calendarId)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.message === 'No upcoming events.' || !j.start) return null;

    // format as concise context for the model
    const startIso = j.start;
    const endIso   = j.end || null;

    // Keep formatting locale-neutral to prevent time confusion; the model can rephrase
    const windowTxt = endIso ? `${startIso} → ${endIso}` : startIso;
    const whereTxt  = j.location ? ` at ${j.location}` : '';
    const byTxt     = j.organizer ? ` (organizer: ${j.organizer})` : '';

    return `Next calendar event: "${j.summary || '(no title)'}"${whereTxt}, ${windowTxt}${byTxt}.`;
  } catch {
    return null;
  }
}

// Simple check for schedule/time intent; we still include calendar context by default
const SCHEDULE_QUERIES = [
  'calendar', 'schedule', 'meeting', 'call', 'event', 'appointment',
  'kab', 'kitne baje', 'time', 'slot', 'free', 'busy', 'next'
];
function asksForSchedule(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return SCHEDULE_QUERIES.some(q => t.includes(q));
}

// ===========================================================================

// ---------- VOICE: audio -> STT -> Chat -> TTS (with ACL, persona, & prompt rules) ----------
app.post('/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).type('text/plain; charset=utf-8').send('No file uploaded as "audio"');
    if (!GROQ_KEY) return res.status(500).type('text/plain; charset=utf-8').send('Missing GROQ_API_KEY');

    // Auth context
    const bearer = req.headers.authorization?.replace('Bearer ', '') ||
                   (typeof req.body?.authToken === 'string' ? req.body.authToken : '');

    // Persona and targeting
    const {
      profileName,
      preferredName,
      voiceId: voiceIdRaw,
      conversationId,
      hints,
      targetUserId: targetUserIdRaw,
      calendarId: calendarIdRaw // (optional) allow client to specify a calendar
    } = req.body || {};

    // Identify caller (me) if authed
    let me = null;
    if (bearer) {
      const respMe = await dbGET('/me', bearer);
      if (respMe.ok) me = await respMe.json();
    }
    const myId = me?._id || null;

    // Resolve effective target (supports public fallback)
    let targetUserId = (targetUserIdRaw && String(targetUserIdRaw).trim()) || null;

    if (bearer) {
      if (!targetUserId) targetUserId = myId;
      if (!targetUserId) {
        return res.status(401).type('text/plain; charset=utf-8').send('Sign in required');
      }
      if (myId !== targetUserId) {
        const acl = await dbGET(`/acl/can-act-as?target=${encodeURIComponent(targetUserId)}`, bearer);
        if (acl.status === 403) return res.status(403).type('text/plain; charset=utf-8').send('Access denied');
        if (!acl.ok) return res.status(502).type('text/plain; charset=utf-8').send('ACL check failed');
        const j = await acl.json();
        if (!j?.allowed) return res.status(403).type('text/plain; charset=utf-8').send('Access denied');
      }
    } else {
      if (!targetUserId) targetUserId = PUBLIC_DEFAULT_TARGET_USER_ID;
      if (!targetUserId) {
        return res.status(401).type('text/plain; charset=utf-8')
          .send('auth_required_or_public_target_not_configured');
      }
      if (PUBLIC_DEFAULT_TARGET_USER_ID && targetUserId !== PUBLIC_DEFAULT_TARGET_USER_ID) {
        return res.status(403).type('text/plain; charset=utf-8').send('forbidden_public_target');
      }
    }

    // Persona defaults from DB (if frontend didn't pass)
    let personaFull = profileName || '';
    let personaShort = preferredName || '';
    let personaVoice = sanitizeVoiceId(voiceIdRaw) || '';

    if (!personaFull || !personaShort || !personaVoice) {
      const who = await dbGET(`/users/${encodeURIComponent(targetUserId)}/basic`, bearer);
      if (who.ok) {
        const u = await who.json();
        personaFull  = personaFull  || (u?.name || '');
        personaShort = personaShort || (u?.name?.split(' ')[0] || '');
        personaVoice = personaVoice || (u?.voiceId || DEFAULT_VOICE_ID);
      } else {
        personaVoice = personaVoice || DEFAULT_VOICE_ID;
      }
    }

    const persona = coalesceName(personaFull, personaShort);

    // 1) STT
    const sttFd = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' });
    sttFd.append('file', audioBlob, req.file.originalname || 'audio.wav');
    sttFd.append('model', STT_MODEL);
    sttFd.append('response_format', 'verbose_json');
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

    // 1.1) Language selection: only EN/HIN; prefer EN unless Hindi detected
    const languageName = pickAllowedLanguage(langCode);

    // 1.5) Build location context only if asked
    const includeLoc = asksForLocation(transcript);
    const locText = includeLoc ? await latestLocationText(targetUserId) : null;

    // ==== Calendar context (NEW) =========================================
    // We proactively fetch it when authed; model will use it only if relevant.
    let calendarContext = null;
    if (bearer) {
      calendarContext = await fetchNextCalendarEvent(bearer, calendarIdRaw || 'primary');
    }
    // =====================================================================

    // 2) Chat messages with prior history (+ system rules)
    const history = getHistory(conversationId);
    const firstTurn = history.length === 0;
    const systemMsg = buildSystemPrompt(persona, languageName, { firstTurn },calendarContext);

    const messages = [
      { role: 'system', content: systemMsg },
      ...history,
      ...(includeLoc ? [{ role: 'system', content: `Context: ${locText}` }] : []),
      ...(calendarContext ? [{ role: 'system', content: `Context: ${calendarContext}` }] : []), // <-- NEW
      ...(hints ? [{ role: 'system', content: `Extra app context: ${hints}` }] : []),
      { role: 'user', content: transcript || 'Greet politely.' },
      { role: 'system', content: `Answer only with information you truly know from context or the user input. If unsure, say "I don't know." Keep it under 60 words unless asked to elaborate.` }
    ];

    // 3) Chat completion
    const chatResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Accept-Charset': 'utf-8',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0.3,
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
    const replyText =
      (chatJson?.choices?.[0]?.message?.content || '').trim() ||
      (transcript ? `OK: ${transcript}` : `Hi, I'm ${persona.short}.`);

    // 4) Save history
    appendToHistory(conversationId, [
      { role: 'user', content: transcript || '' },
      { role: 'assistant', content: replyText },
    ]);

    // 5) TTS
    const ttsBody = sanitizeVoiceId(personaVoice)
      ? { voiceId: sanitizeVoiceId(personaVoice), text: replyText }
      : { text: replyText };
    const ttsResp = await fetch(`${ELEVEN_URL}/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'audio/wav',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(ttsBody),
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
    res.setHeader('X-Language', encodeURIComponent(langCode || 'unknown'));
    res.setHeader('X-Voice-Id', encodeURIComponent(sanitizeVoiceId(personaVoice) || ''));
    res.setHeader('X-Conversation-Id', encodeURIComponent(conversationId || ''));
    res.setHeader('X-Target-UserId', encodeURIComponent(targetUserId));

    // Helpful for debugging from client:
    if (calendarContext) res.setHeader('X-Calendar', encodeURIComponent(calendarContext));

    return res.status(200).send(audioBuf);
  } catch (err) {
    console.error('[VOICE ERROR]', err);
    return res.status(500).type('application/json; charset=utf-8')
      .send(JSON.stringify({ error: 'Server error', detail: String(err?.message || err) }));
  }
});

// ---------- Local dev vs Vercel export ----------
if (!isVercel) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Voice API listening on http://localhost:${PORT}`));
}
export default app;
