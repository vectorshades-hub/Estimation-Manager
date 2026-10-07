require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const estimationRoutes = require('./routes/estimations');
const clientRoutes = require('./routes/clients');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/estimation_manager';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/estimations', estimationRoutes);
app.use('/api/clients', clientRoutes);

app.use((err, req, res, next) => {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
  }
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.code === 11000) {
    const msg = err.keyValue?.jobNo ? `No. "${err.keyValue.jobNo}" already exists` : 'This client is already in the list';
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
