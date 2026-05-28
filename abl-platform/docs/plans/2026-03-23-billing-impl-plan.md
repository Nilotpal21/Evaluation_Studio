# Low-Level Design & Implementation Plan: Billing & Usage

**Feature:** Billing & Usage
**Date:** 2026-03-23
**Feature Spec:** `docs/features/billing.md`
**Test Spec:** `docs/testing/billing.md`
**HLD:** `docs/specs/billing.hld.md`

---

> Retired design note (2026-04-01): this implementation plan predates the current billing replay/materialization architecture. The `UsagePeriod` worker path below is no longer the active design. Do not start new implementation from this document without first reconciling it with the live replay/materialization slices.

## Implementation Phases

The implementation is split into 5 phases, each independently deployable and testable.

---

## Phase 1: Quota Enforcement Middleware

**Goal:** Add request-time quota enforcement that checks tenant token budgets and session limits, with Redis caching for performance.

### 1.1 Files to Create

#### `apps/runtime/src/middleware/quota-enforcement.ts`

**Purpose:** Express middleware that checks tenant usage against subscription/deal quotas.

**Detailed Design:**

```typescript
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('quota-enforcement');

// ── Constants ──────────────────────────────────────────────────────────
const REDIS_KEY_PREFIX = 'billing:quota:';
const REDIS_TTL_SECONDS = 60;
const DEFAULT_THRESHOLDS = [80, 90, 95, 100];

// ── Types ──────────────────────────────────────────────────────────────
interface QuotaState {
  tenantId: string;
  tokenBudget: number | null; // null = unlimited
  sessionLimit: number | null;
  currentTokenUsage: number;
  currentSessionCount: number;
  resolvedAt: number;
}

interface QuotaCheckResult {
  allowed: boolean;
  quotaType?: 'tokens' | 'sessions';
  usage?: number;
  limit?: number;
  thresholdLevel: 'none' | 'warning' | 'high' | 'critical' | 'exceeded';
}

// ── Pure Functions ─────────────────────────────────────────────────────

export function isQuotaExceeded(usage: number, budget: number | null): boolean {
  if (budget === null || budget === undefined) return false;
  return usage >= budget;
}

export function getThresholdLevel(
  usage: number,
  budget: number | null,
): QuotaCheckResult['thresholdLevel'] {
  if (budget === null || budget === undefined || budget === 0) return 'none';
  const pct = (usage / budget) * 100;
  if (pct >= 100) return 'exceeded';
  if (pct >= 95) return 'critical';
  if (pct >= 90) return 'high';
  if (pct >= 80) return 'warning';
  return 'none';
}

export function resolveEffectiveQuota(
  subscription: { orgLimits?: any } | null,
  deals: Array<{ phases?: any[]; creditAllotment?: any }> | null,
): { tokenBudget: number | null; sessionLimit: number | null } {
  // Start with subscription limits
  let tokenBudget: number | null = subscription?.orgLimits?.tokenBudget ?? null;
  let sessionLimit: number | null = subscription?.orgLimits?.sessionLimit ?? null;

  // Deal limits override if present
  if (deals && deals.length > 0) {
    for (const deal of deals) {
      const currentPhase = deal.phases?.find((p: any) => {
        const now = Date.now();
        return new Date(p.startDate).getTime() <= now && new Date(p.endDate).getTime() >= now;
      });
      if (currentPhase?.environments?.production) {
        const limits = currentPhase.environments.production;
        if (limits.maxTokensPerMinute != null) {
          // Deal provides rate limits, not period budgets — use creditAllotment for budget
        }
      }
      if (deal.creditAllotment?.totalCredits != null) {
        tokenBudget = deal.creditAllotment.totalCredits;
      }
    }
  }

  return { tokenBudget, sessionLimit };
}

export function buildRedisQuotaKey(tenantId: string): string {
  return `${REDIS_KEY_PREFIX}${tenantId}`;
}

export function parseQuotaFromCache(data: string | null): QuotaState | null {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    log.warn('Failed to parse quota cache', { data: data.substring(0, 100) });
    return null;
  }
}

// ── Middleware Factory ──────────────────────────────────────────────────

export function createQuotaEnforcementMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Feature flag check
    if (process.env.QUOTA_ENFORCEMENT_ENABLED !== 'true') {
      return next();
    }

    try {
      const tenantId = (req as any).tenantContext?.tenantId;
      if (!tenantId) return next(); // No tenant context = skip

      // Platform admin bypass
      if ((req as any).tenantContext?.isPlatformAdmin) return next();

      // Try Redis cache first
      let quotaState: QuotaState | null = null;
      try {
        const { getRedisClient } = await import('../services/redis-client.js');
        const redis = getRedisClient();
        const cached = await redis.get(buildRedisQuotaKey(tenantId));
        quotaState = parseQuotaFromCache(cached);
      } catch {
        // Redis unavailable — will resolve from DB
      }

      if (!quotaState) {
        // Resolve from MongoDB + ClickHouse
        quotaState = await resolveQuotaState(tenantId);

        // Cache in Redis (fire-and-forget)
        try {
          const { getRedisClient } = await import('../services/redis-client.js');
          const redis = getRedisClient();
          await redis.set(
            buildRedisQuotaKey(tenantId),
            JSON.stringify(quotaState),
            'EX',
            REDIS_TTL_SECONDS,
          );
        } catch {
          // Redis write failure — non-fatal
        }
      }

      // Check token budget
      const tokenResult = checkQuota(
        quotaState.currentTokenUsage,
        quotaState.tokenBudget,
        'tokens',
      );

      if (tokenResult.thresholdLevel === 'exceeded') {
        log.info('Quota exceeded', {
          tenantId,
          quotaType: 'tokens',
          usage: quotaState.currentTokenUsage,
          limit: quotaState.tokenBudget,
        });
        res.status(429).json({
          success: false,
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `Token quota exceeded. Usage: ${quotaState.currentTokenUsage}, Limit: ${quotaState.tokenBudget}`,
          },
        });
        return;
      }

      // Check session limit
      const sessionResult = checkQuota(
        quotaState.currentSessionCount,
        quotaState.sessionLimit,
        'sessions',
      );

      if (sessionResult.thresholdLevel === 'exceeded') {
        log.info('Quota exceeded', {
          tenantId,
          quotaType: 'sessions',
          usage: quotaState.currentSessionCount,
          limit: quotaState.sessionLimit,
        });
        res.status(429).json({
          success: false,
          error: {
            code: 'QUOTA_EXCEEDED',
            message: `Session quota exceeded. Usage: ${quotaState.currentSessionCount}, Limit: ${quotaState.sessionLimit}`,
          },
        });
        return;
      }

      // Emit threshold events if needed (fire-and-forget)
      emitThresholdEvents(tenantId, tokenResult, sessionResult).catch(() => {});

      next();
    } catch (error: unknown) {
      // Fail-open: don't block requests on quota check failures
      const message = error instanceof Error ? error.message : String(error);
      log.error('Quota enforcement check failed, proceeding (fail-open)', {
        error: message,
      });
      next();
    }
  };
}

function checkQuota(
  usage: number,
  budget: number | null,
  quotaType: 'tokens' | 'sessions',
): QuotaCheckResult {
  const exceeded = isQuotaExceeded(usage, budget);
  const thresholdLevel = getThresholdLevel(usage, budget);
  return {
    allowed: !exceeded,
    quotaType,
    usage,
    limit: budget ?? undefined,
    thresholdLevel,
  };
}

async function resolveQuotaState(tenantId: string): Promise<QuotaState> {
  const { Subscription, Deal, Tenant } = await import('@agent-platform/database/models');

  // Load subscription
  const subscription = await Subscription.findOne({
    tenantId,
    status: 'active',
  })
    .lean()
    .exec();

  // Resolve organizationId
  const tenant = await Tenant.findOne({ _id: tenantId }).lean().exec();
  const organizationId = (tenant as any)?.organizationId || tenantId;

  // Load active deals
  const deals = await Deal.find({
    organizationId,
    status: 'active',
  })
    .lean()
    .exec();

  // Merge quotas
  const { tokenBudget, sessionLimit } = resolveEffectiveQuota(subscription as any, deals as any[]);

  // Get current period usage from ClickHouse
  let currentTokenUsage = 0;
  let currentSessionCount = 0;
  try {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const { ClickHouseMetricsStore } =
      await import('../services/stores/clickhouse-metrics-store.js');
    const client = getClickHouseClient();
    const store = new ClickHouseMetricsStore({ type: 'clickhouse' }, { client });

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const usage = await store.getTenantUsage({
      tenantId,
      startDate: periodStart,
      endDate: now,
    });
    currentTokenUsage = usage.totalTokens;
    currentSessionCount = usage.totalRequests;
  } catch {
    // ClickHouse unavailable — use 0 (fail-open)
  }

  return {
    tenantId,
    tokenBudget,
    sessionLimit,
    currentTokenUsage,
    currentSessionCount,
    resolvedAt: Date.now(),
  };
}

async function emitThresholdEvents(
  tenantId: string,
  tokenResult: QuotaCheckResult,
  sessionResult: QuotaCheckResult,
): Promise<void> {
  if (tokenResult.thresholdLevel === 'none' && sessionResult.thresholdLevel === 'none') {
    return;
  }
  // Event emission will be implemented in Phase 4
  log.debug('Quota threshold crossed', {
    tenantId,
    tokenLevel: tokenResult.thresholdLevel,
    sessionLevel: sessionResult.thresholdLevel,
  });
}
```

### 1.2 Files to Modify

#### `apps/runtime/src/server.ts`

Add quota enforcement middleware to the tenant router, after auth and rate limiting:

```typescript
// Import
import { createQuotaEnforcementMiddleware } from './middleware/quota-enforcement.js';

// After line ~485 (after tenantRouter.use(requireTenantMatch)):
tenantRouter.use(createQuotaEnforcementMiddleware());
```

### 1.3 Exit Criteria

- [ ] Quota enforcement middleware exists with feature flag (`QUOTA_ENFORCEMENT_ENABLED`)
- [ ] Pure functions exported and unit-testable: `isQuotaExceeded`, `getThresholdLevel`, `resolveEffectiveQuota`, `buildRedisQuotaKey`, `parseQuotaFromCache`
- [ ] Redis cache path works (get/set with TTL)
- [ ] Fail-open on Redis/ClickHouse/MongoDB errors
- [ ] Platform admin bypass works
- [ ] Returns 429 with `QUOTA_EXCEEDED` error code when quota exceeded
- [ ] 8 unit tests pass (UNIT-1)
- [ ] `pnpm build --filter=runtime` succeeds

---

## Phase 2: Credit Consumption Pipeline

**Goal:** After each LLM call, calculate credit consumption and write entries to CreditLedger.

### 2.1 Files to Create

#### `apps/runtime/src/services/billing/credit-consumption.service.ts`

**Purpose:** Service that records credit consumption after LLM calls.

**Key Functions:**

```typescript
// calculateCreditsForTokens(tokens, feature, dealCreditMapping): number
// buildCreditEntry(params): ICreditEntry
// selectDealForCredits(organizationId): IDeal | null
// recordCreditConsumption(params): Promise<void>
```

**Integration Point:** Called from `apps/runtime/src/routes/chat.ts` after each `.record()` call (lines ~399, ~553, ~1164 in chat.ts).

**Write Pattern:**

```typescript
await CreditLedger.findOneAndUpdate(
  {
    dealId,
    periodStart: computePeriodStart(billingCycle),
  },
  {
    $push: { entries: creditEntry },
    $inc: {
      totalConsumed: credits,
      [`featureUsage.${feature}`]: credits,
    },
    $setOnInsert: {
      organizationId,
      periodEnd: computePeriodEnd(billingCycle),
      totalAllocated: deal.creditAllotment.totalCredits,
    },
  },
  { upsert: true, new: true },
);
```

#### `apps/runtime/src/services/billing/billing-utils.ts`

**Purpose:** Shared utility functions for billing calculations.

**Key Functions:**

```typescript
export function computePeriodLabel(date: Date, cycle: string): string;
export function computePeriodBounds(
  billingStartDate: Date,
  billingCycle: string,
): { start: Date; end: Date };
export function mergeUsageTotals(
  existing: Partial<IUsagePeriod>,
  incoming: UsageSummary,
): Partial<IUsagePeriod>;
```

### 2.2 Files to Modify

#### `apps/runtime/src/routes/chat.ts`

Add credit consumption calls after each `metricsStore.record()`:

```typescript
// After line ~399 (first .record() call):
import { recordCreditConsumption } from '../services/billing/credit-consumption.service.js';

// Fire-and-forget credit recording after metrics recording
recordCreditConsumption({
  tenantId,
  projectId,
  sessionId: sessionId || 'adhoc',
  feature: 'llm_inference',
  tokens: inputTokens + outputTokens,
  modelId: resolvedModelId,
}).catch((err) => {
  log.warn('Credit consumption recording failed', {
    error: err instanceof Error ? err.message : String(err),
  });
});
```

Same pattern for the other two `.record()` call sites (lines ~553, ~1164).

### 2.3 Exit Criteria

- [ ] `credit-consumption.service.ts` created with all functions
- [ ] `billing-utils.ts` created with period calculation functions
- [ ] Credit entries written to CreditLedger after LLM calls
- [ ] Atomic `$push` + `$inc` pattern (no read-modify-write)
- [ ] Upsert creates ledger if not exists for current period
- [ ] No deal → no credit entry (graceful skip)
- [ ] 6 unit tests pass (UNIT-2)
- [ ] 5 unit tests pass (UNIT-3)
- [ ] `pnpm build --filter=runtime` succeeds

---

## Phase 3: Usage Aggregation Worker

**Goal:** Periodically roll up ClickHouse metrics into UsagePeriod documents.

### 3.1 Files to Create

#### `apps/runtime/src/workers/usage-aggregation.worker.ts`

**Purpose:** BullMQ worker that processes usage aggregation jobs.

**Design:**

```typescript
import { Queue, Worker, type Job } from 'bullmq';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('usage-aggregation-worker');

const QUEUE_NAME = 'billing:usage-aggregation';
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 100;

interface AggregationJobData {
  triggeredAt: string;
}

export function createUsageAggregationQueue(redisConnection: any): Queue {
  const queue = new Queue(QUEUE_NAME, { connection: redisConnection });

  // Add repeatable job (every hour)
  queue.add(
    'aggregate',
    { triggeredAt: new Date().toISOString() },
    {
      repeat: { every: 60 * 60 * 1000 }, // 1 hour
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  );

  return queue;
}

export function createUsageAggregationWorker(redisConnection: any): Worker {
  return new Worker(
    QUEUE_NAME,
    async (job: Job<AggregationJobData>) => {
      const startTime = Date.now();
      log.info('Starting usage aggregation', {
        jobId: job.id,
        triggeredAt: job.data.triggeredAt,
      });

      const { Subscription, UsagePeriod } = await import('@agent-platform/database/models');

      // Load all active subscriptions
      const subscriptions = await Subscription.find({
        status: 'active',
      })
        .lean()
        .exec();

      let processed = 0;
      let errors = 0;

      // Process in batches
      for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
        const batch = subscriptions.slice(i, i + BATCH_SIZE);

        for (const sub of batch) {
          try {
            await aggregateForSubscription(sub as any);
            processed++;
          } catch (error: unknown) {
            errors++;
            const message = error instanceof Error ? error.message : String(error);
            log.error('Aggregation failed for subscription', {
              subscriptionId: (sub as any)._id,
              error: message,
            });
          }
        }

        // Delay between batches to avoid overwhelming ClickHouse
        if (i + BATCH_SIZE < subscriptions.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      const duration = Date.now() - startTime;
      log.info('Usage aggregation complete', {
        processed,
        errors,
        total: subscriptions.length,
        durationMs: duration,
      });

      return { processed, errors, durationMs: duration };
    },
    { connection: redisConnection, concurrency: 1 },
  );
}

async function aggregateForSubscription(subscription: ISubscription): Promise<void> {
  const { computePeriodLabel, computePeriodBounds } =
    await import('../services/billing/billing-utils.js');

  const { start, end } = computePeriodBounds(
    new Date(subscription.billingStartDate),
    subscription.billingCycle,
  );
  const periodLabel = computePeriodLabel(new Date(), subscription.billingCycle);

  // Query ClickHouse for aggregated metrics
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const { ClickHouseMetricsStore } = await import('../services/stores/clickhouse-metrics-store.js');
  const client = getClickHouseClient();
  const store = new ClickHouseMetricsStore({ type: 'clickhouse' }, { client });

  const usage = await store.getTenantUsage({
    tenantId: subscription.tenantId,
    startDate: start,
    endDate: end,
  });

  // Upsert UsagePeriod
  const { UsagePeriod } = await import('@agent-platform/database/models');

  await UsagePeriod.findOneAndUpdate(
    {
      subscriptionId: subscription._id,
      periodLabel,
    },
    {
      $set: {
        periodStart: start,
        periodEnd: end,
        totalSessions: usage.totalRequests,
        totalMessages: usage.totalRequests, // 1:1 for now
        totalTokens: usage.totalTokens,
        totalToolCalls: 0, // Not tracked in current query
        totalEstimatedCost: usage.estimatedCost,
        peakConcurrentSessions: 0, // Requires separate query
        updatedAt: new Date(),
      },
      $setOnInsert: {
        subscriptionId: subscription._id,
        periodLabel,
        tenantBreakdown: null,
        invoiced: false,
        invoiceId: null,
        _v: 1,
        createdAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
}
```

### 3.2 Files to Modify

#### `apps/runtime/src/server.ts`

Initialize the worker when the server starts:

```typescript
// Import
import {
  createUsageAggregationQueue,
  createUsageAggregationWorker,
} from './workers/usage-aggregation.worker.js';

// In the server startup section (after Redis is available):
if (process.env.USAGE_AGGREGATION_ENABLED === 'true') {
  const redisConnection = getRedisConnection(); // existing helper
  createUsageAggregationQueue(redisConnection);
  createUsageAggregationWorker(redisConnection);
  log.info('Usage aggregation worker started');
}
```

### 3.3 Exit Criteria

- [ ] Worker file created with BullMQ queue + worker
- [ ] Repeatable job scheduled every hour
- [ ] ClickHouse → UsagePeriod aggregation works
- [ ] Idempotent upsert (unique index on subscriptionId+periodLabel)
- [ ] Batch processing with configurable batch size
- [ ] Error isolation: one subscription failure doesn't block others
- [ ] Feature flag: `USAGE_AGGREGATION_ENABLED`
- [ ] `pnpm build --filter=runtime` succeeds

---

## Phase 4: Billing Events & New API Endpoints

**Goal:** Emit structured billing events via EventStore and add new billing API endpoints.

### 4.1 Files to Create

#### `packages/eventstore/src/schema/events/billing-events.ts`

**Purpose:** Define billing event schemas in the EventRegistry.

```typescript
import { eventRegistry } from '../event-registry.js';

// Register billing event types
eventRegistry.register({
  event_type: 'billing.quota.threshold',
  category: 'billing',
  description: 'Usage approaching quota limit',
  schema: {
    tenantId: 'string',
    quotaType: 'string',
    currentUsage: 'number',
    limit: 'number',
    thresholdPercent: 'number',
  },
});

eventRegistry.register({
  event_type: 'billing.quota.exceeded',
  category: 'billing',
  description: 'Usage exceeded quota limit',
  schema: {
    tenantId: 'string',
    quotaType: 'string',
    currentUsage: 'number',
    limit: 'number',
  },
});

// ... (6 more event types as specified in HLD section 2.4)
```

#### `apps/runtime/src/services/billing/billing-event-emitter.ts`

**Purpose:** Service that emits billing events via EventStore.

**Key Functions:**

```typescript
export function buildQuotaThresholdEvent(params: {
  tenantId: string;
  quotaType: 'tokens' | 'sessions';
  usage: number;
  limit: number;
  thresholdPercent: number;
}): BillingEvent;

export function buildQuotaExceededEvent(params: {
  tenantId: string;
  quotaType: 'tokens' | 'sessions';
  usage: number;
  limit: number;
}): BillingEvent;

export function buildSubscriptionStateChangeEvent(params: {
  tenantId: string;
  subscriptionId: string;
  oldStatus: string;
  newStatus: string;
}): BillingEvent;

export function determineAlertThresholds(): number[];

export async function emitBillingEvent(event: BillingEvent): Promise<void>;
```

### 4.2 New API Endpoints

#### `GET /api/tenants/:tenantId/billing/subscription`

Add to `apps/runtime/src/routes/workspace-billing.ts`:

```typescript
router.get('/subscription', requirePermission('credential:read'), async (req, res) => {
  const tenantId = verifyTenantAccess(req, res);
  if (!tenantId) return;

  const { Subscription } = await import('@agent-platform/database/models');
  const subscription = await Subscription.findOne({
    tenantId,
    status: 'active',
  })
    .lean()
    .exec();

  if (!subscription) {
    res.json({
      success: true,
      subscription: null,
      planTier: 'FREE',
    });
    return;
  }

  res.json({
    success: true,
    subscription: {
      planTier: subscription.planTier,
      billingCycle: subscription.billingCycle,
      billingStartDate: subscription.billingStartDate,
      billingEndDate: subscription.billingEndDate,
      entitlements: subscription.entitlements,
      orgLimits: subscription.orgLimits,
      tenantQuotas: subscription.tenantQuotas,
      trialEndsAt: subscription.trialEndsAt,
    },
  });
});
```

#### `GET /api/tenants/:tenantId/billing/usage-summary`

Add to `apps/runtime/src/routes/workspace-billing.ts`:

```typescript
router.get('/usage-summary', requirePermission('credential:read'), async (req, res) => {
  const tenantId = verifyTenantAccess(req, res);
  if (!tenantId) return;

  const { Subscription, UsagePeriod } = await import('@agent-platform/database/models');
  const { computePeriodLabel } = await import('../services/billing/billing-utils.js');

  const subscription = await Subscription.findOne({
    tenantId,
    status: 'active',
  })
    .lean()
    .exec();

  if (!subscription) {
    res.json({ success: true, usageSummary: null });
    return;
  }

  const periodLabel = computePeriodLabel(new Date(), (subscription as any).billingCycle);

  const usagePeriod = await UsagePeriod.findOne({
    subscriptionId: (subscription as any)._id,
    periodLabel,
  })
    .lean()
    .exec();

  res.json({
    success: true,
    usageSummary: usagePeriod || {
      totalSessions: 0,
      totalMessages: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      totalEstimatedCost: 0,
      peakConcurrentSessions: 0,
      periodLabel,
    },
  });
});
```

### 4.3 Files to Modify

#### `packages/eventstore/src/schema/events/index.ts`

Add import for billing events:

```typescript
import './billing-events.js';
```

#### `apps/runtime/src/middleware/quota-enforcement.ts`

Wire in the billing event emitter (replace the placeholder `emitThresholdEvents`):

```typescript
import {
  emitBillingEvent,
  buildQuotaThresholdEvent,
  buildQuotaExceededEvent,
} from '../services/billing/billing-event-emitter.js';
```

### 4.4 Exit Criteria

- [ ] Billing events registered in EventRegistry (8 event types)
- [ ] Billing event emitter service created
- [ ] `GET /billing/subscription` endpoint returns subscription details
- [ ] `GET /billing/usage-summary` endpoint returns pre-aggregated data
- [ ] Quota enforcement middleware emits real events
- [ ] 4 unit tests pass (UNIT-4)
- [ ] `pnpm build --filter=runtime --filter=eventstore` succeeds

---

## Phase 5: Studio Usage Dashboard

**Goal:** Build the billing & usage page in Studio.

### 5.1 Files to Create

#### `apps/studio/src/app/(workspace)/settings/billing/page.tsx`

**Purpose:** Main billing page with usage dashboard.

**Component Structure:**

```
BillingPage (server component wrapper)
└── BillingDashboard (client component)
    ├── BillingHeader — plan tier badge, billing period
    ├── UsageSummaryCards — 4 KPI cards (tokens, cost, sessions, agents)
    ├── SubscriptionCard — plan details, entitlements, quotas
    ├── CreditBalanceCard — allocated/consumed/remaining with progress bar
    ├── DailyUsageChart — area chart via recharts or similar
    ├── CostBreakdownTable — model/provider breakdown
    └── ProjectUsageTable — per-project usage table
```

#### `apps/studio/src/hooks/use-billing.ts`

**Purpose:** SWR hooks for billing data fetching.

```typescript
export function useTenantUsage(
  tenantId: string,
  params?: {
    startDate?: string;
    endDate?: string;
    projectId?: string;
  },
);

export function useBillingSubscription(tenantId: string);
export function useBillingCredits(tenantId: string);
export function useBillingDeals(tenantId: string);
export function useBillingFeatures(tenantId: string);
export function useBillingUsageSummary(tenantId: string);
```

#### `apps/studio/src/components/billing/`

Individual component files:

- `billing-header.tsx`
- `usage-summary-cards.tsx`
- `subscription-card.tsx`
- `credit-balance-card.tsx`
- `daily-usage-chart.tsx`
- `cost-breakdown-table.tsx`
- `project-usage-table.tsx`

### 5.2 Design System Notes

All components use the existing Studio design system:

- CSS variables for colors (from `globals.css`)
- `clsx` for className composition
- Framer Motion for transitions
- Lucide icons
- Tailwind utility classes

For charts, use a lightweight library (recharts is already in the ecosystem or consider a simpler SVG-based approach).

### 5.3 Navigation Integration

Add billing page link to the workspace settings navigation:

- Location: Workspace settings sidebar (alongside existing settings items)
- Route: `/settings/billing`
- Icon: `CreditCard` from Lucide
- Permission gate: Show only if user has `credential:read` permission

### 5.4 Exit Criteria

- [ ] Billing page accessible at `/settings/billing`
- [ ] Usage summary cards render with real data
- [ ] Subscription card shows plan tier and entitlements
- [ ] Credit balance card shows allocated/consumed/remaining
- [ ] Daily usage chart renders time series
- [ ] Cost breakdown table shows model/provider data
- [ ] Project usage table shows per-project metrics
- [ ] SWR hooks with proper error/loading states
- [ ] Responsive layout (mobile-friendly)
- [ ] `pnpm build --filter=studio` succeeds

---

## Wiring Checklist

Every new component must be wired into the system. This checklist prevents the "written but not connected" failure mode.

| #   | Wiring                                                              | File                                                        | Status  |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ------- |
| W1  | Quota middleware registered on tenant router                        | `apps/runtime/src/server.ts`                                | Phase 1 |
| W2  | Credit consumption called after each `.record()` in chat.ts         | `apps/runtime/src/routes/chat.ts` (3 locations)             | Phase 2 |
| W3  | Aggregation worker initialized on server start                      | `apps/runtime/src/server.ts`                                | Phase 3 |
| W4  | Billing events imported in events/index.ts                          | `packages/eventstore/src/schema/events/index.ts`            | Phase 4 |
| W5  | New subscription/usage-summary routes added to workspace-billing.ts | `apps/runtime/src/routes/workspace-billing.ts`              | Phase 4 |
| W6  | Billing page route in Studio app router                             | `apps/studio/src/app/(workspace)/settings/billing/page.tsx` | Phase 5 |
| W7  | Billing link in workspace settings sidebar                          | Studio navigation component                                 | Phase 5 |
| W8  | SWR hooks import runtime API endpoints                              | `apps/studio/src/hooks/use-billing.ts`                      | Phase 5 |

## Environment Variables

| Variable                        | Default        | Purpose                                     |
| ------------------------------- | -------------- | ------------------------------------------- |
| `QUOTA_ENFORCEMENT_ENABLED`     | `false`        | Enable/disable quota enforcement middleware |
| `USAGE_AGGREGATION_ENABLED`     | `false`        | Enable/disable usage aggregation worker     |
| `USAGE_AGGREGATION_INTERVAL_MS` | `3600000` (1h) | Aggregation job interval                    |
| `QUOTA_CACHE_TTL_SECONDS`       | `60`           | Redis TTL for quota state cache             |
| `CREDIT_CACHE_TTL_SECONDS`      | `300`          | Redis TTL for credit balance cache          |

## Risk Mitigations

| Risk                                        | Phase   | Mitigation                                                               |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| CreditLedger entries array unbounded growth | Phase 2 | One ledger per deal per billing period; entries reset at period boundary |
| Aggregation worker crashes mid-batch        | Phase 3 | BullMQ auto-retry; per-subscription error isolation                      |
| Redis cache stampede on cold start          | Phase 1 | Single-flight pattern: only one concurrent DB resolve per tenant         |
| ClickHouse query timeout during aggregation | Phase 3 | `SETTINGS max_execution_time = 15` on all CH queries                     |
| Studio build failure from new dependencies  | Phase 5 | Verify chart library compatibility before implementation                 |

## Test Execution Order

1. Phase 1: Run UNIT-1 (8 tests) → verify pure functions
2. Phase 2: Run UNIT-2 (6 tests) + UNIT-3 (5 tests)
3. Phase 3: Run INT-3 (5 tests) → verify aggregation with real MongoDB
4. Phase 4: Run UNIT-4 (4 tests) + INT-5 (3 tests)
5. Phase 5: Run INT-4 (6 tests) → verify billing routes
6. Full suite: Run all E2E tests (18 tests) after all phases complete
