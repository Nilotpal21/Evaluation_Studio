# Test Spec Log — helix-work-item-bootstrap

**Feature**: Helix Work-Item Bootstrap & Cross-Session Retrieval
**Slug**: `helix-work-item-bootstrap`
**Started**: 2026-05-01
**Skill**: `/test-spec`

---

## Phase 1 — Inputs

- Feature spec: `docs/features/sub-features/helix-work-item-bootstrap.md` (15 FRs, two phases, ALPHA→PLANNED)
- HLD: not yet authored (next phase)
- LLD: not yet authored
- Existing test files in `packages/helix/src/__tests__/` that overlap:
  - `prompt-context.test.ts` — tests `buildPromptContext` / `renderPromptContext` through public API only; does NOT directly reference `loadPriorDoc`. Replacement is safe as long as `priorFindingsDoc` / `priorDecisionsDoc` shape is preserved.
  - `commit-manager.test.ts` — uses `jiraKey` field but does NOT directly test `isRealJiraKey`. Extraction of that helper into `jira-bootstrap.ts` is a no-behavior-change refactor.
  - `session-manager.test.ts` — does not reference `persistFindings` / `persistDecisions`.
  - Reference patterns (pure-function, no `vi.mock`): `drift-jira-adapter.test.ts`, `jira-assignee-workflow.test.ts`.
- Vitest config (`packages/helix/vitest.config.ts`): `pool: 'forks'`, `maxWorkers: 1`, `testTimeout: 20_000`. Subprocess E2E tests use per-test `{ timeout: 60_000 }` overrides; no separate vitest config.

## Phase 2 — Oracle Decisions

Single product-oracle round. All 15 questions DECIDED — zero AMBIGUOUS escalations.

### Highest-risk FRs (informs depth of coverage)

| Rank | FR    | Why                                                                                                                                                                                |
| ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | FR-10 | Scope-aware ranking is the silent-degradation surface. Wrong order means relevant findings are omitted invisibly. Multiple scenarios required (filter path, fallback path, mixed). |
| 2    | FR-5  | Five distinct Jira failure modes (missing creds / 401 / 403 / 404 / network) — each requires its own scenario.                                                                     |
| 3    | FR-8  | Hook lifecycle: per-finding `addFinding` MUST NOT trigger embedding; only the stage-boundary hook does. Wrong placement multiplies cost.                                           |
| 4    | FR-3  | Combinatorial edge cases: cap-at-5, dedup, description-order preservation, workspace-root enumeration, empty description.                                                          |

### Test Stack

- Random ports for in-process http fakes (`{ port: 0 }`, read back from `server.address()`).
- Deterministic BGE-M3 fake: hash-of-text → seeded PRNG → unit vector. Hand-crafted vectors used for pure-function `EmbeddingIndex.query` tests.
- Subprocess E2E timeout: per-test `{ timeout: 60_000 }`.

### E2E scenario count

5 placeholder + 3 additions = **8 E2E scenarios**:

- E2E-1 bare Jira-key invocation (placeholder)
- E2E-2 Jira unreachable falls back gracefully (placeholder)
- E2E-3 cross-session retrieval surfaces a prior finding (placeholder)
- E2E-4 `helix index rebuild` is idempotent (placeholder)
- E2E-5 resume preserves the original WorkItem snapshot (placeholder)
- E2E-6 CLI overrides win when both positional title + `--jira` supplied (NEW — FR-4)
- E2E-7 `--scope` flag overrides inferred scope (NEW — FR-4)
- E2E-8 concurrent CLI subprocesses writing to the same shard directory (NEW — validates per-session-shard architecture)

Stage-boundary hook lifecycle (FR-8) tested at integration level, not E2E.

### Integration scenarios

6 boundaries — each tests a distinct service contract:

1. CLI → SessionManager (session.json round-trip)
2. SessionManager → EmbeddingIndex (stage-boundary hook)
3. EmbeddingIndex → BgeM3Client (DI'd boundary)
4. jira-client.getIssue → in-process Jira fake
5. prompt-context.loadRelevantPriorContext → EmbeddingIndex (read path)
6. helix index rebuild → fixture sdlc-logs walker

Plus 4 failure-injection integration scenarios:

- Corrupt JSONL row mid-write (skip + warn, no crash)
- Mismatched-model row (skip + one-time warning per FR-15)
- Permission denied on `.helix/cache/embeddings/` (fail-soft)
- Empty `findings.md` (zero rows, no error)

### Security / repo isolation

Tenant/project/user isolation is N/A for this CLI feature. The Security & Isolation section is filled with **repo isolation** scenarios (per-`workDir` cache boundary):

- Two-repo scenario: index in repo A never returns rows from repo B's `.helix/cache/embeddings/`.
- All read/write paths rooted under `config.workDir`.

### Negative / adversarial scenarios

Included:

- Path-traversal tokens in Jira description (`../../../etc/passwd`) — `inferScopeFromText` only matches enumerated workspace roots.
- Adversarial-large Jira description (10 MB+) — graceful timeout, no OOM.
- Symlink in `docs/sdlc-logs/` pointing outside the repo — rebuild walker refuses or errors clearly.

Deferred (low-bar for developer CLI):

- ANSI escape codes in stderr.
- 1000+ findings batch chunking (covered as a performance edge case in `embedding-client.test.ts` unit, not separate scenario).

### Out of scope for CI

- Wall-clock retrieval latency assertion (flaky across machines). Validated via production `RetrievalTelemetry.latencyMs` only. Manual benchmark with 1000+ row fixture noted as a recommendation before Phase 2 ship.

### Open user-escalations

None.

---

## Phase 3 — Generation

- Wrote `docs/testing/sub-features/helix-work-item-bootstrap.md` (full test spec replacing the placeholder).
- Updated `docs/testing/README.md` H02 row counts to `8 planned` E2E + `10 planned` integration.

---

## Phase 4 — Audits (2 phase-auditor rounds)

### Round 1

**Verdict**: APPROVED — 0 CRITICAL, 3 HIGH, 4 MEDIUM. All resolved before round 2.

| ID           | Sev  | Finding                                                                                                      | Resolution                                                                                                                       |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| TS-3         | HIGH | Coverage matrix missing scenario IDs for INT-9, INT-10, UT-19..UT-23.                                        | Added all to FR-9, FR-10, FR-11, FR-12 rows.                                                                                     |
| TS-9         | HIGH | E2E scenarios hosted in `*.integration.test.ts` files — tier-naming conflation.                              | Split into 4 dedicated `*.e2e.test.ts` files; documented 3-tier naming convention in §9.                                         |
| TS-7         | HIGH | SEC-3 (path traversal) was a duplicate of UT-6 with no incremental signal.                                   | Upgraded SEC-3 to a subprocess E2E scenario reading session.json from disk after `helix audit ABLP-EVIL-1`.                      |
| TS-6         | MED  | E2E-7 left `bootstrapMeta.inferredScope` semantics ambiguous when `--scope` is supplied.                     | Locked the contract: `inferredScope === []` on the explicit-scope path. HLD must implement; alternative rejected with rationale. |
| TS-8 (E2E-3) | MED  | E2E-3 precondition assumed `helix index rebuild` knows about session.json findings (it walks markdown only). | Clarified precondition: fixture markdown is symlinked/copied into temp cwd before rebuild runs.                                  |
| TS-8 (SEC-2) | MED  | SEC-2 used "fs spy" — risks `vi.mock` of `node:fs`.                                                          | Reworded to use a DI'd `FileSystem` interface with a recording wrapper.                                                          |
| TS-10        | MED  | Phase 2 enumeration in §1 didn't list INT-9/INT-10/UT-19..UT-23.                                             | Updated enumeration to include them.                                                                                             |

### Round 2 (fresh-eyes)

**Verdict**: APPROVED — 0 CRITICAL, 1 HIGH, 2 MEDIUM. All resolved.

| ID           | Sev  | Finding                                                                                                                   | Resolution                                                                                                                                       |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| TS-10 / XP-4 | HIGH | E2E-1 didn't assert `bootstrapMeta.inferredScope` on the deterministic path → one-sided contract verification with E2E-7. | Added `bootstrapMeta.inferredScope` assertion to E2E-1 expected result; now both paths (`deterministic` and `explicit`) are positively verified. |
| TS-9 (SEC-4) | MED  | SEC-4 was placed in the `*.e2e.test.ts` file but tested in-process `getIssue()`.                                          | Moved SEC-4 to `cli-bootstrap.integration.test.ts`; reworded as in-process integration with explicit tier classification.                        |
| XP-2 (FR-8)  | MED  | INT-2 only transitioned `deep-scan → oracle-analysis`; FR-8 lists 4 stages.                                               | Parameterized INT-2 across all 4 FR-8 stages (`deep-scan`, `oracle-analysis`, `plan-generation`, `implementation`) via `it.each`.                |

### Open user-escalations

None across both rounds.

---

## Phase 5 — Commit

- **Jira ticket**: [ABLP-778](https://kore-platform.atlassian.net/browse/ABLP-778) (re-used from feature-spec phase).
- **Commits on `develop`**:
  - `164d68581` — `[ABLP-778] docs(helix): add work-item bootstrap test spec` (log file only — lint-staged stash cycle stranded the other 3 changes).
  - `ff6504bd2` — `[ABLP-778] docs(helix): expand test spec body, agents.md, README counts` (follow-up: actual test spec body + index counts + agents.md learning entry).
- **Linkback**: Comment posted to ABLP-778 mapping both SHAs.

## Next phase

`/hld helix-work-item-bootstrap`
