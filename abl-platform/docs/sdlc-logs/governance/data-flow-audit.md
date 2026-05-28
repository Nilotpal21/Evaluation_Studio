# Governance Feature -- Data-Flow Audit

**Date:** 2026-04-29
**Auditor:** Claude Opus 4.6 (automated)
**Feature:** Governance compliance dashboard (policies, status, audit, frameworks, reports)
**Verdict:** NEEDS_REVISION

---

## Executive Summary

The governance feature has strong tenant isolation at the database layer (all 3 models use `tenantIsolationPlugin`) and consistent `tenantId + projectId` filtering in most route handlers. However, the audit uncovered **2 CRITICAL**, **3 HIGH**, and **4 MEDIUM** findings across 9 dimensions. The most impactful are a ClickHouse SQL injection vector via metric names in the audit service, a contract mismatch between Studio and runtime metric registries that silently breaks policy creation, and missing `projectId` in two MongoDB queries that weaken project isolation within a tenant.

---

## Findings

### F-01: ClickHouse SQL Injection via `rule.metric` in `buildBreachQuery`

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | CRITICAL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Dimension**       | 3 -- Serialization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Affected file**   | `apps/runtime/src/services/governance-audit.service.ts:62-102`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Description**     | `buildBreachQuery()` interpolates `rule.metric` directly into SQL strings (e.g., `` `${r.metric} <= ${r.threshold}` ``). While `METRIC_REGISTRY` validation in the _create/update policy_ routes (governance.ts:282-293, 392-404) prevents malicious metric names from being persisted, the _audit service_ reads policies from MongoDB and feeds their metrics into `buildBreachQuery` without re-validating. If a metric name were to be inserted via a different code path (migration script, direct DB edit, future API), it would be interpolated raw into ClickHouse SQL. The `threshold` is a `Number` from Zod so it is safe, but the `metric` string has no sanitization at the query-building boundary. |
| **Recommended fix** | Add a guard in `buildBreachQuery()` itself: validate each `rule.metric` against `METRIC_REGISTRY[pipelineType]` and reject or skip any metric not in the allowlist. Defense in depth -- the query builder should never trust its inputs blindly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

### F-02: Studio `GOVERNANCE_METRICS` completely mismatches runtime `METRIC_REGISTRY`

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**        | CRITICAL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Dimension**       | 3 -- Serialization (contract mismatch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Affected file**   | `apps/studio/src/lib/governance-contracts.ts:196-213` vs `packages/database/src/models/governance-policy.model.ts:8-20`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Description**     | The Studio UI presents metric names like `quality_score`, `relevance_score`, `coherence_score` for `quality_evaluation`, while the runtime `METRIC_REGISTRY` defines `overall_score`, `helpfulness`, `accuracy`. **Every single metric name differs.** Additionally, the Studio uses `sentiment_detection` as a pipeline type, while the runtime uses `sentiment_analysis`. If a user creates a policy via the Studio UI using the Studio-defined metric names, the runtime will reject it with a 400 validation error because those metrics are not in `METRIC_REGISTRY`. This means the entire policy creation flow from Studio is effectively broken for any user who selects metrics from the Studio dropdown. |
| **Recommended fix** | Either (a) make Studio import the canonical `METRIC_REGISTRY` from a shared package, or (b) update `GOVERNANCE_METRICS` in Studio to exactly mirror `METRIC_REGISTRY`. Also rename `sentiment_detection` to `sentiment_analysis` in the Studio pipeline types list.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

### F-03: Missing `projectId` in `GovernancePolicyVersion.deleteMany` (delete handler)

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | HIGH                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Dimension**       | 2 -- Writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Affected file**   | `apps/runtime/src/routes/governance.ts:531`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Description**     | The DELETE `/policies/:policyId` handler cleans up version snapshots with `GovernancePolicyVersion.deleteMany({ tenantId, policyId: req.params.policyId })`. The query is missing `projectId`. While `policyId` is a UUIDv7 (collision-free) and `tenantId` prevents cross-tenant access, the missing `projectId` violates the platform's project-isolation invariant. If the governance feature were extended to allow cross-project policy sharing, this would become an exploitable gap. |
| **Recommended fix** | Add `projectId` to the filter: `GovernancePolicyVersion.deleteMany({ tenantId, projectId, policyId: req.params.policyId })`.                                                                                                                                                                                                                                                                                                                                                                |

---

### F-04: Missing `projectId` in `GovernancePolicyVersion.findOne` (thresholdAtTime resolution)

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | HIGH                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Dimension**       | 4 -- Read Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Affected file**   | `apps/runtime/src/services/governance-audit.service.ts:225-230`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Description**     | The thresholdAtTime resolution query uses `GovernancePolicyVersion.findOne({ tenantId, policyId: { $in: policyIds }, createdAt: { $lte: ... } })` without `projectId`. This could theoretically read a policy version from a different project within the same tenant, producing an incorrect `thresholdAtTime` value. The `policyIds` are already scoped to the current project's policies, which mitigates this, but the query itself does not enforce project isolation at the DB level. |
| **Recommended fix** | Add `projectId` to the filter: `GovernancePolicyVersion.findOne({ tenantId, projectId, policyId: { $in: policyIds }, ... })`.                                                                                                                                                                                                                                                                                                                                                               |

---

### F-05: Swallowed catch in thresholdAtTime resolution

| Field               | Value                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | HIGH                                                                                                                                                                                                                                                                                                                                        |
| **Dimension**       | 4 -- Read Paths                                                                                                                                                                                                                                                                                                                             |
| **Affected file**   | `apps/runtime/src/services/governance-audit.service.ts:238`                                                                                                                                                                                                                                                                                 |
| **Description**     | Line 238 has `} catch { // thresholdAtTime falls back to current threshold }`. This empty catch swallows all errors silently, violating the "no swallowed catches" invariant in CLAUDE.md. A database connection error, a tenant isolation violation, or an ObjectId cast error would all be silently ignored, making diagnosis impossible. |
| **Recommended fix** | Log the error: `} catch (err) { log.warn('thresholdAtTime resolution failed', { error: err instanceof Error ? err.message : String(err), policyIds }); }`.                                                                                                                                                                                  |

---

### F-06: Module-level singleton `GovernanceAuditService` holds no state but breaks DI pattern

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Dimension**       | 7 -- Dep Wiring                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Affected file**   | `apps/runtime/src/routes/governance.ts:48`                                                                                                                                                                                                                                                                                                                                                                                              |
| **Description**     | `const auditService = new GovernanceAuditService()` is created at module load time as a singleton. The class currently holds no state, so this is safe. However, `GovernanceStatusService` is created per-request via `getGovernanceStatusService()` with a fresh cache instance. The inconsistency means that if `GovernanceAuditService` were later given state (e.g., a cache), the singleton pattern would leak cross-tenant state. |
| **Recommended fix** | Either make both per-request (preferred for consistency) or document the stateless invariant on `GovernanceAuditService` with a comment.                                                                                                                                                                                                                                                                                                |

---

### F-07: `GovernanceStatusService` creates new `GovernanceCache` per request

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Dimension**       | 7 -- Dep Wiring                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Affected file**   | `apps/runtime/src/routes/governance.ts:43-46`, `apps/runtime/src/routes/governance-frameworks.ts:25-26`                                                                                                                                                                                                                                                                                                                     |
| **Description**     | Both the `/status` and `/frameworks` handlers call `GovernanceCache.create()` per request, which calls `getRedisClient()` each time. While `getRedisClient()` likely returns a shared connection, the `GovernanceCache` wrapper is a new object per request. The `/frameworks` handler also creates a new `GovernanceStatusService` per request. This is not incorrect but adds unnecessary allocation overhead under load. |
| **Recommended fix** | Create the `GovernanceCache` once at module init (lazy singleton pattern).                                                                                                                                                                                                                                                                                                                                                  |

---

### F-08: Cache invalidation race in policy update

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Severity**        | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Dimension**       | 8 -- Parallel Paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Affected file**   | `apps/runtime/src/routes/governance.ts:425-482`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Description**     | The PUT `/policies/:policyId` handler uses optimistic concurrency (`version` check) for the policy update, which is good. However, between the successful update (line 425) and cache invalidation (line 482), a concurrent `/status` request could read stale data from cache, compute status with the old policy rules, and cache that stale result again. The window is small (the version snapshot creation + cache invalidation), but under high concurrency it could serve stale governance status for up to `GOVERNANCE_STATUS_CACHE_TTL_SECONDS` (default 300s). |
| **Recommended fix** | Invalidate cache _before_ returning the response, or use a cache version tag that the status service checks. The current code already invalidates before responding (line 482), so the window is only during the version snapshot creation. Consider invalidating _immediately_ after the `findOneAndUpdate` succeeds, before the version snapshot, to minimize the window.                                                                                                                                                                                              |

---

### F-09: No cross-tenant isolation test for override creation or policy mutation

| Field               | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Dimension**       | 9 -- Regression Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Affected file**   | `apps/runtime/src/__tests__/contracts/governance-policies.contract.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Description**     | The contract test includes one cross-tenant test (line 337) for `GET /status` returning 403/404 for a wrong project. However, there are no cross-tenant tests for: (a) creating a policy in another project, (b) updating a policy belonging to another project, (c) deleting a policy in another project, (d) creating an override in another project, (e) accessing audit events from another project. The existing test also only verifies the status code, not that zero data leaks. |
| **Recommended fix** | Add contract tests that attempt CRUD operations on policies/overrides using a token scoped to Project A against Project B's endpoints. Verify 404 responses with no data leakage.                                                                                                                                                                                                                                                                                                        |

---

## Dimension-by-Dimension Trace

### D1: Source

| Value            | Entry Point                                                                    | Notes                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenantId`       | `req.tenantContext.tenantId` (set by `authMiddleware` + `requireProjectScope`) | Derived from JWT/API key, not user input. Safe.                                                                                              |
| `projectId`      | `req.params.projectId` (URL path param)                                        | Validated by `requireProjectScope` middleware which checks it against tenant context. Safe.                                                  |
| `threshold`      | `req.body.rules[].threshold` (user input)                                      | Validated by Zod as `z.number().finite()`. Safe.                                                                                             |
| `justification`  | `req.body.justification` (user input)                                          | Validated by Zod as `z.string().min(1).max(500)`. Stored as-is. No XSS risk in API-only context but could be rendered unsanitized in Studio. |
| `metric`         | `req.body.rules[].metric` (user input)                                         | Validated against `METRIC_REGISTRY` at create/update time. **Not re-validated at query time** (F-01).                                        |
| Audit event data | Computed from ClickHouse query results + MongoDB policy rules                  | Derived, not direct user input.                                                                                                              |

### D2: Writes

| Write Operation                        | tenantId     | projectId          | Notes                                                                                 |
| -------------------------------------- | ------------ | ------------------ | ------------------------------------------------------------------------------------- |
| `GovernancePolicy.create()`            | Yes          | Yes                | Correct                                                                               |
| `GovernancePolicy.findOneAndUpdate()`  | Yes          | Yes                | Correct, with version check                                                           |
| `GovernancePolicy.deleteOne()`         | Yes          | Yes                | Correct                                                                               |
| `GovernancePolicyVersion.create()`     | Yes          | Yes                | Correct                                                                               |
| `GovernancePolicyVersion.deleteMany()` | Yes          | **NO** (F-03)      | Missing `projectId`                                                                   |
| `GovernanceOverride.create()`          | Yes          | Yes                | Correct                                                                               |
| Redis cache `set()`                    | Yes (in key) | Yes (in key)       | Key: `governance:status:{tenantId}:{projectId}:{period}`                              |
| `writeAuditLog()`                      | Yes          | No (metadata only) | `writeAuditLog` is fire-and-forget; projectId is in metadata but not a required field |

### D3: Serialization

- **Zod validation:** All request bodies use strict Zod schemas (`CreatePolicyBodySchema`, `UpdatePolicyBodySchema`, `CreateOverrideBodySchema`). Correct.
- **Mongoose schemas:** All 3 models have `required: true` on `tenantId` and `projectId`. Correct.
- **ClickHouse parameterization:** `tenantId`, `projectId`, `days` use parameterized queries (`{tenantId:String}`, `{projectId:String}`, `{days:UInt32}`). **But `metric` is interpolated raw** (F-01).
- **Response serialization:** `.lean()` on Mongoose queries strips Mongoose internals. `.toObject()` on create. Both are safe.
- **Contract mismatch:** Studio metric names diverge from runtime (F-02).

### D4: Read Paths

| Read Query                                                              | tenantId    | projectId     | Notes               |
| ----------------------------------------------------------------------- | ----------- | ------------- | ------------------- |
| `GovernancePolicy.find({ tenantId, projectId })` (list)                 | Yes         | Yes           | Correct             |
| `GovernancePolicy.findOne({ _id, tenantId, projectId })` (get)          | Yes         | Yes           | Correct             |
| `GovernancePolicy.find({ tenantId, projectId, status })` (status/audit) | Yes         | Yes           | Correct             |
| `GovernanceOverride.countDocuments({ tenantId, projectId, ... })`       | Yes         | Yes           | Correct             |
| `GovernanceOverride.find({ tenantId, projectId, ... })` (merge)         | Yes         | Yes           | Correct             |
| `GovernancePolicyVersion.countDocuments({ tenantId, projectId })`       | Yes         | Yes           | Correct             |
| `GovernancePolicyVersion.findOne({ tenantId, ... })` (thresholdAtTime)  | Yes         | **NO** (F-04) | Missing `projectId` |
| ClickHouse queries                                                      | Yes (param) | Yes (param)   | Correct             |

### D5: Policy Boundary

| Endpoint                          | Auth Middleware                          | Permission Check                                                        | Notes   |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | ------- |
| `GET /status`                     | `authMiddleware` + `requireProjectScope` | `requireProjectWideAnalyticsAccess` (analytics:read)                    | Correct |
| `GET /audit`                      | Same                                     | `requireGovernanceReadAccess` (analytics:read OR governance:audit-read) | Correct |
| `POST /audit/:eventRef/override`  | Same                                     | `requireProjectPermission(governance:write)`                            | Correct |
| `GET /report.csv`                 | Same                                     | `requireGovernanceReadAccess`                                           | Correct |
| `GET /report.pdf`                 | Same                                     | `requireGovernanceReadAccess`                                           | Correct |
| `GET /frameworks`                 | Same (inherited)                         | `requireProjectWideAnalyticsAccess`                                     | Correct |
| `GET /policies`                   | Same                                     | `requireProjectWideAnalyticsAccess`                                     | Correct |
| `POST /policies`                  | Same                                     | `requireProjectPermission(governance:write)`                            | Correct |
| `GET /policies/:policyId`         | Same                                     | `requireProjectWideAnalyticsAccess`                                     | Correct |
| `PUT /policies/:policyId`         | Same                                     | `requireProjectPermission(governance:write)`                            | Correct |
| `DELETE /policies/:policyId`      | Same                                     | `requireProjectPermission(governance:write)`                            | Correct |
| Studio proxy `[...path]/route.ts` | `requireTenantAuth`                      | Delegates to runtime (proxied auth header)                              | Correct |

All endpoints have auth + project permission checks. The `requireProjectScope` middleware on the router enforces `concealOutOfScope: true` (returns 404 for wrong project). The Studio proxy passes through the `Authorization` header and `X-Tenant-Id`.

### D6: Consumers/Sinks

| Sink                   | Data Exposed                                       | Risk                                             |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ |
| Studio UI (JSON)       | Policy names, rules, thresholds, audit events      | Low -- rendered in React, no raw HTML injection  |
| CSV export             | All audit event fields including justification     | Low -- `papaparse.unparse` handles CSV escaping  |
| PDF export             | Audit event summaries                              | Low -- `pdfkit` text rendering, no HTML          |
| Redis cache            | Full `GovernanceStatusData` as JSON string         | Low -- key scoped by `tenantId:projectId:period` |
| `writeAuditLog()`      | action, userId, tenantId, resourceId, resourceType | Low -- internal audit log, not user-facing       |
| ClickHouse (read-only) | Query results scoped by tenant_id + project_id     | Low -- parameterized queries                     |
| Trace events           | Aggregate counts (policyCount, passCount, etc.)    | Low -- no PII, no thresholds                     |

### D7: Dep Wiring

- **GovernanceAuditService:** Module-level singleton, stateless (F-06). Safe but inconsistent.
- **GovernanceStatusService:** Per-request with per-request `GovernanceCache` (F-07). Safe but wasteful.
- **GovernanceReportService:** Per-request, receives `auditService` via constructor. Correct DI pattern.
- **GovernanceCache:** Uses `getRedisClient()` which returns a shared connection. The cache wrapper itself is stateless (just holds a reference). Safe.
- **ClickHouse client:** Lazy-imported via `@agent-platform/database/clickhouse`. Singleton pattern. Safe.
- **Semaphore:** Per-request `new Semaphore(4)`. Correct -- no cross-request state.

### D8: Parallel Paths

- **Optimistic concurrency on policy update:** Uses `version` field with atomic `findOneAndUpdate({ version: original.version })`. Correct.
- **Cache invalidation race:** Small window between DB update and cache invalidation (F-08).
- **Compensating restore on version snapshot failure:** If `GovernancePolicyVersion.create()` fails after `GovernancePolicy.findOneAndUpdate()` succeeds, the handler attempts to restore the original policy. If the restore also fails, it logs an error. This is a reasonable best-effort approach.
- **Concurrent ClickHouse fan-out:** Semaphore(4) limits concurrency. All queries are read-only. Safe.

### D9: Regression Tests

| Coverage Area                              | Test File                                  | Covered?              |
| ------------------------------------------ | ------------------------------------------ | --------------------- |
| Rule evaluation (5 operators)              | `governance-unit.test.ts`                  | Yes                   |
| Agent status computation (all branches)    | `governance-unit.test.ts`                  | Yes                   |
| Breach query SQL structure                 | `governance-unit.test.ts`                  | Yes                   |
| Framework evaluators (SOC2/GDPR/EU_AI_ACT) | `governance-unit.test.ts`                  | Yes                   |
| Cache fail-open (null redis)               | `governance-unit.test.ts`                  | Yes                   |
| Policy CRUD contract shapes                | `governance-policies.contract.test.ts`     | Yes                   |
| Status endpoint contract shape             | `governance-policies.contract.test.ts`     | Yes                   |
| Audit endpoint contract shape              | `governance-policies.contract.test.ts`     | Yes                   |
| Frameworks endpoint contract shape         | `governance-policies.contract.test.ts`     | Yes                   |
| Cross-project isolation (GET /status)      | `governance-policies.contract.test.ts:337` | Partial (status only) |
| Cross-project isolation (CRUD)             | --                                         | **NO** (F-09)         |
| Override creation contract                 | --                                         | **NO**                |
| CSV/PDF export contract                    | --                                         | **NO**                |
| Metric validation rejection                | --                                         | **NO**                |
| Concurrent update conflict (409)           | --                                         | **NO**                |

---

## Boundary Coverage Table

| API Endpoint                           | Auth | Tenant Isolation | Project Isolation               | Zod Validation | Contract Test | Cross-Tenant Test |
| -------------------------------------- | ---- | ---------------- | ------------------------------- | -------------- | ------------- | ----------------- |
| `GET /governance/status`               | Yes  | Yes              | Yes                             | N/A (no body)  | Yes           | Yes (partial)     |
| `GET /governance/audit`                | Yes  | Yes              | Yes                             | N/A (no body)  | Yes           | No                |
| `POST /governance/audit/:ref/override` | Yes  | Yes              | Yes                             | Yes            | No            | No                |
| `GET /governance/report.csv`           | Yes  | Yes              | Yes                             | N/A            | No            | No                |
| `GET /governance/report.pdf`           | Yes  | Yes              | Yes                             | N/A            | No            | No                |
| `GET /governance/frameworks`           | Yes  | Yes              | Yes                             | N/A            | Yes           | No                |
| `GET /governance/policies`             | Yes  | Yes              | Yes                             | N/A            | Yes           | No                |
| `POST /governance/policies`            | Yes  | Yes              | Yes                             | Yes            | Yes           | No                |
| `GET /governance/policies/:id`         | Yes  | Yes              | Yes                             | N/A            | Yes           | No                |
| `PUT /governance/policies/:id`         | Yes  | Yes              | Yes                             | Yes            | Yes           | No                |
| `DELETE /governance/policies/:id`      | Yes  | Yes              | Yes (main) / Partial (versions) | N/A            | Yes           | No                |

---

## Remediation Priority

| Priority | Finding                                    | Effort                         | Impact                                    |
| -------- | ------------------------------------------ | ------------------------------ | ----------------------------------------- |
| 1        | F-02 (metric registry mismatch)            | Low -- update Studio constants | Blocks all policy creation from Studio UI |
| 2        | F-01 (SQL injection in buildBreachQuery)   | Low -- add allowlist check     | Prevents potential ClickHouse injection   |
| 3        | F-03 (missing projectId in version delete) | Trivial -- add field to query  | Enforces project isolation invariant      |
| 4        | F-04 (missing projectId in version read)   | Trivial -- add field to query  | Enforces project isolation invariant      |
| 5        | F-05 (swallowed catch)                     | Trivial -- add log statement   | Improves debuggability                    |
| 6        | F-09 (missing cross-tenant tests)          | Medium -- add test cases       | Prevents isolation regressions            |
| 7        | F-06 (singleton inconsistency)             | Low -- add comment or refactor | Code hygiene                              |
| 8        | F-07 (per-request cache allocation)        | Low -- lazy singleton          | Performance optimization                  |
| 9        | F-08 (cache invalidation race)             | Low -- reorder invalidation    | Reduces stale data window                 |
