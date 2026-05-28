# Unified Review: Reusable Agent Modules

**Documents reviewed:**

- `docs/specs/reusable-agent-modules-phase-plan.hld.md` (canonical HLD)
- `docs/features/reusable-agent-modules.md` (feature doc)
- `docs/testing/reusable-agent-modules.md` (test guide)

**Review date:** 2026-03-21
**Review agents:** Architecture (LLD reviewer), Codebase Explorer, Security, Test Plan, Consistency
**Detailed architecture review:** `docs/reviews/reusable-agent-modules-arch-review.md`

---

## Verdict: APPROVED — READY FOR LLD

The HLD is a strong, well-structured design with correct Phase 1 boundaries. All 35+ referenced codebase files exist and match the HLD's descriptions. The architecture correctly reuses existing platform patterns and avoids known anti-patterns.

**Original findings: 3 Critical, 10 High, 15 Medium, 4 Low**

### Post-Review Resolution (2026-03-21)

All three documents were updated based on review findings and design decisions:

| Decision                             | Resolution                                                                                                            | Updated In       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Module project deletion              | Soft-delete/archive; releases remain resolvable for existing deployments                                              | HLD              |
| Permission role mapping              | OWNER: all 4, EDITOR: read+import, VIEWER: read only; `module:import` distinguished from `project:import`             | HLD, Feature doc |
| Test guide sync                      | All 26 regression risks, 15 E2E scenarios, full integration test surface now aligned with HLD IDs                     | Test guide       |
| `Project.kind` migration             | Schema-level default, null treated as `application`, no backfill script                                               | HLD              |
| Snapshot size enforcement            | 8 MB uncompressed limit + gzip compression                                                                            | HLD, Feature doc |
| Secret scanning                      | Structural (reject non-templated auth config) + pattern-based (base64, URL keys, PEM)                                 | HLD              |
| `configOverrides` limits             | 50 keys max, 1 KB/value, validated against contract, secrets rejected                                                 | HLD, Feature doc |
| Concurrency control                  | `dependencyVersion` counter + Redis distributed lock during build                                                     | HLD, Feature doc |
| `moduleVisibility='private'`         | All module project members (not just owner)                                                                           | HLD, Feature doc |
| `releaseNotes` field                 | Added to `ModuleRelease` entity                                                                                       | HLD, Feature doc |
| `deployment_module_snapshots` index  | Fixed to `{ tenantId: 1, deploymentId: 1 }`                                                                           | HLD, Feature doc |
| `module:promote` vs `module:publish` | Keep combined under `module:publish` for Phase 1                                                                      | HLD              |
| New test scenarios                   | 5 new unit tests (P1-U17–U21), 2 new E2E (P1-E14–E15), 2 new regressions (P1-R27–R28)                                 | HLD, Test guide  |
| Feature doc gaps                     | Added missing key files, permissions table, type shapes, conservative limits, audit actions, config overrides section | Feature doc      |

**Remaining items for LLD (not doc-level):** Feature flag name/tier mapping, Studio-side feature resolution, E2E test bootstrap architecture, exhaustive IR field list for alias rewriter, i18n namespace, SWR invalidation patterns.

---

## Critical Findings (3)

### CRIT-1: Cascade delete has zero awareness of module entities

**Source:** Architecture + Security reviewers

`packages/database/src/cascade/cascade-delete.ts` handles 20+ entity types but has no mention of the 4 new collections. Two distinct cascade paths are needed:

- **Deleting a module project:** cascade `ModuleRelease`, `ModuleEnvironmentPointer`, and `DeploymentModuleSnapshot` where `moduleProjectId` matches; also delete or block `ProjectModuleDependency` where `moduleProjectId` matches (other projects' deps on this module)
- **Deleting a consumer project:** cascade `ProjectModuleDependency` where `projectId` matches, and `DeploymentModuleSnapshot` where `projectId` matches

`deleteTenant()` also needs the same treatment.

**Action:** LLD must specify both cascade paths with explicit ordering. Add `DeploymentModuleSnapshot` before `Deployment`, `ProjectModuleDependency` before `Project`.

### CRIT-2: Permission role mapping not specified

**Source:** Architecture reviewer

The 4 new permissions (`module:read`, `module:manage`, `module:publish`, `module:import`) lack role-to-permission mappings. Also, `module:import` may collide semantically with the existing `project:import`.

**Action:** LLD must specify which roles (OWNER, EDITOR, VIEWER) get which module permissions by default, and clarify the distinction between `project:import` and `module:import`.

### CRIT-3: Test guide covers less than half the HLD test surface

**Source:** Consistency + Test Plan reviewers

| Category                 | HLD count | Test guide count | Gap        |
| ------------------------ | --------- | ---------------- | ---------- |
| Regression risks         | 26        | 10               | 16 missing |
| Integration tests        | 15        | 5                | 10 missing |
| E2E scenarios (detailed) | 13        | 5                | 8 missing  |
| Unit tests               | 16        | ~10              | 6 missing  |

Additionally, the test guide renumbers E2E scenario IDs, creating cross-reference ambiguity (test guide "P1-E04" = HLD "P1-E05", test guide "P1-E05" = HLD "P1-E12").

**Action:** Sync the test guide with the HLD. Use identical IDs or provide an explicit mapping table. Add all missing scenarios.

---

## High Findings (10)

### HIGH-1: `Project.kind` migration strategy unspecified

Adding a required `kind` field to existing projects needs either a backfill migration or schema-level `default: 'application'` with graceful null handling.

**Action:** Specify in LLD. Recommend schema default + treat null as `'application'`.

### HIGH-2: `deployment_module_snapshots` unique index lacks `tenantId`

The index is `{ deploymentId: 1 }` alone. Any query using `findOne({ deploymentId })` without `tenantId` violates the platform isolation invariant.

**Action:** Change to `{ tenantId: 1, deploymentId: 1 }` and mandate `tenantId` in all queries.

### HIGH-3: Snapshot document size risk (MongoDB 16MB limit)

`DeploymentModuleSnapshot` stores full `AgentIR` objects. A module with 50 agents and 100 tools could produce multi-megabyte documents.

**Action:** LLD must specify byte-size validation at creation time and compression strategy. The 250-symbol cap helps but byte-size enforcement is also needed.

### HIGH-4: Alias rewriting scope is broader than listed

The HLD lists routing, delegate, and fan-out targets but misses: guard conditions, completion detection references, tool section references within agent DSL, and delegate-to targets in reasoning paths.

**Action:** LLD must provide an exhaustive list of IR fields requiring rewriting. Recommend the alias rewriter walks the entire AgentIR tree.

### HIGH-5: Publish-time secret scanning has pattern gaps

Pattern-based scanning will miss: base64-encoded secrets, URL-embedded keys, PEM-encoded private keys, and obfuscated strings. The HLD's intent is correct but the coverage is inherently incomplete.

**Action:** Supplement pattern scanning with structural rules: require all HTTP tool auth to use `auth_profile_ref` or template indirection. Reject any tool with inline literal values in auth config fields.

### HIGH-6: Name-based auth profile resolution allows silent bind to unintended profile

If a consumer forgets to create a project-scoped profile, a tenant-level profile with the same name could bind silently. The fallback chain in `auth-profile-resolver.ts` resolves project-scoped first, then tenant-scoped.

**Action:** During import prerequisite validation, warn if the resolved profile is tenant-scoped rather than project-scoped. Include resolution scope in deploy preflight metadata.

### HIGH-7: No optimistic concurrency between dependency edits and deployment builds

A concurrent dependency removal and deployment build could produce an inconsistent snapshot. No mechanism is specified.

**Action:** Add a `dependencyVersion` counter on consumer projects that increments on every dependency mutation. Deployment build must verify the version hasn't changed before persisting. Alternatively, use a Redis distributed lock.

### HIGH-8: Publish deduplication must use insert+catch-E11000, not check-then-write

If the publish handler reads first and inserts second, a TOCTOU race exists.

**Action:** Mandate `insertOne` / `Model.create` with `MongoServerError` code 11000 handling for 409 responses. Test P1-R17 must verify with parallel requests.

### HIGH-9: Feature flag name, plan-tier mapping, and Studio resolution not specified

The HLD says to reuse `feature-gate.ts` but does not specify the flag name, which tiers include it, or how Studio (Next.js, not Express) reads the flag.

**Action:** LLD must specify all three.

### HIGH-10: `configOverrides` validation and secret-prevention unspecified

The field is `Record<string, string>` but there's no enforcement preventing secret values in plaintext, no validation against the module contract, and no max size.

**Action:** LLD must specify schema, validation rules, max size (recommend 50 keys, 1KB per value), and mandate validation against the module contract's declared non-secret config slots.

---

## Medium Findings (15)

| ID     | Finding                                                                                                                                                | Source            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| MED-1  | `moduleVisibility='private'` scope undefined — does it mean `ownerId` only or all module project members?                                              | Architecture      |
| MED-2  | `sourceHash` computation method unspecified (algorithm, what it covers, key ordering)                                                                  | Architecture      |
| MED-3  | Audit action names need adding to `AuditActions` constant; also missing `MODULE_ENABLED`, `MODULE_DISABLED`, `MODULE_DELETE_BLOCKED`                   | Architecture      |
| MED-4  | Express route ordering risk for any new runtime routes under `/deployments/`                                                                           | Architecture      |
| MED-5  | Module contract should reuse `ProjectManifestV2.required_auth_profiles` shape, not invent new                                                          | Architecture      |
| MED-6  | No i18n strategy for 4 new Studio components                                                                                                           | Architecture      |
| MED-7  | SWR cache invalidation not specified for module mutations                                                                                              | Architecture      |
| MED-8  | `snapshot-service.ts` is specifically a _variable_ snapshot service, not a general snapshot pattern — naming is slightly misleading in HLD             | Codebase Explorer |
| MED-9  | Pointer move between import preview and save can cause silent version drift                                                                            | Security          |
| MED-10 | Orphaned `DeploymentModuleSnapshot` records possible on partial build failure — need pending/active state or cleanup job                               | Security          |
| MED-11 | `module:promote` should be separate from `module:publish`, especially for production promotions                                                        | Security          |
| MED-12 | Indirect privilege escalation through module publish + environment selector promotion                                                                  | Security          |
| MED-13 | Feature gate fails open (`next()` on error) — module gate should fail closed                                                                           | Security          |
| MED-14 | Missing E2E test for AC17 (session rehydration provenance) — only unit-tested                                                                          | Test Plan         |
| MED-15 | Module E2E bootstrap helper (`module-e2e-bootstrap.ts`) architecture decision undocumented — runtime E2E tests need Studio-owned publish/import routes | Test Plan         |

---

## Low Findings (4)

| ID    | Finding                                                                                               | Source       |
| ----- | ----------------------------------------------------------------------------------------------------- | ------------ |
| LOW-1 | `Project.kind` should use Mongoose `enum` validation for future extensibility                         | Architecture |
| LOW-2 | `entryAgentName` is nullable — must validate non-null before allowing module preview                  | Architecture |
| LOW-3 | HLD UX mentions `releaseNotes` in publish form but `ModuleRelease` entity has no `releaseNotes` field | Consistency  |
| LOW-4 | Feature doc omits data flow diagram, rollout sequence, and operational metrics from HLD               | Consistency  |

---

## Codebase Verification: All Clear

All 35 files referenced in the HLD as "existing foundation" or "files to update" were verified to exist with accurate descriptions. Key confirmations:

- **No module entities exist anywhere** — confirmed zero references to `ModuleRelease`, `ModuleEnvironmentPointer`, `ProjectModuleDependency`, or `DeploymentModuleSnapshot` in the database layer
- **No `kind` field on Project** — confirmed in both the DB model and Zustand store
- **No `module:*` permissions** — confirmed in `permissions.ts`
- **Cascade delete has no module awareness** — confirmed
- **`variableNamespaceIds` confirmed present** in `resolve-tool-implementations.ts` at lines 70, 116, 464, 477, 564 — stripping is necessary

---

## Feature Doc Gaps

The feature doc (`docs/features/reusable-agent-modules.md`) is broadly accurate but omits:

1. **Key files:** `module-publish-safety.ts`, `deployment-build-service.ts`, `module-dependency-service.ts`
2. **Permission names:** The 4 `module:*` permissions are not enumerated
3. **Type definitions:** `ModuleReleaseArtifact` and `DeploymentModuleSnapshot` type shapes not shown
4. **Hard decisions:** The 11 Phase 1 design trade-offs are not surfaced as a coherent set
5. **Conservative limits:** 5 deps per project, 250 symbols per snapshot not stated
6. **Audit action names:** `module_published`, `module_promoted`, etc. not listed

**Action:** Update the feature doc with these additions before implementation begins.

---

## Missing Test Scenarios

Beyond the coverage gaps in CRIT-3, the following scenarios are absent from both documents:

| Scenario                                               | Recommended test location          |
| ------------------------------------------------------ | ---------------------------------- |
| Module with zero agents — publish rejection            | `module-release-builder.test.ts`   |
| Module project kind downgrade while dependencies exist | `api-module-routes.test.ts`        |
| 5-dependency cap and 250-symbol cap enforcement        | `deployment-build-service.test.ts` |
| Circular handoff references within a module            | `module-alias-rewriter.test.ts`    |
| Config override key naming conflicts                   | `api-module-dependencies.test.ts`  |
| Alias with special characters or reserved names        | `api-module-dependencies.test.ts`  |
| Unassigned environment pointer resolution failure      | `module-selector.test.ts`          |
| Concurrent deployment builds with modules              | `module-concurrency.e2e.test.ts`   |

---

## Recommendations for Next Steps

### Before LLD writing

1. Fix the test guide: sync IDs, add all 26 regression risks, all 13 E2E scenarios, all 15 integration tests
2. Update the feature doc with missing key files, permissions, type shapes, and limits
3. Add `releaseNotes` field to `ModuleRelease` entity or remove from the publish UX description

### During LLD writing

4. Specify cascade delete paths (two-path: module project vs consumer project)
5. Specify role-to-permission mappings for all 4 module permissions
6. Specify `Project.kind` migration strategy (recommend schema default + null handling)
7. Specify snapshot size enforcement, hash computation, and compression strategy
8. Specify the exhaustive list of IR fields that the alias rewriter must cover
9. Specify feature flag name, tier mapping, and Studio-side resolution
10. Specify `configOverrides` schema, validation, and max size
11. Specify module E2E test bootstrap architecture (how runtime tests exercise Studio-owned routes)
12. Add the 8 missing test scenarios listed above

### Design strengths to preserve

- Immutability-first: release-once, resolve-at-deploy
- Consumer-project-scoped catalog inheriting tenant isolation
- Snapshot stored in its own collection, separate from Deployment
- Config-variable indirection rather than a new binding DSL
- No transitive dependencies in Phase 1
- Feature-gated rollout with kill switch
