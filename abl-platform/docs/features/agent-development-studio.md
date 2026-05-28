# Feature: Agent Development (Studio)

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `admin operations`, `integrations`
**Package(s)**: `apps/studio`, `packages/project-io`, `apps/runtime`, `packages/database`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/agent-development-studio.md](../testing/agent-development-studio.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

Building AI agents requires authoring DSL source code, configuring execution parameters, managing tool integrations, orchestrating multi-agent topologies, and packaging/transporting projects across environments. Without a unified IDE surface, agent authors must manually stitch together compiler outputs, runtime settings, version snapshots, and project transport flows across disparate systems. This fragmentation slows iteration, increases configuration errors, and creates operational blind spots.

### Goal Statement

Agent Development (Studio) provides the end-to-end integrated development environment for ABL agent projects. It unifies project creation, agent authoring (DSL + visual section editors), live compilation feedback, topology visualization, settings management, version control, and project portability (import/export + git sync) into a single coherent workspace. The goal is to let teams build, test, and ship agents without leaving the Studio surface.

### Summary

Studio is a Next.js 15 application serving as the primary IDE for ABL agent development. It provides a three-tier architecture:

1. **Project Management** -- Dashboard with project cards, creation flows (blank + Architect-assisted), search/filter, and project-level navigation sidebar with 30+ pages covering agents, tools, MCP servers, sessions, deployments, evals, workflows, analytics, guardrails, governance, and settings.

2. **Agent Editing** -- Unified agent editor (`AgentEditor.tsx`) with 17 section editors (identity, execution, tools, gather, flow, constraints, guardrails, behavior, handoffs, delegates, escalation, memory, onStart, errorHandling, completion, templates, definition), live ABL compilation via `/api/abl/compile`, surgical section-level saves via `/api/projects/[id]/agents/[agentId]/edit`, DSL overlay for raw code editing, version diff viewer, and topology canvas (`TopologyCanvas.tsx`) for multi-agent graph visualization.

3. **Project Transport & Settings** -- Layered import/export via `packages/project-io` (manifest + lockfile + layer assembly), bidirectional git sync with four providers (GitHub, GitLab, Bitbucket, generic), project settings management (thinking, compaction, trace dimensions, prompt overrides, PII protection, model config, API keys, config variables, runtime config, agent transfer), and versioned settings snapshots with lifecycle promotion (draft -> testing -> staged -> active -> deprecated).

The Studio orchestrates the ABL compiler (`@abl/core`, `@abl/compiler`), runtime APIs, and project-IO transport backbone to deliver a cohesive authoring experience.

---

## 2. Scope

### Goals

- Provide the primary IDE workspace for creating, editing, compiling, and saving ABL agent definitions with both visual section editors and raw DSL editing.
- Enable multi-agent topology visualization and navigation via hierarchical graph canvas.
- Support project portability through layered import/export archives, git push/pull with conflict resolution, and webhook-driven auto-sync across GitHub, GitLab, Bitbucket, and generic providers.
- Manage project-level execution settings (thinking, compaction, prompt overrides, model config, trace dimensions) with working-copy and versioned snapshot lifecycle.
- Provide project-level collaboration through membership management (owner/editor/viewer roles), API key management, and configuration variable namespaces.
- Deliver Architect AI assistance for guided project creation, agent editing, and topology understanding.

### Non-Goals (Out of Scope)

- This feature does not implement the runtime execution engine itself (execution is in `apps/runtime`).
- This feature does not provide real-time collaborative editing or live author presence (GAP-001).
- This feature does not replace downstream deployment pipelines, channel execution, or compiler internals; it orchestrates them.
- This feature does not handle end-customer-facing chat or session management (those are runtime/channel features).
- This feature does not implement the ABL language specification or compiler (those are in `packages/compiler`).

---

## 3. User Stories

1. As an agent author, I want a visual section editor for each agent concern (identity, tools, flow, guardrails, etc.) so that I can edit agent behavior without hand-writing DSL.
2. As an agent author, I want live compilation feedback in the editor so that I see parse errors and IR validation issues as I type.
3. As an agent author, I want a DSL overlay editor so that I can switch between visual editing and raw ABL code when I need fine-grained control.
4. As a project maintainer, I want to import, export, push, and pull project state through supported git providers so that I can move work across environments safely.
5. As an operator, I want a project dashboard with search, agent count, session count, and quick actions so that I can find and navigate to projects efficiently.
6. As a project admin, I want versioned settings snapshots with lifecycle promotion so that I can stage, test, and activate configuration changes with confidence.
7. As a team lead, I want project membership management with role-based access (owner/editor/viewer) so that I can control who can modify agents and settings.
8. As an agent author, I want a topology canvas showing multi-agent relationships (supervisor, handoffs, delegates) so that I can visualize and navigate the agent graph.
9. As a new user, I want an Architect-assisted onboarding flow that interviews me about my use case and generates initial agent definitions so that I can get started quickly.
10. As an agent author, I want to manage tools (HTTP, MCP, Lambda, Sandbox), MCP servers, connections, and config variables at the project level so that shared infrastructure is configured once.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a project dashboard listing all projects for the authenticated user with search, filtering, agent count, session count, and project creation actions.
2. **FR-2**: The system must provide a unified agent editor with 17 section editors (identity, execution, tools, gather, flow, constraints, guardrails, behavior, handoffs, delegates, escalation, memory, onStart, errorHandling, completion, templates, definition) that read from compiled IR and write via surgical edit API.
3. **FR-3**: The system must compile ABL DSL to IR in real-time via `/api/abl/compile` with rate limiting (30 req/60s per user), input size validation (500KB max), config variable resolution, and structured error reporting.
4. **FR-4**: The system must provide a DSL overlay editor for raw ABL code editing with parse error display and save capability via `/api/projects/[id]/agents/[agentId]/dsl`.
5. **FR-5**: The system must render a topology canvas (`TopologyCanvas.tsx`) showing hierarchical agent relationships (entry node, handoffs, delegates) with BFS-based layout, click-to-select, and hover effects.
6. **FR-6**: The system must support layered project import/export with manifest/lockfile generation, layer size limits, dependency edge tracking, and preview before apply.
7. **FR-7**: The system must support bidirectional git sync with GitHub, GitLab, Bitbucket, and generic providers including three-way conflict detection, configurable resolution strategies (manual/local_wins/remote_wins), circuit breaker protection, and optional webhook-driven auto-sync.
8. **FR-8**: The system must persist project execution settings as working copies (`project_settings`) and versioned snapshots (`project_settings_versions`) with lifecycle promotion (draft -> testing -> staged -> active -> deprecated).
9. **FR-9**: The system must gate all authoring operations through project membership (`requireProjectPermission`) and tenant isolation (`tenantIsolationPlugin`), returning 404 for cross-tenant/cross-project access attempts.
10. **FR-10**: The system must provide project settings management UI with tabs for members, API keys, models, config variables, git integration, advanced settings, runtime config, trace dimensions, agent transfer, PII protection, and auth profiles.
11. **FR-11**: The system must support agent version management including version history listing, version diffing, and DSL restore from historical versions.
12. **FR-12**: The system must provide Architect AI-assisted workflows for project creation (interview -> generate -> review -> create) and agent section editing (contextual suggestions, propose_modification tool calls).
13. **FR-13**: The system must support project-level tool management (CRUD, import, export, duplicate, test execution) for HTTP, MCP, Lambda, and Sandbox tool types.
14. **FR-14**: The system must provide MCP server management (CRUD, connection testing, tool discovery, tool testing) at the project level.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                           |
| -------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Studio is the primary project creation, management, and configuration surface.  |
| Agent lifecycle            | PRIMARY      | Agent editing, compilation, versioning, and topology management happen here.    |
| Customer experience        | NONE         | Studio is builder-facing, not customer-facing.                                  |
| Integrations / channels    | SECONDARY    | Channels consume project state produced by Studio. Tool/MCP config lives here.  |
| Observability / tracing    | SECONDARY    | Trace dimension config, session browsing, and trace viewer are Studio features. |
| Governance / controls      | SECONDARY    | Guardrails config, agent governance, and compliance views are in Studio.        |
| Enterprise / compliance    | SECONDARY    | Git sync, audit trails, project transport, and PII protection config.           |
| Admin / operator workflows | PRIMARY      | Project dashboarding, settings management, and version promotion are here.      |

### Related Feature Integration Matrix

| Related Feature                                         | Relationship Type | Why It Matters                                                              | Key Touchpoints                                                 | Current State      |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------ |
| [ABL Language](./abl-language.md)                       | depends on        | Studio is the primary authoring surface for ABL source files.               | `/api/abl/compile`, `/api/abl/parse`, `/api/abl/diagnostics`    | Active integration |
| [Deployments & Versioning](./deployments-versioning.md) | depends on        | Studio project and settings changes flow into deployment/version workflows. | Settings snapshots, agent versions, deploy panel                | Active integration |
| [Channels](./channels.md)                               | configured by     | Channel/runtime features consume project assets authored in Studio.         | Imported/exported project layers, project settings, connectors  | Active integration |
| [Guardrails](./guardrails.md)                           | configured by     | Guardrail policies are configured per-project in Studio settings.           | GuardrailsEditor section, guardrails-config page                | Active integration |
| [Arch AI Assistant](./arch-ai-assistant.md)             | extends           | Architect provides AI-assisted onboarding and editing within Studio.        | ArchPanel, ArchChat, onboarding flow, section-level suggestions | Active integration |
| [Tool Invocations](./tool-invocations.md)               | configured by     | Tool definitions (HTTP, MCP, Lambda, Sandbox) are authored in Studio.       | ToolsEditor, tool API routes, MCP server management             | Active integration |
| [Tracing & Observability](./tracing-observability.md)   | shares data with  | Studio configures trace dimensions and provides session/trace browsing.     | TraceDimensionsTab, session pages, trace viewer                 | Active integration |
| [Memory & Sessions](./memory-sessions.md)               | shares data with  | Studio provides session browsing and management for agent conversations.    | Session list, session detail, session health hooks              | Active integration |

---

## 6. Design Considerations

- **Section-based editing**: The agent editor decomposes IR into 17 discrete sections (identity, tools, flow, etc.) rendered as individual editor components. Each section writes changes via the surgical edit API (`/api/projects/[id]/agents/[agentId]/edit`) with 500ms debounced batching. This pattern avoids full-file save conflicts while enabling granular auto-save.
- **Dual editing modes**: Users can switch between visual section editors (form-based) and the DSL overlay (raw code). The visual editor reads from compiled IR; the DSL overlay reads/writes raw ABL text. Both modes converge through the same compile pipeline.
- **Topology visualization**: The `TopologyCanvas` uses an SVG-based hierarchical BFS layout with Framer Motion animations. Nodes represent agents with entry/supervisor distinction; edges represent handoff and delegate relationships.
- **Design system**: Studio follows the established design system with CSS custom properties (HSL), Tailwind utilities, Framer Motion animations, Lucide icons, `clsx` for className composition, and a component library (`ui/` folder) including Card, Button, Input, EmptyState, PageHeader, DetailPageShell, etc.
- **Navigation**: Client-side routing via `NavigationStore` using `history.pushState` with structured route segments. The sidebar provides 30+ navigation targets organized by category (agents, observability, governance, settings, etc.).

---

## 7. Technical Considerations

- **Compilation pipeline**: `useAgentIR` hook fetches agent DSL from runtime, sends it to `/api/abl/compile` for parsing (`parseAgentBasedABL`) and compilation (`compileABLtoIR`), then loads sections into `AgentDetailStore`. Config variables are resolved from the project during compilation.
- **State management**: Zustand stores (`EditorStore`, `ProjectStore`, `AgentDetailStore`, `NavigationStore`, `VersionStore`, `ArchStore`, `LifecycleStore`, etc.) manage all client-side state. `ProjectStore` uses `persist` middleware for cross-session persistence.
- **Surgical editing**: The `useSectionEdit` hook batches multiple section edits within a 500ms debounce window and sends them as a single API request to the edit endpoint. `saveEditsNow` provides immediate flush for explicit saves.
- **API layer**: Studio API routes (`apps/studio/src/app/api/`) proxy to runtime or implement Studio-specific logic. Auth is handled via `requireAuth` + `isAuthError` pattern. Rate limiting uses `checkRateLimit` with per-user keys.
- **Project-IO backbone**: `packages/project-io` handles portable project archives (V2 format with manifest, lockfile, layer assembly), git sync service orchestration, conflict resolution (three-way merge), and circuit breaker protection for provider API resilience.
- **Git provider architecture**: Abstract `GitProvider` interface with 12 operations implemented by 4 providers. `ProviderFactory` instantiates from `git_integrations` config. Circuit breaker wraps all provider calls.

---

## 8. How to Consume

### Studio UI

Key Studio surfaces include:

- `ProjectDashboard` -- Landing page with project card grid, search, create (blank + Architect-assisted)
- `AgentEditorPage` / `AgentEditor` -- Full-page agent authoring with 17 section editors, DSL overlay, header (save status, version info, agent switcher)
- `AgentEditorMenu` -- Left sidebar menu for section navigation within the agent editor
- `TopologyCanvas` -- SVG multi-agent topology graph with hierarchical BFS layout
- `ProjectSettingsPage` -- Settings shell with 10 sub-tabs (members, API keys, models, config vars, git, advanced, runtime config, trace dimensions, agent transfer, PII protection)
- `ImportDialog` / `ExportDialog` -- Layered import/export with preview and layer selection
- `GitIntegrationTab` -- Git provider setup, push/pull controls, sync status
- `VersionsSlideOver` -- Agent version history and diff viewer
- `DslEditorOverlay` -- Raw ABL code editor with parse error display
- `DeployPanel` -- Deployment controls and status
- `ChatSlideOver` -- Agent chat testing panel

### API (Runtime)

| Method | Path                                         | Purpose                                      |
| ------ | -------------------------------------------- | -------------------------------------------- |
| GET    | `/api/projects/:projectId/settings`          | Load project execution settings working copy |
| PUT    | `/api/projects/:projectId/settings`          | Update project execution settings            |
| GET    | `/api/projects/:projectId/settings/versions` | List settings version snapshots              |
| POST   | `/api/projects/:projectId/settings/versions` | Create settings version snapshot             |
| POST   | `/api/projects/:projectId/project-io/*`      | Import/export coordination surface           |
| GET    | `/api/projects/:projectId/agents`            | List project agents                          |
| GET    | `/api/projects/:projectId/agents/:agentId`   | Get agent detail (DSL, metadata)             |
| PUT    | `/api/projects/:projectId/agents/:agentId`   | Update agent                                 |

### API (Studio)

| Method         | Path                                                        | Purpose                         |
| -------------- | ----------------------------------------------------------- | ------------------------------- |
| POST           | `/api/abl/compile`                                          | Compile ABL DSL to IR           |
| POST           | `/api/abl/parse`                                            | Parse ABL DSL (no compilation)  |
| POST           | `/api/abl/diagnostics`                                      | Get language diagnostics        |
| POST           | `/api/abl/analysis`                                         | Analyze ABL structure           |
| GET/POST       | `/api/projects`                                             | List/create projects            |
| GET/PUT        | `/api/projects/[id]`                                        | Get/update project              |
| GET            | `/api/projects/[id]/agents`                                 | List project agents             |
| GET/PUT        | `/api/projects/[id]/agents/[agentId]`                       | Get/update agent                |
| POST           | `/api/projects/[id]/agents/[agentId]/compile`               | Compile specific agent          |
| POST           | `/api/projects/[id]/agents/[agentId]/edit`                  | Surgical section-level edit     |
| GET/PUT        | `/api/projects/[id]/agents/[agentId]/dsl`                   | Get/update raw DSL content      |
| POST           | `/api/projects/[id]/agents/[agentId]/diff`                  | Diff agent versions             |
| POST           | `/api/projects/[id]/agents/[agentId]/lock`                  | Lock agent for editing          |
| POST           | `/api/projects/[id]/export`                                 | Export project archive          |
| POST           | `/api/projects/[id]/export/preview`                         | Preview export contents         |
| POST           | `/api/projects/[id]/export/async`                           | Async export for large projects |
| POST           | `/api/projects/[id]/import/preview`                         | Preview layered import          |
| POST           | `/api/projects/[id]/import/apply`                           | Apply import                    |
| GET            | `/api/projects/[id]/import/status`                          | Check import job status         |
| POST           | `/api/projects/[id]/import/doctor`                          | Diagnose import issues          |
| GET/POST       | `/api/projects/[id]/git`                                    | Git integration status/config   |
| POST           | `/api/projects/[id]/git/push`                               | Push Studio changes to git      |
| POST           | `/api/projects/[id]/git/pull`                               | Pull external git changes       |
| GET            | `/api/projects/[id]/git/status`                             | Git sync status                 |
| GET            | `/api/projects/[id]/git/history`                            | Git commit history              |
| POST           | `/api/projects/[id]/git/promote`                            | Promote git branch              |
| GET/PUT        | `/api/projects/[id]/settings`                               | Project settings working copy   |
| GET/POST       | `/api/projects/[id]/settings/versions`                      | Settings version snapshots      |
| PUT            | `/api/projects/[id]/settings/versions/[version]`            | Update settings version         |
| POST           | `/api/projects/[id]/settings/versions/[version]/promote`    | Promote settings version        |
| GET            | `/api/projects/[id]/topology`                               | Agent topology graph data       |
| GET/POST       | `/api/projects/[id]/tools`                                  | List/create tools               |
| GET/PUT/DELETE | `/api/projects/[id]/tools/[toolId]`                         | Tool CRUD                       |
| POST           | `/api/projects/[id]/tools/[toolId]/test`                    | Test tool execution             |
| POST           | `/api/projects/[id]/tools/[toolId]/duplicate`               | Duplicate tool                  |
| POST           | `/api/projects/[id]/tools/import`                           | Import tool definition          |
| GET/POST       | `/api/projects/[id]/mcp-servers`                            | List/create MCP servers         |
| GET/PUT/DELETE | `/api/projects/[id]/mcp-servers/[serverId]`                 | MCP server CRUD                 |
| POST           | `/api/projects/[id]/mcp-servers/[serverId]/test-connection` | Test MCP server connection      |
| POST           | `/api/projects/[id]/mcp-servers/[serverId]/tools/discover`  | Discover MCP server tools       |
| GET/POST       | `/api/projects/[id]/config-variables`                       | Config variable management      |
| GET/POST       | `/api/projects/[id]/teams`                                  | Team/membership management      |
| GET/POST       | `/api/projects/[id]/locks`                                  | Agent locking                   |
| GET            | `/api/projects/[id]/dependencies`                           | Project dependency graph        |
| POST           | `/api/webhooks/git/[projectId]`                             | Git webhook bridge (auto-sync)  |

### Admin Portal

Tenant/project administration exists in Admin (`apps/admin`), but daily development workflows live in Studio.

### Channel Integration

Studio development is channel-agnostic. It produces project state, versions, settings, and connectors that downstream channel runtimes consume.

---

## 9. Data Model

### Collections / Tables

```
Collection: projects
Fields:
  - _id: string (UUID v7)
  - name: string (required, display name)
  - slug: string (required, URL-safe identifier)
  - description: string | null
  - ownerId: string (required, creator user ID)
  - tenantId: string | null
  - entryAgentName: string | null (supervisor / entry point agent)
  - gitIntegrationId: string | null (references git_integrations._id)
  - messageRetentionDays: number | null (conversation message TTL)
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, slug: 1 } (unique -- one slug per tenant)
  - { ownerId: 1 } (user's projects)
  - { tenantId: 1 } (tenant listing)
Plugins: tenantIsolationPlugin
```

```
Collection: project_members
Fields:
  - _id: string (UUID v7)
  - projectId: string (required)
  - userId: string (required)
  - role: string (required: 'owner' | 'editor' | 'viewer' | custom)
  - customRoleId: string | null (references custom role definitions)
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { projectId: 1, userId: 1 } (unique -- one membership per user per project)
  - { userId: 1 } (user's memberships across projects)
```

```
Collection: project_settings
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required)
  - projectId: string (required)
  - enableThinking: boolean (default false, Anthropic extended thinking)
  - thinkingBudget: number | null (token budget for thinking)
  - thoughtDescription: string | null
  - promptOverrides: Record<string, unknown> (keyed by prompt_templates convention)
  - compactionThreshold: number | null (0-1, context-usage ratio for auto-compaction)
  - traceDimensions: string[] (session data keys to auto-extract as trace custom_dimensions)
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1 } (unique -- one settings doc per project)
Plugins: tenantIsolationPlugin
```

```
Collection: project_settings_versions
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required)
  - projectId: string (required)
  - version: string (required, semver)
  - status: 'draft' | 'testing' | 'staged' | 'active' | 'deprecated'
  - settings: { enableThinking, thinkingBudget, thoughtDescription, compactionThreshold?, promptOverrides? }
  - sourceHash: string (required, for change detection)
  - changelog: string | null
  - createdBy: string (required)
  - promotedAt: Date | null
  - promotedBy: string | null
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, version: 1 } (unique)
  - { tenantId: 1, projectId: 1, createdAt: -1 } (version listing with sort)
  - { tenantId: 1, projectId: 1, status: 1 } (query by lifecycle stage)
Plugins: tenantIsolationPlugin
```

```
Collection: git_integrations
Fields:
  - _id: string (UUID v7)
  - projectId: string (required)
  - tenantId: string (required)
  - provider: 'github' | 'gitlab' | 'bitbucket' | 'generic'
  - repositoryUrl: string (required)
  - defaultBranch: string (default 'main')
  - syncPath: string (default '/', subfolder within repo)
  - credentials: { type: 'oauth'|'token'|'app', secretId: string }
  - authProfileId: string | null
  - webhookSecret: string | null (for webhook signature verification)
  - webhookId: string | null (registered webhook ID for auto-sync)
  - syncConfig: {
      autoSync: boolean (default false),
      autoDeploy: { enabled, environment, branch } | null,
      conflictStrategy: 'manual' | 'local_wins' | 'remote_wins' (default 'manual')
    }
  - lastSyncAt: Date | null
  - lastSyncCommit: string | null (SHA of last synced commit)
  - lastSyncStatus: 'success' | 'failed' | 'conflict' | null
  - lastSyncError: string | null
  - status: 'active' | 'disconnected' | 'error'
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { projectId: 1 } (unique -- one git integration per project)
  - { tenantId: 1 }
```

### Key Relationships

- `projects.gitIntegrationId` -> `git_integrations._id` (optional 1:1 link)
- `project_members.projectId` -> `projects._id` (many members per project)
- `project_settings.projectId` -> `projects._id` (one settings doc per project)
- `project_settings_versions.projectId` -> `projects._id` (many versions per project)
- Project IO import/export serializes project agents, tools, settings, channels, guardrails, evals, and search layers into a canonical folder structure with manifest and lockfile
- Project membership gates all Studio authoring routes via `requireProjectPermission()`
- Agent records reference `projectId` and are fetched via `/api/projects/[id]/agents`
- Tools, MCP servers, config variables, and connections are all project-scoped

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                    | Purpose                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `packages/project-io/src/export/project-exporter.ts`    | Project archive generation with manifest/lockfile      |
| `packages/project-io/src/import/project-importer-v2.ts` | Layered import application with validation             |
| `packages/project-io/src/git/git-sync-service.ts`       | Git push/pull orchestration with circuit breaker       |
| `packages/project-io/src/git/git-provider.ts`           | Abstract GitProvider interface (12 methods)            |
| `packages/project-io/src/git/github-provider.ts`        | GitHub API implementation                              |
| `packages/project-io/src/git/gitlab-provider.ts`        | GitLab API implementation                              |
| `packages/project-io/src/git/bitbucket-provider.ts`     | Bitbucket API implementation                           |
| `packages/project-io/src/git/generic-git-provider.ts`   | Generic git host token implementation placeholder      |
| `packages/project-io/src/git/conflict-resolver.ts`      | Three-way merge conflict detection and auto-resolution |
| `packages/project-io/src/git/branch-manager.ts`         | Branch creation and management                         |
| `packages/project-io/src/git/webhook-handler.ts`        | Webhook event processing for auto-sync                 |
| `packages/project-io/src/git/git-circuit-breaker.ts`    | Circuit breaker for git provider resilience            |
| `packages/project-io/src/git/provider-factory.ts`       | Provider instantiation from git_integrations config    |
| `apps/studio/src/services/project-service.ts`           | Project creation/bootstrap logic with slug uniqueness  |
| `apps/studio/src/lib/abl-serializers.ts`                | ABL section serialization for surgical edits           |
| `apps/studio/src/lib/api-client.ts`                     | Unified API client with auth headers                   |
| `apps/studio/src/lib/auth.ts`                           | requireAuth / isAuthError auth utilities               |
| `apps/studio/src/lib/rate-limit.ts`                     | Rate limiting for API routes                           |

### Routes / Handlers

| File                                                                      | Purpose                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/studio/src/app/api/abl/compile/route.ts`                            | ABL compile endpoint                             |
| `apps/studio/src/app/api/abl/parse/route.ts`                              | ABL parse endpoint                               |
| `apps/studio/src/app/api/abl/diagnostics/route.ts`                        | ABL diagnostics endpoint                         |
| `apps/studio/src/app/api/projects/route.ts`                               | Project list/create                              |
| `apps/studio/src/app/api/projects/[id]/route.ts`                          | Project detail/update                            |
| `apps/studio/src/app/api/projects/[id]/agents/route.ts`                   | Agent list/create                                |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/route.ts`         | Agent detail/update/delete                       |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/edit/route.ts`    | Surgical section edit                            |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/dsl/route.ts`     | Raw DSL get/update                               |
| `apps/studio/src/app/api/projects/[id]/agents/[agentId]/compile/route.ts` | Agent-specific compile                           |
| `apps/studio/src/app/api/projects/[id]/export/route.ts`                   | Studio export API                                |
| `apps/studio/src/app/api/projects/[id]/import/apply/route.ts`             | Studio import apply API                          |
| `apps/studio/src/app/api/projects/[id]/import/preview/route.ts`           | Import preview                                   |
| `apps/studio/src/app/api/projects/[id]/git/route.ts`                      | Git integration config                           |
| `apps/studio/src/app/api/projects/[id]/git/push/route.ts`                 | Git push                                         |
| `apps/studio/src/app/api/projects/[id]/git/pull/route.ts`                 | Git pull                                         |
| `apps/studio/src/app/api/projects/[id]/settings/route.ts`                 | Project settings CRUD                            |
| `apps/studio/src/app/api/projects/[id]/settings/versions/route.ts`        | Settings versions list/create                    |
| `apps/studio/src/app/api/projects/[id]/topology/route.ts`                 | Topology graph data                              |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts`                    | Tool list/create                                 |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`              | MCP server list/create                           |
| `apps/studio/src/app/api/webhooks/git/[projectId]/route.ts`               | Git webhook bridge                               |
| `apps/runtime/src/routes/project-settings.ts`                             | Runtime project settings working copy + versions |
| `apps/runtime/src/routes/project-io.ts`                                   | Runtime import/export entry points               |

### UI Components (Studio)

| File                                                                     | Purpose                                  |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| `apps/studio/src/components/agent-editor/containers/AgentEditorPage.tsx` | Main authoring page wrapper              |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`                | Core agent editor with 17 section router |
| `apps/studio/src/components/agent-editor/AgentEditorMenu.tsx`            | Section navigation sidebar               |
| `apps/studio/src/components/agent-editor/AgentEditorHeader.tsx`          | Editor header with save status/actions   |
| `apps/studio/src/components/agent-editor/AgentEditorBanners.tsx`         | Error/warning banners                    |
| `apps/studio/src/components/agent-editor/sections/*.tsx`                 | 17 individual section editors            |
| `apps/studio/src/components/agent-detail/DslEditorOverlay.tsx`           | Raw DSL code editor overlay              |
| `apps/studio/src/components/agent-detail/VersionsSlideOver.tsx`          | Version history and diff viewer          |
| `apps/studio/src/components/agent-detail/SectionCard.tsx`                | Collapsible section card component       |
| `apps/studio/src/components/topology/TopologyCanvas.tsx`                 | SVG multi-agent topology graph           |
| `apps/studio/src/components/projects/ProjectDashboard.tsx`               | Project dashboard with card grid         |
| `apps/studio/src/components/projects/ProjectCard.tsx`                    | Individual project card                  |
| `apps/studio/src/components/projects/ImportDialog.tsx`                   | Import workflow UI                       |
| `apps/studio/src/components/projects/ExportDialog.tsx`                   | Export workflow UI                       |
| `apps/studio/src/components/projects/ProjectSwitcher.tsx`                | Project switcher dropdown                |
| `apps/studio/src/components/settings/ProjectSettingsPage.tsx`            | Settings page shell with 10 tabs         |
| `apps/studio/src/components/settings/GitIntegrationTab.tsx`              | Git integration settings                 |
| `apps/studio/src/components/settings/ModelConfigTab.tsx`                 | Model configuration                      |
| `apps/studio/src/components/settings/ProjectMembersTab.tsx`              | Member management                        |
| `apps/studio/src/components/settings/ApiKeysTab.tsx`                     | API key management                       |
| `apps/studio/src/components/settings/ConfigVariablesTab.tsx`             | Config variable management               |
| `apps/studio/src/components/settings/RuntimeConfigTab.tsx`               | Runtime configuration                    |
| `apps/studio/src/components/settings/TraceDimensionsTab.tsx`             | Trace dimension configuration            |
| `apps/studio/src/components/settings/PIIProtectionTab.tsx`               | PII protection settings                  |
| `apps/studio/src/components/settings/AdvancedSettingsTab.tsx`            | Advanced project settings                |
| `apps/studio/src/components/deploy/DeployPanel.tsx`                      | Deployment controls                      |
| `apps/studio/src/components/creation/NewProjectDropdown.tsx`             | Project creation options                 |
| `apps/studio/src/components/arch/ArchPanel.tsx`                          | Architect AI assistant panel             |
| `apps/studio/src/components/onboarding/*.tsx`                            | Architect-assisted onboarding flows      |

### Stores

| File                                          | Purpose                                      |
| --------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/store/editor-store.ts`       | ABL editor state (content, parse, compile)   |
| `apps/studio/src/store/project-store.ts`      | Project list and current project (persisted) |
| `apps/studio/src/store/agent-detail-store.ts` | Agent section data and save status           |
| `apps/studio/src/store/navigation-store.ts`   | Client-side routing and URL state            |
| `apps/studio/src/store/version-store.ts`      | Version diff UI state                        |
| `apps/studio/src/store/arch-store.ts`         | Architect AI workflow state                  |
| `apps/studio/src/store/lifecycle-store.ts`    | Lifecycle/onboarding state                   |
| `apps/studio/src/store/tool-store.ts`         | Tool management state                        |
| `apps/studio/src/store/mcp-server-store.ts`   | MCP server management state                  |
| `apps/studio/src/store/canvas-store.ts`       | Canvas/topology UI state                     |

### Tests

| File                                                                | Type        | Coverage Focus                   |
| ------------------------------------------------------------------- | ----------- | -------------------------------- |
| `packages/project-io/src/__tests__/export-import-roundtrip.test.ts` | integration | Round-trip project IO fidelity   |
| `packages/project-io/src/__tests__/git-sync-service.test.ts`        | integration | Git sync orchestration           |
| `packages/project-io/src/__tests__/project-importer-v2.test.ts`     | integration | Layered import validation        |
| `apps/studio/src/__tests__/api-export-routes.test.ts`               | integration | Studio export route coverage     |
| `apps/studio/src/__tests__/api-git-routes.test.ts`                  | integration | Git API route coverage           |
| `apps/studio/src/__tests__/api-projects.test.ts`                    | integration | Project CRUD route coverage      |
| `apps/studio/src/__tests__/api-tool-routes.test.ts`                 | integration | Tool API route coverage          |
| `apps/studio/src/__tests__/agent-editor-*.test.ts*`                 | unit        | Editor component coverage        |
| `apps/studio/src/__tests__/editor-store.test.ts`                    | unit        | Editor store coverage            |
| `apps/studio/src/__tests__/project-store.test.ts`                   | unit        | Project store coverage           |
| `apps/studio/src/__tests__/agent-detail-store.test.ts`              | unit        | Agent detail store coverage      |
| `apps/studio/e2e/git-bitbucket-e2e.spec.ts`                         | e2e         | Browser git integration flow     |
| `apps/studio/e2e/curl-import.spec.ts`                               | e2e         | Browser import from curl/archive |
| `apps/studio/e2e/full-platform-e2e.spec.ts`                         | e2e         | Full platform end-to-end flow    |
| `apps/runtime/src/__tests__/project-settings-route.test.ts`         | integration | Settings working copy + versions |

---

## 11. Configuration

### Environment Variables

| Variable                  | Default    | Description                                                   |
| ------------------------- | ---------- | ------------------------------------------------------------- |
| `NEXT_PUBLIC_RUNTIME_URL` | (required) | Runtime API base URL for Studio proxy calls                   |
| `NEXT_PUBLIC_STUDIO_URL`  | (required) | Studio's own URL for OAuth callbacks and webhook registration |
| `MONGODB_URI`             | (required) | MongoDB connection string for Studio-side persistence         |
| `REDIS_URL`               | (optional) | Redis for rate limiting and session state                     |
| `ENCRYPTION_MASTER_KEY`   | (required) | Master key for credential encryption                          |

### Runtime Configuration

- Project settings working copy lives in `project_settings` (one per project)
- Versioned snapshots live in `project_settings_versions` with lifecycle states
- Import/export layers include guardrails, evals, channels, workflows, search, and core agent assets
- Git sync config (autoSync, autoDeploy, conflictStrategy) stored per-integration in `git_integrations.syncConfig`

### DSL / Agent IR

Studio development orchestrates ABL authoring and compilation but does not define its own IR schema. The compile pipeline delegates to `@abl/core` (parsing) and `@abl/compiler` (compilation). The compiled IR is consumed by `AgentDetailStore.loadFromIR()` to populate section editors and by the topology API to generate graph data.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project authoring routes are gated by `requireProjectPermission()`. All project-scoped records (`project_settings`, `project_settings_versions`, agents, tools) are keyed by `projectId`. Cross-project access returns 404. |
| Tenant isolation  | `projects`, `project_settings`, `project_settings_versions`, and `git_integrations` carry `tenantId`, with `tenantIsolationPlugin` applied. Cross-tenant access returns 404.                                                |
| User isolation    | Project membership (`project_members`) and `ownerId` / `userId` records determine who can view or mutate authoring state. API keys are user-scoped (`createdBy`).                                                           |

### Security & Compliance

- Auth via `requireAuth` + `isAuthError` pattern on all API routes. No custom token verification.
- Rate limiting on compilation endpoints (30 req/60s per user) and project operations.
- Input validation: DSL size capped at 500KB, request body validation via Zod schemas.
- Git credentials stored as `secretId` references pointing to secure credential store, not inline.
- Webhook secrets stored per-integration for signature verification on inbound webhook events.
- `tenantIsolationPlugin` enforced on all project-scoped collections.
- Sensitive credentials stripped or remapped during import/export via project-IO sanitization.

### Performance & Scalability

- Compilation is CPU-bound; rate limited per user to prevent resource exhaustion.
- Section edits are debounced (500ms) and batched to minimize API calls during active editing.
- Project IO uses staged import/export pipelines; async export available for large projects (`/export/async`).
- Git circuit breaker prevents cascading failures when provider APIs are unavailable.
- SWR client-side caching reduces redundant API calls for agent list, topology, and settings.
- Export generates files in memory via `exportProject()` -- no temp disk I/O for small/medium projects.

### Reliability & Failure Modes

- Git provider outages mitigated by circuit breaker with configurable thresholds (global config).
- Import/export fidelity depends on layered serialization and conflict resolution correctness.
- Compilation failures (parse errors, IR validation) are surfaced in the editor without blocking save.
- `saveEditsNow` provides flush guarantee for explicit save actions; debounced saves may be lost on unexpected navigation.
- Agent locking (`/lock` endpoint) prevents concurrent edits but has no automatic lease expiry (risk of stale locks).

### Observability

- Route/service logs cover export queues, git webhooks, import validation failures, and settings versioning.
- Git sync service uses `createLogger('git-sync-service')` for structured logging of push/pull operations, conflict detection, and circuit breaker state transitions.
- `SyncResult` return type includes success flag, commit SHA, changes summary, conflicts array, and optional error.
- Compilation errors and parse warnings are structured and returned to the client for display.
- Rate limit violations logged with user context.

### Data Lifecycle

- Project artifacts serialized into portable archives through project-IO with V2 manifest format.
- Settings working copies and version snapshots retained as operational records.
- Git integration records retain sync status, last commit, and webhook metadata.
- `messageRetentionDays` on projects controls conversation TTL (data minimization).
- No automatic cleanup of stale agent locks, version snapshots, or export artifacts (potential gaps).

---

## 13. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                | Severity | Status      |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| GAP-001 | No real-time collaborative editing or presence in the editor                                                               | Low      | Open        |
| GAP-002 | Git and import/export browser coverage exists but is lighter than the route/service coverage underneath                    | Medium   | In Progress |
| GAP-003 | Architect/workflow assistance is spread across several entry points rather than one unified creation flow                  | Low      | Open        |
| GAP-004 | `git_integrations` stores credential `secretId` reference but has no automatic secret rotation or expiry monitoring        | Medium   | Open        |
| GAP-005 | Git circuit breaker config is not configurable per-integration -- uses a single global config                              | Low      | Open        |
| GAP-006 | Project settings `promptOverrides` uses `Mixed` type with no schema validation -- arbitrary keys accepted                  | Medium   | Open        |
| GAP-007 | No webhook signature verification for GitLab/generic providers -- only GitHub and Bitbucket webhooks are signature-checked | Medium   | Open        |
| GAP-008 | Agent locking has no automatic lease expiry -- stale locks can block editing                                               | Medium   | Open        |
| GAP-009 | No undo/redo support in section editors -- only full DSL restore from version history                                      | Low      | Open        |
| GAP-010 | `project-service.ts` uses `any` type for Project and ProjectAgent -- should use proper types                               | Low      | Open        |

---

## 14. Delivery Plan / Work Breakdown

1. Broaden end-to-end authoring coverage
   1.1 Add a full create/edit/compile/save/publish Studio journey E2E test
   1.2 Add deeper browser coverage for Architect-assisted flows
   1.3 Add merge-conflict recovery and collaboration-adjacent workflows

2. Harden git and project transport reliability
   2.1 Expand provider-specific webhook verification coverage (GitLab, generic)
   2.2 Add secret-rotation and expiry monitoring for git integrations
   2.3 Revisit per-integration circuit-breaker controls

3. Tighten project settings guarantees
   3.1 Add stronger schema validation for `promptOverrides`
   3.2 Expand settings snapshot and rollback validation across more project shapes

4. Improve editor robustness
   4.1 Add automatic agent lock lease expiry
   4.2 Add undo/redo support in section editors
   4.3 Replace `any` types in project-service with proper typed interfaces

5. Strengthen type safety and code quality
   5.1 Add proper types for Project/ProjectAgent in project-service.ts
   5.2 Validate all section editor data against Zod schemas before API calls

---

## 15. Open Questions

1. Should Studio continue spreading Architect assistance across multiple entry points, or should it move to a more unified authoring flow?
2. Does git circuit-breaker behavior need to become configurable per integration rather than using global defaults?
3. How far should Studio go in supporting collaboration-style workflows before real-time collaborative editing exists?
4. Should agent locks have automatic lease expiry, and if so, what timeout is appropriate for the editing workflow?
5. Should `promptOverrides` be validated against a known prompt template schema, or remain flexible for custom overrides?

---

## 16. Success Metrics

| Metric                        | Baseline                                                                                     | Target                                                                                        | How Measured                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| End-to-end authoring coverage | Browser coverage exists for git/import flows but not one full authoring journey              | One stable browser suite covers create/edit/compile/save/publish                              | Checked-in Playwright/browser tests                 |
| Git transport reliability     | Provider and sync-service tests are strong, but provider-specific webhook coverage is uneven | All supported providers have validated webhook/sync paths with documented failure handling    | Route/service tests and webhook validation coverage |
| Settings safety               | Settings APIs and snapshots are covered, but schema flexibility remains broad                | Project settings updates enforce stronger validation with no regression in snapshot workflows | Runtime route tests and schema validation coverage  |
| Editor save reliability       | Debounced auto-save works but no flush guarantee on navigation                               | All pending edits flushed before navigation or window unload                                  | Browser tests verifying save-before-leave behavior  |
| Compilation latency           | Sub-second for typical agents                                                                | P95 < 500ms for agents under 50KB DSL                                                         | API response time monitoring                        |

---

## 17. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] Export/import round-trips cover serialization fidelity.
- [x] Project importer v2 and git providers/sync services cover validation and sync behavior.
- [x] Project settings routes and Studio export/import APIs are covered.
- [x] Agent editor stores and hooks are unit tested.
- [x] Project CRUD, tool CRUD, and git routes have integration tests.
- [ ] Collaborative editing, branch conflict recovery, and architect-assisted flows need broader coverage.

#### E2E

- [x] Browser Git integration is covered with Playwright (`git-bitbucket-e2e.spec.ts`).
- [x] Browser import from curl/archive is covered with Playwright (`curl-import.spec.ts`).
- [x] Full platform E2E flow exists (`full-platform-e2e.spec.ts`).
- [ ] Full create/edit/compile/save/publish authoring journey not yet automated as a single suite.
- [ ] Multi-user collaboration, presence, and merge-conflict recovery remain open.

### E2E Test Scenarios

| #   | Scenario                      | Status | Test File                                         |
| --- | ----------------------------- | ------ | ------------------------------------------------- |
| 1   | Git integration browser flow  | PASS   | `apps/studio/e2e/git-bitbucket-e2e.spec.ts`       |
| 2   | Import from curl/archive flow | PASS   | `apps/studio/e2e/curl-import.spec.ts`             |
| 3   | Full platform E2E flow        | PASS   | `apps/studio/e2e/full-platform-e2e.spec.ts`       |
| 4   | Tool API E2E                  | PASS   | `apps/studio/e2e/tool-api.spec.ts`                |
| 5   | Workflow create and execute   | PASS   | `apps/studio/e2e/workflow-create-execute.spec.ts` |

### Integration Test Scenarios

| #   | Scenario                                  | Status | Test File                                                           |
| --- | ----------------------------------------- | ------ | ------------------------------------------------------------------- |
| 1   | Export/import round-trip                  | PASS   | `packages/project-io/src/__tests__/export-import-roundtrip.test.ts` |
| 2   | Git sync service                          | PASS   | `packages/project-io/src/__tests__/git-sync-service.test.ts`        |
| 3   | Project importer v2 validation            | PASS   | `packages/project-io/src/__tests__/project-importer-v2.test.ts`     |
| 4   | Studio export API                         | PASS   | `apps/studio/src/__tests__/api-export-routes.test.ts`               |
| 5   | Settings working copy + version snapshots | PASS   | `apps/runtime/src/__tests__/project-settings-route.test.ts`         |

### Unit Test Coverage

| Package               | Tests                                  | Passing |
| --------------------- | -------------------------------------- | ------- |
| `packages/project-io` | import/export/git suites               | Yes     |
| `apps/studio`         | editor/project/settings/arch UI suites | Yes     |
| `apps/runtime`        | settings and project-io routes         | Yes     |

> Full testing details: [docs/testing/agent-development-studio.md](../testing/agent-development-studio.md)

---

## 18. References

- Feature matrix: `docs/feature-matrix.md` section 6
- Enterprise readiness: `docs/enterprise-readiness.md` sections 9-10
- Related features: [ABL Language](./abl-language.md), [Deployments & Versioning](./deployments-versioning.md), [Channels](./channels.md), [Guardrails](./guardrails.md), [Arch AI Assistant](./arch-ai-assistant.md)
- Git provider interface: `packages/project-io/src/git/git-provider.ts`
- Git sync service: `packages/project-io/src/git/git-sync-service.ts`
- Design system: `apps/studio/src/app/globals.css`
- Compiler: `packages/compiler/src/`
