/**
 * أميرتي Cloud Panel — index.js (نسخة فائقة السرعة)
 * HTTP Server + Bot Manager + File Upload API
 * Node.js built-ins only
 */

'use strict';

const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'amirati2026';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const BOTS_DIR = path.resolve(__dirname, 'bots');
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────
let botProcess = null;
let botStatus = 'stopped'; // stopped | starting | online | reconnecting
let pairingCode = '';
let activeBot = null;
let currentPhone = (process.env.BOT_PHONE || '').replace(/\D/g, '');
const logs = [];

// ── Caches for high speed ───────────────────────────────────
let botsCache = { data: [], expiresAt: 0 };
const staticCache = new Map(); // filePath -> { data, mime, etag }

function invalidateBotsCache() {
  botsCache.expiresAt = 0;
}

function getBotFiles() {
  const now = Date.now();
  if (now < botsCache.expiresAt) return botsCache.data;

  const entries = fs.readdirSync(BOTS_DIR, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(BOTS_DIR, entry.name);
    const stat = fs.statSync(full);
    list.push({
      name: entry.name,
      size: stat.size,
      ext: path.extname(entry.name),
    });
  }

  botsCache = { data: list, expiresAt: now + 1500 };
  return list;
}

// ── Helpers ───────────────────────────────────────────────────
function isInsideDir(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase);
}

function addLog(line, src = 'out') {
  const clean = String(line || '').trim();
  if (!clean) return;
  const ts = Date.now();
  logs.push({ ts, src, text: clean });
  if (logs.length > 400) logs.shift();
  process.stdout.write(clean + '\n');

  const pairMatch = clean.match(/PAIRING CODE[:\s]+([A-Z0-9\-]{6,12})/i);
  if (pairMatch) pairingCode = pairMatch[1];
  if (clean.includes('[OK]') && clean.includes('ONLINE')) {
    botStatus = 'online';
    pairingCode = '';
  }
  if (clean.includes('[CLOSE]')) botStatus = 'reconnecting';
}

// ── Bot runner ────────────────────────────────────────────────
function getRunner(filename) {
  const ext = path.extname(filename).toLowerCase();
  const runners = {
    '.js': ['node'],
    '.py': ['python3', '-u'],
    '.ts': ['ts-node'],
    '.sh': ['bash'],
  };
  return runners[ext] || null;
}

function startBot(filename) {
  if (!filename) return addLog('[ERR] لم يتم تحديد ملف بوت للتشغيل', 'err');
  const safeName = path.basename(filename);
  const filePath = path.join(BOTS_DIR, safeName);

  if (!isInsideDir(BOTS_DIR, filePath) || !fs.existsSync(filePath)) {
    return addLog(`[ERR] الملف غير موجود: ${safeName}`, 'err');
  }

  const runner = getRunner(safeName);
  if (!runner) return addLog(`[ERR] نوع الملف غير مدعوم: ${safeName}`, 'err');

  if (botProcess) stopBot();

  botStatus = 'starting';
  activeBot = safeName;
  addLog(`[PANEL] تشغيل البوت: ${safeName}`, 'sys');

  botProcess = spawn(runner[0], [...runner.slice(1), filePath], {
    cwd: BOTS_DIR,
    env: { ...process.env, BOT_PHONE: currentPhone },
  });

  botProcess.stdout.on('data', (d) =>
    d.toString().split('\n').forEach((l) => addLog(l, 'out'))
  );
  botProcess.stderr.on('data', (d) =>
    d.toString().split('\n').forEach((l) => {
      if (l.trim()) addLog(l, 'err');
    })
  );
  botProcess.on('close', (code) => {
    addLog(`[PANEL] البوت توقف (exit ${code})`, 'sys');
    botProcess = null;
    botStatus = 'stopped';
    activeBot = null;
  });
}

function stopBot() {
  if (!botProcess) return;
  const proc = botProcess;
  botProcess = null;
  botStatus = 'stopped';
  activeBot = null;

  proc.kill('SIGTERM');
  setTimeout(() => {
    if (!proc.killed) {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }, 1500);

  addLog('[PANEL] تم إيقاف البوت.', 'sys');
}

function restartBot() {
  const files = getBotFiles();
  const name = activeBot || (files[0] && files[0].name) || null;
  stopBot();
  if (name) setTimeout(() => startBot(name), 300);
}

function resetSession() {
  stopBot();
  const authDir = path.join(BOTS_DIR, 'auth_info');
  if (isInsideDir(BOTS_DIR, authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
  pairingCode = '';
  addLog('[PANEL] تم حذف جلسة auth_info بنجاح.', 'sys');
}

// ── Multipart file parser (no deps) ──────────────────────────
function parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return cb(new Error('No boundary'));
  const boundary = Buffer.from('--' + boundaryMatch[1]);
  const nextBoundaryPattern = Buffer.concat([Buffer.from('\r\n'), boundary]);

  let totalBytes = 0;
  let aborted = false;
  const chunks = [];

  req.on('data', (c) => {
    if (aborted) return;
    totalBytes += c.length;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      aborted = true;
      cb(new Error('File too large'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    const files = [];

    let pos = 0;
    while (pos < buf.length) {
      const bStart = buf.indexOf(boundary, pos);
      if (bStart === -1) break;
      pos = bStart + boundary.length;
      if (buf.slice(pos, pos + 2).toString() === '--') break;
      pos += 2;

      const headerEnd = buf.indexOf('\r\n\r\n', pos);
      if (headerEnd === -1) break;
      const headers = buf.slice(pos, headerEnd).toString('utf8');
      pos = headerEnd + 4;

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (!filenameMatch) {
        pos++;
        continue;
      }

      const nextBoundary = buf.indexOf(nextBoundaryPattern, pos);
      if (nextBoundary === -1) break;

      const fileData = buf.slice(pos, nextBoundary);
      files.push({
        fieldname: nameMatch?.[1] || 'file',
        filename: path.basename(filenameMatch[1]),
        data: fileData,
      });
      pos = nextBoundary + 2;
    }
    cb(null, files);
  });

  req.on('error', (err) => {
    if (!aborted) cb(err);
  });
}

// ── Static & JSON helpers ─────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, filePath) {
  if (!isInsideDir(CLIENT_DIR, filePath)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const cached = staticCache.get(filePath);
  if (cached) {
    if (req.headers['if-none-match'] === cached.etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': cached.mime,
      'Cache-Control': 'public, max-age=60',
      'ETag': cached.etag,
    });
    return res.end(cached.data);
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const etag = `"${crypto.createHash('md5').update(data).digest('hex')}"`;

    staticCache.set(filePath, { data, mime, etag });

    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=60',
      'ETag': etag,
    });
    res.end(data);
  });
}

function json(res, code, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1024 * 1024) {
      req.destroy();
      return cb(new Error('Body too large'));
    }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      cb(null, JSON.parse(raw || '{}'));
    } catch (e) {
      cb(e);
    }
  });
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pass');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const qIdx = req.url.indexOf('?');
  const url = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : req.url.slice(qIdx + 1);
  const method = req.method;

  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('OK');
  }

  if (method === 'GET' && url === '/api/state') {
    const sinceParam = new URLSearchParams(rawQuery).get('since');
    const since = sinceParam ? (parseInt(sinceParam, 10) || 0) : 0;
    const bots = getBotFiles();
    const filteredLogs = since > 0 ? logs.filter((l) => l.ts > since) : logs;

    return json(res, 200, {
      status: botStatus,
      pairingCode,
      phone: currentPhone,
      activeBot,
      bots,
      logs: filteredLogs,
    });
  }

  if (method === 'POST' && url === '/api/upload') {
    parseMultipart(req, (err, files) => {
      if (err) {
        return json(res, 400, { ok: false, error: err.message || 'فشل تحليل الملفات' });
      }
      if (!files.length) {
        return json(res, 400, { ok: false, error: 'لا توجد ملفات صالحة' });
      }
      const allowed = ['.py', '.js', '.ts', '.sh'];
      const saved = [];
      for (const f of files) {
        const safeName = path.basename(f.filename);
        const targetPath = path.join(BOTS_DIR, safeName);
        const ext = path.extname(safeName).toLowerCase();
        if (!allowed.includes(ext) || !isInsideDir(BOTS_DIR, targetPath)) continue;
        fs.writeFileSync(targetPath, f.data);
        saved.push(safeName);
        addLog(`[UPLOAD] تم رفع الملف: ${safeName}`, 'sys');
      }
      if (saved.length) invalidateBotsCache();
      if (!saved.length) {
        return json(res, 400, { ok: false, error: 'نوع الملف غير مدعوم' });
      }
      json(res, 200, { ok: true, uploaded: saved });
    });
    return;
  }

  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = path.basename(decodeURIComponent(url.replace('/api/bots/', '')));
    const fp = path.join(BOTS_DIR, name);
    if (!isInsideDir(BOTS_DIR, fp) || !fs.existsSync(fp)) {
      return json(res, 404, { ok: false, error: 'الملف غير موجود' });
    }
    if (activeBot === name) stopBot();
    fs.unlinkSync(fp);
    invalidateBotsCache();
    addLog(`[PANEL] تم حذف الملف: ${name}`, 'sys');
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/action') {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (body.pass !== ADMIN_PASS) {
        return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });
      }

      switch (body.action) {
        case 'start': {
          const files = getBotFiles();
          startBot(body.bot || (files[0] && files[0].name));
          break;
        }
        case 'stop':
          stopBot();
          break;
        case 'restart':
          restartBot();
          break;
        case 'reset':
          resetSession();
          break;
        case 'set_phone':
          currentPhone = String(body.phone || '').replace(/\D/g, '');
          addLog(`[PANEL] رقم الواتساب: ${currentPhone}`, 'sys');
          break;
        case 'exec':
          if (body.cmd) {
            addLog(`$ ${body.cmd}`, 'sys');
            exec(body.cmd, { cwd: BOTS_DIR, timeout: 15000 }, (e, out, err2) => {
              if (out) out.split('\n').forEach((l) => addLog(l, 'out'));
              if (err2) err2.split('\n').forEach((l) => {
                if (l.trim()) addLog(l, 'err');
              });
              if (e && !err2) addLog(`[ERR] ${e.message}`, 'err');
              invalidateBotsCache();
            });
          }
          break;
        default:
          return json(res, 400, { ok: false, error: 'إجراء غير معروف' });
      }
      json(res, 200, { ok: true });
    });
    return;
  }

  if (method === 'GET') {
    const filePath = url === '/' ? path.join(CLIENT_DIR, 'index.html') : path.join(CLIENT_DIR, url);
    serveStatic(req, res, filePath);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  addLog(`[SERVER] أميرتي Cloud Panel يعمل على المنفذ ${PORT}`, 'sys');
});
