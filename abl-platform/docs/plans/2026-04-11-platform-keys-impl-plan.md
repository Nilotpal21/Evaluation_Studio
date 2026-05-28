# LLD: Platform Keys Management UI

**Feature Spec**: `docs/features/sub-features/platform-keys.md`
**HLD**: `docs/specs/platform-keys.hld.md`
**Test Spec**: `docs/testing/sub-features/platform-keys.md`
**Status**: DONE
**Date**: 2026-04-11

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                       | Rationale                                                                                                              | Alternatives Rejected                                                 |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| D-1 | Extract key generation as pure utility functions               | Test spec UT-1 through UT-4 require unit testing of key gen, scopes, expiry, clientId. Pure functions need zero mocks. | Inline crypto in handler (SDK keys pattern) — not unit-testable       |
| D-2 | API routes first, then UI, then trigger migration              | Feature spec delivery plan §13 prescribes this order. API must be stable before UI consumes it.                        | UI-first — blocked on API; parallel — risky integration               |
| D-3 | No feature flag                                                | Additive feature; SDK key behavior unchanged (FR-02); rollback = delete new files + revert                             | Feature flag on tab visibility — adds complexity for low-risk feature |
| D-4 | Derive `isActive` from `revokedAt`/`expiresAt` in trigger code | `ApiKey` model has no `isActive` field. Must compute: `revokedAt === null && (!expiresAt                               |                                                                       | expiresAt > now)` | Add `isActive` virtual to model — unnecessary schema change for one UI consumer |
| D-5 | `revokedAt: null` guard in DELETE query                        | HLD audit finding: ensures idempotency, preserves original `revokedAt` timestamp for audit trail                       | Unconditional `$set` — overwrites timestamp on repeated calls         |
| D-6 | Prefix = 8 chars via `rawKey.substring(0, 8)`                  | Runtime `auth.ts:159` extracts 8 chars; `auth-repo.ts:107` does exact match. Any other length breaks auth.             | 12 chars (feature spec original) — breaks runtime auth                |

### Key Interfaces & Types

```typescript
// apps/studio/src/app/api/keys/platform-key-utils.ts

/** Predefined scopes for platform keys */
export const AVAILABLE_SCOPES = ['workflow:execute', 'workflow:read'] as const;
export type PlatformKeyScope = (typeof AVAILABLE_SCOPES)[number];

/** Generate a platform API key with abl_ prefix */
export function generatePlatformKey(): {
  rawKey: string;
  prefix: string;
  keyHash: string;
};

/** Generate a plt-<uuidv7> clientId for UI-created keys */
export function generateClientId(): string;

/** Validate scopes against the predefined list */
export function validateScopes(scopes: string[]): scopes is PlatformKeyScope[];

/** Compute expiration date from preset */
export function computeExpiresAt(
  preset: 'none' | '30d' | '90d' | null,
  customDate?: string,
): Date | null;
```

```typescript
// Zod schemas for /api/keys routes

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(['workflow:execute', 'workflow:read'])).min(1),
  projectIds: z.array(z.string().min(1)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

const UpdateKeySchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  scopes: z
    .array(z.enum(['workflow:execute', 'workflow:read']))
    .min(1)
    .optional(),
});

const KeyResponseSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  projectIds: z.array(z.string()),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

// POST response extends KeyResponseSchema with one-time raw key
const CreateKeyResponseSchema = KeyResponseSchema.extend({
  key: z.string(), // raw key (abl_...), returned ONCE only
});

const DeleteQuerySchema = z.object({
  projectId: z.string().min(1),
});

const ListQuerySchema = z.object({
  projectId: z.string().min(1),
});
```

### Tenant Isolation — Explicit tenantId in All Queries

**CRITICAL**: The `tenantIsolationPlugin` on the `ApiKey` model relies on AsyncLocalStorage (ALS) context to auto-inject `tenantId`. Studio Next.js API routes do NOT configure ALS (`withTenantContext` is not called). Therefore, every Mongoose query in the route handlers MUST explicitly include `tenantId: user.tenantId` in the filter. This matches the SDK keys pattern where `sdk-repo.ts` passes `tenantId` explicitly.

All queries in route handlers MUST include `tenantId` explicitly:

- GET: `ApiKey.find({ tenantId: user.tenantId, projectIds: ..., revokedAt: null, ... })`
- POST: `ApiKey.create({ tenantId: user.tenantId, ... })`
- PATCH: `ApiKey.findOne({ _id: keyId, tenantId: user.tenantId, ... })`
- DELETE: `ApiKey.updateOne({ _id: keyId, tenantId: user.tenantId, revokedAt: null, ... })`

### Database Connection — ensureDb()

Every route handler MUST call `await ensureDb()` (from `@/lib/ensure-db`) at the top before any Mongoose model operation. This ensures MongoDB connection is established on cold starts, matching the pattern in `sdk-repo.ts`.

### Multi-Project Access Validation

The POST handler MUST validate `requireSdkProjectAccess(pid, user, 'write')` for ALL `projectIds` in the request body, not just the first. This prevents privilege escalation where a user adds a project they don't have write access to. If any check fails, return 404.

```typescript
// POST handler — validate ALL projectIds
for (const pid of body.projectIds) {
  const access = await requireSdkProjectAccess(pid, user, 'write');
  if (isSdkProjectAccessError(access)) return access; // returns 404
}
```

### Error Response Format

Error responses use a hybrid format matching the SDK keys pattern:

- **Zod validation errors** (via `validateBody()`): Returns `{ success: false, errors: [{ code: 'VALIDATION_ERROR', msg: '...' }] }` — this is the `@agent-platform/openapi/nextjs` standard format, not customizable.
- **Manual 400 errors**: `{ error: 'Cannot modify projectIds' }` — bare `{ error: string }`, matching SDK keys pattern.
- **401**: Returned by `requireAuth` (NextResponse).
- **404**: `{ error: 'API key not found' }` or returned by `requireSdkProjectAccess` (NextResponse).
- **500**: `{ error: 'Internal server error' }`.

Success shapes: DELETE → `{ success: true }`. GET → `{ keys: [...] }`. POST → key object (using `CreateKeyResponseSchema` which includes `key: rawKey`) with 201.

### i18n — Translation Keys

New translation keys in `packages/i18n/locales/en/studio.json` under `settings`:

- `settings.api_keys.tab_sdk_keys` — "SDK Keys"
- `settings.api_keys.tab_platform_keys` — "Platform Keys"
- `settings.platform_keys.page_title` — "Platform Keys"
- `settings.platform_keys.page_description` — "Manage API keys for platform integrations"
- `settings.platform_keys.create_key` — "Create Key"
- `settings.platform_keys.empty_title` — "No platform keys yet"
- `settings.platform_keys.empty_description` — "Create a platform key to authenticate API calls"
- `settings.platform_keys.revoke_warning` — "This key may be in use by workflow triggers..."
- `settings.platform_keys.created_warning` — "This key will not be shown again..."
- (and additional keys for form labels, buttons, etc.)

```typescript
// Shared ApiKey shape used by trigger components after migration
interface TriggerApiKey {
  id: string;
  prefix: string; // was keyPrefix
  isActive: boolean; // derived: revokedAt === null && (!expiresAt || new Date(expiresAt) > new Date())
  expiresAt: string | null;
}
```

### Module Boundaries

| Module                           | Responsibility                                         | Depends On                                         |
| -------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `api/keys/route.ts`              | GET (list) + POST (create) platform keys               | `platform-key-utils`, `ApiKey` model, auth libs    |
| `api/keys/[keyId]/route.ts`      | PATCH (edit) + DELETE (revoke) individual key          | `ApiKey` model, auth libs                          |
| `api/keys/platform-key-utils.ts` | Pure key generation, scope validation, clientId format | `crypto` (Node built-in)                           |
| `PlatformKeysTab.tsx`            | Platform key list, create/edit/revoke UI               | `apiFetch`, UI components, `api/keys` routes       |
| `ApiKeysTab.tsx` (modified)      | Tabbed wrapper: SDK Keys + Platform Keys tabs          | `<Tabs>`, existing SDK key UI, `PlatformKeysTab`   |
| `WebhookKeyCreationModal.tsx`    | Create/select key for webhook trigger (migrated)       | `apiFetch`, `api/keys` routes (was `api/sdk/keys`) |
| `WebhookQuickStart.tsx`          | Quick-start panel with key status (migrated)           | `TriggerApiKey` shape (was SDK key shape)          |
| `WorkflowTriggersTab.tsx`        | Orchestrator: fetches keys, threads data to children   | `apiFetch`, `api/keys` routes, trigger components  |

---

## 2. File-Level Change Map

### New Files

| File                                                      | Purpose                                         | LOC Estimate |
| --------------------------------------------------------- | ----------------------------------------------- | ------------ |
| `apps/studio/src/app/api/keys/route.ts`                   | GET + POST handlers for platform keys           | ~150         |
| `apps/studio/src/app/api/keys/[keyId]/route.ts`           | PATCH + DELETE handlers for individual key      | ~120         |
| `apps/studio/src/app/api/keys/platform-key-utils.ts`      | Pure utility functions for key gen, validation  | ~50          |
| `apps/studio/src/components/settings/PlatformKeysTab.tsx` | Platform key list, create, edit, revoke UI      | ~350         |
| `apps/studio/src/__tests__/platform-keys-unit.test.ts`    | Unit tests for pure utility functions (UT-1..4) | ~80          |
| `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts` | E2E tests (E2E-1..10)                           | ~400         |
| `apps/studio/src/__tests__/platform-keys-api.test.ts`     | Integration tests (INT-1..10)                   | ~350         |

### Modified Files

| File                                                                        | Change Description                                                             | Risk |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---- |
| `apps/studio/src/components/settings/ApiKeysTab.tsx`                        | Add `<Tabs>` wrapper, extract SDK key content under "SDK Keys" tab             | Low  |
| `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` | Switch endpoints `/api/sdk/keys` → `/api/keys`, adapt request/response shapes  | Med  |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`       | Rename `keyPrefix` → `prefix` in props, adapt `isActive` derivation            | Med  |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`         | Switch fetch URL, adapt 6+ field mapping locations for `ApiKey` response shape | High |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: API Routes + Utilities

**Goal**: Create the `/api/keys` CRUD endpoints and pure utility functions, following the SDK keys route pattern.

**Tasks**:

1.1. Create `apps/studio/src/app/api/keys/platform-key-utils.ts` with pure functions:

- `generatePlatformKey()`: `abl_${randomBytes(24).hex()}`, prefix = `substring(0, 8)`, keyHash = SHA-256
- `generateClientId()`: `plt-${uuidv7()}`
- `validateScopes(scopes)`: checks against `AVAILABLE_SCOPES`
- `computeExpiresAt(preset, customDate)`: returns Date or null
- Export `AVAILABLE_SCOPES` constant

  1.2. Create `apps/studio/src/app/api/keys/route.ts` (GET + POST):

- Import `ApiKey` from `@agent-platform/database/models`, `ensureDb` from `@/lib/ensure-db`
- GET handler: `requireAuth` → extract `projectId` from `searchParams` (validate with `ListQuerySchema.safeParse`) → `ensureDb()` → `requireSdkProjectAccess(projectId, user, 'read')` → `ApiKey.find({ tenantId: user.tenantId, projectIds: { $in: [projectId] }, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).limit(100).sort({ createdAt: -1 }).lean()` → return `{ keys: [...] }` (no keyHash, no raw key)
- POST handler: `requireAuth` → `validateBody(request, CreateKeySchema)` → `ensureDb()` → loop ALL `body.projectIds` calling `requireSdkProjectAccess(pid, user, 'write')` (return 404 if any fails) → `generatePlatformKey()` → `generateClientId()` → `ApiKey.create({ tenantId: user.tenantId, name, clientId, keyHash, prefix, scopes, projectIds, environments: [], expiresAt, createdBy: user.id })` → return key object with 201
- Wrap both with `withOpenAPI` and Zod schemas
- Use `createLogger('platform-keys')` for structured logging

  1.3. Create `apps/studio/src/app/api/keys/[keyId]/route.ts` (PATCH + DELETE):

- Import `ApiKey` from `@agent-platform/database/models`, `ensureDb` from `@/lib/ensure-db`
- PATCH handler: `requireAuth` → `validateBody(request, UpdateKeySchema)` → `ensureDb()` → `requireSdkProjectAccess(body.projectId, user, 'write')` → reject if body has `projectIds` field (400: `{ error: 'Cannot modify projectIds' }`) → `ApiKey.findOneAndUpdate({ _id: keyId, tenantId: user.tenantId, projectIds: { $in: [body.projectId] } }, { $set: { ...fields } }, { new: true }).lean()` → if null, return 404 → return updated fields
- DELETE handler: `requireAuth` → extract `projectId` from `searchParams` (validate with `DeleteQuerySchema.safeParse`) → `ensureDb()` → `requireSdkProjectAccess(projectId, user, 'write')` → `ApiKey.updateOne({ _id: keyId, tenantId: user.tenantId, projectIds: { $in: [projectId] }, revokedAt: null }, { $set: { revokedAt: new Date() } })` → if `modifiedCount === 0`, return 404 (`{ error: 'API key not found' }`) → else return `{ success: true }`
- Wrap both with `withOpenAPI`
- Use `createLogger('platform-keys')` for structured logging

  1.4. Create `apps/studio/src/__tests__/platform-keys-unit.test.ts`:

- UT-1: `generatePlatformKey()` returns `abl_` prefix, 8-char prefix, 64-char hex hash
- UT-2: `validateScopes()` accepts valid scopes, rejects invalid
- UT-3: `computeExpiresAt()` returns correct dates for presets
- UT-4: `generateClientId()` returns `plt-` prefix

**Files Touched**:

- `apps/studio/src/app/api/keys/platform-key-utils.ts` — NEW
- `apps/studio/src/app/api/keys/route.ts` — NEW
- `apps/studio/src/app/api/keys/[keyId]/route.ts` — NEW
- `apps/studio/src/__tests__/platform-keys-unit.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] All 4 unit tests pass (`pnpm test --filter=studio -- platform-keys-unit`)
- [ ] `curl -X POST /api/keys` with valid auth returns 201 with `abl_` key (manual smoke test)
- [ ] `curl -X GET /api/keys?projectId=...` returns created key without raw key
- [ ] `curl -X PATCH /api/keys/:id` updates name/scopes
- [ ] `curl -X DELETE /api/keys/:id` sets revokedAt, second DELETE returns 404

**Test Strategy**:

- Unit: UT-1 through UT-4 for pure utility functions
- Smoke: Manual curl commands against dev server

**Rollback**: Delete the 4 new files. No existing files modified.

---

### Phase 2: Settings UI — Tabbed Layout + Platform Keys Tab

**Goal**: Add "SDK Keys" / "Platform Keys" tabs in Settings > API Keys, with the Platform Keys tab showing key list, create dialog, edit dialog, and revoke confirmation.

**Tasks**:

2.1. Modify `apps/studio/src/components/settings/ApiKeysTab.tsx`:

- Import `Tabs` from `../ui/Tabs` and `PlatformKeysTab`
- Add `activeTab` state, default `'sdk-keys'`
- Wrap existing return JSX: move the loading spinner and main content into a `{activeTab === 'sdk-keys' && ...}` conditional
- Add `<Tabs>` at the top with `tabs={[{id:'sdk-keys', label: t('api_keys.tab_sdk_keys')}, {id:'platform-keys', label: t('api_keys.tab_platform_keys')}]}`
- Render `<PlatformKeysTab />` when `activeTab === 'platform-keys'`
- Preserve all existing SDK key behavior exactly (FR-02)

  2.2. Create `apps/studio/src/components/settings/PlatformKeysTab.tsx`:

- State: `keys[]`, `isLoading`, `showCreate`, `showEdit`, `editTarget`, `showRevoke`, `revokeTarget`, `rawKey`
- `load()`: `apiFetch('/api/keys?projectId=${projectId}')` → parse response → `setKeys(data.keys)` (note: `apiFetch(path, init?)` — first arg is URL path, GET is default; for mutations: `apiFetch(url, { method: 'POST', ... })`)
- Key list: Each row shows name, prefix (monospace), scope badges (`<Badge>`), creation date, expiration status, Edit and Revoke buttons
- Create dialog (`<Dialog>`):
  - Name input (required)
  - Scopes multi-select checkboxes from `AVAILABLE_SCOPES`
  - Projects multi-select dropdown (pre-selected current project) — fetch user's accessible projects
  - Expiration picker: radio group (None / 30d / 90d / Custom date picker)
  - Submit: `apiFetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })` → show `KeyRevealModal` with raw key from `data.key`
- Key reveal modal: Raw key display with copy-to-clipboard, "will not be shown again" warning
- Edit dialog (`<Dialog>`):
  - Name input (pre-filled)
  - Scopes multi-select (pre-filled)
  - ProjectIds shown read-only
  - Submit: ``apiFetch(`/api/keys/${keyId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, name, scopes }) })``
- Revoke confirmation (`<ConfirmDialog>`):
  - Warning text about workflow triggers
  - Confirm: ``apiFetch(`/api/keys/${keyId}?projectId=${projectId}`, { method: 'DELETE' })``

**Files Touched**:

- `apps/studio/src/components/settings/ApiKeysTab.tsx` — MODIFY (add tabs wrapper)
- `apps/studio/src/components/settings/PlatformKeysTab.tsx` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] Settings > API Keys page shows two tabs: "SDK Keys" and "Platform Keys"
- [ ] Clicking "SDK Keys" tab shows the existing SDK key management UI with no behavior changes
- [ ] Clicking "Platform Keys" tab shows key list fetched from `/api/keys`
- [ ] Create dialog produces a key with `abl_` prefix, shows one-time raw key modal
- [ ] Edit dialog updates name and scopes
- [ ] Revoke dialog shows warning, revoke removes key from list
- [ ] Loading state and empty state render correctly

**Test Strategy**:

- Manual: Visual verification in browser at `/settings/api-keys`
- Regression: Verify SDK key create/delete still works

**Rollback**: Revert `ApiKeysTab.tsx` to remove tabs wrapper. Delete `PlatformKeysTab.tsx`.

---

### Phase 3: Workflow Trigger Migration

**Goal**: Switch `WebhookKeyCreationModal`, `WebhookQuickStart`, and `WorkflowTriggersTab` from `/api/sdk/keys` to `/api/keys`, adapting all field mappings.

**Tasks**:

3.1. Modify `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`:

- Update `linkedApiKey` state type: `keyPrefix` → `prefix`, keep `isActive` and `expiresAt`
- Update fetch URL: search for `/api/sdk/keys?projectId=` → replace with `/api/keys?projectId=`
- Update response type cast: `keyPrefix` → `prefix`, add `revokedAt` and `scopes` to response shape, derive `isActive`: `!k.revokedAt && (!k.expiresAt || new Date(k.expiresAt) > new Date())`
- Search-and-replace all `keyPrefix` field references in the file → `prefix` (appears in `linkedApiKey` state, `fetchExistingKey` response mapping, `transformedApiKey` construction, `onKeyCreated` callback)
- Update all `isActive` field assignments to derived values where constructing key objects from API responses
- Update `createdRawKey.slice(0, 8)` references — these construct prefix from raw key; rename the field in the object literal from `keyPrefix` to `prefix`

  3.2. Modify `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx`:

- Update `SdkKey` interface: `keyPrefix` → `prefix`, remove `isActive`/`permissions`, add `scopes`, `revokedAt`, `expiresAt`
- Update `SdkKeyCreateResponse` interface: `keyPrefix` → `prefix`
- Update fetch URL (line ~91): `/api/sdk/keys?projectId=...` → `/api/keys?projectId=...`
- Update POST URL (line ~120): `/api/sdk/keys` → `/api/keys`
- Update POST body (line ~123-127): `{ projectId, name, permissions: { chat: true } }` → `{ name, scopes: ['workflow:execute'], projectIds: [projectId] }`
- Update response mapping (line ~130): `result.key` stays the same, field names adapt
- Remove client-side `k.isActive` filter (line ~97) — the new `/api/keys` GET endpoint already excludes revoked and expired keys server-side, so client-side re-filtering is unnecessary
- Update dropdown display (line ~226): `k.keyPrefix` → `k.prefix`

  3.3. Modify `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`:

- Update `WebhookQuickStartProps.apiKey` type: `keyPrefix` → `prefix`
- Update all `apiKey.keyPrefix` references → `apiKey.prefix`:
  - `handleCopyKey` callback: `rawApiKey || apiKey?.keyPrefix` → `rawApiKey || apiKey?.prefix`
  - Key display `<code>` element: `{apiKey.keyPrefix}...` → `{apiKey.prefix}...`
  - `CodeSnippets` prop: `apiKeyPrefix={apiKey?.keyPrefix}` → `apiKeyPrefix={apiKey?.prefix}`
- `isActive` derivation is already handled by `WorkflowTriggersTab` passing the computed value

**Files Touched**:

- `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` — MODIFY (6+ locations)
- `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` — MODIFY
- `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` — MODIFY

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 type errors (catches all stale `keyPrefix`/`isActive` refs)
- [ ] Workflow > Triggers > Webhook panel: "Generate API Key" creates `abl_` key
- [ ] Key creation modal shows existing platform keys (not SDK keys)
- [ ] WebhookQuickStart curl snippets show `abl_` prefix
- [ ] Key status badge renders correctly (active/expired)
- [ ] Existing trigger key selection still works

**Test Strategy**:

- Manual: Walk through webhook trigger creation flow in browser
- Type checking: `tsc --noEmit` catches all stale field references

**Rollback**: Revert all 3 files to their pre-modification state. The `/api/sdk/keys` routes are untouched and still work.

---

### Phase 4: E2E and Integration Tests

**Goal**: Implement all test scenarios from the test spec to verify correctness.

**Tasks**:

4.0. Extend `apps/studio/src/__tests__/helpers/studio-api-harness.ts`:

- Import the new route modules: `api/keys/route` (GET + POST) and `api/keys/[keyId]/route` (PATCH + DELETE)
- Mount them using the harness's `wrapRoute`/`wrapRouteWithParams` helpers:
  - `/api/keys` → `wrapRoute(keysRoute, baseUrlProvider)` for GET/POST
  - `/api/keys/:keyId` → `wrapRouteWithParams(keyIdRoute, baseUrlProvider, (req) => ({ keyId: req.params.keyId }))` for PATCH/DELETE
- Verify the harness starts with the new routes responding (smoke test)

  4.1. Create `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts`:

- Setup: `startStudioApiHarness()`, dev-login for JWT tokens, create project
- E2E-1: Create key, verify in list (FR-05, FR-06, FR-13)
- E2E-2: Revoke key, verify exclusion (FR-11, FR-03)
- E2E-3: Cross-tenant isolation returns 404 (FR-14, invariant #1)
- E2E-4: Cross-project isolation (FR-03, FR-14)
- E2E-5: Scope validation rejects unknown scopes (FR-07)
- E2E-6: Edit name/scopes, projectIds immutable (FR-10)
- E2E-7: Expired key excluded from list (FR-03, FR-08)
- E2E-8: Unauthenticated request returns 401 (FR-14)
- E2E-9: Workflow trigger key creation contract (FR-15, FR-16)
- E2E-10: Multi-project key visible in both projects (FR-09)

  4.2. Create `apps/studio/src/__tests__/platform-keys-api.test.ts`:

- Setup: `startStudioApiHarness()` with MongoMemoryServer
- INT-1: POST creates ApiKey document with correct fields
- INT-2: GET filters by projectId, revokedAt, expiresAt
- INT-3: keyHash matches SHA-256 of raw key (verify at DB level)
- INT-4: DELETE soft-revokes, second DELETE returns 404
- INT-5: Auth middleware rejects unauthenticated/unauthorized
- INT-6: Zod validation rejects malformed bodies
- INT-7: tenantIsolationPlugin scopes queries to tenantId
- INT-8: 100-item safety cap enforced
- INT-9: PATCH updates name/scopes, rejects projectIds change
- INT-10: Multi-project key stored with correct projectIds array

**Files Touched**:

- `apps/studio/src/__tests__/platform-keys-api.e2e.test.ts` — NEW
- `apps/studio/src/__tests__/platform-keys-api.test.ts` — NEW

**Exit Criteria**:

- [ ] All 10 E2E test scenarios pass
- [ ] All 10 integration test scenarios pass
- [ ] `pnpm test --filter=studio -- platform-keys` exits with 0 failures
- [ ] No existing tests regressed (`pnpm test --filter=studio`)

**Test Strategy**:

- E2E: Real HTTP requests against `startStudioApiHarness()`, full middleware chain, MongoMemoryServer
- Integration: Direct MongoDB verification of stored documents, hash matching, index behavior
- Zero mocks of codebase components

**Rollback**: Delete test files. No production code affected.

---

## 4. Wiring Checklist

- [ ] New routes registered by Next.js App Router automatically (file-based routing: `app/api/keys/route.ts` and `app/api/keys/[keyId]/route.ts`)
- [ ] `ApiKey` model already exported from `packages/database/src/models/index.ts` — no change needed
- [ ] `PlatformKeysTab` imported and rendered in `ApiKeysTab.tsx` under the "Platform Keys" tab
- [ ] `<Tabs>` imported from `../ui/Tabs` in `ApiKeysTab.tsx`
- [ ] `platform-key-utils.ts` imported in `route.ts` for key generation functions
- [ ] `WebhookKeyCreationModal` fetches from `/api/keys` instead of `/api/sdk/keys`
- [ ] `WorkflowTriggersTab` fetches from `/api/keys` instead of `/api/sdk/keys`
- [ ] `WebhookQuickStart` receives `prefix` (not `keyPrefix`) in `apiKey` prop

---

## 5. Cross-Phase Concerns

### Database Migrations

None. The `api_keys` collection and all indexes already exist. No schema changes.

### Feature Flags

None required. Direct deployment. See Decision D-3.

### Configuration Changes

None. No new environment variables, config keys, or runtime configuration. The `AVAILABLE_SCOPES` constant is hardcoded in `platform-key-utils.ts` (Open Question #2 in HLD tracks future extensibility).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 16 FRs from feature spec verified (P0 + P1)
- [ ] All 10 E2E tests passing (E2E-1 through E2E-10)
- [ ] All 10 integration tests passing (INT-1 through INT-10)
- [ ] All 4 unit tests passing (UT-1 through UT-4)
- [ ] `pnpm build --filter=studio` succeeds with 0 type errors
- [ ] `pnpm test --filter=studio` passes with no regressions
- [ ] Settings > API Keys shows tabbed UI with SDK Keys and Platform Keys
- [ ] Platform key CRUD works end-to-end (create → list → edit → revoke)
- [ ] WebhookKeyCreationModal creates `ApiKey` via `/api/keys` with `abl_` prefix
- [ ] WebhookQuickStart curl snippets show `abl_` prefix
- [ ] Cross-tenant access returns 404 (not 403)
- [ ] Cross-project access returns empty list
- [ ] Expired/revoked keys excluded from list
- [ ] Raw key shown only once after creation

---

## 7. Open Questions

1. **Compound index (GAP-006)**: Should `{ tenantId: 1, projectIds: 1, revokedAt: 1 }` be added in Phase 1? The existing `{ tenantId: 1 }` index is sufficient for current cardinality. Decision: defer, add during Phase 4 if integration tests show slow queries.
2. **Test spec payload corrections needed during Phase 4 implementation**:
   - **PATCH `projectId` required**: E2E-6 and INT-3 in the test spec reference PATCH payloads without the required `projectId` field. All PATCH request bodies must include `projectId` per `UpdateKeySchema`.
   - **DELETE `projectId` required**: E2E-2 step 1, E2E-3 steps 3/5, INT-4 steps 1/3, INT-9 step 2 show `DELETE /api/keys/<keyId>` without `?projectId=...`. All DELETE requests must include `projectId` query param per `DeleteQuerySchema`.
   - **Error response format**: INT-6 step 6 expects `{ error: { code, message } }` but actual responses use `{ success: false, errors: [...] }` for Zod failures and `{ error: 'string' }` for manual 400s (matching SDK keys pattern). Tests must assert actual shapes.
3. **i18n key namespace**: Tab labels use `settings.api_keys.tab_*` (page-level) while content uses `settings.platform_keys.*` (feature-level). This is intentional — tabs belong to the API Keys page, content belongs to the Platform Keys feature.
4. **HLD tenant isolation correction**: HLD Concern #1 states "the plugin handles it transparently" but Studio routes lack ALS context. Post-impl-sync must update HLD to note explicit `tenantId` is required in Studio API routes.
