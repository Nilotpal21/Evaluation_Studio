# Workflow Shared Types — agents.md

Agent learning journal for workflow types and schemas in `packages/shared/src/types/`.

Agents MUST read this file before modifying workflow types. Agents MUST append learnings after completing work.

---

## What This Is

Shared TypeScript types and Zod validation schemas consumed by all workflow layers (engine, runtime, studio). Changes here ripple across the entire system. This does NOT cover DB models (`packages/database/`) or kernel types (`packages/shared-kernel/`).

## Key Files

| File                  | Purpose                                                                                          | Consumers                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `workflow-types.ts`   | Compatibility re-export for core workflow types that now live in `@agent-platform/shared-kernel` | Engine, Runtime, Studio                        |
| `workflow-schemas.ts` | Zod validation schemas — create/update payloads, trigger schemas, execution input                | Runtime (validation), Studio (form validation) |

## Type Hierarchy

```
WorkflowDefinition
  ├── nodes: WorkflowNode[]
  │     ├── id, name, nodeType: NodeType
  │     ├── position: { x, y }
  │     └── config: Record<string, unknown>
  ├── edges: WorkflowEdge[]
  │     ├── id, source, sourceHandle
  │     └── target, label?
  └── metadata (name, description, status, etc.)

WorkflowExecution
  ├── executionId, workflowId, tenantId, projectId
  ├── status: 'running' | 'waiting_human' | 'waiting_approval' | 'waiting_callback' | ...
  ├── nodeExecutions: NodeExecution[]
  │     ├── nodeId, nodeName, nodeType
  │     ├── status, startedAt, completedAt
  │     ├── input, output, error
  │     └── durationMs
  └── input, output, startedAt, completedAt
```

## Related Type Locations

Types are split across packages by concern:

| Package                  | File                                     | What                                           |
| ------------------------ | ---------------------------------------- | ---------------------------------------------- |
| `packages/shared-kernel` | `src/types/workflow-types.ts`            | Source of truth for node/edge/type definitions |
| `packages/shared`        | `src/types/workflow-types.ts`            | Backwards-compatible re-export of kernel types |
| `packages/shared`        | `src/types/workflow-schemas.ts`          | Zod schemas (this package)                     |
| `packages/shared-kernel` | `src/types/index.ts`                     | Kernel exports used by shared/runtime/studio   |
| `packages/database`      | `src/models/workflow.model.ts`           | Mongoose model (DB schema)                     |
| `packages/database`      | `src/models/workflow-execution.model.ts` | Execution Mongoose model                       |
| `packages/database`      | `src/models/workflow-version.model.ts`   | Version Mongoose model                         |
| `packages/database`      | `src/models/workflow-api-key.model.ts`   | API key Mongoose model                         |

## Patterns & Conventions

### Adding a New Node Type

1. Add the node type to `packages/shared-kernel/src/types/workflow-types.ts` (`NodeType` source of truth)
2. Add or update any type-specific config/types exposed through `@agent-platform/shared-kernel`
3. Add the matching Zod schema and validation wiring in `workflow-schemas.ts`
4. Run `pnpm build --filter=@agent-platform/shared-kernel` and `pnpm build --filter=@agent-platform/shared`
5. Then update consumers: engine (executor + step-dispatcher), studio (config panel + sidebar), runtime (validation)

### Zod ID Validation

Use `z.string().min(1)` for ID fields. Our IDs are UUIDs or custom strings — do not use CUID/NANOID/ULID-specific Zod validators. See CLAUDE.md for the full rule.

### Cross-Package Impact

**Any type change here requires rebuilding all consumers:**

```bash
pnpm build --filter=@agent-platform/shared-kernel
pnpm build --filter=@agent-platform/shared
pnpm build --filter=@agent-platform/workflow-engine
pnpm build --filter=@agent-platform/runtime
# Studio picks up via Turbopack hot-reload
```

**Never delete exported types in feature work** — this is additive-only. If a type needs restructuring, update all consumers first, commit that, then modify the type.

## Known Gaps & Gotchas

- **DB model vs TypeScript type divergence** — The Mongoose model in `packages/database` uses `Schema.Types.Mixed` for some fields that have strict TypeScript types here. Runtime validation catches the gap, but be aware the DB layer is more permissive.
- **`nodeExecutions` field naming** — DB stores `nodeId`/`nodeName`/`nodeType`, but the Studio frontend expects `stepId`/`stepName`. Normalization happens in `useWorkflowExecutions` hook in Studio.
- **Engine uses `(step as any).name`** — The `canvas-to-steps.ts` converter attaches `name` to steps, but the `WorkflowStep` type doesn't declare it. This is a known type gap.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work>
-->

## 2026-04-14 — `workflow-types.ts` Here Is Only The Compatibility Layer

**Category**: architecture
**Learning**: `packages/shared/src/types/workflow-types.ts` no longer owns the workflow node and edge definitions; it re-exports them from `@agent-platform/shared-kernel` for backwards compatibility. The schema layer still lives here, so workflow type changes often need coordinated edits in two packages.
**Files**: `packages/shared/src/types/workflow-types.ts`, `packages/shared-kernel/src/types/workflow-types.ts`, `packages/shared/src/types/workflow-schemas.ts`
**Impact**: If a workflow type change seems to compile but still fails validation, check whether the kernel type source and shared schema layer were updated together.

## 2026-04-14 — Status Schemas Need Backward-Compatible Values During Rollouts

**Category**: gotcha
**Learning**: Workflow execution schemas must stay in sync with database status constants, but mixed-version compatibility still matters. `waiting_human` is the newer execution-facing status while legacy values like `waiting_approval` remain in the schema so older executions and staggered deploys keep parsing cleanly.
**Files**: `packages/shared/src/types/workflow-schemas.ts`, `packages/database/src/models/workflow-execution.model.ts`
**Impact**: Renaming or removing workflow statuses requires coordinated updates across database models, shared schemas, runtime normalization, and Studio UI before compatibility values can be dropped.
