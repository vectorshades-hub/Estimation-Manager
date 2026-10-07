// Builds the reply email ("Please find attached excel sheet of …") as HTML + plain text.
window.EstEmail = (function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const projectTitle = est => [est.jobNo, est.projectName].filter(Boolean).join(' - ');

  function tonnageText(est, calcTonnage) {
    const t = est.quotedTonnage != null && est.quotedTonnage !== '' ? +est.quotedTonnage : Math.round(calcTonnage || 0);
    return `${t.toLocaleString()} MT`;
  }

  function rows(est, calcTonnage) {
    return [
      ['Project Name', projectTitle(est)],
      ['Client Name', est.clientName],
      ['Estimated Steel Tonnage (Approx)', tonnageText(est, calcTonnage)],
      ['Major Scope items', est.scope],
      ['Complexity', est.complexity],
      ['Deliverables', (est.deliverables || []).join(', ')],
      ['Coordination needed', est.coordinationNeeded],
      ['Project Duration (Approx)', est.durationWeeks ? `${est.durationWeeks} Weeks` : ''],
      ['Assumptions*', est.assumptions],
      ['Exclusions*', (est.exclusions || []).join(', ')],
      ['Remark*', est.remark || 'Nil'],
    ];
  }

  function build(est, calcTonnage, { greeting = 'Hi sir,', includeLinks = false, signature = '' } = {}) {
    const font = "font-family:Aptos,Calibri,Arial,sans-serif;font-size:11pt;color:#000;";
    const cell = `border:1px solid #000;padding:3px 6px;${font}`;
    const links = includeLinks ? (est.links || []).filter(l => l.url) : [];
    const data = rows(est, calcTonnage);

    const html = `<div style="${font}">
<p style="margin:0 0 14px;${font}">${esc(greeting)}</p>
<p style="margin:0 0 14px;${font}">Please find attached excel sheet of ${esc(projectTitle(est))} project.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #000;">
<tr><th style="${cell}background:#DDD9C4;font-weight:bold;text-align:center;width:290px;">ITEM</th><th style="${cell}background:#DDD9C4;font-weight:bold;text-align:center;width:490px;">DETAILS</th></tr>
${data.map(([k, v]) => `<tr><td style="${cell}">${esc(k)}</td><td style="${cell}">${esc(v)}</td></tr>`).join('\n')}
</table>
${links.length ? `<p style="margin:14px 0 0;${font}">SharePoint folder:${links.map(l => `<br><a href="${esc(l.url)}">${esc(l.label || l.url)}</a>`).join('')}</p>` : ''}
${signature ? `<p style="margin:14px 0 0;${font}">${esc(signature).replace(/\n/g, '<br>')}</p>` : ''}
</div>`;

    const w = Math.max(...data.map(([k]) => k.length));
    const text = [
      greeting, '',
      `Please find attached excel sheet of ${projectTitle(est)} project.`, '',
      ...data.map(([k, v]) => `${k.padEnd(w)}  :  ${v ?? ''}`),
      ...(links.length ? ['', 'SharePoint folder:', ...links.map(l => `${l.label ? l.label + ': ' : ''}${l.url}`)] : []),
      ...(signature ? ['', signature] : []),
    ].join('\r\n');

    return { html, text };
  }

  return { build, projectTitle };
})();
