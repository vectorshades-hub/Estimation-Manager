const mongoose = require('mongoose');
const { MAX_SHEETS, DEFAULT_HRS_PER_TON, normalizeItems, compute } = require('../public/calc');

const STATUSES = ['Received', 'In Progress', 'Submitted', 'Won', 'Lost', 'On Hold'];
const COMPLEXITIES = ['Low', 'Medium', 'High'];
const DELIVERABLES = ['Shop Drawings', 'Erection Drawings', 'CNC Files', 'Other files'];
const DEFAULT_EXCLUSIONS = ['Design calculations', 'connection design (unless specified)'];

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
  { qty: String, description: String, notes: String, heading: { type: Boolean, default: false } },
  { _id: false }
);
const archSchema = new mongoose.Schema({ ref: String, description: String }, { _id: false });

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
    notes: { type: String, trim: true },

    // Submission details (used in the reply email)
    scope: { type: String, trim: true, default: 'Mainsteel and Misc' },
    complexity: { type: String, enum: COMPLEXITIES, default: 'Medium' },
    deliverables: { type: [String], default: () => [...DELIVERABLES] },
    coordinationNeeded: { type: String, trim: true },
    durationWeeks: { type: Number, min: 0 },
    quotedTonnage: { type: Number, min: 0 }, // blank = use calculated tonnage
    assumptions: { type: String, trim: true, default: 'Steel design completed by client' },
    remark: { type: String, trim: true, default: 'Nil' },

    // SharePoint folder links for the submission documents
    links: [linkSchema],

    // Estimation chart
    sheets: {
      type: [String],
      validate: [v => v.length <= MAX_SHEETS, `Maximum ${MAX_SHEETS} sheet columns`],
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
    exclusions: { type: [String], default: () => [...DEFAULT_EXCLUSIONS] },

    // Derived (stored for list / stats)
    totalCount: Number,
    totalHours: Number,
    totalDwgs: Number,
    approxTonnage: Number,
  },
  { timestamps: true }
);

estimationSchema.pre('validate', function () {
  this.links = (this.links || []).filter(l => l.url || l.label);
  this.items = normalizeItems(this.items, this.sheets.length);
  const c = compute({
    sheets: this.sheets,
    items: this.items,
    dwgOverrides: Object.fromEntries(this.dwgOverrides || []),
    hoursPerTon: this.hoursPerTon,
  });
  this.totalCount = c.totalCount;
  this.totalHours = Math.round(c.totalHours * 100) / 100;
  this.totalDwgs = Math.round(c.totalDwgs * 100) / 100;
  this.approxTonnage = Math.round(c.tonnage * 100) / 100;
});

module.exports = mongoose.model('Estimation', estimationSchema);
module.exports.STATUSES = STATUSES;
module.exports.DELIVERABLES = DELIVERABLES;
