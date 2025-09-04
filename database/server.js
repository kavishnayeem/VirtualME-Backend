// server.js (database/auth)
// Deploy: https://virtual-me-auth.vercel.app
// ESM module. Node 18+. MongoDB official driver.

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
  JWT_SECRET,
  GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_SECRET,
  PUBLIC_BASE_URL,
  WEB_ORIGIN = '*',
} = process.env;

if (!MONGODB_URI) throw new Error('Missing MONGODB_URI');
if (!MONGODB_DB) throw new Error('Missing MONGODB_DB');
if (!JWT_SECRET) throw new Error('Missing JWT_SECRET');
if (!GOOGLE_WEB_CLIENT_ID) throw new Error('Missing GOOGLE_WEB_CLIENT_ID');
if (!PUBLIC_BASE_URL) throw new Error('Missing PUBLIC_BASE_URL');

const BASE = PUBLIC_BASE_URL.replace(/\/$/, '');
const REDIRECT_URI = `${BASE}/auth/callback`;

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// ---------- DB ----------
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const Users   = db.collection('users');
const Devices = db.collection('devices');
const Grants  = db.collection('grants'); // Lobby: ownerId -> guestId permissions

// ---------- OAuth ----------
const oauthVerify = new OAuth2Client({ clientId: GOOGLE_WEB_CLIENT_ID });
const oauthWeb =
  GOOGLE_WEB_CLIENT_SECRET
    ? new OAuth2Client({
        clientId: GOOGLE_WEB_CLIENT_ID,
        clientSecret: GOOGLE_WEB_CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      })
    : null;

// ---------- Helpers ----------
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
function signSession(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '30d' });
}
async function authMiddleware(req, _res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.vm;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.uid;
    } catch { /* ignore */ }
  }
  next();
}
app.use(authMiddleware);

function objId(id) {
  try { return new ObjectId(id); } catch { return null; }
}

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));

// ============================================================
// A) MOBILE/WEB AUTH (kept from your original)
// ============================================================
app.post('/auth/google/native', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
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
    const userPayload = { name: doc.name, email: doc.email, picture: doc.picture, _id: doc._id };
    return res.json({ token, user: userPayload });
  } catch (e) {
    console.error('[NATIVE GOOGLE AUTH ERROR]', e);
    return res.status(500).json({ error: 'native auth failed' });
  }
});

app.get('/auth/google/start', (req, res) => {
  if (!oauthWeb) return res.status(500).send('Server not configured for web OAuth flow');
  const scopes = [
    'openid', 'email', 'profile',
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

    const { tokens } = await oauthWeb.getToken({ code, redirect_uri: REDIRECT_URI });
    if (!tokens.id_token) return res.status(400).send('No id_token');

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
    const userPayload = { name: doc.name, email: doc.email, picture: doc.picture, _id: doc._id };

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

// ---------- Me / Profile ----------
app.get('/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const doc = await Users.findOne(
    { _id: objId(req.userId) },
    { projection: { name: 1, email: 1, picture: 1, profile: 1, voiceId: 1 } }
  );
  if (!doc) return res.status(404).json({ error: 'not found' });
  doc.profile = doc.profile || { ...EMPTY_PROFILE };
  res.json({ _id: doc._id.toString(), name: doc.name, email: doc.email, picture: doc.picture, profile: doc.profile, voiceId: doc.voiceId });
});

app.put('/me', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const _id = objId(req.userId);
    const profile = sanitizeProfile((req.body && req.body.profile) || {});
    const result = await Users.updateOne({ _id }, { $set: { profile, updatedAt: new Date() } });
    if (!result.acknowledged) return res.status(500).json({ error: 'update failed' });

    const doc = await Users.findOne({ _id }, { projection: { name: 1, email: 1, picture: 1, profile: 1, voiceId: 1 } });
    res.json({
      _id: doc._id.toString(),
      name: doc.name,
      email: doc.email,
      picture: doc.picture,
      profile: doc.profile || { ...EMPTY_PROFILE },
      voiceId: doc.voiceId,
    });
  } catch (e) {
    console.error('[PROFILE UPDATE ERROR]', e);
    res.status(500).json({ error: 'update failed' });
  }
});

// Minimal public/basic info for persona (used by voice-agent)
app.get('/users/:id/basic', async (req, res) => {
  try {
    const u = await Users.findOne(
      { _id: objId(req.params.id) },
      { projection: { name: 1, email: 1, voiceId: 1 } }
    );
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({ _id: u._id.toString(), name: u.name, email: u.email, voiceId: u.voiceId || null });
  } catch (e) {
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ============================================================
// B) Devices API (deviceId ↔ ownerId mapping + sharing)
// ============================================================
/*
Devices doc shape:
{
  id: string,            // deviceId (app-generated)
  ownerId: ObjectId,     // user who registered this device
  label?: string,
  platform?: 'ios'|'android'|'web',
  model?: string,
  sharing: boolean,      // app intent to share location
  lastSeenAt?: Date,
  createdAt: Date,
  updatedAt: Date
}
*/

app.get('/devices/:id', async (req, res) => {
  try {
    const dev = await Devices.findOne({ id: String(req.params.id) });
    if (!dev) return res.status(404).json({ error: 'not found' });
    res.json({
      id: dev.id,
      ownerId: dev.ownerId?.toString(),
      label: dev.label || null,
      platform: dev.platform || null,
      model: dev.model || null,
      sharing: !!dev.sharing,
      lastSeenAt: dev.lastSeenAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'lookup failed' });
  }
});

app.post('/devices/register', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const ownerId = objId(req.userId);
    const { id, label, platform, model } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

    const update = {
      id,
      ownerId,
      label: typeof label === 'string' ? label.slice(0, 80) : undefined,
      platform: typeof platform === 'string' ? platform : undefined,
      model: typeof model === 'string' ? model.slice(0, 120) : undefined,
      updatedAt: new Date(),
      $setOnInsert: { createdAt: new Date(), sharing: false },
    };

    await Devices.updateOne({ id }, { $set: update, $setOnInsert: update.$setOnInsert }, { upsert: true });
    const dev = await Devices.findOne({ id });
    res.json({
      id: dev.id,
      ownerId: dev.ownerId?.toString(),
      label: dev.label || null,
      platform: dev.platform || null,
      model: dev.model || null,
      sharing: !!dev.sharing,
      lastSeenAt: dev.lastSeenAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'register failed' });
  }
});

app.post('/devices/:id/sharing', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const { sharing } = req.body || {};
    const id = String(req.params.id);
    const dev = await Devices.findOne({ id });
    if (!dev) return res.status(404).json({ error: 'not found' });
    if (dev.ownerId?.toString() !== req.userId) return res.status(403).json({ error: 'forbidden' });

    await Devices.updateOne({ id }, { $set: { sharing: !!sharing, updatedAt: new Date() } });
    const updated = await Devices.findOne({ id });
    res.json({
      id: updated.id,
      ownerId: updated.ownerId?.toString(),
      label: updated.label || null,
      platform: updated.platform || null,
      model: updated.model || null,
      sharing: !!updated.sharing,
      lastSeenAt: updated.lastSeenAt || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'update failed' });
  }
});

app.post('/devices/:id/touch', async (req, res) => {
  try {
    const id = String(req.params.id);
    const { lastSeenAt } = req.body || {};
    await Devices.updateOne({ id }, { $set: { lastSeenAt: lastSeenAt ? new Date(lastSeenAt) : new Date() } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'touch failed' });
  }
});

// ============================================================
// C) Lobby / Grants (invite, accept, revoke, list, ACL check)
// ============================================================
/*
Grants doc:
{
  _id,
  ownerId: ObjectId,  // persona owner
  guestId: ObjectId,  // person who can access owner's persona
  status: 'active' | 'revoked' | 'pending',
  inviteCode?: string,  // simple 6-8 char
  createdAt: Date,
  updatedAt: Date
}
*/

function code8() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

// ---- LOBBY SUMMARY (reads embedded users.lobby.*) -------------------------
app.get('/lobby/summary', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });

    const meId = new ObjectId(req.userId);
    const meDoc = await Users.findOne(
      { _id: meId },
      { projection: { _id: 1, email: 1, name: 1, picture: 1, lobby: 1 } }
    );
    if (!meDoc) return res.status(404).json({ error: 'not_found' });

    const me = {
      _id: meDoc._id.toString(),
      email: meDoc.email,
      name: meDoc.name,
      picture: meDoc.picture,
    };

    // Normalize any Mongo export formats like {$date: {$numberLong: "..."}}
    const toIso = (v) => {
      if (!v) return undefined;
      if (typeof v === 'string' || typeof v === 'number') return new Date(v).toISOString();
      if (v.$date?.$numberLong) return new Date(Number(v.$date.$numberLong)).toISOString();
      if (v.$date) return new Date(v.$date).toISOString();
      return undefined;
    };

    // ---- Outbound: people I granted access to (from my embedded lobby.granted)
    const granted = (meDoc.lobby?.granted ?? []).map((g) => ({
      status: g.status || 'active',
      inviteCode: g.inviteCode ?? null,
      createdAt: toIso(g.createdAt),
      updatedAt: toIso(g.lastUsedAt) || toIso(g.updatedAt),
      id: g.id || g.grantId || undefined,
      guest: {
        _id: String(g?.guest?._id ?? ''),
        email: g?.guest?.email || '',
        name: g?.guest?.name || undefined,
        picture: g?.guest?.picture || undefined,
      },
    }));

    // ---- Inbound: people who granted ME access
    // Find any user whose lobby.granted contains my _id as guest._id with status active
    const myIdStr = meDoc._id.toString();
    const owners = await Users.find(
      { 'lobby.granted': { $elemMatch: { 'guest._id': myIdStr, status: 'active' } } },
      { projection: { _id: 1, email: 1, name: 1, picture: 1, lobby: 1 } }
    ).toArray();

    const received = [];
    for (const owner of owners) {
      for (const g of owner.lobby?.granted ?? []) {
        if (String(g?.guest?._id) === myIdStr && g.status === 'active') {
          received.push({
            status: 'active',
            createdAt: toIso(g.createdAt),
            updatedAt: toIso(g.lastUsedAt) || toIso(g.updatedAt),
            id: g.id || g.grantId || undefined,
            owner: {
              _id: owner._id.toString(),
              email: owner.email,
              name: owner.name,
              picture: owner.picture,
            },
          });
        }
      }
    }

    return res.json({ me, granted, received });
  } catch (e) {
    console.error('[LOBBY SUMMARY ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


app.post('/lobby/invite', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const ownerId = objId(req.userId);
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' });

  const guest = await Users.findOne({ email: email.toLowerCase() });
  if (!guest) {
    // You can also choose to create a placeholder and mark pending; for now, require account.
    return res.status(404).json({ error: 'guest not found (user must sign up first)' });
  }

  // Upsert: if existing revoked/pending, reactivate or keep pending
  const existing = await Grants.findOne({ ownerId, guestId: guest._id });
  const code = code8();
  if (existing) {
    await Grants.updateOne(
      { _id: existing._id },
      { $set: { status: 'pending', inviteCode: code, updatedAt: new Date() } }
    );
    const g = await Grants.findOne({ _id: existing._id });
    return res.json({ ok: true, grantId: g._id.toString(), status: g.status, inviteCode: g.inviteCode });
  }

  const ins = await Grants.insertOne({
    ownerId,
    guestId: guest._id,
    status: 'pending',
    inviteCode: code,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return res.json({ ok: true, grantId: ins.insertedId.toString(), status: 'pending', inviteCode: code });
});

app.post('/lobby/accept', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const guestId = objId(req.userId);
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'inviteCode required' });

  const g = await Grants.findOne({ inviteCode: String(inviteCode).toUpperCase(), guestId });
  if (!g) return res.status(404).json({ error: 'no matching invite' });

  await Grants.updateOne({ _id: g._id }, { $set: { status: 'active', inviteCode: null, updatedAt: new Date() } });
  res.json({ ok: true });
});

app.post('/lobby/revoke', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
  const ownerId = objId(req.userId);
  const { grantId } = req.body || {};
  if (!grantId) return res.status(400).json({ error: 'grantId required' });

  const g = await Grants.findOne({ _id: objId(grantId) });
  if (!g) return res.status(404).json({ error: 'not found' });
  if (g.ownerId?.toString() !== ownerId.toString()) return res.status(403).json({ error: 'forbidden' });

  await Grants.updateOne({ _id: g._id }, { $set: { status: 'revoked', updatedAt: new Date() } });
  res.json({ ok: true });
});

// Simple ACL check used by voice-agent
// GET /acl/can-act-as?target=<userId>
app.get('/acl/can-act-as', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ allowed: false, reason: 'unauthorized' });
    const me = req.userId;
    const target = String(req.query.target || '').trim();
    if (!target) return res.status(400).json({ allowed: false, reason: 'missing target' });
    if (me === target) return res.json({ allowed: true, reason: 'self' });

    const ok = await Grants.findOne({
      ownerId: objId(target),
      guestId: objId(me),
      status: 'active',
    });
    if (ok) return res.json({ allowed: true, reason: 'grant' });
    return res.status(403).json({ allowed: false, reason: 'no-grant' });
  } catch (e) {
    res.status(500).json({ allowed: false, reason: 'server' });
  }
});

// ============================================================
// D) Calendar demo (unchanged) — tokens stored for WEB flow only
// ============================================================
app.get('/calendar/next', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const user = await Users.findOne({ _id: objId(req.userId) });
    if (!user) return res.status(404).json({ error: 'user not found' });

    if (!user.accessToken && !user.refreshToken) {
      return res.status(200).json({ message: 'No Google tokens stored for this account (use web OAuth flow to consent).' });
    }

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

// ---------- Vercel / Local export ----------
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on :${port}`));
}
export default app;
