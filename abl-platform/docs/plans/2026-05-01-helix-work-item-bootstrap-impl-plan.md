# LLD: Helix Work-Item Bootstrap & Cross-Session Retrieval

**Feature Spec**: [`docs/features/sub-features/helix-work-item-bootstrap.md`](../features/sub-features/helix-work-item-bootstrap.md)
**HLD**: _Deliberately skipped per feature owner direction._ Architectural decisions live in feature-spec §7 and test-spec "locked contracts."
**Test Spec**: [`docs/testing/sub-features/helix-work-item-bootstrap.md`](../testing/sub-features/helix-work-item-bootstrap.md)
**Audit Log**: [`docs/sdlc-logs/helix-work-item-bootstrap/lld.log.md`](../sdlc-logs/helix-work-item-bootstrap/lld.log.md)
**Jira**: [ABLP-778](https://kore-platform.atlassian.net/browse/ABLP-778)
**Status**: IN PROGRESS (Phase 1 complete 2026-05-01; Phase 2 pending)
**Date**: 2026-05-01

---

## 0. Source Survey — Anchors That Shape The Plan

Two repo facts discovered during pre-LLD survey are load-bearing for the design:

1. **`persistFindings` / `persistDecisions` fire once at pipeline-complete, not per-finding.** `pipeline-engine.ts:680-681` is the only call site; `addFinding`/`addDecision` only call `this.persist(session)` (writes session.json), not the markdown persisters. Consequence: `contentHash` cannot be computed at "persist" time as the feature spec implied — it must be computed lazily inside the embedding hook. (See D-L8.)
2. **`pipeline-engine.ts` has 3 divergent `stage-complete` journal sites** — `:741`, `:2583`, `:2730` — plus 3 `stageHistory.push` sites at `:512`, `:543`, `:737`. The journal sites and push sites do NOT pair 1-to-1: the skip branch at `:737` has both a push AND a paired journal at `:741`; the skip branch at `:512` has only a push (no journal); the main path at `:543` has a push but the matching journal lives inside `executeStage` at `:2583`. Hooking the embedding callback into any one of these naturally misses the others. The LLD adopts a narrow `onStageCompleted()` method (D-L6) that fires ONLY the embedding hook from each of the 3 push sites; the journal call sites are left untouched.
3. **`helix` is excluded from `pnpm-workspace.yaml`** (`!packages/helix`). The yaml that `inferScopeFromText` reads is the **target repo's** yaml resolved off `config.workDir`, not Helix's own.
4. **Feature-spec §9 shard layout note (LLD supersedes).** The feature-spec §9 Data Model code block shows a flat layout (`findings.jsonl`, `decisions.jsonl` directly under `.helix/cache/embeddings/bge-m3-1024/`); the LLD-authoritative layout (D-L1) is per-session shards under `findings/<sessionId>.jsonl` and `decisions/<sessionId>.jsonl`, with `helix index rebuild` producing the consolidated flat files alongside the per-session shards. Implementer: follow this LLD, not feature-spec §9. The feature spec will be reconciled in `/post-impl-sync`.

---

## 1. Design Decisions

### Decision Log

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Alternatives Rejected                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-L1  | Custom per-session shard JSONL store at `.helix/cache/embeddings/bge-m3-1024/{findings,decisions}/<sessionId>.jsonl`.                                                                                                                                                                                                                                                                | Zero new deps; full control over shard layout, compaction, mtime cache. Concurrency safe by construction (no shared writer).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `vectra` (file-per-item is hostile to rebuild compaction); `lancedb` (native deps); `sqlite-vec` (build complexity).                                                                                        |
| D-L6  | Add a narrow private method `onStageCompleted(session, stage, result)` to `PipelineEngine` that ONLY fires the embedding hook (no journal, no `stageHistory.push`). Call it from each of the 3 `stageHistory.push` sites (`:512`, `:543`, `:737`) right after the push. Existing `stage-complete` journal sites (`:741`, `:2583`, `:2730`) remain untouched — they journal as today. | Prevents the divergent-sites bug for the embedding hook without touching the journal. True zero-behavior-change for existing journals: skip-branch and fail-result paths keep their current (no-journal) behavior. The narrowness also avoids the LLD-R1 finding that bundling the journal would silently add new journal events on skip/fail paths.                                                                                                                                                                                                                               | Bundling journal + hook into one method (LLD-R1 HIGH 1+2: would add new journal events on `:512` skip path and on failed-result pushes); hook inline at `:543` only (LLD-R1 confirms misses `:512`/`:737`). |
| D-L7  | Embedding hook lives on `EmbeddingIndex.notifyStageComplete(session, stage)`.                                                                                                                                                                                                                                                                                                        | SRP — embedding-domain logic stays on the embedding module. `pipeline-engine.ts` already 2700+ LOC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Inline in `pipeline-engine.ts` (LOC bloat); on `SessionManager` (mixes concerns).                                                                                                                           |
| D-L8  | `contentHash` (SHA-256) computed lazily inside `EmbeddingIndex.notifyStageComplete`, not at `addFinding`/`addDecision` time.                                                                                                                                                                                                                                                         | Avoids per-finding hash overhead. `Finding`/`Decision` types stay minimal (no `contentHash` field). All embedding state lives on the `EmbeddingIndex` instance.                                                                                                                                                                                                                                                                                                                                                                                                                    | Compute at `addFinding` (per-finding overhead, type pollution); compute at `persistFindings` (wrong call frequency — see §0).                                                                               |
| D-L9  | `loadRelevantPriorContext(session, config, embeddingIndex?)` exported from `prompt-context.ts`, replacing `loadPriorDoc` at `:132-133`.                                                                                                                                                                                                                                              | Direct in-place replacement in the same module. When `embeddingIndex` is `undefined`, falls back to existing slug-based behavior — preserves test back-compat.                                                                                                                                                                                                                                                                                                                                                                                                                     | New module (extra import hop); on `EmbeddingIndex` (mixes prompt-context concerns).                                                                                                                         |
| D-L10 | `EmbeddingIndex` constructed once in `PipelineEngine.run()` before the stage loop; passed as a parameter to `buildPromptContext` and called via `onStageCompleted` after each `stageHistory.push`.                                                                                                                                                                                   | `PipelineEngine` owns the stage lifecycle. Avoids polluting `Session` (which serializes to JSON) with a non-serializable reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                | Stored on `Session` (non-serializable); lazy in `prompt-context.ts` (would not fire stage hook).                                                                                                            |
| D-L11 | `getIssue(key, client?: JiraIssueClient)` — `client` optional, defaults to a private production singleton. `JiraIssueClient` is a single-method port (`getIssue` only).                                                                                                                                                                                                              | Helix has a precedent for a typed JIRA test-port: `DriftJiraClient` in `drift-jira-adapter.ts:167` is a 3-method interface used by drift-sync tests. The bootstrap path needs only one method (`getIssue`), so `JiraIssueClient` is intentionally narrower — same DI shape as `DriftJiraClient`, scaled to the bootstrap surface. **Note: this introduces a second JIRA test-port interface.** A future cleanup could collapse them into one shared `JiraIssueClient` interface that `DriftJiraClient` extends, but doing it inside this feature would expand scope unnecessarily. | Class with constructor (heavier than a single-method boundary deserves); reuse `DriftJiraClient` (forces 2 unused methods on the bootstrap caller).                                                         |
| D-L12 | Exported `BgeM3Client` interface + `createBgeM3Client(config)` factory; `EmbeddingIndex` constructor takes the client as a required parameter.                                                                                                                                                                                                                                       | Richer boundary (`embedBatch`, `healthCheck`) justifies an interface. Tests pass an in-memory implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Optional fn parameter (would need to thread through `upsertBatch` and `rebuild` and `notifyStageComplete`).                                                                                                 |
| D-L13 | Existing `session.json` files load with `bootstrapMeta = undefined` and `retrieval = undefined`. No migration script.                                                                                                                                                                                                                                                                | Both fields typed `?` optional in TypeScript; `JSON.parse` simply omits them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Migration script (unnecessary for optional fields); reject old sessions (breaking).                                                                                                                         |
| D-L14 | `case 'index'` placed between `drift` and `jira` in the CLI switch (`cli.ts:131-175`).                                                                                                                                                                                                                                                                                               | Groups maintenance/integration commands together (`drift`, `index`, `jira`). The dispatcher already organizes pipeline ops first, then status, then integration.                                                                                                                                                                                                                                                                                                                                                                                                                   | Alphabetical (breaks the implicit grouping); last (no semantic reason).                                                                                                                                     |

### Key Interfaces & Types

```typescript
// packages/helix/src/types.ts — additions

export interface BootstrapMeta {
  jiraKey?: string;
  jiraFetchSuccess: boolean;
  jiraFetchLatencyMs?: number;
  scopeInferenceMethod: 'deterministic' | 'explicit' | 'empty';
  inferredScope: string[];
  fallbackReason?: 'credentials-missing' | 'auth-failed' | 'not-found' | 'network-error';
}

export interface RetrievalTelemetry {
  queriedAt: string; // ISO timestamp
  topNReturned: number;
  latencyMs: number;
  fallback: boolean;
  embeddingSource: 'bge-m3' | 'fallback-slug';
}

// bootstrapMeta lives on Session, NOT on WorkItem — matches the test-spec assertions
// (E2E-1: `session.bootstrapMeta.jiraFetchSuccess === true`). WorkItem stays minimal —
// it represents the work to do, not how the work was assembled.
export interface Session {
  // ... existing fields (workItem, findings, decisions, stageHistory, etc.)
  bootstrapMeta?: BootstrapMeta; // NEW, optional — set once at create() from the bootstrap orchestrator
}

export interface StageResult {
  // ... existing fields
  retrieval?: RetrievalTelemetry; // NEW, optional — populated for retrieval-gated stages only
}
```

```typescript
// packages/helix/src/integrations/jira-bootstrap.ts — new module

// Re-export of canonical regex helper. commit-manager.ts imports from here.
export function isRealJiraKey(s: string): boolean;

export function mapJiraIssueToWorkItem(
  issue: JiraAssignedIssue | null,
  jiraKey: string,
  cliOverrides: Partial<Pick<WorkItem, 'title' | 'description' | 'scope'>>,
  workspacePackages: string[],
): { workItem: Partial<WorkItem>; bootstrapMeta: BootstrapMeta };

export function inferScopeFromText(text: string, workspacePackages: string[]): string[];

export async function enumerateWorkspacePackages(workDir: string): Promise<string[]>;
```

```typescript
// packages/helix/src/integrations/jira-client.ts — additions

export interface JiraIssueClient {
  getIssue(key: string): Promise<JiraAssignedIssue | null>;
}

export async function getIssue(
  key: string,
  client?: JiraIssueClient, // optional DI for tests; default = production singleton
): Promise<JiraAssignedIssue | null>;
// Endpoint: GET rest/api/3/issue/{key}; returns JiraAssignedIssue with descriptionText pre-computed via private adfToPlainText
```

```typescript
// packages/helix/src/intelligence/embedding-client.ts — new module

export interface BgeM3Client {
  readonly modelId: string; // "bge-m3"
  readonly dimensions: number; // 1024
  embedBatch(inputs: string[]): Promise<EmbeddingResult>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface EmbeddingResult {
  embeddings: number[][];
  totalTokens: number;
  model: string;
  dimensions: number;
}

export function createBgeM3Client(config: {
  baseUrl?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
}): BgeM3Client;
```

```typescript
// packages/helix/src/intelligence/embedding-index.ts — new module

export interface EmbeddingRow {
  id: string;
  contentHash: string;
  model: string;
  dimensions: number;
  vector: number[];
  // Discriminated metadata
  kind: 'finding' | 'decision';
  severity?: FindingSeverity;
  category?: FindingCategory;
  stage?: StageType;
  classification?: 'ANSWERED' | 'INFERRED' | 'DECIDED' | 'AMBIGUOUS';
  files: string[];
  package: string;
  featureSlug: string;
  sessionId: string;
  createdAt: string;
}

export interface QueryRequest {
  scope: string[]; // session.workItem.scope
  queryText: string; // text to embed for cosine
  topNFindings: number; // default 5
  topNDecisions: number; // default 3
}

export interface QueryResult {
  findings: EmbeddingRow[];
  decisions: EmbeddingRow[];
  telemetry: RetrievalTelemetry;
}

export class EmbeddingIndex {
  // Identity/context grouped first; dependencies grouped second — matches the CommitManager
  // options-bag pattern in commit-manager.ts but with semantic grouping for readability.
  constructor(opts: {
    // Identity/context
    workDir: string; // .helix/cache/embeddings/<modelDir>/ rooted here
    sessionId: string;
    // Dependencies
    client: BgeM3Client;
    fileSystem?: FileSystem; // DI'd for SEC-2 path-rooting tests; defaults to node:fs/promises wrapper
  });

  async notifyStageComplete(session: Session, stage: StageDefinition): Promise<void>;
  async query(request: QueryRequest): Promise<QueryResult>;
  async rebuild(opts: { dryRun?: boolean }): Promise<RebuildResult>;
}

export interface RebuildResult {
  filesScanned: number;
  rowsWritten: number;
  rowsSkipped: number;
  durationMs: number;
}

// Recording wrapper for SEC-2; production code uses node:fs/promises directly via this interface
export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  appendFile(path: string, contents: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
}
```

### Module Boundaries

| Module                                   | Responsibility                                                                                                                                                                                                                                        | Depends On                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `integrations/jira-bootstrap.ts` (new)   | Pure functions: regex check, plaintext scope inference, ADF→WorkItem mapping, workspace enumeration.                                                                                                                                                  | `integrations/jira-client.ts` types (no impure calls).                |
| `integrations/jira-client.ts` (modify)   | Adds `getIssue(key, client?)` returning `JiraAssignedIssue` with `descriptionText` pre-computed.                                                                                                                                                      | Existing `jiraFetch`, `resolveCredentials`, private `adfToPlainText`. |
| `intelligence/embedding-client.ts` (new) | Fetch wrapper to BGE-M3; batch + timeout + healthcheck.                                                                                                                                                                                               | `node:fetch` only.                                                    |
| `intelligence/embedding-index.ts` (new)  | Per-session JSONL shard store; cosine retrieval; rebuild walker; stage-complete hook.                                                                                                                                                                 | `embedding-client.ts`, `node:fs/promises`, `node:crypto`.             |
| `pipeline/prompt-context.ts` (modify)    | `loadRelevantPriorContext` replaces `loadPriorDoc`; budget split 3200/1600.                                                                                                                                                                           | `embedding-index.ts` (optional param).                                |
| `session/session-manager.ts` (modify)    | `create(workItem, pipeline, options?)` extended with optional `options.bootstrapMeta`; persists it on `Session.bootstrapMeta` (NOT on `WorkItem`).                                                                                                    | `types.ts BootstrapMeta`.                                             |
| `pipeline/pipeline-engine.ts` (modify)   | Constructs `EmbeddingIndex`; new narrow `onStageCompleted` private method that fires the embedding hook only (no journal, no push); called from each of the 3 `stageHistory.push` sites. The 3 existing `stage-complete` journal sites are untouched. | `embedding-index.ts`.                                                 |
| `pipeline/commit-manager.ts` (modify)    | Imports `isRealJiraKey` from `jira-bootstrap.ts` (no behavior change).                                                                                                                                                                                | `integrations/jira-bootstrap.ts`.                                     |
| `cli.ts` (modify)                        | Detects positional Jira key; registers `index` subcommand.                                                                                                                                                                                            | `integrations/jira-bootstrap.ts`, `intelligence/embedding-index.ts`.  |

---

## 2. File-Level Change Map

**New test-fixtures pattern note.** `packages/helix/src/__tests__/fixtures/` is a new test-organization pattern for Helix. Existing tests use inline fakes (e.g. `class FakeJiraClient` declared at the top of `drift-sync-command.test.ts:20` and `drift-sync-e2e.test.ts:54`) and runtime `mkdtemp()` for ephemeral dirs (`prompt-context.test.ts:23`). The bootstrap+retrieval feature spans 4+ test files that share the same Jira and BGE-M3 fakes plus a workspace tree fixture, so reusable fixture modules are justified. **The existing inline-fake pattern is NOT migrated retroactively** — `drift-sync-*` tests stay as-is; only the new bootstrap/retrieval tests use the `fixtures/` directory.

### New Files (Phase 1)

| File                                                                     | Purpose                                                          | LOC Estimate |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------ |
| `packages/helix/src/integrations/jira-bootstrap.ts`                      | Pure functions + `isRealJiraKey` re-export                       | ~180         |
| `packages/helix/src/__tests__/jira-bootstrap.test.ts`                    | UT-1..UT-9 unit tests                                            | ~250         |
| `packages/helix/src/__tests__/cli-bootstrap.integration.test.ts`         | INT-1, INT-4, SEC-4                                              | ~280         |
| `packages/helix/src/__tests__/cli-bootstrap.e2e.test.ts`                 | E2E-1, E2E-2, E2E-5, E2E-6, E2E-7, SEC-3                         | ~320         |
| `packages/helix/src/__tests__/security-isolation.test.ts` (Phase 1 part) | SEC-3 (handled in cli-bootstrap.e2e), SEC-6 secret-logging guard | ~80          |
| `packages/helix/src/__tests__/fixtures/jira-fake.ts`                     | Reusable in-process Jira fake                                    | ~120         |
| `packages/helix/src/__tests__/fixtures/workspace/`                       | Fixture workspace tree (apps/admin, apps/runtime, packages/...)  | (dirs)       |

### New Files (Phase 2)

| File                                                                          | Purpose                                                         | LOC Estimate |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `packages/helix/src/intelligence/embedding-client.ts`                         | `BgeM3Client` interface + `createBgeM3Client` factory           | ~200         |
| `packages/helix/src/intelligence/embedding-index.ts`                          | `EmbeddingIndex` class — shards, cosine, rebuild, stage hook    | ~520         |
| `packages/helix/src/__tests__/embedding-client.test.ts`                       | UT-19, UT-20, UT-21                                             | ~180         |
| `packages/helix/src/__tests__/embedding-index.test.ts`                        | UT-10..UT-18                                                    | ~480         |
| `packages/helix/src/__tests__/embedding-pipeline.integration.test.ts`         | INT-2, INT-3, INT-5, INT-7, INT-8, INT-9                        | ~420         |
| `packages/helix/src/__tests__/index-rebuild.integration.test.ts`              | INT-6, INT-10                                                   | ~220         |
| `packages/helix/src/__tests__/cross-session-retrieval.e2e.test.ts`            | E2E-3                                                           | ~180         |
| `packages/helix/src/__tests__/index-rebuild.e2e.test.ts`                      | E2E-4, SEC-5                                                    | ~180         |
| `packages/helix/src/__tests__/concurrent-shards.e2e.test.ts`                  | E2E-8                                                           | ~160         |
| `packages/helix/src/__tests__/security-isolation.test.ts` (Phase 2 expansion) | SEC-1, SEC-2 (DI'd FileSystem)                                  | ~140         |
| `packages/helix/src/__tests__/fixtures/bge-m3-fake.ts`                        | Reusable in-process BGE-M3 fake (deterministic vectors)         | ~140         |
| `packages/helix/src/__tests__/fixtures/sdlc-logs/`                            | 3 sub-feature dirs with seed `findings.md` + `decisions.md`     | (dirs)       |
| `packages/helix/src/__tests__/fixtures/sdlc-logs-malformed/`                  | Edge-case fixture (corrupt JSONL, malformed md, empty, symlink) | (dirs)       |

### Modified Files (Phase 1)

| File                                             | Change Description                                                                                                                                                                                                                                                                                                                                                                                  | Risk |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/helix/src/integrations/jira-client.ts` | Add public `getIssue(key, client?)` returning `JiraAssignedIssue` with `descriptionText` pre-computed via private `adfToPlainText`.                                                                                                                                                                                                                                                                 | Low  |
| `packages/helix/src/pipeline/commit-manager.ts`  | Replace local `isRealJiraKey` (line 356-358) with `import { isRealJiraKey } from '../integrations/jira-bootstrap'`.                                                                                                                                                                                                                                                                                 | Low  |
| `packages/helix/src/types.ts`                    | Add `BootstrapMeta` interface; add optional `bootstrapMeta?: BootstrapMeta` to **`Session`** (not `WorkItem` — matches test-spec E2E-1 assertion `session.bootstrapMeta.jiraFetchSuccess`).                                                                                                                                                                                                         | Low  |
| `packages/helix/src/cli.ts`                      | In `runAudit`/`runFix`/`runCanary`: detect `parsed.positional[0]` matching `isRealJiraKey`; call `bootstrapWorkItemFromCli`; merge with explicit flags; thread `bootstrapMeta` to `runPipeline(workItem, { bootstrapMeta })` (audit/fix path) or directly to `sessionManager.create(workItem, pipeline, { bootstrapMeta })` (canary path). Extend `runPipeline` signature with optional `opts` arg. | Med  |

### Modified Files (Phase 2)

| File                                                  | Change Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Risk |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/helix/src/types.ts`                         | Phase-2 changes: (1) add `RetrievalTelemetry` interface; (2) add optional `retrieval?: RetrievalTelemetry` to `StageResult`; (3) add optional `retrievalTelemetry?: RetrievalTelemetry` to `PromptContextSnapshot`; (4) add optional `embeddingProvider?: { kind: 'bge-m3-local'; baseUrl?: string; timeoutMs?: number; maxBatchSize?: number; disabled?: boolean }` to `HelixConfig`.                                                                                                                                                                        | Low  |
| `packages/helix/src/pipeline/prompt-context.ts`       | Replace `loadPriorDoc(session, config, 'findings.md', 'Prior Findings')` and `'decisions.md'` calls at `:132-133` with `loadRelevantPriorContext(session, config, embeddingIndex?)`. Expand `MAX_PRIOR_CONTEXT_CHARS` from 3200 to 4800; split rendering into 3200-chars findings + 1600-chars decisions sub-budgets. Stage gating at `:792-794` unchanged.                                                                                                                                                                                                   | Med  |
| `packages/helix/src/pipeline/pipeline-engine.ts`      | (1) Construct `EmbeddingIndex` early in `run()`. (2) Add new narrow `private async onStageCompleted(session, stage, result)` method that fires `await this.embeddingIndex?.notifyStageComplete(session, stage)` ONLY — no journal write, no `stageHistory` push. (3) Call `await this.onStageCompleted(...)` after each of the 3 existing `stageHistory.push(result)` sites at `:512`, `:543`, `:737`. The 3 existing `'stage-complete'` journal sites at `:741`, `:2583`, `:2730` are NOT modified. (4) Pass `embeddingIndex` to `buildPromptContext` calls. | Med  |
| `packages/helix/src/session/session-manager.ts`       | Extend `create(workItem, pipeline, options?: { bootstrapMeta? })` and set `session.bootstrapMeta = options?.bootstrapMeta` in the constructed `Session` literal (NOT `workItem.bootstrapMeta`). No persist-time changes (markdown path unchanged).                                                                                                                                                                                                                                                                                                            | Low  |
| `packages/helix/src/cli.ts`                           | Register `case 'index'` in dispatcher between `drift` and `jira`; implement `runIndex()` → routes to `helix index rebuild [--dry-run]`.                                                                                                                                                                                                                                                                                                                                                                                                                       | Low  |
| `packages/helix/src/__tests__/prompt-context.test.ts` | Add UT-22, UT-23. Existing 8 tests must continue to pass (replacement preserves `priorFindingsDoc`/`priorDecisionsDoc` shape).                                                                                                                                                                                                                                                                                                                                                                                                                                | Med  |

### Deleted Files

None. Nothing is removed.

---

## 3. Implementation Phases

### Phase 1 — Work-Item Bootstrap (no Phase 2 dependency)

**Goal**: `helix audit ABLP-<key>` auto-fetches the Jira ticket, populates `WorkItem.{title, description, scope}` and `Session.bootstrapMeta`, with explicit CLI flags overriding Jira-derived values, and degrades gracefully on Jira failure.

**Tasks**:

1.1. **Add `getIssue(key, client?)` to `jira-client.ts`.**

- Mirror `searchAssignedIssues` pattern (line 293): `resolveCredentials()` → `jiraFetch(creds, 'rest/api/3/issue/${key}', { method: 'GET' })` → return `JiraAssignedIssue` with `descriptionText: adfToPlainText(issue.fields.description)`.
- Optional `client?: JiraIssueClient` parameter for DI; default to a private production singleton.
- All 5 failure modes (no creds, 401, 403, 404, network) return `null` with one-line `[helix:jira]` stderr warning. Never throws.
- Export `JiraIssueClient` interface for tests.

  1.2. **Create `jira-bootstrap.ts` with pure functions.**

- `isRealJiraKey(s)`: regex `^[A-Z][A-Z0-9]+-\d+$`.
- `enumerateWorkspacePackages(workDir)`: read `pnpm-workspace.yaml` from `workDir`, resolve `packages` glob patterns to a `string[]` of root-relative directory names that contain `package.json`. Idempotent and cached per `workDir` via a module-level `let cachedResult: { workDir: string; packages: string[] } | undefined` — single-entry, process-scoped, no TTL needed (CLI process lifetime is bounded). If `pnpm-workspace.yaml` is absent, fall back to enumerating immediate children of `apps/` and `packages/` that contain `package.json`.
- `inferScopeFromText(text, workspacePackages)`:
  - Tokenize `text` by whitespace/punctuation; for each token, test against each entry in `workspacePackages`.
  - Match if the workspace path appears as a path-segment prefix in the token (e.g. `apps/runtime` matches `"apps/runtime/src/sessions"` but does NOT match `"../../runtime"` because it requires the `apps/` prefix).
  - Dedupe in description order; cap at 5.
- `mapJiraIssueToWorkItem(issue, jiraKey, cliOverrides, workspacePackages)`:
  - If `issue === null` → `{ workItem: { title: jiraKey, description: jiraKey, scope: cliOverrides.scope ?? [] }, bootstrapMeta: { jiraKey, jiraFetchSuccess: false, scopeInferenceMethod: cliOverrides.scope ? 'explicit' : 'empty', inferredScope: [], fallbackReason } }`.
  - Else: Jira values fill any field not present in `cliOverrides`. `inferScopeFromText` runs only when `cliOverrides.scope` is empty/absent; when present, `scopeInferenceMethod = 'explicit'` and `inferredScope = []` (per locked contract).

    1.3. **Update `commit-manager.ts` to import `isRealJiraKey` from the shared location.**

- Delete the local `isRealJiraKey` function at `:356-358`. Add `import { isRealJiraKey } from '../integrations/jira-bootstrap';` at top.
- Existing `commit-manager.test.ts` continues to pass unchanged (no behavior change).

  1.4. **Add `BootstrapMeta` to `types.ts`.**

- Define interface; mark `bootstrapMeta?: BootstrapMeta` as optional on **`Session`** (matches test-spec E2E-1 — `session.bootstrapMeta.*`). The WorkItem stays minimal: it represents what to work on, not how the work was assembled.
- Existing `session.json` files load with `session.bootstrapMeta = undefined` (no migration).

  1.5. **Wire bootstrap into `cli.ts` `runAudit` / `runFix` / `runCanary`.**

- Helper function `bootstrapWorkItemFromCli(positional, flags, workDir)`:
  - **Lives in `cli.ts` as a private (unexported) async helper** — NOT in `jira-bootstrap.ts`. Rationale: this function orchestrates the impure `getIssue` HTTP call and the impure `enumerateWorkspacePackages` filesystem read, and consumes flag state. Keeping it next to the CLI command handlers it serves is correct; `jira-bootstrap.ts` stays a pure-functions module.
  - If `positional` matches `isRealJiraKey` AND `flags['--jira']` is unset, treat positional as Jira key.
  - Else if `flags['--jira']` is set, use that key (positional becomes title override).
  - Call `getIssue(key)` → `mapJiraIssueToWorkItem(...)` → return `{ partialWorkItem, bootstrapMeta }`.
  - **`runCanary` edge case**: `runCanary` does not take a positional title (uses `--title` instead). When invoked WITHOUT a positional Jira key AND without `--jira`, the helper returns `{ partialWorkItem: {}, bootstrapMeta: undefined }` and `runCanary` proceeds with its existing `DEFAULT_CANARY_TITLE` path — pre-feature behavior preserved exactly.
  - When no Jira key is involved (any command), return `{ partialWorkItem: {}, bootstrapMeta: undefined }` — preserves legacy CLI surface exactly.
- `runAudit` / `runFix` / `runCanary` call this helper; merge the partial WorkItem with their existing CLI-flag-built WorkItem (CLI explicit values take precedence per FR-4). `runSmoke` and `runPipeline` are NOT modified — `smoke` has its own WorkItem construction and `runPipeline` is internal.
- Update usage strings to document `helix audit ABLP-XXX` form.

  1.6. **Persist `bootstrapMeta` on session creation — full call-chain threading.**

Critical detail: `runAudit` and `runFix` do NOT call `sessionManager.create` directly — they call `runPipeline(workItem)` which is the shared internal entry point at `cli.ts:1203`. `runPipeline` is the one that calls `sessionManager.create(workItem, pipeline)` at `cli.ts:1224`. Only `runCanary` (`cli.ts:719-778`) calls `sessionManager.create` directly. So `bootstrapMeta` must thread through TWO layers, not one.

Signature changes:

- `SessionManager.create(workItem, pipeline)` → `SessionManager.create(workItem, pipeline, options?: { bootstrapMeta?: BootstrapMeta })`. Inside `create()`, the constructed `Session` literal gains `bootstrapMeta: options?.bootstrapMeta`. Persisted via the existing single `persist()` call inside `create()`.
- `runPipeline(workItem)` → `runPipeline(workItem, opts?: { bootstrapMeta?: BootstrapMeta })`. Threads `opts?.bootstrapMeta` to `sessionManager.create(workItem, pipeline, { bootstrapMeta })`.

Call-chain flow for each command:

- **`runAudit`** (and `runFix`): `bootstrapWorkItemFromCli` returns `{ partialWorkItem, bootstrapMeta }`. The handler merges `partialWorkItem` into the `WorkItem` it builds, then calls `runPipeline(workItem, { bootstrapMeta })`. `runPipeline` passes the meta as the 3rd arg to `sessionManager.create`.
- **`runCanary`**: `bootstrapWorkItemFromCli` returns `{ partialWorkItem, bootstrapMeta }`. The handler merges `partialWorkItem`, then calls `sessionManager.create(workItem, pipeline, { bootstrapMeta })` directly (`cli.ts:749`).
- **Pre-existing call paths that don't go through bootstrap** (`runDriftAudit` at `cli.ts:951`, `runSmoke`, etc.): pass no third argument; `bootstrapMeta` stays undefined. Behavior preserved exactly.

The 3rd-argument pattern is preferred over "mutate `session.bootstrapMeta` after `create()` returns and call a second `persist()`" because `create()` already persists once and a redundant second persist is wasteful and creates a window where `session.bootstrapMeta` is missing on disk.

- Stderr line `[helix:jira] fetched ABLP-X (Yms, summary: N chars, description: M chars, inferred scope: ...)` emitted from the bootstrap helper after `mapJiraIssueToWorkItem`.

**Files Touched**:

- `packages/helix/src/integrations/jira-client.ts` — add `getIssue` + `JiraIssueClient` export.
- `packages/helix/src/integrations/jira-bootstrap.ts` — new file with pure functions.
- `packages/helix/src/pipeline/commit-manager.ts` — import refactor.
- `packages/helix/src/types.ts` — add `BootstrapMeta`, extend `Session` (NOT `WorkItem` — see D-L13 / task 1.4 / R1 fix).
- `packages/helix/src/cli.ts` — bootstrap helper + 3 dispatcher modifications.
- `packages/helix/src/session/session-manager.ts` — accept `bootstrapMeta` on create (no schema migration; field is optional).
- 4 new test files + 2 fixtures (workspace fixture dir, `jira-fake.ts`).

**Exit Criteria** (Phase 1 complete — commit `3a53bd977`, 2026-05-01):

- [x] `pnpm exec tsc --noEmit` in `packages/helix` passes with 0 errors.
- [x] `pnpm exec vitest run` in `packages/helix` passes; UT-1..UT-9, INT-1, INT-4, SEC-4, SEC-6 are GREEN.
- [x] Subprocess E2E tests E2E-1, E2E-2, E2E-5, E2E-6, E2E-7, SEC-3 GREEN.
- [x] `grep -c "function isRealJiraKey" packages/helix/src/pipeline/commit-manager.ts` returns 0; only one canonical declaration in `jira-bootstrap.ts`.
- [ ] Smoke test runbook (§5) — to be run by maintainer on a real Jira ticket.
- [x] `packages/helix/agents.md` appended with Phase 1 implementation learnings (7 entries).
- [x] No regressions: existing `prompt-context.test.ts` / `commit-manager.test.ts` / `session-manager.test.ts` pass unchanged.

**Test Strategy**:

- Unit: pure-function tests of `isRealJiraKey`, `inferScopeFromText`, `mapJiraIssueToWorkItem`, with hand-crafted fixtures. `getIssue` tests via DI'd client.
- Integration: in-process Jira fake on random port; full failure matrix; CLI bootstrap helper tested end-to-end inside the test process.
- E2E: subprocess `helix audit ABLP-FAKE-X` against the same Jira fake; reads `session.json` from disk after exit.

**Rollback**: revert the Phase 1 commit. The CLI behavior is purely additive (positional title path is preserved); no on-disk schema changes; existing sessions continue to work.

---

### Phase 2 — Cross-Session Retrieval (depends on Phase 1; ships ≥ 1 week later)

**Goal**: At `deep-scan` / `oracle-analysis` / `plan-generation` stages, `loadRelevantPriorContext` returns top-N findings and decisions from across all past Helix sessions in the repo, ranked by scope-filter-then-cosine; the embedding hook fires on stage transitions for `deep-scan` / `oracle-analysis` / `plan-generation` / `implementation` to produce JSONL rows; `helix index rebuild` backfills the index from `docs/sdlc-logs/*/findings.md` + `decisions.md`.

**Tasks**:

2.1. **Add `RetrievalTelemetry` to `types.ts`.**

- Interface as defined above; optional `retrieval?: RetrievalTelemetry` on `StageResult`.

  2.2. **Create `embedding-client.ts`.**

- Mirror `packages/search-ai-internal/src/embedding/bge-m3.ts` pattern (reference, not import). 1024 dims; `POST /v1/embeddings`; configurable `baseUrl` (default `HELIX_EMBEDDING_BASE_URL` ?? `http://localhost:8000`); 120s timeout default; batch chunking by `maxBatchSize` (default 8).
- Export `BgeM3Client` interface + `createBgeM3Client` factory.
- Graceful fail: on network/4xx/5xx, throw a structured error that callers (`EmbeddingIndex`) catch and log via `[helix:embeddings]` stderr.

  2.3. **Create `embedding-index.ts`.**

Sub-tasks:

- 2.3.1. Per-session shard write path: `upsertBatch(rows)` writes to `.helix/cache/embeddings/bge-m3-1024/findings/<sessionId>.jsonl` (or `decisions/<sessionId>.jsonl`). Shard file is owned by exactly one session.
- 2.3.2. Read path: `loadAllShards()` walks the directory, parses every shard, dedupes by `id` ("latest `createdAt` wins"). Builds in-memory `Map<id, EmbeddingRow>`. Cached at instance level; mtime-invalidated on subsequent calls.
- 2.3.3. Query path: `query(request)` runs cosine of `embedClient.embedBatch([request.queryText])[0]` against in-memory rows; first filters by `scope` overlap (any `row.files[*]` startsWith `scope[i]` OR `row.package === scope[i]`); cosine-ranks within filtered set; if filtered set < `topN`, fills remainder from global cosine. Returns `RetrievalTelemetry`.
- 2.3.4. Stage hook: `notifyStageComplete(session, stage)`. Only fires on `deep-scan` | `oracle-analysis` | `plan-generation` | `implementation`. Reads `session.findings` + `session.decisions`; computes SHA-256 of canonical serialization for each; compares against internal `lastEmbeddedHash` (an LRU-bounded `Map<id, string>` capped at 10 000 entries — implemented as a small array-backed LRU class local to this module, not a vendored dep, since `packages/helix` is excluded from the pnpm workspace and cannot import shared utils); embeds dirty subset via `client.embedBatch`; writes new rows to shard files. Emits stderr `[helix:embeddings] hook fired for <stage>: <N> embedded, <M> skipped` only when verbose. **Why 4 stages for write but only 3 for read** (read gating at `prompt-context.ts:792-794`): the hook captures findings produced during `implementation` so they're indexed for FUTURE sessions; `loadRelevantPriorContext` only fires at the 3 planning stages because by the time the `implementation` stage runs, the session already has full planning context and prior findings would only add noise. An implementer must NOT "fix" this asymmetry by aligning the two stage sets — it is intentional.
- 2.3.5. Model-mismatch warning: on first `query()` per `EmbeddingIndex` instance, count rows where `model` or `dimensions` differ from configured client; emit one warning `[helix:embeddings] WARNING: <compatible> of <total> indexed findings are compatible with current model bge-m3-1024 (<mismatched> indexed under <prior-model-id>); run \`helix index rebuild\` to re-embed`. Mismatched rows are skipped from results (not errored).
- 2.3.6. Rebuild: walk `config.workDir/docs/sdlc-logs/<slug>/findings.md` and `decisions.md`. Parse the structured-row format that `persistFindings` / `persistDecisions` writes (see `session-manager.ts:281-336`). Embed each row; write into a consolidated `findings.jsonl` + `decisions.jsonl` (next to per-session shards). Rename per-session shards to `<sessionId>.jsonl.compacted`. `--dry-run` walks but does not write. Idempotent.
- 2.3.7. Symlink-out-of-repo refusal: when walking `docs/sdlc-logs/`, `lstat` each path; refuse to follow symlinks whose `realpath` is outside `config.workDir`. Log `[helix:embeddings] rebuild: refusing to follow symlink <path>` and continue. (Single prefix per module: `embedding-index.ts` uses `[helix:embeddings]` for all logging, including rebuild walking.)

  2.4. **Wire `loadRelevantPriorContext` into `prompt-context.ts`.**

- Add new exported `loadRelevantPriorContext(session, config, embeddingIndex?)`. When `embeddingIndex === undefined`, delegate to existing `loadPriorDoc` (preserves test back-compat). When present, call `embeddingIndex.query(...)`.
- Replace `loadPriorDoc(session, config, 'findings.md', ...)` and `'decisions.md'` calls at `:132-133`. Pass `embeddingIndex` from `buildPromptContext`'s new optional parameter.
- Expand `MAX_PRIOR_CONTEXT_CHARS` from 3200 → 4800; split rendering into 3200 findings + 1600 decisions when `embeddingIndex` is present (legacy path keeps the original 3200 monolithic budget).
- Per-stage `RetrievalTelemetry` returned from `query` is wired through to `StageResult.retrieval` in the calling stage executor.

  2.5. **Wire the embedding hook into `pipeline-engine.ts` (narrow refactor).**

Sub-tasks:

- 2.5.1. Add a new private method `private async onStageCompleted(session: Session, stage: StageDefinition, result: StageResult): Promise<void>`. Body: `await this.embeddingIndex?.notifyStageComplete(session, stage)`. The method is intentionally narrow — it does NOT push to `stageHistory` (callers already do that) and does NOT emit any journal event. This preserves "zero behavior change" on the existing journal call sites; the embedding hook is purely additive.
- 2.5.2. Add `await this.onStageCompleted(session, stage, result)` immediately after each of the 3 existing `session.stageHistory.push(result)` callsites: `:512` (upstream-failure skip branch), `:543` (main loop after `executeStage` returns), and `:737` (skip-without-evidence branch). Do NOT modify the existing 3 `stage-complete` journal sites at `:741`, `:2583`, `:2730` — they continue to journal exactly as today. Site descriptions: `:512` and `:737` are skip branches at the `run()` level; `:543` is the main loop's per-stage push at the `run()` level. Sites `:741` (paired with the `:737` skip) and `:2583` (inside `executeStage`'s normal-completion epilogue) and `:2730` (inside `executeDeterministicReplayRegression`) are journals — they remain untouched.
- 2.5.3. In `PipelineEngine.run()`, before the main stage loop, construct `this.embeddingIndex = new EmbeddingIndex({ workDir: this.config.workDir, sessionId: session.id, client: createBgeM3Client(this.config.embeddingProvider ?? {}), ... })`. If `process.env.HELIX_EMBEDDING_DISABLED` is truthy, set `this.embeddingIndex = undefined`.
- 2.5.4. Pass `this.embeddingIndex` to `buildPromptContext` calls. Verify caller count via `grep -rn "buildPromptContext" packages/helix/src/ | grep -v "__tests__"` before refactor; update every caller to thread the optional index. (Wiring checklist §4 mandates this verification.)

  2.6. **Persist `RetrievalTelemetry` on `StageResult`.**

- `PromptContextSnapshot` (existing exported type) gains exactly one new optional field: `retrievalTelemetry?: RetrievalTelemetry`. (Do NOT thread telemetry through `PromptContextDocument` / `priorFindingsDoc` — that would extend a shape consumed by many sites.) The stage executor reads `snapshot.retrievalTelemetry` (top-level) and assigns it to the new `StageResult.retrieval` field BEFORE the result is pushed to `stageHistory`. The push (and thus `onStageCompleted`) sees the populated `result.retrieval` value.

  2.7. **Register `index` CLI command.**

- Add `case 'index':` to the dispatcher switch at `cli.ts` between `case 'drift':` and `case 'jira':`. Routes to `runIndex()`.
- `runIndex()`: parses sub-command (`rebuild` is the only one in v1). Routes to `runIndexRebuild()`.
- `runIndexRebuild()`: builds a minimal `HelixConfig`, instantiates `EmbeddingIndex`, calls `embeddingIndex.rebuild({ dryRun: flag('--dry-run') === 'true' })`. Reports counts via stdout.
- `printUsage()` updated to document `helix index rebuild [--dry-run]`.

  2.8. **Phase 2 doc sync.**

- Update `packages/helix/HELIX.md` future-work entry #4 from "Future Work — Cross-session learning" to "Done" with pointer to this LLD.
- Append `packages/helix/agents.md` with Phase 2 retrieval learnings (recall observations, ranking tradeoffs, manual benchmark numbers).

**Files Touched**:

- `packages/helix/src/types.ts` (extend with `RetrievalTelemetry`).
- `packages/helix/src/intelligence/embedding-client.ts` (new).
- `packages/helix/src/intelligence/embedding-index.ts` (new).
- `packages/helix/src/pipeline/prompt-context.ts` (modify).
- `packages/helix/src/pipeline/pipeline-engine.ts` (refactor + wire).
- `packages/helix/src/cli.ts` (register `index` command).
- 8 new test files + 2 new fixture trees.

**Exit Criteria** (Phase 2 complete when ALL):

- [ ] `pnpm exec tsc --noEmit` passes with 0 errors.
- [ ] All Phase 2 unit tests (UT-10..UT-23, plus the new `notifyStageComplete` no-op assertion for excluded stage types), 8 Phase 2 integration tests (INT-2, INT-3, INT-5, INT-6, INT-7, INT-8, INT-9, INT-10), 3 Phase 2 E2E tests (E2E-3, E2E-4, E2E-8), and Phase 2 security tests (SEC-1, SEC-2, SEC-5) GREEN.
- [ ] Existing `prompt-context.test.ts` 8 tests still pass unchanged.
- [ ] Stage hook fires for all 4 FR-8 stages (parameterized via `it.each` per INT-2).
- [ ] `helix index rebuild` against a fixture produces deterministic, idempotent JSONL.
- [ ] Smoke test runbook (§5 Phase 2) passed: `RetrievalTelemetry.embeddingSource === "bge-m3"` on at least one cross-session result, `latencyMs < 250` p50.
- [ ] Manual perf benchmark: `EmbeddingIndex.query` over 10K-row fixture index < 250 ms p50 on the maintainer's machine. Result documented in `docs/sdlc-logs/helix-work-item-bootstrap/perf-baseline.md`.
- [ ] `packages/helix/HELIX.md` future-work entry #4 updated.
- [ ] No regressions in any existing `packages/helix` test.

**Test Strategy**:

- Unit: pure-function tests of `EmbeddingIndex.query` ranking with hand-crafted vectors; hash-detect logic; mismatched-model warning behavior. `BgeM3Client` fetch/timeout/batching unit tests via in-process http fake.
- Integration: stage-hook lifecycle (parameterized over 4 stages); rebuild walker against fixture sdlc-logs; failure-injection (corrupt JSONL, mismatched-model, permission-denied, empty findings).
- E2E: cross-session retrieval (subprocess against fakes); idempotent rebuild; concurrent shards (3 parallel subprocess writers); symlink-out-of-repo refusal.

**Rollback**: revert the Phase 2 commit. `loadRelevantPriorContext` falls back to slug-based behavior when `embeddingIndex` is absent (which it would be after revert), so prompt-context still functions. `.helix/cache/embeddings/` is gitignored — no shared state to clean up. Existing `session.json` files loaded post-revert simply skip the `retrieval` field on `StageResult` (typed optional).

---

## 4. Wiring Checklist

> CRITICAL: every new component must be wired into its callers — this is the #1 failure mode for agent-written code.

**Phase 1**:

- [ ] `getIssue` and `JiraIssueClient` exported from `packages/helix/src/integrations/jira-client.ts` and reachable via the package's existing barrel (no separate index export needed since jira-client is already imported by tests + commit-manager + cli).
- [ ] `isRealJiraKey`, `mapJiraIssueToWorkItem`, `inferScopeFromText`, `enumerateWorkspacePackages` exported from new `jira-bootstrap.ts`.
- [ ] `commit-manager.ts` import path updated to `import { isRealJiraKey } from '../integrations/jira-bootstrap';`. Verify by grep: `grep -c "function isRealJiraKey" packages/helix/src/pipeline/commit-manager.ts` returns 0.
- [ ] `BootstrapMeta` interface exported from `types.ts`; consumers (`cli.ts`, `session-manager.ts`) import it.
- [ ] `runAudit`, `runFix`, `runCanary` in `cli.ts` each call `bootstrapWorkItemFromCli` before their existing WorkItem construction. WorkItem merge preserves explicit-flag precedence.
- [ ] `runPipeline(workItem, opts?: { bootstrapMeta? })` signature extended; `runAudit` and `runFix` thread `bootstrapMeta` to `runPipeline`; `runPipeline` threads to `sessionManager.create(workItem, pipeline, { bootstrapMeta })`.
- [ ] `runCanary` (which calls `sessionManager.create` directly at `cli.ts:749`) passes `{ bootstrapMeta }` as the 3rd arg.
- [ ] Pre-existing call sites that don't bootstrap (`runDriftAudit`, `runSmoke`, etc.) pass no 3rd arg; behavior preserved.
- [ ] Usage strings updated in `runAudit`/`runFix`/`runCanary` and in `printUsage()`.

**Phase 2**:

- [ ] `BgeM3Client` interface + `createBgeM3Client` factory exported from `embedding-client.ts`.
- [ ] `EmbeddingIndex`, `EmbeddingRow`, `QueryRequest`, `QueryResult`, `RebuildResult`, `FileSystem` exported from `embedding-index.ts`.
- [ ] `RetrievalTelemetry` interface exported from `types.ts`; `StageResult.retrieval?: RetrievalTelemetry` field added.
- [ ] `PromptContextSnapshot.retrievalTelemetry?: RetrievalTelemetry` field added in `types.ts`. The single stage-executor site that consumes `PromptContextSnapshot` reads `snapshot.retrievalTelemetry` and assigns it to `result.retrieval` BEFORE the result is pushed to `stageHistory` (so `onStageCompleted` sees the populated value).
- [ ] `HelixConfig.embeddingProvider?` optional field added in `types.ts`. `PipelineEngine.run()` reads `this.config.embeddingProvider` (with `?? {}` default) when constructing `EmbeddingIndex`.
- [ ] `loadRelevantPriorContext` exported from `prompt-context.ts`; `buildPromptContext` accepts optional `embeddingIndex` parameter.
- [ ] `PipelineEngine.onStageCompleted` (narrow embedding-only hook) is called immediately after each of the 3 `stageHistory.push(result)` sites at `:512`, `:543`, `:737`. The 3 existing `'stage-complete'` journal sites at `:741`, `:2583`, `:2730` are unchanged. (`onStageCompleted` does NOT journal, does NOT push.)
- [ ] `PipelineEngine.run()` constructs `EmbeddingIndex` before stage loop.
- [ ] `case 'index':` registered in `cli.ts` dispatcher switch between `'drift'` and `'jira'`.
- [ ] `runIndex` / `runIndexRebuild` reachable via `pnpm exec tsx packages/helix/src/cli.ts index rebuild --dry-run`.
- [ ] `printUsage()` documents `helix index rebuild [--dry-run]`.
- [ ] `HELIX.md` future-work #4 updated.
- [ ] **`buildPromptContext` caller audit**: `grep -rn "buildPromptContext(" packages/helix/src/ | grep -v "__tests__" | grep -v "function buildPromptContext"` returns the EXPECTED number of caller sites (verify pre-refactor; the count must not change post-refactor). Every listed site passes the optional `embeddingIndex` parameter.
- [ ] **`isRealJiraKey` extraction guard**: `grep -c "function isRealJiraKey" packages/helix/src/pipeline/commit-manager.ts` returns `0`; only the canonical declaration in `jira-bootstrap.ts` exists.
- [ ] **`onStageCompleted` callsite audit**: `grep -c "onStageCompleted" packages/helix/src/pipeline/pipeline-engine.ts` returns `4` (1 declaration + 3 callsites at the 3 push branches `:512`, `:543`, `:737`). The 3 existing journal sites at `:741`, `:2583`, `:2730` remain unchanged.

**Studio UI / API**: N/A — CLI feature only. No Studio routes, no forms, no design-token concerns, no native-select concerns.

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Helix has no MongoDB collection.

### Schema Migrations (`session.json`)

`bootstrapMeta` and `retrieval` are NEW OPTIONAL fields. Existing `session.json` files load via `JSON.parse` with these fields absent — both consumers (`cli.ts` resume path, `prompt-context.ts`, telemetry inspectors) treat `undefined` as "feature inactive for this session." No migration script.

### Feature Flags

- `HELIX_EMBEDDING_DISABLED=1` — Phase 2 only. When set truthy, `PipelineEngine.run()` constructs `embeddingIndex = undefined`, which causes `loadRelevantPriorContext` to fall back to slug-based behavior and the stage-completion hook to be a no-op. Used for emergency rollback or for users with no BGE-M3 service available.

### Configuration Changes

| Variable                     | Default                 | Phase | Description                                                          |
| ---------------------------- | ----------------------- | ----- | -------------------------------------------------------------------- |
| `HELIX_EMBEDDING_BASE_URL`   | `http://localhost:8000` | 2     | BGE-M3 service URL.                                                  |
| `HELIX_EMBEDDING_TIMEOUT_MS` | `120000`                | 2     | Per-batch timeout.                                                   |
| `HELIX_EMBEDDING_DISABLED`   | unset                   | 2     | Truthy → retrieval falls back to slug-based; persistence is a no-op. |

`HelixConfig.embeddingProvider` field added in Phase 2 (optional; defaults derive from env vars).

### Smoke Test Runbook (Maintainer Validation Per Phase)

**Phase 1 smoke test** — perform on `abl-platform` branch after Phase 1 lands, before tagging Phase 1 done:

1. Pick a real Jira ticket (e.g. `ABLP-778`) whose description mentions at least one `apps/*` or `packages/*` path.
2. Run `helix audit ABLP-778` from the repo root.
3. Inspect `session.json`: verify `workItem.title`, `workItem.description` match the Jira ticket; `workItem.scope` contains at least one inferred package; `bootstrapMeta.jiraFetchSuccess === true`; `bootstrapMeta.jiraFetchLatencyMs > 0`; `bootstrapMeta.scopeInferenceMethod === "deterministic"`; `bootstrapMeta.inferredScope` matches `workItem.scope`.
4. Run `helix audit ABLP-DOES-NOT-EXIST-9999` against a non-existent key. Verify `bootstrapMeta.jiraFetchSuccess === false`, `fallbackReason === "not-found"`, `workItem.title === "ABLP-DOES-NOT-EXIST-9999"`.
5. Run `helix audit ABLP-778 --scope apps/admin,packages/database`. Verify `workItem.scope === ["apps/admin", "packages/database"]`, `bootstrapMeta.scopeInferenceMethod === "explicit"`, `bootstrapMeta.inferredScope === []`.
6. Verify stderr contains exactly one `[helix:jira]` line per invocation (no token leakage).

**Phase 2 smoke test** — perform after Phase 2 lands, before tagging Phase 2 done:

1. Run `helix index rebuild` against the live `docs/sdlc-logs/` tree. Capture stdout counts.
2. Re-run `helix index rebuild`. Verify second run reports `0 new embeddings`.
3. Run `helix audit ABLP-778`. Let it reach the `deep-scan` stage; abort early. Inspect `session.json`: `stageHistory[0].retrieval.embeddingSource === "bge-m3"`, `topNReturned >= 1`, `latencyMs < 250`, `fallback === false`.
4. Run a benchmark: build a fixture `EmbeddingIndex` with 10K rows; measure `query` p50 over 100 calls. Document the result in `docs/sdlc-logs/helix-work-item-bootstrap/perf-baseline.md`. Required: p50 < 250 ms.
5. Set `HELIX_EMBEDDING_DISABLED=1`; rerun `helix audit ABLP-778`. Verify retrieval falls back to slug-based; `RetrievalTelemetry.fallback === true`, `embeddingSource === "fallback-slug"`.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] Phase 1 exit criteria met (above).
- [ ] Phase 2 exit criteria met (above).
- [ ] All 13 coverage-matrix scenarios in the test spec are GREEN; status flips from PLANNED → IMPLEMENTED.
- [ ] Feature spec status flips from PLANNED → ALPHA (per pipeline.md status lifecycle gates).
- [ ] No regressions: full `pnpm exec vitest run` in `packages/helix` is GREEN; all 70+ existing tests pass.
- [ ] `HELIX.md` future-work entry #4 ("Cross-session learning") updated to "Done" with pointer to this LLD.
- [ ] `packages/helix/agents.md` has both phase entries (Phase 1 bootstrap, Phase 2 retrieval) appended.
- [ ] `/post-impl-sync helix-work-item-bootstrap` ran successfully — feature spec, test spec, and indexes reflect actual implementation state.

---

## 7. Open Questions

1. **Should `HelixConfig.embeddingProvider` be parsed from a `.helix/config.json` file**, or stay env-var-only for v1? Env-var keeps the UX simple and matches the existing Helix convention; config-file is a Phase 3 concern.
2. **In `enumerateWorkspacePackages`, should we honor `pnpm-workspace.yaml`'s `packages: ['!packages/excluded']` exclusions?** v1 ignores exclusions (any directory under `apps/` or `packages/` containing `package.json` counts). If a user excludes a directory and that directory still gets matched as a scope token, the user can override via `--scope`. Revisit if a real Helix-on-non-pnpm-workspace target repo surfaces.
3. **Stage-type filtering inside `notifyStageComplete`.** The hook is called from the 3 `stageHistory.push` sites which fire for every stage type (deep-scan, oracle-analysis, plan-generation, implementation, manifest-compilation, slice-execution, etc.). `EmbeddingIndex.notifyStageComplete` short-circuits and returns early for any `stage.type` not in `{ deep-scan, oracle-analysis, plan-generation, implementation }`. INT-2 parameterizes over the 4 included stages; an additional UT should assert that an excluded stage like `manifest-compilation` is a no-op. This filter lives on the index, not on the call site, to keep the hook contract simple at the call site.
4. **`MAX_TRACKED_HASHES = 10_000` LRU bound on `EmbeddingIndex.lastEmbeddedHash`** — is this tight enough for sessions with very deep finding history? Most sessions produce < 100 findings; 10K is generous. If a session ever exceeds this, the LRU eviction means a previously-embedded finding's hash is forgotten and the next stage-completion call will redundantly re-embed it. Cost is bounded and acceptable.

5. **`buildPromptContext` runs once per pipeline, not per stage.** `pipeline-engine.ts:1929` (`refreshPromptContext`) constructs the `PromptContextSnapshot` once; the same snapshot is reused at every retrieval-gated stage (`deep-scan`, `oracle-analysis`, `plan-generation`). Consequence: the `RetrievalTelemetry` carried on `snapshot.retrievalTelemetry` is computed once and the same record is copied to all three `StageResult.retrieval` fields. Per-stage retrieval values would require a per-stage prompt-context refresh. Acceptable for v1 — it makes the spec's "Each retrieval call must persist a `retrieval` telemetry record" (FR-14) literally true (one `query()` call → one record copied 3 times) but the per-stage deltas users might expect (different `topNReturned` per stage) won't appear. If Phase 2 telemetry shows the single-snapshot model masks stage-specific recall problems, refactor `refreshPromptContext` to be stage-aware in a follow-up.

---

## 8. References

- Feature spec: `docs/features/sub-features/helix-work-item-bootstrap.md`
- Test spec: `docs/testing/sub-features/helix-work-item-bootstrap.md`
- Feature-spec audit log: `docs/sdlc-logs/helix-work-item-bootstrap/feature-spec.log.md`
- Test-spec audit log: `docs/sdlc-logs/helix-work-item-bootstrap/test-spec.log.md`
- LLD audit log (this artifact): `docs/sdlc-logs/helix-work-item-bootstrap/lld.log.md`
- BGE-M3 reference client (read-only inspiration): `packages/search-ai-internal/src/embedding/bge-m3.ts`
- Helix overview: `packages/helix/HELIX.md`
- Helix contributor brief: `packages/helix/CLAUDE.md`
- Source survey: `packages/helix/src/cli.ts:131-175, 700-780`; `pipeline-engine.ts:512-543, 680-681, 737-741, 2583, 2730`; `session-manager.ts:196-336`; `prompt-context.ts:132-133, 299-325, 792-794`; `jira-client.ts:293-394`; `commit-manager.ts:345-358`.
