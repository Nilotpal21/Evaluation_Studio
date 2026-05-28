# Test Spec: Diagnostics Engine

> **Feature ID:** #43
> **Feature Spec:** `docs/features/diagnostics.md`
> **Status:** PLANNED
> **Created:** 2026-03-22

---

## 1. Test Strategy Overview

The Diagnostics Engine extends the existing runtime diagnostics subsystem with persistence, scheduling, new analyzers, aggregation APIs, and remediation. Testing must cover:

- **Unit tests**: Individual analyzer logic with mock contexts
- **Integration tests**: API endpoints with real Express server, full middleware chain, real MongoDB
- **E2E tests**: Complete diagnostic flows from API call through engine to persisted report

All E2E and integration tests interact ONLY via HTTP API. No mocking of codebase components. No direct DB access from tests. Real servers started on random ports.

---

## 2. E2E Test Scenarios

### E2E-1: Full Diagnostic Run with Persistence

**Description:** Execute a diagnostic run via API, verify the report is returned AND persisted to MongoDB, then query it via the history endpoint.

**Steps:**

1. Start runtime server on random port with real MongoDB (MongoMemoryServer)
2. Seed a tenant, project, and agent via POST endpoints
3. `POST /api/projects/:projectId/agents` to create an agent with DSL content
4. `GET /api/projects/:projectId/diagnostics/agents/:agentName?persist=true`
5. Verify response contains DiagnosticReport with status, findings, summary
6. `GET /api/projects/:projectId/diagnostics/history?agentName=:agentName`
7. Verify the persisted report appears in history with matching report ID
8. Verify tenantId isolation: create a second tenant and verify it cannot see first tenant's reports

**Expected Results:**

- Diagnostic report returned with HTTP 200, `{ success: true, data: DiagnosticReport }`
- Report persisted with correct tenantId, projectId, agentName
- History endpoint returns the report with pagination metadata
- Cross-tenant query returns empty results (not 403)

**FR Coverage:** FR-01, FR-04, FR-18

---

### E2E-2: Scheduled Diagnostic Run Lifecycle

**Description:** Configure a diagnostic schedule, wait for the BullMQ job to fire, verify the report is persisted automatically.

**Steps:**

1. Start runtime server with real MongoDB and Redis
2. Seed tenant + project
3. `PUT /api/projects/:projectId/diagnostics/schedule` with `{ enabled: true, intervalMinutes: 1, depth: "quick" }`
4. Verify response confirms schedule creation
5. Wait for BullMQ job to complete (poll history endpoint, max 90 seconds)
6. `GET /api/projects/:projectId/diagnostics/history` and verify at least 1 report with `trigger: "scheduled"`
7. `PUT /api/projects/:projectId/diagnostics/schedule` with `{ enabled: false }` to disable
8. Verify no new reports are generated after disabling

**Expected Results:**

- Schedule created with HTTP 200
- At least one scheduled report appears in history within 90 seconds
- Reports have `trigger: "scheduled"` field
- Disabling schedule stops new report generation

**FR Coverage:** FR-03, FR-20

---

### E2E-3: Project Diagnostic Summary Aggregation

**Description:** Run diagnostics for multiple agents in a project, then query the summary endpoint for aggregate health.

**Steps:**

1. Start runtime server
2. Seed tenant + project + 3 agents (one healthy, one with missing model, one with missing credential)
3. Run diagnostics for each agent with `?persist=true`
4. `GET /api/projects/:projectId/diagnostics/summary`
5. Verify summary shows overall status = worst of all agents
6. Verify agent-level breakdowns include finding counts
7. Verify lastRun timestamp is recent

**Expected Results:**

- Summary endpoint returns HTTP 200
- `overall` status reflects the worst agent status ("broken" if any agent is broken)
- Each agent listed with individual status and finding counts
- `lastRun` is within the last 60 seconds

**FR Coverage:** FR-05, FR-01

---

### E2E-4: Guardrail Health Analyzer Detection

**Description:** Configure agents with valid and invalid guardrails, run diagnostics, verify the guardrail analyzer produces correct findings.

**Steps:**

1. Start runtime server
2. Seed tenant + project
3. Create agent with guardrail references in DSL
4. Create matching GuardrailConfig records (some valid, some with unreachable providers)
5. `GET /api/projects/:projectId/diagnostics/agents/:agentName?depth=deep`
6. Verify findings include guardrail-specific codes (e.g., `GUARDRAIL_PROVIDER_UNREACHABLE`, `GUARDRAIL_NOT_FOUND`)
7. Verify findings include the specific guardrail name in evidence

**Expected Results:**

- Guardrail health findings appear in the report
- Missing guardrails flagged with severity "warning"
- Unreachable providers flagged with severity "warning"
- Properly configured guardrails produce no findings (or info-level)

**FR Coverage:** FR-07

---

### E2E-5: Memory Health Analyzer Detection

**Description:** Test diagnostics for agents with and without memory configuration, with and without FactStore availability.

**Steps:**

1. Start runtime server
2. Seed tenant + project
3. Create agent A with REMEMBER/RECALL in DSL (memory-capable)
4. Create agent B without memory directives
5. Run diagnostics for agent A -- should detect memory-configured status
6. Run diagnostics for agent B -- should report "no memory configured" (info)
7. Verify findings distinguish between "memory not configured" (info) and potential memory issues

**Expected Results:**

- Agent A: Memory health finding present with appropriate severity
- Agent B: Info-level finding "no memory configured"
- Evidence includes FactStore availability status and userId configuration

**FR Coverage:** FR-09

---

### E2E-6: Remediation Action Execution

**Description:** Run diagnostics that produce a remediable finding, execute the remediation action via API, verify the action result.

**Steps:**

1. Start runtime server
2. Seed tenant + project + agent with stale credential (lastValidatedAt > 30 days ago)
3. Run diagnostics -- should detect `CREDENTIAL_STALE` finding
4. `POST /api/projects/:projectId/diagnostics/remediate` with `{ reportId, findingCode: "CREDENTIAL_STALE", actionType: "revalidate_credential", confirmed: true }`
5. Verify response contains RemediationResult with success status
6. Run diagnostics again -- verify staleness warning is resolved (or at least re-validated timestamp updated)

**Expected Results:**

- Remediation endpoint returns HTTP 200 with `{ success: true, data: RemediationResult }`
- Action execution is logged (verify via traces endpoint)
- Subsequent diagnostic run reflects the remediation effect

**FR Coverage:** FR-11, FR-12

---

### E2E-7: Tenant Summary for Platform Admin

**Description:** As a platform admin, query cross-project diagnostic summary for a tenant.

**Steps:**

1. Start runtime server
2. Seed 1 tenant with 3 projects
3. Run diagnostics for agents in each project with `?persist=true`
4. `GET /api/tenants/diagnostics/summary` with platform admin auth
5. Verify response includes all 3 projects with individual status
6. Test with non-admin auth -- should get 403
7. Test with different tenant admin -- should get empty or 404 (isolation)

**Expected Results:**

- Platform admin sees all projects for their tenant
- Non-admin receives 403
- Cross-tenant admin sees no data from other tenants

**FR Coverage:** FR-06

---

## 3. Integration Test Scenarios

### INT-1: DiagnosticEngine Analyzer Registration and Depth Filtering

**Description:** Verify the engine registers all analyzers and correctly filters them by depth.

**Steps:**

1. Create a DiagnosticEngine instance
2. Register test analyzers across all three categories (infra, execution, behavioral)
3. Call `diagnose()` with depth "quick" -- verify only infra analyzers run
4. Call `diagnose()` with depth "standard" -- verify infra + execution analyzers run
5. Call `diagnose()` with depth "deep" -- verify all analyzers run
6. Verify analyzer failures produce warning findings (not crashes)

**Expected Results:**

- Quick depth: only infra category analyzers
- Standard depth: infra + execution (excludes behavioral)
- Deep depth: all three categories
- Failed analyzer produces `ANALYZER_FAILED` warning finding

**FR Coverage:** FR-18 (backward compatibility)

---

### INT-2: Report Persistence Layer

**Description:** Verify reports are correctly stored in and retrieved from MongoDB with proper indexing and TTL.

**Steps:**

1. Start MongoMemoryServer
2. Create DiagnosticReport documents via the persistence service
3. Query by tenantId + projectId + date range
4. Query by tenantId + projectId + agentName
5. Verify TTL index exists on createdAt field
6. Verify pagination (limit, skip) works correctly
7. Verify cross-tenant queries return empty results

**Expected Results:**

- Reports stored with all required fields
- Queries return correct results with proper filtering
- TTL index present on createdAt
- Pagination metadata correct

**FR Coverage:** FR-01, FR-02, FR-04

---

### INT-3: History Endpoint with Auth and Isolation

**Description:** Test the history endpoint with various auth scenarios and isolation guarantees.

**Steps:**

1. Start Express server on random port with full middleware chain
2. Create reports for tenant-A/project-1 and tenant-B/project-2
3. Query history as tenant-A -- should see only tenant-A reports
4. Query history as tenant-B -- should see only tenant-B reports
5. Query with invalid auth -- should get 401
6. Query with wrong project -- should get 404
7. Verify date range filtering works correctly

**Expected Results:**

- Tenant isolation enforced at query level
- Project isolation enforced via middleware
- Auth failures return 401
- Invalid project returns 404

**FR Coverage:** FR-04, NFR-06

---

### INT-4: Diagnostic Schedule CRUD Operations

**Description:** Test schedule creation, reading, updating, and deletion via API.

**Steps:**

1. Start Express server
2. `PUT /schedule` to create a new schedule
3. `GET /schedule` to read it back
4. `PUT /schedule` to update interval and depth
5. Verify the updated values
6. `PUT /schedule` with `enabled: false` to disable
7. Verify schedule is disabled
8. Test validation: intervalMinutes < 5 or > 1440 should fail

**Expected Results:**

- CRUD operations work correctly
- Validation rejects invalid intervals
- Schedule state persists across requests

**FR Coverage:** FR-03, FR-20

---

### INT-5: GuardrailHealthAnalyzer Unit Logic

**Description:** Test the guardrail health analyzer with various guardrail configurations.

**Steps:**

1. Create DiagnosticContext with tenantId, projectId, agentName
2. Seed database with agent record containing guardrail references
3. Test case: All guardrails present and configured -- expect info findings
4. Test case: Referenced guardrail missing from DB -- expect warning finding with code `GUARDRAIL_NOT_FOUND`
5. Test case: Guardrail present but provider endpoint unreachable -- expect warning
6. Test case: No guardrails referenced -- expect info "no guardrails"
7. Test case: Database error -- expect warning `ANALYSIS_ERROR`

**Expected Results:**

- Each scenario produces the expected finding code and severity
- Evidence includes guardrail names and configuration details
- Analyzer does not throw (wraps errors in findings)

**FR Coverage:** FR-07

---

### INT-6: MemoryHealthAnalyzer Unit Logic

**Description:** Test the memory health analyzer with various memory configurations.

**Steps:**

1. Create DiagnosticContext
2. Test case: Agent with REMEMBER/RECALL in DSL, FactStore available -- expect info
3. Test case: Agent with REMEMBER/RECALL, FactStore unavailable -- expect error
4. Test case: Agent without memory directives -- expect info "no memory configured"
5. Test case: Agent with memory, no userId on session -- expect warning
6. Test case: Database error during check -- expect warning `ANALYSIS_ERROR`

**Expected Results:**

- Memory-capable agents properly detected via DSL analysis
- FactStore availability correctly assessed
- Each scenario maps to the correct severity level

**FR Coverage:** FR-09

---

### INT-7: WebhookReachabilityAnalyzer with SSRF Protection

**Description:** Test that the webhook analyzer only probes registered tool endpoints and respects timeouts.

**Steps:**

1. Start a mock HTTP server on a random port (reachable endpoint)
2. Create ProjectTool records pointing to: the mock server, an unreachable host, and a private IP
3. Run the analyzer
4. Verify reachable endpoint produces info finding
5. Verify unreachable endpoint produces warning finding
6. Verify private IP is rejected (SSRF protection) with appropriate finding
7. Verify timeout behavior (mock server with delayed response)

**Expected Results:**

- Only registered ProjectTool URLs are probed
- Private IPs (10.x, 172.16-31.x, 192.168.x) are blocked
- Timeouts produce warning findings
- Unreachable hosts produce warning findings

**FR Coverage:** FR-08

---

### INT-8: Summary Aggregation Logic

**Description:** Test that the summary endpoint correctly aggregates across multiple reports.

**Steps:**

1. Persist 5 reports for different agents: 2 healthy, 2 degraded, 1 broken
2. Call the summary service function
3. Verify overall status = "broken" (worst of all)
4. Verify per-agent breakdowns are correct
5. Verify finding counts are summed correctly
6. Verify lastRun reflects the most recent report

**Expected Results:**

- Overall status is the worst across all agents
- Per-agent summaries are accurate
- Finding counts aggregate correctly
- Date ranges filter properly

**FR Coverage:** FR-05

---

## 4. Coverage Matrix

| FR ID | E2E Scenarios | Integration Scenarios | Coverage                                       |
| ----- | ------------- | --------------------- | ---------------------------------------------- |
| FR-01 | E2E-1, E2E-3  | INT-2                 | Full                                           |
| FR-02 | E2E-1         | INT-2                 | Full                                           |
| FR-03 | E2E-2         | INT-4                 | Full                                           |
| FR-04 | E2E-1         | INT-2, INT-3          | Full                                           |
| FR-05 | E2E-3         | INT-8                 | Full                                           |
| FR-06 | E2E-7         | --                    | Partial (needs INT for isolation)              |
| FR-07 | E2E-4         | INT-5                 | Full                                           |
| FR-08 | --            | INT-7                 | Partial (E2E deferred to webhook availability) |
| FR-09 | E2E-5         | INT-6                 | Full                                           |
| FR-10 | --            | --                    | Deferred (ClickHouse dependency)               |
| FR-11 | E2E-6         | --                    | Partial                                        |
| FR-12 | E2E-6         | --                    | Partial                                        |
| FR-13 | --            | --                    | Deferred (P2)                                  |
| FR-14 | --            | --                    | Deferred (P2)                                  |
| FR-15 | --            | --                    | Deferred (Studio UI tests)                     |
| FR-16 | --            | --                    | Deferred (P2)                                  |
| FR-17 | --            | --                    | Deferred (P2)                                  |
| FR-18 | --            | INT-1                 | Full                                           |
| FR-19 | --            | --                    | Deferred (MCP tool tests)                      |
| FR-20 | E2E-2         | INT-4                 | Full                                           |

**Coverage Summary:** 12/20 FRs covered by E2E or integration tests. 8 deferred to P2/UI/ClickHouse phases.

---

## 5. NFR Test Scenarios

### NFR-1: Diagnostic Latency (NFR-01)

**Description:** Measure diagnostic run duration for standard depth, single agent.

**Steps:**

1. Seed a realistic agent with model config, credentials, tools, guardrails
2. Run 10 diagnostic iterations
3. Measure p50 and p99 latency

**Target:** p99 < 5 seconds

### NFR-2: History Query Performance (NFR-04)

**Description:** Measure history query response time with 30 days of data.

**Steps:**

1. Seed 1000 diagnostic reports across 30 days for a single agent
2. Query history with date range = 30 days
3. Measure response time

**Target:** < 500ms

### NFR-3: Tenant Isolation (NFR-06)

**Description:** Verify every query endpoint enforces tenantId filtering.

**Steps:**

1. Create reports for tenant-A and tenant-B
2. For each endpoint (history, summary, schedule, remediate), verify tenant-A cannot access tenant-B data
3. Verify cross-tenant queries return 404 (not 403)

**Target:** Zero cross-tenant data leakage

---

## 6. Test Infrastructure Requirements

- **MongoDB**: MongoMemoryServer for integration tests; real MongoDB for E2E
- **Redis**: Real Redis instance for BullMQ scheduling tests
- **Express**: Real server on port 0 (random) with full middleware chain
- **No mocks of codebase components**: Only external services (e.g., webhook targets) may use test doubles
- **Test data factories**: Reusable functions for creating tenants, projects, agents, credentials, guardrails

---

## 7. Test Execution Order

1. Unit tests (analyzers) -- fastest, no infrastructure needed
2. Integration tests (INT-1 through INT-8) -- MongoMemoryServer + Express
3. E2E tests (E2E-1 through E2E-7) -- Full stack with Redis
4. NFR tests -- Performance benchmarks (run separately, not in CI gate)
