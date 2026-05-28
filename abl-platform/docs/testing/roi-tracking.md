# Test Spec: ROI Tracking

**Feature**: ROI Tracking (#67)
**Owner**: Platform team
**Created**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: PLANNED

---

## Test Coverage Matrix

| Area                     | E2E    | Integration | Unit   | Status  |
| ------------------------ | ------ | ----------- | ------ | ------- |
| Cost Config CRUD         | 5      | 3           | 2      | PLANNED |
| ROI Summary API          | 4      | 3           | 3      | PLANNED |
| Cost Trend API           | 3      | 2           | 2      | PLANNED |
| Agent Breakdown API      | 3      | 2           | 1      | PLANNED |
| What-If Simulation API   | 2      | 1           | 3      | PLANNED |
| Budget Alert Events      | 3      | 2           | 2      | PLANNED |
| Tenant/Project Isolation | 5      | 0           | 0      | PLANNED |
| ROI Dashboard UI         | 3      | 0           | 2      | PLANNED |
| Cost Config Settings UI  | 2      | 0           | 1      | PLANNED |
| **Total**                | **30** | **13**      | **16** | --      |

---

## E2E Test Scenarios

All E2E tests interact only via HTTP API. No mocks, no direct DB access. Real Express servers started on random ports.

### E2E-01: Cost Config CRUD (5 tests)

**Precondition**: Authenticated user with `analytics:write` permission, valid project.

| #   | Scenario                                  | Method | Endpoint                               | Expected                             |
| --- | ----------------------------------------- | ------ | -------------------------------------- | ------------------------------------ |
| 1   | Create cost config for project            | PUT    | `/api/projects/:projectId/cost-config` | 200, config returned with all fields |
| 2   | Read cost config                          | GET    | `/api/projects/:projectId/cost-config` | 200, matches what was written        |
| 3   | Update cost config                        | PUT    | `/api/projects/:projectId/cost-config` | 200, updated fields reflected        |
| 4   | Read config for project with no config    | GET    | `/api/projects/:projectId/cost-config` | 404 or 200 with defaults             |
| 5   | Validation: negative cost values rejected | PUT    | `/api/projects/:projectId/cost-config` | 400, validation error                |

### E2E-02: ROI Summary API (4 tests)

**Precondition**: Cost config exists, LLM usage data in ClickHouse (or mock ClickHouse for E2E).

| #   | Scenario                                   | Method | Endpoint                                               | Expected                                                                         |
| --- | ------------------------------------------ | ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | Get ROI summary with valid config and data | GET    | `/api/projects/:projectId/roi/summary?from=...&to=...` | 200, contains `monthlySavings`, `roiPercentage`, `fteEquivalent`, `budgetStatus` |
| 2   | Get ROI summary with no cost config        | GET    | `/api/projects/:projectId/roi/summary`                 | 404 or 200 with zeros/defaults                                                   |
| 3   | Get ROI summary with zero containment      | GET    | `/api/projects/:projectId/roi/summary`                 | 200, savings = 0, ROI = 0                                                        |
| 4   | ROI summary response time under 500ms      | GET    | `/api/projects/:projectId/roi/summary`                 | Response < 500ms                                                                 |

### E2E-03: Cost Trend API (3 tests)

| #   | Scenario                                    | Method | Endpoint                                                                  | Expected                                      |
| --- | ------------------------------------------- | ------ | ------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Get daily cost trend for 30-day range       | GET    | `/api/projects/:projectId/roi/cost-trend?from=...&to=...&granularity=day` | 200, array of `{ date, cost, tokens, calls }` |
| 2   | Get weekly cost trend for 90-day range      | GET    | `/api/projects/:projectId/roi/cost-trend?granularity=week`                | 200, ~13 buckets                              |
| 3   | Cost trend with no data returns empty array | GET    | `/api/projects/:projectId/roi/cost-trend`                                 | 200, `{ data: [] }`                           |

### E2E-04: Agent Breakdown API (3 tests)

| #   | Scenario                             | Method | Endpoint                                                       | Expected                                                             |
| --- | ------------------------------------ | ------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Get agent cost breakdown             | GET    | `/api/projects/:projectId/roi/agent-breakdown?from=...&to=...` | 200, array of `{ agentName, conversations, totalCost, totalTokens }` |
| 2   | Breakdown sorted by cost descending  | GET    | `/api/projects/:projectId/roi/agent-breakdown`                 | First item has highest cost                                          |
| 3   | Breakdown with no data returns empty | GET    | `/api/projects/:projectId/roi/agent-breakdown`                 | 200, `{ data: [] }`                                                  |

### E2E-05: What-If Simulation API (2 tests)

| #   | Scenario                                     | Method | Endpoint                                | Expected                                               |
| --- | -------------------------------------------- | ------ | --------------------------------------- | ------------------------------------------------------ |
| 1   | Simulate increased containment               | POST   | `/api/projects/:projectId/roi/simulate` | 200, `additionalSavings > 0`, `additionalFTEFreed > 0` |
| 2   | Simulate with invalid containment rate (> 1) | POST   | `/api/projects/:projectId/roi/simulate` | 400, validation error                                  |

### E2E-06: Budget Alert Events (3 tests)

| #   | Scenario                                              | Expected                                                                           |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Budget exceeds 75% threshold                          | `roi.budget.exceeded` event emitted with `threshold: 0.75`                         |
| 2   | Budget exceeds 100% threshold                         | `roi.budget.exceeded` event emitted with `threshold: 1.00`, `budgetStatus: 'over'` |
| 3   | Duplicate alert suppressed within same billing period | No second event for same threshold                                                 |

### E2E-07: Tenant/Project Isolation (5 tests)

| #   | Scenario                                             | Expected      |
| --- | ---------------------------------------------------- | ------------- |
| 1   | Read cost config of another tenant's project         | 404 (not 403) |
| 2   | Read ROI summary of another tenant's project         | 404           |
| 3   | Update cost config of another project in same tenant | 404           |
| 4   | Unauthenticated request to cost config               | 401           |
| 5   | User without `analytics:read` permission             | 403           |

### E2E-08: ROI Dashboard UI (3 tests)

| #   | Scenario                                   | Expected                                |
| --- | ------------------------------------------ | --------------------------------------- |
| 1   | Dashboard renders KPI cards with real data | 4 KPI cards visible with numeric values |
| 2   | Dashboard shows cost trend chart           | Chart element rendered with data points |
| 3   | Dashboard shows empty state when no config | Prompt to configure cost settings       |

### E2E-09: Cost Config Settings UI (2 tests)

| #   | Scenario                                      | Expected                                      |
| --- | --------------------------------------------- | --------------------------------------------- |
| 1   | Fill and save cost config form                | Form submits, success toast, values persisted |
| 2   | Validation errors displayed for invalid input | Error messages shown inline                   |

---

## Integration Test Scenarios

Integration tests verify service boundaries and data flow between layers. Real service instances, no mocking codebase components.

### INT-01: ROICalculator with Real ProjectCostConfig (3 tests)

| #   | Scenario                                     | Expected                                                     |
| --- | -------------------------------------------- | ------------------------------------------------------------ |
| 1   | `computeSummary` with typical config         | Matches hand-calculated values (savings, FTE, ROI %)         |
| 2   | `computeSummary` with edge case: zero budget | `budgetStatus: 'at'`, `budgetRemaining: 0` when AI cost is 0 |
| 3   | `simulateContainmentChange` from 0.5 to 0.9  | `additionalSavings > 0`, `additionalFTEFreed > 0`            |

### INT-02: ClickHouse Cost Aggregation (3 tests)

| #   | Scenario                                                | Expected                                          |
| --- | ------------------------------------------------------- | ------------------------------------------------- |
| 1   | Daily cost aggregation matches sum of individual events | Aggregate total = sum of `estimated_cost` per day |
| 2   | Agent breakdown aggregation groups by `agent_name`      | Distinct agent rows with correct totals           |
| 3   | Empty time range returns empty result                   | No errors, empty arrays                           |

### INT-03: Budget Alert Evaluation (2 tests)

| #   | Scenario                                   | Expected                                                     |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| 1   | Threshold evaluator triggers at 75%        | Event emitted when `actualCost / budget >= 0.75`             |
| 2   | Threshold evaluator respects deduplication | Second call with same threshold and period produces no event |

### INT-04: Redis Cache for ROI Summary (3 tests)

| #   | Scenario                                | Expected                        |
| --- | --------------------------------------- | ------------------------------- |
| 1   | First call computes and caches          | Cache key set with 5-minute TTL |
| 2   | Second call returns cached result       | No ClickHouse query executed    |
| 3   | Cache invalidated on cost config update | Next call recomputes            |

### INT-05: Cost Config Repository (2 tests)

| #   | Scenario                       | Expected                                              |
| --- | ------------------------------ | ----------------------------------------------------- |
| 1   | Upsert creates new config      | Document created with correct `tenantId`, `projectId` |
| 2   | Upsert updates existing config | Same document updated, `updatedAt` changes            |

---

## Unit Test Scenarios

### UNIT-01: ROICalculator Formulas (3 tests)

Already exist at `packages/pipeline-engine/src/__tests__/roi-calculator.test.ts` (7 tests passing).

Additional tests:

| #   | Scenario                                               | Expected                             |
| --- | ------------------------------------------------------ | ------------------------------------ |
| 1   | Edge: `costPerAIInteraction > costPerHumanInteraction` | Negative savings (AI more expensive) |
| 2   | Edge: `containmentRate = 1.0` (100% containment)       | Maximum possible savings             |
| 3   | Edge: `totalConversationsPerMonth = 0`                 | All metrics return 0                 |

### UNIT-02: Cost Trend Bucket Aggregation (2 tests)

| #   | Scenario                        | Expected           |
| --- | ------------------------------- | ------------------ |
| 1   | Daily buckets for 7-day range   | 7 bucket entries   |
| 2   | Weekly buckets for 30-day range | 4-5 bucket entries |

### UNIT-03: Budget Threshold Logic (2 tests)

| #   | Scenario                      | Expected                |
| --- | ----------------------------- | ----------------------- |
| 1   | Cost at exactly 75% of budget | Threshold triggered     |
| 2   | Cost at 74.9% of budget       | Threshold not triggered |

### UNIT-04: Zod Validation Schemas (2 tests)

| #   | Scenario                                 | Expected                        |
| --- | ---------------------------------------- | ------------------------------- |
| 1   | Valid cost config body passes validation | `success: true`                 |
| 2   | Missing required fields rejected         | `success: false`, errors listed |

### UNIT-05: Cost Format Utilities (2 tests)

Already exist in `apps/studio/src/utils/llm-cost.ts` (`formatCost`).

Additional:

| #   | Scenario                       | Expected                              |
| --- | ------------------------------ | ------------------------------------- |
| 1   | Format large savings (> $100K) | `$123,456.00` (with comma separators) |
| 2   | Format negative savings        | `-$5,000.00`                          |

### UNIT-06: Client-Side Simulation (3 tests)

| #   | Scenario                                         | Expected                    |
| --- | ------------------------------------------------ | --------------------------- |
| 1   | Simulation with slider at current containment    | `additionalSavings = 0`     |
| 2   | Simulation with slider at 100%                   | Maximum additional savings  |
| 3   | Simulation with slider below current containment | Negative additional savings |

### UNIT-07: ROI Dashboard Components (2 tests)

| #   | Scenario                            | Expected                             |
| --- | ----------------------------------- | ------------------------------------ |
| 1   | KPI cards render with mock data     | All 4 cards display formatted values |
| 2   | Empty state rendered when no config | "Configure" CTA visible              |

### UNIT-08: Cost Config Form Validation (1 test)

| #   | Scenario                          | Expected                   |
| --- | --------------------------------- | -------------------------- |
| 1   | Form rejects containment rate > 1 | Validation error displayed |

---

## Test Infrastructure Requirements

### E2E Tests

- Real Express server on random port (`{ port: 0 }`)
- MongoDB (MongoMemoryServer or test database)
- ClickHouse test instance or in-memory ClickHouse mock (external service -- allowed to mock via DI)
- Redis test instance (or ioredis-mock for cache tests)
- Full auth middleware chain (JWT token generation for test users)
- Seed data via POST/PUT endpoints, assert via GET responses

### Integration Tests

- Real `ROICalculator` instance (no mocking)
- Real MongoDB for `ProjectCostConfig` persistence
- Real Redis for cache verification
- ClickHouse: if unavailable, use DI to inject a test adapter (allowed since ClickHouse is external infrastructure)

### Unit Tests

- Vitest with no external dependencies
- Mock only external I/O (ClickHouse client, Redis client) via DI
- No `vi.mock()` on codebase components

---

## Coverage Targets

| Layer       | Target       | Notes                                        |
| ----------- | ------------ | -------------------------------------------- |
| E2E         | 30 tests     | All API endpoints + isolation + UI basics    |
| Integration | 13 tests     | Service boundaries, data flow, caching       |
| Unit        | 16 tests     | Formulas, validation, formatting, components |
| Total       | **59 tests** |                                              |

---

## Test Execution Order

1. Unit tests first (fast feedback, no infra needed)
2. Integration tests (require MongoDB, Redis)
3. E2E tests last (require full server stack)
