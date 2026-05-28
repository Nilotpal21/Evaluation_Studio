# High-Level Design: Message Templates

**Status**: ALPHA (partially implemented)
**Created**: 2026-03-23
**Last Updated**: 2026-03-26
**Feature Spec**: `docs/features/message-templates.md`
**Test Spec**: `docs/testing/message-templates.md`

---

## Implementation Status

_Audited: 2026-03-26_

| Component (from architecture diagram)                         | Status      | Notes                                                                                                                           |
| ------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **DSL Compiler** (template parsing + compile-time resolution) | DONE        | `compileTemplates()` and `resolveAllTemplateRefs()` in `packages/compiler/src/platform/ir/compiler.ts`. 27 passing tests.       |
| **Runtime variable interpolation**                            | DONE        | `interpolateMessage()` in `packages/compiler/src/platform/constructs/evaluator.ts`. Supports `${var}` and `{{var}}` syntax.     |
| **WhatsApp HSM pass-through**                                 | DONE        | `parseWhatsAppTemplate()` in `apps/runtime/src/channels/adapters/whatsapp-providers/whatsapp-transform.ts`.                     |
| **Studio Template Catalog** (browse-only)                     | DONE        | `TemplateCatalogPage.tsx` + static `template-catalog.ts` (301 lines). Gallery with category tabs, search, preview, JSON editor. |
| **Studio Template Picker Modal**                              | DONE        | `TemplatePickerModal.tsx` with 5 hardcoded sample templates. No API integration.                                                |
| **Studio Template Insert Panel**                              | DONE        | `TemplateInsertPanel.tsx` slide-over for rich content template insertion from static catalog.                                   |
| **Template Data Model** (MongoDB)                             | NOT STARTED | `message_templates` and `message_template_versions` collections do not exist.                                                   |
| **Template Repository**                                       | NOT STARTED | `packages/database/src/repos/message-template.repo.ts` does not exist.                                                          |
| **Template API Routes**                                       | NOT STARTED | `apps/runtime/src/routes/message-templates.ts` does not exist. No REST endpoints.                                               |
| **Template Resolver** (runtime service)                       | NOT STARTED | `packages/shared/src/templates/message-template-resolver.ts` does not exist. No L1 cache, no channel-format selection.          |
| **Redis Pub/Sub invalidation**                                | NOT STARTED | No cache invalidation layer.                                                                                                    |
| **Channel-to-variant mapping**                                | NOT STARTED | `channel-variant-map.ts` does not exist.                                                                                        |
| **Compiler DSL-to-library sync**                              | NOT STARTED | `syncFromDSL()` not implemented; compiler does not write to any DB.                                                             |
| **Studio Template Manager** (CRUD UI)                         | NOT STARTED | Template manager page, editor, version history, SWR hooks do not exist.                                                         |

The architecture described in this HLD remains valid for the planned BETA implementation. The compile-time layer (DSL parsing, `TEMPLATE(name)` resolution, IR generation) is complete and stable. The runtime layer (DB model, API, resolver, cache) and Studio CRUD layer are the remaining work.

---

## 1. Architecture Overview

The message-templates feature adds a project-scoped template library that bridges three existing subsystems:

1. **DSL Templates** (`TEMPLATES:` / `TEMPLATE name:`) — compile-time, author-defined
2. **Platform Prompt Templates** (`prompt_templates` collection) — environment-level, admin-managed
3. **Channel Adapters** — runtime, channel-specific message formatting

The new system introduces a **Template Repository** (MongoDB), a **Template Resolver** (runtime cache + interpolation), and a **Template API** (REST endpoints), connected by a **Cache Invalidation** layer (Redis pub/sub).

```
                    ┌──────────────────────────┐
                    │      Studio UI            │
                    │  Template Manager / Picker │
                    └─────────┬────────────────┘
                              │ REST API
                              ▼
┌──────────────┐    ┌──────────────────────────┐    ┌─────────────────────┐
│  DSL Compiler │───▶│   Template API Routes     │───▶│  Template Repository │
│  (sync on     │    │  /api/projects/:pid/      │    │  (MongoDB model)     │
│   compile)    │    │   message-templates        │    │  - CRUD + versions   │
└──────────────┘    └──────────────────────────┘    │  - tenant/project    │
                              │                      │    isolation          │
                              │ cache invalidation   └──────────┬──────────┘
                              ▼                                  │
                    ┌──────────────────────────┐                │
                    │  Redis Pub/Sub            │◀───────────────┘
                    │  template:invalidate      │     on mutation
                    └─────────┬────────────────┘
                              │ subscribe
                              ▼
                    ┌──────────────────────────┐
                    │  Template Resolver        │
                    │  (runtime service)        │
                    │  - In-memory L1 cache     │
                    │  - Channel format select  │
                    │  - Variable interpolation │
                    └─────────┬────────────────┘
                              │ uses
                              ▼
                    ┌──────────────────────────┐
                    │  renderTemplate()         │
                    │  (shared template engine) │
                    └──────────────────────────┘
```

---

## 2. Component Design

### 2.1 Template Data Model

**Collection**: `message_templates`

```typescript
interface IMessageTemplate {
  _id: string; // uuidv7
  tenantId: string; // Tenant isolation
  projectId: string; // Project scope
  name: string; // Unique within project (slug: \w+, max 64)
  content: string; // Default template content (max 64 KB)
  variants: {
    // Channel-specific format variants
    whatsapp?: string;
    slack?: string;
    msteams?: string;
    email?: string;
    voice?: string;
    [key: string]: string | undefined; // Future channel extensibility
  };
  variables: TemplateVariable[]; // Declared variable schema
  status: 'draft' | 'published';
  locale?: string; // BCP 47 locale (i18n-ready, deferred)
  source: 'api' | 'dsl'; // Origin: Studio UI/API or DSL compilation
  currentVersion: number; // Monotonically incrementing
  createdBy: string; // User ID
  updatedBy: string; // User ID
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateVariable {
  name: string; // Variable name (alphanumeric + underscore)
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  required?: boolean;
  defaultValue?: string;
  description?: string;
}
```

**Collection**: `message_template_versions`

Separate collection for version history (avoids 16 MB document limit risk with embedded versions containing large multi-variant content).

```typescript
interface IMessageTemplateVersion {
  _id: string; // uuidv7
  templateId: string; // FK to message_templates._id
  tenantId: string; // For efficient queries with tenant isolation
  projectId: string; // For efficient queries with project isolation
  version: number; // Version number
  content: string; // Snapshot of content at this version
  variants: Record<string, string>; // Snapshot of variants
  variables: TemplateVariable[]; // Snapshot of variable schema
  authorId: string; // Who made this version
  changeNote?: string; // Optional description of change
  createdAt: Date;
}
```

**Indexes**:

- `message_templates`: `{ tenantId: 1, projectId: 1, name: 1 }` (unique compound)
- `message_templates`: `{ tenantId: 1, projectId: 1 }` (list queries)
- `message_template_versions`: `{ templateId: 1, version: -1 }` (version history, newest first)
- `message_template_versions`: `{ tenantId: 1, projectId: 1, templateId: 1 }` (isolation)

### 2.2 Template Repository

**Location**: `packages/database/src/repos/message-template.repo.ts`

Follows the repository pattern established in Sprint 3 (API verticalization). Encapsulates all MongoDB operations with tenant/project isolation baked into every query.

```typescript
class MessageTemplateRepository {
  create(tenantId, projectId, data, userId): Promise<IMessageTemplate>;
  findById(tenantId, projectId, id): Promise<IMessageTemplate | null>;
  findByName(tenantId, projectId, name): Promise<IMessageTemplate | null>;
  list(tenantId, projectId, options: ListOptions): Promise<PaginatedResult>;
  update(tenantId, projectId, id, data, userId): Promise<IMessageTemplate>;
  delete(tenantId, projectId, id): Promise<boolean>;
  getVersions(tenantId, projectId, id): Promise<IMessageTemplateVersion[]>;
  rollback(tenantId, projectId, id, version, userId): Promise<IMessageTemplate>;
  bulkFindByNames(tenantId, projectId, names: string[]): Promise<IMessageTemplate[]>;
}
```

Key invariants:

- Every query includes `tenantId` and `projectId` in the filter
- `findById` uses `findOne({ _id, tenantId, projectId })`, never `findById()`
- Updates use optimistic locking via `__v` field (Mongoose version key)
- Version creation is atomic with template update (MongoDB transaction)
- Version cap enforced: delete oldest when count exceeds 50

### 2.3 Template API Routes

**Mount point**: `/api/projects/:projectId/message-templates`

```
GET    /                     List templates (paginated, searchable)
POST   /                     Create template
GET    /:templateId          Get template by ID
PUT    /:templateId          Update template
DELETE /:templateId          Delete template (soft or hard)
GET    /:templateId/versions Get version history
POST   /:templateId/rollback Rollback to specific version
```

**Middleware chain** (per route pattern in `apps/runtime/src/routes/tags.ts`):

1. `authMiddleware` — JWT verification
2. `requireProjectScope('projectId')` — project scoping
3. `tenantRateLimit('request')` — 100 req/min per tenant
4. `requireProjectPermission(req, res, 'message-templates:read|write')` — RBAC

**Request/response validation**: Zod schemas registered with OpenAPI registry.

### 2.4 Template Resolver (Runtime)

**Location**: `packages/shared/src/templates/message-template-resolver.ts`

The resolver is the runtime component that resolves `TEMPLATE(name)` references and interpolates variables. It mirrors the `PromptTemplateLoader` pattern but is project-scoped.

```typescript
class MessageTemplateResolver {
  private cache: Map<string, CachedTemplate>; // key: `${projectId}:${name}`
  private maxCacheSize: number; // 10,000 entries
  private cacheTTL: number; // 5 minutes

  async resolve(
    projectId: string,
    templateName: string,
    channelType: ChannelType,
    context: Record<string, unknown>,
    tenantId: string,
  ): Promise<ResolvedTemplate>;

  invalidate(projectId: string, templateName: string): void;
  invalidateProject(projectId: string): void;

  subscribe(): void; // Redis pub/sub subscription
}

interface ResolvedTemplate {
  content: string; // Interpolated content for the channel
  rawContent: string; // Pre-interpolation content (for debugging)
  channelVariant: string; // Which variant was selected ('default', 'whatsapp', etc.)
  warnings: string[]; // Missing variables, fallback applied, etc.
}
```

**Resolution algorithm**:

1. Check L1 cache by `${projectId}:${templateName}`
2. If miss, fetch from MongoDB via repository
3. Select channel variant: exact match on `channelType` key, then channel family (e.g., `voice_twilio` -> `voice`), then `default`
4. Interpolate with `renderTemplate(variant, context)`
5. Emit `trace_event` with resolution metadata
6. Cache result with TTL

**Cache design**:

- Max size: 10,000 entries
- TTL: 5 minutes
- Eviction: LRU (delete oldest on insertion when full)
- Invalidation: Redis pub/sub on `template:invalidate` channel

### 2.5 Channel Format Mapping

Maps `ChannelType` (from `apps/runtime/src/channels/types.ts`) to template variant keys:

```typescript
const CHANNEL_TO_VARIANT: Record<string, string> = {
  // WhatsApp family
  whatsapp: 'whatsapp',

  // Slack
  slack: 'slack',

  // Microsoft Teams
  msteams: 'msteams',

  // Email
  email: 'email',

  // Voice family
  voice: 'voice',
  voice_twilio: 'voice',
  voice_livekit: 'voice',
  vxml: 'voice',
  korevg: 'voice',
  audiocodes: 'voice',

  // Everything else falls through to 'default'
};
```

### 2.6 Compiler Integration

During DSL compilation (in `packages/compiler/src/platform/ir/compiler.ts`), the existing `compileTemplates()` function produces `Record<string, string>`. The new sync step:

1. After `compileTemplates()`, if a project context is available (deployment resolver), call `MessageTemplateRepository.syncFromDSL(tenantId, projectId, compiledTemplates, userId)`
2. `syncFromDSL` upserts templates with `source: 'dsl'`, creating versions on change
3. API-created templates (`source: 'api'`) are never overwritten by DSL sync
4. DSL templates with the same name as API templates produce a compile-time warning

### 2.7 Studio UI Components

**Template Manager Page** (`apps/studio/src/app/[locale]/projects/[projectId]/templates/page.tsx`):

- List view with search, filter by status, sort by name/updated
- Create/edit modal with content editor and variant tabs
- Variable declaration form
- Preview panel with sample context input

**Template Picker** (embedded component for agent editor):

- Autocomplete dropdown when typing `TEMPLATE(`
- Shows template name, preview, variable list
- Inserts `TEMPLATE(name)` reference into DSL

---

## 3. Twelve Architectural Concerns

### 3.1 Resource Isolation

- Every MongoDB query includes `tenantId` and `projectId` in the filter
- Repository methods require both as first parameters (cannot be forgotten)
- Cross-tenant/project access returns 404 (not 403)
- Route middleware enforces `requireProjectScope` before handler execution
- Template cache keys include `projectId` to prevent cross-project leakage

### 3.2 Authentication & Authorization

- All routes behind `authMiddleware` (JWT verification via `createUnifiedAuthMiddleware`)
- Project permission: `requireProjectPermission(req, res, 'message-templates:read')` for GET, `'message-templates:write'` for mutations
- No custom token verification
- User ID extracted from JWT for version `authorId` tracking

### 3.3 Data Consistency

- Template name uniqueness enforced by unique compound index `{ tenantId, projectId, name }`
- Version creation is atomic with template update (MongoDB transaction or `findOneAndUpdate` with `$push` to versions)
- Optimistic locking via Mongoose `__v` field prevents lost updates
- DSL sync uses upsert with `source: 'dsl'` filter to avoid overwriting API-created templates

### 3.4 Caching Strategy

- **L1**: In-memory `Map` with max size (10,000), TTL (5 min), LRU eviction
- **L2**: Redis (optional, for multi-pod consistency if needed in future)
- **Invalidation**: Redis pub/sub on `template:invalidate` channel, triggered by any mutation
- **Cold start**: On first resolve after process start, fetch from MongoDB and populate cache
- **Deployment boundary**: Cache is scoped per deployment; new deployments start cold

### 3.5 Performance

- Template resolution from L1 cache: O(1) lookup, < 1ms
- MongoDB queries use compound indexes for all access patterns
- List endpoint uses cursor-based pagination for large template sets
- Bulk resolve for multiple templates in single request (deployment-time pre-warming)
- Max content size (64 KB) prevents oversized documents

### 3.6 Error Handling

- Template resolution failures return fallback (empty string + trace warning), never crash
- Missing template reference emits `trace_event` type `template_resolution_error`
- Validation errors return `{ success: false, error: { code: 'VALIDATION_ERROR', message: '...' } }`
- Rate limit exceeded returns 429 with `Retry-After` header
- MongoDB transaction failures on version creation retry once, then fail with 500

### 3.7 Observability

- `createLogger('message-template-route')` for API route logging
- `createLogger('message-template-resolver')` for runtime resolution logging
- Trace events: `template_resolved`, `template_resolution_error`, `template_cache_miss`, `template_cache_invalidated`
- Audit events on create, update, delete, rollback (via existing audit logging infrastructure)

### 3.8 Compliance

- All mutations emit audit log events with actor, action, resource, timestamp
- Version history provides full edit trail for compliance review
- Template content stored encrypted at rest (MongoDB at-rest encryption)
- Right to erasure: template deletion cascades to version history
- Variable values are transient (not stored, only used at interpolation time)

### 3.9 Scalability

- 10,000 templates per project (bounded by index performance)
- 50 versions per template (bounded by collection query, not document size)
- Separate `message_template_versions` collection allows independent scaling
- Cache eviction prevents unbounded memory growth
- Stateless resolver instances behind load balancer

### 3.10 Backward Compatibility

- Existing DSL `TEMPLATES:` syntax unchanged
- Existing `TEMPLATE(name)` references continue to work (compile-time resolution)
- New runtime resolution is opt-in: agents using `TEMPLATE(name)` in DSL get compile-time resolution as before. Runtime resolution activates only when agents reference templates from the project library
- `PromptTemplate` model (platform-level prompts) is untouched

### 3.11 Migration

- No data migration required (new collections)
- Existing DSL templates can be imported to the library via `syncFromDSL` during next deployment
- No breaking changes to existing APIs or models

### 3.12 Testing Strategy

- See `docs/testing/message-templates.md` for full test spec
- 10 E2E scenarios, 7 integration scenarios, 5 unit scenarios
- All E2E tests use real servers with full middleware chain
- No mocking of codebase components in E2E tests

---

## 4. Data Model

### Entity Relationship

```
Tenant (1) ──── (N) Project (1) ──── (N) MessageTemplate (1) ──── (N) MessageTemplateVersion
                                              │
                                              │ referenced by
                                              ▼
                                        AgentIR.templates (compile-time)
                                        RuntimeSession.context (runtime)
```

### Access Patterns

| Pattern               | Query                                        | Index                                  |
| --------------------- | -------------------------------------------- | -------------------------------------- |
| Get by ID             | `{ _id, tenantId, projectId }`               | Default `_id` + compound               |
| Get by name           | `{ name, tenantId, projectId }`              | `{ tenantId, projectId, name }` unique |
| List for project      | `{ tenantId, projectId }`                    | `{ tenantId, projectId }`              |
| Search by name        | `{ tenantId, projectId, name: { $regex } }`  | `{ tenantId, projectId, name }`        |
| Versions for template | `{ templateId }` sorted by `{ version: -1 }` | `{ templateId, version: -1 }`          |
| Bulk by names         | `{ tenantId, projectId, name: { $in } }`     | `{ tenantId, projectId, name }`        |

---

## 5. API Design

### POST /api/projects/:projectId/message-templates

**Request**:

```json
{
  "name": "greeting",
  "content": "Hello {{customerName}}, welcome to {{companyName}}!",
  "variants": {
    "whatsapp": "Hello *{{customerName}}*! Welcome to {{companyName}}.",
    "voice": "Hello {{customerName}}, welcome to {{companyName}}."
  },
  "variables": [
    { "name": "customerName", "type": "string", "required": true },
    { "name": "companyName", "type": "string", "defaultValue": "our service" }
  ],
  "status": "draft"
}
```

**Response** (201):

```json
{
  "success": true,
  "data": {
    "_id": "01JK...",
    "name": "greeting",
    "content": "Hello {{customerName}}, welcome to {{companyName}}!",
    "variants": {
      "whatsapp": "Hello *{{customerName}}*! Welcome to {{companyName}}.",
      "voice": "Hello {{customerName}}, welcome to {{companyName}}."
    },
    "variables": [...],
    "status": "draft",
    "source": "api",
    "currentVersion": 1,
    "createdBy": "user-123",
    "createdAt": "2026-03-23T10:00:00Z",
    "updatedAt": "2026-03-23T10:00:00Z"
  }
}
```

### PUT /api/projects/:projectId/message-templates/:templateId

**Request**: Same shape as POST (partial updates allowed).

**Response** (200): Same shape. `currentVersion` incremented. New version record created.

**Conflict** (409): Returned when optimistic lock fails (concurrent edit).

### POST /api/projects/:projectId/message-templates/:templateId/rollback

**Request**:

```json
{
  "version": 3
}
```

**Response** (200): Template with content from version 3, `currentVersion` incremented.

---

## 6. Alternatives Considered

### Alternative A: Extend Existing PromptTemplate Model

**Proposal**: Add `tenantId`, `projectId`, and `variants` fields to the existing `prompt_templates` collection.

**Rejected because**:

- `PromptTemplate` is platform-level (no tenant/project scope). Adding multi-tenancy would break the existing seeder and loader pattern
- The `PromptTemplate` model serves a fundamentally different purpose (system prompts, tool schemas) with different access patterns
- Mixing concerns would create confusing semantics: is a "message" category prompt template the same as a message template?

### Alternative B: Store Templates in Agent DSL Only (No DB)

**Proposal**: Keep templates DSL-only. No API, no DB, no Studio UI.

**Rejected because**:

- Content editors cannot modify DSL
- Template reuse across agents requires copy-paste
- No versioning, no audit trail
- Contradicts the platform's trend toward visual-first authoring in Studio

### Alternative C: Embed Versions in Template Document

**Proposal**: Store version history as an embedded array within the template document.

**Rejected because**:

- 50 versions x 7 variants x 64 KB = potential 22 MB exceeding MongoDB's 16 MB document limit
- Separate collection allows independent indexing and more efficient version queries
- Pagination of version history is cleaner with a separate collection

---

## 7. Security Considerations

- **Variable injection**: Template content is author-defined (trusted). Variable values come from session context (potentially user-influenced). The `renderTemplate()` function does string substitution only (no code execution). HTML/script content in variables is the caller's responsibility to sanitize for the target channel
- **Template content as prompt injection vector**: Templates used in LLM system prompts could be manipulated. Mitigation: templates intended for user-facing messages (this feature) are distinct from system prompt templates (`PromptTemplate` model). The resolver does not inject templates into system prompts
- **Rate limiting**: 100 req/min per tenant on mutation endpoints prevents abuse
- **Size limits**: 64 KB max per variant, 10 variants max, prevents storage abuse
