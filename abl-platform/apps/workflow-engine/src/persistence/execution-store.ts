/**
 * Execution Store
 *
 * Thin persistence wrapper over the WorkflowExecution MongoDB model.
 * All queries include tenantId AND projectId for tenant + project isolation.
 * Implements the ExecutionPersistence interface from the workflow handler.
 */

import type { ClientSession } from 'mongoose';
import type { ExecutionPersistence } from '../handlers/workflow-handler.js';
import type { WorkflowContextData, WorkflowStepData } from '../context/step-context-schema.js';
import { DEFAULT_PAGE_LIMIT } from '../constants.js';
import { computeExecutionExpiresAt } from './workflow-ttl.js';

const TERMINAL_EXECUTION_STATUSES = ['completed', 'failed', 'rejected', 'cancelled'] as const;

// H-1 fix: Prevent MongoDB key injection via user-controlled step names.
// Step names come from the Studio canvas (data.label) and are used as
// dot-notation path components in  /  /  operations.
// A step named "a.b" would be interpreted as a nested path by MongoDB.
function safeStepKey(key: string): string {
  if (/[.$]/.test(key) || key.startsWith('__')) {
    throw new Error(
      `Invalid step key ${key} — step names must not contain ., , or start with __. ` +
        'Rename the workflow step in Studio.',
    );
  }
  return key;
}

/**
 * Chainable Mongoose query shape used by `.find()` callers across the
 * workflow-engine route handlers. Each method returns a narrower chain so
 * callers can mix `.sort().skip().limit().lean()` in the order they need.
 * `TDoc` is the document shape `.lean()` resolves to.
 */
export interface MongoQueryChain<TDoc = unknown> {
  sort(sort: Record<string, unknown>): MongoQueryChain<TDoc>;
  skip(offset: number): MongoQueryChain<TDoc>;
  limit(count: number): MongoQueryChain<TDoc>;
  lean(): Promise<TDoc[]>;
}

/**
 * Canonical Mongoose-like model interface shared across every workflow-engine
 * route that talks to MongoDB. Route files previously declared 5+ overlapping
 * local copies (`ApprovalExecutionModel`, `CallbackExecutionModel`,
 * `HumanTaskExecutionModel`, `WorkflowDefinitionModel`,
 * `NotificationWorkflowModel`, plus the one here) with drifted method sets —
 * only approvals included `countDocuments`, only `ExecutionStore` included
 * `create`/`updateOne` — so a schema-level change would have required fixing
 * 5+ places.
 *
 * Each consumer now `Pick<>`s the method subset it needs and parameterizes
 * `TDoc` with its domain-specific document shape (approval execution,
 * callback execution, workflow definition, notification workflow, etc.) so
 * `findOne`/`find` still return properly narrowed types.
 */
export interface MongooseModelLike<TDoc = unknown> {
  create(doc: Record<string, unknown>): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  findOne(
    filter: Record<string, unknown>,
    projection?: Record<string, unknown>,
  ): Promise<TDoc | null>;
  find(filter: Record<string, unknown>): MongoQueryChain<TDoc>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
}

/**
 * Optional persistence call options. `session` threads a Mongoose
 * ClientSession through the underlying `updateOne`/`findOneAndUpdate`
 * operations so the caller can group the write into an outer
 * `withTransaction` scope alongside outbox writes. See LLD §3.2.
 */
export interface ExecutionStoreOptions {
  session?: ClientSession;
}

/**
 * Narrow subset used by `ExecutionStore`. Equivalent to the previous
 * `WorkflowExecutionModel` shape; kept as a named `Pick` so call sites
 * continue to import `WorkflowExecutionModel` unchanged.
 */
export type WorkflowExecutionModel = Pick<
  MongooseModelLike,
  'create' | 'updateOne' | 'findOneAndUpdate' | 'findOne' | 'find'
>;

/**
 * Tenant-scoped secret encryption callback. Reserved for future per-step
 * secret storage (e.g. callbackSecret). Wired in production to
 * `encryptForTenantAuto`; tests inject a deterministic stub.
 */
export type EncryptSecretFn = (plaintext: string, tenantId: string) => Promise<string>;

export class ExecutionStore implements ExecutionPersistence {
  constructor(
    private readonly model: WorkflowExecutionModel,
    // Reserved for future per-step secret encryption (e.g. callbackSecret).
    _encryptSecret?: EncryptSecretFn,
  ) {}

  async createExecution(
    input: {
      executionId: string;
      tenantId: string;
      projectId: string;
      workflowId: string;
      workflowVersionId?: string;
      workflowVersion?: string;
      status: string;
      triggerType: string;
      triggerPayload: Record<string, unknown>;
      triggerMetadata?: Record<string, unknown>;
      steps: Array<{
        stepId: string;
        name: string;
        type: string;
        status: string;
        loopConfig?: { mode?: 'sequential' | 'parallel'; concurrencyLimit?: number };
      }>;
      webhookMode?: 'sync' | 'async';
      webhookDelivery?: 'poll' | 'push';
      /** Full WorkflowExecutionInput snapshot — stored for relay-leg cold-start. */
      inputSnapshot?: unknown;
    },
    options?: ExecutionStoreOptions,
  ): Promise<void> {
    // Build initial context so routes can query step status and trigger
    // payload immediately after creation. Trigger payload is not duplicated at
    // the context root; callers should use context.steps.start.input or
    // context.trigger.payload.
    const initialSteps: Record<string, unknown> = {};
    for (const s of input.steps) {
      // Boundary steps (start/end) are always keyed by stepId so WS deltas and
      // polling both use the same key. Other steps use their display name.
      const key = s.stepId === 'start' || s.stepId === 'end' ? s.stepId : (s.name ?? s.stepId);
      if (s.stepId === 'start' && s.status === 'completed') {
        initialSteps[key] = {
          nodeType: s.type,
          status: s.status,
          stepId: s.stepId,
          completedAt: new Date().toISOString(),
          durationMs: 0,
          input: input.triggerPayload,
          output: input.triggerPayload,
        };
      } else {
        initialSteps[key] = {
          nodeType: s.type,
          status: s.status,
          stepId: s.stepId,
          ...(s.loopConfig
            ? {
                input: {
                  ...(s.loopConfig.mode !== undefined ? { mode: s.loopConfig.mode } : {}),
                  ...(s.loopConfig.concurrencyLimit !== undefined
                    ? { concurrencyLimit: s.loopConfig.concurrencyLimit }
                    : {}),
                },
              }
            : {}),
        };
      }
    }
    const initialContext = {
      trigger: {
        type: input.triggerType,
        payload: input.triggerPayload,
        ...(input.triggerMetadata !== undefined ? { metadata: input.triggerMetadata } : {}),
      },
      steps: initialSteps,
    };

    // Use updateOne+upsert instead of create() so Restate replays don't fail
    // with duplicate key errors. On replay the record already exists — upsert
    // simply no-ops the $setOnInsert fields.
    await this.model.updateOne(
      { _id: input.executionId, tenantId: input.tenantId, projectId: input.projectId },
      {
        $setOnInsert: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          workflowId: input.workflowId,
          ...(input.workflowVersionId ? { workflowVersionId: input.workflowVersionId } : {}),
          ...(input.workflowVersion ? { workflowVersion: input.workflowVersion } : {}),
          restateWorkflowId: input.executionId,
          status: input.status,
          triggerType: input.triggerType,
          input: input.triggerPayload,
          triggerMetadata: input.triggerMetadata ?? {},
          ...(input.webhookMode ? { webhookMode: input.webhookMode } : {}),
          ...(input.webhookDelivery ? { webhookDelivery: input.webhookDelivery } : {}),
          context: initialContext,
          startedAt: new Date(),
          runCounter: 0,
          ...(input.inputSnapshot !== undefined ? { inputSnapshot: input.inputSnapshot } : {}),
        },
      },
      // MUST merge (not replace) { upsert: true } with any session — LLD §3.1.
      { upsert: true, ...(options?.session ? { session: options.session } : {}) },
    );
  }

  // ─── Relay-race methods (Phase 1 — additive) ────────────────────────────────

  /**
   * Read the inputSnapshot and current context for a relay leg cold-start.
   * Returns null if the execution does not exist or does not belong to the tenant.
   */
  async getExecutionForLeg(
    executionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{
    status: string;
    inputSnapshot: unknown;
    context: Record<string, unknown>;
    cancelledAt?: Date;
  } | null> {
    const doc = (await this.model.findOne({
      _id: executionId,
      tenantId,
      projectId,
    })) as Record<string, unknown> | null;
    if (!doc) return null;
    return {
      status: doc.status as string,
      inputSnapshot: doc.inputSnapshot,
      context: (doc.context as Record<string, unknown>) ?? {},
      cancelledAt: doc.cancelledAt as Date | undefined,
    };
  }

  /**
   * Lightweight cancellation check used at every step boundary in relay-race legs.
   * Projects only {status, cancelledAt} — avoids fetching inputSnapshot (I-2/I-4).
   */
  async getExecutionCancellationStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<{ status: string; cancelledAt?: Date } | null> {
    const doc = (await this.model.findOne(
      { _id: executionId, tenantId, projectId },
      { status: 1, cancelledAt: 1, _id: 0 },
    )) as Record<string, unknown> | null;
    if (!doc) return null;
    return {
      status: doc.status as string,
      cancelledAt: doc.cancelledAt as Date | undefined,
    };
  }

  /**
   * Atomically increment `context.steps[stepKey].barrierCount` and return
   * the new value. Used by relay-race fan-in: only the leg that sees
   * barrierCount === barrierTotal triggers the downstream step.
   */
  async atomicBarrierIncrement(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
  ): Promise<number> {
    const result = (await this.model.findOneAndUpdate(
      { _id: executionId, tenantId, projectId },
      { $inc: { [`context.steps.${safeStepKey(stepKey)}.barrierCount`]: 1 } },
      { returnDocument: 'after' } as Record<string, unknown>,
    )) as Record<string, unknown> | null;
    const ctx = (result?.context as Record<string, unknown>) ?? {};
    const steps = (ctx.steps as Record<string, Record<string, unknown>>) ?? {};
    return (steps[stepKey]?.barrierCount as number) ?? 0;
  }

  /**
   * Atomically increment `context.steps[stepKey].barrierFailCount`.
   * Used by wait_all / ignore_errors branch legs that failed — the branch still
   * contributes to the barrier count (via atomicBarrierIncrement) but also
   * marks itself failed so the join step leg can decide the workflow outcome.
   */
  async atomicBarrierFailIncrement(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
  ): Promise<number> {
    const result = (await this.model.findOneAndUpdate(
      { _id: executionId, tenantId, projectId },
      { $inc: { [`context.steps.${safeStepKey(stepKey)}.barrierFailCount`]: 1 } },
      { returnDocument: 'after' } as Record<string, unknown>,
    )) as Record<string, unknown> | null;
    const ctx = (result?.context as Record<string, unknown>) ?? {};
    const steps = (ctx.steps as Record<string, Record<string, unknown>>) ?? {};
    return (steps[stepKey]?.barrierFailCount as number) ?? 0;
  }

  /**
   * Initialise the barrier fields on a join step before fan-out legs are
   * triggered. Idempotent — $setOnInsert semantics via $min so a Restate
   * retry of the fan-out leg never resets a partially-decremented counter.
   */
  async initStepBarrier(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    barrierTotal: number,
  ): Promise<void> {
    // G-3 fix: $min would reset barrierCount to 0 if fast branches already incremented it.
    // Use two writes: (1) always set barrierTotal; (2) set barrierCount only if absent.
    await this.model.updateOne(
      { _id: executionId, tenantId, projectId },
      { $set: { [`context.steps.${safeStepKey(stepKey)}.barrierTotal`]: barrierTotal } },
    );
    await this.model.updateOne(
      {
        _id: executionId,
        tenantId,
        projectId,
        [`context.steps.${safeStepKey(stepKey)}.barrierCount`]: { $exists: false },
      },
      { $set: { [`context.steps.${safeStepKey(stepKey)}.barrierCount`]: 0 } },
    );
  }

  /**
   * Write park state for a step that needs an external wait.
   * Called from the relay leg before it returns cleanly.
   * Only writes if execution is not already in a terminal status.
   */
  async parkStep(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    parkData: {
      status: string;
      parkPoint: true;
      branchId?: string;
      callbackSecret?: string;
      /**
       * Step IDs to execute when the external event resolves this park.
       * Stored here so callback/approval/human-task routes can call
       * startWorkflow() without needing to read the full DAG definition.
       */
      nextStepIds?: string[];
      /** Approval rejection path — step IDs to execute when the approver rejects. */
      rejectStepIds?: string[];
      /** Phase 4: join step ID for the resumed leg to run barrier check. */
      joinStepId?: string;
      /** Phase 4: barrier total for the resumed leg. */
      barrierTotal?: number;
      /** Phase 5: failure strategy for resumed branch legs. */
      failureStrategy?: 'fail_fast' | 'wait_all' | 'ignore_errors';
    },
  ): Promise<void> {
    await this.model.findOneAndUpdate(
      {
        _id: executionId,
        tenantId,
        projectId,
        status: { $nin: TERMINAL_EXECUTION_STATUSES },
      },
      {
        $set: {
          [`context.steps.${safeStepKey(stepKey)}.status`]: parkData.status,
          [`context.steps.${safeStepKey(stepKey)}.parkPoint`]: true,
          ...(parkData.branchId !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.branchId`]: parkData.branchId }
            : {}),
          ...(parkData.callbackSecret !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.callbackSecret`]: parkData.callbackSecret }
            : {}),
          ...(parkData.nextStepIds !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.nextStepIds`]: parkData.nextStepIds }
            : {}),
          ...(parkData.rejectStepIds !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.rejectStepIds`]: parkData.rejectStepIds }
            : {}),
          ...(parkData.joinStepId !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.joinStepId`]: parkData.joinStepId }
            : {}),
          ...(parkData.barrierTotal !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.barrierTotal`]: parkData.barrierTotal }
            : {}),
          ...(parkData.failureStrategy !== undefined
            ? {
                [`context.steps.${safeStepKey(stepKey)}.failureStrategy`]: parkData.failureStrategy,
              }
            : {}),
          // Set top-level flag so the stuck-execution sweeper can exclude this
          // execution from force-failing — approval/human-task wait times are
          // designer-configured and unbounded from the sweeper's perspective.
          ...(parkData.status === 'waiting_approval' || parkData.status === 'waiting_human_task'
            ? { hasHumanWait: true }
            : {}),
        },
      },
    );
  }

  /**
   * Resolve a parked step — write the external event result and clear the
   * parkPoint flag. Called by callback/approval/human-task routes BEFORE
   * triggering the next relay leg so the leg reads the completed result.
   *
   * Only applies when status matches the expected waiting status — prevents
   * a stale retry from overwriting a step already resolved by another request.
   */
  async resolveParkedStep(
    executionId: string,
    tenantId: string,
    projectId: string,
    stepKey: string,
    expectedStatus: string,
    result: {
      completedAt?: string;
      output?: unknown;
      decision?: string;
      fields?: Record<string, unknown>;
      respondedBy?: string;
      notes?: string;
    },
  ): Promise<boolean> {
    const updated = (await this.model.findOneAndUpdate(
      {
        _id: executionId,
        tenantId,
        projectId,
        [`context.steps.${safeStepKey(stepKey)}.status`]: expectedStatus,
        [`context.steps.${safeStepKey(stepKey)}.parkPoint`]: true,
      },
      {
        $set: {
          // Derive step status — matches develop-branch conventions:
          //   'reject'/'rejected' → 'rejected'  (approval rejection)
          //   'expired'           → 'failed'    (human-task terminate timeout)
          //   'skipped'           → 'skipped'   (human-task skip timeout)
          //   'approved'          → 'completed' (approval auto-approve timeout — matches
          //                                      develop's markStepCompleted after approved)
          //   output.status=failed → 'failed'   (Docling/ADI worker callback)
          //   everything else     → 'completed'
          [`context.steps.${safeStepKey(stepKey)}.status`]:
            result.decision === 'reject' || result.decision === 'rejected'
              ? 'rejected'
              : result.decision === 'expired'
                ? 'failed'
                : result.decision === 'skipped'
                  ? 'skipped'
                  : result.decision === 'approved'
                    ? 'completed'
                    : result.output &&
                        typeof result.output === 'object' &&
                        (result.output as Record<string, unknown>).status === 'failed'
                      ? 'failed'
                      : 'completed',
          [`context.steps.${safeStepKey(stepKey)}.parkPoint`]: false,
          [`context.steps.${safeStepKey(stepKey)}.completedAt`]:
            result.completedAt ?? new Date().toISOString(),
          ...(result.output !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.output`]: result.output }
            : {}),
          ...(result.decision !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.decision`]: result.decision }
            : {}),
          ...(result.fields !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.fields`]: result.fields }
            : {}),
          ...(result.respondedBy !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.respondedBy`]: result.respondedBy }
            : {}),
          ...(result.notes !== undefined
            ? { [`context.steps.${safeStepKey(stepKey)}.notes`]: result.notes }
            : {}),
        },
        // Clear the human-wait flag when an approval/human-task step resolves so
        // the stuck-execution sweeper can resume monitoring this execution if it
        // later parks at a waiting_callback step.
        $unset: {
          ...(expectedStatus === 'waiting_approval' || expectedStatus === 'waiting_human_task'
            ? { hasHumanWait: '' }
            : {}),
        },
      },
      { returnDocument: 'after' } as Record<string, unknown>,
    )) as Record<string, unknown> | null;
    return updated !== null;
  }

  /**
   * Atomically increment the runCounter and return the new value.
   * Used to stamp WS-published events with a monotonic sequence number
   * so Studio can re-order events that arrive out of sequence across runs.
   */
  async incrementLegCounter(
    executionId: string,
    tenantId: string,
    projectId: string,
  ): Promise<number> {
    const result = (await this.model.findOneAndUpdate(
      { _id: executionId, tenantId, projectId },
      { $inc: { runCounter: 1 } },
      { returnDocument: 'after' } as Record<string, unknown>,
    )) as Record<string, unknown> | null;
    return (result?.runCounter as number) ?? 0;
  }

  async updateStepStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    _stepId: string,
    _status: string,
    data?: {
      /** Key in context.steps to write — enables per-step dot-notation $set */
      stepKey?: string;
      /** Step data to write at context.steps[stepKey] */
      stepData?: WorkflowStepData;
      /**
       * Full workflow context — stored as-is (minus internal workflow/tenant
       * sub-objects). context.steps is the single source of truth for all step
       * data; this is the only field written here.
       */
      context?: WorkflowContextData;
      /**
       * Plaintext HMAC secret — reserved for future use; not yet persisted.
       */
      callbackSecret?: string;
      // Legacy params — accepted but ignored.
      nodeType?: string;
      output?: unknown;
      durationMs?: number;
      error?: unknown;
      input?: unknown;
      metrics?: { responseTimeMs?: number; processingTimeMs?: number };
      consoleLogs?: Array<{ level: string; args: unknown[] }>;
      mappingErrors?: Array<{ name: string; expression?: string; error: string }>;
    },
    options?: ExecutionStoreOptions,
  ): Promise<void> {
    // Per-step write — no race, no write amplification
    if (data?.stepKey !== undefined && data?.stepData !== undefined) {
      const { controlFlow: _cf, ...cleanStep } = data.stepData as Record<string, unknown>;
      void _cf;
      const setUpdate: Record<string, unknown> = {
        [`context.steps.${data.stepKey}`]: cleanStep,
      };
      if (data.context !== undefined) {
        const { workflow: _w, tenant: _t, steps: _s, ...publicContext } = data.context;
        void _w;
        void _t;
        void _s;
        for (const [key, value] of Object.entries(publicContext)) {
          setUpdate[`context.${key}`] = value;
        }
      }
      await this.model.findOneAndUpdate(
        {
          _id: executionId,
          tenantId,
          projectId,
          status: { $nin: TERMINAL_EXECUTION_STATUSES },
        },
        { $set: setUpdate },
        options?.session ? { session: options.session } : undefined,
      );
      return;
    }

    // Legacy whole-context path (kept for callers that haven't migrated)
    if (data?.context === undefined) return;

    const { workflow: _w, tenant: _t, ...publicContext } = data.context;

    await this.model.findOneAndUpdate(
      {
        _id: executionId,
        tenantId,
        projectId,
        status: { $nin: TERMINAL_EXECUTION_STATUSES },
      },
      { $set: { context: publicContext } },
      options?.session ? { session: options.session } : undefined,
    );
  }

  async updateExecutionStatus(
    executionId: string,
    tenantId: string,
    projectId: string,
    status: string,
    data?: {
      context?: WorkflowContextData;
      error?: unknown;
      completedAt?: Date;
      output?: Record<string, unknown>;
      startTime?: string;
      endTime?: string;
    },
    options?: ExecutionStoreOptions,
  ): Promise<void> {
    const update: Record<string, unknown> = { status };

    if (data?.context !== undefined) {
      // I-9 fix: use per-field $set instead of replacing the entire context document.
      // Replacing context erases context.loopData (relay-race loop item manifests)
      // which is stored at context.loopData[loopKey] but not in wfCtx.
      const { workflow: _w, tenant: _t, ...publicContext } = data.context;
      for (const [key, value] of Object.entries(publicContext)) {
        if (key !== 'loopData') {
          // loopData managed separately, never overwrite
          update[`context.${key}`] = value;
        }
      }
    }
    if (data?.error !== undefined) {
      update.error = data.error;
    }
    if (data?.completedAt !== undefined) {
      update.completedAt = data.completedAt;
    }
    if (data?.output !== undefined) {
      update.output = data.output;
    }
    if (data?.startTime !== undefined) {
      update.startTime = data.startTime;
    }
    if (data?.endTime !== undefined) {
      update.endTime = data.endTime;
    }

    // LLD §6.1 — populate `expiresAt` on terminal transitions when the
    // TTL flag is on. Non-terminal transitions leave the field alone so a
    // previously-set TTL (e.g. from a prior terminal write that got
    // reverted by replay) doesn't orphan the row. The helper returns null
    // when the flag is off, which no-ops the field.
    const expiresAt = computeExecutionExpiresAt(status);
    if (expiresAt !== null) {
      update.expiresAt = expiresAt;
    }

    // 'cancelled' is authoritative: if the user explicitly cancelled, a late
    // 'completed' write from a Restate replay must not overwrite it.
    const filter: Record<string, unknown> = { _id: executionId, tenantId, projectId };
    if (status === 'completed') {
      filter.status = { $nin: ['cancelled', 'failed', 'rejected'] };
    }

    await this.model.findOneAndUpdate(
      filter,
      { $set: update },
      options?.session ? { session: options.session } : undefined,
    );

    // Compute durationMs for terminal statuses using server-side aggregation.
    // Also purge loop iteration scratch keys from context.steps — those entries
    // (format: `loop:*:i*:*`) are ephemeral retry guards with no audit value
    // once the execution terminates. Removing them keeps documents lean (I-9).
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'rejected' ||
      status === 'cancelled'
    ) {
      // Purge iteration-scoped step keys in a fire-and-forget write.
      // Pattern: any context.steps key that starts with "loop:" and contains ":i" (iteration marker).
      // Uses MongoDB aggregation pipeline update to $unset dynamic keys matching the pattern.
      // If this fails it is non-fatal — stale keys are harmless beyond storage cost.
      void this.model
        .findOneAndUpdate(
          { _id: executionId, tenantId, projectId },
          [
            {
              $set: {
                'context.steps': {
                  $arrayToObject: {
                    $filter: {
                      input: { $objectToArray: '$context.steps' },
                      cond: {
                        $not: {
                          $regexMatch: { input: '$$this.k', regex: /^loop:.*:i\d+:/ },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
          options?.session ? { session: options.session } : undefined,
        )
        .catch(() => {
          // Non-fatal — cleanup failure doesn't affect execution outcome.
        });

      await this.model.findOneAndUpdate(
        { _id: executionId, tenantId, projectId, startedAt: { $exists: true } },
        [{ $set: { durationMs: { $subtract: [new Date(), '$startedAt'] } } }],
        options?.session ? { session: options.session } : undefined,
      );
    }
  }

  async getByTenant(
    tenantId: string,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
  ): Promise<unknown[]> {
    return this.model.find({ tenantId, projectId }).sort({ startedAt: -1 }).limit(limit).lean();
  }

  async getById(executionId: string, tenantId: string, projectId: string): Promise<unknown> {
    return this.model.findOne({ _id: executionId, tenantId, projectId });
  }

  // ─── Phase 6 — Loop data methods ────────────────────────────────────────────

  /**
   * Store loop configuration + items at fan-out time so iteration legs
   * can read their item without it being re-passed in every WorkflowRunInput.
   * Idempotent — uses $set on a fixed key so Restate retries are safe.
   */
  async storeLoopData(
    executionId: string,
    tenantId: string,
    projectId: string,
    loopKey: string,
    data: {
      items: unknown[];
      itemVariable: string;
      bodyStepIds: string[];
      bodyInDegreeMap?: Record<string, number>;
      joinStepId?: string;
      totalIterations: number;
      concurrencyLimit: number;
      ignoreErrors: boolean;
    },
  ): Promise<void> {
    // F-3 fix: per-item 64KB size cap.
    // H-3 fix: 12MB total cap so document stays within MongoDB 16MB hard limit
    //   (execution document has other large fields: inputSnapshot, context.steps).
    const MAX_ITEM_BYTES = 64 * 1024; // 64KB per item
    const TOTAL_LOOP_DATA_MAX_BYTES = 12 * 1024 * 1024; // 12MB total
    let totalBytes = 0;
    for (let i = 0; i < data.items.length; i++) {
      const itemSize = Buffer.byteLength(JSON.stringify(data.items[i] ?? null), 'utf8');
      if (itemSize > MAX_ITEM_BYTES) {
        throw new Error(
          `Loop item at index ${i} exceeds max size (${itemSize} > ${MAX_ITEM_BYTES} bytes). ` +
            `Store only item IDs or references in loop collections containing large payloads.`,
        );
      }
      totalBytes += itemSize;
      if (totalBytes > TOTAL_LOOP_DATA_MAX_BYTES) {
        throw new Error(
          `Loop items total size exceeds ${TOTAL_LOOP_DATA_MAX_BYTES} bytes at item ${i}. ` +
            `Reduce item count or item size — MongoDB document limit is 16MB.`,
        );
      }
    }
    await this.model.updateOne(
      { _id: executionId, tenantId, projectId },
      {
        $set: {
          [`context.loopData.${safeStepKey(loopKey)}`]: {
            ...data,
            nextDispatchIndex: data.concurrencyLimit,
          }, // I-1a fix
        },
      },
    );
  }

  /**
   * Read loop data stored at fan-out time.
   */
  async readLoopData(
    executionId: string,
    tenantId: string,
    projectId: string,
    loopKey: string,
  ): Promise<{
    items: unknown[];
    itemVariable: string;
    bodyStepIds: string[];
    bodyInDegreeMap?: Record<string, number>;
    joinStepId?: string;
    totalIterations: number;
    concurrencyLimit: number;
    ignoreErrors: boolean;
    nextDispatchIndex: number;
  } | null> {
    const doc = (await this.model.findOne({
      _id: executionId,
      tenantId,
      projectId,
    })) as Record<string, unknown> | null;
    if (!doc) return null;
    const loopData = (
      (doc.context as Record<string, unknown>)?.loopData as Record<string, unknown>
    )?.[loopKey];
    return (
      (loopData as unknown as {
        items: unknown[];
        itemVariable: string;
        bodyStepIds: string[];
        bodyInDegreeMap?: Record<string, number>;
        joinStepId?: string;
        totalIterations: number;
        concurrencyLimit: number;
        ignoreErrors: boolean;
        nextDispatchIndex: number;
      } | null) ?? null
    );
  }

  // H-6: atomicLoopNextDispatch removed — dead code. The rolling-window dispatch
  // uses WorkflowRunInput.loopNextIndexToDispatch (carried in Restate input) instead of
  // reading nextDispatchIndex from MongoDB. This avoids a MongoDB roundtrip per
  // iteration and eliminates a side-effect mutation with no callers.
}
