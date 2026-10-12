import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isJiraOAuthConfigured,
  createJiraAuthUrl,
  verifyJiraState,
  getJiraRedirectUri,
  fetchAccessibleJiraResources,
  JiraOAuthError,
} from '../../src/services/jiraOAuthService.js';
import { JiraClient, JiraConnector } from '../../src/integrations/jira/index.js';

describe('Jira OAuth 2.0 (3LO) Service Suite', () => {
  it('1. should verify Jira OAuth credentials are configured from .env', () => {
    assert.equal(isJiraOAuthConfigured(), true);
  });

  it('2. should generate a valid Atlassian authorization URL with state', () => {
    const mockUserId = '507f1f77bcf86cd799439011';
    const authUrl = createJiraAuthUrl(mockUserId);

    assert.ok(authUrl.startsWith('https://auth.atlassian.com/authorize?'));
    const url = new URL(authUrl);

    assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
    assert.ok(url.searchParams.get('client_id'));
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.ok(url.searchParams.get('scope').includes('read:jira-work'));
    assert.ok(url.searchParams.get('state'));

    // Verify the state token decodes to the user ID
    const extractedUserId = verifyJiraState(url.searchParams.get('state'));
    assert.equal(extractedUserId, mockUserId);
  });

  it('3. should reject invalid or tampered state tokens', () => {
    assert.throws(
      () => verifyJiraState('invalid.token.here'),
      (err) => err instanceof JiraOAuthError && err.details.code === 'STATE_EXPIRED_OR_INVALID'
    );
  });

  it('4. should parse accessible Jira resources correctly', async () => {
    const mockResources = [
      {
        id: 'cloud-site-uuid-1234',
        name: 'My Team Jira',
        url: 'https://myteam.atlassian.net',
        scopes: ['read:jira-work', 'offline_access'],
        avatarUrl: 'https://avatar.atlassian.com/1.png',
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url === 'https://api.atlassian.com/oauth/token/accessible-resources') {
        assert.equal(options.headers.Authorization, 'Bearer test-access-token');
        return {
          ok: true,
          status: 200,
          json: async () => mockResources,
        };
      }
      return originalFetch(url, options);
    };

    try {
      const resources = await fetchAccessibleJiraResources('test-access-token');
      assert.equal(resources.length, 1);
      assert.equal(resources[0].id, 'cloud-site-uuid-1234');
      assert.equal(resources[0].url, 'https://myteam.atlassian.net');
      assert.equal(resources[0].name, 'My Team Jira');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('5. should instantiate JiraClient and JiraConnector with cloudId and accessToken', async () => {
    const cloudId = 'cloud-site-uuid-1234';
    const accessToken = 'oauth-bearer-token-xyz';

    let capturedUrl = '';
    let capturedAuthHeader = '';

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedAuthHeader = options.headers.Authorization;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          accountId: 'jira-user-123',
          displayName: 'Vedansh Dubey',
          emailAddress: 'vedanshdubeyd6@gmail.com',
        }),
      };
    };

    const connector = new JiraConnector({
      cloudId,
      accessToken,
      fetchFn: mockFetch,
    });

    const verifyResult = await connector.verifyConnection();
    assert.equal(verifyResult.ok, true);
    assert.equal(verifyResult.details.displayName, 'Vedansh Dubey');
    assert.equal(capturedUrl, `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`);
    assert.equal(capturedAuthHeader, `Bearer ${accessToken}`);
  });
});
