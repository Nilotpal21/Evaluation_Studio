# Feature: Workflow Canvas Context Suggestions

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflow First-Class Memory, Agent Session, and Context](./workflow-first-class-memory-and-context.md)
**Status**: ALPHA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`
**Package(s)**: `apps/studio`
**Owner(s)**: Platform / Studio Team
**Testing Guide**: `../../testing/sub-features/workflow-canvas-context-suggestions.md`
**Last Updated**: 2026-05-12

---

## 1. Introduction / Overview

### Problem Statement

Workflow authors configuring node parameters in the Studio canvas had to manually type `{{expression}}` paths from memory — there was no discoverability of available variables, no browsable list of upstream step outputs, and no indication that memory/agentSession/agentContext were accessible. The only node type that had expression support was `integration` (via `DynamicActionForm`). All other node types — API, TextToText, Condition, Loop, Agent, Tool, Human, DataEntry — accepted plain text inputs with no context-aware assistance. This caused authoring errors (wrong step key format, references to non-existent fields) that only surfaced at execution time.

Additionally, the step-key bug in `IntegrationNodeConfig` generated expressions using the node UUID (`steps.${uuid}.output`) which never resolved at runtime, because the workflow engine keys steps by their canvas label (`ctx.steps[step.name ?? step.id]`).

### Goal Statement

Give every expression-bearing input in the workflow canvas a consistent, discoverable authoring experience: a `{⋮}` button that opens a browsable expression tree and `{{` auto-trigger that pops up inline autocomplete. Ensure the generated expressions are valid at runtime by using the correct step-key contract (canvas label, not UUID). Expose all six expression categories — Trigger, Nodes, Context, Memory, Agent Session, Agent Context — to reflect the full runtime context defined by the workflow engine.

### Summary

This sub-feature adds context-aware expression authoring to all node configuration panels in the workflow canvas. A shared hook (`useWorkflowExpressionContext`) computes available trigger payload fields and upstream step references via BFS backward graph traversal. The `ExpressionInput` component wraps any text or textarea field with a `{⋮}` icon button and `{{` auto-trigger that opens `ContextExplorer` — a searchable, categorized tree of insertable `{{expression}}` paths. The fix also corrects a step-key bug that previously generated unresolvable UUID-based paths.

---

## 2. Scope

### Goals

- Wire `ExpressionInput` + `ContextExplorer` to all expression-bearing fields across all node config panels.
- Create a shared `useWorkflowExpressionContext(nodeId)` hook to eliminate duplicate BFS traversal logic and fix the step-key bug.
- Expose all six `ContextExplorer` categories: Trigger, Nodes, Context, Memory, Agent Session, Agent Context.
- Ensure generated expression paths match the runtime contract: `{{steps.<canvas-label>.output}}`, `{{workflow.id}}`, `{{trigger.payload.<var>}}`, `{{memory.workflow}}`, etc.
- Align context field expressions with `KNOWN_TOP_LEVEL_KEYS` in `expression-resolver.ts`.

### Non-Goals (Out of Scope)

- Per-node output schema inference — previous step schemas are always `undefined`; the explorer shows `{{steps.<label>.output}}` as a single leaf with type `any`.
- Expression support in `FunctionEditorOverlay` (Monaco-based code editor for function nodes uses JavaScript globals, not `{{expression}}` syntax).
- Expression support in dynamic dropdown or multi-select fields (`DynamicDropdownField.tsx`, `DynamicMultiSelectField.tsx`).
- Live Studio debug panels for inspecting runtime memory/agentSession values at design time.
- Conditional rendering of Memory/AgentSession/AgentContext categories based on workflow trigger type.
- Backend or workflow-engine changes — this is purely Studio UI.
- Cross-tenant or cross-project expression resolution.
- `vars` top-level key — `vars` is a runtime key in `KNOWN_TOP_LEVEL_KEYS` but it is set programmatically by function nodes; its contents are not predictable at design time, so it is intentionally excluded from `ContextExplorer`.

---

## 3. User Stories

1. As a **workflow author**, I want to type `{{` in any node config field and see a browsable popup of available expressions, so that I can insert the correct path without memorizing the syntax.
2. As a **workflow author**, I want to browse upstream step outputs in the Nodes category of ContextExplorer, so that I can pipe the output of an Agent node into a Condition node's field without guessing the step name.
3. As a **workflow author**, I want to reference `{{memory.workflow.lastCursor}}` or `{{agentSession.channel}}` in a TextToText prompt, so that I can use persistent state and agent context without writing a function node.
4. As a **workflow author**, I want the `{⋮}` button available on API node URL, headers, and body fields, so that I can inject dynamic values into HTTP calls driven by prior step outputs.
5. As a **workflow author**, I want expressions generated by ContextExplorer to actually resolve at runtime, so that authoring mistakes are eliminated at the source rather than discovered at execution time.

---

## 4. Functional Requirements

1. **FR-1**: Every expression-bearing text/textarea input in node config panels (API URL, header values, body; TextToText system/human prompts; Condition field/value; Loop source; Agent input/sessionId; Tool param values; AgenticApp input; Human subject/message; DataEntry subject/message) must use `ExpressionInput` and provide access to `ContextExplorer`.

2. **FR-2**: `ContextExplorer` must display four user-facing categories — Context (Trigger + Steps), Memory, Agent Session, Agent Context — with correct expression paths matching the `KNOWN_TOP_LEVEL_KEYS` contract in `expression-resolver.ts`. The picker is a **curated** view: telemetry, internal IDs, and engine plumbing fields are hidden even though they resolve at runtime (see § 6 "Field Curation Principle"). The `vars` key is intentionally excluded (see Non-Goals). User-facing paths:
   - `{{context.trigger.type}}`, `{{context.trigger.payload.<var>}}` — trigger metadata is hidden
   - `{{context.steps.<canvas-label>.output}}`, `.status`, `.error.code`, `.error.message` — input/timing/metrics hidden
   - `{{memory.workflow}}`, `{{memory.project}}`, `{{memory.user}}` for memory scopes
   - `{{agentSession.agentName}}`, `.channel`, `.endUserId` — sessionId / source / locale / timestamps hidden
   - `{{agentContext.caller.id}}`, `.invocation.tool`, `.invocation.args`, `.attachments[0].name`, `.mimeType`, `.sizeBytes` — caller.type / messageMetadata / attachments[].id hidden
   - For Agent steps: `{{steps.<label>.output.agentResponse}}`, `.action`, `.sessionEnded` — sessionId / traceEvents / responseMetadata hidden
   - For Human / Data Entry steps: `{{steps.<label>.output.humanTaskResponse.respondedBy}}`, `.decision`, `.fields.<configured-field-name>` — respondedAt / notes hidden, `fields.*` is dynamic per node config

3. **FR-3**: The step key in generated expressions must use the node's canvas label (`n.data.label`), not the node UUID, matching the runtime contract `ctx.steps[step.name ?? step.id]` in `workflow-handler.ts`.

4. **FR-4**: Typing `{{` in an `ExpressionInput` must auto-open `ContextExplorer`. Selecting an expression must insert it at the cursor position; if `{{` was already typed, the two characters must be replaced (not doubled) to produce `{{expression}}` not `{{{{expression}}`.

5. **FR-5**: `ContextExplorer` must support full-text search across all expression paths and labels. Pressing Escape or clicking outside must close the explorer without inserting anything.

6. **FR-6**: The `useWorkflowExpressionContext(nodeId)` hook must compute `triggerPayload` from the Start node's `inputVariables` config and `previousSteps` via BFS backward traversal through the canvas edge graph, excluding the Start node itself from the steps list.

7. **FR-7**: All six categories must always be shown regardless of workflow trigger type, to support discoverability at design time. Categories with no available fields must show "No fields available" rather than being hidden.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                              |
| -------------------------- | ------------ | -------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workflow authoring quality improvement             |
| Agent lifecycle            | SECONDARY    | Enables agent context in downstream workflow nodes |
| Customer experience        | NONE         | Studio-only, no end-user runtime surface           |
| Integrations / channels    | SECONDARY    | Integration node already had partial support       |
| Observability / tracing    | NONE         | No new trace events                                |
| Governance / controls      | NONE         | No new access controls                             |
| Enterprise / compliance    | NONE         | No PII or compliance surface changes               |
| Admin / operator workflows | NONE         | Not admin-facing                                   |

### Related Feature Integration Matrix

| Related Feature                                                                                         | Relationship Type | Why It Matters                                                                                                                                                                                       | Key Touchpoints                                                                                | Current State            |
| ------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------ |
| [Workflow First-Class Memory, Agent Session, and Context](./workflow-first-class-memory-and-context.md) | extends           | This feature surfaces the runtime expression contract in the Studio UI; without the backend objects `memory`, `agentSession`, `agentContext` being real, the categories would resolve to `undefined` | `KNOWN_TOP_LEVEL_KEYS`, `AgentSessionProjection`, `AgentContextProjection`, `MemoryProjection` | STABLE — backend shipped |
| [Workflow Integration Node](./workflow-integration-node.md)                                             | extends           | Integration node was the only node with expression support pre-feature; `DynamicActionForm`+`ExpressionInput` pattern was the reference implementation                                               | `IntegrationNodeConfig.tsx`, `DynamicActionForm.tsx`                                           | STABLE                   |
| [Workflows](../workflows.md)                                                                            | configured by     | Canvas store provides `nodes` and `edges` consumed by the hook                                                                                                                                       | `workflow-canvas-store.ts`                                                                     | STABLE                   |

---

## 6. Design Considerations

### UX Flow

1. User opens a node config panel by clicking a node in the canvas.
2. Any text input that accepts expressions has a `{⋮}` (Braces) icon button at the right edge.
3. User either clicks `{⋮}` OR types `{{` in the field.
4. `ContextExplorer` opens as a floating popover anchored below-right of the input.
5. User sees 6 collapsible categories. Trigger is pre-expanded if it has fields.
6. User browses or searches. Clicking a leaf inserts `{{expression}}` at cursor.
7. Pressing Escape or clicking outside closes without inserting.

### Expression Path Correctness

The most critical correctness invariant: `ContextExplorer` must use `step.id` (which equals the canvas label from `useWorkflowExpressionContext`) in the expression path `steps.${step.id}.output`. The runtime resolves steps by name via `ctx.steps[step.name ?? step.id]`. UUID-based paths will silently fail at runtime.

### Categories Always Visible

Memory, Agent Session, and Agent Context categories are always shown (not conditional on trigger type). This is intentional — at design time the author may not know the trigger type, and showing unavailable categories teaches discoverability. Runtime values resolve to `undefined` for incompatible trigger types, which the expression resolver handles gracefully. Each section header has an info tooltip explaining when its data is populated (e.g. agent-triggered runs only).

### Field Curation Principle

The picker is intentionally **narrower** than the engine's full context object. A field appears in the picker only if a workflow author would reasonably compose it into a `{{...}}` expression. Telemetry, opaque IDs, and internal engine state are **resolvable at runtime** but **hidden from the picker** so users see only what they should care about.

**Hidden fields (still resolve if hand-typed):**

| Namespace                      | Hidden                                                                                                                            | Reason                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `trigger.*`                    | `metadata` (incl. `firedAt`, `userId`)                                                                                            | Internal trigger plumbing           |
| `steps.X.*`                    | `input`, `durationMs`, `startedAt`, `completedAt`, `nodeType`, `stepId`, `metrics`, `consoleLogs`, `mappingErrors`, `controlFlow` | Step-level telemetry                |
| `steps.X.output.*` (any depth) | `traceEvents`, `responseMetadata`, `respondedAt`                                                                                  | Agent / human-task engine internals |
| `agentSession.*`               | `sessionId`, `source`, `startedAt`, `lastActivityAt`, `locale`                                                                    | Opaque IDs and telemetry            |
| `agentContext.*`               | `caller.type`, `messageMetadata`, `attachments[].id`                                                                              | Internal discriminator / opaque     |
| Agent output                   | `sessionId`, `traceEvents`, `responseMetadata.*` (entire subtree)                                                                 | Engine plumbing, not business data  |
| Human output                   | `notes`, `respondedAt`                                                                                                            | Rarely composed; clutter the picker |

**Implementation:** two scoped denylists in `ContextExplorer.tsx`:

- `HIDDEN_STEP_TOP_LEVEL_KEYS` — applied only at the immediate level of `steps.X.<here>`. Telemetry field names are too common to filter recursively (a user's API response might legitimately contain a field called `input` or `startedAt`).
- `HIDDEN_STEP_OUTPUT_INTERNAL_KEYS` — applied at any depth under a step. Reserved for engine-internal names (`traceEvents`, `responseMetadata`, `respondedAt`) specific enough to not collide with user data.

### Dynamic Output Schemas

Where the runtime output shape depends on user configuration, the picker derives the schema from the actual node config instead of showing a generic `object`:

- **Human / Data Entry nodes** — `humanTaskResponse.fields.*` is built from the node's configured `fields` array. If a Data Entry node has fields `[customerName, priority]`, the picker shows `humanTaskResponse.fields.customerName` and `humanTaskResponse.fields.priority` with their declared types. Falls back to generic `fields: object` only when no fields are configured. See `buildHumanOutputSchema` in `useWorkflowExpressionContext.ts`.

---

## 7. Technical Considerations

### Hook Architecture

`useWorkflowExpressionContext(nodeId)` is a pure React hook over the canvas store. It:

- Reads `nodes` and `edges` from `useWorkflowCanvasStore`
- Derives `triggerPayload` from `startNode.data.config.inputVariables` (variable name + type, not runtime values)
- Derives `previousSteps` via BFS backward traversal using `edges`
- Memoizes both computations with `useMemo`
- Returns `{ triggerPayload, previousSteps }`

Each node config that needs expressions calls this hook directly. No prop-drilling from `ConfigPanel`.

### Sub-Component Threading (GenericNodeConfig)

`AgentNodeConfig`, `ToolNodeConfig`, and `AgenticAppConfig` are private sub-components inside `GenericNodeConfig`. They do not receive `nodeId` as a prop from `ConfigPanel`. `GenericNodeConfig` passes `nodeId` down to each sub-component which then calls `useWorkflowExpressionContext(nodeId)` independently.

---

## 8. How to Consume

### Studio UI

Access via the workflow canvas:

- **Route**: `/projects/:projectId/workflows/:workflowId/flow`
- **Entry point**: Click any non-start/non-end node on the canvas → ConfigPanel opens on the right
- **Expression inputs**: Any field with a `{⋮}` icon supports expression authoring
- **Trigger**: Type `{{` or click `{⋮}` to open ContextExplorer

### Surface Semantics Matrix

| Asset / Entity Type     | Source of Truth / Ownership                                  | Design-Time Surface              | Editable or Read-Only?   | Consumer Reference             | Runtime Materialization                            | Notes                                                   |
| ----------------------- | ------------------------------------------------------------ | -------------------------------- | ------------------------ | ------------------------------ | -------------------------------------------------- | ------------------------------------------------------- |
| `triggerPayload` schema | Start node `inputVariables` config in canvas store           | ContextExplorer Trigger category | Read-only (display only) | `useWorkflowExpressionContext` | `trigger.payload` at workflow runtime              | Design-time schema only; actual values are runtime data |
| `previousSteps`         | Canvas `nodes` + `edges` BFS traversal                       | ContextExplorer Nodes category   | Read-only                | `useWorkflowExpressionContext` | `steps.<label>` at runtime                         | `outputSchema` always `undefined` in v1                 |
| Memory schema           | Static constants in `ContextExplorer.tsx`                    | Memory category                  | Read-only                | `MEMORY_FIELDS`                | `memory.workflow`, `memory.project`, `memory.user` | Populated at runtime from FactStore                     |
| AgentSession schema     | `AgentSessionProjection` interface in expression-resolver.ts | Agent Session category           | Read-only                | `AGENT_SESSION_FIELDS`         | `agentSession.*` — only for agent-triggered runs   | `undefined` for non-agent triggers                      |
| AgentContext schema     | `AgentContextProjection` interface                           | Agent Context category           | Read-only                | `AGENT_CONTEXT_FIELDS`         | `agentContext.*` — only for agent-triggered runs   | `undefined` for non-agent triggers                      |

### Design-Time vs Runtime Behavior

**Design-time**: `ContextExplorer` shows the static schema of available expressions. Trigger fields come from the Start node's declared `inputVariables`; step labels come from the current canvas node labels. No API call is made.

**Runtime**: The workflow engine resolves `{{expression}}` paths against the live `WorkflowContextData` object. If a path is unavailable (e.g. `agentSession.*` for a webhook trigger), the resolver returns `undefined`, which serializes to the string `"undefined"` in string contexts.

### API (Runtime)

N/A — this feature has no new API endpoints. All logic is client-side canvas store reads.

### API (Studio)

N/A — no new Studio API routes.

### Admin Portal

N/A.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. The expression authoring surface is design-time only.

---

## 9. Data Model

No new collections, tables, or indexes. This feature is purely a Studio UI computation layer over the existing canvas store.

### Key Relationships

- Reads `WorkflowNodeData.config.inputVariables` from Start node (canvas store, in-memory)
- Reads `nodes[]` and `edges[]` from canvas store (in-memory, not persisted separately)
- Static schemas for Memory/AgentSession/AgentContext are hardcoded constants in `ContextExplorer.tsx` (derived from `expression-resolver.ts` interfaces)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                                | Purpose                                                                                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/hooks/useWorkflowExpressionContext.ts` | Shared hook — BFS backward traversal, triggerPayload derivation, step-key contract                                         |
| `apps/workflow-engine/src/context/expression-resolver.ts`                           | Runtime source of truth for `KNOWN_TOP_LEVEL_KEYS`, `AgentSessionProjection`, `AgentContextProjection`, `MemoryProjection` |

### UI Components

| File                                                                           | Purpose                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/steps/ContextExplorer.tsx`               | Browsable expression tree — 6 categories, search, tree expand/collapse, onSelect callback |
| `apps/studio/src/components/workflows/canvas/config/ExpressionInput.tsx`       | Text/textarea wrapper — `{⋮}` button, `{{` auto-trigger, cursor-preserving insert         |
| `apps/studio/src/components/workflows/canvas/config/IntegrationNodeConfig.tsx` | Refactored to use shared hook (was inline BFS)                                            |
| `apps/studio/src/components/workflows/canvas/config/ApiNodeConfig.tsx`         | URL, header values, body content — ExpressionInput                                        |
| `apps/studio/src/components/workflows/canvas/config/TextToTextNodeConfig.tsx`  | System Prompt, Human Prompt — ExpressionInput                                             |
| `apps/studio/src/components/workflows/canvas/config/ConditionNodeConfig.tsx`   | Condition Field, Value — ExpressionInput                                                  |
| `apps/studio/src/components/workflows/canvas/config/LoopNodeConfig.tsx`        | Source field — ExpressionInput                                                            |
| `apps/studio/src/components/workflows/canvas/config/GenericNodeConfig.tsx`     | Agent (input, sessionId), Tool (param values), AgenticApp (input) — ExpressionInput       |
| `apps/studio/src/components/workflows/canvas/config/HumanNodeConfig.tsx`       | Subject, Message — ExpressionInput                                                        |
| `apps/studio/src/components/workflows/canvas/config/DataEntryNodeConfig.tsx`   | Subject, Message — ExpressionInput                                                        |

### Tests

| File                                                                                               | Type        | Coverage Focus                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `apps/studio/src/components/workflows/canvas/hooks/__tests__/useWorkflowExpressionContext.test.ts` | unit        | BFS traversal, step-key contract, triggerPayload derivation                          |
| `apps/studio/src/components/workflows/steps/__tests__/ContextExplorer.test.tsx`                    | unit        | Category rendering, search filtering, expression insertion                           |
| `apps/studio/src/components/workflows/canvas/config/__tests__/ApiNodeConfig.expression.test.tsx`   | integration | ExpressionInput in ApiNodeConfig — `{{` auto-trigger, expression insert at cursor    |
| `apps/studio/e2e/workflows/expression-authoring.spec.ts`                                           | e2e         | Full authoring journey — type `{{`, select step output, verify canvas config updated |

---

## 11. Configuration

### Environment Variables

N/A — no environment variables.

### Runtime Configuration

No feature flags. Ships directly. Expression authoring is available for all projects as part of the standard workflow canvas.

### DSL / Agent IR / Schema

N/A — this feature does not change the compiled workflow DSL or IR. Expression syntax is `{{path}}` as already defined by the workflow engine.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `useWorkflowExpressionContext` reads only from the current project's canvas store (in-memory, scoped to the open workflow). No cross-project reads.                                                                                            |
| Tenant isolation  | `triggerPayload` is derived from design-time schema only (variable names, not runtime data). No tenant-scoped API calls are made. The canvas store is already tenant- and project-scoped via the auth middleware on the enclosing Studio page. |
| User isolation    | No user-owned resources are accessed. The feature reads node topology which is project-owned.                                                                                                                                                  |

### Security & Compliance

- No API calls are made by the expression authoring UI.
- `triggerPayload` contains only variable names and declared types from the Start node config, not actual runtime execution data.
- Expression paths are inserted as plain strings into node config values; they are evaluated at runtime by the workflow engine under the existing expression resolver security boundary.
- No PII exposure risk at design time.

### Performance & Scalability

- `useMemo` on both `triggerPayload` and `previousSteps` — recomputes only when `nodes` or `edges` change.
- BFS traversal is O(N+E) where N = number of canvas nodes, E = number of edges. Workflow canvases are bounded (< 200 nodes in practice); no perf concern.
- `ContextExplorer` search filters the in-memory tree synchronously — no debounce needed at this scale.

### Reliability & Failure Modes

- If the Start node is absent (malformed canvas), `triggerPayload` returns `{}` — Trigger category shows "No fields available".
- If `edges` is empty, `previousSteps` returns `[]` — Nodes category shows "No fields available".
- Static schema constants for Memory/AgentSession/AgentContext are hardcoded — they never fail.
- ExpressionInput degrades gracefully if `inputRef` is null (inserts expression at end of value).

### Observability

- No new trace events — this is a design-time UI feature.
- If expressions fail to resolve at runtime, the existing `ExpressionTrace` mechanism in `expression-resolver.ts` captures resolution failures.

### Data Lifecycle

N/A — no persistent data. All state is in-memory canvas store.

---

## 13. Delivery Plan / Work Breakdown

1. **Shared Hook & Step-Key Bug Fix**
   1.1. Create `useWorkflowExpressionContext.ts` with BFS traversal using `n.data.label` as step key
   1.2. Refactor `IntegrationNodeConfig` to use the shared hook, remove inline BFS logic

2. **ContextExplorer Category Expansion**
   2.1. Add `AGENT_SESSION_FIELDS`, `AGENT_CONTEXT_FIELDS`, `MEMORY_FIELDS` static schemas
   2.2. Add Memory, Agent Session, Agent Context `CategorySection` renders
   2.3. Correct context field paths (`{{workflow.id}}`, `{{tenant.tenantId}}` replacing wrong `{{context.*}}`)

3. **Node Config ExpressionInput Wiring**
   3.1. `ApiNodeConfig` — URL, header values, body content
   3.2. `TextToTextNodeConfig` — system prompt, human prompt
   3.3. `ConditionNodeConfig` — field, value (thread hook + props to `ConditionCard`)
   3.4. `LoopNodeConfig` — source field
   3.5. `GenericNodeConfig` — Agent (input, sessionId), Tool (param values), AgenticApp (input); thread `nodeId` to sub-components
   3.6. `HumanNodeConfig` — subject, message
   3.7. `DataEntryNodeConfig` — subject, message

4. **Tests** _(required before BETA promotion)_
   4.1. Unit tests for `useWorkflowExpressionContext` (BFS, step-key, triggerPayload)
   4.2. Unit tests for `ContextExplorer` (category rendering, search, expression paths)
   4.3. Integration tests for ExpressionInput in representative node configs
   4.4. E2E tests for full authoring journey

---

## 14. Success Metrics

| Metric                             | Baseline                        | Target                                                     | How Measured                                                        |
| ---------------------------------- | ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Node types with expression support | 1 (integration only)            | 10 (all configurable types)                                | Count of configs importing `ExpressionInput`                        |
| Step expression correctness        | 0% (UUID-based, never resolves) | 100% (label-based, matches runtime)                        | Unit test: `useWorkflowExpressionContext` step-key contract         |
| ContextExplorer categories         | 3 (Trigger, Nodes, Context)     | 6 (+ Memory, Agent Session, Agent Context)                 | Unit test: category rendering assertion                             |
| Trigger-step resolution rate (TSR) | Unmeasured                      | ≥95% of inserted expressions resolve on first execution    | Workflow execution trace `ExpressionTrace` success rate             |
| ExpressionInput adoption           | 0%                              | 100% of expression-bearing config fields                   | PR review gate — no plain `<Input>` or `<Textarea>` in node configs |
| Broken-reference rate              | Unmeasured                      | <5% of saved workflows contain unreachable step references | Expression audit scan on workflow save (post-GA)                    |

---

## 15. Open Questions

1. **Output schema inference**: Should `previousSteps` eventually carry per-node `outputSchema` so ContextExplorer can show typed sub-fields for known node outputs (e.g. TextToText structured output, API response schema)? Currently always `undefined`. This would require either static schema registration per node type or a runtime-introspected schema.
2. **FunctionEditorOverlay**: Should a read-only ContextExplorer panel be embedded in the function node's full-screen Monaco editor as a reference sidebar? Currently, only a static text hint bar shows expression examples.
3. **Dynamic dropdown expression**: Should `DynamicDropdownField` support expression mode (toggle between static options and `{{expression}}` string)? Currently only the integration node's `DynamicActionForm` has this toggle.
4. **Trigger type gating**: Should Memory/AgentSession/AgentContext categories be visually marked (e.g. badge or tooltip) when the current workflow's trigger type is `webhook` or `cron`, to communicate that these fields will be `undefined` at runtime?
5. **ContextExplorer — Radix Accordion refactor**: The custom `CategorySection` expand/collapse pattern (expandedKeys Set + toggle callbacks, ~80 lines) could be replaced with `@radix-ui/react-accordion` (already installed) to gain WAI-ARIA keyboard navigation compliance and reduce custom state management. Migration cost is low (<1 day, no behavior change). Deferred as an incremental improvement.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                      | Severity | Status                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| GAP-001 | `outputSchema` is always `undefined` for previous steps — ContextExplorer shows only `{{steps.<label>.output}}` as a single leaf with type `any`; no sub-field traversal                                                                         | High     | Open — deferred to v2 (requires schema registry or runtime introspection)            |
| GAP-002 | `FunctionEditorOverlay` (Monaco) has no expression explorer panel — function node authors must type paths manually; the static hint bar is a partial mitigation                                                                                  | Medium   | Open — deferred (Monaco integration complexity)                                      |
| GAP-003 | Dynamic dropdown fields (`DynamicDropdownField`) do not support expression mode                                                                                                                                                                  | Low      | Open — deferred                                                                      |
| GAP-004 | Memory/AgentSession/AgentContext categories are always shown even for trigger types where they will be `undefined` at runtime (e.g. webhook, cron) — no visual indicator of availability                                                         | Low      | Open — UX improvement for future iteration                                           |
| GAP-005 | No E2E or integration test coverage exists yet — test files are planned (paths defined in §10)                                                                                                                                                   | High     | Open — required for BETA promotion                                                   |
| GAP-006 | Node rename does not propagate to existing expressions — if a node label changes after expressions have been authored, all `{{steps.<old-label>.output}}` references become stale; there is no rename-refactoring mechanism in `updateNodeLabel` | High     | Open — requires `useWorkflowCanvasStore` label-change cascade and expression-scan PR |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                                                             | Coverage Type | Status     | Test File / Note |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ---------- | ---------------- |
| 1   | `useWorkflowExpressionContext` — BFS finds all upstream nodes and excludes Start node                                                | unit          | NOT TESTED | TBD              |
| 2   | Step key is canvas label, not UUID                                                                                                   | unit          | NOT TESTED | TBD              |
| 3   | `triggerPayload` built from Start node `inputVariables` only                                                                         | unit          | NOT TESTED | TBD              |
| 4   | `ContextExplorer` renders all 6 categories with correct expressions                                                                  | unit          | NOT TESTED | TBD              |
| 5   | ContextExplorer search filters across all categories                                                                                 | unit          | NOT TESTED | TBD              |
| 6   | ExpressionInput — `{{` auto-opens explorer; selection inserts without doubling braces                                                | unit          | NOT TESTED | TBD              |
| 7   | ExpressionInput — `{⋮}` button toggles explorer                                                                                      | unit          | NOT TESTED | TBD              |
| 8   | Integration: ApiNodeConfig URL field accepts expression and saves to config                                                          | integration   | NOT TESTED | TBD              |
| 9   | Integration: ConditionNodeConfig field/value accept expressions                                                                      | integration   | NOT TESTED | TBD              |
| 10  | Integration: Agent node input expression resolves in execution                                                                       | integration   | NOT TESTED | TBD              |
| 11  | E2E: Open workflow canvas → configure API node URL with `{{trigger.payload.url}}` → execute → URL resolved correctly                 | e2e           | NOT TESTED | TBD              |
| 12  | E2E: Open workflow canvas → configure Condition node field with upstream Agent node output → execute → condition evaluated correctly | e2e           | NOT TESTED | TBD              |

### Testing Notes

No automated tests exist for this feature yet. GAP-005 is a HIGH gap that blocks BETA promotion. Manual verification confirms ContextExplorer renders, ExpressionInput triggers on `{{`, and expressions are inserted into config fields. Runtime correctness of generated expressions has been partially verified via manual workflow execution.

> Full testing details: `../../testing/sub-features/workflow-canvas-context-suggestions.md`

---

## 18. References

- Backend expression contract: `apps/workflow-engine/src/context/expression-resolver.ts`
- Parent feature spec: `docs/features/sub-features/workflow-first-class-memory-and-context.md`
- Workflows hub: `docs/features/sub-features/workflows.md`
- Canvas store: `apps/studio/src/store/workflow-canvas-store.ts`
- Workflow handler step-key source: `apps/workflow-engine/src/handlers/workflow-handler.ts`
