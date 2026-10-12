import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument, detectHeading } from './documentChunker.js';

describe('detectHeading', () => {
  it('recognizes markdown, numbered and ALL-CAPS headings; ignores sentences', () => {
    assert.equal(detectHeading('## Architecture Overview'), 'Architecture Overview');
    assert.equal(detectHeading('2.1 Data Model'), '2.1 Data Model');
    assert.equal(detectHeading('NON-FUNCTIONAL REQUIREMENTS'), 'NON-FUNCTIONAL REQUIREMENTS');
    assert.equal(detectHeading('The system must retry failed deliveries.'), null);
    assert.equal(detectHeading(''), null);
  });
});

describe('chunkDocument', () => {
  const doc = [{ page: 1, text: '1. Goals\n\nShip the exporter by Q3.\n\n2. Constraints\n\nMust run on Vercel.' }, { page: 2, text: 'More detail on constraints that continue here.' }];

  it('keeps headings and page numbers, never spans pages', () => {
    const { chunks } = chunkDocument(doc);
    assert.equal(chunks[0].heading, '1. Goals');
    assert.equal(chunks[0].pageStart, 1);
    assert.match(chunks[1].text, /Vercel/);
    assert.equal(chunks[1].heading, '2. Constraints');
    const last = chunks.at(-1);
    assert.equal(last.pageStart, 2);
    assert.equal(last.heading, '2. Constraints'); // carried over from the previous page
  });

  it('is deterministic: identical input yields identical indexes, text and hashes', () => {
    assert.deepEqual(chunkDocument(doc), chunkDocument(JSON.parse(JSON.stringify(doc))));
  });

  it('bounds chunk size and the number of chunks', () => {
    const long = [{ text: 'word '.repeat(5000) }];
    const { chunks } = chunkDocument(long, { maxChars: 500 });
    assert.ok(chunks.every((c) => c.text.length <= 500));
    assert.equal(chunks.every((c) => c.pageStart === undefined), true); // no page is invented for page-less formats
    const capped = chunkDocument(long, { maxChars: 100, maxChunks: 5 });
    assert.equal(capped.chunks.length, 5);
    assert.equal(capped.truncated, true);
  });

  it('returns no chunks for empty input', () => {
    assert.deepEqual(chunkDocument([]).chunks, []);
  });
});
