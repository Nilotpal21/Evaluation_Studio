# Test Specification: Helix Work-Item Bootstrap & Cross-Session Retrieval (HELIX)

**Feature Spec**: [`docs/features/sub-features/helix-work-item-bootstrap.md`](../../features/sub-features/helix-work-item-bootstrap.md)
**HLD**: _Deliberately skipped per feature owner direction. Architectural decisions in feature-spec §7._
**LLD**: [`docs/plans/2026-05-01-helix-work-item-bootstrap-impl-plan.md`](../../plans/2026-05-01-helix-work-item-bootstrap-impl-plan.md)
**Status**: IN PROGRESS
**Last Updated**: 2026-05-02

---

## Feature Metadata

| Field                            | Value                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doc Type                         | SUB-FEATURE                                                                                                                                                                        |
| Parent Feature                   | [helix-autonomous-engineering-harness](../../features/helix-autonomous-engineering-harness.md)                                                                                     |
| Package(s)                       | `packages/helix`                                                                                                                                                                   |
| Test Stack                       | Vitest (`packages/helix/src/__tests__/`); `pool: 'forks'`, `maxWorkers: 1`, `testTimeout: 20_000`. Subprocess E2E tests use per-test `{ timeout: 60_000 }` overrides.              |
| External Dependencies Under Test | Jira REST `/rest/api/3/issue/{key}` via in-process `node:http` server (random port `{ port: 0 }`); BGE-M3 `/v1/embeddings` via in-process `node:http` server (random port).        |
| Environment Variables Under Test | `JIRA_BASE_URL` / `ATLASSIAN_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` / `ATLASSIAN_API_KEY`, `HELIX_EMBEDDING_BASE_URL`, `HELIX_EMBEDDING_TIMEOUT_MS`, `HELIX_EMBEDDING_DISABLED` |
| CI Surface                       | None — HELIX is excluded from the pnpm workspace and has no GitHub Actions workflow. Tests run locally via `pnpm exec vitest run`.                                                 |
| Coverage Thresholds              | None configured.                                                                                                                                                                   |

---

## Current State

Phase 1 (FR-1..FR-7 — Jira bootstrap) is **COMPLETE** as of 2026-05-01 (commit `3a53bd977`). 47 new tests added; 31 existing tests pass without regression. All Phase 1 acceptance criteria met. Phase 2 (FR-8..FR-15 — BGE-M3 embeddings) is planned for ≥1 week after Phase 1 observability period (per feature spec §13).

---

## 1. Coverage Matrix

Every FR-N from the feature spec maps to at least one scenario row below. Phase 2 rows light up after Phase 1 ships.

| FR    | Description                                                                                  | Unit | Integration | E2E | Manual | Status          | Scenario IDs                                    |
| ----- | -------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | --------------- | ----------------------------------------------- |
| FR-1  | Positional `^[A-Z][A-Z0-9]+-\d+$` triggers Jira-key path; shared `isRealJiraKey` extracted   | ✅   | ✅          | ✅  | —      | ✅ COVERED (P1) | UT-1, UT-2, INT-4, E2E-1                        |
| FR-2  | `getIssue` populates `WorkItem.title` / `description` / `jiraKey`                            | ✅   | ✅          | ✅  | —      | ✅ COVERED (P1) | UT-3, INT-1, INT-4, E2E-1                       |
| FR-3  | `inferScopeFromText` parses `pnpm-workspace.yaml`, dedupes, caps at 5 in description order   | ✅   | —           | ✅  | —      | ✅ COVERED (P1) | UT-4, UT-5, UT-6, E2E-1                         |
| FR-4  | CLI `--description` / `--scope` / etc. override Jira-derived values                          | ✅   | ✅          | ✅  | —      | ✅ COVERED (P1) | UT-7, INT-1, E2E-6, E2E-7                       |
| FR-5  | All Jira failure modes (no creds / 401 / 403 / 404 / network) degrade to key-as-title        | ✅   | ✅          | ✅  | —      | ✅ COVERED (P1) | UT-8, INT-4, E2E-2                              |
| FR-6  | `helix resume` does not re-fetch Jira; WorkItem snapshot preserved                           | —    | ✅          | ✅  | —      | ✅ COVERED (P1) | INT-1, E2E-5                                    |
| FR-7  | `bootstrapMeta` persisted on session.json + stderr line                                      | ✅   | ✅          | ✅  | —      | ✅ COVERED (P1) | UT-9, INT-1, E2E-1                              |
| FR-8  | Hash-detect at persist time; embedding hook fires only at stage boundaries (not per-finding) | ✅   | ✅          | —   | —      | ⏳ Phase 2      | UT-10, INT-2                                    |
| FR-9  | JSONL row schema (`id`, `contentHash`, `model`, `dimensions`, `vector`, metadata)            | ✅   | ✅          | —   | —      | ⏳ Phase 2      | UT-11, UT-19, INT-2, INT-6                      |
| FR-10 | Scope-aware cosine ranking: filter overlap → cosine; global-cosine fallback fills shortfall  | ✅   | ✅          | ✅  | —      | ⏳ Phase 2      | UT-12, UT-13, UT-14, UT-22, UT-23, INT-5, E2E-3 |
| FR-11 | BGE-M3 unreachable → retrieval falls back to slug-based loader; persistence skips embedding  | ✅   | ✅          | —   | —      | ⏳ Phase 2      | UT-15, UT-20, UT-21, INT-3, INT-7, INT-9        |
| FR-12 | `helix index rebuild` walks fixture sdlc-logs; idempotent on re-run                          | —    | ✅          | ✅  | —      | ⏳ Phase 2      | INT-6, INT-10, E2E-4                            |
| FR-13 | Budget split: 3200 chars findings + 1600 chars decisions; 200-line cap preserved             | ✅   | —           | —   | —      | ⏳ Phase 2      | UT-16                                           |
| FR-14 | `RetrievalTelemetry` populated on each retrieval-gated stage entry                           | ✅   | ✅          | ✅  | —      | ⏳ Phase 2      | UT-17, INT-5, E2E-3                             |
| FR-15 | Model/dim mismatch logged once per session with prominent counts; mismatched rows skipped    | ✅   | ✅          | —   | —      | ⏳ Phase 2      | UT-18, INT-8                                    |

### Phase 1 / Phase 2 split

- **Phase 1 (ships first)** — FR-1 through FR-7 + their scenarios (UT-1..UT-9, INT-1, INT-4, E2E-1, E2E-2, E2E-5, E2E-6, E2E-7).
- **Phase 2 (depends on Phase 1)** — FR-8 through FR-15 + their scenarios (UT-10..UT-23, INT-2, INT-3, INT-5..INT-10, E2E-3, E2E-4, E2E-8).

---

## 2. E2E Test Scenarios (8 scenarios — exceeds 5-minimum)

> All E2E scenarios spawn the real Helix CLI as a subprocess (`pnpm exec tsx packages/helix/src/cli.ts ...` or built `helix` binary) against in-process `node:http` Jira and BGE-M3 fakes on random ports. **No `vi.mock` of platform packages, no `nock`, no fetch global mocking, no direct DB or session.json writes.** Each subprocess test wears `{ timeout: 60_000 }`.
>
> **Auth context**: Helix is a developer-side CLI. There is no tenant/project/user data plane. The only auth surface is the Jira credentials (env vars `JIRA_API_TOKEN` / `JIRA_EMAIL`). Each scenario explicitly states its credential context.

### E2E-1 — Bare Jira-key invocation produces a complete session

- **Preconditions**: clean `.helix/sessions/` and `.helix/cache/embeddings/` in a temp working directory; in-process Jira fake configured to return `{ summary: "Audit runtime session lifecycle", description: <ADF mentioning "apps/runtime/src/sessions" + "packages/execution"> }` for `GET /rest/api/3/issue/ABLP-FAKE-1`.
- **Auth context**: `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` set to the fake's address + dummy credentials.
- **Steps**:
  1. Spawn `helix audit ABLP-FAKE-1` as a child process with `cwd` = temp dir.
  2. Wait for exit.
  3. Read the new `session.json` from `.helix/sessions/<id>/`.
- **Expected Result**:
  - Process exits 0 (or matches a normal `helix audit` exit code).
  - `session.workItem.title === "Audit runtime session lifecycle"`.
  - `session.workItem.description` matches `adfToPlainText` of the ticket body.
  - `session.workItem.jiraKey === "ABLP-FAKE-1"`.
  - `session.workItem.scope` contains `"apps/runtime"` and `"packages/execution"` (deterministic match against fixture workspace roots).
  - `session.bootstrapMeta.jiraFetchSuccess === true`.
  - `session.bootstrapMeta.scopeInferenceMethod === "deterministic"`.
  - `session.bootstrapMeta.inferredScope` contains `"apps/runtime"` and `"packages/execution"` (matches `session.workItem.scope` on the deterministic-inference path; together with E2E-7's `inferredScope === []` assertion this two-sided check pins the FR-7 contract).
  - `session.bootstrapMeta.jiraFetchLatencyMs` is a positive number.
  - Stderr contains exactly one `[helix:jira] fetched ABLP-FAKE-1 …` line.
- **Covers**: FR-1, FR-2, FR-3, FR-7.

### E2E-2 — Jira unreachable falls back gracefully

- **Preconditions**: same fixture; Jira fake refuses connection (server not started, or `JIRA_API_TOKEN` deliberately unset).
- **Auth context**: variant (a) all creds unset; variant (b) creds set but server unreachable.
- **Steps**: spawn `helix audit ABLP-FAKE-1`; read session.json.
- **Expected Result**:
  - Process exits 0.
  - `session.workItem.title === "ABLP-FAKE-1"` (key as title fallback).
  - `session.workItem.description === "ABLP-FAKE-1"`.
  - `session.workItem.scope === []`.
  - `session.bootstrapMeta.jiraFetchSuccess === false`.
  - `session.bootstrapMeta.fallbackReason` matches one of: `"credentials-missing"` | `"auth-failed"` | `"not-found"` | `"network-error"`.
  - Stderr contains exactly one `[helix:jira] … proceeding without enrichment` line.
  - The pipeline reaches a non-error state at the next stage tick (verifies fail-soft contract is end-to-end).
- **Covers**: FR-5, FR-7.

### E2E-3 — Cross-session retrieval surfaces a prior finding (Phase 2)

- **Preconditions**:
  - Fixture `findings.md` and `decisions.md` are pre-populated at `packages/helix/src/__tests__/fixtures/sdlc-logs/seed-feature/`, including at least one finding referencing `apps/runtime/src/sessions`. The fixture directory is symlinked or copied into the temp `cwd` as `docs/sdlc-logs/seed-feature/` before the test runs.
  - `helix index rebuild` has been invoked (in a setup step) against that temp `cwd`, walking the fixture markdown and populating `.helix/cache/embeddings/bge-m3-1024/` with consolidated rows. Note: rebuild walks markdown files, not `session.json`. The seed-feature `session.json` itself is not required.
  - In-process BGE-M3 fake returns deterministic vectors (hash-of-text → seeded PRNG → unit vector); reachable on `HELIX_EMBEDDING_BASE_URL`.
  - Jira fake returns a ticket whose description mentions `apps/runtime/src/sessions`.
- **Auth context**: Jira creds set (variant happy-path).
- **Steps**: spawn `helix audit ABLP-FAKE-2`; let the pipeline reach the `deep-scan` stage; read session.json.
- **Expected Result**:
  - Rendered `deep-scan` prompt contains the prior finding's title (verified by inspecting the captured prompt artifact written under `.helix/sessions/<id>/`).
  - `session.stageHistory[<deep-scan>].retrieval.embeddingSource === "bge-m3"`.
  - `session.stageHistory[<deep-scan>].retrieval.topNReturned >= 1`.
  - `session.stageHistory[<deep-scan>].retrieval.fallback === false`.
  - Seed feature's slug differs from the new session's slug — proves cross-session retrieval, not slug-based loading.
- **Covers**: FR-10, FR-14, FR-12 (rebuild precondition).

### E2E-4 — `helix index rebuild` is idempotent

- **Preconditions**: fixture `docs/sdlc-logs/` tree at `packages/helix/src/__tests__/fixtures/sdlc-logs/` with N findings and M decisions across 3 sub-features. BGE-M3 fake reachable.
- **Auth context**: N/A (no Jira interaction).
- **Steps**:
  1. Run `helix index rebuild` to completion; capture JSONL output.
  2. Run `helix index rebuild` again immediately.
- **Expected Result**:
  - First run produces consolidated `findings.jsonl` with N rows and `decisions.jsonl` with M rows under `.helix/cache/embeddings/bge-m3-1024/`.
  - Second run produces JSONL files byte-equal to the first run (deterministic vectors → identical content hashes).
  - Stderr of the second run: `0 new embeddings, N existing rows up-to-date` (or equivalent counts).
- **Covers**: FR-9, FR-12.

### E2E-5 — Resume preserves the original WorkItem snapshot

- **Preconditions**: a session created via `helix audit ABLP-FAKE-3`; Jira fake then mutated to return a different summary/description for the same key.
- **Auth context**: Jira creds set.
- **Steps**: run `helix resume <session-id>` against the mutated fake; read `session.json`.
- **Expected Result**:
  - Session resumes from disk.
  - `session.workItem.title` is unchanged (original summary, NOT the post-mutation value).
  - No new `[helix:jira] fetched` stderr line on resume.
  - `bootstrapMeta` unchanged.
- **Covers**: FR-6.

### E2E-6 — CLI title precedence over Jira summary

- **Preconditions**: Jira fake returns `summary: "Jira summary"` for `ABLP-FAKE-4`.
- **Auth context**: Jira creds set.
- **Steps**: spawn `helix audit "Manual title from CLI" --jira ABLP-FAKE-4`; read session.json.
- **Expected Result**:
  - `session.workItem.title === "Manual title from CLI"` (CLI wins).
  - `session.workItem.description` is filled from the Jira ticket (Jira fills empty fields).
  - `session.workItem.jiraKey === "ABLP-FAKE-4"`.
  - `session.bootstrapMeta.jiraFetchSuccess === true`.
- **Covers**: FR-4.

### E2E-7 — `--scope` overrides inferred scope

- **Preconditions**: Jira fake returns description mentioning `apps/runtime` and `packages/execution`.
- **Auth context**: Jira creds set.
- **Steps**: spawn `helix audit ABLP-FAKE-5 --scope apps/admin,apps/studio`; read session.json.
- **Expected Result**:
  - `session.workItem.scope` is exactly `["apps/admin", "apps/studio"]` (CLI wins; ignores Jira-inferred packages).
  - `session.bootstrapMeta.scopeInferenceMethod === "explicit"`.
  - `session.bootstrapMeta.inferredScope === []`. **Contract** (locked by this test spec): when `--scope` is supplied explicitly, the inference branch is short-circuited and `inferredScope` records nothing. The HLD must implement this contract; the alternative (run inference and record alongside the explicit scope) is rejected because it makes the telemetry field's meaning ambiguous (`inferredScope` would mix "what the CLI used" and "what the CLI overrode"). UT-7 separately covers the precedence chain at the pure-function level.
- **Covers**: FR-4.

### E2E-8 — Concurrent CLI sessions write to the same shard directory without loss

- **Preconditions**: empty `.helix/cache/embeddings/bge-m3-1024/findings/` directory; BGE-M3 fake reachable; 3 distinct fixture findings sets, one per session, each producing K embeddings.
- **Auth context**: N/A (no Jira interaction).
- **Steps**:
  1. Spawn 3 `helix audit "<distinct title>"` subprocesses in parallel against the same `cwd`.
  2. Wait for all to exit (with `{ timeout: 60_000 }`).
  3. Read every shard file under `findings/`.
  4. Concatenate all rows; assert shape and counts.
- **Expected Result**:
  - Total row count across all shards equals `3 × K` exactly (no row loss).
  - Every line in every shard parses as valid JSON (no truncated rows).
  - Read-side dedupe in `EmbeddingIndex.query` returns `3 × K` unique IDs; each shard contains rows owned by exactly one `sessionId`.
- **Why required**: validates the per-session shard architecture from feature spec §7 — the single most architecturally novel piece. Avoids the POSIX `O_APPEND` non-atomicity bug class entirely.
- **Covers**: FR-9 (concurrency invariant of the JSONL layout).

---

## 3. Integration Test Scenarios (10 scenarios — exceeds 5-minimum)

> 6 boundary tests + 4 failure-injection tests. Each runs in-process, calls real production code at the boundary, and uses dependency-injected `JiraIssueClient` / `EmbeddingClient` interfaces with in-memory or in-process-http fake implementations. **No `vi.mock` of platform packages.**

### INT-1 — CLI → SessionManager (session.json round-trip)

- **Boundary**: `cli.ts` `runAudit` → `SessionManager.create` → `session.json`.
- **Setup**: temp `cwd`; in-memory `JiraIssueClient` returning a fixed `JiraAssignedIssue`; minimal `HelixConfig`.
- **Steps**: invoke the bootstrap path with `parsed.positional[0] = "ABLP-INT-1"` and an empty flag set; read the persisted `session.json` from disk.
- **Expected Result**: `session.workItem` round-trips with `bootstrapMeta` populated; reload via `SessionManager.load` produces a value-equal `Session`.
- **Failure Mode**: if the fake `JiraIssueClient` returns `null`, the test asserts the fail-soft path produces a session with key-as-title and `bootstrapMeta.jiraFetchSuccess = false`.
- **Covers**: FR-1, FR-2, FR-4, FR-6, FR-7.

### INT-2 — SessionManager → EmbeddingIndex (stage-boundary hook lifecycle)

- **Boundary**: `SessionManager` stage-completion hook → `EmbeddingIndex.upsertBatch`.
- **Setup**: a real `SessionManager` with a recording in-memory `EmbeddingClient` (records call count + payloads); seed the session with 5 findings via `addFinding`; trigger a stage transition.
- **Steps** (parameterized across all 4 FR-8 stages — `deep-scan`, `oracle-analysis`, `plan-generation`, `implementation`):
  1. Call `addFinding` 5 times during stage `<stage>` execution.
  2. Assert `EmbeddingClient.embedBatch` is called **0 times** during these `addFinding` calls.
  3. Trigger stage transition out of `<stage>`.
  4. Assert `EmbeddingClient.embedBatch` is called **exactly once** with 5 inputs.
  5. Repeat the transition with 0 dirty findings (no content change).
  6. Assert `embedBatch` is called 0 times for the second transition.
- **Expected Result**: for each of the 4 stages, the hook fires only at the stage boundary; batch contains only dirty rows; clean batch is a no-op. Vitest `it.each` (or equivalent table-driven test) runs the body once per stage.
- **Failure Mode**: if `EmbeddingClient` throws, persistence still succeeds and the row stays "dirty" for the next batch (validates FR-11 persistence half).
- **Covers**: FR-8, FR-11.

### INT-3 — EmbeddingIndex → BgeM3Client (DI'd boundary, batch + timeout)

- **Boundary**: `EmbeddingIndex.upsertBatch` → real `BgeM3Client` against an in-process http fake.
- **Setup**: in-process fake serving `POST /v1/embeddings` with deterministic vectors; `BgeM3Client` configured with `baseUrl` = fake's address.
- **Steps**: enqueue 9 inputs with `maxBatchSize: 4`; assert the fake receives 3 chunked requests (4, 4, 1).
- **Expected Result**: chunked batching is correct; `EmbeddingResult.embeddings` has 9 vectors in input order.
- **Failure Mode**: when the fake returns 500 on the second batch, `embedBatch` returns the partial result with a logged warning; `EmbeddingIndex.upsertBatch` keeps the un-embedded rows dirty.
- **Covers**: FR-9 (write path), FR-11 (persistence half).

### INT-4 — `jira-client.getIssue` → in-process Jira fake (full failure matrix)

- **Boundary**: `getIssue(key)` → `jiraFetch` → in-process http fake.
- **Setup**: parameterized fake that can answer with: 200/happy, 401, 403, 404, network timeout, network refuse.
- **Steps**: call `getIssue("ABLP-INT-4")` against each variant.
- **Expected Result**: 200 returns a `JiraAssignedIssue` with `descriptionText` populated. 401/403/404/network all return `null` and emit one `[helix:jira]` stderr line; never throw.
- **Failure Mode**: `resolveCredentials()` returns `null` when env vars are unset → `getIssue` returns `null` immediately without making an HTTP call.
- **Covers**: FR-2, FR-5.

### INT-5 — `prompt-context.loadRelevantPriorContext` → EmbeddingIndex (read path)

- **Boundary**: `buildPromptContext` → `loadRelevantPriorContext` → `EmbeddingIndex.query`.
- **Setup**: populated `EmbeddingIndex` with 100 hand-crafted finding rows (10 referencing `apps/runtime`, 90 in other packages); `WorkItem.scope = ["apps/runtime"]`.
- **Steps**: call `buildPromptContext`; inspect the returned `PromptContextSnapshot`.
- **Expected Result**:
  - `priorFindingsDoc.excerpt` contains content drawn from the 10-row scope-overlap subset.
  - When the scope-overlap subset is reduced to 2 rows, the result has 2 from-scope + 3 global-fallback rows (5 total).
  - Total rendered chars ≤ 3200 for findings, ≤ 1600 for decisions (FR-13 budget split).
  - `RetrievalTelemetry` is recorded on the stage entry: `topNReturned`, `latencyMs`, `fallback: false`, `embeddingSource: "bge-m3"`.
- **Failure Mode**: when `EmbeddingClient` throws, `RetrievalTelemetry.fallback === true` and `embeddingSource === "fallback-slug"`; legacy slug-based loader runs.
- **Covers**: FR-10, FR-11 (retrieve path), FR-13, FR-14.

### INT-6 — `helix index rebuild` → fixture sdlc-logs walker

- **Boundary**: `rebuild` entry point → markdown parser → `EmbeddingIndex.upsertBatch`.
- **Setup**: fixture `docs/sdlc-logs/<slug>/` tree at `packages/helix/src/__tests__/fixtures/sdlc-logs/` with 3 sub-features, each containing a `findings.md` and `decisions.md`.
- **Steps**: invoke `rebuild` programmatically; read the consolidated JSONL files.
- **Expected Result**:
  - Total finding-row count equals the sum of `## ` finding entries across all `findings.md` fixtures.
  - Each row carries the correct `featureSlug` (matching the source directory).
  - Running `rebuild` a second time produces byte-identical JSONL.
- **Failure Mode**: a fixture with a malformed `findings.md` (incomplete frontmatter, unparseable header) is logged as a per-file warning and skipped; rebuild does not abort.
- **Covers**: FR-9, FR-12.

### INT-7 — Failure injection: corrupt JSONL row mid-write

- **Boundary**: `EmbeddingIndex.query` reading a shard file with one truncated row from a crashed prior session.
- **Setup**: fixture shard file containing 9 valid rows + 1 truncated row (file ends mid-line).
- **Steps**: call `EmbeddingIndex.query`; assert the result excludes the truncated row.
- **Expected Result**: 9 rows returned; one stderr warning `[helix:embeddings] skipping malformed row in <path>:<line>`. No throw, no crash.
- **Failure Mode**: same — degrades the result set, never propagates an error.
- **Covers**: FR-9 (read robustness).

### INT-8 — Failure injection: mismatched-model row + prominent counts warning (FR-15)

- **Boundary**: `EmbeddingIndex.query` reading shards with mixed model identities.
- **Setup**: fixture shard files with 12 rows total — 4 rows under `model: "bge-m3"` / `dimensions: 1024` (current); 8 rows under `model: "text-embedding-3-small"` / `dimensions: 1536` (prior). Configured `embeddingProvider.kind === "bge-m3-local"`.
- **Steps**: call `EmbeddingIndex.query` once; then call it a second time within the same process.
- **Expected Result**:
  - First call returns at most 4 rows (only compatible).
  - Stderr contains exactly one warning line of the form `[helix:embeddings] WARNING: 4 of 12 indexed findings are compatible with current model bge-m3-1024 (8 indexed under text-embedding-3-small); run \`helix index rebuild\` to re-embed`.
  - Second call returns at most 4 rows but emits **zero** additional warning lines (one-time per session).
- **Covers**: FR-15.

### INT-9 — Failure injection: permission denied on `.helix/cache/embeddings/`

- **Boundary**: `EmbeddingIndex.upsertBatch` when the cache directory is read-only.
- **Setup**: temp cache directory with `chmod 0444`; otherwise normal flow.
- **Steps**: trigger a stage-boundary embedding write.
- **Expected Result**: write fails; `[helix:embeddings]` stderr warning logged; row stays dirty; pipeline continues; subsequent retrieval falls back to slug-based loader (`fallback === true`).
- **Failure Mode**: same — fail-soft contract holds.
- **Covers**: FR-11.

### INT-10 — Failure injection: empty `findings.md` (frontmatter only)

- **Boundary**: `helix index rebuild` walking a fixture `findings.md` with frontmatter but no findings.
- **Setup**: fixture file with only `# Findings — empty\n` header.
- **Steps**: invoke rebuild.
- **Expected Result**: zero rows for that file; rebuild does not error; stderr indicates `0 findings discovered in <path>`.
- **Covers**: FR-12 robustness.

---

## 4. Unit Test Scenarios

### Pure functions — `packages/helix/src/__tests__/jira-bootstrap.test.ts` (NEW)

- **UT-1** — `isRealJiraKey("ABLP-51")` returns `true`; `isRealJiraKey("abc-1")` / `isRealJiraKey("123-1")` / `isRealJiraKey("ABLP")` / `isRealJiraKey("")` return `false`. Covers FR-1.
- **UT-2** — `isRealJiraKey("AB1-9")` returns `true` (digit allowed after first letter, regression guard against the naive `^[A-Z]+-\d+$` regex). Covers FR-1.
- **UT-3** — `mapJiraIssueToWorkItem` happy path: full issue, empty CLI overrides → WorkItem populated from Jira (title = summary, description = descriptionText). Covers FR-2.
- **UT-4** — `inferScopeFromText` with description `"Audit apps/runtime/src/sessions and packages/execution"` returns `["apps/runtime", "packages/execution"]`. Covers FR-3.
- **UT-5** — `inferScopeFromText` with 6 distinct workspace mentions returns first 5 in description order. Duplicates deduped before cap. Covers FR-3.
- **UT-6** — `inferScopeFromText` with description containing `"../../../etc/passwd"` and `".env"` returns `[]` (path-traversal tokens are ignored — only enumerated workspace roots match). Covers FR-3 + security negative.
- **UT-7** — `mapJiraIssueToWorkItem` precedence matrix: CLI override on each field individually wins over Jira value; absent CLI overrides fall through to Jira. Covers FR-4.
- **UT-8** — `mapJiraIssueToWorkItem` with `issue: null` (Jira fetch failed), `key: "ABLP-99"` → `WorkItem { title: "ABLP-99", description: "ABLP-99", scope: [] }` and `bootstrapMeta.fallbackReason` set. Covers FR-5.
- **UT-9** — `bootstrapMeta` shape conforms to `BootstrapMeta` interface; ISO timestamps; non-negative latency; `scopeInferenceMethod` ∈ `'deterministic' | 'explicit' | 'empty'`. Covers FR-7.

### Pure functions — `packages/helix/src/__tests__/embedding-index.test.ts` (NEW)

- **UT-10** — Hash-detect: `upsertBatch([f1, f2, f3])` records 3 rows; immediate `upsertBatch([f1, f2-modified, f3])` calls `EmbeddingClient.embedBatch` with exactly 1 input (f2 only). Covers FR-8.
- **UT-11** — Row schema: written rows include `id`, `contentHash`, `model`, `dimensions`, `vector`, `severity`, `category`, `files`, `package`, `featureSlug`, `sessionId`, `createdAt`. Covers FR-9.
- **UT-12** — Hand-crafted vectors: 5 finding rows with vectors orthogonal to a query vector except one parallel; `query()` returns the parallel one first. Covers FR-10.
- **UT-13** — Hybrid filter behavior: 10 scope-overlap rows + 90 non-overlap rows; `WorkItem.scope = ["apps/runtime"]`; `topN=5` → all 5 from the overlap subset. Reduce overlap to 2 → result is the 2 overlap + 3 global by cosine. Covers FR-10.
- **UT-14** — Empty-overlap fallback: `WorkItem.scope = ["apps/empty"]`; result is `topN=5` from global cosine ranking only. Covers FR-10.
- **UT-15** — `EmbeddingClient` injected to throw → `query` returns the slug-based fallback document; `RetrievalTelemetry.fallback = true`, `embeddingSource = "fallback-slug"`. Covers FR-11.
- **UT-16** — Budget: rendered findings excerpt ≤ 3200 chars; rendered decisions excerpt ≤ 1600 chars; line cap of 200 enforced. Covers FR-13.
- **UT-17** — Telemetry: every `query` call returns a `RetrievalTelemetry` with `queriedAt` (ISO), non-negative `latencyMs`, integer `topNReturned`, `fallback` boolean, `embeddingSource` enum. Covers FR-14.
- **UT-18** — Mismatched-model warning: 12 rows total (4 current model, 8 prior); two `query` calls in same `EmbeddingIndex` instance produce exactly one stderr warning naming the counts. Covers FR-15.

### Pure functions — `packages/helix/src/__tests__/embedding-client.test.ts` (NEW)

- **UT-19** — Batch chunking: 9 inputs with `maxBatchSize: 4` → 3 sequential POSTs. Covers FR-9 (write path).
- **UT-20** — Timeout: in-process fake delays 200 ms; client configured with `timeoutMs: 50` → call rejects with abort error; caller treats as graceful failure. Covers FR-11.
- **UT-21** — 4xx / 5xx response: client throws structured error; downstream `upsertBatch` swallows and keeps rows dirty. Covers FR-11.

### Updated tests — `packages/helix/src/__tests__/prompt-context.test.ts` (MODIFY)

- Existing 8 tests must continue to pass (the public API of `buildPromptContext` is preserved). Add new tests:
- **UT-22** — `buildPromptContext` with a populated `EmbeddingIndex` produces `priorFindingsDoc` and `priorDecisionsDoc` with rank-ordered content. Covers FR-10.
- **UT-23** — Stage gating preserved: `shouldIncludePriorFindings` returns true for `deep-scan` / `oracle-analysis` / `plan-generation` only. Covers FR-10.

---

## 5. Security & Isolation Tests

> Tenant / project / user isolation is N/A — Helix is a developer-side CLI with no multi-tenant data plane (per feature spec §12). The only isolation boundary is the **local repo** (`config.workDir`). All security tests below validate the per-`workDir` repo isolation, plus adversarial-input handling.

### SEC-1 — Repo isolation: cache scoped to `config.workDir`

- **Setup**: two temp directories `repoA/` and `repoB/`; populate `repoA/.helix/cache/embeddings/bge-m3-1024/` with 5 rows; leave `repoB/.helix/cache/embeddings/` empty.
- **Assert**: an `EmbeddingIndex` instantiated with `workDir = repoB` returns 0 rows on `query`. It does NOT walk into `repoA` even when `repoA` is a sibling of `repoB`.
- **Why**: feature spec §12 mandates "scoped strictly to `.helix/cache/embeddings/bge-m3-1024/` under the current `config.workDir`."

### SEC-2 — All read/write paths rooted under `config.workDir`

- **Setup**: a real `EmbeddingIndex` configured with `workDir = "/tmp/repoA"` and a DI'd `FileSystem` interface (recording wrapper that captures every path passed to `readFile` / `writeFile` / `appendFile` / `mkdir`). The recording wrapper delegates to real `node:fs/promises` for behavior but exposes a `recordedPaths: string[]` for assertions. **No `vi.mock` of `node:fs`.**
- **Assert**:
  - After running `upsertBatch` + `query` end-to-end, every entry in `recordedPaths` starts with `/tmp/repoA/.helix/cache/embeddings/`.
  - As a defense-in-depth assertion, after the run completes, `find` the temp file system and verify no files were created outside `/tmp/repoA/.helix/cache/embeddings/`.

### SEC-3 — Path traversal in Jira description ignored (subprocess E2E)

- **Setup**: Jira fake returns description for `ABLP-EVIL-1` containing `"../../../etc/passwd"`, `"../../node_modules"`, and `"./apps/runtime/src/sessions"`. Temp `cwd` mirrors the fixture workspace at `packages/helix/src/__tests__/fixtures/workspace/`.
- **Auth context**: Jira creds set (variant happy-path).
- **Steps**: spawn `helix audit ABLP-EVIL-1` as a subprocess; read the resulting `session.json` from disk after exit.
- **Assert**:
  - `session.workItem.scope === ["apps/runtime"]` — only the legitimate workspace root appears; path-traversal tokens are entirely absent from the persisted record.
  - `session.bootstrapMeta.inferredScope === ["apps/runtime"]` — same property at the telemetry layer.
  - No file at or under the temp `cwd` was created with a path-traversal segment in its name (asserted by `find <cwd> -path '*..*'` returning empty).
- **Why integration-level**: this is the end-to-end version of UT-6. UT-6 tests the pure function directly; SEC-3 asserts that the path-traversal property holds across the full subprocess pipeline (CLI parse → `getIssue` → `mapJiraIssueToWorkItem` → `inferScopeFromText` → SessionManager → session.json write).

### SEC-4 — Adversarial-large Jira description timeout (in-process integration)

- **Setup**: in-process Jira fake returns a 10 MB description body for `ABLP-LARGE`. The DI'd `JiraIssueClient` is the real `getIssue` wired to that fake, configured with the documented timeout (Jira-equivalent of `HELIX_EMBEDDING_TIMEOUT_MS`).
- **Tier**: in-process. Test calls `getIssue("ABLP-LARGE")` directly — does NOT spawn a subprocess. Lives in `cli-bootstrap.integration.test.ts`, not the `*.e2e.test.ts` file. (Subprocess + RSS measurement adds harness complexity without adding signal: the timeout invariant is observable from the in-process call's wall-clock and resolved value.)
- **Assert**: `getIssue("ABLP-LARGE")` either truncates the response or times out cleanly (returns `null`) within the configured timeout +/- 500 ms slack; no OOM, no unbounded await, no thrown exception. The test's `process.memoryUsage().rss` may be sampled before/after as a sanity check but is informational, not the load-bearing assertion.

### SEC-5 — Symlink in `docs/sdlc-logs/` pointing outside the repo

- **Setup**: fixture `docs/sdlc-logs/` contains a symlink `external/` → `/tmp/evil/`. `/tmp/evil/findings.md` contains adversarial content.
- **Assert**: `helix index rebuild` either (a) does not traverse the symlink, or (b) errors clearly with `[helix:rebuild] refusing to follow symlink <path>`. Adversarial findings never appear in the resulting JSONL.
- **Why**: prevents exfiltration of unrelated local-machine files into the embedding store.

### SEC-6 — No tokens / secrets logged

- **Setup**: env vars set with non-trivial `JIRA_API_TOKEN` value; spawn `helix audit ABLP-FAKE-1`.
- **Assert**: capture stderr; assert no stderr line contains the token value (verbatim or substring of length ≥ 8). Hooks into existing `[helix:jira]` logging conventions; regression guard for accidental token interpolation.

---

## 6. Performance & Load Tests

Out of scope for v1 CI. The retrieval p50 ≤ 250 ms target (feature spec §14) is validated via production telemetry (`RetrievalTelemetry.latencyMs`) only — wall-clock CI assertions are flaky across machines.

**Recommended manual benchmark before Phase 2 ship**: build a fixture `EmbeddingIndex` with 1 000 / 5 000 / 10 000 rows of synthetic 1024-dim vectors and measure `query` latency on the maintainer's local machine. Document results in `docs/sdlc-logs/helix-work-item-bootstrap/perf-baseline.md`. Required threshold: p50 < 250 ms at 10 K rows.

---

## 7. Form Error & Wiring Verification

**N/A — CLI-only feature.** The skill mandates form-error E2E coverage for "any feature with a form" and a wiring-verification scenario for "any feature with a new Studio API route." This feature has neither: no Studio UI, no Studio API routes, no Runtime API routes (per feature spec §8). The CLI subprocess E2E tests (E2E-1 through E2E-8) ARE the wiring verification — each spawns the real Helix CLI binary, exercises the real `cli.ts` dispatcher / `SessionManager` / `prompt-context.ts` / `EmbeddingIndex` chain end-to-end, and asserts the production pipeline reaches a non-error state.

### Production Wiring Verification (CLI-equivalent)

| Wiring                                                                                                                | Verification                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts` `runAudit` / `runFix` / `runCanary` call the Jira-key detector before constructing WorkItem                  | E2E-1 asserts `WorkItem` fields are populated from Jira data via the real subprocess.                                                               |
| `cli.ts` registers the new `index` command in the dispatcher switch at `cli.ts:132-148`                               | `helix --help` output (captured in INT-6 setup) contains `index rebuild`; `helix index rebuild --dry-run` exits 0.                                  |
| `prompt-context.ts:132-133` calls `loadRelevantPriorContext` (not `loadPriorDoc`) at the three retrieval-gated stages | E2E-3 inspects rendered `deep-scan` prompt; cross-slug findings appear; `RetrievalTelemetry.embeddingSource === "bge-m3"`.                          |
| `session-manager.ts` enqueues dirty findings/decisions to `EmbeddingIndex` at stage boundary (not per-finding)        | INT-2 counts `EmbeddingClient.embedBatch` calls per stage transition vs per `addFinding`.                                                           |
| `getIssue(key)` is exported from `jira-client.ts`                                                                     | TypeScript barrel-export test (UT-1 neighbor) asserts the export exists with the documented signature returning `JiraAssignedIssue \| null`.        |
| `BootstrapMeta` and `RetrievalTelemetry` interfaces are exported from `types.ts`                                      | Type-only test asserts shapes; serialization round-trips via `JSON.parse(JSON.stringify(value))` (UT-9, UT-17).                                     |
| `commit-manager.ts` imports `isRealJiraKey` from the new shared location (no redeclaration)                           | Static check: `grep -c "function isRealJiraKey" packages/helix/src/pipeline/commit-manager.ts` returns 0; existing `commit-manager.test.ts` passes. |

---

## 8. Test Infrastructure

### Required services

- None at runtime. Both Jira and BGE-M3 are exercised via in-process `node:http` fakes on random ports.

### Test fixtures

| Fixture                                                      | Purpose                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `packages/helix/src/__tests__/fixtures/workspace/`           | Mirrors `apps/<name>/` and `packages/<name>/` directory layout for `enumerateWorkspacePackages` tests. |
| `packages/helix/src/__tests__/fixtures/sdlc-logs/`           | 3 sub-feature directories with seed `findings.md` and `decisions.md` files for `helix index rebuild`.  |
| `packages/helix/src/__tests__/fixtures/jira-fake.ts`         | Reusable Jira fake server factory (returns `{ start(), stop(), urlBase, setResponse(key, payload) }`). |
| `packages/helix/src/__tests__/fixtures/bge-m3-fake.ts`       | Reusable BGE-M3 fake (deterministic vectors via seeded PRNG keyed on input text hash).                 |
| `packages/helix/src/__tests__/fixtures/sdlc-logs-malformed/` | Edge-case fixture: corrupt JSONL, malformed `findings.md`, empty findings file, symlink-out-of-repo.   |

### Data seeding

- All seed data is committed to the fixtures directory. No DB seeding (no DB exists).
- Each test starts from an empty temp `cwd` (`mkdtemp`) and uses fixture sdlc-logs as the seed source for rebuild tests.

### Environment variables

- Tests set `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` to fake-server values via `process.env` mutation inside the test (subject to vitest cleanup hooks).
- `HELIX_EMBEDDING_BASE_URL` set to the BGE-M3 fake's URL.
- `HELIX_EMBEDDING_DISABLED=1` exercised in a dedicated test of FR-11 retrieval-disable path.

### CI configuration

- HELIX is excluded from the pnpm workspace and has no GitHub Actions workflow. Tests run locally via `pnpm exec vitest run` from `packages/helix/`.
- Subprocess E2E tests invoke the CLI via `TSX_BIN` resolved from repo-root `node_modules/.bin/tsx` (NOT `pnpm exec tsx` — pnpm workspace resolution fails from a tempdir cwd). `REPO_ROOT = resolve(HELIX_ROOT, '..', '..')` is the resolution anchor.

---

## 9. Test File Mapping

| Test File                                                             | Type        | Status                 | Covers                                                           |
| --------------------------------------------------------------------- | ----------- | ---------------------- | ---------------------------------------------------------------- |
| `packages/helix/src/__tests__/jira-bootstrap.test.ts`                 | unit        | ✅ DONE (P1, 27 tests) | UT-1..UT-9 → FR-1, FR-2, FR-3, FR-4, FR-5, FR-7                  |
| `packages/helix/src/__tests__/cli-bootstrap.integration.test.ts`      | integration | ✅ DONE (P1, 13 tests) | INT-1, INT-4, SEC-4 → FR-1, FR-2, FR-4, FR-5, FR-6, FR-7         |
| `packages/helix/src/__tests__/cli-bootstrap.e2e.test.ts`              | e2e         | ✅ DONE (P1, 6 tests)  | E2E-1, E2E-2, E2E-5, E2E-6, E2E-7, SEC-3 → FR-1..FR-7 end-to-end |
| `packages/helix/src/__tests__/security-isolation.test.ts`             | security    | ✅ DONE (P1, 1 test)   | SEC-6 (Phase 1); SEC-1, SEC-2 planned for Phase 2                |
| `packages/helix/src/__tests__/embedding-index.test.ts`                | unit        | ⏳ Phase 2             | UT-10..UT-18 → FR-8, FR-9, FR-10, FR-11, FR-13, FR-14, FR-15     |
| `packages/helix/src/__tests__/embedding-client.test.ts`               | unit        | ⏳ Phase 2             | UT-19, UT-20, UT-21 → FR-9 (write path), FR-11                   |
| `packages/helix/src/__tests__/prompt-context.test.ts` (MODIFY)        | unit        | ⏳ Phase 2             | UT-22, UT-23 (existing tests preserved) → FR-10, stage gating    |
| `packages/helix/src/__tests__/embedding-pipeline.integration.test.ts` | integration | ⏳ Phase 2             | INT-2, INT-3, INT-5, INT-7, INT-8, INT-9 → FR-8..FR-15           |
| `packages/helix/src/__tests__/index-rebuild.integration.test.ts`      | integration | ⏳ Phase 2             | INT-6, INT-10 → FR-9, FR-12                                      |
| `packages/helix/src/__tests__/cross-session-retrieval.e2e.test.ts`    | e2e         | ⏳ Phase 2             | E2E-3 → cross-session retrieval surfaces a prior finding         |
| `packages/helix/src/__tests__/index-rebuild.e2e.test.ts`              | e2e         | ⏳ Phase 2             | E2E-4, SEC-5 → idempotent rebuild + symlink-out-of-repo refusal  |
| `packages/helix/src/__tests__/concurrent-shards.e2e.test.ts`          | e2e         | ⏳ Phase 2             | E2E-8 → per-session JSONL shard concurrency invariant            |

**Phase 1**: 4 new test files (47 tests). **Phase 2**: 8 new/modified files (planned).

> **Tier naming convention.** `*.test.ts` = unit; `*.integration.test.ts` = in-process integration (real production code at boundary, DI'd external clients); `*.e2e.test.ts` = subprocess CLI E2E against in-process http fakes. Vitest pattern matching (`vitest run --testPathPattern`) lets CI or local devs filter by tier when desired. All tiers run by default under `pnpm exec vitest run` and inherit the `pool: 'forks'`, `maxWorkers: 1` config. E2E files use per-test `{ timeout: 60_000 }` overrides.

---

## 10. Open Testing Questions

1. Should `concurrent-shards.integration.test.ts` (E2E-8) live in a separate suite skipped by default and run only when `RUN_SLOW_TESTS=1`? It is the slowest test (~5–10 s with 3 subprocesses). Default leans toward including it in the default suite — value > cost — but if local-dev wall-clock matters, the gate is cheap to add.
2. Is the deterministic BGE-M3 fake (seeded PRNG) sufficiently stable across Node versions? If `Math.random` semantics ever shift (extremely unlikely), the recorded test vectors could drift. Mitigation: use a deterministic hash (e.g., `node:crypto` SHA-256 → fixed-width float extraction) instead of `Math.random` from the seed. Defer until first flake observed.
3. Should the perf baseline (`docs/sdlc-logs/helix-work-item-bootstrap/perf-baseline.md`) become a CI artifact in a future iteration? Currently manual; if Phase 2 adoption reveals latency variance, formalize.

---

## Status: IN PROGRESS

Phase 1 (FR-1..FR-7) coverage is COMPLETE as of 2026-05-01. Phase 2 (FR-8..FR-15) is planned after ≥1 week observability period. Status flips to STABLE once all 15 FR rows are GREEN and Phase 2 E2E tests pass.
