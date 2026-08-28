// Static file server for the M Lakhamsi website, plus a small self-serve
// API for managing the LinkedIn / Twitter-X social embeds shown on social.html.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000; // Railway injects PORT

// Railway sits behind a proxy — required for req.ip to reflect the real
// visitor IP (used for country lookups), not Railway's internal address.
app.set('trust proxy', true);

// ─────────────────────────────────────────────────────────────
// Admin notification email — simple SMTP notice on new inquiries/
// certificate requests. NOT a transactional/marketing email service —
// just "someone submitted a form, go check the admin dashboard."
// Configure via env vars on Railway:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_NOTIFY_EMAIL
// If any are missing, notification emails are silently skipped — this
// must never block or fail a form submission.
// ─────────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || '';
const EMAIL_CONFIGURED = !!(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && ADMIN_NOTIFY_EMAIL);

let mailer = null;
if (EMAIL_CONFIGURED) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true for port 465, false for 587/25 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.log('Admin notification email not configured (SMTP_HOST/PORT/USER/PASS/ADMIN_NOTIFY_EMAIL) — skipping email notices, submissions still saved to the admin dashboard.');
}

function notifyAdminOfInquiry(entry) {
  if (!mailer) return; // not configured — never block/throw
  const isCertRequest = entry.sourcePage === 'cert-request-modal' || (entry.certificates && entry.certificates.length);
  const subjectTag = isCertRequest ? 'Certificate Request' : 'New Enquiry';
  const subject = `[M. Lakhamsi Website] ${subjectTag} — ${entry.company}`;

  const lines = [
    `A new ${isCertRequest ? 'certificate request' : 'enquiry'} was submitted on the website.`,
    '',
    `Name: ${entry.name}`,
    `Company: ${entry.company}`,
    `Email: ${entry.email}`,
    `Website: ${entry.website}`,
    entry.country ? `Country: ${entry.country}` : null,
    entry.product ? `Product interest: ${entry.product}` : null,
    (entry.certificates && entry.certificates.length) ? `Certificates requested: ${entry.certificates.join(', ')}` : null,
    entry.message ? `Message: ${entry.message}` : null,
    '',
    `Source page: ${entry.sourcePage || 'unknown'}`,
    `Submitted: ${entry.createdAt}`,
    '',
    'View all submissions in the admin dashboard: /admin-analytics.html'
  ].filter(Boolean).join('\n');

  mailer.sendMail({
    from: SMTP_USER,
    to: ADMIN_NOTIFY_EMAIL,
    subject: subject,
    text: lines
  }).catch(function (err) {
    // Never let a failed notification email affect the visitor's experience —
    // the submission is already safely saved regardless of email delivery.
    console.error('Admin notification email failed to send:', err.message);
  });
}

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

// Rate limiter for the public inquiry endpoint -- a legitimate visitor submits
// a handful of times at most; anything beyond this from one IP is almost
// certainly automated.
const inquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this address. Please try again later.' }
});
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
// Document library (Financial Results, Market Reports, ...)
//
// Each category maps to a folder under /documents that already exists on
// disk (the same folders used by the site's static links elsewhere), so
// uploaded files sit alongside documents that were added manually before
// this system existed.
// ─────────────────────────────────────────────────────────────
const DOCUMENTS_INDEX_FILE = path.join(DATA_DIR, 'documents-index.json');
const DOCUMENTS_SEED_FILE = path.join(__dirname, 'data-seed', 'documents-index.json');

const DOCUMENT_CATEGORIES = {
  'financial-results': { label: 'Financial Results', folder: 'documents/financial-results' },
  'market-reports-groundnut': { label: 'Market Reports — Groundnut', folder: 'documents/market-reports' },
  'market-reports-sesame': { label: 'Market Reports — Sesame', folder: 'documents/market-reports' },
  'annual-reports': { label: 'Annual Reports', folder: 'documents/annual-reports' },
  'newspaper-publications': { label: 'Newspaper Publications', folder: 'documents/newspaper-publications' },
  'shareholding-patterns': { label: 'Shareholding Patterns', folder: 'documents/shareholding-patterns' },
  'agm-egm-notices': { label: 'AGM / EGM Notices & Scrutinizer Reports', folder: 'documents/annual-reports' },
  'corp-gov-non-applicability': { label: 'Non-Applicability of Corporate Governance Report', folder: 'documents/governance/corp-gov-non-applicability' },
  'sebi-compliance-certificates': { label: 'SEBI Compliance Certificates', folder: 'documents/governance' },
};

function ensureDocumentsIndex() {
  if (!fs.existsSync(DOCUMENTS_INDEX_FILE)) {
    if (fs.existsSync(DOCUMENTS_SEED_FILE)) {
      fs.copyFileSync(DOCUMENTS_SEED_FILE, DOCUMENTS_INDEX_FILE);
    } else {
      fs.writeFileSync(DOCUMENTS_INDEX_FILE, JSON.stringify([], null, 2));
    }
  }
}
function readDocumentsIndex() {
  ensureDocumentsIndex();
  try {
    return JSON.parse(fs.readFileSync(DOCUMENTS_INDEX_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeDocumentsIndex(list) {
  fs.writeFileSync(DOCUMENTS_INDEX_FILE, JSON.stringify(list, null, 2));
}

// Multer stores new uploads under the persistent data volume (DATA_DIR), not
// the app's own code directory -- __dirname is the ephemeral codebase on
// Railway and gets replaced on every deploy, so anything written there
// would be lost on the next push. Documents added manually before this
// system existed live under __dirname/documents/... (committed to git) and
// keep working via the existing static file server; new admin uploads live
// under DATA_DIR/documents-uploads/... instead, served by a separate static
// route below, so both survive redeploys correctly.
const UPLOADS_ROOT = path.join(DATA_DIR, 'documents-uploads');

const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const category = req.body && req.body.category;
      const cfg = DOCUMENT_CATEGORIES[category];
      if (!cfg) return cb(new Error('Unknown category'));
      const dir = path.join(UPLOADS_ROOT, category);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\- ]/g, '').slice(0, 150);
      const unique = Date.now() + '-' + safe;
      cb(null, unique);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const okType = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(okType ? null : new Error('Only PDF files are accepted'), okType);
  }
});

app.get('/api/documents', (req, res) => {
  const category = req.query.category;
  let list = readDocumentsIndex();
  if (category) list = list.filter(d => d.category === category);
  list.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(list);
});

app.post('/api/admin/documents', requireAdmin, (req, res) => {
  documentUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const category = req.body.category;
    const cfg = DOCUMENT_CATEGORIES[category];
    if (!cfg) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Unknown category' });
    }
    const title = (req.body.title || '').toString().trim().slice(0, 200);
    const date = (req.body.date || '').toString().trim();
    if (!title || !date || isNaN(Date.parse(date))) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Title and a valid date are required' });
    }

    const entry = {
      id: crypto.randomUUID(),
      category,
      title,
      date,
      filePath: '/documents-uploads/' + category + '/' + encodeURIComponent(req.file.filename),
      fileName: req.file.filename,
      fileSize: req.file.size,
      source: 'uploaded',
      uploadedAt: new Date().toISOString()
    };
    const list = readDocumentsIndex();
    list.unshift(entry);
    writeDocumentsIndex(list);
    res.json({ ok: true, entry });
  });
});

app.delete('/api/admin/documents/:id', requireAdmin, (req, res) => {
  const list = readDocumentsIndex();
  const idx = list.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = list.splice(idx, 1);

  // Only genuinely unlink files this system uploaded itself (living on the
  // writable persistent volume). Migrated/legacy documents live in the git-
  // tracked codebase -- deleting them from the running container's disk
  // wouldn't stick, since the next deploy re-creates them from the commit
  // history. For those, removing the index entry (hiding it from the site)
  // is the correct and complete action; the file staying in the repo,
  // unreferenced, is harmless.
  if (removed.source === 'uploaded') {
    const filePath = path.join(UPLOADS_ROOT, removed.category, removed.fileName);
    fs.unlink(filePath, () => {}); // best-effort; don't fail the request if already gone
  }

  writeDocumentsIndex(list);
  res.json({ ok: true });
});

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

// Adds a single post URL into `data` in place. Returns { ok: true, platform }
// on success, or { ok: false, error, status } on failure. Does not read/write
// the data file itself — callers do that once, after processing however many
// URLs they have (a single add, or a whole bulk batch).
function addPostFromUrl(data, url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, status: 400, error: 'Missing url' };
  }

  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return { ok: false, status: 400, error: `Not a valid URL: ${url}` };
  }

  if (hostname === 'linkedin.com') {
    const parsed = parseLinkedInUrl(url);
    if (!parsed) return { ok: false, status: 400, error: `Couldn't find a LinkedIn post ID in: ${url}` };
    if (data.linkedin.some(p => p.id === parsed.id)) {
      return { ok: false, status: 409, error: `Already added (LinkedIn ${parsed.id})`, duplicate: true };
    }
    data.linkedin.unshift({ id: parsed.id, type: parsed.type, url, addedAt: new Date().toISOString() });
    data.linkedin = data.linkedin.slice(0, 30);
    return { ok: true, platform: 'linkedin' };
  }

  if (hostname === 'twitter.com' || hostname === 'x.com') {
    const parsed = parseTwitterUrl(url);
    if (!parsed) return { ok: false, status: 400, error: `Couldn't find a tweet ID in: ${url}` };
    if (data.twitter.some(p => p.id === parsed.id)) {
      return { ok: false, status: 409, error: `Already added (Tweet ${parsed.id})`, duplicate: true };
    }
    data.twitter.unshift({ id: parsed.id, url, addedAt: new Date().toISOString() });
    data.twitter = data.twitter.slice(0, 30);
    return { ok: true, platform: 'twitter' };
  }

  return { ok: false, status: 400, error: `Not a linkedin.com or twitter.com / x.com link: ${url}` };
}

app.post('/api/social-posts', requireAdmin, (req, res) => {
  const { url } = req.body || {};
  const data = readPosts();
  const result = addPostFromUrl(data, url);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  writePosts(data);
  res.json(data);
});

// Bulk import: accepts { urls: [...] } and adds each one in order. The first
// URL in the array is treated as the newest — each is unshifted in turn, so
// to preserve a "newest first" input order we process the array back-to-front.
// Never fails the whole batch for one bad URL: collects per-URL results and
// keeps going, so a typo three-quarters through a 46-post paste doesn't lose
// the other 45.
app.post('/api/social-posts/bulk', requireAdmin, (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Missing urls array' });
  }

  const data = readPosts();
  const results = [];
  for (let i = urls.length - 1; i >= 0; i--) {
    const url = typeof urls[i] === 'string' ? urls[i].trim() : urls[i];
    if (!url) continue;
    const result = addPostFromUrl(data, url);
    results.push({ url, ...result });
  }
  // Report back in the original (newest-first) order the URLs were submitted.
  results.reverse();

  writePosts(data);
  const added = results.filter(r => r.ok).length;
  const skipped = results.filter(r => !r.ok && r.duplicate).length;
  const failed = results.filter(r => !r.ok && !r.duplicate).length;
  res.json({ added, skipped, failed, results, data });
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

app.get('/api/admin/spam-stats', requireAdmin, (req, res) => {
  res.json({ spamBlockedCount });
});

// ─────────────────────────────────────────────────────────────
// Inquiry form
// ─────────────────────────────────────────────────────────────
// In-memory counter of blocked spam attempts, surfaced in the admin inquiries
// page as a peace-of-mind signal. Resets on server restart -- it's a rough
// indicator, not a durable log.
let spamBlockedCount = 0;

app.post('/api/inquiry', inquiryLimiter, (req, res) => {
  const b = req.body || {};

  // Honeypot: a field real visitors never see or fill (hidden off-screen in
  // the form, never focused by a human). Bots that blindly fill every field
  // trip this. Respond with the same success message as a real submission
  // so the bot has no signal it was caught, but don't store or notify.
  const honeypot = (b.website_confirm || '').toString().trim();
  if (honeypot) {
    spamBlockedCount++;
    return res.json({ ok: true });
  }

  // Timing check: a hidden field records when the form was rendered
  // client-side. Genuine visitors need at least a second or two to read the
  // form and type into it; scripted submissions typically fire in
  // milliseconds. This is a soft signal, not a hard proof, so the threshold
  // is kept low to avoid catching fast genuine submissions (e.g. browser
  // autofill).
  const loadedAt = Number(b.formLoadedAt);
  if (loadedAt && Date.now() - loadedAt < 1200) {
    spamBlockedCount++;
    return res.json({ ok: true });
  }

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
  notifyAdminOfInquiry(entry);

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
app.use('/documents-uploads', express.static(path.join(DATA_DIR, 'documents-uploads')));
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

// Fallback: anything unknown -> homepage (keeps links from 404ing during review)
app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`M Lakhamsi site running on port ${PORT}`);
});
