/**
 * Nico Comment System (Portable)
 * - No external npm dependencies (uses Node built-ins only)
 * - Real-time delivery via Server-Sent Events (EventSource)
 * - Admin via BasicAuth
 *
 * Files:
 *  - config/config.json : main config
 *  - config/ng_words.txt : NG words (1 per line)
 *  - data/state.json : runtime state (admin toggles persist)
 *  - data/comments.log.jsonl : optional logs
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config', 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

function nowMs() { return Date.now(); }

function loadConfig() {
  let cfg = readJson(CONFIG_PATH);
  // Allow environment variable overrides for hosted deployments
  if (process.env.PORT) cfg.listen = { host: '0.0.0.0', port: parseInt(process.env.PORT) };
  if (process.env.ADMIN_PASSWORD) cfg.admin.password = process.env.ADMIN_PASSWORD;
  if (process.env.HASH_SALT) cfg.security.hashSalt = process.env.HASH_SALT;
  if (process.env.BASE_URL) cfg.baseUrl = process.env.BASE_URL;
  // Normalize some fields
  if (!cfg.listen) cfg.listen = { host: '0.0.0.0', port: 3100 };
  if (!cfg.delayMs) cfg.delayMs = 3000;
  if (!cfg.limits) cfg.limits = { maxTextLen: 60, queueMax: 400 };
  if (!cfg.rateLimit) cfg.rateLimit = { windowMs: 1200, maxPerWindow: 2 };
  if (!cfg.moderation) cfg.moderation = {};
  if (!cfg.features) cfg.features = {};
  if (!cfg.screenQrOverlay) cfg.screenQrOverlay = {};
  if (!cfg.renderer) cfg.renderer = {};
  if (!cfg.chime) cfg.chime = {};
  if (!cfg.logging) cfg.logging = { jsonl: false, path: "./data/comments.log.jsonl" };
  if (!cfg.resendWindowMs) cfg.resendWindowMs = 600000;
  return cfg;
}

function defaultRuntimeState(cfg) {
  return {
    postingEnabled: true,
    renderingEnabled: true,
    emergency: false,
    // Copy defaults from cfg so admin tweaks persist independently
    features: {
      guestColorEnabled: cfg.features.guestColorEnabled !== false,
      allowedGuestColors: Array.isArray(cfg.features.allowedGuestColors) ? cfg.features.allowedGuestColors : [
        '#FFFFFF','#FFFF00','#00FFFF','#FF66FF','#66FF66','#FFA500','#FF6666','#BBBBBB'
      ],
      forceSingleColor: cfg.features.forceSingleColor === true
    },
    renderer: {
      lanes: cfg.renderer.lanes ?? 10,
      speedPxPerSec: cfg.renderer.speedPxPerSec ?? 240,
      fontFamily: cfg.renderer.fontFamily ?? 'sans-serif',
      fontSizePx: cfg.renderer.fontSizePx ?? 48,
      strokePx: cfg.renderer.strokePx ?? 6,
      defaultTextColor: cfg.renderer.defaultTextColor ?? '#FFFFFF',
      strokeColor: cfg.renderer.strokeColor ?? '#000000',
      laneGapPx: cfg.renderer.laneGapPx ?? 10,
      entryGapPx: cfg.renderer.entryGapPx ?? 40
    },
    chime: {
      enabled: cfg.chime.enabled === true,
      intervalMinutes: cfg.chime.intervalMinutes ?? 10,
      durationSeconds: cfg.chime.durationSeconds ?? 20,
      pauseCommentsWhileShowing: cfg.chime.pauseCommentsWhileShowing !== false,
      format: cfg.chime.format ?? 'HH:mm'
    },
    screenQrOverlay: {
      enabled: cfg.screenQrOverlay.enabled === true,
      position: cfg.screenQrOverlay.position ?? 'bottom-right',
      mode: cfg.screenQrOverlay.mode ?? 'post',
      sizePx: cfg.screenQrOverlay.sizePx ?? 120,
      marginPx: cfg.screenQrOverlay.marginPx ?? 16,
      opacity: cfg.screenQrOverlay.opacity ?? 0.95
    }
  };
}

function loadState(cfg) {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const st = readJson(STATE_PATH);
      // Merge with defaults to avoid missing keys after upgrade
      const def = defaultRuntimeState(cfg);
      return deepMerge(def, st);
    }
  } catch (e) {
    console.error('[WARN] Failed to load state.json:', e);
  }
  return defaultRuntimeState(cfg);
}

function saveState(state) {
  safeWriteFile(STATE_PATH, JSON.stringify(state, null, 2));
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) && Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k in out) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseBasicAuth(req) {
  const h = req.headers['authorization'];
  if (!h) return null;
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  const [user, pass] = buf.toString('utf8').split(':');
  return { user, pass };
}

function requireAdmin(req, res, cfg) {
  const auth = parseBasicAuth(req);
  if (!auth || auth.user !== cfg.admin.username || auth.pass !== cfg.admin.password) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', `Basic realm="${cfg.admin.realm || 'admin'}", charset="UTF-8"`);
    res.end('Unauthorized');
    return false;
  }
  return true;
}

function getClientIp(req) {
  // Cloudflare Tunnel may set CF-Connecting-IP
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf);
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function getCookie(req, name) {
  const h = req.headers['cookie'];
  if (!h) return null;
  const parts = String(h).split(';').map(s => s.trim());
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const k = p.slice(0, idx);
    const v = p.slice(idx + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function setCookie(res, name, value, options = {}) {
  const attrs = [];
  attrs.push(`${name}=${encodeURIComponent(value)}`);
  attrs.push('Path=/');
  if (options.maxAgeSec) attrs.push(`Max-Age=${options.maxAgeSec}`);
  if (options.httpOnly) attrs.push('HttpOnly');
  if (options.sameSite) attrs.push(`SameSite=${options.sameSite}`);
  // If you always serve via https in production, you can enable Secure
  if (options.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function serveFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const ct = ({
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    })[ext] || 'application/octet-stream';
    res.statusCode = 200;
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function computePublicBaseUrl(req, cfg) {
  if (cfg.baseUrl && String(cfg.baseUrl).trim()) return String(cfg.baseUrl).trim().replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']) : 'http').split(',')[0].trim();
  const host = req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}

function loadNgWords(cfg) {
  const filePath = path.isAbsolute(cfg.moderation.ngWordsFile)
    ? cfg.moderation.ngWordsFile
    : path.join(ROOT, cfg.moderation.ngWordsFile.replace(/^\.\//, ''));
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const words = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      words.push(s);
    }
    return words;
  } catch (e) {
    console.error('[WARN] Failed to read ng words file:', e.message);
    return [];
  }
}

// Moderation helpers
function normalizeText(input) {
  let s = String(input || '');
  s = s.normalize('NFKC');
  s = s.replace(/[\r\n\t]+/g, ' ');
  // remove control chars
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  // remove emojis (best-effort; Node 18+ supports Unicode properties)
  try { s = s.replace(/\p{Extended_Pictographic}/gu, ''); } catch { /* ignore */ }
  // collapse spaces
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

function makeCompact(s) {
  // remove spaces and common punctuation to reduce bypass
  return s.replace(/[\s\.\,\-\_\(\)\[\]\{\}「」『』（）【】<>＜＞"“”'’`・。、，．！!？\?：:；;／\/\\\|]+/g, '');
}

function looksLikeUrl(s) {
  return /https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(com|net|org|info|jp|io|co|dev|app)\b/i.test(s);
}

function looksLikeEmail(s) {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(s);
}

function looksLikePhone(s) {
  // simple: 10-11 digits after stripping non-digits
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 11;
}

function hasRepeats(s, cfg) {
  if (!cfg.moderation.rejectRepeats) return false;
  const m = Math.max(2, Number(cfg.moderation.maxRepeatChar || 6));
  const repeatRe = new RegExp(`(.)\\1{${m - 1},}`, 'u');
  if (repeatRe.test(s)) return true;
  const p = Math.max(3, Number(cfg.moderation.maxPunctRun || 6));
  const punctRe = new RegExp(`[!！?？wｗ]{${p},}`, 'u');
  return punctRe.test(s);
}

function validateColor(color, allowed) {
  if (!color) return null;
  const c = String(color).trim().toUpperCase();
  // accept #RRGGBB only
  if (!/^#[0-9A-F]{6}$/.test(c)) return null;
  if (!Array.isArray(allowed)) return null;
  const set = new Set(allowed.map(x => String(x).trim().toUpperCase()));
  if (!set.has(c)) return null;
  return c;
}

// Simple in-memory rate limiter: sliding window
class RateLimiter {
  constructor(windowMs, maxPerWindow) {
    this.windowMs = windowMs;
    this.maxPerWindow = maxPerWindow;
    this.map = new Map(); // key -> timestamps[]
  }
  allow(key, now) {
    const w = this.windowMs;
    const max = this.maxPerWindow;
    const arr = this.map.get(key) || [];
    const fresh = arr.filter(t => (now - t) < w);
    if (fresh.length >= max) {
      this.map.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.map.set(key, fresh);
    return true;
  }
  cleanup(now) {
    // occasional cleanup
    for (const [k, arr] of this.map.entries()) {
      const fresh = arr.filter(t => (now - t) < this.windowMs);
      if (fresh.length === 0) this.map.delete(k);
      else this.map.set(k, fresh);
    }
  }
}

// Event storage and SSE clients
const sseClients = new Map(); // eventKey -> Set<res>
const commentStore = new Map(); // eventKey -> Array<comment>
const rlByEvent = new Map(); // eventKey -> RateLimiter
let cfg = loadConfig();
let state = loadState(cfg);
let ngWords = loadNgWords(cfg);

function reloadConfigIfChanged() {
  // For simplicity: reload on demand via endpoint; not file watcher.
  try {
    cfg = loadConfig();
    ngWords = loadNgWords(cfg);
    // merge defaults into state (keep admin state but add new keys)
    state = deepMerge(defaultRuntimeState(cfg), state);
  } catch (e) {
    console.error('[WARN] Failed to reload config:', e);
  }
}

function getLimiter(eventKey) {
  const key = eventKey;
  if (!rlByEvent.has(key)) {
    rlByEvent.set(key, new RateLimiter(cfg.rateLimit.windowMs, cfg.rateLimit.maxPerWindow));
  }
  const rl = rlByEvent.get(key);
  // update parameters if config changed
  rl.windowMs = cfg.rateLimit.windowMs;
  rl.maxPerWindow = cfg.rateLimit.maxPerWindow;
  return rl;
}

function getComments(eventKey) {
  if (!commentStore.has(eventKey)) commentStore.set(eventKey, []);
  return commentStore.get(eventKey);
}

function pruneComments(eventKey) {
  const arr = getComments(eventKey);
  const cutoff = nowMs() - cfg.resendWindowMs;
  const kept = arr.filter(c => c.createdAtMs >= cutoff);
  if (kept.length !== arr.length) commentStore.set(eventKey, kept);
}

function pendingCount(eventKey) {
  const now = nowMs();
  const arr = getComments(eventKey);
  return arr.filter(c => c.displayAfterMs > now).length;
}

function broadcast(eventKey, eventName, payload) {
  const set = sseClients.get(eventKey);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of Array.from(set)) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${data}\n\n`);
    } catch (e) {
      try { res.end(); } catch {}
      set.delete(res);
    }
  }
}

function broadcastAll(eventName, payload) {
  for (const eventKey of sseClients.keys()) {
    broadcast(eventKey, eventName, payload);
  }
}

function logJsonl(obj) {
  if (!cfg.logging || !cfg.logging.jsonl) return;
  const line = JSON.stringify(obj) + '\n';
  const logPath = path.isAbsolute(cfg.logging.path)
    ? cfg.logging.path
    : path.join(ROOT, cfg.logging.path.replace(/^\.\//, ''));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFile(logPath, line, () => {});
}

function newId() {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14);
  const rnd = crypto.randomBytes(6).toString('hex');
  return `c_${ts}_${rnd}`;
}

function ok(res) { json(res, 200, { ok: true }); }

function notFound(res) { text(res, 404, 'Not Found'); }

function methodNotAllowed(res) { text(res, 405, 'Method Not Allowed'); }

// Router helpers
function matchPath(urlPath, pattern) {
  // pattern like /p/:eventKey
  const a = urlPath.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i=0;i<a.length;i++) {
    const pb = b[i];
    if (pb.startsWith(':')) params[pb.slice(1)] = a[i];
    else if (pb !== a[i]) return null;
  }
  return params;
}

function servePage(res, name) {
  const filePath = path.join(PUBLIC_DIR, name);
  if (!serveFile(res, filePath)) notFound(res);
}

// Main server
const server = http.createServer(async (req, res) => {
  // Simple security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);

  // Static files under /static/
  if (pathname.startsWith('/static/')) {
    const rel = pathname.slice('/static/'.length);
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
    if (!serveFile(res, filePath)) return notFound(res);
    return;
  }

  // Root redirect
  if (pathname === '/') {
    res.statusCode = 302;
    res.setHeader('Location', `/p/${cfg.eventKey}`);
    res.end();
    return;
  }

  // Pages
  let params;
  if ((params = matchPath(pathname, '/p/:eventKey'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    // Ensure client cookie exists
    let cid = getCookie(req, 'cid');
    if (!cid) {
      cid = crypto.randomBytes(12).toString('hex');
      setCookie(res, 'cid', cid, { maxAgeSec: 60*60*24*30, httpOnly: false, sameSite: 'Lax' });
    }
    return servePage(res, 'post.html');
  }
  if ((params = matchPath(pathname, '/s/:eventKey'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    return servePage(res, 'screen.html');
  }
  if ((params = matchPath(pathname, '/q/:eventKey'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    return servePage(res, 'qr.html');
  }
  if ((params = matchPath(pathname, '/q/:eventKey/screen'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    return servePage(res, 'qr_screen.html');
  }
  if (pathname === '/admin') {
    if (!requireAdmin(req, res, cfg)) return;
    return servePage(res, 'admin.html');
  }

  // Admin APIs
  if (pathname === '/api/v1/admin/state') {
    if (!requireAdmin(req, res, cfg)) return;
    const baseUrl = computePublicBaseUrl(req, cfg);
    return json(res, 200, {
      ok: true,
      eventKey: cfg.eventKey,
      baseUrl,
      postingEnabled: state.postingEnabled,
      renderingEnabled: state.renderingEnabled,
      emergency: state.emergency,
      delayMs: cfg.delayMs,
      limits: cfg.limits,
      rateLimit: cfg.rateLimit,
      moderation: {
        rejectUrl: !!cfg.moderation.rejectUrl,
        rejectEmail: !!cfg.moderation.rejectEmail,
        rejectPhone: !!cfg.moderation.rejectPhone,
        rejectRepeats: !!cfg.moderation.rejectRepeats
      },
      features: state.features,
      renderer: state.renderer,
      chime: state.chime,
    screenQrOverlay: state.screenQrOverlay,
    screenQrOverlay: state.screenQrOverlay,
      stats: {
        pending: pendingCount(cfg.eventKey),
        sseClients: (sseClients.get(cfg.eventKey)?.size) || 0
      },
      serverTimeMs: nowMs()
    });
  }

  if (pathname === '/api/v1/admin/apply') {
    if (!requireAdmin(req, res, cfg)) return;
    if (req.method !== 'POST') return methodNotAllowed(res);
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { ok: false, code: 'BAD_JSON' });
    }

    // Apply actions
    if (typeof body.postingEnabled === 'boolean') state.postingEnabled = body.postingEnabled;
    if (typeof body.renderingEnabled === 'boolean') state.renderingEnabled = body.renderingEnabled;

    if (body.emergencyStop === true) {
      state.emergency = true;
      state.postingEnabled = false;
      state.renderingEnabled = false;
      // clear stored comments
      commentStore.set(cfg.eventKey, []);
      broadcast(cfg.eventKey, 'control', { cmd: 'STOP' });
      broadcast(cfg.eventKey, 'control', { cmd: 'CLEAR' });
    }
    if (body.clearQueue === true) {
      commentStore.set(cfg.eventKey, []);
      broadcast(cfg.eventKey, 'control', { cmd: 'CLEAR' });
    }
    if (body.releaseEmergency === true) {
      state.emergency = false;
    }

    // Merge config sections
    if (body.features && typeof body.features === 'object') {
      state.features = deepMerge(state.features, body.features);
    }
    if (body.renderer && typeof body.renderer === 'object') {
      state.renderer = deepMerge(state.renderer, body.renderer);
    }
    if (body.chime && typeof body.chime === 'object') {
      state.chime = deepMerge(state.chime, body.chime);
    }

    // Sanitize critical values
    if (state.renderer.lanes < 1) state.renderer.lanes = 1;
    if (state.renderer.lanes > 20) state.renderer.lanes = 20;
    if (state.renderer.speedPxPerSec < 80) state.renderer.speedPxPerSec = 80;
    if (state.renderer.speedPxPerSec > 800) state.renderer.speedPxPerSec = 800;
    if (state.chime.intervalMinutes < 1) state.chime.intervalMinutes = 1;
    if (state.chime.intervalMinutes > 60) state.chime.intervalMinutes = 60;
    if (state.chime.durationSeconds < 3) state.chime.durationSeconds = 3;
    if (state.chime.durationSeconds > 120) state.chime.durationSeconds = 120;

    saveState(state);

    // Broadcast latest state/config to clients
    const baseUrl = computePublicBaseUrl(req, cfg);
    broadcastAll('state', makePublicStatePayload(baseUrl));

    return ok(res);
  }

  if (pathname === '/api/v1/admin/reload-config') {
    if (!requireAdmin(req, res, cfg)) return;
    reloadConfigIfChanged();
    const baseUrl = computePublicBaseUrl(req, cfg);
    broadcastAll('state', makePublicStatePayload(baseUrl));
    return ok(res);
  }

  // Public endpoints
  if ((params = matchPath(pathname, '/api/v1/e/:eventKey/public'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    const baseUrl = computePublicBaseUrl(req, cfg);
    return json(res, 200, {
      ok: true,
      eventKey: cfg.eventKey,
      baseUrl,
      delayMs: cfg.delayMs,
      limits: cfg.limits,
      rateLimit: cfg.rateLimit,
      features: state.features,
      renderer: state.renderer,
      chime: state.chime,
      serverTimeMs: nowMs()
    });
  }

  if ((params = matchPath(pathname, '/api/v1/e/:eventKey/comment'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    if (req.method !== 'POST') return methodNotAllowed(res);

    if (!state.postingEnabled || state.emergency) {
      logJsonl({ at: nowMs(), kind: 'reject', code: 'EVENT_PAUSED', ip: sha256Hex(getClientIp(req)), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'EVENT_PAUSED' });
    }

    // ensure cid
    let cid = getCookie(req, 'cid');
    if (!cid) {
      cid = crypto.randomBytes(12).toString('hex');
      setCookie(res, 'cid', cid, { maxAgeSec: 60*60*24*30, httpOnly: false, sameSite: 'Lax' });
    }

    let bodyStr = '';
    try {
      bodyStr = await readBody(req, 8 * 1024);
    } catch (e) {
      return json(res, 400, { ok: false, code: 'BODY_TOO_LARGE' });
    }

    let body;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      return json(res, 400, { ok: false, code: 'BAD_JSON' });
    }

    const ip = getClientIp(req);
    const clientKey = sha256Hex((cfg.security.hashSalt || '') + '|' + ip + '|' + cid);
    const limiter = getLimiter(cfg.eventKey);

    const now = nowMs();
    if (!limiter.allow(clientKey, now)) {
      logJsonl({ at: now, kind: 'reject', code: 'RATE_LIMIT', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'RATE_LIMIT' });
    }

    pruneComments(cfg.eventKey);
    if (pendingCount(cfg.eventKey) >= cfg.limits.queueMax) {
      logJsonl({ at: now, kind: 'reject', code: 'QUEUE_FULL', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'QUEUE_FULL' });
    }

    const textRaw = body.text;
    const textNorm = normalizeText(textRaw);
    if (!textNorm) {
      logJsonl({ at: now, kind: 'reject', code: 'EMPTY', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'EMPTY' });
    }
    if (textNorm.length > cfg.limits.maxTextLen) {
      logJsonl({ at: now, kind: 'reject', code: 'TOO_LONG', ip: sha256Hex(ip), eventKey: cfg.eventKey, len: textNorm.length });
      return json(res, 200, { ok: false, code: 'TOO_LONG' });
    }

    const compact = makeCompact(textNorm);
    // NG word check
    for (const w of ngWords) {
      if (!w) continue;
      if (textNorm.includes(w) || compact.includes(makeCompact(w))) {
        logJsonl({ at: now, kind: 'reject', code: 'NG_WORD', word: w, ip: sha256Hex(ip), eventKey: cfg.eventKey });
        return json(res, 200, { ok: false, code: 'REJECTED' });
      }
    }

    if (cfg.moderation.rejectUrl && looksLikeUrl(textNorm)) {
      logJsonl({ at: now, kind: 'reject', code: 'NG_URL', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'REJECTED' });
    }
    if (cfg.moderation.rejectEmail && looksLikeEmail(textNorm)) {
      logJsonl({ at: now, kind: 'reject', code: 'NG_EMAIL', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'REJECTED' });
    }
    if (cfg.moderation.rejectPhone && looksLikePhone(textNorm)) {
      logJsonl({ at: now, kind: 'reject', code: 'NG_PHONE', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'REJECTED' });
    }
    if (hasRepeats(textNorm, cfg)) {
      logJsonl({ at: now, kind: 'reject', code: 'NG_REPEATS', ip: sha256Hex(ip), eventKey: cfg.eventKey });
      return json(res, 200, { ok: false, code: 'REJECTED' });
    }

    // color
    let color = null;
    if (state.features.guestColorEnabled) {
      color = validateColor(body.color, state.features.allowedGuestColors);
    }
    const comment = {
      id: newId(),
      text: textNorm,
      color, // may be null
      createdAtMs: now,
      displayAfterMs: now + Number(cfg.delayMs || 3000)
    };
    getComments(cfg.eventKey).push(comment);
    logJsonl({ at: now, kind: 'accept', id: comment.id, text: comment.text, color: comment.color, ip: sha256Hex(ip), eventKey: cfg.eventKey });

    // Broadcast to screen/admin
    broadcast(cfg.eventKey, 'comment', comment);
    return json(res, 200, { ok: true });
  }

  if ((params = matchPath(pathname, '/api/v1/e/:eventKey/events'))) {
    if (params.eventKey !== cfg.eventKey) return notFound(res);
    if (req.method !== 'GET') return methodNotAllowed(res);

    // SSE headers
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('\n');

    // Register client
    if (!sseClients.has(cfg.eventKey)) sseClients.set(cfg.eventKey, new Set());
    sseClients.get(cfg.eventKey).add(res);

    const baseUrl = computePublicBaseUrl(req, cfg);
    // Send state first
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(makePublicStatePayload(baseUrl))}\n\n`);

    // Send recent comments for resync
    pruneComments(cfg.eventKey);
    const cutoff = nowMs() - cfg.resendWindowMs;
    const backlog = getComments(cfg.eventKey).filter(c => c.createdAtMs >= cutoff);
    for (const c of backlog) {
      res.write(`event: comment\n`);
      res.write(`data: ${JSON.stringify(c)}\n\n`);
    }

    // keepalive
    const ka = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(ka);
      const set = sseClients.get(cfg.eventKey);
      if (set) set.delete(res);
      try { res.end(); } catch {}
    });
    return;
  }

  // Fallback to static public files by name (limited)
  const allowed = new Set([
    '/favicon.ico',
  ]);
  if (allowed.has(pathname)) {
    const filePath = path.join(PUBLIC_DIR, pathname.slice(1));
    if (!serveFile(res, filePath)) return notFound(res);
    return;
  }

  return notFound(res);
});

function makePublicStatePayload(baseUrl) {
  return {
    eventKey: cfg.eventKey,
    baseUrl,
    postingEnabled: state.postingEnabled,
    renderingEnabled: state.renderingEnabled,
    emergency: state.emergency,
    delayMs: cfg.delayMs,
    limits: cfg.limits,
    rateLimit: cfg.rateLimit,
    features: state.features,
    renderer: state.renderer,
    chime: state.chime,
    screenQrOverlay: state.screenQrOverlay,
    serverTimeMs: nowMs()
  };
}

// Ensure data dir exists
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

// Boot logs
console.log('[BOOT] Nico Comment System (Portable)');
console.log('  Config:', CONFIG_PATH);
console.log('  State :', STATE_PATH);

server.listen(cfg.listen.port, cfg.listen.host, () => {
  const port = cfg.listen.port;
  console.log('\n[OK] Server running');
  console.log(`  Local post:   http://localhost:${port}/p/${cfg.eventKey}`);
  console.log(`  Local screen: http://localhost:${port}/s/${cfg.eventKey}`);
  console.log(`  Local admin:  http://localhost:${port}/admin (BasicAuth)`);
  console.log(`  Local QR:     http://localhost:${port}/q/${cfg.eventKey}`);
  console.log('\n[NOTE] Change admin password + hashSalt in config/config.json before real use.');
});
