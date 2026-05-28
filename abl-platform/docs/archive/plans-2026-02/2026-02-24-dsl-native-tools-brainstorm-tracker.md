# DSL-Native Tools — Brainstorm Phase Tracker

**Date**: 2026-02-24
**Status**: Complete — All 15 phases brainstormed
**Companion docs**:

- `2026-02-24-dsl-native-tools-design.md` (full design)
- `2026-02-24-dsl-native-tools-decisions.md` (decisions, requirements, constraints)
- `2026-02-23-dsl-native-tools-deep-analysis.md` (exploration)

---

## Progress Legend

| Symbol | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| ✅     | Brainstormed — design decisions captured in docs              |
| 🔄     | Partially brainstormed — some aspects need deeper exploration |
| ⬜     | Not started — needs full brainstorming session                |

---

## Phase Overview

| #   | Phase                                     | Status | Design Doc Section              |
| --- | ----------------------------------------- | ------ | ------------------------------- |
| 1   | Schema & Data Model                       | ✅     | §3                              |
| 2   | DSL Syntax & Parser                       | ✅     | §4, §14.2                       |
| 3   | Tool Creation & Validation                | ✅     | §5                              |
| 4   | Tool Linking & Agent DSL Integration      | ✅     | §6                              |
| 5   | Compilation Pipeline                      | ✅     | §7, §8, §14.3                   |
| 6   | Agent Version Snapshots & Stale Detection | ✅     | §10                             |
| 7   | Tool Library UI/UX                        | ✅     | §9                              |
| 8   | Tool Maintenance (Update/Delete/Rename)   | ✅     | §11                             |
| 9   | API Design (CRUD Routes)                  | ✅     | §5.5                            |
| 10  | Security & Secrets                        | ✅     | §5.3, §11.4, §14                |
| 11  | AI/Arch Integration                       | ✅     | §12                             |
| 12  | Migration Strategy                        | ⛔ N/A | §15                             |
| 13  | Testing Strategy                          | ✅     | §17                             |
| 14  | Observability & Audit                     | ✅     | §16 (testing includes), D73-D79 |
| 15  | Performance & Scaling                     | ✅     | D80-D86, R15, C10               |

---

## Phase 1: Schema & Data Model ✅

**What it covers**: MongoDB `project_tools` collection, field definitions, indexes, constraints.

| Aspect                 | Status | Notes                                                                         |
| ---------------------- | ------ | ----------------------------------------------------------------------------- |
| Collection design      | ✅     | `IProjectTool` interface defined — §3                                         |
| Field definitions      | ✅     | All fields documented with types, constraints, rationale                      |
| Indexes                | ✅     | `(tenantId, projectId, name)` unique, `(tenantId, projectId)` compound        |
| Tenant isolation       | ✅     | Every query includes `tenantId` — C1.2                                        |
| Project scoping        | ✅     | Every query includes `projectId` — C1.3                                       |
| Optimistic concurrency | ✅     | `_v` field for concurrent edit protection — C2.4                              |
| Denormalized fields    | ✅     | `toolType`, `description` extracted from dslContent                           |
| Slug strategy          | ✅     | Auto-generated, immutable, kept for future use — D9                           |
| Name uniqueness        | ✅     | Per `(tenantId, projectId)` — C2.1, C5.3                                      |
| One tool per document  | ✅     | Decision D1, Constraint C5.1                                                  |
| Storage format         | ✅     | DSL string (`dslContent`) with `sourceHash` — D4                              |
| What was removed       | ✅     | `source`, `isPublished`, `version`, `toolNames[]`, `toolCount`, `toolTypes[]` |
| Scaling considerations | ⬜     | Max tools per project? Document size limits? Index performance at scale?      |
| Data retention         | ⬜     | Archival policy? Soft delete vs hard delete?                                  |
| Backup/restore         | ⬜     | How does project_tools fit into backup strategy?                              |

**Gaps to brainstorm**:

- Max tools per project limit (100? 500? unlimited?)
- Soft delete vs hard delete (for audit trail)
- Document size limits for sandbox `code` (256KB limit set, but is that per-tool or per-code-field?)

---

## Phase 2: DSL Syntax & Parser ✅

**What it covers**: Agent DSL tool signature syntax, parser changes, error codes, forbidden properties.

| Aspect                 | Status | Notes                                                                        |
| ---------------------- | ------ | ---------------------------------------------------------------------------- | ------- | -------------------- |
| Signature syntax       | ✅     | `tool_name(params) -> returns` + properties — §4                             |
| Per-type DSL fields    | ✅     | HTTP, Sandbox, MCP field reference tables — §4.2-4.4                         |
| Forbidden properties   | ✅     | Implementation properties rejected with E720 — C3.1, §14.2                   |
| Tool type requirement  | ✅     | `type: http                                                                  | sandbox | mcp` required — C3.2 |
| USE TOOL removal       | ✅     | Removed entirely — C3.3                                                      |
| FROM...USE removal     | ✅     | Removed entirely — C3.4                                                      |
| Error codes            | ✅     | E720 (implementation in DSL), E721 (tool not found), E722 (server not found) |
| Parser backward compat | ✅     | None — clean break — C8                                                      |
| Edge cases             | ⬜     | Duplicate tool names in same agent? Tool name conflicts with system tools?   |
| Parser performance     | ⬜     | Impact of rejecting properties on parse time?                                |

**Gaps to brainstorm**:

- What happens if agent DSL declares same tool name twice?
- What if tool name conflicts with system tools (handoff, delegate, escalate, complete)?
- Parser error messages — are they actionable enough?

---

## Phase 3: Tool Creation & Validation ✅

**What it covers**: How tools are created, the 5-phase validation gate, per-type form design, creation flows, backend architecture.

| Aspect                              | Status | Notes                                                                                                        |
| ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Three creation paths                | ✅     | Forms, MCP Discovery, AI/Arch — §5.1                                                                         |
| 5-phase validation                  | ✅     | Parse → structural → type-specific → security → trial compile (strictest — includes MCP server check) — §5.2 |
| Error codes                         | ✅     | E730-E760 defined, auth errors (E735/E736) restored — §5.3                                                   |
| Per-type required fields            | ✅     | HTTP (with full auth/auth_config model), Sandbox, MCP field requirements — §4                                |
| Form → DSL serialization            | ✅     | Server-side: studio sends form data, server serializes via `serializeToolFormToDsl()` — D16                  |
| Type picker UX                      | ✅     | Dialog with name input + type radio selector — D20                                                           |
| Per-type wizard forms               | ✅     | Stepped wizard: HTTP (5 steps incl. auth), Sandbox (4 steps), MCP (3 steps) — D21                            |
| HTTP auth model                     | ✅     | Full auth model restored — `auth` enum + `auth_config` block for OAuth2 flows — D13                          |
| MCP server order                    | ✅     | Server must exist before MCP tool creation — strict order                                                    |
| Sandbox code handling               | ✅     | Inline string in form data, 256KB limit                                                                      |
| Backend architecture                | ✅     | Three layers: Repository + Validator + Service in `packages/shared/` — D15                                   |
| Mongoose schema                     | ✅     | Structural validation in Mongoose, business validation in Validator                                          |
| API routes                          | ✅     | 5 routes (delete endpoint doubles as impact check), studio-only — D14, R1.6                                  |
| Create/Update flow                  | ✅     | Form data → validate → serialize → save → return full document                                               |
| Full replace on update              | ✅     | All fields every time, no partial updates — D17                                                              |
| No concurrency protection           | ✅     | Last write wins — D18                                                                                        |
| Hard delete                         | ✅     | Single endpoint: `DELETE` without force → impact list, with `?force=true` → hard delete — D19                |
| Validation error format             | ✅     | All errors collected, returned at once — R2.7                                                                |
| No auto-update on rename            | ✅     | Rename is normal update, agents get E721 — D22                                                               |
| **Form UX: detailed field layouts** | ⬜     | Exact field layout, validation feedback per field, interactions (Phase 7)                                    |
| **MCP server discovery flow**       | ⬜     | Server discovery → tool selection → auto-populate (Phase 7)                                                  |
| **DSL preview panel behavior**      | ⬜     | Collapsible? Syntax highlighted? Auto-scroll? (Phase 7)                                                      |
| **Error recovery UX**               | ⬜     | Save fails → form state? Fix and retry? (Phase 7)                                                            |
| Scaling                             | ⬜     | Validation pipeline latency, trial compile timeout                                                           |
| Security                            | 🔄     | Secret detection defined, false positive handling TBD                                                        |

**Remaining UI/UX details deferred to Phase 7 (Tool Library UI/UX).**

---

## Phase 4: Tool Linking & Agent DSL Integration ✅

**What it covers**: How tools get linked to agents, the library picker, inline create, DSL insertion.

| Aspect                     | Status | Notes                                                                                                            |
| -------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| Three linking paths        | ✅     | Inline combobox picker, manual typing, AI generation — §6.1                                                      |
| Library picker UX          | ✅     | Inline combobox (tag-picker style), multi-select, shows name + type + description + linked state — D23, D24, D25 |
| No "Create Tool" in picker | ✅     | Not required — user creates tools from library page before linking                                               |
| Agent editor tools section | ✅     | Compact pill-style tags (name + type badge), stale indicator — D26, §6.3                                         |
| Pill actions               | ✅     | Click → tool detail page (view), × → confirmation dialog — D27                                                   |
| Signature insertion        | ✅     | Appended to end of TOOLS section, auto-creates TOOLS section if missing — D28                                    |
| Manual typing flow         | ✅     | Lint on save/blur (not real-time), problems panel, "Create Tool" pre-fills from signature — D30                  |
| Unlink UX                  | ✅     | Visual: confirmation dialog. Raw DSL: manual delete is valid — D27, §6.4                                         |
| Stale signature handling   | ✅     | Stale badge + "Update Signature" button, in-place replacement — D29                                              |
| Multi-agent files          | ✅     | Not relevant for v1 — each agent edited separately                                                               |
| Type-agnostic linking      | ✅     | All tool types linked the same way — §6.2                                                                        |
| Max tools per agent        | ✅     | 100 limit — D31, C3.5                                                                                            |
| No duplicate names         | ✅     | Parser rejects duplicates — D32, C3.6                                                                            |
| Security                   | ✅     | Same project = same permissions. No cross-project linking.                                                       |
| Scaling                    | ⬜     | Project with 200 tools — combobox performance? Virtualized list? (Phase 15)                                      |

---

## Phase 5: Compilation Pipeline ✅

**What it covers**: `resolveToolImplementations()`, `compileTools()`, IR generation, error handling.

| Aspect                      | Status | Notes                                                                                                                                |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Resolution function         | ✅     | `resolveToolImplementations()` in `packages/shared/` — D33                                                                           |
| Caller-resolves pattern     | ✅     | Compiler is pure, no DB access — D34, C4.6                                                                                           |
| Per-type compilation        | ✅     | HTTP → `HttpBindingIR`, Sandbox → `SandboxBindingIR`, MCP → `McpBindingIR` — §7.2                                                    |
| CompilerOptions change      | ✅     | `resolvedToolLinks` → `resolvedToolImplementations` + `compilationMode` + `staleSignatureThreshold` + `compilationTimeoutMs` — §7.11 |
| Error codes                 | ✅     | E720-E727, W721, W726 — §7.8                                                                                                         |
| IR format unchanged         | ✅     | `ToolDefinition` output identical — C4.5                                                                                             |
| Batch resolution            | ✅     | Single `$in` query — C4.3                                                                                                            |
| project_tools authoritative | ✅     | C4.4                                                                                                                                 |
| Compilation flow end-to-end | ✅     | Full flow documented: parse → resolve (with cache) → compile (parallel) → merge → IR — §7.1-7.5                                      |
| Error aggregation           | ✅     | Collect all errors (E721, E722, E725), return at once, fail compilation — D35, C4.7                                                  |
| Warning aggregation         | ✅     | W721 non-blocking by default, configurable threshold promotes to E726 — D36, §7.7                                                    |
| Partial compilation         | ✅     | Strict mode (deploy) fails entirely. Preview mode (studio) compiles what resolves — D37, §7.6                                        |
| Compilation caching         | ✅     | Redis cache by `sourceHash`. MGET/MSET batch. 24h TTL. Content-addressed, no explicit invalidation — D38, §7.10                      |
| Concurrent compilation      | ✅     | No protection needed — stateless, idempotent, last write wins — D39, §7.13                                                           |
| MCP server resolution       | ✅     | Batch-load `mcp_server_configs`, bake full config into `McpBindingIR` — D40                                                          |
| Sandbox compilation         | ✅     | Code inline in IR, W726 warning if >64KB, compression at storage layer — D41                                                         |
| W721 staleness detection    | ✅     | Field-by-field comparison (params, returns, description) — D42                                                                       |
| Compilation timeout         | ✅     | 30s default, configurable, E727 on timeout — D43, §7.9                                                                               |
| Parallel compilation        | ✅     | `Promise.all` for tool parsing + binding compilation — D44, C4.9                                                                     |
| Observability               | ⬜     | Deferred to Phase 14                                                                                                                 |

---

## Phase 6: Agent Version Snapshots & Stale Detection ✅

**What it covers**: Tool state capture at agent version creation, stale detection, version diff.

| Aspect                       | Status | Notes                                                          |
| ---------------------------- | ------ | -------------------------------------------------------------- |
| Snapshot structure           | ✅     | `ToolSnapshotEntry` with full state — §10.2                    |
| Snapshot creation flow       | ✅     | Auto-capture from same DB read as compilation — §10.3          |
| Stale detection logic        | ✅     | Compare against active version's snapshot — §10.4              |
| Version diff                 | ✅     | Added/removed/changed/renamed detection — §10.5                |
| Read-only display            | ✅     | Lazy-loaded, expandable DSL preview — §10.6                    |
| No publishing concept        | ✅     | Tools always mutable working copies — D5, C9.1                 |
| No tool-level versioning     | ✅     | Agent versions are the version history — D5                    |
| Gap analysis                 | ✅     | 12 gaps identified and resolved — §10.7, Part E                |
| Race condition prevention    | ✅     | Single DB read for compile + snapshot — C9.4, G3               |
| Security analysis            | ✅     | No permission gap — G9                                         |
| **Stale banner UX**          | ⬜     | Banner design, dismiss behavior, "update signatures" action    |
| **Version history UX**       | ⬜     | Tool snapshot display in version detail, diff viewer for tools |
| **Snapshot size monitoring** | ⬜     | Alert if snapshots grow beyond expected size?                  |

**Gaps to brainstorm**:

- Stale banner UX details (placement, actions, dismissibility)
- Version history tool snapshot display
- Tool diff viewer between versions

---

## Phase 7: Tool Library UI/UX ✅

**What it covers**: The project-level tool library page — listing, searching, filtering, navigation.

| Aspect              | Status | Notes                                                                         |
| ------------------- | ------ | ----------------------------------------------------------------------------- |
| Library page layout | ✅     | List view only (one tool per row) — D45, §9.1                                 |
| Tool row design     | ✅     | Name + type badge + description + "Updated Xh ago" + "Used by N agents" — D45 |
| Search              | ✅     | Server-side, name + description — D49                                         |
| Filtering           | ✅     | Type filter only (All / HTTP / Sandbox / MCP), server-side — D49              |
| Sorting             | ✅     | Last modified (default), sortable by name — §9.1                              |
| Pagination          | ✅     | No pagination for v1 — load all, rely on search/filter                        |
| Empty state         | ✅     | Illustration + "No tools yet. Create your first tool." + [+ New Tool] — §9.2  |
| Bulk actions        | ✅     | No bulk actions for v1                                                        |
| Navigation          | ✅     | Click tool → detail page (`/tools/:id`) with read-only view — D46             |
| "New Tool" button   | ✅     | Opens type picker dialog (already defined in Phase 3) — §9.3                  |
| Tool detail page    | ✅     | Read-only view with [Edit] button for inline edit mode — D46, §9.4            |
| "Used by" section   | ✅     | List of agent names as clickable links on detail page — §9.4                  |
| Delete confirmation | ✅     | Simple dialog with impacted agent list, no type-to-confirm — D48, §9.6        |
| Wizard validation   | ✅     | Per-step validation, block advancement on error — D47, §9.4                   |
| Step indicator      | ✅     | Clickable steps at top, current highlighted — §9.4                            |
| DSL preview         | ✅     | Collapsed by default, expandable — §9.4                                       |
| Loading states      | ✅     | Skeleton rows matching list layout — §9.7                                     |
| Error states        | ✅     | "Failed to load tools. [Try Again]" — §9.7                                    |
| Responsive design   | ✅     | Desktop-only (1280px min), no mobile — D50, §9.8                              |
| Accessibility       | ✅     | Basic a11y: semantic HTML, keyboard nav, focus management — §9.8              |
| Performance         | ⬜     | Deferred to Phase 15 (virtualization for 200+ tools)                          |

---

## Phase 8: Tool Maintenance (Update/Delete/Rename) ✅

**What it covers**: Lifecycle operations on existing tools — editing, deleting, renaming, impact analysis.

| Aspect                     | Status | Notes                                                                                         |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| Update flow                | ✅     | Full replace — studio sends all fields, server re-serializes — D17                            |
| Delete flow                | ✅     | Single endpoint: `DELETE` without force → impact list, with `?force=true` → hard delete — D19 |
| Rename flow                | ✅     | Part of normal update — no auto-update of agents — D22                                        |
| Impact check               | ✅     | On-demand query via `GET /tools/:id/impact` — returns list of agents                          |
| No concurrency protection  | ✅     | Last write wins — D18                                                                         |
| No auto-update on rename   | ✅     | Agents get E721 at next compile — user fixes manually                                         |
| Blast radius               | ✅     | Changes affect all agents at next compile — no immediate propagation                          |
| **Delete confirmation UX** | ⬜     | Dialog design with impacted agent list (Phase 7)                                              |
| **Audit trail display**    | ⬜     | `lastEditedBy` + `updatedAt` shown in UI (Phase 7/14)                                         |
| **Undo/revert UX**         | ⬜     | Agent version snapshots are the only history — manual copy (Phase 7)                          |
| Scaling                    | ⬜     | Impact query scanning agent DSLs — performance at 100+ agents                                 |
| Security                   | ⬜     | Project-level permissions for delete/rename                                                   |

---

## Phase 9: API Design (CRUD Routes) ✅

**What it covers**: REST API endpoints for project_tools — request/response shapes, pagination, validation, error handling.

| Aspect                | Status | Notes                                                                                              |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Route structure       | ✅     | `/api/projects/:projectId/tools` — studio only, not runtime — D14                                  |
| POST (create)         | ✅     | Raw form data → server serializes → validates → saves → returns full document                      |
| GET (list)            | ✅     | Summary by default, `?include=dslContent` for full. Supports pagination, type filter, name search. |
| GET (detail)          | ✅     | By ID, returns full document including `dslContent`                                                |
| PUT (update)          | ✅     | Full replace, all fields — D17. No `_v` check — D18                                                |
| DELETE                | ✅     | Single endpoint — without `?force=true` returns impact, with `?force=true` hard deletes — D19      |
| Rename                | ✅     | Part of PUT — no separate endpoint — D22                                                           |
| Impact check          | ✅     | Built into DELETE endpoint — `DELETE /tools/:id` (no force) returns `{ impactedAgents: [...] }`    |
| Error response format | ✅     | `{ success: false, errors: [{ code, field, message }] }` — all errors collected                    |
| Service architecture  | ✅     | Three layers: Repository + Validator + Service — D15                                               |
| Mongoose model        | ✅     | Structural validation in Mongoose, business in Validator                                           |
| **OpenAPI spec**      | ⬜     | Zod schemas, registry integration                                                                  |
| **Rate limiting**     | ⬜     | Per-tenant rate limits                                                                             |
| **Middleware chain**  | ⬜     | Auth → project scope → rate limit → handler                                                        |
| **Batch operations**  | ⬜     | Batch create for migration?                                                                        |
| Tenant isolation      | ✅     | Every query includes `tenantId` — C1.2                                                             |
| Project scoping       | ✅     | Every query includes `projectId` — C1.3                                                            |
| Caching               | ⬜     | Cache-Control headers? ETag?                                                                       |

---

## Phase 10: Security & Secrets ✅

**What it covers**: Secret handling, placeholder validation, environment variables, tenant isolation, permission model.

| Aspect                       | Status | Notes                                                                                                                                |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `{{secrets.X}}` placeholders | ✅     | Never plaintext — E760 — §5.3, C2.5                                                                                                  |
| `{{env.X}}` placeholders     | ✅     | Environment-specific values — R11.2                                                                                                  |
| `tool_secrets` collection    | ✅     | Unchanged — encrypted, tenant-scoped — R11.4                                                                                         |
| `environment_variables`      | ✅     | Unchanged — per-environment — R11.5                                                                                                  |
| Tenant isolation             | ✅     | Every query includes `tenantId` — R11.6                                                                                              |
| Project scoping              | ✅     | Every query includes `projectId` — R11.7                                                                                             |
| Secret detection logic       | ✅     | Regex patterns: API keys (32+ hex/base64), Bearer tokens, AWS keys, connection strings, private keys, base64 >100 chars — D52, R11.9 |
| False positive handling      | ✅     | Global `disableSecretDetection` flag per tenant (admin only) — D56, R11.13                                                           |
| Secret management UX         | ✅     | Link to existing `/settings/secrets` page — D54, R11.11                                                                              |
| Environment variable UX      | ✅     | Link to existing `/settings/environments` page — D55, R11.12                                                                         |
| Auth config security         | ✅     | HTTP auth uses `{{secrets.X}}` placeholders for tokens, API keys — already covered by D13                                            |
| Sandbox code security        | ✅     | gVisor isolation, no env var access, max 4GB memory, network restricted — D57, R11.14                                                |
| MCP server security          | ✅     | HTTPS/WSS required (E762 for http/ws), no cert validation v1, auth at server config level — D58, R11.15                              |
| SSRF protection              | ✅     | Block private IPs, localhost, link-local, metadata endpoints — E761 — D53, R11.10                                                    |
| Snapshot security            | ✅     | dslContent in snapshots has placeholders only, no real secrets — G9                                                                  |
| Permission model             | ✅     | Entity-level permissions: `tool:read`, `tool:write`, `tool:delete` — D51, R11.8                                                      |
| Audit logging                | ✅     | Tool create/update/delete events to audit store — D59, R11.16                                                                        |
| Scaling                      | ⬜     | Secret resolution caching deferred to Phase 15                                                                                       |

---

## Phase 11: AI/Arch Integration ✅

**What it covers**: How AI architect creates, discovers, and references tools.

| Aspect                      | Status | Notes                                                                                                          |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| Arch tool definitions       | ✅     | `create_tool`, `update_tool`, `list_tools`, `delete_tool` — §12.1                                              |
| AI workflow                 | ✅     | Check existing → create missing → generate DSL with signatures — §12.2                                         |
| DSL portability             | ✅     | AI-generated DSL is self-documenting — §12.3                                                                   |
| Tool definitions (detailed) | ✅     | Deferred to implementation — high-level description sufficient for design — D60, R12.12                        |
| AI context window           | ✅     | Tool list summary only (name, type, description). Paginate for 50+ tools. Full DSL on-demand. — D60, R12.5     |
| AI-generated tool quality   | ✅     | Same validation pipeline as studio. Structured errors returned. AI can retry. — D63, R12.8                     |
| AI tool creation flow       | ✅     | AI calls `create_tool` → same validation → same permissions (`tool:write`) → success/failure — D64, R12.9      |
| AI tool update flow         | ✅     | AI can update existing tools via `update_tool`. Same validation + permissions. — D61, R12.6                    |
| AI tool discovery           | ✅     | AI calls `list_tools` → gets summary → checks if tool exists → creates if missing — D60                        |
| AI error handling           | ✅     | Structured error format same as studio. AI retries with corrections. — D63, R12.8                              |
| MCP tool creation by AI     | ✅     | AI can create MCP tools if server exists in `mcp_server_configs`. AI cannot configure servers. — D62, R12.7    |
| Security                    | ✅     | Same permission checks (`tool:read/write/delete`). AI acts on behalf of user. No special bypass. — D64, R12.10 |
| Scaling                     | ✅     | AI tool operations count toward per-tenant rate limits. No special allowance. — D65, R12.11                    |

---

## Phase 12: Migration Strategy ⛔ N/A

**Not needed** — this is a greenfield implementation, not a migration from an existing system. The old tool infrastructure (if any) will be replaced directly. No migration scripts, data mapping, or cutover sequence required.

---

## Phase 13: Testing Strategy ✅

**What it covers**: Test plan for the new tool system — unit, integration, e2e.

| Aspect                              | Status | Notes                                                                     |
| ----------------------------------- | ------ | ------------------------------------------------------------------------- |
| **Coverage level**                  | ✅     | Full coverage: unit + integration + E2E — D66                             |
| **Tenant isolation testing**        | ✅     | Basic: verify tenantId in queries, no dedicated suite — D67               |
| **Framework & conventions**         | ✅     | Vitest, `globals: true`, `src/__tests__/*.test.ts` — D68                  |
| **Unit tests: validation pipeline** | ✅     | Each validation phase independently testable — D69, R13.1                 |
| **Unit tests: DSL serialization**   | ✅     | Form → DSL → parse roundtrip per tool type — D69, R13.3                   |
| **Unit tests: parser changes**      | ✅     | E720 rejection, signature parsing, forbidden properties — D69, R13.7      |
| **Unit tests: compilation**         | ✅     | `resolveToolImplementations()`, per-type binding compilation — D69, R13.4 |
| **Unit tests: stale detection**     | ✅     | Updated, deleted, new, renamed scenarios — D69, R13.5                     |
| **Unit tests: snapshot creation**   | ✅     | Full state capture, race condition prevention — D69, R13.6                |
| **Unit tests: secret detection**    | ✅     | Each pattern, edge cases, false positives — D69, R13.9                    |
| **Integration tests: API routes**   | ✅     | CRUD operations with tenant isolation verification — D70, R13.2           |
| **Integration tests: compilation**  | ✅     | DSL + project_tools → IR end-to-end — D70, R13.4                          |
| **Integration tests: permissions**  | ✅     | `tool:read`, `tool:write`, `tool:delete` per route — D70, R13.8           |
| **E2E tests: tool creation**        | ✅     | Form → validate → save → appears in library — D71                         |
| **E2E tests: tool linking**         | ✅     | Library picker → select → signature inserted → compile succeeds — D71     |
| **E2E tests: tool update**          | ✅     | Edit → save → stale detection fires — D71                                 |
| **E2E tests: tool deletion**        | ✅     | Impact check → force delete → agents get E721 — D71                       |
| **E2E tests: compilation**          | ✅     | Full compile flow → verify IR — D71, R13.10                               |
| **Mock strategy**                   | ✅     | Unit: mock DB. Integration: real DB. E2E: real DB + real compiler — D72   |
| **Security tests**                  | ✅     | SSRF (R13.11), MCP HTTPS (R13.12), secret detection (R13.9)               |
| **Performance tests**               | ⬜     | Deferred to Phase 15                                                      |

---

## Phase 14: Observability & Audit ✅

**What it covers**: Tracing, logging, audit events for tool lifecycle.

| Aspect                           | Status | Notes                                                                                                |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| **Observability infrastructure** | ✅     | Use existing platform patterns: TraceEvent, TraceStore, ClickHouse — D73, R14.9                      |
| **Tool CRUD audit events**       | ✅     | Create, update, delete logged to shared audit store — D59/R11.16, D79, R14.6                         |
| **Audit event schema**           | ✅     | Actor, resource (id/name/type), metadata (changedFields, impactedAgents) — D79, R14.7                |
| **Compilation trace events**     | ✅     | Resolution start/complete, per-tool compile, total compilation, timeout — D74, R14.1                 |
| **Validation trace events**      | ✅     | Pass/fail with failed phase and error codes — D75, R14.3                                             |
| **Stale detection events**       | ✅     | `tool.stale.detected` with stale tool list and changed fields — D76, R14.4                           |
| **Metric counters**              | ✅     | Standard counters + histograms: CRUD, compilation duration, validation rate, cache hits — D78, R14.8 |
| **Structured error logging**     | ✅     | All failures with structured context (session ID, agent name, tool name, error code)                 |
| **Dashboard**                    | ✅     | No dashboard v1. Usage count on library page. ClickHouse for ad-hoc queries. — D77, R14.10           |
| **Tenant isolation**             | ✅     | Every event includes `tenantId` and `projectId`. No cross-tenant leakage. — R14.5                    |
| **SOC 2 compliance**             | ✅     | Audit trail covers who/what/when for all tool lifecycle events — D79                                 |

---

## Phase 15: Performance & Scaling ✅

**What it covers**: Performance characteristics, scaling limits, optimization strategies.

| Aspect                        | Status | Notes                                                                       |
| ----------------------------- | ------ | --------------------------------------------------------------------------- |
| **Max tools per project**     | ✅     | 500 limit, E763 on exceed — D80, C10.1                                      |
| **Compilation time target**   | ✅     | <5s for 50 tools, <1s cache-warm — D82, R15.5                               |
| **API response time targets** | ✅     | List <500ms, detail <200ms, create/update <2s — D81, R15.2-R15.4            |
| **Library page load**         | ✅     | No pagination v1, all 500 max loaded, virtual scrolling future — D83, R15.9 |
| **Form rendering**            | ✅     | CodeMirror/Monaco with lazy loading for sandbox code (256KB max)            |
| **DB query optimization**     | ✅     | Two compound indexes cover all patterns, no N+1 — D86, R15.10               |
| **Caching strategy**          | ✅     | Redis by sourceHash, 24h TTL, MGET/MSET batch — D38, R15.7                  |
| **Connection pooling**        | ✅     | Standard MongoDB pooling, no special config                                 |
| **Concurrent compilations**   | ✅     | No protection — stateless, idempotent — D39                                 |
| **Large code content**        | ✅     | 256KB limit (C5.2), W726 at 64KB (D41), compression at storage layer        |
| **Snapshot storage growth**   | ✅     | ~50MB/project max, no dedup v1, lazy-loaded — D85, R15.12                   |
| **Multi-tenant density**      | ✅     | 500K documents, compound indexes sufficient, no sharding v1 — D84, C10.6    |

---

## Cross-Cutting Concerns Checklist

For every phase, ensure these are addressed:

| Concern               | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| **Tenant isolation**  | Every data path scoped to `tenantId`. No cross-tenant leakage. |
| **Project scoping**   | Every tool operation scoped to `projectId`.                    |
| **Authentication**    | All endpoints require auth middleware.                         |
| **Authorization**     | Project-level permissions on all routes.                       |
| **Error handling**    | Structured errors with codes. No empty catch blocks.           |
| **Validation**        | Input validation at system boundaries.                         |
| **Observability**     | Trace events for significant operations.                       |
| **Audit logging**     | Lifecycle events (create/update/delete) logged.                |
| **Performance**       | Indexed queries, batch operations, bounded payloads.           |
| **Scaling**           | Works at 100+ tools per project, 100+ tenants.                 |
| **Security**          | SSRF protection, secret detection, no plaintext secrets.       |
| **Accessibility**     | UI components keyboard navigable, screen reader compatible.    |
| **Loading states**    | Skeleton loaders, spinners for async operations.               |
| **Error states**      | UI error boundaries, retry mechanisms.                         |
| **Empty states**      | Meaningful empty states with CTAs.                             |
| **Responsive design** | Works on standard screen sizes.                                |

---

## Brainstorm Session Log

| Date       | Phase(s)      | Key Decisions Made                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-24 | 1, 2, 3, 4, 5 | Schema design, DSL syntax, creation paths, linking paths, compilation pipeline                                                                                                                                                                                                                                                                                              |
| 2026-02-24 | 6             | Full snapshot structure, stale detection, 12-gap analysis, no publishing (D5)                                                                                                                                                                                                                                                                                               |
| 2026-02-24 | 3, 8, 9       | Backend architecture (D13-D22): studio-only routes, 3-layer service, server-side serialization, full replace, last write wins, hard delete, stepped wizard, dialog type picker, no auto-update on rename                                                                                                                                                                    |
| 2026-02-24 | 3, 8, 9       | **Reverts**: D13 restored full auth/auth_config model (OAuth2 needs runtime token management). Delete changed from two-step to single endpoint with `?force=true`. HTTP wizard 4→5 steps (added Authentication). Added §8.4 Runtime Auth section.                                                                                                                           |
| 2026-02-24 | 4             | Tool linking UX: inline combobox picker (D23), multi-select (D25), pill-style tags (D26), confirmation on unlink (D27), append to end (D28), stale badge + update button (D29), lint on save/blur (D30), max 100 tools (D31), no duplicates (D32)                                                                                                                           |
| 2026-02-24 | 5             | Compilation pipeline: resolution in shared/ (D33), compiler pure (D34), collect-all errors (D35), W721 configurable threshold (D36), strict vs preview mode (D37), Redis cache by sourceHash (D38), no concurrency locks (D39), MCP batch-load (D40), sandbox inline with 64KB warning (D41), field-by-field staleness (D42), 30s timeout (D43), parallel Promise.all (D44) |
| 2026-02-24 | 7             | Tool library UX: list view with usage count (D45), detail page with inline edit (D46), per-step validation (D47), simple delete confirmation (D48), server-side search+filter (D49), desktop-only (D50)                                                                                                                                                                     |
| 2026-02-24 | 10            | Security & secrets: entity-level permissions (D51), secret detection patterns (D52), SSRF protection (D53), secret management link (D54), env var link (D55), global bypass flag (D56), sandbox gVisor isolation (D57), MCP HTTPS/WSS (D58), audit logging (D59)                                                                                                            |
| 2026-02-24 | 11            | AI/Arch integration: tool list summary only (D60), AI can update tools (D61), AI can create MCP tools if server exists (D62), structured errors with retry (D63), same permissions as user (D64), same rate limits (D65)                                                                                                                                                    |
| 2026-02-24 | 12            | **Skipped** — no migration needed, greenfield implementation                                                                                                                                                                                                                                                                                                                |
| 2026-02-24 | 13            | Testing strategy: full coverage (D66), basic tenant isolation (D67), Vitest conventions (D68), unit scope (D69), integration scope (D70), E2E scope (D71), mock strategy (D72), 12 test requirements (R13.1-R13.12)                                                                                                                                                         |
| 2026-02-24 | 14            | Observability: use existing platform patterns (D73), compilation trace events (D74), validation trace events (D75), stale detection events (D76), no dashboard v1 (D77), metric counters (D78), audit event schema (D79), 10 requirements (R14.1-R14.10)                                                                                                                    |
| 2026-02-24 | 15            | Performance: max 500 tools/project (D80), API latency targets (D81), <5s compilation (D82), no pagination v1 (D83), 500K doc scaling (D84), no snapshot dedup (D85), query optimization (D86), 12 requirements (R15.1-R15.12), 6 constraints (C10.1-C10.6)                                                                                                                  |
