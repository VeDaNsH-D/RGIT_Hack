import { config } from '../config.js';

/**
 * Minimal OAuth2 "authorization code" helpers for Google and GitHub, using
 * only global fetch (no OAuth client library). Each provider exposes:
 *  - authorizeUrl(state): URL to redirect the browser to
 *  - exchangeCode(code): -> { providerId, email, emailVerified, name }
 *
 * A provider is only usable when its client id/secret are both set
 * (config.oauth.<provider>.enabled); callers must check that first.
 */

function callbackUrl(provider) {
  return `${config.apiBaseUrl}/api/auth/oauth/${provider}/callback`;
}

export const oauthProviders = {
  google: {
    enabled: () => config.oauth.google.enabled,
    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: config.oauth.google.clientId,
        redirect_uri: callbackUrl('google'),
        response_type: 'code',
        scope: 'openid email profile',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },
    async exchangeCode(code) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.oauth.google.clientId,
          client_secret: config.oauth.google.clientSecret,
          redirect_uri: callbackUrl('google'),
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();

      const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!profileRes.ok) throw new Error(`Google profile fetch failed: ${profileRes.status}`);
      const profile = await profileRes.json();

      return {
        providerId: profile.sub,
        email: profile.email,
        emailVerified: Boolean(profile.email_verified),
        name: profile.name || profile.email,
      };
    },
  },

  github: {
    enabled: () => config.oauth.github.enabled,
    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: config.oauth.github.clientId,
        redirect_uri: callbackUrl('github'),
        scope: 'read:user user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },
    async exchangeCode(code) {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: config.oauth.github.clientId,
          client_secret: config.oauth.github.clientSecret,
          redirect_uri: callbackUrl('github'),
        }),
      });
      if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
      const { access_token } = await tokenRes.json();
      if (!access_token) throw new Error('GitHub token exchange did not return an access token');

      const headers = { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github+json' };
      const [userRes, emailsRes] = await Promise.all([
        fetch('https://api.github.com/user', { headers }),
        fetch('https://api.github.com/user/emails', { headers }),
      ]);
      if (!userRes.ok) throw new Error(`GitHub user fetch failed: ${userRes.status}`);
      if (!emailsRes.ok) throw new Error(`GitHub emails fetch failed: ${emailsRes.status}`);

      const user = await userRes.json();
      const emails = await emailsRes.json();
      const primary = emails.find((e) => e.primary) || emails[0];

      return {
        providerId: String(user.id),
        email: primary?.email || null,
        emailVerified: Boolean(primary?.verified),
        name: user.name || user.login,
      };
    },
  },
};
