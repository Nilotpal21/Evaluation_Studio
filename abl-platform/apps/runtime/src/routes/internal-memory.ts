/**
 * Internal Workflow Memory Route Group
 *
 * POST /api/internal/memory/projection
 * POST /api/internal/memory/get
 * POST /api/internal/memory/set
 * POST /api/internal/memory/delete
 *
 * Service-to-service surface called by the workflow-engine. Encapsulates the
 * workflow first-class memory feature (ABLP-643):
 *  - Three scopes: `workflow` (project-global, `wf:<workflowId>:<key>`),
 *    `project` (project-scoped, requires no end-user identity),
 *    `user` (per-end-user — `endUserId` required, scope=user store).
 *  - Reserved-prefix guard at route layer (`wf:`, `_meta:`, `_system:`,
 *    `_audit:`) — closes the cross-surface bypass alongside the deep
 *    `MongoDBFactStore._setInternal` guard.
 *  - Per-write quotas (key length 256, value 64 KiB, 100 writes/run).
 *  - TTL ceiling clamping (`MAX_FACT_TTL_MS = 365d`) with `ttl_clamped` warning.
 *  - Per-run write counter via Redis (`SET NX PX` + `INCR`). Fails closed with
 *    `STORAGE_UNAVAILABLE` when Redis is unreachable — never a local fallback
 *    (Stateless Distributed Invariant 3).
 *  - Mandatory structured-log audit (`createLogger('workflow-memory').info('memory_op', ...)`)
 *    on successful set/delete — NO `value` field ever.
 *  - Trace events `projection_load`, `memory_op`, `ttl_clamped` emitted via
 *    structured logs (TraceStore integration deferred to v1.1 — GAP-017).
 *
 * Mounted in `server.ts` behind `requireServiceAuth` so the cross-tenant /
 * cross-project guards (Phase 0) gate every call.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger, type Logger } from '@abl/compiler/platform';
import {
  type InternalServiceRequest,
  rejectIfTokenMismatch,
} from '../middleware/internal-service-auth.js';
import { getRedisClient } from '../services/redis/redis-client.js';
import {
  FactStoreWorkflowAdapter,
  MongoDBFactStore,
  PROJECT_SCOPE_USER_ID,
  ReservedPrefixError,
} from '../services/stores/index.js';
import {
  MAX_FACT_TTL_MS,
  MAX_KEY_LENGTH,
  MAX_VALUE_SIZE_BYTES,
  MAX_WRITES_PER_RUN,
  startsWithReservedPrefix,
} from '../services/stores/workflow-memory-constants.js';

const log = createLogger('workflow-memory');

/** Projection payload cap (256 KiB) per HLD Concern #9. */
const DEFAULT_PROJECTION_PAYLOAD_CAP_BYTES = 256 * 1024;

/** Per-run write counter Redis TTL (24 hours) — runs that overshoot are exceptional. */
const RUN_COUNTER_TTL_SECONDS = 24 * 60 * 60;

/**
 * Minimal contract the route uses on the Redis client. Allows tests to
 * inject an in-process counter without importing ioredis or running a
 * real Redis server.
 */
export interface MemoryRouteRedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | unknown>;
}

export interface InternalMemoryRouterDeps {
  /**
   * Redis client used for the per-run write counter. Defaults to the runtime's
   * shared `getRedisClient()` singleton. When the singleton returns `null`
   * the route fails closed with `STORAGE_UNAVAILABLE` (Stateless Distributed
   * Invariant 3 — never a local fallback).
   */
  redisClient?: MemoryRouteRedisClient | null;
  /**
   * Resolver invoked at request time when no `redisClient` is supplied. Lets
   * production code defer the lookup until after `initializeRedis()` runs.
   * Defaults to `getRedisClient`.
   */
  redisClientResolver?: () => MemoryRouteRedisClient | null;
  /** Logger override — defaults to the module-level `workflow-memory` logger. */
  logger?: Logger;
}

// =============================================================================
// SCHEMAS
// =============================================================================

const scopeSchema = z.enum(['workflow', 'project', 'user']);
const actorSchema = z
  .object({
    kind: z.enum(['workflow-author', 'end-user']),
    endUserId: z.string().min(1).optional(),
  })
  .strict();

const projectionSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    workflowId: z.string().min(1),
    endUserId: z.string().min(1).optional(),
  })
  .strict();

const getSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    scope: scopeSchema,
    key: z.string().min(1),
    endUserId: z.string().min(1).optional(),
  })
  .strict();

// `endUserId` at top level is redundant with `actor.endUserId` for set/delete
// (the route reads only `actor.endUserId` for the user-scope branch). It is
// declared here because `RuntimeMemoryClient.buildOpBody` in workflow-engine
// includes it on the wire for end-user runs; strict mode would otherwise
// reject every Phase 4 end-user set/delete call.
const setSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    actor: actorSchema,
    scope: scopeSchema,
    key: z.string().min(1),
    value: z.unknown(),
    ttl: z.string().min(1).optional(),
    endUserId: z.string().min(1).optional(),
  })
  .strict();

const deleteSchema = z
  .object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
    actor: actorSchema,
    scope: scopeSchema,
    key: z.string().min(1),
    endUserId: z.string().min(1).optional(),
  })
  .strict();

// =============================================================================
// ERROR ENVELOPE
// =============================================================================

type WorkflowMemoryErrorCode =
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
  | 'INTERNAL';

class WorkflowMemoryError extends Error {
  constructor(
    public readonly code: WorkflowMemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowMemoryError';
  }
}

function statusForCode(code: WorkflowMemoryErrorCode): number {
  switch (code) {
    case 'INVALID_BODY':
    case 'RESERVED_PREFIX':
    case 'QUOTA_KEY_LENGTH':
    case 'QUOTA_VALUE_SIZE':
    case 'QUOTA_WRITE_COUNT':
    case 'TTL_INVALID':
    case 'INVALID_VALUE':
    case 'UNAVAILABLE_SCOPE':
    case 'PROJECTION_TOO_LARGE':
      return 400;
    case 'STORAGE_UNAVAILABLE':
      return 503;
    case 'INTERNAL':
    default:
      return 500;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

interface OpTraceFields {
  tenantId: string;
  projectId: string;
  workflowId: string;
  runId?: string;
  scope?: 'workflow' | 'project' | 'user';
  key?: string;
  op: 'projection_load' | 'set' | 'get' | 'delete';
  durationMs: number;
  ttlMs?: number;
  result: 'ok' | 'error';
  errorCode?: string;
}

function emitTrace(event: 'projection_load' | 'memory_op', fields: OpTraceFields): void {
  log.info(`trace:${event}`, { ...fields });
}

interface AuditFields {
  tenantId: string;
  projectId: string;
  workflowId: string;
  runId: string;
  scope: 'workflow' | 'project' | 'user';
  key: string;
  actor: z.infer<typeof actorSchema>;
  op: 'set' | 'delete';
  appliedTtlMs?: number;
  tombstone?: boolean;
}

/** Audit log helper — never logs `value`. */
function emitAudit(fields: AuditFields): void {
  log.info('memory_op', { ...fields });
}

/**
 * Parses and clamps a TTL string (`'5d'`, `'1h'`, `'30m'`, `'60s'`, or a
 * numeric milliseconds literal). Returns `{ appliedMs, clamped }`.
 *
 * Throws `WorkflowMemoryError('TTL_INVALID', ...)` for unparseable input.
 * Returns `null` when no TTL was supplied (caller falls back to the
 * `MongoDBFactStore` default of 90d).
 */
export function parseAndClampTtl(ttl: string | undefined): {
  appliedMs: number;
  clamped: boolean;
} | null {
  if (ttl === undefined) return null;

  let parsedMs: number | null = null;
  const match = ttl.trim().match(/^(\d+)(d|h|m|s)?$/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (!Number.isFinite(num) || num <= 0) {
      throw new WorkflowMemoryError('TTL_INVALID', `Invalid TTL: '${ttl}'`);
    }
    const unit = match[2];
    switch (unit) {
      case 'd':
        parsedMs = num * 24 * 60 * 60 * 1000;
        break;
      case 'h':
        parsedMs = num * 60 * 60 * 1000;
        break;
      case 'm':
        parsedMs = num * 60 * 1000;
        break;
      case 's':
        parsedMs = num * 1000;
        break;
      default:
        // Bare number — interpret as milliseconds
        parsedMs = num;
        break;
    }
  } else {
    throw new WorkflowMemoryError('TTL_INVALID', `Invalid TTL: '${ttl}'`);
  }

  if (parsedMs === null || parsedMs <= 0) {
    throw new WorkflowMemoryError('TTL_INVALID', `Invalid TTL: '${ttl}'`);
  }

  if (parsedMs > MAX_FACT_TTL_MS) {
    return { appliedMs: MAX_FACT_TTL_MS, clamped: true };
  }
  return { appliedMs: parsedMs, clamped: false };
}

/**
 * Validates an author-supplied key against quotas + reserved prefixes. Throws
 * the appropriate `WorkflowMemoryError` on violation. Returns nothing on success.
 */
function validateAuthorKey(key: string): void {
  if (key.length > MAX_KEY_LENGTH) {
    throw new WorkflowMemoryError(
      'QUOTA_KEY_LENGTH',
      `Key exceeds ${MAX_KEY_LENGTH} characters (got ${key.length})`,
    );
  }
  if (startsWithReservedPrefix(key)) {
    throw new WorkflowMemoryError(
      'RESERVED_PREFIX',
      `Key '${key}' uses a reserved prefix (wf:/_meta:/_system:/_audit:)`,
    );
  }
}

/**
 * Increments the per-run write counter via Redis. Throws
 * `STORAGE_UNAVAILABLE` when Redis is unavailable (fail-closed per the
 * Stateless Distributed Invariant). Throws `QUOTA_WRITE_COUNT` when the
 * counter exceeds `MAX_WRITES_PER_RUN`.
 *
 * Restate replay caveat (tracked as GAP-020 in the feature spec):
 *   The runId is stable across Restate retries — `ctx.key` is the same
 *   value every attempt. Memory writes are NOT journaled by Restate
 *   (they go through the workflow-engine memory client, not via
 *   `ctx.run`), so a run that wrote N times before a failure and then
 *   retries will increment the counter another N+ times on replay.
 *   Worst case: a run that legitimately performs `MAX_WRITES_PER_RUN`
 *   writes and crashes mid-run can hit `QUOTA_WRITE_COUNT` on the
 *   retry. The counter TTL (24h) bounds the leak.
 *   Authors should treat memory.set as idempotent (rewriting the same
 *   key is fine — no extra storage) and keep total writes/run well
 *   below the cap so replay headroom remains. v1.1 will revisit by
 *   either (a) journaling writes via `ctx.run` so replay short-circuits
 *   to the prior result without re-incrementing, or (b) per-attempt
 *   counter keys keyed on `runId + attemptNumber`.
 */
async function bumpRunWriteCounter(
  redis: MemoryRouteRedisClient | null,
  runId: string,
): Promise<void> {
  if (!redis) {
    throw new WorkflowMemoryError(
      'STORAGE_UNAVAILABLE',
      'Per-run write counter unavailable: Redis is not connected',
    );
  }

  const key = `workflow-memory:run-writes:${runId}`;
  let count: number;
  try {
    // INCR returns the post-increment value. EXPIRE on every call is cheap
    // and refreshes the TTL so the counter survives bursty runs.
    count = await redis.incr(key);
    await redis.expire(key, RUN_COUNTER_TTL_SECONDS);
  } catch (err) {
    throw new WorkflowMemoryError(
      'STORAGE_UNAVAILABLE',
      `Per-run write counter Redis call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (count > MAX_WRITES_PER_RUN) {
    throw new WorkflowMemoryError(
      'QUOTA_WRITE_COUNT',
      `Run ${runId} exceeded the per-run write quota (${MAX_WRITES_PER_RUN})`,
    );
  }
}

/**
 * Serialize a value to JSON; throws `INVALID_VALUE` when not serializable
 * (BigInt, circular reference, etc.). Caps at `MAX_VALUE_SIZE_BYTES`.
 */
function serializeAndCheckSize(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new WorkflowMemoryError(
      'INVALID_VALUE',
      `Value is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (serialized === undefined) {
    throw new WorkflowMemoryError('INVALID_VALUE', 'Value serialized to undefined');
  }
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_VALUE_SIZE_BYTES) {
    throw new WorkflowMemoryError(
      'QUOTA_VALUE_SIZE',
      `Value exceeds ${MAX_VALUE_SIZE_BYTES} bytes (got ${size})`,
    );
  }
  return serialized;
}

function buildWorkflowAdapter(tenantId: string, projectId: string, workflowId: string) {
  return new FactStoreWorkflowAdapter({ type: 'mongodb' }, tenantId, projectId, workflowId);
}

function buildProjectStore(tenantId: string, projectId: string) {
  return new MongoDBFactStore(
    { type: 'mongodb' },
    tenantId,
    PROJECT_SCOPE_USER_ID,
    projectId,
    'project',
  );
}

function buildUserStore(tenantId: string, endUserId: string, projectId: string) {
  return new MongoDBFactStore({ type: 'mongodb' }, tenantId, endUserId, projectId, 'user');
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * Construct a memory router. Defaults wire the production `getRedisClient`;
 * tests inject an in-process Redis substitute (or a real ioredis client
 * scoped to a `MongoMemoryServer`-style harness).
 */
export function createInternalMemoryRouter(deps: InternalMemoryRouterDeps = {}): Router {
  const router: Router = Router();
  const resolveRedis = (): MemoryRouteRedisClient | null => {
    if (deps.redisClient !== undefined) return deps.redisClient;
    const resolver = deps.redisClientResolver ?? getRedisClient;
    return (resolver() as MemoryRouteRedisClient | null) ?? null;
  };

  router.post('/projection', async (req: Request, res: Response) => {
    const started = Date.now();
    const serviceToken = (req as InternalServiceRequest).serviceToken;
    const parsed = projectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'projection body failed validation',
          details: parsed.error.issues,
        },
      });
      return;
    }
    const { tenantId, projectId, workflowId, endUserId } = parsed.data;
    const tokenError = rejectIfTokenMismatch(serviceToken, { tenantId, projectId });
    if (tokenError) {
      res.status(403).json({ success: false, error: tokenError });
      return;
    }

    try {
      const projectStore = buildProjectStore(tenantId, projectId);

      // workflow facts: query `wf:<workflowId>:` prefix on the project-scope store
      const workflowDocs = await projectStore.query({
        prefix: `wf:${workflowId}:`,
        limit: 1000,
      });
      const workflow: Record<string, unknown> = {};
      const workflowKeyPrefix = `wf:${workflowId}:`;
      for (const fact of workflowDocs) {
        const authorKey = fact.key.slice(workflowKeyPrefix.length);
        workflow[authorKey] = fact.value;
      }

      // project facts: everything that does NOT start with `wf:`. The
      // `keyNotPrefix` filter excludes wf:* server-side so a project with
      // many wf:* docs can't push real project-scope facts past the
      // limit: 1000 cursor and silently drop them from the projection.
      const projectDocs = await projectStore.query({ limit: 1000, keyNotPrefix: 'wf:' });
      const project: Record<string, unknown> = {};
      for (const fact of projectDocs) {
        project[fact.key] = fact.value;
      }

      let user: Record<string, unknown> | undefined;
      if (endUserId) {
        const userStore = buildUserStore(tenantId, endUserId, projectId);
        const userDocs = await userStore.query({ limit: 1000 });
        user = {};
        for (const fact of userDocs) {
          user[fact.key] = fact.value;
        }
      }

      const payload = { workflow, project, user };
      const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      if (payloadSize > DEFAULT_PROJECTION_PAYLOAD_CAP_BYTES) {
        throw new WorkflowMemoryError(
          'PROJECTION_TOO_LARGE',
          `Projection size ${payloadSize} bytes exceeds cap ${DEFAULT_PROJECTION_PAYLOAD_CAP_BYTES}`,
        );
      }

      const durationMs = Date.now() - started;
      emitTrace('projection_load', {
        tenantId,
        projectId,
        workflowId,
        op: 'projection_load',
        durationMs,
        result: 'ok',
      });
      log.debug('projection_load_keys', {
        tenantId,
        projectId,
        workflowId,
        counts: {
          workflow: Object.keys(workflow).length,
          project: Object.keys(project).length,
          user: user ? Object.keys(user).length : 0,
        },
        payloadBytes: payloadSize,
      });

      res.status(200).json({ success: true, data: payload });
    } catch (err) {
      handleError(res, err, {
        tenantId,
        projectId,
        workflowId,
        op: 'projection_load',
        durationMs: Date.now() - started,
      });
    }
  });

  /**
   * POST /get
   * Reads a single fact from `workflow` | `project` | `user` scope.
   */
  router.post('/get', async (req: Request, res: Response) => {
    const started = Date.now();
    const serviceToken = (req as InternalServiceRequest).serviceToken;
    const parsed = getSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'get body failed validation',
          details: parsed.error.issues,
        },
      });
      return;
    }
    const { tenantId, projectId, workflowId, runId, scope, key, endUserId } = parsed.data;
    const tokenError = rejectIfTokenMismatch(serviceToken, { tenantId, projectId });
    if (tokenError) {
      res.status(403).json({ success: false, error: tokenError });
      return;
    }

    try {
      if (scope === 'user' && !endUserId) {
        throw new WorkflowMemoryError('UNAVAILABLE_SCOPE', 'User scope requires endUserId');
      }
      validateAuthorKey(key);

      let value: unknown;
      if (scope === 'workflow') {
        const adapter = buildWorkflowAdapter(tenantId, projectId, workflowId);
        const fact = await adapter.getWorkflowKey(key);
        value = fact ? fact.value : undefined;
      } else if (scope === 'project') {
        const store = buildProjectStore(tenantId, projectId);
        const fact = await store.get({ key });
        value = fact ? fact.value : undefined;
      } else {
        // user scope. The guard at line 527 guarantees endUserId is set
        // when scope === 'user'; assign to a narrowed local so TS doesn't
        // need a non-null assertion (see CLAUDE.md "no non-null assertions").
        if (!endUserId) {
          throw new WorkflowMemoryError(
            'UNAVAILABLE_SCOPE',
            'User scope reached read path with no endUserId — guard above did not narrow',
          );
        }
        const store = buildUserStore(tenantId, endUserId, projectId);
        const fact = await store.get({ key });
        value = fact ? fact.value : undefined;
      }

      emitTrace('memory_op', {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'get',
        durationMs: Date.now() - started,
        result: 'ok',
      });

      res.status(200).json({ success: true, data: { value } });
    } catch (err) {
      handleError(res, err, {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'get',
        durationMs: Date.now() - started,
      });
    }
  });

  /**
   * POST /set
   * Writes a single fact. Enforces reserved prefix, quotas, TTL clamp, and
   * audit. Per-run write counter via Redis.
   */
  router.post('/set', async (req: Request, res: Response) => {
    const started = Date.now();
    const serviceToken = (req as InternalServiceRequest).serviceToken;
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'set body failed validation',
          details: parsed.error.issues,
        },
      });
      return;
    }
    const { tenantId, projectId, workflowId, runId, scope, key, value, ttl, actor } = parsed.data;
    const tokenError = rejectIfTokenMismatch(serviceToken, { tenantId, projectId });
    if (tokenError) {
      res.status(403).json({ success: false, error: tokenError });
      return;
    }

    try {
      // 1. Reserved-prefix guard FIRST — even before quota checks. Authors must
      //    never write under reserved namespaces; the `wf:` deep guard in
      //    `MongoDBFactStore._setInternal` is the secondary net.
      validateAuthorKey(key);

      // 2. Scope availability — `user` requires `endUserId` from the actor envelope.
      let userIdForStore: string | undefined;
      if (scope === 'user') {
        if (actor.kind !== 'end-user' || !actor.endUserId) {
          throw new WorkflowMemoryError(
            'UNAVAILABLE_SCOPE',
            'User scope requires actor.kind=end-user with endUserId',
          );
        }
        userIdForStore = actor.endUserId;
      }

      // 3. Value size + canonicalization. JSON-roundtrip ONCE here:
      //    serializeAndCheckSize validates size and canonicalizes the value
      //    (drops undefined fields, normalizes Dates), then we parse a
      //    single time to reuse across the three persistence branches
      //    below. Avoids an O(n) parse per branch on the hot path.
      const serializedValue = serializeAndCheckSize(value);
      const canonicalValue: unknown = JSON.parse(serializedValue);

      // 4. TTL parse + clamp. Run BEFORE the per-run write counter so an
      //    invalid TTL (TTL_INVALID) doesn't burn one of the run's
      //    MAX_WRITES_PER_RUN slots — the request never persists, so it
      //    shouldn't count.
      const ttlOutcome = parseAndClampTtl(ttl);
      const appliedTtlMs = ttlOutcome?.appliedMs;

      // 5. Per-run write counter (Redis INCR). Counts only requests that
      //    have passed every prior validation gate, so authors can't lock
      //    themselves out by submitting 100 invalid TTLs / oversized
      //    values / reserved-prefix keys — those reject before incrementing.
      await bumpRunWriteCounter(resolveRedis(), runId);

      // 6. Persistence.
      if (scope === 'workflow') {
        const adapter = buildWorkflowAdapter(tenantId, projectId, workflowId);
        await adapter.setWorkflowKey(key, canonicalValue, {
          ttlMs: appliedTtlMs,
          source: { type: 'system', traceId: runId },
        });
      } else if (scope === 'project') {
        const store = buildProjectStore(tenantId, projectId);
        await store.set({
          key,
          value: canonicalValue,
          ttlMs: appliedTtlMs,
          source: { type: 'system', traceId: runId },
        });
      } else {
        if (!userIdForStore) {
          throw new WorkflowMemoryError(
            'UNAVAILABLE_SCOPE',
            'User scope reached persistence layer with no endUserId — guard above did not narrow',
          );
        }
        const store = buildUserStore(tenantId, userIdForStore, projectId);
        await store.set({
          key,
          value: canonicalValue,
          ttlMs: appliedTtlMs,
          source: { type: 'system', traceId: runId },
        });
      }

      // 7. Audit + trace.
      emitAudit({
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        actor,
        op: 'set',
        appliedTtlMs,
      });
      if (ttlOutcome?.clamped) {
        emitTrace('memory_op', {
          tenantId,
          projectId,
          workflowId,
          runId,
          scope,
          key,
          op: 'set',
          durationMs: 0,
          result: 'ok',
          errorCode: 'ttl_clamped',
        });
        log.warn('ttl_clamped', {
          tenantId,
          projectId,
          workflowId,
          runId,
          scope,
          key,
          appliedTtlMs,
        });
      }
      emitTrace('memory_op', {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'set',
        ttlMs: appliedTtlMs,
        durationMs: Date.now() - started,
        result: 'ok',
      });

      res.status(200).json({ success: true, data: { ok: true, appliedTtlMs } });
    } catch (err) {
      // The `_setInternal` deep guard throws `ReservedPrefixError`; map it to
      // the route-layer envelope code.
      if (err instanceof ReservedPrefixError) {
        const wrapped = new WorkflowMemoryError('RESERVED_PREFIX', err.message);
        handleError(res, wrapped, {
          tenantId,
          projectId,
          workflowId,
          runId,
          scope,
          key,
          op: 'set',
          durationMs: Date.now() - started,
        });
        return;
      }
      handleError(res, err, {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'set',
        durationMs: Date.now() - started,
      });
    }
  });

  /**
   * POST /delete
   * Tombstones a fact. Audit emits `op: 'delete', tombstone: true` on success.
   */
  router.post('/delete', async (req: Request, res: Response) => {
    const started = Date.now();
    const serviceToken = (req as InternalServiceRequest).serviceToken;
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'delete body failed validation',
          details: parsed.error.issues,
        },
      });
      return;
    }
    const { tenantId, projectId, workflowId, runId, scope, key, actor } = parsed.data;
    const tokenError = rejectIfTokenMismatch(serviceToken, { tenantId, projectId });
    if (tokenError) {
      res.status(403).json({ success: false, error: tokenError });
      return;
    }

    try {
      validateAuthorKey(key);

      let userIdForStore: string | undefined;
      if (scope === 'user') {
        if (actor.kind !== 'end-user' || !actor.endUserId) {
          throw new WorkflowMemoryError(
            'UNAVAILABLE_SCOPE',
            'User scope requires actor.kind=end-user with endUserId',
          );
        }
        userIdForStore = actor.endUserId;
      }

      let tombstoned: boolean;
      if (scope === 'workflow') {
        const adapter = buildWorkflowAdapter(tenantId, projectId, workflowId);
        tombstoned = await adapter.deleteWorkflowKey(key);
      } else if (scope === 'project') {
        const store = buildProjectStore(tenantId, projectId);
        tombstoned = await store.delete(key);
      } else {
        if (!userIdForStore) {
          throw new WorkflowMemoryError(
            'UNAVAILABLE_SCOPE',
            'User scope reached delete path with no endUserId — guard above did not narrow',
          );
        }
        const store = buildUserStore(tenantId, userIdForStore, projectId);
        tombstoned = await store.delete(key);
      }

      emitAudit({
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        actor,
        op: 'delete',
        tombstone: true,
      });
      emitTrace('memory_op', {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'delete',
        durationMs: Date.now() - started,
        result: 'ok',
      });

      res.status(200).json({ success: true, data: { tombstoned } });
    } catch (err) {
      handleError(res, err, {
        tenantId,
        projectId,
        workflowId,
        runId,
        scope,
        key,
        op: 'delete',
        durationMs: Date.now() - started,
      });
    }
  });

  // =============================================================================
  // ERROR HANDLER
  // =============================================================================

  interface ErrorTraceContext {
    tenantId: string;
    projectId: string;
    workflowId: string;
    runId?: string;
    scope?: 'workflow' | 'project' | 'user';
    key?: string;
    op: 'projection_load' | 'set' | 'get' | 'delete';
    durationMs: number;
  }

  function handleError(res: Response, err: unknown, ctx: ErrorTraceContext): void {
    if (err instanceof WorkflowMemoryError) {
      emitTrace(ctx.op === 'projection_load' ? 'projection_load' : 'memory_op', {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        workflowId: ctx.workflowId,
        runId: ctx.runId,
        scope: ctx.scope,
        key: ctx.key,
        op: ctx.op,
        durationMs: ctx.durationMs,
        result: 'error',
        errorCode: err.code,
      });
      res.status(statusForCode(err.code)).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
      return;
    }

    // Unhandled — log and return INTERNAL.
    const message = err instanceof Error ? err.message : String(err);
    log.error('memory_op_internal_error', { ctx, error: message });
    emitTrace(ctx.op === 'projection_load' ? 'projection_load' : 'memory_op', {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      scope: ctx.scope,
      key: ctx.key,
      op: ctx.op,
      durationMs: ctx.durationMs,
      result: 'error',
      errorCode: 'INTERNAL',
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL', message: 'Internal error processing memory operation' },
    });
  }

  return router;
}

/**
 * Default export — production router wired against the runtime's shared
 * Redis client singleton (initialised by `initializeRedis()` at startup).
 */
const router: Router = createInternalMemoryRouter();
export default router;
