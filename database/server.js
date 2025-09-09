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
    try { const payload = jwt.verify(token, JWT_SECRET); req.userId = payload.uid; }
    catch { /* ignore */ }
  }
  next();
}
app.use(authMiddleware);

function objId(id) { try { return new ObjectId(id); } catch { return null; } }

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (_req, res) => res.send('OK'));

// ============================================================
// A) MOBILE/WEB AUTH
// ============================================================
app.post('/auth/google/native', async (req, res) => {
  try {
    console.log(req.body);
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'missing idToken' });
    const ticket = await oauthVerify.verifyIdToken({ idToken, audience: GOOGLE_WEB_CLIENT_ID });
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


// /auth/callback  (JS)
app.get('/auth/callback', async (req, res) => {
  try {
    if (!oauthWeb) return res.status(500).send('Server not configured for web OAuth flow');

    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    // Exchange code -> tokens
    const { tokens } = await oauthWeb.getToken({ code, redirect_uri: REDIRECT_URI });
    if (!tokens.id_token) return res.status(400).send('No id_token');

    // Verify id_token
    const ticket = await oauthVerify.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const p = ticket.getPayload();

    // Upsert user
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
      {
        $set: update,
        $setOnInsert: {
          createdAt: new Date(),
          // make sure shape exists for new users
          profile: {
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
          },
          lobby: { granted: [], invites: [] },
        },
      },
      { upsert: true }
    );

    const doc = await Users.findOne({ googleId: p.sub });
    if (!doc) return res.status(500).send('User upsert failed');

    // backfill if missing
    const patch = {};
    if (!doc.profile) patch.profile = {
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
    };
    if (!doc.lobby) patch.lobby = { granted: [], invites: [] };
    if (Object.keys(patch).length) {
      await Users.updateOne({ _id: doc._id }, { $set: patch });
      Object.assign(doc, patch);
    }

    // Create app session token
    const token = signSession(doc._id.toString());
    const userPayload = { name: doc.name, email: doc.email, picture: doc.picture, _id: doc._id };

    // state may contain app_redirect
    let app_redirect;
    if (state) {
      try {
        const s = JSON.parse(Buffer.from(String(state), 'base64url').toString('utf8'));
        app_redirect = s?.app_redirect;
      } catch {}
    }

    if (app_redirect) {
      const b64 = Buffer.from(JSON.stringify({ token, user: userPayload })).toString('base64');

      // ✅ Treat both new and old Expo proxy domains as “proxy mode”
      const isExpoProxy =
        app_redirect.includes('auth.expo.dev') ||
        app_redirect.includes('auth.expo.io') ||
        app_redirect.includes('expo-auth-session');

      if (isExpoProxy) {
        // Expo proxy expects fragment, not query
        const redirectUrl = `${app_redirect}#vm=${encodeURIComponent(b64)}`;
        return res
          .set('Content-Type', 'text/html')
          .send(`<!doctype html><meta charset="utf-8" />
<title>Redirecting…</title>
<script>
  var u=${JSON.stringify(redirectUrl)};
  try { location.replace(u); } catch(e) { location.href = u; }
  setTimeout(function(){ location = u; }, 120);
</script>
<p>Redirecting back to the app…</p>`);
      }

      // Standalone/dev-client: deep link directly
      const sep = app_redirect.includes('?') ? '&' : '?';
      return res.redirect(`${app_redirect}${sep}vm=${encodeURIComponent(b64)}`);
    }

    // Web popup fallback
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
    return res.status(500).send('OAuth callback failed: ' + e.message);
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
// B) Devices API (unchanged – keep your current endpoints)
// ============================================================
// ...

// ============================================================
// C) Lobby / Grants (invite, accept, reject, revoke, list, requests, ACL)
// ============================================================
function genInviteCode() {
  return `INV-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// Summary: granted (outbound active + outbound pending) and received (active)
app.get('/lobby/summary', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });

    const meId = new ObjectId(req.userId);
    const meDoc = await Users.findOne(
      { _id: meId },
      { projection: { _id: 1, email: 1, name: 1, picture: 1, lobby: 1 } }
    );
    if (!meDoc) return res.status(404).json({ error: 'not_found' });

    const toIso = (v) => (v ? new Date(v).toISOString() : undefined);

    const activeGrants = (meDoc.lobby?.granted ?? []).map((g) => ({
      status: g.status || 'active',
      inviteCode: g.inviteCode ?? null,
      createdAt: toIso(g.createdAt),
      updatedAt: toIso(g.updatedAt || g.lastUsedAt),
      id: g.id || g.grantId,
      guest: {
        _id: String(g?.guest?._id ?? ''),
        email: g?.guest?.email || '',
        name: g?.guest?.name,
        picture: g?.guest?.picture,
      },
    })).filter(Boolean);

    const pendingAsGrants = (meDoc.lobby?.invites ?? [])
      .filter((i) => i?.status === 'pending')
      .map((inv) => ({
        status: 'pending',
        inviteCode: inv.inviteCode,
        createdAt: toIso(inv.createdAt),
        updatedAt: toIso(inv.updatedAt),
        id: undefined,
        guest: { _id: '', email: inv.email || '', name: undefined, picture: undefined },
      }));

    const granted = [...activeGrants, ...pendingAsGrants];

    // Received ACTIVE grants (other owners who granted ME access)
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
            updatedAt: toIso(g.updatedAt || g.lastUsedAt),
            id: g.id || g.grantId,
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

    return res.json({
      me: { _id: meDoc._id.toString(), email: meDoc.email, name: meDoc.name, picture: meDoc.picture },
      granted,
      received,
    });
  } catch (e) {
    console.error('[LOBBY SUMMARY ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// INCOMING invite requests (pending invites that target my email)
// --- replace your current /lobby/requests handler with this ---
app.get('/lobby/requests', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const me = await Users.findOne(
      { _id: objId(req.userId) },
      { projection: { _id: 1, email: 1 } }
    );
    if (!me) return res.status(404).json({ error: 'not_found' });

    const meEmail = (me.email || '').toLowerCase();

    // A) Gather pending requests from Users.lobby.invites
    const ownerCursor = Users.find(
      { 'lobby.invites': { $elemMatch: { email: meEmail, status: 'pending' } } },
      { projection: { _id: 1, name: 1, email: 1, picture: 1, lobby: 1 } }
    );

    const byKey = new Map(); // key: inviteCode || `${ownerId}:${meEmail}`

    for await (const owner of ownerCursor) {
      const invites = Array.isArray(owner.lobby?.invites) ? owner.lobby.invites : [];
      for (const inv of invites) {
        if ((inv?.status === 'pending') && (inv?.email?.toLowerCase() === meEmail)) {
          const key = inv.inviteCode || `${owner._id.toString()}:${meEmail}`;
          byKey.set(key, {
            inviteCode: inv.inviteCode || null,
            createdAt: inv.createdAt ? new Date(inv.createdAt).toISOString() : undefined,
            owner: {
              _id: owner._id.toString(),
              name: owner.name,
              email: owner.email,
              picture: owner.picture,
            },
          });
        }
      }
    }

    // B) Gather pending requests from Grants (guestId=me, status=pending)
    const grantPend = await Grants
    .find({ guestId: me._id, status: 'pending' }, { projection: { ownerId: 1, inviteCode: 1, createdAt: 1 } })
    .toArray();
  
  const ownerIds = [...new Set(grantPend.map(g => g.ownerId).filter(Boolean))];
  const owners = ownerIds.length
    ? await Users.find(
        { _id: { $in: ownerIds } },
        { projection: { _id: 1, name: 1, email: 1, picture: 1 } }
      ).toArray()
    : [];
  const ownerMap = new Map(owners.map(o => [o._id.toString(), o]));
  
  for (const g of grantPend) {
    const owner = ownerMap.get(g.ownerId.toString());
    if (!owner) continue;
  
    // ⬇️ synthesize a deterministic code when Grants row lacks inviteCode
    const synthetic = `GRANT-${owner._id.toString()}-${me._id.toString()}`;
    const code = g.inviteCode || synthetic;
  
    if (!byKey.has(code)) {
      byKey.set(code, {
        inviteCode: code, // <— always defined now
        createdAt: g.createdAt ? new Date(g.createdAt).toISOString() : undefined,
        owner: {
          _id: owner._id.toString(),
          name: owner.name,
          email: owner.email,
          picture: owner.picture,
        },
      });
    }
  }

    // optional: sort newest first
    const requests = Array.from(byKey.values()).sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });

    return res.json({ requests });
  } catch (e) {
    console.error('[LOBBY REQUESTS ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// Invite (owner -> guest email)
app.post('/lobby/invite', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') return res.status(400).json({ error: 'invalid_email' });

    const ownerId = new ObjectId(req.userId);
    const normEmail = email.toLowerCase().trim();
    const now = new Date();
    const inviteCode = genInviteCode();

    // Remove any existing pending invite for same email
    await Users.updateOne(
      { _id: ownerId },
      { $pull: { 'lobby.invites': { email: normEmail, status: 'pending' } } }
    );

    // Push new invite
    await Users.updateOne(
      { _id: ownerId },
      {
        $push: {
          'lobby.invites': {
            email: normEmail,
            inviteCode,
            status: 'pending',
            createdAt: now,
          },
        },
      }
    );

    // Mirror into Grants if guest exists
    const guest = await Users.findOne({ email: normEmail }, { projection: { _id: 1 } });
    if (guest) {
      const existing = await Grants.findOne({ ownerId, guestId: guest._id });
      if (existing) {
        await Grants.updateOne(
          { _id: existing._id },
          { $set: { status: 'pending', inviteCode, updatedAt: now } }
        );
      } else {
        await Grants.insertOne({
          ownerId,
          guestId: guest._id,
          status: 'pending',
          inviteCode,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return res.json({ ok: true, inviteCode });
  } catch (e) {
    console.error('[INVITE ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// --- modify your /lobby/accept handler: add the GRANTS fallback block ---
app.post('/lobby/accept', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const { inviteCode } = req.body || {};
    if (!inviteCode || typeof inviteCode !== 'string') return res.status(400).json({ error: 'invalid_code' });

    const guest = await Users.findOne(
      { _id: objId(req.userId) },
      { projection: { _id: 1, email: 1, name: 1, picture: 1 } }
    );
    if (!guest) return res.status(404).json({ error: 'guest_not_found' });
    
    // Try owner via embedded invite first (existing code)...
    let owner = await Users.findOne(
      { 'lobby.invites': { $elemMatch: { inviteCode, status: 'pending' } } },
      { projection: { _id: 1, email: 1, name: 1, picture: 1, lobby: 1 } }
    );
    

    // B) If not found, resolve via Grants (guestId=me, inviteCode pending)
    if (!owner && inviteCode.startsWith('GRANT-')) {
      const parts = inviteCode.split('-'); // ["GRANT", "<ownerId>", "<guestId>"]
      if (parts.length === 3) {
        const ownerId = objId(parts[1]);
        const guestId = objId(parts[2]);
        if (ownerId && guestId && guestId.equals(guest._id)) {
          const pend = await Grants.findOne({ ownerId, guestId, status: 'pending' });
          if (pend) {
            owner = await Users.findOne(
              { _id: ownerId },
              { projection: { _id: 1, email: 1, name: 1, picture: 1, lobby: 1 } }
            );
          }
        }
      }
    }
    
    if (!owner) return res.status(404).json({ error: 'invite_not_found' });

    // Remove invite if it exists on owner doc
    await Users.updateOne(
      { _id: owner._id },
      { $pull: { 'lobby.invites': { inviteCode } } }
    );

    // Promote to active grant
    const grantId = `grant_${owner._id}_${guest._id}_${Date.now()}`;
    const now = new Date();

    await Users.updateOne(
      { _id: owner._id },
      {
        $push: {
          'lobby.granted': {
            id: grantId,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            guest: {
              _id: guest._id.toString(),
              email: guest.email,
              name: guest.name,
              picture: guest.picture,
            },
          },
        },
      }
    );

    await Grants.updateOne(
      { ownerId: owner._id, guestId: guest._id },
      { $set: { status: 'active', inviteCode: null, updatedAt: now } },
      { upsert: true }
    );

    return res.json({ ok: true, grantId });
  } catch (e) {
    console.error('[ACCEPT ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// Reject (guest rejects an incoming invite by inviteCode)
// --- modify your /lobby/reject handler similarly ---
app.post('/lobby/reject', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const { inviteCode } = req.body || {};
    if (!inviteCode) return res.status(400).json({ error: 'invalid_code' });

    // Try owner doc first
    let owner = await Users.findOne(
      { 'lobby.invites': { $elemMatch: { inviteCode, status: 'pending' } } },
      { projection: { _id: 1 } }
    );

    if (owner) {
      await Users.updateOne(
        { _id: owner._id },
        { $pull: { 'lobby.invites': { inviteCode } } }
      );
      await Grants.updateMany(
        { ownerId: owner._id, status: 'pending', inviteCode },
        { $set: { status: 'revoked', updatedAt: new Date() } }
      );
      return res.json({ ok: true });
    }

    // Fallback via Grants
    const meId = objId(req.userId);
    const pendGrant = await Grants.findOne({ guestId: meId, inviteCode, status: 'pending' });
    if (!pendGrant) return res.status(404).json({ error: 'invite_not_found' });

    await Grants.updateOne(
      { _id: pendGrant._id },
      { $set: { status: 'revoked', updatedAt: new Date() } }
    );
    // Attempt to remove any stale embedded invite as well
    await Users.updateOne(
      { _id: pendGrant.ownerId },
      { $pull: { 'lobby.invites': { inviteCode } } }
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('[REJECT ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// Revoke (owner revokes a pending invite OR an active grant)
app.post('/lobby/revoke', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const ownerId = new ObjectId(req.userId);
    const { inviteCode, grantId } = req.body || {};

    if (inviteCode) {
      const r = await Users.updateOne(
        { _id: ownerId },
        { $pull: { 'lobby.invites': { inviteCode } } }
      );
      await Grants.updateMany(
        { ownerId, inviteCode },
        { $set: { status: 'revoked', updatedAt: new Date() } }
      );
      return res.json({ ok: true, removed: r.modifiedCount });
    }

    if (grantId) {
      const r = await Users.updateOne(
        { _id: ownerId },
        { $pull: { 'lobby.granted': { $or: [ { id: grantId }, { grantId } ] } } }
      );
      await Grants.updateMany(
        { ownerId, status: 'active' },
        { $set: { status: 'revoked', updatedAt: new Date() } }
      );
      return res.json({ ok: true, updated: r.modifiedCount });
    }

    return res.status(400).json({ error: 'missing_inviteCode_or_grantId' });
  } catch (e) {
    console.error('[REVOKE ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Revoke by guestId (lets UI pass guest._id)
app.post('/lobby/revoke-by-guest', async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ error: 'unauthorized' });
    const ownerId = objId(req.userId);
    const { guestId } = req.body || {};
    if (!guestId) return res.status(400).json({ error: 'missing_guestId' });

    const r = await Users.updateOne(
      { _id: ownerId },
      { $pull: { 'lobby.granted': { 'guest._id': String(guestId) } } }
    );
    await Grants.updateMany(
      { ownerId, guestId: objId(guestId) },
      { $set: { status: 'revoked', updatedAt: new Date() } }
    );
    return res.json({ ok: true, updated: r.modifiedCount });
  } catch (e) {
    console.error('[REVOKE BY GUEST ERROR]', e);
    return res.status(500).json({ error: 'server_error' });
  }
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

// ---------- Vercel / Local export ----------
if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API on :${port}`));
}
export default app;
