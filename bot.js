/**
 * أميرتي WhatsApp Bot — bot.js
 * يعمل مع Baileys + Google Gemini API
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const AUTH_DIR = path.join(__dirname, 'auth_info');

// ── إعدادات Gemini ──────────────────────────────────────────
// يتم سحب المفتاح من متغيرات البيئة في Render أو الخادم
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''; 
let genAI = null;
let model = null;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    systemInstruction: "أنت 'أميرتي'، مساعدة ذكاء اصطناعي ذكية ومشرفة على مجموعة واتساب. ردودك يجب أن تكون مختصرة، مفيدة، وبطابع ودود ومحترم. لا تذكر أي أعذار تقنية أو أخطاء برمجية أبداً."
  });
}

// ── إخفاء الضجيج التقني ──────────────────────────────────────
const origLog = console.log.bind(console);
function isCryptoNoise(args) {
  const t = args.map(i => typeof i === 'string' ? i : String(i?.message || i || '')).join(' ');
  return ['MessageCounterError','Session error','Failed to decrypt','Closing session','prekey','Bad MAC']
    .some(k => t.includes(k));
}
console.log   = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };
console.warn  = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };
console.error = (...a) => { if (!isCryptoNoise(a)) origLog(...a); };

let phoneNumber       = (process.env.BOT_PHONE || '').replace(/\D/g, '');
let activeSock        = null;
let isStarting        = false;
let pairingInProgress = false;
let reconnectTimer    = null;
let reconnectCount    = 0;

const chatMemory      = new Map(); // لحفظ سياق المحادثة
const processedIds    = new Set();

// ── Reconnect ─────────────────────────────────────────────────
function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectCount++;
  const wait = delayMs ?? Math.min(7000 * reconnectCount, 35000);
  origLog(`[NET] إعادة الاتصال خلال ${Math.round(wait / 1000)}s...`);
  reconnectTimer = setTimeout(boot, wait);
}

// ── Boot ──────────────────────────────────────────────────────
async function boot() {
  if (isStarting) return;
  isStarting = true;
  try {
    if (activeSock) { try { activeSock.end(undefined); } catch {} activeSock = null; }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try { const r = await fetchLatestBaileysVersion(); version = r.version; } catch {}

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 120000,
      defaultQueryTimeoutMs: 120000,
      keepAliveIntervalMs: 45000,
    });

    activeSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (!sock.authState.creds.registered && (connection === 'connecting' || Boolean(qr)) && !pairingInProgress) {
        pairingInProgress = true;
        try {
          if (!phoneNumber) { origLog('[ERR] لم يتم تحديد رقم الواتساب'); return; }
          await new Promise(r => setTimeout(r, 4500));
          const code = await sock.requestPairingCode(phoneNumber);
          origLog('PAIRING CODE: ' + code);
        } catch (e) {
          origLog('[ERR] فشل طلب كود الربط: ' + e.message);
          pairingInProgress = false;
        }
      }

      if (connection === 'open') {
        isStarting = false; pairingInProgress = false; reconnectCount = 0;
        origLog('[OK] Amirati is ONLINE and ready!');
      } else if (connection === 'close') {
        isStarting = false; pairingInProgress = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        origLog(`[CLOSE] Code: ${code || 'unknown'}`);
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          return scheduleReconnect(8000);
        }
        scheduleReconnect(code === 440 ? 11000 : code === 428 ? 12000 : null);
      }
    });

    // ── Messages ──────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify' && type !== 'append') return;
        const msg = messages?.[0];
        if (!msg?.message || processedIds.has(msg.key?.id)) return;
        processedIds.add(msg.key?.id);
        if (processedIds.size > 500) { const it = processedIds.values(); it.next(); processedIds.delete(it.next().value); }

        const jid     = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') return;
        const isGroup = jid.endsWith('@g.us');

        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!body) return;

        const pushName = msg.pushName || 'مجهول';
        if (msg.key.fromMe) return;

        // التحقق مما إذا كان البوت مطلوباً في المجموعات
        const mentionsMe = body.toLowerCase().includes('أميرتي') || body.toLowerCase().includes('bot');
        if (isGroup && !mentionsMe) return;

        origLog(`[MSG] ${pushName}: ${body}`);
        const cmd = body.replace(/أميرتي\s*/i, '').trim().toLowerCase();

        // أمر مسح الذاكرة
        if (cmd === 'انسى' || cmd === 'انسى كل شي') {
          chatMemory.delete(jid);
          await sock.sendMessage(jid, { text: '🧠 تم مسح الذاكرة، نبدأ من جديد!' }, { quoted: msg });
          return;
        }

        // الرد باستخدام Gemini
        if (!model) {
           origLog("[ERR] GEMINI_API_KEY غير موجود في متغيرات البيئة!");
           return;
        }

        try {
          // تجهيز سياق المحادثة
          if (!chatMemory.has(jid)) chatMemory.set(jid, []);
          const history = chatMemory.get(jid);
          history.push({ role: 'user', parts: [{ text: `${pushName}: ${body}` }] });
          if (history.length > 10) history.shift(); // الاحتفاظ بآخر 10 رسائل فقط

          const chat = model.startChat({ history });
          const result = await chat.sendMessage(body);
          const reply = result.response.text().trim();

          // حفظ رد البوت في الذاكرة
          history.push({ role: 'model', parts: [{ text: reply }] });
          if (history.length > 10) history.shift();

          await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          origLog(`[SENT] رد على ${pushName}`);

        } catch (e) {
          origLog('[ERR] Gemini Error: ' + e.message);
          // في حال فشل Gemini (مثلاً انتهت الحصة اليومية)، نرسل رسالة صامتة أو نتجاهل
        }
      } catch (e) {
        origLog('[ERR] messages.upsert: ' + e.message);
      }
    });

  } catch (e) {
    origLog('[ERR] boot: ' + e.message);
    isStarting = false;
    scheduleReconnect(10000);
  }
}

boot();
