const mongoose = require('mongoose');
const { ROLES } = require('./User');

// Raised when an estimation that is marked Completed gets changed (edit, status, un-completing…)
const changeSchema = new mongoose.Schema(
  { field: String, label: String, from: String, to: String }, // from / to only for short simple values
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    estimation: { type: mongoose.Schema.Types.ObjectId, ref: 'Estimation', index: true },
    jobNo: { type: String, trim: true },        // copied so the entry still reads well after a delete
    projectName: { type: String, trim: true },
    clientName: { type: String, trim: true },
    completedAt: { type: Date },                // when it had been marked complete
    action: { type: String },                   // e.g. "Edited after completion", "Marked not complete"
    changes: [changeSchema],
    by: { type: String, trim: true },           // user name ('' when sign-in is off)
    byRole: { type: String },                   // role of that user: decides who sees it (see visibleTo)
    readBy: { type: [String], default: () => [] }, // ids of the users who marked it read
  },
  { timestamps: true }
);
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ byRole: 1, createdAt: -1 });

// Who sees a change: the roles above the person who made it (Member -> Team Leader and up,
// Team Leader -> Manager and up, Manager -> Admin). Admins see everything, including other Admins' changes.
notificationSchema.statics.visibleTo = function (user) {
  if (user.role === 'admin') return {};
  return { byRole: { $in: ROLES.slice(0, Math.max(0, ROLES.indexOf(user.role))) } };
};

// Key used in readBy ('open' when sign-in is switched off and there are no user accounts)
notificationSchema.statics.readerKey = user => String(user._id || 'open');

module.exports = mongoose.model('Notification', notificationSchema);
