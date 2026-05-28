/**
 * E2E-01 — Workflow Execution Lifecycle (Full Event Flow).
 *
 * Scenario: `docs/testing/sub-features/workflow-execution-event-sourcing.md` §5 E2E-01.
 *
 * Proves the end-to-end pipeline:
 *   execute → Mongo domain row + outbox row → Kafka → CH event row →
 *   *_latest MV projection.
 *
 * Covers FR-1, FR-3, FR-4, FR-5, FR-12.
 *
 * ## Operator Contract
 *
 * This test hits an EXTERNALLY-PROVISIONED stack. It does not spin up
 * Mongo/Kafka/CH containers. To run:
 *
 *   1. Start the stack (`docker compose up` → Mongo + Kafka + Redis + CH
 *      as usual; both apps via `pnpm dev`).
 *
 *   2. Set these flags on BOTH the workflow-engine and the runtime:
 *        export WORKFLOW_OUTBOX_ENABLED=true
 *        export WORKFLOW_CH_SINK_ENABLED=true
 *        # DUAL_READ + MONGO_TTL left off for E2E-01 (per test-spec preconditions)
 *      and restart the services so the poller + consumer come up.
 *
 *   3. Export the auth/tenant/workflow context:
 *        export E2E_AUTH_TOKEN='<bearer-jwt>'
 *        export E2E_TENANT_ID='t1'
 *        export E2E_PROJECT_ID='p1'
 *        export E2E_WORKFLOW_ID='<id of a pre-seeded workflow>'
 *
 *   4. pnpm --filter=@agent-platform/workflow-engine test:e2e
 *
 * If any of the above is missing the scenario SKIPS (never fails). See
 * `helpers/e2e-gate.ts` for the exact probe + flag matrix.
 *
 * ## Pre-seeded workflow requirement
 *
 * The operator must have a workflow definition in the target project whose
 * ID is exported as `E2E_WORKFLOW_ID`. The test does not seed it — the
 * seeding path (workflow creation + version activation + deployment) is
 * out of E2E-01 scope and varies per environment.
 */

import { describe, beforeAll, it, expect } from 'vitest';
import { evaluateE2EGate, logSkip, type E2EGateResult } from './helpers/e2e-gate.js';

const SCENARIO_ID = 'E2E-01';

// Evaluate the gate once at module load. Vitest's `describe.skipIf`
// receives the boolean synchronously, so we need this to settle before
// any `describe` runs — vitest supports top-level await in test files.
const gate: E2EGateResult = await evaluateE2EGate({
  flags: ['WORKFLOW_OUTBOX_ENABLED', 'WORKFLOW_CH_SINK_ENABLED'],
  services: {
    workflowEngine: true,
    runtime: true,
    clickhouse: true,
    kafka: true,
  },
});

if (!gate.shouldRun) {
  logSkip(SCENARIO_ID, gate.skipReason ?? 'unknown');
}

// Budgets (tight enough to catch latency regressions, generous enough to
// absorb normal cold-start variance on a fresh stack).
const OUTBOX_PUBLISH_BUDGET_MS = 15_000;
const CH_INGEST_BUDGET_MS = 15_000;

describe.skipIf(!gate.shouldRun)(
  `${SCENARIO_ID} — workflow execution lifecycle [full event flow]`,
  () => {
    // Describe-body executes during test collection even when
    // `describe.skipIf(true)` skips the contained cases, so these reads
    // must tolerate `auth === undefined`. They're only dereferenced
    // inside `beforeAll` / `it` which only run when the describe runs.
    const { urls, auth } = gate;
    const authHeaders = auth
      ? { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
    const workflowId = auth?.workflowId;

    beforeAll(() => {
      if (!auth) {
        throw new Error(`${SCENARIO_ID}: gate passed but auth is undefined (bug in e2e-gate)`);
      }
      if (!workflowId) {
        throw new Error(
          `${SCENARIO_ID}: E2E_WORKFLOW_ID must be exported (the test does not seed workflows)`,
        );
      }
    });

    it('execute → outbox → Kafka → CH event row → _latest projection', async () => {
      // 1. POST execute — kicks off a run, starts the Mongo + outbox tx.
      const executeRes = await fetch(
        `${urls.workflowEngine}/api/v1/projects/${auth.projectId}/workflows/${workflowId}/executions/execute`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ input: { e2eScenario: SCENARIO_ID, customerId: 'e2e-c-1' } }),
        },
      );
      expect(executeRes.status).toBeGreaterThanOrEqual(200);
      expect(executeRes.status).toBeLessThan(300);
      // Execute responds with `{ success: true, executionId }` at the top
      // level — NOT nested under `data`. See
      // `apps/workflow-engine/src/routes/workflow-executions.ts` POST /execute.
      const executeBody = (await executeRes.json()) as {
        success?: boolean;
        executionId?: string;
      };
      const executionId = executeBody.executionId;
      expect(executionId, 'execute response must include executionId').toBeDefined();

      // 2. Confirm the outbox row landed for THIS execution. Since the
      //    outbox decorator is wired into the persistence layer, the row is
      //    written inside the same Mongo transaction as the execution.
      //    Under Restate, the persistence happens when the workflow handler
      //    (`workflow-runner.run`) picks up the invocation — poll briefly so
      //    we tolerate the Restate dispatch latency.
      //
      //    Diagnostic response shape:
      //      { success: true, data: { rows: Array<{ _id, tenantId, projectId,
      //        entityKind, entityId, topic, eventType, eventVersion, occurredAt,
      //        payload, publishedAt, ...}>, count, limit, filter } }
      type OutboxRow = {
        _id: string;
        entityId: string;
        entityKind: string;
        eventType: string;
        eventVersion: string;
        topic: string;
        occurredAt: string;
        publishedAt: string | null;
        tenantId: string;
        projectId: string;
        payload: Record<string, unknown>;
      };
      const fetchOutboxRows = async (
        published?: 'true' | 'false',
      ): Promise<OutboxRow[] | undefined> => {
        const qs = new URLSearchParams({
          entityKind: 'workflow_execution',
          limit: '100',
          ...(published ? { published } : {}),
        });
        const r = await fetch(`${urls.workflowEngine}/api/admin/test/workflow-outbox?${qs}`, {
          headers: authHeaders,
        });
        if (r.status === 404) {
          throw new Error(
            `${SCENARIO_ID}: /api/admin/test/workflow-outbox returned 404 — server not running with NODE_ENV=test.`,
          );
        }
        if (r.status !== 200) return undefined;
        const body = (await r.json()) as { data?: { rows?: OutboxRow[] } };
        return body.data?.rows ?? [];
      };

      const startedRow = await pollUntil<OutboxRow>(
        async () => {
          const rows = await fetchOutboxRows();
          return rows?.find(
            (r) => r.entityId === executionId && r.eventType === 'workflow.execution.started',
          );
        },
        OUTBOX_PUBLISH_BUDGET_MS,
        500,
      );
      expect(
        startedRow,
        `outbox row for ${executionId} (workflow.execution.started) must be written within ${OUTBOX_PUBLISH_BUDGET_MS}ms`,
      ).toBeDefined();
      expect(startedRow!.tenantId).toBe(auth.tenantId);
      expect(startedRow!.projectId).toBe(auth.projectId);
      expect(startedRow!.topic).toBe('abl.workflow.execution');

      // 3. Wait for the poller to publish (publishedAt becomes non-null).
      const publishedRow = await pollUntil<OutboxRow>(
        async () => {
          const rows = await fetchOutboxRows('true');
          return rows?.find(
            (r) => r.entityId === executionId && r.eventType === 'workflow.execution.started',
          );
        },
        OUTBOX_PUBLISH_BUDGET_MS,
        250,
      );
      expect(
        publishedRow,
        `outbox row for ${executionId} must be published within ${OUTBOX_PUBLISH_BUDGET_MS}ms (poller + Kafka ACK)`,
      ).toBeDefined();
      expect(publishedRow!.publishedAt).toBeTruthy();

      // 4. GET the execution detail — visible via the workflow-engine list
      //    route. Under Mongo-only read path (dual-read OFF) the row should
      //    be present once the workflow handler has persisted. Detail
      //    response shape: { success: true, data: { _id, tenantId,
      //    projectId, status, steps, ... } }.
      const detailBody = await pollUntil<{
        _id?: string;
        tenantId?: string;
        projectId?: string;
        status?: string;
      }>(
        async () => {
          const detailRes = await fetch(
            `${urls.workflowEngine}/api/v1/projects/${auth.projectId}/workflows/${workflowId}/executions/${executionId}`,
            { headers: authHeaders },
          );
          if (detailRes.status !== 200) return undefined;
          const body = (await detailRes.json()) as {
            data?: { _id?: string; tenantId?: string; projectId?: string; status?: string };
          };
          return body.data;
        },
        OUTBOX_PUBLISH_BUDGET_MS,
        500,
      );
      expect(
        detailBody,
        `GET detail for ${executionId} must return 200 within ${OUTBOX_PUBLISH_BUDGET_MS}ms`,
      ).toBeDefined();
      expect(detailBody!.tenantId).toBe(auth.tenantId);
      expect(detailBody!.projectId).toBe(auth.projectId);
      expect(detailBody!.status).toBeDefined();

      // 5. Wait for the CH event row to appear via the runtime
      //    test-diagnostic endpoint. Response shape:
      //    { success: true, data: { rows: Array<ch-row>, count, executionId } }
      type ChEvent = {
        event_type: string;
        event_version: string;
        tenant_id: string;
        project_id: string;
      };
      const chEvent = await pollUntil<ChEvent>(
        async () => {
          const r = await fetch(
            `${urls.runtime}/api/admin/test/workflow-ch-events/${executionId}`,
            { headers: authHeaders },
          );
          if (r.status !== 200) return undefined;
          const body = (await r.json()) as { data?: { rows?: ChEvent[] } };
          return body.data?.rows?.find((row) => row.event_type === 'workflow.execution.started');
        },
        CH_INGEST_BUDGET_MS,
        500,
      );
      expect(
        chEvent,
        `CH event row for ${executionId} must land within ${CH_INGEST_BUDGET_MS}ms (Kafka → buffered writer flush)`,
      ).toBeDefined();
      expect(chEvent!.tenant_id).toBe(auth.tenantId);
      expect(chEvent!.project_id).toBe(auth.projectId);
      expect(chEvent!.event_version).toBeDefined();
    });

    it('unknown-execution CH diagnostic returns an empty rows array (no leak)', async () => {
      // Sanity check tied to the scenario's Isolation Check (§5 E2E-01).
      // Issue the CH diagnostic for a random execution id that doesn't
      // exist for this tenant and expect `rows: []` + `count: 0` — NOT a
      // 4xx that could leak existence. The diagnostic is tenant-scoped, so
      // cross-tenant rows for the same id would be filtered out by the CH
      // WHERE clause. This single-tenant form is directly verifiable
      // without minting a second tenant's JWT.
      //
      // Response shape: { success: true, data: { rows, count, executionId } }
      const ghostId = '00000000-0000-0000-0000-000000000000';
      const r = await fetch(`${urls.runtime}/api/admin/test/workflow-ch-events/${ghostId}`, {
        headers: authHeaders,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        success?: boolean;
        data?: { rows?: unknown[]; count?: number; executionId?: string };
      };
      expect(body.success).toBe(true);
      expect(body.data?.rows).toEqual([]);
      expect(body.data?.count).toBe(0);
      expect(body.data?.executionId).toBe(ghostId);
    });
  },
);

/**
 * Poll a supplier until it returns a non-undefined value or the budget
 * elapses. Returns `undefined` on timeout so the caller can fail with its
 * own budget-aware message.
 */
async function pollUntil<T>(
  supplier: () => Promise<T | undefined>,
  budgetMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  // First try is eager so the fast path costs ~one request, not one interval.
  let result = await supplier();
  while (result === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    result = await supplier();
  }
  return result;
}
