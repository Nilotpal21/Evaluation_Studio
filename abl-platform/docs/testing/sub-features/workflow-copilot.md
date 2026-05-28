# Testing Guide: Workflow Copilot — NL-Driven Workflow Builder

> **Feature Spec**: [../../features/sub-features/workflow-copilot.md](../../features/sub-features/workflow-copilot.md)
> **Parent Feature**: [Workflows & Human Tasks](../workflows.md)
> **Status**: PLANNED
> **Last Updated**: 2026-03-25

---

## Current State

No tests exist yet. Feature is in PLANNED status.

---

## Coverage Matrix

| FR    | Requirement                              | Unit    | Integration | E2E     | Manual |
| ----- | ---------------------------------------- | ------- | ----------- | ------- | ------ |
| FR-1  | Workflow tools activate on canvas page   | -       | PLANNED     | -       | -      |
| FR-2  | Canvas state injected into LLM context   | PLANNED | -           | -       | -      |
| FR-3  | propose_workflow_changes tool            | PLANNED | PLANNED     | -       | -      |
| FR-4  | Propose-confirm-execute pattern          | -       | PLANNED     | PLANNED | -      |
| FR-5  | execute_workflow_changes tool            | PLANNED | PLANNED     | -       | -      |
| FR-6  | Auto-create checkpoint before execution  | -       | PLANNED     | -       | -      |
| FR-7  | Checkpoint navigation (forward/backward) | -       | PLANNED     | -       | -      |
| FR-8  | Batch workflow creation                  | -       | -           | PLANNED | -      |
| FR-9  | get_canvas_state tool                    | PLANNED | -           | -       | -      |
| FR-10 | Node config Zod schemas                  | PLANNED | -           | -       | -      |
| FR-11 | Per-workflow conversation persistence    | -       | -           | PLANNED | -      |
| FR-12 | Read-only queries without mutations      | -       | PLANNED     | -       | -      |
| FR-13 | Checkpoint auto-generated descriptions   | -       | PLANNED     | -       | -      |
| FR-14 | Auto-layout for batch-created nodes      | -       | PLANNED     | -       | -      |

---

## E2E Test Scenarios

### E2E-1: Batch workflow creation via copilot

**Precondition**: Authenticated user with project access, Arch LLM configured.

1. `POST /api/arch/chat` with `{ message: "Create an order approval workflow", context: { page: "workflows", workflowId: "...", workflowState: { nodes: [], edges: [] } } }` (JWT auth).
2. Assert: Response contains a `propose_workflow_changes` tool call with operations for multiple nodes and edges.
3. Simulate user confirmation (second `POST /api/arch/chat` with confirmation message).
4. Assert: Response contains `execute_workflow_changes` tool call.
5. Verify canvas store has nodes and edges matching the proposal.

### E2E-2: Incremental node addition via copilot

**Precondition**: Existing workflow with start and end nodes.

1. `POST /api/arch/chat` with `{ message: "Add an API call to fetch order details between Start and End", context: { page: "workflows", workflowState: { nodes: [start, end], edges: [start→end] } } }` (JWT auth).
2. Assert: Response proposes add_node (api type) + remove old edge + add new edges.
3. Confirm and verify canvas state.

### E2E-3: Per-workflow conversation persistence

**Precondition**: Authenticated user.

1. Send a copilot message for workflow A via `POST /api/arch/chat`.
2. `POST /api/arch/conversations/save` with key `{projectId}/workflow-{workflowAId}`.
3. `GET /api/arch/conversations/load` with the same key.
4. Assert: Conversation messages restored.
5. Attempt load with different project ID → 404.

### E2E-4: Cross-project isolation

**Precondition**: Two projects (A and B), user with access to project A only.

1. Save copilot conversation for project A's workflow.
2. Attempt to load from project B context → 404 (not 403).

### E2E-5: Unauthenticated copilot request

1. `POST /api/arch/chat` without JWT → 401.

---

## Integration Test Scenarios

### INT-1: Propose-confirm-execute state machine

Test the full lifecycle: send message → LLM returns proposal → state transitions to CONFIRMING → user confirms → state transitions to EXECUTING → mutations applied → state returns to IDLE.

### INT-2: Checkpoint creation and navigation

1. Start with canvas state A (3 nodes).
2. Execute copilot mutation → checkpoint created with state A → canvas becomes state B (4 nodes).
3. Execute another mutation → checkpoint created with state B → canvas becomes state C (5 nodes).
4. Navigate backward → canvas restores state B.
5. Navigate backward again → canvas restores state A.
6. Navigate forward → canvas restores state B.

### INT-3: Checkpoint truncation on new change

1. Create checkpoints: A → B → C.
2. Navigate backward to A.
3. Execute new mutation → checkpoint with state A created → canvas becomes state D.
4. Assert: states B and C are removed from checkpoint stack.

### INT-4: Mutation validation rejects invalid operations

1. Propose add_edge with non-existent source node → validation error.
2. Propose remove_node with non-existent node ID → validation error.
3. Propose add_node with invalid nodeType → Zod validation error.
4. Assert: no canvas state changes on validation failure.

### INT-5: Read-only query does not trigger mutations

1. Send "Explain this workflow" message.
2. Assert: LLM responds with text, no propose_workflow_changes tool call.
3. Assert: Canvas state unchanged, no checkpoint created.

---

## Security & Isolation Tests

| #   | Scenario                                                   | Expected Result          |
| --- | ---------------------------------------------------------- | ------------------------ |
| S-1 | Copilot conversation not accessible cross-tenant           | 404                      |
| S-2 | Copilot conversation not accessible cross-project          | 404                      |
| S-3 | Unauthenticated copilot request                            | 401                      |
| S-4 | execute_workflow_changes not callable without confirmation | Blocked by state machine |

---

## Testing Notes

Priority order for test implementation:

1. **Unit tests** for node config Zod schemas (17 types) and mutation schemas (foundation for valid LLM output)
2. **Unit tests** for tool execution (get_canvas_state accuracy, mutation application correctness)
3. **Integration tests** for checkpoint system (highest data-loss risk)
4. **Integration tests** for propose-confirm-execute lifecycle
5. **E2E tests** for full copilot flow through real HTTP
6. **Security tests** reuse existing Arch conversation isolation patterns
