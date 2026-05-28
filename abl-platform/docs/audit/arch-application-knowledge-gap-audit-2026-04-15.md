# ARCH Application Knowledge Gap Audit

Date: 2026-04-15

## Scope

This audit measures how well the backend ARCH engine understands the real project-level feature surface of the product.

Source of truth:

- Live ARCH backends:
  - `apps/studio/src/app/api/arch-ai/message/route.ts`
  - `apps/studio/src/app/api/arch-ai/chat/route.ts`
- Session-based ARCH knowledge layer:
  - `packages/arch-ai/src/knowledge/card-router.ts`
  - `packages/arch-ai/src/prompts/phases/in-project.ts`
- Studio project feature surface:
  - `apps/studio/src/app/api/projects/[id]/**`
- In-project tool executors:
  - `apps/studio/src/lib/arch-ai/tools/in-project-tools.ts`
  - `apps/studio/src/lib/arch-ai/tools/build-tools.ts`
  - `apps/studio/src/lib/arch-ai/context.ts`

Explicitly excluded as source of truth:

- `docs/handbook/**`
- `docs/arch/**`

## Executive Summary

The backend ARCH engine is strong on agent authoring and diagnosis, but only partial on broader application knowledge.

Strong areas:

- ABL constructs and agent authoring
- Topology and routing patterns
- Health checks, semantic diagnostics, traces, and analytics insights
- Project config and model recommendation/configuration
- Tool configs and auth profiles

Weak areas:

- Workflow and HITL surfaces
- Connections, connector catalog, MCP servers, and variable/data-control surfaces
- Project IO and governance surfaces like import/export, git, modules, billing, members, and teams
- Cross-surface consistency between the v3 session-based backend and the older `/api/arch-ai/chat` route

The largest product knowledge gap is not one missing card. It is that the real project feature surface is wider than the current ARCH in-project executor set, so ARCH can easily sound confident about features it cannot actually inspect or change live.

## Audit Method

1. Inventory project-level features from `apps/studio/src/app/api/projects/[id]`.
2. Group them into product families instead of auditing endpoint-by-endpoint.
3. Compare each family against:
   - Session-based ARCH knowledge cards
   - Session-based in-project tools
   - `/api/arch-ai/chat` system prompt and tools
4. Classify coverage as:
   - `Direct`: ARCH has live tools and strong prompt/card knowledge
   - `Partial`: ARCH can explain the area, but lacks executor coverage or complete knowledge
   - `Gap`: Feature exists in project code but ARCH has little or no reliable live coverage

## Project Feature Inventory

Feature families found under `apps/studio/src/app/api/projects/[id]`:

- Design/runtime core: `agents`, `topology`, `llm-config`, `runtime-config`, `settings`, `session-lifecycle`, `sessions`
- Observability/quality: `evals`, `pii-patterns`, `arch-conversation`
- Integrations/data controls: `tools`, `auth-profiles`, `connections`, `connectors`, `mcp-servers`, `config-variables`, `variable-namespaces`, `lookup-tables`
- Workflow/HITL/orchestration: `workflows`, `approvals`, `human-tasks`, `agent-transfer`, `omnichannel`, `attachment-config`
- Project IO/governance: `import`, `export`, `bundle`, `git`, `module`, `module-catalog`, `module-dependencies`, `billing`, `members`, `teams`, `archive`, `restore`, `dependencies`, `locks`

## Coverage Assessment

### 1. Agent Design and Diagnostics: Direct

Evidence:

- Knowledge cards heavily cover ABL syntax and design patterns in `packages/arch-ai/src/knowledge/cards/*`
- Session-based prompt and tools cover:
  - `read_agent`
  - `compile_abl`
  - `read_topology`
  - `health_check`
  - `validate_agent`
  - `diagnose_project`
  - `explain_diagnostic`
  - `query_traces`
  - `recommend_model`
  - `configure_model`
  - `analyze_constraints`

Assessment:

- This is the strongest ARCH area today.
- ARCH can usually answer "why is this agent broken", "how should I restructure the topology", and "what ABL construct should I use" with real backing.

### 2. Runtime, Sessions, and Quality: Partial

Evidence:

- Project routes expose sessions, session lifecycle, eval runs, quick eval, personas, scenarios, evaluators, sets, `llm-config`, and `runtime-config`.
- Session-based ARCH has strong diagnosis tools, but no direct eval CRUD or session CRUD executor set.
- The simpler `/api/arch-ai/chat` route has `session_ops`, `analytics_ops`, and `testing_ops`, but does not use the package knowledge-card layer.

Assessment:

- ARCH understands diagnostics and traces well.
- ARCH only partially understands the broader eval/session product surface.
- Good at "why did this session fail"; weaker at "what eval personas, runs, and lifecycle settings does this project have right now?"

### 3. Integrations, Variables, and Data Controls: Partial to Gap

Evidence:

- Project routes expose:
  - `auth-profiles`
  - `connections`
  - `connectors`
  - `mcp-servers`
  - `config-variables`
  - `variable-namespaces`
  - `lookup-tables`
  - `pii-patterns`
- Session-based ARCH directly supports:
  - `tools_ops`
  - `auth_ops`
  - `collect_secret`
  - `platform_context`
- It does not directly expose connections, connector catalog, MCP CRUD, config variable CRUD, namespace CRUD, lookup-table CRUD, or PII pattern CRUD.

Assessment:

- ARCH can discuss tool configs and auth profiles well.
- ARCH has meaningful knowledge gaps on the rest of the integration/data-control surface.
- This is one of the easiest places for ARCH to overstate what it can inspect live.

### 4. Workflows, HITL, and Cross-Channel Orchestration: Gap

Evidence:

- Project routes expose:
  - `workflows`
  - `approvals`
  - `human-tasks`
  - `agent-transfer`
  - `omnichannel`
  - `attachment-config`
- Session-based ARCH has no dedicated in-project executors for these feature families.
- The older `/api/arch-ai/chat` route also does not expose first-class workflow/HITL tools despite knowing more project context generically.

Assessment:

- ARCH currently lacks strong application knowledge here.
- It can reason about adjacent concepts like topology or handoffs, but not the actual workflow/HITL project surface.

### 5. Project IO and Governance: Gap

Evidence:

- Project routes expose:
  - `import`
  - `export`
  - `bundle`
  - `git`
  - `module`
  - `module-catalog`
  - `module-dependencies`
  - `billing/usage`
  - `members`
  - `teams`
  - `archive`
  - `restore`
- Session-based ARCH has no first-class executor coverage here beyond general project context/config.

Assessment:

- ARCH is weak on packaging, reusable modules, git/project IO, and governance/admin surfaces.
- This is the biggest feature-family blind spot after workflows/HITL.

## Cross-Surface Backend Mismatches

### Mismatch A: Two backend ARCH surfaces know different things

`/api/arch-ai/message`:

- Uses the `@agent-platform/arch-ai` package.
- Benefits from the routed knowledge-card system.
- Has richer in-project mutation/diagnostic tools.

`/api/arch-ai/chat`:

- Uses a separate `buildSystemPrompt()` and `getToolsForContext()` stack.
- Does not use the package knowledge-card router.
- Has different tool availability and a thinner baked-in knowledge model.

Impact:

- ARCH answers depend on which backend route the UI happens to hit.
- Knowledge improvements made only in the package do not automatically improve `/api/arch-ai/chat`.

### Mismatch B: Prompted tools vs callable tools

Before this change, the v3 session-based in-project prompt advertised `platform_context` and `read_journal`, but the specialist allowlists in `apps/studio/src/lib/arch-ai/tools/build-tools.ts` did not expose them to routed specialists.

Impact:

- ARCH could be instructed to use tools it could not actually call.
- This especially hurt broad project-context questions.

Status:

- Fixed in this change by making `platform_context` and `read_journal` reachable across in-project specialists.

### Mismatch C: `/api/arch-ai/chat` prompt drift

The `/api/arch-ai/chat` project prompt references capabilities and workflows that do not perfectly match the actual `getToolsForContext()` tool set.

Impact:

- The older backend can sound more capable than it is.
- This is still open after this audit.

## Knowledge Gaps That Matter Most

Highest-value gaps:

1. Workflow/HITL surfaces

- `workflows`
- `approvals`
- `human-tasks`
- `agent-transfer`
- `omnichannel`

2. Integration/data-control surfaces outside basic tool CRUD

- `connections`
- `connectors`
- `mcp-servers`
- `config-variables`
- `variable-namespaces`
- `lookup-tables`
- `pii-patterns`

3. Project IO/governance surfaces

- `import`
- `export`
- `bundle`
- `git`
- `module*`
- `billing/usage`
- `members`
- `teams`

4. Eval/runtime breadth

- ARCH can diagnose sessions well, but it does not fully speak the product language of eval runs, personas, scenarios, sets, and runtime/session configuration as a first-class project surface.

## Changes Made In This Audit

### New knowledge cards added

Added project-feature cards to the session-based ARCH knowledge router:

- `project-runtime-quality`
- `project-integrations-config`
- `project-workflows-orchestration`
- `project-io-governance`

These cards teach ARCH to:

- Recognize the real product feature families
- Distinguish between direct tool coverage and conceptual knowledge
- Avoid hallucinating live executor coverage where none exists

### Golden-corpus coverage improved

Added scenarios for:

- Previously uncovered construct cards:
  - `memory-full`
  - `nlu-intents`
  - `limitations`
  - `respond-construct`
  - `constraints-advanced`
  - `multi-supervisor`
  - `stateful-flows`
  - `cross-agent-validation`
- New project feature cards

Also changed the coverage test to read registered card IDs from the router instead of keeping a stale hard-coded list.

### Read-only context tool access improved

Expanded in-project specialist allowlists so routed specialists can call:

- `platform_context`
- `read_journal`

This closes one prompt/tool mismatch without broadening destructive access.

## Recommended Follow-Ups

1. Unify the two backend ARCH knowledge stacks.

- Reuse the package knowledge-card router inside `/api/arch-ai/chat`, or retire the older route.

2. Add first-class project executors for the biggest blind spots.

- Workflow/HITL
- Connections/MCP/config variables
- Project IO/governance

3. Add explicit "feature family ownership" guidance to ARCH responses.

- ARCH should say "this exists in the project surface, but I do not have a live executor for it in this session" instead of guessing.

4. Add backend tests for specialist tool allowlists.

- The prompt/tool mismatch around `platform_context` and `read_journal` was easy to miss because current tests cover tool definitions, not routed specialist availability.

## Bottom Line

Today’s backend ARCH engine is good at agent design knowledge and reasonably good at runtime diagnosis, but not yet good enough at full application knowledge across all project-level features.

After this audit, the v3 session-based backend is better at recognizing the real project surface and admitting when executor coverage is missing. The remaining biggest gap is architectural: there are still two backend ARCH paths with different knowledge models, and the older `/api/arch-ai/chat` path remains materially behind the session-based engine.
