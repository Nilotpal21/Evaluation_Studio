# Test Specification: Studio Attachment Settings UI

**Feature Spec**: `docs/features/sub-features/attachment-settings-ui.md`
**Parent Feature**: [Attachments](../attachments.md)
**HLD**: `docs/specs/attachment-settings-ui.hld.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-03-22

---

## 1. Coverage Matrix

| FR    | Description                      | Unit | Integration | E2E | Browser E2E | Status  |
| ----- | -------------------------------- | ---- | ----------- | --- | ----------- | ------- |
| FR-1  | Settings tab accessible via nav  | ✅   | ❌          | ❌  | ✅ BRW-1    | PASSING |
| FR-2  | Load resolved config             | ✅   | ❌          | ✅  | ✅ BRW-1    | PASSING |
| FR-3  | Override vs inherited indicators | ✅   | ❌          | ✅  | ✅ BRW-2    | PASSING |
| FR-4  | Edit all 5 config fields + 1 RO  | ✅   | ❌          | ✅  | ✅ BRW-3,4  | PASSING |
| FR-5  | Per-field reset to default       | ✅   | ❌          | ✅  | ✅ BRW-5    | PASSING |
| FR-6  | Save changes via PUT             | ✅   | ✅          | ✅  | ✅ BRW-3    | PASSING |
| FR-7  | Toast on success/failure         | ✅   | —           | —   | ✅ BRW-6    | PASSING |
| FR-8  | MIME type format validation      | ✅   | ✅          | ✅  | ✅ BRW-4    | PASSING |
| FR-9  | 50 MIME type entry cap           | ✅   | —           | ✅  | —           | PASSING |
| FR-10 | Permission gating (proxy + RBAC) | ❌   | ✅          | ✅  | —           | PASSING |

**Coverage level notes**:

- FR-7 (toast): UI-only behavior (sonner toast display). No server-side equivalent. Unit tests are the appropriate coverage level.
- FR-8 (MIME regex): Both client-side and server-side validation (GAP-004 resolved). Server Zod schema enforces MIME format regex. E2E-10 verifies server rejection.
- FR-9 (50-entry cap): Both client-side and server-side validation (GAP-004 resolved). Server Zod schema enforces `.max(50)`. E2E-10 verifies server rejection.

### Existing Coverage (Pre-Feature)

The config resolver has 7 unit tests in `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts`:

- Platform defaults fallback
- Tenant config fallback
- Project overrides tenant
- Null fields fall through
- `enabled: false` respected (falsy-but-valid)
- `maxFileSizeBytes: 0` respected (falsy-but-valid)
- Empty array `[]` respected (not null)

These cover the resolver logic but NOT the HTTP route handlers or the Studio UI.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real runtime through its HTTP API using `RuntimeApiHarness` with `MongoMemoryServer`. No mocks, no direct DB access, no stubbed servers.

**EXCEPTION**: Tenant config is seeded via direct model insert because no tenant config CRUD API exists. This is the only permitted direct DB interaction in these E2E tests.

### E2E-1: View Default Config (No Overrides)

- **Preconditions**: Project bootstrapped with no `ProjectAttachmentConfig` or `TenantAttachmentConfig` documents
- **Steps**:
  1. `GET /api/projects/:projectId/attachment-config` with valid auth (`attachment:read`)
  2. Assert response `{ success: true, data: { resolved, projectOverrides } }`
- **Expected Result**:
  - `resolved.enabled === true`
  - `resolved.maxFileSizeBytes === 20971520` (20 MB)
  - `resolved.allowedMimeTypes` contains 17 default MIME types
  - `resolved.piiPolicy === 'redact'`
  - `resolved.maxFilesPerSession === 100`
  - `projectOverrides === null` (no project config document exists)
- **Auth Context**: Tenant A user with `attachment:read` permission in Project P1
- **Isolation Check**: `GET` with Tenant B auth for same `projectId` returns 404
- **FR Coverage**: FR-2, FR-3

### E2E-2: Override Single Field and Verify Persistence

- **Preconditions**: Project bootstrapped with no prior overrides
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'block' }` (valid auth, `attachment:write`)
  2. Assert 200 response with updated `resolved.piiPolicy === 'block'`
  3. `GET /api/projects/:projectId/attachment-config` with same auth
  4. Assert `resolved.piiPolicy === 'block'`
  5. Assert `projectOverrides.piiPolicy === 'block'`
  6. Assert all other `resolved` fields still equal platform defaults
  7. Assert `projectOverrides.enabled === null`, `projectOverrides.maxFileSizeBytes === null`, etc.
- **Expected Result**: Only overridden field changes; other fields inherit platform defaults
- **Auth Context**: Tenant A user with `attachment:write` permission in Project P1
- **Isolation Check**: `GET` from different project in same tenant returns platform defaults (no cross-project leak)
- **FR Coverage**: FR-4, FR-6

### E2E-3: Reset Field to Default (Null Fallthrough)

- **Preconditions**: Project has `piiPolicy: 'block'` override from E2E-2
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: null }` (`attachment:write`)
  2. Assert 200 response with `resolved.piiPolicy === 'redact'` (platform default)
  3. `GET /api/projects/:projectId/attachment-config`
  4. Assert `resolved.piiPolicy === 'redact'`
  5. Assert `projectOverrides.piiPolicy === null`
- **Expected Result**: Null value causes resolver to fall through to platform default
- **Auth Context**: Tenant A user with `attachment:write` permission in Project P1
- **Isolation Check**: N/A (same project as E2E-2)
- **FR Coverage**: FR-5

### E2E-4: Config Disable/Enable Round-Trip

- **Preconditions**: Project with default config (attachments enabled)
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ enabled: false }` (`attachment:write`)
  2. Assert 200 with `resolved.enabled === false`
  3. `GET /api/projects/:projectId/attachment-config` — confirm persistence
  4. Assert `resolved.enabled === false` and `projectOverrides.enabled === false`
  5. Re-enable: `PUT /api/projects/:projectId/attachment-config` with `{ enabled: true }`
  6. `GET /api/projects/:projectId/attachment-config` — confirm re-enabled
  7. Assert `resolved.enabled === true`
- **Expected Result**: Disabling and re-enabling attachments persists via PUT/GET round-trip
- **Auth Context**: Tenant A user with `attachment:write` + `attachment:read` permissions
- **Isolation Check**: N/A
- **FR Coverage**: FR-4, FR-6
- **Note**: Upload behavioral verification (original steps 3-8 involving session creation and attachment upload) deferred — tracked as GAP-006 in the feature spec

### E2E-5: Permission Gating — Read vs Write

- **Preconditions**: Project bootstrapped, two users: User-R (attachment:read only), User-W (attachment:write)
- **Steps**:
  1. User-R: `GET /api/projects/:projectId/attachment-config` → Assert 200 (can read)
  2. User-R: `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'block' }` → Assert 403
  3. User-W: `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'block' }` → Assert 200
  4. User-R: `GET /api/projects/:projectId/attachment-config` → Assert `resolved.piiPolicy === 'block'` (can read the change)
- **Expected Result**: Read permission allows GET, blocks PUT. Write permission allows both.
- **Auth Context**: Two users in Tenant A, Project P1, different permission sets
- **Isolation Check**: No auth token → 401. Missing tenantId → 401.
- **FR Coverage**: FR-10

### E2E-6: Falsy-But-Valid Overrides Persist Correctly

- **Preconditions**: Project with default config
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ enabled: false, maxFileSizeBytes: 0, allowedMimeTypes: [] }`
  2. Assert 200 response
  3. `GET /api/projects/:projectId/attachment-config`
  4. Assert `resolved.enabled === false` (not null, not inherited)
  5. Assert `resolved.maxFileSizeBytes === 0` (not null, not inherited)
  6. Assert `resolved.allowedMimeTypes` is `[]` (empty array, not null, not inherited)
  7. Assert `projectOverrides.enabled === false`
  8. Assert `projectOverrides.maxFileSizeBytes === 0`
  9. Assert `projectOverrides.allowedMimeTypes` is `[]`
- **Expected Result**: `false`, `0`, and `[]` are stored and resolved as real overrides, NOT treated as null/missing
- **Auth Context**: Tenant A user with `attachment:write`
- **Isolation Check**: N/A
- **FR Coverage**: FR-4, FR-5 (edge case: falsy-but-valid values)

### E2E-7: Tenant Config Fallback (3-Tier Resolution)

- **Preconditions**: Tenant has `TenantAttachmentConfig` with `{ maxFileSizeBytes: 10485760, piiPolicy: 'block', maxAttachmentsPerSession: 50 }`. Project has NO `ProjectAttachmentConfig`.
- **Steps**:
  1. Seed `TenantAttachmentConfig` via direct model insert (no tenant config API route exists)
  2. `GET /api/projects/:projectId/attachment-config`
  3. Assert `resolved.maxFileSizeBytes === 10485760` (10 MB — from tenant)
  4. Assert `resolved.piiPolicy === 'block'` (from tenant)
  5. Assert `resolved.maxFilesPerSession === 50` (from tenant)
  6. Assert `resolved.enabled === true` (platform default — tenant has no `enabled` field)
  7. Assert `projectOverrides === null`
- **Expected Result**: Resolver merges tenant values where set, falls through to platform defaults for unset fields
- **Auth Context**: Tenant A user with `attachment:read`
- **Isolation Check**: Tenant B's GET returns platform defaults (not Tenant A's tenant config)
- **FR Coverage**: FR-2, FR-3

### E2E-8: Cross-Tenant Isolation

- **Preconditions**: Tenant A has project PA with overrides. Tenant B has project PB.
- **Steps**:
  1. Tenant A: `PUT /api/projects/:PA/attachment-config` with `{ piiPolicy: 'block' }`
  2. Tenant B: `GET /api/projects/:PA/attachment-config` (Tenant B's auth, Tenant A's project)
  3. Assert 404 (not 403 — per CLAUDE.md invariant #1)
  4. Tenant B: `GET /api/projects/:PB/attachment-config`
  5. Assert `projectOverrides === null` (Tenant B's project has no overrides)
- **Expected Result**: Cross-tenant access returns 404. Tenant B cannot read Tenant A's config.
- **Auth Context**: Two tenants with separate auth tokens
- **Isolation Check**: This IS the isolation check
- **FR Coverage**: FR-10

### E2E-9: Disabling Config Blocks Upload Endpoint (GAP-006)

- **Preconditions**: Project bootstrapped, session created
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ enabled: false }` → Assert 200
  2. `POST /api/projects/:projectId/sessions/:sessionId/attachments` (multipart upload) → Assert 403 with `ATTACHMENTS_DISABLED`
  3. `PUT /api/projects/:projectId/attachment-config` with `{ enabled: true }` → Assert 200
  4. `POST /api/projects/:projectId/sessions/:sessionId/attachments` → Assert NOT `ATTACHMENTS_DISABLED` (any other error is acceptable)
- **Expected Result**: Disabling attachments via config API prevents uploads. Re-enabling unblocks them.
- **Auth Context**: Tenant A admin with `attachment:write`
- **Isolation Check**: N/A (behavioral verification, not isolation)
- **FR Coverage**: FR-4, FR-6

### E2E-10: Server-Side Zod Validation (GAP-004)

- **Preconditions**: Project bootstrapped
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ maxFileSizeBytes: 600 * 1024 * 1024 }` → Assert 400 (exceeds 500 MB)
  2. `PUT /api/projects/:projectId/attachment-config` with `{ allowedMimeTypes: ['not-a-mime'] }` → Assert 400 (invalid format)
  3. `PUT /api/projects/:projectId/attachment-config` with `{ allowedMimeTypes: [51 items] }` → Assert 400 (exceeds 50 cap)
  4. `PUT /api/projects/:projectId/attachment-config` with `{ allowedMimeTypes: ['image/jpeg', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/*'] }` → Assert 200 (valid)
- **Expected Result**: Server rejects invalid input with 400 VALIDATION_ERROR. Valid MIME types (including wildcards and dotted subtypes) are accepted.
- **Auth Context**: Tenant A admin with `attachment:write`
- **Isolation Check**: N/A (validation, not isolation)
- **FR Coverage**: FR-8, FR-9

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Studio Proxy Forwards GET to Runtime

- **Boundary**: Studio Next.js API route → Runtime HTTP API
- **Setup**: Mock `requireTenantAuth` (returns user), `requireProjectAccess` (returns void), global `fetch` (returns config response). Mock `getRuntimeUrl` → `http://localhost:3112`.
- **Steps**:
  1. Import `GET` from `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts`
  2. Create `NextRequest` with `GET` method, auth headers, projectId param
  3. Call `GET(request, { params: { id: projectId } })`
  4. Assert `fetch` was called with `http://localhost:3112/api/projects/${projectId}/attachment-config`
  5. Assert Authorization header was forwarded
  6. Assert response body matches mock runtime response
- **Expected Result**: Studio proxy correctly forwards GET request to runtime, passes through auth headers and response body
- **Failure Mode**: If `getRuntimeUrl` is misconfigured, fetch target is wrong → 502

### INT-2: Studio Proxy Forwards PUT to Runtime

- **Boundary**: Studio Next.js API route → Runtime HTTP API
- **Setup**: Same as INT-1, but mock `fetch` for PUT method
- **Steps**:
  1. Import `PUT` from the attachment-config route
  2. Create `NextRequest` with `PUT` method, `Content-Type: application/json`, body `{ piiPolicy: 'block' }`
  3. Call `PUT(request, { params: { id: projectId } })`
  4. Assert `fetch` was called with PUT method, correct URL, body forwarded
  5. Assert response matches mock runtime response
- **Expected Result**: PUT body and headers forwarded correctly to runtime
- **Failure Mode**: Body not forwarded → runtime receives empty body → upsert with no fields

### INT-3: Studio Proxy Requires Auth

- **Boundary**: Studio Next.js API route auth middleware
- **Setup**: `requireTenantAuth` mock throws auth error
- **Steps**:
  1. Call `GET(request, { params: { id: projectId } })` with no auth
  2. Assert response status 401
  3. Assert `fetch` was NOT called (request didn't reach proxy logic)
- **Expected Result**: Unauthenticated requests are rejected before reaching the runtime
- **Failure Mode**: Missing auth check → request proxied without user context → runtime may also reject, but double-check matters for defense in depth

### INT-4: Studio Proxy Requires Project Access

- **Boundary**: Studio Next.js API route project membership check
- **Setup**: `requireTenantAuth` returns user, `requireProjectAccess` throws forbidden error
- **Steps**:
  1. Call `GET(request, { params: { id: projectId } })` with auth but user NOT in project
  2. Assert response status 404 (not 403 — per CLAUDE.md invariant)
  3. Assert `fetch` was NOT called
- **Expected Result**: Non-member user cannot access any project's attachment config via Studio proxy
- **Failure Mode**: Missing membership check → any tenant user can read any project config

### INT-5: Zod Validation Rejects Invalid Body (Runtime)

- **Boundary**: Runtime route → Zod schema validation
- **Setup**: Real runtime server via RuntimeApiHarness, MongoMemoryServer
- **Steps**:
  1. `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'invalid_value' }`
  2. Assert 400 response with `code: 'VALIDATION_ERROR'`
  3. `PUT` with `{ maxFileSizeBytes: -1 }` → Assert 400
  4. `PUT` with `{ maxFileSizeBytes: 1.5 }` → Assert 400 (not integer)
  5. `PUT` with `{ allowedMimeTypes: [''] }` → Assert 400 (empty string, min(1))
  6. `PUT` with `{ defaultProcessingMode: 'scan-only' }` → Assert 400 (not in config enum; `'scan-only'` belongs to the per-attachment model enum `'full' | 'scan-only' | 'store-raw'`, not the config enum `'full' | 'metadata_only' | 'skip'`)
- **Expected Result**: All invalid inputs rejected at the Zod validation layer with 400 status
- **Failure Mode**: Lax validation → invalid data stored in MongoDB → resolver may crash or return unexpected values

### INT-6: Zod Accepts Valid Edge Cases (Runtime)

- **Boundary**: Runtime route → Zod schema validation → MongoDB
- **Setup**: Real runtime server via RuntimeApiHarness, MongoMemoryServer
- **Steps**:
  1. `PUT` with `{ enabled: null }` → Assert 200 (nullable)
  2. `PUT` with `{ allowedMimeTypes: [] }` → Assert 200 (empty array valid)
  3. `PUT` with `{ maxFileSizeBytes: 0 }` → Assert 200 (min(0) allows zero)
  4. `PUT` with `{}` (empty body) → Assert 200 (all fields optional)
  5. `PUT` with `{ unknownField: 'x', piiPolicy: 'block' }` → Assert 200, `unknownField` stripped
  6. `GET` after each PUT to verify stored values
- **Expected Result**: Valid edge cases accepted and stored correctly; unknown fields stripped by Zod
- **Failure Mode**: Zod rejects valid inputs → users cannot set legitimate values

### INT-7: Config Upsert Creates and Updates Document

- **Boundary**: Runtime route → MongoDB (ProjectAttachmentConfig model)
- **Setup**: Real runtime server, MongoMemoryServer, project with no prior config
- **Steps**:
  1. `GET /api/projects/:projectId/attachment-config` → Assert `projectOverrides === null`
  2. `PUT` with `{ piiPolicy: 'block' }` → Assert 200, new document created (upsert)
  3. `GET` → Assert `projectOverrides.piiPolicy === 'block'`
  4. `PUT` with `{ maxFileSizeBytes: 5242880 }` → Assert 200, document updated
  5. `GET` → Assert `projectOverrides.piiPolicy === 'block'` AND `projectOverrides.maxFileSizeBytes === 5242880` (both fields preserved)
- **Expected Result**: First PUT creates document via upsert. Subsequent PUTs update existing document. Previous overrides preserved when new fields are set.
- **Failure Mode**: Upsert replaces entire document → previous overrides lost on second PUT

### INT-8: Resolver Falls Through Null Fields to Tenant Config

- **Boundary**: Config resolver → MongoDB (ProjectAttachmentConfig + TenantAttachmentConfig)
- **Setup**: Real MongoMemoryServer. Seed `TenantAttachmentConfig` with `{ maxFileSizeBytes: 10485760, piiPolicy: 'block' }`. Seed `ProjectAttachmentConfig` with `{ piiPolicy: 'allow', maxFileSizeBytes: null }`.
- **Steps**:
  1. `GET /api/projects/:projectId/attachment-config`
  2. Assert `resolved.piiPolicy === 'allow'` (project overrides tenant)
  3. Assert `resolved.maxFileSizeBytes === 10485760` (project null → falls to tenant)
  4. Assert `resolved.enabled === true` (neither has it → platform default)
- **Expected Result**: 3-tier merge works correctly with real MongoDB: project wins → tenant fallback → platform default
- **Failure Mode**: `pick()` function mishandles BSON null vs JavaScript null → wrong fallthrough

---

## 4. Unit Test Scenarios

### Component Tests (`attachment-settings-tab.test.tsx`)

Tests for the `AttachmentSettingsTab` React component. Uses vitest + React Testing Library + happy-dom. Mocks `apiFetch` for API calls, `useNavigationStore` for projectId, `sonner` toast for notifications.

#### UT-0: Navigation Wiring Renders AttachmentSettingsTab

- **Module**: Navigation integration (`navigation-store` → `AppShell` → `AttachmentSettingsTab`)
- **Input**: `useNavigationStore` current page set to `'settings-attachments'`
- **Expected Output**: `AttachmentSettingsTab` component is rendered. The component appears in the settings area of AppShell.
- **FR Coverage**: FR-1

#### UT-1: Renders Loading Spinner While Fetching

- **Module**: `AttachmentSettingsTab`
- **Input**: Component mounted, `apiFetch` returns pending promise
- **Expected Output**: Loading spinner visible, no form fields rendered
- **FR Coverage**: FR-2

#### UT-2: Renders All Config Fields with Resolved Values

- **Module**: `AttachmentSettingsTab`
- **Input**: `apiFetch` returns `{ resolved: { enabled: true, maxFileSizeBytes: 20971520, allowedMimeTypes: [...17 types], piiPolicy: 'redact', maxFilesPerSession: 100 }, projectOverrides: null }`
- **Expected Output**: Toggle shows ON, file size shows "20 MB", 17 MIME chips displayed, PII policy dropdown shows "Redact", `maxFilesPerSession` displayed as read-only "100"
- **FR Coverage**: FR-2, FR-4

#### UT-3: Shows "Inherited from Defaults" for Non-Overridden Fields

- **Module**: `AttachmentSettingsTab`
- **Input**: `projectOverrides: null` (all fields inherited)
- **Expected Output**: Each field shows "Inherited from defaults" indicator. No reset buttons visible.
- **FR Coverage**: FR-3

#### UT-4: Shows "Custom Override" Badge for Overridden Fields

- **Module**: `AttachmentSettingsTab`
- **Input**: `projectOverrides: { piiPolicy: 'block', maxFileSizeBytes: null, ... }`
- **Expected Output**: PII policy field shows "Custom override" badge + reset button. Other fields show "Inherited from defaults".
- **FR Coverage**: FR-3

#### UT-5: Toggle Enabled Field Updates Local State

- **Module**: `AttachmentSettingsTab`
- **Input**: User clicks the enabled toggle (currently ON)
- **Expected Output**: Toggle switches to OFF. Save button becomes enabled (dirty state). No API call yet.
- **FR Coverage**: FR-4

#### UT-6: Number Input for maxFileSizeBytes Accepts Valid Values

- **Module**: `AttachmentSettingsTab`
- **Input**: User types "10485760" in the file size input
- **Expected Output**: Input displays the value. Human-readable display shows "10 MB". Save button enables.
- **FR Coverage**: FR-4

#### UT-7: Chip Editor Adds MIME Type

- **Module**: `AttachmentSettingsTab`
- **Input**: User types "application/json" and presses Enter
- **Expected Output**: New chip "application/json" appears. Save button enables.
- **FR Coverage**: FR-4

#### UT-8: Chip Editor Removes MIME Type

- **Module**: `AttachmentSettingsTab`
- **Input**: User clicks X on "image/png" chip
- **Expected Output**: Chip removed from list. Save button enables.
- **FR Coverage**: FR-4

#### UT-9: Select Dropdown Changes PII Policy

- **Module**: `AttachmentSettingsTab`
- **Input**: User selects "Block" from PII policy dropdown (was "Redact")
- **Expected Output**: Dropdown shows "Block". Save button enables.
- **FR Coverage**: FR-4

#### UT-10: Select Dropdown Changes Processing Mode

- **Module**: `AttachmentSettingsTab`
- **Input**: User selects "Metadata Only" from processing mode dropdown
- **Expected Output**: Dropdown shows "Metadata Only". Save button enables. Note: if GAP-002 is unresolved, this field shows the `projectOverrides` value or "Not configured".
- **FR Coverage**: FR-4

#### UT-11: Save Button Disabled When No Changes

- **Module**: `AttachmentSettingsTab`
- **Input**: Component loaded with config, no user modifications
- **Expected Output**: Save button is disabled
- **FR Coverage**: FR-6

#### UT-12: Save Button Enabled When Dirty

- **Module**: `AttachmentSettingsTab`
- **Input**: User modifies any field
- **Expected Output**: Save button is enabled
- **FR Coverage**: FR-6

#### UT-13: maxFilesPerSession Displayed as Read-Only

- **Module**: `AttachmentSettingsTab`
- **Input**: `resolved.maxFilesPerSession === 100`
- **Expected Output**: Field rendered with value "100", no edit controls, tooltip or label explaining it's informational
- **FR Coverage**: FR-4

### Save/Validation Tests (`attachment-settings-save.test.tsx`)

#### UT-14: Save Sends PUT with Only Changed Fields

- **Module**: Save handler
- **Input**: User changes `piiPolicy` to "block", leaves other fields unchanged
- **Expected Output**: `apiFetch` called with PUT, body `{ piiPolicy: 'block' }`. Other fields NOT included in request body.
- **FR Coverage**: FR-6

#### UT-15: Reset Sends Null for Specific Field

- **Module**: Reset handler
- **Input**: User clicks reset on `maxFileSizeBytes` (previously overridden to 5 MB)
- **Expected Output**: Field value reverts to resolved default. On save, PUT body includes `{ maxFileSizeBytes: null }`.
- **FR Coverage**: FR-5

#### UT-16: MIME Format Validation Rejects Invalid Format

- **Module**: MIME type input validator
- **Input**: User types "not-a-mime" and presses Enter
- **Expected Output**: Error message displayed (e.g., "Invalid MIME type format"). Chip NOT added. Input retains invalid value for correction.
- **Validation Regex**: `^[a-z]+/([\w.+-]+|\*)$`
- **Test cases**: `"not-a-mime"` → rejected, `"IMAGE/PNG"` → rejected (uppercase), `"image/"` → rejected (empty subtype), `"/png"` → rejected (empty type)
- **FR Coverage**: FR-8

#### UT-17: MIME Format Validation Accepts Valid Format

- **Module**: MIME type input validator
- **Input**: Various valid MIME types
- **Expected Output**: Chip added for each
- **Test cases**: `"image/png"` → accepted, `"application/vnd.ms-excel"` → accepted, `"image/*"` → accepted (wildcard), `"text/plain"` → accepted, `"application/x-custom+json"` → accepted
- **FR Coverage**: FR-8

#### UT-18: 50 MIME Type Cap Enforced

- **Module**: MIME type chip editor
- **Input**: 50 MIME types already in list, user tries to add 51st
- **Expected Output**: Error message (e.g., "Maximum 50 MIME types allowed"). 51st chip NOT added.
- **FR Coverage**: FR-9

#### UT-19: Success Toast Shown on Save

- **Module**: Save handler + toast integration
- **Input**: `apiFetch` PUT resolves successfully
- **Expected Output**: `toast.success()` called with appropriate message. Form state reset to clean (not dirty). Config refreshed with response data.
- **FR Coverage**: FR-7

#### UT-20: Error Toast Shown on Failure

- **Module**: Save handler + toast integration
- **Input**: `apiFetch` PUT rejects (500 or network error)
- **Expected Output**: `toast.error()` called with error message. Form retains unsaved changes (dirty state preserved). Save button remains enabled for retry.
- **FR Coverage**: FR-7

#### UT-21: Form Retains State on Save Failure

- **Module**: Save handler
- **Input**: User changes 3 fields, save fails
- **Expected Output**: All 3 changed fields retain their modified values. User can fix and retry without re-entering data.
- **FR Coverage**: FR-7

#### UT-22: Duplicate MIME Type Rejected

- **Module**: MIME type chip editor
- **Input**: "image/png" already in list, user tries to add "image/png" again
- **Expected Output**: Error message (e.g., "Duplicate MIME type"). Duplicate chip NOT added.
- **FR Coverage**: FR-8

---

## 5. Security & Isolation Tests

### Authentication

- [x] Missing auth returns 401 (E2E-5 — no auth token scenario)
- [x] Missing tenantId on JWT returns 401 (E2E-5 — missing tenantId scenario)
- [x] Expired/invalid JWT returns 401 (INT-3)

### Authorization

- [x] `attachment:read` allows GET (E2E-5)
- [x] `attachment:read` blocks PUT (E2E-5)
- [x] `attachment:write` allows PUT (E2E-5)
- [x] No attachment permissions blocks both GET and PUT (E2E-5)

### Tenant Isolation

- [x] Cross-tenant access returns 404, not 403 (E2E-8)
- [x] Tenant A's config not visible to Tenant B (E2E-8)
- [x] Tenant A's tenant-level config does not leak into Tenant B's resolution (E2E-7 isolation check)

### Project Isolation

- [x] Cross-project access within same tenant returns correct per-project config (E2E-2 isolation check)
- [x] Non-project-member returns 404 via Studio proxy (INT-4)
- [x] Config for Project A does not affect config for Project B in same tenant (E2E-4 isolation check)

### Input Validation

- [x] Invalid enum values rejected (INT-5)
- [x] Negative numbers rejected (INT-5)
- [x] Non-integer numbers rejected (INT-5)
- [x] Empty strings in arrays rejected (INT-5)
- [x] Unknown fields stripped (INT-6)

### Known Server-Side Validation Gaps

> **Resolved (GAP-004)**: The runtime Zod schema now enforces MIME type format regex (`/^[a-z]+\/([\w.+-]+|\*)$/`), `.max(50)` array limit, and 500 MB upper bound on `maxFileSizeBytes`. E2E-10 verifies all three server-side validations. Both client and server now enforce these constraints.

---

## 6. Performance & Load Tests

Not applicable for this sub-feature. The settings page makes a single GET on load and a single PUT on save. The config resolver uses `Promise.all` for parallel DB queries (already optimized). No polling, no streaming, no WebSocket.

---

## 7. Test Infrastructure

### Required Services

| Service                | Purpose                                                 | How Provided                        |
| ---------------------- | ------------------------------------------------------- | ----------------------------------- |
| MongoDB                | ProjectAttachmentConfig, TenantAttachmentConfig storage | MongoMemoryServer (E2E/integration) |
| Runtime Express server | HTTP API endpoints                                      | RuntimeApiHarness (E2E)             |
| happy-dom              | Browser-like DOM for component tests                    | vitest config (unit)                |

### Data Seeding

| Seed                                 | Used By                    | Method                                                        |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------- |
| Clean project (no configs)           | E2E-1, E2E-2, E2E-4, E2E-6 | `bootstrapProject()` helper                                   |
| TenantAttachmentConfig               | E2E-7                      | Direct model insert (no API route)                            |
| Multi-tenant                         | E2E-8                      | Two `bootstrapProject()` calls with different tenant contexts |
| Two users with different permissions | E2E-5                      | `bootstrapProject()` + role assignment                        |

### Environment Variables

No special env vars needed. The runtime E2E harness handles:

- `MONGODB_URI` (set to MongoMemoryServer URI)
- `JWT_SECRET` (set to test secret in harness)
- `ENCRYPTION_MASTER_KEY` (if needed for auth — check harness)

### CI Configuration

```bash
# Unit tests (Studio component + save/validation)
cd apps/studio && pnpm test -- --run attachment-settings

# Integration tests (Studio proxy)
cd apps/studio && pnpm test -- --config vitest.node.config.ts --run attachment-config

# E2E tests (Runtime config API)
cd apps/runtime && pnpm test -- --run attachment-config-e2e
```

---

## 8. Test File Mapping

| Test File                                                                   | Type        | Covers                                                                 | Status  |
| --------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- | ------- |
| `apps/studio/src/__tests__/attachment-settings-tab.test.tsx`                | unit        | FR-1, FR-2, FR-3, FR-4, FR-5 (UT-0 through UT-13)                      | PASSING |
| `apps/studio/src/__tests__/attachment-settings-save.test.tsx`               | unit        | FR-5, FR-6, FR-7, FR-8, FR-9 (UT-14 through UT-22)                     | PASSING |
| `apps/studio/src/__tests__/attachment-config-proxy.test.ts`                 | integration | FR-10 (INT-1 through INT-4)                                            | PASSING |
| `apps/runtime/src/__tests__/attachment-config.e2e.test.ts`                  | e2e         | FR-2, FR-3, FR-4, FR-5, FR-6, FR-8, FR-9, FR-10 (E2E-1 through E2E-10) | PASSING |
| `apps/runtime/src/__tests__/attachment-config-validation.test.ts`           | integration | FR-8 server gap, Zod edge cases (INT-5 through INT-8)                  | PASSING |
| `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts` | unit        | Resolver logic (pre-existing, 8 tests incl. GAP-002 fix)               | PASSING |
| `apps/studio/e2e/attachment-settings-e2e.spec.ts`                           | browser e2e | FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8 (BRW-1 through BRW-6)   | PASSING |

---

## 9. Open Testing Questions

1. ~~**Browser E2E**~~: **Resolved** — `apps/studio/e2e/attachment-settings-e2e.spec.ts` adds 6 Playwright browser E2E scenarios (BRW-1 through BRW-6) covering page load, override indicators, save-reload persistence, MIME chip editor, per-field reset, and toast notification. Closes GAP-003.
2. **Concurrent writes**: Should we add a stress test for concurrent PUT requests from multiple admins? Currently assessed as low risk (atomic MongoDB upsert), but last-write-wins behavior is untested.
3. ~~**MIME regex server-side**~~: **Resolved (GAP-004)** — Server-side Zod schema now enforces MIME format regex, `.max(50)` array limit, and 500 MB upper bound. Verified by E2E-10.

---

## 10. Browser E2E Test Scenarios (Playwright)

**Test file**: `apps/studio/e2e/attachment-settings-e2e.spec.ts`
**Run**: `cd apps/studio && npx playwright test e2e/attachment-settings-e2e.spec.ts --headed`
**Requires**: Studio on 5173, Runtime on 3112

These scenarios exercise the real AttachmentSettingsTab component in a Chromium browser. They complement the API-level E2E tests (Section 2) by verifying UI interaction, visual indicators, and form behavior that cannot be tested via HTTP alone.

### BRW-1: Navigate to Settings > Attachments, Verify Page Loads

- **Preconditions**: Logged in, project selected, config reset to defaults
- **Steps**:
  1. Navigate to `/projects/:projectId/settings/attachments`
  2. Wait for "Attachment Settings" title
  3. Assert all 6 field labels visible
  4. Assert enabled toggle is checked (aria-checked="true")
  5. Assert PII Policy shows "Redact"
  6. Assert Save button is disabled
- **Expected Result**: Page loads with all resolved default values displayed correctly
- **FR Coverage**: FR-1, FR-2

### BRW-2: Override vs Inherited Indicators

- **Preconditions**: API sets `piiPolicy: 'block'` override
- **Steps**:
  1. Navigate to attachment settings
  2. Assert PII Policy container shows "Custom override" badge + reset icon
  3. Assert Enabled container shows "Inherited from defaults" badge, no reset icon
- **Expected Result**: Overridden fields show "Custom override" + reset; inherited fields show "Inherited from defaults"
- **FR Coverage**: FR-3

### BRW-3: Save-Reload Persistence (Toggle + PII + File Size)

- **Preconditions**: Config at defaults
- **Steps**:
  1. Toggle enabled OFF, change PII to "Block", change file size to 10 MB
  2. Assert Save button enabled
  3. Click Save, wait for success toast
  4. Reload page
  5. Assert all three values persisted
  6. Assert all three fields show "Custom override" badge
- **Expected Result**: UI changes persist through save-reload cycle
- **FR Coverage**: FR-4, FR-6

### BRW-4: MIME Type Chip Editor

- **Preconditions**: Config at defaults
- **Steps**:
  1. Type "application/json" + Enter → chip appears
  2. Verify remove button exists for chip
  3. Type "not-a-mime" + Enter → error message, no chip
  4. Click remove on "application/json" → chip removed
- **Expected Result**: Valid MIME types added as chips, invalid rejected with error, chips removable
- **FR Coverage**: FR-4, FR-8

### BRW-5: Per-Field Reset to Default

- **Preconditions**: API sets `piiPolicy: 'block'` override
- **Steps**:
  1. Navigate, verify "Custom override" + "Block" for PII Policy
  2. Click reset icon next to PII Policy
  3. Save, wait for toast
  4. Reload
  5. Assert PII Policy shows "Redact" (platform default)
  6. Assert "Inherited from defaults" badge
- **Expected Result**: Reset reverts field to platform default and changes indicator
- **FR Coverage**: FR-5

### BRW-6: Save Success Toast

- **Preconditions**: Config at defaults
- **Steps**:
  1. Change processing mode to "Metadata Only"
  2. Click Save
  3. Assert toast "Attachment settings saved" visible within 5s
- **Expected Result**: Success toast appears after save
- **FR Coverage**: FR-7
