# SDLC Log: Workflows Feature Spec (Phase 1)

**Date**: 2026-03-23
**Phase**: Feature Spec
**Feature**: Workflows & Human Tasks (#48)

## Summary

Generated feature spec for the Workflows & Human Tasks feature based on comprehensive codebase analysis.

## Sources Analyzed

- `packages/shared-kernel/src/types/workflow-types.ts` - 9 step type interfaces, WorkflowContext, events
- `packages/shared/src/types/workflow-schemas.ts` - Zod validation schemas for all step types
- `packages/database/src/models/workflow.model.ts` - Workflow Mongoose model with 12 step types
- `packages/database/src/models/workflow-execution.model.ts` - Execution tracking model
- `packages/database/src/models/human-task.model.ts` - Unified human task model with discriminated source
- `packages/compiler/src/platform/runtimes/workflow-runtime.ts` - WorkflowRuntime class (1111 LOC)
- `apps/workflow-engine/src/index.ts` - Workflow engine entry point with all service wiring
- `apps/workflow-engine/src/handlers/workflow-handler.ts` - Core execution logic (1014 LOC)
- `apps/workflow-engine/src/handlers/step-dispatcher.ts` - Step type routing (198 LOC)
- `apps/workflow-engine/src/executors/human-task-executor.ts` - HITL executor
- `apps/workflow-engine/src/persistence/human-task-store.ts` - MongoDB task store
- `apps/workflow-engine/src/routes/human-task-resolution.ts` - Task resolution API
- `apps/workflow-engine/src/context/expression-resolver.ts` - Template expression resolver
- `apps/studio/src/api/human-tasks.ts` - Studio API client
- `apps/studio/src/hooks/useHumanTasks.ts` - SWR hooks with polling

## Key Findings

1. **Extensive implementation exists**: 12 step executors, Restate integration, MongoDB persistence, Studio UI hooks
2. **36 unit tests** in workflow-engine but **zero E2E tests** through HTTP API
3. **Workflow CRUD routes missing** from workflow-engine -- only execution/trigger/connection routes found
4. **InMemory stores** in compiler's WorkflowRuntime lack size/TTL/eviction (platform invariant violation)
5. **Console logging** used in workflow-handler.ts instead of createLogger

## Artifact

- `docs/features/workflows.md` - 30 FRs, 8 NFRs, 7 user stories, 10 identified gaps
