# Test-Spec Phase Log — Guardrails Sensitive Data Block

**Date**: 2026-05-15
**Branch**: `discuss/guardrails-pii-consolidation`
**Owner**: Girish (PM)
**Phase**: 2 (Test Spec)
**Inputs**:

- Feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md` (45 FRs)
- Clarifying-questions log at `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md` (12 decisions)
- Feature-spec phase log at `docs/sdlc-logs/guardrails-sensitive-data-block/feature-spec.log.md` (Round 1-5 audit history)
- Test-spec playbook at `docs/sdlc/test-spec-playbook.md`

**Output**: Canonical test spec at `docs/testing/sub-features/guardrails-sensitive-data-block.md` (replaces prior placeholder)

---

## 1. Clarifying Questions — Oracle Pass

Single oracle pass (UX/PM/Engineering composite) with full code-grounding access. **0 AMBIGUOUS items escalated to user** — all 24 questions resolved via ANSWERED/INFERRED/DECIDED.

### Summary by Area

**Area A — Test Scope & Priorities (5 questions)**

- Q-TS-1: Highest-risk FRs → INFERRED (FR-7 activation gate, FR-8 rule enable + validateRule, FR-6.4 entity filter, FR-10 catalog, FR-5.4 failMode default flip)
- Q-TS-2: Known edge cases → ANSWERED (5 customer journeys + auto-deactivation race; no production failures since pre-launch)
- Q-TS-3: Coverage baseline → ANSWERED (zero existing SDB coverage; adjacent infra well-tested at `policy-routes.test.ts`, `policy-rbac.integration.test.ts`, `pii-cross-project-isolation.e2e.test.ts`)
- Q-TS-4: Mock vs real dependencies → INFERRED (real Mongo via `MongoMemoryServer`; real recognizer-packs; mock LLM via `startMockLLM()` only for message-flow tests)
- Q-TS-5: Test environment → ANSWERED (`RuntimeApiHarness` + `{ port: 0 }`; no Docker for runtime E2E; Studio Playwright requires external Studio+Runtime processes)

**Area B — E2E Scenarios (5 questions)**

- Q-TS-6: User-story → E2E mapping → INFERRED (US-1 → E2E-1, US-2 → E2E-1 + Settings cross-feature, US-3 → E2E-10 Playwright, US-4 → E2E-2 + E2E-3, US-5 → E2E-9 tenant-scoped, US-6 → CT-8 component-level, US-7 → E2E-10 + CT-4)
- Q-TS-7: Auth/permission matrix → INFERRED (project-owner happy path + cross-project 404 + cross-tenant 404 + unauthenticated 401 minimum; viewer-role/machine-principal optional)
- Q-TS-8: Cross-feature interactions → INFERRED (3: Settings pack-enable ↔ catalog; ABLP-921 registry ↔ catalog metadata; Settings+SDB coexistence per US-2)
- Q-TS-9: Data seeding → INFERRED (per-test POST creation; no shared fixtures; `bootstrapProject()` + `PUT runtime-config` for pack-enable; mock LLM + `PII_ECHO_AGENT_DSL` for message-flow tests)
- Q-TS-10: Playwright vs HTTP split → DECIDED (Runtime HTTP for all API behavior; Playwright for UI flows only; one Playwright spec at `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`)

**Area C — Integration Boundaries (5 questions)**

- Q-TS-11: Service boundaries → INFERRED (6: route↔Mongo, route↔shared validateRule, catalog↔registry+runtime-config, Studio proxy↔catalog, evaluator↔post-detection filter, auto-deactivation↔policy update)
- Q-TS-12: Event/async flows → INFERRED (3 trace events: `guardrail.activation.blocked`, `guardrail.auto_deactivation`, `guardrail.evaluation.block` with category rename)
- Q-TS-13: Tenant/project isolation → ANSWERED (5 scenarios: cross-project catalog/update/activate, cross-tenant, project-scoped pack filtering)
- Q-TS-14: Race conditions → INFERRED (3: concurrent last-rule disable, concurrent activate+disable, concurrent pack-disable+rule-edit — first 2 server-side via `Promise.all`, third client-side via SWR)
- Q-TS-15: Error paths → INFERRED (5: detector throws + failMode, catalog 500, unknown entity ID, XSS/null-byte in actionMessage, over-length actionMessage)

**Area D — Critical Feature Gate (4 questions)**

- Q-TS-16: Terminology test assertions → DECIDED (implicit via functional tests; no dedicated snapshot test in v1)
- Q-TS-17: Fail-closed coverage → INFERRED (5 failure-mode rows from §C.2 each get min 1-4 scenarios)
- Q-TS-18: Threat-model coverage → DECIDED (all 9 §C.3 threats get ≥1 scenario; T8 catalog rate-limit is LOW priority)
- Q-TS-19: Rollout/rollback coverage → DECIDED (2 scenarios: schema-additive backward compat + failMode default flip; no feature-flag/migration coverage needed)

**Additional must-resolve (5 questions)**

- Q-TS-20: Studio Playwright file location → ANSWERED (`apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`, flat; not under `e2e/workflows/`)
- Q-TS-21: Mock-LLM harness necessity → INFERRED (yes for message-flow E2E like E2E-1, E2E-7, E2E-14; no for CRUD-only E2E like E2E-2 through E2E-6)
- Q-TS-22: `validateRule()` test case count → DECIDED (~34-35 cases, structured as 5 `test.each` blocks: provider+pii / provider+non-pii / cel / llm / cross-cutting edges)
- Q-TS-23: WCAG dialog convention → ANSWERED (`@testing-library/react` + `role="dialog"` + `aria-modal` + user-event keyboard; no `axe-core` integration in codebase)
- Q-TS-24: Concurrency harness → ANSWERED (`Promise.all` pattern from `import-idempotent.e2e.test.ts` L564)

### Decisions logged

| #             | Decision                                                                                                                       | Risk |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| D-1 (Q-TS-10) | Runtime HTTP E2E for API behavior; Playwright for UI flows. File at `apps/studio/e2e/guardrails-sensitive-data-block.spec.ts`. | Low  |
| D-2 (Q-TS-16) | No dedicated vocabulary-integrity snapshot test in v1 — implicit through functional test assertions.                           | Low  |
| D-3 (Q-TS-18) | All 9 §C.3 threats get automated coverage; T8 (rate-limit) is LOW priority single-check.                                       | Low  |
| D-4 (Q-TS-19) | 2 rollout/rollback scenarios (schema-additive + failMode flip); no feature-flag or migration script coverage.                  | Low  |
| D-5 (Q-TS-22) | ~34-35 `validateRule()` test cases via 5 `test.each` blocks.                                                                   | Low  |

---

## 2. Files Created / Modified

| Path                                                              | Action                           | Purpose                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/testing/sub-features/guardrails-sensitive-data-block.md`    | OVERWRITE (replaces placeholder) | Canonical test spec — 15 sections, 45-row coverage matrix, 15 E2E scenarios, 10 integration scenarios, ~34 unit cases, 8 component scenarios, 4 cleanup-script scenarios |
| `docs/sdlc-logs/guardrails-sensitive-data-block/test-spec.log.md` | CREATE                           | This file                                                                                                                                                                |
| `docs/testing/sub-features/README.md`                             | UNCHANGED                        | Already has the row from Phase 1                                                                                                                                         |

---

## 3. Test Spec Statistics

| Metric                                                          | Count                                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| FR coverage matrix rows                                         | 45                                                                                        |
| E2E scenarios                                                   | 14 executable (E2E-1 through E2E-12, E2E-14, E2E-15) + 1 cross-reference (E2E-13 → INT-4) |
| Integration scenarios                                           | 11 (INT-1 through INT-11; INT-11 added in Round 1 fix for RBAC)                           |
| Unit test cases (validateRule matrix)                           | ~34                                                                                       |
| Other unit cases (banner-TTL, preset-defaults, default-message) | 3 helper modules × 3-6 cases                                                              |
| Component test scenarios                                        | 10 (CT-1, CT-1b, CT-2 through CT-9; CT-1b + CT-9 added in Round 1 fix)                    |
| Studio Playwright E2E scenarios                                 | 1 large (E2E-10 — comprehensive flow)                                                     |
| Cleanup script tests                                            | 4 (CL-1 through CL-4)                                                                     |
| Test files (new + extended)                                     | 25                                                                                        |
| Threats with automated coverage                                 | 9 / 9                                                                                     |
| §C.2 fail-closed rows with coverage                             | 5 / 5                                                                                     |

Meets test-spec-playbook minimums (5+ E2E, 5+ integration).

---

## 4. Review Findings

### Round 1 (Coverage & Completeness) — verdict: NEEDS_REVISION (3 HIGH + 5 MEDIUM + 2 LOW; all fixed in-place)

| Finding                                                                                                 | Severity | Gate    | Fix Applied                                                                                               |
| ------------------------------------------------------------------------------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| F-1: Section 2 file mapping contradicts Section 12 (wrong file for E2E-9, E2E-10; missing E2E-13/14/15) | HIGH     | G8      | Replaced Section 2 mapping with the Section 12 canonical 5-line mapping + cross-reference note for E2E-13 |
| F-2: CT-9 referenced in §8.2 but never defined                                                          | HIGH     | G6      | Added full CT-9 scenario (catalog endpoint failure: pending, 5xx, retry, network error) in §5             |
| F-3: 3 RBAC 403 bullets in §7 unmapped to test files                                                    | HIGH     | G5      | Added INT-11 with a 7-case permission matrix mapped to extended `policy-rbac.integration.test.ts`         |
| F-4: E2E-13 not an executable scenario; "15 E2E" count inflated                                         | MEDIUM   | G2      | Re-labeled E2E-13 as cross-reference; added count clarification in §2 header                              |
| F-5: §6 surface-semantics row claims CT-1 covers `kind:'both'` expansion but CT-1 doesn't               | MEDIUM   | G2/XP-1 | Added CT-1b (form serialization round-trip for `kind:'both'` → two rules)                                 |
| F-6: Studio component test paths use new subdirs not in existing flat layout                            | MEDIUM   | G8      | Added §11 directory-creation note for the three new subdirs                                               |
| F-7: E2E-1 doesn't specify HTTP status code for block response                                          | MEDIUM   | G2      | Added inline TBD note in E2E-1 + Open Question #6                                                         |
| F-8: `packages/shared/src/__tests__/validation/` doesn't exist                                          | MEDIUM   | G8      | Added §11 note recommending mirror-the-source-dir convention                                              |
| F-9: E2E-9 tenant-scoped route mount unverified                                                         | LOW      | G2      | Added route-verification note + Open Question #7                                                          |
| F-10: Carryover from feature spec R5                                                                    | LOW      | XP-1    | Subsumed by F-7                                                                                           |

All findings applied. Test spec now ready for Round 2.

### Round 2 (Alignment) — verdict: **PASS** (0 CRITICAL + 0 HIGH + 3 MEDIUM cosmetic; all fixed in-place)

All 6 alignment gates passed. R1 fixes were verified for regressions. 3 MEDIUM-severity cosmetic issues found in §3 and §12 file-mapping completeness — all applied:

| Finding                                                                                              | Severity | Fix                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| M-1: §12 missing CT-1b row; EntityMultiselect row missing CT-9                                       | MEDIUM   | Added CT-1b row for GuardrailPolicyForm.test.tsx; extended EntityMultiselect row to list CT-1, CT-2, CT-9 |
| M-2: §3 header missing INT-8/9/10/11 file mapping                                                    | MEDIUM   | Extended §3 header to all 10 integration file rows                                                        |
| M-3: §12 inline summary statistics stale (claimed "9 integration files × 10; 8 component files × 8") | MEDIUM   | Updated to "10 integration file rows × 11 scenarios; 8 component file rows × 10 scenarios"                |

All gates verified:

- G1 (Highest-risk FR depth): PASS — FR-7 has 8+ scenarios, FR-8 has ~41 total, FR-6.4 has 10, FR-10 has 5, FR-5.4 has 7
- G2 (User-story coverage): PASS — all 7 user stories mapped
- G3 (Integration boundaries vs data flow): PASS — all 5 data-flow boundaries have dedicated INT-\* scenarios
- G4 (Surface semantics alignment with feature spec §8): PASS — 6/6 asset classes covered
- G5 (R1 fix regression check): PASS with 3 cosmetic gaps (M-1/M-2/M-3, now resolved)
- G6 (Final readiness): PASS

---

## 5. Phase Handoff Packet

### What's in scope

The full set of test scenarios documented in `docs/testing/sub-features/guardrails-sensitive-data-block.md` (14 E2E + 1 cross-ref / 11 integration / ~34 unit / 10 component / 1 Playwright / 4 cleanup-script tests = 25 test files).

### Inputs to next phase (HLD)

- Canonical test spec at `docs/testing/sub-features/guardrails-sensitive-data-block.md`
- This phase log
- Feature spec at `docs/features/sub-features/guardrails-sensitive-data-block.md`
- Clarifying-questions reference at `docs/sdlc-logs/guardrails-sensitive-data-block/clarifying-questions.md`
- Existing test patterns: `policy-routes.test.ts`, `policy-rbac.integration.test.ts`, `pii-cross-project-isolation.e2e.test.ts`, `pii-confidence-threshold.e2e.test.ts`
- Mock LLM infrastructure at `tools/agents/e2e-functional/mock-llm-server.js`
- `RuntimeApiHarness` + `MongoMemoryServer` patterns

### Risks to surface for HLD

- **R-1**: HTTP status code for guardrail block response (Open Question #6) — must be decided before E2E-1 / E2E-7 / E2E-14 can be implemented.
- **R-2**: Tenant-scoped route path (Open Question #7) — must be verified for E2E-9.
- **R-3**: Faulty-recognizer fixture mechanism (Open Question #2) — must be designed for E2E-7. Per CLAUDE.md "no `vi.mock` of platform components," the chosen mechanism must avoid mocking `BuiltinPIIProvider` directly.
- **R-4**: Trace store query API for test assertions (Open Question #5) — must be exposed (read-only) for INT-6, INT-7, E2E-14.

### Open questions for HLD phase

The 7 open questions in §13 of the test spec are all HLD-phase concerns. They span: Playwright localStorage isolation, faulty-recognizer fixture, performance threshold, Undo HTTP shape, trace store query API, guardrail block status code, tenant route path.

### Quality gates passed

- Round 1 Coverage & Completeness: PASS (after 10 findings fixed)
- Round 2 Alignment: PASS (after 3 cosmetic findings fixed)
- No CRITICAL/HIGH findings remaining
- All 9 §C.3 threats have ≥1 automated scenario
- All 5 §C.2 fail-closed rows have coverage
- All 45 FRs in the coverage matrix
- 7 user stories all mapped to scenarios
- Test architecture compliance checklist (10/10) verified

### Status

**READY FOR HLD PHASE (Phase 3)**.

---

## 6. Package Learnings (deferred to implementation)

Packages that will receive `agents.md` updates AFTER implementation:

- `apps/runtime/agents.md` — new integration test patterns (race condition harness, RBAC matrix for new permissions, catalog endpoint testing)
- `apps/studio/agents.md` — new component test patterns (`EntityMultiselect`, `DecisionMatrixModal`, `FailModeSelector`); WCAG APG dialog test convention precedent
- `packages/shared/agents.md` — `validateRule()` test pattern (per-checkType `test.each` matrix)
- `apps/studio/e2e/agents.md` (NEW or extended) — Sensitive Data Block Playwright test patterns; localStorage isolation fixture

These are NOT updated at the test-spec phase per CLAUDE.md SDLC workflow — updated after implementation.

---

## 7. Cross-Cutting Insights (for `docs/sdlc-logs/agents.md`)

- **Single-Oracle pass with strong feature-spec foundation can yield 0 AMBIGUOUS escalations.** This test-spec phase had a comprehensive feature spec (already through 5 audit rounds), 12 prior user decisions in the clarifying-questions log, and well-established codebase test patterns. The Oracle classified all 24 questions via ANSWERED/INFERRED/DECIDED with zero user escalation — proof that **investment in Phase-1 quality pays compounding returns in Phase-2 throughput**.
- **Auditor catches its own R1 work**. The Round 2 auditor caught 3 file-mapping consistency gaps that the Round 1 fix introduced (CT-1b and CT-9 were added to §5 in R1 but the corresponding §12 mapping rows were missed). This is the same self-correcting pattern observed in the Feature Spec R3→R4 cycle (where R3's `kind:'both'` extension proposal was correctly reverted in R4). Audit-of-fix is a recurring win.
- **Section-internal duplication invites drift**. The test spec has file mappings duplicated in §2 (header), §3 (header), and §12 (canonical table). Each duplication is a future drift surface. Future test specs should consider either: (a) eliminating header-level duplication (just reference §12), or (b) generating §12 from the headers programmatically.

---

## 5. Phase Handoff Packet — placeholder until audit rounds pass

Will be filled in after both audit rounds PASS.
