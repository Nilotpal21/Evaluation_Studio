# ABLP-976 Git Integration Data Flow Audit

## Scope

Audited the cross-boundary Git integration values touched by this change:

- `authProfileId`
- `credentials.type`
- `syncConfig.conflictStrategy`
- `tenantId`
- `payload.isRelevant`
- Git operation lock state
- Default Git export/import layer names

## Propagation Matrix

| Value                         | UI  | API Boundary | Persistence | Lifecycle Consumers | Tests |
| ----------------------------- | --- | ------------ | ----------- | ------------------- | ----- |
| `authProfileId`               | Yes | Yes          | Yes         | Yes                 | Yes   |
| `credentials.type`            | Yes | Yes          | Yes         | Yes                 | Yes   |
| `syncConfig.conflictStrategy` | Yes | Yes          | Yes         | Yes                 | Yes   |
| `tenantId`                    | N/A | Yes          | Yes         | Yes                 | Yes   |
| `payload.isRelevant`          | N/A | Yes          | N/A         | Yes                 | Yes   |
| Git operation lock state      | N/A | Yes          | N/A         | Yes                 | Yes   |
| Default layer names           | N/A | Yes          | N/A         | Yes                 | Yes   |

## Findings

- `authProfileId` now flows from the setup dialog to the create/update route and into push, pull, promote, webhook, and credential resolution.
- `credentials.type` is normalized from `pat` to `token` before persistence, matching the database enum and project-io credential contract.
- UI conflict values `ours` and `theirs` are normalized to `local_wins` and `remote_wins` before persistence.
- `GitSyncHistory` now persists `tenantId`; history create and query paths include tenant scope.
- Bitbucket webhook relevance now flows from provider parsing through the webhook route instead of being recomputed from empty changed files.
- Mutating Git operations are coordinated by project/tenant; non-mutating reads remain lock-free.
- Default export layer names are accepted by the direct-apply preview path.

## Residual Follow-Ups

- SSH auth profiles are intentionally excluded from the Git integration contract until provider credential resolution and Git provider operations support SSH material end to end.
- Non-core object families need deeper object-by-object apply verification beyond preview acceptance.
- DB-backed Playwright sentinels should run in an environment with `DATABASE_URL` and `ABLP976_GIT_E2E=1` when stateful E2E coverage is required.
