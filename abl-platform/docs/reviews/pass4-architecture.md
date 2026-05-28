# Reusable Agent Modules -- Phase 1 LLD Pass 4 Review

**Reviewer:** LLD Review Agent (Pass 4 of 5)
**Date:** 2026-03-21
**LLD:** `docs/specs/reusable-agent-modules-phase1.lld.md`
**Focus:** Verify Pass 3 fixes are clean; final architecture pass

---

## VERDICT: APPROVED (with 2 LOW notes for implementation)

All Pass 3 fixes have been correctly applied. No new CRITICAL or HIGH issues found. Two LOW-severity alias rewriter gaps identified in behavior profile nesting -- these are edge cases that can be addressed during implementation without blocking.

---

## Pass 3 Fix Verification

### 1. `metadata.name` placement -- VERIFIED

- Line 485: `metadata.name` is first in AGENT_NAME_FIELDS with comment "must be rewritten FIRST"
- Line 609-611: `deepRewriteIR` explicitly rewrites `ir.metadata.name` before the general tree walk
- This is correct. The agent's self-reported identity must match its mounted key before downstream processing.

### 2. Implementation order renumbering -- VERIFIED

- Sprint 1: items 1-7 (lines 1700-1706) -- 7 items, correct
- Sprint 2: items 8-13 (lines 1710-1715) -- 6 items, correct
- Sprint 3: items 14-21 (lines 1719-1726) -- 8 items, correct
- Sprint 4: items 22-27 (lines 1730-1735) -- 6 items, correct
- Sprint 5: items 28-31 (lines 1739-1742) -- 4 items, correct
- Total: 31 items, consecutive, no gaps or duplicates.

### 3. `deleteProject` signature note -- VERIFIED

- Line 294: Clear specification that `deleteProject(projectId: string)` must be extended to `deleteProject(projectId: string, tenantId?: string)`
- Current actual signature at `packages/database/src/cascade/cascade-delete.ts:137` is `deleteProject(projectId: string)` -- matches the LLD's understanding
- The note correctly specifies backward compatibility via optional `tenantId` with fallback to resolving from the Project document
- Placement in Section 2 (Cascade Delete) is appropriate

### 4. SearchAI/Workflow binding warning -- VERIFIED

- Lines 1523-1528: Warning is actionable -- specifies what to emit (publish-time warning), what to include in the contract (`warnings` array with the binding IDs), and what happens at runtime (tool call fails with standard error, not silent misconfiguration)
- Line 1704: Sprint 1 item 5 explicitly includes "SearchAI/Workflow binding warnings"
- The warning surfaces in the contract so consumers see it during import preview (Section 7.4 lines 987-989 show `prerequisites.warnings` in preview response)

### 5. `checkpoint.target` in TOOL_NAME_FIELDS -- VERIFIED

- Line 563: `constraints.constraints[].checkpoint.target` is listed with comment "ConstraintCheckpoint.target -- tool call gate"
- This matches the schema at `packages/compiler/src/platform/ir/schema.ts:1151-1154` where `ConstraintCheckpoint.target` is an optional string

### 6. `ResolvedAgentIR`/`ResolvedToolDefinition` types -- VERIFIED

- Lines 791-805: Formal type declarations in `apps/runtime/src/services/modules/types.ts`
- Line 807: Explicit guidance that runtime code should use these types instead of raw `AgentIR` with type assertions
- Line 1702: Sprint 1 item 3 orders shared types before runtime work in Sprints 2-3

### 7. `TraceEventType` extension -- VERIFIED

- Lines 871-873: Notes that `tool_auth_resolved` must be added to the `TraceEventType` enum
- Line 1702: Sprint 1 item 3 explicitly includes "extend `TraceEventType` union in `packages/shared-kernel/src/types/trace-event.ts` with `tool_auth_resolved`"
- Current enum at `packages/shared-kernel/src/types/trace-event.ts:10-26` is a string union -- extension is straightforward

---

## Remaining Alias Rewriter Gaps (LOW)

Cross-referencing the LLD field lists against `packages/compiler/src/platform/ir/schema.ts`:

### [LOW-1] BehaviorProfile nested Constraint references not in rewrite lists

`BehaviorProfileIR.constraints` (schema line 253) is an array of `Constraint` objects. Each `Constraint` has:

- `on_fail.target` (agent name when `type='handoff'`) -- listed for top-level `constraints.constraints[]` but NOT for `behavior_profiles[].constraints[]`
- `checkpoint.target` (tool name when `kind='tool_call'`) -- same gap

**Risk:** Low. Behavior profiles are an advanced feature. Module agents with behavior-profile-level constraints that reference other module agents by name would be silently missed. In practice, behavior profile constraints typically reference global step names or contain inline messages.

**Fix:** Add to the field lists during implementation:

```
// AGENT_NAME_FIELDS:
'behavior_profiles[].constraints[].on_fail.target'
// TOOL_NAME_FIELDS:
'behavior_profiles[].constraints[].checkpoint.target'
```

### [LOW-2] BehaviorProfile flow insertion steps not walked

`BehaviorProfileIR.flow_modifications.insertions[].step` (schema lines 304-308) is a full `FlowStep` object. A `FlowStep` contains `call` (tool name), `then`/`on_fail` (step/agent name), `digressions[].delegate` (agent name), `digressions[].call` (tool name), `on_success`/`on_failure` branch targets, etc.

These nested FlowStep references inside behavior profile insertions are not covered by the `flow.definitions[*].*` patterns in the LLD field lists.

**Risk:** Low. `flow_modifications.insertions` is a rarely used behavior profile feature. Module agents with behavior profiles that insert steps referencing other module agents/tools would be silently missed.

**Fix:** During implementation, the `deepRewriteIR` function should recursively walk any `FlowStep` object it encounters in behavior profiles, not just `flow.definitions[*]`. The implementor should use a shared `rewriteFlowStep(step, renameMap)` helper that is called from both the main flow walk and the behavior profile walk.

---

## Architecture Pass -- All Clear

### Resource isolation -- PASS

- All queries include `tenantId` (Sections 2, 3, 5, 7, 11.3)
- Cross-tenant access returns 404 (Section 11.3, line 1601)
- `deleteProject` signature extended with `tenantId` parameter (Section 2, line 294)
- Consumer projectId used for auth resolution, not module source projectId (Section 6.4)

### Auth and permissions -- PASS

- 4 new permissions with explicit role mappings (Section 7.2)
- Feature gate fails closed (Section 9.2)
- No custom token verification

### Statelessness -- PASS

- Redis distributed lock for deployment builds (Section 10.2)
- Session provenance persisted to Redis via SessionData (Section 6.2)
- No pod-local state as truth

### Concurrency -- PASS

- Optimistic concurrency via `moduleDependencyVersion` counter (Section 10.1)
- Atomic verify-and-persist pattern for deployment snapshot (Section 10.1, lines 1391-1404)
- Pointer promotion uses revision counter (Section 10.3)
- Redis lock uses Lua scripts for both release and renewal (Section 10.2)

### Error handling -- PASS

- Standard envelope `{ success, data }` / `{ success: false, error: { code, message } }` throughout
- Error instances checked with `err instanceof Error ? err.message : String(err)` (Section 9.2, line 1294)
- Diagnostics truncated to first 10 (Section 5.1, line 700)

### Data model -- PASS

- All indexes specified with unique constraints where needed
- Snapshot compressed with gzip, 8MB limit enforced before compression
- `archivedAt`/`archivedBy` fields specified in schema (Section 1.1, line 77 notes Mongoose strict mode)

### Implementation order -- PASS

- Shared types (item 3) before runtime merge (item 14) and trace enrichment (item 16)
- Data models (item 1) before everything that depends on them
- E2E bootstrap (item 22) before E2E tests (item 23)
- Feature flag wiring (item 28) in final sprint for rollout safety

---

## VERIFIED

- [x] Pass 3 fixes -- all 7 fixes verified clean and correctly placed
- [x] Architecture compliance -- tenant isolation, auth, statelessness, error handling
- [x] Pattern consistency -- follows existing patterns in database, runtime, studio packages
- [x] Completeness -- all HLD requirements covered, cross-reference table is exhaustive
- [x] Implementation order -- 31 items, correctly numbered, dependency ordering is sound
- [x] Concurrency control -- Redis locks with Lua, optimistic version counters, atomic operations
- [x] Domain rules -- alias rewriter field lists verified against schema (2 LOW gaps noted)
- [x] Task independence -- sprints have clear dependency chains, no circular dependencies

## NOTES

1. **For implementors:** When building `deepRewriteIR`, implement it as a recursive walker that handles `FlowStep` objects generically. Do not enumerate individual paths -- walk the IR tree structurally. This naturally handles LOW-1 and LOW-2 above plus any future schema additions.

2. **Lock timer cleanup:** The `acquireDeployLock` renewal timer (Section 10.2) must be called within try/finally. The LLD does not explicitly require this, but Pass 3 memory flagged it. Implementors must ensure `release()` is called in a finally block.

3. **Zod schemas:** The LLD specifies 10 route handlers (Section 7.1) but does not include explicit Zod schemas for request bodies. Sprint 2 item 9 mentions "with Zod request validation" -- implementors should define schemas in a shared location within the module routes directory.
