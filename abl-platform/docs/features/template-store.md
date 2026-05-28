# Feature: Template Store

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `customer experience`, `project lifecycle`, `agent lifecycle`, `enterprise`
**Package(s)**: `apps/template-store`, `packages/database`, `apps/studio`, `packages/config`, `packages/i18n`, `packages/project-io`
**Owner(s)**: `template-store-team`
**Testing Guide**: [../testing/template-store.md](../testing/template-store.md)
**Last Updated**: 2026-05-13

---

## 1. Introduction / Overview

### Problem Statement

New users face a cold-start problem when building agents on the ABL platform. Going from "signed up" to "running agent" requires understanding the DSL, configuring models, setting up tools, and wiring multi-agent orchestration — all before seeing any value. Enterprise teams compound this by duplicating effort across departments, building similar customer-service or HR agents from scratch. There is no way to share proven agent designs across teams or tenants, and no curated catalog of best-practice templates to accelerate onboarding.

### Goal Statement

The Template Store provides a marketplace for browsing, discovering, previewing, and installing reusable agent and project templates. Phase 1 delivered a read-only catalog experience. Phase 2 upgrades the data model to store import-ready bundles aligned with `ProjectManifestV2` (from `packages/project-io`), adds rich media support, prerequisite discovery, and a bundle retrieval API — laying the data foundation for the install flow. The north-star goal remains: reduce time-to-first-agent-session to under 5 minutes and drive 40%+ of new projects to be created from templates.

### Summary

The Template Store is an Express service (`apps/template-store/`, port 3115) providing a public API for browsing templates without authentication (consumable by both Studio and a future marketing website) and authenticated endpoints for publishing and installing (Phase 3). Phase 1 delivered: a curated catalog of platform-provided templates, a Studio marketplace UI with search/filter/detail pages, category browsing, view count tracking, and analytics events. Templates come in two types — `agent` (single agent) and `project` (multi-agent with optional supervisor) — with an extensible type handler registry designed for future types (`workflow` planned for Phase 4).

**Phase 2** (current) upgrades the storage layer: each `TemplateVersion` now stores a complete `files` bundle (`Record<string, string>`) that is fed DIRECTLY to `importProjectV2()` at install time with zero transformation. The `manifest` field is typed as `ProjectManifestV2` for query convenience. Templates also gain `media[]` (replacing `screenshots[]`), `prerequisites`, and `reviewStatus` fields. Browse APIs are updated to exclude the potentially large `files` field and support type-based filtering. A new bundle endpoint provides the `files` payload for install-time retrieval.

---

## 2. Scope

### Goals (Phase 1 — DONE)

- Provide a curated, browsable catalog of agent and project templates accessible from Studio and (future) marketing website
- Enable full-text search with filters by category, template type, and complexity level
- Display rich template detail pages with description, screenshots, demo conversation, agent summary, and configuration preview
- Track view counts and analytics events (marketplace views, searches, category browsing) with 90-day TTL
- Architect for extensibility: new template types can be added with a handler file and type metadata variant — no changes to core service/UI code
- Support public (unauthenticated) API access for marketing website integration

### Goals (Phase 2 — DONE)

- Store import-ready file bundles in `TemplateVersion.files` aligned with `ProjectManifestV2` format from `packages/project-io`
- Derive and display template prerequisites (required env vars, connectors, MCP servers, auth profiles, models) before install
- Support rich media (images AND videos) on template detail pages via unified `media[]` field
- Add `reviewStatus` field for future community template governance
- Serve file bundles via a dedicated bundle endpoint (separate from browse to avoid loading 4MB payloads on browse)
- Support type-based filtering (`?type=project` / `?type=agent`) across all browse/search endpoints
- Drop and re-seed all templates with proper `files` bundles and `ProjectManifestV2` manifests
- Serve media assets as static files via the template-store Express app

### Goals (Phase 3 — DONE)

- Enable one-click project template installation that creates a new project and imports the full bundle
- Enable agent template installation into an existing project with merge conflict strategy
- Show a dry-run preview of what will be added/modified before applying agent template installs
- Display a post-install report showing what still needs provisioning (env vars, connectors, auth profiles, MCP servers)
- Gate install actions behind authentication (browse remains public)
- Track install counts on successful installation
- Adapt the install CTA on the detail page based on template type (project vs agent)
- Template Store Manager — admin CRUD for workspace and superadmin template management (upload, edit, archive, list)

### Non-Goals (Out of Scope)

- **Template installation UX** — ~~Install button, project creation, and import orchestration are Phase 3~~ DONE in Phase 3
- **Template publishing/authoring** — ~~No user-submitted templates; catalog is seeded by platform team via seed script~~ Workspace admins can upload templates via the Templates Manager; community publishing is Phase 5
- **Ratings and reviews** — No review submission or rating display
- **Version management UI** — Templates have versions in the data model but no version picker or changelog UI
- **Admin review queue UI** — `reviewStatus` field added but no UI or workflow in Phase 2
- **Tenant catalog management** — No per-tenant template curation or visibility controls
- **Linked updates** — Fork-only model; installed copies are independent (no upstream sync)
- **Object storage for bundles** — File bundles stored inline in MongoDB (max 4MB per version, well within 16MB doc limit). S3/CDN migration is Phase 4+
- **Customization variables** — `customizationSchema` field exists but variable substitution before install is Phase 3+
- **Workflow templates** — `type: 'workflow'` is planned for Phase 4 (documented in Roadmap)

---

## 3. User Stories

### Phase 1 (DONE)

1. As a **new user**, I want to browse a catalog of pre-built agent templates so that I can find a starting point for my use case instead of building from scratch.
2. As a **team developer**, I want to search templates by category and complexity so that I can quickly find templates relevant to my department (sales, HR, customer service).
3. As a **team developer**, I want to view a template's detail page with screenshots, demo conversation, and configuration preview so that I can evaluate whether it fits my needs before deciding to install.
4. As a **marketing website visitor**, I want to browse the template catalog without signing in so that I can explore what the platform offers before committing to an account.
5. As a **tenant admin**, I want to see template type badges (Agent vs Project) and agent counts so that I can understand the complexity and scope of each template.
6. As a **platform operator**, I want view count and search analytics tracked with automatic 90-day expiry so that I can measure template discovery engagement without unbounded storage growth.

### Phase 2 (NEW)

7. As a **team developer**, I want to see what a template requires (environment variables, connectors, models) before installing so that I can prepare my environment ahead of time.
8. As a **team developer**, I want to filter templates by type (Agent vs Project) using tabs or a dropdown so that I can quickly narrow to the kind of template I need.
9. As a **team developer**, I want to view demo videos alongside screenshots on a template detail page so that I can see the template in action before deciding to install.
10. As a **platform operator**, I want template bundles stored in a format that the existing import pipeline consumes directly so that install is a zero-transformation operation.

### Phase 3 (NEW)

11. As a **team developer**, I want to install a project template to create a new project pre-configured with agents, tools, and settings so that I can go from template to running agent in minutes.
12. As a **team developer**, I want to install an agent template into an existing project so that I can add proven agent designs without rebuilding from scratch.
13. As a **team developer**, I want to see a preview of what will be added before installing an agent template so that I can understand the impact on my existing project.
14. As a **team developer**, I want to see a post-install checklist of what needs provisioning (env vars, connectors, auth profiles) so that I know exactly what to configure after install.
15. As a **platform operator**, I want install actions gated behind authentication while keeping browse public so that only authenticated users consume resources via installs.

---

## 4. Functional Requirements

### Phase 1 (DONE)

1. **FR-1**: The system must serve a public browse API (`GET /api/v1/marketplace/templates`) that returns paginated template listings without requiring authentication.
2. **FR-2**: The system must support filtering templates by `type` (agent/project), `category`, `complexity` (starter/standard/advanced), and free-text search across name, description, and tags.
3. **FR-3**: The system must return template detail by slug (`GET /api/v1/marketplace/templates/:slug`) including full description, media, demo conversation messages, type metadata, detail sections, prerequisites, and publisher information.
4. **FR-4**: The system must serve a categories endpoint (`GET /api/v1/marketplace/categories`) returning category names with template counts.
5. **FR-5**: The system must serve a featured endpoint (`GET /api/v1/marketplace/featured`) returning templates ordered by `featuredOrder`.
6. **FR-6**: The system must increment `viewCount` on the Template document when a detail page is viewed, and record a `detail_view` analytics event.
7. **FR-7**: The system must record analytics events (`marketplace_view`, `detail_view`, `search`, `category_browse`, `bundle_access`) with automatic 90-day TTL expiry.
8. **FR-8**: The system must rate-limit public browse endpoints at 100 requests per 60-second window per IP address, returning HTTP 429 on excess.
9. **FR-9**: The system must add `x-request-id` to all responses via `requestIdMiddleware`.
10. **FR-10**: The system must return errors in the standard format: `{ success: false, error: { code, message } }`.
11. **FR-11**: Studio must proxy requests from `/api/template-store/*` to the template store service at `TEMPLATE_STORE_URL` (default `http://localhost:3115`).
12. **FR-12**: Studio must provide a "Template Store" sidebar navigation entry that routes to the marketplace landing page.
13. **FR-13**: The marketplace landing page must display featured templates, a category grid with counts, and recent additions.
14. **FR-14**: Template cards must display a type badge ("Agent" in cyan or "Project" in purple), category badge, complexity indicator, and denormalized metrics (install count, rating).
15. **FR-15**: The template detail page must render composable sections based on the `detailSections` array from the API, supporting at minimum: `agent-summary`, `demo-conversation`, `config-preview`.

### Phase 2 (NEW)

16. **FR-16**: Each `TemplateVersion` must store a `files` field (`Record<string, string>`) containing the complete import-ready bundle. Keys are relative paths (e.g., `agents/my_agent.agent.abl`), values are file content strings.
17. **FR-17**: Each `TemplateVersion` must store a `manifest` field typed as `ProjectManifestV2` (from `packages/project-io/src/types.ts`), which is a parsed/validated copy of `files["project.json"]`.
18. **FR-18**: Browse endpoints (`GET /templates`, `GET /templates/:slug`, `GET /featured`) must EXCLUDE the `files` field from responses using MongoDB projection. The `files` field is potentially 4MB per template.
19. **FR-19**: A new `GET /api/v1/marketplace/templates/:slug/versions/:version/bundle` endpoint must return only the `files` field for a given template version, used at install time.
20. **FR-20**: The `Template` model must include a `prerequisites` field derived from the manifest metadata at seed/publish time, containing: `envVars`, `connectors`, `mcpServers`, `authProfiles`, and `models`.
21. **FR-21**: The `Template` model must replace `screenshots[]` with a unified `media[]` array supporting both images and videos, each with `type`, `url`, optional `thumbnailUrl`, `caption`, and `order`.
22. **FR-22**: The `Template` model must include a `reviewStatus` field (`'approved' | 'pending' | 'rejected'`) defaulting to `'approved'` for platform templates.
23. **FR-23**: The browse UI must support type filtering via tabs or filter controls for "All", "Projects", "Agents" (and "Workflows" in a future phase).
24. **FR-24**: The template detail page must display prerequisites in a clearly formatted section before any install action.
25. **FR-25**: The seed script must be rewritten to produce templates with proper `files` bundles containing valid ABL DSL content and `ProjectManifestV2` manifests.
26. **FR-26**: Bundle size must be validated at seed/publish time with a maximum of 4MB per `TemplateVersion.files`.
27. **FR-27**: Media assets (images/videos) must be served as static files via the template-store Express app at the path `/assets/templates/<slug>/<filename>`.

### Phase 3 (NEW)

28. **FR-28**: Project template install must create a new project via `POST /api/projects` (requires `project:create` permission), then import the full bundle via the layered import pipeline with `conflictStrategy: 'replace'` and all layers from the manifest.
29. **FR-29**: Agent template install must merge agent+tools into an existing project via the layered import pipeline with `conflictStrategy: 'merge'` and `layers: ['core']`, reusing the existing Studio import API routes (`POST /api/projects/:id/import/preview` and `POST /api/projects/:id/import/apply`).
30. **FR-30**: Agent template install must show a dry-run preview (via `POST /api/template-install/agent/[id]/preview`, which internally runs `previewStudioLayeredImportV2` in dry-run mode) before applying, showing what agents/tools will be added or modified. The user must confirm before the apply call proceeds.
31. **FR-31**: Both project and agent installs must return a post-install report showing what still needs provisioning: environment variables, connectors, MCP servers, and auth profiles. This is derived from the template's `prerequisites` field cross-referenced with the import result.
32. **FR-32**: All install endpoints must require authentication via JWT Bearer token (auto-attached by `apiFetch()`). Browse endpoints remain public and unauthenticated.
33. **FR-33**: On successful installation, the system must atomically increment `Template.installCount` and record an `install` analytics event (with `userId`, `tenantId`, `templateSlug`, and `projectId`).
34. **FR-34**: The install CTA on the template detail page must adapt based on template type: project templates show "Create Project from Template" (navigates to project creation flow), agent templates show "Add to Project" (opens a project selector dropdown, then preview, then confirm).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                        |
| -------------------------- | ------------ | ---------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Phase 2 stores import-ready bundles; Phase 3 install creates projects        |
| Agent lifecycle            | PRIMARY      | Templates contain agent definitions in import-ready ABL DSL format           |
| Customer experience        | PRIMARY      | Core discovery and onboarding experience for new and existing users          |
| Integrations / channels    | NONE         | Not channel-aware                                                            |
| Observability / tracing    | SECONDARY    | Analytics events, request ID propagation, observability middleware           |
| Governance / controls      | SECONDARY    | `reviewStatus` field added; Phase 3+ adds review pipeline, tenant governance |
| Enterprise / compliance    | SECONDARY    | Public API requires CORS, rate limiting; analytics events have PII concerns  |
| Admin / operator workflows | SECONDARY    | Phase 3+ adds admin review queue; Phase 1-2 are platform-team seeded         |

### Related Feature Integration Matrix

| Related Feature                                           | Relationship Type | Why It Matters                                                                     | Key Touchpoints                                                          | Current State               |
| --------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- |
| [Agent Development (Studio)](agent-development-studio.md) | extends           | Templates showcase agent configurations built using Studio                         | Template detail shows agent summary derived from DSL content             | No integration              |
| [Project Import/Export](project-import-export.md)         | **depends on**    | Template install calls `importProjectV2()` directly with the stored `files` bundle | `TemplateVersion.files` is the exact format `importProjectV2()` consumes | **Phase 2: data alignment** |
| [Reusable Agent Modules](reusable-agent-modules.md)       | extends           | Templates can include agents that use shared modules                               | Shared module references in template manifest                            | No integration              |
| [Memory & Sessions](memory-sessions.md)                   | configured by     | Phase 3 install wizard configures session/memory settings per template type        | Install customization schema may include memory config                   | No integration              |

---

## 6. Design Considerations

- **UX guidelines**: Documented in `explorations/2026-03-18-template-store-ux-guidelines.md` — design tokens, color usage, typography, layout/spacing, component specs
- **Composable detail page**: Detail sections are driven by the `detailSections` array from the API (populated by the type handler at packaging time). A section registry maps section IDs to React components. Adding a new template type's UI means registering new section components — no changes to the detail page layout.
- **Type badge design**: "Agent" renders in cyan/info palette, "Project" in purple. Both use `lucide-react` icons (`Bot` for agent, `FolderOpen` for project). See `apps/studio/src/components/marketplace/TemplateTypeBadge.tsx`.
- **Search UX**: 300ms debounce on search input, filter dropdowns for category/type/complexity, sort options (popular, rating, newest, updated).
- **Type filter tabs** (Phase 2): Browse UI gains tabs/filter for "All", "Projects", "Agents". The "Workflows" tab is hidden until Phase 4 adds `type: 'workflow'` support.
- **Prerequisites display** (Phase 2): Template detail page shows a prerequisites section (before any install CTA) listing required env vars, connectors, MCP servers, auth profiles, and models. Displayed as categorized chip lists or a structured table.
- **Media gallery** (Phase 2): The `TemplateScreenshotGallery` component is updated to handle both images and video. Videos show a poster frame (from `thumbnailUrl`) and play inline or in a lightbox.

---

## 7. Technical Considerations

- **Separate Express service**: The template store runs as an independent service (`apps/template-store/`, port 3115), not inside Studio. Driven by marketing website integration (public unauthenticated access), independent team ownership, and enterprise growth trajectory. See `explorations/2026-03-17-template-store-phased-implementation-plan.md` Key Design Decisions.
- **Extensible type system**: Three abstraction boundaries — polymorphic `typeMetadata` (schema layer), type handler registry (service layer), composable detail page sections (UI layer). Adding a new template type requires: one type metadata variant, one handler file, and section component registrations. No changes to existing services or pages.
- **Shared MongoDB instance**: Same database (`abl_platform`) as all other services. Template collections: `templates`, `template_versions`, `template_analytics_events`.
- **No tenant isolation plugin**: Templates span tenants by design (public visibility). Queries use explicit `status: 'published'` + `visibility: 'public'` filtering instead of the standard `tenantIsolationPlugin`.
- **Marketing website (coming soon)**: The public API and CORS configuration are future-proofing for a marketing website (separate repo, being built in parallel). The `MARKETING_SITE_URL` env var defaults to empty string; CORS allows configured origins in production.
- **i18n**: Marketplace UI strings are externalized to `packages/i18n/locales/en/marketplace.json` (74 keys covering nav, landing, search, filters, types, complexity, card, detail, categories, and error states). Studio's `i18n/request.ts` imports the `marketplace` namespace. All user-facing strings in marketplace components should use `useTranslation('marketplace')`. Phase 2 adds keys for prerequisites, media, and type filter tabs.

### Phase 2 Technical Decisions

- **`files` stored inline in MongoDB**: The `files` field (`Record<string, string>`) is stored directly in the `template_versions` document. Maximum bundle size is 4MB, well within MongoDB's 16MB document limit. This avoids the complexity of S3/MinIO for the seed-data-only Phase 2 use case. Future migration to CDN/S3 is straightforward since only the storage layer changes.
- **`manifest` is a convenience copy**: The `manifest` field stores a parsed/validated copy of `files["project.json"]` at the top level of the `TemplateVersion` document. This allows efficient querying without parsing JSON from the `files` map on every read. `files` is the canonical source of truth.
- **Browse endpoints exclude `files`**: All browse/detail endpoints use MongoDB projection (`.select('-files')` or equivalent) to exclude the potentially 4MB `files` field. A separate `/bundle` endpoint returns only the `files` field.
- **`project-io` integration**: The install flow (Phase 3) calls `importProjectV2(files, existingState, options, deps)` from `packages/project-io`. The function requires 4 arguments: the file map, existing project state (loaded from DB), import options (conflict strategy, layers, dry-run flag), and injected dependencies (DB adapter, disassemblers, cross-ref resolver). The `files` stored in `TemplateVersion` are in EXACTLY the format the first argument consumes — `Map<string, string>` where keys are relative paths. At install time, the `Record<string, string>` from MongoDB is converted to a `Map<string, string>` with zero content transformation. The remaining 3 arguments are assembled by the install service from the target project context.
- **Media assets via static files**: Images and videos are served via `express.static` at `/assets/templates/<slug>/<filename>`. URLs stored in `media[].url` use this path. Future CDN migration only requires changing the URL prefix.
- **DSL validation at seed/publish time**: ABL DSL content in the `files` bundle is validated via `@abl/core` parse at seed/publish time. The `abl_version` field in the manifest tracks grammar version compatibility. Stale templates (authored against older ABL grammar) are flagged but not auto-removed.
- **`screenshots[]` to `media[]` migration**: The `screenshots` field is replaced by `media` in the Template model. The seed script produces `media` entries. Existing API responses return `media` instead of `screenshots`. This is a breaking change but acceptable because Phase 1 data is all platform-seeded (drop and re-seed).

---

## 8. How to Consume

### Studio UI

| Route                              | Page            | Description                                               |
| ---------------------------------- | --------------- | --------------------------------------------------------- |
| `/marketplace`                     | Landing page    | Hero, featured templates, category grid, recent additions |
| `/marketplace/templates/[slug]`    | Detail page     | Tabs: Overview, Media, Config Preview, Changelog          |
| `/marketplace/category/[category]` | Category browse | Filtered templates with pagination                        |
| `/marketplace/search`              | Search results  | Full-text search with filter dropdowns                    |

Sidebar entry: "Template Store" (below Projects, above Settings), using `Store` or `LayoutGrid` icon from lucide-react.

### API (Template Store Service — Port 3115)

All Phase 1-2 browse endpoints are public (no auth required). The bundle endpoint is also public in Phase 2 (auth will be added in Phase 3 when install is gated).

| Method | Path                                                           | Purpose                                         | Phase |
| ------ | -------------------------------------------------------------- | ----------------------------------------------- | ----- |
| GET    | `/api/v1/marketplace/templates`                                | Browse templates (paginated, with filters)      | 1     |
| GET    | `/api/v1/marketplace/templates/:slug`                          | Template detail + current version (no `files`)  | 1     |
| GET    | `/api/v1/marketplace/categories`                               | List categories with template counts            | 1     |
| GET    | `/api/v1/marketplace/featured`                                 | Featured templates ordered by `featuredOrder`   | 1     |
| GET    | `/api/v1/marketplace/templates/:slug/versions/:version/bundle` | Return only `files` field for install retrieval | 2     |
| GET    | `/health`                                                      | Health check                                    | 1     |
| GET    | `/ready`                                                       | Readiness check                                 | 1     |

### API (Studio)

Studio proxies to the template store service via Next.js middleware:

| Pattern                 | Target                                    |
| ----------------------- | ----------------------------------------- |
| `/api/template-store/*` | `TEMPLATE_STORE_URL/api/v1/*` (port 3115) |

### Admin Portal — Template Store Manager (Phase 3 — DONE)

The Template Store Manager provides admin CRUD for templates at two levels:

**Superadmin Portal** (`apps/admin/`):

- BFF routes at `/api/template-admin/templates` proxy to template-store admin API
- Superadmin can manage all platform templates with `publisherTenantId` override
- Uses `tenantId` query param workaround (superadmin JWT has platform tenantId, not workspace tenantId)

**Workspace Admin** (`apps/studio/` admin section):

- Templates Manager page at workspace admin Settings > Templates Manager
- Upload templates from project export zips (client-side zip extraction with fflate)
- Edit template metadata (name, description, category, tags, complexity, status) via edit dialog
- Archive templates with confirmation dialog
- Table displays: Name, Type, Category, Status (colored badge), Downloads, Created date
- Tenant-scoped: workspace admins see only their tenant's templates

**Admin API** (`apps/template-store/src/routes/admin.ts`):
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/admin/templates` | List templates (tenant-scoped) |
| POST | `/api/v1/admin/templates/upload` | Upload new template from zip |
| PATCH | `/api/v1/admin/templates/:id` | Update template metadata |
| DELETE | `/api/v1/admin/templates/:id` | Archive/delete template |

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable. The template store is not channel-aware and does not interact with runtime agent execution.

---

## 9. Data Model

### Collections / Tables

```text
Collection: templates
Fields:
  - _id: string (uuidv7)
  - slug: string (required, unique)
  - name: string (required)
  - shortDescription: string (required)
  - longDescription: string (required)
  - type: string (required) — 'agent' | 'project'
  - typeMetadata: Mixed (nullable) — polymorphic: { type, agentCount, hasSupervisor, hasFlow }
  - detailSections: string[] — e.g., ['agent-summary', 'demo-conversation', 'config-preview']
  - category: string (required)
  - subcategory: string | null
  - industries: string[]
  - tags: string[]
  - complexity: string (required) — 'starter' | 'standard' | 'advanced'
  - publisherId: string (required)
  - publisherTenantId: string (required)
  - publisherName: string (required)
  - publisherVerified: boolean
  - visibility: string — 'draft' | 'unlisted' | 'team-scoped' | 'tenant-wide' | 'public'
  - status: string — 'draft' | 'submitted' | ... | 'published' | 'archived'
  - reviewStatus: string — 'approved' | 'pending' | 'rejected' (default: 'approved')  [Phase 2]
  - installCount: number
  - activeInstallCount: number
  - viewCount: number
  - ratingAverage: number
  - ratingCount: number
  - featuredOrder: number | null
  - publishedAt: Date | null
  - deprecatedAt: Date | null
  - deprecationMessage: string | null
  - sourceId: string | null
  - sourceType: string | null
  - media: [{                          [Phase 2 — replaces screenshots]
      type: 'image' | 'video',
      url: string,
      thumbnailUrl?: string,           // video poster frame
      caption: string,
      order: number,
    }]
  - prerequisites: {                   [Phase 2]
      envVars: string[],               // e.g., ['OPENAI_API_KEY']
      connectors: string[],            // e.g., ['Salesforce CRM']
      mcpServers: string[],
      authProfiles: string[],          // e.g., ['oauth-salesforce']
      models: string[],                // e.g., ['gpt-4o']
    }
  - demoConversation: [{ role, content }]
  - iconUrl: string | null
  - _v: number
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { slug: 1 } unique
  - { type: 1, category: 1, status: 1 }
  - { status: 1, visibility: 1 }
  - { publisherTenantId: 1 }
  - { tags: 1 }
  - { name: 'text', shortDescription: 'text', tags: 'text' }

Collection: template_versions
Fields:
  - _id: string (uuidv7)
  - templateId: string (required)
  - version: string (required, semver)
  - changelog: string (required)
  - manifest: ProjectManifestV2 (required)     [Phase 2 — typed as ProjectManifestV2]
      Fields from ProjectManifestV2 include:
        format_version: '2.0'
        name, slug, description, abl_version, exported_at, exported_by
        entry_agent, dsl_format, layers_included
        agents: Record<string, ManifestAgent>
        tools: Record<string, ManifestTool>
        behavior_profiles?: Record<string, ManifestBehaviorProfile>
        metadata: {
          entity_counts, required_env_vars, required_connectors,
          required_mcp_servers, required_auth_profiles?
        }
  - files: Record<string, string> (required)   [Phase 2]
      Complete import-ready file bundle.
      Keys: relative paths (e.g., 'project.json', 'agents/my_agent.agent.abl')
      Values: file content strings.
      Max size: 4MB. Fed directly to importProjectV2() at install time.
  - customizationSchema: Mixed | null           [Phase 3+]
  - status: string
  - publishedAt: Date | null
  - createdBy: string (required)
  - _v: number
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { templateId: 1, version: 1 } unique
  - { templateId: 1, status: 1 }

Collection: template_analytics_events
Fields:
  - _id: string (uuidv7)
  - eventType: string (required) — 'marketplace_view' | 'detail_view' | 'search' | 'category_browse' | 'bundle_access' | 'install'
  - templateId: string | null
  - templateSlug: string | null
  - userId: string | null (nullable for unauthenticated)
  - tenantId: string | null (nullable for unauthenticated)
  - metadata: Mixed | null
  - ipHash: string | null (one-way hash, not reversible)
  - userAgent: string | null
  - createdAt: Date
Indexes:
  - { eventType: 1, createdAt: -1 }
  - { templateId: 1, eventType: 1 }
  - { createdAt: 1 } TTL: 90 days (7,776,000 seconds)
```

### Key Relationships

- `TemplateVersion.templateId` → `Template._id` (one-to-many, one version per template in Phases 1-2)
- `TemplateVersion.files["project.json"]` ↔ `TemplateVersion.manifest` (manifest is a parsed convenience copy; `files` is canonical)
- `Template.prerequisites` ← derived from `TemplateVersion.manifest.metadata` at seed/publish time
- `Template.sourceId` → project or agent ID (set at packaging time, Phase 3)
- `TemplateAnalyticsEvent.templateId` → `Template._id` (loose reference, nullable for non-template events like search)
- No foreign key enforcement (MongoDB) — referential integrity maintained at the application layer

### Phase 2 Schema Changes Summary

| Model           | Change                                  | Migration      |
| --------------- | --------------------------------------- | -------------- |
| Template        | `screenshots[]` → `media[]`             | Drop + re-seed |
| Template        | ADD `prerequisites` (embedded object)   | Drop + re-seed |
| Template        | ADD `reviewStatus` (string, default)    | Drop + re-seed |
| TemplateVersion | `manifest` typed as `ProjectManifestV2` | Drop + re-seed |
| TemplateVersion | ADD `files` (`Record<string, string>`)  | Drop + re-seed |

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                             | Purpose                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/database/src/models/template.model.ts`                 | Template Mongoose schema and model                      |
| `packages/database/src/models/template-version.model.ts`         | TemplateVersion Mongoose schema and model               |
| `packages/database/src/models/template-analytics-event.model.ts` | Analytics event model with 90-day TTL                   |
| `packages/project-io/src/types.ts`                               | `ProjectManifestV2` type (manifest schema reference)    |
| `apps/template-store/src/lib/db.ts`                              | MongoDB connection via MongoConnectionManager           |
| `apps/template-store/src/repos/template-repo.ts`                 | Browse queries, filter, search, pagination, projections |
| `apps/template-store/src/repos/analytics-repo.ts`                | Event tracking repository                               |

### Routes / Handlers

| File                                                  | Purpose                                                 |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `apps/template-store/src/routes/marketplace.ts`       | Public browse API endpoints + bundle endpoint (Phase 2) |
| `apps/template-store/src/routes/health.ts`            | Health and readiness probes                             |
| `apps/template-store/src/server.ts`                   | Express app with middleware chain + static assets       |
| `apps/template-store/src/config.ts`                   | Service configuration                                   |
| `apps/template-store/src/middleware/auth.ts`          | Unified auth middleware (for Phase 2+)                  |
| `apps/template-store/src/middleware/rate-limit.ts`    | Per-IP sliding window rate limiter                      |
| `apps/template-store/src/middleware/error-handler.ts` | Error handler using AppError/errorToResponse            |
| `apps/studio/src/proxy.ts`                            | Studio proxy: `/api/template-store/*` → port 3115       |

### UI Components

| File                                                                   | Purpose                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/studio/src/components/marketplace/TemplateTypeBadge.tsx`         | Type badge (Agent/Project)                       |
| `apps/studio/src/components/marketplace/TemplateCard.tsx`              | Template card for grid views                     |
| `apps/studio/src/components/marketplace/CategoryGrid.tsx`              | Category cards with icons and counts             |
| `apps/studio/src/components/marketplace/TemplateSearchBar.tsx`         | Search input + filter dropdowns                  |
| `apps/studio/src/components/marketplace/TemplateScreenshotGallery.tsx` | Media gallery (images + video) — renamed Phase 2 |
| `apps/studio/src/components/marketplace/DemoConversation.tsx`          | Sample conversation display                      |
| `apps/studio/src/components/marketplace/TemplateConfigPreview.tsx`     | Read-only config schema preview                  |
| `apps/studio/src/components/marketplace/MarketplaceLayout.tsx`         | Shared layout with breadcrumbs and search        |
| `apps/studio/src/store/marketplace-store.ts`                           | Zustand store for marketplace state              |
| `apps/studio/src/app/marketplace/layout.tsx`                           | Next.js layout for marketplace routes            |
| `apps/studio/src/app/marketplace/page.tsx`                             | Landing page                                     |
| `apps/studio/src/app/marketplace/templates/[slug]/page.tsx`            | Detail page                                      |
| `apps/studio/src/app/marketplace/category/[category]/page.tsx`         | Category browse page                             |
| `apps/studio/src/app/marketplace/category/page.tsx`                    | Category index page                              |
| `apps/studio/src/app/marketplace/search/page.tsx`                      | Search results page                              |

### Configuration / Infrastructure

| File                                        | Purpose                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `apps/template-store/Dockerfile`            | Multi-stage Docker build (builder → production → debug) |
| `apps/template-store/package.json`          | Service dependencies and scripts                        |
| `apps/template-store/tsconfig.json`         | TypeScript config with project references               |
| `packages/config/src/constants.ts`          | `DEFAULT_TEMPLATE_STORE_PORT = 3115`                    |
| `packages/i18n/locales/en/marketplace.json` | i18n keys for marketplace UI                            |

### Jobs / Workers / Background Processes

| File                                                | Purpose                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/template-store/src/scripts/seed-templates.ts` | Seed data script — rewritten in Phase 2 to produce `files` + `manifest` bundles |

### Tests

| File                                                             | Type        | Coverage Focus                                |
| ---------------------------------------------------------------- | ----------- | --------------------------------------------- |
| `apps/template-store/src/__tests__/routes/marketplace.test.ts`   | integration | Public browse API endpoints + bundle endpoint |
| `apps/template-store/src/__tests__/repos/template-repo.test.ts`  | unit        | Browse queries, filters, pagination           |
| `apps/template-store/src/__tests__/repos/analytics-repo.test.ts` | unit        | Event tracking                                |
| `apps/studio/src/__tests__/components/marketplace/*.test.tsx`    | unit        | UI component rendering                        |
| `apps/studio/src/__tests__/store/marketplace-store.test.ts`      | unit        | Zustand store actions and state               |
| `apps/studio/e2e/marketplace-*.spec.ts`                          | e2e         | Landing, detail, search, category, responsive |

---

## 11. Configuration

### Environment Variables

| Variable                  | Default                                                | Description                                    |
| ------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `PORT`                    | `3115`                                                 | HTTP port for template store service           |
| `HOST`                    | `0.0.0.0`                                              | Bind address                                   |
| `NODE_ENV`                | `development`                                          | Environment (development/production)           |
| `MONGODB_URL`             | `mongodb://abl_admin:...@localhost:27018/abl_platform` | MongoDB connection string                      |
| `MONGODB_DATABASE`        | `abl_platform`                                         | MongoDB database name                          |
| `JWT_SECRET`              | `dev-secret-change-in-production`                      | JWT secret for authenticated routes (Phase 3+) |
| `CORS_ORIGINS`            | (none)                                                 | Comma-separated allowed CORS origins           |
| `MARKETING_SITE_URL`      | (empty)                                                | Marketing website URL for CORS                 |
| `RATE_LIMIT_WINDOW_MS`    | `60000`                                                | Rate limit sliding window in ms                |
| `RATE_LIMIT_MAX_REQUESTS` | `100`                                                  | Max requests per window per IP                 |
| `TEMPLATE_STORE_URL`      | `http://localhost:3115`                                | Studio proxy target (set in Studio env)        |

### Runtime Configuration

No feature flags or tenant-level settings in Phases 1-2. All templates are platform-seeded with `status: 'published'`, `visibility: 'public'`, and `reviewStatus: 'approved'`.

### DSL / Agent IR / Schema

Phase 2 stores ABL DSL content inside `TemplateVersion.files` bundles. DSL content is validated via `@abl/core` parse at seed/publish time. The `abl_version` field in the `ProjectManifestV2` tracks grammar version compatibility. Stale templates (authored against older ABL grammar) should be flagged but not auto-removed.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | N/A for Phases 1-2 — templates are not project-scoped. Phase 3 install creates project-scoped resources with proper `projectId` filtering.                                                                                                                             |
| Tenant isolation  | Templates intentionally span tenants (`visibility: 'public'`). No `tenantIsolationPlugin` on the Template model. Browse API serves all published public templates regardless of tenant. Analytics events optionally include `tenantId` when the user is authenticated. |
| User isolation    | N/A for Phases 1-2 — no user-owned resources. Phase 3 adds user-scoped draft templates filtered by `publisherId`/`createdBy`, and user-scoped installations.                                                                                                           |

### Security & Compliance

- **Authentication**: Phases 1-2 endpoints are all public `GET` — no auth required. Auth middleware (`createUnifiedAuthMiddleware`) is scaffolded for Phase 3+.
- **Rate limiting**: Per-IP sliding window (100 req/60s) with in-memory storage (10K max buckets, TTL eviction). Returns HTTP 429 with standard error format.
- **CORS**: Production restricts to configured origins (`CORS_ORIGINS`, `MARKETING_SITE_URL`). Development allows all localhost origins.
- **PII considerations**: Analytics events store `ipHash` (one-way, not reversible) and `userAgent`. Both are nullable. The 90-day TTL limits retention. `userAgent` strings can be fingerprinting vectors — consider whether this field is necessary for Phase 1 analytics.
- **Input validation**: Route-level Zod validation for query parameters (pagination, filters). Slug and version format validated. Bundle size validated at seed/publish time (4MB max).
- **Helmet**: Security headers applied (HSTS in production, CSP disabled for API-only service).
- **Bundle content safety**: Phase 2 bundles are platform-seeded only. Phase 3+ community publishing will require content scanning (DSL validation, file type restrictions, size limits).

### Performance & Scalability

- **Pagination**: Default 20, max 100 items per page
- **MongoDB text index**: Unweighted text index across `name`, `shortDescription`, and `tags` (equal weight). Weighted search relevance is a future tuning opportunity (see Open Questions).
- **Response compression**: Enabled with 1KB threshold
- **Body parsing**: 10MB limit
- **Scale target**: <1,000 templates in Phases 1-2 (inline storage). Phase 4+ migrates to object storage if scale exceeds this.
- **Search debounce**: 300ms client-side debounce on search input
- **Caching**: No explicit cache layer in Phases 1-2. Browse responses are inherently cacheable (public, infrequently changing). CDN/reverse-proxy caching can be added without code changes.
- **Bundle size limit**: 4MB per `TemplateVersion.files`. Accommodates projects with up to ~50 agents and associated tools/configs comfortably. Well within MongoDB's 16MB document limit (the `files` field plus other version fields plus overhead).
- **Browse projection**: All browse/detail endpoints exclude `files` from MongoDB query results using projection, ensuring browse performance is unaffected by bundle size.

### Reliability & Failure Modes

- **Service unavailability**: Studio marketplace pages show loading/error state. Other Studio features are unaffected (template store is an independent service).
- **MongoDB connection failure**: Health check returns unhealthy. Liveness probe restarts the pod.
- **Rate limit exhaustion**: Returns 429 with `Retry-After` header. Legitimate users retry after window expires.
- **Graceful shutdown**: SIGTERM/SIGINT handlers with 10-second timeout for in-flight requests.
- **Bundle retrieval failure**: If the bundle endpoint fails or the version is not found, the install flow (Phase 3) shows an error and does not proceed.

### Observability

- **Request ID**: `x-request-id` header on all responses via `requestIdMiddleware`
- **W3C traceparent**: Propagated via `createObservabilityMiddleware` and `AsyncLocalStorage`
- **Structured logging**: `createLogger('template-store-server')` from `@agent-platform/shared-observability`
- **Analytics events**: `TemplateAnalyticsEvent` collection tracks marketplace engagement (views, searches, category browsing)
- **Health probes**: `/health` and `/ready` endpoints for K8s liveness/readiness

### Data Lifecycle

- **Analytics events**: 90-day TTL via MongoDB `expireAfterSeconds` index on `createdAt` (7,776,000 seconds)
- **Templates**: No automatic expiry. `status: 'archived'` soft-deletes templates from browse results. Hard deletion is a manual admin operation.
- **Template versions**: Retained indefinitely. One version per template in Phases 1-2.
- **View counts**: Denormalized on `Template.viewCount`. Atomic increment on each detail view.
- **File bundles**: Stored inline in `TemplateVersion.files`. No separate lifecycle — deleted with the version document. Max 4MB per version.
- **Media assets**: Static files on disk. No automatic cleanup — managed by seed script. Future CDN migration does not change the lifecycle.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1 (DONE)

Phase 1 is delivered in three stages: backend, frontend, and testing.

1. **Backend: Service scaffold + infrastructure** (DONE — LLD Phase 0, commit `e98b0813d`)
   1.1 Scaffold `apps/template-store/` — Express server, health route, DB connection, auth middleware, CORS, helmet, compression, observability
   1.2 Add `DEFAULT_TEMPLATE_STORE_PORT` (3115) to config constants
   1.3 Create Template, TemplateVersion, TemplateAnalyticsEvent Mongoose models
   1.4 Export models from `packages/database`
   1.5 Add Studio proxy config for `/api/template-store/*`
   1.6 Add template store to `docker-compose.yml`
   1.7 Create Dockerfile for template store
   1.8 Create rate limiting middleware

2. **Backend: Browse API + data layer** (DONE — LLD Phase 1, commit `3d455b72d`)
   2.1 Create `template-repo.ts` — browse queries, filter by type/category/complexity, pagination, text search
   2.2 Create `analytics-repo.ts` — event tracking (trackEvent)
   2.3 Create marketplace browse route — 4 public endpoints (templates list, templates/:slug, categories, featured)
   2.4 Wire marketplace route and rate limiter into server.ts
   2.5 Create seed data migration script (10 templates, both types)
   2.6 Dockerfile sync — add `COPY apps/template-store/package.json` to all app Dockerfiles

3. **Frontend: Studio marketplace UI** (DONE — LLD Phase 2, commit `c0c910207`)
   3.1 Create `marketplace-store.ts` (Zustand) — browse state, filters, detail, actions
   3.2 Create `TemplateCard` component
   3.3 Create `CategoryGrid` component
   3.4 Create `TemplateSearchBar` with filter dropdowns
   3.5 Create marketplace landing page (hero, featured, categories, recent)
   3.6 Create template detail page with composable tabs
   3.7 Create `TemplateScreenshotGallery` component
   3.8 Create `DemoConversation` component
   3.9 Create `TemplateConfigPreview` component
   3.10 Create category browse page
   3.11 Create search results page
   3.12 Add "Template Store" to UserMenu navigation (matches Academy pattern — not sidebar)

4. **Testing** (DONE — LLD Phase 3)
   4.1 API integration tests for public browse endpoints (45 tests passing)
   4.2 Unit tests for template-repo browse queries (passing)
   4.3 Unit tests for analytics-repo (passing)
   4.4 Frontend component tests — 7 component test files (42 tests passing)
   4.5 Zustand marketplace-store tests (passing)
   4.6 Playwright E2E: 5 spec files, 23 test cases (require running services)

### Phase 2 (DONE)

5. **Schema updates + migration**
   5.1 Update Template model: replace `screenshots[]` with `media[]`, add `prerequisites`, add `reviewStatus`
   5.2 Update TemplateVersion model: type `manifest` as `ProjectManifestV2`, add `files` field
   5.3 Update model barrel exports and TypeScript interfaces
   5.4 Build `packages/database` to propagate type changes

6. **Seed script rewrite**
   6.1 Rewrite `seed-templates.ts` to produce templates with real ABL DSL in `files` bundles
   6.2 Generate `ProjectManifestV2` manifests for each template
   6.3 Derive `prerequisites` from manifest `metadata` (env vars, connectors, MCP servers, auth profiles, models)
   6.4 Produce `media[]` entries (images and videos) with proper asset files
   6.5 Validate bundle sizes (< 4MB) and DSL syntax at seed time

7. **API updates**
   7.1 Update browse endpoints to exclude `files` from responses via MongoDB projection
   7.2 Update detail endpoint response to return `media` and `prerequisites` instead of `screenshots`
   7.3 Add `GET /templates/:slug/versions/:version/bundle` endpoint (returns `files` only)
   7.4 Add `type` query parameter support to categories endpoint (filter counts by type)
   7.5 Add static file serving for `/assets/templates/` media directory

8. **Frontend updates**
   8.1 Update `TemplateScreenshotGallery` to support `media[]` (images + video)
   8.2 Add prerequisites display section to template detail page
   8.3 Add type filter tabs/controls to browse and search pages
   8.4 Update Zustand store types for `media`, `prerequisites`, `reviewStatus`
   8.5 Add i18n keys for new UI elements

9. **Testing for Phase 2**
   9.1 Update integration tests for projection (verify `files` excluded from browse, included in bundle endpoint)
   9.2 Add integration tests for bundle endpoint
   9.3 Add integration tests for `prerequisites` and `media` in responses
   9.4 Update component tests for media gallery and prerequisites display
   9.5 Update E2E tests for type filter tabs and prerequisites section

---

## 14. Storage Architecture

### Bundle Storage

Template file bundles are stored inline in the `TemplateVersion.files` field as `Record<string, string>`:

```text
files: {
  "project.json": "{ \"format_version\": \"2.0\", ... }",
  "agents/billing-agent.agent.abl": "AGENT billing-agent\n  MODEL gpt-4o\n  ...",
  "agents/supervisor.agent.abl": "AGENT supervisor\n  ...",
  "tools/crm-lookup.tool.yaml": "name: crm-lookup\ntype: http\n...",
  "locales/en.json": "{ \"greeting\": \"Hello\" }"
}
```

- **Format**: Keys are relative paths from the project root. Values are file content strings.
- **Canonical source**: `files` is the single source of truth. `manifest` is a parsed copy of `files["project.json"]`.
- **Size limit**: 4MB per version. Validated at seed/publish time.
- **Install consumption**: At install time, convert `Record<string, string>` to `Map<string, string>` and pass as the first argument to `importProjectV2(files, existingState, options, deps)`. The install service assembles the remaining arguments (existing project state, import options, injected dependencies) from the target project context.

### Manifest Convenience Copy

The `manifest` field stores a parsed `ProjectManifestV2` for efficient querying without re-parsing `files["project.json"]`. Key fields used for queries and display:

- `layers_included`: which import layers the template covers
- `agents`: agent inventory for type metadata
- `metadata.required_env_vars`: feeds `prerequisites.envVars`
- `metadata.required_connectors`: feeds `prerequisites.connectors`
- `metadata.required_mcp_servers`: feeds `prerequisites.mcpServers`
- `metadata.required_auth_profiles`: feeds `prerequisites.authProfiles`
- `metadata.entity_counts`: for display stats

### Media Assets

Media files (images, videos) are served as static files from the template-store Express app:

```text
URL format: /assets/templates/<slug>/<filename>
Example: /assets/templates/billing-support-agent/hero.png
Example: /assets/templates/billing-support-agent/demo.mp4
```

- Storage: Local filesystem, served via `express.static`
- Migration path: Move to CDN/S3 by changing the URL prefix in `media[].url`
- Phase 2 only stores platform-seeded assets — no user uploads

---

## 15. Install Flow Design

> **Status**: IN PROGRESS — Phase 3 implementation underway.

The install flow leverages the existing `importProjectV2()` pipeline from `packages/project-io` with zero transformation of template content. Templates store their content in exactly the format the import pipeline consumes. Studio handles ALL install logic using existing infrastructure — the template-store service only provides the bundle.

### Architecture: Studio-Orchestrated Install

```text
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Studio UI   │────>│  Studio API      │────>│  Template Store   │
│  (browser)   │     │  (Next.js routes)│     │  (Express :3115)  │
└──────────────┘     └──────────────────┘     └──────────────────┘
                            │                         │
                            │  1. Fetch bundle         │
                            │  (server-side via proxy) │
                            │<────────────────────────│
                            │                         │
                            │  2. Create project (if project template)
                            │  3. Run importProjectV2() with bundle
                            │  4. Return install result
                            │
                     ┌──────▼──────────┐
                     │  MongoDB        │
                     │  (project data) │
                     └─────────────────┘
```

Key: Studio fetches the bundle SERVER-SIDE via the `/api/template-store/*` proxy to port 3115, NOT client-side. The client never receives the raw bundle.

### Project Template Installation (Phase 3)

```text
1. User clicks "Create Project from Template" on a project template detail page
2. UI calls POST /api/template-install/project (new Studio API route)
   Body: { templateSlug, version, projectName, projectSlug?, description? }
   Auth: JWT Bearer token (auto-attached by apiFetch())
3. Studio route handler (server-side):
   a. Validates auth (requireTenantAuth + hasPermission('project:create'))
   b. Fetches bundle: GET /api/template-store/marketplace/templates/:slug/versions/:version/bundle
      (server-side via proxy — forwards auth headers)
   c. Creates new project: calls createProject({ name, ownerId, tenantId })
      (same service as POST /api/projects — requires project:create permission)
   d. Assembles import context using layered-import-support.ts wiring:
      - existingState: loaded via loadStudioLayeredImportExistingState({ projectId, tenantId })
      - options: { projectId, tenantId, userId, conflictStrategy: 'replace',
                   layers: <all from manifest.layers_included>, dryRun: false }
      - deps: createStudioLayeredImportDeps({ projectId, tenantId })
   e. Calls importProjectV2(files, existingState, options, deps)
   f. Increments Template.installCount + records 'install' analytics event
4. Studio returns post-import result:
   {
     success: true,
     project: { id, name, slug },
     applied: { created, updated, toolsCreated, ... },
     entryAgentName: string | null,
     provisioningRequired: {
       envVars: string[],       // from template.prerequisites
       connectors: string[],
       mcpServers: string[],
       authProfiles: string[]
     }
   }
5. UI navigates to new project and shows post-install checklist
```

### Agent Template Installation (Phase 3)

```text
1. User clicks "Add to Project" on an agent template detail page
2. User selects target project from dropdown
3. Preview step — UI calls POST /api/projects/:id/import/preview (EXISTING Studio route)
   Body: { files: <bundle files>, layers: ['core'], deleteUnmatched: false }
   Auth: JWT Bearer token (requires PROJECT_READ permission)
   Note: Studio fetches the bundle server-side, then forwards files to the existing preview route
   Actually implemented as:
   a. UI calls POST /api/template-install/agent/[id]/preview (new Studio route)
      Body: { templateSlug, version, projectId }
   b. Studio route fetches bundle server-side, then calls previewStudioLayeredImportV2()
      with { files, projectId, tenantId, userId, conflictStrategy: 'merge', layers: ['core'] }
   c. Returns preview: what agents/tools will be added or modified
4. User reviews preview and confirms
5. Apply step — UI calls POST /api/template-install/agent/[id]/apply (new Studio route)
   Body: { templateSlug, version, projectId, previewDigest }
   Auth: JWT Bearer token (requires PROJECT_IMPORT permission)
   a. Studio route fetches bundle server-side, then calls applyStudioLayeredImportV2()
      with { files, projectId, tenantId, userId, conflictStrategy: 'merge', layers: ['core'],
             previewDigest }
   b. Increments Template.installCount + records 'install' analytics event
6. UI shows install result with post-install checklist
```

### Studio API Routes (Phase 3 — New)

| Method | Path                                       | Purpose                                     | Permission       |
| ------ | ------------------------------------------ | ------------------------------------------- | ---------------- |
| POST   | `/api/template-install/project`            | Create project + import project template    | `project:create` |
| POST   | `/api/template-install/agent/[id]/preview` | Preview agent template install into project | `PROJECT_READ`   |
| POST   | `/api/template-install/agent/[id]/apply`   | Apply agent template install into project   | `PROJECT_IMPORT` |

These new routes orchestrate the install by:

1. Fetching the bundle server-side via the template-store proxy
2. Delegating to the existing `previewStudioLayeredImportV2()` / `applyStudioLayeredImportV2()` functions from `apps/studio/src/lib/project-import/layered-import-support.ts`
3. The existing functions handle all import complexity: disassembly, cross-ref resolution, staged import, rollback on failure

Note: The `importProjectV2()` function signature is `(files, existingState, options, deps)` — 4 arguments. The `previewStudioLayeredImportV2()` and `applyStudioLayeredImportV2()` convenience wrappers from `layered-import-support.ts` handle loading existing state and assembling deps internally.

### Key Install Design Decisions

- **Zero transformation**: `TemplateVersion.files` → `Map<string, string>` → first argument of `importProjectV2()`. No content manipulation needed. The remaining arguments (existingState, options, deps) are assembled by the install service from the target project context.
- **Conflict strategies**: Project templates use `replace` (clean slate). Agent templates use `merge` (additive into existing project).
- **Layer selection**: Project templates import all layers in the manifest. Agent templates import `core` only (agents + tools).
- **Dry-run preview**: Agent installs show a preview before applying. Project installs create a new project so no preview needed.
- **Post-install report**: Both flows return a `postImportReport` detailing what still needs provisioning (env vars, connectors, auth profiles, MCP servers).

---

## 16. Prerequisites

### How Prerequisites Are Derived

Prerequisites are derived from the `ProjectManifestV2.metadata` at seed/publish time and stored denormalized on the `Template` document:

| Prerequisite Field | Source in `ProjectManifestV2`                 |
| ------------------ | --------------------------------------------- |
| `envVars`          | `metadata.required_env_vars`                  |
| `connectors`       | `metadata.required_connectors`                |
| `mcpServers`       | `metadata.required_mcp_servers`               |
| `authProfiles`     | `metadata.required_auth_profiles[].name`      |
| `models`           | Extracted from agent DSL `MODEL` declarations |

### Display

Prerequisites are shown on the template detail page in a dedicated section before any install action. The UI renders each category as a labeled list:

- **Required Environment Variables**: chip list of env var names
- **Required Connectors**: chip list of connector names
- **Required MCP Servers**: chip list of server names
- **Required Auth Profiles**: chip list with auth type indicators
- **Required Models**: chip list of model identifiers

If all prerequisite arrays are empty, the section displays "No prerequisites — ready to install."

---

## 17. Success Metrics

| Metric                          | Baseline | Target        | How Measured                                                                             |
| ------------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------- |
| Time to first agent session     | >30 min  | <5 min        | Timestamp delta: signup → first agent session via template (**measurable from Phase 3**) |
| Projects created from templates | 0%       | 40%+          | `templateOrigin` field on Project model (**measurable from Phase 3**)                    |
| Marketplace page views/month    | 0        | 5,000+        | `marketplace_view` analytics events                                                      |
| Template detail view rate       | N/A      | 30%+ of views | `detail_view` / `marketplace_view` ratio                                                 |
| Search-to-detail conversion     | N/A      | 20%+          | `detail_view` following `search` event                                                   |
| API response time (p95)         | N/A      | <200ms        | Observability metrics on browse endpoints                                                |
| Bundle retrieval time (p95)     | N/A      | <500ms        | Observability metrics on bundle endpoint (Phase 2)                                       |

---

## 18. Open Questions

1. ~~**`userAgent` in analytics events**~~: Deferred to Phase 3 — `userAgent` field remains in schema but storage is optional. Will revisit when community publishing adds GDPR scrutiny. (GAP-004)
2. **Search relevance tuning**: The current text index uses equal weights across `name`, `shortDescription`, and `tags`. Should we add weighted search (e.g., name: 10, tags: 5, shortDescription: 3) for better relevance ranking, or defer tuning until real usage data is available?
3. ~~**CDN/caching layer**~~: Deferred to Phase 4. Static media assets are served via Express for Phase 2; CDN migration is a URL prefix change.
4. ~~**Seed template content**~~: Resolved — engineering creates seed templates with real ABL DSL, manifests, and media as part of the Phase 2 seed script rewrite. (GAP-006 resolved.)
5. **Marketing website timeline**: The marketing website is confirmed as "coming soon" in a separate repo. When it goes live, does the template store public API need any changes (pagination format, response shape, CORS)?
6. **Model extraction for prerequisites**: How are model identifiers extracted from agent DSL for the `prerequisites.models` field? Regex-based extraction from `MODEL` declarations, or use `@abl/core` parse to get structured model info?
7. **Video hosting**: Phase 2 serves video files from local disk via Express. For templates with demo videos, what's the maximum video file size we should support? Should we enforce a duration limit?

---

## 19. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                          | Severity | Status        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------- |
| GAP-001 | ~~Template model `typeMetadata` typed as `Record<string, unknown> \| null` (was `any`)~~                                             | Medium   | Mitigated     |
| GAP-007 | ~~404 handler uses `AppError` + `errorToResponse` returning standard `{ success, error: { code, message } }` format~~                | High     | Mitigated     |
| GAP-002 | No explicit `Cache-Control` headers on browse responses                                                                              | Low      | Open          |
| GAP-003 | Rate limiter uses in-memory storage — not shared across service replicas in multi-pod deployment                                     | Medium   | Open          |
| GAP-004 | `userAgent` field in analytics events may have GDPR implications                                                                     | Medium   | Open (defer)  |
| GAP-005 | ~~Removed — both `/health` and `/ready` endpoints check MongoDB connectivity~~                                                       | N/A      | Mitigated     |
| GAP-006 | ~~Seed template content (DSL, screenshots, demo conversations) not yet authored~~                                                    | High     | **Resolving** |
| GAP-008 | ~~Routes correctly wired at `/api/v1/marketplace/*` path prefix~~                                                                    | Low      | Mitigated     |
| GAP-009 | `hashIp` lacks salt for stronger privacy (deferred from pr-review round 5)                                                           | Low      | Open          |
| GAP-010 | Text search index weights untuned (name > description > tags, deferred)                                                              | Low      | Open          |
| GAP-011 | `screenshots[]` → `media[]` is a breaking API change — mitigated by drop-and-re-seed (no external consumers yet)                     | Medium   | Phase 2       |
| GAP-012 | Bundle endpoint returns full `files` without pagination or streaming — acceptable for 4MB max but may need chunking at larger scales | Low      | Phase 2       |
| GAP-013 | Static media assets served from local filesystem — no replication across pods, no CDN                                                | Medium   | Phase 2       |
| GAP-014 | `prerequisites.models` extraction strategy not yet finalized (regex vs parsed AST)                                                   | Low      | Phase 2       |

---

## 20. Data Migration

### Phase 2 Migration Strategy: Drop and Re-seed

All current template data is platform-owned seed data with placeholder content. No user-generated content exists. The migration strategy is:

1. **Drop** all documents from `templates` and `template_versions` collections
2. **Re-seed** using the rewritten seed script that produces:
   - Templates with `media[]` (replaces `screenshots[]`), `prerequisites`, and `reviewStatus`
   - TemplateVersions with typed `ProjectManifestV2` manifests and `files` bundles
3. **Analytics events** (`template_analytics_events`) are NOT dropped — they remain for historical metrics. The `templateId` references may become orphaned but analytics events are loosely coupled by design (nullable `templateId`).
4. **Indexes** are auto-created by Mongoose schema definitions — no manual index migration needed.

### Why Drop-and-Re-seed Is Safe

- All templates are platform-seeded — zero user-generated content
- No external consumers depend on specific template IDs
- Analytics events use nullable references (no cascading deletes)
- Seed script is idempotent (upsert by slug)

---

## 21. Roadmap

| Phase   | Scope                                                                                                              | Status  |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| Phase 1 | Read-only catalog: browse, search, filter, detail, analytics                                                       | DONE    |
| Phase 2 | Import-ready bundles, media, prerequisites, bundle API                                                             | DONE    |
| Phase 3 | Install flow: project + agent install via `importProjectV2`, admin template manager, auth gating                   | DONE    |
| Phase 4 | Workflow templates (`type: 'workflow'`), CDN/S3 media storage, Redis-backed rate limiting, `Cache-Control` headers | PLANNED |
| Phase 5 | Community publishing: user-submitted templates, review workflow, partner APIs, tenant catalog governance           | PLANNED |

### Phase 3 Key Dependencies

- `packages/project-io` import pipeline (already mature — 9 layers, conflict strategies, binding resolution) — **CONFIRMED READY**
- Studio import wiring: `previewStudioLayeredImportV2()` and `applyStudioLayeredImportV2()` in `apps/studio/src/lib/project-import/layered-import-support.ts` — **CONFIRMED READY**
- Studio import API endpoints (`POST /api/projects/:id/import/preview` requires `PROJECT_READ`, `POST /api/projects/:id/import/apply` requires `PROJECT_IMPORT`) — **CONFIRMED READY**
- Project creation: `POST /api/projects` via `createProject()` service, requires `project:create` permission — **CONFIRMED READY**
- Client API helpers: `fetchImportPreview()` and `applyImport()` in `apps/studio/src/api/project-io.ts` — **CONFIRMED READY**
- Template-store proxy: Studio at `/api/template-store/*` forwards to port 3115 with auth headers — **CONFIRMED READY**
- Auth middleware: JWT Bearer token auto-attached by `apiFetch()`, validated by `requireAuth`/`requireTenantAuth` + `hasPermission()` — **CONFIRMED READY**
- Customization schema interpreter (variable substitution in DSL before import) — **DEFERRED to Phase 3+** (field exists in schema but interpreter not built)

### Phase 4 Key Dependencies

- Workflow engine (`apps/workflow-engine`) templates for `type: 'workflow'`
- CDN/S3 infrastructure for media and bundle storage
- Redis infrastructure for shared rate limiting

---

## 22. Testing & Validation

### Required Test Coverage

| #   | Scenario                                               | Coverage Type | Status  | Test File / Note                                                             |
| --- | ------------------------------------------------------ | ------------- | ------- | ---------------------------------------------------------------------------- |
| 1   | Browse templates with pagination                       | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 2   | Filter by type/category/complexity                     | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 3   | Full-text search returns ranked results                | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 4   | Template detail by slug returns full data              | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 5   | Categories endpoint returns names with counts          | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 6   | Featured endpoint returns ordered templates            | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 7   | Rate limiting returns 429 on excess                    | integration   | PASS    | `apps/template-store/src/__tests__/routes/marketplace.test.ts`               |
| 8   | View count increments on detail view                   | integration   | PASS    | `apps/template-store/src/__tests__/repos/template-repo.test.ts`              |
| 9   | Analytics event recorded for views/searches            | integration   | PASS    | `apps/template-store/src/__tests__/repos/analytics-repo.test.ts`             |
| 10  | Marketplace landing page renders                       | e2e           | WRITTEN | `apps/studio/e2e/marketplace-landing.spec.ts` (requires running services)    |
| 11  | Template detail page renders with tabs                 | e2e           | WRITTEN | `apps/studio/e2e/marketplace-detail.spec.ts` (requires running services)     |
| 12  | Search and filtering works end-to-end                  | e2e           | WRITTEN | `apps/studio/e2e/marketplace-search.spec.ts` (requires running services)     |
| 13  | Category browse with pagination                        | e2e           | WRITTEN | `apps/studio/e2e/marketplace-category.spec.ts` (requires running services)   |
| 14  | Responsive layout at mobile/tablet/desktop breakpoints | e2e           | WRITTEN | `apps/studio/e2e/marketplace-responsive.spec.ts` (requires running services) |
| 15  | Browse excludes `files` from response (projection)     | integration   | PLANNED | Phase 2                                                                      |
| 16  | Bundle endpoint returns `files` for valid version      | integration   | PLANNED | Phase 2                                                                      |
| 17  | Bundle endpoint returns 404 for unknown version        | integration   | PLANNED | Phase 2                                                                      |
| 18  | Detail response includes `media` and `prerequisites`   | integration   | PLANNED | Phase 2                                                                      |
| 19  | Seed script produces valid manifests and bundles       | integration   | PLANNED | Phase 2                                                                      |
| 20  | Media gallery renders images and video                 | unit          | PLANNED | Phase 2                                                                      |
| 21  | Prerequisites section renders categorized lists        | unit          | PLANNED | Phase 2                                                                      |
| 22  | Type filter tabs filter templates correctly            | e2e           | PLANNED | Phase 2                                                                      |

### Testing Notes

**Phase 1 (DONE)**:

- **Integration tests**: 45 tests passing across 3 test files (routes, template-repo, analytics-repo) using MongoMemoryServer with `pool: 'forks'`.
- **UI component tests**: 42 tests passing across 8 test files (7 components + marketplace-store).
- **E2E tests**: 5 Playwright spec files with 23 test cases written. These require the template-store service and Studio running simultaneously to execute.

**Phase 2 (PLANNED)**:

- Integration tests for bundle endpoint, projection verification, and new response fields
- Component tests for media gallery (video support) and prerequisites display
- E2E tests for type filter tabs and prerequisites section on detail page
- Seed script validation tests (manifest structure, bundle integrity, DSL validity)

> Full testing details: [../testing/template-store.md](../testing/template-store.md)

---

## 23. References

- Requirements: `explorations/2026-03-04-template-store-marketplace-requirements.md`
- Technical design: `explorations/2026-03-05-template-store-technical-design.md`
- Implementation plan: `explorations/2026-03-17-template-store-phased-implementation-plan.md`
- UX guidelines: `explorations/2026-03-18-template-store-ux-guidelines.md`
- Competitive research: `explorations/2026-03-04-ai-agent-template-store-marketplace-research.md`
- Platform research: `explorations/2026-03-04-template-marketplace-platform-research.md`
- Best practices: `explorations/2026-03-04-template-marketplace-best-practices.md`
- Project-IO types: `packages/project-io/src/types.ts` (ProjectManifestV2, ImportOptionsV2, ImportResultV2)
- HLD: `docs/specs/template-store.hld.md`
- Post-impl sync log: `docs/sdlc-logs/template-store/post-impl-sync.log.md`
