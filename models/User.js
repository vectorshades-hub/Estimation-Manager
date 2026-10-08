const mongoose = require('mongoose');

// Roles from lowest to highest — each role can do everything the roles before it can
const ROLES = ['member', 'team_leader', 'manager', 'admin'];
const ROLE_LABELS = { member: 'Member', team_leader: 'Team Leader', manager: 'Manager', admin: 'Admin' };

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String, required: [true, 'Username is required'], trim: true, lowercase: true, unique: true,
      match: [/^[a-z0-9._-]{3,30}$/, 'Username: 3-30 characters, letters / numbers / . _ - only'],
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
    _id: this._id, username: this.username, name: this.name, role: this.role,
    roleLabel: ROLE_LABELS[this.role], active: this.active, lastLogin: this.lastLogin, createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.ROLE_LABELS = ROLE_LABELS;
