// Static file server for the M Lakhamsi website, plus a small self-serve
// API for managing the LinkedIn / Twitter-X social embeds shown on social.html.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000; // Railway injects PORT

// ─────────────────────────────────────────────────────────────
// Social posts: persistence
// ─────────────────────────────────────────────────────────────
// DATA_DIR should point at a Railway Volume mount (e.g. /data) so the file
// survives redeploys. Falls back to a local folder for dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'social-posts.json');
const SEED_FILE = path.join(__dirname, 'data-seed', 'social-posts.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    if (fs.existsSync(SEED_FILE)) {
      fs.copyFileSync(SEED_FILE, DATA_FILE);
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ linkedin: [], twitter: [] }, null, 2));
    }
  }
}
ensureDataFile();

function readPosts() {
  ensureDataFile();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      linkedin: Array.isArray(raw.linkedin) ? raw.linkedin : [],
      twitter: Array.isArray(raw.twitter) ? raw.twitter : []
    };
  } catch (e) {
    return { linkedin: [], twitter: [] };
  }
}

function writePosts(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────
// Admin auth — single shared password, no user accounts.
// Session is a deterministic HMAC token in an HttpOnly cookie.
// ─────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'mlakhamsi-social-admin';

function sessionToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update(ADMIN_PASSWORD).digest('hex');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    }
  });
  return out;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  if (ADMIN_PASSWORD && cookies.admin_session === sessionToken()) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ─────────────────────────────────────────────────────────────
// URL parsing helpers
// ─────────────────────────────────────────────────────────────
function parseLinkedInUrl(url) {
  let m = url.match(/urn:li:(share|activity|ugcPost):(\d+)/i);
  if (m) return { type: m[1], id: m[2] };
  m = url.match(/-activity-(\d+)-/);
  if (m) return { type: 'activity', id: m[1] };
  return null;
}

function parseTwitterUrl(url) {
  const m = url.match(/status\/(\d+)/);
  if (m) return { id: m[1] };
  return null;
}

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Admin auth routes
// ─────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'Server not configured: set ADMIN_PASSWORD' });
  }
  if (password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `admin_session=${sessionToken()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  const cookies = parseCookies(req);
  const authenticated = !!ADMIN_PASSWORD && cookies.admin_session === sessionToken();
  res.json({ authenticated });
});

// ─────────────────────────────────────────────────────────────
// Social posts routes
// ─────────────────────────────────────────────────────────────
app.get('/api/social-posts', (req, res) => {
  res.json(readPosts());
});

app.post('/api/social-posts', requireAdmin, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return res.status(400).json({ error: 'That is not a valid URL' });
  }

  const data = readPosts();

  if (hostname === 'linkedin.com') {
    const parsed = parseLinkedInUrl(url);
    if (!parsed) return res.status(400).json({ error: "Couldn't find a LinkedIn post ID in that URL" });
    if (data.linkedin.some(p => p.id === parsed.id)) {
      return res.status(409).json({ error: 'That post is already added' });
    }
    data.linkedin.unshift({ id: parsed.id, type: parsed.type, url, addedAt: new Date().toISOString() });
    data.linkedin = data.linkedin.slice(0, 30);
  } else if (hostname === 'twitter.com' || hostname === 'x.com') {
    const parsed = parseTwitterUrl(url);
    if (!parsed) return res.status(400).json({ error: "Couldn't find a tweet ID in that URL" });
    if (data.twitter.some(p => p.id === parsed.id)) {
      return res.status(409).json({ error: 'That post is already added' });
    }
    data.twitter.unshift({ id: parsed.id, url, addedAt: new Date().toISOString() });
    data.twitter = data.twitter.slice(0, 30);
  } else {
    return res.status(400).json({ error: 'URL must be a linkedin.com or twitter.com / x.com link' });
  }

  writePosts(data);
  res.json(data);
});

app.delete('/api/social-posts/:platform/:id', requireAdmin, (req, res) => {
  const { platform, id } = req.params;
  if (platform !== 'linkedin' && platform !== 'twitter') {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const data = readPosts();
  data[platform] = data[platform].filter(p => p.id !== id);
  writePosts(data);
  res.json(data);
});

// ─────────────────────────────────────────────────────────────
// Static files + page routes
// ─────────────────────────────────────────────────────────────
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));

// Fallback: anything unknown -> homepage (keeps links from 404ing during review)
app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`M Lakhamsi site running on port ${PORT}`);
});
