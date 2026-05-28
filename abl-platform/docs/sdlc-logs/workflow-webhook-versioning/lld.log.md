# LLD Log — workflow-webhook-versioning

**Date**: 2026-04-18
**Skill**: `/lld`
**Artifact**: `docs/plans/2026-04-18-workflow-webhook-versioning-impl-plan.md`
**Prior phase**: HLD (committed 2026-04-18 as `7efce9e115`)

---

## Phase 1 — Prerequisites

- Feature spec read fresh: `docs/features/sub-features/workflow-webhook-versioning.md` (21 FRs)
- HLD read fresh: `docs/specs/workflow-webhook-versioning.hld.md` (13 sections, APPROVED 3-round)
- Test spec read fresh: `docs/testing/sub-features/workflow-webhook-versioning.md` (21-row matrix, 8 E2E)

## Phase 2 — Oracle Clarification

Invoked `product-oracle` with 15 clarifying questions grouped by Implementation Strategy / Technical Details / Risk & Dependencies.

**Oracle outcome**: Agent returned an external-service authentication error mid-run. Remediation: read the 8 critical source files directly (`process-api.ts`, `workflow-executions.ts`, `workflow-engine-proxy.ts`, `workflow-version-service.ts`, `workflow-repo.ts`, `schema.ts`, `dsl-property-parser.ts`, `resolve-tool-implementations.ts`, `WorkflowDetailPage.tsx`, `WebhookQuickStart.tsx`, `CodeSnippets.tsx`, `server.ts`) and classify decisions inline.

### Decisions taken after direct source review (LD-1 through LD-9)

| #    | Decision                                                                                                                                   | Classification | Risk                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------ |
| LD-1 | Runtime short-URL adapter forwards `workflowVersionId` (not semver string) to engine — decouples Phase 1 from engine change                | DECIDED        | Low                                        |
| LD-2 | Tool-executor forwards semver string; requires engine semver-string resolver in same commit (Phase 3)                                      | DECIDED        | Medium — triggers 4-package atomic commit  |
| LD-3 | Shared `handleWorkflowExecute()` exported from `process-api.ts` (matches repo convention)                                                  | DECIDED        | Low                                        |
| LD-4 | New repo function `findWorkflowVersionByAnyState()` rather than option flag on existing function                                           | DECIDED        | Low — matches HLD D-4                      |
| LD-5 | `semver ^7.7.4` per-app prod dep (not shared package)                                                                                      | DECIDED        | Low — matches HLD D-1                      |
| LD-6 | Phase 3 compiler lockstep is atomic across 4 packages; scope guard exception justified in commit message per `packages/compiler/agents.md` | DECIDED        | Medium — commit-scope guard exception      |
| LD-7 | Phase 5 (semver-sort) is the only behavior-change phase; ships as single atomic runtime+engine commit                                      | DECIDED        | Medium — Docker deploy coordination needed |
| LD-8 | Test-alongside per phase (not test-first, not test-last). Phase 6 covers doc sync + observability wiring only.                             | INFERRED       | Low                                        |
| LD-9 | Draft state badge color change (`warning` → neutral) bundled into Phase 4 two-badge refactor                                               | DECIDED        | Low                                        |

### Key source-code insights (verified during LLD drafting)

- **Engine Zod schema at `workflow-executions.ts:97-106` already accepts `workflowVersion` semver string** — but resolution at `:280-324` only consumes `workflowVersionId`. Phase 3 adds the missing resolver branch.
- **Engine default branch at `:311-317`** does `findOne({state:'active'})` **with no sort** — the exact bug HLD Problem Statement #2 calls out.
- **Runtime `resolveDefaultVersion()` at `workflow-version-service.ts:711`** sorts by `publishedAt desc` — Phase 5 replaces with semver-desc.
- **Existing `system-execute-version.test.ts` exists** — LLD corrected to "EXTEND" (not "NEW") after file-existence check.
- **`findActiveWorkflowVersion()` at `workflow-repo.ts:69-84`** filters by `state: 'active'` — kept for legacy `/api/v1/process` explicit-pin path; new `findWorkflowVersionByAnyState()` added adjacent for the new short URL.
- **`process-api.ts` existing handler is ~400 lines of interleaved logic** — Phase 1.2 handler extraction scope was sharpened to explicitly list line ranges (`:210-273` input validation, `:275-289` metadata, `:294-307` engine payload, `:309-485` fetch+branching).
- **`resolve-tool-implementations.ts:571`** passes the whole `workflowBinding` object — confirmed as verify-only (no code change needed).

## Phase 3 — Generation

- LLD written: `docs/plans/2026-04-18-workflow-webhook-versioning-impl-plan.md`
- 6 implementation phases with exit criteria, test strategy, rollback plan per phase
- 9 Design Decisions logged (LD-1 through LD-9)
- Wiring checklist covers runtime, workflow-engine, compiler/shared, studio, tests
- Cross-phase concerns documented (no DB migration, no feature flag, compiler-lockstep scope exception)

## Phase 4b — Audit Loop

### Round 1 — Architecture Compliance (self-audit; lld-reviewer agent unavailable due to stream timeout)

**Focus**: isolation, auth, stateless distributed, traceability, error model, no-mock rule, commit scope, deletion guard.

**Verdict**: NEEDS_REVISION — 0 CRITICAL, 1 HIGH, 3 MEDIUM.

| ID               | Severity | Location             | Fix Applied                                                                                                                                                                                                             |
| ---------------- | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-mode-map      | HIGH     | Phase 1.3            | Added explicit two-field engine mapping (`sync` → `{webhookMode:'sync'}`; `async` → `{webhookMode:'async', webhookDelivery:'poll'}`; `async_push` → `{webhookMode:'async', webhookDelivery:'push'}`) per HLD Concern #3 |
| R1-invalid-mode  | MEDIUM   | Phase 1.3            | Explicit 400 `INVALID_MODE` on unsupported `?mode=` value                                                                                                                                                               |
| R1-status-poll   | MEDIUM   | Phase 1.3            | Clarified status-poll endpoint does NOT reuse `handleWorkflowExecute`; explicit 5-step adapter                                                                                                                          |
| R1-engine-filter | MEDIUM   | Phase 5.5            | Engine default-branch semver-sort query must preserve `{tenantId, projectId}` — isolation non-negotiable; explicit callout added                                                                                        |
| R1-extend-test   | MEDIUM   | Phase 5.9 + File Map | `system-execute-version.test.ts` already exists — LLD corrected from "Write NEW" to "EXTEND"; moved to Modified Files                                                                                                   |
| R1-schema-valid  | MEDIUM   | Phase 1.2            | Clarified input-schema validation moves INTO `handleWorkflowExecute` (needs `args.workflow.inputSchema`); adapter handles pre-handler steps (auth, fetch, scope, version resolve) only                                  |
| R1-missing-cb    | MEDIUM   | Phase 1.3            | Added `MISSING_CALLBACK_URL` 400 guardrail for `mode=async_push` without body `callbackUrl`                                                                                                                             |

### Round 1 — Fix Summary (5 bullets)

1. Phase 1.2 extraction scope sharpened with exact line ranges + input-validation placement.
2. Phase 1.3 route adapter spec expanded to 6 steps with explicit error codes for each failure branch.
3. Phase 1.3 status-poll endpoint clearly separated from execute handler (different contract).
4. Phase 5.5 engine filter explicitly preserves tenant+project isolation.
5. File map + Phase 5.9 corrected to EXTEND the existing `system-execute-version.test.ts`, not create new.

### Round 2 — Pattern Consistency (lld-reviewer)

**Focus**: reuse existing repo patterns, don't reinvent.

**Verdict**: NEEDS_REVISION — 3 CRITICAL, 2 HIGH, 3 MEDIUM.

| ID  | Severity | Location                     | Fix Applied                                                                                                                                                                                                                                                                                           |
| --- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | CRITICAL | Phase 1.1 + workflow-repo.ts | Removed the near-duplicate `findWorkflowVersionByAnyState()` function. Instead, extend existing `findWorkflowVersion()` at `:54-62` with optional `opts?: { excludeDeleted?: boolean }` — matches the repo-idiomatic pattern set by `findWorkflowByIdAndTenant(..., { includeDeleted })` at `:34-45`. |
| F-2 | CRITICAL | Phase 4 i18n                 | Added Phase 4.7 — explicit i18n keys in `packages/i18n/locales/en/studio.json`: `workflows.versions.state.{active,inactive,draft}` and `workflows.versions.servedVia` (ICU). Badge labels and caption MUST go through `useTranslations('workflows.versions')`.                                        |
| F-3 | CRITICAL | Phase 5 files-touched        | Fixed `system-execute-version.test.ts` marker from `— NEW` to `— EXTEND existing file`; consistent with Phase 5.9 task and File-Level Change Map.                                                                                                                                                     |
| F-4 | HIGH     | Phase 4.4                    | Reworded to acknowledge `WebhookQuickStart.tsx:68-70` already emits short-URL form; only `?version=` append + prop threading are new.                                                                                                                                                                 |
| F-5 | HIGH     | Phase 4.5                    | Added explicit callout that `projectId` prop becomes vestigial for URL generation; kept wired for any other consumers; audit during implementation.                                                                                                                                                   |
| F-6 | MEDIUM   | Phase 5.6 test location      | Resolved co-location: `semver-compare.test.ts` lives at `apps/runtime/src/__tests__/semver-compare.test.ts` (runtime-local per LD-5); DSL round-trip test at `packages/shared/...` deferred/removed since it duplicated Phase 3.6 coverage.                                                           |
| F-7 | MEDIUM   | Phase 4.2 design token       | Confirmed `text-muted` is a semantic token (usage at `WorkflowDetailPage.tsx:323,342,345` verified) — no change needed.                                                                                                                                                                               |
| F-8 | MEDIUM   | Integration test naming      | Renamed integration tests to follow `<name>.integration.test.ts` convention matching `process-api.integration.test.ts`: `workflow-version-service-semver.integration.test.ts`, `workflow-tool-executor-versioning.integration.test.ts`, `workflow-engine-proxy-versioning.integration.test.ts`.       |

### Round 2 — Fix Summary (5 bullets)

1. Repo function pattern normalized — extend existing `findWorkflowVersion()` with `opts.excludeDeleted` flag instead of adding a near-duplicate function.
2. Phase 4 now has an explicit i18n sub-task (namespace + 4 translation keys + ICU interpolation).
3. Test file naming now consistent: integration tests carry `.integration.` segment.
4. Phase 4.4 clarified — `WebhookQuickStart` URL format already correct; only `?version=` is new.
5. Phase 5 files-touched corrected to match task descriptions (system-execute-version.test.ts is EXTEND, not NEW).

### Round 3 — Completeness & Precision (lld-reviewer)

**Focus**: FR traceability, file-path verification, test-scenario coverage, signature completeness.

**Verdict**: NEEDS_REVISION — 3 CRITICAL, 3 HIGH, 3 MEDIUM. **All 19 file-path references verified ✓** against HEAD via grep.

| ID  | Severity | Location                          | Fix Applied                                                                                                                                                                                                                                      |
| --- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1 | CRITICAL | E2E-6 coverage gap                | Added Task 3.9 — new E2E test `workflow-tool-executor-versioning.e2e.test.ts` covers full tool-binding round-trip (FR-10/11/12 end-to-end). Added to New Files table.                                                                            |
| F-2 | CRITICAL | Zod schema missing                | Added `workflowsExecuteBodySchema` + `workflowsExecuteQuerySchema` to Section 1 interfaces. Phase 1.3(c) explicitly invokes `.safeParse()` on both.                                                                                              |
| F-3 | CRITICAL | FR-17 tooltip missing             | Phase 4.2 code sample now includes `title={viewed.state === 'active' ? t('tooltip.active') : t('tooltip.inactive')}`. i18n keys added in Task 4.7. Wiring checklist entry added.                                                                 |
| F-4 | HIGH     | HLD D-4 override not flagged      | LD-4 explicitly documents "HLD D-4 override" — post-impl task to update HLD.                                                                                                                                                                     |
| F-5 | HIGH     | Handler extraction payload inject | Task 1.2 expanded: shared handler MUST inject `workflowVersionId` + `workflowVersion` into `enginePayload` (new fields); legacy adapter passes `undefined`; new short-URL adapter passes resolved values.                                        |
| F-6 | HIGH     | Interface missing webhookMode     | `WorkflowExecuteHandlerArgs` interface annotated — single `mode` field is the external contract; handler derives engine two-field enum internally. Task 1.3(g) invocation args updated to match.                                                 |
| F-7 | MEDIUM   | i18n tooltip/aria keys            | Task 4.7 expanded: added `tooltip.active`, `tooltip.inactive`, `versionBadgeLabel` keys.                                                                                                                                                         |
| F-8 | MEDIUM   | Semver helper pin                 | Phase 5.3 pins engine helper to new file `apps/workflow-engine/src/lib/semver-compare.ts` (create `lib/` dir if absent). Phase 5.6 splits into two unit tests — runtime copy + engine copy — documenting parity. New files added to change map.  |
| F-9 | MEDIUM   | Wiring checklist gaps             | Added items: extend-signature on `findWorkflowVersion`; Zod schemas defined+consumed; `useTranslations` import; i18n keys added; tooltip+onClick wiring; E2E-6 test file; engine semver-compare test; system-execute-version EXTENDED (not new). |

### Round 3 — Fix Summary (5 bullets)

1. Added Task 3.9 — E2E-6 full-stack tool-binding round-trip test closes the only test-spec E2E gap.
2. Zod schemas formally specified in Section 1; Phase 1.3 calls them explicitly — no inline string-matching validation.
3. FR-17 tooltip requirement now fully wired — i18n keys + Badge `title` + aria-label for the version badge.
4. Handler extraction Task 1.2 sharpened: explicit injection of `workflowVersionId`/`workflowVersion` into `enginePayload` + mode-to-engine derivation encapsulated in handler.
5. Semver helper placement pinned to two concrete locations; paired unit tests document parity.

### Round 4 — Cross-Phase Consistency (phase-auditor)

**Focus**: HLD-decision fidelity, feature-spec delivery-plan coverage, test-spec scenario coverage, rollout-stage mapping, open-question forwarding, concern → exit-criteria reflection, agents.md package set, commit-scope feasibility, lifecycle gate readiness.

**Verdict**: **APPROVED** — 0 CRITICAL, 1 HIGH, 2 MEDIUM.

All 4 HLD decisions honored (D-1, D-2, D-3 verbatim; D-4 overridden with documented rationale). All 8 E2E + 6 INT test-spec scenarios mapped to LLD tasks. HLD 4-stage rollout cleanly refines into 6 LLD phases with no unauthorized behavior-change stage.

| ID  | Severity | Location                          | Fix Applied                                                                                                                                                                                                                            |
| --- | -------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | HIGH     | Phase 6.4 agents.md list          | Added `packages/shared/agents.md` to the update list — Phase 3 touches `dsl-property-parser.ts` (the 4th lockstep site), so `packages/shared` must receive a learning entry.                                                           |
| F-2 | MEDIUM   | Phase 3 New Files / Task 3.8 name | Reconciled: Phase 3 Files Touched now lists `dsl-property-parser-workflow-version.test.ts` (descriptive, matches Task 3.8); the generic `semver-compare.test.ts` is explicitly for Phase 5 comparator (two copies — runtime + engine). |
| F-3 | MEDIUM   | Test file renaming drift          | No LLD change — flagged for post-impl-sync: feature spec §10 and test spec file-map section need updating to reflect LLD-chosen integration/E2E test file names.                                                                       |

### Round 4 — Fix Summary (3 bullets)

1. `packages/shared/agents.md` added to Phase 6.4 — lockstep atomicity is now properly reflected in learnings.
2. Phase 3 test-file naming internal contradiction resolved — single canonical name used in both Files Touched and Task 3.8.
3. F-3 carried forward to post-impl-sync for feature-spec/test-spec to catch up with final LLD test file names.

### Round 5 — Final Sweep (lld-reviewer)

**Focus**: task independence, wiring checklist completeness, domain-rules sweep, stale sections, rollback quality, performance budget, semver version pin, doc formatting, acceptance-criteria coverage, open-question actionability.

**Verdict**: **APPROVED** — 0 CRITICAL, 0 HIGH, 3 MEDIUM, 2 LOW. All medium/low findings are implementation guidance (not LLD structural changes).

| ID  | Severity | Location                          | Fix Applied                                                                                                                                                                          |
| --- | -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1 | MEDIUM   | Phase 1.3 new route file          | Added explicit `createLogger('workflows-execute')` import requirement in Task 1.3 (forbids `console.log` per CLAUDE.md; matches `process-api.ts:14,24` convention).                  |
| F-2 | MEDIUM   | Phase 3.4 engine 404 message      | Added "static message — do NOT interpolate user-supplied semver string" callout in Task 3.4. Security guideline: no user input in error bodies.                                      |
| F-3 | MEDIUM   | `findWorkflowVersion` return type | No LLD change — the existing `Promise<any \| null>` return type is pre-existing; LLD interface signatures document the aspirational shape. Flagged as implementation-time awareness. |
| F-4 | LOW      | Phase 5.3 engine `lib/` dir       | No change needed — LLD already says "create the `lib/` dir if absent".                                                                                                               |
| F-5 | LOW      | OQ-5 deploy order                 | Added owner: "Runtime Team lead (coordinate with DevOps for Helm chart rollout window)".                                                                                             |

### Round 5 — Fix Summary (3 bullets)

1. Phase 1.3 route file now explicitly requires `createLogger` binding — no `console.log` slippage.
2. Phase 3.4 engine 404 response specifies a static error message — no user input interpolation.
3. OQ-5 has a named owner for deploy coordination.

---

## Final Audit Tally

| Round | Focus                   | Verdict        | Critical | High | Medium |
| ----- | ----------------------- | -------------- | -------- | ---- | ------ |
| 1     | Architecture compliance | NEEDS_REVISION | 0        | 1    | 6      |
| 2     | Pattern consistency     | NEEDS_REVISION | 3        | 2    | 3      |
| 3     | Completeness            | NEEDS_REVISION | 3        | 3    | 3      |
| 4     | Cross-phase consistency | **APPROVED**   | 0        | 1    | 2      |
| 5     | Final sweep             | **APPROVED**   | 0        | 0    | 3      |

All CRITICAL and HIGH findings across 5 rounds resolved. LLD is implementation-ready.

---

## Phase 5 — Commit

To be committed as: `[ABLP-2] docs(workflow-engine): add workflow-webhook-versioning LLD + implementation plan`.

### Package agents.md updates

Not required at LLD phase — delivery Phase 6.4 covers agents.md updates after implementation. Per CLAUDE.md package-learnings rules, LLD phase entries would list file-level surprises and technical debt found, but this LLD's decisions (LD-1 through LD-9) + the lld.log.md itself capture that information. `docs/sdlc-logs/agents.md` gets no entry (nothing cross-cutting beyond what's already tracked in per-package agents.md from prior phases).

### Next phase

Run `/compact` first per pipeline context-management rules, then `/implement workflow-webhook-versioning`. The implement skill will execute 6 phases with preflight + exit-criteria validation + 5-round pr-reviewer audits per phase.

---

## Phase 5 — Commit

Pending commit — will be committed after all 5 audit rounds complete.
