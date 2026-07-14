const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

// ---------- DATA STORE ----------
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_EMAIL = 'nextechince@gmail.com';
const ADMIN_PASS = 'Dominion@14';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE));
  } catch {}
  return { users: {}, admins: [ADMIN_EMAIL], licenses: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// Seed admin if missing
if (!data.users[ADMIN_EMAIL]) {
  data.users[ADMIN_EMAIL] = {
    password: ADMIN_PASS,
    uid: 'admin-lex-001',
    banned: false,
    plan: 'permanent'
  };
  if (!data.admins.includes(ADMIN_EMAIL)) data.admins.push(ADMIN_EMAIL);
  saveData(data);
  console.log(`✅ Admin seeded: ${ADMIN_EMAIL}`);
}

function generateUid() {
  return 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
}

// ---------- AUTH ----------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = data.users[email];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'BANNED', uid: user.uid });
  res.cookie('uid', user.uid, { httpOnly: true, maxAge: 3600000 });
  res.json({ success: true, uid: user.uid, isAdmin: data.admins.includes(email) });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (data.users[email]) return res.status(409).json({ error: 'Email already registered' });
  const uid = generateUid();
  data.users[email] = { password, uid, banned: false, plan: 'none' };
  saveData(data);
  res.cookie('uid', uid, { httpOnly: true, maxAge: 3600000 });
  res.json({ success: true, uid, isAdmin: data.admins.includes(email) });
});

app.post('/api/auth/status', (req, res) => {
  const { uid } = req.body;
  let found = null;
  for (const [email, user] of Object.entries(data.users)) {
    if (user.uid === uid) found = { email, ...user, isAdmin: data.admins.includes(email) };
  }
  if (!found) return res.status(404).json({ error: 'User not found' });
  res.json(found);
});

app.post('/api/user/status', (req, res) => {
  const { uid } = req.body;
  let user = null;
  for (const [email, u] of Object.entries(data.users)) if (u.uid === uid) user = { email, ...u };
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ active: user.plan !== 'none', plan: user.plan });
});

app.post('/api/user/activate-key', (req, res) => {
  const { uid, licenseKey } = req.body;
  const license = data.licenses[licenseKey];
  if (!license) return res.status(404).json({ error: 'Invalid license key' });
  if (license.used) return res.status(409).json({ error: 'License already used' });
  let userEntry = null;
  for (const [email, u] of Object.entries(data.users)) if (u.uid === uid) userEntry = { email, ...u };
  if (!userEntry) return res.status(404).json({ error: 'User not found' });
  data.users[userEntry.email].plan = license.plan;
  license.used = true;
  saveData(data);
  res.json({ success: true, plan: license.plan });
});

app.post('/api/user/metrics', (req, res) => res.json({ total: 0, list: [] }));

// ---------- ADMIN ----------
app.post('/api/admin/verify', (req, res) => {
  const { email } = req.body;
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.banned) return res.json({ status: 'BANNED' });
  if (data.admins.includes(email)) return res.json({ status: 'ADMIN' });
  res.json({ status: 'USER' });
});

app.post('/api/admin/get-users', (req, res) => {
  const { email } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  const users = Object.entries(data.users).map(([email, u]) => ({ email, uid: u.uid, banned: u.banned || false, plan: u.plan || 'none' }));
  res.json({ users });
});

app.post('/api/admin/ban-user', (req, res) => {
  const { email, targetUid, action } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  let targetEmail = null;
  for (const [e, u] of Object.entries(data.users)) if (u.uid === targetUid) targetEmail = e;
  if (!targetEmail) return res.status(404).json({ error: 'User not found' });
  data.users[targetEmail].banned = (action === 'ban');
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/add-admin', (req, res) => {
  const { email, newAdminEmail } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  if (!data.users[newAdminEmail]) return res.status(404).json({ error: 'User not found' });
  if (data.admins.includes(newAdminEmail)) return res.status(409).json({ error: 'Already admin' });
  data.admins.push(newAdminEmail);
  saveData(data);
  res.json({ success: true });
});

app.post('/api/admin/generate-key', (req, res) => {
  const { email, planType } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  const token = 'LEX-' + Math.random().toString(36).substr(2, 8).toUpperCase();
  data.licenses[token] = { plan: planType, used: false };
  saveData(data);
  res.json({ success: true, key: token });
});

// ---------- PAIRING ENGINE (FIXED) ----------
const codeStore = {};        // uid -> code string
const pairingState = {};     // uid -> { status: 'pending'|'ready'|'error', phone: string }

// Clean up socket on error or after code is retrieved
function cleanup(uid) {
  if (pairingState[uid]?.socket) {
    pairingState[uid].socket.end();
    delete pairingState[uid].socket;
  }
  // Keep code in codeStore for later retrieval
}

async function startPairing(uid, phoneNumber) {
  // If we already have a code, return it
  if (codeStore[uid] && codeStore[uid] !== 'ERROR') {
    return codeStore[uid];
  }

  // If pairing already in progress, wait or reuse
  if (pairingState[uid] && pairingState[uid].status === 'pending') {
    return null; // still pending
  }

  // Set state to pending
  pairingState[uid] = { status: 'pending', phone: phoneNumber };

  try {
    // Create credentials folder per user
    const credsDir = path.join(__dirname, 'creds', uid);
    if (!fs.existsSync(credsDir)) fs.mkdirSync(credsDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(credsDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      // Increase timeout for slow networks
      connectTimeoutMs: 60000,
    });

    pairingState[uid].socket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Listen for connection open
    sock.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        console.log(`[${uid}] Connection opened.`);
      }
      if (update.connection === 'close') {
        console.log(`[${uid}] Connection closed.`);
        cleanup(uid);
        pairingState[uid].status = 'error';
        codeStore[uid] = 'ERROR';
      }
    });

    // Request pairing code – number must be in international format without '+'
    const cleanNumber = phoneNumber.replace(/\D/g, '');
    // Baileys expects the number as string (with country code)
    console.log(`[${uid}] Requesting pairing code for ${cleanNumber}...`);
    const code = await sock.requestPairingCode(cleanNumber);
    console.log(`[${uid}] Pairing code received: ${code}`);
    codeStore[uid] = code;
    pairingState[uid].status = 'ready';
    // Close the socket after code is obtained to free resources
    setTimeout(() => cleanup(uid), 5000);
    return code;
  } catch (err) {
    console.error(`[${uid}] Pairing error:`, err.message);
    codeStore[uid] = 'ERROR';
    pairingState[uid].status = 'error';
    cleanup(uid);
    return null;
  }
}

// Endpoint to initiate pairing
app.post('/api/pair', async (req, res) => {
  const { number, isPremium, targets, uid } = req.body;
  if (!number || !uid) {
    return res.status(400).json({ error: 'Missing number or uid' });
  }

  const cleanNumber = number.replace(/\D/g, '');
  if (cleanNumber.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number (must have at least 10 digits)' });
  }

  // Set cookie so /api/code can identify the user
  res.cookie('uid', uid, { httpOnly: true, maxAge: 600000 });

  // Check if we already have a code
  if (codeStore[uid] && codeStore[uid] !== 'ERROR') {
    return res.json({ code: codeStore[uid] });
  }

  // Start pairing in the background
  startPairing(uid, cleanNumber).catch(err => {
    console.error(`Background pairing error for ${uid}:`, err);
    codeStore[uid] = 'ERROR';
  });

  // Respond immediately, client will poll
  res.json({ message: 'Pairing initiated, please poll /api/code' });
});

// Endpoint to poll for code
app.get('/api/code', (req, res) => {
  const uid = req.cookies.uid;
  if (!uid) {
    return res.status(400).json({ error: 'No UID cookie. Please initiate pairing first.' });
  }

  const code = codeStore[uid];
  if (code === 'ERROR') {
    return res.status(500).json({ error: 'Pairing failed. Check server logs.' });
  }

  if (code) {
    return res.json({ code });
  } else {
    // Still pending
    const state = pairingState[uid];
    if (state && state.status === 'pending') {
      return res.json({ code: null, message: 'Pairing in progress...' });
    } else {
      // If no state, maybe not started
      return res.json({ code: null, message: 'Waiting to start pairing...' });
    }
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Data file: ${DATA_FILE}`);
  console.log(`🔑 Admin: ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
  console.log(`📱 Make sure you have a 'creds' folder (will be created automatically).`);
});
