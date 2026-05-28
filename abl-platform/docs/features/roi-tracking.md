# Feature Spec: ROI Tracking

**Feature ID**: #67
**Status**: PLANNED
**Owner**: Platform team
**Created**: 2026-03-23
**Last updated**: 2026-03-23

---

## 1. Problem Statement

Enterprise customers deploying AI agents need quantifiable evidence that the investment is delivering value. Today, the platform captures raw LLM cost data (`llm.call.completed` events with `estimated_cost`, token counts) and the `ROICalculator` service in `pipeline-engine` can compute savings/FTE equivalents from static config inputs, but there is no end-to-end flow that:

1. Connects real-time operational cost data (per-session, per-agent, per-model) to business outcome metrics (containment, escalation, resolution).
2. Allows project owners to configure their cost assumptions (human interaction cost, FTE capacity, monthly budget) via UI.
3. Presents a unified ROI dashboard showing savings, cost trends, budget burn, and what-if simulations.
4. Emits ROI-related platform events for alerting and downstream consumption.

Without this, customers must manually export data and build spreadsheets to justify AI agent spend -- a process that is error-prone, delayed, and not scalable.

---

## 2. Scope

### In Scope

- **Cost Configuration API**: CRUD endpoints for per-project cost configuration (`ProjectCostConfig`), exposing the existing Mongoose model.
- **ROI Summary API**: New endpoint that combines real-time LLM cost data from ClickHouse with static cost config to compute ROI metrics (savings, FTE equivalent, ROI %, budget status).
- **Cost Trend API**: Time-series endpoint returning daily/weekly/monthly cost aggregations with breakdown by agent and model.
- **What-If Simulation API**: Endpoint that accepts hypothetical containment rates and returns projected savings (wraps existing `ROICalculator.simulateContainmentChange`).
- **ROI Dashboard UI**: Studio page with KPI cards (monthly savings, ROI %, FTE freed, budget status), cost trend chart, agent cost breakdown table, and containment-to-savings simulation slider.
- **Cost Configuration UI**: Settings panel where project owners configure cost assumptions (cost per human interaction, cost per AI interaction, FTE capacity, monthly budget, containment rate).
- **ROI Platform Events**: New event types (`roi.summary.computed`, `roi.budget.exceeded`) for alerting integration.
- **Budget Alert Integration**: Threshold-based alerts when budget utilization exceeds configurable percentages (75%, 90%, 100%).

### Out of Scope

- Predictive cost forecasting (ML-based) -- deferred to Tier 6 analytics.
- Cross-tenant cost comparison or benchmarking.
- Invoice generation or billing integration.
- Custom cost models beyond the containment-based formula.
- Voice channel cost attribution (separate feature).

---

## 3. Requirements

### Functional Requirements

| ID    | Requirement                                                                                        | Priority |
| ----- | -------------------------------------------------------------------------------------------------- | -------- |
| FR-01 | Project owners can create/update/read cost configuration for their project                         | P0       |
| FR-02 | Cost config is scoped to tenant + project with unique constraint                                   | P0       |
| FR-03 | ROI summary endpoint returns savings, annual savings, FTE equivalent, ROI %, budget status         | P0       |
| FR-04 | ROI summary combines real ClickHouse LLM cost data with static config inputs                       | P0       |
| FR-05 | Cost trend endpoint returns time-series data groupable by day/week/month                           | P0       |
| FR-06 | Cost trend supports breakdown by agent name and model                                              | P1       |
| FR-07 | What-if simulation accepts new containment rate and returns projected savings delta                | P1       |
| FR-08 | Studio ROI dashboard displays KPI cards: monthly savings, ROI %, FTE freed, budget remaining       | P0       |
| FR-09 | Studio ROI dashboard displays cost trend chart with configurable time range                        | P0       |
| FR-10 | Studio ROI dashboard displays agent cost breakdown table                                           | P1       |
| FR-11 | Studio cost configuration panel accessible from project settings                                   | P0       |
| FR-12 | Budget exceeded event emitted when actual AI cost crosses configured thresholds                    | P1       |
| FR-13 | ROI summary computation cached in Redis with 5-minute TTL                                          | P1       |
| FR-14 | All endpoints enforce tenant and project isolation                                                 | P0       |
| FR-15 | Simulation slider in UI updates projected savings in real-time without API call (client-side calc) | P1       |

### Non-Functional Requirements

| ID     | Requirement                                         | Target            |
| ------ | --------------------------------------------------- | ----------------- |
| NFR-01 | ROI summary API response time                       | < 500ms (P95)     |
| NFR-02 | Cost trend API response time for 90-day range       | < 1s (P95)        |
| NFR-03 | Dashboard initial load time                         | < 2s              |
| NFR-04 | Cost config CRUD response time                      | < 200ms           |
| NFR-05 | Redis cache hit ratio for ROI summary               | > 80%             |
| NFR-06 | Zero data leakage across tenants/projects           | 100%              |
| NFR-07 | Graceful degradation when ClickHouse is unavailable | Show cached/empty |

---

## 4. User Stories

### US-01: Configure Cost Assumptions

**As a** project owner,
**I want to** enter my organization's cost per human interaction, AI interaction cost, FTE capacity, and monthly budget,
**So that** the platform can compute meaningful ROI metrics specific to my business.

**Acceptance Criteria:**

- Form validates all numeric inputs (positive numbers, containment rate 0-1).
- Saving persists to MongoDB with tenant + project isolation.
- Default values pre-populated for new projects (industry averages).
- Changes take effect immediately on the ROI dashboard.

### US-02: View ROI Dashboard

**As a** project owner,
**I want to** see a dashboard showing monthly savings, ROI percentage, FTE equivalents freed, and budget status,
**So that** I can quickly assess the business value of my AI agents.

**Acceptance Criteria:**

- Four KPI cards at the top: Monthly Savings ($), ROI (%), FTEs Freed, Budget Status.
- Cost trend chart showing daily cost over the selected time range.
- Agent cost breakdown table showing per-agent cost, conversations, and containment rate.
- Time range selector (7d, 30d, 90d, custom).
- Data refreshes every 30 seconds via SWR.

### US-03: Run What-If Simulation

**As a** project owner,
**I want to** adjust a containment rate slider and see how projected savings would change,
**So that** I can build a business case for improving agent performance.

**Acceptance Criteria:**

- Slider ranges from current containment rate to 100%.
- Displays: current savings, simulated savings, additional savings delta, additional FTEs freed.
- Computation is client-side using the same formula as `ROICalculator`.
- No API call needed for slider interaction (instant feedback).

### US-04: Receive Budget Alerts

**As a** project owner,
**I want to** be notified when my AI spending approaches or exceeds my monthly budget,
**So that** I can take corrective action before costs spiral.

**Acceptance Criteria:**

- Configurable threshold percentages (default: 75%, 90%, 100%).
- Alert emitted as `roi.budget.exceeded` platform event.
- Budget status reflected on dashboard KPI card (green/yellow/red).
- Alert only fires once per threshold per billing period (deduplication).

### US-05: View Cost Breakdown by Agent

**As a** project owner,
**I want to** see which agents are consuming the most LLM tokens and cost,
**So that** I can optimize the most expensive agents first.

**Acceptance Criteria:**

- Table sorted by total cost descending.
- Columns: Agent Name, Conversations, Total Tokens, Total Cost, Avg Cost/Conversation, Containment Rate.
- Clicking an agent name navigates to agent-specific analytics.
- Exportable as CSV.

---

## 5. Data Model

### Existing: `ProjectCostConfig` (MongoDB)

Already exists at `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts`:

- `tenantId`, `projectId` (unique compound index)
- `costPerHumanInteraction`, `costPerAIInteraction`
- `fteCapacityPerDay`, `fteCostPerYear`
- `monthlyBudget`, `containmentRate`, `totalConversationsPerMonth`
- `createdBy`, `createdAt`, `updatedAt`

### Existing: `ROICalculator` (Service)

Already exists at `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts`:

- `computeSavings()`, `computeFTEEquivalent()`, `computeROI()`
- `computeBudgetStatus()`, `computeSummary()`, `simulateContainmentChange()`

### Existing: LLM Cost Data (ClickHouse)

`llm.call.completed` events contain `estimated_cost`, `input_tokens`, `output_tokens`, `model`, `provider`.

### New: Budget Alert Config (extend ProjectCostConfig)

Add optional fields:

- `budgetAlertThresholds: number[]` (default: `[0.75, 0.90, 1.00]`)
- `lastAlertedThreshold: number` (for deduplication)
- `lastAlertedAt: Date`

### New: Platform Events

- `roi.summary.computed` -- emitted when ROI summary is calculated (for audit trail)
- `roi.budget.exceeded` -- emitted when cost crosses a budget threshold

---

## 6. API Design

### Cost Configuration

- `GET /api/projects/:projectId/cost-config` -- Read cost config
- `PUT /api/projects/:projectId/cost-config` -- Create or update cost config (upsert)

### ROI Metrics

- `GET /api/projects/:projectId/roi/summary?from=&to=` -- ROI summary with real cost data
- `GET /api/projects/:projectId/roi/cost-trend?from=&to=&granularity=day|week|month` -- Time-series cost data
- `GET /api/projects/:projectId/roi/agent-breakdown?from=&to=` -- Per-agent cost breakdown
- `POST /api/projects/:projectId/roi/simulate` -- What-if simulation (body: `{ containmentRate: number }`)

### Permissions

All endpoints require `requireProjectPermission(req, res, 'analytics:read')`. Cost config write requires `analytics:write`.

---

## 7. Dependencies

| Dependency                   | Package           | Status |
| ---------------------------- | ----------------- | ------ |
| ProjectCostConfig model      | `pipeline-engine` | Exists |
| ROICalculator service        | `pipeline-engine` | Exists |
| Model pricing table          | `shared-kernel`   | Exists |
| LLM event schema             | `eventstore`      | Exists |
| ClickHouse LLM metrics       | `database`        | Exists |
| Analytics hooks (SWR)        | `studio`          | Exists |
| Platform event emitter       | `eventstore`      | Exists |
| Alerting threshold evaluator | `eventstore`      | Exists |
| Budget alert event schema    | `eventstore`      | New    |
| Cost config route            | `runtime`         | New    |
| ROI route                    | `runtime`         | New    |
| ROI dashboard page           | `studio`          | New    |
| Cost config settings panel   | `studio`          | New    |

---

## 8. Risks and Mitigations

| Risk                                                          | Impact | Likelihood | Mitigation                                                                |
| ------------------------------------------------------------- | ------ | ---------- | ------------------------------------------------------------------------- |
| ClickHouse unavailable at ROI computation time                | High   | Low        | Graceful degradation: show cached summary or "data unavailable" state     |
| Stale cost config leads to misleading ROI numbers             | Medium | Medium     | Show "last updated" timestamp; prompt review if config > 30 days old      |
| Budget alert storm if cost spikes rapidly                     | Medium | Low        | Deduplication: one alert per threshold per billing period                 |
| Containment rate not automatically measured                   | High   | High       | Phase 1: manual config; Phase 2: auto-compute from session outcome events |
| Token cost estimation inaccurate for custom/fine-tuned models | Medium | Medium     | Allow per-model cost override in cost config; fallback to DEFAULT_PRICING |

---

## 9. Success Metrics

| Metric                                      | Target                      | Measurement                                   |
| ------------------------------------------- | --------------------------- | --------------------------------------------- |
| Projects with cost config configured        | > 50% (30 days post-launch) | Count of ProjectCostConfig documents          |
| ROI dashboard page views per active project | > 3/week                    | Analytics event tracking                      |
| Time to first ROI insight                   | < 5 minutes                 | From project creation to first dashboard view |
| Budget alert response time                  | < 1 minute                  | Event timestamp to alert delivery             |
| Simulation feature engagement               | > 20% of dashboard visitors | Client-side analytics                         |
