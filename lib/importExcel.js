// Reads an "ESTIMATION CHART" workbook (the layout lib/excel.js writes, also used by hand-made charts) back into
// estimation pages: one worksheet = one page. Cells are found by their labels ("SHEET NO.", "ASS'Y", "No Dwgs",
// "STRUCT. DESCRIPTION"…), so charts with more sheet columns (everything right of them shifted) are read too.
const ExcelJS = require('exceljs');
const { MAX_SHEETS, DEFAULT_HRS_PER_TON, ITEM_TEMPLATE, DWG_TYPES, compute } = require('../public/calc');

const bad = msg => Object.assign(new Error(msg), { status: 400 });
const key = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9/]/g, '');

function value(cell) {
  const v = cell.value;
  if (v && typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) return v.result ?? null;
    if (v.richText) return v.richText.map(t => t.text).join('');
    if ('text' in v) return v.text; // hyperlink
  }
  return v;
}
const text = cell => {
  const v = value(cell);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').replace(/\s+/g, ' ').trim();
};
const number = cell => {
  const v = value(cell);
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const formula = cell => {
  const v = cell.value;
  return v && typeof v === 'object' ? v.formula || v.sharedFormula || '' : '';
};

// First cell in the sheet whose text matches (rows top to bottom, columns left to right)
function find(ws, test, { maxRow = 80, minCol = 1 } = {}) {
  for (let r = 1; r <= Math.min(ws.rowCount, maxRow); r++) {
    const row = ws.getRow(r);
    for (let c = minCol; c <= Math.max(row.cellCount, 1); c++) {
      if (test(key(text(row.getCell(c))))) return { r, c };
    }
  }
  return null;
}

function readSheet(ws, warnings) {
  const where = `Sheet "${ws.name}"`;
  const head = find(ws, k => k === 'sheetno', { maxRow: 15 });
  if (!head) throw bad(`${where}: no "SHEET NO." heading found — is this an estimation chart?`);
  const headRow = ws.getRow(head.r);
  let totalCol = 0;
  for (let c = head.c + 1; c <= headRow.cellCount; c++) if (key(text(headRow.getCell(c))) === 'assy') { totalCol = c; break; }
  if (!totalCol) throw bad(`${where}: no "ASS'Y" (total) column found`);
  const hoursCol = totalCol + 1;

  // Item rows: from below the heading until "TYPE" / "No Dwgs"
  const byName = new Map(ITEM_TEMPLATE.map(t => [key(t.name), t]));
  const found = new Map(); // item key -> { counts, minutes, divisor }
  let r = head.r + 1;
  for (; r <= ws.rowCount && r < head.r + 60; r++) {
    const name = key(text(ws.getRow(r).getCell(head.c)));
    if (name === 'type' || name === 'nodwgs') break;
    const t = byName.get(name);
    if (!t) { if (name) warnings.push(`${where}: row ${r} "${text(ws.getRow(r).getCell(head.c))}" is not a chart item — skipped`); continue; }
    const row = ws.getRow(r);
    const counts = [];
    for (let c = head.c + 1; c < totalCol; c++) counts.push(number(row.getCell(c)));
    // Rate from the hours formula: W5*360/60 -> 360 min / 60
    const m = formula(row.getCell(hoursCol)).replace(/\$/g, '').match(/\*\s*([\d.]+)\s*\/\s*([\d.]+)/);
    found.set(t.key, { counts, minutes: t.minutes === null ? null : m ? +m[1] : t.minutes, divisor: m && +m[2] > 0 ? +m[2] : t.divisor });
  }
  if (!found.size) throw bad(`${where}: no chart item rows (Beam 1/1, Column 1/1, …) found`);

  // Sheet columns: drop empty ones at the end (no name and no quantities)
  let nSheets = totalCol - head.c - 1;
  const used = i => text(headRow.getCell(head.c + 1 + i)) || [...found.values()].some(f => f.counts[i]);
  while (nSheets > 0 && !used(nSheets - 1)) nSheets--;
  if (nSheets > MAX_SHEETS) { warnings.push(`${where}: only the first ${MAX_SHEETS} sheet columns were read`); nSheets = MAX_SHEETS; }
  const sheets = Array.from({ length: nSheets }, (_, i) => text(headRow.getCell(head.c + 1 + i)));
  const items = ITEM_TEMPLATE.map(t => {
    const f = found.get(t.key);
    return { key: t.key, name: t.name, minutes: f ? f.minutes : t.minutes, divisor: f ? f.divisor : t.divisor,
      counts: Array.from({ length: nSheets }, (_, i) => (f ? f.counts[i] || 0 : 0)) };
  });

  // No. of drawings: a typed number (not a formula) is a manual override
  const dwgOverrides = {};
  const typeRow = find(ws, k => k === 'type', { maxRow: 80 });
  const dwgRow = find(ws, k => k === 'nodwgs', { maxRow: 80 });
  if (typeRow && dwgRow) {
    const labels = ws.getRow(typeRow.r), vals = ws.getRow(dwgRow.r);
    for (let c = typeRow.c + 1; c <= labels.cellCount; c++) {
      const d = DWG_TYPES.find(t => key(t.label) === key(text(labels.getCell(c))));
      if (!d) continue;
      const cell = vals.getCell(c);
      if (!formula(cell) && text(cell) !== '' && Number.isFinite(+value(cell))) dwgOverrides[d.key] = +value(cell);
    }
  }

  // Hours per ton from "X33/2.5" (TONNAGE EXPECTED)
  let hoursPerTon = DEFAULT_HRS_PER_TON;
  const ton = find(ws, k => k === 'tonnageexpected');
  if (ton) {
    const m = formula(ws.getRow(ton.r).getCell(hoursCol)).replace(/\$/g, '').match(/\/\s*([\d.]+)\s*$/);
    if (m && +m[1] > 0) hoursPerTon = +m[1];
  }

  // Additional hours / Arch / Span / Weight (fixed columns left of the sheet area)
  const addl = find(ws, k => k === 'additionalhoursrequiredfor');
  const additionalHoursFor = addl ? text(ws.getRow(addl.r).getCell(8)) : ''; // H
  const arch = [], span = [], weight = [];
  const archAt = find(ws, k => k === 'arch');
  if (archAt) {
    for (let k = 0; k < 4; k++) {
      const row = ws.getRow(archAt.r + k);
      arch.push({ ref: text(row.getCell(3)), description: text(row.getCell(8)) }); // C, H
      if (k < 3) { span.push(text(row.getCell(15))); weight.push(text(row.getCell(19))); } // O, S
    }
  }

  // Exclusions: the EXCLUSION list in the description panel, else the "SPECIFIC EXCLUSIONS" line
  let exclusions = [];
  const exclLine = find(ws, k => k === 'specificexclusions');
  if (exclLine) {
    const row = ws.getRow(exclLine.r);
    for (let c = exclLine.c + 1; c <= hoursCol; c++) { // stop at the chart's edge (the description panel is right of it)
      const t = text(row.getCell(c));
      if (t && key(t) !== 'specificexclusions') { exclusions = t.split(/\s*;\s*/).filter(Boolean); break; }
    }
  }

  // Description panel (QTY | DESCRIPTION | NOTES), right of the chart
  const structDescriptions = [], miscDescriptions = [];
  const panel = find(ws, k => k === 'structdescription', { minCol: hoursCol + 1 });
  if (panel) {
    const [qc, dc, nc] = [panel.c - 1, panel.c, panel.c + 1];
    let list = structDescriptions, panelExcl = [];
    for (let rr = panel.r + 1; rr <= ws.rowCount; rr++) {
      const row = ws.getRow(rr);
      const desc = row.getCell(dc), qty = text(row.getCell(qc)), notes = text(row.getCell(nc));
      const k = key(text(desc));
      if (k === 'miscdescription') { list = miscDescriptions; continue; }
      if (k === 'exclusion' || k === 'exclusions') { list = panelExcl; continue; }
      if (!qty && !text(desc) && !notes) continue;
      if (list === panelExcl) { if (text(desc)) panelExcl.push(text(desc)); continue; }
      list.push({ qty, description: text(desc), notes, heading: !!desc.font?.bold && !!desc.fill?.fgColor });
    }
    if (panelExcl.length) exclusions = panelExcl;
  }

  return {
    page: {
      name: ws.name.trim(), sheets, items, dwgOverrides, hoursPerTon, additionalHoursFor, arch, span, weight,
      structDescriptions, miscDescriptions,
      autoDesc: false, splitSheets: false, // keep the descriptions from the file as they are
    },
    exclusions,
    header: { // as printed in the file (only shown, to check it is the right project)
      project: text(ws.getCell('G2')),
      client: text(ws.getCell('T1')).replace(/^client:\s*/i, ''),
      doneBy: text(ws.getCell('S2')),
    },
  };
}

// buf: .xlsx file. Returns { pages, exclusions, header, warnings, summary }
async function readEstimationWorkbook(buf) {
  if (!(buf?.[0] === 0x50 && buf?.[1] === 0x4b)) throw bad('Please upload an Excel (.xlsx) file');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { throw bad('The Excel file could not be read'); }
  const warnings = [];
  const sheets = wb.worksheets.filter(s => s.state === 'visible' && s.actualRowCount > 0);
  if (!sheets.length) throw bad('The file is empty');
  const read = sheets.map(ws => readSheet(ws, warnings));

  // Page names must be unique
  const names = new Set();
  read.forEach(({ page }, i) => {
    let n = page.name || `Page ${i + 1}`;
    for (let k = 2; names.has(n.toLowerCase()); k++) n = `${page.name} (${k})`;
    names.add(n.toLowerCase());
    page.name = n;
  });

  const pages = read.map(r => r.page);
  const summary = pages.map(p => {
    const c = compute(p);
    return { name: p.name, sheets: p.sheets.length, totalCount: c.totalCount, totalHours: c.totalHours, tonnage: c.tonnage,
      totalDwgs: c.totalDwgs, structLines: p.structDescriptions.length, miscLines: p.miscDescriptions.length };
  });
  return { pages, exclusions: read[0].exclusions, header: read[0].header, warnings, summary };
}

module.exports = { readEstimationWorkbook };
