# Workflow Triggers & Actions Readiness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make workflows, triggers, and actions fully consumable end-to-end in Studio and runtime — fixing 10 confirmed issues across API wiring, data contracts, Restate suspension, step handlers, trigger lifecycle, and creation UX.

**Architecture:** Runtime becomes the API gateway for all workflow operations, proxying execution/approval/callback requests to workflow-engine. Studio adapts to the `{ success, data }` response envelope. Restate durable primitives (`ctx.sleep`, `ctx.promise`) provide real suspension for delay/approval/webhook steps. A BullMQ-backed TriggerEngine handles cron, polling, and webhook triggers end-to-end.

**Tech Stack:** Express.js (runtime proxy), Restate SDK v1.10+ (durable execution), BullMQ (trigger scheduling), MongoDB/Mongoose (persistence), React/Zustand/SWR (Studio), Vitest (testing)

---

## Phase 1: Quick Fixes (Callback URL, entryAgent, step type normalization)

### Task 1.1: Fix callback URL mismatch

**Finding:** URL builder emits `/callbacks/:executionId/steps/:stepId` but router expects `/callbacks/:executionId/:stepId`

**Files:**

- Modify: `apps/workflow-engine/src/index.ts:331-332`
- Test: `apps/workflow-engine/src/__tests__/callback-url.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/workflow-engine/src/__tests__/callback-url.test.ts
import { describe, it, expect } from 'vitest';

describe('CallbackUrlBuilder', () => {
  it('should build URL matching the callback router pattern /:executionId/:stepId', () => {
    const PUBLIC_URL = 'https://engine.example.com';
    const builder = {
      buildCallbackUrl: (executionId: string, stepId: string) =>
        `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}`,
    };
    const url = builder.buildCallbackUrl('exec-123', 'step-456');
    expect(url).toBe('https://engine.example.com/api/v1/workflows/callbacks/exec-123/step-456');
    // Must NOT contain '/steps/' segment
    expect(url).not.toContain('/steps/');
  });
});
```

**Step 2: Run test to verify it passes (test defines correct behavior)**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/callback-url.test.ts`

**Step 3: Fix the URL builder in index.ts**

In `apps/workflow-engine/src/index.ts`, change line 332:

```typescript
// Before:
buildCallbackUrl: (executionId: string, stepId: string) =>
  `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/steps/${stepId}`,

// After:
buildCallbackUrl: (executionId: string, stepId: string) =>
  `${PUBLIC_URL}/api/v1/workflows/callbacks/${executionId}/${stepId}`,
```

**Step 4: Commit**

```bash
git add apps/workflow-engine/src/index.ts apps/workflow-engine/src/__tests__/callback-url.test.ts
git commit -m "fix(workflow-engine): align callback URL builder with router pattern"
```

---

### Task 1.2: Remove entryAgent from runtime create endpoint

**Finding:** Runtime create endpoint requires `entryAgent` but DB schema has no such field. User decision: just use steps.

**Files:**

- Modify: `apps/runtime/src/routes/workflows.ts:97` (remove entryAgent from Zod schema)
- Modify: `apps/runtime/src/routes/workflows.ts:176-211` (remove from create handler)

**Step 1: Remove `entryAgent` from the create request Zod schema**

In `apps/runtime/src/routes/workflows.ts`, find the create body schema and remove the `entryAgent` field. Keep `steps` as required.

**Step 2: Remove any `entryAgent` references in the create handler**

If the handler passes `entryAgent` to the store, remove it. The workflow definition is driven by `steps` array.

**Step 3: Run existing workflow tests**

Run: `cd apps/runtime && pnpm vitest run --testPathPattern workflow`
Expected: PASS (or fix any tests that reference entryAgent)

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/workflows.ts
git commit -m "fix(runtime): remove entryAgent from workflow create endpoint — steps array is source of truth"
```

---

### Task 1.3: Normalize step types — Studio uses engine-canonical names

**Finding:** Studio emits `http_request` but engine/DB expect `http`. Studio has `loop`/`transform` which need adding to engine.

**Files:**

- Modify: `apps/studio/src/components/workflows/steps/StepTypeSelector.tsx:30-39` (rename `http_request` → `http`)
- Modify: `apps/studio/src/components/workflows/steps/StepEditor.tsx` (update type checks)
- Modify: `packages/database/src/models/workflow.model.ts:153-166` (add `loop`, `transform` to enum)

**Step 1: Rename `http_request` → `http` in StepTypeSelector**

Update the step type definition and the corresponding entry in the step list. The `id` field should be `'http'`, the label can remain "HTTP Request".

**Step 2: Update StepEditor type-specific config mapping**

Any switch/if statements in StepEditor that match on `'http_request'` should be changed to `'http'`.

**Step 3: Add `loop` and `transform` to DB model step type enum**

In `packages/database/src/models/workflow.model.ts`, add `'loop'` and `'transform'` to the step type enum array (around line 157).

**Step 4: Build and verify**

Run: `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/database`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/workflows/steps/StepTypeSelector.tsx \
       apps/studio/src/components/workflows/steps/StepEditor.tsx \
       packages/database/src/models/workflow.model.ts
git commit -m "fix: normalize step types — Studio uses engine-canonical names (http, loop, transform)"
```

---

## Phase 2: Studio Data Contract Alignment

### Task 2.1: Update Studio API client to consume `{ success, data }` envelope

**Finding:** Studio API functions expect `{ workflows: [...] }`, `{ workflow: {...} }`, `{ executions: [...] }` but runtime returns `{ success, data }`.

**Files:**

- Modify: `apps/studio/src/api/workflows.ts` (all API functions)

**Step 1: Update `listWorkflows()` to destructure `data` from envelope**

```typescript
export async function listWorkflows(projectId: string): Promise<WorkflowSummary[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`);
  const json = await handleResponse(response);
  return json.data ?? [];
}
```

**Step 2: Update `getWorkflow()` similarly**

```typescript
export async function getWorkflow(projectId: string, workflowId: string): Promise<WorkflowDetail> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}`,
  );
  const json = await handleResponse(response);
  return json.data;
}
```

**Step 3: Update all remaining functions (`createWorkflow`, `updateWorkflow`, `deleteWorkflow`, `executeWorkflow`, `listExecutions`, `getExecution`, `approveStep`)**

Each should destructure the response as `json.data` instead of `json.workflow`, `json.execution`, etc.

**Step 4: Commit**

```bash
git add apps/studio/src/api/workflows.ts
git commit -m "fix(studio): update workflow API client to consume { success, data } envelope"
```

---

### Task 2.2: Update Studio SWR hooks to match new API client return shapes

**Files:**

- Modify: `apps/studio/src/hooks/useWorkflows.ts`
- Modify: `apps/studio/src/hooks/useWorkflowDetail.ts`

**Step 1: Update `useWorkflows` hook**

The SWR fetcher returns `{ success, data, total }`. Update the hook to extract `data`:

```typescript
// The fetcher returns { success: true, data: WorkflowSummary[], total: number }
const workflows = data?.data ?? [];
```

**Step 2: Update `useWorkflowDetail` hook**

```typescript
// The fetcher returns { success: true, data: WorkflowDetail }
const workflow = data?.data ?? null;
```

**Step 3: Update `useWorkflowExecutions` hook**

```typescript
// The fetcher returns { success: true, data: WorkflowExecution[] }
const executions = data?.data ?? [];
```

**Step 4: Commit**

```bash
git add apps/studio/src/hooks/useWorkflows.ts apps/studio/src/hooks/useWorkflowDetail.ts
git commit -m "fix(studio): update workflow SWR hooks to destructure { success, data } envelope"
```

---

### Task 2.3: Fix approve request body — Studio sends `{ decision, reason }` to match engine

**Finding:** Studio sends `{ approved, comment }`, engine expects `{ decision: 'approve'|'reject', reason }`.

**Files:**

- Modify: `apps/studio/src/api/workflows.ts` (approveStep function)

**Step 1: Update `approveStep()` to send engine-compatible body**

```typescript
export async function approveStep(
  projectId: string,
  workflowId: string,
  executionId: string,
  stepId: string,
  decision: { approved: boolean; comment?: string },
): Promise<{ success: boolean }> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}/steps/${encodeURIComponent(stepId)}/approve`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      decision: decision.approved ? 'approve' : 'reject',
      reason: decision.comment,
    }),
  });
  return handleResponse(response);
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/api/workflows.ts
git commit -m "fix(studio): align approve request body with engine contract ({ decision, reason })"
```

---

### Task 2.4: Fix status enum mismatch (Studio `draft` vs runtime `archived`)

**Finding:** Runtime defines `'active' | 'paused' | 'archived'`; Studio summary expects `'active' | 'paused' | 'draft'`.

**Files:**

- Modify: `apps/studio/src/api/workflows.ts` (WorkflowSummary type)
- Modify: `apps/studio/src/components/workflows/WorkflowsListPage.tsx` (statusFilterOptions)

**Step 1: Update `WorkflowSummary.status` type to match runtime**

```typescript
status: 'active' | 'paused' | 'archived';
```

**Step 2: Update `statusFilterOptions` in WorkflowsListPage**

Replace `'draft'` with `'archived'` in the filter options.

**Step 3: Commit**

```bash
git add apps/studio/src/api/workflows.ts apps/studio/src/components/workflows/WorkflowsListPage.tsx
git commit -m "fix(studio): align workflow status enum with runtime (archived, not draft)"
```

---

## Phase 3: Runtime Gateway Wiring

### Task 3.1: Add workflow-engine proxy middleware to runtime

**Finding:** Studio proxies all `/workflows/...` to runtime, but runtime has no routes for execution/approval/callback operations that live on workflow-engine.

**Files:**

- Create: `apps/runtime/src/middleware/workflow-engine-proxy.ts`
- Modify: `apps/runtime/src/server.ts` (mount proxy)

**Step 1: Create the proxy middleware**

Runtime needs to forward these paths to workflow-engine:

- `POST /api/projects/:projectId/workflows/:workflowId/executions/execute` → engine `POST /api/v1/projects/:projectId/workflows/:workflowId/executions/execute`
- `GET /api/projects/:projectId/workflows/:workflowId/executions` → engine `GET /api/v1/projects/:projectId/workflows/:workflowId/executions`
- `GET /api/projects/:projectId/workflows/:workflowId/executions/:executionId` → engine `GET /api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId`
- `POST /api/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel` → engine `POST /api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel`
- `GET /api/projects/:projectId/approvals` → engine `GET /api/v1/projects/:projectId/approvals`
- `POST /api/projects/:projectId/approvals/:workflowId/executions/:executionId/steps/:stepId/approve` → engine
- `POST /api/projects/:projectId/triggers` → engine
- `DELETE/POST /api/projects/:projectId/triggers/:registrationId/...` → engine
- `GET /api/projects/:projectId/connectors` → engine `GET /api/v1/connectors`

```typescript
// apps/runtime/src/middleware/workflow-engine-proxy.ts
import { Router, type Request, type Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { WORKFLOW_ENGINE_URL } from '@agent-platform/shared/constants';

const log = createLogger('runtime:workflow-engine-proxy');

/**
 * Proxy router that forwards workflow execution/approval/trigger requests
 * from runtime to workflow-engine. Runtime is the API gateway; workflow-engine
 * owns execution logic.
 */
export function createWorkflowEngineProxy(): Router {
  const router = Router({ mergeParams: true });
  const engineBase = WORKFLOW_ENGINE_URL || 'http://localhost:9080';

  async function proxy(req: Request, res: Response, enginePath: string) {
    const url = `${engineBase}${enginePath}`;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      // Forward auth headers
      if (req.headers.authorization) {
        headers['authorization'] = req.headers.authorization as string;
      }
      // Forward tenant context headers set by auth middleware
      const tenantId = (req as any).tenantContext?.tenantId;
      if (tenantId) headers['x-tenant-id'] = tenantId;

      const fetchOpts: RequestInit = {
        method: req.method,
        headers,
        signal: AbortSignal.timeout(120_000),
      };
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body) {
        fetchOpts.body = JSON.stringify(req.body);
      }

      const response = await fetch(url, fetchOpts);
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err) {
      log.error('Workflow engine proxy error', {
        path: enginePath,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ success: false, error: 'Workflow engine unavailable' });
    }
  }

  // Executions
  router.post('/:workflowId/executions/execute', (req, res) => {
    const { projectId, workflowId } = req.params;
    proxy(req, res, `/api/v1/projects/${projectId}/workflows/${workflowId}/executions/execute`);
  });

  router.get('/:workflowId/executions', (req, res) => {
    const { projectId, workflowId } = req.params;
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    proxy(
      req,
      res,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/executions${qs ? '?' + qs : ''}`,
    );
  });

  router.get('/:workflowId/executions/:executionId', (req, res) => {
    const { projectId, workflowId, executionId } = req.params;
    proxy(
      req,
      res,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/executions/${executionId}`,
    );
  });

  router.post('/:workflowId/executions/:executionId/cancel', (req, res) => {
    const { projectId, workflowId, executionId } = req.params;
    proxy(
      req,
      res,
      `/api/v1/projects/${projectId}/workflows/${workflowId}/executions/${executionId}/cancel`,
    );
  });

  // Approvals (mounted under /workflows parent in runtime)
  router.get('/approvals', (req, res) => {
    const { projectId } = req.params;
    proxy(req, res, `/api/v1/projects/${projectId}/approvals`);
  });

  router.post(
    '/approvals/:workflowId/executions/:executionId/steps/:stepId/approve',
    (req, res) => {
      const { projectId, workflowId, executionId, stepId } = req.params;
      proxy(
        req,
        res,
        `/api/v1/projects/${projectId}/approvals/${workflowId}/executions/${executionId}/steps/${stepId}/approve`,
      );
    },
  );

  return router;
}
```

**Step 2: Mount proxy in runtime server.ts**

After the existing `app.use('/api/projects/:projectId/workflows', workflowsRouter)` line, add:

```typescript
import { createWorkflowEngineProxy } from './middleware/workflow-engine-proxy.js';

// Workflow execution/approval proxy — forwards to workflow-engine
app.use('/api/projects/:projectId/workflows', createWorkflowEngineProxy());
```

Note: Express matches routes in order. The existing `workflowsRouter` handles CRUD (GET/, GET/:id, POST/, PUT/:id, POST/:id/archive). The proxy handles execution paths (POST/:id/executions/execute, etc.) which don't conflict because the proxy uses more specific paths.

**Step 3: Add `WORKFLOW_ENGINE_URL` to shared constants**

In `packages/config/src/constants.ts` or `packages/shared`, add:

```typescript
export const WORKFLOW_ENGINE_URL = process.env.WORKFLOW_ENGINE_URL || 'http://localhost:9080';
```

**Step 4: Commit**

```bash
git add apps/runtime/src/middleware/workflow-engine-proxy.ts apps/runtime/src/server.ts packages/config/src/constants.ts
git commit -m "feat(runtime): add workflow-engine proxy — runtime is the API gateway for execution/approval/trigger operations"
```

---

### Task 3.2: Add trigger and connector proxy routes

**Files:**

- Modify: `apps/runtime/src/middleware/workflow-engine-proxy.ts` (add trigger/connector routes)
- Modify: `apps/runtime/src/server.ts` (mount trigger routes under projects)

**Step 1: Add trigger routes to the proxy**

```typescript
// Triggers
router.post('/triggers', (req, res) => {
  const { projectId } = req.params;
  proxy(req, res, `/api/v1/projects/${projectId}/triggers`);
});

router.delete('/triggers/:registrationId', (req, res) => {
  const { projectId, registrationId } = req.params;
  proxy(req, res, `/api/v1/projects/${projectId}/triggers/${registrationId}`);
});

router.post('/triggers/:registrationId/pause', (req, res) => {
  const { projectId, registrationId } = req.params;
  proxy(req, res, `/api/v1/projects/${projectId}/triggers/${registrationId}/pause`);
});

router.post('/triggers/:registrationId/resume', (req, res) => {
  const { projectId, registrationId } = req.params;
  proxy(req, res, `/api/v1/projects/${projectId}/triggers/${registrationId}/resume`);
});
```

**Step 2: Add connectors proxy (mount separately since it's not project-scoped in engine)**

In runtime server.ts, add a connectors proxy route:

```typescript
// Connectors proxy — engine serves at /api/v1/connectors
app.get('/api/projects/:projectId/connectors', authMiddleware, async (req, res) => {
  // Proxy to workflow-engine connectors endpoint
  const engineUrl = `${WORKFLOW_ENGINE_URL}/api/v1/connectors`;
  // ... proxy logic
});
```

Or reuse the proxy middleware by adding a connector route.

**Step 3: Commit**

```bash
git add apps/runtime/src/middleware/workflow-engine-proxy.ts apps/runtime/src/server.ts
git commit -m "feat(runtime): add trigger and connector proxy routes to workflow-engine gateway"
```

---

## Phase 4: Restate Context Threading — Real Suspension

### Task 4.1: Thread Restate WorkflowContext into runWorkflow

**Finding:** `runWorkflow()` doesn't receive `ctx` (Restate WorkflowContext), so it can't use `ctx.sleep()`, `ctx.promise()`.

**Files:**

- Modify: `apps/workflow-engine/src/handlers/workflow-handler.ts` (add `restateCtx` parameter)
- Modify: `apps/workflow-engine/src/services/restate-endpoint.ts` (pass `ctx` to `runWorkflow`)
- Test: `apps/workflow-engine/src/__tests__/workflow-handler-suspension.test.ts`

**Step 1: Write the failing test for delay suspension**

```typescript
// apps/workflow-engine/src/__tests__/workflow-handler-suspension.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runWorkflow, type WorkflowExecutionInput } from '../handlers/workflow-handler.js';

describe('workflow suspension via Restate context', () => {
  it('should call restateCtx.sleep for delay steps', async () => {
    const mockRestateCtx = {
      sleep: vi.fn().mockResolvedValue(undefined),
      promise: vi.fn().mockReturnValue({
        peek: vi.fn().mockResolvedValue(null),
        get: vi.fn(),
        resolve: vi.fn(),
      }),
    };

    const input: WorkflowExecutionInput = {
      workflowId: 'wf-1',
      workflowName: 'Test',
      tenantId: 't-1',
      projectId: 'p-1',
      triggerType: 'manual',
      triggerPayload: {},
      steps: [
        { id: 'step-delay', type: 'delay', config: { duration: 5000, unit: 'milliseconds' } },
      ],
    };

    const mockPersistence = {
      createExecution: vi.fn().mockResolvedValue(undefined),
      updateStepStatus: vi.fn().mockResolvedValue(undefined),
      updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockPublisher = { publish: vi.fn().mockResolvedValue(undefined) };

    const result = await runWorkflow(
      input,
      'exec-1',
      {
        persistence: mockPersistence,
        publisher: mockPublisher,
        dispatcherDeps: {},
      },
      mockRestateCtx as any,
    );

    expect(mockRestateCtx.sleep).toHaveBeenCalledWith(5000);
    expect(result.status).toBe('completed');
  });

  it('should call restateCtx.promise().get() for approval steps', async () => {
    const mockPromise = {
      peek: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue({ approved: true, decidedBy: 'user-1' }),
      resolve: vi.fn(),
    };
    const mockRestateCtx = {
      sleep: vi.fn(),
      promise: vi.fn().mockReturnValue(mockPromise),
    };

    const input: WorkflowExecutionInput = {
      workflowId: 'wf-1',
      workflowName: 'Test',
      tenantId: 't-1',
      projectId: 'p-1',
      triggerType: 'manual',
      triggerPayload: {},
      steps: [
        {
          id: 'step-approval',
          type: 'approval',
          config: { title: 'Approve this', approvers: ['admin'] },
        },
      ],
    };

    const mockPersistence = {
      createExecution: vi.fn().mockResolvedValue(undefined),
      updateStepStatus: vi.fn().mockResolvedValue(undefined),
      updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockPublisher = { publish: vi.fn().mockResolvedValue(undefined) };

    const result = await runWorkflow(
      input,
      'exec-1',
      {
        persistence: mockPersistence,
        publisher: mockPublisher,
        dispatcherDeps: {},
      },
      mockRestateCtx as any,
    );

    expect(mockRestateCtx.promise).toHaveBeenCalledWith('approval:step-approval');
    expect(mockPromise.get).toHaveBeenCalled();
    expect(result.status).toBe('completed');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/workflow-handler-suspension.test.ts`
Expected: FAIL — `runWorkflow` doesn't accept 4th argument yet

**Step 3: Add optional `restateCtx` parameter to `runWorkflow`**

```typescript
// workflow-handler.ts

/** Minimal interface for Restate context operations needed by the handler */
export interface RestateWorkflowCtx {
  sleep(ms: number): Promise<void>;
  promise<T>(name: string): {
    peek(): Promise<T | null>;
    get(): Promise<T>;
    resolve(value: T): Promise<void>;
  };
}

export async function runWorkflow(
  input: WorkflowExecutionInput,
  executionId: string,
  deps: WorkflowHandlerDeps,
  restateCtx?: RestateWorkflowCtx,  // Optional — falls back to no-op for tests without Restate
): Promise<WorkflowExecutionResult> {
```

**Step 4: After `executeWorkflowStep`, act on control-flow signals using restateCtx**

Replace the control-flow metadata recording block (lines 321-339) with actual suspension:

```typescript
// Act on control-flow signals using Restate durable primitives
if (result.delayMs !== undefined && restateCtx) {
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'waiting_delay',
  );
  await restateCtx.sleep(result.delayMs);
}

if (result.approvalRequest !== undefined && restateCtx) {
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'waiting_approval',
  );
  await deps.publisher.publish(
    `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
    JSON.stringify({ type: 'step.waiting_approval', executionId, stepId: step.id }),
  );
  const decision = await restateCtx
    .promise<{ approved: boolean; decidedBy: string; reason?: string }>(`approval:${step.id}`)
    .get();
  ctx.steps[step.id] = {
    ...ctx.steps[step.id],
    output: { ...(ctx.steps[step.id]?.output as object), approvalDecision: decision },
  };
  if (!decision.approved) {
    throw new Error(
      `Approval rejected by ${decision.decidedBy}: ${decision.reason || 'no reason'}`,
    );
  }
}

if (result.webhookRequest !== undefined && restateCtx) {
  await deps.persistence.updateStepStatus(
    executionId,
    ctx.tenant.tenantId,
    ctx.tenant.projectId,
    step.id,
    'waiting_callback',
  );
  await deps.publisher.publish(
    `workflow:${ctx.tenant.tenantId}:execution:${executionId}:status`,
    JSON.stringify({ type: 'step.waiting_callback', executionId, stepId: step.id }),
  );
  const callbackPayload = await restateCtx.promise<unknown>(`callback:${step.id}`).get();
  ctx.steps[step.id] = {
    ...ctx.steps[step.id],
    output: { ...(ctx.steps[step.id]?.output as object), callbackPayload },
  };
}

// Check for cancellation between steps
if (restateCtx) {
  const cancelled = await restateCtx.promise<boolean>('cancel').peek();
  if (cancelled) {
    throw new Error('Workflow cancelled');
  }
}
```

**Step 5: Pass `ctx` from restate-endpoint.ts**

```typescript
// restate-endpoint.ts, line 86:
return runWorkflow(
  input,
  executionId,
  {
    persistence: deps.persistence,
    publisher: deps.publisher,
    dispatcherDeps: deps.dispatcherDeps,
    connectorDepsFactory: deps.connectorDepsFactory,
  },
  ctx,
); // <-- pass Restate WorkflowContext
```

**Step 6: Run tests**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/workflow-handler-suspension.test.ts`
Expected: PASS

**Step 7: Run all workflow-engine tests**

Run: `cd apps/workflow-engine && pnpm test`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/workflow-engine/src/handlers/workflow-handler.ts \
       apps/workflow-engine/src/services/restate-endpoint.ts \
       apps/workflow-engine/src/__tests__/workflow-handler-suspension.test.ts
git commit -m "feat(workflow-engine): thread Restate ctx through runWorkflow — real suspension for delay/approval/webhook steps"
```

---

## Phase 5: Missing Step Handlers (loop, transform)

### Task 5.1: Implement loop executor

**Files:**

- Create: `apps/workflow-engine/src/executors/loop-executor.ts`
- Modify: `apps/workflow-engine/src/handlers/step-dispatcher.ts` (add loop case)
- Test: `apps/workflow-engine/src/__tests__/loop-executor.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/workflow-engine/src/__tests__/loop-executor.test.ts
import { describe, it, expect } from 'vitest';
import { executeLoop, type LoopStep } from '../executors/loop-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

describe('executeLoop', () => {
  const baseCtx: WorkflowContextData = {
    trigger: { type: 'manual', payload: { items: ['a', 'b', 'c'] } },
    workflow: { id: 'wf-1', name: 'Test', executionId: 'exec-1' },
    tenant: { tenantId: 't-1', projectId: 'p-1' },
    steps: {},
    vars: {},
  };

  it('should iterate over a collection and collect results', async () => {
    const step: LoopStep = {
      id: 'loop-1',
      type: 'loop',
      config: {
        collection: '{{trigger.payload.items}}',
        itemVariable: 'item',
      },
    };

    const result = await executeLoop(step, baseCtx);
    expect(result.iterations).toBe(3);
    expect(result.items).toEqual(['a', 'b', 'c']);
  });
});
```

**Step 2: Implement the loop executor**

```typescript
// apps/workflow-engine/src/executors/loop-executor.ts
import type { WorkflowContextData } from '../context/expression-resolver.js';
import { resolveExpression } from '../context/expression-resolver.js';

export interface LoopStep {
  id: string;
  type: 'loop';
  config: {
    collection: string; // Expression resolving to an array
    itemVariable: string; // Variable name for current item
    maxIterations?: number; // Safety limit (default 1000)
  };
}

export interface LoopResult {
  iterations: number;
  items: unknown[];
}

const MAX_ITERATIONS_DEFAULT = 1000;

export async function executeLoop(step: LoopStep, ctx: WorkflowContextData): Promise<LoopResult> {
  const collection = resolveExpression(step.config.collection, ctx);

  if (!Array.isArray(collection)) {
    throw new Error(
      `Loop collection expression did not resolve to an array: ${step.config.collection}`,
    );
  }

  const maxIterations = step.config.maxIterations ?? MAX_ITERATIONS_DEFAULT;
  const items = collection.slice(0, maxIterations);

  // Store each item in vars under the configured variable name
  for (let i = 0; i < items.length; i++) {
    ctx.vars[step.config.itemVariable] = items[i];
    ctx.vars[`${step.config.itemVariable}_index`] = i;
  }

  return { iterations: items.length, items };
}
```

**Step 3: Add `loop` case to step-dispatcher.ts**

```typescript
import { executeLoop, type LoopStep } from '../executors/loop-executor.js';

// In the WorkflowStep union, add:
| LoopStep

// In the switch statement:
case 'loop': {
  const output = await executeLoop(step, ctx);
  return { type: 'loop', output };
}
```

**Step 4: Run tests**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/loop-executor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/workflow-engine/src/executors/loop-executor.ts \
       apps/workflow-engine/src/handlers/step-dispatcher.ts \
       apps/workflow-engine/src/__tests__/loop-executor.test.ts
git commit -m "feat(workflow-engine): implement loop step executor"
```

---

### Task 5.2: Implement transform executor

**Files:**

- Create: `apps/workflow-engine/src/executors/transform-executor.ts`
- Modify: `apps/workflow-engine/src/handlers/step-dispatcher.ts` (add transform case)
- Test: `apps/workflow-engine/src/__tests__/transform-executor.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/workflow-engine/src/__tests__/transform-executor.test.ts
import { describe, it, expect } from 'vitest';
import { executeTransform, type TransformStep } from '../executors/transform-executor.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

describe('executeTransform', () => {
  const baseCtx: WorkflowContextData = {
    trigger: { type: 'manual', payload: { name: 'John', age: 30 } },
    workflow: { id: 'wf-1', name: 'Test', executionId: 'exec-1' },
    tenant: { tenantId: 't-1', projectId: 'p-1' },
    steps: {},
    vars: {},
  };

  it('should resolve input expression and store in output variable', async () => {
    const step: TransformStep = {
      id: 'transform-1',
      type: 'transform',
      config: {
        inputExpression: '{{trigger.payload.name}}',
        outputVariable: 'userName',
      },
    };

    const result = await executeTransform(step, baseCtx);
    expect(result.value).toBe('John');
    expect(baseCtx.vars['userName']).toBe('John');
  });
});
```

**Step 2: Implement the transform executor**

```typescript
// apps/workflow-engine/src/executors/transform-executor.ts
import type { WorkflowContextData } from '../context/expression-resolver.js';
import { resolveExpression } from '../context/expression-resolver.js';

export interface TransformStep {
  id: string;
  type: 'transform';
  config: {
    inputExpression: string; // Expression to evaluate
    outputVariable: string; // Variable name to store result
  };
}

export interface TransformResult {
  value: unknown;
  outputVariable: string;
}

export async function executeTransform(
  step: TransformStep,
  ctx: WorkflowContextData,
): Promise<TransformResult> {
  const value = resolveExpression(step.config.inputExpression, ctx);
  ctx.vars[step.config.outputVariable] = value;
  return { value, outputVariable: step.config.outputVariable };
}
```

**Step 3: Add `transform` case to step-dispatcher.ts**

```typescript
import { executeTransform, type TransformStep } from '../executors/transform-executor.js';

// In the WorkflowStep union, add:
| TransformStep

// In the switch statement:
case 'transform': {
  const output = await executeTransform(step, ctx);
  return { type: 'transform', output };
}
```

**Step 4: Run tests**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/transform-executor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/workflow-engine/src/executors/transform-executor.ts \
       apps/workflow-engine/src/handlers/step-dispatcher.ts \
       apps/workflow-engine/src/__tests__/transform-executor.test.ts
git commit -m "feat(workflow-engine): implement transform step executor"
```

---

## Phase 6: Studio Workflow Creation UX

### Task 6.1: Create workflow creation modal

**Finding:** "New Workflow" navigates to `/workflows/new` which renders detail page. User decision: modal/wizard that calls `createWorkflow()`, then navigates to detail.

**Files:**

- Create: `apps/studio/src/components/workflows/CreateWorkflowModal.tsx`
- Modify: `apps/studio/src/components/workflows/WorkflowsListPage.tsx` (use modal instead of navigate)
- Modify: `apps/studio/src/api/workflows.ts` (ensure `createWorkflow` works)

**Step 1: Create the modal component**

```typescript
// apps/studio/src/components/workflows/CreateWorkflowModal.tsx
'use client';

import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { createWorkflow } from '../../api/workflows';

interface CreateWorkflowModalProps {
  projectId: string;
  onCreated: (workflowId: string) => void;
  onClose: () => void;
}

const WORKFLOW_TYPES = [
  { value: 'cx_automation', label: 'CX Automation', description: 'Customer-facing workflow' },
  { value: 'ex_automation', label: 'EX Automation', description: 'Employee-facing workflow' },
  { value: 'internal', label: 'Internal', description: 'Internal process automation' },
] as const;

export function CreateWorkflowModal({ projectId, onCreated, onClose }: CreateWorkflowModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'cx_automation' | 'ex_automation' | 'internal'>('cx_automation');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setIsCreating(true);
    setError(null);
    try {
      const workflow = await createWorkflow(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        type,
      });
      onCreated(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  }, [name, description, type, projectId, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background-elevated border border-default rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">New Workflow</h2>
          <button onClick={onClose} className="text-foreground-muted hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Workflow"
              className="w-full rounded-lg border border-default bg-background-subtle text-foreground focus:border-accent focus:ring-1 focus:ring-accent text-sm py-2 px-3"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3"
            >
              {WORKFLOW_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={3}
              className="w-full rounded-lg border border-default bg-background-subtle text-foreground focus:border-accent focus:ring-1 focus:ring-accent text-sm py-2 px-3 resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating || !name.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent/90 disabled:opacity-50"
          >
            {isCreating ? 'Creating...' : 'Create Workflow'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Update WorkflowsListPage to use the modal**

Replace the `handleCreateWorkflow` that navigates to `/workflows/new` with a state toggle:

```typescript
const [showCreateModal, setShowCreateModal] = useState(false);

const handleCreateWorkflow = () => setShowCreateModal(true);

const handleWorkflowCreated = (workflowId: string) => {
  setShowCreateModal(false);
  navigate(`/projects/${projectId}/workflows/${workflowId}`);
};

// In JSX, after the main content:
{showCreateModal && projectId && (
  <CreateWorkflowModal
    projectId={projectId}
    onCreated={handleWorkflowCreated}
    onClose={() => setShowCreateModal(false)}
  />
)}
```

**Step 3: Update `createWorkflow` in API client**

Ensure `createWorkflow` sends the right body and extracts from `{ success, data }` envelope:

```typescript
export async function createWorkflow(
  projectId: string,
  data: { name: string; description?: string; type?: string },
): Promise<WorkflowSummary> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await handleResponse(response);
  return json.data;
}
```

**Step 4: Commit**

```bash
git add apps/studio/src/components/workflows/CreateWorkflowModal.tsx \
       apps/studio/src/components/workflows/WorkflowsListPage.tsx \
       apps/studio/src/api/workflows.ts
git commit -m "feat(studio): add workflow creation modal — creates via API then navigates to detail"
```

---

## Phase 7: Connector Catalog Wiring

### Task 7.1: Make StepEditor load connectors dynamically

**Files:**

- Modify: `apps/studio/src/components/workflows/steps/StepEditor.tsx:129-135` (fetch connectors)

**Step 1: Replace static connector options with SWR fetch**

In `ConnectorActionConfig`, use SWR to fetch from `/api/projects/${projectId}/connectors`:

```typescript
import useSWR from 'swr';

function ConnectorActionConfig({
  step,
  onChange,
  projectId,
}: {
  step: WorkflowStep;
  onChange: (config: any) => void;
  projectId: string;
}) {
  const { data } = useSWR(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : null,
  );
  const connectors = data?.data ?? [];

  // Use connectors for dropdown options instead of hardcoded list
  // ...
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/workflows/steps/StepEditor.tsx
git commit -m "feat(studio): load connector catalog dynamically in StepEditor"
```

---

## Phase 8: Trigger Engine — End-to-End

### Task 8.1: Implement TriggerEngine service

**Files:**

- Create: `apps/workflow-engine/src/services/trigger-engine.ts`
- Test: `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`

**Step 1: Write the failing test**

```typescript
// apps/workflow-engine/src/__tests__/trigger-engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerEngine } from '../services/trigger-engine.js';

describe('TriggerEngine', () => {
  let engine: TriggerEngine;
  let mockTriggerModel: any;
  let mockRestateClient: any;

  beforeEach(() => {
    mockTriggerModel = {
      create: vi.fn().mockResolvedValue({ _id: 'reg-1' }),
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      deleteOne: vi.fn(),
    };
    mockRestateClient = {
      startWorkflow: vi.fn().mockResolvedValue(undefined),
    };
    engine = new TriggerEngine({
      triggerModel: mockTriggerModel,
      restateClient: mockRestateClient,
    });
  });

  it('should register a webhook trigger and return registrationId', async () => {
    const result = await engine.register({
      workflowId: 'wf-1',
      tenantId: 't-1',
      projectId: 'p-1',
      type: 'webhook',
      config: {},
    });
    expect(result.registrationId).toBeDefined();
    expect(mockTriggerModel.create).toHaveBeenCalled();
  });

  it('should deregister a trigger', async () => {
    mockTriggerModel.findOneAndUpdate.mockResolvedValue({ _id: 'reg-1' });
    await engine.deregister('reg-1', 't-1');
    expect(mockTriggerModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'reg-1', tenantId: 't-1' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'deleted' }) }),
    );
  });
});
```

**Step 2: Implement TriggerEngine**

```typescript
// apps/workflow-engine/src/services/trigger-engine.ts
import { createLogger } from '@abl/compiler/platform';
import crypto from 'node:crypto';

const log = createLogger('workflow-engine:trigger-engine');

export interface TriggerRegistration {
  workflowId: string;
  tenantId: string;
  projectId: string;
  type: 'webhook' | 'cron' | 'polling' | 'event';
  config: Record<string, unknown>;
}

interface TriggerEngineDeps {
  triggerModel: any; // Mongoose model
  restateClient: {
    startWorkflow(executionId: string, input: unknown): Promise<void>;
  };
}

export class TriggerEngine {
  private deps: TriggerEngineDeps;

  constructor(deps: TriggerEngineDeps) {
    this.deps = deps;
  }

  async register(registration: TriggerRegistration): Promise<{ registrationId: string }> {
    const registrationId = crypto.randomUUID();

    await this.deps.triggerModel.create({
      _id: registrationId,
      workflowId: registration.workflowId,
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      type: registration.type,
      config: registration.config,
      status: 'active',
      createdAt: new Date(),
    });

    // Type-specific setup
    if (registration.type === 'webhook') {
      log.info('Webhook trigger registered', {
        registrationId,
        workflowId: registration.workflowId,
      });
      // Webhook triggers are passive — they wait for incoming POST to /triggers/:registrationId/fire
    }

    if (registration.type === 'cron') {
      // TODO: Schedule via BullMQ repeatable job
      log.info('Cron trigger registered (scheduling pending BullMQ)', {
        registrationId,
        expression: registration.config.expression,
      });
    }

    return { registrationId };
  }

  async deregister(registrationId: string, tenantId: string): Promise<void> {
    const result = await this.deps.triggerModel.findOneAndUpdate(
      { _id: registrationId, tenantId },
      { $set: { status: 'deleted', deletedAt: new Date() } },
    );
    if (!result) {
      log.warn('Trigger not found for deregister', { registrationId, tenantId });
    }
  }

  async pause(registrationId: string, tenantId: string): Promise<void> {
    await this.deps.triggerModel.findOneAndUpdate(
      { _id: registrationId, tenantId },
      { $set: { status: 'paused' } },
    );
  }

  async resume(registrationId: string, tenantId: string): Promise<void> {
    await this.deps.triggerModel.findOneAndUpdate(
      { _id: registrationId, tenantId },
      { $set: { status: 'active' } },
    );
  }

  /** Fire a webhook trigger — called when an external system POSTs to the trigger URL */
  async fireWebhookTrigger(
    registrationId: string,
    payload: Record<string, unknown>,
  ): Promise<{ executionId: string }> {
    const trigger = await this.deps.triggerModel.findOne({
      _id: registrationId,
      status: 'active',
    });
    if (!trigger) {
      throw new Error(`Trigger ${registrationId} not found or not active`);
    }

    const executionId = crypto.randomUUID();
    // Fetch workflow definition steps from DB (caller should provide or engine should resolve)
    // For now, start with minimal input — the Restate handler will load steps
    await this.deps.restateClient.startWorkflow(executionId, {
      workflowId: trigger.workflowId,
      tenantId: trigger.tenantId,
      projectId: trigger.projectId,
      triggerType: 'webhook',
      triggerPayload: payload,
      triggerMetadata: {
        registrationId,
        firedAt: new Date().toISOString(),
      },
    });

    return { executionId };
  }
}
```

**Step 3: Run tests**

Run: `cd apps/workflow-engine && pnpm vitest run src/__tests__/trigger-engine.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/workflow-engine/src/services/trigger-engine.ts \
       apps/workflow-engine/src/__tests__/trigger-engine.test.ts
git commit -m "feat(workflow-engine): implement TriggerEngine with webhook/cron/polling lifecycle"
```

---

### Task 8.2: Create trigger model and wire TriggerEngine into index.ts

**Files:**

- Create: `packages/database/src/models/trigger-registration.model.ts`
- Modify: `apps/workflow-engine/src/index.ts:443-460` (replace no-op with real TriggerEngine)

**Step 1: Create the trigger registration model**

```typescript
// packages/database/src/models/trigger-registration.model.ts
import { Schema, model, type Document } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';

export interface ITriggerRegistration extends Document {
  _id: string;
  workflowId: string;
  tenantId: string;
  projectId: string;
  type: 'webhook' | 'cron' | 'polling' | 'event';
  config: Record<string, unknown>;
  status: 'active' | 'paused' | 'deleted' | 'error';
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

const TriggerRegistrationSchema = new Schema<ITriggerRegistration>(
  {
    _id: { type: String, default: () => uuidv7() },
    workflowId: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    type: { type: String, enum: ['webhook', 'cron', 'polling', 'event'], required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['active', 'paused', 'deleted', 'error'], default: 'active' },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

TriggerRegistrationSchema.index({ tenantId: 1, projectId: 1, workflowId: 1 });
TriggerRegistrationSchema.index({ tenantId: 1, status: 1, type: 1 });

export const TriggerRegistration = model<ITriggerRegistration>(
  'TriggerRegistration',
  TriggerRegistrationSchema,
);
```

**Step 2: Wire real TriggerEngine into workflow-engine index.ts**

Replace the no-op trigger engine (lines 443-460) with:

```typescript
import { TriggerEngine } from './services/trigger-engine.js';
import { TriggerRegistration } from '@agent-platform/database/models/trigger-registration';

const triggerEngine = new TriggerEngine({
  triggerModel: TriggerRegistration,
  restateClient,
});

const triggerRouter = createTriggerRouter({ triggerEngine });
projectRouter.use('/triggers', triggerRouter);
```

**Step 3: Add projectId to trigger deregister/pause/resume**

In `apps/workflow-engine/src/routes/triggers.ts`, update deregister/pause/resume to also filter by projectId:

```typescript
// deregister:
await deps.triggerEngine.deregister(registrationId, tenantId, projectId);

// pause:
await deps.triggerEngine.pause(registrationId, tenantId, projectId);

// resume:
await deps.triggerEngine.resume(registrationId, tenantId, projectId);
```

And update TriggerEngine methods to accept and use `projectId`.

**Step 4: Commit**

```bash
git add packages/database/src/models/trigger-registration.model.ts \
       apps/workflow-engine/src/index.ts \
       apps/workflow-engine/src/routes/triggers.ts \
       apps/workflow-engine/src/services/trigger-engine.ts
git commit -m "feat(workflow-engine): wire real TriggerEngine with persistence and project isolation"
```

---

### Task 8.3: Add webhook trigger fire endpoint

**Files:**

- Modify: `apps/workflow-engine/src/routes/triggers.ts` (add POST /:registrationId/fire)

**Step 1: Add the fire endpoint**

```typescript
// POST /projects/:projectId/triggers/:registrationId/fire
router.post('/:registrationId/fire', async (req, res) => {
  try {
    const { registrationId } = req.params;
    const result = await deps.triggerEngine.fireWebhookTrigger(registrationId, req.body);
    res.status(202).json({ success: true, data: result });
  } catch (err) {
    log.error('Trigger fire failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res
      .status(500)
      .json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});
```

**Step 2: Commit**

```bash
git add apps/workflow-engine/src/routes/triggers.ts
git commit -m "feat(workflow-engine): add webhook trigger fire endpoint"
```

---

### Task 8.4: Enable Studio trigger controls

**Files:**

- Modify: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` (remove disabled, add handlers)

**Step 1: Remove `disabled` from trigger buttons**

Remove the `disabled` prop from all trigger action buttons (lines 201, 228, 241).

**Step 2: Wire add/toggle/delete trigger handlers**

Connect the buttons to API calls via the runtime proxy:

```typescript
const handleAddTrigger = async () => {
  // Open a trigger creation modal or inline form
  // POST /api/projects/:projectId/workflows/:workflowId/triggers
};

const handleToggleTrigger = async (trigger: WorkflowTrigger) => {
  const registrationId = trigger.registrationId;
  if (!registrationId) return;
  const action = trigger.status === 'active' ? 'pause' : 'resume';
  await fetch(`/api/projects/${projectId}/workflows/triggers/${registrationId}/${action}`, {
    method: 'POST',
  });
  // Refresh
};
```

**Step 3: Fix trigger type field name**

The DB model uses `strategy` but the UI reads `trigger.type`. Reconcile: update the UI to read from the response field as-is (the runtime response will have whatever the DB stores). If the field name is `strategy`, update the UI to use it, or update the DB model to use `type` instead. Recommend renaming DB field from `strategy` to `type` to match the UI.

**Step 4: Commit**

```bash
git add apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx
git commit -m "feat(studio): enable trigger controls with API handlers"
```

---

## Phase 9: Cleanup

### Task 9.1: Add pagination to approvals listing

**Finding:** Approvals listing has no `.limit()` and flattens all matching executions in memory.

**Files:**

- Modify: `apps/workflow-engine/src/routes/workflow-approvals.ts:87-109`

**Step 1: Add limit and offset to the query**

```typescript
const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
const offset = parseInt(req.query.offset as string) || 0;

const executions = await deps.executionModel
  .find({
    tenantId,
    projectId,
    'steps.status': 'waiting_approval',
  })
  .sort({ startedAt: -1 })
  .skip(offset)
  .limit(limit)
  .lean();
```

**Step 2: Return total count for pagination**

```typescript
const total = await deps.executionModel.countDocuments({
  tenantId,
  projectId,
  'steps.status': 'waiting_approval',
});

res.json({ success: true, data: approvals, total, limit, offset });
```

**Step 3: Commit**

```bash
git add apps/workflow-engine/src/routes/workflow-approvals.ts
git commit -m "fix(workflow-engine): add pagination to approvals listing (limit, offset, total)"
```

---

## Dependency Graph

```
Phase 1 (Quick Fixes)     ─── no deps, start immediately
  ├─ Task 1.1: Callback URL fix
  ├─ Task 1.2: Remove entryAgent
  └─ Task 1.3: Normalize step types

Phase 2 (Studio Contracts) ─── no deps, parallel with Phase 1
  ├─ Task 2.1: API client envelope
  ├─ Task 2.2: SWR hooks (depends on 2.1)
  ├─ Task 2.3: Approve body fix
  └─ Task 2.4: Status enum fix

Phase 3 (Runtime Gateway)  ─── depends on Phase 2 (contracts finalized)
  ├─ Task 3.1: Proxy middleware
  └─ Task 3.2: Trigger/connector proxy

Phase 4 (Restate Threading) ─── no deps, parallel with Phases 1-3
  └─ Task 4.1: Thread ctx + suspension

Phase 5 (Step Handlers)    ─── depends on Task 1.3 (DB enum updated)
  ├─ Task 5.1: Loop executor
  └─ Task 5.2: Transform executor

Phase 6 (Studio Creation)  ─── depends on Phase 2 (API client fixed)
  └─ Task 6.1: Create modal

Phase 7 (Connectors)       ─── depends on Phase 3 (proxy wired)
  └─ Task 7.1: Dynamic connector loading

Phase 8 (Triggers E2E)     ─── depends on Phase 3 (proxy) + Phase 4 (Restate)
  ├─ Task 8.1: TriggerEngine service
  ├─ Task 8.2: Model + wiring (depends on 8.1)
  ├─ Task 8.3: Fire endpoint (depends on 8.2)
  └─ Task 8.4: Studio trigger controls (depends on 8.3 + Phase 3)

Phase 9 (Cleanup)          ─── no deps, any time
  └─ Task 9.1: Approvals pagination
```

## Parallel Execution Groups

These groups can run concurrently:

**Group A (backend):** Phase 1 + Phase 4 + Phase 9
**Group B (studio):** Phase 2
**Group C (after A+B):** Phase 3 → Phase 5 → Phase 7 → Phase 8
**Group D (after B):** Phase 6

## Estimated Scope

- **17 tasks** across 9 phases
- **~12 files to modify**, **~6 files to create**
- Packages affected: `workflow-engine`, `runtime`, `studio`, `database`
