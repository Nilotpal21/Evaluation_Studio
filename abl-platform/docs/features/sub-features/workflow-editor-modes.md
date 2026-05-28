# Feature: Workflow Editor Mode Switching (YAML + Visual Flow)

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: PLANNED
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`
**Package(s)**: `apps/studio`, `packages/shared-kernel`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-editor-modes.md](../../testing/sub-features/workflow-editor-modes.md)
**Last Updated**: 2026-03-24

---

## 1. Introduction / Overview

### Problem Statement

Workflow authors building complex automation workflows (conditional branches, parallel paths, loops, human-in-the-loop steps) find the visual canvas editor slow for bulk edits, hard to diff in version control, and lacking the precision of text-based editing. Power users familiar with the ABL agent DSL editor expect a similar code-first authoring option for workflows. Without a text-based alternative:

- Bulk operations (renaming steps, adjusting configs across multiple nodes) require tedious click-by-click editing.
- Workflow definitions stored as JSON graphs with `position: { x, y }` on every node produce noisy git diffs.
- Copy-paste of workflow fragments between projects is impractical without a human-readable serialization.
- There is no parity with the agent authoring experience, which already offers a DSL text editor via `DslEditorOverlay`.

### Goal Statement

Provide workflow authors with a seamless toggle between the existing visual canvas editor (@xyflow/react) and a new YAML text editor (Monaco-based), both operating on the same canonical JSON graph data model. Switching between modes must be lossless for semantic content (node types, configs, edges) while gracefully handling visual-only data (node positions).

### Summary

This sub-feature adds a YAML editor mode to the workflow canvas page. The YAML representation serializes the workflow graph (nodes + edges + env vars + schemas) into a human-readable, diff-friendly format. A bidirectional converter (`graphToYaml` / `yamlToGraph`) in `packages/shared-kernel` enables round-trip conversion. The canonical storage format remains the JSON graph in MongoDB — YAML is a view-layer serialization only. The Monaco editor provides syntax highlighting, live Zod validation, and autocomplete for node types and config keys.

---

## 2. Scope

### Goals

- Provide a toggle in the workflow canvas toolbar to switch between "Visual" and "YAML" editor modes.
- Implement bidirectional conversion between the JSON graph (nodes + edges) and a workflow-specific YAML schema.
- Use Monaco editor (`@monaco-editor/react`, already installed) with YAML syntax highlighting and live validation.
- Preserve semantic content (node types, configs, connections) on round-trip conversion.
- Apply auto-layout (Dagre/ELK) for nodes created in YAML mode that lack canvas positions.
- Validate YAML against Zod schemas with inline error reporting.
- Design the YAML schema to be self-documenting with a format version header for future stability.

### Non-Goals (Out of Scope)

- YAML file import/export (download/upload) — follow-up feature.
- API endpoint for YAML-based workflow creation (`POST /workflows/import-yaml`) — follow-up.
- Custom YAML language server with full IntelliSense — initial release uses basic completion provider.
- Collaborative editing (multi-user YAML editing with conflict resolution).
- YAML as a first-class storage format — canonical format remains JSON graph in MongoDB.
- Reusing the ABL agent `FlowDefinition`/`FlowStep` YAML format — workflow graph is a fundamentally different data model.

---

## 3. User Stories

1. As a **workflow author**, I want to toggle between a visual canvas and a YAML text editor so that I can use whichever editing mode is most efficient for the task at hand.
2. As a **workflow author**, I want the YAML editor to show syntax errors and validation issues in real time so that I catch mistakes before saving.
3. As a **workflow author**, I want to edit multiple node configurations quickly by searching and replacing text in YAML mode so that bulk changes are fast.
4. As a **DevOps engineer**, I want workflow definitions in a human-readable YAML format so that I can review workflow changes in pull requests with clean diffs.
5. As a **workflow author**, I want to switch from YAML back to the visual canvas without losing my changes, and have newly created nodes automatically positioned in a readable layout.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a mode toggle (Visual / YAML) in the `CanvasToolbar` that switches the workflow editor between canvas and YAML views.
2. **FR-2**: The system must implement a `graphToYaml()` function in `packages/shared-kernel` that serializes `WorkflowNode[]` + `WorkflowEdge[]` + env vars + input/output schemas into a YAML string, omitting visual-only fields (`position`) and auto-generated fields (`edge.id`). Field mappings for human readability: `nodeType` → `type`, `source` → `from`, `target` → `to`.
3. **FR-3**: The system must implement a `yamlToGraph()` function in `packages/shared-kernel` that parses a YAML string and produces `WorkflowNode[]` + `WorkflowEdge[]` + env vars + input/output schemas, validated against a Zod schema. Reverse field mappings: `type` → `nodeType`, `from` → `source`, `to` → `target`. Auto-generates `edge.id` (e.g., `edge-{from}-{to}-{index}`), defaults `config` to `{}` when omitted, defaults `sourceHandle` to the source node type's primary output handle (resolved via `getOutputHandles()`, e.g., `"on_success"` for most nodes) when omitted, and assigns `position: { x: 0, y: 0 }` as placeholder (overwritten by auto-layout).
4. **FR-4**: The system must preserve all semantic content (node types, node configs, edge connections, edge labels, env vars, input/output schemas) on a full round-trip (graph → YAML → graph).
5. **FR-5**: The system must assign layout positions to nodes that lack stored positions when switching from YAML to canvas view. Nodes with existing stored positions must retain their exact coordinates. New nodes must receive positions computed by a graph layout algorithm (Dagre or ELK).
6. **FR-6**: The YAML editor must use Monaco (`@monaco-editor/react`) with YAML language mode, `vs-dark` theme, and match the existing `GuardrailYamlEditor` configuration patterns.
7. **FR-7**: The system must validate the YAML content on every change using `js-yaml` parse + Zod schema validation, displaying inline errors in the editor and a summary in the validation panel.
8. **FR-8**: The YAML schema must include a `version` header field (initially `v1`) to support future schema evolution.
9. **FR-9**: The system must prompt the user to save or discard unsaved changes when switching between editor modes.
10. **FR-10**: The system must provide a basic `CompletionItemProvider` for Monaco that suggests node type values and top-level YAML keys.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                              |
| -------------------------- | ------------ | -------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workflow authoring UX improvement                  |
| Agent lifecycle            | SECONDARY    | Workflows can invoke agents; authoring mode change |
| Customer experience        | NONE         | No runtime behavior change                         |
| Integrations / channels    | NONE         | No channel impact                                  |
| Observability / tracing    | NONE         | No observability change                            |
| Governance / controls      | NONE         | No governance impact                               |
| Enterprise / compliance    | NONE         | No compliance impact                               |
| Admin / operator workflows | NONE         | No admin impact                                    |

### Related Feature Integration Matrix

| Related Feature                                          | Relationship Type | Why It Matters                                                                                                 | Key Touchpoints                                                                | Current State                           |
| -------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| [Workflows & Human Tasks](../workflows.md)               | extends           | This sub-feature extends the workflow editor with a second editing mode                                        | `WorkflowCanvasPage`, `CanvasToolbar`, `workflow-canvas-store`, workflow types | Canvas editor is ALPHA, YAML is PLANNED |
| [ABL Language](../abl-language.md)                       | shares data with  | ABL has a DSL text editor (`DslEditorOverlay`) — this feature follows the same dual-mode pattern for workflows | `DslEditorOverlay` (UI pattern), `ABLEditor` (Monaco setup)                    | Agent DSL editor is functional          |
| [Deployments & Versioning](../deployments-versioning.md) | emits into        | YAML-friendly format improves version diffing and review workflows                                             | Workflow version snapshots, diff API                                           | Version API exists                      |

---

## 6. Design Considerations

### Editor Mode Toggle

The `CanvasToolbar` gains a segmented control (Visual | YAML) positioned left of the existing save/run buttons. The toggle follows the same pattern as the agent detail page's "Form / DSL" switch.

### YAML Schema Design

The YAML format is a clean serialization of the workflow graph, designed for human readability:

```yaml
version: v1
name: order-approval-workflow
description: Multi-step order approval with human review

envVars:
  API_BASE_URL: https://api.example.com
  SLACK_CHANNEL: '#approvals'

inputSchema:
  type: object
  properties:
    orderId:
      type: string

nodes:
  - id: start-1
    type: start
    name: Start
    config:
      triggerType: manual

  - id: fetch-order
    type: api
    name: Fetch Order
    config:
      method: GET
      url: '{{env.API_BASE_URL}}/orders/{{input.orderId}}'
      headers:
        Authorization: 'Bearer {{env.API_TOKEN}}'

  - id: check-amount
    type: condition
    name: Check Amount
    config:
      conditions:
        - id: high-value
          label: '> $1000'
          expression: '{{steps.fetch-order.output.body.amount}} > 1000'
        - id: low-value
          label: '<= $1000'
          expression: '{{steps.fetch-order.output.body.amount}} <= 1000'

  - id: human-review
    type: human
    name: Manual Review
    config:
      taskType: approval
      title: 'Review order {{input.orderId}}'
      assignTo: '{{env.REVIEWER_EMAIL}}'

  - id: end-1
    type: end
    name: End

edges:
  - from: start-1
    to: fetch-order
  - from: fetch-order
    to: check-amount
  - from: check-amount
    to: human-review
    sourceHandle: high-value
  - from: check-amount
    to: end-1
    sourceHandle: low-value
  - from: human-review
    to: end-1

outputSchema:
  type: object
  properties:
    approved:
      type: boolean
```

### Mode Switching UX

1. User clicks "YAML" in the toolbar toggle.
2. If canvas has unsaved changes → prompt save/discard.
3. `graphToYaml()` converts current graph to YAML string.
4. Monaco editor renders the YAML with syntax highlighting.
5. User edits in YAML mode.
6. On switching back to "Visual":
   - `yamlToGraph()` parses YAML and validates with Zod.
   - If validation fails → block switch, show errors.
   - If valid → merge positions (existing nodes keep their stored positions, new nodes get auto-layout).
   - Canvas renders the updated graph.

### Auto-Layout Strategy

When switching from YAML to canvas, nodes that were created in YAML (no stored position) need layout:

1. Maintain a position cache in `workflow-canvas-store` keyed by node ID.
2. For nodes with cached positions, restore them.
3. For nodes without positions, apply Dagre top-to-bottom layout on the full graph, only overwriting positions for new nodes.

---

## 7. Technical Considerations

- **Dagre dependency**: Studio already uses `@xyflow/react` which includes layout utilities. If Dagre is not already installed, `dagre` (or `@dagrejs/dagre`) needs to be added to `apps/studio`.
- **Monaco editor bundle**: Already installed (`@monaco-editor/react` v4.6.0). YAML language support is built-in.
- **js-yaml**: Already a dependency in Studio (used by `GuardrailYamlEditor`).
- **Round-trip position preservation**: The position cache must be stored in the Zustand store (`workflow-canvas-store`) and persisted across mode switches within the same editing session. Positions are NOT included in YAML and are NOT persisted to the database separately — they come from the canonical graph when it's next loaded.
- **Optimistic concurrency**: The workflow model uses `_v` for optimistic concurrency. Saving from either editor mode uses the same save path — no special handling needed.

---

## 8. How to Consume

### Studio UI

- **Route**: `/projects/:projectId/workflows/:workflowId` (existing route, enhanced with mode toggle)
- **Entry point**: `CanvasToolbar` segmented control → toggles between `WorkflowCanvas` and `WorkflowYamlEditor`
- **Role expectation**: Any user with workflow edit permissions

### API (Runtime)

No new API endpoints. Both editor modes save via the existing `PUT /api/projects/:projectId/workflows/:id` endpoint with the same `{ nodes, edges, envVars, inputSchema, outputSchema }` payload.

### API (Studio)

No new Studio API routes. The existing `saveWorkflowCanvas()` client function is used by both modes.

### Admin Portal

N/A — no admin-facing changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — this is a Studio-only authoring feature with no runtime or channel impact.

---

## 9. Data Model

### Collections / Tables

No data model changes. The canonical storage format remains unchanged:

```text
Collection: workflows (unchanged)
Fields:
  - nodes: IWorkflowNode[] (position is required — set by canvas drag, or auto-layout for YAML-created nodes)
  - edges: IWorkflowEdge[] (id is required — auto-generated by yamlToGraph() for YAML-created edges)
  - envVars: Record<string, string>
  - inputSchema: object
  - outputSchema: object
  (all other fields unchanged)
```

**Note**: `WorkflowNode.position: { x: number; y: number }` is a required field in the stored model. When saving from YAML mode, `yamlToGraph()` produces placeholder positions (`{ x: 0, y: 0 }`) which are then overwritten by auto-layout before persistence.

### Key Relationships

No new relationships. The YAML editor operates on the same data model as the canvas editor.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                     | Purpose                                       |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| `packages/shared-kernel/src/types/workflow-types.ts`                     | Existing WorkflowNode/WorkflowEdge types      |
| `packages/shared-kernel/src/serialization/workflow-yaml.ts` (new)        | `graphToYaml()` and `yamlToGraph()` functions |
| `packages/shared-kernel/src/serialization/workflow-yaml-schema.ts` (new) | Zod schema for the YAML format                |

### Routes / Handlers

No new routes or handlers.

### UI Components

| File                                                                         | Purpose                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/components/workflows/canvas/panels/CanvasToolbar.tsx`       | Add mode toggle (Visual / YAML)                           |
| `apps/studio/src/components/workflows/canvas/WorkflowYamlEditor.tsx` (new)   | Monaco-based YAML editor component                        |
| `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx`         | Conditionally render canvas or YAML editor based on mode  |
| `apps/studio/src/components/workflows/canvas/useWorkflowAutoLayout.ts` (new) | Dagre/ELK auto-layout hook for YAML-to-canvas transitions |
| `apps/studio/src/components/workflows/canvas/useYamlCompletion.ts` (new)     | Monaco CompletionItemProvider for workflow YAML           |
| `apps/studio/src/store/workflow-canvas-store.ts`                             | Add `editorMode`, position cache, mode switching logic    |

### Jobs / Workers / Background Processes

N/A — no background processing.

### Tests

| File                                                                              | Type        | Coverage Focus                                      |
| --------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `packages/shared-kernel/src/serialization/__tests__/workflow-yaml.test.ts` (new)  | unit        | Round-trip conversion, edge cases, Zod validation   |
| `apps/studio/src/components/workflows/canvas/__tests__/yaml-editor.test.ts` (new) | integration | Mode switching, save/discard prompts, error display |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

No new runtime configuration. The YAML editor is always available — no feature flag needed (the feature is additive and non-breaking).

### DSL / Agent IR / Schema

New Zod schema for the YAML format. Note: YAML uses human-friendly field names that differ from the code model — `graphToYaml()` and `yamlToGraph()` handle the mapping.

**Field mappings (YAML ↔ Code):**
| YAML field | Code field (`WorkflowNode`/`WorkflowEdge`) | Notes |
|------------|---------------------------------------------|-------|
| `type` | `nodeType` | Renamed for YAML readability |
| `from` | `source` | Renamed for YAML readability |
| `to` | `target` | Renamed for YAML readability |
| (omitted) | `id` on edges | Auto-generated by `yamlToGraph()` as `edge-{from}-{to}-{index}` |
| (omitted) | `position` | Auto-generated by auto-layout; visual-only |
| `config` (optional) | `config` (required) | Defaults to `{}` when omitted in YAML |
| `sourceHandle` (optional) | `sourceHandle` (required) | Defaults to source node's primary output handle via `getOutputHandles()` (e.g., `on_success`) when omitted |

```typescript
// YAML uses `type` (maps to `nodeType` in WorkflowNode)
const WorkflowYamlNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    /* all 17 NodeType values */
  ]), // maps to nodeType
  name: z.string().min(1),
  config: z.record(z.unknown()).optional().default({}),
});

// YAML uses `from`/`to` (maps to `source`/`target` in WorkflowEdge)
// Edge `id` is omitted in YAML — auto-generated by yamlToGraph()
const WorkflowYamlEdgeSchema = z.object({
  from: z.string().min(1), // maps to source
  to: z.string().min(1), // maps to target
  sourceHandle: z.string().optional(), // required in code model; yamlToGraph() resolves default via getOutputHandles(sourceNodeType)
  label: z.string().optional(),
});

const WorkflowYamlSchema = z.object({
  version: z.literal('v1'),
  name: z.string().min(1),
  description: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  nodes: z.array(WorkflowYamlNodeSchema).min(1),
  edges: z.array(WorkflowYamlEdgeSchema),
  outputSchema: z.record(z.unknown()).optional(),
});
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Project isolation | No change — saves go through the existing API which enforces `projectId` in the URL and query.       |
| Tenant isolation  | No change — existing middleware enforces `tenantId` scoping.                                         |
| User isolation    | No change — existing auth middleware verifies the user has workflow edit permissions on the project. |

### Security & Compliance

- YAML parsing uses `js-yaml`'s `load()` (safe mode by default in js-yaml v4+) — no `loadAll` or `unsafeLoad`.
- Expression templates (`{{...}}`) in YAML are stored as strings and resolved only at execution time by the existing expression resolver — no evaluation at editor time.
- No new authentication or authorization requirements.

### Performance & Scalability

- `graphToYaml()` conversion: O(n) where n = number of nodes + edges. Expected < 5ms for workflows up to 200 nodes.
- `yamlToGraph()` + Zod validation: O(n). Expected < 10ms for workflows up to 200 nodes.
- Monaco editor loads lazily (dynamic import with `next/dynamic`, matching the `DslEditorOverlay.tsx` lazy-loading pattern for `ABLEditor`).
- Auto-layout (Dagre): O(V + E) — sub-100ms for typical workflow sizes (< 100 nodes).

### Reliability & Failure Modes

- If YAML parsing fails, the error is displayed inline — no data loss, user remains in YAML mode.
- If `yamlToGraph()` validation fails when switching to canvas, the switch is blocked and errors are shown — user can fix or discard.
- Save-or-discard prompt on mode switch prevents accidental data loss.
- The existing `_v` optimistic concurrency on the workflow model prevents stale-write conflicts regardless of editor mode.

### Observability

No new trace events or metrics. The existing workflow save traces cover both modes since the save path is identical.

### Data Lifecycle

No new data lifecycle concerns. YAML is ephemeral (view-layer only) and not persisted.

---

## 13. Delivery Plan / Work Breakdown

1. **YAML serialization layer** (`packages/shared-kernel`)
   1.1 Define the YAML Zod schema (`workflow-yaml-schema.ts`)
   1.2 Implement `graphToYaml()` — serialize nodes/edges/envVars/schemas to YAML string
   1.3 Implement `yamlToGraph()` — parse YAML string, validate, produce graph
   1.4 Write unit tests for round-trip conversion, all 17 node types, edge cases (empty graph, missing optional fields, invalid YAML, Zod validation errors)
   1.5 Export from `packages/shared-kernel` barrel

2. **Auto-layout utility** (`apps/studio`)
   2.1 Add Dagre dependency if not present
   2.2 Implement `useWorkflowAutoLayout` hook — takes nodes/edges, returns positioned nodes
   2.3 Integrate position merge logic (preserve cached, auto-layout new nodes only)

3. **YAML editor component** (`apps/studio`)
   3.1 Create `WorkflowYamlEditor` — Monaco wrapper with YAML mode, validation, error display
   3.2 Create `useYamlCompletion` — CompletionItemProvider for node types and YAML keys
   3.3 Wire live validation (js-yaml parse + Zod) with debounced error display

4. **Mode switching integration** (`apps/studio`)
   4.1 Add `editorMode` state and position cache to `workflow-canvas-store`
   4.2 Add mode toggle to `CanvasToolbar`
   4.3 Update `WorkflowCanvasPage` to conditionally render canvas or YAML editor
   4.4 Implement save/discard prompt on mode switch
   4.5 Wire save from YAML mode through existing `useWorkflowSave` hook

5. **Testing**
   5.1 Mode switching integration tests (save/discard, validation errors, round-trip)
   5.2 Automated E2E tests: save workflow via API from YAML-generated graph, verify round-trip, verify execution
   5.3 Cross-project and auth isolation E2E tests for YAML-saved workflows

---

## 14. Success Metrics

| Metric                                 | Baseline | Target        | How Measured                                           |
| -------------------------------------- | -------- | ------------- | ------------------------------------------------------ |
| Workflow edit time (bulk config edits) | N/A      | 50% faster    | User testing: time to rename 10 steps                  |
| YAML mode adoption                     | 0%       | 20% of saves  | Studio analytics: saves with `editorMode=yaml`         |
| Round-trip data loss incidents         | N/A      | 0             | Bug reports: data lost on mode switch                  |
| YAML validation error rate             | N/A      | < 5% of edits | Studio analytics: validation failures per save attempt |

---

## 15. Open Questions

1. Should the YAML editor support keyboard shortcuts for running/saving that match the canvas editor (Ctrl+S to save, Ctrl+Enter to run)?
2. Should the YAML format include comments (e.g., auto-generated `# AI node` category headers) for readability, and if so, should they survive round-trip?
3. Should the editor mode preference be persisted per-user (localStorage) or per-workflow (stored in the workflow model)?
4. Should the auto-layout algorithm be Dagre (simpler, already common in @xyflow ecosystem) or ELK (more sophisticated layered layouts)?
5. When a workflow has complex parallel/conditional branches, should the YAML format use nesting (harder to read for large workflows) or flat lists with explicit edge declarations (current design)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Auto-layout may not match hand-positioned canvas layouts, potentially confusing users switching from YAML to canvas        | Medium   | Open   |
| GAP-002 | YAML comments are not preserved on round-trip (js-yaml discards comments on parse)                                         | Low      | Open   |
| GAP-003 | No YAML import/export (file download/upload) in initial release                                                            | Low      | Open   |
| GAP-004 | CompletionItemProvider is basic (node types, top-level keys only) — no deep config key suggestions per node type initially | Medium   | Open   |
| GAP-005 | Dagre/ELK dependency not yet confirmed in Studio — may need to be added                                                    | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                               | Coverage Type | Status     | Test File / Note                             |
| --- | ------------------------------------------------------------------------------------------------------ | ------------- | ---------- | -------------------------------------------- |
| 1   | Round-trip: graph → YAML → graph preserves all 17 node types                                           | unit          | NOT TESTED | `shared-kernel/.../workflow-yaml.test.ts`    |
| 2   | Round-trip: edges with sourceHandle preserved, default applied when omitted                            | unit          | NOT TESTED | `shared-kernel/.../workflow-yaml.test.ts`    |
| 3   | YAML validation rejects invalid node types                                                             | unit          | NOT TESTED | `shared-kernel/.../workflow-yaml.test.ts`    |
| 4   | YAML validation rejects missing required fields (version, name, nodes)                                 | unit          | NOT TESTED | `shared-kernel/.../workflow-yaml.test.ts`    |
| 5   | Field mapping: `nodeType`↔`type`, `source`↔`from`, `target`↔`to`, edge id auto-gen                     | unit          | NOT TESTED | `shared-kernel/.../workflow-yaml.test.ts`    |
| 6   | Mode toggle switches between canvas and YAML editor                                                    | integration   | NOT TESTED | `studio/.../yaml-editor.test.ts`             |
| 7   | Save/discard prompt appears when switching with unsaved changes                                        | integration   | NOT TESTED | `studio/.../yaml-editor.test.ts`             |
| 8   | Auto-layout positions new nodes without affecting existing positions                                   | integration   | NOT TESTED | `studio/.../yaml-editor.test.ts`             |
| 9   | YAML editor shows inline validation errors for invalid YAML                                            | integration   | NOT TESTED | `studio/.../yaml-editor.test.ts`             |
| 10  | Position cache in Zustand store preserves coordinates across mode switches                             | integration   | NOT TESTED | `studio/.../yaml-editor.test.ts`             |
| 11  | Save from YAML mode via `PUT /api/projects/:projectId/workflows/:id` (JWT auth) persists correct graph | e2e           | NOT TESTED | Real HTTP: PUT, verify nodes/edges in GET    |
| 12  | Workflow created via YAML-generated graph is executable via workflow-engine                            | e2e           | NOT TESTED | Real HTTP: POST execute → GET verify status  |
| 13  | Cross-project isolation: YAML-saved workflow not accessible from another project                       | e2e           | NOT TESTED | Real HTTP: GET from wrong projectId → 404    |
| 14  | Unauthenticated save attempt returns 401                                                               | e2e           | NOT TESTED | Real HTTP: PUT without JWT → 401             |
| 15  | Round-trip all 17 node types via API: create, save YAML-generated graph, reload, verify                | e2e           | NOT TESTED | Real HTTP: POST create, PUT save, GET verify |

### Testing Notes

Unit tests for the serialization layer (`graphToYaml`/`yamlToGraph`) are the highest priority — they must cover all 17 node types, field name mappings (`nodeType`↔`type`, `source`↔`from`, `target`↔`to`), edge ID auto-generation, and validation error paths. Integration tests for the mode switching UX are second priority. E2E tests must exercise real HTTP API endpoints with JWT auth context and verify tenant/project isolation (cross-project access returns 404, not 403).

> Full testing details: [../../testing/sub-features/workflow-editor-modes.md](../../testing/sub-features/workflow-editor-modes.md)

---

## 18. References

- Parent feature spec: [Workflows & Human Tasks](../workflows.md) — **Note**: the parent spec lists "Visual workflow builder/designer UI" as out of scope, but the canvas editor has since been implemented. That out-of-scope item is stale.
- Existing dual-mode pattern: `apps/studio/src/components/agent-detail/DslEditorOverlay.tsx`
- Existing YAML editor: `apps/studio/src/components/guardrails/GuardrailYamlEditor.tsx`
- Shared workflow types: `packages/shared-kernel/src/types/workflow-types.ts` — **Note**: source comment says "16 node types" but the `NodeType` union has 17 values. The comment is stale.
- Workflow canvas store: `apps/studio/src/store/workflow-canvas-store.ts`
- Canvas-to-steps converter: `apps/workflow-engine/src/handlers/canvas-to-steps.ts`
- ABL YAML parser (agent DSL, not workflows): `packages/core/src/parser/yaml-parser.ts`
