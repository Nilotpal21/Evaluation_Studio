# Workflow Findings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 9 findings (3 P0, 6 P1) from the workflow triggers/actions readiness review so that workflows configured in Studio can execute reliably end-to-end.

**Architecture:** Fix the step payload contract at the runtime PUT boundary (denormalize `config` → flat), unblock connector/notification proxy routes, align trigger field names, add missing step types, wire publish lifecycle, fix connections routing, and add project RBAC to engine routes.

**Tech Stack:** TypeScript, Express, Mongoose, Vitest, React/SWR

---

## Task 1: [P0] Fix step payload shape — runtime denormalization

The core issue: Studio saves steps as `{ id, type, config: { connector, action, ... } }` but the DB schema and engine executors expect flat top-level fields `{ id, type, connector, action, ... }`. Fix this at the runtime PUT boundary.

**Files:**

- Modify: `apps/runtime/src/routes/workflows.ts:321-363` (PUT /:id handler)
- Create: `apps/runtime/src/__tests__/workflow-step-denormalize.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect } from 'vitest';

// Import the denormalization function we'll create
import { denormalizeSteps } from '../routes/workflow-helpers.js';

describe('denormalizeSteps', () => {
  test('unwraps config into top-level fields for connector_action', () => {
    const steps = [
      {
        id: 'step-1',
        name: 'Call Salesforce',
        type: 'connector_action',
        config: { connector: 'salesforce', action: 'getRecord', params: '{"id":"123"}' },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0]).toEqual({
      id: 'step-1',
      name: 'Call Salesforce',
      type: 'connector_action',
      connector: 'salesforce',
      action: 'getRecord',
      params: '{"id":"123"}',
      position: 0,
    });
  });

  test('unwraps config for delay step', () => {
    const steps = [
      { id: 's2', name: 'Wait', type: 'delay', config: { duration: '30s' }, position: 1 },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].duration).toBe('30s');
    expect(result[0].config).toBeUndefined();
  });

  test('unwraps config for condition step', () => {
    const steps = [
      {
        id: 's3',
        name: 'Check',
        type: 'condition',
        config: { expression: 'ctx.amount > 100', thenSteps: ['s4'], elseSteps: ['s5'] },
        position: 2,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].expression).toBe('ctx.amount > 100');
    expect(result[0].thenSteps).toEqual(['s4']);
  });

  test('unwraps config for http step', () => {
    const steps = [
      {
        id: 's4',
        name: 'Fetch',
        type: 'http',
        config: {
          method: 'POST',
          url: 'https://api.example.com',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
        position: 3,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].method).toBe('POST');
    expect(result[0].url).toBe('https://api.example.com');
  });

  test('passes through already-flat steps unchanged', () => {
    const steps = [{ id: 's5', name: 'Wait', type: 'delay', duration: '10s', position: 0 }];
    const result = denormalizeSteps(steps);
    expect(result[0]).toEqual(steps[0]);
  });

  test('preserves loop step config wrapper (exception)', () => {
    const steps = [
      {
        id: 's6',
        name: 'Loop',
        type: 'loop',
        config: { collection: 'items', itemVariable: 'item', maxIterations: 100 },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    // loop and transform keep their config wrapper
    expect(result[0].config).toEqual({
      collection: 'items',
      itemVariable: 'item',
      maxIterations: 100,
    });
  });

  test('preserves transform step config wrapper (exception)', () => {
    const steps = [
      {
        id: 's7',
        name: 'Transform',
        type: 'transform',
        config: { inputExpression: 'ctx.data', outputVariable: 'result' },
        position: 0,
      },
    ];
    const result = denormalizeSteps(steps);
    expect(result[0].config).toEqual({ inputExpression: 'ctx.data', outputVariable: 'result' });
  });

  test('handles empty steps array', () => {
    expect(denormalizeSteps([])).toEqual([]);
  });

  test('handles undefined steps', () => {
    expect(denormalizeSteps(undefined)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/workflow-step-denormalize.test.ts`
Expected: FAIL — `denormalizeSteps` not found

**Step 3: Write the denormalization helper**

Create file `apps/runtime/src/routes/workflow-helpers.ts`:

```typescript
/**
 * Denormalize Studio step payloads from { config: { ...fields } } to flat top-level fields.
 *
 * Studio wraps type-specific fields under step.config for UI ergonomics.
 * The DB schema (WorkflowStepSchema) and engine executors expect flat top-level fields.
 * Exception: loop and transform steps use step.config by convention in their executors.
 */

const TOP_LEVEL_KEYS = new Set(['id', 'name', 'type', 'position']);
const CONFIG_WRAPPER_TYPES = new Set(['loop', 'transform']);

export function denormalizeSteps(
  steps: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (!steps || !Array.isArray(steps)) return [];

  return steps.map((step) => {
    const config = step.config;

    // No config wrapper — already flat, pass through
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return step;
    }

    // loop and transform executors expect step.config — preserve wrapper
    if (CONFIG_WRAPPER_TYPES.has(step.type as string)) {
      return step;
    }

    // Spread config fields to top level, remove config key
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(step)) {
      if (key !== 'config') {
        flat[key] = value;
      }
    }
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        flat[key] = value;
      }
    }
    return flat;
  });
}
```

**Step 4: Wire into PUT handler**

In `apps/runtime/src/routes/workflows.ts`, import and use in the PUT /:id handler:

```typescript
// At top of file, add import:
import { denormalizeSteps } from './workflow-helpers.js';

// In PUT /:id handler (around line 340), before store.update:
const body = { ...req.body };
if (body.steps) {
  body.steps = denormalizeSteps(body.steps as Record<string, unknown>[]);
}
const updated = await store.update(req.params.id, tenantId, projectId, body);
```

**Step 5: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/workflow-step-denormalize.test.ts`
Expected: all 9 tests PASS

**Step 6: Commit**

```
[ABLP-2] fix(runtime): denormalize Studio step config wrapper to flat fields on save
```

---

## Task 2: [P0] Fix connector route shadowing

The CRUD router's `GET /:id` captures `/connectors` before the proxy can handle it.

**Files:**

- Modify: `apps/runtime/src/routes/workflows.ts` (add explicit `/connectors` route before `/:id`)
- Create: `apps/runtime/src/__tests__/workflow-connectors-route.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({ isDatabaseAvailable: vi.fn(() => true) }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));
vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));
vi.mock('../services/audit-helpers.js', () => ({
  auditWorkflowCreated: vi.fn(),
  auditWorkflowUpdated: vi.fn(),
  auditWorkflowArchived: vi.fn(),
}));

import express from 'express';
import request from 'supertest';

describe('GET /connectors route priority', () => {
  test('GET /connectors should NOT match the /:id route', async () => {
    const { default: workflowsRouter } = await import('../routes/workflows.js');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: 't1', userId: 'u1' };
      next();
    });
    app.use('/api/projects/:projectId/workflows', workflowsRouter);

    const res = await request(app).get('/api/projects/p1/workflows/connectors');
    // Should NOT return a 404 "Workflow not found" from the /:id handler
    // Instead should pass through to the next router (proxy) or return a known status
    expect(res.status).not.toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/runtime && npx vitest run src/__tests__/workflow-connectors-route.test.ts`
Expected: FAIL — currently returns 404

**Step 3: Add explicit `/connectors` pass-through route before `/:id`**

In `apps/runtime/src/routes/workflows.ts`, add a route BEFORE the `GET /:id` route (around line 286):

```typescript
// Pass connector requests through to the proxy router (mounted after CRUD router in server.ts).
// Without this, the generic GET /:id below captures "connectors" as an ID and returns 404.
router.get('/connectors', (_req, _res, next) => next('route'));
```

The `next('route')` call skips remaining handlers in this router and falls through to the next router on the same mount path (the workflow-engine proxy).

**Step 4: Run test**

Run: `cd apps/runtime && npx vitest run src/__tests__/workflow-connectors-route.test.ts`
Expected: PASS (no longer 404)

**Step 5: Commit**

```
[ABLP-2] fix(runtime): prevent connector route from being shadowed by workflow GET /:id
```

---

## Task 3: [P0] Fix trigger field name mismatch and add event type

Studio sends `config.expression`/`config.intervalMs`/`config.eventName` but the engine expects `config.cronExpression`/`config.pollingIntervalMs`. The DB schema also lacks `event` type.

**Files:**

- Modify: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx:128-166` (fix field names)
- Modify: `packages/database/src/models/trigger-registration.model.ts:49-52` (add `event` to enum)
- Modify: `apps/workflow-engine/src/services/trigger-engine.ts:80-88` (add event handler)
- Create: `apps/workflow-engine/src/__tests__/trigger-field-names.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from 'vitest';

describe('trigger field name alignment', () => {
  test('cron trigger uses cronExpression field', async () => {
    const mockScheduler = {
      scheduleCron: vi.fn(),
      schedulePolling: vi.fn(),
      cancel: vi.fn(),
    };
    const mockTriggerModel = {
      create: vi.fn().mockResolvedValue({}),
    };
    const mockPublisher = { publish: vi.fn() };

    const { TriggerEngine } = await import('../services/trigger-engine.js');
    const engine = new TriggerEngine({
      triggerModel: mockTriggerModel as any,
      scheduler: mockScheduler as any,
      publisher: mockPublisher as any,
    });

    await engine.register({
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      type: 'cron',
      config: { cronExpression: '0 */5 * * *' },
    });

    expect(mockScheduler.scheduleCron).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      '0 */5 * * *',
    );
  });

  test('polling trigger uses pollingIntervalMs field', async () => {
    const mockScheduler = {
      scheduleCron: vi.fn(),
      schedulePolling: vi.fn(),
      cancel: vi.fn(),
    };
    const mockTriggerModel = {
      create: vi.fn().mockResolvedValue({}),
    };
    const mockPublisher = { publish: vi.fn() };

    const { TriggerEngine } = await import('../services/trigger-engine.js');
    const engine = new TriggerEngine({
      triggerModel: mockTriggerModel as any,
      scheduler: mockScheduler as any,
      publisher: mockPublisher as any,
    });

    await engine.register({
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      type: 'polling',
      config: { pollingIntervalMs: 30000 },
    });

    expect(mockScheduler.schedulePolling).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      30000,
    );
  });
});
```

**Step 2: Fix Studio field names**

In `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`, update the trigger creation logic (around lines 128-166):

```typescript
// Change line ~134 from:
config.expression = cronExpression;
// to:
config.cronExpression = cronExpression;

// Change line ~142 from:
config.intervalMs = seconds * 1000;
// to:
config.pollingIntervalMs = seconds * 1000;

// Keep config.eventName as-is (that's what the engine will read for event triggers)
```

**Step 3: Add `event` to DB schema enum**

In `packages/database/src/models/trigger-registration.model.ts`, update line 51:

```typescript
// Change from:
enum: ['webhook', 'polling', 'cron'],
// to:
enum: ['webhook', 'polling', 'cron', 'event'],
```

**Step 4: Add event handler in trigger engine**

In `apps/workflow-engine/src/services/trigger-engine.ts`, after the polling case (around line 88), add:

```typescript
} else if (registration.type === 'event') {
  // Event triggers are passive — they fire when an external event arrives.
  // No scheduling needed; the trigger registration is stored for lookup on event receipt.
  log.info('Event trigger registered', { registrationId, eventName: registration.config.eventName });
}
```

**Step 5: Run tests**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/trigger-field-names.test.ts`
Expected: PASS

**Step 6: Commit**

```
[ABLP-2] fix(workflow): align trigger field names between Studio and engine, add event type
```

---

## Task 4: [P1] Fix trigger tab to render registrations and add list endpoint

The trigger tab renders `workflow.triggers` (inline subdocuments) instead of `TriggerRegistration` records. The engine has no GET endpoint for listing registrations.

**Files:**

- Modify: `apps/workflow-engine/src/routes/triggers.ts` (add GET / list endpoint)
- Modify: `apps/runtime/src/middleware/workflow-engine-proxy.ts` (add GET triggers proxy)
- Modify: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` (fetch registrations via SWR)
- Create: `apps/workflow-engine/src/__tests__/trigger-list-route.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

describe('GET /triggers — list registrations', () => {
  test('returns registrations for a workflow', async () => {
    const mockRegistrations = [
      {
        _id: 'tr-1',
        workflowId: 'wf-1',
        strategy: 'cron',
        status: 'active',
        config: { cronExpression: '0 * * * *' },
      },
      {
        _id: 'tr-2',
        workflowId: 'wf-1',
        strategy: 'polling',
        status: 'paused',
        config: { pollingIntervalMs: 60000 },
      },
    ];

    const deps = {
      triggerModel: {
        find: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockRegistrations),
        }),
      },
      triggerEngine: {
        register: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        delete: vi.fn(),
        fire: vi.fn(),
      },
      executionModel: {},
      workflowModel: {},
    };

    const { createTriggerRouter } = await import('../routes/triggers.js');
    const router = createTriggerRouter(deps as any);

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: 't1', userId: 'u1' };
      req.params = { projectId: 'p1' };
      next();
    });
    app.use('/triggers', router);

    const res = await request(app).get('/triggers?workflowId=wf-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]._id).toBe('tr-1');
  });
});
```

**Step 2: Add GET / endpoint to trigger router**

In `apps/workflow-engine/src/routes/triggers.ts`, add before the POST route:

```typescript
// GET / — List trigger registrations for a project (optionally filter by workflowId)
router.get('/', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantContext?.tenantId;
  const { projectId } = req.params;
  const { workflowId } = req.query;

  if (!tenantId || !projectId) {
    return res.status(400).json({ success: false, error: 'Missing required parameters' });
  }

  try {
    const filter: Record<string, unknown> = { tenantId, projectId };
    if (workflowId) filter.workflowId = workflowId;

    const registrations = await deps.triggerModel.find(filter).lean();
    return res.json({ success: true, data: registrations });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
});
```

**Step 3: Add GET proxy in workflow-engine-proxy.ts**

In `apps/runtime/src/middleware/workflow-engine-proxy.ts`, in the Triggers section, add a GET route:

```typescript
// GET /triggers — list trigger registrations
router.get('/triggers', (req: Request, res: Response) => {
  const { projectId } = params(req);
  const qs = new URLSearchParams(req.query as Record<string, string>).toString();
  const path = `/api/v1/projects/${projectId}/triggers${qs ? `?${qs}` : ''}`;
  proxyRequest(req, res, engineBase, path);
});
```

**Step 4: Update Studio trigger tab to fetch registrations**

In `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`, replace the `workflow.triggers` rendering with an SWR fetch:

```typescript
// Near the top of the component, add SWR fetch for registrations:
const { data: registrationsData, mutate: refreshRegistrations } = useSWR(
  projectId && workflowId
    ? `/api/projects/${encodeURIComponent(projectId)}/workflows/triggers?workflowId=${encodeURIComponent(workflowId)}`
    : null,
);

// In the render section (~line 452), replace:
//   const triggers = workflow.triggers.map(...)
// with:
const triggers = (registrationsData?.data ?? []).map((t: Record<string, unknown>) =>
  normalizeTrigger(t),
);
```

Also update create/pause/resume handlers to use `refreshRegistrations()` instead of mutating `workflow.triggers`.

**Step 5: Run tests**

Run: `cd apps/workflow-engine && npx vitest run src/__tests__/trigger-list-route.test.ts`
Expected: PASS

**Step 6: Commit**

```
[ABLP-2] feat(workflow): add trigger list endpoint and wire Studio tab to registrations
```

---

## Task 5: [P1] Enable notifications with proxy mapping

Notification buttons are hardcoded `disabled`, and no proxy mapping exists.

**Files:**

- Modify: `apps/runtime/src/middleware/workflow-engine-proxy.ts` (add notifications proxy routes)
- Modify: `apps/studio/src/components/workflows/tabs/WorkflowNotificationsTab.tsx` (enable buttons, add CRUD handlers)

**Step 1: Add notification proxy routes**

In `apps/runtime/src/middleware/workflow-engine-proxy.ts`, add a new section after Connectors:

```typescript
// ─── Notification Rules ──────────────────────────────────────────────────────

// GET /notifications — list notification rules for a workflow
router.get('/:workflowId/notifications', (req: Request, res: Response) => {
  const { projectId, workflowId } = params(req);
  proxyRequest(
    req,
    res,
    engineBase,
    `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications`,
  );
});

// POST /notifications — create a notification rule
router.post('/:workflowId/notifications', (req: Request, res: Response) => {
  const { projectId, workflowId } = params(req);
  proxyRequest(
    req,
    res,
    engineBase,
    `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications`,
  );
});

// PUT /notifications/:ruleId — update a notification rule
router.put('/:workflowId/notifications/:ruleId', (req: Request, res: Response) => {
  const { projectId, workflowId } = params(req);
  const ruleId = req.params.ruleId;
  proxyRequest(
    req,
    res,
    engineBase,
    `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}`,
  );
});

// DELETE /notifications/:ruleId — delete a notification rule
router.delete('/:workflowId/notifications/:ruleId', (req: Request, res: Response) => {
  const { projectId, workflowId } = params(req);
  const ruleId = req.params.ruleId;
  proxyRequest(
    req,
    res,
    engineBase,
    `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}`,
  );
});

// POST /notifications/:ruleId/test — test a notification rule
router.post('/:workflowId/notifications/:ruleId/test', (req: Request, res: Response) => {
  const { projectId, workflowId } = params(req);
  const ruleId = req.params.ruleId;
  proxyRequest(
    req,
    res,
    engineBase,
    `/api/v1/projects/${projectId}/workflows/${workflowId}/notifications/${ruleId}/test`,
  );
});
```

**Step 2: Enable notification buttons in Studio**

In `apps/studio/src/components/workflows/tabs/WorkflowNotificationsTab.tsx`:

Remove `disabled` from both `Add Rule` buttons (lines 165, 180) and add `onClick={handleAddRule}` handlers. Add SWR fetch for notification rules and CRUD handlers (create, delete) using the proxy endpoints above.

The pattern to follow is the same as the triggers tab — SWR fetch from `/api/projects/:projectId/workflows/:workflowId/notifications`, with `mutate` on create/delete.

**Step 3: Commit**

```
[ABLP-2] feat(workflow): wire notification rules proxy and enable Studio notification CRUD
```

---

## Task 6: [P1] Fix connections routing in AppShell

The `connections` case in AppShell ignores `subPage`, always rendering the list.

**Files:**

- Modify: `apps/studio/src/components/navigation/AppShell.tsx:395-396`
- Create: `apps/studio/src/components/workflows/connections/ConnectionDetailPage.tsx`
- Create: `apps/studio/src/components/workflows/connections/ConnectionCreatePage.tsx`

**Step 1: Create ConnectionDetailPage**

Create `apps/studio/src/components/workflows/connections/ConnectionDetailPage.tsx`:

```typescript
'use client';

import { useNavigationStore } from '../../../store/navigation-store';
import { useConnections } from '../../../hooks/useConnections';
import { PageHeader } from '../../ui/PageHeader';
import { Button } from '../../ui/Button';
import { ArrowLeft } from 'lucide-react';

export function ConnectionDetailPage() {
  const { projectId, subPage: connectionId, navigate } = useNavigationStore();
  const { connections, isLoading } = useConnections(projectId);

  const connection = connections.find((c) => c.id === connectionId);

  const handleBack = () => {
    navigate(`/projects/${projectId}/connections`);
  };

  if (isLoading) {
    return <div className="p-8 text-muted">Loading...</div>;
  }

  if (!connection) {
    return (
      <div className="p-8">
        <Button variant="ghost" onClick={handleBack} icon={<ArrowLeft className="w-4 h-4" />}>
          Back to Connections
        </Button>
        <div className="mt-4 text-muted">Connection not found.</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-muted hover:text-foreground text-sm transition-default mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Connections</span>
        </button>
        <PageHeader title={connection.displayName} description={`Connector: ${connection.connectorName}`} />
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-border-default bg-surface-secondary p-4">
            <h3 className="text-sm font-medium text-foreground mb-2">Connection Details</h3>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted w-32">ID</dt>
                <dd className="text-foreground font-mono text-xs">{connection.id}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted w-32">Connector</dt>
                <dd className="text-foreground">{connection.connectorName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted w-32">Status</dt>
                <dd className="text-foreground">{connection.status ?? 'active'}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create ConnectionCreatePage**

Create `apps/studio/src/components/workflows/connections/ConnectionCreatePage.tsx`:

A minimal create form with connector name, display name, and auth config fields. Uses the existing `useConnections` hook pattern and POSTs to `/api/projects/:projectId/workflows/connections`.

**Step 3: Fix AppShell routing**

In `apps/studio/src/components/navigation/AppShell.tsx`, replace lines 395-396:

```typescript
// Change from:
case 'connections':
  return <ConnectionsPage />;

// To:
case 'connections':
  if (subPage === 'new') {
    return <ConnectionCreatePage />;
  }
  if (subPage) {
    return <ConnectionDetailPage />;
  }
  return <ConnectionsPage />;
```

Add the imports at the top of the file:

```typescript
import { ConnectionDetailPage } from '../workflows/connections/ConnectionDetailPage';
import { ConnectionCreatePage } from '../workflows/connections/ConnectionCreatePage';
```

**Step 4: Commit**

```
[ABLP-2] fix(studio): add connections detail/create pages and fix AppShell routing
```

---

## Task 7: [P1] Add missing step types (tool_call, async_webhook)

Studio's StepTypeSelector omits `tool_call` and `async_webhook` which are supported by the engine.

**Files:**

- Modify: `apps/studio/src/components/workflows/steps/StepTypeSelector.tsx:30-112` (add entries)
- Modify: `apps/studio/src/components/workflows/steps/StepEditor.tsx:564-578` (add config editors)

**Step 1: Add step types to StepTypeSelector**

In `apps/studio/src/components/workflows/steps/StepTypeSelector.tsx`, add to the type union and the step definitions array:

```typescript
// Add to the type union (around line 30):
| 'tool_call'
| 'async_webhook'

// Add to the STEP_TYPES array (around line 57):
{
  type: 'tool_call',
  label: 'Tool Call',
  description: 'Invoke a registered tool by name',
  icon: Wrench, // from lucide-react
  category: 'Actions',
},
{
  type: 'async_webhook',
  label: 'Async Webhook',
  description: 'Send a webhook and wait for a callback',
  icon: Webhook, // from lucide-react
  category: 'Actions',
},
```

**Step 2: Add config editors in StepEditor**

In `apps/studio/src/components/workflows/steps/StepEditor.tsx`:

Add `ToolCallConfig` and `AsyncWebhookConfig` components following the existing pattern (e.g. `HttpRequestConfig`):

```typescript
function ToolCallConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup label="Tool Name">
        <Input
          value={(config.toolName as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, toolName: e.target.value })}
          placeholder="e.g. search_documents"
        />
      </FieldGroup>
      <FieldGroup label="Parameters (JSON)">
        <textarea
          className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-sm font-mono"
          rows={4}
          value={(config.params as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, params: e.target.value })}
          placeholder='{"query": "search term"}'
        />
      </FieldGroup>
    </div>
  );
}

function AsyncWebhookConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup label="URL">
        <Input
          value={(config.url as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, url: e.target.value })}
          placeholder="https://api.example.com/webhook"
        />
      </FieldGroup>
      <FieldGroup label="Method">
        <select
          className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-sm"
          value={(config.method as string) ?? 'POST'}
          onChange={(e) => onConfigChange({ ...config, method: e.target.value })}
        >
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
        </select>
      </FieldGroup>
      <FieldGroup label="Headers (JSON)">
        <textarea
          className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-sm font-mono"
          rows={3}
          value={(config.headers as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, headers: e.target.value })}
        />
      </FieldGroup>
      <FieldGroup label="Body (JSON)">
        <textarea
          className="w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-sm font-mono"
          rows={4}
          value={(config.body as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, body: e.target.value })}
        />
      </FieldGroup>
      <FieldGroup label="Callback URL Field">
        <Input
          value={(config.callbackUrlField as string) ?? 'callbackUrl'}
          onChange={(e) => onConfigChange({ ...config, callbackUrlField: e.target.value })}
          placeholder="callbackUrl"
        />
      </FieldGroup>
    </div>
  );
}
```

Add to the `configEditors` map:

```typescript
const configEditors: Record<string, React.ComponentType<ConfigEditorProps>> = {
  // existing entries...
  tool_call: ToolCallConfig,
  async_webhook: AsyncWebhookConfig,
};
```

**Step 3: Commit**

```
[ABLP-2] feat(studio): add tool_call and async_webhook step types to workflow editor
```

---

## Task 8: [P1] Add publish lifecycle controls

Studio has only a "Run" button, no way to change workflow status. Status type includes `draft` but DB doesn't support it.

**Files:**

- Modify: `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:296-307` (add status action buttons)
- Modify: `apps/studio/src/api/workflows.ts:28` (remove `draft` from type)

**Step 1: Fix status type**

In `apps/studio/src/api/workflows.ts`, change the status type:

```typescript
// Change from:
status: 'active' | 'paused' | 'archived' | 'draft';
// To:
status: 'active' | 'paused' | 'archived';
```

**Step 2: Add status action buttons to toolbar**

In `apps/studio/src/components/workflows/WorkflowDetailPage.tsx`, replace the right-side action buttons (around lines 296-307):

```typescript
{/* Right: action buttons */}
<div className="flex items-center gap-2 shrink-0">
  {workflow.status === 'active' && (
    <Button
      variant="secondary"
      onClick={() => handleStatusChange('paused')}
      icon={<Pause className="w-4 h-4" />}
    >
      Pause
    </Button>
  )}
  {workflow.status === 'paused' && (
    <Button
      variant="secondary"
      onClick={() => handleStatusChange('active')}
      icon={<Play className="w-4 h-4" />}
    >
      Activate
    </Button>
  )}
  {workflow.status !== 'archived' && (
    <Button
      variant="ghost"
      onClick={() => handleStatusChange('archived')}
      icon={<Archive className="w-4 h-4" />}
    >
      Archive
    </Button>
  )}
  <Button
    variant="primary"
    onClick={handleExecute}
    loading={isExecuting}
    disabled={workflow.status === 'archived'}
    icon={<Play className="w-4 h-4" />}
  >
    Run
  </Button>
</div>
```

Add the status change handler:

```typescript
const handleStatusChange = useCallback(
  async (newStatus: 'active' | 'paused' | 'archived') => {
    if (!projectId || !workflowId) return;
    try {
      setSaveError(null);
      await updateWorkflow(projectId, workflowId, { status: newStatus } as any);
      refresh();
    } catch (err) {
      setSaveError(
        sanitizeError(err, `Failed to ${newStatus === 'archived' ? 'archive' : 'update'} workflow`),
      );
    }
  },
  [projectId, workflowId, refresh],
);
```

Add `Pause` and `Archive` to the lucide-react import.

**Step 3: Commit**

```
[ABLP-2] feat(studio): add workflow publish lifecycle controls (pause/activate/archive)
```

---

## Task 9: [P1 security] Add project RBAC to engine execution and trigger routes

Engine routes only check `tenantId`/`projectId` presence but not project-level RBAC permissions.

**Files:**

- Modify: `apps/runtime/src/middleware/workflow-engine-proxy.ts` (add requireProjectPermission before proxy)
- Create: `apps/runtime/src/__tests__/workflow-proxy-rbac.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => ({ isDatabaseAvailable: vi.fn(() => true) }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

import express from 'express';
import request from 'supertest';

describe('workflow proxy RBAC', () => {
  test('execution proxy requires workflow:execute permission', async () => {
    const { createWorkflowEngineProxy } = await import('../middleware/workflow-engine-proxy.js');

    const app = express();
    app.use(express.json());
    // Inject viewer context — should be denied
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: 't1', userId: 'viewer-user' };
      next();
    });
    app.use('/api/projects/:projectId/workflows', createWorkflowEngineProxy());

    const res = await request(app)
      .post('/api/projects/p1/workflows/wf-1/executions/execute')
      .send({});

    // Should be denied (403 or 404) because viewer cannot execute
    expect([403, 404]).toContain(res.status);
  });

  test('trigger proxy requires workflow:execute permission', async () => {
    const { createWorkflowEngineProxy } = await import('../middleware/workflow-engine-proxy.js');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.tenantContext = { tenantId: 't1', userId: 'viewer-user' };
      next();
    });
    app.use('/api/projects/:projectId/workflows', createWorkflowEngineProxy());

    const res = await request(app)
      .post('/api/projects/p1/workflows/triggers')
      .send({ workflowId: 'wf-1', type: 'cron', config: {} });

    expect([403, 404]).toContain(res.status);
  });
});
```

**Step 2: Add RBAC middleware to proxy router**

In `apps/runtime/src/middleware/workflow-engine-proxy.ts`, add auth middleware and permission checks:

```typescript
import { authMiddleware } from './auth.js';
import { requireProjectScope } from '@agent-platform/shared';
import { requireProjectPermission } from '../middleware/project-permission.js';

export function createWorkflowEngineProxy(): Router {
  const router = Router({ mergeParams: true });
  const engineBase = process.env.WORKFLOW_ENGINE_URL || `http://localhost:${DEFAULT_WORKFLOW_ENGINE_PORT}`;

  // Apply auth middleware to ALL proxy routes
  router.use(authMiddleware);
  router.use(requireProjectScope('projectId'));

  // ... existing route definitions, but add permission guards:

  // Executions — require workflow:execute
  router.post('/:workflowId/executions/execute', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
    // ... existing proxy logic
  });

  // Triggers — require workflow:execute for mutations, workflow:read for reads
  router.get('/triggers', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:read'))) return;
    // ... proxy logic
  });

  router.post('/triggers', async (req: Request, res: Response) => {
    if (!(await requireProjectPermission(req, res, 'workflow:execute'))) return;
    // ... existing proxy logic
  });

  // Similar for DELETE, pause, resume trigger routes
  // Approvals — require workflow:execute
  // Notifications — require workflow:update for mutations, workflow:read for reads
  // Connectors — require workflow:read
```

**Step 3: Run tests**

Run: `cd apps/runtime && npx vitest run src/__tests__/workflow-proxy-rbac.test.ts`
Expected: PASS

**Step 4: Commit**

```
[ABLP-2] fix(security): add project RBAC to workflow engine proxy routes
```

---

## Dependency Graph

```
Task 1 (P0 step payload)  ─── independent
Task 2 (P0 connector route) ── independent
Task 3 (P0 trigger fields) ─── independent
Task 4 (P1 trigger list) ───── depends on Task 3 (field names must be correct first)
Task 5 (P1 notifications) ──── independent
Task 6 (P1 connections) ────── independent
Task 7 (P1 step types) ────── depends on Task 1 (new types must also denormalize correctly)
Task 8 (P1 publish) ────────── independent
Task 9 (P1 security) ────────── independent
```

**Recommended execution order:**

- Batch 1 (parallel): Tasks 1, 2, 3, 5, 6, 8, 9
- Batch 2 (sequential): Tasks 4, 7 (after their dependencies)
