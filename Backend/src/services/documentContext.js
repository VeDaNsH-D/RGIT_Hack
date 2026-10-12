import { Document } from '../models/Document.js';
import { DocumentChunk } from '../models/DocumentChunk.js';

/**
 * Retrieval of uploaded-document evidence for the (single) handoff context builder.
 *
 * Retrieval is STRUCTURED + LEXICAL, not semantic: there is no embedding index. Chunks of the project's
 * 'indexed' documents are scored by IDF-weighted term overlap with the project's own working vocabulary
 * (name, description, open issue / PR / task / note titles, repository component names), with a heading match
 * bonus and a small recency bonus, then selected under per-document and character-budget caps. Documents that match
 * nothing still contribute their opening chunk (up to a few most recent documents) so an uploaded requirements
 * document is never silently dropped.
 *
 * Isolation: every query is scoped to project._id (taken from the authorized request); only chunks whose
 * contentHash equals their Document's current contentHash are eligible, so superseded content cannot resurface.
 */

export const DOC_LIMITS = Object.freeze({ maxDocuments: 100, maxScanChunks: 4000, maxPerDocument: 4, maxChunks: 10, chunkChars: 900, baselineDocuments: 3, maxDigests: 8 });

const STOP = new Set('the and for are but not you all can had her was one our out has have this that with from they will would there their what about which when your said each she how use any may into than then them these some such only over also been being more most other its who why where while should could does did done let per via'.split(' '));

export function tokenize(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)));
}

const cleanText = (t) => String(t || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const condenseWs = (t, max) => cleanText(t).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, max);

export function chunkLabel({ title, heading, pageStart }) {
  return `Document "${title}"${heading ? ` > ${heading}` : ''}${pageStart ? `, p. ${pageStart}` : ''}`;
}

/**
 * @param {Object} project - Authorized project (needs _id).
 * @param {Object} [options]
 * @param {string[]} [options.queryTexts] - Texts whose vocabulary defines relevance.
 * @param {number} [options.budgetChars] - Character budget for all document excerpts.
 * @param {number} [options.scale=1] - Reduces caps when the provider rejects a large request.
 * @param {Object} [options.models] - Test overrides: { documentModel, chunkModel }.
 */
export async function retrieveDocumentContext(project, { queryTexts = [], budgetChars = 24_000, scale = 1, models = {} } = {}) {
  const Doc = models.documentModel ?? Document;
  const Chunks = models.chunkModel ?? DocumentChunk;
  const projectId = project._id;
  const empty = { sources: [], evidence: [], limitations: [], included: [], notIndexed: [], chunkCount: 0 };

  const rows = await Doc.find({ projectId }).select('+digest title filename status statusError processingStartedAt contentHash createdAt chunkCount').sort({ createdAt: -1 }).limit(DOC_LIMITS.maxDocuments).lean();
  if (!rows.length) return empty;

  const limitations = [];
  const indexed = rows.filter((d) => d.status === 'indexed');
  const notIndexed = rows.filter((d) => d.status !== 'indexed').map((d) => ({ documentId: String(d._id), title: d.title, status: d.status === 'processing' && d.processingStartedAt && Date.now() - new Date(d.processingStartedAt) > 5 * 60_000 ? 'failed' : d.status }));
  if (notIndexed.length) limitations.push(`${notIndexed.length} uploaded document(s) are not indexed (${[...new Set(notIndexed.map((d) => d.status))].join('/')}) and are NOT included in this handoff: ${notIndexed.slice(0, 5).map((d) => d.title).join('; ')}. The project knowledge base is not fully current until they are retried.`);
  if (!indexed.length) return { ...empty, limitations, notIndexed };

  const byId = new Map(indexed.map((d) => [String(d._id), d]));
  const scanLimit = Math.max(200, Math.floor(DOC_LIMITS.maxScanChunks * scale));
  const all = await Chunks.find({ projectId, documentId: { $in: indexed.map((d) => d._id) } }).sort({ documentId: 1, chunkIndex: 1 }).limit(scanLimit + 1).lean();
  if (all.length > scanLimit) limitations.push('Some uploaded documents are very large; only the first part of their indexed text was searched for this handoff.');
  const chunks = all.slice(0, scanLimit).filter((c) => byId.get(String(c.documentId))?.contentHash === c.contentHash);

  const query = new Set();
  for (const text of queryTexts) for (const t of tokenize(text)) query.add(t);
  const tokenSets = chunks.map((c) => new Set([...tokenize(c.text), ...tokenize(c.heading), ...tokenize(c.title)]));
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  const n = Math.max(1, chunks.length);
  const recencyRank = new Map(indexed.map((d, i) => [String(d._id), 1 - i / Math.max(1, indexed.length)]));

  const scored = chunks.map((c, i) => {
    let score = 0;
    const headingTokens = tokenize(c.heading);
    for (const t of query) {
      if (!tokenSets[i].has(t)) continue;
      const idf = Math.log(1 + n / (df.get(t) || 1));
      score += idf * (headingTokens.has(t) ? 1.6 : 1);
    }
    return { chunk: c, score: score * (1 + 0.1 * (recencyRank.get(String(c.documentId)) ?? 0)) };
  });

  const maxChunks = Math.max(2, Math.floor(DOC_LIMITS.maxChunks * scale));
  const perDoc = Math.max(1, Math.floor(DOC_LIMITS.maxPerDocument * scale));
  const chunkChars = Math.max(300, Math.min(DOC_LIMITS.chunkChars, Math.floor(budgetChars / 4)));
  // ~25% of the budget is reserved for per-document overviews, the rest for relevance-ranked excerpts.
  let budget = Math.floor(budgetChars * 0.75);
  let digestBudget = budgetChars - budget;
  const picked = [];
  const countByDoc = new Map();
  const take = (c, score, relevance) => {
    const key = String(c.documentId);
    const text = condenseWs(c.text, chunkChars);
    const cost = text.length + (c.heading || '').length + 120;
    if (picked.length >= maxChunks || cost > budget || (countByDoc.get(key) || 0) >= perDoc) return false;
    budget -= cost;
    countByDoc.set(key, (countByDoc.get(key) || 0) + 1);
    picked.push({ chunk: c, text, score, relevance });
    return true;
  };
  for (const { chunk, score } of scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex)) take(chunk, score, 'matched');
  // Documents that matched nothing still contribute their opening chunk (most recent few documents only).
  let baseline = 0;
  for (const d of indexed) {
    if (baseline >= DOC_LIMITS.baselineDocuments) break;
    if (countByDoc.has(String(d._id))) continue;
    const first = chunks.find((c) => String(c.documentId) === String(d._id));
    if (first && take(first, 0, 'baseline')) baseline += 1;
  }
  picked.sort((a, b) => String(a.chunk.documentId).localeCompare(String(b.chunk.documentId)) || a.chunk.chunkIndex - b.chunk.chunkIndex);

  const sources = [];
  const evidence = [];
  const includedMap = new Map();
  const noteIncluded = (doc) => {
    const entry = includedMap.get(String(doc._id)) || { documentId: String(doc._id), title: doc.title, filename: doc.filename, uploadedAt: doc.createdAt, chunks: 0 };
    includedMap.set(String(doc._id), entry);
    return entry;
  };

  // Whole-corpus awareness for pennies: a short outline (headings + opening) of the best-matching documents,
  // computed at index time. The model sees what every relevant document covers without reading all of it.
  const bestScore = new Map();
  for (const { chunk, score } of scored) bestScore.set(String(chunk.documentId), Math.max(bestScore.get(String(chunk.documentId)) || 0, score));
  const digestDocs = indexed.filter((d) => d.digest).sort((a, b) => (bestScore.get(String(b._id)) || 0) - (bestScore.get(String(a._id)) || 0)).slice(0, Math.max(1, Math.floor(DOC_LIMITS.maxDigests * scale)));
  for (const doc of digestDocs) {
    if (doc.digest.length + 120 > digestBudget) break;
    const id = `docsum:${doc._id}`;
    const label = `Document "${doc.title}" (overview)`;
    digestBudget -= doc.digest.length + 120;
    sources.push({ _id: id, provider: 'document', type: 'document_overview', title: label, content: cleanText(doc.digest), url: '', externalId: id, createdAt: doc.createdAt, metadata: { documentId: String(doc._id), filename: doc.filename, uploadedAt: doc.createdAt } });
    evidence.push([id, { id, label, url: null, type: 'document', provider: 'document', document: { projectId: String(projectId), documentId: String(doc._id), title: doc.title, filename: doc.filename, heading: null, pageStart: null, pageEnd: null, chunkId: id, uploadedAt: doc.createdAt } }]);
    noteIncluded(doc);
  }
  for (const { chunk: c, text, score, relevance } of picked) {
    const doc = byId.get(String(c.documentId));
    const id = `doc:${c.documentId}:${c.chunkIndex}`;
    const label = chunkLabel({ title: doc.title, heading: c.heading, pageStart: c.pageStart });
    const meta = { documentId: String(c.documentId), filename: doc.filename, heading: c.heading || undefined, pageStart: c.pageStart, pageEnd: c.pageEnd, chunkId: c.chunkId, uploadedAt: doc.createdAt, contentHash: c.contentHash, relevance, score: Math.round(score * 100) / 100 };
    sources.push({ _id: id, provider: 'document', type: 'document_excerpt', title: label, content: text, url: '', externalId: c.chunkId, createdAt: doc.createdAt, metadata: meta });
    evidence.push([id, { id, label, url: null, type: 'document', provider: 'document', document: { projectId: String(projectId), documentId: String(c.documentId), title: doc.title, filename: doc.filename, heading: c.heading || null, pageStart: c.pageStart ?? null, pageEnd: c.pageEnd ?? null, chunkId: c.chunkId, uploadedAt: doc.createdAt } }]);
    noteIncluded(doc).chunks += 1;
  }
  const noText = indexed.filter((d) => !d.chunkCount).map((d) => d.title);
  if (noText.length) limitations.push(`${noText.length} uploaded document(s) contain no extractable text (scanned images are not OCR'd): ${noText.slice(0, 5).join('; ')}.`);
  if (picked.length && picked.every((p) => p.relevance === 'baseline')) limitations.push('No uploaded document matched the current project activity; only their opening sections were included.');
  return { sources, evidence, limitations, included: [...includedMap.values()], notIndexed, chunkCount: picked.length };
}

/**
 * Cross-source link hints. For each document excerpt, finds the repository files / components / issues / pull requests
 * in the same pack that share distinctive vocabulary with it and records them as `metadata.related` (ids). They are
 * unverified lexical matches: the prompt tells the model to use a hint only when the cited content supports the link.
 * This precomputes the requirement -> code -> issue connections so the model need not read everything to find them.
 */
export function addDocumentLinkHints(sources, { perExcerpt = 2, minShared = 2 } = {}) {
  const targets = sources
    .filter((s) => s.provider !== 'document' && ['file', 'issue', 'pull_request', 'repository_components', 'repository_routes'].includes(s.type || s.record_type))
    .map((s) => ({ s, tokens: new Set([...tokenize(s.title), ...((s.type || s.record_type) === 'repository_components' || (s.type || s.record_type) === 'repository_routes' ? tokenize(s.content) : tokenize((s.content || '').slice(0, 300)))]) }));
  if (!targets.length) return sources;
  const df = new Map();
  for (const { tokens } of targets) for (const t of tokens) df.set(t, (df.get(t) || 0) + 1);
  for (const doc of sources.filter((s) => s.provider === 'document' && (s.type || s.record_type) === 'document_excerpt')) {
    const own = new Set([...tokenize(doc.content), ...tokenize(doc.metadata?.heading)]);
    const ranked = targets.map(({ s, tokens }) => {
      let shared = 0; let score = 0;
      for (const t of tokens) if (own.has(t) && (df.get(t) || 0) <= Math.max(2, targets.length / 3)) { shared += 1; score += Math.log(1 + targets.length / df.get(t)); }
      return { id: s._id || s.id, shared, score };
    }).filter((r) => r.shared >= minShared).sort((a, b) => b.score - a.score).slice(0, perExcerpt);
    if (ranked.length) doc.metadata = { ...doc.metadata, related: ranked.map((r) => r.id) };
  }
  return sources;
}
