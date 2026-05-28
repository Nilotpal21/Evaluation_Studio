# Wire 4 Unregistered Arch-AI Tools — Spec

**Date:** 2026-05-05
**Status:** WIP — draft for review
**Addresses:** Gap #1 from [Capabilities & Gaps audit](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md) §7
**Effort:** S (small, single-spec)
**Dependencies:** none — code & permissions already exist

---

## 1. Summary

Four arch-ai tools have working executors, mapped permissions, and full backend code paths — but are NOT registered in `buildInProjectTools`, so the LLM cannot invoke them:

- `agent_ops` — direct agent CRUD
- `deployment_ops` — deployment + channel config
- `testing_ops` — test runs + eval CRUD
- `analytics_ops` — session metrics + anomalies

This spec wires them up. No new backend code required for the ship subset; deferrals listed in §6.

---

## 2. Audit doc correction

The [audit doc](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md) claimed `analytics_ops` had a permission entry but no executor. **This is wrong** — executor exists at [apps/studio/src/lib/arch-ai/tools/analytics-ops.ts:21](apps/studio/src/lib/arch-ai/tools/analytics-ops.ts:21) (`executeAnalyticsOps`). Two of its four actions (`intents`, `quality_scores`) are stubs that return `{ available: false }`; `metrics` and `anomalies` are fully implemented and read directly from MongoDB `Session`.

The audit doc will be patched alongside this spec landing.

---

## 3. Goals & non-goals

### Goals

1. LLM can invoke `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops` from the IN_PROJECT mode.
2. Each tool is allow-listed only to specialists that should have it.
3. The two divergent `IN_PROJECT_SPECIALIST_TOOL_MAP` definitions are resolved (single source of truth or drift-detection test).
4. Permissions are reviewed; any over/under-privileged action is flagged and resolved.
5. Registry-level + executor-level tests cover the new wiring.

### Non-goals

- Channel `bind_to_agent` and friends (per audit §8.2 — new code required, not in this scope).
- Eval Phase 2 full-write surface (per audit §8.3 — `eval_ops` is a future tool).
- Deploy / promote / rollback action UX (deferred to a follow-up; see §6).
- New analytics pipeline for `intents` / `quality_scores` stubs.

---

## 4. Implementation plan

### 4.1 File-level changes

| File                                                                        | Change                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`                     | Add 4 tool registrations                                                                 |
| `packages/arch-ai/src/types/tools.ts`                                       | Add 4 tool names to `ToolName` union; add to `IN_PROJECT_SPECIALIST_TOOL_MAP` per §4.3   |
| `apps/studio/src/lib/arch-ai/tools/build-tools.ts`                          | Mirror `IN_PROJECT_SPECIALIST_TOOL_MAP` updates; resolve existing drift                  |
| `apps/studio/src/lib/arch-ai/guards.ts`                                     | Add `configure_channel` to `DANGEROUS_ACTIONS`; resolve `deployment_ops.rollback` orphan |
| `apps/studio/src/lib/arch-ai/tools/analytics-ops.ts`                        | (optional) Drop `intents`/`quality_scores` from action enum until pipeline exists        |
| `apps/studio/src/__tests__/arch-ai/agent-ops.test.ts`                       | New                                                                                      |
| `apps/studio/src/__tests__/arch-ai/deployment-ops.test.ts`                  | New                                                                                      |
| `apps/studio/src/__tests__/arch-ai/testing-ops.test.ts`                     | New                                                                                      |
| `apps/studio/src/__tests__/arch-ai/analytics-ops.test.ts`                   | New                                                                                      |
| `apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts` | Extend to assert 4 new tool names registered                                             |

### 4.2 Tool registration template

Mirror `tools_ops` at [in-project-tools.ts:2183-2217](apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:2183). Pattern:

```ts
agent_ops: tool({
  description: '<concise, action-enum-aware description>',
  inputSchema: z.object({
    action: z.enum(['read', 'list', 'create', 'modify', 'compile', 'delete', 'propose_modification']),
    agentName: z.string().min(1).optional().describe('Agent name'),
    content: z.string().optional().describe('Full ABL content (for create)'),
    edits: z.array(z.object({
      section: z.string().min(1),
      content: z.string().nullable(),
    })).optional().describe('Section edits (for modify)'),
    dryRun: z.boolean().optional().describe('Validate without writing'),
    confirmed: z.boolean().optional().describe('Confirmation flag (required for delete)'),
    modification: z.string().optional().describe('Free-text mutation (for propose_modification)'),
    changes: z.array(z.object({
      construct: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      rationale: z.string(),
    })).optional().describe('Structured proposal (for propose_modification)'),
  }),
  execute: async (input) => {
    const { executeAgentOps } = await import('@/lib/arch-ai/tools/agent-ops');
    return executeAgentOps(
      input,
      {
        projectId,
        sessionId,
        user: { tenantId: ctx.tenantId, userId: ctx.userId, permissions: ctx.permissions ?? [] },
        authToken,
      },
    );
  },
}),
```

Apply identical structure for `deployment_ops`, `testing_ops`, `analytics_ops`.

**Schema-action alignment:** Each tool's Zod `action` enum must match its executor's `case` branches exactly. From the executors:

| Tool             | Action enum                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `agent_ops`      | `read`, `list`, `create`, `modify`, `compile`, `delete`, `propose_modification`               |
| `deployment_ops` | `list`, `deploy`, `promote`, `configure_channel`, `list_channels` (NOT `rollback` — see §4.4) |
| `testing_ops`    | `run_test`, `create_eval`, `list_evals`                                                       |
| `analytics_ops`  | `metrics`, `anomalies` (drop `intents`, `quality_scores` until pipeline lands — see §4.5)     |

### 4.3 Specialist tool-map updates

Authoritative map: [packages/arch-ai/src/types/tools.ts:115-261](packages/arch-ai/src/types/tools.ts:115). Display copy: [apps/studio/src/lib/arch-ai/tools/build-tools.ts:50-182](apps/studio/src/lib/arch-ai/tools/build-tools.ts:50).

#### New tool assignments

| Tool             | Specialists granted                                              |
| ---------------- | ---------------------------------------------------------------- |
| `agent_ops`      | `abl-construct-expert`, `multi-agent-architect`, `diagnostician` |
| `deployment_ops` | `multi-agent-architect`, `integration-methodologist`             |
| `testing_ops`    | `testing-eval`, `analyst` (read-only `list_evals`)               |
| `analytics_ops`  | `analyst`, `observer`                                            |

Reasoning: each new tool joins the specialist whose existing toolset is closest in domain (e.g., `analytics_ops` mirrors `read_insights` placement; `testing_ops` replaces the standalone `run_test` for `testing-eval`).

#### Resolve existing drift in same change

`build-tools.ts` is missing entries that `types/tools.ts` already has:

| Specialist                  | Add to `build-tools.ts`                          |
| --------------------------- | ------------------------------------------------ |
| `diagnostician`             | `search_docs`                                    |
| `abl-construct-expert`      | `search_docs`                                    |
| `channel-voice`             | `search_docs`                                    |
| `entity-collection`         | `search_docs`                                    |
| `analyst`                   | `search_docs`                                    |
| `observer`                  | `search_docs`                                    |
| `multi-agent-architect`     | `read_agent`, `search_docs`                      |
| `testing-eval`              | `search_docs`                                    |
| `integration-methodologist` | `variable_ops`, `integration_ops`, `search_docs` |

#### Drift-detection test

Add a contract test at `packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts` that asserts both definitions stringify to the same shape. Prevents future drift without forcing a single source of truth (which is a larger refactor).

```ts
it('IN_PROJECT_SPECIALIST_TOOL_MAP definitions agree', () => {
  const fromTypes = packageMap;
  const fromBuildTools = studioMap;
  for (const specialist of Object.keys(fromTypes)) {
    expect(fromBuildTools[specialist]?.sort()).toEqual(fromTypes[specialist]?.sort());
  }
});
```

### 4.4 Permission audit decisions

| Action                               | Current state                                                                                | Decision                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_ops:delete`                   | `agent:delete` perm + in `DANGEROUS_ACTIONS`                                                 | Keep as-is                                                                                                                            |
| `agent_ops:create`                   | `agent:update` perm                                                                          | Keep as-is (no `agent:create` perm exists; would be a separate refactor)                                                              |
| `agent_ops:propose_modification`     | `agent:read` perm, not dangerous                                                             | Keep as-is (matches existing `propose_modification` policy, gated by user-confirm UX)                                                 |
| `deployment_ops:deploy` / `:promote` | `deployment:create` perm + dangerous, executor enforces `confirmed`                          | Keep                                                                                                                                  |
| `deployment_ops:configure_channel`   | `channel:update` perm, **NOT** in `DANGEROUS_ACTIONS`, executor does NOT enforce `confirmed` | **Add to `DANGEROUS_ACTIONS`** in this change. Channel config touches production routing.                                             |
| `deployment_ops:rollback`            | In `DANGEROUS_ACTIONS` but **no executor case + no permission row**                          | **Drop from `DANGEROUS_ACTIONS`** in this change (orphan entry; executor can't dispatch). Add a TODO comment explaining the deferral. |
| `testing_ops:create_eval`            | `session:execute` perm                                                                       | Keep for Phase 1 (per audit §8.3). Phase 2 will introduce `eval:write`.                                                               |
| `analytics_ops:*`                    | All `session:read`                                                                           | Keep                                                                                                                                  |

### 4.5 `analytics_ops` stub actions

Two paths:

**A. Drop stubs from action enum.** The Zod schema at registration time only allows `metrics`, `anomalies`. The LLM never tries to call the unimplemented actions. When the pipeline lands, re-add them in a separate change.

**B. Keep stubs, document them.** LLM can call them and receive `{ available: false }`. Useful signal to the LLM that the action is known but not yet usable.

**Recommendation: A.** Cleaner contract. Mirrors how the IN_PROJECT generalist prompt admits gaps via `search_docs` rather than exposing dead actions.

### 4.6 `deployment_ops` channel actions — keep here for now

Per audit §8.2, future `channel_ops` will own bind/unbind. But §8.2's `channel_ops` is bind-only — `list_channels` and `configure_channel` don't fit there. Keep them in `deployment_ops` until §8.2's `channel_ops` lands, then evaluate whether to migrate.

### 4.7 `testing_ops` collision with standalone `run_test`

The standalone `run_test` tool is registered at [in-project-tools.ts:1467](apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:1467) and assigned to `testing-eval` in `IN_PROJECT_SPECIALIST_TOOL_MAP`.

**Decision: collapse into `testing_ops`.** Reasoning:

- Avoids two tools doing the same thing.
- `testing_ops:run_test` is functionally identical (calls same `executeTestingOps`).
- Reduces specialist toolset surface area.

**Migration:** remove `run_test:` block from `in-project-tools.ts`; replace `'run_test'` with `'testing_ops'` in both tool maps for `testing-eval` specialist.

### 4.8 `testing_ops:create_eval` scenario-persistence caveat

The executor at `testing-ops.ts:193-205` writes only `name + description` to `eval-repo.createEvalSet`. Scenarios passed in `evalConfig.scenarios` are **silently dropped**. Phase 1 ships as-is with this caveat documented in the tool description string. Phase 2 (eval write) will fix this.

Description string for `testing_ops`: includes the disclaimer "create_eval persists set metadata only; scenarios saved separately via Studio UI in this phase".

---

## 5. Test plan

### 5.1 Executor-level tests (4 new files)

Mirror [apps/studio/src/**tests**/arch-ai/integration-ops.test.ts:1-130](apps/studio/src/__tests__/arch-ai/integration-ops.test.ts:1) pattern:

- Hoist mocks via `vi.hoisted`.
- Mock the executor's _imported peers_ only (repos, services, runtime fetch).
- Build a `ToolPermissionContext` with project + user.
- Lazy `await import(...)` of the executor inside test body.
- Assert on `result.success`, `result.data`, mocked-fn call args.

Per-tool minimum coverage:

| Tool             | Test cases (minimum)                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_ops`      | each of 7 actions × happy path; delete without `confirmed` returns `needsConfirmation`; create with invalid ABL returns error         |
| `deployment_ops` | `list`, `list_channels`, `configure_channel` happy paths; `deploy`/`promote` with `confirmed:false` returns `needsConfirmation`       |
| `testing_ops`    | `run_test` mocks runtime fetch; `list_evals` happy path; `create_eval` writes name/description, ignores scenarios with logged warning |
| `analytics_ops`  | `metrics` happy path with seeded sessions; `anomalies` detects errors/empty/escalation                                                |

### 5.2 Registry-level test

Extend [apps/studio/src/**tests**/arch-ai/engine-factory-in-project-tools.test.ts:56-72](apps/studio/src/__tests__/arch-ai/engine-factory-in-project-tools.test.ts:56) to assert all 4 new tool names appear in `buildInProjectTools` output and their input schemas accept the documented action enums.

### 5.3 Drift-detection test

`packages/arch-ai/src/__tests__/specialist-tool-map-drift.test.ts` per §4.3.

### 5.4 What's NOT covered in this spec

- E2E test that an LLM specialist actually picks the new tool and invokes it — that's a `process-message` test, currently absent for this category. Out of scope; flagged in audit as a separate gap.

---

## 6. Migration / rollout

### 6.1 Sequencing

Single commit. Changes are additive (no deletions of existing exports) — passes the additive-only feat() commit guard in CLAUDE.md.

Order within the commit:

1. Add `ToolName` union entries.
2. Add tool registrations in `in-project-tools.ts`.
3. Update both `IN_PROJECT_SPECIALIST_TOOL_MAP` definitions.
4. Update `guards.ts` (add `configure_channel` to dangerous; remove orphan `rollback`).
5. Add tests.
6. Run `npx prettier --write` on changed files.
7. Run `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio` to catch type errors.

### 6.2 JIRA

Create one ticket: "ABLP-xxx feat(arch-ai): wire 4 unregistered in-project tools (agent/deployment/testing/analytics)".

### 6.3 Rollout

No feature flag needed. Changes are LLM-facing tool exposures gated by existing permissions. Any tenant whose principals hold the relevant permissions immediately sees the new actions.

### 6.4 Rollback contract

If a tool exposure causes issues in production, the rollback is a clean revert of the tool registration block — no schema migrations, no data state to unwind.

---

## 7. Open questions / deferred items

1. **Channel agent-binding (`channel_ops` per audit §8.2)** — separate spec. Requires backend work (new column or collection on `SDKChannel`). Tracked as gap #1's follow-up.
2. **Deploy/promote UX** — `deployment_ops:deploy` and `:promote` are tested at executor level but lack a confirmation widget UX. Deferred — when that lands, both can be added to the action enum here.
3. **`rollback`** — orphan in `DANGEROUS_ACTIONS` today. This spec drops it. If rollback becomes a real feature, both the executor case and the dangerous-action entry get added together.
4. **Eval Phase 2 (`eval_ops`)** — full read/write per audit §8.3. Separate spec when eval-quality validators land.
5. **Analytics pipeline for `intents` / `quality_scores`** — separate work item. Re-add to `analytics_ops` enum when the pipeline produces real data.
6. **Permission for `agent:create`** — currently `agent_ops:create` uses `agent:update`. Not blocking for this spec; flag for the permission-system owner if the distinction matters.

---

## 8. Acceptance criteria

- [ ] `pnpm build --filter=@agent-platform/arch-ai --filter=@agent-platform/studio` clean.
- [ ] `pnpm test --filter=@agent-platform/studio -- arch-ai` passes including 4 new executor tests + registry test + drift test.
- [ ] LLM in IN_PROJECT mode can invoke each of the 4 tools (verified via `engine-factory-in-project-tools.test.ts`).
- [ ] `guards.ts:DANGEROUS_ACTIONS` no longer references `deployment_ops:rollback`; does reference `deployment_ops:configure_channel`.
- [ ] Both `IN_PROJECT_SPECIALIST_TOOL_MAP` definitions agree (drift test passes).
- [ ] No deletions of existing exported symbols; commit passes additive-only guard.
- [ ] Audit doc patched to remove the `analytics_ops` "no executor" claim.

---

## 9. References

- Audit: [packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md](./2026-05-05-arch-ai-capabilities-and-gaps-audit.md)
- Tool registration template: [apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:2183-2217](apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:2183)
- Executor template (test pattern): [apps/studio/src/**tests**/arch-ai/integration-ops.test.ts:1-130](apps/studio/src/__tests__/arch-ai/integration-ops.test.ts:1)
- Permission map: [apps/studio/src/lib/arch-ai/guards.ts](apps/studio/src/lib/arch-ai/guards.ts)
- Specialist tool maps: [packages/arch-ai/src/types/tools.ts:115](packages/arch-ai/src/types/tools.ts:115), [apps/studio/src/lib/arch-ai/tools/build-tools.ts:50](apps/studio/src/lib/arch-ai/tools/build-tools.ts:50)
- CLAUDE.md cross-cutting rules: commit scope guard, additive-only feat(), prettier-before-commit
