// Builds the "export all estimations" workbook: one row per estimation, Excel AutoFilter on
// every column, frozen header, and a SUBTOTAL totals row that follows whatever is filtered in Excel.
const ExcelJS = require('exceljs');
const { LESS_VALUE_HOURS } = require('../public/calc');

const dateOnly = d => (d ? new Date(d) : null);

function daysLeft(dueDate, now = new Date()) {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) - today) / 86400000);
}

const COLUMNS = [
  { header: 'No.', key: 'jobNo', width: 11 },
  { header: 'Date', key: 'date', width: 12, fmt: 'dd-mmm-yy' },
  { header: 'Project Name', key: 'projectName', width: 34 },
  { header: 'Client Name', key: 'clientName', width: 26 },
  { header: 'Priority Client', key: 'priorityClient', width: 10 },
  { header: 'Done By', key: 'doneBy', width: 18 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'Less Value Job', key: 'lessValue', width: 10 },
  { header: 'Due Date', key: 'dueDate', width: 12, fmt: 'dd-mmm-yy' },
  { header: 'Days Left', key: 'daysLeft', width: 9, fmt: '0;[Red]-0' },
  { header: 'Sheets', key: 'sheetCount', width: 8, sum: true },
  { header: 'Total Qty', key: 'totalCount', width: 10, sum: true },
  { header: 'Total Hrs', key: 'totalHours', width: 11, fmt: '#,##0.00', sum: true },
  { header: 'No. Dwgs', key: 'totalDwgs', width: 10, fmt: '#,##0', sum: true },
  { header: 'Tonnage (Calc.)', key: 'approxTonnage', width: 11, fmt: '#,##0.00', sum: true },
  { header: 'Tonnage for Client (MT)', key: 'quotedTonnage', width: 12, fmt: '#,##0.00', sum: true },
  { header: 'Hrs per Ton', key: 'hoursPerTon', width: 8, fmt: '0.00' },
  { header: 'Major Scope Items', key: 'scope', width: 22 },
  { header: 'Complexity', key: 'complexity', width: 11 },
  { header: 'Deliverables', key: 'deliverables', width: 36 },
  { header: 'Coordination Needed', key: 'coordinationNeeded', width: 24 },
  { header: 'Duration (Weeks)', key: 'durationWeeks', width: 10 },
  { header: 'Assumptions', key: 'assumptions', width: 30 },
  { header: 'Exclusions', key: 'exclusions', width: 40 },
  { header: 'Remark', key: 'remark', width: 16 },
  { header: 'Contact Person', key: 'contactPerson', width: 18 },
  { header: 'Contact Email', key: 'contactEmail', width: 26 },
  { header: 'SharePoint Link', key: 'sharepoint', width: 40 },
  { header: 'Internal Notes', key: 'notes', width: 30 },
  { header: 'Created', key: 'createdAt', width: 16, fmt: 'dd-mmm-yy hh:mm' },
  { header: 'Last Updated', key: 'updatedAt', width: 16, fmt: 'dd-mmm-yy hh:mm' },
];

const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFBFC5D2' } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

async function buildExport(estimations, filtersText) {
  const now = new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Estimation Manager';
  const ws = wb.addWorksheet('Estimations', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  const header = ws.getRow(1);
  header.height = 32;
  header.eachCell(cell => {
    cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill('FF12233F');
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });

  for (const e of estimations) {
    const link = (e.links || []).find(l => l.url);
    const row = ws.addRow({
      ...e,
      date: dateOnly(e.date),
      dueDate: dateOnly(e.dueDate),
      daysLeft: daysLeft(e.dueDate, now),
      priorityClient: e.priorityClient ? 'Yes' : 'No',
      lessValue: e.lessValue ? 'Yes' : 'No',
      sheetCount: (e.sheets || []).length,
      quotedTonnage: e.quotedTonnage ?? null,
      deliverables: (e.deliverables || []).join(', '),
      exclusions: (e.exclusions || []).join(', '),
      sharepoint: link ? { text: link.url, hyperlink: link.url } : null,
      createdAt: dateOnly(e.createdAt),
      updatedAt: dateOnly(e.updatedAt),
    });
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const c = COLUMNS[col - 1];
      cell.font = { name: 'Arial', size: 10 };
      cell.border = border;
      cell.alignment = { vertical: 'top', wrapText: ['exclusions', 'assumptions', 'notes', 'deliverables'].includes(c.key) };
      if (c.fmt) cell.numFmt = c.fmt;
    });
    if (link) row.getCell('sharepoint').font = { name: 'Arial', size: 10, color: { argb: 'FF1F5FBF' }, underline: true };
    if (e.status === 'Won') row.eachCell({ includeEmpty: true }, cell => { cell.fill = fill('FFE3F6E8'); });
    if (e.lessValue) row.getCell('lessValue').font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFC25400' } };
    if (e.priorityClient) row.getCell('priorityClient').font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF8A5A00' } };
  }

  const lastDataRow = Math.max(2, ws.rowCount);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastDataRow, column: COLUMNS.length } };

  // Totals row (SUBTOTAL 109 ignores rows hidden by the filter)
  if (estimations.length) {
    const r = lastDataRow + 2;
    const t = ws.getRow(r);
    t.getCell(1).value = 'TOTAL (visible rows)';
    t.getCell(1).font = { name: 'Arial', size: 10, bold: true };
    t.getCell(3).value = { formula: `SUBTOTAL(103,C2:C${lastDataRow})`, result: estimations.length }; // Project Name is always filled
    t.getCell(3).numFmt = '0" estimations"';
    t.getCell(3).font = { name: 'Arial', size: 10, bold: true };
    COLUMNS.forEach((c, i) => {
      if (!c.sum) return;
      const col = ws.getColumn(i + 1).letter;
      const result = estimations.reduce((a, e) => a + (Number(c.key === 'sheetCount' ? (e.sheets || []).length : e[c.key]) || 0), 0);
      const cell = t.getCell(i + 1);
      cell.value = { formula: `SUBTOTAL(109,${col}2:${col}${lastDataRow})`, result };
      cell.numFmt = c.fmt || '#,##0';
      cell.font = { name: 'Arial', size: 10, bold: true };
      cell.fill = fill('FFEEF1F6');
      cell.border = border;
    });
  }

  // Info sheet: what was exported
  const info = wb.addWorksheet('Export Info');
  info.columns = [{ width: 24 }, { width: 70 }];
  [
    ['Exported on', now],
    ['Estimations exported', estimations.length],
    ['Filters applied', filtersText || 'None (all estimations)'],
    ['Less value job rule', `Client not in priority list AND total hours < ${LESS_VALUE_HOURS}`],
    ['Tip', 'Use the filter arrows on the header row of the "Estimations" sheet. The TOTAL row follows the filter.'],
  ].forEach(([k, v]) => {
    const row = info.addRow([k, v]);
    row.getCell(1).font = { name: 'Arial', size: 10, bold: true };
    row.getCell(2).font = { name: 'Arial', size: 10 };
    if (v instanceof Date) row.getCell(2).numFmt = 'dd-mmm-yyyy hh:mm';
  });

  return wb;
}

module.exports = { buildExport };
