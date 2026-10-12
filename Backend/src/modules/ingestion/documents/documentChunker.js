/**
 * @file documentChunker.js
 * @description Splits extracted document text into bounded, citable chunks.
 *
 * Pure and deterministic: the same segments always yield the same chunks (same indexes, text and hashes), which
 * is what makes re-indexing idempotent. Chunks never span a PDF page boundary, so a chunk has at most one page;
 * section headings are detected heuristically (markdown '#', numbered headings, ALL-CAPS or short title-like
 * lines followed by body text) and a chunk's heading is the last heading seen at or before its start. If no
 * heading is found the chunk has none; nothing is invented.
 */

import crypto from 'node:crypto';

export const DEFAULT_CHUNK_CHARS = 1500;
export const MAX_CHUNKS_PER_DOCUMENT = 2000;
const MAX_HEADING_CHARS = 120;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Heuristic: is this single line a section heading? Returns the cleaned heading or null. */
export function detectHeading(line) {
  const t = line.trim();
  if (!t || t.length > MAX_HEADING_CHARS) return null;
  const md = /^#{1,6}\s+(.+?)\s*#*$/.exec(t);
  if (md) return md[1].trim();
  if (/^(?:\d+(?:\.\d+){0,3}|[A-Z]|[IVX]+)[.)]?\s+[A-Z][^.!?]*$/.test(t) && t.split(/\s+/).length <= 12) return t;
  if (/^[A-Z][A-Z0-9 &/,:\-()]{3,}$/.test(t) && /[A-Z]{3}/.test(t)) return t;
  return null;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > max * 0.5 ? cut + 1 : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

/**
 * @param {Array<{ page?: number, text: string }>} segments
 * @param {{ maxChars?: number, maxChunks?: number }} [options]
 * @returns {{ chunks: Array<{ index: number, text: string, heading: string, pageStart?: number, pageEnd?: number, chunkHash: string }>, truncated: boolean }}
 */
export function chunkDocument(segments, { maxChars = DEFAULT_CHUNK_CHARS, maxChunks = MAX_CHUNKS_PER_DOCUMENT } = {}) {
  const chunks = [];
  let heading = '';
  let truncated = false;

  const push = (text, page, chunkHeading) => {
    if (chunks.length >= maxChunks) { truncated = true; return; }
    const body = text.trim();
    if (!body) return;
    chunks.push({ index: chunks.length, text: body, heading: chunkHeading, pageStart: page, pageEnd: page, chunkHash: sha256(body) });
  };

  for (const seg of segments || []) {
    if (truncated) break;
    let buffer = '';
    let bufferHeading = heading;
    const flush = () => { if (buffer.trim()) push(buffer, seg.page, bufferHeading); buffer = ''; bufferHeading = heading; };
    // Heading lines are recognized on any line (PDF text often has no blank lines); the lines between headings
    // form text blocks that are packed into chunks.
    const addBlock = (block) => {
      for (const piece of splitLong(block.trim(), maxChars)) {
        if (buffer && buffer.length + piece.length + 2 > maxChars) flush();
        buffer = buffer ? `${buffer}\n\n${piece}` : piece;
      }
    };
    for (const paragraph of String(seg.text).split(/\n{2,}/)) {
      let block = [];
      for (const line of paragraph.split('\n')) {
        const found = detectHeading(line);
        if (found) {
          if (block.length) { addBlock(block.join('\n')); block = []; }
          flush();
          heading = found;
          bufferHeading = heading;
        } else {
          block.push(line);
        }
      }
      if (block.length) addBlock(block.join('\n'));
    }
    flush();
  }
  return { chunks, truncated };
}
