# Testing Guide: Workflow Editor Mode Switching (YAML + Visual Flow)

> **Feature Spec**: [../../features/sub-features/workflow-editor-modes.md](../../features/sub-features/workflow-editor-modes.md)
> **Parent Feature**: [Workflows & Human Tasks](../workflows.md)
> **Status**: PLANNED
> **Last Updated**: 2026-03-24

---

## Current State

No tests exist yet. Feature is in PLANNED status.

---

## Coverage Matrix

| FR    | Requirement                              | Unit    | Integration | E2E     | Manual |
| ----- | ---------------------------------------- | ------- | ----------- | ------- | ------ |
| FR-1  | Mode toggle in CanvasToolbar             | -       | PLANNED     | -       | -      |
| FR-2  | `graphToYaml()` serialization            | PLANNED | -           | -       | -      |
| FR-3  | `yamlToGraph()` parsing + Zod validation | PLANNED | -           | -       | -      |
| FR-4  | Round-trip semantic content preservation | PLANNED | -           | PLANNED | -      |
| FR-5  | Auto-layout for position-less nodes      | -       | PLANNED     | -       | -      |
| FR-6  | Monaco YAML editor rendering             | -       | PLANNED     | -       | -      |
| FR-7  | Live YAML validation with inline errors  | -       | PLANNED     | -       | -      |
| FR-8  | YAML schema version header               | PLANNED | -           | -       | -      |
| FR-9  | Save/discard prompt on mode switch       | -       | PLANNED     | -       | -      |
| FR-10 | Monaco CompletionItemProvider            | -       | PLANNED     | -       | -      |

---

## E2E Test Scenarios

### E2E-1: Workflow created via YAML mode is executable

**Precondition**: Authenticated user with project access, workflow-engine running.

1. `POST /api/projects/:projectId/workflows` — create a workflow with nodes/edges (simulating YAML-mode save).
2. `POST /api/v1/projects/:projectId/workflows/:workflowId/executions` — execute the workflow.
3. `GET /api/v1/projects/:projectId/workflows/:workflowId/executions/:executionId` — verify execution completes successfully.
4. Assert: All node executions have status `completed`, workflow execution status is `completed`.

**Auth context**: JWT with project edit permission. **Isolation check**: Verify workflow is not accessible from another project.

### E2E-2: Workflow saved from YAML mode matches canvas-mode save format

**Precondition**: Authenticated user, existing workflow created via canvas.

1. `GET /api/projects/:projectId/workflows/:id` — fetch workflow (canvas-created).
2. Convert graph to YAML via `graphToYaml()`, then back via `yamlToGraph()`.
3. `PUT /api/projects/:projectId/workflows/:id` — save the round-tripped graph.
4. `GET /api/projects/:projectId/workflows/:id` — fetch again.
5. Assert: All node types, configs, and edge connections match the original (positions may differ).

### E2E-3: YAML validation rejects invalid workflow and returns error

**Precondition**: Authenticated user.

1. Construct a YAML string with an invalid node type (`type: invalid_node`).
2. Attempt `yamlToGraph()` — expect Zod validation error.
3. Assert: Error message includes the invalid field path and expected values.

### E2E-4: Workflow with all 17 node types round-trips through YAML

**Precondition**: Authenticated user.

1. `POST /api/projects/:projectId/workflows` — create workflow with one node of each of the 17 types.
2. `GET /api/projects/:projectId/workflows/:id` — fetch the workflow.
3. Convert to YAML and back.
4. `PUT /api/projects/:projectId/workflows/:id` — save round-tripped graph.
5. Assert: All 17 nodes preserved with correct types and configs.

### E2E-5: Cross-project isolation for YAML-saved workflows

**Precondition**: Two projects (A and B), authenticated user with access to project A only.

1. Create workflow in project A via API (simulating YAML save).
2. `GET /api/projects/:projectB/workflows/:id` — attempt to access from project B.
3. Assert: Returns 404 (not 403).

---

## Integration Test Scenarios

### INT-1: `graphToYaml()` serializes all node types correctly

Test `graphToYaml()` with a graph containing all 17 node types. Assert: each node appears in the YAML output with correct `type`, `name`, and `config`.

### INT-2: `yamlToGraph()` validates and rejects malformed YAML

Test `yamlToGraph()` with: (a) syntactically invalid YAML, (b) valid YAML but missing required fields, (c) valid YAML with unknown node type. Assert: appropriate error for each case.

### INT-3: Round-trip preserves edge sourceHandle for condition nodes

Create a condition node with multiple output handles and edges using `sourceHandle`. Convert graph → YAML → graph. Assert: `sourceHandle` values on edges are preserved.

### INT-4: `yamlToGraph()` generates positions for all nodes

Parse a YAML string (no position data). Assert: all returned nodes have valid `position: { x, y }` values from auto-layout.

### INT-5: Mode switching in Zustand store preserves state

Set `workflow-canvas-store` to canvas mode with nodes. Switch to YAML mode — assert YAML string is generated. Edit YAML. Switch back to canvas — assert graph reflects edits. Assert: position cache preserves original positions for unmodified nodes.

---

## Security & Isolation Tests

| #   | Scenario                                         | Expected Result |
| --- | ------------------------------------------------ | --------------- |
| S-1 | YAML-saved workflow not accessible cross-tenant  | 404             |
| S-2 | YAML-saved workflow not accessible cross-project | 404             |
| S-3 | Unauthenticated YAML save attempt                | 401             |
| S-4 | User without edit permission attempts YAML save  | 403             |

---

## Testing Notes

Priority order for test implementation:

1. **Unit tests** for `graphToYaml()`/`yamlToGraph()` (highest risk — data integrity on round-trip)
2. **Integration tests** for mode switching UX (user-facing, data loss risk)
3. **E2E tests** for save-and-execute flow (confirms YAML-saved workflows are executable)
4. **Security tests** reuse existing workflow isolation test patterns
