# SDLC Log — LLD — SOAP Tool Support

**Feature**: SOAP Tool Support (sub-feature of Tool Invocations)
**Slug**: `soap-tool-support`
**Phase**: LLD
**Date**: 2026-04-27
**Author**: Claude Code (Opus 4.7) on behalf of `karthikeya.andhoju@kore.com`

---

## 1. Inputs

- Feature spec: `docs/features/sub-features/soap-tool-support.md` (PLANNED, 13 FRs).
- HLD: `docs/specs/soap-tool-support.hld.md` (APPROVED through 3 audit rounds).
- Test spec: `docs/testing/sub-features/soap-tool-support.md` (10 E2E + 7 INT + 26 unit + 12 sec scenarios; APPROVED through 2 audit rounds).
- Pipeline reference: `docs/sdlc/pipeline.md`.
- Design quality gate: `.claude/skills/design-quality-gate.md` (12 concerns).
- Verified code surfaces (read fresh from disk): `HttpBindingIR`, `HttpBindingAST`, `ToolAuthResult`, `patchToolWithResolvedAuth`, both call sites, `compileHttpBinding`, `formatPlaceholderValue`, the placeholder resolver chain, the dispatch terminal callback, the route-handler callback context, the studio permission constants.

## 2. Clarifying Questions — Product Oracle Output

15 questions across Implementation Strategy, Technical Details, Risk & Dependencies. **Zero AMBIGUOUS items.**

Key DECIDED items:

- **D-1 phasing**: Phase 1 = additive scaffolding; Phase 2 = FR-13 + executor; INT-3 test-first in Phase 2 as #1 risk gate.
- **D-2 commits**: split compiler+shared+shared-kernel and core+runtime and studio (initially proposed 3 commits; refined to 6 across 4 phases during audit rounds).
- **D-3 sibling module**: extract `soap-envelope.ts` instead of inlining in the 1,959-line `http-tool-executor.ts`.
- **D-4 typed accessor**: `SoapHttpBindingIR extends HttpBindingIR` with transient `_wsSecurityCredentials`.
- **D-5 no benchmark gate**: parser bounded by existing response-size cap + new depth limit.
- **D-6 no security-team review**: standard pr-reviewer + audit rounds suffice.
- **D-7 INT-3 test-first** for FR-13.

## 3. Phase-Auditor / LLD-Reviewer Rounds

Five mandatory rounds. CRITICAL/HIGH findings resolved in each round before proceeding to the next.

### Round 1 — lld-reviewer (Architecture compliance)

**Verdict**: NEEDS_CHANGES. **Findings: 1 CRITICAL + 4 HIGH + 4 MEDIUM + 2 LOW**.

| Severity | Finding                                                                                                                                                             | Resolution                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `?debug=true` RBAC mechanism unspecified — `withRouteHandler` does only one declarative permission check; LLD did not specify how to do a conditional second check. | Phase 3 task 3.7 rewritten: keep `TOOL_EXECUTE` declarative gate, add in-handler `hasPermission(user.permissions, StudioPermission.TOOL_WRITE)` check via `request.nextUrl.searchParams.get('debug')`. Verified `route-handler.ts:278` exposes `request` to handler callback. |
| HIGH     | `patchToolWithResolvedAuth` 5th-param details + both call sites.                                                                                                    | Task 2.4 enumerates L116-121 (`authResult`) and L376 (`freshResult`).                                                                                                                                                                                                         |
| HIGH     | 403 vs 404 confusion.                                                                                                                                               | Phase 3 exit criteria explicitly notes 403 (same-scope RBAC) is correct.                                                                                                                                                                                                      |
| HIGH     | INT-3 "test-first" methodology ambiguous — could imply a separate failing-test commit.                                                                              | Task 2.1 clarifies it's a development-workflow technique; commit test + fix together.                                                                                                                                                                                         |
| MEDIUM   | `HttpBindingAST` location not specified.                                                                                                                            | Task 1.2 cites exact path `packages/core/src/types/agent-based.ts:654-678`.                                                                                                                                                                                                   |
| MEDIUM   | Denylist inter-phase gap.                                                                                                                                           | Task 2.6 acknowledges acceptable window (zero SOAP tools today).                                                                                                                                                                                                              |
| MEDIUM   | i18n keys not specified.                                                                                                                                            | New task 3.8 with 16 specific keys under `tools.soap.*` + `tools.type_badge.soap_protocol`.                                                                                                                                                                                   |

### Round 2 — lld-reviewer (Pattern consistency)

**Verdict**: NEEDS_CHANGES. **Findings: 1 CRITICAL + 3 HIGH + 4 MEDIUM + 2 LOW**.

| Severity | Finding                                                                                                                                                              | Resolution                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | Phase 1 package count error: `HttpBindingAST` lives in `packages/core` (NOT `compiler`). Phase 1 would touch 4 packages, exceeding the 3-package commit-scope-guard. | Phase 1 split into 1a (`core` + `shared` + `shared-kernel` — includes denylist) + 1b (`compiler` only). Phase 2's task 2.6 (denylist) moved to Phase 1a. Phase 2 now `compiler` + `runtime` (2). |
| HIGH     | `patchToolWithResolvedAuth` should commit to options-object refactor (not "either acceptable").                                                                      | D-14 added; task 2.4 mandates the options-object refactor.                                                                                                                                       |
| HIGH     | Systemic propagation gap — 6 other enterprise auth credential types have the same `ToolAuthResult` boundary drop.                                                    | D-14 documents the systemic gap; Open Question #6 tracks generalization as out-of-v1-scope follow-up.                                                                                            |
| HIGH     | Placeholder integration with `formatPlaceholderValue` not specified.                                                                                                 | D-15 + task 2.8 add `escapeForXmlBodyTemplate` flag; mirrors existing `escapeForJsonBodyTemplate` / `encodeForFormBodyTemplate` pattern.                                                         |
| MEDIUM   | Sibling-module pattern claim was about function reuse (incorrect).                                                                                                   | D-3 rationale clarified — pattern is structural co-location, not function sharing.                                                                                                               |
| MEDIUM   | `SOAP_CONTENT_TYPES` typing should match `BODY_TYPE_CONTENT_TYPES` precedent.                                                                                        | Task 2.7 now uses `Record<NonNullable<HttpBindingIR['soap_version']>, string>`.                                                                                                                  |
| LOW      | Double-wrap detection method unspecified.                                                                                                                            | Task 2.7 specifies prefix-check (no XML parse).                                                                                                                                                  |
| LOW      | i18n badge namespace mismatch.                                                                                                                                       | Moved from `tools.soap.soapBadge` to `tools.type_badge.soap_protocol`.                                                                                                                           |

### Round 3 — lld-reviewer (Completeness)

**Verdict**: NEEDS_CHANGES. **Findings: 0 CRITICAL + 0 HIGH + 1 MEDIUM + 2 LOW**.

| Severity | Finding                                                                                                                                                                                                                                                          | Resolution                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MEDIUM   | Placeholder flag threading missed `resolveSecrets`, `resolveEnvVars`, and the `resolvePlaceholders` orchestrator's options object. Without these, `{{secrets.X}}` and `{{env.X}}` values inside SOAP body templates would not be XML-escaped — injection vector. | Task 2.8 expanded to enumerate all 7 call sites with critical-impact note for secrets/env-vars. |
| LOW      | Phase 2 build-filter still included `--filter=@agent-platform/core`.                                                                                                                                                                                             | Removed (denylist now in Phase 1a).                                                             |
| LOW      | Phase 2 commit description still said "(runtime + core)".                                                                                                                                                                                                        | Updated to "(runtime only)".                                                                    |

Full FR-coverage verification, file-path verification (15+ paths), and signature verification all PASSED in this round.

### Round 4 — phase-auditor (Cross-phase consistency)

**Verdict**: APPROVED with **2 HIGH + 4 MEDIUM**.

| Severity | Finding                                                                                                                                                                                                             | Resolution                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | Phase 2 file list still contained `core/agent-based-parser.ts` (stale from before the round-2 move). Implementer following the file list as a checklist would touch 3 packages instead of 2, breaking commit-scope. | Removed; clarifying note added.                                                                                                                 |
| HIGH     | Phase 1 file list omitted both `core/agent-based.ts` and `core/agent-based-parser.ts` even though task 1.2 and the Packages line said `core` was in Phase 1a.                                                       | File list restructured into Phase-1a / Phase-1b sub-groups; both `core` files now explicitly listed in 1a.                                      |
| MEDIUM   | D-2 commit count stale ("3 commits" when actual plan is 6 across 4 phases).                                                                                                                                         | D-2 rationale updated.                                                                                                                          |
| MEDIUM   | Task 4.5 OQ resolution numbering ambiguous (HLD OQs vs feature spec OQs).                                                                                                                                           | Disambiguated explicitly per OQ.                                                                                                                |
| MEDIUM   | `tool.soap_fault_count` metric counter mentioned in feature spec §12 but never addressed in LLD.                                                                                                                    | Task 2.11 documents that the `soap_fault: true` discriminator subsumes the counter; feature-spec §12 wording to be updated in Phase 4 task 4.5. |
| MEDIUM   | Phase 1 build-filter missing `--filter=@abl/core`.                                                                                                                                                                  | Added.                                                                                                                                          |

All cross-phase consistency checks PASSED:

- All 13 FRs map to LLD tasks.
- All HLD decisions reflected in LLD.
- All test spec scenarios map to LLD phases.
- All naming conventions consistent across 4 artifacts.
- All commit-scope-guard limits respected.

### Round 5 — lld-reviewer (Final sweep)

**Verdict**: APPROVED with **1 MEDIUM + 2 LOW** (no CRITICAL/HIGH).

| Severity | Finding                                                                                           | Resolution                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM   | INT-7 (DSL→IR lockstep round-trip) defined in test spec but not assigned to any LLD task.         | Phase 1b test strategy explicitly assigns INT-7 to extend `tool-lifecycle-e2e.test.ts`; file added to Phase 1b file list. |
| LOW      | `packages/i18n` package not counted in Phase 3 — would trip commit-scope-guard at implementation. | Phase 3 file list adds `packages/i18n/locales/en/studio.json`; package count corrected to "studio + i18n (2)".            |
| LOW      | Wiring checklist could note `xmlEscape` → `formatPlaceholderValue` consumer dependency.           | Implicitly covered by task 2.8 description; not blocking.                                                                 |

After Round 5, no CRITICAL or HIGH findings remain. The LLD is implementation-ready.

## 4. Files Created

| File                                                   | Purpose                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/2026-04-27-soap-tool-support-impl-plan.md` | LLD + Implementation Plan: 15 design decisions, 4-phase plan with 6 commits, file-level change map, wiring checklist, acceptance criteria, transient-field strip-list analysis. |
| `docs/sdlc-logs/soap-tool-support/lld.log.md`          | This log.                                                                                                                                                                       |

## 5. Files Updated

| File                                  | Change                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/soap-tool-support.hld.md` | Pre-LLD touch-up: fixed a stray `ToolCallContext.metadata` reference in the component diagram (line 245) that contradicted the flipped Option (i) recommendation. Now reads `attach to tool.http_binding (transient _wsSecurityCredentials)`. |

## 6. Quality Gate Snapshot

- ≥ 2 implementation phases — **4 phases** (1a, 1b, 2, 3, 4) with 6 commits.
- Every phase has measurable exit criteria (specific test counts, build commands, no "tests pass").
- Every phase has a rollback strategy.
- Wiring checklist: 14 items, all with consumer trace.
- File-level change map: 8 new files (~2,870 LOC), 23 modified files.
- All 13 FRs (FR-1..FR-13) mapped to specific tasks.
- All HLD decisions (D-1..D-13) reflected in LLD (D-1..D-15).
- All HLD open questions either resolved (OQ#1 via D-11, OQ#2 via D-12, OQ#3 via D-13) or carried forward (OQ#4 Jira ticket, OQ#5 connector backport).
- Feature spec GAPs (GAP-001..GAP-007) all acknowledged.
- Commit-scope-guard compliance verified per phase: 1a=3, 1b=1, 2=2, 3=2, 4=2.
- Test integrity: no `vi.mock` of platform components anywhere; only `vi.mock('server-only')` exception documented.
- Code-grounded throughout — every cited file path, line number, and function signature verified against the repo.

## 7. Carry-Forward Items for Implementation

**Open Questions (from LLD §7)**:

1. Jira ticket creation — `[ABLP-XXX]` placeholders in commit messages will be filled in at commit time.
2. Nonce/Timestamp redaction strategy — D-10 mandates redaction; implementer decides whether to redact at the executor's debug-render mode or at the route layer.
3. Connector-tool SOAP backport — out of v1 scope.
4. Nightly real-third-party-SOAP CI — closes feature spec GAP-007 and gates BETA → STABLE; tracked as a follow-up.
5. WSDL import — out of v1 scope; future v2 sub-feature.
6. **Systemic auth-credential propagation gap** (round-2 audit finding): 6 other enterprise auth types have the same `ToolAuthResult` boundary drop as `wsSecurityCredentials`. SOAP fixes only `wsSecurityCredentials`. Generalize via a discriminated `enterpriseCredentials` field as a follow-up.
7. **Inline E2E mock-server pattern → `fixtures/` directory** — Phase 4's stub-server fixture is the first extracted file from the inline pattern; future E2E tests may adopt the new pattern.

**Implementation watch items** (per round-5 auditor):

- The `resolvePlaceholders` options-object pattern at `http-tool-executor.ts:L900` — adding `escapeForXmlBodyTemplate` to the options object is clean, but the 6 downstream calls use positional args; implementer should NOT convert those to options-object too (scope creep).
- The `patchToolWithResolvedAuth` refactor (task 2.4) touches both call sites — test the JIT auth path (L376) explicitly, not just the happy path (L116).

## 8. Next Phase

Run `/implement soap-tool-support` to execute the LLD phase-by-phase. The skill will:

- Read this LLD fresh from disk.
- Execute Phase 1a → verify exit criteria → run pr-reviewer audit → commit.
- Execute Phase 1b → verify → audit → commit.
- Execute Phase 2 (test-first INT-3) → verify → audit → commit (split into 2).
- Execute Phase 3 → verify → audit → commit.
- Execute Phase 4 (E2E + manual) → verify → audit → commit.
- Promote feature status PLANNED → ALPHA on first commit; ALPHA → BETA after Phase 4 E2E green.

After implementation, run `/post-impl-sync soap-tool-support` to sync docs (feature spec, test spec, agents.md learnings).
