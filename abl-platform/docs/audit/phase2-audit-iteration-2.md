# Phase 2 Audit — Iteration 2

**Date:** 2026-03-18
**Auditor:** Architecture Review Agent
**Scope:** All Phase 2 files (tasks 2.1–2.12, scenarios IS-2.1 through IS-2.8)
**Prior Audit:** Iteration 1 found 12 issues (3 critical, 4 high, 4 medium, 1 low)

---

## VERDICT: PASS

All 3 critical and 4 high issues from Audit 1 have been correctly resolved. No new critical or high issues found. Two medium and one low observation remain as implementation notes.

---

## Audit 1 Fix Verification

### CRITICAL-1: Config var resolution before resolveByName — VERIFIED

- **File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:54-69`
- **Status:** Fixed. `resolveAuthProfileRef()` is called when `tool.auth_profile_ref` contains `{{` before calling `resolveByName()`. Config var pattern regex `^\{\{config\.(\w+)\}\}$` correctly matches full template strings.

### CRITICAL-2: resolveByName uses AuthProfileCache singleton — VERIFIED

- **File:** `apps/runtime/src/services/auth-profile-resolver.ts:21,141-145,224`
- **Status:** Fixed. Module-level `const cache = new AuthProfileCache()` singleton. `getByName()` checked on entry, `setByName()` called after DB fetch. Cache key includes tenant + name + environment.

### CRITICAL-3: resolveToolAuth wired into tool middleware chain — VERIFIED

- **File:** `apps/runtime/src/services/execution/llm-wiring.ts:67,493-504`
- **Status:** Fixed. `createAuthProfileToolMiddleware` imported and registered in middleware chain. Conditional: only when `resolvedTenantId` exists AND `allTools.some((t) => t.auth_profile_ref)`. Positioned before HttpToolExecutor's inline auth, after secret scrubber/validation.

### HIGH-1: Integration test imports real resolveToolAuth — VERIFIED

- **File:** `apps/runtime/src/__tests__/auth-profile-tool-executor-integration.test.ts:42`
- **Status:** Fixed. `import { resolveToolAuth } from '../services/auth-profile/resolve-tool-auth.js'` — real module, not inline copy. Mocks are only on DB layer (`@agent-platform/database/models`).

### HIGH-2: search-ai resolveByName supports bearer tokens — VERIFIED

- **File:** `apps/search-ai/src/services/auth-profile-resolver.ts:226`
- **Status:** Fixed. `const apiKey = String(secrets?.apiKey ?? secrets?.token ?? secrets?.accessToken ?? '')` — covers api_key, bearer, and OAuth token field names.

### HIGH-3: Grace period uses shared function — VERIFIED

- **File:** `apps/runtime/src/services/auth-profile-resolver.ts:86-113` and `apps/search-ai/src/services/auth-profile-resolver.ts:240-269`
- **Status:** Fixed. Both resolvers import `resolveWithGracePeriod` from `@agent-platform/shared/services/auth-profile` and use the same passthrough-decrypt pattern for Mongoose auto-decrypted fields.

### HIGH-4: auth-config-builder design decision comment — VERIFIED

- **File:** `packages/compiler/src/platform/ir/auth-config-builder.ts:42-46`
- **Status:** Fixed. Clear JSDoc explains: "auth_profile_ref precedence is enforced at runtime, not at compile time. The compiler emits both auth_profile_ref and inline auth into the IR."

### MEDIUM-1: Resolved config var value removed from logs — VERIFIED

- **File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:214-216`
- **Status:** Fixed. `log.debug('Resolved config variable in auth_profile_ref', { configKey })` — logs only the key name, not the resolved value.

### MEDIUM-2: Compound index on { name, tenantId, status, environment } — VERIFIED

- **File:** `packages/database/src/models/auth-profile.model.ts:193`
- **Status:** Fixed. `AuthProfileSchema.index({ name: 1, tenantId: 1, status: 1, environment: 1 })` present. Uniqueness indexes also added (lines 196-203) with partial filter expressions for null projectId handling.

### MEDIUM-3: Expired env-specific profile fallback test — VERIFIED

- **File:** `apps/runtime/src/__tests__/auth-profile-resolve-by-name.test.ts:175-192`
- **Status:** Fixed. Test case "falls back to default profile when environment-specific profile is expired" verifies the DB-level $or expiry filter causes env match to return null, triggering fallback to default profile.

### MEDIUM-4: `any` replaced with AuthProfileDocument interface — VERIFIED

- **File:** `apps/runtime/src/services/auth-profile-resolver.ts:31-45`
- **Status:** Fixed. `AuthProfileDocument` interface defines all relevant fields. Used as the type for `profile` in `resolveByName()` (line 156).

---

## New Code Audit: auth-profile-tool-middleware.ts

**File:** `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`

### Correct

- [x] Imports `ToolMiddleware`, `ToolCallContext`, `ToolCallResult`, `ToolMiddlewareNext` from `@abl/compiler` — matches actual types in `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`
- [x] Early return via `next(ctx)` when `tool?.auth_profile_ref` is falsy — no unnecessary DB lookups
- [x] Creates a shallow copy of the tool (`patchedTool`) to avoid mutating the shared IR definition
- [x] Sets `auth: { type: 'none' }` on patched http_binding — correctly prevents HttpToolExecutor from double-applying inline auth
- [x] Error handling: `err instanceof Error ? err.message : String(err)` — follows platform standard
- [x] Re-throws after logging — errors propagate to caller (not swallowed)
- [x] Properly passes `configVarStore` through options to `resolveToolAuth`
- [x] Uses `createLogger('auth-profile-tool-middleware')` — correct pattern

### Observations

- [x] When `authResult.source === 'auth_profile'` but headers are empty (e.g., unknown auth type that resolveToolAuth's switch falls through with no headers), the middleware falls through to `next(ctx)` without patching. This is correct — the tool runs without auth profile headers, and the fallback default case in resolveToolAuth already logs this.

---

## Full Integration Path Trace

### DSL Parser (core)

- `packages/core/src/parser/tool-file-parser.ts:482-486` — `auth_profile:` parsed to `result.authProfileRef`, `auth_jit:` parsed to `result.jitAuth`

### AST Types (core)

- `packages/core/src/types/agent-based.ts:529,531` — `authProfileRef?: string` and `jitAuth?: boolean` on ToolDefinition AST

### Compiler IR Schema

- `packages/compiler/src/platform/ir/schema.ts:634,637` — `auth_profile_ref?: string` and `jit_auth?: boolean` on ToolDefinition IR

### Compiler (AST to IR)

- `packages/compiler/src/platform/ir/compiler.ts:721-722` — `auth_profile_ref: tool.authProfileRef` and `jit_auth: tool.jitAuth` emitted in tool compilation

### Compiler Validation

- `packages/compiler/src/platform/ir/validate-preflight.ts:165-192` — `validateAuthJitRequiresProfile()` warns when `jit_auth` set without `auth_profile_ref`. Validation code registered in `validation-types.ts:76`.

### Runtime Middleware Wiring

- `apps/runtime/src/services/execution/llm-wiring.ts:493-504` — `createAuthProfileToolMiddleware` registered when tools have `auth_profile_ref`

### Runtime Tool Middleware

- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` — intercepts tool calls, calls `resolveToolAuth`, patches `http_binding.headers`

### Runtime resolveToolAuth

- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — config var resolution, then `resolveByName()`, then auth type switch to build headers

### Runtime resolveByName

- `apps/runtime/src/services/auth-profile-resolver.ts:135-227` — cache check, DB query with tenant isolation + environment fallback, grace period secret resolution, cache populate

### Runtime Cache

- `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` — LRU cache with max 200 entries, 5min TTL, name-based and ID-based keys, eviction

**Path is complete. No broken links.**

---

## Remaining Observations (Non-blocking)

### MEDIUM-1: resolveToolAuth duplicates auth-type dispatch logic

- **File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:93-125`
- **Observation:** The `switch(profile.authType)` in `resolveToolAuth` manually builds headers for 4 auth types (api_key, bearer, basic, custom_header). The platform already has `applyAuth()` in `packages/shared-auth-profile/src/apply-auth.ts` that handles all 17 auth types. The middleware approach (patching headers into http_binding) works correctly for the 4 types handled, but OAuth2 (app, token, client_credentials), aws_iam, and other auth types will silently produce empty headers and fall through to the default case.
- **Risk:** Low for Phase 2 (only api_key, bearer, basic, custom_header are expected DSL use cases). Will need to be extended or refactored to use `applyAuth()` when mTLS and OAuth tool profiles are added in Phase 3+.
- **Recommendation:** Add a TODO comment in the file referencing the Phase 3 plan to consolidate with `applyAuth()`. The current behavior (log debug + proceed with empty headers) is acceptable but should not silently succeed in production for unsupported auth types — consider logging at warn level instead of debug for the default case.

### MEDIUM-2: search-ai resolveByName has no cache

- **File:** `apps/search-ai/src/services/auth-profile-resolver.ts:177-234`
- **Observation:** The runtime resolver uses `AuthProfileCache` singleton for name-based lookups, but the search-ai resolver does not have any cache. Since search-ai workers may resolve the same profile many times during pipeline processing, this could result in unnecessary DB queries.
- **Risk:** Low (search-ai workers typically have longer-lived connections and fewer resolutions per request than runtime).
- **Recommendation:** Consider adding cache in Phase 3 if DB query volume becomes significant.

### LOW-1: Config var regex only supports single-variable templates

- **File:** `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts:148`
- **Observation:** `CONFIG_VAR_PATTERN = /^\{\{config\.(\w+)\}\}$/` requires the entire string to be a single config var reference. Templates like `prefix-{{config.X}}` or `{{config.X}}-{{config.Y}}` are not supported — they will be treated as literal profile names.
- **Risk:** None currently — the spec only requires `{{config.VAR}}` format. This is a correct design decision documented implicitly by the regex anchoring (`^` and `$`).

---

## Test Coverage Assessment

| Test File                                          | Coverage                                                                              | Status |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| `auth-profile-tool-executor-integration.test.ts`   | resolveToolAuth happy path, precedence, errors, config var, jit_auth                  | Good   |
| `auth-profile-resolve-by-name.test.ts` (runtime)   | Name resolution, tenant isolation, environment fallback, expired fallback, lastUsedAt | Good   |
| `auth-profile-config-var-resolution.test.ts`       | Config var interpolation, literal passthrough, missing var                            | Good   |
| `auth-profile-cache-name-based.test.ts`            | Name-based cache CRUD, TTL, eviction, invalidation, capacity                          | Good   |
| `auth-profile-resolve-by-name.test.ts` (search-ai) | Name resolution, tenant isolation, environment fallback, bearer token support         | Good   |

**Gap:** No test for the `createAuthProfileToolMiddleware` function directly — it is tested indirectly through the integration test that tests `resolveToolAuth`. A dedicated unit test for the middleware's tool-patching behavior (shallow copy, auth override to none, header merge) would strengthen coverage.

---

## Phase 2 Exit Criteria Check

- [x] DSL `auth_profile: "name"` compiles to IR with `auth_profile_ref` (verified: parser line 482, compiler line 721)
- [x] DSL `auth_jit: true` compiles to IR with `jit_auth: true` (verified: parser line 485, compiler line 722)
- [x] Runtime resolves auth profiles by name with tenant isolation (verified: resolveByName with tenantId in query)
- [x] Config variable interpolation works end-to-end (verified: resolveAuthProfileRef + integration test)
- [x] Compile-time validation: jit_auth without auth_profile emits warning (verified: validate-preflight.ts:178)
- [x] auth_profile_ref precedence over inline auth (verified: resolve-tool-auth.ts:54, middleware sets auth.type to 'none')
- [x] Cache integration for name-based lookups (verified: AuthProfileCache with getByName/setByName)
- [x] Database index for name-based queries (verified: auth-profile.model.ts:193)

---

## Integration Scenarios Coverage

| Scenario                                       | Covered By                                                                            | Status                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| IS-2.1: DSL to HTTP call happy path            | `auth-profile-tool-executor-integration.test.ts` + middleware wiring in llm-wiring.ts | Covered (unit), needs E2E         |
| IS-2.2: Tenant isolation                       | `auth-profile-resolve-by-name.test.ts` (both runtime and search-ai)                   | Covered                           |
| IS-2.3: Environment fallback                   | `auth-profile-resolve-by-name.test.ts` lines 102-192                                  | Covered                           |
| IS-2.4: auth_profile precedence                | `auth-profile-tool-executor-integration.test.ts` line 108                             | Covered                           |
| IS-2.5: auth_jit compiles but fails gracefully | `auth-profile-tool-executor-integration.test.ts` line 138                             | Covered                           |
| IS-2.6: Config var interpolation               | `auth-profile-config-var-resolution.test.ts` + integration test line 173              | Covered                           |
| IS-2.7: Compile-time warnings                  | `validate-preflight.ts` + VALIDATION_CODES                                            | Code present, needs compiler test |
| IS-2.8: Cache behavior                         | `auth-profile-cache-name-based.test.ts`                                               | Covered                           |

---

## Summary

All critical and high issues from Audit 1 are resolved. The implementation correctly traces from DSL through compilation to runtime execution. The new tool middleware is well-structured with proper error handling, shallow copying, and conditional registration.

**Remaining items (non-blocking):**

1. MEDIUM: resolveToolAuth auth-type switch only handles 4 of 17 types — acceptable for Phase 2, needs Phase 3 extension
2. MEDIUM: search-ai resolver has no cache for name-based lookups
3. LOW: Config var regex is single-variable only (by design)
4. OBSERVATION: No dedicated unit test for `createAuthProfileToolMiddleware` — consider adding one
5. OBSERVATION: IS-2.7 (compile-time validation warnings) should have a compiler test asserting the warning diagnostic is emitted
