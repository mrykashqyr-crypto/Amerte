/**
 * أميرتي WhatsApp Bot — bot.js
 * نسخة مخصصة: حل مشكلة الربط + دعم Gemini
 */

'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestWaWebVersion, // ← مهم جداً لحل مشكلة الربط
  Browsers,                // ← مهم جداً: تسمية متصفح رسمية
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const AUTH_DIR = path.join(__dirname, 'auth_info');

// ── تهيئة Gemini ─────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let model = null;

if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `أنت "أميرتي"، مساعدة ذكاء اصطناعي شخصية. ردودك ودية ومختصرة. لا تذكر أنك نموذج ذكاء اصطناعي، أنت "أميرتي" فقط.`
  });
  console.log('[OK] تم تهيئة Gemini بنجاح');
} else {
  console.log('[ERR] تحذير: GEMINI_API_KEY غير موجود! البوت لن يرد.');
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

const chatMemory   = new Map();
const processedIds = new Set();

// ── إعادة الاتصال ─────────────────────────────────────────────
function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectCount++;
  const wait = delayMs ?? Math.min(5000 * reconnectCount, 30000);
  origLog(`[NET] إعادة الاتصال خلال ${Math.round(wait / 1000)}s...`);
  reconnectTimer = setTimeout(boot, wait);
}

// ── رد Gemini ─────────────────────────────────────────────────
async function getGeminiReply(jid, pushName, text) {
  if (!model) return null;
  if (!chatMemory.has(jid)) chatMemory.set(jid, []);
  const history = chatMemory.get(jid);
  history.push({ role: 'user', parts: [{ text: `${pushName}: ${text}` }] });
  if (history.length > 6) history.shift();

  try {
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(text);
    const reply = result.response.text().trim();
    if (reply) {
      history.push({ role: 'model', parts: [{ text: reply }] });
      if (history.length > 6) history.shift();
      return reply;
    }
    return null;
  } catch (e) {
    origLog('[ERR] Gemini: ' + e.message);
    return null;
  }
}

// ── التشغيل ───────────────────────────────────────────────────
async function boot() {
  if (isStarting) return;
  isStarting = true;
  
  try {
    if (activeSock) { try { activeSock.end(undefined); } catch {} activeSock = null; }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    // ← التعديل الأهم: جلب أحدث نسخة من واتساب ويب
    let version = [2, 3000, 1015901307];
    try { 
      const r = await fetchLatestWaWebVersion(); 
      version = r.version; 
      origLog(`[VERSION] نسخة واتساب: ${version.join('.')}`);
    } catch (e) {
      origLog('[WARN] فشل جلب النسخة، استخدام الافتراضية');
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS("Chrome"), // ← التعديل الأهم: تسمية رسمية
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
          await new Promise(r => setTimeout(r, 4000));
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

    // ── استقبال الرسائل ───────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify' && type !== 'append') return;
        const msg = messages?.[0];
        if (!msg?.message || processedIds.has(msg.key?.id)) return;
        processedIds.add(msg.key?.id);
        if (processedIds.size > 500) { 
          const it = processedIds.values(); 
          it.next(); processedIds.delete(it.next().value); 
        }

        const jid = msg.key.remoteJid;
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

        const lowerBody = body.toLowerCase();
        const mentionsMe = lowerBody.includes('أميرتي') || 
                           lowerBody.includes('اميرتي') || 
                           lowerBody.includes('bot');
        
        if (isGroup && !mentionsMe) return;

        origLog(`[MSG] ${pushName}: ${body}`);
        
        const cmd = body.replace(/أميرتي\s*/i, '').trim().toLowerCase();

        if (cmd === 'انسى' || cmd === 'انسى كل شي') {
          chatMemory.delete(jid);
          await sock.sendMessage(jid, { text: '🧠 تم مسح الذاكرة، نبدأ من جديد!' }, { quoted: msg });
          return;
        }

        if (model) {
          const reply = await getGeminiReply(jid, pushName, body);
          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            origLog(`[SENT] رد على ${pushName}`);
          }
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
