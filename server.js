require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const estimationRoutes = require('./routes/estimations');
const clientRoutes = require('./routes/clients');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const logRoutes = require('./routes/logs');
const requestLog = require('./lib/requestLog');
const { authenticate, requireRole } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/estimation_manager';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 'loopback');
app.use('/api', requestLog);                   // activity log: every request except GET (user, IP, action, result)
app.use('/api/auth', authRoutes);             // login / logout / first-time setup (no sign-in needed)
// Sign-in can be switched off with AUTH_ENABLED=false in .env: everyone then works with full (admin) rights
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const openAccess = (req, res, next) => { req.user = { name: '', role: 'admin' }; next(); };
app.use('/api', AUTH_ENABLED ? authenticate : openAccess); // everything else requires a signed-in user (when enabled)
app.use('/api/estimations', estimationRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/users', requireRole('admin'), userRoutes);
app.use('/api/logs', requireRole('admin'), logRoutes);

app.use((err, req, res, next) => {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.code === 11000) {
    const msg = err.keyValue?.jobNo ? `No. "${err.keyValue.jobNo}" already exists`
      : err.keyValue?.username ? 'That username is already taken' : 'This client is already in the list';
    return res.status(409).json({ error: msg });
  }
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log(`Connected to MongoDB at ${MONGODB_URI}`);
    await require('./models/Estimation').syncIndexes(); // drop stale indexes from older schema versions
    const migrated = await require('./models/Estimation').migrateToPages();
    if (migrated) console.log(`Moved ${migrated} estimation chart(s) into pages`);
    const Client = require('./models/Client');
    await Client.syncIndexes();
    // Make sure every client used in an estimation is in the client list
    for (const name of await require('./models/Estimation').distinct('clientName')) await Client.ensure(name);
    app.listen(PORT, () => console.log(`Estimation Manager running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
