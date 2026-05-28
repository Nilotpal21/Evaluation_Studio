# Feature Spec: Message Templates

**Status**: ALPHA
**Created**: 2026-03-23
**Last Updated**: 2026-03-26
**Feature Slug**: `message-templates`

---

## Current Implementation Status

_Last audited: 2026-03-26_

### Implemented (ALPHA)

| Component                          | Location                                                                                                  | Description                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| DSL `TEMPLATES:` blocks            | `packages/core/src/parser/agent-based-parser.ts`                                                          | Parser support for `TEMPLATES:` block and standalone `TEMPLATE name:` syntax with multi-format variants                                         |
| `TEMPLATE(name)` compile-time refs | `packages/compiler/src/platform/ir/compiler.ts` (`compileTemplates`, `resolveAllTemplateRefs`)            | Compile-time inlining of `TEMPLATE(name)` references into respond, messages, gather prompts, and rich_content fields                            |
| `interpolateMessage()` runtime     | `packages/compiler/src/platform/constructs/evaluator.ts` (line 1113)                                      | Runtime variable interpolation with `${var}` and `{{var}}` syntax against evaluation context                                                    |
| WhatsApp HSM template pass-through | `apps/runtime/src/channels/adapters/whatsapp-providers/whatsapp-transform.ts`                             | `parseWhatsAppTemplate()` converts `richContent.whatsapp` into WhatsApp message template payloads                                               |
| Studio Template Catalog (browse)   | `apps/studio/src/components/templates/TemplateCatalogPage.tsx`, `apps/studio/src/lib/template-catalog.ts` | Static gallery page for browsing rich content templates with category tabs, search, preview, JSON editor, DSL view                              |
| Studio Template Insert Panel       | `apps/studio/src/components/templates/TemplateInsertPanel.tsx`                                            | Slide-over panel for browsing and inserting rich content templates from the static catalog                                                      |
| Studio Template Picker Modal       | `apps/studio/src/components/abl/pickers/TemplatePickerModal.tsx`                                          | Picker modal with 5 hardcoded sample message templates (greeting_formal, greeting_casual, escalation_handoff, error_fallback, session_timeout)  |
| Compiler test suite                | `packages/compiler/src/__tests__/template-resolution.test.ts`                                             | 27 test cases (644 lines) covering compile-time `TEMPLATE(name)` resolution across flow steps, reasoning agents, scripted agents, gather fields |

### Not Implemented (PLANNED for BETA)

| Component                                 | Planned Location (per HLD/LLD)                                         | Description                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| MongoDB `message_templates` model         | `packages/database/src/models/message-template.model.ts`               | Project-scoped data model with tenant isolation, versioning, channel variants, variable schema        |
| MongoDB `message_template_versions` model | `packages/database/src/models/message-template-version.model.ts`       | Separate collection for immutable version history                                                     |
| Message Template Repository               | `packages/database/src/repos/message-template.repo.ts`                 | Repository class with CRUD, version management, optimistic locking, DSL sync                          |
| Zod validation schemas                    | `packages/database/src/schemas/message-template.schema.ts`             | Request validation for create, update, rollback, list operations                                      |
| REST API routes                           | `apps/runtime/src/routes/message-templates.ts`                         | 7 endpoints under `/api/projects/:projectId/message-templates` with auth, isolation, rate limiting    |
| Runtime MessageTemplateResolver service   | `packages/shared/src/templates/message-template-resolver.ts`           | Runtime template resolution with in-memory L1 cache, channel-format selection, variable interpolation |
| Redis cache invalidation                  | `packages/shared/src/templates/template-cache-invalidation.ts`         | Redis pub/sub for cross-pod cache invalidation on template mutations                                  |
| Channel-to-variant mapping                | `packages/shared/src/templates/channel-variant-map.ts`                 | Maps `ChannelType` to template variant keys with channel family fallback                              |
| DSL-to-library sync                       | Wiring in `packages/compiler/src/platform/ir/compiler.ts`              | `syncFromDSL()` to upsert DSL templates into project library during deployment                        |
| Studio Template Manager CRUD UI           | `apps/studio/src/app/[locale]/projects/[projectId]/templates/page.tsx` | List, create, edit, delete templates with search, filter, pagination                                  |
| Studio Template Editor                    | `apps/studio/src/components/templates/TemplateEditor.tsx`              | Content editor with variant tabs, variable declaration, preview panel                                 |
| Studio Version History                    | `apps/studio/src/components/templates/TemplateVersionHistory.tsx`      | Version list, side-by-side comparison, rollback                                                       |
| SWR hooks                                 | `apps/studio/src/hooks/useMessageTemplates.ts`                         | Data-fetching hooks for template list, single template, versions, mutations                           |
| Project-scoped template library           | —                                                                      | End-to-end flow: API-managed templates referenced at runtime across agents within a project           |

---

## 1. Problem Statement

The ABL platform has two distinct but related "template" concepts that are partially implemented and poorly integrated:

1. **Agent Response Templates** (DSL `TEMPLATES:` / `TEMPLATE name:` blocks) — Named, reusable response fragments defined in DSL that get compiled into IR (`templates?: Record<string, string>`) and resolved at compile-time via `TEMPLATE(name)` references. These support multi-format variants (Markdown, Adaptive Card, WhatsApp, Slack, AG-UI, HTML) and `{{variable}}` interpolation. **Current state**: Parser, compiler, and template-ref resolution are implemented in `packages/core` and `packages/compiler`. However, there is no runtime-level template resolution, no Studio UI for managing templates, no versioning, no project-level template library, and no API for CRUD operations on templates.

2. **Platform Prompt Templates** (MongoDB `prompt_templates` collection) — Environment-level prompt templates for system prompts, tool schemas, tool descriptions, default messages, escalation formats, and LLM task prompts. Loaded via `PromptTemplateLoader`, cached in memory, falling back to `PromptCatalog` hardcoded defaults. **Current state**: DB model, loader, seeder, and catalog are implemented. However, these are platform-wide (not tenant/project-scoped), have no RBAC, no versioning/history, no Studio UI, and no A/B testing capability.

Neither system supports:

- **Tenant- or project-scoped message templates** — reusable message fragments that teams can manage, version, and share across agents within a project
- **Channel-adaptive template resolution** — selecting the right format variant (WhatsApp template, Slack Block Kit, Adaptive Card, plain text) at runtime based on the active channel
- **Runtime template interpolation** — resolving `{{variable}}` placeholders against session context at message-send time, not just at compile time
- **Template lifecycle management** — create, edit, version, deprecate, archive with audit trail
- **i18n-aware templates** — locale-keyed variants per the i18n design (`docs/archive/plans-2026-02/2026-02-21-i18n-end-to-end-design.md`)

### Business Impact

- **Agent developers** must duplicate response text across multiple agents when the same message is needed (e.g., greeting, error, disclaimer, compliance text)
- **Content teams** cannot update messages without modifying DSL source and redeploying
- **Channel expansion** (Telegram, SMS, Line per the gap analysis) requires per-channel message formatting that is currently ad-hoc in each adapter
- **Compliance teams** need auditable, versioned message templates for regulated industries

---

## 2. Scope

### In Scope

| Area                                  | Description                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project-scoped template CRUD API**  | REST endpoints under `/api/projects/:projectId/message-templates` for create, read, update, delete, list, version history                               |
| **Template data model**               | MongoDB model with tenant/project isolation, versioning, channel variants, locale variants, variable schema                                             |
| **Compiler integration**              | Bridge between DSL `TEMPLATES:` block and the project-level template library — import/export, reference resolution                                      |
| **Runtime template resolver**         | Resolve `TEMPLATE(name)` references at runtime against the template library with channel-aware format selection and variable interpolation              |
| **Studio UI — Template Manager**      | List, create, edit, preview, version-compare templates within a project                                                                                 |
| **Studio UI — Template Picker**       | Inline template selection in agent editor (DSL and visual)                                                                                              |
| **Channel-format resolution**         | At runtime, select the appropriate format variant (plain text, markdown, WhatsApp interactive, Slack blocks, Adaptive Card) based on the active channel |
| **Variable interpolation at runtime** | Resolve `{{variable}}` against session context (context vars, gather fields, system vars) at message delivery time                                      |

### Out of Scope

| Area                                          | Rationale                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cross-project template sharing**            | Requires org-level library; defer to future "Template Marketplace" feature                                                                                                                     |
| **Full i18n locale variants**                 | Depends on i18n infrastructure (PLANNED, not yet implemented). Template model will include `locale` field but locale negotiation is deferred                                                   |
| **WhatsApp HSM registration**                 | WhatsApp requires pre-approved message templates registered with Meta. The registration workflow is channel-provider specific and out of scope. We support referencing approved template names |
| **A/B testing of templates**                  | Requires experiment framework; defer to analytics pipeline feature                                                                                                                             |
| **Platform-level prompt template management** | The existing `PromptTemplate` model for system prompts/tool schemas is a separate concern. Future work may unify the admin UI                                                                  |
| **Template approval workflows**               | Multi-step approval chains for regulated content; defer to compliance feature                                                                                                                  |

---

## 3. User Stories

### US-1: Agent Developer Creates Reusable Templates

**As an** agent developer
**I want to** define named message templates in a project-level library
**So that** I can reuse the same message across multiple agents without duplication

**Acceptance Criteria:**

- Can create a template with a name, default content, and optional channel-specific variants
- Can define variable placeholders (`{{customerName}}`, `{{orderId}}`) with type hints
- Template name must be unique within the project
- Can reference the template from DSL via `TEMPLATE(name)` syntax
- Template changes propagate to all agents referencing it on next deployment

### US-2: Content Editor Updates Templates Without DSL Changes

**As a** content editor (non-developer)
**I want to** update message text in the Studio template manager
**So that** I can fix copy, update legal disclaimers, or change greetings without touching agent DSL

**Acceptance Criteria:**

- Studio UI provides a rich text editor for template content
- Can preview the template with sample variable values
- Changes create a new version (immutable version history)
- Can compare versions side-by-side
- Published vs. draft status prevents accidental deployment of work-in-progress

### US-3: Runtime Resolves Templates Per Channel

**As the** runtime system
**I want to** select the correct template format variant based on the active channel
**So that** WhatsApp users see interactive buttons, Slack users see Block Kit, and web users see Markdown

**Acceptance Criteria:**

- Template defines variants: `default`, `whatsapp`, `slack`, `msteams`, `email`, `voice`
- Runtime selects the most specific variant matching the channel, falling back to `default`
- Variable interpolation uses session context at message-send time
- Missing variables produce a warning trace event, not a crash

### US-4: Runtime Interpolates Variables at Send Time

**As the** runtime system
**I want to** resolve `{{variable}}` placeholders against session context when sending a message
**So that** templates produce personalized responses

**Acceptance Criteria:**

- Supports context variables (`context.customerName`), gather fields (`gather.email`), system variables (`system.timestamp`, `system.sessionId`)
- Nested paths (`{{customer.address.city}}`) are supported
- Undefined variables are replaced with empty string and a trace warning is emitted
- The existing `renderTemplate()` engine from `packages/shared/src/prompts/template-engine.ts` is reused

### US-5: Developer Imports/Exports Templates via DSL

**As an** agent developer
**I want to** define templates in DSL and have them sync to the project template library
**So that** I can version-control templates alongside agent definitions

**Acceptance Criteria:**

- `TEMPLATES:` block in DSL creates/updates entries in the project template library on compile
- `TEMPLATE name:` standalone syntax also syncs
- Export produces DSL-compatible format
- Conflict resolution: DSL is the source of truth; API-created templates are additive

### US-6: Template Version History and Rollback

**As a** project administrator
**I want to** view the version history of a template and roll back to a previous version
**So that** I can recover from bad edits

**Acceptance Criteria:**

- Every update creates an immutable version record
- Version list shows author, timestamp, diff summary
- Rollback creates a new version (copy of the selected historical version)
- Minimum 50 versions retained per template

---

## 4. Requirements

### Functional Requirements

| ID    | Requirement                                                                         | Priority | User Story |
| ----- | ----------------------------------------------------------------------------------- | -------- | ---------- |
| FR-1  | CRUD API for project-scoped message templates with tenant isolation                 | P0       | US-1       |
| FR-2  | Template data model with name, content, channel variants, variable schema, versions | P0       | US-1, US-2 |
| FR-3  | Template name uniqueness within project scope                                       | P0       | US-1       |
| FR-4  | Immutable version history with author and timestamp                                 | P0       | US-6       |
| FR-5  | Runtime template resolution with channel-aware format selection                     | P0       | US-3       |
| FR-6  | Runtime variable interpolation against session context                              | P0       | US-4       |
| FR-7  | DSL `TEMPLATE(name)` reference resolution against project template library          | P1       | US-5       |
| FR-8  | Studio UI: Template list with search and filter                                     | P1       | US-2       |
| FR-9  | Studio UI: Template editor with preview                                             | P1       | US-2       |
| FR-10 | Studio UI: Version comparison view                                                  | P2       | US-6       |
| FR-11 | Studio UI: Template picker for agent editor                                         | P2       | US-1       |
| FR-12 | Template export to DSL format                                                       | P2       | US-5       |
| FR-13 | Draft/published status for templates                                                | P2       | US-2       |
| FR-14 | Locale field on templates (i18n-ready, resolution deferred)                         | P2       | —          |

### Non-Functional Requirements

| ID    | Requirement                                                  | Target    |
| ----- | ------------------------------------------------------------ | --------- |
| NFR-1 | Template resolution latency < 5ms (cached)                   | P95 < 5ms |
| NFR-2 | Template library supports up to 10,000 templates per project | —         |
| NFR-3 | Version history query < 100ms for 50 versions                | —         |
| NFR-4 | Template content max size: 64 KB per variant                 | —         |
| NFR-5 | All template mutations emit audit log events                 | —         |
| NFR-6 | Template API rate limit: 100 req/min per tenant              | —         |

---

## 5. Decision Log

| Decision                      | Choice                                                                          | Classification | Rationale                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Template scope                | Project-level (not tenant or org)                                               | DECIDED        | Matches existing resource isolation pattern where all operational resources are project-scoped. Cross-project sharing is a future enhancement |
| Storage                       | MongoDB with separate `message_template_versions` collection (revised in HLD)   | DECIDED        | Originally planned as embedded subdocuments, revised to separate collection in HLD to avoid 16 MB document limit with multi-variant templates |
| Version limit                 | 50 versions per template, LRU eviction                                          | DECIDED        | Balances storage with audit needs. Most templates will have < 20 versions                                                                     |
| Runtime resolution            | In-memory cache per deployment with Redis L2                                    | DECIDED        | Matches `PromptTemplateLoader` pattern. Templates are deployment-scoped, so cache invalidation aligns with deployment lifecycle               |
| Channel format selection      | Discriminated union matching `ChannelType` → format key                         | DECIDED        | Reuses existing `ChannelType` union from `apps/runtime/src/channels/types.ts`. Format keys map to `RichContentIR` fields                      |
| Variable interpolation engine | Reuse `renderTemplate()` from `packages/shared/src/prompts/template-engine.ts`  | DECIDED        | Already supports `{{variable}}`, `{{#if}}`, `{{#each}}`. No need for a second engine                                                          |
| DSL integration               | Compile-time sync from DSL to template library; runtime resolution from library | INFERRED       | DSL `TEMPLATES:` block already compiles to `Record<string, string>`. Adding library sync is additive, not breaking                            |
| Template identifier           | Slug-based name (alphanumeric + underscore, max 64 chars)                       | DECIDED        | Consistent with DSL `TEMPLATE name:` syntax which uses `\w+` pattern                                                                          |

---

## 6. Risks and Mitigations

| Risk                                                    | Impact                                                           | Likelihood | Mitigation                                                                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache staleness after template update                   | Users see old template content                                   | Medium     | Redis pub/sub invalidation on template mutation + deployment-scoped cache reset                                                                                        |
| Variable injection attacks                              | XSS or prompt injection via template variables                   | High       | Sanitize all variable values at interpolation time. Template content is trusted (author-defined), variables are user-supplied                                          |
| Template naming collisions between DSL and API          | Confusing behavior when same name exists in both DSL and library | Medium     | DSL is authoritative at compile time. API-created templates that conflict with DSL names get a warning. Clear precedence documented                                    |
| Performance regression from runtime template resolution | Adds latency to every response                                   | Low        | In-memory cache makes resolution O(1). Fallback to inline content if cache miss                                                                                        |
| Template version storage bloat                          | MongoDB document size limit (16 MB)                              | Low        | 50-version cap, content max 64 KB. Worst case: 50 _ 64 KB _ 7 variants = 22 MB > 16 MB. Mitigation: store versions in separate collection if variants exceed threshold |

---

## 7. Success Metrics

| Metric                             | Target                             | Measurement                                                             |
| ---------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Template reuse rate                | > 3 agents per template on average | Count of `TEMPLATE(name)` references across agents / count of templates |
| Content update cycle time          | < 5 minutes from edit to live      | Time from Studio save to runtime resolution of new version              |
| Template resolution cache hit rate | > 99%                              | Cache hit / total resolution attempts                                   |
| API error rate                     | < 0.1%                             | 5xx responses / total template API requests                             |

---

## 8. Related Features

| Related Feature                                                          | Relationship    | Integration Point                                                                                                                 |
| ------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [SDK Rich Content Templates](sub-features/sdk-rich-content-templates.md) | shares data     | Message template channel variants can include `richContent` fields (KPI, table, chart, etc.) rendered by the SDK TemplateRegistry |
| [SDK Chat UI Consolidation](sub-features/sdk-chat-ui-consolidation.md)   | consumed by     | Resolved template content flows through the shared MessageList component                                                          |
| [Channels](channels.md)                                                  | consumed by     | Channel adapters select the format variant (WhatsApp HSM, Slack Block Kit, plain text) at send time                               |
| [ABL Language](abl-language.md)                                          | extends         | DSL `TEMPLATES:` block and `TEMPLATE(name)` compile-time resolution already implemented in compiler                               |
| [i18n](../archive/plans-2026-02/2026-02-21-i18n-end-to-end-design.md)    | integrates with | Locale-keyed template variants per the i18n design                                                                                |
