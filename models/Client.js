const mongoose = require('mongoose');

const nameKey = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

const clientSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Client name is required'], trim: true },
    nameKey: { type: String, unique: true }, // case/space-insensitive key used for matching
    priority: { type: Boolean, default: false },
  },
  { timestamps: true }
);

clientSchema.pre('validate', function () {
  this.name = String(this.name || '').trim().replace(/\s+/g, ' ');
  this.nameKey = nameKey(this.name);
});

// Add a client if it isn't known yet (never changes priority of an existing one)
clientSchema.statics.ensure = async function (name) {
  const key = nameKey(name);
  if (!key) return;
  await this.updateOne(
    { nameKey: key },
    { $setOnInsert: { name: String(name).trim().replace(/\s+/g, ' '), nameKey: key, priority: false } },
    { upsert: true }
  );
};

// Set of normalized names of priority clients
clientSchema.statics.priorityKeys = async function () {
  const list = await this.find({ priority: true }).select('nameKey').lean();
  return new Set(list.map(c => c.nameKey));
};

module.exports = mongoose.model('Client', clientSchema);
module.exports.nameKey = nameKey;
