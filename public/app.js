const API = '/api/estimations';
const STATUSES = ['Yet To Start','In Progress', 'Submitted', 'Won', 'Lost', 'On Hold', 'No bid placed - Less Value', 'No bid placed - Missing details'];
// CSS class for a status badge, e.g. 'In Progress' -> 'In-Progress', 'No bid placed - Less Value' -> 'No-bid-placed-Less-Value'
const statusClass = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '-');
const { MAX_SHEETS, DEFAULT_HRS_PER_TON, LESS_VALUE_HOURS, isLessValueJob, ITEM_TEMPLATE, DWG_TYPES, normalizeItems, compute,
  newPage, normalizePage, computeEstimation } = window.EstCalc;
const CLIENTS_API = '/api/clients';
const nameKey = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const LV_TITLE = `Client is not a priority client and total hours are less than ${LESS_VALUE_HOURS}`;

const $ = sel => document.querySelector(sel);
const form = $('#form');

const fmt = (n, d = 2) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
const fmtDate = d => (d ? new Date(d).toLocaleDateString(undefined, { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const toInputDate = d => (d ? new Date(d).toISOString().slice(0, 10) : '');
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const CLOSED = ['Submitted', 'Won', 'Lost', 'No bid placed - Less Value', 'No bid placed - Missing details'];

// Days from today until the due date: { text, cls } or null when there is no due date.
// Closed estimations (Submitted / Won / Lost) are shown in neutral grey.
function dueInfo(dueDate, status, completed = false) {
  if (!dueDate) return null;
  const [y, m, d] = toInputDate(dueDate).split('-').map(Number);
  const [ty, tm, td] = today().split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  const closed = completed || CLOSED.includes(status);
  if (days < 0) return { days, text: `${-days} day${days === -1 ? '' : 's'} overdue`, cls: closed ? 'due-closed' : 'due-over' };
  if (days === 0) return { days, text: 'Due today', cls: closed ? 'due-closed' : 'due-soon' };
  return { days, text: `${days} day${days === 1 ? '' : 's'} left`, cls: closed ? 'due-closed' : days <= 3 ? 'due-soon' : 'due-ok' };
}
// "26-008 Project name", or just the project name when there is no No.
const estLabel = e => [e.jobNo, e.projectName].filter(Boolean).join(' ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    dirty = false;
    showAuth();
    throw Object.assign(new Error(data.error || 'Please sign in'), { silent: true });
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// =====================================================================
// SIGN-IN, ROLES
// =====================================================================
const ROLE_ORDER = ['member', 'team_leader', 'manager', 'admin'];
const ROLE_NAMES = { member: 'Member', team_leader: 'Team Leader', manager: 'Manager', admin: 'Admin' };
let me = null; // signed-in user

const can = minRole => !!me && ROLE_ORDER.indexOf(me.role) >= ROLE_ORDER.indexOf(minRole);

// Hide anything marked data-min-role="..." that the current user can't use
function applyRoleVisibility() {
  document.querySelectorAll('[data-min-role]').forEach(el => { el.hidden = !can(el.dataset.minRole); });
}

function showAuth(setupNeeded = false) {
  me = null;
  document.body.classList.add('signed-out');
  $('#authView').hidden = false;
  $('#loginForm').hidden = setupNeeded;
  $('#setupForm').hidden = !setupNeeded;
  (setupNeeded ? $('#setupForm [name=name]') : $('#loginForm [name=email]')).focus();
}

function signedIn(user) {
  me = user;
  document.body.classList.remove('signed-out');
  $('#authView').hidden = true;
  $('#userName').textContent = user.name;
  $('#userRole').textContent = ROLE_NAMES[user.role] || user.role;
  applyRoleVisibility();
  route();
  refreshNotifCount();
}

async function boot() {
  try {
    const status = await api('/api/auth/status');
    // Sign-in switched off (AUTH_ENABLED=false): full access, no user menu
    document.body.classList.toggle('auth-off', !status.authEnabled);
    if (!status.authEnabled) return signedIn({ name: '', role: 'admin' });
    if (status.setupNeeded) return showAuth(true);
    const res = await fetch('/api/auth/me');
    if (!res.ok) return showAuth(false);
    signedIn(await res.json());
  } catch (err) {
    alert('Cannot reach the server: ' + err.message);
  }
}

const formData = f => Object.fromEntries(new FormData(f).entries());
function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

$('#loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  showError($('#loginError'), '');
  try {
    const user = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData(ev.target)) });
    ev.target.reset();
    signedIn(user);
  } catch (err) { showError($('#loginError'), err.message); }
});

$('#setupForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const data = formData(ev.target);
  if (data.password !== data.confirm) return showError($('#setupError'), 'Passwords do not match');
  try {
    const user = await api('/api/auth/setup', { method: 'POST', body: JSON.stringify(data) });
    ev.target.reset();
    signedIn(user);
  } catch (err) { showError($('#setupError'), err.message); }
});

$('#userBtn').onclick = ev => { ev.stopPropagation(); $('#userDropdown').hidden = !$('#userDropdown').hidden; };
document.addEventListener('click', () => { $('#userDropdown').hidden = true; });
$('#logoutBtn').onclick = async () => {
  if (dirty && !confirm('You have unsaved changes. Sign out anyway?')) return;
  dirty = false;
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  // Start the next sign-in on the Estimations list, not on the page this user was last on
  history.replaceState(null, '', '/');
  lastPath = location.pathname;
  showAuth(false);
};

// Change own password, or (admin) reset another user's password
let pwTarget = null;
function openPasswordDialog(user = null) {
  pwTarget = user;
  $('#pwForm').reset();
  showError($('#pwError'), '');
  $('#pwTitle').textContent = user ? `Reset password — ${user.name}` : 'Change password';
  $('#pwCurrentWrap').hidden = !!user;
  $('#pwForm [name=currentPassword]').required = !user;
  $('#pwDialog').showModal();
}
$('#changePwBtn').onclick = () => openPasswordDialog();
$('#pwClose').onclick = () => $('#pwDialog').close();
$('#pwForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const d = formData(ev.target);
  if (d.newPassword !== d.confirm) return showError($('#pwError'), 'Passwords do not match');
  try {
    if (pwTarget) await api(`/api/users/${pwTarget._id}`, { method: 'PUT', body: JSON.stringify({ password: d.newPassword }) });
    else await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify(d) });
    $('#pwDialog').close();
    alert(pwTarget ? `Password reset for ${pwTarget.name}. They will need to sign in again.` : 'Your password has been changed.');
  } catch (err) { showError($('#pwError'), err.message); }
});

// =====================================================================
// LIST VIEW
// =====================================================================
// Due date quick filter: any of -1 yesterday, 0 today, 1 tomorrow (none selected = off)
const dueOffsets = new Set();
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Current list filters as query parameters (used by both the list and the Excel export)
function listParams() {
  const params = new URLSearchParams();
  const set = (k, v) => { if (v) params.set(k, v); };
  set('q', $('#search').value.trim());
  set('status', $('#statusFilter').value);
  set('value', $('#valueFilter').value);
  set('due', [...dueOffsets].sort().map(n => addDays(today(), n)).join(','));
  set('from', $('#fromDate').value);
  set('to', $('#toDate').value);
  return params;
}

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

// Status as a drop-down styled like the status badge: change it right from the list.
// The last option, "Completed" (shown as "Sent for Bid"), marks the estimation complete; on a completed one, picking a status un-completes it.
// Won / Lost can only be set or cleared by Team Leaders and above (the server checks this too).
const DECIDED = ['Won', 'Lost'];
const COMPLETED_OPT = 'Completed';
// Sent for Bid (completed) or Submitted: locked — nothing can be changed until the status is changed (the server checks too)
const isLocked = e => !!e.completed || e.status === 'Submitted';
const LOCK_TIP = 'Sent for Bid / Submitted — change the status to make changes';
function statusSelect(e) {
  const lead = can('team_leader');
  const shown = e.completed ? COMPLETED_OPT : e.status;
  // Members can't move an estimation into or out of Won / Lost
  const blocked = s => !lead && s !== e.status && (DECIDED.includes(s) || DECIDED.includes(e.status));
  return `<select class="badge status-select ${statusClass(shown)}" data-status-id="${e._id}" data-orig="${esc(shown)}"
      data-label="${esc(estLabel(e))}"
      title="${e.completed ? `Completed${e.completedAt ? ' on ' + fmtDate(e.completedAt) : ''} (status: ${esc(e.status)}) — pick a status to mark it not complete` : 'Change status'}">
      ${STATUSES.map(s => `<option value="${esc(s)}" ${s === shown ? 'selected' : ''} ${blocked(s) ? 'disabled' : ''}>${esc(s)}</option>`).join('')}
      <option value="${COMPLETED_OPT}" ${e.completed ? 'selected' : ''}>✓ Sent for Bid</option>
    </select>`;
}

// A <select> is as wide as its longest option: size each status drop-down to the status it shows instead
const measureCtx = document.createElement('canvas').getContext('2d');
function fitStatusSelects(root) {
  root.querySelectorAll('select.status-select').forEach(sel => {
    const cs = getComputedStyle(sel);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = measureCtx.measureText(sel.options[sel.selectedIndex]?.text || '').width;
    const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    sel.style.width = `${Math.ceil(text + extra + 2)}px`;
  });
}

// Shared pager: "Showing 26–50 of 120 estimations" + « ‹ 1 … 4 [5] 6 … 12 › »
// r = { page, pages, total, pageSize } from the server; goTo(page) loads that page.
function renderPager(el, r, noun, goTo, extra = '') {
  if (typeof el === 'string') el = $(el);
  el.hidden = !r.total;
  if (!r.total) { el.innerHTML = ''; return; }
  const first = (r.page - 1) * r.pageSize + 1, last = Math.min(r.total, r.page * r.pageSize);
  const nums = [...new Set([1, r.page - 1, r.page, r.page + 1, r.pages])].filter(p => p >= 1 && p <= r.pages).sort((a, b) => a - b);
  const btn = (p, label, title, cls = '') => `<button type="button" class="pager-btn ${cls}" data-page="${p}" title="${title}" aria-label="${title}"
    ${p < 1 || p > r.pages || p === r.page ? 'disabled' : ''}${p === r.page && cls === 'num' ? ' aria-current="page"' : ''}>${label}</button>`;
  let pages = '';
  nums.forEach((p, i) => {
    if (i && p - nums[i - 1] > 1) pages += '<span class="pager-gap">…</span>';
    pages += btn(p, p, `Page ${p}`, `num${p === r.page ? ' current' : ''}`);
  });
  el.innerHTML = `<span class="pager-info">Showing <strong>${first.toLocaleString()}–${last.toLocaleString()}</strong> of
      <strong>${r.total.toLocaleString()}</strong> ${noun}${extra}</span>
    ${r.pages > 1 ? `<span class="pager-controls">
      ${btn(1, '«', 'First page', 'edge')}${btn(r.page - 1, '‹ Prev', 'Previous page', 'step')}
      ${pages}
      ${btn(r.page + 1, 'Next ›', 'Next page', 'step')}${btn(r.pages, '»', 'Last page', 'edge')}</span>` : ''}`;
  el.onclick = ev => {
    const b = ev.target.closest('button[data-page]');
    if (b && !b.disabled) Promise.resolve(goTo(+b.dataset.page)).catch(err => { if (!err.silent) alert(err.message); });
  };
}

// Main list paging (25 per page, from the server). Changing a filter goes back to page 1;
// reloading after an edit stays on the current page.
let listPage = 1, listFilterKey = null;
async function loadList(page = listPage) {
  const params = listParams();
  const key = params.toString();
  if (key !== listFilterKey) { page = 1; listFilterKey = key; }
  const query = new URLSearchParams(params);
  query.set('page', page);
  const [r, s] = await Promise.all([api(`${API}?${query}`), api(`${API}/stats/summary`)]);
  const items = r.items;
  listPage = r.page;
  $('#exportBtn').textContent = `⬇ Export to Excel (${r.total})`;
  $('#clearFilters').hidden = !key;
  renderPager('#listPager', r, r.total === 1 ? 'estimation' : 'estimations', p => loadList(p).then(() => $('#listView .table-wrap').scrollIntoView({ block: 'start' })));
  const first = (r.page - 1) * r.pageSize;

  $('#rows').innerHTML = items
    .map((e, i) => {
      const due = dueInfo(e.dueDate, e.status, e.completed);
      const won = e.status === 'Won';
      return `<tr class="row-link ${won ? 'row-won' : e.completed ? 'row-done' : ''}" data-open-id="${e._id}" title="${e.completed ? `Completed${e.completedAt ? ' on ' + fmtDate(e.completedAt) : ''} — click to open` : 'Click to open'}">
        <td class="num sl-no">${first + i + 1}</td>
        <td><a href="/edit/${e._id}"><strong>${esc(e.jobNo) || '—'}</strong></a></td>
        <td>${fmtDate(e.date)}</td>
        <td class="project-cell" title="${esc(e.projectName)}">${esc(e.projectName)}</td>
        <td>${e.priorityClient ? '<span class="star" title="Priority client">★</span> ' : ''}${esc(e.clientName)}</td>
        <td>${esc(e.doneBy) || '—'}</td>
        <td class="num">${fmt(e.totalHours)}</td>
        <td class="num"><strong>${fmt(e.approxTonnage)}</strong></td>
        <td>${fmtDate(e.dueDate)}</td>
        <td>${e.completed ? '<span class="due due-closed">Completed</span>' : due ? `<span class="due ${due.cls}">${due.text}</span>` : '—'}</td>
        <td class="center">${(() => {
          const yes = e.connectionDesign === 'Yes';
          return `<button type="button" class="cd-badge${yes ? ' yes' : ''}" data-cd="${yes ? 'No' : 'Yes'}" data-id="${e._id}"
            data-label="${esc(estLabel(e))}" ${isLocked(e) ? `disabled title="${LOCK_TIP}"` : `title="Click to change to ${yes ? 'No' : 'Yes'}"`}>${yes ? 'Yes' : 'No'}</button>`;
        })()}</td>
        <td>${statusSelect(e)}</td>
        <td>${e.lessValue ? `<span class="lv-badge small" title="Less value job — ${LV_TITLE}">LVJ</span>` : '—'}</td>
        <td class="actions-cell">
          ${!can('team_leader') ? '' : won
            ? `<button class="btn small won-on" data-won="0" data-id="${e._id}" title="Click to undo (sets status back to Submitted)">✓ Won</button>`
            : `<button class="btn small won-btn" data-won="1" data-id="${e._id}">Mark Won</button>`}
          ${e.links?.find(l => l.url) ? `<a class="btn small" href="${esc(e.links.find(l => l.url).url)}" target="_blank" rel="noopener" title="Open SharePoint folder">Folder</a>` : ''}
          ${can('team_leader') ? `<button class="btn small danger icon-btn" data-del="${e._id}" data-label="${esc(estLabel(e))}" title="Delete" aria-label="Delete">${TRASH_ICON}</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  fitStatusSelects($('#rows'));
  $('#empty').hidden = items.length > 0;

  const won = s.byStatus.Won || { count: 0, tonnage: 0 };
  const lost = s.byStatus.Lost?.count || 0;
  const active = ['Yet To Start', 'In Progress'].reduce((n, k) => n + (s.byStatus[k]?.count || 0), 0);
  const cards = [
    ['Total Estimations', s.count],
    ['Total Tonnage', fmt(s.tonnage, 1) + ' t'],
    ['Total Hours', fmt(s.hours, 0)],
    ['Active', active],
    ['Submitted', s.byStatus.Submitted?.count || 0],
    ['Won Tonnage', fmt(won.tonnage, 1) + ' t'],
    ['Win Rate', won.count + lost ? Math.round((won.count / (won.count + lost)) * 100) + '%' : '—'],
    ['Less Value Jobs', s.lessValue || 0],
  ];
  $('#stats').innerHTML = cards.map(([l, v]) => `<div class="stat"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
}

$('#rows').addEventListener('click', async ev => {
  if (ev.target.closest('select')) return; // status drop-down: handled on change
  // Clicking anywhere on a row (except its buttons/links) opens the project
  if (!ev.target.closest('a, button')) {
    const row = ev.target.closest('tr[data-open-id]');
    if (!row || getSelection().toString()) return; // don't hijack text selection
    const url = `/edit/${row.dataset.openId}`;
    if (ev.ctrlKey || ev.metaKey) window.open(url, '_blank');
    else go(url);
    return;
  }
  const d = ev.target.closest('button, a').dataset; // icon buttons hold an SVG, so the click target may be inside it
  if (d.cd) {
    if (!confirm(`Change Connection design to "${d.cd}" for ${d.label}?`)) return;
    await api(`${API}/${d.id}`, { method: 'PUT', body: JSON.stringify({ connectionDesign: d.cd }) });
    return loadList();
  }
  if (d.won) {
    if (d.won === '0' && !confirm('Remove the Won mark? Status will go back to Submitted.')) return;
    await api(`${API}/${d.id}`, { method: 'PUT', body: JSON.stringify({ status: d.won === '1' ? 'Won' : 'Submitted' }) });
    return loadList();
  }
  if (d.del && await askDeletePassword(d.del, d.label)) loadList();
});

// Deleting an estimation needs the delete password. Resolves true once deleted.
function askDeletePassword(id, label) {
  const dlg = $('#delDialog'), f = $('#delForm');
  f.reset();
  showError($('#delError'), '');
  $('#delText').textContent = `Delete ${label}? This cannot be undone.`;
  return new Promise(resolve => {
    let deleted = false;
    f.onsubmit = async ev => {
      ev.preventDefault();
      try {
        await api(`${API}/${id}`, { method: 'DELETE', headers: { 'X-Delete-Password': f.password.value } });
        deleted = true;
        dlg.close();
      } catch (err) { if (!err.silent) showError($('#delError'), err.message); }
    };
    dlg.onclose = () => resolve(deleted);
    dlg.showModal();
  });
}
$('#delClose').onclick = () => $('#delDialog').close();

// Status changed in the list
$('#rows').addEventListener('change', async ev => {
  const sel = ev.target.closest('select[data-status-id]');
  if (!sel) return;
  const { statusId, orig, label } = sel.dataset;
  const to = sel.value;
  // "Completed" is not a status: it sets the completed flag (the status itself is kept)
  const [question, body] = to === COMPLETED_OPT
    ? [`Mark ${label} as Sent for Bid?`, { completed: true }]
    : orig === COMPLETED_OPT
      ? [`Mark ${label} as NOT Sent for Bid and set its status to "${to}"?`, { completed: false, status: to }]
      : [`Change the status of ${label} from "${orig}" to "${to}"?`, { status: to }];
  if (!confirm(question)) { sel.value = orig; fitStatusSelects(sel.parentNode); return; }
  sel.disabled = true;
  try {
    await api(`${API}/${statusId}`, { method: 'PUT', body: JSON.stringify(body) });
  } catch (err) {
    if (!err.silent) alert(err.message);
  }
  loadList();
});

// =====================================================================
// EDITOR VIEW
// =====================================================================
let cur = null;    // estimation being edited
let dirty = false;
let savedLocked = false; // the saved estimation is Sent for Bid / Submitted (see isLocked)
let activePage = 0; // index of the chart page shown
const pg = () => cur.pages[activePage];

const DEFAULT_LINK_LABEL = 'SharePoint Link';
const DEFAULT_CONTACT = { name: 'Lee Luck', email: 'lee.luck@vectorshades.com' };

function blankEstimation(jobNo) {
  return {
    jobNo, projectName: '', clientName: '', date: today(), dueDate: today(), doneBy: '', status: 'Yet To Start',
    contactPerson: DEFAULT_CONTACT.name, contactEmail: DEFAULT_CONTACT.email,
    pages: [newPage('Page 1')],
    exclusions: [],
    proposalExclusions: ['Any structural steel not shown, sized or dimensioned on the structural / architectural drawings.', 'Joist details, deck, and foundation rebar details.', 'Engineering'],
    scope: '', complexity: '', deliverables: [],
    coordinationNeeded: '', durationWeeks: null, quotedTonnage: null,
    assumptions: '', remark: '',
    proposalDate: today(), quoteNo: '', submittalWeeks: null, signerName: '', signerTitle: '', connectionDesign: 'No',
    links: [{ label: DEFAULT_LINK_LABEL, url: '' }],
  };
}

// Make sure the loaded estimation has well-formed pages
// Description tables always show at least this many rows (blank rows at the end are dropped on save)
const MIN_DESC_ROWS = 5;
const blankDesc = () => ({ qty: '', description: '', notes: '', heading: false });
function padDescriptions(page) {
  for (const key of ['structDescriptions', 'miscDescriptions']) {
    page[key] = page[key] || [];
    while (page[key].length < MIN_DESC_ROWS) page[key].push(blankDesc());
  }
  return page;
}

function normalizeCur() {
  cur.pages = (cur.pages && cur.pages.length ? cur.pages : [newPage('Page 1')]).map((p, i) => padDescriptions(normalizePage(p, i)));
  if (activePage >= cur.pages.length) activePage = cur.pages.length - 1;
  // Pages that already have chart-generated lines: bring them up to date (e.g. merge older per-sheet lines)
  cur.pages.forEach(p => {
    if (p.autoDesc && [...p.structDescriptions, ...p.miscDescriptions].some(d => d.autoKey)) syncAutoDescriptions(p);
  });
  if (!cur.links?.length) cur.links = [{ label: DEFAULT_LINK_LABEL, url: '' }];
  // Default contact for estimations that don't have one yet (new or older ones)
  if (!cur.contactPerson && !cur.contactEmail) {
    cur.contactPerson = DEFAULT_CONTACT.name;
    cur.contactEmail = DEFAULT_CONTACT.email;
  }
}

let clientPrio = new Set(); // nameKeys of priority clients

async function loadClientOptions() {
  const { clients } = await api(CLIENTS_API).catch(() => ({ clients: [] }));
  clientPrio = new Set(clients.filter(c => c.priority).map(c => c.nameKey));
  $('#clientOptions').innerHTML = clients
    .map(c => `<option value="${esc(c.name)}">${c.priority ? '★ Priority client' : ''}</option>`)
    .join('');
}

function updateClientFlags(totalHours) {
  const name = cur.clientName || '';
  const prio = clientPrio.has(nameKey(name));
  $('#clientBadge').innerHTML = prio ? '<span class="star">★</span> Priority client' : '';
  const less = !!name.trim() && isLessValueJob(totalHours ?? computeEstimation(cur).totalHours, prio);
  $('#lessValueBadge').hidden = !less;
  $('#lessValueBadge').title = LV_TITLE;
}

async function openEditor(id) {
  loadClientOptions().then(() => cur && updateClientFlags());
  $('#formError').hidden = true;
  $('#saveMsg').textContent = '';
  if (id) {
    cur = await api(`${API}/${id}`);
  } else {
    const { jobNo } = await api(`${API}/next-no`).catch(() => ({ jobNo: '' }));
    cur = blankEstimation(jobNo);
  }
  activePage = 0;
  normalizeCur();
  dirty = false;
  savedLocked = isLocked(cur);
  fillForm();
  renderAll();
  applyLock();
}

// Sent for Bid / Submitted: everything in the form is read-only except the status (and switching pages).
// Elements disabled here are marked, so unlocking only re-enables those (others stay disabled for their own reasons).
const LOCK_KEEP = '#statusSelect, .page-tab[data-page]';
function lockElements(root, locked) {
  const els = [...root.querySelectorAll('input, select, textarea, button')];
  if (root.matches?.('input, select, textarea, button')) els.push(root);
  els.forEach(el => {
    if (el.matches(LOCK_KEEP)) return;
    if (locked && !el.disabled) { el.disabled = true; el.dataset.lockDisabled = '1'; }
    else if (!locked && el.dataset.lockDisabled) { el.disabled = false; delete el.dataset.lockDisabled; }
  });
}
function applyLock() {
  const locked = !!cur && isLocked(cur);
  const wasLocked = form.classList.contains('locked');
  form.classList.toggle('locked', locked);
  lockElements(form, locked);
  if (wasLocked && !locked) { renderAutoDescToggle(); renderChart(); updateComputed(); } // their own disabled states
  $('#lockNote').hidden = !locked;
  $('#lockNote').textContent = locked
    ? `🔒 This estimation is ${cur.completed ? 'Sent for Bid' : 'Submitted'} and can't be changed. Change its status to make changes.` : '';
}
// Parts of the form are re-drawn (pages, chart, description rows…): keep new elements locked too
new MutationObserver(muts => {
  if (!form.classList.contains('locked')) return;
  muts.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) lockElements(n, true); }));
}).observe(form, { childList: true, subtree: true });

function fillForm() {
  // Older estimations may have a "Done by" value that isn't in the drop-down — keep it selectable
  const doneBy = $('#doneBySelect');
  doneBy.querySelectorAll('option[data-extra]').forEach(o => o.remove());
  if (cur.doneBy && ![...doneBy.options].some(o => o.value === cur.doneBy)) {
    doneBy.insertAdjacentHTML('beforeend', `<option data-extra>${esc(cur.doneBy)}</option>`);
  }
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.name === 'exclusions' || el.name === 'proposalExclusions') el.value = (cur[el.name] || []).join('\n');
    else if (el.name === 'deliverables') el.checked = (cur.deliverables || []).includes(el.value);
    else if (el.type === 'date') el.value = toInputDate(cur[el.name]);
    else if (el.name === 'connectionDesign') el.value = cur.connectionDesign || 'No';
    else if (el.name === 'status') el.value = cur.completed ? COMPLETED_OPT : cur.status ?? '';
    else el.value = cur[el.name] ?? '';
  }
  $('#editorTitle').textContent = cur._id ? estLabel(cur) : 'New Estimation';
  $('#excelBtn').disabled = !cur._id;
  $('#emailBtn').disabled = !cur._id;
  $('#proposalBtn').disabled = !cur._id;
  $('#packageBtn').disabled = !cur._id;
  updateSplitButtons();
  const lead = can('team_leader');
  [...$('#statusSelect').options].forEach(o => { o.disabled = !lead && ['Won', 'Lost'].includes(o.value) && o.value !== cur.status; });
  $('#statusSelect').disabled = !lead && ['Won', 'Lost'].includes(cur.status);
  $('#auditInfo').textContent = cur._id
    ? [cur.createdBy && `Created by ${cur.createdBy}`, cur.updatedBy && `last changed by ${cur.updatedBy}${cur.updatedAt ? ' on ' + fmtDate(cur.updatedAt) : ''}`].filter(Boolean).join(' · ')
    : '';
  updateQuotePlaceholder();
  updateDueInfo();
}

function updateQuotePlaceholder() {
  const [y, m, d] = (toInputDate(cur.proposalDate) || today()).split('-');
  $('#quoteNo').placeholder = `${m}${d}${y}-01 (auto)`;
}

function updateDueInfo() {
  const due = dueInfo(cur.dueDate, cur.status, cur.completed);
  $('#dueInfo').innerHTML = due ? `<span class="due ${due.cls}">${due.text}</span>` : '';
}

function renderAll() {
  renderPage();
  renderLinks();
  updateComputed();
}

const isUrl = u => /^https?:\/\//i.test(u || '');

function renderLinks() {
  $('#linkRows').innerHTML = cur.links.map((l, k) => `<div class="link-row">
      <input data-link="${k}" data-f="label" value="${esc(l.label)}" placeholder="Label (e.g. Submission documents)" />
      <input data-link="${k}" data-f="url" type="url" value="${esc(l.url)}" placeholder="https://yourcompany.sharepoint.com/sites/…" />
      <a class="btn small${isUrl(l.url) ? '' : ' disabled'}" data-open="${k}" href="${esc(l.url) || '#'}" target="_blank" rel="noopener">Open</a>
      <button type="button" class="x" data-del-link="${k}" title="Remove">×</button></div>`).join('')
    || '<p class="sub">No links yet</p>';
}

// ---------- Pages (tabs) ----------
function renderPageTabs() {
  $('#pageTabs').innerHTML = cur.pages.map((p, i) => `<button type="button" class="page-tab ${i === activePage ? 'active' : ''}"
      data-page="${i}" title="${i === activePage ? 'Double-click to rename' : 'Open this page'}">${esc(p.name || `Page ${i + 1}`)}</button>`).join('') +
    `<button type="button" class="page-tab add" id="addPageBtn" title="Add a new page">+ Add page</button>`;
  $('#renamePageBtn').hidden = false;
  $('#deletePageBtn').hidden = cur.pages.length <= 1;
  document.querySelectorAll('.page-name').forEach(el => { el.textContent = pg().name; });
}

// Everything that belongs to the current page
function renderPage() {
  renderPageTabs();
  renderChart();
  renderDwgs();
  renderExtras();
  renderDesc('structDescriptions');
  renderDesc('miscDescriptions');
  renderAutoDescToggle();
}

function switchPage(i) {
  activePage = i;
  selectedSheet = null;
  renderPage();
  updateComputed();
  updateSplitButtons(); // pages may have been added / deleted
  applyLock(); // the page's switches / buttons set their own disabled state
}

function renamePage(i = activePage) {
  const name = prompt('Page name:', cur.pages[i].name);
  if (name === null) return;
  const clean = name.trim();
  if (!clean) return;
  if (cur.pages.some((p, k) => k !== i && p.name.toLowerCase() === clean.toLowerCase())) return alert(`A page named "${clean}" already exists.`);
  cur.pages[i].name = clean;
  dirty = true;
  renderPageTabs();
}

// ---------- Chart grid ----------
let selectedSheet = null; // sheet column whose title was clicked: "Add sheet column" inserts after it

function renderChart() {
  gridSel = null; // cells are rebuilt: a block selection would point at the wrong cells
  const sheets = pg().sheets;
  if (selectedSheet !== null && selectedSheet >= sheets.length) selectedSheet = null;
  const head = `<thead><tr>
      <th class="sticky">SHEET NO.</th>
      <th class="rate">Rate<div class="sub">min / div</div></th>
      ${sheets.map((s, i) => `<th class="sheet${i === selectedSheet ? ' sheet-selected' : ''}" data-col="${i}">
          <span class="grip" draggable="true" data-grip="${i}" title="Drag to move this column">⋮⋮</span>
          <input class="sheet-name" data-sheet="${i}" value="${esc(s)}" placeholder="Sheet ${i + 1}" />
          <button type="button" class="x" data-del-sheet="${i}" title="Remove column">×</button></th>`).join('')}
      <th class="num tot">TOTAL</th><th class="num hrs">HRS REQ'D</th></tr></thead>`;
  const body = pg().items
    .map((it, r) => `<tr>
      <th class="sticky">${esc(it.name)}</th>
      <td class="rate">${it.minutes === null ? '<span class="sub">hrs</span>'
        : `<input type="number" min="0" step="any" data-rate="${r}" data-f="minutes" value="${it.minutes}" />/<input type="number" min="1" step="any" data-rate="${r}" data-f="divisor" value="${it.divisor}" />`}</td>
      ${sheets.map((_, c) => `<td><input type="text" inputmode="decimal" autocomplete="off" class="cnt" data-r="${r}" data-c="${c}" value="${it.counts[c] || ''}" title="Quantity — a sum like 12+5 is worked out" /></td>`).join('')}
      <td class="num tot" id="tot-${it.key}"></td><td class="num hrs" id="hrs-${it.key}"></td></tr>`)
    .join('');
  const foot = `<tfoot><tr><th class="sticky">TOTAL</th><td></td>${sheets.map((_, c) => `<td class="num" id="colTot-${c}"></td>`).join('')}
      <td class="num tot" id="grandCount"></td><td class="num hrs" id="grandHours"></td></tr></tfoot>`;
  $('#chart').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  $('#addSheetBtn').disabled = sheets.length >= MAX_SHEETS;
}

function renderDwgs() {
  $('#dwgTable').innerHTML = `
    <thead><tr><th class="sticky">TYPE</th>${DWG_TYPES.map(d => `<th>${d.label}</th>`).join('')}<th>TOTAL</th></tr></thead>
    <tbody>
      <tr><th class="sticky">Calculated</th>${DWG_TYPES.map(d => `<td class="num" id="dwgCalc-${d.key}">${d.parts ? '' : '<span class="sub">manual</span>'}</td>`).join('')}<td></td></tr>
      <tr><th class="sticky">No Dwgs</th>${DWG_TYPES.map(d => {
        const v = pg().dwgOverrides[d.key];
        return `<td><input type="number" min="0" step="any" data-dwg="${d.key}" value="${v ?? ''}" placeholder="${d.parts ? 'auto' : '0'}" /></td>`;
      }).join('')}<td class="num"><strong id="dwgTotal"></strong></td></tr>
    </tbody>`;
}

function renderExtras() {
  $('#archRows').innerHTML = [0, 1, 2, 3].map(k => `<div class="pair">
      <input data-arch="${k}" data-f="ref" value="${esc(pg().arch[k]?.ref)}" placeholder="Ref" />
      <input data-arch="${k}" data-f="description" value="${esc(pg().arch[k]?.description)}" placeholder="Description" /></div>`).join('');
  for (const key of ['span', 'weight']) {
    $(`#${key}Rows`).innerHTML = [0, 1, 2].map(k => `<input class="band band${k}" data-list="${key}" data-k="${k}" value="${esc(pg()[key][k])}" />`).join('');
  }
  $('#additionalHoursFor').value = pg().additionalHoursFor || '';
}

// ---------- Chart quantities -> Struct. / Misc. Description lines ----------
// Chart items grouped into one description per sheet; quantity = sum of that group's counts on the sheet
const AUTO_DESC_GROUPS = {
  structDescriptions: [ // main steel — one line per chart item
    { name: 'CURVED BEAM', keys: ['beam11'] },
    { name: 'MOMENT/BRACED BEAM', keys: ['beam12'] },
    { name: 'BEAM', keys: ['beam13'] },
    { name: 'SECONDARY BEAM', keys: ['beam14'] },
    { name: 'COMPLEX COLUMN', keys: ['col11'] },
    { name: 'MOMENT/BRACED COLUMN', keys: ['col12'] },
    { name: 'COLUMN', keys: ['col13'] },
    { name: 'POST/STUD COLUMN', keys: ['col14'] },
    { name: 'BRACE', keys: ['vb11'] },
    { name: 'V BRACE 1/3', keys: ['vb13'] },
    { name: 'V BRACE 1/4', keys: ['vb14'] },
    { name: 'V BRACE 1/2', keys: ['vb12'] },
    { name: 'H BRACE 1/4', keys: ['hb14'] },
    { name: 'H BRACE 1/3', keys: ['hb13'] },
    { name: 'TRUSS', keys: ['truss'] },
  ],
  miscDescriptions: [ // misc
    { name: 'GUARDRAILS', keys: ['hrail'] },
    { name: 'WALL RAILS', keys: ['wrail'] },
    { name: 'CAGE LADDERS', keys: ['ladderCage'] },
    { name: 'LADDERS', keys: ['ladderNoCage'] },
    { name: 'GATES', keys: ['gates'] },
    { name: 'STAIRS W/ RAILINGS', keys: ['stringer'] },
  ],
};
const isBlankDesc = d => !String(d.qty ?? '').trim() && !String(d.description ?? '').trim() && !String(d.notes ?? '').trim();

// Generated lines are keyed by item ("BEAM"), or by item and sheet column ("BEAM|0") when Split sheets is on
function syncAutoDescriptions(page) {
  const counts = Object.fromEntries(page.items.map(it => [it.key, it.counts]));
  const split = !!page.splitSheets;
  for (const [listKey, groups] of Object.entries(AUTO_DESC_GROUPS)) {
    // What the chart says now. Normal: one line per item for the whole page, qty = total over all sheets.
    // Split: one line per item per sheet. Notes are not fetched: they stay as the user typed them.
    const wanted = new Map();
    for (const g of groups) {
      let qty = 0;
      page.sheets.forEach((sheet, c) => {
        const q = g.keys.reduce((a, k) => a + (+(counts[k] || [])[c] || 0), 0);
        if (!q) return;
        if (split) wanted.set(`${g.name}|${c}`, { qty: String(q), name: g.name });
        qty += q;
      });
      if (qty && !split) wanted.set(g.name, { qty: String(qty), name: g.name });
    }
    // Update generated lines where they are (keeps any drag-and-drop order), drop ones no longer in the chart.
    // A line from the other mode is converted in place, keeping wording the user changed:
    // split on -> the item's line becomes its per-sheet lines; split off -> per-sheet lines fold into one line.
    const list = [];
    const placed = new Set();
    const put = (d, key) => { list.push({ ...d, qty: wanted.get(key).qty, autoKey: key }); placed.add(key); };
    for (const d of page[listKey] || []) {
      if (!d.autoKey) { list.push(d); continue; }
      const [base, col] = d.autoKey.split('|');
      if (wanted.has(d.autoKey) && !placed.has(d.autoKey)) put(d, d.autoKey);
      else if (split && col === undefined) {
        for (const key of wanted.keys()) if (key.startsWith(`${base}|`) && !placed.has(key)) put(d, key);
      } else if (!split && col !== undefined && wanted.has(base) && !placed.has(base)) put(d, base);
    }
    // New generated lines go after the last generated line (or at the top) — unless a heading was added after
    // that line: then they go under the newest heading, at the end of its section
    while (list.length && isBlankDesc(list[list.length - 1])) list.pop(); // spare blank rows are re-added below
    let at = 0, lastHeading = -1;
    list.forEach((d, i) => { if (d.autoKey) at = i + 1; if (d.heading) lastHeading = i; });
    if (lastHeading >= at) at = list.length;
    const added = [...wanted].filter(([key]) => !placed.has(key))
      .map(([autoKey, w]) => ({ qty: w.qty, description: w.name, notes: '', heading: false, autoKey }));
    list.splice(at, 0, ...added);
    page[listKey] = list;
  }
  padDescriptions(page);
}

// Auto fetch turned back on: link lines fetched before (or typed with the same wording) to the chart again, so
// the sync updates them instead of adding new ones. With Split sheets on, a line matches its item AND its sheet
// (the Notes column). Extra copies of a line that is already linked are leftovers of earlier fetches: dropped.
function relinkAutoLines(page) {
  const split = !!page.splitSheets;
  const sheetCol = notes => page.sheets.findIndex((s, c) => (s || `Sheet ${c + 1}`).trim().toLowerCase() === String(notes || '').trim().toLowerCase());
  for (const [key, groups] of Object.entries(AUTO_DESC_GROUPS)) {
    const names = new Set(groups.map(g => g.name));
    const taken = new Set(page[key].filter(d => d.autoKey).map(d => d.autoKey));
    page[key] = page[key].filter(d => {
      if (d.autoKey) return true;
      const name = String(d.description || '').trim().toUpperCase();
      if (!names.has(name)) return true; // the user's own line
      const c = split ? sheetCol(d.notes) : -1;
      const autoKey = c >= 0 ? `${name}|${c}` : name;
      if (taken.has(autoKey)) return false; // duplicate of a line that is already linked
      d.autoKey = autoKey;
      taken.add(autoKey);
      return true;
    });
  }
}

// A sheet column was removed: the sync recalculates totals and sheet lists, nothing to renumber any more
function dropAutoColumn() {}

// Call after quantities / sheet names / sheet columns change
function chartChanged() {
  if (!pg().autoDesc) return;
  syncAutoDescriptions(pg());
  renderDesc('structDescriptions');
  renderDesc('miscDescriptions');
}

// ---------- Auto fetch and Split sheets Yes/No switches (per page) ----------
function renderAutoDescToggle() {
  const on = pg().autoDesc !== false;
  $('#autoDescToggle').checked = on;
  $('#autoDescState').textContent = on ? 'Yes' : 'No';
  // Split sheets only applies to lines fetched from the chart
  const split = !!pg().splitSheets;
  $('#splitSheetsToggle').checked = split;
  $('#splitSheetsToggle').disabled = !on;
  $('#splitSheetsState').textContent = split ? 'Yes' : 'No';
  $('#splitSheetsSwitch').classList.toggle('disabled', !on);
  $('#splitSheetsSwitch').title = on ? 'Show a separate description line for each sheet' : 'Turn on Auto fetch to use Split sheets';
}

$('#splitSheetsToggle').addEventListener('change', ev => {
  const page = pg();
  page.splitSheets = ev.target.checked;
  syncAutoDescriptions(page);
  renderDesc('structDescriptions');
  renderDesc('miscDescriptions');
  renderAutoDescToggle();
  saveAutoDesc(page, `Split sheets ${page.splitSheets ? 'Yes' : 'No'}`);
});

$('#autoDescToggle').addEventListener('change', ev => {
  const page = pg();
  const on = ev.target.checked;
  const msg = on
    ? 'Turn auto fetch ON?\n\nDescription lines will be filled from the estimation chart. Existing lines with the same description will have their quantity replaced by the chart value (notes are kept), and repeated copies of them are removed.'
    : 'Turn auto fetch OFF?\n\nLines already fetched from the chart are kept as normal editable lines, and chart changes will no longer update them.';
  if (!confirm(msg)) { ev.target.checked = !on; return; }
  page.autoDesc = on;
  if (on) {
    relinkAutoLines(page);
    syncAutoDescriptions(page);
  } else {
    for (const key of Object.keys(AUTO_DESC_GROUPS)) page[key].forEach(d => { delete d.autoKey; });
  }
  renderDesc('structDescriptions');
  renderDesc('miscDescriptions');
  renderAutoDescToggle();
  saveAutoDesc(page, `Auto fetch ${on ? 'Yes' : 'No'}`);
});

// Save the switches (and the page's description lines they just changed) right away, so a refresh keeps them
async function saveAutoDesc(page, what) {
  if (!cur._id) { dirty = true; return; } // not created yet: kept by the normal Save
  const trimmed = list => { const l = [...list]; while (l.length && isBlankDesc(l[l.length - 1])) l.pop(); return l; };
  try {
    await api(`${API}/${cur._id}/pages/${activePage}/auto-desc`, {
      method: 'PUT',
      body: JSON.stringify({
        autoDesc: page.autoDesc, splitSheets: !!page.splitSheets, pageName: (page.name || '').trim(),
        structDescriptions: trimmed(page.structDescriptions), miscDescriptions: trimmed(page.miscDescriptions),
      }),
    });
    $('#saveMsg').textContent = `${what} saved ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    dirty = true; // e.g. a new page that isn't saved yet: the normal Save stores it
    $('#saveMsg').textContent = `${what.replace(/ (Yes|No)$/, '')} changed — click Save to keep it`;
  }
}

function renderDesc(key) {
  const rows = pg()[key];
  $(`#${key}`).innerHTML = `<thead><tr><th style="width:18px"></th><th style="width:64px">Qty</th><th>Description</th><th style="width:34%">Notes</th><th style="width:56px" title="Heading row (bold, shaded)">Head.</th><th style="width:28px"></th></tr></thead>
    <tbody data-list="${key}">${rows.map((d, k) => `<tr class="${d.heading ? 'heading' : ''} ${d.autoKey ? 'auto-row' : ''}" data-row="${k}"
        ${d.autoKey ? 'title="From the estimation chart — change the quantity in the chart"' : ''}>
      <td class="drag-handle" title="Drag to move this row">⋮⋮</td>
      <td><input data-desc="${key}" data-k="${k}" data-f="qty" value="${esc(d.qty)}" ${d.autoKey ? 'readonly' : ''} /></td>
      <td><input data-desc="${key}" data-k="${k}" data-f="description" value="${esc(d.description)}" /></td>
      <td><input data-desc="${key}" data-k="${k}" data-f="notes" value="${esc(d.notes)}" /></td>
      <td class="center"><input type="checkbox" data-desc="${key}" data-k="${k}" data-f="heading" ${d.heading ? 'checked' : ''} /></td>
      <td><button type="button" class="x" data-del-desc="${key}" data-k="${k}">×</button></td></tr>`).join('')
      || `<tr><td colspan="6" class="sub center">No lines yet</td></tr>`}</tbody>`;
}

// ---------- Drag and drop rows in the description tables ----------
// Rows only become draggable while the handle is held, so text in the inputs can still be selected.
let dragFrom = null; // { list, index }
['structDescriptions', 'miscDescriptions'].forEach(key => {
  const table = $(`#${key}`);
  table.addEventListener('mousedown', ev => {
    const tr = ev.target.closest('tr[data-row]');
    if (tr && ev.target.closest('.drag-handle')) tr.draggable = true;
  });
  table.addEventListener('mouseup', () => { table.querySelectorAll('tr[draggable="true"]').forEach(r => { r.draggable = false; }); });
  table.addEventListener('dragstart', ev => {
    const tr = ev.target.closest('tr[data-row]');
    if (!tr) return;
    dragFrom = { list: key, index: +tr.dataset.row };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(dragFrom.index));
    tr.classList.add('dragging');
  });
  table.addEventListener('dragover', ev => {
    const tr = ev.target.closest('tr[data-row]');
    if (!dragFrom || dragFrom.list !== key || !tr) return;
    ev.preventDefault();
    const below = ev.clientY > tr.getBoundingClientRect().top + tr.offsetHeight / 2;
    table.querySelectorAll('.drop-above, .drop-below').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    tr.classList.add(below ? 'drop-below' : 'drop-above');
  });
  table.addEventListener('drop', ev => {
    const tr = ev.target.closest('tr[data-row]');
    if (!dragFrom || dragFrom.list !== key || !tr) return;
    ev.preventDefault();
    const rows = pg()[key];
    let to = +tr.dataset.row + (tr.classList.contains('drop-below') ? 1 : 0);
    const [moved] = rows.splice(dragFrom.index, 1);
    if (to > dragFrom.index) to--;
    rows.splice(to, 0, moved);
    dirty = true;
    dragFrom = null;
    renderDesc(key);
  });
  table.addEventListener('dragend', () => {
    dragFrom = null;
    table.querySelectorAll('tr[data-row]').forEach(r => { r.draggable = false; r.classList.remove('dragging', 'drop-above', 'drop-below'); });
  });
});

// ---------- Live totals ----------
function updateComputed() {
  const c = compute(pg());
  const all = computeEstimation(cur);
  for (const it of c.items) {
    $(`#tot-${it.key}`).textContent = c.totals[it.key] ? fmt(c.totals[it.key]) : '';
    $(`#hrs-${it.key}`).textContent = c.hours[it.key] ? fmt(c.hours[it.key]) : '';
  }
  pg().sheets.forEach((_, i) => {
    const s = c.items.reduce((a, it) => a + (+it.counts[i] || 0), 0);
    $(`#colTot-${i}`).textContent = s ? fmt(s) : '';
  });
  $('#grandCount').textContent = fmt(c.totalCount);
  $('#grandHours').textContent = fmt(c.totalHours);
  for (const d of DWG_TYPES) if (d.parts) {
    const auto = d.parts.reduce((a, [k, div]) => a + c.totals[k] / div, 0);
    $(`#dwgCalc-${d.key}`).textContent = fmt(auto);
  }
  $('#dwgTotal').textContent = fmt(c.totalDwgs);
  updateClientFlags(all.totalHours);
  $('#quotedTonnage').placeholder = all.tonnage ? `${Math.round(all.tonnage)} (calculated)` : '';
  // Summary cards: built once per page so the hours-per-ton input keeps focus while typing
  if ($('#summary').dataset.page !== String(activePage) || !$('#hrsPerTon')) {
    $('#summary').dataset.page = String(activePage);
    $('#summary').innerHTML = `
      <div class="stat"><div class="label">Total Hrs Req'd</div><div class="value" id="sumHours"></div></div>
      <div class="stat"><div class="label">Hours per Tonnage</div><div class="value">
        <input type="number" id="hrsPerTon" min="0.01" step="any" value="${pg().hoursPerTon ?? DEFAULT_HRS_PER_TON}" /></div></div>
      <div class="stat accent"><div class="label">Tonnage Expected</div><div class="value" id="sumTonnage"></div></div>
      <div class="stat"><div class="label">Total No. Dwgs</div><div class="value" id="sumDwgs"></div></div>
      <div class="stat"><div class="label">Time Taken per Dwg</div><div class="value" id="sumPerDwg"></div></div>`;
  }
  $('#sumHours').textContent = fmt(c.totalHours);
  $('#sumTonnage').textContent = `${fmt(c.tonnage)} t`;
  $('#sumDwgs').textContent = fmt(c.totalDwgs);
  $('#sumPerDwg').textContent = `${fmt(c.timePerDwg)} hrs`;
  // Whole-estimation totals (all pages)
  $('#allPagesSummary').hidden = cur.pages.length < 2;
  $('#allPagesSummary').innerHTML = `<strong>All ${cur.pages.length} pages:</strong>
    ${fmt(all.totalHours)} hrs &nbsp;·&nbsp; <strong>${fmt(all.tonnage)} t</strong> &nbsp;·&nbsp; ${fmt(all.totalDwgs)} dwgs
    &nbsp;·&nbsp; ${fmt(all.timePerDwg)} hrs/dwg`;
}

// ---------- Input handling ----------
form.addEventListener('input', ev => {
  const el = ev.target;
  const d = el.dataset;
  dirty = true;
  $('#saveMsg').textContent = '';
  if (d.r !== undefined) {
    // A quantity can be a sum (12+5): totals follow as soon as it is complete; "12+" keeps the last good value
    const v = evalQty(el.value);
    el.classList.toggle('bad', v === null);
    if (v === null) return;
    pg().items[+d.r].counts[+d.c] = v;
    chartChanged();
  }
  else if (d.rate !== undefined) pg().items[+d.rate][d.f] = el.value === '' ? 0 : +el.value;
  else if (d.sheet !== undefined) { pg().sheets[+d.sheet] = el.value; chartChanged(); return; }
  else if (d.dwg) {
    if (el.value === '') delete pg().dwgOverrides[d.dwg];
    else pg().dwgOverrides[d.dwg] = +el.value;
  } else if (el.id === 'hrsPerTon') {
    pg().hoursPerTon = +el.value || DEFAULT_HRS_PER_TON;
  } else if (el.id === 'additionalHoursFor') { pg().additionalHoursFor = el.value; return; }
  else if (d.arch !== undefined) { (pg().arch[+d.arch] ||= {})[d.f] = el.value; return; }
  else if (d.list) { pg()[d.list][+d.k] = el.value; return; }
  else if (d.link !== undefined) {
    cur.links[+d.link][d.f] = el.value;
    if (d.f === 'url') {
      const a = $(`#linkRows a[data-open="${d.link}"]`);
      a.href = el.value || '#';
      a.classList.toggle('disabled', !isUrl(el.value));
    }
    return;
  }
  else if (d.desc) {
    const row = pg()[d.desc][+d.k];
    row[d.f] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'checkbox') el.closest('tr').classList.toggle('heading', el.checked);
    return;
  } else if (el.name) {
    if (el.name === 'exclusions' || el.name === 'proposalExclusions') cur[el.name] = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    else if (el.name === 'deliverables') cur.deliverables = [...form.querySelectorAll('input[name=deliverables]:checked')].map(i => i.value);
    else if (el.type === 'number') cur[el.name] = el.value === '' ? null : +el.value;
    // "Sent for Bid" is not a status: it sets the completed flag and keeps the status; any other pick un-completes it
    else if (el.name === 'status' && el.value === COMPLETED_OPT) cur.completed = true;
    else if (el.name === 'status') { cur.completed = false; cur.status = el.value; }
    else cur[el.name] = el.value;
    if (el.name === 'dueDate' || el.name === 'status') updateDueInfo();
    if (el.name === 'status') applyLock();
    if (el.name === 'clientName') updateClientFlags();
    if (el.name === 'proposalDate') updateQuotePlaceholder();
    return;
  }
  updateComputed();
});

// The mouse wheel over a focused number box steps its value (browser default): let go of the box instead,
// so the wheel just scrolls the page and the typed value stays as it is (everywhere in the app)
document.addEventListener('wheel', ev => {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.type === 'number' && el === document.activeElement) el.blur();
}, { passive: true, capture: true });

// ---------- Quantity grid: highlight, block selection and fill (like Excel) ----------
// Click a cell and drag (or Shift+click) to select a block; the cell you started in stays active.
// Ctrl+Enter or Ctrl+D copies the active cell's value into every selected cell.
// Ctrl+D with no block selected copies the value from the cell above.
const cellAt = (r, c) => $(`#chart input.cnt[data-r="${r}"][data-c="${c}"]`);
const cellPos = el => (el?.matches?.('input.cnt') ? { r: +el.dataset.r, c: +el.dataset.c } : null);
let gridSel = null;   // { anchor: {r, c}, to: {r, c} } — block selection, anchor = active cell
let gridDrag = null;  // { r, c } while the mouse button is held after pressing on a cell

const selBox = () => gridSel && {
  r0: Math.min(gridSel.anchor.r, gridSel.to.r), r1: Math.max(gridSel.anchor.r, gridSel.to.r),
  c0: Math.min(gridSel.anchor.c, gridSel.to.c), c1: Math.max(gridSel.anchor.c, gridSel.to.c),
};

// Highlight the selected cells, and the item names (left) / sheet names (top) of the focused cell or block
function paintGrid() {
  const chart = $('#chart');
  chart.querySelectorAll('.cell-focus, .in-range').forEach(el => el.classList.remove('cell-focus', 'in-range'));
  const focused = cellPos(document.activeElement);
  const box = selBox() || (focused && { r0: focused.r, r1: focused.r, c0: focused.c, c1: focused.c });
  if (!box) return;
  const rowHeads = chart.querySelectorAll('tbody tr th.sticky'), sheetHeads = chart.querySelectorAll('thead th.sheet');
  for (let r = box.r0; r <= box.r1; r++) rowHeads[r]?.classList.add('cell-focus');
  for (let c = box.c0; c <= box.c1; c++) sheetHeads[c]?.classList.add('cell-focus');
  if (!gridSel) return;
  for (let r = box.r0; r <= box.r1; r++) for (let c = box.c0; c <= box.c1; c++) cellAt(r, c)?.parentElement.classList.add('in-range');
}
function clearGridSel() { gridSel = null; paintGrid(); }

$('#chart').addEventListener('mousedown', ev => {
  const pos = cellPos(ev.target);
  if (!pos || ev.button !== 0) return;
  const active = cellPos(document.activeElement);
  if (ev.shiftKey && active) { // Shift+click: block from the active cell to this one
    ev.preventDefault();
    gridSel = { anchor: active, to: pos };
    return paintGrid();
  }
  gridSel = null;
  gridDrag = pos;
});
$('#chart').addEventListener('mouseover', ev => {
  if (!gridDrag || !(ev.buttons & 1)) return;
  const pos = cellPos(ev.target) || cellPos(ev.target.querySelector?.('input.cnt'));
  if (!pos) return;
  if (pos.r === gridDrag.r && pos.c === gridDrag.c && !gridSel) return; // still inside the first cell
  gridSel = { anchor: gridDrag, to: pos };
  $('#chart').classList.add('grid-selecting'); // no text selection while dragging
  const a = cellAt(gridDrag.r, gridDrag.c);
  if (document.activeElement !== a) a.focus();
  getSelection().removeAllRanges();
  paintGrid();
});
document.addEventListener('mouseup', () => { gridDrag = null; $('#chart').classList.remove('grid-selecting'); });

// Put one value into a set of cells, then update totals / generated description lines once
function fillCells(cells, raw) {
  const v = evalQty(raw);
  if (v === null) return;
  for (const { r, c } of cells) {
    pg().items[r].counts[c] = v;
    const el = cellAt(r, c);
    if (el) el.value = v ? String(v) : '';
  }
  dirty = true;
  $('#saveMsg').textContent = '';
  chartChanged();
  updateComputed();
}

// Quantity cell value: a number, or a sum like 12+5, =12+5, 3*4, (10+2)/2. Returns the number (blank = 0),
// or null if it is not a complete, non-negative sum. Parsed by hand: never runs the text as code.
function evalQty(text) {
  const s = String(text ?? '').replace(/\s+/g, '').replace(/^=/, '');
  if (s === '') return 0;
  if (!/^[\d.+\-*/()]+$/.test(s)) return null;
  let i = 0;
  const number = () => {
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '(') { i++; const v = expr(); if (s[i++] !== ')') throw 0; return v; }
    return number();
  };
  const term = () => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++], f = factor();
      if (op === '/' && f === 0) throw 0;
      v = op === '*' ? v * f : v / f;
    }
    return v;
  };
  function expr() {
    let v = term();
    while (s[i] === '+' || s[i] === '-') v = s[i++] === '+' ? v + term() : v - term();
    return v;
  }
  try {
    const v = expr();
    if (i !== s.length || !Number.isFinite(v) || v < 0) return null;
    return Math.round(v * 1e6) / 1e6;
  } catch { return null; }
}

// Quantity cells only take numbers and + - * / ( ) . = (letters etc. are ignored)
$('#chart').addEventListener('beforeinput', ev => {
  if (cellPos(ev.target) && ev.data && !/^[\d.+\-*/()=\s]+$/.test(ev.data)) ev.preventDefault();
});

// Leaving a quantity cell: show the worked-out number (12+5 -> 17); an unfinished sum goes back to the last value
$('#chart').addEventListener('change', ev => {
  const pos = cellPos(ev.target);
  if (!pos) return;
  const v = evalQty(ev.target.value);
  const n = v === null ? pg().items[pos.r].counts[pos.c] : v;
  ev.target.value = n ? String(n) : '';
  ev.target.classList.remove('bad');
});

$('#chart').addEventListener('focusin', ev => {
  const pos = cellPos(ev.target);
  // Cursor at the end of the value (12 -> after the 2), also when the cell was clicked in the middle
  if (pos) {
    const el = ev.target;
    setTimeout(() => { if (document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length); });
  }
  // Moving to a cell outside the block (Tab, arrows, a click) ends the block selection
  if (gridSel && (!pos || pos.r !== gridSel.anchor.r || pos.c !== gridSel.anchor.c) && !gridDrag) gridSel = null;
  paintGrid();
});
$('#chart').addEventListener('focusout', ev => {
  if (!$('#chart').contains(ev.relatedTarget)) { gridSel = null; setTimeout(paintGrid); }
});

$('#chart').addEventListener('keydown', ev => {
  const pos = cellPos(ev.target);
  if (!pos) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  // Fill: Ctrl+Enter / Ctrl+D -> the active cell's value into the whole block
  if (ctrl && (ev.key === 'Enter' || ev.key.toLowerCase() === 'd')) {
    ev.preventDefault(); // Ctrl+D would otherwise bookmark the page
    const box = selBox();
    if (box) {
      const cells = [];
      for (let r = box.r0; r <= box.r1; r++) for (let c = box.c0; c <= box.c1; c++) cells.push({ r, c });
      fillCells(cells, ev.target.value);
    } else if (ev.key.toLowerCase() === 'd' && pos.r > 0) {
      fillCells([pos], cellAt(pos.r - 1, pos.c)?.value ?? ''); // Ctrl+D on one cell: copy from the cell above
    }
    return;
  }
  if (ev.key === 'Escape' && gridSel) { ev.preventDefault(); return clearGridSel(); }
  // Arrow-key / Enter navigation
  const m = !ctrl && { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0] }[ev.key];
  if (!m) return;
  ev.preventDefault();
  const next = cellAt(pos.r + m[0], pos.c + m[1]);
  if (next) next.focus(); // the cursor goes to the end of its value (see focusin)
});

form.addEventListener('click', ev => {
  const d = ev.target.dataset;
  if (d.page !== undefined) {
    if (+d.page !== activePage) switchPage(+d.page);
  } else if (ev.target.id === 'addPageBtn') {
    const base = 'Page ';
    let n = cur.pages.length + 1;
    while (cur.pages.some(p => p.name.toLowerCase() === (base + n).toLowerCase())) n++;
    cur.pages.push(padDescriptions(newPage(base + n)));
    dirty = true;
    switchPage(cur.pages.length - 1);
  } else if (d.delSheet !== undefined) {
    const i = +d.delSheet;
    const used = pg().items.some(it => +it.counts[i]);
    if (used && !confirm(`Remove column "${pg().sheets[i] || 'Sheet ' + (i + 1)}" and its quantities?`)) return;
    pg().sheets.splice(i, 1);
    pg().items.forEach(it => it.counts.splice(i, 1));
    if (selectedSheet === i) selectedSheet = null;
    else if (selectedSheet > i) selectedSheet--;
    dropAutoColumn(pg(), i); // generated lines are keyed by column position
    chartChanged();
    dirty = true;
    renderChart(); updateComputed();
  } else if (d.add) {
    // "+ Add heading" adds the line with Head. ticked and puts the cursor in its description
    const heading = d.heading === '1';
    pg()[d.add].push({ qty: '', description: '', notes: '', heading });
    dirty = true;
    renderDesc(d.add);
    $(`#${d.add} tbody tr:last-child input[data-f="${heading ? 'description' : 'qty'}"]`)?.focus();
  } else if (d.delLink !== undefined) {
    cur.links.splice(+d.delLink, 1);
    dirty = true;
    renderLinks();
  } else if (d.open !== undefined && ev.target.classList.contains('disabled')) {
    ev.preventDefault();
  } else if (d.delDesc) {
    pg()[d.delDesc].splice(+d.k, 1);
    dirty = true;
    renderDesc(d.delDesc);
  }
});

$('#addLinkBtn').onclick = () => {
  cur.links.push({ label: DEFAULT_LINK_LABEL, url: '' });
  dirty = true;
  renderLinks();
  $(`#linkRows input[data-link="${cur.links.length - 1}"][data-f="url"]`).focus();
};

// Clicking a sheet column title selects that column; clicking a quantity cell or anywhere else clears it
function selectSheet(i) {
  selectedSheet = i;
  $('#chart').querySelectorAll('thead th.sheet').forEach(th => th.classList.toggle('sheet-selected', +th.dataset.col === i));
}
document.addEventListener('mousedown', ev => {
  if (ev.target.closest('#addSheetBtn')) return;
  const th = ev.target.closest('#chart thead th.sheet');
  if (th && !ev.target.closest('.x')) selectSheet(+th.dataset.col);
  else if (selectedSheet !== null) selectSheet(null);
});
$('#chart').addEventListener('focusin', ev => { // Tab onto a title selects its column too
  if (ev.target.dataset.sheet !== undefined) selectSheet(+ev.target.dataset.sheet);
});

// Add sheet column: right after the selected column, otherwise at the end
$('#addSheetBtn').onclick = () => {
  if (pg().sheets.length >= MAX_SHEETS) return;
  const at = selectedSheet !== null ? selectedSheet + 1 : pg().sheets.length;
  pg().sheets.splice(at, 0, '');
  pg().items.forEach(it => it.counts.splice(at, 0, 0));
  dirty = true;
  selectedSheet = at;
  chartChanged();
  renderChart(); updateComputed();
  $(`#chart input[data-sheet="${at}"]`).focus();
};

// Drag a column by its ⋮⋮ handle to move it (with its quantities) to another position
let dragSheet = null;
const clearDropMarks = () => $('#chart').querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
const dropTarget = ev => {
  const th = ev.target.closest?.('#chart thead th.sheet');
  if (!th) return null;
  const r = th.getBoundingClientRect();
  return { th, at: +th.dataset.col + (ev.clientX > r.left + r.width / 2 ? 1 : 0), after: ev.clientX > r.left + r.width / 2 };
};
$('#chart').addEventListener('dragstart', ev => {
  if (ev.target.dataset?.grip === undefined) return;
  if (isLocked(cur)) return ev.preventDefault();
  dragSheet = +ev.target.dataset.grip;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(dragSheet)); // Firefox needs data to start a drag
  const th = ev.target.closest('th');
  ev.dataTransfer.setDragImage(th, ev.offsetX, ev.offsetY);
  th.classList.add('dragging');
});
$('#chart').addEventListener('dragover', ev => {
  if (dragSheet === null) return;
  const t = dropTarget(ev);
  clearDropMarks();
  if (!t) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  t.th.classList.add(t.after ? 'drop-after' : 'drop-before');
});
$('#chart').addEventListener('drop', ev => {
  const t = dragSheet !== null && dropTarget(ev);
  if (!t) return;
  ev.preventDefault();
  const from = dragSheet, to = t.at > from ? t.at - 1 : t.at;
  if (to === from) return;
  const p = pg();
  p.sheets.splice(to, 0, p.sheets.splice(from, 1)[0]);
  p.items.forEach(it => it.counts.splice(to, 0, it.counts.splice(from, 1)[0]));
  selectedSheet = to;
  dirty = true;
  chartChanged();
  renderChart(); updateComputed();
});
$('#chart').addEventListener('dragend', () => {
  dragSheet = null;
  clearDropMarks();
  $('#chart').querySelector('th.dragging')?.classList.remove('dragging');
});

// Page tabs: double-click to rename; rename / delete buttons
$('#pageTabs').addEventListener('dblclick', ev => {
  const i = ev.target.dataset.page;
  if (i !== undefined && !isLocked(cur)) renamePage(+i);
});
$('#renamePageBtn').onclick = () => renamePage();
$('#deletePageBtn').onclick = () => {
  if (cur.pages.length <= 1) return;
  const p = pg();
  const hasData = p.items.some(it => it.counts.some(v => +v));
  if (!confirm(`Delete page "${p.name}"${hasData ? ' and all its quantities' : ''}?`)) return;
  cur.pages.splice(activePage, 1);
  activePage = Math.max(0, activePage - 1);
  dirty = true;
  switchPage(activePage);
};

const saveBody = () => ({ ...cur, pages: cur.pages.map(p => ({ ...p, name: (p.name || '').trim(), sheets: p.sheets.map(s => s.trim()) })) });
// Fields the server sets; an auto-save copies just these back so it never touches what the user is typing
const SERVER_FIELDS = ['updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'totalCount', 'totalHours', 'totalDwgs', 'approxTonnage',
  'sheetCount', 'pageCount', 'wonAt', 'completedAt', 'completedBy', '__v'];

let saveInFlight = null;
async function save(opts = {}) {
  if (saveInFlight) {
    await saveInFlight; // don't send two saves at once
    if (opts.auto) return true;
  }
  saveInFlight = doSave(opts);
  try { return await saveInFlight; } finally { saveInFlight = null; }
}

async function doSave({ auto = false } = {}) {
  if (auto ? !form.checkValidity() : !form.reportValidity()) return false;
  if (!auto) $('#formError').hidden = true;
  // Saved as Sent for Bid / Submitted and still locked: only the status change can be sent
  const lockedBody = () => ({ status: cur.status, completed: !!cur.completed });
  const body = savedLocked && isLocked(cur) ? lockedBody() : saveBody();
  const sent = JSON.stringify(body);
  try {
    const saved = cur._id
      ? await api(`${API}/${cur._id}`, { method: 'PUT', body: sent })
      : await api(API, { method: 'POST', body: sent });
    if (auto) {
      SERVER_FIELDS.forEach(k => { if (k in saved) cur[k] = saved[k]; });
      dirty = JSON.stringify(body.pages ? saveBody() : lockedBody()) !== sent; // still dirty if edited while saving
      savedLocked = isLocked(saved);
      $('#saveMsg').textContent = `Auto-saved ${new Date().toLocaleTimeString()}`;
      return true;
    }
    const wasNew = !cur._id;
    cur = saved;
    normalizeCur();
    renderPageTabs();
    dirty = false;
    savedLocked = isLocked(cur);
    applyLock();
    $('#saveMsg').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    if (wasNew) { history.replaceState(null, '', `/edit/${cur._id}`); lastPath = location.pathname; }
    $('#editorTitle').textContent = estLabel(cur);
    $('#excelBtn').disabled = false;
    $('#emailBtn').disabled = false;
    $('#proposalBtn').disabled = false;
    $('#packageBtn').disabled = false;
    updateSplitButtons();
    loadClientOptions().then(() => updateClientFlags()); // a newly typed client is now in the list
    renderLinks();
    return true;
  } catch (err) {
    if (auto) { $('#saveMsg').textContent = `Auto-save failed: ${err.message}`; return false; }
    $('#formError').textContent = err.message;
    $('#formError').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
}

$('#saveBtn').onclick = () => save();

// Auto-save every 5 minutes: only estimations that already exist, have unsaved changes and pass the required fields
const AUTO_SAVE_MS = 5 * 60 * 1000;
setInterval(() => {
  if (dirty && cur?._id && !$('#editorView').hidden) save({ auto: true });
}, AUTO_SAVE_MS);
$('#packageBtn').onclick = async () => {
  if (dirty && !(await save())) return;
  location.href = `${API}/${cur._id}/package`;
};
async function download(kind, separate = false) {
  if (dirty && !(await save())) return;
  location.href = `${API}/${cur._id}/${kind}${separate ? '?separate=1' : ''}`;
}
$('#proposalBtn').onclick = () => download('proposal');
$('#excelBtn').onclick = () => download('excel');

// ▾ menus next to Download Excel / Proposal: one file for all pages, or one file per page in a zip
const closeSplitMenus = () => document.querySelectorAll('.split-menu').forEach(m => { m.hidden = true; });
document.addEventListener('click', ev => {
  const caret = ev.target.closest('[data-menu]');
  const item = ev.target.closest('[data-download]');
  if (caret) {
    const menu = $(`#${caret.dataset.menu}`);
    const open = menu.hidden;
    closeSplitMenus();
    menu.hidden = !open;
    return;
  }
  closeSplitMenus();
  if (item) download(item.dataset.download, !!item.dataset.separate);
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeSplitMenus(); });

// The ▾ menus are always shown (a one-page chart gives a zip with one file); they need a saved estimation
function updateSplitButtons() {
  document.querySelectorAll('.split-caret').forEach(b => { b.disabled = !cur?._id; });
  if (!cur?._id) closeSplitMenus();
}
document.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's' && !$('#editorView').hidden) { ev.preventDefault(); save(); }
});

// =====================================================================
// REPLY EMAIL
// =====================================================================
const emailDialog = $('#emailDialog');
const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let currentEmail = null;

function emailOptions() {
  return {
    greeting: $('#emailGreeting').value,
    includeLinks: $('#emailLinks').checked,
    signature: $('#emailSignature').value.trim(),
  };
}

function refreshEmail() {
  currentEmail = window.EstEmail.build(cur, computeEstimation(cur).tonnage, emailOptions());
  $('#emailPreview').innerHTML = currentEmail.html;
}

$('#emailBtn').onclick = async () => {
  if (dirty && !(await save())) return;
  $('#emailGreeting').value = pref.get('email.greeting', 'Hi sir,');
  $('#emailSignature').value = pref.get('email.signature', '');
  $('#emailLinks').checked = pref.get('email.includeLinks', '1') === '1';
  $('#emailLinks').disabled = !cur.links.some(l => l.url);
  $('#emailMsg').textContent = '';
  refreshEmail();
  emailDialog.showModal();
};

['emailGreeting', 'emailSignature', 'emailLinks'].forEach(id => $(`#${id}`).addEventListener('input', () => {
  pref.set('email.greeting', $('#emailGreeting').value);
  pref.set('email.signature', $('#emailSignature').value);
  pref.set('email.includeLinks', $('#emailLinks').checked ? '1' : '0');
  refreshEmail();
}));

$('#emailClose').onclick = () => emailDialog.close();
$('#emailExcelBtn').onclick = () => { location.href = `${API}/${cur._id}/excel`; };

$('#emailCopyBtn').onclick = async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([currentEmail.html], { type: 'text/html' }),
      'text/plain': new Blob([currentEmail.text], { type: 'text/plain' }),
    })]);
  } catch {
    // Fallback: copy the rendered preview as a selection
    const range = document.createRange();
    range.selectNodeContents($('#emailPreview'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  $('#emailMsg').textContent = 'Copied — paste it into your Outlook reply.';
};

$('#emailMarkBtn').onclick = async () => {
  cur.status = 'Submitted';
  form.status.value = 'Submitted';
  dirty = true;
  if (await save()) $('#emailMsg').textContent = 'Status set to Submitted.';
};

// =====================================================================
// CLIENTS VIEW
// =====================================================================
let clientData = { clients: [], years: [], preferences: [] };

const prefClass = p => 'pref-' + String(p || 'none').toLowerCase().replace(/[^a-z]+/g, '-');
const fillSelect = (sel, values, first) => {
  const keep = sel.value;
  sel.innerHTML = (first ? `<option value="">${first}</option>` : '') + values.map(v => `<option>${esc(v)}</option>`).join('');
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
};

async function loadClients() {
  $('#lvHours').textContent = LESS_VALUE_HOURS;
  const q = $('#clientSearch').value.trim();
  clientData = await api(`${CLIENTS_API}${q ? '?q=' + encodeURIComponent(q) : ''}`);
  const leads = [...new Set(clientData.clients.map(c => c.salesLead).filter(Boolean))].sort();
  fillSelect($('#prefFilter'), clientData.preferences, 'All preferences');
  fillSelect($('#leadFilter'), leads, 'All sales leads');
  fillSelect($('#newClientPref'), ['', ...clientData.preferences]);
  $('#newClientPref').options[0].textContent = 'Client preference';
  $('#leadOptions').innerHTML = leads.map(l => `<option value="${esc(l)}">`).join('');
  renderClients();
}

function renderClients() {
  const { years, preferences } = clientData;
  let list = clientData.clients;
  const f = $('#clientFilter').value, pf = $('#prefFilter').value, lf = $('#leadFilter').value;
  if (f) list = list.filter(c => c.priority === (f === '1'));
  if (pf) list = list.filter(c => (c.preference || '') === pf);
  if (lf) list = list.filter(c => (c.salesLead || '') === lf);

  $('#clientHead').innerHTML = `<tr>
      <th style="width:110px">Priority</th><th>Client Names</th><th>Sales Lead</th><th>Client Preference</th>
      ${years.map(y => `<th class="num">${y}<div class="sub">Projects awarded</div></th>`).join('')}
      <th class="num">Total Awarded</th><th class="num">Estimations</th><th></th></tr>`;

  const maxTotal = Math.max(1, ...list.map(c => c.totalAwarded));
  $('#clientRows').innerHTML = list.map(c => `<tr class="${c.priority ? 'row-prio' : ''}">
      <td><button class="btn small ${c.priority ? 'prio-on' : 'prio-off'}" data-prio="${c.priority ? 0 : 1}" data-id="${c._id}"
        title="${c.priority ? 'Click to remove priority' : 'Click to mark as priority'}">${c.priority ? '★ Priority' : '☆ Mark'}</button></td>
      <td><input class="cell-edit name" data-id="${c._id}" data-field="name" value="${esc(c.name)}" data-orig="${esc(c.name)}" /></td>
      <td><input class="cell-edit lead" data-id="${c._id}" data-field="salesLead" list="leadOptions" value="${esc(c.salesLead)}" data-orig="${esc(c.salesLead)}" placeholder="—" /></td>
      <td><select class="cell-edit pref ${prefClass(c.preference)}" data-id="${c._id}" data-field="preference">
          <option value="">—</option>${preferences.map(p => `<option ${p === c.preference ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select></td>
      ${years.map(y => {
        const v = c.awarded[y] || 0, w = c.appWins[y] || 0;
        return `<td class="num"><input type="number" min="0" step="1" class="cell-edit yr ${v ? 'has' : ''}" data-id="${c._id}" data-year="${y}"
          value="${v}" data-orig="${v}" title="${w ? `Includes ${w} project(s) marked Won in this app` : 'Awarded projects'}" />${w ? `<span class="won-dot" title="${w} won in app">●</span>` : ''}</td>`;
      }).join('')}
      <td class="num total-cell"><span class="bar" style="width:${Math.round((c.totalAwarded / maxTotal) * 100)}%"></span><strong>${c.totalAwarded}</strong></td>
      <td class="num">${c.estimations}</td>
      <td class="actions-cell"><button class="btn small danger" data-del-client="${c._id}" data-name="${esc(c.name)}">Delete</button></td>
    </tr>`).join('');

  const sum = y => list.reduce((a, c) => a + (c.awarded[y] || 0), 0);
  $('#clientFoot').innerHTML = list.length ? `<tr><th colspan="4">Total (${list.length} clients)</th>
      ${years.map(y => `<th class="num">${sum(y)}</th>`).join('')}
      <th class="num">${list.reduce((a, c) => a + c.totalAwarded, 0)}</th><th class="num">${list.reduce((a, c) => a + c.estimations, 0)}</th><th></th></tr>` : '';
  $('#clientEmpty').hidden = list.length > 0;
  if (!can('manager')) {
    $('#clientRows').querySelectorAll('input, select').forEach(el => { el.disabled = true; });
    $('#clientRows').querySelectorAll('button').forEach(el => { el.hidden = !el.dataset.prio; el.disabled = true; });
  }
}

async function updateClient(id, body, msg) {
  try {
    await api(`${CLIENTS_API}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    if (msg) $('#clientMsg').textContent = msg;
    await loadClients();
  } catch (err) {
    alert(err.message);
    loadClients();
  }
}

$('#clientRows').addEventListener('click', async ev => {
  const d = ev.target.dataset;
  if (d.prio) updateClient(d.id, { priority: d.prio === '1' });
  else if (d.delClient && confirm(`Delete client "${d.name}" from the list? (Estimations are not affected)`)) {
    try { await api(`${CLIENTS_API}/${d.delClient}`, { method: 'DELETE' }); loadClients(); } catch (err) { alert(err.message); }
  }
});

$('#clientRows').addEventListener('change', ev => {
  const el = ev.target, d = el.dataset;
  if (!d.id) return;
  if (d.year) {
    if (el.value === d.orig) return;
    return updateClient(d.id, { awarded: { [d.year]: Math.max(0, parseInt(el.value, 10) || 0) } }, `Awarded ${d.year} updated`);
  }
  const value = el.value.trim();
  if (d.field === 'name' && !value) { el.value = d.orig; return; }
  if (el.tagName === 'INPUT' && value === d.orig) return;
  updateClient(d.id, { [d.field]: value }, 'Saved');
});
$('#clientRows').addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('input.cell-edit')) ev.target.blur(); });

$('#addClientBtn').onclick = async () => {
  const name = $('#newClientName').value.trim();
  if (!name) return $('#newClientName').focus();
  try {
    await api(CLIENTS_API, { method: 'POST', body: JSON.stringify({
      name, priority: $('#newClientPriority').checked, salesLead: $('#newClientLead').value.trim(), preference: $('#newClientPref').value,
    }) });
    $('#newClientName').value = '';
    $('#newClientPriority').checked = false;
    $('#clientMsg').textContent = `Added "${name}"`;
    loadClients();
  } catch (err) { $('#clientMsg').textContent = ''; alert(err.message); }
};
$('#newClientName').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('#addClientBtn').click(); });

$('#importBtn').onclick = async () => {
  const file = $('#importFile').files[0];
  if (!file) return alert('Choose an Excel (.xlsx) or CSV file first.');
  $('#importMsg').textContent = 'Importing…';
  try {
    const res = await fetch(`${CLIENTS_API}/import?priority=${$('#importPriority').checked ? 1 : 0}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Import failed');
    const cols = [r.columns.salesLead && 'Sales Lead', r.columns.preference && 'Client preference',
      r.columns.years.length && `awarded ${r.columns.years.join(', ')}`, r.columns.priority && 'Priority'].filter(Boolean);
    $('#importMsg').textContent = `Imported: ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged/skipped.` +
      (cols.length ? ` Columns read: ${cols.join(', ')}.` : '');
    $('#importFile').value = '';
    loadClients();
  } catch (err) { $('#importMsg').textContent = ''; alert(err.message); }
};

let clientSearchTimer;
$('#clientSearch').oninput = () => { clearTimeout(clientSearchTimer); clientSearchTimer = setTimeout(loadClients, 250); };
['#clientFilter', '#prefFilter', '#leadFilter'].forEach(sel => { $(sel).onchange = renderClients; });

// =====================================================================
// ACTIVITY LOG (Admin)
// =====================================================================
let logPage = 1;
const fmtDateTime = d => new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const METHOD_CLS = { POST: 'm-post', PUT: 'm-put', PATCH: 'm-put', DELETE: 'm-del' };

async function loadLog(page = logPage) {
  const params = new URLSearchParams();
  const set = (k, v) => { if (v) params.set(k, v); };
  set('q', $('#logSearch').value.trim());
  set('user', $('#logUser').value);
  set('result', $('#logResult').value);
  set('from', $('#logFrom').value);
  set('to', $('#logTo').value);
  $('#logClear').hidden = !params.toString();
  params.set('tz', new Date().getTimezoneOffset());
  params.set('page', page);
  const r = await api(`/api/logs?${params}`);
  logPage = r.page;

  // User filter: keep the current choice while refreshing the options
  const sel = $('#logUser'), chosen = sel.value;
  sel.innerHTML = '<option value="">All users</option>' + r.users.map(u => `<option value="${esc(u.username)}">${esc(u.name)}${u.name !== u.username ? ` (${esc(u.username)})` : ''}</option>`).join('');
  sel.value = chosen;

  $('#logRows').innerHTML = r.items.map(l => `<tr class="${l.ok ? '' : 'log-failed'}">
      <td>${fmtDateTime(l.at)}</td>
      <td>${l.user || l.username ? `<strong>${esc(l.user || l.username)}</strong>${l.username && l.user ? `<div class="sub">${esc(l.username)}</div>` : ''}` : '<span class="sub">—</span>'}</td>
      <td><code>${esc(l.ip) || '—'}</code></td>
      <td><span class="method ${METHOD_CLS[l.method] || ''}" title="${esc(l.method + ' ' + l.path)}">${esc(l.method)}</span> ${esc(l.action)}</td>
      <td class="log-target" title="${esc(l.target)}">${esc(l.target) || '—'}</td>
      <td class="log-details" title="${esc(l.details)}">${esc(l.details) || '—'}</td>
      <td>${l.ok ? '<span class="log-ok">✓ OK</span>'
        : `<span class="log-err" title="${esc(l.error)}">✕ ${l.status}</span>${l.error ? `<div class="sub log-error-msg">${esc(l.error)}</div>` : ''}`}</td>
    </tr>`).join('');
  $('#logEmpty').hidden = r.items.length > 0;
  renderPager('#logPager', r, r.total === 1 ? 'entry' : 'entries', p => loadLog(p).then(() => window.scrollTo(0, 0)));
}

['#logUser', '#logResult', '#logFrom', '#logTo'].forEach(sel => { $(sel).onchange = () => loadLog(1); });
let logSearchTimer;
$('#logSearch').oninput = () => { clearTimeout(logSearchTimer); logSearchTimer = setTimeout(() => loadLog(1), 250); };
$('#logClear').onclick = () => {
  ['#logSearch', '#logUser', '#logResult', '#logFrom', '#logTo'].forEach(sel => { $(sel).value = ''; });
  loadLog(1);
};
$('#logRefresh').onclick = () => loadLog(1);

// =====================================================================
// COMPLETED LOG (all users)
// =====================================================================
let compPage = 1;
const localDay = d => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// Completed on / before the due date, or how many days late
function onTime(e) {
  if (!e.dueDate || !e.completedAt) return '<span class="sub">—</span>';
  const late = Math.round((Date.parse(localDay(e.completedAt)) - Date.parse(toInputDate(e.dueDate))) / 86400000);
  return late <= 0 ? '<span class="due due-ok">On time</span>'
    : `<span class="due due-over">${late} day${late === 1 ? '' : 's'} late</span>`;
}

async function loadCompleted(page = compPage) {
  const params = new URLSearchParams();
  const set = (k, v) => { if (v) params.set(k, v); };
  set('q', $('#compSearch').value.trim());
  set('from', $('#compFrom').value);
  set('to', $('#compTo').value);
  $('#compClear').hidden = !params.toString();
  params.set('tz', new Date().getTimezoneOffset());
  params.set('page', page);
  const r = await api(`${API}/completed?${params}`);
  compPage = r.page;
  const first = (r.page - 1) * r.pageSize;
  $('#compRows').innerHTML = r.items.map((e, i) => `<tr class="row-link ${e.status === 'Won' ? 'row-won' : ''}" data-open-id="${e._id}" title="Click to open">
      <td class="num sl-no">${first + i + 1}</td>
      <td><a href="/edit/${e._id}"><strong>${esc(e.jobNo) || '—'}</strong></a></td>
      <td class="project-cell" title="${esc(e.projectName)}">${esc(e.projectName)}</td>
      <td>${e.priorityClient ? '<span class="star" title="Priority client">★</span> ' : ''}${esc(e.clientName)}</td>
      <td>${esc(e.doneBy) || '—'}</td>
      <td class="num">${fmt(e.totalHours)}</td>
      <td class="num"><strong>${fmt(e.approxTonnage)}</strong></td>
      <td>${fmtDate(e.dueDate)}</td>
      <td>${e.completedAt ? fmtDateTime(e.completedAt) : '—'}</td>
      <td>${esc(e.completedBy) || '<span class="sub">—</span>'}</td>
      <td>${onTime(e)}</td>
    </tr>`).join('');
  $('#compEmpty').hidden = r.items.length > 0;
  renderPager('#compPager', r, `completed estimation${r.total === 1 ? '' : 's'}`, p => loadCompleted(p).then(() => window.scrollTo(0, 0)));
}

$('#compRows').addEventListener('click', ev => {
  if (ev.target.closest('a, button')) return;
  const row = ev.target.closest('tr[data-open-id]');
  if (!row || getSelection().toString()) return;
  const url = `/edit/${row.dataset.openId}`;
  if (ev.ctrlKey || ev.metaKey) window.open(url, '_blank');
  else go(url);
});
let compSearchTimer;
$('#compSearch').oninput = () => { clearTimeout(compSearchTimer); compSearchTimer = setTimeout(() => loadCompleted(1), 250); };
$('#compFrom').onchange = () => loadCompleted(1);
$('#compTo').onchange = () => loadCompleted(1);
$('#compClear').onclick = () => { ['#compSearch', '#compFrom', '#compTo'].forEach(s => { $(s).value = ''; }); loadCompleted(1); };

// =====================================================================
// NOTIFICATIONS (estimations changed after being marked Completed)
// =====================================================================
let notifPage = 1;

// Unread count shown next to "Notifications" in the menu
async function refreshNotifCount() {
  if (!can('team_leader')) return;
  const { unread } = await api('/api/notifications/count').catch(() => ({ unread: 0 }));
  $('#notifCount').textContent = unread > 99 ? '99+' : unread;
  $('#notifCount').hidden = !unread;
}
setInterval(refreshNotifCount, 60 * 1000);

const notifChange = c => c.from !== undefined
  ? `<li><strong>${esc(c.label)}:</strong> <span class="old-val">${esc(c.from)}</span> → <span class="new-val">${esc(c.to)}</span></li>`
  : `<li><strong>${esc(c.label)}</strong></li>`;

async function loadNotifications(page = notifPage) {
  const params = new URLSearchParams({ page });
  if ($('#notifUnread').checked) params.set('unread', '1');
  const r = await api(`/api/notifications?${params}`);
  notifPage = r.page;
  $('#notifRows').innerHTML = r.items.map(n => `<tr class="${n.read ? 'notif-read' : 'notif-unread'}">
      <td>${fmtDateTime(n.createdAt)}</td>
      <td>${n.action === 'Deleted' ? `<strong>${esc(n.jobNo) || '—'}</strong>` : `<a href="/edit/${n.estimation}"><strong>${esc(n.jobNo) || '—'}</strong></a>`}</td>
      <td class="project-cell" title="${esc(n.projectName)}">${esc(n.projectName)}</td>
      <td>${esc(n.clientName) || '—'}</td>
      <td>${esc(n.by) || '<span class="sub">—</span>'}${n.byRole ? `<div class="sub">${esc(ROLE_NAMES[n.byRole] || n.byRole)}</div>` : ''}</td>
      <td><span class="notif-action ${n.action === 'Edited after completion' ? '' : 'warn'}">${esc(n.action)}</span></td>
      <td>${n.changes?.length ? `<ul class="notif-changes">${n.changes.map(notifChange).join('')}</ul>` : '—'}</td>
      <td>${n.completedAt ? fmtDate(n.completedAt) : '—'}</td>
      <td class="actions-cell"><button class="btn small" data-notif="${n._id}" data-read="${n.read ? 0 : 1}">${n.read ? 'Mark unread' : 'Mark read'}</button></td>
    </tr>`).join('');
  $('#notifEmpty').hidden = r.items.length > 0;
  renderPager('#notifPager', r, `notification${r.total === 1 ? '' : 's'}`, p => loadNotifications(p).then(() => window.scrollTo(0, 0)),
    ` · <strong>${r.unread}</strong> unread`);
  $('#notifReadAll').disabled = !r.unread;
  $('#notifCount').textContent = r.unread > 99 ? '99+' : r.unread;
  $('#notifCount').hidden = !r.unread;
}

$('#notifRows').addEventListener('click', async ev => {
  const d = ev.target.dataset;
  if (!d.notif) return;
  try {
    await api(`/api/notifications/${d.notif}`, { method: 'PUT', body: JSON.stringify({ read: d.read === '1' }) });
    loadNotifications();
  } catch (err) { if (!err.silent) alert(err.message); }
});
$('#notifReadAll').onclick = async () => {
  if (!confirm('Mark all notifications as read?')) return;
  try { await api('/api/notifications/read-all', { method: 'PUT' }); loadNotifications(1); } catch (err) { if (!err.silent) alert(err.message); }
};
$('#notifUnread').onchange = () => loadNotifications(1);
$('#notifRefresh').onclick = () => loadNotifications(1);

// =====================================================================
// CALENDAR (projects by due date)
// =====================================================================
// calSel: the picked day; calView: the month shown (both kept while moving between pages)
let calSel = null, calView = null;
const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10); // month may over/underflow
const isOpenOverdue = e => !e.completed && !CLOSED.includes(e.status) && toInputDate(e.dueDate) < today();

async function loadCalendar() {
  calSel = calSel || today();
  if (!calView) { const [y, m] = calSel.split('-').map(Number); calView = { y, m: m - 1 }; }
  $('#calDate').value = calSel;
  await Promise.all([loadCalendarMonth(), loadCalendarDay()]);
}

// Open / overdue / sent for bid: the colour of a project in the calendar
const calState = e => (e.completed ? 'done' : isOpenOverdue(e) ? 'over' : 'open');
// Badge colour by number of projects due: 1-4 green, 5-8 yellow, 9+ red
const calLevel = n => (n >= 9 ? 'high' : n >= 5 ? 'mid' : 'low');

// "12 due · 3 overdue · 5 sent for bid" (only the parts that apply)
function calCounts(list) {
  if (!list.length) return '<span class="cal-pill">Nothing due</span>';
  const over = list.filter(isOpenOverdue).length, done = list.filter(e => e.completed).length;
  return `<span class="cal-pill">${list.length} due</span>` +
    (over ? `<span class="cal-pill over">${over} overdue</span>` : '') +
    (done ? `<span class="cal-pill done">${done} sent for bid</span>` : '');
}

// Month grid: 6 weeks from the Sunday on or before the 1st; each day shows how many projects are due
async function loadCalendarMonth() {
  const { y, m } = calView;
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = Array.from({ length: 42 }, (_, i) => ymd(y, m, 1 - lead + i));
  const items = await api(`${API}/calendar?from=${days[0]}&to=${days[41]}`);
  const count = {};
  items.forEach(e => { const d = toInputDate(e.dueDate); count[d] = (count[d] || 0) + 1; });
  $('#calMonth').textContent = `${CAL_MONTHS[m]} ${y}`;
  const monthKey = ymd(y, m, 1).slice(0, 7);
  const now = today();
  $('#calGrid').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="cal-wd">${d}</div>`).join('') +
    days.map(day => {
      const n = count[day] || 0;
      const cls = ['cal-day', day.slice(0, 7) !== monthKey && 'other', day === now && 'today', day === calSel && 'selected'].filter(Boolean).join(' ');
      const label = `${fmtDate(`${day}T00:00:00Z`)}: ${n ? `${n} project${n === 1 ? '' : 's'} due` : 'nothing due'}`;
      return `<div class="${cls}" data-cal-day="${day}" role="button" tabindex="0" title="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${day === calSel}">
        <span class="cal-num">${+day.slice(8)}</span>
        ${n ? `<span class="cal-badge ${calLevel(n)}">${n}</span>` : ''}</div>`;
    }).join('');
}

// Projects due on the picked day
async function loadCalendarDay() {
  const items = await api(`${API}/calendar?from=${calSel}&to=${calSel}`);
  const d = new Date(`${calSel}T00:00:00Z`);
  $('#calDayTitle').textContent = `Due on ${d.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}` +
    (calSel === today() ? ' (today)' : '');
  $('#calDayCount').innerHTML = calCounts(items);
  $('#calRows').innerHTML = items.map((e, i) => {
    const due = dueInfo(e.dueDate, e.status, e.completed);
    return `<tr class="row-link cal-row-${calState(e)} ${e.status === 'Won' ? 'row-won' : e.completed ? 'row-done' : ''}" data-open-id="${e._id}" title="Click to open">
      <td class="num sl-no">${i + 1}</td>
      <td><a href="/edit/${e._id}"><strong>${esc(e.jobNo) || '—'}</strong></a></td>
      <td class="project-cell" title="${esc(e.projectName)}">${esc(e.projectName)}</td>
      <td>${e.priorityClient ? '<span class="star" title="Priority client">★</span> ' : ''}${esc(e.clientName)}</td>
      <td>${esc(e.doneBy) || '—'}</td>
      <td class="num">${fmt(e.totalHours)}</td>
      <td class="num"><strong>${fmt(e.approxTonnage)}</strong></td>
      <td>${e.completed ? `<span class="due due-closed">Sent${e.completedAt ? ` ${new Date(e.completedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}</span>` : due ? `<span class="due ${due.cls}">${due.text}</span>` : '—'}</td>
      <td>${e.completed ? '<span class="badge Completed">✓ Sent for Bid</span>' : `<span class="badge ${statusClass(e.status)}">${esc(e.status)}</span>`}</td>
    </tr>`;
  }).join('');
  $('#calEmpty').hidden = items.length > 0;
}

function calPick(day) {
  calSel = day;
  $('#calDate').value = day;
  const [y, m] = day.split('-').map(Number);
  const monthChanged = y !== calView.y || m - 1 !== calView.m;
  calView = { y, m: m - 1 };
  if (monthChanged) loadCalendarMonth();
  else document.querySelectorAll('#calGrid .cal-day').forEach(b => {
    b.classList.toggle('selected', b.dataset.calDay === day);
    b.setAttribute('aria-pressed', b.dataset.calDay === day);
  });
  loadCalendarDay();
}
// Click a day to list it below (a project inside a day opens that project); Enter / Space work too
$('#calGrid').addEventListener('click', ev => {
  if (ev.target.closest('a')) return;
  const b = ev.target.closest('[data-cal-day]');
  if (b) calPick(b.dataset.calDay);
});
$('#calGrid').addEventListener('keydown', ev => {
  const b = ev.target.closest('[data-cal-day]');
  if (b && ev.target === b && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); calPick(b.dataset.calDay); }
});
$('#calDate').onchange = () => { if ($('#calDate').value) calPick($('#calDate').value); };
$('#calToday').onclick = () => calPick(today());
const calShift = n => { const d = new Date(Date.UTC(calView.y, calView.m + n, 1)); calView = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; loadCalendarMonth(); };
$('#calPrev').onclick = () => calShift(-1);
$('#calNext').onclick = () => calShift(1);
$('#calDayPrev').onclick = () => calPick(addDays(calSel, -1));
$('#calDayNext').onclick = () => calPick(addDays(calSel, 1));
$('#calRows').addEventListener('click', ev => {
  if (ev.target.closest('a, button')) return;
  const row = ev.target.closest('tr[data-open-id]');
  if (!row || getSelection().toString()) return;
  const url = `/edit/${row.dataset.openId}`;
  if (ev.ctrlKey || ev.metaKey) window.open(url, '_blank');
  else go(url);
});

// =====================================================================
// IMPORT EXCEL (Admin): pick a project, upload an Estimation Chart workbook, fill its pages
// =====================================================================
let impProject = null; // selected estimation (card details)
let impSearchTimer = null;
const impMsg = (text, ok = true) => { $('#impMsg').textContent = text; $('#impMsg').classList.toggle('error', !ok); };

async function openImport() {
  if (impProject) return showImportCard(impProject._id); // keep the selection when coming back
  $('#impSearch').value = '';
  await searchImport();
  $('#impSearch').focus();
}

async function searchImport() {
  const q = $('#impSearch').value.trim();
  const list = await api(`${API}/import-search?q=${encodeURIComponent(q)}`);
  $('#impResults').innerHTML = list.length
    ? (q ? '' : '<p>Most recent projects — type to search all</p>') + list.map(e => `<button type="button" data-imp="${e._id}">
        <span class="imp-no">${esc(e.jobNo) || '—'}</span><span class="imp-name">${esc(e.projectName)}</span>
        <span class="sub">${esc(e.clientName)}</span>
        ${e.completed ? '<span class="badge Completed">✓ Sent for Bid</span>' : `<span class="badge ${statusClass(e.status)}">${esc(e.status)}</span>`}</button>`).join('')
    : '<p>No projects found.</p>';
}

$('#impSearch').addEventListener('input', () => {
  clearTimeout(impSearchTimer);
  impSearchTimer = setTimeout(() => searchImport().catch(err => { if (!err.silent) alert(err.message); }), 250);
});
$('#impResults').addEventListener('click', ev => {
  const b = ev.target.closest('[data-imp]');
  if (b) showImportCard(b.dataset.imp).catch(err => { if (!err.silent) alert(err.message); });
});
$('#impChange').onclick = () => {
  impProject = null;
  $('#impCard').hidden = $('#impUpload').hidden = true;
  $('#impSearch').closest('section').hidden = false;
  openImport().catch(err => { if (!err.silent) alert(err.message); });
};

async function showImportCard(id) {
  const e = impProject = await api(`${API}/${id}/import-card`);
  $('#impSearch').closest('section').hidden = true;
  $('#impCard').hidden = $('#impUpload').hidden = false;
  $('#impTitle').textContent = estLabel(e);
  $('#impOpen').href = `/edit/${e._id}`;
  const due = dueInfo(e.dueDate, e.status, e.completed);
  const field = (label, value) => `<div><span class="sub">${label}</span><strong>${value}</strong></div>`;
  $('#impDetails').innerHTML = [
    field('No.', esc(e.jobNo) || '—'),
    field('Project', esc(e.projectName)),
    field('Client', `${e.priorityClient ? '<span class="star" title="Priority client">★</span> ' : ''}${esc(e.clientName)}`),
    field('Status', e.completed ? '<span class="badge Completed">✓ Sent for Bid</span>' : `<span class="badge ${statusClass(e.status)}">${esc(e.status)}</span>`),
    field('Date', fmtDate(e.date)),
    field('Due date', `${fmtDate(e.dueDate)}${due && !e.completed ? ` <span class="due ${due.cls}">${due.text}</span>` : ''}`),
    field('Done by', esc(e.doneBy) || '—'),
    field('Contact', esc(e.contactPerson) || '—'),
    field('Chart pages', e.pageNames.length ? esc(e.pageNames.join(', ')) : '—'),
    field('Sheets', fmt(e.sheetCount)),
    field('Total hours', fmt(e.totalHours)),
    field('Tonnage', `${fmt(e.approxTonnage)} t`),
    field('No. of drawings', fmt(e.totalDwgs)),
    field('Last changed', `${fmtDate(e.updatedAt)}${e.updatedBy ? ` by ${esc(e.updatedBy)}` : ''}`),
  ].join('');
  const locked = isLocked(e);
  $('#impLocked').hidden = !locked;
  $('#impLocked').textContent = locked ? `🔒 This project is ${e.completed ? 'Sent for Bid' : 'Submitted'} — change its status before importing.` : '';
  $('#impFile').value = '';
  $('#impPreview').innerHTML = '';
  $('#impActions').hidden = true;
  impMsg('');
}

// Read the chosen file and show what would be filled (nothing is saved yet)
async function previewImport() {
  const file = $('#impFile').files[0];
  $('#impActions').hidden = true;
  $('#impPreview').innerHTML = '';
  if (!file || !impProject) return impMsg('');
  impMsg('Reading the file…');
  try {
    const r = await api(`${API}/${impProject._id}/import-preview?mode=${$('#impMode').value}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const tot = k => r.summary.reduce((a, p) => a + p[k], 0);
    $('#impPreview').innerHTML = `
      ${r.warnings.length ? `<div class="imp-warn"><strong>Please check:</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="table-wrap"><table class="list">
        <thead><tr><th>Page (worksheet)</th><th class="num">Sheets</th><th class="num">Total qty</th><th class="num">Hours</th>
          <th class="num">Tonnage</th><th class="num">Drawings</th><th class="num">Struct. lines</th><th class="num">Misc. lines</th></tr></thead>
        <tbody>${r.summary.map(p => `<tr><td><strong>${esc(p.name)}</strong></td><td class="num">${p.sheets}</td><td class="num">${fmt(p.totalCount)}</td>
          <td class="num">${fmt(p.totalHours)}</td><td class="num">${fmt(p.tonnage)}</td><td class="num">${fmt(p.totalDwgs)}</td>
          <td class="num">${p.structLines}</td><td class="num">${p.miscLines}</td></tr>`).join('')}
          ${r.summary.length > 1 ? `<tr><td><strong>Total</strong></td><td class="num">${tot('sheets')}</td><td class="num">${fmt(tot('totalCount'))}</td>
            <td class="num"><strong>${fmt(tot('totalHours'))}</strong></td><td class="num"><strong>${fmt(tot('tonnage'))}</strong></td>
            <td class="num">${fmt(tot('totalDwgs'))}</td><td></td><td></td></tr>` : ''}</tbody>
      </table></div>
      <p class="hint">File: ${esc(r.header.project) || '—'} · Client: ${esc(r.header.client) || '—'} · Done by: ${esc(r.header.doneBy) || '—'}
        ${r.exclusions.length ? ` · ${r.exclusions.length} exclusion(s) will replace the project's Specific Exclusions` : ''}</p>`;
    $('#impActions').hidden = isLocked(impProject);
    impMsg(r.mode === 'replace' && r.existingPages
      ? `Nothing saved yet. Filling will REPLACE the project's ${r.existingPages} existing page(s) with the ${r.summary.length} page(s) above.`
      : `Nothing saved yet. Filling will add ${r.summary.length} page(s) to the project.`);
  } catch (err) {
    if (!err.silent) impMsg(err.message, false);
  }
}
$('#impFile').onchange = previewImport;
$('#impMode').onchange = previewImport;

$('#impFillBtn').onclick = async ev => {
  const file = $('#impFile').files[0];
  if (!file || !impProject) return;
  const replace = $('#impMode').value === 'replace' && impProject.pageNames.length;
  if (!confirm(replace ? `Replace the chart pages of ${estLabel(impProject)} with the file's data?` : `Fill ${estLabel(impProject)} with the file's data?`)) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  impMsg('Saving…');
  try {
    const r = await api(`${API}/${impProject._id}/import-excel?mode=${$('#impMode').value}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    await showImportCard(impProject._id);
    impMsg(`Done — the project now has ${r.pageCount} page(s), ${fmt(r.totalHours)} hours, ${fmt(r.approxTonnage)} t. Use “Open project” to check it.`);
  } catch (err) {
    if (!err.silent) impMsg(err.message, false);
  } finally {
    btn.disabled = false;
  }
};

// =====================================================================
// BACKUPS (Admin)
// =====================================================================
const BACKUP_TYPES = {
  auto: ['Automatic', 'Weekly backup (Sunday 6 AM)'],
  hourly: ['Hourly', 'Estimations only, every hour — restoring it replaces just the estimations'],
  manual: ['Manual', 'Made with “Back up now”'],
  'pre-restore': ['Before restore', 'The data as it was just before a restore — restore this to undo it'],
  uploaded: ['Uploaded', 'A backup file that was restored from this computer'],
};
const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const backupMsg = (text, ok = true) => { $('#backupMsg').textContent = text; $('#backupMsg').classList.toggle('error', !ok); };

async function loadBackups() {
  const r = await api('/api/backups');
  const lastAuto = r.items.find(b => b.type === 'auto');
  $('#backupInfo').innerHTML = `
    <div><span class="sub">Automatic backup</span><strong>${esc(r.schedule)}</strong></div>
    <div><span class="sub">Next automatic backup</span><strong>${fmtDateTime(r.nextRun)}</strong></div>
    <div><span class="sub">Last automatic backup</span><strong>${lastAuto ? fmtDateTime(lastAuto.createdAt) : 'None yet'}</strong></div>
    <div><span class="sub">Hourly backup (estimations)</span><strong>Every hour · next ${fmtDateTime(r.nextHourly)}</strong></div>
    <div><span class="sub">Kept</span><strong>Last ${r.keepAuto} automatic · hourly for ${r.hourlyKeepDays} days · manual ones until deleted</strong></div>
    <div class="wide"><span class="sub">Saved in (on the server)</span><code>${esc(r.dir)}</code></div>
    ${r.lastAutoError ? `<div class="wide error">Last automatic backup failed (${fmtDateTime(r.lastAutoError.at)}): ${esc(r.lastAutoError.message)}</div>` : ''}
    ${r.lastHourlyError ? `<div class="wide error">Last hourly backup failed (${fmtDateTime(r.lastHourlyError.at)}): ${esc(r.lastHourlyError.message)}</div>` : ''}`;
  const show = $('#backupFilter').value;
  const items = r.items.filter(b => !show || (show === 'hourly' ? b.type === 'hourly' : b.type !== 'hourly'));
  $('#backupRows').innerHTML = items.map(b => {
    const [label, tip] = BACKUP_TYPES[b.type] || [b.type, ''];
    const n = encodeURIComponent(b.name);
    return `<tr>
      <td><strong>${fmtDateTime(b.createdAt)}</strong><div class="sub">${esc(b.name)}</div></td>
      <td><span class="backup-type ${b.type}" title="${esc(tip)}">${label}</span></td>
      <td class="num">${fmtSize(b.size)}</td>
      <td class="actions-cell">
        <a class="btn small" href="/api/backups/${n}/download" download title="Save this backup file on this computer">Download</a>
        <button type="button" class="btn small" data-restore="${esc(b.name)}" data-when="${esc(fmtDateTime(b.createdAt))}" data-type="${esc(b.type)}">Restore</button>
        <button type="button" class="btn small danger icon-btn" data-del-backup="${esc(b.name)}" title="Delete this backup" aria-label="Delete">${TRASH_ICON}</button>
      </td></tr>`;
  }).join('');
  $('#backupEmpty').hidden = items.length > 0;
}
$('#backupFilter').onchange = () => loadBackups().catch(err => backupMsg(err.message, false));

// Restoring replaces everything: ask the admin to type RESTORE
const confirmRestore = (what, hourly = false) => prompt(`Restore ${what}?\n\n${hourly ? 'All estimations' : 'All estimations, clients, users and notifications'} will be REPLACED with the backup's. ` +
  'A backup of the current data is made first, so this can be undone.\n\nType RESTORE to continue.')?.trim().toUpperCase() === 'RESTORE';

function restoreDone(r) {
  alert(`Restore complete: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.\n\n` +
    `The data from before the restore was saved as "${r.safetyBackup}". The page will now reload.`);
  location.reload();
}

async function withBackupBusy(btn, text, fn) {
  const buttons = document.querySelectorAll('#backupsView button');
  buttons.forEach(b => { b.disabled = true; });
  backupMsg(text);
  try { await fn(); } catch (err) { if (!err.silent) backupMsg(err.message, false); } finally { buttons.forEach(b => { b.disabled = false; }); }
}

$('#backupNowBtn').onclick = ev => withBackupBusy(ev.currentTarget, 'Backing up…', async () => {
  const r = await api('/api/backups', { method: 'POST' });
  await loadBackups();
  backupMsg(`Backup saved (${fmtSize(r.size)}): ${r.counts.estimations} estimations, ${r.counts.clients} clients, ${r.counts.users} users.`);
});

$('#backupRows').addEventListener('click', async ev => {
  const restoreBtn = ev.target.closest('[data-restore]');
  const delBtn = ev.target.closest('[data-del-backup]');
  if (restoreBtn) {
    if (!confirmRestore(`the backup from ${restoreBtn.dataset.when}`, restoreBtn.dataset.type === 'hourly')) return;
    await withBackupBusy(restoreBtn, 'Restoring… please wait', async () => {
      restoreDone(await api(`/api/backups/${encodeURIComponent(restoreBtn.dataset.restore)}/restore`, { method: 'POST' }));
    });
  } else if (delBtn) {
    if (!confirm('Delete this backup? It cannot be recovered.')) return;
    await withBackupBusy(delBtn, 'Deleting…', async () => {
      await api(`/api/backups/${encodeURIComponent(delBtn.dataset.delBackup)}`, { method: 'DELETE' });
      await loadBackups();
      backupMsg('Backup deleted.');
    });
  }
});

$('#restoreFileBtn').onclick = async ev => {
  const file = $('#restoreFile').files[0];
  if (!file) return alert('Choose a backup file (.json.gz) first.');
  if (!confirmRestore(`from the file "${file.name}"`)) return;
  await withBackupBusy(ev.currentTarget, 'Uploading and restoring… please wait', async () => {
    restoreDone(await api('/api/backups/upload-restore', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }));
  });
};

// =====================================================================
// ROUTER
// =====================================================================
async function route() {
  if (!me) return;
  let path = location.pathname;
  const is = p => path === p || path.startsWith(`${p}/`);
  if (((is('/users') || is('/log') || is('/backups') || is('/import')) && !can('admin')) || (is('/notifications') && !can('team_leader'))) {
    history.replaceState(null, '', '/'); path = '/'; lastPath = path;
  }
  const editing = is('/new') || path.startsWith('/edit/');
  const clients = is('/clients');
  const users = is('/users');
  const log = is('/log');
  const notif = is('/notifications');
  const completed = is('/completed');
  const calendar = is('/calendar');
  const backups = is('/backups');
  const importing = is('/import');
  $('#listView').hidden = editing || clients || users || log || notif || completed || calendar || backups || importing;
  $('#importView').hidden = !importing;
  $('#navImport').classList.toggle('active', importing);
  $('#backupsView').hidden = !backups;
  $('#navBackups').classList.toggle('active', backups);
  $('#completedView').hidden = !completed;
  $('#navCompleted').classList.toggle('active', completed);
  $('#calendarView').hidden = !calendar;
  $('#navCalendar').classList.toggle('active', calendar);
  $('#editorView').hidden = !editing;
  $('#clientsView').hidden = !clients;
  $('#usersView').hidden = !users;
  $('#logView').hidden = !log;
  $('#notifView').hidden = !notif;
  $('#newBtn').hidden = editing;
  $('#navEst').classList.toggle('active', !clients && !users && !log && !notif && !completed && !calendar && !backups && !importing);
  $('#navClients').classList.toggle('active', clients);
  $('#navNotif').classList.toggle('active', notif);
  $('#navUsers').classList.toggle('active', users);
  $('#navLog').classList.toggle('active', log);
  try {
    if (path.startsWith('/edit/')) await openEditor(decodeURIComponent(path.slice(6)));
    else if (editing) await openEditor(null);
    else if (clients) await loadClients();
    else if (users) await loadUsers();
    else if (log) await loadLog(1);
    else if (notif) await loadNotifications(1);
    else if (completed) await loadCompleted(1);
    else if (calendar) await loadCalendar();
    else if (backups) await loadBackups();
    else if (importing) await openImport();
    else { await loadList(); refreshNotifCount(); }
  } catch (err) {
    if (err.silent) return;
    alert(err.message);
    go('/');
  }
  window.scrollTo(0, 0);
}

// Old links / bookmarks used "#/edit/…" style addresses: turn them into the plain path
if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1) || '/');
let lastPath = location.pathname;

const leaveEditorOk = () => !(dirty && !$('#editorView').hidden && !confirm('You have unsaved changes. Leave anyway?'));

// Go to a page of the app without reloading
function go(path) {
  if (path === location.pathname) { if (leaveEditorOk()) { dirty = false; route(); } return; }
  if (!leaveEditorOk()) return;
  history.pushState(null, '', path);
  lastPath = location.pathname;
  dirty = false;
  route();
}

// Links inside the app (href="/…") change the page without a full reload; Ctrl/⌘/middle-click still open a new tab
document.addEventListener('click', ev => {
  const a = ev.target.closest('a[href^="/"]');
  if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
  if (a.target === '_blank' || a.hasAttribute('download') || a.getAttribute('href').startsWith('/api/')) return;
  ev.preventDefault();
  go(a.getAttribute('href'));
});

// Browser Back / Forward
window.addEventListener('popstate', () => {
  if (location.pathname === lastPath) return;
  if (!leaveEditorOk()) { history.pushState(null, '', lastPath); return; }
  lastPath = location.pathname;
  dirty = false;
  route();
});
window.addEventListener('beforeunload', ev => { if (dirty) ev.preventDefault(); });

// The chart scrolls inside its own box, so CSS sticky alone pins its headings to that box.
// When the page scrolls the box under the editor bar, push the headings down to sit just below the bar.
function pinChartHeadings() {
  const bar = $('#editorView .editor-bar');
  if (!bar || $('#editorView').hidden) return;
  const barBottom = bar.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--editor-bar-h', `${bar.offsetHeight}px`); // sticky description headings
  document.querySelectorAll('.chart-wrap').forEach(wrap => {
    const head = wrap.querySelector('thead');
    const maxOffset = Math.max(0, wrap.clientHeight - (head ? head.offsetHeight : 0));
    const offset = Math.min(maxOffset, Math.max(0, barBottom - wrap.getBoundingClientRect().top));
    wrap.style.setProperty('--head-offset', `${offset}px`);
  });
}
window.addEventListener('scroll', pinChartHeadings, { passive: true });
window.addEventListener('resize', pinChartHeadings);

const statusOpts = STATUSES.map(s => `<option>${s}</option>`).join('');
$('#statusFilter').insertAdjacentHTML('beforeend', statusOpts);
$('#statusSelect').innerHTML = statusOpts + `<option value="${COMPLETED_OPT}">✓ Sent for Bid</option>`;
$('#statusFilter').onchange = loadList;
$('#valueFilter').onchange = loadList;
$('#fromDate').onchange = loadList;
$('#toDate').onchange = loadList;
$('#clearFilters').onclick = () => {
  ['#search', '#statusFilter', '#valueFilter', '#fromDate', '#toDate'].forEach(sel => { $(sel).value = ''; });
  dueOffsets.clear();
  renderDueButtons();
  loadList();
};
function renderDueButtons() {
  document.querySelectorAll('.due-quick button').forEach(b => {
    const on = dueOffsets.has(+b.dataset.dueOffset);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}
// Click days to add them to the filter (several at once); click a selected day again to remove it
document.querySelectorAll('.due-quick button').forEach(b => {
  b.onclick = () => {
    const n = +b.dataset.dueOffset;
    if (dueOffsets.has(n)) dueOffsets.delete(n); else dueOffsets.add(n);
    renderDueButtons();
    loadList();
  };
});
$('#exportBtn').onclick = () => { location.href = `${API}/export?${listParams()}`; };

// ---------- Bulk upload (Admin) ----------
// Progress bar: sending the file = first 20%, adding the rows (streamed from the server) = the rest
const bulkDialog = $('#bulkDialog');
let bulkBusy = false;
$('#bulkBtn').onclick = () => {
  $('#bulkFile').value = '';
  $('#bulkProgress').hidden = true;
  $('#bulkResult').innerHTML = '';
  bulkDialog.showModal();
};
$('#bulkClose').onclick = () => { if (!bulkBusy) bulkDialog.close(); };
bulkDialog.addEventListener('cancel', ev => { if (bulkBusy) ev.preventDefault(); });

function bulkSetProgress(pct, phase, state = '') {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $('#bulkFill').style.width = `${pct}%`;
  $('#bulkFill').className = `bulk-fill ${state}`;
  $('.bulk-bar').setAttribute('aria-valuenow', pct);
  $('#bulkPct').textContent = `${pct}%`;
  $('#bulkPhase').textContent = phase;
}

function bulkRenderResult(r) {
  const table = (title, rows, cols) => !rows.length ? '' : `<h4>${title} (${rows.length})</h4>
    <div class="bulk-scroll"><table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(x => `<tr>${cols.map(c => `<td>${c[1](x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const dateCells = r.added.filter(a => a.fromDateCell);
  $('#bulkResult').innerHTML = `
    <p class="save-msg">${r.added.length} estimation${r.added.length === 1 ? '' : 's'} added` +
      `${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}${r.errors.length ? `, ${r.errors.length} with errors` : ''}.` +
      `${r.newClients.length ? ` New client${r.newClients.length === 1 ? '' : 's'} added: ${r.newClients.map(esc).join(', ')}.` : ''}</p>
    ${table('Errors — not added', r.errors, [['Row', x => x.row], ['Project', x => esc(x.projectName) || '—'], ['Problem', x => esc(x.reason)]])}
    ${table('Skipped', r.skipped, [['Row', x => x.row], ['Project', x => esc(x.projectName)], ['Reason', x => esc(x.reason)]])}
    ${table(`Dates read from Excel date cells${r.swapDateCells ? ' (day / month swapped back)' : ''} — please check`, dateCells,
      [['Row', x => x.row], ['Project', x => esc(x.projectName)], ['Due date', x => fmtDate(x.dueDate)]])}`;
}

$('#bulkUploadBtn').onclick = () => {
  const file = $('#bulkFile').files[0];
  if (!file) return alert('Choose an Excel (.xlsx) file first.');
  bulkBusy = true;
  $('#bulkUploadBtn').disabled = $('#bulkClose').disabled = true;
  $('#bulkProgress').hidden = false;
  $('#bulkResult').innerHTML = '';
  bulkSetProgress(0, 'Uploading file…');

  const xhr = new XMLHttpRequest();
  let seen = 0, final = null, failed = null;
  const finish = () => {
    bulkBusy = false;
    $('#bulkUploadBtn').disabled = $('#bulkClose').disabled = false;
  };
  // Read the complete progress lines received so far
  const readLines = () => {
    const text = xhr.responseText;
    const end = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(seen, end).split('\n')) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.type === 'start') bulkSetProgress(20, m.total ? `Adding ${m.total} estimation${m.total === 1 ? '' : 's'}…` : 'Checking rows…');
      else if (m.type === 'progress') bulkSetProgress(20 + 80 * (m.done / m.total), `Adding estimations… ${m.done} of ${m.total}`);
      else if (m.type === 'done') final = m;
      else if (m.type === 'error') failed = m.error;
    }
    seen = end;
  };
  xhr.upload.onprogress = ev => { if (ev.lengthComputable) bulkSetProgress(20 * (ev.loaded / ev.total), 'Uploading file…'); };
  xhr.onprogress = () => { if (xhr.status < 400) readLines(); };
  xhr.onload = () => {
    finish();
    if (xhr.status === 401) { bulkDialog.close(); dirty = false; showAuth(); return; }
    if (xhr.status >= 400) {
      let msg = `Upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not JSON */ }
      bulkSetProgress(100, msg, 'failed');
      return;
    }
    try { readLines(); } catch { failed = failed || 'Unexpected reply from the server'; }
    if (final && !failed) {
      bulkSetProgress(100, 'Done', 'done');
      bulkRenderResult(final);
      $('#bulkFile').value = '';
    } else {
      bulkSetProgress(100, failed || 'Upload did not finish — check the list before uploading again', 'failed');
    }
    loadList();
  };
  xhr.onerror = () => { finish(); bulkSetProgress(100, 'Connection lost — check the list before uploading again', 'failed'); loadList(); };
  xhr.open('POST', `${API}/bulk?swapDateCells=${$('#bulkSwap').checked ? 1 : 0}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.send(file);
};
let searchTimer;
$('#search').placeholder = 'Search No., project, client, done by, scope…';
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); };

// =====================================================================
// USERS (Admin)
// =====================================================================
let userList = [];
$('#newUserRole').innerHTML = ROLE_ORDER.map(r => `<option value="${r}">${ROLE_NAMES[r]}</option>`).join('');

async function loadUsers() {
  userList = await api('/api/users');
  $('#userRows').innerHTML = userList.map(u => {
    const self = u._id === me._id;
    return `<tr class="${u.active ? '' : 'row-inactive'}">
      <td><strong>${esc(u.name)}</strong>${self ? ' <span class="sub">(you)</span>' : ''}</td>
      <td><input type="email" class="cell-edit" data-user-email="${u._id}" value="${esc(u.email)}" data-orig="${esc(u.email)}" title="Sign-in email — edit and press Enter to change" /></td>
      <td><select class="cell-edit" data-user-role="${u._id}">
        ${ROLE_ORDER.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}</select></td>
      <td>${u.active ? '<span class="badge Won">Active</span>' : '<span class="badge On-Hold">Disabled</span>'}</td>
      <td>${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '<span class="sub">never</span>'}</td>
      <td class="actions-cell">
        <button class="btn small" data-reset="${u._id}">Reset password</button>
        ${self ? '' : `<button class="btn small" data-toggle="${u._id}">${u.active ? 'Disable' : 'Enable'}</button>
        <button class="btn small danger" data-del-user="${u._id}">Delete</button>`}
      </td></tr>`;
  }).join('');
}

$('#addUserForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    const u = await api('/api/users', { method: 'POST', body: JSON.stringify(formData(ev.target)) });
    ev.target.reset();
    $('#userMsg').textContent = `Added ${u.name} (${ROLE_NAMES[u.role]})`;
    loadUsers();
  } catch (err) { $('#userMsg').textContent = ''; alert(err.message); }
});

$('#userRows').addEventListener('change', async ev => {
  const emailId = ev.target.dataset.userEmail;
  if (emailId) {
    const email = ev.target.value.trim().toLowerCase();
    if (!email || email === ev.target.dataset.orig) { ev.target.value = ev.target.dataset.orig; return; }
    try {
      await api(`/api/users/${emailId}`, { method: 'PUT', body: JSON.stringify({ email }) });
      $('#userMsg').textContent = `Email changed to ${email}`;
    } catch (err) { if (!err.silent) alert(err.message); }
    return loadUsers();
  }
  const id = ev.target.dataset.userRole;
  try {
    await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify({ role: ev.target.value }) });
    $('#userMsg').textContent = 'Role updated';
    if (id === me._id) return boot(); // own role changed: refresh what's visible
  } catch (err) { alert(err.message); }
  loadUsers();
});

$('#userRows').addEventListener('click', async ev => {
  const d = ev.target.dataset;
  const u = userList.find(x => x._id === (d.reset || d.toggle || d.delUser));
  if (!u) return;
  try {
    if (d.reset) return openPasswordDialog(u);
    if (d.toggle) await api(`/api/users/${u._id}`, { method: 'PUT', body: JSON.stringify({ active: !u.active }) });
    if (d.delUser) {
      if (!confirm(`Delete user ${u.name}? (Their estimations are kept.)`)) return;
      await api(`/api/users/${u._id}`, { method: 'DELETE' });
    }
    loadUsers();
  } catch (err) { alert(err.message); }
});

boot();
