# HLD: Template Store

**Feature Spec**: `docs/features/template-store.md`
**Test Spec**: `docs/testing/template-store.md`
**Status**: IN PROGRESS (Phase 3)
**Author**: Product/Engineering
**Date**: 2026-05-13 (Phase 3 update; Phase 2: 2026-05-13; Phase 1 original: 2026-04-21)

---

## 1. Problem Statement

New users face a cold-start problem when building agents on the ABL platform. Going from "signed up" to "running agent" requires understanding the DSL, configuring models, setting up tools, and wiring multi-agent orchestration — all before seeing any value. Enterprise teams compound this by duplicating effort across departments, building similar agents from scratch with no way to share proven designs.

Phase 1 delivered a **read-only marketplace catalog** — a curated set of 10 platform-provided templates that users can browse, search, and preview. Phase 2 upgraded the **storage and data model** so that each template version stores a complete import-ready file bundle aligned with `ProjectManifestV2` from `packages/project-io`. Phase 3 delivers the **install flow** — the Studio-orchestrated pipeline that creates projects from templates and merges agent templates into existing projects, leveraging `importProjectV2()` with zero content transformation.

The north-star goal remains: reduce time-to-first-agent-session to under 5 minutes and drive 40%+ of new projects to be created from templates. Phase 3 makes this measurable for the first time.

**Terminology note**: The backend service and repository are named "Template Store" (`apps/template-store/`, proxy path `/api/template-store/*`). The user-facing UI and API route prefix are named "Marketplace" (`/marketplace/*` pages, `/api/v1/marketplace/*` endpoints, `marketplace` i18n namespace). This distinction is intentional: the service scope extends beyond the marketplace to include publishing, admin, and governance in later phases.

---

## 2. Alternatives Considered

### Option A: Embed in Studio (Next.js routes + Studio DB)

- **Description**: Add marketplace pages directly to the Studio Next.js app. Templates stored alongside existing Studio data. No new service.
- **Pros**: Simpler deployment (no new service), reuses existing Studio auth/middleware, faster to ship Phase 1.
- **Cons**: Cannot serve the marketing website (requires auth-free public API). Couples template catalog to Studio's deploy cadence. No independent scaling. Phase 2+ (publishing, admin review, partner APIs) would require painful extraction.
- **Effort**: S

### Option B: Separate Express microservice (Chosen)

- **Description**: New Express service at `apps/template-store/` on port 3115. Public API for unauthenticated browsing. Studio proxies requests. Shared MongoDB.
- **Pros**: Marketing website can consume the API directly. Independent deploy cadence for a separate team. Clean service boundary for Phase 2+ enterprise features (governance, partner APIs, compliance). Follows established platform patterns (runtime, search-ai).
- **Cons**: Additional service to deploy and monitor. Studio proxy indirection. Slightly more infrastructure setup.
- **Effort**: M

### Option C: Extend Runtime with marketplace routes

- **Description**: Add `/api/v1/marketplace/*` routes to the existing runtime service.
- **Pros**: No new service. Reuses runtime's auth, rate limiting, and middleware chain.
- **Cons**: Runtime is already the most complex service. Public unauthenticated routes in the runtime create a security surface concern. Marketing website would need to call the runtime, coupling external traffic to the agent execution service. Violates single-responsibility.
- **Effort**: S

### Recommendation: Option B — Separate Express microservice

**Rationale**: The marketing website requirement makes a separate service unavoidable — we need unauthenticated public APIs that shouldn't live in the runtime. Independent team ownership and the enterprise growth trajectory (tenant catalogs, governance, partner APIs) justify the up-front service boundary. The scaffold already exists and follows proven patterns from runtime and search-ai.

### Phase 2 Storage Alternatives

#### Alt D: Object Storage (S3/MinIO) for bundles

- **Description**: Store `TemplateVersion.files` bundles in S3 or MinIO. MongoDB stores a reference key.
- **Pros**: No document size concern. Scalable to arbitrarily large bundles. CDN-ready.
- **Cons**: Additional infrastructure dependency (S3/MinIO). More complex retrieval path. Overkill for <50 platform-seeded templates with a 4MB cap.
- **Why rejected for Phase 2**: All Phase 2 data is platform-seeded. The 4MB bundle limit (well within MongoDB's 16MB doc limit) accommodates projects with ~50 agents comfortably. Inline storage avoids operational complexity. Migration to S3/CDN in Phase 4 is straightforward — only the storage layer changes.

#### Alt E: Manifest-only (no `files` bundle)

- **Description**: Store only the `ProjectManifestV2` in TemplateVersion. Reconstruct files at install time from the manifest metadata + individual agent/tool records.
- **Pros**: Smaller documents. No duplicate storage.
- **Cons**: Requires reverse-engineering the export pipeline to reconstruct files. Breaks the "zero transformation at install" invariant. Error-prone reconstruction path.
- **Why rejected**: The cardinal design constraint for Phase 2 is **zero transformation between storage and install**. Storing files exactly as `importProjectV2()` consumes them eliminates an entire class of bugs.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             ABL Platform                                  │
│                                                                           │
│  ┌──────────────┐   proxy: /api/template-store/*   ┌──────────────────┐  │
│  │  Studio       │ ──────────────────────────────> │  Template Store   │  │
│  │  :5173        │ <───────────────────────────── │    :3115           │  │
│  │  (Next.js)    │     JSON / bundle responses     │  (Express)        │  │
│  │               │                                 │                   │  │
│  │ Phase 3:      │   POST /install-event           │ Phase 3:          │  │
│  │ +install      │ ──────────────────────────────> │ +installCount     │  │
│  │  routes       │                                 │  increment        │  │
│  │ +project      │                                 │ +install analytics│  │
│  │  creation     │                                 └────────┬──────────┘  │
│  │ +import       │                                          │             │
│  │  pipeline     │                                          │             │
│  └──────┬────────┘                                          │             │
│         │                                                    │             │
│         │ renders UI                                         │             │
│         ▼                                                    │             │
│  ┌──────────────┐                                           │             │
│  │ Browser      │  Phase 3: install CTAs,                   │             │
│  │ (User)       │  project selector, preview,               │             │
│  │              │  post-install checklist                    │             │
│  └──────────────┘                                           │             │
│                                                              │             │
│  ┌──────────────┐    direct API call                        │             │
│  │  Marketing   │ ─────────────────────────────────────────┘             │
│  │  Website     │      (public, no auth — browse only)                    │
│  │  (future)    │                                                         │
│  └──────────────┘                                                         │
│                                                                           │
│                        ┌──────────────┐                                   │
│                        │  MongoDB     │                                   │
│                        │  Atlas       │                                   │
│                        │              │                                   │
│                        │  templates (Phase 3: installCount $inc)          │
│                        │  template_versions                               │
│                        │  template_analytics_events (Phase 3: +install)   │
│                        │  projects (Phase 3: created by install)          │
│                        │  project_agents, project_tools, ...              │
│                        │    (Phase 3: populated by importProjectV2)       │
│                        └──────────────┘                                   │
│                                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐   │
│  │ Runtime  │  │ SearchAI │  │  Admin   │  │ project-io (package)   │   │
│  │  :3112   │  │  :3005   │  │  :3003   │  │                        │   │
│  └──────────┘  └──────────┘  └──────────┘  │ Phase 3: importProjectV2│   │
│  (no dep)       (no dep)     (no dep)      │ called by Studio install│   │
│                                             │ routes via layered-     │   │
│                                             │ import-support.ts       │   │
│                                             └────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Template Store Service                              │
│                                                                          │
│  HTTP Request                                                            │
│      │                                                                   │
│      ▼                                                                   │
│  ┌──────────────────────────────────────────────────┐                   │
│  │             Middleware Chain (ordered)             │                   │
│  │  helmet → cors → compression → json-parse        │                   │
│  │  → requestId → observability → optionalAuth      │                   │
│  │  → rateLimiter                                    │                   │
│  └──────────────┬────────────────────────────────────┘                   │
│                 │                                                         │
│      ┌──────────┼──────────────┐                                         │
│      ▼          ▼              ▼                                         │
│  ┌────────┐ ┌────────────┐ ┌──────────────────┐                        │
│  │ Health │ │   Static   │ │  Marketplace      │                        │
│  │ Routes │ │   Assets   │ │    Routes         │                        │
│  │ /health│ │ /assets/   │ │ /api/v1/          │                        │
│  │ /ready │ │ templates/ │ │ marketplace/       │                        │
│  └───┬────┘ └────────────┘ │ Phase 3:           │                        │
│      │       (Phase 2)     │ +install-event     │                        │
│      │                     └────────┬───────────┘                        │
│      │                              │                                     │
│      │                              ▼                                     │
│      │                     ┌──────────────┐    fire-and-forget           │
│      │                     │  Repo Layer  │──────────────┐               │
│      │                     │              │              ▼               │
│      │                     │ template-repo│       ┌────────────┐        │
│      │                     │ +projection  │       │ analytics- │        │
│      │                     │ +bundle()    │       │    repo    │        │
│      │                     │ Phase 3:     │       │ Phase 3:   │        │
│      │                     │ +installCount│       │ +install   │        │
│      │                     │  increment   │       │  event     │        │
│      │                     └──────┬───────┘       └─────┬──────┘        │
│      │                            │                     │                │
│      │                            ▼                     │                │
│      │                     ┌──────────────┐             │                │
│      └────────────────────>│   MongoDB    │<────────────┘                │
│                            └──────────────┘                              │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     Studio Install Routes (Phase 3)                      │
│                                                                          │
│  POST /api/template-install/*                                            │
│      │                                                                   │
│      ▼                                                                   │
│  ┌──────────────────────────────────────────────────┐                   │
│  │         withRouteHandler Middleware Chain          │                   │
│  │  auth → rate limit → tenant → permissions         │                   │
│  └──────────────┬────────────────────────────────────┘                   │
│                 │                                                         │
│      ┌──────────┼──────────────────────┐                                 │
│      ▼          ▼                      ▼                                 │
│  ┌─────────┐ ┌─────────────────┐ ┌──────────────────┐                  │
│  │ /project│ │ /agent/preview  │ │ /agent/apply     │                  │
│  └────┬────┘ └───────┬─────────┘ └────────┬─────────┘                  │
│       │              │                     │                             │
│       │    ┌─────────┴─────────────────────┘                             │
│       │    │                                                             │
│       ▼    ▼                                                             │
│  ┌─────────────────────┐     ┌─────────────────────────────────────┐    │
│  │ Bundle Fetch        │────>│ Template Store (via proxy :3115)    │    │
│  │ (server-side HTTP)  │<────│ GET /templates/:slug/versions/      │    │
│  └─────────┬───────────┘     │     :version/bundle                 │    │
│            │                 └─────────────────────────────────────┘    │
│            │                                                             │
│  ┌─────────▼───────────┐     ┌─────────────────────────────────────┐    │
│  │ /project only:      │     │ layered-import-support.ts           │    │
│  │ createProject()     │     │ • previewStudioLayeredImportV2()    │    │
│  │ (project-service)   │     │ • applyStudioLayeredImportV2()      │    │
│  └─────────┬───────────┘     │ • loadStudioLayeredImportExisting   │    │
│            │                 │   State()                           │    │
│            └────────────────>│ • createStudioLayeredImportDeps()   │    │
│                              └──────────────┬──────────────────────┘    │
│                                             │                            │
│                                             ▼                            │
│                              ┌──────────────────────────────────┐       │
│                              │ importProjectV2()                 │       │
│                              │ (packages/project-io)             │       │
│                              │ • disassemble files into layers   │       │
│                              │ • resolve cross-references        │       │
│                              │ • staged import → activate        │       │
│                              │ • rollback on failure             │       │
│                              └──────────────┬───────────────────┘       │
│                                             │                            │
│                                             ▼                            │
│                              ┌──────────────────────────────────┐       │
│                              │ MongoDB                           │       │
│                              │ project_agents, project_tools,    │       │
│                              │ project_settings, model_configs,  │       │
│                              │ etc. (all project collections)    │       │
│                              └──────────────────────────────────┘       │
│                                                                          │
│  Post-install:                                                           │
│  ┌──────────────────────┐     ┌────────────────────────────────────┐    │
│  │ Notify template-store│────>│ POST /api/v1/marketplace/templates/│    │
│  │ of install event     │     │   :slug/install-event              │    │
│  └──────────────────────┘     │ → $inc installCount                │    │
│                               │ → record 'install' analytics event │    │
│                               └────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
apps/template-store/
├── src/
│   ├── index.ts              # Entry: dotenv, config, DB init, start server
│   ├── server.ts             # Express app with middleware chain + static assets (Phase 2)
│   ├── config.ts             # Env-based config singleton
│   ├── lib/
│   │   └── db.ts             # MongoConnectionManager initialization
│   ├── middleware/
│   │   ├── auth.ts           # Unified auth (requireAuth, optionalAuth)
│   │   ├── rate-limit.ts     # Per-IP sliding window rate limiter
│   │   └── error-handler.ts  # AppError → errorToResponse
│   ├── repos/
│   │   ├── template-repo.ts  # Browse queries, filters, pagination, projection, bundle
│   │   └── analytics-repo.ts # Event tracking
│   ├── routes/
│   │   ├── health.ts         # /health and /ready probes
│   │   └── marketplace.ts    # 5 public GET endpoints (Phase 2: +bundle)
│   ├── scripts/
│   │   └── seed-templates.ts # Seed templates with files bundles + manifests (Phase 2 rewrite)
│   └── assets/
│       └── templates/        # Static media files: /assets/templates/<slug>/<file> (Phase 2)
├── Dockerfile
├── package.json
└── tsconfig.json

packages/database/src/models/
├── template.model.ts                  # Template schema (Phase 2: +media, +prerequisites, +reviewStatus)
├── template-version.model.ts          # TemplateVersion schema (Phase 2: +files, typed manifest)
├── template-analytics-event.model.ts  # Analytics with 90-day TTL
└── index.ts                           # Barrel exports

packages/project-io/src/
├── types.ts                           # ProjectManifestV2, ImportOptionsV2, ImportResultV2
└── import/
    └── project-importer-v2.ts         # importProjectV2(files, existingState, options, deps)

apps/studio/
├── src/proxy.ts                       # /api/template-store/* → :3115
├── src/store/marketplace-store.ts     # Zustand store (Phase 2: +media, +prerequisites types)
├── src/components/marketplace/
│   ├── TemplateTypeBadge.tsx          # Type badge (Agent/Project)
│   ├── TemplateCard.tsx               # Template card for grid views
│   ├── CategoryGrid.tsx               # Category cards with icons and counts
│   ├── TemplateSearchBar.tsx          # Search input + filter dropdowns
│   ├── TemplateScreenshotGallery.tsx  # Media gallery (Phase 2: images + video)
│   ├── DemoConversation.tsx           # Sample conversation display
│   ├── TemplateConfigPreview.tsx      # Read-only config schema preview
│   ├── PrerequisitesSection.tsx       # Phase 2: categorized prerequisites display
│   ├── InstallButton.tsx              # Phase 3: adaptive CTA (project vs agent)
│   ├── ProjectSelector.tsx            # Phase 3: project picker for agent installs
│   ├── InstallPreviewDialog.tsx       # Phase 3: dry-run preview before agent install
│   ├── PostInstallChecklist.tsx       # Phase 3: provisioning requirements display
│   └── MarketplaceLayout.tsx          # Shared layout with breadcrumbs
├── src/lib/project-import/
│   └── layered-import-support.ts      # Phase 3: reused (previewStudioLayeredImportV2, applyStudioLayeredImportV2)
├── src/app/api/template-install/
│   ├── project/route.ts               # Phase 3: POST — create project + import template
│   └── agent/
│       ├── preview/route.ts           # Phase 3: POST — dry-run agent template install
│       └── apply/route.ts             # Phase 3: POST — apply agent template install
├── src/api/
│   └── template-install.ts            # Phase 3: client-side API functions for install flow
└── src/app/marketplace/               # Pages (no route group)
```

### Data Flow

**Browse flow (Studio user):**

```
1. User clicks "Template Store" in Studio sidebar
2. Studio renders marketplace landing page
3. Page component calls GET /api/template-store/marketplace/templates?featured=true
4. Studio middleware rewrites → GET http://localhost:3115/api/v1/marketplace/templates?featured=true
5. Template Store:
   a. requestIdMiddleware adds x-request-id
   b. observabilityMiddleware sets up trace context
   c. optionalAuth populates req.user (if authenticated) or continues (if not)
   d. rateLimiter checks IP window (100 req/60s)
   e. Route handler calls template-repo.findTemplates({ status: 'published', visibility: 'public' })
   f. MongoDB query with filters, pagination, sort
   g. Phase 2: MongoDB projection EXCLUDES `files` field from TemplateVersion join
   h. Response: { success: true, data: { templates: [...], total, page, limit, hasMore } }
6. Studio renders template cards with type badges, categories, stats
```

**Detail view flow (updated for Phase 2):**

```
1. User clicks a template card
2. Page calls GET /api/template-store/marketplace/templates/:slug
3. Template Store:
   a. Route handler calls template-repo.findBySlug(slug)
   b. If not found → 404 { success: false, error: { code: 'NOT_FOUND' } }
   c. Atomically increments viewCount on template document
   d. Records analytics event: { eventType: 'detail_view', templateSlug, templateId }
   e. Loads current version from template_versions collection (Phase 2: EXCLUDES files)
   f. Response includes: media[], prerequisites, manifest summary, demoConversation, typeMetadata
4. Studio renders detail page with composable sections based on detailSections array
5. Phase 2: Prerequisites section renders categorized chip lists before install CTA
```

**Bundle retrieval flow (Phase 2 — new):**

```
1. Client requests GET /api/v1/marketplace/templates/:slug/versions/:version/bundle
2. Template Store:
   a. Validates slug + version params via Zod
   b. Looks up template by slug (enforces published + public)
   c. Finds TemplateVersion by templateId + version
   d. If not found → 404
   e. Returns ONLY the `files` field: { success: true, data: { files: { ... } } }
3. Response is potentially large (up to 4MB) — no other fields included
4. Phase 3: This is the endpoint the install flow calls before passing files to importProjectV2()
```

**Project template install flow (Phase 3 — new):**

```
1. User clicks "Create Project from Template" on a project template detail page
2. UI shows project name form (name, optional description)
3. UI calls POST /api/template-install/project
   Body: { templateSlug, version, projectName, description? }
   Auth: JWT Bearer token (auto-attached by apiFetch())
4. Studio route handler (server-side):
   a. Validates auth: requireTenantAuth + hasPermission('project:create')
   b. Fetches bundle SERVER-SIDE:
      GET http://localhost:3115/api/v1/marketplace/templates/:slug/versions/:version/bundle
      (via internal HTTP using TEMPLATE_STORE_URL — NOT through the browser)
   c. Creates new project: calls createProject({ name, ownerId, tenantId })
      (same service function used by POST /api/projects)
   d. Converts files: new Map(Object.entries(bundleResponse.files))
   e. Loads existing state: loadStudioLayeredImportExistingState({ projectId, tenantId })
      (empty project — no agents/tools/settings yet)
   f. Assembles deps: createStudioLayeredImportDeps({ projectId, tenantId })
   g. Calls importProjectV2(fileMap, existingState, {
        projectId, tenantId, userId,
        conflictStrategy: 'replace',
        layers: manifest.layers_included,
        dryRun: false
      }, deps)
   h. On success: notifies template-store via POST /api/v1/marketplace/templates/:slug/install-event
      → template-store atomically increments installCount + records 'install' analytics event
5. Response: { success, project: { id, name, slug }, applied, entryAgentName, provisioningRequired }
6. UI navigates to new project dashboard + shows post-install checklist
```

**Agent template install — preview step (Phase 3 — new):**

```
1. User clicks "Add to Project" on an agent template detail page
2. User selects target project from dropdown (fetches user's projects via GET /api/projects)
3. UI calls POST /api/template-install/agent/[id]/preview
   Body: { templateSlug, version, projectId }
   Auth: JWT Bearer token (requires PROJECT_READ on target project)
4. Studio route handler (server-side):
   a. Validates auth: withRouteHandler with requireProject + PROJECT_READ permission
   b. Fetches bundle SERVER-SIDE (same as project flow step 4b)
   c. Calls previewStudioLayeredImportV2({
        files: new Map(Object.entries(bundle.files)),
        projectId, tenantId, userId,
        conflictStrategy: 'merge',
        layers: ['core']
      })
      This is a dry-run — no data is written
   d. Response includes: preview (agents/tools to add/modify), issues, warnings
5. UI shows preview dialog: "This will add X agents and Y tools to your project"
   User reviews changes and confirms or cancels
```

**Agent template install — apply step (Phase 3 — new):**

```
1. User confirms the preview and clicks "Install"
2. UI calls POST /api/template-install/agent/[id]/apply
   Body: { templateSlug, version, projectId, previewDigest }
   Auth: JWT Bearer token (requires PROJECT_IMPORT on target project)
3. Studio route handler (server-side):
   a. Validates auth: withRouteHandler with requireProject + PROJECT_IMPORT permission
   b. Fetches bundle SERVER-SIDE (re-fetch to avoid stale data)
   c. Calls applyStudioLayeredImportV2({
        files: new Map(Object.entries(bundle.files)),
        projectId, tenantId, userId,
        conflictStrategy: 'merge',
        layers: ['core'],
        previewDigest
      })
      This performs the actual staged import:
        - Disassembles files into layer records
        - Stages new records with shadow projectIds
        - Activates staged records (swaps to real projectId)
        - Supersedes existing records that conflict
        - Rolls back on any failure
   d. On success: notifies template-store via install-event endpoint
   e. Invalidates runtime model cache if model policies were changed
4. Response: { success, applied: { created, updated, toolsCreated, ... }, entryAgentName, warnings }
5. UI shows success with post-install checklist (provisioning requirements)
```

**Media assets flow (Phase 2 — new):**

```
1. Template detail page renders <img src="/api/template-store/assets/templates/<slug>/hero.png" />
2. Studio proxy rewrites → GET http://localhost:3115/assets/templates/<slug>/hero.png
3. Template Store serves via express.static (no auth, no rate limit on static assets)
4. Future CDN migration: only the URL prefix in media[].url changes
```

**Marketing website flow (future):**

```
1. Marketing site calls GET http://template-store:3115/api/v1/marketplace/templates directly
2. CORS middleware validates origin against MARKETING_SITE_URL / CORS_ORIGINS
3. Same handler logic as Studio flow (no auth required)
```

---

## 4. The 12 Architectural Concerns

### Concern 1: Data Model

**Phase 1 (Done):** Three new collections (`templates`, `template_versions`, `template_analytics_events`) with compound indexes for browse queries, text index for search, and TTL index for analytics expiry.

**Phase 2 Changes:**

| Model             | Change                                            | Migration Strategy |
| ----------------- | ------------------------------------------------- | ------------------ |
| `Template`        | `screenshots[]` replaced by `media[]`             | Drop + re-seed     |
| `Template`        | ADD `prerequisites` (embedded object)             | Drop + re-seed     |
| `Template`        | ADD `reviewStatus` (string, default `'approved'`) | Drop + re-seed     |
| `TemplateVersion` | `manifest` typed as `ProjectManifestV2`           | Drop + re-seed     |
| `TemplateVersion` | ADD `files` (`Record<string, string>`)            | Drop + re-seed     |

**Phase 3 Changes:**

No new models or collections. Phase 3 operates on existing data:

| Model                       | Change                                           | Migration Strategy                |
| --------------------------- | ------------------------------------------------ | --------------------------------- |
| `Template`                  | `installCount` field incremented on install      | Already exists (default 0)        |
| `template_analytics_events` | New `install` event type recorded on install     | No schema change (Mixed metadata) |
| `projects`                  | New projects created by project template install | No schema change                  |
| `project_agents`, etc.      | Populated by `importProjectV2` during install    | No schema change                  |

The `installCount` field already exists on the Template model (added in Phase 1 with default 0). Phase 3 activates it via atomic `$inc` after successful install. No data migration is needed.

**`media[]` replaces `screenshots[]`:**

```
media: [{
  type: 'image' | 'video',
  url: string,              // /assets/templates/<slug>/<filename>
  thumbnailUrl?: string,    // video poster frame
  caption: string,
  order: number,
}]
```

This is a breaking API change (GAP-011). Safe because all data is platform-seeded — no user-generated content. Drop and re-seed resolves it.

**`prerequisites` (embedded, denormalized):**

```
prerequisites: {
  envVars: string[],        // e.g., ['OPENAI_API_KEY']
  connectors: string[],     // e.g., ['Salesforce CRM']
  mcpServers: string[],     // e.g., ['filesystem-mcp']
  authProfiles: string[],   // e.g., ['oauth-salesforce']
  models: string[],         // e.g., ['gpt-4o']
}
```

Derived from `ProjectManifestV2.metadata` at seed/publish time:

| Prerequisite Field | Source in `ProjectManifestV2`                 |
| ------------------ | --------------------------------------------- |
| `envVars`          | `metadata.required_env_vars`                  |
| `connectors`       | `metadata.required_connectors`                |
| `mcpServers`       | `metadata.required_mcp_servers`               |
| `authProfiles`     | `metadata.required_auth_profiles[].name`      |
| `models`           | Extracted from agent DSL `MODEL` declarations |

**`reviewStatus` (governance foundation):**

```
reviewStatus: 'approved' | 'pending' | 'rejected'   // default: 'approved'
```

All platform-seeded templates default to `'approved'`. Phase 3+ community publishing will use `'pending'` + admin review workflow.

**`TemplateVersion.files` (the core Phase 2 addition):**

```
files: Record<string, string>
// Keys: relative paths from project root
// Values: file content strings
// Max size: 4MB (validated at seed/publish time)
// Example:
{
  "project.json": "{ \"format_version\": \"2.0\", ... }",
  "agents/billing-agent.agent.abl": "AGENT billing-agent\n  MODEL gpt-4o\n  ...",
  "tools/crm-lookup.tool.yaml": "name: crm-lookup\ntype: http\n..."
}
```

**`TemplateVersion.manifest` typed as `ProjectManifestV2`:**

The `manifest` field stores a parsed/validated copy of `files["project.json"]`. It is a **convenience copy** — `files` is the canonical source of truth. The `manifest` enables efficient querying (e.g., `layers_included`, `agents`, `metadata.entity_counts`) without parsing JSON from the `files` map on every read.

Key `ProjectManifestV2` fields used for queries and display:

- `format_version: '2.0'`
- `layers_included: LayerName[]` — which import layers the template covers
- `agents: Record<string, ManifestAgent>` — agent inventory for type metadata
- `metadata.required_env_vars` — feeds `prerequisites.envVars`
- `metadata.required_connectors` — feeds `prerequisites.connectors`
- `metadata.required_mcp_servers` — feeds `prerequisites.mcpServers`
- `metadata.required_auth_profiles` — feeds `prerequisites.authProfiles`
- `metadata.entity_counts` — for display stats

### Concern 2: API Design

**Phase 1 (Done):** Four public GET endpoints for browse, detail, categories, and featured.

**Phase 2 Changes:**

| Change                  | Endpoint(s) Affected                            | Details                                                              |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| New bundle endpoint     | `GET /templates/:slug/versions/:version/bundle` | Returns only `files` field for install retrieval                     |
| Projection on browse    | `GET /templates`, `/featured`                   | MongoDB projection excludes `files` from TemplateVersion joins       |
| Projection on detail    | `GET /templates/:slug`                          | Version response excludes `files`; returns `manifest` summary        |
| Type filter param       | `GET /templates`, `/categories`                 | `?type=project\|agent` query parameter on browse and category counts |
| Response shape: media   | `GET /templates/:slug`                          | `media[]` replaces `screenshots[]` in template object                |
| Response shape: prereqs | `GET /templates/:slug`                          | `prerequisites` object included in template response                 |
| Static file serving     | `GET /assets/templates/<slug>/*`                | Express static middleware for media files                            |

**Phase 3 Changes:**

Three new Studio API routes + one new template-store route:

| Change                         | Service        | Endpoint                                                 | Details                                                   |
| ------------------------------ | -------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Project template install       | Studio         | `POST /api/template-install/project`                     | Create project + fetch bundle + importProjectV2 (replace) |
| Agent template install preview | Studio         | `POST /api/template-install/agent/[id]/preview`          | Fetch bundle + dry-run importProjectV2 (merge, core only) |
| Agent template install apply   | Studio         | `POST /api/template-install/agent/[id]/apply`            | Fetch bundle + apply importProjectV2 (merge, core only)   |
| Install event notification     | Template Store | `POST /api/v1/marketplace/templates/:slug/install-event` | Increment installCount + record install analytics event   |

**Why install routes live in Studio (not template-store):**

The install flow requires capabilities that only Studio has:

1. **Direct MongoDB access via Mongoose** — `importProjectV2` uses `createStudioLayeredImportDbAdapter` which operates on raw MongoDB collections (project_agents, project_tools, model_configs, etc.) via `mongoose.connection.db.collection()`. The template-store service does not import Mongoose models for project data.
2. **Cross-reference resolution** — The import pipeline resolves references between imported entities and existing tenant data (e.g., mapping model configs to `TenantModel` records, resolving search indexes by name). This requires querying the full project and tenant data graph.
3. **Project-scoped lifecycle management** — Creating projects, setting entry agents, invalidating runtime model caches, and audit logging all use Studio's existing service layer (`createProject`, `notifyRuntimeModelConfigChanged`, `logAuditEvent`).
4. **Staged import with rollback** — The `StagedImporter` uses shadow projectIds and bulk MongoDB operations that require the full `ImportDbAdapter` wiring.

The template-store service's role in Phase 3 is limited to: (a) serving the bundle via the existing `GET /bundle` endpoint, and (b) recording the install event via a new `POST /install-event` endpoint.

**New Studio route: POST /api/template-install/project**

```
Request:
  POST /api/template-install/project
  Auth: JWT Bearer token
  Permission: project:create (checked via hasPermission on user.permissions)
  Body: {
    templateSlug: string,       // z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)
    version: string,            // z.string().regex(/^\d+\.\d+\.\d+$/)
    projectName: string,        // z.string().trim().min(1).max(100)
    description?: string        // z.string().trim().max(500).optional()
  }

Response 201 (success):
  {
    success: true,
    project: { id: string, name: string, slug: string },
    applied: {
      created: number,
      updated: number,
      deleted: number,
      toolsCreated: number,
      toolsUpdated: number,
      toolsDeleted: number,
      ...
    },
    entryAgentName: string | null,
    provisioningRequired: {
      envVars: string[],
      connectors: string[],
      mcpServers: string[],
      authProfiles: string[]
    }
  }

Error responses:
  401 UNAUTHORIZED — missing or invalid JWT
  403 FORBIDDEN — missing project:create permission
  400 VALIDATION_ERROR — invalid body params
  404 NOT_FOUND — template slug or version not found
  409 CONFLICT — project slug already exists
  502 BAD_GATEWAY — template-store service unavailable (bundle fetch failed)
  500 INTERNAL_ERROR — import pipeline failure (with rollback)
```

**New Studio route: POST /api/template-install/agent/[id]/preview**

```
Request:
  POST /api/template-install/agent/[id]/preview
  Auth: JWT Bearer token
  Permission: PROJECT_READ on target project (via withRouteHandler requireProject)
  Body: {
    templateSlug: string,
    version: string,
    projectId: string           // z.string().min(1)
  }

Response 200 (success):
  {
    success: true,
    preview: {
      layers: string[],
      agentChanges: { added: string[], modified: [...], removed: string[], unchanged: string[] },
      toolChanges: { added: string[], modified: string[], removed: string[] },
      issues: [...],
      hasBlockingIssues: boolean,
      previewDigest: string,
      ...
    },
    warnings: string[]
  }

Error responses:
  401/403 — auth/permission failure
  400 — validation error
  404 — template or project not found
  502 — template-store unavailable
```

**New Studio route: POST /api/template-install/agent/[id]/apply**

```
Request:
  POST /api/template-install/agent/[id]/apply
  Auth: JWT Bearer token
  Permission: PROJECT_IMPORT on target project (via withRouteHandler requireProject)
  Body: {
    templateSlug: string,
    version: string,
    projectId: string,
    previewDigest?: string | null,
    acknowledgedIssueIds?: string[]
  }

Response 200 (success):
  {
    success: true,
    operationId: string,
    applied: { created, updated, deleted, toolsCreated, ... },
    entryAgentName: string | null,
    warnings: string[],
    provisioningRequired: {
      envVars: string[],
      connectors: string[],
      mcpServers: string[],
      authProfiles: string[]
    }
  }

Error responses:
  401/403 — auth/permission failure
  400 — validation error or import validation failure
  404 — template or project not found
  409 — preview stale (previewDigest mismatch)
  500 — import apply failure (with automatic rollback)
  502 — template-store unavailable
```

**New template-store route: POST /api/v1/marketplace/templates/:slug/install-event**

```
Request:
  POST /api/v1/marketplace/templates/:slug/install-event
  Auth: JWT Bearer token (requireAuth — authenticated Studio server-side call)
  Body: {
    userId: string,
    tenantId: string,
    projectId: string,
    version: string
  }

Response 200:
  { success: true }

Side effects:
  - Template.installCount atomically incremented via $inc
  - Analytics event recorded: { eventType: 'install', templateSlug, metadata: { userId, tenantId, projectId, version } }

Error responses:
  401 — missing auth
  404 — template slug not found
  500 — internal error
```

**New endpoint: Bundle retrieval**

```
GET /api/v1/marketplace/templates/:slug/versions/:version/bundle

Validation:
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)
  version: z.string().min(1).max(20).regex(/^\d+\.\d+\.\d+$/)

Response 200:
{
  "success": true,
  "data": {
    "files": {
      "project.json": "{ \"format_version\": \"2.0\", ... }",
      "agents/billing-agent.agent.abl": "AGENT billing-agent\n  ...",
      ...
    }
  }
}

Response 404:
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Template version not found" }
}
```

**Updated browse response (Phase 2):**

```
GET /api/v1/marketplace/templates?type=agent&page=1&limit=20

Response 200:
{
  "success": true,
  "data": {
    "templates": [
      {
        "slug": "billing-support-agent",
        "name": "Billing Support Agent",
        "shortDescription": "...",
        "type": "agent",
        "typeMetadata": { "type": "agent", "agentCount": 1 },
        "category": "customer-service",
        "complexity": "starter",
        "tags": ["billing", "support"],
        "publisherName": "ABL Platform",
        "publisherVerified": true,
        "installCount": 0,
        "viewCount": 42,
        "ratingAverage": 0,
        "featuredOrder": null,
        "iconUrl": null,
        "media": [                          // Phase 2: replaces screenshots
          { "type": "image", "url": "/assets/templates/billing-support-agent/hero.png", "caption": "Dashboard", "order": 1 }
        ],
        "prerequisites": {                  // Phase 2: new field
          "envVars": ["OPENAI_API_KEY"],
          "connectors": [],
          "mcpServers": [],
          "authProfiles": [],
          "models": ["gpt-4o"]
        },
        "reviewStatus": "approved"          // Phase 2: new field
      }
    ],
    "total": 6,
    "page": 1,
    "limit": 20,
    "hasMore": false
  }
}
```

**Updated detail response (Phase 2):**

```
GET /api/v1/marketplace/templates/billing-support-agent

Response 200:
{
  "success": true,
  "data": {
    "template": {
      ...full template fields...,
      "media": [...],                       // replaces screenshots
      "prerequisites": { ... },             // new
      "reviewStatus": "approved"            // new
    },
    "version": {
      "version": "1.0.0",
      "changelog": "Initial release",
      "manifest": { ... }                   // ProjectManifestV2 (files EXCLUDED)
    }
  }
}
```

**Updated categories with type filter:**

```
GET /api/v1/marketplace/categories?type=agent

Response 200:
{
  "success": true,
  "data": {
    "categories": [
      { "name": "customer-service", "count": 3 },
      { "name": "sales", "count": 2 }
    ]
  }
}
```

### Concern 3: Storage Architecture

**Phase 3 note:** No storage architecture changes. The inline bundle storage established in Phase 2 serves Phase 3 directly — Studio fetches the bundle server-side from the template-store, converts `Record<string, string>` to `Map<string, string>`, and passes it to `importProjectV2()`. No new storage is needed for install data; installed projects use the existing project data collections.

**Inline bundle storage** (chosen over object storage for Phase 2):

- `TemplateVersion.files`: `Record<string, string>` stored directly in the MongoDB document
- Keys are relative paths from the project root (e.g., `agents/my_agent.agent.abl`)
- Values are file content strings (ABL DSL, JSON, YAML)
- **Size limit**: 4MB per version, validated at seed/publish time
- **Headroom**: 4MB bundle + ~1KB manifest + overhead is well within MongoDB's 16MB document limit
- **Scale target**: <50 templates in Phase 2 (all platform-seeded). This storage model is appropriate for this scale.

**Why inline storage works for Phase 2:**

1. No external dependency (S3/MinIO) — simpler ops for a seed-data-only phase
2. Atomic reads — the entire bundle is one document read, no multi-step retrieval
3. Simple retrieval — `TemplateVersion.findOne({ templateId, version }).select('files')`
4. Migration path is clean — Phase 4 moves to S3/CDN by changing only the storage and retrieval layer

**Manifest convenience copy:**

- `TemplateVersion.manifest` stores a parsed `ProjectManifestV2` at the document top level
- Enables efficient queries: `manifest.layers_included`, `manifest.agents`, `manifest.metadata.entity_counts`
- `files["project.json"]` is the canonical source; `manifest` is derived at seed/publish time
- If they diverge, `files` wins — the install flow reads `files`, not `manifest`

**Media asset storage:**

```
URL pattern: /assets/templates/<slug>/<filename>
Examples:
  /assets/templates/billing-support-agent/hero.png
  /assets/templates/billing-support-agent/demo.mp4
```

- Served via `express.static` on the template-store Express app
- Static file serving is mounted BEFORE the API routes in the middleware chain (no auth, no rate limit)
- Files stored on local filesystem at `apps/template-store/src/assets/templates/`
- Phase 2 only stores platform-seeded assets — no user uploads
- **CDN migration** (Phase 4): change the URL prefix in `media[].url` entries. No code changes needed beyond URL rewriting.

**Size limits:**

| Resource         | Limit | Enforcement                       |
| ---------------- | ----- | --------------------------------- |
| `files` bundle   | 4MB   | Seed/publish-time                 |
| Individual file  | None  | Implicitly capped by bundle limit |
| Media image      | 5MB   | Seed script                       |
| Media video      | 50MB  | Seed script                       |
| MongoDB document | 16MB  | MongoDB native limit              |

### Concern 4: Integration (project-io + Studio Import Infrastructure)

**The cardinal design constraint**: `TemplateVersion.files` → `Map<string, string>` → `importProjectV2()` with **zero content transformation**.

**`importProjectV2` signature** (from `packages/project-io/src/import/project-importer-v2.ts`):

```typescript
export async function importProjectV2(
  files: Map<string, string>,
  existingState: ExistingProjectStateV2,
  options: ImportOptionsV2,
  deps: ImportV2Deps,
): Promise<ImportResultV2>;
```

**Conversion at install time** (Phase 3, one line):

```typescript
const fileMap = new Map(Object.entries(templateVersion.files));
// Pass directly to importProjectV2 — no content manipulation
```

**Conflict strategies by template type:**

| Template Type | `conflictStrategy` | `layers`                            | Rationale                      |
| ------------- | ------------------ | ----------------------------------- | ------------------------------ |
| `project`     | `'replace'`        | All from `manifest.layers_included` | Clean slate — new project      |
| `agent`       | `'merge'`          | `['core']`                          | Additive into existing project |

**Coupling analysis:**

- `TemplateVersion.files` format is coupled to `importProjectV2()`'s expected input format
- This is intentional and desirable — the whole point is zero-transformation install
- If `importProjectV2` changes its file format, the seed script must be updated to produce the new format
- The `manifest.format_version: '2.0'` field tracks compatibility
- `importProjectV2` already handles `stripCommonPrefix()` internally, so template files use clean relative paths

**What the existing import pipeline handles:**

- Path normalization and common prefix stripping
- Format detection (v1 vs v2 manifest)
- DSL parsing and validation
- Dependency graph resolution
- Layer-by-layer staging and activation
- Conflict resolution (replace/skip/merge)
- Binding resolution requests (searchai indexes, workflow triggers)
- Post-import report generation (provisioning_required)

**What template install does NOT need to implement** (already in project-io):

- DSL parsing — `importProjectV2` does it
- Dependency validation — `importProjectV2` does it
- Layer assembly — `importProjectV2` does it
- Error handling — `ImportResultV2` includes `issues`, `hasBlockingIssues`, `warnings`

**Phase 3: Studio ↔ Template-Store Integration**

The install flow introduces a new integration pattern: Studio makes server-side HTTP requests to the template-store service. This is NOT a proxy passthrough from the browser — Studio's route handlers fetch the bundle internally.

```
Studio install route handler
  │
  ├── 1. Bundle fetch (server-side HTTP)
  │   GET http://${TEMPLATE_STORE_URL}/api/v1/marketplace/templates/:slug/versions/:version/bundle
  │   • Uses the TEMPLATE_STORE_URL environment variable (default: http://localhost:3115)
  │   • No auth headers needed (bundle endpoint is public in Phase 2)
  │   • Response: { success: true, data: { files: Record<string, string> } }
  │   • Error: 404 if template/version not found → propagated as 404 to client
  │   • Error: network failure → propagated as 502 to client
  │
  ├── 2. Import pipeline wiring (reuses existing Studio infrastructure)
  │   • loadStudioLayeredImportExistingState({ projectId, tenantId })
  │     → Queries 30+ MongoDB collections for current project state
  │   • createStudioLayeredImportDeps({ projectId, tenantId })
  │     → Builds disassemblers, db adapter, cross-ref resolver
  │   • previewStudioLayeredImportV2() / applyStudioLayeredImportV2()
  │     → High-level wrappers that call importProjectV2 with Studio-specific wiring
  │
  └── 3. Install event notification (server-side HTTP, fire-and-forget)
      POST http://${TEMPLATE_STORE_URL}/api/v1/marketplace/templates/:slug/install-event
      • Sent after successful import, before responding to the client
      • Failure does NOT cause the install to fail — logged and ignored
      • Auth: JWT forwarded from the original request
```

**Phase 3: Studio import support functions used (from layered-import-support.ts):**

| Function                                 | Used By                          | Purpose                                        |
| ---------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `previewStudioLayeredImportV2()`         | Agent preview route              | Dry-run import with merge strategy, core layer |
| `applyStudioLayeredImportV2()`           | Agent apply route, project route | Full import with staged activate + rollback    |
| `loadStudioLayeredImportExistingState()` | Both (called internally)         | Load active records from 30+ collections       |
| `createStudioLayeredImportDeps()`        | Both (called internally)         | Build disassemblers + db adapter + cross-ref   |
| `buildLayeredAppliedCounts()`            | Both (called internally)         | Count agents/tools/locales created/updated     |

These are the SAME functions used by the existing manual import UI (`POST /api/projects/:id/import/preview` and `/apply`). The template install routes differ only in how files are sourced (from template-store instead of user upload) and the conflict strategy used.

### Concern 5: Security

**Phase 1 (unchanged):** All public GET, no auth required, `optionalAuth` for analytics enrichment.

**Phase 2 additions:**

- **`reviewStatus` field**: Foundation for community template governance. All platform-seeded templates default to `'approved'`. Browse queries enforce `reviewStatus: 'approved'` (or omit the filter for platform data where all are approved). Phase 3+ community publishing will use `'pending'` + admin review.

- **DSL validation at seed/publish time**: ABL DSL content in `files` bundles is validated via `@abl/core` parse at seed time. This catches syntax errors, malformed agent definitions, and invalid tool configurations before they enter the catalog. The `abl_version` field in the manifest tracks grammar version compatibility.

- **Bundle content scanning** (Phase 2 seed-time only, Phase 3+ community publishing):
  - File type validation: only `.abl`, `.yaml`, `.json`, `.txt` allowed in bundles
  - No executable content (`.js`, `.ts`, `.sh`, `.py`) in bundles
  - Size validation: 4MB total per `files` bundle
  - No path traversal in file keys: reject `../` or absolute paths

- **Bundle endpoint**: Public in Phase 2 (same as browse). Auth gating added in Phase 3 when install flow is built — install requires authenticated user + project permissions.

- **Static asset serving**: `express.static` serves media files without auth. Content is platform-owned. Phase 3+ community publishing will require upload scanning (virus scan, content moderation).

**Phase 3 additions:**

- **Auth gating on install routes**: All three install endpoints require JWT Bearer token authentication via `requireTenantAuth` / `withRouteHandler`. Browse endpoints remain public and unauthenticated.

- **Permission model:**

  | Route                                           | Auth Pattern                                                        | Permission Required | Rationale                                |
  | ----------------------------------------------- | ------------------------------------------------------------------- | ------------------- | ---------------------------------------- |
  | `POST /api/template-install/project`            | `requireTenantAuth` + `hasPermission('project:create')`             | `project:create`    | Creating a new project                   |
  | `POST /api/template-install/agent/[id]/preview` | `withRouteHandler({ requireProject, permissions: PROJECT_READ })`   | `PROJECT_READ`      | Reading target project state for dry-run |
  | `POST /api/template-install/agent/[id]/apply`   | `withRouteHandler({ requireProject, permissions: PROJECT_IMPORT })` | `PROJECT_IMPORT`    | Modifying target project data            |
  | `POST /api/v1/.../install-event`                | `requireAuth` (template-store middleware)                           | Authenticated user  | Recording install metrics                |

- **Project isolation**: Agent install routes use `withRouteHandler({ requireProject: true })` which resolves the project from `projectId` in the body, verifies the user has access, and returns 404 for cross-tenant requests (not 403 — prevents existence leakage). This is the same pattern used by the existing import routes.

- **Rate limiting on install endpoints:**

  | Route                             | Limit      | Scope  | Rationale                                           |
  | --------------------------------- | ---------- | ------ | --------------------------------------------------- |
  | `/template-install/project`       | 5 req/60s  | tenant | Project creation is expensive (DB writes + import)  |
  | `/template-install/agent/preview` | 10 req/60s | tenant | Dry-run is read-heavy but not destructive           |
  | `/template-install/agent/apply`   | 5 req/60s  | tenant | Import is expensive (staged bulk writes + rollback) |
  | `/install-event`                  | 20 req/60s | IP     | Server-side fire-and-forget, must not bottleneck    |

- **Bundle endpoint remains public in Phase 3**: The bundle endpoint (`GET /bundle`) stays public because the install routes fetch bundles server-side (Studio → template-store, never browser → template-store). Adding auth to the bundle endpoint would require Studio to forward JWT tokens to the template-store service, adding complexity without security benefit since the bundles contain only public DSL content.

- **No privilege escalation via install**: Installing a template does not grant the installing user any additional permissions. The installed project inherits the creating user's tenant context. Agent installs into existing projects require `PROJECT_IMPORT` — the same permission needed for manual file import.

### Concern 6: Performance

**Phase 1 targets (maintained):** p95 <200ms for browse endpoints.

**Phase 2 additions:**

| Metric                      | Target | How Achieved                                                |
| --------------------------- | ------ | ----------------------------------------------------------- |
| Browse response time (p95)  | <200ms | MongoDB projection excludes `files` (up to 4MB per version) |
| Detail response time (p95)  | <200ms | Version response excludes `files`; manifest included        |
| Bundle retrieval time (p95) | <500ms | Single document read, `select('files')` projection          |
| Static asset response time  | <100ms | `express.static` with filesystem read                       |

**Phase 3 additions:**

| Metric                           | Target | How Achieved                                                     |
| -------------------------------- | ------ | ---------------------------------------------------------------- |
| Project install end-to-end (p95) | <5s    | Bundle fetch (<500ms) + project creation (<200ms) + import (<4s) |
| Agent install preview (p95)      | <3s    | Bundle fetch (<500ms) + dry-run import (<2.5s)                   |
| Agent install apply (p95)        | <5s    | Bundle fetch (<500ms) + staged import with activate (<4.5s)      |
| Install event recording          | <100ms | Fire-and-forget atomic $inc + event insert                       |

**Bundle fetch latency in install flow:**

The install routes fetch the bundle server-side from the template-store. This is a loopback HTTP request (Studio → localhost:3115), adding ~50-100ms network overhead on top of the MongoDB read time. For bundles up to 4MB, the total fetch time stays under 500ms. This is acceptable because:

1. Install is a low-frequency operation (5 req/60s rate limit per tenant)
2. The bundle is fetched once per install, not repeatedly
3. The import pipeline itself (disassembly, staging, activation) dominates the total latency

**Import pipeline performance:**

The import pipeline's performance is already established by the existing manual import UI:

- **Dry-run (preview)**: Reads existing state from 30+ collections, disassembles files, resolves cross-references, generates diff — typically 1-3s for a template with ~5 agents
- **Apply**: Preview + staged writes + activate — typically 2-5s. Dominated by the number of MongoDB bulk write operations (one per layer per entity type)
- **Rollback**: If activation fails, staged records are deleted and superseded records are restored — adds ~1-2s to failure cases

**Caching considerations for install:**

- The install routes do NOT cache bundles. Each install re-fetches the bundle to ensure freshness.
- If the same template is installed by multiple users simultaneously, each gets its own bundle fetch. At <50 templates with low install frequency, this is not a concern.
- Phase 4 can add a short-lived server-side cache (TTL=60s) keyed by `slug+version` if install volume warrants it.

**Projection optimization (critical for Phase 2):**

Browse and detail endpoints MUST use MongoDB projection to exclude the `files` field from `TemplateVersion` documents. Without projection, every browse response would load potentially 4MB of file content per template — destroying browse performance.

```
// Browse: exclude files from version join
TemplateVersion.findOne({ templateId, status: 'published' })
  .select('-files')
  .sort({ createdAt: -1 })
  .lean()

// Bundle: include ONLY files
TemplateVersion.findOne({ templateId, version })
  .select('files')
  .lean()
```

**Bundle endpoint caching considerations:**

- Bundle responses are large (up to 4MB) but immutable (templates are versioned)
- `Cache-Control: public, max-age=86400` is appropriate for bundle responses
- CDN caching in Phase 4 will offload bundle retrieval from the service
- No server-side cache in Phase 2 — MongoDB reads are fast enough for <50 templates

### Concern 7: Scalability

**Current scale:** <50 templates, all platform-seeded. Inline MongoDB storage is appropriate.

**Scalability limits of inline storage:**

| Metric                  | Current Limit | When It Matters                |
| ----------------------- | ------------- | ------------------------------ |
| Bundle size per version | 4MB           | Phase 2 — projects ~50 agents  |
| Templates in catalog    | ~1,000        | Phase 4 — community publishing |
| MongoDB document size   | 16MB          | Never — 4MB cap + overhead     |
| Concurrent bundle reads | ~100/s        | Phase 3 — install traffic      |

**Phase 3: Concurrent install considerations:**

- **No import locking needed**: Each install creates a new project (project installs) or uses the existing `StagedImporter` (agent installs) which handles concurrency via shadow projectIds. Two users installing the same template simultaneously get separate import operations with isolated staging.
- **Agent installs on the same project**: The `StagedImporter` in `layered-import-support.ts` uses per-operation shadow projectIds (`projectId:__abl_import_staging__:operationId`). If two users try to install different agent templates into the same project simultaneously, the staged import mechanism handles this — each operation stages records under its own shadow key. However, activation conflicts are possible (one operation supersedes records that the other is also trying to modify). The `previewDigest` mechanism detects this: the second apply will fail with `PREVIEW_STALE` if the project state changed between preview and apply.
- **Rate limiting prevents abuse**: 5 installs per 60s per tenant keeps concurrent install volume manageable.
- **installCount atomicity**: `Template.installCount` uses MongoDB atomic `$inc`, so concurrent installs on the same template don't lose counts.

**Phase 4 migration path to object storage:**

When the catalog grows beyond ~1,000 templates or community publishing drives higher install traffic:

1. Add S3/MinIO storage for `files` bundles
2. `TemplateVersion.files` becomes `TemplateVersion.bundleRef: { bucket, key, size, sha256 }`
3. Bundle endpoint reads from S3 instead of MongoDB
4. `importProjectV2()` call site unchanged — it still receives `Map<string, string>`
5. Media assets move to CDN — URL prefix change in `media[].url`

This is a storage-layer-only change. No API contract changes. No `importProjectV2` changes.

### Concern 8: Migration

**Phase 3: No data migration needed.** The install flow operates on existing schema — no new fields, no schema changes. The `installCount` field already exists with default 0. The `install` analytics event type is a new value in an existing field (`eventType`). No drop-and-re-seed, no migration scripts.

**Phase 2 Strategy: Drop and Re-seed** (for reference)

All current template data is platform-owned seed data with placeholder content. No user-generated content exists. The migration is:

1. **Drop** all documents from `templates` and `template_versions` collections
2. **Re-seed** using the rewritten seed script that produces:
   - Templates with `media[]` (replaces `screenshots[]`), `prerequisites`, `reviewStatus`
   - TemplateVersions with typed `ProjectManifestV2` manifests and `files` bundles containing valid ABL DSL
3. **Analytics events** (`template_analytics_events`) are NOT dropped — they remain for historical metrics. `templateId` references may become orphaned but analytics events are loosely coupled by design (nullable `templateId`).
4. **Indexes** are auto-created by Mongoose schema definitions — no manual index migration needed.

**Why drop-and-re-seed is safe:**

- All templates are platform-seeded — zero user-generated content
- No external consumers depend on specific template IDs
- Analytics events use nullable references (no cascading deletes)
- Seed script is idempotent (upsert by slug)

**Backwards compatibility:**

- `screenshots[]` → `media[]` is a breaking API change
- Acceptable because: (a) Phase 1 data is all platform-seeded, (b) no external consumers, (c) Studio UI is updated in the same release
- `media` array is a superset of `screenshots` — images have `type: 'image'`, adding video support

### Concern 9: Observability

**Phase 1 (maintained):** Structured logging, request ID, traceparent, analytics events, health probes.

**Phase 2 additions:**

| Signal                  | Type             | Details                                                      |
| ----------------------- | ---------------- | ------------------------------------------------------------ |
| Bundle access tracking  | Analytics event  | `bundle_access` event when bundle endpoint is hit            |
| Bundle size in logs     | Structured log   | Log `bundleSize` (byte count) on bundle retrieval            |
| Projection verification | Integration test | Tests verify `files` is NOT in browse/detail responses       |
| Seed script validation  | Structured log   | Log validation results (DSL parse, manifest structure, size) |
| Static asset 404s       | Structured log   | Log when media asset not found on disk                       |

**Phase 3 additions:**

| Signal                     | Type            | Details                                                                    |
| -------------------------- | --------------- | -------------------------------------------------------------------------- |
| Install analytics event    | Analytics event | `install` event with userId, tenantId, projectId, templateSlug, version    |
| Install count increment    | DB operation    | Atomic `$inc` on `Template.installCount` after successful install          |
| Install route logging      | Structured log  | Log install start, bundle fetch, import result, install-event notification |
| Bundle fetch latency       | Structured log  | Log duration of server-side bundle fetch from template-store               |
| Import pipeline result     | Structured log  | Log agents/tools created/updated/deleted, entry agent name                 |
| Install failure tracking   | Structured log  | Log failure stage (bundle_fetch, project_creation, import, event_notify)   |
| Runtime cache invalidation | Structured log  | Log when model policy changes trigger runtime model cache invalidation     |

**New analytics event type (Phase 2):**

```
eventType: 'bundle_access'
metadata: { slug, version, bundleSizeBytes }
```

**New analytics event type (Phase 3):**

```
eventType: 'install'
metadata: {
  userId: string,
  tenantId: string,
  projectId: string,
  version: string,
  templateType: 'project' | 'agent',
  agentsCreated: number,
  toolsCreated: number
}
```

**Install error tracking structure:**

Each install route logs failures at specific stages with structured context:

```
log.error('Template install failed', {
  stage: 'bundle_fetch' | 'project_creation' | 'import_preview' | 'import_apply' | 'event_notify',
  templateSlug,
  version,
  projectId,
  tenantId,
  error: message,
  durationMs
})
```

### Concern 10: Error Handling

**Phase 1 error model (maintained):** `AppError` → `errorToResponse()` → standard envelope.

**Phase 2 error scenarios:**

| Scenario                           | Status | Code               | Message                                     |
| ---------------------------------- | ------ | ------------------ | ------------------------------------------- |
| Bundle endpoint: slug not found    | 404    | `NOT_FOUND`        | "Template not found"                        |
| Bundle endpoint: version not found | 404    | `NOT_FOUND`        | "Template version not found"                |
| Bundle endpoint: invalid version   | 400    | `VALIDATION_ERROR` | "Invalid version format"                    |
| Seed: DSL validation failure       | N/A    | Script error       | Logged + skipped (does not enter catalog)   |
| Seed: manifest parse failure       | N/A    | Script error       | Logged + skipped                            |
| Seed: bundle exceeds 4MB           | N/A    | Script error       | Logged + skipped                            |
| Seed: malformed file keys          | N/A    | Script error       | Logged + skipped (path traversal, absolute) |
| Stale DSL (old grammar version)    | N/A    | Warning            | Flagged in manifest, not auto-removed       |

**Phase 3 error scenarios:**

| Scenario                                 | Status | Code                   | Message                                        | Recovery                                          |
| ---------------------------------------- | ------ | ---------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Bundle fetch: template not found         | 404    | `NOT_FOUND`            | "Template or version not found"                | User retries with correct slug/version            |
| Bundle fetch: template-store unavailable | 502    | `BAD_GATEWAY`          | "Template store service unavailable"           | Retry later; service may be restarting            |
| Bundle fetch: network timeout            | 502    | `BAD_GATEWAY`          | "Template store request timed out"             | Retry; check template-store health                |
| Project creation: duplicate slug         | 409    | `CONFLICT`             | "A project with this slug already exists"      | User chooses a different project name             |
| Project creation: permission denied      | 403    | `FORBIDDEN`            | "Missing required permission (project:create)" | User needs project:create role                    |
| Import preview: blocking issues          | 400    | `VALIDATION_FAILED`    | "Import preview contains blocking issues"      | Show issues to user; template may be incompatible |
| Import apply: preview stale              | 409    | `PREVIEW_STALE`        | "Project state changed since preview"          | Re-run preview then apply                         |
| Import apply: pipeline failure           | 500    | `IMPORT_APPLY_FAILED`  | "Import failed during apply"                   | Automatic rollback; staged records deleted        |
| Import apply: rollback failure           | 500    | `INTERNAL_ERROR`       | "Import rollback failed"                       | Alert ops; check import_operations collection     |
| Install event: notification failure      | N/A    | (logged, not surfaced) | "Failed to notify template-store of install"   | Install succeeds; count updated later             |
| Agent install: project not found         | 404    | `NOT_FOUND`            | "Project not found"                            | User selects a valid project                      |
| Agent install: insufficient permissions  | 403    | `FORBIDDEN`            | "Missing required permission (PROJECT_IMPORT)" | User needs PROJECT_IMPORT on the project          |

**Error handling strategy by stage:**

```
POST /api/template-install/project
  Stage 1: Auth + validation → 401/403/400 (standard middleware)
  Stage 2: Bundle fetch → 404/502 (propagated from template-store response)
  Stage 3: Project creation → 409/500 (propagated from createProject)
  Stage 4: Import → 400/500 (propagated from importProjectV2)
    If import fails AFTER project creation:
    → Project exists but is empty (no agents/tools imported)
    → NOT auto-deleted: user can retry import manually via the import UI
    → Logged as partial install with projectId for debugging
  Stage 5: Install event → failure logged but NOT surfaced to user
```

**Stale bundle handling (agent install):**

If a template is updated between agent preview and agent apply:

- The `previewDigest` mechanism detects the mismatch
- Apply returns 409 `PREVIEW_STALE`
- The UI re-fetches the bundle and re-runs preview automatically
- This is the same mechanism used by the manual import UI

**Stale template handling:**

Templates authored against older ABL grammar versions are identified by `manifest.abl_version`. They are:

- Flagged with a warning in seed script output
- Still served in browse results (they may still be installable)
- NOT auto-removed — the platform team decides whether to update or archive

### Concern 11: Testing Strategy

**Phase 1 tests (maintained):** 45 integration tests, 42 UI component tests, 23 E2E test cases.

**Phase 2 test additions:**

| #   | Scenario                                             | Type        | Validates                                        |
| --- | ---------------------------------------------------- | ----------- | ------------------------------------------------ |
| 15  | Browse excludes `files` from response (projection)   | Integration | `files` key absent in browse response templates  |
| 16  | Bundle endpoint returns `files` for valid version    | Integration | Full `files` object returned, correct structure  |
| 17  | Bundle endpoint returns 404 for unknown version      | Integration | Error envelope with `NOT_FOUND` code             |
| 18  | Detail response includes `media` and `prerequisites` | Integration | New fields present and correctly shaped          |
| 19  | Seed script produces valid manifests and bundles     | Integration | `ProjectManifestV2` validates, DSL parses clean  |
| 20  | Media gallery renders images and video               | Unit        | Video poster frames, inline playback             |
| 21  | Prerequisites section renders categorized lists      | Unit        | All prerequisite categories displayed            |
| 22  | Type filter tabs filter templates correctly          | E2E         | Tab clicks update query and results              |
| 23  | Bundle size validation rejects oversized bundles     | Unit        | 4MB limit enforced at seed/publish time          |
| 24  | Categories endpoint respects type filter             | Integration | `?type=agent` returns agent-only category counts |
| 25  | Detail response excludes `files` from version        | Integration | Version object has `manifest` but not `files`    |

**Testing the `files` → `importProjectV2` pipeline:**

- Phase 2 tests validate that `files` bundles are well-formed (valid paths, parseable content)
- Phase 3 tests validate the end-to-end install: `files` → `Map<string, string>` → `importProjectV2()` → project created
- The separation keeps Phase 2 tests independent of the import pipeline internals

**Phase 3 test additions:**

| #   | Scenario                                               | Type        | Validates                                                      |
| --- | ------------------------------------------------------ | ----------- | -------------------------------------------------------------- |
| 26  | Project install: auth required                         | Integration | 401 returned without JWT                                       |
| 27  | Project install: permission check                      | Integration | 403 without project:create permission                          |
| 28  | Project install: happy path creates project + imports  | Integration | Project created, agents/tools populated, import counts correct |
| 29  | Project install: template not found                    | Integration | 404 when slug doesn't exist                                    |
| 30  | Project install: duplicate project slug                | Integration | 409 when project slug already exists                           |
| 31  | Project install: template-store unavailable            | Integration | 502 when bundle fetch fails                                    |
| 32  | Project install: install event recorded                | Integration | installCount incremented, analytics event created              |
| 33  | Agent install preview: shows correct diff              | Integration | Preview lists agents/tools to add, no data written             |
| 34  | Agent install preview: project permission check        | Integration | 403 without PROJECT_READ on target project                     |
| 35  | Agent install apply: merges into existing project      | Integration | Agents/tools added, existing data preserved                    |
| 36  | Agent install apply: preview digest validation         | Integration | 409 when project state changed between preview and apply       |
| 37  | Agent install apply: rollback on failure               | Integration | Staged records cleaned up, existing data restored              |
| 38  | Install CTA adapts by template type                    | Unit        | Project shows "Create Project", agent shows "Add to Project"   |
| 39  | Project selector shows user's projects                 | Unit        | Dropdown populated from GET /api/projects                      |
| 40  | Post-install checklist shows provisioning requirements | Unit        | Env vars, connectors, auth profiles displayed                  |
| 41  | Install flow: project template end-to-end              | E2E         | Click install → project created → navigated to dashboard       |
| 42  | Install flow: agent template end-to-end                | E2E         | Select project → preview → confirm → agents added              |
| 43  | Install event endpoint: installCount atomicity         | Integration | Concurrent installs correctly increment count                  |
| 44  | Install event endpoint: auth required                  | Integration | 401 without JWT                                                |
| 45  | Post-install report: provisioning requirements derived | Integration | Prerequisites cross-referenced with import result              |

### Concern 12: Deployment

**Phase 2 requires NO new services.** All changes are within existing packages:

| Package               | Change Type        | Build Impact               |
| --------------------- | ------------------ | -------------------------- |
| `packages/database`   | Schema updates     | Rebuild required           |
| `apps/template-store` | API + seed updates | Rebuild + re-seed required |
| `apps/studio`         | UI updates         | Rebuild required           |
| `packages/i18n`       | New keys           | Rebuild required           |

**Phase 2 deployment sequence:**

1. Deploy updated `packages/database` (schema changes)
2. Deploy updated `apps/template-store` (API changes + static assets)
3. Run seed script (`pnpm seed` in template-store) — drops + re-seeds
4. Deploy updated `apps/studio` (UI changes)

**Phase 2 rollback:**

- Phase 2 changes are backward-compatible at the API level (new fields are additive for browse)
- The `screenshots[]` → `media[]` rename is breaking but only affects the Studio UI (updated in the same release)
- Rollback: revert all three packages and re-run the Phase 1 seed script

**Phase 3 requires NO new services.** All changes are new routes in existing packages:

| Package               | Change Type                     | Build Impact     |
| --------------------- | ------------------------------- | ---------------- |
| `apps/studio`         | 3 new API routes + UI updates   | Rebuild required |
| `apps/template-store` | 1 new API route (install-event) | Rebuild required |
| `packages/i18n`       | New keys (install UI strings)   | Rebuild required |

**Phase 3 deployment sequence:**

1. Deploy updated `apps/template-store` (new install-event endpoint)
2. Deploy updated `apps/studio` (new install routes + UI)

Order matters: template-store must be deployed first so the install-event endpoint exists when Studio starts sending install notifications. If Studio is deployed first, install events will fail silently (fire-and-forget with error logging) — installs will work but installCount won't increment until template-store catches up.

**Phase 3 rollback:**

- Phase 3 is fully backward-compatible: removing the install routes and UI does not affect browse/detail functionality
- The install-event endpoint on template-store can remain deployed without Studio calling it (no side effects)
- Projects created by template install persist as normal projects — they are not linked to the template and don't need cleanup
- Rollback: revert Studio and template-store to Phase 2 versions

---

## 5. Data Model

### Collections

#### `templates`

| Field                | Type     | Required | Notes                                                                          |
| -------------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `_id`                | string   | yes      | uuidv7                                                                         |
| `slug`               | string   | yes      | Unique, URL-safe identifier                                                    |
| `name`               | string   | yes      | Display name                                                                   |
| `shortDescription`   | string   | yes      | Card-level summary                                                             |
| `longDescription`    | string   | yes      | Detail page full description                                                   |
| `type`               | string   | yes      | `'agent'` or `'project'`                                                       |
| `typeMetadata`       | Mixed    | no       | Polymorphic: `{ type, agentCount, hasSupervisor, hasFlow }`                    |
| `detailSections`     | string[] | no       | Section IDs for composable detail page                                         |
| `category`           | string   | yes      | Primary category                                                               |
| `subcategory`        | string   | no       | Optional subcategory                                                           |
| `industries`         | string[] | no       | Industry tags                                                                  |
| `tags`               | string[] | no       | Searchable tags                                                                |
| `complexity`         | string   | yes      | `'starter'`, `'standard'`, `'advanced'`                                        |
| `publisherId`        | string   | yes      | Publisher user ID                                                              |
| `publisherTenantId`  | string   | yes      | Publisher's tenant                                                             |
| `publisherName`      | string   | yes      | Display name                                                                   |
| `publisherVerified`  | boolean  | no       | Verified publisher badge                                                       |
| `visibility`         | string   | no       | `'public'` for Phases 1-2                                                      |
| `status`             | string   | no       | `'published'` for Phases 1-2                                                   |
| `reviewStatus`       | string   | no       | **Phase 2**: `'approved'` / `'pending'` / `'rejected'` (default: `'approved'`) |
| `installCount`       | number   | no       | Denormalized (Phase 3)                                                         |
| `activeInstallCount` | number   | no       | Denormalized (Phase 3)                                                         |
| `viewCount`          | number   | no       | Incremented on detail view                                                     |
| `ratingAverage`      | number   | no       | Denormalized (Phase 5+)                                                        |
| `ratingCount`        | number   | no       | Denormalized (Phase 5+)                                                        |
| `featuredOrder`      | number   | no       | Null = not featured; lower = higher priority                                   |
| `media`              | array    | no       | **Phase 2**: `[{ type, url, thumbnailUrl?, caption, order }]`                  |
| `prerequisites`      | object   | no       | **Phase 2**: `{ envVars, connectors, mcpServers, authProfiles, models }`       |
| `demoConversation`   | array    | no       | `[{ role, content }]`                                                          |
| `iconUrl`            | string   | no       | Template icon                                                                  |
| `publishedAt`        | Date     | no       | When published                                                                 |
| `deprecatedAt`       | Date     | no       | When deprecated                                                                |
| `deprecationMessage` | string   | no       | Reason for deprecation                                                         |
| `sourceId`           | string   | no       | Source project/agent ID (set at packaging time, Phase 3)                       |
| `sourceType`         | string   | no       | `'project'` or `'agent'` (Phase 3)                                             |
| `_v`                 | number   | no       | Document version for optimistic concurrency                                    |

**Indexes:**

- `{ slug: 1 }` — unique
- `{ type: 1, category: 1, status: 1 }` — browse filtering (Phase 2: type filter uses this)
- `{ status: 1, visibility: 1 }` — published+public filter
- `{ publisherTenantId: 1 }` — publisher lookup
- `{ tags: 1 }` — tag filtering
- `{ name: 'text', shortDescription: 'text', tags: 'text' }` — full-text search

#### `template_versions`

| Field                 | Type   | Required | Notes                                                                              |
| --------------------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `_id`                 | string | yes      | uuidv7                                                                             |
| `templateId`          | string | yes      | FK to `templates._id`                                                              |
| `version`             | string | yes      | Semver string                                                                      |
| `changelog`           | string | yes      | Release notes                                                                      |
| `manifest`            | Mixed  | yes      | **Phase 2**: Typed as `ProjectManifestV2` — parsed copy of `files["project.json"]` |
| `files`               | Mixed  | yes      | **Phase 2**: `Record<string, string>` — import-ready bundle (max 4MB)              |
| `customizationSchema` | Mixed  | no       | Install customization (Phase 3)                                                    |
| `status`              | string | no       | Version status                                                                     |
| `publishedAt`         | Date   | no       | When this version was published                                                    |
| `createdBy`           | string | yes      | Author user ID                                                                     |
| `_v`                  | number | no       | Document version for optimistic concurrency                                        |
| `createdAt`           | Date   | auto     | Mongoose timestamps                                                                |
| `updatedAt`           | Date   | auto     | Mongoose timestamps                                                                |

**Indexes:**

- `{ templateId: 1, version: 1 }` — unique (one version string per template)
- `{ templateId: 1, status: 1 }` — version lookup by status

#### `template_analytics_events`

| Field          | Type   | Required | Notes                                                                                                                      |
| -------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `_id`          | string | yes      | uuidv7                                                                                                                     |
| `eventType`    | string | yes      | `'marketplace_view'`, `'detail_view'`, `'search'`, `'category_browse'`, `'bundle_access'` (Phase 2), `'install'` (Phase 3) |
| `templateId`   | string | no       | Null for non-template events (search, browse)                                                                              |
| `templateSlug` | string | no       | For correlation                                                                                                            |
| `userId`       | string | no       | Null for unauthenticated visitors                                                                                          |
| `tenantId`     | string | no       | Null for unauthenticated visitors                                                                                          |
| `metadata`     | Mixed  | no       | Event-specific data (search query, category, filters, bundleSizeBytes)                                                     |
| `ipHash`       | string | no       | One-way hash, not reversible                                                                                               |
| `userAgent`    | string | no       | Fingerprinting concern — consider dropping (GAP-004)                                                                       |
| `createdAt`    | Date   | yes      | TTL index: auto-expires after 90 days                                                                                      |

**Indexes:**

- `{ eventType: 1, createdAt: -1 }` — event type queries
- `{ templateId: 1, eventType: 1 }` — per-template analytics
- `{ createdAt: 1 }` — **TTL: 7,776,000 seconds (90 days)**

### Modified Collections

None. All existing collections (outside template-store) are unaffected.

### Key Relationships

```
templates (1) ──────── (N) template_versions
    │                         via templateId
    │                         Phase 2: version stores files + typed manifest
    │
    │ Phase 2: template.prerequisites derived from
    │          version.manifest.metadata at seed time
    │
    └──── (N) template_analytics_events
                via templateId (loose, nullable)
                Phase 2: +bundle_access event type

TemplateVersion.files["project.json"]
    ↔ TemplateVersion.manifest (convenience copy; files is canonical)

TemplateVersion.files (at install time, Phase 3)
    → Map<string, string>
    → importProjectV2(files, existingState, options, deps)
    → ImportResultV2
```

No foreign key enforcement (MongoDB). Referential integrity maintained at the application/repo layer.

---

## 6. API Design

### Endpoints (Template Store Service — Port 3115)

| Method | Path                                                           | Purpose                                         | Auth          | Phase |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- | ------------- | ----- |
| GET    | `/api/v1/marketplace/templates`                                | Browse templates (paginated, filtered)          | None (public) | 1     |
| GET    | `/api/v1/marketplace/templates/:slug`                          | Template detail + current version (no `files`)  | None (public) | 1     |
| GET    | `/api/v1/marketplace/categories`                               | List categories with template counts            | None (public) | 1     |
| GET    | `/api/v1/marketplace/featured`                                 | Featured templates ordered by `featuredOrder`   | None (public) | 1     |
| GET    | `/api/v1/marketplace/templates/:slug/versions/:version/bundle` | Return only `files` field for install retrieval | None (public) | 2     |
| POST   | `/api/v1/marketplace/templates/:slug/install-event`            | Record install count + analytics event          | JWT required  | 3     |
| GET    | `/assets/templates/<slug>/<filename>`                          | Static media files (images, videos)             | None          | 2     |
| GET    | `/health`                                                      | Liveness probe                                  | None          | 1     |
| GET    | `/ready`                                                       | Readiness probe                                 | None          | 1     |

### Endpoints (Studio — Install Routes)

| Method | Path                                       | Purpose                                     | Auth                              | Phase |
| ------ | ------------------------------------------ | ------------------------------------------- | --------------------------------- | ----- |
| POST   | `/api/template-install/project`            | Create project + import project template    | JWT + `project:create`            | 3     |
| POST   | `/api/template-install/agent/[id]/preview` | Preview agent template install into project | JWT + `PROJECT_READ` on project   | 3     |
| POST   | `/api/template-install/agent/[id]/apply`   | Apply agent template install into project   | JWT + `PROJECT_IMPORT` on project | 3     |

### Request/Response Shapes

**Browse templates (Phase 2 — with type filter):**

```
GET /api/v1/marketplace/templates?page=1&limit=20&type=agent&category=customer-service&complexity=starter&q=billing&sort=popular

Response 200:
{
  "success": true,
  "data": {
    "templates": [
      {
        "slug": "billing-support-agent",
        "name": "Billing Support Agent",
        "shortDescription": "...",
        "type": "agent",
        "typeMetadata": { "type": "agent", "agentCount": 1 },
        "category": "customer-service",
        "complexity": "starter",
        "tags": ["billing", "support"],
        "publisherName": "ABL Platform",
        "publisherVerified": true,
        "installCount": 0,
        "viewCount": 42,
        "ratingAverage": 0,
        "featuredOrder": null,
        "iconUrl": null,
        "media": [
          { "type": "image", "url": "/assets/templates/billing-support-agent/hero.png", "caption": "Dashboard view", "order": 1 }
        ],
        "prerequisites": {
          "envVars": ["OPENAI_API_KEY"],
          "connectors": [],
          "mcpServers": [],
          "authProfiles": [],
          "models": ["gpt-4o"]
        },
        "reviewStatus": "approved"
      }
    ],
    "total": 6,
    "page": 1,
    "limit": 20,
    "hasMore": false
  }
}
```

**Template detail (Phase 2 — with media, prerequisites, no files):**

```
GET /api/v1/marketplace/templates/billing-support-agent

Response 200:
{
  "success": true,
  "data": {
    "template": {
      "slug": "billing-support-agent",
      "name": "Billing Support Agent",
      ...full template fields...,
      "media": [
        { "type": "image", "url": "/assets/templates/billing-support-agent/hero.png", "caption": "Dashboard", "order": 1 },
        { "type": "video", "url": "/assets/templates/billing-support-agent/demo.mp4", "thumbnailUrl": "/assets/templates/billing-support-agent/demo-thumb.png", "caption": "Demo walkthrough", "order": 2 }
      ],
      "prerequisites": {
        "envVars": ["OPENAI_API_KEY"],
        "connectors": [],
        "mcpServers": [],
        "authProfiles": [],
        "models": ["gpt-4o"]
      },
      "reviewStatus": "approved"
    },
    "version": {
      "version": "1.0.0",
      "changelog": "Initial release",
      "manifest": {
        "format_version": "2.0",
        "name": "Billing Support Agent",
        "layers_included": ["core"],
        "agents": { ... },
        "metadata": { ... }
      }
    }
  }
}

Response 404:
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Template not found" }
}
```

Note: `version.manifest` is returned but `version.files` is NOT — `files` is only available via the bundle endpoint.

**Bundle retrieval (Phase 2 — new):**

```
GET /api/v1/marketplace/templates/billing-support-agent/versions/1.0.0/bundle

Response 200:
{
  "success": true,
  "data": {
    "files": {
      "project.json": "{ \"format_version\": \"2.0\", ... }",
      "agents/billing-agent.agent.abl": "AGENT billing-agent\n  MODEL gpt-4o\n  ...",
      "tools/billing-lookup.tool.yaml": "name: billing-lookup\ntype: http\n..."
    }
  }
}

Response 404:
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Template version not found" }
}
```

**Categories (Phase 2 — with type filter):**

```
GET /api/v1/marketplace/categories?type=agent

Response 200:
{
  "success": true,
  "data": {
    "categories": [
      { "name": "customer-service", "count": 3 },
      { "name": "sales", "count": 2 },
      { "name": "hr", "count": 1 }
    ]
  }
}
```

**Featured templates:**

```
GET /api/v1/marketplace/featured

Response 200:
{
  "success": true,
  "data": {
    "templates": [
      { "slug": "...", "name": "...", "featuredOrder": 1, "media": [...], "prerequisites": {...}, ... },
      { "slug": "...", "name": "...", "featuredOrder": 2, ... }
    ]
  }
}
```

Note: Featured returns a flat array (no pagination) since featured templates are a small curated set (typically 3-6). Same template shape as browse results including Phase 2 fields.

### Analytics Event Fire Conditions

| Event Type         | When It Fires                                                                 | Triggered By                          | Phase |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------- | ----- |
| `marketplace_view` | Browse endpoint hit without filters (`GET /templates` with no `q`/`category`) | Server-side effect                    | 1     |
| `detail_view`      | Template detail endpoint hit (`GET /templates/:slug`)                         | Server-side effect                    | 1     |
| `search`           | Browse endpoint hit with search query (`GET /templates?q=...`)                | Server-side effect                    | 1     |
| `category_browse`  | Browse endpoint hit with category filter (`GET /templates?category=...`)      | Server-side effect                    | 1     |
| `bundle_access`    | Bundle endpoint hit (`GET /templates/:slug/versions/:version/bundle`)         | Server-side effect                    | 2     |
| `install`          | Successful template install (project or agent)                                | Studio POST to install-event endpoint | 3     |

### Query Parameter Validation (Zod)

```typescript
const BrowseQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['agent', 'project']).optional(),
  category: z.string().min(1).optional(),
  complexity: z.enum(['starter', 'standard', 'advanced']).optional(),
  q: z.string().min(1).max(200).optional(),
  sort: z.enum(['popular', 'rating', 'newest', 'updated']).default('popular'),
});

// Phase 2: Bundle endpoint params
const BundleParamSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  version: z
    .string()
    .min(1)
    .max(20)
    .regex(/^\d+\.\d+\.\d+$/),
});

// Phase 2: Categories type filter
const CategoriesQuerySchema = z.object({
  type: z.enum(['agent', 'project']).optional(),
});
```

### Error Responses

| Status | Code                | When                                                                                                                |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`  | Invalid query params (page < 1, invalid version format, etc.)                                                       |
| 404    | `NOT_FOUND`         | Template slug not found, version not found, unknown route. Standard `{ success, error: { code, message } }` format. |
| 429    | `TOO_MANY_REQUESTS` | Rate limit exceeded (100 req/60s/IP)                                                                                |
| 500    | `INTERNAL_ERROR`    | Unhandled server error                                                                                              |

### Studio Proxy (Existing)

| Studio Path             | Rewrites To                      |
| ----------------------- | -------------------------------- |
| `/api/template-store/*` | `http://localhost:3115/api/v1/*` |

---

## 7. Cross-Cutting Concerns

### Audit Logging

- **Phase 1**: Analytics events serve as the audit trail. `detail_view` events record which templates are viewed, by whom (if authenticated), and when.
- **Phase 2**: `bundle_access` event tracks bundle retrieval (who accessed which version's files).
- **Phase 3+**: Write operations (publish, update, archive) will use the platform's `logAuditEvent()` pattern.

### Rate Limiting

- 100 requests per 60-second sliding window per IP address
- In-memory storage (not shared across replicas — GAP-003, acceptable for Phase 1-2 single-pod)
- **Trust proxy**: `app.set('trust proxy', 1)` — trust one hop (K8s ingress) so `req.ip` uses the real client IP from `X-Forwarded-For`. Without this, clients can spoof IPs to bypass rate limits.
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`
- Map with 10,000 max entries, periodic eviction every 60s
- **Phase 2**: Rate limiting applies to the bundle endpoint. Static asset serving (`/assets/`) is NOT rate-limited (Express static middleware is mounted separately).

### Caching

- No explicit cache layer in Phases 1-2
- Browse responses are inherently cacheable (public, infrequently changing content)
- **Phase 2**: Bundle responses are immutable per version — ideal for `Cache-Control: public, max-age=86400`
- CDN/reverse-proxy caching can be added without code changes via `Cache-Control` headers (deferred — GAP-002)
- MongoDB query performance is sufficient for <1,000 templates with proper indexes

### Encryption

- **In transit**: HTTPS/TLS enforced at ingress (K8s/NGINX). Helmet adds HSTS in production.
- **At rest**: MongoDB Atlas encryption at rest (platform-level). No additional field-level encryption needed — template content is public.
- **Phase 2**: `files` bundles contain DSL content (not secrets). No field-level encryption needed.

### i18n

- 74+ keys in `packages/i18n/locales/en/marketplace.json`
- Covers: navigation, landing page, search, filters, template types, complexity levels, card components, detail page, categories, pagination, error states
- **Phase 2 additions**: keys for prerequisites section headers, media gallery controls, type filter tab labels, empty state for prerequisites
- Studio components use `useTranslation('marketplace')` from `next-intl`

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                             | Type              | Risk    | Notes                                                                                       |
| -------------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------- |
| MongoDB Atlas                          | Infrastructure    | Low     | Shared DB, already operational                                                              |
| `@agent-platform/database`             | Workspace package | Low     | Models exported from barrel; Phase 2 schema updates needed                                  |
| `@agent-platform/shared-auth`          | Workspace package | Low     | Auth middleware scaffolded                                                                  |
| `@agent-platform/shared-kernel`        | Workspace package | Low     | Error handling, AppError                                                                    |
| `@agent-platform/shared-observability` | Workspace package | Low     | Logging, request ID, tracing                                                                |
| `@agent-platform/config`               | Workspace package | Low     | Port constant already added                                                                 |
| `packages/project-io`                  | Workspace package | **Low** | **Phase 2**: `ProjectManifestV2` type; **Phase 3**: `importProjectV2()` for install         |
| `@abl/core`                            | Workspace package | Low     | **Phase 2**: DSL validation at seed time via `parse()`                                      |
| Studio proxy infrastructure            | Feature           | Low     | Proxy rule already wired; **Phase 3**: used for server-side bundle fetch                    |
| Studio import infrastructure           | Feature           | **Low** | **Phase 3**: `layered-import-support.ts` functions (preview, apply, deps) — confirmed ready |
| Studio project service                 | Feature           | Low     | **Phase 3**: `createProject()` for project template install — confirmed ready               |
| Studio auth / permissions              | Feature           | Low     | **Phase 3**: `requireTenantAuth`, `hasPermission`, `withRouteHandler` — confirmed ready     |

### Downstream (depends on this feature)

| Consumer                     | Impact                                                                    |
| ---------------------------- | ------------------------------------------------------------------------- |
| Studio UI                    | Marketplace pages consume browse API via proxy                            |
| Studio install routes        | **Phase 3**: 3 new routes consume bundle endpoint + import infrastructure |
| Marketing Website            | Will consume browse API directly (future, not yet built)                  |
| Phase 5 community publishing | Builds on `reviewStatus`, `prerequisites`, `media` fields                 |

---

## 9. Open Questions & Decisions Needed

### Resolved (Phase 2)

1. ~~**`userAgent` in analytics**~~: Deferred to Phase 3 — `userAgent` field remains in schema but storage is optional. Will revisit when community publishing adds GDPR scrutiny. (GAP-004)

2. ~~**Seed template content ownership**~~: Resolved — engineering creates seed templates with real ABL DSL, manifests, and media as part of the Phase 2 seed script rewrite. (GAP-006)

3. ~~**Docker Compose entry**~~: DECIDED — added in Phase 1.

4. ~~**Storage for files bundles**~~: DECIDED — inline MongoDB storage for Phase 2 (see Concern 3: Storage Architecture). S3/CDN migration is Phase 4.

### Open

5. **Search relevance weighting**: The text index uses equal weights across `name`, `shortDescription`, and `tags`. Should we add weighted search (name: 10, tags: 5, description: 3) now, or defer tuning until real usage data exists? (GAP-010)

6. **Marketing website CORS**: When the marketing website goes live, does the API need response shape changes (pagination format, field names)?

7. **Model extraction for prerequisites**: How are model identifiers extracted from agent DSL for the `prerequisites.models` field? Options: (a) regex-based extraction from `MODEL` declarations, (b) use `@abl/core` parse to get structured model info. Recommendation: use `@abl/core` parse — it is already imported for DSL validation, and structured extraction is more reliable than regex. (GAP-014)

8. **Video hosting limits**: Phase 2 serves video files from local disk via Express. Maximum video file size? Duration limit? Recommendation: 50MB max file size (enforced in seed script), no duration limit. (GAP-013 related)

---

## 10. References

- Feature spec: `docs/features/template-store.md`
- Test spec: `docs/testing/template-store.md`
- Change manifest: `docs/specs/template-store.changes.md`
- Technical design: `explorations/2026-03-05-template-store-technical-design.md`
- Implementation plan: `explorations/2026-03-17-template-store-phased-implementation-plan.md`
- UX guidelines: `explorations/2026-03-18-template-store-ux-guidelines.md`
- Competitive research: `explorations/2026-03-04-ai-agent-template-store-marketplace-research.md`
- SDLC log: `docs/sdlc-logs/template-store/hld.log.md`
- Project-IO types: `packages/project-io/src/types.ts` (ProjectManifestV2, ImportOptionsV2, ImportResultV2)
- Import pipeline: `packages/project-io/src/import/project-importer-v2.ts` (importProjectV2 function)
