const mongoose = require('mongoose');

// Roles from lowest to highest — each role can do everything the roles before it can
const ROLES = ['member', 'team_leader', 'manager', 'admin'];
const ROLE_LABELS = { member: 'Member', team_leader: 'Team Leader', manager: 'Manager', admin: 'Admin' };

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String, required: [true, 'Email is required'], trim: true, lowercase: true, unique: true,
      // Checked only when set / changed, so accounts migrated from a username still save (e.g. last sign-in)
      validate: [function (v) { return !(this.isNew || this.isModified('email')) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); },
        'Enter a valid email address'],
    },
    name: { type: String, required: [true, 'Name is required'], trim: true },
    role: { type: String, enum: ROLES, default: 'member' },
    passwordHash: { type: String, required: true },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  return {
    _id: this._id, email: this.email, name: this.name, role: this.role,
    roleLabel: ROLE_LABELS[this.role], active: this.active, lastLogin: this.lastLogin, createdAt: this.createdAt,
  };
};

// One-time migration: accounts used to sign in with a username -> it becomes their sign-in email
// (an Admin can then change it to the real address on the Users page)
userSchema.statics.migrateToEmail = async function () {
  const coll = this.collection;
  const old = await coll.find({ email: { $exists: false }, username: { $exists: true } }).toArray();
  for (const u of old) await coll.updateOne({ _id: u._id }, { $set: { email: u.username }, $unset: { username: '' } });
  if (await coll.indexExists('username_1').catch(() => false)) await coll.dropIndex('username_1');
  return old.length;
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.ROLE_LABELS = ROLE_LABELS;
