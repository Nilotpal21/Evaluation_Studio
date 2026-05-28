# HLD: Platform Keys Management UI

**Feature Spec**: `docs/features/sub-features/platform-keys.md`
**Test Spec**: `docs/testing/sub-features/platform-keys.md`
**Status**: DONE
**Author**: Platform team
**Date**: 2026-04-11

---

## 1. Problem Statement

The ABL platform uses two distinct API key systems: `PublicApiKey` (`pk_` prefix, `public_api_keys` collection) for browser SDK authentication, and `ApiKey` (`abl_` prefix, `api_keys` collection) for server-to-server API access. The `ApiKey` model already exists in `packages/database`, and the runtime's `resolveApiKey()` already resolves `abl_` keys for authentication. However, there is no Studio UI to create, list, edit, or revoke `ApiKey` documents.

The workflow triggers feature (first consumer) needs users to create and manage `abl_` scoped keys. Without a UI, users cannot view which platform keys exist, their scopes, or revoke compromised keys. The existing Settings > API Keys page only manages SDK keys (`pk_`).

This HLD designs a tabbed API Keys settings page with a new "Platform Keys" tab and Studio API routes for `ApiKey` CRUD operations. The runtime and database model require zero changes.

---

## 2. Alternatives Considered

### Option A: Extend Existing ApiKeysTab with Inline Sections

- **Description**: Add a "Platform Keys" section below the existing SDK keys list in the same `ApiKeysTab` component. No tabs — both key types are visible on the same scrollable page with section headers.
- **Pros**: Simplest implementation. No tab state management. Users see all keys at once.
- **Cons**: Mixes two fundamentally different key types (browser SDK vs server-to-server) in one list. Different CRUD endpoints, different response shapes, different scope models. Confusing UX as key count grows. No clear visual separation of concerns.
- **Effort**: S (Small)

### Option B: Tabbed UI within ApiKeysTab (Recommended)

- **Description**: Add `<Tabs>` component inside `ApiKeysTab` with "SDK Keys" and "Platform Keys" tabs. SDK Keys tab renders the existing SDK key UI unchanged. Platform Keys tab renders a new `PlatformKeysTab` component with its own list, create, edit, and revoke flows. New `/api/keys` Studio API routes handle `ApiKey` CRUD.
- **Pros**: Clean separation of two key types while keeping them in the same settings area. Reuses existing `<Tabs>` component (WAI-ARIA compliant, animated). Matches the mental model: both are "API Keys" but serve different purposes. Existing SDK key behavior is preserved exactly (FR-02). Each tab can evolve independently.
- **Cons**: Slightly more code than Option A (tab state, separate component). Users must switch tabs to see different key types.
- **Effort**: S (Small)

### Option C: Separate Settings Page for Platform Keys

- **Description**: Add a new "Platform Keys" entry in the settings sidebar navigation alongside "API Keys". Each gets its own `ProjectSettingsPage` navigation item and component.
- **Pros**: Maximum separation. Can have its own URL/route for deep linking.
- **Cons**: Over-engineered — both are API key management and belong together. Requires changes to `ProjectSettingsPage` sidebar navigation and `useNavigationStore`. Fragments the key management experience. Users must navigate between two different settings pages to understand their full key portfolio.
- **Effort**: M (Medium)

### Recommendation: Option B (Tabbed UI within ApiKeysTab)

**Rationale**: Option B provides clean visual separation without fragmenting the UX. The existing `<Tabs>` component is production-proven with accessibility support. The SDK Keys tab is a zero-change wrapper around existing code, eliminating regression risk. The two key types are conceptually related (both are "API Keys") but operationally distinct (different collections, different scopes, different audiences), making tabs the natural UI pattern. Option A conflates them; Option C over-separates them.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                   Browser (Studio User)                    │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │   Settings > API Keys                                │  │
│  │   ┌──────────────┬───────────────────┐              │  │
│  │   │  SDK Keys    │  Platform Keys ◄──┤ <Tabs>       │  │
│  │   └──────────────┴───────────────────┘              │  │
│  │                                                      │  │
│  │   ┌──────────────────────────────────────────────┐  │  │
│  │   │  PlatformKeysTab                              │  │  │
│  │   │  ┌─────────────────────────────────────────┐  │  │  │
│  │   │  │ Key List (name, prefix, scopes, expiry) │  │  │  │
│  │   │  │ [+ Create Key] [Edit] [Revoke]          │  │  │  │
│  │   │  └─────────────────────────────────────────┘  │  │  │
│  │   │  ┌──────────────┐  ┌──────────────────────┐  │  │  │
│  │   │  │ Create Dialog │  │ One-Time Key Reveal  │  │  │  │
│  │   │  └──────────────┘  └──────────────────────┘  │  │  │
│  │   └──────────────────────────────────────────────┘  │  │
│  │                    apiFetch                          │  │
│  └────────────────────┬───────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────┘
                        │ GET/POST/PATCH/DELETE /api/keys
                        ▼
┌──────────────────────────────────────────────────────────┐
│              Studio (Next.js, port 5173)                   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  /api/keys/route.ts          GET + POST             │  │
│  │  /api/keys/[keyId]/route.ts  PATCH + DELETE         │  │
│  │                                                      │  │
│  │  1. requireAuth(req)                                 │  │
│  │  2. requireSdkProjectAccess(projectId, user, level) │  │
│  │  3. Zod schema validation (withOpenAPI)              │  │
│  │  4. ApiKey model CRUD via Mongoose                   │  │
│  └────────────────────────┬────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────┘
                            │ Mongoose
                            ▼
┌──────────────────────────────────────────────────────────┐
│                    MongoDB                                  │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  api_keys collection (existing)                      │  │
│  │  Indexes: keyHash(unique), tenantId+clientId(unique) │  │
│  │  Plugins: tenantIsolationPlugin, auditTrailPlugin    │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘

                      ╔═════════════════╗
                      ║  Runtime (3112)  ║
                      ║  resolveApiKey() ║──── no changes
                      ╚═════════════════╝
```

### Component Diagram

```
ApiKeysTab.tsx (modified)
├── <Tabs tabs={['sdk-keys', 'platform-keys']} />
├── [sdk-keys]  → Existing SDK key list/create/delete UI (extracted inline)
└── [platform-keys] → PlatformKeysTab.tsx (NEW)
                       ├── PlatformKeyList (key rows with scope badges)
                       ├── CreatePlatformKeyDialog
                       │   ├── Name input
                       │   ├── Scopes multi-select (AVAILABLE_SCOPES)
                       │   ├── Projects multi-select (pre-selected current)
                       │   └── Expiration picker (none/30d/90d/custom)
                       ├── EditPlatformKeyDialog
                       │   ├── Name input (pre-filled)
                       │   └── Scopes multi-select (pre-filled)
                       ├── KeyRevealModal (one-time raw key display)
                       └── ConfirmRevokeDialog (warning about triggers)

WebhookKeyCreationModal.tsx (modified)
└── Switches from /api/sdk/keys to /api/keys
    ├── POST body: { name, scopes: ["workflow:execute"], projectIds: [projectId] }
    └── Response mapping: prefix (not keyPrefix), scopes (not permissions)
```

### Data Flow

**Create Platform Key:**

1. User fills create dialog → clicks "Create Key"
2. `PlatformKeysTab` calls `apiFetch('POST', '/api/keys', { name, scopes, projectIds, expiresAt })`
3. Next.js route handler: `requireAuth(req)` → `requireSdkProjectAccess(projectId, user, 'write')`
4. Zod validates request body against `CreateKeySchema`
5. Generate: `rawKey = abl_${randomBytes(24).hex()}`, `prefix = rawKey.substring(0, 8)` (8 chars for runtime exact-match compatibility), `keyHash = sha256(rawKey)`, `clientId = plt-${uuidv7()}`
6. `ApiKey.create({ tenantId, name, clientId, keyHash, prefix, scopes, projectIds, expiresAt, createdBy: user.id })`
7. Return `{ id, key: rawKey, prefix, name, scopes, projectIds, clientId, expiresAt, createdAt }` with status 201
8. UI shows `KeyRevealModal` with raw key and copy-to-clipboard
9. On modal close, re-fetch key list via GET

**List Platform Keys:**

1. `PlatformKeysTab` mounts → calls `apiFetch('GET', '/api/keys?projectId=${projectId}')`
2. Route handler: `requireAuth` → `requireSdkProjectAccess(projectId, user, 'read')`
3. Query: `ApiKey.find({ projectIds: { $in: [projectId] }, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).limit(100).sort({ createdAt: -1 })`
4. `tenantIsolationPlugin` auto-adds `tenantId` filter
5. Return array of key summaries (no `keyHash`, no raw key)

**Revoke Platform Key:**

1. User clicks "Revoke" → `ConfirmRevokeDialog` shows warning about workflow triggers
2. On confirm: `apiFetch('DELETE', '/api/keys/${keyId}?projectId=${projectId}')`
3. Route handler: `requireAuth` → `requireSdkProjectAccess` → verify key exists and belongs to project
4. `ApiKey.updateOne({ _id: keyId, projectIds: { $in: [projectId] }, revokedAt: null }, { $set: { revokedAt: new Date() } })` — the `revokedAt: null` guard ensures idempotency: already-revoked keys are not matched, returning 404 on second revoke attempt
5. If `modifiedCount === 0`: check if key exists but is already revoked → return 404. Return `{ success: true }` on successful revoke.
6. Re-fetch list

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | `tenantIsolationPlugin` on the `ApiKey` model auto-injects `tenantId` into every query. Cross-tenant requests return empty results (effectively 404). No manual `tenantId` filtering needed in route handlers — the plugin handles it transparently. Verified in test spec INT-9.                                                                                                                        |
| 2   | **Data Access Pattern** | Direct Mongoose model access from Next.js route handlers, matching the established pattern in `/api/sdk/keys/route.ts`. No repository layer — the model is simple enough (CRUD only) that an abstraction would be premature. `tenantIsolationPlugin` and `auditTrailPlugin` provide cross-cutting concerns at the model layer.                                                                           |
| 3   | **API Contract**        | Four endpoints at `/api/keys` (GET, POST) and `/api/keys/:keyId` (PATCH, DELETE). Request/response validated by Zod schemas via `withOpenAPI`. Error responses follow `{ success: false, error: { code: string, message: string } }` envelope. Raw key returned only in POST response. List responses never include `keyHash` or raw key.                                                                |
| 4   | **Security Surface**    | **Auth**: `requireAuth` (JWT verification) + `requireSdkProjectAccess` (project membership + permission level). **Input validation**: Zod schemas reject malformed data before handler logic. **Key storage**: Only SHA-256 hash stored; raw key returned once then discarded. **SSRF**: No external URLs in request body. **Scope validation**: Only predefined scopes accepted (no arbitrary strings). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **400**: Invalid request body (Zod validation), attempt to edit `projectIds`. **401**: Missing or invalid JWT. **404**: Key not found, belongs to different tenant/project, or user lacks project membership (per platform invariant: cross-scope = 404 to avoid leaking existence; `requireSdkProjectAccess` returns 404 for access failures). **409**: Duplicate `clientId` (extremely unlikely with UUIDv7). **500**: Unexpected errors logged via `createLogger`.             |
| 6   | **Failure Modes** | **MongoDB down**: Route returns 500; UI shows error toast. No retry logic needed (user can retry manually). **Duplicate clientId**: Caught by unique index, return 409 (vanishingly rare with UUIDv7). **Concurrent revoke**: Idempotent — setting `revokedAt` on an already-revoked key is a no-op. No external service dependencies to fail.                                                                                                                                    |
| 7   | **Idempotency**   | **GET/LIST**: Naturally idempotent (read-only). **POST/CREATE**: Not idempotent (each call generates a new key). Acceptable — creating duplicate keys is harmless and can be cleaned up. **PATCH/EDIT**: Idempotent (same name/scopes produce same result). **DELETE/REVOKE**: Guarded by `revokedAt: null` in query filter — first call revokes, subsequent calls return 404 (key already revoked). This preserves the original `revokedAt` timestamp for audit trail integrity. |
| 8   | **Observability** | `createLogger('platform-keys')` for structured logging in route handlers. Key lifecycle events logged: create (with clientId, scopes, no raw key), edit (fields changed), revoke (keyId). No `TraceEvent` emission — key management is a settings operation, not an execution path. Audit trail via `auditTrailPlugin` on the model.                                                                                                                                              |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | **List**: Single MongoDB query with limit(100), indexed on `tenantId`. Expected <50ms for typical workloads (tens of keys per project). **Create**: One `randomBytes` + one SHA-256 hash + one `insertOne` = <20ms. **No pagination**: 100-item cap is sufficient for expected cardinality (tens per project).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | **Migration Path**     | No schema migration needed. The `api_keys` collection and all indexes already exist. Existing `ApiKey` documents (e.g., auto-created by workflow triggers with `wf-trigger-` clientId) will appear in the Platform Keys list alongside UI-created keys (`plt-` clientId). This is by design — all `abl_` keys for the project are visible. **WebhookKeyCreationModal transition**: After FR-15 ships, new trigger keys are `ApiKey` (`abl_`). Existing triggers that reference `PublicApiKey` documents (`pk_`) continue to work — `resolveApiKey()` falls back to the `PublicApiKey` collection (auth-repo.ts:122-128). The triggers panel does NOT need to handle both key types simultaneously because `TriggerRegistration.config.apiKeyId` is an opaque reference resolved at runtime. No one-time migration of existing `pk_` trigger keys is required; they remain functional until manually revoked. |
| 11  | **Rollback Plan**      | Purely additive feature: (1) New files: `api/keys/route.ts`, `api/keys/[keyId]/route.ts`, `PlatformKeysTab.tsx` — delete to rollback. (2) Modified files: `ApiKeysTab.tsx` (tabs wrapper), `WebhookKeyCreationModal.tsx` (endpoint switch) — git revert. (3) Data: Any `ApiKey` documents created remain valid for runtime auth. No data cleanup needed. (4) `/api/sdk/keys` is untouched throughout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 12  | **Test Strategy**      | **E2E (10 scenarios)**: Real HTTP against `startStudioApiHarness()` with MongoMemoryServer. Full middleware chain (auth, validation, tenant isolation). Tests: CRUD lifecycle, scope validation, expiration, multi-project, cross-tenant isolation, 100-item cap. **Integration (10 scenarios)**: MongoDB-level verification of key storage, hash matching, index enforcement, plugin behavior. **Unit (4 scenarios)**: Pure function tests for key generation, scope validation, expiry calculation, clientId format. Zero mocks of codebase components.                                                                                                                                                                                                                                                                                                                                                    |

---

## 5. Data Model

### New Collections/Tables

None. This feature creates no new collections or schemas.

### Modified Collections/Tables

None. The existing `api_keys` collection schema is unchanged.

### Existing Collection Used

```
Collection: api_keys
Managed by: packages/database/src/models/api-key.model.ts

Fields:
  _id:          string    (UUIDv7, default)
  tenantId:     string    (required, auto-injected by tenantIsolationPlugin)
  name:         string    (required, user-provided display name)
  clientId:     string    (required, "plt-<uuidv7>" for UI-created keys)
  keyHash:      string    (SHA-256 hex of raw key, unique)
  prefix:       string    (first 8 chars: "abl_" + 4 hex chars, e.g., "abl_a1b2" — must match runtime's `rawKey.substring(0, 8)` exact comparison in `resolveApiKey`)
  scopes:       string[]  (e.g., ["workflow:execute", "workflow:read"])
  projectIds:   string[]  (projects this key can access)
  environments: string[]  (default: [], not exposed in UI v1)
  expiresAt:    Date|null (null = no expiration)
  lastUsedAt:   Date|null (updated by runtime on key use)
  createdBy:    string    (required, authenticated user's ID)
  revokedAt:    Date|null (null = active, Date = revoked)
  _v:           number    (default: 1)
  createdAt:    Date      (auto, timestamps plugin)
  updatedAt:    Date      (auto, timestamps plugin)

Plugins:
  - tenantIsolationPlugin (auto-scopes all queries to tenantId)
  - auditTrailPlugin (tracks create/update/delete events)

Indexes:
  - { keyHash: 1 }              unique
  - { tenantId: 1, clientId: 1 } unique
  - { tenantId: 1 }
  - { prefix: 1 }
```

### Recommended Additional Index (GAP-006)

```
{ tenantId: 1, projectIds: 1, revokedAt: 1 }
```

This compound index optimizes the list query: `find({ projectIds: { $in: [projectId] }, revokedAt: null })` with `tenantId` auto-injected by the plugin. At current cardinality (tens of keys per project), the existing `{ tenantId: 1 }` index is sufficient, but this compound index prevents a collection scan as key counts grow.

**Decision**: Defer to implementation phase. Add the index in the model file alongside existing indexes if the implementation team agrees.

### Key Relationships

```
ApiKey.projectIds[]  ──→  Project._id (many-to-many)
ApiKey.createdBy     ──→  User._id (creator)
ApiKey.tenantId      ──→  Tenant._id (auto by plugin)
TriggerRegistration.config.apiKeyId ──→ ApiKey._id (from workflow-triggers spec)
```

---

## 6. API Design

### New Endpoints

| Method | Path                             | Purpose                       | Auth                                   |
| ------ | -------------------------------- | ----------------------------- | -------------------------------------- |
| GET    | `/api/keys?projectId=:projectId` | List active platform keys     | JWT + `requireSdkProjectAccess(read)`  |
| POST   | `/api/keys`                      | Create platform key           | JWT + `requireSdkProjectAccess(write)` |
| PATCH  | `/api/keys/:keyId`               | Update key name and/or scopes | JWT + `requireSdkProjectAccess(write)` |
| DELETE | `/api/keys/:keyId`               | Soft-revoke key               | JWT + `requireSdkProjectAccess(write)` |

### Request/Response Schemas

**POST /api/keys — Create**

```typescript
// Request
const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['workflow:execute', 'workflow:read'])).min(1),
  projectIds: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

// Response (201)
{
  id: string,
  key: string,          // raw key (abl_...), ONE-TIME ONLY
  prefix: string,       // first 8 chars (runtime compatibility)
  name: string,
  clientId: string,     // plt-<uuidv7>
  scopes: string[],
  projectIds: string[],
  expiresAt: string | null,
  createdAt: string,
}
```

**GET /api/keys?projectId=... — List**

```typescript
// Response (200)
{
  keys: Array<{
    id: string;
    prefix: string;
    name: string;
    clientId: string;
    scopes: string[];
    projectIds: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }>;
}
```

**PATCH /api/keys/:keyId — Edit**

```typescript
// Request
const UpdateKeySchema = z.object({
  projectId: z.string().min(1),  // for access check
  name: z.string().min(1).max(100).optional(),
  scopes: z.array(z.enum(['workflow:execute', 'workflow:read'])).min(1).optional(),
});

// Response (200)
{
  id: string,
  name: string,
  scopes: string[],
  updatedAt: string,
}
```

**DELETE /api/keys/:keyId — Revoke**

```typescript
// Request query: ?projectId=...
// Response (200)
{
  success: true,
}
```

### projectId Delivery Convention

- **GET** and **DELETE**: `projectId` in query parameter (`?projectId=...`) — follows REST convention for filtering/scoping read and delete operations.
- **POST**: `projectIds[]` in request body — the key can span multiple projects, so it's part of the resource creation payload.
- **PATCH**: `projectId` in request body — needed for the `requireSdkProjectAccess` check but not part of the mutable fields. This is a single project ID for the access check, not the key's `projectIds` array (which is immutable).

### Modified Endpoints

None. The existing `/api/sdk/keys` route is untouched.

### Error Responses

| Status | Code                    | When                                                                                                                              |
| ------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`       | Zod validation failure, attempt to edit `projectIds`                                                                              |
| 400    | `INVALID_SCOPES`        | Scopes not in predefined list                                                                                                     |
| 401    | `UNAUTHORIZED`          | Missing or invalid JWT, missing user ID                                                                                           |
| 404    | `KEY_NOT_FOUND`         | Key doesn't exist, wrong project, wrong tenant, or user lacks project access (per platform invariant: cross-scope = 404, not 403) |
| 409    | `DUPLICATE_CLIENT_ID`   | ClientId collision (vanishingly rare)                                                                                             |
| 500    | `INTERNAL_SERVER_ERROR` | Unexpected error                                                                                                                  |

Note: `requireSdkProjectAccess` returns 404 (not 403) for missing membership or project not found, consistent with the platform invariant that cross-scope access never leaks resource existence. The only exception is missing `tenantId` context (returns 403), which indicates a session-level issue rather than resource-level access.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: `auditTrailPlugin` on the `ApiKey` model records all create/update operations automatically. Revoke is an update (`$set: { revokedAt }`), so it's also captured. Additionally, `createLogger('platform-keys')` emits structured logs for each route handler invocation.
- **Rate Limiting**: Inherits tenant-level rate limiting from the Studio API layer. No feature-specific rate limits — key management is a low-frequency settings operation.
- **Caching**: No caching. Key list is always fetched fresh from MongoDB. At expected cardinality (tens of keys), caching adds complexity without meaningful benefit.
- **Encryption**: Keys are hashed (SHA-256) before storage — raw keys are never persisted. The `api_keys` collection is encrypted at rest via MongoDB's storage engine encryption (platform-wide). TLS in transit (platform-wide).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                | Type     | Risk                               |
| ----------------------------------------- | -------- | ---------------------------------- |
| `@agent-platform/database` (ApiKey model) | Package  | Low — existing, stable, no changes |
| `@agent-platform/openapi` (withOpenAPI)   | Package  | Low — established pattern          |
| `@/lib/auth` (requireAuth)                | Internal | Low — existing auth middleware     |
| `@/lib/sdk-project-access`                | Internal | Low — proven pattern from SDK keys |
| `<Tabs>` UI component                     | Internal | Low — production-proven component  |
| Node.js `crypto`                          | Built-in | None                               |

### Downstream (depends on this feature)

| Consumer                          | Impact                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| `WebhookKeyCreationModal`         | Must switch from `/api/sdk/keys` to `/api/keys` after this ships  |
| `WorkflowTriggersTab`             | Adapts key data shape for `ApiKey` fields (prefix vs keyPrefix)   |
| `WebhookQuickStart`               | Displays `abl_` prefix in curl snippets instead of `pk_`          |
| Future: Any platform API consumer | Can create scoped `abl_` keys via this UI for any future use case |

---

## 9. Open Questions & Decisions Needed

1. **Compound index (GAP-006)**: Should `{ tenantId: 1, projectIds: 1, revokedAt: 1 }` be added now or deferred until performance data shows it's needed? The existing `{ tenantId: 1 }` index covers the current low cardinality.
2. **Scope extensibility**: When new scopes are added beyond `workflow:execute` and `workflow:read`, should they be fetched from a config endpoint or remain hardcoded in `AVAILABLE_SCOPES`? The feature spec captures this as Open Question #2.

### Resolved Decisions

- **Prefix length**: RESOLVED — must be 8 characters (`rawKey.substring(0, 8)`, e.g., `abl_a1b2`). The runtime at `auth.ts:159` extracts `rawKey.substring(0, 8)` and `auth-repo.ts:107` performs an **exact match** (`apiKey.prefix !== prefix`). Storing any other length would cause all platform keys to fail authentication. Note: SDK keys (`PublicApiKey`) use 11-char `keyPrefix` with a `startsWith` comparison (auth-repo.ts:126), but `ApiKey` uses strict equality — the patterns are intentionally different.

### Pre-LLD Corrections Required

The following cross-doc inconsistencies MUST be corrected before the LLD phase begins:

1. **Feature spec prefix length**: `docs/features/sub-features/platform-keys.md` — FR-05, Section 7 (`rawKey.slice(0, 12)`), and Section 9 ("first 12 chars") all reference 12-char prefix. Must be corrected to 8 chars (`rawKey.substring(0, 8)`).
2. **Test spec prefix assertions**: `docs/testing/sub-features/platform-keys.md` — E2E-1 step 2 asserts "prefix is first 12 chars of key" and UT-1 expects "first 12 chars of rawKey". Must be corrected to 8 chars.
3. **Test spec INT-4 DELETE idempotency**: INT-4 steps 3-4 expect a second DELETE to return 200 with unchanged `revokedAt`. The HLD designs `revokedAt: null` guard in the query filter, meaning a second DELETE returns 404 (key already revoked). INT-4 must be corrected to assert 404 on second DELETE.

---

## 10. References

- Feature spec: `docs/features/sub-features/platform-keys.md`
- Test spec: `docs/testing/sub-features/platform-keys.md`
- SDK keys route (pattern reference): `apps/studio/src/app/api/sdk/keys/route.ts`
- ApiKey model: `packages/database/src/models/api-key.model.ts`
- Tabs component: `apps/studio/src/components/ui/Tabs.tsx`
- ApiKeysTab: `apps/studio/src/components/settings/ApiKeysTab.tsx`
- Runtime auth: `apps/runtime/src/repos/auth-repo.ts` (resolveApiKey)
- Workflow triggers spec: `docs/features/sub-features/workflow-triggers.md`
