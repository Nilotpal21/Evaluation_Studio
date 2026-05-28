# DSL-Native Tools — Design Document

**Date**: 2026-02-24
**Status**: Approved Design
**Authors**: Sai Kumar Shetty + Claude (Brainstorming)
**Replaces**: `2026-02-23-dsl-native-tools-deep-analysis.md` (exploration), `2026-02-23-tool-architecture-analysis.md` (comparison)

---

## 1. Problem Statement

The ABL platform currently maintains **two parallel systems** for tool definitions:

1. **DB entities**: 3 MongoDB collections (`tools`, `tool_versions`, `tool_secrets`), 13+ API routes, 30+ UI components (~7,845 lines), slug/version resolution pipeline, `convertDbToolToIR()`
2. **DSL inline**: Tool definitions embedded directly in agent DSL with full implementation details, compiled by the parser → compiler pipeline

These two systems create:

- A dual mental model (developers must understand both)
- Sync issues between DB state and DSL state
- AI generation difficulty (`USE TOOL: slug` is opaque — AI cannot generate it)
- ~22,700 lines of code to maintain

### Goal

Consolidate to a **single system** where:

- `project_tools` (MongoDB) is the **sole source of truth** for tool implementation
- Agent DSL contains **tool signatures only** (interface, not implementation)
- Per-type **forms** are the creation/editing surface (not DSL editing)
- The **compiler** merges signatures (from agent DSL) + implementation (from project_tools) into IR

### Non-Negotiable Constraints

| Constraint                        | Detail                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| **No filesystem**                 | Fully enterprise multi-tenant platform. All data in MongoDB.                          |
| **No backward compatibility**     | Clean break. `USE TOOL:` syntax fully removed. No migration shims.                    |
| **No tool-level versioning**      | Agent versions snapshot tool state. No `tool_versions` collection.                    |
| **No inline tool implementation** | Agent DSL cannot contain implementation properties (`endpoint`, `auth`, `code`, etc.) |
| **Single creation path**          | All tools created/edited via forms → validated DSL → stored in `project_tools`        |
| **Secrets never in DSL**          | `{{secrets.X}}` and `{{env.X}}` are runtime placeholders only                         |

---

## 2. Architecture Model

### Core Principle: Interface vs Implementation

```
Agent DSL = Interface (WHAT the tool does)
  - Tool name, parameters, return type, description, tool type
  - Portable, readable, AI-generatable

project_tools = Implementation (HOW the tool works)
  - Endpoint, auth, headers, retry (HTTP)
  - Code, runtime, memory (Sandbox)
  - Server reference (MCP)
  - Created/edited via forms, stored as validated DSL string

Compiler = Merges interface + implementation → complete IR
  - Looks up project_tools by name at compile time
  - Bakes everything into ToolDefinition IR
  - Runtime has zero DB lookups for tools
```

### System Boundary Diagram

```
┌───────────────────────────── STUDIO (UI) ─────────────────────────────┐
│                                                                        │
│  ┌───────────────────┐              ┌────────────────────────────────┐ │
│  │  Tool Library       │   insert    │  Agent DSL Editor              │ │
│  │  (project_tools)    │  signature  │                                │ │
│  │                     │ ──────────→ │  TOOLS:                        │ │
│  │  Per-type forms     │             │    charge_card(amount: number, │ │
│  │  (API / Code / MCP) │             │      currency: string)         │ │
│  │                     │             │      -> {txnId: string}        │ │
│  │  DSL preview        │             │      description: "Charge..."  │ │
│  │  (read-only)        │             │      type: http                │ │
│  └──────────┬──────────┘             └──────────────┬─────────────────┘ │
│             │ save (validated)                       │ save agent DSL    │
│             ▼                                        ▼                  │
│  ┌───────────────────┐              ┌────────────────────────────────┐ │
│  │  project_tools     │              │  agent dslContent              │ │
│  │  (MongoDB)         │              │  (MongoDB)                     │ │
│  │                    │              │                                │ │
│  │  NEVER compiled    │              │  THIS gets compiled            │ │
│  │  directly          │              │                                │ │
│  └───────────────────┘              └──────────────┬─────────────────┘ │
└────────────────────────────────────────────────────┼───────────────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────┐
                          │  COMPILER                 │                  │
                          │                           ▼                  │
                          │  1. Parse agent DSL → AgentTool[] (sigs)    │
                          │  2. resolveToolImplementations()            │
                          │     → batch lookup project_tools by name   │
                          │     → parse each dslContent                │
                          │     → compile per-type bindings            │
                          │     → bake MCP server configs              │
                          │  3. compileTools() merges sig + impl       │
                          │  4. → ToolDefinition[] (complete IR)       │
                          │                                             │
                          │  DB queries: project_tools + mcp_server_   │
                          │  configs only. Nothing else.               │
                          └──────────────────────────┬─────────────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────┐
                          │  RUNTIME (unchanged)      │                  │
                          │                           ▼                  │
                          │  IR cached: Redis L2 + MongoDB L0           │
                          │  Session stores irSourceHash ref            │
                          │  {{secrets.X}} resolved at execution time   │
                          │  {{env.X}} resolved at execution time       │
                          │  HttpToolExecutor / SandboxToolExecutor /   │
                          │  McpToolExecutor — zero changes             │
                          └─────────────────────────────────────────────┘
```

### What project_tools IS and IS NOT

| project_tools IS                                 | project_tools IS NOT                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| The sole source of truth for tool implementation | A library you copy from (that was a rejected approach) |
| Queried by the compiler at compile time          | Queried at runtime (IR has everything baked)           |
| Created/edited via forms only                    | Edited via DSL text editor                             |
| Validated before every save                      | A raw data store accepting any content                 |
| One document per tool                            | A multi-tool file/bundle                               |

---

## 3. Schema

### 3.1 project_tools Collection

```typescript
interface IProjectTool {
  _id: string;
  tenantId: string;
  projectId: string;

  /** Tool name — primary identifier, used in agent DSL signatures.
   *  Must be unique within (tenantId, projectId).
   *  Format: lowercase, underscores, 2-64 chars. */
  name: string;

  /** Auto-generated slug from name at creation time.
   *  Immutable after creation. Kept for potential future use
   *  (external API references, webhook URLs). */
  slug: string;

  /** Denormalized from dslContent for fast filtering/listing.
   *  Extracted during pre-save validation. */
  toolType: 'http' | 'sandbox' | 'mcp';

  /** Denormalized from dslContent for listing display.
   *  Extracted during pre-save validation. */
  description: string | null;

  /** The validated DSL string — full tool definition including
   *  signature AND implementation. This is the source of truth.
   *  Guaranteed to parse and compile (pre-save validation gate). */
  dslContent: string;

  /** SHA-256 hash of dslContent. Used for:
   *  - Stale detection (compare with agent version snapshot)
   *  - Change detection (skip recompilation if unchanged) */
  sourceHash: string;

  createdBy: string;
  lastEditedBy: string | null;
  createdAt: Date;
  updatedAt: Date;

  /** Optimistic concurrency version counter */
  _v: number;
}
```

### 3.2 Indexes

```
{ tenantId: 1, projectId: 1, name: 1 }     — unique
{ tenantId: 1, projectId: 1, slug: 1 }     — unique
{ tenantId: 1, projectId: 1, toolType: 1 } — filter queries
```

### 3.3 Fields NOT Included (and why)

| Excluded Field                                      | Reason                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `source` (`manual` / `discovered` / `ai_generated`) | YAGNI. No system logic depends on it. Add later if analytics need it. |
| `toolNames[]`                                       | Not needed — one tool per document. Name is the tool name.            |
| `toolCount`                                         | Always 1.                                                             |
| `toolTypes[]`                                       | Not needed — single `toolType` field.                                 |
| `isPublished`                                       | No publish lifecycle. Tools are always mutable working copies.        |
| `version` / `versionPin`                            | No tool-level versioning. Agent versions handle snapshots.            |

### 3.4 Collections Deleted

| Collection      | Reason                      |
| --------------- | --------------------------- |
| `tools`         | Replaced by `project_tools` |
| `tool_versions` | No tool-level versioning    |

### 3.5 Collections Kept (unchanged)

| Collection              | Reason                                                  |
| ----------------------- | ------------------------------------------------------- |
| `tool_secrets`          | Stores encrypted `{{secrets.X}}` values, tenant-scoped  |
| `environment_variables` | Stores `{{env.X}}` values per environment               |
| `mcp_server_configs`    | MCP server infrastructure config (URL, transport, auth) |

---

## 4. DSL Specification

### 4.1 Agent DSL — Signatures Only

Tools declared in agent DSL contain **interface information only**:

```abl
AGENT: booking_assistant
  DESCRIPTION: "Helps users book hotels"
  MODEL: gpt-4

  TOOLS:
    search_hotels(city: string, dates: object) -> Hotel[]
      description: "Search available hotels in a city"
      type: http

    calculate_risk(data: object) -> {score: number, factors: string[]}
      description: "Custom risk scoring model"
      type: sandbox

    get_weather(city: string, units: string) -> object
      description: "Get current weather for a city"
      type: mcp
```

#### Allowed properties in agent DSL TOOLS section

| Property                                              | Required    | Purpose                      |
| ----------------------------------------------------- | ----------- | ---------------------------- |
| Tool name + parameters + return type (signature line) | **Yes**     | Defines the tool's interface |
| `description`                                         | Recommended | Human-readable purpose       |
| `type`                                                | **Yes**     | `http` / `sandbox` / `mcp`   |

#### Forbidden properties in agent DSL TOOLS section

The parser **rejects** these with error E720:

```
endpoint, method, headers, auth, auth_config, timeout, retry, retry_delay,
rate_limit, circuit_breaker, code, runtime,
entrypoint, memory_mb, server, server_tool
```

**Error**: `E720: Implementation property "{name}" not allowed in agent DSL. Tool implementation must be configured in Project Tools.`

#### Rationale

- Agent DSL describes **orchestration** — what tools the agent uses, how it flows, what it gathers
- Tool implementation is an **infrastructure concern** — managed via forms in project_tools
- Signatures make the DSL **portable** — readable without DB access, AI-generatable
- Implementation details would make agent DSL **large and cluttered**

### 4.2 project_tools DSL — Full Definition

Each `project_tools.dslContent` contains the **complete** tool definition: signature + implementation.

#### 4.2.1 HTTP Tool

```abl
charge_card(amount: number, currency: string) -> {txnId: string}
  description: "Charge a credit card"
  type: http
  endpoint: "{{env.PAYMENTS_URL}}/v1/charge"
  method: POST
  auth: oauth2_client
  auth_config:
    token_url: "{{env.OAUTH_TOKEN_URL}}"
    client_id: "{{env.OAUTH_CLIENT_ID}}"
    client_secret: "{{secrets.OAUTH_CLIENT_SECRET}}"
    scopes: "payments:write"
  headers:
    X-Idempotency-Key: "{{env.IDEMPOTENCY_PREFIX}}"
  timeout: 10000
  retry: 2
  retry_delay: 1000
  rate_limit: 60
  circuit_breaker:
    threshold: 5
    reset_ms: 30000
```

**HTTP Field Reference:**

| Field             | Required    | Type             | Default | Constraints                                                                            |
| ----------------- | ----------- | ---------------- | ------- | -------------------------------------------------------------------------------------- |
| `endpoint`        | **Yes**     | string           | —       | Must be a URL. Use `{{env.X}}` for environment-specific parts.                         |
| `method`          | No          | enum             | `GET`   | `GET` / `POST` / `PUT` / `PATCH` / `DELETE`                                            |
| `auth`            | No          | enum             | `none`  | `none` / `bearer` / `api_key` / `oauth2_client` / `oauth2_user` / `custom`             |
| `auth_config`     | Conditional | block            | —       | Required for `oauth2_client` and `oauth2_user`. Shape varies by auth type (see below). |
| `headers`         | No          | key-value block  | —       | Use `{{secrets.X}}` for sensitive values. Static headers sent with every request.      |
| `timeout`         | No          | number (ms)      | `30000` | Range: 1–300000 (5 min max)                                                            |
| `retry`           | No          | number           | `0`     | Range: 0–10                                                                            |
| `retry_delay`     | No          | number (ms)      | `1000`  | Only meaningful if retry > 0. Range: 0–60000                                           |
| `rate_limit`      | No          | number (per min) | —       | Requests per minute cap                                                                |
| `circuit_breaker` | No          | block            | —       | `threshold` (1-100) + `reset_ms` (1000-300000)                                         |

**auth_config keys by auth type:**

| Auth Type       | Required Keys                             | Optional Keys                        | Runtime Behavior                                                                            |
| --------------- | ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `none`          | —                                         | —                                    | No auth header added                                                                        |
| `bearer`        | —                                         | —                                    | `Authorization: Bearer {{secrets.TOOL_NAME_TOKEN}}` resolved at runtime via SecretsProvider |
| `api_key`       | —                                         | `header_name` (default: `X-API-Key`) | Secret resolved and sent in configured header                                               |
| `oauth2_client` | `token_url`, `client_id`, `client_secret` | `scopes`                             | Runtime fetches token via client credentials flow, caches per-tenant, auto-refreshes        |
| `oauth2_user`   | `provider`                                | —                                    | Delegated user token via `SecretsProvider.getUserOAuthToken()`                              |
| `custom`        | —                                         | `custom_headers` (key-value block)   | Each value resolved via `{{secrets.X}}` / `{{env.X}}` at runtime                            |

**Note**: `bearer` and `api_key` use convention-based secret resolution (`{authType}_token_{toolName}` → fallback `{authType}_token`). For explicit control, use `headers` block with `{{secrets.X}}`.

#### 4.2.2 Sandbox (Code) Tool

```abl
calculate_risk(data: object) -> {score: number, factors: string[]}
  description: "Custom risk scoring model"
  type: sandbox
  runtime: "javascript"
  memory_mb: 256
  timeout: 5000
  code: |
    // Parameters are injected as local variables.
    // 'data' is available directly from the signature.
    const score = analyzeFactors(data);
    return { score, factors: identifyFactors(data) };

    function analyzeFactors(data) {
      return 0.75;
    }

    function identifyFactors(data) {
      return ['credit_history', 'income_ratio'];
    }
```

**Sandbox Field Reference:**

| Field       | Required | Type             | Default | Constraints                             |
| ----------- | -------- | ---------------- | ------- | --------------------------------------- |
| `runtime`   | **Yes**  | enum             | —       | `"javascript"` / `"python"`             |
| `code`      | **Yes**  | multiline string | —       | Max 256KB. Uses YAML `\|` block syntax. |
| `memory_mb` | No       | number           | `128`   | Range: 128–4096                         |
| `timeout`   | No       | number (ms)      | `5000`  | Range: 100–60000 (1 min max)            |

**No `entrypoint` field.** The code executes directly. Parameters from the tool signature are injected as local variables. The script's return value is the tool's output.

**Runtime execution model:**

```javascript
// The runtime wraps user code:
(async function(param1, param2, ...) {
  // --- user code starts ---
  <code content>
  // --- user code ends ---
})(inputParam1, inputParam2, ...)
```

#### 4.2.3 MCP Tool

```abl
get_weather(city: string, units: string) -> object
  description: "Get current weather for a city"
  type: mcp
  server: "weather-service"
  server_tool: "getCurrentWeather"
```

**MCP Field Reference:**

| Field         | Required | Type   | Default         | Constraints                                                                                                                          |
| ------------- | -------- | ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `server`      | **Yes**  | string | —               | Must reference a name in `mcp_server_configs` collection. Validated at save time (server must exist before MCP tool can be created). |
| `server_tool` | No       | string | Tool's own name | The tool name as known by the MCP server. Use when the server's tool name differs from your tool name.                               |

**MCP server config** (URL, transport, auth) comes from `mcp_server_configs` collection and is **baked into IR at compile time**. It is NOT stored in the tool DSL.

### 4.3 Shared Signature Format

Both agent DSL and project_tools DSL share the same signature line format:

```
tool_name(param1: type1, param2: type2) -> return_type
```

**Parameter types**: `string`, `number`, `boolean`, `object`, `array`, or structured types like `{field: type}`, `Type[]`

**Return types**: Same as parameter types. `object` is the generic fallback.

**Description**: Always `description: "..."` — double-quoted string.

**Type**: Always `type: http | sandbox | mcp`.

---

## 5. Tool Creation & Validation

### 5.1 Three Creation Paths (Same Validation)

| Path               | Flow                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Per-type Forms** | User fills form → `serializeToolFormToDsl()` → `validateToolDsl()` → save            |
| **MCP Discovery**  | Discover tools from server → auto-generate DSL per tool → `validateToolDsl()` → save |
| **AI (Arch)**      | AI calls `create_tool` with generated DSL → `validateToolDsl()` → save               |

All three paths converge on the same validation gate. Nothing is saved without passing.

### 5.2 Form → DSL Serialization (One-Way)

Forms are the editing surface. DSL is a read-only preview generated from form state.

```
┌──────────────┐   serialize    ┌──────────────┐
│   Form       │ ─────────────→ │  DSL Preview │
│  (editable)  │                │  (read-only) │
└──────────────┘                └──────────────┘
```

- **No DSL → Form direction** (no bidirectional sync)
- **No raw DSL editing** of tools (forms only)
- Developer escape hatch: "Copy DSL" button to copy generated DSL to clipboard

**`serializeToolFormToDsl(state: ToolFormState): string`** — the serializer produces valid DSL from form fields. The DSL preview updates in real-time as the user fills in the form.

### 5.3 Pre-Save Validation Pipeline

```typescript
function validateToolDsl(dslContent: string): ValidateToolDslResult;
```

**Five validation phases, all must pass:**

| Phase                         | What                                       | Errors                             |
| ----------------------------- | ------------------------------------------ | ---------------------------------- |
| **1. Parse**                  | Parse DSL string → AST                     | E730: Parse error                  |
| **2. Structural**             | Name exists, type is valid                 | E731: No name. E732: Invalid type. |
| **3. Type-specific bindings** | Per-type required fields present and valid | E733–E750 (see §5.4)               |
| **4. Security**               | No plaintext secrets in DSL                | E760: Potential plaintext secret   |
| **5. Trial compilation**      | Compile to IR — proves it works            | E739: Compilation error            |

**If ANY phase fails → save is REJECTED. Errors returned to UI.**

**If ALL phases pass → extracted metadata returned:**

- `name`, `description`, `toolType`, `sourceHash`
- These populate the denormalized fields on `project_tools`

### 5.4 Error Codes — Tool Validation

#### Parse Errors

| Code | Message                                          |
| ---- | ------------------------------------------------ |
| E730 | `Parse error: {details}`                         |
| E731 | `Tool must have a name`                          |
| E732 | `Tool must declare type: http \| sandbox \| mcp` |

#### HTTP Binding Errors

| Code | Message                                          | Condition                                                |
| ---- | ------------------------------------------------ | -------------------------------------------------------- |
| E733 | `HTTP tool must have endpoint`                   | Missing `endpoint`                                       |
| E734 | `Invalid HTTP method: "{value}"`                 | Not GET/POST/PUT/PATCH/DELETE                            |
| E735 | `Invalid auth type: "{value}"`                   | Not none/bearer/api_key/oauth2_client/oauth2_user/custom |
| E736 | `auth_config is required for auth type "{type}"` | Missing auth_config for oauth2_client or oauth2_user     |
| E737 | `retry must be 0-10`                             | Out of range                                             |
| E738 | `timeout must be 1-300000`                       | Out of range                                             |

#### Sandbox Binding Errors

| Code | Message                                    | Condition             |
| ---- | ------------------------------------------ | --------------------- |
| E740 | `Sandbox tool must have runtime and code`  | Missing binding       |
| E741 | `runtime must be "javascript" or "python"` | Invalid runtime       |
| E742 | `Sandbox tool must have code content`      | Empty or missing code |
| E743 | `Code exceeds 256KB limit ({size}KB)`      | Code too large        |
| E745 | `memory_mb must be 128-4096`               | Out of range          |

#### MCP Binding Errors

| Code | Message                               | Condition        |
| ---- | ------------------------------------- | ---------------- |
| E750 | `MCP tool must have server reference` | Missing `server` |

#### Security Errors

| Code | Message                                                                   | Condition                                                  |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| E760 | `Potential plaintext secret in {path}. Use {{secrets.NAME}} placeholder.` | Detects raw API keys, tokens, base64 secrets in DSL values |

#### Compilation Errors

| Code | Message                        | Condition                |
| ---- | ------------------------------ | ------------------------ |
| E739 | `Compilation error: {details}` | Trial compilation failed |

#### Warnings (non-blocking)

| Code | Message                                    | Condition            |
| ---- | ------------------------------------------ | -------------------- |
| W730 | `Tool has no parameters`                   | Empty parameter list |
| W731 | `No timeout set — defaults to {default}ms` | Missing timeout      |

### 5.5 Backend Architecture

#### Service Layer (in `packages/shared/`)

Three-layer architecture:

```
ProjectToolService          — orchestrates validator + serializer + repository + business logic
  ├── ProjectToolValidator  — 5-phase validation pipeline (business rules)
  ├── serializeToolFormToDsl()  — structured form data → DSL string
  └── ProjectToolRepository — pure DB operations (Mongoose model)
```

**Mongoose model** handles structural validation (required fields, type enforcement, enum for `toolType`).
**ProjectToolValidator** handles business validation (name format, DSL parsing, type-specific rules, secret detection, trial compile).

#### Data Flow

Studio sends **raw form data** (structured fields). Server serializes to DSL, validates, and saves.

```
Studio Form → { name, toolType, description, endpoint, method, headers, ... }
  → ProjectToolService.create(formData)
    → ProjectToolValidator.validate(formData)     // 5-phase validation, all errors collected
    → serializeToolFormToDsl(formData)             // structured → DSL string
    → compute sourceHash (SHA-256 of dslContent)
    → ProjectToolRepository.create({ name, toolType, description, dslContent, sourceHash, ... })
    → return full tool document
```

**Why server-side serialization?**

- Single source of truth for DSL serialization logic (not duplicated in studio client)
- Validation pipeline runs on same machine — no roundtrip
- AI/Arch also sends structured data — same service handles it
- Studio form never needs to know DSL syntax

#### API Routes (Studio-only, mounted via Next.js)

```
POST   /api/projects/:projectId/tools            — create tool
GET    /api/projects/:projectId/tools             — list tools (summary by default, ?include=dslContent for full)
GET    /api/projects/:projectId/tools/:id         — get tool detail (full document)
PUT    /api/projects/:projectId/tools/:id         — update tool (full replace, all fields)
DELETE /api/projects/:projectId/tools/:id         — without ?force=true: returns impacted agents; with ?force=true: hard delete
```

**Routes live in studio** (`apps/studio/src/app/api/`), service logic in `packages/shared/`. Runtime does NOT expose tool CRUD — it only reads `project_tools` at compilation time via the shared repository.

#### Create Flow

1. Studio sends structured form data: `{ name, toolType, description, ...typeSpecificFields }`
2. `ProjectToolService.create()`:
   a. `ProjectToolValidator.validate(formData)` → all errors collected, return all at once
   b. `serializeToolFormToDsl(formData)` → generates DSL string
   c. Check name uniqueness within `(tenantId, projectId)` — reject with error if exists
   d. `ProjectToolRepository.create({ dslContent, sourceHash, denormalized fields, ... })`
3. Return `{ success: true, tool: { ...full document } }`

#### Update Flow

1. Studio sends ALL form fields (full replace, not partial): `{ name, toolType, description, ...typeSpecificFields }`
2. `ProjectToolService.update(id, formData)`:
   a. Validate (same pipeline as create)
   b. Re-serialize to DSL
   c. If name changed → just update the tool document (no auto-update of agents referencing old name — they'll get E721 at next compile)
   d. Full replace: `ProjectToolRepository.update(id, { ...allFields })`
3. Return `{ success: true, tool: { ...full document } }`
4. **No concurrency protection** — last write wins. `_v` field exists on schema but is not checked.

#### Delete Flow (Single Endpoint with Force Flag)

1. Studio calls `DELETE /tools/:id` (no force flag) → returns `{ impactedAgents: ['agent_a', 'agent_b'] }` — does NOT delete
2. Studio shows confirmation dialog with impacted agent list
3. User confirms → Studio calls `DELETE /tools/:id?force=true` → hard delete from MongoDB
4. Return `{ success: true }`
5. Agents referencing the deleted tool will fail with E721 at next compilation

#### List Flow

1. `GET /tools?toolType=http&search=verify&include=dslContent`
2. Returns **summary by default**: `{ id, name, toolType, description, sourceHash, createdAt, updatedAt }`
3. With `?include=dslContent`: returns full documents including `dslContent`
4. Supports: pagination (`page`, `limit`), filtering (`toolType`), search (`search` on name), sorting (`sort`, `order`)

#### Validation Error Response

All errors collected across all validation phases, returned at once:

```json
{
  "success": false,
  "errors": [
    { "code": "E733", "field": "endpoint", "message": "HTTP tool must have endpoint" },
    {
      "code": "E760",
      "field": "headers.Authorization",
      "message": "Potential plaintext secret. Use {{secrets.NAME}} placeholder."
    }
  ]
}
```

#### Trial Compile Phase (Phase 5)

The strictest validation — parse + compile binding + verify external references:

- Parse DSL → AST
- Compile type-specific binding (HttpBindingIR, SandboxBindingIR, McpBindingIR)
- **MCP tools**: Verify server exists in `mcp_server_configs` at save time (not just compile time)
- If any step fails → E739 error collected with details

**Implication for MCP tools**: MCP server must exist before MCP tool creation. The MCP form's server picker dropdown only shows existing servers from `mcp_server_configs`.

### 5.6 MCP Discovletry → project_tools

```
Discover tools from MCP server
  ↓
For EACH discovered tool:
  ↓
Auto-generate DSL:
  get_weather(city: string, units: string) -> object
    description: "Get current weather"
    type: mcp
    server: "weather-service"
    server_tool: "getCurrentWeather"   # if server name differs
  ↓
validateToolDsl(generatedDsl) → must pass
  ↓
Create project_tools entry
```

Each discovered tool = one separate `project_tools` entry.

---

## 6. Tool Linking to Agents

### 6.1 Three Linking Paths

#### Path A: Inline Combobox Picker (recommended)

The agent editor's visual tools section includes an inline combobox (tag-picker style). User types to search, selects tools, signatures are appended to the TOOLS section.

```
Agent Editor → tools section → combobox input
  → user types "charge" → filtered list appears
  → each item shows: name, type badge, description, "already linked" indicator
  → user selects "charge_card" (and optionally more — multi-select supported)
  → extractSignatureFromDsl(tool.dslContent) generates signature per tool
  → signatures appended to end of agent DSL TOOLS section
  → if no TOOLS section exists, one is auto-created
```

**`extractSignatureFromDsl(dslContent: string): string`** — parses full DSL, outputs signature-only DSL (name, params, returns, description, type).

**Picker item display:**

```
┌─────────────────────────────────────────────────┐
│ 🔍 Search tools...                               │
├─────────────────────────────────────────────────┤
│ charge_card  [HTTP]  ✓ linked                    │
│ Charge a credit card via Stripe                  │
├─────────────────────────────────────────────────┤
│ verify_email  [HTTP]                             │
│ Verify if an email address is valid              │
├─────────────────────────────────────────────────┤
│ calculate_risk  [Sandbox]                        │
│ Custom risk scoring model                        │
└─────────────────────────────────────────────────┘
```

- Already-linked tools show a check indicator and are visually dimmed
- Multi-select: user can pick several tools before closing the picker
- Each selection appends a signature to the end of the TOOLS section

#### Path B: Manual Typing (developer escape hatch)

```
Developer types in agent DSL editor:
  charge_card(amount: number, currency: string) -> {txnId: string}
    description: "Charge a credit card"
    type: http
```

**Linting**: On save or blur (not real-time keystroke), the editor checks tool names against project_tools. Unknown names appear in a problems panel.

**Inline action for unknown tools:**

```
┌──────────────────────────────────────────────────┐
│ ⚠ "foo_bar" not found in project tools            │
│                                                    │
│ [Create Tool]  [Ignore]                            │
└──────────────────────────────────────────────────┘
```

"Create Tool" → opens per-type form pre-filled with signature data extracted from the typed DSL (name, params, returns, description, type).

#### Path C: AI (Arch) Generation

```
AI workflow:
  1. AI creates tools in project_tools (via create_tool Arch tool)
  2. AI generates agent DSL with tool signatures
  3. Compiler validates all tool names exist
```

AI can also generate agent DSL with signatures for tools that don't exist yet → user is prompted to create them.

### 6.2 Linking is Type-Agnostic

The linking workflow is **identical for all tool types**. Type badge shows in the picker for visual distinction, but the insertion mechanism is the same: extract signature → append to TOOLS section.

Type-specific behavior exists only in: creation forms, validation, compilation, execution.

### 6.3 Visual Tools Section

Linked tools are displayed as **compact pill-style tags** in the agent editor's tools section:

```
TOOLS ──────────────────────────────────────────
  [charge_card HTTP] [verify_email HTTP] [calculate_risk Sandbox]
  [search_docs MCP ⚠ stale]
  [+ Add Tool ▾]
```

Each pill shows:

- Tool name
- Type badge (colored by type: HTTP, Sandbox, MCP)
- Stale indicator (if project_tool has changed since agent DSL signature was last synced)

**Actions per pill:**

- Click → navigates to tool detail page (view mode)
- Remove (×) → confirmation: "Remove {name} from this agent? The tool will remain in your library."

**Stale tools** additionally show:

- Stale badge (warning indicator)
- "Update Signature" button → replaces the signature block **in-place** in the TOOLS section (preserving position)

### 6.4 Unlinking

Two paths to unlink:

1. **Visual tools section**: Click × on a tool pill → confirmation dialog → signature block removed from DSL
2. **Raw DSL editor**: User manually deletes the tool signature text → valid unlink, no confirmation needed (deliberate text edit)

In both cases, the `project_tools` entry is NOT deleted — it remains in the library for other agents.

### 6.5 Constraints

| Constraint                 | Detail                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| Max 100 tools per agent    | Parser rejects if TOOLS section exceeds 100 tool definitions          |
| No duplicate names         | Parser rejects duplicate tool names within same agent's TOOLS section |
| TOOLS section auto-created | If no TOOLS section exists when linking via picker, one is created    |

---

## 7. Compilation Pipeline

### 7.1 Overview

```
Agent DSL (signatures)     project_tools (implementations)
         │                            │
         ▼                            │
    Parse agent DSL                   │
    → AgentTool[] (no bindings)       │
         │                            │
         ▼                            │
    resolveToolImplementations()  ←───┘    [packages/shared/]
    → batch lookup by name                 │
    → check Redis cache by sourceHash      │
    → parse uncached dslContent → AST      │  ← Promise.all (parallel)
    → compile per-type bindings            │
    → batch-load mcp_server_configs        │
    → bake MCP server configs              │
    → cache parsed results by sourceHash   │
    → ResolvedToolImpl[]                   │
         │                                 │
         ▼                                 │
    compileTools(doc, resolvedImpls)        │  [packages/compiler/]
    → merge signature + implementation     │
    → W721 field-by-field comparison       │
    → ToolDefinition[] (complete IR)       │
         │                                 │
         ▼                                 │
    AgentIR (with full tool bindings)
```

**Architecture**: `resolveToolImplementations()` lives in `packages/shared/` (reusable by studio and runtime). The compiler (`packages/compiler/`) is a **pure function** — no DB access. The caller resolves tools and passes results via `CompilerOptions`.

### 7.2 Step 1: Parse Agent DSL

Parser produces `AgentTool[]` with **signatures only**:

```typescript
// Parser output — NO httpBinding, mcpBinding, sandboxBinding
interface AgentTool {
  name: string;
  description?: string;
  parameters: ToolParam[];
  returns: ToolReturn;
  type?: 'http' | 'sandbox' | 'mcp';
  // Binding fields are ABSENT — parser rejects implementation properties
}
```

**Parser enforcement**: If `endpoint:`, `method:`, `headers:`, `auth:`, `auth_config:`, `code:`, `server:`, `runtime:`, etc. appear in agent DSL TOOLS section → emit `E720`.

### 7.3 Step 2: Resolve Tool Implementations

**New function replacing `resolveToolLinks()`, located in `packages/shared/`:**

```typescript
interface ResolveToolImplInput {
  tenantId: string;
  projectId: string;
  toolsByAgent: Map<string, string[]>; // agent name → tool names from DSL
}

interface ResolveToolImplResult {
  resolvedByAgent: Map<string, ResolvedToolImpl[]>;
  errors: ValidationDiagnostic[]; // E721, E722, E725 — all collected
  warnings: ValidationDiagnostic[]; // W726 (code size warning)
}

interface ResolvedToolImpl {
  name: string;
  toolType: 'http' | 'sandbox' | 'mcp';
  projectToolId: string;
  sourceHash: string;
  // Compiled binding (exactly one set):
  httpBinding?: HttpBindingIR;
  sandboxBinding?: SandboxBindingIR;
  mcpBinding?: McpBindingIR;
}
```

**Resolution logic:**

1. Collect unique tool names across all agents
2. **Single batch DB query**: `project_tools.find({ name: { $in: names }, tenantId, projectId })`
3. For each resolved tool, check **Redis cache** by `sourceHash`:
   - Cache hit → use cached `ResolvedToolImpl` (skip parse + compile)
   - Cache miss → proceed to step 4
4. Parse each uncached `project_tools.dslContent` → full AST (**in parallel** via `Promise.all`)
5. Compile per-type bindings from parsed AST in parallel (reuse existing `compileHttpBinding()`, `compileSandboxBinding()`, `compileMcpBinding()`)
6. For MCP tools: **batch-load** `mcp_server_configs` (single `$in` query for all unique server names), bake full server config into `McpBindingIR`
7. For sandbox tools: if `code_content` exceeds 64KB, emit warning W726
8. Cache newly parsed results in Redis by `sourceHash` (content-addressed — natural invalidation on tool update)
9. **Collect all errors** — if any tool fails (E721 not found, E722 server missing, E725 corrupt DSL), collect the error and continue resolving remaining tools. Return all errors at once.

**Error handling**: All errors are collected, never fail-fast. The caller decides whether to abort (deploy) or continue with partial results (studio preview).

### 7.4 Step 3: Compile Tools (Merge)

```typescript
function compileTools(doc: AgentBasedDocument, resolvedImpls: ResolvedToolImpl[]): ToolDefinition[];
```

For each tool in `doc.tools`:

1. **project_tools is authoritative** — compiler uses project_tools data for parameters, returns, description, and all bindings
2. Agent DSL signature is **informational only** — not used for IR generation
3. **W721 staleness check** — field-by-field comparison of agent DSL signature vs project_tools:
   - Parameters: compare names, types, and count
   - Returns: compare return type
   - Description: compare description text
   - If any field differs → emit `W721`
4. If tool not found in `resolvedImpls` → error already emitted in Step 2

### 7.5 Step 4: Agent IR Assembly

```typescript
// In compileAgentToIR():
tools: [...compileTools(doc, resolvedImpls), ...compileSystemTools(doc)];
```

System tools (`handoff`, `delegate`, `escalate`, `complete`) are unchanged — compiler-injected, not from project_tools.

### 7.6 Compilation Modes

Two modes depending on caller context:

| Mode                                  | Caller                         | Behavior on tool errors                                                                                  |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Strict** (deploy/version creation)  | Studio deploy handler, runtime | All tools must resolve. Any E721/E722/E725 → compilation fails, no IR produced.                          |
| **Preview** (studio topology/editing) | Studio topology API            | Compile what resolves, flag missing tools as errors in response. Partial IR usable for preview/topology. |

```typescript
interface CompilerOptions {
  // ... existing fields ...
  resolvedToolImplementations?: Map<string, ResolvedToolImpl[]>;
  compilationMode?: 'strict' | 'preview'; // default: 'strict'
}
```

### 7.7 W721 Warning Threshold

W721 warnings are **non-blocking by default**. A configurable threshold promotes warnings to errors:

```typescript
interface CompilerOptions {
  // ... existing fields ...
  staleSignatureThreshold?: number; // 0-1, e.g., 0.5 = 50%. Default: undefined (disabled)
}
```

If `staleSignatureThreshold` is set and the proportion of stale tools exceeds the threshold, compilation fails with an error: `"Too many stale tool signatures (N/M exceed threshold of X%). Update signatures or raise threshold."`

### 7.8 Compilation Error Codes

| Code | Phase   | Message                                                                              |
| ---- | ------- | ------------------------------------------------------------------------------------ |
| E720 | Parse   | `Implementation property "{name}" not allowed in agent DSL`                          |
| E721 | Resolve | `Tool "{name}" not found in project tools`                                           |
| E722 | Resolve | `MCP server "{server}" not found for tool "{name}"`                                  |
| E725 | Resolve | `Failed to parse project tool "{name}": {details}`                                   |
| E726 | Compile | `Too many stale tool signatures (N/M exceed threshold)`                              |
| E727 | Resolve | `Compilation timeout exceeded ({timeout}ms)`                                         |
| W721 | Compile | `Tool "{name}" signature in agent DSL differs from project tool. Consider updating.` |
| W726 | Resolve | `Sandbox tool "{name}" code exceeds 64KB ({size}KB). Consider optimizing.`           |

### 7.9 Compilation Timeout

Compilation has a **configurable timeout** (default: 30 seconds). If `resolveToolImplementations()` + `compileABLtoIR()` exceeds the timeout, abort with `E727`.

```typescript
interface CompilerOptions {
  // ... existing fields ...
  compilationTimeoutMs?: number; // default: 30000
}
```

Typical compilation with 50 tools: <5 seconds. The 30s timeout is a safety net for edge cases (slow DB, large sandbox code, network issues).

### 7.10 Caching Strategy

Parsed tool AST and compiled bindings are cached in **Redis** by `sourceHash`:

```
Key:    tool_compiled:{sourceHash}
Value:  JSON serialized ResolvedToolImpl (minus projectToolId — that's per-query)
TTL:    24 hours
```

**Why sourceHash works**: Content-addressed. Any pod builds the same cache entry for the same tool content. Tool update changes `sourceHash` → cache miss → re-parse. No explicit invalidation needed. Old cache entries expire via TTL.

**Cache flow during resolution:**

1. Batch DB query returns N tools with their `sourceHash` values
2. `MGET tool_compiled:{hash1} tool_compiled:{hash2} ...` — single Redis roundtrip
3. Cache hits → use directly. Cache misses → parse + compile in parallel → `MSET` back to Redis.

### 7.11 CompilerOptions Changes

```typescript
interface CompilerOptions {
  version?: string;
  optimize_for?: 'voice' | 'digital' | 'workflow';
  include_source_maps?: boolean;
  coordination_defaults?: ProjectCoordinationDefaults;
  config_variables?: Record<string, string>;

  // NEW — replaces resolvedToolLinks
  resolvedToolImplementations?: Map<string, ResolvedToolImpl[]>;

  // NEW — compilation behavior
  compilationMode?: 'strict' | 'preview'; // default: 'strict'
  staleSignatureThreshold?: number; // 0-1, default: undefined (disabled)
  compilationTimeoutMs?: number; // default: 30000

  // REMOVED: resolvedToolLinks (deleted with USE TOOL: syntax)
}
```

### 7.12 What the Compiler Produces (unchanged)

The output `ToolDefinition` IR is **identical** to today:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: ToolHints;
  system?: boolean;
  tool_type?: 'http' | 'mcp' | 'sandbox';
  http_binding?: HttpBindingIR;
  mcp_binding?: McpBindingIR;
  sandbox_binding?: SandboxBindingIR;
}
```

Runtime executors work on this IR. They are completely unaffected by this change.

### 7.13 Concurrent Compilation

No distributed locks. Compilation is **stateless and idempotent** — reads DB, produces IR. Two concurrent compilations for the same agent both produce valid (possibly different) IR. Last write to IR cache wins. This is safe because:

- Compilation is read-only relative to `project_tools`
- Output is deterministic per input (same tools + same DSL = same IR)
- IR cache uses content-addressed keys — identical compilations produce identical cache entries

---

## 8. IR Binding Types

### 8.1 HttpBindingIR (unchanged)

```typescript
interface HttpBindingIR {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: {
    type: ToolAuthTypeIR;
    config?: {
      headerName?: string;
      headerPrefix?: string;
      queryParam?: string;
      oauth?: { tokenUrl: string; clientId: string; scopes: string[] };
      provider?: string;
      customHeaders?: Record<string, string>;
    };
  };
  timeout_ms?: number;
  retry?: { count: number; delay_ms: number };
  rate_limit_per_minute?: number;
  circuit_breaker?: { threshold: number; reset_ms: number };
  headers?: Record<string, string>;
}
```

### 8.2 SandboxBindingIR (modified — removed entrypoint)

```typescript
interface SandboxBindingIR {
  runtime: 'javascript' | 'python';
  // REMOVED: entrypoint — code executes directly, params injected as locals
  timeout_ms?: number;
  memory_mb?: number;
  code_content?: string;
}
```

**Breaking change**: `entrypoint` removed. `SandboxToolExecutor` must be updated to wrap code with parameter injection instead of calling a named function.

### 8.3 McpBindingIR (unchanged)

```typescript
interface McpBindingIR {
  server: string;
  tool: string;
  server_config?: {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    encrypted_env?: string;
    connection_timeout_ms?: number;
    request_timeout_ms?: number;
    allowed_commands?: string[];
    encrypted_auth_config?: string;
    auth_type?: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials';
  };
}
```

### 8.4 Runtime Auth Handling

Auth configuration is baked into the IR at compile time. At runtime, executors resolve credentials and execute auth flows with zero DB lookups.

#### HTTP Tool Auth (Full Model)

The `HttpToolExecutor` reads `HttpBindingIR.auth.type` and dispatches per-type handling:

| Auth Type       | Runtime Behavior                                                                                                                    | Secret Resolution                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `none`          | No auth header added                                                                                                                | —                                                                                                    |
| `bearer`        | `Authorization: Bearer <token>`                                                                                                     | `SecretsProvider` resolves token via convention: `bearer_token_{toolName}` → fallback `bearer_token` |
| `api_key`       | Secret sent in configured header (default: `X-API-Key`)                                                                             | `SecretsProvider` resolves via convention: `api_key_{toolName}` → fallback `api_key`                 |
| `oauth2_client` | Client credentials flow: fetch token from `token_url` using `client_id` + `client_secret`, cache per-tenant, auto-refresh on expiry | `client_secret` resolved via `{{secrets.X}}`. Token cached in-memory with TTL.                       |
| `oauth2_user`   | Delegated user token: `SecretsProvider.getUserOAuthToken(provider)` returns user's OAuth token for the configured provider          | Token managed by the identity layer, not the tool system                                             |
| `custom`        | Each `custom_headers` value resolved via `{{secrets.X}}` / `{{env.X}}`                                                              | Standard placeholder resolution                                                                      |

**SecretsProvider resolution chain** (multi-layer, per credential):

1. Session cache (in-memory, per-execution)
2. DB `ToolSecret` (AES-256-GCM encrypted, tenant-scoped)
3. IR credentials (baked at compile time from `auth_config`)
4. Environment variables (`{{env.X}}` resolved from `environment_variables` collection)

**Static headers** (`headers` block) are resolved independently — each value goes through `{{secrets.X}}` / `{{env.X}}` placeholder resolution. These are sent alongside any auth-type headers.

#### MCP Tool Auth

MCP tool auth is handled at the **server level**, not per-tool. Auth config lives in `mcp_server_configs` and is baked into `McpBindingIR.server_config` at compile time.

| Auth Type                   | Runtime Behavior                              |
| --------------------------- | --------------------------------------------- |
| `none`                      | No auth                                       |
| `bearer`                    | Bearer token sent with MCP requests           |
| `api_key`                   | API key sent in configured header             |
| `custom_headers`            | Key-value headers sent with each request      |
| `oauth2_client_credentials` | Client credentials flow for MCP server access |

The `McpToolExecutor` reads `server_config.auth_type` + `server_config.encrypted_auth_config` and applies auth before each MCP call. Auth config is encrypted at rest in `mcp_server_configs` via `encrypted_auth_config` field.

#### Sandbox Tool Auth

Sandbox tools have **no auth model**. They execute in isolated gVisor containers with:

- No outbound network access (by design)
- No access to secrets or environment variables
- Parameters injected as local variables
- Return value is the tool output

If a sandbox tool needs data from an authenticated source, the agent flow should call an HTTP/MCP tool first and pass the result to the sandbox tool as a parameter.

#### Auth in DSL vs IR

| Concern         | DSL (project_tools)                       | IR (compiled)                      | Runtime                               |
| --------------- | ----------------------------------------- | ---------------------------------- | ------------------------------------- |
| Auth type       | `auth: oauth2_client`                     | `auth.type: 'oauth2_client'`       | Dispatch to OAuth2 handler            |
| Credentials     | `{{secrets.OAUTH_CLIENT_SECRET}}`         | Placeholder preserved              | `SecretsProvider` resolves            |
| Token URL       | `{{env.OAUTH_TOKEN_URL}}`                 | Placeholder preserved              | Resolved from `environment_variables` |
| Static headers  | `headers: { X-Custom: "value" }`          | `headers: { "X-Custom": "value" }` | Sent with request                     |
| MCP server auth | Not in tool DSL (in `mcp_server_configs`) | `server_config.auth_type`          | `McpToolExecutor` applies             |

---

## 9. UI/UX Design

### 9.1 Tool Library Page

Replace the current 3-tab ToolsListPage with a unified **list view** (one tool per row):

```
┌─────────────────────────────────────────────────────┐
│  Project Tools                        [+ New Tool]    │
│                                                       │
│  ┌─ Search ──────────────┐  ┌─ Filter ─┐ ┌─Sort─┐   │
│  │ 🔍 Search tools...    │  │ All ▼    │ │ Last │   │
│  └───────────────────────┘  └──────────┘ └──────┘   │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │ 🌐 charge_card                         HTTP    │   │
│  │ Charge a credit card                           │   │
│  │ Updated 2h ago • Used by 3 agents              │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │ ⚡ calculate_risk                    Sandbox   │   │
│  │ Custom risk scoring model                      │   │
│  │ Updated 1d ago • Used by 1 agent               │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │ 🔌 get_weather                         MCP     │   │
│  │ Get current weather for a city                 │   │
│  │ Updated 3d ago • Used by 2 agents              │   │
│  └────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Features**:

- **Search**: Server-side, matches name + description (`?search=`)
- **Filter**: Type dropdown (All / HTTP / Sandbox / MCP) — server-side (`?type=`)
- **Sort**: Default is last modified (most recent first), sortable by name (alphabetical)
- **No pagination** for v1 — load all tools, rely on search/filter
- **"Used by N agents" count** on each row — gives immediate blast radius visibility

**Click behavior**: Clicking a tool row navigates to tool detail page (`/tools/:id`)

### 9.2 Empty State

When a project has zero tools:

```
┌─────────────────────────────────────────────────────┐
│  Project Tools                        [+ New Tool]    │
│                                                       │
│              ┌───────────┐                            │
│              │  [icon]   │                            │
│              │  No tools │                            │
│              │   yet     │                            │
│              └───────────┘                            │
│                                                       │
│        No tools yet. Create your first tool.          │
│                                                       │
│                 [+ New Tool]                          │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### 9.3 Tool Type Picker (Dialog)

"New Tool" opens a **dialog** with type selector and name field:

```
┌─────────────────────────────────────────────────────┐
│  Create New Tool                               [X]   │
│                                                       │
│  Tool Name                                            │
│  ┌──────────────────────────────────────────────┐    │
│  │ verify_email                                  │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  Tool Type                                            │
│  ○ API Tool    — Connect to an external API endpoint  │
│  ● Code Tool   — Write custom logic in JS or Python   │
│  ○ MCP Tool    — Import from an MCP server            │
│                                                       │
│                          [Cancel]  [Create]            │
└─────────────────────────────────────────────────────┘
```

User enters name + selects type → "Create" navigates to the per-type **stepped wizard form**.

### 9.4 Tool Detail Page (with Inline Editing)

Route: `/tools/:id`

The detail page has two modes: **View** (default) and **Edit** (inline).

#### View Mode

```
┌─────────────────────────────────────────────────────┐
│  ← Back to Library                          [Edit]    │
│                                                       │
│  charge_card                                 HTTP     │
│  Charge a credit card                                 │
│  Updated 2h ago by user@example.com                   │
│                                                       │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                       │
│  DSL Preview                                ▼ Expand   │
│  ┌───────────────────────────────────────────────┐   │
│  │ charge_card(amount: number, ...) -> object    │   │
│  │   type: http                                  │   │
│  │   endpoint: "https://api.stripe.com/..."      │   │
│  │   ...                                         │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  Used By                                              │
│  • booking_agent  (v1.2 active)                       │
│  • payment_agent  (v2.0 active)                       │
│  • refund_agent   (v1.5 draft)                        │
│                                                       │
└─────────────────────────────────────────────────────┘
```

[Edit] button transitions to **edit mode** (inline overlay).

#### Edit Mode

The wizard form overlays the detail view — no separate `/tools/:id/edit` route.

```
┌─────────────────────────────────────────────────────┐
│  ← Cancel                                    [Save]    │
│                                                       │
│  Edit Tool: charge_card                               │
│                                                       │
│  Step 2 of 5: Endpoint                                │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  Step 1: Basics  ✓                                    │
│  Step 2: Endpoint  ●  ← Current                       │
│  Step 3: Authentication                               │
│  Step 4: Parameters & Response                        │
│  Step 5: Advanced                                     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                       │
│  Endpoint URL                                         │
│  ┌──────────────────────────────────────────────┐    │
│  │ https://api.stripe.com/v1/charges             │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  Method                                               │
│  ○ GET  ● POST  ○ PUT  ○ PATCH  ○ DELETE              │
│                                                       │
│  Headers (optional)                        [+ Add]     │
│  ┌──────────────────────────────────────────────┐    │
│  │ Content-Type: application/json                │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│                          [Back]  [Next]               │
│                                                       │
│  ▶ DSL Preview (collapsed)                            │
│                                                       │
└─────────────────────────────────────────────────────┘
```

**Validation**: Per-step. [Next] button validates the current step. If errors exist, they're shown inline and [Next] is disabled until fixed. No end-of-form validation — by the time you reach [Save] on the final step, all previous steps are guaranteed valid.

**Step indicator**: Clickable step names at the top. Current step highlighted. Completed steps show checkmark. Future steps are dimmed.

### 9.5 Per-Type Wizard Forms

Each tool type uses a **stepped wizard** (multi-step form with Next/Back navigation).

**HTTP Tool wizard steps:**

1. **Basics** — Name, description
2. **Endpoint** — URL (`endpoint`), method (GET/POST/PUT/DELETE/PATCH), headers (key-value editor for custom/static headers)
3. **Authentication** — Auth type selector (`none` / `bearer` / `api_key` / `oauth2_client` / `oauth2_user` / `custom`), type-specific `auth_config` fields (token_url, client_id, client_secret, scopes for OAuth2; header_name for api_key; etc.)
4. **Parameters & Response** — Input parameters (name, type, required), return type
5. **Advanced** — Timeout, retry, retry_delay, rate_limit, circuit_breaker (all optional, collapsed by default)

**Sandbox Tool wizard steps:**

1. **Basics** — Name, description
2. **Runtime & Code** — Runtime selector (JavaScript / Python), code editor
3. **Parameters & Response** — Input parameters, return type
4. **Advanced** — Timeout, memory_mb (optional)

**MCP Tool wizard steps:**

1. **Basics** — Name, description
2. **Server & Tool** — Server picker (dropdown from `mcp_server_configs`, must exist first), server_tool name (auto-populated from discovery or manual entry)
3. **Parameters & Response** — Input parameters, return type (auto-populated from discovery if available)

All wizards include:

- **Collapsible DSL preview** (collapsed by default, expandable via toggle)
- **[Save] button on final step** (no validation needed — per-step validation ensures all fields valid)
- **[Back] / [Next] navigation** between steps

### 9.6 Delete Confirmation

When user clicks delete, the system checks for impacted agents:

```
┌─────────────────────────────────────────────┐
│  Delete "charge_card"?                 [X]   │
│                                              │
│  This tool is used by 3 agents:              │
│  • booking_agent                             │
│  • payment_agent                             │
│  • refund_agent                              │
│                                              │
│  Deleting will cause E721 errors on next     │
│  compile for these agents.                   │
│                                              │
│              [Cancel]  [Delete]               │
└─────────────────────────────────────────────┘
```

**No type-to-confirm** — tools are recoverable from agent version snapshots.

### 9.7 Loading & Error States

**Loading** (initial page load):

- Skeleton rows matching list layout (shimmer effect)
- 3-5 skeleton rows with name, badge, description placeholders

**Error** (failed to load):

```
┌─────────────────────────────────────────────────────┐
│  Project Tools                        [+ New Tool]    │
│                                                       │
│              ┌───────────┐                            │
│              │  [error]  │                            │
│              └───────────┘                            │
│                                                       │
│        Failed to load tools.                          │
│                                                       │
│                 [Try Again]                           │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### 9.8 Responsive & Accessibility

**Responsive**: Desktop-only, minimum 1280px width. No mobile responsive behavior for v1.

**Accessibility**:

- Semantic HTML (`<main>`, `<nav>`, `<button>`, `<input>`)
- Keyboard navigation for major actions (focus visible, tab order)
- Focus management on dialogs (trap focus, restore on close)
- ARIA labels on icon buttons
- **No full WCAG 2.1 AA** for v1 — just the basics

---

## 10. Agent Version Snapshots

### 10.1 Design Rationale

There is **no tool-level versioning** and **no publishing concept** for tools. Tools in `project_tools` are always mutable working copies — there is no draft/published lifecycle.

Instead, **agent versions automatically capture the full state of all linked tools** at creation time. These snapshots are:

- **Read-only** — viewable in version history but never editable
- **Self-contained** — contain the full tool DSL, not just hash references
- **Automatic** — captured during agent version creation with no user action

This means agent versions serve as the version history for tools. If you need to know "what did this tool look like 3 months ago?", you look at the agent version from that time.

### 10.2 Snapshot Structure

When an agent version is created, capture full tool state:

```typescript
interface AgentVersionToolSnapshot {
  tools: ToolSnapshotEntry[];
}

interface ToolSnapshotEntry {
  /** Tool name as it appears in agent DSL */
  name: string;

  /** ObjectId of the project_tools document at snapshot time */
  projectToolId: string;

  /** SHA-256 of project_tools.dslContent at snapshot time */
  sourceHash: string;

  /** Tool type (denormalized for display without DB lookup) */
  toolType: 'http' | 'sandbox' | 'mcp';

  /** Description at snapshot time (for read-only display) */
  description: string | null;

  /** Full tool DSL at snapshot time (the complete read-only view) */
  dslContent: string;
}
```

**Why full state, not just hash references?**

- **Self-contained audit trail**: Each agent version is a complete snapshot. You never need to cross-reference `project_tools` to understand what a version contained.
- **Survives tool deletion**: If a tool is later deleted from `project_tools`, the snapshot still has the full definition.
- **Cheap read-only display**: UI can render tool cards from snapshot data without extra API calls.
- **Negligible storage**: Tool `dslContent` is typically 5-20 lines. Even 50 tools × 100 versions = kilobytes.
- **Decoupled from project_tools lifecycle**: Future changes to project_tools (archival, reorganization, etc.) don't affect historical snapshots.

### 10.3 Snapshot Creation Flow

When an agent version is created:

```
1. Parse working DSL → extract all tool names referenced
2. Batch fetch: db.project_tools.find({ name: { $in: toolNames }, projectId, tenantId })
3. For each found tool → create ToolSnapshotEntry { name, projectToolId, sourceHash, toolType, description, dslContent }
4. For tools NOT found in project_tools → handle as per Gap Resolution (see §10.6)
5. Store as toolSnapshot array on the agent version record
6. This is fully automatic — no user action needed
```

### 10.4 Stale Detection

At agent edit time, compare current project_tools state with the **active** version's snapshot:

```typescript
// Determine which version to compare against
const referenceVersion =
  versions.find((v) => v.status === 'active' && v.toolSnapshot?.length) ??
  versions.find((v) => v.toolSnapshot?.length); // fallback to latest with snapshot

if (!referenceVersion) return { stale: [], deleted: [], added: [] };

for (const snapshot of referenceVersion.toolSnapshot.tools) {
  const current = await db.project_tools.findOne({ _id: snapshot.projectToolId, tenantId });

  if (!current) {
    staleTools.push({ name: snapshot.name, status: 'deleted', snapshot });
  } else if (current.sourceHash !== snapshot.sourceHash) {
    staleTools.push({ name: snapshot.name, status: 'updated', snapshot, current });
  }
}

// Detect newly added tools (in working DSL but not in snapshot)
for (const toolName of workingDslToolNames) {
  if (!referenceVersion.toolSnapshot.tools.find((t) => t.name === toolName)) {
    addedTools.push({ name: toolName, status: 'new' });
  }
}
```

**UI banner examples**:

- `"2 tools changed since last version: charge_card (updated), old_tool (deleted)"`
- `"1 new tool added: send_confirmation (not in last version)"`

### 10.5 Agent Version Diff

Compare `toolSnapshot` between two agent versions to show:

- Tools added (in version B but not A, matched by `name`)
- Tools removed (in version A but not B, matched by `name`)
- Tools changed (same `name`, different `sourceHash` — can show DSL diff since both snapshots have `dslContent`)
- Tools renamed (same `projectToolId`, different `name` — detected via ID matching)

### 10.6 Read-Only Display

When viewing an agent version in the UI:

- **"Tools at this version"** section with read-only tool cards
- Each card shows: name, type badge, description
- Expandable DSL preview showing the exact `dslContent` from snapshot
- No edit actions — snapshots are immutable
- Lazy-loaded: version list API does NOT return snapshots; detail API returns them on demand

### 10.7 Gap Analysis & Resolutions

#### Gap 1: Orphaned tool references in working DSL (CRITICAL)

**Problem**: When a tool is deleted from `project_tools`, the agent's working DSL still references it by name. At agent version creation, the batch lookup returns nothing for that tool.

**Resolution**: Agent version creation proceeds with a **warning**, not a failure. The unresolved tool is recorded in the snapshot with a special marker:

```typescript
// Tool not found during snapshot
{
  name: 'deleted_tool',
  projectToolId: '',       // empty — no DB record
  sourceHash: '',          // empty — nothing to hash
  toolType: 'unknown',     // unknown — can't determine
  description: null,
  dslContent: '',          // empty — no source
  _unresolved: true        // flag for UI to show warning
}
```

However, **compilation itself will fail** (E721) if the tool isn't in `project_tools`. So in practice:

- If DSL references a deleted tool → compilation fails → version creation fails with compile errors
- The snapshot only contains tools that compiled successfully
- The compile error message tells the user which tool is missing

**Decision**: Compilation failure is the gate. No partial snapshots with unresolved tools.

#### Gap 2: Tool renamed between versions (IMPORTANT)

**Problem**: If `verify_email` is renamed to `validate_email` in `project_tools` and the agent DSL is updated, the version diff shows "removed + added" rather than "renamed".

**Resolution**: Use `projectToolId` to detect renames. When diffing two versions:

1. Match by `name` first (same name = same tool)
2. For unmatched entries, check if any removed tool's `projectToolId` matches an added tool's `projectToolId`
3. If match found → display as "renamed: verify_email → validate_email" instead of separate add/remove

#### Gap 3: Race condition between compilation and snapshot (CRITICAL)

**Problem**: A tool could be updated between when the compiler reads it (for IR) and when the snapshot is captured. The IR would have tool state X but the snapshot records state Y.

**Resolution**: Both compilation and snapshot capture happen in the **same operation**:

1. `resolveToolImplementations()` batch-fetches all tools from DB (single query)
2. The returned data is used for BOTH compilation AND snapshot creation
3. The snapshot is built from the exact same DB read that the compiler used
4. No second DB read for snapshots — eliminating the race window

```typescript
// In version creation service:
const resolvedTools = await resolveToolImplementations({ tenantId, projectId, toolNames });

// Same data feeds both:
const compiledIR = compileTools(resolvedTools);
const toolSnapshot = resolvedTools.map((t) => ({
  name: t.name,
  projectToolId: t.projectToolId,
  sourceHash: t.sourceHash,
  toolType: t.toolType,
  description: t.description,
  dslContent: t.dslContent,
}));
```

#### Gap 4: Multi-agent DSL files (ACCEPTABLE)

**Problem**: A single DSL file can define multiple agents, each referencing different tools. Versions are created per agent. Two agents sharing a tool but versioned at different times will have different tool snapshots.

**Accepted trade-off**: This is expected behavior. Each agent version is an independent snapshot of that agent's state. If agents need consistent tool state, create their versions at the same time (or use the same deployment pipeline).

#### Gap 5: Agent DSL signature vs project_tools dslContent divergence (IMPORTANT)

**Problem**: The snapshot stores the tool's `dslContent` (from `project_tools`). But the agent DSL has its own signature line that could be outdated. At compilation, `project_tools` is authoritative — so the IR is correct. But the snapshot shows tool's `dslContent` while the agent DSL shows a stale signature.

**Resolution**: The snapshot correctly captures what was compiled (project_tools data). The stale agent DSL signature is:

- Flagged by W721 warning at compile time
- Visible in stale detection banner
- Informational only — does not affect the compiled IR or the snapshot
- Agent editor can update signatures by re-linking from the tool library

No change to snapshot structure needed. The snapshot is authoritative (it shows what was actually compiled), and the agent DSL staleness is handled by existing warning mechanisms.

#### Gap 6: Snapshot size growth for long-lived agents (ACCEPTABLE)

**Problem**: Each version captures full `dslContent` for every tool. An agent with 30 tools and 200 versions produces 6,000 snapshot entries.

**Resolution**:

- Version **list** API does NOT return `toolSnapshot` (lightweight pagination)
- Version **detail** API returns `toolSnapshot` only on demand (lazy load)
- Tool `dslContent` is 5-20 lines per tool, so 6,000 entries ≈ tens of KB (negligible)
- Future: version retention policy (archive/delete old versions) if needed
- Future: content-addressed deduplication by `sourceHash` if storage becomes a concern

No action needed now — this is YAGNI until proven otherwise.

#### Gap 7: Stale detection — which version to compare against? (CRITICAL)

**Problem**: If there are multiple versions, stale detection must know which version's snapshot to compare against. The user might be editing from an older version, not the latest.

**Resolution**: Compare against the **active** version's snapshot (the one currently deployed). Fallback chain:

1. Latest version with status `active` that has a tool snapshot → use this
2. If no active version → latest version with any status that has a tool snapshot
3. If no versions have snapshots → no stale detection (first version scenario)

This matches the intent: "has anything changed since the last time this agent was deployed?"

#### Gap 8: Tool in DSL that doesn't exist in project_tools yet (CRITICAL)

**Problem**: User types a tool name in the DSL that doesn't exist in `project_tools`. At agent version creation, the batch lookup returns nothing.

**Resolution**: This is blocked by **compilation**. The compiler runs before snapshot creation:

1. Parse DSL → extract tool names
2. `resolveToolImplementations()` → tool not found → E721 error
3. Compilation fails → version creation fails → no snapshot created
4. User sees: "Error E721: Tool 'my_new_tool' not found in project tools"
5. User must create the tool in `project_tools` first, then retry version creation

No partial snapshots. No "unresolved" entries. Compilation is the gate.

#### Gap 9: Security — dslContent in snapshot may expose tool implementation (CRITICAL)

**Problem**: HTTP tools have URLs and auth patterns. MCP tools have server URIs. Sandbox tools have code. The `dslContent` is stored in the agent version record. Could a user with `version:read` but not `tool:read` see implementation details?

**Resolution**:

- Agent versions and project_tools are both scoped to `(tenantId, projectId)`
- `version:read` and `tool:read` are both project-level permissions
- In practice, anyone who can view agent versions can also view project tools — they're the same audience
- Secrets are never in `dslContent` (stored as `{{secrets.X}}` placeholders) — so no secret leakage
- Sensitive URLs use `{{env.X}}` placeholders — actual values resolved at runtime only
- **No permission gap exists**: same project membership gates both resources

#### Gap 10: Rollback semantics — what does "restore" mean? (IMPORTANT)

**Problem**: Snapshots enable viewing old tool state, but what about restoring it? If someone wants to "roll back a tool to its state at version X", they'd need to manually copy `dslContent` from the snapshot back to `project_tools`.

**Resolution**: For now, rollback is **view-only reference**:

- User views old version → sees tool snapshot → manually copies DSL if needed
- Agent version rollback (redeploying an old version) uses the IR baked into that version — tool snapshots are informational
- No "Restore Tool" button in v1

Future enhancement (not in scope):

- "Restore tool to this snapshot" button that copies `dslContent` from snapshot → `project_tools`
- Would require re-validation (snapshot DSL might reference servers/envs that no longer exist)

#### Gap 11: Deduplication of identical tool state across versions (ACCEPTABLE)

**Problem**: If a tool hasn't changed between version 5 and version 6, the snapshot stores identical `dslContent` twice. Over many versions, this is redundant data.

**Accepted trade-off**: Storage cost is negligible (tool DSL is small text). Content-addressed deduplication by `sourceHash` is a possible future optimization but YAGNI for now. The simplicity of self-contained snapshots outweighs the minor storage overhead.

#### Gap 12: No inter-tool dependency tracking in snapshots (ACCEPTABLE)

**Problem**: If tool A's HTTP binding calls an endpoint that depends on tool B's configuration, the snapshot captures A and B independently. There's no record of inter-tool relationships.

**Accepted trade-off**: Tools are independent by design. Inter-tool dependencies are an infrastructure concern (e.g., shared API gateway) not a tool-definition concern. Future "tool dependency graph" features would operate at the project level, not the snapshot level.

---

## 11. Maintenance Operations

### 11.1 Tool Update

1. Edit via form → re-validate → save dslContent
2. All agents get the update on **next compile** (automatic propagation)
3. No manual per-agent updates needed

**Blast radius awareness**: Changing a tool affects ALL agents using it at next compile. The tool edit UI should show "Used by N agents" count.

### 11.2 Tool Deletion

Single endpoint with force flag:

1. `DELETE /tools/:id` (no force) → returns `{ impactedAgents: ['agent_a', 'agent_b'] }` — does NOT delete
2. Studio shows confirmation dialog with impacted agent list
3. `DELETE /tools/:id?force=true` → hard delete from MongoDB
4. After deletion → agents referencing this tool will fail compilation (E721)
5. Stale detection will show "deleted" status
6. Agent version snapshots still contain the tool's full `dslContent` for historical reference

**No soft delete.** Snapshots are the history.
**Single endpoint.** No separate impact check route — the DELETE endpoint itself returns impact data when called without `force=true`.

### 11.3 Tool Rename

Rename is part of the normal update flow — not a separate operation.

1. User changes the name field in the tool form and saves
2. Backend detects name changed as part of `PUT /tools/:id`
3. Tool is updated with new name
4. **No auto-update of agent DSLs** — agents referencing the old name will fail with E721 at next compilation
5. User must manually update agent DSL references to use the new name

**Why no auto-update?** Simplicity. Agent DSLs are the user's domain — the tool system doesn't reach into them. E721 errors at compilation give clear feedback about what needs updating.

### 11.4 Shared Tool Change — Considerations

| Concern                                    | Mitigation                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Someone changes tool params → agents break | Compilation warnings (W721) + stale detection banner                                    |
| Accidental destructive change              | `_v` optimistic concurrency prevents overwrites                                         |
| "Who changed the tool?"                    | `lastEditedBy` + `updatedAt` on project_tools                                           |
| Rollback a tool change                     | Agent version snapshot has `sourceHash` — can detect which version of the tool was used |

---

## 12. AI (Arch) Integration

### 12.1 New Arch Tools

| Tool          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `create_tool` | Create a project_tools entry (generates DSL, validates, saves) |
| `update_tool` | Update existing project_tool implementation                    |
| `list_tools`  | List project_tools in current project (for context)            |
| `delete_tool` | Delete a project_tool                                          |

### 12.2 AI Agent Design Workflow

```
Step 1: AI understands what tools the agent needs
  → "This booking agent needs search_hotels, charge_card, send_confirmation"

Step 2: AI checks which tools exist
  → list_tools() → "charge_card exists, search_hotels exists, send_confirmation missing"

Step 3: AI creates missing tools
  → create_tool({ dslContent: "send_confirmation(...) type: http ..." })

Step 4: AI generates agent DSL with signatures
  → TOOLS: search_hotels(...) type: http
           charge_card(...) type: http
           send_confirmation(...) type: http
```

### 12.3 AI Portability

AI-generated agent DSL is **portable** — signatures are self-documenting. Anyone reading the DSL can understand what tools are needed and create corresponding project_tools entries in their own project.

---

## 13. What Gets Deleted / Added / Kept

### 13.1 Deleted (~22,700 lines)

| Category                        | Files | Lines |
| ------------------------------- | ----: | ----: |
| Studio UI components (tools/)   |   25+ | 7,845 |
| Studio API routes (tools)       |    14 |   706 |
| Studio stores/services/hooks    |     4 |   843 |
| Shared tool resolution pipeline |    10 | 3,249 |
| Database models/migrations      |     6 | 1,675 |
| Tests for deleted code          |   20+ | 8,436 |

### 13.2 Added (~2,500 lines)

| Component                                   | Lines (est.) |
| ------------------------------------------- | -----------: |
| `project_tools` model + CRUD API (4 routes) |          300 |
| Tool forms (per-type) + library list        |        1,200 |
| `resolveToolImplementations()`              |          200 |
| `serializeToolFormToDsl()` per type         |          200 |
| `validateToolDsl()` pipeline                |          200 |
| `extractSignatureFromDsl()`                 |           50 |
| New tests                                   |          350 |

### 13.3 Kept (unchanged)

| Component                                | Reason                          |
| ---------------------------------------- | ------------------------------- |
| `ToolDefinition` IR schema               | Output format identical         |
| `HttpBindingIR`, `McpBindingIR`          | IR binding types unchanged      |
| `HttpToolExecutor`, `McpToolExecutor`    | Runtime executors work on IR    |
| `ToolBindingExecutor`                    | Unified dispatch unchanged      |
| `tool_secrets` + `environment_variables` | Secret/env management unchanged |
| `mcp_server_configs`                     | Infrastructure config unchanged |
| `SecretsProvider`                        | Runtime resolution unchanged    |
| IR caching (L1/L2/L0)                    | Caching layer unchanged         |
| System tools (handoff, delegate, etc.)   | Compiler-injected, unchanged    |

### 13.4 Modified

| Component                      | Change                                                                     |
| ------------------------------ | -------------------------------------------------------------------------- |
| `SandboxBindingIR`             | Remove `entrypoint` field                                                  |
| `SandboxToolExecutor`          | Wrap code with param injection instead of calling named function           |
| `agent-based-parser.ts`        | Reject implementation properties in TOOLS section (E720)                   |
| `compiler.ts`                  | Replace `resolvedToolLinks` merge with `resolvedToolImplementations` merge |
| `CompilerOptions`              | Replace `resolvedToolLinks` with `resolvedToolImplementations`             |
| Agent DSL serializers (Studio) | Serialize tool signatures (not `USE TOOL:`)                                |
| `ToolsSection.tsx`             | New "Add from Library" workflow                                            |
| `AgentDetailPage.tsx`          | Remove `USE TOOL:` parsing, add signature parsing                          |

---

## 14. Constraints & Limitations

### 14.1 Architectural Constraints

| Constraint                                     | Detail                                                                                                                    | Rationale                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Every tool must have a project_tools entry** | No tool can exist only in agent DSL. Even one-off agent-specific tools need a project_tools entry.                        | Single creation path enforcement. One source of truth for implementation.        |
| **Compilation requires DB**                    | Compiler must query project_tools to resolve tool implementations. Compilation is not a pure function of DSL text alone.  | Trade-off for single source of truth. Mitigated by batch queries.                |
| **Agent DSL is not fully self-contained**      | Agent DSL has signatures but not implementations. You need project_tools + mcp_server_configs to compile.                 | By design — DSL is the orchestration layer, not the implementation layer.        |
| **project_tools is authoritative**             | If agent DSL signature conflicts with project_tools definition, project_tools wins. Agent DSL signature is informational. | Prevents stale signatures from affecting compilation output.                     |
| **No DSL editing of tools**                    | Tool implementation is always edited via forms, never via raw DSL text.                                                   | Ensures validation gate is always enforced. Prevents bypassing pre-save checks.  |
| **No multi-tool files**                        | Each project_tools document is exactly one tool. No grouping or bundling.                                                 | Simpler model: 1 tool = 1 document. Atomic CRUD. No multi-tool parsing for CRUD. |

### 14.2 Parser Constraints

| Constraint                                       | Detail                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation properties forbidden in agent DSL | Parser emits E720 for: `endpoint`, `method`, `headers`, `auth`, `auth_config`, `timeout`, `retry`, `retry_delay`, `rate_limit`, `circuit_breaker`, `code`, `runtime`, `memory_mb`, `server`, `server_tool` |
| Tool type is required                            | Every tool in agent DSL must declare `type: http \| sandbox \| mcp`                                                                                                                                        |
| `USE TOOL:` syntax removed                       | Parser no longer recognizes `USE TOOL:`. All references are signatures.                                                                                                                                    |
| `FROM...USE` syntax removed                      | No import syntax. All tools are signatures referencing project_tools by name.                                                                                                                              |

### 14.3 Compilation Constraints

| Constraint                                          | Detail                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All tool names must exist in project_tools          | Compilation fails (E721) if any tool name in agent DSL is not found in project_tools for the same tenant+project                                                                                       |
| MCP server must exist at save time AND compile time | MCP tools reference a server by name; that server must exist in `mcp_server_configs` at tool save time (trial compile phase) AND at agent compile time (E722). Server must be created before MCP tool. |
| Batch resolution                                    | All tool lookups are batched into a single `$in` query per compilation. No N+1 queries.                                                                                                                |
| project_tools.dslContent must parse                 | If a project_tools entry has corrupted dslContent (shouldn't happen due to pre-save validation), compilation emits E725.                                                                               |

### 14.4 Storage Constraints

| Constraint                  | Detail                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Name uniqueness per project | `(tenantId, projectId, name)` must be unique                                           |
| Slug immutability           | Slug is set at creation, never changed (even on rename)                                |
| Code size limit             | Sandbox `code` content max 256KB                                                       |
| Validated DSL only          | project_tools.dslContent is guaranteed to parse and compile (pre-save validation gate) |
| No plaintext secrets        | E760 rejects DSL containing potential raw secrets                                      |

### 14.5 UI/UX Constraints

| Constraint               | Detail                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Form-only editing        | Tool implementation is always created/edited via per-type forms. No raw DSL editing.                                       |
| One-way sync             | Form → DSL preview (read-only). No DSL → Form direction.                                                                   |
| Type-specific forms      | Each tool type (HTTP, Sandbox, MCP) has a dedicated form layout. No "universal" form.                                      |
| Pre-delete warning       | `DELETE /tools/:id` (no force) returns impacted agents. Studio shows confirmation. `DELETE /tools/:id?force=true` deletes. |
| No auto-update on rename | Rename is part of normal update. Agents get E721 at next compile. No "Rename & Update Agents" option.                      |

### 14.6 Runtime Constraints

| Constraint                              | Detail                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| Zero runtime changes (except sandbox)   | HttpToolExecutor, McpToolExecutor unchanged. Runtime works on IR.     |
| Sandbox executor change                 | Must remove `entrypoint` calling. Wrap code with parameter injection. |
| `{{secrets.X}}` / `{{env.X}}` unchanged | Runtime resolution via SecretsProvider. Same mechanism.               |
| IR caching unchanged                    | Same L1/L2/L0 caching. Session stores irSourceHash.                   |

### 14.7 Known Limitations

| Limitation                                               | Impact                                                                                  | Mitigation                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **No shared defaults across tools**                      | If 5 HTTP tools share the same base_url and auth, each repeats it.                      | Use `{{env.X}}` environment variables — same value for all tools that reference them.      |
| **Compilation depends on DB availability**               | If project_tools DB is down, compilation fails.                                         | Same as current system (DB is always required for tool resolution).                        |
| **Same DSL at different times may produce different IR** | If project_tools changes between compilations, IR changes even though agent DSL didn't. | Agent version snapshots capture sourceHash for reproducibility audit.                      |
| **No cross-project tool sharing**                        | project_tools is scoped to (tenantId, projectId).                                       | Copy DSL between projects manually. Possible future feature.                               |
| **No tool-level access control**                         | Permissions are at project level, not per-tool.                                         | Possible future feature via `slug` field.                                                  |
| **Stale signatures in agent DSL**                        | Agent DSL signature may not match project_tools after tool is updated.                  | Stale detection banner + W721 compilation warning. Informational only — doesn't affect IR. |

---

## 15. Migration Plan (High Level)

### Phase 1: Build new infrastructure

- `project_tools` collection, model, indexes
- CRUD API (4 routes) + validation pipeline
- Per-type forms + serializer

### Phase 2: Migration tooling

- Export existing DB tools → generate project_tools entries (one per tool)
- Rewrite agent DSL: replace `USE TOOL: slug` with tool signatures
- Validate: compile all agents with new pipeline, diff IR output

### Phase 3: Remove old infrastructure

- Delete `tools` + `tool_versions` collections
- Delete 13+ API routes, 30+ UI components, resolution pipeline
- Delete `USE TOOL:` parser code

### Phase 4: Polish

- Update parser to reject implementation properties in agent DSL (E720)
- Update sandbox executor (remove entrypoint)
- Update documentation and CLAUDE.md

---

## 16. Testing Strategy

### 16.1 Coverage Level

Full coverage: **unit + integration + E2E** tests across all components.

```
┌─────────────────────────────────────────────────────────┐
│                    E2E Tests                             │
│  Full workflows: create → link → compile → verify IR    │
├─────────────────────────────────────────────────────────┤
│                Integration Tests                         │
│  API routes + real DB + validation pipeline               │
├─────────────────────────────────────────────────────────┤
│                   Unit Tests                             │
│  Pure functions: validators, serializers, parsers,       │
│  stale detection, compilation helpers, secret detection  │
└─────────────────────────────────────────────────────────┘
```

### 16.2 Unit Tests

All pure functions independently tested. Mock DB, mock Redis, mock external services.

| Component               | Test Cases                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validation pipeline** | Each of 5 phases in isolation: parse (valid/invalid DSL), structural (required fields), type-specific (HTTP/Sandbox/MCP), security (E760 detection patterns), trial compile (E722 MCP server missing)                         |
| **DSL serializers**     | `serializeToolFormToDsl()` per tool type: HTTP (with/without auth), Sandbox (with/without code), MCP. Roundtrip: form → DSL → parse → verify fields match                                                                     |
| **Parser changes**      | E720 rejection for forbidden properties (`endpoint`, `code`, `server`, etc.). Valid signature parsing. `type:` requirement. System tool name rejection.                                                                       |
| **Compilation helpers** | `resolveToolImplementations()`: batch lookup, missing tool (E721), corrupt DSL (E725), MCP server resolution. Per-type binding compilation: HTTP → `HttpBindingIR`, Sandbox → `SandboxBindingIR`, MCP → `McpBindingIR`        |
| **Stale detection**     | sourceHash comparison. Field-by-field W721: parameter name change, parameter type change, parameter count change, return type change, description change. Deleted tool detection. Renamed tool detection via `projectToolId`. |
| **Snapshot creation**   | `ToolSnapshotEntry` construction with all fields. Verify single-read feeds both compilation and snapshot (no race condition).                                                                                                 |
| **Secret detection**    | Each regex pattern: API keys (32+ hex/base64), Bearer tokens, AWS access keys, connection strings, private keys, base64 >100 chars. False positive scenarios. Global bypass flag.                                             |
| **Error codes**         | Every error (E720-E762) and warning (W721, W726) has at least one triggering test case.                                                                                                                                       |

### 16.3 Integration Tests

API routes with real MongoDB (in-memory via `mongodb-memory-server`). Mock external services (MCP servers, HTTP endpoints).

| Component                  | Test Cases                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRUD API routes**        | `POST /tools` (create with validation), `GET /tools` (list with type filter + search), `GET /tools/:id` (detail), `PUT /tools/:id` (update full replace), `DELETE /tools/:id` (impact check + force delete) |
| **Tenant isolation**       | Verify `tenantId` is present in every DB query. Tenant A cannot read/write/delete Tenant B's tools.                                                                                                         |
| **Permission enforcement** | `tool:read` required for GET. `tool:write` required for POST/PUT. `tool:delete` required for DELETE. Missing permission → 403.                                                                              |
| **Validation pipeline**    | Form data → validate → serialize → save → return full document. Invalid data → structured errors.                                                                                                           |
| **Compilation flow**       | Agent DSL with tool signatures + project_tools in DB → compile → verify `ToolDefinition` IR output matches expected shape.                                                                                  |
| **Error responses**        | Structured error format: `{ success: false, errors: [{ code, field, message }] }` for all failure modes.                                                                                                    |

### 16.4 E2E Tests

Full workflow tests with real DB + real compilation pipeline. Mock only external infrastructure.

| Workflow                          | Steps                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool creation**                 | Open type picker → select HTTP → fill wizard form → submit → appears in library list with correct name/type/description                       |
| **Tool linking**                  | Open agent editor → open tool picker → select tool → signature inserted into TOOLS section → compile agent → verify IR contains tool          |
| **Tool update + stale detection** | Edit tool parameters → save → open linked agent → stale badge visible → update signature → recompile → verify updated IR                      |
| **Tool deletion**                 | Click delete → see impacted agents in dialog → force delete → compile impacted agent → E721 error                                             |
| **Full compilation**              | Create 3 tools (HTTP + Sandbox + MCP) → create agent with all 3 → compile → verify all 3 `ToolDefinition` entries in IR with correct bindings |

### 16.5 Security Tests

| Category             | Test Cases                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF protection**  | Block private IPs (10.x, 172.16-31.x, 192.168.x), localhost (127.0.0.1, ::1), link-local (169.254.x), cloud metadata (169.254.169.254). Verify E761. |
| **MCP URI security** | HTTPS → pass, WSS → pass, HTTP → E762, WS → E762                                                                                                     |
| **Secret detection** | AWS key in DSL → E760. Bearer token → E760. `{{secrets.X}}` placeholder → pass. Global bypass flag → skip detection.                                 |
| **Permissions**      | No auth → 401. Wrong permission → 403. Cross-tenant → 404 (not 403).                                                                                 |

### 16.6 Mock Strategy

| Test Level      | DB                       | Redis          | External Services                    |
| --------------- | ------------------------ | -------------- | ------------------------------------ |
| **Unit**        | Mocked                   | Mocked         | Mocked                               |
| **Integration** | Real (in-memory MongoDB) | Mocked         | Mocked                               |
| **E2E**         | Real (in-memory MongoDB) | Real or mocked | Mocked (MCP servers, HTTP endpoints) |

---

## 17. Observability & Audit

### 17.1 Architecture

All tool system observability uses existing platform infrastructure. No new backends or abstractions.

```
Tool System Events
       │
       ├── TraceEvent (structured) ─────→ TraceStore → ClickHouse
       ├── Audit Events ────────────────→ Shared Audit Store
       └── Metric Counters ─────────────→ Existing Metrics Infrastructure
```

### 17.2 Compilation Trace Events

| Event                       | Fields                                                                  | Trigger                               |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| `tool.resolution.start`     | `agentName`, `toolCount`, `compilationMode`                             | Before `resolveToolImplementations()` |
| `tool.resolution.complete`  | `agentName`, `resolvedCount`, `missingCount`, `durationMs`, `cacheHits` | After batch DB lookup + cache check   |
| `tool.compilation.per_tool` | `toolName`, `toolType`, `durationMs`, `fromCache`                       | Each tool's binding compilation       |
| `tool.compilation.complete` | `agentName`, `totalTools`, `warnings[]`, `errors[]`, `durationMs`       | After merge into final IR             |
| `tool.compilation.timeout`  | `agentName`, `elapsedMs`, `timeoutMs`                                   | E727 timeout exceeded                 |

### 17.3 Validation Trace Events

| Event                  | Fields                                                          | Trigger                      |
| ---------------------- | --------------------------------------------------------------- | ---------------------------- |
| `tool.validation.pass` | `toolName`, `toolType`, `durationMs`, `phasesRun`               | All 5 validation phases pass |
| `tool.validation.fail` | `toolName`, `toolType`, `failedPhase`, `errors[]`, `durationMs` | Any validation phase fails   |

### 17.4 Stale Detection Events

| Event                 | Fields                                    | Trigger                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| `tool.stale.detected` | `agentName`, `staleTools[]`, `totalTools` | Any W721 warnings during compilation |

Each entry in `staleTools[]`:

```typescript
{ toolName: string, changedFields: ('parameters' | 'returns' | 'description')[] }
```

### 17.5 Audit Events

Tool lifecycle events logged to the shared audit store:

```typescript
{
  type: 'tool.created' | 'tool.updated' | 'tool.deleted',
  actor: { userId: string, email: string },
  tenantId: string,
  projectId: string,
  resource: {
    id: string,          // project_tools._id
    name: string,        // tool name
    toolType: string,    // http | sandbox | mcp
  },
  metadata: {
    changedFields?: string[],  // for updates
    impactedAgents?: number,   // for deletes
  },
  timestamp: Date,
}
```

### 17.6 Metric Counters

| Metric                           | Type      | Labels                                |
| -------------------------------- | --------- | ------------------------------------- |
| `tool.created`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.updated`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.deleted`                   | Counter   | `tenantId`, `projectId`, `toolType`   |
| `tool.compilation.duration_ms`   | Histogram | `compilationMode`, `toolCount` bucket |
| `tool.validation.duration_ms`    | Histogram | `toolType`, `result` (pass/fail)      |
| `tool.validation.failure_rate`   | Counter   | `toolType`, `failedPhase`             |
| `tool.resolution.cache_hit_rate` | Counter   | `result` (hit/miss)                   |

### 17.7 Tenant Isolation

Every trace event, audit event, and metric label includes `tenantId`. ClickHouse queries and audit store queries always filter by `tenantId`. No cross-tenant event leakage.

---

## 18. Performance & Scaling

### 18.1 Scaling Limits

| Dimension                       | Limit | Basis                                                      |
| ------------------------------- | ----- | ---------------------------------------------------------- |
| Tools per project               | 500   | E763 on exceed. Covers all realistic use cases.            |
| Tools per agent                 | 100   | C3.5. Parser-enforced.                                     |
| Total documents (project_tools) | ~500K | 100 tenants × 10 projects × 500 tools. No sharding needed. |
| Sandbox code size               | 256KB | C5.2. W726 warning at 64KB.                                |
| Compilation timeout             | 30s   | E727. Configurable via `compilationTimeoutMs`.             |

### 18.2 API Response Time Targets

| Operation                      | Target |
| ------------------------------ | ------ |
| `GET /tools` (list)            | <500ms |
| `GET /tools/:id` (detail)      | <200ms |
| `POST /tools` (create)         | <2s    |
| `PUT /tools/:id` (update)      | <2s    |
| `DELETE /tools/:id` (impact)   | <500ms |
| `DELETE /tools/:id?force=true` | <300ms |

### 18.3 Compilation Performance

Target: **<5s** for compiling an agent with 50 tools. Cache-warm: **<1s**.

```
Phase breakdown (50 tools, cold cache):
├── Tool resolution (batch $in query)     ~500ms
├── Redis cache check (MGET)              ~100ms
├── Per-tool binding compilation (parallel) ~3s
│   ├── HTTP binding: ~30ms/tool
│   ├── Sandbox binding: ~50ms/tool (parse code)
│   └── MCP binding: ~40ms/tool (server config merge)
├── IR merge + warning collection          ~200ms
└── Total                                  ~4s
```

### 18.4 Database Indexes

| Index                                | Query Pattern                           |
| ------------------------------------ | --------------------------------------- |
| `(tenantId, projectId, name)` unique | Find by name, batch resolve, uniqueness |
| `(tenantId, projectId)` compound     | List all tools in project               |
| `_id` primary                        | Find by ID (with tenantId filter)       |

Two compound indexes cover all query patterns. No additional indexes on `toolType` or `description` — max 500 docs per project makes in-memory filtering negligible.

### 18.5 Caching Strategy

```
Compilation request
       │
       ▼
  Redis MGET by sourceHash[]
       │
  ┌────┴────┐
  │ Hit     │ Miss
  │ (cached │ (parse from
  │  AST)   │  dslContent)
  └────┬────┘
       │
  Compile bindings (parallel)
       │
  Redis MSET (24h TTL)
       │
  Return ToolDefinition[] IR
```

- **Key**: `tool:ast:{sourceHash}` — content-addressed
- **Batch**: MGET/MSET for all tools in single pipeline
- **TTL**: 24h. No explicit invalidation. Content-addressed keys mean new content = new key.
- **Miss penalty**: Parse dslContent (~50ms/tool). Acceptable for cold cache.

### 18.6 Snapshot Storage Projection

| Scale                                                | Documents              | Storage |
| ---------------------------------------------------- | ---------------------- | ------- |
| 1 project, 50 tools, 50 versions                     | 2,500 snapshot entries | ~1.2MB  |
| 10 projects, 100 tools, 100 versions                 | 100,000 entries        | ~50MB   |
| 100 tenants × 10 projects × 500 tools × 200 versions | 100M entries           | ~50GB   |

Lazy-loaded (C9.7): version list API excludes snapshots. Detail API includes on demand. No deduplication v1 — revisit if storage exceeds 100GB.

### 18.7 Future Optimizations (Not v1)

| Optimization               | Trigger                                    | Approach                                                                  |
| -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Virtual scrolling          | Library page >200 tools renders >200ms     | react-window / react-virtuoso                                             |
| API pagination             | Projects with >500 tools (if limit raised) | Cursor-based pagination                                                   |
| Snapshot deduplication     | Storage >100GB                             | Content-addressed by sourceHash, reference counting                       |
| Tenant sharding            | >1000 tenants                              | Shard by tenantId                                                         |
| Compilation result caching | High compilation frequency                 | Cache final `ToolDefinition[]` IR by agent sourceHash + tool sourceHashes |

---

## 19. Glossary

| Term                    | Definition                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Signature**           | Tool name + parameters + return type + description + type. The interface contract. Appears in agent DSL.                                               |
| **Implementation**      | Type-specific binding details (endpoint, auth, code, server). Lives in project_tools.dslContent.                                                       |
| **project_tools**       | MongoDB collection storing one tool per document with validated dslContent.                                                                            |
| **dslContent**          | The full tool DSL string (signature + implementation) stored in project_tools. Validated before save.                                                  |
| **sourceHash**          | SHA-256 of dslContent. Used for stale detection and change tracking.                                                                                   |
| **Stale signature**     | When the tool signature in agent DSL differs from the current project_tools definition. Informational warning only.                                    |
| **Tool snapshot**       | `{ name, projectToolId, sourceHash, toolType, description, dslContent }` captured per tool at agent version creation time. Full state, self-contained. |
| **Pre-save validation** | 5-phase validation (parse → structural → type-specific → security → trial compile) that gates every project_tools write.                               |
| **Denormalized fields** | `toolType` and `description` on project_tools — extracted from dslContent during validation for fast listing/filtering.                                |
