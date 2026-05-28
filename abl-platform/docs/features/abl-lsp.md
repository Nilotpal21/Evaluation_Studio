# Feature Spec: ABL Language Server Protocol & VS Code Extension

- **Feature ID**: F017-LSP (subset of F017 Developer Tooling)
- **Status**: PLANNED
- **Created**: 2026-03-23
- **Last Updated**: 2026-03-23

## 1. Problem Statement

ABL (Agent Blueprint Language) developers currently author agent definitions in either YAML format (`.agent.yaml`) or legacy uppercase format (`.agent.abl`) using plain text editors without language-specific tooling. This results in:

1. **Slow feedback loops**: Syntax and structural errors are only discovered at compile/deploy time, not while editing
2. **Lack of discoverability**: New users must memorize ABL keywords, tool names, agent names, CEL functions, and value enums without IDE assistance
3. **No workspace awareness**: Multi-agent projects require manually tracking agent names and tool definitions across files for handoff/delegate references
4. **Poor navigation**: Large ABL files with many flow steps, tools, and constraints lack document outline support
5. **No inline documentation**: Developers must consult external docs to understand keyword semantics

The platform already has foundational packages (`@abl/language-service`, `@abl/lsp-server`, `kore-abl` VS Code extension) that implement a baseline of diagnostics, completions, hover, and symbols. However, these packages are at v0.1.0 and need hardening, gap-filling, and production readiness before they can serve as the official developer tooling.

## 2. Scope

### 2.1 In Scope

| Component         | Package                     | Current State                                                                                                                   | Target State                                                                                                                     |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Language Service  | `packages/language-service` | v0.1.0 — diagnostics (3 tiers), completions (context-aware), hover, symbols, format detection, YAML serialization               | Hardened with go-to-definition, find-references, code actions (quick fixes), rename support, semantic tokens                     |
| LSP Server        | `packages/abl-lsp-server`   | v0.1.0 — stdio transport, debounced diagnostics, workspace scanner, 4 adapters                                                  | Hardened with incremental document sync, go-to-definition, find-references, code actions, semantic tokens, configuration support |
| VS Code Extension | `packages/abl-vscode`       | v0.1.0 — dual language registration (abl-yaml, abl-legacy), TextMate grammars, snippets (7), validate command, esbuild bundling | Marketplace-ready with status bar, output channel, configuration UI, agent topology preview command                              |
| Core Parser       | `packages/core`             | Stable — `parseYamlABL`, `parseAgentBasedABL` with errors/warnings/document output                                              | No changes needed (consumed as dependency)                                                                                       |

### 2.2 Out of Scope

- **Web-based editor integration** (Studio/Monaco) — Studio already consumes `@abl/language-service` directly
- **CLI integration** — `kore-platform-cli` is a separate feature track
- **MCP debug tools** — separate package, separate lifecycle
- **ABL compiler changes** — `@abl/compiler` is consumed via `CompileFn` injection, not modified
- **Multi-root workspace support** — single workspace folder only for v1
- **Remote development** (SSH, containers) — future enhancement
- **Neovim, JetBrains, Sublime** — LSP server supports any client, but only VS Code extension is explicitly developed/tested

### 2.3 Existing Codebase Inventory

**`packages/language-service`** (shared, editor-agnostic):

- `types.ts` — `Position`, `Diagnostic`, `DocumentSymbol`, `CompletionItem`, `HoverInfo`, `CompileFn`
- `detect-format.ts` — YAML vs legacy format detection
- `diagnostics.ts` — 3-tier diagnostics (syntax, structural, compile)
- `completions.ts` — Context-aware completions (top-level, tools, flow steps, handoff targets, CEL functions, value enums, gather fields)
- `symbols.ts` — Hierarchical document outline (agent > sections > items)
- `hover.ts` — Keyword hover documentation
- `docs.ts` — Keyword markdown documentation registry (18 keywords)
- `cel-functions.ts` — 30 CEL function metadata entries
- `serialize-yaml.ts` — IR-to-YAML round-trip serialization

**`packages/abl-lsp-server`** (LSP protocol bridge):

- `server.ts` — LSP connection, document management, debounced diagnostics (300ms), lifecycle handlers
- `capabilities.ts` — Server capabilities declaration (incremental sync, completions, hover, document symbols)
- `adapters/` — 4 adapters converting language-service types to LSP protocol types (diagnostics, completions, symbols, hover)
- `workspace-scanner.ts` — Scans workspace for `.agent.yaml`/`.agent.abl` files, extracts agent/tool names for completion context

**`packages/abl-vscode`** (VS Code client):

- `extension.ts` — Language client setup (stdio transport), file watcher, validate command
- `language-configuration.json` — Comments, brackets, folding, indentation, word pattern
- `syntaxes/abl-yaml.tmLanguage.json` — TextMate grammar for YAML format
- `syntaxes/abl-legacy.tmLanguage.json` — TextMate grammar for legacy format
- `snippets/abl.snippets.json` — 7 snippets (agent, tool, step, constraint, handoff, gather field, flow, delegate)
- `esbuild.config.mjs` — Bundles both extension client and LSP server

## 3. User Stories

### 3.1 Persona: ABL Developer (primary)

| ID    | Story                                                                                                         | Priority | Acceptance Criteria                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| US-01 | As an ABL developer, I want real-time error highlighting so I catch syntax mistakes while typing              | P0       | Diagnostics appear within 500ms of typing, with correct line/column positions, squiggly underlines, and Problems panel integration                |
| US-02 | As an ABL developer, I want context-aware completions so I can discover available keywords, tools, and agents | P0       | Completions trigger on `:`, `.`, `{`, space; show correct items based on cursor context (top-level, tools, flow, handoff target, CEL, value enum) |
| US-03 | As an ABL developer, I want hover documentation so I can understand keywords without leaving the editor       | P0       | Hovering over any recognized ABL keyword shows markdown documentation in a tooltip                                                                |
| US-04 | As an ABL developer, I want document outline so I can navigate large agent definitions                        | P0       | Outline view shows hierarchical tree: Agent > Sections (Tools, Flow, Constraints, Gather, Handoffs, Delegates) > Items                            |
| US-05 | As an ABL developer, I want syntax highlighting for both YAML and legacy formats                              | P0       | TextMate grammars correctly highlight top-level keys, sub-keys, strings, numbers, constants, comments, template variables, CEL expressions        |
| US-06 | As an ABL developer, I want code snippets so I can scaffold common patterns quickly                           | P1       | All 7 snippets (agent, tool, step, constraint, handoff, field, flow, delegate) insert correctly with tab stops                                    |
| US-07 | As an ABL developer, I want go-to-definition for handoff/delegate targets so I can navigate between agents    | P1       | Ctrl+Click on a handoff `to:` or delegate `agent:` value navigates to the target agent's file                                                     |
| US-08 | As an ABL developer, I want find-all-references for agent names so I can understand coupling                  | P1       | Right-click "Find References" on an agent name shows all files that reference it in handoffs/delegates                                            |
| US-09 | As an ABL developer, I want quick-fix code actions for common errors                                          | P2       | "Unknown tool" offers to add tool to tools section; "Unknown agent" suggests available agents                                                     |
| US-10 | As an ABL developer, I want semantic token highlighting for CEL expressions                                   | P2       | CEL function names, context variables, and operators get distinct colorization beyond TextMate regex                                              |

### 3.2 Persona: ABL Platform Team (secondary)

| ID    | Story                                                                                                         | Priority | Acceptance Criteria                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| US-11 | As a platform maintainer, I want the LSP server to be standalone so it works with any LSP-compatible editor   | P0       | LSP server starts via `abl-lsp` binary, communicates over stdio, conforms to LSP 3.17          |
| US-12 | As a platform maintainer, I want the language service to be editor-agnostic so Studio and VS Code share logic | P0       | `@abl/language-service` has zero VS Code/LSP dependencies; only `@abl/core`                    |
| US-13 | As a platform maintainer, I want the VS Code extension to be publishable to the marketplace                   | P1       | Extension passes `vsce package`, has icon, README, changelog, minimum VS Code version declared |

## 4. Requirements

### 4.1 Functional Requirements

| ID    | Requirement                                                                                                                                         | Source       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| FR-01 | Diagnostics must support 3 tiers: syntax (parser errors), structural (parser warnings), compile (optional `CompileFn` injection)                    | US-01        |
| FR-02 | Completions must be context-aware: top-level keys, tool names, agent names, flow step keywords, CEL functions, value enums, gather field properties | US-02        |
| FR-03 | Hover must display markdown documentation for all 18+ recognized ABL keywords                                                                       | US-03        |
| FR-04 | Document symbols must produce hierarchical outline matching the agent structure                                                                     | US-04        |
| FR-05 | Both YAML (`.agent.yaml`) and legacy (`.agent.abl`) formats must be supported                                                                       | US-05, US-01 |
| FR-06 | Workspace scanner must discover agent/tool names from workspace `.agent.yaml`/`.agent.abl` files for cross-file completions                         | US-02, US-07 |
| FR-07 | Go-to-definition must resolve handoff `to:` and delegate `agent:` references to the target agent file                                               | US-07        |
| FR-08 | Find-references must locate all handoff/delegate references to a given agent name across workspace                                                  | US-08        |
| FR-09 | Quick-fix code actions must offer corrections for unknown tool/agent references                                                                     | US-09        |
| FR-10 | Semantic tokens must provide fine-grained highlighting for CEL expressions                                                                          | US-10        |

### 4.2 Non-Functional Requirements

| ID     | Requirement                                                     | Target                             |
| ------ | --------------------------------------------------------------- | ---------------------------------- |
| NFR-01 | Diagnostics latency (time from keystroke to squiggly underline) | < 500ms (currently 300ms debounce) |
| NFR-02 | Completion response time                                        | < 200ms                            |
| NFR-03 | Workspace scan time (100 files)                                 | < 2s                               |
| NFR-04 | Extension activation time                                       | < 1s                               |
| NFR-05 | Memory usage (LSP server, 100-file workspace)                   | < 100MB RSS                        |
| NFR-06 | Minimum VS Code version                                         | 1.85.0                             |
| NFR-07 | LSP protocol version                                            | 3.17                               |
| NFR-08 | Test coverage (language-service + lsp-server)                   | >= 80% line coverage               |

## 5. Dependencies

| Dependency                                                         | Type             | Risk                            |
| ------------------------------------------------------------------ | ---------------- | ------------------------------- |
| `@abl/core` (parseYamlABL, parseAgentBasedABL, AgentBasedDocument) | Internal package | Low — stable, well-tested       |
| `vscode-languageserver` ^9.0.1                                     | NPM              | Low — stable LSP implementation |
| `vscode-languageserver-textdocument` ^1.0.11                       | NPM              | Low                             |
| `vscode-languageclient` ^9.0.1                                     | NPM              | Low                             |
| `esbuild` ^0.20.0                                                  | NPM (dev)        | Low                             |
| `@types/vscode` ^1.85.0                                            | NPM (dev)        | Low                             |

## 6. Risks and Mitigations

| Risk                                                 | Likelihood | Impact | Mitigation                                                       |
| ---------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------- |
| Parser changes in `@abl/core` break language service | Low        | Medium | Language service has its own test suite; parser types are stable |
| Large workspaces (>100 files) cause slow scans       | Medium     | Low    | MAX_FILES=100 cap already exists; add progress reporting         |
| TextMate grammar misses new ABL keywords             | Medium     | Low    | Grammars are data-driven; add new keywords to arrays             |
| Compile-tier diagnostics crash on malformed input    | Low        | Medium | `CompileFn` injection is try-caught; graceful degradation        |
| VS Code marketplace publishing blocked by policy     | Low        | Medium | Extension can be distributed as `.vsix` sideload                 |

## 7. Success Metrics

| Metric                         | Target                                               | Measurement                                   |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------- |
| Diagnostic accuracy            | Zero false positives on valid ABL files              | Test suite with corpus of valid/invalid files |
| Completion relevance           | Correct suggestions for all documented context types | Unit tests per context type                   |
| Extension install success rate | 100% on VS Code >= 1.85                              | Manual testing on macOS, Linux, Windows       |
| Test coverage                  | >= 80% line coverage                                 | `vitest --coverage`                           |
| Unit test count                | >= 50 tests across language-service + lsp-server     | CI pipeline                                   |
