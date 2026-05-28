# Tool Architecture Analysis: DB Entities vs DSL-Native vs Hybrid

**Date**: 2026-02-23
**Status**: Decision Pending
**Scope**: Whether tools should remain as separate DB entities, move entirely into DSL, or adopt a hybrid model

---

## 1. Executive Summary

The ABL platform currently maintains tools as **first-class DB entities** (MongoDB collections: `tools`, `tool_versions`, `tool_secrets`) alongside a **fully capable DSL-native tool system** (`.tools.abl` files with `FROM...USE` imports, inline tool definitions with `{{env.X}}` / `{{secrets.X}}` runtime placeholders).

This analysis evaluates three architectural approaches for long-term enterprise maintainability:

- **Approach A**: Keep separate DB tool entities (current architecture)
- **Approach B**: Tools as DSL content (convert DB tools to DSL, store as `dslContent` in DB)
- **Approach C**: Hybrid — DB for runtime config only, DSL for tool interface

**Critical context**: In production, all DSL is stored in the database (`project_agents.dslContent`), not on the filesystem. The `.tools.abl` examples in the repo are filesystem-based development artifacts. Any DSL-based approach must store tool DSL content in DB — either embedded in agent `dslContent` or as separate shared tool DSL entities.

The analysis covers 15 dimensions relevant to enterprise platform operation.

---

## 2. Current State of the Platform

### 2.1 What Exists Today

The platform supports **three parallel mechanisms** for defining tools:

| Mechanism             | Where Defined                    | Where Stored                      | How Referenced by Agents                    |
| --------------------- | -------------------------------- | --------------------------------- | ------------------------------------------- |
| **Inline tools**      | Agent `.abl` file, TOOLS section | Inside agent DSL string           | Direct — parsed and compiled inline         |
| **Tool file imports** | `.tools.abl` files               | Filesystem / source control       | `FROM "./path.tools.abl" USE: tool1, tool2` |
| **DB-managed tools**  | Studio UI (forms, wizards)       | MongoDB `tools` + `tool_versions` | `USE TOOL: slug[@version]`                  |

### 2.2 DB Tool Infrastructure

| Component           | Count   | Details                                                                                           |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| MongoDB collections | 3       | `tools`, `tool_versions`, `tool_secrets`                                                          |
| REST API routes     | 13+     | CRUD, versioning, publishing, testing, import/export, MCP discovery                               |
| UI components       | 30+     | Pages (3), dialogs (5), type-specific forms (4), wizards (3), test panels (2), version management |
| Shared packages     | 6 files | `convert-db-tool-to-ir.ts`, `load-project-tools-as-ir.ts`, `resolve-tool-links.ts`, repos         |
| Resolution pipeline | 4 steps | Parse `USE TOOL` → resolve from DB → convert to IR → merge into compiler                          |

### 2.3 DSL-Native Tool Infrastructure

| Component            | Details                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `.tools.abl` parser  | `tool-file-parser.ts` — parses defaults + tool definitions                                       |
| Import resolver      | `tool-import-resolver.ts` — resolves `FROM...USE`, merges defaults, handles paths                |
| Import syntax        | `FROM "./tools/api.tools.abl" USE: search, get_details`                                          |
| Shared defaults      | `base_url`, `auth`, `timeout`, `retry`, `headers` — applied to all tools in file                 |
| Config variables     | `{{config.X}}` resolved at compile time                                                          |
| Runtime placeholders | `{{env.X}}` and `{{secrets.X}}` resolved at execution time via `SecretsProvider`                 |
| Secret storage       | `EnvironmentVariable` and `ToolSecret` collections (encrypted, tenant-scoped, environment-aware) |

### 2.4 Key Insight

The DSL-native system is **already production-capable**. It handles:

- Reusable tool libraries (`.tools.abl` files with `FROM...USE`)
- Secret management (`{{secrets.X}}` resolved at runtime)
- Environment-specific config (`{{env.X}}` per deployment environment)
- Full binding definitions (HTTP endpoint/method/auth/headers, MCP server/tool, Sandbox runtime/entrypoint)
- Compile-time config injection (`{{config.X}}`)

The DB tool system provides **additional capabilities** on top: versioning lifecycle, independent testing, MCP auto-discovery, and a form-based UI.

---

## 3. Approach A: Keep Separate DB Tool Entities (Current)

### 3.1 Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│  Studio UI           │     │  Agent DSL            │
│  (Forms, Wizards)    │     │  (TOOLS section)      │
│        │             │     │        │               │
│        ▼             │     │        ▼               │
│  MongoDB             │     │  Parser                │
│  tools + versions    │────▶│  USE TOOL: slug        │
│        │             │     │        │               │
│        ▼             │     │        ▼               │
│  resolveToolLinks()  │────▶│  Compiler              │
│  convertDbToolToIR() │     │  (merge resolved tools)│
└─────────────────────┘     └──────────────────────┘
```

### 3.2 Strengths

**S1. Independent tool lifecycle**
Tools have their own versioning: draft (mutable) → named versions (immutable snapshots) → published. An agent can pin to `@v2` while `v3` is being tested. This decouples tool development from agent development — different teams can work on tools and agents independently.

**S2. MCP auto-discovery**
`discoverAndPersist()` automatically creates DB tools from MCP server discovery. Discovered tools get proper slugs, schemas from server introspection (`inputSchema`), and `mcpConfig.serverId` linking. This is a one-click operation — discover 20 tools from a server, all become usable immediately.

**S3. Independent testing**
`ToolTestPanel` tests tools in isolation without running an agent. Dynamic form generation from JSON Schema, JSON input mode, result display with latency. Rate-limited (10 req/min). This is critical for tool developers iterating on endpoint configs or sandbox code.

**S4. Form-based editing for non-DSL users**
HTTP wizard: endpoint → method → auth → headers → retry → circuit breaker. Sandbox editor: code editor with syntax highlighting. MCP wizard: server selection → tool discovery. These lower the barrier for non-developer users (product managers, business analysts).

**S5. Granular access control**
Separate permissions: `TOOL_READ`, `TOOL_WRITE`, `TOOL_DELETE`, `TOOL_EXECUTE`. A team member can test tools without being able to modify agent behavior, or read tool configs without being able to delete them.

**S6. Audit trail for compliance**
`tool_secrets` has `auditTrailPlugin`. Version history tracked with `createdBy`/`modifiedBy`. `ToolLinkSnapshotEntry[]` records exact tool+version deployed. Supports SOC 2 and PCI audit requirements.

**S7. Runtime binding isolation**
Sandbox `codeContent`, MCP `server_config`, HTTP `authConfig` — all baked into IR at compile time. Zero DB lookups at runtime. Encrypted fields (`encrypted_env`, `encrypted_auth_config`) decrypted only at execution time.

### 3.3 Weaknesses

**W1. AI cannot generate `USE TOOL: slug`**
AI models generating DSL have no knowledge of what slugs exist in a project's DB. They can only generate inline tool definitions. This creates a disconnect — AI generates inline tools, but the platform encourages DB tools.

**W2. Two sources of truth for tool interface**
Tool description and parameters exist in both DB (`inputSchema`, `description`) and DSL (inline signature). When a DB tool's schema changes, agents with `USE TOOL:` get the new schema at next compile. But there's no visibility into what changed — the DSL shows a bare slug, not the interface.

**W3. DSL is not self-contained**
An agent with `USE TOOL: weather_api` is meaningless without DB access. The DSL cannot be reviewed, shared, or understood in isolation. This hurts code review, documentation, and portability.

**W4. Complex resolution pipeline**
Parse `USE TOOL` → `resolveToolLinks()` (batch DB query by slugs) → `convertDbToolToIR()` (per-type conversion) → merge into compiler. This pipeline has edge cases: stale tools (deleted from DB), version pin mismatches, auto-publish of draft-only tools, collision with inline tools (E705), collision with system tools (E707).

**W5. Dual mental model**
Developers must understand: when to use inline tools vs DB tools, how `USE TOOL:` resolution works, how versioning affects agents, what the stale tool banner means. This increases onboarding time and cognitive load.

**W6. UI maintenance burden**
30+ components across pages, dialogs, forms, wizards, test panels, version management. Each tool type has its own config form and wizard. This is substantial code to maintain, test, and evolve.

### 3.4 Risks

| Risk                                               | Severity | Mitigation                                                   |
| -------------------------------------------------- | -------- | ------------------------------------------------------------ |
| Stale tool references (tool deleted, slug changed) | Medium   | `StaleToolBanner` already implemented                        |
| Version drift (agent uses old tool version)        | Low      | Version pinning + stale check                                |
| Resolution failure at compile time                 | Medium   | Graceful error handling in `loadProjectToolsAsIR`            |
| Maintenance cost of dual system                    | High     | Team must maintain both DSL parsing + DB tool infrastructure |

---

## 4. Approach B: Tools as DSL Content (Convert DB Tools → DSL)

### 4.1 Critical Context: DSL Storage in Production

In production, agent DSL is stored as `dslContent: string` in the `project_agents` MongoDB collection — **not** on the filesystem. The `.tools.abl` files in `examples/` are filesystem-based development artifacts. Any DSL approach must account for DB-based storage.

**Two storage models for tool DSL:**

**B1. Embed in agent `dslContent`** — each agent's TOOLS section contains full inline definitions. Simple but duplicates tools across agents.

**B2. Shared tool DSL entities** — new `project_tool_files` collection with `dslContent` field. Agents reference via `FROM "tool-file-id" USE: tool1, tool2`. Shared across agents, stored in DB, edited via Studio UI.

**Recommended: B2** — maintains reusability while keeping DSL as source of truth. The `project_tool_files` entity is much simpler than the current `tools` + `tool_versions` system (one collection vs three, DSL string vs structured schema+config).

### 4.2 Architecture

```
┌───────────────────────────────────────────────┐
│  project_tool_files (NEW — simple collection)  │
│                                                │
│  { _id, tenantId, projectId, name,             │
│    dslContent: "TOOLS:\n  base_url: ...\n      │
│      search(q: string) -> object\n             │
│        type: http\n        endpoint: ...",     │
│    createdBy, updatedAt }                      │
└────────────────────┬──────────────────────────┘
                     │ referenced by
┌────────────────────▼──────────────────────────┐
│  Agent dslContent (project_agents)             │
│                                                │
│  TOOLS:                                        │
│    FROM "payments-api" USE: charge, refund     │
│                                                │
│    inline_tool(x: string) -> object            │
│      type: http                                │
│      endpoint: "{{env.API_URL}}/search"        │
│      headers:                                  │
│        Authorization: "{{secrets.API_KEY}}"    │
│                                                │
│         │                                      │
│         ▼                                      │
│    Parser → Compiler → IR                      │
│    (resolve FROM ref from DB, no tool entity   │
│     resolution needed)                         │
└───────────────────────────────────────────────┘

┌───────────────────────────────────────────────┐
│  Runtime                                       │
│  SecretsProvider resolves:                      │
│    {{env.X}}     → EnvironmentVariable (DB)    │
│    {{secrets.X}} → ToolSecret (DB)             │
└───────────────────────────────────────────────┘
```

### 4.3 The `project_tool_files` Entity

```typescript
interface IProjectToolFile {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string; // e.g., "payments-api", "mcp-search-tools"
  description: string | null;
  dslContent: string; // Full .tools.abl DSL content
  sourceHash: string; // For change detection
  source: 'manual' | 'discovered'; // How it was created
  createdBy: string;
  lastEditedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

This is dramatically simpler than `tools` + `tool_versions`:

- **1 collection** vs 3 (`tools`, `tool_versions`, `tool_secrets`)
- **1 field** for tool definition (`dslContent`) vs 20+ structured fields
- **No versioning lifecycle** — git/agent-version handles that
- **No type-specific schemas** — DSL is the universal format
- **No resolution pipeline** — parser reads DSL directly

Agent reference syntax adapts `FROM...USE` for DB-stored tool files:

```
FROM "payments-api" USE: charge_card, refund, get_balance
```

The compiler resolves `"payments-api"` → looks up `project_tool_files` by name → parses `dslContent` → merges tools.

### 4.4 What Gets Removed

| Component                          | Action                                                 |
| ---------------------------------- | ------------------------------------------------------ |
| `tools` MongoDB collection         | Delete                                                 |
| `tool_versions` MongoDB collection | Delete                                                 |
| Tool CRUD API (13+ routes)         | Replace with simple tool-file CRUD (4 routes)          |
| Tool UI (30+ components)           | Replace with DSL editor + form overlay (~5 components) |
| `resolveToolLinks()` pipeline      | Delete                                                 |
| `convertDbToolToIR()`              | Delete                                                 |
| `USE TOOL:` parser syntax          | Delete                                                 |
| `StaleToolBanner`                  | Delete                                                 |

### 4.5 What Remains

| Component                                | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `tool_secrets` collection                | Stores `{{secrets.X}}` values (encrypted, tenant-scoped) |
| `environment_variables` collection       | Stores `{{env.X}}` values (encrypted, per-environment)   |
| `SecretsProvider` interface              | Runtime resolution of placeholders                       |
| `.tools.abl` parser + import resolver    | Reusable tool library parsing (already exists)           |
| Inline tool parsing                      | Direct tool definitions in agent DSL                     |
| Config variable resolution               | `{{config.X}}` at compile time                           |
| **NEW**: `project_tool_files` collection | Simple DSL content storage for shared tools              |
| **NEW**: Tool file CRUD API (4 routes)   | List, get, create/update, delete                         |
| **NEW**: Tool file editor UI             | DSL editor with optional form overlay                    |

### 4.6 Strengths

**S1. Single source of truth**
Every tool is defined in exactly one place: either inline in an agent's TOOLS section or in a shared tool file (`project_tool_files.dslContent`). No sync between structured DB entities and DSL. No resolution pipeline. What you read in the DSL is what gets compiled.

**S2. AI-native**
AI generates complete, self-contained DSL with full tool definitions. No need for AI to know about slugs, DB IDs, or version pins. The generated DSL compiles directly. This is critical for AI-powered agent building workflows.

**S3. Simplified compilation**
Parse → compile → IR. The only DB lookup is resolving `FROM "name" USE: ...` → read `project_tool_files.dslContent` by name. No type-specific conversion, no version resolution, no slug matching. Compiler is deterministic — same DSL always produces same IR.

**S4. DSL is self-documenting and reviewable**
Agent DSL shows the complete tool interface (name, parameters, returns, description, type, binding). `FROM "payments-api" USE: charge, refund` is readable and the tool file content is inspectable. No hidden DB state that affects behavior.

**S5. Reusability via shared tool files**
Shared tool files stored in `project_tool_files`:

```
FROM "payments-api" USE: charge_card, refund, get_balance
```

Multiple agents import from the same tool file. Change the tool file → all importing agents get the update on next compile. Shared defaults (base_url, auth, timeout) reduce duplication.

**S6. Secrets remain secure**
`{{env.X}}` and `{{secrets.X}}` are runtime placeholders — never resolved at compile time, never stored in DSL. The `EnvironmentVariable` and `ToolSecret` collections (encrypted, tenant-scoped, environment-aware) remain. The `SecretsProvider` chain handles resolution at execution time.

**S7. Significant code reduction**
Delete `tools` + `tool_versions` collections, 13+ API routes, 30+ UI components, resolution pipeline, stale detection. Replace with 1 simple collection + 4 CRUD routes + ~5 UI components. Estimated net removal: 6,000–7,000 lines of code.

**S8. Environment-specific configuration is already solved**

```abl
endpoint: "{{env.STOCK_API_URL}}/v1/quote"
headers:
  X-Api-Key: "{{env.STOCK_API_KEY}}"
```

Different environments (dev, staging, prod) use different values for the same placeholder. This is managed via the Studio Environments UI (already exists).

**S9. DSL-level versioning via agent versions**
`agent_versions` already stores `dslContent` snapshots. Tool files can follow the same pattern — or simply version through the agent compilation snapshots that include resolved tool definitions in the IR.

### 4.7 Weaknesses

**W1. MCP discovery flow changes**
Currently, MCP discovery auto-creates DB tool entities. In Approach B, discovery would: (a) discover tools from server, (b) auto-generate a tool file DSL content, (c) create/update a `project_tool_files` entry. The flow changes from "create N DB entities" to "generate one DSL content blob" — conceptually similar, different mechanics.

_Mitigation_: Discovery auto-creates a `project_tool_files` entry with generated DSL content. One-click flow preserved — just writes DSL instead of structured entities.

**W2. Tool testing needs rebuild**
`ToolTestPanel` currently tests DB tools by ID. Needs rework to test from DSL definition (parse tool from `dslContent` → resolve secrets → execute).

_Mitigation_: Build "Test from DSL" feature. Parse tool definition from tool file DSL → execute with `SecretsProvider`. Architecturally simpler than DB-backed testing.

**W3. Form-based editing requires DSL ↔ form translation**
HTTP endpoint config, auth setup, retry/circuit-breaker — currently edited via structured forms. In Approach B, the form UI must read DSL → show form → write DSL. This is a bidirectional parser/serializer challenge.

_Mitigation_: Build a form overlay that parses `.tools.abl` DSL into structured form fields and serializes back. The existing `tool-file-parser.ts` already handles parsing; serialization is the new work.

**W4. Sandbox code in DSL content**
Sandbox tools with large `codeContent` would be embedded in DSL — potentially hundreds of lines mixed with tool metadata.

_Mitigation_: Support `code_file: "risk_calculator.py"` property referencing a separate content field or DB-stored code blob. Or accept that sandbox code in DSL is the same as "code in a config file" — a reasonable trade-off.

**W5. No independent tool-level version pinning**
Currently `USE TOOL: slug@v2` pins to a specific version. With tool files, the content is the single version. Agents always get the latest tool file content at compile time.

_Mitigation_: Agent versions (`agent_versions.dslContent` + `irContent`) already snapshot the full compilation. For explicit pinning, use named tool file variants: `FROM "payments-api-v2" USE: charge`.

**W6. Tool change impact across agents**
When a tool file changes, all importing agents are affected on next compile. No stale banner equivalent.

_Mitigation_: Compilation validation on tool file save — show which agents import this tool file and whether they still compile. This is a simpler check than the current stale tool detection.

### 4.8 Risks

| Risk                              | Severity | Mitigation                                          |
| --------------------------------- | -------- | --------------------------------------------------- |
| MCP discovery flow change         | Low      | Auto-generate tool file DSL from discovery          |
| Form ↔ DSL serialization bugs     | Medium   | Comprehensive round-trip tests                      |
| Sandbox code management           | Low      | `code_file:` or accept inline                       |
| Migration disruption              | Medium   | Phased migration with DB tool → DSL export          |
| Loss of granular tool permissions | Low      | Project-level permissions sufficient for most teams |

---

## 5. Approach C: Hybrid — DB for Runtime Config, DSL for Interface

### 5.1 Architecture

```
┌─────────────────────────────┐    ┌──────────────────────────┐
│  Agent DSL                   │    │  DB: tool_configs         │
│                              │    │  (runtime config only)    │
│  TOOLS:                      │    │                          │
│    search(q: string) -> obj  │    │  slug: "search"          │
│      type: http              │◄──▶│  httpConfig: { endpoint,  │
│      description: "..."      │    │    method, auth, headers } │
│                              │    │  timeoutMs: 5000          │
│                              │    │  cacheable: false         │
│         │                    │    └──────────────────────────┘
│         ▼                    │
│    Parser → Compiler → IR    │
│    + post-compile enrichment │
│      from DB configs         │
└─────────────────────────────┘
```

### 5.2 What Changes

| Component                  | Action                                                                          |
| -------------------------- | ------------------------------------------------------------------------------- |
| `tools` collection         | Replace with `tool_configs` (no name, no slug, no source — just runtime config) |
| `tool_versions` collection | Remove (config is flat, no versioning)                                          |
| Tool CRUD API              | Simplify to config-only API                                                     |
| Tool UI                    | Simplify to config editor (endpoint, auth, code)                                |
| Resolution pipeline        | Replace with name-based config matching                                         |
| `USE TOOL:` syntax         | Remove                                                                          |

### 5.3 Strengths

**S1. DSL carries the tool contract**
Tool interface (name, parameters, returns, description, type) lives in DSL. This is the compilable, reviewable, AI-friendly part.

**S2. Secrets stay in DB**
Runtime configs (endpoints, auth, code) remain in DB with encryption and access control. DSL never contains secrets.

**S3. Simpler than Approach A**
No versioning lifecycle, no slug management, no `USE TOOL:` resolution. Config is a flat key-value store keyed by tool name.

### 5.4 Weaknesses

**W1. Two sources of truth (still)**
Interface in DSL + config in DB. If DSL renames a tool, the DB config no longer matches. If DB config changes auth type, DSL might still say `type: http` with incompatible assumptions.

**W2. Name-matching fragility**
DB config is matched by tool name. Typos, renames, or convention differences cause silent failures — tool compiles fine from DSL but has no runtime binding.

**W3. No versioning on configs**
Config changes are immediate. No draft → publish. No rollback. A broken config change affects all agents immediately.

**W4. Unclear ownership**
Is the tool "interface" (DSL) or "config" (DB) the source of truth? When they disagree, which wins? This creates ambiguity for developers and the compiler.

**W5. Migration cost is high for little gain**
Must split existing tool data into two systems, rewrite the resolution pipeline, build new config matching. The result is arguably more complex than either A or B alone.

**W6. MCP discovery is awkward**
Discovery creates a DB config. But user must separately write the DSL interface. Two separate steps for one logical operation.

### 5.5 Risks

| Risk                                | Severity | Mitigation                              |
| ----------------------------------- | -------- | --------------------------------------- |
| Silent name-matching failures       | High     | Strict validation at compile time       |
| Interface/config drift              | High     | Sync validation tooling                 |
| Higher complexity than A or B alone | Medium   | Careful API design                      |
| Migration effort with unclear ROI   | High     | Thorough cost-benefit before committing |

---

## 6. Cross-Cutting Dimension Analysis

### 6.1 AI Generation

| Dimension                    |            A: DB Entities             |              B: DSL-Native               |                   C: Hybrid                    |
| ---------------------------- | :-----------------------------------: | :--------------------------------------: | :--------------------------------------------: |
| AI generates complete agent  | Partial — cannot generate `USE TOOL:` | **Full** — inline tools compile directly | Partial — generates interface, needs DB config |
| AI understands tool contract |            No (bare slug)             |     **Yes** (full signature in DSL)      |             Yes (interface in DSL)             |
| AI-generated DSL is portable |             No (needs DB)             |         **Yes** (self-contained)         |           Partial (needs DB config)            |
| AI can modify existing tools |            No (DB entity)             |            **Yes** (edit DSL)            |            Partial (interface only)            |

**Winner: B** — DSL-native is fully AI-compatible.

### 6.2 Security & Compliance

| Dimension                  |        A: DB Entities        |               B: DSL-Native                |  C: Hybrid   |
| -------------------------- | :--------------------------: | :----------------------------------------: | :----------: |
| Secrets in source code     |           No (DB)            |   **No** (`{{secrets.X}}` placeholders)    |   No (DB)    |
| Encryption at rest         | Yes (DB + encryption plugin) | **Yes** (ToolSecret + EnvironmentVariable) |   Yes (DB)   |
| Per-environment secrets    |             Yes              |   **Yes** (`{{env.X}}` per environment)    |     Yes      |
| Audit trail                |    Yes (DB audit plugin)     |           Partial (git history)            |   Partial    |
| Access control granularity |    Tool-level permissions    |             File/project-level             | Config-level |
| PCI/SOC 2 compliance       |             Full             |      **Full** (secrets never in DSL)       |     Full     |

**Winner: Tie (A ≈ B)** — Both are compliant. A has richer audit; B relies on git.

### 6.3 Reusability

| Dimension                        |               A: DB Entities                |                            B: DSL-Native                            |                   C: Hybrid                   |
| -------------------------------- | :-----------------------------------------: | :-----------------------------------------------------------------: | :-------------------------------------------: |
| Share tool across agents         | Yes (one DB tool, N agents via `USE TOOL:`) | **Yes** (one `project_tool_files` entry, N agents via `FROM...USE`) | Partial (config shared, interface duplicated) |
| Change once, update all          |               Yes (DB update)               |                     **Yes** (tool file update)                      |      Partial (config yes, interface no)       |
| Shared defaults (base_url, auth) |            No (per-tool config)             |                 **Yes** (tool file defaults block)                  |                      No                       |
| Cross-project sharing            |             No (project-scoped)             |           Possible (copy tool file DSL between projects)            |                      No                       |

**Winner: B** — Tool files with shared defaults and `FROM...USE` imports are more flexible.

### 6.4 MCP Tool Discovery

| Dimension              |         A: DB Entities          |                B: DSL-Native                 |                    C: Hybrid                    |
| ---------------------- | :-----------------------------: | :------------------------------------------: | :---------------------------------------------: |
| One-click discovery    | **Yes** (auto-creates DB tools) | **Yes** (auto-generates tool file DSL in DB) | Partial (creates config, user writes interface) |
| Schema from server     | **Yes** (stored as inputSchema) |     **Yes** (embedded in generated DSL)      |            Partial (in config only)             |
| Schema drift detection | **Yes** (re-discovery compares) |  **Yes** (re-discovery diffs tool file DSL)  |                     Partial                     |
| Server config linking  |  **Yes** (mcpConfig.serverId)   |           Yes (MCP binding in DSL)           |               Yes (in DB config)                |

**Winner: Tie (A ≈ B)** — Both can auto-create from discovery. A writes structured DB entities; B writes DSL content to `project_tool_files`. Same UX, different storage format.

### 6.5 Tool Testing

| Dimension                |        A: DB Entities         |             B: DSL-Native              |          C: Hybrid          |
| ------------------------ | :---------------------------: | :------------------------------------: | :-------------------------: |
| Test tool independently  | **Yes** (ToolTestPanel by ID) |  Possible (test from DSL definition)   | Possible (test from config) |
| Dynamic form from schema | **Yes** (JSON Schema → form)  | **Yes** (can generate from DSL params) |           **Yes**           |
| Test with secrets        |      **Yes** (DB-backed)      |   **Yes** (`{{secrets.X}}` resolved)   |           **Yes**           |

**Winner: Tie** — All approaches can support independent testing. A has it built already; B requires rebuilding.

### 6.6 Versioning

| Dimension             |            A: DB Entities            |       B: DSL-Native        | C: Hybrid |
| --------------------- | :----------------------------------: | :------------------------: | :-------: |
| Tool-level versioning | **Yes** (draft → named → published)  | No (git-based, file-level) |    No     |
| Version pinning       |           **Yes** (`@v2`)            |  No (file is the version)  |    No     |
| Rollback              | **Yes** (revert to previous version) |    **Yes** (git revert)    |    No     |
| Change history        |      **Yes** (DB version list)       |     **Yes** (git log)      |    No     |
| Immutable snapshots   |       **Yes** (named versions)       | **Yes** (git tags/commits) |    No     |

**Winner: Tie (A ≈ B)** — Different mechanisms, similar capabilities. A is UI-driven; B is git-driven.

### 6.7 Developer Experience

| Dimension             |          A: DB Entities          |                    B: DSL-Native                    |         C: Hybrid         |
| --------------------- | :------------------------------: | :-------------------------------------------------: | :-----------------------: |
| Onboarding complexity |        High (dual system)        |                 **Low** (DSL only)                  |    High (split system)    |
| Mental model          |    Two systems to understand     |                   **One system**                    | Two systems to understand |
| Code review           |  Partial (DSL only, DB hidden)   |  **Full** (everything in DSL — agent + tool files)  |          Partial          |
| IDE/Studio editing    | Separate tool forms + DSL editor | **Unified DSL editor** (with optional form overlay) |        Two editors        |
| Debugging             |          Check DB + DSL          |            **Check DSL** (single source)            |   Check DSL + DB config   |

**Winner: B** — Simpler mental model, single editing surface.

### 6.8 Non-Developer Users

| Dimension                |            A: DB Entities             |                 B: DSL-Native                 |       C: Hybrid        |
| ------------------------ | :-----------------------------------: | :-------------------------------------------: | :--------------------: |
| Form-based tool creation |      **Yes** (wizards per type)       | Possible (form overlay that reads/writes DSL) | Partial (config forms) |
| Visual tool management   | **Yes** (tool list page, detail page) |  **Yes** (tool file list + editor in Studio)  |        Partial         |
| No-code tool testing     |        **Yes** (ToolTestPanel)        |        Possible (test from DSL panel)         |        Possible        |

**Winner: A** — Has it built today. B can match with a form overlay on the DSL editor, but requires build investment.

### 6.9 Maintainability

| Dimension           |         A: DB Entities          |                  B: DSL-Native                  |             C: Hybrid             |
| ------------------- | :-----------------------------: | :---------------------------------------------: | :-------------------------------: |
| Code to maintain    | 5,000-8,000 lines (tool system) |   **~1,000 lines** (tool file CRUD + editor)    |    Medium (new config system)     |
| DB schema evolution |   Must migrate 3 collections    | **1 simple collection** (`project_tool_files`)  | Must migrate to new config schema |
| API surface         |           13+ routes            | **4 routes** (list, get, create/update, delete) |          New config API           |
| Test surface        |    Extensive (DB + API + UI)    | **Minimal** (parser tests exist + simple CRUD)  |              Medium               |
| Feature evolution   |    Must evolve DB + API + UI    |    **Evolve DSL syntax + tool file editor**     |   Must evolve DSL + config API    |

**Winner: B** — Dramatically lower maintenance burden. 1 simple collection vs 3 complex ones.

### 6.10 Scalability

| Dimension                   |              A: DB Entities               |                         B: DSL-Native                         |      C: Hybrid       |
| --------------------------- | :---------------------------------------: | :-----------------------------------------------------------: | :------------------: |
| Compile-time DB queries     | Yes (resolve tool links by slug, version) |    **Minimal** (resolve `FROM` ref by name — single query)    | Yes (match configs)  |
| Runtime DB queries          |           None (baked into IR)            |                   **None** (baked into IR)                    | None (baked into IR) |
| Large projects (100+ tools) |              DB handles well              |  **DB handles well** (`project_tool_files` indexed by name)   |   DB handles well    |
| Multi-tenant data isolation |                DB indexes                 | **DB indexes** (tenantId + projectId on `project_tool_files`) |      DB indexes      |

**Winner: Tie (A ≈ B)** — Both use DB; B has simpler queries (name lookup vs slug+version resolution).

### 6.11 Migration Cost

| Dimension              |   A: DB Entities   |                                 B: DSL-Native                                  |        C: Hybrid         |
| ---------------------- | :----------------: | :----------------------------------------------------------------------------: | :----------------------: |
| Migration effort       | **None** (current) | Medium (export DB tools → `project_tool_files` DSL, delete old infrastructure) | High (split and rewrite) |
| Backward compatibility |      **Full**      |            Needs transition period (support both during migration)             | Needs transition period  |
| Data loss risk         |      **None**      |           Low (DB-to-DB migration, automated export with validation)           |          Medium          |
| Timeline estimate      |       **0**        |                                   2-4 weeks                                    |        3-5 weeks         |

**Winner: A** — No migration needed. B migration is lower risk than originally estimated since it's DB-to-DB (not DB-to-filesystem).

---

## 7. Summary Scorecard

| Dimension             | Weight | A: DB Entities | B: DSL-Native | C: Hybrid |
| --------------------- | ------ | :------------: | :-----------: | :-------: |
| AI Generation         | High   |       2        |     **5**     |     3     |
| Security & Compliance | High   |       5        |     **5**     |     5     |
| Reusability           | High   |       4        |     **5**     |     3     |
| MCP Discovery         | Medium |       5        |     **5**     |     2     |
| Tool Testing          | Medium |     **5**      |       4       |     4     |
| Versioning            | Medium |       4        |       4       |     2     |
| Developer Experience  | High   |       2        |     **5**     |     2     |
| Non-Developer Users   | Medium |     **5**      |       3       |     3     |
| Maintainability       | High   |       2        |     **5**     |     3     |
| Scalability           | Low    |       4        |       4       |     4     |
| Migration Cost        | Medium |     **5**      |       3       |     2     |
| **Weighted Total**    |        |    **3.4**     |    **4.4**    |  **2.9**  |

_(Weights: High=3x, Medium=2x, Low=1x. Scores 1-5.)_

**Score adjustments from corrected model (B stores tool DSL in DB, not filesystem):**

- MCP Discovery: B raised 3→5 (auto-generate tool file in DB is equivalent UX to auto-create DB entity)
- Non-Developer Users: B raised 2→3 (Studio tool file editor with form overlay is feasible)
- Scalability: B lowered 5→4 (still uses DB queries, just simpler ones)
- Migration Cost: B raised 2→3 (DB-to-DB migration is lower risk than DB-to-filesystem)

---

## 8. Recommendation

### Primary Recommendation: Approach B (DSL-Native) with DB-Stored Tool Files

**Rationale**: The DSL-native tool system is already built and production-capable. The DB tool system adds complexity (30+ components, 13+ routes, 3 collections, resolution pipeline) for benefits that are either already solved by DSL mechanisms (reusability via `FROM...USE`, secrets via `{{env.X}}`/`{{secrets.X}}`) or can be rebuilt more simply (testing, MCP discovery).

The corrected Approach B stores tool DSL in the database (`project_tool_files.dslContent`) — the same pattern already used for agents (`project_agents.dslContent`). This eliminates the filesystem concerns while achieving the simplicity benefits.

For an enterprise platform focused on long-term maintainability, reducing the code surface while maintaining capability is the optimal path.

### Migration Strategy

**Phase 1: Build new tool file infrastructure (2 weeks)**

- Create `project_tool_files` MongoDB collection (schema, model, indexes)
- Build tool file CRUD API (4 routes: list, get, create/update, delete)
- Build tool file editor UI in Studio (DSL editor with optional form overlay for HTTP/MCP/Sandbox)
- Build "Test from DSL" panel (parse tool from tool file DSL → execute with `SecretsProvider`)
- Update MCP discovery to generate tool file DSL content → write to `project_tool_files`
- Update compiler's `FROM...USE` resolver to look up `project_tool_files` by name (in addition to filesystem paths)

**Phase 2: Migration tooling (1 week)**

- Build migration script: for each project, export DB tools → generate `.tools.abl` DSL → create `project_tool_files` entries
- Build agent migration: replace `USE TOOL: slug` in `dslContent` with `FROM "tool-file-name" USE: tool1, tool2`
- Validate: compile all agents with both old (DB entity) and new (tool file) resolution, diff IR output for equivalence

**Phase 3: Remove old DB tool infrastructure (1 week)**

- Delete `tools` and `tool_versions` MongoDB collections
- Delete tool CRUD API routes (13+)
- Delete tool UI components (30+)
- Delete resolution pipeline (`resolveToolLinks`, `convertDbToolToIR`, `loadProjectToolsAsIR`)
- Delete `USE TOOL:` parser syntax
- Keep: `tool_secrets`, `environment_variables`, `SecretsProvider`, `project_tool_files`

**Phase 4: Polish (1 week)**

- Update documentation
- Update CLAUDE.md (remove `USE TOOL` references, document `FROM...USE` with tool file patterns)
- Update examples

### What to Build (New)

| Component                               | Purpose                                                     | Complexity |
| --------------------------------------- | ----------------------------------------------------------- | ---------- |
| `project_tool_files` collection + model | Simple DSL content storage (1 collection, ~50 lines)        | Low        |
| Tool file CRUD API (4 routes)           | List, get, create/update, delete                            | Low        |
| Tool file editor UI                     | DSL editor + form overlay (replaces 30+ components with ~5) | Medium     |
| "Test from DSL" panel                   | Parse tool from DSL → execute with `SecretsProvider`        | Low        |
| MCP discovery → tool file DSL generator | Generate DSL content from discovered MCP tools              | Low        |
| `FROM...USE` DB resolver                | Compiler resolves `FROM "name"` from `project_tool_files`   | Low        |
| Migration script                        | Export DB tools → `project_tool_files` entries              | Medium     |

### What to Keep (Existing)

| Component                                     | Purpose                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `tool_secrets` collection                     | Encrypted secret storage                                    |
| `environment_variables` collection            | Per-environment config values                               |
| `SecretsProvider` interface + implementations | Runtime `{{secrets.X}}` / `{{env.X}}` resolution            |
| `.tools.abl` parser + import resolver         | Already production-ready (reused for tool file DSL parsing) |
| Inline tool parsing in agent DSL              | Already production-ready                                    |
| Config variable resolution (`{{config.X}}`)   | Already production-ready                                    |

### What to Delete

| Component                                                           | Lines (est.)             |
| ------------------------------------------------------------------- | ------------------------ |
| MongoDB: `tools`, `tool_versions` models                            | ~250                     |
| Tool repos (`tool-repo.ts`, `tool-version-repo.ts`)                 | ~500                     |
| Tool API routes (13+ routes)                                        | ~1,500                   |
| Tool UI components (30+)                                            | ~4,000                   |
| Resolution pipeline (`resolveToolLinks`, `convertDbToolToIR`, etc.) | ~500                     |
| Tool store (Zustand)                                                | ~200                     |
| `USE TOOL:` parser syntax                                           | ~100                     |
| Tests for above                                                     | ~1,500                   |
| **Total estimated removal**                                         | **~8,500 lines**         |
| **Net after new code (~1,000 lines)**                               | **~7,500 lines removed** |

---

## 9. Addressing Concerns

### "What about non-developer users who need form-based editing?"

Build a tool file editor with a form overlay. The editor shows DSL (source of truth) with a side panel that presents structured form inputs for the currently selected tool (endpoint, method, auth, headers, etc.). Form changes write back to DSL. This is simpler than the current system — one editor component, instead of 30+ components managing DB entities with versioning.

### "What about MCP discovery?"

Discovery flow is preserved: discover tools from server → auto-generate tool file DSL content → create a `project_tool_files` entry. The Studio UI shows the generated content and offers to save. The UX is identical — one-click discovery, auto-populated tools. The only difference is the storage format (DSL string vs structured DB entities).

### "What about independent tool testing?"

Build a lightweight "Test Tool" panel that: parses a tool definition from DSL text → resolves `{{env.X}}`/`{{secrets.X}}` via `SecretsProvider` → executes the tool → shows results. This is simpler than the current DB-backed testing because there's no entity lookup, no version resolution, no ID-based routing.

### "What about tool versioning?"

Agent versions (`agent_versions`) already snapshot `dslContent` + `irContent` — this captures the exact tool definitions used at publish time. Tool files themselves track `updatedAt` and `sourceHash` for change detection. For explicit version pinning, use named tool file variants: `FROM "payments-api-v2" USE: charge`. For most enterprise teams, the agent version snapshot provides sufficient audit trail.

### "What about the migration risk?"

Phase 2 includes IR-level validation: compile all agents with both old (DB entity resolution) and new (`project_tool_files` DSL resolution) and diff the IR output. Since both paths ultimately produce the same `ToolDefinition` IR, this guarantees functional equivalence before deleting any old infrastructure. The migration is DB-to-DB (not DB-to-filesystem), which is lower risk and fully automatable.

---

## 10. Decision Matrix for Stakeholders

| If your priority is...                | Choose... | Because...                                                |
| ------------------------------------- | --------- | --------------------------------------------------------- |
| AI-powered agent building             | **B**     | AI generates complete, compilable DSL                     |
| Minimum maintenance burden            | **B**     | Net removal of ~7,500 lines, 2 collections, 9+ routes     |
| Non-developer user experience         | A         | Form-based wizards already built                          |
| Fastest time to market (no migration) | A         | Zero migration needed                                     |
| Long-term platform simplicity         | **B**     | Single source of truth (DSL), one mental model, DB-stored |
| Maximum compliance audit trail        | A         | DB-level audit plugins on tool entities                   |
| MCP-heavy workflows                   | **Tie**   | Both can auto-create from discovery                       |
| Developer experience                  | **B**     | Single DSL surface, reviewable, no hidden DB state        |
| Consistency with agent storage        | **B**     | Same pattern as `project_agents.dslContent`               |

---

## 11. Conclusion

Approach B (DSL-Native with DB-stored tool files) is the recommended path for enterprise long-term maintainability. The corrected model — storing tool DSL in `project_tool_files.dslContent` rather than on the filesystem — aligns with the platform's existing pattern for agents (`project_agents.dslContent`) and eliminates the original concerns about filesystem dependencies in production.

The key insight: the platform already has a production-capable DSL tool system (parser, compiler, secret placeholders, shared defaults, imports). The DB tool entity system is a parallel infrastructure that adds complexity without unique capabilities that DSL can't match. Consolidating to DSL-as-source-of-truth with simple DB storage reduces the codebase by ~7,500 lines while maintaining all enterprise requirements (security, compliance, reusability, MCP discovery, testing).
