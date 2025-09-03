// server.js

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

dotenv.config();

const {
  MONGODB_URI,
  MONGODB_DB,
  JWT_SECRET ,
  GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_SECRET, 
  PUBLIC_BASE_URL,
  WEB_ORIGIN = '*',
} = process.env;

if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!GOOGLE_WEB_CLIENT_ID) throw new Error('Missing GOOGLE_WEB_CLIENT_ID');
if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL (e.g., https://virtual-me-auth.vercel.app)');

// Single source of truth for redirect
const BASE = PUBLIC_BASE_URL.replace(/\/$/, '');
const REDIRECT_URI = `${BASE}/auth/callback`;

/** -------- APP -------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// CORS: allow all origins (no cookies used)
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

/** -------- DB -------- */
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const Users = db.collection('users');

/** -------- GOOGLE OAuth Clients -------- */
// For verifying idToken (native) AND web popup code flow verifyIdToken
const oauthVerify = new OAuth2Client({ clientId: GOOGLE_WEB_CLIENT_ID });

// For WEB popup code flow (exchange auth code -> tokens)
const oauthWeb =
  GOOGLE_WEB_CLIENT_SECRET
    ? new OAuth2Client({
        clientId: GOOGLE_WEB_CLIENT_ID,
        clientSecret: GOOGLE_WEB_CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      })
    : null;

/** -------- HELPERS -------- */
function signSession(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}

async function authMiddleware(req, _res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.vm;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.uid;
    } catch {
      // ignore
    }
  }
  next();
}
app.use(authMiddleware);

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

/** -------- ROUTES: Health -------- */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));

/** =========================================================
 *  A) NATIVE GOOGLE SIGN-IN (Android/iOS Dev Build)
 *  Client gets Google idToken natively, POSTs here to mint app JWT
 *  ========================================================= */
app.post('/auth/google/native', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });

    // Verify Google idToken (audience = your Web client ID)
    const ticket = await oauthVerify.verifyIdToken({
      idToken,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p?.sub) return res.status(400).json({ error: 'invalid idToken' });

    const update = {
      googleId: p.sub,
      email: p.email,
      name: p.name,
      picture: p.picture,
      updatedAt: new Date(),
    };

    await Users.updateOne(
      { googleId: p.sub },
      { $set: update, $setOnInsert: { createdAt: new Date(), profile: { ...EMPTY_PROFILE } } },
      { upsert: true }
    );

    const doc = await Users.findOne({ googleId: p.sub });
    if (!doc) return res.status(500).json({ error: 'user upsert failed' });

    const token = signSession(doc._id.toString());
    const userPayload = { name: doc.name, email: doc.email, picture: doc.picture };
    return res.json({ token, user: userPayload });
  } catch (e) {
    console.error('[NATIVE GOOGLE AUTH ERROR]', e);
    return res.status(500).json({ error: 'native auth failed' });
  }
});

/** =========================================================
 *  B) WEB POPUP FLOW (optional; keeps your web login working)
 *  /auth/google/start -> user consents -> /auth/callback
 *  ========================================================= */
app.get('/auth/google/start', (req, res) => {
  if (!oauthWeb) return res.status(500).send('Server not configured for web OAuth flow');
  const scopes = [
    'openid',
    'email',
    'profile',
    // add calendar if you need it for web-based consent
    'https://www.googleapis.com/auth/calendar.readonly',
  ];
  const { app_redirect } = req.query;
  const state = app_redirect
    ? Buffer.from(JSON.stringify({ app_redirect })).toString('base64url')
    : undefined;

  const url = oauthWeb.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    redirect_uri: REDIRECT_URI,
    ...(state ? { state } : {}),
  });

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!oauthWeb) return res.status(500).send('Server not configured for web OAuth flow');

    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    // Exchange code -> tokens using the SAME redirect_uri
    const { tokens } = await oauthWeb.getToken({ code, redirect_uri: REDIRECT_URI });
    if (!tokens.id_token) return res.status(400).send('No id_token');

    // Validate id_token and get profile
    const ticket = await oauthVerify.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const p = ticket.getPayload();

    const update = {
      googleId: p.sub,
      email: p.email,
      name: p.name,
      picture: p.picture,
      // keep access/refresh tokens if you want to call Google APIs on behalf of the user (web)
      refreshToken: tokens.refresh_token ?? undefined,
      accessToken: tokens.access_token ?? undefined,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
      updatedAt: new Date(),
    };

    await Users.updateOne(
      { googleId: p.sub },
      { $set: update, $setOnInsert: { createdAt: new Date(), profile: { ...EMPTY_PROFILE } } },
      { upsert: true }
    );

    const doc = await Users.findOne({ googleId: p.sub });
    if (!doc) return res.status(500).send('User upsert failed');

    const token = signSession(doc._id.toString());
    const userPayload = { name: doc.name, email: doc.email, picture: doc.picture };

    // If the web popup was opened from your SPA, postMessage back and close
    const targetOrigin = WEB_ORIGIN || '*';
    return res
      .set('Content-Type', 'text/html')
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

/** -------- Protected: Me -------- */
app.get('/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const doc = await Users.findOne(
    { _id: new ObjectId(req.userId) },
    { projection: { name: 1, email: 1, picture: 1, profile: 1 } }
  );
  if (!doc) return res.status(404).json({ error: 'not found' });
  doc.profile = doc.profile || { ...EMPTY_PROFILE };
  res.json({ _id: doc._id, name: doc.name, email: doc.email, picture: doc.picture, profile: doc.profile });
});

app.put('/me', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const _id = new ObjectId(req.userId);
    const profile = sanitizeProfile((req.body && req.body.profile) || {});
    const result = await Users.updateOne({ _id }, { $set: { profile, updatedAt: new Date() } });
    if (!result.acknowledged) return res.status(500).json({ error: 'update failed' });

    const doc = await Users.findOne(
      { _id },
      { projection: { name: 1, email: 1, picture: 1, profile: 1 } }
    );
    res.json({
      _id: doc._id,
      name: doc.name,
      email: doc.email,
      picture: doc.picture,
      profile: doc.profile || { ...EMPTY_PROFILE },
    });
  } catch (e) {
    console.error('[PROFILE UPDATE ERROR]', e);
    res.status(500).json({ error: 'update failed' });
  }
});

/** -------- OPTIONAL: Calendar demo (works for WEB flow where tokens were saved) -------- */
app.get('/calendar/next', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await Users.findOne({ _id: new ObjectId(req.userId) });
    if (!user) return res.status(404).json({ error: 'user not found' });

    if (!user.accessToken && !user.refreshToken) {
      return res.status(200).json({ message: 'No Google tokens stored for this account (use web OAuth flow to consent).' });
    }

    // Use stored tokens to call Calendar
    const oa = new OAuth2Client({
      clientId: GOOGLE_WEB_CLIENT_ID,
      clientSecret: GOOGLE_WEB_CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    oa.setCredentials({
      access_token: user.accessToken,
      refresh_token: user.refreshToken,
    });

    const calendar = google.calendar({ version: 'v3', auth: oa });
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
    console.error('[CALENDAR ERROR]', e);
    res.status(500).json({ error: 'calendar query failed' });
  }
});

/** -------- Vercel / Local export -------- */
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on :${port}`));
}

export default app;
