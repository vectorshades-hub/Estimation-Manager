const API = '/api/estimations';
const STATUSES = ['Received', 'In Progress', 'Submitted', 'Won', 'Lost', 'On Hold'];
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
const CLOSED = ['Submitted', 'Won', 'Lost'];

// Days from today until the due date: { text, cls } or null when there is no due date.
// Closed estimations (Submitted / Won / Lost) are shown in neutral grey.
function dueInfo(dueDate, status) {
  if (!dueDate) return null;
  const [y, m, d] = toInputDate(dueDate).split('-').map(Number);
  const [ty, tm, td] = today().split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  const closed = CLOSED.includes(status);
  if (days < 0) return { days, text: `${-days} day${days === -1 ? '' : 's'} overdue`, cls: closed ? 'due-closed' : 'due-over' };
  if (days === 0) return { days, text: 'Due today', cls: closed ? 'due-closed' : 'due-soon' };
  return { days, text: `${days} day${days === 1 ? '' : 's'} left`, cls: closed ? 'due-closed' : days <= 3 ? 'due-soon' : 'due-ok' };
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// =====================================================================
// LIST VIEW
// =====================================================================
// Current list filters as query parameters (used by both the list and the Excel export)
function listParams() {
  const params = new URLSearchParams();
  const set = (k, v) => { if (v) params.set(k, v); };
  set('q', $('#search').value.trim());
  set('status', $('#statusFilter').value);
  set('value', $('#valueFilter').value);
  set('from', $('#fromDate').value);
  set('to', $('#toDate').value);
  return params;
}

async function loadList() {
  const params = listParams();
  const [items, s] = await Promise.all([api(`${API}?${params}`), api(`${API}/stats/summary`)]);
  $('#exportBtn').textContent = `⬇ Export to Excel (${items.length})`;
  $('#clearFilters').hidden = !params.toString();

  $('#rows').innerHTML = items
    .map(e => {
      const due = dueInfo(e.dueDate, e.status);
      const won = e.status === 'Won';
      return `<tr class="row-link ${won ? 'row-won' : ''}" data-open-id="${e._id}" title="Click to open">
        <td><a href="#/edit/${e._id}"><strong>${esc(e.jobNo)}</strong></a></td>
        <td>${fmtDate(e.date)}</td>
        <td>${esc(e.projectName)}</td>
        <td>${e.priorityClient ? '<span class="star" title="Priority client">★</span> ' : ''}${esc(e.clientName)}</td>
        <td>${esc(e.doneBy) || '—'}</td>
        <td class="num">${e.sheetCount || 0}${e.pageCount > 1 ? `<div class="sub">${e.pageCount} pages</div>` : ''}</td>
        <td class="num">${fmt(e.totalHours)}</td>
        <td class="num">${fmt(e.totalDwgs, 0)}</td>
        <td class="num"><strong>${fmt(e.approxTonnage)}</strong></td>
        <td>${fmtDate(e.dueDate)}</td>
        <td>${due ? `<span class="due ${due.cls}">${due.text}</span>` : '—'}</td>
        <td><span class="badge ${e.status.replace(' ', '-')}">${esc(e.status)}</span></td>
        <td>${e.lessValue ? `<span class="lv-badge small" title="${LV_TITLE}">Less value job</span>` : '—'}</td>
        <td class="actions-cell">
          ${won
            ? `<button class="btn small won-on" data-won="0" data-id="${e._id}" title="Click to undo (sets status back to Submitted)">✓ Won</button>`
            : `<button class="btn small won-btn" data-won="1" data-id="${e._id}">Mark Won</button>`}
          <a class="btn small" href="#/edit/${e._id}">Edit</a>
          ${e.links?.find(l => l.url) ? `<a class="btn small" href="${esc(e.links.find(l => l.url).url)}" target="_blank" rel="noopener" title="Open SharePoint folder">Folder</a>` : ''}
          <a class="btn small" href="${API}/${e._id}/excel">Excel</a>
          <a class="btn small" href="${API}/${e._id}/proposal" title="Download proposal (Word)">Proposal</a>
          <button class="btn small danger" data-del="${e._id}" data-label="${esc(e.jobNo + ' ' + e.projectName)}">Delete</button>
        </td>
      </tr>`;
    })
    .join('');
  $('#empty').hidden = items.length > 0;

  const won = s.byStatus.Won || { count: 0, tonnage: 0 };
  const lost = s.byStatus.Lost?.count || 0;
  const active = ['Received', 'In Progress'].reduce((n, k) => n + (s.byStatus[k]?.count || 0), 0);
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
  // Clicking anywhere on a row (except its buttons/links) opens the project
  if (!ev.target.closest('a, button')) {
    const row = ev.target.closest('tr[data-open-id]');
    if (!row || getSelection().toString()) return; // don't hijack text selection
    const url = `#/edit/${row.dataset.openId}`;
    if (ev.ctrlKey || ev.metaKey) window.open(url, '_blank');
    else location.hash = url;
    return;
  }
  const d = ev.target.dataset;
  if (d.won) {
    if (d.won === '0' && !confirm('Remove the Won mark? Status will go back to Submitted.')) return;
    await api(`${API}/${d.id}`, { method: 'PUT', body: JSON.stringify({ status: d.won === '1' ? 'Won' : 'Submitted' }) });
    return loadList();
  }
  if (!d.del || !confirm(`Delete ${d.label}?`)) return;
  await api(`${API}/${d.del}`, { method: 'DELETE' });
  loadList();
});

// =====================================================================
// EDITOR VIEW
// =====================================================================
let cur = null;    // estimation being edited
let dirty = false;
let activePage = 0; // index of the chart page shown
const pg = () => cur.pages[activePage];

function blankEstimation(jobNo) {
  return {
    jobNo, projectName: '', clientName: '', date: today(), doneBy: '', status: 'Received',
    pages: [newPage('Page 1')],
    structDescriptions: [], miscDescriptions: [],
    exclusions: [],
    proposalExclusions: ['Any structural steel not shown, sized or dimensioned on the structural / architectural drawings.', 'Joist details, deck, and foundation rebar details.', 'Engineering'],
    scope: '', complexity: '', deliverables: [],
    coordinationNeeded: '', durationWeeks: null, quotedTonnage: null,
    assumptions: '', remark: '',
    proposalDate: null, quoteNo: '', submittalWeeks: null, signerName: '', signerTitle: '',
    links: [{ label: '', url: '' }],
  };
}

// Make sure the loaded estimation has well-formed pages
function normalizeCur() {
  cur.pages = (cur.pages && cur.pages.length ? cur.pages : [newPage('Page 1')]).map((p, i) => normalizePage(p, i));
  if (activePage >= cur.pages.length) activePage = cur.pages.length - 1;
  if (!cur.links?.length) cur.links = [{ label: '', url: '' }];
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
  fillForm();
  renderAll();
}

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
    else el.value = cur[el.name] ?? '';
  }
  $('#editorTitle').textContent = cur._id ? `${cur.jobNo} ${cur.projectName}` : 'New Estimation';
  $('#excelBtn').disabled = !cur._id;
  $('#emailBtn').disabled = !cur._id;
  $('#proposalBtn').disabled = !cur._id;
  $('#packageBtn').disabled = !cur._id;
  updateQuotePlaceholder();
  updateDueInfo();
}

function updateQuotePlaceholder() {
  const [y, m, d] = (toInputDate(cur.proposalDate) || today()).split('-');
  $('#quoteNo').placeholder = `${m}${d}${y}-01 (auto)`;
}

function updateDueInfo() {
  const due = dueInfo(cur.dueDate, cur.status);
  $('#dueInfo').innerHTML = due ? `<span class="due ${due.cls}">${due.text}</span>` : '';
}

function renderAll() {
  renderPage();
  renderDesc('structDescriptions');
  renderDesc('miscDescriptions');
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
}

function switchPage(i) {
  activePage = i;
  renderPage();
  updateComputed();
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
function renderChart() {
  const sheets = pg().sheets;
  const head = `<thead><tr>
      <th class="sticky">SHEET NO.</th>
      <th class="rate">Rate<div class="sub">min / div</div></th>
      ${sheets.map((s, i) => `<th class="sheet">
          <input class="sheet-name" data-sheet="${i}" value="${esc(s)}" placeholder="Sheet ${i + 1}" />
          <button type="button" class="x" data-del-sheet="${i}" title="Remove column">×</button></th>`).join('')}
      <th class="num tot">TOTAL</th><th class="num hrs">HRS REQ'D</th></tr></thead>`;
  const body = pg().items
    .map((it, r) => `<tr>
      <th class="sticky">${esc(it.name)}</th>
      <td class="rate">${it.minutes === null ? '<span class="sub">hrs</span>'
        : `<input type="number" min="0" step="any" data-rate="${r}" data-f="minutes" value="${it.minutes}" />/<input type="number" min="1" step="any" data-rate="${r}" data-f="divisor" value="${it.divisor}" />`}</td>
      ${sheets.map((_, c) => `<td><input type="number" min="0" step="any" class="cnt" data-r="${r}" data-c="${c}" value="${it.counts[c] || ''}" /></td>`).join('')}
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

function renderDesc(key) {
  const rows = cur[key];
  $(`#${key}`).innerHTML = `<thead><tr><th style="width:90px">Qty</th><th>Description</th><th>Notes</th><th style="width:80px">Heading</th><th style="width:40px"></th></tr></thead>
    <tbody>${rows.map((d, k) => `<tr class="${d.heading ? 'heading' : ''}">
      <td><input data-desc="${key}" data-k="${k}" data-f="qty" value="${esc(d.qty)}" /></td>
      <td><input data-desc="${key}" data-k="${k}" data-f="description" value="${esc(d.description)}" /></td>
      <td><input data-desc="${key}" data-k="${k}" data-f="notes" value="${esc(d.notes)}" /></td>
      <td class="center"><input type="checkbox" data-desc="${key}" data-k="${k}" data-f="heading" ${d.heading ? 'checked' : ''} /></td>
      <td><button type="button" class="x" data-del-desc="${key}" data-k="${k}">×</button></td></tr>`).join('')
      || `<tr><td colspan="5" class="sub center">No lines yet</td></tr>`}</tbody>`;
}

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
  if (d.r !== undefined) pg().items[+d.r].counts[+d.c] = el.value === '' ? 0 : +el.value;
  else if (d.rate !== undefined) pg().items[+d.rate][d.f] = el.value === '' ? 0 : +el.value;
  else if (d.sheet !== undefined) { pg().sheets[+d.sheet] = el.value; return; }
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
    const row = cur[d.desc][+d.k];
    row[d.f] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'checkbox') el.closest('tr').classList.toggle('heading', el.checked);
    return;
  } else if (el.name) {
    if (el.name === 'exclusions' || el.name === 'proposalExclusions') cur[el.name] = el.value.split('\n').map(s => s.trim()).filter(Boolean);
    else if (el.name === 'deliverables') cur.deliverables = [...form.querySelectorAll('input[name=deliverables]:checked')].map(i => i.value);
    else if (el.type === 'number') cur[el.name] = el.value === '' ? null : +el.value;
    else cur[el.name] = el.value;
    if (el.name === 'dueDate' || el.name === 'status') updateDueInfo();
    if (el.name === 'clientName') updateClientFlags();
    if (el.name === 'proposalDate') updateQuotePlaceholder();
    return;
  }
  updateComputed();
});

// Arrow-key / Enter navigation in the quantity grid
$('#chart').addEventListener('keydown', ev => {
  const d = ev.target.dataset;
  if (d.r === undefined) return;
  const m = { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [1, 0] }[ev.key];
  if (!m) return;
  ev.preventDefault();
  const next = $(`#chart input[data-r="${+d.r + m[0]}"][data-c="${+d.c + m[1]}"]`);
  if (next) { next.focus(); next.select(); }
});

form.addEventListener('click', ev => {
  const d = ev.target.dataset;
  if (d.page !== undefined) {
    if (+d.page !== activePage) switchPage(+d.page);
  } else if (ev.target.id === 'addPageBtn') {
    const base = 'Page ';
    let n = cur.pages.length + 1;
    while (cur.pages.some(p => p.name.toLowerCase() === (base + n).toLowerCase())) n++;
    cur.pages.push(newPage(base + n));
    dirty = true;
    switchPage(cur.pages.length - 1);
  } else if (d.delSheet !== undefined) {
    const i = +d.delSheet;
    const used = pg().items.some(it => +it.counts[i]);
    if (used && !confirm(`Remove column "${pg().sheets[i] || 'Sheet ' + (i + 1)}" and its quantities?`)) return;
    pg().sheets.splice(i, 1);
    pg().items.forEach(it => it.counts.splice(i, 1));
    dirty = true;
    renderChart(); updateComputed();
  } else if (d.add) {
    cur[d.add].push({ qty: '', description: '', notes: '', heading: false });
    dirty = true;
    renderDesc(d.add);
    $(`#${d.add} tbody tr:last-child input[data-f="qty"]`)?.focus();
  } else if (d.delLink !== undefined) {
    cur.links.splice(+d.delLink, 1);
    dirty = true;
    renderLinks();
  } else if (d.open !== undefined && ev.target.classList.contains('disabled')) {
    ev.preventDefault();
  } else if (d.delDesc) {
    cur[d.delDesc].splice(+d.k, 1);
    dirty = true;
    renderDesc(d.delDesc);
  }
});

$('#addLinkBtn').onclick = () => {
  cur.links.push({ label: '', url: '' });
  dirty = true;
  renderLinks();
  $(`#linkRows input[data-link="${cur.links.length - 1}"][data-f="url"]`).focus();
};

$('#addSheetBtn').onclick = () => {
  if (pg().sheets.length >= MAX_SHEETS) return;
  pg().sheets.push('');
  pg().items.forEach(it => it.counts.push(0));
  dirty = true;
  renderChart(); updateComputed();
  $(`#chart input[data-sheet="${pg().sheets.length - 1}"]`).focus();
};

// Page tabs: double-click to rename; rename / delete buttons
$('#pageTabs').addEventListener('dblclick', ev => {
  const i = ev.target.dataset.page;
  if (i !== undefined) renamePage(+i);
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

async function save() {
  $('#formError').hidden = true;
  if (!form.reportValidity()) return false;
  const body = { ...cur, pages: cur.pages.map(p => ({ ...p, name: (p.name || '').trim(), sheets: p.sheets.map(s => s.trim()) })) };
  try {
    const saved = cur._id
      ? await api(`${API}/${cur._id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api(API, { method: 'POST', body: JSON.stringify(body) });
    const wasNew = !cur._id;
    cur = saved;
    normalizeCur();
    renderPageTabs();
    dirty = false;
    $('#saveMsg').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    if (wasNew) { history.replaceState(null, '', `#/edit/${cur._id}`); lastHash = location.hash; }
    $('#editorTitle').textContent = `${cur.jobNo} ${cur.projectName}`;
    $('#excelBtn').disabled = false;
    $('#emailBtn').disabled = false;
    $('#proposalBtn').disabled = false;
    $('#packageBtn').disabled = false;
    loadClientOptions().then(() => updateClientFlags()); // a newly typed client is now in the list
    renderLinks();
    return true;
  } catch (err) {
    $('#formError').textContent = err.message;
    $('#formError').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return false;
  }
}

$('#saveBtn').onclick = save;
$('#packageBtn').onclick = async () => {
  if (dirty && !(await save())) return;
  location.href = `${API}/${cur._id}/package`;
};
$('#proposalBtn').onclick = async () => {
  if (dirty && !(await save())) return;
  location.href = `${API}/${cur._id}/proposal`;
};
$('#excelBtn').onclick = async () => {
  if (dirty && !(await save())) return;
  location.href = `${API}/${cur._id}/excel`;
};
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
// ROUTER
// =====================================================================
async function route() {
  const hash = location.hash || '#/';
  const editing = hash.startsWith('#/new') || hash.startsWith('#/edit/');
  const clients = hash.startsWith('#/clients');
  $('#listView').hidden = editing || clients;
  $('#editorView').hidden = !editing;
  $('#clientsView').hidden = !clients;
  $('#newBtn').hidden = editing;
  $('#navEst').classList.toggle('active', !clients);
  $('#navClients').classList.toggle('active', clients);
  try {
    if (hash.startsWith('#/edit/')) await openEditor(hash.slice(7));
    else if (hash.startsWith('#/new')) await openEditor(null);
    else if (clients) await loadClients();
    else await loadList();
  } catch (err) {
    alert(err.message);
    location.hash = '#/';
  }
  window.scrollTo(0, 0);
}

let lastHash = location.hash;
window.addEventListener('hashchange', ev => {
  if (dirty && !$('#editorView').hidden && !confirm('You have unsaved changes. Leave anyway?')) {
    history.replaceState(null, '', lastHash);
    return;
  }
  lastHash = location.hash;
  dirty = false;
  route();
});
window.addEventListener('beforeunload', ev => { if (dirty) ev.preventDefault(); });

const statusOpts = STATUSES.map(s => `<option>${s}</option>`).join('');
$('#statusFilter').insertAdjacentHTML('beforeend', statusOpts);
$('#statusSelect').innerHTML = statusOpts;
$('#statusFilter').onchange = loadList;
$('#valueFilter').onchange = loadList;
$('#fromDate').onchange = loadList;
$('#toDate').onchange = loadList;
$('#clearFilters').onclick = () => {
  ['#search', '#statusFilter', '#valueFilter', '#fromDate', '#toDate'].forEach(sel => { $(sel).value = ''; });
  loadList();
};
$('#exportBtn').onclick = () => { location.href = `${API}/export?${listParams()}`; };
let searchTimer;
$('#search').placeholder = 'Search No., project, client, done by, scope…';
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); };

route();
