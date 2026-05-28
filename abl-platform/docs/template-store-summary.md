# Template Store — Feature Summary

## What It Is

A marketplace for browsing, discovering, and installing reusable agent and project templates. Admins upload project exports as templates; users browse and install them into their workspaces with one click.

## Key Capabilities

### For Users (Template Store)

- **Browse & Search** — filterable catalog with sidebar (type, category checkboxes), full-text search, sort by downloads/views/name
- **Template Detail** — overview, topology (agents & tools list), demo conversations, prerequisites (env vars, models, connectors)
- **One-Click Install** — project templates create a new project; agent templates merge into an existing project. Uses the existing `importProjectV2` pipeline with zero transformation.
- **"From Template" Entry Point** — accessible from the "+ New Project" dropdown on the Projects page

### For Workspace Admins (Template Manager)

- **Upload Templates** — drag-and-drop zip upload (same format as project export). Auto-validates ABL syntax, folder structure, and import compatibility. Auto-extracts metadata from the manifest.
- **Edit Metadata** — name, description, category, tags, complexity, status
- **Archive Templates** — soft-delete with confirmation
- **Workspace Scoping** — templates uploaded here are visible only within the workspace

### For Platform Admins (Superadmin Portal)

- **Global Template Management** — same upload/edit/archive flow, but templates are published globally (visible to all tenants)
- **Separate from Workspace Templates** — superadmin portal only shows global templates; workspace admin only shows workspace templates

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  Studio Marketplace  │     │  Studio Workspace    │     │  Superadmin     │
│  (Browse + Install)  │     │  Admin (Upload)      │     │  Portal (Upload)│
└────────┬────────────┘     └──────────┬───────────┘     └────────┬────────┘
         │                             │                          │
         └─────────────┬───────────────┘                          │
                       ▼                                          ▼
              ┌─────────────────┐                    ┌────────────────────┐
              │  Studio Proxy   │                    │  Admin BFF Proxy   │
              │  (Next.js)      │                    │  (Next.js)         │
              └────────┬────────┘                    └────────┬───────────┘
                       │                                      │
                       └──────────────┬───────────────────────┘
                                      ▼
                          ┌───────────────────────┐
                          │  Template Store Service│
                          │  (Express, port 3115)  │
                          │                        │
                          │  Browse API (public)   │
                          │  Admin API (auth)      │
                          │  Bundle API            │
                          │  Install Event API     │
                          └───────────┬────────────┘
                                      │
                                      ▼
                                   MongoDB
                          (Templates + Versions)
```

## Data Model

- **Template** — metadata (name, description, category, tags, type, complexity, prerequisites, media, install count, publisher info, review status)
- **TemplateVersion** — versioned content bundle stored as `files: Record<string, string>` (the exact format `importProjectV2` consumes). Includes parsed `ProjectManifestV2` manifest for query convenience.

## Tenant Scoping

| Source            | `publisherTenantId` | Visible To          |
| ----------------- | ------------------- | ------------------- |
| Superadmin portal | `platform`          | All tenants         |
| Workspace admin   | `<tenantId>`        | That workspace only |

The browse API filters by `publisherTenantId IN ('platform', currentTenantId)` for authenticated users. Public browse shows only global templates.

## Install Flow

1. User clicks "Create Project from Template" or "Add to Project"
2. Studio fetches the `files` bundle from the template store
3. Runs a dry-run preview via `importProjectV2` (validates, detects conflicts)
4. Auto-acknowledges non-blocking issues
5. Applies the import (creates agents, tools, configs in the target project)
6. Shows post-install report (what needs provisioning: env vars, connectors, etc.)

No custom import logic — the entire install reuses the existing project import pipeline.

## Upload Flow

1. Admin drops a project export zip in the upload dialog
2. Client extracts zip (fflate), validates size limits (4MB)
3. Sends extracted files to the admin API
4. Server validates: folder structure (`readFolderV2`), ABL syntax (`validateAgentSyntax`), dependency graph
5. Auto-extracts metadata from manifest (name, description, agents, tools, env vars)
6. Admin reviews/edits metadata and submits
7. Template + TemplateVersion created in MongoDB

## Implementation Details

### Separate Microservice — Zero Coupling to Runtime

The Template Store is a **standalone Express service** (`apps/template-store/`, port 3115) with its own Dockerfile and Docker Compose entry. It has no dependency on the Runtime service — it only shares the MongoDB database and the `@agent-platform/database` model package. This means it can be deployed, scaled, and versioned independently. The public browse API requires no authentication, making it suitable for a future marketing website or external catalog.

### Maximum Reuse — No Reinvented Wheels

The implementation deliberately reuses existing platform infrastructure rather than building custom solutions:

- **Import pipeline** — Template install calls `importProjectV2()` from `packages/project-io` directly. The same code that handles manual project imports handles template installs. No separate import logic exists.
- **Export format** — Templates store content as `Record<string, string>` — the exact same file-map format that project export produces. Upload a project export zip → it becomes a template → install it → identical project gets created. Zero transformation at any step.
- **Validation** — Upload validation reuses `readFolderV2()`, `validateAgentSyntax()`, and `validateCrossLayerDeps()` from `packages/project-io`. The same validators that protect manual imports protect template uploads.
- **Auth middleware** — Uses `createUnifiedAuthMiddleware` from `@agent-platform/shared-auth` (same as Runtime and Studio).
- **Sidebar primitives** — The marketplace UI reuses `SidebarContainer`, `SidebarGroup`, `SidebarNavItem` from Studio's shared sidebar system. A new `'marketplace'` surface type was added to the existing `SidebarSurface` enum.
- **Admin page patterns** — Workspace admin pages follow the exact same layout, data-fetching (`useSWR` + `apiFetch`), and component patterns as existing admin pages like Members and Models.
- **Superadmin BFF pattern** — The admin portal uses the same `withAdminRoute` + proxy pattern as existing admin features (Config, Models, Features). A `template-store-proxy.ts` helper mirrors the existing `runtime-proxy.ts`.

### Studio Integration Points

- **Proxy** — Studio's Next.js middleware rewrites `/api/template-store/*` to the template store service, enabling the marketplace UI to call the template store API without CORS issues.
- **"From Template" button** — Wired into the existing `NewProjectDropdown` component on the Projects page.
- **Admin sidebar** — A new "MARKETPLACE" section was added to `AdminSidebar.tsx` alongside existing groups (Team, AI Configuration, Analytics, Account).
- **Navigation store** — The `AdminPage` type union was extended with `'template-manager'` and wired into `AppShell.tsx`'s content renderer.

### Database — Shared MongoDB, Dedicated Collections

Templates use 3 collections in the shared `abl_platform` MongoDB database:

- `templates` — template metadata with text search indexes on name/description/tags
- `template_versions` — versioned content bundles (the `files` field, max 4MB inline)
- `template_analytics_events` — view/install tracking with 90-day TTL auto-expiry

No migration needed — the Mongoose models auto-create collections and indexes on first connection.

## Tech Stack

- **Backend**: Express service (`apps/template-store/`), Mongoose models (`packages/database/`), project-io validators (`packages/project-io/`)
- **Frontend**: Next.js pages (`apps/studio/src/app/marketplace/`), Zustand store, sidebar primitives
- **Admin Portal**: Next.js pages (`apps/admin/src/app/(dashboard)/templates/`), BFF proxy pattern
- **Tests**: 216 tests (131 backend integration, 72 frontend unit, 13 E2E Playwright)

## What's Next (Future Phases)

- Workflow templates (`type: 'workflow'`)
- Ratings & reviews
- Template versioning UI (changelog, version picker)
- S3/CDN for media assets (currently static files)
- Community publishing with approval flow
