# Centralized Auth Architecture: Channel Auth vs. Tenant Auth

**Date**: 2026-02-22
**Status**: Implemented (Phases 1–3 complete, Phase 4 pending)
**Authors**: Prasanna Arikala, Claude
**Scope**: Auth middleware refactoring, user-level data ownership, session ownership enforcement, header trust removal

**Related docs:**

- [Channel Identity & Contact Design](2026-02-18-channel-identity-contact-design.md) — how CallerContext is built (identity tiers, verification methods)
- [Project-Level RBAC Design](2026-02-20-project-level-rbac-design.md) — User JWT RBAC (implemented); this design extends it with SDK/API key access models
- [Attachment Pipeline Design](2026-02-21-attachment-pipeline-design.md) — attachment security layer (§6) now references session ownership
- [Centralized Auth Plan](2026-02-22-centralized-auth-plan.md) — implementation plan for this design

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current Architecture](#2-current-architecture)
3. [Design Goals](#3-design-goals)
4. [Discriminated Auth Context Types](#4-discriminated-auth-context-types)
5. [Three-Layer Access Control](#5-three-layer-access-control)
6. [Session Ownership Middleware](#6-session-ownership-middleware)
7. [Data Store Isolation Model](#7-data-store-isolation-model)
8. [Presigned URL Security](#8-presigned-url-security)
9. [Route Middleware Composition](#9-route-middleware-composition)
10. [Migration Strategy](#10-migration-strategy) (Phases 1–3 complete, Phase 4 pending)
11. [Testing Strategy](#11-testing-strategy)
12. [Implementation Status](#12-implementation-status)

---

## 1. Problem Statement

### The Conflation

The platform has three auth flows — User JWT (Studio), SDK Session Token (end-users via channels), and API Key (machine-to-machine) — that all converge to a single `TenantContextData` type. This creates three problems:

1. **`userId` means different things.** For User JWT, it's a real platform user ID. For SDK sessions, it's a synthetic `sdk:{channelId}`. For API keys, it's the key creator. Downstream code can't distinguish these without checking `authType` and casting.

2. **`requireProjectPermission()` only works for User JWT.** It does a `ProjectMember` DB lookup — but SDK sessions have no `ProjectMember` record (they're end-users, not platform members). API keys bypass project membership entirely.

3. **No user-level data ownership.** Sessions, messages, and attachments are scoped to `tenantId` + `projectId` but not to the end-user who created them. An SDK token for user A can access user B's sessions within the same project.

### The Gap

| Store       | Current Scoping                      | Required Scoping                   |
| ----------- | ------------------------------------ | ---------------------------------- |
| Sessions    | `tenantId` + `projectId`             | + end-user identity (for SDK auth) |
| Messages    | `sessionId` (transitive via session) | + session ownership verification   |
| Attachments | `tenantId` + `sessionId`             | + session ownership verification   |
| FactStore   | `tenantId` + `userId` + `projectId`  | Already correct (gold standard)    |
| Memory      | Via FactStore                        | Already correct                    |

### Impact

Without this fix, any end-user with a valid SDK session token can:

- List another user's sessions in the same project
- Read another user's conversation messages
- Download another user's attachments
- Access presigned URLs for another user's files

---

## 2. Current Architecture

### Auth Flow Convergence

```
                                    ┌──────────────────────┐
User JWT (Studio)  ─────────────────┤                      │
                                    │  TenantContextData   │──→ All routes
SDK Session Token  ─────────────────┤  (single flat type)  │    use same type
                                    │                      │
API Key (abl_*)    ─────────────────┤                      │
                                    └──────────────────────┘
```

### TenantContextData (Current)

```typescript
interface TenantContextData {
  tenantId: string;
  orgId?: string;
  userId: string; // Real user ID OR "sdk:{channelId}" OR key creator
  role: string; // Tenant role OR "sdk_session" OR "api_key"
  permissions: string[];
  authType: AuthType; // 'user' | 'sdk_session' | 'api_key'
  isSuperAdmin: boolean;
  // SDK-specific (optional, only set for sdk_session)
  deploymentId?: string;
  channelId?: string;
  sessionId?: string;
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  channelArtifact?: string;
  userContext?: { userId?: string; customAttributes?: Record<string, unknown> };
  // API key-specific (optional, only set for api_key)
  apiKeyId?: string;
  clientId?: string;
  projectScope?: string[];
  environmentScope?: string[];
}
```

### Middleware Stack (Before)

```
createUnifiedAuthMiddleware()  →  Sets req.tenantContext
                                  ⚠ Reads X-Tenant-Id header as tenant hint when JWT has no tenantId
requireAuth()                  →  Rejects if no auth context
requirePermission('x:y')      →  Checks ctx.permissions
requireProjectPermission()     →  DB lookup: ProjectMember by userId
                                  (FAILS for SDK — no ProjectMember for "sdk:webchat")
requireProjectScope()          →  API key projectScope check
```

### Middleware Stack (After — Implemented)

```
createUnifiedAuthMiddleware()  →  Sets req.tenantContext + req.authContext
                                  ✅ TenantId from verified credentials ONLY (JWT claims, SDK tokens, API key DB)
                                  ✅ X-Tenant-Id / X-Organization-Id headers completely ignored
requireAuth()                  →  Rejects if no auth context
requirePermission('x:y')      →  Checks ctx.permissions
requireProjectPermission()     →  Dispatches by authType:
                                  - User JWT: DB ProjectMember lookup + RBAC
                                  - SDK Session: projectId match (fail-closed if missing)
                                  - API Key: projectScope check
requireSessionOwnership()      →  NEW: SDK users can only access own sessions (identity match)
```

---

## 3. Design Goals

1. **Type safety.** Each auth flow gets its own typed context. No more optional fields that "might" be set.
2. **Clear access models.** Platform members prove permission (RBAC). End-users prove ownership (identity match). API keys prove scope (project list).
3. **Session as gateway.** For SDK auth, session ownership is the single access control check. Messages, attachments, and conversation history are transitively accessible through the session.
4. **Backward compatible.** `TenantContextData` remains available during migration. New typed contexts coexist via a discriminated union.
5. **Follow FactStore pattern.** The FactStore's `ownerFilter()` approach — immutable ownership dimensions bound at instantiation, spread into every query — is the target for all stores.

---

## 4. Discriminated Auth Context Types

### New Type Hierarchy

```typescript
// ─── Base (shared by all auth flows) ─────────────────────────────
interface AuthContextBase {
  tenantId: string;
  orgId?: string;
  authType: AuthType;
  permissions: string[];
}

// ─── Flow 1: Platform Member (Studio JWT) ────────────────────────
// WHO: Developer, admin, operator using Studio or admin APIs.
// ACCESS MODEL: Tenant role + project membership + RBAC permissions.
interface PlatformMemberContext extends AuthContextBase {
  authType: 'user';
  userId: string; // Real platform user ID from JWT sub
  role: string; // Tenant role: OWNER | ADMIN | OPERATOR | MEMBER | VIEWER
  isSuperAdmin: boolean;
}

// ─── Flow 2: Channel End-User (SDK Session Token) ────────────────
// WHO: End-user interacting via webchat, WhatsApp, voice, email, SMS.
// ACCESS MODEL: Owns their own data. Prove identity to access own sessions.
interface ChannelUserContext extends AuthContextBase {
  authType: 'sdk_session';
  projectId: string; // Baked into SDK token from sdk/init
  channelId: string; // Channel identifier (webchat, whatsapp, etc.)
  deploymentId?: string;
  sessionId?: string; // Current session (if resolved by token)
  callerIdentity: CallerIdentity;
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
}

// ─── Flow 3: Machine-to-Machine (API Key) ────────────────────────
// WHO: External integration, CI/CD, monitoring system.
// ACCESS MODEL: Scoped by project + environment + explicit permissions.
interface ApiKeyContext extends AuthContextBase {
  authType: 'api_key';
  apiKeyId: string;
  clientId: string; // Identifies the integrating system
  createdBy: string; // Platform user who created the key
  projectScope?: string[];
  environmentScope?: string[];
}

// ─── Discriminated Union ─────────────────────────────────────────
type AuthContext = PlatformMemberContext | ChannelUserContext | ApiKeyContext;
```

### CallerIdentity (extracted from TenantContextData SDK fields)

```typescript
// End-user identity — who is this person on this channel?
interface CallerIdentity {
  customerId?: string; // Verified user ID (identity tier 2)
  anonymousId?: string; // Ephemeral session ID (tier 0)
  contactId?: string; // CRM contact ID
  channelArtifact?: string; // SHA-256 hashed device/cookie/phone (tier 1)
  channelArtifactType?: ChannelArtifactType;
  identityTier: IdentityTier; // 0=anonymous, 1=artifact, 2=verified
  verificationMethod: VerificationMethod;
}
```

### Type Guard Utilities

```typescript
function isPlatformMember(ctx: AuthContext): ctx is PlatformMemberContext {
  return ctx.authType === 'user';
}
function isChannelUser(ctx: AuthContext): ctx is ChannelUserContext {
  return ctx.authType === 'sdk_session';
}
function isApiKey(ctx: AuthContext): ctx is ApiKeyContext {
  return ctx.authType === 'api_key';
}
```

### Backward Compatibility

```typescript
// Bridge function: convert AuthContext → TenantContextData for legacy code
function toLegacyTenantContext(ctx: AuthContext): TenantContextData { ... }

// Bridge function: convert TenantContextData → AuthContext for new code
function toAuthContext(ctx: TenantContextData): AuthContext { ... }
```

---

## 5. Three-Layer Access Control

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: TENANT ISOLATION (all auth types)                      │
│  Existing: tenantIsolationPlugin, DB-level tenantId filter      │
│  Every query scoped to tenantId from auth context               │
│  Status: IMPLEMENTED, no changes needed                         │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Layer 2a:     │   │ Layer 2b:       │   │ Layer 2c:       │
│ PLATFORM RBAC │   │ USER OWNERSHIP  │   │ PROJECT SCOPE   │
│               │   │                 │   │                 │
│ Auth: JWT     │   │ Auth: SDK       │   │ Auth: API Key   │
│               │   │                 │   │                 │
│ Check:        │   │ Check:          │   │ Check:          │
│ ProjectMember │   │ Session creator │   │ projectScope[]  │
│ role + perms  │   │ identity match  │   │ includes projId │
│               │   │                 │   │                 │
│ Middleware:   │   │ Middleware:     │   │ Middleware:     │
│ requireProject│   │ requireSession  │   │ requireProject  │
│ Permission()  │   │ Ownership()     │   │ Scope()         │
└───────────────┘   └─────────────────┘   └─────────────────┘
```

### When Each Layer Applies

| Auth Type   | Layer 1 (Tenant) | Layer 2 (Access)                                         | Data Model                                                          |
| ----------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| User JWT    | tenantId filter  | Project RBAC: `requireProjectPermission('session:read')` | Permission-based: can access any session in projects they belong to |
| SDK Session | tenantId filter  | User ownership: `requireSessionOwnership()`              | Ownership-based: can only access sessions they created              |
| API Key     | tenantId filter  | Project scope: `requireProjectScope()`                   | Scope-based: can access any session in scoped projects              |

---

## 6. Session Ownership Middleware

### Core: `requireSessionOwnership()`

The critical missing middleware. For SDK auth, the end-user must prove they own the requested session.

```typescript
async function requireSessionOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ctx = getAuthContext(req);
  const sessionId = req.params.sessionId || req.params.id;

  if (!sessionId) {
    // Route doesn't reference a specific session (e.g., list endpoint)
    // Handled separately by query-level filtering
    return next();
  }

  switch (ctx.authType) {
    case 'sdk_session': {
      // End-user must own this session
      const session = await findSessionById(sessionId, ctx.tenantId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (!matchesSessionOwner(session, ctx.callerIdentity)) {
        // Return 404 (not 403) to avoid leaking existence
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      return next();
    }

    case 'user':
      // Platform member — needs project-level permission
      if (!(await requireProjectPermission(req, res, 'session:read'))) return;
      return next();

    case 'api_key':
      // M2M — needs project scope
      requireProjectScope('projectId')(req, res, next);
      return;
  }
}
```

### Identity Matching Logic

Same algorithm as session resolution — match on the strongest available identity:

```typescript
function matchesSessionOwner(
  session: { callerContext?: CallerContext },
  identity: CallerIdentity,
): boolean {
  const sc = session.callerContext;
  if (!sc) return false;

  // Tier 2: verified customerId (strongest)
  if (identity.customerId && sc.customerId) {
    return identity.customerId === sc.customerId;
  }

  // Tier 1: channelArtifact — hashed device/cookie/phone
  if (identity.channelArtifact && sc.channelArtifact) {
    return identity.channelArtifact === sc.channelArtifact;
  }

  // Tier 0: anonymousId (weakest — same browser session only)
  if (identity.anonymousId && sc.anonymousId) {
    return identity.anonymousId === sc.anonymousId;
  }

  return false;
}
```

### Session List Filtering (for SDK auth)

When an SDK user calls `GET /sessions`, the response must be filtered to only their sessions:

```typescript
// For SDK auth: add caller identity filter to query
function buildSessionListFilter(ctx: AuthContext, projectId: string): Record<string, unknown> {
  const base = { tenantId: ctx.tenantId, projectId };

  if (isChannelUser(ctx)) {
    const identity = ctx.callerIdentity;
    // Filter by strongest available identity
    if (identity.customerId) return { ...base, customerId: identity.customerId };
    if (identity.channelArtifact) return { ...base, channelArtifact: identity.channelArtifact };
    if (identity.anonymousId) return { ...base, anonymousId: identity.anonymousId };
    // No identity — return nothing
    return { ...base, _id: { $exists: false } };
  }

  // Platform member or API key: return all sessions in project
  return base;
}
```

---

## 7. Data Store Isolation Model

### Principle: Session as Gateway

For SDK auth, session ownership is the single checkpoint. All session-scoped data (messages, attachments, traces) is transitively accessible if the caller owns the session. No need to add `userId` to every message or attachment query — just guard the session entry point.

```
SDK Token  ──→  requireSessionOwnership()  ──→  Session  ──→  Messages
                                                         ──→  Attachments
                                                         ──→  Traces
                                                         ──→  Conversation History
```

### Per-Store Access Model

| Store           | Access Gate                 | Query Pattern                                                                           | Changes Required                                                        |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Sessions**    | `requireSessionOwnership()` | Single: `findOne({_id, tenantId})` + identity match. List: filtered by caller identity. | Add ownership check middleware. Add list filter.                        |
| **Messages**    | Transitive (session gate)   | `find({sessionId})` after session ownership verified                                    | No model changes. Add session ownership check before message access.    |
| **Attachments** | Transitive (session gate)   | `find({sessionId, tenantId})` after session ownership verified                          | No model changes. Add session ownership check before attachment access. |
| **FactStore**   | `ownerFilter()`             | `find({tenantId, userId, projectId, key})` — already complete                           | No changes. Gold standard.                                              |
| **Traces**      | Transitive (session gate)   | `find({sessionId})` after session ownership verified                                    | No model changes. Add session ownership check.                          |

### Why Transitive (Not Per-Record)?

Adding `userId` to every message and attachment record would:

- Require schema migrations on existing data
- Add index overhead on high-write collections
- Create inconsistency when session ownership transfers (identity tier promotion)
- Duplicate what session ownership already enforces

Session ownership is the correct abstraction because messages and attachments don't exist outside a session context.

---

## 8. Presigned URL Security

### Current State

Presigned URLs are time-limited (15 min default) but not user-scoped. Once generated, anyone with the URL can download.

### Enhancement

For SDK auth, validate session ownership before generating presigned URLs. The URL itself remains time-limited (this is standard for S3/GCS/Azure Blob), but the generation endpoint enforces ownership:

```
GET /api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/url
                     │                    │
                     │                    └── requireSessionOwnership() verifies caller
                     └── requireProjectScope() for API keys
```

No changes to the presigned URL format or storage provider. The security boundary is at URL generation time, not URL consumption time.

### Additional Hardening (Future)

- Reduce default presigned URL TTL to 5 minutes for SDK-generated URLs
- Log presigned URL generation in trace events (who, what, when)
- Rate-limit presigned URL generation per session

---

## 9. Route Middleware Composition

### Session Routes (`/api/projects/:projectId/sessions`)

| Route         | Method | SDK Auth                                        | User JWT Auth                            | API Key Auth                   |
| ------------- | ------ | ----------------------------------------------- | ---------------------------------------- | ------------------------------ |
| `/`           | GET    | List own sessions (filtered by caller identity) | List all (project permission)            | List all (project scope)       |
| `/`           | POST   | Create session (caller identity captured)       | Create test session (project permission) | Create session (project scope) |
| `/:id`        | GET    | Own session only                                | Project permission                       | Project scope                  |
| `/:id`        | DELETE | Own session only                                | Project permission                       | Project scope                  |
| `/:id/close`  | POST   | Own session only                                | Project permission                       | Project scope                  |
| `/:id/reset`  | POST   | Own session only                                | Project permission                       | Project scope                  |
| `/:id/traces` | GET    | Own session only                                | Project permission                       | Project scope                  |

### Attachment Routes (`/api/projects/:projectId/sessions/:sessionId/attachments`)

All attachment routes check session ownership first (since attachments are session-scoped):

| Route                | Method | SDK Auth                    | User JWT Auth      | API Key Auth  |
| -------------------- | ------ | --------------------------- | ------------------ | ------------- |
| `/`                  | POST   | Upload to own session       | Project permission | Project scope |
| `/`                  | GET    | List from own session       | Project permission | Project scope |
| `/:attachmentId`     | GET    | Own session's attachment    | Project permission | Project scope |
| `/:attachmentId/url` | GET    | Own session's presigned URL | Project permission | Project scope |
| `/:attachmentId`     | DELETE | Own session's attachment    | Project permission | Project scope |

### Message Routes

Messages are accessed through session context. Same pattern: verify session ownership for SDK auth before returning messages.

---

## 10. Migration Strategy

### Phase 1: Types & Helpers — COMPLETE

- Added `AuthContextBase`, `PlatformMemberContext`, `ChannelUserContext`, `ApiKeyContext`, `CallerIdentity` types to `packages/shared/src/types/auth-context.ts`
- Added type guards: `isPlatformMember()`, `isChannelUser()`, `isApiKey()`
- Added `toAuthContext()` / `toLegacyTenantContext()` bridge functions in `packages/shared/src/middleware/auth-context-bridge.ts`
- Added `matchesSessionOwner()` pure function
- Added `buildSessionListFilter()` pure function
- Unit tests: `auth-context-types.test.ts`, `auth-context-bridge.test.ts`

### Phase 2: Session Ownership Middleware — COMPLETE

- Implemented `createRequireSessionOwnership()` middleware in `packages/shared/src/middleware/session-ownership.ts`
- Wired into session routes (`apps/runtime/src/routes/sessions.ts`) — SDK users can only access own sessions
- Wired into attachment routes (`apps/runtime/src/routes/attachments.ts`) — session ownership verified before attachment access
- Wired into message access paths — session ownership verified before message retrieval
- Integration tests: `session-ownership-authz.test.ts`, `attachment-ownership-authz.test.ts`, `user-isolation-e2e.test.ts`

### Phase 3: Auth Context on Request — COMPLETE

- `req.authContext` (typed `AuthContext`) populated alongside `req.tenantContext` in `createUnifiedAuthMiddleware()`
- Both fields set simultaneously — no breaking changes
- Route handlers can use either; gradual migration in progress

### Phase 3.5: Security Hardening — COMPLETE (added post-design)

This phase was added after the initial implementation, driven by code review findings:

1. **SDK project isolation (fail-closed)**: `requireProjectPermission()` in `rbac.ts` now rejects SDK sessions that lack `ctx.projectId` (returns 403), and enforces cross-project guard (returns 404 on mismatch)
2. **Header trust removal**: `createUnifiedAuthMiddleware()` no longer reads `X-Tenant-Id`, `X-Organization-Id`, or `tenantId` query params. When JWT has no `tenantId` claim, resolves from `resolveDefaultTenant()` only
3. **LiveKit proxy hardening**: SDK token paths in `livekit/token/route.ts` and `livekit/capabilities/route.ts` no longer forward client-supplied `X-Tenant-Id`
4. **ALS removal**: All 15 `getCurrentTenantId()` calls in session routes replaced with `req.tenantContext!.tenantId`
5. **Studio `requireTenantAuth()`**: New helper in `apps/studio/src/lib/auth.ts` guarantees `tenantId: string` in return type — replaces `user.tenantId!` non-null assertions across all Studio proxy routes
6. **Model-config proxy**: Uses `requireTenantAuth()` + `user.tenantId` instead of reading `x-tenant-id` from client request

### Phase 4: Cleanup — PENDING

- Remove `req.tenantContext` once all consumers migrated to `req.authContext`
- Remove bridge functions
- Remove legacy `requireWriteAccess()` (already deprecated, not called from any routes)

### Backward Compatibility

- `TenantContextData` and `req.tenantContext` remain throughout Phases 1-3
- All existing middleware (`requirePermission`, `requireProjectPermission`, `requireProjectScope`) continues to work unchanged
- New middleware (`requireSessionOwnership`) is additive — added to routes that need it
- No database migrations required

---

## 11. Testing Strategy

### Unit Tests

- `matchesSessionOwner()`: all identity tier combinations, missing fields, mismatches
- `buildSessionListFilter()`: each auth type produces correct query filter
- `toAuthContext()`: each auth type converts correctly, optional fields preserved
- Type guards: exhaustive coverage

### Integration Tests (per route)

For every session-scoped route:

1. **SDK user accesses own session** → 200
2. **SDK user accesses another user's session** → 404 (not 403)
3. **SDK user lists sessions** → only own sessions returned
4. **Platform member accesses session with permission** → 200
5. **Platform member accesses session without permission** → 403
6. **API key accesses session in scoped project** → 200
7. **API key accesses session outside scope** → 403
8. **No auth** → 401

### Cross-Concern Tests

- SDK user uploads attachment to own session → can download it
- SDK user cannot download attachment from another user's session (404)
- SDK user cannot list attachments from another user's session (404)
- Session deletion by SDK user only works on own sessions
- Platform admin can access any session (project permission check, not ownership)

---

## Key Files

| File                                                                           | Purpose                                                 | Status      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------- |
| `packages/shared/src/types/auth-context.ts`                                    | Discriminated AuthContext types, CallerIdentity, guards | Implemented |
| `packages/shared/src/middleware/unified-auth.ts`                               | Auth flow dispatcher (produces AuthContext + TenantCtx) | Hardened    |
| `packages/shared/src/middleware/auth-context-bridge.ts`                        | `toAuthContext()` / `toLegacyTenantContext()` bridges   | Implemented |
| `packages/shared/src/middleware/session-ownership.ts`                          | `createRequireSessionOwnership()` middleware            | Implemented |
| `packages/shared/src/middleware/permission-guard.ts`                           | Permission guards (unchanged)                           | Existing    |
| `apps/runtime/src/middleware/rbac.ts`                                          | Project RBAC + SDK fail-closed projectId guard          | Hardened    |
| `apps/runtime/src/routes/sessions.ts`                                          | Session routes with ownership enforcement               | Hardened    |
| `apps/runtime/src/routes/attachments.ts`                                       | Attachment routes with ownership enforcement            | Hardened    |
| `apps/studio/src/lib/auth.ts`                                                  | `requireTenantAuth()` helper for Studio routes          | New         |
| `apps/studio/src/app/api/livekit/token/route.ts`                               | LiveKit proxy (no longer trusts client headers)         | Hardened    |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/model-config/route.ts` | Model config proxy (uses authenticated tenantId)        | Hardened    |
| `apps/runtime/src/services/identity/artifact-hasher.ts`                        | CallerContext builder                                   | Existing    |

### Test Files

| File                                                            | Coverage                                            |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `packages/shared/src/__tests__/auth-context-types.test.ts`      | Type guards, discriminated union                    |
| `packages/shared/src/__tests__/auth-context-bridge.test.ts`     | Bridge function conversions                         |
| `packages/shared/src/__tests__/session-ownership.test.ts`       | Ownership middleware all auth types                 |
| `packages/shared/src/__tests__/unified-auth.test.ts`            | All 3 auth flows, header trust rejection            |
| `apps/runtime/src/__tests__/middleware/rbac.test.ts`            | RBAC roles, SDK fail-closed, project mismatch       |
| `apps/runtime/src/__tests__/session-ownership-authz.test.ts`    | Session routes: own session, cross-user 404         |
| `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts` | Attachment routes: own session, cross-user 404      |
| `apps/runtime/src/__tests__/user-isolation-e2e.test.ts`         | End-to-end: two SDK users, zero cross-contamination |

---

## Design Decisions

### D1: Why session ownership instead of per-record userId?

Adding `userId` to every message and attachment would require schema migrations, index overhead, and create inconsistency during identity promotion. Session ownership is the correct abstraction — it's what the FactStore model would use if facts were session-scoped.

### D2: Why 404 instead of 403 for cross-user access?

Per CLAUDE.md security guidelines: cross-tenant/cross-user access returns 404 to avoid leaking resource existence. An attacker cannot distinguish "session exists but not yours" from "session doesn't exist."

### D3: Why discriminated union instead of fixing TenantContextData?

A discriminated union with type guards provides compile-time safety. When you switch on `authType`, TypeScript narrows the type and you get autocomplete for auth-type-specific fields. The flat `TenantContextData` requires runtime checks and `!` assertions.

### D4: Why not require userId on SDK session tokens?

End-users may be anonymous (tier 0). The identity spectrum is: anonymous → device-identified → verified. All three must work. The matching logic handles the full spectrum using `channelArtifact` and `anonymousId` as fallbacks.

### D5: Why keep requireProjectPermission() for User JWT?

Platform members (developers, admins) need to access any session in their project for debugging, monitoring, and support. This is a permission-based access model, not ownership-based. Both models coexist cleanly because they're gated by `authType`.

### D6: Why remove X-Tenant-Id header trust entirely?

The original design allowed `X-Tenant-Id` as a "hint" for multi-tenant users whose JWT lacked a `tenantId` claim — verified via `resolveTenantMembership()` DB lookup. While this DB check prevented accessing tenants the user wasn't a member of, the pattern is dangerous:

- It lets any authenticated user select which tenant context they operate in via a client-controlled header
- The membership check is a positive assertion ("is user a member?"), but the header itself is untrusted input steering authorization decisions
- A compromised or malicious client could enumerate tenants by observing 403 vs 200 responses

The fix: when JWT has no `tenantId` claim, resolve from `resolveDefaultTenant()` only. Users who need multi-tenant access must get JWTs with the correct `tenantId` claim embedded at login time.

### D7: Why fail-closed for SDK projectId?

SDK session tokens must carry a `projectId` to scope their access. If a token lacks `projectId` (e.g., from an older token format or a bug), the system rejects with 403 rather than allowing unrestricted access. This fail-closed design prevents a missing field from silently bypassing the project isolation guard.

### D8: Why requireTenantAuth() in Studio instead of requireAuth() + non-null assertion?

`requireAuth()` returns a user that may have `tenantId: string | null`. Routes that proxy to the runtime need a guaranteed `tenantId`. Rather than scattering `user.tenantId!` assertions (which crash at runtime if the assumption is wrong), `requireTenantAuth()` returns a typed `TenantAuthenticatedUser & { tenantId: string }` or a 403 response. This moves the check from runtime crash to a structured error response.

---

## 12. Implementation Status

### Summary

| Phase | Description                  | Status   | Commits                                        |
| ----- | ---------------------------- | -------- | ---------------------------------------------- |
| 1     | Types & Helpers              | Complete | `a67060ee`, `b01ecc61`, `c1828441`             |
| 2     | Session Ownership Middleware | Complete | `5fc2b25b`, `ef099d31`, `2b61d667`, `13566b2e` |
| 3     | Auth Context on Request      | Complete | `a6d829c8`, `70639408`                         |
| 3.5   | Security Hardening           | Complete | `9465fb6c`, `cd6642ae`, `ccf9042f`, `95949930` |
| 4     | Cleanup                      | Pending  | —                                              |

### Test Coverage

All auth and ownership tests pass (verified 2026-02-22):

- **Shared package**: 20/20 test files, 476/476 tests
- **Runtime package**: 221/221 test files, 5070/5070 tests

### Security Hardening Changelog (Phase 3.5)

These changes were driven by a cross-cutting code review of all three auth contexts after Phases 1–3:

| #   | Severity  | Issue                                                                       | Fix                                                                          | File                                                      |
| --- | --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | CRITICAL  | SDK auth bypassed project isolation when `ctx.projectId` was missing        | Fail-closed: reject with 403 if SDK token lacks projectId                    | `rbac.ts:129-140`                                         |
| 2   | CRITICAL  | LiveKit proxy routes forwarded client-supplied `X-Tenant-Id` in SDK path    | Removed header forwarding; runtime validates tenant from SDK token           | `livekit/token/route.ts`, `livekit/capabilities/route.ts` |
| 3   | CRITICAL  | Session routes used `getCurrentTenantId()` (ALS) — fragile, wrong store     | Replaced all 15 occurrences with `req.tenantContext!.tenantId`               | `sessions.ts`                                             |
| 4   | CRITICAL  | Unified auth read `X-Tenant-Id`/`X-Organization-Id` headers as tenant hints | Removed entirely; JWT without tenantId resolves via `resolveDefaultTenant()` | `unified-auth.ts:346-372`                                 |
| 5   | IMPORTANT | Studio proxy routes used `user.tenantId!` non-null assertion                | Added `requireTenantAuth()` helper returning guaranteed `tenantId: string`   | `auth.ts`, all proxy routes                               |
| 6   | IMPORTANT | `model-config/route.ts` read `x-tenant-id` from client request              | Switched to `requireTenantAuth()` + `user.tenantId`                          | `model-config/route.ts`                                   |
| 7   | IMPORTANT | Next.js 14 sync params in Studio routes                                     | Migrated to `Promise<{ id: string }>` with `await params`                    | Multiple Studio routes                                    |

### Remaining Work (Phase 4)

- Migrate route handlers from `req.tenantContext` to `req.authContext` (typed discriminated union)
- Remove `req.tenantContext` field once migration complete
- Remove `toLegacyTenantContext()` bridge function
- Remove legacy `requireWriteAccess()` (deprecated, not called from any routes)
- Consider removing client-side `X-Tenant-Id` header from `api-client.ts` (no longer read by server)

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate channel auth (end-user ownership) from tenant auth (platform RBAC) with type-safe discriminated union types and session ownership enforcement.

**Architecture:** Discriminated `AuthContext` union replaces flat `TenantContextData`. New `requireSessionOwnership()` middleware enforces user-level data isolation for SDK auth. Platform member and API key auth unchanged.

**Tech Stack:** TypeScript discriminated unions, Express middleware, MongoDB queries, Vitest

**Design Doc:** `docs/plans/2026-02-22-centralized-auth-design.md`

---

### Task 1: Add CallerIdentity and AuthContext Types

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/auth-context.ts`
- Test: `packages/shared/src/__tests__/auth-context-types.test.ts`

**Context:** Currently all three auth flows converge to `TenantContextData`. We need a discriminated union with separate types per auth flow. The existing `TenantContextData` stays for backward compatibility — new types coexist.

**Step 1: Write the test file**

```typescript
// packages/shared/src/__tests__/auth-context-types.test.ts
import { describe, test, expect } from 'vitest';
import {
  isPlatformMember,
  isChannelUser,
  isApiKey,
  type AuthContext,
  type PlatformMemberContext,
  type ChannelUserContext,
  type ApiKeyContext,
  type CallerIdentity,
} from '../types/auth-context.js';

describe('AuthContext type guards', () => {
  const platformCtx: PlatformMemberContext = {
    tenantId: 't1',
    authType: 'user',
    permissions: ['project:*'],
    userId: 'user-123',
    role: 'ADMIN',
    isSuperAdmin: false,
  };

  const channelCtx: ChannelUserContext = {
    tenantId: 't1',
    authType: 'sdk_session',
    permissions: ['session:execute'],
    projectId: 'proj-1',
    channelId: 'webchat',
    callerIdentity: {
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    },
  };

  const apiKeyCtx: ApiKeyContext = {
    tenantId: 't1',
    authType: 'api_key',
    permissions: ['session:read'],
    apiKeyId: 'key-1',
    clientId: 'ci-system',
    createdBy: 'user-456',
    projectScope: ['proj-1'],
  };

  test('isPlatformMember narrows correctly', () => {
    expect(isPlatformMember(platformCtx)).toBe(true);
    expect(isPlatformMember(channelCtx)).toBe(false);
    expect(isPlatformMember(apiKeyCtx)).toBe(false);
  });

  test('isChannelUser narrows correctly', () => {
    expect(isChannelUser(channelCtx)).toBe(true);
    expect(isChannelUser(platformCtx)).toBe(false);
    expect(isChannelUser(apiKeyCtx)).toBe(false);
  });

  test('isApiKey narrows correctly', () => {
    expect(isApiKey(apiKeyCtx)).toBe(true);
    expect(isApiKey(platformCtx)).toBe(false);
    expect(isApiKey(channelCtx)).toBe(false);
  });

  test('switch on authType provides exhaustive narrowing', () => {
    function getLabel(ctx: AuthContext): string {
      switch (ctx.authType) {
        case 'user':
          return `member:${ctx.userId}`;
        case 'sdk_session':
          return `channel:${ctx.channelId}`;
        case 'api_key':
          return `key:${ctx.apiKeyId}`;
      }
    }
    expect(getLabel(platformCtx)).toBe('member:user-123');
    expect(getLabel(channelCtx)).toBe('channel:webchat');
    expect(getLabel(apiKeyCtx)).toBe('key:key-1');
  });

  test('CallerIdentity with all tiers', () => {
    const tier0: CallerIdentity = {
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const tier1: CallerIdentity = {
      channelArtifact: 'hash123',
      channelArtifactType: 'cookie',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const tier2: CallerIdentity = {
      customerId: 'cust-1',
      identityTier: 2,
      verificationMethod: 'hmac',
    };

    expect(tier0.identityTier).toBe(0);
    expect(tier1.identityTier).toBe(1);
    expect(tier2.identityTier).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/auth-context-types.test.ts`
Expected: FAIL — module `../types/auth-context.js` not found

**Step 3: Implement the types**

Create `packages/shared/src/types/auth-context.ts`:

```typescript
/**
 * Discriminated Auth Context Types
 *
 * Three auth flows produce three distinct context types:
 * - PlatformMemberContext (User JWT) — RBAC permission-based access
 * - ChannelUserContext (SDK Session Token) — ownership-based access
 * - ApiKeyContext (API Key) — scope-based access
 */

import type { AuthType, ChannelArtifactType, IdentityTier, VerificationMethod } from './index.js';

// ─── CallerIdentity ──────────────────────────────────────────────
/** End-user identity carried by SDK session tokens. */
export interface CallerIdentity {
  customerId?: string;
  anonymousId?: string;
  contactId?: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
}

// ─── Base ────────────────────────────────────────────────────────
interface AuthContextBase {
  tenantId: string;
  orgId?: string;
  authType: AuthType;
  permissions: string[];
}

// ─── Flow 1: Platform Member ─────────────────────────────────────
export interface PlatformMemberContext extends AuthContextBase {
  authType: 'user';
  userId: string;
  role: string;
  isSuperAdmin: boolean;
}

// ─── Flow 2: Channel End-User ────────────────────────────────────
export interface ChannelUserContext extends AuthContextBase {
  authType: 'sdk_session';
  projectId: string;
  channelId: string;
  deploymentId?: string;
  sessionId?: string;
  callerIdentity: CallerIdentity;
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
}

// ─── Flow 3: Machine-to-Machine ──────────────────────────────────
export interface ApiKeyContext extends AuthContextBase {
  authType: 'api_key';
  apiKeyId: string;
  clientId: string;
  createdBy: string;
  projectScope?: string[];
  environmentScope?: string[];
}

// ─── Union ───────────────────────────────────────────────────────
export type AuthContext = PlatformMemberContext | ChannelUserContext | ApiKeyContext;

// ─── Type Guards ─────────────────────────────────────────────────
export function isPlatformMember(ctx: AuthContext): ctx is PlatformMemberContext {
  return ctx.authType === 'user';
}
export function isChannelUser(ctx: AuthContext): ctx is ChannelUserContext {
  return ctx.authType === 'sdk_session';
}
export function isApiKey(ctx: AuthContext): ctx is ApiKeyContext {
  return ctx.authType === 'api_key';
}
```

Re-export from `packages/shared/src/types/index.ts`:

```typescript
export type {
  CallerIdentity,
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
} from './auth-context.js';
export { isPlatformMember, isChannelUser, isApiKey } from './auth-context.js';
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm build && pnpm test -- --run src/__tests__/auth-context-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/types/auth-context.ts packages/shared/src/types/index.ts packages/shared/src/__tests__/auth-context-types.test.ts
git commit -m "feat(shared): add discriminated AuthContext types and CallerIdentity"
```

---

### Task 2: Add Bridge Functions (TenantContextData ↔ AuthContext)

**Files:**

- Create: `packages/shared/src/middleware/auth-context-bridge.ts`
- Test: `packages/shared/src/__tests__/auth-context-bridge.test.ts`

**Context:** During migration, we need to convert between `TenantContextData` (legacy) and `AuthContext` (new). The `toAuthContext()` function extracts the discriminated type from the flat struct. The `toLegacyTenantContext()` function flattens back.

**Step 1: Write the test file**

```typescript
// packages/shared/src/__tests__/auth-context-bridge.test.ts
import { describe, test, expect } from 'vitest';
import { toAuthContext, toLegacyTenantContext } from '../middleware/auth-context-bridge.js';
import type { TenantContextData } from '../types/index.js';

describe('toAuthContext', () => {
  test('converts User JWT TenantContextData to PlatformMemberContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-123',
      role: 'ADMIN',
      permissions: ['project:*'],
      authType: 'user',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('user');
    if (ctx.authType === 'user') {
      expect(ctx.userId).toBe('user-123');
      expect(ctx.role).toBe('ADMIN');
      expect(ctx.isSuperAdmin).toBe(false);
    }
  });

  test('converts SDK session TenantContextData to ChannelUserContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: ['session:execute'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
      deploymentId: 'dep-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      channelArtifact: 'hash-abc',
      userContext: { userId: 'cust-xyz' },
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('sdk_session');
    if (ctx.authType === 'sdk_session') {
      expect(ctx.channelId).toBe('webchat');
      expect(ctx.callerIdentity.identityTier).toBe(2);
      expect(ctx.callerIdentity.verificationMethod).toBe('hmac');
      expect(ctx.callerIdentity.channelArtifact).toBe('hash-abc');
      expect(ctx.callerIdentity.customerId).toBe('cust-xyz');
    }
  });

  test('converts API key TenantContextData to ApiKeyContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-456',
      role: 'api_key',
      permissions: ['session:read'],
      authType: 'api_key',
      isSuperAdmin: false,
      apiKeyId: 'key-1',
      clientId: 'ci-system',
      projectScope: ['proj-1'],
    };
    const ctx = toAuthContext(legacy);
    expect(ctx.authType).toBe('api_key');
    if (ctx.authType === 'api_key') {
      expect(ctx.apiKeyId).toBe('key-1');
      expect(ctx.clientId).toBe('ci-system');
      expect(ctx.createdBy).toBe('user-456');
      expect(ctx.projectScope).toEqual(['proj-1']);
    }
  });

  test('SDK session without identity fields defaults to tier 0', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: [],
      authType: 'sdk_session',
      isSuperAdmin: false,
      channelId: 'webchat',
    };
    const ctx = toAuthContext(legacy);
    if (ctx.authType === 'sdk_session') {
      expect(ctx.callerIdentity.identityTier).toBe(0);
      expect(ctx.callerIdentity.verificationMethod).toBe('none');
    }
  });
});

describe('toLegacyTenantContext', () => {
  test('round-trips PlatformMemberContext', () => {
    const legacy: TenantContextData = {
      tenantId: 't1',
      userId: 'user-123',
      role: 'ADMIN',
      permissions: ['project:*'],
      authType: 'user',
      isSuperAdmin: false,
    };
    const ctx = toAuthContext(legacy);
    const back = toLegacyTenantContext(ctx);
    expect(back.tenantId).toBe('t1');
    expect(back.userId).toBe('user-123');
    expect(back.role).toBe('ADMIN');
    expect(back.authType).toBe('user');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/auth-context-bridge.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the bridge functions**

Create `packages/shared/src/middleware/auth-context-bridge.ts`:

```typescript
/**
 * Bridge functions for TenantContextData ↔ AuthContext conversion.
 * Used during migration from flat TenantContextData to discriminated AuthContext.
 */

import type { TenantContextData } from '../types/index.js';
import type {
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  CallerIdentity,
} from '../types/auth-context.js';

/**
 * Convert legacy TenantContextData to typed AuthContext.
 * Extracts auth-type-specific fields into the correct discriminated variant.
 */
export function toAuthContext(ctx: TenantContextData): AuthContext {
  switch (ctx.authType) {
    case 'user':
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'user',
        permissions: ctx.permissions,
        userId: ctx.userId,
        role: ctx.role,
        isSuperAdmin: ctx.isSuperAdmin,
      } satisfies PlatformMemberContext;

    case 'sdk_session': {
      const callerIdentity: CallerIdentity = {
        customerId: ctx.userContext?.userId,
        channelArtifact: ctx.channelArtifact,
        identityTier: ctx.identityTier ?? 0,
        verificationMethod: ctx.verificationMethod ?? 'none',
      };
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'sdk_session',
        permissions: ctx.permissions,
        projectId: '', // Populated from SDKSessionTokenPayload.projectId at middleware level
        channelId: ctx.channelId ?? '',
        deploymentId: ctx.deploymentId,
        sessionId: ctx.sessionId,
        callerIdentity,
        userContext: ctx.userContext,
      } satisfies ChannelUserContext;
    }

    case 'api_key':
      return {
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        authType: 'api_key',
        permissions: ctx.permissions,
        apiKeyId: ctx.apiKeyId ?? '',
        clientId: ctx.clientId ?? '',
        createdBy: ctx.userId,
        projectScope: ctx.projectScope,
        environmentScope: ctx.environmentScope,
      } satisfies ApiKeyContext;
  }
}

/**
 * Convert typed AuthContext back to legacy TenantContextData.
 * Used for backward compatibility with code that still reads TenantContextData.
 */
export function toLegacyTenantContext(ctx: AuthContext): TenantContextData {
  const base: TenantContextData = {
    tenantId: ctx.tenantId,
    orgId: ctx.orgId,
    userId: '',
    role: '',
    permissions: ctx.permissions,
    authType: ctx.authType,
    isSuperAdmin: false,
  };

  switch (ctx.authType) {
    case 'user':
      return { ...base, userId: ctx.userId, role: ctx.role, isSuperAdmin: ctx.isSuperAdmin };

    case 'sdk_session':
      return {
        ...base,
        userId: `sdk:${ctx.channelId}`,
        role: 'sdk_session',
        channelId: ctx.channelId,
        deploymentId: ctx.deploymentId,
        sessionId: ctx.sessionId,
        identityTier: ctx.callerIdentity.identityTier,
        verificationMethod: ctx.callerIdentity.verificationMethod,
        channelArtifact: ctx.callerIdentity.channelArtifact,
        userContext: ctx.userContext,
      };

    case 'api_key':
      return {
        ...base,
        userId: ctx.createdBy,
        role: 'api_key',
        apiKeyId: ctx.apiKeyId,
        clientId: ctx.clientId,
        projectScope: ctx.projectScope,
        environmentScope: ctx.environmentScope,
      };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm build && pnpm test -- --run src/__tests__/auth-context-bridge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/middleware/auth-context-bridge.ts packages/shared/src/__tests__/auth-context-bridge.test.ts
git commit -m "feat(shared): add TenantContextData ↔ AuthContext bridge functions"
```

---

### Task 3: Add matchesSessionOwner() and buildSessionListFilter()

**Files:**

- Create: `packages/shared/src/middleware/session-ownership.ts`
- Test: `packages/shared/src/__tests__/session-ownership.test.ts`

**Context:** Two pure functions that are the core of session ownership enforcement. `matchesSessionOwner()` compares a session's caller identity to the requesting user's identity (tier 2 > tier 1 > tier 0 fallback). `buildSessionListFilter()` produces a MongoDB filter for listing sessions scoped to the caller.

**Step 1: Write the test file**

```typescript
// packages/shared/src/__tests__/session-ownership.test.ts
import { describe, test, expect } from 'vitest';
import { matchesSessionOwner, buildSessionListFilter } from '../middleware/session-ownership.js';
import type { CallerIdentity, ChannelUserContext } from '../types/auth-context.js';
import type { CallerContext } from '../types/index.js';

describe('matchesSessionOwner', () => {
  test('tier 2: customerId match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 2: customerId mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-xyz',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier 1: channelArtifact match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const identity: CallerIdentity = {
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 1: channelArtifact mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      channelArtifact: 'hash-123',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    const identity: CallerIdentity = {
      channelArtifact: 'hash-999',
      identityTier: 1,
      verificationMethod: 'cookie',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('tier 0: anonymousId match', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });

  test('tier 0: anonymousId mismatch', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      anonymousId: 'anon-1',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      anonymousId: 'anon-2',
      identityTier: 0,
      verificationMethod: 'none',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('no matching identity fields returns false', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      identityTier: 0,
      verificationMethod: 'none',
    };
    const identity: CallerIdentity = {
      identityTier: 0,
      verificationMethod: 'none',
    };
    expect(matchesSessionOwner(session, identity)).toBe(false);
  });

  test('customerId takes priority over channelArtifact', () => {
    const session: CallerContext = {
      tenantId: 't1',
      channel: 'webchat',
      customerId: 'cust-abc',
      channelArtifact: 'hash-999',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    const identity: CallerIdentity = {
      customerId: 'cust-abc',
      channelArtifact: 'hash-different',
      identityTier: 2,
      verificationMethod: 'hmac',
    };
    // Matches on customerId (tier 2), doesn't check channelArtifact
    expect(matchesSessionOwner(session, identity)).toBe(true);
  });
});

describe('buildSessionListFilter', () => {
  test('SDK auth: filters by customerId when available', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: { customerId: 'cust-1', identityTier: 2, verificationMethod: 'hmac' },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({ tenantId: 't1', projectId: 'proj-1', customerId: 'cust-1' });
  });

  test('SDK auth: filters by channelArtifact when no customerId', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: {
        channelArtifact: 'hash-abc',
        identityTier: 1,
        verificationMethod: 'cookie',
      },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({ tenantId: 't1', projectId: 'proj-1', channelArtifact: 'hash-abc' });
  });

  test('SDK auth: filters by anonymousId as last resort', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: { anonymousId: 'anon-1', identityTier: 0, verificationMethod: 'none' },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toEqual({ tenantId: 't1', projectId: 'proj-1', anonymousId: 'anon-1' });
  });

  test('SDK auth: no identity returns impossible filter', () => {
    const ctx: ChannelUserContext = {
      tenantId: 't1',
      authType: 'sdk_session',
      permissions: [],
      projectId: 'proj-1',
      channelId: 'webchat',
      callerIdentity: { identityTier: 0, verificationMethod: 'none' },
    };
    const filter = buildSessionListFilter(ctx, 'proj-1');
    expect(filter).toHaveProperty('_id');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/session-ownership.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the functions**

Create `packages/shared/src/middleware/session-ownership.ts`:

```typescript
/**
 * Session Ownership — Pure Functions
 *
 * matchesSessionOwner(): Compares a session's caller identity to a requesting
 * user's CallerIdentity. Used by requireSessionOwnership() middleware.
 *
 * buildSessionListFilter(): Produces a MongoDB filter for listing sessions
 * scoped to the calling end-user's identity.
 */

import type { CallerContext } from '../types/index.js';
import type { CallerIdentity, AuthContext, ChannelUserContext } from '../types/auth-context.js';

/**
 * Check if the requesting user owns the session.
 * Matches on the strongest available identity tier:
 *   Tier 2 (customerId) > Tier 1 (channelArtifact) > Tier 0 (anonymousId)
 */
export function matchesSessionOwner(
  sessionCaller: CallerContext,
  requestIdentity: CallerIdentity,
): boolean {
  // Tier 2: verified customerId (strongest)
  if (requestIdentity.customerId && sessionCaller.customerId) {
    return requestIdentity.customerId === sessionCaller.customerId;
  }

  // Tier 1: channelArtifact — SHA-256 hashed device/cookie/phone
  if (requestIdentity.channelArtifact && sessionCaller.channelArtifact) {
    return requestIdentity.channelArtifact === sessionCaller.channelArtifact;
  }

  // Tier 0: anonymousId — ephemeral session identity
  if (requestIdentity.anonymousId && sessionCaller.anonymousId) {
    return requestIdentity.anonymousId === sessionCaller.anonymousId;
  }

  return false;
}

/**
 * Build a MongoDB filter for listing sessions scoped to the caller's identity.
 * For SDK auth: only returns sessions that belong to this end-user.
 * For other auth types: returns all sessions in the project (access controlled elsewhere).
 */
export function buildSessionListFilter(
  ctx: AuthContext,
  projectId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { tenantId: ctx.tenantId, projectId };

  if (ctx.authType !== 'sdk_session') {
    // Platform member or API key: all sessions in project
    return base;
  }

  const identity = (ctx as ChannelUserContext).callerIdentity;

  // Filter by strongest available identity
  if (identity.customerId) {
    return { ...base, customerId: identity.customerId };
  }
  if (identity.channelArtifact) {
    return { ...base, channelArtifact: identity.channelArtifact };
  }
  if (identity.anonymousId) {
    return { ...base, anonymousId: identity.anonymousId };
  }

  // No identity — return impossible filter (no sessions match)
  return { ...base, _id: { $exists: false } };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm build && pnpm test -- --run src/__tests__/session-ownership.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/middleware/session-ownership.ts packages/shared/src/__tests__/session-ownership.test.ts
git commit -m "feat(shared): add matchesSessionOwner() and buildSessionListFilter()"
```

---

### Task 4: Add requireSessionOwnership() Express Middleware

**Files:**

- Modify: `packages/shared/src/middleware/session-ownership.ts` (add middleware)
- Test: `packages/shared/src/__tests__/session-ownership-middleware.test.ts`

**Context:** The middleware that wires `matchesSessionOwner()` into Express routes. For SDK auth, loads the session and checks identity match. For User JWT, delegates to `requireProjectPermission()`. For API keys, delegates to `requireProjectScope()`.

**Step 1: Write the test file**

Tests should cover:

- SDK user accessing own session → calls next()
- SDK user accessing another user's session → 404
- SDK user with no sessionId param → calls next() (for list routes)
- User JWT → delegates to project permission check (mocked)
- API key → delegates to project scope check (mocked)
- No auth → 401

Use Express supertest or mock `req`/`res`/`next` objects.

**Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test -- --run src/__tests__/session-ownership-middleware.test.ts`
Expected: FAIL

**Step 3: Implement the middleware**

Add to `packages/shared/src/middleware/session-ownership.ts`:

```typescript
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { TenantContextData } from '../types/index.js';
import { toAuthContext } from './auth-context-bridge.js';

export interface SessionOwnershipConfig {
  /** Load a session by ID and tenantId. Returns session with callerContext or null. */
  findSession(
    sessionId: string,
    tenantId: string,
  ): Promise<{ callerContext?: CallerContext } | null>;
}

/**
 * Middleware factory: enforce session ownership for SDK auth.
 *
 * For SDK sessions:  loads session, checks identity match. Returns 404 on mismatch.
 * For User JWT:      passes through (project-level RBAC checked elsewhere).
 * For API Key:       passes through (project scope checked elsewhere).
 */
export function createRequireSessionOwnership(config: SessionOwnershipConfig): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantCtx = req.tenantContext as TenantContextData | undefined;
    if (!tenantCtx) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const sessionId = req.params.sessionId || req.params.id;
    if (!sessionId) {
      // No session referenced (e.g., list endpoint) — pass through
      return next();
    }

    if (tenantCtx.authType !== 'sdk_session') {
      // Platform member or API key — ownership not enforced here
      return next();
    }

    // SDK session auth — verify ownership
    const ctx = toAuthContext(tenantCtx);
    if (ctx.authType !== 'sdk_session') return next();

    const session = await config.findSession(sessionId, ctx.tenantId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!session.callerContext) {
      // Session has no caller context — deny access (defensive)
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!matchesSessionOwner(session.callerContext, ctx.callerIdentity)) {
      // Return 404 (not 403) to avoid leaking existence
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    next();
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm build && pnpm test -- --run src/__tests__/session-ownership-middleware.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/middleware/session-ownership.ts packages/shared/src/__tests__/session-ownership-middleware.test.ts
git commit -m "feat(shared): add createRequireSessionOwnership() middleware"
```

---

### Task 5: Wire Session Ownership into Session Routes

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`
- Test: `apps/runtime/src/__tests__/session-ownership-authz.test.ts`

**Context:** Apply `createRequireSessionOwnership()` to all session routes that accept a `:id` or `:sessionId` parameter. Session listing uses `buildSessionListFilter()` to scope results for SDK auth.

**Step 1: Write integration tests**

Tests should use the existing authz test patterns from `sessions-authz.test.ts`:

1. SDK user with matching customerId → 200
2. SDK user with non-matching customerId → 404
3. SDK user listing sessions → only own sessions returned
4. Platform member with session:read → 200 (any session)
5. API key with project scope → 200

**Step 2: Run test to verify it fails**

Expected: Tests calling with SDK auth on non-owned sessions currently return 200 (the gap).

**Step 3: Wire the middleware**

In `apps/runtime/src/routes/sessions.ts`:

1. Import `createRequireSessionOwnership` and `buildSessionListFilter` from `@agent-platform/shared`
2. Create the middleware instance with the session repo's `findSessionById` function
3. Apply to all routes with `:id` parameter (GET, DELETE, close, reset, traces, agent-spec, analysis)
4. In the list handler (GET `/`), use `buildSessionListFilter()` to scope the query when `authType === 'sdk_session'`

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm build && pnpm test -- --run src/__tests__/session-ownership-authz.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts apps/runtime/src/__tests__/session-ownership-authz.test.ts
git commit -m "feat(runtime): enforce session ownership on session routes for SDK auth"
```

---

### Task 6: Wire Session Ownership into Attachment Routes

**Files:**

- Modify: `apps/runtime/src/routes/attachments.ts`
- Test: `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts`

**Context:** All attachment routes are under `/api/projects/:projectId/sessions/:sessionId/attachments`. The `:sessionId` param provides the ownership check point. Apply `createRequireSessionOwnership()` to verify the SDK user owns the session before granting access to its attachments.

**Step 1: Write integration tests**

1. SDK user uploads to own session → 201
2. SDK user uploads to another user's session → 404
3. SDK user lists own session's attachments → 200
4. SDK user lists another user's session's attachments → 404
5. SDK user downloads from own session → 200
6. SDK user downloads from another user's session → 404
7. Platform member with attachment:read → 200 (any session)

**Step 2: Run test to verify it fails**

Expected: Cross-user attachment access currently returns 200 (the gap).

**Step 3: Wire the middleware**

In `apps/runtime/src/routes/attachments.ts`:

1. Import `createRequireSessionOwnership`
2. Create middleware instance (same `findSession` function as sessions route)
3. Apply as `router.use(requireSessionOwnership)` — all attachment routes need session ownership

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm build && pnpm test -- --run src/__tests__/attachment-ownership-authz.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/attachments.ts apps/runtime/src/__tests__/attachment-ownership-authz.test.ts
git commit -m "feat(runtime): enforce session ownership on attachment routes for SDK auth"
```

---

### Task 7: Wire Session Ownership into Message Access Paths

**Files:**

- Modify: `apps/runtime/src/repos/session-repo.ts` (or wherever messages are queried from routes)
- Modify: Any message-related route handlers
- Test: `apps/runtime/src/__tests__/message-ownership-authz.test.ts`

**Context:** Messages are accessed via session context (conversation history, GET messages). The session ownership middleware on session routes transitively protects messages. If there are separate message endpoints, they need the same guard.

**Step 1: Identify all message access points**

Search for routes that return messages or conversation history. These include:

- Session detail endpoint (may include recent messages)
- WebSocket message handler (already has session resolution — check ownership)
- REST chat endpoint (session-based)
- Any dedicated message listing endpoints

**Step 2: Write tests for message access via SDK auth**

1. SDK user gets own session's messages → 200
2. SDK user gets another user's session's messages → 404

**Step 3: Apply ownership checks**

If message routes go through session routes (nested under `/sessions/:id/...`), the middleware from Task 5 covers them. If there are separate message routes, apply `createRequireSessionOwnership()` there too.

**Step 4: Run test to verify it passes**

Run: `cd apps/runtime && pnpm build && pnpm test -- --run src/__tests__/message-ownership-authz.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add <modified files>
git commit -m "feat(runtime): enforce session ownership on message access for SDK auth"
```

---

### Task 8: Populate req.authContext in Unified Auth Middleware

**Files:**

- Modify: `packages/shared/src/middleware/unified-auth.ts`
- Modify: Express request type declaration in `packages/shared/src/types/index.ts`
- Test: `packages/shared/src/__tests__/unified-auth-context.test.ts`

**Context:** Add `req.authContext` (typed `AuthContext`) alongside existing `req.tenantContext`. Both are populated simultaneously. This lets new code use the typed union while legacy code continues reading `tenantContext`.

**Step 1: Extend Express Request type**

In `packages/shared/src/types/index.ts`, add to the global declaration:

```typescript
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenantContext?: TenantContextData;
      authContext?: AuthContext; // NEW: typed discriminated union
      mfaPending?: boolean;
      sdkInit?: SDKInitData;
    }
  }
}
```

**Step 2: Write tests**

Test that after auth middleware runs:

- User JWT request has both `req.tenantContext` and `req.authContext` with `authType: 'user'`
- SDK session request has `req.authContext` with `authType: 'sdk_session'` and populated `callerIdentity`
- API key request has `req.authContext` with `authType: 'api_key'`

**Step 3: Add authContext population**

In `createUnifiedAuthMiddleware()`, after setting `req.tenantContext = ctx`, add:

```typescript
req.authContext = toAuthContext(ctx);
```

For SDK sessions, also populate `projectId` from the token payload:

```typescript
if (ctx.authType === 'sdk_session' && req.authContext?.authType === 'sdk_session') {
  (req.authContext as ChannelUserContext).projectId = payload.projectId;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm build && pnpm test -- --run src/__tests__/unified-auth-context.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/middleware/unified-auth.ts packages/shared/src/types/index.ts packages/shared/src/__tests__/unified-auth-context.test.ts
git commit -m "feat(shared): populate req.authContext alongside req.tenantContext"
```

---

### Task 9: Add SDK projectId to SDKSessionTokenPayload and ChannelUserContext

**Files:**

- Verify: `packages/shared/src/types/index.ts` — `SDKSessionTokenPayload` already has `projectId`
- Modify: `packages/shared/src/middleware/unified-auth.ts` — propagate `projectId` to `TenantContextData`
- Test: Existing SDK auth tests

**Context:** `SDKSessionTokenPayload` has `projectId` but `TenantContextData` doesn't carry it. The `ChannelUserContext` needs it for `buildSessionListFilter()`. Ensure `projectId` flows from token → TenantContextData → AuthContext.

**Step 1: Verify projectId is in SDKSessionTokenPayload**

Confirm `packages/shared/src/types/index.ts` has `projectId: string` in `SDKSessionTokenPayload`. (It does per our earlier read.)

**Step 2: Add projectId to TenantContextData (if missing)**

If not already present, add `projectId?: string` to `TenantContextData`. Then in the SDK session path of `createUnifiedAuthMiddleware()`, set `ctx.projectId = payload.projectId`.

**Step 3: Update bridge function**

In `toAuthContext()`, read `ctx.projectId` (if present on TenantContextData) to populate `ChannelUserContext.projectId`.

**Step 4: Run existing tests**

Run: `cd packages/shared && pnpm build && pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts packages/shared/src/middleware/unified-auth.ts packages/shared/src/middleware/auth-context-bridge.ts
git commit -m "feat(shared): propagate projectId from SDK token to AuthContext"
```

---

### Task 10: End-to-End Integration Test

**Files:**

- Create: `apps/runtime/src/__tests__/user-isolation-e2e.test.ts`

**Context:** Comprehensive end-to-end test that creates two SDK users in the same project, creates sessions for each, and verifies complete isolation: session access, message access, attachment access.

**Test Scenarios:**

1. **Setup:** Create two SDK session tokens with different callerIdentities (user A and user B) in the same project
2. **Session isolation:** User A creates session → User A can access it → User B gets 404
3. **Session listing:** User A lists sessions → only sees own sessions, not User B's
4. **Message isolation:** User A's session has messages → User A can read them → User B gets 404 on session (so can't reach messages)
5. **Attachment isolation:** User A uploads to own session → User A can download → User B gets 404 on session
6. **Platform member access:** Admin JWT user can access both sessions (project permission)
7. **Cross-tenant isolation:** SDK user from tenant B cannot access tenant A sessions (existing behavior, regression test)

**Step 1: Write the test**
**Step 2: Run and verify failures** (some should fail before Tasks 5-7 are applied)
**Step 3: All should pass after Tasks 5-7**
**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/user-isolation-e2e.test.ts
git commit -m "test(runtime): add end-to-end user isolation tests for SDK auth"
```

---

## Task Dependency Graph

```
Task 1 (types)
  ↓
Task 2 (bridge functions)
  ↓
Task 3 (pure functions: matchesSessionOwner, buildSessionListFilter)
  ↓
Task 4 (Express middleware)
  ↓
  ├── Task 5 (wire session routes)
  ├── Task 6 (wire attachment routes)
  └── Task 7 (wire message access)
  ↓
Task 8 (populate req.authContext)
  ↓
Task 9 (propagate SDK projectId)
  ↓
Task 10 (end-to-end test)
```

Tasks 1-4 are sequential (each depends on previous). Tasks 5-7 can be done in parallel after Task 4. Tasks 8-9 can be done in parallel with 5-7. Task 10 depends on all previous tasks.

---

## Verification Checklist

After all tasks complete, verify:

- [ ] `pnpm build` succeeds across all packages
- [ ] `pnpm test` passes across all packages
- [ ] SDK user can only access own sessions (GET, DELETE, close, reset, traces)
- [ ] SDK user session listing returns only own sessions
- [ ] SDK user can only access own session's attachments
- [ ] SDK user can only access own session's messages
- [ ] Platform member can access any session in their project (unchanged)
- [ ] API key can access any session in scoped projects (unchanged)
- [ ] Cross-tenant access returns 404 (unchanged, regression test)
- [ ] No breaking changes to existing auth flows
