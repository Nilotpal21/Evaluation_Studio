# Feature: ABL Language

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `observability`, `enterprise`
**Package(s)**: `packages/core`, `packages/compiler`, `packages/language-service`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/abl-language.md](../testing/abl-language.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

The platform needs a single authoring language for agent behavior that can be edited in Studio, validated before deployment, compiled into a stable runtime contract, and reused across multiple execution surfaces. Without that common language, authoring would fragment across bespoke route handlers, runtime-specific formats, and inconsistent validation paths.

### Goal Statement

The goal of ABL Language is to provide one source format for agent behavior while keeping runtime execution framework-agnostic. ABL source should parse consistently, compile into portable `AgentIR`, surface rich diagnostics in Studio, and remain safe to validate, version, and deploy across digital, voice, SDK, and orchestration runtimes.

### Summary

ABL Language is the authoring surface for agent definitions across the platform. It covers the DSL itself, the YAML flow variant, parsing and structural validation, compilation into AgentIR, and the language-service diagnostics that power Studio editing.

The language supports two formats: a Chevrotain-based uppercase syntax (`AGENT:`, `GOAL:`, `FLOW:`) and a YAML-based lowercase syntax (`agent:`, `goal:`, `flow:`). Both formats parse into the same `AgentBasedDocument` AST and compile into identical `AgentIR` output via `compileABLtoIR()`. Format detection is automatic via heuristic inspection of the first non-empty, non-comment line (`packages/language-service/src/detect-format.ts`).

### Key Capabilities

- DSL constructs for AGENT, STEP, GATHER, RESPOND, CALL, SET, HANDOFF, DELEGATE, CONSTRAINT, LOOKUP, MEMORY, ESCALATE, GUARDRAIL, TEMPLATE, ATTACHMENT, BEHAVIOR_PROFILE, and NLU
- YAML flow parsing into the same `AgentBasedDocument` AST as the uppercase DSL files
- Expression parsing for CEL expressions and legacy compatibility paths, with 35+ custom `abl.*` functions (`packages/compiler/src/platform/constructs/cel-functions.ts`)
- Cross-reference validation for agents, tools, steps, variable references, gather field dependencies, and input mappings
- IR compilation into `AgentIR` with source hashes, config variable resolution, and compilation warnings
- Post-IR validation: flow graph integrity, tool references, cross-agent references, field references, guardrails, and preflight checks
- Studio diagnostics (3-tier: syntax, structural, compile), completions, hover, and document symbols
- Tool file parsing (`.tools.abl`) for reusable tool collections with shared defaults
- Supervisor/topology parsing and compilation for multi-agent routing

---

## 2. Scope

### Goals

- Provide a single DSL for authoring agents that is both human-readable and machine-compilable
- Compile DSL source into a portable, framework-agnostic `AgentIR` consumed by all runtimes
- Support both uppercase DSL format (Chevrotain-based) and YAML format with identical AST output
- Surface rich editor diagnostics (syntax, structural, compile) through a dedicated language-service package
- Validate cross-agent references, tool bindings, field references, and deployment readiness before runtime
- Support CEL expressions with 35+ custom `abl.*` functions for validation, transformation, and flow control
- Enable tool file reuse through `.tools.abl` importable collections with shared defaults
- Provide supervisor/topology compilation for multi-agent orchestration patterns

### Non-Goals (Out of Scope)

- Runtime execution of agents (consumed by runtime features, not executed by the compiler)
- Real-time collaborative editing or presence on the DSL editor surface
- Full LSP server with semantic analysis (current diagnostics are heuristic/position-based)
- Visual drag-and-drop agent builder (Studio visual editing is a separate feature)
- Incremental/partial compilation (full `AgentBasedDocument[]` is recompiled on each change)

---

## 3. User Stories

1. As an **agent developer**, I want to write agent behavior in a structured DSL so that I can define goals, tools, flows, constraints, and handoffs in one document that compiles consistently.
2. As an **agent developer**, I want to choose between uppercase DSL or YAML syntax so that I can use the format most natural to my workflow while producing identical compiled output.
3. As an **agent developer**, I want real-time diagnostics in Studio (syntax errors, structural warnings, compile errors) so that I can fix issues before attempting to deploy.
4. As a **platform operator**, I want compiled IR to be framework-agnostic so that the same agent definition can execute across digital, voice, SDK, and orchestration runtimes.
5. As a **platform operator**, I want cross-agent reference validation so that handoff targets, delegate targets, and routing references are verified before deployment.
6. As an **agent developer**, I want to use CEL expressions (`abl.upper()`, `abl.date_after()`, `abl.mask()`) in gather validations and flow conditions so that I can encode business logic without custom code.
7. As an **agent developer**, I want to define reusable tool collections in `.tools.abl` files so that shared tools can be imported across multiple agents without duplication.
8. As a **team lead**, I want behavior profiles that can be composed onto agents so that tone, response style, and gather behavior can be standardized across a project.

---

## 4. Functional Requirements

1. **FR-1**: The system must parse uppercase DSL source into an `AgentBasedDocument` AST via the regex-based line scanner in `packages/core/src/parser/agent-based-parser.ts` (6,701 LOC).
2. **FR-2**: The system must parse YAML-format ABL source into the identical `AgentBasedDocument` AST via `js-yaml` in `packages/core/src/parser/yaml-parser.ts` (1,031 LOC).
3. **FR-3**: The system must automatically detect whether input is uppercase DSL or YAML via the heuristic in `packages/language-service/src/detect-format.ts` (33 LOC).
4. **FR-4**: The system must compile `AgentBasedDocument[]` into `CompilationOutput` containing `AgentIR` records via `compileABLtoIR()` in `packages/compiler/src/platform/ir/compiler.ts` (2,751 LOC).
5. **FR-5**: The system must run post-compilation validators (flow graph, tool refs, cross-agent refs, field refs, guardrails, preflight) via `validateIR()` in `packages/compiler/src/platform/ir/validate-ir.ts`.
6. **FR-6**: The system must evaluate CEL expressions with 35+ custom `abl.*` functions via the evaluator in `packages/compiler/src/platform/constructs/cel-evaluator.ts`, capping expression length at 4,096 bytes.
7. **FR-7**: The system must provide 3-tier diagnostics (syntax, structural, compile) via `packages/language-service/src/diagnostics.ts` (92 LOC) for Studio editor integration.
8. **FR-8**: The system must provide context-aware completions, hover documentation, and document symbols via `packages/language-service/src/completions.ts` (513 LOC), `hover.ts`, and `symbols.ts`.
9. **FR-9**: The system must parse `.tools.abl` files for reusable tool collections via `packages/core/src/parser/tool-file-parser.ts` and resolve imports via `tool-import-resolver.ts`.
10. **FR-10**: The system must parse supervisor documents (SUPERVISOR:, AGENTS:, INTENTS:, POLICIES:) via the Chevrotain CST parser in `packages/core/src/parser/supervisor-parser.ts`.
11. **FR-11**: The system must compile behavior profiles and attach them to agents via `compileBehaviorProfile()` and `attachProfilesToAgent()` in `packages/compiler/src/platform/ir/compile-behavior-profile.ts`.
12. **FR-12**: The system must resolve config variables at compile time using the `CONFIG_VAR_PATTERN` regex and emit warnings for unresolved references.
13. **FR-13**: The system must enforce a compilation timeout (default 30,000ms, configurable via `CompilerOptions.compilationTimeoutMs`) and emit error `E727` when exceeded.
14. **FR-14**: The system must prevent shadowing of system tool names (`__handoff__`, `__delegate__`, `__complete__`, `__escalate__`, `__fan_out__`, `__set_context__`) by project tool declarations.
15. **FR-15**: The system must generate source hashes (SHA-256) for change detection and deduplication of compiled artifacts.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                            |
| -------------------------- | ------------ | -------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Agents belong to projects; compile context is project-scoped                     |
| Agent lifecycle            | PRIMARY      | ABL is the authoring surface for all agent definitions                           |
| Customer experience        | PRIMARY      | Agent behavior directly shapes end-user conversation quality                     |
| Integrations / channels    | SECONDARY    | IR carries voice/digital/workflow optimization hints for channel adaptation      |
| Observability / tracing    | SECONDARY    | CompilationOutput carries structured errors/warnings with machine-readable codes |
| Governance / controls      | PRIMARY      | Guardrails, constraints, and preflight validation are compile-time gates         |
| Enterprise / compliance    | SECONDARY    | Config variable resolution, secret exclusion, and audit trails                   |
| Admin / operator workflows | SECONDARY    | Version promotion lifecycle managed through compiled artifacts                   |

### Related Feature Integration Matrix

| Related Feature                                             | Relationship Type | Why It Matters                                                            | Key Touchpoints                                     | Current State |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------- | ------------- |
| [Agent Anatomy](./agent-anatomy.md)                         | depends on        | Agent anatomy defines the structural concepts that ABL encodes            | AgentIR schema, identity, tools, flow, coordination | STABLE        |
| [Agent Development (Studio)](./agent-development-studio.md) | extends           | Studio provides the editing surface that consumes language-service output | Editor store, compile API, diagnostics API          | STABLE        |
| [Deployments & Versioning](./deployments-versioning.md)     | emits into        | Compiled IR is the input to versioning and deployment workflows           | agent_versions collection, irContent field          | STABLE        |
| [Auth Profiles](./auth-profiles.md)                         | shares data with  | Auth config is compiled from DSL AUTH: sections into IR auth config       | auth-config-builder.ts, AuthConfigIR                | ALPHA         |
| [Guardrails](./circuit-breaker.md)                          | shares data with  | Guardrail definitions in DSL compile into IR guardrail configs            | guardrail-validator.ts, guardrail-action.ts         | STABLE        |

---

## 6. Design Considerations

### Editor Integration

- Studio uses a code editor component (`AgentEditor.tsx`) with real-time diagnostics, inline error banners, and compile-on-save behavior
- The language service provides completions at the current cursor position, hover documentation for ABL keywords, and document symbols for outline/navigator views
- Format detection determines whether to route through the Chevrotain-based parser or the YAML parser before diagnostics run
- The serialize-yaml module (`packages/language-service/src/serialize-yaml.ts`, 1,174 LOC) enables IR-to-YAML round-trip editing

### DSL Syntax Design

- Uppercase DSL uses section-header syntax (`AGENT:`, `GOAL:`, `FLOW:`) parsed by a regex-based line scanner
- YAML format uses lowercase keys (`agent:`, `goal:`, `flow:`) parsed via `js-yaml`
- Both formats coexist in production and both are supported domain conventions (neither is "legacy")
- Expression syntax supports CEL with custom `abl.*` functions for string manipulation, date handling, formatting, type checking, and array operations

---

## 7. Technical Considerations

### Parser Architecture

- The uppercase DSL parser (`agent-based-parser.ts`, 6,701 LOC) is a regex-based line scanner -- not a Chevrotain grammar. The Chevrotain lexer (`lexer.ts`, 524 LOC) and CST parser are only used for supervisor documents.
- The YAML parser (`yaml-parser.ts`, 1,031 LOC) uses `js-yaml` for initial parsing, then maps YAML structures to the same `AgentBasedDocument` type system.
- Both parsers emit parse warnings (non-blocking) and produce identical AST types, ensuring downstream compilation is format-agnostic.

### Compilation Pipeline

The compilation pipeline follows these stages:

1. **Format detection** -- heuristic scan of first non-empty line
2. **Parsing** -- DSL or YAML parser produces `AgentBasedDocument[]`
3. **Behavior profile separation** -- profiles compiled first, then agents
4. **Agent compilation** -- each document compiled to `AgentIR` via `compileAgentToIR()`
5. **Profile attachment** -- behavior profiles merged onto referencing agents
6. **Post-compilation validation** -- flow graph, tool refs, cross-agent refs, field refs, guardrails, preflight
7. **Output assembly** -- `CompilationOutput` with agents, errors, warnings, deployment hints

### CEL Expression Evaluation

- Uses `@marcbachmann/cel-js` with BigInt normalization for safe integer handling
- 35+ custom functions registered under the `abl` namespace (string, numeric, date, formatting, type, array)
- Expression length capped at 4,096 bytes to prevent abuse
- CEL's `has()` macro requires member access syntax (`has(obj.field)`), not bare identifiers

### Dependency Chain

```
packages/core (parser, types, schema)
    |
    v
packages/compiler (IR compiler, validators, CEL, guardrails)
    |
    v
packages/language-service (diagnostics, completions, hover, symbols)
    |
    v
apps/studio (editor UI, compile API routes)
```

---

## 8. How to Consume

### Studio UI

- **Agent Editor** (`apps/studio/src/components/agent-editor/AgentEditor.tsx`): Main authoring experience with inline diagnostics and compile-on-save
- **DSL Editor Tab** (`apps/studio/src/components/agents/DslEditorTab.tsx`): Raw DSL editing surface
- **Editor Store** (`apps/studio/src/store/editor-store.ts`): Zustand store for compile errors and compiled IR state
- Route: Agent editor is accessed via the project agent detail page in Studio

### API (Studio)

| Method | Path                   | Purpose                                     |
| ------ | ---------------------- | ------------------------------------------- |
| POST   | `/api/abl/compile`     | Compile DSL source into IR                  |
| POST   | `/api/abl/diagnostics` | Parse and return 3-tier diagnostics         |
| GET    | `/api/abl/docs`        | Language docs/snippets metadata             |
| POST   | `/api/abl/analysis`    | Higher-level ABL analysis helpers           |
| POST   | `/api/abl/parse`       | Parse DSL into AST without full compilation |

### API (Runtime)

| Method | Path                                                | Purpose                            |
| ------ | --------------------------------------------------- | ---------------------------------- |
| POST   | `/api/projects/:projectId/validate`                 | Project validation entry point     |
| POST   | `/api/projects/:projectId/agents/:agentId/versions` | Version creation from compiled DSL |

### Admin Portal

Admin users do not author ABL directly. Platform-admin inspection paths rely on compiled artifacts and version metadata:

- `agent_versions` records with `status: 'active'` are the source of truth for deployed agents
- Version promotion lifecycle (draft -> testing -> staged -> active -> deprecated) is managed through runtime routes
- Tool snapshots frozen at version time enable audit trails

### Channel / SDK / Voice / A2A / MCP Integration

ABL Language itself is channel-agnostic. The compiled IR carries optimization hints (`optimize_for: 'voice' | 'digital' | 'workflow'`) and voice-specific config (`VoiceConfigIR`) that downstream runtimes use for channel adaptation. The `RichContentIR` type supports markdown, adaptive cards, HTML, Slack Block Kit, AG-UI, WhatsApp, and carousel formats for multi-channel output.

---

## 9. Data Model

### Collections / Tables

```text
Collection: project_agents
Purpose: Stores agent DSL source and metadata
Fields:
  - _id: string (required)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required)
  - dslContent: string (required, raw DSL source)
  - ownerId: string (required)
  - lastEditedBy: string
  - isEntryAgent: boolean
  - status: string (draft | active | archived)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { projectId: 1, name: 1 } (unique within project)
```

```text
Collection: agent_versions
Purpose: Immutable compiled snapshots for deployment
Fields:
  - _id: string (required)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - agentId: string (required, references project_agents._id)
  - version: string (required, semver)
  - status: string (required -- draft | testing | staged | active | deprecated)
  - dslContent: string (required, frozen DSL at version time)
  - irContent: string (required, JSON-serialized AgentIR)
  - sourceHash: string (required, SHA-256 for dedup)
  - changelog: string | null
  - createdBy: string (required)
  - promotedAt: Date | null
  - promotedBy: string | null
  - toolSnapshot: Array<{
      name: string,
      projectToolId: string,
      sourceHash: string,
      toolType: 'http' | 'sandbox' | 'mcp' | 'searchai',
      description: string | null,
      dslContent: string
    }> | null (frozen tool definitions at version time)
  - testResults: Mixed | null
  - _v: number (schema version, default 1)
  - createdAt: Date (auto, timestamps)
  - updatedAt: Date (auto, timestamps)
Indexes:
  - { agentId: 1, version: 1 } (unique)
  - { agentId: 1, createdAt: -1 } (version listing with sort)
  - { agentId: 1 }
  - { status: 1 }
```

```text
Collection: project_runtime_configs
Purpose: Provides compile-time/runtime validation context for extraction, lookup, and multi-intent settings
```

### Key Relationships

- `project_agents.dslContent` is the source that compiles into `agent_versions.irContent` (JSON-serialized `AgentIR`)
- `agent_versions.agentId` references `project_agents._id`
- `agent_versions.toolSnapshot` freezes the resolved tool implementations at version creation time
- Studio compile APIs can inject resolved tool/config-variable context before emitting IR
- Runtime and deployment features consume the compiled output (`irContent`), not the raw editor buffer
- Behavior profiles are compiled alongside agents and attached via `attachProfilesToAgent()`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts`                | Primary DSL agent parser (regex-based line scanner, 6,701 LOC)                               |
| `packages/core/src/parser/yaml-parser.ts`                       | YAML flow parser via `js-yaml`, produces same `AgentBasedDocument` AST (1,031 LOC)           |
| `packages/core/src/parser/expression-parser.ts`                 | Expression parsing for conditions and assignments (502 LOC)                                  |
| `packages/core/src/parser/lexer.ts`                             | Chevrotain lexer with all ABL tokens (524 LOC, used by supervisor parser)                    |
| `packages/core/src/parser/supervisor-parser.ts`                 | Chevrotain CST parser for supervisor documents                                               |
| `packages/core/src/parser/tool-file-parser.ts`                  | Parser for `.tools.abl` files (reusable tool collections)                                    |
| `packages/core/src/parser/tool-parser-utils.ts`                 | Shared tool parameter/return parsing utilities                                               |
| `packages/core/src/parser/tool-import-resolver.ts`              | Resolves tool imports across files                                                           |
| `packages/core/src/types/agent-based.ts`                        | Full AST type definitions: `AgentBasedDocument`, flow steps, gather, constraints (1,413 LOC) |
| `packages/core/src/types/base.ts`                               | Base types: `DocumentMeta`, `DocumentKind`, `TypeDefinition`, `VariableDefinition`           |
| `packages/core/src/types/expressions.ts`                        | Expression AST: `Expression`, `Condition`, `BinaryExpression`, operators                     |
| `packages/core/src/types/supervisor.ts`                         | Supervisor AST: `SupervisorDocument`, `AgentRef`, `IntentMapping`, `Policy`                  |
| `packages/core/src/types/tool-file.ts`                          | Tool file AST: `ToolFileDocument`, `ToolFileDefaults`                                        |
| `packages/core/src/schema/abl-schema.json`                      | JSON Schema for validating ABL YAML-format agent definitions                                 |
| `packages/compiler/src/platform/ir/compiler.ts`                 | `compileABLtoIR()`: AST -> AgentIR compilation with tool resolution (2,751 LOC)              |
| `packages/compiler/src/platform/ir/schema.ts`                   | Full IR type definitions: `AgentIR`, `CompilationOutput`, `FlowConfig` (2,044 LOC)           |
| `packages/compiler/src/platform/ir/validate-ir.ts`              | IR validation orchestrator: runs all validators against compiled IR                          |
| `packages/compiler/src/platform/ir/validate-cross-agent.ts`     | Cross-agent reference validator (handoff, delegate, routing targets)                         |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`      | Field reference validator (condition variables, gather depends_on)                           |
| `packages/compiler/src/platform/ir/validate-preflight.ts`       | Preflight validation for deployment readiness                                                |
| `packages/compiler/src/platform/ir/validate-input-mappings.ts`  | Input mapping validator (CEL expression safety)                                              |
| `packages/compiler/src/platform/ir/validation-types.ts`         | Validation codes and diagnostic types (20+ codes)                                            |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`    | Tool definition quality validation (descriptions, params)                                    |
| `packages/compiler/src/platform/ir/graph-extractor.ts`          | Static flow graph extraction for visualization                                               |
| `packages/compiler/src/platform/ir/guardrail-validator.ts`      | Guardrail IR validation                                                                      |
| `packages/compiler/src/platform/ir/guardrail-action.ts`         | Guardrail action types and severity levels                                                   |
| `packages/compiler/src/platform/ir/auth-config-builder.ts`      | Auth configuration builder from AST                                                          |
| `packages/compiler/src/platform/ir/recall-validation.ts`        | RECALL event validation                                                                      |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Behavior profile compilation and attachment                                                  |
| `packages/compiler/src/platform/constructs/cel-evaluator.ts`    | CEL expression evaluator wrapping `@marcbachmann/cel-js`                                     |
| `packages/compiler/src/platform/constructs/cel-functions.ts`    | 35+ custom `abl.*` CEL functions (string, numeric, formatting, type, array)                  |
| `packages/compiler/src/platform/constants.ts`                   | Shared constants: system tool names, default messages, timeouts, context keys                |

### Language Service

| File                                              | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/language-service/src/diagnostics.ts`    | 3-tier diagnostics pipeline (syntax, structural, compile) (92 LOC)       |
| `packages/language-service/src/completions.ts`    | Context-aware completions (top-level keys, tools, agents, CEL) (513 LOC) |
| `packages/language-service/src/hover.ts`          | Hover documentation for ABL keywords (26 LOC)                            |
| `packages/language-service/src/symbols.ts`        | Document symbol extraction for outline/tree-view (239 LOC)               |
| `packages/language-service/src/detect-format.ts`  | Heuristic YAML vs uppercase format detection (33 LOC)                    |
| `packages/language-service/src/serialize-yaml.ts` | IR-to-YAML serializer for round-trip editing (1,174 LOC)                 |
| `packages/language-service/src/docs.ts`           | Keyword documentation registry for hover info (38 LOC)                   |
| `packages/language-service/src/cel-functions.ts`  | Static CEL function metadata for completions and hover (222 LOC)         |
| `packages/language-service/src/types.ts`          | `Diagnostic`, `CompletionItem`, `HoverInfo`, `DocumentSymbol` types      |

### Routes / Handlers

| File                                               | Purpose                            |
| -------------------------------------------------- | ---------------------------------- |
| `apps/studio/src/app/api/abl/compile/route.ts`     | Studio compile endpoint            |
| `apps/studio/src/app/api/abl/diagnostics/route.ts` | Parse/compile diagnostics endpoint |
| `apps/studio/src/app/api/abl/docs/route.ts`        | Language docs/snippets metadata    |
| `apps/studio/src/app/api/abl/analysis/route.ts`    | Higher-level ABL analysis helpers  |
| `apps/studio/src/app/api/abl/parse/route.ts`       | Parse DSL into AST endpoint        |
| `apps/runtime/src/routes/validate.ts`              | Project validation entry point     |
| `apps/runtime/src/routes/versions.ts`              | Version creation from compiled DSL |

### UI Components (Studio)

| File                                                                       | Purpose                                  |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/studio/src/components/agent-editor/AgentEditor.tsx`                  | Main authoring experience                |
| `apps/studio/src/components/agent-editor/AgentEditorHeader.tsx`            | Editor header with agent name and status |
| `apps/studio/src/components/agent-editor/AgentEditorMenu.tsx`              | Editor actions menu                      |
| `apps/studio/src/components/agent-editor/AgentEditorBanners.tsx`           | Compile error/warning banners            |
| `apps/studio/src/components/agent-editor/containers/AgentEditorPage.tsx`   | Full-page editor container               |
| `apps/studio/src/components/agent-editor/containers/AgentEditorModal.tsx`  | Modal editor container                   |
| `apps/studio/src/components/agent-editor/containers/AgentEditorSlider.tsx` | Slider editor container                  |
| `apps/studio/src/components/agents/DslEditorTab.tsx`                       | Raw DSL editing surface                  |
| `apps/studio/src/store/editor-store.ts`                                    | Compile errors + compiled IR state       |

### Tests

| File                                                                       | Type        | Description                                                               |
| -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------- |
| `packages/core/src/__tests__/agent-based-parser.test.ts`                   | unit        | Primary parser coverage                                                   |
| `packages/core/src/__tests__/yaml-parser.test.ts`                          | unit        | YAML parser coverage                                                      |
| `packages/core/src/__tests__/yaml-flow-parser.test.ts`                     | unit        | YAML flow parsing and AST parity                                          |
| `packages/core/src/__tests__/expression-parser.test.ts`                    | unit        | Expression/condition parsing                                              |
| `packages/core/src/__tests__/lexer.test.ts`                                | unit        | Chevrotain lexer token coverage                                           |
| `packages/core/src/__tests__/supervisor-parser.test.ts`                    | unit        | Supervisor document parsing                                               |
| `packages/core/src/__tests__/tool-file-parser.test.ts`                     | unit        | Tool file parsing                                                         |
| `packages/core/src/__tests__/tool-import-resolver.test.ts`                 | unit        | Tool import resolution                                                    |
| `packages/core/src/__tests__/rich-content-parser.test.ts`                  | unit        | Rich content parsing                                                      |
| `packages/core/src/__tests__/behavior-profile-parser.test.ts`              | unit        | Behavior profile parsing                                                  |
| `packages/core/src/__tests__/dsl-extensions-parser.test.ts`                | unit        | DSL extension constructs (positive)                                       |
| `packages/core/src/__tests__/dsl-extensions-parser-negative.test.ts`       | unit        | DSL extension constructs (negative/error cases)                           |
| `packages/core/src/__tests__/parser-*.test.ts` (8 files)                   | unit        | Specialized parser tests (memory, gather, handoff, constraints, etc.)     |
| `packages/core/src/__tests__/abl-schema.test.ts`                           | unit        | JSON Schema validation                                                    |
| `packages/compiler/src/__tests__/e2e/e2e.test.ts`                          | e2e         | Full DSL-to-IR compilation                                                |
| `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`       | e2e         | Supervisor/topology compilation                                           |
| `packages/compiler/src/__tests__/e2e/traveldesk-hotel-booking.e2e.test.ts` | e2e         | Full travel booking scenario                                              |
| `packages/compiler/src/__tests__/validate-cross-agent.test.ts`             | integration | Cross-agent reference validation                                          |
| `packages/compiler/src/__tests__/validate-abl-export.test.ts`              | integration | ABL export/validation compatibility                                       |
| `packages/compiler/src/__tests__/validate-field-refs.test.ts`              | integration | Field reference validation                                                |
| `packages/compiler/src/__tests__/validate-flow-graph.test.ts`              | integration | Flow graph integrity validation                                           |
| `packages/compiler/src/__tests__/validate-input-mappings.test.ts`          | integration | Input mapping validation                                                  |
| `packages/compiler/src/__tests__/validate-integration.test.ts`             | integration | Full validation pipeline integration                                      |
| `packages/compiler/src/__tests__/validate-preflight.test.ts`               | integration | Preflight deployment validation                                           |
| `packages/compiler/src/__tests__/validate-tool-refs.test.ts`               | integration | Tool reference validation                                                 |
| `packages/compiler/src/__tests__/dual-format-compilation.test.ts`          | integration | Legacy and YAML format compilation parity                                 |
| `packages/compiler/src/__tests__/ir/*.test.ts` (12 files)                  | unit        | IR-level tests (behavior profiles, auth, config vars, rich content, etc.) |
| `packages/compiler/src/__tests__/guardrails/*.test.ts` (29 files)          | unit/e2e    | Guardrail compilation, evaluation, and pipeline                           |
| `packages/language-service/src/__tests__/diagnostics.test.ts`              | unit        | 3-tier diagnostics pipeline                                               |
| `packages/language-service/src/__tests__/completions.test.ts`              | unit        | Context-aware completions                                                 |
| `packages/language-service/src/__tests__/cel-completions.test.ts`          | unit        | CEL function completions                                                  |
| `packages/language-service/src/__tests__/hover.test.ts`                    | unit        | Hover documentation                                                       |
| `packages/language-service/src/__tests__/symbols.test.ts`                  | unit        | Document symbol extraction                                                |
| `packages/language-service/src/__tests__/detect-format.test.ts`            | unit        | Format detection heuristic                                                |
| `packages/language-service/src/__tests__/serialize-yaml.test.ts`           | unit        | IR-to-YAML round-trip serialization                                       |
| `apps/studio/src/__tests__/abl-serializers.test.ts`                        | unit        | Studio-side serialization helpers                                         |
| `apps/studio/src/__tests__/editor-store.test.ts`                           | unit        | Editor store state management                                             |

---

## 11. Configuration

### Environment Variables

| Variable            | Default         | Description                                                           |
| ------------------- | --------------- | --------------------------------------------------------------------- |
| `LOG_LEVEL`         | `debug`/`info`  | Logging level for compiler/parser output (debug in dev, info in prod) |
| `LOG_FORMAT`        | `simple`/`json` | Log format (simple in dev, json in prod)                              |
| `LLM_CACHE_ENABLED` | `true`          | Enable/disable LLM response caching for compilation tests             |
| `LLM_CACHE_DIR`     | `.llm-cache`    | Directory for cached LLM responses during compilation                 |
| `LLM_CACHE_TTL_MS`  | `0`             | TTL for cached LLM responses (0 = no expiry)                          |

### Runtime Configuration

- Compile requests may include resolved tool bindings (`resolvedToolImplementations`) and config variables (`config_variables`)
- Project runtime config influences lookup tables, multi-intent behavior, and extraction defaults
- Parse warnings are non-blocking and surface in Studio/editor flows

### Compiler Options (`CompilerOptions`)

| Option                        | Type                                 | Default     | Description                                                  |
| ----------------------------- | ------------------------------------ | ----------- | ------------------------------------------------------------ |
| `version`                     | `string`                             | `'1.0.0'`   | Semantic version for compiled IR metadata                    |
| `optimize_for`                | `'voice' \| 'digital' \| 'workflow'` | --          | Target runtime for optimization hints                        |
| `include_source_maps`         | `boolean`                            | --          | Include source map information in IR                         |
| `config_variables`            | `Record<string, string>`             | --          | Config variable values resolved at compile time              |
| `resolvedToolImplementations` | `Map<string, ToolDefinition[]>`      | --          | Pre-resolved tool implementations from project_tools         |
| `staleSignatureThreshold`     | `number` (0-100)                     | disabled    | Fail compilation if > X% of tools have stale signatures      |
| `compilationTimeoutMs`        | `number`                             | `30000`     | Compilation timeout in milliseconds                          |
| `mode`                        | `'strict' \| 'preview'`              | `'preview'` | Strict fails on unresolved tools; preview returns partial IR |
| `coordination_defaults`       | `ProjectCoordinationDefaults`        | --          | Project-level coordination settings                          |

### DSL / Agent IR

This feature is the source-of-truth for AgentIR generation. Key schema files:

- IR output schema: `packages/compiler/src/platform/ir/schema.ts`
- JSON Schema for validation: `packages/core/src/schema/abl-schema.json`
- AST types: `packages/core/src/types/agent-based.ts`

---

## 12. Runtime Integration

ABL activates at authoring, validation, version creation, deployment, and live execution bootstrap time. Runtime does not execute the DSL directly; it executes the compiled IR resolved from agent/version records.

### Lifecycle

1. Source is edited in Studio or imported through Project IO.
2. Parser + diagnostics run in Studio or validation endpoints. Format is auto-detected (YAML vs uppercase).
3. Parser produces `AgentBasedDocument` AST (or `SupervisorDocument` for supervisors).
4. Compiler emits `CompilationOutput` containing `AgentIR` records, deployment hints, errors, and warnings.
5. Post-compilation validators run: flow graph, tool references, cross-agent references, field references, guardrails, preflight.
6. Versioning/deployment stores the resulting artifact (`irContent`) with a frozen `toolSnapshot` for runtime execution.

### Dependencies

- `packages/core` parser layer (lexer, agent-based parser, YAML parser, expression parser, supervisor parser)
- `packages/compiler` IR compiler, validators, and constructs (CEL evaluator, guardrails, model selector)
- `packages/language-service` diagnostics, completions, hover, symbols
- Project tool/config resolution during compile (resolved via `CompilerOptions`)

### Event Flow

Compilation warnings and errors surface to editor state, validation routes, versioning routes, and deployment logs. The `CompilationOutput` carries both `compilation_errors` (blocking, agents omitted from output) and `compilation_warnings` (non-blocking). Traceability for downstream execution begins after IR is handed off to runtime features.

### DSL Example (YAML format)

```yaml
agent: Hotel_Booking
goal: Help users book hotel rooms
persona: Friendly and efficient hotel booking assistant

execution:
  model: gpt-4o
  temperature: 0.3

tools:
  - name: search_hotels
    description: Search for available hotels
    type: http
    parameters:
      - name: destination
        type: string
        required: true
      - name: check_in
        type: date
        required: true

gather:
  - name: destination
    type: string
    prompt: 'Where would you like to stay?'
    required: true
  - name: check_in
    type: date
    prompt: 'What is your check-in date?'
    required: true
    validation:
      type: cel
      rule: 'abl.date_after(value, abl.today())'
      error_message: 'Check-in date must be in the future'

constraints:
  - rule: 'Only book hotels in supported regions'
    action: block

flow:
  start:
    respond: 'Welcome! I can help you book a hotel.'
    then: collect_info
  collect_info:
    gather: [destination, check_in]
    then: search
  search:
    call: search_hotels
    call_with:
      destination: '{{destination}}'
      check_in: '{{check_in}}'
    then: present_results

handoff:
  - target: Payment_Agent
    when: 'booking_confirmed == true'
    context:
      - booking_id
      - total_price
```

### Compiled IR Output (abbreviated)

```json
{
  "ir_version": "1.0",
  "metadata": {
    "name": "Hotel_Booking",
    "version": "1.0.0",
    "type": "agent",
    "compiled_at": "2026-03-18T10:00:00.000Z",
    "source_hash": "a1b2c3d4...",
    "compiler_version": "1.0.0"
  },
  "identity": {
    "goal": "Help users book hotel rooms",
    "persona": "Friendly and efficient hotel booking assistant"
  },
  "execution": {
    "model": "gpt-4o",
    "temperature": 0.3
  },
  "tools": [
    {
      "name": "search_hotels",
      "description": "Search for available hotels",
      "tool_type": "http",
      "parameters": [
        { "name": "destination", "type": "string", "required": true },
        { "name": "check_in", "type": "date", "required": true }
      ]
    }
  ],
  "gather": {
    "fields": [
      {
        "name": "destination",
        "type": "string",
        "prompt": "Where would you like to stay?",
        "required": true
      },
      {
        "name": "check_in",
        "type": "date",
        "prompt": "What is your check-in date?",
        "required": true,
        "validation": {
          "type": "cel",
          "rule": "abl.date_after(value, abl.today())",
          "error_message": "Check-in date must be in the future"
        }
      }
    ]
  },
  "flow": {
    "entry_point": "start",
    "steps": [
      {
        "name": "start",
        "respond": "Welcome! I can help you book a hotel.",
        "transition": "collect_info"
      },
      {
        "name": "collect_info",
        "gather": ["destination", "check_in"],
        "transition": "search"
      },
      {
        "name": "search",
        "call": "search_hotels",
        "transition": "present_results"
      }
    ]
  },
  "coordination": {
    "handoffs": [
      {
        "target": "Payment_Agent",
        "when": "booking_confirmed == true",
        "context": ["booking_id", "total_price"]
      }
    ]
  }
}
```

---

## 13. Admin Integration

Admin users do not author ABL directly, but platform-admin inspection paths rely on the compiled artifacts and version metadata produced by this feature. Specifically:

- `agent_versions` records with `status: 'active'` are the source of truth for deployed agents
- Version promotion lifecycle (draft -> testing -> staged -> active -> deprecated) is managed through runtime routes
- Tool snapshots frozen at version time enable audit trails of what was deployed

---

## 14. Delivery Plan / Work Breakdown

1. Tighten the authoring/runtime handoff
   1.1 Add stronger coverage around editor-driven compile/save loops
   1.2 Improve validation gates for unresolved tools, stale signatures, and export compatibility
2. Reduce authoring-path fragmentation
   2.1 Continue closing raw-DSL-only authoring affordances
   2.2 Evaluate whether the dual parser paths can share more validation/grammar infrastructure
3. Improve operator confidence in compiled output
   3.1 Add clearer source-map or path-level diagnostic metadata
   3.2 Strengthen package-level coverage gates for parser/compiler/language-service changes
4. Harden CEL expression handling
   4.1 Add fuzz testing for CEL evaluator edge cases (BigInt overflow, deeply nested expressions)
   4.2 Document all 35+ `abl.*` functions with input/output examples in language-service docs
5. Strengthen supervisor/topology compilation
   5.1 Add cross-supervisor validation (circular routing, unreachable agents)
   5.2 Add topology graph extraction for multi-supervisor projects

---

## 15. Success Metrics

| Metric               | Baseline                                                                                   | Target                                                       | How Measured                                  |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------- |
| Compile correctness  | Strong package-level parser/compiler coverage (3,947+ core, 8,861+ compiler tests passing) | Zero parser/compiler regressions reaching deployment         | Package-level test suites in CI               |
| Authoring confidence | Browser authoring loop coverage is thinner than package-level coverage                     | Full editor-driven diagnostics/compile coverage in E2E       | Studio/browser test inventory                 |
| Format stability     | Both formats compile through separate parser paths                                         | Maintain IR parity and validation parity across both formats | Dual-format compilation and validation suites |
| Compile latency      | Not formally tracked                                                                       | P95 compile latency < 5s for single-agent definitions        | Compile API response time monitoring          |
| Validation coverage  | 20+ validation codes defined                                                               | All validation codes exercised in integration tests          | Validation test suite coverage report         |

---

## 16. Open Questions

1. Should the uppercase DSL and YAML syntax continue to evolve in parallel, or should the platform converge on one primary authoring path over time?
2. How much of the current heuristic language-service behavior should move toward a fuller semantic/LSP-style implementation?
3. Should compilation and validation gains be enforced through explicit package coverage thresholds or compile gates?
4. Should incremental compilation be implemented to reduce latency for large multi-agent projects, or is the current full-recompile model acceptable?
5. Should the CEL evaluator's BigInt normalization layer be replaced with explicit type coercion at the DSL level?

---

## 17. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                          | Severity | Status      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| GAP-001 | No real-time collaborative editing/presence on top of the DSL editor                                                                                                 | Low      | Open        |
| GAP-002 | Some higher-level authoring affordances still require raw DSL fallback instead of full visual editing                                                                | Medium   | In Progress |
| GAP-003 | Compile diagnostics are strong in Studio APIs but not yet enforced as minimum coverage gates per package                                                             | Medium   | Open        |
| GAP-004 | Uppercase format and YAML format maintain separate parsing codepaths; no shared grammar (uppercase uses regex scanner, YAML uses `js-yaml`)                          | Low      | By Design   |
| GAP-005 | No incremental/partial compilation -- full `AgentBasedDocument[]` is recompiled on every change, which may cause latency for large multi-agent projects              | Medium   | Open        |
| GAP-006 | CEL evaluator wraps `@marcbachmann/cel-js` which treats integer literals as BigInt; normalization layer handles this but edge cases exist with mixed-type arithmetic | Low      | Known       |
| GAP-007 | `CompilerOptions.include_source_maps` is declared but source maps are not fully implemented in the IR output                                                         | Low      | Open        |
| GAP-008 | Language service completions and hover are position-heuristic based (line scanning), not backed by a full LSP server with semantic analysis                          | Medium   | Open        |
| GAP-009 | No dedicated ABL linter CLI -- validation requires importing and calling `compileABLtoIR()` programmatically                                                         | Low      | Open        |

---

## 18. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `project_agents` and project-scoped versioning/validation flows must always resolve through the owning `projectId`, with cross-project access hidden as `404`.  |
| Tenant isolation  | Agent and version access is tenant-bounded through the parent project lookup chain and related route authorization.                                             |
| User isolation    | Authoring metadata such as `ownerId`, `lastEditedBy`, and related Studio flows must not expose other users' private project resources outside authorized scope. |

### Performance

- Parsing and compilation are synchronous, CPU-bound operations. A 30-second compilation timeout (`compilationTimeoutMs`) guards against runaway compilations.
- Studio debounces repeated diagnostic requests to avoid flooding the compile API.
- LLM response caching (`LLM_CACHE_ENABLED`) speeds up compilation tests that involve real model calls.
- The CEL evaluator caps expression length at 4,096 bytes to prevent abuse.

### Security

- Compiled output excludes raw secret values and relies on later auth/variable-resolution layers for runtime credential injection.
- System tool names (`__handoff__`, `__delegate__`, `__complete__`, `__escalate__`, `__fan_out__`, `__set_context__`) cannot be shadowed by project tool declarations.
- Config variable patterns (`CONFIG_VAR_PATTERN`) are resolved at compile time; unresolved references emit warnings.
- Guardrail validation ensures safety constraints are well-formed before deployment.

### Scalability

- Compilation is stateless and horizontally scalable; each compile request is independent.
- The bottleneck is usually surrounding tool/config resolution rather than AST generation.
- No shared state between compile calls -- each invocation builds a fresh `CompilationOutput`.

### Observability

- Studio and runtime validation routes log compile failures via `createLogger('module')`.
- Versioning/deployment routes preserve compile error messages for operator review.
- `CompilationOutput` carries structured `compilation_errors` and `compilation_warnings` arrays with agent name, message, and optional path information.
- Validation diagnostics include machine-readable codes (20+ defined in `VALIDATION_CODES`) for programmatic processing.

### Data Lifecycle

- Raw source lives in `project_agents.dslContent` while immutable compiled/versioned snapshots live in `agent_versions`.
- Source hashes and frozen tool snapshots exist to support change detection, auditability, rollback, and redeploy flows.
- The feature does not persist secrets directly in source; credential injection happens later through auth/config-variable layers.

---

## 19. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] Parser, lexer, and schema validation cover the core DSL surface.
- [x] YAML flow parsing and AST parity are covered.
- [x] Cross-agent/tool reference validation and export compatibility are covered.
- [x] Dual-format compilation parity (uppercase and YAML produce same IR) is covered.
- [x] Flow graph, field reference, input mapping, and preflight validation are covered.

#### E2E

- [x] Real DSL files compile end-to-end into IR artifacts.
- [x] Supervisor and topology composition compile end-to-end.
- [x] Full travel booking scenario tested end-to-end with real LLM calls.

### E2E Test Scenarios

| #   | Scenario                        | Status | Test File                                                                  |
| --- | ------------------------------- | ------ | -------------------------------------------------------------------------- |
| 1   | DSL parse + compile to IR       | PASS   | `packages/compiler/src/__tests__/e2e/e2e.test.ts`                          |
| 2   | Supervisor/topology compilation | PASS   | `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`       |
| 3   | Travel booking full scenario    | PASS   | `packages/compiler/src/__tests__/e2e/traveldesk-hotel-booking.e2e.test.ts` |
| 4   | Studio compile API surface      | PASS   | `apps/studio/src/app/api/abl/compile/route.ts` + unit coverage             |
| 5   | Dual-format parity (DSL + YAML) | PASS   | `packages/compiler/src/__tests__/dual-format-compilation.test.ts`          |

### Integration Test Scenarios

| #   | Scenario                             | Status | Test File                                                         |
| --- | ------------------------------------ | ------ | ----------------------------------------------------------------- |
| 1   | Cross-agent reference validation     | PASS   | `packages/compiler/src/__tests__/validate-cross-agent.test.ts`    |
| 2   | ABL export compatibility             | PASS   | `packages/compiler/src/__tests__/validate-abl-export.test.ts`     |
| 3   | Flow graph integrity validation      | PASS   | `packages/compiler/src/__tests__/validate-flow-graph.test.ts`     |
| 4   | Field reference validation           | PASS   | `packages/compiler/src/__tests__/validate-field-refs.test.ts`     |
| 5   | Input mapping validation             | PASS   | `packages/compiler/src/__tests__/validate-input-mappings.test.ts` |
| 6   | Preflight deployment validation      | PASS   | `packages/compiler/src/__tests__/validate-preflight.test.ts`      |
| 7   | Full validation pipeline integration | PASS   | `packages/compiler/src/__tests__/validate-integration.test.ts`    |

### Unit Test Coverage

| Package                     | Test Files | Passing |
| --------------------------- | ---------- | ------- |
| `packages/core`             | 25         | Yes     |
| `packages/compiler`         | 168        | Yes     |
| `packages/language-service` | 7          | Yes     |
| `apps/studio`               | 2          | Yes     |

### Testing Notes

The package-level parser, compiler, validator, and language-service suites provide strong confidence in ABL correctness below the browser layer. The main remaining weakness is broader browser-driven editing/diagnostics automation rather than the parser/compiler contract itself.

> Full testing details: [docs/testing/abl-language.md](../testing/abl-language.md)

---

## 20. References

- Feature matrix: `docs/feature-matrix.md` sections 1.1-1.2
- Enterprise readiness: `docs/enterprise-readiness.md` section 9
- JSON Schema: `packages/core/src/schema/abl-schema.json`
- IR Schema: `packages/compiler/src/platform/ir/schema.ts`
- AST Types: `packages/core/src/types/agent-based.ts`
- CEL Functions: `packages/compiler/src/platform/constructs/cel-functions.ts`
- Related features: [Agent Anatomy](./agent-anatomy.md), [Agent Development (Studio)](./agent-development-studio.md), [Deployments & Versioning](./deployments-versioning.md)
