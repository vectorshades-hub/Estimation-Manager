// Backups page (Admin only — see server.js): list, back up now, download, restore, delete
const express = require('express');
const fs = require('fs');
const backup = require('../lib/backup');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ ...backup.status(), items: backup.listBackups() });
});

router.post('/', async (req, res, next) => {
  try {
    res.status(201).json(await backup.createBackup('manual', req.user.name || req.user.email));
  } catch (err) {
    next(err);
  }
});

router.get('/:name/download', (req, res, next) => {
  try {
    const file = backup.backupPath(req.params.name);
    res.download(file, req.params.name);
  } catch (err) {
    next(err);
  }
});

// Restore a backup from the list
router.post('/:name/restore', async (req, res, next) => {
  try {
    const buf = fs.readFileSync(backup.backupPath(req.params.name));
    res.json(await backup.restore(buf, req.user.name || req.user.email));
  } catch (err) {
    next(err);
  }
});

// Restore from a backup file chosen on this computer (it is also kept in the list)
router.post('/upload-restore', express.raw({ type: () => true, limit: '500mb' }), async (req, res, next) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
    const { name } = backup.saveUploaded(req.body);
    res.json({ ...(await backup.restore(req.body, req.user.name || req.user.email)), uploadedAs: name });
  } catch (err) {
    next(err);
  }
});

router.delete('/:name', (req, res, next) => {
  try {
    backup.deleteBackup(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
