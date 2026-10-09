const mongoose = require('mongoose');
const { MAX_SHEETS, DEFAULT_HRS_PER_TON, normalizeItems, computeEstimation } = require('../public/calc');

const STATUSES = ['Received', 'In Progress', 'Submitted', 'Won', 'Lost', 'On Hold', 'No bid placed - Less Value', 'No bid placed - Missing details'];
const COMPLEXITIES = ['', 'Low', 'Medium', 'High'];
const DELIVERABLES = ['Shop Drawings', 'Erection Drawings', 'CNC Files', 'Other files'];
// Standard exclusions printed in the Word proposal (from the proposal template)
const DEFAULT_PROPOSAL_EXCLUSIONS = ['Any structural steel not shown, sized or dimensioned on the structural / architectural drawings.', 'Joist details, deck, and foundation rebar details.', 'Engineering'];

const linkSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    url: {
      type: String, trim: true,
      validate: [v => !v || /^https?:\/\//i.test(v), 'SharePoint link must start with http:// or https://'],
    },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  { key: String, name: String, minutes: Number, divisor: Number, counts: [Number] },
  { _id: false }
);
const descSchema = new mongoose.Schema(
  {
    qty: String, description: String, notes: String, heading: { type: Boolean, default: false },
    autoKey: String, // set on lines generated from the chart (main steel), e.g. "COLUMNS|3"
  },
  { _id: false }
);
const archSchema = new mongoose.Schema({ ref: String, description: String }, { _id: false });

// One page of the estimation chart (= one worksheet in the Excel output)
const pageSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: 'Page 1' },
    sheets: {
      type: [String],
      validate: [v => v.length <= MAX_SHEETS, `Maximum ${MAX_SHEETS} sheet columns per page`],
    },
    items: [itemSchema],
    dwgOverrides: { type: Map, of: Number, default: {} },
    hoursPerTon: { type: Number, default: DEFAULT_HRS_PER_TON, min: [0.01, 'Hours per ton must be > 0'] },
    additionalHoursFor: { type: String, trim: true },
    arch: [archSchema],
    span: [String],
    weight: [String],
    structDescriptions: [descSchema],
    miscDescriptions: [descSchema],
    autoDesc: { type: Boolean, default: true }, // fill the description lines from the chart quantities
  },
  { _id: false }
);

const estimationSchema = new mongoose.Schema(
  {
    // Header
    jobNo: { type: String, required: [true, 'No. is required'], trim: true, unique: true },
    projectName: { type: String, required: [true, 'Project name is required'], trim: true },
    date: { type: Date, default: Date.now },
    doneBy: { type: String, trim: true },

    // Client / tracking details
    clientName: { type: String, required: [true, 'Client name is required'], trim: true },
    contactPerson: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    dueDate: { type: Date },
    status: { type: String, enum: STATUSES, default: 'Received' },
    wonAt: { type: Date }, // set when status becomes Won (used for awarded-per-year counts)
    completed: { type: Boolean, default: false }, // estimation work finished ("Mark Complete")
    completedAt: { type: Date },
    notes: { type: String, trim: true },
    createdBy: { type: String, trim: true },  // user names, set by the server
    updatedBy: { type: String, trim: true },

    // Submission details (used in the reply email) — no defaults, filled in per job
    scope: { type: String, trim: true },
    complexity: { type: String, enum: COMPLEXITIES },
    deliverables: { type: [String], default: () => [] },
    coordinationNeeded: { type: String, trim: true },
    durationWeeks: { type: Number, min: 0 },
    quotedTonnage: { type: Number, min: 0 }, // blank = use calculated tonnage
    assumptions: { type: String, trim: true },
    remark: { type: String, trim: true },

    // Proposal (Word) — blank values fall back to the template / today's date
    proposalDate: { type: Date },
    quoteNo: { type: String, trim: true },
    submittalWeeks: { type: Number, min: 0 },
    signerName: { type: String, trim: true },
    signerTitle: { type: String, trim: true },
    connectionDesign: { type: String, enum: ['Yes', 'No'], default: 'No' },
    proposalExclusions: { type: [String], default: () => [...DEFAULT_PROPOSAL_EXCLUSIONS] },

    // SharePoint folder links for the submission documents
    links: [linkSchema],

    // Estimation chart pages
    pages: [pageSchema],
    exclusions: { type: [String], default: () => [] },

    // Derived (stored for list / stats)
    totalCount: Number,
    totalHours: Number,
    totalDwgs: Number,
    approxTonnage: Number,
    sheetCount: Number,
    pageCount: Number,
  },
  { timestamps: true }
);

estimationSchema.pre('validate', function () {
  if (this.status === 'Won' && !this.wonAt) this.wonAt = new Date();
  if (this.status !== 'Won' && this.wonAt) this.wonAt = undefined;
  if (this.completed && !this.completedAt) this.completedAt = new Date();
  if (!this.completed && this.completedAt) this.completedAt = undefined;
  this.links = (this.links || []).filter(l => l.url || l.label);
  if (!this.pages || !this.pages.length) this.pages = [{ name: 'Page 1', sheets: [] }];
  const isBlank = d => !String(d.qty ?? '').trim() && !String(d.description ?? '').trim() && !String(d.notes ?? '').trim();
  this.pages.forEach((p, i) => {
    if (!p.name) p.name = `Page ${i + 1}`;
    p.items = normalizeItems(p.items, p.sheets.length);
    // Drop empty rows at the end of the description lists (the editor shows spare blank rows)
    for (const key of ['structDescriptions', 'miscDescriptions']) {
      const list = p[key] || [];
      let end = list.length;
      while (end > 0 && isBlank(list[end - 1])) end--;
      if (end < list.length) p[key] = list.slice(0, end);
    }
  });
  const c = computeEstimation({
    pages: this.pages.map(p => ({ ...p.toObject(), dwgOverrides: Object.fromEntries(p.dwgOverrides || []) })),
  });
  this.totalCount = c.totalCount;
  this.totalHours = Math.round(c.totalHours * 100) / 100;
  this.totalDwgs = Math.round(c.totalDwgs * 100) / 100;
  this.approxTonnage = Math.round(c.tonnage * 100) / 100;
  this.sheetCount = c.sheetCount;
  this.pageCount = c.pageCount;
});

// One-time migration: older estimations stored a single chart at the top level -> move it into pages[0]
estimationSchema.statics.migrateToPages = async function () {
  const coll = this.collection;
  const old = await coll.find({ pages: { $exists: false } }).toArray();
  for (const d of old) {
    const page = {
      name: 'Page 1', sheets: d.sheets || [], items: d.items || [], dwgOverrides: d.dwgOverrides || {},
      hoursPerTon: d.hoursPerTon || DEFAULT_HRS_PER_TON, additionalHoursFor: d.additionalHoursFor || '',
      arch: d.arch || [], span: d.span || [], weight: d.weight || [],
    };
    await coll.updateOne({ _id: d._id }, {
      $set: { pages: [page] },
      $unset: { sheets: '', items: '', dwgOverrides: '', hoursPerTon: '', additionalHoursFor: '', arch: '', span: '', weight: '' },
    });
  }
  // Descriptions used to be one list per estimation -> move them into the first page
  const withDesc = await coll.find({ $or: [{ structDescriptions: { $exists: true } }, { miscDescriptions: { $exists: true } }] }).toArray();
  for (const d of withDesc) {
    const set = {};
    if ((d.structDescriptions || []).length && !(d.pages?.[0]?.structDescriptions || []).length) set['pages.0.structDescriptions'] = d.structDescriptions;
    if ((d.miscDescriptions || []).length && !(d.pages?.[0]?.miscDescriptions || []).length) set['pages.0.miscDescriptions'] = d.miscDescriptions;
    await coll.updateOne({ _id: d._id }, { ...(Object.keys(set).length ? { $set: set } : {}), $unset: { structDescriptions: '', miscDescriptions: '' } });
  }
  if (withDesc.length) console.log(`Moved descriptions of ${withDesc.length} estimation(s) into Page 1`);

  // Recompute derived totals (sheetCount / pageCount). Old records may miss fields that are required today
  // (e.g. No.), so only validate what changes, and never let one bad record stop the server from starting.
  for (const doc of await this.find({ sheetCount: { $exists: false } })) {
    try { await doc.save({ validateModifiedOnly: true }); }
    catch (err) { console.warn(`Could not recompute totals for estimation ${doc._id}: ${err.message}`); }
  }
  return old.length;
};

module.exports = mongoose.model('Estimation', estimationSchema);
module.exports.STATUSES = STATUSES;
module.exports.DELIVERABLES = DELIVERABLES;
