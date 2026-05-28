# Unified Agent Type — Design Document

**Date:** 2026-03-02

**Goal:** Unify ABL into a single agent type where scripted and reasoning execution modes compose naturally within a single agent definition. MODE is deleted entirely — no deprecation, no backward compatibility layer. All existing examples migrated in one pass.

**Key Codebase Finding:** `MODE` is functionally redundant. The runtime branches on `currentFlowStep !== undefined`, not on `execution.mode`. All constructs (TOOLS, GATHER, CONSTRAINTS, HANDOFF, DELEGATE, MEMORY, GUARDRAILS, etc.) already work in both modes. Only `FLOW` is exclusive to scripted. MODE is checked at compile time in exactly 3 trivial places (voice latency default, gather strategy, flow graph validation) — all replaceable with `hasFlow?`.

**Migration stance:** No production agents exist. All changes are breaking. All existing `.abl` examples are migrated atomically. No backward compatibility code.

**Key Design Decisions:**

1. **GOAL is mandatory** on every agent, no exceptions. It serves as purpose statement for deterministic agents and drives reasoning for reasoning agents.
2. **REASONING: true/false required on every flow step.** No default, fully explicit. `REASONING: true` = reasoning zone, `REASONING: false` = deterministic.
3. **Agent-level GOAL + FLOW** — GOAL is persona/context injected into every step's system prompt. Step-level GOAL overrides it for that step.
4. **GATHER + GOAL in same step** — Natural conversation. LLM collects GATHER fields organically. Validation still enforced.
5. **IR mode field** — Remove `execution.mode` from IR entirely. Runtime derives from `flow` / `currentFlowStep` presence. Step-level `reasoning_zone` presence determines per-step execution.
6. **Realtime voice + mixed steps** — Realtime LLM stays connected throughout. System prompt + tools updated at step boundaries. No mode switching.
7. **MAX_TURNS exceeded** — Escalate. Trigger agent's escalation handler. If no handler defined, emit warning + advance to THEN.
8. **WORKFLOW visibility** — Explicit declarations required. WORKFLOW is organizational only.
9. **Migration script** — Automated script to migrate existing `.abl` files (remove MODE, add GOAL, add REASONING to every step).

---

## The Unified Design

**Core idea:** Delete MODE from agent level. GOAL is mandatory on every agent. Each flow step must explicitly declare `REASONING: true` or `REASONING: false`.

- `REASONING: false` — **deterministic** step (FlowStepExecutor: GATHER, CALL, SET, RESPOND, THEN)
- `REASONING: true` — **reasoning zone** (ReasoningExecutor invoked for that step, bounded by EXIT_WHEN + MAX_TURNS)
- Agent with GOAL + TOOLS but no FLOW — **reasoning-only** (current reasoning behavior)

```
          AGENT (one type, GOAL mandatory)
          |-- GOAL (required), TOOLS, CONSTRAINTS, MEMORY, etc.
          |-- FLOW (optional):
          |     step1: REASONING: false + GATHER + THEN      -> deterministic
          |     step2: REASONING: true + EXIT_WHEN + THEN    -> reasoning zone
          |     step3: REASONING: false + RESPOND + THEN     -> deterministic
          |     step4: HANDOFF other_agent                    -> delegation
          +-- No FLOW: GOAL + TOOLS                          -> reasoning-only
```

### DSL Example — Credit Card Workflow

```abl
AGENT: Credit_Card_Workflow
GOAL: "Guide customer through card recommendation and application"

TOOLS:
  get_eligible_cards(credit_profile) -> Card[]
  compare_cards(card_ids: string[]) -> ComparisonResult
  submit_application(card_id, customer_data) -> {confirmation_id}

CONSTRAINTS:
  - REQUIRE income > 0
    ON_FAIL: RESPOND "Please provide a valid income"
  - REQUIRE selected_card IN eligible_cards
    ON_FAIL: RESPOND "Please choose from the eligible cards"

FLOW:
  collect:
    REASONING: false
    GATHER: income, city, age, employment_type
    CALL: get_eligible_cards(credit_profile)
    AS: eligible_cards
    THEN: advise

  advise:
    REASONING: true
    GOAL: "Have a consultative conversation about spending habits and lifestyle to recommend the best card from the eligible set"
    TOOLS: [compare_cards]
    EXIT_WHEN: selected_card != null
    MAX_TURNS: 8
    THEN: confirm

  confirm:
    REASONING: false
    RESPOND: "You selected {{selected_card.name}} — {{selected_card.annual_fee}}/year"
    GATHER: accept_terms
    CHECK: accept_terms == true
    ON_FAIL: collect
    THEN: submit

  submit:
    REASONING: false
    CALL: submit_application(selected_card.id, customer_data)
    RESPOND: TEMPLATE(confirmation)
    THEN: COMPLETE
```

- `collect` — `REASONING: false` — deterministic: GATHER fields, CALL tool, advance
- `advise` — `REASONING: true` — reasoning zone: LLM converses with user, uses tools, exits when condition met
- `confirm` — `REASONING: false` — deterministic: show result, collect consent
- `submit` — `REASONING: false` — deterministic: call API, show confirmation

Every step's execution mode is explicitly declared. No ambiguity. One workflow.

### DSL Example — Reasoning-Only Agent

```abl
AGENT: General_Assistant
GOAL: "Help users with general questions"
TOOLS:
  search(query) -> SearchResult[]
  calculate(expression) -> number
CONSTRAINTS:
  - REQUIRE response is professional
```

No FLOW. Compiler sees GOAL + TOOLS without FLOW — reasoning-only execution.

### DSL Example — Flow-Only Agent (Deterministic)

```abl
AGENT: Order_Tracker
GOAL: "Help customers track their order status"

FLOW:
  lookup:
    REASONING: false
    GATHER: order_id
    CALL: lookup_order(order_id)
    THEN: show_status
  show_status:
    REASONING: false
    RESPOND: TEMPLATE(order_status)
    THEN: COMPLETE
```

GOAL is mandatory (purpose statement). All steps declare `REASONING: false` — fully deterministic. Agent-level GOAL guides LLM-based extraction in GATHER fields.

---

## Arguments FOR the Unified Design

### 1. MODE is Already Redundant (Codebase Evidence)

The runtime at `runtime-executor.ts:1313` branches on `session.currentFlowStep !== undefined`, not on `execution.mode`. Session initialization at line 558 sets `currentFlowStep` only when `mode === 'scripted' && agentIR.flow`. MODE is a proxy for "does this agent have a flow?" — the proxy adds no value.

MODE is checked at compile time in 3 places:

- Voice latency default (line 475) — `mode === 'scripted'` could be `flow !== undefined`
- Gather strategy (line 869) — `mode === 'scripted'` could be `flow !== undefined`
- Flow graph validation (validate-ir.ts line 45) — `mode !== 'scripted'` could be `!flow`

All trivially replaceable.

### 2. Natural Evolution Without Restructuring

Enterprise requirements evolve through sprints:

| Sprint   | Requirement                                                 | Change                                                |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Sprint 1 | "Collect 5 fields"                                          | Write GATHER steps (deterministic)                    |
| Sprint 3 | "If customer pushes back on insurance, have a conversation" | Add GOAL to that step — reasoning zone                |
| Sprint 5 | "After conversation, apply business rules"                  | Next step is CALL — deterministic                     |
| Sprint 7 | "Premium customers skip collection, talk directly"          | Add conditional branch to a GOAL step                 |
| Sprint 9 | "The advisory costs too much"                               | Remove GOAL, add CALL + RESPOND — deterministic again |

Each evolution is an additive or subtractive change to a step. No agent decomposition, no HANDOFF rewiring, no supervisor creation.

### 3. Per-Step Cost and Latency Control

Deterministic steps skip LLM calls entirely — field validation, business rules, conditional branching execute without LLM involvement. Only GOAL steps incur LLM costs. The developer controls cost at step granularity, not agent granularity.

### 4. Single Mental Model

Developers learn one construct vocabulary: GOAL, REASONING, GATHER, CALL, SET, RESPOND, THEN, CHECK, EXIT_WHEN, MAX_TURNS, CONSTRAINTS. Every agent has a GOAL (purpose). Every step declares REASONING (execution mode). There's no upfront "scripted or reasoning?" decision at agent level — the decision is per-step, explicit, and reversible.

### 5. Traceability Remains Clean

Each step emits trace events with the step name as boundary. Deterministic steps produce `flow_step_enter`, `dsl_collect`, `tool_call`, `flow_transition`. GOAL steps produce those plus `llm_call`, `tool_call` (LLM-initiated), `decision`. The step boundary is the trace boundary — it's clear which steps were deterministic and which were LLM-driven.

### 6. The Supervisor Pattern Still Works

Supervisors are agents with HANDOFF rules and no FLOW (or a minimal FLOW). They route to specialist agents. The unified type doesn't change this — it just means the specialist agents can internally mix modes without decomposition.

---

## Arguments AGAINST the Unified Design

### 1. FlowStepExecutor Must Invoke ReasoningExecutor

Today, FlowStepExecutor (~3500 LOC) and ReasoningExecutor (~700 LOC) are completely independent. Adding GOAL steps means FlowStepExecutor needs to call ReasoningExecutor for those steps. This creates coupling between two execution models.

**Counter:** The coupling is one-directional and bounded. FlowStepExecutor already calls `executeFlowCall()` for CALL steps — calling `reasoning.executeForStep()` for GOAL steps follows the same pattern. ReasoningExecutor doesn't need to change — it already takes a session, system prompt, and tools. The new call would be:

```typescript
if (step.goal) {
  const result = await this.reasoning.executeForStep(
    session,
    step.goal,
    step.tools,
    step.exit_when,
    step.max_turns,
    onChunk,
    onTraceEvent,
  );
  // On exit, advance to step.then
}
```

This is ~20 lines in FlowStepExecutor, not architectural coupling.

### 2. Conversation History Complexity

A reasoning step produces multiple conversation turns (LLM <-> user <-> tools). These append to `session.conversationHistory`, which subsequent deterministic steps also use. The history becomes a mix of structured prompts and LLM conversation.

**Counter:** This already happens with multi-agent handoffs. When a reasoning child returns to a scripted parent, the history contains both. The conversation history is inherently mixed — it represents the user's actual conversation, which naturally alternates between structured and free-form.

### 3. EXIT_WHEN is a New Step-Level Concept

How does the reasoning zone know when to stop? Today, completion is agent-level (`COMPLETE: WHEN`). For step-level reasoning, we need step-level exit conditions.

**Counter:** `COMPLETE_WHEN` already exists on FlowStep (line 260 in types). We rename/alias it as `EXIT_WHEN` for reasoning steps. The ReasoningExecutor evaluates this after each turn. If the condition is met (or MAX_TURNS reached), the reasoning loop exits and the flow advances to `THEN`.

### 4. Developers May Not Realize GOAL Changes Execution Semantics

Adding GOAL to a step makes it non-deterministic. Without explicit MODE, the developer might not understand the implications (higher cost, non-reproducible behavior, needs LLM credentials).

**Counter (resolved by design):** Every step now requires explicit `REASONING: true` or `REASONING: false`. The developer must consciously declare reasoning behavior — it cannot happen accidentally. `REASONING: true` is an unambiguous opt-in. The compiler additionally emits an informational diagnostic: "Step 'advise' uses REASONING: true — non-deterministic, requires LLM credentials."

### 5. Testing Dual-Mode Steps Requires Two Testing Strategies

Deterministic steps are testable with fixed inputs leading to fixed outputs. GOAL steps need LLM mocking and may produce different outputs each run.

**Counter:** This complexity exists today for multi-agent workflows (scripted parent to reasoning child to scripted parent). The testing burden doesn't increase — it redistributes from agent-level to step-level. Pure deterministic agents remain deterministic. Only agents with GOAL steps need LLM testing — and only for those specific steps.

### 6. Loss of Explicit Communication

MODE: scripted / MODE: reasoning is an explicit declaration of intent. Removing it makes the execution model implicit — a reader must inspect step constructs to understand the execution style.

**Counter (resolved by design):** `REASONING: true/false` is required on every step — the execution model is MORE explicit than MODE. Every step declares its intent. A reader sees `REASONING: true` and immediately knows "this step is LLM-driven." With agent-level MODE, the reader knows the whole agent is one mode — but the actual execution may be mixed across agents via handoffs. Per-step `REASONING` is more granular, more accurate, and fully explicit.

---

## Voice/Realtime Interactions — All Combinations

The unified agent type creates new combinations of step execution x voice channel that must work correctly.

### Current Voice Architecture (Summary)

Two voice modes exist:

- **Pipeline**: STT (Deepgram) to text agent to TTS (ElevenLabs). Sequential. ~1-2s latency per turn.
- **Realtime**: Bidirectional audio streaming through LLM (OpenAI Realtime API / Gemini Live). Sub-500ms latency. Server-side VAD.

Key interfaces already on `RealtimeVoiceSession`: `updateSystemPrompt(prompt)`, `updateTools(tools)` — designed for handoff scenarios, reusable for step transitions.

Voice mode resolved via priority chain in `voice-mode-resolver.ts`: kill switch to deployment config to agent hint (`voice_optimized`) + tenant model to global config to default (pipeline).

### Combination Matrix

| Agent Shape                       | Text                                                                | Pipeline Voice                                                                                                                                                       | Realtime Voice                                                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Flow-only (all deterministic)** | No LLM. Prompt to typed input to extract to validate to next step.  | STT to extract to validate to TTS prompt. No reasoning LLM needed.                                                                                                   | Realtime LLM constrained as field collector. System prompt = step script with required fields + validation rules.                                                                                                                                                                    |
| **Flow with GOAL steps (mixed)**  | Deterministic steps: no LLM. GOAL steps: reasoning loop with tools. | Deterministic: STT to extract to TTS. GOAL: STT to reasoning loop to TTS. Mode switches between steps are transparent — pipeline doesn't care about execution model. | **Key new scenario.** Realtime LLM active throughout. Deterministic steps: system prompt updated to constrain LLM as structured collector. GOAL steps: system prompt updated to GOAL with full tool access. `updateSystemPrompt()` + `updateTools()` called at each step transition. |
| **Reasoning-only (no FLOW)**      | Standard reasoning loop: LLM with tools and user.                   | STT to reasoning loop to TTS.                                                                                                                                        | Native realtime. Bidirectional audio streaming. Best fit.                                                                                                                                                                                                                            |

### Critical Insight: Voice Mode Makes All Steps LLM-Mediated

In **text mode**, deterministic steps skip the LLM entirely — the system displays a prompt, the user types a response, the engine extracts and validates. No LLM call.

In **voice mode**, even "deterministic" steps require LLM involvement for speech understanding. The user speaks, and something must understand their speech. The determinism is in **flow control** (which step comes next, what validations apply, what transitions fire), not in whether the LLM processes user input.

This means:

- **Text**: Deterministic = no LLM. GOAL = LLM.
- **Pipeline voice**: Deterministic = STT only (no reasoning LLM). GOAL = STT + reasoning LLM.
- **Realtime voice**: Deterministic = realtime LLM constrained as collector. GOAL = realtime LLM with autonomous reasoning.

### Realtime Voice + Mixed Steps: How It Works

When a mixed-mode agent runs in a realtime voice session:

1. **Session start**: `RealtimeVoiceExecutor` connects to realtime LLM with initial system prompt based on the entry step.

2. **Deterministic step active**: System prompt instructs the LLM to act as a structured field collector:
   - "Collect the following fields from the user: income (number), city (string), age (number)"
   - "Validate: income must be > 0"
   - "When all fields are collected and validated, signal completion"
   - The LLM handles speech understanding and natural conversation, but the ABL engine enforces validation rules and step transitions deterministically.

3. **Step transition (deterministic to GOAL)**: `RealtimeVoiceExecutor` calls:
   - `session.updateSystemPrompt(goalPrompt)` — switches to the GOAL's system prompt
   - `session.updateTools(stepTools)` — updates available tools to the GOAL step's tool set
   - ~100ms overhead for the prompt swap. The realtime audio stream continues without interruption.

4. **GOAL step active**: The realtime LLM operates autonomously — conversing, calling tools, reasoning. The `RealtimeVoiceExecutor` evaluates `exit_when` after each tool call result or turn end.

5. **Step transition (GOAL to deterministic)**: Same prompt/tool swap. The LLM switches from autonomous reasoning to constrained collection.

### Design Implications for Implementation

1. **`RealtimeVoiceExecutor` must be step-aware.** Currently it only updates system prompt for handoffs. It needs to also update on flow step transitions. This is the same mechanism — `updateSystemPrompt()` + `updateTools()` — just triggered by step changes instead of (or in addition to) handoffs.

2. **`voice_optimized` hint needs refinement.** Currently a boolean on `RuntimeHints`. For mixed agents, the hint should reflect the dominant execution style or be per-step. Recommendation: keep `voice_optimized: true` if the agent has a FLOW (even mixed), since flow-based agents have predictable step structure that maps well to voice. Set `voice_optimized: false` only for complex reasoning-only agents with many tools.

3. **GATHER field `promptMode` remains correct.** `ask` = voice-prompted, `extract_only` = silent extraction. This works identically in both deterministic and GOAL steps, in all voice modes.

4. **Latency constants remain valid.**
   - `VOICE_LATENCY_SCRIPTED_MS = 500` — applies to deterministic steps (currently checks `mode === 'scripted'`, change to `hasFlow`)
   - `VOICE_LATENCY_INTERACTIVE_MS = 1000` — applies to GOAL steps and reasoning-only agents

5. **No fundamental architectural changes to voice subsystem.** The existing `RealtimeVoiceExecutor` to `RealtimeVoiceSession` to provider architecture handles this naturally. The main change is making the executor aware of flow step transitions, which mirrors how it already handles handoff transitions.

### Voice Combinations That Don't Work

| Combination                                                              | Why                                                                                                                   | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime voice + GOAL step with 20+ tools                                | Realtime LLMs have limited tool handling capacity (~5-8 tools optimal). Too many tools degrades latency and accuracy. | Compiler warning: "Step 'advise' has GOAL with 20 tools in a voice-eligible agent. Consider reducing to <8 tools for realtime voice performance." Use `availableTools` to subset. |
| Realtime voice + rapid step transitions (many small deterministic steps) | Each step transition = system prompt swap = ~100ms. 10 rapid transitions = 1s overhead.                               | Compiler warning if flow has >5 sequential single-action deterministic steps. Suggest consolidating into fewer steps.                                                             |
| Realtime voice + long GOAL step (MAX_TURNS: 50)                          | Long reasoning sessions in realtime voice consume expensive audio tokens.                                             | Informational diagnostic on cost implications.                                                                                                                                    |

---

## Development Clarity Review

### The Question: Without Agent-Level MODE, Is Intent Clear?

Agent-level MODE is deleted, but every step now explicitly declares `REASONING: true/false`. Is the overall intent clear?

### Analysis: Per-Step REASONING Is Clearer Than Agent-Level MODE

Agent-level MODE was misleading in multi-agent scenarios:

- An agent declares `MODE: scripted`, but it HANDOFFs to a reasoning agent mid-flow. The actual execution is mixed — but MODE says "scripted."
- A supervisor declares `MODE: reasoning`, but it delegates to scripted children. The actual execution alternates — but MODE says "reasoning."

Per-step `REASONING: true/false` is more accurate because it declares intent exactly where it matters — at each step boundary.

### What Developers Need to Know

| Developer Question                        | How Answered                                                                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "What does this agent do overall?"        | `AGENT:` name + `GOAL:` (mandatory on every agent)                                                                                                                                                                   |
| "Is this agent deterministic?"            | Scan steps for `REASONING: true`. All `REASONING: false` = fully deterministic.                                                                                                                                      |
| "Which steps use LLM reasoning?"          | Steps with `REASONING: true` — explicit, scannable, highlighted in editor                                                                                                                                            |
| "What's the cost profile?"                | Count `REASONING: true` steps vs `REASONING: false`. True = LLM cost. False = zero LLM cost.                                                                                                                         |
| "Can I run this without LLM credentials?" | All steps `REASONING: false` + no FLOW (reasoning-only) = no. But: GOAL is mandatory, and even deterministic agents use GOAL for extraction context. LLM credentials needed for all agents (GOAL drives extraction). |
| "What execution model is this?"           | Has FLOW = flow-based. No FLOW = reasoning-only. Steps declare their own mode.                                                                                                                                       |

### Clarity Mechanisms (Built Into the Design)

**1. Compiler Diagnostics (automatic)**

When compiling, the compiler emits informational diagnostics:

```
INFO: Agent 'Credit_Card_Workflow' — 4 flow steps (3 deterministic, 1 reasoning zone)
INFO: Step 'advise' uses GOAL — non-deterministic, requires LLM credentials
INFO: Agent execution: flow-based with reasoning zones
```

These appear in Studio's compilation output panel. Zero developer effort.

**2. Studio Visual Indicators**

In the flow editor and topology view:

- Deterministic steps: standard step appearance
- GOAL steps: visually distinct (e.g., different border color, brain/sparkle icon, "AI" badge)
- Agent cards in topology: show "3 deterministic + 1 reasoning" summary

**3. DSL Readability**

Compare reading this with MODE vs with explicit REASONING:

**With MODE (current):**

```abl
AGENT: Intake          # MODE: scripted — ok, I know
  FLOW: ...
AGENT: Advisor         # MODE: reasoning — ok, I know
  GOAL: ...
AGENT: Confirmation    # MODE: scripted — ok, I know
  FLOW: ...
# But: 3 agents, 2 handoffs to wire, 3 deployments
```

**With explicit REASONING (unified):**

```abl
AGENT: Credit_Card_Workflow
GOAL: "Guide customer through card recommendation"
FLOW:
  collect:
    REASONING: false    # explicit: deterministic
    GATHER: ...
  advise:
    REASONING: true     # explicit: LLM reasoning zone
    GOAL: "Recommend best card"
    EXIT_WHEN: ...
  confirm:
    REASONING: false    # explicit: deterministic
    RESPOND: ...
  submit:
    REASONING: false    # explicit: deterministic
    CALL: ...
# 1 agent, 0 handoffs, 1 deployment, execution model explicit per-step
```

The unified version is **more readable** — the execution model is explicit at every step, and the developer doesn't need to mentally track 3 separate agents and their handoff wiring.

**4. REASONING: true as a Clear Opt-In Signal**

`REASONING: true` is the most explicit possible signal. The developer must type it on every reasoning step — it cannot happen accidentally. Combined with mandatory GOAL at agent level, the intent is clear at both levels:

- Agent GOAL = "what is this agent for?"
- Step REASONING = "how does this step execute?"

### Potential Confusion Points and Mitigations

| Confusion                                                     | Mitigation                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I set REASONING: true but forgot to add GOAL"                | If no step GOAL and no agent GOAL, compiler error: "REASONING: true requires a GOAL." But since agent GOAL is mandatory, this only triggers if agent GOAL is somehow empty.                                |
| "My agent has no FLOW and no GOAL — what happens?"            | Compiler error: "GOAL is required on every agent." (GOAL is mandatory, so this is caught at parse time.)                                                                                                   |
| "I have FLOW but also GOAL at agent level — which one wins?"  | Both are used. Agent GOAL = persona/context for all steps. Steps with `REASONING: true` + step GOAL override agent GOAL for that step. Steps with `REASONING: false` use agent GOAL as extraction context. |
| "Can I mix GATHER and REASONING: true in the same step?"      | Yes — GATHER defines fields to collect, REASONING: true + GOAL defines how the LLM approaches collection. Fields collected through natural conversation. Validation enforced deterministically.            |
| "Team member added REASONING: true to a step I didn't expect" | Code review: `REASONING: true` is a visible, explicit keyword, easy to spot in diffs. Topology view highlights which steps are reasoning zones.                                                            |
| "I forgot REASONING on a step"                                | Compiler error: "Step '{name}' must declare REASONING: true or REASONING: false." No ambiguity possible.                                                                                                   |

### Verdict: Maximum Clarity

The combination of mandatory GOAL + explicit `REASONING: true/false` provides **maximum clarity**:

1. Every agent declares its purpose (mandatory GOAL)
2. Every step declares its execution model (mandatory REASONING)
3. No implicit inference — the developer controls and communicates everything
4. Compiler catches all missing declarations immediately
5. Code review is trivial — `REASONING: true/false` is the first line of every step

---

## What This Means for the 3-Approach Plan

The unified design **subsumes Approach 2** (HANDOFF from flow steps as the primary mechanism for reasoning) for INTERNAL reasoning needs:

| Need                                  | Without Unified                                | With Unified                             |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Reasoning section mid-flow            | HANDOFF to separate reasoning agent            | Add GOAL to that step                    |
| Different persona/tools for reasoning | HANDOFF to separate agent with its own persona | HANDOFF to separate agent (still needed) |
| Complex multi-turn advisory           | HANDOFF to dedicated reasoning agent           | GOAL step with EXIT_WHEN + MAX_TURNS     |
| External agent delegation             | HANDOFF (required)                             | HANDOFF (still required)                 |

**HANDOFF from flow steps (Approach 2) is still valuable** for delegating to external agents, agents with different personas, or agents owned by different teams. GOAL steps handle the simpler case where you just need LLM reasoning within your own flow.

**Multi-agent files (Approach 1) and inline agents (Approach 3)** are orthogonal organizational conveniences — still useful regardless of the unified type.

So the revised implementation plan becomes:

| Priority | Feature                      | Purpose                                |
| -------- | ---------------------------- | -------------------------------------- |
| **P0**   | GOAL as flow step construct  | Core unified agent capability          |
| **P1**   | HANDOFF from flow steps      | Delegation to external/separate agents |
| **P1**   | Multi-agent files (WORKFLOW) | Organizational convenience             |
| **P2**   | Inline agents (@name)        | DX convenience, builds on P0+P1        |

---

## Implementation Design: GOAL as Flow Step Construct (P0)

### Type Changes

**`packages/core/src/types/agent-based.ts`** — Changes:

1. **Make `goal` mandatory on `AgentBasedDocument`** (change from `goal?: string` to `goal: string`)

2. **Delete `mode` from `AgentBasedDocument`** (remove `mode?: 'scripted' | 'reasoning'`)

3. **Add to `FlowStep`:**

```typescript
export interface FlowStep {
  // ... existing fields ...

  /** Whether this step uses LLM reasoning (REQUIRED on every step) */
  reasoning: boolean;

  /** LLM reasoning goal for this step (overrides agent GOAL when reasoning: true) */
  goal?: string;

  /** Tools available for reasoning in this step (subset of agent tools) */
  availableTools?: string[];

  /** Condition to exit the reasoning loop (evaluated after each turn) */
  exitWhen?: string;

  /** Max reasoning turns before forcing exit (default: 10) */
  maxTurns?: number;

  /** Constraints specific to this reasoning zone */
  stepConstraints?: string[];
}
```

**`packages/compiler/src/platform/ir/schema.ts`** — Add to IR `FlowStep`:

```typescript
export interface FlowStep {
  // ... existing fields ...

  /** Reasoning zone configuration (present = this step uses LLM reasoning) */
  reasoning_zone?: ReasoningZoneIR;
}

export interface ReasoningZoneIR {
  goal: string;
  available_tools?: string[]; // Tool names (subset of agent tools)
  exit_when?: string; // Condition expression
  max_turns: number; // Default: 10
  constraints?: string[]; // Step-level constraints
}
```

### Parser Changes

**`packages/core/src/parser/agent-based-parser.ts`**:

1. **Remove MODE parsing** at agent level. If `MODE:` encountered, add parse error: "MODE is no longer supported. Execution style is declared per-step with REASONING: true/false."

2. **Make GOAL required** at agent level. If no GOAL found after parsing, add parse error: "GOAL is required on every agent."

3. **In flow step switch** (~line 1002), add cases:

```
case 'REASONING' -> currentStep.reasoning = (value.toLowerCase() === 'true')
case 'GOAL'      -> currentStep.goal = value
case 'EXIT_WHEN' -> currentStep.exitWhen = value
case 'MAX_TURNS' -> currentStep.maxTurns = parseInt(value)
case 'AVAILABLE_TOOLS' -> currentStep.availableTools = parseArray(value)
```

4. **Validate REASONING is declared** on every flow step. After flow parsing, iterate steps — if `step.reasoning === undefined`, add parse error: "Step '{name}' must declare REASONING: true or REASONING: false."

5. **Validate REASONING: true constraints**:
   - `REASONING: true` with no step GOAL and no agent GOAL — error
   - `REASONING: false` with step GOAL — error ("GOAL on a deterministic step has no effect; set REASONING: true or remove GOAL")
   - Step TOOLS must be a subset of agent-level TOOLS — error if step references undeclared tool: "Step 'advise' references tool 'unknown_tool' not declared in agent TOOLS"
   - `REASONING: false` with step TOOLS — error ("TOOLS on a deterministic step has no effect; use CALL to invoke tools deterministically")

### Compiler Changes

**`packages/compiler/src/platform/ir/compiler.ts`** — In `compileFlow()`:

```typescript
reasoning_zone: step.reasoning ? {
  goal: step.goal ?? doc.goal,  // Step GOAL overrides agent GOAL
  available_tools: step.availableTools,
  exit_when: step.exitWhen ?? step.completeWhen,
  max_turns: step.maxTurns ?? 10,
  constraints: step.stepConstraints,
} : undefined,
```

**In `compileAgentToIR()`** — Replace MODE with derivation:

```typescript
// MODE is deleted from DSL and IR. Derive execution style from structure:
const hasFlow = doc.flow !== undefined && Object.keys(doc.flow).length > 0;
// hasFlow -> flow-based execution (deterministic + reasoning zones)
// !hasFlow -> reasoning-only execution
```

All 3 places that currently check `mode`:

- Voice latency default (line 475): `mode === 'scripted'` becomes `hasFlow`
- Gather strategy (line 869): `mode === 'scripted'` becomes `hasFlow`
- Flow graph validation (validate-ir.ts line 45): `mode !== 'scripted'` becomes `!hasFlow`

**Delete `mode` from `ExecutionConfig` in IR schema.** The runtime already branches on `currentFlowStep !== undefined`. All consumers (Studio, topology, debugging) derive execution style from `flow !== undefined`.

**Agent-level GOAL + FLOW coexistence:** Agent-level GOAL is persona/context injected into every step's system prompt. For `REASONING: true` steps without step-level GOAL, agent GOAL drives the reasoning. For `REASONING: true` steps with step-level GOAL, step GOAL overrides agent GOAL for that step.

### Runtime Changes

**`apps/runtime/src/services/execution/flow-step-executor.ts`**

In the step execution logic, BEFORE the existing GATHER/CALL handling, check the `reasoning_zone` field (compiled from `REASONING: true`):

```typescript
if (step.reasoning_zone) {
  // Build step-level system prompt from GOAL
  const stepSystemPrompt = buildReasoningZonePrompt(session, ir, step.reasoning_zone);

  // Filter tools to available_tools subset (or all agent tools if not specified)
  const stepTools = filterToolsForStep(allTools, step.reasoning_zone.available_tools);

  // Run reasoning loop for this step
  const result = await this.reasoning.executeReasoningZone(
    session,
    stepSystemPrompt,
    stepTools,
    step.reasoning_zone.exit_when,
    step.reasoning_zone.max_turns,
    onChunk,
    onTraceEvent,
  );

  // Check exit condition
  if (result.exitConditionMet) {
    // Advance to step.then
    nextStep = step.then;
  } else if (result.maxTurnsReached) {
    // Escalate: trigger agent's escalation handler
    // If no handler, emit warning trace + advance to step.then
    if (ir.routing?.escalation) {
      return this.routing.handleEscalation(session, {
        reason: `Reasoning zone '${step.name}' exceeded MAX_TURNS (${step.reasoning_zone.max_turns})`,
        source: 'reasoning_zone_timeout',
      });
    }
    onTraceEvent?.({ type: 'escalation', data: { reason: 'max_turns_reached', step: step.name } });
    nextStep = step.then;
  } else if (result.waitingForInput) {
    // Reasoning needs more user input — pause flow
    return result;
  }
}
```

**`apps/runtime/src/services/execution/reasoning-executor.ts`** — Add method:

```typescript
async executeReasoningZone(
  session: RuntimeSession,
  systemPrompt: string,
  tools: ToolDefinition[],
  exitWhen: string | undefined,
  maxTurns: number,
  onChunk?: ...,
  onTraceEvent?: ...,
): Promise<ReasoningZoneResult> {
  // Similar to existing execute() but:
  // 1. Uses step-level system prompt (from GOAL)
  // 2. Checks exitWhen after each turn
  // 3. Bounded by maxTurns instead of max_iterations
  // 4. Returns ReasoningZoneResult with exitConditionMet flag
}
```

This method is a variant of the existing `execute()` method, with step-scoped behavior.

### The User Interaction Model for GOAL Steps

When a GOAL step is active:

1. FlowStepExecutor detects `step.reasoning_zone` and invokes ReasoningExecutor
2. ReasoningExecutor runs LLM with GOAL as system prompt, available tools, and conversation history
3. LLM may respond to user (text), call tools, or both
4. If LLM produces a response — return to user, wait for next message
5. On next message — FlowStepExecutor sees same step is active, invokes ReasoningExecutor again
6. ReasoningExecutor continues the conversation with the new user message
7. After each LLM turn, evaluate `exit_when` against session data
8. If exit_when is satisfied — reasoning zone exits, flow advances to `then`
9. If max_turns reached — reasoning zone exits with max_turns flag

This is effectively the same as the existing reasoning loop, but bounded by step-level exit conditions instead of agent-level completion conditions.

### GATHER + GOAL in the Same Step (Natural Conversation)

When a GOAL step also has GATHER fields, the LLM collects fields organically through conversation:

- The system prompt includes the GATHER field names, types, and validation rules as context
- The LLM extracts field values naturally from the conversation (no rigid per-field prompting)
- After each LLM turn, the engine runs deterministic validation on any extracted field values
- If validation fails, the LLM is informed and can re-ask naturally
- EXIT_WHEN can reference GATHER field completion: `EXIT_WHEN: all_fields_collected`

This combines the natural conversation quality of reasoning with the data integrity guarantees of GATHER validation.

---

## Implementation Design: HANDOFF from Flow Steps (P1)

### DSL Syntax

```abl
step_name:
  GATHER: ...
  THEN: HANDOFF Agent_Name
    RETURN: true
    PASS: [field1, field2]
    ON_RETURN: next_step
    MAP: {child_key: parent_key}
```

### Changes Required

- **Types**: `FlowStepHandoff` on `FlowStep`, `FlowStepHandoffIR` on IR `FlowStep`
- **Parser**: `THEN: HANDOFF` detection + indented property parsing, standalone `HANDOFF:` case
- **Compiler**: Map to IR, synthesize `coordination.handoffs` entries
- **FlowStepExecutor**: After step action, call `routing.handleHandoff()`
- **Thread types**: `handoffReturnToStep` on `AgentThread`, advance in `tryThreadReturn()`
- **Also**: Implement digression `delegate` (clear the TODO at line 2162)

---

## Implementation Design: Multi-Agent Files (P1)

### DSL Syntax

```abl
WORKFLOW: Credit_Card_Application

AGENT: Intake
FLOW:
  ...

AGENT: Advisor
GOAL: "..."
TOOLS: ...
```

### Changes Required

- **Types**: `MultiAgentParseResult`
- **Parser**: `parseMultiAgentABL()`, `splitIntoAgentBlocks()`
- **Compiler**: No changes (already accepts `AgentBasedDocument[]`)
- **Seed script**: Handle multi-agent files
- **Topology API**: Use `parseMultiAgentABL`

**Note:** WORKFLOW is purely organizational — agents within the same file must still declare HANDOFF targets explicitly. No implicit routing or visibility.

---

## Implementation Design: Inline Agent Blocks (P2)

### DSL Syntax

```abl
AGENT: Orchestrator
FLOW:
  step1: ...
  step2:
    HANDOFF: @advisor
    ...

@advisor:
  GOAL: "..."
  TOOLS: ...
```

### Changes Required

- **Types**: `InlineAgentDefinition` on `AgentBasedDocument`
- **Parser**: `@name:` block detection, collect + recursive parse
- **Compiler**: `flattenInlineAgents()` before main compilation loop
- **Monarch tokenizer**: `@name:` syntax highlighting rule

---

## Full Implementation Sequence

| Task       | Feature                                        | Scope                                                                                               | Dependencies                           |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Task 1** | Delete MODE + GOAL as flow step construct (P0) | Types + Parser + Compiler + FlowStepExecutor + ReasoningExecutor + MODE removal                     | None                                   |
| **Task 2** | HANDOFF from flow steps (P1)                   | Types + Parser + Compiler + FlowStepExecutor + Thread types                                         | None (parallel with 1)                 |
| **Task 3** | Multi-agent files / WORKFLOW (P1)              | Types + Parser + Seed + Topology                                                                    | None (parallel with 1, 2)              |
| **Task 4** | Inline agent blocks / @name (P2)               | Types + Parser + Compiler + Monarch                                                                 | Task 2 (needs HANDOFF from flow steps) |
| **Task 5** | Migration script + migrate all examples        | Script: remove MODE, add GOAL if missing, add REASONING to every step. Run on all example projects. | Task 1                                 |
| **Task 6** | Integration testing + validation               | Tests + Graph + Docs                                                                                | All above                              |

**Task 1 now includes MODE deletion** (formerly Task 5). Since there's no backward compatibility to maintain, MODE removal is part of the core unified type work — not a separate deprecation step.

---

## Critical Files

| File                                                         | All Changes                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                     | Delete `mode` from `AgentBasedDocument`. Make `goal` required. Add `FlowStep.reasoning/goal/exitWhen/maxTurns/availableTools`. Add `FlowStepHandoff`, `InlineAgentDefinition`, `MultiAgentParseResult`.                                         |
| `packages/core/src/parser/agent-based-parser.ts`             | Remove MODE parsing (error if found). Require GOAL at agent level. Add REASONING/GOAL/EXIT_WHEN/MAX_TURNS in step switch. Validate REASONING on every step. Add HANDOFF in step switch. Add `parseMultiAgentABL()`. Add `@name:` block parsing. |
| `packages/compiler/src/platform/ir/schema.ts`                | Delete `mode` from `ExecutionConfig`. Add `ReasoningZoneIR` on `FlowStep`. Add `FlowStepHandoffIR` on `FlowStep`.                                                                                                                               |
| `packages/compiler/src/platform/ir/compiler.ts`              | Replace all `mode` checks with `hasFlow`. Reasoning zone compilation. Flow handoff compilation. Coordination synthesis. `flattenInlineAgents()`.                                                                                                |
| `packages/compiler/src/platform/ir/validate-ir.ts`           | Replace `mode !== 'scripted'` with `!flow`.                                                                                                                                                                                                     |
| `apps/runtime/src/services/runtime-executor.ts`              | Replace `mode === 'scripted' && agentIR.flow` with `agentIR.flow`. Session init no longer checks mode.                                                                                                                                          |
| `apps/runtime/src/services/execution/flow-step-executor.ts`  | GOAL step execution (invoke reasoning). Step HANDOFF execution. Digression delegate.                                                                                                                                                            |
| `apps/runtime/src/services/execution/reasoning-executor.ts`  | `executeReasoningZone()` method.                                                                                                                                                                                                                |
| `apps/runtime/src/services/execution/types.ts`               | `handoffReturnToStep` on `AgentThread`, advance in `tryThreadReturn()`.                                                                                                                                                                         |
| `apps/runtime/src/services/voice/realtime-voice-executor.ts` | Step-transition awareness: call `updateSystemPrompt()` + `updateTools()` on flow step changes.                                                                                                                                                  |
| `apps/studio/src/lib/abl-monarch.ts`                         | Remove MODE highlighting. Add `@name:` and `WORKFLOW:` syntax rules.                                                                                                                                                                            |
| `packages/database/seed-mongo.ts`                            | Multi-agent file support.                                                                                                                                                                                                                       |
| `scripts/migrate-abl.ts` (new)                               | Migration script: parse `.abl` files, remove MODE, add GOAL if missing, add REASONING to every step.                                                                                                                                            |
| `examples/**/*.abl`                                          | Migrated by script: remove MODE, add GOAL, add REASONING to every step.                                                                                                                                                                         |

---

## Verification Checklist

1. **Parser tests**: REASONING/GOAL/EXIT_WHEN/MAX_TURNS in steps. HANDOFF in steps. WORKFLOW parsing. @name parsing. Parser rejects `MODE:` with clear error. Parser requires GOAL on every agent. Parser requires REASONING on every step.

2. **Compiler tests**: ReasoningZoneIR output for `REASONING: true` steps. FlowStepHandoffIR output. `mode` absent from compiled IR. Inline agent flattening. Compiler error if `REASONING: true` without GOAL. Compiler error if `REASONING: false` with step GOAL.

3. **Runtime tests**: `REASONING: true` step invokes reasoning loop. exit_when terminates reasoning. max_turns triggers escalation. HANDOFF triggers handleHandoff. Return advances flow.

4. **MODE removal**: Grep codebase for `execution.mode` / `doc.mode` / `MODE:` — zero references remain (except migration script).

5. **Voice tests**: Mixed-step agent in realtime voice mode — system prompt updates at step transitions. Verify `updateSystemPrompt()` called on reasoning to deterministic transition.

6. **Migration script**: Run on all example projects. Verify all migrated files compile. Verify no MODE remains. Verify every agent has GOAL. Verify every step has REASONING.

7. **E2E**: Credit card workflow example with `REASONING: false` + `REASONING: true` + `REASONING: false` steps, no separate agents.
