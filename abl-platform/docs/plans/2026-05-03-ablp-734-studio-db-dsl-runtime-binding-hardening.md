# ABLP-734 Studio to Runtime Tool Binding Hardening

## Goal

Close the remaining Studio -> DB -> DSL -> runtime gaps for workflow and SearchAI tools by validating bindings at every persistence and execution boundary, including cached runtime IR and AI-assisted tool creation paths.

## Design Principles

- Treat workflow and SearchAI bindings as live references, not static DSL strings.
- Fail closed at save, import, version, runtime-load, and Studio test boundaries.
- Keep type-specific binding checks centralized through shared validators.
- Prefer runtime-backed execution for Studio tests when a tool type depends on runtime-only executors.
- Keep module publish checks DSL-native so portability warnings match actual persisted syntax.

## Slice Plan

1. Cached IR revalidation
   - Lock with `packages/shared/src/__tests__/resolve-tool-implementations.test.ts`.
   - Revalidate cached SearchAI/workflow bindings before accepting Redis IR.
   - Exit: deleted or cross-project referenced resources produce compile diagnostics even on cache hit.

2. Studio save service validation
   - Lock with `apps/studio/src/__tests__/tool-creation-service-binding-validation.test.ts`.
   - Run `validateProjectToolBindingsForSave` in shared Studio create/update/raw DSL service paths and ArchAI SearchAI create/update.
   - Exit: invalid workflow/SearchAI DSL never reaches `ProjectTool` persistence.

3. Workflow pinned-version strictness
   - Lock with `packages/shared/src/__tests__/project-tool-validator.workflow.test.ts`.
   - Reject trigger-pinned workflow versions that are missing, soft-deleted, or inactive.
   - Exit: a trigger registration cannot validate unless its pinned version is live.

4. Runtime-backed Studio tool tests
   - Lock with `apps/studio/src/__tests__/tool-test-service.test.ts`.
   - Delegate workflow/SearchAI tool tests to runtime's internal tool execution route.
   - Wire runtime internal execution with SearchAI and Workflow executors.
   - Exit: Studio Test exercises the same runtime loader/executor path used by deployed execution.

5. Module publish portability checks
   - Lock with `packages/project-io/src/__tests__/module-publish-safety.test.ts`.
   - Detect both camelCase metadata and DSL-native snake_case binding keys.
   - Exit: project-scoped SearchAI/workflow bindings always emit portability warnings.

## Verification

- Build before tests per repo policy.
- Run package builds for shared, project-io, runtime, and Studio.
- Run focused Vitest suites for the five lock points.
- If broader package builds fail because of pre-existing dirty-worktree changes, record the blocker and keep focused tests green.
