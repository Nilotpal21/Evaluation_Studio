# Arch-AI Capabilities & Gaps — Audit

**Date:** 2026-05-05
**Branch:** develop
**Status:** WIP — draft for review
**Scope:** Live arch-ai code only. The previous plugin-based architecture (`packages/arch-ai/dist/plugins/`, `registerOnboardingPlugins`) has been discarded and is NOT counted as a capability in this audit.

---

## TL;DR

- **~125 reachable IN_PROJECT actions** across **40 tools** — toolbox is broader than commonly credited.
- ~~Significant pieces are wired in code yet unreachable from the LLM~~ — RESOLVED in [wire-unregistered-tools-spec.md](./2026-05-05-wire-unregistered-tools-spec.md). All 4 tools (`agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops`) are now registered. ~125 reachable IN_PROJECT actions (was ~111).
- Authoring is **structurally narrow**: Scaffold emits 6 slots; ~13 IR-level constructs have no Scaffold coverage AND no specialist-prompt teaching.
- Diagnostics: **77 rule codes** (prompt advertises 53 — drift) but **only 20 fix templates** — 57 codes ship description-only.
- "Fix opens new problem" loop has _partial_ protection (apply-time before/after diff) but four root-cause leaks.
- **30 knowledge cards** ship; 11 IR types uncovered; specialists almost never force-load their domain card.

---

## Glossary

These terms are used consistently throughout the doc.

| Term              | Meaning                                                                                                   | Reference                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Construct**     | A top-level ABL block (`GOAL`, `GATHER`, `HANDOFF`, `CONSTRAINTS`, `BEHAVIOR_PROFILE`, etc.)              | parser `knownSections`                                                                                      |
| **Scaffold**      | Deterministic, Studio-side authoring with Zod schemas + per-slot validators + assembler. Slot-by-slot.    | [apps/studio/src/lib/arch-ai/scaffold/](apps/studio/src/lib/arch-ai/scaffold/)                              |
| **Slot**          | A single LLM-filled field inside Scaffold (e.g., `gather.refund_id.ask`)                                  | [scaffold/scaffold-generator.ts](apps/studio/src/lib/arch-ai/scaffold/scaffold-generator.ts)                |
| **LLM authoring** | LLM specialist writes ABL freely using prompt + card knowledge, commits via `propose_modification`        | [packages/arch-ai/src/prompts/specialists/](packages/arch-ai/src/prompts/specialists/)                      |
| **Specialist**    | A named LLM persona with its own prompt + tool allow-list (`abl-construct-expert`, `diagnostician`, etc.) | [packages/arch-ai/src/types/tools.ts:115](packages/arch-ai/src/types/tools.ts)                              |
| **Card**          | Knowledge artifact loaded into specialist context at runtime                                              | [packages/arch-ai/src/knowledge/cards/generated/](packages/arch-ai/src/knowledge/cards/generated/)          |
| **Validator**     | Code that rejects bad ABL — slot-level (Scaffold), Tier 1/2/3 (diagnostics), runtime analyzer             | various                                                                                                     |
| **Cascade**       | Mechanical rewrite of dependent references when something is renamed/deleted                              | [in-project-tools.ts:526](apps/studio/src/lib/arch-ai/tools/in-project-tools.ts:526) `cascadeHandoffRename` |
| **Cascade plan**  | Structured `{ primary, dependents[], rationale, risks }` returned to the LLM for user review              | new (proposed §8)                                                                                           |

When this doc says "Construct X is authored via Scaffold", it means slots + validators + assembler. When it says "authored via LLM", it means prompt + card + `propose_modification`.

---

## 1. Code locations

| Component                    | Path                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| In-project tools             | `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts` (composes `buildBuildTools` + project-aware tools)                                     |
| Tool wiring                  | `app/api/arch-ai/message/route.ts` → `processors/process-in-project.ts:328`                                                                    |
| Specialist↔tool map          | `packages/arch-ai/src/types/tools.ts:115` (authoritative) — duplicated at `apps/studio/src/lib/arch-ai/tools/build-tools.ts:50` (display copy) |
| Permission map               | `apps/studio/src/lib/arch-ai/guards.ts`                                                                                                        |
| Scaffold path                | `apps/studio/src/lib/arch-ai/scaffold/` (Ring 1 Zod, Ring 2 slot-validators, Ring 3 compile)                                                   |
| Specialist prompts           | `packages/arch-ai/src/prompts/specialists/*.ts`                                                                                                |
| Phase prompts                | `packages/arch-ai/src/prompts/phases/*.ts`                                                                                                     |
| Diagnostic engine            | `packages/arch-ai/src/diagnostics/diagnostic-engine.ts`                                                                                        |
| Semantic validators          | `packages/arch-ai/src/diagnostics/semantic-validators.ts` (1737 LoC)                                                                           |
| Compiler IR validators       | `packages/compiler/src/platform/ir/validate-*.ts`                                                                                              |
| Studio cross-agent validator | `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`                                                                                         |
| Runtime analyzers            | `apps/runtime/src/services/diagnostics/analyzers/` (7 files)                                                                                   |
| Knowledge cards              | `packages/arch-ai/src/knowledge/cards/generated/` (30 files) + `cards/_mapping.ts` + `card-router.ts`                                          |
| Studio handbook              | `apps/studio/src/lib/arch-ai/handbook-reference.ts:204+`                                                                                       |
| Card generator pipeline      | `tools/abl-docs/card-generator.ts` + `card-mapping.ts`                                                                                         |

---

## 2. CRUD coverage matrix

(Source: live in-project tool registration in `in-project-tools.ts:1080-2940`)

| Domain                   | Create                                                                          | Read                                                                | Update                                               | Delete                                                         | Test/Verify                                                 | Notes                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents                   | ✓ via `agent_ops` + propose+apply                                               | ✓                                                                   | ✓ via `agent_ops` + propose+apply                    | ✓ via `agent_ops` (RESOLVED)                                   | compile_abl, validate_agent, health_check, diagnose_project | RESOLVED — direct CRUD now reachable via `agent_ops` (read, list, create, modify, compile, delete with confirmation, propose_modification).                                                                                                                       |
| Tools (HTTP/sandbox/MCP) | ✓                                                                               | ✓                                                                   | ✓                                                    | ✓                                                              | test                                                        | Full CRUD via `tools_ops`. MCP setup separate via `mcp_server_ops` (10 actions).                                                                                                                                                                                  |
| Auth profiles            | ✓                                                                               | ✓                                                                   | ✓                                                    | ✓                                                              | validate                                                    | Only 4 types: `api_key`, `bearer`, `oauth2_app`, `oauth2_client_credentials`. **GAP**: no `oauth2_user`, `mtls`, `aws_sigv4`, custom.                                                                                                                             |
| Variables / namespaces   | ✓                                                                               | ✓                                                                   | ✓                                                    | ✓                                                              | –                                                           | env + config; `link_namespace` action.                                                                                                                                                                                                                            |
| Knowledge bases          | ✓                                                                               | ✓                                                                   | ✓                                                    | ✓                                                              | search, health                                              | Full via `kb_manage`, `kb_ingest`, `kb_documents`.                                                                                                                                                                                                                |
| KB connectors            | ✓                                                                               | ✓                                                                   | **GAP**                                              | **GAP**                                                        | auth, sync_start/status/pause                               | Studio API DELETE/PUT exist, not wrapped. No revoke, sync*stop, sync_restart, delta_token_reset, permissions*\_, filters\_\_, discover, recommend, quick_setup.                                                                                                   |
| Channels                 | ✓ via `deployment_ops:configure_channel` (RESOLVED)                             | ✓ via `deployment_ops:list_channels` (RESOLVED), `platform_context` | **GAP** (channel_ops not built)                      | **GAP** (channel_ops not built)                                | –                                                           | RESOLVED for project-level channel config (list_channels, configure_channel reachable via `deployment_ops`). Update/Delete and agent↔channel binding deferred to future `channel_ops` (see §8.2).                                                                 |
| Deployments              | ✓ via `deployment_ops:deploy` (RESOLVED)                                        | ✓ via `deployment_ops:list` (RESOLVED)                              | ✓ via `deployment_ops:promote` (RESOLVED)            | – (rollback removed from DANGEROUS_ACTIONS — no executor case) | ✓ via `deployment_ops:configure_channel` (RESOLVED)         | RESOLVED — `deploy`/`promote`/`list`/`configure_channel`/`list_channels` all reachable via `deployment_ops` (deploy/promote/configure_channel require `confirmed: true`).                                                                                         |
| Project config           | –                                                                               | ✓                                                                   | ✓                                                    | –                                                              | –                                                           | Name, description, entry agent, retention, language, thinking.                                                                                                                                                                                                    |
| Models                   | –                                                                               | ✓                                                                   | ✓                                                    | –                                                              | –                                                           | `configure_model` (apply tenant/project overrides), `recommend_model`. **GAP**: doesn't touch agent's `EXECUTION:` block — overrides live in `ProjectModelConfig` out-of-band.                                                                                    |
| Sessions / traces        | –                                                                               | ✓                                                                   | –                                                    | –                                                              | analyze, query, diagnose, explain                           | `session_ops` (3), `query_traces`, `trace_diagnosis` (6 actions), `read_insights`.                                                                                                                                                                                |
| Tests / evals            | partial via `testing_ops:create_eval` (Phase 1 — RESOLVED for read+run+propose) | ✓ via `testing_ops:list_evals` (RESOLVED), `testing_ops:run_test`   | **GAP** (Phase 2 deferred — full eval write surface) | **GAP** (Phase 2 deferred)                                     | ✓ via `testing_ops:run_test` (RESOLVED)                     | Phase 1 RESOLVED — `run_test`, `list_evals`, `create_eval` reachable via `testing_ops`. Phase 1 caveat: `create_eval` persists name + description only; scenarios save via Studio UI. Phase 2 (full write) unblocks when eval-quality validators land — see §8.3. |
| Analytics                | –                                                                               | ✓ via `analytics_ops:metrics`, `analytics_ops:anomalies` (RESOLVED) | –                                                    | –                                                              | –                                                           | RESOLVED for read-only — `metrics` and `anomalies` reachable via `analytics_ops`. `intents` and `quality_scores` actions are scaffolded as stubs (return `NOT_IMPLEMENTED`) until tab-stats and quality-eval pipelines land.                                      |
| Memory                   | ✓                                                                               | ✓                                                                   | ✓                                                    | –                                                              | –                                                           | `manage_memory` (3 actions).                                                                                                                                                                                                                                      |

**Action counts by domain (reachable IN_PROJECT actions):**

| Domain                                                                                           | Count      |
| ------------------------------------------------------------------------------------------------ | ---------- |
| Agents (propose/apply/dismiss/read/compile/topology/journal + `agent_ops` 7 actions)             | 9 + 7 = 16 |
| Tools (`tools_ops`)                                                                              | 6          |
| MCP servers (`mcp_server_ops`)                                                                   | 10         |
| Auth profiles (`auth_ops`)                                                                       | 6          |
| Variables (`variable_ops`)                                                                       | 6          |
| Integrations (`integration_ops`)                                                                 | 7          |
| Knowledge bases (kb_manage/kb_ingest/kb_search/kb_health/kb_connector/kb_documents)              | 28         |
| Sessions/traces/diagnostics                                                                      | 16         |
| Project config                                                                                   | 4          |
| Model selection (`configure_model`, `recommend_model`)                                           | 4          |
| Tests/evals (`testing_ops`: run_test, list_evals, create_eval)                                   | 3          |
| Channels/deployments (`deployment_ops`: list, deploy, promote, list_channels, configure_channel) | 5          |
| Analytics (`analytics_ops`: metrics, anomalies — `intents` and `quality_scores` are stubs)       | 2          |
| Memory                                                                                           | 3          |
| Misc                                                                                             | 9          |
| **Total reachable**                                                                              | **~125**   |

### Drift / over-privilege

- **DRIFT**: Two `IN_PROJECT_SPECIALIST_TOOL_MAP` definitions disagree on which specialist sees which tools — `packages/arch-ai/src/types/tools.ts:115` (authoritative, used by coordinator) vs `apps/studio/src/lib/arch-ai/tools/build-tools.ts:50` (display copy). A drift-detection contract test (`specialist-tool-map-drift.test.ts`) now keeps these in lockstep, but the studio copy is still a redundant duplicate. See §10.1.
- ~~**DRIFT**: `agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops` have executor functions and permission entries in `guards.ts` but **no tool consumer** in `buildInProjectTools` — the LLM cannot invoke them.~~ RESOLVED 2026-05-05 — see [wire-unregistered-tools-spec.md](./2026-05-05-wire-unregistered-tools-spec.md). All 4 tools are now registered.
- **DRIFT**: `onboarding` and `in-project-generalist` specialists silently fall through to `abl-construct-expert` defaults (not in `IN_PROJECT_SPECIALIST_TOOL_MAP` keys).
- **OVER-PRIVILEGED**: `propose_modification`/`apply_modification` gated only by `agent:read`. User confirmation is the de-facto write control.
- **OVER-PRIVILEGED**: `apply_modification` not in `DANGEROUS_ACTIONS` — relies on the propose-then-apply UX. If propose-cache reused, no safety net.

---

## 3. Authoring coverage — what arch-ai can BUILD

### 3.1 Scaffold

Slots emitted today (`scaffold/scaffold-generator.ts` + `scaffold/assembler.ts`):

| Slot                   | Generator                    | Validator                                        | Validates                                          |
| ---------------------- | ---------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `goal`                 | scaffold-generator.ts:33     | slot-validators.ts:16 `validateGoal`             | length 20-500                                      |
| `persona`              | scaffold-generator.ts:38-46  | slot-validators.ts:24 `validatePersona`          | length 100-2000                                    |
| `handoff.<i>.when`     | scaffold-generator.ts:48-65  | slot-validators.ts:32 `validateHandoffWhen`      | no `{{...}}`, not bare `true`, length 10-200       |
| `gather.<name>.ask`    | scaffold-generator.ts:67-79  | slot-validators.ts:50 `validateGatherAsk`        | no templates, not generic, ends `?`, length 20-300 |
| `complete.<i>.when`    | scaffold-generator.ts:81-103 | slot-validators.ts:70 `validateCompleteWhen`     | declared-identifier check                          |
| `complete.<i>.respond` | assembler.ts:90-95           | slot-validators.ts:102 `validateCompleteRespond` | length ≤300                                        |

**Code-owned (hardcoded, not LLM-driven):** `GUARDRAILS.content_safety` (kind `input`, tier `1`, threshold `0.8`), `MEMORY.session` (auto-populated from gather fields), HANDOFF `RETURN: true` flag, catch-all `WHEN: true`.

**Archetypes:** `supervisor`, `specialist`/`worker`/`single_agent`, `pipeline_stage`. All emit JSON via Zod schemas; assembler renders ABL.

### 3.2 ABL constructs Scaffold does NOT emit

(Verified vs `packages/core/src/parser/agent-based-parser.ts:561-601 knownSections`)

| Construct                                  | Compiler | Scaffold                             | Specialist prompt                             | Status       |
| ------------------------------------------ | -------- | ------------------------------------ | --------------------------------------------- | ------------ |
| LIMITATIONS                                | ✓        | ✗                                    | mention only                                  | **GAP**      |
| TOOLS                                      | ✓        | ✗ (`skeleton.tools=[]` always)       | ✓ (abl-construct-expert)                      | scaffold gap |
| CONSTRAINTS                                | ✓        | ✗                                    | ✓                                             | scaffold gap |
| FLOW / STEPS                               | ✓        | ✗                                    | ✓                                             | scaffold gap |
| DELEGATE                                   | ✓        | ✗                                    | partial                                       | **GAP**      |
| ESCALATE (top-level)                       | ✓        | ✗                                    | partial                                       | **GAP**      |
| ON_ERROR / ON_START                        | ✓        | ✗                                    | partial                                       | **GAP**      |
| EXECUTION                                  | ✓        | ✗                                    | "do not emit" (DRIFT — catalog says yes)      | **DRIFT**    |
| MESSAGES                                   | ✓        | ✗                                    | ✗                                             | **GAP**      |
| HOOKS, ACTION_HANDLERS, TEMPLATES          | ✓        | ✗                                    | ✗                                             | **GAP**      |
| NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES | ✓        | ✗                                    | ✗                                             | **GAP**      |
| ATTACHMENTS, DESTINATIONS                  | ✓        | ✗                                    | ✗                                             | **GAP**      |
| BEHAVIOR_PROFILE                           | ✓        | ✗                                    | ✗                                             | **GAP**      |
| CONVERSATION (voice)                       | ✓        | ✗                                    | ✗ (`channel-voice.ts` is 19 lines, no syntax) | **GAP**      |
| MEMORY.persistent / .recall / .remember    | ✓        | session only                         | ✓                                             | scaffold gap |
| GATHER.type beyond `string`                | ✓        | hardcoded `string` (assembler.ts:73) | ✓                                             | scaffold gap |

13 IR-level constructs have neither Scaffold support nor specialist-prompt teaching. See §8.1 for the per-construct authoring assignment that closes this gap.

### 3.3 Cascade primitives

**Inventory:** one — `cascadeHandoffRename` (`in-project-tools.ts:526-545`). Regex over `TO: <name>` and `Project.entryAgentName`.

**GAPS** (no cascade primitive exists):

- GATHER field rename
- GATHER field delete
- Tool rename
- Tool delete
- Auth-profile rename
- Channel rename / delete
- Connector / KB delete
- MEMORY.persistent path rename
- Agent rename in `DELEGATE:`, `available_agents`, `action_handler.handoff`, `error_handler.handoff_target`, routing rule `to`

The apply path's diagnostics-diff catches some of these post-hoc as "new error", but no automated rewrite.

### 3.4 Cross-agent validator scope

`apps/studio/src/lib/arch-ai/cross-agent-validator.ts:33-136` checks 4 things only:

1. `missing_handoff_target` (error)
2. `missing_delegate_return` (warning)
3. `orphan_agent` (warning, BFS reachability)
4. `abl_routing_mismatch` (error)

**GAPS:**

- Tool sharing/contention across agents
- MEMORY.persistent path collisions
- CONTEXT.pass field declarations across handoff boundaries
- Channel routing / supervisor routing-config consistency
- BEHAVIOR_PROFILE name uniqueness

This validator emits string `type` values, not the H-/CO-/T- codes the diagnostician uses — separate finding shape from the diagnostic engine.

### 3.5 Authoring routes for tools / auth / connectors / channels

| Capability                                 | Authoring tool                 | Create from scratch?                          | Notes                                         |
| ------------------------------------------ | ------------------------------ | --------------------------------------------- | --------------------------------------------- |
| Tools (HTTP/MCP/Sandbox/Workflow/SearchAI) | `tools_ops`                    | ✓                                             | All 5 IR types                                |
| Auth profiles                              | `auth_ops`                     | ✓                                             | 4 of N types                                  |
| MCP servers                                | `mcp_server_ops`               | ✓                                             | + discover, import                            |
| Variables                                  | `variable_ops`                 | ✓                                             | env + config                                  |
| Models                                     | `configure_model`              | apply only                                    | doesn't touch agent EXECUTION block           |
| Project config                             | `project_config`               | modify only                                   | not create                                    |
| Channels                                   | –                              | **GAP** — no `channel_ops` create/update tool | `platform_context list_channels` is read-only |
| KBs                                        | `kb_manage`, `kb_ingest`, etc. | ✓                                             | full CRUD                                     |
| Connectors                                 | `kb_connector`                 | partial                                       | no update/delete (Section 2)                  |
| Memory                                     | `manage_memory`                | ✓                                             | –                                             |
| Deployment                                 | `deployment-ops.ts` (executor) | –                                             | tool unregistered (Section 2)                 |

**Concrete answer:** the LLM cannot "create a Slack channel and bind it to AgentX with reasoning enabled" today. Channel creation/binding has no authoring tool path; reasoning-mode authoring at agent EXECUTION block is not surfaced (only `enableThinking` at project level via `project_config`).

---

## 4. Diagnostics + cross-context validation

### 4.1 Validator inventory

| Tier              | Location                                                                                    | LoC   | Notes                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier 1 (compiler) | `packages/compiler/src/platform/ir/validate-*.ts`                                           | ~2880 | Master at `validate-ir.ts`; cross-agent at `validate-cross-agent.ts:22-318`; coordination at `validate-coordination-config.ts:1-454`; field refs at `validate-field-refs.ts:63-466` |
| Tier 2 (semantic) | `packages/arch-ai/src/diagnostics/semantic-validators.ts` + flow/memory/behavior validators | ~2489 | 20 functions in `ALL_VALIDATORS:1713-1737`                                                                                                                                          |
| Tier 3 (patterns) | `packages/arch-ai/src/diagnostics/pattern-analyzer.ts`                                      | 173   | classifyArchitecture, detectAntiPatterns                                                                                                                                            |
| Runtime           | `apps/runtime/src/services/diagnostics/analyzers/`                                          | 1272  | 7 analyzers: model-resolution, credential-chain, tool-binding, encryption, execution-status, empty-response, flow-state                                                             |

### 4.2 Rule registry

- **77 codes** registered in `packages/arch-ai/src/diagnostics/rule-registry.ts:27-862`
- Categories: handoff, delegation, completion, flow, constraint, guardrail, tool, gather, memory, execution, behavior-profile, naming, template, routing, semantic-vault, quality-floor
- **DRIFT**: Diagnostician prompt advertises "53 implemented rule codes". Either prompt is stale or registry includes deferred codes. Not gated by a test.
- **GAP**: No public catalog (UI page, doc) lists the codes. `executeExplainDiagnostic` requires the user/LLM to know the code first.

### 4.3 Fix templates

`fix-templates.ts` `FIX_MAP` has **20 entries**: CO-01..04, H-02, H-03, H-04, H-05, H-06, H-07, H-08, H-15, T-01, T-04, T-08, G-01, G-07, GR-01, O-02, C-04.

**57 codes have NO template.** Categories with zero or near-zero templates:

- All flow rules (F-01..F-14, SV-08, SV-09, SV-10, SV-14)
- All memory rules (M-01..M-06)
- All execution rules (E-01..E-07)
- All behavior-profile rules (BP-01..BP-06)
- Most semantic-vault rules (SV-03..SV-18)
- Most constraint rules (C-01..C-03, C-05..C-10)
- Most tool rules (T-02, T-03, T-05..T-07, T-09..T-12)
- Most gather rules (G-02..G-06, G-08, G-09)
- Most guardrail rules (GR-02, GR-03, GR-05)
- Most naming rules (O-01, O-04..O-12)
- Quality floor (QG-02..QG-05; QG-01..04 carry inline `fix:` but no template)

When a code has no template, the LLM has only `description` text and must invent ABL — drift risk.

### 4.4 Cross-context dependencies CHECKED today

| Dependency                                  | Where                                                                       | Severity      |
| ------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| Handoff target existence                    | `validate-cross-agent.ts:189-211` + Studio `cross-agent-validator.ts:42-56` | error         |
| Delegate target existence                   | `validate-cross-agent.ts:214-232`                                           | error         |
| Routing target existence                    | `validate-cross-agent.ts:189-211`                                           | error         |
| `on_start.delegate` target                  | `validate-cross-agent.ts:235-248`                                           | error         |
| error_handler `handoff_target`              | `validate-cross-agent.ts:297-316`                                           | error         |
| `available_agents`                          | `validate-cross-agent.ts:169-187`                                           | error         |
| ON_ACTION handoff/delegate target           | `validate-cross-agent.ts:86-166`                                            | error         |
| Self-target prohibition                     | `validate-cross-agent.ts:60-72`                                             | error         |
| Handoff PASS field type compat (H-08)       | `semantic-validators.ts:151-166`                                            | warning       |
| PASS references gather/session field (H-04) | `semantic-validators.ts:139-149`                                            | warning       |
| Handoff return contract (CO-04)             | `semantic-validators.ts:38-69`                                              | error         |
| ON_RETURN.map child fields (H-07)           | `semantic-validators.ts:174-223`                                            | warning       |
| Return state coverage (H-15)                | `semantic-validators.ts:281-344`                                            | warning       |
| Memory grants ↔ persistent decls            | `validate-coordination-config.ts:293-340`                                   | error         |
| RECALL agent ref                            | `recall-validation.ts:84+`                                                  | error         |
| RECALL tool ref                             | `recall-validation.ts:73+`                                                  | error         |
| Delegate input ↔ target GATHER (H-12)       | `semantic-validators.ts:1524-1538`                                          | error         |
| Routing conflicts (H-09)                    | `semantic-validators.ts:347-372` (string-equal WHEN only)                   | warning       |
| Tool DSL → ProjectTool record (T-03)        | `diagnose-project.ts:241-251`                                               | error         |
| Tool params signature drift (T-06)          | `diagnose-project.ts:291-313`                                               | warning       |
| Runtime tool binding (post-deploy)          | `runtime/.../analyzers/tool-binding.ts:135-178`                             | warning       |
| Runtime credential chain                    | `runtime/.../analyzers/credential-chain.ts`                                 | warning/error |
| Runtime model resolution                    | `runtime/.../analyzers/model-resolution.ts`                                 | warning/error |

### 4.5 Cross-context dependencies NOT CHECKED — the gaps

For each, no validator reference found across `packages/arch-ai/src/diagnostics/`, `packages/compiler/src/platform/ir/`, or `apps/studio/src/lib/arch-ai/`:

- **GAP**: Tool removal vs gather/flow refs to tool output (`last_<tool>_result`, `tool.on_result.set` keys)
- **GAP**: Tool rename vs handoff/recall references in other agents
- **GAP**: Auth-profile change vs tool credential resolution
- **GAP**: Auth-profile field schema per connector type
- **GAP**: Model change vs runtime credential availability (Studio→Runtime not invoked at apply time)
- **GAP**: Channel↔agent binding modality compat
- **GAP**: Channel↔model binding (vision/voice/streaming caps)
- **GAP**: Connector delete vs dependent agents (no KB→agent reverse index)
- **GAP**: KB delete vs RECALL refs
- **GAP**: Permission topology shift on KB rebind
- **GAP**: Memory key rename across agents
- **GAP**: Gather field rename across handoff PASS in other agents
- **GAP**: Gather field delete across COMPLETE/FLOW refs of other agents

### 4.6 Single-agent mode false-positive carve-out

`SINGLE_AGENT_FALSE_POSITIVE_CODES` (`diagnostic-engine.ts:31-37`) suppresses these codes in single-agent compile:

- `INVALID_HANDOFF_TARGET`
- `INVALID_DELEGATE_TARGET`
- `INVALID_ROUTING_TARGET`
- `INVALID_DEFAULT_ROUTING_TARGET`
- `UNKNOWN_RECALL_AGENT`

Auto-enabled when `options.agentName` is set or `skipCrossAgentPatterns === true`. Filtering hard-coded in `shouldSkipSingleAgentTier1Finding:191-199`. **Not user-configurable.** Tier 3 also fully suppressed in single-agent scope.

**Risk:** sibling-breaking changes pass silently in single-agent mode. Tier 2 cross-agent semantic validators silently no-op when `ctx.agents` has only one entry.

### 4.7 Suggestion → Apply loop

**Suggestion source:** there is no deterministic suggestion-generator. The user-visible `fix.description` is attached at validator emit site (e.g., `semantic-validators.ts:1271`) or via `getFixTemplate` lookup (`diagnostic-engine.ts:131-138`). The actual proposal of new ABL is an LLM specialist call (`diagnostician`, `abl-construct-expert`, `multi-agent-architect`) via `propose_modification`.

**`Finding.fix` schema** (`types.ts:53-60`):

```ts
FixSuggestion { description: string; template?: string; effort: 'S'|'M'|'L' }
```

**GAP**: no `affectedConstructs`, `requires`, `invalidates`, `relatedAgents` fields. The `Finding` interface itself (`types.ts:35-48`) carries `code, message, severity, category, agentName, path, fix` only — no structured downstream-impact metadata.

**Apply path re-runs full diagnostics:** YES (`in-project-tools.ts:441-485`):

- `validateProjectAgentCode` compiles whole project before AND after
- Runs `runProjectDiagnostics` on both
- Rejects on regression (`semanticRegressions:452-472`)
- Invoked on `propose_modification` (`:1794-1799`) and `apply_modification` (via `applyProjectAgentModification:961`)

**4 leak paths:**

1. **Only blocks on NEW ERROR-severity findings** (`:452-454`). New warnings/infos pass.
2. **Dedup key is message-text-sensitive** (`diagnosticFindingKey:206-213` hashes severity+code+agent+category+message). Wording drift = false "new" finding; identical wording = false suppression of a different bug.
3. **Runtime engine NOT called from apply path.** `apps/runtime/src/services/diagnostics/engine.ts` runs only at execution time. Studio commits configs runtime then rejects.
4. **No structured ripple metadata in `Finding.fix`** (Section 4.7 above). LLM has no machine-readable hint that fixing X will break Y.

**Impact analysis is collected but not used as a gate:** `buildAgentChangeImpact:669-766` computes `incomingBefore/After`, `outgoingBefore/After`, `addedEdges`, `removedEdges`, `tools.added/removed`. Surfaces in the proposal payload. Does NOT feed back into validator selection or trigger sibling re-validation.

**Apply-time cascade is regex-only and `TO:`-only.** Does not handle `DELEGATE:`, `available_agents`, action_handler `handoff:`, error_handler `handoff_target`, routing rule `to`. Risk: a rename routed via `propose_modification` surfaces those sites in the after-state diagnostics, but the apply-time cascade only auto-rewrites `TO:`.

### 4.8 Test coverage

Searched `apps/studio/src/__tests__/arch-ai/` and `packages/arch-ai/src/__tests__/`:

- `apply-project-agent-modification.test.ts` — verifies metadata refresh, valid edit, rename cascade. No "fix → no degraded health" test.
- `engine-factory-propose-modification.test.ts` — proposal envelope shape only.
- `cross-agent-validator.test.ts` — missing routing target detection at validator level.
- Per-validator unit tests in `packages/arch-ai/src/__tests__/diagnostics/`.

**GAP**: No test asserts "after `apply_modification` of a fix to finding X on agent A, finding Y is not introduced on agent B". `semanticRegressions` filter (`:452`) has no integration test demonstrating cascade prevention. No grep matches for "reapply", "introduces.*new", "degrade.*health".

---

## 5. Knowledge cards & prompt content

### 5.1 Card inventory

30 auto-generated cards in `packages/arch-ai/src/knowledge/cards/generated/`. Header: `// Auto-generated from docs-internal MDX. Do not edit manually. // Regenerate: pnpm abl:docs:generate`. Source mapping in `tools/abl-docs/card-mapping.ts`. Generator at `tools/abl-docs/card-generator.ts`.

| Card                                                                     | Domain                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| abl-anatomy                                                              | Top-level sections, file extensions                                         |
| execution-config                                                         | EXECUTION block, model, temperature, compaction, voice, fallbacks           |
| limitations-vs-constraints                                               | LIMITATIONS / CONSTRAINTS / GUARDRAILS distinction                          |
| flow-patterns / flow-reasoning-zones / flow-transform / flow-digressions | FLOW step types, REASONING, TRANSFORM, digressions                          |
| gather-fields / gather-validation-pii                                    | GATHER, validation, PII                                                     |
| tool-binding-auth / tool-resolution / tool-templates                     | Tools, auth, JIT, identity tier, interpolation                              |
| handoff-delegate / cross-agent-contracts                                 | HANDOFF/DELEGATE, RETURN, ON_RETURN, history; SUPERVISOR + AGENTS + ROUTING |
| routing-intents                                                          | Supervisor INTENTS, MULTI_INTENT, ROUTING                                   |
| guardrails-tiers                                                         | GUARDRAILS local/model/llm tiers                                            |
| error-handling                                                           | ON_ERROR handlers, RETRY, BACKOFF                                           |
| escalate-a2a                                                             | ESCALATE, destinations, A2A, voice transfer                                 |
| cel-functions / cel-pitfalls                                             | CEL operators, helpers, pitfalls                                            |
| memory-full                                                              | MEMORY session/persistent/remember/recall/projected                         |
| nlu-entities                                                             | NLU intents, ENTITIES, LOOKUP_TABLES                                        |
| behavior-profiles                                                        | BEHAVIOR_PROFILES, VIP/tier overrides                                       |
| hooks-lifecycle                                                          | HOOKS, before/after, ACTION_HANDLERS, RETURN_HANDLERS                       |
| rich-content                                                             | Carousels, tables, charts, KPIs, forms                                      |
| attachments-kb                                                           | ATTACHMENTS, OCR, AWAIT_ATTACHMENT, SearchAI KB                             |
| project-config                                                           | Auth profiles, MCP, config vars, PII patterns, sessions, evals              |
| diagnostics-workflow                                                     | Validate/diagnose flow, codes                                               |
| observer-analytics                                                       | Performance metrics, briefings, knowledge gaps                              |
| testing-workflow                                                         | Scenario taxonomy, golden corpus, regression evals                          |

### 5.2 11 IR surfaces with NO first-class card

(From `packages/compiler/src/platform/ir/schema.ts`)

1. `SystemPromptConfig` (custom SYSTEM_PROMPT/INSTRUCTIONS)
2. `OmnichannelPolicyIR` (channel-policy rules)
3. `VoiceConfigIR` (voice provider/speed/barge-in)
4. `ConversationBehaviorIR` / Speaking / Listening / Interaction (voice conversation)
5. `ResponseRulesIR` / `FlowModificationsIR` (mentioned only inside behavior-profiles card)
6. `AsyncWebhookBindingIR` (referenced in tool-binding-auth as name only)
7. `AuthRequirementIR` (declarative auth requirements)
8. `SearchAIBindingIR` / SearchAI manifest discovery (only briefly mentioned)
9. `ConnectorBindingIR` (partial coverage in tool-resolution)
10. `WorkflowBindingIR` (Workflow tool integration absent)
11. `ProjectRuntimeConfigIR` (runtime overrides; project-config card covers some, not RuntimePromptOverrideRef, RuntimeFillerConfig, CompactionPolicyOverride)

Plus categories with no card at all:

- Channels (CHANNEL_VOICE_PROMPT is 19 lines, no syntax, no card)
- Deployments
- Model resolution (the contract documented in CLAUDE.md)
- Trace event shape
- Security / RBAC / tenant isolation
- Sandbox runtimes (gvisor/lambda/mock/noop, 5MB limit)
- BullMQ flows / workers
- Compaction policies

### 5.3 Card source-of-truth check

**Contract-grounded portions:** `handoff-delegate`, `cross-agent-contracts`, `memory-full` end with a "Canonical Contract" trailer injected from `contract-facts.ts` reading `getAblContractRegistry()` (`packages/compiler/src/platform/contracts/contract-source-data.ts`).

**Contract test coverage:** `packages/arch-ai/src/__tests__/abl-contract-backed-knowledge.test.ts` verifies 5 fields across 3 cards. **27 of 30 cards have NO contract grounding** — verbatim MDX excerpts that drift independently of IR.

**DRIFT in cards:**

- `cross-agent-contracts.ts` shows `ROUTING:` and `AGENTS:` syntax. Compiler whitelist in `BUILD_PHASE_PROMPT` (`build.ts:193`) and L0 (`platform-limits.ts:17`) **explicitly lists `ROUTING:` as REJECTED** ("use HANDOFF"). LLM grabbing this card sees conflict.
- `error-handling.ts:34-42` lists error type `routing_failure` and `agent_unavailable` — these names appear in MDX but unverified vs runtime executors.
- `memory-full.ts:57-62` malformed properties table (pipe-character escaping not sanitized).

### 5.4 Specialist ↔ card binding

Card selection happens in the prompt assembler (`packages/arch-ai/src/prompts/index.ts:59-93` `composeSystemPrompt`, `:109-144` `composeInProjectPrompt`):

- Driven by `userMessage` regex matching against `CARD_REGISTRY`
- 28 of 30 cards have regex patterns
- `forceCardIds`: BUILD phase forces only `['handoff-delegate']`. No other phase forces cards.

**GAP**: no specialist forces its domain card.

- `ANALYST_PROMPT` doesn't force `observer-analytics`
- `DIAGNOSTICIAN_PROMPT` doesn't force `diagnostics-workflow`
- `INTEGRATION_METHODOLOGIST_PROMPT` doesn't force `tool-binding-auth` or `tool-resolution`
- `ENTITY_COLLECTION_PROMPT` doesn't force `gather-fields`
- `CHANNEL_VOICE_PROMPT` has no card to force (none exists for voice)
- `MULTI_AGENT_ARCHITECT_PROMPT` doesn't force `routing-intents`, `handoff-delegate`, `cross-agent-contracts`
- `TESTING_EVAL_PROMPT` doesn't force `testing-workflow`

If user message lacks the regex trigger, the relevant card never loads. The IN_PROJECT generalist explicitly admits the gap: "Knowledge injected in your context above covers ABL constructs well, but may not cover all platform topics — use search_docs."

### 5.5 Three sources of truth for ABL rules

1. `packages/arch-ai/src/prompts/phases/build.ts` — `BUILD_PHASE_PROMPT` (~140 lines of compiler-specific rules)
2. `packages/arch-ai/src/prompts/specialists/abl-construct-expert.ts` — `ABL_CONSTRUCT_EXPERT_SYNTAX` (~259 lines)
3. `apps/studio/src/lib/arch-ai/handbook-reference.ts:237-263` — `ablGenerationRules` (17 rules)

**No test links them.** `build-prompt-contract.test.ts` covers (1) and (2) string-presence; (3) is uncovered. Updating one location does not propagate.

### 5.6 Drift detection holes

- **GAP**: no card↔IR-schema coverage test (adding a new IR type doesn't fail anything)
- **GAP**: no prompt↔card duplication test (`ablGenerationRules` ↔ `BUILD_PHASE_PROMPT` ↔ `ABL_CONSTRUCT_EXPERT_SYNTAX`)
- **GAP**: no specialist↔card binding test
- **GAP**: no compile-on-card test (`prompts-compile.test.ts` referenced in JSDoc but FILE DOES NOT EXIST)
- **GAP**: no card-mapping integrity test (orphan cards possible)
- **Contract registry covers only 13 constructs** — most ABL surfaces have no entry, so contract-test approach can't be extended without first growing `contract-source-data.ts`

### 5.7 Recent fix patterns specific to cards/prompts

Sample of last 60 days under `packages/arch-ai/src/{knowledge,prompts}` and Studio handbook/scaffold:

| Class                                                             | Examples                                 |
| ----------------------------------------------------------------- | ---------------------------------------- |
| Prompt rule lag (Diagnostician deleting GATHER on RETURN targets) | `e337c15d0c`, `3c1700be6e`               |
| Scaffold↔compiler                                                 | `5d124d5727`, `46e17df4fb`               |
| Build prompt rule lag                                             | `e2b48fcb87`, `8b925c60ae`               |
| L3 retrieval drift                                                | `f174801a8d`, `01e72de8b4`               |
| Knowledge regen drift                                             | `6a872b1282`, `9c52777c06`, `7035a73830` |
| WHEN expression authoring                                         | `5f74f9c02d`                             |
| Handoff continuity contracts                                      | `a9e05a27ba`, `45b856ebd6`, `0821674963` |
| Coordination shorthand drift (`grant_memory` → `memory_grants`)   | per `agents.md` 2026-04-19               |
| GATHER cleanup without RETURN check                               | per `agents.md` 2026-04-29               |

Dominant drift class: **Studio prompts vs runtime CEL/compiler contract** (not card↔compiler).

---

## 6. Recurring regression patterns (60–90 days)

15+ fix() commits sampled. Themes:

- **Cross-agent validation skip in single-agent compile** then partial re-enable with carve-outs (`cd80114146`)
- **Project-aware compilation rolled in late** fixing escaped issues (`5de14533eb`, `3563a64872`)
- **Apply path repeatedly hardened** (`362d094201`, `417259c400`)
- **WHEN expression rules relaxed multiple times** (`5f74f9c02d`, `84f1beaaea`)
- **End-to-end hardening sweeps mixed with field-propagation fixes** — ABLP-791 (companion tail, 16 fix commits), ABLP-732/734 (project tool bindings, import git), ABLP-612 (action handler routing, 10 fix commits) — match the "cross-boundary field propagation" pattern in CLAUDE.md
- **False-positive whack-a-mole** — single-agent FP suppression list grew over time; QG-05 expansion was reverted

Net pattern: **schema/contract change in feature commit → diagnose/health/validate fail because they read old shape → fix commit re-aligns them.**

---

## 7. The 6 highest-leverage gaps

Ranked by impact on the user's stated goal: "fully handle agents/tools/auth/connectors/channels + non-regressing diagnose".

| #     | Gap                                                                                                                                                                                                                    | Lift | Why high leverage                                                                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| ~~1~~ | ~~**Wire up the 4 unregistered tools** (`agent_ops`, `deployment_ops`, `testing_ops`, `analytics_ops`)~~ ✅ ADDRESSED 2026-05-05 — see [wire-unregistered-tools-spec.md](./2026-05-05-wire-unregistered-tools-spec.md) | S    | Code exists, permissions mapped. Just register + permission audit. Unblocks channel/deployment/eval/analytics areas immediately. |
| 2     | **Add `Finding.fix` ripple metadata** (`affectedConstructs`, `invalidates`, `requires`, `relatedAgents`) and populate from validators                                                                                  | M    | Closes the "no machine-readable ripple data" leak. Every validator already knows what it's checking against — expose it.         |
| 3     | **Replace single-agent FP carve-out with a "warn but defer" qualifier**                                                                                                                                                | S    | The 5 suppressed codes are exactly the cross-agent regression class. Today they're invisible in single-agent mode.               |
| 4     | **Studio→Runtime diagnose at apply time**                                                                                                                                                                              | M    | Runtime analyzers exist, just not called. Wire into `applyProjectAgentModification` post-validation.                             |
| 5     | **Build a Cascade graph + Cascade plans** (per §8.5 tiers) covering field rename/delete, tool rename/delete, auth rotation, channel rebind, KB delete                                                                  | L    | Bulk of "fix opens new issue" originates here.                                                                                   |
| 6     | **Knowledge card coverage for the 11 missing IR types** via code-card-generator (per §8.4) + auto-load by specialist + prompt-compile test + drift CI                                                                  | M    | Channels, voice, model resolution, security all blind. Generated from IR types + JSDoc.                                          |

Recommended phasing: 1 → 3 (both small) → 2 → 4 → 6 → 5 (largest scope).

---

## 8. Locked decisions

These five decisions are locked as of 2026-05-05 and unblock spec writing for gaps #5 (cascade graph) and #6 (knowledge cards).

### 8.1 Per-construct authoring assignment

For each ABL construct that arch-ai can't author today (or authors poorly), one of two homes:

**Authored via Scaffold** (slot + validator + schema):
TOOLS, CONSTRAINTS, FLOW, DELEGATE, ESCALATE, LIMITATIONS, ON_ERROR, ON_START, EXECUTION, MEMORY.persistent, MEMORY.recall.

**Authored via LLM** (prompt + card + `propose_modification`):
NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES, ATTACHMENTS, DESTINATIONS, MESSAGES, HOOKS, ACTION_HANDLERS, TEMPLATES, BEHAVIOR_PROFILE, CONVERSATION.

Rationale: Scaffold pays its way for high-volume regression-prone constructs. LLM authoring is enough for rarer/more-variable constructs.

### 8.2 Channels — `channel_ops` tool, bind-only

Add `channel_ops` tool with these actions only:
`list`, `inspect`, `bind_to_agent`, `unbind_from_agent`, `list_bindings`, `validate_modality_compat`.

**Out of scope for `channel_ops`:** `create_channel`, `rotate_credential`, `delete_channel`. Channel provisioning (OAuth flows, vendor consent screens, secret entry) stays in Studio UI. Mirrors `auth_ops` pattern: arch-ai creates the profile shell, secrets enter via `collect_secret` widget.

### 8.3 Evals — Phase 1 (read + run + propose)

Add `eval_ops` tool with:
`list_scenarios`, `list_runs`, `list_evaluators`, `list_personas`, `list_sets`, `inspect_run`, `trigger_run`, `propose_scenario`.

`propose_scenario` returns a structured suggestion the user reviews and saves via Studio UI. No direct write to evaluators/personas/sets in this cycle. Phase 2 (full write) unblocks when eval-quality validators land — out of scope for this design.

### 8.4 Knowledge cards from code

Build `tools/abl-docs/code-card-generator.ts`. TS-AST walker over IR types + JSDoc + executor source. Emits to `packages/arch-ai/src/knowledge/cards/generated-from-code/`. Registered in `_mapping.ts` with `coverageType: 'code'`.

MDX-based cards stay in existing `tools/abl-docs/card-generator.ts`. Both pipelines run in CI; both have drift-detection tests.

Cards to generate this way (the 11 IR surfaces uncovered today): `voice-config`, `omnichannel-policy`, `sandbox-runtimes`, `connector-resolution`, `searchai-discovery`, `model-resolution`, `trace-event-shape`, `security-isolation`, `async-webhook`, `project-runtime-config`, `compaction-policies`.

### 8.5 Cascade tiers

Cascade behavior when arch-ai mutates a construct that has dependent references elsewhere:

| Mutation                                                                                                                                                     | Cascade mode                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| Agent rename (extends `cascadeHandoffRename` to `DELEGATE`, `available_agents`, `action_handler.handoff`, `error_handler.handoff_target`, routing rule `to`) | **auto-rewrite**               |
| Tool rename                                                                                                                                                  | **auto-rewrite**               |
| Auth-profile rename                                                                                                                                          | **auto-rewrite**               |
| GATHER field rename                                                                                                                                          | **cascade plan + user review** |
| GATHER field delete                                                                                                                                          | **cascade plan + user review** |
| Tool delete                                                                                                                                                  | **cascade plan + user review** |
| MEMORY.persistent path rename                                                                                                                                | **cascade plan + user review** |
| Channel rebind                                                                                                                                               | **cascade plan + user review** |
| Connector / KB delete                                                                                                                                        | **cascade plan + user review** |

Cascade plan returns `{ primary, dependents[], rationale, risks }` to the LLM, which renders as a single confirm-all / review-each widget. User can apply all, apply selected, or cancel.

---

## 9. References

- Live audit raw outputs: 4 explorer agents dispatched 2026-05-05; raw outputs in conversation history.
- Plugin discard decision: `~/.claude/projects/-Users-sriharshanalluri-abl-platform/memory/feedback-plugin-approach-discarded.md`
- Cross-cutting platform principles: `CLAUDE.md` § Resource Isolation, Centralized Auth, Type Safety, Studio Route Handler Gotchas
- Relevant skills: `data-flow-audit`, `data-propagation-audit`, `pre-review-checklist`, `cross-cutting-concerns`

---

## 10. Known follow-ups from gap #1 work

Tracked for future work — none blocking the current ship of gap #1.

| #     | Follow-up                                                                                                                                                                                                                                                                                                                         | Surface                                               | Severity          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| 10.1  | `build-tools.ts` `IN_PROJECT_SPECIALIST_TOOL_MAP` is a dead duplicate kept in sync only by the drift contract test. Delete it and point Studio code at the package's authoritative map.                                                                                                                                           | `apps/studio/src/lib/arch-ai/tools/build-tools.ts`    | tech debt         |
| 10.2  | `deployment-ops.ts` hardcodes the dangerous-action predicate (`['deploy','promote'].includes(action)`) instead of calling the shared `isDangerousAction()` helper used by every other ops executor. The dead `isDangerousAction` import at the top of the file is the smoking gun. Same pattern likely exists in other executors. | `apps/studio/src/lib/arch-ai/tools/*-ops.ts`          | drift risk        |
| 10.3  | `@abl/compiler/platform` is mocked in 9+ ops-executor tests for the logger. The platform-mock-lint hook BLOCKS this in principle but doesn't fire because of pre-existing test patterns. Either carve out a logger allow-list or extract `createLogger` to a DI seam.                                                             | `apps/studio/src/__tests__/arch-ai/*.test.ts`         | test architecture |
| 10.4  | Test coverage for `agent_ops`, `deployment_ops`, `analytics_ops` is narrower than the spec §5.1 minimum (3, 4, 1 cases vs spec's 9, 5, ≥3). True happy-path coverage requires DI on the executors so platform packages can be swapped in tests without `vi.mock`.                                                                 | spec §5.1                                             | follow-up         |
| 10.5  | Cross-tool description-string consistency — `analytics_ops` field describes are terse compared to `agent_ops` / `deployment_ops` / `testing_ops`. Standardize the describe-richness when adding the next ops tool.                                                                                                                | `in-project-tools.ts` registrations                   | minor             |
| 10.6  | First-class `channel_ops` tool for agent-channel binding (per audit §8.2). Currently only project-level `configure_channel` is reachable.                                                                                                                                                                                         | new tool                                              | feature           |
| 10.7  | `eval_ops` Phase 2 — full read/write surface for evals. Currently `testing_ops:create_eval` persists name + description only.                                                                                                                                                                                                     | new actions on existing tool                          | feature           |
| 10.8  | `analyst` specialist prompt has `testing_ops` allow-listed but no playbook entry — the LLM sees the tool definition but has no "when to use" guidance. Either remove from allow-list or add a "When to run a test" section to `analyst.ts`.                                                                                       | `packages/arch-ai/src/prompts/specialists/analyst.ts` | minor             |
| 10.9  | `agent_ops:create` is gated by `agent:update` permission (no `agent:create` perm exists). A user who can edit existing agents gains the ability to create new ones via the LLM. May be intentional, but worth a separate permission.                                                                                              | `apps/studio/src/lib/arch-ai/guards.ts:11`            | permission        |
| 10.10 | `engine-factory.ts:1941` still registers a standalone `run_test` in the v2 `buildOnboardingToolRegistry` (different from `buildInProjectTools`). Specialist allow-list filters strip it today, but a future maintainer who re-adds `'run_test'` to a specialist allow-list would silently re-route to the dead tool.              | `apps/studio/src/lib/arch-ai/engine-factory.ts:1941`  | latent footgun    |
