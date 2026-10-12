// Notifications for estimations that are changed after being marked Completed.
const Notification = require('../models/Notification');

const LABELS = {
  jobNo: 'No.', projectName: 'Project name', date: 'Date', doneBy: 'Done by', clientName: 'Client name',
  contactPerson: 'Contact person', contactEmail: 'Email', dueDate: 'Due date', status: 'Status', completed: 'Completed',
  notes: 'Internal notes', scope: 'Major scope items', complexity: 'Complexity', deliverables: 'Deliverables',
  coordinationNeeded: 'Coordination needed', durationWeeks: 'Project duration (weeks)', quotedTonnage: 'Estimated tonnage for client',
  assumptions: 'Assumptions', remark: 'Remark', proposalDate: 'Proposal date', quoteNo: 'Quote #',
  submittalWeeks: 'Schedule of submittals (weeks)', signerName: 'Signed by (name)', signerTitle: 'Signed by (title)',
  connectionDesign: 'Connection design', proposalExclusions: 'Proposal exclusions', links: 'SharePoint links',
  pages: 'Estimation chart / descriptions', exclusions: 'Specific exclusions',
};
// Set by the server, not by the user — never reported as a change
const IGNORE = new Set(['_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'completedAt', 'completedBy', 'wonAt',
  'totalCount', 'totalHours', 'totalDwgs', 'approxTonnage', 'sheetCount', 'pageCount']);

const snapshot = doc => JSON.parse(JSON.stringify(doc.toObject({ flattenMaps: true })));

const show = v => {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};
const isSimple = v => v === undefined || v === null || ['string', 'number', 'boolean'].includes(typeof v);
// Drop blank values ('' / null / {} / trailing blank array slots) and sort object keys, so data that only
// differs by padding (the editor adds empty Arch / Span / Weight boxes) or key order compares equal
function prune(v) {
  if (Array.isArray(v)) {
    const out = v.map(prune);
    while (out.length && out[out.length - 1] === undefined) out.pop();
    return out.length ? out : undefined;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) { const x = prune(v[k]); if (x !== undefined) out[k] = x; }
    return Object.keys(out).length ? out : undefined;
  }
  return v === '' || v === null ? undefined : v;
}
const stable = v => JSON.stringify(prune(v) ?? null);

// Fields that differ between two snapshots
function diff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];
  for (const field of keys) {
    if (IGNORE.has(field)) continue;
    const a = before[field], b = after[field];
    const same = stable(a) === stable(b) || (isSimple(a) && isSimple(b) && show(a) === show(b));
    if (same) continue;
    const change = { field, label: LABELS[field] || field };
    if (isSimple(a) && isSimple(b) && show(a).length <= 120 && show(b).length <= 120) Object.assign(change, { from: show(a), to: show(b) });
    changes.push(change);
  }
  return changes;
}

// Store one notification about a completed estimation `est`, made by `user` (their role decides who sees it)
const record = (est, user, action, changes = []) => Notification.create({
  estimation: est._id, jobNo: est.jobNo, projectName: est.projectName, clientName: est.clientName,
  completedAt: est.completedAt, action, changes, by: user?.name || '', byRole: user?.role || 'member',
});

// before: snapshot taken before the change; doc: the saved estimation. Only completed estimations notify.
async function recordIfCompleted(before, doc, user) {
  if (!before.completed) return;
  const changes = diff(before, snapshot(doc));
  if (!changes.length) return;
  await record({ ...before, _id: doc._id }, user, doc.completed ? 'Edited after completion' : 'Marked not complete', changes);
}

module.exports = { snapshot, diff, record, recordIfCompleted };
