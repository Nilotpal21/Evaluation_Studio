# ABL Supervisor Routing — Open Concerns

## Summary

| #   | Concern                                                                                                             | Severity | Category    | Status |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------- | ----------- | ------ |
| 1   | Multi-intent handling — second agent silently overwrites the first                                                  | Critical | Handoff     | Open   |
| 2   | Handoff tool design — single enum vs agents-as-tools                                                                | High     | Handoff     | Open   |
| 3   | Handoff context is not enforced                                                                                     | Critical | Handoff     | Open   |
| 4   | Scripted agents compiled as reasoning after supervisor handoff                                                      | Critical | Compilation | Open   |
| 5   | Text + tool_call collision in supervisor responses                                                                  | Medium   | Handoff     | Open   |
| 6   | Entity extraction hallucinates values and conflicts with response generation                                        | High     | Extraction  | Open   |
| 7   | Routing conditions and escalation triggers need programmatic evaluation                                             | High     | Routing     | Open   |
| 8   | Supervisor ROUTING priority ordering is lost in compilation                                                         | Medium   | Compilation | Open   |
| 9   | Memory values not surfaced to LLM in system prompts                                                                 | Medium   | Memory      | Open   |
| 10  | DELEGATE is LLM-discretionary — WHEN conditions blocked by incomplete context, and LLM bypasses delegation entirely | Critical | Delegate    | Open   |

**By severity:** Critical (4) · High (3) · Medium (3)

**By category:** Handoff (4) · Compilation (2) · Extraction (1) · Routing (1) · Memory (1) · Delegate (1)

---

## 1. Multi-intent handling — second agent silently overwrites the first

**Severity**: Critical

**Problem**: When a user sends a multi-intent message, the supervisor makes multiple `__handoff__` tool calls in a single LLM response. The runtime executes both handoffs sequentially — each child agent runs fully (entity extraction + LLM response generation) — but **only the last agent's response is delivered to the user**. The first agent's response is silently discarded.

Observed in two domains:

**TravelDesk** — User: "Book a flight to Paris AND cancel my London reservation"

1. Supervisor calls `__handoff__(Sales_Agent)` + `__handoff__(Booking_Manager)` in one tool-call response
2. Sales_Agent runs: entity extraction (415 in / 10 out tokens) + response gen (1,203 in / 131 out tokens) → responds "I'd be happy to help with booking a flight to Paris..."
3. Booking_Manager runs: entity extraction (407 in / 54 out tokens) + response gen (1,481 in / 70 out tokens) → responds "Let's start with canceling your London reservation..."
4. **User only sees Booking_Manager's response.** Sales_Agent's 1,618 tokens and response are discarded.

**Saludsa** — User: "necesito saber cuánto debo y también quiero pedir un reembolso"

1. Supervisor calls `__handoff__(Pending_Payments)` + `__handoff__(Refund_Guidance)` in one tool-call response
2. Pending_Payments runs fully → responds about balance inquiry
3. Refund_Guidance runs fully → responds about reembolso
4. **User only sees Refund_Guidance's response.** Pending_Payments response discarded.

The first agent burns real LLM tokens (entity extraction + response generation) producing a response that no one ever sees.

**Proposal**: ABL needs a multi-intent strategy:

- Option A: Sequential handling — execute first handoff, deliver response, then execute second handoff in a follow-up turn
- Option B: First-class `MULTI_INTENT` construct that splits intents before routing, with a combined response
- Option C: Block multiple `__handoff__` calls in a single response at the runtime level — force the supervisor to pick one

---

## 2. Handoff tool design — single enum vs agents-as-tools

**Severity**: High

**Problem**: The supervisor uses a single `__handoff__(target: enum, context?: string)` tool. Agent names are listed as enum values with no per-agent semantic information in the tool schema. The LLM's only signal for routing decisions comes from unstructured text in the system prompt ("Routing Rules" section), not from the tool definitions themselves.

**Proposal**: Should we move from single-handoff-tool-with-enum to an agent-per-tool pattern for supervisors? Each agent becomes its own tool with a dedicated description and typed parameters, giving the LLM structured routing signal and enabling typed context passing.

---

## 3. Handoff context is not enforced

**Severity**: Critical

**Problem**: ABL authors define required context per handoff rule (e.g. `pass: [quote_id, total_price]` for Payment_Agent), but the compiled tool schema makes `context` a single optional free-form string. The LLM can omit it entirely. There is no runtime validation that the declared context fields are actually passed.

The `pass` array in ABL acts as a whitelist filter — it declares which variables from the source agent's context should be forwarded to the target agent. Currently, this is only honored by the compiler-level `HandoffExecutor.buildHandoffContext()`, which cherry-picks the listed keys from the source context. However, in the runtime's LLM-driven handoff path, the `pass` declaration is ignored entirely — the `__handoff__` tool exposes a single untyped `context` string parameter, and the LLM decides what (if anything) to include.

**Proposal**: Since each handoff target declares different `pass` fields, a single `__handoff__` tool cannot enforce per-target required context — the required fields depend on which target the LLM picks, and JSON Schema has no way to express conditional requirements based on an enum value.

This reinforces the case for the agents-as-tools pattern (see concern #2). Each target agent becomes its own tool with `pass` fields compiled as required parameters:

```yaml
# ABL declaration:
- TO: Payment_Agent
  CONTEXT:
    pass: [quote_id, total_price, customer_email]

- TO: Sales_Agent
  CONTEXT:
    pass: [search_context, user_preferences, budget]
```

Compiles to:

```
handoff_to_Payment_Agent(quote_id: string, total_price: number, customer_email: string)  — all required
handoff_to_Sales_Agent(search_context: string, user_preferences: string, budget: number)  — all required
```

This makes `pass` enforceable at the tool schema level — the LLM **must** provide the declared fields to make a valid tool call. No runtime validation needed; the tool schema itself is the contract.

---

## 4. Scripted agents compiled as reasoning after supervisor handoff

**Severity**: Critical

**Problem**: When a supervisor hands off to a child agent defined with `MODE scripted`, the runtime compiles and executes it as a reasoning agent instead. The scripted `FLOW` (step transitions, `COLLECT` blocks, deterministic branching) is entirely ignored — the child agent receives a free-form system prompt with all its tools and makes autonomous LLM decisions.

Observed in the TravelDesk example: `Welcome_Agent` is defined as `MODE scripted` with a deterministic flow (`check_user → greet_new/greet_returning → detect_intent → route`), but the actual LLM call shows it running as a reasoning agent. The LLM calls both `check_returning_user` and `get_user_context` simultaneously in a single turn, skipping the scripted flow's sequential step logic. The `detect_intent` collection step and keyword-based branching (`"book" → new_booking`, `"cancel" → manage_booking`) never execute — the LLM responds freely instead.

Evidence from raw LLM call:

- System prompt contains `"You are a specialist agent. Help the user directly"` — reasoning-mode framing, not scripted flow instructions
- No flow step references, no `COLLECT` field prompts, no transition conditions in the prompt
- LLM autonomously decides tool calling order and response content

**Proposal**: The runtime must preserve the agent's declared mode across handoff boundaries. When a supervisor delegates to a scripted agent, the scripted executor (not the reasoning executor) must handle execution. The compiled flow steps, transitions, and collection logic defined in ABL must be honored regardless of how the agent was invoked.

---

## 5. Text + tool_call collision in supervisor responses

**Severity**: Medium

**Problem**: When the LLM returns both text content and a handoff tool call in the same response, the text is streamed to the user first, then the child agent's response is also delivered. There is no policy governing this — the user sees two messages (supervisor's text + child agent's response) with no clear boundary or deduplication.

**Proposal**: Define a policy for text + handoff collisions — either suppress assistant text when a handoff tool call is present, or treat it as a structured transition message with explicit UX handling.

---

## 6. Entity extraction hallucinates values and conflicts with response generation

**Severity**: High

**Problem**: When a child agent has `GATHER` fields, the runtime runs an entity extraction LLM call before the response generation call. The extraction produces results that are inconsistent, hallucinated, or contradicted by the subsequent response generation.

Observed across three domains:

**Unified — Hotel_Search**: ABL defines `guests` with `default: 2`. User says "hotel in Barcelona for 3 nights, 200 euros per night" (no mention of guest count). Entity extraction returns `{"guests": 1}` — inventing a value the user never stated, and disagreeing with the ABL default of 2. Then the response generation LLM **ignores the extraction result** and asks: "Could you please let me know how many guests will be staying?" The two LLM calls contradict each other.

**TravelDesk — Booking_Manager**: User says "Book a flight to Paris AND cancel my London reservation". Entity extraction returns `{"cancellation_reason": "Switching to Paris", "confirmation": "Proceed with cancellation"}` — neither value was stated or implied by the user. The extraction hallucinated a reason and pre-confirmed a cancellation the user didn't authorize.

**Saludsa — Pending_Payments**: ABL defines `inquiry_type` with a Spanish prompt and enum-style options ("Su saldo actual", "Historial de pagos", "Formas de pago disponibles"). The entity extraction prompt is in English ("You are an entity extraction assistant. Extract information from the user's message."). It returns `{"inquiry_type": "Su saldo actual"}` — correct value but extracted via an English-language instruction from a Spanish-language input. The extraction prompt doesn't use the field's `PROMPT` text or language.

Root causes:

1. Entity extraction and response generation are independent LLM calls with no shared state — extraction results aren't fed into the response generation context
2. The extraction prompt doesn't include field defaults, validation rules, or allowed values from the ABL definition
3. The extraction prompt is always in English regardless of the agent's persona language
4. No validation layer rejects hallucinated values before they're stored

**Proposal**: Either unify extraction and response generation into a single LLM call (using structured output / tool-based field collection), or feed extraction results into the response generation context and validate extracted values against ABL field definitions (type, enum, default, required) before accepting them.

---

## 7. Routing conditions and escalation triggers need programmatic evaluation

**Severity**: High

**Problem**: ABL defines structured routing conditions (`WHEN: intent.category == "escalation"`) and escalation triggers with numeric thresholds (`routing_failures >= 3 → priority: high`). Both are compiled into natural language in the system prompt but never evaluated programmatically at runtime.

This creates two problems:

**Routing conditions are LLM-interpreted, not runtime-evaluated.** The runtime has a condition evaluator (`evaluateCondition()` in `evaluator.ts`) that can resolve expressions like `intent.category == "escalation"` against `state.context`. But supervisor routing conditions are only rendered as prose in the system prompt — the evaluator is not invoked for them. The LLM may misinterpret or ignore the conditions.

Where programmatic evaluation would add value: entity extraction already runs on user messages and produces values like `{"intent": "Find a hotel"}` (observed in Unified Supervisor test). If the runtime evaluated routing conditions against these extracted values BEFORE asking the LLM to route, it could pre-filter or pre-select targets — reducing the LLM to a tiebreaker rather than the sole routing decision-maker.

**Escalation triggers with numeric thresholds are not tracked.** ABL defines `routing_failures >= 3` and `handoff_count >= 4` as escalation triggers. The runtime doesn't maintain these as counters. The LLM has no way to track how many routing failures have occurred across turns — it relies on conversation history (which may be truncated) to self-escalate. Observed in the Telco NOC test: the Network_Triage agent retried failed tool calls 3 times before self-escalating, but no runtime counter triggered the ABL-defined escalation rule.

**Proposal**: Introduce a programmatic pre-evaluation layer for supervisor routing:

1. Run entity extraction on the user message (already happens)
2. Evaluate ABL routing conditions against extracted values + `state.context`
3. If a condition matches unambiguously, route directly without an LLM call
4. If multiple conditions match or none match, fall through to LLM-based routing
5. Track numeric counters (`routing_failures`, `handoff_count`) in session state and trigger escalation automatically when thresholds are crossed

---

## 8. Supervisor ROUTING priority ordering is lost in compilation

**Severity**: Medium

**Problem**: ABL defines explicit priority ordering for routing rules (P1 through P7 in TravelDesk_Supervisor). The compiled system prompt renders these as flat markdown bullets under "Routing Rules" — the priority numbers are stripped. The LLM has no structured signal about which rule should take precedence when multiple match.

ABL source:

```
ROUTING:
  - TO: Live_Agent_Transfer    # P1 — Escalation
  - TO: Live_Agent_Transfer    # P2 — Complaint
  - TO: Farewell_Agent         # P3
  - TO: Authentication_Agent   # P4
```

Compiled system prompt:

```
## Routing Rules (use __handoff__ tool with target parameter):
- **Live_Agent_Transfer**: User requests human assistance...
- **Live_Agent_Transfer**: Customer complaint...
- **Farewell_Agent**: User ending conversation
- **Authentication_Agent**: User needs to authenticate...
```

No priority numbers, no ordering signal. The LLM treats all rules equally. This matters when a frustrated user wants to cancel a booking — both the escalation rule (P1) and booking management rule (P4) match, but the LLM has no signal to prefer escalation.

**Proposal**: Either include priority numbers in the compiled prompt (e.g., "Priority 1: Live_Agent_Transfer — ...") or, better, use the priority ordering in the programmatic pre-evaluation layer proposed in concern #7.

---

## 9. Memory values not surfaced to LLM in system prompts

**Severity**: Medium

**Problem**: ABL agents define session memory, persistent memory, and recall instructions. The runtime correctly maintains these — persistent memory is loaded from FactStore on recall, stored on remember triggers, and merged into `state.context` for condition evaluation and template interpolation. However, **memory values are never included in the LLM system prompt**.

The `buildSystemPrompt()` method in `reasoning-executor.ts` includes `gatherProgress` (collected fields) and identity (persona, goal, limitations), but omits:

- `state.memory.session` — session-scoped variables like `current_intent`, `routing_history`
- `state.memory.persistentCache` — recalled persistent values like `user.name`, `user.preferred_language`

This means when an ABL agent defines `recall: ON_START - "Check if user is returning"` and the FactStore contains `user.name = "John"`, the runtime loads it into context for condition evaluation, but the LLM never sees it. The LLM cannot personalize responses based on recalled memory — it can only use what's in `gatherProgress` or the conversation history.

Session memory is even more disconnected: it stays in `state.memory.session` and is NOT auto-merged into `state.context`, so it's invisible to both conditions and the LLM.

**Proposal**: The system prompt builder should include relevant resolved memory values in a "Context" section, at minimum the non-empty session memory fields and recalled persistent values. The ABL author declared these as important to the agent's behavior — they should be visible to the LLM.

---

## 10. DELEGATE is LLM-discretionary — WHEN conditions blocked by incomplete context, and LLM bypasses delegation entirely

**Severity**: Critical

**Problem**: ABL's `DELEGATE` construct defines sub-agent invocations with `WHEN` conditions, `INPUT` mappings, and `RETURNS` mappings. The runtime correctly implements all of these — `WHEN` is evaluated programmatically via `evaluateCondition()`, `INPUT` maps parent context to child input, and `RETURNS` maps child output back. However, two issues prevent delegates from ever executing in practice:

**Issue A: LLM prefers direct tools over `__delegate__`.** When an agent has both its own tools and the `__delegate__` system tool, the LLM consistently chooses to call the agent's own tools rather than delegating. The `__delegate__` tool is generic — `__delegate__(target: enum, input?: object)` — and competes with purpose-specific tools that are more semantically obvious to the LLM.

Observed in **TravelDesk — Booking_Manager**: The agent defines `DELEGATE: Fee_Calculator` with `WHEN: action_type == "modify" OR action_type == "change_dates"`. The agent also has 8 direct tools including `check_change_eligibility`, `get_change_options`, and `get_upgrade_pricing`. When the user requests a date change:

1. Entity extraction runs and populates `action_type: "change dates"` — the WHEN condition would pass
2. The LLM calls `check_change_eligibility` and `get_change_options` directly — never calls `__delegate__`
3. Fee_Calculator never executes — its specialized fee calculation logic is entirely bypassed

The LLM has no signal in the tool schema that delegation is _preferred_ over direct tool calls for fee calculation. The ABL author's intent (use Fee_Calculator for all fee-related work) is invisible to the LLM.

**Issue B: DELEGATE WHEN conditions reference variables that entity extraction never populates.** Entity extraction only populates `GATHER` fields. DELEGATE `WHEN` conditions can reference arbitrary context variables that are not GATHER fields, so the condition evaluator finds them undefined and blocks the delegation.

Observed in **Telco — Incident_Manager**: The agent defines `DELEGATE: Link_Analyzer` with `WHEN: incident_category == "link_degradation" OR incident_category == "fiber_cut"`. The field `incident_category` is NOT a GATHER field (only `incident_id` and `severity` are). When the user reports a fiber cut:

1. Entity extraction extracts only GATHER fields: `{"incident_id": "HYD-088", "severity": "P1"}` — `incident_category` is not extracted
2. The LLM correctly calls `__delegate__(target: "Link_Analyzer")`
3. Runtime evaluates `WHEN: incident_category == "fiber_cut"` against session context → `incident_category` is `undefined` → **condition fails**
4. Runtime returns error: `"Delegate to Link_Analyzer blocked: WHEN condition not met"`
5. The LLM gives up on link diagnosis despite the user explicitly stating "The incident category is fiber_cut"

The user's message contained exactly the data needed to satisfy the WHEN condition, but entity extraction only targets GATHER fields and ignores the DELEGATE condition variables.

**Proposal**:

- **For Issue A**: Either compile delegate-eligible tool calls to go through the delegate path automatically when the WHEN condition is met (runtime-driven delegation instead of LLM-driven), or move to an agents-as-tools pattern (see concern #2) where Fee_Calculator becomes `delegate_to_Fee_Calculator(booking_id, change_type, changes)` — giving the LLM a distinct, semantically clear tool for delegation rather than a generic `__delegate__` that competes with the agent's own tools.
- **For Issue B**: Entity extraction should include variables referenced in DELEGATE WHEN conditions, not just GATHER fields. When compiling the extraction prompt, scan WHEN expressions for referenced variable names and include them in the extraction schema. Alternatively, use the same programmatic pre-evaluation approach from concern #7 — evaluate WHEN conditions against all available context (including parsed user message) before the LLM's tool call.
