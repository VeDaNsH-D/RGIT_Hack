import PDFDocument from 'pdfkit';

/**
 * Renders a persisted HandoffReport as a PDF (A4). Uses only report content that was already validated and
 * stored; source links are real clickable annotations. Fonts are the built-in PDF fonts (WinAnsi), so
 * characters outside that range are replaced rather than failing.
 */

const COLORS = { ink: '#221e1b', muted: '#7a6f66', orange: '#d33b14', rule: '#ede8e2' };
const KIND = { fact: 'Source-backed', inference: 'Inference', unknown: 'Unknown' };

const clean = (value) => String(value ?? '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[–—]/g, '-').replace(/→/g, '->')
  .replace(/[^\u0009\u000A -~ -ÿ]/g, '?');

export function renderReportPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: `Developer handoff - ${clean(report.projectName)}`, Author: 'Relay', Subject: 'Repository-aware developer handoff' }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const when = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    doc.fillColor(COLORS.orange).font('Helvetica-Bold').fontSize(9).text('DEVELOPER HANDOFF', { characterSpacing: 1.5 });
    doc.moveDown(0.3).fillColor(COLORS.ink).fontSize(22).text(clean(report.projectName));
    doc.moveDown(0.3).font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(`Generated ${when(report.generatedAt)}`);
    for (const r of report.repositories || []) {
      doc.fillColor(COLORS.ink).fontSize(9).text(`${clean(r.fullName)}  |  branch ${clean(r.branch)}  |  analyzed commit ${clean(r.commitSha)}`, { continued: false });
      doc.fillColor(COLORS.muted).text(`Analysis ${clean(r.status)}: ${r.coverage?.analyzed ?? '?'} of ${r.coverage?.eligible ?? '?'} eligible files (${r.coverage?.percent ?? '?'}%)  |  knowledge ${clean(r.freshness || 'unknown')}  |  analyzed ${r.analyzedAt ? when(r.analyzedAt) : 'unknown'}`);
      if (r.url) doc.fillColor(COLORS.orange).text(clean(r.url), { link: r.url, underline: true });
    }
    if (report.limitations?.length) {
      doc.moveDown(0.6).fillColor(COLORS.orange).font('Helvetica-Bold').fontSize(9).text('Limitations');
      doc.font('Helvetica').fillColor(COLORS.muted).fontSize(9);
      for (const l of report.limitations) doc.text(`- ${clean(l)}`, { width });
    }

    for (const section of report.sections || []) {
      doc.moveDown(1);
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(13).text(clean(section.title), { width });
      doc.moveTo(doc.x, doc.y + 2).lineTo(doc.x + width, doc.y + 2).strokeColor(COLORS.rule).lineWidth(1).stroke();
      doc.moveDown(0.5);
      for (const item of section.items || []) {
        doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink).text(`- ${clean(item.text)}`, { width, lineGap: 2 });
        const tags = [item.kind && KIND[item.kind]].filter(Boolean).join(' ');
        if (section.key !== 'links' && tags) doc.fontSize(8).fillColor(COLORS.muted).text(`    ${tags}`, { width });
        for (const e of item.evidence || []) {
          if (section.key === 'links') { if (e.url) doc.fontSize(9).fillColor(COLORS.orange).text(`    ${clean(e.url)}`, { link: e.url, underline: true, width }); continue; }
          if (e.url) doc.fontSize(8).fillColor(COLORS.orange).text(`    Source: ${clean(e.label)}`, { link: e.url, underline: true, width });
          else doc.fontSize(8).fillColor(COLORS.muted).text(`    Source: ${clean(e.label)}`, { width });
        }
        doc.moveDown(0.35);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Relay - ${clean(report.projectName)} - page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 36, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}
