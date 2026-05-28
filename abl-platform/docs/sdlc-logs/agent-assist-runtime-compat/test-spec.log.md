# Test Spec Oracle Log: Agent Assist Runtime Compat

**Feature**: agent-assist-runtime-compat
**JIRA**: ABLP-390
**Phase**: Test Spec (Phase 2)
**Date**: 2026-04-22
**Oracle**: product-oracle

---

## Context Consulted

- `docs/testing/agent-assist-runtime-compat.md` (existing testing guide)
- `docs/features/agent-assist-runtime-compat.md` (feature spec, FR-1 through FR-31)
- `docs/poc/agent-assist-runtime-compat-poc-reference.md` (POC reference)
- `docs/sdlc/test-spec-playbook.md` (template mandatory sections)
- `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts` (POC route tests)
- `apps/runtime/src/__tests__/services/agent-assist/` (4 POC unit test files)
- `CLAUDE.md` (test architecture, E2E standards)

## Classification Summary

| Question | Classification | Confidence |
| -------- | -------------- | ---------- |
| A1       | ANSWERED       | HIGH       |
| A2       | ANSWERED       | HIGH       |
| A3       | ANSWERED       | HIGH       |
| A4       | INFERRED       | HIGH       |
| A5       | ANSWERED       | HIGH       |
| B1       | ANSWERED       | HIGH       |
| B2       | DECIDED        | HIGH       |
| B3       | ANSWERED       | HIGH       |
| B4       | ANSWERED       | HIGH       |
| C1       | ANSWERED       | HIGH       |
| C2       | ANSWERED       | HIGH       |
| C3       | ANSWERED       | HIGH       |
| C4       | ANSWERED       | HIGH       |
| D1       | ANSWERED       | HIGH       |
| D2       | DECIDED        | HIGH       |
| D3       | DECIDED        | HIGH       |
| E1       | ANSWERED       | HIGH       |
| E2       | ANSWERED       | MEDIUM     |
| E3       | DECIDED        | MEDIUM     |
| F1       | ANSWERED       | HIGH       |
| F2       | DECIDED        | MEDIUM     |

## Decisions Made

| #   | Decision                                                                                              | Rationale                                        | Risk |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| D-1 | Add E2E-6 for kill-switch/feature-gate off                                                            | Safety-critical path deserves named E2E scenario | Low  |
| D-2 | List 4 new Phase Actual unit test files (binding-repo, callback-worker, v1-sse-emitter, admin routes) | Template requires forward-looking unit plan      | Low  |
| D-3 | Log HMAC rotation as Open Item, not mandatory                                                         | Operational edge case for BETA gate              | Low  |
| D-4 | POC tests need permission + source tag updates                                                        | FR-11 and FR-30 changed contract from POC        | Low  |

## Escalations

None -- all questions resolved from existing docs/code/patterns.

## Gaps Identified (12 total)

1. FR-11 missing as distinct matrix row
2. E2E scenarios not in template structured format (Preconditions/Steps/Expected/Auth/Isolation)
3. No E2E-6 for kill-switch off
4. No explicit relative callbackUrl rejection scenario
5. No Phase Actual unit test plan (only POC inventory)
6. Security section not in checkbox format; missing cross-user + insufficient-perms checks
7. No Critical Feature Gate Coverage subsection
8. No Test Infrastructure section
9. No Phase Actual test file mapping
10. No HMAC rotation open item
11. \_agentAssist metadata field assertions not enumerated
12. No Surface Semantics N/A declaration

---

## Phase-Auditor Round 1

**Date**: 2026-04-22
**Auditor**: phase-auditor
**Verdict**: APPROVED (with HIGH/MEDIUM items to fix in Round 2)

### CRITICAL

None. All 31 FRs (FR-1 through FR-31) are present in the coverage matrix. 7 E2E scenarios and 5 integration scenarios are fully structured with Preconditions/Steps/Expected/Auth/Isolation. No `vi.mock` of internal packages. No direct Mongoose access in E2E scenarios. E2E standards compliance is strong.

### HIGH

1. **[TS-9] Section 10 cross-reference error: "section 9 bit-flip check" does not exist.** Line 343 says HMAC bit-flip is verified in "section 9" but section 9 is the Load Test Plan -- no bit-flip assertion there. The bit-flip check should either be (a) added as an explicit sub-step in E2E-4, or (b) moved to a named unit test in section 6 / file mapping, with the section 10 reference corrected.
   - Location: line 343
   - Fix: Add a bit-flip sub-step to E2E-4 (step 5: "mutate one byte of the callback body and re-verify HMAC -- must reject") and update the section 10 reference to cite "E2E-4 step 5".

2. **[TS-9] INT-4 assumes supertest harness for Next.js App Router route handlers.** Line 249 says "Next.js route handlers mounted in a supertest harness" but Next.js App Router handlers (`app/api/.../route.ts` exporting `GET`/`POST`/`PATCH`/`DELETE`) are not Express middleware and cannot be directly mounted in supertest. The integration test must either (a) use `next/test-server` or a custom adapter, or (b) explicitly document that the handlers are tested via the `next dev` server on a random port with real HTTP calls.
   - Location: line 249 (INT-4)
   - Fix: Clarify the test harness approach -- either "start Next.js test server on `port: 0` and issue real HTTP requests" (consistent with E2E standards) or document a specific adapter pattern for testing App Router handlers in isolation.

3. **[TS-7] E2E-3 heartbeat timing is unreliable as specified.** Line 161 says "DI LLM double configured to emit >= 4 token chunks with 3-second gap between chunks 2 and 3 so the 15s heartbeat fires" but a 3-second gap cannot trigger a 15-second heartbeat. Section 11 env vars (line 373) shorten `AGENT_ASSIST_SSE_HEARTBEAT_MS=500` for tests, which would work with a 3-second gap, but E2E-3's preconditions do not mention this env var override.
   - Location: line 161 (E2E-3 Preconditions)
   - Fix: Add to E2E-3 preconditions: "env `AGENT_ASSIST_SSE_HEARTBEAT_MS=500` (shortened per section 11)" and adjust the gap timing description to match.

### MEDIUM

4. **[TS-8] Section 11 data seeding uses `seedBinding(db, ...)` which implies direct DB writes.** For E2E tests, CLAUDE.md requires seeding via POST endpoints. Section 11's `seedBinding` helper writing directly to `agent_assist_bindings` is acceptable for integration tests (INT-2, INT-3) but E2E scenarios (E2E-1 through E2E-7) should seed bindings via the Admin API `POST /api/tenants/:tenantId/agent-assist/bindings`.
   - Location: lines 358-363 (section 11 Data seeding)
   - Fix: Add a note distinguishing E2E seeding (via Admin API POST) from integration seeding (via direct `seedBinding` helper). Or add an `seedBindingViaAdminAPI(httpClient, ...)` helper alongside the direct one.

5. **[TS-10] Section 12 maps INT-4 to `apps/admin/src/__tests__/routes/agent-assist-bindings.int.test.ts` but admin tests currently live flat in `apps/admin/src/__tests__/` (no `routes/` subdirectory).** The `routes/` subdirectory would need to be created. Not blocking but the naming convention should match existing admin test patterns.
   - Location: line 390 (section 12 file mapping)
   - Fix: Either use the existing flat pattern (`apps/admin/src/__tests__/agent-assist-bindings.int.test.ts`) or note that the `routes/` subdirectory is new and intentional.

6. **[TS-10] Section 13 Open Items missing concurrent-session race -- but it IS present.** Item 5 (line 408) covers "Concurrent `/sessions` races" which satisfies the requirement. However, item 5's wording says "Need a race test asserting no duplicate sessions in the DB" which implies direct DB assertion in what should be an E2E-style check. Reword to assert via API response consistency.
   - Location: line 408 (section 13 item 5)
   - Fix: Reword to "assert via two concurrent `/runs/execute` requests that both return the same `sessionId` and no HTTP 5xx" rather than "no duplicate sessions in the DB".

### Cross-Phase Consistency

- [XP-1] PASS -- All FRs trace back to feature spec section 4
- [XP-2] PASS -- Scenarios are detailed enough to enable HLD and implementation
- [XP-3] PASS -- No new scope introduced beyond the feature spec
- [XP-4] PASS -- Terminology consistent (`logAdminAction`, `agent_assist_v1`, `APP_NOT_FOUND`, `session:send_message` all match feature spec)
- [XP-5] PASS -- Prior audit finding about `auditLogStore.write` being invented has been corrected; test spec uses `logAdminAction` throughout

### Verified

- [x] TS-1 -- 7 E2E scenarios (exceeds minimum 5)
- [x] TS-2 -- 5 integration scenarios (meets minimum 5)
- [x] TS-3 -- All 31 FRs appear in coverage matrix
- [x] TS-4 -- No `vi.mock` of internal packages; explicit "no mocks" declaration at line 135
- [x] TS-5 -- Cross-tenant 404 (E2E-2), missing-auth 401 (section 3.2 FR-10), insufficient-perms 403 (section 3.2 FR-11), immutable-field PATCH rejection (INT-4), byte-identical 404 bodies (E2E-6, section 5.3)
- [x] TS-6 -- Every E2E scenario specifies auth context with tenant + project + key
- [x] TS-8 -- Section 11 names all required services, data seeding helpers, env vars, CI config
- [x] TS-10 -- Consistent with feature spec FRs; no invented requirements
- [x] Section 5.3 feature-gate matrix: four 404 cases listed as byte-identical (kill-switch, feature-gate, binding-disabled, cross-tenant)
- [x] Section 9 load test plan has measurable p50/p95/error-rate/delivery-rate gates
- [x] Section 13 includes both HMAC secret rotation (item 1) and concurrent-session race (item 5)
- [x] Prior R2 audit finding resolved: `logAdminAction` used correctly, no `auditLogStore.write` references

### Notes for Round 2

Focus areas: (1) section 10 bit-flip cross-reference fix, (2) INT-4 Next.js test harness clarification, (3) E2E-3 heartbeat timing + env var alignment, (4) E2E seeding via Admin API vs direct DB

---

## Phase-Auditor Round 2

**Date**: 2026-04-22
**Auditor**: phase-auditor
**Verdict**: APPROVED

### Round 1 Fix Verification

All 3 HIGH and 3 MEDIUM findings from Round 1 are resolved:

1. **[TS-9] Bit-flip cross-reference** -- FIXED. E2E-4 now has an explicit step 5 ("Bit-flip check -- take the recorded callback body, mutate exactly one byte, and re-run HMAC verification. Assert verification fails"). Section 10 line 344 references "E2E-4 step 5". No dangling "section 9" reference remains.
2. **[TS-9] INT-4 supertest wording** -- FIXED. INT-4 (line 251) now says "Start a Next.js test server on `port: 0`... Issue REAL HTTP requests -- App Router handlers are not compatible with Express supertest middleware, so we go through the full Next.js handler pipeline." Remaining "supertest" mentions at lines 4, 12, 22 are factual POC history, not test plan prescriptions.
3. **[TS-7] E2E-3 heartbeat env var** -- FIXED. E2E-3 preconditions (line 160) now include `AGENT_ASSIST_SSE_HEARTBEAT_MS=500` and LLM gap changed to 600 ms (consistent with 500 ms heartbeat interval).
4. **[TS-8] E2E seeding** -- FIXED. Section 11 (line 362) documents `seedBindingViaAdminAPI(httpClient, {...})` for E2E tests and `seedBinding(db, {...})` for integration-only, with explicit guidance on which to use where.
5. **[TS-10] Admin file path** -- FIXED. Section 12 (line 392) uses flat `apps/admin/src/__tests__/agent-assist-bindings.int.test.ts` matching existing admin test layout.
6. **[TS-10] Open item 5 wording** -- FIXED. Line 410 now reads "both requests return the same `sessionId` with no HTTP 5xx and no duplicate trace `agent_assist.delegated` events for different session ids" -- HTTP-observable, no direct DB assertion.

### CRITICAL

None.

### HIGH

None.

### MEDIUM (logged, not blocking)

1. **[TS-5] Four-way byte-identical 404 not explicitly asserted in one place.** Section 5.3 claims byte-identical bodies across four cases (kill-switch off, feature-gate off, binding disabled, cross-tenant). E2E-6 explicitly compares (a) vs (b) and states "body is identical to a cross-tenant 404" in prose, but no single test step collects all four bodies and asserts byte-equality across the set. The binding-disabled 404 is only in the coverage matrix row (section 3.2 FR-12), not in a named E2E scenario. Recommendation: during implementation, the E2E file covering E2E-6 should add a sub-assertion comparing all four 404 bodies in a single test, or add a dedicated parameterized test.

### Fresh-Eyes Pass

- Section numbering 1-13 is contiguous with no gaps or duplicates.
- All 12 scenario IDs (E2E-1 through E2E-7, INT-1 through INT-5) are defined in section 5 and every reference in section 12's file mapping table points to a valid ID.
- No dangling section references found (grep for "section" confirms all point to valid sections).
- No `vi.mock` or `jest.mock` of internal packages anywhere in the spec.
- No `auditLogStore` references remain (prior feature-spec audit finding fully resolved).
- No direct Mongoose access prescribed in E2E scenarios.
- `logAdminAction` from `apps/admin/src/lib/audit-logger.ts` used consistently (lines 118, 129, 251, 254).
- Admin route paths use `/api/tenants/:tenantId/...` (no erroneous `/api/admin/` prefix -- prior feature-spec audit finding resolved).

### Cross-Phase Consistency

- [XP-1] PASS -- All FRs trace to feature spec section 4
- [XP-2] PASS -- Scenarios enable HLD and implementation
- [XP-3] PASS -- No new scope beyond feature spec
- [XP-4] PASS -- Terminology consistent across feature spec and test spec
- [XP-5] PASS -- Prior audit learnings (auditLogStore.write, admin path prefix, Next.js not Express) all reflected

### Verified

- [x] TS-1 -- 7 E2E scenarios (exceeds minimum 5)
- [x] TS-2 -- 5 integration scenarios (meets minimum 5)
- [x] TS-3 -- All 31 FRs in coverage matrix
- [x] TS-4 -- No vi.mock of internal packages
- [x] TS-5 -- Isolation tests present (cross-tenant, cross-project, missing auth, insufficient perms, byte-identical 404s)
- [x] TS-6 -- Every E2E scenario has auth context
- [x] TS-7 -- Failure paths covered (INT-1 deployment-resolve failure, INT-3 retry+DLQ, INT-4 audit-fail-closed, INT-5 endSession-throws, E2E-7 invalid URLs)
- [x] TS-8 -- Infrastructure documented (services, seeding, env vars, CI)
- [x] TS-9 -- File paths realistic, flat admin layout matches existing patterns
- [x] TS-10 -- Scenarios match feature spec FRs, no invented requirements
- [x] Round 1 HIGH findings 1-3 all resolved
- [x] Round 1 MEDIUM findings 4-6 all resolved
- [x] No regressions introduced by fixes
