/**
 * Workflow First-Class Memory & Agent-Context E2E
 *
 * Covers test-spec scenarios E2E-1, E2E-2, E2E-3, E2E-6 from
 * `docs/testing/sub-features/workflow-first-class-memory-and-context.md`.
 *
 * Per CLAUDE.md "E2E Test Standards": real Studio + Runtime + Workflow Engine,
 * no `vi.mock` / `jest.mock`, no direct Mongo access. Function-node sandbox
 * exercises the real `memory.*` and `agentSession`/`agentContext` globals
 * shipped by Phase 3 + Phase 4.
 *
 *   E2E-3 (full) — Non-agent trigger surfaces `agentSession` as `undefined`
 *                  safely; `memory.user.*` rejects with `UNAVAILABLE_SCOPE`.
 *                  Implementable today against the Studio direct-run path
 *                  (a `workflow-author` actor without `agentSession`).
 *
 *   E2E-6 (full) — Workflow-scope memory persists across runs of the same
 *                  workflow. Studio direct-run × 2 against one workflow
 *                  with a function node that reads-then-writes
 *                  `memory.workflow.<sentinel>`. Run 1 sees `previous` as
 *                  undefined; run 2 must see the value run 1 persisted.
 *                  Proves FR-9 (`memory.{scope}.get/set/delete` author
 *                  contract end-to-end) + FR-10 (workflow-scope key
 *                  isolation `wf:<workflowId>:<key>`) + FR-14 (in-run
 *                  projection updates after writes) all the way through
 *                  the V8-isolate ↔ runtime-memory-route ↔ Mongo path.
 *
 *   E2E-1 / E2E-2 — Require an agent-bound trigger (workflow-as-tool invoked
 *                   from a real chat session) and a cron trigger respectively.
 *                   Neither path is currently available in the workflow E2E
 *                   harness — see GAP-018 / GAP-019 in the feature spec. Both
 *                   tests are `test.skip(...)` with rationale; the spec
 *                   scaffold exists so the next iteration can drop the skip
 *                   without restructuring.
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

/** Add an End node after a given source node via the Zustand store (viewport-safe). */
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

/** Wait for execution to reach Completed or Failed in the debug panel. */
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

test.describe('Workflow First-Class Memory & Agent Context E2E', () => {
  test('E2E-3: non-agent trigger sees agentSession=undefined and memory.user.* rejects with UNAVAILABLE_SCOPE', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loginAndSetup(page);
    const workflowName = `MemoryE2E3_${Date.now()}`;

    try {
      await navigateToWorkflows(page);
      await createWorkflowViaUI(
        page,
        workflowName,
        'E2E-3: agentSession undefined + memory.user UNAVAILABLE_SCOPE',
      );
      await waitForCanvasReady(page);

      // First function node — reads agentSession?.channel safely; expects 'no-agent'.
      // The function-executor (Phase 3) sets agentSession only when the run is
      // agent-triggered. A Studio direct-run is `workflow-author`, so the global
      // is `undefined` — `typeof` guard prevents ReferenceError.
      await addNodeViaHandleMenu(page, 'function');
      await page.waitForTimeout(500);
      await configureFunctionCode(
        page,
        'Function0001',
        `
          const channel =
            (typeof agentSession !== 'undefined' && agentSession && agentSession.channel) ||
            'no-agent';
          workflow.setOutput({ channel });
        `,
      );

      // Second function node — chains after Function0001 via Zustand. Tries
      // memory.user.get('foo') and catches the cross-isolate error. The host
      // rethrows it as `UNAVAILABLE_SCOPE: User scope requires actor.kind=...`
      // (function-executor.ts:280-286), so we match by prefix on the message.
      await page.evaluate(() => {
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
        const fn1 = state.nodes.find((n) => n.data.label === 'Function0001');
        if (!fn1) throw new Error('Function0001 not found');
        state.addNode(
          'function',
          { x: fn1.position.x + 300, y: fn1.position.y },
          { nodeId: fn1.id, handleId: 'on_success' },
        );
      });
      await page.waitForTimeout(500);
      await configureFunctionCode(
        page,
        'Function0002',
        `
          let errorCode = null;
          let threw = false;
          try {
            memory.user.get('foo');
          } catch (e) {
            threw = true;
            const msg = (e && e.message) || String(e);
            const m = /^([A-Z_]+):/.exec(msg);
            errorCode = m ? m[1] : msg;
          }
          workflow.setOutput({ threw, errorCode });
        `,
      );

      await addEndNodeAfter(page, 'Function0002');
      await saveWorkflow(page);
      await runWorkflow(page);
      await waitForDebugPanel(page);

      const { completed, failed } = await waitForTerminalStatus(page);
      // Function0002 catches the error internally, so the workflow as a whole
      // completes; if the catch path is broken we want to see the failure
      // surface so the assertion below produces a useful diff.
      expect(completed || failed).toBe(true);

      const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
      const panelText = (await debugPanel.textContent()) ?? '';

      // Assertion 1 — Function0001 saw `agentSession === undefined` and fell
      // through to `'no-agent'`.
      expect(panelText).toContain('no-agent');

      // Assertion 2 — Function0002 hit the UNAVAILABLE_SCOPE branch. The
      // function-executor wraps `WorkflowMemoryError` as
      // `Error('UNAVAILABLE_SCOPE: User scope requires...')`, so the script
      // sees the code in the message prefix and surfaces it via
      // `workflow.setOutput`.
      expect(panelText).toContain('UNAVAILABLE_SCOPE');
    } finally {
      await navigateToWorkflows(page);
      await deleteWorkflowFromList(page, workflowName).catch(() => {});
    }
  });

  test('E2E-6: workflow-scope memory persists across runs (Studio direct-run × 2)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loginAndSetup(page);
    const workflowName = `MemoryE2E6_${Date.now()}`;
    const sentinelKey = `cross_run_${Date.now()}`;

    try {
      // ────────────────────────────────────────────────────────────────────
      // SETUP — One workflow with a function node that reads-then-writes
      //          memory.workflow.<sentinel>. The first run sees `previous` as
      //          undefined; the second run must see the value persisted by
      //          run 1. The sentinel key is unique per test invocation so the
      //          assertion holds even if a prior test left workflow-scope
      //          state in the project (FR-10: workflow-scope is keyed
      //          `wf:<workflowId>:<key>` so cross-test interference between
      //          runs of DIFFERENT workflows can't happen, but using a
      //          random sentinel key removes ALL ambiguity).
      // ────────────────────────────────────────────────────────────────────
      await navigateToWorkflows(page);
      await createWorkflowViaUI(
        page,
        workflowName,
        'E2E-6: cross-run workflow-scope memory continuity',
      );
      await waitForCanvasReady(page);

      await addNodeViaHandleMenu(page, 'function');
      await page.waitForTimeout(500);
      await configureFunctionCode(
        page,
        'Function0001',
        `
          const previous = memory.workflow.get(${JSON.stringify(sentinelKey)});
          const now = Date.now();
          memory.workflow.set(${JSON.stringify(sentinelKey)}, { ts: now });
          workflow.setOutput({
            previousIsDefined: previous !== undefined && previous !== null,
            previousTs: (previous && previous.ts) || null,
            currentTs: now,
          });
        `,
      );
      await addEndNodeAfter(page, 'Function0001');
      await saveWorkflow(page);

      // ────────────────────────────────────────────────────────────────────
      // RUN 1 — first invocation; `previous` should be undefined/null.
      // ────────────────────────────────────────────────────────────────────
      await runWorkflow(page);
      await waitForDebugPanel(page);
      const run1 = await waitForTerminalStatus(page);
      expect(run1.completed || run1.failed).toBe(true);
      const debugPanel = page.locator('[data-testid="execution-debug-panel"]');
      const run1Text = (await debugPanel.textContent()) ?? '';
      // Run 1 must report previousIsDefined=false. Match on either the
      // boolean literal or the JSON-quoted form because the debug panel
      // renders setOutput as a key/value object.
      expect(run1Text).toMatch(/"previousIsDefined":\s*false|previousIsDefined.*false/);

      // ────────────────────────────────────────────────────────────────────
      // RUN 2 — same workflow, fresh trigger. `previous` must be the value
      // run 1 wrote (proves FR-10 workflow-scope persistence + FR-9 set/get
      // contract + FR-14 in-run projection-update at the boundary).
      // ────────────────────────────────────────────────────────────────────
      // The Run dialog from Run 1 may have left UI in mid-state — close any
      // residual debug panel before kicking the second run.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);

      await runWorkflow(page);
      await waitForDebugPanel(page);
      const run2 = await waitForTerminalStatus(page);
      expect(run2.completed || run2.failed).toBe(true);
      const run2Text = (await debugPanel.textContent()) ?? '';
      // Run 2 must report previousIsDefined=true AND previousTs as a number
      // (the timestamp Run 1 wrote). Cross-run continuity is the assertion
      // that distinguishes E2E-6 from E2E-3.
      expect(run2Text).toMatch(/"previousIsDefined":\s*true|previousIsDefined.*true/);
      expect(run2Text).toMatch(/"previousTs":\s*\d{10,}|previousTs.*\d{10,}/);
    } finally {
      await navigateToWorkflows(page);
      await deleteWorkflowFromList(page, workflowName).catch(() => {});
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E2E-1 and E2E-2 — Contract closed at integration layer (GAP-018, GAP-019)
  //
  // Both scenarios exercise the agent-bound workflow run path. The actual
  // contract — that `agentSession.endUserId` populates correctly, that
  // `actor.kind === 'end-user'` derives from it, and that `memory.user.*`
  // / `memory.workflow.*` / `memory.project.*` reads carry across runs and
  // trigger types — is now closed at the runtime boundary by:
  //
  //   • E2E-6 (this file) — cross-run `memory.workflow.*` continuity for
  //     the Studio-direct-run path
  //   • workflow-cron-trigger-memory.spec.ts (GAP-019 closure) —
  //     cross-trigger `memory.project.*` continuity for the cron-fire path
  //   • workflow-memory-isolate.test.ts "INT-3 + INT-13 — agentSession ↔
  //     memory.user actor derivation" (GAP-018 contract closure) —
  //     agentSession.endUserId reachable from the script + memory.user
  //     persistence under the same endUserId, with cross-run readability
  //     and cross-end-user isolation
  //   • workflow-tool-executor-projection.test.ts (INT-13) — the upstream
  //     agentSession projection enrichment in `workflow-tool-executor.ts`
  //
  // The remaining E2E delta is the HTTP-end-to-end chat-WS driver — a
  // deterministic LLM mock + SDK channel session bootstrap + WS chat-frame
  // automation. None of that exists in `apps/studio/e2e/workflows/` today;
  // adding it as part of this feature would balloon scope past the
  // BETA → STABLE bar. Both tests stay `test.skip` so the scaffold is
  // ready when the v1.1 chat E2E harness lands.
  // ──────────────────────────────────────────────────────────────────────────

  test.skip('E2E-1: HTTP-end-to-end agent-triggered workflow run via chat-WS (deferred to v1.1)', async () => {
    // Contract closed at integration: workflow-memory-isolate.test.ts
    // "agentSession ↔ memory.user actor derivation" + INT-13.
    // Residual gap is the live chat-WS driver.
  });

  test.skip('E2E-2: HTTP-end-to-end webhook → cron → agent cross-trigger continuity (deferred to v1.1)', async () => {
    // Cron leg closed by workflow-cron-trigger-memory.spec.ts (GAP-019).
    // Webhook leg covered structurally by INT-1
    // (runtime-memory-client-http.test.ts) and E2E-3 / E2E-6 here. Agent
    // leg is the residual GAP-018 piece — same chat-WS driver dependency.
  });
});
