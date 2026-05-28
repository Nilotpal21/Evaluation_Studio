# Arch AI Feature, Specialist, and Tool Gap Audit

> Date: 2026-05-05  
> Scope: `packages/arch-ai`, `apps/studio/src/lib/arch-ai`, Studio project navigation, and existing Arch AI audit/spec docs.  
> Goal: map what Arch AI can actually do today, what is only partially wired, and what feature/tool families are missing before implementation starts.

> Follow-up status: the first implementation slice from this audit has been applied in the working tree: `search_docs` is registered, `manage_memory` accepts the prompted `delete` action, `get_topology_patterns` is wired, and a production registry invariant test was added. The findings below are retained as the source-backed audit trail.

## Executive Summary

Arch AI is stronger than the April audit docs suggest. Several previously critical in-project gaps are now fixed: `project_config`, `kb_*`, `mcp_server_ops`, `collect_secret`, `configure_model`, and project-aware `platform_context` are registered in the production registry. The agent edit path also now refreshes Studio draft state after applying a proposal.

The highest-risk remaining problems are wiring and contract drift:

1. `search_docs` is declared, specialist-mapped, prompted, and directly implemented, but it is not registered in the production `ToolRegistry`. In-project prompts tell the model to use a tool that production filtering removes.
2. `manage_memory` has a schema/prompt mismatch: the prompt and direct in-project tool use `delete`, while the production registry only accepts `remove`.
3. `get_topology_patterns` exists as a tool implementation and was promised by the specialist enhancement design, but it is not declared, mapped, or registered.
4. Legacy/shadow operation modules exist for `agent_ops`, `deployment_ops`, `knowledge_ops`, `analytics_ops`, and `topology_ops`, but they are not part of the live `ToolName`/registry contract. Do not count them as live coverage.
5. Arch LLM resolution is still a Studio-specific resolver instead of the runtime `ModelResolutionService`. It has improved parity for auth profiles, `authConfig`, and `useResponsesApi`, but it remains duplicate critical model-selection logic.

## Sources Audited

Primary code paths:

- `packages/arch-ai/src/types/tools.ts`
- `packages/arch-ai/src/types/constants.ts`
- `packages/arch-ai/src/types/in-project-specialists.ts`
- `packages/arch-ai/src/prompts/index.ts`
- `packages/arch-ai/src/prompts/phases/in-project.ts`
- `packages/arch-ai/src/prompts/specialists/*`
- `apps/studio/src/lib/arch-ai/engine-factory.ts`
- `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`
- `apps/studio/src/lib/arch-ai/compat/v1-core-refs.ts`
- `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`
- `apps/studio/src/lib/arch-ai/processors/process-message.ts`
- `apps/studio/src/lib/arch-ai/ui/proposal-artifacts.ts`
- `apps/studio/src/store/navigation-store.ts`
- `apps/studio/src/components/navigation/ProjectSidebar.tsx`

Existing docs used as comparison points:

- `docs/audit/arch-ai-project-capability-matrix-2026-04-27.md`
- `docs/audit/arch-ai-project-capabilities-audit-2026-04-27.md`
- `docs/audit/arch-ai-inproject-api-scope-validation-2026-04-27.md`
- `docs/audit/arch-ai-agent-edit-topology-runtime-audit-2026-04-28.md`
- `docs/superpowers/2026-03-12-abl-platform-feature-map.md`
- `docs/superpowers/specs/2026-04-03-arch-specialist-enhancement-design.md`
- Existing untracked local analysis docs under `docs/analysis/` were read as user-provided context but not modified.

## Live Tool Contract Map

Current source counts:

| Layer                            | Count | Notes                                                           |
| -------------------------------- | ----: | --------------------------------------------------------------- |
| Declared `ToolName` union        |    43 | Canonical source-level contract.                                |
| Production registry entries      |    40 | Built in `buildOnboardingToolRegistry()`.                       |
| In-project specialist map union  |    36 | Derived from `IN_PROJECT_SPECIALIST_TOOL_MAP`.                  |
| Direct legacy in-project toolset |    35 | `buildInProjectTools()` path, not the production registry path. |

Declared but not production-registered:

| Tool             | Status                                                                      | Impact                                                                                                    | Recommendation                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_docs`    | Declared, specialist-mapped, prompted, directly implemented, not registered | Model is instructed to use it but cannot see it in production in-project turns                            | Register in `engine-factory.ts`, delegate to the existing implementation or shared package search helper, and add a registry invariant test |
| `create_project` | Declared and in `PHASE_TOOL_MAP.CREATE`, not registered                     | Mostly hidden by deterministic `msg.type === "create"` flow, but CREATE prompt/tool contract is ambiguous | Either register a server-side wrapper or remove it from model-visible phase contracts and document the deterministic create path            |
| `save_tool_dsl`  | Declared and implemented in legacy build tools, not registered              | BUILD:TOOLS legacy compat capability is not available through the current production registry             | Decide whether tool DSL save is still a product capability; register or retire the declaration                                              |

Production-registered in-project tools that were previously suspected missing:

| Tool family                                                                        | Current status                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `project_config`                                                                   | Registered and delegates through compat refs                                                              |
| `kb_manage`, `kb_search`, `kb_health`, `kb_ingest`, `kb_connector`, `kb_documents` | Registered                                                                                                |
| `mcp_server_ops`                                                                   | Registered with create/update/test/discover/import/list tool actions                                      |
| `collect_secret`                                                                   | Registered with the secure `{ flowId, field, label }` contract                                            |
| `configure_model`                                                                  | Registered with inspect/diff/apply fields including source, model IDs, operation models, and confirmation |
| `platform_context`                                                                 | Registered with onboarding and in-project mode-aware behavior                                             |

## Tool Propagation Gaps

### GAP-01: `search_docs` Is Dropped at Registry

Propagation matrix:

| Layer                                         | Status                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `ToolName` definition                         | Yes                                                                   |
| `IN_PROJECT_SPECIALIST_TOOL_MAP`              | Yes, included for every in-project specialist                         |
| `IN_PROJECT_TOOLS` prompt list                | Yes, derived from the specialist map                                  |
| In-project phase prompt                       | Yes, explicitly says to use `search_docs`                             |
| Direct `buildInProjectTools()` implementation | Yes                                                                   |
| Production `buildOnboardingToolRegistry()`    | GAP                                                                   |
| In-project runtime filtering                  | Drops it because `process-in-project` subsets the production registry |

Impact: documentation search is advertised as authoritative platform fallback, but live in-project turns cannot call it. This is the cleanest first fix.

### GAP-02: `manage_memory` Uses Two Action Names

Propagation matrix:

| Layer                                 | Expected action           | Status       |
| ------------------------------------- | ------------------------- | ------------ |
| In-project prompt                     | `delete`                  | Yes          |
| Direct `buildInProjectTools()` schema | `delete`                  | Yes          |
| Direct executor behavior              | `delete`                  | Yes          |
| Production registry schema            | `remove`                  | GAP          |
| Compat ref                            | Maps `remove` to `delete` | Partial shim |

Impact: the model is prompted to call `manage_memory(action: "delete")`, but production schema validation accepts only `remove`. Forget-memory requests can fail before reaching the compatibility shim.

Recommendation: make the production registry accept `delete` as the canonical action. Optionally keep `remove` as a short compatibility alias in the executor, but update prompt, schema, and tests around `delete`.

### GAP-03: `get_topology_patterns` Exists but Is Unwired

The specialist enhancement design promised one specialist-visible project-mode tool: `get_topology_patterns`. The implementation exists in `apps/studio/src/lib/arch-ai/tools/get-topology-patterns.ts`, but it is absent from:

- `ToolName`
- `IN_PROJECT_SPECIALIST_TOOL_MAP`
- `IN_PROJECT_TOOLS`
- production registry
- in-project prompt capability list

Impact: topology restructuring help cannot query the pattern catalog as designed. The code exists, but no specialist can call it.

Recommendation: declare, register, map to `multi-agent-architect` and likely `abl-construct-expert`, and add a production registry test.

### GAP-04: Shadow Operation Modules Are Not Live Tools

These modules exist and some have tests or UI labels, but they are not declared in `ToolName` and not registered in the production registry:

| Shadow module       | Actions found                                               | Live replacement or gap                                                                                                                                               |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-ops.ts`      | read/list/create/modify/compile/delete/propose_modification | Partly replaced by `read_agent`, `propose_modification`, `apply_modification`, `compile_abl`, and `platform_context list_agents`; delete/import/duplicate remain gaps |
| `deployment-ops.ts` | list/deploy/promote/configure_channel/list_channels         | No current live deployment/channel tool                                                                                                                               |
| `knowledge-ops.ts`  | Legacy KB actions                                           | Mostly replaced by `kb_*`, but advanced KB settings/source controls remain incomplete                                                                                 |
| `analytics-ops.ts`  | Analytics reads                                             | Partly replaced by `read_insights`; broader analytics surfaces are not operationally exposed                                                                          |
| `topology-ops.ts`   | read/validate/modify shape                                  | `read_topology` exists; topology modification is still effectively not live                                                                                           |

Impact: old docs and activity-step labels can make these look live. For implementation planning, count them as shadow code until registered and prompt-mapped.

## Specialist Map

Live specialist IDs total 10:

| Specialist                  | Primary live capability                             | Current gap                                                                                            |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `onboarding`                | Home/interview project discovery                    | No direct issue in this audit                                                                          |
| `multi-agent-architect`     | Topology and cross-agent reads/edits                | Missing `get_topology_patterns`; no live topology modification tool                                    |
| `abl-construct-expert`      | Agent code reads, edits, compile, tools, KB         | `search_docs` missing from registry; tool docs lookup unavailable                                      |
| `channel-voice`             | Channel/voice prompt specialization and agent edits | No live `channel_ops`; deployment/channel module is shadow-only                                        |
| `entity-collection`         | Gather/entity-oriented agent edits                  | No specific entity tooling beyond agent edits and docs/cards                                           |
| `integration-methodologist` | Tools, MCP, auth, variables, integration drafts     | No direct connection/external-agent operations; auth type/action coverage is narrower than Studio APIs |
| `testing-eval`              | `run_test`, traces, sessions, compile               | Eval set/run APIs exist, but model-visible eval operations are not registered                          |
| `diagnostician`             | Validate, diagnose, traces, sessions, health        | `search_docs` missing from registry; no direct remediation beyond proposal edits                       |
| `analyst`                   | Read insights, traces, sessions                     | Broad analytics dashboards are not exposed as tools                                                    |
| `observer`                  | Insights/traces/read-only project observation       | Same analytics coverage gap                                                                            |

Important nuance: in-project prompt composition always uses the generalist prompt and ignores the specialist-specific prompt text. Specialists still matter because `resolveTurnPlan()` routes to specialist-scoped tool subsets. This is okay if intentional, but docs should describe specialists as tool-routing profiles rather than separate in-project personalities.

## Feature Coverage Map

Legend:

- **FULL**: Arch can inspect and mutate the main user workflow through live tools.
- **PARTIAL**: Arch can inspect or mutate a subset, but important UI/API actions are missing.
- **AWARENESS**: Arch has docs, prompt knowledge, or general context only.
- **NONE**: No meaningful live Arch capability found.
- **SHADOW**: Code exists but is not model-visible through the live registry.

### Build and Resource Surfaces

| Studio surface  | Coverage | Evidence / gap                                                                                                                                                          |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents          | PARTIAL  | Read/edit/create via proposal flow, apply, compile, health. Missing live delete/duplicate/import/list-as-first-class lifecycle operations.                              |
| Topology        | PARTIAL  | `read_topology` exists; proposed `get_topology_patterns` is unwired; topology modification remains shadow/incomplete.                                                   |
| Tools           | FULL-ish | `tools_ops` supports list/read/create/update/test/delete and SearchAI tool generation. Missing historical invocation browsing.                                          |
| MCP Servers     | FULL-ish | `mcp_server_ops` supports CRUD, test, discover preview, import tools, list/test server tools.                                                                           |
| Knowledge Bases | PARTIAL  | Core `kb_*` tools cover manage/search/health/ingest/connectors/documents. Missing advanced settings, vocabulary/schema/KG/feedback/source removal/bulk/crawl policy.    |
| Connections     | PARTIAL  | Integration drafts, tools, auth profiles, variables help create integration ingredients. No direct `connection_ops` for Studio connection CRUD/test/OAuth route family. |
| External Agents | NONE     | Studio APIs exist, but no Arch tool family for list/create/update/test external agents.                                                                                 |
| Prompt Library  | NONE     | APIs exist; no Arch prompt-library operations.                                                                                                                          |
| Workflows       | NONE     | APIs exist; no workflow CRUD/trigger/execute/approval tool family.                                                                                                      |

### Operate and Evaluate Surfaces

| Studio surface         | Coverage          | Evidence / gap                                                                                                                                       |
| ---------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions               | PARTIAL           | `session_ops`, `trace_diagnosis`, `query_traces` cover diagnostics. Missing chat reset/replay controls and some UI session operations.               |
| Deployments            | SHADOW            | `deployment-ops.ts` exists but is not declared/registered.                                                                                           |
| Channels / Omnichannel | SHADOW/PARTIAL    | `deployment-ops.ts` has channel actions, but no live tool. Some platform context can list channels.                                                  |
| Inbox / HITL approvals | NONE              | No workflow approval operations exposed.                                                                                                             |
| Transfer sessions      | AWARENESS/PARTIAL | APIs and pages exist; Arch has trace/session tools but no agent-transfer tool family.                                                                |
| Evals                  | PARTIAL           | `run_test` sends a runtime test message. Eval APIs are broad, but `create_eval`/`list_evals` are shadow-only in `testing-ops.ts` and not registered. |
| Experiments            | NONE              | APIs exist; no experiment tool family.                                                                                                               |

### Insights, Governance, and Settings

| Studio surface                                                                      | Coverage          | Evidence / gap                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard / analytics / billing / performance / quality / customer / voice insights | PARTIAL/AWARENESS | `read_insights` covers selected insight queries; broader dashboard operations are not exposed.                                                                 |
| Pipelines                                                                           | NONE              | No pipeline tool family.                                                                                                                                       |
| Guardrails config                                                                   | AWARENESS         | Prompt/docs may know guardrails; no guardrail CRUD/config tool.                                                                                                |
| Governance                                                                          | NONE              | No registry/compliance governance tool family.                                                                                                                 |
| Members / API keys / Git / localization / attachments / public API / modules        | NONE              | No direct Arch tools.                                                                                                                                          |
| Models                                                                              | PARTIAL           | `configure_model`, `recommend_model`, `analyze_constraints`; Studio-specific Arch LLM resolution still duplicates runtime resolver.                            |
| Config variables                                                                    | PARTIAL/FULL-ish  | `variable_ops` covers env/config variables and namespaces.                                                                                                     |
| Auth profiles                                                                       | PARTIAL           | `auth_ops` supports list/read/create/update/delete/validate for four auth types. Studio APIs support broader provider/user-consent/revoke/consumer/bulk flows. |
| Behavior profiles                                                                   | AWARENESS/PARTIAL | Agent edits can reference behavior, but no direct behavior-profile CRUD tool.                                                                                  |
| Agent transfer / Agent assist / PII / attachments / omnichannel settings            | NONE/PARTIAL      | APIs exist for some; no direct Arch tool families.                                                                                                             |

## Auth and Integration Gap Map

Current live integration-methodologist stack:

- `tools_ops`: ProjectTool CRUD/test.
- `mcp_server_ops`: MCP server CRUD/discovery/import/test.
- `auth_ops`: auth profile list/read/create/update/delete/validate.
- `collect_secret`: secure secret collection.
- `variable_ops`: env/config variable CRUD and namespace linking.
- `integration_ops`: session-scoped integration draft lifecycle.
- `platform_context`: list project agents/tools/auth profiles/models/channels.

Missing or partial:

| Gap                         | Impact                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct `connection_ops`     | Arch cannot manage Studio `connections` resources even though routes exist.                                                                   |
| Direct `external_agent_ops` | Arch cannot manage external agent registry/test connections.                                                                                  |
| Auth type coverage          | `auth_ops` creation supports only `api_key`, `bearer`, `oauth2_app`, and `oauth2_client_credentials`; database/UI support more auth variants. |
| Auth action coverage        | No Arch wrapper for provider metadata, OAuth initiate/callback/user-consent, revoke, consumers, or bulk operations.                           |
| Tool invocation history     | Arch can test tools, but cannot inspect historical tool invocations as a first-class workflow.                                                |

## Recommended Starting Backlog

### Phase 0: Fix Contract Drift

1. Register `search_docs` in `buildOnboardingToolRegistry()`.
2. Align `manage_memory` around `delete` in the production registry schema.
3. Wire `get_topology_patterns` through `ToolName`, specialist map, prompt, registry, and tests.
4. Add a registry invariant test: every in-project tool in `IN_PROJECT_TOOLS` that is meant to be model-visible must exist in the production registry, with explicit allowlist exceptions for intentionally deterministic paths.
5. Add a CREATE contract test or remove `create_project` from model-visible CREATE maps if deterministic create remains the intended path.

### Phase 1: Clean Duplicate Maps and Stale Docs

1. Consolidate or retire duplicate in-project specialist maps in Studio legacy files.
2. Update docs that still count shadow tools like `agent_ops` and `deployment_ops` as live.
3. Update feature maps to use the live `ProjectSidebar` project navigation, not only older navigation config.

### Phase 2: Model Resolution Parity

1. Decide whether Studio Arch should call the runtime `ModelResolutionService` or keep a deliberately separate resolver.
2. If separate, create a parity test matrix for provider inference, auth profile credentials, `authConfig`, `useResponsesApi`, policy/budget behavior, cache behavior, and sanitized user-facing errors.
3. Prefer extracting shared resolution utilities so critical model-selection behavior is not duplicated across Studio and runtime.

### Phase 3: Feature Tool Expansion

Prioritize new tool families by user value:

1. `connection_ops` and `external_agent_ops` for integration coverage.
2. Deployment/channel operations, either by reviving `deployment_ops` or splitting into `deployment_ops` and `channel_ops`.
3. Auth profile expansion for provider-guided OAuth, revoke, consumers, bulk, and broader auth types.
4. Eval operations beyond `run_test`: list/create/run/cancel/compare evals through public APIs.
5. Agent lifecycle expansion for delete/duplicate/import, with confirmation guards.

### Phase 4: Deep Feature Coverage

1. Workflow CRUD/trigger/execution/approval operations.
2. Prompt library CRUD/version/test operations.
3. Advanced KB controls: source removal, settings, schema/vocabulary/KG/feedback, bulk/crawl policy.
4. Governance/guardrails/settings tool families once product requirements are clearer.

## First Implementation Slice

The safest first coding slice is small and high leverage:

1. Register `search_docs`.
2. Fix `manage_memory` action mismatch.
3. Wire `get_topology_patterns`.
4. Add production registry invariant tests.

This slice does not require new product design, unlocks promised in-project specialist behavior, and prevents future silent tool-map drift.
