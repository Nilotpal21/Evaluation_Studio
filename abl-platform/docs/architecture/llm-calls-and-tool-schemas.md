# LLM Calls and Tool Schemas in ABL

This document catalogs every type of LLM call the ABL runtime makes, what is sent (system prompt, messages, tools), and the exact tool schemas the LLM receives.

> **Runtime note (2026-04-01)**: The primary routing surface is now per-target `handoff_to_<Agent>` and `delegate_to_<Agent>` tools built from the active IR. Generic `__handoff__`, `__delegate__`, and `__fan_out__` remain runtime compatibility paths for cached tool lists and parallel-call normalization, but they are not the default prompt-builder output.

---

## Table of Contents

1. [LLM Call Types Overview](#llm-call-types-overview)
2. [Call Type 1: Reasoning (response_gen)](#call-type-1-reasoning-response_gen)
3. [Call Type 2: Entity Extraction (extraction)](#call-type-2-entity-extraction-extraction)
4. [Call Type 3: Field Validation (validation)](#call-type-3-field-validation-validation)
5. [System Tool Schemas](#system-tool-schemas)
6. [Regular Tool Schemas](#regular-tool-schemas)
7. [System Prompt Structure](#system-prompt-structure)
8. [Message Format and Tool Result Flow](#message-format-and-tool-result-flow)

---

## LLM Call Types Overview

All LLM calls go through `SessionLLMClient.chatWithToolUse()` at `session-llm-client.ts:201`. The `operationType` parameter determines model resolution (different operations can use different models/providers).

| Call Type             | `operationType` | Tools Sent             | Called From                 | Purpose                                                    |
| --------------------- | --------------- | ---------------------- | --------------------------- | ---------------------------------------------------------- |
| **Reasoning**         | `response_gen`  | All (system + regular) | `reasoning-executor.ts:251` | Main agent reasoning loop — generate responses, call tools |
| **Entity Extraction** | `extraction`    | None (`[]`)            | `flow-step-executor.ts:798` | Extract field values from user message                     |
| **Field Validation**  | `validation`    | None (`[]`)            | `llm-field-validator.ts:59` | Validate extracted values against rules                    |

---

## Call Type 1: Reasoning (response_gen)

The main agent loop. The LLM receives the full system prompt, conversation history, and all available tools. It can respond with text, call tools, or both.

**Called at**: `reasoning-executor.ts:251`

```typescript
const result = await session.llmClient!.chatWithToolUse(
  systemPrompt, // Built by buildSystemPrompt()
  messages, // Conversation history + tool exchanges
  tools, // Built by buildTools()
  'response_gen',
);
```

### What the LLM receives

```
┌─────────────────────────────────────────────────┐
│ system: (buildSystemPrompt output)              │
│   You are Booking_Agent, an AI assistant.       │
│   Your goal: Help users book hotels             │
│   Persona: Friendly and efficient               │
│   Limitations:                                  │
│   - Cannot process payments directly            │
│   - Cannot access external booking systems      │
│   You have access to tools...                   │
│   You need to gather: destination, dates, ...   │
│   ## Handoff (use only when necessary)          │
│   ## Escalation                                 │
│   ## Current Context                            │
│   { "destination": "Paris", "dates": "..." }    │
│   ## Recalled Memory Instructions               │
│   (any RECALL prompt_llm instructions)          │
├─────────────────────────────────────────────────┤
│ messages: [                                     │
│   { role: "user", content: "Find hotels..." }   │
│   { role: "assistant", content: "I found..." }  │
│   { role: "user", content: "Book the first" }   │
│   --- within same turn (ephemeral): ---         │
│   { role: "assistant", content: [tool_use] }    │
│   { role: "user", content: [tool_result] }      │
│ ]                                               │
├─────────────────────────────────────────────────┤
│ tools: [                                        │
│   { name: "search_hotels", ... }                │
│   { name: "create_booking", ... }               │
│   { name: "handoff_to_Booking_Agent", ... }     │
│   { name: "handoff_to_Support_Agent", ... }     │
│   { name: "__fan_out__", ... }                  │
│   { name: "delegate_to_Price_Calculator", ... } │
│   { name: "__escalate__", ... }                 │
│ ]                                               │
└─────────────────────────────────────────────────┘
```

### LLM can respond with

1. **Text only** → final response, loop ends
2. **Tool call(s)** → runtime executes tools, adds results to messages, calls LLM again
3. **Text + tool calls** → text streamed to user, tools executed, loop continues

### Iteration loop

```
while (iterations < maxIterations):
    LLM call with (systemPrompt, messages, tools)
    if text only → break
    if tool calls:
        messages.push(assistant: tool_use blocks)
        for each tool call:
            execute tool
            collect result
        messages.push(user: tool_result blocks)
        continue loop
```

**Code**: `reasoning-executor.ts:246-394`

---

## Call Type 2: Entity Extraction (extraction)

A separate LLM call dedicated to extracting structured field values from the user's message. Used by GATHER (both flow mode and reasoning mode).

**Called at**: `flow-step-executor.ts:798`

```typescript
const response = await session.llmClient!.chatWithToolUse(
  systemPrompt, // Entity extraction instructions
  [{ role: 'user', content: userMessage }], // Single user message
  [], // No tools
  'extraction',
);
```

### What the LLM receives

```
┌─────────────────────────────────────────────────┐
│ system:                                         │
│   You are an entity extraction assistant.       │
│   Extract information from the user's message.  │
│   Return ONLY a valid JSON object.              │
│                                                 │
│   ALREADY COLLECTED:                            │
│   destination: "Paris"                          │
│   check_in: "2026-03-10"                        │
│                                                 │
│   RULES:                                        │
│   1. If user says "same" → return from ALREADY  │
│   2. For dates: Convert to YYYY-MM-DD           │
│   3. Only extract explicitly stated values      │
│   4. If REQUIRED field not found, omit it       │
│   5. Capitalize proper nouns                    │
│                                                 │
│   Fields to extract:                            │
│   (REQUIRED) "check_out" (date) - checkout date │
│     [must match pattern: YYYY-MM-DD]            │
│   (REQUIRED) "num_guests" (number) - number of  │
│     guests [valid range: 1-10]                  │
│   (optional) "room_type" - preferred room type  │
│     [allowed values: single, double, suite]     │
│                                                 │
│   Example 1:                                    │
│   User: "John Smith, email john@example.com"    │
│   Output: {"name":"John Smith","email":"..."}   │
│                                                 │
│   IMPORTANT: Return ONLY JSON, no explanations  │
├─────────────────────────────────────────────────┤
│ messages: [                                     │
│   { role: "user", content: "2 guests, leaving   │
│     March 15, suite please" }                   │
│ ]                                               │
├─────────────────────────────────────────────────┤
│ tools: []  (no tools)                           │
└─────────────────────────────────────────────────┘
```

### LLM responds with

Raw JSON (no tools):

```json
{ "check_out": "2026-03-15", "num_guests": 2, "room_type": "suite" }
```

### Post-processing (`flow-step-executor.ts:827-895`)

1. Parse JSON from response (handles markdown code blocks)
2. Map field name case variations
3. Validate against `GatherField.validation` rules (pattern, range, enum)
4. If validation type is `llm` → triggers Call Type 3 (field validation)
5. Invalid fields are deleted from result

### Extraction strategies (per field)

| Strategy           | What happens                             | When to use                              |
| ------------------ | ---------------------------------------- | ---------------------------------------- |
| `pattern`          | Regex only, no LLM call                  | Structured formats (email, phone, dates) |
| `llm`              | LLM only, no regex                       | Free-text, intent, complex values        |
| `hybrid` (default) | LLM first, regex fallback on LLM failure | Most fields                              |

Fields with `strategy: pattern` are extracted via regex before the LLM call and excluded from the LLM prompt. If all fields are pattern-only, no LLM call is made at all.

**Code**: `flow-step-executor.ts:609-927`

---

## Call Type 3: Field Validation (validation)

A lightweight LLM call to validate a single extracted field value against a custom rule. Only used when `GatherField.validation.type === 'llm'`.

**Called at**: `llm-field-validator.ts:59`

```typescript
const response = await llmClient.chatWithToolUse(
  systemPrompt, // Validation instructions
  [{ role: 'user', content: `Validate this value: ${valueStr}` }],
  [], // No tools
  'validation',
);
```

### What the LLM receives

```
┌─────────────────────────────────────────────────┐
│ system:                                         │
│   You are a validation assistant.               │
│   Validate the given value against the rule.    │
│   Return ONLY a JSON object:                    │
│     {"valid": true}                             │
│     or {"valid": false, "reason": "..."}        │
│                                                 │
│   Rule: Must be a real city name, not a country │
│   Field: destination                            │
│   Value: "France"                               │
│                                                 │
│   IMPORTANT: Return ONLY JSON                   │
├─────────────────────────────────────────────────┤
│ messages: [                                     │
│   { role: "user", content: "Validate: France" } │
│ ]                                               │
├─────────────────────────────────────────────────┤
│ tools: []  (no tools)                           │
└─────────────────────────────────────────────────┘
```

### LLM responds with

```json
{ "valid": false, "reason": "France is a country, not a city. Did you mean Paris?" }
```

### Behavior

- **Fail-open**: If the LLM call errors, the field is treated as valid (non-blocking)
- **Size guard**: Values > 2000 chars are rejected before calling LLM
- Called once per field that has `validation.type: 'llm'`

**Code**: `llm-field-validator.ts:31-78`

---

## System Tool Schemas

These are the routing/system schemas the runtime can execute. `buildTools()` now emits per-target routing tools, and the runtime keeps the legacy generic routing tools as compatibility safety nets.

### `handoff_to_<TargetAgent>` — Per-Target Route / Handoff Tool

**Added when**: Agent has `routing.rules` or `coordination.handoffs`

**Code**: `prompt-builder.ts:839-1018`

```json
{
  "name": "handoff_to_Booking_Agent",
  "description": "[Priority 1]. Route booking requests. Use when: intent.category == \"booking\". This agent returns control after completion.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "description": "Why this routing decision is appropriate"
      },
      "message": {
        "type": "string",
        "description": "The user request or sub-request this agent should handle"
      },
      "customer_id": {
        "type": "string",
        "description": "Context: customer_id"
      }
    },
    "required": ["reason", "message"]
  }
}
```

**Tool names are derived from the active IR target list**:

- `ir.routing.rules[].to` (supervisor routing rules)
- `ir.coordination.handoffs[].to` (specialist handoffs)

The schema is per-target, not a generic enum. `CONTEXT.pass` fields become typed tool parameters by resolving against the agent's session-memory declarations. Descriptions incorporate priority, `WHEN`, and `RETURN` semantics directly into the tool text so the model routes by tool name and description instead of by enum choice.

**LLM calls it**:

```json
{
  "name": "handoff_to_Booking_Agent",
  "input": {
    "reason": "The booking specialist should handle this request",
    "message": "Help the user with booking support"
  }
}
```

**Runtime handles it**: `reasoning-executor.ts` extracts the target name from the tool name and calls `RoutingExecutor.handleHandoff()`. The generic `__handoff__` tool is still accepted as a compatibility safety net for cached tool lists.

---

### `__fan_out__` — Legacy Compatibility Path for Parallel Dispatch

**Added when**: Not added by `buildTools()` in the normal prompt-builder path. It is still accepted by the runtime for cached tool lists, historical prompts, and provider responses that are normalized from parallel routing calls.

**Code**: `reasoning-executor.ts:1406-1470` and `reasoning-executor.ts:2541-2563`

```json
{
  "name": "__fan_out__",
  "description": "Handle a message with MULTIPLE distinct requests needing different specialists. Use ONLY when the user asks 2+ unrelated things in one message. Results are returned for you to synthesize into one unified response.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tasks": {
        "type": "array",
        "description": "List of sub-tasks to dispatch to specialist agents",
        "items": {
          "type": "object",
          "properties": {
            "target": { "type": "string" },
            "intent": { "type": "string" },
            "context": { "type": "object" }
          },
          "required": ["target", "intent"]
        },
        "minItems": 2,
        "maxItems": 5
      }
    },
    "required": ["tasks"]
  }
}
```

**Runtime handles it**: `reasoning-executor.ts` forwards the task list to `RoutingExecutor.handleFanOut()`. New classifier-driven and guided multi-intent flows can reach the same fan-out execution path without exposing `__fan_out__` to the model, because they build a canonical parallel execution plan first.

Each task creates a separate thread, all run in parallel, results merge back. The supervisor LLM receives formatted results and synthesizes one unified response.

---

### `delegate_to_<TargetAgent>` — Per-Target Delegate Tool

**Added when**: Agent has `coordination.delegates`

**Code**: `prompt-builder.ts:839-1049`

```json
{
  "name": "delegate_to_Price_Calculator",
  "description": "Calculate total price with taxes. Use when: needs_pricing == true. Runs to completion and returns a result you can use.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "description": "Why this sub-agent should handle the work"
      },
      "message": {
        "type": "string",
        "description": "Instruction for the sub-agent"
      },
      "route": {
        "type": "string",
        "description": "Input: route (mapped from route)"
      }
    },
    "required": ["reason", "message"]
  }
}
```

**Description includes**: Each delegate's `purpose` and `when` condition from the DSL, and any `DELEGATE.INPUT` mappings become typed parameters.

**LLM calls it**:

```json
{
  "name": "delegate_to_Price_Calculator",
  "input": {
    "reason": "Need a pricing calculation",
    "message": "Calculate total price for this itinerary",
    "route": "DXB-CDG"
  }
}
```

**Runtime handles it**: `reasoning-executor.ts` extracts the delegate target from the tool name and calls `RoutingExecutor.handleDelegate()`. The generic `__delegate__` path is still accepted as a compatibility fallback.

Delegate runs to completion in an ephemeral thread. Parent blocks until delegate returns. Result stored in `session.data.values["use_result_key"]` and mapped via `RETURNS` config.

---

### `__return_to_parent__` — Return Control to Parent Supervisor

**Added when**: Active thread has `returnExpected=true` AND `handoffFrom` set (i.e., agent was invoked via `HANDOFF RETURN:true`)

**Code**: `prompt-builder.ts` (after `__escalate__` injection block)

```json
{
  "name": "__return_to_parent__",
  "description": "Return control to your supervisor (Supervisor_Name). Use ONLY when the user asks something outside your capabilities. Do NOT use for requests you can handle.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "description": "Why you cannot handle this request"
      },
      "message": {
        "type": "string",
        "description": "The user message to forward to your supervisor for re-routing"
      }
    },
    "required": ["reason", "message"]
  }
}
```

**Description varies**: The supervisor name in the description is dynamically set from `activeThread.handoffFrom`.

**LLM calls it**:

```json
{
  "name": "__return_to_parent__",
  "input": {
    "reason": "User is asking about account balance which is outside my payment processing capabilities",
    "message": "what's my balance?"
  }
}
```

**Runtime handles it**: `reasoning-executor.ts` → `routing-executor.ts` `handleReturnToParent()`

Sets child thread status to `waiting` (not `completed`), stores the forwarded message in `_forwarded_message` data field, breaks the reasoning loop. The forwarded message is then injected as a `user` message into the parent supervisor's conversation history, allowing the supervisor to re-route to an appropriate agent.

**Thread resume**: When the supervisor later re-routes back to the same child agent via the corresponding `handoff_to_<Agent>` tool, the runtime detects the existing `waiting` thread and **resumes it** instead of creating a new one. The child's conversation history, gathered data, and flow position are fully preserved.

---

### `__escalate__` — Transfer to Human Agent

**Added when**: Agent has `coordination.escalation` configured

**Code**: `prompt-builder.ts:557-579`

```json
{
  "name": "__escalate__",
  "description": "Transfer the conversation to a human agent. Use when the user explicitly requests human help or when you cannot assist them.",
  "input_schema": {
    "type": "object",
    "properties": {
      "reason": {
        "type": "string",
        "description": "Reason for escalation"
      },
      "priority": {
        "type": "string",
        "description": "Priority level",
        "enum": ["low", "medium", "high", "critical"]
      }
    },
    "required": ["reason"]
  }
}
```

**LLM calls it**:

```json
{
  "name": "__escalate__",
  "input": { "reason": "User insists on speaking with a human", "priority": "high" }
}
```

**Runtime handles it**: `reasoning-executor.ts:522-546` → `routing-executor.ts` `handleEscalate()`

Sets `session.isEscalated = true`, breaks the tool-use loop.

---

### `__complete__` — Session Completion (NOT a tool)

**NOT sent to the LLM.** Removed from the tools array at `prompt-builder.ts:554-555`.

Completion is **runtime-evaluated** after each reasoning turn:

```typescript
// runtime-executor.ts:1153
if (this.routing.checkAndMarkComplete(session, onTraceEvent)) {
  result.action = { type: 'complete', message: result.response };
}
```

`checkAndMarkComplete()` at `routing-executor.ts:1171` evaluates COMPLETE conditions from the IR against `session.data.values`. First matching `WHEN` condition triggers completion.

The `SYSTEM_TOOL_COMPLETE` constant still exists as a safety net in `reasoning-executor.ts:514-521` — if the LLM somehow calls it, it works. But the tool is not in the tools array.

**Why not a tool?** Completion is a runtime guarantee, not an LLM decision. The runtime evaluates conditions against actual state deterministically.

---

## Regular Tool Schemas

User-defined tools from the DSL's `TOOLS` section.

**Code**: `prompt-builder.ts:389-418`

### Conversion: IR → LLM Schema

```
DSL:
  TOOLS:
    - search_hotels:
        TYPE: http
        URL: "https://api.example.com/hotels/search"
        METHOD: POST
        DESCRIPTION: "Search for available hotels"
        PARAMS:
          destination:
            TYPE: string
            DESCRIPTION: "City or region"
            REQUIRED: true
          check_in:
            TYPE: date
            DESCRIPTION: "Check-in date"
            REQUIRED: true
          max_price:
            TYPE: number
            DESCRIPTION: "Maximum price per night"
            REQUIRED: false
          amenities:
            TYPE: string[]
            DESCRIPTION: "Required amenities"
            REQUIRED: false

      ↓ compiled to IR (ToolDefinition at schema.ts:297)

      ↓ converted by buildTools() (prompt-builder.ts:392-416)

LLM receives:
```

```json
{
  "name": "search_hotels",
  "description": "Search for available hotels",
  "input_schema": {
    "type": "object",
    "properties": {
      "destination": {
        "type": "string",
        "description": "City or region"
      },
      "check_in": {
        "type": "string",
        "description": "Check-in date"
      },
      "max_price": {
        "type": "number",
        "description": "Maximum price per night"
      },
      "amenities": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Required amenities"
      }
    },
    "required": ["destination", "check_in"]
  }
}
```

### Type Mapping (`ablTypeToJsonSchema`)

| ABL Type                     | JSON Schema                                          | Notes            |
| ---------------------------- | ---------------------------------------------------- | ---------------- |
| `string`                     | `{ "type": "string" }`                               | Default          |
| `number`, `integer`, `float` | `{ "type": "number" }`                               |                  |
| `boolean`                    | `{ "type": "boolean" }`                              |                  |
| `date`                       | `{ "type": "string" }`                               | Dates as strings |
| `string[]`, `array`          | `{ "type": "array", "items": { "type": "string" } }` |                  |
| `object`, `json`             | `{ "type": "object" }`                               |                  |
| `enum(a,b,c)`                | `{ "type": "string", "enum": ["a","b","c"] }`        |                  |

### Required Fields

Parameters with `REQUIRED: true` (or no `REQUIRED` field — defaults to true) are added to the `required` array. Parameters with `REQUIRED: false` are optional.

---

## System Prompt Structure

Built by `buildSystemPrompt()` at `prompt-builder.ts:107-257`. The system prompt is a single string composed of ordered sections:

```
1. Identity
   "You are Booking_Agent, an AI assistant."
   "Your goal: Help users book hotels"
   "Persona: Friendly and efficient"
   "Limitations: - Cannot process payments directly"

2. Tools context (if tools exist)
   "You have access to tools. Use them when needed."

3. Gather fields (if GATHER defined)
   "You need to gather the following information:"
   "- destination: Where do you want to go? (required)"
   "- check_in: When do you want to check in? (required)"
   "Continue asking for any missing required fields."

4. Routing instructions (varies by agent type)

   [Supervisor]:
   "## CRITICAL: You are a ROUTING-ONLY supervisor"
   "## Routing Rules (use handoff_to_<Agent> tools):"
   "- handoff_to_Booking_Agent: When user wants to book"
   "## MANDATORY: Always use the matching handoff_to_<Agent> tool"
   "## Multi-Intent Messages"
   "emit the relevant routing tools; runtime normalizes legacy parallel calls when needed"

   [Specialist with handoffs]:
   "## Your Role"
   "You are a specialist agent. Help the user directly."
   "## Handoff (use only when necessary)"
   "- Support_Agent"

5. Escalation instructions (if configured)
   "## Escalation"
   "Use the __escalate__ tool ONLY if:"
   "- Customer requests supervisor (priority: high)"
   "IMPORTANT: Always attempt to help at least once"

6. Voice channel format (if voice)
   "## Response Format (Voice Channel)"
   "No markdown, no emoji, plain conversational text"

7. Current Context (dynamic, from session.data.values)
   "## Current Context"
   { "destination": "Paris", "check_in": "2026-03-10", "num_guests": 2 }

8. Recalled Memory (from RECALL prompt_llm)
   "## Recalled Memory Instructions"
   "User prefers luxury hotels and early check-in"
```

**Key behavior:**

- Sections 1-6 are built from the IR (static per agent, changes only on redeployment)
- Section 7 (Current Context) updates every turn from `session.data.values` (excludes `_`-prefixed internal keys)
- Section 8 (Recalled Memory) updates based on RECALL instructions triggered by events

---

## Message Format and Tool Result Flow

### Messages array structure

The `messages` array sent to the LLM follows the Anthropic API format:

```typescript
// Simple text messages
{ role: "user", content: "Find hotels in Paris" }
{ role: "assistant", content: "I found 5 hotels..." }

// Tool use (assistant response containing tool calls)
{ role: "assistant", content: [
    { type: "text", text: "Let me search for hotels." },
    { type: "tool_use", id: "toolu_123", name: "search_hotels", input: { destination: "Paris" } }
]}

// Tool results (sent as user message)
{ role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_123", content: "{\"count\":5,\"hotels\":[...]}" }
]}
```

### What is persisted vs ephemeral

```
session.conversationHistory (persisted to Redis):
  [user]      "Find hotels in Paris for 2 guests"
  [assistant]  "I found 5 hotels in Paris. The cheapest is Hotel Lumiere at $120/night."
  [user]      "Book the first one"
  [assistant]  "Your booking is confirmed! Confirmation code: CONF-ABC."

local messages array (ephemeral, rebuilt each turn):
  [user]      "Book the first one"
  [assistant]  { tool_use: "create_booking", input: { hotel_id: "htl-1", guests: 2 } }
  [user]      { tool_result: id=xyz, content: '{"success":true,"code":"CONF-ABC"}' }
  [assistant]  "Your booking is confirmed! Confirmation code: CONF-ABC."
```

- **Tool_use blocks** → pushed to local `messages` at `reasoning-executor.ts:309-312`
- **Tool_result blocks** → pushed to local `messages` at `reasoning-executor.ts:374-378`
- **Final text response only** → saved to `session.conversationHistory` at `reasoning-executor.ts:418-419`
- **Local messages array** → garbage collected when `execute()` returns

On the next user message, the LLM has no memory of intermediate tool calls — only the final summarized responses.

### Tool result storage in session context

After each tool call (`reasoning-executor.ts:604`):

```typescript
session.data.values[`last_${toolCall.name}_result`] = toolResult;
```

This raw result blob appears in the system prompt's `## Current Context` section on the next LLM call. See GAP-12 in `docs/memory-and-session-store.md` for context bloat concerns.

---

## Complete Example: Full LLM Call for a Booking Agent

### Agent DSL

```abl
AGENT: Booking_Agent
MODE: reasoning
GOAL: "Help users search and book hotels"
PERSONA: "Friendly, efficient travel assistant"

LIMITATIONS:
  - "Cannot process payments directly"
  - "Cannot guarantee room availability"

GATHER:
  - destination:
      TYPE: string
      PROMPT: "Where would you like to stay?"
      REQUIRED: true
  - check_in:
      TYPE: date
      PROMPT: "Check-in date?"
      REQUIRED: true
  - num_guests:
      TYPE: number
      PROMPT: "How many guests?"
      REQUIRED: true
      VALIDATION:
        TYPE: range
        RULE: "1-10"

TOOLS:
  - search_hotels:
      TYPE: http
      URL: "https://api.example.com/hotels/search"
      DESCRIPTION: "Search for available hotels by destination and dates"
      PARAMS:
        destination: { TYPE: string, REQUIRED: true }
        check_in: { TYPE: date, REQUIRED: true }
        check_out: { TYPE: date, REQUIRED: false }
        guests: { TYPE: number, REQUIRED: false }

  - create_booking:
      TYPE: http
      URL: "https://api.example.com/bookings"
      DESCRIPTION: "Create a hotel booking"
      PARAMS:
        hotel_id: { TYPE: string, REQUIRED: true }
        guest_name: { TYPE: string, REQUIRED: true }

HANDOFF:
  - TO: Support_Agent
    WHEN: intent == "support"

ESCALATE:
  TRIGGERS:
    - WHEN: "Customer requests supervisor"
      PRIORITY: high

COMPLETE:
  - WHEN: "booking_confirmed == true"
    RESPOND: "Your booking is confirmed!"
```

### Actual LLM API Call (Turn 3 — user says "Book the first one")

**System prompt** (built by `buildSystemPrompt()`):

```
You are Booking_Agent, an AI assistant.

Your goal: Help users search and book hotels

Persona: Friendly, efficient travel assistant

Limitations:
- Cannot process payments directly
- Cannot guarantee room availability

You have access to tools. Use them when needed to help the user.

You need to gather the following information from the user:
- destination: Where would you like to stay? (required)
- check_in: Check-in date? (required)
- num_guests: How many guests? (required)
Continue asking for any missing required fields. The system will automatically detect when all information has been gathered.

## Your Role
You are a specialist agent. Help the user directly with your expertise.
Do NOT immediately hand off - try to assist the user first.

## Handoff (use only when necessary)
If the user's request is clearly outside your expertise, you can transfer to:
- **Support_Agent**
IMPORTANT: Only use the matching `handoff_to_<Agent>` tool when the specific handoff conditions above are met.

## Escalation
Use the __escalate__ tool ONLY if:
- Customer requests supervisor (priority: high)
- The user explicitly and repeatedly asks for a human agent
IMPORTANT: Always attempt to help the user at least once before escalating.
Do NOT escalate for normal routing - use the matching `handoff_to_<Agent>` tool instead.

## Current Context
{
  "destination": "Paris",
  "check_in": "2026-03-10",
  "num_guests": 2,
  "last_search_hotels_result": {
    "count": 5,
    "hotels": [
      { "id": "htl-1", "name": "Hotel Lumiere", "price": 120 },
      { "id": "htl-2", "name": "Le Grand Paris", "price": 250 }
    ]
  }
}
```

**Messages**:

```json
[
  { "role": "user", "content": "I want to find hotels in Paris, checking in March 10, 2 guests" },
  {
    "role": "assistant",
    "content": "I found 5 hotels in Paris. The cheapest is Hotel Lumiere at $120/night. Would you like to book one?"
  },
  { "role": "user", "content": "Book the first one" }
]
```

**Tools**:

```json
[
  {
    "name": "search_hotels",
    "description": "Search for available hotels by destination and dates",
    "input_schema": {
      "type": "object",
      "properties": {
        "destination": { "type": "string", "description": "destination" },
        "check_in": { "type": "string", "description": "Check-in date" },
        "check_out": { "type": "string", "description": "check_out" },
        "guests": { "type": "number", "description": "guests" }
      },
      "required": ["destination", "check_in"]
    }
  },
  {
    "name": "create_booking",
    "description": "Create a hotel booking",
    "input_schema": {
      "type": "object",
      "properties": {
        "hotel_id": { "type": "string", "description": "hotel_id" },
        "guest_name": { "type": "string", "description": "guest_name" }
      },
      "required": ["hotel_id", "guest_name"]
    }
  },
  {
    "name": "handoff_to_Support_Agent",
    "description": "Transfer the conversation to Support_Agent when the request is outside your expertise.",
    "input_schema": {
      "type": "object",
      "properties": {
        "reason": {
          "type": "string",
          "description": "Why Support_Agent should take over"
        },
        "message": {
          "type": "string",
          "description": "The user request or sub-request this agent should handle"
        }
      },
      "required": ["reason", "message"]
    }
  },
  {
    "name": "__fan_out__",
    "description": "Legacy compatibility path for batched parallel routing. The normal tool surface is per-target handoff_to_<Agent> / delegate_to_<Agent>.",
    "input_schema": {
      "type": "object",
      "properties": {
        "tasks": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "target": { "type": "string", "enum": ["Support_Agent"] },
              "intent": { "type": "string" },
              "context": { "type": "object" }
            },
            "required": ["target", "intent"]
          },
          "minItems": 2,
          "maxItems": 5
        }
      },
      "required": ["tasks"]
    }
  },
  {
    "name": "__escalate__",
    "description": "Transfer the conversation to a human agent. Use when the user explicitly requests human help or when you cannot assist them.",
    "input_schema": {
      "type": "object",
      "properties": {
        "reason": { "type": "string", "description": "Reason for escalation" },
        "priority": {
          "type": "string",
          "description": "Priority level",
          "enum": ["low", "medium", "high", "critical"]
        }
      },
      "required": ["reason"]
    }
  }
]
```

**LLM responds**:

```json
{
  "content": [
    { "type": "text", "text": "Let me book Hotel Lumiere for you." },
    {
      "type": "tool_use",
      "id": "toolu_456",
      "name": "create_booking",
      "input": { "hotel_id": "htl-1", "guest_name": "User" }
    }
  ]
}
```

**Runtime executes tool, adds result to messages, calls LLM again. LLM responds with final text. Runtime evaluates COMPLETE condition (`booking_confirmed == true`). Session completes.**

---

## Code References

| What                           | File                           | Line(s)   |
| ------------------------------ | ------------------------------ | --------- |
| `chatWithToolUse()` interface  | `session-llm-client.ts`        | 201-240   |
| Reasoning LLM call             | `reasoning-executor.ts`        | 251-256   |
| Reasoning tool-use loop        | `reasoning-executor.ts`        | 246-394   |
| Entity extraction LLM call     | `flow-step-executor.ts`        | 798-803   |
| Extraction system prompt       | `flow-step-executor.ts`        | 770-793   |
| Extraction response parsing    | `flow-step-executor.ts`        | 827-867   |
| Extraction validation          | `flow-step-executor.ts`        | 869-895   |
| Field validation LLM call      | `llm-field-validator.ts`       | 59-64     |
| `buildSystemPrompt()`          | `prompt-builder.ts`            | 533-631   |
| `buildTools()`                 | `prompt-builder.ts`            | 634-828   |
| Regular tool conversion        | `prompt-builder.ts`            | 668-713   |
| Per-target routing tools       | `prompt-builder.ts`            | 839-1049  |
| `__escalate__` schema          | `prompt-builder.ts`            | 731-763   |
| `__return_to_parent__` schema  | `prompt-builder.ts`            | 766-781   |
| `__complete__` removed         | `prompt-builder.ts`            | 725-726   |
| Parallel routing normalization | `reasoning-executor.ts`        | 1406-1470 |
| Legacy routing safety nets     | `reasoning-executor.ts`        | 2525-2563 |
| `__complete__` safety net      | `reasoning-executor.ts`        | 514-521   |
| Runtime completion check       | `routing-executor.ts`          | 1171-1206 |
| Tool_use to messages           | `reasoning-executor.ts`        | 309-312   |
| Tool_result to messages        | `reasoning-executor.ts`        | 374-378   |
| Final response to history      | `reasoning-executor.ts`        | 418-419   |
| Tool result to context         | `reasoning-executor.ts`        | 604       |
| `ToolExecutor` interface       | `compiler/constructs/types.ts` | 535-544   |
| `ToolDefinition` IR            | `compiler/ir/schema.ts`        | 297-330   |
