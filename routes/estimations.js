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

const router = express.Router();

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_FIELDS = 'jobNo projectName clientName date doneBy dueDate status links sheets totalCount totalHours totalDwgs approxTonnage createdAt';

// Shared by the list and the Excel export.
// Query: q (search), status, value ('less' | 'priority'), from / to (estimation date, yyyy-mm-dd)
async function findFiltered(query, fields) {
  const { q, status, value, from, to } = query;
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ jobNo: rx }, { projectName: rx }, { clientName: rx }, { doneBy: rx }, { scope: rx }];
  }
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (isDate(from) || isDate(to)) {
    filter.date = {};
    if (isDate(from)) filter.date.$gte = new Date(`${from}T00:00:00.000Z`);
    if (isDate(to)) filter.date.$lte = new Date(`${to}T23:59:59.999Z`);
  }
  let items = await withFlags(await Estimation.find(filter).select(fields).sort('-createdAt'));
  if (value === 'less') items = items.filter(e => e.lessValue);
  if (value === 'priority') items = items.filter(e => e.priorityClient);
  return items;
}

function describeFilters({ q, status, value, from, to }) {
  return [
    q && `Search: "${q}"`,
    status && `Status: ${status}`,
    value === 'less' && 'Less value jobs only',
    value === 'priority' && 'Priority clients only',
    from && `Date from: ${from}`,
    to && `Date to: ${to}`,
  ].filter(Boolean).join(';  ');
}

// List with optional filters
router.get('/', async (req, res, next) => {
  try {
    res.json(await findFiltered(req.query, LIST_FIELDS));
  } catch (err) {
    next(err);
  }
});

// Export the (filtered) list to Excel
router.get('/export', async (req, res, next) => {
  try {
    const items = await findFiltered(req.query, '-items -arch -span -weight -structDescriptions -miscDescriptions -dwgOverrides');
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

router.get('/:id', async (req, res, next) => {
  try {
    const item = await Estimation.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// Download the estimation chart as .xlsx
router.get('/:id/excel', async (req, res, next) => {
  try {
    const doc = await Estimation.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const est = doc.toObject({ flattenMaps: true });
    const wb = await buildWorkbook(est);
    const name = `${[est.jobNo, est.projectName].filter(Boolean).join(' ')}_output.xlsx`.replace(/[\\/:*?"<>|]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

const clean = ({ _id, createdAt, updatedAt, totalCount, totalHours, totalDwgs, approxTonnage, __v, ...data }) => data;

router.post('/', async (req, res, next) => {
  try {
    const doc = await Estimation.create(clean(req.body));
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
    doc.set(clean(req.body));
    await doc.save(); // save() so derived totals are recomputed
    await Client.ensure(doc.clientName);
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const item = await Estimation.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
