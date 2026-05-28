# Test Spec: Billing & Usage

**Feature:** Billing & Usage
**Status:** PLANNED
**Date:** 2026-03-23
**Feature Spec:** `docs/features/billing.md`

---

> Retired design note (2026-04-01): test plans in this document that assume `UsagePeriod` rollups are historical. Current billing validation should target replay/materialization artifacts and aggregate materialization batches instead of `UsagePeriod`.

## 1. Test Coverage Matrix

| Component                    | Unit    | Integration | E2E     | Status  |
| ---------------------------- | ------- | ----------- | ------- | ------- |
| Quota enforcement middleware | 8 tests | 4 tests     | 3 tests | PLANNED |
| Credit consumption pipeline  | 6 tests | 3 tests     | 2 tests | PLANNED |
| Usage aggregation worker     | 5 tests | 3 tests     | 2 tests | PLANNED |
| Billing event emitter        | 4 tests | 2 tests     | 2 tests | PLANNED |
| Workspace billing routes     | —       | 6 tests     | 4 tests | PLANNED |
| Tenant usage route           | —       | 3 tests     | 2 tests | PLANNED |
| Studio usage dashboard       | —       | —           | 3 tests | PLANNED |
| **Total**                    | **23**  | **21**      | **18**  | —       |

## 2. E2E Test Scenarios

All E2E tests interact via HTTP API. No mocking of codebase components. Real Express servers started on random ports with full middleware chain.

### E2E-1: Usage Dashboard Data Retrieval

**User Story:** US-1 (View Usage Dashboard)
**File:** `apps/runtime/src/__tests__/e2e/billing-usage-dashboard.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Create test tenant with active subscription
- Seed ClickHouse with LLM usage metrics for the tenant across 7 days, 2 projects, 3 models
- Authenticate as tenant admin

**Test Cases:**

| #   | Test                                                     | Expected                                                                                                           |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `GET /api/tenants/:tenantId/usage` with no filters       | Returns summary with total tokens, cost, sessions; daily breakdown for 30 days; model breakdown; project breakdown |
| 2   | `GET /api/tenants/:tenantId/usage?projectId=X`           | Returns usage filtered to single project                                                                           |
| 3   | `GET /api/tenants/:tenantId/usage?startDate=X&endDate=Y` | Returns usage for custom date range only                                                                           |
| 4   | `GET /api/tenants/:tenantId/usage` with wrong tenantId   | Returns 404 (tenant isolation)                                                                                     |
| 5   | `GET /api/tenants/:tenantId/usage` without auth          | Returns 401                                                                                                        |

### E2E-2: Subscription and Feature Resolution

**User Story:** US-2 (View Subscription & Plan Info)
**File:** `apps/runtime/src/__tests__/e2e/billing-subscription-features.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Create test tenant with BUSINESS subscription
- Create a second tenant with FREE subscription

**Test Cases:**

| #   | Test                                                              | Expected                                                                                                    |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/tenants/:tenantId/billing/features` for BUSINESS tenant | Returns `{ planTier: 'BUSINESS', features: { advanced_analytics: true, sso: true, kms_byok: false, ... } }` |
| 2   | `GET /api/tenants/:tenantId/billing/features` for FREE tenant     | Returns only `guardrails: true`, all others false                                                           |
| 3   | `GET /api/tenants/:tenantId/billing/features` cross-tenant        | Returns 404                                                                                                 |
| 4   | Feature resolution with deal override                             | Create deal with `features: ['kms_byok']` for FREE tenant; verify kms_byok now resolves to true             |

### E2E-3: Credit Balance Lifecycle

**User Story:** US-3 (View Credit Balance) + US-6 (Credit Consumption)
**File:** `apps/runtime/src/__tests__/e2e/billing-credit-lifecycle.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Create test tenant + organization
- Create active deal with creditAllotment: { totalCredits: 1000, sharedPoolCredits: 500, featureCredits: { llm_inference: 300, search_ai: 200 } }
- Initialize CreditLedger for the deal

**Test Cases:**

| #   | Test                                                             | Expected                                                 |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `GET /api/tenants/:tenantId/billing/credits` with no consumption | Returns allocated=1000, consumed=0, remaining=1000       |
| 2   | Consume credits via LLM calls, then `GET credits`                | Returns accurate consumed count, remaining decreased     |
| 3   | `GET credits` with feature breakdown                             | Returns per-feature consumption matching the seeded data |
| 4   | `GET credits` cross-tenant                                       | Returns 404                                              |

### E2E-4: Quota Enforcement End-to-End

**User Story:** US-7 (Quota Enforcement)
**File:** `apps/runtime/src/__tests__/e2e/billing-quota-enforcement.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Create test tenant with subscription having `orgLimits: { tokenBudget: 100 }`
- Seed usage data approaching the limit

**Test Cases:**

| #   | Test                                                     | Expected                                     |
| --- | -------------------------------------------------------- | -------------------------------------------- |
| 1   | Request when usage is below quota                        | Request succeeds (200)                       |
| 2   | Request when usage exactly at quota                      | Returns 429 with `QUOTA_EXCEEDED` error code |
| 3   | Request when Redis cache is unavailable                  | Request proceeds (fail-open behavior)        |
| 4   | Platform admin request when quota exceeded               | Request succeeds (admin bypass)              |
| 5   | Quota check for different quota types (tokens, sessions) | Each quota type enforced independently       |

### E2E-5: Billing Deals API

**User Story:** US-8 (Platform Admin Deal Management)
**File:** `apps/runtime/src/__tests__/e2e/billing-deals-api.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Authenticate as platform admin

**Test Cases:**

| #   | Test                                                    | Expected                                               |
| --- | ------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `GET /api/tenants/:tenantId/billing/deals`              | Returns active deals for tenant's organization         |
| 2   | Non-admin user accessing billing deals                  | Returns 403 or appropriate error                       |
| 3   | Deals with credit allotment reflected in credit balance | After creating deal, credit balance reflects allotment |

### E2E-6: Billing Event Emission

**User Story:** US-4 (Quota Threshold Alerts)
**File:** `apps/runtime/src/__tests__/e2e/billing-events.e2e.test.ts`

**Setup:**

- Start runtime server on random port
- Create test tenant with subscription + quotas
- Set up event listener/subscriber

**Test Cases:**

| #   | Test                         | Expected                                                         |
| --- | ---------------------------- | ---------------------------------------------------------------- |
| 1   | Usage crosses 80% threshold  | Event emitted with type `billing.quota.threshold`, level=warning |
| 2   | Usage crosses 100% threshold | Event emitted with type `billing.quota.exceeded`, level=critical |
| 3   | Subscription status changes  | Event emitted with type `billing.subscription.state_change`      |

## 3. Integration Test Scenarios

Integration tests test real service boundaries. No mocking of codebase components. External services (ClickHouse, Redis) use real connections where feasible or containerized test instances.

### INT-1: Quota Enforcement Middleware

**File:** `apps/runtime/src/__tests__/integration/quota-enforcement.integration.test.ts`

| #   | Test                                              | Description                                                           |
| --- | ------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Middleware resolves quota from Subscription model | Query MongoDB for subscription, extract orgLimits, compare with usage |
| 2   | Middleware resolves quota from Deal model         | When deal provides limits, uses deal limits over subscription         |
| 3   | Redis cache hit path                              | After first check, subsequent checks read from Redis cache            |
| 4   | Redis cache miss path                             | When Redis key expired, re-fetches from MongoDB                       |
| 5   | Multi-quota type enforcement                      | Token budget and session limit checked independently                  |
| 6   | Hierarchical quota resolution                     | Tenant quota overrides org quota; project quota overrides tenant      |

### INT-2: Credit Consumption Pipeline

**File:** `apps/runtime/src/__tests__/integration/credit-consumption.integration.test.ts`

| #   | Test                                           | Description                                                    |
| --- | ---------------------------------------------- | -------------------------------------------------------------- |
| 1   | Credit entry created after LLM metric recorded | Verify CreditLedger.entries grows after metric insert          |
| 2   | Feature attribution correct                    | Credits tagged to correct feature (llm_inference, search_ai)   |
| 3   | Project attribution correct                    | Credits tagged to correct projectId                            |
| 4   | No deal found — no credit entry                | When tenant has no active deal, no CreditLedger entry created  |
| 5   | Concurrent credit writes                       | Multiple simultaneous writes don't lose entries (atomic $push) |

### INT-3: Usage Aggregation Worker

**File:** `apps/runtime/src/__tests__/integration/usage-aggregation.integration.test.ts`

| #   | Test                                           | Description                                                      |
| --- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Aggregates ClickHouse metrics into UsagePeriod | After running worker, UsagePeriod has correct totals             |
| 2   | Idempotent re-aggregation                      | Running twice for same period updates rather than duplicates     |
| 3   | New period boundary handling                   | When billing period rolls over, creates new UsagePeriod          |
| 4   | Tenant breakdown populated                     | tenantBreakdown field contains per-tenant sub-totals             |
| 5   | Empty period handling                          | When no metrics exist for period, creates UsagePeriod with zeros |

### INT-4: Workspace Billing Routes

**File:** `apps/runtime/src/__tests__/integration/workspace-billing.integration.test.ts`

| #   | Test                                      | Description                                                    |
| --- | ----------------------------------------- | -------------------------------------------------------------- |
| 1   | GET /deals returns correct deal data      | Deals filtered by organizationId and status=active             |
| 2   | GET /credits returns accurate totals      | Credits computed from deal allotments and ledger consumption   |
| 3   | GET /features returns correct feature set | Features resolved from deal features + PLAN_FEATURES[planTier] |
| 4   | POST /upgrade validates targetPlan        | Invalid plan returns 400                                       |
| 5   | POST /credits/topup validates request     | Missing amount handled gracefully                              |
| 6   | Tenant isolation enforced                 | Cross-tenant requests return 404                               |

### INT-5: Billing Event Emission

**File:** `apps/runtime/src/__tests__/integration/billing-events.integration.test.ts`

| #   | Test                            | Description                                                   |
| --- | ------------------------------- | ------------------------------------------------------------- |
| 1   | Threshold event emitted at 80%  | EventStore receives quota threshold event                     |
| 2   | Threshold event emitted at 100% | EventStore receives quota exceeded event                      |
| 3   | Subscription state change event | EventStore receives state change event on subscription update |

## 4. Unit Test Scenarios

### UNIT-1: Quota Enforcement Logic

**File:** `apps/runtime/src/__tests__/unit/quota-enforcement.test.ts`

| #   | Test                                                        | Description                                                        |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | `isQuotaExceeded` returns true when usage > budget          | Pure function test                                                 |
| 2   | `isQuotaExceeded` returns false when usage < budget         | Pure function test                                                 |
| 3   | `isQuotaExceeded` handles null/undefined budget (unlimited) | Returns false                                                      |
| 4   | `resolveEffectiveQuota` merges subscription + deal quotas   | Deal overrides subscription                                        |
| 5   | `resolveEffectiveQuota` with no deal                        | Falls back to subscription limits                                  |
| 6   | `buildRedisQuotaKey` format                                 | Returns `billing:quota:{tenantId}`                                 |
| 7   | `parseQuotaFromCache` handles corrupted Redis data          | Returns null, logs warning                                         |
| 8   | `getThresholdLevel` classifies usage percentage             | 0-79=none, 80-89=warning, 90-94=high, 95-99=critical, 100=exceeded |

### UNIT-2: Credit Calculation

**File:** `apps/runtime/src/__tests__/unit/credit-calculation.test.ts`

| #   | Test                                                      | Description                                     |
| --- | --------------------------------------------------------- | ----------------------------------------------- |
| 1   | `calculateCreditsForTokens` with standard rate            | 1000 tokens at 0.01 credits/token = 10 credits  |
| 2   | `calculateCreditsForTokens` with feature-specific rate    | Different rates for llm_inference vs. search_ai |
| 3   | `calculateCreditsForTokens` with zero tokens              | Returns 0 credits                               |
| 4   | `buildCreditEntry` creates valid entry structure          | All required fields populated                   |
| 5   | `selectDealForCredits` picks active deal for organization | Active deal selected over expired/paused        |
| 6   | `selectDealForCredits` with no active deal                | Returns null                                    |

### UNIT-3: Usage Period Calculation

**File:** `apps/runtime/src/__tests__/unit/usage-period-calculation.test.ts`

| #   | Test                                             | Description                     |
| --- | ------------------------------------------------ | ------------------------------- |
| 1   | `computePeriodLabel` for monthly billing         | Returns 'YYYY-MM' format        |
| 2   | `computePeriodLabel` for annual billing          | Returns 'YYYY' format           |
| 3   | `computePeriodBounds` for monthly cycle          | Returns first/last day of month |
| 4   | `computePeriodBounds` for custom start date      | Returns start + 30 days         |
| 5   | `mergeUsageTotals` accumulates metrics correctly | Sums tokens, sessions, cost     |

### UNIT-4: Billing Event Construction

**File:** `apps/runtime/src/__tests__/unit/billing-events.test.ts`

| #   | Test                                                       | Description                                |
| --- | ---------------------------------------------------------- | ------------------------------------------ |
| 1   | `buildQuotaThresholdEvent` creates valid event             | Type, level, tenantId, threshold populated |
| 2   | `buildQuotaExceededEvent` creates critical event           | Level=critical, includes quota details     |
| 3   | `buildSubscriptionStateChangeEvent` captures old/new state | Before/after status included               |
| 4   | `determineAlertThresholds` returns correct thresholds      | Default: [80, 90, 95, 100]                 |

## 5. Security Test Scenarios

| #     | Test                                     | Location     | Description                            |
| ----- | ---------------------------------------- | ------------ | -------------------------------------- |
| SEC-1 | Tenant isolation on billing routes       | E2E-2, E2E-3 | Cross-tenant access returns 404        |
| SEC-2 | Auth required for all billing endpoints  | E2E-1, E2E-2 | Unauthenticated returns 401            |
| SEC-3 | Platform admin routes require admin role | E2E-5        | Non-admin returns 403                  |
| SEC-4 | Quota bypass requires platform admin     | E2E-4        | Regular user cannot bypass quota       |
| SEC-5 | Credit ledger not modifiable by tenant   | INT-4        | No POST/PUT/DELETE on credit endpoints |

## 6. Performance Test Scenarios

| #      | Test                             | Target       | Description                                            |
| ------ | -------------------------------- | ------------ | ------------------------------------------------------ |
| PERF-1 | Quota check with Redis cache hit | < 5ms        | Measure middleware latency with warm cache             |
| PERF-2 | Usage dashboard query (30 days)  | < 2s         | ClickHouse query with 1M records for tenant            |
| PERF-3 | Credit balance computation       | < 500ms      | Aggregate across 10 deals, 12 ledger periods           |
| PERF-4 | Aggregation worker throughput    | < 30s/tenant | Full period aggregation from ClickHouse to UsagePeriod |

## 7. Test Infrastructure Requirements

| Requirement         | Details                                                        |
| ------------------- | -------------------------------------------------------------- |
| MongoDB             | Required for subscription, deal, credit ledger models          |
| ClickHouse          | Required for usage metrics queries (test container or mock)    |
| Redis               | Required for quota caching tests                               |
| BullMQ              | Required for aggregation worker tests                          |
| Express test server | Random port binding with full middleware chain                 |
| Test data factories | Factories for Subscription, Deal, CreditLedger, LLMUsageMetric |

## 8. Test Data Factories

```typescript
// Planned factory functions (to be implemented)

createTestSubscription({
  tenantId: string,
  planTier: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE',
  orgLimits?: { tokenBudget?: number, sessionLimit?: number },
}): Promise<ISubscription>

createTestDeal({
  organizationId: string,
  creditAllotment: { totalCredits: number, featureCredits?: Record<string, number> },
  overagePolicy?: 'hard_stop' | 'soft_cap' | 'auto_upgrade',
}): Promise<IDeal>

createTestCreditLedger({
  dealId: string,
  organizationId: string,
  totalConsumed?: number,
  featureUsage?: Record<string, number>,
}): Promise<ICreditLedger>

seedClickHouseMetrics({
  tenantId: string,
  projectId?: string,
  days: number,
  metricsPerDay: number,
}): Promise<void>
```

## 9. Iteration Log

_No iterations yet. Feature is in PLANNED status._
