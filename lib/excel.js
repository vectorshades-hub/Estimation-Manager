// Builds the "ESTIMATION CHART" workbook in the same layout as the sample output
// (26-149 AURORA ACC_output sample.xlsx). Cells carry live formulas plus cached results.
const ExcelJS = require('exceljs');
const { MAX_SHEETS, DWG_TYPES, compute, normalizePage } = require('../public/calc');

const FILL = {
  blue: 'FF99CCFF',   // header
  yellow: 'FFFFFF99', // labels
  teal: 'FFCCFFFF',   // count inputs
  green: 'FFCCFFCC',  // hours
  tan: 'FFFFCC99',
  rose: 'FFFF99CC',
  grey: 'FFEEECE1',   // description group headings
};
const FIRST_ITEM_ROW = 5;
const colOf = i => String.fromCharCode(66 + i); // sheet index 0 -> B ... 20 -> V
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const border = (s = 'hair') => ({ top: { style: s }, left: { style: s }, bottom: { style: s }, right: { style: s } });

function style(cell, { bold, size = 10, name = 'Arial', color, bg, h = 'center', v = 'middle', wrap, b, fmt } = {}) {
  cell.font = { name, size, bold: !!bold, ...(color ? { color: { argb: color } } : {}) };
  cell.alignment = { horizontal: h, vertical: v, wrapText: !!wrap };
  if (bg) cell.fill = fill(bg);
  if (b) cell.border = border(b);
  if (fmt) cell.numFmt = fmt;
  return cell;
}

function put(ws, ref, value, opts) {
  const cell = ws.getCell(ref);
  cell.value = value === '' ? null : value;
  return style(cell, opts);
}

const f = (formula, result) => ({ formula, result: Number.isFinite(result) ? result : 0 });

// One workbook, one worksheet per page. Descriptions and exclusions are printed on the first page only.
async function buildWorkbook(est) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Estimation Manager';
  const pages = (est.pages && est.pages.length ? est.pages : [{}]).map((p, i) => normalizePage(p, i));
  const used = new Set();
  pages.forEach((page, i) => {
    // Excel sheet names: max 31 chars, no : \ / ? * [ ], unique (case-insensitive)
    let name = (page.name || `Page ${i + 1}`).replace(/[:\\/?*[\]]/g, '-').slice(0, 31).trim() || `Page ${i + 1}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name.slice(0, 27)} (${n})`;
    used.add(name.toLowerCase());
    const pageEst = {
      ...est, ...page,
      structDescriptions: i === 0 ? est.structDescriptions : [],
      miscDescriptions: i === 0 ? est.miscDescriptions : [],
      exclusions: i === 0 ? est.exclusions : [],
    };
    addChartSheet(wb, pageEst, name);
  });
  return wb;
}

function addChartSheet(wb, est, sheetName) {
  const c = compute(est);
  const sheets = (est.sheets || []).slice(0, MAX_SHEETS);
  const ws = wb.addWorksheet(sheetName, {
    pageSetup: {
      orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      printArea: 'A1:X39', margins: { left: 0.75, right: 0.75, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
    },
    views: [{ state: 'frozen', xSplit: 1, ySplit: 4 }],
  });

  // Column widths (from sample)
  const widths = { A: 24.86, B: 14.14, C: 11.57, D: 11.43, F: 11.14, H: 11.14, L: 10.71, M: 11.14, N: 10.71,
    Q: 11.29, R: 11.86, S: 19.43, T: 11.86, U: 10.71, W: 12, X: 27.29, Y: 12.43, Z: 52, AA: 61.29 };
  for (let i = 1; i <= 27; i++) {
    const col = ws.getColumn(i);
    col.width = widths[col.letter] || 10;
  }
  const heights = { 1: 23.25, 2: 22.5, 3: 20.1, 4: 26.45, 31: 25.15, 32: 24, 33: 25.15, 34: 25.9, 35: 25.15, 36: 23.45, 37: 24, 38: 24, 39: 20.1 };
  for (let r = 1; r <= 39; r++) ws.getRow(r).height = heights[r] || 27;

  // ---------- Header (rows 1-2) ----------
  ws.mergeCells('A1:E2');
  put(ws, 'A1', 'ESTIMATION  CHART', { name: 'Broadway', size: 16, bold: true, bg: FILL.blue });
  put(ws, 'F1', ' ', { bg: FILL.blue, b: 'thin' });
  put(ws, 'F2', 'PROJECT:', { bold: true, size: 11, bg: FILL.blue, b: 'thin' });
  ws.mergeCells('G1:P1');
  style(ws.getCell('G1'), { bg: FILL.blue, b: 'thin' });
  ws.mergeCells('G2:P2');
  put(ws, 'G2', [est.jobNo, est.projectName].filter(Boolean).join(' '),
    { name: 'Times New Roman', size: 16, bold: true, color: 'FF000080', bg: FILL.blue, b: 'thin' });
  ws.mergeCells('Q1:Q2');
  style(ws.getCell('Q1'), { bg: FILL.blue, b: 'thin' });
  put(ws, 'R1', 'DATE:', { bold: true, bg: FILL.blue, b: 'thin' });
  put(ws, 'S1', est.date ? new Date(est.date) : null, { bold: true, size: 12, bg: FILL.blue, b: 'thin', fmt: 'd-mmm-yy' });
  put(ws, 'R2', 'DONE BY:', { bold: true, bg: FILL.blue, b: 'thin' });
  put(ws, 'S2', est.doneBy || '', { bold: true, size: 12, bg: FILL.blue, b: 'thin', wrap: true });
  ws.mergeCells('T1:X2');
  put(ws, 'T1', est.clientName ? `CLIENT: ${est.clientName}` : '', { bold: true, size: 12, bg: FILL.blue, b: 'thin', wrap: true });

  // ---------- Column headings (rows 3-4) ----------
  ws.mergeCells('B3:V3');
  style(ws.getCell('B3'), { b: 'hair' });
  put(ws, 'W3', 'TOTAL', { bold: true, b: 'hair' });
  put(ws, 'X3', "HRS REQ'D", { bold: true, bg: FILL.yellow, b: 'hair' });
  put(ws, 'A4', 'SHEET NO.', { bold: true, h: 'left', wrap: true, b: 'hair' });
  for (let i = 0; i < MAX_SHEETS; i++) {
    put(ws, `${colOf(i)}4`, sheets[i] || null, { wrap: true, b: 'thin' });
  }
  put(ws, 'W4', "ASS'Y", { bold: true, b: 'hair' });
  put(ws, 'X4', 'A', { bold: true, b: 'hair' });

  // ---------- Item rows (5-30) ----------
  c.items.forEach((it, idx) => {
    const r = FIRST_ITEM_ROW + idx;
    put(ws, `A${r}`, it.name, { bold: true, h: 'left', bg: FILL.yellow, b: 'hair' });
    for (let i = 0; i < MAX_SHEETS; i++) {
      const v = i < sheets.length ? it.counts[i] : 0;
      put(ws, `${colOf(i)}${r}`, v ? v : null, { bg: FILL.teal, b: 'hair' });
    }
    put(ws, `W${r}`, f(`SUM(B${r}:V${r})`, c.totals[it.key]), { b: 'hair' });
    const hf = it.minutes === null ? `W${r}` : `W${r}*${it.minutes}/${it.divisor}`;
    put(ws, `X${r}`, f(hf, c.hours[it.key]), { bg: FILL.green, b: 'hair', fmt: '0.00' });
  });
  const lastItemRow = FIRST_ITEM_ROW + c.items.length - 1; // 30
  const rowOf = Object.fromEntries(c.items.map((it, i) => [it.key, FIRST_ITEM_ROW + i]));

  // ---------- Totals / No. of drawings (rows 31-34) ----------
  put(ws, 'T31', 'TOTAL UDC', {});
  style(ws.getCell('X31'), { bg: FILL.green, b: 'hair' });
  ws.mergeCells('B32:G32');
  put(ws, 'B32', 'Additional Hours Required for', { bold: true, size: 11, h: 'left' });
  ws.mergeCells('H32:V32');
  put(ws, 'H32', est.additionalHoursFor || '', { h: 'left', wrap: true, b: 'hair' });
  style(ws.getCell('X32'), { bg: FILL.green, b: 'hair' });

  put(ws, 'A33', 'TYPE', { bold: true, bg: FILL.yellow, b: 'hair' });
  put(ws, 'A34', 'No Dwgs', { bold: true, bg: FILL.yellow, b: 'hair' });
  const overrides = est.dwgOverrides || {};
  DWG_TYPES.forEach((d, i) => {
    const col = colOf(i); // B..N
    put(ws, `${col}33`, d.label, { b: 'hair' });
    const ov = overrides[d.key];
    let value;
    if (ov !== undefined && ov !== null && ov !== '') value = Number(ov);
    else if (d.parts) {
      const [[k0, d0]] = d.parts;
      const formula = d.parts.length === 1 && d0 === 1
        ? `W${rowOf[k0]}`
        : d.parts.map(([k, div]) => `(W${rowOf[k]}/${div})`).join('+');
      value = f(formula, c.dwgs[d.key]);
    } else value = null;
    put(ws, `${col}34`, value, { bg: FILL.teal, b: 'hair', fmt: '0' });
  });
  for (let i = DWG_TYPES.length; i < 17; i++) style(ws.getCell(`${colOf(i)}34`), { bg: FILL.teal, b: 'hair' }); // O..R
  ws.mergeCells('T33:V33');
  put(ws, 'S33', 'TOTAL', { bold: true, size: 9, b: 'hair' });
  put(ws, 'S34', f(`SUM(B34:${colOf(DWG_TYPES.length - 1)}34)`, c.totalDwgs), { bg: FILL.teal, b: 'hair', fmt: '0' });
  put(ws, 'W33', f(`SUM(W${FIRST_ITEM_ROW}:W${lastItemRow})`, c.totalCount), { bold: true, b: 'hair' });
  put(ws, 'X33', f(`SUM(X${FIRST_ITEM_ROW}:X32)`, c.totalHours), { bold: true, bg: FILL.green, b: 'hair', fmt: '0' });

  ws.mergeCells('T34:V34');
  put(ws, 'T34', 'TONNAGE EXPECTED', { bold: true, b: 'hair' });
  put(ws, 'X34', f(`X33/${c.hrsPerTon}`, c.tonnage), { bg: FILL.teal, b: 'hair', fmt: '0.00' });

  // ---------- Arch / Span / Weight / ratios (rows 35-38) ----------
  ws.mergeCells('B35:B38');
  put(ws, 'B35', 'ARCH', { bold: true, b: 'hair' });
  const arch = est.arch || [];
  for (let k = 0; k < 4; k++) {
    const r = 35 + k;
    ws.mergeCells(`C${r}:G${r}`);
    put(ws, `C${r}`, arch[k]?.ref || '', { bg: FILL.yellow, h: 'left', b: 'hair' });
    ws.mergeCells(`H${r}:M${r}`);
    put(ws, `H${r}`, arch[k]?.description || '', { bg: FILL.yellow, h: 'left', b: 'hair' });
  }
  ws.mergeCells('N35:N37');
  put(ws, 'N35', 'SPAN', { bold: true, b: 'hair' });
  ws.mergeCells('R35:R37');
  put(ws, 'R35', 'WEIGHT', { bold: true, b: 'hair' });
  const bands = [FILL.green, FILL.tan, FILL.rose];
  for (let k = 0; k < 3; k++) {
    const r = 35 + k;
    ws.mergeCells(`O${r}:Q${r}`);
    put(ws, `O${r}`, (est.span || [])[k] || '', { bg: bands[k], b: 'hair' });
    put(ws, `S${r}`, (est.weight || [])[k] || '', { bg: bands[k], b: 'hair' });
  }
  ws.mergeCells('T35:V35');
  put(ws, 'T35', 'HOURS PER TONNAGE', { bold: true, b: 'hair' });
  put(ws, 'X35', f('IF(X34=0,0,X33/X34)', c.tonnage ? c.totalHours / c.tonnage : 0), { bold: true, bg: FILL.green, b: 'hair', fmt: '0.00' });
  ws.mergeCells('T36:V36');
  put(ws, 'T36', 'TIME TAKEN PER DWG', { bold: true, b: 'hair' });
  put(ws, 'X36', f('IF(S34=0,0,X33/S34)', c.timePerDwg), { bold: true, bg: FILL.green, b: 'hair', fmt: '0.00' });
  ws.mergeCells('T37:W37');
  ws.mergeCells('T38:W38');

  // ---------- Exclusions (row 39) ----------
  ws.mergeCells('B39:E39');
  put(ws, 'B39', '** SPECIFIC EXCLUSIONS:', { bold: true, h: 'left' });
  ws.mergeCells('F39:X39');
  const excl = (est.exclusions || []).filter(Boolean);
  put(ws, 'F39', excl.join(';  '), { h: 'left', wrap: true });
  if (excl.join(';  ').length > 180) ws.getRow(39).height = 20 * Math.ceil(excl.join(';  ').length / 180);

  // Heavy outline around the chart (A1:X38)
  for (let r = 1; r <= 38; r++) {
    const a = ws.getCell(`A${r}`);
    a.border = { ...(a.border || {}), left: { style: 'medium' } };
    const x = ws.getCell(`X${r}`);
    x.border = { ...(x.border || {}), right: { style: 'medium' } };
  }
  for (let i = 1; i <= 24; i++) {
    const top = ws.getRow(1).getCell(i);
    top.border = { ...(top.border || {}), top: { style: 'medium' } };
    const bot = ws.getRow(38).getCell(i);
    bot.border = { ...(bot.border || {}), bottom: { style: 'medium' } };
  }

  // ---------- Description panel (columns Y:AA) ----------
  const panelHeader = (r, title) => {
    put(ws, `Y${r}`, 'QTY:', { bold: true, size: 14, b: 'thin' });
    put(ws, `Z${r}`, title, { bold: true, size: 14, b: 'thin' });
    put(ws, `AA${r}`, 'NOTES:', { bold: true, size: 14, b: 'thin' });
  };
  const panelRows = (start, list) => {
    list.forEach((d, k) => {
      const r = start + k;
      const o = { size: 12, b: 'thin', bold: !!d.heading, bg: d.heading ? FILL.grey : undefined };
      put(ws, `Y${r}`, d.qty === '' || d.qty == null ? null : isNaN(+d.qty) ? d.qty : +d.qty, o);
      put(ws, `Z${r}`, d.description || '', { ...o, h: 'left' });
      put(ws, `AA${r}`, d.notes || '', { ...o, h: 'left' });
    });
    return start + list.length;
  };
  const blankRows = (from, to) => {
    for (let r = from; r < to; r++) ['Y', 'Z', 'AA'].forEach(col => style(ws.getCell(`${col}${r}`), { size: 12, b: 'thin' }));
  };

  const struct = est.structDescriptions || [];
  const misc = est.miscDescriptions || [];
  panelHeader(1, 'STRUCT. DESCRIPTION');
  let end = panelRows(2, struct);
  const miscHeader = Math.max(14, end + 1);
  blankRows(end, miscHeader);
  panelHeader(miscHeader, 'MISC. DESCRIPTION');
  end = panelRows(miscHeader + 1, misc);
  const exclHeader = Math.max(48, end + 1);
  blankRows(end, exclHeader);
  put(ws, `Z${exclHeader}`, 'EXCLUSION', { bold: true, size: 14, b: 'thin' });
  excl.forEach((e, k) => put(ws, `Z${exclHeader + 1 + k}`, e, { size: 12, h: 'left', b: 'thin' }));

}

module.exports = { buildWorkbook };
