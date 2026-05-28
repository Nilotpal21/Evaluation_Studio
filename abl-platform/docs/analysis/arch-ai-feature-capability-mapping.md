# Arch AI — Feature Capability Mapping (Menu-Based)

> **Generated**: 2026-05-04
> **Approach**: Walk the actual Studio menu structure (navigation.ts + AppShell.tsx + AdminSidebar.tsx), identify every user-facing page, its sub-features, and map each to Arch AI's capability.
> **Source**: `apps/studio/src/config/navigation.ts`, `apps/studio/src/components/navigation/AppShell.tsx`, `packages/arch-ai/src/` (tools, specialists, knowledge cards, 119 diagnostic rules)

---

## Capability Legend

| Level         | Icon                | Meaning                                                                                        |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| **FULL**      | :green_circle:      | Arch AI can create, modify, diagnose, and explain this through dedicated tools and specialists |
| **PARTIAL**   | :yellow_circle:     | Arch AI can interact with some aspects but lacks dedicated tools for complete lifecycle        |
| **AWARENESS** | :large_blue_circle: | Arch AI has knowledge (cards or docs-search) but no direct tools to act                        |
| **NONE**      | :red_circle:        | Outside Arch AI's domain — no coverage                                                         |

---

## Arch AI Tool & Specialist Quick Reference

**Arch AI Tools (40+):** `ask_user`, `collect_file`, `update_specification`, `generate_topology`, `generate_agent`, `compile_abl`, `propose_modification`, `apply_modification`, `dismiss_proposal`, `create_project`, `proceed_to_next_phase`, `query_traces`, `trace_diagnosis`, `session_ops`, `run_test`, `health_check`, `read_agent`, `read_journal`, `read_topology`, `recommend_model`, `analyze_constraints`, `read_insights`, `validate_agent`, `diagnose_project`, `explain_diagnostic`, `project_config`, `configure_model`, `auth_ops`, `collect_secret`, `tools_ops`, `mcp_server_ops`, `variable_ops`, `integration_ops`, `save_tool_dsl`, `platform_context`, `manage_memory`, `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, `kb_documents`, `search_docs`

**Specialists (10):** `onboarding`, `multi-agent-architect`, `abl-construct-expert`, `channel-voice`, `entity-collection`, `integration-methodologist`, `testing-eval`, `diagnostician`, `analyst`, `observer`

**Knowledge Cards (30):** abl-anatomy, execution-config, limitations-vs-constraints, flow-patterns, flow-reasoning-zones, flow-transform, flow-digressions, gather-fields, gather-validation-pii, tool-binding-auth, tool-resolution, tool-templates, handoff-delegate, routing-intents, cross-agent-contracts, guardrails-tiers, error-handling, escalate-a2a, cel-functions, cel-pitfalls, memory-full, nlu-entities, behavior-profiles, hooks-lifecycle, rich-content, attachments-kb, project-config, diagnostics-workflow, observer-analytics, testing-workflow

**Diagnostic Rules (119):** H (handoff, 15), SV (semantic, 15), F (flow, 14), T (tool, 12), O (other, 12), C (constraint, 10), G (gather, 8), E (execution, 7), M (memory, 6), BP (behavior-profile, 6), QG (guardrail, 5), GR (guardrail-runtime, 5), CO (completion, 4)

---

## A. Arch AI Standalone (area: `arch`)

The full-screen project creation wizard — Arch v0.3.

| Page            | Component    | What the user does                                                      | Arch AI Level | How Arch covers it                                                                                                                                                                                                                                                                                    |
| --------------- | ------------ | ----------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Arch Wizard** | `ArchV3Page` | Create new projects via AI-guided interview → topology → build → create | **FULL**      | This IS Arch AI's ONBOARDING mode. 4 phases (INTERVIEW → BLUEPRINT → BUILD → CREATE). Tools: `ask_user`, `collect_file`, `update_specification`, `generate_topology`, `generate_agent`, `compile_abl`, `create_project`. `onboarding` + `multi-agent-architect` + `abl-construct-expert` specialists. |

---

## B. Project Workspace (area: `project`)

### B.1 BUILD Section

| Menu Item                  | Component             | What the user does                                                    | Arch AI Level | How Arch covers it                                                                                                                                                                                                   |
| -------------------------- | --------------------- | --------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**               | `ProjectOverviewPage` | See project dashboard, agent topology, health status, recent activity | **PARTIAL**   | `health_check`, `read_topology`, `project_config` tools. Can explain project state. Cannot modify overview widgets/layout.                                                                                           |
| **Agents** (list)          | `AgentListPage`       | Browse all agents, see topology canvas, create new agents             | **FULL**      | `read_agent`, `read_topology`, `propose_modification(isNew:true)` for new agents. `multi-agent-architect` specialist. Architecture planner with pattern detection (hub-spoke, pipeline, mesh, triage, hierarchical). |
| **Agents** (detail/editor) | `AgentEditorPage`     | Edit a single agent across 17 sections (see B.1.1 below)              | **FULL**      | Core competency. `propose_modification` (sections or updatedCode), `apply_modification`, `compile_abl`. Page-context-aware — Arch sees which section the user is viewing.                                            |
| **Agents** (chat/test)     | `ChatWithDebugPanel`  | Test an agent in live chat with debug pane                            | **PARTIAL**   | `session_ops`, `query_traces`, `trace_diagnosis` for post-run analysis. Cannot inject messages or control the chat programmatically from Arch.                                                                       |
| **Workflows** (list)       | `WorkflowsListPage`   | Browse workflows, create new workflows                                | **AWARENESS** | Page context recognizes `workflow` entity. `search_docs` for workflow concepts. No workflow CRUD tools.                                                                                                              |
| **Workflows** (detail)     | `WorkflowDetailPage`  | Edit workflow YAML, configure steps, view execution history           | **AWARENESS** | No tools to read/write workflow definitions. Cannot modify steps, triggers, or logic.                                                                                                                                |
| **Workflows** (canvas)     | `WorkflowCanvasPage`  | Visual flow editor for workflow nodes and edges                       | **NONE**      | Completely separate visual editor. Arch has no canvas manipulation tools.                                                                                                                                            |

#### B.1.1 Agent Editor Sections (17 sections)

These are the sections within the agent editor (`AgentEditorPage`). Arch AI is most powerful here.

| Section            | EditorSection ID | What the user configures                                          | Arch AI Level | How Arch covers it                                                                                                                                                                   |
| ------------------ | ---------------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Identity**       | `identity`       | Agent name, role, goal, persona, execution mode                   | **FULL**      | `propose_modification(sections)`. `abl-anatomy` card. BP-01→BP-06 diagnostic rules.                                                                                                  |
| **Execution**      | `execution`      | Model, temperature, max tokens, thinking, timeouts, concurrency   | **FULL**      | `configure_model`, `recommend_model`, `analyze_constraints`. `execution-config` card. E-01→E-07 rules.                                                                               |
| **Tools**          | `tools`          | Tool bindings (HTTP, function, KB, MCP)                           | **FULL**      | `tools_ops`, `mcp_server_ops`, `save_tool_dsl`, `auth_ops`. `tool-binding-auth`, `tool-resolution`, `tool-templates` cards. T-01→T-12 rules. `integration-methodologist` specialist. |
| **Gather**         | `gather`         | Data collection fields, validation, PII masking, extraction hints | **FULL**      | `entity-collection` specialist. `gather-fields`, `gather-validation-pii` cards. G-01→G-08 rules. Fuzzy match, progressive activation, depends-on.                                    |
| **Memory**         | `memory`         | Session vars, persistent paths, remember/recall triggers          | **FULL**      | `manage_memory` tool. `memory-full` card. M-01→M-06 rules.                                                                                                                           |
| **Flow**           | `flow`           | Conversation flow steps, reasoning zones, transforms, digressions | **FULL**      | `flow-patterns`, `flow-reasoning-zones`, `flow-transform`, `flow-digressions` cards. F-01→F-14 rules.                                                                                |
| **Constraints**    | `constraints`    | Behavioral limitations and constraints                            | **FULL**      | `limitations-vs-constraints` card. C-01→C-10 rules. `constraint-design-coaching` knowledge.                                                                                          |
| **Guardrails**     | `guardrails`     | Input/output guardrail policies                                   | **FULL**      | `guardrails-tiers` card. QG-01→QG-05 + GR-01→GR-05 rules.                                                                                                                            |
| **Behavior**       | `behavior`       | Behavior profile (tone, verbosity, language style)                | **FULL**      | `behavior-profiles` card. BP-01→BP-06 rules.                                                                                                                                         |
| **Handoffs**       | `handoffs`       | Agent-to-agent routing (WHEN, PASS, history, targets)             | **FULL**      | `handoff-delegate` card. `cross-agent-contracts`, `escalate-a2a` cards. H-01→H-15 rules.                                                                                             |
| **Delegates**      | `delegates`      | Delegate sub-tasks to other agents (DELEGATE construct)           | **FULL**      | H-11, H-12 delegation rules. `handoff-delegate` card.                                                                                                                                |
| **Escalation**     | `escalation`     | Human handoff triggers, context, routing                          | **FULL**      | H-13, H-14 rules. `escalate-a2a` card. `abl-construct-expert` specialist.                                                                                                            |
| **On Start**       | `onStart`        | Lifecycle hooks — initial message, tool calls, variable sets      | **FULL**      | `hooks-lifecycle` card.                                                                                                                                                              |
| **Error Handling** | `errorHandling`  | Error handlers with retry/backoff strategies                      | **FULL**      | `error-handling` card.                                                                                                                                                               |
| **Completion**     | `completion`     | Completion conditions and disposition                             | **FULL**      | CO-01→CO-04 rules.                                                                                                                                                                   |
| **Templates**      | `templates`      | Rich content templates (default, markdown, HTML, voice)           | **PARTIAL**   | `rich-content` card. Diagnostic rules exist but no dedicated template management tool.                                                                                               |
| **Definition**     | `definition`     | Raw ABL DSL source code                                           | **FULL**      | `compile_abl`, `propose_modification(updatedCode)`. Core DSL expertise.                                                                                                              |

### B.2 RESOURCES Section

| Menu Item                       | Component                    | What the user does                                              | Arch AI Level | How Arch covers it                                                                                                                                                      |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tools** (list)                | `ToolsListPage`              | Browse project tools (HTTP, Function, KB, MCP tabs)             | **FULL**      | `tools_ops(action:"list")`. `integration-methodologist` specialist.                                                                                                     |
| **Tools** (detail)              | `ToolDetailPage`             | Edit tool endpoint, auth, headers, body, test execution         | **FULL**      | `tools_ops(action:"update")`, `auth_ops`. Includes endpoint, auth profile, schema editing.                                                                              |
| **Tools** (create)              | `ToolCreatePage`             | Create new HTTP/Function/KB/MCP tools                           | **FULL**      | `tools_ops(action:"create")`. `integration-methodologist` guides tool design.                                                                                           |
| **MCP Servers**                 | `McpServerDetailPage`        | Configure MCP server connection, discover/import tools          | **FULL**      | `mcp_server_ops` (create, update, test, discover, import). Full lifecycle.                                                                                              |
| **Knowledge Bases** (dashboard) | `KnowledgeBaseDashboardPage` | View all KBs, create new KB, see health metrics                 | **FULL**      | `kb_manage`, `kb_health`. `attachments-kb` card.                                                                                                                        |
| **Knowledge Bases** (detail)    | `KnowledgeBaseDetailPage`    | Manage sources, chunks, connectors, embeddings, graph, settings | **PARTIAL**   | `kb_ingest`, `kb_search`, `kb_documents`, `kb_connector`, `kb_health` tools. Cannot configure embedding models, chunk strategies, or knowledge graph entities directly. |
| **Prompt Library** (list)       | `PromptLibraryListPage`      | Browse versioned prompt templates                               | **AWARENESS** | `search_docs` for prompt concepts. No prompt CRUD tools.                                                                                                                |
| **Prompt Library** (detail)     | `PromptLibraryDetailPage`    | Edit prompt content, variables, version history                 | **NONE**      | No prompt editing tools in Arch.                                                                                                                                        |
| **Prompt Library** (compare)    | `PromptLibraryComparePage`   | Diff prompt versions side-by-side                               | **NONE**      | No prompt comparison tools.                                                                                                                                             |
| **Integrations**                | `ConnectionsPage`            | Manage OAuth connections, API integrations                      | **PARTIAL**   | `integration_ops`, `auth_ops` tools. Can create auth profiles. Cannot manage full OAuth flow or connection testing UI.                                                  |
| **Dependencies**                | `ModuleDependenciesPage`     | View and manage reusable module dependencies                    | **AWARENESS** | No module dependency management tools.                                                                                                                                  |

### B.3 EVALUATE Section

| Menu Item                | Component          | What the user does                                          | Arch AI Level | How Arch covers it                                                                                                                                 |
| ------------------------ | ------------------ | ----------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evals**                | `EvalsPage`        | Create/run evaluation sets, scenarios, personas, evaluators | **PARTIAL**   | `testing-eval` specialist. `run_test` tool. `testing-workflow` card. Can run tests but cannot create eval personas or evaluator configs from Arch. |
| **Experiments** (list)   | `ExperimentsPage`  | Create A/B experiments with agent variants                  | **AWARENESS** | No experiment creation/management tools.                                                                                                           |
| **Experiments** (detail) | `ExperimentDetail` | View experiment results, compare variants                   | **AWARENESS** | `read_insights` could surface some metrics. No dedicated experiment analysis tool.                                                                 |

### B.4 OPERATE Section

| Menu Item             | Component              | What the user does                                                | Arch AI Level | How Arch covers it                                                                                                                               |
| --------------------- | ---------------------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sessions** (list)   | `SessionsListPage`     | Browse active/completed sessions, filter, search                  | **FULL**      | `session_ops` tool. `diagnostician` specialist. Can query and filter sessions.                                                                   |
| **Sessions** (detail) | `SessionDetailPage`    | View session transcript, trace events, debug info                 | **FULL**      | `query_traces`, `trace_diagnosis`, `session_ops`. `diagnostician` specialist can analyze failures, explain decision paths, identify root causes. |
| **Deployments**       | `DeploymentsPage`      | Create deployments, promote between environments, manage channels | **AWARENESS** | `project_config` for reading. No deployment creation, promotion, or channel instance tools.                                                      |
| **Inbox**             | `UnifiedInboxPage`     | Review and approve human-in-the-loop tasks from workflows         | **NONE**      | No inbox/task management tools in Arch.                                                                                                          |
| **Alerts**            | `AlertsPage`           | Configure and view proactive alert rules                          | **NONE**      | No alert CRUD tools.                                                                                                                             |
| **Transfer Sessions** | `TransferSessionsPage` | Monitor live agent transfer sessions                              | **AWARENESS** | `session_ops` can query. No transfer-specific management tools.                                                                                  |

### B.5 INSIGHTS Section

| Menu Item             | Component              | What the user does                                             | Arch AI Level | How Arch covers it                                                                                       |
| --------------------- | ---------------------- | -------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| **Dashboard**         | `AtAGlancePage`        | Executive KPIs — resolution rate, volume, CSAT, latency        | **PARTIAL**   | `read_insights` tool. `observer` specialist can discuss trends. Cannot configure dashboard.              |
| **Analytics**         | `AnalyticsPage`        | Deep analytics explorer with custom queries/charts             | **PARTIAL**   | `analyst` specialist. `read_insights`. Can explain patterns. Cannot create custom queries or charts.     |
| **Billing/Usage**     | `ProjectBillingPage`   | View project-level billing units and cost breakdowns           | **NONE**      | Financial data. Outside Arch's domain.                                                                   |
| **Agent Performance** | `AgentPerformancePage` | Per-agent diagnostic metrics (response time, error rate, etc.) | **PARTIAL**   | `diagnostician` specialist. Can analyze agent health. Cannot configure performance thresholds or alerts. |
| **Quality Monitor**   | `QualityMonitorPage`   | Watchtower — automated quality scoring trends                  | **PARTIAL**   | `observer` specialist. `read_insights`. Can explain quality trends. Cannot configure quality rules.      |
| **Customer Insights** | `CustomerInsightsPage` | Intent analysis, VoC, sentiment trends                         | **PARTIAL**   | `analyst` specialist. `nlu-entities` card. Can analyze patterns. Cannot configure intent training.       |
| **Voice Analytics**   | `VoiceAnalyticsPage`   | Aggregated voice metrics — call duration, latency, quality     | **AWARENESS** | `observer-analytics` card. No voice-specific analytics tools.                                            |

### B.6 GOVERN Section

| Menu Item             | Component              | What the user does                                       | Arch AI Level | How Arch covers it                                                                                                                                     |
| --------------------- | ---------------------- | -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Guardrails Config** | `GuardrailsConfigPage` | Configure project-level guardrail policies and providers | **PARTIAL**   | `guardrails-tiers` card. Can author guardrail ABL constructs. Cannot manage guardrail provider configurations (PII, content filter, custom) from Arch. |
| **Governance**        | `GovernancePage`       | Agent registry compliance, governance frameworks, audit  | **AWARENESS** | `search_docs` for governance concepts. No governance CRUD tools.                                                                                       |

### B.7 SETTINGS Section (Project-Level)

| Menu Item            | Component                   | What the user configures                               | Arch AI Level | How Arch covers it                                                                                                |
| -------------------- | --------------------------- | ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Members**          | `ProjectMembersTab`         | Project member roles and permissions                   | **NONE**      | RBAC management. Outside Arch's domain.                                                                           |
| **API Keys**         | `ApiKeysTab`                | Project API keys for SDK/REST access                   | **NONE**      | Key management. Outside Arch's domain.                                                                            |
| **Models**           | `ModelConfigTab`            | Project LLM model selection, credentials, overrides    | **FULL**      | `configure_model` tool (inspect, diff, apply). `recommend_model`. Core Arch capability.                           |
| **Config Variables** | `ConfigVariablesTab`        | Environment variables for tool endpoints, secrets      | **FULL**      | `variable_ops` tool. `integration-methodologist` specialist.                                                      |
| **Localization**     | `LocalizationSettingsPage`  | Language settings, translation management              | **AWARENESS** | `search_docs` for i18n concepts. No localization tools.                                                           |
| **Git**              | `GitIntegrationTab`         | Git repo connection, branch sync                       | **NONE**      | Infrastructure. Outside Arch's domain.                                                                            |
| **Advanced**         | `AdvancedSettingsTab`       | Advanced project configuration flags                   | **PARTIAL**   | `project_config` tool can read. Limited write capability.                                                         |
| **Runtime Config**   | `RuntimeConfigTab`          | Runtime behavior tuning (timeouts, concurrency, etc.)  | **PARTIAL**   | `project_config` can read/write some. `execution-config` card.                                                    |
| **Trace Dimensions** | `TraceDimensionsTab`        | Custom trace dimension definitions                     | **AWARENESS** | No trace dimension management tools.                                                                              |
| **Agent Transfer**   | `AgentTransferSettingsPage` | Transfer adapter config (Five9, Kore, Genesys, etc.)   | **AWARENESS** | `search_docs` for transfer concepts. No adapter configuration tools.                                              |
| **Agent Assist**     | `AgentAssistSettingsPage`   | Agent Assist mode configuration                        | **AWARENESS** | No agent-assist configuration tools.                                                                              |
| **PII Protection**   | `PIIProtectionTab`          | PII detection patterns and redaction rules             | **PARTIAL**   | `gather-validation-pii` card. Can author PII rules in ABL GATHER fields. Cannot manage project-wide PII patterns. |
| **Public API**       | `PublicApiAccessTab`        | Public API access configuration                        | **NONE**      | API access management. Outside Arch's domain.                                                                     |
| **Auth Profiles**    | `AuthProfilesPage`          | OAuth/API key/mTLS auth profiles for tool integrations | **FULL**      | `auth_ops` tool. `tool-binding-auth` card. `integration-methodologist` specialist.                                |
| **Attachments**      | `AttachmentSettingsTab`     | File upload limits, allowed types, storage config      | **AWARENESS** | `attachments-kb` card. No attachment settings tools.                                                              |
| **Omnichannel**      | `OmnichannelSettingsPanel`  | Cross-channel session continuity rules                 | **AWARENESS** | No omnichannel configuration tools.                                                                               |
| **Modules**          | `ModuleSettingsPage`        | Reusable module management                             | **AWARENESS** | No module management tools.                                                                                       |

---

## C. Workspace Admin (area: `admin`)

### C.1 Team Section

| Menu Item                 | Component         | What the admin does                         | Arch AI Level | How Arch covers it                                         |
| ------------------------- | ----------------- | ------------------------------------------- | ------------- | ---------------------------------------------------------- |
| **Members**               | `MembersPage`     | Manage workspace members, invitations       | **NONE**      | Workspace-level IAM. Outside Arch's project-scoped domain. |
| **Custom Roles**          | `CustomRolesPage` | Define custom RBAC roles                    | **NONE**      | RBAC management. Outside Arch's domain.                    |
| **Security**              | `SecurityPage`    | SSO, MFA, session policies, audit logs      | **NONE**      | Security infrastructure. Outside Arch's domain.            |
| **KMS**                   | `KMSPage`         | Key management (BYOK, key rotation, scopes) | **NONE**      | Encryption infrastructure. Outside Arch's domain.          |
| **Environment Variables** | `EnvVarsPage`     | Workspace-level environment variables       | **NONE**      | Workspace-level config. Arch operates at project scope.    |

### C.2 AI Configuration Section

| Menu Item          | Component                   | What the admin does                                               | Arch AI Level | How Arch covers it                                                                                                            |
| ------------------ | --------------------------- | ----------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **LLM Providers**  | `ModelsPage`                | Add/configure LLM providers, API keys, model catalog              | **AWARENESS** | `configure_model` works at project level. Workspace provider setup is outside Arch's scope. `search_docs` for model concepts. |
| **Arch Settings**  | `ArchSettingsPage`          | Configure Arch AI (model selection, hyper-parameters, audit logs) | **AWARENESS** | This configures Arch itself. Arch cannot self-configure.                                                                      |
| **Voice Services** | `VoiceServicesPage`         | Configure voice providers (LiveKit, Twilio, AudioCodes)           | **NONE**      | Voice infrastructure. Outside Arch's domain.                                                                                  |
| **Guardrails**     | `GuardrailsPage`            | Workspace-level guardrail providers and policies                  | **AWARENESS** | `guardrails-tiers` card. Workspace-level guardrail admin is outside project scope.                                            |
| **Auth Profiles**  | `WorkspaceAuthProfilesPage` | Workspace-level auth profile templates                            | **AWARENESS** | `auth_ops` works at project level. Workspace templates outside scope.                                                         |

### C.3 Analytics Section

| Menu Item             | Component                   | What the admin does                       | Arch AI Level | How Arch covers it                                |
| --------------------- | --------------------------- | ----------------------------------------- | ------------- | ------------------------------------------------- |
| **Agent Performance** | `AdminAgentPerformancePage` | Cross-project agent performance metrics   | **NONE**      | Workspace-level analytics. Outside project scope. |
| **Session Explorer**  | `SessionExplorerPage`       | Cross-project session search and analysis | **NONE**      | Workspace-level. Outside project scope.           |
| **Trace Viewer**      | `TraceViewerPage`           | Cross-project trace search and deep-dive  | **NONE**      | Workspace-level. Outside project scope.           |

### C.4 Account Section

| Menu Item              | Component               | What the admin does                  | Arch AI Level | How Arch covers it                                                         |
| ---------------------- | ----------------------- | ------------------------------------ | ------------- | -------------------------------------------------------------------------- |
| **Workspace Settings** | `WorkspaceSettingsPage` | Workspace name, branding, defaults   | **NONE**      | Workspace config. Outside Arch's domain.                                   |
| **Secrets**            | `SecretsPage`           | Workspace secret vault management    | **NONE**      | Secret infrastructure. Outside Arch's domain.                              |
| **Billing**            | `BillingPage`           | Subscription, usage, invoices        | **NONE**      | Financial. Outside Arch's domain.                                          |
| **Connectors**         | `ConnectorsPage`        | Workspace-level connector management | **AWARENESS** | `kb_connector` works at project level. Workspace connectors outside scope. |

---

## D. User Settings (area: `settings`)

| Page                  | Component     | What the user does       | Arch AI Level | How Arch covers it                        |
| --------------------- | ------------- | ------------------------ | ------------- | ----------------------------------------- |
| **Personal API Keys** | `ApiKeysPage` | Manage personal API keys | **NONE**      | Personal settings. Outside Arch's domain. |

---

## E. Arch AI In-Project Overlay (ArchV4Overlay)

Available on ALL project pages as a slide-over panel. This is the IN_PROJECT mode.

| Capability                         | How it works                                   | Specialist                  | Key Tools                                                                          |
| ---------------------------------- | ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| **Ask about any agent**            | Reads agent ABL, explains constructs           | `abl-construct-expert`      | `read_agent`, `read_journal`                                                       |
| **Modify agents conversationally** | NL → structured diff → apply                   | `abl-construct-expert`      | `propose_modification`, `apply_modification`, `compile_abl`                        |
| **Diagnose issues**                | Static validation (119 rules) + trace analysis | `diagnostician`             | `validate_agent`, `diagnose_project`, `explain_diagnostic`                         |
| **Debug sessions**                 | Query traces, explain failures, suggest fixes  | `diagnostician`             | `query_traces`, `trace_diagnosis`, `session_ops`                                   |
| **Analyze production**             | Metrics, trends, anomalies, weekly briefings   | `observer` + `analyst`      | `read_insights`, `session_ops`                                                     |
| **Configure tools**                | Create/edit tools, MCP servers, auth profiles  | `integration-methodologist` | `tools_ops`, `mcp_server_ops`, `auth_ops`, `variable_ops`, `collect_secret`        |
| **Manage knowledge bases**         | CRUD, ingest, search, health, connectors       | `abl-construct-expert`      | `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, `kb_documents` |
| **Configure models**               | Inspect, diff recommendations, apply optimal   | `abl-construct-expert`      | `configure_model`, `recommend_model`                                               |
| **Run tests**                      | Execute test scenarios, analyze results        | `testing-eval`              | `run_test`, `query_traces`                                                         |
| **Entity collection design**       | GATHER fields, lookup tables, PII, extraction  | `entity-collection`         | `propose_modification`, `compile_abl`                                              |
| **Voice/channel authoring**        | Voice-specific ABL (TTS, ASR, latency targets) | `channel-voice`             | `propose_modification`, `compile_abl`                                              |
| **Search platform docs**           | Find answers about any platform topic          | All specialists             | `search_docs` (L3 BM25 over docs-internal)                                         |
| **Manage project memory**          | Read/write project-level memory entries        | `abl-construct-expert`      | `manage_memory`                                                                    |

---

## Summary

### By Menu Area

| Area                           | Total Pages | FULL   | PARTIAL | AWARENESS | NONE   |
| ------------------------------ | ----------- | ------ | ------- | --------- | ------ |
| **Arch Wizard**                | 1           | 1      | 0       | 0         | 0      |
| **Build** (agents + workflows) | 7           | 4      | 1       | 1         | 1      |
| **Agent Editor** (17 sections) | 17          | 16     | 1       | 0         | 0      |
| **Resources**                  | 11          | 6      | 2       | 1         | 2      |
| **Evaluate**                   | 3           | 0      | 1       | 2         | 0      |
| **Operate**                    | 6           | 2      | 0       | 2         | 2      |
| **Insights**                   | 7           | 0      | 5       | 1         | 1      |
| **Govern**                     | 2           | 0      | 1       | 1         | 0      |
| **Settings** (project)         | 16          | 3      | 3       | 6         | 4      |
| **Admin** (workspace)          | 14          | 0      | 0       | 4         | 10     |
| **User Settings**              | 1           | 0      | 0       | 0         | 1      |
| **TOTAL**                      | **85**      | **32** | **14**  | **18**    | **21** |

### Overall Distribution

| Level     | Count | %     |
| --------- | ----- | ----- |
| FULL      | 32    | 37.6% |
| PARTIAL   | 14    | 16.5% |
| AWARENESS | 18    | 21.2% |
| NONE      | 21    | 24.7% |

### Where Arch AI is Strongest

1. **Agent Editor** — 16/17 sections at FULL. This is Arch's core domain. Every ABL construct (identity, tools, gather, flow, handoffs, delegates, memory, constraints, guardrails, behavior, escalation, completion, error handling, on-start, execution, definition) has dedicated tools, knowledge cards, and diagnostic rules.

2. **Tools & Integrations** — FULL coverage for tool CRUD, MCP server lifecycle, auth profiles, and config variables. The `integration-methodologist` specialist handles end-to-end.

3. **Knowledge Bases** — FULL for core KB lifecycle. Tools for manage, ingest, search, health, connector, documents.

4. **Session Debugging** — FULL for session inspection and trace analysis. `diagnostician` specialist with `query_traces` + `trace_diagnosis`.

### Highest Impact Gaps

| Gap                        | Pages Affected                       | Impact                                                                             | Effort to Close                                                                          |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Workflows**              | 3 pages (list, detail, canvas)       | Users can't get Arch help designing workflow logic                                 | HIGH — needs new tools: `workflow_read`, `workflow_modify`, `workflow_validate`          |
| **Deployments & Channels** | Deployments page + channel instances | Users can't get Arch help deploying or configuring channels                        | MEDIUM — needs: `deployment_ops`, `channel_ops`                                          |
| **Eval & Experiments**     | 3 pages                              | Users can't create eval scenarios or experiments via Arch                          | MEDIUM — needs: `eval_create`, `experiment_ops`                                          |
| **Alerts**                 | Alerts page                          | Users can't configure monitoring rules via Arch                                    | LOW — needs: `alert_ops`                                                                 |
| **Insights Configuration** | 7 insight pages                      | All PARTIAL — Arch reads but can't configure dashboards, queries, or quality rules | MEDIUM — `analyst` specialist needs write tools                                          |
| **Workspace Admin**        | 14 admin pages                       | All NONE — Arch is project-scoped by design                                        | DESIGN DECISION — extending Arch to workspace scope is a fundamental architecture change |
