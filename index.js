import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import cors from "cors";
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const XI = process.env.XI_API_KEY;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ok =
      /^audio\//.test(file.mimetype) ||
      file.mimetype === 'application/octet-stream';
    if (ok) cb(null, true);
    else cb(new Error('Unsupported audio type: ' + file.mimetype));
  },
});

app.post('/clone', upload.single('audio'), async (req, res) => {
  try {
    if (!XI) return res.status(500).send('Missing XI_API_KEY');
    if (!req.file) {
      console.error('No file field received. body keys:', Object.keys(req.body));
      return res.status(400).send('No file uploaded (field name must be "audio")');
    }

    const name = req.body.name || `voice-${Date.now()}`;
    const fd = new FormData();
    fd.append('name', name);

    // ElevenLabs expects the field to be 'files'
    fd.append('files', req.file.buffer, {
      filename: req.file.originalname || 'sample.wav',
      contentType: req.file.mimetype || 'audio/wav',
    });

    const resp = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: {
        'xi-api-key': XI,
        ...fd.getHeaders(),
      },
      body: fd,
    });

    if (!resp.ok) {
      const t = await resp.text();
      console.error('ElevenLabs error:', t);
      return res.status(resp.status).send(t);
    }

    const data = await resp.json();
    if (!data.voice_id) {
      console.error('No voice_id in ElevenLabs response:', data);
      return res.status(500).send('No voice_id returned from ElevenLabs');
    }
    return res.json({ voice_id: data.voice_id, requires_verification: data.requires_verification });
  } catch (e) {
    console.error('Clone error:', e);
    res.status(500).send('Clone error');
  }
});

app.post('/speak', async (req, res) => {
  try {
    if (!XI) return res.status(500).send('Missing XI_API_KEY');
    const { voiceId, text } = req.body || {};
    if (!voiceId) return res.status(400).send('voiceId required');

    const payload = {
      text: text || 'This is a default sample of around one hundred words to demonstrate your cloned voice. You can replace this text in your app.',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      output_format: 'mp3_44100_128',
    };

    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': XI,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify(payload),
    });

    if (!tts.ok) {
      const t = await tts.text();
      return res.status(tts.status).send(t);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    tts.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send('TTS error');
  }
});

// Print something to know that server is running (only if not in Vercel serverless)
if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Voice Clone API server running on port ${PORT}`);
  });
}

// For Vercel serverless: export the app as a handler
export default app;
