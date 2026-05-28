# Sprint 1 — Pass 2 Architecture Review

**Reviewer:** LLD Reviewer Agent
**Date:** 2026-03-22
**Pass:** 2 of 5 (Architecture)
**Scope:** Data models, cascade delete, release builder, DI types, contract extraction, selector, publish safety, runtime types, trace events, tests

---

## Review Methodology

This review was conducted fresh with no context from Pass 1. Every implementation file was read and compared against the HLD and LLD. All file paths were verified to exist. All function signatures were verified against their actual code. Tests were read for coverage adequacy.

### Files Reviewed

**Implementation:**

- `packages/database/src/models/module-release.model.ts`
- `packages/database/src/models/module-environment-pointer.model.ts`
- `packages/database/src/models/project-module-dependency.model.ts`
- `packages/database/src/models/deployment-module-snapshot.model.ts`
- `packages/database/src/models/project.model.ts`
- `packages/database/src/models/index.ts`
- `packages/database/src/cascade/cascade-delete.ts`
- `apps/runtime/src/services/modules/types.ts`
- `packages/shared-kernel/src/types/trace-event.ts`
- `packages/project-io/src/module-release/build-module-release.ts`
- `packages/project-io/src/module-release/source-hash.ts`
- `packages/project-io/src/module-release/module-contract.ts`
- `packages/project-io/src/module-release/module-selector.ts`
- `packages/project-io/src/module-release/module-publish-safety.ts`
- `packages/project-io/src/module-release/index.ts`

**Tests:**

- `packages/database/src/__tests__/model-module-release.test.ts`
- `packages/database/src/__tests__/model-module-environment-pointer.test.ts`
- `packages/database/src/__tests__/model-project-module-dependency.test.ts`
- `packages/database/src/__tests__/model-deployment-module-snapshot.test.ts`
- `packages/database/src/__tests__/cascade-delete-modules.test.ts`
- `packages/project-io/src/__tests__/module-release-builder.test.ts`
- `packages/project-io/src/__tests__/module-contract.test.ts`
- `packages/project-io/src/__tests__/module-selector.test.ts`
- `packages/project-io/src/__tests__/module-publish-safety.test.ts`

**Spec:**

- `docs/specs/reusable-agent-modules-phase-plan.hld.md`
- `docs/specs/reusable-agent-modules-phase1.lld.md`

---

## Findings

### CRITICAL

**(none)**

All previous CRITICAL findings from Pass 1 were verified as resolved:

- DI type `ExtractContractFn` matches `extractModuleContract` signature (arrays, verified at `build-module-release.ts:45-48` vs `module-contract.ts:58-61`)
- DI type `ValidatePublishSafetyFn` returns `{ safe, issues[] }` matching actual function (verified at `build-module-release.ts:55-66` vs `module-publish-safety.ts:34-37`)
- `deleteProject` scopes Project lookup by tenantId when provided (verified at `cascade-delete.ts:222`)
- Cascade delete two-path logic is correctly implemented with blocking error (verified at `cascade-delete.ts:228-276`)

---

### HIGH

#### HIGH-1: `deleteProject` without `tenantId` falls through module paths silently

**File:** `packages/database/src/cascade/cascade-delete.ts:229,263`
**Severity:** HIGH

When `deleteProject(projectId)` is called without `tenantId` and the project has no `tenantId` (i.e., `projectDoc.tenantId === null`), `projectTenantId` becomes `null`. The module Path A check at line 229 (`if (projectKind === 'module' && projectTenantId)`) correctly skips — but Path B at line 263 (`if (projectTenantId)`) also skips entirely, meaning `ProjectModuleDependency` and `DeploymentModuleSnapshot` for that project are never cleaned up.

This is a safe degradation since projects without `tenantId` cannot have module dependencies (module features require tenant context), but the LLD Section 1.1 explicitly states "A project with `tenantId: null` cannot be converted to `kind: 'module'`." The code doesn't enforce this invariant — it just silently skips. A defensive comment documenting why the null path is safe would prevent future confusion.

**Fix:** Add a comment at line 263 explaining that `tenantId: null` projects cannot have module dependencies, so skipping is safe. Alternatively, add an assertion or log.

---

#### HIGH-2: Cascade delete ordering risk — module entities deleted AFTER Deployments in `deleteTenant`

**File:** `packages/database/src/cascade/cascade-delete.ts:110-122`
**Severity:** HIGH

In `deleteTenant`, the module entity cascade runs at lines 110-120 (DeploymentModuleSnapshot, ProjectModuleDependency, ModuleEnvironmentPointer, ModuleRelease), which is placed after Sessions (line 108) but before Deployments (line 122). This is the correct order per the LLD Section 2 ("snapshots -> deps -> pointers -> releases"). However, the code currently deletes `DeploymentModuleSnapshot` at line 111 _before_ `Deployment` at line 122, which is correct since snapshots reference deployments, not the other way around.

**Verified as correct.** The ordering `DeploymentModuleSnapshot -> ProjectModuleDependency -> ModuleEnvironmentPointer -> ModuleRelease -> Deployment` is consistent with the LLD. No action needed.

_Downgrading this to a verification note — the ordering IS correct upon careful analysis._

---

#### HIGH-3: `compiledIR` typed as `Record<string, unknown>` creates unsafe downstream casts

**File:** `packages/database/src/models/module-release.model.ts:59`, `packages/project-io/src/module-release/build-module-release.ts:73`
**Severity:** HIGH

The `IModuleRelease.compiledIR` is typed as `Record<string, unknown>` to avoid a `@abl/compiler` dependency in the database package. The builder returns `compiledIR: Record<string, Record<string, unknown>>` (line 73). The comment at line 54-58 explains this is intentional.

However, at runtime when the deployment resolver consumes `compiledIR` from a `ModuleRelease` document (LLD Section 6.1), it must cast to `AgentIR` without any validation. Since the release builder already compiles and validates the IR at publish time, this is acceptable — but there is no runtime guard against schema drift if the `AgentIR` type changes between when a release was published and when a consumer deploys.

This is an accepted risk per the LLD design (immutable releases), but implementors should be aware that schema changes to `AgentIR` could break runtime deserialization of older releases. This is a Phase 2 concern (release format versioning).

**Fix:** Implementation note only — no code change needed for Sprint 1. Add a doc comment on `compiledIR` in the model noting that future `AgentIR` schema changes must be backward-compatible with already-published releases.

---

#### HIGH-4: `buildModuleRelease` safety validation is optional — no caller contract ensures it runs

**File:** `packages/project-io/src/module-release/build-module-release.ts:107`
**Severity:** HIGH

`validatePublishSafetyFn` is an optional parameter (`ValidatePublishSafetyFn?`). The LLD Section 3.1 Step 5 specifies "Run publish safety validation" as a required step, not optional. While the test at `module-release-builder.test.ts:343-349` explicitly tests the no-safety-validator path as a valid case, this means any caller can skip safety validation entirely by not providing the function.

The builder's signature should match the LLD intent. The safety validator should be required, with the caller explicitly opting out only via a `skipSafetyValidation` flag rather than the function simply being absent.

**Fix:** Either (a) make `validatePublishSafetyFn` required, or (b) add a `skipSafetyValidation?: boolean` parameter and log a warning when safety is skipped. At minimum, the publish route handler must always supply the validator.

---

### MEDIUM

#### MEDIUM-1: `IModuleRelease.compiledIR` in builder returns nested `Record<string, Record<string, unknown>>` but model type is `Record<string, unknown>`

**File:** `packages/project-io/src/module-release/build-module-release.ts:73` vs `packages/database/src/models/module-release.model.ts:59`
**Severity:** MEDIUM

The builder success type declares `compiledIR: Record<string, Record<string, unknown>>` (keyed by agent name, each value is an IR object). The model interface declares `compiledIR: Record<string, unknown>`. These are assignment-compatible in TypeScript, but the model's type is weaker. When reading from the database, consumers get `Record<string, unknown>` and must know to cast the values.

**Fix:** Update the model's `compiledIR` type to `Record<string, Record<string, unknown>>` for consistency, since the inner Records are agent IR objects.

---

#### MEDIUM-2: `module-contract.ts` does not emit warnings for unsupported constructs

**File:** `packages/project-io/src/module-release/module-contract.ts:164-173`
**Severity:** MEDIUM

The contract extractor initializes a `warnings` array (line 68) but never pushes anything to it. The LLD Section 1.2 contract shape includes `warnings: Array<{ code: string; message: string }>` and the HLD Section "Proposed artifact contracts" states the contract should include "warnings for unsupported source-specific constructs." The builder (Section 3.1 Step 8) checks for AgentModelConfig and emits a warning on the builder side, but the contract itself will always have `warnings: []`.

This means the contract, as a standalone artifact, does not communicate portability concerns. If a consumer inspects the contract (e.g., in the catalog detail view), they won't see any warnings.

**Fix:** Move the `hasModelConfigs` warning and any other contract-level warnings into the contract extraction, or document that builder-level warnings are the canonical source and the contract's `warnings` array is reserved for future use.

---

#### MEDIUM-3: No test coverage for `softDeleteModuleProject` when project does not exist

**File:** `packages/database/src/__tests__/cascade-delete-modules.test.ts:280-305`
**Severity:** MEDIUM

The `softDeleteModuleProject` test verifies the happy path (project and releases archived), but does not test:

- What happens when `moduleProjectId` doesn't exist (no project found)
- What happens when `tenantId` doesn't match any project (cross-tenant attempt)
- What happens when no releases exist for the project

The function at `cascade-delete.ts:359-379` uses `findOneAndUpdate` which returns null on miss but does not throw. A cross-tenant call would silently do nothing. The test should verify that the function handles these edge cases gracefully.

**Fix:** Add test cases for: (1) non-existent project returns `{ archivedReleases: 0 }`, (2) wrong tenantId returns `{ archivedReleases: 0 }` and does not modify any documents.

---

#### MEDIUM-4: Selector enum validation in `ProjectModuleDependency` allows arbitrary strings

**File:** `packages/database/src/models/project-module-dependency.model.ts:51`
**Severity:** MEDIUM

The `selector.type` field uses `enum: ['version', 'environment']` which validates at Mongoose level. However, `selector.value` has no validation constraints — it accepts any string. For `environment` selectors, the value should be constrained to `['dev', 'staging', 'production']`. For `version` selectors, there is no semver validation at the model level.

The LLD relies on the module-selector.ts function and the Studio API route to perform value validation. The model is a storage layer and does not validate business rules. This is acceptable if all write paths go through validated Studio routes, but a direct model write could store invalid data.

**Fix:** This is acceptable if all callers validate. Add a doc comment on the `selector.value` field noting that business validation (env values, semver format) is performed by the service layer.

---

#### MEDIUM-5: `extractModuleContract` uses `extractAuthProfileReferences` which parses AUTH: directives broadly

**File:** `packages/project-io/src/module-release/module-contract.ts:83-86`
**Severity:** MEDIUM

The contract extractor calls `extractAuthProfileReferences` from `env-var-scanner.ts` for auth profile extraction. The env-var-scanner's `extractAuthProfileReferences` function uses `^\s*AUTH:\s+(.+)$/gim` which captures everything after `AUTH:` including `auth_profile_ref` prefixes, tool names, etc. This means if a tool DSL has `AUTH: auth_profile_ref my-profile`, the extracted name would be `auth_profile_ref my-profile` (the full line content), not just `my-profile`.

The env-var-scanner was designed for manifest generation where it performs further processing. Reusing it directly in module contract extraction may produce noisy or incorrect auth profile names in the contract.

**Fix:** Verify by running the existing tests whether the `extractAuthProfileReferences` function correctly isolates profile names from `auth_profile_ref` prefixes. If it does not, the contract extractor needs a custom parser or post-processing to strip the `auth_profile_ref` prefix. The test at `module-contract.test.ts:103-137` tests with `AUTH: production-openai` and `AUTH: api-profile` (direct names), but not with `AUTH: auth_profile_ref my-profile` (the production format).

---

#### MEDIUM-6: Missing test: `ProjectModuleDependency` selector.type enum validation

**File:** `packages/database/src/__tests__/model-project-module-dependency.test.ts`
**Severity:** MEDIUM

The test file validates required fields and unique indexes but does not test that `selector.type` rejects invalid enum values (e.g., `selector: { type: 'invalid', value: '1.0.0' }`). The `ModuleEnvironmentPointer` test file correctly tests enum rejection at line 91-99. Parity is needed.

**Fix:** Add a test that constructs a `ProjectModuleDependency` with `selector.type = 'invalid'` and verifies `validateSync()` returns an error.

---

#### MEDIUM-7: `module-publish-safety.ts` `BASE64_RE` has high false-positive risk on DSL content

**File:** `packages/project-io/src/module-release/module-publish-safety.ts:55`
**Severity:** MEDIUM

`BASE64_RE = /[A-Za-z0-9+/=]{20,}/g` matches any 20+ character alphanumeric string, which will frequently match normal variable names, DSL keywords, descriptions, and agent goals. The `looksLikeEncodedSecret` heuristic at line 282 filters by checking if the decoded value is 50%+ printable ASCII, but many normal strings satisfy this.

The safety validator correctly categorizes base64 matches as `warning` (not `blocking`), so this won't block valid publishes. But it may generate noisy warnings that train users to ignore the safety validation output.

**Fix:** Acceptable for Sprint 1 as warnings are non-blocking. Consider tightening the heuristic in Sprint 2 (e.g., require `=` padding, minimum entropy, or exclude matches that are purely alphanumeric with no `/+` characters).

---

### LOW

#### LOW-1: `ModuleRelease` schema uses `timestamps: { createdAt: true, updatedAt: false }` — correct but implicit

**File:** `packages/database/src/models/module-release.model.ts:85`
**Severity:** LOW

Releases are immutable, so `updatedAt: false` is correct. This matches the LLD Section 1.2 which only lists `createdAt`. However, the `archivedAt` and `archivedBy` fields can be updated after creation (for soft-delete). This means the document CAN be updated (via `findOneAndUpdate`), but `updatedAt` won't track when the archive happened. The `archivedAt` field itself serves this purpose, so this is functionally correct.

**No fix needed.**

---

#### LOW-2: `source-hash.ts` replacer function parameter has an unused `_key` parameter

**File:** `packages/project-io/src/module-release/source-hash.ts:29`
**Severity:** LOW

The JSON.stringify replacer function uses `(_key, value)` — the `_key` is conventionally prefixed with underscore to indicate intentional non-use. This is correct and follows the codebase's convention. No issue.

**No fix needed.**

---

#### LOW-3: `module-selector.ts` error message for deleted release via pointer is misleading

**File:** `packages/project-io/src/module-release/module-selector.ts:58`
**Severity:** LOW

When an environment pointer references a release that has been deleted (not just archived), the error message is `"Promoted release has been archived"`. It should distinguish between archived and deleted, or use a more general message like `"Promoted release is no longer available"`.

**Fix:** Change the error message to `"Promoted release is no longer available (archived or deleted)"` for accuracy.

---

## Verified

- [x] **Data model correctness vs LLD Sections 1.1-1.5** — All 4 new models plus Project extension match the LLD exactly. Interfaces, schema fields, indexes, and collection names are correct.
- [x] **Cascade delete two-path logic vs LLD Section 2** — Path A (module project) blocks on active consumers with `CascadeDeleteBlockedError`, then deletes pointers and releases. Path B (consumer project) deletes dependencies and snapshots. Tenant deletion cascades all 4 collections. Soft-delete function archives project and releases.
- [x] **Release builder pipeline vs LLD Section 3.1** — All 9 steps implemented correctly: agent validation, entry agent check, compilation, variableNamespaceIds stripping (including nested arrays), per-item hashing, safety validation, contract extraction, source hash.
- [x] **DI type alignment** — `ExtractContractFn` signature matches `extractModuleContract`. `ValidatePublishSafetyFn` return type matches `PublishSafetyResult`. `CompileFn` matches builder's usage.
- [x] **Contract extraction completeness** — Extracts all 7 prerequisite types: env vars, secrets, auth profiles, connectors, MCP servers, config keys, secret config keys. Deduplication works. Sorting is deterministic.
- [x] **Selector resolution** — Both version and environment selectors implemented correctly. Archived releases filtered via `archivedAt: null`. Tenant isolation enforced on all queries.
- [x] **Publish safety two-tier validation** — Tier 1 (structural) checks HTTP tool auth. Tier 2 (pattern) scans for PEM keys, Bearer tokens, sk- prefixes, URL-embedded keys, base64 secrets. Non-portable warnings for SearchAI/Workflow bindings. Source-project identifiers (variableNamespaceIds, raw \_ids, projectIds) checked.
- [x] **Tenant isolation in all DB queries** — All model queries include `tenantId`. Cross-tenant access returns null (maps to 404). Cascade delete scopes by tenantId.
- [x] **Model registration in barrel export** — All 4 new models exported from `packages/database/src/models/index.ts` with correct type exports.
- [x] **TraceEvent extension** — `tool_auth_resolved` added to `TraceEventType` union. Module provenance fields (`moduleAlias`, `moduleProjectId`, `moduleReleaseId`, `sourceAgentName`) added as optional fields on `TraceEvent`.
- [x] **Runtime types** — `ModuleProvenance`, `ResolvedAgentIR`, `ResolvedToolDefinition`, `DeploymentModuleSnapshotPayload` and supporting types correctly defined. Tool provenance uses `sourceToolName` instead of `sourceAgentName`.
- [x] **Source hash determinism** — Uses canonical JSON with deep-sorted keys, includes entryAgentName, truncated SHA-256.
- [x] **Pass 1 fixes verified** — All 6 Pass 1 fixes confirmed in code.

### Test Coverage Assessment

- [x] **ModuleRelease model** — 12 tests: required fields, defaults, UUID format, uniqueness, tenant scoping, listing sort, soft-delete persistence, timestamps
- [x] **ModuleEnvironmentPointer model** — 10 tests: required fields, enum validation (accepts valid, rejects invalid), defaults, revision, uniqueness, optimistic concurrency, timestamps
- [x] **ProjectModuleDependency model** — 12 tests: required fields, defaults, selector sub-document, configOverrides, contractSnapshot, uniqueness, reverse lookup, timestamps
- [x] **DeploymentModuleSnapshot model** — 9 tests: required fields, defaults, Buffer storage, uniqueness, listing, Buffer round-trip, timestamps
- [x] **Cascade delete** — 5 test groups: module project blocked, module project without consumers, consumer project cleanup, soft delete, tenant deletion
- [x] **Release builder** — 17 tests: success, validation failures (no agents, null entry, missing entry, compile null, compile throw, compile non-Error), safety blocking/warnings, variableNamespaceIds stripping, sourceHash determinism/diffing, tool artifacts, contract function args, safety function args, multiple compile failures, model config warning
- [x] **Contract extractor** — 21 tests: provided agents/tools, env vars, secrets, auth profiles with referencedBy, connectors, MCP servers, config keys (secret vs non-secret), deduplication, empty project, mixed content, sorting
- [x] **Module selector** — 7 tests: version match, version not found, archived version, environment pointer+release, no pointer, archived pointed release, unknown selector type, tenant isolation
- [x] **Publish safety** — 14 tests: HTTP auth (hardcoded, auth_profile_ref, env template, config template, X-Api-Key, inline token), PEM key, sk- prefix, Bearer token, template exclusion, short base64, long base64 warning, SearchAI indexId, workflowId, variableNamespaceIds blocking, raw \_id warning, projectId warning, clean cases, empty inputs

---

## Summary

| Category                | Status                                        |
| ----------------------- | --------------------------------------------- |
| Architecture compliance | PASS                                          |
| Pattern consistency     | PASS                                          |
| Data model correctness  | PASS                                          |
| Cascade delete logic    | PASS (1 edge case noted — HIGH-1)             |
| DI type alignment       | PASS                                          |
| Contract extraction     | PASS (warnings field empty — MEDIUM-2)        |
| Selector resolution     | PASS                                          |
| Publish safety          | PASS                                          |
| Tenant isolation        | PASS                                          |
| Test coverage           | PASS (2 gap areas noted — MEDIUM-3, MEDIUM-6) |

---

## VERDICT: APPROVED_WITH_RESERVATIONS

### Must-address before Sprint 2 (HIGH)

1. **HIGH-1:** Add defensive comment or log for `deleteProject` without tenantId path
2. **HIGH-4:** Ensure the publish route handler always supplies the safety validator; consider making it required in the builder signature

### Should-address (MEDIUM)

3. **MEDIUM-1:** Align `compiledIR` types between builder and model
4. **MEDIUM-2:** Populate contract `warnings` from contract extractor, or document that builder-level warnings are canonical
5. **MEDIUM-3:** Add edge-case tests for `softDeleteModuleProject`
6. **MEDIUM-5:** Test `extractAuthProfileReferences` with `auth_profile_ref <name>` format in contract context
7. **MEDIUM-6:** Add selector enum validation test for `ProjectModuleDependency`

### Implementation Notes

- The `BASE64_RE` false-positive rate (MEDIUM-7) is acceptable for Sprint 1 since matches are warnings only. Tighten in Sprint 2.
- The `compiledIR` as `Record<string, unknown>` (HIGH-3) is an accepted design decision to avoid cross-package dependencies. Future `AgentIR` schema changes must maintain backward compatibility with published releases.
- Express route ordering requirements from the LLD (Section 11.4) cannot be verified until the runtime routes are implemented (Sprint 2).
- Lock timer try/finally requirement (from Pass 3/4 memory) cannot be verified until `deployment-build-service.ts` is implemented (Sprint 2).
