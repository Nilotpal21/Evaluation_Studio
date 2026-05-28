/**
 * Workflow Callback Routes
 *
 * POST /api/v1/workflows/callbacks/:executionId/:stepId
 *
 * Resolves a Restate durable promise with the callback payload.
 * Used by the async_webhook step executor -- it registers a callback URL,
 * then pauses until the external system POSTs back here.
 */

import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { verifyWebhookSignature } from '@agent-platform/shared-kernel/security';
import { CALLBACK_REPLAY_TOLERANCE_MS } from '../constants.js';
import type { MongooseModelLike } from '../persistence/execution-store.js';
import type { RestateWorkflowClient } from '../services/restate-client.js';
import { asyncHandler } from '../lib/route-helpers.js';
// NOTE: `rejectBlockedWebhookSource` is intentionally NOT used on this route.
// That guard blocks private-IP source addresses on EXTERNAL webhook endpoints
// (webhooks.ts, connector-webhooks.ts). The workflow-callbacks route is the
// opposite: it is consumed by internal worker pods (search-ai, etc.) whose
// source IPs are always private (Docker bridge 172.x.x.x, K8s pod 10.x.x.x).
// Authentication on this route is HMAC verification + timestamp replay-window
// + step.status === 'waiting_callback' — not IP allowlisting.

const log = createLogger('workflow-engine:callbacks');

// ─── Per-execution-ID rate limiter (SEC-4 fix) ─────────────────────────────
// In K8s, all internal workers typically share 3-5 source IPs (Docker bridge /
// pod CIDR). A per-IP limiter is useless: legitimate callers consume all buckets
// and a malicious pod on a new IP bypasses history entirely.
//
// Per-execution-ID limiting is correct: each real callback fires exactly once
// per step (ADI / Docling / approval → one POST per step per execution). A burst
// of POSTs to the same executionId is always an anomaly. Defaults: 20 requests
// per execution per 60 s — covers HMAC retries (up to 5) with generous headroom.
const CALLBACK_RATE_LIMIT_WINDOW_MS = 60_000;
const CALLBACK_RATE_LIMIT_MAX = 20;
const MAX_CALLBACK_RATE_LIMIT_BUCKETS = 4096;

interface RateBucket {
  count: number;
  windowStart: number;
  lastSeen: number;
}
const callbackRateBuckets = new Map<string, RateBucket>();

function evictOldestCallbackBucket(): void {
  let oldest: [string, RateBucket] | undefined;
  for (const entry of callbackRateBuckets.entries()) {
    if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry;
  }
  if (oldest) callbackRateBuckets.delete(oldest[0]);
}

export function createCallbackRateLimit(): RequestHandler {
  return (req, res, next) => {
    // Key on executionId from the URL path (both /t/:tenantId/:execId/:stepId and /:execId/:stepId).
    // Fall back to remote address if the param isn't parsed yet (shouldn't happen in practice).
    const parts = req.path.split('/').filter(Boolean);
    const execId =
      parts[0] === 't' && parts.length >= 4
        ? parts[2] // /t/:tenantId/:executionId/:stepId — parts[2] is executionId
        : (parts[0] ?? req.socket.remoteAddress ?? 'unknown'); // /:executionId/:stepId
    const now = Date.now();
    let bucket = callbackRateBuckets.get(execId);
    if (!bucket || now - bucket.windowStart >= CALLBACK_RATE_LIMIT_WINDOW_MS) {
      if (callbackRateBuckets.size >= MAX_CALLBACK_RATE_LIMIT_BUCKETS) evictOldestCallbackBucket();
      bucket = { count: 0, windowStart: now, lastSeen: now };
      callbackRateBuckets.set(execId, bucket);
    }
    bucket.count += 1;
    bucket.lastSeen = now;
    if (bucket.count > CALLBACK_RATE_LIMIT_MAX) {
      log.warn('callbacks.rate_limit_exceeded', { execId, count: bucket.count });
      res
        .status(429)
        .json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return;
    }
    next();
  };
}

/** Step entry read from context.steps for callback verification. */
interface CallbackStepEntry {
  status?: string;
  stepId?: string;
  callbackSecret?: string;
  /** Restate awakeable ID — present on connector_action steps using the awakeable experiment path. */
  awakeableId?: string;
  /** Relay-race: true when this step was parked by executeWorkflow() (no awakeable). */
  parkPoint?: boolean;
  /** Relay-race: successor step IDs stored at park time — used to trigger the next leg. */
  nextStepIds?: string[];
  /** Relay-race: which parallel branch this step belongs to. */
  branchId?: string;
  /** Phase 4: join step ID for barrier check when this branch resumes. */
  joinStepId?: string;
  /** Phase 4: barrier total for the resumed branch leg. */
  barrierTotal?: number;
  /** Phase 5: failure strategy carried to resumed branch leg. */
  failureStrategy?: 'fail_fast' | 'wait_all' | 'ignore_errors';
}

/** Execution document shape the callback route reads. */
interface CallbackExecutionDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  context?: {
    steps?: Record<string, CallbackStepEntry>;
  };
}

/** Mongoose-like model for WorkflowExecution */
export type CallbackExecutionModel = Pick<MongooseModelLike<CallbackExecutionDoc>, 'findOne'>;

/** Restate client for resolving durable promises, awakeables, or relay-race runs */
export type CallbackRestateClient = Pick<
  RestateWorkflowClient,
  'resolveCallback' | 'resolveAwakeable' | 'startWorkflow'
>;

export interface DecryptFn {
  (encrypted: string, tenantId: string): Promise<string>;
}

/** Minimal persistence interface needed by the callback route for relay-race path. */
export interface CallbackPersistence {
  resolveParkedStep(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    expectedStatus: string,
    result: { output?: unknown; completedAt?: string },
  ): Promise<boolean>;
}

export interface CallbackRouteDeps {
  executionModel: CallbackExecutionModel;
  restateClient: CallbackRestateClient;
  decryptSecret: DecryptFn;
  /** Optional — wired for relay-race path. Falls back to awakeable/promise resolution if absent. */
  persistence?: CallbackPersistence;
}

export function createCallbackRouter(deps: CallbackRouteDeps): Router {
  const router = Router();

  /**
   * POST /callbacks/t/:tenantId/:executionId/:stepId  (tenant-scoped — preferred)
   * POST /callbacks/:executionId/:stepId              (legacy — backward compat)
   *
   * External system / internal worker posts callback payload here.
   * HMAC signature with per-execution callbackSecret is the auth boundary.
   */

  // Shared handler used by both route patterns.
  async function handleCallback(
    req: Request,
    res: Response,
    executionId: string,
    stepId: string,
    scopedTenantId?: string,
  ): Promise<Response> {
    // 1. Load execution. When tenantId is present in the URL (new path) scope the
    //    query so cross-tenant enumeration is impossible even when execution IDs
    //    are guessed (SEC-1). Legacy path keeps unscoped lookup for backward compat.
    const filter: Record<string, unknown> = scopedTenantId
      ? { _id: executionId, tenantId: scopedTenantId }
      : { _id: executionId };
    const execution = await deps.executionModel.findOne(filter);

    if (!execution) {
      return res.status(404).json({ error: 'Not found' });
    }

    const step = Object.values(execution.context?.steps ?? {}).find((s) => s.stepId === stepId);
    if (!step) {
      return res.status(404).json({ error: 'Step not found' });
    }

    if (step.status !== 'waiting_callback') {
      return res.status(409).json({ error: 'Step is not waiting for callback' });
    }

    // SEC-7: application-level payload validation — reject obviously malformed bodies
    // before doing any crypto work. Guards against deeply-nested JSON DoS payloads.
    const body = req.body as unknown;
    if (body !== null && body !== undefined) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Callback body must be a JSON object' });
      }
      const bodyStr = JSON.stringify(body);
      if (bodyStr.length > 5 * 1024 * 1024) {
        // Express body-parser already enforces ADI_CALLBACK_BODY_LIMIT (12 MB),
        // but add a tighter application-level cap (5 MB) to reduce MongoDB write size.
        return res.status(413).json({ error: 'Callback body exceeds 5 MB application limit' });
      }
    }

    // 2. HMAC signature verification — MANDATORY for all callbacks.
    // SECURITY: callbackSecret must exist; without it the callback is rejected.
    if (!step.callbackSecret) {
      log.warn('Callback rejected: step has no callbackSecret configured', {
        executionId,
        stepId,
      });
      return res
        .status(401)
        .json({ error: 'Callback authentication not configured', code: 'CALLBACK_SECRET_MISSING' });
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      log.warn('Callback rejected: raw body not captured', { executionId, stepId });
      return res.status(400).json({ error: 'Unable to verify callback: missing body' });
    }

    const signature = getHeader(req.headers, 'x-callback-signature', 'x-webhook-signature');
    if (!signature) {
      log.warn('Callback rejected: missing signature header', { executionId, stepId });
      return res.status(401).json({ error: 'Missing signature', code: 'SIGNATURE_MISSING' });
    }

    // 3. Replay protection + HMAC verification — MANDATORY
    const timestamp = getHeader(req.headers, 'x-callback-timestamp', 'x-webhook-timestamp');
    if (!timestamp) {
      log.warn('Callback rejected: missing timestamp header', { executionId, stepId });
      return res
        .status(401)
        .json({ error: 'Missing x-callback-timestamp header', code: 'TIMESTAMP_MISSING' });
    }
    {
      // Split timestamp-tolerance from signature-mismatch so the worker can
      // distinguish clock-skew failures (TIMESTAMP_EXPIRED) from authentic
      // signature failures (SIGNATURE_INVALID) — Phase 4 / Round-7 callback
      // poster error_class dimension. `verifyWebhookSignature` collapses both
      // into a single boolean, so we check the tolerance window first.
      const tsNum = parseInt(String(timestamp), 10);
      const toleranceSeconds = Math.floor(CALLBACK_REPLAY_TOLERANCE_MS / 1000);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > toleranceSeconds) {
        log.warn('Callback rejected: timestamp out of tolerance', {
          executionId,
          stepId,
          timestamp,
        });
        return res
          .status(401)
          .json({ error: 'Timestamp out of tolerance', code: 'TIMESTAMP_EXPIRED' });
      }

      const secret = await deps.decryptSecret(step.callbackSecret, execution.tenantId);
      const rawBodyText = rawBody.toString('utf8');
      const normalizedSignature = normalizeSignature(signature);
      const isSignatureValid = verifyWebhookSignature(
        secret,
        rawBodyText,
        normalizedSignature,
        String(timestamp),
        toleranceSeconds,
      );
      if (!isSignatureValid) {
        log.warn('Callback rejected: invalid signature', { executionId, stepId });
        return res.status(401).json({ error: 'Invalid signature', code: 'SIGNATURE_INVALID' });
      }
    }

    // 4. Resolve the Restate suspension — tri-path for backward compatibility.
    //
    // Path A (relay-race): step.parkPoint === true
    //   Write result to MongoDB, then trigger the next relay run via startWorkflow().
    //   No Restate awakeable or durable promise involved — avoids the 1.6.2 bug.
    //
    // Path B (awakeable): step.awakeableId is set
    //   Resolve via /restate/awakeables/:id/resolve (bypasses shared-handler dispatch).
    //
    // Path C (legacy): neither parkPoint nor awakeableId
    //   Resolve via resolveCallback shared handler (oldest path).
    try {
      if (step.parkPoint && deps.persistence) {
        // Find the step key (the key in context.steps, which is the step name)
        const stepKey = Object.keys(execution.context?.steps ?? {}).find(
          (k) => (execution.context?.steps ?? {})[k]?.stepId === stepId,
        );
        if (!stepKey) {
          return res.status(404).json({ error: 'Step key not found in execution context' });
        }

        const resolved = await deps.persistence.resolveParkedStep(
          executionId,
          execution.tenantId,
          execution.projectId,
          stepKey,
          'waiting_callback',
          { output: req.body ?? {}, completedAt: new Date().toISOString() },
        );
        if (!resolved) {
          log.warn('resolveParkedStep: step already resolved or not in waiting_callback', {
            executionId,
            stepId,
          });
          return res.status(409).json({ error: 'Step is no longer waiting for callback' });
        }

        const nextStepIds: string[] = step.nextStepIds ?? [];
        if (nextStepIds.length > 0) {
          await deps.restateClient.startWorkflow(executionId, {
            tenantId: execution.tenantId,
            projectId: execution.projectId,
            startFromStepIds: nextStepIds,
            branchId: step.branchId,
            resumeStepId: stepId,
            joinStepId: step.joinStepId,
            barrierTotal: step.barrierTotal,
            failureStrategy: step.failureStrategy,
          });
        }
        log.info('Relay-race callback resolved — next leg triggered', {
          executionId,
          stepId,
          nextStepIds,
        });
      } else if (step.awakeableId) {
        await deps.restateClient.resolveAwakeable(step.awakeableId, req.body ?? {});
      } else {
        await deps.restateClient.resolveCallback(executionId, stepId, req.body ?? {});
      }
    } catch (err: unknown) {
      log.error('Failed to resolve workflow callback', {
        executionId,
        stepId,
        parkPoint: step.parkPoint,
        awakeableId: step.awakeableId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(503).json({ error: 'Workflow engine unavailable' });
    }

    return res.json({ ok: true });
  }

  // Tenant-scoped path (preferred, new callbacks) — findOne includes tenantId (SEC-1).
  router.post(
    '/t/:tenantId/:executionId/:stepId',
    asyncHandler(async (req: Request, res: Response) => {
      const { tenantId, executionId, stepId } = req.params;
      return handleCallback(req, res, executionId, stepId, tenantId);
    }),
  );

  // Legacy path — unscoped findOne, kept for backward compatibility with in-flight callbacks.
  // SEC-1: gated behind WORKFLOW_LEGACY_CALLBACKS_ENABLED. Default `true` preserves rollout
  // safety for in-flight executions that registered callbacks pre-migration. Operators must
  // flip the flag to `false` once no pre-migration executions remain in-flight (workflow TTL
  // is the soft deadline). When disabled the route returns 404 so its existence is not leaked.
  const legacyCallbacksEnabled = process.env.WORKFLOW_LEGACY_CALLBACKS_ENABLED !== 'false';
  router.post(
    '/:executionId/:stepId',
    asyncHandler(async (req: Request, res: Response) => {
      if (!legacyCallbacksEnabled) {
        log.warn('callbacks.legacy_path_disabled', { path: req.path });
        return res.status(404).json({ error: 'Not found' });
      }
      log.warn('callbacks.legacy_unscoped_path_used', {
        path: req.path,
        remoteAddress: req.socket.remoteAddress,
      });
      const { executionId, stepId } = req.params;
      return handleCallback(req, res, executionId, stepId);
    }),
  );

  return router;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) continue;
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function normalizeSignature(signature: string): string {
  return String(signature).replace(/^sha256=/i, '');
}
