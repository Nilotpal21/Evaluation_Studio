# ROI Tracking -- Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end ROI tracking: cost configuration API, ROI summary/trend/breakdown APIs, budget alerting, and a Studio dashboard with KPI cards, charts, and what-if simulation.

**Architecture:** Thin Express routes in runtime wrapping a stateless ROI service. Service orchestrates existing `ROICalculator` (pipeline-engine) + ClickHouse queries + Redis caching. Studio dashboard consumes via SWR hooks.

**Tech Stack:** Node.js/TypeScript, MongoDB/Mongoose, ClickHouse, Redis, Express, React 18, Next.js 15, Zustand, SWR, Tailwind, Recharts

**Feature Spec:** `docs/features/roi-tracking.md`
**Test Spec:** `docs/testing/roi-tracking.md`
**HLD:** `docs/specs/roi-tracking.hld.md`

---

## Phase Overview

| Phase | Name                     | Description                                                    | Independent?    |
| ----- | ------------------------ | -------------------------------------------------------------- | --------------- |
| 1     | Schema & Event Types     | Extend ProjectCostConfig, add ROI event schemas to eventstore  | Yes             |
| 2     | Cost Config API          | CRUD route + Zod validation for project cost configuration     | Yes             |
| 3     | ROI Service & APIs       | ROI summary, cost trend, agent breakdown, simulation endpoints | Depends on 1, 2 |
| 4     | Budget Alert Integration | Threshold evaluation + event emission + deduplication          | Depends on 1, 3 |
| 5     | Studio Dashboard UI      | ROI dashboard page, KPI cards, trend chart, breakdown table    | Depends on 3    |
| 6     | Studio Cost Config Panel | Settings form for cost configuration                           | Depends on 2    |
| 7     | Tests                    | E2E, integration, and unit tests per test spec                 | Depends on 1-6  |

---

## Phase 1: Schema & Event Types

**Exit Criteria:** `ProjectCostConfig` schema extended with budget alert fields. `roi.summary.computed` and `roi.budget.exceeded` event schemas registered in eventstore. `pnpm build --filter=pipeline-engine --filter=eventstore` passes.

### Task 1.1: Extend ProjectCostConfig Schema

**Files:**

- Modify: `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts`

- [ ] **Step 1:** Add optional budget alert fields to `IProjectCostConfig` interface:

```typescript
// Add to IProjectCostConfig interface:
budgetAlertThresholds?: number[];
lastAlertedThreshold?: number;
lastAlertedAt?: Date;
```

- [ ] **Step 2:** Add corresponding schema fields (all optional):

```typescript
// Add to ProjectCostConfigSchema:
budgetAlertThresholds: { type: [Number], default: [0.75, 0.90, 1.00] },
lastAlertedThreshold: { type: Number, default: null },
lastAlertedAt: { type: Date, default: null },
```

- [ ] **Step 3:** Verify build: `pnpm build --filter=pipeline-engine`

### Task 1.2: Add ROI Event Schemas to EventStore

**Files:**

- Create: `packages/eventstore/src/schema/events/roi-events.ts`
- Modify: `packages/eventstore/src/schema/events/index.ts` (if barrel export exists)

- [ ] **Step 1:** Read `packages/eventstore/src/schema/events/llm-events.ts` to verify the event registration pattern.

- [ ] **Step 2:** Create `roi-events.ts`:

```typescript
import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// roi.summary.computed
export const ROISummaryComputedDataSchema = z
  .object({
    monthly_savings: z.number().optional(),
    annual_savings: z.number().optional(),
    roi_percentage: z.number().optional(),
    fte_equivalent: z.number().optional(),
    budget_status: z.enum(['under', 'at', 'over']).optional(),
    budget_remaining: z.number().optional(),
    actual_ai_cost: z.number().optional(),
    configured_budget: z.number().optional(),
  })
  .passthrough();

export type ROISummaryComputedData = z.infer<typeof ROISummaryComputedDataSchema>;

eventRegistry.register('roi.summary.computed', ROISummaryComputedDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ANALYTICS,
  containsPII: false,
  description: 'ROI summary computed for project',
});

// roi.budget.exceeded
export const ROIBudgetExceededDataSchema = z
  .object({
    threshold: z.number(),
    actual_utilization: z.number(),
    actual_ai_cost: z.number(),
    configured_budget: z.number(),
    budget_status: z.enum(['under', 'at', 'over']),
  })
  .passthrough();

export type ROIBudgetExceededData = z.infer<typeof ROIBudgetExceededDataSchema>;

eventRegistry.register('roi.budget.exceeded', ROIBudgetExceededDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.ANALYTICS,
  containsPII: false,
  description: 'Project AI cost exceeded a budget threshold',
});
```

- [ ] **Step 3:** Read `packages/eventstore/src/schema/event-categories.ts` to verify `EVENT_CATEGORIES.ANALYTICS` exists. If not, add it.

- [ ] **Step 4:** Ensure `roi-events.ts` is imported in the events barrel (check if one exists at `packages/eventstore/src/schema/events/index.ts`).

- [ ] **Step 5:** Verify build: `pnpm build --filter=eventstore`

### Task 1.3: Export ROICalculator from pipeline-engine

**Files:**

- Read: `packages/pipeline-engine/src/index.ts`

- [ ] **Step 1:** Verify `ROICalculator` and `ProjectCostConfigModel` are already exported from `packages/pipeline-engine/src/index.ts`. If not, add exports.

- [ ] **Step 2:** Verify build: `pnpm build --filter=pipeline-engine`

---

## Phase 2: Cost Config API

**Exit Criteria:** `GET/PUT /api/projects/:projectId/cost-config` endpoints working with auth, validation, tenant/project isolation. Build passes.

### Task 2.1: Create Cost Config Route

**Files:**

- Create: `apps/runtime/src/routes/cost-config.ts`

- [ ] **Step 1:** Read `apps/runtime/src/routes/tenant-usage.ts` to understand the route pattern (auth middleware, Zod validation, tenant context extraction).

- [ ] **Step 2:** Read `apps/runtime/src/middleware/rbac.ts` to verify `requireProjectPermission` signature.

- [ ] **Step 3:** Create `cost-config.ts` route:

```typescript
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { ProjectCostConfigModel } from '@agent-platform/pipeline-engine';

const log = createLogger('cost-config-route');
const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

const costConfigBodySchema = z.object({
  costPerHumanInteraction: z.number().positive(),
  costPerAIInteraction: z.number().nonnegative(),
  fteCapacityPerDay: z.number().positive().int(),
  fteCostPerYear: z.number().positive(),
  monthlyBudget: z.number().positive(),
  containmentRate: z.number().min(0).max(1),
  totalConversationsPerMonth: z.number().nonnegative().int(),
  budgetAlertThresholds: z.array(z.number().min(0).max(2)).optional(),
});

// GET / — Read cost config
router.get('/', requireProjectPermission('analytics:read'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantContext?.tenantId;
    const { projectId } = req.params;

    const config = await ProjectCostConfigModel.findOne({ tenantId, projectId });
    if (!config) {
      res.status(404).json({
        success: false,
        error: {
          code: 'COST_CONFIG_NOT_FOUND',
          message: 'No cost configuration found for this project',
        },
      });
      return;
    }

    res.json({ success: true, data: config });
  } catch (err) {
    log.error('Failed to read cost config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to read cost configuration' },
    });
  }
});

// PUT / — Upsert cost config
router.put('/', requireProjectPermission('analytics:write'), async (req, res) => {
  try {
    const tenantId = (req as any).tenantContext?.tenantId;
    const { projectId } = req.params;
    const userId = (req as any).userId;

    const parsed = costConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const config = await ProjectCostConfigModel.findOneAndUpdate(
      { tenantId, projectId },
      { ...parsed.data, tenantId, projectId, createdBy: userId },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Invalidate Redis cache for ROI summary
    try {
      const { getRedisClient } = await import('../services/redis/redis-client.js');
      const redis = getRedisClient();
      const pattern = `roi:summary:${tenantId}:${projectId}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      log.debug('Redis cache invalidation skipped (Redis unavailable)');
    }

    log.info('Cost config updated', { tenantId, projectId });
    res.json({ success: true, data: config });
  } catch (err) {
    log.error('Failed to update cost config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update cost configuration' },
    });
  }
});

export default router;
```

### Task 2.2: Mount Cost Config Route

**Files:**

- Modify: `apps/runtime/src/server.ts` (or the route registration file)

- [ ] **Step 1:** Read `apps/runtime/src/server.ts` to find where routes are mounted.

- [ ] **Step 2:** Add cost-config route mount:

```typescript
import costConfigRouter from './routes/cost-config.js';
// Mount under project scope
app.use('/api/projects/:projectId/cost-config', costConfigRouter);
```

- [ ] **Step 3:** Wrap mount in feature flag check:

```typescript
if (process.env.FEATURE_ROI_TRACKING !== 'false') {
  app.use('/api/projects/:projectId/cost-config', costConfigRouter);
}
```

- [ ] **Step 4:** Verify build: `pnpm build --filter=runtime`

---

## Phase 3: ROI Service & APIs

**Exit Criteria:** ROI summary, cost trend, agent breakdown, and simulation endpoints working. Redis caching operational. Build passes.

### Task 3.1: Create ROI Service

**Files:**

- Create: `apps/runtime/src/services/roi-service.ts`

- [ ] **Step 1:** Read `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts` to verify the `ROICalculator` API.

- [ ] **Step 2:** Read `apps/runtime/src/routes/tenant-usage.ts` to understand the ClickHouse query pattern.

- [ ] **Step 3:** Create `roi-service.ts`:

The service should:

- `getROISummary(tenantId, projectId, from, to)` -- Check Redis cache, if miss: query ClickHouse for total AI cost in period, load ProjectCostConfig, compute summary via ROICalculator, cache, return.
- `getCostTrend(tenantId, projectId, from, to, granularity)` -- Query ClickHouse with date truncation GROUP BY.
- `getAgentBreakdown(tenantId, projectId, from, to)` -- Query ClickHouse GROUP BY agent_name.
- `simulate(tenantId, projectId, newContainmentRate)` -- Load config, call `ROICalculator.simulateContainmentChange`.
- `checkBudgetThresholds(tenantId, projectId, actualAICost)` -- Compare against configured thresholds, emit event if crossed.

Key implementation notes:

- Use `createLogger('roi-service')` for logging.
- ClickHouse queries use the existing `getClickHouseClient()` from `@agent-platform/database/clickhouse`.
- Redis keys: `roi:summary:${tenantId}:${projectId}:${md5(from+to)}` with 300s TTL.
- All ClickHouse queries MUST include `tenant_id = {tenantId}` AND `project_id = {projectId}` in WHERE clause.
- Use parameterized queries to prevent SQL injection.

- [ ] **Step 4:** Verify the ClickHouse table name for LLM metrics by reading `apps/runtime/src/services/stores/clickhouse-metrics-store.ts` (first 50 lines).

### Task 3.2: Create ROI Route

**Files:**

- Create: `apps/runtime/src/routes/roi.ts`

- [ ] **Step 1:** Create the route file with 4 endpoints:

```
GET  /summary           -> ROI summary
GET  /cost-trend        -> Time-series cost data
GET  /agent-breakdown   -> Per-agent breakdown
POST /simulate          -> What-if simulation
```

Each endpoint:

1. Extracts `tenantId` from `req.tenantContext.tenantId`
2. Extracts `projectId` from `req.params.projectId`
3. Validates query/body with Zod
4. Calls ROI service method
5. Returns `{ success: true, data }` or error envelope

Validation schemas:

- Time range: `from` (ISO datetime), `to` (ISO datetime)
- Granularity: `z.enum(['day', 'week', 'month']).default('day')`
- Simulation body: `z.object({ containmentRate: z.number().min(0).max(1) })`

- [ ] **Step 2:** Mount in server.ts:

```typescript
import roiRouter from './routes/roi.js';
if (process.env.FEATURE_ROI_TRACKING !== 'false') {
  app.use('/api/projects/:projectId/roi', roiRouter);
}
```

- [ ] **Step 3:** Verify build: `pnpm build --filter=runtime`

### Task 3.3: Add Studio Proxy Route

**Files:**

- Read: `apps/studio/src/proxy.ts` or `apps/studio/src/app/api/runtime/` to understand how Studio proxies to Runtime.

- [ ] **Step 1:** If Studio uses Next.js API routes to proxy to Runtime, verify the proxy pattern and ensure `/api/projects/:projectId/cost-config` and `/api/projects/:projectId/roi/*` are routed through.

- [ ] **Step 2:** If a proxy allowlist exists, add the new paths.

---

## Phase 4: Budget Alert Integration

**Exit Criteria:** Budget threshold evaluation emits `roi.budget.exceeded` events. Deduplication prevents duplicate alerts. Build passes.

### Task 4.1: Implement Budget Threshold Check in ROI Service

**Files:**

- Modify: `apps/runtime/src/services/roi-service.ts`

- [ ] **Step 1:** Add `checkBudgetThresholds` method:

```typescript
async checkBudgetThresholds(
  tenantId: string,
  projectId: string,
  actualAICost: number,
): Promise<void> {
  const config = await ProjectCostConfigModel.findOne({ tenantId, projectId });
  if (!config || !config.monthlyBudget || config.monthlyBudget <= 0) return;

  const utilization = actualAICost / config.monthlyBudget;
  const thresholds = config.budgetAlertThresholds ?? [0.75, 0.90, 1.00];
  const sortedThresholds = [...thresholds].sort((a, b) => b - a); // highest first

  for (const threshold of sortedThresholds) {
    if (utilization >= threshold) {
      // Check deduplication
      if (config.lastAlertedThreshold && config.lastAlertedThreshold >= threshold) {
        // Already alerted for this or higher threshold
        break;
      }

      // Emit event
      // ... emit roi.budget.exceeded platform event ...

      // Update deduplication state
      await ProjectCostConfigModel.findOneAndUpdate(
        { tenantId, projectId },
        { lastAlertedThreshold: threshold, lastAlertedAt: new Date() },
      );

      log.info('Budget alert emitted', { tenantId, projectId, threshold, utilization });
      break; // Only alert for highest crossed threshold
    }
  }
}
```

- [ ] **Step 2:** Call `checkBudgetThresholds` at the end of `getROISummary` (fire-and-forget, do not block response).

- [ ] **Step 3:** Add monthly reset logic: if `lastAlertedAt` is in a previous month, reset `lastAlertedThreshold` to null before checking.

- [ ] **Step 4:** Verify build: `pnpm build --filter=runtime`

---

## Phase 5: Studio Dashboard UI

**Exit Criteria:** ROI dashboard page renders with KPI cards, cost trend chart, agent breakdown table, and simulation slider. Navigation wired. Build passes.

### Task 5.1: Create ROI SWR Hook

**Files:**

- Create: `apps/studio/src/hooks/useROI.ts`

- [ ] **Step 1:** Read `apps/studio/src/hooks/useAnalytics.ts` to understand the SWR pattern used in Studio.

- [ ] **Step 2:** Read `apps/studio/src/lib/api-client.ts` to verify the `apiFetch` function signature.

- [ ] **Step 3:** Create `useROI.ts` with hooks:
  - `useROISummary(projectId, timeRange)` -- fetches `/api/projects/:projectId/roi/summary`
  - `useCostTrend(projectId, timeRange, granularity)` -- fetches `/api/projects/:projectId/roi/cost-trend`
  - `useAgentBreakdown(projectId, timeRange)` -- fetches `/api/projects/:projectId/roi/agent-breakdown`
  - `useCostConfig(projectId)` -- fetches `/api/projects/:projectId/cost-config`

### Task 5.2: Create ROI Dashboard Page

**Files:**

- Create: `apps/studio/src/components/roi/ROIDashboardPage.tsx`
- Create: `apps/studio/src/components/roi/ROIKPICards.tsx`
- Create: `apps/studio/src/components/roi/CostTrendChart.tsx`
- Create: `apps/studio/src/components/roi/AgentBreakdownTable.tsx`
- Create: `apps/studio/src/components/roi/SimulationSlider.tsx`

- [ ] **Step 1:** Read `apps/studio/src/app/globals.css` to understand design tokens (colors, spacing).

- [ ] **Step 2:** Read existing dashboard components (e.g., `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx`) for layout patterns.

- [ ] **Step 3:** Read `apps/studio/src/components/session/MetricsBar.tsx` for KPI card patterns.

- [ ] **Step 4:** Create `ROIDashboardPage.tsx`:
  - Time range selector at top (7d, 30d, 90d, custom).
  - 4 KPI cards: Monthly Savings, ROI %, FTEs Freed, Budget Status.
  - Cost trend line chart (Recharts `LineChart` or `AreaChart`).
  - Agent breakdown table (sortable by cost).
  - Simulation section with containment rate slider.
  - Empty state: "Configure cost settings to see ROI metrics" with link to settings.

- [ ] **Step 5:** Create `ROIKPICards.tsx`:
  - 4 cards in a grid layout.
  - Budget status card uses color coding: green (under), yellow (at 75%+), red (over).
  - Uses `formatCost` from `apps/studio/src/utils/llm-cost.ts`.

- [ ] **Step 6:** Create `CostTrendChart.tsx`:
  - Line chart with date on x-axis, cost on y-axis.
  - Uses Recharts (check if already a dependency).
  - Responsive container.

- [ ] **Step 7:** Create `AgentBreakdownTable.tsx`:
  - Sortable table with columns: Agent, Conversations, Tokens, Cost, Avg Cost/Conv.
  - CSV export button.

- [ ] **Step 8:** Create `SimulationSlider.tsx`:
  - Range slider from current containment to 1.0.
  - Client-side computation using same formulas as `ROICalculator`.
  - Displays: current savings, projected savings, delta, additional FTEs.
  - No API call -- all computation in browser.

### Task 5.3: Wire Navigation

**Files:**

- Modify: `apps/studio/src/config/navigation.ts`

- [ ] **Step 1:** Read `apps/studio/src/config/navigation.ts` to understand nav structure.

- [ ] **Step 2:** Add ROI Dashboard entry under the appropriate section (likely under "Insights" or "Analytics").

- [ ] **Step 3:** Add Next.js page route for the dashboard.

- [ ] **Step 4:** Verify build: `pnpm build --filter=studio`

---

## Phase 6: Studio Cost Config Panel

**Exit Criteria:** Cost configuration form accessible from project settings. Form validates input, submits via PUT, shows success/error feedback.

### Task 6.1: Create Cost Config Form

**Files:**

- Create: `apps/studio/src/components/settings/CostConfigTab.tsx`

- [ ] **Step 1:** Read `apps/studio/src/components/settings/ModelConfigTab.tsx` for the settings tab pattern.

- [ ] **Step 2:** Create `CostConfigTab.tsx`:
  - Form fields: cost per human interaction, cost per AI interaction, FTE capacity/day, FTE cost/year, monthly budget, containment rate, total conversations/month.
  - Budget alert threshold configuration (multi-select or comma-separated input).
  - Pre-populated with existing config (from `useCostConfig` hook) or industry defaults.
  - Validation matching the Zod schema (positive numbers, containment 0-1).
  - Submit calls PUT `/api/projects/:projectId/cost-config`.
  - Success toast notification.
  - Link to ROI dashboard after saving.

### Task 6.2: Wire Cost Config Tab into Settings

**Files:**

- Read and modify the settings page that contains tabs (find by reading `ModelConfigTab` imports).

- [ ] **Step 1:** Add "Cost & ROI" tab to the project settings page.

- [ ] **Step 2:** Verify build: `pnpm build --filter=studio`

---

## Phase 7: Tests

**Exit Criteria:** All tests from the test spec pass. `pnpm test` green for affected packages.

### Task 7.1: Unit Tests for ROI Calculator Edge Cases

**Files:**

- Modify: `packages/pipeline-engine/src/__tests__/roi-calculator.test.ts`

- [ ] **Step 1:** Add 3 edge case tests:
  - `costPerAIInteraction > costPerHumanInteraction` -- negative savings
  - `containmentRate = 1.0` -- maximum savings
  - `totalConversationsPerMonth = 0` -- all zeros

### Task 7.2: Unit Tests for Zod Validation Schemas

**Files:**

- Create: `apps/runtime/src/__tests__/roi-validation.test.ts`

- [ ] **Step 1:** Test cost config body schema:
  - Valid body passes
  - Missing required fields rejected
  - Negative numbers rejected
  - Containment > 1 rejected

### Task 7.3: Unit Tests for Client-Side Simulation

**Files:**

- Create: `apps/studio/src/__tests__/roi-simulation.test.ts`

- [ ] **Step 1:** Test simulation computation:
  - Slider at current containment: delta = 0
  - Slider at 100%: maximum delta
  - Slider below current: negative delta

### Task 7.4: Integration Tests for ROI Service

**Files:**

- Create: `apps/runtime/src/__tests__/roi-service.integration.test.ts`

- [ ] **Step 1:** Test ROI summary computation with real ROICalculator + mock ClickHouse adapter (DI).
- [ ] **Step 2:** Test Redis cache behavior (set, get, invalidate).
- [ ] **Step 3:** Test budget threshold evaluation and deduplication.

### Task 7.5: E2E Tests for Cost Config API

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/cost-config.e2e.test.ts`

- [ ] **Step 1:** Start real Express server on random port.
- [ ] **Step 2:** Test CRUD operations via HTTP.
- [ ] **Step 3:** Test tenant/project isolation (cross-tenant returns 404).
- [ ] **Step 4:** Test validation errors (negative values, missing fields).

### Task 7.6: E2E Tests for ROI APIs

**Files:**

- Create: `apps/runtime/src/__tests__/e2e/roi.e2e.test.ts`

- [ ] **Step 1:** Test ROI summary with seeded config + ClickHouse test adapter.
- [ ] **Step 2:** Test cost trend endpoint.
- [ ] **Step 3:** Test agent breakdown endpoint.
- [ ] **Step 4:** Test simulation endpoint.
- [ ] **Step 5:** Test auth/isolation scenarios.

---

## Wiring Checklist

Every phase must verify these integration points:

- [ ] `ProjectCostConfig` schema changes are backward-compatible (optional fields only)
- [ ] ROI event schemas are imported in eventstore barrel export
- [ ] `ROICalculator` and `ProjectCostConfigModel` are exported from pipeline-engine index
- [ ] Cost config route mounted in runtime server.ts behind feature flag
- [ ] ROI route mounted in runtime server.ts behind feature flag
- [ ] Static routes registered BEFORE parameterized routes in server.ts
- [ ] Studio proxy routes pass through cost-config and roi paths
- [ ] ROI dashboard page has a Next.js route entry
- [ ] Navigation config includes ROI dashboard link
- [ ] Cost config tab wired into settings page
- [ ] All ClickHouse queries include `tenant_id` AND `project_id` in WHERE clause
- [ ] All MongoDB queries use `findOne({ tenantId, projectId })`, never `findById`
- [ ] Redis cache keys include `tenantId:projectId` prefix
- [ ] Error responses use standard envelope `{ success, error: { code, message } }`
- [ ] `npx prettier --write` run on all changed files before each commit
- [ ] `pnpm build --filter=<package>` passes after each phase

---

## Risk Mitigation During Implementation

| Risk                                                  | Mitigation                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| ClickHouse table name or schema differs from expected | Read actual ClickHouse store code before writing queries (Task 3.1 Step 4) |
| Auth middleware signature different than assumed      | Read actual middleware before using (Task 2.1 Step 2)                      |
| Studio proxy does not support new paths               | Verify proxy config before building UI (Task 3.3)                          |
| Recharts not installed in Studio                      | Check package.json; if missing, use CSS-only bar charts or add dependency  |
| Redis client not available in runtime                 | Graceful fallback: skip caching, compute on every request                  |

---

## Estimated LOE

| Phase     | Files Created | Files Modified | LOE          |
| --------- | ------------- | -------------- | ------------ |
| 1         | 1             | 2              | 2 hours      |
| 2         | 1             | 1              | 3 hours      |
| 3         | 2             | 1              | 6 hours      |
| 4         | 0             | 1              | 2 hours      |
| 5         | 6             | 2              | 8 hours      |
| 6         | 1             | 1              | 3 hours      |
| 7         | 5             | 1              | 8 hours      |
| **Total** | **16**        | **9**          | **32 hours** |
