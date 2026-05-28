# LLD Log — helix-work-item-bootstrap

**Feature**: Helix Work-Item Bootstrap & Cross-Session Retrieval
**Slug**: `helix-work-item-bootstrap`
**Started**: 2026-05-01
**Skill**: `/lld`

---

## Phase 1 — Inputs

- Feature spec: `docs/features/sub-features/helix-work-item-bootstrap.md`
- Test spec: `docs/testing/sub-features/helix-work-item-bootstrap.md`
- HLD: **deliberately skipped per user direction.** Architectural decisions normally captured in HLD live in feature-spec §7 + test-spec "locked contracts" list.
- Source survey produced two repo facts that materially shape the LLD:
  1. **`persistFindings` / `persistDecisions` are called once at pipeline-complete** (`pipeline-engine.ts:680-681`), NOT from `addFinding`/`addDecision`. The feature-spec FR-8 wording about "compute hash at persistFindings time" is misleading. The LLD must compute the hash lazily at embedding-hook time instead.
  2. **`pipeline-engine.ts` has 3 divergent `stage-complete` journal sites** (`:741`, `:2583`, `:2730`) plus 3 `stageHistory.push` sites (`:512`, `:543`, `:737`). Wiring the embedding hook into one site silently misses the others. The LLD adopts a centralizing `emitStageComplete` refactor to fix this.
  3. **`helix` package is excluded from the host repo's pnpm workspace** (`!packages/helix`). The `pnpm-workspace.yaml` Helix parses for scope inference is the **target repo's** yaml at `config.workDir/pnpm-workspace.yaml`, not Helix's own.

---

## Phase 2 — Oracle Decisions

Single product-oracle round. All 18 questions DECIDED — zero AMBIGUOUS escalations.

### Storage / Architecture

| ID    | Decision                                                                                                  | Rationale                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| D-L1  | Custom per-session shard JSONL store; reject vectra.                                                      | Zero new deps; full control over shard layout, compaction, mtime cache; vectra's file-per-item model is hostile to rebuild. |
| D-L6  | Centralize stage-completion via new `PipelineEngine.emitStageComplete(session, stage, result)`.           | Prevents the 3-divergent-sites bug class; zero-behavior-change refactor + additive hook.                                    |
| D-L7  | Embedding hook lives on `EmbeddingIndex.notifyStageComplete(session, stage)`.                             | SRP — embedding-domain logic stays on the embedding module; `pipeline-engine.ts` already at 2700+ LOC.                      |
| D-L8  | `contentHash` computed lazily inside `EmbeddingIndex.notifyStageComplete`, not at `addFinding` time.      | Avoids per-finding overhead; keeps hash state internal to `EmbeddingIndex`; `Finding` type stays minimal.                   |
| D-L9  | `loadRelevantPriorContext` lives in `prompt-context.ts` (replaces `loadPriorDoc`).                        | Direct replacement in the same module; takes optional `EmbeddingIndex` parameter — falls back to slug-based when absent.    |
| D-L10 | `EmbeddingIndex` constructed in `PipelineEngine`, passed to `prompt-context.buildPromptContext` as param. | Pipeline owns the lifecycle; avoids polluting serializable `Session` with non-serializable refs.                            |

### DI Boundaries

| ID    | Decision                                                                                                          | Rationale                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D-L11 | `getIssue(key, client?)` with optional `client` parameter for DI; default singleton in production.                | Lightest DI for a single-function boundary; matches `jira-client.ts:293` pattern.                                    |
| D-L12 | Exported `BgeM3Client` interface + `createBgeM3Client(config)` factory; `EmbeddingIndex` takes it in constructor. | Richer boundary (batch, timeout, health) justifies interface; threading optional through constructor would be messy. |

### Implementation Order

| ID   | Decision                                                                                                               | Rationale                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-L3 | Phase 1 order: `getIssue` → `jira-bootstrap.ts` pure functions → CLI wiring → telemetry.                               | Narrowest-to-broadest; downstream depends on upstream type shapes.                                           |
| D-L4 | Phase 2 order: types (`RetrievalTelemetry`) → embedding-client → embedding-index → pipeline integration → rebuild CLI. | Follows dependency graph; consumers compile-clean as they're built.                                          |
| D-L5 | Test-first for pure functions (`jira-bootstrap.test.ts`, `embedding-index.test.ts`); test-after for integration/E2E.   | Pure functions have fully-specified contracts from UT-1..UT-18; integration infra easier to build post-prod. |

### CLI / Schema

| ID    | Decision                                                                                                       | Rationale                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| D-L13 | Existing `session.json` files load with `bootstrapMeta = undefined` and `retrieval = undefined`. No migration. | Both fields typed as `?` optional; explicitly stated as locked invariant.                   |
| D-L14 | `case 'index'` slot in CLI dispatcher between `drift` and `jira`.                                              | Groups maintenance/integration commands together; matches existing dispatcher organization. |

### Risk

| ID    | Decision                                                                                                | Mitigation                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-L15 | Single highest implementation risk: stage-hook firing pattern across 3 divergent pipeline-engine sites. | Centralizing `emitStageComplete` (D-L6) + INT-2 parameterized across 4 stages (test spec) + dev-mode stderr `[helix:embeddings] hook fired for <stage>`. |
| D-L18 | No production monitoring; documented "Smoke Test Runbook" for maintainer manual validation per phase.   | Phase 1: `helix audit ABLP-<real-ticket>` on a real ticket; Phase 2: rebuild + cross-session verify.                                                     |

### Open user-escalations

None.

---

## Phase 3 — Generation

- Wrote `docs/plans/2026-05-01-helix-work-item-bootstrap-impl-plan.md` with phased delivery (Phase 1: Jira bootstrap; Phase 2: cross-session retrieval), file-level change map for both phases, wiring checklist, exit criteria with concrete test IDs, smoke-test runbook, 5 Open Questions, and 14 design decisions (D-L1..D-L14).

---

## Phase 4 — Audits (4 of 8 rounds run; R5/R6/R7/R8 skipped per user direction)

User direction was to skip R5–R8 and go straight to `/implement` after the architectural rounds. The 4 rounds that ran caught a substantial finding load (1 CRITICAL, 5 HIGH, 11 MEDIUM, all resolved on disk). The remaining rounds would have been: R5 lld-reviewer final sweep, R6 platform audit, R7 industry research, R8 OSS library.

### Round 1 — lld-reviewer (architecture compliance)

**Verdict**: NEEDS_CHANGES — 0 CRITICAL, 2 HIGH, 5 MEDIUM, 2 LOW. All resolved before R2.

| Sev  | Finding                                                                                                                      | Resolution                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH | `emitStageComplete` claimed "zero behavior change" but bundling the journal would add new journal events on skip/fail paths. | Reframed D-L6: narrow `onStageCompleted` method that fires ONLY the embedding hook, called from 3 push sites; existing 3 journal sites untouched. |
| HIGH | Refactor description ambiguous — could be misread as wide refactor across `executeStage`.                                    | Spelled out site-by-site: which 3 sites get the new call appended, which 3 stay untouched.                                                        |
| MED  | Feature spec §9 flat layout vs LLD per-session shard layout.                                                                 | §0 note 4 added: LLD authoritative; reconcile in `/post-impl-sync`.                                                                               |
| MED  | `PromptContextSnapshot.retrievalTelemetry` vs `priorFindingsDoc.telemetry` ambiguity.                                        | Locked: top-level `snapshot.retrievalTelemetry`.                                                                                                  |
| MED  | 4-stage write vs 3-stage read asymmetry unexplained.                                                                         | Added rationale to task 2.3.4.                                                                                                                    |
| MED  | `buildPromptContext` caller count not verified.                                                                              | Added grep verification to wiring checklist.                                                                                                      |
| LOW  | `bootstrapWorkItemFromCli` location not specified.                                                                           | Pinned to `cli.ts` private helper (not `jira-bootstrap.ts`).                                                                                      |
| LOW  | `enumerateWorkspacePackages` cache mechanism unspecified.                                                                    | Module-level `let cachedResult`, single-entry, process-scoped.                                                                                    |

### Round 2 — lld-reviewer (pattern consistency)

**Verdict**: NEEDS_CHANGES — 1 CRITICAL, 3 HIGH, 4 MEDIUM. All resolved before R3.

| Sev      | Finding                                                                                                                                                                                              | Resolution                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | After R1, 5 sites still carried stale wide-refactor `emitStageComplete` references (Module Boundaries, Modified Files, Wiring Checklist, OQ #3, D-L10). LLD was internally inconsistent with itself. | Scrubbed every reference; everything now describes the narrow `onStageCompleted` design.                                                                           |
| HIGH     | LLD used `PipelineStage` type which doesn't exist.                                                                                                                                                   | Replaced all instances with the real type `StageDefinition`.                                                                                                       |
| HIGH     | `SessionManager.create` signature for `bootstrapMeta` threading was under-specified.                                                                                                                 | Pinned: `create(workItem, pipeline, options?: { bootstrapMeta? })` — third optional argument; meta lands inside the `Session` literal.                             |
| HIGH     | `getIssue` DI rationale claimed "matches `searchAssignedIssues` style" but `searchAssignedIssues` doesn't use DI.                                                                                    | Rewrote D-L11 to acknowledge the actual precedent (`DriftJiraClient` in drift-jira-adapter.ts:167) and explain `JiraIssueClient` is a narrower single-method port. |
| MED      | `EmbeddingIndex` constructor opts grouping (identity vs deps mixed).                                                                                                                                 | Grouped semantically with comments.                                                                                                                                |
| MED      | `[helix:rebuild]` log prefix breaks one-prefix-per-module convention.                                                                                                                                | Changed to `[helix:embeddings] rebuild: refusing to follow symlink ...`.                                                                                           |
| MED      | `__tests__/fixtures/` is a new pattern not yet present in Helix.                                                                                                                                     | Added explicit note: new pattern justified by 4+ test files sharing fakes; existing `drift-sync-*` inline fakes NOT migrated.                                      |
| MED      | "Files Touched" Phase 1 row said `extend WorkItem` (stale post-R1 fix).                                                                                                                              | Changed to `extend Session`.                                                                                                                                       |

### Round 3 — lld-reviewer (completeness)

**Verdict**: NEEDS_CHANGES — 1 CRITICAL, 2 HIGH, 4 MEDIUM. All resolved before R4.

| Sev      | Finding                                                                                                                                                                                                                                                                                                | Resolution                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | `bootstrapMeta` threading gap — `runAudit`/`runFix` go through `runPipeline()` (not `sessionManager.create` directly), but the LLD specified passing `bootstrapMeta` as a 3rd arg to `create` only. The meta had no path to flow through `runPipeline`.                                                | Extended task 1.6 to spell out the full call chain: `runAudit` → `runPipeline(workItem, { bootstrapMeta })` → `sessionManager.create(workItem, pipeline, { bootstrapMeta })`. `runPipeline` signature gains optional `opts` arg. `runCanary` (which calls `create` directly) passes `{ bootstrapMeta }` as its own 3rd arg. |
| HIGH     | `types.ts` Phase 2 row missed `PromptContextSnapshot.retrievalTelemetry` and `HelixConfig.embeddingProvider` additions.                                                                                                                                                                                | Updated row to enumerate all 4 type changes.                                                                                                                                                                                                                                                                                |
| HIGH     | "4 E2E tests" in exit criteria; only 3 E2E scenarios are Phase 2.                                                                                                                                                                                                                                      | Corrected to "3 Phase 2 E2E tests (E2E-3, E2E-4, E2E-8)".                                                                                                                                                                                                                                                                   |
| MED      | Module Boundaries text said "session WorkItem" (stale).                                                                                                                                                                                                                                                | Changed to "Session at create-time".                                                                                                                                                                                                                                                                                        |
| MED      | Phase 1 Goal text said "WorkItem.bootstrapMeta" (stale).                                                                                                                                                                                                                                               | Changed to "Session.bootstrapMeta".                                                                                                                                                                                                                                                                                         |
| MED      | Wiring checklist missing items for `PromptContextSnapshot.retrievalTelemetry` and `HelixConfig.embeddingProvider`.                                                                                                                                                                                     | Added both.                                                                                                                                                                                                                                                                                                                 |
| Note     | `buildPromptContext` runs once per pipeline (`pipeline-engine.ts:1929`), not per stage — same `RetrievalTelemetry` is copied to all 3 retrieval-gated stages. FR-14's "each retrieval call" is literally true (1 call → 1 record copied 3 times) but per-stage deltas users might expect won't appear. | Logged as Open Question #5; classified as "acceptable for v1" with a follow-up path; not a blocker for implementation.                                                                                                                                                                                                      |

### Round 4 — phase-auditor (cross-phase consistency)

**Verdict**: APPROVED — 0 CRITICAL, 1 HIGH, 2 MEDIUM. Resolved on disk.

| Sev  | Finding                                                                                                                          | Resolution                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| HIGH | Stale `populate workItem.bootstrapMeta` text in Phase 1 Modified Files row for `session-manager.ts`.                             | Changed to "Extend `create(workItem, pipeline, options?: { bootstrapMeta? })` and set `session.bootstrapMeta` in the constructed Session literal." |
| MED  | "6 Phase 2 integration tests" enumerated 8 IDs.                                                                                  | Corrected to "8".                                                                                                                                  |
| MED  | LLD should recommend a code comment at the `result.retrieval` assignment site explaining the single-snapshot origin (per OQ #5). | Already covered by Open Question #5; implementer can read the rationale there. No additional doc change.                                           |

### Rounds 5–8 — SKIPPED per user direction

Per user direction (cost optimization), the remaining 4 audit rounds were not run. The architectural decisions in this LLD are well-vetted by 4 prior rounds plus the 5 audit passes on the upstream feature spec and the 2 audit rounds on the upstream test spec. Going straight to `/implement` next.

### Open user-escalations

None across all 4 rounds.

---

## Phase 5 — Commit

- **Jira ticket**: [ABLP-778](https://kore-platform.atlassian.net/browse/ABLP-778) (re-used from feature-spec/test-spec phases).
- **Commit on `develop`**: `41ae989b5` — `[ABLP-778] docs(helix): add work-item bootstrap LLD + implementation plan` — 3 files, 772 insertions.
- **Linkback**: Comment posted to ABLP-778 mapping the SHA + summary of audit findings resolved.

## Next phase

`/implement helix-work-item-bootstrap` — execute Phase 1 first (Jira bootstrap), then Phase 2 (cross-session retrieval) after Phase 1 lands and is observed in-use for ≥ 1 week per feature spec §13.
