# High-Level Design: Billing & Usage

**Feature:** Billing & Usage
**Status:** PLANNED
**Date:** 2026-03-23
**Feature Spec:** `docs/features/billing.md`
**Test Spec:** `docs/testing/billing.md`

---

> Retired design note (2026-04-01): the `UsagePeriod`-based aggregation path in this document is historical and is not the active runtime direction. Current billing persistence is built around replay/materialization artifacts (`BillingReplayRun`, `BillingReplaySessionResult`, `BillingMaterializationBatch`, `BillingMaterializationSessionResult`, `BillingMaterializationCheckpoint`). Do not implement new runtime work against `UsagePeriod`.

## 1. Architecture Overview

The Billing & Usage system spans four layers of the ABL platform:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Studio (Next.js)                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Usage        │  │ Subscription │  │ Credit       │                  │
│  │ Dashboard    │  │ Info Card    │  │ Balance Card │                  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                 │                  │                          │
│         │   SWR hooks: useTenantUsage, useBillingInfo, useCredits      │
└─────────┼─────────────────┼──────────────────┼──────────────────────────┘
          │                 │                  │
          ▼                 ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Runtime API (Express)                               │
│                                                                         │
│  GET /api/tenants/:tenantId/usage ─────────► ClickHouseMetricsStore    │
│  GET /api/tenants/:tenantId/billing/* ─────► MongoDB (Subscription,    │
│                                               Deal, CreditLedger)      │
│                                                                         │
│  ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐       │
│  │ Quota            │  │ Credit         │  │ Billing Event    │       │
│  │ Enforcement      │  │ Consumption    │  │ Emitter          │       │
│  │ Middleware        │  │ Pipeline       │  │                  │       │
│  └────────┬─────────┘  └───────┬────────┘  └────────┬─────────┘       │
│           │                    │                     │                  │
│           ▼                    ▼                     ▼                  │
│       Redis Cache          MongoDB              EventStore             │
│  (quota state, 60s TTL) (CreditLedger)    (billing.* events)          │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Background Workers                                  │
│                                                                         │
│  ┌───────────────────────────┐                                          │
│  │ Usage Aggregation Worker  │  BullMQ repeatable job (every 1h)       │
│  │ ClickHouse → UsagePeriod  │  Rolls up metrics into billing periods  │
│  └───────────────────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. Component Design

### 2.1 Quota Enforcement Middleware

**Purpose:** Intercept runtime requests and reject when a tenant exceeds their token budget or session limit.

**Location:** `apps/runtime/src/middleware/quota-enforcement.ts`

**Design:**

```
Request
  │
  ├─ Extract tenantId from req.tenantContext
  │
  ├─ Check Redis cache: billing:quota:{tenantId}
  │    ├─ Cache HIT → compare usage vs. limits
  │    └─ Cache MISS → resolve from MongoDB
  │         ├─ Load Subscription (tenantId, status='active')
  │         ├─ Load active Deals (organizationId)
  │         ├─ Merge quotas (deal overrides subscription)
  │         ├─ Load current period usage from ClickHouse
  │         └─ Cache result in Redis (TTL 60s)
  │
  ├─ If usage >= budget → 429 QUOTA_EXCEEDED
  │    └─ Emit billing.quota.exceeded event
  │
  ├─ If usage >= threshold (80/90/95%) → emit warning event
  │    └─ Continue processing (don't block)
  │
  └─ If check fails → proceed (fail-open)
```

**Key Types:**

```typescript
interface QuotaState {
  tenantId: string;
  tokenBudget: number | null; // null = unlimited
  sessionLimit: number | null; // null = unlimited
  currentTokenUsage: number;
  currentSessionCount: number;
  resolvedAt: number; // timestamp for cache freshness
}

interface QuotaCheckResult {
  allowed: boolean;
  quotaType?: 'tokens' | 'sessions';
  usage?: number;
  limit?: number;
  thresholdLevel?: 'none' | 'warning' | 'high' | 'critical' | 'exceeded';
}
```

**Middleware Chain Placement:**

```
authMiddleware → tenantRateLimit → quotaEnforcement → route handler
```

The middleware is placed AFTER auth (needs tenantContext) and rate limiting (rate limits are per-request; quota is per-period). It is registered on the tenant router in `server.ts`.

### 2.2 Credit Consumption Pipeline

**Purpose:** After each LLM call, calculate credit consumption and write entries to CreditLedger.

**Location:** `apps/runtime/src/services/billing/credit-consumption.service.ts`

**Design:**

The credit consumption pipeline hooks into the existing LLM metrics recording path. When the ClickHouseMetricsStore writes a metric, it also triggers credit consumption.

```
LLM Call completes
  │
  ├─ ClickHouseMetricsStore.record(metric)  [existing]
  │
  ├─ CreditConsumptionService.recordUsage({
  │     tenantId, projectId, sessionId,
  │     feature: 'llm_inference',
  │     tokens: metric.totalTokens,
  │     model: metric.modelId
  │   })
  │
  ├─ Resolve active deal for organization
  │    └─ If no deal → return (no credit tracking)
  │
  ├─ Calculate credits: tokens × creditRate(feature, model)
  │
  ├─ Atomic write to CreditLedger:
  │    CreditLedger.findOneAndUpdate(
  │      { dealId, periodStart: currentPeriodStart },
  │      {
  │        $push: { entries: creditEntry },
  │        $inc: {
  │          totalConsumed: credits,
  │          [`featureUsage.${feature}`]: credits,
  │          sharedPoolConsumed: sharedCredits
  │        }
  │      },
  │      { upsert: true }
  │    )
  │
  └─ Check credit thresholds → emit events if crossed
```

**Key Principle:** The credit write is **async and non-blocking**. LLM response is returned to the user before credit accounting completes. Failures are logged and retried via a dead-letter pattern.

### 2.3 Usage Aggregation Worker

**Purpose:** Periodically roll up ClickHouse LLM metrics into UsagePeriod documents for billing-period summaries.

**Location:** `apps/runtime/src/workers/usage-aggregation.worker.ts`

**Design:**

```
BullMQ Repeatable Job (every 1 hour)
  │
  ├─ List all active subscriptions
  │
  ├─ For each subscription:
  │    ├─ Compute current period bounds from billingCycle + billingStartDate
  │    ├─ Query ClickHouse: aggregate metrics for tenant in period
  │    │    SELECT
  │    │      sum(total_tokens) as totalTokens,
  │    │      sum(estimated_cost) as totalEstimatedCost,
  │    │      count(DISTINCT session_id) as totalSessions,
  │    │      count(*) as totalMessages,
  │    │      sum(tool_call_count) as totalToolCalls,
  │    │      max(concurrent_sessions) as peakConcurrentSessions
  │    │    FROM llm_metrics
  │    │    WHERE tenant_id = :tenantId
  │    │      AND timestamp BETWEEN :periodStart AND :periodEnd
  │    │
  │    ├─ Build tenant breakdown (if multi-tenant subscription)
  │    │
  │    └─ Upsert UsagePeriod:
  │         UsagePeriod.findOneAndUpdate(
  │           { subscriptionId, periodLabel },
  │           { $set: aggregatedData },
  │           { upsert: true }
  │         )
  │
  └─ Log completion: { subscriptionsProcessed, duration }
```

**Idempotency:** Uses `findOneAndUpdate` with upsert, keyed on `(subscriptionId, periodLabel)` which has a unique index. Re-running overwrites with latest data.

**Scalability:** For large tenant counts, the worker processes subscriptions in batches of 50 with a 100ms delay between batches to avoid overwhelming ClickHouse.

### 2.4 Billing Event Emitter

**Purpose:** Emit structured events for billing-related state changes via the EventStore.

**Location:** `apps/runtime/src/services/billing/billing-event-emitter.ts`

**Event Schema:** New event definitions in `packages/eventstore/src/schema/events/billing-events.ts`

**Event Types:**

| Event Type                          | Trigger                             | Severity |
| ----------------------------------- | ----------------------------------- | -------- |
| `billing.quota.threshold`           | Usage crosses 80/90/95% of quota    | warning  |
| `billing.quota.exceeded`            | Usage reaches/exceeds 100% of quota | critical |
| `billing.subscription.created`      | New subscription created            | info     |
| `billing.subscription.state_change` | Status change (active→paused, etc.) | info     |
| `billing.subscription.plan_change`  | Plan tier upgrade/downgrade         | info     |
| `billing.credit.low`                | Credit balance below 20%            | warning  |
| `billing.credit.depleted`           | Credit balance reaches 0            | critical |
| `billing.credit.topup`              | Credits added to ledger             | info     |

**Event Structure:**

```typescript
interface BillingEvent {
  event_type: string;
  tenant_id: string;
  timestamp: string; // ISO 8601
  severity: 'info' | 'warning' | 'critical';
  data: {
    subscriptionId?: string;
    dealId?: string;
    quotaType?: string; // 'tokens' | 'sessions'
    currentUsage?: number;
    limit?: number;
    thresholdPercent?: number;
    oldStatus?: string;
    newStatus?: string;
    creditBalance?: number;
  };
}
```

### 2.5 Studio Usage Dashboard

**Purpose:** Provide tenant admins with a visual overview of usage, subscription, and credits.

**Location:** `apps/studio/src/app/(workspace)/settings/billing/page.tsx`

**Component Hierarchy:**

```
BillingPage
├── BillingHeader
│   └── Plan tier badge, billing period dates
├── UsageSummaryCards
│   ├── KPI: Total Tokens (with trend indicator)
│   ├── KPI: Estimated Cost
│   ├── KPI: Active Sessions
│   └── KPI: Active Agents
├── SubscriptionCard
│   ├── Plan tier + billing cycle
│   ├── Feature entitlements list (check/cross)
│   └── Quota allocation bars
├── CreditBalanceCard
│   ├── Allocated / Consumed / Remaining
│   ├── Progress bar (color-coded by threshold)
│   └── Feature breakdown table
├── UsageCharts
│   ├── DailyUsageChart (area chart: tokens over time)
│   └── CostBreakdownChart (bar chart: by model/provider)
└── ProjectUsageTable
    └── Sortable table: project, tokens, cost, sessions
```

**Data Fetching:** All data fetched via SWR hooks that call the existing Runtime API endpoints:

- `useTenantUsage()` → `GET /api/tenants/:tenantId/usage`
- `useBillingInfo()` → `GET /api/tenants/:tenantId/billing/features`
- `useBillingCredits()` → `GET /api/tenants/:tenantId/billing/credits`
- `useBillingDeals()` → `GET /api/tenants/:tenantId/billing/deals`

## 3. Data Model

### Existing Models (No Changes)

The following models are already complete and require no schema changes:

| Model           | Collection           | Purpose                                  |
| --------------- | -------------------- | ---------------------------------------- |
| Subscription    | `subscriptions`      | Plan tier, quotas, entitlements          |
| Deal            | `deals`              | Commercial agreements, credit allotments |
| CreditLedger    | `credit_ledgers`     | Credit consumption tracking              |
| UsagePeriod     | `usage_periods`      | Billing period aggregated metrics        |
| BillingLineItem | `billing_line_items` | Invoice line items                       |
| LLMUsageMetric  | `llm_usage_metrics`  | Per-call LLM usage data                  |

### New: Redis Cache Schema

```
Key:     billing:quota:{tenantId}
Value:   JSON-serialized QuotaState
TTL:     60 seconds
Purpose: Avoid per-request MongoDB+ClickHouse lookups for quota enforcement
```

```
Key:     billing:credit:{dealId}:{periodLabel}
Value:   JSON { totalConsumed, featureUsage, lastUpdated }
TTL:     300 seconds (5 minutes)
Purpose: Fast credit balance checks for threshold detection
```

### New: EventStore Event Definitions

New file: `packages/eventstore/src/schema/events/billing-events.ts`

Registers 8 event types under the `billing` category in the EventRegistry. Events are written to the ClickHouse `events` table with standard platform event schema.

## 4. API Design

### Existing Endpoints (No Changes)

| Method | Path                                      | Handler                 | Notes                             |
| ------ | ----------------------------------------- | ----------------------- | --------------------------------- |
| GET    | `/api/tenants/:tenantId/usage`            | tenant-usage.ts         | ClickHouse-backed usage analytics |
| GET    | `/api/tenants/:tenantId/billing/deals`    | workspace-billing.ts    | Active deals list                 |
| GET    | `/api/tenants/:tenantId/billing/credits`  | workspace-billing.ts    | Credit balance                    |
| GET    | `/api/tenants/:tenantId/billing/features` | workspace-billing.ts    | Feature resolution                |
| GET    | `/api/platform/admin/usage-summary`       | platform-admin-usage.ts | Cross-tenant usage                |
| \*     | `/api/platform/admin/deals/*`             | platform-admin-deals.ts | Deal CRUD                         |

### Modified Endpoints

| Method | Path                                           | Change                                                                            |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| POST   | `/api/tenants/:tenantId/billing/upgrade`       | Replace placeholder with Stripe checkout session creation (Phase 2, stub for now) |
| POST   | `/api/tenants/:tenantId/billing/credits/topup` | Replace placeholder with Stripe checkout session creation (Phase 2, stub for now) |

### New Endpoints

| Method | Path                                           | Purpose                                                       |
| ------ | ---------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/api/tenants/:tenantId/billing/subscription`  | Return full subscription details (plan, cycle, dates, quotas) |
| GET    | `/api/tenants/:tenantId/billing/usage-summary` | Return pre-aggregated UsagePeriod data for current period     |

## 5. Twelve Architectural Concerns

### 5.1 Tenant Isolation

- Every billing query includes `tenantId` in the filter
- Cross-tenant access returns 404 (existing pattern in workspace-billing.ts)
- Redis cache keys are tenant-scoped: `billing:quota:{tenantId}`
- Credit ledgers are scoped to `dealId` + `organizationId`, and deals are organization-scoped
- The `verifyTenantAccess()` helper in workspace-billing.ts handles the tenant match check

### 5.2 Authentication & Authorization

- All billing routes sit behind `authMiddleware` + `requirePermission('credential:read')`
- Platform admin routes additionally require `requirePlatformAdmin()` + `requirePlatformAdminIp()`
- Quota enforcement middleware runs after auth (needs tenantContext)
- No new permissions introduced; `credential:read` reused for billing visibility

### 5.3 Data Consistency

- Credit consumption uses atomic `$push` + `$inc` on CreditLedger (no read-modify-write race)
- UsagePeriod upserts use the unique index `(subscriptionId, periodLabel)` for idempotency
- Redis cache has explicit TTL (60s for quotas, 300s for credits); stale data is bounded
- No eventual consistency across ClickHouse → MongoDB; aggregation worker is the sync mechanism

### 5.4 Observability

- Each component uses `createLogger('billing-*')` with structured context
- Quota enforcement logs: tenantId, quotaType, usage, limit, decision (allowed/denied)
- Credit consumption logs: dealId, credits, feature, projectId
- Aggregation worker logs: subscriptionsProcessed, duration, errors
- All billing events flow through EventStore → ClickHouse `events` table → queryable via Observatory

### 5.5 Performance

| Path                   | Target       | Strategy                                        |
| ---------------------- | ------------ | ----------------------------------------------- |
| Quota check (hot path) | < 5ms        | Redis cache, fail-open                          |
| Credit write           | < 10ms       | Async, non-blocking                             |
| Usage dashboard        | < 2s         | ClickHouse columnar queries, parallel execution |
| Aggregation worker     | < 30s/tenant | Batched processing, configurable concurrency    |

### 5.6 Scalability

- Quota state cached in Redis (shared across runtime pods)
- Credit writes are append-only (CreditLedger entries array grows monotonically within a period)
- UsagePeriod documents are bounded (one per subscription per billing period)
- BillingLineItem documents are bounded (one per deal per period per category)
- Aggregation worker can be horizontally scaled by partitioning subscriptions

### 5.7 Security

- No PII in billing data (token counts and costs are not personal)
- Credit ledger entries include sessionId for traceability but no user content
- Stripe API keys (Phase 2) will be stored as encrypted credentials via `LLMCredential` or `ToolSecret` pattern
- Audit logs written for subscription state changes and deal modifications

### 5.8 Error Handling

- Quota enforcement: fail-open on any error (matches feature-gate pattern)
- Credit consumption: async with retry; failures logged, not surfaced to user
- Aggregation worker: per-subscription try/catch; one failure doesn't block others
- API routes: standard `{ success: false, error: { code, message } }` envelope

### 5.9 Testing Strategy

See `docs/testing/billing.md` for full test spec. Key strategy:

- E2E tests use real Express servers with full middleware chain
- Integration tests verify MongoDB/Redis/ClickHouse interactions
- Unit tests cover pure calculation functions
- No mocking of codebase components in E2E/integration tests

### 5.10 Migration & Rollout

No database migrations required — all models already exist. Rollout strategy:

1. **Phase 1a:** Deploy quota enforcement middleware with `QUOTA_ENFORCEMENT_ENABLED=false` (feature flag)
2. **Phase 1b:** Deploy credit consumption pipeline (write-only, no enforcement)
3. **Phase 1c:** Deploy aggregation worker
4. **Phase 1d:** Deploy Studio UI
5. **Phase 1e:** Enable quota enforcement (`QUOTA_ENFORCEMENT_ENABLED=true`)

Feature flag allows gradual rollout and quick rollback.

### 5.11 Compliance

- Right to erasure: billing data is org-level, not user-level. Erasure cascades from org deletion.
- Data minimization: UsagePeriod stores aggregates, not individual records
- Audit logging: subscription changes logged via existing `writeAuditLog()` pattern
- Data retention: UsagePeriod and CreditLedger entries follow the org's data retention policy

### 5.12 Dependencies & Failure Modes

| Dependency   | Failure Mode      | Impact                                                          | Mitigation                                                             |
| ------------ | ----------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Redis        | Unavailable       | Quota check falls back to DB; higher latency                    | Fail-open; log warning                                                 |
| ClickHouse   | Unavailable       | Usage dashboard returns 503; quota check uses cached/stale data | Graceful error in UI; Redis cache provides short-term buffer           |
| MongoDB      | Unavailable       | All billing reads/writes fail                                   | Standard MongoDB retry/failover; health check endpoint                 |
| BullMQ/Redis | Worker queue down | Aggregation stops; UsagePeriod stale                            | BullMQ auto-recovery on reconnect; manual trigger endpoint             |
| EventStore   | Event write fails | Billing events lost                                             | Fire-and-forget by design; events are informational, not transactional |

## 6. Alternatives Considered

### Alternative 1: Real-time quota enforcement via ClickHouse

**Rejected.** Querying ClickHouse on every request adds 50-100ms latency. The Redis cache approach adds < 5ms with acceptable staleness (60s).

### Alternative 2: Event-sourced billing

**Rejected.** Full event sourcing for credit consumption would require CQRS projections and add significant complexity. The current append-only CreditLedger with atomic `$inc` provides sufficient consistency without the overhead.

### Alternative 3: Dedicated billing microservice

**Deferred.** For Phase 1, billing logic lives in the runtime service alongside the existing routes. If billing complexity grows significantly (e.g., multi-currency, dynamic pricing), extraction to a dedicated service is recommended. The service layer separation (service files, not inline route logic) makes future extraction straightforward.

### Alternative 4: Webhook-based usage reporting to Stripe

**Phase 2.** Using Stripe metered billing with usage records would delegate aggregation and invoicing to Stripe. This is the right long-term approach but requires Stripe Connect setup and more integration work than Phase 1 scope allows.

## 7. Open Questions

| #   | Question                                                                   | Status                                                                                                      | Owner |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Should quota enforcement be per-project or only per-tenant?                | DECIDED: Per-tenant in Phase 1, per-project in Phase 2                                                      | —     |
| 2   | What credit rate applies to different LLM models?                          | DECIDED: Configurable per-deal creditAllotment.featureCredits; default 1 credit = 1K tokens                 | —     |
| 3   | Should aggregation worker run in the runtime process or a separate worker? | DECIDED: Same process for Phase 1 (simple); separate worker container for production scale                  | —     |
| 4   | Is `credential:read` the right permission for billing visibility?          | INFERRED: Reusing existing permission avoids RBAC migration. Dedicated `billing:read` permission in Phase 2 | —     |
