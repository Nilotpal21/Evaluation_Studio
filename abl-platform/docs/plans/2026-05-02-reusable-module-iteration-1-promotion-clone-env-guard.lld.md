# Reusable Module E2E Audit Iteration 1: Promotion Clone Environment Guard

Status: Implemented
Date: 2026-05-02
Jira: ABLP-51

## Audit Finding

Promotion currently has all the data needed to know whether a module snapshot clone is safe:

- Source deployment environment: `Deployment.environment`
- Target deployment environment: promotion request / created deployment
- Frozen module snapshot: `DeploymentModuleSnapshot`
- Target prerequisite validation: `buildDeploymentModuleSnapshot(..., { environment })`

The gap is at the route-to-service boundary. The promotion route attempts `cloneDeploymentModuleSnapshot(...)` before rebuilding, but it does not pass the source and target environment identities into the clone decision. If a dev deployment is promoted to staging/production and the clone succeeds, target-environment env-var/MCP prerequisite validation is skipped.

## Target Design

Snapshot cloning should remain the fast path only when it is semantically safe. A clone is safe when source and target deployment environments are the same or when no environment identity is available for backward-compatible internal callers. Cross-environment promotion must fall back to a rebuild so the target environment re-runs dependency resolution and prerequisite checks.

## Implementation Slices

- [x] Red test: promotion route forwards source/target environment context into snapshot clone.
- [x] Red test: snapshot clone service refuses cross-environment clones before reading snapshot storage.
- [x] Green implementation: add an optional clone options object and guard mismatched environments.
- [x] Green implementation: update promotion route to pass source and target environments.
- [x] Verification: run focused promotion/deployment-build-service tests and runtime package build.

## Future-Ready Contract

- Clone behavior is explicit and auditable rather than implicit in route ordering.
- Rebuild remains the single deploy-time validation path for cross-environment promotions.
- The optional options object leaves room for future clone gates, such as config snapshot generation, release compatibility policy, and module runtime contract version checks.
