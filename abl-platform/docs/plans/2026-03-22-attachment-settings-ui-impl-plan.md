# LLD: Studio Attachment Settings UI

**Feature Spec**: `docs/features/sub-features/attachment-settings-ui.md`
**HLD**: `docs/specs/attachment-settings-ui.hld.md`
**Test Spec**: `docs/testing/sub-features/attachment-settings-ui.md`
**Status**: DONE
**Date**: 2026-03-22

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                        | Rationale                                                                                           | Alternatives Rejected                                          |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D-1 | Bottom-up implementation order                  | Each phase depends on the previous: resolver → proxy → nav → component → i18n → tests               | Top-down (UI first) — blocked on missing backend/proxy         |
| D-2 | GAP-002 as separate Phase 0                     | Different package (runtime), independently testable, critical prerequisite                          | Bundling with proxy — mixes runtime/studio changes             |
| D-3 | Numeric MB input (not raw bytes)                | Matches wireframe, simplest UX, no new component needed. Convert MB↔bytes transparently             | Raw bytes input, unit selector dropdown                        |
| D-4 | `Paperclip` icon for sidebar                    | Already used for attachments in ChatInput.tsx, universally recognized, already mocked in test setup | FileUp, Upload, File — less associated with "attachments"      |
| D-5 | Tests alongside each phase                      | Catches integration errors early per phase                                                          | All tests in final phase — late failure discovery              |
| D-6 | No feature flag                                 | Zero existing settings tabs use feature flags. Admin-only, purely additive                          | Feature flag rollout — unnecessary overhead                    |
| D-7 | New inherited/overridden indicator pattern      | No existing settings tab has this UX. Must build from scratch                                       | Reuse existing pattern — none exists                           |
| D-8 | Place in "Security & Observability" nav section | Attachments relate to data handling/security (PII policy, file restrictions)                        | "General" — too generic; "Agent Behavior" — not agent-specific |

### Key Interfaces & Types

```typescript
// === Runtime: Extended ResolvedAttachmentConfig (GAP-002) ===
// File: apps/runtime/src/attachments/attachment-config-resolver.ts
// NOTE: defaultProcessingMode is added by Phase 0 — not present in current runtime response
export interface ResolvedAttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip'; // Added by Phase 0
}

// === Studio: API response shape from runtime (after Phase 0) ===
interface AttachmentConfigResponse {
  success: true;
  data: {
    resolved: ResolvedAttachmentConfig;
    // Note: maxFilesPerSession is NOT in projectOverrides — not editable at project level
    projectOverrides: {
      enabled: boolean | null;
      maxFileSizeBytes: number | null;
      allowedMimeTypes: string[] | null;
      piiPolicy: 'redact' | 'block' | 'allow' | null;
      defaultProcessingMode: 'full' | 'metadata_only' | 'skip' | null;
    } | null;
  };
}

// === Studio: PUT request body (only changed fields) ===
interface AttachmentConfigUpdateBody {
  enabled?: boolean | null;
  maxFileSizeBytes?: number | null;
  allowedMimeTypes?: string[] | null;
  piiPolicy?: 'redact' | 'block' | 'allow' | null;
  defaultProcessingMode?: 'full' | 'metadata_only' | 'skip' | null;
}

// === Studio: Constants ===
const BYTES_PER_MB = 1024 * 1024;
const MIME_PATTERN = /^[a-z]+\/([\w.+-]+|\*)$/;
const MAX_MIME_ENTRIES = 50;

// === Studio: Component local state ===
interface AttachmentFormState {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number; // read-only
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip' | null;
}

// === Studio: Reset tracking ===
// pendingNulls tracks fields where the user clicked "reset to default".
// On save, computeDiff includes { fieldName: null } for each field in this set,
// regardless of whether the display value matches the initial state.
type PendingNulls = Set<keyof AttachmentConfigUpdateBody>;
```

### Module Boundaries

| Module                       | Responsibility                                           | Depends On                                                    |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `attachment-config-resolver` | 3-tier config merge with `defaultProcessingMode`         | `ProjectAttachmentConfig`, `TenantAttachmentConfig` models    |
| `attachment-config route`    | Runtime REST API (GET/PUT) with RBAC                     | `attachment-config-resolver`, `ProjectAttachmentConfig` model |
| `attachment-config proxy`    | Studio API route: auth + membership + forward to runtime | `requireTenantAuth`, `requireProjectAccess`, `getRuntimeUrl`  |
| `AttachmentSettingsTab`      | React component: form, validation, save/reset            | `apiFetch`, `useNavigationStore`, `sonner` toast, `next-intl` |
| `navigation-store`           | URL ↔ page routing                                       | `ProjectPage` type                                            |
| `AppShell`                   | Renders the correct tab component                        | `AttachmentSettingsTab` import                                |
| `ProjectSidebar`             | Settings nav items in sidebar                            | `navigation-store`, Lucide icons                              |

---

## 2. File-Level Change Map

### New Files

| File                                                               | Purpose                            | LOC Estimate |
| ------------------------------------------------------------------ | ---------------------------------- | ------------ |
| `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` | Studio proxy route (GET + PUT)     | ~60          |
| `apps/studio/src/components/settings/AttachmentSettingsTab.tsx`    | Settings tab component             | ~350         |
| `apps/studio/src/__tests__/attachment-settings-tab.test.tsx`       | Unit tests (UT-0 through UT-13)    | ~300         |
| `apps/studio/src/__tests__/attachment-settings-save.test.tsx`      | Unit tests (UT-14 through UT-22)   | ~250         |
| `apps/studio/src/__tests__/attachment-config-proxy.test.ts`        | Integration tests (INT-1 to INT-4) | ~200         |
| `apps/runtime/src/__tests__/attachment-config.e2e.test.ts`         | E2E tests (E2E-1 through E2E-8)    | ~400         |
| `apps/runtime/src/__tests__/attachment-config-validation.test.ts`  | Integration tests (INT-5 to INT-8) | ~250         |

### Modified Files

| File                                                                        | Change Description                                           | Risk |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| `apps/runtime/src/attachments/attachment-config-resolver.ts`                | Add `defaultProcessingMode` to interface, defaults, resolver | Low  |
| `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts` | Add test for `defaultProcessingMode` resolution              | Low  |
| `apps/studio/src/store/navigation-store.ts`                                 | Add `'settings-attachments'` to type + 2 maps                | Low  |
| `apps/studio/src/components/navigation/AppShell.tsx`                        | Add import + switch case                                     | Low  |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`                  | Add nav item to settings group                               | Low  |
| `packages/i18n/locales/en/studio.json`                                      | Add ~38 i18n keys (nav + tabs + settings.attachments.\*)     | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 0: Resolver Extension (GAP-002)

**Goal**: Add `defaultProcessingMode` to the 3-tier config resolver so the UI can show resolved values.

**Tasks**:

0.1. Add `defaultProcessingMode: 'full' | 'metadata_only' | 'skip'` to `ResolvedAttachmentConfig` interface in `attachment-config-resolver.ts` (L20-26)

0.2. Add `defaultProcessingMode: 'full'` to `PLATFORM_DEFAULTS` constant (L32-56)

0.3. Add `pick()` call in the resolver return object (L97-121):

```typescript
defaultProcessingMode: pick(
  projectConfig?.defaultProcessingMode,
  undefined, // TenantAttachmentConfig has no defaultProcessingMode field
  PLATFORM_DEFAULTS.defaultProcessingMode,
),
```

0.4. Add unit test in `attachment-config-resolver.test.ts`: verify `defaultProcessingMode` returns `'full'` by default, respects project override, falls through null to platform default

0.5. Run `pnpm build --filter=@agent-platform/runtime` and `pnpm test --filter=@agent-platform/runtime -- --run attachment-config-resolver` to verify

**Files Touched**:

- `apps/runtime/src/attachments/attachment-config-resolver.ts` — add field to interface + defaults + pick call
- `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts` — add 1 test case

**Exit Criteria**:

- [ ] `ResolvedAttachmentConfig` interface includes `defaultProcessingMode: 'full' | 'metadata_only' | 'skip'`
- [ ] `PLATFORM_DEFAULTS.defaultProcessingMode === 'full'`
- [ ] All 8 resolver unit tests pass (7 existing + 1 new)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] GET `/api/projects/:projectId/attachment-config` returns `resolved.defaultProcessingMode === 'full'` when no override exists

**Test Strategy**:

- Unit: New test case in `attachment-config-resolver.test.ts` for `defaultProcessingMode` with project override and null fallthrough

**Rollback**: Revert the 3 additions (interface field, default value, pick call). Backward-compatible — removing the field from `resolved` response does not break any consumer.

---

### Phase 1: Studio Proxy Route

**Goal**: Create the Studio API proxy that forwards GET/PUT to the runtime attachment config endpoint.

**Tasks**:

1.1. Create `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` following the exact pattern from `apps/studio/src/app/api/projects/[id]/settings/route.ts`:

- Import: `NextRequest`, `NextResponse`, `createLogger`, `requireTenantAuth`, `isAuthError`, `requireProjectAccess`, `isAccessError`, `getRuntimeUrl`, `handleApiError`
- Logger: `createLogger('api:projects:attachment-config')`
- `RouteParams` type: `{ params: Promise<{ id: string }> }`
- `proxyToRuntime(request, ctx)`: auth → access → construct URL → forward headers (Authorization, X-Tenant-Id, Content-Type) → forward body for PUT → return `NextResponse.json(data, { status: res.status })`
- Error handler: `handleApiError(error, 'AttachmentConfig.proxy')`
- Export named `GET` and `PUT` functions

  1.2. Write proxy integration tests (INT-1 through INT-4) in `apps/studio/src/__tests__/attachment-config-proxy.test.ts`:

- INT-1: GET forwarding (mock auth, mock fetch, verify URL + headers + response)
- INT-2: PUT forwarding (mock auth, mock fetch, verify body + URL + response)
- INT-3: Auth required (requireTenantAuth returns 401 NextResponse, isAuthError returns true → fetch NOT called)
- INT-4: Project access required (requireProjectAccess returns 404 NextResponse, isAccessError returns true → fetch NOT called)
- Use `vi.stubGlobal('fetch', vi.fn())` pattern for fetch mocking
- Mock `requireTenantAuth`, `requireProjectAccess`, `getRuntimeUrl` via `vi.mock`

  1.3. Run `pnpm build --filter=studio` and proxy tests to verify

**Files Touched**:

- `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` — NEW proxy route
- `apps/studio/src/__tests__/attachment-config-proxy.test.ts` — NEW integration tests

**Exit Criteria**:

- [ ] Proxy route file exists at correct path
- [ ] GET proxy forwards to `${getRuntimeUrl()}/api/projects/${projectId}/attachment-config` with Authorization and X-Tenant-Id headers
- [ ] PUT proxy forwards request body and returns runtime response
- [ ] Auth failure returns error response before reaching fetch
- [ ] Project access failure returns error response before reaching fetch
- [ ] All 4 proxy integration tests pass
- [ ] `pnpm build --filter=studio` succeeds with 0 errors

**Test Strategy**:

- Integration: INT-1 through INT-4 — mock auth helpers and global fetch, verify proxy forwarding behavior

**Rollback**: Delete the route file. No other code depends on it yet.

---

### Phase 2: Navigation Wiring + AttachmentSettingsTab Component + i18n

**Goal**: Wire the `settings-attachments` page into Studio's navigation and build the full settings tab component with form fields, validation, save/reset, and all i18n keys. Navigation and component are merged into one phase to avoid deploying a broken placeholder.

**Tasks**:

**Navigation wiring:**

2.1. In `apps/studio/src/store/navigation-store.ts`:

- Add `'settings-attachments'` to `ProjectPage` type union (~L34, between `'settings-auth-profiles'` and `'transfer-sessions'`)
- Add `'attachments': 'settings-attachments'` to `settingsSubPages` record (~L185)
- Add `'settings-attachments': 'attachments'` to `settingsPageMap` record (~L338)

  2.2. In `apps/studio/src/components/navigation/ProjectSidebar.tsx`:

- Add `Paperclip` to the lucide-react import
- Add `'settings-attachments'` to the settings group `pages` array (before `'settings-trace-dimensions'`)
- Add nav item to `items` array (after pii-protection): `{ id: 'settings-attachments', Icon: Paperclip, key: 'attachments' }` (same `section` as pii-protection: "Security & Observability")

  2.3. Add i18n key for sidebar: Add `"attachments": "Attachments"` to the nav section of `packages/i18n/locales/en/studio.json` (~L137, after `"auth_profiles"`)

**i18n keys + Component + AppShell wiring:**

2.4. Add i18n keys to `packages/i18n/locales/en/studio.json`:

- `settings.tabs.attachments` — for tab group label (add entry in `settings.tabs` object)
- `settings.attachments.title` — "Attachment Settings"
- `settings.attachments.description` — "Configure file upload behavior for this project."
- `settings.attachments.save` — "Save Changes"
- `settings.attachments.saved` — "Attachment settings saved"
- `settings.attachments.save_failed` — "Failed to save attachment settings"
- `settings.attachments.load_failed` — "Failed to load attachment settings"
- `settings.attachments.field_enabled` — "Enable Attachments"
- `settings.attachments.field_enabled_description` — "Allow file uploads in chat sessions."
- `settings.attachments.field_max_file_size` — "Maximum File Size"
- `settings.attachments.field_max_file_size_description` — "Maximum file size per upload."
- `settings.attachments.field_max_file_size_unit` — "MB"
- `settings.attachments.field_allowed_mime_types` — "Allowed File Types"
- `settings.attachments.field_allowed_mime_types_description` — "MIME types allowed for upload."
- `settings.attachments.field_allowed_mime_types_add` — "Add MIME type..."
- `settings.attachments.field_pii_policy` — "PII Policy"
- `settings.attachments.field_pii_policy_description` — "How to handle PII detected in attachments."
- `settings.attachments.field_processing_mode` — "Default Processing Mode"
- `settings.attachments.field_processing_mode_description` — "How newly uploaded files are processed."
- `settings.attachments.field_max_files_per_session` — "Max Files Per Session"
- `settings.attachments.field_max_files_per_session_description` — "Maximum number of files per session (read-only)."
- `settings.attachments.indicator_inherited` — "Inherited from defaults"
- `settings.attachments.indicator_override` — "Custom override"
- `settings.attachments.reset_to_default` — "Reset to default"
- `settings.attachments.validation_mime_format` — "Invalid MIME type format (e.g., image/png)"
- `settings.attachments.validation_mime_duplicate` — "Duplicate MIME type"
- `settings.attachments.validation_mime_cap` — "Maximum 50 MIME types allowed"
- Dropdown option labels:
- `settings.attachments.pii_redact` — "Redact"
- `settings.attachments.pii_block` — "Block"
- `settings.attachments.pii_allow` — "Allow"
- `settings.attachments.processing_full` — "Full"
- `settings.attachments.processing_metadata_only` — "Metadata Only"
- `settings.attachments.processing_skip` — "Skip"
- Accessibility labels:
- `settings.attachments.aria_toggle_enabled` — "Toggle attachments enabled"
- `settings.attachments.aria_reset_field` — "Reset {field} to default"
- `settings.attachments.aria_remove_mime` — "Remove MIME type {type}"
- `settings.attachments.aria_add_mime` — "Add MIME type"

  2.5. Create `apps/studio/src/components/settings/AttachmentSettingsTab.tsx`:

**Component structure:**

- `export function AttachmentSettingsTab()` — named export (matches all existing settings tabs)
- Uses `useNavigationStore()` → `projectId`
- Uses `useTranslations('settings.attachments')` for i18n
- State: `isLoading`, `isSaving`, `isDirty`, `formState` (AttachmentFormState), `initialState` (snapshot for dirty tracking), `overrides` (projectOverrides from API), `mimeInputValue`, `mimeInputError`

**Load pattern (following TraceDimensionsTab):**

```typescript
const load = useCallback(async () => {
  if (!projectId) return;
  setIsLoading(true);
  try {
    const res = await apiFetch(`/api/projects/${projectId}/attachment-config`);
    if (res.ok) {
      const { data } = await res.json();
      const state = mapResponseToFormState(data.resolved);
      setFormState(state);
      setInitialState(state);
      setOverrides(data.projectOverrides);
    } else {
      toast.error(t('load_failed'));
    }
  } catch {
    toast.error(t('load_failed'));
  } finally {
    setIsLoading(false);
  }
}, [projectId]); // t is stable in next-intl, matches existing tabs (TraceDimensionsTab, PIIProtectionTab)
```

**Save pattern:**

```typescript
const save = async () => {
  if (!projectId || !isDirty || isSaving) return;
  setIsSaving(true);
  try {
    const body = computeDiff(initialState, formState); // Only changed fields
    const res = await apiFetch(`/api/projects/${projectId}/attachment-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const { data } = await res.json();
      const state = mapResponseToFormState(data.resolved);
      setFormState(state);
      setInitialState(state);
      setOverrides(data.projectOverrides);
      setIsDirty(false);
      toast.success(t('saved'));
    } else {
      const errorData = await res.json().catch(() => ({}));
      toast.error(errorData.error?.message || t('save_failed'));
    }
  } catch {
    toast.error(t('save_failed'));
  } finally {
    setIsSaving(false);
  }
};
```

**Reset-to-default pattern:**

- Component maintains `pendingNulls: PendingNulls` state (a `Set<string>`)
- `resetField(fieldName)` adds `fieldName` to `pendingNulls`, sets `formState[fieldName]` to the resolved default (from `initialState` where override was null), and marks dirty
- `computeDiff(initialState, formState, pendingNulls)`:
  - For each field in `pendingNulls`: include `{ fieldName: null }` in the PUT body
  - For each field NOT in `pendingNulls`: include only if value differs from `initialState`
  - This distinguishes "field unchanged" (omit) from "field reset to default" (send null)
- On successful save: clear `pendingNulls`

**Override detection:**

- A field is overridden if `overrides !== null && overrides[fieldName] !== null && overrides[fieldName] !== undefined`
- Show "Custom override" badge + reset icon for overridden fields
- Show "Inherited from defaults" for non-overridden fields
  - `maxFilesPerSession` always shows "Inherited" — it has no project-level override field, so its override status cannot be detected from `projectOverrides`

**MIME validation:**

- Regex: `MIME_PATTERN` (`/^[a-z]+\/([\w.+-]+|\*)$/`)
- Duplicate check against current list (case-sensitive)
- Max `MAX_MIME_ENTRIES` (50) entries check
- On validation failure: set `mimeInputError`, do NOT add chip

**File size MB conversion:**

- Display: `formState.maxFileSizeBytes / BYTES_PER_MB` → show with up to 2 decimal places
- Input: user enters MB value → store as `value * BYTES_PER_MB` in `maxFileSizeBytes`
- Edge case: `0 MB` is valid input mapping to `maxFileSizeBytes: 0` (Zod allows `min(0)`)

**UI layout** (from feature spec wireframe §6):

- Header: icon + title + description + Save button (disabled when not dirty or saving)
- Section "General": enabled toggle
- Section "Upload Limits": maxFileSizeBytes (MB input), allowedMimeTypes (chip editor)
- Section "Processing": piiPolicy (select), defaultProcessingMode (select)
- Section "Info": maxFilesPerSession (read-only display)
- Each field: label, description, input control, override/inherited indicator, optional reset button

  2.6. In `apps/studio/src/components/navigation/AppShell.tsx`:

- Add import: `import { AttachmentSettingsTab } from '../settings/AttachmentSettingsTab';`
- Add `case 'settings-attachments': return <AttachmentSettingsTab />;` in the settings switch block (before `default:`)

  2.7. Write unit tests — `apps/studio/src/__tests__/attachment-settings-tab.test.tsx` (UT-0 through UT-13):

- Mock `apiFetch`, `useNavigationStore`, `sonner` toast
- Mock `next-intl` using the real translation pattern from test setup
- UT-0: Navigation wiring renders component
- UT-1: Loading spinner while fetching
- UT-2: All config fields rendered with resolved values
- UT-3: "Inherited from defaults" for non-overridden fields
- UT-4: "Custom override" badge for overridden fields
- UT-5 through UT-10: Individual field interaction tests
- UT-11: Save button disabled when clean
- UT-12: Save button enabled when dirty
- UT-13: maxFilesPerSession read-only

  2.8. Write unit tests — `apps/studio/src/__tests__/attachment-settings-save.test.tsx` (UT-14 through UT-22):

- UT-14: Save sends PUT with only changed fields
- UT-15: Reset sends null for field
- UT-16: MIME format validation rejects invalid
- UT-17: MIME format validation accepts valid
- UT-18: 50 MIME cap enforced
- UT-19: Success toast on save
- UT-20: Error toast on failure
- UT-21: Form retains state on save failure
- UT-22: Duplicate MIME rejected

  2.9. Run `pnpm build --filter=studio` and `pnpm test --filter=studio -- --run attachment-settings` to verify all unit tests pass

**Files Touched**:

- `apps/studio/src/store/navigation-store.ts` — 3 additions (type + 2 maps)
- `apps/studio/src/components/navigation/ProjectSidebar.tsx` — add icon import + pages + items entry
- `apps/studio/src/components/navigation/AppShell.tsx` — add import + switch case
- `packages/i18n/locales/en/studio.json` — add nav key + settings.tabs + ~35 i18n keys
- `apps/studio/src/components/settings/AttachmentSettingsTab.tsx` — NEW component
- `apps/studio/src/__tests__/attachment-settings-tab.test.tsx` — NEW unit tests
- `apps/studio/src/__tests__/attachment-settings-save.test.tsx` — NEW unit tests

**Exit Criteria**:

- [ ] `ProjectPage` type includes `'settings-attachments'`
- [ ] URL `/projects/:id/settings/attachments` resolves to page `'settings-attachments'`
- [ ] Sidebar shows "Attachments" item with Paperclip icon in "Security & Observability" section
- [ ] AppShell renders `AttachmentSettingsTab` when page is `'settings-attachments'`
- [ ] AttachmentSettingsTab renders all 6 fields (5 editable + 1 read-only)
- [ ] Override/inherited indicators display correctly based on `projectOverrides`
- [ ] Save button enables only when form is dirty
- [ ] Save sends PUT with only changed fields (uses `pendingNulls` for reset tracking)
- [ ] Reset sets field to null in the save payload via `pendingNulls` set
- [ ] MIME validation rejects invalid format, duplicates, and >50 entries
- [ ] File size input shows MB (using `BYTES_PER_MB` constant), stores bytes; 0 MB is valid
- [ ] All 23 unit tests pass (UT-0 through UT-22)
- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] `pnpm build --filter=@agent-platform/i18n` succeeds with 0 errors
- [ ] All i18n keys are present including dropdown options and aria-labels

**Test Strategy**:

- Unit: UT-0 through UT-22 — mock apiFetch, verify component behavior in isolation

**Rollback**: Delete `AttachmentSettingsTab.tsx` and test files. Revert navigation-store, ProjectSidebar, AppShell, and i18n additions. All changes are additive.

---

### Phase 3: E2E & Integration Tests

**Goal**: Write E2E tests for the runtime API and integration tests for Zod validation/upsert behavior.

**Tasks**:

3.1. Create `apps/runtime/src/__tests__/attachment-config.e2e.test.ts` (E2E-1 through E2E-8):

- Use `RuntimeApiHarness` with `MongoMemoryServer` for real HTTP + real DB
- E2E-1: View default config (no overrides) — verify 17 MIME types, platform defaults
- E2E-2: Override single field and verify persistence (PUT → GET round-trip)
- E2E-3: Reset field to default (null fallthrough)
- E2E-4: Config change affects upload behavior (disable → upload blocked → re-enable → upload works)
- E2E-5: Permission gating (read vs write) — two users with different roles
- E2E-6: Falsy-but-valid overrides persist (`enabled: false`, `maxFileSizeBytes: 0`, `allowedMimeTypes: []`)
- E2E-7: Tenant config fallback (3-tier resolution with seeded `TenantAttachmentConfig`)
- E2E-8: Cross-tenant isolation (Tenant B → Tenant A's project → 404)
- EXCEPTION: E2E-7 seeds `TenantAttachmentConfig` via direct model insert (no API route exists). Use `afterEach` cleanup to prevent tenant config leaking into other scenarios.
- All other data operations via HTTP API only
- **Router mounting**: E2E-4 requires the full upload path — mount `attachmentConfigRouter`, `attachmentsRouter`, `sessionsRouter`, and auth routers. Study `attachment-tools.e2e.test.ts` for the route mounting pattern. Alternatively, use `startRuntimeServerHarness()` for full-server coverage.

  3.2. Create `apps/runtime/src/__tests__/attachment-config-validation.test.ts` (INT-5 through INT-8):

- Use `RuntimeApiHarness` with `MongoMemoryServer`
- INT-5: Zod rejects invalid body (6 cases: bad enum, negative, non-integer, empty string, wrong processing mode enum)
- INT-6: Zod accepts valid edge cases (6 cases: null, empty array, zero, empty body, unknown fields stripped)
- INT-7: Config upsert creates and updates document (first PUT creates, second PUT updates, previous overrides preserved)
- INT-8: Resolver falls through null fields to tenant config (real DB)

  3.3. Run `pnpm build --filter=@agent-platform/runtime` and `pnpm test --filter=@agent-platform/runtime -- --run attachment-config-e2e` and `--run attachment-config-validation` to verify

**Files Touched**:

- `apps/runtime/src/__tests__/attachment-config.e2e.test.ts` — NEW E2E tests
- `apps/runtime/src/__tests__/attachment-config-validation.test.ts` — NEW integration tests

**Exit Criteria**:

- [ ] All 8 E2E tests pass (E2E-1 through E2E-8)
- [ ] All 4 integration tests pass (INT-5 through INT-8)
- [ ] `resolved.defaultProcessingMode` is returned correctly in all E2E scenarios
- [ ] Cross-tenant access returns 404 (not 403)
- [ ] Config disable → upload blocked → re-enable → upload works
- [ ] Falsy-but-valid values (`false`, `0`, `[]`) persist and resolve correctly
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors

**Test Strategy**:

- E2E: Real Express server, real MongoDB (MongoMemoryServer), real middleware chain, HTTP API only
- Integration: Real server + DB for Zod validation and MongoDB upsert behavior

**Rollback**: Delete the two test files. No production code affected.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] N/A — New service registered in DI container / module exports (no new services)
- [x] N/A — New routes registered in router file (Next.js file-based routing, auto-discovered)
- [x] N/A — New models added to `packages/database/src/models/index.ts` (no new models)
- [x] N/A — New types exported from package index (types are local to component)
- [x] N/A — New middleware added to middleware chain (no new middleware)
- [x] N/A — New workers registered in worker startup (no workers)
- [ ] **UI component imported and rendered in AppShell.tsx** — `import { AttachmentSettingsTab } from '../settings/AttachmentSettingsTab'` + `case 'settings-attachments': return <AttachmentSettingsTab />`
- [ ] **Navigation store: `ProjectPage` type** — add `'settings-attachments'` to union
- [ ] **Navigation store: `settingsSubPages`** — add `'attachments': 'settings-attachments'`
- [ ] **Navigation store: `settingsPageMap`** — add `'settings-attachments': 'attachments'`
- [ ] **ProjectSidebar: settings group** — add to `pages` array and `items` array with `Paperclip` icon
- [ ] **i18n: nav key** — add `"attachments": "Attachments"` to nav namespace
- [ ] **i18n: settings keys** — add `settings.tabs.attachments` and `settings.attachments.*` namespace
- [x] N/A — New API endpoints documented in OpenAPI spec (no OpenAPI spec for Studio proxy routes)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. Uses existing `project_attachment_configs` collection. GAP-002 changes only the resolver code, not the MongoDB schema.

### Feature Flags

None. All existing settings tabs ship unconditionally. This is admin-only and purely additive.

### Configuration Changes

No new environment variables, config keys, or runtime configuration. Uses existing `RUNTIME_URL` for proxy routing.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases (0, 1, 2, 3) complete with exit criteria met
- [ ] E2E tests passing: 8 scenarios (E2E-1 through E2E-8) — `apps/runtime/src/__tests__/attachment-config.e2e.test.ts`
- [ ] Integration tests passing: 8 scenarios (INT-1 through INT-8) — proxy (4) + runtime validation (4)
- [ ] Unit tests passing: 23 scenarios (UT-0 through UT-22) — component (14) + save/validation (9)
- [ ] Resolver unit tests passing: 8 tests (7 existing + 1 new for `defaultProcessingMode`)
- [ ] `pnpm build` succeeds with 0 errors across all packages
- [ ] `pnpm test` succeeds with 0 regressions in existing tests
- [ ] No regressions in existing settings tabs (build + existing tests pass)
- [ ] Coverage matrix in test spec: all 10 FRs have at least one test at the appropriate level
- [ ] Feature spec status updated from PLANNED to ALPHA after implementation
- [ ] GAP-002 status updated from Open to Mitigated

---

## 7. Open Questions

1. **MIME autocomplete**: Should the chip editor offer autocomplete from common MIME types? Currently implementing format validation only. Autocomplete can be added as a follow-up enhancement.
2. **File size edge cases**: For non-round MB values from the API (e.g., 5,242,880 bytes = 5 MB exactly, but what about 3,145,728 = 3 MB?), the display shows up to 2 decimal places. Need to verify the conversion handles all cases cleanly.
3. **Permission-gated visibility**: The HLD notes `attachment:read/write` is only available to admins (via `*:*` wildcard). Should the sidebar item be hidden for non-admins, or shown with a "no permission" state? Currently deferring to runtime error handling — the 403 response will trigger an error toast.

---

## 8. Test Spec Alignment Notes

The following test spec items need updating during implementation to align with LLD decisions:

1. **UT-6 (bytes → MB)**: Test spec UT-6 describes "User types '10485760' in the file size input" (raw bytes). Per LLD decision D-3, the input is in MB — user types "10" and the component stores 10*1024*1024 bytes internally. Update UT-6 during implementation.
2. **E2E-1 (defaultProcessingMode)**: After Phase 0, `resolved.defaultProcessingMode` is added to the response. E2E-1's expected result should include `resolved.defaultProcessingMode === 'full'`. E2E-2 step 6 ("all other resolved fields still equal platform defaults") should explicitly include it. Update during implementation.
3. **i18n count**: Feature spec §13 task 4.1 says "~25 i18n keys" — actual count is ~38 after dropdown options and aria-labels. Update during post-impl-sync.
