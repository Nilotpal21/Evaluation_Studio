# LLD: Platform Keys — Phase 2 Scope Architecture

**Feature Spec**: `docs/features/sub-features/platform-keys.md`
**HLD**: `docs/specs/platform-keys.hld.md`
**Test Spec**: `docs/testing/sub-features/platform-keys.md`
**Phase 1 LLD**: `docs/plans/2026-04-11-platform-keys-impl-plan.md`
**Status**: DRAFT
**Date**: 2026-04-12

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                               | Rationale                                                                                                                                                                      | Alternatives Rejected                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| D-1 | Scope registry as `Record<string, ScopeEntry>` constant in `packages/shared-auth/src/scopes/platform-key-scopes.ts`    | Shared between Studio (ceiling check, Zod validation, UI scopes endpoint) and Runtime (scope expansion). Single source of truth. Avoids duplicated scope lists.                | DB-stored scopes (over-engineering for ~10 scopes), per-app constants (divergence risk)                              |
| D-2 | Implementation order: Registry → Studio routes → Runtime expansion → UI                                                | Data layer first (registry), then consumers. Studio routes need the registry for ceiling check before runtime can expand. UI last because it fetches scopes from API.          | UI-first (blocked on API), parallel (risky integration)                                                              |
| D-3 | Only dot-separated scopes accepted at creation time; legacy colon-separated handled by runtime expansion only          | More secure — prevents creating keys with arbitrary RBAC permission strings. Feature spec Section 7 backwards compat algorithm handles legacy at resolve time.                 | Accept both at creation (allows bypassing ceiling check with raw RBAC strings)                                       |
| D-4 | Ceiling check + expansion utilities in `packages/shared-auth/src/scopes/scope-validation.ts` (separate from registry)  | Clean separation: registry is data, validation is logic. Both consumed by different callers. Keeps registry file simple and importable without pulling in hasPermission deps.  | Combined file (grows too large), inline in route handlers (duplication)                                              |
| D-5 | Derive Zod enum from registry keys at import time: `z.enum(Object.keys(PLATFORM_KEY_SCOPES) as [string, ...string[]])` | Keeps shared-auth Zod-free. Studio routes already use Zod — deriving enum from registry keys ensures they stay in sync without shared-auth depending on Zod.                   | Export Zod schema from shared-auth (adds Zod dependency to shared-auth), hardcode new list (same problem as Phase 1) |
| D-6 | Strip `requiredPermissions` from `GET /api/keys/scopes` response                                                       | Internal implementation detail. External API consumers should not see RBAC permission mappings. Endpoint returns `{ scope, label, description, category }`.                    | Return full registry (leaks internal RBAC structure)                                                                 |
| D-7 | `user.role` from `requireAuth` is the tenant role for ceiling check — no new middleware needed                         | `requireAuth` already populates `user.role` from JWT claims or DB fallback. `getPermissionCeiling(user.role)` is a direct call.                                                | Custom middleware for role extraction (unnecessary), DB lookup per request (already done by requireAuth)             |
| D-8 | Expansion happens INSIDE each app's `resolveApiKey` before returning `ApiKeyRecord`                                    | Keeps the expansion at the boundary where scopes become permissions. Existing middleware reads `ApiKeyRecord.scopes` as permissions — expansion must happen before that point. | Middleware-level expansion (requires changes to unified auth core), post-resolve expansion (leaks across more files) |

### Key Interfaces & Types

```typescript
// packages/shared-auth/src/scopes/platform-key-scopes.ts

export interface ScopeEntry {
  /** Human-readable label for UI display */
  label: string;
  /** Description shown in tooltips and API docs */
  description: string;
  /** Grouping for UI category sections */
  category: 'execution' | 'management' | 'analytics' | 'admin';
  /** RBAC permissions this scope maps to (ceiling check + runtime expansion) */
  requiredPermissions: readonly string[];
}

export const PLATFORM_KEY_SCOPES: Record<string, ScopeEntry> = {
  'workflows.execute': {
    label: 'Execute Workflows',
    description: 'Execute workflows via Process API',
    category: 'execution',
    requiredPermissions: ['workflow:read', 'workflow:execute'],
  },
  'workflows.read': {
    label: 'Read Workflows',
    description: 'Read workflow definitions and status',
    category: 'execution',
    requiredPermissions: ['workflow:read'],
  },
  'chat.execute': {
    label: 'Execute Chat',
    description: 'Send messages to agents via Chat API',
    category: 'execution',
    requiredPermissions: ['agent:execute', 'session:send_message'],
  },
  'agents.read': {
    label: 'Read Agents',
    description: 'List and inspect agent configurations',
    category: 'management',
    requiredPermissions: ['agent:read'],
  },
  'agents.write': {
    label: 'Write Agents',
    description: 'Create and update agent configurations',
    category: 'management',
    requiredPermissions: ['agent:read', 'agent:create', 'agent:update'],
  },
  'deployments.read': {
    label: 'Read Deployments',
    description: 'List deployment status and history',
    category: 'management',
    requiredPermissions: ['deployment:read'],
  },
  'deployments.write': {
    label: 'Write Deployments',
    description: 'Create and promote deployments',
    category: 'management',
    requiredPermissions: ['deployment:read', 'deployment:create'],
  },
  'sessions.read': {
    label: 'Read Sessions',
    description: 'Read session history and transcripts',
    category: 'management',
    requiredPermissions: ['session:read'],
  },
  'analytics.read': {
    label: 'Read Analytics',
    description: 'Read analytics dashboards and metrics',
    category: 'analytics',
    requiredPermissions: ['analytics:read'],
  },
  'tenant.read': {
    label: 'Read Workspace',
    description: 'Read workspace settings and usage data',
    category: 'admin',
    requiredPermissions: ['tenant:read'],
  },
};

/** All valid scope keys as a typed array */
export const PLATFORM_KEY_SCOPE_KEYS = Object.keys(
  PLATFORM_KEY_SCOPES,
) as (keyof typeof PLATFORM_KEY_SCOPES)[];

/** Category type derived from registry */
export type ScopeCategory = ScopeEntry['category'];
```

```typescript
// packages/shared-auth/src/scopes/scope-validation.ts

import { PLATFORM_KEY_SCOPES, type ScopeEntry } from './platform-key-scopes.js';
import { getPermissionCeiling } from '../rbac/role-permissions.js';
import { hasPermission } from '../rbac/permission-resolver.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('platform-key-scopes');

/**
 * Check whether a user's tenant role ceiling covers all requested scopes.
 * Returns { allowed: true } or { allowed: false, denied: [...] }.
 *
 * Pure function — takes scopes + role, returns result. No DB calls.
 */
export function checkScopeCeiling(
  requestedScopes: string[],
  creatorTenantRole: string,
): { allowed: true } | { allowed: false; denied: string[] } {
  const ceiling = getPermissionCeiling(creatorTenantRole);
  const denied: string[] = [];

  for (const scope of requestedScopes) {
    const entry = PLATFORM_KEY_SCOPES[scope];
    if (!entry) {
      denied.push(scope);
      continue;
    }
    for (const perm of entry.requiredPermissions) {
      if (!hasPermission(ceiling, perm)) {
        denied.push(scope);
        break;
      }
    }
  }

  return denied.length === 0 ? { allowed: true } : { allowed: false, denied };
}

/**
 * Expand an array of scope strings to their corresponding RBAC permissions.
 * Handles three cases per feature spec Section 7 backwards compat algorithm:
 *
 * 1. Dot-separated registry key (e.g., 'workflows.execute') → expand via requiredPermissions
 * 2. Colon-separated string (e.g., 'workflow:execute') → pass through as-is (legacy)
 * 3. Unknown → skip with warning (fail-closed)
 *
 * Returns a deduplicated array of RBAC permission strings.
 */
export function expandScopesToPermissions(scopes: string[]): string[] {
  const permissions = new Set<string>();

  for (const scope of scopes) {
    const entry = PLATFORM_KEY_SCOPES[scope];
    if (entry) {
      // Case 1: dot-separated registry key
      for (const perm of entry.requiredPermissions) {
        permissions.add(perm);
      }
    } else if (scope.includes(':')) {
      // Case 2: colon-separated legacy RBAC permission
      permissions.add(scope);
    }
    // Case 3: unknown — skip with warning (fail-closed, no permissions granted)
    else {
      log.warn('Unknown scope skipped during expansion', { scope });
    }
  }

  return Array.from(permissions);
}

/**
 * Validate that all scopes are valid registry keys.
 * Used by Studio routes at creation/update time.
 */
export function validateRegistryScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter((s) => !(s in PLATFORM_KEY_SCOPES));
  return { valid: invalid.length === 0, invalid };
}
```

```typescript
// packages/shared-auth/src/scopes/index.ts

export {
  PLATFORM_KEY_SCOPES,
  PLATFORM_KEY_SCOPE_KEYS,
  type ScopeEntry,
  type ScopeCategory,
} from './platform-key-scopes.js';
export {
  checkScopeCeiling,
  expandScopesToPermissions,
  validateRegistryScopes,
} from './scope-validation.js';
```

### Module Boundaries

| Module                                           | Responsibility                               | Depends On                                                                 |
| ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| `shared-auth/scopes/platform-key-scopes`         | Scope registry (data only)                   | None                                                                       |
| `shared-auth/scopes/scope-validation`            | Ceiling check, expansion, validation (logic) | `platform-key-scopes`, `rbac/role-permissions`, `rbac/permission-resolver` |
| `studio/api/keys/route.ts`                       | POST handler with ceiling check              | `shared-auth/scopes`                                                       |
| `studio/api/keys/[keyId]/route.ts`               | PATCH handler with ceiling check             | `shared-auth/scopes`                                                       |
| `studio/api/keys/scopes/route.ts`                | GET scopes endpoint                          | `shared-auth/scopes`                                                       |
| `runtime/repos/auth-repo.ts`                     | Scope expansion in `resolveApiKey`           | `shared-auth/scopes`                                                       |
| `search-ai/middleware/auth.ts`                   | Scope expansion in `resolveApiKey`           | `shared-auth/scopes`                                                       |
| `search-ai-runtime/middleware/auth.ts`           | Scope expansion in `resolveApiKey`           | `shared-auth/scopes`                                                       |
| `workflow-engine/index.ts`                       | Scope expansion in `resolveApiKey`           | `shared-auth/scopes`                                                       |
| `studio/components/settings/PlatformKeysTab.tsx` | Dynamic scope rendering from API             | `GET /api/keys/scopes` (HTTP)                                              |

---

## 2. File-Level Change Map

### New Files

| File                                                     | Purpose                                                                    | LOC Estimate |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `packages/shared-auth/src/scopes/platform-key-scopes.ts` | Scope registry constant + types                                            | ~80          |
| `packages/shared-auth/src/scopes/scope-validation.ts`    | `checkScopeCeiling`, `expandScopesToPermissions`, `validateRegistryScopes` | ~70          |
| `packages/shared-auth/src/scopes/index.ts`               | Public barrel exports                                                      | ~5           |
| `apps/studio/src/app/api/keys/scopes/route.ts`           | `GET /api/keys/scopes` endpoint                                            | ~40          |

### Modified Files

| File                                                      | Change Description                                                                                     | Risk |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| `packages/shared-auth/src/index.ts`                       | Add `export * from './scopes/index.js'`                                                                | Low  |
| `apps/studio/src/app/api/keys/route.ts`                   | Replace hardcoded Zod enum with registry-derived enum; add ceiling check to POST handler               | Med  |
| `apps/studio/src/app/api/keys/[keyId]/route.ts`           | Replace hardcoded Zod enum with registry-derived enum; add ceiling check to PATCH handler              | Med  |
| `apps/studio/src/app/api/keys/platform-key-utils.ts`      | Replace `AVAILABLE_SCOPES` with re-export from registry; update `validateScopes`                       | Low  |
| `apps/runtime/src/repos/auth-repo.ts`                     | Add scope expansion in `resolveApiKey` before returning `ApiKeyRecord` (line ~241)                     | Med  |
| `apps/search-ai/src/middleware/auth.ts`                   | Add scope expansion in `resolveApiKey` return path (line ~163) + prefix/expiry parity fix              | Med  |
| `apps/search-ai-runtime/src/middleware/auth.ts`           | Add scope expansion in `resolveApiKey` return path + prefix/expiry parity fix                          | Med  |
| `apps/search-ai-runtime/package.json`                     | Add `@agent-platform/shared-auth` dependency                                                           | Low  |
| `apps/workflow-engine/package.json`                       | Add `@agent-platform/shared-auth` dependency                                                           | Low  |
| `apps/workflow-engine/src/index.ts`                       | Add scope expansion in `resolveApiKey` return path (line ~192)                                         | Med  |
| `apps/studio/src/components/settings/PlatformKeysTab.tsx` | Fetch scopes from `GET /api/keys/scopes`; render grouped by category; disable ceiling-exceeding scopes | Med  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Scope Registry in shared-auth

**Goal**: Create the scope registry and validation/expansion utilities as a new module in `packages/shared-auth`.

**Tasks**:

1.1. Create `packages/shared-auth/src/scopes/platform-key-scopes.ts` with the `PLATFORM_KEY_SCOPES` constant and types (`ScopeEntry`, `ScopeCategory`, `PLATFORM_KEY_SCOPE_KEYS`). Verify all 10 scopes match the feature spec Section 7 table — every `requiredPermissions` entry must exist in `role-permissions.ts`.

1.2. Create `packages/shared-auth/src/scopes/scope-validation.ts` with three pure functions:

- `checkScopeCeiling(requestedScopes, creatorTenantRole)` — uses `getPermissionCeiling` + `hasPermission` from existing RBAC module
- `expandScopesToPermissions(scopes)` — implements the three-case expansion algorithm from feature spec Section 7
- `validateRegistryScopes(scopes)` — validates all scopes are registry keys

  1.3. Create `packages/shared-auth/src/scopes/index.ts` barrel export.

  1.4. Add `export * from './scopes/index.js'` to `packages/shared-auth/src/index.ts`.

  1.5. Run `pnpm build --filter=@agent-platform/shared-auth` and `pnpm build --filter=@agent-platform/shared-auth -- --noEmit` to verify compilation.

  1.6. Create `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts` with pure function tests:

- UT-5: Registry completeness (10 scopes, 4 categories, all `requiredPermissions` valid)
- UT-6: Category grouping (exact scope membership per category)
- UT-7: `checkScopeCeiling` with 7 role/scope combinations from test spec (discriminated union return type). Note: `chat.execute`, `sessions.read`, and `analytics.read` are intentionally OWNER-only per GAP-012 (their RBAC permissions aren't in standard tenant roles). Tests should assert ADMIN+chat.execute→denied, ADMIN+sessions.read→denied, ADMIN+analytics.read→denied as expected behavior, not bugs.
- UT-8: `expandScopesToPermissions` with 6 input/output cases from test spec (dot, colon, unknown, mixed, empty)
- Pure function tests only — no I/O, no mocks, no DB.

**Files Touched**:

- `packages/shared-auth/src/scopes/platform-key-scopes.ts` — NEW
- `packages/shared-auth/src/scopes/scope-validation.ts` — NEW
- `packages/shared-auth/src/scopes/index.ts` — NEW
- `packages/shared-auth/src/index.ts` — add scopes export
- `packages/shared-auth/src/__tests__/platform-key-scopes.test.ts` — NEW (UT-5 through UT-8)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/shared-auth` succeeds with 0 errors
- [ ] `PLATFORM_KEY_SCOPES` has exactly 10 entries matching feature spec Section 7 table
- [ ] Every `requiredPermissions` string exists in `TENANT_ROLE_PERMISSIONS` values (verified by reading `role-permissions.ts`)
- [ ] `checkScopeCeiling`, `expandScopesToPermissions`, `validateRegistryScopes` are all exported from `@agent-platform/shared-auth`
- [ ] Unit tests pass for registry completeness (UT-5), category grouping (UT-6), ceiling check (UT-7), and scope expansion (UT-8) from test spec

**Test Strategy**:

- Unit: Test all 4 pure functions — `checkScopeCeiling` with 5 role combinations (VIEWER+agents.write→denied, OPERATOR+workflows.execute→allowed, MEMBER+workflows.execute→denied, ADMIN+analytics.read→denied, OWNER+all→allowed); `expandScopesToPermissions` with dot-separated, colon-separated, and unknown inputs; registry completeness (10 scopes, 4 categories)
- Integration: None for this phase (pure module, no I/O)

**Rollback**: Delete `packages/shared-auth/src/scopes/` directory, remove the export line from `index.ts`.

---

### Phase 2: Studio Route Updates + Ceiling Check

**Goal**: Update Studio API routes to use registry-driven validation and add the creation-time ceiling check to POST and PATCH handlers.

**Tasks**:

2.1. Update `apps/studio/src/app/api/keys/route.ts`:

- Import `PLATFORM_KEY_SCOPES`, `checkScopeCeiling` from `@agent-platform/shared-auth`
- Replace hardcoded `z.enum(['workflow:execute', 'workflow:read'])` in `CreateKeySchema` with `z.enum(Object.keys(PLATFORM_KEY_SCOPES) as [string, ...string[]])`
- Add `user.role` guard before ceiling check: if `!user.role`, return 403 matching the existing error pattern in these routes (bare `{ error: 'Tenant role required to create platform keys' }`). This matches the existing `!user.tenantId` guard pattern at line ~57.
- Add ceiling check after the role guard and before key creation: call `checkScopeCeiling(parsed.data.scopes, user.role)`. If not allowed, return 403 with `{ error: 'Scope ceiling exceeded', code: 'SCOPE_CEILING_EXCEEDED', denied: result.denied }`. The `denied` array contains **scope names** (e.g., `['agents.write']`), NOT RBAC permission strings. **Note**: The existing keys routes use bare `{ error: 'string' }` responses (not the `errorJson()` helper from `@/lib/api-response.ts`). The ceiling check follows the same per-route error pattern for consistency within the keys domain. The `denied` array is additional structured data for the UI error handler.

  2.2. Update `apps/studio/src/app/api/keys/[keyId]/route.ts`:

- Import `PLATFORM_KEY_SCOPES`, `checkScopeCeiling` from `@agent-platform/shared-auth`
- Replace hardcoded `z.enum(['workflow:execute', 'workflow:read'])` in `UpdateKeySchema` with `z.enum(Object.keys(PLATFORM_KEY_SCOPES) as [string, ...string[]])`
- Add `user.role` guard before ceiling check (same pattern as 2.1)
- Add ceiling check in PATCH handler when `parsed.data.scopes !== undefined`: same `checkScopeCeiling` call and 403 response (denied array contains scope names, not RBAC strings)

  2.3. Update `apps/studio/src/app/api/keys/platform-key-utils.ts`:

- Replace `AVAILABLE_SCOPES = ['workflow:execute', 'workflow:read'] as const` with import from `@agent-platform/shared-auth`: `import { PLATFORM_KEY_SCOPE_KEYS } from '@agent-platform/shared-auth'`
- Re-export as `AVAILABLE_SCOPES = PLATFORM_KEY_SCOPE_KEYS` for backwards compatibility (existing callers)
- Update `validateScopes` to use `validateRegistryScopes` from shared-auth

  2.4. Create `apps/studio/src/app/api/keys/scopes/route.ts`:

- `GET /api/keys/scopes` — returns scope registry entries stripped of `requiredPermissions`
- Auth: `requireAuth` only (any authenticated user)
- Use `withOpenAPI` wrapper with a Zod response schema (`ScopesResponseSchema`) to match the existing keys route pattern
- Response schema: `z.object({ scopes: z.array(z.object({ scope: z.string(), label: z.string(), description: z.string(), category: z.string() })) })`

  2.5. Update UI callers to use dot-separated scopes (must deploy atomically with Zod enum change):

- `apps/studio/src/components/settings/PlatformKeysTab.tsx` — change hardcoded default scopes from `['workflow:execute', 'workflow:read']` to `['workflows.execute', 'workflows.read']` at lines ~53 and ~96 where create/edit forms set default scope values. The full dynamic fetch from `GET /api/keys/scopes` is deferred to Phase 4 — this task only migrates the string values to pass the new Zod enum.
- `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` — change `scopes: ['workflow:execute']` to `scopes: ['workflows.execute']` at line ~125.

  2.6. Update existing test files to use dot-separated scopes:

- `apps/studio/src/__tests__/platform-keys-api.test.ts` — change all `scopes: ['workflow:execute']` / `scopes: ['workflow:read']` to `scopes: ['workflows.execute']` / `scopes: ['workflows.read']` throughout (~20 occurrences)
- `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts` — same scope string migration throughout

  2.7. Run `pnpm build --filter=studio` to verify compilation.

**Files Touched**:

- `apps/studio/src/app/api/keys/route.ts` — replace Zod enum, add ceiling check
- `apps/studio/src/app/api/keys/[keyId]/route.ts` — replace Zod enum, add ceiling check
- `apps/studio/src/app/api/keys/platform-key-utils.ts` — replace hardcoded scopes
- `apps/studio/src/app/api/keys/scopes/route.ts` — NEW
- `apps/studio/src/components/settings/PlatformKeysTab.tsx` — migrate hardcoded scope strings from colon- to dot-separated
- `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` — migrate scope string
- `apps/studio/src/__tests__/platform-keys-unit.test.ts` — update assertions: `AVAILABLE_SCOPES` changes from 2 colon-separated to 10 dot-separated registry-derived scopes
- `apps/studio/src/__tests__/platform-keys-api.test.ts` — migrate all scope strings to dot-separated
- `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts` — migrate all scope strings to dot-separated

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] POST /api/keys with `scopes: ['workflows.execute']` from an OPERATOR user → 201 (scope within ceiling)
- [ ] POST /api/keys with `scopes: ['agents.write']` from a VIEWER user → 403 with `SCOPE_CEILING_EXCEEDED` error
- [ ] PATCH /api/keys/:keyId with `scopes: ['agents.write']` from a VIEWER user → 403
- [ ] POST /api/keys with `scopes: ['nonexistent.scope']` → 400 (Zod validation failure)
- [ ] GET /api/keys/scopes returns 10 scopes grouped by 4 categories, without `requiredPermissions`
- [ ] Integration tests INT-11 through INT-14, INT-16 from test spec pass

**Test Strategy**:

- Integration: Ceiling check with 5 role combinations (INT-12, INT-13); PATCH ceiling (INT-14); registry validation endpoint (INT-16); Zod rejects invalid scopes (INT-11)
- E2E: VIEWER ceiling block (E2E-11), ADMIN ceiling (E2E-12), PATCH escalation (E2E-13), scopes endpoint (E2E-16)

**Rollback**: Revert route files to pre-change state (hardcoded Zod enum, no ceiling check). Delete `scopes/route.ts`.

---

### Phase 3: Runtime Scope Expansion (4 apps)

**Goal**: Update `resolveApiKey` in all four apps to expand scopes to RBAC permissions using the shared registry.

**Tasks**:

3.0. **Prerequisite: Add `@agent-platform/shared-auth` dependency** to `apps/search-ai-runtime/package.json` and `apps/workflow-engine/package.json`:

- Add `"@agent-platform/shared-auth": "workspace:*"` to `dependencies` in both files
- Run `pnpm install` to update lockfile
- Verify Dockerfiles: `apps/search-ai-runtime/Dockerfile` uses individual COPY lines and already has `COPY packages/shared-auth/package.json packages/shared-auth/package.json` (line 34) — no change needed. `apps/workflow-engine/Dockerfile` uses `COPY packages/ packages/` (bulk copy) — no change needed. No Dockerfile modifications required.

  3.1. Update `apps/runtime/src/repos/auth-repo.ts`:

- Import `expandScopesToPermissions` from `@agent-platform/shared-auth`
- In `resolveApiKey` (line ~241), replace `scopes: apiKey.scopes` with `scopes: expandScopesToPermissions(apiKey.scopes)`
- PublicApiKey path does NOT need expansion — PublicApiKey uses `permissions` not platform key scopes

  3.2. Update `apps/search-ai/src/middleware/auth.ts`:

- Import `expandScopesToPermissions` from `@agent-platform/shared-auth`
- In the `resolveApiKey` callback (line ~163), replace `scopes: apiKey.scopes || []` with `scopes: expandScopesToPermissions(apiKey.scopes || [])`
- **Parity fix**: Add `prefix` validation and `expiresAt` check to match runtime `resolveApiKey` behavior. Currently search-ai only checks `keyHash` + `revokedAt`, missing prefix match and expiry. Add: `if (apiKey.prefix !== rawKey.substring(0, 8)) return null;` and `if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;` before the return statement.

  3.3. Update `apps/search-ai-runtime/src/middleware/auth.ts`:

- Import `expandScopesToPermissions` from `@agent-platform/shared-auth`. **Note**: This file currently imports auth utilities from `@agent-platform/shared` (not shared-auth). Adding a second import source is acceptable — the existing `@agent-platform/shared` import is for `createUnifiedAuthMiddleware` which is re-exported from shared. The scopes module is shared-auth only. Do NOT re-export scopes from `@agent-platform/shared` to avoid enlarging that package's surface.
- In the `resolveApiKey` callback, replace `scopes` with `expandScopesToPermissions(...)` on the returned scopes
- **Parity fix**: Same as 3.2 — add prefix validation and expiresAt check. Also remove `(doc as any)` casts by typing the lean() result properly. Add `log.error` in the catch block (currently swallows errors silently) to match the search-ai pattern which has `logger.error`.

  3.4. Update `apps/workflow-engine/src/index.ts`:

- Import `expandScopesToPermissions` from `@agent-platform/shared-auth`. Same import source note as 3.3 — mixed import sources are acceptable here.
- In the `resolveApiKey` callback (line ~192), replace `scopes: apiKey.scopes` with `scopes: expandScopesToPermissions(apiKey.scopes)`

  3.5. Run `pnpm build` for all four affected packages to verify compilation:

- `pnpm build --filter=runtime --filter=@agent-platform/search-ai --filter=@agent-platform/search-ai-runtime --filter=@agent-platform/workflow-engine`

**Files Touched**:

- `apps/search-ai-runtime/package.json` — add shared-auth dependency
- `apps/workflow-engine/package.json` — add shared-auth dependency
- `apps/runtime/src/repos/auth-repo.ts` — add expansion call
- `apps/search-ai/src/middleware/auth.ts` — add expansion call + prefix/expiry parity fix
- `apps/search-ai-runtime/src/middleware/auth.ts` — add expansion call + prefix/expiry parity fix
- `apps/workflow-engine/src/index.ts` — add expansion call
- No Dockerfile changes required (verified: search-ai-runtime already has shared-auth COPY, workflow-engine uses bulk COPY)

**Exit Criteria**:

- [ ] `pnpm build` succeeds for all four apps with 0 errors
- [ ] A key with `scopes: ['workflows.execute']` resolves to `permissions: ['workflow:read', 'workflow:execute']` in runtime
- [ ] A legacy key with `scopes: ['workflow:execute']` still resolves to `permissions: ['workflow:execute']` (colon passthrough)
- [ ] A key with unknown scope `foo.bar` gets 0 permissions from that scope (fail-closed)
- [ ] Integration test INT-15 (resolveApiKey expansion with correct signature) passes
- [ ] E2E test E2E-14 (runtime HTTP scope enforcement) passes
- [ ] E2E test E2E-15 (backwards compat — legacy key still works via runtime HTTP) passes

**Test Strategy**:

- Integration: `resolveApiKey` expansion with dot-separated, colon-separated, and unknown scopes (INT-15)
- E2E: Create key via Studio API with new scope → hit runtime endpoint → verify access (E2E-14); Seed legacy key directly in MongoDB (colon-separated) → verify runtime still works (E2E-15)

**Rollback**: Revert the four files — remove `expandScopesToPermissions` import and restore `scopes: apiKey.scopes` in each return statement.

---

### Phase 4: UI Updates

**Goal**: Update `PlatformKeysTab` to dynamically fetch and render scopes from the registry, grouped by category, with ceiling-based disabling.

**Tasks**:

4.1. Update `apps/studio/src/components/settings/PlatformKeysTab.tsx`:

- Remove hardcoded `AVAILABLE_SCOPES` constant (line 26)
- Add SWR hook for scopes: `useSWR('/api/keys/scopes', fetcher, { revalidateOnFocus: false })` — scope registry is static (changes only on deploy), so no need for frequent revalidation. Define `ScopeInfo = { scope: string; label: string; description: string; category: string }`.
- Group scopes by `category` for the create/edit dialogs
- Render category headers (Execution, Management, Analytics, Admin) with scope checkboxes under each
- Replace scope badge rendering to use `label` from fetched scopes (fallback to raw scope string if not found — handles legacy keys with colon-separated scopes)
- **i18n note**: Scope labels and category headers come from the API response in English. i18n for these strings is deferred — the registry is the canonical source. When i18n is needed, add translation keys to the `settings` namespace and map from `scope.category` / `scope.scope` to translated strings in the component.

  4.2. Ceiling-based disabling: Since the scopes endpoint doesn't include ceiling info (it's role-dependent), the UI can either:

- **Option A (simpler)**: Show all scopes enabled; rely on 403 from POST/PATCH for ceiling enforcement. Show toast with denied scopes on error.
- **Option B (better UX)**: Add optional `userRole` param to scopes endpoint that returns `{ ...scope, available: boolean }`. Disable uncovered scopes with tooltip.
- **Decision**: Option A for this phase — ceiling is enforced server-side. The 403 response includes `denied` scopes list for clear error messaging. Option B can be added as a follow-up UX enhancement.

  4.3. Run `pnpm build --filter=studio` to verify compilation.

**Files Touched**:

- `apps/studio/src/components/settings/PlatformKeysTab.tsx` — dynamic scopes, category grouping

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] Create dialog shows scopes grouped under 4 category headers
- [ ] Selecting `workflows.execute` scope creates a key with dot-separated scope
- [ ] Editing a key shows current scopes checked (including legacy colon-separated if present)
- [ ] 403 ceiling error shows toast with denied scopes list
- [ ] Manual verification: FR-23 partially satisfied — scopes rendered from registry and grouped by category. Client-side ceiling disabling with tooltip (feature spec task 9.2) is deferred per decision in task 4.2 (Option A: server-side 403 enforcement). Ceiling disabling can be a follow-up UX enhancement.

**Test Strategy**:

- Manual: Visual verification of category grouping, scope selection, error messaging
- E2E: Covered by E2E-11/E2E-12/E2E-13 (ceiling enforcement is API-level)

**Rollback**: Revert `PlatformKeysTab.tsx` to hardcoded `AVAILABLE_SCOPES`.

---

## 4. Wiring Checklist

- [x] New service registered in DI container / module exports — N/A (pure functions, no DI)
- [ ] New `scopes/` module exported from `packages/shared-auth/src/index.ts` via barrel
- [ ] New `scopes/route.ts` auto-discovered by Next.js file-system routing (no manual registration)
- [ ] `PLATFORM_KEY_SCOPES` importable from `@agent-platform/shared-auth` in all consumer packages
- [ ] `expandScopesToPermissions` called in all 4 `resolveApiKey` implementations (runtime, search-ai, search-ai-runtime, workflow-engine)
- [ ] `checkScopeCeiling` called in both POST `/api/keys` and PATCH `/api/keys/:keyId`
- [ ] `PlatformKeysTab.tsx` fetches from `GET /api/keys/scopes` — no direct import of shared-auth
- [ ] `platform-key-utils.ts` updated to use registry — no stale hardcoded scopes remain
- [ ] Zod schemas in `route.ts` and `[keyId]/route.ts` derive enum from registry keys
- [ ] New types exported from package index — `ScopeEntry`, `ScopeCategory`, `PLATFORM_KEY_SCOPE_KEYS`

---

## 5. Cross-Phase Concerns

### Database Migrations

None. The `api_keys` collection schema is unchanged. New keys store dot-separated scopes; existing keys retain colon-separated scopes. The `expandScopesToPermissions` function handles both formats at resolve time.

### Feature Flags

None. The scope registry is additive — existing keys continue to work. New scopes are available immediately but only when explicitly selected at key creation time.

### Configuration Changes

None. No new environment variables or config keys. The scope registry is a code constant, not a runtime configuration.

### Backwards Compatibility

Existing keys with colon-separated scopes (`workflow:execute`, `workflow:read`) continue to work:

1. **At creation time**: New keys must use dot-separated scopes from the registry. The Zod enum rejects colon-separated strings. This is intentional — forces migration to the new scope system.
2. **At resolve time**: `expandScopesToPermissions` handles both:
   - Dot-separated → expand via registry
   - Colon-separated → pass through as-is
   - Unknown → skip (fail-closed)
3. **In the UI**: `PlatformKeysTab` shows scope badges. Legacy keys display their raw scope strings. The edit dialog shows all registry scopes and checks any that match the key's current scopes.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] Scope registry has 10 entries across 4 categories matching feature spec Section 7
- [ ] Ceiling check prevents VIEWER from creating keys with `agents.write` scope (FR-19)
- [ ] Ceiling check prevents scope escalation via PATCH (FR-20)
- [ ] Runtime `resolveApiKey` expands `workflows.execute` to `['workflow:read', 'workflow:execute']` (FR-22, FR-24)
- [ ] Legacy keys with `workflow:execute` continue to resolve correctly (backwards compat)
- [ ] `GET /api/keys/scopes` returns all scopes without `requiredPermissions` (FR-25)
- [ ] Studio create/edit dialogs render scopes grouped by category (FR-23)
- [ ] E2E tests E2E-11 through E2E-16 from test spec pass
- [ ] Integration tests INT-11 through INT-16 from test spec pass
- [ ] Unit tests UT-5 through UT-8 from test spec pass
- [ ] No regressions in existing Phase 1 tests (E2E-1 through E2E-10, INT-1 through INT-10)
- [ ] `pnpm build && pnpm test` pass with 0 errors

---

## 7. Open Questions

1. **GAP-012 (tenant-only ceiling)**: `chat.execute`, `sessions.read`, and `analytics.read` are currently OWNER-only because their RBAC permissions don't appear in any standard tenant role. Should we add these permissions to ADMIN/OPERATOR roles, or accept OWNER-gating for Phase 2? (Feature spec GAP-012 tracks this.)

2. **Scopes endpoint caching**: Should `GET /api/keys/scopes` be cached client-side (scope registry changes only on deploy)? Decision: defer — SWR in the UI provides sufficient caching for now.

3. **Audit logging**: Should ceiling check denials emit audit events? Decision: the route already logs via `createLogger` — structured audit events can be added as a follow-up when the audit pipeline supports it.
