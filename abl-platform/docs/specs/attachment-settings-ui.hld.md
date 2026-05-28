# HLD: Studio Attachment Settings UI

**Feature Spec**: `docs/features/sub-features/attachment-settings-ui.md`
**Test Spec**: `docs/testing/sub-features/attachment-settings-ui.md`
**Parent HLD**: `docs/specs/attachments.hld.md`
**Status**: APPROVED
**Author**: Platform team
**Date**: 2026-03-22

---

## 1. Problem Statement

The ABL platform supports per-project attachment configuration (enable/disable, file type restrictions, size caps, PII policy, processing mode) via a 3-tier resolution system (project → tenant → platform defaults). However, this configuration is only accessible through raw HTTP calls to the runtime API. Project admins have no Studio UI to view, modify, or reset these settings.

This HLD designs the Studio frontend and API proxy layer needed to close GAP-001 from the parent Attachments feature spec. The backend (runtime API, config resolver, MongoDB models) already exists and is unchanged by this feature.

---

## 2. Alternatives Considered

### Option A: Direct apiFetch to Runtime (Proxy Pattern)

- **Description**: Add a Studio Next.js API route that proxies GET/PUT to the runtime's `/api/projects/:projectId/attachment-config` endpoint. The Studio UI component calls `apiFetch` which hits the Studio proxy, which forwards to the runtime. Auth is verified at both layers (Studio: tenant auth + project membership; Runtime: RBAC permissions).
- **Pros**: Follows the established pattern used by all existing Studio settings tabs (settings, runtime-config, trace-dimensions). No new infrastructure. Two-layer auth (defense in depth). Simple request-response proxy (~30 lines of code).
- **Cons**: Adds one HTTP hop (Studio → Runtime). Requires maintaining a thin proxy route.
- **Effort**: S (Small)

### Option B: SWR with Direct Runtime API Access

- **Description**: Studio UI calls the runtime API directly (via `NEXT_PUBLIC_RUNTIME_URL`) with SWR for caching and revalidation. No Studio proxy route needed.
- **Pros**: One fewer HTTP hop. SWR provides auto-revalidation and cache.
- **Cons**: Breaks the established pattern — all existing settings tabs use `apiFetch` + proxy, none use SWR. Exposes runtime URL to the client. Loses the Studio-layer project membership check. CORS configuration needed for cross-origin runtime calls from the browser.
- **Effort**: S (Small)

### Option C: Zustand Store with API Sync

- **Description**: Create a dedicated Zustand store (`attachment-config-store.ts`) that manages the config state, handles loading/saving, and syncs with the API. UI component reads from store instead of managing local state.
- **Pros**: Centralized state management. Could be reused if other components need config access. Enables optimistic updates.
- **Cons**: Over-engineered for a single settings page. No existing settings tab uses Zustand for API data — they all use local `useState`. Adds unnecessary complexity and a new store file. The config is only needed on the settings page, not globally.
- **Effort**: M (Medium)

### Recommendation: Option A (Direct apiFetch + Proxy Pattern)

**Rationale**: Option A follows the established pattern used by all 11 existing Studio settings tabs. Consistency reduces cognitive load for developers maintaining the codebase. The extra HTTP hop is negligible for a settings page (single GET on load, single PUT on save). The two-layer auth (Studio proxy + Runtime RBAC) provides defense in depth. Option B violates the Studio proxy convention and creates CORS issues. Option C is over-engineered for a read-modify-save settings form.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                   Browser (Project Admin)                  │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │     AttachmentSettingsTab (React Component)          │  │
│  │     ┌──────────┐  ┌──────────┐  ┌──────────────┐   │  │
│  │     │ Toggle    │  │ Select   │  │ Chip Editor  │   │  │
│  │     │ (enabled) │  │ (policy) │  │ (MIME types) │   │  │
│  │     └──────────┘  └──────────┘  └──────────────┘   │  │
│  │            │              │              │           │  │
│  │            └──────────────┴──────────────┘           │  │
│  │                       apiFetch                       │  │
│  └────────────────────────┬────────────────────────────┘  │
└───────────────────────────┼────────────────────────────────┘
                            │ GET/PUT /api/projects/[id]/attachment-config
                            ▼
┌──────────────────────────────────────────────────────────┐
│              Studio (Next.js, port 5173)                   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │   API Route: /api/projects/[id]/attachment-config    │  │
│  │   1. requireTenantAuth(request)                      │  │
│  │   2. requireProjectAccess(projectId, user)           │  │
│  │   3. fetch(runtimeUrl + path, { headers })           │  │
│  └────────────────────────┬────────────────────────────┘  │
└───────────────────────────┼────────────────────────────────┘
                            │ GET/PUT /api/projects/:projectId/attachment-config
                            │ Headers: Authorization, X-Tenant-Id, Content-Type
                            ▼
┌──────────────────────────────────────────────────────────┐
│              Runtime (Express, port 3112)                   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │   Route: attachment-config.ts (EXISTING)             │  │
│  │   Auth: authMiddleware + requireProjectScope         │  │
│  │   GET: requireProjectPermission('attachment:read')   │  │
│  │        → resolveAttachmentConfig(tenantId, projectId)│  │
│  │        → Return { resolved, projectOverrides }       │  │
│  │   PUT: requireProjectPermission('attachment:write')  │  │
│  │        → Zod validate → findOneAndUpdate (upsert)    │  │
│  │        → Re-resolve → Return updated config          │  │
│  └────────────────────────┬────────────────────────────┘  │
└───────────────────────────┼────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│                  MongoDB (EXISTING)                        │
│   project_attachment_configs  { tenantId, projectId, ... } │
│   tenant_attachment_configs   { tenantId, ... }            │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
apps/studio/src/
├── app/api/projects/[id]/attachment-config/
│   └── route.ts                    ← NEW: Proxy route (GET + PUT)
├── components/
│   ├── navigation/
│   │   ├── AppShell.tsx            ← MODIFY: Add render case
│   │   └── ProjectSidebar.tsx      ← MODIFY: Add nav item
│   └── settings/
│       └── AttachmentSettingsTab.tsx ← NEW: Settings tab component
├── store/
│   └── navigation-store.ts         ← MODIFY: Add page type + URL mappings
packages/i18n/locales/en/
└── studio.json                     ← MODIFY: Add ~25 i18n keys
```

### Data Flow

**Load (GET):**

1. User navigates to Settings > Attachments in Studio sidebar
2. `navigation-store` sets page to `'settings-attachments'`
3. `AppShell.renderContent()` matches case → renders `<AttachmentSettingsTab />`
4. Component `useEffect` fires `load()`:
   - `apiFetch(`/api/projects/${projectId}/attachment-config`)` with auto-injected auth headers
5. Studio proxy route:
   - `requireTenantAuth(request)` — extracts user from JWT
   - `requireProjectAccess(projectId, user)` — verifies membership
   - `fetch(runtimeUrl + path)` — forwards with `Authorization`, `X-Tenant-Id`, `Content-Type`
6. Runtime route:
   - `authMiddleware` + `requireProjectPermission('attachment:read')`
   - `resolveAttachmentConfig(tenantId, projectId)` — parallel DB queries → 3-tier merge
   - Returns `{ success: true, data: { resolved, projectOverrides } }`
7. Component receives response, populates form fields with `resolved` values, computes override indicators by diffing `projectOverrides` against `null`. Note: `maxFilesPerSession` is present in `resolved` but has no corresponding field in the PUT Zod schema — the component renders it as read-only (informational).

**Save (PUT):**

1. User modifies fields → component tracks dirty state
2. User clicks "Save Changes"
3. Component computes diff: only fields that differ from initial state are included
4. `apiFetch(`/api/projects/${projectId}/attachment-config`, { method: 'PUT', body })` — body contains only changed fields (e.g., `{ piiPolicy: 'block' }`)
5. Same proxy flow as GET, but with PUT method and request body
6. Runtime validates via Zod, upserts via `findOneAndUpdate`, re-resolves config
7. Component receives updated `{ resolved, projectOverrides }`, refreshes form, shows success toast

**Reset to Default:**

1. User clicks reset icon (⟲) on an overridden field
2. Component sets the field's pending value to `null`
3. On save, PUT body includes `{ fieldName: null }` — Zod accepts nullable fields
4. Runtime stores `null` in MongoDB → resolver's `pick()` function falls through to tenant/platform default
5. Response shows the inherited default value; component shows "Inherited from defaults" indicator

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Two layers: Studio proxy verifies project membership via `requireProjectAccess(projectId, user)` (user must be in the tenant's project). Runtime route explicitly includes `tenantId` in all DB queries via `findOne({ projectId, tenantId })` as the primary isolation mechanism; the `tenantIsolationPlugin` on the Mongoose model provides an additional defense-in-depth layer. Cross-tenant access returns 404 (not 403) via `findProjectByIdAndTenant()` in `requireProjectPermission`.                                                                                                                                                                                                                                                                                                                            |
| 2   | **Data Access Pattern** | No new data access layer. The Studio proxy is a thin HTTP forwarder (no DB access). The Runtime uses the existing `ProjectAttachmentConfig` Mongoose model with `findOne` and `findOneAndUpdate`. The `attachment-config-resolver` performs parallel `Promise.all` DB queries with the null-aware `pick()` merge function. All data access is through existing, tested code.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3   | **API Contract**        | **Studio proxy**: `GET /api/projects/[id]/attachment-config` → `{ success, data: { resolved, projectOverrides } }`. `PUT /api/projects/[id]/attachment-config` with JSON body → same response shape. **Error envelope**: `{ success: false, error: { code, message } }` with standard HTTP status codes (400, 401, 403, 404, 500). No new API versioning — the Studio proxy is a transparent passthrough to the existing runtime API.                                                                                                                                                                                                                                                                                                                                                                                    |
| 4   | **Security Surface**    | Auth: `requireTenantAuth` (JWT verification) + `requireProjectAccess` (membership) at Studio layer; `authMiddleware` + `requireProjectPermission('attachment:read/write')` at Runtime layer. **Access restriction**: `attachment:read/write` permissions are not explicitly assigned to any role — they are only available to project admins (via `*:*` wildcard), project owners, and tenant admins (via `project:*`). Developers and viewers get 403. The UI should handle this gracefully (hide the sidebar item or show a "no permission" state). Input validation: Zod schema at Runtime for all PUT payloads. MIME type format regex and 50-entry cap enforced at UI layer only (known gap — not security-critical for admin-only endpoint). No secrets handled. No SSRF risk (proxy URL is server-side constant). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **UI errors**: Loading failure → error toast + empty state (user can retry). Save failure → error toast + form retains unsaved changes (UT-20, UT-21). Validation failure → inline field error message (MIME format, 50-cap, duplicate). **Proxy errors**: Runtime unreachable → `handleApiError` returns 500 with `INTERNAL_ERROR` (matches existing proxy pattern). Auth failure → 401/404 passthrough from runtime. |
| 6   | **Failure Modes** | **Runtime down**: Studio proxy `fetch` fails → `handleApiError` catches and returns 500 `INTERNAL_ERROR`. UI shows error toast. Config remains as-is in MongoDB. **MongoDB down**: Runtime route catch block returns 500. UI shows error toast. No partial writes possible (single-document upsert is atomic). **Network timeout**: Standard `fetch` timeout (no custom timeout needed for a settings page).           |
| 7   | **Idempotency**   | GET is naturally idempotent. PUT is idempotent — `findOneAndUpdate` with `$set` + `upsert: true` produces the same result regardless of how many times it's called with the same body. No dedup strategy needed. No optimistic locking (`_v` field exists but is not checked — last write wins, acceptable for low-frequency admin operations).                                                                        |
| 8   | **Observability** | Runtime route already logs via `createLogger('attachment-config-route')` — `log.info` on successful PUT, `log.error` on failures. Studio proxy follows existing pattern: `createLogger('api:projects:attachment-config')` + `handleApiError` for error logging. No new trace events — the settings page is a simple CRUD UI. Debug: existing `debug_diagnose` MCP tool can inspect config resolution if needed.        |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Single GET on page load (~50ms runtime + ~20ms proxy overhead). Single PUT on save (same latency). No polling, streaming, or WebSocket. Payload size: GET response is ~500 bytes (resolved config + overrides). PUT body is ~100 bytes (only changed fields). Config resolver uses `Promise.all` for parallel DB queries (already optimized). No caching needed — admin settings page with infrequent access.                                                                                                                                                                                                                                                                                                     |
| 10  | **Migration Path**     | No migration needed. The `ProjectAttachmentConfig` collection and model already exist. The proxy route and UI component are purely additive. The only prerequisite code change is GAP-002: add `defaultProcessingMode` to the resolver's `ResolvedAttachmentConfig` interface and `PLATFORM_DEFAULTS` constant (~5 lines of code in `attachment-config-resolver.ts`).                                                                                                                                                                                                                                                                                                                                             |
| 11  | **Rollback Plan**      | **Full rollback**: Remove new files (proxy route + component), revert additive changes to `navigation-store.ts`, `AppShell.tsx`, `ProjectSidebar.tsx`, `studio.json`. Backend untouched — any config changes made via the UI persist and remain accessible via direct API. The GAP-002 resolver change is backward-compatible and can be left in place. **Blast radius**: Only affects the "Settings > Attachments" tab — no impact on other settings tabs, attachment uploads, or agent execution.                                                                                                                                                                                                               |
| 12  | **Test Strategy**      | **Unit (23 tests)**: Component rendering, form interactions, MIME validation, toast notifications, dirty tracking — via vitest + React Testing Library + happy-dom. Mock `apiFetch` for API calls. **Integration (8 tests)**: Studio proxy forwarding (mock auth + fetch), runtime Zod validation and upsert (real MongoMemoryServer via RuntimeApiHarness). **E2E (8 tests)**: Full runtime API round-trips — config CRUD, permission gating, cross-tenant isolation, 3-tier resolution, falsy-but-valid persistence, config→upload behavioral verification. All E2E tests use real HTTP API, real MongoDB, real middleware chain. See `docs/testing/sub-features/attachment-settings-ui.md` for full test spec. |

---

## 5. Data Model

### New Collections/Tables

None. This feature does not create new collections.

### Modified Collections/Tables

No schema modifications. The existing `project_attachment_configs` collection is used as-is.

### Prerequisite: Resolver Extension (GAP-002)

The `ResolvedAttachmentConfig` interface in `attachment-config-resolver.ts` must be extended to include `defaultProcessingMode`:

```typescript
// Before (current)
interface ResolvedAttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
}

// After (with GAP-002 fix)
interface ResolvedAttachmentConfig {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip';
}
```

Add to `PLATFORM_DEFAULTS`:

```typescript
defaultProcessingMode: 'full',
```

Add `pick()` call in the resolver merge function for the new field.

### Key Relationships

```
ProjectAttachmentConfig (project_attachment_configs)
  ├── tenantId → Tenant (tenant isolation)
  ├── projectId → Project (project scope)
  └── resolved by attachment-config-resolver with:
      ├── TenantAttachmentConfig (tenant_attachment_configs) [same tenantId]
      └── PLATFORM_DEFAULTS (hardcoded constant)
```

---

## 6. API Design

### New Endpoints (Studio Proxy)

| Method | Path                                   | Purpose              | Auth                                         |
| ------ | -------------------------------------- | -------------------- | -------------------------------------------- |
| GET    | `/api/projects/[id]/attachment-config` | Proxy to runtime GET | `requireTenantAuth` + `requireProjectAccess` |
| PUT    | `/api/projects/[id]/attachment-config` | Proxy to runtime PUT | `requireTenantAuth` + `requireProjectAccess` |

### Existing Endpoints (Runtime — Unchanged)

| Method | Path                                         | Purpose                  | Auth                                                              |
| ------ | -------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/attachment-config` | Get resolved + overrides | `authMiddleware` + `requireProjectPermission('attachment:read')`  |
| PUT    | `/api/projects/:projectId/attachment-config` | Upsert project overrides | `authMiddleware` + `requireProjectPermission('attachment:write')` |

### Modified Endpoints

None. The runtime API is completely unchanged.

### Error Responses

| Status | Code                          | When                                                                                                                                                                                                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`            | PUT body fails Zod validation (runtime route handler)                                                                                                                                                                                             |
| 401    | `AUTHENTICATION_REQUIRED`     | Missing/invalid JWT (authMiddleware). Also `USER_ID_REQUIRED` if token has no userId (rbac).                                                                                                                                                      |
| 401    | `AUTH_REQUIRED`               | Token is valid but missing `tenantId` (route handler manual check at attachment-config.ts L52/L104)                                                                                                                                               |
| 403    | `PROJECT_MEMBERSHIP_REQUIRED` | Authenticated user is not a member of this project (rbac `evaluateProjectPermission`)                                                                                                                                                             |
| 403    | `PROJECT_PERMISSION_REQUIRED` | User is a project member but their role lacks `attachment:read` or `attachment:write` permission                                                                                                                                                  |
| 404    | `PROJECT_NOT_FOUND`           | Cross-tenant access: `findProjectByIdAndTenant()` in `requireProjectPermission` returns 404 when project does not exist for tenant. Also `PROJECT_SCOPE_MISMATCH` for API key scope violations. Returns 404 (not 403) per CLAUDE.md invariant #1. |
| 500    | `INTERNAL_ERROR`              | Runtime DB error (route catch block), or Studio proxy fetch failure (via `handleApiError`)                                                                                                                                                        |

Note: The Studio proxy passes through the runtime's error envelope as-is. Studio-layer errors (auth, project access) use `handleApiError` which returns 500 `INTERNAL_ERROR` for unhandled exceptions, or the appropriate status code from the auth/access helpers.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Not in scope for this phase (config change audit trail is listed as a non-goal). Runtime route logs `log.info('Project attachment config updated', { projectId, tenantId })` on successful PUT.
- **Rate Limiting**: Runtime route already applies `tenantRateLimit('request')` via middleware chain. No additional rate limiting needed at Studio proxy layer.
- **Caching**: Not needed. Admin settings page with infrequent access (est. <1 req/min per project). Config resolution already uses direct DB queries with no caching layer.
- **Encryption**: Data at rest uses standard MongoDB encryption (platform-level). Data in transit uses HTTPS (platform-level). No additional encryption for this feature. PII policy config values are not themselves PII.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                     | Type     | Risk                                      |
| ---------------------------------------------- | -------- | ----------------------------------------- |
| Runtime attachment-config API (GET/PUT)        | runtime  | None (exists, stable, unchanged)          |
| `attachment-config-resolver.ts`                | runtime  | Low (GAP-002 requires ~5-line extension)  |
| `ProjectAttachmentConfig` Mongoose model       | database | None (exists, unchanged)                  |
| Studio auth library (`requireTenantAuth`)      | studio   | None (stable, used by all proxy routes)   |
| Studio project access (`requireProjectAccess`) | studio   | None (stable, used by all project routes) |
| `navigation-store.ts` page type system         | studio   | Low (additive change to type union)       |
| `packages/i18n` English locale                 | i18n     | None (additive keys only)                 |

### Downstream (depends on this feature)

| Consumer                  | Impact                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Tenant admin config UI    | Future GAP-003 would follow the same pattern at tenant scope |
| Config change audit trail | Future audit feature would hook into the same PUT flow       |

---

## 9. Open Questions & Decisions Needed

1. **MIME autocomplete**: Should the chip editor offer autocomplete suggestions from a known list of common MIME types, or only validate format? The current design validates format only. Autocomplete would improve UX but adds complexity (curated MIME list, fuzzy matching).
2. **File size input UX**: Should the file size input use a raw numeric input (bytes), a numeric input with unit selector (MB/KB), or a preset dropdown (1 MB, 5 MB, 10 MB, 20 MB, 50 MB)? The feature spec shows "20 MB" display but doesn't specify the input mechanism.
3. **Safe proxy**: Should the Studio proxy use `safeJsonParse` from `@/lib/safe-proxy` for defensive upstream response parsing? The established pattern uses raw `res.json()`, but `safeJsonParse` would gracefully handle HTML error pages from the runtime during outages.

---

## 10. References

- Feature spec: `docs/features/sub-features/attachment-settings-ui.md`
- Test spec: `docs/testing/sub-features/attachment-settings-ui.md`
- Parent HLD: `docs/specs/attachments.hld.md`
- Runtime API: `apps/runtime/src/routes/attachment-config.ts`
- Config resolver: `apps/runtime/src/attachments/attachment-config-resolver.ts`
- Existing proxy pattern: `apps/studio/src/app/api/projects/[id]/settings/route.ts`
- Existing settings tab pattern: `apps/studio/src/components/settings/TraceDimensionsTab.tsx`
- Navigation store: `apps/studio/src/store/navigation-store.ts`
- AppShell: `apps/studio/src/components/navigation/AppShell.tsx`
