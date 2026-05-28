# ABL Engine — Design Implementation Plan

> **Purpose**: Design specification for ABL engine changes. Each change describes current behavior, updated behavior with examples, and implementation details.
> **Status**: In Progress (18/23 completed)
> **Author**: ABL Platform Team
> **Reference**: Detailed gap analysis in [`docs/memory-and-session-store.md`](./memory-and-session-store.md)

---

## Table of Contents

- [1. Change Summary](#1-change-summary)
- [2. CRITICAL Changes](#2-critical-changes)
  - [2.1. Fix RECALL Legacy ON_START Dead Code](#21-fix-recall-legacy-on_start-dead-code)
  - [2.2. Structured Entity Extraction via Tool Call](#22-structured-entity-extraction-via-tool-call)
  - [2.3. Post-Tool Variable Mapping & Constraint Enforcement in Reasoning Mode](#23-post-tool-variable-mapping--constraint-enforcement-in-reasoning-mode)
- [3. HIGH Changes](#3-high-changes)
  - [3.1. Externalize All Prompts — Template System & Prompt Catalog](#31-externalize-all-prompts--template-system--prompt-catalog)
  - [3.2. Structured System Tool Schemas — Context, Descriptions, Reason/Thought](#32-structured-system-tool-schemas--context-descriptions-reasonthought)
  - [3.3. Declarative Lifecycle Events — Replace Hardcoded Prefixes](#33-declarative-lifecycle-events--replace-hardcoded-prefixes)
  - [3.4. Durable Session Persistence (Hot/Cold Tiering)](#34-durable-session-persistence-hotcold-tiering)
  - [3.5. Parallel Fan-Out Execution](#35-parallel-fan-out-execution)
  - [3.6. Enable Thinking — Project-Level Default + Agent-Level Override](#36-enable-thinking--project-level-default--agent-level-override)
  - [3.7. Tool Thought Extraction + Chat UI Display](#37-tool-thought-extraction--chat-ui-display)
  - [3.8. Handoff/Delegate `message` Parameter](#38-handoffdelegate-message-parameter)
  - [3.9. LLM Call Options + Message Thread in Debug UI](#39-llm-call-options--message-thread-in-debug-ui)
  - [3.10. Per-Agent Routing Tools](#310-per-agent-routing-tools--replace-generic-__handoff____delegate____fan_out__)
- [4. MEDIUM Changes](#4-medium-changes)
  - [4.1. Compiler Validation for RECALL Event Names](#41-compiler-validation-for-recall-event-names)
  - [4.2. Tool Context Access (Read/Write Session Variables)](#42-tool-context-access-readwrite-session-variables)
  - [4.3. FactStore Batch Query Optimization](#43-factstore-batch-query-optimization)
  - [4.4. Dynamic IDENTITY Interpolation (GOAL, PERSONA, LIMITATIONS)](#44-dynamic-identity-interpolation-goal-persona-limitations)
  - [4.5. LLM-Based Preference Detection](#45-llm-based-preference-detection)
  - [4.6. LLM Context Setting (`__set_context__` System Tool)](#46-llm-context-setting-__set_context__-system-tool)
  - [4.7. Non-Blocking Warning Constraints (WARN)](#47-non-blocking-warning-constraints-warn)
  - [4.8. Composite Object Memory + Type Coercion](#48-composite-object-memory--type-coercion)
  - [4.9. Type-Aware Session Memory (TYPE/DESCRIPTION)](#49-type-aware-session-memory-typedescription)
  - [4.10. Settings Versioning & Deployment Pinning](#410-settings-versioning--deployment-pinning)
- [5. LOW Changes](#5-low-changes)
  - [5.1. Project-Scoped (Shared) Facts](#51-project-scoped-shared-facts)
  - [5.2. Session Memory Declaration Validation](#52-session-memory-declaration-validation)
  - [5.3. Externalize Arch Prompts — Studio Prompt Catalog](#53-externalize-arch-prompts--studio-prompt-catalog)
- [6. Implementation Order & Dependencies](#6-implementation-order--dependencies)

---

## 1. Change Summary

| #    | Change                                                                       | Priority | Category                   | Effort | Status        |
| ---- | ---------------------------------------------------------------------------- | -------- | -------------------------- | ------ | ------------- |
| 2.1  | Fix RECALL `ON_START` dead code                                              | CRITICAL | Bug Fix                    | Small  | **Completed** |
| 2.2  | Structured entity extraction via tool call                                   | CRITICAL | Reliability                | Medium | **Completed** |
| 2.3  | Post-tool variable mapping + constraint check                                | CRITICAL | Feature + Bug Fix          | Large  | **Completed** |
| 3.1  | Externalize all prompts — template system                                    | HIGH     | Maintainability            | Large  | **Completed** |
| 3.2  | Structured system tool schemas                                               | HIGH     | Reliability                | Medium | **Completed** |
| 3.3  | Declarative lifecycle events (replace hardcoded prefixes)                    | HIGH     | Feature + Cleanup          | Large  | **Completed** |
| 3.4  | Durable session persistence                                                  | HIGH     | Architecture               | Large  | **Completed** |
| 3.5  | Parallel fan-out with mixed agent + tool targets                             | HIGH     | Performance + Architecture | Large  | **Completed** |
| 4.1  | Compiler validation for RECALL events                                        | MEDIUM   | DX                         | Small  | **Completed** |
| 4.2  | Tool context access + imperative memory API                                  | MEDIUM   | Feature                    | Large  | **Completed** |
| 4.3  | FactStore batch queries                                                      | MEDIUM   | Performance                | Small  | **Completed** |
| 4.4  | Dynamic IDENTITY interpolation                                               | MEDIUM   | Feature                    | Small  | **Completed** |
| 4.5  | LLM-based preference detection                                               | MEDIUM   | Feature                    | Medium | Pending       |
| 4.6  | LLM context setting (`__set_context__` system tool)                          | MEDIUM   | Feature                    | Small  | **Completed** |
| 3.6  | Enable Thinking — project + agent resolution chain                           | HIGH     | Feature + Infrastructure   | Large  | **Completed** |
| 3.7  | Tool thought extraction + chat UI display                                    | HIGH     | Feature + UX               | Medium | **Completed** |
| 4.7  | Non-blocking warning constraints (WARN)                                      | MEDIUM   | Feature                    | Medium | **Completed** |
| 4.8  | Composite object memory + type coercion                                      | MEDIUM   | Feature + Bug Fix          | Small  | **Completed** |
| 4.9  | Type-aware session memory (TYPE/DESCRIPTION)                                 | MEDIUM   | DX + Reliability           | Small  | **Completed** |
| 4.10 | Settings versioning & deployment pinning                                     | MEDIUM   | Infrastructure             | Medium | **Completed** |
| 3.10 | Per-agent routing tools (replace `__handoff__`/`__delegate__`/`__fan_out__`) | CRITICAL | Accuracy + Architecture    | Medium | **Planned**   |
| 3.8  | Handoff/delegate `message` parameter                                         | HIGH     | Reliability + Feature      | Medium | **Completed** |
| 3.9  | LLM call options + message thread in debug UI                                | HIGH     | Observability + DX         | Medium | **Completed** |
| 5.1  | Project-scoped facts (merged into 4.2)                                       | LOW      | Feature                    | Medium | **Completed** |
| 5.2  | Session memory declaration validation                                        | LOW      | DX                         | Small  | **Completed** |
| 5.3  | Externalize Arch prompts — Studio prompt catalog                             | LOW      | Maintainability + DX       | Medium | **Completed** |

---

## 2. CRITICAL Changes

### 2.1. Fix RECALL Legacy ON_START Dead Code — **Completed**

**Files**: `agent-based-parser.ts`, `memory-executor.ts`, `memory-integration.ts`

#### Current Behavior

The legacy shorthand `- ON_START: "instruction"` inside RECALL is **silently non-functional**. Every example agent's RECALL rules fail at runtime.

**Two bugs**:

1. Parser creates `event: "ON_START"` but runtime emits `"session_start"` — string mismatch
2. Legacy format produces `action: undefined` — executor skips it as "legacy format"

**Example — what a DSL author writes**:

```yaml
MEMORY:
  recall:
    - ON_START: 'Check if user is returning customer and load their preferences'
```

**What happens at runtime**:

```
Parser output:   { event: "ON_START", instruction: "Check if...", action: undefined }
Runtime emits:   events = ["session_start"]
Matching check:  ["session_start"].includes("ON_START")  →  false  ← ALWAYS FAILS
Even if matched: action === undefined  →  skipped as "legacy format"

Result: RECALL rule silently ignored. No error. No warning. No trace event.
```

**Impact**: All 7 example agents (`traveldesk`, `banknexus`, `telco`) have broken RECALL rules. The memory system appears non-functional on first use.

#### Updated Behavior

Parser normalizes legacy shorthand to modern format during parsing. Both bugs fixed at the source.

**Same DSL input produces working output**:

```yaml
# Author writes (unchanged):
MEMORY:
  recall:
    - ON_START: 'Check if user is returning customer and load their preferences'
```

```
Parser output:   { event: "session_start", instruction: "Check if...",
                   action: { type: "prompt_llm", instruction: "Check if..." } }
Runtime emits:   events = ["session_start"]
Matching check:  ["session_start"].includes("session_start")  →  true  ✓
Action present:  action.type === "prompt_llm"  →  executes instruction  ✓

Result: LLM receives "Check if user is returning..." as a system instruction.
        FactStore is queried for user preferences. Context is enriched.
```

**Use cases this solves**:

| Scenario                     | Before                                                                         | After                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Returning customer detection | `ON_START: "Check if returning"` silently fails — LLM has no customer history  | LLM receives instruction, queries FactStore, personalizes greeting            |
| Preference loading           | `ON_START: "Load travel preferences"` ignored — agent starts cold              | Agent loads `user.preferred_destinations`, `user.hotel_chains` from FactStore |
| Alarm monitoring (telco)     | `ON_START: "Check active alarms"` dead — agent unaware of outages              | Agent loads current alarms, can proactively inform user                       |
| Authentication state         | `ON_START: "Check if previously verified"` ignored — re-verifies every session | Agent skips verification for recently authenticated users                     |

**Parser also emits deprecation warning**:

```
⚠ DEPRECATION: Legacy "ON_START:" shorthand at line 56.
  Migrate to:
    - ON: session_start
      ACTION: prompt_llm
      INSTRUCTION: "Check if user is returning customer..."
```

#### Fix Details

**Parser change** — `agent-based-parser.ts:2324-2342`:

```typescript
const EVENT_ALIASES: Record<string, string> = {
  ON_START: 'session_start',
  ON_END: 'session_end',
  ON_SEARCH: 'search_initiated',
  ON_BOOKING: 'booking_started',
  ON_CANCEL: 'cancellation_initiated',
  ON_PAYMENT: 'payment_initiated',
  ON_UPDATE: 'modification_initiated',
};

const onMatch = line.match(/^-\s*(ON_\w+):\s*"?(.+)"?$/);
if (onMatch) {
  const rawEvent = onMatch[1];
  const normalizedEvent = EVENT_ALIASES[rawEvent] || rawEvent.toLowerCase();
  const instruction = onMatch[2].replace(/^"|"$/g, '');

  // Emit deprecation diagnostic
  diagnostics.push({
    severity: 'warning',
    message: `Legacy "${rawEvent}:" shorthand. Migrate to: ON: ${normalizedEvent} / ACTION: prompt_llm`,
    location: { line: lineNumber, agent: agentName },
  });

  return {
    event: normalizedEvent,
    instruction,
    action: { type: 'prompt_llm', instruction },
  };
}
```

**No runtime changes needed** — parser output now matches what runtime expects.

| What                | File                             | Lines     | Change                                                 |
| ------------------- | -------------------------------- | --------- | ------------------------------------------------------ |
| Event normalization | `agent-based-parser.ts`          | 2324-2342 | Map `ON_START` → `session_start`, auto-generate action |
| Deprecation warning | `agent-based-parser.ts`          | 2324-2342 | Emit `ValidationDiagnostic` with migration hint        |
| Tests               | `parser-memory-enhanced.test.ts` | new       | Verify normalized event + action generation            |
| Integration test    | `memory-executor.test.ts`        | new       | End-to-end: parse → emit → match → execute             |

---

### 2.2. Structured Entity Extraction via Tool Call — **Completed**

**Files**: `flow-step-executor.ts`, `session-llm-client.ts`, `llm-field-validator.ts`

#### Current Behavior

Entity extraction calls the LLM with **empty tools** and asks it to return raw JSON text. This fails frequently because LLMs wrap JSON in prose or markdown.

**Example — gathering hotel booking fields**:

```yaml
GATHER:
  FIELDS:
    - destination:
        TYPE: string
        PROMPT: 'Where would you like to stay?'
        REQUIRED: true
        VALIDATE:
          TYPE: llm
          RULE: 'Must be a real city name, not a country or region'
    - num_guests:
        TYPE: number
        PROMPT: 'How many guests?'
        VALIDATE:
          TYPE: range
          RULE: '1-10'
    - room_type:
        TYPE: string
        PROMPT: 'Room category'
        VALIDATE:
          TYPE: enum
          RULE: 'single|double|suite'
```

**User says**: "I need a hotel in Paris for 3 people, a double room please"

**What happens today (4 LLM calls)**:

````
── LLM Call 1: Extraction ──────────────────────────────────────────
System: "Return ONLY a valid JSON object with extracted values..."
Tools:  []  ← empty, no structure

LLM returns (text, not tool call):
  "Here are the extracted values:\n```json\n{\"Destination\": \"Paris\", \"numGuests\": 3, \"roomType\": \"double\"}\n```"

Runtime must:
  1. Try JSON.parse() → fails (markdown wrapping)
  2. Regex fallback: extract from ```json...``` → parse inner JSON
  3. Case normalization: "Destination" → "destination", "numGuests" → "num_guests"
  4. Type coercion: roomType "double" (not in enum as-is)

── LLM Call 2: Validate "destination" ──────────────────────────────
System: "Validate: Is 'Paris' a real city name, not a country?"
LLM returns: '{"valid": true}'

── LLM Call 3: Validate "num_guests" ───────────────────────────────
(sync range check — no LLM call for this one)

── LLM Call 4: Validate "room_type" ────────────────────────────────
(sync enum check — no LLM call for this one, but if it was LLM-validated it would be)

Total: 2-4 LLM API calls per extraction cycle
~40 lines of defensive parsing code (regex, case mapping, JSON fallbacks)
````

**Failure modes seen in production**:

| LLM Returns                                | Problem                                             |
| ------------------------------------------ | --------------------------------------------------- |
| `"Here are the extracted values:\n{...}"`  | Prose wrapping — JSON.parse() fails                 |
| ` ```json\n{...}\n``` `                    | Markdown code block — needs regex extraction        |
| `{"Destination": "Paris", "numGuests": 3}` | Wrong casing — `destination` ≠ `Destination`        |
| `"I couldn't find any booking details"`    | Explanation instead of JSON — empty result          |
| `{"destination": "France"}`                | Country instead of city — needs LLM validation call |

#### Updated Behavior

Build a `_extract_entities` tool from GatherField definitions. The LLM uses structured `tool_use` to return data — guaranteed valid JSON, correct field names, embedded validation. **1 LLM call instead of 4.**

**Same user input**: "I need a hotel in Paris for 3 people, a double room please"

**What happens now (1 LLM call)**:

```
── LLM Call 1: Extraction via Tool Call ────────────────────────────
System: "Extract information from the user's message"
Tools:  [{
  name: "_extract_entities",
  input_schema: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description: "Where would you like to stay? RULE: Must be a real city name, not a country or region"
      },
      num_guests: {
        type: "number",
        description: "How many guests?",
        minimum: 1,
        maximum: 10
      },
      room_type: {
        type: "string",
        description: "Room category",
        enum: ["single", "double", "suite"]
      }
    }
  }
}]
toolChoice: "auto"  ← LLM decides whether to call

LLM returns (tool_use, not text):
  tool_use("_extract_entities", {
    destination: "Paris",      ← correct field name (schema-enforced)
    num_guests: 3,             ← correct type (number, schema-enforced)
    room_type: "double"        ← valid enum value (schema-enforced)
  })

Runtime:
  extracted = response.toolCalls[0].input  ← guaranteed valid JSON
  Post-extraction: only sync validation remains (regex for complex rules)

Total: 1 LLM API call
0 lines of defensive parsing code
```

**Use cases this solves**:

| Scenario                     | Before                                                                        | After                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| User says "hmm let me think" | LLM returns `"I'll wait for..."` — parsing fails, empty extraction with error | `toolChoice: 'auto'` → LLM returns text only, no tool call → `extracted = {}` (clean) |
| Multi-field extraction       | LLM returns `{"checkIn": "Mar 10"}` — case mismatch with `check_in`           | Schema defines exact field name `check_in` — LLM must use it                          |
| Numeric validation           | LLM returns `"15"` as string for `num_guests` — type mismatch                 | Schema enforces `type: "number", maximum: 10` — provider rejects 15                   |
| Enum validation              | LLM returns `"deluxe"` for `room_type` — not in enum                          | Schema enforces `enum: ["single", "double", "suite"]` — provider rejects              |
| City vs country              | LLM returns `"France"` for destination                                        | Description says "RULE: Must be a real city name, not a country" — LLM self-corrects  |
| Complex validation           | `email` with regex + `dates` with LLM rule                                    | Regex as `pattern` in schema, LLM rule in description — all in 1 call                 |

#### Fix Details

**1. Build extraction tool from GatherFields** — `flow-step-executor.ts` (replaces lines 770-867):

```typescript
function buildExtractionTool(gatherFields: GatherFieldIR[]): LLMToolDefinition {
  return {
    name: '_extract_entities',
    description:
      'Extract the following fields from the user message based on what they explicitly stated',
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        gatherFields.map((f) => {
          const schema = ablTypeToJsonSchema(f.type || 'string', f.prompt);
          // Embed validation in schema
          if (f.validation?.type === 'range') {
            const [min, max] = f.validation.rule.split('-').map(Number);
            schema.minimum = min;
            schema.maximum = max;
          }
          if (f.validation?.type === 'enum') {
            schema.enum = f.validation.rule.split('|');
          }
          if (f.validation?.type === 'pattern') {
            schema.pattern = f.validation.rule;
          }
          if (f.validation?.type === 'llm') {
            schema.description = `${schema.description || f.prompt}. RULE: ${f.validation.rule}`;
          }
          return [f.name, schema];
        }),
      ),
      required: [], // all optional — only extract what's present
    },
  };
}
```

**2. Add `toolChoice` passthrough** — `session-llm-client.ts:201`:

```typescript
async chatWithToolUse(
  systemPrompt: string,
  messages: ChatMessage[],
  tools: LLMToolDefinition[],
  operationType: string,
  options?: { toolChoice?: 'auto' | 'required' | { type: 'tool'; name: string } },
): Promise<LLMResponse>
```

**3. Use tool call result instead of JSON parsing** — `flow-step-executor.ts`:

```typescript
const extractionTool = buildExtractionTool(gatherFields);
const response = await session.llmClient!.chatWithToolUse(
  systemPrompt,
  messages,
  [extractionTool],
  'extraction',
  { toolChoice: 'auto' },
);

const extracted =
  response.toolCalls.length > 0
    ? response.toolCalls[0].input // ← structured, valid JSON
    : {}; // ← nothing to extract (clean)
```

| What                   | File                         | Lines   | Change                                                       |
| ---------------------- | ---------------------------- | ------- | ------------------------------------------------------------ |
| Build extraction tool  | `flow-step-executor.ts`      | 770-867 | Replace prompt + empty tools + JSON parsing with tool schema |
| toolChoice passthrough | `session-llm-client.ts`      | 201-240 | Add optional `options` parameter                             |
| Vercel AI adapter      | `vercel-ai-adapters.ts`      | 85-215  | Pass `toolChoice` to `generateText()`                        |
| LLM field validator    | `llm-field-validator.ts`     | 31-155  | Can be removed — rules folded into extraction tool           |
| Extraction prompt      | `constants.ts`               | 366-389 | Simplified — no "Return ONLY JSON" instruction needed        |
| Tests                  | `flow-step-executor.test.ts` | new     | Tool call extraction, no-call handling, validation           |

**Code removed**: ~40 lines of JSON parsing + regex fallback + case/underscore normalization.

#### Reasoning Mode: Rebuild System Prompt After Extraction

In reasoning mode, extraction runs inside `reasoning-executor.ts:execute()` (lines 161-247) but the `systemPrompt` is passed in from the caller (`runtime-executor.ts:1331`) **before** extraction happens. After extraction updates `session.data.values` with new entity values, the system prompt's `## Current Context` section is stale — the LLM enters the tool loop without seeing the just-extracted values in its context.

**Fix**: After extraction completes (and after the post-extraction constraint check), rebuild the system prompt so the tool loop receives updated context:

```typescript
// reasoning-executor.ts — after extraction + constraint check, before tool loop

// Rebuild system prompt with updated context after extraction
if (justExtractedFields.length > 0) {
  systemPrompt = buildSystemPrompt(session);
}
```

This requires changing the `systemPrompt` parameter from `const` to `let` in `execute()`, or accepting a session reference and rebuilding internally. The rebuild is cheap (string concatenation) and only happens when extraction actually produced values.

**Note**: No extraction tool is needed for reasoning mode. If extracted values need to persist across sessions, the existing REMEMBER mechanism handles that. The key gap is just ensuring the LLM **sees** the extracted values in its system prompt context during the current session's tool loop.

| What                            | File                    | Lines                         | Change                                                              |
| ------------------------------- | ----------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Rebuild prompt after extraction | `reasoning-executor.ts` | ~262 (after constraint check) | `systemPrompt = buildSystemPrompt(session)` when entities extracted |

---

### 2.3. Post-Tool Variable Mapping & Constraint Enforcement in Reasoning Mode — **Completed**

**Files**: `reasoning-executor.ts`, `memory-integration.ts`, `compiler/ir/schema.ts`, `agent-based-parser.ts`

#### Current Behavior

In reasoning mode, after a tool call completes, the runtime stores the **entire raw result** as `session.data.values['last_<tool>_result']` and nothing else. There is no mechanism to extract specific fields, no constraint checking, and REMEMBER/RECALL run as fire-and-forget (race condition).

**Example — booking agent with budget constraint**:

```yaml
AGENT: Booking_Agent
MODE: reasoning

CONSTRAINTS:
  - NAME: budget_check
    WHEN: 'selected_price > budget'
    ACTION: respond
    MESSAGE: 'That exceeds your budget of {{budget}}. Let me find alternatives.'

TOOLS:
  - search_hotels:
      TYPE: http
      URL: 'https://api.example.com/search'
      PARAMS:
        destination: { TYPE: string }
        max_price: { TYPE: number }
```

**User says**: "Search for hotels in Paris" (budget is 500)

**What happens today**:

```
LLM calls: search_hotels({ destination: "Paris" })
Tool returns: {
  count: 5,
  hotels: [
    { name: "Le Grand", price: 1200, ... },   ← exceeds $500 budget!
    { name: "Hotel Lumiere", price: 120, ... },
    ...
  ]
}

Runtime stores:
  session.data.values["last_search_hotels_result"] = { count: 5, hotels: [...] }
  // ← entire raw blob dumped into context

  evaluateRememberAfterStateChange().catch(() => {})   ← fire-and-forget, may not complete
  executeRecallAfterToolCall().catch(() => {})          ← fire-and-forget, may not complete

  // NO constraint check happens here
  // "selected_price > budget" never evaluated
  // because "selected_price" variable doesn't exist — only the raw blob

Next LLM iteration starts immediately (REMEMBER/RECALL may still be running)
```

**Three problems**:

| Problem                 | Impact                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No variable mapping** | Can't extract `hotel_count`, `cheapest_price` into flat variables. Constraints like `selected_price > budget` can't evaluate because `selected_price` doesn't exist.                                           |
| **Context bloat**       | Raw tool result (potentially large JSON) dumped into `## Current Context` every turn. Grows linearly with each tool call. LLM already sees the result in conversation history — storing it again is redundant. |
| **Race condition**      | REMEMBER/RECALL run async with `.catch(() => {})`. RECALL injects data via `Object.assign(session.data.values, ...)` which may race with the next LLM iteration reading context.                               |

#### Updated Behavior

Tools can declare `ON_RESULT SET` mappings to extract specific fields into named variables. REMEMBER/RECALL are awaited (not fire-and-forget). Constraints are checked after every tool call.

**Updated DSL**:

```yaml
AGENT: Booking_Agent
MODE: reasoning

CONSTRAINTS:
  - NAME: budget_check
    WHEN: 'selected_price > budget'
    ACTION: respond
    MESSAGE: 'That exceeds your budget of {{budget}}. Let me find alternatives.'

TOOLS:
  - search_hotels:
      TYPE: http
      URL: 'https://api.example.com/search'
      STORE_RESULT: false # don't dump raw blob into context
      ON_RESULT:
        SET:
          hotel_count: 'result.count'
          cheapest_price: 'result.hotels.0.price'
          cheapest_hotel: 'result.hotels.0.name'
          search_status: 'completed'
      ON_ERROR:
        SET:
          search_status: 'failed'

  - book_hotel:
      TYPE: http
      URL: 'https://api.example.com/book'
      STORE_RESULT: false
      ON_RESULT:
        SET:
          booking_id: 'result.booking_id'
          selected_price: 'result.total_price' # ← constraint can now check this
          booking_status: 'confirmed'
      ON_ERROR:
        SET:
          booking_status: 'failed'
          booking_error: 'result.error'
```

**Same user input**: "Search for hotels in Paris" (budget is 500)

**What happens now**:

```
LLM calls: search_hotels({ destination: "Paris" })
Tool returns: { count: 5, hotels: [{ name: "Le Grand", price: 1200, ... }, ...] }

Runtime:
  ① STORE_RESULT: false → raw blob NOT stored in session.data.values
     (LLM still sees full result in conversation history as tool_result message)

  ② ON_RESULT SET applied:
     session.data.values["hotel_count"] = 5
     session.data.values["cheapest_price"] = 1200
     session.data.values["cheapest_hotel"] = "Le Grand"
     session.data.values["search_status"] = "completed"

  ③ await REMEMBER → persistent write completes before next iteration
  ④ await RECALL → FactStore read completes before next iteration

  ⑤ Constraint check: evaluateConstraints(session.data.values)
     → "selected_price > budget"? selected_price not set yet → passes (no violation)

  ⑥ Next LLM iteration with clean context:
     ## Current Context
     { hotel_count: 5, cheapest_price: 1200, cheapest_hotel: "Le Grand",
       search_status: "completed", budget: 500, ... }
     // No raw blob! Just the mapped variables.

...later, user says "Book Le Grand"...

LLM calls: book_hotel({ hotel_id: "htl-1", room_type: "standard" })
Tool returns: { booking_id: "BK-789", total_price: 1200, success: true }

Runtime:
  ② ON_RESULT SET:
     session.data.values["selected_price"] = 1200
     session.data.values["booking_id"] = "BK-789"
     session.data.values["booking_status"] = "confirmed"

  ⑤ Constraint check:
     → "selected_price > budget"? 1200 > 500? → YES — VIOLATION!
     → Response: "That exceeds your budget of $500. Let me find alternatives."
     → Booking prevented by constraint. ✓
```

**Use cases this solves**:

| Scenario                        | Before                                                                          | After                                                               |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Budget constraints              | Can't evaluate `price > budget` — no flat `price` variable                      | `ON_RESULT SET: selected_price: "result.total"` → constraint works  |
| Cross-tool data flow            | Tool B needs field from Tool A — LLM must carry mentally                        | `hotel_id` extracted as variable, available to all subsequent tools |
| Context size control            | Every `last_<tool>_result` blob accumulates in system prompt                    | `STORE_RESULT: false` + only mapped variables in context            |
| REMEMBER trigger on tool result | `WHEN: hotel_count IS SET` can't fire — only `last_search_hotels_result` exists | `hotel_count` is a flat variable → REMEMBER triggers correctly      |
| Constraint after booking        | `selected_price > budget` never checked after `book_hotel` returns              | Constraint runs after every tool call → violation caught            |
| Race condition                  | RECALL may inject data after next LLM iteration starts                          | `await` ensures RECALL completes before constraint check            |

#### Fix Details

**1. IR extension** — `compiler/ir/schema.ts`:

```typescript
export interface ToolDefinition {
  // ... existing fields ...

  /** Control raw result storage (default: true if no on_result, false if on_result exists) */
  store_result?: boolean;

  /** Post-tool-success variable mapping */
  on_result?: {
    set: Record<string, string>; // varName → "result.path" or "hardcoded_value"
  };

  /** Post-tool-error variable mapping */
  on_error?: {
    set: Record<string, string>;
  };
}
```

**2. Parser** — `agent-based-parser.ts` (TOOLS section parsing):

Parse `STORE_RESULT`, `ON_RESULT { SET }`, `ON_ERROR { SET }` within each tool definition.

**3. Executor** — `reasoning-executor.ts` (after line 604):

```typescript
// Post-tool-call sequence (deterministic, blocking)
const toolDef = ir?.tools?.find((t) => t.name === toolCall.name);
const isError = typeof toolResult === 'object' && toolResult !== null && 'error' in toolResult;

// Step 1: Conditionally store raw result
const storeResult = toolDef?.store_result ?? (toolDef?.on_result ? false : true);
if (storeResult) {
  session.data.values[`last_${toolCall.name}_result`] = toolResult;
}

// Step 2: Apply ON_RESULT or ON_ERROR SET mappings
const mapping = isError ? toolDef?.on_error?.set : toolDef?.on_result?.set;
if (mapping) {
  for (const [varName, valueExpr] of Object.entries(mapping)) {
    if (valueExpr.startsWith('result.')) {
      session.data.values[varName] = resolveNestedPath(toolResult, valueExpr.slice(7));
    } else {
      session.data.values[varName] = interpolateTemplate(valueExpr, session.data.values);
    }
  }
}

// Step 3: Await REMEMBER (was fire-and-forget)
await evaluateRememberAfterStateChange(session, onTraceEvent);

// Step 4: Await RECALL (was fire-and-forget)
await executeRecallAfterToolCall(session, toolCall.name, onTraceEvent);

// Step 5: Constraint check (NEW — did not exist in tool loop)
const violation = checkConstraints(session, onTraceEvent);
if (violation) {
  return handleConstraintViolation(session, violation, onChunk, onTraceEvent);
}
```

**4. Path resolver utility** (new, shared):

```typescript
function resolveNestedPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

| What             | File                         | Lines                | Change                                                        |
| ---------------- | ---------------------------- | -------------------- | ------------------------------------------------------------- |
| IR extension     | `compiler/ir/schema.ts`      | 297-346              | Add `store_result`, `on_result`, `on_error` to ToolDefinition |
| Parser           | `agent-based-parser.ts`      | TOOLS section        | Parse ON_RESULT/ON_ERROR/STORE_RESULT                         |
| Compiler         | `compiler/ir/compiler.ts`    | tool compilation     | Compile new fields to IR                                      |
| Executor         | `reasoning-executor.ts`      | 604-610              | Replace fire-and-forget with deterministic sequence           |
| Path resolver    | `utils/path-resolver.ts`     | new                  | `resolveNestedPath()` utility                                 |
| Constraint check | `reasoning-executor.ts`      | after tool loop body | Call `checkConstraints()` after memory ops                    |
| Tests            | `reasoning-executor.test.ts` | new                  | ON_RESULT mapping, constraint post-tool, await memory         |

---

## 3. HIGH Changes

### 3.1. Externalize All Prompts — Template System & Prompt Catalog — **Completed**

**Files**: `prompt-builder.ts`, `constants.ts`, `flow-step-executor.ts`, `llm-field-validator.ts`, `routing-executor.ts`

#### Current Behavior

All 99 prompts are hardcoded in TypeScript. The system prompt is built by ~30 `parts.push()` calls across 150 lines of conditional code.

**Example — a customer wants to change the gathering style**:

```typescript
// constants.ts:244-245 — hardcoded, requires code change + deploy
"Continue asking for any missing required fields. The system will automatically
detect when all information has been gathered."
```

Customer wants: "Ask for all required information at once in a single question."
To change this today: modify `constants.ts` → rebuild → redeploy → affects ALL customers.

**Example — supervisor prompt is fragmented**:

```typescript
// prompt-builder.ts:107-256 — 30 parts.push() calls
const parts: string[] = [];
parts.push(`You are ${name}...`);
if (ir.identity?.goal) parts.push(`\nYour goal: ${ir.identity.goal}`);
if (isSupervisor) {
  parts.push(`\n## CRITICAL: You are a ROUTING-ONLY supervisor`);
  parts.push(`You MUST use the ${SYSTEM_TOOL_HANDOFF}...`);
  // ... 15 more pushes with branching
}
return parts.join('\n');
```

You can't see the full prompt without mentally executing 150 lines of TypeScript. Non-engineers can't review or tune prompts. No A/B testing possible.

#### Updated Behavior

Three-tier prompt resolution: **Project override → Seed data → Hardcoded fallback**. Single template per agent type. Editable in Studio UI.

**Example — customer overrides gathering style per project**:

```
Studio UI → Settings → Prompts → "gather_continuation"
  Project default: "Continue asking for any missing required fields..."
  Override:        "Ask for ALL required information in a single question.
                    List the fields as bullet points."
```

At runtime:

```
resolvePromptTemplate('gather_continuation', session)
  → Project override found → returns custom text
  → No override → returns seed data default
  → No seed data → returns constants.ts fallback
```

**Example — single template for supervisor**:

```handlebars
{{! Template: system_prompt.supervisor }}
You are
{{name}}, an AI assistant.
{{#if goal}}
  Your goal:
  {{goal}}
{{/if}}
{{#if persona}}
  Persona:
  {{persona}}
{{/if}}

## CRITICAL: You are a ROUTING-ONLY supervisor
{{supervisor_mandate}}

## Routing Rules (use
{{handoff_tool}}
tool with target parameter):
{{#each routing_rules}}- **{{to}}**:
  {{description}}
{{/each}}

## MANDATORY: Always use
{{handoff_tool}}
tool
{{mandatory_body}}

{{#if escalation}}
  ## Escalation
  {{escalation_instructions}}
{{/if}}

{{#if context}}
  ## Current Context
  {{context_json}}
{{/if}}
```

**What you see is what the LLM gets.** Prompt engineers can read, review, and edit directly.

**Use cases this solves**:

| Scenario                       | Before                                   | After                                                 |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| Customer wants formal tone     | Modify `constants.ts`, rebuild, redeploy | Override `greeting`, `escalation_format` in Studio UI |
| Extraction prompt tuning       | Edit `constants.ts:366-389`, rebuild     | Override `extraction` template per project            |
| Voice channel customization    | Edit `constants.ts:296-299`, rebuild     | Override `voice_format_rules` per project             |
| A/B test prompts               | Impossible — code changes only           | Swap template in DB, no deploy                        |
| Multi-language prompts         | Single English template                  | Per-locale templates via resolution chain             |
| Prompt review by non-engineers | Must read TypeScript                     | Read template text with `{{placeholders}}`            |

#### Fix Details

**99 prompts classified**:

| Category                     | Count | Owner                                   |
| ---------------------------- | ----- | --------------------------------------- |
| System prompt sections       | 40    | ~25 Seed Data, ~15 Externalize          |
| System tool descriptions     | 16    | All Seed Data                           |
| Entity extraction            | 1     | Externalize                             |
| Correction detection         | 1     | Externalize                             |
| LLM field validation         | 1     | Seed Data (obsolete if 2.2 implemented) |
| Default user-facing messages | 35    | ~30 Externalize, ~5 Seed Data           |
| Escalation formats           | 3     | All Externalize                         |
| Fan-out synthesis            | 2     | All Externalize                         |

**Implementation**:

| What                                | Detail                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `prompt_templates` collection/table | `{ key, template, category, locale, projectId? }`                                  |
| Seed data                           | Platform defaults seeded on deployment, admin-overridable                          |
| Project overrides                   | Per-project, editable in Studio UI (Settings → Prompts)                            |
| Resolution chain                    | `projectPrompts[key]` → `seedPrompts[key]` → `CONSTANTS[key]`                      |
| Template engine                     | Lightweight `renderTemplate()` (~50 lines) — `{{var}}`, `{{#if}}`, `{{#each}}`     |
| Three base templates                | `system_prompt.supervisor`, `system_prompt.specialist`, `system_prompt.standalone` |
| `buildSystemPrompt()` rewrite       | Load template → build context object → render                                      |

---

### 3.2. Structured System Tool Schemas — Context, Descriptions, Reason/Thought — **Completed**

> **Design doc**: [`docs/plans/2026-03-01-lifecycle-events-tool-schemas-design.md`](./plans/2026-03-01-lifecycle-events-tool-schemas-design.md)

**Files**: `prompt-builder.ts`, `reasoning-executor.ts`, `routing-executor.ts`, `constants.ts`, `compiler/ir/schema.ts`, `agent-based-parser.ts`, `compiler/ir/compiler.ts`

#### Current Behavior

System tools have three problems:

**Problem 1 — `__handoff__` context is free-form string**:

```json
"context": { "type": "string", "description": "JSON context to pass (optional)" }
```

LLM guesses at context. Runtime overrides with PASS fields anyway. Wasted tokens.

**Problem 2 — Target enum has no descriptions**:

```json
"target": { "type": "string", "enum": ["billing_agent", "support_agent"] }
```

LLM picks agents based on name alone. No description of what each agent handles.

**Problem 3 — No `reason` field (except `__escalate__`)**:
LLM calls tools without explaining why. No chain-of-thought at schema level. No traceability.

#### Updated Behavior

**Key design decisions** (from brainstorming):

| Topic                   | Decision                                                                                    | Rationale                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`                | Required on all 6 system tools                                                              | Traceability — every system action has an audit trail. `__escalate__` already has it.                                                                                              |
| `thought`               | Optional, gated by `enable_thinking` in ExecutionConfig                                     | `enable_thinking` already exists in IR. Description externalized later with 3.1.                                                                                                   |
| Handoff context schema  | Description-based with per-agent field listings (not typed properties)                      | One `__handoff__` tool serves multiple targets with different PASS fields. Typed union is confusing. Rich description with per-agent fields + types + descriptions guides the LLM. |
| PASS field descriptions | Hybrid: flat names resolve from `MEMORY.session` declarations; inline objects for overrides | DRY — descriptions come from session memory. Inline override when session memory doesn't have the field or needs a handoff-specific description.                                   |

##### `reason` — Required on All System Tools

Add `reason` as required string to all 6 system tools: `__handoff__`, `__delegate__`, `__escalate__`, `__fan_out__`, `__complete__`, `__set_context__`. `__escalate__` already has it.

Both `reason` and `thought` are stripped from tool input before execution. They're emitted as trace event fields for observability.

##### `thought` — Optional, Agent-Level Opt-In

Gated by `enable_thinking` in `ExecutionConfig` (already exists in IR schema). NOT added to `required` — always optional.

##### PASS Field Descriptions — Hybrid DSL Syntax

PASS fields support two forms: flat name (resolves description from session memory) or inline object with TYPE/DESCRIPTION.

```yaml
MEMORY:
  session:
    - NAME: customer_id
      TYPE: string
      DESCRIPTION: 'Unique customer identifier'
    - NAME: plan_type
      TYPE: string
      DESCRIPTION: 'Current subscription plan (basic, premium, enterprise)'

COORDINATION:
  HANDOFFS:
    - TO: Billing_Agent
      PASS:
        - customer_id # resolved from MEMORY.session
        - plan_type # resolved from MEMORY.session
        - outstanding_balance: # inline override
            TYPE: number
            DESCRIPTION: 'Amount owed by the customer in USD'

    - TO: Support_Agent
      PASS:
        - booking_id:
            TYPE: string
            DESCRIPTION: 'Booking reference number'
        - customer_tier:
            TYPE: string
            DESCRIPTION: 'Support tier (standard, premium, vip)'
```

**Resolution chain at compile time:**

1. If PASS field has inline TYPE/DESCRIPTION → use those
2. Else look up the name in `MEMORY.session` declarations → use those
3. Else fallback → `type: string`, no description

**IR representation:**

```typescript
interface ResolvedPassField {
  name: string;
  type: string; // resolved: inline → session memory → 'string'
  description?: string; // resolved: inline → session memory → undefined
}

interface HandoffConfig {
  to: string;
  context?: {
    pass: ResolvedPassField[]; // was string[], now resolved with types/descriptions
  };
}
```

##### Handoff Context Schema — Description-Based Per-Agent Guidance

Since each agent has different PASS fields, the context stays `type: object` with a dynamically built description listing per-agent fields:

**What the LLM sees:**

```json
"context": {
  "type": "object",
  "description": "Context for the target agent. Populate relevant fields from conversation. Missing fields auto-filled from session.\n\nFields by target:\nBilling_Agent:\n  - customer_id (string) — Unique customer identifier\n  - plan_type (string) — Current subscription plan\n  - outstanding_balance (number) — Amount owed by the customer in USD\nSupport_Agent:\n  - booking_id (string) — Booking reference number\n  - customer_tier (string) — Support tier (standard, premium, vip)"
}
```

##### Agent Descriptions in `target` Enum

```json
"target": {
  "type": "string",
  "description": "The specialist to route to:\n- \"billing_agent\": Handles billing inquiries, payment issues\n- \"support_agent\": Handles technical support, troubleshooting",
  "enum": ["billing_agent", "support_agent"]
}
```

**Use cases this solves**:

| Scenario                  | Before                                                                   | After                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Handoff with rich context | LLM sends free-form `"customer needs billing help"` — runtime ignores it | LLM populates typed fields from history + context. Runtime uses LLM values, falls back to session state. |
| Agent selection accuracy  | LLM guesses from name `"billing_agent"`                                  | LLM reads description: "Handles billing inquiries, payment issues"                                       |
| Debugging tool calls      | No reason recorded — "why did LLM call search_hotels?"                   | `reason: "User asked about availability in Paris"` in every trace event                                  |
| Test ground debugging     | No visibility into LLM reasoning                                         | `thought` toggle shows full reasoning chain                                                              |

#### Fix Details

| What                         | File                                           | Change                                                                         |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `reason` injection           | `prompt-builder.ts` (buildTools)               | Add `reason` as required to all 6 system tools                                 |
| `thought` injection          | `prompt-builder.ts` (buildTools)               | Add `thought` when `ir.execution?.enable_thinking`                             |
| Context description          | `prompt-builder.ts`                            | Build description with per-agent PASS field listings (name, type, description) |
| Agent descriptions in target | `prompt-builder.ts`                            | Embed routing rule description / agent goal in target enum description         |
| Strip before execution       | `reasoning-executor.ts`, `routing-executor.ts` | `const { reason, thought, ...cleanInput } = toolCall.input` + trace event      |
| Constants                    | `constants.ts`                                 | Add `reason` and `thought` to `SYSTEM_TOOL_DESCRIPTIONS`                       |
| IR type extension            | `compiler/ir/schema.ts`                        | `ResolvedPassField` with `name`, `type`, `description?`                        |
| Hybrid PASS parsing          | `agent-based-parser.ts`                        | Parse flat names + inline objects with TYPE/DESCRIPTION                        |
| PASS field resolution        | `compiler/ir/compiler.ts`                      | Resolve descriptions from session memory declarations at compile time          |

---

### 3.3. Declarative Lifecycle Events — Replace Hardcoded Prefixes — **Completed**

> **Design doc**: [`docs/plans/2026-03-01-lifecycle-events-tool-schemas-design.md`](./plans/2026-03-01-lifecycle-events-tool-schemas-design.md)

**Files**: `event-detector.ts`, `memory-executor.ts`, `memory-integration.ts`, `routing-executor.ts`, `reasoning-executor.ts`, `flow-step-executor.ts`

#### Current Behavior

Three distinct problems create a broken, opaque event system:

**Problem 1 — Hardcoded tool name prefix conventions** (`event-detector.ts:22-42`):

```typescript
// The ENTIRE vocabulary of tool→event mapping — 5 prefix rules, zero DSL control
export function detectToolEvents(toolName: string): string[] {
  if (toolName.startsWith('search_'))  → ['search_initiated']
  if (toolName.startsWith('book_'))    → ['booking_started']
  if (toolName.startsWith('pay_'))     → ['payment_initiated']
  if (toolName.startsWith('cancel_'))  → ['cancellation_initiated']
  if (toolName.startsWith('update_'))  → ['modification_initiated']
}
```

A tool named `find_flights` → no event. `buscar_vuelos` (Spanish) → nothing. **5 English prefixes is the entire event vocabulary.** DSL authors have zero control.

**Problem 2 — Agent lifecycle events never fire** (ghost definitions):

`agent_enter`, `agent_exit`, `delegate_complete` appear in documentation but are **never emitted**. The routing executor creates/completes threads without calling the RECALL system. These events are silently ignored.

**Problem 3 — Fire-and-forget memory calls**: 9 `.catch()` sites in executors mean RECALL/REMEMBER may not complete before the next LLM iteration.

#### Updated Behavior — Simplified Event Taxonomy

**Key design decisions** (from brainstorming):

| Topic                    | Original Design                                               | Decision                                                                | Rationale                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent events             | 4 events (before_enter, after_enter, before_exit, after_exit) | 2 named events (`agent:<name>:before`, `agent:<name>:after`) + wildcard | before_enter vs after_enter fire in same sync block — no meaningful distinction for RECALL. Named events enable per-specialist context loading.                       |
| Delegate events          | Separate `delegate:before` / `delegate:after`                 | Dropped — unified into agent events                                     | Handoff, delegate, and fan-out all invoke a child agent. RECALL doesn't need to distinguish invocation mechanism. Event payload carries `invocationType` for tracing. |
| Tool BEFORE events       | `tool:<name>:before`                                          | Dropped                                                                 | Tool params already set by LLM. Weak use case until Tool Context Access (4.2) exists.                                                                                 |
| Custom EVENTS field      | `events?: string[]` on ToolDefinition                         | Dropped                                                                 | `tool:<name>:after` in RECALL gives per-tool targeting directly without indirection.                                                                                  |
| Tool after success/error | `tool:<name>:after:success` / `tool:<name>:after:error`       | Dropped                                                                 | ON_RESULT SET / ON_ERROR SET (2.3, completed) already handle success/error distinction.                                                                               |
| Events scope             | Potentially RECALL and REMEMBER                               | RECALL only                                                             | REMEMBER is condition-driven (`WHEN: X IS SET`), fires on state change — unaffected by events.                                                                        |

##### Event Taxonomy

```
SESSION (2)                AGENT (named + wildcard)         TOOL (named + wildcard)
───────────                ─────────────────────            ───────────────────────
session:start              agent:<name>:before              tool:<name>:after
session:end                agent:<name>:after               tool:*:after
                           agent:*:before
                           agent:*:after
```

**4 built-in lifecycle patterns + named references by agent/tool name.** Pure runtime refactor — no IR changes, no parser changes.

##### DSL Syntax for RECALL

```yaml
MEMORY:
  recall:
    # Load billing-specific context before Billing_Agent
    - ON: agent:Billing_Agent:before
      ACTION: inject_context
      PATHS: [user.billing_history, user.payment_methods]

    # Load travel docs before Visa_Agent
    - ON: agent:Visa_Agent:before
      ACTION: inject_context
      PATHS: [user.nationality, user.passport_expiry]

    # Common context before any agent
    - ON: agent:*:before
      ACTION: inject_context
      PATHS: [user.name, user.language, user.tier]

    # After Booking_Agent finishes — persist outcomes
    - ON: agent:Booking_Agent:after
      ACTION: prompt_llm
      INSTRUCTION: 'Persist booking confirmation details'

    # After specific tool — load related memory
    - ON: tool:search_hotels:after
      ACTION: load_memory
      DOMAIN: hotel_preferences

    # After any tool — evaluate memory triggers
    - ON: tool:*:after
      ACTION: prompt_llm
      INSTRUCTION: 'Check if new information should be remembered'
```

##### Backward Compatibility

```typescript
const LEGACY_EVENT_ALIASES: Record<string, string> = {
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};
```

##### How Events Relate to RECALL and REMEMBER

Events are **RECALL-only**. REMEMBER is unaffected.

- **RECALL** is event-driven. The `ON:` field subscribes to events. When the event fires, the RECALL action executes.
- **REMEMBER** is condition-driven. The `WHEN:` field evaluates conditions against `session.data.values`. It fires via `evaluateRememberAfterStateChange()` after any state mutation. Events do not trigger REMEMBER.

**Use cases this solves**:

| Scenario                                 | Before (hardcoded)          | After (declarative)                                            |
| ---------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| Non-standard tool names                  | `find_flights` → no event   | `tool:find_flights:after` → works                              |
| Multi-language tools                     | `buscar_vuelos` → nothing   | `tool:buscar_vuelos:after` → works                             |
| Load per-specialist context on handoff   | Only loads at session start | `agent:Billing_Agent:before` → inject billing-specific context |
| Common context for all agent transitions | Not possible                | `agent:*:before` → inject shared user context                  |
| Persist results when agent completes     | `agent_exit` never fires    | `agent:Booking_Agent:after` → persist results                  |
| React to any tool completion             | Not possible                | `tool:*:after` → matches all tool completions                  |
| Wildcard agent events                    | Not possible                | `agent:*:after` → matches all agent completions                |

#### Fix Details

| What                            | File                       | Change                                                             |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| **Delete** `detectToolEvents()` | `event-detector.ts`        | Remove hardcoded prefix detection                                  |
| **Delete** `detectEvents()`     | `event-detector.ts`        | Remove aggregator, replace with specific resolvers                 |
| New `resolveToolAfterEvents()`  | `event-detector.ts`        | Returns `[tool:<name>:after, tool:*:after]`                        |
| New `resolveAgentEvents()`      | `event-detector.ts`        | Returns `[agent:<name>:<phase>, agent:*:<phase>]`                  |
| Export `LIFECYCLE_PATTERNS`     | `event-detector.ts`        | Regex patterns for compiler validation (4.1)                       |
| Export `LEGACY_EVENT_ALIASES`   | `event-detector.ts`        | Legacy → new event name mapping                                    |
| Wildcard matching               | `memory-executor.ts`       | `eventMatches()` with `*` support + legacy alias normalization     |
| Tool AFTER events               | `reasoning-executor.ts`    | Emit `tool:<name>:after` after tool calls                          |
| Tool AFTER events in flow       | `flow-step-executor.ts`    | Emit `tool:<name>:after` after CALL steps                          |
| Agent lifecycle events          | `routing-executor.ts`      | Emit `agent:<name>:before/after` around handoff, delegate, fan-out |
| Memory integration              | `memory-integration.ts`    | Use `resolveToolAfterEvents()`, `session:start`                    |
| **Convert** 9 `.catch()` sites  | reasoning + flow executors | Replace fire-and-forget with `await` + `try/catch`                 |
| Tests                           | `event-detector.test.ts`   | New resolver functions, wildcard matching                          |
| Tests                           | `memory-executor.test.ts`  | Event matching with wildcards, legacy aliases                      |
| Tests                           | `routing-executor.test.ts` | Agent lifecycle event emission                                     |

---

### 3.4. Durable Session Persistence (Hot/Cold Tiering) — **Completed**

**Architecture Doc**: [`docs/plans/3.4-durable-session-persistence.md`](./plans/3.4-durable-session-persistence.md)

**Files**: `session-state.model.ts` (new), `session-state-repo.ts` (new), `tiered-session-store.ts` (new), `compaction-engine.ts` (new), `session-operations.ts` (new), `session-service.ts`, `types.ts`, `config/index.ts`, `reasoning-executor.ts`, `runtime-executor.ts`, `websocket/handler.ts`, `types/index.ts`

#### Summary

Replaced Redis-only sessions (30-min TTL, data lost on idle) with a tiered hot/cold architecture. Redis remains the hot path (zero added latency), MongoDB `session_states` collection provides durable cold storage (configurable TTL, default 7 days). Write-through on every save (fire-and-forget), cold restore on Redis miss.

Also adds: automatic context compaction (LLM summarization when thread approaches context limit), session forking at thread boundaries (for debugging / alternative flows), and all necessary config env vars.

#### Key Decisions

| Decision                    | Choice                     | Rationale                                                             |
| --------------------------- | -------------------------- | --------------------------------------------------------------------- |
| Rewind                      | Skipped                    | Multi-agent handoff chains make arbitrary message rewind complex      |
| Compaction                  | Fully automatic per-thread | Runtime detects context limit; no user/admin trigger needed           |
| Fork                        | At thread boundaries       | Simpler than mid-conversation fork; thread model already supports it  |
| Async resume                | Deferred                   | Existing HTTP async channel + BullMQ can be extended later            |
| Message log (`message_log`) | Deferred                   | Current `messages` collection + `session_states` is sufficient for v1 |

#### Post-Implementation Fixes (2026-03-06)

**Multi-Level Compaction Threshold**: `compaction_threshold` is now configurable per agent/project/platform (same resolution chain as `enableThinking`): Agent IR → Agent DB hyperParameters → ProjectSettings → `SESSION_AUTO_COMPACT_THRESHOLD` env var → 0.8 default. DSL: `EXECUTION: compaction_threshold: 0.5`. Studio UI: slider in Agent Model tab (injected via model-capabilities API with dynamic description showing model context window).

**Model-Aware Context Window** (previously deferred): `getContextWindowSize()` now uses `getModelRegistryEntry()` (prefix-matching) and reads `session.resolvedModelId` (DB-resolved model from Agent DB / Tenant Model), not just the DSL-declared model. Fixes incorrect 128K fallback for DB-configured models.

**Cold Storage Encryption Fix**: `SessionStateRepo.upsert()` was using `updateOne()` which bypasses Mongoose `pre('save')` hooks — the encryption plugin never fired. Fixed to use `findOne()` + `.save()` so `stateData`, `irData`, `compilationData` are properly encrypted via AES-256-GCM before persistence.

**Cold Restore Decrypt Fix**: `decompressJson()` now handles both `Buffer` (unencrypted legacy) and `string` (decrypted by encryption plugin's `post('findOne')` hook — the plugin returns `JSON.stringify(Buffer)` after decryption). Removed `.lean()` from the load query so the encryption plugin's post-find hook fires.

**Dead Code Removal**: Deleted `packages/compiler/src/platform/checkpointing/` (4 files) — unused abstract checkpointer module. Relocated `TenantAccessError` to `base-runtime.ts` where it's actually used.

#### Fix Details

| What                 | File                                                        | Change                                                                                             |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Session state model  | `packages/database/src/models/session-state.model.ts`       | NEW — MongoDB `session_states` collection with per-thread compressed state, encryption, TTL        |
| Repository           | `apps/runtime/src/services/session/session-state-repo.ts`   | NEW — upsert, load (tenant-scoped), delete, touch, getVersion (projection), resolveByArtifact      |
| Tiered store         | `apps/runtime/src/services/session/tiered-session-store.ts` | NEW — wraps any SessionStore with MongoDB cold fallback                                            |
| Compaction engine    | `apps/runtime/src/services/session/compaction-engine.ts`    | NEW — auto-compact per-thread with LLM summary + extractive fallback                               |
| Fork operations      | `apps/runtime/src/services/session/session-operations.ts`   | NEW — forkSession() with deep clone at thread boundary                                             |
| Session config       | `apps/runtime/src/services/session/types.ts`                | MODIFY — coldStorageEnabled, coldTtlDays, compactionEnabled, autoCompactThreshold, compactionModel |
| Runtime config       | `apps/runtime/src/config/index.ts`                          | MODIFY — Zod schema + env var mappings for new session config fields                               |
| Service factory      | `apps/runtime/src/services/session/session-service.ts`      | MODIFY — wires TieredSessionStore when coldStorageEnabled                                          |
| Reasoning hook       | `apps/runtime/src/services/execution/reasoning-executor.ts` | MODIFY — calls autoCompact() before LLM loop                                                       |
| Runtime wiring       | `apps/runtime/src/services/runtime-executor.ts`             | MODIFY — creates CompactionEngine, passes to ReasoningExecutor                                     |
| WS fork handler      | `apps/runtime/src/websocket/handler.ts`                     | MODIFY — fork_session message type with tenant auth                                                |
| WS types             | `apps/runtime/src/types/index.ts`                           | MODIFY — fork_session / session_forked message types                                               |
| Compaction threshold | Multiple (13 files across core/compiler/database/runtime)   | Multi-level resolution: DSL → Agent DB → ProjectSettings → env var                                 |
| Model-aware context  | `compaction-engine.ts`                                      | `getModelRegistryEntry()` + `session.resolvedModelId` instead of `MODEL_REGISTRY[modelId]`         |
| Encryption fix       | `session-state-repo.ts`                                     | `findOne()` + `.save()` instead of `updateOne()` — Mongoose encryption hooks now fire              |
| Decrypt fix          | `session-state-repo.ts`                                     | `decompressJson()` handles decrypted string form; removed `.lean()` from load query                |
| UI integration       | `model-capabilities.ts` route                               | Injects `compactionThreshold` slider + `contextWindow` into model capabilities response            |

---

#### 3.4.1 Compaction Strategies

The platform provides configurable compaction strategies via `CompactionPolicy`, resolving at three levels: platform defaults → project config (DB) → agent IR (compile-time).

**Strategies:**

| Strategy     | Tool Results                     | Prior Turns                     |
| ------------ | -------------------------------- | ------------------------------- |
| `none`       | Pass through raw                 | Keep full history               |
| `truncate`   | Character-cap only               | Replace with placeholder        |
| `structured` | Strip non-essential fields + cap | Placeholder + assistant preview |
| `summarize`  | LLM summary (async)              | LLM summary (async)             |

**Configuration:**

- **Project level:** `ProjectRuntimeConfig.compaction` — project-wide defaults
- **Agent level:** `AgentIR.execution.compaction` — per-agent overrides
- **Tool level:** `ToolDefinition.compaction.essential_fields` — per-tool field allowlists

**Files:** `compaction-policy.ts` (resolution), `tool-result-compressor.ts` (structured compression), `reasoning-executor.ts` (wiring)

---

### 3.5. Parallel Fan-Out Execution with Mixed Agent + Tool Targets — **Completed**

**Files**: `routing-executor.ts`, `reasoning-executor.ts`, `prompt-builder.ts`, `types.ts`

#### Current Behavior

**Two problems** — sequential execution AND agent-only targets.

**Problem 1 — Sequential execution**: Fan-out runs child tasks in a `for` loop. Each child agent completes its full reasoning loop before the next one starts.

**Problem 2 — Agent-only targets**: The `__fan_out__` tool only accepts agents in its `target` enum (`prompt-builder.ts:595`). To call a tool, the supervisor must first handoff to a child agent, which then calls the tool — a full LLM round-trip just to invoke one HTTP call.

**Example — user says**: "Search flights to Paris, check my loyalty points, and get the weather forecast"

```
Today's schema (prompt-builder.ts:592-595):
  target: {
    type: 'string',
    enum: handoffTargets,           // ← ONLY agent names: ["flights_agent", "loyalty_agent", ...]
  }

To call search_flights directly? Not possible.
Supervisor MUST:
  1. Fan-out to flights_agent        → flights_agent calls search_flights     (LLM + tool = ~5s)
  2. Fan-out to loyalty_agent        → loyalty_agent calls get_loyalty_points  (LLM + tool = ~5s)
  3. Fan-out to weather_agent        → weather_agent calls get_weather         (LLM + tool = ~5s)

Each child agent: create thread → wire LLM → run reasoning loop → call tool → return
Overhead per tool: ~3s of LLM reasoning that just decides to call the one tool it has
```

**What happens today** (`routing-executor.ts:955-1058`):

```
for (let i = 0; i < executableTasks.length; i++) {       // SEQUENTIAL loop
  const task = executableTasks[i];

  // ① Create child thread
  childThread = createThread(session, task.target, targetInfo.ir, { ... });

  // ② MUTATE shared session to point to child
  session.activeThreadIndex = childIndex;                  // ← shared state
  session.agentName = task.target;                         // ← shared state
  session.agentIR = targetInfo.ir;                         // ← shared state
  session.conversationHistory = childThread.conversationHistory;  // ← shared state
  session.state = childThread.state;                       // ← shared state
  session.data = childThread.data;                         // ← shared state

  // ③ Wire LLM client
  await this.llmWiring.wireLLMClient(session, ...);

  // ④ Execute child — full agent loop with timeout
  const result = await Promise.race([
    this.ctx.executeMessage(session.id, task.intent),      // ← reads from shared session
    timeout(timeoutMs),
  ]);

  // ⑤ Restore parent
  session.activeThreadIndex = savedActiveIndex;
  syncThreadToSession(session);
}

Timeline (sequential, agent-only):
  flights_agent:  [==LLM=+==tool== 5s ==]
  loyalty_agent:                          [==LLM=+==tool== 5s ==]
  weather_agent:                                                   [==LLM=+==tool== 5s ==]
  Total:          [===================== 15s =====================]
  User waits:     15 seconds
```

**Root cause for sequential** — session mutation makes parallel execution unsafe:

The `for` loop exists because `executeMessage(sessionId)` looks up the session from the store and reads `session.agentName`, `session.agentIR`, `session.conversationHistory`, etc. Two concurrent children would race on these shared fields:

```
Thread A writes: session.agentName = "billing_agent"
Thread B writes: session.agentName = "support_agent"    ← overwrites A
Thread A reads:  session.agentName → "support_agent"    ← WRONG AGENT
```

**Root cause for agent-only** — `prompt-builder.ts:595` hardcodes `enum: handoffTargets`. Tools declared in the supervisor's own IR are offered as regular tools (one-at-a-time), not as fan-out targets. No `type` discriminator exists in the task schema.

**Impact**:

| Tasks                         | Sequential agent-only | Parallel with tools                   | Wasted time  |
| ----------------------------- | --------------------- | ------------------------------------- | ------------ |
| 3 tool calls via child agents | 15s (3 × 5s LLM+tool) | ~2s (3 parallel tool calls, no LLM)   | 13s (87%)    |
| 2 agents + 1 tool             | 15s (3 × 5s each)     | ~5s (agents parallel + tool parallel) | 10s (67%)    |
| 5 mixed tasks                 | 25-40s                | ~5-8s                                 | 20-32s (80%) |

With `FAN_OUT_MAX_TASKS` of 5 and typical LLM latency of 3-8 seconds per child agent, sequential agent-only fan-out can take **25-40 seconds**. Parallel with direct tool calls would be **2-8 seconds**.

#### Updated Behavior

Two changes: (A) mixed agent + tool targets with a `type` discriminator, and (B) parallel execution via isolated contexts.

##### A. Mixed Agent + Tool Targets

The `__fan_out__` tool schema gains a `type` field. Tasks can target agents (full reasoning loop) or tools (direct execution, no child LLM). The `target` enum merges agent names and tool names.

**Full ABL Example** — supervisor with both agent routing and direct tools:

```yaml
# ============================================================
# Travel Supervisor — can fan-out to both agents AND tools
# ============================================================

AGENT: Travel_Supervisor
VERSION: 1.0
MODE: supervisor

IDENTITY:
  PERSONA: 'A helpful travel planning coordinator'
  GOAL: 'Route user requests to the right specialist or call tools directly when appropriate'

# ──────────────────────────────────────────────────────────────
# TOOLS — declared on the supervisor itself
# These become fan-out targets with type: "tool"
# The supervisor can call these directly (no child agent needed)
# ──────────────────────────────────────────────────────────────
TOOLS:
  - search_flights:
      TYPE: http
      URL: 'https://api.example.com/flights/search'
      DESCRIPTION: 'Search for available flights'
      PARAMS:
        origin: { TYPE: string, DESCRIPTION: 'Departure city' }
        destination: { TYPE: string, DESCRIPTION: 'Arrival city' }
        date: { TYPE: string, DESCRIPTION: 'Travel date (YYYY-MM-DD)' }

  - search_hotels:
      TYPE: http
      URL: 'https://api.example.com/hotels/search'
      DESCRIPTION: 'Search for available hotels'
      PARAMS:
        city: { TYPE: string }
        checkin: { TYPE: string }
        checkout: { TYPE: string }
        guests: { TYPE: number }

  - get_weather:
      TYPE: http
      URL: 'https://api.weather.com/forecast'
      DESCRIPTION: 'Get weather forecast for a city'
      PARAMS:
        city: { TYPE: string }
        days: { TYPE: number, DESCRIPTION: 'Forecast days (1-14)' }

  - check_loyalty_points:
      TYPE: http
      URL: 'https://api.example.com/loyalty/balance'
      DESCRIPTION: "Check user's loyalty points balance"

  - get_exchange_rate:
      TYPE: http
      URL: 'https://api.forex.com/rate'
      DESCRIPTION: 'Get currency exchange rate'
      PARAMS:
        from: { TYPE: string }
        to: { TYPE: string }

# ──────────────────────────────────────────────────────────────
# ROUTING — these become fan-out targets with type: "agent"
# Agents handle multi-turn conversations and complex workflows
# ──────────────────────────────────────────────────────────────
ROUTING:
  RULES:
    - TO: Booking_Agent
      DESCRIPTION: 'Handles flight and hotel bookings, payment, and confirmation'
      WHEN: 'User wants to book flights or hotels'

    - TO: Support_Agent
      DESCRIPTION: 'Handles cancellations, changes, refunds, and complaints'
      WHEN: 'User needs help with existing bookings'

    - TO: Visa_Agent
      DESCRIPTION: 'Handles visa requirements, document preparation, and travel advisories'
      WHEN: 'User asks about visa or travel documents'

# ──────────────────────────────────────────────────────────────
# COORDINATION — handoff config for agent targets
# ──────────────────────────────────────────────────────────────
COORDINATION:
  HANDOFFS:
    - TO: Booking_Agent
      RETURN: true
      PASS: [destination, travel_dates, num_guests, loyalty_tier]
    - TO: Support_Agent
      RETURN: true
      PASS: [booking_id, customer_tier]
    - TO: Visa_Agent
      RETURN: true
      PASS: [destination, nationality]
```

**Design principle**: The supervisor's own `TOOLS` become tool-type fan-out targets. The `ROUTING` rules become agent-type fan-out targets. Both appear in the same `target` enum. The LLM decides the type based on whether the request needs a conversation (agent) or a data lookup (tool).

**What the LLM sees** — the `__fan_out__` tool offered to the supervisor at runtime:

```
target enum: ["Booking_Agent", "Support_Agent", "Visa_Agent",     ← agents (from ROUTING)
              "search_flights", "search_hotels", "get_weather",   ← tools (from TOOLS)
              "check_loyalty_points", "get_exchange_rate"]         ← tools (from TOOLS)
```

**Scenario 1 — All tools** (pure data lookups, no agents needed):

User says: "I'm planning a trip to Tokyo next month. Search flights from NYC, check hotels, get the weather, and check my loyalty points"

```json
{
  "name": "__fan_out__",
  "input": {
    "tasks": [
      {
        "type": "tool",
        "target": "search_flights",
        "params": { "origin": "NYC", "destination": "Tokyo", "date": "2026-04-01" }
      },
      {
        "type": "tool",
        "target": "search_hotels",
        "params": {
          "city": "Tokyo",
          "checkin": "2026-04-01",
          "checkout": "2026-04-07",
          "guests": 1
        }
      },
      { "type": "tool", "target": "get_weather", "params": { "city": "Tokyo", "days": 7 } },
      { "type": "tool", "target": "check_loyalty_points" }
    ]
  }
}
```

4 parallel HTTP calls, no child agents, no LLM round-trips. **~1-2 seconds total.** Supervisor LLM synthesizes results into one response.

**Scenario 2 — Mixed tools + agents** (data lookup + conversational workflow):

User says: "Search flights to Tokyo AND help me cancel my Paris booking"

```json
{
  "tasks": [
    {
      "type": "tool",
      "target": "search_flights",
      "params": { "origin": "NYC", "destination": "Tokyo" }
    },
    { "type": "agent", "target": "Support_Agent", "intent": "Help me cancel my Paris booking" }
  ]
}
```

1 direct tool call (~1s) + 1 agent with full reasoning loop (~5s) = **~5s total** (parallel).

**Scenario 3 — All agents** (complex multi-turn workflows):

User says: "I need to book a flight to Tokyo and also check visa requirements for Japan"

```json
{
  "tasks": [
    { "type": "agent", "target": "Booking_Agent", "intent": "Book a flight to Tokyo" },
    { "type": "agent", "target": "Visa_Agent", "intent": "Check visa requirements for Japan" }
  ]
}
```

Both are agent tasks with full conversational loops (booking has GATHER, visa has multi-step reasoning). Both run in parallel with isolated contexts. **~5-8s total.**

**When to use tool vs agent**:

| Target type     | Use when                                                                        | Runtime cost                         |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| `type: "tool"`  | Data lookup, API query, stateless operation — no conversation needed            | Direct HTTP call (~0.5-2s), no LLM   |
| `type: "agent"` | Multi-turn workflow, GATHER flow, complex reasoning, needs its own conversation | Full agent loop (LLM + tools, ~3-8s) |

**Updated `__fan_out__` schema** (`prompt-builder.ts`):

```json
{
  "name": "__fan_out__",
  "input_schema": {
    "type": "object",
    "properties": {
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "enum": ["agent", "tool"],
              "description": "Whether this task targets a specialist agent or a direct tool call"
            },
            "target": {
              "type": "string",
              "description": "Agent or tool name. Agents: Booking_Agent, Support_Agent. Tools: search_flights, get_weather, check_loyalty",
              "enum": [
                "Booking_Agent",
                "Support_Agent",
                "search_flights",
                "get_weather",
                "check_loyalty"
              ]
            },
            "intent": {
              "type": "string",
              "description": "For agents: the user's sub-request. For tools: ignored (use params instead)."
            },
            "params": {
              "type": "object",
              "description": "For tool tasks: the tool input parameters. Ignored for agent tasks."
            },
            "context": {
              "type": "object",
              "description": "Optional context (for agents: handoff context, for tools: ignored)"
            }
          },
          "required": ["type", "target"]
        }
      }
    },
    "required": ["tasks"]
  }
}
```

**Example — user says**: "Search flights to Paris, check my loyalty points, and get the weather"

```
LLM calls: __fan_out__({
  tasks: [
    { type: "tool",  target: "search_flights", params: { destination: "Paris", date: "2026-03-15" } },
    { type: "tool",  target: "check_loyalty" },
    { type: "tool",  target: "get_weather",    params: { city: "Paris" } }
  ]
})
```

**What happens now — tool tasks go direct, agent tasks get child threads**:

```
┌─ Dispatch (parallel) ────────────────────────────────────────────────┐
│                                                                       │
│  search_flights (tool):  toolExecutor.execute("search_flights", {...}) │
│                          → Direct HTTP call, no LLM, no child thread  │
│                          → ~0.5-2s                                    │
│                                                                       │
│  check_loyalty (tool):   toolExecutor.execute("check_loyalty", {})    │
│                          → Direct HTTP call                           │
│                          → ~0.5-1s                                    │
│                                                                       │
│  get_weather (tool):     toolExecutor.execute("get_weather", {...})   │
│                          → Direct HTTP call                           │
│                          → ~0.5-1s                                    │
└───────────────────────────────────────────────────────────────────────┘

Timeline (parallel tool calls):
  search_flights:  [== 1s ==]
  check_loyalty:   [= 0.5s =]
  get_weather:     [= 0.8s =]
  Total:           [== 1s ==]     ← bounded by slowest tool
  User waits:      ~1 second

vs. today (sequential, through child agents):
  flights_agent:  [==LLM 3s=+==tool 1s== 4s ==]
  loyalty_agent:                                  [==LLM 3s=+==tool 0.5s== 3.5s ==]
  weather_agent:                                                                     [==LLM 3s=+==tool 0.8s== 3.8s ==]
  Total:          [========================= 11.3s =========================]
  User waits:     ~11 seconds
```

**Mixed agent + tool example**: "Search flights to Paris AND help me with my booking dispute"

```
LLM calls: __fan_out__({
  tasks: [
    { type: "tool",  target: "search_flights", params: { destination: "Paris" } },
    { type: "agent", target: "Support_Agent",  intent: "Help me with my booking dispute" }
  ]
})

Timeline (parallel mixed):
  search_flights (tool):    [= 1s =]                          ← direct HTTP call
  Support_Agent (agent):    [===== LLM reasoning 5s =====]    ← full agent loop
  Total:                    [===== 5s =====]
  User waits:               ~5 seconds (vs 6s sequential)
```

##### B. Parallel Execution via Isolated Contexts

Agent tasks get **isolated execution contexts** — lightweight session snapshots scoped to their own thread. Tool tasks execute directly via the session's `ToolExecutor`. No shared session mutation during execution. Results are collected with `Promise.allSettled` and merged back after all tasks complete.

**Execution dispatch** — type-based routing:

```typescript
const taskPromises = executableTasks.map(async (task) => {
  if (task.type === 'tool') {
    // ── Direct tool execution (no thread, no LLM) ──
    const toolDef = ir?.tools?.find(t => t.name === task.target);
    if (!toolDef) throw new Error(`Tool not found: ${task.target}`);
    if (!session.toolExecutor) throw new Error('No tool executor available');

    const result = await Promise.race([
      session.toolExecutor.execute(task.target, task.params || {}, timeoutMs),
      timeout(timeoutMs, `Tool ${task.target} timed out`),
    ]);

    return {
      target: task.target,
      type: 'tool' as const,
      status: 'completed' as const,
      response: typeof result === 'string' ? result : JSON.stringify(result),
      rawResult: result,
    };

  } else {
    // ── Agent execution (isolated context, full reasoning loop) ──
    const targetInfo = this.ctx.agentRegistry[task.target];
    const childThread = childThreads[agentIndex];
    const childCtx = createChildExecutionContext(session, childThread, targetInfo.ir);
    await this.llmWiring.wireLLMClient(childCtx, targetInfo.ir, ...);

    const result = await Promise.race([
      this.ctx.executeMessageWithContext(childCtx, task.intent!, onTraceEvent),
      timeout(timeoutMs, `Fan-out to ${task.target} timed out`),
    ]);

    return {
      target: task.target,
      type: 'agent' as const,
      status: 'completed' as const,
      response: result.response,
      gatheredData: extractGatheredData(childThread),
    };
  }
});

// All tasks (agents + tools) run concurrently
const settled = await Promise.allSettled(taskPromises);
```

**What's isolated vs. shared**:

| Field                             | Agent tasks (isolated)   | Tool tasks           | Shared (read-only)                   |
| --------------------------------- | ------------------------ | -------------------- | ------------------------------------ |
| `agentName`                       | Own copy per child       | N/A                  | —                                    |
| `agentIR`                         | Own copy per child       | N/A                  | —                                    |
| `conversationHistory`             | Own ref (child thread's) | N/A                  | —                                    |
| `data` / `values`                 | Own ref (child thread's) | N/A                  | —                                    |
| `llmClient`                       | Own instance per child   | Not needed           | —                                    |
| `toolExecutor`                    | —                        | Shared (thread-safe) | Used by tool tasks                   |
| `sessionId`                       | —                        | —                    | Read-only, same for all              |
| `tenantId`, `userId`, `projectId` | —                        | —                    | Read-only, same for all              |
| `factStore`                       | —                        | —                    | Thread-safe (MongoDB ops are atomic) |

**Use cases this solves**:

| Scenario                           | Before (sequential, agent-only)             | After (parallel, mixed)                           |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| 3 tool calls via child agents      | ~15s (3 × LLM+tool)                         | ~1-2s (3 parallel direct tool calls)              |
| 2 agents + 1 tool call             | ~15s (3 × 5s sequential)                    | ~5s (parallel, bounded by slowest agent)          |
| "Search + check loyalty + weather" | 3 child agents, 3 LLM round-trips, ~11s     | 3 direct tool calls, 0 LLM round-trips, ~1s       |
| Complex 5-task mixed               | ~25-40s                                     | ~5-8s (bounded by slowest agent task)             |
| One child times out                | Blocks remaining children from starting     | Other children complete; timeout is isolated      |
| Tool returns data for agent        | Tool result available only after agent loop | Tool result available in synthesis prompt for LLM |

**Error handling with `Promise.allSettled`**:

```
Tasks: [search_flights (tool), Support_Agent (agent), get_weather (tool)]

Outcomes:
  search_flights → fulfilled (1s) → { type: "tool", response: "{flights: [...]}" }
  Support_Agent  → rejected (timeout after 30s) → { status: "error", error: "timed out" }
  get_weather    → fulfilled (0.5s) → { type: "tool", response: "{forecast: ...}" }

Result: 2/3 succeeded. LLM synthesizes from completed + explains agent failure.
Total time: ~30s (bounded by slowest — the timed-out agent)
Sequential agent-only would be: 1 + 30 + 0.5 = 31.5s (with agent overhead: ~38s)
```

#### Fix Details

**1. Updated `__fan_out__` schema** — `prompt-builder.ts:577-614`:

```typescript
// Build merged target enum: agent names + tool names
const agentTargets = handoffTargets;
const toolTargets = (ir?.tools || []).filter((t) => !SYSTEM_TOOLS.has(t.name)).map((t) => t.name);
const allTargets = [...agentTargets, ...toolTargets];

// Build target description with type hints
const targetDescription = [
  agentTargets.length > 0 ? `Agents (type: "agent"): ${agentTargets.join(', ')}` : null,
  toolTargets.length > 0 ? `Tools (type: "tool"): ${toolTargets.join(', ')}` : null,
]
  .filter(Boolean)
  .join('. ');

tools.push({
  name: SYSTEM_TOOL_FAN_OUT,
  description: interpolateTemplate(TD.fan_out.runtime, { targets: allTargets.join(', ') }),
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['agent', 'tool'],
              description: 'Whether this task targets a specialist agent or a direct tool call',
            },
            target: {
              type: 'string',
              description: targetDescription,
              enum: allTargets,
            },
            intent: { type: 'string', description: TD.fan_out.intent },
            params: { type: 'object', description: 'Tool input parameters (for tool tasks only)' },
            context: { type: 'object', description: TD.fan_out.context },
          },
          required: ['type', 'target'],
        },
      },
    },
    required: ['tasks'],
  },
});
```

**2. Updated `SubTaskResult` type** — `types.ts`:

```typescript
export interface SubTaskResult {
  target: string;
  type: 'agent' | 'tool'; // NEW — discriminator
  status: 'completed' | 'error';
  response?: string;
  error?: string;
  gatheredData?: Record<string, unknown>; // agent tasks only
  rawResult?: unknown; // tool tasks only — structured result
}
```

**3. Validation in `handleFanOut()`** — `routing-executor.ts`:

```typescript
// Validate each task's type + target combination
for (const task of tasks) {
  if (task.type === 'agent') {
    if (!this.ctx.agentRegistry[task.target]?.ir) {
      results.push({
        target: task.target,
        type: 'agent',
        status: 'error',
        error: `Agent not found: ${task.target}`,
      });
      continue;
    }
    if (!task.intent) {
      results.push({
        target: task.target,
        type: 'agent',
        status: 'error',
        error: `Agent task requires "intent" field`,
      });
      continue;
    }
  } else if (task.type === 'tool') {
    const toolDef = ir?.tools?.find((t) => t.name === task.target);
    if (!toolDef) {
      results.push({
        target: task.target,
        type: 'tool',
        status: 'error',
        error: `Tool not found: ${task.target}`,
      });
      continue;
    }
  }
  executableTasks.push(task);
}
```

**4. Isolated execution context** — new type and factory:

```typescript
/**
 * Lightweight execution context scoped to a single child thread.
 * Contains everything an executor needs without mutating the shared session.
 */
interface ChildExecutionContext {
  // Identity (read-only, shared)
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly projectId: string;

  // Agent-specific (isolated per child)
  agentName: string;
  agentIR: AgentIR;
  llmClient: SessionLLMClient | null;

  // Thread-specific (own references)
  conversationHistory: ChatMessage[];
  data: ThreadData;
  state: string;
  currentFlowStep: string | null;

  // Shared services (thread-safe)
  factStore: FactStore | null;
  toolExecutor: ToolExecutor | null;
}

function createChildExecutionContext(
  session: RuntimeSession,
  childThread: Thread,
  agentIR: AgentIR,
): ChildExecutionContext {
  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    userId: session.userId,
    projectId: session.projectId,
    agentName: childThread.agentName,
    agentIR,
    llmClient: null, // wired separately
    conversationHistory: childThread.conversationHistory,
    data: childThread.data,
    state: childThread.state,
    currentFlowStep: childThread.currentFlowStep,
    factStore: session.factStore,
    toolExecutor: session.toolExecutor,
  };
}
```

**5. New `executeMessageWithContext()`** — `reasoning-executor.ts`:

The current `executeMessage(sessionId, text)` looks up the session from the store and reads shared fields. A new variant accepts a `ChildExecutionContext` directly:

```typescript
async executeMessageWithContext(
  ctx: ChildExecutionContext,
  text: string,
  onTraceEvent?: TraceCallback,
): Promise<{ response: string }> {
  // Same logic as executeMessage(), but reads from ctx instead of session
  // ctx.agentIR, ctx.conversationHistory, ctx.data, ctx.llmClient, etc.
}
```

This is the core refactor. The existing `executeMessage` can delegate to this internally:

```typescript
async executeMessage(sessionId: string, text: string, ...): Promise<{ response: string }> {
  const session = await this.sessionStore.get(sessionId);
  const ctx = sessionToExecutionContext(session);  // wrap session as context
  return this.executeMessageWithContext(ctx, text, ...);
}
```

**6. Parallel `handleFanOut()`** — `routing-executor.ts:955-1058`:

Replace the sequential `for` loop with `Promise.allSettled`:

```typescript
// Pre-allocate all child threads (sequential — mutates session.threads[])
const childThreads = executableTasks.map((task) => {
  const targetInfo = this.ctx.agentRegistry[task.target];
  return createThread(session, task.target, targetInfo.ir, {
    handoffFrom: currentThread.agentName,
    initialData: {
      ...task.context,
      _fan_out_intent: task.intent,
      _fan_out_child: true,
      delegate_from: currentThread.agentName,
    },
  });
});

// Build isolated contexts + wire LLM clients (can be parallel)
const childContexts = await Promise.all(
  executableTasks.map(async (task, i) => {
    const targetInfo = this.ctx.agentRegistry[task.target];
    const ctx = createChildExecutionContext(session, childThreads[i], targetInfo.ir);
    await this.llmWiring.wireLLMClient(ctx, targetInfo.ir,
      session.tenantId, session.projectId, session.userId);
    return ctx;
  }),
);

// Execute ALL children concurrently
const settled = await Promise.allSettled(
  executableTasks.map((task, i) =>
    Promise.race([
      this.ctx.executeMessageWithContext(childContexts[i], task.intent, onTraceEvent),
      timeout(timeoutMs, `Fan-out to ${task.target} timed out`),
    ]),
  ),
);

// Collect results (sequential — safe, children are done)
session.activeThreadIndex = savedActiveIndex;
for (const [i, outcome] of settled.entries()) { ... }
syncThreadToSession(session);
```

**7. Thread pre-allocation safety**:

`createThread()` pushes to `session.threads[]`. This must happen **before** the parallel phase (sequential). Once threads are pre-allocated, each child references its own thread by index — no concurrent mutation of the `threads` array during execution.

**8. Trace event ordering**:

Parallel children emit trace events concurrently. Each event already carries `agentName` and `target`, so they're distinguishable. The `fan_out_task_start` / `fan_out_task_complete` events get an additional `parallelIndex` field for debugging:

```typescript
onTraceEvent?.({
  type: 'fan_out_task_start',
  data: {
    index: i,
    parallelIndex: i, // NEW — indicates parallel dispatch order
    target: task.target,
    intent: task.intent,
    agentName: currentThread.agentName,
  },
});
```

**9. Concurrency limit** (optional, future):

For deployments with LLM rate limits, add an optional concurrency cap:

```typescript
// Default: all tasks parallel. With limit: semaphore-controlled.
const concurrencyLimit = this.ctx.config.fanOutConcurrency || executableTasks.length;
```

This is not required for the initial implementation — `FAN_OUT_MAX_TASKS` (typically 5) is already a natural cap.

| What                            | File                         | Lines     | Change                                                                |
| ------------------------------- | ---------------------------- | --------- | --------------------------------------------------------------------- |
| Mixed target schema             | `prompt-builder.ts`          | 577-614   | Add `type` discriminator, merge agent + tool names in `enum`          |
| `SubTaskResult` type            | `types.ts`                   | 170-176   | Add `type: 'agent' \| 'tool'`, `rawResult?`                           |
| Task validation                 | `routing-executor.ts`        | 921-938   | Validate type+target combination, require `intent` for agents         |
| Tool dispatch path              | `routing-executor.ts`        | new       | `toolExecutor.execute()` for `type: 'tool'` tasks                     |
| `ChildExecutionContext` type    | `types.ts`                   | new       | Isolated execution context interface                                  |
| `createChildExecutionContext()` | `routing-executor.ts`        | new       | Factory: session + thread → isolated context                          |
| `executeMessageWithContext()`   | `reasoning-executor.ts`      | new       | Context-based execution (no session lookup)                           |
| Refactor `executeMessage()`     | `reasoning-executor.ts`      | ~100-130  | Delegate to `executeMessageWithContext()`                             |
| Parallel `handleFanOut()`       | `routing-executor.ts`        | 955-1058  | Replace `for` loop with `Promise.allSettled`, type-based routing      |
| Thread pre-allocation           | `routing-executor.ts`        | 955-970   | Create agent threads before parallel phase (tools don't need threads) |
| LLM client wiring               | `routing-executor.ts`        | 991-1002  | `Promise.all` for parallel agent wiring (tools skip)                  |
| Trace events                    | `routing-executor.ts`        | 959-1057  | Add `parallelIndex`, `taskType` fields                                |
| `formatFanOutToolResult()`      | `routing-executor.ts`        | 1540-1570 | Include `type` in formatted result for LLM context                    |
| `deduplicateFanOutTasks()`      | `routing-executor.ts`        | 1516-1534 | Dedup by `(type, target)` pair, not just `target`                     |
| Tool description in fan-out     | `constants.ts`               | 344-354   | Update description to mention direct tool calls                       |
| Tests                           | `routing-executor.test.ts`   | new       | Mixed fan-out, tool-only, agent-only, partial failure                 |
| Tests                           | `reasoning-executor.test.ts` | extend    | `executeMessageWithContext()` correctness                             |

---

### 3.6. Enable Thinking — Project-Level Default + Agent-Level Override — **Completed**

**Files**: `model-resolution.ts`, `session-llm-client.ts`, `llm-resolution-repo.ts`, `llm-wiring.ts`, `prompt-builder.ts`, `reasoning-executor.ts`, `types.ts`, `agent-based-parser.ts`, `compiler.ts`, `schema.ts`, `project-settings.model.ts`, `project-settings-version.model.ts`, `deployment.model.ts`

#### Current Behavior

The `enable_thinking` flag only exists in the Agent IR (`execution.enable_thinking`). There is no project-level default, no database-backed override, and no deployment pinning. If an agent's ABL does not declare `enable_thinking: true`, thinking is off — project administrators cannot flip a global switch.

**Two problems**:

1. **No centralized control**: To enable thinking across 10 agents, you must edit 10 ABL files.
2. **No deployment safety**: Changing thinking settings in the project affects all environments immediately — no way to test in staging first.

```
Resolution today (prompt-builder.ts):
  enableThinking = ir?.execution?.enable_thinking;  // ← single source, no override chain

Impact:
  - Project admin can't set a default without modifying every agent
  - Agent developers can't test thinking in isolation
  - No way to pin thinking settings to a specific deployment version
```

#### Updated Behavior

Four-level resolution chain with deployment pinning:

```
Level 0: Agent ABL (highest priority)
  EXECUTION:
    enable_thinking: true
    thinking_budget: 10000

Level 1: Agent DB (Studio "Identity" panel)
  AgentModelConfig.hyperParameters: { enableThinking: true, thinkingBudget: 10000 }

Level 2: Project DB — Versioned Settings
  ProjectSettings (working copy): { enableThinking: true, thinkingBudget: 8000 }
  ProjectSettingsVersion (immutable snapshot): { status: 'active', settings: { ... } }

Level 3: Platform Default
  false (thinking disabled)
```

**Resolution chain** — first non-null wins:

```
Agent ABL  →  Agent DB hyperParameters  →  Project Settings  →  false
  (IR)         (model-resolution L1)       (model-resolution L3)  (platform default)
```

**Deployment pinning**:

```
Deployment created with settingsVersionId = "psv-abc123"
  → model-resolution uses pinned version for enableThinking/thinkingBudget
  → Project admin changes working copy → does NOT affect deployed agents
  → New deployment created with latest version → picks up changes
```

**Pre-resolution at session creation**:

```
LLM wiring (session start):
  ① SessionLLMClient.resolveEnableThinking()
  ② Runs full resolution chain → { enableThinking: true, thinkingBudget: 10000 }
  ③ Stores on session: session.resolvedEnableThinking = true
                        session.resolvedThinkingBudget = 10000

Prompt builder (every LLM call):
  enableThinking = session.resolvedEnableThinking ?? ir?.execution?.enable_thinking
  // No DB round-trip — already resolved at session creation
```

**What `thought` injection looks like on regular tools** (new in this change):

```
Before (thought only on system tools):
  __handoff__:  { reason: "...", thought: "...", target: "sales_agent" }
  search_hotels: { destination: "Paris", dates: "..." }  // No thought field

After (thought on ALL tools when enabled):
  __handoff__:  { reason: "...", thought: "...", target: "sales_agent" }
  search_hotels: { reason: "...", thought: "...", destination: "Paris", dates: "..." }
  // reason is always injected; thought only when enableThinking is true
  // Both are stripped before forwarding to the tool executor
```

**Use cases this solves**:

| Scenario                 | Before                                             | After                                                             |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| Global thinking toggle   | Edit every ABL file individually                   | One project setting, all agents inherit                           |
| Agent opt-out            | Not possible — all or nothing                      | Agent sets `enable_thinking: false` in ABL or Studio              |
| Deployment safety        | Settings change affects all envs immediately       | Pin `settingsVersionId` per deployment                            |
| Budget control           | No budget concept                                  | `thinking_budget: 10000` limits thought token usage per tool call |
| Pre-resolved per session | IR value read on every prompt build                | Resolved once at session creation, stored on `RuntimeSession`     |
| Regular tool thought     | `thought` only on system tools, leaked to executor | `thought` injected on all tools, stripped before execution        |

#### Fix Details

**1. Parser + Compiler** — `agent-based-parser.ts`, `compiler.ts`:

```yaml
EXECUTION:
  enable_thinking: true
  thinking_budget: 10000
```

Parser extracts `enable_thinking` (boolean) and `thinking_budget` (integer) from EXECUTION block. Compiler passes through to `AgentIR.execution`.

**2. IR Schema** — `compiler/ir/schema.ts`:

Added `enable_thinking?: boolean` and `thinking_budget?: number` to `ExecutionConfig`.

**3. Database Models** — `project-settings.model.ts`, `project-settings-version.model.ts`, `deployment.model.ts`:

- `ProjectSettings`: Working copy with `enableThinking: boolean`, `thinkingBudget: number | null`
- `ProjectSettingsVersion`: Immutable snapshot with status lifecycle (`draft` → `testing` → `staged` → `active`)
- `Deployment.settingsVersionId`: Pins a deployment to a specific settings version

**4. Resolution repo** — `llm-resolution-repo.ts`:

New `findProjectEnableThinking(projectId, settingsVersionId?, tenantId?)`:

1. If `settingsVersionId` provided → look up pinned `ProjectSettingsVersion`
2. Else → find `active` version for project
3. Else → fall back to `ProjectSettings` working copy

**5. Model resolution** — `model-resolution.ts`:

- Pre-fetches project enableThinking in parallel with tenant policy and tier overrides
- Level 1 (Agent DB): Extracts `enableThinking`/`thinkingBudget` from `AgentModelConfig.hyperParameters`
- Level 3 (Project DB): Falls back to project settings when agent-level is null

**6. Session LLM client** — `session-llm-client.ts`:

New `resolveEnableThinking()` public method — runs full resolution chain and returns `{ enableThinking?, thinkingBudget? }`.

**7. LLM wiring** — `llm-wiring.ts`:

At session creation, calls `client.resolveEnableThinking()` and stores resolved values on `RuntimeSession.resolvedEnableThinking` and `RuntimeSession.resolvedThinkingBudget`.

**8. Prompt builder** — `prompt-builder.ts`:

- Resolution priority: `session.resolvedEnableThinking ?? ir?.execution?.enable_thinking`
- When thinking enabled, `thought` is required on ALL tools (system + regular)
- `thinkingBudget` appended to thought description: "Keep your reasoning within N tokens"
- `reason` injected on all regular tools (always, not just when thinking enabled)

**9. Session types** — `types.ts`:

Added `resolvedEnableThinking?: boolean`, `resolvedThinkingBudget?: number`, `settingsVersionId?: string` to `RuntimeSession`.

| What                    | File                                | Change                                                                  |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Parser                  | `agent-based-parser.ts`             | Parse `enable_thinking`, `thinking_budget` from EXECUTION               |
| Compiler                | `compiler.ts`                       | Pass through to IR execution config                                     |
| IR schema               | `schema.ts`                         | Add `enable_thinking`, `thinking_budget` to ExecutionConfig             |
| DB model (working copy) | `project-settings.model.ts`         | `ProjectSettings` with enableThinking + thinkingBudget                  |
| DB model (version)      | `project-settings-version.model.ts` | `ProjectSettingsVersion` with immutable snapshot + status lifecycle     |
| DB model (deployment)   | `deployment.model.ts`               | Add `settingsVersionId` field                                           |
| Resolution repo         | `llm-resolution-repo.ts`            | `findProjectEnableThinking()` with version fallback chain               |
| Model resolution        | `model-resolution.ts`               | Parallel pre-fetch, agent-level + project-level extraction              |
| Session LLM client      | `session-llm-client.ts`             | `resolveEnableThinking()` public method                                 |
| LLM wiring              | `llm-wiring.ts`                     | Pre-resolve at session creation, store on RuntimeSession                |
| Prompt builder          | `prompt-builder.ts`                 | Resolution priority, thought on all tools, budget in description        |
| Session types           | `types.ts`                          | `resolvedEnableThinking`, `resolvedThinkingBudget`, `settingsVersionId` |
| Deployment routes       | `deployments.ts`                    | Accept + propagate settingsVersionId                                    |
| Deployment resolver     | `deployment-resolver.ts`            | Pass settingsVersionId to ResolvedAgent                                 |
| Cascade delete          | `cascade-delete.ts`                 | Delete ProjectSettingsVersion + ProjectSettings on project delete       |
| Seed data               | `seed-mongo.ts`                     | Seed ProjectLLMConfig + ProjectSettings for test project                |

---

### 3.7. Tool Thought Extraction + Chat UI Display — **Completed**

**Files**: `reasoning-executor.ts`, `routing-executor.ts`, `types/index.ts`, `WebSocketContext.tsx`, `session-store.ts`, `MessageList.tsx`, `ChatPanel.tsx`, `globals.css`, `trace-store.ts`, `replay-trace-events.ts`, `studio/types/index.ts`

> **Design doc**: [`docs/plans/thought-in-chat-ui.md`](./plans/thought-in-chat-ui.md)

#### Current Behavior

When `enable_thinking` is ON, the prompt builder injects a `thought` property into every tool schema. The LLM fills this in to explain its reasoning per tool call. Currently:

- **System tools** (`__handoff__`, etc.): `thought` is extracted, stripped, emitted as a `decision` trace event → goes to Observatory debug panel only, **not to chat**.
- **Regular tools**: `thought` is **not extracted at all** — it gets passed to the actual tool executor (HTTP/MCP/sandbox endpoint), wasting tokens and potentially confusing external APIs.
- **Chat UI**: Only shows `user`, `assistant`, `system` messages. No tool call or thought rendering exists.
- **Handoff text**: When the LLM calls `__handoff__`, the runtime sends a "Transferring you to Sales Agent" text chunk to the chat for ALL channels — even non-voice channels where the thought card provides better context.
- **Streaming text**: LLM text before a system-tool call (e.g. "Let me transfer you to our sales team") is always streamed to chat, even when the LLM is just routing internally.

```
System tool path:
  LLM calls __handoff__({ reason: "...", thought: "reasoning here", target: "sales" })
  → thought extracted at line 550-572
  → emitted as 'decision' trace event
  → sent to Observatory debug panel
  → NOT visible in chat UI

Regular tool path:
  LLM calls search_hotels({ thought: "reasoning here", destination: "Paris" })
  → thought NOT extracted
  → passed to tool executor: session.toolExecutor.execute("search_hotels", { thought: "...", destination: "Paris" })
  → external API receives 'thought' as a parameter — WRONG

Handoff path:
  runtime sends: onChunk("Transferring you to Sales Agent") → appears in chat for ALL channels
  → redundant in non-voice channels where the thought card already shows reasoning
```

#### Updated Behavior

Six coordinated changes across runtime and Studio create a unified thought experience:

**A. Runtime — thought extraction + text buffering** (`reasoning-executor.ts`):

Both system and regular tool thoughts are extracted, stripped, and emitted as `tool_thought` trace events.

```
System tool path (reasoning-executor.ts:580-591):
  LLM calls __handoff__({ reason: "...", thought: "reasoning here", target: "sales" })
  → thought extracted (existing behavior)
  → 'decision' trace event emitted (existing, preserved for Observatory)
  → NEW: 'tool_thought' trace event also emitted
  → thought stripped from input before handling

Regular tool path (reasoning-executor.ts:741-755):
  LLM calls search_hotels({ reason: "...", thought: "reasoning here", destination: "Paris" })
  → NEW: thought + reason destructured out
  → NEW: 'tool_thought' trace event emitted
  → executor receives clean input: { destination: "Paris" }
  → retry path also uses clean input
```

**Iteration text buffering** — LLM text is buffered per-iteration instead of streamed directly. When all tool calls in an iteration are system tools (handoff, delegate, escalate), the buffer is **discarded** — the thought card provides reasoning context instead. For non-system-tool iterations and final responses, the buffer is flushed normally.

```
LLM iteration with system-only tools:
  LLM produces text: "Let me transfer you to our sales team"
  LLM calls: __handoff__({ target: "sales_agent", thought: "User needs booking help" })
  → text buffered, NOT streamed (all tools are system tools)
  → tool_thought emitted → chat shows thought card instead
  → buffer discarded

LLM iteration with regular tools:
  LLM produces text: "Let me search for hotels in Paris"
  LLM calls: search_hotels({ destination: "Paris", thought: "..." })
  → text buffered initially
  → not all tools are system tools → buffer flushed to chat
  → tool_thought also emitted

Final response (no tool calls):
  LLM produces text: "Here are the best options..."
  → buffer flushed immediately to chat
```

**B. Voice-only handoff messages** (`routing-executor.ts`):

The `onChunk` handoff message ("Transferring you to Sales Agent") is now **only sent for voice channels**. Non-voice channels rely on the thought card or handoff trace event for UX — eliminating the redundant system message.

**C. Turn-scoped thought merging** (`WebSocketContext.tsx`):

Multiple `tool_thought` events in a single user turn are **merged into one thought card** instead of creating separate cards. The handoff event also merges its routing info (`from` → `to`) into the current turn's thought card metadata. Falls back to a system message only when no thought card exists (i.e. thinking is disabled).

```
User sends: "I need help booking a hotel"

  ① startStreaming → placeholder thought created (blinking bulb)
  ② tool_thought (search_hotels): "Searching for hotels..."
     → merged into placeholder card, content updated
  ③ tool_thought (__handoff__): "User needs specialized help"
     → appended to same card: content = "Searching...\nUser needs specialized help"
  ④ handoff event: from=supervisor → to=sales_agent
     → merged into card metadata: { handoffTo: "sales_agent" }
  ⑤ response_end → endStreaming() → thoughts collapse, empty placeholders cleaned up

Result: ONE thought card showing:
  💡 Thinking · Handoff → sales_agent  ▸
```

**D. Placeholder thought + animated bulb states** (`session-store.ts`, `globals.css`, `MessageList.tsx`):

`startStreaming()` immediately creates an empty placeholder thought message and expands it. This makes the blinking lightbulb appear **instantly** when the agent starts working — before any `tool_thought` event arrives. The bulb has three visual states:

```
① Blinking (agent working):  animate-bulb-blink — 1.2s warm pulse
   text-warning + drop-shadow glow, toggles 100%↔30% opacity
   Shown when: isLast && (isStreaming || isLoading)

② Steady glow (has content):  bulb-on — warm drop-shadow, no animation
   Shown when: thought has content, agent done
   fill="currentColor" for solid filled bulb

③ Hidden (no content, not thinking):  returns null
   Placeholder removed by endStreaming() cleanup
```

`endStreaming()` removes placeholder thoughts that never received content (no tool_thought events arrived).

**E. Streaming guard** (`ChatPanel.tsx`):

`StreamingMessage` only renders when `streamingContent` is truthy. This prevents an empty streaming box from appearing during system-tool-only iterations where the text buffer was discarded.

**F. ThoughtItem component** (`MessageList.tsx`):

Redesigned with three-state rendering:

```
ThoughtItem states:

  Thinking (blinking, no content yet):
    💡⚡ Thinking…

  Collapsed (content available, agent done):
    💡 Agent Reasoning · Handoff → Sales Agent  ▸

  Expanded (user clicked):
    💡 Agent Reasoning · Handoff → Sales Agent  ˅
    ┃ The user wants hotels in Paris within budget.
    ┃ I'll search for 4-star options under €200/night
    ┃ since they mentioned preferring central areas.
    ┃
    ┃ User needs specialized booking help, routing to sales.
```

- `FRIENDLY_TOOL_LABELS` map: `__handoff__` → "Handoff", `__delegate__` → "Delegate", etc.
- `Lightbulb` icon with `fill="currentColor"` for solid appearance
- Smooth CSS collapse via `collapse-content` / `collapse-content.open` (grid-template-rows transition)
- `ChevronRight` with `rotate-90` transform when expanded
- Handoff routing display: "→ Sales Agent" from merged `handoffTo` metadata
- Empty-state guard: returns `null` when no content and not thinking

**Use cases this solves**:

| Scenario                     | Before                                                   | After                                                        |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Regular tool thought leakage | `thought` passed to HTTP/MCP executor                    | Stripped before execution, emitted as trace event            |
| Chat visibility of reasoning | Only in Observatory debug panel                          | Collapsible thought card in chat UI                          |
| Consistent event type        | System tools emit `decision`, regular tools emit nothing | Both emit `tool_thought` (system tools also keep `decision`) |
| Redundant handoff text       | "Transferring to Sales Agent" on ALL channels            | Voice-only; non-voice uses thought card                      |
| LLM preamble before routing  | "Let me transfer you..." streamed to chat                | Text buffered and discarded for system-tool-only rounds      |
| Multiple thoughts per turn   | Would create N separate thought cards                    | Merged into ONE card per user turn                           |
| Instant thinking indicator   | Nothing until first tool_thought event                   | Blinking bulb appears immediately on startStreaming          |
| Empty streaming box          | Empty `StreamingMessage` during system-tool rounds       | Guard: only render when `streamingContent` is truthy         |
| Session replay               | Thought messages not in replay                           | `hydrateSessionStoreFromDetail()` includes `'thought'` role  |

#### Fix Details

**1. Runtime — thought extraction for regular tools** — `reasoning-executor.ts:741-755`:

```typescript
// Strip observability-only fields before forwarding to external tools
const { thought: userToolThought, reason: userToolReason, ...cleanInput } = toolCall.input;
if (userToolThought) {
  onTraceEvent?.({
    type: 'tool_thought',
    data: {
      toolName: toolCall.name,
      thought: userToolThought,
      reasoning: userToolReason,
      agent: session.agentName,
    },
  });
}
toolResult = await session.toolExecutor.execute(toolCall.name, cleanInput, 30000);
```

**2. Runtime — `tool_thought` for system tools** — `reasoning-executor.ts:580-591`:

Existing system tool thought extraction also emits `tool_thought` in addition to `decision` (backward compatible — Observatory still receives `decision`).

**3. Runtime — iteration text buffering** — `reasoning-executor.ts:282-300, 368-376, 470-474`:

```typescript
// Buffer text per-iteration — suppress for system-tool-only rounds
let iterBuffer = '';
const bufferChunk = onChunk
  ? (chunk: string) => {
      iterBuffer += chunk;
    }
  : undefined;

// After tool calls processed:
const allSystemTools = result.toolCalls.every((tc) => tc.name.startsWith('__'));
if (!allSystemTools && iterBuffer && onChunk) {
  onChunk(iterBuffer + '\n\n'); // Flush for regular tool rounds
}
// System-tool-only rounds: iterBuffer silently discarded

// Final response (no tools): flush immediately
if (iterBuffer && onChunk) {
  onChunk(iterBuffer);
}
```

**4. Runtime — voice-only handoff messages** — `routing-executor.ts:355-366`:

```typescript
// Send handoff message only for voice channels. Non-voice channels use the
// thought card (tool_thought trace event) or handoff trace event for UX.
if (onChunk && isVoiceChannel(session)) {
  const msg = interpolateTemplate(
    session.agentIR?.messages?.handoff_message_voice || DEFAULT_MESSAGES.handoff_message_voice,
    { target: targetAgent.replace(/_/g, ' ') },
  );
  onChunk(msg);
}
```

**5. Trace event type** — `types/index.ts`:

Added `| 'tool_thought'` to `TraceEventType` union.

**6. Studio types** — `studio/types/index.ts`:

- `SessionMessage.role`: Added `| 'thought'`
- `SessionMessage.metadata`: Added `toolName`, `agentName`, `handoffFrom`, `handoffTo`
- `ExtendedTraceEventType`: Added `| 'tool_thought'`

**7. WebSocket handler — turn-scoped merging** — `WebSocketContext.tsx`:

For `tool_thought` events: walks messages backward to find a thought in the current turn (before the last `user` message). If found and streaming, appends content via `updateMessage()`. Otherwise creates a new thought card. For `handoff` events: merges routing into the current turn's thought card metadata, or falls back to a system message when no thought card exists.

**8. Session store** — `session-store.ts`:

- `expandedThoughtIds: Set<string>` — tracks expanded thoughts
- `expandThought(id)` / `collapseAllThoughts()` / `toggleThought(id)` actions
- `updateMessage(id, updates)` — enables merging content/metadata into existing messages
- `startStreaming()` — creates empty placeholder thought with blinking bulb, pre-expands it
- `endStreaming()` — clears `expandedThoughtIds`, removes placeholder thoughts with no content
- All session lifecycle methods (`setSession`, `clearSession`, `restoreSession`) reset to empty `Set`

**9. Chat UI — ThoughtItem** — `MessageList.tsx`:

- `FRIENDLY_TOOL_LABELS` map for system tools
- Three bulb states: `animate-bulb-blink` (thinking), `bulb-on` (has content), hidden (empty)
- `Lightbulb` icon with `fill="currentColor"`, `text-warning` color
- `collapse-content` CSS class for smooth expand/collapse (grid-template-rows transition)
- `ChevronRight` with `rotate-90` transform on expand
- Handoff routing: "→ Sales Agent" from `handoffTo` metadata
- Empty-state guard: `null` when no content and not thinking

**10. Streaming guard** — `ChatPanel.tsx`:

```typescript
{isStreaming && streamingContent && (  // Guard: only render when content exists
  <StreamingMessage content={streamingContent} />
)}
```

**11. Animations** — `globals.css`:

- `@keyframes bulb-blink`: 1.2s ease-in-out, toggles opacity 100%↔30% with warm `drop-shadow`
- `.animate-bulb-blink`: applies bulb-blink animation
- `.bulb-on`: steady warm glow (`drop-shadow(0 0 3px hsl(--warning / 0.5))`)

**12. Trace store + replay** — `trace-store.ts`, `replay-trace-events.ts`:

- `'tool_thought'` added to `ALL_TYPES` array
- `formatTraceEventLog()`: `Thought (search_hotels): The user wants...`
- `hydrateSessionStoreFromDetail()`: Role cast includes `'thought'`

| What                  | File                     | Change                                                             |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| Regular tool strip    | `reasoning-executor.ts`  | Destructure thought/reason, emit `tool_thought`, pass clean input  |
| System tool emit      | `reasoning-executor.ts`  | Also emit `tool_thought` alongside existing `decision`             |
| Text buffering        | `reasoning-executor.ts`  | Buffer per-iteration, discard for system-tool-only rounds          |
| Voice-only handoff    | `routing-executor.ts`    | Handoff `onChunk` message only for `isVoiceChannel(session)`       |
| Trace event type      | `types/index.ts`         | Add `'tool_thought'` to `TraceEventType`                           |
| Studio types          | `studio/types/index.ts`  | `'thought'` role, `toolName`/`agentName`/`handoffFrom`/`handoffTo` |
| Turn-scoped merging   | `WebSocketContext.tsx`   | Merge tool_thought + handoff into one thought card per user turn   |
| Session store         | `session-store.ts`       | Placeholder thought, `updateMessage`, expand/collapse, cleanup     |
| ThoughtItem component | `MessageList.tsx`        | Three-state bulb, friendly labels, CSS collapse, handoff routing   |
| Streaming guard       | `ChatPanel.tsx`          | Only render `StreamingMessage` when `streamingContent` is truthy   |
| Bulb animations       | `globals.css`            | `bulb-blink` keyframes, `.animate-bulb-blink`, `.bulb-on` glow     |
| Trace store           | `trace-store.ts`         | Add to `ALL_TYPES`                                                 |
| Replay utility        | `replay-trace-events.ts` | Log formatting + role cast for hydration                           |

---

### 3.8. Handoff/Delegate `message` Parameter — **Completed**

**Files**: `prompt-catalog.ts`, `prompt-builder.ts`, `routing-executor.ts`, `reasoning-executor.ts`, `fan-out.test.ts`, `prompt-builder.test.ts`, `prompt-catalog.test.ts`

#### Current Behavior

When a supervisor calls `__handoff__`, the child agent receives the **last user message** from conversation history — there's no way for the supervisor to specify _what_ message the child should handle. This causes two problems:

1. **Multi-intent messages**: User says "Book a flight and find a hotel." Supervisor hands off to Flight_Agent, but the child gets the entire multi-intent string instead of just "Book a flight."
2. **Parallel→fan_out conversion**: The guard that converts parallel `__handoff__` calls into a synthesized `__fan_out__` uses the same full user message as intent for every task — losing the LLM's per-target decomposition.

For `__delegate__`, the child receives `JSON.stringify(inputData)` — structured data, not a natural language instruction.

Fan-out already has an explicit `intent` field per task. Handoff and delegate did not.

#### Updated Behavior

A **required** `message` field on both `__handoff__` and `__delegate__` tool schemas:

- The LLM must articulate the specific sub-request the child should handle
- For handoff: replaces the implicit `lastUserMessage` extraction — the supervisor explicitly states what the child should do
- For delegate: provides a natural language instruction alongside optional structured `input` data
- In the parallel→fan_out conversion, `tc.input.message` is used directly as the per-task intent

**Example — multi-intent message**:

```
User: "Book a flight and find a hotel"

Before (both children get same message):
  __handoff__({ target: "Flight_Agent", reason: "flight request" })
  → child receives: "Book a flight and find a hotel"

After (each child gets targeted message):
  __handoff__({ target: "Flight_Agent", message: "Book a flight", reason: "flight request" })
  → child receives: "Book a flight"
```

**Example — parallel→fan_out conversion**:

```
Before: synthesized fan_out tasks all get userMessage as intent
After:  synthesized fan_out tasks get tc.input.message as intent (per-target sub-request)
```

**Safety net**: If the LLM omits `message` despite it being required, both handlers fall back to `lastUserMessage` (handoff) or `JSON.stringify(delegateInput)` (delegate).

#### Fix Details

| What                  | File                     | Change                                                                                              |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| Schema + descriptions | `prompt-catalog.ts`      | Add `message` to handoff + delegate schemas (type: string, required) and descriptions               |
| Tool registration     | `prompt-builder.ts`      | Wire `message` into handoff + delegate tool definitions in `buildTools()`                           |
| Handoff execution     | `routing-executor.ts`    | `handleHandoff`: use `input.message` as primary, fallback to `lastUserMessage`. Add to trace event. |
| Remote handoff        | `routing-executor.ts`    | `handleRemoteHandoff`: accept `messageOverride` param, use for A2A SDK message                      |
| Delegate execution    | `routing-executor.ts`    | `handleDelegate` + `executeDelegate`: extract `message`, use as primary input message, add to trace |
| Fan-out conversion    | `reasoning-executor.ts`  | Use `tc.input.message` as per-task intent in parallel→fan_out synthesis                             |
| Tests                 | `fan-out.test.ts`        | `__handoff__` includes required `message` property                                                  |
| Tests                 | `prompt-builder.test.ts` | `__handoff__` and `__delegate__` schemas have required `message`                                    |
| Tests                 | `prompt-catalog.test.ts` | Schema properties and required arrays include `message`                                             |

### 3.10. Per-Agent Routing Tools — Replace Generic `__handoff__`/`__delegate__`/`__fan_out__` — **Planned**

**Design doc**: [`docs/plans/2026-03-06-per-agent-routing-tools-design.md`](./plans/2026-03-06-per-agent-routing-tools-design.md)
**Implementation doc**: [`docs/plans/2026-03-06-per-agent-routing-tools-implementation.md`](./plans/2026-03-06-per-agent-routing-tools-implementation.md)

**Files**: `prompt-builder.ts`, `routing-executor.ts`, `reasoning-executor.ts`

#### Problem

Generic routing tools (`__handoff__`, `__delegate__`, `__fan_out__`) use flat enum target lists across separate tools. The LLM must make a two-step decision (pick tool → pick enum value) causing frequent misrouting. Example: "book a flight" → `__handoff__` → `Live_Agent_Transfer` instead of `__delegate__` → `Sales_Agent`, because `__handoff__` is described as "MANDATORY for every user message".

#### Solution

Replace generic tools with **per-agent transfer functions** named by convention:

| DSL Source                     | Generated Tool  | Behavior           |
| ------------------------------ | --------------- | ------------------ |
| `HANDOFF: TO: X`               | `handoff_to_X`  | Transfer control   |
| `HANDOFF: TO: X, RETURN: true` | `handoff_to_X`  | Transfer + return  |
| `DELEGATE: AGENT: X`           | `delegate_to_X` | Call as function   |
| `ROUTING: RULE: TO: X`         | `handoff_to_X`  | Supervisor routing |

Each tool gets a **dedicated description** (from DSL `CONTEXT: summary:` / `PURPOSE:`) and **typed input schema** (from `CONTEXT: pass:` / `INPUT:` fields resolved against `MEMORY.session` declarations).

`__fan_out__` is removed — LLMs that support parallel tool calls invoke multiple `handoff_to_*`/`delegate_to_*` in one response; non-parallel models handle intents sequentially.

#### Key Decisions

| Decision                                 | Choice            | Rationale                                                                                    |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Per-agent vs unified tool                | Per-agent         | Tool NAME is strongest LLM signal; enum values are weakly matched                            |
| `handoff_to_X` vs `delegate_to_X` naming | Separate prefixes | Same agent in both HANDOFF and DELEGATE gets two tools with different descriptions + schemas |
| Remove `__fan_out__`                     | Yes               | Not a DSL construct; LLM parallel tool calls handle multi-intent natively                    |
| System prompt simplification             | Yes               | Routing rules move into tool descriptions; ~300 tokens saved                                 |

#### Expected Impact

| Metric                           | Current             | After        |
| -------------------------------- | ------------------- | ------------ |
| Routing accuracy                 | 70-80%              | 90-95%       |
| Token delta (8-agent supervisor) | ~1600               | ~1700 (+100) |
| System prompt size               | ~400 tokens routing | ~50 tokens   |
| Average turns to correct route   | 1.5-2.0             | 1.0-1.1      |

---

### 3.9. LLM Call Options + Message Thread in Debug UI — **Completed**

**Files**: `reasoning-executor.ts`, `flow-step-executor.ts`, `config/index.ts`, `useLLMCalls.ts`, `LLMCallCard.tsx`, `llm-cost.ts`, `studio.json`

#### Current Behavior

The debug window's LLM calls tab shows token counts, latency, cost, system prompt, and tools — but two key pieces of information are missing:

1. **LLM call options**: Provider-level settings like `disableParallelToolUse` and `toolChoice` are invisible. You can't tell if a supervisor was constrained from making parallel tool calls, or if an extraction call used forced tool choice.

2. **Conversation messages**: Only plain text messages are captured in the trace event (`filter((m) => typeof m.content === 'string')`). Tool use blocks (assistant calling `__fan_out__`) and tool result blocks (fan-out results sent back to LLM for synthesis) are dropped. You can't see the full round-trip that drives synthesis.

#### Updated Behavior

##### A. LLM Call Options in Trace Events + Debug UI

Runtime emits `disableParallelToolUse` and `toolChoice` as fields in `llm_call` trace events. The Studio hook extracts them into an `llmOptions` object on `LLMCall`. The UI renders them as compact badges:

- **"No Parallel Tools"** — amber badge when `disableParallelToolUse` is true
- **"tool_choice: \_extract_entities"** — blue monospace badge for forced tool choice

Options are also included in the Raw Request Payload JSON viewer.

##### B. `allowParallelToolCalls` Feature Flag

The `disableParallelToolUse` option is now controlled via the proper config system instead of a raw `process.env` read:

```typescript
// config/index.ts — FeatureFlagsSchema
allowParallelToolCalls: z.boolean().default(false)

// .env mapping
ALLOW_PARALLEL_TOOL_CALLS → features.allowParallelToolCalls

// reasoning-executor.ts
const allowParallel = getConfig().features.allowParallelToolCalls;
const disableParallelToolUse = isSupervisor && !allowParallel;
```

When `allowParallelToolCalls` is true, supervisors are free to make parallel tool calls — the application-level guard in reasoning-executor converts them to `__fan_out__` (with per-target `message` intents from 3.8).

##### C. Full Conversation Messages in Trace Events

The trace event message snapshot now captures **all message types** (last 20 messages instead of 10 text-only):

- **Text messages**: `{ role, content: "text..." }`
- **Tool use blocks**: `{ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }`
- **Tool result blocks**: `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`

##### D. Message Thread Component in LLM Call Card

A new **Messages Thread** section renders the conversation as a visual thread between the metadata row and raw payload:

- **User messages** — blue icon with text content
- **Assistant messages** — purple icon with text content
- **Tool use blocks** — wrench icon with tool name, ID, and collapsible input JSON
- **Tool result blocks** — arrow icon with formatted result JSON (auto-parsed for readability)
- **LLM response** — shown at the bottom with a dashed separator

For fan-out synthesis calls, you now see the full round-trip: the `__fan_out__` tool_use with its tasks, followed by the tool_result containing per-agent responses and the "Synthesize a unified response" instruction.

#### Fix Details

| What             | File                    | Change                                                                         |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Options in trace | `reasoning-executor.ts` | Add `disableParallelToolUse` to `llm_call` trace event data                    |
| Options in trace | `flow-step-executor.ts` | Add `toolChoice` to extraction `llm_call` trace event data                     |
| Feature flag     | `config/index.ts`       | Add `allowParallelToolCalls` to `FeatureFlagsSchema` + env mapping             |
| Config usage     | `reasoning-executor.ts` | Use `getConfig().features.allowParallelToolCalls` instead of `process.env`     |
| Full messages    | `reasoning-executor.ts` | Capture tool_use + tool_result messages in trace (not just text strings)       |
| Hook types       | `useLLMCalls.ts`        | Add `MessageContentBlock`, `LLMMessage` types, `llmOptions` field on `LLMCall` |
| Hook extraction  | `useLLMCalls.ts`        | Extract `disableParallelToolUse` and `toolChoice` from trace event data        |
| UI: options      | `LLMCallCard.tsx`       | `LLMOptionsRow` component with amber/blue badges                               |
| UI: messages     | `LLMCallCard.tsx`       | `MessageBubble` + `ContentBlockView` components for conversation thread        |
| UI: raw payload  | `LLMCallCard.tsx`       | Include `options` in raw request JSON viewer                                   |
| Serialization    | `llm-cost.ts`           | Widen `messages` type to `Array<{ role: string; content: unknown }>`           |
| i18n             | `studio.json`           | Add `llm_options`, `no_parallel_tools`, `tool_choice`, `messages_thread` keys  |

---

## 4. MEDIUM Changes

### 4.1. Compiler Validation for RECALL Event Names — **Completed**

> **Design doc**: [`docs/plans/2026-03-01-lifecycle-events-tool-schemas-design.md`](./plans/2026-03-01-lifecycle-events-tool-schemas-design.md)

**Files**: `compiler/ir/compiler.ts`, `event-detector.ts`

#### Current Behavior

```yaml
MEMORY:
  recall:
    - ON: booking_completed # ← not a valid event, silently never fires
```

No warning at parse time, compile time, or runtime. The author discovers the bug only when RECALL doesn't fire in a live session.

#### Updated Behavior

Compiler validates every RECALL `ON:` event against:

1. Built-in lifecycle patterns (from `LIFECYCLE_PATTERNS` exported by 3.3)
2. Legacy aliases (from `LEGACY_EVENT_ALIASES` exported by 3.3)
3. Tool names in `tool:<name>:after` references (from declared tools)
4. Agent names in `agent:<name>:before/after` references (from routing rules + coordination handoffs)

**Example — valid events pass silently**:

```yaml
RECALL:
  - ON: session:start # ✓ built-in lifecycle
  - ON: agent:Billing_Agent:before # ✓ named agent lifecycle (agent exists in routing)
  - ON: agent:*:after # ✓ wildcard agent lifecycle
  - ON: tool:search_hotels:after # ✓ named tool lifecycle (tool declared)
  - ON: tool:*:after # ✓ wildcard tool lifecycle
  - ON: session_start # ✓ legacy alias → session:start
```

**Example — invalid event gets diagnostic**:

```yaml
RECALL:
  - ON: tool:nonexistent_tool:after # ← tool not declared
  - ON: agent:Unknown_Agent:before # ← agent not in routing rules
  - ON: booking_completed # ← no matching pattern
```

```
⚠ WARNING: RECALL event "tool:nonexistent_tool:after" references unknown tool "nonexistent_tool". Declared tools: search_hotels, book_room
⚠ WARNING: RECALL event "agent:Unknown_Agent:before" references unknown agent "Unknown_Agent". Known agents: Billing_Agent, Support_Agent
⚠ WARNING: RECALL event "booking_completed" does not match any known event. Valid patterns: session:start, session:end, agent:<name>:before, agent:<name>:after, agent:*:before, agent:*:after, tool:<name>:after, tool:*:after
```

#### Fix Details

Depends on 3.3's `LIFECYCLE_PATTERNS` and `LEGACY_EVENT_ALIASES` exports. The `validateRecallEvents()` function:

1. Collects declared tool names and known agent names (from routing rules + coordination handoffs)
2. For each RECALL `ON:` event, checks: legacy alias → lifecycle pattern → tool name → agent name
3. For `tool:<name>:after` patterns, verifies the specific tool name exists in declared tools
4. For `agent:<name>:before/after` patterns, verifies the specific agent name exists in known agents
5. Emits `ValidationDiagnostic` with severity `warning` and actionable message (includes available tool/agent names)

| What                      | File                      | Change                                                                                                |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lifecycle patterns import | `compiler/ir/compiler.ts` | Import `LIFECYCLE_PATTERNS`, `LEGACY_EVENT_ALIASES` from `event-detector.ts`                          |
| Agent name collection     | `compiler/ir/compiler.ts` | `collectKnownAgents(ir)` from routing rules + coordination handoffs                                   |
| Validation pass           | `compiler/ir/compiler.ts` | `validateRecallEvents()` with tool name + agent name verification                                     |
| Diagnostic output         | `compiler/ir/compiler.ts` | `ValidationDiagnostic` with specific "unknown tool" / "unknown agent" / "unrecognized event" messages |
| Tests                     | `compiler.test.ts`        | Valid lifecycle, valid tool ref, invalid tool ref, invalid agent ref, legacy alias, wildcard patterns |

---

### 4.2. Tool Context Access + Imperative Memory API — **Completed**

**Files**: `compiler/ir/schema.ts`, `core/types/agent-based.ts`, `core/parser/tool-file-parser.ts`, `core/parser/agent-based-parser.ts`, `compiler/ir/compiler.ts`, `compiler/ir/compile-behavior-profile.ts`, `reasoning-executor.ts`, `http-tool-executor.ts`, `sandbox-tool-executor.ts`, `tool-binding-executor.ts`, `tool-memory-bridge.ts` (new), `llm-wiring.ts`, `prompt-builder.ts`, `compiler/constructs/types.ts`

Combined implementation of items 4.2 (Tool Context Access) and 5.1 (Project-Scoped Facts) into a unified 3-scope memory system with tool-side memory APIs.

#### Previous Behavior

- Tools receive only explicit `params` from the LLM. Cannot read session variables. Cannot write back state.
- No project-level shared facts — every fact requires `userId`.
- No imperative memory API for code tools (sandbox/lambda).

#### Implemented Behavior

**A. Declarative CONTEXT_ACCESS for HTTP tools** — auto-inject reads, auto-apply writes:

```yaml
TOOLS:
  - check_inventory:
      TYPE: http
      CONTEXT_ACCESS:
        READ: [user_location, preferred_currency, loyalty_tier]
        WRITE: [last_inventory_check]
      PARAMS:
        item_id: { TYPE: string }
```

- Tool receives: `{ params: { item_id: "...", _context: { user_location: "...", ... } } }`
- HTTP body includes context under `context` key; headers support `{{_context.key}}` interpolation
- Tool can return: `{ result: {...}, context_updates: { last_inventory_check: "..." } }`
- `_context` is **not** exposed in the LLM tool schema — auto-injected at execution time

**B. Imperative memory API for code tools** (sandbox/lambda) — always available, no opt-in:

```javascript
// Inside sandbox tool code — scope auto-resolved from MEMORY declarations
const data = await memory.get_content('user_preferences'); // → { data: { content: <value> } }
await memory.set_content('booking_status', { status: 'confirmed' });
await memory.delete_content('temp_results');
// Errors: undeclared keys throw, read-only keys throw on write
```

**C. Project-scoped persistent memory** — shared across all users in a project:

```yaml
MEMORY:
  persistent:
    - path: user.preferences
      SCOPE: user # DEFAULT
      ACCESS: readwrite
      TYPE: object
    - path: global_promotions
      SCOPE: project # Shared across all users
      ACCESS: read
      TYPE: array
```

**Use cases this solves**:

| Scenario                  | Before                                        | After                                                                   |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Common session fields     | LLM passes `user_id` every tool call          | Auto-injected from `CONTEXT_ACCESS: READ`                               |
| Tool-driven state updates | Tool can't set `booking_status = "confirmed"` | Tool returns `context_updates: { booking_status: "confirmed" }`         |
| Token savings             | LLM wastes tokens on known parameters         | Fewer params for LLM to manage                                          |
| Global promotions         | No way to share across users                  | `SCOPE: project` facts visible to all users                             |
| Legacy migration          | No `memory.get/set/delete`                    | `get_content`/`set_content`/`delete_content` with legacy wrapper format |

#### Implementation Details

**Data Model (Phase A)**:

| What                       | File                            | Change                                                                                                                                                           |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IR `PersistentMemory`      | `compiler/ir/schema.ts`         | Added `scope: 'user' \| 'project'` (required field)                                                                                                              |
| IR `ToolContextAccess`     | `compiler/ir/schema.ts`         | New interface with `read: string[]`, `write: string[]`                                                                                                           |
| IR `ToolDefinition`        | `compiler/ir/schema.ts`         | Added `context_access?: ToolContextAccess`                                                                                                                       |
| AST `PersistentMemoryPath` | `core/types/agent-based.ts`     | Added `scope?: 'user' \| 'project'`                                                                                                                              |
| AST `AgentTool`            | `core/types/agent-based.ts`     | Added `contextAccess?: { read: string[]; write: string[] }`                                                                                                      |
| Fact model                 | `database/models/fact.model.ts` | Added `scope` field with `'user' \| 'project'` enum, updated compound index                                                                                      |
| FactStore                  | `mongodb-fact-store.ts`         | `MongoDBFactStore` constructor takes `scope` param, `ownerFilter()` includes scope. New `createProjectFactStore()` factory with `PROJECT_SCOPE_USER_ID` sentinel |

**Parser + Compiler (Phase B)**:

| What                    | File                                         | Change                                                                                            |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Parse `SCOPE:`          | `agent-based-parser.ts`                      | Persistent memory entries now parse `SCOPE:`, `ACCESS:`, `DESCRIPTION:` sub-properties            |
| Parse `CONTEXT_ACCESS:` | `tool-file-parser.ts`                        | New `parseContextAccessBlock()` handles `READ:` and `WRITE:` sub-properties                       |
| Compiler pass-through   | `compiler.ts`, `compile-behavior-profile.ts` | Maps `ast.scope` → `ir.scope`, `ast.contextAccess` → `ir.context_access`                          |
| Validation              | `compiler.ts`                                | `validateContextAccessDeclarations()` warns when CONTEXT_ACCESS references undeclared memory vars |

**Runtime Memory Integration (Phase C)**:

| What                  | File                              | Change                                                                             |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------- |
| Split load by scope   | `memory-integration.ts`           | `loadPersistentDefaults()` splits user/project paths, loads from respective stores |
| Route REMEMBER        | `memory-integration.ts`           | REMEMBER writes route to user or project FactStore based on declared scope         |
| Wire projectFactStore | `runtime-executor.ts`, `types.ts` | `projectFactStore` on `RuntimeSession`, wired at creation and rehydration          |

**Declarative Context Access (Phase D)**:

| What              | File                    | Change                                                                                                    |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Context injection | `reasoning-executor.ts` | Before tool execution, `_context` injected from session values for `context_access.read`                  |
| Context writes    | `reasoning-executor.ts` | After tool execution, `context_updates` applied to session values (whitelisted by `context_access.write`) |
| LLM schema        | `prompt-builder.ts`     | `_context` naturally excluded — not in IR parameters                                                      |

**Imperative Memory API (Phase E)**:

| What                      | File                                        | Change                                                                                   |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ToolMemoryAPI` interface | `compiler/constructs/types.ts`              | `get_content`, `set_content`, `delete_content` matching legacy product                   |
| `ToolMemoryBridge`        | `tool-memory-bridge.ts` (new)               | Builds path→scope lookup from MEMORY declarations, routes to session/user/project stores |
| Sandbox injection         | `sandbox-tool-executor.ts`                  | `memoryAPI` field, passed as `globals.memory` to `SandboxRunner`                         |
| Wiring                    | `tool-binding-executor.ts`, `llm-wiring.ts` | `setMemoryAPI()` method, bridge created during tool wiring                               |

**HTTP Context Marshaling (Phase F)**:

| What                 | File                    | Change                                                            |
| -------------------- | ----------------------- | ----------------------------------------------------------------- |
| Header interpolation | `http-tool-executor.ts` | `{{_context.key}}` resolved in header values                      |
| Body injection       | `http-tool-executor.ts` | Context vars included in body under `context` key for non-GET     |
| Param cleanup        | `http-tool-executor.ts` | `_context` stripped from regular params before URL/query building |

---

### 4.3. FactStore Batch Query Optimization — **Completed**

**Files**: `memory-integration.ts`, `memory-executor.ts`, `mongodb-fact-store.ts`

#### Current Behavior

**Problem A**: `loadPersistentDefaults()` loads ALL facts (up to 100) then filters client-side.
**Problem B**: `inject_context` RECALL does N DB round-trips for N paths.

#### Updated Behavior

Add `batchGet(keys: string[])` to FactStore. Single `$in` query.

| Operation                         | Before                                | After                             |
| --------------------------------- | ------------------------------------- | --------------------------------- |
| `persistent:` (2 paths, 80 facts) | 1 query → 80 docs, filter client-side | 1 query → 2 docs via `$in`        |
| `inject_context` (3 paths)        | 3 sequential `findOne()`              | 1 `find({ key: { $in: [...] } })` |

#### Fix Details

| What                   | File                         | Change                                                     |
| ---------------------- | ---------------------------- | ---------------------------------------------------------- |
| Interface              | `fact-store.ts`              | Add `batchGet(keys: string[]): Promise<Map<string, Fact>>` |
| MongoDB impl           | `mongodb-fact-store.ts`      | `find({ key: { $in: keys } })` with owner filter           |
| loadPersistentDefaults | `memory-integration.ts:140`  | Use `batchGet(paths)` instead of `query({})`               |
| inject_context         | `memory-executor.ts:101-107` | Use `batchGet(action.paths)` instead of N `get()` calls    |

---

### 4.4. Dynamic IDENTITY Interpolation (GOAL, PERSONA, LIMITATIONS) — **Completed**

**Files**: `prompt-builder.ts`

#### Current Behavior

```yaml
GOAL: 'Help {{customer_name}} book travel. Phase: {{current_phase}}'
# LLM sees literally: "Help {{customer_name}} book travel. Phase: {{current_phase}}"
```

`buildSystemPrompt()` uses raw strings without `interpolateTemplate()`.

#### Updated Behavior

```yaml
GOAL: 'Help {{customer_name}} book travel. Phase: {{current_phase}}'
# LLM sees: "Help John book travel. Phase: discovery"
```

**Use cases this solves**: Personalized identity, multi-phase workflows, tier-based capabilities, multi-tenancy.

#### Fix Details

3 lines changed in `prompt-builder.ts:117-131`:

```typescript
const goal = interpolateTemplate(ir.identity.goal, session.data.values);
const persona = interpolateTemplate(ir.identity.persona, session.data.values);
const limitation = interpolateTemplate(limitation, session.data.values);
```

---

### 4.5. LLM-Based Preference Detection

**Files**: `preference-detector.ts`, `memory-integration.ts`

#### Current Behavior

12 hardcoded regex patterns. Misses "I hate seafood", "big fan of rooftop bars", "that's a dealbreaker", negation, non-English.

#### Updated Behavior

Hybrid: keep regex for high-confidence patterns, use LLM structured tool call for ambiguous cases.

**Use cases this solves**: Natural language preference signals in any language, negation handling, entity normalization.

#### Fix Details

| What                | File                     | Change                                                |
| ------------------- | ------------------------ | ----------------------------------------------------- |
| LLM extraction tool | `preference-detector.ts` | Build `_detect_preferences` tool with category schema |
| Hybrid trigger      | `preference-detector.ts` | Regex first pass, LLM for unmatched text              |
| Config              | `compiler/ir/schema.ts`  | `preference_detection: 'regex' \| 'llm' \| 'hybrid'`  |

---

### 4.6. LLM Context Setting (`__set_context__` System Tool) — **Completed**

**Files**: `constants.ts`, `prompt-builder.ts`, `reasoning-executor.ts`, `compiler.ts`

#### Current Behavior

In reasoning mode, the LLM has no mechanism to write session variables from conversation. Session values (`session.data.values`) are only populated by tool call results (`last_<tool>_result`), GATHER extraction (scripted mode only), or manual assignment. This means REMEMBER triggers like `WHEN: user_name IS SET` never fire because the LLM learns facts from conversation (e.g., the user's name) but cannot store them in session state.

#### Updated Behavior

Agents with `MEMORY.session` variables declared get a `__set_context__` system tool injected into their tool list. The LLM calls this tool to explicitly store learned facts as session variables. When called:

1. Input keys are validated against the declared session memory variable names
2. Valid keys are written to `session.data.values`
3. `evaluateRememberAfterStateChange()` fires, which evaluates REMEMBER rules and persists matching facts via FactStore
4. On the next session, RECALL ON_START loads those facts back into the prompt

```
User: "Hi, I'm Alex and I prefer Spanish"
  → LLM calls __set_context__({ updates: { user_name: "Alex", user_language: "Spanish" } })
  → session.data.values.user_name = "Alex", session.data.values.user_language = "Spanish"
  → REMEMBER: WHEN user_name IS SET → STORE user_name -> user.name  (fires)
  → FactStore: { namespace: "user", key: "name", value: "Alex" }
```

**Use cases this solves**: Cross-session personalization, returning user recognition, language preference persistence.

#### Fix Details

| What           | File                    | Change                                                                                       |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| Constant       | `constants.ts`          | Add `SYSTEM_TOOL_SET_CONTEXT = '__set_context__'` + description                              |
| Reservation    | `compiler.ts`           | Add to `SYSTEM_TOOL_NAMES` set (prevents user tool shadowing)                                |
| Tool injection | `prompt-builder.ts`     | Inject tool when `ir.memory.session.length > 0`, schema restricts keys to declared var names |
| Handler        | `reasoning-executor.ts` | Validate keys, update `session.data.values`, trigger REMEMBER evaluation                     |

---

### 4.7. Non-Blocking Warning Constraints (WARN) — **Completed**

**Files**: `agent-based-parser.ts`, `agent-based.ts`, `compiler.ts`, `schema.ts`, `constraint-executor.ts`, `constraint-checker.ts`, `prompt-builder.ts`

#### Current Behavior

All constraints are blocking. When a condition fails, execution stops and the `ON_FAIL` message is returned immediately. There is no way to issue a soft warning that informs the LLM and user without blocking the action.

```yaml
CONSTRAINTS:
  # This BLOCKS the booking — user can't proceed even if they want to
  - REQUIRE total_price <= budget OR budget == null
    ON_FAIL: "This exceeds your budget of {{budget}}."
```

**Problem**: Some constraints are informational — the user should be warned but allowed to proceed. Example: budget advisory, expiring promotions, non-critical policy reminders. Using `REQUIRE` for these creates a rigid experience where the agent refuses legitimate user intent.

```
User: "Book the Grand Hotel for €1200"
Agent: "This exceeds your budget of €500."   ← BLOCKED, no way to proceed
User: "I know, I want to splurge"
Agent: "This exceeds your budget of €500."   ← Still blocked
```

#### Updated Behavior

New `WARN` keyword creates non-blocking constraints. Warnings are collected, injected into the system prompt, and emitted as `constraint_warning` trace events — but execution continues.

```yaml
CONSTRAINTS:
  # Hard constraint — blocks execution
  - REQUIRE search_results_valid == true
    ON_FAIL: "Search results have expired. Let me search again."

  # Soft constraint — warns but allows proceeding
  - WARN total_price <= budget OR budget == null
    ON_FAIL: "This exceeds your budget of {{budget}}. Would you like to see cheaper options or proceed anyway?"
```

**What happens at runtime**:

```
User: "Book the Grand Hotel for €1200" (budget = 500)

Constraint check:
  ① REQUIRE search_results_valid == true  →  passes (results valid)
  ② WARN total_price <= budget            →  FAILS (1200 > 500)
     → severity: 'warning' → non-blocking
     → constraint_warning trace event emitted
     → warning message stored: session.data.values._constraint_warnings

System prompt injection (next LLM call):
  ⚠️ ACTIVE WARNINGS (inform the user about these, but do not block their request):
  - This exceeds your budget of €500. Would you like to see cheaper options or proceed anyway?

LLM response (informed, not blocked):
  "I should let you know this is €1200, which exceeds your €500 budget.
   Would you like to proceed anyway, or shall I find cheaper alternatives?"

User: "Go ahead and book it"
  → LLM proceeds with booking (not blocked by WARN constraint)
```

**Use cases this solves**:

| Scenario                | Before (REQUIRE only)            | After (WARN available)                                |
| ----------------------- | -------------------------------- | ----------------------------------------------------- |
| Budget advisory         | Blocks booking entirely          | Warns user, allows them to proceed                    |
| Expiring promotions     | Can't express "promotion ending" | `WARN promo_expires_soon` → LLM mentions it naturally |
| Policy reminders        | Hard block or no check           | Soft warning injected into conversation               |
| Non-critical validation | Must use REQUIRE → too rigid     | WARN allows informational feedback                    |

#### Fix Details

**1. Parser** — `agent-based-parser.ts`:

- Regex updated: `- REQUIRE` → `- (REQUIRE|WARN)` matching
- Keyword captured: `match[1]` determines `severity`
- `ConstraintRequirement.severity`: `'warning'` for WARN, `'error'` for REQUIRE

**2. AST types** — `agent-based.ts`:

Added `severity?: 'error' | 'warning'` to `ConstraintRequirement`.

**3. Compiler** — `compiler.ts`:

- Passes `severity: 'warning'` to IR constraint when present
- Added `'WARN'` to `CONSTRAINT_KEYWORDS` set

**4. IR schema** — `schema.ts`:

Added `severity?: 'error' | 'warning'` to `Constraint` interface.

**5. Constraint executor** — `constraint-executor.ts`:

- `ConstraintCheckInfo` gains `severity?: 'error' | 'warning'`
- `checkConstraintsCore()`: Warning failures are reported via `onCheck` but do NOT set `firstFailure` — execution continues

```typescript
if (!passed && constraint.severity !== 'warning') {
  if (shortCircuit) return info;
  if (!firstFailure) firstFailure = info;
}
```

**6. Constraint checker** — `constraint-checker.ts`:

- Collects warnings separately from errors
- Emits `constraint_warning` trace event type (vs `constraint_check` for passing, `constraint_guard_skipped` for guarded)
- Stores warning messages on session: `session.data.values._constraint_warnings = warningMessages`
- Clears warnings when all constraints pass

**7. Prompt builder** — `prompt-builder.ts`:

Injects `_constraint_warnings` into system prompt (both supervisor and agent paths):

```typescript
const constraintWarnings = session.data.values._constraint_warnings;
if (Array.isArray(constraintWarnings) && constraintWarnings.length > 0) {
  parts.push('\n⚠️ ACTIVE WARNINGS (inform the user about these, but do not block their request):');
  for (const warning of constraintWarnings) {
    parts.push(`- ${warning}`);
  }
}
```

| What                | File                         | Change                                                          |
| ------------------- | ---------------------------- | --------------------------------------------------------------- |
| Parser              | `agent-based-parser.ts`      | `WARN` keyword matching, severity extraction                    |
| AST types           | `agent-based.ts`             | `severity?: 'error' \| 'warning'` on `ConstraintRequirement`    |
| Compiler            | `compiler.ts`                | Pass severity to IR, add WARN to keyword set                    |
| IR schema           | `schema.ts`                  | `severity` on `Constraint`                                      |
| Constraint executor | `constraint-executor.ts`     | Non-blocking handling for `severity: 'warning'`                 |
| Constraint checker  | `constraint-checker.ts`      | Warning collection, `constraint_warning` event, session storage |
| Prompt builder      | `prompt-builder.ts`          | `_constraint_warnings` injection into system prompt             |
| Tests               | `constraint-checker.test.ts` | Updated test for new onCheck callback signature                 |

---

### 4.8. Composite Object Memory + Type Coercion — **Completed**

**Files**: `memory-executor.ts`, `memory-executor.test.ts`

#### Current Behavior

**Two problems**:

**Problem 1 — REMEMBER STORE only supports simple paths**: The `STORE` value in REMEMBER triggers can only reference a single session variable path. To persist multiple related values, you need multiple REMEMBER rules — each requiring its own condition evaluation and FactStore write.

```yaml
MEMORY:
  remember:
    # Three separate rules for related data
    - WHEN: quote_created == true
      STORE: destination -> user.travel_preferences.destination
    - WHEN: quote_created == true
      STORE: num_travelers -> user.travel_preferences.travelers
    - WHEN: quote_created == true
      STORE: budget -> user.travel_preferences.budget
    # 3 condition evaluations, 3 FactStore writes, 3 RECALL loads next session
```

**Problem 2 — Type mismatch in comparisons**: When the LLM sets a boolean via `__set_context__`, it arrives as a string (`"true"`) because tool parameters are strings. JavaScript loose equality fails: `"true" == true` is `false`. REMEMBER triggers with boolean conditions silently don't fire.

```
LLM calls: __set_context__({ updates: { quote_created: "true" } })
session.data.values.quote_created = "true"   // string, not boolean

REMEMBER: WHEN quote_created == true
  → "true" == true  →  false (JS loose equality)  →  trigger doesn't fire
  → Facts not persisted. User preferences lost between sessions.
```

#### Updated Behavior

**Composite objects**: REMEMBER STORE supports `{key: path}` syntax to build structured objects from multiple session variables in a single rule.

```yaml
MEMORY:
  remember:
    # One rule, one FactStore write, one RECALL load
    - WHEN: quote_created == true
      STORE: {destination: destination, travelers: num_travelers, budget: budget} -> user.travel_preferences
      TTL: 90d
```

**What happens at runtime**:

```
session.data.values = { quote_created: true, destination: "Barcelona", num_travelers: 2, budget: 1500 }

resolveStoreValue("{destination: destination, travelers: num_travelers, budget: budget}", values):
  → Detects composite syntax (starts with '{', ends with '}')
  → Splits on ','
  → For each pair: key = trim(before ':'), valuePath = trim(after ':')
  → Resolves each valuePath via resolvePathValue()
  → Skips null/undefined values
  → Returns: { destination: "Barcelona", travelers: 2, budget: 1500 }

FactStore write:
  key: "user.travel_preferences"
  value: { destination: "Barcelona", travelers: 2, budget: 1500 }
  ttl: "90d"
```

**Type coercion**: New `coerceToType()` function handles string↔boolean and string↔number mismatches before comparison.

```
REMEMBER: WHEN quote_created == true

session.data.values.quote_created = "true"  (string from LLM)

coerceToType("true", true):
  → typeof "true" !== typeof true  (string vs boolean)
  → target is boolean, value is string
  → "true" → true

compareValues: coerceToType("true", true) == true  →  true == true  →  true
  → Trigger fires correctly!
```

**Use cases this solves**:

| Scenario                           | Before                                          | After                                                     |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Persist related data as object     | 3 separate REMEMBER rules + 3 FactStore writes  | 1 rule with composite `{key: path}` syntax                |
| Boolean condition with string      | `"true" == true` → false → trigger doesn't fire | `coerceToType("true", true)` → `true` → trigger fires     |
| Number condition with string       | `"2" == 2` works in JS (loose equality)         | Also handled by coerceToType for consistency              |
| Partial composite (missing fields) | N/A                                             | Undefined fields skipped, partial object persisted        |
| All fields missing                 | N/A                                             | Returns undefined → no FactStore write (no empty objects) |

#### Fix Details

**1. `resolveStoreValue()`** — `memory-executor.ts`:

New function that dispatches between simple path resolution and composite object construction:

```typescript
function resolveStoreValue(expr: string, values: Record<string, unknown>): unknown {
  const trimmed = expr.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    // Composite: parse {key: path, key: path}, resolve each, skip null/undefined
    const result: Record<string, unknown> = {};
    for (const pair of inner.split(',')) {
      const key = pair.slice(0, colonIdx).trim();
      const resolved = resolvePathValue(valuePath, values);
      if (resolved !== undefined && resolved !== null) result[key] = resolved;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return resolvePathValue(trimmed, values);
}
```

**2. `coerceToType()`** — `memory-executor.ts`:

```typescript
function coerceToType(value: unknown, target: unknown): unknown {
  if (typeof value === typeof target) return value;
  if (typeof target === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (typeof target === 'number' && typeof value === 'string') {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }
  return value;
}
```

Applied in `compareValues()` for `==` and `!=` operators: `coerceToType(left, right) == right`.

| What               | File                      | Change                                                      |
| ------------------ | ------------------------- | ----------------------------------------------------------- |
| Composite resolver | `memory-executor.ts`      | `resolveStoreValue()` — `{key: path}` syntax                |
| Type coercion      | `memory-executor.ts`      | `coerceToType()` — string↔boolean, string↔number            |
| Compare values     | `memory-executor.ts`      | Apply coercion in `compareValues()` for `==`/`!=`           |
| Tests              | `memory-executor.test.ts` | 7 new tests: string↔bool, string↔number, composite, partial |

---

### 4.9. Type-Aware Session Memory (TYPE/DESCRIPTION) — **Completed**

**Files**: `agent-based-parser.ts`, `compiler.ts`, `schema.ts`, `prompt-builder.ts`

#### Current Behavior

Session memory variables are declared with just a name. The `__set_context__` tool generates `{ type: 'string' }` for all parameters regardless of actual data type. The LLM has no schema guidance for what values to set.

```yaml
MEMORY:
  session:
    - quote_created # No type info — LLM might set "true" (string) or true (boolean)
    - num_travelers # No type info — LLM might set "2" (string) or 2 (number)
    - search_context # No type info — LLM doesn't know this is an object
```

```json
__set_context__ tool schema:
{
  "updates": {
    "type": "object",
    "properties": {
      "quote_created": { "type": "string" },    // Wrong — should be boolean
      "num_travelers": { "type": "string" },    // Wrong — should be number
      "search_context": { "type": "string" }    // Wrong — should be object
    }
  }
}
```

#### Updated Behavior

Session variables declare `TYPE` and `DESCRIPTION` in ABL. These flow through the parser → compiler → IR → prompt-builder to generate accurate JSON Schema for `__set_context__`.

```yaml
MEMORY:
  session:
    - quote_created
      TYPE: boolean
      DESCRIPTION: "Whether a quote has been successfully created in this session"
    - num_travelers
      TYPE: number
      DESCRIPTION: "Number of travelers in the booking"
    - search_context
      TYPE: object
      DESCRIPTION: "Travel search parameters including origin, destination, dates, and passengers"
```

```json
__set_context__ tool schema:
{
  "updates": {
    "type": "object",
    "properties": {
      "quote_created": { "type": "boolean", "description": "Whether a quote has been..." },
      "num_travelers": { "type": "number", "description": "Number of travelers..." },
      "search_context": { "type": "object", "description": "Travel search parameters..." }
    }
  }
}
```

**What changes in LLM behavior**:

```
Before (all string types):
  LLM calls __set_context__({ updates: { quote_created: "true" } })  // string
  → REMEMBER: WHEN quote_created == true  → "true" == true → false (without coercion)

After (typed schemas):
  LLM calls __set_context__({ updates: { quote_created: true } })    // boolean
  → REMEMBER: WHEN quote_created == true  → true == true → true
```

**Use cases this solves**:

| Scenario             | Before                         | After                                                |
| -------------------- | ------------------------------ | ---------------------------------------------------- |
| Boolean session vars | LLM sends `"true"` (string)    | Schema says `boolean` → LLM sends `true`             |
| Numeric session vars | LLM sends `"2"` (string)       | Schema says `number` → LLM sends `2`                 |
| Object session vars  | LLM tries to stringify objects | Schema says `object` → LLM sends proper JSON objects |
| LLM guidance         | No description of what to set  | Description tells LLM what the variable means        |

#### Fix Details

**1. Parser** — `agent-based-parser.ts`:

Already parses `TYPE:` and `DESCRIPTION:` within session variable blocks (implemented in prior lifecycle work). These now flow through the full pipeline.

**2. IR schema** — `schema.ts`:

Added `type?: string` to `SessionMemory` interface.

**3. Compiler** — `compiler.ts`:

Passes `type: s.type` through to compiled `SessionMemory` in `compileMemory()`.

**4. Prompt builder** — `prompt-builder.ts`:

The `__set_context__` tool schema now reads `type` and `description` from session vars:

```typescript
const sessionVars = ir?.memory?.session?.map((s) =>
  typeof s === 'string' ? { name: s } : s
).filter((s) => s.name) ?? [];

// In tool schema generation:
properties: Object.fromEntries(
  sessionVars.map((s) => [s.name, ablTypeToJsonSchema(s.type || 'string', s.description)])
),
```

`ablTypeToJsonSchema()` maps ABL types (`boolean`, `number`, `object`, `array`, `datetime`, etc.) to proper JSON Schema types.

| What           | File                    | Change                                                   |
| -------------- | ----------------------- | -------------------------------------------------------- |
| IR schema      | `schema.ts`             | `type?: string` on `SessionMemory`                       |
| Compiler       | `compiler.ts`           | Pass `type` through to IR                                |
| Prompt builder | `prompt-builder.ts`     | Use `ablTypeToJsonSchema(s.type, s.description)` per var |
| Example ABL    | `supervisor.agent.abl`  | 15 typed session vars with TYPE/DESCRIPTION              |
| Example ABL    | `sales_agent.agent.abl` | `quote_created` with `TYPE: boolean`                     |

---

### 4.10. Settings Versioning & Deployment Pinning — **Completed**

**Files**: `project-settings.model.ts`, `project-settings-version.model.ts`, `deployment.model.ts`, `deployment-repo.ts`, `deployments.ts`, `deployment-resolver.ts`, `cascade-delete.ts`, `seed-mongo.ts`

#### Current Behavior

Project settings (like `enableThinking`) are stored as a single mutable document. Changing settings affects all deployments immediately — no way to version, test, or rollback.

```
ProjectLLMConfig: { enableThinking: true }
  → Deployment A reads current value → true
  → Admin changes to false
  → Deployment A reads current value → false ← CHANGED WITHOUT DEPLOY
```

#### Updated Behavior

Two-tier model: **working copy** (editable) and **immutable snapshots** (deployable).

```
ProjectSettings (working copy):
  { projectId: "p1", enableThinking: true, thinkingBudget: 10000 }

ProjectSettingsVersion (immutable snapshots):
  v1: { status: "active", settings: { enableThinking: false, thinkingBudget: null } }
  v2: { status: "staged", settings: { enableThinking: true, thinkingBudget: 10000 } }
  v3: { status: "draft",  settings: { enableThinking: true, thinkingBudget: 8000 } }

Status lifecycle: draft → testing → staged → active
  Only one version per project can be 'active' at a time

Deployment:
  { settingsVersionId: "v1" }
  → Pinned to v1 settings regardless of working copy changes
  → New deployment can pin to v2 or v3
```

**Resolution in model-resolution** (`findProjectEnableThinking`):

```
① If deployment has settingsVersionId → use that specific version
② Else if project has an 'active' version → use active version
③ Else → fall back to ProjectSettings working copy
```

**Use cases this solves**:

| Scenario                     | Before                         | After                                      |
| ---------------------------- | ------------------------------ | ------------------------------------------ |
| Safe testing of new settings | Changes affect production live | Pin staging deploy to `testing` version    |
| Rollback                     | No history of past settings    | Reactivate a previous version              |
| Multiple environments        | All share one mutable document | Each deployment pins its own version       |
| Project cleanup              | Settings orphaned on delete    | Cascade delete removes versions + settings |

#### Fix Details

| What                | File                                | Change                                                                |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| DB model            | `project-settings.model.ts`         | Working copy: `enableThinking`, `thinkingBudget`                      |
| DB model            | `project-settings-version.model.ts` | Immutable snapshot with `status` lifecycle + `settings` embed         |
| Deployment model    | `deployment.model.ts`               | `settingsVersionId: String \| null`                                   |
| Deployment repo     | `deployment-repo.ts`                | Accept + store `settingsVersionId`                                    |
| Deployment routes   | `deployments.ts`                    | Validate + propagate `settingsVersionId` in create endpoint           |
| Deployment resolver | `deployment-resolver.ts`            | Pass `settingsVersionId` to `ResolvedAgent`                           |
| Cascade delete      | `cascade-delete.ts`                 | Delete `ProjectSettingsVersion` + `ProjectSettings` on project delete |
| Model exports       | `models/index.ts`                   | Export new models and types                                           |
| Seed data           | `seed-mongo.ts`                     | Seed `ProjectLLMConfig` + `ProjectSettings` for test project          |

---

## 5. LOW Changes

### 5.1. Project-Scoped (Shared) Facts — **Completed**

Implemented as part of 4.2 (Unified 3-Scope Memory + Tool Context Access). See section 4.2 for full implementation details.

**Summary**: `scope: 'user' | 'project'` on persistent memory declarations and Fact model. `createProjectFactStore()` factory with `PROJECT_SCOPE_USER_ID` sentinel. Memory integration splits load/write by scope.

---

### 5.2. Session Memory Declaration Validation — **Completed**

**Files**: `compiler/ir/compiler.ts`

#### Current Behavior

Variables declared in `MEMORY.session` are never validated against population sources. Dead declarations pass silently.

#### Updated Behavior

Compiler warning for session variables with no population source (GATHER, TOOLS, SET, HANDOFF).

```
⚠ WARNING: Session variable "search_expires_at" has no population source.
  Not populated by: GATHER fields, tool result mapping, SET assignments, or HANDOFF context.
```

#### Fix Details

| What                | File                      | Change                                                           |
| ------------------- | ------------------------- | ---------------------------------------------------------------- |
| Population analysis | `compiler/ir/compiler.ts` | Collect all value-writing paths, warn for unmatched session vars |

---

### 5.3. Externalize Arch Prompts — Studio Prompt Catalog — **Completed**

**Files**: `apps/studio/src/app/api/arch/chat/route.ts`, `apps/studio/src/lib/arch-prompts.ts` (new)

#### Current Behavior

Arch (the Studio AI copilot) has its own `buildSystemPrompt()` function with inline template strings in `arch/chat/route.ts`. These prompts are hardcoded and not overridable — unlike the runtime's `PromptCatalog` which supports DB overrides via `PromptTemplateLoader`.

The Arch prompts serve a different purpose than runtime prompts (developer workflows vs end-user conversations), but they share the same problem: inline strings that can't be customized without code changes.

#### Proposed Behavior

Create a Studio-side prompt catalog (`arch-prompts.ts`) that:

- Centralizes all Arch system prompts (ideate, design, build, test, deploy, edit stages)
- Supports DB override via a `StudioPromptTemplate` collection (same pattern as runtime's `PromptTemplateLoader`)
- Allows project-level customization of Arch behavior (e.g., custom instructions for how Arch should generate ABL)
- Uses the same `renderTemplate()` engine for `{{#if}}` / `{{variable}}` placeholders

Currently Arch prompts live in:

- `apps/studio/src/app/api/arch/chat/route.ts` — `buildSystemPrompt()` (~200 lines of inline templates)
- `apps/studio/src/app/api/arch/generate/route.ts` — generator-specific prompts
- `apps/studio/src/lib/arch-workflows.ts` — workflow stage prompts

| What           | File                                                                          | Change                                                                               |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Prompt catalog | `apps/studio/src/lib/arch-prompts.ts` (new)                                   | Centralize all Arch stage prompts with template variables                            |
| DB override    | `StudioPromptTemplate` model or reuse `PromptTemplate` with `scope: 'studio'` | DB-backed overrides for Arch prompts                                                 |
| Route cleanup  | `arch/chat/route.ts`                                                          | Replace inline `buildSystemPrompt()` with catalog lookup                             |
| Studio UI      | Settings page                                                                 | UI for editing Arch prompt overrides (similar to Advanced Settings prompt overrides) |

---

## 6. Implementation Order & Dependencies

```
Phase 1 — Quick Wins (no dependencies)                                 ✅ ALL COMPLETED
  ├── 2.1  Fix RECALL ON_START (parser only, small)                    ✅ COMPLETED
  ├── 4.4  Dynamic IDENTITY interpolation (3 lines, small)             ✅ COMPLETED
  ├── 4.6  LLM context setting — __set_context__ tool (small, no deps) ✅ COMPLETED
  └── 4.3  FactStore batch queries (MongoDB only, small)               ✅ COMPLETED

Phase 2 — Core Engine                                                   ✅ ALL COMPLETED
  ├── 2.2  Structured entity extraction                                ✅ COMPLETED
  └── 2.3  Post-tool variable mapping + constraints                    ✅ COMPLETED

Phase 3 — Lifecycle Events + Tool Schemas                               ✅ ALL COMPLETED
  ├── 3.3  Declarative lifecycle events (foundation)                   ✅ COMPLETED
  ├── 3.2  Structured system tool schemas                              ✅ COMPLETED
  └── 4.1  Compiler event validation                                   ✅ COMPLETED

Phase 4 — Enable Thinking + Constraints + Memory                        ✅ ALL COMPLETED
  ├── 3.6  Enable Thinking — project + agent resolution chain          ✅ COMPLETED
  │         4-level resolution: Agent ABL → Agent DB → Project DB → false
  │         Settings versioning + deployment pinning
  │
  ├── 3.7  Tool thought extraction + chat UI display                   ✅ COMPLETED
  │         Strip thought/reason from regular tools, emit tool_thought
  │         Purple collapsible ThoughtItem in chat, auto-expand/collapse
  │
  ├── 4.7  Non-blocking warning constraints (WARN)                     ✅ COMPLETED
  │         WARN keyword, severity on constraints, warning injection
  │
  ├── 4.8  Composite object memory + type coercion                     ✅ COMPLETED
  │         {key: path} syntax in REMEMBER, coerceToType()
  │
  ├── 4.9  Type-aware session memory (TYPE/DESCRIPTION)                ✅ COMPLETED
  │         Typed __set_context__ tool schema via ablTypeToJsonSchema
  │
  └── 4.10 Settings versioning & deployment pinning                    ✅ COMPLETED
            ProjectSettings + ProjectSettingsVersion models

Phase 5 — Fan-Out + Debug Improvements                                 ✅ ALL COMPLETED
  ├── 3.8  Handoff/delegate `message` parameter                        ✅ COMPLETED
  │         Required `message` field on __handoff__ + __delegate__
  │         Parallel→fan_out uses per-target message as intent
  │
  └── 3.9  LLM call options + message thread in debug UI               ✅ COMPLETED
            disableParallelToolUse/toolChoice in trace events + UI
            Full conversation thread (tool_use + tool_result) in LLM tab
            allowParallelToolCalls feature flag in config system

Phase 6 — Template System                                              ✅ COMPLETED
  └── 3.1  Externalize prompts                                         ✅ COMPLETED
            PromptCatalog + template engine + PromptTemplateLoader
            DB model (PromptTemplate) + seed script + tests

Phase 7 — Architecture + Fan-Out
  ├── 3.4  Durable session persistence (independent, large)            Pending
  │
  ├── 3.5  Parallel fan-out execution                                  ✅ COMPLETED
  │         Mixed agent+tool targets, Promise.allSettled, semaphore
  │         ExecutionPlan/ExecutionUnit types, InProcessExecutionRuntime
  │         Fan-out trace events, child session isolation, bug fix regressions
  │
  ├── 4.2  Tool context access + imperative memory API                  ✅ COMPLETED
  │         Unified 3-scope memory (session/user/project)
  │         Declarative CONTEXT_ACCESS (HTTP) + imperative get/set/delete (sandbox)
  │         ToolMemoryBridge, project FactStore, scope auto-resolution
  │
  ├── 4.5  LLM preference detection (independent)                     Pending
  └── 5.1  Project-scoped facts (merged into 4.2)                      ✅ COMPLETED

Phase 8 — Validation & Studio DX
  ├── 5.2  Session memory declaration validation                       ✅ COMPLETED
  └── 5.3  Externalize Arch prompts — Studio prompt catalog            ✅ COMPLETED
            PromptCatalog.arch (shared, chat, workflow, generate)
            Studio routes use renderTemplate() with catalog prompts
            Arch system prompts centralized + DB-overridable
```

---

## 7. Related Design Documents

| Document                                                                  | Description                                                                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/gvisor-sandbox.md`](./gvisor-sandbox.md)                           | gVisor sandbox — Docker image architecture, Helm deployment, memory API bridge, security model (NetworkPolicy + nginx sidecar + JWT), and Harness CI integration. |
| [`docs/SANDBOX_RUNNER_ARCHITECTURE.md`](./SANDBOX_RUNNER_ARCHITECTURE.md) | Sandbox runner architecture — `GvisorSandboxRunner`, `LambdaSandboxRunner`, factory pattern, and security model.                                                  |
