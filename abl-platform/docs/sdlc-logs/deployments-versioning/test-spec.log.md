# Test Spec Log: deployments-versioning

**Phase:** Test Spec
**Date:** 2026-03-22
**Status:** COMPLETE

## Inputs Read

- Feature spec: `docs/features/deployments-versioning.md`
- Existing test files (11 files) in `apps/runtime/src/__tests__/`
- Test patterns from `deployment-routes.test.ts`, `deployments-authz.test.ts`, `version-routes.test.ts`

## Existing Test Inventory

| Test File                                    | Tests | Pattern                    |
| -------------------------------------------- | ----- | -------------------------- |
| `deployment-routes.test.ts`                  | ~15   | Mocked repos, real Express |
| `deployments-authz.test.ts`                  | ~12   | RBAC matrix                |
| `deployment-promotion.test.ts`               | ~8    | Cross-env promotion        |
| `deployment-pipeline.e2e.test.ts`            | ~5    | Real LLM E2E               |
| `deployment-resolver.test.ts`                | ~6    | Unit                       |
| `version-routes.test.ts`                     | ~20   | Mocked repos, real Express |
| `versions-authz.test.ts`                     | ~10   | RBAC matrix                |
| `workflow-version-routes.test.ts`            | ~12   | Integration                |
| `workflow-version-service.test.ts`           | ~8    | Service-level              |
| `snapshot-service.test.ts`                   | ~10   | Integration                |
| `model-deployment-workflow-manifest.test.ts` | ~3    | Model unit                 |

## Decisions Made

| Decision                                                   | Classification | Rationale                                                                    |
| ---------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| 7 E2E scenarios (exceeds minimum 5)                        | DECIDED        | Feature spans multiple critical flows                                        |
| 7 integration scenarios (exceeds minimum 5)                | DECIDED        | Multiple services need isolated testing                                      |
| Existing mocked-repo tests counted as integration, not E2E | DECIDED        | They mock repos, so don't exercise real middleware chain end-to-end          |
| Settings version lifecycle flagged as top gap              | DECIDED        | Zero test coverage on 4 endpoints                                            |
| Cross-tenant E2E flagged as critical gap                   | DECIDED        | Existing authz tests only verify RBAC, not real tenant isolation at DB level |

## Output

- `docs/testing/deployments-versioning.md` -- Test spec with 7 E2E + 7 integration + 5 unit scenarios
