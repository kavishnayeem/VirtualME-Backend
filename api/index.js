// api/index.js
import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import 'dotenv/config';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const XI = process.env.XI_API_KEY;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const ok =
      /(audio\/(x-m4a|m4a|mp4|aac|mpeg|mp3|wav|x-wav|ogg|flac|webm|3gpp|3gpp2))/.test(file.mimetype) ||
      file.mimetype === 'application/octet-stream';
    if (ok) cb(null, true);
    else cb(new Error('Unsupported audio type: ' + file.mimetype));
  },
});

app.post(
  '/clone',
  (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (err) {
        console.error('Multer error:', err);
        return res.status(400).send(err.message);
      }
      if (!req.file) {
        console.error('No file field received. body keys:', Object.keys(req.body || {}));
        return res.status(400).send('No file uploaded (field name must be "audio")');
      }
      next();
    });
  },
  async (req, res) => {
    console.log('Received file:', req.file.originalname, req.file.mimetype, req.file.size);
    try {
      if (!XI) return res.status(500).send('Missing XI_API_KEY');

      const name = req.body?.name || `voice-${Date.now()}`;
      const fd = new FormData();
      fd.append('name', name);
      fd.append('files', req.file.buffer, {
        filename: req.file.originalname || 'sample.wav',
        contentType: req.file.mimetype || 'audio/wav',
      });

      const resp = await fetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers: { 'xi-api-key': XI, ...fd.getHeaders() },
        body: fd,
      });

      if (!resp.ok) {
        const t = await resp.text();
        return res.status(resp.status).send(t);
      }

      const data = await resp.json(); // { voice_id, requires_verification }
      return res.json({ voice_id: data.voice_id, requires_verification: data.requires_verification });
    } catch (e) {
      console.error(e);
      res.status(500).send('Clone error');
    }
  }
);

app.post('/speak', async (req, res) => {
  try {
    if (!XI) return res.status(500).send('Missing XI_API_KEY');
    const { voiceId, text } = req.body || {};
    if (!voiceId) return res.status(400).send('voiceId required');

    const payload = {
      text:
        text ||
        'This is a default sample of around one hundred words to demonstrate your cloned voice. You can replace this text in your app.',
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      output_format: 'mp3_44100_128',
    };

    const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': XI,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(payload),
    });

    if (!tts.ok) {
      const t = await tts.text();
      return res.status(tts.status).send(t);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    // stream back to client
    if (tts.body?.pipe) tts.body.pipe(res);
    else {
      const buf = Buffer.from(await tts.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    console.error(e);
    res.status(500).send('TTS error');
  }
});

// IMPORTANT: no app.listen on Vercel!
// Export the app as the default request handler
export default app;
