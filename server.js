// Static file server for the M Lakhamsi website, plus a small self-serve
// API for managing the LinkedIn / Twitter-X social embeds shown on social.html.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const geoip = require('geoip-lite');

const app = express();
const PORT = process.env.PORT || 3000; // Railway injects PORT

// Railway sits behind a proxy — required for req.ip to reflect the real
// visitor IP (used for country lookups), not Railway's internal address.
app.set('trust proxy', true);

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
// Analytics: persistence
// ─────────────────────────────────────────────────────────────
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics-events.json');
const INQUIRIES_FILE = path.join(DATA_DIR, 'inquiries.json');
const MAX_EVENTS = 200000; // safety cap so the JSON file can't grow unbounded
const EVENT_RETENTION_DAYS = 400;

function ensureJsonFile(file, fallback) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}

function readJsonArray(file) {
  ensureJsonFile(file, []);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function writeJsonArray(file, arr) {
  ensureJsonFile(file, []);
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

function readEvents() { return readJsonArray(ANALYTICS_FILE); }

function appendEvent(evt) {
  const events = readEvents();
  events.push(evt);
  const cutoff = Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = events.filter(e => new Date(e.createdAt).getTime() >= cutoff);
  if (pruned.length > MAX_EVENTS) pruned = pruned.slice(pruned.length - MAX_EVENTS);
  writeJsonArray(ANALYTICS_FILE, pruned);
}

function readInquiries() { return readJsonArray(INQUIRIES_FILE); }

function appendInquiry(inq) {
  const list = readInquiries();
  list.unshift(inq);
  writeJsonArray(INQUIRIES_FILE, list.slice(0, 5000));
}

// ─────────────────────────────────────────────────────────────
// Market Reports — email subscribers
// ─────────────────────────────────────────────────────────────
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readSubscribers() { return readJsonArray(SUBSCRIBERS_FILE); }

function appendSubscriber(sub) {
  const list = readSubscribers();
  list.unshift(sub);
  writeJsonArray(SUBSCRIBERS_FILE, list.slice(0, 20000));
}

function readSettings() {
  ensureJsonFile(SETTINGS_FILE, { subscribeEnabled: true });
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { subscribeEnabled: true, ...raw };
  } catch (e) {
    return { subscribeEnabled: true };
  }
}

function writeSettings(settings) {
  ensureJsonFile(SETTINGS_FILE, { subscribeEnabled: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function classifyReferrer(referrer) {
  if (!referrer) return 'Direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host.includes('google.')) return 'Google';
    if (host.includes('bing.')) return 'Bing';
    if (host.includes('linkedin.') || host.includes('twitter.') || host.includes('x.com') || host.includes('facebook.') || host.includes('instagram.')) return 'Social';
    if (host === 'm.lakhamsi.com' || host.includes('railway.app')) return 'Direct';
    return 'Referral';
  } catch (e) {
    return 'Direct';
  }
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
// Analytics routes
// ─────────────────────────────────────────────────────────────
// Fire-and-forget by design: the client never awaits this, and this handler
// never throws back to the client — a broken analytics call must never break
// the site. Admin pages are excluded (the tracker script isn't loaded there,
// and we double-check server-side too).
app.post('/api/track', (req, res) => {
  res.json({ ok: true }); // respond immediately, do the write after
  try {
    const b = req.body || {};
    const pagePath = typeof b.pagePath === 'string' ? b.pagePath.slice(0, 255) : '';
    if (!b.sessionId || !b.eventType || pagePath.startsWith('/admin')) return;

    const ip = req.ip || '';
    const geo = geoip.lookup(ip.replace('::ffff:', ''));

    appendEvent({
      sessionId: String(b.sessionId).slice(0, 64),
      eventType: String(b.eventType).slice(0, 64),
      entityId: typeof b.entityId === 'string' ? b.entityId.slice(0, 64) : null,
      entityType: typeof b.entityType === 'string' ? b.entityType.slice(0, 32) : null,
      pagePath,
      referrerSource: classifyReferrer(b.referrer),
      deviceType: ['desktop', 'mobile', 'tablet'].includes(b.deviceType) ? b.deviceType : 'desktop',
      country: geo && geo.country ? geo.country : null,
      value: typeof b.value === 'number' ? b.value : null,
      createdAt: new Date().toISOString()
    });
  } catch (e) {
    // swallow — analytics must never affect the visitor experience
  }
});

app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const range = req.query.range === 'month' ? 30 : 7;
  const events = readEvents();
  const now = Date.now();
  const cutoff = now - range * 24 * 60 * 60 * 1000;
  const inRange = events.filter(e => new Date(e.createdAt).getTime() >= cutoff);

  const pageViews = inRange.filter(e => e.eventType === 'page_view');
  const sessionsInRange = new Set(pageViews.map(e => e.sessionId));
  const visits = sessionsInRange.size;
  const totalPageViews = pageViews.length;

  // Funnel: all visits -> visited an inner page (not the homepage) -> converted
  const innerSessions = new Set(
    pageViews.filter(e => e.pagePath !== '/' && e.pagePath !== '/index.html').map(e => e.sessionId)
  );
  const conversionEvents = inRange.filter(e => e.eventType === 'inquiry_submit' || e.eventType === 'whatsapp_click');
  const convertedSessions = new Set(conversionEvents.map(e => e.sessionId));
  const funnel = [
    { stage: 'Visits', count: visits },
    { stage: 'Viewed an inner page', count: innerSessions.size },
    { stage: 'Inquiry or WhatsApp click', count: convertedSessions.size }
  ];

  const inquiriesInRange = readInquiries().filter(i => new Date(i.createdAt).getTime() >= cutoff);
  const whatsappClicksInRange = inRange.filter(e => e.eventType === 'whatsapp_click').length;
  const conversions = inquiriesInRange.length + whatsappClicksInRange;
  const conversionRate = visits ? (conversions / visits) * 100 : 0;

  const topPagesMap = {};
  pageViews.forEach(e => { topPagesMap[e.pagePath] = (topPagesMap[e.pagePath] || 0) + 1; });
  const topPages = Object.entries(topPagesMap).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([pagePath, count]) => ({ pagePath, count }));

  const sourceMap = {};
  pageViews.forEach(e => { sourceMap[e.referrerSource] = (sourceMap[e.referrerSource] || 0) + 1; });

  const deviceMap = {};
  pageViews.forEach(e => { deviceMap[e.deviceType] = (deviceMap[e.deviceType] || 0) + 1; });

  const countryMap = {};
  pageViews.forEach(e => { if (e.country) countryMap[e.country] = (countryMap[e.country] || 0) + 1; });
  const topCountries = Object.entries(countryMap).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([country, count]) => ({ country, count }));

  // New vs returning: a session is "returning" if it has any page_view older
  // than the range window; "new" if its earliest page_view falls inside it.
  const firstSeen = {};
  events.filter(e => e.eventType === 'page_view').forEach(e => {
    const t = new Date(e.createdAt).getTime();
    if (!firstSeen[e.sessionId] || t < firstSeen[e.sessionId]) firstSeen[e.sessionId] = t;
  });
  let newCount = 0, returningCount = 0;
  sessionsInRange.forEach(sid => {
    if (firstSeen[sid] >= cutoff) newCount++; else returningCount++;
  });

  const avgTimeEvents = inRange.filter(e => e.eventType === 'page_time' && typeof e.value === 'number');
  const avgTimeOnPage = avgTimeEvents.length
    ? Math.round(avgTimeEvents.reduce((s, e) => s + e.value, 0) / avgTimeEvents.length)
    : null;

  res.json({
    range,
    metrics: {
      visits,
      pageViews: totalPageViews,
      pagesPerVisit: visits ? +(totalPageViews / visits).toFixed(2) : 0,
      conversions,
      conversionRate: +conversionRate.toFixed(1),
      avgTimeOnPageSeconds: avgTimeOnPage
    },
    funnel,
    topPages,
    trafficSources: sourceMap,
    deviceBreakdown: deviceMap,
    topCountries,
    newVsReturning: { new: newCount, returning: returningCount }
  });
});

app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  res.json(readInquiries().slice(0, 200));
});

// ─────────────────────────────────────────────────────────────
// Inquiry form
// ─────────────────────────────────────────────────────────────
app.post('/api/inquiry', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').toString().trim().slice(0, 200);
  const company = (b.company || '').toString().trim().slice(0, 200);
  const email = (b.email || '').toString().trim().slice(0, 200);
  const website = (b.website || '').toString().trim().slice(0, 200);
  if (!name || !company || !email || !website) {
    return res.status(400).json({ error: 'Please enter valid details in order for us to respond.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter valid details in order for us to respond.' });
  }

  const ip = (req.ip || '').replace('::ffff:', '');
  const geo = geoip.lookup(ip);

  const certificates = Array.isArray(b.certificates)
    ? b.certificates.map(c => c.toString().trim().slice(0, 100)).filter(Boolean).slice(0, 20)
    : [];

  const entry = {
    id: crypto.randomUUID(),
    name,
    company,
    email,
    website,
    country: (b.country || '').toString().trim().slice(0, 100),
    product: (b.product || '').toString().trim().slice(0, 100),
    certificates,
    message: (b.message || '').toString().trim().slice(0, 2000),
    mailingOptIn: !!b.mailingOptIn,
    sourcePage: (b.sourcePage || '').toString().trim().slice(0, 100),
    ipCountry: geo && geo.country ? geo.country : null,
    createdAt: new Date().toISOString()
  };
  appendInquiry(entry);

  // NOTE for developer: not yet wired to a transactional email service —
  // submissions are persisted to the Volume and visible in the admin
  // dashboard. Add SMTP/SendGrid delivery to the trade team inbox once the
  // confirmed address is available (see Phase 10 of the implementation brief).
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Market Reports — subscribe
// ─────────────────────────────────────────────────────────────
app.get('/api/subscribe/status', (req, res) => {
  res.json({ enabled: readSettings().subscribeEnabled });
});

app.post('/api/subscribe', (req, res) => {
  const settings = readSettings();
  if (!settings.subscribeEnabled) {
    return res.status(403).json({ error: 'Subscriptions are temporarily closed. Please check back soon.' });
  }
  const email = ((req.body || {}).email || '').toString().trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const list = readSubscribers();
  const existing = list.find(s => s.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.json({ ok: true, alreadySubscribed: true });
  }
  const ip = (req.ip || '').replace('::ffff:', '');
  const geo = geoip.lookup(ip);
  appendSubscriber({
    id: crypto.randomUUID(),
    email,
    ipCountry: geo && geo.country ? geo.country : null,
    sourcePage: ((req.body || {}).sourcePage || '').toString().trim().slice(0, 100),
    createdAt: new Date().toISOString()
  });
  res.json({ ok: true, alreadySubscribed: false });
});

app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  res.json(readSubscribers().slice(0, 5000));
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(readSettings());
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const current = readSettings();
  const next = { ...current };
  if (typeof (req.body || {}).subscribeEnabled === 'boolean') {
    next.subscribeEnabled = req.body.subscribeEnabled;
  }
  writeSettings(next);
  res.json(next);
});

// ─────────────────────────────────────────────────────────────
// Static files + page routes
// ─────────────────────────────────────────────────────────────
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

// Fallback: anything unknown -> homepage (keeps links from 404ing during review)
app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`M Lakhamsi site running on port ${PORT}`);
});
