// Activity log — Admin only (guarded in server.js)
const express = require('express');
const Log = require('../models/Log');

const router = express.Router();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PAGE_SIZE = 100;

// Query: q (search), user (username), result ('ok' | 'failed'), from / to (yyyy-mm-dd), page (1-based)
router.get('/', async (req, res, next) => {
  try {
    const { q, user, result, from, to } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = {};
    if (user) filter.username = user;
    if (result === 'ok') filter.ok = true;
    if (result === 'failed') filter.ok = false;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ action: rx }, { target: rx }, { details: rx }, { user: rx }, { username: rx }, { ip: rx }, { path: rx }, { error: rx }];
    }
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    if (isDate(from) || isDate(to)) {
      // Dates are the viewer's local days: tz = minutes from getTimezoneOffset()
      const tz = Number(req.query.tz) || 0;
      filter.at = {};
      if (isDate(from)) filter.at.$gte = new Date(new Date(`${from}T00:00:00.000Z`).getTime() + tz * 60000);
      if (isDate(to)) filter.at.$lte = new Date(new Date(`${to}T23:59:59.999Z`).getTime() + tz * 60000);
    }
    const [items, total, users] = await Promise.all([
      Log.find(filter).sort({ at: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Log.countDocuments(filter),
      Log.aggregate([{ $match: { username: { $nin: [null, ''] } } },
        { $group: { _id: '$username', name: { $last: '$user' } } }, { $sort: { name: 1, _id: 1 } }]),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      users: users.map(u => ({ username: u._id, name: u.name || u._id })) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
