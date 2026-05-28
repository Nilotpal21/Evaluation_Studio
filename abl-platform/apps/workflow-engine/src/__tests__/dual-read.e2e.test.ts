/**
 * E2E-02 — Dual-Read UNION parity with Mongo-only path.
 *
 * Scenario: `docs/testing/sub-features/workflow-execution-event-sourcing.md` §5 E2E-02.
 *
 * Proves FR-6: the hybrid reader fans out to Mongo + ClickHouse, with
 * Mongo-winning-on-overlap and deterministic ordering. Uses the
 * `workflow-executions/:id/hybrid?mode=mongo-only|ch-only|union` test-
 * diagnostic endpoint — operator-toggling the flag mid-run is not
 * testable from E2E, so the endpoint exposes all three views in parallel.
 *
 * ## Gate requirements
 *
 * Requires `WORKFLOW_OUTBOX_ENABLED=true` + `WORKFLOW_CH_SINK_ENABLED=true`
 * + `WORKFLOW_DUAL_READ_ENABLED=true`. Without dual-read the hybrid
 * inspector is not wired and the test-diagnostic endpoint returns 503.
 *
 * Operator contract matches E2E-01 — see `execution-lifecycle.e2e.test.ts`
 * for the full startup walkthrough.
 */

import { describe, beforeAll, it, expect } from 'vitest';
import { evaluateE2EGate, logSkip, type E2EGateResult } from './helpers/e2e-gate.js';

const SCENARIO_ID = 'E2E-02';

const gate: E2EGateResult = await evaluateE2EGate({
  flags: ['WORKFLOW_OUTBOX_ENABLED', 'WORKFLOW_CH_SINK_ENABLED', 'WORKFLOW_DUAL_READ_ENABLED'],
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

const CH_INGEST_BUDGET_MS = 15_000;
const CH_LATEST_PROJECTION_BUDGET_MS = 15_000;

describe.skipIf(!gate.shouldRun)(
  `${SCENARIO_ID} — dual-read UNION [Mongo + CH parity via hybrid inspector]`,
  () => {
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

    it('union returns Mongo row; ch-only returns CH row; both carry identical identity fields', async () => {
      // 1. Execute a workflow to generate both a Mongo execution row and
      //    (after CH ingest) a CH `workflow_executions_latest` row.
      const executeRes = await fetch(
        `${urls.workflowEngine}/api/v1/projects/${auth.projectId}/workflows/${workflowId}/executions/execute`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ input: { e2eScenario: SCENARIO_ID } }),
        },
      );
      expect(executeRes.status).toBeGreaterThanOrEqual(200);
      expect(executeRes.status).toBeLessThan(300);
      const executeBody = (await executeRes.json()) as { executionId?: string };
      const executionId = executeBody.executionId;
      expect(executionId).toBeDefined();

      type ExecutionRow = {
        _id: string;
        tenantId?: string;
        projectId?: string;
        workflowId?: string;
        tenant_id?: string;
        project_id?: string;
        workflow_id?: string;
        status?: string;
        source?: 'mongo' | 'ch';
      };

      const fetchHybrid = async (
        mode: 'mongo-only' | 'ch-only' | 'union',
      ): Promise<ExecutionRow | undefined> => {
        const qs = new URLSearchParams({ mode, projectId: auth.projectId });
        const r = await fetch(
          `${urls.workflowEngine}/api/admin/test/workflow-executions/${executionId}/hybrid?${qs}`,
          { headers: authHeaders },
        );
        if (r.status === 404) {
          // Row not yet projected — treat as "keep polling".
          return undefined;
        }
        if (r.status === 503) {
          throw new Error(
            `${SCENARIO_ID}: hybrid inspector returned 503 — WORKFLOW_DUAL_READ_ENABLED not wired on the workflow-engine even though the gate passed. Double-check the flag on the running process.`,
          );
        }
        if (r.status !== 200) return undefined;
        const body = (await r.json()) as { data?: ExecutionRow };
        return body.data;
      };

      // 2. Poll for Mongo row — published synchronously with the outbox
      //    when the workflow handler persists.
      const mongoRow = await pollUntil<ExecutionRow>(
        () => fetchHybrid('mongo-only'),
        CH_INGEST_BUDGET_MS,
        500,
      );
      expect(
        mongoRow,
        `mongo-only row for ${executionId} must be present within ${CH_INGEST_BUDGET_MS}ms`,
      ).toBeDefined();
      expect(mongoRow!._id).toBe(executionId);
      expect(mongoRow!.tenantId).toBe(auth.tenantId);
      expect(mongoRow!.projectId).toBe(auth.projectId);
      expect(mongoRow!.workflowId).toBe(workflowId);

      // 3. Poll for the CH `workflow_executions_latest` projection. The
      //    event has to land in raw `workflow_execution_events` and then
      //    the per-row MV projects it — tight but possible within the
      //    budget.
      const chRow = await pollUntil<ExecutionRow>(
        () => fetchHybrid('ch-only'),
        CH_LATEST_PROJECTION_BUDGET_MS,
        500,
      );
      expect(
        chRow,
        `ch-only row for ${executionId} must be projected within ${CH_LATEST_PROJECTION_BUDGET_MS}ms (Kafka + buffered writer + MV)`,
      ).toBeDefined();
      // CH projection uses snake_case column names.
      expect(chRow!._id).toBe(executionId);
      expect(chRow!.tenant_id ?? chRow!.tenantId).toBe(auth.tenantId);
      expect(chRow!.project_id ?? chRow!.projectId).toBe(auth.projectId);
      expect(chRow!.workflow_id ?? chRow!.workflowId).toBe(workflowId);

      // 4. Union must return a row equal in identity to the Mongo row.
      //    On overlap (both Mongo AND CH have a row with the same _id), the
      //    merger keeps the Mongo row (`mongoWinsOnOverlap` invariant of
      //    `mergeMongoAndCH`). The union-mode response therefore matches
      //    the mongo-only response for identity fields, with `source:
      //    'mongo'` added by the hybrid reader.
      const unionRow = await fetchHybrid('union');
      expect(unionRow, 'union-mode row must be defined').toBeDefined();
      expect(unionRow!._id).toBe(executionId);
      expect(unionRow!.tenantId).toBe(auth.tenantId);
      expect(unionRow!.projectId).toBe(auth.projectId);
      expect(unionRow!.workflowId).toBe(workflowId);
      // The hybrid reader stamps source='mongo' when Mongo wins on overlap.
      expect(unionRow!.source).toBe('mongo');
    });

    it('ch-only for unknown execution returns 404 (no leak)', async () => {
      // Isolation check: a random execution id for this tenant must return
      // 404, not 200-empty, so we don't inadvertently rely on returning
      // shell rows under CH miss.
      const ghostId = '00000000-0000-0000-0000-000000000000';
      const qs = new URLSearchParams({ mode: 'ch-only', projectId: auth.projectId });
      const r = await fetch(
        `${urls.workflowEngine}/api/admin/test/workflow-executions/${ghostId}/hybrid?${qs}`,
        { headers: authHeaders },
      );
      expect(r.status).toBe(404);
    });
  },
);

async function pollUntil<T>(
  supplier: () => Promise<T | undefined>,
  budgetMs: number,
  intervalMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  let result = await supplier();
  while (result === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    result = await supplier();
  }
  return result;
}
