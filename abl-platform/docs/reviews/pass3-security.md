# Pass 3 Security Review: Reusable Agent Modules Phase 1

**Reviewer:** LLD Security Reviewer (Agent)
**Date:** 2026-03-21
**Documents reviewed:**

- `docs/specs/reusable-agent-modules-phase1.lld.md` (Sections 10, 11 primary; all sections for context)
- `docs/features/reusable-agent-modules.md`
- `docs/testing/reusable-agent-modules.md`

**Scope:** Pass 3 of 5-pass security review cycle. Verify fixes from Passes 1-2 are solid; find remaining security concerns.

**Codebase files verified:**

- `packages/database/src/models/project.model.ts` -- confirmed current schema (no `kind`, `archivedAt`, `archivedBy` fields yet)
- `packages/database/src/cascade/cascade-delete.ts` -- confirmed `deleteProject(projectId)` has no `tenantId` parameter
- `packages/shared-kernel/src/types/trace-event.ts` -- confirmed `tool_auth_resolved` not in union
- `packages/compiler/src/platform/ir/schema.ts` -- confirmed `ConstraintCheckpoint.target` holds tool names
- `packages/compiler/src/platform/ir/compiler.ts:1491-1505` -- confirmed `parseConstraintCheckpointTarget` extracts tool name
- `packages/compiler/src/platform/ir/guardrail-action.ts` -- confirmed no agent/tool name refs in guardrail actions
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` -- confirmed function signature for auth resolution
- `apps/runtime/src/middleware/feature-gate.ts` -- confirmed `PLAN_FEATURES` structure and fail-open default

---

## VERDICT: APPROVED_WITH_RESERVATIONS

Passes 1-2 fixes are solid. Four new findings remain -- one HIGH (template injection regex bypass via newline), one MEDIUM (missing alias rewrite field), and two LOW items. None are blocking for implementation start, but the HIGH must be fixed before the security gate.

---

## Fix Verification: Passes 1-2

### FIX-1: Redis Lock TOCTOU Race -- VERIFIED SOLID

**LLD Section 10.2, lines 1376-1418**

Both Lua scripts are correct:

- **Release script** (`RELEASE_LOCK_SCRIPT`): Atomically checks `GET == lockId` then `DEL`. Prevents releasing another process's lock. Correct.
- **Renewal script** (`RENEW_LOCK_SCRIPT`): Atomically checks `GET == lockId` then `PEXPIRE`. Prevents extending another process's lock. Correct.
- **Acquisition**: Uses `SET NX PX` which is inherently atomic. Correct.

The `renewalTimer` callback correctly checks the return value and stops renewal if the lock was lost (`if (!renewed) clearInterval(renewalTimer)`).

**Minor concern** (covered in new finding SEC-5 below): caller must use try/finally to ensure `release()` is called.

### FIX-2: Template Injection in configOverrides -- PARTIALLY VERIFIED

**LLD Section 11.2, lines 1526-1536**

The regex `/\{\{.*?\}\}/` catches simple `{{...}}` patterns. Control character check `/[\x00-\x08\x0B\x0C\x0E-\x1F]/` catches most dangerous characters.

**However**: See SEC-1 below -- the regex has a newline bypass.

### FIX-3: Credential Leakage in Published Modules -- VERIFIED SOLID

**LLD Section 11.1, lines 1459-1487**

Two-tier validation is comprehensive:

1. **Structural validation**: Requires `auth_config` to use `auth_profile_ref` or templating. Rejects non-templated literal values. This is the primary guard and is structurally sound -- you cannot accidentally export a hardcoded bearer token.
2. **Pattern-based validation**: Base64 (>20 chars), URL-embedded keys, PEM private keys, common prefixes (`Bearer`, `Basic`, `sk-`, `pk_`). Good supplementary layer.
3. **Source-only identifiers**: `variableNamespaceIds` stripping confirmed against actual codebase (`apps/runtime/src/services/secrets-provider.ts` lines 58-353).

### FIX-4: Wrong Project Scope for Tool Auth -- VERIFIED SOLID

**LLD Section 6.4, lines 804-835**

The fix is explicit and well-documented:

- Consumer `projectId` used for auth resolution (not module source `moduleProjectId`)
- Trace event emits `scope` field for observability
- Comment in code makes the intent unmistakable

The LLD correctly notes that `tool_auth_resolved` must be added to `TraceEventType` (line 833). See SEC-6 below for a minor tracking gap.

---

## New Security Findings

### SEC-1 [HIGH] Template injection regex bypass via newline

**File:** LLD Section 11.2, line 1528
**Regex:** `/\{\{.*?\}\}/`

The `.` in JavaScript regex does not match newline (`\n`, `\r`) by default. A `configOverrides` value like:

```
{{\nmalicious_expression\n}}
```

would bypass the template injection check because `.*?` cannot span across `\n`. The control character regex at line 1534 permits `\n` (0x0A), `\r` (0x0D), and `\t` (0x09).

**Risk:** If config override values are interpolated into templates that process newlines, the `{{` and `}}` on separate lines could still be parsed as template delimiters by downstream template engines.

**Fix:** Replace `/\{\{.*?\}\}/` with `/\{\{/`. There is no legitimate reason for a config override value to contain `{{`. Rejecting the opening delimiter alone is simpler and more defensive than trying to match the full `{{...}}` pattern.

```ts
// Before (bypassable):
if (/\{\{.*?\}\}/.test(value)) {

// After (comprehensive):
if (/\{\{/.test(value)) {
```

Alternatively, add the `s` flag for dotAll matching: `/\{\{.*?\}\}/s`. But the simpler `{{` rejection is preferred for defense-in-depth.

### SEC-2 [MEDIUM] Missing alias rewrite field: `constraints.constraints[].checkpoint.target`

**File:** LLD Section 4.2, `TOOL_NAME_FIELDS` list (lines 524-557)

The `ConstraintCheckpoint` interface at `packages/compiler/src/platform/ir/schema.ts:1151-1154` defines:

```ts
export interface ConstraintCheckpoint {
  kind: 'tool_call' | 'response';
  target?: string; // tool name when kind === 'tool_call'
}
```

Confirmed by `parseConstraintCheckpointTarget` at `packages/compiler/src/platform/ir/compiler.ts:1491-1505`:

```ts
const callMatch = target.match(/^calling\s+([A-Za-z_]\w*)(?:\(\))?$/i);
if (callMatch) {
  return { kind: 'tool_call', target: callMatch[1] };
}
```

The LLD's `TOOL_NAME_FIELDS` list includes `constraints.constraints[].on_fail.target` (when `type='handoff'`, this is an agent name -- correct), but does NOT include `constraints.constraints[].checkpoint.target` (when `checkpoint.kind='tool_call'`, this is a tool name).

**Impact:** If a module constraint uses `BEFORE calling my_tool`, the `checkpoint.target` field would not be rewritten to `alias__my_tool`. The constraint would reference a nonexistent tool name at runtime, causing the checkpoint to never trigger.

**Fix:** Add to `TOOL_NAME_FIELDS`:

```ts
'constraints.constraints[].checkpoint.target', // ConstraintCheckpoint.target (when kind='tool_call')
```

### SEC-3 [MEDIUM] `HumanApprovalIR` fields incorrectly classified as agent name fields

**File:** LLD Section 4.2, `AGENT_NAME_FIELDS` list (lines 519-521)

```ts
'flow.definitions[*].human_approval.onApprove', // Step transitions
'flow.definitions[*].human_approval.onReject',
'flow.definitions[*].human_approval.onTimeout',
```

These are flow step names (transitions within the same agent's flow), not agent name references. The `HumanApprovalIR` interface at `packages/compiler/src/platform/ir/schema.ts:1789-1802` confirms they reference step names like `"confirm_step"` or `"cancel_step"`.

**Risk:** If a flow step name happens to match a module agent or tool name in `moduleSymbolNames`, the step transition would be incorrectly rewritten to `alias__step_name`, breaking the agent's flow graph.

**Impact:** Low probability in practice (step names rarely collide with agent names), but violates the principle that the rewriter should only touch actual symbol references.

**Fix:** Remove these three fields from `AGENT_NAME_FIELDS`. They are flow-internal references, not cross-agent symbol references.

### SEC-4 [MEDIUM] No Zod validation schemas specified for route inputs

**File:** LLD Section 7 (all 10 route handlers)

The review checklist requires: "Every route parameter validated with Zod `.safeParse()`" and "Array body inputs validate element types."

The LLD specifies request/response shapes but does not define Zod schemas for any of the 10 new route handlers. Key unvalidated inputs:

- `POST /module/releases`: `version` (semver pattern mentioned but no Zod schema), `releaseNotes`, `promoteToEnvironment`
- `POST /module-dependencies/preview` and `POST /module-dependencies`: `moduleProjectId`, `alias`, `selector`, `configOverrides`
- `DELETE /module-dependencies/:dependencyId`: path parameter

Without explicit Zod schemas, implementors may use ad-hoc validation or skip it entirely.

**Fix:** Add a Zod schema section for each route handler. At minimum:

```ts
const publishReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  releaseNotes: z.string().max(5000).optional(),
  promoteToEnvironment: z.enum(['dev', 'staging', 'production']).optional(),
});

const importPreviewSchema = z.object({
  moduleProjectId: z.string().min(1),
  selector: z.object({
    type: z.enum(['version', 'environment']),
    value: z.string().min(1),
  }),
  alias: z.string().regex(/^[a-z][a-z0-9_]{1,24}$/),
  configOverrides: z.record(z.string(), z.string()).optional(),
});
```

### SEC-5 [LOW] Lock renewal timer leak on build failure

**File:** LLD Section 10.2, lines 1393-1418

The `acquireDeployLock` function returns `{ lockId, release }`. If the deployment build (Section 5.1) throws an exception between lock acquisition (step 3) and release (step 16), the `renewalTimer` setInterval continues running indefinitely, keeping the lock alive and blocking future deployments.

The 60s TTL provides an eventual safety net (the lock expires if renewal fails after a lockId mismatch), but the timer itself leaks and keeps running in the Node.js event loop.

**Fix:** The deployment build service (Section 5.1) must wrap the build in try/finally:

```ts
const lock = await acquireDeployLock(redis, tenantId, projectId);
if (!lock) return res.status(409).json({ ... });
try {
  // ... build steps 4-15 ...
} finally {
  await lock.release();
}
```

This is implied by the LLD flow (step 16 says "Release Redis lock") but should be explicit as a try/finally requirement, since exceptions from steps 4-15 would skip step 16.

### SEC-6 [LOW] `tool_auth_resolved` trace event type not tracked as implementation task

**File:** LLD Section 6.4, line 833 vs Section 14 cross-reference table

The LLD correctly notes: "The trace event type must be added to the `TraceEventType` enum in `packages/shared-kernel/src/types/trace-event.ts`." However, this is not tracked in the Section 14 cross-reference table or the Section 13 implementation order.

**Risk:** The type addition could be overlooked, causing trace consumers to silently drop `tool_auth_resolved` events. The current `TraceEventType` union (confirmed at `packages/shared-kernel/src/types/trace-event.ts:10-26`) has no `tool_auth_resolved` entry.

**Fix:** Add to Section 13 Sprint 3 (item 15): "Add `tool_auth_resolved` to `TraceEventType` enum in `packages/shared-kernel/src/types/trace-event.ts`."

### SEC-7 [LOW] Runtime merge does not defensively check for local name collisions

**File:** LLD Section 6.1, lines 740-763

The deployment resolver merge loop sets `resolvedAgents[mountedName] = ...` and `resolvedTools[mountedName] = ...` without checking whether `mountedName` already exists in the resolved set (i.e., collides with a local agent/tool).

Collision detection happens at import time (Section 4.3), so this should never occur in normal operation. However, if:

- The snapshot were tampered with (DB-level attack)
- A bug in collision detection allowed a collision through
- The local agent set changed after the snapshot was created

...then a module agent could silently override a consumer's local agent. This is a defense-in-depth concern.

**Fix:** Add a defensive check before merge:

```ts
for (const [mountedName, agent] of Object.entries(payload.mountedAgents)) {
  if (resolvedAgents[mountedName]) {
    log.error('Module mount collision with local agent', { mountedName, alias: agent.alias });
    continue; // skip — local agent takes precedence
  }
  resolvedAgents[mountedName] = { ... };
}
```

### SEC-8 [LOW] `deleteProject` function signature lacks `tenantId` parameter

**File:** LLD Section 2.1 (Path B) vs `packages/database/src/cascade/cascade-delete.ts:137`

The LLD specifies cascade queries as `{ tenantId, projectId }` but the actual `deleteProject` function signature is:

```ts
export async function deleteProject(projectId: string): Promise<CascadeDeleteResult>;
```

There is no `tenantId` parameter. All internal queries use `{ projectId }` without tenant scoping.

This is a pre-existing gap (documented in memory from prior reviews). The new module entity deletes (`ProjectModuleDependency.deleteMany`, `DeploymentModuleSnapshot.deleteMany`) need to be added with `tenantId` scoping, but the function signature must be extended first.

**Fix:** Implementors must either:

1. Extend `deleteProject` to accept `tenantId` as a second parameter, or
2. Add module entity cleanup as a separate function called before the existing `deleteProject`

---

## Verified Security Properties

### Tenant/Project Isolation

- [x] All new model queries include `tenantId` (Sections 1.2-1.5, 3.3, 7.3)
- [x] Cross-tenant catalog access returns empty results, not 403 (Section 11.3, line 1547)
- [x] Module visibility check includes `$or` for private vs tenant visibility (Section 7.3, lines 893-898)
- [x] Import validates `moduleProject.tenantId === consumerProject.tenantId` (Section 11.3)

### Cascade Delete

- [x] Two-path cascade correctly differentiates module project vs consumer project deletion (Section 2.1)
- [x] Module project deletion blocked when active consumer dependencies exist (Section 2.1, Path A step 1)
- [x] `DeploymentModuleSnapshot` NOT deleted when module project is deleted (correct -- belongs to consumer) (Section 2.1, Path A note)
- [x] Tenant deletion cascade includes all 4 new entities in correct order (Section 2.1, Tenant Deletion)

### Soft-Delete

- [x] `archivedAt` and `archivedBy` fields explicitly specified in Mongoose schema (Section 1.1, line 77 note)
- [x] Archived releases remain resolvable for existing deployment snapshots (Section 2.2, line 359)
- [x] Catalog query filters out archived module projects (Section 2.2, line 359)

### Feature Gating

- [x] Fail-closed behavior specified for module operations (Section 9.2, lines 1251-1263)
- [x] Error case returns 503 (not silent pass-through) (Section 9.2, line 1257)
- [x] Studio fails closed when Runtime unreachable (Section 9.3, line 1304)
- [x] `reusable_modules` placed in BUSINESS and ENTERPRISE tiers (Section 9.1, lines 1225-1227)

### Concurrency Control

- [x] Dependency version counter uses atomic MongoDB condition check (Section 10.1, lines 1351-1364)
- [x] Orphaned snapshot cleaned up on version mismatch (Section 10.1, line 1362)
- [x] Pointer promotion uses optimistic concurrency via `revision` (Section 10.3)
- [x] Publish deduplication via MongoDB unique index + catch E11000 (Section 7.5, line 982-983)

### Alias Rewriting

- [x] Alias validation rejects `__` (double underscore), reserved prefixes, special characters (Section 4.1)
- [x] Collision detection checks against local agents, local tools, and existing mounted names (Section 4.3)
- [x] IR field list is comprehensive for all major reference types (Section 4.2) -- with exception of SEC-2 above
- [x] CEL `when` conditions correctly excluded from rewriting (Section 4.2, line 560 note)

### Snapshot Integrity

- [x] 8 MB uncompressed size limit enforced before compression (Section 1.5, lines 274-277)
- [x] `snapshotHash` stored alongside payload for integrity reference (Section 1.5)
- [ ] `snapshotHash` is NOT verified on load (defense-in-depth gap -- see SEC-7)

### configOverrides Security

- [x] 50 key limit (Section 11.2, line 1502)
- [x] 1 KB per value limit (Section 11.2, line 1506)
- [x] Secret key rejection against contract (Section 11.2, lines 1513-1525)
- [x] Template injection regex present (Section 11.2, line 1528) -- with bypass noted in SEC-1
- [x] Control character rejection (Section 11.2, line 1534) -- with newline gap noted in SEC-1
- [ ] Key name format validation not specified (minor -- keys are validated against contract)

---

## Summary

| ID    | Severity | Description                                                                | Status                         |
| ----- | -------- | -------------------------------------------------------------------------- | ------------------------------ |
| SEC-1 | HIGH     | Template injection regex bypass via newline in configOverrides             | Must fix before security gate  |
| SEC-2 | MEDIUM   | Missing alias rewrite field: `constraints.constraints[].checkpoint.target` | Must fix before implementation |
| SEC-3 | MEDIUM   | `HumanApprovalIR` step transitions misclassified as agent name fields      | Should fix                     |
| SEC-4 | MEDIUM   | No Zod validation schemas specified for route inputs                       | Should fix                     |
| SEC-5 | LOW      | Lock renewal timer leak on build failure (need explicit try/finally)       | Recommended                    |
| SEC-6 | LOW      | `tool_auth_resolved` not tracked in implementation order                   | Recommended                    |
| SEC-7 | LOW      | Runtime merge lacks defensive collision check                              | Recommended                    |
| SEC-8 | LOW      | `deleteProject` function signature lacks `tenantId` (pre-existing)         | Known debt                     |

### Remediation Priority

1. **SEC-1** -- One-line regex fix. Must be applied before implementation begins.
2. **SEC-2** -- One-line addition to `TOOL_NAME_FIELDS`. Must be applied before alias rewriter implementation.
3. **SEC-3** -- Three-line removal from `AGENT_NAME_FIELDS`. Should be applied before alias rewriter implementation.
4. **SEC-4** -- New section with Zod schemas. Can be addressed during implementation (Sprint 2).
5. **SEC-5 through SEC-8** -- Low-risk items that can be addressed during implementation.

---

## Notes for Implementation

1. **configOverrides key format**: While keys are validated against the module contract, consider adding a key format regex (`/^[a-zA-Z_][a-zA-Z0-9_.]*$/`) to prevent unusual key names from causing downstream issues when interpolated into templates.

2. **Snapshot hash verification**: The `snapshotHash` field exists in the model but is never re-verified on load. Adding `if (computeHash(decompressed) !== snapshot.snapshotHash) throw` at load time in the deployment resolver would complete the integrity chain.

3. **`configOverrides` at deployment build time**: Section 5.1 step 5a says "Apply configOverrides to module config slots" and step 5c says "If configOverrides change IR-affecting values, re-compile from DSL." The validation from Section 11.2 must ALSO run at deployment build time (not just import save time) to catch any values that were modified between import and deployment.

4. **Feature flag wiring for Studio**: The Studio feature resolution (Section 9.3) calls `${RUNTIME_URL}/api/tenants/${tenantId}/features`. Verify this endpoint exists in the runtime or specify it. The feature-gate middleware currently only exposes `requireFeature()` as Express middleware, not as a REST endpoint.
