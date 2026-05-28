# Testing Guide: Agent Governance Dashboard

**Feature**: [Agent Governance Dashboard](../features/governance.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-29
**Owner**: Platform Team
**Packages**: `apps/runtime`, `apps/studio`, `packages/database`

---

## 1. Current State

Implementation complete as of 2026-04-29. All 11 runtime API endpoints implemented, all Studio UI components implemented, 36 unit tests and 12 contract integration tests pass. Remaining coverage gaps are all ClickHouse-dependent scenarios requiring live ClickHouse seeding. See GAP-012 in the feature spec.

---

## 2. Coverage Matrix

| FR    | Description                                                          | Unit | Integration | E2E | Manual | Status          |
| ----- | -------------------------------------------------------------------- | ---- | ----------- | --- | ------ | --------------- |
| FR-1  | Governance policy CRUD with validation                               | —    | ✅          | —   | ✗      | PARTIAL         |
| FR-2  | Policy name uniqueness (409 on duplicate)                            | —    | ✅          | —   | ✗      | PARTIAL         |
| FR-3  | Studio policy editor form                                            | —    | —           | —   | ✗      | NOT TESTED      |
| FR-4  | pipelineType validation against VALID_PIPELINE_TYPES                 | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-5  | Status aggregation: PASS/WARN/FAIL per rule                          | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-6  | Status endpoint period param (7d/30d/90d)                            | —    | ✅          | —   | —      | PARTIAL         |
| FR-7  | Status Redis caching (5-min TTL)                                     | ✅   | —           | —   | —      | PARTIAL         |
| FR-8  | Agent Registry sortable table                                        | —    | —           | —   | ✗      | NOT TESTED      |
| FR-9  | Per-agent overall PASS/WARN/FAIL badge                               | ✅   | —           | —   | —      | PARTIAL         |
| FR-10 | Agent detail panel with sparklines                                   | —    | —           | —   | ✗      | NOT TESTED      |
| FR-11 | Registry table sort + date range                                     | —    | —           | —   | ✗      | NOT TESTED      |
| FR-12 | Compliance card per pipeline type                                    | —    | —           | —   | ✗      | NOT TESTED      |
| FR-13 | "Create Alert" CTA deep-link                                         | —    | —           | —   | ✗      | NOT TESTED      |
| FR-14 | "No threshold" empty state                                           | —    | —           | —   | ✗      | NOT TESTED      |
| FR-15 | Policy editor slide-over form UI                                     | —    | —           | —   | ✗      | NOT TESTED      |
| FR-16 | Audit Trail paginated timeline                                       | —    | ✅          | —   | ✗      | PARTIAL         |
| FR-17 | Audit event row fields (Zod contract)                                | —    | ✅          | —   | —      | PARTIAL         |
| FR-18 | Audit filters (pipeline, agent, severity)                            | —    | —           | —   | ✗      | NOT TESTED      |
| FR-19 | /governance/audit endpoint                                           | —    | ✅          | —   | —      | PARTIAL         |
| FR-20 | CSV export (column headers, content-type)                            | —    | —           | —   | ✗      | NOT TESTED      |
| FR-21 | PDF export (compliance report content)                               | —    | —           | —   | ✗      | NOT TESTED      |
| FR-22 | PDF generation server-side streaming                                 | —    | —           | —   | ✗      | NOT TESTED      |
| FR-23 | CSV route streaming (content-disposition)                            | —    | —           | —   | ✗      | NOT TESTED      |
| FR-24 | Loading skeletons + empty states                                     | —    | —           | —   | ✗      | NOT TESTED      |
| FR-25 | Error banners on API errors                                          | —    | —           | —   | ✗      | NOT TESTED      |
| FR-26 | All strings use i18n governance namespace                            | —    | —           | —   | ✗      | NOT TESTED      |
| FR-27 | Date range URL param persistence                                     | —    | —           | —   | ✗      | NOT TESTED      |
| FR-28 | "Mark as Reviewed" action creates override event                     | —    | —           | —   | ✗      | NOT TESTED      |
| FR-29 | POST /governance/audit/:eventRef/override endpoint                   | —    | ✅          | —   | —      | PARTIAL         |
| FR-30 | Policy version counter + thresholdAtTime in audit                    | ✅   | —           | —   | —      | PARTIAL         |
| FR-31 | governance:audit-read scope grants external auditor read-only access | —    | —           | —   | ✗      | NOT IMPLEMENTED |
| FR-32 | /governance/frameworks endpoint with per-control status              | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-33 | SOC2 control mapping (CC6.1, CC7.1, CC7.2, CC8.1, CC9.1)             | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-34 | GDPR checklist (Arts. 5, 22, 25, 30, 13/14)                          | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-35 | EU AI Act checklist (Arts. 9, 11, 12, 13, 14, 15)                    | ✅   | ✅          | —   | —      | PARTIAL         |
| FR-36 | Framework checklists in PDF report and CSV export                    | —    | —           | —   | ✗      | NOT TESTED      |

---

## 3. E2E Test Scenarios

All E2E tests must: start a real Express server on a random port, authenticate via the real auth middleware chain, seed data via POST endpoints only, and assert via GET responses. No mocking of platform components (`vi.mock` of `@abl/*` or `@agent-platform/*` is forbidden).

### E2E-1: Governance Policy CRUD — full lifecycle

**Setup**: Authenticated project-member user; empty governance_policies collection for projectId
**Steps**:

1. `POST /api/projects/:projectId/governance/policies` with valid body (name, rules with `quality_evaluation` pipelineType, `gte` operator, threshold 3.5, severity `critical`)
2. Assert 201 + `{ _id, name, rules, status: 'enabled' }`
3. `GET /api/projects/:projectId/governance/policies/:policyId` → assert same document
4. `PUT /api/projects/:projectId/governance/policies/:policyId` with updated threshold 4.0
5. Assert 200 + updated threshold
6. `DELETE /api/projects/:projectId/governance/policies/:policyId` → assert 200
7. `GET /api/projects/:projectId/governance/policies/:policyId` → assert 404

**Pass criterion**: All 7 steps return expected status codes and body shapes

### E2E-2: Tenant isolation — cross-project 404

**Setup**: Two tenants (tenantA, tenantB), each with a project and a governance policy
**Steps**:

1. Authenticate as tenantA user
2. `GET /api/projects/:projectIdB/governance/policies` (tenantB's project) → assert 404
3. `PUT /api/projects/:projectIdB/governance/policies/:policyId` → assert 404
4. Authenticate as unauthenticated (no token)
5. `GET /api/projects/:projectIdA/governance/policies` → assert 401

**Pass criterion**: 404 for cross-project, 401 for unauthenticated

### E2E-3: Governance status — PASS/WARN/FAIL derivation

**Setup**: Project with two governance policies: (a) `quality_evaluation.overall_score gte 3.5` severity critical; (b) `hallucination_detection.faithfulness_score gte 0.80` severity warning. ClickHouse seeded with test rows where `quality_evaluation.overall_score = 3.2` (FAIL) and `hallucination_detection.faithfulness_score = 0.85` (PASS). Note: `hallucination_rate` is not a valid column — use `faithfulness_score` or `overall_score` per METRIC_REGISTRY.
**Steps**:

1. `GET /api/projects/:projectId/governance/status?period=7d`
2. Assert response includes per-rule statuses: quality → FAIL (critical), hallucination → PASS
3. Assert per-agent posture: overall status = FAIL (critical wins)
4. Re-seed ClickHouse with quality score = 3.8
5. `GET /api/projects/:projectId/governance/status?period=7d` (cache busted)
6. Assert quality rule → PASS; overall status → PASS

**Pass criterion**: Status correctly reflects metric values against threshold; overall status is most severe rule

### E2E-4: Audit Trail — breach event retrieval and filtering

**Setup**: Governance policy with quality_evaluation.overall_score gte 3.5. ClickHouse seeded with quality rows: 5 rows below threshold (breach), 3 rows above threshold (compliance)
**Steps**:

1. `GET /api/projects/:projectId/governance/audit?period=30d&page=1&limit=10`
2. Assert response includes breach events (rows where metric < threshold) and recovery events
3. `GET .../audit?pipelineType=quality_evaluation&severity=critical` — assert filtered results
4. `GET .../audit?page=2&limit=5` — assert correct pagination offset

**Pass criterion**: Breach events correctly identified; filters work; pagination is consistent

### E2E-5: CSV export — format and download

**Setup**: Project with governance policy and seeded ClickHouse breach events
**Steps**:

1. `GET /api/projects/:projectId/governance/report.csv?period=7d`
2. Assert `Content-Type: text/csv`
3. Assert `Content-Disposition: attachment; filename="governance-report-*.csv"`
4. Assert first line = column headers: `timestamp,pipelineType,metric,agent,threshold,actualValue,severity,eventType`
5. Assert subsequent lines are comma-separated data rows matching known test data

**Pass criterion**: Valid CSV download with correct headers and row content

### E2E-6: PDF export — response integrity

**Setup**: Same as E2E-5
**Steps**:

1. `GET /api/projects/:projectId/governance/report.pdf?period=7d`
2. Assert `Content-Type: application/pdf`
3. Assert `Content-Disposition: attachment; filename="governance-report-*.pdf"`
4. Assert response body is non-empty and starts with `%PDF-` magic bytes

**Pass criterion**: Valid PDF download with correct headers

### E2E-7: Isolation — non-CRUD routes return 404 cross-project, 401 unauthenticated

**Setup**: ProjectA with governance policies and seeded ClickHouse data; ProjectB in a different tenant
**Steps**:

1. Authenticate as tenantA user
2. `GET /api/projects/:projectIdB/governance/status?period=7d` → assert 404
3. `GET /api/projects/:projectIdB/governance/audit` → assert 404
4. `GET /api/projects/:projectIdB/governance/report.csv?period=7d` → assert 404
5. Remove auth header; `GET /api/projects/:projectIdA/governance/status` → assert 401
6. Remove auth header; `GET /api/projects/:projectIdA/governance/report.pdf` → assert 401

**Pass criterion**: Cross-project access returns 404; unauthenticated access returns 401 for all non-CRUD routes

### E2E-9: Human override — "Mark as Reviewed" creates attestation record

**Setup**: Project with governance policy + seeded ClickHouse breach event (eventRef = `quality_evaluation:my-agent:overall_score:2026-04-01T10:00:00Z`)
**Steps**:

1. `POST /api/projects/:projectId/governance/audit/quality_evaluation:my-agent:overall_score:2026-04-01T10:00:00Z/override` with `{ justification: "False positive — model retrained on 2026-03-31", reviewedBy: userId }`
2. Assert 201 + `{ _id, eventRef, reviewedBy, justification, createdAt }`
3. `GET /api/projects/:projectId/governance/audit?period=30d` — assert the breach event row now includes `overrideId` and `reviewStatus: 'reviewed'`
4. `GET /api/projects/:projectId/governance/report.csv?period=30d` — assert CSV row for the event includes `reviewedBy` and `reviewJustification` columns

**Pass criterion**: Override record created; audit timeline and CSV export reflect the attestation

### E2E-10: Policy version — thresholdAtTime preserved after threshold change

**Setup**: Governance policy version 1 (threshold = 3.5); breach event recorded. Then policy updated to threshold = 4.0 (version 2).
**Steps**:

1. `GET /api/projects/:projectId/governance/audit?period=30d`
2. Assert breach event from before the policy update shows `thresholdAtTime: 3.5` (not 4.0)
3. Assert breach events after the update show `thresholdAtTime: 4.0`

**Pass criterion**: Historical breach events reflect the threshold that was active at event time, not the current threshold

### E2E-11: External auditor access — audit-read scope grants read, not write

**Setup**: Project with governance policies + audit events. External auditor user granted `governance:audit-read` scope.
**Steps**:

1. Authenticate as external auditor
2. `GET /api/projects/:projectId/governance/audit` → assert 200
3. `GET /api/projects/:projectId/governance/report.pdf` → assert 200
4. `POST /api/projects/:projectId/governance/policies` → assert 403 (governance:write required)
5. `POST /api/projects/:projectId/governance/audit/:eventRef/override` → assert 403

**Pass criterion**: Read access granted; write access denied for governance:audit-read scope

### E2E-12: Frameworks endpoint — SOC2 control status derivation

**Setup**: Project with a `guardrail_analysis` governance policy (PASS in current period) and at least one enabled governance policy (any type).
**Steps**:

1. `GET /api/projects/:projectId/governance/frameworks?period=7d`
2. Assert HTTP 200 + response contains `frameworks` array with three entries: `SOC2`, `GDPR`, `EU_AI_ACT`
3. Assert SOC2 controls: `CC9.1` (risk assessment) = `PASS` (enabled policy exists), `CC6.1` (logical access) = `PASS` (guardrail_analysis PASS), `CC7.2` (monitoring) = `NOT_EVALUATED` (no anomaly_detection policy configured)
4. Remove the guardrail_analysis policy; re-request; assert `CC6.1` = `NOT_EVALUATED` (no matching policy)

**Pass criterion**: Control status correctly reflects governance policy presence and evaluation results; NOT_EVALUATED used correctly when no policy maps

### E2E-13: Frameworks endpoint — EU AI Act Art. 14 human oversight control

**Setup**: Project with a governance policy + seeded breach event + one `governance_overrides` record for the breach event.
**Steps**:

1. `GET /api/projects/:projectId/governance/frameworks?period=30d`
2. Assert EU AI Act `Art_14` (human oversight) = `PASS` (override record exists for FAIL event)
3. Delete the override record from MongoDB (via DELETE endpoint or test teardown)
4. Re-request frameworks (no cache); assert `Art_14` = `WARN` (FAIL events exist but no override records)

**Pass criterion**: Art. 14 status reflects whether human review has been performed on breach events

### E2E-14: Frameworks endpoint — isolation and auth

**Setup**: ProjectA (tenantA) and ProjectB (tenantB), each with governance policies
**Steps**:

1. Authenticate as tenantA user
2. `GET /api/projects/:projectIdB/governance/frameworks?period=7d` → assert 404
3. Remove auth header; `GET /api/projects/:projectIdA/governance/frameworks?period=7d` → assert 401

**Pass criterion**: Cross-project returns 404; unauthenticated returns 401

### E2E-15: PDF report includes framework compliance section

**Setup**: Project with governance policies covering SOC2-mapped pipeline types
**Steps**:

1. `GET /api/projects/:projectId/governance/report.pdf?period=7d`
2. Assert HTTP 200 + `Content-Type: application/pdf`
3. Assert response body starts with `%PDF-` magic bytes and is non-empty

**Pass criterion**: PDF response is a valid PDF file (full content verification — framework section presence — is manual-only for Phase 1)

### E2E-8: Duplicate policy name — 409 rejection

**Setup**: Existing policy named "Quality Policy" in projectId
**Steps**:

1. `POST /api/projects/:projectId/governance/policies` with same name "Quality Policy"
2. Assert HTTP 409 with `{ success: false, error: { code: 'GOVERNANCE_POLICY_EXISTS', message: ... } }`

**Pass criterion**: 409 returned; no duplicate document created

---

---

## 4. Integration Test Scenarios

### INT-1: Policy evaluation service — all operators

**What to test**: `GovernanceStatusService.evaluateRule()` pure function with inputs (metricValue, operator, threshold)
**Inputs to cover**: `gt`, `gte`, `lt`, `lte`, `eq` — both passing and failing cases for each operator
**No mocks required**: Pure function, no external dependencies
**Pass criterion**: All 10 operator/direction combinations return correct PASS or FAIL

### INT-2: Policy evaluation service — per-agent overall status priority

**What to test**: `GovernanceStatusService.computeAgentStatus(ruleResults[])` — FAIL beats WARN beats PASS
**Cases**: [PASS, PASS] → PASS; [WARN, PASS] → WARN; [FAIL, WARN] → FAIL; [FAIL, PASS] → FAIL
**Pass criterion**: All 4 cases return correct overall status

### INT-3: Audit query builder — parameterized threshold safety

**What to test**: `GovernanceAuditService.buildBreachQuery()` does not interpolate threshold into SQL string
**Method**: Inspect the returned ClickHouse query object — threshold must appear in the `parameters` map, not in the `query` string
**Pass criterion**: Query string contains `{threshold:Float64}` placeholder, not the literal threshold value

### INT-4: Governance status service — partial pipeline failure handling

**What to test**: When one pipeline-analytics summary call throws (simulating ClickHouse unavailability for that table), the service returns results for other pipelines with the failed type marked `{ status: 'unavailable' }`
**No platform mocks**: Use dependency injection — pass a mock pipeline-analytics client that throws for one specific pipelineType
**Pass criterion**: Response contains results for N-1 pipelines; failed pipeline has `status: 'unavailable'`; no top-level error thrown

### INT-5: Governance policy model — tenant isolation plugin

**What to test**: Mongoose `governance_policies` model cannot query without `tenantId` in the filter
**Method**: Call `GovernancePolicy.find({ projectId })` without tenantId — assert `tenantIsolationPlugin` throws or adds tenantId
**Pass criterion**: Query without tenantId is rejected or auto-scoped (consistent with existing platform model behavior)

### INT-7: Policy version increment on update

**What to test**: `PUT /governance/policies/:id` increments `version` from N to N+1 atomically
**Method**: Create policy (version=1), update threshold, assert version=2, update name, assert version=3
**Pass criterion**: Version counter increments monotonically; never resets; stored correctly in MongoDB

### INT-8: Audit query — breach detection groups rules by pipelineType

**What to test**: `GovernanceAuditService.buildBreachQueries()` groups multiple rules with the same `pipelineType` into a single ClickHouse query, not separate queries
**Method**: Create 3 rules all on `quality_evaluation`; assert the service produces 1 ClickHouse query, not 3
**No platform mocks**: Pure query-builder logic
**Pass criterion**: One query object returned per unique pipelineType, not one per rule

### INT-9: Framework evaluation service — SOC2 control status derivation

**What to test**: `GovernanceFrameworksService.evaluateSOC2Controls(governanceStatus, overrideCount)` pure function
**Cases**:

- CC9.1: `enabledPolicies > 0` → PASS; `enabledPolicies === 0` → NOT_EVALUATED
- CC6.1: guardrail_analysis rule present and PASS → PASS; rule present and FAIL → FAIL; no rule → NOT_EVALUATED
- CC7.2: anomaly_detection rule present and PASS → PASS; no rule → NOT_EVALUATED
  **No platform mocks**: Pure function, inputs are plain objects
  **Pass criterion**: All 3 controls × all status paths return correct status

### INT-10: Framework evaluation service — EU AI Act Art. 14 human oversight

**What to test**: `GovernanceFrameworksService.evaluateEUAIActControls()` — Art. 14 derives from override count vs FAIL event count
**Cases**: (a) no FAIL events → PASS; (b) FAIL events exist + overrides exist for all → PASS; (c) FAIL events exist + no overrides → WARN; (d) no governance policies at all → NOT_EVALUATED
**Pass criterion**: All 4 cases return correct status

### INT-6: CSV formatter — row limit enforcement

**What to test**: `GovernanceReportService.streamCsv()` stops at `GOVERNANCE_REPORT_MAX_ROWS` even if ClickHouse returns more rows
**Method**: Inject a mock audit service that returns 10,001 rows; assert CSV output has exactly 10,000 data rows
**Pass criterion**: Row count in CSV output is capped at the configured limit

---

## 5. Testing Notes

- **ClickHouse test data**: The existing runtime test setup seeds ClickHouse data via `packages/pipeline-engine/src/__tests__/test-utils.ts` (verify this path exists before implementation). Governance tests must use the same seeding utilities rather than querying MongoDB directly.
- **Framework evaluation tests**: `apps/runtime/src/__tests__/governance-frameworks.e2e.test.ts` (E2E-12 through E2E-15) and `apps/runtime/src/__tests__/governance-frameworks.service.test.ts` (INT-9, INT-10). Framework evaluation service is a pure function — no external dependencies, zero mocks required.
- **No mocking of platform components**: `vi.mock` of `@abl/*`, `@agent-platform/*`, or relative imports (`../`) is forbidden per CLAUDE.md. Use dependency injection for any service-level isolation.
- **Redis cache in E2E tests**: The status endpoint caches in Redis. E2E tests must either flush the cache between assertions (using the real Redis test instance) or pass a `?nocache=true` param (to be added during LLD if needed).
- **PDF byte validation**: E2E-6 validates the PDF magic bytes (`%PDF-`). Full structural PDF validation (section counts, embedded tables) is manual-only for Phase 1.
- **Security scenarios**: Cross-tenant 404 and unauthenticated 401 must be tested for every route group — policy CRUD, status, audit, reports, and frameworks.

### PR test drift detection

Repo-wide PR drift checks are intentionally narrow and should stay consistent
with the runtime deterministic testing architecture:

- Run `pnpm test:changed:pr` for the changed-test PR lane. The lane uses the
  branch upstream as its base and falls back to `origin/develop`; it must never
  hard-code `origin/main`.
- The changed-test lane must run the affected build before tests. Build output
  can be stale otherwise, which makes Turbo test failures misleading.
- Run `pnpm lint:mock-export-drift` for the mock-export drift detector.
- The mock-export drift detector is diff-scoped and low-noise: it reports newly
  added runtime value exports and newly introduced named runtime imports only
  when an affected internal mock omits that value.
- Type-only exports and imports are ignored.
- Internal mock drift is a refactor/testability signal. Prefer dependency
  injection or pure-function extraction over expanding relative-path mocks.
- Timing failures, async scheduling bugs, and WebSocket handler regressions are
  not static-detector findings. Reproduce those with focused Vitest,
  integration, or E2E coverage.

---

## 6. Security & Isolation Tests

| Scenario                                                           | Expected | Covered By              |
| ------------------------------------------------------------------ | -------- | ----------------------- |
| Cross-tenant access to governance policies                         | 404      | E2E-2                   |
| Cross-tenant access to governance status                           | 404      | E2E-7                   |
| Cross-tenant access to audit trail                                 | 404      | E2E-7                   |
| Cross-tenant access to CSV/PDF reports                             | 404      | E2E-7                   |
| Cross-tenant access to frameworks endpoint                         | 404      | E2E-14                  |
| Unauthenticated access to any governance route                     | 401      | E2E-2, E2E-7, E2E-14    |
| governance:audit-read scope: read audit/reports → allowed          | 200      | E2E-11                  |
| governance:audit-read scope: write policies → blocked              | 403      | E2E-11                  |
| governance:audit-read scope: POST override → blocked               | 403      | E2E-11                  |
| Input with invalid pipelineType in policy rule                     | 400      | E2E-1 (validation step) |
| Threshold interpolated into SQL string (parameterized query check) | N/A      | INT-3                   |
| Policy name uniqueness within project                              | 409      | E2E-8                   |

---

## 7. Test Infrastructure

**Required services**:

- MongoDB (real instance, not mock) — `governance_policies` and `governance_overrides` collections
- Redis (real instance) — status cache (flush between test runs)
- ClickHouse (real instance) — seeded with pipeline evaluation rows for breach/PASS scenarios

**Data seeding**:

- Seed ClickHouse data via `packages/pipeline-engine/src/__tests__/test-utils.ts` utilities
- Seed governance policies via `POST /api/projects/:projectId/governance/policies` endpoint (not direct DB writes)
- Seed governance overrides via `POST /api/projects/:projectId/governance/audit/:eventRef/override` endpoint

**Environment variables required for tests**:

```
GOVERNANCE_STATUS_CACHE_TTL_SECONDS=5   # short TTL for cache-bust tests
GOVERNANCE_REPORT_MAX_ROWS=10000
CLICKHOUSE_URL=http://localhost:8123
MONGODB_URI=mongodb://localhost:27017/abl_test
REDIS_URL=redis://localhost:6379
```

**CI configuration**: Tests run under `pnpm test --filter=@abl/runtime` in the same Docker Compose stack that provides MongoDB, Redis, and ClickHouse for existing runtime integration tests. No new infrastructure required.

---

## 8. Test File Mapping

**Actual test files (post-implementation):**

| Test File                                                                   | Type        | Exists | Covers                                                                           |
| --------------------------------------------------------------------------- | ----------- | ------ | -------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/governance-unit.test.ts`                        | unit        | ✅     | FR-5, FR-9, FR-30, FR-32, FR-33, FR-34, FR-35, FR-7 (INT-1, INT-2, INT-3, INT-9) |
| `apps/runtime/src/__tests__/contracts/governance-policies.contract.test.ts` | integration | ✅     | FR-1, FR-2, FR-4, FR-5, FR-6, FR-16, FR-19, FR-29, FR-32, cross-tenant isolation |

**Planned but not yet created (required for BETA):**

| Test File                                                              | Type        | Covers                                                                             |
| ---------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/governance-clickhouse.integration.test.ts` | integration | FR-5, FR-6, FR-7, FR-9, FR-16, FR-18, FR-19 (ClickHouse breach detection, caching) |
| `apps/runtime/src/__tests__/governance-reports.integration.test.ts`    | integration | FR-20, FR-21, FR-22, FR-23 (CSV/PDF streaming)                                     |
| `apps/runtime/src/__tests__/governance-override.integration.test.ts`   | integration | FR-28, FR-29, FR-30 (E2E-9, E2E-10)                                                |
| `apps/runtime/src/__tests__/governance-frameworks.integration.test.ts` | integration | FR-35 Art.14 with overrides (E2E-13)                                               |

---

## 9. Open Testing Questions

1. **ClickHouse test utility path**: Verify `packages/pipeline-engine/src/__tests__/test-utils.ts` exists and supports seeding rows for all 6 governance pipeline types before writing E2E-3 and E2E-4 setup code.
2. **Redis cache invalidation in E2E tests**: Determine whether tests flush the real Redis cache between assertions or rely on a `?nocache=true` param. LLD must specify the chosen approach.
3. **Override record teardown**: E2E-13 requires deleting a `governance_overrides` record mid-test to verify Art. 14 status changes. Confirm whether a `DELETE /governance/audit/:eventRef/override` endpoint is needed for test teardown (not required for production) or whether tests use MongoDB-scoped teardown utilities.
4. **PDF structural validation**: E2E-15 only validates magic bytes. Manual validation of the "Regulatory Framework Compliance Status" PDF section is required before BETA status — add to QA checklist.
5. **INT-4 dependency injection pattern**: Confirm whether `GovernanceStatusService` accepts a pipeline-analytics client via constructor injection (preferred) or accesses it via module import (harder to isolate). LLD must choose the DI pattern before implementation.
