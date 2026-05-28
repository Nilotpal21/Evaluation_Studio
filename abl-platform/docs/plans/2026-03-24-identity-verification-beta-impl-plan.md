# Identity Verification BETA — Low-Level Design & Implementation Plan

**Feature Spec**: `docs/features/identity-verification.md`
**HLD**: `docs/specs/identity-verification.hld.md`
**Test Spec**: `docs/testing/identity-verification.md`
**Prior LLD (ALPHA)**: `docs/plans/2026-03-22-identity-verification-impl-plan.md`
**Date**: 2026-03-24
**Status**: DONE

---

## Scope

This LLD covers the four remaining ALPHA gaps required for BETA promotion:

| Gap     | Description                                              | Severity |
| ------- | -------------------------------------------------------- | -------- |
| GAP-016 | No `createLogger` in OTP, OAuth, or email-link verifiers | Low      |
| GAP-015 | OAuth verifier not wired in production                   | Medium   |
| GAP-007 | OTP code delivery mechanism not integrated               | Medium   |
| GAP-006 | No integration with agent DSL for verification policy    | Medium   |

### Scope Overrides

GAP-007 (delivery) and GAP-006 (DSL gate) are listed as Non-Goals in the feature spec (`docs/features/identity-verification.md` lines 47, 51). They are intentionally promoted to BETA scope for the following reasons:

- **GAP-007 (delivery)**: Returning raw OTP codes and magic-link tokens in HTTP responses is a security concern for production. The ALPHA implementation delegated delivery to the orchestration layer, but no orchestration-layer delivery was built. Without delivery integration, OTP and email-link verification methods are unusable in production deployments. This is a security and functionality gap, not a nice-to-have.
- **GAP-006 (DSL gate)**: Identity verification without agent DSL integration is unusable — agent developers cannot gate tool access by identity tier, which is the primary use case (User Story 1: "require identity verification before sensitive operations"). Without DSL policy, the verification system has no consumer.

**Pre-implementation doc updates required**:

1. Feature spec: Move "SMS/email delivery infrastructure" and "Verification policy configuration via DSL" from Non-Goals to Goals, with BETA scope qualifier
2. HLD: Add `VerificationDeliveryService` port to hexagonal architecture diagram, add identity tier gate middleware to dependency table
3. Test spec: Add E2E-8 (DSL tier gate) and INT-8 (delivery dispatch) scenarios

These doc updates should be done in the first commit of implementation, before Phase 1 code changes.

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                 | Rationale                                                                                                      | Alternatives Rejected                                               |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D-1 | Implementation order: GAP-016 → GAP-015 → GAP-007 → GAP-006                              | Simple/self-contained first, cross-package last. Matches ALPHA LLD pattern.                                    | Reverse order (higher risk of regressions)                          |
| D-2 | Arctic v3 adapter classes for OAuth (`GoogleOAuthAdapter`, etc.)                         | `OAuthProviderAdapter` port exists. Arctic handles PKCE/provider quirks. Raw fetch would reimplement the lib.  | Raw fetch like ChannelOAuth (duplicates Arctic functionality)       |
| D-3 | Delivery OUTSIDE verifier, in route handler after `initiate()`                           | Preserves verifier single responsibility. Route handler strips raw code from response before sending.          | Inject delivery into verifier constructor (mixes concerns)          |
| D-4 | `VerificationDeliveryService` interface injected via DI in server.ts                     | Follows hexagonal port/adapter pattern. Identity context has zero `packages/shared` imports today.             | Direct import of EmailService in identity context (breaks hex arch) |
| D-5 | `identity_tier_required` as top-level field on `AgentTool` (AST) + `ToolDefinition` (IR) | Follows `confirmation` and `pii_access` precedent. Policy/access-control, not execution hints.                 | Inside `ToolHintsAST` (hints are for execution optimization)        |
| D-6 | `identityTierGateMiddleware` in composable tool middleware chain                         | `ToolCallerContext.identityTier` already exists. Middleware chain infrastructure proven (audit, auth profile). | Inline check in executor (breaks middleware composability)          |
| D-7 | New `IDENTITY_OAUTH_*` env vars, not reusing channel/tool OAuth vars                     | Different redirect URIs, scopes, and client registrations. Follows existing `IDENTITY_` prefix convention.     | Reuse OAUTH*PROVIDER*\* (shared redirect URIs = security risk)      |
| D-8 | No feature flags; DSL gate is implicitly opt-in (no-op when field absent)                | Same pattern as `confirmation`. Identity routes already path-gated.                                            | Feature flag (adds complexity for no benefit)                       |

### Key Interfaces & Types

**New: Arctic v3 OAuth Adapters (GAP-015)**

```typescript
// apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-adapters.ts

import type { OAuthProviderAdapter } from './oauth-verifier.js';

export class GoogleOAuthAdapter implements OAuthProviderAdapter {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}
  createAuthorizationURL(state: string, codeVerifier: string): URL {
    /* Arctic Google */
  }
  validateAuthorizationCode(code: string, codeVerifier: string): Promise<{ accessToken: string }> {
    /* Arctic */
  }
  fetchUserEmail(accessToken: string): Promise<string> {
    /* Google userinfo endpoint */
  }
}

// Similar: MicrosoftOAuthAdapter, GitHubOAuthAdapter
```

**New: Verification Delivery Service (GAP-007)**

```typescript
// apps/runtime/src/contexts/identity/domain/verification-delivery.ts

export interface VerificationDeliveryService {
  deliverCode(
    channel: 'email' | 'sms',
    to: string,
    code: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; error?: string }>;
}
```

**Modified: Tool Identity Tier Gate (GAP-006)**

```typescript
// packages/core/src/types/agent-based.ts — AgentTool (add field)
identityTierRequired?: 0 | 1 | 2;

// packages/compiler/src/platform/ir/schema.ts — ToolDefinition (add field)
identity_tier_required?: 0 | 1 | 2;

// packages/compiler/src/platform/constructs/executors/identity-tier-gate-middleware.ts (new)
export function createIdentityTierGateMiddleware(): ToolMiddleware;
```

### Module Boundaries

| Module                                             | Responsibility                            | Depends On                                        |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `identity/infrastructure/verifiers/oauth-adapters` | Arctic v3 provider wrappers               | `arctic` npm package, `OAuthProviderAdapter` port |
| `identity/domain/verification-delivery`            | Delivery port interface                   | None (pure interface)                             |
| `identity/infrastructure/email-delivery-adapter`   | Email delivery via `EmailService`         | `packages/shared` EmailService (via DI)           |
| `compiler/executors/identity-tier-gate-middleware` | Tool execution gate by identity tier      | `ToolMiddleware`, `ToolCallerContext`             |
| `core/types/agent-based`                           | AST type: `identityTierRequired` on tool  | None                                              |
| `compiler/ir/schema`                               | IR type: `identity_tier_required` on tool | None                                              |
| `compiler/ir/compiler`                             | AST→IR mapping for new field              | AST types, IR types                               |

---

## 2. File-Level Change Map

### New Files

| File                                                                                   | Purpose                                                   | LOC Estimate |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------ |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-adapters.ts`        | Arctic v3 adapters (Google, Microsoft, GitHub)            | ~180         |
| `apps/runtime/src/contexts/identity/domain/verification-delivery.ts`                   | Delivery port interface                                   | ~20          |
| `apps/runtime/src/contexts/identity/infrastructure/email-delivery-adapter.ts`          | EmailService bridge implementing delivery port            | ~60          |
| `packages/compiler/src/platform/constructs/executors/identity-tier-gate-middleware.ts` | Tool middleware for identity tier enforcement             | ~60          |
| `apps/runtime/src/__tests__/contexts/identity/oauth-adapters.test.ts`                  | Unit tests for Arctic v3 adapters                         | ~200         |
| `apps/runtime/src/__tests__/contexts/identity/delivery-integration.test.ts`            | Integration test: delivery dispatched after initiate      | ~150         |
| `packages/compiler/src/__tests__/identity-tier-gate-middleware.test.ts`                | Unit tests for tier gate middleware                       | ~120         |
| `packages/compiler/src/__tests__/compiler-identity-tier.test.ts`                       | Unit test: AST→IR compilation of `identity_tier_required` | ~50          |

### Modified Files

| File                                                                                 | Change Description                                                                    | Risk   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------ |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts`        | Add `createLogger('otp-verifier')` + structured logging in initiate/complete          | Low    |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts`      | Add `createLogger('oauth-verifier')` + structured logging                             | Low    |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` | Add `createLogger('email-link-verifier')` + structured logging                        | Low    |
| `apps/runtime/src/contexts/identity/index.ts`                                        | Export new types (delivery, adapters)                                                 | Low    |
| `apps/runtime/src/server.ts`                                                         | Wire OAuth adapter + delivery service in identity section                             | Medium |
| `apps/runtime/src/routes/identity-verification.ts`                                   | Add delivery dispatch after initiate; strip raw code from response                    | Medium |
| `packages/core/src/types/agent-based.ts`                                             | Add `identityTierRequired?: 0 \| 1 \| 2` to `AgentTool`                               | Low    |
| `packages/compiler/src/platform/ir/schema.ts`                                        | Add `identity_tier_required?: 0 \| 1 \| 2` to `ToolDefinition`                        | Low    |
| `packages/compiler/src/platform/ir/compiler.ts`                                      | Map `identityTierRequired` → `identity_tier_required` in `compileTools()`             | Low    |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts`                      | Map `identityTierRequired` → `identity_tier_required` in `compileToolDefinitionAST()` | Low    |
| `packages/compiler/src/platform/constructs/index.ts`                                 | Re-export `createIdentityTierGateMiddleware` from new file                            | Low    |
| `apps/runtime/src/services/execution/llm-wiring.ts`                                  | Add identity tier gate middleware to tool middleware chain                            | Medium |
| `apps/runtime/src/__tests__/contexts/identity/identity-e2e-http.test.ts`             | Add E2E scenarios for delivery and DSL gate                                           | Low    |

---

## 3. Implementation Phases

### Phase 1: Verifier Logging (GAP-016)

**Goal**: Add structured logging to the three verifiers missing `createLogger`.

**Tasks**:

1.1. Add `import { createLogger } from '@abl/compiler/platform'` and `const log = createLogger('<name>')` to `otp-verifier.ts`, `oauth-verifier.ts`, `email-link-verifier.ts`

1.2. Add `log.info(...)` for initiate success, `log.warn(...)` for validation failures (expired, max attempts, state mismatch), `log.error(...)` for unexpected errors — all with structured context (`{ tenantId, attemptId, method }`)

1.3. Verify builds pass: `pnpm build --filter=runtime`

**Files Touched**:

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts` — add logger
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts` — add logger
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts` — add logger

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] All 3 verifiers import `createLogger` and create a named logger instance
- [x] Each verifier logs initiate/complete events with `{ tenantId, attemptId }` context
- [x] All existing identity tests pass: `pnpm test --filter=runtime -- apps/runtime/src/__tests__/contexts/identity/`
- [x] No `console.log` or `console.error` in any verifier file

**Test Strategy**:

- Unit: Existing tests continue to pass (logging is non-functional)
- No new tests needed for logging addition

**Rollback**: Revert the commit. Logging is non-functional.

---

### Phase 2: OAuth Provider Wiring (GAP-015)

**Goal**: Create Arctic v3 adapter classes and wire OAuth verifier in `server.ts` production config.

**Tasks**:

2.1. Create `oauth-adapters.ts` with `GoogleOAuthAdapter`, `MicrosoftOAuthAdapter`, `GitHubOAuthAdapter` classes implementing `OAuthProviderAdapter`:

- Each wraps an Arctic v3 provider class (`Google`, `MicrosoftEntraId`, `GitHub`)
- Add `createLogger('oauth-adapters')` for structured logging — log `fetchUserEmail` attempts, failures, and latency (consistent with Phase 1 GAP-016 fix)
- `createAuthorizationURL(state, codeVerifier)` → delegates to Arctic with `openid email profile` scopes
- `validateAuthorizationCode(code, codeVerifier)` → delegates to Arctic token exchange
- `fetchUserEmail(accessToken)` → calls provider-specific userinfo endpoint (Google: `googleapis.com/oauth2/v3/userinfo`, Microsoft: `graph.microsoft.com/v1.0/me`, GitHub: `api.github.com/user/emails`). For GitHub: filter to `primary && verified` email.

  2.2. Add `IDENTITY_OAUTH_PROVIDER` env var (values: `google`, `microsoft`, `github`) and per-provider config:

- `IDENTITY_OAUTH_GOOGLE_CLIENT_ID`, `IDENTITY_OAUTH_GOOGLE_CLIENT_SECRET`, `IDENTITY_OAUTH_GOOGLE_REDIRECT_URI`
- Same pattern for `MICROSOFT` and `GITHUB`
- **Note**: Redirect URIs must match the registered application redirect URI in each provider's developer console exactly. No wildcards or localhost defaults in production.

  2.3. Wire in `server.ts`: Read env vars, if configured create the adapter and register `OAuthVerifier` in the verifier map. **Dependency note**: `arctic` v3 (`"arctic": "^3.7.0"`) is already in `apps/runtime/package.json` — no new npm install needed.

  2.4. Export `GoogleOAuthAdapter`, `MicrosoftOAuthAdapter`, `GitHubOAuthAdapter` from `identity/index.ts`

  2.5. Write unit tests for each adapter: mock Arctic provider instances, verify delegation pattern, verify `fetchUserEmail` calls correct endpoint

**Files Touched**:

- `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-adapters.ts` — new
- `apps/runtime/src/contexts/identity/index.ts` — export adapters
- `apps/runtime/src/server.ts` — wire OAuth adapter from env vars
- `apps/runtime/src/__tests__/contexts/identity/oauth-adapters.test.ts` — new unit tests

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] `GoogleOAuthAdapter` implements all 3 methods of `OAuthProviderAdapter`
- [x] `MicrosoftOAuthAdapter` implements all 3 methods
- [x] `GitHubOAuthAdapter` implements all 3 methods
- [x] `server.ts` reads `IDENTITY_OAUTH_PROVIDER` and wires the correct adapter when configured
- [x] `server.ts` logs "OAuth verifier wired with <provider>" when configured
- [x] `server.ts` logs warning and skips OAuth when not configured (existing behavior)
- [x] All OAuth adapter unit tests pass (≥ 6 tests: 2 per adapter)
- [x] Existing E2E-5 (OAuth with mock provider) still passes

**Test Strategy**:

- Unit: New tests for Arctic adapter delegation
- E2E: Existing E2E-5 uses TestOAuthProvider (remains valid)

**Rollback**: Revert the commit. OAuth verifier stays un-wired (ALPHA behavior).

---

### Phase 3: Verification Code Delivery (GAP-007)

**Goal**: Bridge OTP/email-link code delivery to existing `EmailService` from `packages/shared`.

**Tasks**:

3.1. Create `verification-delivery.ts` in `identity/domain/` with `VerificationDeliveryService` interface

3.2. Create `email-delivery-adapter.ts` in `identity/infrastructure/` implementing the port:

- Define a local `EmailSender` interface in the adapter file: `{ sendEmail(to: string, subject: string, html: string): Promise<void> }` — do NOT import types from `packages/shared`
- Constructor accepts `EmailSender` via DI (structurally matches `EmailService` from `packages/shared`, injected from `server.ts` — identity context does NOT import `packages/shared` directly)
- `deliverCode('email', to, code)` → calls injected `sendEmail(to, subject, html)` with an OTP/magic-link email template
- `deliverCode('sms', to, code)` → logs warning "SMS delivery not configured" (Twilio bridge deferred; no generic SmsService exists)
- Wraps `sendEmail()` in try/catch: `err instanceof Error ? err.message : String(err)` per platform standards
- Returns `{ delivered: true }` on success, `{ delivered: false, error: message }` on failure

  3.3. Update `createIdentityVerificationRouter` to accept an optional `deliveryService?: VerificationDeliveryService` dependency

  3.4. Update `POST /initiate` route handler:

- **Delivery dispatch and code stripping ONLY occur when `deliveryService` is provided.** When `deliveryService` is undefined (e.g., in E2E tests), the full `challengeData` including `code`/`token` is returned unchanged (preserving ALPHA behavior).
- When `deliveryService` IS configured:
  - After `verifyIdentity.execute(input)` succeeds, if `result.challengeData?.code` exists:
    - **ALWAYS strip `code` from `challengeData` before returning** (security-first — raw OTP MUST NEVER appear in HTTP response when delivery is configured)
    - Call `deliveryService.deliverCode('email', input.identityValue, code)`
    - If delivery fails: return `{ success: true, attemptId, challengeData: { userAction: 'enter_otp', deliveryStatus: 'failed' } }` — code is still stripped, client should show "code not delivered, try again"
  - If `result.challengeData?.token` exists (email-link):
    - **ALWAYS strip `token` from `challengeData` before returning**
    - Build magic link URL and call `deliveryService.deliverCode('email', input.identityValue, magicLinkUrl)`
    - If delivery fails: same pattern — strip token, return `deliveryStatus: 'failed'`

      3.5. Wire in `server.ts`: Create `EmailService` via `createEmailService()`, create `EmailDeliveryAdapter`, pass to router factory

      3.6. Write integration test: initiate OTP → verify delivery service called with correct args → verify response does NOT contain raw code

**Files Touched**:

- `apps/runtime/src/contexts/identity/domain/verification-delivery.ts` — new interface
- `apps/runtime/src/contexts/identity/infrastructure/email-delivery-adapter.ts` — new adapter
- `apps/runtime/src/contexts/identity/index.ts` — export new types
- `apps/runtime/src/routes/identity-verification.ts` — delivery dispatch + code stripping
- `apps/runtime/src/server.ts` — wire EmailService → delivery adapter
- `apps/runtime/src/__tests__/contexts/identity/delivery-integration.test.ts` — new integration test

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] `VerificationDeliveryService` interface exported from identity context
- [x] `EmailDeliveryAdapter` implements the interface and delegates to `EmailService`
- [x] `POST /initiate` for OTP calls delivery service and strips `code` from response
- [x] `POST /initiate` for email-link calls delivery service and strips `token` from response
- [x] When no delivery service configured, behavior unchanged (code/token in response)
- [x] Integration test verifies delivery called + code stripped (≥ 3 test cases)
- [x] Existing E2E tests still pass (they don't configure delivery service, so get old behavior)

**Test Strategy**:

- Integration: New delivery integration test (OTP delivery, email-link delivery, no-delivery fallback)
- E2E: Existing E2E tests unaffected (no delivery service injected)

**API Contract Change**:

When delivery service is configured, the `POST /initiate` response shape changes:

- **Before (ALPHA)**: `{ success: true, attemptId, challengeData: { userAction: "enter_otp", code: "123456" } }`
- **After (BETA with delivery)**: `{ success: true, attemptId, challengeData: { userAction: "enter_otp", deliveryStatus: "sent" } }` — `code` field stripped
- **Backward-compatible**: When no delivery service is configured (e.g., E2E tests, local dev), the old response shape is preserved unchanged. The delivery gating is purely based on whether `deliveryService` is provided to the router factory.
- **Client SDK migration**: Client SDKs that read `challengeData.code` must handle the field being absent when delivery is configured. The `deliveryStatus` field indicates the delivery outcome (`"sent"` or `"failed"`).

**Rollback**: Revert the commit. Route handler returns raw code (ALPHA behavior).

---

### Phase 4: Agent DSL Identity Tier Gate (GAP-006)

**Goal**: Allow agent tool definitions to declare a minimum identity tier requirement, enforced at tool execution time.

**Tasks**:

4.1. Add `identityTierRequired?: 0 | 1 | 2` to `AgentTool` in `packages/core/src/types/agent-based.ts`

4.2. Add `identity_tier_required?: 0 | 1 | 2` to `ToolDefinition` in `packages/compiler/src/platform/ir/schema.ts`

4.3. Add AST→IR mapping in **BOTH** tool compilation paths:

- `packages/compiler/src/platform/ir/compiler.ts` `compileTools()` function (line ~780):
  ```typescript
  identity_tier_required: astTool.identityTierRequired,
  ```
- `packages/compiler/src/platform/ir/compile-behavior-profile.ts` `compileToolDefinitionAST()` function (line ~315):
  ```typescript
  identity_tier_required: ast.identityTierRequired,
  ```
- **Both paths MUST map the field** — behavior profile tools use `compileToolDefinitionAST`, agent tools use `compileTools`.
- **Note**: `compileToolDefinitionAST` maps a subset of fields vs `compileTools` (missing `confirmation`, `pii_access`, etc.). This is a pre-existing gap outside this LLD's scope — add a code comment noting this when adding `identity_tier_required`.

  4.4. Create `identity-tier-gate-middleware.ts` in `packages/compiler/src/platform/constructs/executors/`:

- Use `import { createLogger } from '../../logger.js'` — the compiler-internal relative path used by all other middleware in this directory. Do NOT use `@abl/compiler/platform` (circular import).
- Create `const log = createLogger('identity-tier-gate')` at module level
- Reads `ctx.tool?.identity_tier_required` — if not set, call `next(ctx)` (no-op)
- Reads `ctx.metadata?.callerContext?.identityTier` — caller's current tier
- If caller tier < required tier: return `{ result: JSON.stringify({ error: { code: 'IDENTITY_TIER_INSUFFICIENT', message: '...', required_tier: N, current_tier: M } }), metadata: {} }`
- If caller tier >= required tier: call `next(ctx)`
- Defensively handle invalid `identity_tier_required` values (not 0/1/2): log warning and pass through

  4.5. Wire the middleware in `apps/runtime/src/services/execution/llm-wiring.ts`: Push `createIdentityTierGateMiddleware()` unconditionally after the audit middleware try/catch block (line ~534) and before `middleware.push(createSecretScrubberMiddleware())` (line ~537). This insertion is independent of whether audit middleware was successfully added.

  4.6. Export from `packages/compiler/src/platform/constructs/index.ts`. In `packages/compiler/src/index.ts`, add `export { createIdentityTierGateMiddleware } from './platform/constructs/executors/identity-tier-gate-middleware.js';` — following the direct-from-source-file pattern used by `createAuditMiddleware` (line ~493).

  4.7. Write unit tests:

- Compiler test: `identityTierRequired: 2` on AST tool → `identity_tier_required: 2` on IR tool
- Middleware test: tier 0 caller + tool requires tier 2 → IDENTITY_TIER_INSUFFICIENT error
- Middleware test: tier 2 caller + tool requires tier 2 → passes through to next()
- Middleware test: no `identity_tier_required` on tool → passes through (no-op)

  4.8. Write E2E test scenario: E2E-8 in `identity-e2e-http.test.ts`:

- **Note**: This test spans both identity verification AND tool execution. The test setup must wire `ToolBindingExecutor` with the identity tier gate middleware alongside the existing Express server with identity routes. This is more complex than existing E2E tests — plan additional test infrastructure setup time.
- Build a test tool with `identity_tier_required: 2`
- Call tool as anonymous (tier 0) → assert IDENTITY_TIER_INSUFFICIENT error
- Verify identity via OTP (tier 2) → call tool again → assert success

**Files Touched**:

- `packages/core/src/types/agent-based.ts` — add `identityTierRequired` to `AgentTool`
- `packages/compiler/src/platform/ir/schema.ts` — add `identity_tier_required` to `ToolDefinition`
- `packages/compiler/src/platform/ir/compiler.ts` — add field mapping in `compileTools()`
- `packages/compiler/src/platform/ir/compile-behavior-profile.ts` — add field mapping in `compileToolDefinitionAST()`
- `packages/compiler/src/platform/constructs/executors/identity-tier-gate-middleware.ts` — new middleware
- `packages/compiler/src/platform/constructs/index.ts` — re-export new middleware
- `packages/compiler/src/index.ts` — export new middleware
- `apps/runtime/src/services/execution/llm-wiring.ts` — wire middleware into chain
- `packages/compiler/src/__tests__/compiler-identity-tier.test.ts` — new compiler test
- `packages/compiler/src/__tests__/identity-tier-gate-middleware.test.ts` — new middleware test

**Exit Criteria**:

- [x] `pnpm build --filter=@abl/core` succeeds with 0 errors
- [x] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] `identityTierRequired: 2` in AST compiles to `identity_tier_required: 2` in IR
- [x] Middleware blocks tool call when caller tier < required tier
- [x] Middleware passes through when caller tier >= required tier
- [x] Middleware passes through when `identity_tier_required` is not set (no-op)
- [x] Error response includes `required_tier` and `current_tier` for client SDK
- [x] All compiler tests pass: `pnpm test --filter=@abl/compiler`
- [x] All runtime tests pass: `pnpm test --filter=runtime`
- [x] No regressions in existing tool execution (middleware is no-op for tools without the field)

**Test Strategy**:

- Unit: Compiler mapping test, middleware behavior tests (3 cases minimum)
- E2E: E2E-8 scenario (anonymous blocked, verified allowed)

**Rollback**: Revert the 3 package changes. Field is additive/optional; no existing tool has it.

---

## 4. Wiring Checklist

- [x] `createLogger` added to OTP, OAuth, email-link verifiers (Phase 1)
- [x] `GoogleOAuthAdapter`, `MicrosoftOAuthAdapter`, `GitHubOAuthAdapter` exported from `identity/index.ts` (Phase 2)
- [x] OAuth adapter wired in `server.ts` when `IDENTITY_OAUTH_PROVIDER` is configured (Phase 2)
- [x] OAuth verifier registered in verifier map in `server.ts` (Phase 2)
- [x] `VerificationDeliveryService` interface exported from `identity/domain/` (Phase 3)
- [x] `EmailDeliveryAdapter` exported from `identity/infrastructure/` (Phase 3)
- [x] Delivery service wired in `server.ts` via `createEmailService()` (Phase 3)
- [x] Delivery service passed to `createIdentityVerificationRouter()` (Phase 3)
- [x] Route handler dispatches delivery and strips raw code from response (Phase 3)
- [x] `identityTierRequired` added to `AgentTool` AST type (Phase 4)
- [x] `identity_tier_required` added to `ToolDefinition` IR type (Phase 4)
- [x] AST→IR mapping added in `compileTools()` in `compiler.ts` (Phase 4)
- [x] AST→IR mapping added in `compileToolDefinitionAST()` in `compile-behavior-profile.ts` (Phase 4)
- [x] `createIdentityTierGateMiddleware` exported from `constructs/index.ts` and `compiler/src/index.ts` (Phase 4)
- [x] Identity tier gate middleware wired in `llm-wiring.ts` tool middleware chain (Phase 4)

---

## 5. Cross-Phase Concerns

### Configuration Changes

| Phase   | Config Change                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------- |
| Phase 2 | New env vars: `IDENTITY_OAUTH_PROVIDER`, `IDENTITY_OAUTH_<PROVIDER>_CLIENT_ID/SECRET/REDIRECT_URI` |
| Phase 3 | Uses existing email env vars: `AWS_SES_REGION` / `RESEND_API_KEY` / `SMTP_HOST` (already in use)   |

### Feature Flags

None. OAuth wiring is gated by env var presence. DSL gate is implicitly opt-in (no-op when field absent).

### Database Migrations

None. All changes are in-memory (types, middleware, adapters).

---

## 6. Acceptance Criteria (Whole Feature — BETA)

- [x] All 4 phases complete with exit criteria met
- [x] `pnpm build` succeeds across all affected packages (runtime, compiler, core)
- [x] All existing identity tests pass (14 test files, 196+ tests)
- [x] New unit tests pass: OAuth adapters (16), compiler mapping (9), middleware (10)
- [x] New integration test passes: delivery integration (5 test cases)
- [x] Existing 7 E2E scenarios still pass
- [x] No regressions in full test suite: `pnpm build && pnpm test`
- [x] Feature spec GAP-006, GAP-007, GAP-015, GAP-016 marked "Mitigated"
- [x] Feature spec Non-Goals updated: delivery and DSL gate moved to Goals with BETA qualifier (see Scope Overrides)
- [x] Feature spec GAP-017 added for SMS delivery adapter deferral
- [x] Feature spec status updated to BETA (post-impl-sync evaluation passed)
- [x] Test spec updated with E2E-8 (DSL tier gate) and INT-8 (delivery dispatch) scenarios
- [x] HLD updated with delivery port in hexagonal diagram and DSL gate in dependency table

---

## 7. Resolved Questions

1. **GitHub userinfo for private emails**: **DECIDED** — Filter to `primary && verified` email from GitHub's `/user/emails` endpoint. Already specified in Task 2.1.
2. **SMS delivery**: **DECIDED** — Defer SMS adapter. Log warning "SMS delivery not configured" for now. Track as GAP-017 in feature spec. Implement when `@agent-platform/notifications` package is created.
3. **OAuth callback route**: **DECIDED** — Client SDK handles the OAuth callback and sends the authorization code via `POST /complete`. No server-side callback endpoint needed. Matches the current E2E-5 test pattern.
