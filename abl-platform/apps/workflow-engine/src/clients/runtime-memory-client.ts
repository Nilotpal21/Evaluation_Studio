/**
 * Runtime Memory Client
 *
 * HTTP client for the runtime's `/api/internal/memory/*` route group. The
 * workflow-engine uses this client at TWO call sites:
 *  1. `loadProjection` — invoked by `loadMemoryProjection` in
 *     `workflow-handler.ts` at the start of every workflow run; populates
 *     `context.memory`.
 *  2. `get` / `set` / `delete` — invoked from inside the function-node V8
 *     isolate via `ivm.Reference.applySyncPromise`; these run on the
 *     ISOLATE WORKER THREAD (D-9 finding) and block the script until the
 *     host promise resolves.
 *
 * Per LLD §1.2 the client:
 *  - Signs a fresh service JWT per request via `createServiceToken` (5-min
 *    expiry; payload carries the per-call tenantId/projectId).
 *  - Uses `globalThis.fetch` (Node ≥ 18; matches workspace convention — no
 *    axios). Tests inject a `fetchImpl` for the request-shape unit cases.
 *  - Enforces a 5-second per-op timeout via `AbortSignal.timeout`. D-9
 *    confirmed `script.run({ timeout })` does NOT cancel a script blocked
 *    inside `applySyncPromise`, so the timeout must live in the HTTP layer.
 *  - Maps response codes to `WorkflowMemoryError` so callers can branch on
 *    `code` without parsing JSON envelopes themselves.
 *
 * The client is intentionally stateless: every method takes the full
 * tenant/project/workflow trio and signs a token from those values. This
 * matches the runtime's `requireServiceAuth` cross-check rule (the body's
 * tenantId must equal the JWT's tenantId).
 */

import { createServiceToken } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import type { MemoryProjection } from '../context/expression-resolver.js';
import { MEMORY_OP_TIMEOUT_MS } from '../constants.js';

const log = createLogger('workflow-engine:runtime-memory-client');

/** Fetch surface — Node 18+ global, overridable for tests. */
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Constructor options. The secret signs every outbound JWT. */
export interface RuntimeMemoryClientOptions {
  baseUrl: string;
  serviceTokenSecret: string;
  defaultTimeoutMs?: number;
  /** Test-only override. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchImpl;
}

/** Request body shape for `/projection`. */
export interface MemoryProjectionRequest {
  tenantId: string;
  projectId: string;
  workflowId: string;
  endUserId?: string;
}

/**
 * Common base for `/get`, `/set`, `/delete`. Each route's body adds fields
 * (set: `value`/`ttl`; delete: neither).
 */
export interface MemoryOpRequest {
  tenantId: string;
  projectId: string;
  workflowId: string;
  runId: string;
  actor: { kind: 'workflow-author' | 'end-user'; endUserId?: string };
  scope: 'workflow' | 'project' | 'user';
  key: string;
  endUserId?: string;
  value?: unknown;
  ttl?: string;
}

/**
 * Mirrors the route's error envelope. Codes are stable; message is
 * human-readable. Callers branch on `code`.
 */
export type WorkflowMemoryErrorCode =
  | 'INVALID_BODY'
  | 'RESERVED_PREFIX'
  | 'QUOTA_KEY_LENGTH'
  | 'QUOTA_VALUE_SIZE'
  | 'QUOTA_WRITE_COUNT'
  | 'TTL_INVALID'
  | 'INVALID_VALUE'
  | 'UNAVAILABLE_SCOPE'
  | 'STORAGE_UNAVAILABLE'
  | 'PROJECTION_TOO_LARGE'
  | 'INVALID_TENANT'
  | 'INVALID_PROJECT'
  | 'INTERNAL';

export class WorkflowMemoryError extends Error {
  constructor(
    public readonly code: WorkflowMemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowMemoryError';
  }
}

interface RouteEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const KNOWN_ERROR_CODES = new Set<WorkflowMemoryErrorCode>([
  'INVALID_BODY',
  'RESERVED_PREFIX',
  'QUOTA_KEY_LENGTH',
  'QUOTA_VALUE_SIZE',
  'QUOTA_WRITE_COUNT',
  'TTL_INVALID',
  'INVALID_VALUE',
  'UNAVAILABLE_SCOPE',
  'STORAGE_UNAVAILABLE',
  'PROJECTION_TOO_LARGE',
  'INVALID_TENANT',
  'INVALID_PROJECT',
  'INTERNAL',
]);

function normalizeErrorCode(raw: string | undefined): WorkflowMemoryErrorCode {
  if (raw && KNOWN_ERROR_CODES.has(raw as WorkflowMemoryErrorCode)) {
    return raw as WorkflowMemoryErrorCode;
  }
  return 'INTERNAL';
}

export class RuntimeMemoryClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: RuntimeMemoryClientOptions) {
    if (!opts.baseUrl) throw new Error('RuntimeMemoryClient: baseUrl is required');
    if (!opts.serviceTokenSecret)
      throw new Error('RuntimeMemoryClient: serviceTokenSecret is required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.secret = opts.serviceTokenSecret;
    this.timeoutMs = opts.defaultTimeoutMs ?? MEMORY_OP_TIMEOUT_MS;
    // `fetchImpl` lets unit tests inject a stub. Production uses the Node
    // global. We DON'T `vi.mock('node-fetch')` — that's banned by CLAUDE.md
    // "Test Architecture": platform components are dependency-injected.
    this.fetchImpl =
      opts.fetchImpl ??
      ((url, init) =>
        // The cast is only because TS doesn't know the runtime has fetch.
        (globalThis as { fetch: FetchImpl }).fetch(url, init));
  }

  async loadProjection(req: MemoryProjectionRequest): Promise<MemoryProjection> {
    const body: Record<string, unknown> = {
      tenantId: req.tenantId,
      projectId: req.projectId,
      workflowId: req.workflowId,
    };
    if (req.endUserId) body.endUserId = req.endUserId;
    const data = await this.post<{
      workflow: Record<string, unknown>;
      project: Record<string, unknown>;
      user?: Record<string, unknown>;
    }>('/api/internal/memory/projection', req.tenantId, req.projectId, body);
    return {
      workflow: data.workflow,
      project: data.project,
      user: data.user,
    };
  }

  async get(req: MemoryOpRequest): Promise<unknown> {
    // /get does not declare or read `actor` on the runtime side — sending it
    // would be silently dropped under loose validation and now rejected as
    // INVALID_BODY under .strict(). Build a get-specific body instead of
    // routing through the shared write-body builder.
    const body: Record<string, unknown> = {
      tenantId: req.tenantId,
      projectId: req.projectId,
      workflowId: req.workflowId,
      runId: req.runId,
      scope: req.scope,
      key: req.key,
    };
    if (req.endUserId) body.endUserId = req.endUserId;
    const data = await this.post<{ value: unknown }>(
      '/api/internal/memory/get',
      req.tenantId,
      req.projectId,
      body,
    );
    return data.value;
  }

  async set(req: MemoryOpRequest): Promise<void> {
    const body = this.buildOpBody(req);
    if (req.value !== undefined) body.value = req.value;
    if (req.ttl !== undefined) body.ttl = req.ttl;
    await this.post('/api/internal/memory/set', req.tenantId, req.projectId, body);
  }

  async delete(req: Omit<MemoryOpRequest, 'value' | 'ttl'>): Promise<void> {
    const body = this.buildOpBody(req);
    await this.post('/api/internal/memory/delete', req.tenantId, req.projectId, body);
  }

  private buildOpBody(
    req: MemoryOpRequest | Omit<MemoryOpRequest, 'value' | 'ttl'>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      tenantId: req.tenantId,
      projectId: req.projectId,
      workflowId: req.workflowId,
      runId: req.runId,
      actor: req.actor,
      scope: req.scope,
      key: req.key,
    };
    if (req.endUserId) body.endUserId = req.endUserId;
    return body;
  }

  private async post<T>(
    path: string,
    tenantId: string,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // Sign a fresh token per request. Cheap (HMAC) and ensures the JWT's
    // tenantId always matches the body's tenantId — the runtime's
    // `requireServiceAuth` cross-check (Phase 0) compares them.
    const token = createServiceToken(this.secret, {
      tenantId,
      projectId,
      serviceName: 'workflow-engine',
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Network errors and abort timeouts both surface as STORAGE_UNAVAILABLE.
      // Authors should not see these surfaced as `INTERNAL` (which suggests a
      // platform bug); from the workflow's POV the storage tier is just down.
      const message = err instanceof Error ? err.message : String(err);
      log.warn('runtime memory call failed at network layer', { url, message });
      throw new WorkflowMemoryError('STORAGE_UNAVAILABLE', `Memory op network failure: ${message}`);
    }

    let envelope: RouteEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as RouteEnvelope<T>;
    } catch (parseErr) {
      log.warn('runtime memory response was not JSON', {
        url,
        status: response.status,
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
    }

    if (!response.ok || !envelope?.success) {
      const code = normalizeErrorCode(envelope?.error?.code);
      const message =
        envelope?.error?.message ?? `runtime memory op failed (status=${response.status})`;
      throw new WorkflowMemoryError(code, message);
    }

    return envelope.data as T;
  }
}
