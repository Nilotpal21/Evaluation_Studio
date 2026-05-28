# Runtime Config, Git Sync, and Internal Tool Hardening Plan

## Goal

Close the end-to-end gaps where Studio, project-io, Git sync, DB persistence, and runtime execution disagree about project runtime configuration and project-scoped dependencies.

## Design

1. Runtime config imports fail closed before DB writes.
   `project-io` owns a planner-level validation hook for runtime config write operations. Studio supplies the concrete validator so it can use Studio/database models for async model and prompt reference checks. The hook runs during preview/apply planning, which covers direct import and git pull before any adapter writes to Mongo.

2. Git sync paths are canonical at the boundary.
   `GitSyncService` accepts a configured `syncPath`, asks providers for that sub-tree, strips the prefix before import planning, and prefixes canonical project files before push. Conflict detection compares canonical local paths while all remote provider calls receive repository paths.

3. Git pull uses the same project tool validation as direct import.
   The pull route passes `validateProjectToolBindingsForSave` into `prepareCoreImportApplyV2`, preserving runtime-backed `workflow` and `searchai` tool validation parity.

4. Export provisioning advertises auth profiles.
   Provisioning preview scans agent/tool/profile DSL for env vars, connectors, MCP servers, and auth profile references. Export manifests receive `required_auth_profiles` so importers can provision prerequisites before runtime execution.

5. Internal tool execution requires project-scoped service tokens.
   `/api/internal/tools/execute` uses the shared token/body cross-check helper. Tenant-scoped internal tokens cannot select an arbitrary project from the request body.

## Test Slices

1. `project-io` planner rejects invalid runtime config through a validation hook.
2. `project-io` git sync preserves canonical paths while honoring `syncPath` on push and pull.
3. Studio git pull route passes `syncPath` and tool-binding validation into project-io.
4. Export provisioning emits auth profile requirements and referenced-by metadata.
5. Runtime internal tools route rejects missing/mismatched project-scoped service tokens before loading tools.

## Exit Criteria

- Targeted tests for each slice pass.
- Changed files are formatted with Prettier.
- Package builds covering changed TypeScript surfaces pass before final handoff.
