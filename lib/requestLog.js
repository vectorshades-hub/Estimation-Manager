// Records every API request except GET (who, from which IP, what, and whether it worked) in the Log collection.
const Log = require('../models/Log');
const Estimation = require('../models/Estimation');
const Client = require('../models/Client');
const User = require('../models/User');

const SECRET = /password|confirm|token/i;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clientIp = req => String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

// Readable action for a request, e.g. PUT /api/estimations/<id> -> "Updated estimation"
function describe(method, path, body = {}) {
  const [, , area, id, sub] = path.split('/'); // ['', 'api', area, id, sub]
  const verb = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] || method;
  if (area === 'auth') {
    return { login: 'Sign in', logout: 'Signed out', setup: 'First-time setup (Admin created)', 'change-password': 'Changed own password' }[id] || `Auth: ${id}`;
  }
  if (area === 'estimations') {
    if (sub === 'pages') return 'Changed auto-fetch descriptions';
    if (method === 'PUT' && !body.pages) {
      if ('completed' in body) return body.completed ? 'Marked complete' : 'Marked not complete';
      if (body.status === 'Won') return 'Marked Won';
      if ('connectionDesign' in body) return `Set connection design to ${body.connectionDesign}`;
    }
    return `${verb} estimation`;
  }
  if (area === 'clients') return id === 'import' ? 'Imported clients' : `${verb} client`;
  if (area === 'users') {
    if (method === 'PUT' && body.password) return 'Reset user password';
    return `${verb} user`;
  }
  return `${method} ${path}`;
}

// Which fields were sent (values for short simple fields; passwords never stored)
function summarize(body) {
  if (Buffer.isBuffer(body)) return 'File upload';
  if (!body || typeof body !== 'object') return '';
  if (body.pages) return 'Saved full estimation';
  const parts = [];
  for (const [k, v] of Object.entries(body)) {
    if (SECRET.test(k)) { if (v) parts.push(`${k}: ••••`); continue; }
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) parts.push(`${k}: ${clip(String(v ?? ''), 60)}`);
    else parts.push(k);
  }
  return clip(parts.join(', '), 400);
}

// The record a request acts on, looked up before the request runs (so it still works after a delete)
async function findTarget(path, body = {}) {
  const [, , area, id] = path.split('/');
  const isId = /^[0-9a-f]{24}$/i.test(id || '');
  if (area === 'estimations') {
    const e = isId ? await Estimation.findById(id, 'jobNo projectName').lean() : body;
    return e ? [e.jobNo, e.projectName].filter(Boolean).join(' ') : '';
  }
  if (area === 'clients') {
    const c = isId ? await Client.findById(id, 'name').lean() : body;
    return c?.name || '';
  }
  if (area === 'users') {
    const u = isId ? await User.findById(id, 'name username').lean() : body;
    return u ? [u.name, u.username && `(${u.username})`].filter(Boolean).join(' ') : '';
  }
  if (area === 'auth' && id === 'login') return String(body.username || '').trim().toLowerCase();
  return '';
}

async function requestLog(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const started = Date.now();
  const path = req.originalUrl.split('?')[0];
  // Body is parsed by express.json() before this runs (file imports arrive later as raw data)
  const jsonBody = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  let target = '';
  try { target = await findTarget(path, jsonBody); } catch { /* unknown id etc. */ }

  // Capture the error message the route sends back
  let errorMsg = '';
  const json = res.json.bind(res);
  res.json = data => { if (res.statusCode >= 400 && data?.error) errorMsg = String(data.error); return json(data); };

  res.on('finish', async () => {
    try {
      const body = req.body;
      const u = req.user || {};
      const failedLogin = path === '/api/auth/login' && res.statusCode >= 400;
      await Log.create({
        user: u.name || '',
        username: u.username || (path === '/api/auth/login' ? String(body?.username || '').trim().toLowerCase() : ''),
        role: u.role || '',
        ip: clientIp(req),
        method: req.method,
        path,
        action: failedLogin ? 'Failed sign-in' : describe(req.method, path, body && !Buffer.isBuffer(body) ? body : {}),
        target: clip(String(target || ''), 200),
        details: summarize(body),
        status: res.statusCode,
        ok: res.statusCode < 400,
        error: clip(errorMsg, 300),
        ms: Date.now() - started,
      });
    } catch (err) {
      console.error('Could not write log entry:', err.message);
    }
  });

  next();
}

module.exports = requestLog;
