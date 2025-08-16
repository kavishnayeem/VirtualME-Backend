import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const XI = process.env.XI_API_KEY;
const isVercel = process.env.VERCEL === "1";

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // see note on Vercel limit below
  fileFilter: (req, file, cb) => {
    const ok = /^audio\//.test(file.mimetype) || file.mimetype === "application/octet-stream";
    cb(ok ? null : new Error(`Unsupported audio type: ${file.mimetype}`), ok);
  },
});

app.post("/clone", (req, res) => {
  upload.single("audio")(req, res, async (err) => {
    try {
      if (err) return res.status(400).send(`File upload error: ${err.message}`);
      if (!XI) return res.status(500).send("Missing XI_API_KEY");
      if (!req.file) return res.status(400).send('No file uploaded (field name must be "audio")');

      const name = req.body.name || `voice-${Date.now()}`;
      // Use native FormData/Blob
      const fd = new FormData();
      fd.append("name", name);
      const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/wav" });
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

app.post("/speak", async (req, res) => {
  try {
    if (!XI) return res.status(500).send("Missing XI_API_KEY");
    const { voiceId, text } = req.body || {};
    if (!voiceId) return res.status(400).send("voiceId required");

    const payload = {
      text: text || "This is a default sample of around one hundred words to demonstrate your cloned voice. You can replace this text in your app.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      output_format: "mp3_44100_128",
    };

    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": XI,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!tts.ok) {
      const t = await tts.text();
      return res.status(tts.status).send(t);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    // In Node 18/20, tts.body is a web ReadableStream
    const buf = Buffer.from(await tts.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.status(500).send("TTS error");
  }
});

// Only listen locally
if (!isVercel) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Voice Clone API server running on ${PORT}`));
}

// Vercel needs the default export
export default app;
