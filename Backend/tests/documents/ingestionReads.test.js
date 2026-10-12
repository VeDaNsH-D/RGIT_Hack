/**
 * Read APIs: source records, document list/detail, ingestion status.
 *
 * Real: JWT auth, attachProject()/requireRole(), the router, validation.
 * Mocked: Project/ProjectMembership lookups and the three data models
 * (in-memory fakes with chainable find). No database or network access.
 */

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import mongoose from 'mongoose';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:1/relay-test-unused';
process.env.JWT_SECRET ??= 'test-jwt-secret-that-is-at-least-32-characters';
process.env.CRON_SECRET ??= 'test-cron-secret';

const { createIngestionRouter, MAX_PAGE_SIZE } = await import('../../src/routes/ingestion.js');
const { signAuthToken } = await import('../../src/middleware/auth.js');
const { Project } = await import('../../src/models/Project.js');
const { ProjectMembership } = await import('../../src/models/ProjectMembership.js');

const oid = (s) => new mongoose.Types.ObjectId(s);
const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const OTHER_PROJECT_ID = '665f1c2e8b3a4d0087654321';
const MEMBER = '665f1c2e8b3a4d00aaaaaaaa';
const VIEWER = '665f1c2e8b3a4d00bbbbbbbb';
const OUTSIDER = '665f1c2e8b3a4d00cccccccc';
const ROLES = { [MEMBER]: 'member', [VIEWER]: 'viewer' };
const tokenFor = (u) => signAuthToken({ _id: oid(u) });

const hex = (n) => n.toString(16).padStart(24, '0');

/** Minimal chainable fake of a Mongoose model over an array. */
class FakeModel {
  constructor(rows = []) { this.rows = rows; this.error = null; this.filters = []; }
  #match(filter) {
    this.filters.push(filter);
    return this.rows.filter((row) => Object.entries(filter).every(([k, v]) => {
      const actual = row[k];
      if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.map(String).includes(String(actual));
      return String(actual) === String(v);
    }));
  }
  #check() { if (this.error) throw this.error; }
  find(filter) {
    const self = this;
    let out = null;
    const q = {
      select() { return q; },
      sort() { q._sorted = true; return q; },
      skip(n) { q._skip = n; return q; },
      limit(n) { q._limit = n; return q; },
      async lean() {
        self.#check();
        out = self.#match(filter);
        if (q._sorted) out = [...out].sort((a, b) => (b.createdAt - a.createdAt) || (String(b._id) < String(a._id) ? -1 : 1));
        return out.slice(q._skip ?? 0, (q._skip ?? 0) + (q._limit ?? out.length)).map(structuredCloneSafe);
      },
    };
    return q;
  }
  findOne(filter) { const q = { select: () => q, lean: async () => { this.#check(); return this.#match(filter)[0] ?? null; } }; return q; }
  async countDocuments(filter) { this.#check(); return this.#match(filter).length; }
  async aggregate(pipeline) {
    this.#check();
    const match = pipeline[0].$match;
    const rows = this.#match(match);
    const g = new Map();
    for (const r of rows) g.set(r.provider, (g.get(r.provider) || 0) + 1);
    return [...g].map(([_id, count]) => ({ _id, count }));
  }
}
const structuredCloneSafe = (r) => ({ ...r });

const sr = (n, over = {}) => ({
  _id: oid(hex(n)),
  projectId: oid(PROJECT_ID),
  provider: 'github',
  externalId: `ext-${n}`,
  type: 'issue',
  title: `Record ${n}`,
  url: `https://example.com/${n}`,
  content: `SECRET-BODY-${n}`,
  metadata: {
    author: 'alice', sourceCreatedAt: '2025-01-01T00:00:00.000Z', fetchedAt: '2025-01-02T00:00:00.000Z',
    contentType: 'text/markdown', version: 1, isActive: true, isDeleted: false,
    providerMetadata: { repo: 'a/b', accessToken: 'ghs_LEAK', nested: { password: 'p', ok: 1 } },
  },
  createdAt: new Date(2025, 0, n), updatedAt: new Date(2025, 0, n),
  ...over,
});

const doc = (n, over = {}) => ({
  _id: oid(hex(1000 + n)),
  projectId: oid(PROJECT_ID),
  title: `Doc ${n}`, filename: `d${n}.txt`, mimeType: 'text/plain', size: 10,
  url: '', storageRef: { provider: 'none', key: '/var/secret/path/key', url: '' },
  extractedText: 'FULL-EXTRACTED-TEXT',
  uploadedBy: oid(MEMBER),
  createdAt: new Date(2025, 0, n), updatedAt: new Date(2025, 0, n),
  ...over,
});

describe('ingestion read APIs', () => {
  let server, baseUrl, records, documents, connections;

  before(async () => {
    mock.method(Project, 'findById', async (id) => (String(id) === PROJECT_ID ? { _id: oid(PROJECT_ID) } : null));
    mock.method(ProjectMembership, 'findOne', async ({ projectId, userId }) => {
      const role = String(projectId) === PROJECT_ID ? ROLES[String(userId)] : undefined;
      return role ? { projectId, userId, role } : null;
    });
    records = new FakeModel(); documents = new FakeModel(); connections = new FakeModel();
    const app = express();
    app.use('/api/projects', createIngestionRouter({ sourceRecordModel: records, documentModel: documents, sourceConnectionModel: connections }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      const status = err.status || err.statusCode || 500;
      res.status(status).json({ error: err.code || 'internal_error', message: status < 500 ? err.message : 'Internal server error' });
    });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/projects`;
  });
  after(async () => { mock.restoreAll(); await new Promise((r) => server.close(r)); });

  beforeEach(() => { records.rows = []; documents.rows = []; connections.rows = []; records.error = documents.error = connections.error = null; records.filters = []; });

  async function get(path, { user = MEMBER, headers = {} } = {}) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { ...(user ? { Authorization: `Bearer ${tokenFor(user)}` } : {}), ...headers } });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  }

  describe('access control (all endpoints)', () => {
    const paths = [
      `/${PROJECT_ID}/source-records`, `/${PROJECT_ID}/source-records/${hex(1)}`,
      `/${PROJECT_ID}/documents`, `/${PROJECT_ID}/documents/${hex(1)}`, `/${PROJECT_ID}/ingestion/status`,
    ];
    for (const p of paths) {
      it(`401 without a token: ${p.replace(PROJECT_ID, ':id')}`, async () => {
        const r = await get(p, { user: null });
        assert.equal(r.status, 401);
      });
      it(`404 for non-members (and unknown projects): ${p.replace(PROJECT_ID, ':id')}`, async () => {
        assert.equal((await get(p, { user: OUTSIDER })).status, 404);
        assert.equal((await get(p.replace(PROJECT_ID, OTHER_PROJECT_ID))).status, 404);
      });
      it(`200/404-by-resource for a viewer (not 403): ${p.replace(PROJECT_ID, ':id')}`, async () => {
        const r = await get(p, { user: VIEWER });
        assert.notEqual(r.status, 403);
        assert.notEqual(r.status, 401);
      });
      it(`404 for an invalid project id (attachProject convention): ${p.replace(PROJECT_ID, ':id')}`, async () => {
        const r = await get(p.replace(PROJECT_ID, 'not-an-id'));
        assert.equal(r.status, 404);
      });
    }
  });

  describe('GET /:id/source-records', () => {
    it('empty dataset', async () => {
      const r = await get(`/${PROJECT_ID}/source-records`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false } });
    });

    it('lists newest first with default pagination, scoped to the project, without content', async () => {
      records.rows = [sr(1), sr(3), sr(2), sr(4, { projectId: oid(OTHER_PROJECT_ID) })];
      const r = await get(`/${PROJECT_ID}/source-records`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((i) => i.title), ['Record 3', 'Record 2', 'Record 1']);
      assert.equal(r.body.pagination.total, 3);
      assert.ok(!r.text.includes('SECRET-BODY'));
      assert.ok(!('content' in r.body.items[0]) && !('metadata' in r.body.items[0]));
    });

    it('excludes non-ingestion (manual) records', async () => {
      records.rows = [sr(1), sr(2, { provider: 'manual', type: 'note' })];
      const r = await get(`/${PROJECT_ID}/source-records`);
      assert.equal(r.body.items.length, 1);
    });

    it('paginates with page and limit', async () => {
      records.rows = [1, 2, 3, 4, 5].map((n) => sr(n));
      const r = await get(`/${PROJECT_ID}/source-records?limit=2&page=2`);
      assert.deepEqual(r.body.items.map((i) => i.title), ['Record 3', 'Record 2']);
      assert.deepEqual(r.body.pagination, { page: 2, limit: 2, total: 5, totalPages: 3, hasNextPage: true });
    });

    it('filters by provider and type', async () => {
      records.rows = [sr(1), sr(2, { provider: 'jira', type: 'issue' }), sr(3, { provider: 'github', type: 'commit' })];
      const a = await get(`/${PROJECT_ID}/source-records?provider=github`);
      assert.deepEqual(a.body.items.map((i) => i.title).sort(), ['Record 1', 'Record 3']);
      const b = await get(`/${PROJECT_ID}/source-records?provider=github&type=commit`);
      assert.deepEqual(b.body.items.map((i) => i.title), ['Record 3']);
    });

    for (const q of [
      'provider=bitbucket', 'provider=manual', 'type=bogus', 'provider=github&provider=jira',
      'page=0', 'page=-1', 'page=abc', 'page=1.5', 'limit=0', `limit=${MAX_PAGE_SIZE + 1}`, 'limit=1e3', 'page=10001',
    ]) {
      it(`400 for invalid query: ${q}`, async () => {
        const r = await get(`/${PROJECT_ID}/source-records?${q}`);
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'validation_error');
      });
    }

    it('accepts the maximum page size', async () => {
      assert.equal((await get(`/${PROJECT_ID}/source-records?limit=${MAX_PAGE_SIZE}`)).status, 200);
    });

    it('ignores bracket-operator query keys (Express simple parser)', async () => {
      records.rows = [sr(1, { provider: 'jira' })];
      const r = await get(`/${PROJECT_ID}/source-records?provider[$ne]=jira`);
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 1);
      assert.deepEqual(Object.keys(records.filters[0]).sort(), ['projectId', 'provider']);
    });

    it('never passes client-supplied operators to the model', async () => {
      await get(`/${PROJECT_ID}/source-records?type=issue`);
      for (const f of records.filters) assert.deepEqual(Object.keys(f).sort(), ['projectId', 'provider', 'type']);
    });

    it('500 with a generic body on database errors', async () => {
      records.error = new Error('mongo exploded: mongodb://user:pw@host');
      const r = await get(`/${PROJECT_ID}/source-records`);
      assert.equal(r.status, 500);
      assert.equal(r.body.message, 'Internal server error');
      assert.ok(!r.text.includes('mongodb://'));
    });
  });

  describe('GET /:id/source-records/:recordId', () => {
    it('returns one record with content and redacted metadata', async () => {
      records.rows = [sr(1)];
      const r = await get(`/${PROJECT_ID}/source-records/${hex(1)}`, { user: VIEWER });
      assert.equal(r.status, 200);
      assert.equal(r.body.item.content, 'SECRET-BODY-1');
      assert.deepEqual(r.body.item.metadata, { repo: 'a/b', nested: { ok: 1 } });
      assert.ok(!r.text.includes('ghs_LEAK'));
    });
    it('404 when missing', async () => {
      assert.equal((await get(`/${PROJECT_ID}/source-records/${hex(9)}`)).status, 404);
    });
    it('404 for a record in another project', async () => {
      records.rows = [sr(1, { projectId: oid(OTHER_PROJECT_ID) })];
      assert.equal((await get(`/${PROJECT_ID}/source-records/${hex(1)}`)).status, 404);
    });
    it('404 for manual records', async () => {
      records.rows = [sr(1, { provider: 'manual' })];
      assert.equal((await get(`/${PROJECT_ID}/source-records/${hex(1)}`)).status, 404);
    });
    it('400 for an invalid record id', async () => {
      assert.equal((await get(`/${PROJECT_ID}/source-records/xyz`)).status, 400);
    });
    it('500 on database error', async () => {
      records.error = new Error('boom');
      assert.equal((await get(`/${PROJECT_ID}/source-records/${hex(1)}`)).status, 500);
    });
  });

  describe('output redaction (defence in depth for rows written by other code paths)', () => {
    // Built at runtime so the literals never appear in failure output as real-looking secrets.
    const GH = ['ghs', '_', 'A'.repeat(36)].join('');
    const SLACK = ['xoxb', '-', '1234567890', '-', 'abcdefghijkl'].join('');
    const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3', 'abc123def456'].join('.');

    const detail = async (providerMetadata, over = {}) => {
      records.rows = [sr(1, { metadata: { providerMetadata }, ...over })];
      const r = await get(`/${PROJECT_ID}/source-records/${hex(1)}`);
      assert.equal(r.status, 200);
      return r;
    };
    const assertNoLeak = (r, needles) => {
      for (const n of needles) assert.ok(!r.text.includes(n), 'response leaked a secret-shaped value');
    };

    it('redacts token-shaped values under innocent key names, at any depth', async () => {
      const r = await detail({ note: `see ${GH}`, nested: { deep: { label: SLACK } }, list: [{ ref: JWT }, 'plain'] });
      assertNoLeak(r, [GH, SLACK, JWT]);
      assert.equal(r.body.item.metadata.list[1], 'plain');
      assert.ok(r.body.item.metadata.note.includes('[REDACTED]'));
    });

    it('drops credential keys inside arrays of objects', async () => {
      const r = await detail({ items: [{ id: 1, apiKey: 'k1', ok: true }, { id: 2, password: 'p', ok: false }] });
      assert.deepEqual(r.body.item.metadata.items, [{ id: 1, ok: true }, { id: 2, ok: false }]);
    });

    it('strips credentials embedded in URLs (metadata and the record url)', async () => {
      const r = await detail({ remote: 'https://user:s3cretpass@github.com/acme/repo.git', safe: 'https://github.com/acme/repo' },
        { url: 'https://bot:hunter2@example.com/issues/1' });
      assertNoLeak(r, ['s3cretpass', 'hunter2']);
      assert.equal(r.body.item.metadata.safe, 'https://github.com/acme/repo');
      assert.equal(r.body.item.url, 'https://[REDACTED]@example.com/issues/1');
    });

    it('redacts error messages that carry bearer tokens', async () => {
      const r = await detail({ lastError: `401 Unauthorized: Bearer ${'a'.repeat(40)}` });
      assertNoLeak(r, ['a'.repeat(40)]);
    });

    it('hides filesystem/storage paths but keeps ordinary values', async () => {
      const r = await detail({ stored: '/var/folders/xx/relay-documents/abc.pdf', winPath: 'C:\\Users\\bob\\a.txt', storageKey: 'abc.pdf', repo: 'acme/relay', branch: 'main' });
      assertNoLeak(r, ['/var/folders', 'C:\\Users']);
      assert.equal(r.body.item.metadata.repo, 'acme/relay');
      assert.equal(r.body.item.metadata.branch, 'main');
      assert.ok(!('storageKey' in r.body.item.metadata));
    });

    it('keeps useful safe metadata untouched', async () => {
      const meta = { number: 7, labels: ['bug', 'p1'], state: 'open', merged: false, closedAt: null, sha: 'a'.repeat(40) };
      const r = await detail(meta);
      assert.deepEqual(r.body.item.metadata, meta);
    });

    it('document list/detail never return extractedText or raw bytes even if present on the row', async () => {
      documents.rows = [doc(1, { fileBuffer: Buffer.from('RAW-BYTES'), storageRef: { provider: 'none', key: '/tmp/relay/secret.pdf', url: 'file:///tmp/relay/secret.pdf' } })];
      const list = await get(`/${PROJECT_ID}/documents`);
      const one = await get(`/${PROJECT_ID}/documents/${hex(1001)}`);
      for (const r of [list, one]) {
        assertNoLeak(r, ['FULL-EXTRACTED-TEXT', 'RAW-BYTES', '/tmp/relay', 'file://']);
      }
    });
  });

  describe('GET /:id/documents', () => {
    it('empty dataset', async () => {
      const r = await get(`/${PROJECT_ID}/documents`);
      assert.equal(r.status, 200);
      assert.equal(r.body.items.length, 0);
      assert.equal(r.body.pagination.total, 0);
    });

    it('lists project documents with processing status and no sensitive fields', async () => {
      documents.rows = [doc(1), doc(2), doc(3, { projectId: oid(OTHER_PROJECT_ID) })];
      records.rows = [sr(50, {
        provider: 'document', type: 'document', externalId: hex(1001),
        metadata: { extractionStatus: 'extracted', providerMetadata: { contentHash: 'a'.repeat(64), characterCount: 19 } },
      })];
      const r = await get(`/${PROJECT_ID}/documents`, { user: VIEWER });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((d) => d.title), ['Doc 2', 'Doc 1']);
      const d1 = r.body.items[1];
      assert.equal(d1.processing.status, 'indexed');
      assert.equal(d1.processing.extractionStatus, 'extracted');
      assert.equal(d1.processing.characterCount, 19);
      assert.equal(r.body.items[0].processing.status, 'pending_indexing');
      assert.ok(!r.text.includes('FULL-EXTRACTED-TEXT'));
      assert.ok(!r.text.includes('/var/secret'));
      assert.ok(!('extractedText' in d1) && !('storageRef' in d1));
    });

    it('paginates and validates', async () => {
      documents.rows = [1, 2, 3].map((n) => doc(n));
      const r = await get(`/${PROJECT_ID}/documents?limit=2`);
      assert.equal(r.body.items.length, 2);
      assert.equal(r.body.pagination.hasNextPage, true);
      assert.equal((await get(`/${PROJECT_ID}/documents?limit=1000`)).status, 400);
      assert.equal((await get(`/${PROJECT_ID}/documents?page=x`)).status, 400);
    });

    it('500 on database error', async () => {
      documents.error = new Error('boom');
      assert.equal((await get(`/${PROJECT_ID}/documents`)).status, 500);
    });
  });

  describe('GET /:id/documents/:documentId', () => {
    it('returns safe metadata only', async () => {
      documents.rows = [doc(1)];
      const r = await get(`/${PROJECT_ID}/documents/${hex(1001)}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.item.filename, 'd1.txt');
      assert.equal(r.body.item.processing.status, 'pending_indexing');
      assert.ok(!r.text.includes('FULL-EXTRACTED-TEXT'));
      assert.ok(!r.text.includes('/var/secret'));
    });
    it('404 missing / other project', async () => {
      assert.equal((await get(`/${PROJECT_ID}/documents/${hex(1001)}`)).status, 404);
      documents.rows = [doc(1, { projectId: oid(OTHER_PROJECT_ID) })];
      assert.equal((await get(`/${PROJECT_ID}/documents/${hex(1001)}`)).status, 404);
    });
    it('400 invalid id; 500 db error', async () => {
      assert.equal((await get(`/${PROJECT_ID}/documents/nope`)).status, 400);
      documents.error = new Error('boom');
      assert.equal((await get(`/${PROJECT_ID}/documents/${hex(1001)}`)).status, 500);
    });
  });

  describe('GET /:id/ingestion/status', () => {
    it('reports supported providers, none connected, zero counts on an empty project', async () => {
      const r = await get(`/${PROJECT_ID}/ingestion/status`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.providers.map((p) => p.provider).sort(), ['github', 'gmail', 'jira', 'notion', 'outlook', 'slack']);
      assert.ok(r.body.providers.every((p) => p.supported && !p.connected && p.recordCount === 0));
      assert.equal(r.body.documents.available, true);
      assert.equal(r.body.totalRecords, 0);
    });

    it('connected reflects persisted connections only; counts per provider; no config leakage', async () => {
      connections.rows = [
        { projectId: oid(PROJECT_ID), provider: 'github', config: { installationId: 99, token: 'ghs_LEAK' } },
        { projectId: oid(OTHER_PROJECT_ID), provider: 'jira', config: {} },
      ];
      records.rows = [sr(1), sr(2), sr(3, { provider: 'document' }), sr(4, { provider: 'manual' }), sr(5, { projectId: oid(OTHER_PROJECT_ID) })];
      const r = await get(`/${PROJECT_ID}/ingestion/status`, { user: VIEWER });
      const by = Object.fromEntries(r.body.providers.map((p) => [p.provider, p]));
      assert.equal(by.github.connected, true);
      assert.equal(by.github.recordCount, 2);
      assert.equal(by.jira.connected, false);
      assert.equal(r.body.documents.recordCount, 1);
      assert.equal(r.body.totalRecords, 3);
      assert.ok(!r.text.includes('ghs_LEAK') && !r.text.includes('installationId'));
    });

    it('500 on database error', async () => {
      connections.error = new Error('boom');
      assert.equal((await get(`/${PROJECT_ID}/ingestion/status`)).status, 500);
    });
  });
});
