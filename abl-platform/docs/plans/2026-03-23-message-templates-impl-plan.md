# LLD + Implementation Plan: Message Templates

**Status**: ALPHA (compile-time layer done; CRUD system planned)
**Created**: 2026-03-23
**Last Updated**: 2026-03-26
**HLD**: `docs/specs/message-templates.hld.md`
**Feature Spec**: `docs/features/message-templates.md`
**Test Spec**: `docs/testing/message-templates.md`

---

## Pre-existing Implementation (before this plan)

_Audited: 2026-03-26_

The following capabilities were already implemented when this plan was created and remain stable:

| Component                                          | Status | Location                                                                                                  |
| -------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| DSL `TEMPLATES:` parsing                           | DONE   | `packages/core/src/parser/agent-based-parser.ts`                                                          |
| `compileTemplates()` + `resolveAllTemplateRefs()`  | DONE   | `packages/compiler/src/platform/ir/compiler.ts`                                                           |
| `interpolateMessage()` runtime interpolation       | DONE   | `packages/compiler/src/platform/constructs/evaluator.ts`                                                  |
| WhatsApp HSM template pass-through                 | DONE   | `apps/runtime/src/channels/adapters/whatsapp-providers/whatsapp-transform.ts`                             |
| Compile-time template resolution tests             | DONE   | `packages/compiler/src/__tests__/template-resolution.test.ts` (27 tests, 644 lines)                       |
| Studio Template Catalog (static browse)            | DONE   | `apps/studio/src/components/templates/TemplateCatalogPage.tsx`, `apps/studio/src/lib/template-catalog.ts` |
| Studio Template Insert Panel (static)              | DONE   | `apps/studio/src/components/templates/TemplateInsertPanel.tsx`                                            |
| Studio Template Picker Modal (5 hardcoded samples) | DONE   | `apps/studio/src/components/abl/pickers/TemplatePickerModal.tsx`                                          |

All six phases below describe the project-scoped CRUD system that is NOT YET IMPLEMENTED.

---

## Phase 1: Data Model + Repository (P0) -- PLANNED

**Goal**: Create MongoDB models for message templates and version history, with a repository layer enforcing tenant/project isolation.

### 1.1 Create MessageTemplate Model

**File**: `packages/database/src/models/message-template.model.ts`

```typescript
// Model following the pattern from message.model.ts and prompt-template.model.ts
// - _id: String, default: uuidv7
// - tenantId: String, required, indexed
// - projectId: String, required, indexed
// - name: String, required (slug: /^\w{1,64}$/)
// - content: String, required (max 65536 bytes)
// - variants: Mixed (Record<string, string>)
// - variables: Array of { name, type, required?, defaultValue?, description? }
// - status: String, enum ['draft', 'published'], default 'draft'
// - locale: String, optional
// - source: String, enum ['api', 'dsl'], default 'api'
// - currentVersion: Number, default 1
// - createdBy: String, required
// - updatedBy: String, required
// - timestamps: true
// Indexes:
//   { tenantId: 1, projectId: 1, name: 1 } unique compound
//   { tenantId: 1, projectId: 1 } for list queries
//   { tenantId: 1, projectId: 1, status: 1 } for filtered list
// Apply tenantIsolationPlugin
```

### 1.2 Create MessageTemplateVersion Model

**File**: `packages/database/src/models/message-template-version.model.ts`

```typescript
// Separate collection for version history
// - _id: String, default: uuidv7
// - templateId: String, required
// - tenantId: String, required
// - projectId: String, required
// - version: Number, required
// - content: String, required
// - variants: Mixed (Record<string, string>)
// - variables: Array
// - authorId: String, required
// - changeNote: String, optional
// - timestamps: { createdAt: true, updatedAt: false }
// Indexes:
//   { templateId: 1, version: -1 } for version history queries
//   { tenantId: 1, projectId: 1, templateId: 1 } for isolation
```

### 1.3 Create Message Template Repository

**File**: `packages/database/src/repos/message-template.repo.ts`

```typescript
// Repository class with methods:
// - create(tenantId, projectId, data, userId) -> IMessageTemplate
//     Creates template + first version record (atomic)
// - findById(tenantId, projectId, id) -> IMessageTemplate | null
//     Uses findOne({ _id, tenantId, projectId }), never findById()
// - findByName(tenantId, projectId, name) -> IMessageTemplate | null
// - list(tenantId, projectId, { limit, offset, search?, status? }) -> { data, total }
//     Pagination, text search on name, status filter
// - update(tenantId, projectId, id, data, userId) -> IMessageTemplate
//     Optimistic lock via __v, creates new version record, enforces 50-version cap
// - delete(tenantId, projectId, id) -> boolean
//     Deletes template + all version records
// - getVersions(tenantId, projectId, templateId, { limit?, offset? }) -> versions[]
// - rollback(tenantId, projectId, id, targetVersion, userId) -> IMessageTemplate
//     Creates new version with content from targetVersion
// - bulkFindByNames(tenantId, projectId, names[]) -> IMessageTemplate[]
// - syncFromDSL(tenantId, projectId, templates: Record<string, string>, userId)
//     Upsert with source:'dsl' filter, skip source:'api' templates
```

### 1.4 Export from Database Package

**File**: `packages/database/src/models/index.ts`

Add exports for both new models.

### 1.5 Zod Validation Schemas

**File**: `packages/database/src/schemas/message-template.schema.ts`

```typescript
// Zod schemas for API validation:
// - createMessageTemplateSchema: name (z.string().min(1).max(64).regex(/^\w+$/)),
//   content (z.string().max(65536)), variants, variables, status
// - updateMessageTemplateSchema: partial of create
// - rollbackSchema: version (z.number().int().min(1))
// - listQuerySchema: limit, offset, search, status
// IMPORTANT: Use z.string().min(1) for all ID fields, NOT .cuid() or similar
```

### Exit Criteria

- [ ] Both models created with correct indexes
- [ ] Repository CRUD methods pass with MongoMemoryServer
- [ ] Tenant isolation enforced: cross-tenant findById returns null
- [ ] Project isolation enforced: cross-project findById returns null
- [ ] Version cap: 51st update evicts version 1
- [ ] Optimistic locking: concurrent updates produce conflict
- [ ] Zod schemas validate all edge cases from UNIT-1 through UNIT-4
- [ ] `pnpm build --filter=@agent-platform/database` passes

---

## Phase 2: API Routes (P0) -- PLANNED

**Goal**: REST API endpoints for message template CRUD with full auth/middleware chain.

### 2.1 Create Route File

**File**: `apps/runtime/src/routes/message-templates.ts`

```typescript
// Pattern from apps/runtime/src/routes/tags.ts:
// - createOpenAPIRouter with basePath '/api/projects/:projectId/message-templates'
// - router.use(authMiddleware)
// - router.use(requireProjectScope('projectId'))
// - router.use(tenantRateLimit('request'))
//
// Routes:
// GET    /              — list with pagination + search
// POST   /              — create template
// GET    /:templateId   — get by ID
// PUT    /:templateId   — update template
// DELETE /:templateId   — delete template
// GET    /:templateId/versions — get version history
// POST   /:templateId/rollback — rollback to version
//
// Static routes (/versions, /rollback) MUST be registered BEFORE /:templateId
// per Express route ordering rule in CLAUDE.md
//
// All handlers:
// 1. requireProjectPermission(req, res, 'message-templates:read|write')
// 2. Extract tenantId from req.tenantContext!.tenantId
// 3. Extract projectId from req.params.projectId
// 4. Call repository method
// 5. Return { success: true, data } or { success: false, error: { code, message } }
// 6. Log with createLogger('message-template-route')
```

### 2.2 Register Route in Server

**File**: `apps/runtime/src/server.ts` (or route registration file)

Mount the new router at the correct path. Verify it loads after auth middleware is initialized.

### 2.3 Zod Request Validation

All request bodies validated via Zod schemas registered with the OpenAPI registry.

```typescript
// POST body schema:
const createBody = z.object({
  name: z.string().min(1).max(64).regex(/^\w+$/),
  content: z.string().max(65536),
  variants: z.record(z.string().max(65536)).optional(),
  variables: z
    .array(
      z.object({
        name: z.string().min(1).regex(/^\w+$/),
        type: z.enum(['string', 'number', 'boolean', 'date', 'array', 'object']),
        required: z.boolean().optional(),
        defaultValue: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  status: z.enum(['draft', 'published']).optional(),
});

// PUT body: createBody.partial() but name is not updatable after creation
// Rollback body: z.object({ version: z.number().int().min(1) })
// List query: z.object({ limit, offset, search, status }).partial()
```

### Exit Criteria

- [ ] All 7 route handlers respond with correct status codes
- [ ] Auth middleware rejects requests without valid JWT (401)
- [ ] Project scope middleware rejects cross-project access (404)
- [ ] Rate limiter returns 429 after threshold
- [ ] Zod validation returns 400 on invalid input
- [ ] Duplicate name returns 409
- [ ] Optimistic lock conflict returns 409
- [ ] Response envelope format: `{ success, data/error }`
- [ ] Route registered and accessible on runtime server
- [ ] `pnpm build --filter=runtime` passes

---

## Phase 3: Runtime Template Resolver (P0) -- PLANNED

**Goal**: Runtime service that resolves template names to interpolated content with channel-aware format selection.

### 3.1 Create Template Resolver

**File**: `packages/shared/src/templates/message-template-resolver.ts`

```typescript
// MessageTemplateResolver class:
// - Constructor: maxCacheSize (default 10000), cacheTTL (default 300000ms)
// - cache: Map<string, { template: IMessageTemplate, fetchedAt: number }>
// - resolve(projectId, templateName, channelType, context, tenantId):
//     1. Cache key: `${tenantId}:${projectId}:${templateName}`
//     2. Check L1 cache (TTL check)
//     3. On miss: fetch via lazy-imported repository
//     4. Channel variant selection (CHANNEL_TO_VARIANT mapping)
//     5. Interpolate with renderTemplate() from template-engine.ts
//     6. Return ResolvedTemplate { content, rawContent, channelVariant, warnings }
// - invalidate(tenantId, projectId, templateName): remove from cache
// - invalidateProject(tenantId, projectId): remove all entries for project
// - subscribe(): Redis pub/sub listener for 'template:invalidate' channel
//
// Cache invariants (per CLAUDE.md):
// - Max size: 10,000 entries
// - TTL: 5 minutes
// - LRU eviction when full
```

### 3.2 Channel-to-Variant Mapping

**File**: `packages/shared/src/templates/channel-variant-map.ts`

```typescript
// Maps ChannelType to variant key with family fallback:
// voice_twilio -> 'voice' -> 'default'
// slack -> 'slack' -> 'default'
// web_chat -> 'default'
// etc.
//
// Function: resolveVariantKey(channelType: string): string
// Returns the first matching variant key from the mapping
```

### 3.3 Redis Pub/Sub Integration

**File**: `packages/shared/src/templates/template-cache-invalidation.ts`

```typescript
// publishTemplateInvalidation(tenantId, projectId, templateName?)
//   Publishes to Redis 'template:invalidate' channel
//   Payload: { tenantId, projectId, templateName? }
//   templateName undefined = invalidate entire project
//
// Called from repository.update(), repository.delete(), repository.syncFromDSL()
```

### 3.4 Export and Index

**File**: `packages/shared/src/templates/index.ts`

Export resolver, mapping, and invalidation utilities.

### 3.5 Wire into Runtime

Connect the resolver to the runtime execution path where `TEMPLATE(name)` references are encountered at runtime. This hooks into the message response pipeline, specifically where `renderTemplate()` is already called for system messages.

### Exit Criteria

- [ ] Resolver returns correct channel variant for each ChannelType
- [ ] Fallback to 'default' when channel-specific variant missing
- [ ] Variable interpolation produces correct output for all context types
- [ ] Missing variables produce warnings, not errors
- [ ] Cache TTL expires entries after 5 minutes
- [ ] Cache evicts LRU entries when at max capacity
- [ ] Redis pub/sub invalidation clears cache entries
- [ ] P95 resolution latency < 5ms from cache (benchmark test)
- [ ] `pnpm build --filter=@agent-platform/shared` passes

---

## Phase 4: Compiler Integration (P1) -- PLANNED

**Goal**: Bridge DSL `TEMPLATES:` block compilation with the project template library.

### 4.1 Add syncFromDSL to Repository

Already defined in Phase 1, but the logic is:

```typescript
// syncFromDSL(tenantId, projectId, templates, userId):
// 1. For each template name in the compiled dictionary:
//    a. findOne({ tenantId, projectId, name, source: 'dsl' })
//    b. If exists and content changed: update + new version
//    c. If not exists: create with source: 'dsl'
//    d. If exists with source: 'api': skip + emit compile warning
// 2. Do NOT delete templates not present in DSL (additive sync)
// 3. Return { synced: string[], skipped: string[], warnings: string[] }
```

### 4.2 Wire Sync into Deployment Resolver

**File**: `packages/compiler/src/platform/ir/compiler.ts` (or deployment resolver)

After `compileTemplates()` and `resolveAllTemplateRefs()` succeed:

```typescript
// if (projectContext && compiledTemplates && Object.keys(compiledTemplates).length > 0) {
//   const repo = new MessageTemplateRepository();
//   await repo.syncFromDSL(tenantId, projectId, compiledTemplates, userId);
// }
```

This is conditional — only runs when a project context is available (deployment flow), not during pure DSL validation.

### 4.3 Compile Warnings for Conflicts

When a DSL template name conflicts with an API-created template:

```typescript
// Emit compiler warning:
// W601: Template "disclaimer" exists as API-created template in project.
//       DSL template will not overwrite it. Use the API to update.
```

### Exit Criteria

- [ ] DSL templates sync to project library on compile
- [ ] API-created templates are not overwritten
- [ ] Version history created for DSL template updates
- [ ] Compile warning emitted on name conflict with API template
- [ ] No sync when no TEMPLATES: block in DSL
- [ ] No sync during pure validation (no project context)
- [ ] Existing compileTemplates() and resolveAllTemplateRefs() behavior unchanged
- [ ] `pnpm build --filter=@abl/compiler` passes

---

## Phase 5: Studio UI -- Template Manager (P1) -- PLANNED

**Goal**: Studio page for managing message templates within a project.

### 5.1 Template List Page

**File**: `apps/studio/src/app/[locale]/projects/[projectId]/templates/page.tsx`

- List all templates for the project
- Search by name
- Filter by status (draft/published)
- Sort by name, updatedAt
- Pagination (10/25/50 per page)
- Create button -> opens create modal/drawer

### 5.2 Template Editor Component

**File**: `apps/studio/src/components/templates/TemplateEditor.tsx`

- Content textarea with syntax highlighting for `{{variables}}`
- Tab panel for channel variants (Default, WhatsApp, Slack, Teams, Email, Voice)
- Variable declaration form (add/remove variables with name, type, required, default)
- Preview panel: renders template with sample variable values
- Save button: POST or PUT to API
- Status toggle: draft/published

### 5.3 Version History Component

**File**: `apps/studio/src/components/templates/TemplateVersionHistory.tsx`

- List of versions with author, timestamp, change note
- Select two versions for side-by-side comparison
- Rollback button (creates new version from selected historical version)

### 5.4 Template Picker Component

**File**: `apps/studio/src/components/templates/TemplatePicker.tsx`

- Autocomplete/dropdown for inserting `TEMPLATE(name)` references
- Shows template name, preview of default content, variable list
- Used in agent DSL editor

### 5.5 SWR Hooks

**File**: `apps/studio/src/hooks/useMessageTemplates.ts`

```typescript
// useMessageTemplates(projectId, options) — SWR hook for list
// useMessageTemplate(projectId, templateId) — SWR hook for single template
// useTemplateVersions(projectId, templateId) — SWR hook for version history
// useCreateTemplate(projectId) — mutation hook
// useUpdateTemplate(projectId, templateId) — mutation hook
// useDeleteTemplate(projectId, templateId) — mutation hook
// useRollbackTemplate(projectId, templateId) — mutation hook
```

### 5.6 Navigation Integration

Add "Templates" link to the project sidebar navigation.

### Exit Criteria

- [ ] Template list loads and displays correctly
- [ ] Create template via UI and verify in API
- [ ] Edit template content and variants
- [ ] Version history displays correctly
- [ ] Rollback via UI creates new version
- [ ] Template picker inserts `TEMPLATE(name)` into editor
- [ ] Navigation link accessible from project sidebar
- [ ] `pnpm build --filter=studio` passes

---

## Phase 6: E2E and Integration Tests (P0) -- PLANNED

**Goal**: Implement all test scenarios from the test spec.

### 6.1 E2E Tests

**File**: `apps/runtime/src/__tests__/e2e/message-templates-e2e.test.ts`

Implement E2E-1 through E2E-10 from `docs/testing/message-templates.md`.

Key requirements:

- Real Express server on random port
- Full middleware chain (auth, tenant isolation, rate limiting)
- Real JWT tokens with tenant/project claims
- No `vi.mock()` or `jest.mock()` of codebase components
- Factory functions for seed data

### 6.2 Integration Tests

**File**: `apps/runtime/src/__tests__/integration/message-template-resolver.test.ts`

Implement INT-1 through INT-7.

Key requirements:

- MongoMemoryServer for DB
- Real Redis for cache invalidation tests
- Real template engine (renderTemplate)
- No mocking of codebase components

### 6.3 Unit Tests

**File**: `packages/database/src/__tests__/message-template-validation.test.ts`

Implement UNIT-1 through UNIT-5.

### Exit Criteria

- [ ] All 10 E2E scenarios pass
- [ ] All 7 integration scenarios pass
- [ ] All 5 unit scenarios pass
- [ ] No vi.mock() or jest.mock() in E2E tests
- [ ] No direct DB access in E2E tests (API-only)
- [ ] Coverage targets met per test coverage map

---

## Implementation Order and Dependencies

```
Phase 1 (Data Model + Repository)
  ↓
Phase 2 (API Routes) ← depends on Phase 1 models and repository
  ↓
Phase 3 (Runtime Resolver) ← depends on Phase 1 repository
  ↓
Phase 4 (Compiler Integration) ← depends on Phase 1 repository
  ↓
Phase 5 (Studio UI) ← depends on Phase 2 API routes
  ↓
Phase 6 (Tests) ← depends on all above (but can start E2E after Phase 2)
```

Phases 3 and 4 can be parallelized after Phase 1 is complete.
Phase 5 can start after Phase 2 is complete.
Phase 6 E2E tests can start after Phase 2; integration tests after Phase 3.

---

## Wiring Checklist

This checklist ensures all components are properly wired together. Each item must be verified during implementation.

| #   | Wiring Point          | Source                              | Target                                   | Verification                                           |
| --- | --------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| W1  | Model export          | `message-template.model.ts`         | `packages/database/src/models/index.ts`  | Import in route file succeeds                          |
| W2  | Version model export  | `message-template-version.model.ts` | `packages/database/src/models/index.ts`  | Import in repository succeeds                          |
| W3  | Route registration    | `message-templates.ts`              | `apps/runtime/src/server.ts`             | `GET /api/projects/:pid/message-templates` returns 200 |
| W4  | Resolver export       | `message-template-resolver.ts`      | `packages/shared/src/templates/index.ts` | Import in runtime succeeds                             |
| W5  | Shared package export | `templates/index.ts`                | `packages/shared/src/index.ts`           | Build passes                                           |
| W6  | Cache invalidation    | Repository mutations                | Redis pub/sub                            | Template update invalidates cache                      |
| W7  | Compiler sync         | `compiler.ts` compile flow          | Repository `syncFromDSL`                 | DSL template appears in API list                       |
| W8  | Studio navigation     | Sidebar config                      | Templates page                           | Click "Templates" navigates to list page               |
| W9  | SWR hooks             | `useMessageTemplates.ts`            | Template list page                       | List renders from API data                             |
| W10 | Dockerfile update     | New packages                        | All app Dockerfiles                      | `pnpm install --frozen-lockfile` succeeds in Docker    |

---

## Risk Mitigation

| Risk                                                 | Mitigation                                                                        | Phase   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| MongoDB transaction failures during version creation | Retry once, then fall back to non-transactional write with version reconciliation | Phase 1 |
| Express route ordering conflict with `:templateId`   | Register static routes (`/versions`, `/rollback`) before parameterized route      | Phase 2 |
| Cache stampede on cold start                         | Singleflight pattern: only one fetch per template name when cache is cold         | Phase 3 |
| DSL sync during CI/CD compilation                    | Guard sync with `projectContext` check; pure validation does not sync             | Phase 4 |
| Studio build failure from new page route             | Verify `[locale]` and `[projectId]` params match existing patterns                | Phase 5 |
