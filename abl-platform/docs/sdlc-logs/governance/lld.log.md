# LLD Log: Agent Governance Dashboard

**Date**: 2026-04-29
**Phase**: LLD (Phase 4)
**Artifact**: `docs/plans/2026-04-29-governance-impl-plan.md`
**Status**: COMPLETE

---

## Oracle Decisions (15 Questions)

| #   | Question                          | Decision                                                                                                      |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | Implementation order              | Data layer → API → Studio UI; Phase 0 first for pipeline summary extraction                                   |
| Q2  | getPipelineSummary extraction     | Phase 0: create `pipeline-analytics-summary.service.ts`; returns both SQL string + executor                   |
| Q3  | governance-contracts.ts location  | `apps/runtime/src/routes/governance-contracts.ts` — no existing contracts pattern in codebase                 |
| Q4  | RBAC scopes additions             | developer: +governance:write + analytics:read; tester/viewer: +governance:audit-read; viewer: +analytics:read |
| Q5  | requireGovernanceReadAccess       | Added to `rbac.ts` as exported function (sendRuntimeAccessDenied is private)                                  |
| Q6  | GovernanceCache location          | `apps/runtime/src/services/cache/governance-cache.ts` (mirrors embedding-cache.ts)                            |
| Q7  | Dynamic import for cascade-delete | Yes, per packages/database/agents.md pattern                                                                  |
| Q8  | pdfkit installation               | `pnpm add pdfkit papaparse` + `@types/pdfkit @types/papaparse` in apps/runtime                                |
| Q9  | Route mount location              | server.ts after pipelineAnalyticsRouter (~L1118); behind GOVERNANCE_ENABLED env var kill switch               |
| Q10 | Biggest risk                      | Phase 0 extraction from 901-line pipeline-analytics.ts                                                        |
| Q11 | Contract tests location           | `apps/runtime/src/__tests__/contracts/governance-*.contract.test.ts`                                          |
| Q12 | E2E cache busting                 | GOVERNANCE_STATUS_CACHE_TTL_SECONDS=5 (no test-only code paths)                                               |
| Q13 | Studio contracts import           | Local type-mirror in `apps/studio/src/lib/governance-contracts.ts` for MVP                                    |
| Q14 | Override teardown in E2E-13       | Fresh project per test case (API-only, no DELETE override endpoint)                                           |
| Q15 | Policy version atomicity          | findOneAndUpdate with version-check filter + compensating restore (no MongoDB transactions)                   |

---

## Audit Rounds Summary

### Round 1 (lld-reviewer — architecture compliance): NEEDS_REVISION → FIXED

| Finding                                                     | Severity | Resolution                                                                               |
| ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| developer role lacks analytics:read                         | CRITICAL | Added analytics:read to developer in Task 0.3                                            |
| i18n path wrong (`apps/studio/src/i18n/messages/en.json`)   | CRITICAL | Fixed to `packages/i18n/locales/en/studio.json`                                          |
| Express route ordering ambiguous                            | HIGH     | Added explicit ordered list in Task 2.5 (11 routes in static-before-parameterized order) |
| Frameworks sub-router `router.use('/', ...)` shadowing risk | HIGH     | Changed to `router.use('/frameworks', ...)`                                              |
| cascade-delete missing config-vs-audit distinction          | HIGH     | Added note: governance models are config data, deleteMany correct                        |
| sendRuntimeAccessDenied not exported                        | NOTE     | requireGovernanceReadAccess moved to rbac.ts as exported function                        |

### Round 2 (lld-reviewer — pattern consistency): NEEDS_REVISION → FIXED

| Finding                                                      | Severity | Resolution                                                             |
| ------------------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| `validateBody` doesn't exist in runtime                      | CRITICAL | Replaced with inline `schema.safeParse(req.body)` pattern              |
| `z.enum([...Set])` TypeScript error                          | CRITICAL | Fixed: `as [string, ...string[]]` type assertion                       |
| Wiring checklist contradicts Task 4.4                        | HIGH     | Fixed checklist to use `/frameworks` path                              |
| GovernanceCache pattern divergence from AnalyticsCache       | HIGH     | Updated D-3 to document deliberate divergence + SCAN-vs-KEYS rationale |
| Missing `.lean()` on policyVersion/override queries          | MEDIUM   | Added `.lean()` to audit service queries                               |
| Compensating action description wrong ("delete" → "restore") | MEDIUM   | Fixed D-5: compensating restore, not delete                            |

### Round 3 (lld-reviewer — completeness): NEEDS_REVISION → FIXED

| Finding                                        | Severity | Resolution                                                    |
| ---------------------------------------------- | -------- | ------------------------------------------------------------- |
| FR-27 (period URL persistence) no task         | MEDIUM   | Added URL query param sync to Task 6.7                        |
| FR-18 (audit filters) missing AuditFilters.tsx | MEDIUM   | Added AuditFilters.tsx to file map + Task 7.4                 |
| GET /audit missing server-side filter params   | MEDIUM   | Extended getAuditEvents signature with optional filter params |
| Phase 2 modified files list missing rbac.ts    | MEDIUM   | Added to Phase 2 files touched                                |

### Round 4 (phase-auditor — cross-phase consistency): APPROVED with 3 HIGH

| Finding                                          | Severity | Resolution                                                  |
| ------------------------------------------------ | -------- | ----------------------------------------------------------- |
| Acceptance criteria missing E2E-6 through E2E-11 | HIGH     | Added all 11 E2E scenarios to acceptance criteria           |
| "6 operators" should be 5 (gt/gte/lt/lte/eq)     | HIGH     | Fixed to 5 operators in Phase 2 tests + acceptance criteria |
| Phase 8 only scaffolds 5 of 15 E2E scenarios     | HIGH     | Expanded Task 8.5 to cover all 15 E2E scenarios             |

### Round 5 (lld-reviewer — final sweep): APPROVED with 3 MEDIUM

| Finding                                                 | Severity | Resolution                                                             |
| ------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| PDF streaming race (headers sent before timeout fires)  | MEDIUM   | Changed to buffer-first approach: generatePdfBuffer() before res.write |
| No task for .env.example updates                        | MEDIUM   | Added Task 2.0 with all 3 env vars                                     |
| Wiring checklist says validateBody instead of safeParse | MEDIUM   | Fixed wiring checklist entry                                           |
| Viewer role lacks analytics:read                        | NOTE     | Added analytics:read to viewer in Task 0.3                             |

### Round 6 (platform audit): NEEDS_REVISION → FIXED

| Finding                                 | Severity | Resolution                                                                            |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| Missing TraceEvent emission             | HIGH     | Added recordSyntheticTraceEvent to GovernanceStatusService.getStatus()                |
| Concurrent PUT race — no version-check  | HIGH     | Added version-check filter: `{ _id, tenantId, projectId, version: original.version }` |
| tenantIsolationPlugin import path wrong | MEDIUM   | Fixed to `'../mongo/plugins/tenant-isolation.plugin.js'`                              |
| Missing createLogger instruction        | MEDIUM   | Added createLogger to wiring checklist + service tasks                                |

### Round 7 (industry research audit): Findings integrated

| Finding                                                | Severity | Resolution                                                                    |
| ------------------------------------------------------ | -------- | ----------------------------------------------------------------------------- |
| ClickHouse fan-out → max_concurrent_queries exhaustion | RISK     | Added Semaphore(4) from local-semaphore.ts to GovernanceStatusService fan-out |
| pdfkit buffer OOM                                      | RISK     | Added 50MB size check + 413 response after Buffer.concat                      |
| Redis SCAN+DEL non-atomic race                         | RISK     | Documented trade-off; bounded by TTL; acceptable for MVP                      |
| No feature flag kill switch                            | GAP      | Added GOVERNANCE_ENABLED env var to server.ts mount                           |
| No concurrency load test                               | GAP      | Noted as Phase 2 item (k6 scenario)                                           |

### Round 8 (OSS library audit): Findings integrated

| Finding                                             | Action                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Manual CSV silently corrupts embedded commas/quotes | Replaced with papaparse (already in lockfile)                |
| pdfkit correct choice                               | Confirmed: MIT, 2.8M/wk, March 2026, no browser              |
| GovernanceCache SCAN+DEL pattern                    | Directed to copy guardrails cache.ts pattern (lines 156-185) |

---

## Files Created

- `docs/plans/2026-04-29-governance-impl-plan.md` — full LLD (9 phases, ~750 LOC)
- `docs/sdlc-logs/governance/lld.log.md` — this file

## Open Items for Implementation

1. Verify `recordSyntheticTraceEvent` import path from `@agent-platform/trace-store` during Phase 2 implementation (read channel-genesys.ts import for exact module path)
2. Verify `GovernancePage.tsx` stub's `GovernanceTab` type union during Phase 6 — extend from `'registry' | 'compliance'` to all 4 tabs
3. HLD cache path divergence (`apps/runtime/src/cache/` vs `apps/runtime/src/services/cache/`) — update HLD during post-impl-sync
4. External auditor invitation UI (FR-31 scope/permission check implemented; UI flow is Phase 2)
5. MV-backed status queries for 4 pipeline types — Phase 2 performance optimization
