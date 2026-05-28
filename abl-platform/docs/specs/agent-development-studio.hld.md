# HLD: Agent Development (Studio)

**Feature**: Agent Development (Studio)
**Status**: STABLE
**Author**: Platform team
**Date**: 2026-03-22
**Feature Spec**: [docs/features/agent-development-studio.md](../features/agent-development-studio.md)
**Test Spec**: [docs/testing/agent-development-studio.md](../testing/agent-development-studio.md)

---

## 1. Problem Statement

Agent authors need a unified IDE for building, configuring, testing, and deploying ABL agents. Without a cohesive development surface, authors must manually coordinate compiler outputs, runtime settings, version snapshots, project transport, and multi-agent topology across disparate systems. This creates fragmentation, increases error rates, and slows iteration cycles.

Studio addresses this by providing a three-tier architecture: project management (dashboards, creation, settings), agent editing (17 section editors, DSL overlay, live compilation, topology), and project transport (import/export, git sync with 4 providers). The HLD defines how these tiers integrate with each other and with the broader platform (runtime, compiler, project-IO).

---

## 2. Alternatives Considered

### Alternative A: Monolithic Server-Rendered Application

**Description**: Traditional server-rendered application with Express/EJS templates, server-side form handling, and full-page reloads for navigation.

**Pros**:

- Simpler deployment (single Express server)
- No client-side state management complexity
- Better SEO (irrelevant for a dev tool)

**Cons**:

- No live compilation feedback without WebSocket bolting
- Full-page reloads break editing flow
- Cannot support rich visual components (topology canvas, animated transitions)
- State management for section editing would require server-side sessions

**Effort**: M

### Alternative B: Next.js SPA with Client-Side Routing (Chosen)

**Description**: Next.js 15 application with client-side navigation via Zustand-managed routing, SWR for data fetching, and a component library for rich editing. Studio API routes proxy to runtime or implement Studio-specific logic.

**Pros**:

- Rich interactive editing experience (section editors, DSL overlay, topology canvas)
- Live compilation feedback via async API calls with debouncing
- Zustand stores provide predictable, testable state management
- SWR caching reduces redundant API calls
- Component architecture supports iterative section editor development

**Cons**:

- Larger client bundle
- Client-side routing requires careful URL synchronization
- State management across 20+ stores requires discipline

**Effort**: L (already implemented)

### Alternative C: VS Code Extension / LSP-Only Approach

**Description**: Provide only a VS Code extension with ABL Language Server Protocol support, no web-based IDE.

**Pros**:

- Leverage existing editor ecosystem (VS Code, Cursor, etc.)
- LSP provides standard diagnostics, completion, hover
- No custom UI to maintain

**Cons**:

- Cannot support project management, topology visualization, or import/export workflows
- No browser-based access for team members without local setup
- Cannot integrate Architect AI assistance
- Limits adoption to users with VS Code

**Effort**: M

### Recommendation

**Alternative B** is the correct choice (and the current implementation). The web-based IDE enables rich visual editing, topology visualization, Architect AI integration, and project management workflows that are not possible with server-rendered or editor-extension approaches. The tradeoff of client-side complexity is manageable with Zustand's simple store model and SWR's caching.

---

## 3. Architecture

### System Context Diagram

```
+------------------+     +------------------+     +------------------+
|   Studio (UI)    |---->|  Studio API      |---->|  Runtime API     |
|   Next.js 15     |     |  (Next.js routes)|     |  (Express)       |
|   Port 5173      |     |  Same process    |     |  Port 3112       |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        |                        |                        |
        v                        v                        v
+------------------+     +------------------+     +------------------+
| Zustand Stores   |     | @abl/core        |     | MongoDB          |
| (20+ stores)     |     | @abl/compiler    |     | (projects,       |
| SWR Cache        |     | ABL parsing &    |     |  agents,         |
+------------------+     | compilation      |     |  settings,       |
                          +------------------+     |  git_integrations|
                                                   +------------------+
                                                          |
                          +------------------+            |
                          | packages/        |<-----------+
                          | project-io       |
                          | (export, import, |---> Git Providers
                          |  git sync)       |    (GitHub, GitLab,
                          +------------------+     Bitbucket, generic)
```

### Component Diagram

```
Studio Application (apps/studio)
+---------------------------------------------------------------+
|                                                               |
|  Navigation Layer                                             |
|  +----------------------------------------------------------+|
|  | NavigationStore (client routing via pushState)            ||
|  | ProjectSwitcher | Sidebar (30+ pages) | Breadcrumbs      ||
|  +----------------------------------------------------------+|
|                                                               |
|  Project Management Tier                                      |
|  +----------------------------------------------------------+|
|  | ProjectDashboard (card grid, search, create)             ||
|  | ProjectStore (persisted) | LifecycleStore (onboarding)   ||
|  | NewProjectDropdown | ImportDialog | ExportDialog          ||
|  +----------------------------------------------------------+|
|                                                               |
|  Agent Editing Tier                                           |
|  +----------------------------------------------------------+|
|  | AgentEditorPage -> AgentEditor                            ||
|  |   +-- AgentEditorHeader (save status, actions)            ||
|  |   +-- AgentEditorMenu (17 section navigation)            ||
|  |   +-- Section Editors (identity, tools, flow, ...)       ||
|  |   +-- DslEditorOverlay (raw ABL code)                    ||
|  |   +-- VersionsSlideOver (version history, diff)          ||
|  | EditorStore | AgentDetailStore | VersionStore             ||
|  | useAgentIR (fetch + compile) | useSectionEdit (debounce) ||
|  +----------------------------------------------------------+|
|                                                               |
|  Topology Tier                                                |
|  +----------------------------------------------------------+|
|  | TopologyCanvas (SVG, BFS layout, Framer Motion)          ||
|  | CanvasStore                                               ||
|  +----------------------------------------------------------+|
|                                                               |
|  Settings Tier                                                |
|  +----------------------------------------------------------+|
|  | ProjectSettingsPage (10 tabs)                             ||
|  | Members | API Keys | Models | Config Vars | Git          ||
|  | Advanced | Runtime Config | Trace Dimensions | PII       ||
|  +----------------------------------------------------------+|
|                                                               |
|  AI Assistance Tier                                           |
|  +----------------------------------------------------------+|
|  | ArchPanel | ArchChat | ArchStore                          ||
|  | Onboarding (Interview -> Reveal -> Review -> Create)      ||
|  +----------------------------------------------------------+|
|                                                               |
+---------------------------------------------------------------+

Studio API Layer (apps/studio/src/app/api/)
+---------------------------------------------------------------+
|  /api/abl/*        -> @abl/core + @abl/compiler               |
|  /api/projects/*   -> Project CRUD, agents, tools, settings    |
|  /api/projects/[id]/export|import|git -> project-io proxy      |
|  /api/webhooks/git/[projectId] -> Git webhook handler          |
|  Auth: requireAuth + isAuthError on all routes                 |
|  Rate limit: checkRateLimit on compile routes                  |
+---------------------------------------------------------------+

External Dependencies
+---------------------------------------------------------------+
|  Runtime API        -> Agent persistence, settings, sessions   |
|  @abl/core          -> ABL parsing (parseAgentBasedABL)        |
|  @abl/compiler      -> IR compilation (compileABLtoIR)         |
|  packages/project-io -> Export, import, git sync               |
|  MongoDB            -> All persistent data                     |
|  Redis              -> Rate limiting, session state             |
|  Git Providers      -> GitHub, GitLab, Bitbucket, generic      |
+---------------------------------------------------------------+
```

### Data Flow: Agent Edit Cycle

```
User edits section in AgentEditor
          |
          v
useSectionEdit batches edits (500ms debounce)
          |
          v
POST /api/projects/[id]/agents/[agentId]/edit
  { edits: [{ section, data }] }
          |
          v
ABL Serializer maps section data -> DSL text mutation
          |
          v
Updated dslContent persisted to agent record
          |
          v
Response returns updated { dslContent, diff }
          |
          v
Client recompiles: POST /api/abl/compile { dsl, projectId }
          |
          v
Parse (parseAgentBasedABL) -> Compile (compileABLtoIR)
  with config variable resolution from project
          |
          v
AgentDetailStore.loadFromIR(ir) -> sections updated in UI
```

### Data Flow: Git Push

```
User clicks "Push to Git" in GitIntegrationTab
          |
          v
POST /api/projects/[id]/git/push { message }
          |
          v
Studio route -> Runtime project-io route
          |
          v
GitSyncService.push(projectId, options)
  |
  +-- exportProject() -> generate file tree
  +-- providerFactory.create(integration)
  +-- circuitBreaker.wrap(provider.getDiff())
  +-- conflictResolver.checkConflicts()
  |     (three-way merge if conflicts detected)
  +-- circuitBreaker.wrap(provider.pushFiles())
  |
  v
SyncResult { success, commitSha, changes, conflicts, error }
          |
          v
Update git_integrations.lastSync* fields
          |
          v
Response to client with sync status
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

- **Query level**: All project-scoped collections (`projects`, `project_settings`, `project_settings_versions`, `git_integrations`) carry `tenantId` and use `tenantIsolationPlugin`.
- **Enforcement**: `findOne({_id, tenantId})` pattern, never `findById`. Cross-tenant access returns 404.
- **Code evidence**: `project-repo.ts` uses `findProjectByIdAndTenant()`, not `findById()`.
- **Studio API**: `requireAuth` extracts tenant from token; project routes verify membership.

#### 2. Data Access Pattern

- **Studio side**: Repository layer in `apps/studio/src/repos/` (project-repo, config-variable-repo, credential-repo, etc.). Repos wrap Mongoose/Prisma with tenant-scoped queries.
- **Runtime side**: Direct model access in route handlers (runtime routes).
- **Client side**: SWR for data fetching with `apiFetch` wrapper. No direct DB access from client.
- **Caching**: SWR client-side cache with automatic revalidation. No server-side Redis cache for project data (stateless API design).

#### 3. API Contract

- **Error envelope**: `{ success: boolean, data?: T, error?: { code: string, message: string } }` on failure paths. Compile endpoint returns `{ success, ir, errors }`.
- **Auth**: All routes require auth via `requireAuth`. Returns 401 for missing/invalid auth.
- **Rate limiting**: Compile endpoint limited to 30 req/60s per user. Returns 429 with `Retry-After` header.
- **Input validation**: DSL size capped at 500KB. Zod schemas for structured inputs.
- **Versioning**: No explicit API versioning. Project-IO archive format has V1/V2 versioning via manifest.

#### 4. Security Surface

- **Authentication**: `requireAuth` + `isAuthError` pattern on all API routes. No custom token verification.
- **Authorization**: `requireProjectPermission` gates project-scoped operations by role.
- **Input validation**: DSL size limits, Zod schemas for request bodies, JSON parsing with try/catch.
- **SSRF prevention**: Git provider URLs validated and sanitized. Webhook endpoints use registered URLs.
- **Credential handling**: Git credentials stored as `secretId` references, never inline. Import/export sanitizes credentials.
- **XSS**: React's default escaping. DSL content rendered in code editors (Monaco/CodeMirror), not as HTML.

### Behavioral Concerns

#### 5. Error Model

| Error Type         | Status           | User Experience                | Recovery                       |
| ------------------ | ---------------- | ------------------------------ | ------------------------------ |
| Parse error        | 200 (structured) | Inline error markers in editor | Fix DSL and recompile          |
| Compile error      | 200 (structured) | Error banner in editor         | Fix DSL and recompile          |
| Save error         | 500              | Toast notification             | Retry via save button          |
| Rate limit         | 429              | Toast with wait message        | Wait for Retry-After           |
| Auth error         | 401              | Redirect to login              | Re-authenticate                |
| Permission error   | 403              | Disabled actions               | Request access from owner      |
| Not found          | 404              | 404 page                       | Navigate back                  |
| Git provider error | 502              | Error panel in git tab         | Retry or check provider status |
| Import validation  | 400              | Structured error list          | Fix archive and retry          |

#### 6. Failure Modes

- **Git provider unavailable**: Circuit breaker opens after configurable threshold (default 3 failures). Requests fail fast with "service unavailable" error. Auto-recovery after timeout.
- **MongoDB unavailable**: All CRUD operations fail. No degraded mode. Studio shows error state.
- **Compiler crash**: Caught in try/catch at route level. Returns `{ success: false, errors: [...] }`. Editor remains functional with previous IR.
- **Network partition (Studio <-> Runtime)**: Studio API proxy calls fail. User sees connection error. SWR retries on focus/reconnect.
- **Large project export**: Async export path (`/export/async`) prevents request timeout. Status polling via `/import/status`.

#### 7. Idempotency

- **Section edits**: Not idempotent -- each edit mutates DSL state. Batching within debounce window provides de-facto dedup for rapid edits.
- **Settings updates**: PUT is idempotent (full replacement). Version snapshots are append-only (POST creates new version).
- **Git push**: Not inherently idempotent but safe to retry -- provider handles duplicate commits gracefully.
- **Import/apply**: Not idempotent -- repeated import adds duplicate resources. Preview step provides dry-run verification.
- **Recommendation**: Add idempotency keys to mutation endpoints as a future improvement.

#### 8. Observability

- **Logging**: `createLogger` used in services (`git-sync-service`, `project-service`, etc.) for structured logging.
- **Compilation**: Parse errors and compile errors are structured in API responses for client display.
- **Git sync**: `SyncResult` includes success flag, commit SHA, changes summary, conflicts array, and error details.
- **Rate limiting**: Violations logged with user context and IP.
- **Trace dimensions**: Configurable per-project via `TraceDimensionsTab` for custom session analytics.
- **Missing**: No OpenTelemetry spans on Studio API routes. No Prometheus metrics for compilation latency.

### Operational Concerns

#### 9. Performance Budget

| Operation                    | Target      | Current                 | Notes                       |
| ---------------------------- | ----------- | ----------------------- | --------------------------- |
| ABL compilation (< 50KB DSL) | P95 < 500ms | ~200ms typical          | CPU-bound, rate limited     |
| Section edit round-trip      | < 1s        | ~700ms (debounce + API) | 500ms debounce + network    |
| Project dashboard load       | < 2s        | ~1s                     | SWR cached after first load |
| Project export (10 agents)   | < 3s        | ~1s                     | In-memory file generation   |
| Git push (50 files)          | < 10s       | Depends on provider     | Circuit breaker protects    |
| Topology render (20 nodes)   | < 100ms     | ~50ms                   | BFS layout + SVG render     |

#### 10. Migration Path

Studio is the existing, production system. No migration from a prior state is needed. The key migration paths are:

- **Project-IO V1 -> V2**: V2 manifest/lockfile format with layer assembly and dependency edges. V1 archives should be accepted by V2 importer with backward compatibility.
- **Settings working copy -> versioned snapshots**: Working copy is the "current" state; version snapshots capture point-in-time configurations. No data migration needed -- both coexist.
- **Future: Editor undo/redo**: Would require operation log per editing session (not currently persisted). No migration of existing data.

#### 11. Rollback Plan

- **Studio UI changes**: Standard deployment rollback (previous container version). Client-side state in Zustand stores is ephemeral (except ProjectStore).
- **API route changes**: Backward-compatible additions. Breaking changes would require API versioning (not currently needed).
- **Project-IO format changes**: V2 format is additive to V1. Rollback to V1 exporter would lose layer assembly and dependency tracking.
- **Settings schema changes**: Working copy schema is flexible (Mixed type for promptOverrides). Version snapshots are immutable once created.
- **Git integration changes**: Integration records are append-only for sync state. Rollback does not affect remote repository state.

#### 12. Test Strategy

- **Unit tests**: Zustand stores (editor-store, project-store, agent-detail-store), ABL serializers, section editor components, utility functions. Fast, isolated, no external dependencies.
- **Integration tests**: API route handlers (export, import, git, projects, tools, settings) with MongoDB (MongoMemoryServer). Test real service boundaries, not mocked handlers. Project-IO exporter/importer round-trips.
- **E2E tests**: Full Playwright browser tests for git integration, import, and platform flows. API-level E2E for authoring journey (create -> edit -> compile -> save). No mocking of codebase components.
- **Coverage targets**: 80% unit coverage for stores/serializers, all API routes covered by integration tests, minimum 5 E2E scenarios passing.
- **Missing coverage**: Topology canvas rendering, concurrent editing conflicts, agent lock lifecycle, rate limiting enforcement.

---

## 5. Data Model

### Existing Collections (No Changes Needed)

The data model is fully implemented. See feature spec section 9 for complete schemas of:

- `projects` -- Project records with tenant isolation
- `project_members` -- Project membership with roles
- `project_settings` -- Working copy execution settings
- `project_settings_versions` -- Versioned settings snapshots with lifecycle
- `git_integrations` -- Git provider configuration and sync state

### Key Relationships

```
projects (1) ----- (N) project_members
projects (1) ----- (1) project_settings
projects (1) ----- (N) project_settings_versions
projects (1) ----- (0..1) git_integrations
projects (1) ----- (N) agents
projects (1) ----- (N) tools
projects (1) ----- (N) mcp_servers
projects (1) ----- (N) config_variables
```

### Indexes

All collections use compound indexes with `tenantId` as the leading key for tenant isolation. Project-scoped collections include `projectId` in the compound index. See feature spec section 9 for full index definitions.

---

## 6. API Design

### Existing API (No New Endpoints Needed)

The API surface is fully implemented with 60+ routes under `/api/projects/[id]/`. See feature spec section 8 for the complete endpoint table. Key categories:

- **ABL compilation**: `/api/abl/compile`, `/api/abl/parse`, `/api/abl/diagnostics`, `/api/abl/analysis`
- **Project CRUD**: `/api/projects`, `/api/projects/[id]`
- **Agent CRUD + editing**: `/api/projects/[id]/agents/[agentId]` (GET/PUT/DELETE), `...edit`, `...dsl`, `...compile`, `...lock`, `...diff`
- **Project transport**: `/api/projects/[id]/export`, `...import`, `...git`
- **Settings management**: `/api/projects/[id]/settings`, `...settings/versions`
- **Tool management**: `/api/projects/[id]/tools`, `...tools/[toolId]`
- **MCP servers**: `/api/projects/[id]/mcp-servers`, `...mcp-servers/[serverId]`
- **Infrastructure**: `/api/projects/[id]/config-variables`, `...teams`, `...locks`, `...topology`, `...dependencies`

### Error Responses

All routes follow the error envelope pattern:

```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have editor access to this project"
  }
}
```

Status codes: 400 (validation), 401 (auth), 403 (permission), 404 (not found / tenant isolation), 429 (rate limit), 500 (internal).

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Settings version creation and promotion are logged with `createdBy` / `promotedBy` fields.
- Git sync operations are logged via `createLogger('git-sync-service')` with structured `SyncResult`.
- Project membership changes are tracked via `createdAt` / `updatedAt`.
- **Gap**: No centralized audit trail for agent edits (individual section mutations are not logged to an audit store).

### Rate Limiting

- ABL compilation: 30 req/60s per user via `checkRateLimit`.
- Project creation: Implicitly limited by auth + tenant quotas.
- Git operations: Implicitly limited by circuit breaker and provider rate limits.
- **Gap**: No rate limiting on section edit endpoint (high-frequency by design due to debouncing, but abuse protection is missing).

### Caching

- **Client-side**: SWR with automatic revalidation on focus/reconnect. Cache keys based on URL path.
- **Server-side**: No Redis cache for project data. Compilation is stateless per-request.
- **Project-IO**: No caching of export artifacts. Each export regenerates the archive.
- **Git sync**: `lastSyncCommit` stored in `git_integrations` for incremental diff computation.

### Encryption

- **At rest**: Git credentials stored as `secretId` references to encrypted credential store. `ENCRYPTION_MASTER_KEY` required.
- **In transit**: HTTPS for all API calls. Studio <-> Runtime communication over HTTP (assumed internal network).
- **Import/export**: Credentials sanitized during export. Import restores credential references, not raw secrets.

---

## 8. Dependencies

### Upstream (Studio depends on)

| Dependency                           | Risk                                                   | Mitigation                                                      |
| ------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------- |
| `@abl/core` (parser)                 | Medium -- Parser changes can break IR structure        | Version pinning, compilation error handling                     |
| `@abl/compiler` (IR compiler)        | Medium -- IR schema changes affect all section editors | AgentDetailStore.loadFromIR handles unknown sections gracefully |
| Runtime API                          | High -- All persistence flows through Runtime          | SWR retry, error states in UI                                   |
| MongoDB                              | High -- All data persistence                           | Standard retry, connection pooling                              |
| Git providers (GitHub, GitLab, etc.) | Medium -- External API dependencies                    | Circuit breaker, manual retry in UI                             |
| Redis (optional)                     | Low -- Only for rate limiting                          | Graceful degradation if unavailable                             |

### Downstream (depends on Studio)

| Dependent            | Impact                                                  | Notes                                                     |
| -------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Deployment workflows | High -- Consume project state, settings versions        | Breaking changes to settings schema affect deployments    |
| Channel runtime      | Medium -- Consume project agents, tools, settings       | Project export format changes affect import compatibility |
| Admin portal         | Low -- Admin manages tenants/projects at higher level   | Studio owns day-to-day authoring                          |
| Architect AI         | Medium -- Uses Studio API routes for generation/editing | API contract changes affect Architect flows               |

---

## 9. Open Questions & Decisions Needed

1. **Audit logging for agent edits**: Should individual section mutations be logged to a centralized audit store, or is the agent version history sufficient for traceability?
2. **Rate limiting on edit endpoint**: The section edit endpoint is intentionally high-frequency (debounced saves). Should it have a separate, higher rate limit to prevent abuse while allowing normal editing?
3. **OpenTelemetry for Studio**: Should Studio API routes emit OpenTelemetry spans for compilation latency, edit round-trip time, and git sync duration?
4. **Agent lock lease expiry**: What timeout is appropriate for automatic lock release (5 min? 30 min? configurable?)?
5. **Editor undo/redo**: Should undo/redo be implemented as a client-side operation log, or should it leverage the DSL version history?

---

## 10. References

- Feature spec: [docs/features/agent-development-studio.md](../features/agent-development-studio.md)
- Test spec: [docs/testing/agent-development-studio.md](../testing/agent-development-studio.md)
- Git provider interface: `packages/project-io/src/git/git-provider.ts`
- Git sync service: `packages/project-io/src/git/git-sync-service.ts`
- ABL compiler: `packages/compiler/src/`
- Studio design system: `apps/studio/src/app/globals.css`
- Platform principles: CLAUDE.md Core Invariants
