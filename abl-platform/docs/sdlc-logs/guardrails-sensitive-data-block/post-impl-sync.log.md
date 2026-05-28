# Post-Implementation Sync: Guardrails Sensitive Data Block

**Date**: 2026-05-18
**JIRA**: ABLP-723
**Branch**: `discuss/guardrails-pii-consolidation`
**Status transition**: PLANNED → **ALPHA**
**Auditor**: phase-auditor (1 round, NEEDS_REVISION → re-fix → PASS)

## Documents updated

| Doc                                                             | Delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/sub-features/guardrails-sensitive-data-block.md` | Status PLANNED → ALPHA. §10 implementation-file table rewritten with actual shipped paths (12-commit series, all paths verified). §11 config key corrected to `pii_redaction.enabled_recognizer_packs`. §16 Gaps: GAP-003/005 mitigated; GAP-006..010 added. §17 testing rows updated with actual PASS / it.todo statuses. Added Production Wiring Verification table with `server.ts` mount file:line refs.                                                                                          |
| `docs/testing/sub-features/guardrails-sensitive-data-block.md`  | Status TEST_SPEC_AUTHORED → PARTIAL. Coverage matrix walked row-by-row against actual test files; FR-2.3 corrected from PASS → it.todo (banner-ttl file is all `it.todo`). Entity-ID drift reconciled across E2E-5, INT-3, UT-4, CT-1, CT-2: `us_ssn` → `ssn`, `email_address` → `email`, `phone_number` → `phone`, `bank_account` → `us_bank_account`, `iban` → `eu_iban`. §12 file-mapping table updated to show 6 deferred subcomponent specs as NOT YET CREATED with their owning GAP references. |
| `docs/specs/guardrails-sensitive-data-block.hld.md`             | Status PLANNED → APPROVED. New §10 Post-Implementation Notes lists 6 deviations from the original HLD (failMode flips at 4 sites not 3; `pii_redaction.enabled_recognizer_packs` config key path; UI consolidation into `GuardrailPolicyForm.tsx`; no Studio proxy needed; test commit split; 8 `it.todo` markers). Trace event registry count clarified — 20 at HLD authoring, now 22.                                                                                                               |
| `docs/specs/guardrails-sensitive-data-block.lld.md`             | Status → DONE. §10 commit plan annotated to note the test commit was split into 10a + 10b due to the 3-packages-per-commit rule. §11 acceptance checkbox marked. §12 Phase Handoff updated to DONE with implementation summary.                                                                                                                                                                                                                                                                       |
| `docs/features/sub-features/README.md`                          | Row already present; no Status column in the table — status lives in the individual doc.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/testing/sub-features/README.md`                           | Same as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Coverage delta

| Type              | Before | After                                                                                                                                                                                   |
| ----------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests        | 0      | 1 file × 51 cases (guardrail-rule-validation) + 1 file × 2 cases (preset-defaults) + 1 scaffold (banner-ttl, all it.todo)                                                               |
| Integration tests | 0      | 9 files × ~80 cases (entity-filter, validate-rule, sanitization, telemetry rename, trace-events, cross-tenant, RBAC extension, failmode, pii-entities-catalog) + auto-deactivation-race |
| E2E tests         | 0      | 4 runtime e2e specs + 1 Studio Playwright spec (HTTP-only, no mocks of `@agent-platform/*` / `@abl/*`)                                                                                  |
| Tool tests        | 0      | 1 file × 8 cases (cleanup-guardrail-traces parameterized SQL + 90-day window math)                                                                                                      |

Approx. **215 passing assertions** across the new files; **8 documented `it.todo` markers** in `banner-ttl.test.ts` (FR-2.3) and the deferred-subcomponent test bodies inside `GuardrailPolicyForm.test.tsx`.

## Remaining gaps (open after this sync)

| ID      | Severity | Description                                                        | Owner sub-task |
| ------- | -------- | ------------------------------------------------------------------ | -------------- |
| GAP-006 | MED      | PIIProtectionTab cross-link banner (FR-2.1/2.2/2.3 implementation) | TBD            |
| GAP-007 | MED      | GuardrailsConfigPage SDB-specific chip rendering                   | TBD            |
| GAP-008 | LOW      | E2E-7 failMode fault-injection test seam                           | TBD            |
| GAP-009 | LOW      | RuleCard toggle gate when entities empty (UX nicety)               | TBD            |
| GAP-010 | LOW      | Output-blocked presetKey E2E (data-flow audit R2 finding)          | TBD            |

## Deviations from the original plan

1. **failMode default flip** — LLD §4.2 said 3 sites; data-flow audit R1 found a 4th site at `PolicyResolver` and fixed it.
2. **Config key path** — initial spec referenced `pii_redaction.packs`; actual project-config schema uses `pii_redaction.enabled_recognizer_packs`. Caught and fixed in pr-reviewer R1 (F-1 CRITICAL).
3. **UI consolidation** — LLD enumerated 6 subcomponent specs (EntityMultiselect, DecisionMatrixModal, FailModeSelector, RuleCard, GuardrailsConfigPage, PIIProtectionTab). Implementation consolidated CT-1, CT-1b, CT-1c, CT-2, CT-5, CT-9 into a single `GuardrailPolicyForm.test.tsx` (host-driven testing). CT-3, CT-4, CT-6, CT-7, CT-8 deferred to subcomponent extraction (GAP-006..009).
4. **No Studio proxy needed** — original HLD assumed a Studio-side BFF route for `/pii-entities`; runtime route was directly proxiable via the existing Studio proxy layer, so no new BFF route was added.
5. **Commit count** — LLD §10 planned 11 commits; landed 12 because the test commit had to be split (apps/runtime alone vs. apps/studio + packages/shared + tools = 3-packages limit).
6. **`it.todo` count** — 8 markers point at real implementation gaps, not aspirational specs. All are documented in GAP-006..010 and the test-spec coverage matrix.

## Status transition rationale

PLANNED → ALPHA chosen over PLANNED → BETA because:

- ALPHA criteria met: implementation phases complete, core happy path works, ≥1 E2E exists.
- BETA criteria **not** met: 8 `it.todo` markers mean coverage is PARTIAL, not full. AUTHORING_GUIDE §6 requires "no CRITICAL/HIGH gaps" for BETA — GAP-006/007 are MED but block BETA-grade UX claims.

## Auditor findings (R1, all resolved)

| Finding | Severity | Resolution                                                                                                              |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| PS-1    | CRITICAL | FR-2.3 coverage flipped PASS → it.todo; banner-ttl SHIPPED → it.todo / DEFERRED in feature spec §10 + §17               |
| PS-1    | HIGH     | Test spec §12 file-mapping table updated — 6 nonexistent subcomponent files marked NOT YET CREATED with owning GAP refs |
| PS-4    | MEDIUM   | HLD §9 "20 events" annotated with "now 22"                                                                              |

## Next actions

- File JIRA sub-tasks for GAP-006..010 under ABLP-723
- Map this commit SHA back to ABLP-723 via `pnpm jira:update -- ABLP-723 --comment ...`
- Open PR from `discuss/guardrails-pii-consolidation` → `develop`
