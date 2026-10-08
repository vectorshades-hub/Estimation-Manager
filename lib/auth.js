// Authentication helpers: password hashing (scrypt), cookie sessions, and role checks.
const crypto = require('crypto');
const User = require('../models/User');
const Session = require('../models/Session');
const { ROLES } = require('../models/User');

const COOKIE = 'em_session';
const SESSION_HOURS = 12;
const MIN_PASSWORD = 8;

// ---------- Passwords ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function checkPasswordRules(password) {
  if (String(password || '').length < MIN_PASSWORD) {
    throw Object.assign(new Error(`Password must be at least ${MIN_PASSWORD} characters`), { status: 400 });
  }
}

// ---------- Sessions ----------
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await Session.create({ tokenHash: sha256(token), user: user._id, expiresAt });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}

async function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Sign out a user everywhere (password reset, deactivation, deletion)
const endAllSessions = userId => Session.deleteMany({ user: userId });

// ---------- Middleware ----------
// Loads req.user from the session cookie; 401 if not signed in
async function authenticate(req, res, next) {
  try {
    const token = readCookie(req, COOKIE);
    if (!token) return res.status(401).json({ error: 'Please sign in' });
    const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ error: 'Your session has expired — please sign in again' });
    const user = await User.findById(session.user);
    if (!user || !user.active) {
      await session.deleteOne();
      return res.status(401).json({ error: 'Your account is not active' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const roleRank = role => ROLES.indexOf(role);
const hasRole = (user, minRole) => !!user && roleRank(user.role) >= roleRank(minRole);

// requireRole('team_leader') -> team leaders, managers and admins
const requireRole = minRole => (req, res, next) =>
  hasRole(req.user, minRole)
    ? next()
    : res.status(403).json({ error: 'You do not have permission to do this' });

// ---------- Login throttling (per username + IP, in memory) ----------
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

function loginBlocked(key) {
  const a = attempts.get(key);
  if (!a) return 0;
  if (a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function loginFailed(key) {
  const a = attempts.get(key) || { count: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) { a.lockedUntil = Date.now() + LOCK_MINUTES * 60000; a.count = 0; }
  attempts.set(key, a);
}
const loginSucceeded = key => attempts.delete(key);

module.exports = {
  hashPassword, verifyPassword, checkPasswordRules,
  startSession, endSession, endAllSessions,
  authenticate, requireRole, hasRole,
  loginBlocked, loginFailed, loginSucceeded,
};
