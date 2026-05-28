# Feature Spec Log — helix-work-item-bootstrap

**Feature**: Helix Work-Item Bootstrap & Cross-Session Retrieval (sub-feature of Helix Autonomous Engineering Harness)
**Slug**: `helix-work-item-bootstrap`
**Started**: 2026-05-01
**Skill**: `/feature-spec`

---

## Phase 1 — Discovery & Clarification

### Repo evidence consulted

- `packages/helix/src/cli.ts:190-243` — current `runAudit` / `runFix` builds `WorkItem` from CLI flags only. `--jira` is stored on `workItem.jiraKey` but never read back to populate `title`/`description`/`scope`.
- `packages/helix/src/integrations/jira-client.ts` — has `searchAssignedIssues`, `searchByLabel`, `createTicket`, `updateTicket`, `enrichTicketFromSession`, and an `adfToPlainText` helper at line 390. No public `getIssue(key)` yet — `rest/api/3/issue/${key}` is referenced inside `updateTicket` (line 482) only. Logging convention `[helix:jira]`. All Jira calls return graceful fallbacks.
- `packages/helix/src/types.ts:17-30` — `WorkItem` interface (title, description, scope[], jiraKey, featureSpec, testSpec, hldSpec, lldPlan, targetBranch).
- `packages/helix/src/pipeline/prompt-context.ts:132-133, :299-325, :792-794` — `loadPriorDoc` matches by slug (`slugifyTitle(workItem.title)`) only. Stage gate at `:792` covers `deep-scan`, `oracle-analysis`, `plan-generation`. Budget `MAX_PRIOR_CONTEXT_CHARS = 3200`, `MAX_DOC_LINES = 200`.
- `packages/helix/src/session/session-manager.ts:281, :310` — `persistFindings` and `persistDecisions` rewrite the entire markdown each call via `writeFileAtomic`.
- `packages/search-ai-internal/src/embedding/bge-m3.ts` — existing 1024-dim BGE-M3 client, OpenAI-compatible `/v1/embeddings`, `healthCheck()` available, default `http://localhost:8000`.
- `packages/helix/HELIX.md:538` — "Cross-session learning" listed as Future Work.
- `CLAUDE.md` — JIRA workflow rules (default project `ABLP`; never `source .env`; use `pnpm jira:update` for ADF updates).
- `packages/helix/CLAUDE.md` — operational rules (control-plane first; deterministic verifiers preferred over prompt rules).

### Prior art

- Major-feature parent: `docs/features/helix-autonomous-engineering-harness.md`.
- Existing sub-feature precedent: `docs/features/sub-features/cross-provider-quorum-convergence.md`.
- No existing spec at `docs/features/sub-features/helix-work-item-bootstrap.md` — new doc.

---

## Phase 2 — Oracle Decisions

Two product-oracle rounds (one per phase of the feature). All questions resolved DECIDED — zero AMBIGUOUS escalations.

### Round 1 — Embeddings retrieval (Phase 2 of feature)

| ID   | Decision                                                                                                                                                    | Confidence |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D-1  | Top-N = 8 per stage (5 findings + 3 decisions). Budget grows from 3200 → 4800 chars (3200 findings / 1600 decisions).                                       | MED        |
| D-2  | Re-embed only changed rows. SHA-256 of serialized finding/decision drives invalidation.                                                                     | HIGH       |
| D-3  | Backfill via explicit `helix index rebuild` CLI; no implicit one-shot or background sweep. Forward-going embedding is the default.                          | HIGH       |
| D-4  | BGE-M3 unreachable: persistence succeeds with stderr warning; retrieval falls back to existing slug-based `loadPriorDoc`.                                   | HIGH       |
| D-5  | Telemetry surfaces via per-session `stageHistory` in `session.json` (matches timeout-telemetry precedent).                                                  | HIGH       |
| D-6  | Single-repo scope only — embedding store reads `config.journalDir` of the current repo. Cross-repo deferred.                                                | HIGH       |
| D-7  | Append-only JSONL with line-level POSIX atomicity (`appendFile` with `O_APPEND`). Dedupe by finding-id on read (latest wins).                               | MED        |
| D-8  | Per-row metadata stores `model` + `dimensions`; cache directory versioned (`.helix/cache/embeddings/v1/`). Mismatch → warn + suggest `helix index rebuild`. | HIGH       |
| D-9  | Local-only by default. Hosted embedding providers require explicit `allowRemoteEmbedding: true` opt-in + one-time CLI warning.                              | HIGH       |
| D-10 | Embed at stage boundary (batch). Not inline per `addFinding`. Uses `embedBatch`.                                                                            | HIGH       |

### Round 2 — Jira bootstrap (Phase 1 of feature)

| ID    | Decision                                                                                                                                                                                                                          | Confidence |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D-B1  | Positional arg matching `^[A-Z]+-\d+$` is detected as a Jira key. `--jira` flag preserved as explicit override. Applies to `helix audit`, `helix fix`, `helix canary`.                                                            | HIGH       |
| D-B2  | CLI-explicit values win; Jira fills only empty/unset fields (matches `flag('--description') ?? title` precedent).                                                                                                                 | HIGH       |
| D-B3  | Scope inference is deterministic only — regex match path tokens against the live `apps/*` and `packages/*` workspace roots. Cap inferred scope at 5 entries. No LLM. Empty fallback path already supported by `deriveScopeRoots`. | HIGH       |
| D-B4  | Always fetch fresh on bootstrap. `session.json` IS the cache for the session lifetime.                                                                                                                                            | HIGH       |
| D-B5  | All four Jira failure modes (missing creds, 401/403, 404, network) fail soft: log to stderr, use the Jira key as the title, proceed with empty scope.                                                                             | HIGH       |
| D-B6  | Use flat plaintext via existing `adfToPlainText`. No structured ADF section parsing — `DescriptionSection` is outbound-only.                                                                                                      | HIGH       |
| D-B7  | Accept any key matching `^[A-Z]+-\d+$`. Jira REST `/issue/{key}` is project-agnostic; invalid keys naturally degrade via 404.                                                                                                     | HIGH       |
| D-B8  | No bootstrap-time linkback comment. Existing `enrichTicketFromSession` post-pipeline linkback is sufficient.                                                                                                                      | HIGH       |
| D-B9  | `helix resume` keeps the original WorkItem snapshot. No re-fetch. Mutating WorkItem mid-session would invalidate scan + plan state.                                                                                               | HIGH       |
| D-B10 | No auto-population of `featureSpec` / `testSpec` / `hldSpec` / `lldPlan` from ticket text. CLI flags remain the only path.                                                                                                        | HIGH       |
| D-B11 | Helix command (audit / fix / canary) determines `WorkItemType` — Jira issue type is informational only.                                                                                                                           | HIGH       |
| D-B12 | Bootstrap telemetry: stderr line + structured `bootstrapMeta` field on the session (jiraKey, fetchSuccess, fetchLatencyMs, scopeInferenceMethod, inferredScope[], fallbackReason?).                                               | MED        |
| D-B13 | Tests follow the pure-function pattern from `drift-jira-adapter.test.ts` and `jira-assignee-workflow.test.ts`. New test file: `src/__tests__/jira-bootstrap.test.ts` testing `mapJiraIssueToWorkItem` and `inferScopeFromText`.   | HIGH       |

### Open user-escalations

None. All 23 oracle questions across both rounds were resolved deterministically from existing code patterns and CLAUDE.md invariants.

---

## Phase 3 — Generation

- Wrote `docs/features/sub-features/helix-work-item-bootstrap.md` (sub-feature, parent: `helix-autonomous-engineering-harness`).
- Wrote `docs/testing/sub-features/helix-work-item-bootstrap.md`.
- Updated index files: `docs/features/README.md`, `docs/features/sub-features/README.md`, `docs/testing/README.md`, `docs/testing/sub-features/README.md`.

---

## Phase 4 — Audits (5 passes)

### Pass 1 — phase-auditor (round 1)

**Verdict**: APPROVED with 2 HIGH / 3 MEDIUM findings. Fixed in-place.

| ID   | Sev  | Finding                                                                                  | Resolution                                                                                                   |
| ---- | ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| FS-2 | HIGH | Broken link `../search-ai-development.md` in §5 integration matrix.                      | Replaced with reference-only row pointing directly at `packages/search-ai-internal/src/embedding/bge-m3.ts`. |
| FS-9 | HIGH | Testing README counts "6 + 5" did not match the spec's 9 unit + 4 integration coverage.  | Reconciled `docs/testing/README.md` to "9 planned" / "4 planned".                                            |
| FS-2 | MED  | `runCanary` uses `--title` not positional — bootstrap path needs separate handling.      | Added §7 Technical Considerations note clarifying canary divergence.                                         |
| FS-8 | MED  | Delivery plan task 9.1 missed the dispatcher-switch registration step for `helix index`. | Split into 9.1 (register in dispatcher) and 9.2 (implement `index rebuild`).                                 |
| FS-5 | MED  | Parent-harness integration row missing `session-manager.ts` touchpoints.                 | Expanded "Key Touchpoints" cell to include `persistFindings` / `persistDecisions`.                           |

### Pass 2 — phase-auditor (round 2, fresh-eyes)

**Verdict**: APPROVED — 0 CRITICAL, 1 HIGH, 4 MEDIUM. The HIGH was FR-8 stage-boundary lifecycle conflation (per-finding `addFinding → persist` confused with stage-boundary embedding). Resolved by rewriting FR-8 to explicitly separate hash computation (per-finding, at persist time) from embedding work (via a separate stage-completion hook). MEDIUMs logged but not blocking.

### Pass 3 — Platform audit (general-purpose)

**Verdict**: APPROVED — 0 CRITICAL, 2 HIGH, 2 MEDIUM. Both HIGHs were genuine reinventions:

| ID   | Sev  | Finding                                                                                                | Resolution                                                                                                      |
| ---- | ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| PA-1 | HIGH | `isRealJiraKey` already exists at `commit-manager.ts:356` with regex `^[A-Z][A-Z0-9]+-\d+$`.           | Updated FR-1 + §7 to extract & re-export from `jira-bootstrap.ts`; added `commit-manager.ts` modify row to §10. |
| PA-2 | HIGH | `adfToPlainText` is private at `jira-client.ts:390`; spec needed an explicit access pattern.           | Updated §7 to follow `searchAssignedIssues` precedent — `getIssue` returns `descriptionText` pre-converted.     |
| PA-3 | MED  | Naming proximity: existing `inferScope(files)` in `commit-manager.ts:345` vs new `inferScopeFromText`. | Added explicit naming-clarity note to delivery task 2.1.                                                        |
| PA-4 | MED  | `search_findings_semantic` MCP tool name collision with existing `search_findings`.                    | Already correctly deferred to Open Questions in spec.                                                           |

### Pass 4 — Industry research audit (general-purpose, WebSearch)

**Verdict**: 10 findings (3 RISK, 4 IMPROVEMENT, 3 GAP). RISKs were technical correctness issues; resolved.

| ID    | Tag         | Finding                                                                                                                        | Resolution                                                                                                                                                                     |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IR-4  | RISK        | No in-memory parsed-index cache → every retrieval pays full JSONL parse cost.                                                  | Added "in-memory parsed index with mtime invalidation" subsection to §7.                                                                                                       |
| IR-5  | GAP         | "Hybrid" in spec ≠ industry-standard BM25+vector fusion; only metadata-filter+cosine.                                          | Renamed all "hybrid" → "scope-aware cosine" / "scope-filter-then-cosine"; added BM25 fusion as Open Question #5; logged GAP-007.                                               |
| IR-6  | RISK        | PIPE_BUF atomicity does not apply to regular files. macOS atomic-append may cap at 1024 bytes; 1024-dim JSON vector is ~11 KB. | Replaced shared-JSONL design with per-session shard files at `.helix/cache/embeddings/bge-m3-1024/findings/<sessionId>.jsonl`; added compaction step in `helix index rebuild`. |
| IR-9  | GAP         | Directory `v1/` conflates schema version with model version; mismatch warning too quiet.                                       | Renamed dir to `bge-m3-1024/`; rewrote FR-15 to require a prominent counts-aware warning naming exact compatibility numbers.                                                   |
| IR-1  | IMPROVEMENT | Multi-strategy retrieval (Cody, Aider) is industry direction; embedding-only is not best practice.                             | Logged as Open Question #7 — "switch strategies if Phase 2 adoption stalls."                                                                                                   |
| IR-2  | IMPROVEMENT | No staleness / TTL signal; Copilot uses 28-day expiry + citation verification.                                                 | Logged as Open Question #6; logged GAP-006.                                                                                                                                    |
| IR-3  | IMPROVEMENT | No decision record for embedding choice over BM25 / graph ranking.                                                             | Implicitly resolved by Open Question #5 + #7; LLD will write the decision record.                                                                                              |
| IR-7  | RISK        | Regex scope inference is fragile; no quality metric.                                                                           | Added §14 success metric "% of bootstraps where `inferredScope` matches finding-distribution package".                                                                         |
| IR-8  | IMPROVEMENT | Scope cap of 5 doesn't specify ordering when >5 matches.                                                                       | Updated FR-3 to specify "first 5 in description order, post-dedup".                                                                                                            |
| IR-10 | IMPROVEMENT | Local-only default is correct per OWASP LLM08:2025 — should cite the standard.                                                 | Added OWASP LLM08:2025 citation to §12 Security; strengthened hosted-provider warning text to mention embedding inversion.                                                     |

### Pass 5 — OSS library audit (general-purpose, WebSearch)

**Verdict**: One material recommendation — `vectra` (MIT, ~23k weekly, pure-JS, zero native deps) as a near-drop-in replacement for the custom `EmbeddingIndex` storage and query layer. Rejected: lancedb (native deps, oversized), chroma (server-shaped), sqlite-vec (native build), hnswlib-node (no metadata filter, native), LangChain stores (heavy dep tree), jira.js (existing in-house client is sufficient), @atlaskit/adf-utils (would replace 20 lines with a heavier dep), @manypkg/get-packages (read pattern, don't import). Adopted into spec as a §7 OSS-option note: the LLD must explicitly choose between vectra and the per-session-shard custom implementation.

---

## Phase 5 — Commit

- **Jira ticket**: [ABLP-778](https://kore-platform.atlassian.net/browse/ABLP-778) (Story, labels: `helix`, `sdlc-feature-spec`).
- **Commit**: `7fbefa43a` on branch `develop` — `[ABLP-778] docs(helix): add work-item bootstrap & cross-session retrieval feature spec` — 8 files, 1063 insertions / 98 deletions, all docs (no code).
- **Linkback**: SHA mapped to ABLP-778 via `pnpm jira:update -- ABLP-778 --comment ...`.

## Next phase

`/test-spec helix-work-item-bootstrap`

---

## Phase 6 — Post-Implementation Doc Sync

**Date**: 2026-05-03
**Trigger**: `/post-impl-sync` after Phase 2 (cross-session embedding retrieval) implementation complete.

### What shifted between spec and implementation

| Spec §9 (pre-LLD draft)                                                                                   | Actual implementation (D-L1)                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flat layout: `findings.jsonl` and `decisions.jsonl` directly under `.helix/cache/embeddings/bge-m3-1024/` | Per-session shards: `findings/<sessionId>.jsonl` and `decisions/<sessionId>.jsonl`; `helix index rebuild` produces the flat consolidated files alongside the shard dirs |
| Row schema: flat top-level fields (`severity`, `category`, `sessionId`, `createdAt`, …)                   | Row schema: `metadata` nested wrapper (`EmbeddingRecordMetadata`) + top-level `kind: 'finding' \| 'decision'` discriminator                                             |
| Decision rows used `decisionId` + `classification`/`stage` fields                                         | Both kinds use `id`; type-specific fields (`severity`, `category`, `classification`) live in `metadata` and are `undefined` for the other kind                          |
| Session fields: only `bootstrapMeta?` noted                                                               | Session also carries `embeddingShardPaths?: EmbeddingShardPaths` (resolved at session-create time when embedding is enabled)                                            |

### Changes made

1. **`docs/features/sub-features/helix-work-item-bootstrap.md` §9** — replaced flat JSONL code block with per-session shard layout + consolidated file description; updated row shape to reflect nested `metadata` and `kind` discriminator; added `embeddingShardPaths?` to "Fields added to Session"; updated "Key Relationships" last bullet to mention per-session shards, consolidation step, and `buildEmbeddingShardPaths` as authoritative path builder.
2. **`packages/helix/agents.md`** — appended `2026-05-03 — ABLP-778 Post-Implementation Doc Sync` process entry documenting the §9 reconciliation and pointing future doc-sync passes at `buildEmbeddingShardPaths` + `EmbeddingRecord`/`EmbeddingRecordMetadata` in `src/types.ts` as ground-truth schema sources.

### Authoritative sources confirmed

- **Path builder**: `buildEmbeddingShardPaths` in `packages/helix/src/intelligence/embedding-config.ts`
- **Record schema**: `EmbeddingRecord` / `EmbeddingRecordMetadata` in `packages/helix/src/types.ts`
- **Write path**: `EmbeddingStore.notifyStageComplete` in `packages/helix/src/intelligence/embedding-store.ts`
