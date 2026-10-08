// User management — Admin only (guarded in server.js)
const express = require('express');
const User = require('../models/User');
const auth = require('../lib/auth');

const router = express.Router();

const adminCount = () => User.countDocuments({ role: 'admin', active: true });

router.get('/', async (req, res, next) => {
  try {
    const users = await User.find().collation({ locale: 'en' }).sort({ active: -1, name: 1 });
    res.json(users.map(u => u.toSafeJSON()));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { username, name, role, password } = req.body;
    auth.checkPasswordRules(password);
    const user = await User.create({ username, name, role, passwordHash: auth.hashPassword(password) });
    res.status(201).json(user.toSafeJSON());
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That username is already taken' });
    next(err);
  }
});

// Update name / role / active, or reset the password
router.put('/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { name, role, active, password } = req.body;
    const self = user._id.equals(req.user._id);

    // Never leave the system without an active admin
    const losingAdmin = user.role === 'admin' && user.active &&
      ((role !== undefined && role !== 'admin') || active === false);
    if (losingAdmin && (await adminCount()) <= 1) {
      return res.status(400).json({ error: 'There must be at least one active Admin' });
    }
    if (self && active === false) return res.status(400).json({ error: 'You cannot disable your own account' });

    if (name !== undefined) user.name = name;
    if (role !== undefined) user.role = role;
    if (active !== undefined) user.active = !!active;
    if (password) {
      auth.checkPasswordRules(password);
      user.passwordHash = auth.hashPassword(password);
    }
    await user.save();
    if (password || active === false) await auth.endAllSessions(user._id); // force sign-in again
    res.json(user.toSafeJSON());
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user._id.equals(req.user._id)) return res.status(400).json({ error: 'You cannot delete your own account' });
    if (user.role === 'admin' && user.active && (await adminCount()) <= 1) {
      return res.status(400).json({ error: 'There must be at least one active Admin' });
    }
    await auth.endAllSessions(user._id);
    await user.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
