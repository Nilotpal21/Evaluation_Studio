# DSL-Native Tools — Decisions, Constraints & Requirements

**Date**: 2026-02-24
**Status**: Approved
**Companion**: `2026-02-24-dsl-native-tools-design.md` (full design)

---

## Part A: Decisions

Every design choice made during brainstorming, with the alternatives we considered and why we chose what we chose.

---

### D1. One Tool Per Document

**Decision**: Each `project_tools` document stores exactly one tool definition.

**Rejected alternative**: Multi-tool files — one document containing multiple related tools (e.g., "payments-api" with charge, refund, get_balance).

**Why we rejected it**:

- Multi-tool parsing required for every CRUD operation
- Non-atomic edits (editing one tool means parsing all, modifying one, re-serializing all)
- Pre-extracted metadata (`toolNames[]`, `toolCount`) must be kept in sync — sync bugs are likely
- AI generation is harder (must decide: create new file or append to existing?)
- Partial failures: one tool's syntax error affects all tools in the file
- "File" naming is an artificial concept — `payments-api` isn't a tool, it's a container

**Why one-per-document wins**:

- Simplest mental model: 1 tool = 1 document = 1 name
- Atomic CRUD: create/update/delete one tool without affecting others
- Clean AI generation: AI generates one tool, saves one document
- Per-tool metadata: `toolType`, `description` are first-class DB fields
- Granular search/filter: query by `toolType`, `name` directly
- No multi-tool parser needed for CRUD operations

---

### D2. Agent DSL Contains Signatures Only

**Decision**: Agent DSL TOOLS section contains tool interface (name, params, returns, description, type) — never implementation details (endpoint, auth, code, server config).

**Rejected alternatives**:

- **All inline** — full tool definitions in agent DSL (portable but cluttered, dual editing paths)
- **Bare USE: name** — opaque reference with no signature (simple but unreadable, AI can't understand)

**Why signatures win**:

- **Portable**: Anyone reading agent DSL understands every tool's contract
- **AI-generatable**: AI generates interfaces naturally — doesn't need to know endpoints or OAuth configs
- **Clean separation**: Agent DSL = orchestration (what), project_tools = implementation (how)
- **Readable**: Developers see tool names + params + types without 15 lines of HTTP config per tool
- **Single creation path enforced**: No backdoor for putting implementation in agent DSL

---

### D3. project_tools Is the Sole Source of Truth

**Decision**: `project_tools.dslContent` is authoritative for tool implementation. Agent DSL signatures are informational only — the compiler ignores them for IR generation.

**Rejected alternative**: Agent DSL as source of truth (all inline, project_tools as a copy-from library).

**Why project_tools wins**:

- Single creation/editing path via forms — no dual editing surfaces
- Change a tool once → all agents get the update on next compile
- Validated DSL at rest — pre-save validation gate ensures consistency
- Forms enforce structure — no syntax errors from manual DSL editing

**Trade-off accepted**: Compilation depends on DB. Same agent DSL compiled at different times may produce different IR if project_tools changed. Mitigated by agent version snapshots.

---

### D4. DSL String Storage (Not Structured Fields)

**Decision**: `project_tools` stores tool implementation as a DSL string (`dslContent`), not as structured database fields.

**Rejected alternative**: Structured fields per type (e.g., `http.endpoint`, `http.method`, `sandbox.code`).

**Why DSL string wins**:

- Consistent with "DSL as source of truth" vision
- Schema evolution is easier — add new DSL features without DB migrations
- Single parser handles validation (not per-field DB validation)
- String diff for audit trail
- Flexible — DSL can express things that structured fields might miss

**Trade-off accepted**: Every read requires parsing. Mitigated by denormalized fields (`toolType`, `description`) for listing and the pre-save validation gate ensuring parsability.

---

### D5. No Tool-Level Versioning, No Publishing

**Decision**: No `tool_versions` collection. No draft/published lifecycle on tools. No version numbers on tools. No publishing concept. Tools are always mutable working copies — edit and save, that's it.

**How versioning works instead**: Agent versions automatically capture a full `toolSnapshot` at creation time — not just hash references, but the complete tool state (`name`, `projectToolId`, `sourceHash`, `toolType`, `description`, `dslContent`). This gives:

- **Exact reproducibility**: Full tool DSL captured at the moment the agent version was created
- **Audit trail**: Which tools changed between agent versions (diff via `sourceHash`)
- **Rename detection**: Same `projectToolId` with different `name` across versions
- **Survives deletion**: Full `dslContent` in snapshot even if tool is later deleted from `project_tools`
- **Read-only history**: Snapshots are immutable — viewable but never editable
- **Rollback reference**: View old tool state from any historical agent version (v1: manual copy, no auto-restore)

**Why no tool publishing**:

- Tools are "source files" — like code files in a repo. You edit them, you save them.
- Draft/published lifecycle adds complexity (which version is "active"? what about tools used by multiple agents at different publish states?)
- Tool version sprawl creates maintenance burden (draft, v1, v2, published, etc.)
- Agent-level snapshots are sufficient for audit, history, and rollback

**Why full state in snapshots, not just hashes**:

- Hash-only snapshots require `project_tools` to still exist for display — breaks on deletion
- Self-contained snapshots decouple version history from the mutable `project_tools` collection
- Storage is negligible (tool DSL is 5-20 lines of text)
- Simpler model: fewer collections, fewer APIs, fewer UI states

---

### D6. No Inline Tool Implementation

**Decision**: The parser rejects implementation properties (`endpoint`, `auth`, `code`, `server`, etc.) in agent DSL TOOLS section. Error E720.

**Rejected alternative**: Allow inline tools for quick prototyping, with project_tools as optional.

**Why full removal wins**:

- **Single creation path** — architecturally enforced, not just a convention
- No "oh I'll just put the endpoint inline for now" shortcuts that become permanent
- No dual editing surfaces (DSL editor vs forms)
- Parser enforcement is simple and clear
- Every tool goes through the validation gate

**Trade-off accepted**: Even one-off agent-specific tools need a project_tools entry. Mitigated by "Create Tool" inline action in the DSL editor that pre-fills the form from the typed signature.

---

### D7. Forms Only — No DSL Editing of Tools

**Decision**: Tool implementation is always created/edited via per-type forms. No raw DSL editing. DSL preview is read-only. One-way sync: Form → DSL.

**Rejected alternatives**:

- Bidirectional Form ↔ DSL sync (complex, parse-on-every-keystroke)
- DSL-only editing (excludes non-developers)

**Why forms-only wins**:

- Every save goes through the validation gate — no way to store invalid DSL
- Non-developers can create tools without learning DSL syntax
- Per-type forms guide users through required fields
- One-way sync is dramatically simpler than bidirectional
- DSL preview gives developers visibility without edit capability

---

### D8. Sandbox: No Entrypoint

**Decision**: Sandbox tools have no `entrypoint` field. Code executes directly. Parameters from the tool signature are injected as local variables.

**Old model** (rejected):

```abl
calculate_risk(data: object) -> {score: number}
  type: sandbox
  runtime: "javascript"
  entrypoint: "calculateRisk"     ← unnecessary indirection
  code: |
    function calculateRisk(data) {  ← must match entrypoint name
      return { score: 0.75 };
    }
```

**New model**:

```abl
calculate_risk(data: object) -> {score: number}
  type: sandbox
  runtime: "javascript"
  code: |
    const score = analyzeFactors(data);  ← 'data' injected directly
    return { score };
```

**Why**:

- Simpler mental model: write code, it runs, parameters are available
- No name-matching requirement between entrypoint and function name
- Fewer validation rules (no E744 entrypoint check)
- Runtime wraps code automatically with parameter injection

---

### D9. Slug Kept for Future Use

**Decision**: `slug` is auto-generated from `name` at creation time, stored immutably. `name` is the primary identifier used everywhere (DSL, compiler, UI).

**Why keep slug if not primary**:

- Future use cases: external API references, webhook URLs, stable identifiers for integrations
- Low cost to store — one extra indexed field
- Immutability gives stability that `name` (renameable) doesn't

**Why name is primary**:

- DSL references tools by name (readable, meaningful)
- Users think in names, not slugs
- Compiler resolves by name

---

### D10. REMOVED: `source` Field

**Decision**: No `source` field (`'manual' | 'discovered' | 'ai_generated'`) on project_tools.

**Why removed**: YAGNI. No system logic, compilation, validation, or execution depends on how a tool was created. If analytics later need this, it can be added as a non-breaking schema addition.

---

### D11. MCP: Added `server_tool` Field

**Decision**: MCP tools have an optional `server_tool` field for when the MCP server's tool name differs from our tool name.

```abl
get_weather(city: string) -> object
  type: mcp
  server: "weather-service"
  server_tool: "getCurrentWeather"   # optional, defaults to tool name
```

**Why**: MCP servers may expose tools under names that don't match our naming conventions. Without `server_tool`, we'd be forced to use the server's naming or lose the mapping.

---

### D12. project_tools Is Authoritative for Params/Returns

**Decision**: At compile time, the compiler uses project_tools data for parameters, returns, description — NOT the agent DSL signature. If they differ, a warning (W721) is emitted.

**Why**: Prevents stale agent DSL signatures from producing incorrect IR. The project_tools definition is always current (updated via forms with validation). Agent DSL signatures may be outdated.

---

### D13. RESTORED: Full `auth` and `auth_config` Model

**Decision**: HTTP tools support a dedicated `auth` enum with type-specific `auth_config` block. This is required for OAuth2 flows that need runtime token management beyond static headers.

**Auth types**: `none` | `bearer` | `api_key` | `oauth2_client` | `oauth2_user` | `custom`

**Rejected**: Headers-only approach (all auth expressed as static `headers` key-value pairs).

**Why headers-only was rejected**:

- Static headers cannot express OAuth2 client credentials flow (token_url, client_id, client_secret, scopes, auto-refresh)
- Static headers cannot express delegated user OAuth2 (provider-based token delegation)
- Runtime already has full auth infrastructure: `HttpToolExecutor` reads `auth.type` + `auth.config` from IR, `SecretsProvider` resolves credentials per auth type, OAuth2 token caching/refresh is built in
- Removing auth/auth_config would mean reimplementing this as ad-hoc header logic

**Why full auth model wins**:

- OAuth2 flows require runtime token management (fetch, cache, refresh) — not expressible as static headers
- Existing IR schema (`HttpBindingIR.auth`) already supports the full model
- Existing runtime executors already implement per-type auth handling
- `SecretsProvider` has multi-layer resolution: session cache → DB ToolSecret (AES-256-GCM) → IR credentials → env vars
- MCP server auth is already a dedicated config (`mcp_server_configs.auth_type`) — parity with HTTP

**Note**: `bearer` and `api_key` can also be expressed via `headers` block with `{{secrets.X}}`. The `auth` field provides structured semantics; `headers` provides the escape hatch for custom patterns.

---

### D14. Tool CRUD is Studio-Only

**Decision**: Tool CRUD API routes live in **studio only**. Runtime does NOT expose tool management endpoints. Runtime reads `project_tools` at compilation time via the shared repository layer.

**Why**: Tool management is a design-time concern. Runtime is for execution. Keeping CRUD in studio reduces runtime's attack surface and API complexity.

---

### D15. Three-Layer Service Architecture

**Decision**: Tool backend uses three layers in `packages/shared/`:

- `ProjectToolRepository` — pure DB operations (Mongoose model)
- `ProjectToolValidator` — 5-phase validation pipeline (business rules)
- `ProjectToolService` — orchestrates repo + validator + serializer + business logic

**Why**: Clean separation. Repository is testable without validation. Validator is testable without DB. Service orchestrates the flow. All three are reusable (studio, AI/Arch, migration scripts).

---

### D16. Server-Side DSL Serialization

**Decision**: Studio sends **raw form data** (structured fields). Server serializes to DSL via `serializeToolFormToDsl()`, validates, and saves. Studio never constructs DSL strings.

**Rejected**: Client-side DSL serialization (studio builds DSL, sends to server).

**Why server-side wins**:

- Single source of truth for serialization logic (not duplicated in client)
- Validation pipeline runs on same machine — no roundtrip
- AI/Arch sends same structured data — same code path
- Studio form stays a pure form UI, no DSL syntax knowledge needed

---

### D17. Full Replace on Update

**Decision**: Update sends all form fields every time. Server re-serializes full DSL and overwrites. No partial update / PATCH semantics.

**Rejected**: Partial updates (send only changed fields, merge server-side).

**Why**: Simpler — no merge logic, no field-level diffing, no "which fields were intentionally cleared vs omitted?" ambiguity. Forms always have all fields populated.

---

### D18. Last Write Wins (No Concurrency Check)

**Decision**: No `_v` optimistic concurrency checking on update. Last write wins. `_v` exists on the Mongoose schema but is not checked during updates.

**Rejected**: Requiring `_v` match on every update (409 Conflict on mismatch).

**Why**: Tools are rarely edited concurrently by multiple users. The UX complexity of "reload and retry" is not worth it for a low-probability scenario.

---

### D19. Hard Delete via Single Endpoint with Force Flag

**Decision**: `DELETE /tools/:id` is the single delete endpoint. Without `?force=true`, it returns `{ impactedAgents: ['agent_a', 'agent_b'] }` and does NOT delete. With `?force=true`, it permanently removes the document from MongoDB. No `deletedAt` field, no soft delete, no recycle bin.

**Rejected alternatives**:

- Soft delete with `deletedAt` timestamp — snapshots are the historical record
- Separate impact endpoint (`GET /tools/:id/impact`) — unnecessary extra route; single endpoint handles both

**Why single endpoint**: Fewer routes, simpler client logic. Studio calls DELETE once without force → gets impact list → shows confirmation → calls DELETE with `?force=true`. Two calls to the same endpoint, not two different endpoints.

---

### D20. Type Picker is a Dialog

**Decision**: "New Tool" opens a **dialog** with tool name input + type radio selector. "Create" navigates to the per-type stepped wizard form.

**Rejected**: Card selection page (full page with 3 clickable cards), inline tab switcher (tabs on form page).

**Why**: Dialog is lightweight — user picks name + type without leaving the library page. Wizard form opens only after the basic info is confirmed.

---

### D21. Stepped Wizard Forms

**Decision**: Tool creation/edit uses a **multi-step wizard** (Next/Back navigation) instead of a single scrollable form or accordion.

**Why**: Reduces cognitive load — user focuses on one concern per step. Allows progressive disclosure of advanced/optional fields. Matches the form complexity (HTTP has 5 steps, MCP has 3).

---

### D22. No Auto-Update on Rename

**Decision**: Renaming a tool does NOT auto-update agent DSLs referencing the old name. Agents will fail with E721 at next compilation. User manually updates agent DSL references.

**Rejected**: "Rename & Update Agents" option that batch-updates all agent DSLs.

**Why**: Simplicity. Agent DSLs are the user's domain — the tool system doesn't reach into them. Atomic batch updates across tool + N agents introduce transaction complexity and failure modes. E721 errors give clear, immediate feedback about what needs updating.

---

### D23. Library Picker is an Inline Combobox

**Decision**: "Add Tool" in the agent editor opens an **inline dropdown/combobox** directly in the tools section (like a tag picker), not a modal or drawer.

**Rejected alternatives**:

- Modal dialog (heavyweight for a quick selection)
- Slide-out panel (overkill for a list of tools)

**Why combobox wins**: Lightweight, fast. User stays in context. Type to search, select, done. Matches the mental model of "tagging" an agent with tools.

---

### D24. Library Picker Shows Name + Type + Description + Linked State

**Decision**: Each tool in the picker shows: name, type badge, description, and "already linked" indicator for tools already in this agent's TOOLS section.

**Why**: Description helps distinguish similarly-named tools. Linked state prevents accidental duplicates and gives visual feedback about what's already configured.

---

### D25. Library Picker Supports Multi-Select

**Decision**: Users can select multiple tools in the picker and add them all at once. Each selected tool's signature is appended to the TOOLS section.

**Why**: Common workflow is linking 3-5 tools when setting up an agent. Single-select-close-reopen is tedious.

---

### D26. Linked Tools Displayed as Compact Pills

**Decision**: In the agent editor's visual tools section, linked tools are displayed as **compact pill-style tags** with tool name + type-colored badge. Not cards, not table rows.

**Why**: Minimal visual footprint. Tools section is not the primary focus of the agent editor — it's configuration, not content. Pills scale well to 10-20 tools without overwhelming the layout.

---

### D27. Unlink Requires Confirmation

**Decision**: Removing a tool from an agent shows a confirmation: "Remove {tool_name} from this agent? The tool will remain in your library." Manual deletion from the raw DSL editor is also a valid unlink (no confirmation needed since it's a deliberate text edit).

**Why**: Prevents accidental removal. The confirmation message clarifies that the tool itself isn't deleted — important for users who might confuse unlinking with deleting.

---

### D28. Signatures Appended to End of TOOLS Section

**Decision**: When linking a tool via the picker, its signature is appended to the **end** of the TOOLS section. If no TOOLS section exists, one is auto-created.

**Rejected alternatives**:

- Insert at cursor (requires tracking cursor in DSL editor — complex)
- Alphabetically sorted (surprising reordering of user's DSL)

**Why append wins**: Predictable, simple. User can manually reorder in the DSL editor if they care about ordering.

---

### D29. Stale Badge + Update Signature Button

**Decision**: When a project_tool is updated and the agent DSL signature becomes stale, the visual tools section shows both (a) a stale badge on the tool pill, and (b) an "Update Signature" button. Clicking "Update Signature" replaces the entire signature block **in-place** (preserving position in TOOLS section).

**Why both**: Badge gives passive awareness. Button gives actionable one-click fix. In-place replacement preserves user's intentional ordering.

---

### D30. Lint on Save/Blur (Not Real-Time)

**Decision**: The DSL editor lints tool names against project_tools on **save or blur** — not on every keystroke. Unknown tool names appear in a problems panel. The inline "Create Tool" action pre-fills the creation form from the typed signature (name, params, returns, description, type).

**Rejected**: Real-time keystroke linting (too complex for v1, requires debounced API calls on every edit).

**Why save/blur wins**: Pragmatic middle ground. No API spam, no lag on typing. Errors surface before compile. Pre-fill from signature reduces friction for the "I typed it, now I need to create it" flow.

---

### D31. Max 100 Tools Per Agent

**Decision**: An agent can reference at most 100 tools in its TOOLS section. Parser rejects with an error if exceeded.

**Why**: Practical upper bound. An agent with 100+ tools is likely a design problem (should be split). Prevents LLM context overflow (each tool adds to the system prompt). Keeps compilation time bounded.

---

### D32. No Duplicate Tool Names Per Agent

**Decision**: The parser rejects duplicate tool names within the same agent's TOOLS section.

**Why**: Duplicate tool names would produce ambiguous IR. The parser catches this early rather than letting it propagate to compilation or runtime.

---

### D33. `resolveToolImplementations()` Lives in `packages/shared/`

**Decision**: The resolution function lives in `packages/shared/` so both studio (topology API, deploy) and runtime (session init) can use it.

**Rejected**: Putting it in `packages/compiler/` (would couple compiler to DB) or having callers pre-resolve (duplicated logic).

**Why shared wins**: Single implementation, reusable across studio and runtime. Compiler stays pure — it receives `resolvedToolImplementations` via `CompilerOptions`, never touches DB directly.

---

### D34. Caller-Resolves Pattern (Compiler Has No DB Access)

**Decision**: The caller (studio deploy handler, runtime session init) calls `resolveToolImplementations()` from `packages/shared/` and passes the result to the compiler via `CompilerOptions.resolvedToolImplementations`. The compiler is a **pure function** — no DB access.

**Why**: Clean separation. Compiler is testable without DB. Caller controls DB access, connection pooling, and caching. Same pattern as existing `resolvedToolLinks`.

---

### D35. Collect All Errors, Fail Compilation

**Decision**: If multiple tools fail resolution (E721, E722, E725), all errors are collected and returned at once. Compilation fails — no IR produced. No partial success.

**Rejected alternatives**:

- Fail fast (misses subsequent errors — user fixes one at a time)
- Partial success (dangerous — partial IR could be deployed accidentally)

**Why collect-all wins**: Best developer experience — user sees all broken tool references in one pass and fixes them all. No surprises from partial IR.

---

### D36. W721 Warnings Have Configurable Threshold

**Decision**: W721 (stale signature) warnings are non-blocking by default. A configurable threshold controls when warnings promote to errors (e.g., `>50%` stale = compilation error). Default threshold is disabled (warnings never block).

**Why configurable**: Teams with strict processes can enforce signature freshness. Teams moving fast can ignore staleness until they're ready. Threshold is a project-level or compilation option, not hardcoded.

---

### D37. Partial Compilation for Studio Preview

**Decision**: If tools fail resolution, compilation fails for deploy/version creation (no IR produced). However, studio topology/preview can use **partial compilation** — compile what resolves, flag missing tools as errors in the UI.

**Why two modes**: Deploy must be strict (C9.5: compilation gates snapshot). But studio needs to show useful previews while the user is still linking tools. The compiler returns both the partial result and the error list.

---

### D38. Cache Parsed Tool AST by sourceHash

**Decision**: Cache the parsed tool AST and compiled binding by `sourceHash`. If a tool hasn't changed since last compilation, skip re-parsing its `dslContent`. Cache lives in **Redis** (shared across pods).

**Rejected alternatives**:

- No caching (re-parse every time — wasteful for unchanged tools)
- Cache full resolved set per project (too coarse — one tool change invalidates everything)

**Why per-sourceHash wins**: Content-addressed — any pod builds the same cache entry for the same tool content. Natural invalidation: tool update changes sourceHash → cache miss → re-parse. No explicit invalidation needed.

---

### D39. No Concurrent Compilation Protection

**Decision**: No distributed locks for concurrent compilation of the same agent. Compilation is stateless — reads DB, produces IR. Two concurrent compilations both produce valid (possibly different) IR. Last write to IR cache wins.

**Why**: Compilation is idempotent and read-only (relative to project_tools). The output is deterministic per input. Locking adds latency and complexity for a scenario that resolves naturally.

---

### D40. MCP Server Resolution via Pre-Loaded Batch

**Decision**: During `resolveToolImplementations()`, collect all unique server names from MCP tools, batch-query `mcp_server_configs`, and bake full server config into `McpBindingIR`. Zero runtime DB lookups.

**What gets baked**: Full server config — URI, auth, transport, everything needed for runtime connection. Same as existing IR structure.

**Why batch**: Single `$in` query for all MCP servers. No N+1. Consistent with the tool resolution pattern.

---

### D41. Sandbox Code Inline in IR with Size Warning

**Decision**: Sandbox `code_content` is stored inline in the IR as a string. If code exceeds 64KB, emit a compilation warning. Compression happens at the IR storage layer (Redis/MongoDB gzip — already implemented).

**Rejected**: Content-addressed storage (over-engineering for v1 — tool DSL is max 256KB, compression reduces this significantly).

**Why inline with warning**: Simplest approach. IR is already gzipped at storage. Warning alerts developers to unusually large tools that may impact compilation/transfer performance.

---

### D42. Signature Staleness via Field-by-Field Comparison

**Decision**: W721 compares agent DSL signature vs project_tools field-by-field: parameters (names, types, count), returns type, and description. Name match is prerequisite (already matched by resolution). If any field differs, emit W721.

**Rejected alternatives**:

- sourceHash comparison (hash of DSL signature block is fragile — whitespace/formatting changes trigger false positives)
- Name-only check (too coarse — misses actual parameter changes)

**Why field-by-field**: Precise. Detects real semantic differences (new param, changed type, updated description) without false positives from formatting.

---

### D43. Compilation Timeout (30s Default)

**Decision**: Compilation has a configurable timeout. If `resolveToolImplementations()` + `compileABLtoIR()` exceeds the timeout, abort with a structured error. Default: 30 seconds.

**Why**: Prevents runaway compilations from blocking resources. 30s is generous — typical compilation with 50 tools should be <5s. Timeout is a safety net, not a performance target.

---

### D44. Parallel Tool Parsing and Compilation

**Decision**: During `resolveToolImplementations()`, parse and compile all resolved tools in parallel (`Promise.all`). Each tool's parse + binding compilation is independent.

**Why**: 50 tools × ~1ms sequential = 50ms. Parallel ≈ ~5ms. Easy win with no complexity — each tool's compilation is independent. No shared mutable state.

---

### D45. Tool Library List View with Usage Count

**Decision**: Tool library page uses a **list view** (one tool per row, stacked vertically). Each row shows: name, type badge, description, "Updated Xh ago", and **"Used by N agents"** count. No grid view, no view switcher.

**Rejected**: Grid view (harder to scan), card-heavy layouts (too much visual weight).

**Why list wins**: Clean, scannable, matches standard admin list UIs. "Used by" count gives immediate visibility into blast radius before editing/deleting.

---

### D46. Tool Detail Page with Inline Editing

**Decision**: Clicking a tool in the library opens a **detail page** (`/tools/:id`) with read-only overview (name, type, description, DSL preview, "Used by" section). The page has an [Edit] button that switches to **inline edit mode** — the same wizard form, overlaying the detail view. No separate `/tools/:id/edit` route.

**Rejected alternatives**:

- Direct to edit form (no read-only view — users can't just view a tool without entering edit mode)
- Separate edit page (extra route, extra navigation step)

**Why inline edit wins**: Single page, fewer routes. View-first is the common case (users browse, inspect, only edit when needed). Inline transition from view → edit is seamless.

---

### D47. Per-Step Validation (Block on Error)

**Decision**: Wizard form validates each step when user clicks [Next]. If validation fails, errors are shown inline on the current step and [Next] is disabled until fixed. User cannot advance past an invalid step. Validation never runs on [Save] — by the time you reach the final step, all previous steps are guaranteed valid.

**Rejected**: End-of-form validation (user fills everything, clicks [Save], sees errors from step 1 — bad UX).

**Why per-step wins**: Immediate feedback. User fixes errors as they go. [Save] button on final step is always safe to click.

---

### D48. Simple Delete Confirmation (No Type-to-Confirm)

**Decision**: Delete confirmation dialog shows the list of impacted agents and a simple [Delete] button. No type-to-confirm required.

**Rejected**: Type-to-confirm (too heavyweight — tools are recoverable from agent version snapshots).

**Why simple confirmation wins**: Tools aren't critical infrastructure. Accidental deletion is fixable (view snapshot DSL, copy to new tool). Type-to-confirm is for truly destructive actions (delete tenant, drop database). This is destructive but recoverable.

---

### D49. Server-Side Search and Type Filtering

**Decision**: Search (name + description) and type filtering are **server-side** — API queries with `?search=` and `?type=` params. Studio fetches filtered results from the API.

**Why**: Consistent with existing API design (R1.4 already defines these params). Works at any scale. Simple client code (no in-browser filtering logic).

---

### D50. Desktop-Only UI (No Mobile Responsive)

**Decision**: Tool library and forms are **desktop-only** — minimum 1280px width assumed. No responsive breakpoints for tablet/mobile.

**Why**: Studio is a developer tool. Usage patterns show >95% desktop. Mobile responsiveness is effort with little value. Clean break: "not supported on mobile" is clearer than "barely works on mobile."

---

### D51. Entity-Level Permissions (tool:read, tool:write, tool:delete)

**Decision**: Tool CRUD operations use **entity-level permissions** — `tool:read`, `tool:write`, `tool:delete` checked via the existing RBAC system. Not project-wide write access, not a separate "tools:write" permission.

**Rejected alternatives**:

- Project-wide write (too coarse — grants access to all entities in project)
- New granular permission (unnecessary — existing entity-level permissions work)

**Why entity-level wins**: Consistent with existing RBAC for agents, workflows, deployments. Reuses existing permission checks. Fine-grained control per resource type.

---

### D52. Secret Detection Patterns

**Decision**: Pre-save validation detects plaintext secrets via regex patterns and rejects with E760:

- **API keys**: 32+ character hex or base64 strings (e.g., `sk_live_[A-Za-z0-9]{32,}`)
- **Bearer tokens**: `Bearer [A-Za-z0-9-._~+/]+=*`
- **AWS keys**: `AKIA[0-9A-Z]{16}`
- **Connection strings**: `mongodb://`, `postgres://`, `mysql://` with embedded credentials
- **Private keys**: `-----BEGIN PRIVATE KEY-----`, `-----BEGIN RSA PRIVATE KEY-----`
- **Base64 blobs**: Base64 strings >100 characters (likely encoded secrets)

**Why these patterns**: Catches the most common secret types. Regex-based detection is fast and deterministic. False positives are handled by bypass flag (D56).

---

### D53. SSRF Protection for HTTP Tools

**Decision**: HTTP tool `endpoint` URL is validated at save time. Block private IP ranges and metadata endpoints. Emit E761 on violation.

**Blocked ranges**:

- RFC1918 private IPs: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Localhost: `127.0.0.0/8`, `::1`
- Link-local: `169.254.0.0/16`, `fe80::/10`
- Cloud metadata endpoints: `169.254.169.254`, `fd00:ec2::254`

**Why**: Prevents SSRF attacks where HTTP tools are tricked into calling internal services, cloud metadata endpoints, or localhost. Validation at save time (not just runtime) gives immediate feedback.

---

### D54. Secret Management UX — Link to Existing Page

**Decision**: When a tool form contains `{{secrets.X}}` placeholders, the UI shows "Secrets referenced: X, Y [Manage Secrets →]" — a link to the existing `/settings/secrets` page. No inline secret creation in tool forms.

**Rejected**: Inline secret creation dialog (adds complexity to tool forms — secrets are tenant-wide config, not tool-specific).

**Why link wins**: Secrets are managed centrally, not per-tool. Existing secret management page has full UX (create, edit, delete, environment scoping). Tool forms just validate placeholder syntax and link out.

---

### D55. Environment Variable UX — Link to Existing Page

**Decision**: When a tool form contains `{{env.X}}` placeholders, the UI shows "Environment variables referenced: X, Y [Manage Variables →]" — a link to the existing `/settings/environments` page. No inline preview of current values in tool forms.

**Rejected**: Inline preview (adds complexity — env vars are per-environment, tool forms are environment-agnostic).

**Why link wins**: Consistent with secrets approach. Environment variables are managed centrally. Tool forms just validate placeholder syntax and link out.

---

### D56. Global Secret Detection Bypass Flag

**Decision**: If secret detection produces false positives, a **tenant admin** can set a global flag (`disableSecretDetection: true` in tenant settings) to disable E760 validation for that tenant. No per-tool or per-field allowlist.

**Rejected alternatives**:

- No override (too strict — blocks legitimate use cases like demo URLs with fake tokens)
- Per-field allowlist (complex UX — adds "Mark as safe" button to every field)

**Why global bypass wins**: Simple. Admins make a conscious decision to disable protection tenant-wide. Most tenants leave it enabled. Power users who understand the risk can disable. No per-tool state to maintain.

---

### D57. Sandbox Code Security Model

**Decision**: Sandbox tools execute in **gVisor isolation** (already implemented). Code cannot access environment variables directly — parameters are injected as local variables only. Network access is restricted (allowlist future, default deny for v1). Max memory 4GB, max execution time from `timeout` field.

**Why**: gVisor provides kernel-level isolation. No access to host filesystem, env vars, or network beyond what's explicitly allowed. Secure by default.

---

### D58. MCP Server Security

**Decision**: MCP tool `server` URI must use **HTTPS or WSS** (reject `http://`, `ws://` with E762). No certificate chain validation in v1 (trust user-provided server config). Authentication to MCP server is handled at the server config level in `mcp_server_configs` (already exists).

**Why**: Encrypted transport prevents MITM. Cert validation is complex (self-signed certs, private CAs) — defer to v2. Auth at server level (not per-tool) matches existing MCP architecture.

---

### D59. Audit Logging for Tool Lifecycle

**Decision**: Tool create, update, delete events are logged to the audit store with: actor (`userId`), timestamp, tool name, tool type, action (`tool.created`, `tool.updated`, `tool.deleted`), `tenantId`, `projectId`. Uses existing audit infrastructure (no new store).

**Why**: Compliance requirement (SOC 2). Audit trail for who changed what and when. Reuses existing audit store — no new infrastructure.

---

### D60. AI Context Window — Tool List Summary Only

**Decision**: When AI (Arch) calls `list_tools`, it receives **summary only**: name, type, description per tool. No full DSL content. For projects with 50+ tools, paginate or limit to most relevant. If AI needs full DSL for a specific tool, it fetches on-demand.

**Rejected**: Sending all full DSL content (blows up AI context with implementation details that are rarely needed).

**Why summary wins**: Most AI workflows just need to know "what tools exist" to avoid duplicates. Full DSL is only needed when AI wants to understand or modify implementation. On-demand fetch keeps context lean.

---

### D61. AI Can Update Existing Tools

**Decision**: Arch has `update_tool` action. AI can update existing tool implementations (e.g., fix a broken endpoint, add a parameter, change auth). Same validation pipeline. Same permission checks (`tool:write`).

**Rejected alternatives**:

- Read-only update (AI suggests, human approves — adds friction)
- No update capability (AI can only create/delete — limits usefulness)

**Why AI update wins**: AI is already trusted to create tools. Update is the same operation with a different starting state. Validation catches errors. User can review via stale detection + agent compile errors. Blast radius exists for both create and update.

---

### D62. AI Can Create MCP Tools (If Server Exists)

**Decision**: AI can call `create_tool` with `type: mcp` if the MCP server already exists in `mcp_server_configs`. Server must be pre-configured by user. AI cannot discover or configure servers.

**Rejected alternatives**:

- No MCP for AI (too restrictive — MCP tools are just references to server tools)
- AI auto-discovery of servers (too complex — server setup requires URIs, auth, transport config)

**Why "if server exists" wins**: MCP tool creation is simple once the server is configured (just `server: "name"` + `server_tool: "tool_name"`). Server config is infrastructure — user sets up once, AI references many times.

---

### D63. AI Error Handling — Structured Errors with Retry

**Decision**: When AI tool operations fail validation, AI receives the same structured error format as studio: `{ success: false, errors: [{ code, field, message }] }`. AI can retry with corrections.

**Why**: Consistent error format across all callers (studio, AI, API). AI can parse errors and adjust inputs. No special error handling for AI.

---

### D64. AI Permissions — Same as User

**Decision**: AI tool operations (`create_tool`, `update_tool`, `delete_tool`, `list_tools`) go through **same permission checks** as human users. `tool:write` required for create/update, `tool:delete` for delete, `tool:read` for list. AI acts on behalf of the user who initiated the session.

**Why**: No special bypass for AI. Security model is consistent. AI inherits user's permissions. Prevents AI from performing operations the user isn't allowed to do.

---

### D65. AI Rate Limiting — No Special Allowance

**Decision**: AI tool operations count toward the same per-tenant API rate limits as studio/API calls. No special allowance for AI.

**Why**: Prevents runaway AI tool creation. Same infrastructure, same limits. If AI hits rate limits, user sees clear error and can adjust workflow or request limit increase.

---

### D66. Test Coverage Level — Full Coverage

**Decision**: Full test coverage: unit tests + integration tests + E2E tests across all new tool system components.

**Rejected alternative**: (a) Unit tests only — faster to write but misses integration bugs between layers (validator ↔ serializer ↔ compiler). (c) Unit + integration only — misses full workflow failures.

**Why**: The tool system spans parser, compiler, API routes, DB layer, and UI. Bugs at integration boundaries are the most dangerous. Full coverage catches: pure logic errors (unit), API contract violations (integration), and workflow-level regressions (E2E).

---

### D67. Tenant Isolation Test Approach — Basic Verification

**Decision**: Basic tenant isolation: verify `tenantId` is included in all DB queries. No dedicated multi-tenant test suite.

**Rejected alternatives**: (a) Full multi-tenant test suite — two tenants, same resource names, verify zero cross-contamination per operation. Overkill for v1. (b) Integration-level — test cross-tenant 404s on every route. Adds significant test maintenance burden.

**Why**: The platform already enforces tenant isolation via Mongoose query patterns and middleware. Adding `tenantId` to every query is an existing pattern. Verifying it's present in each new query is sufficient. A full multi-tenant test suite is a future investment if cross-tenant bugs emerge.

---

### D68. Testing Framework & Conventions

**Decision**: Vitest with `globals: true`. Tests in `src/__tests__/*.test.ts`. Runtime tests use `pool: 'forks'`. Follows existing codebase conventions.

**Why**: Consistency with existing test infrastructure. No new test framework to learn or configure.

---

### D69. Unit Test Scope

**Decision**: All pure functions independently tested:

- Validation pipeline: each of 5 phases testable in isolation
- DSL serializers: `serializeToolFormToDsl()` per tool type
- Parser changes: E720 rejection, signature parsing, forbidden properties
- Compilation helpers: `resolveToolImplementations()`, per-type binding compilation
- Stale detection: sourceHash comparison, field-by-field W721 checks
- Snapshot creation: `ToolSnapshotEntry` construction
- Secret detection: each regex pattern, edge cases, false positives

**Why**: Pure functions are the foundation. Fast to run, easy to debug, high signal-to-noise ratio.

---

### D70. Integration Test Scope

**Decision**: API routes tested with real MongoDB (in-memory via `mongodb-memory-server` or test container):

- CRUD operations: create, read, update, delete with validation
- Validation pipeline: form data → validate → serialize → save → return
- Compilation flow: DSL + project_tools → compile → verify IR output
- Permission enforcement: `tool:read`, `tool:write`, `tool:delete` per route
- Error responses: structured error format with correct codes

**Why**: Integration tests catch contract violations between layers. Real DB ensures query correctness (indexes, unique constraints, projections).

---

### D71. E2E Test Scope

**Decision**: Full workflow tests covering critical paths:

- Tool creation: form → validate → save → appears in library list
- Tool linking: library picker → select → signature inserted into agent DSL → compile succeeds
- Tool update: edit tool → save → stale detection fires in linked agents
- Tool deletion: delete with impact check → force delete → agents get E721
- Compilation: agent DSL with tool signatures + project_tools → compile → verify `ToolDefinition` IR

**Why**: E2E tests validate the entire system works together. Catches workflow-level regressions that unit/integration tests miss.

---

### D72. Mock Strategy

**Decision**:

- **Unit tests**: Mock DB (no real MongoDB), mock Redis, mock external services. Test pure logic only.
- **Integration tests**: Real DB (in-memory MongoDB), mock external services (MCP servers, HTTP endpoints). Test API contracts.
- **E2E tests**: Real DB + real compilation pipeline. Mock only external infrastructure (MCP servers, HTTP tool endpoints).

**Why**: Each test level has appropriate isolation. Unit tests are fast (no I/O). Integration tests verify DB interactions. E2E tests verify end-to-end correctness.

---

### D73. Observability Infrastructure — Use Existing Platform Patterns

**Decision**: All tool system observability uses the existing platform infrastructure: `TraceEvent` type, shared `TraceStore` interface, ClickHouse backend, structured logging. No new observability infrastructure needed.

**Why**: The platform already has a mature observability stack (CLAUDE.md §4 Full Traceability). Adding tool-specific events follows the established pattern. No new dependencies or abstractions.

---

### D74. Compilation Trace Events

**Decision**: The compilation pipeline emits trace events at each phase:

| Event                       | Fields                                                                  | When                                  |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| `tool.resolution.start`     | `agentName`, `toolCount`, `compilationMode`                             | Before `resolveToolImplementations()` |
| `tool.resolution.complete`  | `agentName`, `resolvedCount`, `missingCount`, `durationMs`, `cacheHits` | After resolution                      |
| `tool.compilation.per_tool` | `toolName`, `toolType`, `durationMs`, `fromCache`                       | Per-tool binding compilation          |
| `tool.compilation.complete` | `agentName`, `totalTools`, `warnings[]`, `errors[]`, `durationMs`       | After full compilation                |
| `tool.compilation.timeout`  | `agentName`, `elapsedMs`, `timeoutMs`                                   | On E727 timeout                       |

**Why**: Compilation is the most performance-sensitive path. Per-tool granularity enables bottleneck identification. Cache hit tracking validates caching strategy. Timeout events enable alerting.

---

### D75. Pre-Save Validation Trace Events

**Decision**: The validation pipeline emits trace events:

| Event                  | Fields                                                          | When              |
| ---------------------- | --------------------------------------------------------------- | ----------------- |
| `tool.validation.pass` | `toolName`, `toolType`, `durationMs`, `phasesRun`               | All 5 phases pass |
| `tool.validation.fail` | `toolName`, `toolType`, `failedPhase`, `errors[]`, `durationMs` | Any phase fails   |

**Why**: Validation failures are the primary creation/update blocker. Tracking failure rates and which phases fail most guides UX improvements (better form validation, better error messages).

---

### D76. Stale Detection Trace Events

**Decision**: Stale detection emits during compilation:

| Event                 | Fields                                                            | When              |
| --------------------- | ----------------------------------------------------------------- | ----------------- |
| `tool.stale.detected` | `agentName`, `staleTools[]` (name + changed fields), `totalTools` | Any W721 warnings |

Each entry in `staleTools[]` includes: `{ toolName, changedFields: ['parameters', 'returns', 'description'] }`.

**Why**: Tracks how frequently signatures become stale and which fields drift most. Informs whether "auto-update signatures" should be a future feature.

---

### D77. No Admin Dashboard in v1

**Decision**: No dedicated admin tool usage dashboard. Tool observability is via:

- Library page: "Used by N agents" count per tool (D45)
- Existing platform metrics/traces infrastructure for operational visibility
- ClickHouse queries for ad-hoc analysis

**Why**: Building a dashboard is UI work with low ROI at launch. The "Used by N agents" count covers the primary use case. Operational teams query ClickHouse directly. Dashboard is a future enhancement if there's demand.

---

### D78. Metric Counters

**Decision**: Standard counters and histograms emitted via existing metrics infrastructure:

| Metric                           | Type      | Labels                                |
| -------------------------------- | --------- | ------------------------------------- |
| `tool.created`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.updated`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.deleted`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.compilation.duration_ms`   | Histogram | `compilationMode`, `toolCount` bucket |
| `tool.validation.duration_ms`    | Histogram | `toolType`, `result` (pass/fail)      |
| `tool.validation.failure_rate`   | Counter   | `toolType`, `failedPhase`             |
| `tool.resolution.cache_hit_rate` | Counter   | `result` (hit/miss)                   |

**Why**: Standard operational metrics for monitoring health. Cache hit rate validates caching strategy. Validation failure rate identifies problematic tool types or form UX issues.

---

### D79. Audit Event Schema

**Decision**: Tool audit events follow the existing audit store schema with these tool-specific fields:

```typescript
{
  type: 'tool.created' | 'tool.updated' | 'tool.deleted',
  actor: { userId, email },
  tenantId: string,
  projectId: string,
  resource: {
    id: string,          // project_tools._id
    name: string,        // tool name
    toolType: string,    // http | sandbox | mcp
  },
  metadata: {
    changedFields?: string[],  // for updates: which fields changed
    impactedAgents?: number,   // for deletes: how many agents affected
  },
  timestamp: Date,
}
```

**Why**: Consistent with existing audit patterns. `changedFields` on update enables "who changed what" queries. `impactedAgents` on delete provides blast radius context.

---

### D80. Max Tools Per Project — 500

**Decision**: Maximum 500 tools per `(tenantId, projectId)`. Enforced at API create time. Error E763 if limit exceeded.

**Rejected alternatives**: (a) Unlimited — no practical need, unbounded data growth risk. (b) 100 — too restrictive for projects with many HTTP integrations. (c) 1000 — generous but unnecessary. 500 covers all realistic use cases.

**Why**: 500 tools × ~5KB avg DSL = ~2.5MB total data per project. Well within MongoDB document/index performance. Compound index `(tenantId, projectId, name)` handles queries efficiently. Leaves headroom for large enterprise projects.

---

### D81. API Response Time Targets

**Decision**: Target latencies under normal load:

| Operation                      | Target | Notes                                                                   |
| ------------------------------ | ------ | ----------------------------------------------------------------------- |
| `GET /tools` (list)            | <500ms | Includes DB query with filter/search. Projection excludes `dslContent`. |
| `GET /tools/:id` (detail)      | <200ms | Single document lookup by `_id` + `tenantId`.                           |
| `POST /tools` (create)         | <2s    | Includes 5-phase validation + trial compile.                            |
| `PUT /tools/:id` (update)      | <2s    | Same validation as create.                                              |
| `DELETE /tools/:id` (no force) | <500ms | Impact check: scan agent DSLs for references.                           |
| `DELETE /tools/:id?force=true` | <300ms | Single document delete.                                                 |

**Why**: Create/update are slower due to validation pipeline (especially trial compile which may invoke parser + compiler). 2s is acceptable for a save operation. Read operations are fast (indexed queries).

---

### D82. Compilation Performance Target

**Decision**: Target <5s for compiling an agent with 50 tools (all tool types). Breakdown:

| Phase                                   | Target    |
| --------------------------------------- | --------- |
| Tool resolution (batch DB lookup)       | <500ms    |
| Redis cache check (MGET)                | <100ms    |
| Per-tool binding compilation (parallel) | <3s total |
| IR merge + warnings                     | <200ms    |

Cache-warm compilation (all tools cached): <1s.

**Why**: 30s timeout (D43) is the hard limit. 5s target ensures good developer experience. Parallel compilation (D44) and Redis caching (D38) make this achievable. Per-tool compilation is CPU-bound (parsing DSL), averaging ~50ms/tool.

---

### D83. Library Page Rendering

**Decision**: No pagination in v1. Load all tools for the project (max 500) with server-side search/filter. Client renders full list.

**Future optimization** (not v1): Virtual scrolling (react-window or similar) if rendering 200+ rows causes perceptible jank. Measured threshold: if initial render exceeds 200ms, add virtualization.

**Why**: 500 tools × ~100 bytes per row summary = ~50KB payload. Trivial network/parse cost. DOM rendering of 500 rows is borderline but acceptable for desktop-only (D50) with modern browsers. Virtual scrolling is a known optimization path if needed.

---

### D84. Multi-Tenant Scaling Limits

**Decision**: Designed for:

- 100 tenants × 10 projects × 500 tools = **500,000 documents** in `project_tools`
- Compound index `(tenantId, projectId, name)` handles all queries with O(log n) lookups
- Compound index `(tenantId, projectId)` for list queries
- No sharding needed at this scale
- MongoDB WiredTiger handles 500K documents with ease

**If scaling beyond**: Consider tenant-based sharding with `tenantId` as shard key. Separate concern from v1.

**Why**: 500K documents × ~5KB avg = ~2.5GB total collection size. Indexes fit in RAM. Query performance is bounded by index depth, not collection scan. No special scaling infrastructure needed.

---

### D85. Snapshot Storage Growth

**Decision**: No deduplication in v1. Accept full tool state in every agent version snapshot.

**Projected growth**: 500 tools × 200 versions × 500 bytes/snapshot entry = ~50MB per project. Across 100 tenants × 10 projects = ~50GB total. Negligible for MongoDB.

**Mitigations already in place**:

- Version list API excludes snapshots (C9.7 — lazy-loaded)
- Tool DSL is compact (5-20 lines typical, max 256KB sandbox code)
- Projection in list queries reduces payload

**Future optimization**: Content-addressed deduplication by `sourceHash` (G11). Only store unique tool states, reference by hash in version snapshots. Only if storage becomes a concern.

**Why**: YAGNI. Storage is cheap. Deduplication adds complexity (reference counting, garbage collection). Revisit if projected growth exceeds 100GB.

---

### D86. DB Query Optimization

**Decision**: Query patterns optimized via:

| Pattern                | Index Used                                 | Covered?                                             |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------- |
| List by project        | `(tenantId, projectId)` compound           | Partial (projection needed for dslContent exclusion) |
| Find by name           | `(tenantId, projectId, name)` unique       | Yes (index-only lookup)                              |
| Batch resolve by names | `(tenantId, projectId, name)` with `$in`   | Yes                                                  |
| Find by ID             | `_id` + `tenantId` filter                  | Yes (primary key + index)                            |
| Filter by toolType     | `(tenantId, projectId)` + in-memory filter | Acceptable for 500 max docs                          |

**Why**: Two compound indexes cover all query patterns. No need for additional indexes on `toolType` or `description` — the max 500 documents per project means in-memory filtering after index scan is negligible.

---

## Part B: Requirements

Every functional requirement the system must satisfy.

---

### R1. Tool CRUD

| ID    | Requirement                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1.1  | System must support creating project_tools entries via per-type stepped wizard forms (HTTP, Sandbox, MCP)                                                              |
| R1.2  | System must support updating project_tools entries via the same per-type forms (full replace, all fields)                                                              |
| R1.3  | System must support deleting project_tools entries via hard delete                                                                                                     |
| R1.4  | System must support listing project_tools with filtering by toolType, search by name, and configurable field inclusion (`?include=dslContent`)                         |
| R1.5  | Rename is part of normal update — no auto-update of agent DSL references. Agents get E721 at next compile.                                                             |
| R1.6  | System must expose 5 API routes: `POST` (create), `GET` (list), `GET /:id` (detail), `PUT /:id` (update), `DELETE /:id` (delete with optional `?force=true`)           |
| R1.7  | Tool CRUD routes live in **studio only** — runtime does NOT expose tool management                                                                                     |
| R1.8  | Backend uses three-layer architecture: Repository (Mongoose) + Validator (business rules) + Service (orchestration), all in `packages/shared/`                         |
| R1.9  | Studio sends raw form data — server serializes to DSL via `serializeToolFormToDsl()`                                                                                   |
| R1.10 | Create and update return full tool document in response                                                                                                                |
| R1.11 | Delete is a single endpoint: `DELETE /tools/:id` without `force=true` returns `{ impactedAgents: [...] }` and does NOT delete; with `?force=true` performs hard delete |
| R1.12 | No concurrency protection — last write wins                                                                                                                            |

### R2. Tool Validation

| ID   | Requirement                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| R2.1 | Every project_tools write (create or update) must pass 5-phase validation before saving                        |
| R2.2 | Phase 1: DSL must parse without errors                                                                         |
| R2.3 | Phase 2: Tool must have a name and a valid type (http/sandbox/mcp)                                             |
| R2.4 | Phase 3: Type-specific bindings must be complete and valid (see per-type requirements)                         |
| R2.5 | Phase 4: DSL must not contain plaintext secrets (detect raw API keys, tokens, base64)                          |
| R2.6 | Phase 5: Trial compilation — parse + compile binding + verify external references (MCP server must exist)      |
| R2.7 | All validation errors collected across all phases, returned at once (`{ errors: [{ code, field, message }] }`) |
| R2.8 | Validation warnings are non-blocking — save proceeds with warnings                                             |
| R2.9 | Validation runs server-side in `ProjectToolValidator` — studio sends raw form data, not DSL                    |

### R3. HTTP Tool Requirements

| ID    | Requirement                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R3.1  | Must have `endpoint`                                                                                                               |
| R3.2  | `method` defaults to GET if not specified                                                                                          |
| R3.3  | `headers` is a key-value block — used for custom/additional headers. Use `{{secrets.X}}` for sensitive values.                     |
| R3.4  | `auth` field supports: `none`, `bearer`, `api_key`, `oauth2_client`, `oauth2_user`, `custom`                                       |
| R3.5  | `auth_config` is required for `oauth2_client` (`token_url`, `client_id`, `client_secret`, `scopes`) and `oauth2_user` (`provider`) |
| R3.6  | Sensitive auth values must use `{{secrets.X}}` placeholders (e.g., `client_secret`, tokens)                                        |
| R3.7  | `retry` must be 0-10                                                                                                               |
| R3.8  | `timeout` must be 1-300000 ms                                                                                                      |
| R3.9  | `circuit_breaker` requires both `threshold` (1-100) and `reset_ms` (1000-300000)                                                   |
| R3.10 | Environment-specific values (URLs, IDs) should use `{{env.X}}` placeholders                                                        |

### R4. Sandbox Tool Requirements

| ID   | Requirement                                                                          |
| ---- | ------------------------------------------------------------------------------------ |
| R4.1 | Must have `runtime` — "javascript" or "python"                                       |
| R4.2 | Must have `code` — non-empty, max 256KB                                              |
| R4.3 | No `entrypoint` — code executes directly with parameters injected as local variables |
| R4.4 | `memory_mb` must be 128-4096 (defaults to 128)                                       |
| R4.5 | `timeout` must be 100-60000 ms (defaults to 5000)                                    |
| R4.6 | Runtime wraps user code: `(async function(param1, param2) { <code> })(val1, val2)`   |

### R5. MCP Tool Requirements

| ID   | Requirement                                                                  |
| ---- | ---------------------------------------------------------------------------- |
| R5.1 | Must have `server` — name referencing `mcp_server_configs`                   |
| R5.2 | `server_tool` is optional — defaults to the tool's own name                  |
| R5.3 | Server existence is validated at compile time, not at tool save time         |
| R5.4 | MCP server config is baked into IR at compile time (zero runtime DB lookups) |

### R6. Agent DSL Requirements

| ID   | Requirement                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------- |
| R6.1 | Agent DSL TOOLS section must contain tool signatures only (name, params, returns, description, type) |
| R6.2 | Parser must reject implementation properties with E720                                               |
| R6.3 | Every tool name in TOOLS section must declare `type: http \| sandbox \| mcp`                         |
| R6.4 | `USE TOOL:` syntax must be fully removed from parser                                                 |
| R6.5 | `FROM...USE` syntax must be fully removed from parser                                                |

### R7. Tool Linking Requirements

| ID    | Requirement                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------ |
| R7.1  | Users can add tools to agent DSL via inline combobox picker in the tools section                                   |
| R7.2  | Picker extracts signature from project_tools.dslContent and appends to end of TOOLS section                        |
| R7.3  | Users can manually type tool signatures in the DSL editor                                                          |
| R7.4  | Editor must lint tool names on save/blur against project_tools (not real-time keystroke)                           |
| R7.5  | For unknown tool names, editor must offer inline "Create Tool" action that pre-fills the form from typed signature |
| R7.6  | AI (Arch) can generate agent DSL with tool signatures                                                              |
| R7.7  | Linking is type-agnostic — same flow for HTTP, Sandbox, MCP                                                        |
| R7.8  | Picker shows name, type badge, description, and "already linked" indicator per tool                                |
| R7.9  | Picker supports multi-select — add several tools at once                                                           |
| R7.10 | If no TOOLS section exists, linking auto-creates one                                                               |
| R7.11 | Unlinking shows confirmation: "Remove {name} from this agent? The tool will remain in your library."               |
| R7.12 | Manual deletion of signature text in DSL editor is a valid unlink (no confirmation)                                |
| R7.13 | Linked tools displayed as compact pill-style tags (name + type badge) in the visual tools section                  |
| R7.14 | Each pill has a "View" action linking to the tool detail page                                                      |
| R7.15 | Stale tools show a stale badge + "Update Signature" button that replaces the signature block in-place              |
| R7.16 | Max 100 tools per agent — parser rejects if exceeded                                                               |
| R7.17 | No duplicate tool names within same agent — parser rejects duplicates                                              |

### R8. Compilation Requirements

| ID    | Requirement                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R8.1  | Compiler must resolve every tool name in agent DSL from project_tools collection                                                        |
| R8.2  | Resolution must batch all tool lookups into a single `$in` DB query per compilation                                                     |
| R8.3  | For each resolved tool, compiler must parse `project_tools.dslContent` and compile type-specific bindings                               |
| R8.4  | For MCP tools, compiler must look up `mcp_server_configs` and bake server config into IR                                                |
| R8.5  | project_tools data is authoritative for IR generation — agent DSL signatures are informational                                          |
| R8.6  | If agent DSL signature differs from project_tools, emit warning W721                                                                    |
| R8.7  | If tool not found in project_tools, emit error E721                                                                                     |
| R8.8  | If MCP server not found, emit error E722                                                                                                |
| R8.9  | Output ToolDefinition IR must be identical in structure to current IR (no IR schema breaking changes except sandbox entrypoint removal) |
| R8.10 | System tools (handoff, delegate, escalate, complete) are unaffected — compiler-injected as before                                       |
| R8.11 | `resolveToolImplementations()` lives in `packages/shared/` — reusable by studio and runtime                                             |
| R8.12 | Compiler has no DB access — caller resolves tools and passes via `CompilerOptions.resolvedToolImplementations`                          |
| R8.13 | All resolution errors (E721, E722, E725) collected across all tools, returned at once, compilation fails                                |
| R8.14 | W721 warnings non-blocking by default. Configurable threshold promotes to error (e.g., >50% stale)                                      |
| R8.15 | Studio preview uses partial compilation (compile what resolves, flag errors). Deploy/version creation requires all tools resolved.      |
| R8.16 | Parsed tool AST cached by `sourceHash` in Redis. Cache miss → re-parse. No explicit invalidation needed.                                |
| R8.17 | No concurrent compilation protection — stateless, idempotent, last write to IR cache wins                                               |
| R8.18 | MCP server configs batch-loaded during resolution. Full config baked into `McpBindingIR`.                                               |
| R8.19 | Sandbox `code_content` inline in IR. Warning emitted if code exceeds 64KB. Compression at storage layer.                                |
| R8.20 | W721 staleness detected via field-by-field comparison: parameters, returns, description                                                 |
| R8.21 | Compilation timeout: 30s default, configurable. Abort with structured error on timeout.                                                 |
| R8.22 | Tool parsing and binding compilation run in parallel (`Promise.all`) during resolution                                                  |

### R9. Agent Version & Snapshot Requirements

| ID    | Requirement                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R9.1  | Agent version creation must automatically capture `toolSnapshot`: array of `ToolSnapshotEntry` with full tool state (`name`, `projectToolId`, `sourceHash`, `toolType`, `description`, `dslContent`) |
| R9.2  | Tool snapshots must be **read-only** — viewable in version history but never editable                                                                                                                |
| R9.3  | There is **no tool publishing concept** — tools are always mutable working copies, no draft/published lifecycle                                                                                      |
| R9.4  | Snapshot creation must use the same DB read as compilation — no separate fetch (eliminates race conditions)                                                                                          |
| R9.5  | Snapshots must be **self-contained** — survive tool deletion, no cross-reference to project_tools needed for display                                                                                 |
| R9.6  | Stale detection must compare current `project_tools.sourceHash` with snapshot's `sourceHash`                                                                                                         |
| R9.7  | Stale detection must compare against the **active** version's snapshot (fallback: latest version with snapshot)                                                                                      |
| R9.8  | Stale detection must identify tools as "updated" (hash differs), "deleted" (not found), or "new" (in working DSL but not in snapshot)                                                                |
| R9.9  | UI must show stale tool banner when editing an agent with stale/deleted/new tools                                                                                                                    |
| R9.10 | Version diff must show tools added, removed, changed, and **renamed** (detected via `projectToolId` matching) between two agent versions                                                             |
| R9.11 | Version list API must NOT return `toolSnapshot` (lightweight pagination) — only version detail API returns it                                                                                        |
| R9.12 | If compilation fails (e.g., E721 unresolved tool), version creation fails — no partial snapshots                                                                                                     |
| R9.13 | No "Restore Tool" from snapshot in v1 — rollback is view-only reference                                                                                                                              |

### R10. UI/UX Requirements

| ID     | Requirement                                                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R10.1  | Tool library page uses list view (one tool per row) showing name, type badge, description, "Updated Xh ago", "Used by N agents" count           |
| R10.2  | Tool library supports server-side search (name + description) and type filtering (HTTP/Sandbox/MCP)                                             |
| R10.3  | "New Tool" must open a **dialog** with name input + type radio selector (API / Code / MCP)                                                      |
| R10.4  | Each type must use a **stepped wizard form** with type-specific fields                                                                          |
| R10.5  | Wizard forms must show a collapsible read-only DSL preview that updates in real-time                                                            |
| R10.6  | Forms must be the only editing surface — no raw DSL editing of tools                                                                            |
| R10.7  | Delete must show impacted agents before confirming — `DELETE /tools/:id` (no force) returns impact list, `DELETE /tools/:id?force=true` deletes |
| R10.8  | Rename has no special UX — it's part of normal form update. No "Rename & Update Agents"                                                         |
| R10.9  | MCP tool creation must support server picker dropdown (existing servers only) + tool discovery flow                                             |
| R10.10 | HTTP tool wizard steps: Basics → Endpoint (URL, method, headers) → Authentication (auth type, auth_config) → Parameters & Response → Advanced   |
| R10.11 | Sandbox tool wizard steps: Basics → Runtime & Code → Parameters & Response → Advanced                                                           |
| R10.12 | MCP tool wizard steps: Basics → Server & Tool → Parameters & Response                                                                           |
| R10.13 | Default sort order is last modified (most recent first), with option to sort by name (alphabetical)                                             |
| R10.14 | No pagination for v1 — load all tools, rely on search/filter for large lists                                                                    |
| R10.15 | Empty state shows illustration + "No tools yet. Create your first tool." with [+ New Tool] button                                               |
| R10.16 | Clicking a tool in library opens detail page at `/tools/:id` with read-only view                                                                |
| R10.17 | Tool detail page shows: name, type, description, DSL preview (collapsible), "Used by" section (list of agent names as links), [Edit] button     |
| R10.18 | [Edit] button switches to inline edit mode — wizard form overlays detail view, no separate route                                                |
| R10.19 | Wizard validates per-step on [Next]. Errors shown inline, [Next] disabled until fixed. No end-of-form validation.                               |
| R10.20 | Wizard has clickable step indicator at top (Step 1 of 5 with step names, current step highlighted)                                              |
| R10.21 | DSL preview panel is collapsed by default, expandable via toggle                                                                                |
| R10.22 | Delete confirmation dialog shows impacted agent list + [Delete] button. No type-to-confirm required.                                            |
| R10.23 | Loading state uses skeleton rows matching list layout                                                                                           |
| R10.24 | Error state shows "Failed to load tools. [Try Again]" with retry button                                                                         |
| R10.25 | UI is desktop-only (minimum 1280px), no mobile responsive behavior                                                                              |
| R10.26 | Basic accessibility: semantic HTML, keyboard navigation for major actions, focus management on dialogs                                          |
| R10.27 | No bulk actions for v1 (no multi-select, no bulk delete)                                                                                        |

### R11. Security Requirements

| ID     | Requirement                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R11.1  | Sensitive values must use `{{secrets.X}}` placeholders — never plaintext                                                                      |
| R11.2  | Environment-specific values must use `{{env.X}}` placeholders                                                                                 |
| R11.3  | Pre-save validation must detect and reject potential plaintext secrets (E760)                                                                 |
| R11.4  | `tool_secrets` collection remains unchanged (encrypted, tenant-scoped)                                                                        |
| R11.5  | `environment_variables` collection remains unchanged (per-environment)                                                                        |
| R11.6  | project_tools must enforce tenant isolation via `tenantId` in all queries                                                                     |
| R11.7  | project_tools must enforce project scoping via `projectId` in all queries                                                                     |
| R11.8  | Tool CRUD operations require entity-level permissions: `tool:read`, `tool:write`, `tool:delete`                                               |
| R11.9  | Secret detection validates for: API keys (32+ hex/base64), Bearer tokens, AWS keys, connection strings, private keys, base64 blobs >100 chars |
| R11.10 | SSRF protection blocks private IPs (RFC1918, localhost, link-local), cloud metadata endpoints — E761 on violation                             |
| R11.11 | Tool forms show "Secrets referenced: X [Manage Secrets →]" link to `/settings/secrets` page                                                   |
| R11.12 | Tool forms show "Environment variables referenced: X [Manage Variables →]" link to `/settings/environments` page                              |
| R11.13 | Tenant admin can set global `disableSecretDetection` flag to bypass E760 validation                                                           |
| R11.14 | Sandbox tools execute in gVisor isolation. No env var access. Max 4GB memory. Max execution time from timeout field.                          |
| R11.15 | MCP server URI must use HTTPS or WSS (E762 for http/ws). No cert validation in v1. Auth at server config level.                               |
| R11.16 | Tool create/update/delete events logged to audit store with: actor, timestamp, tool name/type, action, tenantId, projectId                    |

### R12. AI (Arch) Integration Requirements

| ID     | Requirement                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| R12.1  | Arch must have `create_tool` action to create project_tools entries                                                                 |
| R12.2  | Arch must have `list_tools` action to discover existing tools in a project                                                          |
| R12.3  | Arch must generate agent DSL with tool signatures that reference existing project_tools                                             |
| R12.4  | Arch-generated DSL must go through the same validation pipeline                                                                     |
| R12.5  | `list_tools` returns summary only (name, type, description). Paginate or limit for 50+ tools. Full DSL on-demand.                   |
| R12.6  | Arch has `update_tool` action. AI can update existing tool implementations. Same validation + permissions as create.                |
| R12.7  | AI can create MCP tools (`type: mcp`) if the MCP server exists in `mcp_server_configs`. AI cannot configure servers.                |
| R12.8  | AI tool operation failures return structured errors: `{ success: false, errors: [{ code, field, message }] }`                       |
| R12.9  | AI tool operations require same permissions as user: `tool:write` for create/update, `tool:delete` for delete, `tool:read` for list |
| R12.10 | AI acts on behalf of the user who initiated the session. No special permission bypass.                                              |
| R12.11 | AI tool operations count toward per-tenant API rate limits. No special allowance.                                                   |
| R12.12 | Detailed Arch tool schemas deferred to implementation phase. High-level description sufficient for design.                          |

### R13. Testing Requirements

| ID     | Requirement                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R13.1  | Every validation phase (parse, structural, type-specific, security, trial compile) has independent unit tests                             |
| R13.2  | Every API route has CRUD integration tests with tenant isolation verification (tenantId in queries)                                       |
| R13.3  | DSL serialization roundtrip tests: form data → DSL → parse → verify per tool type (HTTP, Sandbox, MCP)                                    |
| R13.4  | Compilation tests: agent DSL + project_tools → IR for each tool type, verifying `ToolDefinition` output                                   |
| R13.5  | Stale detection tests: updated tool, deleted tool, new tool, renamed tool scenarios                                                       |
| R13.6  | Snapshot creation tests: full state capture correctness, single-read race condition prevention                                            |
| R13.7  | Error code tests: every error code (E720-E762) and warning (W721, W726) has at least one test case                                        |
| R13.8  | Permission tests: `tool:read`, `tool:write`, `tool:delete` enforcement verified per route                                                 |
| R13.9  | Secret detection tests: each pattern (API keys, Bearer, AWS, connection strings, private keys, base64) matched + false positive scenarios |
| R13.10 | E2E compilation flow: agent DSL with tool signatures + project_tools → compile → verify IR matches expected output                        |
| R13.11 | SSRF protection tests: private IP, localhost, link-local, metadata endpoint blocking verified                                             |
| R13.12 | MCP security tests: HTTPS/WSS required (E762 for http/ws)                                                                                 |

### R14. Observability & Audit Requirements

| ID     | Requirement                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R14.1  | Compilation pipeline emits trace events: `tool.resolution.start`, `tool.resolution.complete`, `tool.compilation.per_tool`, `tool.compilation.complete`, `tool.compilation.timeout`                                |
| R14.2  | Each compilation trace event includes: agentName, toolCount/toolName, durationMs, compilationMode                                                                                                                 |
| R14.3  | Pre-save validation emits `tool.validation.pass` or `tool.validation.fail` with failedPhase and error codes                                                                                                       |
| R14.4  | Stale detection emits `tool.stale.detected` with list of stale tools and their changed fields                                                                                                                     |
| R14.5  | All trace events include `tenantId` and `projectId`. No cross-tenant event leakage.                                                                                                                               |
| R14.6  | Tool CRUD audit events (`tool.created`, `tool.updated`, `tool.deleted`) logged to shared audit store (already D59/R11.16)                                                                                         |
| R14.7  | Audit events include: actor (userId, email), resource (id, name, toolType), timestamp, metadata (changedFields for updates, impactedAgents for deletes)                                                           |
| R14.8  | Standard metric counters emitted: `tool.created`, `tool.updated`, `tool.deleted`, `tool.compilation.duration_ms`, `tool.validation.duration_ms`, `tool.validation.failure_rate`, `tool.resolution.cache_hit_rate` |
| R14.9  | All observability uses existing platform infrastructure (TraceEvent, TraceStore, ClickHouse). No new backends.                                                                                                    |
| R14.10 | No admin dashboard in v1. Tool usage visibility via library page "Used by N agents" count.                                                                                                                        |

### R15. Performance & Scaling Requirements

| ID     | Requirement                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------- |
| R15.1  | Max 500 tools per `(tenantId, projectId)`. E763 on create if limit exceeded.                        |
| R15.2  | `GET /tools` (list) must respond in <500ms with projection excluding `dslContent`                   |
| R15.3  | `GET /tools/:id` (detail) must respond in <200ms                                                    |
| R15.4  | `POST /tools` and `PUT /tools/:id` must complete in <2s (including full validation pipeline)        |
| R15.5  | Agent compilation with 50 tools must complete in <5s (cache-warm: <1s)                              |
| R15.6  | Tool resolution uses batch `$in` query — no N+1 queries                                             |
| R15.7  | Redis cache for parsed tool AST with 24h TTL, content-addressed by `sourceHash`                     |
| R15.8  | Per-tool binding compilation runs in parallel via `Promise.all`                                     |
| R15.9  | Library page renders up to 500 tools without pagination (server-side search/filter reduces payload) |
| R15.10 | Compound indexes `(tenantId, projectId, name)` and `(tenantId, projectId)` cover all query patterns |
| R15.11 | No sharding required for target scale: 500K documents across 100 tenants × 10 projects × 500 tools  |
| R15.12 | Snapshot storage: no deduplication v1. Projected ~50MB per project at max scale.                    |

---

## Part C: Constraints

Hard boundaries the implementation must not violate.

---

### C1. Platform Constraints

| ID   | Constraint                 | Detail                                                                     |
| ---- | -------------------------- | -------------------------------------------------------------------------- |
| C1.1 | **No filesystem**          | All data in MongoDB. No `.tools.abl` files on disk.                        |
| C1.2 | **Multi-tenant isolation** | Every query must include `tenantId`. No cross-tenant data leakage.         |
| C1.3 | **Project scoping**        | project_tools scoped to `(tenantId, projectId)`. Tools are not global.     |
| C1.4 | **Stateless pods**         | No pod-local state. project_tools in MongoDB, IR cache in Redis + MongoDB. |

### C2. Data Integrity Constraints

| ID   | Constraint                 | Detail                                                            |
| ---- | -------------------------- | ----------------------------------------------------------------- |
| C2.1 | **Name uniqueness**        | `(tenantId, projectId, name)` must be unique across project_tools |
| C2.2 | **Slug immutability**      | Slug set at creation, never changed                               |
| C2.3 | **Validated DSL at rest**  | project_tools.dslContent is guaranteed to parse and compile       |
| C2.4 | **Optimistic concurrency** | `_v` field prevents lost updates from concurrent edits            |
| C2.5 | **No plaintext secrets**   | Validation gate rejects plaintext secrets in DSL                  |

### C3. Parser Constraints

| ID   | Constraint                         | Detail                                                                                                                                                                                              |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C3.1 | **No implementation in agent DSL** | Parser rejects: `endpoint`, `method`, `headers`, `auth`, `auth_config`, `timeout`, `retry`, `retry_delay`, `rate_limit`, `circuit_breaker`, `code`, `runtime`, `memory_mb`, `server`, `server_tool` |
| C3.2 | **Type required**                  | Every tool in agent DSL must declare `type: http \| sandbox \| mcp`                                                                                                                                 |
| C3.3 | **USE TOOL removed**               | Parser no longer recognizes `USE TOOL:` syntax                                                                                                                                                      |
| C3.4 | **FROM...USE removed**             | Parser no longer recognizes `FROM "name" USE:` syntax                                                                                                                                               |
| C3.5 | **Max 100 tools per agent**        | Parser rejects if TOOLS section exceeds 100 tool definitions                                                                                                                                        |
| C3.6 | **No duplicate tool names**        | Parser rejects duplicate tool names within same agent's TOOLS section                                                                                                                               |

### C4. Compilation Constraints

| ID   | Constraint                                              | Detail                                                                                                                       |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C4.1 | **All tools must exist in project_tools**               | Compilation fails (E721) for any tool name not found                                                                         |
| C4.2 | **MCP server must exist at save time AND compile time** | E722 if server not in mcp_server_configs. Server must be created before MCP tool. Form dropdown only shows existing servers. |
| C4.3 | **Batch resolution**                                    | All tool lookups batched into single `$in` query. No N+1.                                                                    |
| C4.4 | **project_tools authoritative**                         | Compiler uses project_tools data for IR, not agent DSL signatures                                                            |
| C4.5 | **IR format unchanged**                                 | Output ToolDefinition IR structure identical to current (except sandbox entrypoint removal)                                  |
| C4.6 | **Compiler is pure**                                    | Compiler has no DB access. Caller resolves tools, passes via CompilerOptions.                                                |
| C4.7 | **Collect all errors**                                  | All resolution errors collected across all tools, returned at once. No fail-fast.                                            |
| C4.8 | **Compilation timeout**                                 | 30s default. Abort with structured error on timeout. Configurable.                                                           |
| C4.9 | **Parallel tool compilation**                           | Tool parsing and binding compilation run in parallel via `Promise.all`.                                                      |

### C5. Storage Constraints

| ID   | Constraint                | Detail                                                     |
| ---- | ------------------------- | ---------------------------------------------------------- |
| C5.1 | **One tool per document** | project_tools stores exactly one tool per document         |
| C5.2 | **Code size limit**       | Sandbox code max 256KB                                     |
| C5.3 | **Name format**           | Lowercase, underscores, 2-64 characters                    |
| C5.4 | **DSL string storage**    | Implementation stored as DSL string, not structured fields |

### C6. UI Constraints

| ID   | Constraint                   | Detail                                                                             |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------- |
| C6.1 | **Forms only**               | Tool implementation edited via per-type forms only. No raw DSL editing.            |
| C6.2 | **One-way sync**             | Form → DSL preview (read-only). No DSL → Form direction.                           |
| C6.3 | **Pre-delete warning**       | Must show impacted agents before allowing deletion (via DELETE without force flag) |
| C6.4 | **No auto-update on rename** | Rename is normal update — agents get E721. No "Rename & Update" option.            |

### C7. Runtime Constraints

| ID   | Constraint                       | Detail                                                                                       |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| C7.1 | **Zero runtime tool DB lookups** | All tool data baked into IR at compile time                                                  |
| C7.2 | **Executors work on IR**         | HttpToolExecutor, McpToolExecutor unchanged. SandboxToolExecutor modified for no-entrypoint. |
| C7.3 | **Secret resolution unchanged**  | `{{secrets.X}}` / `{{env.X}}` via SecretsProvider at execution time                          |
| C7.4 | **IR caching unchanged**         | L1 in-memory → L2 Redis → L0 MongoDB                                                         |

### C8. Backward Compatibility Constraints

| ID   | Constraint                    | Detail                                                        |
| ---- | ----------------------------- | ------------------------------------------------------------- |
| C8.1 | **No backward compatibility** | Clean break. No support for `USE TOOL:` during migration.     |
| C8.2 | **No migration shims**        | No code that handles "old format or new format" at runtime.   |
| C8.3 | **One-time migration**        | Export old → import new → delete old. No dual-running period. |

### C9. Snapshot Constraints

| ID   | Constraint                                 | Detail                                                                                                                      |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| C9.1 | **No tool publishing**                     | No draft/published lifecycle on tools. Tools are always mutable working copies.                                             |
| C9.2 | **Snapshots are read-only**                | Tool snapshots in agent versions are immutable. No editing, no restoring (v1).                                              |
| C9.3 | **Full state capture**                     | Snapshots contain `name`, `projectToolId`, `sourceHash`, `toolType`, `description`, `dslContent` — not just hash references |
| C9.4 | **Single DB read for compile + snapshot**  | Same `resolveToolImplementations()` result feeds both compilation and snapshot creation. No race conditions.                |
| C9.5 | **Compilation gates snapshot**             | If compilation fails (E721, E722, etc.), version creation fails — no partial snapshots created                              |
| C9.6 | **Stale detection against active version** | Compare against active version's snapshot. Fallback: latest version with snapshot.                                          |
| C9.7 | **Lazy-loaded snapshots**                  | Version list API excludes snapshots. Version detail API includes them on demand.                                            |

### C10. Performance Constraints

| ID    | Constraint                       | Detail                                                                |
| ----- | -------------------------------- | --------------------------------------------------------------------- |
| C10.1 | **Max 500 tools per project**    | Enforced at API create time. E763 if exceeded.                        |
| C10.2 | **Max 100 tools per agent**      | Enforced at parser level. C3.5.                                       |
| C10.3 | **Compilation timeout 30s**      | Hard limit. E727 on timeout. Configurable via `compilationTimeoutMs`. |
| C10.4 | **Batch DB queries only**        | Tool resolution uses single `$in` query. No N+1 patterns.             |
| C10.5 | **No pagination in list API v1** | Max 500 tools returned. Server-side search/filter reduces payload.    |
| C10.6 | **No sharding v1**               | Target scale 500K documents. Compound indexes sufficient.             |

---

## Part D: Limitations

Known limitations accepted as part of this design.

---

| ID  | Limitation                                                           | Impact                                                                                                         | Mitigation                                                                                                                                     |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **No shared defaults across tools**                                  | If 5 HTTP tools share the same base_url and auth, each repeats the `{{env.X}}` references                      | Environment variables (`{{env.X}}`) serve as shared defaults — same value for all tools that reference them                                    |
| L2  | **Compilation depends on DB**                                        | If project_tools DB is unavailable, compilation fails                                                          | Same as current system (DB is always required). Redis/MongoDB HA mitigates.                                                                    |
| L3  | **Same DSL, different IR at different times**                        | If project_tools changes between compilations, IR changes even though agent DSL didn't                         | Agent version snapshots capture `sourceHash` for reproducibility audit. Determinism is per-compilation, not per-DSL.                           |
| L4  | **No cross-project tool sharing**                                    | project_tools scoped to (tenantId, projectId). Cannot share tools between projects.                            | Copy DSL between projects manually. Future feature possible.                                                                                   |
| L5  | **No tool-level access control**                                     | Permissions are at project level. Any project member can edit any tool.                                        | Possible future feature using `slug` field for per-tool permissions.                                                                           |
| L6  | **Stale signatures in agent DSL**                                    | Agent DSL signature may lag behind project_tools after tool update                                             | W721 warning at compile time + stale detection banner in UI. Informational only — does not affect IR.                                          |
| L7  | **Blast radius of shared tool changes**                              | Changing a tool's implementation affects ALL agents using it at next compile                                   | Tool edit UI shows "Used by N agents" count. Stale detection warns agent editors.                                                              |
| L8  | **Every tool needs a project_tools entry**                           | Even one-off agent-specific tools need a DB entry. No "quick inline" shortcut.                                 | "Create Tool" inline action in DSL editor pre-fills form from typed signature. Two clicks from "I need a tool" to "it exists."                 |
| L9  | **No raw DSL editing for tools**                                     | Developers cannot edit tool DSL directly — must use forms                                                      | "Copy DSL" button for clipboard export. Forms cover all fields. Developer audience has DSL preview for visibility.                             |
| L10 | **Sandbox entrypoint removal is a breaking change**                  | Existing sandbox tools with `entrypoint` will need migration                                                   | One-time migration: remove `entrypoint` from existing tools, verify code works without it                                                      |
| L11 | **No "Restore Tool" from snapshot**                                  | Users can view old tool state in version history but cannot auto-restore a tool to a previous snapshot's state | Manual copy from snapshot DSL preview. Automated restore is a future enhancement (requires re-validation since servers/envs may have changed). |
| L12 | **Snapshot deduplication not implemented**                           | Same tool state stored in full across multiple versions even if unchanged                                      | Storage is negligible (tool DSL is 5-20 lines). Content-addressed deduplication by `sourceHash` is a future optimization if needed.            |
| L13 | **No inter-tool dependency tracking in snapshots**                   | If tool A depends on tool B's infrastructure, snapshots capture them independently                             | Tools are independent by design. Inter-tool dependencies are an infrastructure concern, not a snapshot concern.                                |
| L14 | **Version diff shows "removed + added" for renames unless detected** | Tool renames across versions may appear as separate add/remove operations                                      | Rename detection via `projectToolId` matching mitigates this for most cases.                                                                   |

---

## Part E: Snapshot Gap Analysis

Identified gaps in the agent version snapshot approach, categorized by severity.

Full analysis with resolutions documented in the design doc §10.7.

---

### Critical Gaps (must resolve before implementation)

| Gap                                        | Problem                                                                                                                 | Resolution                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1: Orphaned tool references**           | Deleted tool still referenced in working DSL → batch lookup finds nothing at version creation                           | Compilation gate: E721 fails compilation → version creation fails. No partial snapshots with unresolved tools.                                                                                              |
| **G3: Race condition**                     | Tool updated between compiler read and snapshot capture → IR has state X, snapshot has state Y                          | Single DB read: `resolveToolImplementations()` result feeds BOTH compilation AND snapshot. No second fetch.                                                                                                 |
| **G7: Which version for stale detection?** | Multiple versions exist — which snapshot to compare against? User may be editing from older version.                    | Compare against **active** version's snapshot (deployed). Fallback: latest version with any status that has a snapshot. Matches intent: "has anything changed since last deployment?"                       |
| **G8: Tool not yet in project_tools**      | User types tool name in DSL that doesn't exist yet → batch lookup returns nothing                                       | Blocked by compilation: E721 error → version creation fails → user must create tool first. No partial snapshots.                                                                                            |
| **G9: Security — dslContent exposure**     | Snapshot contains full tool DSL (URLs, server URIs, code) — could users with `version:read` but not `tool:read` see it? | No permission gap: both resources are project-scoped. Same project membership gates both. Secrets use `{{secrets.X}}` placeholders (never plaintext). URLs use `{{env.X}}` (actual values at runtime only). |

### Important Gaps (should resolve)

| Gap                                                     | Problem                                                                            | Resolution                                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G2: Tool renamed between versions**                   | Rename shows as "removed + added" in version diff — no continuity                  | Detect via `projectToolId`: if removed tool's ID matches added tool's ID → display as "renamed: old_name → new_name".                             |
| **G5: Agent DSL signature vs project_tools divergence** | Snapshot has project_tools `dslContent`, agent DSL has potentially stale signature | Snapshot is authoritative (shows what was compiled). Stale signature flagged by W721 warning + stale detection banner. No snapshot change needed. |
| **G10: Rollback semantics unclear**                     | What does "restore a tool" mean? No automated mechanism.                           | v1: view-only reference. User can view snapshot DSL and manually copy. No "Restore Tool" button. Future enhancement possible.                     |

### Acceptable Trade-offs (acknowledged, no action needed)

| Gap                                 | Problem                                                                   | Accepted Because                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **G4: Multi-agent snapshot timing** | Two agents share tool, versioned at different times → different snapshots | Expected behavior. Each agent version is independent. Consistent state achieved by versioning at same time or same deployment pipeline. |
| **G6: Snapshot size growth**        | 30 tools × 200 versions = 6,000 entries                                   | Negligible storage (KB). Version list API excludes snapshots. Detail API lazy-loads. Retention policy is a future concern.              |
| **G11: Deduplication**              | Same tool state duplicated across versions                                | YAGNI. Storage is negligible. Future optimization if needed.                                                                            |
| **G12: No inter-tool dependencies** | Snapshots don't capture relationships between tools                       | Tools are independent by design. Dependencies are infrastructure-level, not snapshot-level.                                             |
