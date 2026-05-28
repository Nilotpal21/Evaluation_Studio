# HLD: Workflow Canvas Context Suggestions

**Feature Spec**: `docs/features/sub-features/workflow-canvas-context-suggestions.md`
**Test Spec**: `docs/testing/sub-features/workflow-canvas-context-suggestions.md`
**Status**: APPROVED
**Author**: Veerannapet Santhosh Vishal
**Date**: 2026-05-05

---

## 1. Problem Statement

Workflow authors configuring node parameters in the Studio canvas were required to type `{{expression}}` paths from memory. No discoverability existed for available variables, upstream step outputs, or runtime context keys. The only node type with expression support was the integration node (via `DynamicActionForm`). All other node types — API, TextToText, Condition, Loop, Agent, Tool, Human, DataEntry — accepted plain text inputs with no authoring assistance.

A compounding bug: `IntegrationNodeConfig` had inline BFS traversal that generated step expressions using the node UUID (`steps.${uuid}.output`). The workflow engine keys steps by canvas label (`ctx.steps[step.name ?? step.id]`, where `step.name = n.data.label`), so UUID-based paths silently resolved to `undefined` at runtime.

This HLD designs the **purely Studio-side** authoring layer: a shared hook for BFS graph traversal, an `ExpressionInput` wrapper component, and an expanded `ContextExplorer` with all six expression categories, wired to all node config panels.

---

## 2. Alternatives Considered

### Option A: Per-Node Inline Implementation (status quo extended)

- **Description**: Each `*NodeConfig` component independently implements its own expression input (custom `<input>` with a tooltip listing common paths). No shared hook or shared explorer panel.
- **Pros**: No coordination between node configs. Each node can customise its expression hints.
- **Cons**: Code duplication across 9 files. The step-key bug would have to be fixed in each file separately. No unified search, no consistent UX. Discoverability is still text-hint only.
- **Effort**: L (growing maintenance burden)

### Option B: ConfigPanel-Level Prop Threading (centralised hook, threaded props)

- **Description**: `ConfigPanel` calls `useWorkflowExpressionContext(selectedNodeId)` once and passes `triggerPayload` and `previousSteps` as props to every `*NodeConfig` child.
- **Pros**: Single hook invocation per open panel. Slightly lower re-render surface.
- **Cons**: Forces `ConfigPanel` to know about expression context — a concern it currently doesn't have. Every `*NodeConfig` interface must be updated to accept and thread these props. `GenericNodeConfig` has private sub-components (`AgentNodeConfig`, `ToolNodeConfig`, `AgenticAppConfig`) that would need two levels of prop threading. Tight coupling between the panel orchestrator and every config's expression needs.
- **Effort**: M (same code volume, worse coupling)

### Option C: Shared Hook Per NodeConfig (chosen)

- **Description**: Each `*NodeConfig` independently calls `useWorkflowExpressionContext(nodeId)`, which reads from the shared Zustand store. `nodeId` is already passed to every `*NodeConfig` as a prop from `ConfigPanel`. The hook is memoised so calling it in multiple components for the same `nodeId` is safe (React deduplicates via store subscription).
- **Pros**: Each node config is self-contained. No prop threading through `ConfigPanel`. No coupling between configs. Private sub-components in `GenericNodeConfig` receive `nodeId` from their parent (not from `ConfigPanel`), which is one level of threading. Follows the existing pattern of `ConfigPanel` passing `nodeId` to child configs.
- **Cons**: Hook called N times (once per config file that renders), not once. In practice, only one config renders at a time (only one node is selected), so this has zero practical overhead.
- **Effort**: S

### Option D: Global Context Provider

- **Description**: Wrap the canvas in a React context that provides `triggerPayload` and `previousSteps` to any descendant via `useContext`.
- **Pros**: Single computation. Available anywhere in the canvas subtree.
- **Cons**: Context re-renders all consumers whenever `nodes` or `edges` change — including node components on the canvas itself. The Zustand selector pattern already provides fine-grained subscription; a React context would be a regression. Overkill for data only needed in config panels.
- **Effort**: M

### Recommendation: Option C — Shared Hook Per NodeConfig

**Rationale**: Self-contained configs, no `ConfigPanel` coupling, zero practical performance impact (one panel open at a time), follows established `nodeId`-prop-threading pattern. The hook's `useMemo` on both computations means BFS only re-runs when the canvas topology changes, not on every keystroke or config update.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Studio UI (Next.js / React)  — apps/studio                     │
│                                                                  │
│  ┌─────────────────┐     ┌──────────────────────────────────┐   │
│  │  WorkflowCanvas  │     │  ConfigPanel (right panel)       │   │
│  │  (React Flow)    │────▶│                                  │   │
│  │                  │     │  *NodeConfig                     │   │
│  │  nodes[]         │     │    useWorkflowExpressionContext  │   │
│  │  edges[]         │     │      (reads from store)          │   │
│  └─────────────────┘     │    ExpressionInput (per field)    │   │
│         │                │      ContextExplorer (popover)    │   │
│         ▼                └──────────────────────────────────┘   │
│  ┌─────────────────┐              │ onChange(newValue)          │
│  │ workflow-canvas  │◀─────────────┘                             │
│  │ -store.ts       │                                             │
│  │ (Zustand)        │                                             │
│  └─────────────────┘                                             │
│                                                                  │
│  ── NO new API routes ── NO backend calls ── NO DB changes ───  │
└─────────────────────────────────────────────────────────────────┘
                    │  existing workflow save
                    ▼
         Studio BFF (Next.js API routes)
                    │
                    ▼
         Workflow Engine — unchanged
         expression-resolver.ts resolves {{paths}} at runtime
```

### Component Diagram

```
useWorkflowExpressionContext(nodeId)
  ├── reads: useWorkflowCanvasStore().nodes
  ├── reads: useWorkflowCanvasStore().edges
  ├── computes: triggerPayload  (Start node inputVariables → { name: type })
  └── computes: previousSteps   (BFS backward from nodeId, id = n.data.label)

ExpressionInput (props: value, onChange, triggerPayload, previousSteps, ...)
  ├── <input> or <textarea>  (controlled, value/onChange)
  ├── {⋮} button             (toggles showExplorer)
  ├── handleInputChange       (detects '{{' trigger, opens explorer)
  ├── handleInsertExpression  (cursor splice; hasPendingBraces derived inline
  │                            from cursor position — NOT React state;
  │                            brace-dedup if value[-2:cursor] === '{{')
  └── ContextExplorer         (rendered when showExplorer, absolute z-50)
        ├── Category: Trigger    (buildNodesFromObject(triggerPayload, 'trigger.payload'))
        ├── Category: Nodes      (previousSteps mapped to step tree nodes)
        ├── Category: Context    (CONTEXT_METADATA_FIELDS — static)
        ├── Category: Memory     (MEMORY_FIELDS — static)
        ├── Category: AgentSession   (AGENT_SESSION_FIELDS — static)
        └── Category: AgentContext   (AGENT_CONTEXT_FIELDS — static)

Default expansion: Trigger, Nodes, Context pre-expanded on open (most-used);
Memory, Agent Session, Agent Context start collapsed (secondary/agent-only).

*NodeConfig files (9 total — each independently calls hook)
  ApiNodeConfig         → URL, header values, body content
  TextToTextNodeConfig  → system prompt, human prompt
  ConditionNodeConfig   → field, value (threaded to ConditionCard sub-component)
  LoopNodeConfig        → source
  GenericNodeConfig     → AgentNodeConfig (input, sessionId)
                          ToolNodeConfig (param values)
                          AgenticAppConfig (input)
  HumanNodeConfig       → subject, message
  DataEntryNodeConfig   → subject, message
  IntegrationNodeConfig → (refactored from inline BFS to shared hook)
```

### Data Flow — Design Time

```
1. User clicks node on canvas
        │
        ▼
2. WorkflowCanvas sets selectedNodeId in useWorkflowCanvasStore
        │
        ▼
3. ConfigPanel reads selectedNodeId → finds node → renders *NodeConfig(nodeId, config, onUpdate)
        │
        ▼
4. *NodeConfig calls useWorkflowExpressionContext(nodeId)
   ┌─── Hook reads nodes[], edges[] from store (Zustand subscription)
   ├─── useMemo: triggerPayload = startNode.data.config.inputVariables → { name: type }
   └─── useMemo: previousSteps = BFS backward from nodeId
                  { id: n.data.label, name: n.data.label, outputSchema: undefined }
        │
        ▼
5. *NodeConfig passes triggerPayload, previousSteps to each <ExpressionInput>
        │
        ▼
6a. User types '{{' in field:
    ExpressionInput.handleInputChange detects slice[-2:] === '{{'
    → setShowExplorer(true)
    (hasPendingBraces is NOT React state; it will be re-derived from cursor
     position inline inside handleInsertExpression when the user selects)

6b. User clicks {⋮} button:
    → setShowExplorer(!showExplorer)
    (no hasPendingBraces flag set; on insert, cursor is at current position)
        │
        ▼
7. ContextExplorer renders with 6 categories

   Path A — User clicks leaf node (e.g. '{{steps.Agent0001.output}}'):
   → onSelect('{{steps.Agent0001.output}}') fires
   → continues to step 8

   Path B — User presses Escape or clicks outside ContextExplorer:
   → setShowExplorer(false)
   → onChange NOT called; value unchanged; explorer closes with no insertion
        │
        ▼
8. ExpressionInput.handleInsertExpression:
   cursor = inputRef.current.selectionStart
   hasPendingBraces = (cursor >= 2 && value.slice(cursor-2, cursor) === '{{')  ← computed const
   if hasPendingBraces: insertStart = cursor - 2  (replace the '{{')
   else:               insertStart = cursor
   newValue = value.slice(0, insertStart) + expression + value.slice(cursor)
   onChange(newValue)   ← calls *NodeConfig's field setter
   setShowExplorer(false)
        │
        ▼
9. *NodeConfig calls onUpdate(updatedConfig)
   → useWorkflowCanvasStore.updateNodeConfig(nodeId, updatedConfig)
   → isDirty = true → useAutoSave triggers debounced PATCH /versions/draft
```

### Sequence Diagram — `{{` auto-trigger to expression insertion

```
User           ExpressionInput       ContextExplorer     CanvasStore
 │                    │                     │                  │
 │ type '{{'          │                     │                  │
 │──────────────────▶│                     │                  │
 │                    │ handleInputChange   │                  │
 │                    │ detects '{{', sets  │                  │
 │                    │ showExplorer=true   │                  │
 │                    │─────────────────▶  │                  │
 │                    │                    │ renders w/ props  │
 │                    │                    │ (triggerPayload,  │
 │                    │                    │ previousSteps)    │
 │ clicks leaf        │                    │                  │
 │────────────────────────────────────────▶│                  │
 │                    │ onSelect(expr)      │                  │
 │                    │◀────────────────── │                  │
 │                    │ handleInsertExpr   │                  │
 │                    │ splice, no-double  │                  │
 │                    │ onChange(newVal)   │                  │
 │                    │────────────────────────────────────▶  │
 │                    │                    │  updateNodeConfig  │
 │                    │ showExplorer=false │                  │
 │                    │─────────────────▶ X (closed)          │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | N/A — no server-side component. The canvas store is populated from the workflow loaded for the authenticated user's project. All expression suggestions derive from in-memory store state that is already project- and tenant-scoped by the workflow loading API. No cross-tenant data is accessible from the Studio canvas.                                                                                                      |
| 2   | **Data Access Pattern** | Pure Zustand store reads. `useWorkflowExpressionContext` subscribes to `nodes` and `edges` slices of `useWorkflowCanvasStore`. No repository layer, no MongoDB, no Redis. Both derived values are memoised with `useMemo`. All static schemas are compile-time constants in `ContextExplorer.tsx`.                                                                                                                                |
| 3   | **API Contract**        | No new API endpoints. The internal component contract: `ExpressionInput` accepts `{ value, onChange, triggerPayload, previousSteps, ... }`. `ContextExplorer` accepts `{ triggerPayload, previousSteps, onSelect, className? }`. Both are internal Studio components with no public API surface.                                                                                                                                  |
| 4   | **Security Surface**    | No API calls from the expression authoring UI. `triggerPayload` contains only variable names and declared types from the Start node config — not runtime execution data. Expression paths inserted by `ContextExplorer` are plain strings; they are evaluated at runtime by the workflow engine under the existing `expression-resolver.ts` security boundary. No `eval`, no code execution at design time. No PII exposure risk. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | ExpressionInput degrades gracefully if `inputRef` is null (insert at end of value). If the Start node is absent, `triggerPayload` returns `{}` and Trigger category shows "No fields available". If edges are empty, `previousSteps` returns `[]`. Static category schemas (Memory, AgentSession, AgentContext) never fail. **Decided**: The hook MUST guard with `id: n.data.label ?? n.id` — if `n.data.label` is `undefined`, fall back to the node UUID. A UUID-based expression path fails silently at runtime but is diagnosable via `ExpressionTrace`; an `undefined`-based path (`{{steps.undefined.output}}`) is harder to debug and collides across all unlabelled nodes. The fallback UUID is strictly better. This guard is a required LLD implementation item (not optional). |
| 6   | **Failure Modes** | No network calls, no async operations. The only failure modes are React rendering errors. If `ExpressionInput` throws, the parent `*NodeConfig` would fail to render. **Risk**: no error boundary wraps individual `*NodeConfig` components in `ConfigPanel`. Mitigation: keep ExpressionInput's render path side-effect-free; add an error boundary to `ConfigPanel` as a defensive measure.                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | **Idempotency**   | N/A — insert-only operation on a local string value. Selecting the same expression twice appends it twice (correct behaviour — the user typed two insertions). The brace-deduplication applies only when a pending `{{` is detected at the cursor; it does not prevent double-insertion in general.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | **Observability** | No new trace events — this is a design-time UI feature. Runtime expression resolution failures are captured by the existing `ExpressionTrace` mechanism in `expression-resolver.ts`. No new logging is introduced. If the undefined-label bug manifests in production, it will surface as `steps.undefined` never resolving in `ExpressionTrace`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | BFS traversal: O(N+E), N < 200, E < N². Both `triggerPayload` and `previousSteps` are `useMemo`-guarded. ContextExplorer search: synchronous in-memory filter over ≤ 50 total nodes. No debounce needed. No network round-trips. No performance budget concern at current canvas scale.                                                                                                                                                                                                                                                                                                                                                                                             |
| 10  | **Migration Path**     | No data migration. Existing UUID-based expressions (`steps.${uuid}.output`) in saved workflow configs were already broken at runtime (unresolvable). They remain broken after this feature ships — no backfill is implemented. New expressions authored after this feature ships will use correct label-based paths. Future tooling could scan workflow configs for `steps.<uuid-pattern>.output` and flag them, but this is out of scope.                                                                                                                                                                                                                                          |
| 11  | **Rollback Plan**      | Revert the `apps/studio` commits and redeploy Studio frontend. No backend state is affected. No DB migrations to roll back. **Atomic rollback required**: `ExpressionInput`, `ContextExplorer`, `useWorkflowExpressionContext`, and all 9 `*NodeConfig` file changes form a single atomic rollback unit — partial revert of any one component will break the remaining NodeConfig files that depend on it. The `IntegrationNodeConfig` revert reintroduces the pre-existing UUID step-key bug (accepted regression on rollback). Expressions already inserted by users (label-based `{{steps.X.output}}`) remain valid in storage — they are opaque strings to the workflow engine. |
| 12  | **Test Strategy**      | Unit tests: `useWorkflowExpressionContext` (BFS, step-key contract, triggerPayload derivation) + `ContextExplorer` (category rendering, search) + `ExpressionInput` (cursor logic, brace-deduplication). Integration tests: Vitest + React Testing Library with real Zustand store (no `vi.mock` of platform components). E2E: Playwright against real Studio + workflow-engine for expression resolution scenarios. Full test plan: `docs/testing/sub-features/workflow-canvas-context-suggestions.md`.                                                                                                                                                                            |

---

## 5. Data Model

No new collections, tables, or indexes. No schema changes.

### Key Relationships (in-memory only)

```
WorkflowCanvasStore (Zustand, in-memory)
  nodes: WorkflowNode[]        ← source of triggerPayload (startNode.data.config.inputVariables)
  edges: WorkflowEdge[]        ← source of BFS traversal for previousSteps

WorkflowNode.data.label        ← the runtime step key (used as previousSteps[i].id)
WorkflowNode.data.config       ← written back after expression insertion

WorkflowPreviousStep (exported interface — primary data contract)
  id: string                   ← canvas label (n.data.label ?? n.id); NOT the node UUID
                                  This is the step key used in {{steps.<id>.output}}
  name: string                 ← same as id (display label in ContextExplorer)
  outputSchema?: Record<string, unknown>  ← always undefined in v1

expression-resolver.ts interfaces (read-only reference, compile-time)
  AgentSessionProjection        ← source of AGENT_SESSION_FIELDS constants
  AgentContextProjection        ← source of AGENT_CONTEXT_FIELDS constants
  MemoryProjection              ← source of MEMORY_FIELDS constants
  KNOWN_TOP_LEVEL_KEYS          ← canonical top-level key list
```

### Static Schema Constants in ContextExplorer.tsx

These constants are hardcoded in `ContextExplorer.tsx` and derived from `expression-resolver.ts` interfaces. They must be kept in sync when the engine interfaces gain new fields:

| Constant                  | Source Interface                          | Fields                                                                  |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `CONTEXT_METADATA_FIELDS` | `WorkflowContextData.workflow`, `.tenant` | `workflow.id`, `.name`, `.executionId`, `tenant.tenantId`, `.projectId` |
| `MEMORY_FIELDS`           | `MemoryProjection`                        | `memory.workflow`, `.project`, `.user`                                  |
| `AGENT_SESSION_FIELDS`    | `AgentSessionProjection`                  | 8 fields including `lastActivityAt`                                     |
| `AGENT_CONTEXT_FIELDS`    | `AgentContextProjection`                  | `caller`, `invocation`, `messageMetadata`, `attachments`                |

---

## 6. API Design

No new endpoints. No modifications to existing endpoints.

### Internal Component Interface

**`useWorkflowExpressionContext(nodeId: string)`** — React hook

```typescript
// Returns:
{
  triggerPayload: Record<string, unknown>;  // { varName: 'type', ... }
  previousSteps: WorkflowPreviousStep[];    // { id: label, name: label, outputSchema: undefined }
}
```

**`ExpressionInput`** — React component props

```typescript
interface ExpressionInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  description?: string;
  triggerPayload: Record<string, unknown>;
  previousSteps: Array<{ id: string; name: string; outputSchema?: Record<string, unknown> }>;
}
```

**`ContextExplorer`** — React component props

```typescript
interface ContextExplorerProps {
  triggerPayload: Record<string, unknown>;
  previousSteps: PreviousStep[];
  onSelect: (expression: string) => void;
  className?: string;
}
```

### Error Responses

N/A — no server-side component.

---

## 7. Cross-Cutting Concerns

| Concern            | Decision                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit Logging**  | N/A — design-time UI only. No user action audit trail for expression insertion (it is equivalent to typing text).                                                                                                                                                                                                                                                            |
| **Rate Limiting**  | N/A — no API calls.                                                                                                                                                                                                                                                                                                                                                          |
| **Caching**        | Zustand `useMemo` provides in-process caching of BFS results. No distributed cache.                                                                                                                                                                                                                                                                                          |
| **Encryption**     | N/A — design-time schema only. Variable names and types are not sensitive. Actual runtime values never pass through the Studio expression authoring UI.                                                                                                                                                                                                                      |
| **Error Boundary** | `ConfigPanel` does not currently have an error boundary around `*NodeConfig` renders. Given that `ExpressionInput` is now wired to 9 config files (blast radius = all non-start/end/function node types), adding an error boundary to `ConfigPanel` is recommended to prevent a rendering crash from making the entire config panel inaccessible.                            |
| **Accessibility**  | The `{⋮}` button has `aria-label="Open expression explorer"`. The ContextExplorer search input and category buttons are keyboard-focusable `<button>` elements. The custom expand/collapse pattern (`expandedKeys` Set) does not have ARIA accordion semantics — this is documented as a future improvement via `@radix-ui/react-accordion` (Feature Spec Open Question #5). |

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                          | Type                           | Risk                                                     |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------- |
| `useWorkflowCanvasStore` (Zustand)  | Internal — canvas store        | Low — stable API, widely used                            |
| `expression-resolver.ts` interfaces | Internal — read-only reference | Low — only static constants; changes require manual sync |
| `lucide-react`                      | External npm                   | Low — already installed, MIT licensed                    |
| `clsx`                              | External npm                   | Low — already installed, MIT licensed                    |
| `@xyflow/react`                     | External npm (types via store) | Low — types used transitively via canvas store           |

### Downstream (depends on this feature)

| Consumer                  | Impact                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| All 9 `*NodeConfig` files | ExpressionInput is the new rendering path for all expression fields. Breaking ExpressionInput breaks all config panels.                        |
| `DynamicActionForm.tsx`   | Uses ExpressionInput for integration node's string field inputs — already existed; refactored to use shared hook.                              |
| Workflow execution engine | Downstream consumer of the expressions authored in config fields. Correct label-based paths now resolve via `ctx.steps[step.name ?? step.id]`. |

---

## 9. Decided & Open Items

### Closed Decisions

1. **Undefined label guard** _(DECIDED)_: The hook MUST use `id: n.data.label ?? n.id`. If `n.data.label` is `undefined` (malformed or programmatically added node), fall back to the node UUID. A UUID path fails silently at runtime but is diagnosable via `ExpressionTrace`; an `undefined`-keyed path (`{{steps.undefined.output}}`) collides across all unlabelled nodes and produces identical, indistinguishable failures. The UUID fallback is strictly better. **LLD must implement this guard.** See concern #5 (Error Model).

### Open Questions

2. **Error boundary for ConfigPanel**: `ConfigPanel` has no error boundary around `*NodeConfig` renders. Given ExpressionInput is now a dependency of all config panels, a rendering crash would make the entire panel inaccessible. Recommendation: wrap each `*NodeConfig` render in `<ErrorBoundary fallback={<ConfigError />}>`. Add to LLD task list.

3. **Q-3: Rename propagation** _(see feature spec GAP-006)_: `updateNodeName` in `workflow-canvas-store.ts` does not scan other nodes' config values for `{{steps.<old-label>.output}}` expressions. Node renaming silently breaks existing expressions. Out of scope for this HLD — follow-up LLD task.

4. **ContextExplorer accessibility**: The custom `CategorySection` expand/collapse lacks WAI-ARIA accordion semantics. `@radix-ui/react-accordion` (already installed) could replace it. Deferred — not blocking ALPHA or BETA.

---

## 10. References

- Feature spec: `docs/features/sub-features/workflow-canvas-context-suggestions.md`
- Test spec: `docs/testing/sub-features/workflow-canvas-context-suggestions.md`
- Parent feature HLD: `docs/specs/workflow-first-class-memory-and-context.hld.md`
- Related design (integration node): `docs/specs/workflow-integration-node.hld.md`
- Canvas store: `apps/studio/src/store/workflow-canvas-store.ts`
- Runtime expression contract: `apps/workflow-engine/src/context/expression-resolver.ts`
- Workflow handler step-key source: `apps/workflow-engine/src/handlers/workflow-handler.ts`
