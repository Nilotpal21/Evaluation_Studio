# Feature-Spec Phase — Ambiguous Decisions Resolved

**Date**: 2026-05-03  
**Status**: LOCKED  
**Source**: Decisions.md from feature-spec session `74a76eaf`

---

## AMBIGUOUS-1: Hook Placement Risk Severity

**Question**: What severity should finding 04ad7cd9 (Three divergent stage-complete journal sites not paired with stageHistory.push sites — hook placement risk) have?

**RESOLVED ANSWER**: **RESOLVED BY LLD-D-L6** — No severity action needed.

The hook placement risk is mitigated by LLD-D-L6, which specifies:

- A narrow `onStageCompleted()` private method on `PipelineEngine`
- Fires ONLY from the 3 `stageHistory.push` sites (`:512`, `:543`, `:737`)
- The 3 existing `stage-complete` journal sites (`:741`, `:2583`, `:2730`) are NOT modified
- This prevents divergence: every shard write is paired with the corresponding push, and journal sites keep their current behavior

**Implementation Guard**: Ensure all 3 push sites call `onStageCompleted()` after the push. This is enforced by code review and the LLD file-level change map (§2, p. 268).

**Reference**: LLD-D-L6 (p. 31), LLD §2 pipeline-engine.ts changes (p. 268)

---

## AMBIGUOUS-2: Shard Scope — SessionId-Only vs TenantId/ProjectId

**Question**: Should per-session shards be scoped under tenantId/projectId in the SHARD_BASE_PATH, or is sessionId-only acceptable because session IDs already encode tenant/project context elsewhere?

**RESOLVED ANSWER**: **SessionId-only is acceptable and required.**

### Reasoning

Helix is a **developer-side CLI tool with no tenant/project/user data plane** (per feature-spec §12 "Isolation & Multitenancy"):

- Helix operates entirely on local files (`.helix/` directory in the active repo)
- No shared multi-user state; no tenant/project scoping concepts
- Session IDs are unique within the local repo context by construction
- The single isolation boundary is the local repo (`config.workDir`)

### Shard Path Format

Per LLD-D-L1 (p. 31) and Feature-Spec §9:

```
.helix/cache/embeddings/bge-m3-1024/
├── findings/<sessionId>.jsonl
└── decisions/<sessionId>.jsonl
```

This is **sufficient and correct** for Helix's scope. Future cross-repo retrieval (flagged as GAP-002 in feature-spec §16) would require cross-repo index federation, not per-shard scoping.

### Implementation

Do **NOT** prepend `tenantId/projectId/` to shard paths. SessionId-only is the authoritative design.

**Reference**: Feature-Spec §12 "Isolation & Multitenancy" (p. 378), LLD-D-L1 (p. 31)

---

## Summary

| AMBIGUOUS Decision                  | Resolution                                             | Action                                    |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| Hook placement risk severity        | Mitigated by LLD-D-L6 (narrow onStageCompleted method) | No action; enforce code review            |
| Shard scope (tenantId vs sessionId) | SessionId-only; Helix has no tenant/project concepts   | Implement per LLD-D-L1; no scoping needed |

Both decisions are now **LOCKED** and should unblock implementation of session `a9278307`.

---

## For Phase 2 Planners

The feature-spec session `74a76eaf` reported 10 harnessDefects related to:

1. Missing embedding modules (embedding-client.ts, embedding-index.ts) — Phase 2 deliverables
2. Test coverage gaps (Phase 2 tests not yet written)
3. No retrieval hook wired into prompt-context.ts — Phase 2 deliverable
4. Index rebuild CLI not registered — Phase 2 deliverable

All 10 are **expected Phase 2 work** and should NOT block Phase 1 implementation. Phase 1 is complete (commit 3a53bd977); Phase 2 ships after Phase 1 stabilizes in production for ≥ 1 week.
