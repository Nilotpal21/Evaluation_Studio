/**
 * Workflow Cron Trigger × Memory Cross-Trigger Continuity E2E (GAP-019)
 *
 * Closes GAP-019 from the workflow-first-class-memory feature spec by
 * driving a real cron-trigger code path end-to-end. Together with E2E-3,
 * E2E-4, E2E-6 this brings the cross-trigger continuity surface (test-spec
 * scenario 5 / FR-7) up to PARTIAL → DONE for the webhook-write+cron-read
 * pairing. The remaining agent leg of E2E-2 stays gated on GAP-018.
 *
 * Per CLAUDE.md "E2E Test Standards": real Studio + Runtime + Workflow
 * Engine + Mongo + Redis + BullMQ. No `vi.mock`, no direct DB access —
 * everything goes through the live HTTP API.
 *
 * Approach (avoids waiting wall-clock minutes for a cron schedule to fire):
 *
 *   1. Create a workflow with a single function node whose body
 *      reads/writes `memory.project.<sentinel>`. The body asserts that on
 *      a cron-fire run, the value MUST be a number (i.e. the prior Studio
 *      direct-run's write was persisted) — if not, the function throws
 *      `CROSS_TRIGGER_CONTINUITY_FAILED` and the workflow run reports
 *      `status: 'failed'`.
 *
 *   2. Studio direct-run #1 — function-author actor writes `1` to the
 *      sentinel. `previous` resolves to `undefined`.
 *
 *   3. POST /api/projects/:projectId/workflows/triggers — register a cron
 *      trigger with a never-fire cron expression (`0 0 31 2 *` — Feb 31
 *      doesn't exist) so BullMQ doesn't actually schedule a real fire and
 *      interfere with the test.
 *
 *   4. POST /api/projects/:projectId/workflows/triggers/:regId/fire —
 *      fires the cron trigger immediately. The engine's
 *      `fireWebhookTrigger()` preserves the registration's `triggerType`
 *      so the workflow run sees `triggerType: 'cron'`, the actor envelope
 *      is `{kind: 'workflow-author'}` (no agentSession), and the payload
 *      carries `assertPersistence: true`.
 *
 *   5. Poll GET /api/projects/:projectId/workflows/:workflowId/executions
 *      /:executionId until terminal. `status === 'completed'` IS the
 *      cross-trigger continuity assertion: it means the cron-fire run
 *      read the value the Studio direct-run had written (otherwise the
 *      function body would have thrown and the run would be `failed`).
 *
 * Cleanup deregisters the cron trigger and deletes the workflow.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  loginAndSetup,
  navigateToWorkflows,
  createWorkflowViaUI,
  waitForCanvasReady,
  addNodeViaHandleMenu,
  saveWorkflow,
  runWorkflow,
  waitForDebugPanel,
  deleteWorkflowFromList,
} from './helpers';

const STUDIO_URL = 'http://localhost:5173';

/** Add an End node after a given source node via the Zustand store. */
async function addEndNodeAfter(page: Page, sourceNodeName: string): Promise<void> {
  await page.evaluate((srcName: string) => {
    const store = (window as unknown as Record<string, unknown>).__zustandStores as
      | Record<string, { getState: () => Record<string, unknown> }>
      | undefined;
    if (!store?.workflowCanvas) throw new Error('Zustand store not found');
    const state = store.workflowCanvas.getState() as {
      nodes: Array<{ id: string; position: { x: number; y: number }; data: { label: string } }>;
      addNode: (
        type: string,
        pos: { x: number; y: number },
        source: { nodeId: string; handleId: string },
      ) => void;
    };
    const srcNode = state.nodes.find((n) => n.data.label === srcName);
    if (!srcNode) throw new Error(`Node "${srcName}" not found`);
    state.addNode(
      'end',
      { x: srcNode.position.x + 300, y: srcNode.position.y },
      { nodeId: srcNode.id, handleId: 'on_success' },
    );
  }, sourceNodeName);
  await page.waitForTimeout(500);
}

/** Configure a function node's code via the Zustand store. */
async function configureFunctionCode(page: Page, nodeName: string, code: string): Promise<void> {
  await page.evaluate(
    ({ name, src }) => {
      const store = (window as unknown as Record<string, unknown>).__zustandStores as
        | Record<string, { getState: () => Record<string, unknown> }>
        | undefined;
      if (!store?.workflowCanvas) throw new Error('Zustand store not found');
      const state = store.workflowCanvas.getState() as {
        nodes: Array<{ id: string; data: { label: string; config: Record<string, unknown> } }>;
        updateNodeConfig: (id: string, config: Record<string, unknown>) => void;
      };
      const node = state.nodes.find((n) => n.data.label === name);
      if (!node) throw new Error(`Node "${name}" not found`);
      state.updateNodeConfig(node.id, {
        ...node.data.config,
        code: src,
        inputVariables: [],
        timeout: 10,
        mode: 'inline',
      });
    },
    { name: nodeName, src: code },
  );
  await page.waitForTimeout(500);
}

/** Wait for the in-Studio debug panel to reach Completed/Failed. */
async function waitForTerminalStatus(page: Page): Promise<{ completed: boolean; failed: boolean }> {
  const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
  const completedBadge = debugPanel.getByText('Completed', { exact: true }).first();
  const failedBadge = debugPanel.getByText('Failed', { exact: true }).first();
  for (let i = 0; i < 45; i++) {
    const completed = await completedBadge.isVisible().catch(() => false);
    const failed = await failedBadge.isVisible().catch(() => false);
    if (completed || failed) return { completed, failed };
    await page.waitForTimeout(1000);
  }
  return { completed: false, failed: false };
}

interface JsonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<JsonResponse> {
  const resp = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return { ok: resp.ok, status: resp.status, body };
}

/**
 * Poll the workflow-engine-proxy execution detail endpoint until the run
 * reaches a terminal status or the deadline expires. Returns the final
 * execution document.
 */
async function pollExecution(
  token: string,
  projectId: string,
  workflowId: string,
  executionId: string,
  deadlineMs = 45_000,
): Promise<{ status: string; raw: Record<string, unknown> }> {
  const start = Date.now();
  let last: Record<string, unknown> = { status: 'unknown' };
  while (Date.now() - start < deadlineMs) {
    const resp = await jsonFetch(
      `${STUDIO_URL}/api/projects/${projectId}/workflows/${workflowId}/executions/${executionId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.ok && resp.body && typeof resp.body === 'object') {
      const data =
        (resp.body as { data?: Record<string, unknown> }).data ??
        (resp.body as Record<string, unknown>);
      last = data;
      const status = (data?.status as string | undefined) ?? 'unknown';
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return { status, raw: data };
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { status: (last.status as string | undefined) ?? 'timeout', raw: last };
}

test.describe('Workflow Cron Trigger × Memory Cross-Trigger Continuity (GAP-019)', () => {
  test('cron fire reads memory.project.* written by a prior Studio direct-run', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { projectId, token } = await loginAndSetup(page);
    const workflowName = `CronMemE2E_${Date.now()}`;
    // Sentinel key is unique per test invocation so cross-test residue can't
    // mask a real regression.
    const sentinelKey = `cnt_${Date.now()}`;
    let workflowId = '';
    let registrationId: string | null = null;

    try {
      // ───────────────────────────────────────────────────────────────────
      // SETUP — single workflow, single function node. Function body
      // reads-then-writes the sentinel; throws on a cron-fire run if
      // `previous` is not a number (cross-trigger continuity assertion).
      // ───────────────────────────────────────────────────────────────────
      await navigateToWorkflows(page);
      workflowId = await createWorkflowViaUI(
        page,
        workflowName,
        'GAP-019: cron-fire reads memory.project written by prior run',
      );
      await waitForCanvasReady(page);

      await addNodeViaHandleMenu(page, 'function');
      await page.waitForTimeout(500);

      const fnBody = `
        const previous = memory.project.get(${JSON.stringify(sentinelKey)});
        const triggerPayload = (context && context.trigger && context.trigger.payload) || {};
        const assertPersistence = triggerPayload.assertPersistence === true;
        if (assertPersistence && typeof previous !== 'number') {
          throw new Error('CROSS_TRIGGER_CONTINUITY_FAILED: previous=' + JSON.stringify(previous));
        }
        const base = typeof previous === 'number' ? previous : 0;
        const next = base + 1;
        memory.project.set(${JSON.stringify(sentinelKey)}, next);
        workflow.setOutput({
          previous: typeof previous === 'number' ? previous : null,
          next,
          triggerType: (context && context.trigger && context.trigger.type) || 'unknown',
        });
      `;
      await configureFunctionCode(page, 'Function0001', fnBody);
      await addEndNodeAfter(page, 'Function0001');
      await saveWorkflow(page);

      // ───────────────────────────────────────────────────────────────────
      // RUN 1 — Studio direct-run (workflow-author actor).
      // Writes 1 to memory.project.<sentinel>. assertPersistence is
      // undefined (no trigger payload), so no throw on the undefined read.
      // ───────────────────────────────────────────────────────────────────
      await runWorkflow(page);
      await waitForDebugPanel(page);
      const run1 = await waitForTerminalStatus(page);
      expect(run1.completed, 'Studio direct-run #1 must complete (writes baseline value)').toBe(
        true,
      );

      // ───────────────────────────────────────────────────────────────────
      // RUN 2 — Register cron trigger via the engine API and fire it
      // immediately. Cron expression "0 0 31 2 *" (Feb 31 — never fires)
      // keeps BullMQ's repeatable-job scheduler from kicking off a real
      // fire that would race with the test.
      // ───────────────────────────────────────────────────────────────────
      const triggerCreate = await jsonFetch(
        `${STUDIO_URL}/api/projects/${projectId}/workflows/triggers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            workflowId,
            triggerType: 'cron',
            config: { cronExpression: '0 0 31 2 *' },
          }),
        },
      );
      expect(
        triggerCreate.ok,
        `Cron trigger create failed: ${triggerCreate.status} ${JSON.stringify(triggerCreate.body)}`,
      ).toBe(true);
      const triggerData = (
        triggerCreate.body as { data?: { registrationId?: string }; registrationId?: string }
      ).data;
      registrationId = triggerData?.registrationId ?? null;
      expect(registrationId, 'registrationId missing on cron trigger create response').toBeTruthy();

      // Fire the cron trigger immediately. The engine preserves the
      // registration's triggerType, so the run sees triggerType='cron'.
      const fireResp = await jsonFetch(
        `${STUDIO_URL}/api/projects/${projectId}/workflows/triggers/${registrationId}/fire`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ assertPersistence: true }),
        },
      );
      expect(
        fireResp.ok,
        `Cron trigger /fire failed: ${fireResp.status} ${JSON.stringify(fireResp.body)}`,
      ).toBe(true);
      const fireData = (fireResp.body as { data?: { executionId?: string }; executionId?: string })
        .data;
      const executionId = fireData?.executionId;
      expect(executionId, 'executionId missing on cron-fire response').toBeTruthy();

      // ───────────────────────────────────────────────────────────────────
      // ASSERT — poll the cron-fire execution. status === 'completed' IS
      // the cross-trigger continuity assertion: the function body throws
      // on missing `previous`, so a completed status means the runtime
      // read the Studio-direct-run's persisted value.
      // ───────────────────────────────────────────────────────────────────
      const exec = await pollExecution(token, projectId, workflowId, executionId!);
      expect(
        exec.status,
        `Cron-fire execution should complete (proves memory.project read carried across triggers). raw=${JSON.stringify(
          exec.raw,
        ).slice(0, 500)}`,
      ).toBe('completed');
    } finally {
      // Deregister the cron trigger BEFORE deleting the workflow so the
      // engine doesn't complain about an orphaned registration.
      if (registrationId) {
        await fetch(
          `${STUDIO_URL}/api/projects/${projectId}/workflows/triggers/${registrationId}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          },
        ).catch(() => {});
      }
      // Best-effort sentinel cleanup (project-scope memory). A new test
      // invocation uses a different sentinel key, so this is just hygiene.
      if (workflowId) {
        await navigateToWorkflows(page);
        await deleteWorkflowFromList(page, workflowName).catch(() => {});
      }
    }
  });
});
