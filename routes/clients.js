const express = require('express');
const ExcelJS = require('exceljs');
const Client = require('../models/Client');
const Estimation = require('../models/Estimation');
const { nameKey } = require('../models/Client');

const router = express.Router();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TRUTHY = /^(y|yes|true|1|x|✓|✔|p|priority|high)$/i;
const PREFERENCES = ['Client', 'Bidding', 'Past Client', 'Closed'];

// Won estimations in this app, per client and year: Map(nameKey -> { [year]: count })
async function appWins() {
  const won = await Estimation.find({ status: 'Won' }).select('clientName wonAt date updatedAt').lean();
  const map = new Map();
  for (const e of won) {
    const year = String(new Date(e.wonAt || e.date || e.updatedAt).getFullYear());
    const k = nameKey(e.clientName);
    const m = map.get(k) || {};
    m[year] = (m[year] || 0) + 1;
    map.set(k, m);
  }
  return map;
}

// Estimations per client (any status)
async function estimationCounts() {
  const counts = await Estimation.aggregate([{ $group: { _id: { $toLower: { $trim: { input: '$clientName' } } }, n: { $sum: 1 } } }]);
  return Object.fromEntries(counts.map(c => [String(c._id).replace(/\s+/g, ' '), c.n]));
}

// Clients with awarded counts per year (= imported/manual base + Won estimations) and the list of years
async function clientsWithAwards(filter = {}) {
  const [clients, wins, est] = await Promise.all([
    Client.find(filter).collation({ locale: 'en' }).sort({ priority: -1, name: 1 }).lean(),
    appWins(),
    estimationCounts(),
  ]);
  const years = new Set([String(new Date().getFullYear())]);
  const list = clients.map(c => {
    const base = c.awardedBase || {};
    const w = wins.get(c.nameKey) || {};
    const awarded = {};
    for (const y of new Set([...Object.keys(base), ...Object.keys(w)])) {
      awarded[y] = (Number(base[y]) || 0) + (w[y] || 0);
      years.add(y);
    }
    const totalAwarded = Object.values(awarded).reduce((a, b) => a + b, 0);
    return { ...c, awarded, appWins: w, totalAwarded, estimations: est[c.nameKey] || 0 };
  });
  return { clients: list, years: [...years].sort() };
}

router.get('/', async (req, res, next) => {
  try {
    const filter = req.query.q ? { name: new RegExp(escapeRegex(req.query.q), 'i') } : {};
    const { clients, years } = await clientsWithAwards(filter);
    const prefs = new Set(PREFERENCES);
    clients.forEach(c => c.preference && prefs.add(c.preference));
    res.json({ clients, years, preferences: [...prefs] });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, priority, salesLead, preference } = req.body;
    const existing = await Client.findOne({ nameKey: nameKey(name) });
    if (existing) return res.status(409).json({ error: `"${existing.name}" is already in the list` });
    res.status(201).json(await Client.create({ name, priority: !!priority, salesLead, preference }));
  } catch (err) {
    next(err);
  }
});

// Update fields. `awarded: { "2025": 4 }` sets the shown count for a year (base is adjusted for app wins).
router.put('/:id', async (req, res, next) => {
  try {
    const c = await Client.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const { name, priority, salesLead, preference, awarded } = req.body;
    if (name !== undefined) c.name = name;
    if (priority !== undefined) c.priority = !!priority;
    if (salesLead !== undefined) c.salesLead = salesLead;
    if (preference !== undefined) c.preference = preference;
    if (awarded && typeof awarded === 'object') {
      const w = (await appWins()).get(nameKey(c.name)) || {};
      for (const [year, v] of Object.entries(awarded)) {
        if (!/^\d{4}$/.test(year)) continue;
        c.awardedBase.set(year, Math.max(0, (Number(v) || 0) - (w[year] || 0)));
      }
    }
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
    const ws = wb.worksheets.find(s => s.state !== 'hidden' && s.actualRowCount > 0) || wb.worksheets[0];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
      const cells = [];
      for (let i = 1; i <= row.cellCount; i++) {
        const cell = row.getCell(i);
        const v = cell.result !== undefined && cell.formula ? cell.result : null; // use formula results
        cells.push(String(v ?? cell.text ?? '').trim());
      }
      rows.push(cells);
    });
    return rows;
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf) throw Object.assign(new Error('Old .xls format is not supported — please save the file as .xlsx or .csv'), { status: 400 });
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

// Work out which column holds what from the header row
function mapHeader(header) {
  const h = header.map(x => String(x || '').replace(/\s+/g, ' ').trim());
  const find = (re, not) => h.findIndex(x => re.test(x) && !(not && not.test(x)));
  let name = find(/client\s*name|customer\s*name|company\s*name|^name$/i);
  if (name < 0) name = find(/client|customer|company|name/i, /pref|lead|priority|award|total/i);
  const years = [];
  h.forEach((x, i) => {
    const m = x.match(/\b(19|20)\d{2}\b/);
    if (m && !/total/i.test(x) && i !== name) years.push({ col: i, year: m[0] });
  });
  return {
    name,
    salesLead: find(/sales|lead/i, /client\s*name/i),
    preference: find(/pref/i),
    priority: find(/priority|prio|vip/i),
    years,
  };
}

router.post('/import', express.raw({ type: () => true, limit: '10mb' }), async (req, res, next) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
    const rows = await readRows(req.body);
    if (!rows.length) return res.status(400).json({ error: 'The file is empty' });

    // Header row = first of the first 5 rows that has a client/name column
    let headerIdx = -1, cols = { name: 0, salesLead: -1, preference: -1, priority: -1, years: [] };
    for (let r = 0; r < Math.min(5, rows.length); r++) {
      const m = mapHeader(rows[r]);
      if (m.name >= 0) { headerIdx = r; cols = m; break; }
    }
    const markAll = req.query.priority === '1';
    const wins = await appWins();
    const existing = new Map((await Client.find()).map(c => [c.nameKey, c]));
    const seen = new Set();
    let added = 0, updated = 0, skipped = 0;

    for (const r of rows.slice(headerIdx + 1)) {
      const name = String(r[cols.name] || '').trim().replace(/\s+/g, ' ');
      const key = nameKey(name);
      if (!key || seen.has(key) || /^total/i.test(name)) { skipped++; continue; }
      seen.add(key);
      const val = i => (i >= 0 ? String(r[i] ?? '').trim() : '');
      const doc = existing.get(key) || new Client({ name });
      const isNew = doc.isNew;
      if (markAll) doc.priority = true;
      else if (cols.priority >= 0) doc.priority = TRUTHY.test(val(cols.priority));
      if (val(cols.salesLead)) doc.salesLead = val(cols.salesLead);
      if (val(cols.preference)) doc.preference = val(cols.preference);
      // File counts are the truth as of import: base = file count - wins already tracked in the app
      const w = wins.get(key) || {};
      for (const { col, year } of cols.years) {
        const n = parseFloat(val(col).replace(/,/g, ''));
        if (Number.isFinite(n)) doc.awardedBase.set(year, Math.max(0, n - (w[year] || 0)));
      }
      if (isNew) { await doc.save(); added++; }
      else if (doc.isModified()) { await doc.save(); updated++; }
      else skipped++;
    }
    res.json({
      added, updated, skipped,
      columns: {
        name: rows[headerIdx]?.[cols.name] || 'column 1',
        salesLead: cols.salesLead >= 0, preference: cols.preference >= 0, priority: cols.priority >= 0,
        years: cols.years.map(y => y.year),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Excel template / export (same layout as the client sheet) ----------
async function clientWorkbook(clients, years, { template = false } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clients', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = ['Client Names', 'Sales Lead', 'Client preferance', ...years.map(y => `${y}\nNo of projects awarded`), 'Total Awarded Projects', 'Priority'];
  ws.columns = headers.map((h, i) => ({ header: h, width: i === 0 ? 38 : i < 3 ? 18 : 20 }));
  const head = ws.getRow(1);
  head.height = 42;
  head.eachCell(cell => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B5E7E' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  head.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
  const border = { style: 'thin', color: { argb: 'FF1B5E7E' } };
  const totalCol = 4 + years.length;
  clients.forEach(c => {
    const row = ws.addRow([c.name, c.salesLead || '', c.preference || '', ...years.map(y => c.awarded?.[y] || 0), null, c.priority ? 'Yes' : 'No']);
    const first = ws.getColumn(4).letter, last = ws.getColumn(3 + years.length).letter;
    row.getCell(totalCol).value = { formula: `SUM(${first}${row.number}:${last}${row.number})`, result: c.totalAwarded || 0 };
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { name: 'Arial', size: 10 };
      cell.border = { top: border, bottom: border };
      if (col > 3) cell.alignment = { horizontal: 'center' };
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, ws.rowCount), column: headers.length } };
  if (!template && clients.length) {
    ws.addConditionalFormatting({
      ref: `${ws.getColumn(4).letter}2:${ws.getColumn(totalCol).letter}${ws.rowCount}`,
      rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF63BE7B' } }],
    });
  }
  return wb;
}

router.get('/template', async (req, res, next) => {
  try {
    const y = new Date().getFullYear();
    const wb = await clientWorkbook([
      { name: 'Example Steel Inc', salesLead: 'Daniel', preference: 'Client', awarded: { [y - 1]: 3, [y]: 1 }, totalAwarded: 4, priority: true },
      { name: 'Sample Fabricators LLC', salesLead: 'Daniel', preference: 'Bidding', awarded: {}, totalAwarded: 0 },
    ], [String(y - 1), String(y)], { template: true });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="client_list_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const { clients, years } = await clientsWithAwards();
    const wb = await clientWorkbook(clients, years);
    const d = new Date();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Client_List_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
