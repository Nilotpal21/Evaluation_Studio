# Feature Spec: Billing & Usage

**Status:** ALPHA
**Priority:** P1
**Feature Slug:** `billing`
**Date:** 2026-03-23

---

> Retired design note (2026-04-01): the historical `UsagePeriod` rollup path described in this document is not wired in runtime and should not be used for new work. Live usage persistence now centers on `BillingReplayRun`, `BillingReplaySessionResult`, `BillingMaterializationBatch`, `BillingMaterializationSessionResult`, and `BillingMaterializationCheckpoint`. Treat any `UsagePeriod` references below as historical context only.

## 1. Problem Statement

The ABL platform has foundational billing models (Subscription, Deal, CreditLedger, UsagePeriod, BillingLineItem) and partial backend routes (workspace-billing, tenant-usage, platform-admin-usage, platform-admin-deals) but lacks a complete, production-ready billing and usage system. Key gaps include:

1. **No Studio UI for billing/usage**: Tenant admins cannot view subscription details, credit balances, usage charts, or manage plan upgrades from the Studio frontend.
2. **No runtime usage enforcement**: Token/session usage is tracked in ClickHouse but quotas defined in subscriptions and deals are never enforced at request time. A tenant on a FREE plan can consume unlimited tokens.
3. **No automated usage aggregation**: UsagePeriod documents must be populated manually; there is no periodic job that rolls up ClickHouse metrics into billing-period summaries.
4. **No Stripe integration**: The `externalBillingId` and `externalCustomerId` fields on Subscription exist but are unused. Plan upgrades and credit top-ups return placeholder responses.
5. **No overage handling**: Deals define `overagePolicy` (hard_stop, soft_cap, auto_upgrade) and `overageAlertThresholds`, but no code evaluates these during request processing.
6. **No credit consumption pipeline**: CreditLedger entries are never written automatically when LLM tokens are consumed. The credit balance endpoint aggregates from empty ledgers.
7. **No webhook/event system for billing events**: No events emitted when quotas are approached, exceeded, or when subscriptions change state.

## 2. Scope

### In Scope (MVP — Phase 1)

| Area                             | Deliverable                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Usage Dashboard (Studio)**     | Tenant-scoped page showing current billing period usage summary, daily usage chart, cost breakdown by model/provider, and project-level breakdown |
| **Subscription Info (Studio)**   | Card displaying plan tier, billing cycle, entitlements, and quota allocations                                                                     |
| **Credit Balance (Studio)**      | Card showing allocated vs. consumed credits with feature-level breakdown                                                                          |
| **Usage Aggregation Worker**     | BullMQ periodic job that rolls up ClickHouse metrics into UsagePeriod documents per subscription per billing period                               |
| **Quota Enforcement Middleware** | Request-time middleware that checks tenant token/session quotas from subscription/deal and returns 429 when exceeded                              |
| **Credit Consumption Pipeline**  | After each LLM call, write credit entries to CreditLedger based on token consumption and deal credit mappings                                     |
| **Billing Event Emitter**        | Emit structured events (via EventStore) for quota threshold warnings, quota exceeded, and subscription state changes                              |
| **API Completion**               | Fill in placeholder upgrade/topup endpoints with proper Stripe checkout session creation                                                          |

### In Scope (Phase 2 — Post-MVP)

- Invoice history page in Studio
- Billing line item detail views
- Self-service plan upgrade/downgrade flows (full Stripe integration)
- Overage policy enforcement (hard_stop vs. soft_cap vs. auto_upgrade)
- Credit rollover automation at period boundaries
- Platform admin billing dashboard in Admin app
- Usage export (CSV/PDF)

### Out of Scope

- Custom pricing engines or dynamic rate cards
- Multi-currency support
- Tax calculation or compliance (delegated to Stripe)
- Payment method management (delegated to Stripe Customer Portal)
- Revenue recognition or accounting integration

## 3. User Personas

| Persona                | Description                                                     | Key Needs                                                                         |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Tenant Admin**       | Manages a workspace (tenant). Has `credential:read` permission. | View usage, understand costs, see credit balance, get alerted on quota thresholds |
| **Organization Owner** | Owns the billing relationship (organization level).             | Manage subscription, upgrade plan, purchase credit top-ups, view invoices         |
| **Platform Admin**     | Kore.ai operator with super-admin access.                       | Manage deals, adjust quotas, view cross-tenant usage, generate billing reports    |
| **Developer**          | Builds agents on the platform.                                  | Understand per-project usage to optimize agent costs                              |

## 4. User Stories

### US-1: View Usage Dashboard

**As a** Tenant Admin, **I want to** see a usage dashboard for my workspace, **so that** I can understand token consumption, costs, and trends over the current billing period.

**Acceptance Criteria:**

- Dashboard shows: total tokens, total cost, session count, active agents for the current period
- Daily usage chart (line/area chart) with tokens and cost axes
- Cost breakdown by model/provider (table or bar chart)
- Project-level usage breakdown (table with project name, tokens, cost, sessions)
- Date range filter (default: current billing period)
- Optional project filter

### US-2: View Subscription & Plan Info

**As a** Tenant Admin, **I want to** see my current subscription plan details, **so that** I know what features and quotas are available to me.

**Acceptance Criteria:**

- Displays plan tier (FREE, TEAM, BUSINESS, ENTERPRISE)
- Shows billing cycle (monthly/annual) and period dates
- Lists enabled features (entitlements) with check/cross indicators
- Shows quota allocations (tokens, sessions, storage) with usage bars

### US-3: View Credit Balance

**As a** Tenant Admin, **I want to** see my credit balance and consumption breakdown, **so that** I can plan capacity and know when to purchase top-ups.

**Acceptance Criteria:**

- Shows total allocated vs. consumed credits
- Remaining credits with percentage indicator
- Feature-level breakdown (which features consumed how many credits)
- Visual progress bar showing consumption percentage
- Warning indicator when credits < 20% remaining

### US-4: Receive Quota Threshold Alerts

**As a** Tenant Admin, **I want to** be notified when my usage approaches quota limits, **so that** I can take action before service is degraded.

**Acceptance Criteria:**

- Alerts emitted at configurable thresholds (default: 80%, 90%, 95%, 100%)
- Alert events stored in EventStore with type `billing.quota.threshold`
- In-app notification in Studio when threshold is crossed
- Quota enforcement returns HTTP 429 with clear error message when 100% reached

### US-5: Automatic Usage Period Aggregation

**As a** Platform Operator, **I want** usage metrics to be automatically aggregated into billing periods, **so that** billing data is always up to date without manual intervention.

**Acceptance Criteria:**

- BullMQ repeatable job runs every hour
- Aggregates ClickHouse metrics into UsagePeriod documents
- Handles tenant breakdowns within subscription
- Idempotent — re-running for the same period updates rather than duplicates
- Creates new UsagePeriod at billing period boundaries

### US-6: Credit Consumption Tracking

**As a** Platform Operator, **I want** every LLM call to automatically deduct credits from the appropriate deal/ledger, **so that** credit balances are accurate in real time.

**Acceptance Criteria:**

- After each LLM call completes, a CreditEntry is appended to the CreditLedger
- Credits calculated based on token count and deal-specific credit mapping
- Feature attribution (which feature consumed credits — e.g., "llm_inference", "search_ai")
- Project and session attribution for drill-down analytics

### US-7: Quota Enforcement at Request Time

**As a** Platform Operator, **I want** runtime requests to be rejected when a tenant exceeds their quota, **so that** resource usage stays within contractual limits.

**Acceptance Criteria:**

- Middleware checks token budget and session limits from active subscription/deal
- Returns HTTP 429 with error code `QUOTA_EXCEEDED` and message indicating which quota was hit
- Caches quota state in Redis (TTL 60s) to avoid per-request DB lookups
- Bypass for platform admin requests
- Graceful degradation: if quota check fails, request proceeds (fail-open)

### US-8: Platform Admin Deal Management (Enhancement)

**As a** Platform Admin, **I want to** manage deals through the API, **so that** I can create, update, and track commercial agreements.

**Acceptance Criteria:**

- Existing platform-admin-deals routes already support CRUD operations
- Enhance with: credit ledger initialization on deal creation, auto-pause on deal expiry
- Add deal utilization summary endpoint (credits used vs. allocated across all active deals)

## 5. Technical Context

### Existing Infrastructure

| Component                  | Location                                                       | Status                                   |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Subscription model         | `packages/database/src/models/subscription.model.ts`           | Complete                                 |
| UsagePeriod model          | `packages/database/src/models/usage-period.model.ts`           | Complete                                 |
| Deal model                 | `packages/database/src/models/deal.model.ts`                   | Complete                                 |
| CreditLedger model         | `packages/database/src/models/credit-ledger.model.ts`          | Complete                                 |
| BillingLineItem model      | `packages/database/src/models/billing-line-item.model.ts`      | Complete                                 |
| Feature gate middleware    | `apps/runtime/src/middleware/feature-gate.ts`                  | Complete                                 |
| Workspace billing routes   | `apps/runtime/src/routes/workspace-billing.ts`                 | Partial (placeholder upgrade/topup)      |
| Tenant usage route         | `apps/runtime/src/routes/tenant-usage.ts`                      | Complete (reads from ClickHouse)         |
| Platform admin usage route | `apps/runtime/src/routes/platform-admin-usage.ts`              | Complete                                 |
| Platform admin deals route | `apps/runtime/src/routes/platform-admin-deals.ts`              | Complete                                 |
| ClickHouse metrics store   | `apps/runtime/src/services/stores/clickhouse-metrics-store.ts` | Complete                                 |
| LLMUsageMetric model       | `packages/database/src/models/llm-usage-metric.model.ts`       | Complete                                 |
| PLAN_FEATURES constant     | `apps/runtime/src/middleware/feature-gate.ts`                  | Complete (FREE/TEAM/BUSINESS/ENTERPRISE) |

### Route Mounting (server.ts)

- `/api/tenants/:tenantId/billing` — workspace billing (deals, credits, upgrade, topup, features)
- `/api/tenants/:tenantId/usage` — tenant usage analytics (ClickHouse-backed)
- `/api/platform/admin/usage-summary` — cross-tenant usage aggregation
- `/api/platform/admin/deals` — deal CRUD

### Data Flow

```
LLM Call → ClickHouse llm_metrics insert → (hourly aggregation) → UsagePeriod
                                         → (real-time) → CreditLedger entry
                                         → (threshold check) → EventStore event
```

### Key Decisions

| Decision                                                                  | Classification | Rationale                                                                                           |
| ------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Use ClickHouse for real-time usage queries, MongoDB for billing summaries | DECIDED        | ClickHouse handles 330M writes/day; MongoDB for control plane is the platform convention            |
| Redis cache for quota checks (60s TTL)                                    | DECIDED        | Per-request DB lookups would add 5-10ms latency; 60s staleness is acceptable for soft quotas        |
| Fail-open on quota check errors                                           | DECIDED        | Matches existing feature-gate pattern; don't block revenue-generating traffic on transient failures |
| BullMQ for periodic aggregation                                           | DECIDED        | Platform already uses BullMQ for pipeline-engine; consistent job infrastructure                     |
| Stripe for external billing                                               | INFERRED       | Fields exist for `externalBillingId`/`externalCustomerId`; Stripe is the de facto standard          |
| EventStore for billing events                                             | DECIDED        | Platform convention for structured event emission (compliance requirement #4)                       |

## 6. Non-Functional Requirements

| Requirement                 | Target                                                       |
| --------------------------- | ------------------------------------------------------------ |
| Quota check latency         | < 5ms (Redis-cached path)                                    |
| Usage dashboard load time   | < 2s for 30-day range                                        |
| Aggregation job duration    | < 30s per tenant per period                                  |
| Credit ledger write latency | < 10ms (async, non-blocking)                                 |
| Data freshness              | Usage dashboard: < 1 hour; Credit balance: < 5 minutes       |
| Availability                | Billing reads: 99.9%; Quota enforcement: fail-open on errors |

## 7. Dependencies

| Dependency                         | Type           | Notes                                                               |
| ---------------------------------- | -------------- | ------------------------------------------------------------------- |
| ClickHouse                         | Infrastructure | Required for usage metrics queries                                  |
| Redis                              | Infrastructure | Required for quota state caching                                    |
| BullMQ                             | Library        | Required for periodic aggregation jobs                              |
| EventStore (`packages/eventstore`) | Package        | Required for billing event emission                                 |
| Stripe SDK                         | External       | Required for Phase 2 checkout/payment integration (stub in Phase 1) |
| Studio design system               | Frontend       | Requires chart components (area chart, bar chart, progress bars)    |

## 8. Risks & Mitigations

| Risk                                       | Impact                                           | Likelihood | Mitigation                                                                                      |
| ------------------------------------------ | ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------- |
| ClickHouse unavailable at usage query time | Dashboard shows empty/stale data                 | Low        | Graceful 503 with "Analytics not available" message (already implemented in tenant-usage route) |
| Redis cache stale during quota check       | Tenant briefly exceeds quota                     | Medium     | 60s TTL is acceptable; hard_stop overage policy adds safety margin                              |
| Credit consumption write failure           | Credits not deducted, balance becomes inaccurate | Low        | Async retry with dead-letter queue; periodic reconciliation job                                 |
| Aggregation job runs during high load      | Increased ClickHouse query pressure              | Low        | Run during low-traffic window; configurable schedule via env var                                |
| Stripe API rate limits                     | Checkout session creation fails                  | Low        | Exponential retry; queue upgrade requests                                                       |

## 9. Success Metrics

| Metric                                | Target                                 | Measurement                             |
| ------------------------------------- | -------------------------------------- | --------------------------------------- |
| Tenant admins viewing usage dashboard | > 50% of active tenants within 30 days | Analytics event tracking                |
| Quota enforcement preventing overuse  | 0 tenants exceeding 2x quota           | Monthly audit of usage vs. quota        |
| Credit balance accuracy               | < 1% discrepancy vs. ClickHouse source | Periodic reconciliation report          |
| Usage aggregation freshness           | < 1 hour lag for 95th percentile       | Monitor UsagePeriod.updatedAt vs. now() |
