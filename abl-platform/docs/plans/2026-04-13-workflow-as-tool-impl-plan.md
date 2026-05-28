# LLD: Workflow-as-Tool

**Feature Spec**: `docs/features/workflow-as-tool.md`
**HLD**: `docs/specs/workflow-as-tool.hld.md`
**Test Spec**: `docs/testing/workflow-as-tool.md`
**Status**: DONE
**Date**: 2026-04-13

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                                      | Rationale                                                                                                                                        | Alternatives Rejected                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| D-1  | Layer-first phasing (IR → DSL/shared → DB → runtime → Studio) across 6 phases, one concern per commit.                        | CLAUDE.md commit discipline caps at 3 packages & 40 files per commit; vertical slice would violate the guard.                                    | Vertical slice per FR.                                                                              |
| D-2  | Mirror SearchAI KB-as-tool end-to-end (executor shape, wiring location, internal JWT pattern).                                | Feature spec, HLD, and test spec all name it as the structural template; proven, well-reviewed path.                                             | Build a workflow-SDK package wrapping the HTTP client; auto-expose every workflow.                  |
| D-3  | `WorkflowBindingIR.triggerId` declared **optional** at the type level; validator enforces non-empty for `tool_type:workflow`. | Keeps the exported interface additive (backward-compatible for any latent `@abl/compiler` consumer); runtime correctness preserved via Zod.      | Required field (breaking); separate overloaded type.                                                |
| D-4  | `WorkflowToolExecutor` implements the existing `ToolExecutor` interface; one instance per agent session.                      | Matches `SearchAIKBToolExecutor` lifecycle; natural blast-radius isolation; reuses the dispatcher arm already at `tool-binding-executor.ts:573`. | Singleton service; per-tenant pool.                                                                 |
| D-5  | Engine POST body carries `triggerId` inside `triggerMetadata`, not as a top-level field.                                      | Engine ignores top-level `triggerId`; metadata keeps it in the execution record for traceability. Matches HLD §5 data-flow fix.                  | Top-level field (silently ignored); omit entirely (loses traceability).                             |
| D-6  | Error normalizer branches on `typeof body.error` (string vs object with `code`) to handle the **mixed** engine envelope.      | Engine returns both shapes depending on the error; HLD Concern #5 enumerates all mappings.                                                       | Assume flat-string only (breaks on `RESTATE_START_FAILED`); require engine refactor (out of scope). |
| D-7  | Sync-poll exp backoff schedule: `[250ms, 500ms, 1_000ms, 2_000ms]` then cap at 2 s until `timeoutMs` elapses.                 | HLD Concern #9 budget; gives first status flip in ≤ 250 ms while keeping tail < 2 s per poll.                                                    | Constant 500 ms; full exponential without cap (up to 32 s).                                         |
| D-8  | Cancel POST on timeout treats **409** ("execution already terminal") as benign — log at `debug`, swallow, keep timeout error. | Prevents a benign race from masking the real timeout error on the agent.                                                                         | Surface 409 as a separate error; fail-fast on any cancel failure.                                   |
| D-9  | No feature flag. Kill-switch is hot-archive of `toolType:'workflow'` docs or revert.                                          | HLD Concern #11: fully opt-in, dispatcher branch isolated, no impact on other tool types.                                                        | Env-var flag; tenant feature flag.                                                                  |
| D-10 | `paramMapping: Record<string, string>` with JSONPath values; DSL property is a flat `<json-object>`.                          | Matches existing IR type; JSONPath is already the convention for other mappings in the runtime.                                                  | Nested JSON (unused in v1); DSL-native mini-language.                                               |
| D-11 | Test-first per phase, tests committed separately from feature code but within the same phase branch work.                     | CLAUDE.md `test()` vs `feat()` commit-type separation; keeps audit reviewers focused.                                                            | All tests at the end (risk of testing-to-pass); all tests upfront (blocks IR changes).              |
| D-12 | Test infra uses DI fakes for Restate + Mongoose models ONLY; no `vi.mock` of `@agent-platform/*` or `@abl/*`.                 | CLAUDE.md test architecture hard rule; test spec §5–§7 already encode this.                                                                      | Platform-level mocking.                                                                             |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/ir/schema.ts — MODIFIED
export interface WorkflowBindingIR {
  workflowId: string;
  /**
   * Optional at the type level for additive compatibility.
   * Validator (`tool-schema-validator.ts`) requires a non-empty string for
   * every `tool_type: 'workflow'` binding. Must reference a webhook trigger.
   */
  triggerId?: string;
  mode: 'sync' | 'async';
  /** Flat map of workflow-input-name → JSONPath expression (e.g. { topic: '$.query' }). */
  paramMapping: Record<string, string>;
  timeoutMs?: number;
}

// packages/shared/src/tools/dsl-property-parser.ts — NEW EXPORT
export interface WorkflowBindingLocal {
  workflowId: string;
  triggerId: string; // runtime-required
  mode: 'sync' | 'async';
  timeoutMs?: number;
  paramMapping: Record<string, string>;
}
export function buildWorkflowBindingFromProps(props: Record<string, string>): WorkflowBindingLocal;

// apps/runtime/src/services/workflow/workflow-tool-executor.ts — NEW
export interface WorkflowToolExecutorConfig {
  workflowEngineUrl: string; // process.env.WORKFLOW_ENGINE_URL
  authToken: string; // internal service JWT, 1h TTL
  projectId: string;
  tenantId: string;
  /** Per-session context — used in triggerMetadata + trace event tags. */
  sessionId?: string;
  agentName?: string;
  defaultTimeoutMs?: number; // default 60_000
}

export interface WorkflowMeta {
  name: string;
  description?: string;
  inputVariables: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'json';
    required: boolean;
    description?: string;
  }>;
  triggerMode: 'sync' | 'async';
}

export interface WorkflowExecuteResult {
  status: 'completed' | 'running' | 'failed' | 'cancelled' | 'rejected';
  executionId: string;
  output?: Record<string, unknown>;
}

export class WorkflowToolExecutor implements ToolExecutor {
  constructor(cfg: WorkflowToolExecutorConfig);
  registerBinding(toolName: string, binding: WorkflowBindingIR, meta: WorkflowMeta): void;
  /**
   * Matches the existing `ToolExecutor.execute` 3-arg signature used by
   * `ToolBindingExecutor` and mirrored by `SearchAIKBToolExecutor`. Session
   * context (sessionId, agentName) is injected via the constructor config
   * — NOT via per-call args — because the dispatcher never passes a 4th arg.
   */
  execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkflowExecuteResult>;
  /** Mirrors SearchAI's `{ name, params }` call shape, not `{ toolName, ... }`. */
  executeParallel(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
    timeoutMs: number,
  ): Promise<Array<{ name: string; result?: WorkflowExecuteResult; error?: string }>>;
}
```

### Module Boundaries

| Module                                                                      | Responsibility                                                                                  | Depends On                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/*`                                       | IR schema for `tool_type:'workflow'`; validation arms; hint inference defaults.                 | `zod`, `@agent-platform/shared-kernel`                                       |
| `packages/shared/src/tools/*`                                               | DSL ↔ IR parsing; project-tool validator webhook-trigger enforcement; tool adapters.            | `@abl/compiler`, `@agent-platform/database`                                  |
| `packages/database/src/models/project-tool.model.ts` + `tool-extractor.ts`  | Persist `toolType:'workflow'`; read-side extractor for the shared tool pipeline.                | `mongoose`                                                                   |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (new)        | HTTP client to workflow-engine; sync-poll loop, async return, cancel-on-timeout, normalizer.    | `native fetch`, `@agent-platform/shared-observability` (logger + traceStore) |
| `apps/runtime/src/tools/load-project-tools-as-ir.ts`                        | Convert DB `project_tools` → IR `ToolDefinition[]` including `workflow_binding` + `parameters`. | `@abl/compiler`, `@agent-platform/shared`, `@agent-platform/database`        |
| `apps/runtime/src/services/execution/llm-wiring.ts`                         | Mint internal JWT, construct executor per session, register tool bindings, emit telemetry.      | `WorkflowToolExecutor`, `jsonwebtoken`                                       |
| `apps/studio/src/components/tools/*` + `store/*` + `lib/abl-serializers.ts` | Create/edit workflow-tool form; list tab; DSL emit for persistence.                             | Existing Studio tool subsystem                                               |

---

## 2. File-Level Change Map

### New Files

| File                                                                                         | Purpose                                                                            | LOC Estimate |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`                               | `WorkflowToolExecutor` (POST + sync-poll + async return + cancel + normalizer).    | ~380         |
| `apps/runtime/src/services/workflow/__tests__/workflow-tool-executor.unit.test.ts`           | UT-4, UT-6 (normalizer, exp-backoff math, param mapping pass-through vs JSONPath). | ~220         |
| `apps/runtime/src/__tests__/integration/workflow/workflow-tool-executor.integration.test.ts` | INT-1, INT-2, INT-3, INT-7 (real engine, random port, DI fakes for Restate/Mongo). | ~420         |
| `apps/runtime/src/__tests__/workflow-tool-agent.e2e.test.ts`                                 | E2E-1, E2E-2, E2E-3, E2E-6 (agent ↔ workflow tool).                                | ~320         |
| `apps/runtime/src/__tests__/workflow-tool-validation.e2e.test.ts`                            | E2E-4, E2E-5 (webhook-only reject + cross-project 404).                            | ~180         |
| `apps/runtime/src/__tests__/workflow-tool-auth.e2e.test.ts`                                  | E2E-7 (401/403/expired-JWT/internal-JWT verification).                             | ~180         |
| `apps/runtime/src/tools/__tests__/load-project-tools-as-ir.workflow.test.ts`                 | INT-5 (DB doc → IR tool parameters derived from `start.inputVariables`).           | ~180         |
| `packages/shared/src/__tests__/project-tool-validator.workflow.test.ts`                      | INT-4 (webhook-only + missing trigger + wrong trigger type + cross-project).       | ~220         |
| `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts`                | INT-6 (engine-side cross-tenant/project 404).                                      | ~160         |

### Modified Files

| File                                                                       | Change Description                                                                                                                                                                                                                                                                                                                                             | Risk     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/compiler/src/platform/ir/schema.ts`                              | Add optional `triggerId?: string` to `WorkflowBindingIR` (line 881-886). Update Zod at sibling `z.object` if applicable.                                                                                                                                                                                                                                       | Low      |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`               | Add `'workflow'` to `VALID_TOOL_TYPES` (line 34). Add `case 'workflow':` arm in `validateToolEntry` (line 84-89) requiring `workflow_binding.{workflowId, triggerId}` non-empty strings.                                                                                                                                                                       | Low      |
| `packages/compiler/src/platform/ir/compiler.ts`                            | Add `case 'workflow':` to default-hint inference switch (line 903-921): `{ latency: 'slow', side_effects: true, parallelizable: false }` (enum is `'fast' \| 'medium' \| 'slow'`).                                                                                                                                                                             | Low      |
| `packages/compiler/src/__tests__/constructs/tool-schema-validator.test.ts` | Add tests UT-2: accepts valid workflow binding, rejects missing `workflowId`, rejects missing `triggerId`.                                                                                                                                                                                                                                                     | Low      |
| `packages/compiler/src/__tests__/tool-binding-executor-connector.test.ts`  | Extend existing `case 'workflow':` test to assert `workflowToolExecutor.execute` invoked with correct args (UT-3).                                                                                                                                                                                                                                             | Low      |
| `packages/shared/src/tools/dsl-property-parser.ts`                         | Add `WorkflowBindingLocal` + `buildWorkflowBindingFromProps` after line 515. Reads `workflow_id`, `trigger_id`, `mode`, `timeout_ms`, optional `param_mapping` JSON.                                                                                                                                                                                           | Low      |
| `packages/shared/src/tools/index.ts`                                       | Export `buildWorkflowBindingFromProps` and `WorkflowBindingLocal` (additive).                                                                                                                                                                                                                                                                                  | Low      |
| `packages/shared/src/__tests__/dsl-property-parser.test.ts`                | Add UT-1: roundtrip + defaults + invalid JSON in `param_mapping`.                                                                                                                                                                                                                                                                                              | Low      |
| `packages/shared/src/tools/project-tool-validator.ts`                      | Add `case 'workflow':` in the validator dispatch (~line 318-331) and in the binding builder (~line 574-587). Implement `validateWorkflowTool` that (a) loads workflow by `{_id, tenantId, projectId}`, (b) asserts `status:'active'`, (c) looks up `triggerId` in `workflow.triggers[]`, (d) asserts trigger `type === 'webhook'`.                             | Med      |
| `packages/shared/src/tools/standalone-tool-adapter.ts`                     | Extend `toolType` cast (line 286-298) with `'workflow'`; add `if (toolType === 'workflow')` branch constructing `workflow_binding`.                                                                                                                                                                                                                            | Low      |
| `packages/shared/src/tools/resolve-tool-implementations.ts`                | Add `workflowBinding` to `ResolvedToolImpl` (line 68); `case 'workflow':` in resolver (line 480-497); map in `toToolDefinition` (line 559-564).                                                                                                                                                                                                                | Low      |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                  | Add `case 'workflow':` (line 44-53) emitting `type: workflow / workflow_id / trigger_id / mode / timeout_ms / param_mapping`.                                                                                                                                                                                                                                  | Low      |
| `packages/database/src/models/project-tool.model.ts`                       | Add `'workflow'` to `PROJECT_TOOL_TYPES` array (line 18). Mongoose `enum` picks it up automatically at the schema definition (line 73).                                                                                                                                                                                                                        | Low      |
| `packages/database/src/tool-extractor.ts`                                  | Extend `ToolType` alias (line 12); add `case 'workflow':` in parse switch (line 90-94).                                                                                                                                                                                                                                                                        | Low      |
| `apps/runtime/src/tools/load-project-tools-as-ir.ts`                       | Extend type cast at line 117 to include `'workflow'`; add `case 'workflow':` (after line 142) that (a) calls `buildWorkflowBindingFromProps`, (b) loads the referenced workflow document, (c) derives `tool.parameters` JSON Schema from `start.inputVariables`, (d) attaches `workflow_binding`.                                                              | Med      |
| `apps/runtime/src/services/execution/llm-wiring.ts`                        | Insert workflow wiring block right after SearchAI block at ~line 994 (50 LOC): filter `allTools` by `tool_type === 'workflow'`, mint internal JWT, instantiate `WorkflowToolExecutor`, call `registerBinding` per tool, pass executor into `ToolBindingExecutor` (which already accepts it at line 92,226). Add `workflowTools` to telemetry log at line 1301. | **High** |
| `apps/runtime/src/__tests__/llm-wiring-telemetry.test.ts`                  | UT-5: telemetry log includes `workflowTools`.                                                                                                                                                                                                                                                                                                                  | Low      |
| `apps/studio/src/store/tool-store.ts`                                      | Add `'workflow'` to `ToolType` union (line 14).                                                                                                                                                                                                                                                                                                                | Low      |
| `apps/studio/src/store/agent-detail-store.ts`                              | Map `workflow_binding` ↔ `workflowBinding` at line 70 & 399-403.                                                                                                                                                                                                                                                                                               | Low      |
| `apps/studio/src/components/tools/ToolCreateDialog.tsx`                    | Add Workflow option to `TOOL_TYPE_OPTIONS` (line 45-54).                                                                                                                                                                                                                                                                                                       | Low      |
| `apps/studio/src/components/tools/sections/ToolConfigurationSection.tsx`   | New workflow form (line 67-80 area): searchable workflow picker (`status:'active'`, project-scoped), webhook-trigger picker, mode selector pre-filled from trigger node, readonly preview of `inputVariables`, `timeoutMs` input (sync only), empty-state when no webhook triggers.                                                                            | Med      |
| `apps/studio/src/components/tools/ToolDetailPage.tsx`                      | Read-only Workflow Binding panel (line 106, 184, 186, 737-788), analogous to SearchAI panel.                                                                                                                                                                                                                                                                   | Low      |
| `apps/studio/src/components/tools/ToolsListPage.tsx`                       | Add Workflow tab (line 42, 117, 127).                                                                                                                                                                                                                                                                                                                          | Low      |
| `apps/studio/src/components/tools/ToolTypeBadge.tsx`                       | Color/icon/label for workflow (line 17, 24, 31).                                                                                                                                                                                                                                                                                                               | Low      |
| `apps/studio/src/lib/abl-serializers.ts`                                   | DSL emit block for workflow (line 105-111).                                                                                                                                                                                                                                                                                                                    | Low      |
| `apps/studio/src/services/tool-test-service.ts`                            | `case 'workflow':` invoking the workflow execute endpoint with the test payload (line 158-173).                                                                                                                                                                                                                                                                | Low      |

### Deleted Files

None. Feature is purely additive.

---

## 3. Implementation Phases

### Phase 1: IR & Validator Foundation

**Goal**: Make `tool_type: 'workflow'` a valid type across the compiler IR layer without any runtime behavior change.

**Tasks**:
1.1. Add optional `triggerId?: string` to `WorkflowBindingIR` in `packages/compiler/src/platform/ir/schema.ts:881-886` (and matching Zod schema if present).
1.2. Add `'workflow'` to `VALID_TOOL_TYPES` Set in `tool-schema-validator.ts:34`.
1.3. Add `else if (tool.tool_type === 'workflow') { ... }` arm at `tool-schema-validator.ts:84-90` (the file uses an `if/else if` chain, not `switch`). Requires `tool.workflow_binding` object with non-empty `workflowId` and `triggerId`. Also update the stale error message at `tool-schema-validator.ts:79` to list all valid types dynamically (`Array.from(VALID_TOOL_TYPES).join(', ')`) so new additions don't regress the user-facing error.
1.4. Add `case 'workflow':` hint-inference in `compiler.ts:903-921` → `{ latency: 'slow', side_effects: true, parallelizable: false }` — the hint enum is `'fast' | 'medium' | 'slow'` (compiler.ts:899). 'slow' matches http and mcp.
1.5. Write UT-2 in `tool-schema-validator.test.ts` (accept valid, reject missing `workflowId`, reject missing `triggerId`).
1.6. Write UT-3 extension in `tool-binding-executor-connector.test.ts` verifying the `workflow` dispatch arm invokes the executor with the bound args.

**Files Touched**:

- `packages/compiler/src/platform/ir/schema.ts` — add `triggerId?`.
- `packages/compiler/src/platform/ir/tool-schema-validator.ts` — add tool-type entry + validation arm.
- `packages/compiler/src/platform/ir/compiler.ts` — add hint inference case.
- `packages/compiler/src/__tests__/constructs/tool-schema-validator.test.ts` — UT-2.
- `packages/compiler/src/__tests__/tool-binding-executor-connector.test.ts` — UT-3 extension.

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 TS errors.
- [ ] `pnpm test --filter=@abl/compiler -- tool-schema-validator` passes with the new UT-2 tests.
- [ ] `pnpm test --filter=@abl/compiler -- tool-binding-executor-connector` passes with updated UT-3.
- [ ] Grep confirms no existing consumer of `WorkflowBindingIR` broke (`rg "WorkflowBindingIR" packages/ apps/` returns expected call sites).

**Test Strategy**:

- Unit only. The compiler package has no integration tests — all IR + validator coverage is unit-level.

**Rollback**: `git revert` the phase commits; no persisted state.

**Covers**: FR-1 (partial — IR side), FR-2 (partial — shape validation). Test spec: UT-2, UT-3.

---

### Phase 2: DSL Parser, Database, and Shared-Tool Plumbing

**Goal**: Round-trip a `toolType:'workflow'` document through the DB → shared adapters → DSL → IR without runtime execution.

**Tasks**:
2.1. Add `'workflow'` to `PROJECT_TOOL_TYPES` in `packages/database/src/models/project-tool.model.ts:18`.
2.2. Extend `ToolType` alias in `packages/database/src/tool-extractor.ts:12`. The parse arm at line 88-95 is an `if/else if` chain (NOT a switch) terminating in `else toolType = 'sandbox'`. Insert `else if (typeVal === 'workflow') toolType = 'workflow';` **before** the terminal `else` fallback — otherwise workflow DSL blocks silently default to `sandbox`.
2.3. Add `WorkflowBindingLocal` + `buildWorkflowBindingFromProps` to `packages/shared/src/tools/dsl-property-parser.ts` immediately after `buildSearchAIBindingFromProps` (line 515). Reads `workflow_id` (required), `trigger_id` (required), `mode` (default `'sync'`), `timeout_ms` (optional number), `param_mapping` (optional JSON object).
2.4. Export the new symbol from `packages/shared/src/tools/index.ts`.
2.5. Extend `standalone-tool-adapter.ts:286-298` and `resolve-tool-implementations.ts:68,480-497,559-564` with `workflow` branches. The `toolType` cast at `standalone-tool-adapter.ts:286` is a literal union `as 'http' | 'sandbox' | 'mcp' | 'searchai'` — widen to include `'workflow'`. Add a `workflow_binding` local variable and an `if (toolType === 'workflow')` branch that builds it via `buildWorkflowBindingFromProps` and includes it in the returned `ToolDefinitionLocal`.
2.6. Add `case 'workflow':` to `serialize-tool-form-to-dsl.ts:44-53` emitting the canonical DSL block.
2.7. **Extend all tool-type literal unions** in `packages/shared/src/tools/resolve-tool-implementations.ts`:

- `ResolvedToolImpl.toolType` at line 59 — add `'workflow'`.
- Add `workflowBinding?: WorkflowBindingLocal` field alongside `searchaiBinding` at line 68.
- `ToolDefinitionLocal.tool_type` at line 109 — add `'workflow'`; add `workflow_binding?: WorkflowBindingLocal` at line ~114 (or wherever sibling bindings sit). Required so `toToolDefinition` (line 559-564) typechecks.
- `ToolSnapshotEntry.toolType` at line 123 — add `'workflow'` so IR snapshot caching does not drop workflow tools.
  2.8. **Add Zod `CreateWorkflowToolSchema`** in `packages/shared/src/validation/project-tool-schemas.ts` after the existing `CreateMcpToolSchema` (line 148): `ToolFormBaseSchema.extend({ toolType: z.literal('workflow'), workflowId: z.string().min(1), triggerId: z.string().min(1), mode: z.enum(['sync','async']).default('sync'), timeoutMs: z.number().int().min(1000).max(600_000).optional(), paramMapping: z.record(z.string(), z.string()).optional() })`. Add it to the `CreateProjectToolSchema` discriminated union at line 152-155. Export type. **Without this, every `POST /api/projects/:id/tools` with `toolType:'workflow'` is rejected at request validation.**
  2.9. Write UT-1 in `packages/shared/src/__tests__/dsl-property-parser.test.ts` (roundtrip + defaults + invalid JSON in `param_mapping` throws structured parse error). Add a sibling test in `packages/shared/src/validation/__tests__/project-tool-schemas.workflow.test.ts` asserting the Zod union accepts a valid workflow payload and rejects missing `workflowId`/`triggerId`.

**Files Touched**:

- `packages/database/src/models/project-tool.model.ts`, `packages/database/src/tool-extractor.ts`.
- `packages/shared/src/tools/dsl-property-parser.ts`, `index.ts`, `standalone-tool-adapter.ts`, `resolve-tool-implementations.ts`, `serialize-tool-form-to-dsl.ts`.
- `packages/shared/src/validation/project-tool-schemas.ts` (new `CreateWorkflowToolSchema` + discriminated-union arm).
- `packages/shared/src/__tests__/dsl-property-parser.test.ts`, `packages/shared/src/validation/__tests__/project-tool-schemas.workflow.test.ts` (new).

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database --filter=@agent-platform/shared` succeeds with 0 TS errors.
- [ ] `pnpm test --filter=@agent-platform/shared -- dsl-property-parser` passes UT-1 (3 sub-cases: valid, defaults, invalid JSON).
- [ ] A crafted `project_tools` document with `toolType:'workflow'` and a well-formed `dslContent` parses round-trip (asserted in UT-1).
- [ ] `commit-scope-guard` permits the commits (≤ 3 packages per commit — split database vs shared vs compiler-tests).

**Test Strategy**:

- Unit tests only in this phase. Integration coverage of the validator + IR-loader follows in Phase 4.

**Rollback**: `git revert`. Existing documents with other `toolType` values are unaffected (no data migration).

**Covers**: FR-1 (full), FR-2 (shape + DSL parsing). Test spec: UT-1.

---

### Phase 3: Runtime Executor (`WorkflowToolExecutor`)

**Goal**: Deliver the concrete `ToolExecutor` that POSTs to the engine, polls for sync, returns immediately for async, cancels on timeout, and normalizes the mixed engine error envelope — validated against a real workflow-engine instance.

**Tasks**:
3.1. Create directory + file `apps/runtime/src/services/workflow/workflow-tool-executor.ts` implementing the class in §1 "Key Interfaces". Native `fetch` only; no new deps.
3.2. Implement `registerBinding(name, binding, meta)` caching the binding + inputVariables in an internal `Map<string, { binding, meta }>`. **Map lifecycle**: bounded by session lifetime (one executor per agent session) and by project tool count (typically < 50 bindings). No eviction needed — the Map is released when the session ends. This mirrors `SearchAIKBToolExecutor.toolBindings` and satisfies the CLAUDE.md "every in-memory Map needs max-size / TTL / eviction" rule via session-scoped lifetime.
3.3. Implement `execute(name, params, timeoutMs)` — **3-arg signature, matching existing `ToolExecutor` contract** (verified against `searchai-kb-tool-executor.ts:128-132`). Session context (`sessionId`, `agentName`) is read from `this.cfg` (set at construction), NOT from a 4th arg:

- Resolve binding; if missing throw with message `` `Workflow tool "${toolName}" has no registered binding. Ensure the tool is registered via registerBinding().` `` (mirrors SearchAI's format).
- Default `timeoutMs` to the caller's value or `cfg.defaultTimeoutMs ?? 60_000`.
- Apply `paramMapping`: if empty → pass-through. Otherwise each value is a JSONPath string — resolve it against `params` using an existing JSONPath helper (`packages/shared` — confirm import during implementation; fall back to a minimal `$.field.subfield` resolver if no shared helper exists).
- Build body `{ payload, triggerType:'api', triggerMetadata:{ source:'agent_tool', sessionId: this.cfg.sessionId, agentName: this.cfg.agentName, triggerId: binding.triggerId } }`.
- **`toolCallId` propagation (HLD Concern #7 idempotency)**: the existing 3-arg `ToolExecutor.execute` contract has no slot for `toolCallId`, and we intentionally did NOT widen it (keeps dispatcher additive-safe). **v1 gap**: `toolCallId` is NOT forwarded to the engine. Re-try idempotency is preserved end-to-end only if the agent loop deduplicates tool_call IDs before dispatch (LLMWiringService already dedupes by `toolCallId` at the top of its tool_call handler — confirm in Phase 5). Tracked as tech debt in `docs/sdlc-logs/workflow-as-tool/lld.log.md`; a follow-up widens the contract once SearchAI needs it too.
- `POST ${workflowEngineUrl}/api/projects/:projectId/workflows/:workflowId/executions/execute` with `Authorization: Bearer ${authToken}`.
- Parse `{ success, executionId }` from 202 body; on non-2xx → run the normalizer (D-6).
- If `mode === 'async'` → emit `tool.workflow.execute.start` + `tool.workflow.execute.complete` trace events and return `{ executionId, status:'running' }`.
- If `mode === 'sync'` → enter poll loop (D-7 schedule). Break on `status ∈ {completed, failed, cancelled, rejected}`. On `timeoutMs` elapsed → `POST .../cancel` (swallow 409 per D-8), emit `tool.workflow.execute.timeout`, throw `ToolExecutionError('workflow execution timed out after <ms>ms')`.
- On terminal `completed` → return `{ status, output, executionId }`. On terminal `failed/cancelled/rejected` → normalize engine payload → throw `ToolExecutionError`.
- **Error code discrimination** (matches SearchAI executor + HLD Error Responses table): - Sync timeout → `ToolExecutionError` with `code: 'TOOL_TIMEOUT'`, message `"workflow execution timed out after <ms>ms"`. - Terminal `failed|cancelled|rejected` → `code: 'TOOL_EXECUTION_ERROR'`, message from the normalized engine envelope. - Network error / engine unreachable / non-2xx before execution starts → `code: 'TOOL_NETWORK_ERROR'`, message from normalizer (includes upstream status when available).
  3.4. Implement `executeParallel(calls, timeoutMs)` using `Promise.allSettled`, mirroring SearchAI's `{name, params}[]` shape (NOT `{toolName, params}[]`) and its `{name, result?, error?}[]` return shape.
  3.5. Normalizer helper (`private normalizeEngineError(status, body)`): implements the shape-check table from HLD Concern #5 — flat-string, structured `{code,message}`, network errors, 502/`RESTATE_START_FAILED` forwarding.
  3.6. Trace events: `tool.workflow.execute.{start, poll, complete, timeout, cancel, error}` via shared `traceStore` with tags `{ executionId, workflowId, triggerId, mode, latencyMs }`. Logger via `createLogger('workflow-tool-executor')`.
  3.7. Write UT-4 + UT-6 in `workflow-tool-executor.unit.test.ts`: normalizer handles both envelope shapes + 409-on-cancel; exp-backoff schedule matches D-7; `paramMapping` pass-through + JSONPath resolution.
  3.8. Write INT-1, INT-2, INT-3, INT-7 in `workflow-tool-executor.integration.test.ts`: real workflow-engine app on random port + DI fakes for Restate/Mongoose models (pattern from `workflow-executions-routes.test.ts:39-51`). Seeds an active workflow with one webhook trigger + `start.inputVariables`; exercises sync happy path, async immediate return, sync timeout + cancel, parallel independence.

**Files Touched**:

- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (new).
- `apps/runtime/src/services/workflow/__tests__/workflow-tool-executor.unit.test.ts` (new).
- `apps/runtime/src/__tests__/integration/workflow/workflow-tool-executor.integration.test.ts` (new).

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 TS errors.
- [ ] `pnpm test --filter=@abl/runtime -- workflow-tool-executor.unit` passes (≥ 12 sub-cases across UT-4, UT-6).
- [ ] `pnpm test --filter=@abl/runtime -- workflow-tool-executor.integration` passes INT-1, INT-2, INT-3, INT-7 — **no `vi.mock` of `@agent-platform/*` or `@abl/*`** (verified by `e2e-test-quality-lint.sh` hook).
- [ ] INT-2 (async) asserts a follow-up `GET` eventually observes `status:'completed'`.
- [ ] INT-3 (timeout) asserts the cancel POST fires and the final thrown error message contains `"timed out after"`.
- [ ] Executor file ≤ 400 LOC (matches SearchAI executor size envelope).

**Test Strategy**:

- Unit: normalizer, exp-backoff schedule, paramMapping resolver — pure-function style.
- Integration: real workflow-engine Express app on `port: 0`; DI fakes for `WorkflowExecutionModel` and Restate service client (both accepted via constructor injection in the engine app factory).
- **No platform mocks.** No direct DB access in integration tests; seeding goes through the engine's create-workflow route.

**Rollback**: Delete the new files + tests; revert. No persistent state changes.

**Covers**: FR-4 (param schema derivation — feeds from tests in P5), FR-5 (sync poll/timeout/cancel), FR-6 (async return), error model + normalizer. Test spec: UT-4, UT-6, INT-1, INT-2, INT-3, INT-7.

---

### Phase 4: Project-Tool Validator & IR Loader

**Goal**: Enforce webhook-only rejection at tool-create time (server-side) and attach derived `parameters` to the IR tool at agent-session-start time.

**Tasks**:
4.1. **Split structural vs DB validation** — the existing `project-tool-validator.ts` functions are synchronous and must stay that way (they run inside IR load, form preview, and tool-form parsing paths that can't await).

- **Sync structural arm** in `project-tool-validator.ts:318-331,574-587`: add `case 'workflow':` that runs only the shape checks — `buildWorkflowBindingFromProps` non-empty-string asserts on `workflowId`, `triggerId`, enum check on `mode`, numeric bounds on `timeoutMs`. Returns `{ valid, binding }` or structured `INVALID_TOOL_BINDING` error.
- **Async DB-cross-check** — create new `packages/shared/src/tools/validate-workflow-tool-binding.ts` exporting `async validateWorkflowToolBinding(binding, ctx: { tenantId, projectId, workflowsRepo })` that verifies (a) `workflowsRepo.findOne({_id: workflowId, tenantId, projectId})` returns a doc, (b) `status === 'active'`, (c) `workflow.triggers[]` has an entry with `id === triggerId`, (d) that trigger's `type === 'webhook'`, (e) if the webhook trigger has `auth.type === 'user_level'` → reject with `INVALID_TOOL_BINDING` (open question #2). Returns `{ valid, error?: { code: 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_INACTIVE' | 'INVALID_TOOL_BINDING', message } }`.
- **Wire into route handler** — `apps/studio/src/app/api/projects/[id]/tools/route.ts` (Next.js dynamic segment in this repo is `[id]`, not `[projectId]`; verify at start of Phase 4 via `ls apps/studio/src/app/api/projects`) awaits `validateWorkflowToolBinding` after the sync validator passes, before persisting. On failure, return the structured error with HTTP 400 (INVALID/INACTIVE) or 404 (WORKFLOW_NOT_FOUND — cross-scope returns 404 per CLAUDE.md invariant 1). Identify sibling call sites via `rg "project-tool-validator" apps/studio/src/app/api apps/runtime/src`.
  4.2. In `apps/runtime/src/tools/load-project-tools-as-ir.ts:117,142-150`:
- Extend `tool_type` cast to include `'workflow'`.
- Add `case 'workflow':` that (a) calls `buildWorkflowBindingFromProps`, (b) loads the workflow document by `{_id, tenantId, projectId}`, (c) extracts `start.inputVariables` and converts them into a JSON Schema `{ type:'object', properties, required }` following the mapping: `string→{type:'string'}`, `number→{type:'number'}`, `boolean→{type:'boolean'}`, `json→{}` (no schema); propagate `description` + `required`.
- Attach the derived schema to `ToolDefinition.parameters`.
- Attach `workflow_binding` with `{ workflowId, triggerId, mode (from trigger node if not overridden), paramMapping, timeoutMs }`.
  4.3. Write INT-4 in `packages/shared/src/__tests__/project-tool-validator.workflow.test.ts`: 4 cases — webhook accepted, non-existent trigger rejected, cron trigger rejected, cross-project 404 (workflow in different `projectId`).
  4.4. Write INT-5 in `apps/runtime/src/tools/__tests__/load-project-tools-as-ir.workflow.test.ts`: DB seed with a workflow having `inputVariables:[{name:'topic',type:'string',required:true,description:'Topic'}]`; assert the derived IR tool has `parameters: { type:'object', properties:{topic:{type:'string',description:'Topic'}}, required:['topic'] }`.

**Files Touched**:

- `packages/shared/src/tools/project-tool-validator.ts` (sync structural arm).
- `packages/shared/src/tools/validate-workflow-tool-binding.ts` (new — async DB cross-check).
- Tool-create route handler (identified during Phase 4) — await the async validator, map errors to HTTP.
- `packages/shared/src/__tests__/project-tool-validator.workflow.test.ts` (new — covers both sync + async arms; INT-4).
- `apps/runtime/src/tools/load-project-tools-as-ir.ts`.
- `apps/runtime/src/tools/__tests__/load-project-tools-as-ir.workflow.test.ts` (new).

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/shared --filter=@abl/runtime` succeeds with 0 TS errors.
- [ ] `pnpm test --filter=@agent-platform/shared -- project-tool-validator.workflow` passes all 4 INT-4 cases.
- [ ] `pnpm test --filter=@abl/runtime -- load-project-tools-as-ir.workflow` passes INT-5.
- [ ] Cross-project test asserts **404** (not 403) per CLAUDE.md invariant 1.
- [ ] Validator integration tests use real MongoDB (`MONGO_URI` env var) — no Mongoose mock.

**Test Strategy**:

- Integration against real MongoDB. DI fakes not used here because the models themselves are the boundary we are verifying.
- No platform mocks.

**Rollback**: `git revert`. Feature becomes silently rejected at create-time (validator returns "unknown tool type") — consistent with pre-feature behavior.

**Covers**: FR-2, FR-3, FR-4. Test spec: INT-4, INT-5.

---

### Phase 5: Runtime Wiring + Engine-Side Isolation + Agent E2E

**Goal**: Connect the executor into `LLMWiringService` for real agent sessions, verify engine-side tenant/project isolation, and land all seven E2E scenarios.

**Tasks**:
5.1. In `apps/runtime/src/services/execution/llm-wiring.ts` right after the SearchAI block (~line 994):

- Declare `let workflowToolExecutor: WorkflowToolExecutor | undefined;`
- Filter `const workflowTools = allTools.filter(t => t.tool_type === 'workflow')`.
- **Guard**: `if (workflowTools.length > 0 && resolvedTenantId && resolvedProjectId)` — both IDs are required to build the engine URL `/api/projects/:projectId/...` and to mint a tenant-scoped JWT. If either is missing, log a `warn` ("workflow tools present but tenant/project context missing — skipping executor wiring") and fall through; `ToolBindingExecutor` will throw a clear dispatcher error if a workflow tool is invoked without an executor registered.
- Inside the guard: mint internal JWT using the **same helper** as the SearchAI block (line 930-952) — `{ tenantId: resolvedTenantId, internal:true }`, 1h TTL, signed with `JWT_SECRET`.
- `workflowToolExecutor = new WorkflowToolExecutor({ workflowEngineUrl: process.env.WORKFLOW_ENGINE_URL ?? '', authToken: internalToken, projectId: resolvedProjectId, tenantId: resolvedTenantId, sessionId, agentName, defaultTimeoutMs: 60_000 })` — passing `sessionId` + `agentName` at construction (not per call), so the 3-arg `execute` signature remains compatible with the existing dispatcher.
- For each workflow tool: `workflowToolExecutor.registerBinding(tool.name, tool.workflow_binding!, { name: tool.name, description: tool.description, inputVariables: <from IR parameters>, triggerMode: tool.workflow_binding!.mode })`.
- Pass the executor to `ToolBindingExecutor` (already accepted at line 92, 226) via the existing constructor argument list — add `workflowToolExecutor`.
  5.2. Update telemetry log at `llm-wiring.ts:~1301` to include `workflowTools: workflowTools.length`, matching the existing naming convention (`httpTools`, `sandboxTools`, `mcpTools` — no `Count` suffix). Verify at implementation time by reading `llm-wiring.ts:1298-1305` — if the log already emits `searchaiTools` / `connectorTools`, include `workflowTools` alongside; otherwise add just `workflowTools` without back-filling missing counts (that's out of scope).
  5.3. Write UT-5 in `llm-wiring-telemetry.test.ts`: assert `workflowTools` appears in the emitted log line with correct count.
  5.4. Write INT-6 in `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts`: two tenants + two projects; create execution under `(tenantA, projA)`; GET under `(tenantB, projA)` returns 404; GET under `(tenantA, projB)` returns 404; audit the error body shape matches the engine's real format (flat string).
  5.5. Write E2E-1, E2E-2, E2E-3, E2E-6 in `workflow-tool-agent.e2e.test.ts`: real runtime server + engine server on random ports, full middleware chain, DI fake for LLM provider only (via existing test-LLM pattern). Agent reasoning loop issues tool_call → assertion against HTTP GET of execution + final agent response. E2E-6 issues multi-turn agent conversation; asserts history forwarding via `GET .../executions?sessionId=` + cross-tenant 404.
  5.6. Write E2E-4, E2E-5 in `workflow-tool-validation.e2e.test.ts`: attempt to create a workflow tool bound to a cron trigger → 400 `INVALID_TOOL_BINDING`; attempt cross-project binding → 404. E2E-5 uses the API-only stale-binding flow (create tool, archive workflow via PATCH, attempt execute → 404 surfaced as `ToolExecutionError`).
  5.7. Write E2E-7 in `workflow-tool-auth.e2e.test.ts`: no-auth POST → 401; viewer-role POST → 403; expired user JWT → 401; verify internal JWT rejects external forgery (signs with wrong key, engine rejects).

**Files Touched**:

- `apps/runtime/src/services/execution/llm-wiring.ts` — the ~50-LOC wiring block + telemetry line.
- `apps/runtime/src/__tests__/llm-wiring-telemetry.test.ts` — UT-5.
- `apps/workflow-engine/src/__tests__/executions-isolation.integration.test.ts` — INT-6 (new).
- `apps/runtime/src/__tests__/workflow-tool-agent.e2e.test.ts` — E2E-1/2/3/6 (new).
- `apps/runtime/src/__tests__/workflow-tool-validation.e2e.test.ts` — E2E-4/5 (new).
- `apps/runtime/src/__tests__/workflow-tool-auth.e2e.test.ts` — E2E-7 (new).

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/runtime --filter=@abl/workflow-engine` succeeds with 0 TS errors.
- [ ] The wiring block is ≤ 60 LOC and stays additive (no edits inside the SearchAI block or shared session init).
- [ ] `pnpm test --filter=@abl/runtime -- workflow-tool-agent.e2e` passes E2E-1/2/3/6.
- [ ] `pnpm test --filter=@abl/runtime -- workflow-tool-validation.e2e` passes E2E-4/5.
- [ ] `pnpm test --filter=@abl/runtime -- workflow-tool-auth.e2e` passes E2E-7 (all four auth sub-cases).
- [ ] `pnpm test --filter=@abl/workflow-engine -- executions-isolation.integration` passes INT-6.
- [ ] `e2e-test-quality-lint.sh` passes on every new E2E file (no `vi.mock`, no direct DB access, no TODO stubs).
- [ ] Full session trace contains all 6 `tool.workflow.execute.*` events for a sync happy-path E2E run.

**Test Strategy**:

- E2E uses real Express servers on random ports, full middleware chain, real JWT secret.
- Integration (INT-6) uses real MongoDB.
- Only the LLM provider is DI-faked via the existing test-LLM pattern (returns scripted tool_calls).

**Rollback**: Remove the wiring block from `llm-wiring.ts` (revert commit) — workflow tools persist in DB but are silently ignored by `ToolBindingExecutor` (dispatcher throws `case 'workflow'` unhandled). Agents continue to work with other tools.

**Covers**: FR-1, FR-4, FR-5, FR-6, FR-7, FR-10. Test spec: UT-5, INT-6, E2E-1, E2E-2, E2E-3, E2E-4, E2E-5, E2E-6, E2E-7.

---

### Phase 6: Studio UI

**Goal**: Let users create, configure, edit, and test workflow tools in Studio, including the empty-state for workflows with no webhook triggers.

**Tasks**:
6.1. Extend `ToolType` union in `apps/studio/src/store/tool-store.ts:14`. Also add:

- `workflowCount: number` to the store state interface (~line 101-104).
- `workflowCount` update in the count reducer (~line 126-132).
- `workflowCount: 0` in the initial state (~line 144-147).
  Without these, the `ToolsListPage` tab badge (line 123-131) reads `undefined` for the workflow tab count.
  6.2. Map `workflow_binding` ↔ `workflowBinding` in `agent-detail-store.ts:70,399-403`.
  6.3. Add Workflow to `TOOL_TYPE_OPTIONS` in `ToolCreateDialog.tsx:45-54` as `{ value: 'workflow', label: t('type_workflow'), description: t('type_workflow_description') }` (the existing dialog uses `useTranslations('tools.create_dialog')` — verified at line 39).
  6.4. Build the workflow form in `ToolConfigurationSection.tsx:67-80`. This component currently has **no** `useTranslations` hook — introduce `const t = useTranslations('tools.config.workflow')` at the top of the workflow-specific sub-component (co-locate, don't lift into the parent; parent handles non-workflow tool types). All labels below use this namespace:
- Searchable workflow picker → `GET /api/projects/:projectId/workflows?status=active`.
- Trigger picker filtered to `type === 'webhook'`. If selected workflow has zero webhook triggers → empty-state message per FR-9: "This workflow has no webhook triggers. Only webhook-triggered workflows can be exposed as tools."
- Mode selector pre-filled from the chosen trigger node's `mode`; user-overridable.
- Readonly preview of `inputVariables` (they become the tool's params).
- `timeoutMs` input, enabled only when `mode === 'sync'`.
  6.5. Add read-only "Workflow Binding" panel to `ToolDetailPage.tsx:106,184,186,737-788`.
  6.6. Add Workflow tab in `ToolsListPage.tsx`:
- Extend the `ToolTab` literal union at line 42 to include `'workflow'`.
- Add `'workflow'` to the URL-param whitelist `.includes(...)` array at line 117 so deep-linking via `?tab=workflow` resolves (without this, the param falls back to default).
- Add the tab button render at line 127 using `t('list.tab_workflow')`.
  6.7. Color/icon/label for workflow in `ToolTypeBadge.tsx` — the `Record<ToolType, ...>` maps sit at lines 13 (colors), 20 (icons), 27 (labels). Verify fresh at implementation time.
  6.8. DSL emit block in `abl-serializers.ts:105-111` matching the canonical format.
  6.9. `case 'workflow':` in `tool-test-service.ts:158-173` calling the engine execute endpoint with test payload.
  6.10. **Add i18n keys** to `packages/i18n/locales/en/studio.json` (and sibling locale files) under the **existing Studio namespaces actually consumed** by the tool pages (`tools.type_badge.*`, `tools.create_dialog.*`, `tools.list.*`, `tools.config.*`, `tools.detail.*` — verify each consumer file's `useTranslations('tools.xxx')` call at the start of Phase 6 before keying). Required keys:
- `tools.type_badge.workflow` — "Workflow" (used by `ToolTypeBadge.tsx`)
- `tools.create_dialog.type_workflow` — create-dialog row label
- `tools.create_dialog.type_workflow_description` — short descriptor for the row
- `tools.list.tab_workflow` — list-page tab label (used by `ToolsListPage.tsx`)
- `tools.config.workflow.pickWorkflow` / `pickTrigger` / `mode` / `timeout` / `paramsPreview` — form field labels
- `tools.config.workflow.noWebhookTriggers` — FR-9 empty-state copy
- `tools.config.workflow.timeoutHint` — sync-only hint
- `tools.detail.workflow.bindingTitle` + 4 field labels (workflowId, triggerId, mode, timeoutMs)
- aria-labels for pickers (screen-reader support). Sync the corresponding keys into every non-English locale file with TODO-marked placeholders (per i18n-guide). Run `pnpm i18n:check` as an exit criterion.
  6.11. Manual smoke test: Studio `pnpm dev` → create a workflow tool → attach to an agent → run in playground → observe the workflow execution in `workflow_executions` + the agent receives the output.

**Files Touched**:

- All Studio files listed in §2 under "Modified Files" (9 Studio files).

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` succeeds with 0 TS errors.
- [ ] `pnpm lint --filter=@abl/studio` passes.
- [ ] All new i18n keys added (6.10) and `pnpm i18n:check` passes.
- [ ] Manual smoke test (6.11) succeeds end-to-end.
- [ ] Empty-state for non-webhook-only workflows renders the FR-9 copy.
- [ ] No design-token violations (tailwind palette hooks pass).
- [ ] Screenshots attached to the PR for: create dialog with workflow option, configuration section with trigger picker, empty-state, binding panel on detail page, list-page workflow tab.

**Test Strategy**:

- Existing Studio lint + build hooks.
- Manual smoke test (no automated Studio E2E for this phase — consistent with SearchAI's rollout).

**Rollback**: Revert; users with persisted workflow tools will see an "unknown tool type" fallback rendering but tools remain callable via agent runtime (no data loss).

**Covers**: FR-8, FR-9. Test spec: Manual (FR-8, FR-9 rows in coverage matrix).

---

## 4. Wiring Checklist

- [ ] `WorkflowToolExecutor` instantiated inside `LLMWiringService` session-start block (Phase 5, task 5.1)
- [ ] Executor passed into `ToolBindingExecutor` constructor argument list so the existing `case 'workflow':` dispatch can invoke it
- [ ] `buildWorkflowBindingFromProps` exported from `packages/shared/src/tools/index.ts` (Phase 2, task 2.4)
- [ ] `'workflow'` added to `VALID_TOOL_TYPES` Set (Phase 1), `PROJECT_TOOL_TYPES` array (Phase 2), `ToolType` unions in shared + Studio (Phase 2 + 6)
- [ ] `workflow_binding` populated on the IR `ToolDefinition` by `load-project-tools-as-ir.ts` (Phase 4, task 4.2)
- [ ] `tool.parameters` JSON Schema derived from `start.inputVariables` and attached (Phase 4, task 4.2)
- [ ] Telemetry log includes `workflowTools` (Phase 5, task 5.2)
- [ ] Trace events registered via shared `traceStore` (Phase 3, task 3.6)
- [ ] Workflow option added to Studio `ToolCreateDialog` and `ToolsListPage` tabs (Phase 6)
- [ ] `ToolTypeBadge` renders workflow color/icon/label (Phase 6)
- [ ] Workflow binding panel visible on `ToolDetailPage` (Phase 6)
- [ ] DSL emitter covers workflow in both shared (`serialize-tool-form-to-dsl.ts`) and Studio (`abl-serializers.ts`)
- [ ] `tool-test-service.ts` has a workflow branch so the Studio "Test" button works
- [ ] No new API routes to register (API design confirms zero new endpoints)
- [ ] No new worker to start (runtime is request-path only)
- [ ] No new models to export from `packages/database/src/models/index.ts` (using existing `project-tool.model.ts`)

---

## 5. Cross-Phase Concerns

### Database Migrations

**None.** The only DB change is adding `'workflow'` to the `PROJECT_TOOL_TYPES` Mongoose enum at `packages/database/src/models/project-tool.model.ts:18`. Mongoose's enum is write-time validation only; existing documents are not re-validated on read. No migration script, no backfill, no shadow mode. Confirmed in HLD Concern #10.

### Feature Flags

**None.** Per D-9, the feature is fully opt-in at the Studio create-tool step and the dispatcher branch is isolated. Kill-switch is hot-archive of all `toolType:'workflow'` docs or revert.

### Configuration Changes

- **Required env var**: `WORKFLOW_ENGINE_URL` — already present in the runtime environment for other engine consumers (agentic-app workflow-node invocations). No new env var. If unset, the executor throws at first call with `"workflow engine unreachable"`, which the agent loop surfaces as `ToolExecutionError` — other tool types are unaffected.
- **Required secret**: `JWT_SECRET` — shared HMAC secret already used by the SearchAI internal JWT block. No rotation needed.
- **No new ports, no new services, no Docker changes.**

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with their listed exit criteria met.
- [ ] All 7 E2E scenarios from `docs/testing/workflow-as-tool.md` passing (E2E-1 through E2E-7).
- [ ] All 7 integration scenarios passing (INT-1 through INT-7).
- [ ] All 6 unit scenarios passing (UT-1 through UT-6).
- [ ] `pnpm build && pnpm test` green across the full monorepo (no regressions in pre-existing tests).
- [ ] `e2e-test-quality-lint.sh` passes on every E2E test file (no `vi.mock`, no direct DB access, no TODO stubs).
- [ ] `commit-scope-guard.sh` passes on every commit (≤ 40 files, ≤ 3 packages per commit).
- [ ] `deletion-ratio-guard.sh` passes on every `feat()` commit (≤ 30% deletions).
- [ ] `platform-mock-lint.sh` passes on every test commit (no `@abl/*` / `@agent-platform/*` mocks).
- [ ] Manual Studio smoke test documented in Phase 6, task 6.10 has been executed against a real workflow and recorded in the PR.
- [ ] `docs/features/workflow-as-tool.md` updated to `Status: ALPHA` and "Implementation Notes" section filled in.
- [ ] `docs/testing/workflow-as-tool.md` coverage matrix updated to show actual pass/fail status per FR.
- [ ] `docs/specs/workflow-as-tool.hld.md` status updated to `IMPLEMENTED`.
- [ ] `pr-reviewer` agent clears 5 rounds of implementation review without CRITICAL findings.
- [ ] All new trace events appear in a sampled sync-happy-path E2E run (6 events: `start`, `poll`, `complete`, and the non-error variants).
- [ ] Feature status promoted to **ALPHA** per `docs/sdlc/pipeline.md` lifecycle criteria.

---

## 7. Open Questions

1. **`paramMapping` helper** — does `packages/shared` expose an existing JSONPath evaluator we can reuse, or do we add a minimal `$.a.b.c` resolver inline in the executor? Resolve in Phase 3 by `rg "jsonpath|JSONPath" packages/shared/src` before implementing. Default plan: inline minimal resolver if none exists; track as tech debt in `docs/sdlc-logs/workflow-as-tool/lld.log.md`.
2. **`auth.type: 'user_level'` webhook triggers** — v1 default per HLD is to block at validator time and surface `INVALID_TOOL_BINDING`. Confirm during Phase 4 that the validator `validateWorkflowTool` includes this check; add a dedicated INT-4 sub-case if user-level auth webhook triggers exist in test fixtures.
3. **Companion "wait-for-workflow-execution" tool for async mode** — deferred per feature spec §2 Non-Goals. Track in feature spec gaps table during post-impl-sync.

---

## 8. Post-Implementation Notes

Captured 2026-04-15 (commit `76d206c6c5`):

- **§2 change map — Studio path correction**: `apps/studio/src/components/tools/sections/ToolConfigurationSection.tsx` was NOT the shipped path. The workflow tool picker lives at `apps/studio/src/components/tools/WorkflowConfigForm.tsx`. Replaced the original single workflow+trigger picker with three sequential dropdowns (workflow → active version → webhook trigger) to match the version-first workflow UX.
- **§2 change map — Shared validator file added**: `packages/shared/src/tools/validate-workflow-tool-binding.ts` (new) now validates bindings against `TriggerRegistrationsRepo` (canonical source) rather than the denormalized `workflow.triggers[]` the LLD assumed. FR-2/FR-3 behavior unchanged from the agent's perspective.
- **Studio FR-8 delta**: Version dropdown filters to `state === 'active' || version === 'draft'` — drafts are spec-guaranteed active under the version-first model. Default selection prefers the first non-draft active version, falling back to draft if no published versions exist.
- **`ToolCreateDialog` parameter forwarding**: Creates now forward the derived `parameters` array to the backend so tool detail and runtime load observe the same params without an extra refresh.
- **Tool name UI regex**: Added client-side enforcement of `TOOL_NAME_REGEX` so invalid names are caught before the backend round-trip.

All LLD phase exit criteria remain satisfied; no acceptance criteria were weakened.

---

## 9. References

- Feature spec: `docs/features/workflow-as-tool.md`
- HLD: `docs/specs/workflow-as-tool.hld.md`
- Test spec: `docs/testing/workflow-as-tool.md`
- Plan history: `~/.claude/plans/smooth-roaming-wozniak.md`
- Sibling executor: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
- Engine routes: `apps/workflow-engine/src/routes/workflow-executions.ts`
- Wiring template: `apps/runtime/src/services/execution/llm-wiring.ts:917-994`
