# Reusable Module Studio -> DB -> Import -> DSL -> Runtime Hardening

**Status**: IN PROGRESS
**Date**: 2026-05-02
**Related Feature**: [docs/features/reusable-agent-modules.md](../features/reusable-agent-modules.md)

## 1. Design Contract

Reusable modules must behave as one coherent lifecycle, not a set of loosely
coupled partial implementations. The target contract is:

1. Studio publish must emit a release artifact whose tool payloads are already
   executable runtime definitions, not just raw DSL blobs.
2. Module contract extraction must distinguish deploy-time auth-profile
   requirements from config-templated auth values so deploy preflight does not
   reject valid releases.
3. Consumer `configOverrides` must affect the mounted module behavior seen by
   the runtime, with override scope limited to the importing dependency.
4. Collision protection must be consistent across preview, confirm import, and
   deployment build for both mounted agents and mounted tools.
5. Regression coverage must exercise a real reusable-module execution path:
   published release -> imported dependency -> deployment snapshot -> session
   execution.

## 2. Decisions

| Decision                                                                 | Rationale                                                                                                                        | Alternative Rejected                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Persist materialized tool definitions inside the module release artifact | Keeps deployment-time resolution deterministic and avoids re-deriving runtime bindings from raw DSL blobs                        | Recompiling module tools from raw artifact DSL during every deployment reintroduces drift and misses publish-time validation |
| Normalize auth requirements at extraction time                           | The contract should describe what the consumer must provide, not leak raw DSL syntax into deploy-time validation                 | Continuing to store raw `AUTH:` payload strings makes deploy-time auth lookup depend on authoring syntax                     |
| Apply module config overrides only during module mounting                | Overrides are consumer-scoped and must not mutate source project artifacts or consumer-local non-module agents                   | Writing merged values back to source releases or shared project config would break isolation                                 |
| Fail collision checks at every boundary                                  | Preview-only collision safety is not a real contract because clients can skip preview and local symbols can change before deploy | Trusting preview as the only enforcement point leaves deploy-time collisions unblocked                                       |
| Upgrade the E2E helper to build realistic release artifacts              | Current tests prove storage and activation, but not release-builder fidelity or mounted execution correctness                    | Keeping placeholder IR/raw artifacts preserves blind spots around materialization and config substitution                    |

## 3. Slice Plan

### Slice 1: Publish-Time Contract and Tool Artifact Normalization

**Goal**: Release artifacts carry executable tool definitions and normalized
auth requirements.

**Files**

- `packages/project-io/src/export/env-var-scanner.ts`
- `packages/project-io/src/module-release/module-contract.ts`
- `packages/project-io/src/module-release/build-module-release.ts`
- `packages/database/src/models/module-release.model.ts`
- `packages/project-io/src/__tests__/env-var-scanner.test.ts`
- `packages/project-io/src/__tests__/module-contract.test.ts`
- `packages/project-io/src/__tests__/module-release-builder.test.ts`

**Test Lock**

- Auth extraction tests prove `auth_profile_ref profile-name` is normalized to
  `profile-name`.
- Auth extraction tests prove `{{config.X}}` auth values are not emitted as
  required auth profiles.
- Release-builder tests prove artifact tools contain executable runtime fields
  needed by mounted execution.

### Slice 2: Deploy-Time Module Materialization and Config Override Application

**Goal**: Mounted agents and tools resolve consumer-scoped config variables and
config overrides before snapshot storage, while preserving runtime-only
fields like `auth_profile_ref`.

**Files**

- `apps/runtime/src/services/modules/deployment-build-service.ts`
- `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`
- `apps/runtime/src/services/modules/__tests__/contract-auth-validator.test.ts`

**Test Lock**

- Snapshot-build tests prove materialized tool definitions survive into mounted
  tools with real bindings.
- Snapshot-build tests prove config overrides are applied to mounted module
  agents and tools.
- Auth-preflight tests prove config-templated auth values do not trigger false
  missing-profile failures.

### Slice 3: Collision Enforcement Parity

**Goal**: The same mounted-symbol collision rules apply during preview,
confirm-import, and deployment creation.

**Files**

- `apps/studio/src/app/api/projects/[id]/module-dependencies/route.ts`
- `apps/runtime/src/routes/deployments.ts`
- `apps/studio/src/__tests__/api-routes/api-module-dependencies.test.ts`

**Test Lock**

- Confirm-import route tests prove mounted tool and agent collisions are
  rejected even if preview is skipped.
- Deployment tests prove local project tool names participate in
  `existingSymbols` collision detection.

### Slice 4: Realistic End-to-End Module Execution Regression

**Goal**: A reusable module release built through the real release-builder path
can be imported into two consumers and produce different runtime behavior based
on dependency-scoped config overrides.

**Files**

- `apps/runtime/src/__tests__/helpers/module-e2e-bootstrap.ts`
- `apps/runtime/src/__tests__/tools-deployment/module-preview.e2e.test.ts`
- `apps/runtime/src/__tests__/tools-deployment/module-runtime-isolation.e2e.test.ts`

**Test Lock**

- Publish helper uses the real release-builder path instead of placeholder tool
  payloads.
- E2E runtime test proves a consumer session executes an imported module agent
  that calls an imported module tool.
- Isolation E2E proves two consumer projects importing the same release with
  different `configOverrides` observe different execution results.

## 4. Propagation Matrix

| Concern                  | Studio Publish | DB Release           | Import Confirm        | Deployment Build                 | Runtime Resolve                     | Session Execution     |
| ------------------------ | -------------- | -------------------- | --------------------- | -------------------------------- | ----------------------------------- | --------------------- |
| Tool executable binding  | materialized   | stored in artifact   | copied via dependency | mounted                          | merged into resolvedTools           | callable              |
| Auth profile requirement | normalized     | stored in contract   | visible in snapshot   | preflighted                      | auth middleware consumes tool field | resolved at call time |
| `configOverrides`        | validated      | stored on dependency | persisted             | merged with consumer config vars | mounted values already resolved     | behavior changes      |
| Symbol collisions        | previewed      | N/A                  | enforced              | enforced                         | N/A                                 | N/A                   |

## 5. Acceptance Criteria

- [ ] Module release artifacts store executable tool definitions, not only raw
      tool DSL blobs.
- [ ] `auth_profile_ref profile-name` is stored as `profile-name` in module
      contract auth requirements.
- [ ] `{{config.X}}` auth references no longer become false required auth
      profile names.
- [ ] Mounted module agents and tools observe consumer `configOverrides` during
      deployment snapshot creation.
- [ ] Confirm import rejects mounted-symbol collisions without relying on a
      prior preview call.
- [ ] Deployment build blocks collisions against existing local project tools.
- [ ] At least one E2E regression executes a published/imported module agent
      calling a published/imported module tool through the runtime.

## 6. Future Slice

**Canonical Module Materializer**

Once these fixes land, the next consolidation step is a single shared
materializer that accepts project-tool documents plus consumer config context
and returns:

- release-artifact tool entries
- contract auth/config requirements
- deployment-ready mounted tool definitions

That future service would remove duplicated tool-definition assembly logic
between Studio tool test paths, publish-time release building, and module
deployment build.
