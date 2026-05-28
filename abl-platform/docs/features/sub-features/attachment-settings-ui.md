# Feature: Studio Attachment Settings UI

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Attachments](../attachments.md)
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `governance`, `customer experience`
**Package(s)**: `apps/studio`, `packages/i18n`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/attachment-settings-ui.md](../../testing/sub-features/attachment-settings-ui.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform supports per-project attachment configuration — enabling/disabling uploads, restricting file types, capping file sizes, and controlling PII policy — but this configuration is only accessible via raw HTTP calls to the runtime API (`PUT /api/projects/:projectId/attachment-config`). Project admins who want to customize attachment behavior for sensitive or regulated projects have no way to do so from the Studio UI.

This is tracked as **GAP-001** in the parent [Attachments feature spec](../attachments.md).

### Goal Statement

Add an "Attachments" settings tab to the Studio project settings page that lets project admins view the effective (resolved) attachment configuration, override specific fields at the project level, and reset overrides to inherit tenant/platform defaults — all without leaving the Studio UI.

### Summary

The Attachment Settings UI is a new tab in Studio's project settings that surfaces the existing 3-tier config resolution (project → tenant → platform defaults). It shows the effective value for each field, visually distinguishes overridden fields from inherited ones, and supports per-field reset to defaults. The backend API and resolver already exist — this feature adds only the Studio frontend and its API proxy route.

---

## 2. Scope

### Goals

- Provide a Studio settings tab for per-project attachment configuration
- Show both the resolved (effective) values and which fields have project-level overrides
- Support per-field "reset to default" (inherit from tenant/platform defaults)
- Follow existing Studio settings tab patterns (direct `apiFetch`, no SWR)
- Support i18n for all labels and descriptions

### Non-Goals (Out of Scope)

- Tenant-level admin config UI (tracked as GAP-003 in the parent feature)
- Attachment processing pipeline configuration (Tika, Whisper, ClamAV, FFmpeg toggles — these are multimodal-service env vars)
- Storage backend configuration (S3/local/MinIO — infrastructure config)
- DSL `ATTACHMENTS:` / `DESTINATIONS:` section editing (per-agent, not project config)
- Real-time preview of config changes on active sessions
- Bulk "reset all overrides" action (per-field reset is supported, but no single button to clear all overrides)
- Config change audit trail (who changed what and when — no history tracking in this phase)

---

## 3. User Stories

1. As a **project admin**, I want to disable file uploads for a project so that agents in that project cannot receive attachments.
2. As a **project admin**, I want to restrict allowed file types to PDFs and images so that agents only process relevant document types.
3. As a **project admin**, I want to set the PII policy to "block" for a compliance-sensitive project so that files containing PII are never sent to the LLM.
4. As a **project admin**, I want to see which attachment settings are inherited from defaults vs explicitly overridden so that I understand the effective configuration.
5. As a **project admin**, I want to reset a specific field to inherit from defaults so that I can undo a previous override without knowing the default value.
6. As a **project admin**, I want to set a maximum file size limit so that users cannot upload excessively large files that slow down processing.

---

## 4. Functional Requirements

1. **FR-1**: The system must display a "Settings > Attachments" tab in Studio project settings, accessible via sidebar navigation.
2. **FR-2**: The tab must load the resolved attachment config from the runtime API (`GET /api/projects/:projectId/attachment-config`) and display the effective value for each field.
3. **FR-3**: The tab must visually distinguish fields that have project-level overrides from fields that inherit tenant/platform defaults (e.g., badge, label, or icon).
4. **FR-4**: The tab must allow editing each configurable field:
   - `enabled` — toggle (on/off)
   - `maxFileSizeBytes` — numeric input with human-readable display (e.g., "20 MB")
   - `allowedMimeTypes` — chip/tag editor with MIME format validation
   - `piiPolicy` — select dropdown (Redact / Block / Allow)
   - `defaultProcessingMode` — select dropdown (Full / Metadata Only / Skip). Note: this field is NOT included in the resolver's `ResolvedAttachmentConfig` return type, so the UI must display the `projectOverrides` value when set, or "No default — not configured" when null (see GAP-002). Prerequisite task 0 extends the resolver.
   - `maxFilesPerSession` — displayed as read-only (informational) since it is returned in the resolved config but NOT editable at project level (only tenant-level `maxAttachmentsPerSession` feeds into it).
5. **FR-5**: The tab must support per-field "reset to default" that sends `null` for the field, causing it to inherit from the tenant/platform default.
6. **FR-6**: The tab must save changes via `PUT /api/projects/:projectId/attachment-config` and display the updated resolved config on success.
7. **FR-7**: The tab must show a toast notification on save success or failure.
8. **FR-8**: The tab must validate MIME types against the pattern `^[a-z]+/([\w.+-]+|\*)$` before saving.
9. **FR-9**: The tab must enforce a maximum of 50 MIME type entries.
10. **FR-10**: The Studio proxy route must verify project membership via `requireProjectAccess`. The runtime endpoint (proxied target) must require `attachment:read` permission to view and `attachment:write` permission to edit via `requireProjectPermission`. The Studio UI should not duplicate permission checks — it relies on the runtime's RBAC enforcement.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                            |
| -------------------------- | ------------ | ------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project-level config, not project creation       |
| Agent lifecycle            | NONE         | Does not affect agent compilation or deployment  |
| Customer experience        | SECONDARY    | Indirect — affects what files end users can send |
| Integrations / channels    | NONE         | Config applies to all channels uniformly         |
| Observability / tracing    | NONE         | No new trace events                              |
| Governance / controls      | PRIMARY      | PII policy, file type restrictions               |
| Enterprise / compliance    | SECONDARY    | Supports compliance configuration                |
| Admin / operator workflows | PRIMARY      | New settings page for project admins             |

### Related Feature Integration Matrix

| Related Feature                              | Relationship Type | Why It Matters                             | Key Touchpoints                                       | Current State |
| -------------------------------------------- | ----------------- | ------------------------------------------ | ----------------------------------------------------- | ------------- |
| [Attachments](../attachments.md)             | extends           | Parent feature — this adds the missing UI  | Config resolver, ProjectAttachmentConfig model        | ALPHA         |
| [Workspace Sharing](../workspace-sharing.md) | depends on        | RBAC determines who can access settings    | `requireProjectPermission('attachment:read/write')`   | STABLE        |
| PII Protection (settings tab)                | shares data with  | PII policy configured here, viewed in both | `piiPolicy` field in both attachment and PII settings | STABLE        |

---

## 6. Design Considerations

### UI Layout

The settings tab follows the standard Studio settings pattern:

```
┌─────────────────────────────────────────────────────────┐
│ Attachment Settings                                      │
│ Configure file upload behavior for this project.         │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌─ General ──────────────────────────────────────────┐  │
│ │ Enable Attachments                  [Toggle] ⟲     │  │
│ │ Allow file uploads in chat sessions.               │  │
│ │ ℹ Inherited from defaults                          │  │
│ └────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Upload Limits ────────────────────────────────────┐  │
│ │ Maximum File Size                   [20 MB  ▼] ⟲   │  │
│ │ Maximum file size per upload.                       │  │
│ │                                                     │  │
│ │ Allowed File Types                                  │  │
│ │ [image/jpeg ✕] [image/png ✕] [application/pdf ✕]   │  │
│ │ [+ Add MIME type...]                                │  │
│ │ ℹ Custom override (3 of 16 defaults)               │  │
│ └────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Processing ───────────────────────────────────────┐  │
│ │ PII Policy                          [Redact  ▼] ⟲  │  │
│ │ How to handle PII in attachments.                   │  │
│ │                                                     │  │
│ │ Default Processing Mode             [Full    ▼] ⟲  │  │
│ │ How newly uploaded files are processed.             │  │
│ └────────────────────────────────────────────────────┘  │
│                                                          │
│                              [Save Changes]              │
└─────────────────────────────────────────────────────────┘

⟲ = Reset to default (shown only for overridden fields)
```

### Visual Indicators

- **Inherited field**: Subtle text "Inherited from defaults" below the field
- **Overridden field**: Badge "Custom override" + reset icon (⟲) to revert to null
- **Dirty state**: Save button appears/enables only when changes are pending

---

## 7. Technical Considerations

### Backend Already Exists

The runtime API is complete:

- `GET /api/projects/:projectId/attachment-config` — Returns `{ resolved, projectOverrides }` (lines 45-91 of `attachment-config.ts`)
- `PUT /api/projects/:projectId/attachment-config` — Zod-validated upsert, returns updated resolved config (lines 97-160)
- Config resolver: 3-tier merge with null-aware `pick()` helper (`attachment-config-resolver.ts`)

### Studio Proxy Route

A new Next.js API route must proxy Studio requests to the runtime. Follow the `apps/studio/src/app/api/projects/[id]/settings/route.ts` pattern:

1. `requireTenantAuth(request)` — verify user
2. `requireProjectAccess(projectId, user)` — verify project membership
3. Forward to `${getRuntimeUrl()}/api/projects/${projectId}/attachment-config`

### Processing Mode Enum

The backend Zod schema uses `'full' | 'metadata_only' | 'skip'` for the config model's `defaultProcessingMode` field — the UI must match these exact values, not the plan's `'scan-only' | 'store-raw'`. Note: the attachment model has a separate `processingMode` field with a different enum (`'full' | 'scan-only' | 'store-raw'`). The config model controls the default for new uploads; the attachment model records the actual mode used per file. The UI operates on the config model only.

---

## 8. How to Consume

### Studio UI

Navigate to **Project Settings > Attachments** (sidebar). View and edit per-project attachment configuration. Changes take effect immediately for new uploads.

### API (Runtime)

| Method | Path                                         | Purpose                  |
| ------ | -------------------------------------------- | ------------------------ |
| GET    | `/api/projects/:projectId/attachment-config` | Get resolved + overrides |
| PUT    | `/api/projects/:projectId/attachment-config` | Upsert project overrides |

### API (Studio)

| Method | Path                                   | Purpose              |
| ------ | -------------------------------------- | -------------------- |
| GET    | `/api/projects/[id]/attachment-config` | Proxy to runtime GET |
| PUT    | `/api/projects/[id]/attachment-config` | Proxy to runtime PUT |

### Admin Portal

N/A — tenant-level config remains API-only (GAP-003).

### Channel / SDK / Voice / A2A / MCP Integration

N/A — this is a Studio-only settings page. The underlying config applies uniformly across all channels.

---

## 9. Data Model

### Collections / Tables

No new collections. Uses existing `ProjectAttachmentConfig`:

```text
Collection: project_attachment_configs (existing)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - enabled: boolean | null
  - maxFileSizeBytes: number | null
  - allowedMimeTypes: string[] | null
  - piiPolicy: 'redact' | 'block' | 'allow' | null
  - defaultProcessingMode: 'full' | 'metadata_only' | 'skip' | null
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1 } (unique)
```

### Key Relationships

- `ProjectAttachmentConfig` → resolved by `attachment-config-resolver.ts` with `TenantAttachmentConfig` and platform defaults
- `projectId` links to the project being configured
- `tenantId` ensures tenant isolation on all queries

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                             |
| ----------------------------------------------------------------- | ----------------------------------- |
| `apps/runtime/src/attachments/attachment-config-resolver.ts`      | 3-tier config resolution (existing) |
| `apps/runtime/src/routes/attachment-config.ts`                    | Runtime API routes (existing)       |
| `packages/database/src/models/project-attachment-config.model.ts` | Mongoose model (existing)           |

### Routes / Handlers

| File                                                               | Purpose                |
| ------------------------------------------------------------------ | ---------------------- |
| `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` | Studio API proxy (NEW) |

### UI Components

| File                                                            | Purpose                                  |
| --------------------------------------------------------------- | ---------------------------------------- |
| `apps/studio/src/components/settings/AttachmentSettingsTab.tsx` | Settings tab component (NEW)             |
| `apps/studio/src/store/navigation-store.ts`                     | Add `settings-attachments` page (MODIFY) |
| `apps/studio/src/components/navigation/ProjectSidebar.tsx`      | Add sidebar nav item (MODIFY)            |
| `apps/studio/src/components/navigation/AppShell.tsx`            | Add render case (MODIFY)                 |

### i18n

| File                                   | Purpose                       |
| -------------------------------------- | ----------------------------- |
| `packages/i18n/locales/en/studio.json` | Add settings.attachments keys |

### Tests

| File                                                              | Type        | Coverage Focus                                                        |
| ----------------------------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| `apps/studio/src/__tests__/attachment-settings-tab.test.tsx`      | unit        | Component rendering, state (14 tests: UT-0–UT-13)                     |
| `apps/studio/src/__tests__/attachment-settings-save.test.tsx`     | unit        | Save, reset, validation (9 tests: UT-14–UT-22)                        |
| `apps/studio/src/__tests__/attachment-config-proxy.test.ts`       | integration | Studio proxy GET/PUT forwarding, auth checks (4 tests)                |
| `apps/runtime/src/__tests__/attachment-config.e2e.test.ts`        | e2e         | Full round-trip via real Express + MongoDB (8 tests)                  |
| `apps/runtime/src/__tests__/attachment-config-validation.test.ts` | integration | Zod validation + resolver null-field fallthrough (14 tests)           |
| `apps/studio/e2e/attachment-settings-e2e.spec.ts`                 | browser e2e | UI interaction, indicators, MIME, reset, toast (6 tests: BRW-1–BRW-6) |

---

## 11. Configuration

### Environment Variables

No new environment variables. Uses existing `RUNTIME_URL` / `NEXT_PUBLIC_RUNTIME_URL` for proxy routing.

### Runtime Configuration

Uses the existing 3-tier config resolution:

1. **Project level**: `ProjectAttachmentConfig` — editable via this UI
2. **Tenant level**: `TenantAttachmentConfig` — read-only from this UI (no tenant admin UI yet)
3. **Platform defaults**: Hardcoded in `PLATFORM_DEFAULTS` constant

### DSL / Agent IR / Schema

N/A — project config is not DSL-level configuration.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Project isolation | Studio proxy verifies project membership via `requireProjectAccess`. Runtime route includes `projectId`. |
| Tenant isolation  | Runtime route uses `tenantId` from auth context. All DB queries include `tenantId`.                      |
| User isolation    | N/A — config is project-wide, not per-user. Access controlled by project role.                           |

### Security & Compliance

- Studio proxy route uses `requireTenantAuth` + `requireProjectAccess`
- Runtime route uses `authMiddleware` + `requireProjectPermission('attachment:read/write')`
- No secrets or credentials handled in this UI
- PII policy config helps satisfy compliance requirements (controlled from this page)

### Performance & Scalability

- Single GET on page load, single PUT on save — minimal API calls
- No polling, no WebSocket, no streaming
- Config resolution uses `Promise.all` for parallel DB queries (already optimized)

### Reliability & Failure Modes

- API proxy failure: display error toast, retain form state for retry
- Save failure: show error, do not clear unsaved changes
- Network timeout: standard fetch timeout applies

### Observability

- Runtime route already logs config reads and updates via `createLogger('attachment-config-route')`
- No additional trace events needed for the UI layer

### Data Lifecycle

- Config persists until explicitly changed or project deleted
- Project deletion cascades to `ProjectAttachmentConfig` (handled by existing cleanup)

---

## 13. Delivery Plan / Work Breakdown

0. **Prerequisite: Extend config resolver** (GAP-002)
   0.1 Add `defaultProcessingMode` to `ResolvedAttachmentConfig` interface in `attachment-config-resolver.ts`
   0.2 Add platform default value (e.g., `'full'`) to `PLATFORM_DEFAULTS`
   0.3 Add `pick()` call in resolver for the new field

1. **Studio API proxy route**
   1.1 Create `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts`
   1.2 Implement GET and PUT handlers proxying to runtime

2. **Navigation wiring**
   2.1 Add `'settings-attachments'` to `ProjectPage` type in `navigation-store.ts`
   2.2 Add URL mapping in `settingsSubPages` and `settingsPageMap`
   2.3 Add sidebar nav item in `ProjectSidebar.tsx`
   2.4 Add render case in `AppShell.tsx`

3. **AttachmentSettingsTab component**
   3.1 Scaffold component with loading state
   3.2 Implement config loading via `apiFetch` GET
   3.3 Implement form fields (toggle, number input, select, chip/tag editor)
   3.4 Implement resolved vs overridden visual indicators
   3.5 Implement per-field reset to default
   3.6 Implement save via `apiFetch` PUT with dirty tracking
   3.7 Implement MIME type validation (`^[a-z]+/([\w.+-]+|\*)$`) and 50-entry cap

4. **i18n keys**
   4.1 Add ~25 i18n keys to `packages/i18n/locales/en/studio.json`

5. **Tests**
   5.1 Unit tests for component rendering and state
   5.2 Unit tests for save, reset, and validation
   5.3 API-level E2E test: PUT config change via Studio proxy → GET via Studio proxy → verify resolved config reflects change. Covers FR-2, FR-5, FR-6. Browser-based E2E (Playwright/Cypress) deferred — tracked as GAP-003.

---

## 14. Success Metrics

| Metric                        | Baseline | Target | How Measured                          |
| ----------------------------- | -------- | ------ | ------------------------------------- |
| Projects with custom config   | 0%       | 20%    | Count of ProjectAttachmentConfig docs |
| Admin API calls for config    | 100%     | <20%   | Runtime access logs                   |
| Config save success rate      | N/A      | >95%   | Toast success/error ratio             |
| Time to configure attachments | ~5min    | <30s   | Estimated (API→UI improvement)        |

---

## 15. Open Questions

1. ~~Should the MIME type chip editor offer autocomplete suggestions from a known list of common types, or only validate format?~~ **Resolved**: Format validation only — chip editor with `^[a-z]+/([\w.+-]+|\*)$` pattern. Autocomplete deferred.
2. ~~Should the file size input use a slider, a numeric input with unit selector (MB/KB), or a preset dropdown?~~ **Resolved**: Numeric input displaying MB with automatic MB↔bytes conversion (`BYTES_PER_MB = 1024 * 1024`). Min value 1 MB enforced at form level.
3. ~~When the processing mode field has no platform default in the resolver, what should the UI show as the "inherited" value?~~ **Resolved**: GAP-002 fixed — resolver now includes `defaultProcessingMode` with platform default `'full'`. UI shows resolved value like all other fields.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                | Severity | Status   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| GAP-001 | No tenant-level admin config UI (GAP-003 in parent)                                                                                                        | Low      | Open     |
| GAP-002 | `defaultProcessingMode` not in resolver `ResolvedAttachmentConfig` — UI cannot show resolved/inherited value for this field without extending the resolver | High     | Resolved |
| GAP-003 | Playwright browser E2E tests added for Studio settings — 6 scenarios (BRW-1 through BRW-6) covering UI interaction, indicators, MIME, reset, toast         | Medium   | Resolved |
| GAP-004 | Server-side Zod validation: `.max(50)` for MIME array, 500 MB upper bound for maxFileSizeBytes, MIME format regex — defense-in-depth                       | Low      | Resolved |
| GAP-005 | `attachment:read` added to developer and viewer roles — non-admin roles can now view config but not write                                                  | Low      | Resolved |
| GAP-006 | E2E-9 proves disabling config blocks uploads (403 ATTACHMENTS_DISABLED) and re-enabling unblocks them                                                      | Medium   | Resolved |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                         | Coverage Type | Status  | Test File / Note                                                  |
| --- | -------------------------------- | ------------- | ------- | ----------------------------------------------------------------- |
| 1   | Tab renders with resolved config | unit          | PASSING | attachment-settings-tab.test.tsx (UT-0, UT-2)                     |
| 2   | Toggle enable/disable            | unit          | PASSING | attachment-settings-tab.test.tsx (UT-5)                           |
| 3   | Change max file size             | unit          | PASSING | attachment-settings-tab.test.tsx (UT-7)                           |
| 4   | Add/remove MIME types            | unit          | PASSING | attachment-settings-tab.test.tsx (UT-10, UT-11)                   |
| 5   | MIME type format validation      | unit          | PASSING | attachment-settings-save.test.tsx (UT-16, UT-17, UT-18, UT-22)    |
| 6   | Select PII policy                | unit          | PASSING | attachment-settings-tab.test.tsx (UT-8)                           |
| 7   | Select processing mode           | unit          | PASSING | attachment-settings-tab.test.tsx (UT-9)                           |
| 8   | Save changes (PUT request)       | unit          | PASSING | attachment-settings-save.test.tsx (UT-14)                         |
| 9   | Reset field to default           | unit          | PASSING | attachment-settings-save.test.tsx (UT-15)                         |
| 10  | Override vs inherited indicators | unit          | PASSING | attachment-settings-tab.test.tsx (UT-3, UT-4)                     |
| 11  | Loading state                    | unit          | PASSING | attachment-settings-tab.test.tsx (UT-1)                           |
| 12  | Error state (API failure)        | unit          | PASSING | attachment-settings-save.test.tsx (UT-20, UT-21)                  |
| 13  | Permission gating (read-only)    | e2e           | PASSING | attachment-config.e2e.test.ts (E2E-5: permission gating)          |
| 14  | Save → resolved config refreshes | e2e           | PASSING | attachment-config.e2e.test.ts (E2E-2: PUT/GET round-trip)         |
| 15  | Config disable/enable round-trip | e2e           | PASSING | attachment-config.e2e.test.ts (E2E-4: disable/enable via PUT/GET) |

### Testing Notes

All 51 tests pass (23 unit + 4 proxy integration + 14 runtime integration + 10 E2E) plus 6 browser E2E tests (BRW-1 through BRW-6). Unit tests cover component rendering, form interactions, validation, and API calls. E2E tests verify config changes via real Express + MongoMemoryServer with full middleware chain. E2E-9 verifies disabled config blocks uploads; E2E-10 verifies Zod server-side validation rejects invalid input. Browser E2E tests exercise the real Studio UI in Chromium via Playwright.

> Full testing details: [../../testing/sub-features/attachment-settings-ui.md](../../testing/sub-features/attachment-settings-ui.md)

---

## 18. References

- Parent feature: [docs/features/attachments.md](../attachments.md)
- Runtime API: `apps/runtime/src/routes/attachment-config.ts`
- Config resolver: `apps/runtime/src/attachments/attachment-config-resolver.ts`
- Implementation plan: `docs/plans/2026-03-13-agent-capabilities-phase2-attachment-tools.md`
- Change manifest: `docs/specs/attachment-config-resolution.changes.md`
- Design tokens: [docs/features/gradient-design-tokens.md](../gradient-design-tokens.md) (for consistent UI styling)
