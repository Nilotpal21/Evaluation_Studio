# Feature: Helix Work-Item Bootstrap & Cross-Session Retrieval (HELIX)

**Doc Type**: SUB-FEATURE
**Parent Feature**: [helix-autonomous-engineering-harness](../helix-autonomous-engineering-harness.md)
**Status**: ALPHA
**Feature Area(s)**: `developer-tooling`, `observability`
**Package(s)**: `packages/helix`
**Owner(s)**: HELIX maintainers
**Testing Guide**: [../../testing/sub-features/helix-work-item-bootstrap.md](../../testing/sub-features/helix-work-item-bootstrap.md)
**Last Updated**: 2026-05-02

---

## 1. Introduction / Overview

### Problem Statement

When a developer runs `helix audit ABLP-51` today, Helix has no path that reads the Jira ticket — `--jira` is captured on `WorkItem.jiraKey` but never used to populate `title`, `description`, or `scope`. The CLI requires the user to type the ticket summary as a positional argument and pass `--scope packages/foo,apps/bar` by hand. After the session starts, the only cross-session memory available to the prompt builder is `loadPriorDoc` in `packages/helix/src/pipeline/prompt-context.ts:132-133`, which matches _only_ by `slugifyTitle(workItem.title)` — so prior findings on related work invisibly stay invisible.

The result: every Helix session starts cold. A developer who already audited `apps/runtime/src/sessions/` last week gets no automatic carry-over when they audit it again under a different title or ticket. Time and tokens are spent re-discovering known issues. This is the gap called out in `packages/helix/HELIX.md:538` ("Cross-session learning … aren't yet fed back into new session prompts systematically").

### Goal Statement

Make `helix audit ABLP-51` a complete invocation: Helix fetches the Jira ticket via the existing client, derives a `WorkItem` (title, description, inferred scope) without the user typing anything else, and during prompt construction surfaces the most semantically-relevant prior findings and decisions across all past Helix sessions in this repo, not just sessions sharing the same title slug.

### Summary

Two-phase capability sitting in the existing CLI surface and prompt-context pipeline:

- **Phase 1 — Work-Item Bootstrap.** A regex on the positional CLI argument detects Jira keys (`^[A-Z]+-\d+$`). When matched, Helix calls a new `getIssue(key)` helper in `packages/helix/src/integrations/jira-client.ts`, runs `adfToPlainText` over the description, and infers `WorkItem.scope` deterministically by matching path tokens (`apps/*`, `packages/*`) against the live workspace. Explicit CLI flags (`--scope`, `--description`) always take precedence. All Jira failure modes degrade to the existing "key as title, empty scope" fallback path.
- **Phase 2 — Cross-Session Retrieval.** A new `EmbeddingIndex` writes per-finding and per-decision embeddings to `.helix/cache/embeddings/bge-m3-1024/` (JSONL, 1024-dim BGE-M3 vectors, change-detected by SHA-256). At the three stages already gated by `shouldIncludePriorFindings` (`deep-scan`, `oracle-analysis`, `plan-generation`), `loadPriorDoc` is replaced by a scope-aware retriever that filters candidates by `session.workItem.scope` overlap, cosine-ranks within that filter, and falls back to global cosine top-N when the filter is empty.

The two phases ship in order — Phase 1 first because Phase 2's retrieval quality depends on having a real `description` and `scope` to embed against.

---

## 2. Scope

### Goals

- A developer can run `helix audit ABLP-51` (or `helix fix ABLP-51`, `helix canary ABLP-51`) with no other arguments and Helix correctly populates `WorkItem.title`, `description`, and a useful `scope`.
- Helix surfaces the most relevant prior findings and decisions (across _all_ past sessions in this repo) at the three planning stages, ranked by scope-filter-then-cosine retrieval.
- Persistence and retrieval never block the pipeline on Jira or BGE-M3 outages — both fail soft to the current CLI-flag and slug-based behaviors respectively.
- Embedding cache is content-addressed and self-versioning, so a model swap or schema change cannot silently produce mixed-dimension corruption.
- A single explicit CLI command (`helix index rebuild`) backfills embeddings from existing `docs/sdlc-logs/<slug>/findings.md` and `decisions.md` files.

### Non-Goals (Out of Scope)

- LLM-based scope inference — only deterministic path-token matching against live workspace roots.
- Cross-repo retrieval (sharing learnings across `abl-platform`, `abl-platform-deploy`, `abl-platform-infra`). Single-repo scope only; cross-repo is deferred until usage data justifies it.
- Bootstrap-time Jira linkback (no comment posted on bootstrap; existing post-pipeline `enrichTicketFromSession` already covers commit/PR linkback).
- Hosted embedding providers (OpenAI, Voyage). Local BGE-M3 only by default; future hosted support requires explicit opt-in and is out of scope here.
- Re-fetching the Jira ticket during `helix resume` — the snapshot at session creation is authoritative.
- ADF structured-section parsing for field mapping (`Acceptance Criteria` heading → `testSpec` etc.). Plaintext only.
- Auto-population of `--spec`, `--test-spec`, `--hld`, `--lld` from ticket text. CLI flags remain the only path.
- Migrating the embedding store off flat JSONL (no sqlite, no Mongo Atlas Vector Search). Migration path is documented but not delivered.

---

## 3. User Stories

1. As a Helix user with a Jira ticket, I want to run `helix audit ABLP-51` with no other arguments so that I do not have to retype the ticket summary or guess the right `--scope` packages.
2. As a Helix user re-auditing a code area, I want prior findings from earlier sessions on the same packages to surface in the new session's prompt so that the audit does not waste tokens re-discovering known issues.
3. As a Helix user whose machine cannot reach the Jira server (offline / firewall), I want `helix audit ABLP-51` to still run — falling back to using the key as the title — so that my workflow is never blocked by Jira availability.
4. As a Helix maintainer, I want a `helix index rebuild` command so that after a model upgrade or after pulling a long-running branch, I can refresh the embedding store without ad-hoc shell scripts.
5. As a Helix maintainer, I want every retrieval call to log structured telemetry (latency, top-N returned, fallback flag, embedding source) into `session.json` so that I can answer "is the new retriever actually winning over the slug-based loader" from session data alone.

---

## 4. Functional Requirements

### Phase 1 — Work-Item Bootstrap

1. **FR-1**: When the positional argument to `helix audit`, `helix fix`, or `helix canary` matches the regex `^[A-Z][A-Z0-9]+-\d+$` (the existing `isRealJiraKey` shape from `packages/helix/src/pipeline/commit-manager.ts:356`), the CLI must treat it as a Jira key and call a new `getIssue(key)` helper before constructing the `WorkItem`. The shared regex helper must be re-exported from `packages/helix/src/integrations/jira-bootstrap.ts` (or `jira-client.ts`); `commit-manager.ts` must be updated to import it instead of redeclaring it.
2. **FR-2**: When a Jira key is detected, the CLI must populate `WorkItem.title` from the ticket summary, `WorkItem.description` from `adfToPlainText` of the ticket description, and `WorkItem.jiraKey` from the supplied key.
3. **FR-3**: `WorkItem.scope` must be inferred deterministically by scanning the description plaintext for path tokens that match live workspace roots. Workspace roots must be discovered by parsing `pnpm-workspace.yaml` and resolving its glob patterns (no hardcoded `apps/`+`packages/` assumption), so the inference stays correct if the workspace layout changes. When the description matches more than 5 workspace tokens, the inferred scope must take the first 5 in description order (preserving the author's implicit priority signal); duplicates are deduped before the cap is applied.
4. **FR-4**: Explicit CLI overrides (`--description`, `--scope`, `--branch`, `--spec`, `--test-spec`, `--hld`, `--lld`) and any positional title supplied alongside `--jira` must take precedence over Jira-derived values. Jira values fill only fields the user did not set.
5. **FR-5**: All Jira-fetch failure modes (missing credentials, HTTP 401/403, HTTP 404, network timeout / DNS failure) must degrade gracefully: log a one-line `[helix:jira]` warning to stderr, use the Jira key string as `WorkItem.title` and `description`, leave `scope` empty, and proceed with session creation.
6. **FR-6**: `helix resume <session-id>` must not re-fetch the Jira ticket — the WorkItem snapshot in `session.json` is authoritative for the lifetime of the session.
7. **FR-7**: Bootstrap telemetry must be persisted on the session under a new `bootstrapMeta` field with `jiraKey`, `jiraFetchSuccess`, `jiraFetchLatencyMs`, `scopeInferenceMethod` (`deterministic`/`explicit`/`empty`), `inferredScope: string[]`, and optional `fallbackReason: string`. The same line must also be written to stderr at bootstrap time for human visibility.

### Phase 2 — Cross-Session Retrieval

8. **FR-8**: The `SessionManager` must compute a SHA-256 content hash for each finding and each decision at `persistFindings` / `persistDecisions` time and store it on the in-memory finding/decision record. **A separate stage-completion hook** (distinct from the per-finding `addFinding → persist` lifecycle) must, on stage transitions for `deep-scan`, `oracle-analysis`, `plan-generation`, and `implementation`, collect the set of findings/decisions whose `contentHash` differs from the value last embedded for that `id` and submit them as a single batch to the embedding client. Per-finding persistence must NOT trigger embedding work directly — the hook is the only embedding entry point. This separation guarantees that frequent `addFinding` calls do not multiply embedding latency.
9. **FR-9**: Embeddings must be persisted as JSONL append-only at `.helix/cache/embeddings/bge-m3-1024/findings.jsonl` and `.helix/cache/embeddings/bge-m3-1024/decisions.jsonl`, with each row carrying `id`, `contentHash`, `model`, `dimensions`, `vector`, and indexable metadata (`severity`, `category`, `files: string[]`, `package: string`, `featureSlug`, `sessionId`, `createdAt`).
10. **FR-10**: At the `deep-scan`, `oracle-analysis`, and `plan-generation` stages, prompt construction must call a new `loadRelevantPriorContext(session, config)` retriever that returns up to 5 findings and 3 decisions drawn from across all past sessions of the current repo. The retriever must use scope-aware cosine ranking: candidates whose `files`/`package` metadata overlaps `session.workItem.scope` are ranked by cosine first; if that filtered set yields fewer than `top-N`, the remainder is filled by global cosine ranking.
11. **FR-11**: When BGE-M3 is unreachable during retrieval, the retriever must fall back to the existing slug-based `loadPriorDoc` and emit a one-line `[helix:embeddings]` warning. When unreachable during persistence, embedding generation is skipped (the next batch retry picks up the still-dirty rows via FR-8).
12. **FR-12**: A new CLI subcommand `helix index rebuild` must walk `config.journalDir` for all `findings.md` and `decisions.md` files in the current repo, parse the structured rows (the same shape that `persistFindings` / `persistDecisions` write), and re-embed each row. The command must be idempotent — running it twice produces the same JSONL.
13. **FR-13**: The retrieval prompt budget must be expanded from `MAX_PRIOR_CONTEXT_CHARS = 3200` to `MAX_PRIOR_CONTEXT_CHARS = 4800` (split: 3200 chars findings, 1600 chars decisions). The 200-line cap is preserved.
14. **FR-14**: Each retrieval call must persist a `retrieval` telemetry record on the stage entry in `session.stageHistory`: `queriedAt`, `topNReturned`, `latencyMs`, `fallback: boolean`, `embeddingSource: 'bge-m3' | 'fallback-slug'`.
15. **FR-15**: When the configured embedding model name or dimensions on disk differ from the current runtime configuration, the retriever must log a one-time prominent warning per session that names exact compatibility counts (e.g. `[helix:embeddings] WARNING: 0 of 412 indexed findings are compatible with current model bge-m3-1024 (412 indexed under <prior-model-id>); run \`helix index rebuild\` to re-embed`) and treat mismatched rows as candidates for skip (not error). The warning is stronger than a generic mismatch message because silent skipping would otherwise hide a complete loss of cross-session memory after a model change.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                               |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Helix is a developer-side CLI; tenants/projects/agents not involved.                |
| Agent lifecycle            | NONE         | Same.                                                                               |
| Customer experience        | NONE         | Same.                                                                               |
| Integrations / channels    | NONE         | Same.                                                                               |
| Observability / tracing    | SECONDARY    | New telemetry fields on `session.json` (`bootstrapMeta`, `stageHistory.retrieval`). |
| Governance / controls      | NONE         | No user-data plane involved.                                                        |
| Enterprise / compliance    | SECONDARY    | Embedding content is local-only by default to satisfy data-minimization invariant.  |
| Admin / operator workflows | NONE         | Same.                                                                               |

### Related Feature Integration Matrix

| Related Feature                                                                                              | Relationship Type | Why It Matters                                                                                                                                  | Key Touchpoints                                                                                                                                                       | Current State           |
| ------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [Helix Autonomous Engineering Harness](../helix-autonomous-engineering-harness.md)                           | extends           | This is a sub-feature directly enhancing Helix's session bootstrap and prompt-context pipeline.                                                 | `packages/helix/src/cli.ts`, `packages/helix/src/pipeline/prompt-context.ts`, `packages/helix/src/session/session-manager.ts` (`persistFindings`, `persistDecisions`) | STABLE                  |
| [Cross-Provider Quorum & Planning Convergence](cross-provider-quorum-convergence.md)                         | shares data with  | Both write into the same `session.json` and `docs/sdlc-logs/<slug>/` artifacts; no interference.                                                | `session.findings`, `session.decisions`, `docs/sdlc-logs/<slug>/`                                                                                                     | ALPHA                   |
| `packages/search-ai-internal/src/embedding/bge-m3.ts` (BGE-M3 client pattern, reference only — not imported) | reference         | Helix's new embedding client mirrors the fetch / batch / health-check pattern of the SearchAI client without taking a cross-package dependency. | `packages/search-ai-internal/src/embedding/bge-m3.ts`                                                                                                                 | implemented in SearchAI |

---

## 6. Design Considerations

CLI is the only user surface. Output stays compact:

- Stderr line at bootstrap: `[helix:jira] fetched ABLP-51 (287 ms, summary: 54 chars, description: 1203 chars, inferred scope: apps/runtime, packages/execution)` — or a one-line failure note that names the failure mode.
- Stderr line at first retrieval per session: `[helix:embeddings] retriever ready (model: bge-m3, dim: 1024, indexed findings: 412, decisions: 88)`.
- Per-stage retrieval emits one structured journal line into the existing per-session journal stream — no extra surfaces.

No Studio UI, no admin portal, no API surface.

---

## 7. Technical Considerations

- **`getIssue(key)` helper.** Add a public exported function in `packages/helix/src/integrations/jira-client.ts` that follows the same `resolveCredentials() → jiraFetch(...) → graceful null on failure` pattern used by `searchAssignedIssues` (line 293). Endpoint: `rest/api/3/issue/${key}` with fields `summary,status,description,labels,issuetype,priority,components,updated,created`. The function must return the existing `JiraAssignedIssue` shape (already exported by `jira-client.ts`) populating `descriptionText` via the existing private `adfToPlainText` helper at `jira-client.ts:390` — the same pattern `searchAssignedIssues` uses at line 362. `adfToPlainText` stays private; downstream callers consume `descriptionText` only.
- **Reuse the existing Jira-key regex.** A function `isRealJiraKey(s: string): boolean` already exists at `packages/helix/src/pipeline/commit-manager.ts:356-358` with regex `^[A-Z][A-Z0-9]+-\d+$`. The new bootstrap module must extract this helper into a shared location (`packages/helix/src/integrations/jira-bootstrap.ts` is the natural home) and have `commit-manager.ts` import it. Do NOT introduce a parallel `isJiraKey` definition — the existing regex is more correct than a naive `^[A-Z]+-\d+$` because it allows digits after the first letter (matching Jira's actual key shape).
- **Bootstrap is a pure function.** `mapJiraIssueToWorkItem(issue: JiraAssignedIssue, cliOverrides: Partial<WorkItem>): Partial<WorkItem>` and `inferScopeFromText(text: string, workspacePackages: string[]): string[]` are pure and live in a new module `packages/helix/src/integrations/jira-bootstrap.ts`. Tested as pure functions; the HTTP call is the only impure surface and is dependency-injected via the existing client.
- **Canary command divergence.** `runCanary` in `cli.ts:719` does NOT use a positional title argument — it reads `--title` (defaulting to `DEFAULT_CANARY_TITLE`). Phase 1 must add positional-as-Jira-key detection to `runCanary` as a separate code path (the regex check goes on `parsed.positional[0]`, distinct from the existing `--title` flag). When both a positional Jira key and `--title` are supplied, `--title` wins per the explicit-overrides-Jira precedence in FR-4.
- **Embedding client.** Helix gets its own narrow `BgeM3Client` in `packages/helix/src/intelligence/embedding-client.ts` that mirrors the fetch pattern from `packages/search-ai-internal/src/embedding/bge-m3.ts` without taking a dependency on `search-ai-internal` (Helix is currently a leaf package — cross-package import would expand its dep graph).
- **Index module.** New `packages/helix/src/intelligence/embedding-index.ts` exports `EmbeddingIndex` with `upsertBatch`, `query`, and a `rebuild` entry point used by the `helix index rebuild` CLI command.
- **OSS-library option for the index.** The OSS-audit pass identified [`vectra`](https://www.npmjs.com/package/vectra) (MIT, ~23k weekly downloads, pure-JS, zero native deps, file-backed JSON store with metadata-filter + cosine query) as a near-drop-in fit for the `EmbeddingIndex` storage and query layer. Adopting `vectra` would replace the custom JSONL persistence, dedupe-on-read pass, and concurrency design with library-managed file-per-item storage — leaving only the content-hash invalidation (FR-8) and `helix index rebuild` as Helix-owned. The LLD must explicitly choose between (a) adopt `vectra`, or (b) implement the per-session-shard layout described above. If `vectra` is adopted, the FR-9 row schema becomes a metadata payload on a vectra item, the per-session shard concurrency mitigation is replaced by vectra's per-item file model, and `packages/helix/package.json` gains one new MIT dependency.
- **Concurrency — per-session shard files, not a single shared JSONL.** Multiple Helix sessions on the same machine may run concurrently. Naive `O_APPEND` to a single shared JSONL is **not safe** for our row size: POSIX `PIPE_BUF` atomicity applies to pipes/FIFOs, not regular files; macOS / APFS empirical guarantees can be as low as 1024 bytes per write, and a 1024-dim BGE-M3 vector serialized as JSON at 6-dp precision is ~11 KB per row — well above any platform's atomic-append guarantee. Instead, each session writes its own shard file: `.helix/cache/embeddings/bge-m3-1024/findings/<sessionId>.jsonl` and `.helix/cache/embeddings/bge-m3-1024/decisions/<sessionId>.jsonl`. There is no cross-session contention because there is no shared writer. On retrieval, the index reads all shard files in the directory, deduplicates by row `id` with "latest `createdAt` wins", and merges into the in-memory store.
- **In-memory parsed index with mtime invalidation.** On first retrieval call per CLI process, the `EmbeddingIndex` walks the shard directory, parses every shard, and builds an in-memory store keyed by `id`. On subsequent retrieval calls within the same process, the index re-reads only shard files whose mtime has changed since the last load. Without this, every retrieval call pays the full JSONL parse cost (the actual bottleneck — cosine over 10 K vectors is < 50 ms; parsing 10 K JSON lines each containing a 1024-element float array is far more expensive). The cache lives for the CLI process lifetime; there is no cross-process cache.
- **Compaction at `helix index rebuild`.** The shard layout grows one file per session. `helix index rebuild` compacts the per-session shards into consolidated `findings.jsonl` / `decisions.jsonl` files inside the same model-versioned directory and renames the per-session shards to `<sessionId>.jsonl.compacted`. Later sessions still write new shards next to the compacted file; the next rebuild folds them in. This keeps shard count bounded over time without requiring a daemon.
- **Privacy.** Local-only by default. The embedding configuration in `HelixConfig` exposes a `embeddingProvider: { kind: 'bge-m3-local', baseUrl }` field; future hosted-provider variants must require an explicit `allowRemoteEmbedding: true` boolean and must emit a one-time CLI warning before the first call.
- **Pipeline fail-soft contract.** Every Jira and BGE-M3 call returns `null | undefined | empty` on failure. The pipeline never throws because of these dependencies. This matches the contract in `packages/helix/src/integrations/jira-client.ts:5-6`.
- **Resume invariant.** `helix resume` reloads `session.json` and never re-fetches Jira nor re-runs scope inference. Session content is point-in-time. If the user wants fresh Jira data, they must start a new session.
- **Test architecture compliance.** All new test files in `packages/helix/src/__tests__/` follow the pure-function pattern from `drift-jira-adapter.test.ts` and `jira-assignee-workflow.test.ts`. The `JiraIssueClient` and `EmbeddingClient` boundaries are typed interfaces tested via in-memory implementations — no `vi.mock` of platform modules.

---

## 8. How to Consume

### Studio UI

N/A — CLI only.

### Surface Semantics Matrix

N/A — Helix is a developer CLI. There is no design-time / runtime split; every artifact is materialized to disk inside the active repo's `.helix/` and `docs/sdlc-logs/` paths at session-execution time.

### Design-Time vs Runtime Behavior

N/A.

### API (Runtime)

N/A.

### API (Studio)

N/A.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

The Helix MCP control plane (`packages/helix/src/mcp/`) is unchanged by this feature in v1. A future MCP surface for `search_findings_semantic` (vector-aware variant of `search_findings`) is noted in §15 as Open Question.

### CLI

```text
# New behaviors
helix audit ABLP-51                                  # auto-fetches ticket; full bootstrap
helix fix ABLP-51                                    # same; pipeline = bug-fix
helix canary ABLP-51                                 # same; pipeline = canary

# Existing behaviors preserved
helix audit "Manual title"                           # legacy positional title path
helix audit "Manual title" --jira ABLP-51            # CLI title wins; Jira fills empty fields
helix audit ABLP-51 --scope apps/runtime,apps/admin  # CLI scope overrides inferred scope
helix audit ABLP-51 --description "Override desc"    # CLI description overrides ticket body

# New maintenance command
helix index rebuild                                  # backfills .helix/cache/embeddings/bge-m3-1024/ from docs/sdlc-logs/
helix index rebuild --dry-run                        # walks but does not write
```

---

## 9. Data Model

This feature does not add MongoDB collections — Helix operates entirely on local files. The on-disk artifacts:

```text
Per-session shard files (written at stage boundary via EmbeddingStore.notifyStageComplete):
  .helix/cache/embeddings/bge-m3-1024/findings/<sessionId>.jsonl
  .helix/cache/embeddings/bge-m3-1024/decisions/<sessionId>.jsonl

Consolidated files (produced by `helix index rebuild`; live alongside the shard dirs):
  .helix/cache/embeddings/bge-m3-1024/findings.jsonl
  .helix/cache/embeddings/bge-m3-1024/decisions.jsonl

Row shape (EmbeddingRecord — same structure for both findings and decisions shards):
  - id: string                     (Finding.id or Decision.id)
  - kind: 'finding' | 'decision'
  - contentHash: string            (sha256 of canonicalized item text, 32 hex chars)
  - model: string                  (e.g., "bge-m3")
  - dimensions: number             (1024)
  - vector: number[]               (1024 floats)
  - metadata:
      severity?: FindingSeverity   (findings only)
      category?: FindingCategory   (findings only)
      classification?: DecisionClassification  (decisions only)
      stage?: StageType            (reserved; currently undefined)
      files: string[]              (FileReference.path values; empty [] for decisions)
      package?: string             (best-effort root package; currently undefined)
      featureSlug: string          (slugify(workItem.title))
      sessionId: string
      projectId?: string           (Jira key when available, else slugify(title);
                                    mandatory isolation key — query() filters by this)
      createdAt: string            (ISO timestamp)
```

```text
Fields added to Session (packages/helix/src/types.ts):
  - bootstrapMeta?: BootstrapMeta
  - embeddingShardPaths?: EmbeddingShardPaths  (resolved paths for the session's
                                                per-session shard files; set by
                                                PipelineEngine on session create
                                                when embedding is enabled)

Note: bootstrapMeta lives on Session, NOT WorkItem. WorkItem is the portable
work-description object; bootstrapMeta is per-session telemetry about how that
WorkItem was sourced. This was a locked invariant during implementation.

interface BootstrapMeta {
  jiraKey?: string;
  jiraFetchSuccess: boolean;
  jiraFetchLatencyMs?: number;
  scopeInferenceMethod: 'deterministic' | 'explicit' | 'empty';
  inferredScope: string[];
  fallbackReason?: string;
}

Field added to StageResult (packages/helix/src/types.ts):
  - retrieval?: RetrievalTelemetry

interface RetrievalTelemetry {
  queriedAt: string;
  topNReturned: number;
  latencyMs: number;
  fallback: boolean;
  embeddingSource: 'bge-m3' | 'fallback-slug';
}
```

### Key Relationships

- `bootstrapMeta` is owned by the `Session` (set once at create time, never mutated).
- `RetrievalTelemetry` is owned by individual stage entries in `session.stageHistory`; one record per retrieval call (i.e. per stage that gates on `shouldIncludePriorFindings`).
- JSONL rows are owned by the on-disk store under `.helix/cache/embeddings/bge-m3-1024/`. The live write target is per-session shards (`findings/<sessionId>.jsonl`, `decisions/<sessionId>.jsonl`); `helix index rebuild` compacts those into consolidated flat files alongside the shard directories. The store is per-repo (keyed off `config.workDir`); no shared global cache. The authoritative path builder is `buildEmbeddingShardPaths` in `packages/helix/src/intelligence/embedding-config.ts`.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/helix/src/integrations/jira-client.ts` (modify)   | Add public `getIssue(key)` helper returning `JiraAssignedIssue` with pre-computed `descriptionText`. Keep `adfToPlainText` private.                        |
| `packages/helix/src/integrations/jira-bootstrap.ts` (new)   | Pure functions: `mapJiraIssueToWorkItem`, `inferScopeFromText`, plus re-export of the canonical `isRealJiraKey` helper extracted from `commit-manager.ts`. |
| `packages/helix/src/pipeline/commit-manager.ts` (modify)    | Import `isRealJiraKey` from the new shared location instead of redeclaring it. No behavior change.                                                         |
| `packages/helix/src/intelligence/embedding-client.ts` (new) | `BgeM3Client` — fetch wrapper for `/v1/embeddings`, mirrors search-ai-internal pattern.                                                                    |
| `packages/helix/src/intelligence/embedding-index.ts` (new)  | `EmbeddingIndex` — append-only JSONL store with scope-aware cosine retrieval, rebuild path.                                                                |
| `packages/helix/src/pipeline/prompt-context.ts` (modify)    | Replace `loadPriorDoc` with `loadRelevantPriorContext`; expand budget constants.                                                                           |
| `packages/helix/src/session/session-manager.ts` (modify)    | At stage boundary, batch-enqueue dirty findings/decisions to `EmbeddingIndex`.                                                                             |
| `packages/helix/src/types.ts` (modify)                      | Add `BootstrapMeta`, `RetrievalTelemetry`; extend `Session` and `StageResult`.                                                                             |

### Routes / Handlers

N/A — CLI tool, no HTTP routes.

### UI Components

N/A.

### Jobs / Workers / Background Processes

| File                                 | Purpose                                                                |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `packages/helix/src/cli.ts` (modify) | Detect Jira key on positional arg; wire `helix index rebuild` command. |

### Tests — Phase 1 (shipped in commit `3a53bd977`)

| File                                                                   | Type        | Coverage Focus                                                                                                                |
| ---------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/helix/src/__tests__/jira-bootstrap.test.ts` (new)            | unit        | `mapJiraIssueToWorkItem`, `inferScopeFromText`, `isRealJiraKey`, `enumerateWorkspacePackages` — 27 tests, UT-1..UT-9 ✅       |
| `packages/helix/src/__tests__/cli-bootstrap.integration.test.ts` (new) | integration | `getIssue` failure matrix + SessionManager round-trip + SEC-4 large-body — 13 tests, INT-1, INT-4, SEC-4 ✅                   |
| `packages/helix/src/__tests__/cli-bootstrap.e2e.test.ts` (new)         | e2e         | Subprocess Helix CLI vs in-process Jira fake — 6 tests, E2E-1, E2E-2, E2E-5, E2E-6, E2E-7, SEC-3 ✅                           |
| `packages/helix/src/__tests__/security-isolation.test.ts` (new)        | security    | SEC-6: secret token never appears in stderr ✅                                                                                |
| `packages/helix/src/__tests__/fixtures/jira-fake.ts` (new)             | fixture     | In-process node:http Jira fake, random port, `closeAllConnections` on teardown ✅                                             |
| `packages/helix/src/__tests__/fixtures/workspace/` (new)               | fixture     | `pnpm-workspace.yaml` + `apps/{runtime,admin,studio}` + `packages/{database,execution,compiler}` for scope-inference tests ✅ |

### Tests — Phase 2 (not yet implemented)

| File                                                                        | Type        | Coverage Focus                                              |
| --------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `packages/helix/src/__tests__/embedding-index.test.ts` (new)                | unit        | Hybrid ranking, dedupe-on-read, model-mismatch, hash-detect |
| `packages/helix/src/__tests__/embedding-client.test.ts` (new)               | unit        | Fetch wrapper, batch chunking, graceful fail                |
| `packages/helix/src/__tests__/embedding-pipeline.integration.test.ts` (new) | integration | INT-2, INT-3, INT-5, INT-7, INT-8, INT-9                    |
| `packages/helix/src/__tests__/index-rebuild.integration.test.ts` (new)      | integration | INT-6, INT-10                                               |
| `packages/helix/src/__tests__/prompt-context.test.ts` (modify)              | unit        | UT-22, UT-23 (existing 8 tests preserved)                   |
| `packages/helix/src/__tests__/cross-session-retrieval.e2e.test.ts` (new)    | e2e         | E2E-3                                                       |
| `packages/helix/src/__tests__/index-rebuild.e2e.test.ts` (new)              | e2e         | E2E-4, SEC-5                                                |
| `packages/helix/src/__tests__/concurrent-shards.e2e.test.ts` (new)          | e2e         | E2E-8                                                       |

---

## 11. Configuration

### Environment Variables

| Variable                               | Default                 | Description                                                                                                             |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL` / `ATLASSIAN_BASE_URL` | unset                   | Existing — required for Jira fetch. Bootstrap fails soft when unset.                                                    |
| `JIRA_EMAIL`                           | unset                   | Existing — required.                                                                                                    |
| `JIRA_API_TOKEN` / `ATLASSIAN_API_KEY` | unset                   | Existing — required.                                                                                                    |
| `JIRA_PROJECT_KEY`                     | `ABLP`                  | Existing — informational only for bootstrap; `getIssue(key)` does not require a project key.                            |
| `HELIX_EMBEDDING_BASE_URL`             | `http://localhost:8000` | Optional override for the BGE-M3 service URL.                                                                           |
| `HELIX_EMBEDDING_TIMEOUT_MS`           | `120000`                | Per-batch timeout. Same default as the search-ai-internal client.                                                       |
| `HELIX_EMBEDDING_DISABLED`             | unset                   | If set to a truthy value, the retriever skips embedding lookup and uses the existing slug-based loader unconditionally. |

### Runtime Configuration

`HelixConfig` gains an optional `embeddingProvider` field:

```ts
interface HelixConfig {
  // ... existing fields
  embeddingProvider?: {
    kind: 'bge-m3-local';
    baseUrl?: string;
    timeoutMs?: number;
    maxBatchSize?: number;
    disabled?: boolean;
  };
}
```

When `embeddingProvider` is absent, defaults from the env vars above apply. Future hosted-provider variants will add their own discriminator and require an explicit `allowRemoteEmbedding: true` field.

### DSL / Agent IR / Schema

N/A.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | N/A — Helix is a developer-side CLI with no tenant/project/user data plane. The single isolation boundary is the local repo (`config.workDir`).                          |
| Tenant isolation  | N/A — same reason.                                                                                                                                                       |
| User isolation    | N/A — same reason. The embedding store is per-repo on the developer's local disk; there is no shared multi-user state.                                                   |
| Repo isolation    | The retriever must scope queries strictly to `.helix/cache/embeddings/bge-m3-1024/` under the current `config.workDir`. Cross-repo retrieval is explicitly out of scope. |

### Security & Compliance

- **No secrets in the embedding payload.** Findings and decisions are derived from local source files and prior session output. They may incidentally reference env-var names (`OPENAI_API_KEY`) but never contain secret values; this is already true today before this feature.
- **Local-only by default.** The default `bge-m3-local` provider keeps all content on the developer's machine. This aligns with [OWASP LLM08:2025 — Vector and Embedding Weaknesses](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/), which flags that embedding-inversion attacks may allow partial reconstruction of embedded source text. Any future hosted-provider variant must require an explicit opt-in flag (`allowRemoteEmbedding: true`) and emit a one-time CLI warning that (a) names the destination URL, (b) cites OWASP LLM08:2025, and (c) explicitly states that embedded content may be partially recoverable from vectors transmitted to the provider.
- **Jira credentials.** Read via existing `resolveCredentials()` in `jira-client.ts`. The bootstrap path adds no new credential surface and never logs the token.
- **Cache directory path.** `.helix/cache/embeddings/bge-m3-1024/` is excluded by the existing `.helix/` gitignore entry — no risk of committing local embeddings.

### Performance & Scalability

- Bootstrap adds one Jira HTTP call (~150–300 ms) before session creation. Acceptable.
- Embedding cost: per stage boundary, batch up to ~20 findings + ~5 decisions in one BGE-M3 call (~100–300 ms). Hash-detect ensures unchanged rows are not re-embedded.
- Retrieval: cosine over a JSONL with up to ~10 000 rows scanned in-process is < 50 ms on commodity hardware. Beyond ~50 000 rows the linear scan becomes noticeable; at that point we migrate to sqlite-vss or a vector index — out of scope for v1.
- Prompt budget grows from 3200 → 4800 chars at the three retrieval-gated stages. The 2026-04-05 `agents.md` learning ("Planning Prompt Reduction") cautions against over-stuffing planning prompts; the 50% growth is the smallest increase that meaningfully fits 5+3 ranked chunks. Larger budgets must be justified separately with planning-stage telemetry.

### Reliability & Failure Modes

| Failure                           | Behavior                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jira unreachable / unauth / 404   | `[helix:jira]` warning to stderr; `WorkItem.title = description = "<KEY>"`; `scope = []`; `bootstrapMeta.fallbackReason` records the cause.            |
| BGE-M3 unreachable on persist     | `[helix:embeddings]` warning to stderr; persistence still succeeds; row stays "dirty" and is retried at the next stage boundary.                       |
| BGE-M3 unreachable on retrieve    | Retriever falls back to existing slug-based `loadPriorDoc`; `RetrievalTelemetry.fallback = true`, `embeddingSource = 'fallback-slug'`.                 |
| Model/dim mismatch on read        | Mismatched rows are skipped; one-time per-session warning suggests `helix index rebuild`.                                                              |
| JSONL row exceeds `PIPE_BUF`      | Write-time guard splits the vector into a binary sidecar at `.helix/cache/embeddings/bge-m3-1024/blobs/<id>.bin`; JSONL stores only the relative path. |
| Concurrent CLI sessions           | Append-only writes are POSIX-atomic per line; reads dedupe by `id` (latest row wins).                                                                  |
| `helix index rebuild` interrupted | Rebuild writes to a `<file>.tmp` and renames atomically only on success. Partial state is overwritten on next rebuild.                                 |

### Observability

- **Stderr.** Two new lines per session: one at bootstrap, one at first retrieval. Same `[helix:<module>]` prefix convention as today.
- **Session telemetry.** `Session.bootstrapMeta` (set once); `StageResult.retrieval` (set per retrieval-gated stage). Both serialize naturally into `session.json` and are queryable via the existing MCP control plane reads (`get_session`, `get_slice_packet`).
- **CLI introspection.** `helix index rebuild --dry-run` reports per-file counts of would-be embeddings and stale rows.
- **No new dashboards.** Helix has no observability dashboard; new fields land in existing inspection paths.

### Data Lifecycle

- `.helix/cache/embeddings/bge-m3-1024/` is local, ephemeral, and gitignored. No retention policy. Users delete it manually or via `helix index rebuild` (which overwrites).
- `bootstrapMeta` and `retrieval` telemetry live in `session.json` and inherit the existing session retention behavior.
- No migration is required — Phase 1 ships behind no flag (CLI surface change only). Phase 2 ships with an empty `.helix/cache/embeddings/bge-m3-1024/` directory created on first persist; the retriever returns "no results" until the index has been populated either by forward-going sessions or `helix index rebuild`.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1 — Work-Item Bootstrap ✅ COMPLETE (commit `3a53bd977`, 2026-05-01)

1. **Jira fetch primitive** ✅
   1.1 `getIssue(key)` added to `packages/helix/src/integrations/jira-client.ts`.
   1.2 `JiraIssueClient` interface for DI; failure matrix covered by INT-4 (13 tests).
2. **Bootstrap pure functions** ✅
   2.1 `packages/helix/src/integrations/jira-bootstrap.ts` created with `mapJiraIssueToWorkItem`, `inferScopeFromText`, `enumerateWorkspacePackages`, `isRealJiraKey`.
   2.2 `commit-manager.ts` imports `isRealJiraKey` from shared location.
   2.3 27 unit tests (UT-1..UT-9) in `jira-bootstrap.test.ts`.
3. **CLI wiring** ✅
   3.1 `runAudit`, `runFix`, `runCanary` in `cli.ts` detect Jira key on positional arg and call `bootstrapWorkItemFromCli`.
   3.2 CLI usage strings updated to document `ABLP-KEY | "title"` positional form.
   3.3 6 E2E subprocess tests + 13 integration tests passing.
4. **Telemetry** ✅
   4.1 `Session.bootstrapMeta?: BootstrapMeta` added to `types.ts`.
   4.2 Stderr line emitted + `bootstrapMeta` persisted to `session.json`.
5. **Phase 1 docs sync** ✅
   5.1 `packages/helix/agents.md` appended with 7 bootstrap learnings.
   5.2 Implementation log finalized at `docs/sdlc-logs/helix-work-item-bootstrap/implementation.log.md`.
   5.3 JIRA ABLP-778 updated with commit SHAs.

### Phase 2 — Cross-Session Retrieval (ships after Phase 1 lands and is observed in-use for ≥ 1 week)

6. **Embedding client**
   6.1 Create `packages/helix/src/intelligence/embedding-client.ts` mirroring the `BgeM3` fetch pattern.
   6.2 Unit tests covering batching, timeout, graceful failure.
7. **Embedding index**
   7.1 Create `packages/helix/src/intelligence/embedding-index.ts` with `upsertBatch`, `query`, `rebuild`. JSONL append-only; dedupe-on-read.
   7.2 Hybrid retrieval logic with scope-overlap filter and global-cosine fallback.
   7.3 Hash-detect change tracking for re-embed efficiency.
   7.4 Unit tests for ranking, mismatch handling, dedupe.
8. **Pipeline integration**
   8.1 Replace `loadPriorDoc` calls in `prompt-context.ts:132-133` with `loadRelevantPriorContext`.
   8.2 Expand budget constants (`MAX_PRIOR_CONTEXT_CHARS = 4800`, split 3200/1600).
   8.3 Hook into `session-manager.ts` stage boundaries to batch-enqueue dirty rows.
   8.4 Add `RetrievalTelemetry` to `StageResult` and emit per call.
9. **Maintenance command**
   9.1 Register a new `index` command in the CLI dispatcher switch at `cli.ts:132-148`, alongside the existing `audit` / `fix` / `canary` / `resume` cases.
   9.2 Implement `helix index rebuild [--dry-run]` as the first sub-action under that command.
   9.3 Integration test: rebuild against fixture `docs/sdlc-logs/` directory and verify idempotent output.
10. **Phase 2 docs sync + activation**
    10.1 Update HELIX.md future-work entry #4 to "Done" (or remove).
    10.2 Append `packages/helix/agents.md` with retrieval learnings (recall observations, ranking tradeoffs).

---

## 14. Success Metrics

| Metric                                                                                                                    | Baseline                                               | Target                                             | How Measured                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| % of `helix audit` invocations that omit a positional title (i.e. use the bare Jira key form)                             | 0%                                                     | ≥ 60% within 4 weeks of Phase 1 ship               | Stderr telemetry / `bootstrapMeta.scopeInferenceMethod` distribution across recent sessions                                                                                                                         |
| Median bootstrap latency (Jira fetch + scope infer)                                                                       | N/A (manual entry)                                     | ≤ 500 ms                                           | `bootstrapMeta.jiraFetchLatencyMs`                                                                                                                                                                                  |
| `bootstrapMeta.jiraFetchSuccess = true` rate                                                                              | N/A                                                    | ≥ 95% over rolling 7-day window                    | Same                                                                                                                                                                                                                |
| % of `deep-scan` / `oracle-analysis` / `plan-generation` stages where retrieval produces ≥ 1 cross-session result         | 0% (slug-based loader rarely matches on cross-session) | ≥ 40% within 2 weeks of Phase 2 ship               | `RetrievalTelemetry.topNReturned > 0 && retrieval.embeddingSource = 'bge-m3'`                                                                                                                                       |
| Median retrieval latency at stage boundary                                                                                | N/A                                                    | ≤ 250 ms                                           | `RetrievalTelemetry.latencyMs`                                                                                                                                                                                      |
| Reduction in median tokens consumed per `oracle-analysis` stage on re-audited code areas                                  | Current per-area baseline                              | ≥ 10% reduction (proxy for less re-discovery work) | Cost telemetry already tracked by `cost-accumulator.ts`                                                                                                                                                             |
| % of bootstrap sessions where `inferredScope` is non-empty AND includes the package(s) where session findings concentrate | N/A                                                    | ≥ 70% within 4 weeks of Phase 1 ship               | Cross-reference `bootstrapMeta.inferredScope` against the package distribution of `session.findings[*].files` per session — validates that regex-based scope inference is producing useful signal rather than noise |

---

## 15. Open Questions

1. Should the `helix index rebuild` command also walk and re-embed rows when the `model` field on disk differs from the configured model (auto-migration), or strictly require an explicit `--migrate` flag? Default leans toward explicit-flag to avoid surprise embedding-cost spikes.
2. Should we expose a `search_findings_semantic` tool on the existing Helix MCP control-plane surface (`packages/helix/src/mcp/`)? The scaffolding is straightforward once `EmbeddingIndex` exists, but it adds a new MCP tool that must be documented and version-stable.
3. Is `package` on each row (derived from `files[0]`) the right metadata key for filtering, or should we instead carry the full `files: string[]` and overlap on substring? `files[0]` is faster but loses signal when a finding spans packages.
4. Does the planning-stage prompt budget tolerate the 3200 → 4800 expansion, or should we keep 3200 and just rely on better top-N ranking? This is testable empirically once Phase 2 is live and the agents.md "Planning Prompt Reduction" check can be re-run.
5. **Should the retriever add a lexical (BM25 / TF-IDF) signal alongside cosine for true industry-standard "hybrid" retrieval?** The current Phase-2 design is scope-filter + dense-cosine only. Industry benchmarks (Cody, Cursor, public RAG benchmarks) report ~15–30% recall@10 improvement when BM25 is fused with vector scores via Reciprocal Rank Fusion. Findings/decisions are structured technical prose where exact-keyword matches (function names, error messages, file paths) carry strong signal that dense embeddings can blur. Defer until Phase 2 telemetry shows recall is the limiting factor.
6. **Should findings carry a staleness signal or TTL?** GitHub Copilot's memory system uses 28-day expiry plus live citation verification (does the referenced file still exist at HEAD?). The current spec embeds findings indefinitely — over months, results referencing refactored or deleted code will pollute retrieval. Candidate signals: file-existence check at retrieval time, mtime-based decay, explicit `status === 'fixed'` deprioritization.
7. **Should we adopt a multi-strategy retrieval stack (graph + lexical + vector) instead of vectors-only?** Sourcegraph Cody Enterprise abandoned embeddings entirely in favor of Zoekt (trigram keyword) + graph-based static analysis, citing scalability and security concerns. Aider's repo-map uses tree-sitter + PageRank with no embeddings. For Helix's small finding/decision corpus the dense-vector approach is reasonable, but if Phase 2 adoption stalls (success metrics in §14 don't trend up), switching strategies may be cheaper than tuning the vector path.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                  | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Linear-scan retrieval becomes O(n) noticeable past ~50 000 rows. Migration to sqlite-vss or a binary-vector index is documented but not delivered.                                                                           | Medium   | Open   |
| GAP-002 | No cross-repo retrieval. Sibling repos (`abl-platform-deploy`, `abl-platform-infra`) cannot share learnings without a future cross-repo extension.                                                                           | Low      | Open   |
| GAP-003 | Hosted embedding providers (OpenAI, Voyage) are unsupported in v1. The `embeddingProvider` discriminator leaves room but the contract for `allowRemoteEmbedding` opt-in is not implemented.                                  | Low      | Open   |
| GAP-004 | Bootstrap does not detect ticket renames mid-session. If a Jira ticket summary changes after `helix audit ABLP-51` runs, the session keeps the original snapshot.                                                            | Low      | Open   |
| GAP-005 | Scope inference cap of 5 entries is heuristic. Tickets that legitimately span more areas will be under-scoped; the user can still override with `--scope`.                                                                   | Low      | Open   |
| GAP-006 | Findings have no TTL or staleness signal. Findings about code that has since been refactored or deleted will continue to surface in retrieval until the user manually rebuilds the index. (See Open Question #6.)            | Medium   | Open   |
| GAP-007 | "Hybrid" in the spec means scope-filter + cosine, not the industry-standard BM25 + dense fusion. Lexical signal is absent in v1; recall against keyword-heavy queries will lag a true hybrid system. (See Open Question #5.) | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                        | Coverage Type | Status       | Test File / Note                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ | ---------------------------------------------------------------------------------- |
| 1   | `mapJiraIssueToWorkItem` with happy-path issue → populated WorkItem fields, no overrides                                        | unit          | ✅ DONE (P1) | `packages/helix/src/__tests__/jira-bootstrap.test.ts` (UT-3)                       |
| 2   | `mapJiraIssueToWorkItem` with CLI overrides (title, description, scope) → CLI values win                                        | unit          | ✅ DONE (P1) | Same (UT-7)                                                                        |
| 3   | `inferScopeFromText` matches multiple `apps/*` and `packages/*` mentions, caps at 5                                             | unit          | ✅ DONE (P1) | Same (UT-4, UT-5, UT-6)                                                            |
| 4   | `getIssue(key)` against in-process Jira fake — happy / 401 / 404 / network-timeout each return graceful nullable                | integration   | ✅ DONE (P1) | `packages/helix/src/__tests__/cli-bootstrap.integration.test.ts` (INT-4, 13 tests) |
| 5   | `helix audit ABLP-9001` subprocess against fake Jira → produces session.json with `bootstrapMeta.jiraFetchSuccess=true`         | e2e           | ✅ DONE (P1) | `packages/helix/src/__tests__/cli-bootstrap.e2e.test.ts` (E2E-1)                   |
| 6   | `helix audit <KEY>` against fake Jira with missing creds → still creates session, `jiraFetchSuccess=false`                      | e2e           | ✅ DONE (P1) | Same (E2E-2)                                                                       |
| 7   | `helix resume <id>` after bootstrap → does not re-fetch Jira, WorkItem snapshot intact                                          | e2e           | ✅ DONE (P1) | Same (E2E-5)                                                                       |
| 8   | `EmbeddingIndex.upsertBatch` writes JSONL row matching schema; second call with same content does not duplicate                 | unit          | ⏳ Phase 2   | `packages/helix/src/__tests__/embedding-index.test.ts` (planned)                   |
| 9   | `EmbeddingIndex.query` scope-aware cosine ranking: scope-overlap filter precedes cosine; falls back to global cosine when empty | unit          | ⏳ Phase 2   | Same                                                                               |
| 10  | `EmbeddingIndex.query` returns slug-based fallback when BGE-M3 unreachable                                                      | unit          | ⏳ Phase 2   | Same (with DI'd embedding client)                                                  |
| 11  | `EmbeddingIndex` skips rows with mismatched `model` / `dimensions` and emits one-time warning                                   | unit          | ⏳ Phase 2   | Same                                                                               |
| 12  | `loadRelevantPriorContext` integrates into `prompt-context.ts` and emits `RetrievalTelemetry` on `session.stageHistory`         | unit          | ⏳ Phase 2   | `packages/helix/src/__tests__/prompt-context.test.ts` (planned modify)             |
| 13  | `helix index rebuild` against fixture `docs/sdlc-logs/` produces deterministic JSONL; running twice is idempotent               | integration   | ⏳ Phase 2   | `packages/helix/src/__tests__/index-rebuild.integration.test.ts` (planned)         |

### Testing Notes

All tests follow the `Test Architecture` rules in `CLAUDE.md`:

- No `vi.mock()` of `@agent-platform/*`, `@abl/*`, or relative imports. The Jira fetch boundary and the BGE-M3 fetch boundary are both injected via typed client interfaces (`JiraIssueClient`, `EmbeddingClient`) and substituted with in-memory implementations in tests.
- Pure functions (`mapJiraIssueToWorkItem`, `inferScopeFromText`, `EmbeddingIndex.query`) are tested directly with no harness.
- Integration tests spawn the real CLI as a subprocess and exercise the real session-manager path.
- The `cli-bootstrap.integration.test.ts` and `index-rebuild.integration.test.ts` files MUST exercise the on-disk JSONL store (no in-memory shortcuts) so the POSIX append-atomicity and dedupe-on-read assumptions are validated.
- HTTP boundary tests use a tiny in-process http server (`createServer`) to stand in for Jira and BGE-M3 — no `nock`, no `fetch` global mocking.

> Full testing details: [../../testing/sub-features/helix-work-item-bootstrap.md](../../testing/sub-features/helix-work-item-bootstrap.md)

---

## 18. References

- Parent feature: [helix-autonomous-engineering-harness](../helix-autonomous-engineering-harness.md)
- Sibling sub-feature: [cross-provider-quorum-convergence](cross-provider-quorum-convergence.md)
- Helix overview: `packages/helix/HELIX.md` (future-work entry #4 — Cross-Session Learning)
- Helix contributor brief: `packages/helix/CLAUDE.md`
- Existing BGE-M3 client (reference, not import): `packages/search-ai-internal/src/embedding/bge-m3.ts`
- Oracle decision logs: `docs/sdlc-logs/helix-work-item-bootstrap/feature-spec.log.md`
