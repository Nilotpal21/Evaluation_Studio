# XO11 to ABL Construct Mapping

> **Status**: Reference document for XO11 migration
> **Last Updated**: 2026-02-07

This document maps three XO11 generative AI node types to existing ABL constructs. For each node type, it shows:

1. The **raw XO11 JSON format** (from actual exports)
2. A **direct mapping** — achieving the same experience using native ABL
3. A **recommended ABL-native approach** — better representation leveraging ABL's design

---

## Table of Contents

- [1. GenerativeAI Node](#1-generativeai-node)
- [2. AI Assist Node](#2-ai-assist-node)
- [3. Dynamic Intent Node](#3-dynamic-intent-node)
- [4. Quick Reference Table](#4-quick-reference-table)
- [5. Migration Guidance](#5-migration-guidance)

---

## 1. GenerativeAI Node

### XO11 Raw Format

In XO11, a `generativeai` component makes a single LLM call with a prompt and model settings:

```json
{
  "refId": "comp-abc123",
  "label": "Intent Classifier",
  "componentId": "generativeai",
  "generativeAI": {
    "settings": {
      "model": "gpt-4",
      "temperature": 0.3,
      "max_tokens": 256,
      "integrationName": "openai"
    },
    "prompt": "You are a travel assistant. Classify the user's intent into one of: book_flight, cancel_booking, modify_booking, check_status, general_inquiry.\n\nUser message: {{context.session.userInput}}\n\nRespond with a JSON object: {\"intent\": \"<intent_name>\", \"confidence\": <0-1>}"
  }
}
```

**Key characteristics:**

- Single-shot LLM call (not multi-turn)
- Model, temperature, max_tokens configured per node
- Prompt with `{{context.*}}` variable interpolation
- Output stored at `context.session.<nodeName>.response`
- Common uses: intent classification, text summarization, content generation, sentiment analysis

### Direct Mapping: Same Experience

For **intent classification** (the most common use), map to a reasoning-mode agent with a focused GOAL:

```
AGENT: IntentClassifier
# No FLOW section → reasoning-only execution

GOAL: "Classify the user's message into exactly one intent category and return it"

PERSONA: |
  You are a travel assistant intent classifier.
  You classify user messages into: book_flight, cancel_booking,
  modify_booking, check_status, or general_inquiry.

LIMITATIONS:
  - "Must return exactly one intent classification"
  - "Must include confidence score"

EXECUTION:
  model: "gpt-4"
  temperature: 0.3
  max_tokens: 256

TOOLS:
  classify_intent(message: string) -> {intent: string, confidence: number}
    description: "Return the classified intent and confidence"
```

For **content generation** (summarize, rewrite, etc.), map to a scripted-mode agent with CALL:

```
AGENT: ContentGenerator
# Has FLOW section → flow-based execution

TOOLS:
  generate_content(prompt: string, context: object) -> {text: string}
    description: "Generate content using LLM with the given prompt and context"

FLOW:
  steps: [generate, respond]

  generate:
    CALL: generate_content(prompt, session_context)
    ON_SUCCESS:
      SET: generated_text = result.text
      THEN: respond
    ON_FAIL:
      RESPOND: "I couldn't generate a response. Let me try again."
      THEN: generate

  respond:
    RESPOND: "{{generated_text}}"
    THEN: COMPLETE
```

### Recommended ABL-Native Approach

ABL's reasoning mode already provides LLM-driven behavior without wrapping it in a separate node. The recommended approach depends on the use case:

**For intent classification** — use **Supervisor ROUTING** or **NLU configuration**:

```
SUPERVISOR: TravelSupport

NLU:
  intents:
    - name: "book_flight"
      patterns: ["book a flight", "I want to fly", "flight booking"]
    - name: "cancel_booking"
      patterns: ["cancel", "cancel my booking", "I want to cancel"]
    - name: "modify_booking"
      patterns: ["change", "modify", "update my booking"]
    - name: "check_status"
      patterns: ["status", "where is my booking", "check booking"]

HANDOFF:
  - TO: Booking_Agent
    WHEN: intent == "book_flight"
  - TO: Cancellation_Agent
    WHEN: intent == "cancel_booking"
  - TO: Modification_Agent
    WHEN: intent == "modify_booking"
  - TO: Status_Agent
    WHEN: intent == "check_status"
  - TO: General_Agent
    WHEN: true
```

**For content generation** — use **PERSONA + GOAL** in reasoning mode. The LLM inherently generates content based on the persona and goal without needing an explicit "generate" step:

```
AGENT: TravelAdvisor
# No FLOW section → reasoning-only execution

GOAL: "Provide travel recommendations and summaries based on user preferences"

PERSONA: |
  Expert travel advisor. Provide concise, actionable recommendations.
  Summarize options clearly with pros/cons.

TOOLS:
  search_destinations(preferences: object) -> Destination[]
    description: "Search for destinations matching user preferences"
```

**Why this is better:**

- Intent classification is handled by ABL's NLU + routing layer, not a separate LLM call per message
- Content generation is the natural behavior of reasoning-mode agents — no wrapper needed
- Model and temperature are configured once in EXECUTION, not per-node
- Eliminates the XO11 pattern of "call LLM to decide, then call LLM to act" (two hops → one hop)

---

## 2. AI Assist Node

### XO11 Raw Format

The `aiassist` component provides multi-turn LLM-driven entity extraction with rules and exit conditions:

```json
{
  "refId": "comp-def456",
  "label": "Travel Preferences",
  "componentId": "aiassist",
  "generativeAI": {
    "dynamicEntityConfig": {
      "systemContext": "You are a travel booking assistant. Collect the user's travel preferences through natural conversation. Be friendly and helpful.",
      "dynamicEntities": [
        {
          "entityName": "destination",
          "entityType": "string",
          "description": "Travel destination city or country"
        },
        {
          "entityName": "travel_dates",
          "entityType": "date_range",
          "description": "Check-in and check-out dates"
        },
        {
          "entityName": "num_travelers",
          "entityType": "number",
          "description": "Number of travelers"
        },
        {
          "entityName": "budget_range",
          "entityType": "string",
          "description": "Budget preference (economy, mid-range, luxury)"
        }
      ],
      "rules": [
        "Always confirm the destination before asking about dates",
        "If budget is luxury, suggest premium add-ons",
        "Accept relative dates like 'next weekend' or 'in two weeks'",
        "If destination is ambiguous, ask for clarification"
      ],
      "exitScenarios": [
        {
          "scenarioName": "all_collected",
          "condition": "All required entities (destination, travel_dates, num_travelers) are collected"
        },
        {
          "scenarioName": "user_wants_exit",
          "condition": "User explicitly says they want to stop or cancel"
        }
      ]
    }
  }
}
```

**Key characteristics:**

- Multi-turn conversation (LLM manages the dialog)
- Dynamic entities defined with name, type, and description
- Rules guide LLM behavior during collection
- Exit scenarios define when to stop collecting
- LLM returns structured JSON each turn: `{"bot": "<response>", "conv_status": "in_progress|complete|exit", "entities": [{"entityName": "...", "entityValue": "..."}]}`
- Output path: `context.AI_Assisted_Dialogs.<name>.entities[0].<entityName>`

### Direct Mapping: Same Experience

Map to a **reasoning-mode agent** with GATHER + CONSTRAINTS:

```
AGENT: TravelPreferences
# No FLOW section → reasoning-only execution

GOAL: "Collect all travel preferences through natural conversation"

PERSONA: |
  You are a travel booking assistant. Collect the user's travel
  preferences through natural conversation. Be friendly and helpful.

LIMITATIONS:
  - "Always confirm the destination before asking about dates"
  - "If budget is luxury, suggest premium add-ons"
  - "Accept relative dates like 'next weekend' or 'in two weeks'"
  - "If destination is ambiguous, ask for clarification"

GATHER:
  destination:
    prompt: "Where would you like to travel?"
    type: string
    required: true
    validate: "Must be a valid city or country"

  travel_dates:
    prompt: "When are you planning to travel?"
    type: string
    required: true
    validate: "Must include check-in and check-out dates"

  num_travelers:
    prompt: "How many travelers?"
    type: number
    required: true

  budget_range:
    prompt: "What's your budget preference?"
    type: string
    required: false
    default: "mid-range"

COMPLETE:
  - WHEN: destination IS SET AND travel_dates IS SET AND num_travelers IS SET
    RESPOND: |
      Great! Here's what I have:
      - Destination: {{destination}}
      - Dates: {{travel_dates}}
      - Travelers: {{num_travelers}}
      - Budget: {{budget_range}}

HANDOFF:
  - TO: Search_Agent
    WHEN: destination IS SET AND travel_dates IS SET AND num_travelers IS SET
    CONTEXT:
      pass: [destination, travel_dates, num_travelers, budget_range]
```

### Recommended ABL-Native Approach

ABL's GATHER construct in reasoning mode already provides exactly what AI Assist does — multi-turn LLM-driven entity extraction. The key improvement is combining GATHER with CONSTRAINTS and GUARDRAILS for rule enforcement:

```
AGENT: TravelPreferences
# No FLOW section → reasoning-only execution

GOAL: "Collect travel preferences naturally and hand off to search"

PERSONA: |
  Friendly travel booking assistant. Collect preferences conversationally.
  Don't ask all questions at once — let the conversation flow naturally.

GATHER:
  destination:
    prompt: "Where would you like to travel?"
    type: string
    required: true
    validate: "Must be a real city or country"
    extractionHints: ["city names", "country names", "region names"]

  checkin:
    prompt: "Check-in date?"
    type: date
    required: true
    validate: "Must be today or future date"
    extractionHints: ["next weekend", "in two weeks", "March 15th"]

  checkout:
    prompt: "Check-out date?"
    type: date
    required: true
    validate: "Must be after check-in date"

  num_travelers:
    prompt: "How many travelers?"
    type: number
    required: true
    default: 1

  budget_range:
    prompt: "Budget preference?"
    type: string
    required: false
    default: "mid-range"

CONSTRAINTS:
  always:
    - REQUIRE destination IS SET
      ON_FAIL: "I need to know where you'd like to travel before we discuss dates."

GUARDRAILS:
  confirm_destination:
    kind: output
    check: "confirms_destination_before_dates"
    action: ensure
    msg: "Confirm the destination before moving to date questions"

  handle_ambiguity:
    kind: input
    check: "destination_is_specific"
    action: recommend
    msg: "If destination is ambiguous, ask user to clarify"

TOOLS:
  validate_destination(destination: string) -> {valid: boolean, suggestions: string[]}
    description: "Check if destination is a real, bookable location"

DELEGATE:
  - AGENT: Search_Agent
    WHEN: destination IS SET AND checkin IS SET AND checkout IS SET AND num_travelers IS SET
    PURPOSE: "Search for travel options"
    INPUT: {destination, checkin, checkout, num_travelers, budget_range}
    RETURNS: {results: SearchResult[]}

COMPLETE:
  - WHEN: user.intent == "cancel" OR user.intent == "stop"
    RESPOND: "No problem! Come back anytime."
```

**Why this is better:**

- XO11's `dynamicEntities` → ABL's **GATHER** fields (same concept, cleaner syntax)
- XO11's `rules` → ABL's **LIMITATIONS**, **CONSTRAINTS**, and **GUARDRAILS** depending on whether the rule is prompt guidance, business logic, or safety validation
- XO11's `exitScenarios` → ABL's **COMPLETE** conditions + **DELEGATE** triggers
- XO11's `systemContext` → ABL's **PERSONA** (first-class construct, not a config string)
- ABL adds **validation** per field (XO11 relies entirely on LLM judgment)
- ABL adds **extractionHints** to improve entity extraction accuracy
- ABL separates collection concerns (GATHER) from behavior rules (CONSTRAINTS/GUARDRAILS) from completion (COMPLETE)

---

## 3. Dynamic Intent Node

### XO11 Raw Format

The `dynamicIntent` component reads an intent value from context and routes to the appropriate dialog:

```json
{
  "refId": "comp-ghi789",
  "label": "Dynamic Router",
  "componentId": "dynamicIntent",
  "intentPath": "context.session.fallbackIntentResponse"
}
```

In the dialog tree, it appears as a node with transitions based on the intent value:

```json
{
  "nodeId": "node-xyz",
  "componentRef": "comp-ghi789",
  "transitions": [
    {
      "condition": "intent == 'book_flight'",
      "targetNodeId": "node-booking"
    },
    {
      "condition": "intent == 'cancel_booking'",
      "targetNodeId": "node-cancel"
    },
    {
      "default": true,
      "targetNodeId": "node-fallback"
    }
  ]
}
```

**Key characteristics:**

- No LLM call — purely reads a context variable
- The intent was classified upstream (often by a `generativeai` node)
- Routes based on string matching against the stored intent
- Supports a default/fallback route
- Essentially a context-driven switch statement

### Direct Mapping: Same Experience

**Scripted mode** — map to ON_INPUT with CHECK:

```
AGENT: DynamicRouter
# Has FLOW section → flow-based execution

FLOW:
  steps: [route]

  route:
    CHECK: context.computed_intent IS SET
    ON_INPUT:
      - IF: context.computed_intent == "book_flight"
        SIGNAL: HANDOFF booking_agent
        THEN: COMPLETE
      - IF: context.computed_intent == "cancel_booking"
        SIGNAL: HANDOFF cancellation_agent
        THEN: COMPLETE
      - IF: context.computed_intent == "modify_booking"
        SIGNAL: HANDOFF modification_agent
        THEN: COMPLETE
      - ELSE:
        SIGNAL: HANDOFF fallback_agent
        THEN: COMPLETE
```

**Supervisor level** — map to handoff rules:

```
SUPERVISOR: TravelSupport

HANDOFF:
  - TO: Booking_Agent
    WHEN: context.computed_intent == "book_flight"
  - TO: Cancellation_Agent
    WHEN: context.computed_intent == "cancel_booking"
  - TO: Modification_Agent
    WHEN: context.computed_intent == "modify_booking"
  - TO: Fallback_Agent
    WHEN: true
```

### Recommended ABL-Native Approach

The XO11 pattern of "classify intent in one node, then route in another node" is a two-step pattern that ABL eliminates. ABL's supervisor handles intent classification and routing as a single operation:

```
SUPERVISOR: TravelSupport

HANDOFF:
  - TO: Human_Support
    WHEN: user.wants_escalation
  - TO: Booking_Agent
    WHEN: intent.category IN ["book_flight", "book_hotel", "make_reservation"]
  - TO: Cancellation_Agent
    WHEN: intent.category IN ["cancel", "cancel_booking", "request_refund"]
  - TO: Modification_Agent
    WHEN: intent.category IN ["change", "modify", "update_booking"]
  - TO: Status_Agent
    WHEN: intent.category IN ["status", "where_is", "check_booking"]
  - TO: General_Agent
    WHEN: true
```

**Why this is better:**

- XO11 requires two nodes (classify + route) — ABL does it in one supervisor
- ABL's NLU + INTENTS mapping handles classification without a dedicated `generativeai` node
- `HANDOFF` targets make routing declarative without a separate intent mapping block
- No intermediate context variable (`context.session.fallbackIntentResponse`) needed
- Adding a new intent/agent is a one-line change in INTENTS, not a new node + transition wiring
- Supervisor handoffs support priority-based evaluation, so security/escalation rules take precedence

**For dynamic routing based on runtime-computed values** (e.g., an upstream agent determines the next agent):

```
SUPERVISOR: TravelSupport

HANDOFF:
  - TO: ${context.next_agent}
    WHEN: context.next_agent IS SET
  - TO: General_Agent
    WHEN: true
```

This supports the XO11 pattern where the intent path is computed dynamically, but does so within the supervisor's handoff rules rather than requiring a separate `dynamicIntent` node.

---

## 4. Quick Reference Table

| XO11 Node                  | XO11 Purpose                              | ABL Direct Mapping                        | ABL Recommended Approach                               |
| -------------------------- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `generativeai` (classify)  | Single LLM call for intent classification | Reasoning agent with GOAL + PERSONA       | Supervisor NLU + INTENTS + ROUTING                     |
| `generativeai` (generate)  | Single LLM call for content generation    | Scripted agent with CALL to LLM tool      | Reasoning agent with PERSONA (LLM generates naturally) |
| `generativeai` (summarize) | Single LLM call for summarization         | Scripted agent with CALL to LLM tool      | TOOLS + reasoning mode (summarize as a tool)           |
| `aiassist`                 | Multi-turn LLM entity extraction          | Reasoning agent with GATHER + CONSTRAINTS | GATHER + GUARDRAILS + COMPLETE + DELEGATE              |
| `dynamicIntent`            | Context-based intent routing              | Scripted ON_INPUT with conditions         | Supervisor ROUTING with `?intent_match`                |

### Construct-Level Mapping

| XO11 Concept                          | ABL Construct                                | Notes                                                                          |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `generativeAI.settings.model`         | `EXECUTION.model`                            | Configured once per agent, not per node                                        |
| `generativeAI.settings.temperature`   | `EXECUTION.temperature`                      | Same                                                                           |
| `generativeAI.settings.max_tokens`    | `EXECUTION.max_tokens`                       | Same                                                                           |
| `generativeAI.prompt`                 | `PERSONA` + `GOAL`                           | Behavior defined declaratively, not as a prompt string                         |
| `dynamicEntityConfig.systemContext`   | `PERSONA`                                    | First-class construct                                                          |
| `dynamicEntityConfig.dynamicEntities` | `GATHER` fields                              | Typed, validated, with extraction hints                                        |
| `dynamicEntityConfig.rules`           | `LIMITATIONS` + `CONSTRAINTS` + `GUARDRAILS` | Split by semantics: prompt guidance, runtime business logic, and safety checks |
| `dynamicEntityConfig.exitScenarios`   | `COMPLETE` conditions                        | Declarative completion triggers                                                |
| `intentPath`                          | Supervisor `ROUTING` condition               | Direct variable reference in routing table                                     |
| Node transitions                      | `THEN` / `HANDOFF` / `ROUTING`               | Declarative flow control                                                       |
| `{{context.*}}` interpolation         | `{{variable}}` in templates                  | Same concept, simpler syntax                                                   |

---

## 5. Migration Guidance

### General Principles

1. **Don't replicate the two-hop pattern.** XO11 often uses `generativeai` → `dynamicIntent` (classify then route). In ABL, the supervisor handles both in one step via NLU + ROUTING.

2. **Move from prompt engineering to declarative constructs.** XO11 embeds behavior in prompt strings. ABL uses GOAL, PERSONA, LIMITATIONS, GATHER, and CONSTRAINTS — each with distinct semantics and enforcement behavior.

3. **Entity extraction is built-in.** XO11's `aiassist` wraps an LLM to extract entities. ABL's GATHER does this natively with type validation, extraction hints, and configurable strategy (LLM, pattern, or hybrid).

4. **Rules become enforceable.** XO11's `rules` array is a hint to the LLM. ABL's CONSTRAINTS and GUARDRAILS are checked at runtime and trigger specific actions on failure (respond, escalate, block, handoff).

5. **Keep the xo11-converter for automated migration.** The converter at `packages/kore-platform-cli/src/mcp/import/xo11-converter.ts` handles the mechanical translation. This document guides manual refinement of the generated ABL.

### Migration Steps

1. **Run the xo11-converter** to generate initial ABL from the dialog tree export
2. **Review generated agents** — the converter maps basic nodes (entity, message, webhook, script)
3. **For `generativeai` nodes used as classifiers**: Remove the generated agent and configure the supervisor's NLU + INTENTS + ROUTING instead
4. **For `generativeai` nodes used as generators**: Convert to reasoning-mode agents with appropriate GOAL and PERSONA
5. **For `aiassist` nodes**: Convert to reasoning-mode agents with GATHER fields, then move rules to LIMITATIONS, CONSTRAINTS, or GUARDRAILS based on whether they are prompt guidance, business logic, or safety checks
6. **For `dynamicIntent` nodes**: Remove and configure supervisor ROUTING with appropriate conditions
7. **Validate** that all transition paths are preserved in the ABL routing

### Future Enhancements

These ABL features, when implemented, will further improve the migration experience:

| Feature            | Status                           | Benefit for Migration                                         |
| ------------------ | -------------------------------- | ------------------------------------------------------------- |
| Interrupt handling | Design complete, not implemented | Maps XO11 mid-flow task switching                             |
| NLU embeddings     | Implemented                      | Improves intent classification accuracy over pattern matching |
| Multi-language     | Design proposed                  | Maps XO11 localization features                               |
