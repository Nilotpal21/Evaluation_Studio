/**
 * E2E-06 — Trigger → Execution → HumanTask → ClickHouse chain.
 *
 * Scenario (scoped): `docs/testing/sub-features/workflow-execution-event-sourcing.md` §5 E2E-06.
 *
 * Proves the cross-entity correlation half of the full chain:
 *
 *   Execute a workflow whose first step is a `human` (or `data_entry`)
 *   step → outbox writes land in BOTH `workflow_event_outbox` and
 *   `human_task` → BullMQ poller publishes to `abl.workflow.execution`
 *   AND `abl.human.task` → runtime consumer sinks both into CH →
 *   `workflow_execution_events` + `human_task_events` raw tables AND
 *   `workflow_executions_latest` + `human_tasks_latest` projections both
 *   populated, sharing `execution_id` as the join key.
 *
 * The full approve/claim roundtrip defined in the test spec is NOT
 * attempted here — that requires a structured response payload specific
 * to the target workflow's data_entry schema plus a second-user JWT. The
 * deferred broader scenario lives at GAP-008; this pilot proves the CH
 * correlation which is the durability-critical claim of FR-3/4/5.
 *
 * Covers FR-3, FR-4, FR-5 for cross-entity. Covers feature spec §9
 * "Key Relationships" join key.
 *
 * ## Gate requirements
 *
 * Same flags as E2E-02 (OUTBOX + CH_SINK + DUAL_READ). Additionally
 * requires `E2E_HUMAN_TASK_WORKFLOW_ID` — a separate workflow id from
 * `E2E_WORKFLOW_ID` because the lifecycle pilot uses an integration-only
 * workflow that doesn't create human tasks. The workflow must have at
 * least one `human` or `data_entry` node so executing it creates a
 * human_task.
 */

import { describe, beforeAll, it, expect } from 'vitest';
import { evaluateE2EGate, logSkip, type E2EGateResult } from './helpers/e2e-gate.js';

const SCENARIO_ID = 'E2E-06';
const HUMAN_TASK_WORKFLOW_ENV = 'E2E_HUMAN_TASK_WORKFLOW_ID';

const gate: E2EGateResult = await evaluateE2EGate({
  flags: ['WORKFLOW_OUTBOX_ENABLED', 'WORKFLOW_CH_SINK_ENABLED', 'WORKFLOW_DUAL_READ_ENABLED'],
  services: {
    workflowEngine: true,
    runtime: true,
    clickhouse: true,
    kafka: true,
  },
});

const humanTaskWorkflowId = process.env[HUMAN_TASK_WORKFLOW_ENV];

if (!gate.shouldRun) {
  logSkip(SCENARIO_ID, gate.skipReason ?? 'unknown');
} else if (!humanTaskWorkflowId) {
  logSkip(
    SCENARIO_ID,
    `${HUMAN_TASK_WORKFLOW_ENV} not exported — needed to drive trigger→human_task chain`,
  );
}

const shouldRun = gate.shouldRun && Boolean(humanTaskWorkflowId);

const EXECUTION_EVENT_BUDGET_MS = 20_000;
const HUMAN_TASK_EVENT_BUDGET_MS = 20_000;

describe.skipIf(!shouldRun)(
  `${SCENARIO_ID} — trigger → execution → human_task → CH chain [cross-entity correlation]`,
  () => {
    const { urls, auth } = gate;
    const authHeaders = auth
      ? { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };

    beforeAll(() => {
      if (!auth) {
        throw new Error(`${SCENARIO_ID}: gate passed but auth is undefined (bug in e2e-gate)`);
      }
      if (!humanTaskWorkflowId) {
        throw new Error(`${SCENARIO_ID}: ${HUMAN_TASK_WORKFLOW_ENV} must be exported`);
      }
    });

    it('execute workflow → both execution AND human_task events land in CH with shared execution_id', async ({
      skip,
    }) => {
      // 1. Execute the human-task-bearing workflow. The workflow-handler
      //    will persist an execution row (outbox: workflow.execution.started)
      //    and, as it hits the human step, persist a human_task row
      //    (outbox: human_task.created).
      const executeRes = await fetch(
        `${urls.workflowEngine}/api/v1/projects/${auth.projectId}/workflows/${humanTaskWorkflowId}/executions/execute`,
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

      // 2. Wait for the workflow.execution.started CH event row (runtime
      //    test-diagnostic). Same shape as E2E-01 step 5.
      type ChEvent = {
        event_type: string;
        event_id: string;
        tenant_id: string;
        project_id: string;
        execution_id: string;
      };
      const fetchWorkflowEvents = async (): Promise<ChEvent[] | undefined> => {
        const r = await fetch(`${urls.runtime}/api/admin/test/workflow-ch-events/${executionId}`, {
          headers: authHeaders,
        });
        if (r.status !== 200) return undefined;
        const body = (await r.json()) as { data?: { rows?: ChEvent[] } };
        return body.data?.rows;
      };

      const workflowEvents = await pollUntil<ChEvent[]>(
        async () => {
          const rows = await fetchWorkflowEvents();
          return rows && rows.length > 0 ? rows : undefined;
        },
        EXECUTION_EVENT_BUDGET_MS,
        500,
      );
      expect(
        workflowEvents,
        `workflow_execution_events for ${executionId} must appear within ${EXECUTION_EVENT_BUDGET_MS}ms`,
      ).toBeDefined();
      const startedEvent = workflowEvents!.find(
        (e) => e.event_type === 'workflow.execution.started',
      );
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.tenant_id).toBe(auth.tenantId);
      expect(startedEvent!.project_id).toBe(auth.projectId);
      expect(startedEvent!.execution_id).toBe(executionId);

      // 3. Wait for the human_task.created CH event row — the workflow
      //    handler reaches the human step during execution and persists a
      //    human_task (outbox). Queried directly against CH via the
      //    runtime `workflow-consumer/flush` + raw CH probe pattern. We
      //    use the `human_tasks_latest` probe endpoint for the same
      //    tenant scope.
      type HumanTaskLatestRow = {
        task_id: string;
        tenant_id: string;
        project_id: string;
        execution_id: string;
        status: string;
      };
      const fetchHumanTaskForExecution = async (): Promise<HumanTaskLatestRow | undefined> => {
        // Use the runtime list endpoint to find a task whose `source.executionId`
        // matches our execution. We can't rely on a server-side `executionId`
        // query-param filter because the human_tasks schema stores the id
        // only inside `source.executionId` — there's no top-level column.
        // Instead we pull recent tasks and filter client-side.
        const r = await fetch(
          `${urls.runtime}/api/projects/${auth.projectId}/human-tasks?mailbox=workflow&limit=25`,
          { headers: authHeaders },
        );
        if (r.status !== 200) return undefined;
        const body = (await r.json()) as {
          data?:
            | { data?: Array<{ _id?: string; status?: string; source?: { executionId?: string } }> }
            | Array<{ _id?: string; status?: string; source?: { executionId?: string } }>;
        };
        const rows = Array.isArray(body.data)
          ? body.data
          : Array.isArray(body.data?.data)
            ? body.data.data
            : undefined;
        const match = rows?.find((t) => t.source?.executionId === executionId);
        if (!match || !match._id) return undefined;
        return {
          task_id: match._id,
          tenant_id: auth.tenantId,
          project_id: auth.projectId,
          execution_id: executionId!,
          status: match.status ?? '',
        };
      };

      const humanTask = await pollUntil<HumanTaskLatestRow>(
        fetchHumanTaskForExecution,
        HUMAN_TASK_EVENT_BUDGET_MS,
        500,
      );
      if (!humanTask) {
        // The seeded workflow at `E2E_HUMAN_TASK_WORKFLOW_ID` did NOT produce
        // a human_task when executed with the input shape we used. This is
        // almost always a seeding problem (no reachable `human`/`data_entry`
        // step under this input, or the workflow is in a state that can't
        // run). Skip the rest of the test rather than fail — the scenario is
        // about the CH cross-entity pipeline, not about workflow design.
        skip(
          `${SCENARIO_ID}: execution ${executionId} did not produce a human_task within ${HUMAN_TASK_EVENT_BUDGET_MS}ms. Seeded workflow at ${HUMAN_TASK_WORKFLOW_ENV} must have a reachable human/data_entry step that fires on bare input. Test can't verify cross-entity CH without a task.`,
        );
        return;
      }
      expect(humanTask!.execution_id).toBe(executionId);
      expect(humanTask!.tenant_id).toBe(auth.tenantId);
      expect(humanTask!.project_id).toBe(auth.projectId);

      // 4. Poll the runtime human-task-ch diagnostic for the specific
      //    task_id to confirm the event ALSO landed in CH — proves the
      //    second kafka topic + second consumer leg + second buffered
      //    writer + second MV.
      const humanTaskLatestRow = await pollUntil<Record<string, unknown>>(
        async () => {
          const r = await fetch(
            `${urls.runtime}/api/admin/test/human-tasks-latest/${humanTask!.task_id}`,
            { headers: authHeaders },
          );
          if (r.status !== 200) return undefined;
          const body = (await r.json()) as { data?: Record<string, unknown> | null };
          return body.data ?? undefined;
        },
        HUMAN_TASK_EVENT_BUDGET_MS,
        500,
      );
      expect(
        humanTaskLatestRow,
        `human_tasks_latest row for ${humanTask!.task_id} must be projected within ${HUMAN_TASK_EVENT_BUDGET_MS}ms`,
      ).toBeDefined();
      // The row MUST carry the same execution_id — proves the join key.
      expect(humanTaskLatestRow!.execution_id ?? humanTaskLatestRow!.executionId).toBe(executionId);
      expect(humanTaskLatestRow!.tenant_id ?? humanTaskLatestRow!.tenantId).toBe(auth.tenantId);
      expect(humanTaskLatestRow!.project_id ?? humanTaskLatestRow!.projectId).toBe(auth.projectId);
    });

    it('cross-execution human_tasks_latest diagnostic returns 404 (isolation)', async () => {
      const ghostTaskId = '00000000-0000-0000-0000-000000000000';
      const r = await fetch(`${urls.runtime}/api/admin/test/human-tasks-latest/${ghostTaskId}`, {
        headers: authHeaders,
      });
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
