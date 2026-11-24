/**
 * لوحة أميرتي السحابية — Index.js
 * خادم HTTP + مدير البوتات + واجهة برمجة تطبيقات تحميل الملفات
 * وظائف Node.js المدمجة فقط (http، fs، path، child_process)
 * لا توجد تبعيات خارجية باستثناء تحليل الملفات بدون استخدام multer
 */

'use strict';

const http = require('http');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'amirati2026';
const BOTS_DIR = path.join(__dirname, 'bots');
const CLIENT_DIR = path.join(__dirname, '..', 'client');

إذا لم يكن المجلد BOTS_DIR موجودًا في نظام الملفات (fs.existsSync)، فسيتم إنشاء المجلد BOTS_DIR باستخدام الدالة fs.mkdirSync مع تحديد خيار التكرار (recursive: true).

// ── الحالة ─────────────────────────────────────────────────────────────────
let botProcess = null;
let botStatus = 'stopped'; // متوقف | قيد التشغيل | متصل | إعادة الاتصال
let pairingCode = '';
let activeBot = null; // اسم ملف البوت الذي يعمل حاليًا
let currentPhone = (process.env.BOT_PHONE || '').replace(/\D/g, '');
const logs = [];

// ── تسجيل الأحداث ────────────────────────────────────────────────────────────────
دالة addLog(line, src = 'out') {
  const clean = String(line || '').trim();
  إذا لم يكن نظيفًا، فارجع؛
  const ts = Date.now();
  logs.push({ ts, src, text: clean });
  إذا كان طول السجل أكبر من 400، فسيتم إزاحة السجل.
  process.stdout.write(clean + '\n');

  const pairMatch = clean.match(/PAIRING CODE[:\s]+([A-Z0-9\-]{6,12})/i);
  إذا كان (pairMatch) pairingCode = pairMatch[1];
  إذا كان (clean.includes('[OK]') && clean.includes('ONLINE')) { botStatus = 'online'; pairingCode = ''; }
  إذا كان (clean.includes('[CLOSE]')) botStatus = 'reconnecting';
}

// ── بوت رانر ───────────────────────────────────────────────────────────
دالة getRunner(filename) {
  const ext = path.extname(filename).toLowerCase();
  return { '.js': ['node'], '.py': ['python3', '-u'], '.ts': ['ts-node'], '.sh': ['bash'] }[ext] || null;
}

دالة بدء تشغيل البوت (اسم الملف) {
  إذا (botProcess) أوقف البوت();
  const filePath = path.join(BOTS_DIR, filename);
  if (!fs.existsSync(filePath)) return addLog(`[ERR] الملف غير موجود: ${filename}`, 'err');

  const runner = getRunner(filename);
  if (!runner) return addLog(`[ERR] نوع الملف غير مدعوم: ${filename}`, 'err');

  botStatus = 'starting';
  activeBot = filename;
  addLog(`[PANEL] تشغيل البوت: ${filename}`);

  botProcess = spawn(runner[0], [...runner.slice(1), filePath], {
    cwd: BOTS_DIR,
    env: { ...process.env, BOT_PHONE: currentPhone }
  });

  botProcess.stdout.on('data', d => d.toString().split('\n').forEach(l => addLog(l, 'out')));
  botProcess.stderr.on('data', d => d.toString().split('\n').forEach(l => { if (l.trim()) addLog(l, 'err'); }));
  botProcess.on('close', code => {
    addLog(`[PANEL] البوت توقف (exit ${code})`, 'sys');
    botProcess = null;
    botStatus = 'stopped';
    activeBot = null;
  });
}

دالة stopBot() {
  إذا لم تكن عملية البوت تعمل، فقم بالإرجاع؛
  botProcess.kill('SIGTERM');
  botProcess = null;
  botStatus = 'stopped';
  addLog('[PANEL] تم إيقاف البوت.', 'sys');
}

دالة restartBot() {
  const name = activeBot || (fs.readdirSync(BOTS_DIR)[0] || null);
  stopBot();
  إذا كان (الاسم) setTimeout(() => startBot(الاسم)، 1200)؛
}

دالة resetSession() {
  stopBot();
  const authDir = path.join(BOTS_DIR, 'auth_info');
  fs.rmSync(authDir, { recursive: true, force: true });
  pairingCode = '';
  addLog('[PANEL] تم حذف جلسة auth_info الفعالة.', 'sys');
}

// ── محلل ملفات متعدد الأجزاء (بدون deps) ─────────────────────
دالة parseMultipart(req, cb) {
  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  إذا لم يكن هناك تطابق في الحدود، فسيتم إرجاع خطأ جديد ('لا يوجد حد').
  const boundary = '--' + boundaryMatch[1];

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const files = [];

    let pos = 0;
    بينما (الموضع < طول المخزن المؤقت) {
      const bStart = buf.indexOf(boundary, pos);
      إذا كانت قيمة bStart تساوي -1، فاخرج من الحلقة.
      pos = bStart + boundary.length;
      إذا كانت نتيجة عملية تقطيع المخزن المؤقت (buf.slice(pos, pos + 2).toString() === '--')، فاخرج من الحلقة.
      pos += 2; // تخطي \r\n

      const headerEnd = buf.indexOf('\r\n\r\n', pos);
      إذا كانت قيمة (headerEnd) تساوي -1، فاخرج من الحلقة.
      const headers = buf.slice(pos, headerEnd).toString();
      pos = headerEnd + 4;

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      إذا لم يكن اسم الملف مطابقًا، فقم بزيادة الموضع بمقدار واحد، ثم انتقل إلى الخطوة التالية.

      const nextBoundary = buf.indexOf('\r\n' + boundary, pos);
      إذا كانت قيمة (nextBoundary) تساوي -1، فتوقف.
      const fileData = buf.slice(pos, nextBoundary);
      files.push({ fieldname: nameMatch?.[1] || 'file', filename: path.basename(filenameMatch[1]), data: fileData });
      pos = nextBoundary + 2;
    }
    cb(null, files);
  });
  req.on('error', cb);
}

// ── خدمة الملفات الثابتة ─────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
};

دالة serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    إذا حدث خطأ، فسيتم كتابة رمز الاستجابة 404، وسيتم إرجاع رسالة "غير موجود".
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ── أدوات مساعدة JSON ──────────────────────────────────────────────────────
دالة json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

دالة قراءة نص الطلب (req, cb) {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(e); } });
}

// ── خادم HTTP ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = req.url.split('?')[0];
  const method = req.method;

  // ── فحص صحي
  إذا كانت (الطريقة === 'GET' && عنوان URL === '/health') {
    res.writeHead(200); return res.end('OK');
  }

  // ── واجهة برمجة التطبيقات: الحالة
  إذا كانت (الطريقة === 'GET' && عنوان URL === '/api/state') {
    const since = parseInt(new URLSearchParams(req.url.split('?')[1] || '').get('since') || '0', 10);
    const bots = fs.readdirSync(BOTS_DIR)
      .filter(f => !fs.statSync(path.join(BOTS_DIR, f)).isDirectory())
      .map(f => ({ name: f, size: fs.statSync(path.join(BOTS_DIR, f)).size, ext: path.extname(f) }));
    return json(res, 200, {
      الحالة: botStatus,
      pairingCode,
      phone: currentPhone,
      activeBot,
      روبوتات،
      السجلات: logs.filter(l => l.ts > since),
    });
  }

  // ── واجهة برمجة التطبيقات: تحميل ملف البوت
  إذا كانت طريقة الإرسال هي POST وكان عنوان URL هو /api/upload،
    parseMultipart(req, (err, files) => {
      if (err || !files.length) return json(res, 400, { ok: false, error: 'لا توجد ملفات صالحة' });
      const allowed = ['.py', '.js', '.ts', '.sh'];
      const saved = [];
      for (const f of files) {
        const ext = path.extname(f.filename).toLowerCase();
        إذا لم يكن مسموحًا به، فتابع
        fs.writeFileSync(path.join(BOTS_DIR, f.filename), f.data);
        saved.push(f.filename);
        addLog(`[UPLOAD] تم رفع الملف: ${f.filename}`, 'sys');
      }
      if (!saved.length) return json(res, 400, { ok: false, error: 'نوع الملف غير مدعوم' });
      json(res, 200, { ok: true, uploaded: saved });
    });
    إرجاع؛
  }

  // ── واجهة برمجة التطبيقات: حذف ملف البوت
  إذا كانت طريقة التنفيذ هي "حذف" وكان عنوان URL يبدأ بـ "/api/bots/" {
    const name = decodeURIComponent(url.replace('/api/bots/', ''));
    const fp = path.join(BOTS_DIR, name);
    if (!fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'الملف غير موجود' });
    إذا كان (activeBot === name) أوقف البوت();
    fs.unlinkSync(fp);
    addLog(`[PANEL] تم حذف الملف: ${name}`, 'sys');
    return json(res, 200, { ok: true });
  }

  // ── واجهة برمجة التطبيقات: الإجراءات (بدء/إيقاف/إعادة تشغيل/إعادة ضبط/تنفيذ/ضبط الهاتف)
  إذا كانت طريقة الإرسال هي POST وكان عنوان URL هو '/api/action' {
    readBody(req, (err, body) => {
      if (err) return json(res, 400, { ok: false, error: 'JSON غير صالح' });
      if (body.pass !== ADMIN_PASS) return json(res, 403, { ok: false, error: 'كلمة المرور غير صحيحة' });

      switch (body.action) {
        حالة 'start':
          startBot(body.bot || fs.readdirSync(BOTS_DIR).filter(f => !fs.statSync(path.join(BOTS_DIR,f)).isDirectory())[0]);
          فاصل؛
        في حالة 'إيقاف': أوقف الروبوت(); توقف؛
        في حالة 'إعادة التشغيل': أعد تشغيل البوت(); توقف؛
        في حالة 'reset': أعد ضبط الجلسة(); توقف؛
        حالة 'set_phone':
          currentPhone = String(body.phone || '').replace(/\D/g, '');
          addLog(`[PANEL] رقم الواتساب: ${currentPhone}`, 'sys');
          فاصل؛
        حالة 'exec':
          إذا كان (body.cmd) {
            addLog(`$ ${body.cmd}`, 'sys');
            exec(body.cmd, { cwd: BOTS_DIR, timeout: 15000 }, (e, out, err2) => {
              إذا كان (out) out.split('\n').forEach(l => addLog(l, 'out'));
              إذا كان (err2) err2.split('\n').forEach(l => { if (l.trim()) addLog(l, 'err'); });
              إذا كان (e && !err2) أضف سجل(`[ERR] ${e.message}`, 'err');
            });
          }
          فاصل؛
      }
      json(res, 200, { ok: true });
    });
    إرجاع؛
  }

  // ── ملفات ثابتة
  إذا كانت (الطريقة === 'GET') {
    let filePath = url === '/' ? '/index.html' : url;
    serveStatic(res, path.join(CLIENT_DIR, filePath));
    إرجاع؛
  }

  res.writeHead(404); res.end('غير موجود');
});

server.listen(PORT, () => {
  addLog(`[SERVER] أميرتي Cloud Panel تعمل على المنفذ ${PORT}`, 'sys');
});
