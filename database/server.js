// server.js
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
  // Local fallback; in prod we infer from request or PUBLIC_BASE_URL
  BACKEND_BASE = 'http://localhost:4000',
  // Optional: set to your deployed backend origin to avoid inference
  PUBLIC_BASE_URL,
  // Optional: restrict postMessage target origin in popup HTML
  WEB_ORIGIN,
} = process.env;

if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_WEB_CLIENT_SECRET) {
  throw new Error('Missing Google client credentials');
}

const app = express();
app.use(express.json());
app.use(cookieParser());

// --- CORS ---
const corsOrigins = [
  'http://localhost:8081', // Expo Web dev
  'http://localhost:19006', // alt Expo Web port
  WEB_ORIGIN,               // your prod web app origin (optional)
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);             // curl/postman
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, true);                           // permissive during bring-up
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false, // we use Bearer tokens, not cookies
  })
);

// --- Mongo ---
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const Users = db.collection('users');

// --- Google OAuth client ---
// We pass redirect_uri per request dynamically (don’t set in constructor).
const oauth = new OAuth2Client({
  clientId: GOOGLE_WEB_CLIENT_ID,
  clientSecret: GOOGLE_WEB_CLIENT_SECRET,
});

// ---------- Helpers ----------
function signSession(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}

async function authMiddleware(req, _res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.vm;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
  } catch { /* ignore */ }
  next();
}
app.use(authMiddleware);

// Build the base URL for redirects (works on Vercel & locally)
function getBaseFromReq(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').toString();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  return BACKEND_BASE.replace(/\/$/, '');
}

function sendSessionJson(res, userDoc) {
  const token = signSession(userDoc._id.toString());
  res.json({
    token,
    user: { name: userDoc.name, email: userDoc.email, picture: userDoc.picture },
  });
}

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));

// ---------- WEB POPUP FLOW (root paths; no /api) ----------

// Step 1: Start OAuth → redirect to Google
app.get('/auth/google/start', (req, res) => {
  const base = getBaseFromReq(req);
  const redirectUri = `${base}/auth/callback`; // << root callback

  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar.readonly',
  ];

  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    redirect_uri: redirectUri,
  });

  console.log('[OAUTH start] redirect_uri =', redirectUri);
  res.redirect(url);
});

// Step 2: Callback from Google → exchange code, upsert user, postMessage back to opener
app.get('/auth/callback', async (req, res) => {
  try {
    const base = getBaseFromReq(req);
    const redirectUri = `${base}/auth/callback`; // << root callback

    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const { tokens } = await oauth.getToken({ code, redirect_uri: redirectUri });

    const idToken = tokens.id_token;
    if (!idToken) return res.status(400).send('No id_token');

    const ticket = await oauth.verifyIdToken({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
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

    let doc = await Users.findOne({ googleId: p.sub });
    if (doc) {
      if (!update.refreshToken) delete update.refreshToken; // keep existing refresh if not returned
      await Users.updateOne({ _id: doc._id }, { $set: update });
      doc = await Users.findOne({ _id: doc._id });
    } else {
      update.createdAt = new Date();
      const ins = await Users.insertOne(update);
      doc = await Users.findOne({ _id: ins.insertedId });
    }

    const token = signSession(doc._id.toString());

    // Post session to opener and close popup
    const targetOrigin = WEB_ORIGIN || '*';
    res
      .set('Content-Type', 'text/html')
      .send(`<!doctype html><meta charset="utf-8" />
<script>
  (function() {
    var payload = ${JSON.stringify({
      token,
      user: { name: doc.name, email: doc.email, picture: doc.picture },
    })};
    if (window.opener) window.opener.postMessage({ type: 'vm-auth', payload }, '${targetOrigin}');
    window.close();
  })();
</script>
<p>You can close this window.</p>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('OAuth callback failed');
  }
});

// --- Me (protected) ---
app.get('/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const doc = await Users.findOne(
    { _id: new ObjectId(req.userId) },
    { projection: { name: 1, email: 1, picture: 1 } }
  );
  res.json(doc || {});
});

// --- Calendar: next event (protected) ---
app.get('/calendar/next', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await Users.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'user not found' });

    oauth.setCredentials({
      access_token: user.accessToken,
      refresh_token: user.refreshToken,
    });

    // Refresh if missing/expired
    if (!user.accessToken || !user.tokenExpiry || user.tokenExpiry < new Date()) {
      const { credentials } = await oauth.refreshAccessToken();
      await Users.updateOne(
        { _id: user._id },
        {
          $set: {
            accessToken: credentials.access_token,
            tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : undefined,
            refreshToken: credentials.refresh_token ?? user.refreshToken,
          },
        }
      );
      oauth.setCredentials(credentials);
    }

    const calendar = google.calendar({ version: 'v3', auth: oauth });
    const now = new Date().toISOString();
    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 1,
    });

    const item = resp.data.items?.[0];
    if (!item) return res.json({ message: 'No upcoming events' });

    res.json({
      id: item.id,
      summary: item.summary,
      start: item.start?.dateTime || item.start?.date,
      end: item.end?.dateTime || item.end?.date,
      location: item.location,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'calendar query failed' });
  }
});

// -------- Local dev only: listen --------
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on :${port}`));
}

export default app;
