# ABL Extensions Roadmap — Design Document

**Date**: 2026-03-01
**Status**: Approved
**Scope**: Authoring experience, import/export, CLI model management, AI-assisted authoring, documentation, SDK generation, LSP/VS Code extension

---

## 1. Overview

This design covers the next phase of ABL platform evolution: making ABL a first-class development experience across editors, CLI, and AI-assisted workflows. The guiding principles are:

- **YAML-first**: All new authoring targets YAML format. Legacy format supported for reading/migration only.
- **Shared intelligence**: A single `abl-language-service` package powers all consumers (Studio, CLI, MCP, VS Code).
- **AI-native authoring**: Both human developers and AI models (Claude Code, Arch) can create and modify agents programmatically.

**Architecture**:

```
                  +-------------------------------------------------+
                  |          abl-language-service                    |
                  |  (completions, diagnostics, symbols, hover)      |
                  +----------+-----------+-----------+---------------+
                             |           |           |
                      +------v---+  +----v-----+  +-v-----------+
                      | Studio   |  |  LSP     |  |  CLI/MCP    |
                      | Monaco   |  | Server   |  |  Direct     |
                      | (API)    |  | (thin)   |  |  calls      |
                      +----------+  +----+-----+  +-------------+
                                         |
                                 +-------+-------+
                                 |       |       |
                              VS Code  Neovim  JetBrains
```

---

## 2. ABL Language Service Package

**Package**: `packages/abl-language-service`

Shared intelligence core wrapping the parser (`@abl/core`) and compiler (`@abl/compiler`).

### API Surface

```typescript
class ABLLanguageService {
  getDiagnostics(source: string, format: 'yaml' | 'legacy'): Diagnostic[];
  getCompletions(source: string, position: Position, context: CompletionContext): CompletionItem[];
  getDocumentSymbols(source: string): DocumentSymbol[];
  getHoverInfo(source: string, position: Position): HoverInfo | null;
  format(source: string, options: FormatOptions): string;
  detectFormat(source: string): 'yaml' | 'legacy';
}
```

### Design Decisions

1. **Stateless functions** — no session state, no caching. Consumers handle caching (Monaco debounces, CLI is one-shot).

2. **Format-aware** — every method accepts both YAML and legacy format. `detectFormat()` runs first, then delegates to the appropriate parser branch. The YAML branch uses `packages/core/src/parser/yaml-parser.ts` (already exists).

3. **Completion context** — completions need to know what the user is typing and where:

   | Context                      | Suggestions                                                            |
   | ---------------------------- | ---------------------------------------------------------------------- |
   | Top-level (empty line)       | `AGENT:`, `SUPERVISOR:`, `MODE:`, `GOAL:`, etc.                        |
   | Inside `TOOLS:`              | Project tools (passed via `CompletionContext.availableTools`)          |
   | Inside `FLOW:` step body     | `WHEN`, `RESPOND`, `CALL`, `SET`, `CLEAR`, `HANDOFF`                   |
   | `HANDOFF TO` / `DELEGATE TO` | Known agent names in project                                           |
   | `condition:` value           | CEL functions (`abl.contains`, `abl.length`, etc.) + context variables |
   | `GATHER:` field              | `type:`, `required:`, `validation:`, `extraction_hints:`               |

4. **Document symbols** — returns a tree structure matching the ABL hierarchy:

   ```
   Agent "booking_agent"
   +-- Goal
   +-- Tools
   |   +-- search_hotels
   |   +-- book_room
   +-- Flow
   |   +-- Step: greeting
   |   +-- Step: search
   |   +-- Step: confirm
   +-- Constraints
   +-- Handoffs
       +-- -> support_agent
   ```

5. **Dependencies** — only depends on `@abl/core` (parser) and `@abl/compiler` (for compile-level diagnostics). No Studio or CLI dependencies.

---

## 3. Studio Authoring Experience

### 3a. YAML Mode in Monaco

**Current state**: Monaco has a custom `abl` language with Monarch tokenizer for legacy format only.

**Change**: Register `abl-yaml` language mode with format auto-detection:

- Auto-detect format on file open via `languageService.detectFormat(content)`
- YAML tokenizer: Monarch rules with YAML syntax (keys, values, block scalars). ABL keywords (`mode:`, `goal:`, `tools:`, `flow:`) get keyword highlighting. CEL expressions inside `condition:` values get expression highlighting.
- Fallback to legacy format if detection is ambiguous.
- Implementation: New Monarch tokenizer extracted to `lib/abl-monarch.ts`.

### 3b. Tree-View Navigator

**Current state**: No structural navigation — flat code editor only.

**Change**: Collapsible sidebar panel to the left of the editor:

- Calls `languageService.getDocumentSymbols()` on content change (debounced)
- Tree structure: Agent -> sections (Tools, Flow, Constraints, etc.) -> items
- Click symbol -> editor scrolls to line (`editor.revealLineInCenter()`)
- Active symbol highlighted based on cursor position
- Icons per symbol type (agent, tool wrench, flow step arrow, constraint shield)
- New `ABLSymbolTree.tsx` component alongside `ABLEditor.tsx`
- Layout: `[SymbolTree (250px) | Monaco Editor (flex)]` with resizable divider, toggleable via toolbar button

### 3c. Smart Autocomplete

**Current state**: Tool name autocomplete only, inside `TOOLS:` section, 30s cache.

**Change**: Context-aware completions everywhere via language service:

- Top-level sections, flow step keywords, CEL functions, handoff targets, gather field properties
- Trigger characters: `:` (after section keywords), `.` (for CEL dotted paths), `{` (for template variables)
- Studio passes `CompletionContext` with `availableTools` and `availableAgents` from project API

### 3d. Live Validation and Diagnostics

**Current state**: Parse errors on 500ms debounce. Compile errors only on explicit "Compile" click.

**Change**: Unified diagnostics pipeline with tiered validation:

- **Tier 1 (fast, every keystroke, ~5ms)**: Syntax validation (parse only)
- **Tier 2 (medium, 1s debounce, ~50ms)**: Structural validation (tool refs, step refs, required fields)
- **Tier 3 (slow, explicit compile, ~500ms+)**: Full compilation with tool resolution

Monaco markers: red squiggles for errors, yellow for warnings, blue for info/hints. Diagnostics panel at bottom with clickable navigation. Status bar with severity counts.

---

## 4. Import/Export Improvements

### 4a. YAML Export

- New `serializeToYAML(ir: AgentIR): string` function in the language service
- Export route gains `?format=yaml` (default) or `?format=legacy` query param
- YAML export produces `.agent.yaml` files instead of `.agent.abl`
- `project.json` gains `format: 'yaml'` field
- Import auto-detects format (YAML or legacy)

### 4b. Agent Packaging (.abl bundles)

Single compressed archive format:

```
my-agent.abl (tar.gz)
+-- manifest.json          # name, version, format, dependencies
+-- agents/
|   +-- booking.agent.yaml
|   +-- support.agent.yaml
+-- tools/
|   +-- tool-definitions.json
+-- config/
    +-- project.json
```

- CLI: `kore export --bundle my-project.abl` / `kore import my-project.abl`
- Studio: "Download as .abl bundle" option
- Bundles are versioned (semver in manifest)

---

## 5. CLI Model Management

### New Commands

```bash
kore models list                                    # List models for current tenant
kore models add --provider anthropic --model ...     # Add model (prompts for API key)
kore models test <model-name>                        # Test connectivity
kore models set-default <model-name> --project ...   # Set project default
kore models remove <model-name>                      # Remove model
```

### Implementation

- New `src/commands/models.ts` in `kore-platform-cli`
- Calls existing Studio API routes (`/api/tenant-models`, `/api/llm-credentials`)
- `models add` creates both `LLMCredential` + `TenantModel` in one command
- Corresponding MCP tools: `kore_list_models`, `kore_add_model`, `kore_test_model`, `kore_set_default_model`

---

## 6. AI-Assisted Agent Authoring

### 6a. MCP Authoring Tools

New tools in the MCP server for programmatic agent creation:

| Tool                    | Purpose                             |
| ----------------------- | ----------------------------------- |
| `kore_create_agent`     | Create a new agent in a project     |
| `kore_add_tool`         | Add a tool reference to an agent    |
| `kore_add_flow_step`    | Add a flow step to a scripted agent |
| `kore_add_constraint`   | Add a constraint                    |
| `kore_add_handoff`      | Add a handoff target                |
| `kore_update_agent_dsl` | Replace full DSL content            |
| `kore_validate_agent`   | Validate agent DSL                  |
| `kore_compile_agent`    | Compile agent DSL to IR             |
| `kore_list_agents`      | List agents in project              |
| `kore_get_agent_dsl`    | Get agent's current DSL             |

Design principles: granular tools for incremental modifications, full DSL tools for wholesale creation, auto-validation after every mutation, YAML-first generation.

### 6b. Natural Language to ABL Generation

Enhance existing architect tools:

- Update `kore_architect_generate` to produce YAML format by default
- New `kore_architect_refine`: takes existing DSL + natural language instruction, returns modified DSL
- Enables iterative refinement rather than full regeneration

### 6c. MCP Testing Tools

| Tool                     | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `kore_test_conversation` | Run test conversation against deployed agent |
| `kore_test_scenario`     | Run scenario with expected outcomes          |
| `kore_get_test_results`  | Get test results / session trace             |

Testing tools create headless sessions, send messages, and return full traces for behavioral validation.

### 6d. Arch as In-Studio ABL Authoring Assistant

Extend Arch (existing Studio AI assistant) to be an ABL co-pilot:

- **Context awareness**: When user is in ABL editor, Arch receives current DSL as context
- **Troubleshoot**: Arch calls `getDocumentSymbols()` to understand flow graph, analyzes transitions
- **Modify**: Proposes DSL modifications via `propose_modification`, generating YAML-format patches
- **Test**: Triggers test conversations via test infrastructure, shows trace with annotations
- **Explain**: Uses hover info from language service to explain DSL sections

New Arch tools: `test_agent`, `explain_dsl`, `suggest_improvements`

### 6e. Arch-Guided Onboarding

Enhanced onboarding flow with Arch as pair-programming partner:

1. **Ideate** (existing): User describes use case -> Arch suggests agent topology
2. **Generate** (new): Arch calls architect tools to produce YAML ABL scaffold with explanations
3. **Refine** (new): Arch walks user through each section, explains decisions, offers adjustments
4. **Test** (enhanced): Arch runs test conversations, shows annotated traces, suggests path coverage
5. **Deploy** (existing): Arch guides deployment with model selection

Key principle: Arch pair-programs through the entire first-agent experience, not just generate-and-hand-off.

---

## 7. ABL Documentation

### 7a. Expanded Embedded Docs

New topics added to the doc system:

- `yaml-format` — YAML ABL syntax with examples
- `cel-functions` — All 35 `abl.*` functions with signatures, descriptions, examples
- `extensions` — Gather, Constraints, Memory, Coordination, Rich Content
- `tools` — Tool definition patterns (HTTP, MCP, Sandbox, Lambda)
- `best-practices` — Common patterns, anti-patterns, performance tips

CEL function docs auto-generated from the function registry in `packages/core/src/cel/abl-functions.ts`.

### 7b. In-Editor Docs

Language service's `getHoverInfo()` pulls from doc content:

- Hover over `GATHER:` -> gather extension syntax + example
- Hover over `abl.contains()` -> function signature + description
- Hover over `MODE: reasoning` -> reasoning mode behavior

### 7c. Documentation Site

Studio route `/docs/abl` that renders docs from the language service's doc content. Navigable, searchable, linked from in-editor hover tooltips.

---

## 8. SDK Generation

### Two-Layer Architecture

**Layer 1: Stable Base SDK** (`@agent-platform/sdk`)

Generic client for any agent. Never needs regeneration.

```typescript
const client = new AgentClient({ baseUrl, projectId, apiKey });
const session = await client.startSession('booking_agent');
const response = await session.sendMessage('Book a hotel in Paris');

session.onMessage((msg) => console.log(msg.content));
session.onToolCall((tool) => console.log(tool.name, tool.params));
session.onHandoff((target) => console.log('Handed off to', target));
```

**Layer 2: Optional Type Overlays** (generated, agent-specific, `.d.ts` only)

```typescript
import type { BookingAgentTypes } from './generated/booking-agent.types';

const session = await client.startSession<BookingAgentTypes>('booking_agent');
session.provideField('destination', 'Paris'); // autocomplete + type checking
```

Type overlays are optional, type-only (zero bundle impact), independently versioned, and generated on demand.

### Three Communication Modes

**1. WebSocket (real-time, streaming)**

- SDK opens WS connection to runtime
- Sends messages, receives streaming events (LLM tokens, tool calls, state changes)

**2. REST (simple request/response)**

- `POST /api/sessions/:id/messages` -> blocks until processing completes
- Returns full response (messages, tool calls, gather state)

**3. Webhooks (async)**

- SDK registers callback URL at session creation
- Runtime POSTs events to webhook URL as they happen
- HMAC-SHA256 signature verification, retry with exponential backoff
- Event filtering, correlation IDs
- Use cases: serverless functions, queue-based architectures, Slack/Teams bots

### Authentication

- **Server-side**: API key (tenant-scoped)
- **Client-side**: Session token (from SDK init endpoint)

### Generation Pipeline

1. Input: Compiled IR (AgentIR) from compiler
2. Extract: Gather fields -> typed parameters. Flow steps -> event types.
3. Generate: TypeScript `.d.ts` type overlays. Python type hints (pydantic).
4. Output: Downloadable package or installable SDK

CLI: `kore sdk generate --project my-project --language typescript --output ./generated/`
MCP tool: `kore_generate_sdk`
Studio: "Generate SDK" button on agent detail page

### Regeneration Strategy

- **Manual**: `kore sdk generate` or Studio button
- **On deployment**: Auto-regenerate when agent is compiled and deployed
- Version derived from compilation hash for compile-time breakage detection

---

## 9. LSP Server + VS Code Extension

### 9a. ABL LSP Server

**Package**: `packages/abl-lsp-server`

Thin protocol adapter wrapping the language service (~30-50 lines per adapter):

```
packages/abl-lsp-server/
+-- src/
    +-- server.ts          # LSP server entry (vscode-languageserver)
    +-- capabilities.ts    # Declared LSP capabilities
    +-- adapters/
        +-- completions.ts # LanguageService -> LSP CompletionItem
        +-- diagnostics.ts # LanguageService -> LSP Diagnostic
        +-- symbols.ts     # LanguageService -> LSP DocumentSymbol
        +-- hover.ts       # LanguageService -> LSP Hover
```

Dependencies: `vscode-languageserver`, `vscode-languageserver-textdocument`, `abl-language-service`
Communication: Stdio (for VS Code) or TCP (for other editors)

### 9b. VS Code Extension

**Package**: `packages/abl-vscode` (published as `kore-abl` on Marketplace)

```
packages/abl-vscode/
+-- src/
|   +-- extension.ts       # Activate: start LSP server, register file associations
+-- syntaxes/
|   +-- abl.tmLanguage.json # TextMate grammar for .agent.yaml and .agent.abl
+-- snippets/
|   +-- abl.snippets.json   # Code snippets
+-- language-configuration.json
+-- package.json            # Extension manifest
```

Features:

- File associations: `.agent.yaml`, `.agent.abl` -> ABL language mode
- TextMate grammar for offline syntax highlighting
- Full LSP: completions, diagnostics, hover, document symbols, go-to-definition
- Snippets: `agent` (scaffold), `step` (flow step), `tool` (tool definition)
- Commands: "ABL: Compile", "ABL: Validate", "ABL: Generate SDK"
- Project-aware: fetches tools and agent names from platform when authenticated via CLI

---

## 10. Implementation Phases

### Phase 1: Foundation (Language Service + YAML Mode)

- `packages/abl-language-service` with diagnostics, completions, symbols, hover, format detection
- YAML Monarch tokenizer in Studio Monaco editor
- Live validation with tiered diagnostics

### Phase 2: Studio Authoring (Tree-View + Autocomplete)

- Tree-view navigator sidebar
- Smart context-aware autocomplete
- Diagnostics panel

### Phase 3: Import/Export + CLI

- YAML export format
- .abl bundle packaging
- CLI model management commands

### Phase 4: AI Authoring + Arch

- MCP authoring tools (create, modify, validate agents)
- NL-to-ABL generation (YAML output)
- Testing tools (headless conversations)
- Arch ABL co-pilot tools
- Arch-guided onboarding flow

### Phase 5: Documentation

- Expanded embedded docs (YAML, CEL, extensions)
- In-editor hover docs
- Studio docs route

### Phase 6: SDK Generation

- Base SDK package (`@agent-platform/sdk`)
- Type overlay generator
- WebSocket, REST, webhook communication modes
- CLI `kore sdk generate` command

### Phase 7: LSP + VS Code

- ABL LSP server
- VS Code extension with TextMate grammar and snippets

---

## 11. Files Modified (by phase)

### Phase 1

| File                                                     | Changes                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/abl-language-service/` (NEW)                   | Full package: diagnostics, completions, symbols, hover, format |
| `apps/studio/src/components/abl/ABLEditor.tsx`           | YAML Monarch tokenizer, wire language service                  |
| `apps/studio/src/lib/abl-monarch.ts` (NEW)               | Extracted tokenizer definitions                                |
| `apps/studio/src/app/api/abl/diagnostics/route.ts` (NEW) | API route for language service                                 |

### Phase 2

| File                                                     | Changes                             |
| -------------------------------------------------------- | ----------------------------------- |
| `apps/studio/src/components/abl/ABLSymbolTree.tsx` (NEW) | Tree-view navigator                 |
| `apps/studio/src/components/abl/ABLEditor.tsx`           | Layout changes, autocomplete wiring |
| `apps/studio/src/store/editor-store.ts`                  | Add symbols state                   |

### Phase 3

| File                                                        | Changes                   |
| ----------------------------------------------------------- | ------------------------- |
| `packages/abl-language-service/src/serialize-yaml.ts` (NEW) | IR -> YAML serializer     |
| `apps/studio/src/app/api/projects/.../export/route.ts`      | YAML format support       |
| `packages/kore-platform-cli/src/commands/models.ts` (NEW)   | Model management commands |
| `packages/kore-platform-cli/src/mcp/server.ts`              | Register model MCP tools  |

### Phase 4

| File                                                  | Changes                                 |
| ----------------------------------------------------- | --------------------------------------- |
| `packages/kore-platform-cli/src/mcp/authoring/` (NEW) | MCP authoring tools                     |
| `packages/kore-platform-cli/src/mcp/testing/` (NEW)   | MCP testing tools                       |
| `packages/kore-platform-cli/src/mcp/server.ts`        | Register new tools                      |
| `apps/studio/src/lib/arch-tools.ts`                   | New Arch tools (test, explain, suggest) |
| `apps/studio/src/components/arch/`                    | Arch onboarding flow enhancements       |

### Phase 5

| File                                         | Changes          |
| -------------------------------------------- | ---------------- |
| `packages/kore-platform-cli/src/mcp/docs/`   | New doc topics   |
| `packages/abl-language-service/src/hover.ts` | Wire doc content |
| `apps/studio/src/app/docs/abl/` (NEW)        | Docs route       |

### Phase 6

| File                                                   | Changes                |
| ------------------------------------------------------ | ---------------------- |
| `packages/sdk/` (NEW)                                  | Base SDK package       |
| `packages/sdk-generator/` (NEW)                        | Type overlay generator |
| `packages/kore-platform-cli/src/commands/sdk.ts` (NEW) | CLI sdk generate       |

### Phase 7

| File                             | Changes              |
| -------------------------------- | -------------------- |
| `packages/abl-lsp-server/` (NEW) | LSP protocol adapter |
| `packages/abl-vscode/` (NEW)     | VS Code extension    |

---

## 12. Design Review — Issues & Resolutions

Three-phase review conducted against the existing codebase and CLAUDE.md guidelines.

### Critical Issues

**C1. `@abl/compiler` has server-only dependencies (AWS SDK, Pino, @agent-platform/config)**

- **Impact**: Language service cannot be bundled for VS Code extension or browser execution.
- **Resolution**: Use dependency injection for compile-level diagnostics. The language service constructor accepts an optional `compileFn: (source: string) => CompileDiagnostic[]`. In Studio/CLI context, pass the real compiler. In VS Code/browser context, omit it (Tier 3 diagnostics disabled gracefully). This avoids a compiler-lite split while keeping the language service lightweight.

**C2. YAML parser missing `parseFlow()` — flow steps silently dropped**

- **Impact**: Document symbols, flow step completions, and `kore_add_flow_step` all depend on parsed flow data.
- **Resolution**: Phase 1 prerequisite: implement `parseFlow()` in `packages/core/src/parser/yaml-parser.ts`. The legacy parser already has flow parsing logic — port it to the YAML branch. Add to Phase 1 files list.

**C3. Webhook mode requires runtime infrastructure, not just SDK**

- **Impact**: No outbound HTTP delivery, retry queue, or webhook registration exists in the runtime.
- **Resolution**: Move webhook support to a Phase 6b sub-phase with explicit runtime scope: (1) webhook registration storage (per-session, in MongoDB), (2) outbound delivery with HMAC signing via a new `WebhookDeliveryService`, (3) retry queue via BullMQ, (4) SSRF protection on webhook URLs (block private IPs, metadata endpoints per CLAUDE.md). SDK just calls `POST /api/sessions` with `{ webhook: { url, secret, events } }`.

**C4. MCP authoring tool schemas missing `projectId`**

- **Impact**: Breaks tenant isolation (Platform Principle 1).
- **Resolution**: All mutation MCP tools (`kore_create_agent`, `kore_add_tool`, `kore_update_agent_dsl`, etc.) require `projectId` as a mandatory parameter. The CLI resolves `projectId` from `currentProjectId` config if not provided. Server-side routes verify project-to-tenant ownership via `requireProjectPermission`. Updated tool table in Section 6a to show `projectId` parameter.

### Important Issues

**I5. Tier 1 validation (~5ms) cannot work over HTTP roundtrip**

- **Resolution**: Tier 1 runs client-side in the browser. Bundle `@abl/core`'s YAML syntax validator (not the full parser) for browser use. `js-yaml` is already browser-safe. Tier 2+ runs server-side via API routes with debouncing.

**I6. `packages/web-sdk` already exists and overlaps with proposed `packages/sdk`**

- **Resolution**: The existing `packages/web-sdk` (`@anthropic/agent-sdk`) is a browser-embeddable widget SDK (chat UI, voice, session management). The proposed `packages/sdk` (`@agent-platform/sdk`) is a server-side integration SDK for programmatic access (no UI, API key auth, Node.js). These serve different audiences. Document the distinction explicitly. Rename proposed package to `packages/server-sdk` to make the separation clear.

**I7. `packages/project-io` already handles export/import**

- **Resolution**: Build `.abl bundle` on top of `packages/project-io`. The bundle is `project-io`'s output compressed into a single tar.gz with a version-stamped manifest. No parallel format.

**I8. LOCAL vs REMOTE MCP tool classification for mutations**

- **Resolution**: All MCP tools that call the platform API (create, update, delete) are classified as REMOTE. Only pure-local tools (validate syntax, search docs, analyze locally) are LOCAL. `kore_validate_agent` with DSL input (no API call) = LOCAL. `kore_create_agent` = REMOTE. Update Section 6a to annotate each tool's classification.

**I9. Webhook SSRF protection not mentioned**

- **Resolution**: Added to C3 resolution. Webhook URL validation uses the same SSRF blocklist as tool execution HTTP calls (block 10.x, 169.254.x, 172.16-31.x, 192.168.x, and cloud metadata endpoints).

**I10. `readFileSync`/`statSync` in MCP server async handlers**

- **Resolution**: Fix as part of Phase 4 MCP server refactoring. Replace with `fs.promises.readFile`/`fs.promises.stat`. Include MCP server cleanup (tool registry pattern) in Phase 4 scope.

**I11. Monaco language ID mismatch (`abl` registered, `agent-dsl` used)**

- **Resolution**: Fix in Phase 1. Register a single `abl` language ID. Set `defaultLanguage="abl"` on the Editor component. Format detection (YAML vs legacy) switches the Monarch tokenizer, not the language ID.

### Low Issues (noted for implementation)

- **L12**: Language service exports pure functions, not a class. Module pattern: `export function getDiagnostics(...)`.
- **L13**: Package names follow `@abl/` namespace: `@abl/language-service`, `@abl/lsp-server`.
- **L14**: Python SDK generation is TypeScript-only initially. Python support is a stretch goal.
- **L15**: VS Code extension reads credentials from the CLI's Conf store (`~/.config/kore-platform/credentials.json`). Same file, shared access.
- **L16**: SDK auto-regeneration on deployment is a post-Phase 6 enhancement. Not required for initial SDK release.

### Updated Phase 1 Files

| File                                                     | Changes                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/core/src/parser/yaml-parser.ts`                | Implement `parseFlow()` for YAML scripted agents (C2)        |
| `packages/abl-language-service/` (NEW)                   | Full package with DI for compiler (C1)                       |
| `apps/studio/src/components/abl/ABLEditor.tsx`           | Fix language ID (I11), YAML tokenizer, wire language service |
| `apps/studio/src/lib/abl-monarch.ts` (NEW)               | Extracted tokenizer definitions (YAML + legacy)              |
| `apps/studio/src/app/api/abl/diagnostics/route.ts` (NEW) | API route for Tier 2+ diagnostics                            |

### Pre-Implementation Questions Resolved

1. **Flow parser gap**: `parseFlow()` will be implemented in Phase 1 as a prerequisite.
2. **Compiler dependency isolation**: Dependency injection via constructor parameter, not `@abl/compiler-lite`.
3. **web-sdk reconciliation**: Separate packages by audience — `web-sdk` (browser widget) vs `server-sdk` (programmatic API).
4. **Webhook storage**: Per-session in MongoDB, tenant-scoped. Cleanup on session TTL expiry.
5. **MCP tool registry**: Refactor to registry pattern in Phase 4 before adding tools.
6. **Tier 1 browser execution**: Bundle `@abl/core`'s parser for browser. Mark as browser-safe in package.json exports.
