const express = require('express');
const User = require('../models/User');
const { ROLES, ROLE_LABELS } = require('../models/User');
const auth = require('../lib/auth');

const router = express.Router();

// Is first-time setup needed (no users yet)?
router.get('/status', async (req, res, next) => {
  try {
    const authEnabled = process.env.AUTH_ENABLED === 'true';
    res.json({ authEnabled, setupNeeded: authEnabled && (await User.countDocuments()) === 0, roles: ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] })) });
  } catch (err) {
    next(err);
  }
});

// First-time setup: create the first Admin (only allowed while there are no users)
router.post('/setup', async (req, res, next) => {
  try {
    if (process.env.AUTH_ENABLED !== 'true') return res.status(403).json({ error: 'Sign-in is switched off' });
    if (await User.countDocuments()) return res.status(403).json({ error: 'Setup has already been completed' });
    const { username, name, password } = req.body;
    auth.checkPasswordRules(password);
    const user = await User.create({ username, name, role: 'admin', passwordHash: auth.hashPassword(password) });
    await auth.startSession(res, user);
    res.status(201).json(user.toSafeJSON());
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const key = `${username}|${req.ip}`;
    const wait = auth.loginBlocked(key);
    if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait} minute(s).` });

    const user = await User.findOne({ username });
    if (!user || !auth.verifyPassword(req.body.password || '', user.passwordHash)) {
      auth.loginFailed(key);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    if (!user.active) return res.status(403).json({ error: 'This account has been disabled. Contact your admin.' });
    auth.loginSucceeded(key);
    user.lastLogin = new Date();
    await user.save();
    await auth.startSession(res, user);
    res.json(user.toSafeJSON());
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await auth.endSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', auth.authenticate, (req, res) => res.json(req.user.toSafeJSON()));

router.post('/change-password', auth.authenticate, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!auth.verifyPassword(currentPassword || '', req.user.passwordHash)) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
    auth.checkPasswordRules(newPassword);
    req.user.passwordHash = auth.hashPassword(newPassword);
    await req.user.save();
    await auth.endAllSessions(req.user._id); // sign out other devices
    await auth.startSession(res, req.user);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
