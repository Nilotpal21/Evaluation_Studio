# SearchAI End-User Authentication — Low-Level Design

## Task T-1: Shared IdP Token Validator (`packages/shared-auth`)

### Files to Create

- `packages/shared-auth/src/idp/idp-token-validator.ts` — Core validator class (moved from search-ai-runtime)
- `packages/shared-auth/src/idp/types.ts` — Types (IdPProvider, UserIdentity, IdPValidationConfig)
- `packages/shared-auth/src/idp/index.ts` — Barrel export

### Files to Modify

- `packages/shared-auth/src/index.ts` — Add `export * from './idp/index.js'`
- `packages/shared-auth/package.json` — Add `./idp` export entry, add `jwks-rsa` dependency
- `packages/shared-auth/tsconfig.json` — No changes needed (already includes `src/**/*`)
- `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts` — Update import path
- `apps/search-ai-runtime/src/routes/query.ts` — No changes (middleware handles it)

### Function Signatures

```typescript
// packages/shared-auth/src/idp/types.ts
export type IdPProvider = 'azuread' | 'okta' | 'google' | 'custom';

export interface UserIdentity {
  email: string;
  name?: string;
  idpUserId: string;
  idpProvider: IdPProvider;
  domain: string;
  groups?: string[];
}

export interface IdPValidationConfig {
  /** Expected issuer URI (from auth profile config) */
  expectedIssuer?: string;
  /** Expected audience / clientId (from auth profile config) */
  expectedAudience?: string;
  /** Allowed email domains — empty = allow all */
  allowedDomains?: string[];
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

// packages/shared-auth/src/idp/idp-token-validator.ts
export class IdPTokenValidator {
  constructor(redis: RedisLike);

  validateToken(
    token: string,
    tenantId: string,
    config?: IdPValidationConfig,
  ): Promise<UserIdentity>;

  invalidateJWKSCache(tenantId: string): Promise<void>;
}
```

### Subtasks (execution order)

1. **ST-1.1**: Create `packages/shared-auth/src/idp/types.ts` with `IdPProvider`, `UserIdentity`, `IdPValidationConfig`, `RedisLike` interface
2. **ST-1.2**: Create `packages/shared-auth/src/idp/idp-token-validator.ts` — copy from `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts`, refactor to:
   - Accept `RedisLike` interface (not concrete `RedisClient`)
   - Accept `IdPValidationConfig` for issuer/audience/domain validation
   - Add `expectedAudience` check in `validateToken()` (verify `aud` claim matches config)
   - Add `allowedDomains` check after email extraction
   - Keep all existing provider detection + JWKS caching logic
3. **ST-1.3**: Create `packages/shared-auth/src/idp/index.ts` barrel export
4. **ST-1.4**: Update `packages/shared-auth/src/index.ts` — add IdP export line
5. **ST-1.5**: Update `packages/shared-auth/package.json` — add `./idp` export entry and `jwks-rsa` dependency
6. **ST-1.6**: Update `apps/search-ai-runtime/src/services/idp/idp-token-validator.ts` — re-export from shared-auth for backward compat (thin wrapper)

### Acceptance Criteria

- AC-1.1: `import { IdPTokenValidator } from '@agent-platform/shared-auth/idp'` compiles
  - Verify: `pnpm build --filter=@agent-platform/shared-auth`
  - Expected: Clean build, no type errors
- AC-1.2: Existing search-ai-runtime `permission-filter.middleware.ts` still works unchanged
  - Verify: `pnpm build --filter=@agent-platform/search-ai-runtime`
  - Expected: No import errors — backward-compat re-export works
- AC-1.3: Audience validation rejects tokens with wrong `aud` claim
  - Verify: Unit test with mocked JWKS
  - Expected: Token with `aud: 'wrong-client'` throws error

---

## Task T-2: Search Session Token (`packages/shared-auth`)

### Files to Create

- `packages/shared-auth/src/idp/search-session-token.ts` — Token issuer + verifier

### Files to Modify

- `packages/shared-auth/src/idp/index.ts` — Add session token exports
- `packages/shared-auth/src/idp/types.ts` — Add `SearchSessionTokenPayload` interface

### Function Signatures

```typescript
// packages/shared-auth/src/idp/types.ts (additions)
export interface SearchSessionTokenPayload {
  type: 'search_session';
  iss: 'abl:search-runtime';
  aud: 'abl:search-query';
  sub: string; // User email (lowercase)
  tenantId: string;
  projectId: string;
  domain: string;
  groups?: string[];
  contactId?: string;
  idpProvider: string;
  iat: number;
  exp: number;
}

export interface SearchSessionTokenOptions {
  email: string;
  tenantId: string;
  projectId: string;
  domain: string;
  groups?: string[];
  contactId?: string;
  idpProvider: string;
  ttlSeconds: number;
}

// packages/shared-auth/src/idp/search-session-token.ts
export function issueSearchSessionToken(
  options: SearchSessionTokenOptions,
  jwtSecret: string,
): string;

export function verifySearchSessionToken(
  token: string,
  jwtSecret: string,
): SearchSessionTokenPayload;
```

### Subtasks (execution order)

1. **ST-2.1**: Add `SearchSessionTokenPayload` and `SearchSessionTokenOptions` to `types.ts`
2. **ST-2.2**: Create `search-session-token.ts` with:
   - `issueSearchSessionToken()` — uses `jsonwebtoken.sign()` with discriminators
   - `verifySearchSessionToken()` — uses `jsonwebtoken.verify()` then validates `type`, `iss`, `aud`
   - Rejects tokens where `type !== 'search_session'` or `iss !== 'abl:search-runtime'` or `aud !== 'abl:search-query'`
3. **ST-2.3**: Export from `idp/index.ts`

### Acceptance Criteria

- AC-2.1: Round-trip: issue → verify returns same claims
  - Verify: Unit test
  - Expected: All fields preserved after issue + verify cycle
- AC-2.2: Token with wrong `type` field rejected
  - Verify: Unit test — modify payload type to `'sdk_session'`
  - Expected: Throws with "Invalid token type"
- AC-2.3: Expired token rejected
  - Verify: Unit test with `ttlSeconds: -1`
  - Expected: Throws with expiration error

---

## Task T-3: Database Schema — `publicApiAccess` on ProjectSettings

### Files to Modify

- `packages/database/src/models/project-settings.model.ts` — Add interface + schema field

### Function Signatures

```typescript
// Added to packages/database/src/models/project-settings.model.ts

export interface IPublicApiAccessScopeConfig {
  enabled: boolean;
  authProfileId: string;
  allowedDomains: string[];
  allowedOrigins: string[];
  sessionTokenTtlSeconds: number;
  rateLimits: {
    perUserPerMinute: number;
    perProjectPerMinute: number;
  };
}

export interface IPublicApiAccessSettings {
  scopes: {
    'search.query'?: IPublicApiAccessScopeConfig;
  };
}

// Added to IProjectSettings interface:
export interface IProjectSettings {
  // ... existing fields ...
  publicApiAccess: IPublicApiAccessSettings | null;
}
```

### Subtasks (execution order)

1. **ST-3.1**: Add `IPublicApiAccessScopeConfig` and `IPublicApiAccessSettings` interfaces to `project-settings.model.ts`
2. **ST-3.2**: Add `publicApiAccess` field to `IProjectSettings` interface
3. **ST-3.3**: Add `publicApiAccess` field to Mongoose schema (Schema.Types.Mixed, default null)

### Acceptance Criteria

- AC-3.1: Build succeeds with new field
  - Verify: `pnpm build --filter=@agent-platform/database`
  - Expected: Clean build
- AC-3.2: Existing project settings documents unaffected (field defaults to null)
  - Verify: Read existing ProjectSettings doc — `publicApiAccess` is undefined/null
  - Expected: No migration needed
- AC-3.3: Can create a ProjectSettings with the new field populated
  - Verify: Integration test creates doc with `publicApiAccess.scopes['search.query']`
  - Expected: Document persists and reads back correctly

---

## Task T-4: End-User Auth in `apps/search-ai-runtime`

### Files to Create

- `apps/search-ai-runtime/src/middleware/end-user-auth.middleware.ts` — Core end-user auth middleware
- `apps/search-ai-runtime/src/routes/auth.ts` — `/api/search/auth/token` route
- `apps/search-ai-runtime/src/services/end-user/end-user-auth.service.ts` — Business logic (validate, issue token, create contact)
- `apps/search-ai-runtime/src/middleware/end-user-cors.middleware.ts` — Dynamic CORS for end-user origins
- `apps/search-ai-runtime/src/middleware/end-user-rate-limit.middleware.ts` — Per-user + per-project rate limiting

### Files to Modify

- `apps/search-ai-runtime/src/routes/query.ts` — Add `endUserAuthMiddleware` before `authMiddleware`, add guard to skip authMiddleware if tenantContext set
- `apps/search-ai-runtime/src/server.ts` — Mount `/api/search/auth` router, add dynamic CORS middleware
- `apps/search-ai-runtime/src/db/index.ts` — Register `ProjectSettings`, `AuthProfile`, `Contact` models on platform DB
- `apps/search-ai-runtime/src/middleware/permission-filter.middleware.ts` — Handle `X-Search-Session-Token` path

### Function Signatures

```typescript
// apps/search-ai-runtime/src/middleware/end-user-auth.middleware.ts
import type { RequestHandler } from 'express';

/**
 * End-user auth middleware — runs BEFORE existing authMiddleware.
 * If request has no Authorization header + has X-Auth-Mode: user → handles auth.
 * Otherwise passes through (no-op).
 */
export function createEndUserAuthMiddleware(): RequestHandler;

// apps/search-ai-runtime/src/services/end-user/end-user-auth.service.ts
export interface EndUserAuthResult {
  sessionToken: string;
  expiresIn: number;
  user: {
    email: string;
    domain: string;
    contactId?: string;
  };
}

export class EndUserAuthService {
  /**
   * Validate IdP token and issue search session token (Path A: /auth/token)
   */
  async authenticateAndIssueToken(params: {
    idpToken: string;
    indexId: string;
  }): Promise<EndUserAuthResult>;

  /**
   * Validate session token or raw IdP token on /query (Paths C)
   */
  async resolveEndUserIdentity(params: {
    indexId: string;
    sessionToken?: string;
    idpToken?: string;
  }): Promise<{
    tenantId: string;
    projectId: string;
    userIdentity: UserIdentity;
    contactId?: string;
  }>;
}

// apps/search-ai-runtime/src/routes/auth.ts
// POST /api/search/auth/token
// Headers: X-End-User-Token: {idpJWT}, X-Index-Id: {indexId}
// Response: { success: true, token: string, expiresIn: number, user: {...} }

// apps/search-ai-runtime/src/middleware/end-user-cors.middleware.ts
export function createEndUserCorsMiddleware(): RequestHandler;

// apps/search-ai-runtime/src/middleware/end-user-rate-limit.middleware.ts
export function createEndUserRateLimitMiddleware(): RequestHandler;
```

### Subtasks (execution order)

1. **ST-4.1**: Register `ProjectSettings`, `AuthProfile`, `Contact` models in `db/index.ts`
2. **ST-4.2**: Create `end-user-auth.service.ts` with:
   - `authenticateAndIssueToken()`: indexId → SearchIndex lookup → ProjectSettings lookup → auth profile load → IdP validate → contact create/find → issue session token
   - `resolveEndUserIdentity()`: For /query path — validates session token OR raw IdP token
   - Uses `@agent-platform/shared-auth/idp` for validation
   - Uses `@agent-platform/shared-auth/idp` for session token issuance
3. **ST-4.3**: Create `end-user-auth.middleware.ts`:
   - Check: no `Authorization` header AND `X-Auth-Mode: user` header present
   - If both true → call `resolveEndUserIdentity()` → set `req.tenantContext`, `req.authMode`, `req.userIdentity`
   - If not → `next()` (pass through to existing authMiddleware)
4. **ST-4.4**: Create `end-user-cors.middleware.ts`:
   - For requests with `X-Auth-Mode: user` or to `/api/search/auth/*`
   - Look up indexId → ProjectSettings → `allowedOrigins`
   - Set CORS headers if Origin matches
   - Handle OPTIONS preflight
5. **ST-4.5**: Create `end-user-rate-limit.middleware.ts`:
   - After identity resolved, apply per-user and per-project limits
   - Redis-backed fixed-window (same pattern as existing `rate-limit.ts`)
   - Keys: `eu:{tenantId}:{email}` and `eu:{tenantId}:{projectId}`
6. **ST-4.6**: Create `routes/auth.ts`:
   - `POST /token` handler: reads `X-End-User-Token` and `X-Index-Id` headers
   - Calls `EndUserAuthService.authenticateAndIssueToken()`
   - Returns `{ success: true, token, expiresIn, user: { email, domain } }`
7. **ST-4.7**: Modify `routes/query.ts`:
   - Add `endUserAuthMiddleware` BEFORE `authMiddleware` in router chain
   - Guard `authMiddleware` — skip if `req.tenantContext` already set
8. **ST-4.8**: Modify `server.ts`:
   - Mount auth router: `app.use('/api/search/auth', endUserCors, authRouter)`
   - Add dynamic CORS middleware before rate limit

### Acceptance Criteria

- AC-4.1: `POST /api/search/auth/token` with valid IdP token returns session JWT
  - Verify: Integration test with mocked JWKS endpoint
  - Expected: 200 response with `{ success: true, token: "...", expiresIn: 900 }`
- AC-4.2: Query with `X-Search-Session-Token` (no API key) succeeds
  - Verify: Integration test
  - Expected: 200 with search results, RACL filter applied
- AC-4.3: Query with `X-End-User-Token` (no API key, Path C) succeeds
  - Verify: Integration test
  - Expected: 200 with search results
- AC-4.4: Existing API key auth (Path D) still works unchanged
  - Verify: Integration test with `Authorization: Bearer abl_*` + `X-Auth-Mode: user`
  - Expected: Same behavior as before
- AC-4.5: Request without any auth returns 401
  - Verify: Integration test
  - Expected: 401 with `{ success: false, error: { code: 'AUTH_REQUIRED' } }`
- AC-4.6: Disabled `publicApiAccess` returns 403
  - Verify: Integration test with toggle off
  - Expected: 403 with `{ success: false, error: { code: 'END_USER_ACCESS_DISABLED' } }`
- AC-4.7: Rate limiting kicks in after configured threshold
  - Verify: Integration test — send 61 requests in 1 minute window
  - Expected: 429 after limit exceeded

---

## Task T-5: Studio UI — Public API Access Settings

### Files to Create

- `apps/studio/src/components/settings/PublicApiAccessSettings.tsx` — UI component
- `apps/studio/src/app/api/projects/[id]/public-api-access/route.ts` — Studio proxy route

### Files to Modify

- `apps/studio/src/components/settings/ProjectSettingsPage.tsx` — Add PublicApiAccess section

### Function Signatures

```typescript
// apps/studio/src/components/settings/PublicApiAccessSettings.tsx
interface PublicApiAccessSettingsProps {
  projectId: string;
}

export function PublicApiAccessSettings(props: PublicApiAccessSettingsProps): JSX.Element;

// apps/studio/src/app/api/projects/[id]/public-api-access/route.ts
// GET — reads publicApiAccess from ProjectSettings
// PUT — updates publicApiAccess on ProjectSettings
```

### Subtasks (execution order)

1. **ST-5.1**: Create Studio proxy route `apps/studio/src/app/api/projects/[id]/public-api-access/route.ts`
   - GET: Proxy to runtime `GET /api/projects/:id/settings` → extract `publicApiAccess`
   - PUT: Proxy to runtime `PUT /api/projects/:id/settings` with `publicApiAccess` field
2. **ST-5.2**: Create `PublicApiAccessSettings.tsx` component:
   - Toggle for `search.query` scope (enabled/disabled)
   - Auth Profile dropdown (filtered to `oauth2_app` and `azure_ad` types)
   - Allowed Domains input (tag-style, comma-separated)
   - Allowed Origins input (tag-style)
   - Session TTL input (number, default 900)
   - Rate limits section (per-user, per-project)
3. **ST-5.3**: Add `PublicApiAccessSettings` section to `ProjectSettingsPage.tsx`

### Acceptance Criteria

- AC-5.1: Settings page shows Public API Access section
  - Verify: Navigate to Project Settings in Studio
  - Expected: New section visible with toggle, auth profile picker, domain/origin inputs
- AC-5.2: Saving settings persists to database
  - Verify: Toggle on → select auth profile → save → refresh
  - Expected: Values persisted and loaded correctly
- AC-5.3: Auth profile dropdown only shows OIDC-compatible profiles
  - Verify: Create profiles of different types → open dropdown
  - Expected: Only `oauth2_app` and `azure_ad` profiles shown

---

## Task T-6: E2E Tests

### Files to Create

- `apps/search-ai-runtime/src/__tests__/end-user-auth.integration.test.ts` — Integration tests for all paths

### Subtasks (execution order)

1. **ST-6.1**: Create integration test file with test cases for:
   - Path A: Token exchange (valid IdP token → session token)
   - Path C: Raw IdP token on /query (no API key)
   - Path D: API key + user mode (backward compat)
   - Error: disabled feature → 403
   - Error: invalid IdP token → 401
   - Error: wrong domain → 403
   - Error: expired session token → 401
   - Rate limiting: per-user limit exceeded → 429

### Acceptance Criteria

- AC-6.1: All integration tests pass
  - Verify: `pnpm test --filter=@agent-platform/search-ai-runtime`
  - Expected: All tests green
- AC-6.2: Tests use real Express server (no mocked middleware)
  - Verify: Code inspection — no `vi.mock` of platform components
  - Expected: Real middleware chain exercised
