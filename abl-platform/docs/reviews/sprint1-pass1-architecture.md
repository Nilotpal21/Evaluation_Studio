# Sprint 1 — Pass 1: Architecture Review

**Reviewer:** LLD Architecture Reviewer
**Date:** 2026-03-22
**Scope:** Sprint 1 implementation files (data models, cascade delete, release builder, contract extractor, selector, publish safety, shared types, barrel exports, tests)
**Spec:** `docs/specs/reusable-agent-modules-phase1.lld.md` Sections 1-3, 11

---

## Summary: APPROVED_WITH_RESERVATIONS

Sprint 1 implementation is architecturally sound. All 4 new models, cascade delete logic, release builder pipeline, contract extractor, selector, and publish safety validator match the LLD spec with high fidelity. The issues below are mostly MEDIUM/LOW — no blocking CRITICAL issues found.

---

## Findings

### ARCH-P1-001 — MEDIUM — ExtractContractFn type does not match extractModuleContract signature

**File:** `packages/project-io/src/module-release/build-module-release.ts:44-48`
**File:** `packages/project-io/src/module-release/module-contract.ts:58-61`

The builder defines `ExtractContractFn` as taking `{ agents: Record<string, Record<string, unknown>> }` (compiled IR keyed by name), but the actual `extractModuleContract` function takes `(agents: ContractAgentInput[], tools: ContractToolInput[])` where `ContractAgentInput` needs `{ name, dslContent, description? }`.

The caller must write an adapter to bridge these signatures. Since the builder already has access to `input.agents` (DSL content), the adapter would need to merge compiled IR agent names with DSL content. The DI pattern is correct, but the type mismatch means the builder's `ExtractContractFn` type and the actual extractor cannot be used together without a non-trivial adapter.

**Impact:** The contract extractor scans **DSL text** for env vars, auth profiles, connectors, etc. It does NOT use compiled IR. The builder's `ExtractContractFn` type misleadingly passes compiled IR when the extractor needs DSL content. The test in `module-release-builder.test.ts:332-343` shows the mock extractor ignoring the compiled IR argument — this masks the real adapter complexity.

**Fix:** Either:
(a) Change `ExtractContractFn` params to include both `agents: Record<string, string>` (DSL) and `compiledAgents: Record<string, Record<string, unknown>>` (IR), since the extractor needs DSL text but future extractors may also need IR, or
(b) Accept the current DI design as intentional and document in the barrel export that callers must compose the adapter.

**Severity rationale:** MEDIUM — the code works via DI injection; the mismatch is a type ergonomics issue that will cause confusion for Sprint 2 implementors wiring the publish route.

---

### ARCH-P1-002 — MEDIUM — ValidatePublishSafetyFn return type inconsistent with validatePublishSafety

**File:** `packages/project-io/src/module-release/build-module-release.ts:54-58`
**File:** `packages/project-io/src/module-release/module-publish-safety.ts:34-37`

The builder's `ValidatePublishSafetyFn` type returns `{ errors: string[]; warnings: string[] }`. The actual `validatePublishSafety` function returns `PublishSafetyResult = { safe: boolean; issues: PublishSafetyIssue[] }` where `PublishSafetyIssue` has `severity`, `code`, `source`, `message`.

The caller must write an adapter that:

1. Calls `validatePublishSafety` to get `PublishSafetyResult`
2. Splits `issues` into errors (severity = 'blocking') and warnings (severity = 'warning')
3. Maps each `PublishSafetyIssue.message` to a string

This is another DI impedance mismatch. The builder's simpler `{errors, warnings}` return type discards the structured `code` and `source` fields from `PublishSafetyIssue`.

**Fix:** Same as ARCH-P1-001 — either align the types or document the adapter requirement. The structured issue data (`code`, `source`) is valuable for the publish API response (LLD Section 7.5 specifies returning "errors and warnings"). Consider updating the builder's return type to carry structured issues.

**Severity rationale:** MEDIUM — functional via adapter, but loses valuable structured error data.

---

### ARCH-P1-003 — LOW — ModuleRelease.compiledIR typed as Record<string, unknown>

**File:** `packages/database/src/models/module-release.model.ts:54`

The `IModuleRelease.compiledIR` is typed as `Record<string, unknown>`. The LLD specifies `compiledIR: Record<string, AgentIR>`. The implementation stores it as `Schema.Types.Mixed` in MongoDB (correct), but the TypeScript interface loses the `AgentIR` structure.

**Impact:** Downstream consumers (deployment resolver, runtime merge) will need to cast `compiledIR` values to `AgentIR`. This creates a gap where the type system cannot verify the IR structure at compile time.

**Fix:** Import `AgentIR` from `@abl/compiler` and type as `Record<string, AgentIR>` or at minimum `Record<string, Record<string, unknown>>` to match the builder's output type. Note: `AgentIR` may create a heavy import dependency in the database package — if so, `Record<string, Record<string, unknown>>` is an acceptable compromise.

**Severity rationale:** LOW — Mongoose stores `Mixed` regardless; this is a TypeScript DX issue.

---

### ARCH-P1-004 — MEDIUM — Cascade delete: deleteProject does NOT check tenantId on the Project.find query

**File:** `packages/database/src/cascade/cascade-delete.ts:216-218`

```ts
const projectDocs = await Project.find({ _id: projectId }, { tenantId: 1, kind: 1 }).lean();
```

The initial Project lookup uses `{ _id: projectId }` without `tenantId`. If `tenantId` is provided as a parameter, it is only used downstream for module entity deletion — but the Project itself is found without tenant scoping. This is a pre-existing pattern (the original `deleteProject` never had tenantId), but the LLD explicitly says: "When `tenantId` is not provided, resolve it from the Project document."

When `tenantId` IS provided, it should be used in the Project lookup for defense-in-depth: `{ _id: projectId, tenantId }`.

**Impact:** If an attacker can invoke `deleteProject(victimProjectId, attackerTenantId)`, the function finds the project (wrong tenant), then uses `attackerTenantId` for module deletions — which would harmlessly delete zero records. But the standard cascade (line 274+) uses `projectId` without tenantId, so Session/Agent/Deployment deletions proceed. This is a pre-existing gap, not introduced by this PR.

**Fix:** When `tenantId` is provided, include it in the Project query: `Project.find({ _id: projectId, tenantId }, ...)`. If the project is not found, abort early. This is defense-in-depth for the new tenantId parameter.

**Severity rationale:** MEDIUM — pre-existing pattern, but the new `tenantId` parameter creates an expectation of tenant scoping that isn't fully enforced.

---

### ARCH-P1-005 — LOW — Cascade delete tests use vi.mock (unit test, not integration)

**File:** `packages/database/src/__tests__/cascade-delete-modules.test.ts`

The cascade delete tests mock all models via `vi.mock('../models/index.js')`. This is appropriate for a unit test — it verifies the cascade orchestration logic (call order, arguments, error shape). However:

1. It does NOT verify that the actual model imports resolve correctly (the barrel export wiring).
2. It cannot catch Mongoose query API mismatches (e.g., if `.find().lean()` chain changes).

The LLD's E2E test plan (Section 12) covers this gap for later sprints. For Sprint 1, the unit test is sufficient.

**Impact:** Low — the model tests (4 separate test files) verify actual Mongoose behavior. The cascade test verifies orchestration. Together they provide adequate Sprint 1 coverage.

**Fix:** No action needed for Sprint 1. Sprint 4 E2E tests will cover the full integration path.

---

### ARCH-P1-006 — LOW — module-contract.ts does not use compiled IR

**File:** `packages/project-io/src/module-release/module-contract.ts`

The contract extractor scans DSL text using regex patterns (`CONNECTOR:`, `MCP_SERVER:`, `{{config.KEY}}`, `{{env.KEY}}`, `{{secrets.KEY}}`, `AUTH:`). It does NOT use compiled IR at all.

The LLD Section 3.2 says the contract extractor "reuses existing `auth-requirement-collector.ts` for auth profile extraction and `manifest-generator.ts` patterns." The implementation correctly reuses the env-var-scanner utilities (`extractEnvVarReferences`, `extractSecretReferences`, `extractAuthProfileReferences` from `../export/env-var-scanner.js`).

However, regex-based extraction from raw DSL text has blind spots:

- Auth profiles declared in compiled IR but not via `AUTH:` directive syntax
- Config keys in computed expressions
- Connectors declared via non-standard syntax

**Impact:** Low for Phase 1 — the regex patterns match the current DSL conventions. When YAML format expands, the regex patterns may need updating.

**Fix:** No action for Sprint 1. When Sprint 2 adds more complex module scenarios, consider adding a secondary IR-based extraction pass.

---

### ARCH-P1-007 — MEDIUM — No configOverrides validation function implemented

**File:** LLD Section 11.2 specifies `validateConfigOverrides()` with:

- 50-key limit
- 1KB per value
- Contract key validation (reject undeclared keys as warning, reject secret keys as blocking)
- Template injection check (`/\{\{/` regex)
- Control character rejection

This function is specified in the LLD but NOT implemented in any Sprint 1 file. The LLD says validation happens "at import save time and deployment build time" — both are Sprint 2 concerns (routes + deployment build service).

However, the function itself is pure logic with no route or DB dependency. It could have been included in Sprint 1's `packages/project-io/src/module-release/` alongside the other validators.

**Impact:** MEDIUM — Sprint 2 implementors must implement this from the LLD spec. Having it as a Sprint 1 deliverable with tests would reduce Sprint 2 scope.

**Fix:** Consider adding `validateConfigOverrides()` to `packages/project-io/src/module-release/` as a Sprint 1 follow-up, since it's pure logic and testable in isolation.

---

### ARCH-P1-008 — LOW — Publish safety: BASE64_RE too broad

**File:** `packages/project-io/src/module-release/module-publish-safety.ts:55`

```ts
const BASE64_RE = /[A-Za-z0-9+/=]{20,}/g;
```

This regex matches any 20+ character alphanumeric string, which will match DSL content, English sentences, variable names, and UUID strings. The `looksLikeEncodedSecret()` heuristic (line 282) mitigates false positives by checking if the string is valid Base64 that decodes to printable ASCII.

**Impact:** Low — the heuristic works well in practice and the severity is `warning` (non-blocking). Some false positives are expected and acceptable.

**Fix:** No fix needed. The heuristic is reasonable for a supplementary warning. Document the expected false positive rate in the test file.

---

### ARCH-P1-009 — LOW — Test helper uses secret value in configOverrides

**File:** `packages/database/src/__tests__/model-project-module-dependency.test.ts:41`

```ts
configOverrides: { API_KEY: 'sk-test-123' },
```

The test data uses `'sk-test-123'` as a config override value. The LLD Section 1.4 says "configOverrides are non-secret only." The contract fixture includes `{ key: 'API_KEY', isSecret: true }`. This combination would be rejected by `validateConfigOverrides()` (LLD Section 11.2) when it's implemented.

**Impact:** Low — this is test data only. The model stores whatever it receives; validation is at the route layer.

**Fix:** Consider changing the test value to a non-secret-looking string (e.g., `'production'` or `'https://api.example.com'`) to avoid confusion when the validation function is implemented.

---

### ARCH-P1-010 — LOW — TraceEvent type union only adds tool_auth_resolved

**File:** `packages/shared-kernel/src/types/trace-event.ts:28`

The LLD mentions `tool_auth_resolved` as the new trace event type. The implementation adds exactly this one type. However, the LLD Section 6.2-6.3 also describes trace enrichment with module provenance fields. These fields are added to the `TraceEvent` interface (lines 43-50) as optional properties — correct.

The LLD does not specify additional event types like `module_resolved`, `module_snapshot_loaded`, or `module_agent_started`. These may be needed in Sprint 3 when the deployment resolver and session bootstrap are implemented.

**Impact:** Low — the current type is sufficient for Sprint 1. Additional types can be added incrementally.

**Fix:** No action for Sprint 1. Sprint 3 may need additional TraceEventType values.

---

### ARCH-P1-011 — LOW — Barrel index exports ModuleDependencySelector type

**File:** `packages/database/src/models/index.ts:164`

```ts
type ModuleDependencySelector,
```

This type is exported from the barrel, which is good for downstream consumers. Verified it's defined in `project-module-dependency.model.ts:17-20` as `{ type: 'version' | 'environment'; value: string }` — matches the LLD.

**Impact:** None — this is correct.

---

## Checklist Verification

### Data Model Correctness (LLD 1.1-1.5)

- [x] **Project model** (1.1): `kind`, `moduleVisibility`, `moduleDependencyVersion`, `archivedAt`, `archivedBy` — all present with correct types, enum values, defaults. `archivedAt`/`archivedBy` in schema (resolves Mongoose strict:true concern from memory).
- [x] **ModuleRelease** (1.2): All fields present. Unique index `{tenantId, moduleProjectId, version}`. Listing index `{tenantId, moduleProjectId, createdAt: -1}`. `compiledIR` typed as `Record<string, unknown>` (see ARCH-P1-003). Artifact and contract shapes match LLD.
- [x] **ModuleEnvironmentPointer** (1.3): All fields present. Unique index `{tenantId, moduleProjectId, environment}`. `revision` defaults to 1. Uses `timestamps: { createdAt: false, updatedAt: true }`.
- [x] **ProjectModuleDependency** (1.4): All fields present. Unique index `{tenantId, projectId, alias}`. Reverse lookup index `{tenantId, moduleProjectId}`. Selector sub-schema with `_id: false`. `contractSnapshot` as `Mixed`.
- [x] **DeploymentModuleSnapshot** (1.5): All fields present. Unique index `{tenantId, deploymentId}`. Consumer listing index `{tenantId, projectId}`. `compressedPayload` as `Buffer`. `timestamps: { createdAt: true, updatedAt: false }`.
- [x] **Barrel exports** (1.6): All 4 new models + their interfaces + sub-types exported from `packages/database/src/models/index.ts` under `── Modules ──` section.
- [x] **Tenant isolation plugin**: Applied to all 4 new models.
- [x] **UUIDv7 IDs**: All 4 models use `uuidv7` from `../mongo/base-document.js`.

### Cascade Delete (LLD 2)

- [x] **Path A — Module project**: Blocks with `CascadeDeleteBlockedError` when `countDocuments > 0`. Deletes `ModuleEnvironmentPointer` then `ModuleRelease` when no consumers. Does NOT delete consumer `DeploymentModuleSnapshot`.
- [x] **Path B — Consumer project**: Deletes `ProjectModuleDependency` and `DeploymentModuleSnapshot` scoped to `{tenantId, projectId}`.
- [x] **Tenant deletion**: All 4 module collections deleted in correct order (snapshots -> deps -> pointers -> releases).
- [x] **softDeleteModuleProject**: Sets `archivedAt`/`archivedBy` on both Project and ModuleRelease records with correct tenant scoping.
- [x] **CascadeDeleteBlockedError**: Proper Error subclass with `code`, `consumerProjectIds`.
- [x] **deleteProject signature**: Extended to `deleteProject(projectId, tenantId?)` per LLD. Resolves from Project doc when not provided.
- [ ] **deleteProject tenantId in Project query**: See ARCH-P1-004.

### Module Release Builder (LLD 3.1)

- [x] **9-step pipeline**: All steps implemented in correct order.
- [x] **Step 1**: Validates at least one agent.
- [x] **Step 2**: Validates entryAgentName non-null AND exists in agents.
- [x] **Step 3**: Compile each agent via injected `compileFn`.
- [x] **Step 4**: `stripVariableNamespaceIds` recursively removes `variableNamespaceIds` from IR.
- [x] **Step 5**: Per-agent sourceHash (SHA-256, 16-char hex).
- [x] **Step 6**: Tool artifacts with dslContent, toolType, sourceHash.
- [x] **Step 7**: Optional publish safety via injected `validatePublishSafetyFn`.
- [x] **Step 8**: Contract extraction via injected `extractContractFn`.
- [x] **Step 9**: sourceHash via `computeModuleSourceHash`, model config warning.
- [x] **Error handling**: `err instanceof Error ? err.message : String(err)` pattern.
- [x] **Dependency injection**: All external dependencies (compile, contract, safety) injected.
- [x] **Logging**: Uses `createLogger('module-release-builder')`.
- [ ] **DI type alignment**: See ARCH-P1-001, ARCH-P1-002.

### Source Hash (LLD 1.2 Decision 2c)

- [x] **Deterministic**: Deep-sort all object keys via JSON.stringify replacer.
- [x] **Includes entryAgentName**: Per user decision override on 2c.
- [x] **SHA-256 truncated to 16 hex chars**: Matches LLD spec exactly.

### Contract Extraction (LLD 3.2)

- [x] **6 prerequisite types**: providedAgents, providedTools, requiredConfigKeys, requiredEnvVars, requiredAuthProfiles, requiredConnectors, requiredMcpServers. (7 fields total — requiredMcpServers is the 7th.)
- [x] **Auth profile extraction**: Reuses `extractAuthProfileReferences` from env-var-scanner.
- [x] **referencedBy tracking**: Auth profiles track which agents/tools reference them.
- [x] **Deduplication**: All sets deduplicate correctly.
- [x] **Sorting**: All output arrays sorted alphabetically.
- [x] **Config key secret classification**: `isSecret` flag based on `{{secrets.KEY}}` vs `{{config.KEY}}`.
- [x] **Warnings array**: Present in contract, currently always empty (future use).

### Module Selector (LLD 3.3)

- [x] **Version selector**: `findOne({tenantId, moduleProjectId, version, archivedAt: null})`.
- [x] **Environment selector**: Two-step: find pointer, then find release.
- [x] **Archived release handling**: Both paths filter `archivedAt: null`.
- [x] **Tenant isolation**: All queries include `tenantId`.
- [x] **Unknown selector type**: Returns error.
- [x] **Return types**: Discriminated union `{ releaseId, version } | { error }`.

### Publish Safety (LLD 11.1)

- [x] **Tier 1 — Structural**: HTTP tool auth validation (auth_profile_ref, template, or blocking).
- [x] **Tier 2 — Pattern**: Base64, URL-embedded keys, PEM private keys, secret prefixes.
- [x] **Non-portable warnings**: SearchAI indexId, Workflow workflowId.
- [x] **Source-project identifiers**: variableNamespaceIds (blocking), raw \_id (warning), projectId (warning).
- [x] **Template safe patterns**: `{{env.*}}`, `{{config.*}}`, `{{secrets.*}}` excluded.
- [x] **Auth-sensitive headers**: Authorization, X-Api-Key, X-Auth-Token, Api-Key checked.
- [x] **Logging**: Uses `createLogger('module-publish-safety')`.

### Type Definitions (LLD 6.1)

- [x] **ModuleProvenance**: `{ alias, moduleProjectId, moduleReleaseId, sourceAgentName }` matches LLD.
- [x] **ResolvedAgentIR**: `AgentIR & { _moduleProvenance?: ModuleProvenance }` matches LLD.
- [x] **ResolvedToolDefinition**: `ToolDefinitionLocal & { _moduleProvenance?: Omit<ModuleProvenance, 'sourceAgentName'> & { sourceToolName } }` matches LLD.
- [x] **DeploymentModuleSnapshotPayload**: `{ dependencies, mountedAgents, mountedTools, snapshotHash }` — correct shape for compressed storage.
- [x] **MountedAgentEntry / MountedToolEntry**: Include all provenance fields + IR/definition.
- [x] **DeploymentModuleDependency**: `{ alias, moduleProjectId, moduleReleaseId, version }` — correct metadata shape.

### Tenant Isolation

- [x] All 4 models apply `tenantIsolationPlugin`.
- [x] All model queries in `module-selector.ts` include `tenantId`.
- [x] Cascade delete scopes by `tenantId` in all module paths.
- [x] Test files verify tenant-scoped queries.

### Test Coverage Assessment

| Component                      | Tests                                                                                                                        | Gaps                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ModuleRelease model            | 12 tests: validation, defaults, unique index, tenant scoping, listing, soft-delete                                           | None significant                                                                     |
| ModuleEnvironmentPointer model | 11 tests: validation, enum, defaults, unique index, revision, optimistic concurrency                                         | None significant                                                                     |
| ProjectModuleDependency model  | 11 tests: validation, defaults, unique index, selector sub-doc, configOverrides, reverse lookup                              | None significant                                                                     |
| DeploymentModuleSnapshot model | 9 tests: validation, defaults, unique index, Buffer round-trip, consumer listing                                             | None significant                                                                     |
| Cascade delete modules         | 6 test groups: Path A blocked, Path A clean, Path B, softDelete, tenant cascade, error shape                                 | Integration gap (mocked) — acceptable for Sprint 1                                   |
| Module release builder         | 18 tests: success, validation errors, compile failure, safety, sourceHash, variableNamespaceIds stripping                    | No test for multi-agent mixed success/failure (partial compile)                      |
| Module contract                | 14 test groups: provided items, env vars, secrets, auth profiles, connectors, MCP, config keys, dedup, sorting, empty, mixed | Good coverage                                                                        |
| Module selector                | 7 test groups: version match/miss, environment match/miss/archived, tenant isolation, unknown type                           | Good coverage                                                                        |
| Publish safety                 | 11 test groups: structural HTTP, pattern (PEM, sk-, Bearer, Base64), non-portable, source-project, clean cases               | No test for multi-issue accumulation (agent + tool blocking + warning in single run) |

---

## VERDICT: APPROVED_WITH_RESERVATIONS

### Must address before Sprint 2 starts:

1. **ARCH-P1-001** (MEDIUM): Document the DI adapter pattern for `ExtractContractFn` or align the types. Sprint 2 publish route implementors need clarity.
2. **ARCH-P1-002** (MEDIUM): Same for `ValidatePublishSafetyFn`. The structured issue data should flow through to the API response.
3. **ARCH-P1-007** (MEDIUM): Implement `validateConfigOverrides()` as a Sprint 1 follow-up or add it to Sprint 2 task 0.

### Implementation notes for Sprint 2:

- ARCH-P1-004: Consider adding tenantId to the Project lookup in `deleteProject` when tenantId is provided. Pre-existing gap but worth fixing.
- The `stripVariableNamespaceIds` function is recursive and correctly handles arrays and nested objects. No depth limit is needed since IR depth is bounded by the compiler.
- The `computeModuleSourceHash` function's JSON.stringify replacer correctly handles non-array objects only. Arrays preserve insertion order, which is correct since agent/tool arrays don't need sorting (the outer object keys are sorted).
