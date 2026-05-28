/**
 * Restate Client Wrapper
 *
 * Used by Express routers to trigger workflow operations via the Restate ingress HTTP API.
 * Sends requests to the Restate ingress (default: http://localhost:8090).
 *
 * URL pattern for Restate workflow virtual objects:
 *   /{service-name}/{key}/{handler}       — call handler synchronously
 *   /{service-name}/{key}/{handler}/send  — fire-and-forget (async)
 */
import { createLogger } from '@abl/compiler/platform';
import { WORKFLOW_SERVICE_NAME } from './restate-endpoint.js';
import { WORKFLOW_EXECUTOR_SERVICE_NAME } from '../handlers/workflow-handler.js';
import type { WorkflowRunInput } from '../handlers/workflow-handler.js';

const log = createLogger('workflow-engine:restate-client');

const DEFAULT_RESTATE_INGRESS_URL = 'http://localhost:8091';
const DEFAULT_RESTATE_ADMIN_URL = 'http://localhost:9070';
const RESTATE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Matches Restate's "service not registered" error body. Example:
 *   {"message":"service 'workflow-runner' not found, make sure to register the service before calling it."}
 * When seen on a 404, it indicates Restate has lost our deployment registration
 * (e.g. Restate pod restart with ephemeral state) — the client re-registers
 * via the registerFn callback and retries the invocation once.
 */
const SERVICE_NOT_FOUND_PATTERN = /service .* not found/i;

export interface RestateClientConfig {
  ingressUrl?: string;
  adminUrl?: string;
  /**
   * Optional callback the client invokes when a Restate ingress call returns
   * 404 "service not found". Should re-POST the workflow-engine deployment to
   * Restate admin and return true on success. If omitted, the client does not
   * attempt self-healing and behaves as before.
   */
  registerFn?: () => Promise<boolean>;
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on every outbound
   * Restate ingress and admin call. When set, the Restate deployment (either
   * natively or via an auth sidecar) must verify it so that only workflow-engine
   * pods — not arbitrary cluster peers — can start/cancel/resolve workflows.
   *
   * Omit (falsy) to preserve the legacy unauthenticated behavior; intended for
   * local dev only. Prod deployments should set `RESTATE_INGRESS_AUTH_TOKEN`.
   */
  authToken?: string;
}

export class RestateWorkflowClient {
  private readonly ingressUrl: string;
  private readonly adminUrl: string;
  private readonly registerFn?: () => Promise<boolean>;
  private readonly authHeader?: string;

  constructor(config?: RestateClientConfig) {
    this.ingressUrl =
      config?.ingressUrl || process.env.RESTATE_INGRESS_URL || DEFAULT_RESTATE_INGRESS_URL;
    this.adminUrl = config?.adminUrl || process.env.RESTATE_ADMIN_URL || DEFAULT_RESTATE_ADMIN_URL;
    this.registerFn = config?.registerFn;
    const token = config?.authToken ?? process.env.RESTATE_INGRESS_AUTH_TOKEN;
    this.authHeader = token && token.length > 0 ? `Bearer ${token}` : undefined;
  }

  /**
   * Compose the outbound header set for a Restate call. Always includes
   * `Content-Type: application/json`; adds `Authorization: Bearer …` only
   * when `authToken` has been configured. Kept in one place so every call
   * site stays symmetric — adding a new method can't silently skip the
   * bearer.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    return headers;
  }

  /**
   * POST to a Restate ingress URL with a single re-register+retry on a 404
   * "service not found" response. This closes the small window between Restate
   * losing deployment state and the next periodic reconciliation tick in
   * workflow-engine's registration loop — any in-flight request self-heals
   * instead of surfacing a 404 to the caller.
   */
  private async postWithReregister(
    url: string,
    body: unknown,
    context: Record<string, unknown>,
  ): Promise<Response> {
    const doPost = () =>
      fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RESTATE_REQUEST_TIMEOUT_MS),
      });

    const response = await doPost();
    if (response.status !== 404 || !this.registerFn) return response;

    const text = await response.clone().text();
    if (!SERVICE_NOT_FOUND_PATTERN.test(text)) return response;

    log.error('Restate reports service not registered — re-registering and retrying once', {
      ...context,
      url,
      body: text,
    });
    const registered = await this.registerFn();
    if (!registered) return response;
    return doPost();
  }

  /**
   * Start a workflow execution via Restate ingress (fire-and-forget).
   * Uses the `/send` suffix so the HTTP call returns immediately
   * while Restate schedules durable execution.
   *
   * The executionId is used as both the Restate virtual object key
   * and the idempotency key to prevent duplicate starts.
   */
  async startLegacyWorkflow(executionId: string, input: Record<string, unknown>): Promise<void> {
    const url = `${this.ingressUrl}/${WORKFLOW_SERVICE_NAME}/${encodeURIComponent(executionId)}/run/send`;
    log.info('Starting legacy workflow via Restate', { executionId });

    const response = await this.postWithReregister(url, input, { executionId });

    if (!response.ok) {
      const text = await response.text();
      log.error('Restate startLegacyWorkflow failed', {
        executionId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate startLegacyWorkflow failed (${response.status}): ${text}`);
    }
  }

  /**
   * Cancel a running workflow by invoking the `cancel` shared handler via
   * the Restate ingress. The handler resolves the `sys:cancel` durable promise
   * which `raceCancel` in workflow-handler.ts races against the active sleep or
   * approval wait, causing the workflow to throw CancellationError and stop.
   *
   * Uses fire-and-forget (/send) so the HTTP cancel endpoint can respond
   * immediately without waiting for the cancel handler to complete.
   * A 404 is treated as success — the workflow has already finished.
   */
  async cancelLegacyWorkflow(executionId: string): Promise<void> {
    log.info('Cancelling legacy workflow via Restate ingress cancel handler', { executionId });

    const url = `${this.ingressUrl}/${WORKFLOW_SERVICE_NAME}/${encodeURIComponent(executionId)}/cancel/send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(RESTATE_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      log.error('Restate cancelLegacyWorkflow failed', {
        executionId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate cancelLegacyWorkflow failed (${response.status}): ${text}`);
    }
  }

  /**
   * Resolve a durable callback promise in a running workflow.
   * Calls the `resolveCallback` shared handler on the workflow virtual object.
   */
  async resolveCallback(executionId: string, stepId: string, payload: unknown): Promise<void> {
    const url = `${this.ingressUrl}/${WORKFLOW_SERVICE_NAME}/${encodeURIComponent(executionId)}/resolveCallback`;
    log.info('Resolving callback via Restate', { executionId, stepId });

    const response = await this.postWithReregister(
      url,
      { executionId, stepId, payload },
      { executionId, stepId },
    );

    if (!response.ok) {
      const text = await response.text();
      log.error('Restate resolveCallback failed', {
        executionId,
        stepId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate resolveCallback failed (${response.status}): ${text}`);
    }
  }

  /**
   * Resolve a Restate awakeable via the built-in ingress endpoint.
   * Unlike resolveCallback (which goes through the workflow.shared handler),
   * this hits /restate/awakeables/:id/resolve directly — bypassing the
   * 1.6.2 suspended-run re-dispatch bug in the shared-handler path.
   */
  async resolveAwakeable(awakeableId: string, payload: unknown): Promise<void> {
    const url = `${this.ingressUrl}/restate/awakeables/${encodeURIComponent(awakeableId)}/resolve`;
    log.info('Resolving awakeable via Restate built-in endpoint', { awakeableId });

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESTATE_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error('Restate resolveAwakeable failed', {
        awakeableId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate resolveAwakeable failed (${response.status}): ${text}`);
    }
  }

  /**
   * Resolve a durable approval promise in a running workflow.
   * Calls the `resolveApproval` shared handler on the workflow virtual object.
   */
  async resolveApproval(
    executionId: string,
    stepId: string,
    decision: { approved: boolean; decidedBy: string; reason?: string },
  ): Promise<void> {
    const url = `${this.ingressUrl}/${WORKFLOW_SERVICE_NAME}/${encodeURIComponent(executionId)}/resolveApproval`;
    log.info('Resolving approval via Restate', { executionId, stepId });

    const response = await this.postWithReregister(
      url,
      { executionId, stepId, decision },
      { executionId, stepId },
    );

    if (!response.ok) {
      const text = await response.text();
      log.error('Restate resolveApproval failed', {
        executionId,
        stepId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate resolveApproval failed (${response.status}): ${text}`);
    }
  }

  /**
   * Resolve a durable human task promise in a running workflow.
   * Calls the `resolveHumanTask` shared handler on the workflow virtual object.
   */
  /**
   * Trigger a relay-race run on the `workflow-executor` Restate object.
   * Fire-and-forget (/send) — returns immediately while Restate schedules
   * the exclusive handler. The handler is exclusive per executionId key
   * so concurrent triggers for the same execution are serialised by Restate.
   *
   * Called by:
   *   - The execute route (initial run, Phase 3)
   *   - Callback/approval/human-task routes on external event arrival (Phase 3)
   *   - Fan-out: parallel step triggers one run per branch (Phase 4)
   *   - Fan-in: the last branch triggers the join step run (Phase 4)
   *   - Delay: timer-based delayed send (Phase 3)
   */
  async startWorkflow(
    executionId: string,
    input: WorkflowRunInput,
    options?: {
      /** Delay in milliseconds before Restate delivers the invocation. */
      delayMs?: number;
      correlationId?: string;
    },
  ): Promise<void> {
    const delayParam = options?.delayMs && options.delayMs > 0 ? `?delay=${options.delayMs}ms` : '';
    const url = `${this.ingressUrl}/${WORKFLOW_EXECUTOR_SERVICE_NAME}/${encodeURIComponent(executionId)}/runWorkflow/send${delayParam}`;

    log.info('Triggering relay-race workflow via Restate', {
      executionId,
      startFromStepIds: input.startFromStepIds,
      branchId: input.branchId,
      resumeStepId: input.resumeStepId,
      correlationId: options?.correlationId,
    });

    const response = await this.postWithReregister(url, input, {
      executionId,
      correlationId: options?.correlationId,
    });

    if (!response.ok) {
      const text = await response.text();
      log.error('Restate startWorkflow failed', {
        executionId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate startWorkflow failed (${response.status}): ${text}`);
    }
  }

  /**
   * Cancel a relay-race workflow execution via the `cancelWorkflow` shared handler.
   * Uses fire-and-forget so the HTTP cancel endpoint responds immediately.
   * Falls back to the legacy cancelLegacyWorkflow for backward compat.
   */
  async cancelWorkflow(executionId: string, tenantId: string, projectId: string): Promise<void> {
    log.info('Cancelling relay-race workflow via cancelWorkflow', { executionId });
    const url = `${this.ingressUrl}/${WORKFLOW_EXECUTOR_SERVICE_NAME}/${encodeURIComponent(executionId)}/cancelWorkflow/send`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ tenantId, projectId }),
      signal: AbortSignal.timeout(RESTATE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      log.error('Restate cancelWorkflow failed', {
        executionId,
        status: response.status,
        body: text,
      });
      throw new Error(`Restate cancelWorkflow failed (${response.status}): ${text}`);
    }
  }

  async resolveHumanTask(
    executionId: string,
    stepId: string,
    response: {
      respondedBy: string;
      respondedAt?: string;
      fields: Record<string, unknown>;
      notes?: string;
      decision?: string;
    },
  ): Promise<void> {
    const url = `${this.ingressUrl}/${WORKFLOW_SERVICE_NAME}/${encodeURIComponent(executionId)}/resolveHumanTask`;
    log.info('Resolving human task via Restate', { executionId, stepId });

    const resp = await this.postWithReregister(
      url,
      {
        executionId,
        stepId,
        response: {
          ...response,
          respondedAt: response.respondedAt ?? new Date().toISOString(),
        },
      },
      { executionId, stepId },
    );

    if (!resp.ok) {
      const text = await resp.text();
      log.error('Restate resolveHumanTask failed', {
        executionId,
        stepId,
        status: resp.status,
        body: text,
      });
      throw new Error(`Restate resolveHumanTask failed (${resp.status}): ${text}`);
    }
  }
}
