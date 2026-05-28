# SDLC Log — pii-detection-tiered-recognizers — Test Spec

**Feature**: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)
**Slug**: `pii-detection-tiered-recognizers`
**Phase**: Test Spec
**Date**: 2026-05-08
**JIRA**: ABLP-921

---

## Inputs

- Feature spec: `docs/features/sub-features/pii-detection-tiered-recognizers.md`
- Existing testing placeholder (overwritten with full test spec): `docs/testing/sub-features/pii-detection-tiered-recognizers.md`
- Parent testing guide (do not duplicate): `docs/testing/pii-detection.md`
- Sibling: `docs/features/sub-features/pii-detection-enhancements.md`

## Output Artifacts

- `docs/testing/sub-features/pii-detection-tiered-recognizers.md` — full test spec (authoritative)
- Feature spec §10 + §17 cross-references updated
- Testing index row 102 updated
- This log

## Decisions Recorded

- **Risk-ranked FRs** (oracle): FR-3/FR-4 > FR-6 > FR-5 > FR-7 > FR-2 > FR-1 > FR-8.
- **Test layout** matches actual repo: `packages/compiler/src/__tests__/security/...` and `apps/runtime/src/__tests__/...`. Updated feature spec §10 to match.
- **Harness**: `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` (TypeScript, not `.js`).
- **No third-party mocks** at module level — `validator.js`, `cockatiel`, `libphonenumber-js` are pure-JS deterministic libraries; tests run them live. Synthetic slow async recognizer for INT-5 is dependency injection, not a mock.
- **INT-11 audit-log read**: `PIIAuditStore` exposes only `insert()`. Test uses constructor-injected store implementation that captures inserts (DI), not module mocking. Compliance-read API existence flagged as Open Question 2.
- **E2E count**: 6 core + 1 regression (E2E-7) + 1 error-path (E2E-ERR-1) = 8 total.
- **Form/wiring rule**: N/A — no Studio form (UX deferred to WS-4) and no new Studio API route (extends existing PATCH/GET runtime-config and POST pii-patterns/test). E2E-ERR-1 satisfies the input-validation spirit at the API boundary.
- **Performance/load**: deferred to Capacity Planner; test spec includes only UT-6 (ReDoS adversarial timing) and a microbenchmark file (`recognizer-packs.bench.ts`) under non-blocking CI.
- **Concurrency**: INT-10 covers mid-session epoch-bump refresh — `refreshSessionPIIContext()` does mutate session in place at the next refresh boundary, so tier/pack changes propagate without restart.

## Audit Rounds

### Pass 1 — Phase-Auditor (round 1 of 2)

- **Verdict**: NEEDS_REVISION
- **CRITICAL fixed**: harness extension `.js` → `.ts` (2 occurrences, §2 preamble + §7).
- **HIGH fixed**:
  - `vitest.e2e.config.ts` allowlist registration note added to §7.
  - INT-11 rewritten to use constructor-injected `PIIAuditStore` (DI) since `PIIAuditStore` only exposes `insert()` — verified against source at `packages/compiler/src/platform/security/pii-audit.ts:24`.
  - Feature spec §10 test paths corrected from `packages/compiler/src/platform/security/__tests__/...` to `packages/compiler/src/__tests__/security/...` to match actual repo + test spec §8.
- **MEDIUM fixed**:
  - E2E-5 pack-disablement assertion split into a new dedicated **E2E-7** scenario.
  - Benchmark runner (`vitest bench`) and CI-lane note added to §7.

### Pass 2 — Phase-Auditor (round 2 of 2, fresh-eyes)

- **Verdict**: APPROVED
- All Round 1 fixes verified.
- **MEDIUM fixed**:
  - E2E count off-by-one in README + feature spec §17 corrected to 8 (6 core + 1 reg + 1 err), not 9.
  - Stale "INT-11 (with a cross-tenant probe)" claim in §5 Security matrix removed; cross-tenant overlay isolation is asserted in INT-9 instead.
- **MEDIUM logged but not fixed (cosmetic)**: E2E-7 appears before E2E-6 in document order. Reordering would require substantial restructuring with no functional gain.

## Open Questions Logged on the Test Spec (§9)

1. Permission key naming: `runtime_config:write` vs `pii:write` — pin down before E2E-ERR-1 implementation.
2. Audit-log compliance-read API (does `PIIAuditStore` need a `query()` method to surface `confidence`/`recognizer` for compliance UI?). Parent-feature gap, not a sub-feature blocker.
3. Vault round-trip scope in E2E-5 — folded the new-fields assertion in, did not duplicate parent's vault-render matrix.
4. Synthetic golden corpus storage (in-repo vs generate-at-test-time).
5. INT-12 (`MAX_RECOGNIZERS` cap) shape depends on LLD's binding decision (raise cap vs `permanent: true`). Update once LLD lands.

## Files Touched (this phase)

| Path                                                               | Action                                     |
| ------------------------------------------------------------------ | ------------------------------------------ |
| `docs/testing/sub-features/pii-detection-tiered-recognizers.md`    | rewritten as full test spec                |
| `docs/features/sub-features/pii-detection-tiered-recognizers.md`   | §10 test paths + §17 testing notes updated |
| `docs/testing/README.md`                                           | row 102 count corrected                    |
| `docs/sdlc-logs/pii-detection-tiered-recognizers/test-spec.log.md` | created (this log)                         |

## Next Phase

`/hld pii-detection-tiered-recognizers` — generate the High-Level Design with the 12 architectural concerns. The HLD must address the OQs flagged here (especially OQ-1 permission key, OQ-5 `MAX_RECOGNIZERS` decision) and the deferred MEDIUMs from feature-spec round 2 (terminology disambiguation: project tier vs `RecognizerTier` enum).
