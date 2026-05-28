# Feature Spec Log: deployments-versioning

**Phase:** Feature Spec
**Date:** 2026-03-22
**Status:** COMPLETE

## Inputs Read

- Codebase exploration of all deployment/versioning models, services, routes, repos, and Studio components
- No prior feature spec existed; generated from code analysis

## Key Files Analyzed

| File                                                                 | Purpose                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/database/src/models/deployment.model.ts`                   | Deployment schema (environments, status lifecycle, manifests)           |
| `packages/database/src/models/agent-version.model.ts`                | Agent version schema (DSL+IR snapshots, lifecycle states)               |
| `packages/database/src/models/workflow-version.model.ts`             | Workflow version schema                                                 |
| `packages/database/src/models/project-settings-version.model.ts`     | Settings version schema                                                 |
| `packages/database/src/models/deployment-variable-snapshot.model.ts` | Variable snapshot schema                                                |
| `apps/runtime/src/services/version-service.ts`                       | Agent version lifecycle (create, promote, diff, dedup)                  |
| `apps/runtime/src/services/workflow-version-service.ts`              | Workflow version lifecycle                                              |
| `apps/runtime/src/services/settings-version-service.ts`              | Settings version lifecycle                                              |
| `apps/runtime/src/services/snapshot-service.ts`                      | Variable snapshot creation + diff                                       |
| `apps/runtime/src/services/preflight-validation-service.ts`          | Pre-deployment diagnostic checks                                        |
| `apps/runtime/src/routes/deployments.ts`                             | Full deployment REST API (create, list, get, retire, rollback, promote) |
| `apps/runtime/src/repos/deployment-repo.ts`                          | Deployment data access layer                                            |
| `apps/studio/src/hooks/useAgentVersions.ts`                          | Studio hook for version management                                      |
| `apps/studio/src/store/version-store.ts`                             | Studio version diff UI state                                            |
| `apps/studio/src/components/deploy/DeployPanel.tsx`                  | Widget/SDK deploy panel (not full lifecycle UI)                         |
| `apps/studio/src/app/api/projects/[id]/git/promote/route.ts`         | Git branch promotion                                                    |

## Decisions Made

| Decision                                          | Classification | Rationale                                                                           |
| ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Status set to ALPHA                               | DECIDED        | Core backend exists but Studio deployment lifecycle UI is missing                   |
| Canary/traffic splitting excluded                 | DECIDED        | No code evidence; listed as future work                                             |
| Focus on existing implementation documentation    | DECIDED        | Feature is substantially built; spec reflects reality                               |
| DeployPanel categorized as widget deployment only | ANSWERED       | Code inspection confirms it handles API keys + embed code, not deployment lifecycle |

## Output

- `docs/features/deployments-versioning.md` -- 18-section feature spec with all code-grounded details
