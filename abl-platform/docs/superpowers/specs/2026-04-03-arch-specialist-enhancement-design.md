# ARCH Specialist Enhancement — Staged Pipeline Design

> **Date:** 2026-04-03
> **Branch:** Archv03
> **Status:** DESIGN APPROVED
> **Problem:** ARCH generates flat agent lists with no topology intelligence, generic agents missing 15+ ABL constructs, and unreliable ABL output that falls back to minimal stubs.
> **Solution:** 3-stage pipeline — Topology Reasoning, Parallel Agent Enrichment, Compile-Fix Loop — combining prompt-embedded pattern knowledge with tool-based platform discovery.

### Implementation Target Scope

> **Decision (P0 review finding):** This plan targets the **current Studio home-context generation stack only** — the code in `apps/studio/src/lib/arch-ai/` and `apps/studio/src/services/arch.service.ts` that powers the working `generate_topology` / `generate_agents` orchestration via Vercel AI SDK tools.
>
> The canonical Arch phased contracts (`contracts/tool-registry.md`, `contracts/prompt-architecture.md`, `contracts/tool-call-sequences.md`) describe the **v0.3 phased coordinator architecture** which models Build around per-agent `generate_agent` + `compile_abl` tools driven by a coordinator state machine. That architecture is not yet built (all 75 manifest features are in SPEC status).
>
> **This plan does NOT revise the canonical phased contracts.** When the phased coordinator is built, it should adopt the patterns from this enhancement:
>
> - The construct catalog and `getRelevantConstructs()` helper should back the `generate_agent` tool's internal prompt enrichment
> - The `compileAndFix()` loop should back the `compile_abl` tool's error-feedback behavior
> - The topology pattern catalog should be embedded in the Multi-Agent Architect specialist prompt
> - The canonical edge type enum defined here should be used by the coordinator's topology validation
>
> But the phased contracts themselves are not modified by this plan — they describe a different execution surface.

---

## 1. Problem Statement

### What's Broken

The ABL platform supports **25+ constructs** (MEMORY, NLU, Behavior Profiles, Rich Content, Actions, Attachments, Destinations, Omnichannel, advanced GATHER, CONSTRAINTS checkpoints, Hooks, 147+ models, 3-tier guardrails, 7 tool binding types). **ARCH only knows about ~8 of them** (AGENT, SUPERVISOR, GOAL, PERSONA, TOOLS, basic GATHER, basic CONSTRAINTS, HANDOFF).

| Area                   | Current State                                                          | Desired State                                                                           |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Topology**           | Always produces supervisor + N specialists regardless of use case      | Reasons about 5 patterns, picks the right one with rationale                            |
| **Agent richness**     | Minimal: PERSONA + GOAL + optional TOOLS/GATHER                        | Deep: MEMORY, CONSTRAINTS, FLOW, NLU, Guardrails, proper tool bindings, model selection |
| **ABL reliability**    | ~50%+ LLM-generated ABL fails validation → falls back to minimal stubs | Generate-compile-fix loop (max 3 rounds) produces rich, valid ABL                       |
| **Platform awareness** | Hardcoded ABL syntax reference covering ~30% of constructs             | Tool-based discovery of relevant constructs per agent role                              |

### Root Causes

1. **Topology generation prompt has no pattern vocabulary** — it says "design an optimal topology" without defining what patterns exist or when to use each
2. **ABL syntax reference is incomplete** — the `ABL_SYNTAX_REFERENCE` in `abl-reference.ts` covers basic constructs only; 15+ constructs are missing entirely
3. **No construct selection intelligence** — every agent gets the same minimal template regardless of its role (a data collection agent should get advanced GATHER + MEMORY; a routing supervisor should get NLU + CONSTRAINTS)
4. **Stub fallback destroys richness** — when LLM output fails validation, `buildAbl()` produces minimal ABL (PERSONA + GOAL only), losing all the LLM's design work
5. **Single-shot generation** — one LLM call must produce everything; no iteration on compiler errors

---

## 2. Architecture: 3-Stage Pipeline

### Design Decision: Prompts for Bounded Knowledge, Tools for Dynamic Knowledge

The core question was: build more tools to read system capabilities, or prompt agents with relevant details?

**Answer: both, strategically.**

- **Prompts** for bounded, stable knowledge: topology patterns (5 patterns, ~2K tokens, rarely changes)
- **Tools** for large, dynamic, context-dependent knowledge: platform constructs (25+, varies by agent role), model capabilities (147+ models, changes frequently), guardrail options

This avoids the failure modes of pure approaches:

- Pure prompt: 30K+ token prompts where the LLM ignores details
- Pure tools: LLM doesn't know what to ask for if it doesn't know what exists

### Pipeline Overview

```
User Brief (from Interview)
        |
        v
+----------------------------------------------+
|  STAGE 1: TOPOLOGY REASONING                 |
|  Single LLM call with pattern catalog        |
|  Output: pattern choice + agent graph        |
|  => Shown to user immediately (~5s)          |
+--------------------+-------------------------+
                     |
        +------------+------------+----------+
        v            v            v          v
+-------------++-----------++--------++--------+
| STAGE 2a:   || STAGE 2b: ||  2c:   ||  2d:   |
| Agent 1     || Agent 2   || Agt 3  || Agt N  |
| +---------+ || +-------+ ||        ||        |
| |discover | || |discover| ||  ...   ||  ...   |
| |constructs||| |constr. | ||        ||        |
| +---------+ || +-------+ ||        ||        |
| |generate | || |generate| ||        ||        |
| |rich ABL | || |rich ABL| ||        ||        |
| +---------+ || +-------+ ||        ||        |
+------+------++-----+-----++---+----++---+----+
       +-------------+----------+---------+
                     |
                     v
+----------------------------------------------+
|  STAGE 3: COMPILE-FIX + CROSS-VALIDATE       |
|  3a: Parallel compile per agent (max 3 rounds)|
|  3b: Sequential cross-agent validation        |
|  Output: validated, compilable project        |
+----------------------------------------------+
```

**Key properties:**

- **Progressive output** — topology visible after Stage 1 (~5s), agents stream as Stage 2 completes
- **Parallel Stage 2** — all agents generated concurrently (no cross-agent dependencies during generation)
- **Cross-validation deferred** — handoff consistency checked in Stage 3 only, after all agents exist
- **3 internal helpers + 1 specialist-visible tool** — see Tool Surface Model below

### Tool Surface Model

> **Decision (P0 review finding):** The 4 new capabilities are NOT all specialist-visible canonical tools. They split into two categories:

**Internal helpers** (called by `generate_topology` / `generate_agents` orchestration, invisible to the LLM):

- `getRelevantConstructs()` — called inside `generateSingleAgent()` to enrich the per-agent prompt before the LLM call
- `getModelRecommendation()` — called inside `generateSingleAgent()` to inject model config into the prompt
- `compileAndFix()` — called inside `generateSingleAgent()` after the LLM returns ABL, replacing the current compile+stub logic

**Specialist-visible tool** (registered in the canonical tool registry, callable by the LLM):

- `get_topology_patterns` — available in **project mode only**, for in-project topology modification queries ("Should I restructure?", "What pattern alternatives exist?")

The existing specialist-visible tools remain unchanged:

- **Home context:** `ask_user`, `collect_file`, `generate_topology`, `generate_agents`, `create_project`
- **Project context:** all existing tools + `get_topology_patterns` (new)

This means the LLM interaction model stays simple: the specialist calls `generate_topology` and `generate_agents` as before. The pipeline intelligence is inside those tools, not exposed as additional LLM tool calls. This avoids the "LLM must orchestrate 6 tools in the right order" problem.

---

## 3. Stage 1: Topology Reasoning

### Current Problem

`generateTopology()` in `arch.service.ts` uses a prompt that says "design an optimal topology" but provides no vocabulary of patterns. Result: always supervisor + N specialists.

### Solution: Pattern Catalog in Prompt

Embed a concise **Topology Pattern Catalog** (~2K tokens) directly in the topology generation prompt. This is bounded, stable knowledge — 5 patterns that rarely change.

### The 5 Topology Patterns

| Pattern                   | When to Use                                                                      | Structure                                                               | ABL Implications                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Single Agent**          | 1 domain, no routing, simple Q&A or task completion                              | 1 AGENT (reasoning or hybrid)                                           | No HANDOFF needed. GATHER + TOOLS + CONSTRAINTS only.                                                                          |
| **Triage -> Specialists** | Multiple distinct domains, user intent determines routing                        | 1 SUPERVISOR (NLU routing) -> N AGENT nodes                             | Supervisor needs NLU + HANDOFF. Specialists are independent. Most common pattern.                                              |
| **Pipeline**              | Sequential workflow, each stage transforms/enriches before passing to next       | Chain of AGENTs with `pipeline_next` edges                              | Each agent does one job and hands off. FLOW-driven (scripted/hybrid). GATHER in early stages, TOOLS in middle, RESPOND at end. |
| **Hub-and-Spoke**         | Central coordinator delegates subtasks, needs results back                       | 1 SUPERVISOR with `delegate` edges -> N workers with `return_to_parent` | Supervisor uses `__delegate__` (stack-based). Workers use `__return_to_parent__`. Supervisor aggregates results.               |
| **Mesh**                  | Peer agents route to each other based on context, multiple entry points possible | N AGENTs with bidirectional `handoff` edges                             | Requires `allowCycle` on edges. Each agent needs CONSTRAINTS to know when to hand off. Complex — use sparingly.                |

### Selection Decision Tree (embedded in prompt)

```
Q1: How many distinct capability domains?
  -> 1 domain -> SINGLE AGENT
  -> 2+ domains:
    Q2: Is the workflow sequential (each step feeds the next)?
      -> Yes -> PIPELINE
      -> No:
        Q3: Does a central agent need results back from sub-agents?
          -> Yes -> HUB-AND-SPOKE
          -> No:
            Q4: Can users enter from multiple points / agents are peers?
              -> Yes -> MESH
              -> No -> TRIAGE -> SPECIALISTS
```

### Canonical Edge Type Enum

> **Decision (P0 review finding):** The edge type enum was inconsistent across the spec, existing feature docs (S2-F02 uses `delegate | escalate | transfer`), and the prompt redesign section. This is the single canonical definition.

| Edge Type       | Semantics                                                                                  | Pattern Usage                | `returnsControl` |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------- | ---------------- |
| `routing`       | Supervisor intent-based routing. Supervisor stays active, selects target by NLU/condition. | Triage->Specialists          | `false`          |
| `delegate`      | Stack-based. Parent pauses, child executes, child returns control + context to parent.     | Hub-and-Spoke                | `true`           |
| `handoff`       | Full transfer with no return. Source agent exits, target takes over completely.            | Triage (after routing), Mesh | `false`          |
| `escalation`    | Human handoff. Conversation leaves the automated system entirely.                          | Any pattern                  | `false`          |
| `pipeline_next` | Sequential chain. Source completes its stage, passes enriched context to next stage.       | Pipeline                     | `false`          |

**Dropped:** `transfer` (was an alias for `handoff` — merged into `handoff`).
**Renamed:** `escalate` → `escalation` (noun form, consistent with other edge type names).

All validators, canvas labels, build-order logic, cross-agent validation, and specialist prompts MUST use this enum. The S2-F02 feature spec's `delegate | escalate | transfer` is superseded by this table.

### Enhanced Topology Output Schema

```typescript
interface TopologyDecision {
  pattern: 'single_agent' | 'triage_specialists' | 'pipeline' | 'hub_spoke' | 'mesh';
  reasoning: string; // WHY this pattern fits the use case
  nodes: {
    id: string;
    name: string;
    type: 'supervisor' | 'agent';
    role: string; // What this agent is responsible for
    executionMode: 'reasoning' | 'scripted' | 'hybrid';
    isEntry: boolean;
    suggestedConstructs: string[]; // Hints for Stage 2 (e.g., ['GATHER', 'MEMORY', 'FLOW'])
  }[];
  edges: {
    from: string;
    to: string;
    type: 'routing' | 'handoff' | 'delegate' | 'escalation' | 'pipeline_next'; // Canonical enum — see table above
    condition: string;
    returnsControl: boolean; // Derived from type: true only for 'delegate'
  }[];
}
```

### What Changes

| File                                          | Change                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `arch.service.ts` `generateTopology()`        | New system prompt with pattern catalog + decision tree                                      |
| `PromptCatalog.arch.generate.topology_system` | Rewritten with 5 patterns, selection criteria, anti-patterns                                |
| `PromptCatalog.arch.generate.topology_user`   | Enhanced to pass domain analysis from interview                                             |
| Topology Zod schema                           | Add `pattern`, `role`, `suggestedConstructs`, `returnsControl` fields                       |
| `generateTopologyStub()`                      | Replace with pattern-aware stub (single agent stub for simple cases, not always supervisor) |

---

## 4. Stage 2: Parallel Agent Enrichment

### Current Problem

`generateSingleAgent()` gets a minimal prompt: agent name, connections, and "Output valid JSON only." It knows nothing about which ABL constructs are relevant to the agent's role. Result: generic PERSONA + GOAL + maybe TOOLS.

### Solution: Discovery Tool + Parallel Generation

Each agent's generation gets two steps (sequential within the agent, parallel across agents):

1. **Construct discovery** — call `get_relevant_constructs(agentRole, domain)` to get only the ABL constructs relevant to this agent
2. **Rich generation** — LLM generates ABL with full knowledge of relevant constructs + examples

### New Tool: `get_relevant_constructs`

**Purpose:** Given an agent's role and domain, return the ABL constructs it should use, with syntax reference and examples.

**Implementation:** A deterministic mapping function (not an LLM call) that selects from the full construct catalog based on agent characteristics.

```typescript
function getRelevantConstructs(input: {
  agentRole: string; // e.g., "data_collection", "routing", "processing", "coordinator"
  agentType: 'supervisor' | 'agent';
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  domain: string; // e.g., "insurance", "ecommerce", "healthcare"
  suggestedConstructs: string[]; // Hints from topology stage
  hasComplianceRequirements: boolean;
  hasVoiceChannel: boolean;
}): ConstructCatalogResponse;
```

**Construct selection rules:**

| Agent Characteristic                       | Constructs Included                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Any agent                                  | AGENT/SUPERVISOR, GOAL, PERSONA, TOOLS (always)                                            |
| `agentType === 'supervisor'`               | HANDOFF, NLU (intent routing), CONSTRAINTS (routing rules)                                 |
| `executionMode === 'scripted' or 'hybrid'` | FLOW (step definitions), ON_START                                                          |
| Role involves data collection              | Advanced GATHER (depends_on, ranges, semantics, lookup, validation), MEMORY (session vars) |
| Role involves conversation management      | MEMORY (persistent facts, REMEMBER/RECALL), TEMPLATES (response templates)                 |
| `hasComplianceRequirements`                | GUARDRAILS (3-tier), CONSTRAINTS (REQUIRE/WARN/LIMIT with ON_FAIL)                         |
| `hasVoiceChannel`                          | Voice config (SSML, TTS provider), GATHER voice_prompt, barge_in                           |
| Role involves external integrations        | Tool binding types (HTTP with auth, MCP, sandbox, connector, async_webhook)                |
| Hub-spoke coordinator                      | HOOKS (on_delegate_complete), MEMORY (aggregation state)                                   |
| Pipeline agent                             | ON_START, FLOW, COMPLETE (pass to next condition)                                          |
| Any agent with user interaction            | Rich Content reference (carousels, quick replies, tables, forms)                           |
| Any agent                                  | EXECUTION config (model selection, temperature, compaction)                                |

**Each construct entry includes:**

- Syntax reference (valid ABL YAML)
- 1-2 examples relevant to the domain
- Common mistakes to avoid
- When NOT to use it

**Token budget:** ~3-5K tokens per agent (only relevant constructs), vs 30K+ if all constructs were included.

### New Tool: `get_model_recommendation`

**Purpose:** Recommend model configuration from the 147+ model registry based on agent requirements.

```typescript
function getModelRecommendation(input: {
  agentRole: string;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  requiresToolCalling: boolean;
  requiresVision: boolean;
  requiresStructuredOutput: boolean;
  complexityTier: 'simple' | 'moderate' | 'complex';
  operations?: string[]; // e.g., ['extraction', 'summarization', 'coordination']
}): ModelRecommendation;
```

**Returns:**

```typescript
interface ModelRecommendation {
  primary: { provider: string; model: string; reason: string };
  perOperation?: Record<string, { provider: string; model: string; reason: string }>;
  executionConfig: {
    temperature: number;
    maxTokens: number;
    compactionPolicy?: string;
  };
}
```

**Implementation:** Wraps the existing `model-selector.ts` and `model-capabilities.ts` from `packages/compiler/`. No new model logic — just surfaces existing platform intelligence to ARCH.

### Parallel Execution

```
Topology output (N agents)
        |
        +---> Agent 1: getRelevantConstructs() -> generate ABL  --+
        +---> Agent 2: getRelevantConstructs() -> generate ABL  --+-- All parallel
        +---> Agent 3: getRelevantConstructs() -> generate ABL  --+
        +---> Agent N: getRelevantConstructs() -> generate ABL  --+
                                                                   |
                                                                   v
                                                          Stage 3 (compile)
```

**No conflicts:** Each agent's construct selection and ABL generation are independent. Cross-agent concerns (handoff consistency, duplicate tool bindings) are deferred to Stage 3.

### What Changes

| File                                                                 | Change                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| New: `apps/studio/src/lib/arch-ai/tools/get-relevant-constructs.ts`  | Construct catalog + selection logic                                                    |
| New: `apps/studio/src/lib/arch-ai/tools/get-model-recommendation.ts` | Model recommendation wrapping compiler's model-selector                                |
| New: `apps/studio/src/lib/arch-ai/construct-catalog.ts`              | Full ABL construct catalog (25+ constructs with syntax + examples)                     |
| `arch.service.ts` `generateSingleAgent()`                            | Enhanced prompt: inject relevant constructs + model recommendation                     |
| `abl-builder.ts`                                                     | Enhanced fallback: use construct hints to build richer stubs (not just PERSONA + GOAL) |

---

## 5. Stage 3: Compile-Fix Loop

### Current Problem

If LLM-generated ABL fails parser/compiler validation, the system falls back to `buildAbl()` which produces minimal stubs. All the LLM's design work (MEMORY, CONSTRAINTS, FLOW, etc.) is lost.

### Solution: Iterative Compile-Fix

```
For each agent (parallel):
  Round 0: Compile LLM output
    -> Pass? Done.
    -> Fail? Extract errors, feed back to LLM
  Round 1: LLM fixes based on compiler errors
    -> Pass? Done.
    -> Fail? Extract errors, feed back to LLM
  Round 2: LLM fixes again
    -> Pass? Done.
    -> Fail? Fall back to enhanced stub (construct-aware, not minimal)

Then (sequential):
  Cross-agent validation:
    - Handoff targets exist
    - Delegate return paths are complete
    - No orphan agents (unreachable from entry)
    - Tool name consistency across agents
    - Guardrail scope consistency
```

### Internal Helper: `compileAndFix`

> **Decision (P1 review finding):** `compileAndFix` is an **internal helper for auto-generation only**. It does NOT replace `compile_abl`.
>
> - `compile_abl` — the existing specialist-visible tool and Monaco editor primitive. Used for: user-initiated recompiles, Monaco edit → recompile cycles, race-safe user iteration (debounced, single-file). **Unchanged.**
> - `compileAndFix()` — internal function called by `generateSingleAgent()` after LLM returns ABL. Used for: auto-generation compile-fix loop only. Includes LLM fix rounds. **Not exposed as a tool.**
>
> The two share the same underlying compiler (`@abl/core` parser + `@abl/compiler`) but serve different purposes with different retry semantics.

**Purpose:** Compile LLM-generated ABL, return structured errors, auto-fix via LLM retry.

```typescript
function compileAndFix(input: {
  agentName: string;
  ablContent: string;
  maxRounds: number; // default: 3
  allAgentNames: string[]; // for cross-reference validation
}): CompileResult;
```

**Returns:**

```typescript
interface CompileResult {
  success: boolean;
  rounds: number;
  finalAbl: string; // The working ABL (fixed or original)
  errors?: CompileError[]; // Only if still failing after max rounds
  warnings?: CompileWarning[];
  constructs_used: string[]; // Which ABL constructs are in the final output
}
```

**Implementation:** Wraps existing `@abl/core` parser + `@abl/compiler`. The LLM fix step is a **new, separate LLM call** (not a continuation of the generation call) that receives: the original ABL, the compiler errors with line numbers, and the relevant construct catalog. This is a focused "fix this code" call, not a full re-generation — keeping it fast (~2-3s per fix round).

### Enhanced Stub Fallback

When all 3 compile-fix rounds fail, the fallback is no longer minimal. The enhanced `buildAbl()` uses `suggestedConstructs` from the topology to produce richer stubs:

| Current Stub            | Enhanced Stub                                                  |
| ----------------------- | -------------------------------------------------------------- |
| PERSONA + GOAL only     | PERSONA + GOAL + GATHER (with field definitions from topology) |
| No CONSTRAINTS          | CONSTRAINTS based on compliance requirements                   |
| No MEMORY               | MEMORY with session vars for data collection agents            |
| No FLOW                 | FLOW skeleton for scripted/hybrid agents                       |
| Generic tool signatures | Tool signatures matching platform tool types                   |

### What Changes

| File                                                        | Change                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| New: `apps/studio/src/lib/arch-ai/tools/compile-and-fix.ts` | Iterative compile-fix loop                                           |
| `arch.service.ts`                                           | Remove single-shot compile + stub fallback; use compile-and-fix tool |
| `abl-builder.ts` `buildAbl()`                               | Enhanced with construct-aware stub generation                        |
| Cross-agent validation                                      | New function checking handoff targets, delegate returns, orphans     |

---

## 6. New Tool: `get_topology_patterns`

While the pattern catalog is embedded in the topology prompt, a separate tool allows the LLM to query patterns during in-project mode (when modifying existing topologies).

```typescript
function getTopologyPatterns(input: {
  filter?: 'all' | 'simple' | 'complex';
  currentPattern?: string; // For "what alternatives exist?" queries
}): PatternCatalog;
```

**Returns:** The same 5-pattern catalog with selection criteria, but as structured data the LLM can reason about.

**Use cases:**

- In-project: "Should I add another agent or restructure the topology?"
- Blueprint iteration: "The current triage pattern doesn't fit anymore, what else?"

---

## 7. Specialist Prompt Redesign

### Multi-Agent Architect (Topology Specialist)

**Current prompt** (in `docs/arch/prompts/multi-agent-architect.md`): Lists 4 patterns but provides no selection criteria, no decision tree, no anti-patterns.

**Enhanced prompt adds:**

1. Pattern selection decision tree (Section 3 of this doc)
2. Anti-patterns: "Never use mesh for <3 agents", "Never use pipeline when steps can run in parallel", "Single agent is valid — don't add a supervisor for 1 agent"
3. `suggestedConstructs` — the architect annotates each agent with which ABL constructs it should use, giving Stage 2 targeted guidance
4. Edge type semantics: canonical enum (`routing`, `delegate`, `handoff`, `escalation`, `pipeline_next`) — see Section 3 Canonical Edge Type Enum
5. Topology completeness checks: fallback handler, escalation path, entry point validation

### ABL Construct Expert (Agent Specialist)

**Current prompt** (in `docs/arch/prompts/abl-construct-expert.md`): Covers basic AGENT, TOOLS, GATHER, FLOW, CONSTRAINTS. Missing 15+ constructs.

**Enhanced prompt adds:**

1. **Richer construct knowledge** — the orchestration injects relevant constructs (via internal `getRelevantConstructs()`) into the per-agent prompt before the LLM call. The specialist sees a focused ~3-5K token construct reference tailored to its agent's role, not a generic reference.
2. **Model recommendation** — the orchestration injects model config (via internal `getModelRecommendation()`) so the specialist can generate accurate EXECUTION sections.
3. **Compile error context** — if the compile-fix loop detects errors, the specialist is re-prompted with the errors and asked to fix. The prompt includes: "Fix the following compilation errors in the ABL code. Preserve all construct usage. Only change what the error messages indicate."
4. **Generate-compile-fix discipline** — the prompt instructs: "Generate complete ABL using all relevant constructs for this agent's role. The system will compile and may ask you to fix errors."
5. **Cross-agent awareness note** — the prompt includes the full agent name list and topology edges so the specialist generates correct handoff targets and tool references.

### Prompt Token Budget

| Component                                        | Tokens (est.)                                        |
| ------------------------------------------------ | ---------------------------------------------------- |
| Base persona (Layer 1)                           | ~500                                                 |
| Multi-Agent Architect specialist (Layer 2)       | ~3,000 (up from ~1,500)                              |
| ABL Construct Expert specialist (Layer 2)        | ~2,000 (down from ~2,500 — constructs moved to tool) |
| Phase context (Layer 3)                          | ~500                                                 |
| Dynamic context — brief + conversation (Layer 4) | ~2,000-5,000                                         |
| **Per-agent construct catalog (via tool)**       | **~3,000-5,000**                                     |
| **Total per generation call**                    | **~8,000-13,000**                                    |

This is well within the ~48K context budget defined in the prompt-architecture contract. The key win: each agent gets ~3-5K of **relevant** constructs instead of 30K of everything.

---

## 8. Integration with Existing Code

### Files Modified (not replaced)

| File                                                     | Modification                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/services/arch.service.ts`               | `generateTopology()`: new prompt with pattern catalog. `generateSingleAgent()`: inject construct discovery + model recommendation. Remove stub-only fallback, use compile-fix loop. |
| `apps/studio/src/lib/arch-ai/abl-builder.ts`             | `buildAbl()`: enhanced with construct-aware stub generation using `suggestedConstructs`                                                                                             |
| `apps/studio/src/lib/arch-ai/abl-reference.ts`           | Deprecated — constructs moved to `construct-catalog.ts` (tool-served, not prompt-embedded)                                                                                          |
| `apps/studio/src/lib/arch-ai/tools/generate-topology.ts` | Enhanced Zod schema for topology output                                                                                                                                             |
| `apps/studio/src/lib/arch-ai/tools/generate-agents.ts`   | Orchestrate parallel Stage 2 + Stage 3                                                                                                                                              |
| `packages/shared/src/prompts/prompt-catalog.ts`          | Updated `arch.generate.*` templates                                                                                                                                                 |
| `docs/arch/prompts/multi-agent-architect.md`             | Rewritten with pattern catalog + decision tree                                                                                                                                      |
| `docs/arch/prompts/abl-construct-expert.md`              | Rewritten with tool-first workflow                                                                                                                                                  |

### New Files

| File                                                              | Purpose                                                                  | Surface                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| `apps/studio/src/lib/arch-ai/construct-catalog.ts`                | Full ABL construct catalog (25+ constructs) with selection logic         | Internal module                            |
| `apps/studio/src/lib/arch-ai/helpers/get-relevant-constructs.ts`  | Internal helper: returns relevant constructs for an agent role           | Internal (called by `generateSingleAgent`) |
| `apps/studio/src/lib/arch-ai/helpers/get-model-recommendation.ts` | Internal helper: recommends model config from platform registry          | Internal (called by `generateSingleAgent`) |
| `apps/studio/src/lib/arch-ai/helpers/compile-and-fix.ts`          | Internal helper: iterative compile-fix loop                              | Internal (called by `generateSingleAgent`) |
| `apps/studio/src/lib/arch-ai/tools/get-topology-patterns.ts`      | Specialist-visible tool: pattern catalog for in-project topology queries | Project context tool registry              |
| `apps/studio/src/lib/arch-ai/cross-agent-validator.ts`            | Cross-agent validation (handoffs, orphans, consistency)                  | Internal module                            |

### No Breaking Changes

- All existing tools (`generate_topology`, `generate_agents`, `create_project`) keep their external interface
- The `generate_topology` tool output is a superset of the current schema (new fields are additive)
- The `generate_agents` tool output format is unchanged (agents array with name + ablContent + validation)
- Frontend components consuming topology/agent data require no changes (new fields are optional)

---

## 9. Progressive UX Flow

### Timeline (estimated)

| Phase                                | Time          | User Sees                                                                                                          |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stage 1: Topology reasoning          | ~5s           | Topology pattern + agent graph appears. "I chose the Pipeline pattern because your loan workflow is sequential..." |
| Stage 2: Agent generation (parallel) | ~10-15s total | Agents generated concurrently; review gates buffered and revealed in `buildOrder` sequence (see below).            |
| Stage 3: Compile-fix                 | ~3-8s         | Compile status per agent. Fix rounds shown as progress.                                                            |
| Cross-validation                     | ~2s           | "All agents validated. Handoff targets verified. Ready to create."                                                 |
| **Total**                            | **~20-30s**   | vs current ~10-25s, but output quality is dramatically higher                                                      |

### Generation vs Review Ordering

> **Decision (P1 review finding):** Parallel generation and sequential review gates are separate concerns.

- **Generation** may complete out of order (Agent 3 finishes before Agent 1). This is expected and beneficial for latency.
- **Review gates** (S3-F05) are **buffered and revealed in `buildOrder` sequence**. If Agent 3 finishes first, its review gate is held until Agent 1 and Agent 2 have been reviewed. The coordinator maintains a `completedAgents: Map<string, GeneratedAgent>` buffer; when the next agent in `buildOrder` is available in the buffer, its review gate is presented.
- **Progress indicators** show all agents' generation status simultaneously (spinning/done/failed), so the user sees work happening in parallel. But the Accept/Modify/Reject gates appear one at a time in `buildOrder`.
- This preserves the S3-F05 sequential review contract while gaining parallel generation performance.

### Failure Modes

| Failure                             | Handling                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology LLM call fails             | Retry once with simpler prompt (just brief, no catalog). If still fails, ask user to simplify requirements.                                   |
| Agent generation LLM call fails     | Retry once. If still fails, use enhanced stub (construct-aware) and mark agent as "needs review".                                             |
| Compile-fix exhausts 3 rounds       | Use enhanced stub. Flag to user: "Agent X needed manual review — the ABL was too complex for auto-generation. Here's a solid starting point." |
| Cross-agent validation finds issues | Auto-fix where possible (add missing handoff targets). Flag remaining issues to user.                                                         |

---

## 10. Use Case Validation

Testing this design against the existing use cases in `docs/arch/usecases/`:

| Use Case                   | Current Result                  | Expected with Pipeline                                                                     |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| UC-01 FAQ Assistant        | Supervisor + 1 agent (overkill) | **Single Agent** pattern. 1 reasoning agent with TOOLS + basic CONSTRAINTS.                |
| UC-02 Account Intake       | Supervisor + intake agent       | **Single Agent** (hybrid). Advanced GATHER (depends_on, validation), MEMORY, FLOW.         |
| UC-04 Document Intake      | Supervisor + agents             | **Pipeline**. Upload -> Extract -> Classify -> Store. Each agent scripted with FLOW.       |
| UC-05 Support Router       | Supervisor + specialists        | **Triage -> Specialists**. Supervisor with NLU intent routing. Correct pattern.            |
| UC-07 Knowledge Research   | Supervisor + research agents    | **Hub-and-Spoke**. Coordinator delegates to search/analysis/summary, aggregates results.   |
| UC-10 Distributed War Room | Complex multi-agent             | **Mesh** or **Hub-and-Spoke** depending on peer vs hierarchical. ARCH reasons about which. |

This is the key improvement: UC-01 currently gets a supervisor (unnecessary), UC-04 gets a flat list (should be a pipeline), UC-07 gets handoffs (should be delegates). The pattern catalog fixes all of these.

---

## 11. Impact Analysis

### Impacted Manifest Features

| Feature ID                                | Impact                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| S2-F02 (Multi-Agent Architect specialist) | **Major** — prompt rewrite with pattern catalog                     |
| S2-F04 (BlueprintOutput data structure)   | **Minor** — add `pattern` and `suggestedConstructs` fields          |
| S3-F01 (ABL Construct Expert specialist)  | **Major** — prompt rewrite with tool-first workflow                 |
| S3-F03 (Per-agent ABL generation)         | **Major** — parallel generation with construct discovery            |
| S3-F04 (Compiler integration)             | **Major** — compile-fix loop replaces single-shot compile           |
| S3-F12 (Cross-agent validation)           | **Minor** — validation logic already spec'd, now has concrete rules |
| S2-F05 (Topology canvas)                  | **None** — topology output is a superset, canvas renders same graph |

### Impacted Contracts

> **Correction (P2 review finding):** TopologyOutput changes belong in BlueprintOutput / tool contracts, not specification-schema.md. Specification schema covers Interview output (the brief), not Blueprint output.

| Contract                                  | Impact                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- | ------- | -------- | ---------- | -------------- |
| `contracts/tool-registry.md`              | **Add** `get_topology_patterns` as specialist-visible tool in project context. Document `getRelevantConstructs`, `getModelRecommendation`, `compileAndFix` as internal helpers (not in tool registry but referenced for completeness). |
| `contracts/prompt-architecture.md`        | **Update** token budget estimates, note internal-helper-based construct delivery (not tool-based from LLM perspective)                                                                                                                 |
| `S2-F04` (BlueprintOutput data structure) | **Update** TopologyOutput schema: add `pattern`, `reasoning`, `role`, `suggestedConstructs` on nodes; normalize edge types to canonical enum; add `returnsControl` on edges                                                            |
| `S2-F02` (Multi-Agent Architect)          | **Update** edge type enum from `delegate                                                                                                                                                                                               | escalate | transfer`to canonical`routing | handoff | delegate | escalation | pipeline_next` |

### Risk Assessment

| Risk                                        | Likelihood | Mitigation                                                                                          |
| ------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| Construct catalog becomes stale vs platform | Medium     | Catalog reads from compiler source (model-capabilities.ts, parser keywords). Add a sync script.     |
| More LLM calls increase latency             | Low        | Stage 2 is parallel. Tools are deterministic (no LLM). Net overhead is ~5s for much better quality. |
| Compile-fix loop adds complexity            | Low        | Wrapper around existing parser+compiler. Loop logic is simple (compile, check errors, retry).       |
| Pattern decision tree is too rigid          | Low        | Decision tree is a guide, not a constraint. The LLM can override with reasoning.                    |

---

## 12. Open Question Resolutions

> These were raised during design review and resolved here.

**Q1: Should `getModelRecommendation()` output be persisted in BlueprintOutput.perAgent?**

**A: No — modelConfig is a Build-time artifact, NOT part of BlueprintOutput.**

> **Decision (P1 review finding, round 4):** BlueprintOutput is immutable once approved (S2-F04 requirement 8). Model selection is an implementation detail that depends on agent complexity and the live model registry — it belongs in Build, not Blueprint.

**Lifecycle:**

1. **Blueprint phase** — BlueprintOutput approved and frozen. Contains architectural decisions only (topology, roles, tools, constraints, persona). No modelConfig. Blueprint spec cards (S2-F08) do NOT show model recommendations.
2. **Build start** — for each agent in buildOrder, `getModelRecommendation()` runs based on agent role/complexity from the frozen BlueprintOutput. Results stored in `session.metadata.buildState.modelConfigs[agentName]`.
3. **Build generation** — `generateSingleAgent()` reads modelConfig from `buildState.modelConfigs[agentName]` and injects it into the per-agent prompt.
4. **Build review gate** — the `agent_review` gate shows the generated ABL (including the EXECUTION section with model config) + a "Model Selection" summary showing provider/model/reason. Users can override the model choice here before accepting.
5. **Override** — user edits update `buildState.modelConfigs[agentName]`, triggering re-generation of the agent's EXECUTION section.
6. **Project creation** — final modelConfig is baked into each agent's compiled EXECUTION section.

**Storage:** `session.metadata.buildState.modelConfigs: Record<agentName, ModelRecommendation>` — separate from the immutable BlueprintOutput. Build-phase state is mutable by design.

**Q2: Should the >95% valid ABL metric exclude enhanced-stub fallbacks?**

**A: Yes — the metric measures true compile-fix quality.** Two separate metrics:

- **Compile-fix success rate:** % of agents where the LLM's ABL (original or fixed) passes compilation. Target >95%. Enhanced stubs are counted as **failures** for this metric.
- **Overall generation completeness:** % of agents that have valid, compilable ABL (including enhanced stubs). Target 100% — every agent should have _something_ compilable, even if it's a stub.

This way we can track whether the pipeline is actually producing quality ABL vs just falling back gracefully.

---

## 13. Success Criteria

| Criterion                       | Measurement                                                                           | Metric Definition                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Topology pattern diversity      | Run all 10 use cases — at least 3 different patterns should be selected               | Count distinct `pattern` values across 10 runs                                            |
| Agent construct richness        | Generated agents should average 4+ ABL constructs (vs current 2-3)                    | Count distinct ABL sections per agent, average across all generated agents                |
| Compile-fix success rate        | Target >95% after max 3 rounds                                                        | `(agents with LLM-generated valid ABL) / (total agents)` — stubs count as failures        |
| Overall generation completeness | Target 100%                                                                           | `(agents with any valid ABL, including stubs) / (total agents)`                           |
| First-compile success rate      | Target >70% (vs current ~50%)                                                         | `(agents passing on round 0) / (total agents)`                                            |
| Latency                         | Total generation time <35s for a 4-agent topology                                     | Wall clock from `generate_topology` call to cross-validation complete                     |
| No regressions                  | Existing simple use cases (FAQ, single agent) still work, generate simpler topologies | UC-01 must produce Single Agent pattern, not supervisor + specialist                      |
| Model recommendation accuracy   | Model choices should be appropriate for agent complexity                              | Manual review: simple agents get cost-effective models, complex agents get capable models |
