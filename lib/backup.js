// Database backups: one gzipped JSON file per backup (Extended JSON, so ids and dates restore exactly).
// - Automatic backup every Sunday at 06:00 (server time); a missed run (server was off) is made up at start-up.
// - Hourly backup of the estimations only (on the hour), kept for HOURLY_KEEP_DAYS days.
// - Manual backups and restores from the Backups page (Admin).
// - Before every restore a "pre-restore" backup of the current data is made, so a restore can be undone.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups', 'db'));
const KEEP_AUTO = Math.max(1, Number(process.env.BACKUP_KEEP) || 12); // automatic backups kept (older ones are deleted)
const SCHEDULE = { weekday: 0, hour: 6 };                             // Sunday 06:00
const HOURLY_KEEP_DAYS = 10;
const HOUR = 3600 * 1000;
const APP = 'estimation-manager';

// Saved and restored. Sessions are not (everyone stays signed in); the activity log is saved but never
// overwritten by a restore, so the record of who restored what is kept.
const COLLECTIONS = ['estimations', 'clients', 'users', 'notifications', 'logs'];
const RESTORED = ['estimations', 'clients', 'users', 'notifications'];

const TYPES = ['auto', 'hourly', 'manual', 'pre-restore', 'uploaded'];
const NAME_RX = /^backup-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})-(auto|hourly|manual|pre-restore|uploaded)\.json\.gz$/;
// Hourly backups hold the estimations only
const collectionsFor = type => (type === 'hourly' ? ['estimations'] : COLLECTIONS);

let busy = null; // one backup / restore at a time
async function exclusive(what, fn) {
  if (busy) throw Object.assign(new Error(`Please wait — a ${busy} is already running`), { status: 409 });
  busy = what;
  try { return await fn(); } finally { busy = null; }
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function fileFor(type) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let name = `backup-${stamp(new Date())}-${type}.json.gz`;
  for (let s = 1; fs.existsSync(path.join(BACKUP_DIR, name)); s++) { // two in the same second
    const d = new Date(Date.now() + s * 1000);
    name = `backup-${stamp(d)}-${type}.json.gz`;
  }
  return name;
}

// Only plain backup file names from the list (never a path)
function backupPath(name) {
  if (!NAME_RX.test(String(name || ''))) throw Object.assign(new Error('Unknown backup'), { status: 404 });
  const p = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(p)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  return p;
}

async function dump(type, by) {
  const db = mongoose.connection.db;
  const data = { app: APP, version: 1, type, createdAt: new Date(), createdBy: by || '', counts: {}, collections: {} };
  for (const c of collectionsFor(type)) {
    data.collections[c] = await db.collection(c).find({}).toArray();
    data.counts[c] = data.collections[c].length;
  }
  const name = fileFor(type);
  const gz = zlib.gzipSync(Buffer.from(EJSON.stringify(data, { relaxed: false })));
  fs.writeFileSync(path.join(BACKUP_DIR, name), gz);
  if (type === 'auto' || type === 'hourly') prune();
  return { name, counts: data.counts, size: gz.length };
}

const createBackup = (type, by) => exclusive('backup', () => dump(type, by));

// Delete the oldest automatic backups beyond KEEP_AUTO and hourly ones older than HOURLY_KEEP_DAYS
// (manual ones are only deleted by hand)
function prune() {
  const all = listBackups();
  const cutoff = Date.now() - HOURLY_KEEP_DAYS * 24 * HOUR;
  const old = [...all.filter(b => b.type === 'auto').slice(KEEP_AUTO), ...all.filter(b => b.type === 'hourly' && b.createdAt < cutoff)];
  for (const b of old) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* already gone */ }
  }
}

// Newest first
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .map(name => {
      const m = name.match(NAME_RX);
      if (!m) return null;
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      const [, day, hh, mm, ss, type] = m;
      return { name, type, createdAt: new Date(`${day}T${hh}:${mm}:${ss}`), size: st.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

// Read and check a backup before anything is changed
function parseBackup(buf) {
  let data;
  try {
    const raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf; // .json.gz or plain .json
    data = EJSON.parse(raw.toString('utf8'), { relaxed: false });
  } catch {
    throw Object.assign(new Error('This is not a valid backup file'), { status: 400 });
  }
  if (data?.app !== APP || !data.collections || typeof data.collections !== 'object') {
    throw Object.assign(new Error('This file is not an Estimation Manager backup'), { status: 400 });
  }
  // An hourly backup has the estimations only: restoring it replaces just the estimations
  for (const c of data.type === 'hourly' ? ['estimations'] : RESTORED) {
    if (!Array.isArray(data.collections[c])) throw Object.assign(new Error(`The backup has no "${c}" data`), { status: 400 });
  }
  if (data.collections.users && !data.collections.users.some(u => u.role === 'admin' && u.active !== false)) {
    throw Object.assign(new Error('The backup has no active Admin user — restoring it would lock everyone out'), { status: 400 });
  }
  return data;
}

// Replace the data with the backup's. Makes a pre-restore backup first.
async function restore(buf, by) {
  const data = parseBackup(buf);
  return exclusive('restore', async () => {
    const safety = await dump('pre-restore', by);
    const db = mongoose.connection.db;
    const counts = {};
    for (const c of RESTORED.filter(c => Array.isArray(data.collections[c]))) {
      const docs = data.collections[c];
      await db.collection(c).deleteMany({});
      if (docs.length) await db.collection(c).insertMany(docs, { ordered: false });
      counts[c] = docs.length;
    }
    // Sessions of users that no longer exist (or are inactive) after the restore are ended
    const activeIds = (await db.collection('users').find({ active: { $ne: false } }, { projection: { _id: 1 } }).toArray()).map(u => u._id);
    await db.collection('sessions').deleteMany({ user: { $nin: activeIds } });
    return { counts, backupOf: data.createdAt, safetyBackup: safety.name };
  });
}

function deleteBackup(name) {
  fs.unlinkSync(backupPath(name));
}

// Keep an uploaded backup in the list too, so it can be restored again later
function saveUploaded(buf) {
  const data = parseBackup(buf);
  const name = fileFor('uploaded');
  fs.writeFileSync(path.join(BACKUP_DIR, name), buf[0] === 0x1f && buf[1] === 0x8b ? buf : zlib.gzipSync(buf));
  return { name, data };
}

// ---------- Weekly schedule ----------
// The latest scheduled time at or before `from`, and the next one after it
function lastScheduled(from = new Date()) {
  const d = new Date(from);
  d.setHours(SCHEDULE.hour, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - SCHEDULE.weekday + 7) % 7));
  if (d > from) d.setDate(d.getDate() - 7);
  return d;
}
const nextScheduled = (from = new Date()) => { const d = lastScheduled(from); d.setDate(d.getDate() + 7); return d; };

let timer = null, lastAutoError = null;
async function runAuto() {
  const Log = require('../models/Log');
  try {
    const r = await createBackup('auto', 'Automatic');
    lastAutoError = null;
    console.log(`Automatic backup saved: ${r.name}`);
    await Log.create({ user: 'System', action: 'Automatic backup', target: r.name, details: summary(r.counts), status: 200, ok: true }).catch(() => {});
  } catch (err) {
    lastAutoError = { at: new Date(), message: err.message };
    console.error('Automatic backup failed:', err.message);
    await Log.create({ user: 'System', action: 'Automatic backup', status: 500, ok: false, error: err.message }).catch(() => {});
  }
}

function scheduleNext() {
  clearTimeout(timer);
  const wait = Math.max(1000, nextScheduled() - Date.now());
  timer = setTimeout(async () => { await runAuto(); scheduleNext(); }, wait);
  timer.unref?.();
}

// ---------- Hourly estimations backup ----------
const lastHour = (from = new Date()) => { const d = new Date(from); d.setMinutes(0, 0, 0); return d; };
const nextHour = (from = new Date()) => new Date(lastHour(from).getTime() + HOUR);

let hourlyTimer = null, lastHourlyError = null;
async function runHourly(retry = true) {
  try {
    const r = await createBackup('hourly', 'Hourly');
    lastHourlyError = null;
    console.log(`Hourly backup saved: ${r.name}`);
  } catch (err) {
    // Another backup / restore is running: try again in a minute (once)
    if (err.status === 409 && retry) return void setTimeout(() => runHourly(false), 60 * 1000).unref?.();
    lastHourlyError = { at: new Date(), message: err.message };
    console.error('Hourly backup failed:', err.message);
    await require('../models/Log').create({ user: 'System', action: 'Hourly backup', status: 500, ok: false, error: err.message }).catch(() => {});
  }
}

function scheduleNextHour() {
  clearTimeout(hourlyTimer);
  hourlyTimer = setTimeout(async () => { await runHourly(); scheduleNextHour(); }, Math.max(1000, nextHour() - Date.now()));
  hourlyTimer.unref?.();
}

// Called once the database is connected
async function startSchedule() {
  const latest = listBackups().find(b => b.type === 'auto');
  if (!latest || latest.createdAt < lastScheduled()) await runAuto(); // missed while the server was off
  scheduleNext();
  const latestHourly = listBackups().find(b => b.type === 'hourly');
  if (!latestHourly || latestHourly.createdAt < lastHour()) await runHourly();
  scheduleNextHour();
}

const summary = counts => Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ');

function status() {
  return {
    dir: BACKUP_DIR, keepAuto: KEEP_AUTO, schedule: 'Every Sunday at 6:00 AM (server time)',
    nextRun: nextScheduled(), lastAutoError, busy,
    hourlyKeepDays: HOURLY_KEEP_DAYS, nextHourly: nextHour(), lastHourlyError,
  };
}

module.exports = {
  TYPES, createBackup, listBackups, backupPath, deleteBackup, restore, saveUploaded, startSchedule, status, summary,
};
