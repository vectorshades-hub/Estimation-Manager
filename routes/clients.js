const express = require('express');
const ExcelJS = require('exceljs');
const Client = require('../models/Client');
const Estimation = require('../models/Estimation');
const { nameKey } = require('../models/Client');

const router = express.Router();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TRUTHY = /^(y|yes|true|1|x|✓|✔|p|priority|high)$/i;

// List (priority first, then A-Z) with number of estimations per client
router.get('/', async (req, res, next) => {
  try {
    const filter = req.query.q ? { name: new RegExp(escapeRegex(req.query.q), 'i') } : {};
    const [clients, counts] = await Promise.all([
      Client.find(filter).collation({ locale: 'en' }).sort({ priority: -1, name: 1 }).lean(),
      Estimation.aggregate([{ $group: { _id: { $toLower: { $trim: { input: '$clientName' } } }, n: { $sum: 1 } } }]),
    ]);
    const byKey = Object.fromEntries(counts.map(c => [c._id, c.n]));
    res.json(clients.map(c => ({ ...c, estimations: byKey[c.nameKey] || 0 })));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, priority } = req.body;
    const existing = await Client.findOne({ nameKey: nameKey(name) });
    if (existing) return res.status(409).json({ error: `"${existing.name}" is already in the list` });
    res.status(201).json(await Client.create({ name, priority: !!priority }));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const c = await Client.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (req.body.name !== undefined) c.name = req.body.name;
    if (req.body.priority !== undefined) c.priority = !!req.body.priority;
    res.json(await c.save());
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const c = await Client.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Import from Excel (.xlsx) or CSV ----------
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map(s => s.trim()));
  }
  return rows;
}

async function readRows(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) { // "PK" = xlsx (zip)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const cells = [];
      for (let i = 1; i <= row.cellCount; i++) cells.push(String(row.getCell(i).text ?? '').trim());
      rows.push(cells);
    });
    return rows;
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw Object.assign(new Error('Old .xls format is not supported — please save the file as .xlsx or .csv'), { status: 400 });
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

router.post('/import', express.raw({ type: () => true, limit: '10mb' }), async (req, res, next) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
    const rows = await readRows(req.body);
    if (!rows.length) return res.status(400).json({ error: 'The file is empty' });

    // Find a header row (within the first 5 rows) with a client/name column
    let headerIdx = -1, nameCol = 0, prioCol = -1;
    for (let r = 0; r < Math.min(5, rows.length); r++) {
      const n = rows[r].findIndex(h => /client|customer|company|name/i.test(h));
      if (n >= 0) {
        headerIdx = r; nameCol = n;
        prioCol = rows[r].findIndex(h => /priority|prio|vip/i.test(h));
        break;
      }
    }
    const markAll = req.query.priority === '1';
    const data = rows.slice(headerIdx + 1);

    const existing = new Map((await Client.find().lean()).map(c => [c.nameKey, c]));
    const seen = new Set();
    let added = 0, updated = 0, skipped = 0;
    const ops = [];
    for (const r of data) {
      const name = String(r[nameCol] || '').trim().replace(/\s+/g, ' ');
      const key = nameKey(name);
      if (!key || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const filePrio = prioCol >= 0 ? TRUTHY.test(String(r[prioCol] || '').trim()) : null;
      const priority = markAll ? true : filePrio;
      const ex = existing.get(key);
      if (!ex) {
        ops.push({ insertOne: { document: { name, nameKey: key, priority: !!priority } } });
        added++;
      } else if (priority !== null && ex.priority !== priority) {
        ops.push({ updateOne: { filter: { _id: ex._id }, update: { $set: { priority } } } });
        updated++;
      } else skipped++;
    }
    if (ops.length) await Client.bulkWrite(ops, { ordered: false });
    res.json({ added, updated, skipped, priorityColumn: prioCol >= 0 });
  } catch (err) {
    next(err);
  }
});

// Blank template to fill in
router.get('/template', async (req, res, next) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clients');
    ws.columns = [{ header: 'Client Name', width: 40 }, { header: 'Priority', width: 12 }];
    ws.getRow(1).font = { bold: true, name: 'Arial' };
    ws.addRow(['Steel Works', 'Yes']);
    ws.addRow(['Example Fabricators Inc', 'No']);
    ws.getCell('D1').value = 'Priority: Yes / No (leave blank = No)';
    ws.getCell('D1').font = { italic: true, color: { argb: 'FF666666' } };
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="client_list_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
