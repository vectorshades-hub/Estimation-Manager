// Fills templates/proposal-template.docx (the VectorShades-themed "QUOTE / <project>" Word file)
// with one estimation's details. Everything else in the template (logo, footers, terms) is left untouched.
// The detailing cost ($ amounts) is intentionally left as placeholders to be filled in manually.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'proposal-template.docx');

// Sample text that is in the template and gets replaced
const T = {
  project: 'LAWS Shelter',          // JOB NAME cell, page header, document title
  projectUpper: 'LAWS SHELTER',     // "QUOTE / LAWS SHELTER" banner
  attn: 'Josh Lewis',
  date: 'September 16, 2026',
  quoteNo: '09162026-01',
  signer: 'Lee Luck',               // CONTACT cell and the signature NAME line
  title: 'Lead Estimator',
};

// Schedules longer than this many weeks get the sequencing note
const LONG_SCHEDULE_WEEKS = 10;
const LONG_SCHEDULE_NOTE = ' - Sequencing Release +/- 2 Weeks for Duration of the project';

// The template starts the Misc. table on a new page; set to false to let it follow the Struct. table
const MISC_ON_NEW_PAGE = true;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');

const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const P_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
const TR_RE = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;

const paraText = p => [...p.matchAll(T_RE)].map(m => xmlUnesc(m[2])).join('');

// Copies of template rows/paragraphs must not repeat the original's Word paragraph ids
const stripIds = x => x.replace(/\s+w14:paraId="[^"]*"/g, '').replace(/\s+w14:textId="[^"]*"/g, '').replace(/\s+wp14:textId="[^"]*"/g, '');

// Replace a substring of a paragraph's text even when Word has split it across several runs.
// The replacement takes the formatting of the run where the old text starts.
function replaceInParagraph(p, oldSub, newSub) {
  const parts = [...p.matchAll(T_RE)].map(m => ({ full: m[0], text: xmlUnesc(m[2]), index: m.index }));
  const fullText = parts.map(x => x.text).join('');
  const at = fullText.indexOf(oldSub);
  if (at < 0) return p;
  const end = at + oldSub.length;
  let pos = 0, inserted = false;
  for (const part of parts) {
    const s = pos, e = pos + part.text.length;
    pos = e;
    if (e <= at || s >= end) { part.newText = part.text; continue; }
    const before = part.text.slice(0, Math.max(0, at - s));
    const after = part.text.slice(Math.max(0, end - s));
    part.newText = before + (inserted ? '' : newSub) + after;
    inserted = true;
  }
  let out = '', last = 0;
  for (const part of parts) {
    out += p.slice(last, part.index) + `<w:t xml:space="preserve">${xmlEsc(part.newText)}</w:t>`;
    last = part.index + part.full.length;
  }
  return out + p.slice(last);
}

// Apply a replacement to every paragraph (or only those passing `when`)
const replaceAll = (xml, oldSub, newSub, when = () => true) =>
  xml.replace(P_RE, p => (when(paraText(p)) && paraText(p).includes(oldSub) ? replaceInParagraph(p, oldSub, newSub) : p));

// Set the whole text of a paragraph. Empty template cells hold a formatted run with no text:
// the text goes into that run so it keeps the cell's font.
function setParagraphText(p, text) {
  const cur = paraText(p);
  if (cur) return replaceInParagraph(p, cur, text);
  if (!text) return p;
  const t = `<w:t xml:space="preserve">${xmlEsc(text)}</w:t>`;
  if (/<w:t[\s>]/.test(p)) return p.replace(/<w:t(\s[^>]*)?>[^<]*<\/w:t>/, t);
  if (/<\/w:r>/.test(p)) return p.replace(/<\/w:r>/, `${t}</w:r>`);
  return p.replace(/<\/w:p>$/, `<w:r>${t}</w:r></w:p>`);
}

// Set the text of each cell (first paragraph) of a table row
function fillRow(rowXml, values) {
  let i = 0;
  return stripIds(rowXml).replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => {
    const v = values[i++] ?? '';
    let done = false;
    return tc.replace(P_RE, p => {
      if (done) return p;
      done = true;
      return setParagraphText(p, String(v));
    });
  });
}

// Locate the table that contains `marker` (header-cell text): its position and rows
function findTable(xml, marker) {
  const at = xml.indexOf(marker);
  if (at < 0) return null;
  const start = xml.lastIndexOf('<w:tbl>', at);
  const end = xml.indexOf('</w:tbl>', at) + '</w:tbl>'.length;
  const tbl = xml.slice(start, end);
  return { start, end, tbl, rows: tbl.match(TR_RE) || [] };
}

// Replace every row after the header row of a table with `bodyRows`
function setTableBody(t, bodyRows) {
  const firstRowAt = t.tbl.indexOf(t.rows[0]);
  const lastRow = t.rows[t.rows.length - 1];
  const lastRowEnd = t.tbl.lastIndexOf(lastRow) + lastRow.length;
  return t.tbl.slice(0, firstRowAt) + t.rows[0] + bodyRows.join('') + t.tbl.slice(lastRowEnd);
}

// Scope rows: heading lines use the shaded sheet-title row, the rest the plain item row.
// Each group (= one page's lines) after the first is separated by an empty row unless it starts with a heading.
function scopeRows(groups, headingRow, itemRow) {
  const out = [];
  groups.forEach((lines, g) => {
    if (g && !lines[0]?.heading) out.push(fillRow(itemRow, ['', '', '']));
    for (const l of lines) out.push(fillRow(l.heading ? headingRow : itemRow, [l.qty, l.description, l.notes]));
  });
  return out;
}

// Rebuild the two "Scope of Work" tables (STRUCT. DESCRIPTION, then MISC. DESCRIPTION on its own page)
function buildScopeTables(xml, structGroups, miscGroups) {
  const st = findTable(xml, '>STRUCT. DESCRIPTION<');
  if (!st || st.rows.length < 3) return xml;
  const headingRow = st.rows[1]; // template: header, shaded sheet heading, item rows...
  const structItem = st.rows[2];
  const hasStruct = structGroups.length > 0, hasMisc = miscGroups.length > 0;

  // Misc. table first (it comes later in the file, so the struct table positions stay valid)
  const mt = findTable(xml, '>MISC. DESCRIPTION<');
  if (mt && mt.rows.length >= 2) {
    // The page-break paragraph right before the misc table
    const brkStart = xml.lastIndexOf('<w:p ', mt.start);
    const brk = xml.slice(brkStart, mt.start);
    const isBreak = brk.includes('<w:pageBreakBefore');
    const from = isBreak ? brkStart : mt.start;
    if (!hasMisc) {
      xml = xml.slice(0, from) + xml.slice(mt.end);
    } else {
      // No struct lines: the misc table takes the struct table's place on page 1.
      // Not on a new page: a normal-height empty line separates the two tables instead.
      let sep = brk;
      if (isBreak && !hasStruct) sep = '';
      else if (isBreak && !MISC_ON_NEW_PAGE) sep = brk.replace(/<w:pageBreakBefore\s*\/>/, '').replace(/<w:spacing [^>]*\/>/, '<w:spacing w:before="0" w:after="0" />');
      const tbl = setTableBody(mt, scopeRows(miscGroups, headingRow, mt.rows[1]));
      xml = xml.slice(0, from) + (isBreak ? sep : '') + tbl + xml.slice(mt.end);
    }
  }

  if (hasStruct || !hasMisc) {
    const body = hasStruct ? scopeRows(structGroups, headingRow, structItem) : [fillRow(structItem, ['', '', ''])];
    xml = xml.slice(0, st.start) + setTableBody(st, body) + xml.slice(st.end);
  } else {
    xml = xml.slice(0, st.start) + xml.slice(st.end);
  }
  return xml;
}

// Replace the list under the "EXCLUSIONS" heading with the proposal exclusions
function buildExclusions(xml, exclusions) {
  const paras = [...xml.matchAll(P_RE)];
  const head = paras.findIndex(m => paraText(m[0]).trim() === 'EXCLUSIONS');
  if (head < 0) return xml;
  const bullets = [];
  for (let i = head + 1; i < paras.length && /<w:numPr>/.test(paras[i][0]) && paraText(paras[i][0]).trim(); i++) bullets.push(paras[i]);
  if (!bullets.length) return xml;
  const tpl = stripIds(bullets[0][0]);
  const list = exclusions.length ? exclusions : ['None'];
  const newXml = list.map(e => setParagraphText(tpl, e)).join('');
  const from = bullets[0].index;
  const to = bullets[bullets.length - 1].index + bullets[bullets.length - 1][0].length;
  return xml.slice(0, from) + newXml + xml.slice(to);
}

// "DETAILING COST" table: one row per package plus the dark total row, amounts left as placeholders
//   Total Cost for Structural Package    $00,000.00
//   Total Cost for Misc. Package         $00,000.00
//   Total Cost for PE, S & S Package     $00,000.00
//   Total for all the above              $00,000.00   (black row)
const COST_LINES = ['Total Cost for Structural Package', 'Total Cost for Misc. Package', 'Total Cost for PE, S & S Package'];
const COST_TOTAL = 'Total for all the above';
const AMOUNT_PLACEHOLDER = '$00,000.00';

function buildCostTable(xml) {
  const t = findTable(xml, '>Total Cost for Structural Package<');
  if (!t || t.rows.length < 2) return xml;
  const lineRow = t.rows[0], totalRow = t.rows[t.rows.length - 1];
  const rows = [...COST_LINES.map(l => fillRow(lineRow, [l, AMOUNT_PLACEHOLDER])), fillRow(totalRow, [COST_TOTAL, AMOUNT_PLACEHOLDER])];
  const firstRowAt = t.tbl.indexOf(t.rows[0]);
  const lastRowEnd = t.tbl.lastIndexOf(totalRow) + totalRow.length;
  return xml.slice(0, t.start) + t.tbl.slice(0, firstRowAt) + rows.join('') + t.tbl.slice(lastRowEnd) + xml.slice(t.end);
}

// Total page count for the footer, estimated from the template's layout (measured in points on a Letter page).
// Checked against Word's own page count for short to 90-row scopes, wrapped descriptions and misc-only proposals.
const LAYOUT = {
  bodyTop: 65, bodyBottom: 727,     // 0.9" top / bottom margins
  scopeTopPage1: 360,               // first scope row on page 1 (below the banner, info grid and intro)
  bannerCharsPerLine: 38, bannerExtraLine: 20,
  scopeTopNextPage: 83,             // first scope row below the repeated table header
  row: 18.2, rowExtraLine: 10.5,    // scope row and each extra wrapped line
  descChars: 50, notesChars: 20,    // characters per line in the description / notes columns
  exclusionsHead: 39.5, exclusionLine: 14.4, exclusionChars: 95,
  cost: 129, schedule: 55, signature: 135,
  termsPages: 2,                    // TERMS & CONDITIONS always starts on a new page and fills two
};

function estimatePageCount({ projectTitle, structGroups, miscGroups, exclusions }) {
  const L = LAYOUT;
  let pages = 1;
  const bannerLines = Math.max(1, Math.ceil(`QUOTE / ${projectTitle}`.length / L.bannerCharsPerLine));
  let y = L.scopeTopPage1 + (bannerLines - 1) * L.bannerExtraLine;
  const place = h => { if (y + h > L.bodyBottom) { pages++; y = L.bodyTop; } y += h; };
  const rows = (groups, top) => {
    groups.forEach((lines, g) => {
      if (g && !lines[0]?.heading) lines = [{}, ...lines];
      for (const l of lines) {
        const n = Math.max(1, Math.ceil(String(l.description ?? '').length / L.descChars), Math.ceil(String(l.notes ?? '').length / L.notesChars));
        const h = L.row + (n - 1) * L.rowExtraLine;
        if (y + h > L.bodyBottom) { pages++; y = top; }
        y += h;
      }
    });
  };
  const hasStruct = structGroups.length > 0, hasMisc = miscGroups.length > 0;
  if (hasStruct || !hasMisc) rows(hasStruct ? structGroups : [[{}]], L.scopeTopNextPage);
  if (hasMisc) {
    if (hasStruct && MISC_ON_NEW_PAGE) { pages++; y = L.scopeTopNextPage; } else if (hasStruct) y += 14 + L.row;
    rows(miscGroups, L.scopeTopNextPage);
  }
  const exLines = (exclusions.length ? exclusions : ['None']).map(e => Math.max(1, Math.ceil(e.length / L.exclusionChars)));
  place(L.exclusionsHead + exLines[0] * L.exclusionLine);
  exLines.slice(1).forEach(n => place(n * L.exclusionLine));
  place(L.cost);
  place(L.schedule);
  place(L.signature);
  return pages + L.termsPages;
}

// Footer "Page X of Y".
// Page 1 has its own footer, which Word lays out before it has counted the pages and does not refresh, so a
// live NUMPAGES there shows "of 1". That footer gets plain text instead: "1" and the estimated total.
// The other pages keep the live fields (with the same values stored as their results).
async function setFooterPageFields(zip, xml, totalPages) {
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const target = id => (rels.match(new RegExp(`<Relationship [^>]*Id="${id}"[^>]*>`)) || [''])[0].match(/Target="([^"]*)"/)?.[1];
  const RPR = '<w:rPr>(?:(?!<\\/w:rPr>)[\\s\\S])*<\\/w:rPr>'; // one run's properties, never spanning into the next run
  const run = n => `<w:r>(${RPR})?${n}<\\/w:r>`;
  // A whole complex field: begin, instruction, separate, optional result runs, end
  const fieldRe = new RegExp(`${run('<w:fldChar w:fldCharType="begin"[^>]*\\/>')}<w:r>(?:${RPR})?<w:instrText[^>]*>\\s*(PAGE|NUMPAGES)\\s*<\\/w:instrText><\\/w:r>` +
    `${run('<w:fldChar w:fldCharType="separate"\\s*\\/>')}((?:<w:r>(?:${RPR})?<w:t[^>]*>[^<]*<\\/w:t><\\/w:r>)*)${run('<w:fldChar w:fldCharType="end"\\s*\\/>')}`, 'g');
  for (const [, type, id] of xml.matchAll(/<w:footerReference w:type="(\w+)" r:id="(\w+)"\s*\/>/g)) {
    const name = target(id) && `word/${target(id)}`;
    if (!name || !zip.file(name)) continue;
    const first = type === 'first';
    const values = { PAGE: first ? 1 : 2, NUMPAGES: totalPages };
    let f = await zip.file(name).async('string');
    f = f.replace(fieldRe, (m, rPr = '', instr) => {
      const text = `<w:r>${rPr}<w:t>${values[instr]}</w:t></w:r>`;
      return first ? text : m.replace(/(<w:fldChar w:fldCharType="separate"\s*\/><\/w:r>)(?:<w:r>(?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t[^>]*>[^<]*<\/w:t><\/w:r>)*/, `$1${text}`);
    });
    zip.file(name, f);
  }
}

function proposalDate(est) {
  const d = est.proposalDate ? new Date(est.proposalDate) : new Date();
  const utc = !!est.proposalDate; // stored dates are UTC midnight
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  return { y, m, day };
}

// pageName: for the one-proposal-per-chart-page download
function proposalFileName(est, pageName) {
  const { y, m, day } = proposalDate(est);
  const name = [est.jobNo, est.projectName, pageName].filter(Boolean).join(' - ');
  return `${name} - Proposal -${pad(m + 1)}-${pad(day)}-${y}.docx`.replace(/[\\/:*?"<>|]/g, '-');
}

async function buildProposal(est) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let xml = await zip.file('word/document.xml').async('string');

  const { y, m, day } = proposalDate(est);
  const projectTitle = [est.jobNo, est.projectName].filter(Boolean).join(' - ');
  const attn = est.clientName ? `VectorShades w/ ${est.clientName}` : 'VectorShades';
  const quoteNo = est.quoteNo || `${pad(m + 1)}${pad(day)}${y}-01`;

  // Signer first: the filled-in client values may themselves contain the sample signer's name
  if (est.signerName) xml = replaceAll(xml, T.signer, est.signerName);
  if (est.signerTitle) xml = replaceAll(xml, T.title, est.signerTitle);
  xml = replaceAll(xml, T.projectUpper, projectTitle.toUpperCase());
  xml = replaceAll(xml, T.project, projectTitle);
  xml = replaceAll(xml, T.attn, attn);
  xml = replaceAll(xml, T.date, `${MONTHS[m]} ${pad(day)}, ${y}`);
  xml = replaceAll(xml, T.quoteNo, quoteNo);
  // Detailing cost: package rows with $00,000.00 placeholders (amounts are filled in manually)
  xml = buildCostTable(xml);
  // Schedule of Submittals for Approval: "<n> weeks", plus the sequencing note for long schedules
  const weeks = est.submittalWeeks ?? ''; // blank = filled in manually
  xml = xml.replace(P_RE, p => {
    const t = paraText(p);
    const mm = t.match(/^([\d-]+)( ?\s*weeks)/);
    if (!mm) return p;
    let out = replaceInParagraph(p, mm[1], String(weeks));
    if (Number(weeks) > LONG_SCHEDULE_WEEKS) out = replaceInParagraph(out, mm[2], `${mm[2]}${LONG_SCHEDULE_NOTE}`);
    return out;
  });

  // Scope of Work: every page's Struct. lines in the first table, every page's Misc. lines in the second
  const groups = key => (est.pages || []).map(p => p[key] || []).filter(s => s.length);
  const structGroups = groups('structDescriptions'), miscGroups = groups('miscDescriptions');
  const exclusions = (est.proposalExclusions || []).filter(Boolean);
  xml = buildScopeTables(xml, structGroups, miscGroups);
  xml = buildExclusions(xml, exclusions);
  zip.file('word/document.xml', xml);
  await setFooterPageFields(zip, xml, estimatePageCount({ projectTitle, structGroups, miscGroups, exclusions }));

  // Page header on pages 2+: "QUOTE # <no>  |  <project>"
  for (const name of Object.keys(zip.files).filter(n => /^word\/header\d*\.xml$/.test(n))) {
    let h = await zip.file(name).async('string');
    h = replaceAll(h, T.quoteNo, quoteNo);
    h = replaceAll(h, T.project, projectTitle);
    zip.file(name, h);
  }
  const core = zip.file('docProps/core.xml');
  if (core) zip.file('docProps/core.xml', (await core.async('string')).replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>${xmlEsc(`QUOTE / ${projectTitle}`)}</dc:title>`));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildProposal, proposalFileName };
