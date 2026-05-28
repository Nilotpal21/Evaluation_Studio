/**
 * API helpers for real E2E tests.
 *
 * Thin wrappers around Playwright's request API for making authenticated
 * calls to Studio proxy routes and direct backend APIs.
 *
 * Auth model:
 * - Studio proxy routes require `Authorization: Bearer <accessToken>` + `X-Tenant-Id`
 * - The real frontend's `apiFetch` sends both headers (from Zustand auth store)
 * - On 401, the frontend auto-refreshes via `/api/auth/refresh` (httpOnly cookie)
 *
 * @e2e-real — No mocks. All calls hit real endpoints.
 */

import type { Page, APIRequestContext } from '@playwright/test';
import { env } from './env';
import type { TestState } from './state';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

interface ApiOptions {
  /** Additional headers to merge (e.g., X-Tenant-Id override) */
  headers?: Record<string, string>;
}

function getRequest(ctx: Page | APIRequestContext): APIRequestContext {
  return 'request' in ctx ? ctx.request : ctx;
}

/**
 * Build standard headers matching what the real frontend sends.
 *
 * The real frontend's `apiFetch` sends:
 * - `Authorization: Bearer <accessToken>` from Zustand auth store
 * - `X-Tenant-Id: <tenantId>` from Zustand auth store
 *
 * We replicate this so the Next.js API routes and the backend see
 * the same headers they'd see from a real browser session.
 */
function authHeaders(token: string, opts?: ApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Tenant-Id': env.tenantId,
    ...opts?.headers,
  };
}

/** POST to Studio proxy. */
export async function apiPost<T = Record<string, unknown>>(
  ctx: Page | APIRequestContext,
  path: string,
  token: string,
  data: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<ApiResponse<T>> {
  const resp = await getRequest(ctx).post(`${env.baseUrl}${path}`, {
    headers: { ...authHeaders(token, opts), 'Content-Type': 'application/json' },
    data,
  });
  const body = await resp.json().catch(() => ({}) as T);
  return { status: resp.status(), body };
}

/** GET from Studio proxy. */
export async function apiGet<T = Record<string, unknown>>(
  ctx: Page | APIRequestContext,
  path: string,
  token: string,
  opts?: ApiOptions,
): Promise<ApiResponse<T>> {
  const resp = await getRequest(ctx).get(`${env.baseUrl}${path}`, {
    headers: authHeaders(token, opts),
  });
  const body = await resp.json().catch(() => ({}) as T);
  return { status: resp.status(), body };
}

/** PUT to Studio proxy. */
export async function apiPut<T = Record<string, unknown>>(
  ctx: Page | APIRequestContext,
  path: string,
  token: string,
  data: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<ApiResponse<T>> {
  const resp = await getRequest(ctx).put(`${env.baseUrl}${path}`, {
    headers: { ...authHeaders(token, opts), 'Content-Type': 'application/json' },
    data,
  });
  const body = await resp.json().catch(() => ({}) as T);
  return { status: resp.status(), body };
}

/** PATCH to Studio proxy. */
export async function apiPatch<T = Record<string, unknown>>(
  ctx: Page | APIRequestContext,
  path: string,
  token: string,
  data: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<ApiResponse<T>> {
  const resp = await getRequest(ctx).patch(`${env.baseUrl}${path}`, {
    headers: { ...authHeaders(token, opts), 'Content-Type': 'application/json' },
    data,
  });
  const body = await resp.json().catch(() => ({}) as T);
  return { status: resp.status(), body };
}

/** DELETE from Studio proxy. */
export async function apiDelete<T = Record<string, unknown>>(
  ctx: Page | APIRequestContext,
  path: string,
  token: string,
  opts?: ApiOptions,
): Promise<ApiResponse<T>> {
  const resp = await getRequest(ctx).delete(`${env.baseUrl}${path}`, {
    headers: authHeaders(token, opts),
  });
  const body = await resp.json().catch(() => ({}) as T);
  return { status: resp.status(), body };
}

/**
 * Upload a file to SearchAI via multipart POST.
 *
 * File upload has no Studio proxy — goes direct to SearchAI engine.
 * On remote environments, ensure the SearchAI engine URL is reachable
 * (set TEST_SEARCHAI_URL). Playwright's request context bypasses browser
 * CORS restrictions, so cross-origin is not an issue.
 */
export async function uploadFile(
  ctx: Page | APIRequestContext,
  indexId: string,
  sourceId: string,
  token: string,
  fileName: string,
  content: string | Buffer,
  mimeType = 'text/plain',
): Promise<ApiResponse> {
  const uploadUrl = `${env.searchAiUrl}/api/indexes/${indexId}/sources/${sourceId}/documents`;

  const resp = await getRequest(ctx).post(uploadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': env.tenantId,
    },
    multipart: {
      file: {
        name: fileName,
        mimeType,
        buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
      },
    },
  });
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status(), body };
}

/**
 * Detect feature state by calling 6 Studio proxy APIs.
 *
 * Returns a partial TestState with feature detection flags populated.
 * Used by setup-create, setup-existing, and wait-enrichment specs.
 */
export async function detectFeatureState(
  ctx: Page | APIRequestContext,
  token: string,
  indexId: string,
): Promise<Partial<TestState>> {
  const result: Partial<TestState> = {};

  // 1. LLM configuration
  try {
    const { body } = await apiGet(ctx, `/api/search-ai/indexes/${indexId}/llm-config`, token);
    const config = body as Record<string, unknown>;
    const useCases = (config.useCases || config.llmConfig || {}) as Record<
      string,
      { enabled?: boolean }
    >;
    result.llmConfigured = Object.values(useCases).some((uc) => uc?.enabled === true);
  } catch {
    result.llmConfigured = false;
  }

  // 2. Document count (Studio proxy)
  try {
    const { body } = await apiGet(
      ctx,
      `/api/search-ai/indexes/${indexId}/documents?limit=1`,
      token,
    );
    const data = body as Record<string, unknown>;
    result.documentCount =
      typeof data.total === 'number'
        ? data.total
        : Array.isArray(data.documents)
          ? (data.documents as unknown[]).length
          : 0;
  } catch {
    result.documentCount = 0;
  }

  // 3. Knowledge Graph / Taxonomy status
  try {
    const { body } = await apiGet(
      ctx,
      `/api/search-ai/indexes/${indexId}/kg-configuration-status`,
      token,
    );
    const kg = body as Record<string, unknown>;
    result.hasKnowledgeGraph = kg.enabled === true || kg.isEnabled === true;
    result.hasTaxonomy = Array.isArray(kg.taxonomy)
      ? (kg.taxonomy as unknown[]).length > 0
      : kg.hasTaxonomy === true;
  } catch {
    result.hasKnowledgeGraph = false;
    result.hasTaxonomy = false;
  }

  // 4. Vocabulary
  try {
    const { body } = await apiGet(ctx, `/api/search-ai/indexes/${indexId}/vocabulary`, token);
    const vocab = body as Record<string, unknown>;
    const entries = Array.isArray(vocab.vocabularyTerms)
      ? vocab.vocabularyTerms
      : Array.isArray(vocab.data)
        ? vocab.data
        : [];
    result.hasVocabulary = (entries as unknown[]).length > 0;
  } catch {
    result.hasVocabulary = false;
  }

  // 5. Field mappings (tab-stats) — note: param is `knowledgeBaseId` but value is indexId (tech debt)
  try {
    const { body } = await apiGet(
      ctx,
      `/api/search-ai/mappings/tab-stats?knowledgeBaseId=${indexId}`,
      token,
    );
    const stats = body as Record<string, unknown>;
    result.hasFieldMappings = typeof stats.totalFields === 'number' ? stats.totalFields > 0 : false;
  } catch {
    result.hasFieldMappings = false;
  }

  // 6. Enrichment status (status-summary via Studio proxy)
  try {
    const { body } = await apiGet(
      ctx,
      `/api/search-ai/indexes/${indexId}/documents/status-summary`,
      token,
    );
    const summary = body as Record<string, unknown>;
    const statuses = Array.isArray(summary.documentStatuses)
      ? (summary.documentStatuses as { _id: string; count: number }[])
      : [];
    const allIndexed =
      statuses.length > 0 && statuses.every((s) => s._id === 'indexed' || s._id === 'ready');
    const chunkErrors =
      typeof summary.docsWithChunkErrors === 'number' ? summary.docsWithChunkErrors : 0;
    result.enrichmentDone = allIndexed && chunkErrors === 0;
  } catch {
    result.enrichmentDone = false;
  }

  return result;
}
