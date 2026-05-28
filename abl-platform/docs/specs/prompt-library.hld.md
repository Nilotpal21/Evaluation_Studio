# HLD: Prompt Library

**Feature Spec**: `docs/features/prompt-library.md`
**Test Spec**: `docs/testing/prompt-library.md`
**Status**: IMPLEMENTED
**Author**: prasanna@kore.com
**Date**: 2026-04-27
**Implemented**: 2026-04-28

---

## 1. Problem Statement

Prompt iteration on ABL Platform today is primitive. Editing a system prompt requires modifying the `SYSTEM_PROMPT:` DSL directive, recompiling the agent, creating a new agent version, and validating through the Studio debug chat — a 5+ minute round trip per iteration. There is no isolated prompt-testing surface, no version history for prompts separate from agent versions, and no way to compare a prompt across models or compare versions against a single model.

The platform-wide `PromptTemplate` model (`packages/database/src/models/prompt-template.model.ts`) is an internal seed catalog — not user-editable, not tenant-scoped, not surfaced in Studio. Prompt engineers and agent developers resort to side-channel comparison (multiple browser windows, manual spreadsheets) and ad-hoc deployment cycles that are slow, error-prone, and impossible to audit.

This HLD designs a **project-scoped Prompt Library** — a first-class versioned resource with a single-turn test harness and compiler integration — that reduces iteration cycle time from minutes to seconds.

### Overview / Goal

Add a project-scoped Prompt Library under Studio → Resources that lets users:

1. **Author and version prompts** as named, reusable assets with a 3-state lifecycle (`draft` / `active` / `archived`).
2. **Reference a library prompt from an agent** by pinning a specific version (`libraryRef`) — resolved at compile time into the agent IR so runtime execution is unchanged.
3. **Test prompts side-by-side** in a single-turn harness: one prompt × N models (find the cheapest model that meets quality bar) or N versions × one model (regression-test an edit), with credential and budget governance via `ModelResolutionService`.
4. **Observe reverse references** — which agents use which prompt versions — before archiving or upgrading.

The design must honour all platform invariants: tenant/project isolation (404 on cross-scope access), centralized auth via `createUnifiedAuthMiddleware`, audit logging on all lifecycle transitions, and sanitized user-facing error messages.

---

## 2. Alternatives Considered

### Option A: Runtime-native service with Studio proxy (Recommended)

- **Description**: Runtime (`apps/runtime`) owns all CRUD, version lifecycle, and test execution for the Prompt Library. Studio Next.js API routes act as authenticated proxies using the existing `proxyToRuntime()` helper (`apps/studio/src/lib/runtime-proxy.ts`). The compiler integration is a pre-compile hook in `VersionService.createVersion()` that resolves `libraryRef` → template before calling `compileABLtoIR()`.
- **Pros**: Single source of truth for credential and budget governance (ModelResolutionService stays in runtime). Consistent with Tool Library, Knowledge Base, and Model Hub patterns. Studio isolation requirements (CLAUDE.md: "never rely on ALS in Studio routes") are satisfied because Studio never writes to DB directly. Rollback is one line in `server.ts`.
- **Cons**: Design-time CRUD requires HTTP hop from Studio to runtime. Slightly higher latency for list/edit operations (acceptable for control-plane operations).
- **Effort**: M

### Option B: Studio-owned service with direct DB access

- **Description**: Studio Next.js API routes own CRUD and write directly to MongoDB via Mongoose. Only the test invocation crosses to runtime.
- **Pros**: No HTTP hop for CRUD in Studio; potentially simpler Studio UX.
- **Cons**: Violates CLAUDE.md invariant — Studio route handlers lack AsyncLocalStorage tenant injection and must scope every query to `user.tenantId` explicitly. Duplicates auth and isolation patterns. Creates split ownership of the same data type (Studio writes, runtime reads for compile). `ModelResolutionService` would need to be called from Studio, breaking the service boundary.
- **Effort**: M (but introduces architectural debt)

### Option C: Dedicated microservice

- **Description**: Extract a standalone `prompt-library-service` from both Studio and runtime.
- **Pros**: Independent scaling; clear domain ownership.
- **Cons**: Gross over-engineering for v1. Adds new service lifecycle (Dockerfile, Kubernetes manifest, CI pipeline). Adds network hop on the critical execution path. Nothing in the current feature set justifies a new service.
- **Effort**: XL

### Recommendation: Option A

Option A follows the established platform pattern (runtime owns data + credential governance, Studio proxies), requires minimal new infrastructure, and has a trivial rollback story. The control-plane HTTP hop latency for CRUD operations is acceptable — these are authoring-time operations, not session execution path.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Studio (5173)                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Prompt Library UI Pages (list, detail, compare)         │  │
│  │  IdentityEditor (agent system-prompt picker)             │  │
│  │  Studio API Routes (/api/projects/[id]/prompt-library/*) │  │
│  └──────────────────────────┬───────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │ proxyToRuntime() — JWT + tenantId
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Runtime (3112)                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Router: /api/projects/:projectId/prompt-library/*       │  │
│  │  Middleware: unifiedAuth → requireProjectScope →         │  │
│  │             tenantRateLimit → requireProjectPermission   │  │
│  │  PromptLibraryService (CRUD + lifecycle)                 │  │
│  │  PromptLibraryTestService (single-turn test)             │  │
│  └──────────┬────────────────────────┬────────────────────--┘  │
│             │                        │                          │
│    ┌────────▼───────┐    ┌───────────▼──────────────┐          │
│    │  MongoDB        │    │  ModelResolutionService  │          │
│    │  prompt_library │    │  + Vercel AI SDK         │          │
│    │  _items         │    │  generateText()          │          │
│    │  prompt_library │    └───────────┬──────────────┘          │
│    │  _versions      │               │                          │
│    └─────────────────┘    ┌──────────▼──────────────┐          │
│                           │  LLM Provider (HTTP)    │          │
│                           └─────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
              (compile-time libraryRef resolution)
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│  Compiler Package (packages/compiler)                           │
│  compileABLtoIR() — pure, no DB                                 │
│  VersionService.createVersion() — orchestrates compile          │
│    ↳ pre-compile hook: fetch PromptLibraryVersion               │
│    ↳ copy template + set custom: true + record resolvedHash     │
│    ↳ pass resolved IR to compileABLtoIR()                       │
└─────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
packages/database/
  ├── prompt-library-item.model.ts      (new — PromptLibraryItem)
  └── prompt-library-version.model.ts  (new — PromptLibraryVersion)

packages/shared-auth/
  └── role-permissions.ts              (modified — 6 new prompt:* permissions)

packages/compiler/
  └── ir/schema.ts                     (modified — SystemPromptConfig + libraryRef; type-only, compileABLtoIR() unchanged)

apps/runtime/
  ├── routes/prompt-library.ts         (new — 13 Express route handlers)
  ├── server.ts                        (modified — mount router)
  ├── services/prompt-library/
  │   ├── prompt-library-service.ts    (new — CRUD + lifecycle, atomic promote)
  │   └── prompt-library-test-service.ts (new — single-turn test via ModelResolutionService)
  └── services/agent-compile/          (modified — libraryRef pre-compile hook)

apps/studio/
  ├── app/api/projects/[id]/prompt-library/** (new — proxy routes)
  ├── config/navigation.ts             (modified — 4th resourceNavDef)
  ├── store/navigation-store.ts        (modified — ProjectPage union)
  ├── app/projects/[id]/resources/prompt-library/** (new — 3 UI pages)
  └── components/
      ├── prompt-library/PromptEditor.tsx        (new)
      ├── prompt-library/PromptComparePanel.tsx  (new)
      ├── prompt-library/PromptPickerModal.tsx   (new)
      └── agent-editor/sections/IdentityEditor.tsx (modified)
```

### Data Flow: Test Endpoint (FR-4, FR-5)

```
1. Studio UI: POST /api/projects/P/prompt-library/test
   body: { promptVersionId, variables, userMessage, tenantModelIds, mode }

2. Studio API route (/api/projects/[id]/prompt-library/test/route.ts)
   → proxyToRuntime(request, '/api/projects/P/prompt-library/test', {
       method: 'POST', body, tenantId: user.tenantId
     })
   Adds: Authorization: Bearer <jwt>, X-Tenant-Id: <tenantId>

3. Runtime middleware chain:
   createUnifiedAuthMiddleware()      → sets req.tenantContext (ALS)
   requireProjectScope('projectId')  → validates project membership
   tenantRateLimit('request')        → rate gate
   requireProjectPermission(req, res, 'prompt:test')

4. PromptLibraryTestService.executeCompare({ mode, ... })
   → load version(s) from PromptLibraryVersion (scoped tenantId+projectId)
   → renderTemplate(template, sanitizedVariables) per version
   → build pane tasks: [{ tenantModelId, renderedTemplate, userMessage }]

5. Promise.all(paneTasks.map(pane =>
     ModelResolutionService.resolve(pane.tenantModelId, userId)
       .then(resolved => createVercelProvider(resolved))
       .then(provider => generateText({
           model: provider,
           system: pane.renderedTemplate,
           messages: [{ role: 'user', content: pane.userMessage }],
           maxRetries: 0,
           abortSignal: paneController.signal
         }))
       .then(result => ({ ...pane, output: result.text, usage: result.usage, latencyMs }))
       .catch(err => ({ tenantModelId: pane.tenantModelId, error: sanitize(err) }))
   ))
   → partition into panes[] and failedPanes[]

6. Emit TraceEvent: prompt-library.test.complete
   Do not emit an AuditLog row; prompt tests remain execution telemetry

7. Return HTTP 200:
   { panes: [...], failedPanes: [...] }
```

### Data Flow: Compile-time libraryRef Resolution (FR-6)

```
1. Agent working copy has system_prompt.libraryRef = { promptId, versionId }

2. VersionService.createVersion() (apps/runtime/src/services/version-service.ts)
   ↓
3. Pre-compile hook: if (workingCopy.system_prompt?.libraryRef)
     const version = await PromptLibraryService.getVersion(libraryRef, { tenantId, projectId })
     if (version.status === 'archived') throw PROMPT_LIBRARY_VERSION_ARCHIVED
     workingCopy.system_prompt.template = version.template
     workingCopy.system_prompt.custom = true
     workingCopy.system_prompt.libraryRef.resolvedHash = sha256(version.template)
   ↓
4. compileABLtoIR(workingCopy) — compiler sees resolved template, custom: true
   Compiler is PURE — no DB calls, no libraryRef awareness
   ↓
5. Post-compile: PromptLibraryService.incrementUsageCount(promptId)
   ↓
6. Persist AgentVersion with resolved IR (libraryRef + template both stored)

7. Runtime execution: buildSystemPrompt() sees custom: true + resolved template
   → No library access at runtime
```

### Sequence Diagram: Atomic Promote

```
Client            Runtime Route          PromptLibraryService      MongoDB
  │                     │                        │                     │
  │ POST /promote        │                        │                     │
  │─────────────────────►│                        │                     │
  │                      │ promoteVersion(id)     │                     │
  │                      │───────────────────────►│                     │
  │                      │                        │ findOneAndUpdate(   │
  │                      │                        │  {_id: id,          │
  │                      │                        │   promptId,         │
  │                      │                        │   status: 'draft'}, │
  │                      │                        │  {status: 'active'} │
  │                      │                        │ )                   │
  │                      │                        │────────────────────►│
  │                      │            modifiedCount=1 or 0             │
  │                      │                        │◄────────────────────│
  │                      │   if modifiedCount=0   │                     │
  │                      │   throw CONCURRENT_MOD │                     │
  │                      │                        │                     │
  │                      │ demoteOldActive()       │                     │
  │                      │  (atomic second update)│                     │
  │                      │                        │────────────────────►│
  │                      │                        │◄────────────────────│
  │                      │                        │ emit audit event    │
  │ 200 { status:active }│◄───────────────────────│                     │
  │◄─────────────────────│                        │                     │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Both `PromptLibraryItem` and `PromptLibraryVersion` use `tenantIsolationPlugin` (ALS-injected `tenantId` on every query, matching `WorkflowVersion`). Every route handler additionally includes explicit `projectId` filter. Studio proxy routes pass `tenantId: user.tenantId` via `proxyToRuntime()` — never relying on ALS (CLAUDE.md: Studio routes lack ALS injection). Cross-scope access returns 404, never 403.                                                                                                                                                                 |
| 2   | **Data Access Pattern** | Service classes (`PromptLibraryService`, `PromptLibraryTestService`) wrap repository functions (lazy-import pattern from `project-repo.ts`). No caching at CRUD layer — control-plane data, low read rate, no hot-path dependency. Active version fetched per compile invocation; if compile frequency is high, a short-lived (5s) in-process LRU cache per `(tenantId, promptId)` can be added in a follow-up.                                                                                                                                                                         |
| 3   | **API Contract**        | REST over JSON. 13 runtime endpoints under `/api/projects/:projectId/prompt-library/`. Response envelope: `{ success: true, data: {...} }` on success; `{ success: false, error: { code: 'PROMPT_LIBRARY_*', message } }` on error. All codes documented in §6. Studio proxy mirrors runtime paths under Next.js App Router. No breaking changes to existing endpoints.                                                                                                                                                                                                                 |
| 4   | **Security Surface**    | `createUnifiedAuthMiddleware` + `requireProjectPermission(req, res, 'prompt:<op>')` on every handler. Zod `.strict()` schemas at route boundary (CLAUDE.md: no unknown fields, no double-body-parse). Variable values stripped of `{{`/`}}` before template render (FR-13). Error responses routed through shared sanitizer helpers — no tenant IDs, model IDs, or credential hints in user-facing errors. No user-supplied URLs (no SSRF risk). No `eval`/`new Function` — template engine is regex-based string substitution at `packages/shared/src/prompts/template-engine.ts:101`. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **User-visible**: structured `PROMPT_LIBRARY_*` error codes with human-readable messages, no internal context leaked. **Service-level**: typed errors propagated from service to route handler, caught by Express error handler. **Test endpoint**: partial failure returns HTTP 200 with `{ panes, failedPanes: [{ tenantModelId, error: { code, message } }] }` — caller gets maximum useful data even when some panes fail. **Compile-time missing ref**: throws a sanitized `ModelResolutionConfigurationError`-shaped error with raw `promptId`/`versionId` in server logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | **Failure Modes** | **Concurrent promote**: `findOneAndUpdate` with `status: 'draft'` guard — losing concurrent update receives `modifiedCount: 0` → 409. **Promote two-step window**: promote is two sequential `findOneAndUpdate` calls — first sets new version to `active`, second sets the previously-active version to `archived`. Between these two writes there is a transient window where two versions are simultaneously `active`. This window is bounded to a single request handler, is not observable by concurrent read queries (no read path fetches two active versions simultaneously), and does not result in data corruption. The LLD must either wrap both operations in a MongoDB session/transaction (preferred if MongoMemoryServer replica-set support is available in tests) or explicitly document the window as an accepted invariant. INT-1 must verify the post-promote state. **LLM provider timeout**: each compare pane has its own `AbortController` keyed to `PROMPT_LIBRARY_TEST_TIMEOUT_MS` (default 60s); timeout → pane goes to `failedPanes`. **MongoDB transient error**: standard Express error handler returns 500. **Studio → runtime network error**: `proxyToRuntime()` propagates status code; catches fetch error as 502. **Archived libraryRef at compile time**: rejected with 400 before agent version is written — agent is left in working-copy state. |
| 7   | **Idempotency**   | Create endpoints accept `Idempotency-Key` header (existing platform pattern in Express middleware). Version promote: check current status before update; if already `active`, return 200 idempotently. Test endpoint is inherently non-idempotent (LLM invocation). Delete endpoint is idempotent (404 on repeat is acceptable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | **Observability** | **Trace events**: `prompt-library.test.start`, `prompt-library.test.pane.start`, `prompt-library.test.pane.complete` (with `latencyMs`, `tokens.input`, `tokens.output`, `model`, `provider`), `prompt-library.test.complete`. Tags scrubbed by the existing tenant-scrubbing pipeline. **Audit logs**: `prompt.created`, `prompt.version_created`, `prompt.version_promoted`, `prompt.version_archived` — emitted post-commit via `audit-helpers.ts:getAuditStore()`. Prompt tests remain execution telemetry. **Metrics**: test endpoint p95/p99 latency, compare pane count distribution, version promotion rate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Test endpoint ≤500ms platform overhead (p95, excluding LLM provider latency). Compare mode ≤(max single-pane latency + 1s) via `Promise.all` over up to 5 panes. Reverse-reference query ≤200ms (project-scoped `agent_versions` scan, acceptable for ≤1000 agents; denormalized index added if it becomes a hotspot per GAP-003). List endpoint ≤100ms (paginated, indexed). Template render O(n) per variable, <10ms at 32KB/20-var limit.                                                                                                                                  |
| 10  | **Migration Path**     | **Zero data migration required**. Both new collections are created on first document insert (Mongoose default). `SystemPromptConfig.libraryRef` is an optional additive field — existing `AgentVersion` documents without it continue to work unchanged. Runtime `buildSystemPrompt()` already handles `custom: true` via optional chaining; libraryRef field is ignored when absent.                                                                                                                                                                                         |
| 11  | **Rollback Plan**      | **One-line rollback**: remove the `app.use('/api/projects/:projectId/prompt-library', promptLibraryRouter)` mount from `apps/runtime/src/server.ts`. Studio proxy routes become unreachable. New `PromptLibraryItem`/`PromptLibraryVersion` collections remain in DB (harmless orphan data — no schema enforces foreign keys). The optional `libraryRef` field on `SystemPromptConfig` is ignored by all existing code. No destructive actions needed. Agents compiled with `libraryRef` already have the resolved template in their IR — they continue to execute correctly. |
| 12  | **Test Strategy**      | Per the approved test spec (`docs/testing/prompt-library.md`): **8 unit tests** (pure functions: schema validation, sourceHash, extractVariables, sanitizer, boundary helpers, RBAC registry, type extension); **12 integration tests** (real MongoDB via MongoMemoryServer, real services, DI-only LLM transport — no vi.mock of platform components); **7 E2E tests** (real HTTP via `startRuntimeServerHarness()` on random port, full middleware chain, no DB access in tests). Studio E2E-7 uses real Playwright + real MongoDB.                                         |

---

## 5. Data Model

### New Collections

```
Collection: prompt_library_items
MongoDB collection name: prompt_library_items
Plugin: tenantIsolationPlugin

Fields:
  _id:          string        (pl_<ulid>, required)
  tenantId:     string        (required, ALS-injected)
  projectId:    string        (required)
  name:         string        (required, unique within tenantId+projectId, max 128)
  description:  string?       (optional, max 512)
  tags:         string[]      (default [])
  usageCount:        number   (default 0, denormalized — updated by compile hook)
  nextVersionNumber: number   (default 0, atomically incremented via $inc on each version creation — provides TOCTOU-safe monotonic assignment)
  status:            'active'|'archived'  (item-level lifecycle, default 'active'; only 'active' items may have new versions created; manual archive via PATCH .../prompts/:promptId, v1)
  createdBy:         string   (userId)
  createdAt:         Date
  updatedAt:         Date

Indexes:
  { tenantId: 1, projectId: 1, name: 1 }   UNIQUE
  { tenantId: 1, projectId: 1, status: 1 }
  { tenantId: 1, projectId: 1, tags: 1 }

---

Collection: prompt_library_versions
MongoDB collection name: prompt_library_versions
Plugin: tenantIsolationPlugin

Fields:
  _id:           string        (plv_<ulid>, required)
  tenantId:      string        (required, ALS-injected)
  projectId:     string        (required)
  promptId:      string        (required, FK to prompt_library_items._id)
  versionNumber: number        (monotonic per promptId, auto-assigned)
  template:      string        (required, max 32KB)
  variables:     string[]      (required, max 20 items, each name max 64 chars)
  description:   string?       (optional, max 512, changelog for this version)
  status:        'draft'|'active'|'archived'  (required)
  sourceHash:    string        (sha256 of template + sorted variables JSON, immutable)
  metadata:      Record<string, unknown>?  (optional, extensible)
  createdBy:     string        (userId)
  createdAt:     Date
  publishedAt:   Date?         (set on transition to 'active')
  publishedBy:   string?       (set on transition to 'active')

Indexes:
  { tenantId: 1, projectId: 1, promptId: 1, versionNumber: 1 }  UNIQUE
  { tenantId: 1, projectId: 1, promptId: 1, status: 1 }          (fast active lookup)
  { tenantId: 1, projectId: 1, sourceHash: 1 }                   (dedup detection)
```

### Modified Collections

**`agent_versions.irContent.identity.system_prompt`** (existing field, additive change):

```typescript
// packages/compiler/src/platform/ir/schema.ts (additive only)
export interface SystemPromptConfig {
  template: string;
  custom?: boolean;
  sections: {
    context?: boolean;
    tools?: boolean;
    constraints?: boolean;
    history?: boolean;
  };
  // NEW — optional, resolved at compile time into template + custom: true
  libraryRef?: {
    promptId: string;
    versionId: string;
    resolvedHash: string; // sha256 of resolved template for staleness detection
  };
}
```

Existing documents without `libraryRef` are unaffected — optional chaining at all read sites.

**`packages/shared-auth/src/rbac/role-permissions.ts`** — new `PERMISSION_REGISTRY` category:

```typescript
{
  category: 'prompt-library',
  label: 'Prompt Library',
  permissions: [
    'prompt:create', 'prompt:read', 'prompt:update',
    'prompt:delete', 'prompt:test', 'prompt:promote'
  ]
}
// PROJECT_ROLE_PERMISSIONS updates:
//   developer:  all 6
//   tester:     prompt:read, prompt:test
//   viewer:     prompt:read
```

### Key Relationships

```
PromptLibraryItem (1) ────── has many ────── PromptLibraryVersion (N)
  (promptId FK on version)
  (at most 1 active version per item at any time — enforced by optimistic lock)

PromptLibraryVersion.promptId ─── references ─── PromptLibraryItem._id
  (same tenantId + projectId — cross-project reference rejected at compile time)

AgentVersion.irContent.identity.system_prompt.libraryRef.{promptId, versionId}
  ─── compile-time resolved from ─── PromptLibraryVersion
  (NOT a FK enforced by MongoDB — IR is self-contained after compile)
  (runtime NEVER reads PromptLibraryVersion during session execution)

PromptLibraryItem.usageCount ─── denormalized from ─── agent_versions scan
  (updated by compile hook; source of truth is GET .../references query)
```

---

## 6. API Design

### New Endpoints (Runtime)

All routes mount under `/api/projects/:projectId/prompt-library`. Auth: `createUnifiedAuthMiddleware` + `requireProjectScope('projectId')` + `requireProjectPermission(req, res, 'prompt:<op>')`.

| Method | Path                                             | Purpose                                                            | Permission       |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------ | ---------------- |
| POST   | `/prompts`                                       | Create prompt (+ optional initial draft version)                   | `prompt:create`  |
| GET    | `/prompts`                                       | List prompts (paginated; filter by tag, status)                    | `prompt:read`    |
| GET    | `/prompts/:promptId`                             | Get prompt with versions metadata                                  | `prompt:read`    |
| PATCH  | `/prompts/:promptId`                             | Update prompt metadata (name, description, tags)                   | `prompt:update`  |
| DELETE | `/prompts/:promptId`                             | Delete prompt (only if no live agent references)                   | `prompt:delete`  |
| POST   | `/prompts/:promptId/versions`                    | Create a draft version                                             | `prompt:create`  |
| GET    | `/prompts/:promptId/versions`                    | List versions of a prompt                                          | `prompt:read`    |
| GET    | `/prompts/:promptId/versions/:versionId`         | Get a specific version's full content                              | `prompt:read`    |
| PATCH  | `/prompts/:promptId/versions/:versionId`         | Update a draft version (rejected if not `draft`)                   | `prompt:update`  |
| POST   | `/prompts/:promptId/versions/:versionId/promote` | Promote draft → active (atomic demote-and-promote)                 | `prompt:promote` |
| POST   | `/prompts/:promptId/versions/:versionId/archive` | Archive a version                                                  | `prompt:promote` |
| GET    | `/prompts/:promptId/references`                  | Reverse references — agents using this prompt (count + list)       | `prompt:read`    |
| POST   | `/test`                                          | Single-turn test: one version × N models OR N versions × one model | `prompt:test`    |

### Studio Proxy Endpoints

All proxied via `proxyToRuntime()` from `apps/studio/src/app/api/projects/[projectId]/prompt-library/`. Mirror every runtime endpoint above. Studio routes validate auth via Next.js middleware before proxying; runtime re-validates on receipt.

### Request/Response Shapes (key endpoints)

**POST `/prompts`**

```typescript
// Request
{
  name: string,              // max 128
  description?: string,
  tags?: string[],
  initialVersion?: {
    template: string,        // max 32KB
    variables?: string[],    // max 20
    description?: string
  }
}
// Response 201
{
  success: true,
  data: {
    prompt: PromptLibraryItem,
    version?: PromptLibraryVersion   // if initialVersion provided
  }
}
```

**POST `/test`**

```typescript
// Request — Mode A: one version × N models
{
  mode: 'compare-models',
  promptVersionId: string,
  tenantModelIds: string[],   // 1–5
  variables?: Record<string, string>,
  userMessage: string
}
// Request — Mode B: N versions × one model
{
  mode: 'compare-versions',
  promptVersionIds: string[],  // 1–5
  tenantModelId: string,
  variables?: Record<string, string>,
  userMessage: string
}
// Response 200
{
  success: true,
  data: {
    panes: Array<{
      promptVersionId: string,
      tenantModelId: string,
      output: string,
      usage: { input: number, output: number, total: number },
      latencyMs: number,
      model: string,
      provider: string
    }>,
    failedPanes: Array<{
      tenantModelId?: string,
      promptVersionId?: string,
      error: { code: string, message: string }
    }>
  }
}
```

### Error Responses

| Code                                      | HTTP Status | Trigger                                               |
| ----------------------------------------- | ----------- | ----------------------------------------------------- |
| `PROMPT_LIBRARY_NOT_FOUND`                | 404         | Prompt or version not in tenant+project scope         |
| `PROMPT_LIBRARY_NAME_CONFLICT`            | 409         | Duplicate name within project                         |
| `PROMPT_LIBRARY_VERSION_NOT_DRAFT`        | 400         | Attempt to update a non-draft version                 |
| `PROMPT_LIBRARY_VERSION_ARCHIVED`         | 400         | Attempt to reference an archived version              |
| `PROMPT_LIBRARY_CONCURRENT_PROMOTE`       | 409         | Concurrent promote race — losing update               |
| `PROMPT_LIBRARY_TEMPLATE_TOO_LARGE`       | 400         | Template > 32KB                                       |
| `PROMPT_LIBRARY_TOO_MANY_VARIABLES`       | 400         | Variables > 20                                        |
| `PROMPT_LIBRARY_VARIABLE_VALUE_TOO_LARGE` | 400         | Variable value > 4KB at test endpoint                 |
| `PROMPT_LIBRARY_VERSION_LIMIT_EXCEEDED`   | 400         | 201st version on a single prompt                      |
| `PROMPT_LIBRARY_INVALID_COMPARE_MODE`     | 400         | Cross-product N versions × M models requested         |
| `PROMPT_LIBRARY_TOO_MANY_PANES`           | 400         | More than 5 panes requested                           |
| `PROMPT_LIBRARY_HAS_REFERENCES`           | 409         | Delete attempted on prompt with live agent references |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: `prompt.created` (on POST /prompts), `prompt.version_created` (on POST .../versions), `prompt.version_promoted` (on POST .../promote), and `prompt.version_archived` (on POST .../archive). All emitted post-commit via the helper functions in `apps/runtime/src/services/audit-helpers.ts` (which wraps `getAuditStore()` from `audit-store-singleton.ts`). Prompt test runs remain execution telemetry, not durable audit rows. Never emitted before the DB write commits.

- **Rate Limiting**: Standard `tenantRateLimit('request')` applied at the router level, same as all project-scoped routes. No feature-specific rate limit in v1. If compare-mode requests become a budget concern, a separate `tenantRateLimit('llm-test')` bucket can be added per prompt-library test endpoint.

- **Caching**: No caching at the CRUD layer in v1. The active-version lookup during compile is a single indexed DB query — fast enough without a cache. If compile hotspot emerges, add a short-lived (5s TTL) in-process LRU keyed on `(tenantId, promptId)` in `PromptLibraryService.getActiveVersion()`.

- **Encryption**: Templates are not credentials — no field-level encryption. Standard MongoDB encryption-at-rest via infrastructure applies. All data in transit encrypted via TLS (HTTPS/WSS enforced at load balancer).

- **Feature Gate**: The feature is enabled by default for all tenants post-deploy (RBAC is the access gate, not a feature flag). If a soft-launch is needed, `requireFeature('prompt-library')` from `apps/runtime/src/middleware/feature-gate.ts` can be applied as additional middleware on the router mount (fail-open; use `createFailClosedFeatureGate('prompt-library')` if hard-gate behaviour is required).

- **Right-to-Erasure**: Project deletion cascades delete all `PromptLibraryItem` and `PromptLibraryVersion` documents via the existing project-deletion cascade path. No additional cascade configuration needed — the cascade pattern already removes all project-scoped resources.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                       | Type                                   | Risk   | Notes                                                                                                              |
| -------------------------------- | -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `ModelResolutionService`         | Internal service                       | LOW    | Already stable (BETA); test endpoint delegates to it. Used at runtime only.                                        |
| `tenantIsolationPlugin`          | `@agent-platform/database`             | LOW    | Stable pattern used by WorkflowVersion, ConnectorVersion, etc.                                                     |
| `createUnifiedAuthMiddleware`    | `@agent-platform/shared-auth`          | LOW    | Stable, centralized — no change needed.                                                                            |
| Vercel AI SDK `generateText()`   | External (npm)                         | LOW    | Already used in session-llm-client.ts. Test endpoint uses same import path.                                        |
| `renderTemplate()`               | `packages/shared`                      | LOW    | Stable regex-based template engine; no changes needed.                                                             |
| `proxyToRuntime()`               | `apps/studio/src/lib/runtime-proxy.ts` | LOW    | Stable proxy helper; already used by other Studio API routes.                                                      |
| `compileABLtoIR()`               | `packages/compiler`                    | LOW    | Remains pure — no changes to the compiler itself. Pre-compile hook is in VersionService.                           |
| `VersionService.createVersion()` | Internal service                       | MEDIUM | Adding a pre-compile hook here. Needs careful testing (INT-8) to avoid regressions on existing agent compile flow. |

### Downstream (depends on this feature)

| Consumer                         | Impact                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent IdentityEditor (Studio)    | Gains prompt picker — additive UI change, no behavior change to existing inline-prompt path.             |
| Agent compile (`VersionService`) | Gains optional `libraryRef` pre-compile hook — existing compile path unchanged when `libraryRef` absent. |
| Runtime `buildSystemPrompt()`    | Zero change — receives resolved template via `custom: true`, same code path as today.                    |
| Audit pipeline                   | 5 new `prompt.*` event types added.                                                                      |
| RBAC system                      | 6 new permissions in PERMISSION_REGISTRY. Existing roles updated (developer, tester, viewer).            |

---

## 9. Open Questions & Decisions Needed

1. **Reverse-reference indexing strategy (GAP-003)**: Start with query-time scan of `agent_versions.irContent` (acceptable for ≤1000 agents per project). If the `/references` endpoint becomes slow for large projects, add a denormalized `prompt_library_references` collection updated by the compile hook. Decision can be deferred until performance monitoring shows regression — INT-11 perf test covers the 1000-agent benchmark.

2. **usageCount increment timing**: Should `usageCount` be incremented in the compile hook (`VersionService.createVersion()`) synchronously, or asynchronously (fire-and-forget)? Synchronous is simpler and consistent with the current `WorkflowVersion` pattern, but adds a DB write to the compile critical path. Recommendation: synchronous for v1 (compile path is already DB-heavy); add async option in v2 if profiling shows it matters.

3. **libraryRef resolution during agent PATCH vs full compile**: When a developer PATCHes an agent's working copy to set `libraryRef`, does the pre-compile hook run immediately, or only on the next `POST .../deployments`? Decision: resolution happens at compile time (when a new `AgentVersion` is created), not on PATCH. Working copy stores the `libraryRef` intent; IR resolution happens on compile.

4. **`versionNumber` assignment**: Should `versionNumber` be a DB-level sequence (using `findOneAndUpdate` increment) or application-level (`max(versionNumber) + 1` in service)? Risk: application-level is susceptible to a TOCTOU race under concurrent version creation. Recommendation: use `findOneAndUpdate` with `$inc: { versionNumber: 1 }` on the parent item to atomically assign the next version number.

---

## 10. References

- Feature spec: `docs/features/prompt-library.md`
- Test spec: `docs/testing/prompt-library.md`
- SDLC log: `docs/sdlc-logs/prompt-library/`
- Related HLDs:
  - `docs/specs/agent-anatomy.hld.md` (SystemPromptConfig + IR contract)
  - `docs/specs/agent-development-studio.hld.md` (IdentityEditor + resourceNavDefs)
  - `docs/specs/model-hub.hld.md` (ModelResolutionService contract)
  - `docs/specs/agent-testing-evals.hld.md` (sibling feature, distinct scope)
  - `docs/specs/arch-audit-logs.hld.md` (audit emission pattern)
- Code patterns referenced:
  - `apps/runtime/src/services/version-service.ts` — `promoteVersion()` optimistic lock pattern
  - `apps/studio/src/lib/runtime-proxy.ts` — `proxyToRuntime()` Studio proxy helper
  - `apps/runtime/src/services/llm/model-resolution.ts` — `ModelResolutionService.resolve()`
  - `packages/shared-auth/src/rbac/role-permissions.ts` — `PERMISSION_REGISTRY` structure
  - `apps/runtime/src/server.ts` — project-scoped router mount pattern
  - `apps/runtime/src/middleware/feature-gate.ts` — `requireFeature()`, `createFailClosedFeatureGate()`
