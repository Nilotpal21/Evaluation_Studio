# Arch-AI Capability Metrics

> **Purpose.** This is a **scorecard** for what Arch-AI can do today across every product surface in the ABL platform — menu by menu, route by route, specialist by specialist. It is the canonical "we are at X%" doc that we re-run periodically and use to pick the next capability to invest in.
>
> **This is not a narrative audit.** For deep reasoning behind scores, see the companion docs in [References](#references--source-of-truth) — most recently [`wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md`](./wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md). This doc tracks the bottom line.

| Field            | Value                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| Owner            | Arch-AI eng                                                           |
| Last refreshed   | 2026-05-11                                                            |
| Refresh cadence  | Every Arch-AI minor version + before each capability-planning cycle   |
| Refresh skill    | `arch-capability-refresh` (proposed — see [§9](#9-recommended-skill)) |
| Companion audits | `wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md`               |

---

## TL;DR — 2026-05-11 snapshot

| Metric                                                 | Value      |
| ------------------------------------------------------ | ---------- |
| Studio project-menu items inventoried                  | **62**     |
| Of those Arch-AI can fully orchestrate (FULL)          | **8**      |
| Of those Arch-AI can partially orchestrate (CONFIG)    | **17**     |
| Of those Arch-AI can only read/observe (READ)          | **15**     |
| Of those with no Arch-AI awareness (NONE)              | **22**     |
| **Studio coverage score** (weighted, see §1.10)        | **38 %**   |
| Runtime subsystems inventoried                         | **17**     |
| Runtime subsystems Arch-AI exercises directly          | **6**      |
| **Runtime coverage score**                             | **35 %**   |
| Arch-AI specialists registered                         | **12**     |
| Arch-AI tools registered (internal + interactive)      | **68**     |
| Arch-AI in-project reachable actions (per May 5 audit) | **~125**   |
| ABL constructs Scaffold emits                          | **6 / 19** |
| Knowledge cards shipped                                | **49**     |
| Diagnostic rule codes (vs prompt-claimed 53)           | **77**     |

**Headline gaps (P0–P1, pull from §7 for next sprint):**

1. Channel CRUD + agent↔channel binding (Studio surface present, Arch-AI has read-only).
2. Auth-profile types — only 4 of 7 supported; no `oauth2_user`, `mtls`, `aws_sigv4`.
3. Evals — Phase 2 write surface (scenarios, datasets, comparisons) not exposed.
4. Observatory / dashboards / alerts — zero Arch-AI awareness despite full Studio menus.
5. Workflow + Pipeline authoring — Studio has 23 node types, Arch-AI has zero generators.
6. KB connector lifecycle — discover/recommend/quick-setup, sync_stop/restart, permissions.
7. Scaffold construct coverage — 13 IR constructs have neither Scaffold nor specialist teaching.

---

## How to refresh this document

> Run this when **any** of the following land: a new Arch-AI specialist/tool/phase, a new top-level Studio menu, a new Runtime route family, or a new audit doc in `packages/arch-ai/docs/wip/`. Otherwise re-run quarterly.

1. **Re-audit Studio surface** — read `apps/studio/src/components/navigation/ProjectSidebar.tsx` and `AppShell.tsx`; cross-check every nav item appears in [§1](#1-studio-project-level-menu-surface). New routes → add row at appropriate scoring.
2. **Re-audit Runtime surface** — read `apps/runtime/src/server.ts` route mounts and `apps/runtime/src/routes/`; update [§2](#2-runtime-surface).
3. **Re-audit Arch-AI inventory**:
   - Specialists: enumerate `packages/arch-ai/src/prompts/specialists/*.ts` → [§3](#3-arch-ai-specialist-inventory).
   - Tools: enumerate `packages/arch-ai/src/tools/adapters/classification.ts` + `tools/schemas/in-project-schemas.ts` + `types/tools.ts` → [§4](#4-arch-ai-tool-inventory).
   - Phases: `packages/arch-ai/src/prompts/phases/*.ts` → [§3.2](#32-phases).
   - Cards: `packages/arch-ai/src/knowledge/cards/` counts → §3.3.
4. **Re-score every row in §1 and §2** using the legend below. A score may move UP (new feature) or DOWN (regression / removed coverage).
5. **Update the TL;DR snapshot** numbers and the date.
6. **Compute the weighted coverage score** per [§1.10](#110-coverage-score-method).
7. **Promote items in §7** that have shipped; demote completed items to "Done" with the PR/commit reference.
8. **Diff vs previous version** — commit the doc with `[ABLP-XXX] docs(arch-ai): refresh capability metrics — <date>`.

If the **`arch-capability-refresh`** skill exists (proposed §9), `/arch-capability-refresh` automates steps 1–6.

---

## Scoring legend

| Score      | Symbol | Meaning                                                                                                                                                             |
| ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FULL**   | ●●●●   | Arch-AI can do every CRUD operation **plus** test/verify it. A user can ask "build/change/delete X" in natural language and Arch-AI completes the round trip.       |
| **CONFIG** | ●●●○   | Arch-AI can perform most CRUD operations but has notable holes (e.g. read+update but no delete; or partial schema coverage). User often falls back to Studio for X. |
| **READ**   | ●●○○   | Arch-AI can observe (list/describe/explain) but cannot mutate. Useful for diagnosis, not for build.                                                                 |
| **NONE**   | ●○○○   | Arch-AI has no tool, no knowledge card, no specialist prompt referencing this surface. User must do this entirely in Studio.                                        |
| **N/A**    | —      | Not Arch-AI's responsibility (e.g. platform admin, billing UI). Documented for completeness but excluded from coverage scoring.                                     |

A trailing **★** denotes that a knowledge card or specialist exists guiding the user (e.g. `READ ★` = can observe + has teaching material; `NONE ★` = teaching exists but no executable tool yet).

---

## 1. Studio project-level menu surface

> Source of truth: `apps/studio/src/components/navigation/ProjectSidebar.tsx:103–252`, `AppShell.tsx:656–904`, `agent-editor/AgentEditor.tsx:43–71`.
>
> Scope: every leaf menu under `/projects/[projectId]/*`. Settings is treated as one section with subscores. Workspace-level menus (Academy, Admin) listed in §1.9.

### 1.1 BUILD

| Menu item | Route                      | Sub-resources                                                                          | Arch-AI specialist(s)                   | Arch-AI tool(s)                                                         | Score    | Notes                                                                                                                                                                |
| --------- | -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview  | `/projects/[id]/overview`  | Resource summary, recent activity                                                      | in-project-architect                    | `platform_context` (`get_summary`)                                      | READ     | Read-only summary; no widgets to mutate.                                                                                                                             |
| Agents    | `/projects/[id]/agents`    | 17 agent-editor sections (Identity, Execution, Tools, Gather, Memory, Flow, Handoffs…) | abl-construct-expert, multi-agent-arch. | `agent_ops`, `generate_agent`, `compile_abl`, `propose_modification`, … | CONFIG ★ | Full CRUD via `agent_ops`. Authoring narrow: Scaffold emits only 6 slots; 13 IR constructs lack scaffold + prompt teaching (see [§5.3](#53-abl-construct-coverage)). |
| Workflows | `/projects/[id]/workflows` | 23 node types (start/end/condition/loop/llm/api/agent/human/…)                         | — (none)                                | — (none)                                                                | NONE     | Studio surface has no Arch-AI integration. Workflow generation is the **biggest authoring gap**.                                                                     |

### 1.2 RESOURCES

| Menu item       | Route                            | Sub-resources                                                      | Arch-AI specialist(s)     | Arch-AI tool(s)                                                                                             | Score  | Notes                                                                                                                                                                       |
| --------------- | -------------------------------- | ------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools           | `/projects/[id]/tools`           | HTTP, Sandbox (JS/Py), MCP, Workflow, Lambda                       | integration-methodologist | `tools_ops` (6 actions), `mcp_server_ops` (10 actions), `save_tool_dsl`                                     | FULL ★ | Full CRUD + test for HTTP/Sandbox/MCP. Lambda surface is read-only.                                                                                                         |
| Knowledge Bases | `/projects/[id]/search-ai`       | 88 connectors, docs, indexing, schema, crawl, permissions, filters | integration-methodologist | `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, `kb_documents`, `kb_crawl`, `kb_schema` | CONFIG | KB lifecycle mostly covered. Connector lifecycle gaps: no `discover`/`recommend`/`quick_setup`/`sync_stop`/`sync_restart`/`delta_token_reset`/permissions/filters wrappers. |
| Prompt Library  | `/projects/[id]/prompt-library`  | Prompt versioning, comparison, A/B                                 | — (none)                  | — (none)                                                                                                    | NONE   | No Arch-AI integration at all.                                                                                                                                              |
| Integrations    | `/projects/[id]/connections`     | OAuth/API connection bindings (per channel/connector)              | integration-methodologist | `connection_ops`, `integration_ops` (7 actions), `auth_ops` (6 actions)                                     | CONFIG | Connection binding works; OAuth-redirect orchestration only partially modelled.                                                                                             |
| External Agents | `/projects/[id]/external-agents` | Remote A2A agents, delegate-only or returning                      | multi-agent-architect     | `external_agent_ops`                                                                                        | CONFIG | Spec-1 limitation: remote handoffs are fire-and-forget — no `RETURN:true` support.                                                                                          |

### 1.3 EVALUATE

| Menu item   | Route                        | Sub-resources                                          | Arch-AI specialist(s) | Arch-AI tool(s)                                                                                  | Score    | Notes                                                                                                  |
| ----------- | ---------------------------- | ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| Evals       | `/projects/[id]/evals`       | Eval cases, runs, comparison dashboards, quality gates | testing-eval          | `testing_ops` (run_test, list_evals, create_eval — name+desc only), `run_test`, `run_simulation` | CONFIG ★ | Phase 1 only: read + run + propose. Phase 2 (full scenario authoring, datasets, comparisons) deferred. |
| Experiments | `/projects/[id]/experiments` | A/B variant assignment, success criteria, rollout %    | — (none)              | — (none)                                                                                         | NONE     | No Arch-AI awareness. Closely tied to Models + Eval surfaces.                                          |

### 1.4 OPERATE

| Menu item         | Route                              | Sub-resources                           | Arch-AI specialist(s)     | Arch-AI tool(s)                                                            | Score  | Notes                                                                     |
| ----------------- | ---------------------------------- | --------------------------------------- | ------------------------- | -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| Sessions          | `/projects/[id]/sessions`          | List, filter, replay, diagnose          | diagnostician, analyst    | `session_ops` (3 actions), `query_traces`, `trace_diagnosis` (6 actions)   | READ   | Strong diagnosis surface. No write/replay/mutate.                         |
| Deployments       | `/projects/[id]/deployments`       | Deploy, promote, rollback, channel-bind | integration-methodologist | `deployment_ops` (deploy, promote, list, configure_channel, list_channels) | CONFIG | Rollback was removed from DANGEROUS_ACTIONS — no executor case currently. |
| Inbox             | `/projects/[id]/inbox`             | HITL queue, escalations, assignments    | — (none)                  | — (none)                                                                   | NONE   | No Arch-AI awareness.                                                     |
| Transfer Sessions | `/projects/[id]/transfer-sessions` | Human-handoff sessions, agent assist    | — (none)                  | — (none)                                                                   | NONE   | No Arch-AI awareness.                                                     |

### 1.5 GOVERN

| Menu item  | Route                              | Sub-resources                                 | Arch-AI specialist(s) | Arch-AI tool(s) | Score  | Notes                                                                                                  |
| ---------- | ---------------------------------- | --------------------------------------------- | --------------------- | --------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Guardrails | `/projects/[id]/guardrails-config` | Content moderation tiers, thresholds          | abl-construct-expert  | — (indirect)    | READ ★ | Tier-1 `content_safety` auto-injected by Scaffold; project-level config not configurable from Arch-AI. |
| Governance | `/projects/[id]/governance`        | Policies, audit log, breach override, CSV/PDF | — (none)              | — (none)        | NONE   | Runtime exposes full `/governance/*` API; Arch-AI does not consume.                                    |

### 1.6 INSIGHTS

| Menu item               | Route                                    | Sub-resources                          | Arch-AI specialist(s) | Arch-AI tool(s)                                       | Score  | Notes                                                             |
| ----------------------- | ---------------------------------------- | -------------------------------------- | --------------------- | ----------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| Dashboard               | `/projects/[id]/dashboard`               | KPI cards, recent activity             | observer              | `read_insights` (overview action)                     | READ ★ |                                                                   |
| Analytics               | `/projects/[id]/analytics`               | Volume, completion, latency trends     | observer              | `read_insights`, `analytics_ops` (metrics, anomalies) | READ ★ | `intents` + `quality_scores` actions are NOT_IMPLEMENTED stubs.   |
| Billing                 | `/projects/[id]/billing`                 | Token cost, quota                      | — (none)              | — (none)                                              | NONE   |                                                                   |
| Agent Performance       | `/projects/[id]/agent-performance`       | Per-agent latency / success / quality  | observer              | `read_insights` (agent_performance)                   | READ ★ |                                                                   |
| Quality Monitor         | `/projects/[id]/quality-monitor`         | Real-time quality, alerts              | observer              | `read_insights` (quality)                             | READ   |                                                                   |
| Customer Insights       | `/projects/[id]/customer-insights`       | Sentiment, satisfaction                | observer              | `read_insights` (sentiment)                           | READ   |                                                                   |
| Voice Analytics         | `/projects/[id]/voice-analytics`         | Call duration, success                 | — (none)              | — (none)                                              | NONE   |                                                                   |
| Agent Transfer Insights | `/projects/[id]/agent-transfer-insights` | Handoff rates, resolution times        | — (none)              | — (none)                                              | NONE   |                                                                   |
| Pipelines               | `/projects/[id]/pipelines`               | Pipeline authoring (5 node categories) | — (none)              | — (none)                                              | NONE   | Same gap as Workflows — authoring surface not exposed to Arch-AI. |

### 1.7 SETTINGS

> Settings has 22 subpages — listed individually because Arch-AI coverage varies enormously across them.

| Subpage                 | Route fragment                 | Sub-resources                             | Arch-AI tool(s)                      | Score  | Notes                                                                                          |
| ----------------------- | ------------------------------ | ----------------------------------------- | ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| Members                 | `settings/members`             | Role assignment                           | — (none)                             | NONE   |                                                                                                |
| API Keys                | `settings/api-keys`            | Project API keys                          | — (none)                             | NONE   |                                                                                                |
| Models                  | `settings/models`              | Tenant/project model overrides            | `recommend_model`, `configure_model` | CONFIG | Doesn't touch agent's `EXECUTION:` block (overrides live in `ProjectModelConfig` out-of-band). |
| Runtime Config          | `settings/runtime-config`      | Fillers, timeouts, circuit breakers       | — (none)                             | NONE   |                                                                                                |
| Config Variables        | `settings/config-vars`         | Env-scoped variables                      | `variable_ops` (6 actions)           | FULL   |                                                                                                |
| Localization            | `settings/localization`        | Language, TZ, locale                      | — (none)                             | NONE   |                                                                                                |
| Git Integration         | `settings/git`                 | GitHub connect, branch protection         | — (none)                             | NONE   |                                                                                                |
| Auth Profiles           | `settings/auth-profiles`       | api_key, bearer, oauth2_app, oauth2_cc    | `auth_ops` (6 actions)               | CONFIG | Only 4 of 7 types — missing `oauth2_user`, `mtls`, `aws_sigv4`, custom.                        |
| Behavior Profiles       | `settings/profiles`            | Persona, tone, fallback                   | — (none)                             | NONE ★ | `BEHAVIOR_PROFILE` is an ABL construct but no Scaffold/prompt teaching.                        |
| Alerts                  | `settings/alerts`              | Alert rules, channels                     | — (none)                             | NONE   |                                                                                                |
| Agent Transfer          | `settings/agent-transfer`      | HITL timeouts, escalation policy          | — (none)                             | NONE   |                                                                                                |
| Agent Assist            | `settings/agent-assist`        | Suggestion config                         | — (none)                             | NONE   |                                                                                                |
| PII Protection          | `settings/pii-protection`      | Masking rules                             | — (none)                             | NONE   |                                                                                                |
| Public API              | `settings/public-api`          | Public endpoint exposure                  | — (none)                             | NONE   |                                                                                                |
| Attachments             | `settings/attachments`         | Upload limits                             | — (none)                             | NONE   |                                                                                                |
| Omnichannel             | `settings/omnichannel`         | Cross-channel context                     | — (none)                             | NONE   |                                                                                                |
| Templates               | `settings/templates`           | Starter kits                              | — (none)                             | NONE   |                                                                                                |
| Imported Modules        | `settings/module-dependencies` | Code modules                              | — (none)                             | NONE   |                                                                                                |
| Module Publishing       | `settings/modules`             | Publish/version modules                   | — (none)                             | NONE   |                                                                                                |
| Trace Dimensions        | `settings/trace-dimensions`    | Observable trace attributes               | — (none)                             | NONE   |                                                                                                |
| Advanced                | `settings/advanced`            | Experimental flags                        | — (none)                             | NONE   |                                                                                                |
| Project Config (header) | (multi)                        | Name, description, entry agent, retention | `project_config`                     | CONFIG | 4 actions; entry agent + retention covered.                                                    |

### 1.8 ARCH (entry points to arch-ai itself)

| Surface            | Location                                          | Description                                     | Coverage notes                            |
| ------------------ | ------------------------------------------------- | ----------------------------------------------- | ----------------------------------------- |
| In-project overlay | `components/navigation/AppShell.tsx:443–459, 604` | Arch-AI v4 overlay opened from project header   | `ArchV4Overlay`, store: `useArchAIStore`. |
| Standalone page    | `/arch` → `ArchV3Page`                            | Full-screen v0.3 (onboarding) experience        | Mode = ONBOARDING.                        |
| Admin settings     | `/admin/arch` → `ArchSettingsPage`                | Workspace-level config                          | Workspace, not project-scoped.            |
| Evals integration  | Quality heatmaps → `openOverlay()` button         | Request Arch-AI improvement from analytics view | Bridges Insights → Arch-AI overlay.       |

### 1.9 Non-project (workspace) surfaces

| Menu                      | Route                    | Score | Notes                                           |
| ------------------------- | ------------------------ | ----- | ----------------------------------------------- |
| Academy                   | `/academy/*`             | N/A   | Learning content; not arch-ai's responsibility. |
| Docs                      | `/docs/*`                | N/A   | Static documentation.                           |
| Onboarding                | `/onboarding`            | FULL  | Arch-AI is the entire onboarding flow.          |
| Auth flows                | `/auth/*`                | N/A   | Identity, not arch-ai.                          |
| OAuth                     | `/oauth/*` (3 callbacks) | N/A   | Auth callback receivers, not arch-ai.           |
| Softphone Automation      | `/softphone-automation`  | NONE  | Voice testing harness; no arch-ai integration.  |
| Preview / Preview-LiveKit | `/preview*`              | N/A   | Channel preview iframes.                        |
| Health                    | `/health/*`              | N/A   | Liveness/readiness endpoints.                   |
| Invite                    | `/invite/[token]`        | N/A   | Member invite acceptance.                       |

### 1.10 Coverage score (method)

Weight each leaf row in [§1.1](#11-build)–[§1.7](#17-settings) by importance (default = 1; high-frequency authoring surfaces like Agents and Tools = 2). Compute:

```
coverage = ( Σ score × weight ) / ( 3 × Σ weight )
```

where FULL = 3, CONFIG = 2, READ = 1, NONE = 0. `N/A` rows excluded from numerator and denominator.

| Section            |   Rows | FULL | CONFIG | READ | NONE | Coverage                   |
| ------------------ | -----: | ---: | -----: | ---: | ---: | -------------------------- |
| BUILD              |      3 |    0 |      1 |    1 |    1 | 33 %                       |
| RESOURCES          |      5 |    1 |      3 |    0 |    1 | 53 %                       |
| EVALUATE           |      2 |    0 |      1 |    0 |    1 | 33 %                       |
| OPERATE            |      4 |    0 |      1 |    1 |    2 | 25 %                       |
| GOVERN             |      2 |    0 |      0 |    1 |    1 | 17 %                       |
| INSIGHTS           |      9 |    0 |      0 |    5 |    4 | 19 %                       |
| SETTINGS           |     22 |    1 |      3 |    0 |   18 | 14 %                       |
| ARCH               |      — |    — |      — |    — |    — | (n/a, surface, not target) |
| **Weighted total** | **47** |      |        |      |      | **38 %**                   |

---

## 2. Runtime surface

> Source of truth: `apps/runtime/src/server.ts:927–1274`, `apps/runtime/src/routes/`.

### 2.1 Route families

| Family                      | Example routes                                                                       | Consumer                  | Arch-AI exercises?                         | Score  | Notes                                                           |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------ | ------ | --------------------------------------------------------------- |
| Chat / Voice                | `POST /api/v1/chat`, `POST /api/v1/voice`                                            | SDK / Studio              | indirect (via runtime simulate)            | READ   | Arch-AI uses `run_simulation` which goes through these paths.   |
| Sessions                    | `GET/POST /api/projects/:p/sessions/*`                                               | Studio / SDK              | yes (`session_ops`)                        | CONFIG | Read + close; no resume/replay write actions.                   |
| Simulate / Eval             | `POST /api/projects/:p/runtime/simulate`                                             | Studio (eval)             | yes (`run_simulation`)                     | FULL   | Scripted turns + mocked tool responses end-to-end.              |
| Workflows                   | `GET/POST /api/projects/:p/workflows`, `POST /api/workflows/:id/execute`             | Studio / SDK              | NO                                         | NONE   | Authoring + execution surface fully outside arch-ai.            |
| Governance / Audit          | `GET /governance/*`, `POST /governance/policies`                                     | Studio                    | NO                                         | NONE   | Full API exists; arch-ai does not surface any of it.            |
| Internal Tools              | `POST /api/internal/tools/execute`                                                   | Inter-service             | yes (`tools_ops:test`)                     | CONFIG | Used as test executor; not for production wiring.               |
| Project I/O (lookup tables) | `POST /api/projects/:p/project-io/lookup-tables`                                     | Studio                    | NO                                         | NONE   |                                                                 |
| Connections / OAuth         | `POST /api/projects/:p/connections`, `POST /api/v1/channel-oauth`                    | Studio / external         | partial (`connection_ops`)                 | CONFIG | Read+create; full lifecycle gaps.                               |
| Agents (CRUD + versions)    | `/api/projects/:p/agents`, `/agents/:n/versions`, `/agents/:n/model-config`          | Studio                    | yes (`agent_ops`, `configure_model`)       | FULL   | Most mature arch-ai surface.                                    |
| Deployments                 | `/api/projects/:p/deployments`                                                       | Studio                    | yes (`deployment_ops`)                     | CONFIG | Deploy/promote/list. Rollback unavailable.                      |
| Channel adapters (46)       | `POST /api/v1/channels/{vxml,genesys,ai4w,http-async,…}`                             | External / channels       | NO                                         | NONE   | Inbound channel webhooks. Arch-AI does not configure/test them. |
| Internal MCP                | `POST /api/internal/mcp/reset-project-init`                                          | Studio (inter)            | indirect                                   | READ   | `mcp_server_ops` invalidates cache via this.                    |
| Platform Admin              | `GET/POST /api/platform/admin/*`                                                     | Platform admin            | NO                                         | N/A    | Out of scope.                                                   |
| WebSocket (SDK / chat)      | `WS /api/v1/{sdk,chat}`                                                              | SDK / web                 | NO                                         | NONE   |                                                                 |
| Analytics                   | `POST /api/projects/:p/analytics`, `GET /voice-analytics`, `GET /pipeline-analytics` | Studio / runtime internal | partial (`analytics_ops`, `read_insights`) | READ   | `intents` + `quality_scores` actions stubbed.                   |
| Agent transfer / CSAT       | `/agent-transfer/*`                                                                  | Studio / channels         | NO                                         | NONE   |                                                                 |
| Memory API                  | semantic ops                                                                         | runtime intra             | indirect (`manage_memory`)                 | CONFIG | Session-scope memory CRUD via `manage_memory` (3 actions).      |

### 2.2 Subsystems

(For depth, see runtime audit Section 2.)

| Subsystem              | Arch-AI awareness | Notes                                                                                 |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| execution (91 files)   | indirect          | Arch-AI generates ABL → compiler → runtime executes. No direct tool.                  |
| session                | CONFIG            | `session_ops` (3 actions): list, get, close.                                          |
| channels/adapters (46) | NONE              | Inbound channel adapters opaque to arch-ai. Big gap given 22 channel types in Studio. |
| llm                    | CONFIG            | `recommend_model` + `configure_model`; tenant policy not modifiable from arch-ai.     |
| auth-profile           | CONFIG            | `auth_ops` covers 4 of 7 types.                                                       |
| tools                  | FULL              | `tools_ops`, `mcp_server_ops`.                                                        |
| audit (10 files)       | NONE              | Runtime audit emission untouched by arch-ai (separate from arch-ai's own audit log).  |
| event-bus              | NONE              |                                                                                       |
| agent-assist           | NONE              |                                                                                       |
| channel-oauth          | partial           | Connection callback URLs constructed; full lifecycle gaps.                            |
| agent-transfer         | NONE              | HITL handoff config not surfaced.                                                     |
| contacts               | NONE              |                                                                                       |
| traces                 | READ              | `query_traces`, `trace_diagnosis`.                                                    |
| mcp                    | CONFIG            | `mcp_server_ops` (10 actions).                                                        |
| memory-api             | CONFIG            | `manage_memory` (3 actions).                                                          |
| governance-audit       | NONE              |                                                                                       |
| diagnostics analyzers  | READ              | Read via `validate_agent`, `diagnose_project`, `health_check`.                        |

**Runtime coverage**: 6 subsystems with CONFIG-or-better / 17 = **35 %**.

---

## 3. Arch-AI specialist inventory

### 3.1 Specialists (12)

| Specialist                        | File                                               | Mode                   | Phase(s)             | Output                         | Status                                  |
| --------------------------------- | -------------------------------------------------- | ---------------------- | -------------------- | ------------------------------ | --------------------------------------- |
| onboarding                        | `prompts/specialists/onboarding.ts`                | ONBOARDING             | INTERVIEW, CREATE    | Specification + create_project | LIVE                                    |
| multi-agent-architect             | `prompts/specialists/multi-agent-architect.ts`     | ONBOARDING             | BLUEPRINT            | TopologyOutput                 | LIVE                                    |
| abl-construct-expert              | `prompts/specialists/abl-construct-expert.ts`      | ONBOARDING, IN_PROJECT | BUILD, IN_PROJECT    | AgentSpec (ABL YAML)           | LIVE                                    |
| diagnostician                     | `prompts/specialists/diagnostician.ts`             | IN_PROJECT             | IN_PROJECT           | DiagnosticReport               | LIVE                                    |
| integration-methodologist         | `prompts/specialists/integration-methodologist.ts` | IN_PROJECT             | IN_PROJECT           | ProjectTool + auth             | LIVE                                    |
| testing-eval                      | `prompts/specialists/testing-eval.ts`              | IN_PROJECT             | IN_PROJECT           | TestResult                     | LIVE                                    |
| channel-voice                     | `prompts/specialists/channel-voice.ts`             | IN_PROJECT             | IN_PROJECT           | ChannelConfig                  | **THIN** (19 lines, no syntax teaching) |
| entity-collection                 | `prompts/specialists/entity-collection.ts`         | IN_PROJECT             | IN_PROJECT           | GatherSpec                     | LIVE                                    |
| analyst                           | `prompts/specialists/analyst.ts`                   | IN_PROJECT             | IN_PROJECT           | AnalysisReport                 | LIVE                                    |
| observer                          | `prompts/specialists/observer.ts`                  | IN_PROJECT             | IN_PROJECT           | ProductionInsight              | LIVE                                    |
| in-project-architect (generalist) | `prompts/specialists/in-project-generalist.ts`     | IN_PROJECT             | IN_PROJECT (default) | Mixed                          | LIVE                                    |

### 3.2 Phases (5)

| Phase      | File                           | Trigger                          | Exit criterion                                       | Tool allow-list size |
| ---------- | ------------------------------ | -------------------------------- | ---------------------------------------------------- | -------------------- |
| INTERVIEW  | `prompts/phases/interview.ts`  | Mode=ONBOARDING, phase=INTERVIEW | spec.projectName + (description or channels or lang) | 5                    |
| BLUEPRINT  | `prompts/phases/blueprint.ts`  | EXIT(INTERVIEW)                  | `metadata.topologyApproved === true`                 | 4                    |
| BUILD      | `prompts/phases/build.ts`      | EXIT(BLUEPRINT)                  | All topology agents `compiled` or `warning`          | 6                    |
| CREATE     | `prompts/phases/create.ts`     | EXIT(BUILD)                      | `metadata.projectId` set                             | 2                    |
| IN_PROJECT | `prompts/phases/in-project.ts` | Mode=IN_PROJECT                  | n/a (stateless; specialist-routed)                   | ~60                  |

### 3.3 Knowledge cards (49)

| Folder             | Count | Coverage shape                                                                            |
| ------------------ | ----- | ----------------------------------------------------------------------------------------- |
| `cards/generated/` | 35    | ABL constructs, FLOW patterns, handoff/delegate, GATHER, memory, guardrails, tool binding |
| `cards/platform/`  | 13    | Channels, A2A, deployments, auth profiles, testing/evals                                  |
| `cards/expertise/` | 1     | (index only)                                                                              |

**Gaps**: 11 ABL constructs have no card (LIMITATIONS, MESSAGES, HOOKS, ACTION_HANDLERS, TEMPLATES, NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES, ATTACHMENTS, DESTINATIONS, BEHAVIOR_PROFILE, CONVERSATION). Per the May 5 audit, specialists almost never force-load their domain card.

### 3.4 Coordinator state

| Concept        | States                                                                               |
| -------------- | ------------------------------------------------------------------------------------ |
| Phase machine  | INTERVIEW → BLUEPRINT → BUILD → CREATE (forward); BUILD → BLUEPRINT (backtrack only) |
| Session states | IDLE, ACTIVE, COMPLETE, ARCHIVED (legacy GATE_PENDING auto-archived on load)         |

---

## 4. Arch-AI tool inventory

> Source of truth: `packages/arch-ai/src/tools/adapters/classification.ts:8–101` + `tools/schemas/in-project-schemas.ts`. Counts per the May 5 audit ([§2 of that doc](./wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md#2-crud-coverage-matrix)).

### 4.1 By phase

| Phase      | Tools                                                                                                        | Count |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| INTERVIEW  | `ask_user`, `collect_file`, `update_specification`, `proceed_to_next_phase`, `platform_context`              | 5     |
| BLUEPRINT  | `ask_user`, `collect_file`, `generate_topology`, `proceed_to_next_phase`                                     | 4     |
| BUILD      | `ask_user`, `collect_file`, `generate_agent`, `compile_abl`, `propose_modification`, `proceed_to_next_phase` | 6     |
| CREATE     | `ask_user`, `create_project`                                                                                 | 2     |
| IN_PROJECT | 60+ (see §4.2)                                                                                               | ~60   |

### 4.2 By category (IN_PROJECT)

| Category                   | Tools                                                                                                                                                                                                 | Count |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Read / query               | `read_journal`, `read_topology`, `get_topology_patterns`, `read_agent`, `read_insights`, `session_ops`, `trace_diagnosis`, `query_traces`                                                             | 8     |
| Reference lookup           | `find_memory_refs`, `find_gather_field_refs`, `find_tool_consumers`, `find_agent_refs`, `find_cel_var_refs`                                                                                           | 5     |
| Diagnostics                | `validate_agent`, `diagnose_project`, `explain_diagnostic`, `health_check`, `analyze_constraints`                                                                                                     | 5     |
| Operations (CRUD wrappers) | `tools_ops`, `mcp_server_ops`, `project_config`, `auth_ops`, `external_agent_ops`, `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops`, `variable_ops`, `integration_ops`, `connection_ops` | 12    |
| Knowledge spine            | `get_construct_spec`, `list_valid_combinations`, `get_cel_grammar`, `lookup_validation_code`, `search_docs`                                                                                           | 5     |
| Knowledge base             | `kb_manage`, `kb_search`, `kb_health`, `kb_ingest`, `kb_connector`, `kb_documents`, `kb_crawl`, `kb_schema`                                                                                           | 8     |
| Model                      | `recommend_model`, `configure_model`                                                                                                                                                                  | 2     |
| Test / simulate            | `run_test`, `run_simulation`                                                                                                                                                                          | 2     |
| Memory                     | `manage_memory`                                                                                                                                                                                       | 1     |
| Modification proposal      | `propose_plan`, `propose_modification`, `apply_modification`, `dismiss_proposal`, `save_tool_dsl`                                                                                                     | 5     |
| Interactive                | `ask_user`, `collect_file`, `collect_secret`                                                                                                                                                          | 3     |
| Platform context (read)    | `platform_context`                                                                                                                                                                                    | 1     |

**Total registered**: 68 (per classification.ts); **reachable in-project actions**: ~125 (per May 5 audit §2).

### 4.3 Drift / over-privilege flags

(Status verified 2026-05-05; re-check at refresh.)

| Flag                                                                                                                      | Status                                        |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Two `IN_PROJECT_SPECIALIST_TOOL_MAP` definitions disagree (types.ts vs build-tools.ts)                                    | drift-test in place; still duplicated         |
| `agent_ops` / `deployment_ops` / `testing_ops` / `analytics_ops` wired but unreachable                                    | **RESOLVED 2026-05-05** — all four registered |
| `onboarding` + `in-project-generalist` fall through to `abl-construct-expert` defaults                                    | open                                          |
| `propose_modification` / `apply_modification` gated only by `agent:read`; user confirmation is the de-facto write control | open                                          |
| `apply_modification` not in `DANGEROUS_ACTIONS` (relies on propose-then-apply UX)                                         | open                                          |

---

## 5. Authoring / generation coverage

### 5.1 Scaffold slots

| Slot                   | Generator                      | Validator                            |
| ---------------------- | ------------------------------ | ------------------------------------ |
| `goal`                 | `scaffold-generator.ts:33`     | length 20–500                        |
| `persona`              | `scaffold-generator.ts:38-46`  | length 100–2000                      |
| `handoff.<i>.when`     | `scaffold-generator.ts:48-65`  | no `{{…}}`, length 10–200            |
| `gather.<name>.ask`    | `scaffold-generator.ts:67-79`  | non-generic, ends `?`, length 20–300 |
| `complete.<i>.when`    | `scaffold-generator.ts:81-103` | declared-identifier check            |
| `complete.<i>.respond` | `assembler.ts:90-95`           | length ≤ 300                         |

**Code-owned**: `GUARDRAILS.content_safety` (input, tier 1, threshold 0.8); `MEMORY.session` auto-populated; HANDOFF `RETURN:true`; catch-all `WHEN:true`.

### 5.2 Cascade primitives

| Primitive                                                                                                               | Status                                             |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `cascadeHandoffRename`                                                                                                  | LIVE (regex over `TO:` + `Project.entryAgentName`) |
| GATHER field rename                                                                                                     | **GAP**                                            |
| GATHER field delete                                                                                                     | **GAP**                                            |
| Tool rename                                                                                                             | **GAP**                                            |
| Tool delete                                                                                                             | **GAP**                                            |
| Auth-profile rename                                                                                                     | **GAP**                                            |
| Channel rename / delete                                                                                                 | **GAP**                                            |
| Connector / KB delete                                                                                                   | **GAP**                                            |
| MEMORY.persistent rename                                                                                                | **GAP**                                            |
| Agent rename in DELEGATE / available_agents / action_handler.handoff / error_handler.handoff_target / routing rule `to` | **GAP**                                            |

### 5.3 ABL construct coverage

Per the May 5 audit ([§3.2](./wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md)):

| Construct                                                                           | Compiler | Scaffold           | Specialist prompt                        | Status       |
| ----------------------------------------------------------------------------------- | -------- | ------------------ | ---------------------------------------- | ------------ |
| GOAL, PERSONA, HANDOFF, GATHER, COMPLETE, MEMORY.session, GUARDRAILS.content_safety | ✓        | ✓                  | ✓                                        | covered      |
| LIMITATIONS                                                                         | ✓        | ✗                  | mention only                             | **GAP**      |
| TOOLS                                                                               | ✓        | ✗ (empty stub)     | ✓                                        | scaffold gap |
| CONSTRAINTS                                                                         | ✓        | ✗                  | ✓                                        | scaffold gap |
| FLOW / STEPS                                                                        | ✓        | ✗                  | ✓                                        | scaffold gap |
| DELEGATE                                                                            | ✓        | ✗                  | partial                                  | **GAP**      |
| ESCALATE (top-level)                                                                | ✓        | ✗                  | partial                                  | **GAP**      |
| ON_ERROR / ON_START                                                                 | ✓        | ✗                  | partial                                  | **GAP**      |
| EXECUTION                                                                           | ✓        | ✗                  | "do not emit" (DRIFT — catalog says yes) | **DRIFT**    |
| MESSAGES                                                                            | ✓        | ✗                  | ✗                                        | **GAP**      |
| HOOKS, ACTION_HANDLERS, TEMPLATES                                                   | ✓        | ✗                  | ✗                                        | **GAP**      |
| NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES                                          | ✓        | ✗                  | ✗                                        | **GAP**      |
| ATTACHMENTS, DESTINATIONS                                                           | ✓        | ✗                  | ✗                                        | **GAP**      |
| BEHAVIOR_PROFILE                                                                    | ✓        | ✗                  | ✗                                        | **GAP**      |
| CONVERSATION (voice)                                                                | ✓        | ✗                  | ✗ (channel-voice.ts is 19 lines)         | **GAP**      |
| MEMORY.persistent / .recall / .remember                                             | ✓        | session only       | ✓                                        | scaffold gap |
| GATHER.type beyond `string`                                                         | ✓        | hardcoded `string` | ✓                                        | scaffold gap |

**13 IR-level constructs** have neither Scaffold nor specialist-prompt teaching. **6 of 19** constructs are fully covered. Scaffold construct coverage = **32 %**.

### 5.4 Cross-agent validator

`apps/studio/src/lib/arch-ai/cross-agent-validator.ts` checks 4 things only:

1. `missing_handoff_target` (error)
2. `missing_delegate_return` (warning)
3. `orphan_agent` (warning, BFS reachability)
4. `abl_routing_mismatch` (error)

**Gaps**: tool contention across agents; MEMORY.persistent path collisions; CONTEXT.pass field declarations across handoffs; channel routing / supervisor routing-config consistency; BEHAVIOR_PROFILE name uniqueness.

---

## 6. Diagnostic & feasibility coverage

### 6.1 Diagnostic rule codes

| Aspect               | Value                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rule codes shipped   | 77                                                                                                                                                                 |
| Prompt-advertised    | 53 (**drift**)                                                                                                                                                     |
| Fix templates        | 20 (57 codes ship description-only)                                                                                                                                |
| Validator categories | 18 (handoff, delegation, completion, flow, constraint, guardrail, tool, gather, memory, execution, routing, behavior-profile, template, pattern, naming, other, …) |

### 6.2 Feasibility checks (5)

| Name                    | Severity |
| ----------------------- | -------- |
| empty-response          | warning  |
| tool-binding            | warning  |
| voice-model-feasibility | warning  |
| provider-allowlist      | warning  |
| memory-scope-identity   | warning  |

All findings are warning-level (no error-blocker).

### 6.3 Audit categories (8)

`llm_call`, `tool_execution`, `phase_transition`, `user_action`, `build_event`, `editor_mode_event`, `error`, `system_event`. Severity: info / warning / error / critical. Span kinds: phase / turn / llm_call / tool_call.

---

## 7. Improvement queue (pick from this list)

> Items are tagged P0 (next sprint) / P1 (next quarter) / P2 (backlog). Move items to "Done" with a PR or commit reference when shipped, then keep them here for traceability.

### P0 — high impact, near-term

| #    | Title                                                     | Surface                | Estimated scope                            | Why                                                                     |
| ---- | --------------------------------------------------------- | ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| P0-1 | **Workflow node generator + tool**                        | Studio Workflows       | Medium (1 specialist, 1 tool, 1 generator) | 23 node types fully un-served by arch-ai. Massive UX gap.               |
| P0-2 | **Channel CRUD + agent↔channel binding**                  | Settings + Deployments | Medium                                     | 22 channel types in Studio, arch-ai has list-only.                      |
| P0-3 | **Auth-profile types: oauth2_user, mtls, aws_sigv4**      | Settings/Auth-profiles | Small                                      | Currently 4 of 7 types supported.                                       |
| P0-4 | **Cascade primitives for GATHER + Tools + Agent renames** | Authoring              | Small–Medium                               | Today only handoff rename cascades; rest leak as new errors post-apply. |
| P0-5 | **Scaffold coverage for TOOLS, FLOW, CONSTRAINTS**        | Authoring              | Medium                                     | These are common but rely on free-form LLM.                             |

### P1 — meaningful coverage gains

| #    | Title                                                                                                                                           | Surface            | Notes                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------- |
| P1-1 | **Eval Phase 2** — write scenarios, datasets, comparisons                                                                                       | Evaluate           | Today only Phase 1 (name + desc).         |
| P1-2 | **Pipeline node generator** (5 categories)                                                                                                      | Insights/Pipelines | Mirror of workflow generator.             |
| P1-3 | **KB connector lifecycle** — `discover`, `recommend`, `quick_setup`, `sync_stop`, `sync_restart`, `permissions`, `filters`, `delta_token_reset` | KB                 | Studio API exists; arch-ai not wrapped.   |
| P1-4 | **Cross-agent validator extensions** — tool contention, MEMORY.persistent collisions, CONTEXT.pass declarations                                 | Authoring          | Big quality bump for multi-agent systems. |
| P1-5 | **Fix templates for the 57 description-only diagnostic codes**                                                                                  | Diagnostics        | Direct improvement to fix-first UX.       |
| P1-6 | **Specialist tool-map drift removal** — single source of truth                                                                                  | Internal hygiene   | Drift test passes today, but duplicated.  |
| P1-7 | **Channel-voice specialist hardening** — currently 19 lines, no syntax                                                                          | Channels/Voice     | Big gap for voice-first projects.         |

### P2 — backlog / depends on other roadmaps

| #    | Title                                             | Surface           | Notes                                                                                                                                                            |
| ---- | ------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | Governance/policies tool                          | Govern            | Wraps Runtime `/governance/*` already complete.                                                                                                                  |
| P2-2 | Behavior profile authoring                        | Settings/Behavior | New ABL construct + Scaffold + card.                                                                                                                             |
| P2-3 | Remote A2A handoff with RETURN:true               | External Agents   | Spec-2 design needed.                                                                                                                                            |
| P2-4 | Knowledge cards for the 13 missing ABL constructs | Knowledge         | LIMITATIONS, MESSAGES, HOOKS, ACTION_HANDLERS, TEMPLATES, NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES, ATTACHMENTS, DESTINATIONS, BEHAVIOR_PROFILE, CONVERSATION. |
| P2-5 | Alert / Quality Monitor / Voice Analytics tools   | Insights          | Read-side; downstream of trace dimensions.                                                                                                                       |
| P2-6 | Public API / module publishing tools              | Settings          | Niche.                                                                                                                                                           |
| P2-7 | Trace dimension authoring                         | Settings          | Touches observability — coordinate with traces team.                                                                                                             |
| P2-8 | Streaming agent code generation                   | Authoring         | Today buffered; UX win.                                                                                                                                          |
| P2-9 | Cross-session learning memory indexing            | Memory            | Storage exists; indexing not built.                                                                                                                              |

### Done (kept for traceability)

| #   | Title                                                                         | PR / commit                                      |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| D-1 | Wire `agent_ops`/`deployment_ops`/`testing_ops`/`analytics_ops` (May 5, 2026) | `wip/2026-05-05-wire-unregistered-tools-plan.md` |

---

## 8. How a user request maps to Arch-AI capability

> Sanity check: for any natural-language request, this table answers "what does Arch-AI do today?".

| User intent                                  | Today's route                              | Score  | Pickup    |
| -------------------------------------------- | ------------------------------------------ | ------ | --------- |
| "Build me an agent that does X"              | onboarding → blueprint → build             | FULL   | covered   |
| "Add a Slack channel to this project"        | (no tool) — user opens Studio              | NONE   | P0-2      |
| "Make this agent call our /orders API"       | `tools_ops` + `integration_methodologist`  | FULL   | covered   |
| "Connect Google Drive as a knowledge source" | `kb_connector` (limited)                   | CONFIG | P1-3      |
| "Create an eval scenario for billing"        | `testing_ops:create_eval` (name+desc only) | CONFIG | P1-1      |
| "Build a workflow that nightly emails X"     | (no tool)                                  | NONE   | P0-1      |
| "Why are escalations up this week?"          | observer + `read_insights`                 | READ ★ | covered   |
| "Roll back the agent to last week"           | (no rollback executor)                     | NONE   | P0-2 / P1 |
| "Configure mTLS auth for the bank API"       | (auth_ops doesn't support mtls)            | NONE   | P0-3      |
| "Add an alert when CSAT drops below 4"       | (no tool)                                  | NONE   | P2-5      |

---

## 9. Recommended skill

> Yes — add a skill. The doc is structured so a refresh is mechanical; the skill makes that refresh a one-command operation.

### 9.1 Skill: `arch-capability-refresh`

**Location**: `.claude/skills/arch-capability-refresh/SKILL.md` (alongside `data-flow-audit`, `lld`, `feature-spec`, etc.).

**Description (frontmatter)**:

> Refresh `packages/arch-ai/docs/arch-capability-metrics.md`. Re-inventories Studio menus, Runtime APIs, and Arch-AI specialists/tools/cards; re-scores every row with the NONE/READ/CONFIG/FULL legend; recomputes the weighted coverage score; updates the TL;DR snapshot; demotes shipped items from the improvement queue. Use after major Arch-AI PRs, before sprint planning, or quarterly.

**Required behavior (skill body, abridged)**:

1. Read the existing `arch-capability-metrics.md` to capture the "previous version" coverage numbers (for diff).
2. Inventory the Studio sidebar (`apps/studio/src/components/navigation/ProjectSidebar.tsx`) by reading the nav arrays; emit a flat list of `route + label`.
3. Inventory `apps/runtime/src/server.ts` route mounts; emit a flat list of `method + path + consumer`.
4. Inventory `packages/arch-ai/src/prompts/specialists/`, `prompts/phases/`, `tools/adapters/classification.ts`, `knowledge/cards/`; emit counts.
5. Cross-reference each Studio row against the arch-ai tool map (built from `IN_PROJECT_SPECIALIST_TOOL_MAP` + `classification.ts`); compute score using the legend.
6. Recompute the weighted coverage formula in [§1.10](#110-coverage-score-method); update TL;DR.
7. Write back the doc; show a diff of the "Score" column changes vs previous version.
8. If any P0/P1 items in [§7](#7-improvement-queue-pick-from-this-list) are now FULL, move them to "Done" and require the user supply the PR/commit reference.

**Why a skill (vs ad-hoc)**:

- Refresh involves reading ~6 source-of-truth files and applying a deterministic scoring legend. That's exactly what a skill is for: encoding the recipe so it doesn't drift.
- The scoring legend is the load-bearing part. A skill keeps it pinned next to the doc and ensures every refresh applies the same rubric.
- We will want to track the coverage score over time. A skill can emit a one-line metric (`coverage=38%` → `coverage=47%`) into commit messages.

### 9.2 Optional second skill (later): `arch-capability-spec`

When we pick an improvement-queue item to ship, we'll want a structured spec for it (new specialist? new tool? new card? scaffold extension?). A small skill `arch-capability-spec` could generate that spec from a row-id in [§7](#7-improvement-queue-pick-from-this-list). Don't add this yet — wait until we've shipped 2–3 items the manual way and have a feel for the recurring spec shape.

---

## References & source of truth

| Topic                               | Path                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Companion narrative audit (deep)    | `packages/arch-ai/docs/wip/2026-05-05-arch-ai-capabilities-and-gaps-audit.md`     |
| Tool wiring (May 5)                 | `packages/arch-ai/docs/wip/2026-05-05-wire-unregistered-tools-spec.md`            |
| In-project update-flow audit        | `packages/arch-ai/docs/wip/2026-05-05-in-project-update-flow-audit.md`            |
| Arch-AI overall design              | `packages/arch-ai/docs/DESIGN.md`                                                 |
| Studio sidebar (nav SoT)            | `apps/studio/src/components/navigation/ProjectSidebar.tsx:103-252`                |
| Studio AppShell                     | `apps/studio/src/components/navigation/AppShell.tsx:656-904`                      |
| Studio agent editor sections        | `apps/studio/src/components/agent-editor/AgentEditor.tsx:43-71`                   |
| Tool types                          | `apps/studio/src/components/tools/shared-types.ts`                                |
| Workflow node types                 | `packages/shared-kernel/src/types/workflow-types.ts:20-42`                        |
| Channel types                       | `apps/studio/src/api/channel-connections.ts:53-74`                                |
| SearchAI connector catalog (88)     | `apps/studio/src/components/search-ai/data/connector-catalog-registry.ts:68-100+` |
| Runtime route mounts                | `apps/runtime/src/server.ts:927-1274`                                             |
| Runtime simulate                    | `apps/runtime/src/routes/simulate.ts:135-322`                                     |
| Runtime governance                  | `apps/runtime/src/routes/governance.ts:76-200`                                    |
| Arch-AI tool classification         | `packages/arch-ai/src/tools/adapters/classification.ts:8-101`                     |
| Arch-AI tool schemas                | `packages/arch-ai/src/tools/schemas/in-project-schemas.ts`                        |
| Arch-AI specialist tool map (SoT)   | `packages/arch-ai/src/types/tools.ts:115`                                         |
| Arch-AI Studio tool map (duplicate) | `apps/studio/src/lib/arch-ai/tools/build-tools.ts:50`                             |
| Arch-AI phase machine               | `packages/arch-ai/src/coordinator/phase-machine.ts`                               |
| Arch-AI session-state machine       | `packages/arch-ai/src/coordinator/session-state-machine.ts`                       |
| Arch-AI scaffold (Studio)           | `apps/studio/src/lib/arch-ai/scaffold/`                                           |
| Arch-AI cross-agent validator       | `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`                            |
| Diagnostic engine                   | `packages/arch-ai/src/diagnostics/diagnostic-engine.ts`                           |
| Semantic validators                 | `packages/arch-ai/src/diagnostics/semantic-validators.ts`                         |
| Knowledge cards                     | `packages/arch-ai/src/knowledge/cards/`                                           |
