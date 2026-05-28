# Auth Profile Wiring & JIT Auth Design

**Date:** 2026-03-17
**Status:** Draft
**Scope:** Complete auth profile wiring gaps + new JIT auth mechanism

## Problem

Auth profiles are 80%+ built but have critical wiring gaps — code exists but isn't called:

- `AuthProfileRotationJob` exists but is never scheduled in `server.ts`
- `resolveWithGracePeriod()` exists but the resolver doesn't call it
- `applyAuth()` returns `tlsOptions` for mTLS but nothing consumes them
- No DSL syntax to reference auth profiles by name
- No runtime name-based resolution (ID-only)
- No bulk action endpoints
- No mechanism for mid-conversation user authentication (JIT auth)

## Part 1: Auth Profile Wiring

### 1.1 Rotation Job Scheduling

Wire `AuthProfileRotationJob` into runtime startup.

**Files:**

- `apps/runtime/src/server.ts` — instantiate and start the job
- `apps/runtime/src/services/auth-profile/auth-profile-rotation-job.ts` — existing class

**Design:**

- Add `AUTH_ROTATION_INTERVAL_MS` env var (default: 300000 = 5 min)
- Instantiate in `startServer()` after DB connection established
- Register shutdown handler to stop the interval on SIGTERM
- Log rotation results via `createLogger('auth-profile-rotation')`

### 1.2 Grace Period Wiring

Replace direct `JSON.parse(profile.encryptedSecrets)` with `resolveWithGracePeriod()`.

**Files:**

- `apps/runtime/src/services/auth-profile-resolver.ts` — swap decryption call
- `packages/shared-auth-profile/src/grace-period.ts` — existing function

**Design:**

- Import `resolveWithGracePeriod` in the resolver
- Pass `profile.encryptedSecrets`, `profile.previousEncryptedSecrets`, `profile.rotationGracePeriodMs`
- Fallback: if grace period function throws, log and re-throw (don't silently fail)

### 1.3 Runtime Name→Profile Resolution

Add name-based lookup alongside existing ID-based resolution.

**Files:**

- `apps/runtime/src/services/auth-profile-resolver.ts` — new `resolveByName()` method
- `apps/search-ai/src/services/auth-profile-resolver.ts` — same change

**Design:**

- `resolveByName(name: string, tenantId: string, environment?: string)`
- Query: `findOne({ name, tenantId, status: 'active', expiresAt: { $gt: now } OR null })`
- Environment: exact match first, then fallback to `environment: null` (default profile)
- Returns same shape as `resolveAuthProfileCredentials`

### 1.4 DSL Auth Profile References

Add `auth_profile:` property to tool definitions in DSL.

**Files:**

- `packages/core/src/parser/tool-file-parser.ts` — parse `auth_profile:` property
- `packages/compiler/src/platform/ir/schema.ts` — add `authProfileRef?: string` to `HttpBindingIR`
- `packages/compiler/src/platform/ir/auth-config-builder.ts` — handle profile ref
- Runtime tool executor — resolve `authProfileRef` via `resolveByName()`

**Design:**

- Tool YAML: `auth_profile: "my-staging-creds"` alongside existing `auth: bearer`
- `auth_profile` takes precedence over inline `auth` when both present
- Compiler emits `authProfileRef` on the IR; does NOT validate existence at compile time (profiles are runtime state)
- Runtime: if `authProfileRef` is set, call `resolveByName()` and apply credentials

### 1.5 mTLS TLS Agent Wiring

Wire `tlsOptions` from `applyAuth()` into the HTTP client.

**Files:**

- Runtime HTTP tool executor — read `tlsOptions` from auth result
- `packages/shared-auth-profile/src/apply-auth.ts` — already returns `tlsOptions`

**Design:**

- When `applyAuth()` returns `tlsOptions`, create `new https.Agent({ cert, key, ca, rejectUnauthorized: true })`
- Pass agent to axios/fetch call
- Studio mTLS form fields deferred to separate UI PR

### 1.6 Bulk Actions API

Add bulk operations endpoint for auth profiles.

**Files:**

- `apps/studio/src/app/api/projects/[id]/auth-profiles/bulk/route.ts` — new route
- `apps/studio/src/app/api/auth-profiles/bulk/route.ts` — workspace-level

**Design:**

- `POST` with body `{ action: 'delete' | 'revoke' | 'activate', profileIds: string[] }`
- Max 50 profiles per request
- Each profile verified for tenant ownership individually (no batch bypass)
- Returns `{ success: true, results: { id, status: 'ok' | 'error', error? }[] }`

### 1.7 Config Variable Resolution

Support `auth_profile: "{{config.AUTH_PROFILE}}"` in DSL.

**Files:**

- `packages/compiler/src/platform/ir/auth-config-builder.ts` — detect config var pattern
- Existing config variable resolution pipeline

**Design:**

- Compiler detects `{{config.*}}` or `{{env.*}}` patterns in `authProfileRef`
- Preserves as template string in IR (not resolved at compile time)
- Runtime resolves variables before calling `resolveByName()`

## Part 2: JIT Auth

### 2.1 DSL Syntax

**Files:**

- `packages/core/src/parser/tool-file-parser.ts` — parse `auth_jit: true`
- `packages/compiler/src/platform/ir/schema.ts` — add `jitAuth?: boolean` to tool IR

### 2.2 WebSocket Auth Challenge Protocol

**Files:**

- `apps/runtime/src/websocket/handler.ts` — send `auth_challenge`, handle `auth_response`
- `apps/runtime/src/websocket/sdk-handler.ts` — same
- New types file for auth challenge messages

**Message types:**

```typescript
// Server → Client
interface AuthChallengeMessage {
  type: 'auth_challenge';
  toolCallId: string;
  authType: string;
  authUrl?: string; // OAuth authorization URL
  profileId: string;
  profileName: string;
  prompt: string; // Human-readable: "This tool requires Google authorization"
  timeoutMs: number; // How long the client has to respond
}

// Client → Server
interface AuthResponseMessage {
  type: 'auth_response';
  toolCallId: string;
  status: 'completed' | 'cancelled';
}
```

### 2.3 Execution Pause/Resume

**Files:**

- New: `apps/runtime/src/services/paused-execution-store.ts`
- Tool executor — check `jitAuth`, pause if token missing

**Design:**

- `PausedExecutionStore` backed by Redis
- Key: `paused-exec:{sessionId}:{toolCallId}`, TTL: 10 min (configurable via `JIT_AUTH_TIMEOUT_MS`)
- Stores: tool call params, auth profile ref, session context ID
- Does NOT serialize full execution context — instead, the tool executor awaits a Promise that resolves when `auth_response` arrives
- On timeout: reject Promise with `AuthTimeoutError`
- On cancel: reject with `AuthCancelledError`
- On complete: resolve, tool executor retries the tool call with fresh credentials

### 2.4 OAuth Flow for JIT

**Files:**

- `apps/runtime/src/services/tool-oauth-service.ts` — add `initiateJitOAuth()` method
- OAuth callback handler — notify paused execution on token arrival

**Design:**

- Runtime calls `ToolOAuthService.initiateJitOAuth(profileId, sessionId, toolCallId)`
- Returns OAuth URL for the auth profile's provider
- OAuth callback writes token → publishes Redis event `jit-auth:complete:{sessionId}:{toolCallId}`
- PausedExecutionStore subscribes to this event → resolves the waiting Promise

**Token Storage Principle:**

JIT follows the same token storage rules as preflight — tokens are always stored under the real end user's ID in `EndUserOAuthToken`. The auth profile's `connectionMode` field controls credential storage scope only for `preconfigured` mode. Specifically:

- JIT token → `EndUserOAuthToken` with `userId = real user ID` (always per-user)
- Preflight token → same as JIT (always per-user)
- `connectionMode: 'shared'` with `__tenant__` userId is exclusively for `preconfigured` mode (admin-managed credentials)
- `SessionOAuthArtifact` is only used as a fallback when the runtime session has no authenticated user identity (anonymous SDK sessions)

Note: `visibility` (who can see the profile) and `connectionMode` (how credentials are stored) are independent fields on the auth profile.

The only difference between JIT and preflight is **timing**: preflight obtains consent before execution starts; JIT obtains consent mid-execution when a tool actually needs credentials.

### 2.5 Studio Chat UI

**Files:**

- New: `apps/studio/src/components/chat/AuthChallengeMessage.tsx`
- Chat message renderer — handle `auth_challenge` type

**Design:**

- Renders card in chat: profile name, auth type icon, "Authorize" button, countdown timer
- Button opens popup using same pattern as `AuthProfileOAuthDialog`
- On popup completion, sends `auth_response` via WebSocket
- On timeout/dismiss, sends `auth_response` with `status: 'cancelled'`

### 2.6 SDK Support

**Files:**

- SDK WebSocket client — expose `onAuthChallenge` callback hook

**Design:**

- `onAuthChallenge(challenge: AuthChallengeMessage): Promise<'completed' | 'cancelled'>`
- Default: log auth URL to console, resolve `'cancelled'` after timeout
- Custom implementations can open a browser, call an auth service, etc.

### 2.7 Session Cleanup

**Files:**

- `apps/runtime/src/websocket/handler.ts` — cleanup on disconnect
- `apps/runtime/src/services/paused-execution-store.ts` — `cleanupSession()`

**Design:**

- On WebSocket disconnect, call `PausedExecutionStore.cleanupSession(sessionId)` — deletes all `paused-exec:{sessionId}:*` keys
- JIT-acquired token revocation deferred (requires `auth_scope: session` which is Part 1 duration/scope work)

## Testing Strategy

Each component gets an integration test that verifies wiring end-to-end:

1. **Rotation scheduling:** server starts → job runs → stale profiles re-encrypted
2. **Grace period:** profile with old key + previous key → resolver returns credentials
3. **Name resolution:** `resolveByName("profile-name", tenantId)` → correct profile
4. **DSL refs:** tool YAML with `auth_profile: "x"` → compiles → runtime resolves
5. **mTLS:** `applyAuth()` result with `tlsOptions` → HTTPS agent configured
6. **Bulk actions:** bulk delete → all removed, cross-tenant → 404
7. **JIT flow:** tool needs auth → auth_challenge sent → auth_response received → tool succeeds

## Implementation Order

1. Rotation scheduling + grace period wiring (independent, low risk)
2. Name resolution (needed by DSL refs and JIT)
3. DSL `auth_profile:` references
4. mTLS wiring + bulk actions + config vars
5. JIT: WebSocket protocol + pause/resume store
6. JIT: OAuth flow + Studio UI
7. JIT: SDK support + session cleanup
