# Feature: Workflow Copilot — NL-Driven Workflow Builder

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: PLANNED
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`
**Package(s)**: `apps/studio`, `packages/shared-kernel`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-copilot.md](../../testing/sub-features/workflow-copilot.md)
**Last Updated**: 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

Building workflows in the visual canvas editor requires manual node-by-node construction: dragging nodes from the sidebar, configuring each one individually, and manually wiring edges. For complex workflows (10+ nodes with conditions, parallel branches, loops, and human tasks), this process is tedious and error-prone. Users must:

- Know all 17 node types and their configuration schemas upfront.
- Manually position and connect nodes in the correct order.
- Configure each node's settings individually through form panels.
- Mentally translate business requirements into graph topology.
- Start over or manually undo if the initial structure is wrong.

There is no way to describe "what the workflow should do" in natural language and have the system build it. Additionally, there is no undo/redo mechanism — any mistake requires manual reconstruction.

### Goal Statement

Extend the existing Arch AI assistant with workflow-aware tools that enable users to build, modify, and iterate on workflows through natural language conversation. The copilot should understand the current canvas state, propose changes for user confirmation, and maintain a checkpoint history for navigating forward and backward through workflow evolution.

### Summary

This sub-feature extends the Arch AI assistant (`ArchPanel`) with workflow-specific tools activated on the workflow canvas page. Users describe their workflow requirements in the chat panel and the copilot proposes graph mutations (add/remove/connect/configure nodes) following Arch's propose-confirm-execute pattern. A snapshot-based checkpoint system records canvas state before each copilot operation, enabling forward/backward navigation through the workflow's evolution. The copilot uses structured Zod schemas for each node type's config to generate valid configurations. Conversations are persisted per-workflow.

---

## 2. Scope

### Goals

- Extend the Arch AI assistant with workflow-aware tools activated when the user is on the workflow canvas page.
- Support batch workflow creation from a single natural language description (e.g., "Create an order approval workflow with API fetch, amount check, human review, and notification").
- Support incremental NL operations: add node, remove node, connect nodes, update node config, rename node, explain workflow.
- Follow the propose-confirm-execute pattern — all canvas mutations require user confirmation before applying.
- Implement a snapshot-based checkpoint system that auto-captures canvas state before each copilot operation.
- Enable checkpoint navigation (move forward/backward) to undo/redo copilot-driven changes.
- Make the copilot available from workflow creation (empty canvas) through ongoing editing.
- Provide the copilot with structured node config schemas so it generates valid configurations.
- Persist copilot conversations per-workflow using a `contextKey` field on the existing `arch_conversations` model.
- Support read-only queries: "Explain what this workflow does", "What happens if the condition fails?".

### Non-Goals (Out of Scope)

- Voice input — text only for V1.
- Manual-change undo/redo (V1 checkpoints are copilot-triggered only; manual undo is a natural V2 extension).
- A separate copilot UI panel — reuses the existing Arch AI panel.
- Copilot-driven deployment or execution (the copilot builds workflows, it does not run them).
- Custom LLM model selection for the copilot — uses Arch's existing `resolveArchLLMClient()` credential resolution.
- Auto-completion of partial workflows (e.g., "finish this workflow") — the copilot operates on explicit instructions.

---

## 3. User Stories

1. As a **workflow author**, I want to describe a business process in plain English and have the copilot build the workflow graph for me, so that I can create complex workflows without manually dragging and connecting nodes.
2. As a **workflow author**, I want to ask the copilot to add a specific node type (e.g., "add an API call to fetch the order details") and have it propose the node with appropriate configuration, so that I can build incrementally.
3. As a **workflow author**, I want the copilot to understand my existing workflow and make targeted modifications when I say "change the condition threshold to $500" or "add an error handler after the API call", so that editing is as easy as describing changes.
4. As a **workflow author**, I want to undo copilot changes by navigating backward through checkpoints, so that I can recover from mistakes without manually reconstructing the workflow.
5. As a **workflow author**, I want to ask the copilot "explain this workflow" or "what happens if the human reviewer declines?", so that I can understand complex workflows without reading every node config.
6. As a **workflow author**, I want the copilot to be available as soon as I create a new workflow (empty canvas), so that I can start building from a description rather than an empty graph.
7. As a **workflow author**, I want to see a visual preview of proposed changes before they are applied to the canvas, so that I can confirm, reject, or refine the copilot's suggestions.

---

## 4. Functional Requirements

1. **FR-1**: The system must activate workflow-specific tools in the Arch AI panel when the user is on the workflow canvas page. Tool activation adds a `workflows` entry to `PAGE_TO_STAGE` mapping (in `ArchPanel.tsx`) to a workflow-enabled lifecycle stage (e.g., `build`), which causes `stageUsesWorkflow()` to return true and engages the workflow state machine for tool gating via `getToolsForWorkflow()`. Tools are gated by `WorkflowState`: `get_canvas_state` and `explain_workflow` are available in any state, `propose_workflow_changes` is available in RESPONDING state, and `execute_workflow_changes` is available only in EXECUTING state.
2. **FR-2**: The system must inject the current canvas state (nodes, edges, envVars, inputSchema, outputSchema) into the LLM context on each chat message, so the copilot can reason about the existing workflow graph.
3. **FR-3**: The system must provide a `propose_workflow_changes` tool that proposes a set of canvas mutations (add nodes, remove nodes, add edges, remove edges, update configs) as a structured plan with a human-readable summary.
4. **FR-4**: The system must follow the propose-confirm-execute pattern — canvas mutations are only applied after the user clicks "Confirm". The user can also "Reject" or "Refine" (send follow-up message to adjust the proposal).
5. **FR-5**: The system must provide an `execute_workflow_changes` tool (callable only in EXECUTING state after user confirmation) that applies proposed mutations to the canvas store. All mutations must be validated before any are applied (all-or-nothing). Mutations must be compatible with the `canvas-to-steps.ts` step converter so the resulting workflow is executable.
6. **FR-6**: The system must auto-create a checkpoint (full canvas snapshot) before executing any `execute_workflow_changes` operation. The checkpoint includes `{ nodes, edges, envVars, inputSchema, outputSchema, description }`.
7. **FR-7**: The system must provide checkpoint navigation — a UI control to browse checkpoints and restore any previous state by replacing the canvas store contents via `setWorkflow()`.
8. **FR-8**: The system must support batch workflow creation — given a natural language description, the copilot proposes a complete graph (start node, step nodes, end node, all edges) in a single `propose_workflow_changes` call.
9. **FR-9**: The system must provide a `get_canvas_state` tool that returns the current workflow graph in a structured format the LLM can reason about (node list with types/configs/connections).
10. **FR-10**: The system must define structured Zod schemas for each of the 17 node types' config shapes in `packages/shared-kernel`, and serialize a summary into the copilot's system prompt so the LLM knows valid configuration fields.
11. **FR-11**: The system must persist copilot conversations per-workflow. The existing `arch_conversations` model is keyed by `(userId, projectId)` with a unique compound index. To support per-workflow scoping, add an optional `contextKey` field (e.g., `workflow-{workflowId}`) to the model so multiple conversations can exist per user/project pair. The compound unique index becomes `(userId, projectId, contextKey)`. Existing agent conversations use `contextKey: null` (default) for backwards compatibility.
12. **FR-12**: The system must support read-only queries (explain workflow, describe node behavior) without triggering the propose-confirm-execute cycle — the LLM responds directly without calling mutation tools.
13. **FR-13**: Checkpoints must have auto-generated descriptions derived from the copilot's proposal summary (e.g., "Added API node 'Fetch Order' and connected to Start").
14. **FR-14**: The system must auto-layout newly added nodes using the same layout logic as the YAML editor mode (Dagre/ELK), preserving positions of existing nodes.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                             |
| -------------------------- | ------------ | ------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Workflow authoring acceleration                   |
| Agent lifecycle            | SECONDARY    | Workflows invoke agents; faster workflow creation |
| Customer experience        | NONE         | No runtime behavior change                        |
| Integrations / channels    | NONE         | No channel impact                                 |
| Observability / tracing    | NONE         | No observability change                           |
| Governance / controls      | NONE         | No governance impact                              |
| Enterprise / compliance    | NONE         | No compliance impact                              |
| Admin / operator workflows | NONE         | No admin impact                                   |

### Related Feature Integration Matrix

| Related Feature                                   | Relationship Type | Why It Matters                                                                            | Key Touchpoints                                                      | Current State           |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------- |
| [Workflows & Human Tasks](../workflows.md)        | extends           | Copilot extends the workflow editor with NL-driven authoring                              | `workflow-canvas-store`, node types, config schemas                  | Canvas editor is ALPHA  |
| [Arch AI Assistant](../arch-ai-assistant.md)      | extends           | Copilot is implemented as workflow-specific tools within Arch's existing infrastructure   | `ArchPanel`, `arch-store`, `arch-tools`, `arch-workflow`, `arch-llm` | Arch is STABLE          |
| [Workflow Editor Modes](workflow-editor-modes.md) | shares data with  | Copilot shares the node config Zod schemas and auto-layout utilities with the YAML editor | `workflow-yaml-schema.ts`, auto-layout utility (to be created)       | YAML editor is PLANNED  |
| [Model Hub](../model-hub.md)                      | configured by     | Copilot uses Arch's `resolveArchLLMClient()` which resolves credentials through Model Hub | `arch-llm.ts`, tenant model configuration                            | Model Hub is functional |

**Dependency risk**: The parent [Workflows & Human Tasks](../workflows.md) feature is at ALPHA status with GAP-01 (no E2E tests for workflow execution). Copilot-generated workflows must be compatible with the `canvas-to-steps.ts` converter for execution. This dependency means copilot-generated configs must follow the same shape the step converter expects. Validating this is a testing priority.

---

## 6. Design Considerations

### Copilot Tool Set

The copilot exposes workflow-aware tools through Arch's agentic tool loop:

| Tool                       | Purpose                                                          | State Gate     |
| -------------------------- | ---------------------------------------------------------------- | -------------- |
| `get_canvas_state`         | Read current workflow graph (nodes, edges, configs, connections) | Any            |
| `propose_workflow_changes` | Propose a set of canvas mutations with summary                   | RESPONDING     |
| `execute_workflow_changes` | Apply confirmed mutations to canvas store                        | EXECUTING only |
| `explain_workflow`         | Analyze and explain workflow behavior                            | Any            |

Tools are defined in `apps/studio/src/lib/workflow-copilot-tools.ts` and registered through the existing `getToolsForWorkflow()` dispatch in `arch-tools.ts`.

### Propose-Confirm-Execute Flow

```
User: "Create an order approval workflow"
  ↓
Arch (RESPONDING): calls get_canvas_state → empty graph
  ↓
Arch (RESPONDING): calls propose_workflow_changes with:
  {
    summary: "Create order approval workflow with 5 nodes",
    operations: [
      { op: "add_node", nodeType: "start", name: "Start", config: {...} },
      { op: "add_node", nodeType: "api", name: "FetchOrder", config: {method: "GET", url: "..."} },
      { op: "add_node", nodeType: "condition", name: "CheckAmount", config: {...} },
      { op: "add_node", nodeType: "human", name: "ManualReview", config: {...} },
      { op: "add_node", nodeType: "end", name: "End", config: {} },
      { op: "add_edge", from: "Start", to: "FetchOrder" },
      { op: "add_edge", from: "FetchOrder", to: "CheckAmount" },
      { op: "add_edge", from: "CheckAmount", to: "ManualReview", sourceHandle: "high-value" },
      { op: "add_edge", from: "CheckAmount", to: "End", sourceHandle: "low-value" },
      { op: "add_edge", from: "ManualReview", to: "End" }
    ]
  }
  ↓
Arch (CONFIRMING): Shows proposal in chat with [Confirm] [Reject] [Refine] buttons
  ↓
User clicks [Confirm]
  ↓
Arch (EXECUTING): Auto-creates checkpoint → calls execute_workflow_changes → applies to canvas store
  ↓
Arch (IDLE): Canvas shows the new workflow
```

### Checkpoint System

The checkpoint system is a snapshot stack stored in the workflow canvas Zustand store:

```typescript
interface WorkflowCheckpoint {
  id: string;                    // UUID
  description: string;           // From proposal summary
  timestamp: number;             // Date.now()
  snapshot: {
    nodes: WorkflowNode[];       // From toWorkflowNodes()
    edges: WorkflowEdge[];       // From toWorkflowEdges()
    envVars: Record<string, string>;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  };
}

// In workflow-canvas-store.ts
checkpoints: WorkflowCheckpoint[];
currentCheckpointIndex: number;   // -1 = latest (no checkpoint active)
```

**Navigation:**

- **Undo (←)**: Decrement `currentCheckpointIndex`, restore snapshot via `setWorkflow()`.
- **Redo (→)**: Increment `currentCheckpointIndex`, restore snapshot.
- **New change while viewing old checkpoint**: Truncate forward history (standard undo stack behavior).
- **UI**: Checkpoint timeline strip below the canvas toolbar showing checkpoint descriptions as step indicators.

### Mutation Operations Schema

```typescript
type WorkflowMutation =
  | { op: 'add_node'; nodeType: NodeType; name: string; config: Record<string, unknown> }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'update_node_config'; nodeId: string; config: Record<string, unknown> }
  | { op: 'rename_node'; nodeId: string; name: string }
  | { op: 'add_edge'; from: string; to: string; sourceHandle?: string; label?: string }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'update_env_vars'; envVars: Record<string, string> }
  | { op: 'update_input_schema'; inputSchema: Record<string, unknown> }
  | { op: 'update_output_schema'; outputSchema: Record<string, unknown> };

interface WorkflowProposal {
  summary: string;
  operations: WorkflowMutation[];
}
```

### Node Config Schema Strategy

Define per-node-type Zod schemas in `packages/shared-kernel/src/schemas/workflow-node-configs.ts`:

```typescript
export const ApiNodeConfigSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  body: z.object({ type: z.enum(['json', 'form', 'raw']), content: z.string() }).optional(),
  auth: z.object({ type: z.string(), profileId: z.string() }).optional(),
  timeout: z.number().optional(),
});

export const ConditionNodeConfigSchema = z.object({
  conditions: z.array(z.object({
    id: z.string().min(1),
    label: z.string(),
    field: z.string(),
    operator: z.enum(['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'not_contains', 'is_empty', 'is_not_empty', 'matches_regex']),
    value: z.string(),
  })),
});

// ... schemas for all 17 node types
export const NODE_CONFIG_SCHEMAS: Record<NodeType, z.ZodType> = { ... };
```

These schemas are serialized into the copilot's system prompt as a structured reference, so the LLM knows what fields to populate for each node type.

---

## 7. Technical Considerations

- **Arch extension, not replacement**: The copilot is implemented as additional tools in the existing Arch infrastructure. No new panel, no new store, no new LLM client. This minimizes surface area and reuses proven patterns.
- **System prompt size**: Including all 17 node config schemas in the system prompt adds ~2-3KB. This is within LLM context limits but should use concise schema descriptions (field name, type, description) rather than full Zod source.
- **Concurrent canvas access**: The canvas store is a single Zustand store. The copilot reads from and writes to it on the main thread. No concurrency issues since all operations are synchronous store mutations.
- **Checkpoint memory**: Snapshots are stored in the Zustand store (in-memory). They are lost on page navigation. This is acceptable for V1 — persistent checkpoint history is a V2 enhancement.
- **Auto-layout for batch creation**: When the copilot creates multiple nodes at once, positions are not specified. The `execute_workflow_changes` tool must run auto-layout (Dagre/ELK) on the full graph after all mutations are applied. A shared auto-layout utility should be created or shared with the workflow-editor-modes feature, based on the existing ELK-based `useAutoLayout` pattern in the project canvas.
- **Edge sourceHandle resolution**: When the copilot adds edges, it may omit `sourceHandle`. The execution tool resolves defaults via `getOutputHandles(sourceNodeType)` — same as the YAML editor's `yamlToGraph()`.

---

## 8. How to Consume

### Studio UI

- **Entry point**: Existing Arch AI panel (480px right sidebar), automatically context-switches when user navigates to `/projects/:projectId/workflows/:workflowId`.
- **Checkpoint UI**: Timeline strip in `CanvasToolbar` area showing checkpoint steps with undo/redo navigation.
- **Workflow-specific suggestions**: Quick action chips (e.g., "Build workflow from description", "Add a new step", "Explain this workflow") shown when on the workflow canvas page.
- **Proposal preview**: In the Arch chat, proposed mutations are shown as a structured plan with node types, names, and connections. [Confirm] / [Reject] / [Refine] buttons appear below.

### API (Runtime)

No new runtime API endpoints. The copilot operates entirely in the Studio frontend + Studio BFF (Arch chat route).

### API (Studio)

No new Studio API routes. The copilot reuses `POST /api/arch/chat` with workflow-specific context:

| Method | Path           | Purpose                          |
| ------ | -------------- | -------------------------------- |
| POST   | /api/arch/chat | Existing route, extended context |

The request body includes `workflowState` (current graph) when `context.page === 'workflows'`.

### Admin Portal

N/A — no admin-facing changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — this is a Studio-only authoring feature.

---

## 9. Data Model

### Collections / Tables

```text
Collection: arch_conversations (existing, schema change required)
  Existing unique index: { userId: 1, projectId: 1 }
  New field: contextKey: string | null (default: null)
  New unique index: { userId: 1, projectId: 1, contextKey: 1 }
  For workflow copilot: contextKey = "workflow-{workflowId}"
  For existing agent conversations: contextKey = null (backwards compatible)
  Other fields: same as existing (messages[], context, metadata)

Collection: workflows (unchanged)
  Fields: unchanged — copilot writes via same canvas store → API save path
```

**Migration**: The index change from `(userId, projectId)` to `(userId, projectId, contextKey)` requires dropping the old index and creating the new one. Existing documents get `contextKey: null` by default. This is a backwards-compatible additive change.

Checkpoints are stored in-memory (Zustand store) and are NOT persisted to the database in V1.

### Key Relationships

- Copilot conversation 1:1 Workflow (via `contextKey: "workflow-{workflowId}"` in `arch_conversations`)
- Copilot mutations → Canvas store → Workflow API save → workflows collection (existing flow)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                | Purpose                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/studio/src/lib/workflow-copilot-tools.ts` (new)               | Tool definitions: get_canvas_state, propose/execute changes |
| `apps/studio/src/lib/workflow-copilot-context.ts` (new)             | Build workflow context for LLM system prompt                |
| `packages/shared-kernel/src/schemas/workflow-node-configs.ts` (new) | Zod schemas for all 17 node type configs                    |
| `packages/shared-kernel/src/schemas/workflow-mutations.ts` (new)    | Zod schemas for WorkflowMutation and WorkflowProposal       |

### Routes / Handlers

| File                                         | Purpose                                         |
| -------------------------------------------- | ----------------------------------------------- |
| `apps/studio/src/app/api/arch/chat/route.ts` | Existing route — extended with workflow context |
| `apps/studio/src/services/arch.service.ts`   | Existing service — add workflow tool dispatch   |

### UI Components

| File                                                                              | Purpose                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/components/arch/ArchPanel.tsx`                                   | Existing — add workflow suggestion chips             |
| `apps/studio/src/components/arch/ArchChat.tsx`                                    | Existing — render WorkflowProposal messages          |
| `apps/studio/src/components/arch/WorkflowProposalMessage.tsx` (new)               | Render proposed mutations with confirm/reject/refine |
| `apps/studio/src/components/workflows/canvas/panels/CheckpointTimeline.tsx` (new) | Checkpoint navigation strip below toolbar            |
| `apps/studio/src/store/workflow-canvas-store.ts`                                  | Add checkpoints[], checkpoint navigation actions     |
| `apps/studio/src/store/arch-store.ts`                                             | Add workflow conversation key pattern                |

### Jobs / Workers / Background Processes

N/A — no background processing.

### Tests

| File                                                                               | Type        | Coverage Focus                                      |
| ---------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `packages/shared-kernel/src/schemas/__tests__/workflow-node-configs.test.ts` (new) | unit        | Config schema validation for all 17 node types      |
| `packages/shared-kernel/src/schemas/__tests__/workflow-mutations.test.ts` (new)    | unit        | Mutation schema validation, proposal structure      |
| `apps/studio/src/lib/__tests__/workflow-copilot-tools.test.ts` (new)               | unit        | Tool execution: canvas reads, mutation application  |
| `apps/studio/src/components/workflows/canvas/__tests__/checkpoint.test.ts` (new)   | integration | Checkpoint create, navigate, truncate on new change |

---

## 11. Configuration

### Environment Variables

No new environment variables. The copilot uses Arch's existing env vars:

| Variable          | Default                    | Description                   |
| ----------------- | -------------------------- | ----------------------------- |
| `ARCH_CHAT_MODEL` | `claude-sonnet-4-20250514` | LLM model for chat (existing) |

### Runtime Configuration

No new runtime configuration. The copilot inherits Arch's workspace settings (LLM credentials, model selection) configured in the Arch Settings page.

### DSL / Agent IR / Schema

New schemas in `packages/shared-kernel`:

**WorkflowMutation schema** (used by copilot tools):

```typescript
const WorkflowMutationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    nodeType: NodeTypeEnum,
    name: z.string().min(1),
    config: z.record(z.unknown()),
  }),
  z.object({ op: z.literal('remove_node'), nodeId: z.string().min(1) }),
  z.object({
    op: z.literal('update_node_config'),
    nodeId: z.string().min(1),
    config: z.record(z.unknown()),
  }),
  z.object({ op: z.literal('rename_node'), nodeId: z.string().min(1), name: z.string().min(1) }),
  z.object({
    op: z.literal('add_edge'),
    from: z.string().min(1),
    to: z.string().min(1),
    sourceHandle: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({ op: z.literal('remove_edge'), edgeId: z.string().min(1) }),
  z.object({ op: z.literal('update_env_vars'), envVars: z.record(z.string()) }),
  z.object({ op: z.literal('update_input_schema'), inputSchema: z.record(z.unknown()) }),
  z.object({ op: z.literal('update_output_schema'), outputSchema: z.record(z.unknown()) }),
]);

const WorkflowProposalSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(WorkflowMutationSchema).min(1),
});
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Copilot conversations scoped by `(userId, projectId, contextKey)` in `arch_conversations`. Canvas mutations save through existing project-scoped API. |
| Tenant isolation  | LLM resolution via `resolveArchLLMClient(tenantId)` — scoped to tenant. Conversation persistence via tenant-scoped Arch APIs.                         |
| User isolation    | Arch conversations are per-user (stored in tenant-scoped context). Canvas mutations go through auth middleware on save.                               |

### Security & Compliance

- The copilot does NOT execute workflows — it only builds graph structure. No runtime data exposure.
- LLM prompts include the workflow graph (node names, configs, expressions). Configs may contain API URLs and expression templates but NOT secrets (connection credentials are stored separately and referenced by ID).
- The propose-confirm-execute pattern ensures no canvas mutation happens without explicit user consent.
- Tool execution is gated by the workflow state machine — `execute_workflow_changes` is callable only in EXECUTING state.

### Performance & Scalability

- LLM call latency: ~2-5s for proposals (typical for Claude Sonnet). Streaming responses display incrementally.
- Checkpoint snapshot creation: O(n) serialization via `toWorkflowNodes()` / `toWorkflowEdges()`. Expected < 5ms for workflows up to 200 nodes.
- Checkpoint memory: ~10KB per snapshot, 50 checkpoints = ~500KB. Negligible for in-memory storage.
- Auto-layout after batch creation: Same Dagre/ELK performance as YAML editor (sub-100ms for < 100 nodes).
- System prompt with node schemas: ~2-3KB overhead per LLM call. Within token limits.

### Reliability & Failure Modes

- If LLM call fails, the error is shown in the Arch chat — no canvas state is modified.
- If `execute_workflow_changes` partially fails (e.g., edge references non-existent node), the checkpoint enables full rollback. The execution should validate all mutations before applying any (all-or-nothing).
- If the user navigates away from the workflow page, in-memory checkpoints are lost. The canvas state itself is persisted via the normal save flow.
- Conversation persistence follows Arch's existing compaction (MAX_PERSISTED_MESSAGES=30) to prevent unbounded growth.

### Observability

No new trace events. The copilot reuses Arch's existing logging in `arch.service.ts` (LLM calls, tool executions, errors).

### Data Lifecycle

- Checkpoints: In-memory only, lost on page navigation. No persistence, no TTL needed.
- Conversations: Scoped by `(userId, projectId, contextKey)` in `arch_conversations`, compacted to 30 messages, subject to Arch's existing conversation cleanup (MAX_PERSISTED_CONVERSATIONS=10 per project).

---

## 13. Delivery Plan / Work Breakdown

1. **Node config schemas** (`packages/shared-kernel`)
   1.1 Define Zod schemas for all 17 node type configs based on existing config component fields
   1.2 Define WorkflowMutation and WorkflowProposal Zod schemas
   1.3 Create schema summary serializer for LLM system prompt injection
   1.4 Write unit tests for all schemas
   1.5 Export from `packages/shared-kernel` barrel

2. **Copilot tools** (`apps/studio`)
   2.1 Create `workflow-copilot-tools.ts` with tool definitions (get_canvas_state, propose_workflow_changes, execute_workflow_changes, explain_workflow)
   2.2 Create `workflow-copilot-context.ts` to build workflow-aware system prompt (graph state + schema reference)
   2.3 Implement tool execution: canvas read, mutation validation, mutation application via canvas store actions
   2.4 Integrate tools into `arch-tools.ts` via `getToolsForWorkflow()` dispatch for `page === 'workflows'`
   2.5 Wire tool results through `arch.service.ts` processChat workflow path

3. **Checkpoint system** (`apps/studio`)
   3.1 Add checkpoint state to `workflow-canvas-store` (checkpoints[], currentCheckpointIndex, createCheckpoint(), restoreCheckpoint(), navigateCheckpoint())
   3.2 Auto-create checkpoint in `execute_workflow_changes` before applying mutations
   3.3 Implement forward/backward checkpoint navigation with stack truncation on new changes
   3.4 Write integration tests for checkpoint create, navigate, truncate

4. **UI integration** (`apps/studio`)
   4.1 Create `WorkflowProposalMessage.tsx` to render proposed mutations in Arch chat
   4.2 Add workflow-specific suggestion chips to `ArchPanel` when on workflows page
   4.3 Create `CheckpointTimeline.tsx` navigation strip component
   4.4 Mount checkpoint timeline in `CanvasToolbar` area
   4.5 Wire confirm/reject/refine buttons to arch-store workflow state transitions
   4.6 Extend `arch-store.ts` conversation key pattern for workflow-scoped conversations

5. **Auto-layout integration**
   5.1 Apply auto-layout (Dagre/ELK) after batch node creation in `execute_workflow_changes`
   5.2 Create or share an auto-layout utility based on the existing ELK-based `useAutoLayout` pattern from the project canvas

6. **Testing**
   6.1 Unit tests for node config Zod schemas (all 17 types, valid + invalid inputs)
   6.2 Unit tests for mutation schema validation (all 9 operation types)
   6.3 Unit tests for tool execution (canvas state reads, mutation application, validation rejection)
   6.4 Integration tests for checkpoint lifecycle (create, navigate, truncate, all-or-nothing rollback)
   6.5 Integration tests for propose-confirm-execute state machine transitions
   6.6 Automated E2E tests: POST /api/arch/chat with JWT, workflow context, verify response structure
   6.7 Automated E2E tests: cross-project and cross-tenant conversation isolation (404 on wrong scope)
   6.8 Automated E2E test: copilot-generated workflow is executable via canvas-to-steps → workflow-engine

---

## 14. Success Metrics

| Metric                                    | Baseline | Target               | How Measured                                              |
| ----------------------------------------- | -------- | -------------------- | --------------------------------------------------------- |
| Workflow creation time (10-node workflow) | N/A      | 70% faster           | User testing: time from empty canvas to complete workflow |
| Copilot-assisted workflow creation rate   | 0%       | 30% of new workflows | Studio analytics: workflows with copilot conversation     |
| Checkpoint usage (undo) per session       | N/A      | > 0.5 per session    | Studio analytics: checkpoint navigations                  |
| Proposal acceptance rate                  | N/A      | > 60%                | Studio analytics: confirmed / (confirmed + rejected)      |
| Copilot error rate (invalid mutations)    | N/A      | < 5%                 | Studio analytics: mutation validation failures            |

---

## 15. Open Questions

1. Should the copilot support multi-turn refinement of a single proposal (e.g., "also add error handling" while a proposal is pending), or should each refinement create a new proposal?
2. Should checkpoints be visualized as a linear timeline or a branching tree (when the user undoes and then makes different changes)?
3. Should the copilot have access to the project's connections and auth profiles to auto-fill API node configs with real connection IDs?
4. Should the node config schemas be generated from the React config components (code-gen) or manually maintained as a separate source of truth?
5. How should the copilot handle stub node types (`browser`, `doc_search`, `doc_intelligence`) that are not yet implemented?
6. Should checkpoint history survive page refresh (persist to localStorage or workflow model)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                     | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Node config schemas don't exist yet — must be reverse-engineered from config components (Record<string, unknown> in code)       | High     | Open   |
| GAP-002 | No undo/redo for manual canvas changes (V1 only covers copilot-triggered checkpoints)                                           | Medium   | Open   |
| GAP-003 | Checkpoint history is in-memory only — lost on page navigation                                                                  | Medium   | Open   |
| GAP-004 | LLM may generate invalid configs for complex node types (condition expressions, loop iterators)                                 | Medium   | Open   |
| GAP-005 | System prompt with all 17 node schemas may be large; may need to selectively inject only relevant schemas based on conversation | Low      | Open   |
| GAP-006 | Copilot does not know about the project's existing connections/auth profiles — cannot auto-fill connectionId/profileId fields   | Medium   | Open   |
| GAP-007 | Batch workflow creation auto-layout may produce suboptimal visual layouts for complex branching workflows                       | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                     | Coverage Type | Status     | Test File / Note                                  |
| --- | -------------------------------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------- |
| 1   | Node config Zod schemas validate correct configs for all 17 node types                       | unit          | NOT TESTED | `shared-kernel/.../workflow-node-configs.test.ts` |
| 2   | Node config Zod schemas reject invalid configs (wrong types, missing required fields)        | unit          | NOT TESTED | `shared-kernel/.../workflow-node-configs.test.ts` |
| 3   | WorkflowMutation discriminated union validates all 9 operation types                         | unit          | NOT TESTED | `shared-kernel/.../workflow-mutations.test.ts`    |
| 4   | `get_canvas_state` tool returns correct graph representation                                 | unit          | NOT TESTED | `studio/.../workflow-copilot-tools.test.ts`       |
| 5   | `execute_workflow_changes` applies add_node mutations to canvas store                        | unit          | NOT TESTED | `studio/.../workflow-copilot-tools.test.ts`       |
| 6   | Checkpoint auto-created before mutation execution                                            | integration   | NOT TESTED | `studio/.../checkpoint.test.ts`                   |
| 7   | Checkpoint navigation restores previous canvas state                                         | integration   | NOT TESTED | `studio/.../checkpoint.test.ts`                   |
| 8   | Forward checkpoint history truncated when new change made after undo                         | integration   | NOT TESTED | `studio/.../checkpoint.test.ts`                   |
| 9   | Propose-confirm-execute cycle: proposal shown, confirm applies, reject discards              | integration   | NOT TESTED | `studio/.../workflow-copilot-tools.test.ts`       |
| 10  | Mutation validation rejects add_edge with non-existent source node                           | integration   | NOT TESTED | `studio/.../workflow-copilot-tools.test.ts`       |
| 11  | `POST /api/arch/chat` with workflow context returns tool-call response with canvas mutations | e2e           | NOT TESTED | Real HTTP: POST with JWT, verify response shape   |
| 12  | Batch workflow creation: description → proposal → confirm → canvas has correct nodes/edges   | e2e           | NOT TESTED | Real HTTP + canvas store verification             |
| 13  | Copilot conversation persisted and restored per-workflow                                     | e2e           | NOT TESTED | Real HTTP: save conversation, reload, verify      |
| 14  | Cross-project isolation: copilot conversation not accessible from another project            | e2e           | NOT TESTED | Real HTTP: GET from wrong projectId → 404         |
| 15  | Unauthenticated copilot request returns 401                                                  | e2e           | NOT TESTED | Real HTTP: POST without JWT → 401                 |
| 16  | Cross-tenant isolation: copilot conversation not accessible from another tenant              | e2e           | NOT TESTED | Real HTTP: GET with different tenant JWT → 404    |

### Testing Notes

Unit tests for node config schemas and mutation schemas are highest priority — they are the foundation for LLM-generated configurations. Integration tests for the checkpoint system are second priority (data loss risk). E2E tests for the propose-confirm-execute flow validate the full copilot pipeline through real HTTP calls to the Arch chat endpoint. All E2E tests must use JWT auth context and verify tenant/project isolation.

> Full testing details: [../../testing/sub-features/workflow-copilot.md](../../testing/sub-features/workflow-copilot.md)

---

## 18. References

- Parent feature spec: [Workflows & Human Tasks](../workflows.md)
- Sibling feature spec: [Workflow Editor Modes](workflow-editor-modes.md) — shares node config schemas and auto-layout
- Arch AI Assistant: [Arch AI Assistant](../arch-ai-assistant.md)
- Arch store: `apps/studio/src/store/arch-store.ts`
- Arch tools: `apps/studio/src/lib/arch-tools.ts`
- Arch workflow state machine: `apps/studio/src/lib/arch-workflow.ts`
- Arch LLM resolution: `apps/studio/src/lib/arch-llm.ts`
- Arch types: `apps/studio/src/types/arch.ts`
- Workflow canvas store: `apps/studio/src/store/workflow-canvas-store.ts`
- Arch conversation model: `packages/database/src/models/arch-conversation.model.ts` — unique index `(userId, projectId)` must be extended to `(userId, projectId, contextKey)`
- Canvas-to-steps converter: `apps/workflow-engine/src/handlers/canvas-to-steps.ts` — copilot-generated configs must be compatible
- Shared workflow types: `packages/shared-kernel/src/types/workflow-types.ts` — **Note**: source comment says "16 node types" but the `NodeType` union has 17 values. The comment is stale.
