# LLD Review Log: Agent Assist Runtime Compat

## LLD-Reviewer Round 1 — Architecture Compliance

**Reviewer**: lld-reviewer
**Date**: 2026-04-22
**LLD**: `docs/plans/2026-04-22-agent-assist-runtime-compat-impl-plan.md`
**Focus**: Architecture compliance against ABL platform principles and core invariants

---

### VERDICT: NEEDS_CHANGES

### ISSUES

- **[CRITICAL] Feature-gate middleware returns 403, but facade requires 404 to avoid leaking feature existence.**
  The LLD (Phase 3, task 3.7) specifies the middleware chain includes `feature-gate('agent_assist')`. However, the existing `requireFeature()` in `apps/runtime/src/middleware/feature-gate.ts:119` returns HTTP 403 with `FEATURE_NOT_AVAILABLE`. The HLD and LLD both require that disabled/missing features return 404 `APP_NOT_FOUND` (identical to cross-tenant mismatch) to prevent existence disclosure. The LLD exit criteria at Phase 3 explicitly state: "With `agent_assist` feature flag OFF [...] all facade requests return 404 APP_NOT_FOUND byte-identical to cross-tenant 404."
  File: `apps/runtime/src/middleware/feature-gate.ts:119` | Fix: Either (a) create a facade-specific wrapper that catches the 403 from `requireFeature` and converts it to 404 `APP_NOT_FOUND`, or (b) add a `concealAsNotFound` option to `requireFeature` that returns 404 instead of 403. Option (b) is preferable as it is reusable. The LLD must specify which approach and include the implementation task.

- **[CRITICAL] In-process binding cache missing max-size and eviction strategy.**
  The LLD (Phase 1, task 1.2) specifies a "60-second in-process read cache keyed on `(tenantId, appId, environment)`" but does not specify a max-size cap or eviction policy. CLAUDE.md invariant: "Every in-memory Map needs max size, TTL, and eviction." Without a cap, a tenant creating many bindings could grow the cache unboundedly.
  File: LLD Phase 1, task 1.2 | Fix: Specify `maxEntries` (e.g., 500), LRU eviction, and add these as exit criteria assertions in the unit test.

- **[HIGH] Feature-gate middleware fails OPEN on error, but the LLD says nothing about this.**
  `requireFeature()` at `feature-gate.ts:130` fails open on errors (allows request through on DB outage). For a security-irrelevant cosmetic feature this is fine, but the agent-assist facade is an externally-facing API surface that accepts V1 traffic and creates sessions. A transient DB outage would let ALL tenants (even those without the feature) reach the facade, potentially creating sessions on projects they should not access. The LLD should either (a) use `createModuleFeatureGate` (fail-closed) or (b) document why fail-open is acceptable and add a compensating control (the kill-switch env var is a partial mitigation but requires manual intervention).
  File: `apps/runtime/src/middleware/feature-gate.ts:126-131` | Fix: Add a decision note in the LLD explaining why fail-open is acceptable OR switch to fail-closed. The binding-resolution step is a second gate (binding must exist for the tenant), which partially mitigates this; document that.

- **[HIGH] Admin CRUD route auth not specified in the LLD.**
  Phase 2 describes admin routes under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/` but does not specify what auth middleware protects them. The admin app has its own auth pattern. The LLD should explicitly state which auth guard is used and that `tenantId` from the URL path is validated against the authenticated principal's tenant.
  File: LLD Phase 2 | Fix: Add a task step specifying the auth middleware (admin app pattern) and the `tenantId` path-param-vs-principal validation. Verify cross-tenant admin cannot access another tenant's bindings.

- **[HIGH] BullMQ callback worker job config missing `removeOnComplete`, `removeOnFail`, `failParentOnFailure`.**
  Phase 4, task 4.4 describes retry and DLQ semantics but does not specify `removeOnComplete`, `removeOnFail` settings on the job. CLAUDE.md requires all BullMQ job configs to include these. Without `removeOnComplete`, completed jobs accumulate in Redis.
  File: LLD Phase 4, task 4.4 | Fix: Specify `removeOnComplete: { count: 100, age: 86400 }`, `removeOnFail: false` (since DLQ handles failures), and worker `lockDuration` based on expected processing time (the callback POST has a 10s timeout, so `lockDuration: 30000` minimum).

- **[MEDIUM] POC route uses `authMiddleware` (custom wrapper), LLD says `createUnifiedAuthMiddleware` — verify the actual plan.**
  The POC at `agent-assist.ts:32` imports `authMiddleware` from `../middleware/auth.js`, which is a wrapper around `createUnifiedAuthMiddleware` + `requireAuth` + `requireTenantContext`. The LLD Phase 3 task 3.7 says the chain should use `createUnifiedAuthMiddleware`. These are different: `authMiddleware` requires tenant context; `createUnifiedAuthMiddleware` alone does not. The LLD should use `authMiddleware` (the existing wrapper that enforces tenant context) or explicitly specify the equivalent chain.
  File: `apps/runtime/src/middleware/auth.ts:194` vs LLD Phase 3 task 3.7 | Fix: Clarify that the LLD means `authMiddleware` (which internally calls `createUnifiedAuthMiddleware` + `requireAuthWithTenant`), not the raw `createUnifiedAuthMiddleware`.

- **[MEDIUM] Right-to-erasure cascade not addressed.**
  CLAUDE.md compliance invariant #5 requires right-to-erasure cascades. The LLD introduces a new `agent_assist_bindings` collection with `tenantId` and `projectId`. If a project is deleted, bindings for that project should be cleaned up. If a tenant is deleted, all bindings should be deleted. The LLD does not mention this.
  File: LLD missing | Fix: Add a note in Phase 1 or Phase 5 specifying that project-delete and tenant-delete cascades must include `agent_assist_bindings` cleanup, either via existing cascade hooks or a new listener.

- **[MEDIUM] Cross-pod cache staleness acknowledged but no invalidation mechanism specified.**
  Open question #7 acknowledges that in-process cache invalidation is pod-local only. The LLD should at minimum specify the TTL as a named constant (not inline `60`) and document that staleness window equals TTL. This is acceptable for Phase Actual but should be a tracked follow-up.
  File: LLD Phase 1, task 1.2 and Open question #7 | Fix: No code change needed, but add the TTL constant name to the LLD and ensure the exit criteria includes a test that verifies cache expiry.

### VERIFIED

- [x] **Resource isolation** — Repo layer enforces `tenantId` filter on every query (belt-and-braces with `tenantIsolationPlugin`). Cross-scope returns 404 (not 403) at the route handler (verified in POC code `agent-assist.ts:117-143`). Project-scope check via `projectScope` array is present.
- [x] **Centralized auth** — Uses `authMiddleware` from `../middleware/auth.js` which wraps `createUnifiedAuthMiddleware`. No custom `jwt.verify` or manual `Authorization` parsing. `requirePermission('session:send_message')` is a real export from `@agent-platform/shared-auth`.
- [x] **Stateless distributed** — In-process cache explicitly documented as never-authoritative with TTL. BullMQ for async work. No pod-local state as source of truth.
- [x] **Traceability** — All 8 `agent_assist.*` trace events from FR-29 have explicit call sites listed in Phase 3 task 3.7. Events registered in `trace-event-registry.ts` (existing pattern).
- [x] **Performance** — `AGENT_ASSIST_MAX_BODY_BYTES` (512 KiB) as named constant. `AGENT_ASSIST_MAX_INPUT_CHARS` (16000). `AGENT_ASSIST_MAX_AA_HISTORY_MSGS` (50). No inline magic numbers.
- [x] **Express route ordering** — Not applicable; facade uses its own sub-router with parameterized paths only.
- [x] **Commit discipline** — 5 phases map to additive commits. Section 2.3 explicitly states "No exported symbol removal."
- [x] **E2E test quality** — E2E tests specify real Express on `port:0`, real middleware chain, real HTTP. DI for LLM doubles only. No `vi.mock` of internal packages.
- [x] **No `any`** — Interfaces use discriminated unions (`status: 'active' | 'disabled'`).
- [x] **Error patterns** — POC code already uses `err instanceof Error ? err.message : String(err)`.

### NOTES

- The POC `authMiddleware` import at `agent-assist.ts:32` is the runtime's full auth stack (not raw `createUnifiedAuthMiddleware`). The LLD should be precise about which one it means.
- The `requireFeature` 403-to-404 conversion is the most architecturally significant finding. Without it, the feature gate leaks information about which tenants have the feature enabled.
- The `fail-open` behavior of `requireFeature` is partially mitigated by the binding-resolution step (no binding = 404), but a DB outage that affects feature-gate resolution could still affect binding resolution, making the mitigation incomplete.
- Worker `lockDuration` must exceed the callback POST timeout (10s) plus envelope-build time. Recommend 30s minimum.

---

## LLD-Reviewer Round 2 — Pattern Consistency

**Reviewer**: lld-reviewer
**Date**: 2026-04-22
**Focus**: Does the LLD reuse existing codebase patterns, or reinvent wheels?

---

### VERDICT: NEEDS_CHANGES

### ISSUES

- **[CRITICAL] `logAdminAction` arg shape mismatch — LLD assumes `{ subject, action, before, after, actor }`, actual signature is `{ actor, actorRole, action, target, environment?, ipAddress?, metadata? }` with `action` constrained to `AdminAction` union type.**
  The LLD Phase 2 task 2.2 says: `logAdminAction({ subject: "agent_assist_binding", action: "create", tenantId, before: null, after: <record>, actor })`. The actual signature at `apps/admin/src/lib/audit-logger.ts:44` is `logAdminAction(entry: Omit<AuditEntry, 'timestamp'>)` where `AuditEntry` has fields `{ actor, actorRole, action: AdminAction, target, environment?, ipAddress?, metadata? }`. The `AdminAction` type is a union of `'config_view' | 'secret_list' | 'secret_create' | 'secret_update' | 'secret_delete' | 'secret_rotate'` — it does not include any `agent_assist_binding_*` values. There is no `subject`, `before`, or `after` field.
  File: `apps/admin/src/lib/audit-logger.ts:9-26,44` | Fix: (a) Extend `AdminAction` union with `'binding_create' | 'binding_update' | 'binding_delete' | 'binding_disable' | 'binding_enable'`. (b) Update LLD call sites to use the actual shape: `logAdminAction({ actor: ctx.user.userId, actorRole: ctx.user.role, action: 'binding_create', target: bindingId, ipAddress: ctx.user.ipAddress, metadata: { tenantId, before: null, after: record } })`. (c) Stash `before`/`after` inside `metadata`, not as top-level fields.

- **[HIGH] Trace event registration requires a new domain group, not just appending event names.**
  The LLD task 3.2 says "Append `agent_assist.*` event names to `trace-event-registry.ts`." But the registry at `packages/shared-kernel/src/constants/trace-event-registry.ts` is structured as domain-specific `const` arrays (e.g., `CHANNEL_TRACE_EVENT_TYPES`, `A2A_TRACE_EVENT_TYPES`), each with a corresponding type, a key in `TRACE_EVENT_GROUPS`, and a spread into `ALL_TRACE_EVENT_TYPES`. The LLD does not specify creating an `AGENT_ASSIST_TRACE_EVENT_TYPES` array, a `AgentAssistTraceEventType` type, adding an `agent_assist` key to `TRACE_EVENT_GROUPS`, spreading into `ALL_TRACE_EVENT_TYPES`, or adding entries to `RUNTIME_EVENT_TYPES`. Without this, the events won't be part of the `TraceEventType` union and won't pass type checks.
  File: `packages/shared-kernel/src/constants/trace-event-registry.ts:257-278,282-305,315-421` | Fix: LLD task 3.2 must specify: (1) create `AGENT_ASSIST_TRACE_EVENT_TYPES` const array, (2) export `AgentAssistTraceEventType`, (3) add `agent_assist` to `TRACE_EVENT_GROUPS`, (4) spread into `ALL_TRACE_EVENT_TYPES`, (5) add to `RUNTIME_EVENT_TYPES`, (6) add `registryEntriesForDomain('agent_assist', ...)` to `TRACE_EVENT_REGISTRY`.

- **[HIGH] `PLAN_FEATURES` is a `Record<string, string[]>` of plan tiers, not a feature registry — LLD must specify WHICH tiers get `agent_assist`.**
  The LLD task 3.1 says "Add `agent_assist` to `plan-features.ts`" but `PLAN_FEATURES` at `packages/shared-kernel/src/constants/plan-features.ts` is a map from plan tier (`FREE`, `TEAM`, `BUSINESS`, `ENTERPRISE`) to arrays of feature strings. The LLD must specify which plan tiers include `agent_assist`. The decision log says "Default OFF across all existing plans" (section 5.2), so it should NOT be added to any tier array initially — it should only be grantable via Deal documents. This means `requireFeature('agent_assist')` will always fall through to 403 unless a Deal exists. The LLD should make this explicit.
  File: `packages/shared-kernel/src/constants/plan-features.ts:12-38` | Fix: Task 3.1 should state: "Do NOT add `agent_assist` to any tier in `PLAN_FEATURES`. The feature is grantable only via Deal documents initially. The `requireFeature` middleware already checks deals first (line 88-100 of feature-gate.ts), so this works without code changes to `plan-features.ts`." If no change to the file is needed, remove it from the file-change map or note it as "no change needed."

- **[HIGH] No existing shared LRU helper in ABL — LLD task 1.2 says "use the existing `shared-kernel` LRU helper" but none exists.**
  I verified `packages/shared-kernel/src/` and found no LRU cache utility. The `auth-profile-repo` referenced in the LLD as having a "bounded-cache pattern" also does not exist at the expected path. The LLD should either (a) specify implementing a simple bounded LRU inline in the repo (a `Map` with size cap + TTL + LRU eviction — ~40 lines), or (b) use the `lru-cache` npm package (already a dependency in other packages). Do NOT create a new shared-kernel utility for a single consumer.
  File: LLD Phase 1 task 1.2 | Fix: Remove the reference to a nonexistent "shared-kernel LRU helper." Specify: use a local bounded `Map` with `AGENT_ASSIST_BINDING_CACHE_MAX` (500) / `AGENT_ASSIST_BINDING_CACHE_TTL_MS` (60000) constants, implementing LRU eviction by tracking access order. Or if `lru-cache` npm package is available, use it.

- **[MEDIUM] Admin routes use `withAdminRoute` wrapper, not raw middleware — LLD should specify this pattern.**
  The LLD task 2.0 says "Run through the existing admin auth middleware." The actual pattern is `withAdminRoute({ role: 'ADMIN' }, async (ctx) => { ... })` from `apps/admin/src/lib/with-admin-route.ts`. This wrapper handles JWT verification, role checks, session age, idle timeout, and anti-spoofing. The `ctx` provides `user` (with `userId`, `email`, `role`, `ipAddress`, `isSuperAdmin`), `params`, `request`, and `token`. The LLD should specify using `withAdminRoute` with the correct role level and `AdminRouteContext` typing. There is no separate `assertTenantAccess` helper — tenant access is implicit in the admin's JWT scope. Admin routes that are tenant-scoped proxy to runtime with tenant context; direct DB access admin routes are not common.
  File: `apps/admin/src/lib/with-admin-route.ts:1-53` | Fix: Task 2.0 should say: "Every route handler uses `withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => { ... })`. Tenant isolation comes from the admin user's JWT claims. The `ctx.params.tenantId` is the path segment. Since these routes access MongoDB directly (not proxying to runtime), add a tenant-scope check: verify `ctx.user` has access to `params.tenantId` via a lightweight lookup (e.g., the user's `isSuperAdmin` flag or org membership)." Drop the proposed `apps/admin/src/lib/agent-assist-auth.ts` helper unless the tenant-scope logic is complex enough to warrant extraction.

- **[MEDIUM] HMAC signing — no existing reusable helper in ABL. A2A uses Bearer token auth, not HMAC.**
  The LLD proposes creating `apps/runtime/src/services/agent-assist/hmac.ts`. I verified the A2A push notification delivery at `packages/a2a/src/application/push-notification-delivery.ts` — it uses a simple `Authorization: Bearer <token>` header, not HMAC signing. There is no existing HMAC helper to reuse. Creating `hmac.ts` in the facade service module is the correct approach. No finding — this is confirmed as acceptable.
  File: N/A | No change needed.

- **[MEDIUM] Wiring checklist item says `createUnifiedAuthMiddleware` but should say `authMiddleware`.**
  Section 4 wiring checklist says "Router middleware chain: kill-switch env check -> `createUnifiedAuthMiddleware` -> ..." but the POC code and the corrected LLD task 3.7 both use `authMiddleware` (the runtime wrapper). The wiring checklist is inconsistent with the task description.
  File: LLD Section 4 wiring checklist, bullet 4 | Fix: Change `createUnifiedAuthMiddleware` to `authMiddleware` in the wiring checklist.

- **[LOW] Zod `.strict()` usage — LLD specifies it for admin schemas but should also note it for runtime schemas.**
  The `workflows-execute.ts` pattern uses `.strict()` on body schemas (line 46). The LLD task 2.1 correctly specifies `.strict()` for admin schemas. The LLD task 3.10 (schema tightening) should also confirm `.strict()` on `v1ExecuteBodySchema` and `v1SessionsBodySchema` if not already present.
  File: LLD Phase 3 task 3.10 / `apps/runtime/src/routes/agent-assist.schemas.ts` | Fix: Add a note to task 3.10 verifying `.strict()` on runtime schemas.

### VERIFIED

- [x] **Mongoose model pattern** — `tenantIsolationPlugin` import path is `../mongo/plugins/tenant-isolation.plugin.js` and `auditTrailPlugin` is `../mongo/plugins/audit-trail.plugin.js`. LLD correctly specifies both plugins. Pattern matches `auth-profile.model.ts` and `channel-connection.model.ts`.
- [x] **Middleware chain order** — POC already uses `json` -> `authMiddleware` -> kill-switch -> handler. LLD Phase 3 adds `requireFacadeFeature` and `tenantRateLimit` in the correct position. `workflows-execute.ts` confirms `tenantRateLimit('request')` usage (line 283).
- [x] **BullMQ worker startup** — Runtime workers are started in `server.ts` (not `index.ts`). LLD task 4.5 says `index.ts` which may be wrong; verify at implementation time whether workers boot from server.ts or index.ts. The LLD is acceptable either way as long as the implementer follows the existing pattern.
- [x] **Feature gate wrapper** — LLD task 3.7b correctly specifies wrapping `requireFeature` (not forking it), converting 403->404 and fail-open->fail-closed. This matches the `createFailClosedFeatureGate` pattern already in `feature-gate.ts`.
- [x] **Error response pattern** — POC uses `{ error: { code, message } }` which is the V1-compat shape. Admin routes should use `{ success: false, error: { code, message } }` per the `withAdminRoute` convention. LLD should be explicit about which shape each surface uses.

### NOTES

- The `logAdminAction` mismatch is the highest-risk finding — implementing against the LLD's assumed shape will cause type errors at compile time. Fix the LLD before implementation.
- The trace event registration pattern is detailed but mechanical — the implementer just needs to follow the existing domain-group structure exactly.
- Admin routes that access MongoDB directly (not proxying to runtime) are uncommon in this codebase — most admin routes proxy to runtime. The binding CRUD routes will be one of the first admin routes with direct DB access, so the pattern should be established carefully.

---

## LLD-Reviewer Round 2 — Resolutions Applied

**Date**: 2026-04-22
**LLD**: `docs/plans/2026-04-22-agent-assist-runtime-compat-impl-plan.md` (updated)

### Fixes applied from Round 2 findings

1. **[CRITICAL] `logAdminAction` signature mismatch** — D-3 now explicitly uses the canonical `Omit<AuditEntry,'timestamp'>` shape (`actor`, `actorRole`, `action`, `target`, `ipAddress`, `metadata`). Before/after diffs go under `metadata`, not top-level. Added task 2.0b mandating a 5-member extension of the `AdminAction` union at `apps/admin/src/lib/audit-logger.ts:9-15`. Rewrote task 2.2 with a verbatim call-site example. Added `audit-logger.ts` to Phase 2 files-touched and exit-criteria-assertion #2 ("tsc --noEmit passes with new members used as literal types").

2. **[HIGH] Trace event 6-step registration** — Added D-14 codifying the pattern (const array → type alias → `TRACE_EVENT_GROUPS` key → `ALL_TRACE_EVENT_TYPES` spread → `RUNTIME_EVENT_TYPES` entries → `registryEntriesForDomain` spread). Rewrote Phase 3 task 3.2 with all 6 numbered substeps and the exact `AGENT_ASSIST_TRACE_EVENT_TYPES` declaration. Wiring checklist item updated to require grep evidence at each insertion point.

3. **[HIGH] `PLAN_FEATURES` rollout strategy** — D-7 rationale updated: `PLAN_FEATURES` is a plan-tier → features map and `requireFeature` resolves `Deal.features[]` first. Initial rollout is Deal-grant only — no `plan-features.ts` change needed. Phase 3 task 3.1 explicitly says DO NOT modify it. Removed `plan-features.ts` from Phase 3 files-touched list. §5.2 rewritten to explain the Deal-grant pilot posture.

4. **[HIGH] No shared LRU helper exists** — Confirmed: no `lru-cache` npm dep, two hand-rolled classes with different feature sets, neither TTL+max. Added D-11 rationale and new file `packages/shared-kernel/src/cache/lru-ttl-cache.ts` (+ barrel + unit tests). Phase 1 now has a prereq task 1.2 (helper) before 1.2b (binding-repo). Binding-repo consumes `LRUTTLCache<IAgentAssistBinding>` via `@agent-platform/shared-kernel`. Exit criteria assert both size eviction and TTL expiry via clock injection.

5. **[MEDIUM] `withAdminRoute({ role: 'ADMIN' }, handler)`** — Rewrote task 2.0 to match the real wrapper signature. Dropped the proposed `assertTenantAccess` helper and `apps/admin/src/lib/agent-assist-auth.ts` idea (rejected in D-13 rationale because `AdminRouteUser` has no per-admin tenant scope — the admin app's current posture is super-admin-only). Defense-in-depth is the repo-level `tenantIsolationPlugin`. Per-admin tenant-scope RBAC tracked as open question §7-2.

6. **[MEDIUM] Wiring checklist `authMiddleware`** — Updated §4 bullet 4 from `createUnifiedAuthMiddleware` → `authMiddleware` with line reference `apps/runtime/src/middleware/auth.ts:194-202` (the compound wrapper). Also updated Phase 3 task 3.7 middleware-chain text and the module-boundaries table (section 1.3 entry for `routes/agent-assist.ts`).

### Summary

- 1 CRITICAL + 3 HIGH + 2 MEDIUM → all resolved in-artifact.
- 3 new decisions added: D-13 (admin tenant-scope posture), D-14 (trace-event 6-step), plus expanded D-3, D-7, D-11.
- 2 new files in the plan: `packages/shared-kernel/src/cache/lru-ttl-cache.ts`, `apps/runtime/src/services/agent-assist/feature-gate.ts`.
- 0 references to stale signatures remain (verified via grep for `createUnifiedAuthMiddleware`, `subject:`, `assertTenantAccess`, `agent-assist-auth.ts`).

Proceeding to Round 3 (completeness — every FR covered, file paths verified, signatures checked).

---

## LLD-Reviewer Round 3 — Completeness

**Date**: 2026-04-22
**Focus**: FR coverage, file path verification, signature checks, test-spec cross-ref, exit-criteria measurability, wiring-checklist completeness, Phase-Actual contract precision.

### VERDICT from reviewer: NEEDS_CHANGES (2 HIGH, 2 MEDIUM, 1 LOW)

### Fixes applied from Round 3 findings

1. **[HIGH] Worker bootstrap location wrong** — Round-3 reviewer confirmed that `apps/runtime/src/index.ts` has no worker startup code (only calls `startServer()`). All workers are started inside `apps/runtime/src/server.ts::wireAsyncInfra()` (function at line 1313, Redis branch at lines 1394-1555, examples at 1522 `startResumptionWorker` and 1534 `startSuspensionTimeoutWorker`). Rewrote Phase 4 task 4.5 with the correct path + line refs, gated behind the Redis availability check (lines 1319-1321). Updated Phase 4 files-touched from `index.ts` → `server.ts` and the wiring-checklist bullet.

2. **[HIGH] Admin routes — proxy vs direct DB ambiguity** — Round-3 reviewer flagged that ALL existing admin tenant-scoped routes (`apps/admin/src/app/api/tenants/[tenantId]/feature-toggle/route.ts`, and every `apps/runtime/src/routes/platform-admin-*.ts` sibling) use the proxy pattern, not direct DB. Added **D-15** codifying the proxy pattern. Rewrote Phase 2 entirely:
   - Task 2.0 now creates a runtime-side `apps/runtime/src/routes/platform-admin-agent-assist.ts` with 7 CRUD handlers, mounted under `/api/platform/admin/agent-assist` via `platformAdminAuthMiddleware`.
   - Task 2.0b makes admin Next.js routes thin proxies (`withAdminRoute` → `fetch(getRuntimeBaseUrl + ...)` → `logAdminAction` on 2xx).
   - Added 3 new test files (runtime integration test + admin proxy integration + admin proxy unit).
   - Retired the old direct-DB admin integration + unit tests.
   - Exit criteria updated to cover both surfaces, including grep-verifiable mount line.

3. **[MEDIUM] Cascade path was hedged as `(or equivalent)`** — verified the actual cascade module at `packages/database/src/cascade/cascade-delete.ts`: `deleteProject(projectId, tenantId?)` at line 199 and `deleteTenant(tenantId)` at line 49 (both real and actively used). Rewrote Phase 5 task 5.7b with exact insertion points (~line 348 for project, ~line 180 for tenant), exact `deleteMany` pattern, and runtime wrappers at `cascade-repo.ts:83-127` + line 22. Added integration-test cases covering both project and tenant cascades with isolation assertions (other-project / other-tenant bindings untouched). Removed open question §7-8 since tenant-delete cascade is now confirmed and wired.

4. **[MEDIUM] BullMQ backoff cap comment inconsistency** — corrected `attempts: 5` → `attempts: 6` so the 30-s backoff actually happens on attempt 6 (1 → 2 → 4 → 8 → 16 → 30 s). Updated the trailing prose to match (total ~61 s across 6 attempts).

5. **[LOW] Callback URL validation location** — added **D-16** codifying the layered approach: syntactic checks (missing URL with `isAsync:true`, malformed URL) at the Zod route handler → 400 fast; allowlist policy (HTTPS-only or `http://localhost`) at the worker → DLQ with `agent_assist.callback_failed` trace. Documented the async-contract rationale for why allowlist failures don't propagate to sync 4xx.

### VERIFIED items from round-3 auditor (no changes needed)

- All 31 FRs covered
- All 7 E2E + 5 integration scenarios have tasks
- File paths all exist or have plausible parent dirs
- All signatures match verified source (`logAdminAction`, `withAdminRoute`, `registryEntriesForDomain`, `authMiddleware`, `requireFeature`)
- D-14 6-step order is correct (type must precede `TRACE_EVENT_GROUPS` key consumption)
- D-7 plan-features posture correct (Deal-first resolution)
- Exit criteria all measurable
- Round 1 + 2 findings remain resolved (no re-flagging)

### Summary

- 2 HIGH + 2 MEDIUM + 1 LOW → all resolved in-artifact.
- 2 new decisions added: D-15 (admin proxy pattern), D-16 (layered callback URL validation).
- 1 previously-open question closed (§7-8 tenant-delete cascade).
- Phase 2 fully restructured to proxy pattern; 3 new test files (runtime + admin proxy integration + admin proxy unit); old direct-DB tests retired.

Proceeding to Round 4 (cross-phase consistency via phase-auditor — does the LLD implement the HLD, and does it cover the test spec's scenarios end-to-end?).

---

## Phase-Auditor Round 4 — Cross-Phase Consistency

**Date**: 2026-04-22
**Focus**: HLD → LLD implementation completeness, 12-concerns coverage, test-spec → LLD coverage, phase-order correctness, no-regression from rounds 1-3, Phase-Actual contract precision.

### VERDICT from reviewer: APPROVED (1 HIGH acknowledgment + 2 MEDIUM)

### Fixes applied from Round 4 findings

1. **[HIGH] `LRUTTLCache<V>` new scope not in HLD** — Acknowledged. Added a final acceptance-criteria item to §6 mandating that `/post-impl-sync` after Phase 5 appends `LRUTTLCache` (D-11) and proxy-admin architecture (D-15) to the HLD data-model + component-diagram sections. This closes the loop so future features see them as first-class.

2. **[MEDIUM] Retry count `attempts: 6` vs HLD/test-spec "max 5"** — Aligned to 5 (1 initial + 4 retries). Updated BullMQ queue config to `attempts: 5`, delay prose to 1/2/4/8 s (no 30 s clamp reached), lockDuration commentary to reflect 5-attempt worst-case envelope (~4 min total wallclock at 10-s POST timeouts). INT-3's "4 retries observed" assertion now exactly matches (5 total attempts = 1 initial + 4 retries).

3. **[MEDIUM] `AgentAssistCallbackJob.envelope: V1ExecuteResponse` contradicts worker-replay** — Removed the pre-built `envelope` field. Replaced with `input: { v1RequestBody, callerUserId, authScopes }`. The worker now replays `executeMessage` against the deterministic session per HLD concern 6 (idempotency) and concern 7 (stable sessionId via UUIDv5 keying ensures replay reuses the session row). Added a leading comment above the interface explaining the replay-model choice and pod-crash safety.

### Round 4 summary

- 1 HIGH (acknowledgment) + 2 MEDIUM → all resolved.
- No new decisions added (fixes are clarifications, not new design choices).
- `attempts: 5` now canonical across HLD, LLD, test spec.
- Job payload carries input, not a built envelope — consistent with HLD execution model.

All prior-round findings remain resolved — no regressions detected.

Proceeding to Round 5 (final sweep via lld-reviewer: task independence, wiring checklist, domain rules, any remaining gaps).

---

## LLD-Reviewer Round 5 — Final Sweep

**Date**: 2026-04-22
**Focus**: Task independence, wiring-checklist completeness, domain-rules compliance, contract precision, open-questions triage, no-regression, implementation readiness.

### VERDICT: APPROVED

### Findings

- **[LOW]** Feature-gate helper extraction (task 3.7b) should return a boolean, not an HTTP response with interpolated `featureName` — keeps the user-facing sanitation invariant intact. Implementation tip, not LLD change.
- **[LOW]** Phase 5 task 5.7b cascade line numbers (~348, ~180) are approximate — implementer should grep for the nearest `deleteMany` block rather than relying on exact line numbers (they may drift if other features merge first).

### No CRITICAL / HIGH / MEDIUM findings. No regressions detected.

### Implementation tips from the auditor

1. Read `apps/admin/src/app/api/tenants/[tenantId]/feature-toggle/route.ts` as the canonical admin-proxy example — its error-handling edge cases (e.g., 502 on runtime failure) are instructive.
2. `registryEntriesForDomain('agent_assist', ...)` requires the `'agent_assist'` key in `TRACE_EVENT_GROUPS` — D-14 step 3 MUST land before step 6 or TypeScript rejects.
3. Phase 1 and Phase 2 can be committed independently; Phase 3 depends on both; Phase 4 depends on Phase 3; Phase 5 depends on all prior.
4. `deleteProject` in cascade-delete.ts accepts optional `tenantId`; the cascade `deleteMany({ projectId })` uses project-scoped delete matching existing pattern — tenantIsolationPlugin is the belt-and-braces tenant floor.
5. Commit-size guard: Phase 1 touches 3 packages (shared-kernel + database + runtime) = at limit. Phase 2 touches 2 packages (runtime + admin). All within CLAUDE.md 3-package cap.

### Round 5 summary

- Zero blockers remain.
- 5-round audit cycle complete: R1 (2C + 3H), R2 (1C + 3H), R3 (2H + 2M), R4 (1H + 2M), R5 (0C + 0H).
- LLD is ready for implementation.

### Next step

Execute `/implement` or spawn implementation agents per phase. User has requested NO commits — work stays uncommitted in this worktree until user validates via ngrok against real Kore.ai APIs.
