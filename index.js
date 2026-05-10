// ============================================================
//  APEX-MD Pairing Site
//  Generates SESSION_ID via QR code or pairing code.
//  Deploy on Render free tier — scans once, gives SESSION_ID
//  to paste into apex-md-bot env vars.
// ============================================================
'use strict';

require('dotenv').config();
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const QRCode   = require('qrcode');
const pino     = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { Boom }        = require('@hapi/boom');
const { encodeSession, SESSION_DIR } = require('./lib/session');

const PORT = process.env.PORT || 3000;
const log  = pino({ level: 'info' });

// ── Global pairing state ─────────────────────────────────────
let state = fresh();
function fresh() {
  return { status: 'idle', qrDataUrl: null, pairCode: null, sessionId: null, error: null, sock: null, dir: null };
}

function cleanup() {
  if (state.sock)  { try { state.sock.ws.close(); } catch(_){} state.sock = null; }
  if (state.dir)   { try { fs.rmSync(state.dir, { recursive: true, force: true }); } catch(_){} }
}

async function startPairing(mode, phoneNumber) {
  cleanup();
  state = fresh();
  state.status = 'connecting';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-pair-'));
  state.dir = dir;

  const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys:  makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger:            pino({ level: 'silent' }),
    browser:           ['APEX-MD', 'Chrome', '120.0.0'],
    mobile: mode === 'code',
  });

  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR ──────────────────────────────────────────────────
    if (qr && mode === 'qr') {
      state.status = 'qr_ready';
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'H', margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          width: 300,
        });
        log.info('[Pair] QR code generated');
      } catch (e) { log.error('[Pair] QR error:', e.message); }
    }

    // ── Pairing code ─────────────────────────────────────────
    if (connection === 'open' && mode === 'code' && phoneNumber && !state.pairCode) {
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
        state.pairCode = code;
        state.status   = 'code_ready';
        log.info(`[Pair] Pairing code: ${code}`);
      } catch (e) {
        state.error  = e.message;
        state.status = 'error';
      }
    }

    // ── Paired ───────────────────────────────────────────────
    if (connection === 'open' && state.status !== 'paired') {
      log.info('[Pair] WhatsApp connected! Encoding session...');
      state.status = 'encoding';
      await new Promise(r => setTimeout(r, 2500)); // let creds settle
      const sid = encodeSession(dir);
      if (sid) {
        state.sessionId = sid;
        state.status    = 'paired';
        log.info('[Pair] SESSION_ID ready ✅');
      } else {
        state.error  = 'Session encode failed — try again';
        state.status = 'error';
      }
      cleanup();
    }

    // ── Disconnected ─────────────────────────────────────────
    if (connection === 'close') {
      const code      = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (state.status !== 'paired') {
        state.error  = loggedOut ? 'Logged out — refresh and try again.' : `Connection closed (code ${code})`;
        state.status = 'error';
      }
    }
  });
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Main page ─────────────────────────────────────────────────
app.get('/', (_req, res) => res.send(html()));

// ── Start QR ──────────────────────────────────────────────────
app.post('/start/qr', async (_req, res) => {
  try {
    await startPairing('qr');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Start pairing code ────────────────────────────────────────
app.post('/start/code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'phone required' });
  try {
    await startPairing('code', phone);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Poll state ────────────────────────────────────────────────
app.get('/state', (_req, res) => {
  res.json({
    status:    state.status,
    qrDataUrl: state.qrDataUrl,
    pairCode:  state.pairCode,
    sessionId: state.sessionId,
    error:     state.error,
  });
});

// ── Reset ─────────────────────────────────────────────────────
app.post('/reset', (_req, res) => {
  cleanup();
  state = fresh();
  res.json({ ok: true });
});

app.listen(PORT, () => log.info(`[Server] APEX-MD Pairing Site on port ${PORT}`));

// ── HTML ──────────────────────────────────────────────────────
function html() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>APEX-MD · Pair Your Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#0a0a0a;color:#f0f0f0;min-height:100vh;
     display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#141414;border:1px solid #222;border-radius:20px;
      padding:40px 32px;max-width:500px;width:100%;text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{font-size:2.8rem;margin-bottom:8px}
h1{font-size:1.5rem;font-weight:800;color:#fff;letter-spacing:-.02em}
.sub{font-size:.85rem;color:#666;margin-top:6px;margin-bottom:28px}
.tabs{display:flex;gap:8px;margin-bottom:24px;background:#1a1a1a;
      padding:4px;border-radius:12px}
.tab{flex:1;padding:10px;border-radius:9px;cursor:pointer;font-size:.85rem;
     font-weight:600;transition:all .2s;color:#666;border:none;background:transparent}
.tab.active{background:#25d366;color:#000}
.tab:hover:not(.active){color:#aaa}
.panel{display:none}.panel.active{display:block}
input{width:100%;padding:12px 16px;background:#1e1e1e;border:1px solid #2a2a2a;
      border-radius:10px;color:#f0f0f0;font-size:.95rem;outline:none;margin-bottom:14px}
input:focus{border-color:#25d366}
input::placeholder{color:#555}
.btn{width:100%;padding:13px;background:#25d366;color:#000;border:none;
     border-radius:10px;font-size:.95rem;font-weight:700;cursor:pointer;
     transition:background .2s}
.btn:hover{background:#1ebe5d}
.btn:disabled{background:#1a1a1a;color:#444;cursor:not-allowed}
.qr-wrap{margin:20px auto 0;text-align:center}
.qr-wrap img{border-radius:12px;border:3px solid #25d366;max-width:260px;width:100%}
.qr-hint{font-size:.78rem;color:#555;margin-top:10px}
.code-box{margin-top:20px;background:#1a1a1a;border-radius:12px;
          border:2px solid #25d366;padding:20px}
.code-label{font-size:.75rem;color:#25d366;font-weight:700;
            letter-spacing:.1em;margin-bottom:8px}
.code-num{font-size:2.2rem;font-weight:900;letter-spacing:.15em;
          color:#fff;font-family:'Courier New',monospace}
.code-steps{font-size:.78rem;color:#666;margin-top:10px;line-height:1.7}
.code-steps b{color:#aaa}
.session-box{margin-top:20px;background:#0d1f0d;border:2px solid #25d366;
             border-radius:12px;padding:20px;text-align:left}
.session-label{font-size:.75rem;color:#25d366;font-weight:700;
               letter-spacing:.1em;margin-bottom:10px;text-align:center}
.session-id{font-family:'Courier New',monospace;font-size:.7rem;
            color:#90ee90;word-break:break-all;line-height:1.5;
            max-height:100px;overflow-y:auto;background:#0a170a;
            border-radius:8px;padding:10px}
.copy-btn{width:100%;margin-top:10px;padding:10px;background:#25d366;
          color:#000;border:none;border-radius:8px;font-weight:700;
          font-size:.85rem;cursor:pointer}
.copy-btn:hover{background:#1ebe5d}
.status{font-size:.8rem;margin-top:16px;padding:10px 14px;
        border-radius:8px;text-align:center}
.status.ok{background:#0d1f0d;color:#25d366;border:1px solid #1a4a1a}
.status.error{background:#1f0d0d;color:#ff6b6b;border:1px solid #4a1a1a}
.status.info{background:#1a1a1a;color:#888;border:1px solid #2a2a2a}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #333;
         border-top-color:#25d366;border-radius:50%;animation:spin .8s linear infinite;
         vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.reset-btn{width:100%;margin-top:12px;padding:10px;background:transparent;
           color:#555;border:1px solid #2a2a2a;border-radius:8px;
           font-size:.82rem;cursor:pointer;transition:all .2s}
.reset-btn:hover{border-color:#555;color:#aaa}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>APEX-MD</h1>
  <p class="sub">Pair your WhatsApp bot and get your SESSION_ID</p>

  <div class="tabs">
    <button class="tab active" id="t-qr"   onclick="sw('qr')">📷 QR Code</button>
    <button class="tab"        id="t-code" onclick="sw('code')">🔑 Pairing Code</button>
  </div>

  <!-- QR panel -->
  <div class="panel active" id="p-qr">
    <p style="font-size:.82rem;color:#555;margin-bottom:16px">
      Click generate, then scan with WhatsApp:<br>
      <b style="color:#aaa">Linked Devices → Link a Device</b>
    </p>
    <button class="btn" id="qrBtn" onclick="startQR()">Generate QR Code</button>
    <div class="qr-wrap" id="qrWrap" style="display:none">
      <img id="qrImg" src="" alt="QR Code"/>
      <div class="qr-hint">QR refreshes every 20s — scan quickly</div>
    </div>
  </div>

  <!-- Code panel -->
  <div class="panel" id="p-code">
    <input id="phoneIn" type="tel"
           placeholder="2348012345678  (no + sign)"
           maxlength="20"/>
    <button class="btn" id="codeBtn" onclick="startCode()">Get Pairing Code</button>
    <div class="code-box" id="codeBox" style="display:none">
      <div class="code-label">YOUR PAIRING CODE</div>
      <div class="code-num" id="codeNum">────────</div>
      <div class="code-steps">
        WhatsApp → ⋮ Menu → <b>Linked Devices</b><br>
        → <b>Link a Device</b> → <b>"Link with phone number instead"</b><br>
        → enter the code above
      </div>
    </div>
  </div>

  <!-- Status bar -->
  <div id="statusBar" style="display:none" class="status info"></div>

  <!-- Session ID result -->
  <div class="session-box" id="sessionBox" style="display:none">
    <div class="session-label">✅ SESSION_ID — paste into apex-md-bot .env</div>
    <div class="session-id" id="sessionVal"></div>
    <button class="copy-btn" onclick="copySession()">📋 Copy SESSION_ID</button>
  </div>

  <button class="reset-btn" id="resetBtn" style="display:none" onclick="doReset()">↺ Start over</button>
</div>

<script>
let mode = 'qr';
let pollTimer = null;

function sw(m) {
  mode = m;
  ['qr','code'].forEach(t => {
    document.getElementById('t-'+t).classList.toggle('active', t===m);
    document.getElementById('p-'+t).classList.toggle('active', t===m);
  });
}

async function startQR() {
  setStatus('info','<span class="spinner"></span>Connecting to WhatsApp...');
  document.getElementById('qrBtn').disabled = true;
  document.getElementById('qrWrap').style.display = 'none';
  await fetch('/start/qr', {method:'POST'});
  startPolling();
}

async function startCode() {
  const phone = document.getElementById('phoneIn').value.trim().replace(/\\D/g,'');
  if (!phone || phone.length < 7) { setStatus('error','Enter a valid phone number'); return; }
  setStatus('info','<span class="spinner"></span>Requesting pairing code...');
  document.getElementById('codeBtn').disabled = true;
  await fetch('/start/code', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone})});
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 1500);
}

async function poll() {
  let r;
  try { r = await fetch('/state').then(x=>x.json()); } catch(_) { return; }

  if (r.status === 'qr_ready' && r.qrDataUrl) {
    document.getElementById('qrImg').src = r.qrDataUrl;
    document.getElementById('qrWrap').style.display = 'block';
    setStatus('info','📷 Scan the QR code with WhatsApp');
  }

  if (r.status === 'code_ready' && r.pairCode) {
    document.getElementById('codeNum').textContent = r.pairCode;
    document.getElementById('codeBox').style.display = 'block';
    setStatus('info','🔑 Enter the pairing code in WhatsApp');
  }

  if (r.status === 'encoding') {
    setStatus('info','<span class="spinner"></span>Encoding session...');
  }

  if (r.status === 'paired' && r.sessionId) {
    clearInterval(pollTimer);
    setStatus('ok','✅ Paired! Copy your SESSION_ID below.');
    document.getElementById('sessionVal').textContent = r.sessionId;
    document.getElementById('sessionBox').style.display = 'block';
    document.getElementById('resetBtn').style.display  = 'block';
    document.getElementById('qrBtn').disabled  = false;
    document.getElementById('codeBtn').disabled = false;
  }

  if (r.status === 'error') {
    clearInterval(pollTimer);
    setStatus('error', '❌ ' + (r.error || 'Unknown error'));
    document.getElementById('resetBtn').style.display = 'block';
    document.getElementById('qrBtn').disabled  = false;
    document.getElementById('codeBtn').disabled = false;
  }
}

function setStatus(type, msg) {
  const el = document.getElementById('statusBar');
  el.style.display = 'block';
  el.className = 'status ' + type;
  el.innerHTML = msg;
}

async function doReset() {
  if (pollTimer) clearInterval(pollTimer);
  await fetch('/reset', {method:'POST'});
  location.reload();
}

function copySession() {
  const val = document.getElementById('sessionVal').textContent;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = '📋 Copy SESSION_ID', 2000);
  });
}
</script>
</body>
</html>`;
}
