// Notifications: estimations changed after they were marked Completed.
// Team Leaders and above only (guarded in server.js); each user sees the changes made by the roles below them
// (Admins see all), and marks them read for themselves.
const express = require('express');
const Notification = require('../models/Notification');

const router = express.Router();
const PAGE_SIZE = 100;

const visible = req => Notification.visibleTo(req.user);
const unreadFor = req => ({ ...visible(req), readBy: { $ne: Notification.readerKey(req.user) } });

// Query: unread=1 (only unread), page (1-based)
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = req.query.unread === '1' ? unreadFor(req) : visible(req);
    const me = Notification.readerKey(req.user);
    const [items, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments(unreadFor(req)),
    ]);
    res.json({
      items: items.map(({ readBy, ...n }) => ({ ...n, read: (readBy || []).includes(me) })),
      total, unread, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    next(err);
  }
});

// Unread count for the menu badge
router.get('/count', async (req, res, next) => {
  try {
    res.json({ unread: await Notification.countDocuments(unreadFor(req)) });
  } catch (err) {
    next(err);
  }
});

router.put('/read-all', async (req, res, next) => {
  try {
    await Notification.updateMany(unreadFor(req), { $addToSet: { readBy: Notification.readerKey(req.user) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const me = Notification.readerKey(req.user);
    const n = await Notification.findOneAndUpdate({ _id: req.params.id, ...visible(req) },
      req.body.read ? { $addToSet: { readBy: me } } : { $pull: { readBy: me } }, { new: true });
    if (!n) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
