const mongoose = require('mongoose');

// Activity log: one entry per change request (everything except GET). MongoDB removes entries after LOG_DAYS (TTL index).
const LOG_DAYS = Number(process.env.LOG_DAYS) || 365;

const logSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: { expires: LOG_DAYS * 24 * 3600 } },
  user: { type: String, trim: true },      // display name
  username: { type: String, trim: true },
  role: { type: String },
  ip: { type: String },
  method: { type: String },
  path: { type: String },
  action: { type: String },                // readable summary, e.g. "Updated estimation"
  target: { type: String },                // e.g. "26-007 Project name"
  details: { type: String },               // which fields were sent (never passwords)
  status: { type: Number },
  ok: { type: Boolean },
  error: { type: String },
  ms: { type: Number },
});
logSchema.index({ at: -1 });

module.exports = mongoose.model('Log', logSchema);
