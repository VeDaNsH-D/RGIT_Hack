/**
 * @file githubSyncService.test.js
 * @description Tests for the persistence-enabled GitHub path (fetch -> normalize -> persist)
 * and backward compatibility of the fetch-only path. GitHub and the database are mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { GitHubClient } from './githubClient.js';
import { GITHUB_ERROR_CODES } from './githubErrors.js';
import { fetchGitHubRepositoryData } from './githubIngestionService.js';
import { syncGitHubRepository, syncGitHubSourceConnection } from './githubSyncService.js';
import { InMemorySourceRecordModel } from '../../persistence/inMemorySourceRecordModel.js';

const PROJECT_ID = '665f1c2e8b3a4d0012345678';
const TOKEN = 'ghs_SyncTestInstallationToken000000000000000';
const NOW = new Date('2026-10-12T10:00:00Z');

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

function mockGitHub(overrides = {}) {
  const calls = [];
  const routes = {
    '/repos/acme/relay': () => json({
      id: 42, node_id: 'R_1', name: 'relay', full_name: 'acme/relay', owner: { login: 'acme', id: 1 },
      html_url: 'https://github.com/acme/relay', default_branch: 'main', private: true,
    }),
    '/repos/acme/relay/issues': () => json([
      { id: 1, node_id: 'I_1', number: 1, title: 'Bug', body: 'b', state: 'open', html_url: 'https://github.com/acme/relay/issues/1' },
      { id: 2, node_id: 'I_2', number: 2, title: 'PR', pull_request: {} },
    ]),
    '/repos/acme/relay/pulls': () => json([
      { id: 20, node_id: 'PR_2', number: 2, title: 'PR', body: '', state: 'open', html_url: 'https://github.com/acme/relay/pull/2' },
    ]),
    '/repos/acme/relay/commits': () => json([
      { sha: 'c'.repeat(40), commit: { message: 'Init' }, html_url: `https://github.com/acme/relay/commit/${'c'.repeat(40)}` },
    ]),
    ...overrides,
  };
  const fetchFn = async (url, opts) => {
    const { pathname } = new URL(url);
    calls.push({ pathname, auth: opts.headers.Authorization });
    return (routes[pathname] || (() => json({ message: 'Not Found' }, 404)))();
  };
  return { client: new GitHubClient({ token: TOKEN, fetchFn }), calls };
}

const run = (client, model, extra = {}) => syncGitHubRepository({
  owner: 'acme', repo: 'relay', projectId: PROJECT_ID, client, model, now: () => NOW, ...extra,
});

describe('syncGitHubRepository', () => {
  it('fetches, normalizes and persists repository, issues, PRs and commits', async () => {
    const { client } = mockGitHub();
    const model = new InMemorySourceRecordModel();
    const { result, repository } = await run(client, model);

    assert.equal(result.status, 'succeeded', JSON.stringify(result.errors));
    assert.equal(result.persisted, true);
    assert.equal(result.createdCount, 4);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.persistence.receivedCount, 4);
    assert.equal(result.normalizedCount, 4);
    assert.equal(repository.fullName, 'acme/relay');
    assert.deepEqual(model.all().map((d) => d.type).sort(), ['commit', 'issue', 'pull_request', 'repository']);
    assert.ok(model.all().every((d) => d.projectId.toHexString() === PROJECT_ID));
  });

  it('re-syncing updates the same documents', async () => {
    const model = new InMemorySourceRecordModel();
    await run(mockGitHub().client, model);
    const ids = model.all().map((d) => String(d._id)).sort();
    const { result } = await run(mockGitHub().client, model);

    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 4);
    assert.deepEqual(model.all().map((d) => String(d._id)).sort(), ids);
  });

  it('persists successful categories when another category fails', async () => {
    const { client } = mockGitHub({
      '/repos/acme/relay/pulls': () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    });
    const model = new InMemorySourceRecordModel();
    const { result } = await run(client, model);

    assert.equal(result.status, 'partial');
    assert.equal(result.createdCount, 3);
    assert.equal(result.errors[0].code, GITHUB_ERROR_CODES.RATE_LIMITED);
    assert.equal(model.docs.size, 3);
  });

  it('reports persistence write failures in the same result', async () => {
    const model = new InMemorySourceRecordModel();
    model.failOn('I_1');
    const { result } = await run(mockGitHub().client, model);

    assert.equal(result.status, 'partial');
    assert.equal(result.createdCount, 3);
    assert.equal(result.persistence.failedCount, 1);
    const err = result.errors.find((e) => e.resource === 'persistence');
    assert.equal(err.externalId, 'I_1');
  });

  it('does not claim persistence when the repository cannot be fetched', async () => {
    const { client } = mockGitHub({ '/repos/acme/relay': () => json({ message: 'Bad credentials' }, 401) });
    const model = new InMemorySourceRecordModel();
    const { result } = await run(client, model);

    assert.equal(result.status, 'failed');
    assert.equal(result.persisted, false);
    assert.equal(result.createdCount, 0);
    assert.equal(model.bulkWriteCalls.length, 0);
  });

  it('requires a Relay ObjectId projectId and rejects it before any GitHub request', async () => {
    const { client, calls } = mockGitHub();
    for (const projectId of [undefined, 'default-project', 'acme/relay', '42']) {
      await assert.rejects(() => run(client, new InMemorySourceRecordModel(), { projectId }), { code: GITHUB_ERROR_CODES.INVALID_INPUT });
    }
    assert.equal(calls.length, 0);
  });

  it('never stores the installation token', async () => {
    const model = new InMemorySourceRecordModel();
    const { result } = await run(mockGitHub().client, model);
    assert.ok(!JSON.stringify(model.all()).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});

describe('fetch-only path remains backward compatible', () => {
  it('fetchGitHubRepositoryData does not persist or claim persistence', async () => {
    const { client } = mockGitHub();
    const { records, result } = await fetchGitHubRepositoryData({ owner: 'acme', repo: 'relay', projectId: 'any-string-project', client });
    assert.equal(records.length, 4);
    assert.equal(result.persisted, false);
    assert.equal(result.createdCount, null);
    assert.equal(result.updatedCount, null);
    assert.equal(result.persistence, undefined);
  });
});

describe('syncGitHubSourceConnection', () => {
  const connection = (overrides = {}) => ({
    projectId: new mongoose.Types.ObjectId(PROJECT_ID),
    provider: 'github',
    config: { installationId: 170530734, owner: 'acme', repo: 'relay' },
    ...overrides,
  });

  it('takes the projectId from the connection and authenticates via the installation', async () => {
    const { client, calls } = mockGitHub();
    let installationIdSeen;
    const authService = { createInstallationClient: async (id) => { installationIdSeen = id; return { client }; } };
    const model = new InMemorySourceRecordModel();

    const { result } = await syncGitHubSourceConnection({ connection: connection(), authService, model, now: () => NOW });

    assert.equal(installationIdSeen, 170530734);
    assert.equal(result.projectId, PROJECT_ID);
    assert.equal(result.createdCount, 4);
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  });

  it('rejects non-GitHub connections and invalid config before exchanging a token', async () => {
    let exchanged = false;
    const authService = { createInstallationClient: async () => { exchanged = true; } };
    const bad = [
      connection({ provider: 'notion' }),
      connection({ projectId: null }),
      connection({ config: { installationId: 'abc', owner: 'acme', repo: 'relay' } }),
      connection({ config: { installationId: 1, owner: '../x', repo: 'relay' } }),
      connection({ config: {} }),
    ];
    for (const c of bad) {
      await assert.rejects(() => syncGitHubSourceConnection({ connection: c, authService, model: new InMemorySourceRecordModel() }));
    }
    assert.equal(exchanged, false);
  });
});
