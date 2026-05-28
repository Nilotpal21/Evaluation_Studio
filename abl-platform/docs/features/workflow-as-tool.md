# Feature: Workflow-as-Tool

**Doc Type**: SUB-FEATURE
**Parent Feature**: agent-anatomy.md (Tools)
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `integrations`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/compiler`, `packages/shared`, `packages/database`
**Owner(s)**: Platform / Agent Runtime
**Testing Guide**: `../testing/workflow-as-tool.md`
**Last Updated**: 2026-05-11

---

## 1. Introduction / Overview

### Problem Statement

Agents in ABL Platform can call HTTP endpoints, sandbox functions, MCP servers, and SearchAI knowledge bases — but they cannot invoke a user-defined **Workflow**, even though Workflows are already a first-class artifact (project-scoped, typed inputs/outputs, Restate-backed engine, versioned). Today, if a builder wants an agent to run a multi-step orchestration (approval flow, data enrichment, side-effecting integration), they must rebuild that logic as raw HTTP tools or duplicate it in the agent's reasoning loop. This causes drift between agents and workflows that should share the same business logic.

### Goal Statement

Let an agent invoke an existing Workflow by registering it as a tool, with the workflow's `start` node `inputVariables` automatically surfaced as the LLM-facing parameter schema. The execution path goes through the existing workflow-engine API (no engine changes). Sync mode blocks until the workflow finishes and returns its `output`; async mode returns an `executionId` immediately.

### Summary

A new tool type `'workflow'` is added alongside `http | sandbox | mcp | searchai`. A user creates a Tool in Studio, picks a workflow from the same project plus one of its **webhook** triggers, and the runtime exposes it to the LLM. When the agent calls the tool, the runtime POSTs to the workflow-engine's existing executions endpoint and (for sync) polls until terminal. The `WorkflowToolExecutor` mirrors the structure of `SearchAIKBToolExecutor` — same `ToolExecutor` interface, same wiring point in `LLMWiringService`, same internal-JWT pattern for cross-service auth.

---

## 2. Scope

### Goals

- Add `tool_type: 'workflow'` end-to-end: IR → DSL → DB → runtime executor → Studio UI.
- Sync execution: poll until terminal, return `{ status, output, executionId }`, honor `timeoutMs`.
- Async execution: return `{ executionId, status: 'running' }` immediately; no auto-polling.
- Param schema derived from the workflow's `start.inputVariables` (typed: `string | number | boolean | json`, with `required` and `description`).
- Same-project, same-tenant only.
- Studio: workflow + webhook-trigger picker, mode selector pre-filled from the trigger node's mode, readonly preview of `inputVariables`, timeout config (sync only).
- Validation rejects workflows with no webhook triggers, and rejects binding to non-webhook triggers.

### Non-Goals (Out of Scope)

- **Cron / schedule and appevent / event triggers** — explicitly NOT registerable as tools (different invocation semantics; cron has no caller and event triggers are platform-emitted).
- A companion "wait-for-workflow-execution" tool to pair with `mode: 'async'` (deferred).
- Cross-project workflow invocation.
- Streaming intermediate workflow node events into the agent trace panel.
- Auto-generating tool descriptions from the workflow node graph (v1 uses workflow `description` + `inputVariables`).
- Tool-level auth profiles for workflow tools (workflow tools inherit the agent's auth context via internal JWT).

---

## 3. User Stories

1. As an **agent builder**, I want to expose an existing approval workflow as a tool so my agent can request approvals without me re-implementing the multi-step logic in HTTP tools.
2. As an **agent builder**, I want the LLM to see the workflow's typed inputs so it knows exactly what arguments to pass — without me writing a JSON Schema by hand.
3. As an **agent builder**, I want the choice of sync (wait for the answer) vs async (fire-and-forget with executionId) per tool, so long-running workflows don't block the agent turn.
4. As an **agent operator**, I want workflow tools to be project-scoped so an agent in Project A can never invoke a workflow in Project B.
5. As an **agent builder**, when I pick a workflow that has only cron / appevent triggers, I want a clear error explaining why it can't be exposed as a tool.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept `tool_type: 'workflow'` as a valid Tool type wherever existing tool types are accepted (DB enum, IR validator, DSL parser, Studio create dialog).
2. **FR-2**: The system must require `workflow_binding.workflowId` and `workflow_binding.triggerId` to be non-empty strings, and must reject any binding whose referenced workflow does not exist in the same `tenantId` + `projectId` as the Tool.
3. **FR-3**: The system must reject any binding whose `triggerId` does not exist on the workflow's `triggers[]` array, or whose trigger `type !== 'webhook'`.
4. **FR-4**: The system must derive the LLM-facing tool parameter schema from the workflow's `start` node `inputVariables`, mapping each entry to a JSON-Schema property with `type`, `description`, and `required` propagated.
5. **FR-5**: For `mode === 'sync'`, the runtime must POST to the workflow-engine executions endpoint, then poll the execution by ID with exponential backoff until the status is terminal (`completed`, `failed`, `cancelled`, `rejected`) or the configured `timeoutMs` (default 60000ms) elapses. On timeout, the runtime must POST a cancel request and surface a `ToolExecutionError`.
6. **FR-6**: For `mode === 'async'`, the runtime must POST to the workflow-engine executions endpoint and return `{ executionId, status: 'running' }` immediately without polling.
7. **FR-7**: The runtime must mint an internal service JWT (tenant-scoped, 1-hour expiry) for Runtime → Workflow-Engine calls, mirroring the SearchAI pattern in `apps/runtime/src/services/execution/llm-wiring.ts:930-952`.
8. **FR-8**: Studio must present three sequential pickers: (a) a workflow picker scoped to the current project, (b) a version picker filtered to active versions of the chosen workflow — draft versions are always treated as active per the version-first model, and (c) a trigger picker filtered to `type === 'webhook'` and scoped to the selected version (triggers pinned via `workflowVersionId` are version-filtered; unpinned triggers apply to all versions). The mode selector must default to the chosen trigger's `mode` and remain user-overridable.
9. **FR-9**: Studio must show an empty-state message when a chosen workflow has zero webhook triggers, explaining that only webhook-triggered workflows are exposable as tools.
10. **FR-10**: The runtime must emit telemetry counts of `tool_type === 'workflow'` registrations alongside other tool-type counts.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                   |
| -------------------------- | ------------ | ----------------------------------------------------------------------- |
| Project lifecycle          | NONE         |                                                                         |
| Agent lifecycle            | PRIMARY      | New tool type expands the agent's tool surface area.                    |
| Customer experience        | NONE         |                                                                         |
| Integrations / channels    | SECONDARY    | Workflows often wrap external integrations.                             |
| Observability / tracing    | SECONDARY    | Tool calls emit standard `TraceEvent`s; workflow trace lives in engine. |
| Governance / controls      | SECONDARY    | Project-scope isolation enforced; webhook-only restriction.             |
| Enterprise / compliance    | NONE         |                                                                         |
| Admin / operator workflows | NONE         |                                                                         |

### Related Feature Integration Matrix

| Related Feature     | Relationship                                                          |
| ------------------- | --------------------------------------------------------------------- |
| Agent Tools (Hub)   | New `tool_type` value alongside `http \| sandbox \| mcp \| searchai`. |
| Workflows           | Consumes existing webhook triggers; no engine changes.                |
| SearchAI KB-as-Tool | Structural template for executor + wiring.                            |
| Auth Profiles       | Not used; workflow tools inherit agent auth context via internal JWT. |
| Tool Confirmation   | Compatible — `confirmation.require: 'always'` works unchanged.        |

---

## 6. Architecture / Design Sketch

```
Studio Tool form
   │ (user picks workflow + webhook trigger + mode + timeout)
   ▼
DB: project_tools { toolType: 'workflow', dslContent: "type: workflow / workflow_id / trigger_id / mode / timeout_ms" }
   │
   ▼
load-project-tools-as-ir.ts ──► ToolDefinition { tool_type: 'workflow', workflow_binding: { workflowId, triggerId, mode, timeoutMs }, parameters: <from start.inputVariables> }
   │
   ▼
LLMWiringService (filters tool_type === 'workflow') ──► new WorkflowToolExecutor (mints internal JWT, registers bindings)
   │
   ▼
ToolBindingExecutor.execute → switch case 'workflow' → workflowToolExecutor.execute()
   │
   ▼
POST {WORKFLOW_ENGINE_URL}/api/projects/:projectId/workflows/:workflowId/executions/execute
   │ body: { payload, triggerType: 'api', triggerMetadata: { sessionId, agentName, source: 'agent_tool', triggerId } }
   ▼
202 { executionId }
   │
   ├── mode 'async' → return { executionId, status: 'running' }
   └── mode 'sync'  → poll GET .../executions/:executionId (exp backoff 250ms→2s, cap = timeoutMs)
                      → terminal? return { status, output, executionId } / throw on failure
                      → timeout?  POST .../cancel, throw ToolExecutionError
```

Key reused code (no duplication):

- IR + dispatcher already wired: `packages/compiler/src/platform/ir/schema.ts:781,807,881-886` and `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:573-582`.
- Workflow execution endpoints already exist: `apps/workflow-engine/src/routes/workflow-executions.ts:113,169`.
- SearchAI executor template: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`.
- Internal JWT pattern: `apps/runtime/src/services/execution/llm-wiring.ts:930-952`.

---

## 7. Key Files

| Layer      | File                                                                           | Change                                                               |
| ---------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| IR         | `packages/compiler/src/platform/ir/schema.ts:881-886`                          | Add `triggerId` to `WorkflowBindingIR`                               |
| IR         | `packages/compiler/src/platform/ir/tool-schema-validator.ts:34,84-89`          | Add `'workflow'` + validation arm                                    |
| IR         | `packages/compiler/src/platform/ir/compiler.ts:903-921`                        | Default hint inference                                               |
| DSL        | `packages/shared/src/tools/dsl-property-parser.ts:507`                         | New `buildWorkflowBindingFromProps`                                  |
| Validator  | `packages/shared/src/tools/project-tool-validator.ts:318-331,574-587`          | Webhook-trigger enforcement                                          |
| Validator  | `packages/shared/src/tools/validate-workflow-tool-binding.ts` (new)            | Version-first validation against `TriggerRegistrationsRepo`          |
| Adapters   | `packages/shared/src/tools/standalone-tool-adapter.ts:286-298`                 | New branch                                                           |
| Adapters   | `packages/shared/src/tools/resolve-tool-implementations.ts:68,480-497,559-564` | New branch                                                           |
| Serializer | `packages/shared/src/tools/serialize-tool-form-to-dsl.ts:44-53`                | Emit `type: workflow / workflow_id / trigger_id / mode / timeout_ms` |
| DB         | `packages/database/src/models/project-tool.model.ts:18,73`                     | Add to `PROJECT_TOOL_TYPES`                                          |
| DB         | `packages/database/src/tool-extractor.ts:12,90-94`                             | Extend type alias and parse switch                                   |
| Runtime    | `apps/runtime/src/services/workflow/workflow-tool-executor.ts` (new)           | Concrete `ToolExecutor` (sync poll + async return)                   |
| Runtime    | `apps/runtime/src/tools/load-project-tools-as-ir.ts:117,142-150`               | New `case 'workflow':` building binding + params                     |
| Runtime    | `apps/runtime/src/services/execution/llm-wiring.ts:~919-990,1301`              | Wire executor + telemetry                                            |
| Studio     | `apps/studio/src/store/tool-store.ts:14`                                       | Extend `ToolType`                                                    |
| Studio     | `apps/studio/src/store/agent-detail-store.ts:70,399-403`                       | Map `workflow_binding` ↔ `workflowBinding`                           |
| Studio     | `apps/studio/src/components/tools/ToolCreateDialog.tsx:45-54`                  | Add Workflow option                                                  |
| Studio     | `apps/studio/src/components/tools/WorkflowConfigForm.tsx`                      | 3-dropdown picker (workflow → version → trigger), mode, timeout      |
| Studio     | `apps/studio/src/components/tools/ToolDetailPage.tsx:106,184,186,737-788`      | Read-only binding panel                                              |
| Studio     | `apps/studio/src/components/tools/ToolsListPage.tsx:42,117,127`                | Workflow tab                                                         |
| Studio     | `apps/studio/src/components/tools/ToolTypeBadge.tsx:17,24,31`                  | Color/icon/label                                                     |
| Studio     | `apps/studio/src/lib/abl-serializers.ts:105-111`                               | DSL emit                                                             |
| Studio     | `apps/studio/src/services/tool-test-service.ts:158-173`                        | Test runner branch                                                   |
| UI E2E     | `apps/studio/e2e/workflow-tool-config.spec.ts` (new)                           | Playwright: FR-8/FR-9 picker, mode, empty-state (UI-E2E-1, UI-E2E-2) |
| UI E2E     | `apps/studio/e2e/workflow-tool-list.spec.ts` (new)                             | Playwright: workflow tab, badge, binding panel (UI-E2E-3, UI-E2E-4)  |
| UI E2E     | `apps/studio/e2e/helpers/workflow-seed.ts` (new)                               | Seed helpers for UI E2E workflow fixtures                            |
| UI Testids | `apps/studio/src/components/ui/Select.tsx`                                     | Extended with optional `testid` prop                                 |
| UI Testids | `apps/studio/src/components/ui/Tabs.tsx`                                       | Extended with optional `testid` prop                                 |
| UI Testids | `apps/studio/src/components/ui/Badge.tsx`                                      | Extended with optional `testid` prop                                 |

---

## 8. Open Questions

- Should the executor enrich `paramMapping` from form input names → workflow input variable names automatically when names match (1-to-1 pass-through)? Likely yes for ergonomics; explicit mapping only when names differ.
- Should `mode: 'async'` returns include the engine's `pollUrl` so the agent's own tool description can hint at "call X to check status" — or wait until the companion polling tool ships?
- For workflows with `auth.type === 'user_level'` on the webhook trigger, do we propagate the agent's `userId` claim or block exposure entirely in v1? Default: block in v1, surface a validator error.

---

## 9. Post-Implementation Notes

Deviations and refinements captured during implementation (commit `76d206c6c5`):

- **Version-first alignment** — Workflow container `status` is vestigial under the version-first model. Added `packages/shared/src/tools/validate-workflow-tool-binding.ts` which validates bindings against `TriggerRegistrationsRepo` (canonical trigger source) rather than the denormalized `workflow.triggers[]`. This honors `WorkflowVersion.state` and `TriggerRegistration.status` as the activation signals.
- **Studio picker split into three dropdowns** — The original single workflow+trigger picker in `sections/ToolConfigurationSection.tsx` was replaced by `WorkflowConfigForm.tsx` exposing (workflow → version → trigger) sequentially. Version dropdown filters to `state === 'active'` OR literal `version === 'draft'` (drafts are spec-guaranteed active). Default selection prefers the first non-draft active version, falling back to draft.
- **Parameters forwarded on create** — `ToolCreateDialog.tsx` now forwards `parameters` derived from the selected version's `start.inputVariables` so the stored tool exposes the same params the workflow expects; without this the tool detail page and LLM could not invoke the tool correctly.
- **Name regex UI validation** — Tool name field now enforces `TOOL_NAME_REGEX` (`/^[a-z][a-z0-9_]{0,62}[a-z0-9]$/`) at the UI layer so invalid names are caught before the backend round-trip.
- **Trigger version pinning respected** — Webhook triggers with a `workflowVersionId` are shown only when the matching version is selected; unpinned triggers remain available across all versions.

---

## 10. Post-Implementation Notes (HTTP Async Completion)

Sub-feature added in 2026-05-11 (commits `cb0d3fbfc2`, `0b325cfcc1`, `3819788007`, `51e3a171ce`): HTTP tools invoked from workflow `tool_call` nodes can now execute asynchronously.

Key points:

- **Two modes for HTTP tools**: `sync` (unchanged behavior) and `async_wait` (suspend workflow, inject callback, resume on callback).
- **`async_continue` not supported for HTTP**: Removed from HTTP path during implementation — semantically equivalent to `sync` for HTTP (both return immediately without suspending). Only `workflow`-type tools retain `async_continue`.
- **Callback injection**: When `async_wait`, the workflow engine generates a per-step secret and injects `callbackUrl` + `callbackSecret` into the HTTP request body, query params, or headers (configurable via `callbackConfig.location`).
- **Accepted response classification**: HTTP responses are classified as `accepted` only when status code matches `asyncHttpSuccess.acceptedStatusCodes` (default: [202]) and optional body discriminator matches. All other responses classify as `completed`.
- **Studio UX**: Execution mode dropdown shows technical labels (`sync`, `async_wait`). GET HTTP tools hide the `body` callback location option.

Full design: `docs/specs/workflow-http-tool-async-completion.hld.md`  
Full LLD: `docs/plans/2026-05-10-workflow-http-tool-async-completion-plan.md`  
Test spec: `docs/testing/sub-features/workflow-http-tool-async-completion.md`

---

## 11. References

- Plan: `~/.claude/plans/smooth-roaming-wozniak.md`
- Parent feature: `docs/features/agent-anatomy.md`
- Sibling pattern: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
- Engine API: `apps/workflow-engine/src/routes/workflow-executions.ts`
- HTTP async completion HLD: `docs/specs/workflow-http-tool-async-completion.hld.md`
- Workflow async completion sub-feature: `docs/features/sub-features/workflow-async-completion.md`
