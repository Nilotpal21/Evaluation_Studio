# SDLC Log — Test Spec — SOAP Tool Support

**Feature**: SOAP Tool Support (sub-feature of Tool Invocations)
**Slug**: `soap-tool-support`
**Phase**: Test Spec
**Date**: 2026-04-27
**Author**: Claude Code (Opus 4.7) on behalf of `karthikeya.andhoju@kore.com`

---

## 1. Inputs

- Feature spec: `docs/features/sub-features/soap-tool-support.md` (PLANNED, 13 FRs, 7 user stories — APPROVED through 2 audit rounds during /feature-spec).
- Reference E2E pattern: `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts` (3300 lines; canonical no-mocks Express + MongoMemoryServer + Redis-subprocess harness).
- Reference unit pattern: `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` (3000 lines; exhaustive REST executor coverage).
- WS-Security helper coverage: `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts`.
- `ws_security` auth-profile case coverage: `packages/shared/src/__tests__/auth-profile/apply-auth-phase3.test.ts`.

## 2. Clarifying Questions — Product Oracle Output

15 questions across Test Scope, E2E Scenarios, Integration Boundaries. **Zero AMBIGUOUS items.** All grounded in code reads.

| Section / #                     | Classification | Decision                                                                                                                                                                                         |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1 (high-risk FRs)              | ANSWERED       | FR-5 (envelope wrap + WS-Sec inject), FR-6 (XML parse), FR-7 (fault detect), FR-13 (auth-resolver propagation) confirmed highest risk.                                                           |
| S2 (production SOAP edge cases) | DECIDED        | None known; pre-emptive tests for namespace prefix variation (`soapenv:`, `SOAP-ENV:`, `soap:`), double-wrap detection, SOAP 1.2 `<env:Code>` prefix.                                            |
| S3 (coverage baseline)          | ANSWERED       | Zero SOAP-specific coverage. Existing WS-Sec helper tests + apply-auth phase-3 tests do not cover the executor path.                                                                             |
| S4 (mock vs real)               | DECIDED        | SOAP backend = local Express stub (the "external service"); MongoDB = MongoMemoryServer; Redis = subprocess (matches parent E2E); `applyWsSecurity()` = real (Node crypto).                      |
| S5 (harness)                    | DECIDED        | Reuse the parent E2E full harness (Mongo + Redis + Express wrapping Next.js routes + dev-login + real encryption).                                                                               |
| E1 (E2E count)                  | ANSWERED       | 5–7 happy-path / security / fault scenarios sufficient; SOAP is channel-agnostic so no per-channel variants needed.                                                                              |
| E2 (auth combinations)          | DECIDED        | Mandatory: shared `ws_security` + admin happy path; cross-tenant 404; missing auth 401; oauth2 transport + WS-Sec composition. Nice-to-have: personal-profile visibility; permission denial 403. |
| E3 (cross-feature E2E)          | ANSWERED       | One agent-bound SOAP-tool-through-real-session scenario is the gold-standard validation.                                                                                                         |
| E4 (data seeding)               | INFERRED       | Auth profile + tool DSL + stub backend + (for E3) model connection + agent DSL.                                                                                                                  |
| E5 (load tests)                 | DECIDED        | Defer to `load-test-analysis` / `saturation-finder` skills; not duplicated in this spec.                                                                                                         |
| I1 (integration boundaries)     | INFERRED       | 5 boundaries from question + `fast-xml-parser` hardened-config validation as a 6th explicit boundary.                                                                                            |
| I2 (webhooks / async)           | ANSWERED       | None — SOAP is synchronous request/response.                                                                                                                                                     |
| I3 (isolation)                  | ANSWERED       | Cross-tenant 404, cross-project 404, tenant-scoped profile visibility, tenant-scoped circuit breaker keys.                                                                                       |
| I4 (concurrency)                | DECIDED        | No dedicated concurrency tests — WS-Sec is stateless per call; resilience primitives are per-instance.                                                                                           |
| I5 (failure paths)              | ANSWERED       | Auth-profile-not-found, decryption failure, timeout/retry/breaker, malformed-XML, HTTP 5xx without fault body, FR-11 warning path — all in scope.                                                |

## 3. Phase-Auditor Rounds

### Round 1 — NEEDS_REVISION

| Severity         | Finding                                                                                                     | Resolution                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH [TS-9]      | INT-3 file path used non-existent `__tests__/auth-profile/`; actual path is `__tests__/auth/auth-profile/`. | Global rename across §3, §5, §8. Verified directory exists with peer test files.                                                                                                              |
| HIGH [TS-6]      | E2E-2, E2E-3, E2E-4 missing Auth Context / Isolation Check.                                                 | Added both lines to all three. E2E-2 also expanded from "Identical to E2E-1" to 4 enumerated steps.                                                                                           |
| HIGH [TS-1/TS-5] | SEC-2/4/5 were bare table rows without scenario bodies.                                                     | Added 3 new concrete sub-scenarios E2E-5b (cross-project 404), E2E-5c (missing auth 401), E2E-5d (insufficient permissions 403) with full structure. Updated security table cross-references. |
| HIGH [TS-8]      | Missing playbook-required sections: Surface Semantics & Critical Feature Gate Coverage.                     | Added §5b (design-time vs runtime verification matrix + author-name → IR-name mapping) and §5c (7 security gates with fail-closed semantics + rollout/rollback note).                         |
| MEDIUM [TS-1]    | E2E-2 not self-contained.                                                                                   | Resolved via the HIGH [TS-6] expansion.                                                                                                                                                       |
| MEDIUM [TS-4]    | `vi.mock('server-only')` exception not documented.                                                          | Added explicit exception note with rationale and reference to parent E2E pattern.                                                                                                             |
| MEDIUM [TS-8]    | E2E-7 LLM-stub determinism not noted.                                                                       | Added bolded precondition that LLM stub must return canned function call.                                                                                                                     |
| MEDIUM [TS-10]   | FR-3 row lacked justification for unit-only coverage.                                                       | Annotated row: "types-only; validated transitively via INT-7 DSL round-trip".                                                                                                                 |

### Round 2 — APPROVED

Round-1 fixes verified. Two MEDIUM polish items addressed inline:

- Added Isolation Check lines to E2E-5, E2E-6, E2E-7 (3/10 scenarios that lacked them).
- Corrected SEC-10 coverage type from "Integration" to "E2E" (file reference was already to the E2E test file).

No CRITICAL or HIGH findings remained at round 2.

## 4. Files Created

| File                                                | Purpose   |
| --------------------------------------------------- | --------- |
| `docs/sdlc-logs/soap-tool-support/test-spec.log.md` | This log. |

## 5. Files Updated

| File                                              | Change                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/testing/sub-features/soap-tool-support.md`  | Replaced placeholder (created during /feature-spec) with full test specification: 10 E2E scenarios, 7 integration scenarios, 26 unit scenarios, 12 security/isolation scenarios, surface-semantics matrix, critical-gate coverage, manual test plan, production wiring verification, file mapping for 12 test files. |
| `docs/features/sub-features/soap-tool-support.md` | Updated §17 Testing Notes to reference the now-complete test spec instead of duplicating scenarios; added explicit promotion thresholds (PLANNED → ALPHA → BETA → STABLE).                                                                                                                                           |

## 6. Quality Gate Snapshot

- E2E scenarios: **10** (E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-5b, E2E-5c, E2E-5d, E2E-6, E2E-7) — exceeds the ≥5 minimum.
- Integration scenarios: **7** (INT-1..INT-7) — exceeds ≥5 minimum.
- Unit scenarios: **26** across executor, DSL, schema, and Studio UI.
- FR coverage: **all 13** (FR-1..FR-13, with FR-5 split into FR-5a..FR-5d) appear in the matrix.
- Security tests: **12 SEC-N rows** with concrete cross-references; not bare checkboxes.
- No `vi.mock` of platform components in any scenario; only `vi.mock('server-only')` exception documented.
- All E2E specify auth context + isolation check.
- All file mappings point to existing or planned paths verified against the repo.

## 7. Carry-Forward Items for HLD / LLD

- Resolve feature-spec Open Question #1 (XML-escape for `{{input.X}}` placeholders) so unit tests can assert specific behavior.
- Resolve Open Question #2 (one-way SOAP response shape) so U-9 can have a concrete assertion.
- Resolve Open Question #4 (test-endpoint envelope visibility gating) so E2E-1 step 5 can assert correct gating.
- Pin / verify exact `fast-xml-parser` version (carried from /feature-spec round-2 MEDIUM).
- Create the ABLP Jira ticket before HLD/LLD so commits can reference it (carried from /feature-spec round-2 MEDIUM).

## 8. Next Phase

Run `/hld soap-tool-support` to produce the High-Level Design with the 12 architectural concerns.
