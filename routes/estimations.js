const express = require('express');
const Estimation = require('../models/Estimation');
const Client = require('../models/Client');
const { nameKey } = require('../models/Client');
const { isLessValueJob } = require('../public/calc');

// Adds priorityClient / lessValue flags (computed live, so priority changes apply immediately)
async function withFlags(docs) {
  const prio = await Client.priorityKeys();
  return docs.map(d => {
    const o = d.toJSON ? d.toJSON() : d;
    const priorityClient = prio.has(nameKey(o.clientName));
    return { ...o, priorityClient, lessValue: isLessValueJob(o.totalHours, priorityClient) };
  });
}
const { buildWorkbook } = require('../lib/excel');
const { buildExport } = require('../lib/exportList');
const { buildProposal, proposalFileName } = require('../lib/proposal');
const JSZip = require('jszip');
const { requireRole, hasRole } = require('../lib/auth');
const notify = require('../lib/notify');

const router = express.Router();

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_FIELDS = 'completed completedAt completedBy createdBy updatedBy updatedAt jobNo projectName clientName date doneBy dueDate status links sheetCount pageCount totalCount totalHours totalDwgs approxTonnage createdAt connectionDesign';

// Completed estimations stay in the main list for this many days, then are only on the Completed page
const COMPLETED_LIST_DAYS = 3;
const recentOrOpen = () => ({ $or: [
  { completed: { $ne: true } },
  { completedAt: { $gte: new Date(Date.now() - COMPLETED_LIST_DAYS * 24 * 3600 * 1000) } },
] });

const { LESS_VALUE_HOURS } = require('../public/calc');
const LIST_PAGE_SIZE = 25;

// Shared by the list and the Excel export. Filtering, sorting (see listOrder) and paging all run in MongoDB.
// Query: q (search), status, value ('less' | 'priority' | 'open' | 'completed'), from / to (due date range, yyyy-mm-dd),
// due (due date(s), yyyy-mm-dd, comma-separated for several days).
// With `page` (1-based) only that page is returned: { items, total, page, pages, pageSize }; without it, every match.
async function findFiltered(query, fields, { page } = {}) {
  const { value } = query;
  // Priority client = client name matches a priority client (ignoring case and extra spaces)
  const prioNames = (await Client.find({ priority: true }).select('name').lean())
    .map(c => escapeRegex(nameKey(c.name)).replace(/ /g, '\\s+'));
  const priorityClient = prioNames.length
    ? { $regexMatch: { input: { $ifNull: ['$clientName', ''] }, regex: `^\\s*(?:${prioNames.join('|')})\\s*$`, options: 'i' } }
    : false;
  const valueMatch = {
    less: { lessValue: true }, priority: { priorityClient: true },
    completed: { completed: true }, open: { completed: { $ne: true } },
  }[value];
  const pipeline = [
    { $match: buildFilter(query) },
    { $addFields: { priorityClient } },
    { $addFields: {
      lessValue: { $and: [{ $not: ['$priorityClient'] }, { $lt: [{ $ifNull: ['$totalHours', 0] }, LESS_VALUE_HOURS] }] },
      _done: { $cond: ['$completed', 1, 0] },
      _due: { $cond: [{ $ifNull: ['$dueDate', false] }, { $dateToString: { date: '$dueDate', format: '%Y-%m-%d' } }, '9999-99-99'] },
      _prio: { $cond: ['$priorityClient', 0, 1] },
      _prog: { $cond: [{ $eq: ['$status', 'In Progress'] }, 0, 1] },
    } },
    ...(valueMatch ? [{ $match: valueMatch }] : []),
    { $sort: { _done: 1, _due: 1, _prio: 1, _prog: 1, jobNo: 1, _id: 1 } },
  ];
  const collation = { locale: 'en', numericOrdering: true }; // No. "26-9" before "26-10"
  let ids, total, pageNo = 1, pages = 1;
  if (page) {
    total = (await Estimation.aggregate([...pipeline.slice(0, -1), { $count: 'n' }]).collation(collation))[0]?.n || 0;
    pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    pageNo = Math.min(Math.max(1, parseInt(page, 10) || 1), pages);
    pipeline.push({ $skip: (pageNo - 1) * LIST_PAGE_SIZE }, { $limit: LIST_PAGE_SIZE });
  }
  ids = (await Estimation.aggregate([...pipeline, { $project: { _id: 1 } }]).collation(collation)).map(d => String(d._id));
  const docs = await Estimation.find({ _id: { $in: ids } }).select(fields);
  const order = new Map(ids.map((id, i) => [id, i]));
  const items = (await withFlags(docs)).sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
  return page ? { items, total, page: pageNo, pages, pageSize: LIST_PAGE_SIZE } : items;
}

function buildFilter(query) {
  const { q, status, from, to, due } = query;
  const filter = { $and: [recentOrOpen()] };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ jobNo: rx }, { projectName: rx }, { clientName: rx }, { doneBy: rx }, { scope: rx }];
  }
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (isDate(from) || isDate(to)) { // due date range (due dates are stored as UTC midnight of the day)
    const range = {};
    if (isDate(from)) range.$gte = new Date(`${from}T00:00:00.000Z`);
    if (isDate(to)) range.$lte = new Date(`${to}T23:59:59.999Z`);
    filter.$and.push({ dueDate: range });
  }
  const dueDays = String(due || '').split(',').filter(isDate);
  if (dueDays.length) {
    filter.$and.push({ $or: dueDays.map(d => ({ dueDate: { $gte: new Date(`${d}T00:00:00.000Z`), $lte: new Date(`${d}T23:59:59.999Z`) } })) });
  }
  return filter;
}

// List order: open estimations first, completed ones at the bottom. Within each group: by due day (earliest first,
// no due date last); on the same day priority clients first, then In Progress, then by No.
const dueDay = e => (e.dueDate ? new Date(e.dueDate).toISOString().slice(0, 10) : '9999-99-99');
function listOrder(a, b) {
  return (!!a.completed - !!b.completed)
    || dueDay(a).localeCompare(dueDay(b))
    || (!!b.priorityClient - !!a.priorityClient)
    || ((b.status === 'In Progress') - (a.status === 'In Progress'))
    || String(a.jobNo || '').localeCompare(String(b.jobNo || ''), undefined, { numeric: true });
}

function describeFilters({ q, status, value, from, to, due }) {
  return [
    q && `Search: "${q}"`,
    status && `Status: ${status}`,
    value === 'less' && 'Less value jobs only',
    value === 'priority' && 'Priority clients only',
    value === 'open' && 'Not completed only',
    value === 'completed' && `Completed only (last ${COMPLETED_LIST_DAYS} days)`,
    due && `Due: ${String(due).split(',').join(', ')}`,
    from && `Due from: ${from}`,
    to && `Due to: ${to}`,
  ].filter(Boolean).join(';  ');
}

// List with optional filters, LIST_PAGE_SIZE per page (?page=, 1-based)
router.get('/', async (req, res, next) => {
  try {
    res.json(await findFiltered(req.query, LIST_FIELDS, { page: req.query.page || 1 }));
  } catch (err) {
    next(err);
  }
});

// Completed log: every completed estimation, most recently completed first (all users).
// Query: q (search), from / to (completed date, yyyy-mm-dd, viewer's local days), tz (getTimezoneOffset), page (1-based)
const COMPLETED_PAGE_SIZE = 25;
router.get('/completed', async (req, res, next) => {
  try {
    const { q, from, to } = req.query;
    const filter = { completed: true };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ jobNo: rx }, { projectName: rx }, { clientName: rx }, { doneBy: rx }, { completedBy: rx }];
    }
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    if (isDate(from) || isDate(to)) {
      const tz = Number(req.query.tz) || 0;
      filter.completedAt = {};
      if (isDate(from)) filter.completedAt.$gte = new Date(new Date(`${from}T00:00:00.000Z`).getTime() + tz * 60000);
      if (isDate(to)) filter.completedAt.$lte = new Date(new Date(`${to}T23:59:59.999Z`).getTime() + tz * 60000);
    }
    const total = await Estimation.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / COMPLETED_PAGE_SIZE));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages); // past the end -> last page
    const docs = await Estimation.find(filter).select(LIST_FIELDS).sort({ completedAt: -1, _id: -1 })
      .skip((page - 1) * COMPLETED_PAGE_SIZE).limit(COMPLETED_PAGE_SIZE);
    res.json({ items: await withFlags(docs), total, page, pages, pageSize: COMPLETED_PAGE_SIZE,
      listDays: COMPLETED_LIST_DAYS });
  } catch (err) {
    next(err);
  }
});

// Calendar: every estimation (completed ones too) due between from and to (yyyy-mm-dd, inclusive).
// Due dates are stored as UTC midnight of the chosen day.
const CALENDAR_MAX_DAYS = 62;
router.get('/calendar', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from and to dates (yyyy-mm-dd) are required' });
    const start = new Date(`${from}T00:00:00.000Z`), end = new Date(`${to}T23:59:59.999Z`);
    if (end < start || end - start > CALENDAR_MAX_DAYS * 86400000) return res.status(400).json({ error: `Pick a range of up to ${CALENDAR_MAX_DAYS} days` });
    const docs = await Estimation.find({ dueDate: { $gte: start, $lte: end } }).select(LIST_FIELDS);
    res.json((await withFlags(docs)).sort(listOrder));
  } catch (err) {
    next(err);
  }
});

// Export the (filtered) list to Excel
router.get('/export', requireRole('team_leader'), async (req, res, next) => {
  try {
    const items = await findFiltered(req.query, '-pages -structDescriptions -miscDescriptions');
    const wb = await buildExport(items, describeFilters(req.query));
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Estimations_${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// Dashboard summary
router.get('/stats/summary', async (req, res, next) => {
  try {
    const [totals] = await Estimation.aggregate([
      { $group: { _id: null, count: { $sum: 1 }, tonnage: { $sum: '$approxTonnage' }, hours: { $sum: '$totalHours' } } },
    ]);
    const byStatus = await Estimation.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 }, tonnage: { $sum: '$approxTonnage' } } },
    ]);
    const all = await withFlags(await Estimation.find().select('clientName totalHours').lean());
    res.json({
      lessValue: all.filter(e => e.lessValue).length,
      count: totals?.count || 0,
      tonnage: totals?.tonnage || 0,
      hours: totals?.hours || 0,
      byStatus: Object.fromEntries(byStatus.map(s => [s._id, { count: s.count, tonnage: s.tonnage }])),
    });
  } catch (err) {
    next(err);
  }
});

// Suggest the next No. in the form YY-NNN (e.g. 26-150)
router.get('/next-no', async (req, res, next) => {
  try {
    const yy = String(new Date().getFullYear()).slice(-2);
    const docs = await Estimation.find({ jobNo: new RegExp(`^${yy}-\\d+`) }).select('jobNo').lean();
    const max = docs.reduce((m, d) => Math.max(m, parseInt(d.jobNo.split('-')[1], 10) || 0), 0);
    res.json({ jobNo: `${yy}-${String(max + 1).padStart(3, '0')}` });
  } catch (err) {
    next(err);
  }
});

// ---------- Import Excel (Admin): fill an estimation's chart from an estimation chart workbook ----------
const { readEstimationWorkbook } = require('../lib/importExcel');
const IMPORT_FIELDS = 'jobNo projectName clientName contactPerson date dueDate doneBy status completed completedAt createdBy updatedBy updatedAt sheetCount pageCount totalCount totalHours totalDwgs approxTonnage pages.name';

// Project picker: every estimation (completed ones too), searched by No. / project / client, newest first
router.get('/import-search', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const rx = q && new RegExp(escapeRegex(q), 'i');
    const docs = await Estimation.find(rx ? { $or: [{ jobNo: rx }, { projectName: rx }, { clientName: rx }] } : {})
      .select('jobNo projectName clientName dueDate status completed').sort({ createdAt: -1 }).limit(30).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/import-card', requireRole('admin'), async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id).select(IMPORT_FIELDS).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ ...(await withFlags([doc]))[0], pageNames: (doc.pages || []).map(p => p.name) });
  } catch (err) {
    next(err);
  }
});

// Body: the .xlsx file. ?mode=replace (default: the file's pages replace the chart) | append (added after the
// existing pages). import-preview only reads the file and returns what would be filled; import-excel saves it.
const importExcel = preview => async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const file = await readEstimationWorkbook(req.body);
    const append = req.query.mode === 'append';
    const warnings = [...file.warnings];
    const same = (a, b) => nameKey(a).replace(/[^a-z0-9]/g, '') === nameKey(b).replace(/[^a-z0-9]/g, '');
    const label = [doc.jobNo, doc.projectName].filter(Boolean).join(' ');
    if (file.header.project && !same(file.header.project, label) && !same(file.header.project, doc.projectName)) {
      warnings.push(`The file is for project "${file.header.project}", not "${label}"`);
    }
    if (file.header.client && !same(file.header.client, doc.clientName)) {
      warnings.push(`The file is for client "${file.header.client}", not "${doc.clientName}"`);
    }
    let pages = file.pages;
    if (append) {
      const taken = new Set(doc.pages.map(p => p.name.toLowerCase()));
      pages = pages.map(p => {
        let name = p.name;
        for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${p.name} (${k})`;
        taken.add(name.toLowerCase());
        return { ...p, name };
      });
    }
    const result = { header: file.header, summary: file.summary, exclusions: file.exclusions, warnings,
      existingPages: doc.pages.length, mode: append ? 'append' : 'replace' };
    if (preview) return res.json(result);

    const body = { pages: append ? [...doc.toObject({ flattenMaps: true }).pages, ...pages] : pages };
    if (file.exclusions.length) body.exclusions = file.exclusions;
    checkLocked(doc, body);
    doc.set({ ...body, ...(req.user.name ? { updatedBy: req.user.name } : {}) });
    await doc.save(); // recomputes the totals
    res.json({ ...result, saved: true, totalHours: doc.totalHours, approxTonnage: doc.approxTonnage, pageCount: doc.pageCount });
  } catch (err) {
    next(err);
  }
};
const xlsxBody = express.raw({ type: () => true, limit: '20mb' });
router.post('/:id/import-preview', requireRole('admin'), xlsxBody, importExcel(true));
router.post('/:id/import-excel', requireRole('admin'), xlsxBody, importExcel(false));

router.get('/:id', async (req, res, next) => {
  try {
    const item = await Estimation.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

const safeName = s => s.replace(/[\\/:*?"<>|]/g, '-');
const chartFileName = (est, pageName) => safeName(`${[est.jobNo, est.projectName, pageName].filter(Boolean).join(' ')}_output.xlsx`);
const zipName = (est, what) => safeName(`${[est.jobNo, est.projectName].filter(Boolean).join(' - ')} - ${what}.zip`);

// One estimation per chart page (for the "separate files" downloads): that page only, named after it
const perPage = est => (est.pages || []).map((page, i) => ({ pageName: (page.name || '').trim() || `Page ${i + 1}`, est: { ...est, pages: [page] } }));

// Zip with the given { name: buffer } files. Repeated names (pages with the same name) get " (2)", " (3)"…
async function sendZip(res, name, files) {
  const zip = new JSZip();
  // Zip entries store wall-clock time; JSZip writes UTC, so shift to local time
  const now = new Date();
  const date = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  const used = new Set();
  for (let [file, buf] of files) {
    for (let n = 2; used.has(file.toLowerCase()); n++) file = file.replace(/( \(\d+\))?(\.\w+)$/, ` (${n})$2`);
    used.add(file.toLowerCase());
    zip.file(file, buf, { date });
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(out);
}

// "Ready for Submittal": Excel estimation chart + Word proposal in one zip
router.get('/:id/package', async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const est = doc.toObject({ flattenMaps: true });
    const wb = await buildWorkbook(est);
    await sendZip(res, zipName(est, 'Submittal'), [
      [chartFileName(est), await wb.xlsx.writeBuffer()],
      [proposalFileName(est), await buildProposal(est)],
    ]);
  } catch (err) {
    next(err);
  }
});

// Download the estimation chart as .xlsx (?separate=1: one .xlsx per chart page, in a zip)
router.get('/:id/excel', async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const est = doc.toObject({ flattenMaps: true });
    if (req.query.separate) {
      const files = [];
      for (const p of perPage(est)) files.push([chartFileName(est, p.pageName), await (await buildWorkbook(p.est)).xlsx.writeBuffer()]);
      return await sendZip(res, zipName(est, 'Excel by page'), files);
    }
    const wb = await buildWorkbook(est);
    const name = chartFileName(est);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

// Download the proposal as a Word document (?separate=1: one proposal per chart page, in a zip)
router.get('/:id/proposal', async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const est = doc.toObject({ flattenMaps: true });
    if (req.query.separate) {
      const files = [];
      for (const p of perPage(est)) files.push([proposalFileName(est, p.pageName), await buildProposal(p.est)]);
      return await sendZip(res, zipName(est, 'Proposals by page'), files);
    }
    const buf = await buildProposal(est);
    const name = proposalFileName(est);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^ -~]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

const clean = ({ _id, createdAt, updatedAt, totalCount, totalHours, totalDwgs, approxTonnage, sheetCount, pageCount,
  wonAt, completedAt, completedBy, createdBy, updatedBy, __v, ...data }) => data;

// Only Team Leaders and above may set or clear Won / Lost
const DECIDED = ['Won', 'Lost'];
function checkStatusChange(req, from, to) {
  if (to === undefined || to === from) return;
  if ((DECIDED.includes(to) || DECIDED.includes(from)) && !hasRole(req.user, 'team_leader')) {
    throw Object.assign(new Error('Only a Team Leader, Manager or Admin can mark an estimation Won or Lost'), { status: 403 });
  }
}

// "Sent for Bid" (completed) or Submitted: locked. Nothing else can be changed until the status is changed
// to one that is not locked (a change that keeps it locked may only touch the status / Sent for Bid).
const isLocked = e => !!e.completed || e.status === 'Submitted';
const LOCK_KEYS = ['status', 'completed'];
function checkLocked(doc, body) {
  if (!isLocked(doc)) return;
  const after = { completed: 'completed' in body ? !!body.completed : doc.completed, status: body.status ?? doc.status };
  if (!isLocked(after)) return; // being unlocked: the other changes are allowed with it
  if (Object.keys(body).some(k => !LOCK_KEYS.includes(k))) {
    throw Object.assign(new Error(`This estimation is ${doc.completed ? 'Sent for Bid' : 'Submitted'} — change its status first to make changes`), { status: 409 });
  }
}

// Deleting an estimation needs the delete password (sent in the X-Delete-Password header)
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || 'estimation@vs2026';

// ---------- Bulk upload (Admin) ----------
// .xlsx with one estimation per row, no header needed: A = due date (mm/dd/yyyy), B = project name, C = client name.
// Unknown clients are added to the client list. Rows already in the app (same project, client and due date) are skipped.
const ExcelJS = require('exceljs');
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => d.toISOString().slice(0, 10);

function cellValue(cell) {
  const v = cell.value;
  return v && typeof v === 'object' && 'formula' in v ? v.result : v;
}
const cellText = cell => String(cell.text ?? '').trim().replace(/\s+/g, ' ');

// Due date as UTC midnight. Text is read as mm/dd/yyyy. A real date cell is used as is, unless swapDateCells:
// on a PC set to dd/mm, Excel turns a typed "11/03/2026" (meant as Nov 3) into 11 March, so day and month are swapped back.
function parseDue(cell, swapDateCells) {
  let v = cellValue(cell);
  if (typeof v === 'number' && v > 0) v = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
  let y, m, d, fromDateCell = false;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    [y, m, d, fromDateCell] = [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), true];
    if (swapDateCells && d <= 12) [m, d] = [d, m];
  } else {
    const s = String(v ?? '').trim();
    let p;
    if ((p = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/))) [m, d, y] = [+p[1], +p[2], +p[3]];
    else if ((p = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+p[1], +p[2], +p[3]];
    else return null;
    if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // e.g. 13/40/2026
  return { date, fromDateCell };
}

router.post('/bulk', requireRole('admin'), express.raw({ type: () => true, limit: '10mb' }), async (req, res, next) => {
  let streaming = false;
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received' });
    if (!(req.body[0] === 0x50 && req.body[1] === 0x4b)) return res.status(400).json({ error: 'Please upload an Excel (.xlsx) file' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.body);
    const ws = wb.worksheets.find(s => s.state !== 'hidden' && s.actualRowCount > 0);
    if (!ws) return res.status(400).json({ error: 'The file is empty' });
    const swap = req.query.swapDateCells === '1';

    // Read and check every row first
    const rows = [], errors = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const [dueCell, projCell, clientCell] = [1, 2, 3].map(i => row.getCell(i));
      const projectName = cellText(projCell), clientName = cellText(clientCell);
      if (!cellText(dueCell) && !projectName && !clientName) return;
      const due = parseDue(dueCell, swap);
      if (!due && rows.length === 0 && errors.length === 0 && /due|date|project|client/i.test(cellText(dueCell) + projectName)) return; // header row
      const problems = [!due && `due date "${cellText(dueCell)}" is not a valid mm/dd/yyyy date`,
        !projectName && 'project name is missing', !clientName && 'client name is missing'].filter(Boolean);
      if (problems.length) errors.push({ row: n, projectName, reason: problems.join('; ') });
      else rows.push({ row: n, dueDate: due.date, fromDateCell: due.fromDateCell, projectName, clientName });
    });
    if (!rows.length && !errors.length) return res.status(400).json({ error: 'No rows found in the file' });

    // From here on, progress is streamed as one JSON object per line
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    streaming = true;
    const send = o => res.write(JSON.stringify(o) + '\n');
    const total = rows.length;
    send({ type: 'start', total, invalid: errors.length });

    const clients = new Map((await Client.find().select('name nameKey').lean()).map(c => [c.nameKey, c.name]));
    const dupKey = (p, c, d) => `${nameKey(p)}|${nameKey(c)}|${ymd(d)}`;
    const days = [...new Set(rows.map(r => r.dueDate.getTime()))].map(t => new Date(t));
    const existing = new Set((await Estimation.find({ dueDate: { $in: days } }).select('projectName clientName dueDate').lean())
      .map(e => dupKey(e.projectName, e.clientName, e.dueDate)));

    const added = [], skipped = [], newClients = [];
    let lastPct = -1;
    for (let i = 0; i < total; i++) {
      const r = rows[i];
      try {
        const ck = nameKey(r.clientName);
        if (!clients.has(ck)) {
          await Client.ensure(r.clientName);
          clients.set(ck, r.clientName.replace(/\s+/g, ' '));
          newClients.push(r.clientName);
        }
        const clientName = clients.get(ck); // spelled as in the client list
        const key = dupKey(r.projectName, clientName, r.dueDate);
        if (existing.has(key)) {
          skipped.push({ row: r.row, projectName: r.projectName, reason: 'already in the app (same project, client and due date)' });
        } else {
          await Estimation.create({ projectName: r.projectName, clientName, dueDate: r.dueDate,
            createdBy: req.user.name || undefined, updatedBy: req.user.name || undefined });
          existing.add(key);
          added.push({ row: r.row, projectName: r.projectName, clientName, dueDate: ymd(r.dueDate), fromDateCell: r.fromDateCell });
        }
      } catch (err) {
        errors.push({ row: r.row, projectName: r.projectName, reason: err.message });
      }
      const pct = Math.floor(((i + 1) / total) * 100);
      if (pct !== lastPct || i === total - 1) { lastPct = pct; send({ type: 'progress', done: i + 1, total }); }
    }
    errors.sort((a, b) => a.row - b.row);
    send({ type: 'done', added, skipped, errors, newClients, swapDateCells: swap });
    res.end();
  } catch (err) {
    if (!streaming) return next(err);
    console.error(err);
    res.end(JSON.stringify({ type: 'error', error: 'Server error — some rows may have been added already' }) + '\n');
  }
});

router.post('/', async (req, res, next) => {
  try {
    checkStatusChange(req, 'Yet To Start', req.body.status);
    const doc = await Estimation.create({ ...clean(req.body), createdBy: req.user.name || undefined, updatedBy: req.user.name || undefined,
      ...(req.body.completed ? { completedBy: req.user.name || undefined } : {}) });
    await Client.ensure(doc.clientName);
    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    checkStatusChange(req, doc.status, req.body.status);
    checkLocked(doc, req.body);
    const before = notify.snapshot(doc);
    const wasCompleted = doc.completed;
    doc.set({ ...clean(req.body), ...(req.user.name ? { updatedBy: req.user.name } : {}) });
    if (doc.completed && !wasCompleted) doc.completedBy = req.user.name || undefined;
    await doc.save(); // save() so derived totals are recomputed
    await Client.ensure(doc.clientName);
    await notify.recordIfCompleted(before, doc, req.user);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// Descriptions "Auto fetch" / "Split sheets" switches: saved straight away (with that page's description lines)
// so they survive a refresh
router.put('/:id/pages/:page/auto-desc', async (req, res, next) => {
  try {
    const i = Number(req.params.page);
    const doc = await Estimation.findById(req.params.id, 'pages.name pages.autoDesc pages.splitSheets completed completedAt status jobNo projectName clientName');
    if (!doc) return res.status(404).json({ error: 'Not found' });
    checkLocked(doc, { pages: true });
    const { autoDesc, splitSheets, structDescriptions, miscDescriptions, pageName } = req.body;
    // Pages added / removed / renamed but not saved yet: the index may point at another page
    if (!Number.isInteger(i) || i < 0 || i >= doc.pages.length || (pageName !== undefined && doc.pages[i].name !== pageName)) {
      return res.status(409).json({ error: 'Page not saved yet' });
    }
    const set = { [`pages.${i}.autoDesc`]: !!autoDesc };
    if (splitSheets !== undefined) set[`pages.${i}.splitSheets`] = !!splitSheets;
    if (Array.isArray(structDescriptions)) set[`pages.${i}.structDescriptions`] = structDescriptions;
    if (Array.isArray(miscDescriptions)) set[`pages.${i}.miscDescriptions`] = miscDescriptions;
    await Estimation.updateOne({ _id: doc._id }, { $set: set }, { runValidators: true });
    if (doc.completed) {
      const yn = v => (v ? 'Yes' : 'No');
      const page = doc.pages[i];
      const changes = [];
      if (!!autoDesc !== (page.autoDesc !== false)) changes.push({ field: 'pages', label: `Descriptions auto fetch (${page.name})`, from: yn(page.autoDesc !== false), to: yn(autoDesc) });
      if (splitSheets !== undefined && !!splitSheets !== !!page.splitSheets) changes.push({ field: 'pages', label: `Descriptions split sheets (${page.name})`, from: yn(page.splitSheets), to: yn(splitSheets) });
      if (changes.length) await notify.record(doc, req.user, 'Edited after completion', changes);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireRole('team_leader'), async (req, res, next) => {
  try {
    if (req.get('X-Delete-Password') !== DELETE_PASSWORD) return res.status(403).json({ error: 'Wrong delete password' });
    const item = await Estimation.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.completed) await notify.record(item, req.user, 'Deleted');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
