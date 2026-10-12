import PDFDocument from 'pdfkit';

/**
 * Renders a persisted HandoffReport as a PDF (A4). Uses only report content that was already validated and
 * stored; source links are real clickable annotations. Fonts are the built-in PDF fonts (WinAnsi), so
 * characters outside that range are replaced rather than failing.
 */

const COLORS = { ink: '#221e1b', muted: '#7a6f66', orange: '#d33b14', rule: '#ede8e2' };
const KIND = { fact: 'Source-backed', inference: 'Inference', unknown: 'Unknown' };
export const SOURCE_TYPE_LABELS = {
  repository_file: 'Repository file', repository: 'Repository', issue: 'GitHub issue', pull_request: 'Pull request', commit: 'Commit',
  document: 'Uploaded document', jira_issue: 'Jira issue', slack_message: 'Slack message', note: 'Relay note', handoff: 'Previous handoff', task: 'Relay task',
};
const typeTag = (e) => (SOURCE_TYPE_LABELS[e.type] ? `[${SOURCE_TYPE_LABELS[e.type]}] ` : '');
// Document sources are private: they carry a stable reference (not a link) and are opened inside Relay by authorized members.
const docRef = (e) => (e.document?.chunkId ? ` (ref ${e.document.chunkId})` : '');

const clean = (value) => String(value ?? '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/[–—]/g, '-').replace(/→/g, '->')
  .replace(/[^\u0009\u000A -~ -ÿ]/g, '?');

function renderLegacyReportPdf(report) {
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
          if (section.key === 'links') { if (/^https?:\/\//.test(e.url || '')) doc.fontSize(9).fillColor(COLORS.orange).text(`    ${clean(e.url)}`, { link: e.url, underline: true, width }); continue; }
          if (/^https?:\/\//.test(e.url || '')) doc.fontSize(8).fillColor(COLORS.orange).text(`    Source: ${typeTag(e)}${clean(e.label)}`, { link: e.url, underline: true, width });
          else doc.fontSize(8).fillColor(COLORS.muted).text(`    Source: ${typeTag(e)}${clean(e.label)}${clean(docRef(e))}`, { width });
        }
        doc.moveDown(0.35);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer text sits inside the bottom margin; without this pdfkit appends an empty page per footer
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Relay - ${clean(report.projectName)} - page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 36, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}


// ---------------------------------------------------------------------------------------------------------------------
// Engineering handoff (v5+): rendered from the same validated structure as the web preview
// ---------------------------------------------------------------------------------------------------------------------

const KIND_TAG = { fact: 'Verified fact', inference: 'Inference', unknown: 'Unknown' };
const KIND_COLOR = { fact: '#4f7a4f', inference: '#a8641f', unknown: '#7a6f66' };
const STATUS_TAG = { matches: 'Matches', conflicts: 'Conflict', unverified: 'Unverified', not_found: 'Not found in code' };
const BASIS_TAG = { confirmed: 'confirmed', suggested: 'suggested', clarification_needed: 'clarification needed' };
const refText = (item) => (item.refs?.length ? ` [${item.refs.join(',')}]` : '');
const wasLabelled = (item) => ({ confirmed: 'Confirmed', 'inferred risk': 'Inferred risk' }[item.label] || null);
/** Joins list entries with "; " unless an entry already ends a sentence. */
const joinList = (list) => (list || []).reduce((acc, x, i) => (i === 0 ? x : `${acc}${/[.!?]$/.test(acc) ? ' ' : '; '}${x}`), '');
const isLink = (e) => /^https?:\/\//.test(e?.url || '');

export function renderEngineeringPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Developer handoff - ${clean(report.projectName)}`, Author: 'Relay', Subject: 'Engineering handoff' }, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const when = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    /** Starts a new page unless `h` points still fit; never adds a page at the top of an empty one. */
    const space = (h) => { if (doc.y > doc.page.margins.top + 4 && doc.y > bottom() - h) doc.addPage(); };
    const heightOf = (text, font, size, w) => { doc.font(font).fontSize(size); return doc.heightOfString(clean(text), { width: w, lineGap: 1.5 }); };
    const heading = (text, size = 12) => {
      space(80);
      doc.moveDown(0.9).fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(size).text(clean(text), left, doc.y, { width });
      doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(COLORS.rule).lineWidth(1).stroke();
      doc.moveDown(0.45);
    };
    const subheading = (text) => { space(60); doc.moveDown(0.7).fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10.5).text(clean(text), left, doc.y, { width }); doc.moveDown(0.25); };
    const label = (text) => { space(48); doc.moveDown(0.6).fillColor(COLORS.orange).font('Helvetica-Bold').fontSize(8).text(clean(text.toUpperCase()), left, doc.y, { characterSpacing: 1, width }); doc.moveDown(0.25); };
    const note = (text) => { if (text) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(COLORS.muted).text(clean(text), left, doc.y, { width, lineGap: 1 }); doc.moveDown(0.3); } };
    /** One bullet: optional coloured tag, the statement (a link when it is an inline-linked deterministic item), then compact source numbers. */
    const bullet = (item, { tag, tagColor, indent = 0 } = {}) => {
      const w = width - indent - 12;
      space(Math.min(heightOf(`${tag || ''} ${item.text}${refText(item)}`, 'Helvetica', 9.5, w) + 6, 120));
      const x = left + indent; const y = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.ink).text('-', x, y, { width: 10, lineBreak: false });
      const url = item.inline && isLink(item.evidence?.[0]) ? item.evidence[0].url : null;
      // One continued chain whose wrapper (x, width) is set by its first call, so the text wraps inside the bullet's column.
      if (tag) doc.font('Helvetica-Bold').fontSize(7.5).fillColor(tagColor || COLORS.muted).text(`${clean(tag)}  `, x + 12, y + 1, { continued: true, width: w });
      doc.font('Helvetica').fontSize(9.5).fillColor(url ? COLORS.orange : COLORS.ink).text(`${clean(item.text)}${refText(item)}`, tag ? undefined : x + 12, tag ? undefined : y, { width: w, lineGap: 1.5, ...(url ? { link: url, underline: true } : {}) });
      if (item.resolvedLabel) doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Addressed by: ${item.resolvedLabel}`, x + 12, doc.y, { width: w });
      doc.x = left;
    };
    /** "Name: value" line, indented under its item; `mono` for paths and symbols (wraps inside the column). */
    const detail = (name, text, { mono = false, indent = 14, color } = {}) => {
      if (!text) return;
      space(Math.min(heightOf(`${name}: ${text}`, mono ? 'Courier' : 'Helvetica', 8.5, width - indent) + 4, 80));
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(color || COLORS.muted).text(`${name}: `, left + indent, doc.y, { continued: true, width: width - indent });
      doc.font(mono ? 'Courier' : 'Helvetica').fontSize(mono ? 8 : 8.5).fillColor(COLORS.ink).text(clean(text), { width: width - indent, lineGap: 1 });
    };
    const action = (item, n) => {
      space(Math.min(110, 40 + heightOf(item.text, 'Helvetica-Bold', 9.5, width)));
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.ink).text(`${n}. `, left, doc.y, { continued: true, width });
      doc.fillColor(item.priority === 'P1' ? COLORS.orange : COLORS.muted).fontSize(8).text(`${item.priority} ${BASIS_TAG[item.basis] || 'suggested'}  `, { continued: true });
      doc.fillColor(COLORS.ink).fontSize(9.5).text(clean(item.text), { continued: Boolean(item.refs?.length) });
      if (item.refs?.length) doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted).text(refText(item));
      detail('Why', item.why); detail('Needs first', joinList(item.prerequisites)); detail('Done when', item.doneWhen);
      if (item.files?.length) detail('Files', item.files.join(', '), { mono: true });
      if (item.symbols?.length) detail('Symbols', item.symbols.join(', '), { mono: true });
      detail('Scope', item.note, { color: COLORS.orange });
      doc.moveDown(0.35);
    };
    /** Technical walkthrough entry: purpose, entry point, ordered execution flow, functions and relationships, I/O, dependencies, limits. */
    const subsystem = (item) => {
      space(120);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.ink).text(clean(item.text), left, doc.y, { continued: true, width });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(KIND_COLOR[item.kind]).text(`   ${KIND_TAG[item.kind]}`, { continued: Boolean(item.refs?.length) });
      if (item.refs?.length) doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted).text(refText(item));
      doc.moveDown(0.15);
      if (item.purpose) detail('Purpose', item.purpose);
      if (item.entry) detail('Entry point', item.entry, { mono: true });
      if (item.steps?.length) {
        space(40);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted).text('Execution flow:', left + 14, doc.y, { width: width - 14 });
        item.steps.forEach((step, i) => { space(24); doc.font('Helvetica').fontSize(9).fillColor(COLORS.ink).text(`${i + 1}. ${clean(step)}`, left + 24, doc.y, { width: width - 24, lineGap: 1.3 }); });
      } else detail('How it runs', item.flow);
      if (item.steps?.length && item.flow) detail('Summary', item.flow);
      if (item.functions?.length) {
        space(30);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.muted).text('Key functions:', left + 14, doc.y, { width: width - 14 });
        for (const f of item.functions) {
          space(26);
          doc.font('Courier-Bold').fontSize(8).fillColor(COLORS.ink).text(`${clean(f.name)}${f.file && f.line ? ` (${clean(f.file)}:${f.line})` : ''}`, left + 24, doc.y, { continued: Boolean(f.role), width: width - 24 });
          if (f.role) doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.ink).text(`  ${clean(f.role)}`, { width: width - 24, lineGap: 1 });
        }
      }
      if (item.calls?.length) detail('Textual call sites', item.calls.map((c) => `${c.from} -> ${c.to} (L${c.line})`).join(', '), { mono: true });
      detail('Inputs', joinList(item.inputs)); detail('Outputs', joinList(item.outputs));
      detail('Depends on', joinList(item.dependencies));
      detail('Limitations', joinList(item.limits), { color: COLORS.orange });
      if (item.files?.length) detail('Files', item.files.join(', '), { mono: true });
      doc.moveDown(0.5);
    };
    const onboardingStep = (item, n) => {
      space(70);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.ink).text(`${n}. ${clean(item.text)}`, left, doc.y, { continued: Boolean(item.refs?.length), width });
      if (item.refs?.length) doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted).text(refText(item));
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.ink).text(clean(item.detail), left + 14, doc.y, { width: width - 14, lineGap: 1.3 });
      for (const r of item.reads || []) {
        space(26);
        doc.font('Courier-Bold').fontSize(8).fillColor(COLORS.ink).text(clean(r.file), left + 24, doc.y, { continued: Boolean(r.why), width: width - 24 });
        if (r.why) doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted).text(` - ${clean(r.why)}`, { width: width - 24, lineGap: 1 });
      }
      doc.moveDown(0.4);
    };

    // ---- Page one: executive summary, verified state, first actions -------------------------------------------
    const b = report.brief;
    doc.fillColor(COLORS.orange).font('Helvetica-Bold').fontSize(8.5).text('DEVELOPER HANDOFF', left, doc.y, { characterSpacing: 1.5 });
    doc.moveDown(0.25).fillColor(COLORS.ink).fontSize(20).text(clean(report.projectName), { width });
    doc.moveDown(0.2).font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Generated ${when(report.generatedAt)}${report.complexity ? `  |  ${report.complexity} codebase` : ''}`);
    for (const r of report.repositories || []) {
      const cov = (report.verification?.coverage || []).find((c) => c.repository === r.fullName);
      doc.fontSize(8).fillColor(COLORS.muted).text(`${clean(r.fullName)}  |  ${clean(r.branch)} @ ${clean(String(r.commitSha).slice(0, 7))}  |  analysis ${clean(r.status)}: ${r.coverage?.analyzed ?? '?'} of ${r.coverage?.eligible ?? '?'} files (${r.coverage?.percent ?? '?'}%)${cov?.gaps?.length ? `  |  not analyzed: ${clean(cov.gaps.join(', '))}` : ''}`, { width });
    }

    label('Executive summary');
    doc.font('Helvetica').fontSize(10.5).fillColor(COLORS.ink).text(clean(b.summary), left, doc.y, { width, lineGap: 2 });

    if (b.currentState?.length || b.status?.length) {
      label('Current verified state');
      for (const i of b.currentState || []) bullet(i);
      for (const st of b.status || []) detail(st.label, st.text, { indent: 0 });
    }
    if (b.doFirst?.length) { label('Do first'); b.doFirst.forEach((i) => action(i, i.n || 1)); }
    if (b.findings?.text) { doc.moveDown(0.1); detail('Needs attention', b.findings.text, { indent: 0, color: COLORS.orange }); }
    // Reports stored before the findings pointer existed keep their one-page attention list.
    if (b.attention?.length) { label('Needs attention'); for (const i of b.attention) bullet(i, { tag: i.type === 'comparison' ? 'Conflict' : (wasLabelled(i) || KIND_TAG[i.kind]), tagColor: i.label === 'confirmed' || i.type === 'comparison' ? COLORS.orange : KIND_COLOR[i.kind] }); }

    // ---- Sections in reading order (empty ones never exist) --------------------------------------------------
    let group = null;
    for (const section of report.sections || []) {
      if (section.group) { if (section.group !== group) { heading(section.group); group = section.group; } subheading(section.title); } else { group = null; heading(section.title); }
      note(section.intro);
      let n = 0;
      for (const item of section.items || []) {
        if (item.type === 'recommendation') { action(item, item.n || (n += 1)); continue; }
        if (item.type === 'subsystem' || item.type === 'path') { subsystem(item.type === 'path' ? { ...item, steps: [], functions: [], calls: [] } : item); continue; }
        if (item.type === 'step') { onboardingStep(item, (n += 1)); continue; }
        if (item.type === 'status') { space(30); detail(item.label, item.text, { indent: 0 }); continue; }
        const ai = section.origin === 'ai';
        const tag = item.type === 'comparison' ? STATUS_TAG[item.status] : (wasLabelled(item) || (ai || item.kind === 'unknown' ? KIND_TAG[item.kind] : null));
        const color = item.type === 'comparison' && item.status === 'conflicts' ? COLORS.orange : item.label === 'confirmed' ? COLORS.orange : KIND_COLOR[item.kind];
        bullet(item, { tag, tagColor: color });
        doc.moveDown(0.15);
      }
    }
    // Reports stored before the verification section existed still show their verification block.
    const v = report.verification;
    if (v && !(report.sections || []).some((s) => s.key === 'verification') && v.tests && v.runtime) {
      heading('Verification status');
      for (const [k, text] of [['Tests executed', v.tests.executed.detail], ['Runtime behaviour', v.runtime.detail], ['Requirements', v.requirements.detail], ['Work tracking', v.workTracking.detail], ['Completion', v.completion.detail]]) detail(k, text, { indent: 0 });
    }

    // ---- Sources and limitations -----------------------------------------------------------------------------
    if (report.sourceIndex?.length) {
      heading('Sources');
      for (const s of report.sourceIndex) {
        space(28);
        const type = SOURCE_TYPE_LABELS[s.type] ? `[${SOURCE_TYPE_LABELS[s.type]}] ` : '';
        const linked = isLink(s);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text(`[${s.n}] `, left, doc.y, { continued: true, width });
        doc.font('Helvetica').fillColor(linked ? COLORS.orange : COLORS.ink).text(`${type}${clean(s.label)}${s.document?.chunkId ? clean(` (ref ${s.document.chunkId})`) : ''}`, linked ? { link: s.url, underline: true, width } : { width });
      }
    }
    if (report.limitations?.length) {
      heading('Limitations and data quality');
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted);
      for (const l of report.limitations) { space(24); doc.text(`- ${clean(l)}`, left, doc.y, { width, lineGap: 1 }); }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer text sits inside the bottom margin; without this pdfkit appends an empty page per footer
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Relay - ${clean(report.projectName)} - page ${i + 1} of ${range.count}`, left, doc.page.height - 34, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

/** Renders a persisted report: the engineering layout for v5+ reports, the earlier layout for reports created before it. */
export function renderReportPdf(report) {
  return report.brief ? renderEngineeringPdf(report) : renderLegacyReportPdf(report);
}
