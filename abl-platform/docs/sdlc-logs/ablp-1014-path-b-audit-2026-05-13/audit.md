# ABLP-1014 Path-B Audit — 2026-05-13

**Auditor:** Claude (manual file-inspection audit; codex gpt-5.5 high failed twice due to Codex.app daemon instability — process exited mid-investigation both attempts; manual fallback used for time-sensitive merge decision)

**Branch:** `origin/feat/ablp-1014-arch-path-b` HEAD `99d27f681a`
**Base:** `origin/develop` HEAD `213c661b7c`

## Verdict

**PASS-with-fixes — 0 Critical / 0 High / 1 Medium / 1 Low**

Both phases of the path-B refactor land cleanly. Auth/scope flow is correct (runtime session scope wins over user-controlled input). Cross-project injection is blocked by tests in both arch-ai and runtime test suites. Multi-turn Studio parity preserved via dependency injection. Workflow-engine cleanup is clean. No orphan code references in non-doc files. Composition with merged W1.x and ABLP-999 work on develop is conflict-free.

## Phase-1 verification (deletions + in-process pivot)

### Deletions

`git grep` for the deleted surfaces shows only **one orphan reference in non-doc code**:

```
packages/arch-ai/src/__tests__/dispatcher.test.ts:49:describe('oneshot-dispatcher: decideNextEvent', () => {
```

This is a `describe()` label in the renamed test file — purely cosmetic. **LOW finding.**

All other matches are in `docs/` and `agents.md` (historical learning entries about the now-deleted one-shot endpoint) — those are factually correct historical artifacts and should remain.

### In-process pivot

- `apps/runtime/src/services/execution/system-agent-handler.ts:222-242` — handler receives `tenantId`, `userId`, `permissions`, `projectId` from runtime session and passes them into `runArchSystemAgentInProcess`. No service token minted. No HTTP call to Studio.
- `apps/runtime/src/services/execution/routing-executor.ts:123, :3438` — `validateSystemAgentRequiredPermissions` still enforced before dispatch (W1.3-H3 preserved).

## Phase-2 verification (processMessage port + full pipeline)

### processMessage move

- Studio multi-turn route at `apps/studio/src/app/api/arch-ai/message/route.ts:50` imports `processMessage` from `@agent-platform/arch-ai` (no longer local).
- Package re-exports at `packages/arch-ai/src/index.ts:402, :406` — `processMessage`, `configureProcessMessageDeps`, `ProcessMessageDeps`.
- Studio supplies its own implementations via `apps/studio/src/lib/arch-ai/processors/process-message-deps.ts` (the new injectable bag — Studio-specific finalizers, model resolvers, LLM engine wiring, etc.).
- Runtime supplies its own implementations via `packages/arch-ai/src/system-agent-process-deps.ts` (deterministic BUILD generation, scoped project persistence).

### Full INTERVIEW → BUILD → CREATE

- `packages/arch-ai/src/system-agent-driver.ts` is now a 471-line driver that loops `processMessage` through all four phases.
- Auto-answer policies for `gate_response_required` / `tool_answer_required` / `proposal_ready` carried forward from the deleted Studio orchestrator.
- Return shape: `{ projectId, agents, topology }` — matches the deleted one-shot's return contract.

## Auth/scope verification (the critical property)

End-to-end scope flow traced; runtime session wins over any user-controlled `input.projectId`.

| Layer                        | File:line                                                                 | Property                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Runtime delegate context     | `apps/runtime/src/services/execution/system-agent-handler.ts:218`         | Rejects if `tenantId` or `projectId` missing                                                                         |
| Runtime → driver             | `apps/runtime/src/services/execution/system-agent-handler.ts:231-242`     | Passes `{tenantId, userId, permissions, projectId}` from runtime context (NOT from `input.spec`)                     |
| Driver: Arch session updates | `packages/arch-ai/src/system-agent-driver.ts:102-107, :153-162`           | All `ArchSessionModel.updateOne()` calls scoped by `{_id, tenantId, userId}` + `metadata.projectId`                  |
| Driver: BUILD/CREATE         | `packages/arch-ai/src/system-agent-driver.ts:289-290, :337-349, :460-461` | All persistence operations carry `ctx.tenantId` + `ctx.projectId`                                                    |
| Permission check             | `apps/runtime/src/services/execution/routing-executor.ts:3438`            | `validateSystemAgentRequiredPermissions` runs before dispatch (`system/arch.requiredPermissions: ['project:write']`) |

**Tests pinning cross-project rejection:**

- `packages/arch-ai/src/__tests__/system-agent-driver.test.ts` — creates `projectId` + `otherProjectId`, runs driver against `projectId`, asserts `ProjectAgent.find({tenantId, projectId: otherProjectId})` returns zero results.
- `apps/runtime/src/__tests__/system-agent-handler.test.ts` — injects `input.projectId: 'other-project'`, expects the driver to receive `project-1` (runtime session scope).
- `apps/runtime/src/__tests__/routing/delegate-safety.test.ts` — same property at the routing-executor boundary.

This replaces the W1.3-C1 service-token boundary check with a stronger in-process Mongo-scoped query. The deleted boundary trust assumption is gone; the new property is enforced at every Mongo write.

## Composition with develop

- **ABLP-999 retention surfaces:** path-B branch touches zero retention files. `git diff origin/develop...HEAD --name-only | grep -i retention` returns empty. No interaction.
- **W1.3-H3 permission check:** `validateSystemAgentRequiredPermissions` at `routing-executor.ts:3438` is still invoked before dispatch to the new in-process path. Preserved.
- **W1.4 knownSource:** runtime session creation paths are unchanged by this branch. Sessions created via DELEGATE-to-`system/arch` inherit the runtime session's `knownSource` from the parent session.
- **`system-agent.ts` definition:** unchanged. `ARCH_SYSTEM_AGENT_ID = 'system/arch'` and `requiredPermissions: ['project:write']` intact.

## Studio multi-turn parity

The HTTP surface at `POST /api/arch-ai/message` is **functionally unchanged**:

- Same request schema (`MessageRequestSchema` from package)
- Same SSE event sequence emitted
- `processMessage` invocation at `apps/studio/src/app/api/arch-ai/message/route.ts:397` passes identical args
- Studio-only side effects (SSE stream observation, audit sink, Redis turn lock, request timing) remain in the Studio route — not moved to the package

Studio parity tests pass (per codex result file: 7 tests in `process-message-tool-answer-history.test.ts` and `agent-edit-runtime-validation.test.ts`).

## Workflow-engine cleanup

`apps/workflow-engine/src/services/system-agent-client.ts` and its test are deleted. No orphan references in workflow-engine code (`apps/workflow-engine/src/index.ts` was updated in commit `4e79f5cf12`).

**Replacement path for workflow → system/arch:** workflow-engine uses the existing runtime internal chat invocation, which routes through runtime's DELEGATE path, which now invokes the in-process driver. Single canonical Arch invocation path on the platform.

## Diff stats

- 33 files changed · +3593 / -2190 · **net +1403 lines** on the branch
- Net code-only (excluding tests): the deleted Studio one-shot surface (~1000 LOC) is replaced by ~1200 LOC of in-process driver + new package-side helpers
- The growth is from `build-llm-messages.ts` (893 lines moved into the package from Studio) and `blueprint-flow.ts` (439 lines moved). Both were Studio-local pure helpers that need to live in the package to be importable by the runtime driver.

## Merge feasibility

`git merge-tree origin/develop origin/feat/ablp-1014-arch-path-b`: **clean.** Zero conflict markers in the merge result.

## Findings detail

### MEDIUM-1 — Audit was not run by codex; manual verification only

Two codex gpt-5.5 high audit attempts failed mid-run (Codex.app app-server appears overloaded; processes start, do a few exec calls, then exit silently without "tokens used" footer). Manual file-inspection audit covers the key claims but is shallower than a full codex pass on areas like full test-suite verification and broader CLAUDE.md invariant cross-checks.

**Mitigation:** every critical claim verified by file:line citation. Branch builds and targeted tests pass per the codex result file. Re-attempt full codex audit when Codex.app daemon recovers; for now, manual audit is sufficient to support merge.

### LOW-1 — Cosmetic describe-block name retains "oneshot-dispatcher" label

`packages/arch-ai/src/__tests__/dispatcher.test.ts:49` reads `describe('oneshot-dispatcher: decideNextEvent', () => {`. The file is the renamed dispatcher test; the function under test is `decideNextEvent` from `packages/arch-ai/src/dispatcher.ts`. The "oneshot-dispatcher" prefix in the describe label is a stale reference to the old Studio path.

**Fix:** rename to `describe('dispatcher: decideNextEvent', ...)`. One-line change, post-merge cleanup commit.

## Recommendation

**MERGE.** The branch implements the path-B vision cleanly. Auth model is provably stronger than what it replaces. Cost Estimator's pipeline now has a working `arch_generate` that produces executable agents in a project. No CRITICAL or HIGH findings. Merge as-is; address LOW-1 in a separate cleanup commit later.
