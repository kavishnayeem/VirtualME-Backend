// index.js  (voice clone + TTS with per-user single voice)
import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Accept-Charset'],
}));

const {
  XI_API_KEY,
  MONGODB_URI,
  MONGODB_DB = "virtualme",
  JWT_SECRET,
  DEFAULT_VOICE_ID,
} = process.env;

if (!XI_API_KEY)      throw new Error("Missing XI_API_KEY");
if (!MONGODB_URI)     throw new Error("Missing MONGODB_URI");
if (!JWT_SECRET)      throw new Error("Missing JWT_SECRET");
if (!DEFAULT_VOICE_ID) throw new Error("Missing DEFAULT_VOICE_ID");

const XI = XI_API_KEY;

const isVercel = process.env.VERCEL === "1";

// ---------- Mongo ----------
const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const Users = db.collection("users");

// ---------- Auth ----------
function authMiddleware(req, _res, next) {
  const token =
    req.headers.authorization?.replace("Bearer ", "") || req.cookies?.vm;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
  } catch {}
  next();
}
app.use(authMiddleware);

// ---------- Multer in-memory ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      /^audio\//.test(file.mimetype) ||
      file.mimetype === "application/octet-stream";
    cb(ok ? null : new Error(`Unsupported audio type: ${file.mimetype}`), ok);
  },
});

// ---------- Helpers ----------
async function deleteElevenLabsVoice(voiceId) {
  if (!voiceId) return;
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`,
      { method: "DELETE", headers: { "xi-api-key": XI } }
    );
    // 200/204 ok, 404 already gone — both fine
    if (!resp.ok && resp.status !== 404) {
      const t = await resp.text().catch(() => "");
      console.warn("[ElevenLabs delete] non-ok:", resp.status, t);
    }
  } catch (e) {
    console.warn("[ElevenLabs delete] error:", e);
  }
}

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(
      "Voice API is up.\n\n" +
        "Endpoints:\n" +
        "POST /clone (multipart: audio) [auth required]\n" +
        "POST /speak (json: { text?, voiceId? }) [auth optional]\n" +
        "GET  /me/voice [auth required]"
    );
});

app.get("/healthz", (_req, res) => res.send("ok"));

// ---------- Create/replace user voice (one per user) ----------
app.post("/clone", (req, res) => {
  upload.single("audio")(req, res, async (err) => {
    try {
      if (err) return res.status(400).send(`File upload error: ${err.message}`);
      if (!req.userId) return res.status(401).send("unauthorized");
      if (!req.file)
        return res
          .status(400)
          .send('No file uploaded (field name must be "audio")');

      // Delete existing voice for this user (if any)
      const _id = new ObjectId(req.userId);
      const user = await Users.findOne({ _id }, { projection: { voiceId: 1 } });
      if (user?.voiceId) {
        await deleteElevenLabsVoice(user.voiceId);
      }

      // Create new voice on ElevenLabs
      const name = req.body.name || `voice-${Date.now()}`;
      const fd = new FormData();
      fd.append("name", name);
      const blob = new Blob([req.file.buffer], {
        type: req.file.mimetype || "audio/wav",
      });
      fd.append("files", blob, req.file.originalname || "sample.wav");

      const resp = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": XI },
        body: fd,
      });

      if (!resp.ok) {
        const t = await resp.text();
        console.error("ElevenLabs error:", t);
        return res.status(resp.status).send(t);
      }

      const data = await resp.json();
      if (!data.voice_id) {
        console.error("No voice_id in ElevenLabs response:", data);
        return res.status(500).send("No voice_id returned from ElevenLabs");
      }

      // Save back to Mongo
      await Users.updateOne(
        { _id },
        { $set: { voiceId: data.voice_id, voiceUpdatedAt: new Date() } }
      );

      return res.json({
        voice_id: data.voice_id,
        requires_verification: data.requires_verification,
      });
    } catch (e) {
      console.error("Clone error:", e);
      res.status(500).send("Clone error");
    }
  });
});

// ---------- Read saved user voice ----------
app.get("/me/voice", async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "unauthorized" });
  const _id = new ObjectId(req.userId);
  const doc = await Users.findOne({ _id }, { projection: { voiceId: 1 } });
  res.json({ voiceId: doc?.voiceId ?? null });
});

// ---------- Speak: use body.voiceId OR user's saved voice OR default ----------
app.post("/speak", async (req, res) => {
  try {
    const { voiceId: bodyVoiceId, text } = req.body || {};
    let voiceId = (bodyVoiceId || "").trim();

    // If caller didn't pass voiceId, try the user
    if (!voiceId && req.userId) {
      const _id = new ObjectId(req.userId);
      const user = await Users.findOne({ _id }, { projection: { voiceId: 1 } });
      // If user.voiceId is null/undefined/empty, fallback to default
      voiceId = user?.voiceId ? String(user.voiceId).trim() : "";
    }

    // Final fallback to your default voice if not found or invalid
    if (!voiceId) voiceId = DEFAULT_VOICE_ID || "";

    // If still not found, just use the default (even if empty, ElevenLabs will error)
    // But do NOT throw error if user has no voiceId, just use default

    const payload = {
      text:
        text ||
        "This is a default sample to demonstrate your cloned voice in VirtualMe.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      output_format: "pcm_44100", // WAV/PCM
    };

    const tts = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        voiceId
      )}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": XI,
          "Content-Type": "application/json",
          Accept: "audio/wav",
        },
        body: JSON.stringify(payload),
      }
    );

    if (!tts.ok) {
      const t = await tts.text();
      return res.status(tts.status).send(t);
    }

    res.setHeader("Content-Type", "audio/wav");
    const buf = Buffer.from(await tts.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.status(500).send("TTS error");
  }
});

if (!isVercel) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () =>
    console.log(`Voice Clone API server running on ${PORT}`)
  );
}

export default app;
