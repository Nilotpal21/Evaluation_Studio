# HELIX Bootstrap Implementation — Decision Clarifications

**Document**: Resolves 3 AMBIGUOUS decisions blocking session `a9278307`  
**Date**: 2026-05-03  
**Status**: LOCKED (answers derived from LLD-D6, D-L7, D-L14, Feature-Spec §12)

---

## D1: CLI Architecture for `helix index` Command

**Question**: Is the CLI helix index subcommand intended to be registered in the existing cli.ts command tree or as a separate entrypoint?

**RESOLVED ANSWER**:

Register as a `case 'index'` in the existing CLI dispatcher switch in `packages/helix/src/cli.ts` between `drift` and `jira` (lines 131-175).

**Implementation Pattern**:

```typescript
// cli.ts dispatcher
switch (parsed.command) {
  case 'drift':
  // ...
  case 'index':
    return await runIndex(parsed, config);
  case 'jira':
  // ...
}
```

**Rationale (LLD-D14)**:

- Groups maintenance/integration commands together (`drift`, `index`, `jira`)
- The dispatcher already organizes pipeline ops first, then status, then integration
- Reuses existing command routing, no new entrypoint needed

**Reference**: LLD §1 Design Decisions, D-L14 (p. 40)

---

## D2: `onStageCompleted()` API Surface & Signature

**Question**: What is the exact API surface and signature of onStageCompleted() and how does it receive the sessionId needed to construct the shard path?

**RESOLVED ANSWER**:

Two-layer design: a narrow `PipelineEngine` method + an `EmbeddingIndex` callback.

### Layer 1: `PipelineEngine.onStageCompleted()` (owner of stage lifecycle)

```typescript
// packages/helix/src/pipeline/pipeline-engine.ts

export class PipelineEngine {
  // ... existing fields
  private embeddingIndex?: EmbeddingIndex;

  async run(
    workItem: WorkItem,
    pipeline: Pipeline,
    options?: { bootstrapMeta? },
  ): Promise<Session> {
    // Construct embedding index early
    this.embeddingIndex = new EmbeddingIndex({
      workDir: this.config.workDir,
      sessionId: session.id,
      client: createBgeM3Client(this.config.embeddingProvider),
    });

    // ... existing stage loop
    // When pushing stage results at `:512`, `:543`, `:737`:
    stageHistory.push(result);
    await this.onStageCompleted(session, stage, result); // NEW CALL after each push
  }

  private async onStageCompleted(
    session: Session,
    stage: StageDefinition,
    result: StageResult,
  ): Promise<void> {
    // Fires ONLY the embedding hook — no journal write, no stageHistory.push
    if (this.embeddingIndex) {
      await this.embeddingIndex.notifyStageComplete(session, stage);
    }
  }
}
```

**Key properties**:

- Receives `sessionId` via the `session` parameter
- Called from each of the 3 existing `stageHistory.push(result)` sites (`:512`, `:543`, `:737`)
- Does NOT call the existing stage-complete journal sites (`:741`, `:2583`, `:2730`)
- Existing journal behavior is untouched — skip-branch and fail-result paths keep their current (no-journal) behavior

### Layer 2: `EmbeddingIndex.notifyStageComplete()` (embedding-domain logic)

```typescript
// packages/helix/src/intelligence/embedding-index.ts

export class EmbeddingIndex {
  private sessionId: string;
  private workDir: string;
  private client: BgeM3Client;

  constructor(opts: { workDir: string; sessionId: string; client: BgeM3Client }) {
    this.workDir = opts.workDir;
    this.sessionId = opts.sessionId;
    this.client = opts.client;
  }

  async notifyStageComplete(session: Session, stage: StageDefinition): Promise<void> {
    // sessionId is available as this.sessionId (set in constructor)
    // Collect dirty findings/decisions and batch-enqueue for embedding
    const dirtyFindings = this.collectDirtyFindings(session);
    const dirtyDecisions = this.collectDirtyDecisions(session);

    if (dirtyFindings.length > 0 || dirtyDecisions.length > 0) {
      await this.upsertBatch(dirtyFindings, dirtyDecisions);
    }
  }

  private async upsertBatch(findings: Finding[], decisions: Decision[]): Promise<void> {
    // Computes contentHash (SHA-256) lazily here
    // Embeds via this.client.embedBatch()
    // Writes per-session shard at: .helix/cache/embeddings/bge-m3-1024/findings/<sessionId>.jsonl
  }
}
```

**Rationale (LLD-D6, D-L7, D-L8)**:

- **D-L6**: Narrow method prevents the divergent-sites bug without touching the journal
- **D-L7**: Embedding-domain logic stays on `EmbeddingIndex`; `PipelineEngine` stays focused on stage orchestration
- **D-L8**: `contentHash` computed lazily inside `notifyStageComplete`, not at `addFinding`/`addDecision` time

**Reference**: LLD §1 Design Decisions, D-L6 (p. 31), D-L7 (p. 32), D-L8 (p. 33)

---

## D3: Index Rebuild — CLI Subcommand vs Automatic Trigger

**Question**: Should helix index rebuild consolidation be a separate CLI subcommand or triggered automatically after each session?

**RESOLVED ANSWER**:

Separate CLI subcommand, NOT automatic.

### CLI Surface

```bash
helix index rebuild              # backfills embeddings from docs/sdlc-logs/
helix index rebuild --dry-run    # walks but does not write
```

### Implementation

```typescript
// packages/helix/src/cli.ts

case 'index':
  return await runIndex(parsed, config);

async function runIndex(parsed: ParsedArgs, config: HelixConfig): Promise<void> {
  const dryRun = parsed.flags['dry-run'] ?? false;
  const result = await embeddingIndex.rebuild({ dryRun });

  if (dryRun) {
    console.log(`[helix:index] DRY RUN: ${result.rowsWritten} rows would be written`);
  } else {
    console.log(`[helix:index] Rebuild complete: ${result.rowsWritten} rows written`);
  }
}
```

**Why separate?**

- Rebuilding is expensive (scans all `docs/sdlc-logs/<slug>/findings.md` + `decisions.md` files, re-embeds each row)
- User controls when to run it (after model upgrades, after long-running branches, manually)
- Automatic rebuilds after every session would be noise and cost

**When users should run it**:

- After a Helix version that changes embedding model
- After pulling a long-running branch with many new sessions
- Explicitly, if they want to migrate embeddings

**Reference**: Feature-Spec §12 FR-12 (p. 88), LLD-D14 (p. 40)

---

## Summary Table

| Decision             | Resolved                                                                                | Implementation Location                     | LLD Reference                |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| D1: CLI architecture | `case 'index'` in dispatcher                                                            | `cli.ts:132-148`                            | D-L14 (p. 40)                |
| D2: API surface      | Two-layer: `PipelineEngine.onStageCompleted()` + `EmbeddingIndex.notifyStageComplete()` | `pipeline-engine.ts` + `embedding-index.ts` | D-L6, D-L7, D-L8 (pp. 31–33) |
| D3: Rebuild trigger  | Separate CLI subcommand                                                                 | `helix index rebuild [--dry-run]`           | FR-12, D-L14 (pp. 88, 40)    |

---

## Next Steps for Implementation

1. **Read this document** before resuming work on session `a9278307`
2. **Implement Phase 1 tasks** per LLD §3 (tasks 1.1–1.5, pp. 285–290)
3. **Cross-reference** all file-level changes in LLD §2 (pp. 219–272)
4. **Run tests** from the test plan in Feature-Spec §17 (pp. 512–530)

For any clarifications, escalate to the feature owner or re-read the LLD source-of-truth sections listed above.
