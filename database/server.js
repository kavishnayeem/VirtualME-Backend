// server.js (only the parts that changed vs your posted file)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { MongoClient, ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

dotenv.config();

const {
  MONGODB_URI,
  MONGODB_DB = 'virtualme',
  JWT_SECRET = 'change_me',
  GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_SECRET,
  BACKEND_BASE = 'http://localhost:4000',
  PUBLIC_BASE_URL,
  WEB_ORIGIN,
} = process.env;

if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_WEB_CLIENT_SECRET) throw new Error('Missing Google client credentials');

const app = express();
app.use(express.json());
app.use(cookieParser());

const corsOrigins = [
  'http://localhost:8081',
  'http://localhost:19006',
  WEB_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// --- Mongo ---
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const Users = db.collection('users');

const oauth = new OAuth2Client({ clientId: GOOGLE_WEB_CLIENT_ID, clientSecret: GOOGLE_WEB_CLIENT_SECRET });

function signSession(userId) { return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' }); }

async function authMiddleware(req, _res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.vm;
  if (!token) return next();
  try { const payload = jwt.verify(token, JWT_SECRET); req.userId = payload.uid; } catch {}
  next();
}
app.use(authMiddleware);

function getBaseFromReq(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  return BACKEND_BASE.replace(/\/$/, '');
}

function sendSessionJson(res, userDoc) {
  const token = signSession(userDoc._id.toString());
  res.json({ token, user: { name: userDoc.name, email: userDoc.email, picture: userDoc.picture } });
}

const EMPTY_PROFILE = Object.freeze({
  character: '',
  homeAddress: '',
  usualPlaces: [],
  languages: [],
  timeZone: '',
  availability: '',
  voiceStyle: '',
  aiPersona: '',
  calendarPrefs: '',
  locationSharingOptIn: false,
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));

// ---------- OAuth start ----------
app.get('/auth/google/start', (req, res) => {
  const base = getBaseFromReq(req);
  const redirectUri = `${base}/auth/callback`;
  const scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly'];
  const { app_redirect } = req.query;
 const stateObj = app_redirect ? { app_redirect } : null;
 const state = stateObj ? Buffer.from(JSON.stringify(stateObj)).toString('base64url') : undefined;
 const url = oauth.generateAuthUrl({
   access_type: 'offline',
   prompt: 'consent',
   scope: scopes,
   redirect_uri: redirectUri,
   ...(state ? { state } : {}),
 });
  res.redirect(url);
});

// ---------- OAuth callback (fixed) ----------
app.get('/auth/callback', async (req, res) => {
  try {
  const base = PUBLIC_BASE_URL || BACKEND_BASE;
  const redirectUri = `${base}/auth/callback`;
  
  
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code');
  
  
  const { tokens } = await oauth.getToken({ code, redirect_uri: redirectUri });
  if (!tokens.id_token) return res.status(400).send('No id_token');
  
  
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_WEB_CLIENT_ID });
  const p = ticket.getPayload();
  
  
  const update = {
  googleId: p.sub,
  email: p.email,
  name: p.name,
  picture: p.picture,
  refreshToken: tokens.refresh_token ?? undefined,
  accessToken: tokens.access_token ?? undefined,
  tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
  updatedAt: new Date(),
  };
  
  
  // ✅ Upsert then fetch explicitly (driver‑safe)
  await Users.updateOne(
  { googleId: p.sub },
  { $set: update, $setOnInsert: { createdAt: new Date(), profile: { ...EMPTY_PROFILE } } },
  { upsert: true }
  );
  
  
  const doc = await Users.findOne({ googleId: p.sub });
  if (!doc) return res.status(500).send('User insert failed');
  
  
  
     const token = signSession(doc._id.toString());
   const userPayload = { name: doc.name, email: doc.email, picture: doc.picture };

   // Native deep link
   let appRedirect = null;
   if (state && typeof state === 'string') {
     try {
       const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
       if (parsed?.app_redirect && typeof parsed.app_redirect === 'string') {
         appRedirect = parsed.app_redirect;
       }
     } catch {}
   }
   if (appRedirect) {
    const url = `${appRedirect}?token=${encodeURIComponent(token)}&user=${encodeURIComponent(JSON.stringify(userPayload))}`;
     return res
       .set('Content-Type', 'text/html')
       .send(`<!doctype html><meta charset="utf-8" />
<script>
  // Deep link back to the app, then close the tab
  window.location.href = ${JSON.stringify(url)};
  setTimeout(function(){ window.close(); }, 750);
</script>
<p>Returning to the app…</p>`);
   }

   // Web popup fallback (unchanged)
   const targetOrigin = WEB_ORIGIN || '*';
   return res
     .set('Content-Type','text/html')
     .send(`<!doctype html><meta charset="utf-8" />
<script>
 (function(){
   var payload = ${JSON.stringify({ token, user: userPayload })};
   if (window.opener) window.opener.postMessage({ type: 'vm-auth', payload }, '${targetOrigin}');
   window.close();
 })();
</script>
<p>You can close this window.</p>`);
  } catch (e) {
  console.error('[OAUTH CALLBACK ERROR]', e);
  res.status(500).send('OAuth callback failed');
  }
  });
// ---------- Me (protected) ----------
app.get('/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const doc = await Users.findOne(
    { _id: new ObjectId(req.userId) },
    { projection: { name: 1, email: 1, picture: 1, profile: 1 } }
  );
  if (!doc) return res.status(404).json({ error: 'not found' });
  // Normalize: ensure profile always present
  doc.profile = doc.profile || { ...EMPTY_PROFILE };
  res.json({ _id: doc._id, name: doc.name, email: doc.email, picture: doc.picture, profile: doc.profile });
});

// Update profile (protected)
// --- Update profile (protected) ---
app.put('/me', async (req, res) => {
  try {
    if (!req.userId) {
      console.warn('[PUT /me] no req.userId (missing/invalid token)');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const _id = new ObjectId(req.userId);
    const existing = await Users.findOne({ _id }, { projection: { _id: 1 } });
    if (!existing) {
      console.warn('[PUT /me] user not found for _id:', req.userId);
      return res.status(404).json({ error: 'user not found' });
    }

    const profile = sanitizeProfile((req.body && req.body.profile) || {});
    const result = await Users.updateOne(
      { _id },
      { $set: { profile, updatedAt: new Date() } }
    );

    if (!result.acknowledged) {
      console.error('[PUT /me] update not acknowledged for _id:', req.userId);
      return res.status(500).json({ error: 'update failed' });
    }

    const doc = await Users.findOne(
      { _id },
      { projection: { name: 1, email: 1, picture: 1, profile: 1 } }
    );
    return res.json({
      _id: doc._id,
      name: doc.name,
      email: doc.email,
      picture: doc.picture,
      profile: doc.profile || { ...EMPTY_PROFILE },
    });
  } catch (e) {
    console.error('[PROFILE UPDATE ERROR]', e);
    return res.status(500).json({ error: 'update failed' });
  }
});


function sanitizeProfile(raw) {
  const out = { ...EMPTY_PROFILE };
  if (typeof raw.character === 'string') out.character = raw.character.slice(0, 500);
  if (typeof raw.homeAddress === 'string') out.homeAddress = raw.homeAddress.slice(0, 300);
  if (Array.isArray(raw.usualPlaces)) out.usualPlaces = raw.usualPlaces.map(String).slice(0, 50);
  if (Array.isArray(raw.languages)) out.languages = raw.languages.map(String).slice(0, 20);
  if (typeof raw.timeZone === 'string') out.timeZone = raw.timeZone.slice(0, 80);
  if (typeof raw.availability === 'string') out.availability = raw.availability.slice(0, 200);
  if (typeof raw.voiceStyle === 'string') out.voiceStyle = raw.voiceStyle.slice(0, 150);
  if (typeof raw.aiPersona === 'string') out.aiPersona = raw.aiPersona.slice(0, 600);
  if (typeof raw.calendarPrefs === 'string') out.calendarPrefs = raw.calendarPrefs.slice(0, 300);
  if (typeof raw.locationSharingOptIn === 'boolean') out.locationSharingOptIn = raw.locationSharingOptIn;
  return out;
}

// ---------- Calendar example (unchanged) ----------
app.get('/calendar/next', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await Users.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'user not found' });

    oauth.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });

    // (Optional) refresh flow omitted for brevity…
    const calendar = google.calendar({ version: 'v3', auth: oauth });
    const now = new Date().toISOString();
    const resp = await calendar.events.list({ calendarId: 'primary', timeMin: now, singleEvents: true, orderBy: 'startTime', maxResults: 1 });
    const item = resp.data.items?.[0];
    if (!item) return res.json({ message: 'No upcoming events' });
    res.json({ id: item.id, summary: item.summary, start: item.start?.dateTime || item.start?.date, end: item.end?.dateTime || item.end?.date, location: item.location });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'calendar query failed' });
  }
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on :${port}`));
}

export default app;