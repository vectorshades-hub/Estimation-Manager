const mongoose = require('mongoose');

// Login sessions. Only a SHA-256 of the cookie token is stored; MongoDB removes expired sessions (TTL index).
const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = mongoose.model('Session', sessionSchema);
