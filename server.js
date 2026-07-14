const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

const DATA_FILE = path.join(__dirname, 'data.json');

// ----- DEFAULT ADMIN CREDENTIALS (hardcoded) -----
const ADMIN_EMAIL = 'nextechince@gmail.com';
const ADMIN_PASS = 'Dominion@14';

// Default data structure
const defaultData = {
  users: {},
  admins: [ADMIN_EMAIL],
  licenses: {}
};

// Load or create data file
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(defaultData));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// ----- SEED ADMIN ACCOUNT (if missing) -----
if (!data.users[ADMIN_EMAIL]) {
  data.users[ADMIN_EMAIL] = {
    password: ADMIN_PASS,
    uid: 'admin-lex-001',
    banned: false,
    plan: 'permanent'
  };
  if (!data.admins.includes(ADMIN_EMAIL)) {
    data.admins.push(ADMIN_EMAIL);
  }
  saveData(data);
  console.log(`✅ Admin account seeded: ${ADMIN_EMAIL}`);
}

// Helper to generate UID
function generateUid() {
  return 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 6);
}

// ---------- AUTH ENDPOINTS ----------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
  
  const user = data.users[email];
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.banned) {
    return res.status(403).json({ error: 'BANNED', uid: user.uid });
  }
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
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  let found = null;
  for (const [email, user] of Object.entries(data.users)) {
    if (user.uid === uid) {
      found = { email, ...user, isAdmin: data.admins.includes(email) };
      break;
    }
  }
  if (!found) return res.status(404).json({ error: 'User not found' });
  res.json(found);
});

// ---------- SUBSCRIPTION / PLAN ----------
app.post('/api/user/status', (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  let user = null;
  for (const [email, u] of Object.entries(data.users)) {
    if (u.uid === uid) { user = { email, ...u }; break; }
  }
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ active: user.plan !== 'none', plan: user.plan });
});

app.post('/api/user/activate-key', (req, res) => {
  const { uid, licenseKey } = req.body;
  if (!uid || !licenseKey) return res.status(400).json({ error: 'Missing data' });
  const license = data.licenses[licenseKey];
  if (!license) return res.status(404).json({ error: 'Invalid license key' });
  if (license.used) return res.status(409).json({ error: 'License already used' });
  let userEntry = null;
  for (const [email, u] of Object.entries(data.users)) {
    if (u.uid === uid) { userEntry = { email, ...u }; break; }
  }
  if (!userEntry) return res.status(404).json({ error: 'User not found' });
  data.users[userEntry.email].plan = license.plan;
  license.used = true;
  saveData(data);
  res.json({ success: true, plan: license.plan });
});

app.post('/api/user/metrics', (req, res) => {
  const { uid } = req.body;
  res.json({ total: 0, list: [] }); // Mock
});

// ---------- ADMIN ENDPOINTS ----------
app.post('/api/admin/verify', (req, res) => {
  const { email, uid } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const user = data.users[email];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.banned) return res.json({ status: 'BANNED' });
  if (data.admins.includes(email)) return res.json({ status: 'ADMIN' });
  res.json({ status: 'USER' });
});

app.post('/api/admin/get-users', (req, res) => {
  const { email } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  const users = Object.entries(data.users).map(([email, u]) => ({
    email,
    uid: u.uid,
    banned: u.banned || false,
    plan: u.plan || 'none'
  }));
  res.json({ users });
});

app.post('/api/admin/ban-user', (req, res) => {
  const { email, targetUid, action } = req.body;
  if (!data.admins.includes(email)) return res.status(403).json({ error: 'Not admin' });
  let targetEmail = null;
  for (const [e, u] of Object.entries(data.users)) {
    if (u.uid === targetUid) { targetEmail = e; break; }
  }
  if (!targetEmail) return res.status(404).json({ error: 'User not found' });
  if (targetEmail === email) return res.status(400).json({ error: 'Cannot ban yourself' });
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

// ---------- PAIRING ENDPOINTS ----------
const codeStore = {};
const activeSockets = {};

async function startPairing(uid, phoneNumber) {
  if (codeStore[uid]) return codeStore[uid];
  if (activeSockets[uid]) return null;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./creds/${uid}`);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });
    activeSockets[uid] = sock;
    sock.ev.on('creds.update', saveCreds);
    const code = await sock.requestPairingCode(phoneNumber);
    codeStore[uid] = code;
    console.log(`[${uid}] Pairing code: ${code}`);
    return code;
  } catch (err) {
    console.error(`[${uid}] Pairing error:`, err);
    codeStore[uid] = 'ERROR';
    return null;
  }
}

app.post('/api/pair', async (req, res) => {
  const { number, isPremium, targets, uid } = req.body;
  if (!number || !uid) return res.status(400).json({ error: 'Missing number or uid' });
  const cleanNumber = number.replace(/\D/g, '');
  if (cleanNumber.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  res.cookie('uid', uid, { httpOnly: true, maxAge: 600000 });
  if (codeStore[uid] && codeStore[uid] !== 'ERROR') {
    return res.json({ code: codeStore[uid] });
  }
  startPairing(uid, cleanNumber).catch(err => console.error(err));
  res.json({ message: 'Pairing initiated, please poll /api/code' });
});

app.get('/api/code', (req, res) => {
  const uid = req.cookies.uid;
  if (!uid) return res.status(400).json({ error: 'No UID cookie' });
  const code = codeStore[uid];
  if (code === 'ERROR') return res.status(500).json({ error: 'Pairing failed' });
  if (code) return res.json({ code });
  res.json({ code: null, message: 'Pairing in progress...' });
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📁 Data file: ${DATA_FILE}`);
  console.log(`🔑 Admin: ${ADMIN_EMAIL} / ${ADMIN_PASS}`);
});
