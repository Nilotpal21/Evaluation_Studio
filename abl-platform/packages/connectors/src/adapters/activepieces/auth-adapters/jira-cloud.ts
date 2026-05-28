/**
 * Jira Cloud OAuth Auth Adapter
 *
 * The unpatched @activepieces/piece-jira-cloud only supports Basic auth
 * (email + apiToken). This adapter replaces the three HTTP entry points in
 * common/index.js at runtime so that when auth.access_token is present the
 * piece routes requests to api.atlassian.com with a Bearer token.
 *
 * Why runtime replacement works here:
 *   Action files load common/index.js and hold a reference to its exports
 *   object (e.g. `const common_1 = require('../common')`). Mutating that
 *   same object after load means every subsequent call through common_1.X
 *   hits our replacement. Internal calls within common/index.js that use
 *   local function refs are covered by re-implementing jiraPaginatedApiCall
 *   to call exports.jiraApiCall instead of the local ref.
 *
 * Must be called after localRequire('@activepieces/piece-jira-cloud') so the
 * module is in the require cache.
 */

import { createHash } from 'crypto';
import { createLogger } from '../../../logger.js';

const log = createLogger('jira-cloud-patch');

const ACCESSIBLE_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const CLOUD_ID_TTL_MS = 5 * 60 * 1000;
const CLOUD_ID_CACHE_MAX = 256;

interface CloudIdEntry {
  cloudId: string;
  expiresAt: number;
}

// Pod-local read-through cache for Jira Cloud IDs. cloudId is stable for the
// lifetime of an OAuth token and is cheap to re-fetch on pod restart.
// Bounded (256 entries, 5 min TTL) — not a source of truth.
const cloudIdCache = new Map<string, CloudIdEntry>();

async function resolveCloudId(accessToken: string): Promise<string> {
  // Hash the full token to avoid the shared JWT-header prefix collision (all Atlassian RS256
  // JWTs start with the same 36-char base64 header, so a raw slice(0,32) is identical for
  // every tenant on the same deployment).
  const cacheKey = createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
  const cached = cloudIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.cloudId;

  const resp = await fetch(ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    throw new Error(`Jira cloudId resolution failed: ${resp.status} ${resp.statusText}`);
  }

  const resources = (await resp.json()) as Array<{ id: string; name?: string }>;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error('No Jira Cloud instances found for this OAuth2 token');
  }

  if (resources.length > 1) {
    log.warn('Jira OAuth token grants access to multiple Cloud instances; using the first one', {
      instanceCount: resources.length,
      selectedId: resources[0].id,
    });
  }

  if (cloudIdCache.size >= CLOUD_ID_CACHE_MAX) {
    // Evict only the single oldest entry to avoid thundering-herd on full clear
    cloudIdCache.delete(cloudIdCache.keys().next().value!);
  }
  cloudIdCache.set(cacheKey, { cloudId: resources[0].id, expiresAt: Date.now() + CLOUD_ID_TTL_MS });
  return resources[0].id;
}

interface JiraAuth {
  access_token?: string;
  props?: { instanceUrl?: string; email?: string; apiToken?: string };
}

interface JiraApiCallArgs {
  auth: JiraAuth;
  method: string;
  resourceUri: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
}

interface JiraPaginatedApiCallArgs extends JiraApiCallArgs {
  propertyName: string;
}

interface JiraRequest {
  auth: JiraAuth;
  url: string;
  method: string;
  body?: unknown;
  queryParams?: Record<string, string>;
}

interface PiecesCommon {
  httpClient: { sendRequest: (req: unknown) => Promise<{ body: unknown }> };
  AuthenticationType: Record<string, string>;
}

export function applyJiraCloudAuthAdapter(localRequire: NodeRequire): void {
  const cacheKey = Object.keys(localRequire.cache).find(
    (k) => k.includes('piece-jira-cloud') && k.includes('/common/') && k.endsWith('index.js'),
  );

  if (!cacheKey) {
    log.warn(
      'jira-cloud auth-adapter: common/index.js not found in require cache — OAuth not applied',
    );
    return;
  }

  const mod = localRequire.cache[cacheKey];
  if (!mod) {
    log.warn('jira-cloud auth-adapter: module entry is undefined — OAuth not applied');
    return;
  }

  const exp = mod.exports as Record<string, unknown>;
  const { httpClient, AuthenticationType } = localRequire(
    '@activepieces/pieces-common',
  ) as PiecesCommon;

  // ── jiraApiCall ────────────────────────────────────────────────────────────
  const originalJiraApiCall = exp.jiraApiCall as (args: JiraApiCallArgs) => Promise<unknown>;

  exp.jiraApiCall = async function oauthJiraApiCall(args: JiraApiCallArgs): Promise<unknown> {
    const { auth, method, resourceUri, query, body } = args;
    if (typeof auth?.access_token === 'string') {
      const cloudId = await resolveCloudId(auth.access_token);
      const qs: Record<string, string> = {};
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== null && v !== undefined) qs[k] = String(v);
        }
      }
      const response = await httpClient.sendRequest({
        method,
        url: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${resourceUri}`,
        queryParams: qs,
        body,
        authentication: { type: AuthenticationType.BEARER_TOKEN, token: auth.access_token },
      });
      return response.body;
    }
    return originalJiraApiCall(args);
  };

  // ── jiraPaginatedApiCall ───────────────────────────────────────────────────
  // Re-implemented to call exports.jiraApiCall (patched) rather than the
  // local function ref that the original uses.
  exp.jiraPaginatedApiCall = async function oauthJiraPaginatedApiCall(
    args: JiraPaginatedApiCallArgs,
  ): Promise<unknown[]> {
    const { auth, method, resourceUri, body, propertyName } = args;
    const qs: Record<string, string | number> = args.query
      ? { ...(args.query as Record<string, string | number>) }
      : {};
    qs['startAt'] = 0;
    qs['maxResults'] = 100;
    const results: unknown[] = [];
    let hasMore = true;

    do {
      const response = (await (exp.jiraApiCall as (a: JiraApiCallArgs) => Promise<unknown>)({
        auth,
        method,
        resourceUri,
        query: qs,
        body,
      })) as Record<string, unknown>;

      if (response[propertyName] === null || response[propertyName] === undefined) break;
      if (Array.isArray(response[propertyName])) results.push(...response[propertyName]);

      (qs['startAt'] as number) += 100;
      hasMore =
        response['isLast'] === undefined
          ? (response['startAt'] as number) + (response['maxResults'] as number) <
            (response['total'] as number)
          : !(response['isLast'] as boolean);
    } while (hasMore);

    return results;
  };

  // ── sendJiraRequest ────────────────────────────────────────────────────────
  const originalSendJiraRequest = exp.sendJiraRequest as (req: JiraRequest) => Promise<unknown>;

  exp.sendJiraRequest = async function oauthSendJiraRequest(
    request: JiraRequest,
  ): Promise<unknown> {
    if (typeof request.auth?.access_token === 'string') {
      const cloudId = await resolveCloudId(request.auth.access_token);
      return httpClient.sendRequest({
        ...request,
        url: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/${request.url}`,
        authentication: {
          type: AuthenticationType.BEARER_TOKEN,
          token: request.auth.access_token,
        },
      });
    }
    return originalSendJiraRequest(request);
  };

  // ── Helper exports — re-routed through patched sendJiraRequest/jiraApiCall ──
  // These helpers call sendJiraRequest/jiraPaginatedApiCall via LOCAL function
  // refs inside common/index.js, bypassing the export replacements above.
  // Replacing their exports ensures dropdown options resolvers and action files
  // that call e.g. common_1.getProjects(auth) hit the OAuth-aware path.

  const callSend = exp.sendJiraRequest as (req: JiraRequest) => Promise<{ body: unknown }>;
  const callPaginated = exp.jiraPaginatedApiCall as (
    args: JiraPaginatedApiCallArgs,
  ) => Promise<unknown[]>;

  exp.getUsers = async (auth: JiraAuth) => {
    const response = await callSend({
      url: 'users/search',
      method: 'GET',
      auth,
      queryParams: { maxResults: '1000' },
    });
    return response.body;
  };

  exp.getProjects = async (auth: JiraAuth) => {
    return callPaginated({
      auth,
      method: 'GET',
      resourceUri: '/project/search',
      propertyName: 'values',
    });
  };

  exp.getIssueTypes = async ({ auth, projectId }: { auth: JiraAuth; projectId: string }) => {
    const response = await callSend({
      url: 'issuetype/project',
      method: 'GET',
      auth,
      queryParams: { projectId },
    });
    return response.body;
  };

  exp.searchIssuesByJql = async ({
    auth,
    jql,
    maxResults,
    sanitizeJql,
  }: {
    auth: JiraAuth;
    jql: string;
    maxResults?: number;
    sanitizeJql?: boolean;
  }) => {
    let reqJql = jql;
    if (sanitizeJql) {
      const sanitizeResult = (await callSend({
        auth,
        url: 'jql/sanitize',
        method: 'POST',
        body: { queries: [{ query: jql }] },
      })) as { body: { queries: Array<{ sanitizedQuery: string }> } };
      reqJql = sanitizeResult.body.queries[0].sanitizedQuery;
    }
    const jqlResult = (await callSend({
      auth,
      url: 'search/jql',
      method: 'POST',
      body: { maxResults, jql: reqJql },
    })) as { body: { issues: Array<{ id: string }> } };
    const issueIds = jqlResult.body.issues.map((i) => i.id);
    if (issueIds.length === 0) return [];
    const response = await callSend({
      auth,
      url: 'issue/bulkfetch',
      method: 'POST',
      body: { issueIdsOrKeys: issueIds },
    });
    return (response.body as { issues: unknown[] }).issues;
  };

  log.info('jira-cloud: OAuth auth adapter applied');
}
