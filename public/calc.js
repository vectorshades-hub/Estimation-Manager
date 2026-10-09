// Shared estimation logic — loaded in the browser (window.EstCalc) and by Node (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EstCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SHEETS = 21; // Excel columns B..V
  const DEFAULT_HRS_PER_TON = 2.5;
  const LESS_VALUE_HOURS = 175; // non-priority client + fewer hours than this = "less value job"

  const isLessValueJob = (totalHours, isPriorityClient) => !isPriorityClient && (Number(totalHours) || 0) < LESS_VALUE_HOURS;

  // Item rows of the estimation chart, in sheet order (rows 5..30).
  // Hours = total count * minutes / divisor. minutes === null means the count is already in hours.
  const ITEM_TEMPLATE = [
    { key: 'beam11', name: 'Beam 1/1', minutes: 360, divisor: 60 },
    { key: 'beam12', name: 'Beam 1/2', minutes: 120, divisor: 60 },
    { key: 'beam13', name: 'Beam 1/3', minutes: 60, divisor: 60 },
    { key: 'beam14', name: 'Beam 1/4', minutes: 40, divisor: 60 },
    { key: 'col11', name: 'Column 1/1', minutes: 360, divisor: 60 },
    { key: 'col12', name: 'Column 1/2', minutes: 150, divisor: 60 },
    { key: 'col13', name: 'Column 1/3', minutes: 60, divisor: 60 },
    { key: 'col14', name: 'Column 1/4', minutes: 40, divisor: 45 },
    { key: 'vb11', name: 'Vbrace 1/1', minutes: 120, divisor: 60 },
    { key: 'vb13', name: 'Vbrace 1/3', minutes: 90, divisor: 60 },
    { key: 'vb14', name: 'Vbrace 1/4', minutes: 60, divisor: 60 },
    { key: 'vb12', name: 'Vbrace 1/2', minutes: 120, divisor: 60 },
    { key: 'hb14', name: 'Hbrace 1/4', minutes: 60, divisor: 60 },
    { key: 'hb13', name: 'Hbrace 1/3', minutes: 120, divisor: 60 },
    { key: 'truss', name: 'Truss', minutes: 3000, divisor: 60 },
    { key: 'hrail', name: 'Hrail 1/2', minutes: 360, divisor: 60 },
    { key: 'wrail', name: 'W-rail 1/4', minutes: 240, divisor: 60 },
    { key: 'ladderCage', name: 'Ladder Cage', minutes: 480, divisor: 60 },
    { key: 'ladderNoCage', name: 'Ladder no cage', minutes: 300, divisor: 60 },
    { key: 'gates', name: 'Gates', minutes: 840, divisor: 85 },
    { key: 'stringer', name: 'Stringer Assembly', minutes: 600, divisor: 60 },
    { key: 'embeds', name: 'Embeds', minutes: null, divisor: 60 },
    { key: 'connection', name: 'Connection', minutes: 120, divisor: 60 },
    { key: 'roofOpening', name: 'roof opening', minutes: 60, divisor: 60 },
    { key: 'outrigger', name: 'Outrigger', minutes: 60, divisor: 60 },
    { key: 'misc', name: 'Misc .in Hrs', minutes: null, divisor: 60 },
  ];

  // "No Dwgs" row: drawings per type = sum(item total / pieces-per-drawing).
  // Types without parts are manual entry only.
  const DWG_TYPES = [
    { key: 'AB', label: 'AB', parts: null },
    { key: 'LINTEL', label: 'LINTEL', parts: null },
    { key: 'ERE', label: 'ERE', parts: null },
    { key: 'COL', label: 'COL', parts: [['col11', 1], ['col12', 2], ['col13', 4], ['col14', 6]] },
    { key: 'BEAM', label: 'BEAM', parts: [['beam11', 1], ['beam12', 2], ['beam13', 12], ['beam14', 16]] },
    { key: 'BRACE', label: 'BRACE', parts: [['vb11', 1], ['vb13', 3], ['vb14', 4], ['vb12', 2], ['hb14', 4], ['hb13', 3]] },
    { key: 'MISC', label: 'MISC', parts: [['misc', 10]] },
    { key: 'STAIR', label: 'STAIR', parts: [['stringer', 1]] },
    { key: 'FRAME', label: 'Frame', parts: [['truss', 4]] },
    { key: 'SR', label: 'SR', parts: [['hrail', 2], ['wrail', 2]] },
    { key: 'LADD', label: 'LADD', parts: [['ladderCage', 1], ['ladderNoCage', 1]] },
    { key: 'EMBEDS', label: 'Embeds', parts: [['embeds', 8]] },
    { key: 'ROOF', label: 'Roof Open', parts: [['roofOpening', 4]] },
  ];

  const num = v => (Number.isFinite(+v) ? +v : 0);

  // Merge stored items with the template so every template row exists, in template order.
  function normalizeItems(items = [], sheetCount = 0) {
    const byKey = Object.fromEntries((items || []).map(i => [i.key, i]));
    return ITEM_TEMPLATE.map(t => {
      const s = byKey[t.key] || {};
      const counts = Array.from({ length: sheetCount }, (_, i) => num((s.counts || [])[i]));
      return {
        key: t.key,
        name: t.name,
        minutes: t.minutes === null ? null : s.minutes != null ? num(s.minutes) : t.minutes,
        divisor: s.divisor != null && num(s.divisor) > 0 ? num(s.divisor) : t.divisor,
        counts,
      };
    });
  }

  function itemHours(item, total) {
    return item.minutes === null ? total : (total * item.minutes) / (item.divisor || 60);
  }

  function compute(est) {
    const sheets = est.sheets || [];
    const items = normalizeItems(est.items, sheets.length);
    const totals = {}, hours = {};
    let totalCount = 0, totalHours = 0;
    for (const it of items) {
      const t = it.counts.reduce((a, b) => a + num(b), 0);
      totals[it.key] = t;
      hours[it.key] = itemHours(it, t);
      totalCount += t;
      totalHours += hours[it.key];
    }
    const overrides = est.dwgOverrides || {};
    const dwgs = {};
    let totalDwgs = 0;
    for (const d of DWG_TYPES) {
      const ov = overrides[d.key];
      const manual = ov !== null && ov !== undefined && ov !== '';
      dwgs[d.key] = manual ? num(ov) : d.parts ? d.parts.reduce((a, [k, div]) => a + totals[k] / div, 0) : 0;
      totalDwgs += dwgs[d.key];
    }
    const hrsPerTon = num(est.hoursPerTon) > 0 ? num(est.hoursPerTon) : DEFAULT_HRS_PER_TON;
    const tonnage = totalHours / hrsPerTon;
    return {
      items, totals, hours, totalCount, totalHours, dwgs, totalDwgs,
      hrsPerTon, tonnage, timePerDwg: totalDwgs ? totalHours / totalDwgs : 0,
    };
  }

  // ---------- Pages (each page = one estimation chart / one Excel worksheet) ----------
  const DEFAULT_SHEETS_PER_PAGE = 5;

  function newPage(name, sheetCount = DEFAULT_SHEETS_PER_PAGE) {
    return {
      name: name || 'Page 1',
      sheets: Array.from({ length: sheetCount }, () => ''),
      items: normalizeItems([], sheetCount),
      dwgOverrides: {},
      hoursPerTon: DEFAULT_HRS_PER_TON,
      additionalHoursFor: '',
      arch: [{}, {}, {}, {}],
      span: ['', '', ''],
      weight: ['', '', ''],
      structDescriptions: [],
      miscDescriptions: [],
      autoDesc: true,
    };
  }

  // Fill in missing parts of a stored page
  function normalizePage(p, i = 0) {
    const sheets = (p && p.sheets) || [];
    const pad = (arr, n, blank) => Array.from({ length: Math.max(n, (arr || []).length) }, (_, k) => (arr || [])[k] ?? blank());
    return {
      ...p,
      name: (p && p.name) || `Page ${i + 1}`,
      sheets: [...sheets],
      items: normalizeItems(p && p.items, sheets.length),
      dwgOverrides: (p && p.dwgOverrides) || {},
      hoursPerTon: p && num(p.hoursPerTon) > 0 ? num(p.hoursPerTon) : DEFAULT_HRS_PER_TON,
      additionalHoursFor: (p && p.additionalHoursFor) || '',
      arch: pad(p && p.arch, 4, () => ({})),
      span: pad(p && p.span, 3, () => ''),
      weight: pad(p && p.weight, 3, () => ''),
      structDescriptions: [...((p && p.structDescriptions) || [])],
      miscDescriptions: [...((p && p.miscDescriptions) || [])],
      autoDesc: !(p && p.autoDesc === false),
    };
  }

  // Totals for the whole estimation = sum of all pages
  function computeEstimation(est) {
    const pages = (est.pages && est.pages.length ? est.pages : [newPage()]).map((p, i) => normalizePage(p, i));
    const perPage = pages.map(p => compute(p));
    const sum = k => perPage.reduce((a, c) => a + c[k], 0);
    const totalHours = sum('totalHours'), totalDwgs = sum('totalDwgs');
    return {
      pages: perPage,
      totalCount: sum('totalCount'),
      totalHours,
      totalDwgs,
      tonnage: sum('tonnage'),
      sheetCount: pages.reduce((a, p) => a + p.sheets.length, 0),
      pageCount: pages.length,
      timePerDwg: totalDwgs ? totalHours / totalDwgs : 0,
    };
  }

  return {
    MAX_SHEETS, DEFAULT_HRS_PER_TON, LESS_VALUE_HOURS, isLessValueJob, ITEM_TEMPLATE, DWG_TYPES,
    normalizeItems, itemHours, compute, newPage, normalizePage, computeEstimation,
  };
});
