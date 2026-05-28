# Feature: Agent Anatomy

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `enterprise`, `admin operations`
**Package(s)**: `packages/compiler`, `apps/runtime`, `packages/database`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/agent-anatomy.md](../testing/agent-anatomy.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

The platform needs a stable runtime representation of an agent after authoring is complete so that execution, versioning, deployment, and model binding do not depend on raw editor state. Without that contract, every runtime surface (digital, voice, workflow, orchestration) would need to understand ABL source syntax directly, and versioned execution would be much harder to reason about. Additionally, operators and Studio users need a consistent way to inspect, manage, and promote agents across environments without re-parsing DSL at every request.

### Goal Statement

Agent Anatomy defines the runtime shape of an agent after compilation: agent types, `AgentIR`, versioned artifacts, model overrides, and stored metadata that make execution, promotion, and inspection consistent across the platform. It provides the single canonical contract between authoring and execution.

### Summary

Agent Anatomy describes the runtime shape of an agent after authoring is complete: agent types, AgentIR structure, contracts, behavior overlays, completion rules, and the stored/versioned artifacts that power execution and deployment.

This feature sits between ABL authoring and live runtime execution. It gives the platform a stable representation for reasoning, flow, supervisor, voice, digital, and workflow agents while preserving the metadata needed for versioning, model binding, and deployment promotion.

The core abstraction is the **Agent Intermediate Representation (IR)** — a framework-agnostic JSON structure produced by the DSL compiler (`packages/compiler/src/platform/ir/compiler.ts`) and consumed uniformly by all runtimes (voice, digital, workflow). The IR captures identity, execution config, tools, gather fields, attachments, memory, constraints, guardrails, coordination, completion, error handling, flow definitions, hooks, NLU config, routing (for supervisors), behavior profiles, and more. This single representation eliminates runtime-specific compilation and enables portable agent versioning.

### Key Capabilities

- Agent types for reasoning, flow, supervisor, digital, voice, and workflow execution — determined by IR content (flow presence, routing config, runtime hints) rather than an explicit type enum
- AgentIR schema with 20+ top-level sections: identity, execution, tools, gather, attachments, memory, constraints, coordination, completion, error handling, flow, hooks, NLU, routing, behavior profiles, lookup tables, templates, messages, on_start, and project runtime config
- Versioned agent artifacts with source-hash tracking, tool snapshots, and IR content frozen at compile time
- Project-scoped agent CRUD, detail lookup, and version history with lifecycle states (`draft`, `testing`, `staged`, `active`, `deprecated`)
- Per-agent model configuration overrides layered on top of tenant/project defaults, including per-operation model overrides for extraction, validation, tool_selection, response_gen, summarization, reasoning, realtime_voice, and coordination
- Static graph extraction for state machine visualization of flow agents (`extractStaticGraph` in `graph-extractor.ts`)
- App-level multi-agent graph extraction for topology visualization (`extractAppStaticGraph` in `app-graph-extractor.ts`)
- Behavior profile compilation and attachment for context-dependent agent behavior (priority-based, CEL condition evaluation)
- Compilation pipeline with timeout tracking (30s default), cross-agent validation, field reference validation, input mapping validation, guardrail validation, tool signature comparison, and config variable resolution
- Compaction policy configuration at agent level (tool result and prior-turn compaction strategies)
- Concurrency strategy configuration (`serial`, `preemptive`, `parallel`) with queue depth controls

---

## 2. Scope

### Goals

- Define a portable `AgentIR` contract (`ir_version: '1.0'`) that all runtimes can consume uniformly.
- Preserve versioned snapshots, tool bindings, and model overrides needed for deployment and auditability.
- Give Studio and runtime routes a stable way to inspect, list, and update agent metadata without depending on raw source parsing at request time.
- Support multiple agent execution patterns (reasoning, scripted flow, supervisor routing, workflow orchestration) through a single IR schema.
- Enable behavior profile composition for context-dependent agent behavior modification.

### Non-Goals (Out of Scope)

- This feature does not replace ABL authoring; it consumes the result of compilation.
- This feature does not provide a separate admin-only editor for agents.
- This feature does not define the runtime execution engine itself — it defines the artifact that execution engines consume.
- This feature does not manage the ABL parser (`@abl/core`) or its grammar; it depends on the parsed AST output.

---

## 3. User Stories

1. As a runtime engineer, I want a stable `AgentIR` artifact so that digital, voice, and orchestration runtimes can execute agents without understanding raw source files.
2. As a Studio user, I want agent detail, versions, and model bindings surfaced consistently so that I can inspect and manage deployed behavior.
3. As an operator, I want versioned snapshots and tool/model metadata so that promotions, rollbacks, and audits are traceable.
4. As a platform developer, I want cross-agent validation at compile time so that handoff targets, delegate references, and field references are verified before deployment.
5. As a voice engineer, I want runtime hints (voice_optimized, voice_latency_target_ms) baked into the IR so that latency-sensitive paths can be optimized without re-parsing DSL.
6. As a project admin, I want per-agent model overrides so that specific agents can use different LLMs without changing the project-wide default.

---

## 4. Functional Requirements

1. **FR-1**: The system must compile authored agents into a framework-agnostic `AgentIR` (via `compileABLtoIR` in `packages/compiler/src/platform/ir/compiler.ts`) stored in versioned artifacts (`agent_versions.irContent`).
2. **FR-2**: The system must support multiple agent types, including reasoning, flow, supervisor, digital, voice, and workflow execution, all represented through the same `AgentIR` schema with type-specific sections (e.g., `flow` for scripted agents, `routing` for supervisors).
3. **FR-3**: The system must persist project agent records (`project_agents`), immutable version snapshots (`agent_versions`), and agent-level model overrides (`agent_model_configs`) in MongoDB with proper indexing.
4. **FR-4**: The system must expose project-scoped list/detail/model-config/version routes for agent inspection and management, all requiring auth middleware, project scope validation, and tenant rate limiting.
5. **FR-5**: The system must preserve source hashes and frozen tool snapshots (`toolSnapshot` in `agent_versions`) so deployed behavior remains auditable and drift between DSL tool declarations and project tool definitions is detectable.
6. **FR-6**: The system must validate cross-agent references, field references, input mappings, guardrails, and related IR integrity rules (via `validateIR`) before execution and promotion.
7. **FR-7**: The system must extract static graphs from flow agents for state machine visualization (via `extractStaticGraph`) and app-level multi-agent graphs (via `extractAppStaticGraph`).
8. **FR-8**: The system must compile and attach behavior profiles to agents, supporting priority-based conflict resolution, CEL condition evaluation, and deep-merge composition of identity, constraints, tools, gather, and flow overrides.
9. **FR-9**: The system must resolve config variables during compilation and report resolution metadata (resolved, unresolved, unused) in the compilation output.
10. **FR-10**: The system must enforce compilation timeout (configurable, default 30s) and emit structured `CompilationError` diagnostics with agent name, message, type (parse/compilation/validation), and severity.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                           |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Agent records, versions, and model configs are project-scoped data and management surfaces.                     |
| Agent lifecycle            | PRIMARY      | This feature defines the compiled/runtime shape of an agent after authoring.                                    |
| Customer experience        | SECONDARY    | End-user behavior depends on the selected `AgentIR`, but the feature itself is mostly internal/platform-facing. |
| Integrations / channels    | SECONDARY    | Digital, voice, SDK, and A2A runtimes consume the same agent artifact.                                          |
| Observability / tracing    | SECONDARY    | Version creation, compilation output, and execution-model mismatches are operator debugging inputs.             |
| Governance / controls      | SECONDARY    | Version lifecycles, model overrides, and project isolation govern what executes in each environment.            |
| Enterprise / compliance    | SECONDARY    | Immutable versions and frozen tool snapshots support auditability and promotion control.                        |
| Admin / operator workflows | PRIMARY      | Operators inspect versions, model bindings, and deployed state through these records.                           |

### Related Feature Integration Matrix

| Related Feature                                       | Relationship Type | Why It Matters                                                                               | Key Touchpoints                                                                | Current State     |
| ----------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------- |
| [ABL Language](abl-language.md)                       | depends on        | Agent Anatomy is the compiled/runtime contract produced from ABL source.                     | `compileABLtoIR()`, `parseAgentBasedABL()`, `AgentBasedDocument` AST           | Stable dependency |
| [Deployments & Versioning](deployments-versioning.md) | feeds             | Promotion and environment activation operate on versioned agent artifacts.                   | `agent_versions`, active version state, promotion routes, `VersionService`     | Stable dependency |
| [Model Hub](model-hub.md)                             | configured by     | Effective execution settings combine tenant/project defaults with per-agent model overrides. | `agent_model_configs`, execution model layering, `OperationModelMap`           | Stable dependency |
| [Guardrails](guardrails.md)                           | extends           | Guardrails are validated and tier-inferred at compile time, stored in IR constraints.        | `guardrail-validator.ts`, `ConstraintConfig`, guardrail tier inference         | Stable dependency |
| [Agent Transfer](agent-transfer.md)                   | shares data with  | Handoff and delegate targets reference other agents validated at compile time.               | `coordination`, `validateCrossAgentRefs`, system tools (handoff/delegate/etc.) | Stable dependency |

---

## 6. Design Considerations (Optional)

- A single framework-agnostic `AgentIR` keeps the runtime contract portable across voice, digital, workflow, and orchestration execution paths.
- Versioned agent artifacts intentionally freeze `dslContent`, `irContent`, and `toolSnapshot` together so promotions and rollbacks are explainable.
- The `metadata.type` discriminator (`'agent'` vs `'supervisor'`) is the only agent-kind marker in the IR — execution style is inferred from the presence of `flow`, `routing`, runtime hints, and behavior profiles.
- Behavior profiles use a priority-based merge strategy with CEL conditions evaluated at runtime, allowing the same base agent to behave differently across channels, time windows, or context conditions.
- Compaction policy at the agent level overrides project-level and platform defaults, supporting per-agent tuning of context window management.

---

## 7. Technical Considerations (Optional)

- The compiler transforms ABL into `AgentIR`, validates the result, extracts static graphs, computes hashes, and packages version-ready output. The pipeline stages are: parse -> separate profiles -> compile profiles -> compile agents -> attach profiles -> validate -> extract graph -> hash -> package.
- Runtime execution layers resolve an agent artifact, apply tenant/project/agent model overrides, and then construct the execution context.
- `agent_versions` does not have its own `tenantId`; tenant isolation depends on the parent `project_agents` resolution path (join through `agentId` -> `project_agents._id` -> `project_agents.tenantId`).
- `agent_model_configs` has no `tenantId` — it is project-scoped only (`{ projectId, agentName }` unique index), relying on project-level authz for tenant isolation.
- Admin influence is indirect through tenant/project model layering rather than a dedicated admin-specific anatomy surface.
- System tools (`__handoff__`, `__delegate__`, `__complete__`, `__escalate__`, `__fan_out__`, `__set_context__`) are injected by the compiler and cannot be shadowed by project tool declarations.
- Tool signature comparison (`compareToolSignatures` in `compiler.ts`) detects drift between DSL tool declarations and resolved project tool definitions, emitting W721 warnings.
- The compiler enforces a configurable timeout (default 30s via `compilationTimeoutMs` option) and emits E727 errors when compilation exceeds the budget.

---

## 8. How to Consume

### Studio UI

Studio exposes agent anatomy through the agent list, detail page, version history, model tab, coordination/gather sections, and mini-topology views.

### API (Runtime)

| Method | Path                                                                              | Purpose                              |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------ |
| GET    | `/api/projects/:projectId/agents`                                                 | List project agents                  |
| GET    | `/api/projects/:projectId/agents/:agentName`                                      | Get full project-scoped agent detail |
| PUT    | `/api/projects/:projectId/agents/:agentName/dsl`                                  | Save working copy (no compilation)   |
| GET    | `/api/agents`                                                                     | Tenant-scoped agent listing          |
| GET    | `/api/agents/:name`                                                               | Tenant/global agent detail view      |
| GET    | `/api/projects/:projectId/agents/:agentName/model-config`                         | Load effective agent model override  |
| PUT    | `/api/projects/:projectId/agents/:agentName/model-config`                         | Update agent-specific model override |
| POST   | `/api/projects/:projectId/agents/:agentName/versions`                             | Create version from working copy     |
| GET    | `/api/projects/:projectId/agents/:agentName/versions`                             | List versions                        |
| GET    | `/api/projects/:projectId/agents/:agentName/versions/:version`                    | Get version detail                   |
| POST   | `/api/projects/:projectId/agents/:agentName/versions/:version/promote`            | Promote version status               |
| GET    | `/api/projects/:projectId/agents/:agentName/versions/:version/diff/:otherVersion` | Diff two versions                    |

### API (Studio)

| Method | Path                                               | Purpose                                     |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| GET    | `/api/projects/[id]/agents/*`                      | Studio project agent listing/detail proxies |
| GET    | `/api/projects/[id]/agents/[agentId]/model-config` | Agent model configuration proxy             |

### Admin Portal

No dedicated admin authoring surface exists, but admin model and tenant inspection flows depend on the agent metadata and model bindings produced here.

### Channel Integration

Agent anatomy is consumed uniformly by digital, voice, SDK, and A2A runtimes once the selected deployment/version resolves to an AgentIR artifact. The IR includes runtime hints (`voice_optimized`, `voice_latency_target_ms`) and deployment hints (`runtime_recommendations`) that channels use for optimization.

---

## 9. Data Model

### Collections / Tables

```
Collection: project_agents
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required)
  - projectId: string (required)
  - name: string (required, agent identifier within project)
  - agentPath: string (required, file-system-style path)
  - description: string | null
  - dslContent: string | null (raw ABL source)
  - activeVersions: Mixed | null (version references per environment)
  - ownerId: string | null (user who owns this agent)
  - ownerTeamId: string | null (team ownership)
  - sourceHash: string | null (SHA hash of dslContent for change detection)
  - lastEditedBy: string | null
  - lastEditedAt: Date | null
  - _v: number (optimistic concurrency)
  - createdAt, updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique — one agent per name per project)
  - { tenantId: 1, projectId: 1 } (compound for project listing)
  - { projectId: 1, agentPath: 1 } (unique — one agent per path)
```

```
Collection: agent_versions
Fields:
  - _id: string (UUID v7)
  - agentId: string (required, references project_agents._id)
  - version: string (required, semver)
  - status: string (required: 'draft' | 'testing' | 'staged' | 'active' | 'deprecated')
  - dslContent: string (required, ABL source snapshot)
  - irContent: string (required, serialized compiled AgentIR JSON)
  - sourceHash: string (required, for change detection)
  - changelog: string | null
  - createdBy: string (required, user ID)
  - promotedAt: Date | null
  - promotedBy: string | null
  - toolSnapshot: Array<{ name, projectToolId, sourceHash, toolType, description, dslContent }> | null
  - testResults: Mixed | null
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { agentId: 1, version: 1 } (unique — one version string per agent)
  - { agentId: 1, createdAt: -1 } (version listing with sort)
  - { agentId: 1 } (all versions for an agent)
  - { status: 1 } (query by lifecycle stage)
```

```
Collection: agent_model_configs
Fields:
  - _id: string (UUID v7)
  - projectId: string (required)
  - agentName: string (required)
  - defaultModel: string | null (override primary LLM model)
  - operationModels: Mixed | null (per-operation overrides: extraction, validation, tool_selection, etc.)
  - temperature: number | null
  - maxTokens: number | null
  - hyperParameters: Record<string, unknown> | null (topP, frequencyPenalty, etc.)
  - useResponsesApi: boolean | null (OpenAI Responses API vs Chat Completions)
  - useStreaming: boolean | null (null=inherit, true=force streaming, false=force non-streaming)
  - _v: number
  - createdAt, updatedAt: Date
Indexes:
  - { projectId: 1, agentName: 1 } (unique — one config per agent per project)
  - { projectId: 1 } (list all configs in a project)
```

### AgentIR Top-Level Structure

The compiled `AgentIR` is the canonical runtime representation stored in `agent_versions.irContent`:

```
AgentIR {
  ir_version: '1.0'
  metadata: { name, version, type ('agent'|'supervisor'), compiled_at, source_hash, compiler_version, config_hash? }
  execution: { mode?, hints, timeouts, model?, temperature?, max_tokens?, max_iterations?,
               fallback_model?, reasoning_effort?, enable_thinking?, thinking_budget?,
               compaction_threshold?, compaction?, pipeline_order?, operation_models?,
               concurrency?, max_queue_depth?, max_concurrent_messages?, inline_gather?,
               pipeline? }
  identity: { goal, persona, limitations[], system_prompt, voice_response_rules?, language? }
  tools: ToolDefinition[] (tool_type: http|mcp|sandbox|lambda|connector|workflow|searchai|async_webhook)
  gather: { fields[], strategy ('llm'|'pattern'|'hybrid'), correction_patterns? }
  attachments?: AttachmentFieldIR[] (image, document, audio, video)
  memory: { session[], persistent[], remember[], recall[] }
  constraints: { constraints[], guardrails[] }
  coordination: { delegates[], handoffs[], escalation? }
  completion: { conditions[] }
  error_handling: { handlers[], default_handler }
  flow?: { steps[], definitions, entry_point?, global_digressions?, staticGraph? }
  on_start?: { respond?, voice_config?, call?, set?, delegate? }
  messages?: { error_default, constraint_blocked, gather_prompt, ... }
  hooks?: { before_agent?, after_agent?, before_turn?, after_turn? }
  nlu?: { models?, languages?, intents[], categories[], entities[], glossary[], evaluation?, embeddings? }
  intent_handling?: { multi_intent? }
  templates?: Record<string, string>
  routing?: { rules[], default_agent, intent_classification, direct_response_allowed? }
  available_agents?: string[]
  project_runtime_config?: ProjectRuntimeConfigIR
  lookup_tables?: Record<string, LookupTableIR>
  behavior_profiles?: BehaviorProfileIR[]
}
```

### Flow Step Node Types

Flow steps (`FlowStep`) are the building blocks of scripted agents. Each step can contain:

| Capability            | Fields                                                                    | Purpose                                  |
| --------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| Reasoning zone        | `reasoning_zone: { goal, available_tools?, exit_when?, max_turns }`       | LLM reasoning within a scripted flow     |
| In-step gather        | `gather: { fields[], strategy?, prompt? }`                                | Multi-field collection within a step     |
| Variable assignment   | `set: SetAssignmentIR[]`, `clear: string[]`                               | Computed values and variable cleanup     |
| Data transformation   | `transform: { source, item_var, target, filter?, map?, sort_by?, limit?}` | Array pipelines (filter/map/sort/limit)  |
| Tool invocation       | `call, call_with?, call_as?, success_when?`                               | Tool calls with parameter passing        |
| Response              | `respond, voice_config?, rich_content?, actions?, on_action?`             | Multi-format output with interactive UIs |
| Conditional branching | `on_input?, on_result?, on_success?, on_failure?`                         | Multi-way branching on user/tool results |
| Intent handling       | `digressions?, sub_intents?`                                              | Intent-based escapes and scoped intents  |
| Error handling        | `on_error?: ErrorHandler[]`                                               | Step-level error handler overrides       |
| Human approval        | `human_approval: { prompt, assignee?, timeoutSeconds, onApprove, ... }`   | Human-in-the-loop approval gates         |
| Presentation          | `present?`                                                                | Template shown before collection         |
| Transition            | `then?`                                                                   | Next step transition                     |

### Static Graph Types (Visualization)

The compiler extracts a `StaticGraph` from flow agents for state machine visualization:

- **Node types** (`StaticNodeType`): `entry`, `step`, `decision` (ON_INPUT branch), `llm_decision` (intent classification), `exit`
- **Edge types** (`StaticEdgeType`): `sequential` (THEN), `conditional` (ON_INPUT branch), `success`, `failure`, `error`, `digression`
- **App-level graph** (`AppStaticGraph`): Combines multiple agent graphs with inter-agent edges for multi-agent topology visualization

### Key Relationships

- `project_agents` defines the working copy; scoped by `tenantId` + `projectId`
- `agent_versions` snapshots that working copy for deployment/promotion; linked via `agentId`
- `agent_model_configs` overlays model selection without changing the source definition; keyed by `projectId` + `agentName`
- `agent_versions.toolSnapshot` captures the exact project tools resolved at compile time for audit trail
- `agent_versions.irContent` contains the serialized `AgentIR` consumed by all runtime executors

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                   | AgentIR schema definition (~2090 lines, all IR types)           |
| `packages/compiler/src/platform/ir/compiler.ts`                 | ABL-to-IR compiler (`compileABLtoIR`, `compileAgentToIR`)       |
| `packages/compiler/src/platform/ir/validate-ir.ts`              | IR validation orchestrator (flow graph, tool refs, field refs)  |
| `packages/compiler/src/platform/ir/validate-cross-agent.ts`     | Cross-agent validation (handoff targets, delegate refs)         |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`      | Field reference and producer/consumer validation in expressions |
| `packages/compiler/src/platform/ir/validate-input-mappings.ts`  | Input mapping validation for handoffs/delegates                 |
| `packages/compiler/src/platform/ir/validate-preflight.ts`       | Pre-compilation validation                                      |
| `packages/compiler/src/platform/ir/graph-extractor.ts`          | Static graph extraction for flow visualization                  |
| `packages/compiler/src/platform/ir/app-graph-extractor.ts`      | App-level multi-agent graph extraction                          |
| `packages/compiler/src/platform/ir/compile-behavior-profile.ts` | Behavior profile compilation                                    |
| `packages/compiler/src/platform/ir/guardrail-validator.ts`      | Guardrail validation and tier inference                         |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`    | Tool definition validation (signature comparison)               |
| `packages/compiler/src/platform/ir/auth-config-builder.ts`      | Auth configuration building from AST                            |
| `packages/compiler/src/platform/ir/recall-validation.ts`        | Recall event validation                                         |
| `packages/database/src/models/project-agent.model.ts`           | Working-copy agent storage (IProjectAgent, ProjectAgent)        |
| `packages/database/src/models/agent-version.model.ts`           | Versioned compiled artifacts (IAgentVersion, AgentVersion)      |
| `packages/database/src/models/agent-model-config.model.ts`      | Per-agent model overrides (IAgentModelConfig, AgentModelConfig) |
| `apps/runtime/src/services/version-service.ts`                  | Version lifecycle service (create, promote, list, diff)         |
| `apps/runtime/src/services/workflow-version-service.ts`         | Workflow-agent-specific version operations                      |
| `apps/runtime/src/services/settings-version-service.ts`         | Project settings version management                             |
| `apps/runtime/src/repos/project-repo.ts`                        | Repository layer for project agents, versions, model configs    |

### Routes / Handlers

| File                                            | Purpose                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| `apps/runtime/src/routes/project-agents.ts`     | Project-scoped agent CRUD/detail routes            |
| `apps/runtime/src/routes/agents.ts`             | Agent discovery (tenant-scoped list/detail)        |
| `apps/runtime/src/routes/agent-model-config.ts` | Agent model config GET/PUT                         |
| `apps/runtime/src/routes/versions.ts`           | Agent version lifecycle (create/list/promote/diff) |
| `apps/runtime/src/routes/workflow-versions.ts`  | Workflow-agent version routes                      |

### UI Components (Studio)

| File                                                      | Purpose                       |
| --------------------------------------------------------- | ----------------------------- |
| `apps/studio/src/components/agents/AgentDetailPage.tsx`   | Full agent detail surface     |
| `apps/studio/src/components/agents/AgentListPage.tsx`     | Project agent listing         |
| `apps/studio/src/components/agents/AgentModelTab.tsx`     | Agent model binding UI        |
| `apps/studio/src/components/agents/VersionListTab.tsx`    | Version history surface       |
| `apps/studio/src/components/agents/AgentMiniTopology.tsx` | Topology/coordination preview |

### Tests

| File                                                             | Type        | Coverage Focus                    |
| ---------------------------------------------------------------- | ----------- | --------------------------------- |
| `apps/runtime/src/__tests__/project-agents-authz.test.ts`        | integration | Project agent route authorization |
| `apps/runtime/src/__tests__/agent-model-config-authz.test.ts`    | integration | Agent model config authz          |
| `apps/runtime/src/__tests__/execution-model-integration.test.ts` | integration | Execution model compatibility     |
| `apps/runtime/src/__tests__/versions-authz.test.ts`              | integration | Version route authz/promotion     |
| `apps/runtime/src/__tests__/version-routes.test.ts`              | integration | Version route CRUD                |
| `apps/studio/src/__tests__/agent-detail-page.test.tsx`           | unit/UI     | Detail page rendering             |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                                                                                                      |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| ---      | ---     | Agent anatomy is driven by source, version records, and model-config data rather than dedicated process env vars |

### Runtime Configuration

- Tenant, project, and agent model config layers combine to determine effective execution settings
- Version creation stores compiled IR and source hashes for rollback/diff workflows
- Model config layering: tenant defaults < project LLM config < agent model config (most specific wins)
- Per-operation model overrides allow different LLMs for extraction, validation, tool_selection, response_gen, summarization, reasoning, realtime_voice, and coordination
- Compaction policy layering: platform defaults < project compaction config < agent-level `execution.compaction`

### DSL / Agent IR

Agent anatomy is expressed in `AgentIR`. The compilation pipeline transforms ABL source through these stages:

1. **Parse**: ABL text -> `AgentBasedDocument` AST (via `@abl/core`)
2. **Separate**: Split behavior profiles from agent/supervisor documents
3. **Compile profiles**: Behavior profiles compiled first (referenced by agents)
4. **Compile agents**: Each `AgentBasedDocument` -> `AgentIR` via `compileAgentToIR()`
5. **Attach profiles**: Behavior profiles attached to referencing agents
6. **Merge resolved tools**: Project tool implementations merged into agent tools (DSL behavioral properties preserved)
7. **Tool staleness detection**: DSL signatures compared against resolved project tools (W721 warnings)
8. **Validate**: `validateIR()` runs post-compilation checks (flow graph, tool refs, tool descriptions, field refs, cross-agent refs, reserved variables, guardrails, preflight)
9. **Extract graph**: `extractStaticGraph()` generates state machine visualization for flow agents
10. **Hash**: Source hash computed for change detection, config hash for cache invalidation
11. **Package**: All agents assembled into `CompilationOutput` with deployment hints, remote agent registry, coordination defaults, and config variable resolution metadata

The compiler enforces a configurable timeout (default 30s) and emits structured `CompilationError` diagnostics with agent name, message, type (parse/compilation/validation), and severity.

---

## 12. Runtime Integration

Runtime resolves an agent by project/name/version, loads the stored working copy or compiled artifact, applies model/runtime config overlays, and then constructs the execution context used by chat, voice, or orchestration flows.

### Lifecycle

1. Project agent record stores current ABL source and source hash.
2. Version creation compiles ABL to IR, captures tool snapshot, and persists the immutable version record.
3. Runtime resolves the appropriate artifact (working copy or versioned) for execution.
4. Model/config overlays are applied: tenant defaults -> project config -> agent model config.
5. Execution context constructed with resolved tools, gather config, constraints, and flow definitions.

### Dependencies

- **ABL Compiler** (`packages/compiler`): Produces AgentIR from ABL source
- **Version Service** (`apps/runtime/src/services/version-service.ts`): Manages version lifecycle (draft -> testing -> staged -> active -> deprecated)
- **Model Hub**: Provides tenant/project-level model defaults that agent configs overlay
- **Deployment Routes**: Consume versioned artifacts for environment promotion
- **Project Tools**: Resolved at compile time and baked into IR tool definitions

### Event Flow

Agent lookup, version promotion, and model-config changes are audited through runtime route logs and related project settings/version services. Audit helpers (`auditDslUpdated`, `auditVersionCreated`, `auditVersionPromoted`, `auditVersionDeprecated`) emit structured audit events.

---

## 13. Admin Integration

Admin model management affects agent execution indirectly through tenant/project/agent model layering; there is no separate admin-only agent editor.

---

## 14. Delivery Plan / Work Breakdown

1. Strengthen operator confidence in versioned artifacts
   1.1 Expand browser coverage for version history, diffs, and topology-heavy interactions
   1.2 Improve visibility into execution-model mismatches and promotion behavior
2. Harden artifact isolation and lifecycle management
   2.1 Add `tenantId` to `agent_versions` to simplify isolation reasoning and query safety
   2.2 Clarify migration/recompilation strategy when `ir_version` changes
   2.3 Add retention/archival policy for deprecated versions
3. Improve workflow/topology depth
   3.1 Expand workflow-agent-specific testing and documentation
   3.2 Continue improving canonical visual/topology views in Studio
4. Compilation pipeline enhancements
   4.1 Add per-agent compilation timeout granularity
   4.2 Add IR schema migration tooling for `ir_version` upgrades

---

## 15. Success Metrics

| Metric                | Baseline                                                              | Target                                                                       | How Measured                                           |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Artifact reliability  | Route/model/version coverage is strong below the browser layer        | Keep model-config, version, and agent route regressions caught automatically | Runtime and Studio test inventory                      |
| Version UX confidence | Browser automation is thinner for topology/version-heavy interactions | Add stronger automated coverage for version history and topology journeys    | Browser/UI test inventory                              |
| Runtime portability   | Multiple runtimes already consume stored `AgentIR`                    | Maintain one stable compiled contract across execution paths                 | Execution-model integration tests and deployment flows |
| Compilation safety    | Timeout enforcement exists at 30s global level                        | Per-agent timeout granularity and IR migration tooling                       | Compilation diagnostic metrics                         |

---

## 16. Open Questions

1. Should `agent_versions` eventually carry an explicit `tenantId` to simplify isolation reasoning and query safety?
2. What is the preferred migration path when `ir_version` changes and old stored blobs need recompilation?
3. How much of the current topology/version inspection UX should move toward richer browser-level coverage and visualization?
4. Should `agent_model_configs` add a `tenantId` field for direct tenant-scoped queries, or is project-level authz sufficient?
5. What retention/archival policy should apply to deprecated `agent_versions` records?

---

## 17. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                   | Severity | Status      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | ----------- |
| GAP-001 | Some topology/structure affordances are still split across raw DSL and detail tabs instead of one canonical visual model view | Medium   | In Progress |
| GAP-002 | Workflow-agent documentation/testing is thinner than reasoning/flow agent coverage                                            | Medium   | Open        |
| GAP-003 | Browser automation for complex version/detail flows is lighter than route-level coverage                                      | Low      | Open        |
| GAP-004 | `agent_versions` has no `tenantId` field — tenant isolation relies on the parent `project_agents` lookup chain                | Medium   | Open        |
| GAP-005 | No built-in IR schema migration when `ir_version` changes — old IR blobs may need recompilation                               | Medium   | Open        |
| GAP-006 | `compileABLtoIR` timeout (30s default) has no per-agent granularity — one slow agent can exhaust the budget for all agents    | Low      | Open        |
| GAP-007 | `agent_model_configs` has no `tenantId` — project-scoped only, requiring project-level authz to ensure tenant isolation       | Low      | By Design   |
| GAP-008 | `agents.ts` route uses `console.error` instead of structured logger (`createLogger`) — violates code standards                | Low      | Open        |

---

## 18. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | `project_agents` and `agent_model_configs` are project-scoped and must always be resolved with the owning `projectId`, with cross-project access hidden as `404`. |
| Tenant isolation  | Tenant boundaries are enforced through the parent project lookup chain and related route authorization, especially for versioned artifacts.                       |
| User isolation    | User-specific ownership metadata must not leak access beyond authorized project scope, even though the main data model is project-owned rather than user-owned.   |

### Security & Compliance

- Project scope and tenant isolation are enforced on agent and version routes via `authMiddleware`, `requireProjectScope`, and `requireProjectPermission`.
- Cross-project access returns 404-style behavior through the shared route pattern.
- Agent model configs are project-scoped with unique compound index on `{ projectId, agentName }`.
- Tool bindings may contain encrypted credentials (MCP `encrypted_env`, `encrypted_auth_config`) that are decrypted only at execution time.
- Version records include `createdBy` and `promotedBy` for audit trail.

### Performance & Scalability

- Agent detail and version lookup are read-heavy and index-backed; execution-critical work happens after artifact resolution.
- Compilation timeout enforced at 30s default to prevent runaway compilation.
- Source hash comparison enables skip-compilation when DSL content has not changed.
- Tool signature comparison (`compareToolSignatures`) detects drift between DSL tool declarations and project tool definitions.
- Agent metadata is lightweight compared with session/message data; version artifacts scale horizontally with MongoDB storage and stateless runtime readers.
- Compiled IR is stored as a JSON string in `irContent` — no secondary indexes on IR content, keeping write performance stable.

### Reliability & Failure Modes

- Compilation failures emit structured `CompilationError[]` — agents that fail compilation are omitted from `CompilationOutput.agents` but errors are preserved for diagnostic reporting.
- Version creation is atomic — if compilation fails, no version record is created.
- Model config upsert uses MongoDB `findOneAndUpdate` with `upsert: true` for idempotency.

### Observability

- Version creation and execution-model mismatches surface through runtime logs, deployment traces, and Studio/UI validation.
- Compilation emits structured `CompilationError[]` and `CompilationWarning[]` arrays for diagnostic reporting.
- Config variable resolution metadata (`resolved`, `unresolved`, `unused`) is included in compilation output for debugging.
- Audit helpers emit structured events for DSL updates, version creation, version promotion, and version deprecation.

### Data Lifecycle

- Working-copy source lives in `project_agents`, while immutable promoted snapshots live in `agent_versions`.
- Source hashes, tool snapshots, and status transitions support rollback, diffing, audit, and deployment workflows.
- Model overrides are stored separately so execution settings can change without rewriting the source definition.
- No retention/TTL policy exists for deprecated versions (GAP-005).

---

## 19. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] Project-agent CRUD/authz and model-config GET/PUT flows are covered.
- [x] Version routes cover history and promotion semantics.
- [x] Execution-model integration covers runtime compatibility across agent types.

#### E2E

- [x] Project-agent listing/detail and authz are exercised through runtime routes.
- [x] Agent-level model overrides are exercised end-to-end.
- [x] Execution-model resolution is exercised against runtime integration tests.

### E2E Test Scenarios

| #   | Scenario                                     | Status | Test File                                                        |
| --- | -------------------------------------------- | ------ | ---------------------------------------------------------------- |
| 1   | Project agent listing/detail with authz      | PASS   | `apps/runtime/src/__tests__/project-agents-authz.test.ts`        |
| 2   | Agent model override GET/PUT flow            | PASS   | `apps/runtime/src/__tests__/agent-model-config-authz.test.ts`    |
| 3   | Compiled execution model resolves at runtime | PASS   | `apps/runtime/src/__tests__/execution-model-integration.test.ts` |
| 4   | Browser-driven agent detail rendering        | PASS   | `apps/studio/src/__tests__/agent-detail-page.test.tsx`           |

### Integration Test Scenarios

| #   | Scenario                                    | Status | Test File                                           |
| --- | ------------------------------------------- | ------ | --------------------------------------------------- |
| 1   | Version route authz and promotion semantics | PASS   | `apps/runtime/src/__tests__/versions-authz.test.ts` |
| 2   | Version route CRUD operations               | PASS   | `apps/runtime/src/__tests__/version-routes.test.ts` |

### Unit Test Coverage

| Package             | Tests                             | Passing |
| ------------------- | --------------------------------- | ------- |
| `packages/compiler` | IR schema + execution model tests | Yes     |
| `apps/runtime`      | agent routes/model config         | Yes     |
| `apps/studio`       | list/detail/model tab UI          | Yes     |

> Full testing details: [docs/testing/agent-anatomy.md](../testing/agent-anatomy.md)

---

## 20. References

- Feature matrix: `docs/feature-matrix.md` section 2
- Related features: [ABL Language](./abl-language.md), [Deployments & Versioning](./deployments-versioning.md), [Model Hub](./model-hub.md)
- IR schema source: `packages/compiler/src/platform/ir/schema.ts`
- Compiler source: `packages/compiler/src/platform/ir/compiler.ts`
- Version service: `apps/runtime/src/services/version-service.ts`
- Project agent model: `packages/database/src/models/project-agent.model.ts`
