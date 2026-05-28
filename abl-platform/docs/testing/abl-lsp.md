# Test Spec: ABL Language Server Protocol & VS Code Extension

- **Feature**: abl-lsp (F017-LSP)
- **Status**: PLANNED
- **Created**: 2026-03-23
- **Last Updated**: 2026-03-23

## 1. Test Strategy Overview

The ABL LSP feature spans 3 packages with different testing needs:

| Package                  | Test Type          | Framework             | Why                                                                        |
| ------------------------ | ------------------ | --------------------- | -------------------------------------------------------------------------- |
| `@abl/language-service`  | Unit               | vitest                | Pure functions, no I/O — fast, deterministic                               |
| `@abl/lsp-server`        | Unit + Integration | vitest                | Adapters (unit), server lifecycle (integration via LSP client mock)        |
| `kore-abl` (VS Code ext) | E2E                | @vscode/test-electron | Requires real VS Code instance for activation, commands, language features |

### Test Pyramid

```
  E2E (5)     — VS Code extension activation, real LSP roundtrips
 Integration (8) — LSP server protocol compliance, workspace scanning
Unit (40+)   — Language service functions, adapters, format detection
```

## 2. Coverage Matrix

### 2.1 Language Service (`packages/language-service`)

| Module         | Function                                                                | Test ID  | Priority | Status                           |
| -------------- | ----------------------------------------------------------------------- | -------- | -------- | -------------------------------- |
| detect-format  | `detectFormat` — YAML detection                                         | LS-DF-01 | P0       | EXISTS (detect-format.test.ts)   |
| detect-format  | `detectFormat` — legacy detection                                       | LS-DF-02 | P0       | EXISTS                           |
| detect-format  | `detectFormat` — empty input                                            | LS-DF-03 | P0       | EXISTS                           |
| detect-format  | `detectFormat` — comment-only input                                     | LS-DF-04 | P1       | NEW                              |
| diagnostics    | `getDiagnostics` — valid YAML, zero errors                              | LS-DG-01 | P0       | EXISTS (diagnostics.test.ts)     |
| diagnostics    | `getDiagnostics` — YAML parse errors (tier 1)                           | LS-DG-02 | P0       | EXISTS                           |
| diagnostics    | `getDiagnostics` — YAML warnings (tier 2)                               | LS-DG-03 | P0       | EXISTS                           |
| diagnostics    | `getDiagnostics` — compile diagnostics (tier 3) via CompileFn           | LS-DG-04 | P0       | EXISTS                           |
| diagnostics    | `getDiagnostics` — legacy format parse errors                           | LS-DG-05 | P0       | EXISTS                           |
| diagnostics    | `getDiagnostics` — CompileFn crash graceful degradation                 | LS-DG-06 | P1       | NEW                              |
| diagnostics    | `getDiagnostics` — empty input                                          | LS-DG-07 | P1       | NEW                              |
| completions    | `getCompletions` — top-level keys (YAML)                                | LS-CP-01 | P0       | EXISTS (completions.test.ts)     |
| completions    | `getCompletions` — top-level keys (legacy)                              | LS-CP-02 | P0       | EXISTS                           |
| completions    | `getCompletions` — tool names in tools section                          | LS-CP-03 | P0       | EXISTS                           |
| completions    | `getCompletions` — flow step keywords                                   | LS-CP-04 | P0       | EXISTS                           |
| completions    | `getCompletions` — handoff target agent names                           | LS-CP-05 | P0       | EXISTS                           |
| completions    | `getCompletions` — CEL function completions                             | LS-CP-06 | P0       | EXISTS (cel-completions.test.ts) |
| completions    | `getCompletions` — value enums (mode, type, action, strategy, priority) | LS-CP-07 | P0       | EXISTS                           |
| completions    | `getCompletions` — gather field properties                              | LS-CP-08 | P0       | EXISTS                           |
| completions    | `getCompletions` — gather field type values                             | LS-CP-09 | P0       | EXISTS                           |
| completions    | `getCompletions` — empty source                                         | LS-CP-10 | P1       | EXISTS                           |
| completions    | `getCompletions` — excludes already-present top-level keys              | LS-CP-11 | P1       | EXISTS                           |
| completions    | `getCompletions` — built-in tools merged with context tools             | LS-CP-12 | P1       | NEW                              |
| completions    | `getCompletions` — delegate target completions                          | LS-CP-13 | P1       | NEW                              |
| symbols        | `getDocumentSymbols` — agent with tools section                         | LS-SY-01 | P0       | EXISTS (symbols.test.ts)         |
| symbols        | `getDocumentSymbols` — agent with flow steps                            | LS-SY-02 | P0       | EXISTS                           |
| symbols        | `getDocumentSymbols` — agent with gather fields                         | LS-SY-03 | P0       | EXISTS                           |
| symbols        | `getDocumentSymbols` — agent with constraints                           | LS-SY-04 | P0       | EXISTS                           |
| symbols        | `getDocumentSymbols` — agent with handoffs                              | LS-SY-05 | P0       | EXISTS                           |
| symbols        | `getDocumentSymbols` — agent with delegates                             | LS-SY-06 | P0       | EXISTS                           |
| symbols        | `getDocumentSymbols` — empty source                                     | LS-SY-07 | P1       | EXISTS                           |
| symbols        | `getDocumentSymbols` — legacy format                                    | LS-SY-08 | P1       | NEW                              |
| hover          | `getHoverInfo` — recognized keyword                                     | LS-HV-01 | P0       | EXISTS (hover.test.ts)           |
| hover          | `getHoverInfo` — unrecognized word                                      | LS-HV-02 | P0       | EXISTS                           |
| hover          | `getHoverInfo` — cursor on empty line                                   | LS-HV-03 | P1       | NEW                              |
| hover          | `getHoverInfo` — case-insensitive keyword match                         | LS-HV-04 | P1       | NEW                              |
| cel-functions  | CEL_FUNCTIONS registry completeness                                     | LS-CF-01 | P0       | NEW                              |
| serialize-yaml | `serializeToYAML` — round-trip basic agent                              | LS-SZ-01 | P0       | EXISTS (serialize-yaml.test.ts)  |
| serialize-yaml | `serializeToYAML` — round-trip with flow                                | LS-SZ-02 | P0       | EXISTS                           |
| serialize-yaml | `serializeToYAML` — round-trip with gather                              | LS-SZ-03 | P1       | EXISTS                           |

### 2.2 LSP Server (`packages/abl-lsp-server`)

| Module               | Function/Scenario                                     | Test ID   | Priority | Status                             |
| -------------------- | ----------------------------------------------------- | --------- | -------- | ---------------------------------- |
| adapters/diagnostics | `toLSPDiagnostic` — severity mapping                  | LSP-AD-01 | P0       | EXISTS (adapters.test.ts)          |
| adapters/diagnostics | `toLSPDiagnostic` — range with endLine/endColumn      | LSP-AD-02 | P0       | EXISTS                             |
| adapters/diagnostics | `toLSPDiagnostics` — batch conversion                 | LSP-AD-03 | P0       | EXISTS                             |
| adapters/completions | `toLSPCompletionItem` — kind mapping                  | LSP-AC-01 | P0       | EXISTS                             |
| adapters/completions | `toLSPCompletionItem` — sortOrder to sortText padding | LSP-AC-02 | P0       | EXISTS                             |
| adapters/completions | `toLSPCompletionItems` — batch conversion             | LSP-AC-03 | P0       | EXISTS                             |
| adapters/symbols     | `toLSPDocumentSymbol` — kind mapping                  | LSP-AS-01 | P0       | EXISTS                             |
| adapters/symbols     | `toLSPDocumentSymbol` — recursive children            | LSP-AS-02 | P0       | EXISTS                             |
| adapters/symbols     | `toLSPDocumentSymbols` — batch conversion             | LSP-AS-03 | P0       | EXISTS                             |
| adapters/hover       | `toLSPHover` — markdown content + range               | LSP-AH-01 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — finds agent names from .agent.yaml           | LSP-WS-01 | P0       | EXISTS (workspace-scanner.test.ts) |
| workspace-scanner    | `scan` — finds tool names                             | LSP-WS-02 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — deduplicates across files                    | LSP-WS-03 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — caches results                               | LSP-WS-04 | P0       | EXISTS                             |
| workspace-scanner    | `invalidate` — clears cache                           | LSP-WS-05 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — skips node_modules and .git                  | LSP-WS-06 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — handles non-existent directories             | LSP-WS-07 | P0       | EXISTS                             |
| workspace-scanner    | `scan` — MAX_FILES=100 cap                            | LSP-WS-08 | P1       | NEW                                |
| workspace-scanner    | `scan` — depth limit (5 levels)                       | LSP-WS-09 | P1       | NEW                                |
| workspace-scanner    | `scan` — finds .agent.abl files (legacy)              | LSP-WS-10 | P1       | NEW                                |
| capabilities         | SERVER_CAPABILITIES correctness                       | LSP-CP-01 | P0       | NEW                                |

### 2.3 Integration Tests — LSP Protocol

| Scenario                                                  | Test ID | Priority | Status |
| --------------------------------------------------------- | ------- | -------- | ------ |
| Server initializes with correct capabilities              | INT-01  | P0       | NEW    |
| textDocument/didOpen triggers diagnostics                 | INT-02  | P0       | NEW    |
| textDocument/didChange triggers debounced diagnostics     | INT-03  | P0       | NEW    |
| textDocument/completion returns context-aware items       | INT-04  | P0       | NEW    |
| textDocument/hover returns keyword documentation          | INT-05  | P0       | NEW    |
| textDocument/documentSymbol returns hierarchical outline  | INT-06  | P0       | NEW    |
| workspace/didChangeWatchedFiles invalidates scanner cache | INT-07  | P1       | NEW    |
| textDocument/didClose clears diagnostics                  | INT-08  | P1       | NEW    |

### 2.4 E2E Tests — VS Code Extension

| Scenario                                                | Test ID | Priority | Status |
| ------------------------------------------------------- | ------- | -------- | ------ |
| Extension activates on .agent.yaml file open            | E2E-01  | P0       | NEW    |
| Diagnostics appear in Problems panel for invalid ABL    | E2E-02  | P0       | NEW    |
| Completions suggest top-level keys in empty .agent.yaml | E2E-03  | P0       | NEW    |
| Hover shows documentation for ABL keywords              | E2E-04  | P0       | NEW    |
| Document outline shows agent structure                  | E2E-05  | P0       | NEW    |
| Snippets insert correctly with tab stops                | E2E-06  | P1       | NEW    |
| abl.validate command triggers re-validation             | E2E-07  | P1       | NEW    |

## 3. Test Scenarios — Detailed

### 3.1 Unit Test Scenarios (Language Service)

#### LS-DG-06: CompileFn crash graceful degradation

```
GIVEN a valid ABL source
AND a CompileFn that throws an error
WHEN getDiagnostics is called with { compileFn }
THEN syntax/structural diagnostics still return
AND no compile diagnostics are included
AND no error is thrown
```

#### LS-CP-12: Built-in tools merged with context tools

```
GIVEN a source with cursor in the tools section
AND a CompletionContext with availableTools: [{ name: 'search_api' }]
WHEN getCompletions is called
THEN result includes 'search_api' from context
AND result includes built-in tools (transfer_to_agent, check_hours, etc.)
AND context tools take priority over built-in tools with same name
```

#### LS-CP-13: Delegate target completions

```
GIVEN a source with:
  delegate:
    - agent: <cursor>
AND a CompletionContext with availableAgents: [{ name: 'booking_agent' }]
WHEN getCompletions is called at the cursor position
THEN result includes 'booking_agent' with kind 'agent'
```

### 3.2 Integration Test Scenarios (LSP Protocol)

#### INT-01: Server initializes with correct capabilities

```
GIVEN a new LSP connection
WHEN the client sends initialize
THEN the response includes:
  - textDocumentSync: Incremental
  - completionProvider with triggerCharacters [':', '.', '{', ' ']
  - hoverProvider: true
  - documentSymbolProvider: true
```

#### INT-02: textDocument/didOpen triggers diagnostics

```
GIVEN an initialized LSP connection
WHEN the client opens a document with content "agent: test\nmode: invalid_mode"
THEN the server publishes diagnostics within 500ms
AND at least one diagnostic has severity=Warning for "invalid_mode"
```

#### INT-03: textDocument/didChange triggers debounced diagnostics

```
GIVEN an open document in the LSP connection
WHEN the client sends two rapid didChange notifications (50ms apart)
THEN only one diagnostics publication occurs (debounced at 300ms)
```

#### INT-04: textDocument/completion returns context-aware items

```
GIVEN an open document with content "agent: test\n"
WHEN the client requests completions at line 2, character 0
THEN the response includes items for remaining top-level keys
AND does NOT include 'agent' (already present)
```

#### INT-05: textDocument/hover returns keyword documentation

```
GIVEN an open document with content "agent: test\nmode: reasoning"
WHEN the client requests hover at line 1, character 0 (on "agent")
THEN the response contains markdown with "**agent**"
```

#### INT-06: textDocument/documentSymbol returns hierarchical outline

```
GIVEN an open document with:
  agent: test
  tools:
    - search_api
  flow:
    entry_point: start
    steps:
      start:
        respond: Hello
WHEN the client requests documentSymbols
THEN the response includes a root symbol 'test' (kind=Class)
AND child symbols 'Tools' and 'Flow' (kind=Namespace/Namespace)
AND 'Tools' has child 'search_api' (kind=Function)
AND 'Flow' has child 'start' (kind=Method)
```

#### INT-07: workspace/didChangeWatchedFiles invalidates scanner cache

```
GIVEN an initialized server with a workspace containing agent files
AND the scanner has been used (cache populated)
WHEN the client sends didChangeWatchedFiles notification
THEN subsequent completion requests include updated agent/tool names
```

#### INT-08: textDocument/didClose clears diagnostics

```
GIVEN an open document with diagnostics published
WHEN the client sends didClose for that document
THEN the server publishes empty diagnostics for the document URI
```

### 3.3 E2E Test Scenarios (VS Code Extension)

#### E2E-01: Extension activates on .agent.yaml file open

```
GIVEN VS Code with the kore-abl extension installed
WHEN the user opens a file with .agent.yaml extension
THEN the extension activates (language ID is abl-yaml)
AND the status bar shows no errors
AND the LSP server process is running
```

#### E2E-02: Diagnostics appear in Problems panel

```
GIVEN an open .agent.yaml file with invalid syntax
WHEN the file is opened or edited
THEN the Problems panel shows at least one error
AND the error has source "abl-syntax"
AND squiggly underlines appear in the editor
```

#### E2E-03: Completions suggest top-level keys

```
GIVEN an empty .agent.yaml file
WHEN the user triggers completions (Ctrl+Space)
THEN the completion list includes: agent, mode, goal, tools, flow, constraints, handoff, delegate, gather, identity, context, on_start, on_complete, on_error
```

#### E2E-04: Hover shows documentation

```
GIVEN a .agent.yaml file with content "agent: test"
WHEN the user hovers over "agent"
THEN a tooltip appears with markdown content containing "**agent**"
```

#### E2E-05: Document outline shows agent structure

```
GIVEN a .agent.yaml file with agent, tools, and flow sections
WHEN the user opens the Outline view
THEN the outline shows the agent name at the root
AND sections (Tools, Flow) as children
AND individual tools/steps as grandchildren
```

## 4. Test Data & Fixtures

### 4.1 Valid ABL YAML fixtures

```yaml
# fixture: minimal-reasoning-agent.agent.yaml
agent: booking_agent
mode: reasoning
goal: Help users book flights
tools:
  - search_flights
  - book_flight
constraints:
  - Always verify passenger details before booking
```

```yaml
# fixture: scripted-flow-agent.agent.yaml
agent: onboarding_agent
mode: scripted
goal: Collect user registration info
gather:
  name:
    type: string
    required: true
    prompt: What is your name?
  email:
    type: email
    required: true
    prompt: What is your email?
flow:
  entry_point: greeting
  steps:
    greeting:
      respond: Welcome! Let me collect some information.
      then: collect_info
    collect_info:
      gather: true
      then: confirm
    confirm:
      respond: "Thanks {{name}}, we'll send a confirmation to {{email}}."
      then: complete
```

```yaml
# fixture: multi-agent-handoff.agent.yaml
agent: supervisor
mode: reasoning
goal: Route customer inquiries to the right agent
handoff:
  - to: billing_agent
    when: context.topic == "billing"
    reason: Handle billing inquiries
  - to: support_agent
    when: context.topic == "support"
    reason: Handle support requests
delegate:
  - agent: research_agent
    task: Look up customer history
```

### 4.2 Invalid ABL fixtures (for diagnostic testing)

```yaml
# fixture: invalid-syntax.agent.yaml
agent: test
mode: reasoning
goal  # missing colon
tools:
  - search_api
  - [invalid yaml
```

```yaml
# fixture: unknown-mode.agent.yaml
agent: test
mode: freeform
goal: Test unknown mode warning
```

## 5. Test Infrastructure

### 5.1 Unit Tests (vitest)

- Location: `packages/language-service/src/__tests__/`, `packages/abl-lsp-server/src/__tests__/`
- Run: `pnpm test --filter=@abl/language-service`, `pnpm test --filter=@abl/lsp-server`
- No mocks of codebase components — all language service functions are pure
- No external dependencies required

### 5.2 Integration Tests (vitest + LSP test client)

- Location: `packages/abl-lsp-server/src/__tests__/integration/`
- Uses `vscode-languageserver` test utilities or a lightweight LSP client that communicates over stdio
- Starts the real LSP server as a child process
- Sends/receives LSP JSON-RPC messages
- No VS Code required

### 5.3 E2E Tests (@vscode/test-electron)

- Location: `packages/abl-vscode/src/__tests__/e2e/`
- Uses `@vscode/test-electron` to launch a real VS Code instance
- Opens fixture files, triggers features, asserts UI state
- Requires VS Code installed (CI: use `xvfb` for headless)
- Run: `pnpm test --filter=kore-abl` (or dedicated e2e script)

## 6. Quality Gates

| Gate                                                | Threshold | Enforcement                          |
| --------------------------------------------------- | --------- | ------------------------------------ |
| Unit test pass rate                                 | 100%      | CI pipeline, `pnpm test`             |
| Integration test pass rate                          | 100%      | CI pipeline                          |
| E2E test pass rate                                  | 100%      | CI pipeline (headless VS Code)       |
| Line coverage (language-service)                    | >= 80%    | `vitest --coverage`                  |
| Line coverage (lsp-server)                          | >= 70%    | `vitest --coverage`                  |
| Zero false-positive diagnostics on valid ABL corpus | 100%      | Fixture-based tests                  |
| All 7 snippet prefixes work                         | 100%      | E2E test E2E-06                      |
| Completion accuracy per context type                | 100%      | Unit tests LS-CP-01 through LS-CP-13 |
