// Fills templates/proposal-template.docx (the company "Project Name - Proposal -MM-DD-YYYY" Word file)
// with one estimation's details. Everything else in the template (logo, footers, terms) is left untouched.
// The detailing cost ($ amount) is intentionally left blank to be filled in manually.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'proposal-template.docx');

// Text that is in the template and gets replaced
const T = {
  project: 'Truss Rehab',
  attn: 'Stephen Johnson w/ Advantage Steel and Construction',
  date: 'October 02, 2026',
  quoteNo: '10022026-01',
  signer: 'Lee Luck',
  title: 'Lead Estimator',
  amount: '9,800.00',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');

const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const P_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;

const paraText = p => [...p.matchAll(T_RE)].map(m => xmlUnesc(m[2])).join('');

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

// Set the whole text of a paragraph; if it has no text run yet, create one using the paragraph's run style
function setParagraphText(p, text) {
  const cur = paraText(p);
  if (/<w:t[\s>]/.test(p)) return replaceInParagraph(p, cur, text);
  if (!text) return p;
  const rPr = (p.match(/<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/) || [])[1] || '';
  return p.replace(/<\/w:p>$/, `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`);
}

// Set the text of each cell (first paragraph) of a table row
function fillRow(rowXml, values) {
  let i = 0;
  return rowXml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => {
    const v = values[i++] ?? '';
    let done = false;
    return tc.replace(P_RE, p => {
      if (done) return p;
      done = true;
      return setParagraphText(p, String(v));
    });
  });
}

// Rebuild the "Scope of Work" table (QTY / STRUCT. DESCRIPTION / NOTES) from the description lists
function buildScopeTable(xml, lines) {
  const qtyAt = xml.indexOf('>QTY:<');
  if (qtyAt < 0) return xml;
  const start = xml.lastIndexOf('<w:tbl>', qtyAt);
  const end = xml.indexOf('</w:tbl>', qtyAt) + '</w:tbl>'.length;
  const tbl = xml.slice(start, end);
  const rows = tbl.match(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g);
  if (!rows || rows.length < 4) return xml;
  const [headerRow, headingRow, itemRow, blankRow] = rows; // template: header, blue heading, item, spacer

  const out = [];
  lines.forEach((l, i) => {
    const empty = !l.qty && !l.description && !l.notes;
    if (empty) { out.push(blankRow); return; }
    if (l.heading && i > 0 && out.length && out[out.length - 1] !== blankRow) out.push(blankRow);
    out.push(fillRow(l.heading ? headingRow : itemRow, [l.qty, l.description, l.notes]));
  });
  if (!out.length) out.push(fillRow(itemRow, ['', '', '']));

  const firstRowAt = tbl.indexOf(rows[0]);
  const lastRowEnd = tbl.lastIndexOf(rows[rows.length - 1]) + rows[rows.length - 1].length;
  const newTbl = tbl.slice(0, firstRowAt) + headerRow + out.join('') + tbl.slice(lastRowEnd);
  return xml.slice(0, start) + newTbl + xml.slice(end);
}

// Replace the bullet list under "Exclusions:" with the estimation's exclusions
function buildExclusions(xml, exclusions) {
  const paras = [...xml.matchAll(P_RE)];
  const head = paras.findIndex(m => paraText(m[0]).trim() === 'Exclusions:');
  if (head < 0) return xml;
  const bullets = [];
  for (let i = head + 1; i < paras.length && /<w:numPr>/.test(paras[i][0]) && paraText(paras[i][0]).trim(); i++) bullets.push(paras[i]);
  if (!bullets.length) return xml;
  const tpl = bullets[0][0];
  const list = exclusions.length ? exclusions : ['None'];
  const newXml = list.map(e => setParagraphText(tpl, e)).join('');
  const from = bullets[0].index;
  const to = bullets[bullets.length - 1].index + bullets[bullets.length - 1][0].length;
  return xml.slice(0, from) + newXml + xml.slice(to);
}

// Start "TERMS & CONDITIONS" on a new page (pageBreakBefore must follow pStyle/keepNext/keepLines in pPr)
function termsOnNewPage(xml) {
  return xml.replace(P_RE, p => {
    if (paraText(p).trim() !== 'TERMS & CONDITIONS' || p.includes('<w:pageBreakBefore')) return p;
    if (!/<w:pPr>/.test(p)) return p.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr><w:pageBreakBefore/></w:pPr>');
    return p.replace(/<w:pPr>((?:<w:pStyle\b[^>]*\/>)?(?:<w:keepNext\b[^>]*\/>)?(?:<w:keepLines\b[^>]*\/>)?)/, '<w:pPr>$1<w:pageBreakBefore/>');
  });
}

function proposalDate(est) {
  const d = est.proposalDate ? new Date(est.proposalDate) : new Date();
  const utc = !!est.proposalDate; // stored dates are UTC midnight
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  return { y, m, day };
}

function proposalFileName(est) {
  const { y, m, day } = proposalDate(est);
  const name = [est.jobNo, est.projectName].filter(Boolean).join(' - ');
  return `${name} - Proposal -${pad(m + 1)}-${pad(day)}-${y}.docx`.replace(/[\\/:*?"<>|]/g, '-');
}

async function buildProposal(est) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let xml = await zip.file('word/document.xml').async('string');

  const { y, m, day } = proposalDate(est);
  const projectTitle = [est.jobNo, est.projectName].filter(Boolean).join(' - ');
  const attn = est.contactPerson ? `${est.contactPerson} w/ ${est.clientName}` : est.clientName || '';
  const quoteNo = est.quoteNo || `${pad(m + 1)}${pad(day)}${y}-01`;

  xml = replaceAll(xml, T.project, projectTitle);
  xml = replaceAll(xml, T.attn, attn);
  xml = replaceAll(xml, T.date, `${MONTHS[m]} ${pad(day)}, ${y}`);
  xml = replaceAll(xml, T.quoteNo, quoteNo);
  if (est.signerName) xml = replaceAll(xml, T.signer, est.signerName);
  if (est.signerTitle) xml = replaceAll(xml, T.title, est.signerTitle);
  // Detailing cost: keep "$" and leave the amount blank (filled in manually)
  xml = replaceAll(xml, `$${T.amount}`, '$', t => t.includes('Total for'));
  // Schedule of Submittals for Approval: "<n> weeks"
  const weeks = est.submittalWeeks ?? 2;
  xml = xml.replace(P_RE, p => {
    const t = paraText(p);
    const mm = t.match(/^(\d+) ?\s*weeks/);
    return mm ? replaceInParagraph(p, mm[1], String(weeks)) : p;
  });

  const struct = est.structDescriptions || [], misc = est.miscDescriptions || [];
  const lines = [...struct, ...(struct.length && misc.length ? [{}] : []), ...misc]; // blank spacer row between sections
  xml = buildScopeTable(xml, lines);
  xml = buildExclusions(xml, (est.exclusions || []).filter(Boolean));

  xml = termsOnNewPage(xml);

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildProposal, proposalFileName };
