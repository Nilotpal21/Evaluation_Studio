/**
 * Bridge from auth-profile validate routes to a piece's `auth.validate` hook.
 *
 * Activepieces pieces can declare a "test connection" function via
 * `BasePieceAuthSchema.validate`. The runtime adapter surfaces this on
 * `Connector.auth.validateAuth` (see `packages/connectors/src/types.ts`).
 *
 * This helper:
 *   1. Looks up the live connector in the registry by `connector` slug.
 *   2. Maps the auth-profile secrets to the shape the underlying piece expects
 *      via `normalizeAuthForAP` (the same mapping used at execution time).
 *   3. Invokes `validateAuth` with a minimal `ServerContext` (apiUrl/publicUrl).
 *
 * Returns:
 *   - `null` when no validate hook is available (caller should fall back to
 *     its existing structural checks).
 *   - `{ valid, error? }` when the hook ran.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { IAuthProfile } from '@agent-platform/database/models';

const log = createLogger('piece-auth-validator');
// Runtime imports are lazy (vite-ignore) so this module stays testable without
// the full package build chain.  When deps are injected the lazy defaults are
// never executed, keeping unit tests free of database / registry side-effects.

interface ValidateOutcome {
  valid: boolean;
  error?: string;
}

/**
 * Indicates how a profile was validated.
 *   live        — a live network call to the provider confirmed or rejected credentials
 *   structural  — credentials were checked against internal state (DB grants, field
 *                 validation, token expiry) without a live provider call
 *   optimistic  — no check was possible; the response is assumed valid
 */
export type ValidationMethod = 'live' | 'structural' | 'optimistic';

/**
 * A per-connector live-check function used when the underlying AP piece has no
 * `auth.validate` hook. Receives the flattened credential payload (secrets merged
 * with config) and returns an outcome from a single idempotent API call.
 */
export type LiveCheckFn = (params: {
  secrets: Record<string, string>;
  config: Record<string, unknown>;
}) => Promise<ValidateOutcome>;

// ---------------------------------------------------------------------------
// Lazy-import helpers — only resolved in production; tests inject liveChecks.
// ---------------------------------------------------------------------------

/** Lazy-loads safeFetch utilities. Module cache means subsequent calls are free. */
async function loadSafeFetch() {
  // @vite-ignore — lazy; tests bypass via injected liveChecks dep
  const [{ safeFetch, SSRFError }, { getDevSSRFOptions }] = await Promise.all([
    import(/* @vite-ignore */ '@agent-platform/shared-kernel/security/safe-fetch') as Promise<{
      safeFetch: (
        url: string,
        init: RequestInit,
        options?: Record<string, unknown>,
      ) => Promise<Response>;
      SSRFError: new (...args: unknown[]) => Error;
    }>,
    import(/* @vite-ignore */ '@agent-platform/shared-kernel/security') as unknown as Promise<{
      getDevSSRFOptions: () => Record<string, unknown>;
    }>,
  ]);
  return { safeFetch, SSRFError, getDevSSRFOptions };
}

type Aws4Module = {
  sign(
    opts: {
      host: string;
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      service: string;
      region: string;
    },
    creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  ): { headers: Record<string, string> };
};

/**
 * Signs an AWS request with SigV4 via the `aws4` package (already a root
 * workspace dep). Returns only the HTTP headers that should be forwarded —
 * `Host` is removed because `safeFetch` sets it implicitly.
 */
async function signWithAws4(params: {
  url: string;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}): Promise<Record<string, string>> {
  const aws4 = (await import(/* @vite-ignore */ 'aws4')) as Aws4Module;
  const requestUrl = new URL(params.url);
  const signed = aws4.sign(
    {
      host: requestUrl.host,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: 'GET',
      headers: {},
      service: params.service,
      region: params.region,
    },
    {
      accessKeyId: params.accessKeyId,
      secretAccessKey: params.secretAccessKey,
      ...(params.sessionToken ? { sessionToken: params.sessionToken } : {}),
    },
  );
  const signedHeaders = { ...signed.headers };
  delete signedHeaders.host;
  delete signedHeaders.Host;
  return signedHeaders;
}

// ---------------------------------------------------------------------------

/**
 * Built-in live checks for high-value connectors whose AP pieces lack a
 * validate hook. Each makes one lightweight, idempotent read-only API call
 * to confirm the credential is accepted by the provider.
 *
 * Keys are connector names (same as `IAuthProfile.connector`).
 * Injectable via `RunPieceAuthValidateDeps.liveChecks` to keep tests
 * free of real HTTP calls.
 */
const BUILT_IN_LIVE_CHECKS: Record<string, LiveCheckFn> = {
  // ── Simple bearer / api-key checks ────────────────────────────────────────

  discord: async ({ secrets }) => {
    const token = secrets.apiKey ?? secrets.botToken ?? '';
    if (!token) return { valid: false, error: 'No bot token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://discord.com/api/v10/users/@me',
        { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid bot token' };
      return { valid: false, error: `Discord returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Discord URL blocked by SSRF protection' };
      throw err;
    }
  },

  sendgrid: async ({ secrets }) => {
    const apiKey = secrets.apiKey ?? secrets.secret_text ?? '';
    if (!apiKey) return { valid: false, error: 'No API key found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.sendgrid.com/v3/user/profile',
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid API key' };
      return { valid: false, error: `SendGrid returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'SendGrid URL blocked by SSRF protection' };
      throw err;
    }
  },

  notion: async ({ secrets }) => {
    const token =
      secrets.apiKey ?? secrets.secret_text ?? secrets.access_token ?? secrets.notionApiKey ?? '';
    if (!token) return { valid: false, error: 'No API token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.notion.com/v1/users/me',
        {
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid Notion API token' };
      return { valid: false, error: `Notion returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Notion URL blocked by SSRF protection' };
      throw err;
    }
  },

  claude: async ({ secrets }) => {
    const apiKey = secrets.apiKey ?? secrets.secret_text ?? '';
    if (!apiKey) return { valid: false, error: 'No API key found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.anthropic.com/v1/models',
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid API key' };
      return { valid: false, error: `Anthropic returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Anthropic URL blocked by SSRF protection' };
      throw err;
    }
  },

  twilio: async ({ secrets }) => {
    // Twilio Basic auth: username = Account SID, password = Auth Token.
    const accountSid = secrets.username ?? secrets.accountSid ?? '';
    const authToken = secrets.password ?? secrets.authToken ?? '';
    if (!accountSid || !authToken) {
      return { valid: false, error: 'Twilio requires Account SID and Auth Token' };
    }
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    try {
      const res = await safeFetch(
        'https://api.twilio.com/2010-04-01/Accounts.json',
        {
          headers: { Authorization: `Basic ${credentials}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid Account SID or Auth Token' };
      return { valid: false, error: `Twilio returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Twilio URL blocked by SSRF protection' };
      throw err;
    }
  },

  servicenow: async ({ secrets, config }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const connectionConfig = (config.connectionConfig as Record<string, unknown> | undefined) ?? {};
    const subdomain =
      (connectionConfig.subdomain as string | undefined) ??
      (config.subdomain as string | undefined) ??
      secrets.subdomain;
    if (!subdomain) {
      return { valid: false, error: 'ServiceNow requires subdomain in connection config' };
    }
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        `https://${subdomain}.service-now.com/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      if (res.status === 403)
        return { valid: false, error: 'Access denied — insufficient ServiceNow permissions' };
      return { valid: false, error: `ServiceNow returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'ServiceNow URL blocked by SSRF protection' };
      throw err;
    }
  },

  // ── OAuth2 connector live checks ──────────────────────────────────────────
  // For oauth2_app profiles the access token flows here from the DB grant via
  // validateOAuth2AppProfile → runPieceAuthValidate(oauthAccessToken).
  // buildAuthPayload sets secrets.access_token = oauthAccessToken, so all
  // checks below read secrets.access_token as the live OAuth bearer token.

  github: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.github.com/user',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            Accept: 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired GitHub token' };
      return { valid: false, error: `GitHub returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'GitHub URL blocked by SSRF protection' };
      throw err;
    }
  },

  // Google services share the same OAuth2 userinfo endpoint.
  gmail: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Google token' };
      return { valid: false, error: `Google returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Google URL blocked by SSRF protection' };
      throw err;
    }
  },

  'google-calendar': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Google token' };
      return { valid: false, error: `Google returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Google URL blocked by SSRF protection' };
      throw err;
    }
  },

  'google-drive': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Google token' };
      return { valid: false, error: `Google returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Google URL blocked by SSRF protection' };
      throw err;
    }
  },

  'google-sheets': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Google token' };
      return { valid: false, error: `Google returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Google URL blocked by SSRF protection' };
      throw err;
    }
  },

  slack: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://slack.com/api/auth.test',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (!res.ok) return { valid: false, error: `Slack returned ${res.status}` };
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) return { valid: true };
      if (body.error === 'invalid_auth' || body.error === 'token_revoked') {
        return { valid: false, error: 'Invalid or revoked Slack token' };
      }
      return { valid: false, error: body.error ?? 'Slack auth.test failed' };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Slack URL blocked by SSRF protection' };
      throw err;
    }
  },

  hubspot: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.hubapi.com/oauth/v1/access-tokens/' + encodeURIComponent(token),
        { signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: 'Invalid or expired HubSpot token' };
      return { valid: false, error: `HubSpot returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'HubSpot URL blocked by SSRF protection' };
      throw err;
    }
  },

  asana: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://app.asana.com/api/1.0/users/me',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Asana token' };
      return { valid: false, error: `Asana returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Asana URL blocked by SSRF protection' };
      throw err;
    }
  },

  clickup: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.clickup.com/api/v2/user',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired ClickUp token' };
      return { valid: false, error: `ClickUp returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'ClickUp URL blocked by SSRF protection' };
      throw err;
    }
  },

  pipedrive: async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.pipedrive.com/v1/users/me',
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Pipedrive token' };
      return { valid: false, error: `Pipedrive returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Pipedrive URL blocked by SSRF protection' };
      throw err;
    }
  },

  // ── Microsoft Graph bearer checks ─────────────────────────────────────────
  // All three connectors use Azure AD access tokens and share the MS Graph /me
  // endpoint for credential confirmation.

  'microsoft-outlook': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://graph.microsoft.com/v1.0/me',
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      return { valid: false, error: `Microsoft Graph returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Microsoft Graph URL blocked by SSRF protection' };
      throw err;
    }
  },

  // Salesforce environment prop is 'login' (production) or 'test' (sandbox).
  // It determines the OAuth host — enforce the allowlist to prevent SSRF via
  // a user-supplied environment string becoming part of the hostname.
  salesforce: async ({ secrets, config }) => {
    const token = secrets.access_token ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const props = (config.props as Record<string, unknown> | undefined) ?? {};
    const rawEnv =
      (props.environment as string | undefined) ??
      (config.environment as string | undefined) ??
      'login';
    const environment = rawEnv === 'test' ? 'test' : 'login';
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        `https://${environment}.salesforce.com/services/oauth2/userinfo`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired Salesforce token' };
      return { valid: false, error: `Salesforce returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Salesforce URL blocked by SSRF protection' };
      throw err;
    }
  },

  // Dynamics 365 BC uses Azure AD tokens scoped to the BC API.
  // The 'cloud' prop selects commercial vs US Gov; 'environment' is the BC
  // environment name (e.g. 'Production'). Both are user-supplied so the host
  // is selected from a two-value allowlist and the environment is path-only.
  'microsoft-dynamics-365-business-central': async ({ secrets, config }) => {
    const token = secrets.access_token ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const props = (config.props as Record<string, unknown> | undefined) ?? {};
    const cloud = (props.cloud as string | undefined) ?? (config.cloud as string | undefined) ?? '';
    const host =
      cloud === 'login.microsoftonline.us'
        ? 'api.businesscentral.dynamics.us'
        : 'api.businesscentral.dynamics.com';
    const environment =
      (props.environment as string | undefined) ??
      (config.environment as string | undefined) ??
      'Production';
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        `https://${host}/v2.0/${encodeURIComponent(environment)}/api/v2.0/companies?$top=1`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401)
        return { valid: false, error: 'Invalid or expired Business Central token' };
      if (res.status === 403)
        return { valid: false, error: 'Access denied — check Business Central permissions' };
      return { valid: false, error: `Business Central returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Business Central URL blocked by SSRF protection' };
      throw err;
    }
  },

  'microsoft-outlook-calendar': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://graph.microsoft.com/v1.0/me',
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      return { valid: false, error: `Microsoft Graph returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Microsoft Graph URL blocked by SSRF protection' };
      throw err;
    }
  },

  'microsoft-sharepoint': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://graph.microsoft.com/v1.0/me',
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      return { valid: false, error: `Microsoft Graph returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Microsoft Graph URL blocked by SSRF protection' };
      throw err;
    }
  },

  'microsoft-power-bi': async ({ secrets }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        'https://api.powerbi.com/v1.0/myorg/datasets?$top=1',
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      return { valid: false, error: `Power BI returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Power BI URL blocked by SSRF protection' };
      throw err;
    }
  },

  'microsoft-onedrive': async ({ secrets, config }) => {
    const token = secrets.access_token ?? secrets.accessToken ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const props = (config.props as Record<string, unknown> | undefined) ?? {};
    const cloud = (props.cloud as string | undefined) ?? (config.cloud as string | undefined) ?? '';
    const graphBase =
      cloud === 'login.microsoftonline.us'
        ? 'https://graph.microsoft.us'
        : 'https://graph.microsoft.com';
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        `${graphBase}/v1.0/me/drive`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      return { valid: false, error: `OneDrive returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'OneDrive URL blocked by SSRF protection' };
      throw err;
    }
  },

  // ── AWS SigV4 checks ───────────────────────────────────────────────────────
  // All four use IAM credentials (accessKeyId + secretAccessKey + region).
  // Signed with aws4 (root workspace dep). Uses safeFetch for SSRF protection
  // on the constructed endpoint URLs — mitigates SSRF on user-supplied region.

  'amazon-s3': async ({ secrets }) => {
    const { accessKeyId, secretAccessKey, region = 'us-east-1', sessionToken } = secrets;
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: 'AWS credentials require accessKeyId and secretAccessKey' };
    }
    const url = `https://s3.${region}.amazonaws.com/`;
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const signedHeaders = await signWithAws4({
        url,
        service: 's3',
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      const res = await safeFetch(
        url,
        { headers: signedHeaders, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 403)
        return { valid: false, error: 'Invalid AWS credentials or insufficient S3 permissions' };
      return { valid: false, error: `S3 returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'S3 URL blocked by SSRF protection' };
      throw err;
    }
  },

  'amazon-ses': async ({ secrets }) => {
    const { accessKeyId, secretAccessKey, region = 'us-east-1', sessionToken } = secrets;
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: 'AWS credentials require accessKeyId and secretAccessKey' };
    }
    const url = `https://email.${region}.amazonaws.com/?Action=GetSendQuota&Version=2010-12-01`;
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const signedHeaders = await signWithAws4({
        url,
        service: 'ses',
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      const res = await safeFetch(
        url,
        { headers: signedHeaders, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 403)
        return { valid: false, error: 'Invalid AWS credentials or insufficient SES permissions' };
      return { valid: false, error: `SES returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'SES URL blocked by SSRF protection' };
      throw err;
    }
  },

  'amazon-sns': async ({ secrets }) => {
    const { accessKeyId, secretAccessKey, region = 'us-east-1', sessionToken } = secrets;
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: 'AWS credentials require accessKeyId and secretAccessKey' };
    }
    const url = `https://sns.${region}.amazonaws.com/?Action=ListTopics&Version=2010-03-31`;
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const signedHeaders = await signWithAws4({
        url,
        service: 'sns',
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      const res = await safeFetch(
        url,
        { headers: signedHeaders, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 403)
        return { valid: false, error: 'Invalid AWS credentials or insufficient SNS permissions' };
      return { valid: false, error: `SNS returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'SNS URL blocked by SSRF protection' };
      throw err;
    }
  },

  // ── Zendesk bearer check ──────────────────────────────────────────────────
  // The Zendesk AP piece has no `auth.validate` hook. The subdomain lives in
  // config.connectionConfig.subdomain (same pattern as ServiceNow).

  zendesk: async ({ secrets, config }) => {
    const token = secrets.access_token ?? secrets.apiKey ?? '';
    if (!token) return { valid: false, error: 'No access token found in credentials' };
    const connectionConfig = (config.connectionConfig as Record<string, unknown> | undefined) ?? {};
    const subdomain =
      (connectionConfig.subdomain as string | undefined) ??
      (config.subdomain as string | undefined) ??
      secrets.subdomain;
    if (!subdomain) {
      return { valid: false, error: 'Zendesk requires subdomain in connection config' };
    }
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const res = await safeFetch(
        `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: 'Invalid or expired access token' };
      if (res.status === 403)
        return { valid: false, error: 'Access denied — insufficient Zendesk permissions' };
      return { valid: false, error: `Zendesk returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'Zendesk URL blocked by SSRF protection' };
      throw err;
    }
  },

  'amazon-sqs': async ({ secrets }) => {
    const { accessKeyId, secretAccessKey, region = 'us-east-1', sessionToken } = secrets;
    if (!accessKeyId || !secretAccessKey) {
      return { valid: false, error: 'AWS credentials require accessKeyId and secretAccessKey' };
    }
    const url = `https://sqs.${region}.amazonaws.com/?Action=ListQueues&Version=2012-11-05`;
    const { safeFetch, SSRFError, getDevSSRFOptions } = await loadSafeFetch();
    try {
      const signedHeaders = await signWithAws4({
        url,
        service: 'sqs',
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      });
      const res = await safeFetch(
        url,
        { headers: signedHeaders, signal: AbortSignal.timeout(10_000) },
        getDevSSRFOptions(),
      );
      if (res.ok) return { valid: true };
      if (res.status === 403)
        return { valid: false, error: 'Invalid AWS credentials or insufficient SQS permissions' };
      return { valid: false, error: `SQS returned ${res.status}` };
    } catch (err) {
      if (err instanceof SSRFError)
        return { valid: false, error: 'SQS URL blocked by SSRF protection' };
      throw err;
    }
  },
};

/**
 * Connectors whose AP `auth.validate` hooks require action-specific parameters
 * that are NOT part of the credential payload stored in auth profiles (e.g.
 * `amazon-s3` requires `bucket`, which is a per-action field, not a credential).
 *
 * For these connectors the built-in live check is used instead of the AP hook,
 * even when the registry exposes a `validateAuth` function.
 */
const AP_HOOK_REQUIRES_ACTION_PARAMS = new Set(['amazon-s3']);

/**
 * Minimal shape of an OAuth grant returned by the find function.
 * Using a structural type (not `IEndUserOAuthToken`) keeps this helper
 * independent of the database layer and straightforward to stub in tests.
 */
export interface OAuthGrant {
  expiresAt: Date | null;
  /** Raw access token — already decrypted when fetched via findOne() (not lean()). */
  encryptedAccessToken: string;
}

/**
 * Injectable grant-lookup function. Defaults to a real `EndUserOAuthToken.findOne`.
 * Inject a stub in tests to exercise the branch logic without a database.
 */
export type FindOAuthGrantFn = (params: {
  tenantId: string;
  userId: string;
  provider: string;
}) => Promise<OAuthGrant | null>;

export interface ValidateOAuth2AppDeps extends RunPieceAuthValidateDeps {
  /** Override the default EndUserOAuthToken lookup for testing. */
  findGrant?: FindOAuthGrantFn;
}

/**
 * Connector-registry shape used by the validator. Decoupled from
 * `ConnectorRegistry` so tests can pass a hand-rolled stub without
 * `vi.mock('@agent-platform/connectors')` or `vi.mock('@/lib/...')`.
 */
export interface PieceValidatorRegistry {
  has(name: string): boolean;
  get(name: string): Promise<{ auth: { validateAuth?: unknown } }>;
}

/** Function type for registry lookup. */
export type GetPieceValidatorRegistry = () => Promise<PieceValidatorRegistry>;

/** Function type for the auth normalizer the validate hook expects. */
export type NormalizeAuthForPieceValidate = (
  connectorName: string,
  auth: Record<string, unknown>,
) => unknown;

export interface RunPieceAuthValidateDeps {
  /** Resolves the live connector registry. Defaults to studio's `getConnectorRegistry`. */
  getRegistry?: GetPieceValidatorRegistry;
  /** Per-connector auth shape normalizer. Defaults to the connectors-package implementation. */
  normalizeAuth?: NormalizeAuthForPieceValidate;
  /**
   * Override the built-in live-check map (connector name → LiveCheckFn).
   * Inject an empty object `{}` in tests to suppress all live HTTP calls.
   * Defaults to BUILT_IN_LIVE_CHECKS (Discord, SendGrid, Notion).
   */
  liveChecks?: Record<string, LiveCheckFn>;
}

/**
 * Build the auth payload that we pass to `validateAuth`. Auth-profile secrets
 * + config are merged so connection-config fields (subdomain, hostname, etc.)
 * are available alongside credentials.
 *
 * For `oauth2_app` profiles the access token isn't stored on the profile —
 * it lives in `EndUserOAuthToken` keyed by the profile's provider key. The
 * caller must pass it in (or skip OAuth profiles when it's unavailable).
 */
function buildAuthPayload(
  profile: IAuthProfile,
  decryptedSecrets: Record<string, unknown>,
  oauthAccessToken?: string,
): Record<string, unknown> {
  const config = (profile.config ?? {}) as Record<string, unknown>;
  return {
    ...config,
    ...decryptedSecrets,
    ...(oauthAccessToken ? { access_token: oauthAccessToken } : {}),
  };
}

/**
 * Validates an `oauth2_app` auth profile by looking up the durable OAuth grant
 * and, when a grant is found, optionally invoking the connector's `validateAuth` hook.
 *
 * `deps.findGrant` is intentionally required — callers (route handlers) own the
 * database interaction and pass their own implementation. This keeps the helper
 * free of database imports, which enables unit testing without mocks.
 */
export async function validateOAuth2AppProfile(
  params: {
    profile: IAuthProfile;
    decryptedSecrets: Record<string, unknown>;
    tenantId: string;
    grantUserId: string;
    provider: string;
  },
  deps: ValidateOAuth2AppDeps & { findGrant: FindOAuthGrantFn },
): Promise<{ valid: boolean; error?: string }> {
  const { findGrant } = deps;

  const grant = await findGrant({
    tenantId: params.tenantId,
    userId: params.grantUserId,
    provider: params.provider,
  });

  if (!grant) {
    return { valid: false, error: 'No OAuth grant found — user authorization required' };
  }

  if (grant.expiresAt && grant.expiresAt < new Date()) {
    return { valid: false, error: 'OAuth grant has expired — reauthorization required' };
  }

  // encryptedAccessToken is auto-decrypted by the encryption plugin on findOne() (not lean())
  const pieceOutcome = await runPieceAuthValidate(
    {
      profile: params.profile,
      decryptedSecrets: params.decryptedSecrets,
      oauthAccessToken: grant.encryptedAccessToken,
    },
    deps,
  );

  if (pieceOutcome === null) return { valid: true };
  return {
    valid: pieceOutcome.valid,
    ...(pieceOutcome.valid
      ? {}
      : { error: pieceOutcome.error ?? 'Provider rejected the OAuth credentials' }),
  };
}

/**
 * Returns `null` when there's nothing to validate (no connector slug, registry
 * not initialised, no `validateAuth` on the connector). Otherwise invokes
 * the piece's hook and returns its outcome.
 */
export async function runPieceAuthValidate(
  params: {
    profile: IAuthProfile;
    decryptedSecrets: Record<string, unknown>;
    oauthAccessToken?: string;
    /** Public URL of the platform — surfaced as ServerContext.publicUrl. */
    publicUrl?: string;
  },
  deps: RunPieceAuthValidateDeps = {},
): Promise<ValidateOutcome | null> {
  const connectorName = params.profile.connector;
  if (!connectorName) return null;

  const getRegistry: GetPieceValidatorRegistry =
    deps.getRegistry ??
    (async () => {
      // @vite-ignore — lazy default; only reached in production (tests inject getRegistry)
      const mod = await import(/* @vite-ignore */ '@/lib/connection-service');
      return mod.getConnectorRegistry();
    });

  let normalizeAuth: NormalizeAuthForPieceValidate;
  if (deps.normalizeAuth) {
    normalizeAuth = deps.normalizeAuth;
  } else {
    // @vite-ignore — lazy default; only reached in production (tests inject normalizeAuth)
    const mod = await import(/* @vite-ignore */ '@agent-platform/connectors');
    normalizeAuth = (mod as { normalizeAuthForPieceValidate: NormalizeAuthForPieceValidate })
      .normalizeAuthForPieceValidate;
  }

  let registry: PieceValidatorRegistry;
  try {
    registry = (await getRegistry()) as PieceValidatorRegistry;
  } catch (err) {
    log.debug('Failed to load piece validator registry', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!registry.has(connectorName)) return null;

  const connector = await registry.get(connectorName);
  const validateAuth = connector?.auth.validateAuth;
  const effectiveLiveChecks = deps.liveChecks ?? BUILT_IN_LIVE_CHECKS;
  const liveCheck = effectiveLiveChecks[connectorName];

  // Use the built-in live check when:
  //   a) the AP piece has no validate hook, OR
  //   b) the AP hook requires action-specific params not in the credential payload
  //      (e.g. amazon-s3 needs `bucket`; we can't provide it from an auth profile).
  const useBuiltIn =
    typeof validateAuth !== 'function' || AP_HOOK_REQUIRES_ACTION_PARAMS.has(connectorName);

  if (useBuiltIn) {
    if (!liveCheck) return null;
    const allPayload = buildAuthPayload(
      params.profile,
      params.decryptedSecrets,
      params.oauthAccessToken,
    );
    const secrets: Record<string, string> = Object.fromEntries(
      Object.entries(allPayload).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    const config = (params.profile.config ?? {}) as Record<string, unknown>;
    try {
      return await liveCheck({ secrets, config });
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Use the validate-specific normalizer — for some connectors the validate
  // hook expects a different auth shape than the action runtime. See
  // normalizeAuthForPieceValidate JSDoc for the per-connector divergences
  // (Shopify unwraps the props envelope; Linear receives a raw string).
  const auth = normalizeAuth(
    connectorName,
    buildAuthPayload(params.profile, params.decryptedSecrets, params.oauthAccessToken),
  );

  const publicUrl =
    params.publicUrl ??
    process.env.PUBLIC_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    'http://localhost:5173';

  try {
    const validateFn = validateAuth as (input: {
      auth: unknown;
      server: { apiUrl: string; publicUrl: string };
    }) => Promise<{ valid: true } | { valid: false; error: string }>;
    const result = await validateFn({
      auth,
      server: { apiUrl: publicUrl, publicUrl },
    });
    if (result.valid) return { valid: true };
    return { valid: false, error: result.error };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
