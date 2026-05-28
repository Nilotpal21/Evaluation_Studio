# ABL Memory System

## Overview

All runtime state lives in a single map: `session.data.values` (`Record<string, unknown>`).
This map is injected into the LLM system prompt under `## Current Context` by `prompt-builder.ts`.

---

## MEMORY DSL Sections

| Section       | Purpose                                                                     | DB Involvement                                           |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `session:`    | Declare in-memory variable names + optional initial values                  | None — dies when session ends                            |
| `persistent:` | Declare FactStore keys this agent uses (path, type, access, default)        | **Read** at session start via `loadPersistentDefaults()` |
| `remember:`   | Conditional write rules — store values to FactStore when conditions are met | **Write** after every state change                       |
| `recall:`     | Event-triggered read rules — load values from FactStore on specific events  | **Read** on detected events                              |

### Universal Example — Hotel Booking Agent

This example covers every MEMORY feature with comments explaining the use case.

```
AGENT: Hotel_Booking_Agent
MODE: reasoning

TOOLS:
  - search_hotels          # prefix "search_" → triggers "search_initiated" event
  - book_hotel             # prefix "book_"   → triggers "booking_started" event
  - cancel_booking         # prefix "cancel_" → triggers "cancellation_initiated" event
  - check_loyalty_status   # no matching prefix → no RECALL event triggered
  - update_preferences     # prefix "update_" → triggers "modification_initiated" event

GATHER:
  - destination            # extraction → triggers "destination_mention" event
  - check_in_date
  - check_out_date
  - num_guests
  - budget_range
  - room_type

MEMORY:

  # ─────────────────────────────────────────────────────────────
  # SESSION: In-memory variables — die when session ends
  # Populated by: GATHER extraction, tool results, SET, HANDOFF
  # ─────────────────────────────────────────────────────────────
  session:

    - search_results             # Populated by: last_search_hotels_result (tool result)
                                 # Use case: hold search results so LLM can reference them
                                 # in follow-up ("show me the 3rd option")

    - selected_hotel             # Populated by: LLM reasoning (implicit in reasoning mode)
                                 # Use case: track which hotel user picked from results

    - booking_confirmation_id    # Populated by: last_book_hotel_result (tool result)
                                 # Use case: reference booking ID in conversation

    - attempt_count              # Populated by: nobody — dead declaration (GAP-4 example)
      INITIAL: 0                 # Use case: was intended to count retries, never wired up
      RESET: per_session         # RESET: per_session = back to 0 on new session

    - step_notes                 # Populated by: SET assignment in flow mode
      RESET: per_step            # RESET: per_step = cleared every time flow step changes
                                 # Use case: scratch pad that doesn't carry over between steps

  # ─────────────────────────────────────────────────────────────
  # PERSISTENT: Schema declarations for FactStore keys
  # - Loaded at session start via loadPersistentDefaults()
  # - Enforces ACCESS control on REMEMBER writes
  # - Enforces TYPE validation on REMEMBER writes
  # - Provides DEFAULT_VALUE fallback when key not in DB
  # ─────────────────────────────────────────────────────────────
  persistent:

    - user.preferred_chains      # Written by: this agent's REMEMBER (below)
      ACCESS: readwrite          # ← REMEMBER can write, persistent can read
      TYPE: array                # ← REMEMBER value must be array, else blocked
      DEFAULT_VALUE: []          # ← if not in DB, session gets empty array

    - user.room_preferences      # Written by: this agent's REMEMBER (below)
      ACCESS: readwrite
      TYPE: object
      DEFAULT_VALUE: {}

    - user.loyalty_tier          # Written by: external system (Loyalty_Agent or API)
      ACCESS: read               # ← READ-ONLY: this agent's REMEMBER CANNOT overwrite
      TYPE: string               # ← protects externally-managed data from accidental writes
      DEFAULT_VALUE: "standard"

    - user.lifetime_bookings     # Written by: Analytics_Agent's REMEMBER
      ACCESS: read               # ← READ-ONLY: cross-agent data, don't touch
      TYPE: number
      DEFAULT_VALUE: 0

    - user.blacklisted_hotels    # Written by: Support_Agent's REMEMBER
      ACCESS: read               # ← READ-ONLY: safety data, never overwrite
      TYPE: array
      DEFAULT_VALUE: []

  # ─────────────────────────────────────────────────────────────
  # REMEMBER: Write rules — store to FactStore when conditions met
  # - Evaluated after every state change (extraction, tool result, SET)
  # - Respects persistent ACCESS control (read-only paths blocked)
  # - Respects persistent TYPE validation (mismatched types blocked)
  # - Writes are scoped to (tenantId, userId, projectId)
  # - Data available to ANY agent in ANY future session
  # ─────────────────────────────────────────────────────────────
  remember:

    # Use case: remember which hotel chains the user likes
    # Trigger: after GATHER extracts destination + user mentions a chain
    - WHEN preferred_chain IS SET
      STORE: preferred_chain -> user.preferred_chains
      TTL: 365d
    # Writes to user.preferred_chains (ACCESS: readwrite, TYPE: array) ✓

    # Use case: remember room preferences for personalization
    # Trigger: after booking completes and room details are known
    - WHEN booking_confirmation_id IS SET
      STORE: {room_type: room_type, floor: preferred_floor} -> user.room_preferences
      TTL: 180d
    # Writes to user.room_preferences (ACCESS: readwrite, TYPE: object) ✓

    # Use case: would try to overwrite loyalty tier — but BLOCKED
    # This demonstrates ACCESS: read protection
    - WHEN some_condition == true
      STORE: "gold" -> user.loyalty_tier
      TTL: 90d
    # BLOCKED at runtime — user.loyalty_tier has ACCESS: read
    # memory-integration.ts:240 logs "REMEMBER skipped: path is readonly"

  # ─────────────────────────────────────────────────────────────
  # RECALL: Read rules — load from FactStore on specific events
  # - 3 action types: inject_context, load_memory, prompt_llm
  # - Events are derived from tool name prefixes (event-detector.ts)
  #   and entity extraction ({field}_mention)
  # - Results injected into session.data.values
  # ─────────────────────────────────────────────────────────────
  recall:

    # ── inject_context: load specific keys by exact path ──
    # Use case: at session start, load user's chain preferences and blacklist
    # so LLM knows which hotels to recommend/avoid from the first message
    - ON: session_start
      ACTION: inject_context
      PATHS: [user.preferred_chains, user.blacklisted_hotels]
    # DB call: factStore.get({ key: "user.preferred_chains" })
    #          factStore.get({ key: "user.blacklisted_hotels" })
    # Result: session.data.values["user.preferred_chains"] = ["Marriott", "Hilton"]
    #         session.data.values["user.blacklisted_hotels"] = ["BadHotel123"]

    # ── load_memory: load ALL keys under a domain prefix ──
    # Use case: when user searches, load ALL their travel preferences
    # (we don't know every key upfront — there could be preferences.travel.airlines,
    #  preferences.travel.meal_type, preferences.travel.seat_class, etc.)
    - ON: search_initiated
      ACTION: load_memory
      DOMAIN: travel
    # DB call: factStore.query({ prefix: "preferences.travel" })
    # Result: loads ALL keys like preferences.travel.* into session.data.values
    # Triggered when: LLM calls search_hotels (tool starts with "search_")

    # ── prompt_llm: no DB read, just inject instruction text ──
    # Use case: remind LLM to check loyalty status before confirming booking
    # This is a hint, not data — the LLM decides what to do with it
    - ON: booking_started
      ACTION: prompt_llm
      INSTRUCTION: "Verify user's loyalty tier and apply any applicable discounts before confirming"
    # DB call: NONE
    # Result: instruction stored in session.data.values["_recallPrompts"]
    # Triggered when: LLM calls book_hotel (tool starts with "book_")

    # ── inject_context on entity extraction event ──
    # Use case: when user mentions a destination, load their history for that area
    - ON: destination_mention
      ACTION: inject_context
      PATHS: [user.room_preferences, user.lifetime_bookings]
    # Triggered when: GATHER extracts "destination" field from user message
    # Loads room preferences so LLM can suggest same room type as last time
```

### What happens at runtime (timeline)

```
SESSION CREATED
  │
  ├─ persistent: loads 5 keys from FactStore (or defaults)
  │   → user.preferred_chains = ["Marriott"]     (from DB)
  │   → user.room_preferences = {}               (DEFAULT_VALUE, not in DB yet)
  │   → user.loyalty_tier = "gold"               (from DB, written by Loyalty_Agent)
  │   → user.lifetime_bookings = 12              (from DB, written by Analytics_Agent)
  │   → user.blacklisted_hotels = ["BadHotel"]   (from DB, written by Support_Agent)
  │
  ├─ recall ON: session_start (inject_context)
  │   → user.preferred_chains = ["Marriott"]     (same key, redundant with persistent)
  │   → user.blacklisted_hotels = ["BadHotel"]   (same key, redundant with persistent)
  │
  ├─ session: initializes variables
  │   → attempt_count = 0                        (INITIAL value)
  │   → search_results = undefined               (no initial)
  │   → selected_hotel = undefined
  │
  USER: "I want a hotel in Paris for 2 nights"
  │
  ├─ GATHER extracts: destination="Paris", num_guests=1, check_in_date=...
  │   → destination_mention event fires
  │   → recall ON: destination_mention (inject_context)
  │     → user.room_preferences = {room_type: "king", floor: "high"}
  │     → user.lifetime_bookings = 12
  │
  ├─ REMEMBER evaluates (after extraction):
  │   → preferred_chain IS SET? No → skip
  │   → booking_confirmation_id IS SET? No → skip
  │
  ├─ LLM calls search_hotels(destination="Paris", ...)
  │   → search_initiated event fires
  │   → recall ON: search_initiated (load_memory)
  │     → loads preferences.travel.* from FactStore
  │   → session.data.values["last_search_hotels_result"] = [{...}, {...}]
  │
  USER: "Book the Marriott option"
  │
  ├─ LLM calls book_hotel(hotel_id="marriott-paris-123", ...)
  │   → booking_started event fires
  │   → recall ON: booking_started (prompt_llm)
  │     → _recallPrompts = ["Verify user's loyalty tier and apply discounts..."]
  │   → session.data.values["last_book_hotel_result"] = { confirmation_id: "BK-789" }
  │   → session.data.values["booking_confirmation_id"] = "BK-789"
  │
  ├─ REMEMBER evaluates (after tool result):
  │   → preferred_chain IS SET? Yes → STORE "Marriott" -> user.preferred_chains (TTL 365d) ✓
  │   → booking_confirmation_id IS SET? Yes → STORE {room_type, floor} -> user.room_preferences (TTL 180d) ✓
  │   → some_condition == true? → STORE "gold" -> user.loyalty_tier → BLOCKED (ACCESS: read)
  │
  SESSION ENDS
  │
  └─ session vars die: search_results, selected_hotel, booking_confirmation_id, attempt_count
     persistent facts survive: user.preferred_chains, user.room_preferences (updated)
     user.loyalty_tier, user.lifetime_bookings, user.blacklisted_hotels (unchanged)
```

---

## RECALL Syntax: `ON_START:` vs `ON:`

There are **two different `ON_START` concepts** in ABL:

### 1. Top-level `ON_START:` (lifecycle handler — NOT memory)

```
ON_START:
  respond: "Welcome! How can I help?"
  call: check_returning_user
  set: session_initialized = true
```

This is a **lifecycle hook** parsed as a top-level section. It runs respond/call/set actions when the session first begins. Executed by `flow-step-executor.ts:executeOnStart()`. **Not related to memory.**

### 2. `ON_START:` inside RECALL (legacy shorthand — BROKEN)

```
MEMORY:
  recall:
    - ON_START: "Check if user has travel preferences"
```

Parsed by `parseRecallInstruction()` (`agent-based-parser.ts:2531`) into:

- `event: "ON_START"`, `instruction: "Check if..."`, `action: undefined`

**This does NOT work at runtime** for two reasons:

1. **Event mismatch**: Runtime fires `"session_start"` but the stored event is `"ON_START"` — `detectedEvents.includes("ON_START")` is always false
2. **No action**: Even if events matched, `action` is `undefined`, so `executeRecallInstructions()` hits the legacy fallback and skips it

### 3. `ON:` inside RECALL (new format — WORKS)

```
MEMORY:
  recall:
    - ON: session_start
      ACTION: inject_context
      PATHS: [user.preferred_destinations, user.travel_preferences]
```

Uses `ON:` keyword, event string `session_start` matches the runtime, and has an explicit action type.

### Comparison

| Syntax                            | Event stored      | Matches runtime? | Has action?    | Works?  |
| --------------------------------- | ----------------- | ---------------- | -------------- | ------- |
| `- ON_START: "text"`              | `"ON_START"`      | No               | No (undefined) | **No**  |
| `- ON: session_start` + `ACTION:` | `"session_start"` | Yes              | Yes            | **Yes** |

### All Legacy `ON_` Shorthands vs Working `ON:` Events

The parser accepts **any** `ON_\w+` pattern (wildcard regex: `agent-based-parser.ts:2533`).
The runtime only fires specific event strings (`event-detector.ts`). They never match because
the legacy parser stores `"ON_START"` but the runtime fires `"session_start"`.

| Runtime Event            | When it fires                            | Legacy shorthand (**broken**) | Working `ON:` syntax         |
| ------------------------ | ---------------------------------------- | ----------------------------- | ---------------------------- |
| `session_start`          | Session created                          | `ON_START:`                   | `ON: session_start`          |
| `session_end`            | Session ended                            | `ON_END:`                     | `ON: session_end`            |
| `search_initiated`       | Tool with `search_*` prefix              | `ON_SEARCH:`                  | `ON: search_initiated`       |
| `booking_started`        | Tool with `book_*` / `reserve_*` prefix  | `ON_BOOKING:`                 | `ON: booking_started`        |
| `payment_initiated`      | Tool with `pay_*` / `charge_*` prefix    | `ON_PAYMENT:`                 | `ON: payment_initiated`      |
| `cancellation_initiated` | Tool with `cancel_*` prefix              | `ON_CANCELLATION:`            | `ON: cancellation_initiated` |
| `modification_initiated` | Tool with `update_*` / `modify_*` prefix | `ON_MODIFICATION:`            | `ON: modification_initiated` |
| `{field}_mention`        | Entity extracted (e.g., `destination`)   | `ON_DESTINATION:`             | `ON: destination_mention`    |
| `step_enter_{name}`      | Flow step entered                        | —                             | `ON: step_enter_checkout`    |

> **Note**: Every example DSL in the repo uses the legacy `ON_START:` shorthand.
> None use the working `ON:` format. All RECALL rules in example agents are dead code.

### Code References

| What                          | File                    | Line                                               |
| ----------------------------- | ----------------------- | -------------------------------------------------- |
| Top-level ON_START parser     | `agent-based-parser.ts` | :275 (`parseOnStart`)                              |
| Top-level ON_START executor   | `flow-step-executor.ts` | :411 (`executeOnStart()`)                          |
| Legacy RECALL ON_START parser | `agent-based-parser.ts` | :2531 (`parseRecallInstruction`)                   |
| New RECALL ON: parser         | `agent-based-parser.ts` | :2410                                              |
| Runtime event firing          | `memory-integration.ts` | :90 (`['session_start']`)                          |
| Event detector                | `event-detector.ts`     | Full file — all runtime events defined here        |
| Event matching                | `memory-executor.ts`    | :87 (`detectedEvents.includes(instruction.event)`) |

---

## FactStore

The persistent storage backend for REMEMBER/RECALL. Scoped to three dimensions:

```
(tenantId, userId, projectId)
```

Every query includes all three via `ownerFilter()`. No cross-tenant, cross-user, or cross-project access is possible.

**Implementation**: `apps/runtime/src/services/stores/mongodb-fact-store.ts` (`MongoDBFactStore`)

**Created at**: `runtime-executor.ts:402` during session creation:

```typescript
session.factStore = createMongoDBFactStore(tenantId, userId, projectId);
```

**Facts are stored as JSON strings** in MongoDB — `JSON.stringify()` on write, `JSON.parse()` on read.

**Default TTL**: 90 days (GDPR compliance). Max value size: 10KB.

---

## Persistent vs RECALL with `ON: session_start`

Both load from FactStore at session start and write to `session.data.values`. They run **in parallel** (`Promise.all` at `memory-integration.ts:85`). But they serve different purposes.

### Comparison

|                        | `persistent:`                           | `recall: ON: session_start`                              |
| ---------------------- | --------------------------------------- | -------------------------------------------------------- |
| **Purpose**            | Schema declaration + auto-load          | Flexible event-driven read                               |
| **What you declare**   | Key paths + TYPE, ACCESS, DEFAULT_VALUE | An event + an action type                                |
| **How it reads**       | `query({})` — all facts, match by path  | Depends on action: by key, by prefix, or no DB           |
| **Fallback**           | Uses `DEFAULT_VALUE` if key not in DB   | No fallback                                              |
| **Access control**     | `ACCESS: read` blocks REMEMBER writes   | No access control                                        |
| **Type validation**    | `TYPE:` enforced on REMEMBER writes     | No type checking                                         |
| **Action flexibility** | Always loads by exact key match         | 3 options: `inject_context`, `load_memory`, `prompt_llm` |
| **When it fires**      | Session start only                      | Session start + any other event                          |

### Example: `persistent:` with schema enforcement

```
MEMORY:
  persistent:
    - user.preferred_destinations
      ACCESS: readwrite              # REMEMBER can write to this key
      TYPE: array                    # REMEMBER value must be an array
      DEFAULT_VALUE: []              # if not in DB, session gets empty array

    - user.credit_score
      ACCESS: read                   # REMEMBER is BLOCKED from writing to this key
      TYPE: number                   # read-only data from another system
      DEFAULT_VALUE: 0

    - user.travel_preferences
      ACCESS: write                  # write-only, not loaded at start
      TYPE: object

  remember:
    - WHEN destination IS SET
      STORE: destination -> user.preferred_destinations
      TTL: 365d
    # This write succeeds — ACCESS is readwrite, TYPE is array ✓

    - WHEN budget_range IS SET
      STORE: budget_range -> user.credit_score
      TTL: 30d
    # This write is BLOCKED — ACCESS is read (line 240-247 in memory-integration.ts)
```

At session start, `loadPersistentDefaults()` runs:

1. Loads all facts from FactStore for this user
2. `user.preferred_destinations` found in DB → `session.data.values["user.preferred_destinations"] = ["Paris", "Tokyo"]`
3. `user.credit_score` found in DB → `session.data.values["user.credit_score"] = 750`
4. `user.travel_preferences` — ACCESS is `write`, not loaded (write-only)

Later, when REMEMBER triggers fire:

- Write to `user.preferred_destinations` → allowed (ACCESS: readwrite), type checked (must be array)
- Write to `user.credit_score` → **blocked** (ACCESS: read), logged as `remember_blocked`

### Example: `recall:` with different action types

```
MEMORY:
  recall:
    # inject_context — load 2 specific keys at session start
    - ON: session_start
      ACTION: inject_context
      PATHS: [user.preferred_destinations, user.travel_preferences]

    # load_memory — load ALL travel preferences when user searches
    - ON: search_initiated
      ACTION: load_memory
      DOMAIN: travel
    # Loads: preferences.travel.airlines, preferences.travel.seat_class, etc.

    # prompt_llm — just tell the LLM to consider something (no DB read)
    - ON: booking_started
      ACTION: prompt_llm
      INSTRUCTION: "Check user's loyalty status before confirming booking"
```

Key differences from `persistent:`:

- `inject_context` loads **only** the 2 listed paths (targeted `get()` calls), not all facts
- `load_memory` loads by **prefix** — you don't need to know every key, just the domain
- `prompt_llm` doesn't read DB at all — just injects text into LLM context
- `search_initiated` and `booking_started` fire **mid-session** on tool calls, not just at start
- No schema enforcement — no ACCESS check, no TYPE validation, no DEFAULT_VALUE fallback

### When to use which

| Use case                                                    | Use                                            |
| ----------------------------------------------------------- | ---------------------------------------------- |
| "I need these keys at start, with defaults and type safety" | `persistent:`                                  |
| "Load specific keys at start" (no schema needed)            | `recall: ON: session_start` + `inject_context` |
| "Load a whole category of preferences when user searches"   | `recall: ON: search_initiated` + `load_memory` |
| "Remind the LLM about something when booking starts"        | `recall: ON: booking_started` + `prompt_llm`   |
| "Protect a key from being overwritten"                      | `persistent:` with `ACCESS: read`              |

They're **complementary**, not redundant. Use `persistent:` to declare and protect your keys. Use `recall:` to load additional data on specific events.

---

## RECALL Action Types

| Action           | DSL Syntax                                       | What it does                                       | DB Call                           |
| ---------------- | ------------------------------------------------ | -------------------------------------------------- | --------------------------------- |
| `inject_context` | `ACTION: inject_context` + `PATHS: [key1, key2]` | Load specific fact keys by path                    | `factStore.get({ key })` per path |
| `load_memory`    | `ACTION: load_memory` + `DOMAIN: travel`         | Load all facts under prefix `preferences.<domain>` | `factStore.query({ prefix })`     |
| `prompt_llm`     | `ON_START: "instruction text"`                   | Pass instruction string to LLM context             | No DB call — text hint only       |

---

## RECALL Events

Events are derived by naming convention from tool names and field names.

| Event                    | Triggered When                                                |
| ------------------------ | ------------------------------------------------------------- |
| `session_start`          | Session created                                               |
| `session_end`            | Session ended                                                 |
| `search_initiated`       | Tool called with `search_*` prefix                            |
| `booking_started`        | Tool called with `book_*` or `reserve_*` prefix               |
| `payment_initiated`      | Tool called with `pay_*` or `charge_*` prefix                 |
| `modification_initiated` | Tool called with `update_*`, `modify_*`, or `change_*` prefix |
| `{field}_mention`        | Entity extracted (e.g., `destination_mention`)                |
| `step_enter_{stepName}`  | Flow step entered                                             |

**Source**: `apps/runtime/src/services/execution/event-detector.ts`

---

## All Ways `session.data.values` Gets Updated

### Memory System

| #   | Source                         | File                    | Function : Line                         | What it writes                        |
| --- | ------------------------------ | ----------------------- | --------------------------------------- | ------------------------------------- |
| 1   | Session var init               | `memory-integration.ts` | `initializeAllMemory()` :73             | `values[name] = initial_value`        |
| 2   | Persistent defaults (from DB)  | `memory-integration.ts` | `loadPersistentDefaults()` :145         | `values[path] = fact.value`           |
| 3   | Persistent defaults (fallback) | `memory-integration.ts` | `loadPersistentDefaults()` :132,147,155 | `values[path] = default_value`        |
| 4   | RECALL injection               | `memory-integration.ts` | `executeRecallForEvents()` :341         | `Object.assign(values, injectedData)` |

### Extraction (GATHER)

| #   | Source                  | File                    | Function : Line                         | What it writes                               |
| --- | ----------------------- | ----------------------- | --------------------------------------- | -------------------------------------------- |
| 5   | GATHER (reasoning mode) | `reasoning-executor.ts` | `executeMessage()` :192                 | `setGatheredValues(session, validExtracted)` |
| 6   | GATHER (flow mode)      | `flow-step-executor.ts` | `executeFlowStep()` :265,1486,1562,1975 | `setGatheredValues(session, extracted)`      |

### Tool Results

| #   | Source                  | File                    | Function : Line                                  | What it writes                                                               |
| --- | ----------------------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| 7   | Tool result (reasoning) | `reasoning-executor.ts` | `executeMessage()` :604                          | `values[last_<tool>_result] = toolResult`                                    |
| 8   | CALL result (flow)      | `flow-step-executor.ts` | `executeFlowStep()` :472,474,1308,1398,1896,2203 | `values[last_<tool>_result] = result` or `Object.assign(values, callResult)` |
| 9   | CALL_AS result (flow)   | `flow-step-executor.ts` | `executeFlowStep()` :2198                        | `values[call_as] = callResult`                                               |

### Flow Assignments

| #   | Source            | File                    | Function : Line                    | What it writes                                         |
| --- | ----------------- | ----------------------- | ---------------------------------- | ------------------------------------------------------ |
| 10  | SET assignment    | `flow-step-executor.ts` | `executeFlowStep()` :444,1635,1864 | `values[key] = resolveSetValue(...)`                   |
| 11  | TRANSFORM         | `flow-step-executor.ts` | `executeFlowStep()` :2354          | `values[target] = transformed`                         |
| 12  | Raw input capture | `flow-step-executor.ts` | `executeFlowStep()` :1595-1596     | `values['input'] = currentMessage`                     |
| 13  | Per-step reset    | `flow-step-executor.ts` | `executeFlowStep()` :1125          | `values[name] = initial_value` (resets on step change) |
| 14  | Sub-intent SET    | `flow-step-executor.ts` | `executeFlowStep()` :1388          | `Object.assign(values, subIntent.set)`                 |

### Multi-Agent (Routing)

| #   | Source                | File                  | Function : Line              | What it writes                           |
| --- | --------------------- | --------------------- | ---------------------------- | ---------------------------------------- |
| 15  | Handoff context       | `routing-executor.ts` | `executeHandoff()` :361      | `values[key] = value`                    |
| 16  | Delegate result       | `routing-executor.ts` | `executeDelegation()` :774   | `values[useResultKey] = result.response` |
| 17  | Fan-out stored result | `routing-executor.ts` | `executeFanOut()` :1177,1583 | `values[_stored_<key>] = {...}`          |
| 18  | Fan-out merge         | `routing-executor.ts` | `mergeFanOutResults()` :1441 | `values[targetKey] = value`              |

---

## Tool Result Storage — CALL, CALL_AS, WITH, and Related Flow Step Keywords

When a tool executes, the **entire result** is stored automatically. The storage strategy depends on the mode and DSL keywords used.

### Reasoning Mode — No Control

```
# No DSL control over storage in reasoning mode.
# LLM calls search_hotels → result always stored as:
session.data.values["last_search_hotels_result"] = { hotels: [...], count: 15 }
```

**Code**: `reasoning-executor.ts:604`

```typescript
session.data.values[`last_${toolCall.name}_result`] = toolResult;
```

Always the full result. Always under `last_<tool>_result`. No way to pick fields or rename.

### Flow Mode — Full Control via Step Keywords

#### CALL — Basic tool call (result spread flat)

```
STEP: lookup
  CALL: search_hotels
  ON_SUCCESS:
    RESPOND: "Found {{count}} hotels"
    THEN: select_hotel
```

**Storage** (`flow-step-executor.ts:2203-2206`):

```typescript
// 1. Flat spread — every field merged into session.data.values
Object.assign(session.data.values, callResult);
// session.data.values["hotels"] = [...]
// session.data.values["count"] = 15
// session.data.values["filters_applied"] = { city: "Paris" }

// 2. Also nested under tool name
session.data.values["search_hotels"] = { hotels: [...], count: 15, ... };
```

Risk: if the tool returns a field named `destination`, it **overwrites** the user's gathered `destination` value.

#### CALL_AS — Store result under a named key

```
STEP: lookup
  CALL: search_hotels
  CALL_AS: hotel_results          ← you name the variable
  ON_SUCCESS:
    RESPOND: "Found {{hotel_results.count}} hotels"
    THEN: select_hotel
```

**Storage** (`flow-step-executor.ts:2198`):

```typescript
session.data.values['hotel_results'] = callResult;
// session.data.values["hotel_results"] = { hotels: [...], count: 15 }
```

No flat spread — result stays contained under one key. **Safer** than bare CALL.

#### WITH — Pass explicit parameters to the tool

```
STEP: check_user
  CALL: verify_identity
  WITH:
    user_id: session_id                ← resolved from session.data.values
    method: "sms"                       ← literal value
  CALL_AS: verification_result
  ON_SUCCESS:
    SET: is_verified = true
    RESPOND: "You're verified!"
    THEN: main_menu
  ON_FAILURE:
    RESPOND: "Verification failed. Let's try again."
    THEN: retry_verification
```

**Code** (`flow-step-executor.ts:2160-2190`):

```typescript
// Resolve each WITH param from session context
const params = {};
for (const [key, expr] of Object.entries(step.call_with)) {
  params[key] = resolveValue(String(expr), session.data.values);
}
// params = { user_id: "usr-123", method: "sms" }

callResult = await this.executeToolWithErrorHandling(session, toolName, params, onTraceEvent);
```

Without WITH, the tool receives parameters auto-resolved from `session.data.values` by name matching. WITH gives explicit control over what the tool receives.

#### SUCCESS_WHEN — Custom success condition

```
STEP: book_hotel
  CALL: book_hotel
  CALL_AS: booking
  SUCCESS_WHEN: booking.confirmation_id IS SET       ← custom condition
  ON_SUCCESS:
    SET: booking_confirmed = true
    RESPOND: "Booked! Confirmation: {{booking.confirmation_id}}"
    THEN: complete
  ON_FAILURE:
    RESPOND: "Booking failed: {{booking.error}}"
    THEN: retry_booking
```

**Code** (`flow-step-executor.ts:2217-2226`):

```typescript
if (step.success_when) {
  callSuccess = compilerEvaluateCondition(step.success_when, {
    ...session.data.values,
    _result: callResult,
  });
} else {
  // Generic: check for error indicators
  callSuccess =
    !callResult._error && callResult.error === undefined && callResult.success !== false;
}
```

Without SUCCESS_WHEN, success is determined by absence of error fields. SUCCESS_WHEN lets you define domain-specific success (e.g., "success means confirmation_id exists").

#### ON_RESULT — Multi-way branching on result values

```
STEP: check_status
  CALL: get_booking_status
  CALL_AS: status
  ON_RESULT:
    - WHEN: status.state == "confirmed"
      RESPOND: "Your booking is confirmed."
      THEN: show_details
    - WHEN: status.state == "pending"
      RESPOND: "Still processing, please wait."
      THEN: wait_step
    - WHEN: status.state == "cancelled"
      RESPOND: "This booking was cancelled."
      THEN: rebook
```

**Code** (`flow-step-executor.ts:2232-2280`):
Evaluates each WHEN condition in order against the result. First match wins. Supports SET, RESPOND, and THEN in each branch.

#### TRANSFORM — Array pipeline on stored results

```
STEP: filter_results
  TRANSFORM:
    SOURCE: hotel_results.hotels         ← read from session.data.values
    ITEM_VAR: hotel                      ← loop variable name
    FILTER: hotel.price < budget_range   ← keep only matching items
    MAP:                                 ← reshape each item
      name: hotel.name
      price: hotel.price
      rating: hotel.rating
    SORT_BY:
      FIELD: price
      ORDER: asc
    LIMIT: 5
    TARGET: filtered_hotels              ← write result here
```

**Code** (`flow-step-executor.ts:2292-2354`):

```typescript
// Pipeline: filter → map → sort_by → limit
session.data.values['filtered_hotels'] = transformed;
```

This is the **only way** to pick specific fields from a tool result — by running TRANSFORM after the CALL step.

### Summary of Flow Step Keywords

| Keyword        | Purpose                                | DSL Example                      | Code Line |
| -------------- | -------------------------------------- | -------------------------------- | --------- |
| `CALL`         | Execute a tool                         | `CALL: search_hotels`            | :2158     |
| `CALL_AS`      | Name the result variable               | `CALL_AS: hotel_results`         | :2197     |
| `WITH`         | Pass explicit parameters               | `WITH: { user_id: session_id }`  | :2160     |
| `SUCCESS_WHEN` | Custom success condition               | `SUCCESS_WHEN: result.id IS SET` | :2217     |
| `ON_SUCCESS`   | Branch when call succeeds              | `ON_SUCCESS: RESPOND: "Done"`    | :2384     |
| `ON_FAILURE`   | Branch when call fails                 | `ON_FAILURE: THEN: retry`        | :2384     |
| `ON_RESULT`    | Multi-way branching on result          | `ON_RESULT: - WHEN: ...`         | :2232     |
| `SET`          | Assign values from result              | `SET: confirmed = true`          | :2404     |
| `TRANSFORM`    | Array pipeline (filter/map/sort/limit) | `TRANSFORM: SOURCE: results`     | :2292     |
| `THEN`         | Go to next step                        | `THEN: next_step`                | :2424     |

### Storage Comparison

| Approach                | What gets stored                 | Key name                    | Risk                                        |
| ----------------------- | -------------------------------- | --------------------------- | ------------------------------------------- |
| Reasoning mode          | Full result                      | `last_<tool>_result`        | Can't control — always full result          |
| `CALL` (no CALL_AS)     | Full result flat-spread + nested | Every field + `<tool_name>` | Field name collisions with session vars     |
| `CALL` + `CALL_AS`      | Full result under one key        | Your chosen name            | Safe — no collisions, but still full result |
| `CALL_AS` + `TRANSFORM` | Filtered/mapped subset           | TRANSFORM's TARGET          | Only way to pick specific fields            |

---

## Key Files

| File                                                         | Purpose                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/memory-integration.ts`  | Main orchestrator — init, REMEMBER eval, RECALL dispatch                                                      |
| `apps/runtime/src/services/execution/memory-executor.ts`     | REMEMBER condition evaluation + RECALL action execution                                                       |
| `apps/runtime/src/services/execution/event-detector.ts`      | Maps tool names / field names → event strings                                                                 |
| `apps/runtime/src/services/execution/preference-detector.ts` | Auto-detects user preferences from text                                                                       |
| `apps/runtime/src/services/execution/types.ts`               | `setGatheredValues()`, `RuntimeSession` type with `factStore`                                                 |
| `apps/runtime/src/services/stores/mongodb-fact-store.ts`     | MongoDB FactStore — tenant+user+project scoped                                                                |
| `packages/compiler/src/platform/stores/fact-store.ts`        | FactStore abstract class + in-memory implementation                                                           |
| `packages/compiler/src/platform/ir/schema.ts`                | IR types: `MemoryConfig`, `SessionMemory`, `PersistentMemory`, `RememberTrigger`, `RecallInstruction`         |
| `packages/core/src/types/agent-based.ts`                     | AST types: `MemoryConfig`, `SessionMemoryVar`, `PersistentMemoryPath`, `RememberTrigger`, `RecallInstruction` |

---

## Lifecycle

```
Session Created
  │
  ├─ initializeAllMemory()
  │   ├─ Set session vars to initial_value          (#1)
  │   ├─ loadPersistentDefaults() from FactStore    (#2, #3)
  │   └─ executeRecallForEvents(['session_start'])  (#4)
  │
  ▼
Message Received
  │
  ├─ [Reasoning Mode]
  │   ├─ LLM extracts entities → setGatheredValues  (#5)
  │   ├─ evaluateRememberAfterStateChange()          (writes to DB)
  │   ├─ executeRecallAfterExtraction()              (#4)
  │   ├─ LLM calls tool → last_<tool>_result         (#7)
  │   ├─ evaluateRememberAfterStateChange()          (writes to DB)
  │   └─ executeRecallAfterToolCall()                (#4)
  │
  ├─ [Flow Mode]
  │   ├─ GATHER step → extract entities              (#6)
  │   ├─ SET step → assign values                    (#10)
  │   ├─ CALL step → tool result                     (#8, #9)
  │   ├─ TRANSFORM step → transform data             (#11)
  │   ├─ evaluateRememberAfterStateChange()          (writes to DB)
  │   └─ executeRecallAfterExtraction/ToolCall()     (#4)
  │
  └─ [Multi-Agent]
      ├─ HANDOFF → context passed to child           (#15)
      ├─ DELEGATE → result stored                    (#16)
      └─ FAN_OUT → results merged                    (#17, #18)
```

---

## Dynamic Prompt Resolution (Template Interpolation)

### Overview

All text fields in the DSL support **template interpolation** using `{{variable}}` syntax (Handlebars-style). Variables are resolved from `session.data.values` — the single source of truth for all runtime state.

**Design philosophy:** Users control caching behavior. If you don't use templates, text is static and fully cached by LLM providers. If you use templates, you're explicitly opting into dynamic behavior and accepting the cache trade-off.

**Key insight:** `interpolateTemplate()` is called **on every turn** for all fields, but if there's no `{{}}` in the text, it's a fast no-op that returns the string as-is. Existing agents with static identity stay fully cached.

### Syntax Reference

```
{{variable}}                           # Simple substitution
{{nested.property}}                    # Dot-path access
{{array.length}}                       # Array length
{{#if condition}}...{{/if}}            # Conditional block
{{#each array}}{{name}}{{/each}}       # Loop over array
{{@index}}                             # Loop index (inside #each)
{{add @index 1}}                       # Arithmetic helper (inside #each)
```

All operators from `value-resolution.ts:11-73`.

### Where Template Interpolation Works

| DSL Location                      | Interpolation Timing                   | Code Reference                                          | Cache Impact                     |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| **IDENTITY.GOAL**                 | ⚠️ **GAP-10** — not interpolated today | `prompt-builder.ts:118`                                 | High if dynamic                  |
| **IDENTITY.PERSONA**              | ⚠️ **GAP-10** — not interpolated today | `prompt-builder.ts:122`                                 | High if dynamic                  |
| **IDENTITY.LIMITATIONS**          | ⚠️ **GAP-10** — not interpolated today | `prompt-builder.ts:128`                                 | High if dynamic                  |
| **RESPOND** / **PRESENT**         | ✅ Every turn                          | `flow-step-executor.ts:482, 1214, ...`                  | No impact (not in system prompt) |
| **PROMPT** (flow gather)          | ✅ Every turn                          | `flow-step-executor.ts:1701, 1759, ...`                 | No impact (user message)         |
| **SET** right-hand side           | ✅ When SET executes                   | `flow-step-executor.ts:2406`, `value-resolution.ts:134` | No impact (stored value)         |
| **ON_SUCCESS/ON_FAILURE RESPOND** | ✅ Every turn                          | Same as RESPOND                                         | No impact                        |
| **ON_RESULT RESPOND**             | ✅ Every turn                          | Same as RESPOND                                         | No impact                        |
| **TRANSFORM SET**                 | ✅ When TRANSFORM executes             | `flow-step-executor.ts:2406`                            | No impact                        |
| **Constraint MESSAGE**            | ✅ When constraint fires               | `constraint-checker.ts:223`                             | No impact (error path)           |
| **Voice config (SSML)**           | ✅ Every turn                          | `value-resolution.ts:99-101`                            | No impact (response)             |
| **Rich content (MARKDOWN)**       | ✅ Every turn                          | `value-resolution.ts:113-118`                           | No impact (response)             |
| **CALL WITH params**              | ✅ When CALL executes                  | Implicit via `resolveSetValue`                          | No impact (tool params)          |
| **HANDOFF CONTEXT summary**       | ✅ When handoff executes               | `routing-executor.ts:1570`                              | No impact (handoff message)      |

**Cache impact key:**

- "High if dynamic" = Affects system prompt caching if variables change frequently
- "No impact" = Not in system prompt, or in non-cached sections

### Use Case Patterns

#### 1. Session-Personalized Identity (Cache-Friendly)

Variables set once at session start, stable throughout.

```abl
IDENTITY:
  GOAL: "Help {{customer_name}} book travel packages"
  PERSONA: "Friendly {{user_tier}} concierge for {{company_name}}"

MEMORY:
  session:
    - customer_name: "Valued Customer"
    - user_tier: "Standard"
    - company_name: "TravelDesk.com"
```

**Cache behavior:** If `customer_name` doesn't change during the session, the system prompt stays constant → LLM provider caches it after first turn.

#### 2. Multi-Phase Workflows (Intentionally Dynamic)

Agent behavior changes as conversation progresses.

```abl
IDENTITY:
  GOAL: |
    {{#if current_phase == "discovery"}}
    Help users explore travel options. Be conversational, ask open-ended questions.
    {{/if}}
    {{#if current_phase == "selection"}}
    Help users compare and select from {{search_results_count}} hotel options. Be analytical and data-focused.
    {{/if}}
    {{#if current_phase == "booking"}}
    Finalize booking for {{selected_hotel_name}}. Be precise, security-focused, confirm all details.
    {{/if}}

MODE: scripted

FLOW:
  entry_point: discovery

  discovery:
    SET: current_phase = "discovery"
    GATHER: [destination, check_in, check_out]
    ON_INPUT:
      - IF: ALL_GATHERED
        THEN: search

  search:
    CALL: search_hotels
      AS: searchResult
    ON_SUCCESS:
      SET:
        current_phase = "selection"
        search_results_count = searchResult.hotels.length
      THEN: select_hotel

  select_hotel:
    RESPOND: "Found {{search_results_count}} options"
    GATHER: [selected_hotel_id]
    ON_INPUT:
      - ELSE:
        SET:
          current_phase = "booking"
          selected_hotel_name = searchResult.hotels[0].name
        THEN: confirm
```

**Cache behavior:** System prompt changes on each phase transition. Accepted trade-off for dynamic behavior.

#### 3. Progress-Aware Instructions

Agent adapts tone based on completion progress.

```abl
IDENTITY:
  GOAL: |
    Collect booking information from the user.
    Progress: {{gathered_fields_count}}/{{total_required_fields}} fields collected.
    {{#if gathered_fields_count >= 4}}
    Almost done! Just need: {{missing_fields}}. Stay focused, confirm details, and proceed.
    {{else if gathered_fields_count >= 2}}
    Good progress. Continue gathering remaining fields naturally.
    {{else}}
    Just started. Keep conversation natural and exploratory. Don't rush.
    {{/if}}

GATHER:
  - destination: required
  - check_in: required
  - check_out: required
  - num_guests: required
  - room_type: required
```

#### 4. Tier-Based Capabilities (Tool Result Driven)

Agent permissions and tone change based on discovered user status.

```abl
IDENTITY:
  PERSONA: |
    {{#if user_tier == "vip"}}
    Premium concierge. Proactive, anticipate needs, offer room upgrades and exclusive perks.
    {{else if user_tier == "standard"}}
    Professional travel agent. Helpful, efficient, friendly.
    {{else}}
    Trial account agent. Focus on demonstrating value. Encourage upgrade to paid tier.
    {{/if}}

  LIMITATIONS:
    - "{{#if user_tier == "vip"}}Can offer discounts up to 30%{{else}}Can offer discounts up to 10%{{/if}}"
    - "{{#if fraud_flag}}CRITICAL: Fraud alert raised. Require additional verification before processing payment.{{/if}}"

TOOLS:
  - check_user_tier
  - verify_payment_method

MEMORY:
  remember:
    - WHEN: last_check_user_tier_result.tier IS SET
      STORE:
        user_tier: last_check_user_tier_result.tier

    - WHEN: last_verify_payment_method_result.fraud_score > 80
      STORE:
        fraud_flag: true
```

**Flow:**

1. Agent calls `check_user_tier` tool
2. Result stored: `last_check_user_tier_result = { tier: "vip" }`
3. REMEMBER rule fires, updates `session.data.values.user_tier = "vip"`
4. Next turn: PERSONA re-interpolates, LLM now sees VIP instructions

#### 5. Conditional Tool Availability

Agent capabilities change based on state.

```abl
IDENTITY:
  GOAL: |
    Help users manage their hotel booking.
    {{#if booking_confirmed}}
    Booking #{{booking_id}} is confirmed. You can now: modify dates, cancel booking, request refund.
    {{else if eligibility_checked}}
    {{#if eligible_for_booking}}
    User is eligible. Available actions: search hotels, create booking.
    {{else}}
    User is NOT eligible (reason: {{ineligibility_reason}}). Can only provide information, cannot book.
    {{/if}}
    {{else}}
    First step: Check user eligibility using check_eligibility tool.
    {{/if}}

CONSTRAINTS:
  guardrails:
    - REQUIRE eligibility_checked == true BEFORE calling search_hotels
      ON_FAIL: "Must check eligibility first. Call check_eligibility tool."

    - REQUIRE booking_confirmed == true BEFORE calling modify_booking
      ON_FAIL: "No active booking to modify."
```

#### 6. Error Recovery Mode

Agent switches to manual fallback when tools fail.

```abl
IDENTITY:
  GOAL: |
    {{#if tool_failure_count > 2}}
    BOOKING SYSTEM IS DOWN. New objective: Collect user requirements (destination, dates, preferences) and create a manual booking request ticket. Explain the manual process will take 24 hours. Do NOT attempt to use search_hotels or book_hotel tools.
    {{else}}
    Help users search and book hotels using the search_hotels and book_hotel tools.
    {{/if}}

  LIMITATIONS:
    {{#if tool_failure_count > 2}}
    - "Cannot use automated booking system"
    - "Manual booking requests take 24 hours to process"
    - "Must collect: destination, dates, room preferences, contact info, special requests"
    {{/if}}

ON_ERROR:
  tool_error:
    SET: tool_failure_count = ADD(COALESCE(tool_failure_count, 0), 1)
    RESPOND: "Let me try that again..."
    RETRY: 1
```

#### 7. Contextual Constraints (Security-Sensitive Phases)

Stricter validation during payment/PII collection.

```abl
IDENTITY:
  LIMITATIONS:
    - "Must validate all user inputs"
    {{#if current_step == "payment"}}
    - "CRITICAL: Payment collection phase. Use formal tone. Do NOT store raw card numbers. Validate card format strictly."
    {{/if}}
    {{#if current_step == "personal_info"}}
    - "Collecting PII. Validate email format, phone format. Explain data privacy policy. Require consent."
    {{/if}}

FLOW:
  collect_personal_info:
    SET: current_step = "personal_info"
    GATHER: [full_name, email, phone]
    THEN: collect_payment

  collect_payment:
    SET: current_step = "payment"
    GATHER: [card_number, expiry, cvv]
    THEN: process_booking
```

#### 8. Array-Driven Dynamic Instructions

Generate instructions from lists (e.g., active warnings, restricted destinations).

```abl
IDENTITY:
  LIMITATIONS:
    - "Cannot book international flights without passport information"
    {{#each active_warnings}}
    - "WARNING {{this.severity}}: {{this.message}}"
    {{/each}}
    {{#if restricted_destinations.length > 0}}
    - "Cannot book travel to: {{#each restricted_destinations}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}"
    {{/if}}

MEMORY:
  session:
    - active_warnings: []
    - restricted_destinations: []

REMEMBER:
  - WHEN: last_check_travel_advisory_result.warnings IS SET
    STORE:
      active_warnings: last_check_travel_advisory_result.warnings

  - WHEN: last_sanctions_check_result.restricted_countries IS SET
    STORE:
      restricted_destinations: last_sanctions_check_result.restricted_countries
```

**Example interpolated output:**

```
Limitations:
- Cannot book international flights without passport information
- WARNING HIGH: Hurricane alert in Caribbean region
- WARNING MEDIUM: Airport delays expected in NYC
- Cannot book travel to: Country A, Country B
```

#### 9. Agent Metadata in Prompts (Multi-Tenancy)

Same agent DSL, different branding per tenant.

```abl
IDENTITY:
  GOAL: "Help users book travel with {{brand_name}}"
  PERSONA: "Professional travel agent representing {{brand_name}}. {{brand_tagline}}"

# Variables injected at session creation from project metadata:
# session.data.values.brand_name = project.metadata.brandName
# session.data.values.brand_tagline = project.metadata.tagline
```

**Tenant A:** `Goal: Help users book travel with TravelDesk.com`
**Tenant B:** `Goal: Help users book travel with LuxuryEscapes`

### Caching Implications

#### How LLM Provider Caching Works

Modern LLM APIs cache **prefixes** of the system prompt. If the first N tokens are identical to a previous request, they're served from cache (cheaper, faster).

#### Cache Impact by Pattern

| Pattern                  | Variables Change Frequency         | Cache Behavior                             | Cost Impact      |
| ------------------------ | ---------------------------------- | ------------------------------------------ | ---------------- |
| **Static identity**      | Never (no `{{}}`)                  | Fully cached across all sessions           | Lowest cost      |
| **Session-personalized** | Once per session                   | Cached within session, miss on new session | Low cost         |
| **Phase-based**          | Few times per session (3-5 phases) | Cache miss on each phase transition        | Medium cost      |
| **Progress-based**       | Every turn (progress changes)      | Cache miss every turn                      | High cost        |
| **Tool-result-driven**   | After each tool call               | Cache miss after tool execution            | Medium-high cost |

#### User Control: Choosing Your Trade-Off

**Maximize caching (lowest cost):**

```abl
GOAL: "Help users book travel"                          # Static
PERSONA: "Friendly, professional travel agent"          # Static
```

**Balance (some dynamism, acceptable cost):**

```abl
GOAL: "Help {{customer_name}} book travel"              # Stable per session
PERSONA: "{{user_tier}} travel concierge"               # Changes rarely
```

**Full dynamism (highest flexibility, higher cost):**

```abl
GOAL: "Phase: {{current_phase}}. Progress: {{progress}}%"  # Changes every turn
```

**Recommendation:** Use dynamic variables in GOAL/PERSONA **only when the behavior genuinely needs to change**. For display-only information (progress bars, status updates), use the `## Current Context` section instead (it's never cached, so no penalty).

### Best Practices

#### DO

1. **Use static text when possible** — No templates = maximum caching
2. **Use session-stable variables for personalization** — `{{customer_name}}` set once at start
3. **Use templates in RESPOND/PRESENT freely** — Not in system prompt, no cache impact
4. **Use conditionals for mutually exclusive modes** — `{{#if vip_mode}}...{{else}}...{{/if}}`

#### DON'T

1. **Don't use rapidly-changing variables in GOAL/PERSONA** — `{{turn_count}}` kills caching, put in RESPOND instead
2. **Don't use templates for information that doesn't change behavior** — `{{search_results_count}}` in PERSONA doesn't alter behavior, put in RESPOND
3. **Don't embed full context in identity** — `{{destination}}, {{dates}}` already exists in `## Current Context`
4. **Don't duplicate Current Context section** — Identity should describe WHO, not WHAT state

### Anti-Patterns

```abl
# BAD — Progress bar in identity, cache miss every turn
GOAL: "Progress: [{{progress_bar}}] {{progress_percent}}%"

# GOOD — Show progress in response messages
GOAL: "Collect booking information from users"
RESPOND: "Progress: {{progress_percent}}% complete."
```

```abl
# BAD — Duplicating Current Context
PERSONA: "Agent helping with {{destination}} booking for {{num_guests}} guests"

# GOOD — Context is already in prompt
PERSONA: "Professional travel booking agent"
```

```abl
# BAD — Tool result details in identity
PERSONA: "Agent who found {{search_results_count}} hotels"

# GOOD — Tool results belong in responses
RESPOND: "I found {{search_results_count}} hotels."
```

### Implementation Status

| Component                                 | Status             | Code Reference                                      |
| ----------------------------------------- | ------------------ | --------------------------------------------------- |
| Template engine (`interpolateTemplate`)   | ✅ Implemented     | `value-resolution.ts:11-73`                         |
| RESPOND/PRESENT interpolation             | ✅ Implemented     | `flow-step-executor.ts:482, 1214, ...`              |
| PROMPT interpolation (flow mode)          | ✅ Implemented     | `flow-step-executor.ts:1701, 1759, ...`             |
| SET value interpolation                   | ✅ Implemented     | `value-resolution.ts:126-146`                       |
| Constraint MESSAGE interpolation          | ✅ Implemented     | `constraint-checker.ts:223`                         |
| **IDENTITY interpolation (GOAL/PERSONA)** | ⚠️ **GAP-10**      | `prompt-builder.ts:118, 122` (needs implementation) |
| Compiler warnings for anti-patterns       | ❌ Not implemented | Future enhancement                                  |

---

## Known Gaps & Issues

### Priority Matrix

| Priority     | GAP    | Title                                                                          | Severity                                          | Impact                                                                                                                                                                            |
| ------------ | ------ | ------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** | GAP-1  | RECALL Legacy `ON_START:` Shorthand is Dead Code                               | All RECALL ON_START rules non-functional          | Every example agent's RECALL rules silently fail. Memory system appears broken on first use.                                                                                      |
| **CRITICAL** | GAP-14 | Entity Extraction Should Use Structured Tool Call                              | Reliability — fragile raw JSON parsing            | ~40 lines of defensive parsing. LLM returns prose/markdown instead of JSON. Extraction failures in production.                                                                    |
| **CRITICAL** | GAP-12 | No Post-Tool-Call Variable Mapping in Reasoning Mode                           | Feature gap — can't map tool results to variables | REMEMBER/RECALL fire-and-forget (race conditions). No constraint check after state changes. Raw tool result bloats context.                                                       |
| **HIGH**     | GAP-16 | All Prompts Must Be Externalized                                               | Maintainability + Customization                   | 99 hardcoded prompts. Customers can't tune without code changes. Prompt improvements require redeployment. System prompt is fragmented `parts.push()` instead of single template. |
| **HIGH**     | GAP-15 | System Tool Schemas — Unstructured Context, No Descriptions, No Reason/Thought | Reliability + wasted tokens                       | `__handoff__` context is free-form string. Target enum has no agent descriptions. No `reason` field (except `__escalate__`). No configurable `thought` for test ground debugging. |
| **HIGH**     | GAP-7  | Tool Event Detection is Hardcoded and Doesn't Scale                            | Feature limitation — 8 hardcoded prefix patterns  | DSL authors have zero control over event mapping. Tools must be named with specific prefixes. No custom events, no success/failure distinction.                                   |
| **HIGH**     | GAP-11 | No Durable Session Persistence for Long-Lived Sessions                         | Architectural gap — 30min Redis TTL               | Sessions cannot survive inactivity beyond TTL. No tiered hot/cold persistence. Long-lived use cases (30-day sessions) impossible.                                                 |
| **MEDIUM**   | GAP-2  | RECALL Event Names are Undiscoverable from DSL                                 | DSL authoring — no event discovery                | Authors must guess event names. No validation at parse/compile time. Invalid events silently never fire.                                                                          |
| **MEDIUM**   | GAP-8  | No Agent-Level Lifecycle Events for RECALL                                     | Feature limitation — no agent_enter/exit events   | Can't trigger RECALL on handoff/delegate transitions. Ghost event definitions exist but never emit.                                                                               |
| **MEDIUM**   | GAP-13 | Tools Cannot Access or Update Session Context                                  | Architectural limitation — tools are stateless    | ToolExecutor has no session access. Can't read context or write variables from tool logic.                                                                                        |
| **MEDIUM**   | GAP-3  | FactStore Queries Over-Fetch and N+1                                           | Performance — unnecessary DB round-trips          | `loadPersistentDefaults()` loads ALL facts then filters client-side. `inject_context` does N sequential queries.                                                                  |
| **MEDIUM**   | GAP-10 | Dynamic Prompt Resolution — IDENTITY not interpolated                          | Feature gap — GOAL/PERSONA are static             | `prompt-builder.ts:118,122` doesn't interpolate `{{variables}}` in GOAL and PERSONA strings.                                                                                      |
| **MEDIUM**   | GAP-6  | Preference Detection is Regex-Only                                             | Feature limitation — misses most signals          | 12 hardcoded regex patterns. Misses "I hate", "big fan of", "dealbreaker", negation, non-English.                                                                                 |
| **LOW**      | GAP-9  | No Project-Scoped (Shared) Facts                                               | Feature limitation — facts require userId         | Can't share facts across all users in a project. No global promotions, business hours, FAQ entries.                                                                               |
| **LOW**      | GAP-4  | Session Memory Declarations Have No Validation                                 | DSL authoring — silent dead declarations          | Session variables can be declared but never populated. No warning at any stage.                                                                                                   |

---

### GAP-1: RECALL Legacy `ON_START:` Shorthand is Dead Code

**Severity**: CRITICAL — All RECALL rules in every example agent are non-functional.

**Root Cause — Two Bugs**:

1. **Event name mismatch**: Parser creates `event: "ON_START"` (literal string from `parseRecallInstruction()` at `agent-based-parser.ts:2326`). Runtime emits `"session_start"` (lowercase, underscore, from `event-detector.ts:67`). The check `detectedEvents.includes("ON_START")` at `memory-executor.ts:87` always fails because `"ON_START" ∉ ["session_start"]`.

2. **Missing action**: Legacy format produces `{ event: "ON_START", instruction: "...", action: undefined }`. Even if event matched, the executor skips entries with `action: undefined` as "legacy format" at `memory-executor.ts:91`.

**Parser code** (`agent-based-parser.ts:2324-2342`):

```typescript
const onMatch = line.match(/^-\s*(ON_\w+):\s*"?(.+)"?$/);
if (onMatch) {
  return {
    event: onMatch[1], // ← literal "ON_START", not "session_start"
    instruction: onMatch[2], // ← text, but action: undefined
  };
}
```

**Runtime code** (`memory-executor.ts:87-93`):

```typescript
if (!detectedEvents.includes(instruction.event)) {
  // "ON_START" ∉ ["session_start"]
  continue; // ← always skipped
}
const action = instruction.action as RecallAction | undefined;
if (!action) {
  log.debug('RECALL with no action — prompt_llm only', { event: instruction.event });
  continue; // ← skipped even if event matched
}
```

**Event emission** (`memory-integration.ts:70-80`):

```typescript
await executeRecallForEvents(
  session,
  memory.recall || [],
  ['session_start'], // ← lowercase, underscore
  'session_start',
  onTraceEvent,
);
```

**Affected files**:

- `examples/traveldesk/supervisor.agent.abl:56` — `ON_START: "Check if user is returning..."`
- `examples/traveldesk/agents/welcome_agent.agent.abl:80` — `ON_START: "Check if user has visited before..."`
- `examples/traveldesk/agents/sales_agent.agent.abl` — `ON_START: "Check if user has travel preferences..."`
- `examples/traveldesk/agents/authentication.agent.abl` — `ON_START: "Check if user has previously verified..."`
- `examples/traveldesk/agents/booking_manager.agent.abl` — `ON_START: "Check user's bookings..."`
- `examples/banknexus/supervisor.agent.abl` — `ON_START: "Check if user is returning..."`
- `examples/telco/supervisor.agent.abl` — `ON_START: "Check active alarms..."`

**Tests confirm the bug** (`parser-memory-enhanced.test.ts:148-202`): Parser test asserts `event === "ON_START"` (passes), but no integration test verifies end-to-end RECALL execution.

#### Design Solutions

**Option A — Parser Normalization (Recommended)** ⭐

Normalize legacy shorthand to modern format during parsing. Both bugs fixed at the source.

```typescript
// agent-based-parser.ts — parseRecallInstruction()
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
  return {
    event: normalizedEvent, // ← "session_start" instead of "ON_START"
    instruction: onMatch[2].replace(/^"|"$/g, ''),
    action: { type: 'prompt_llm', instruction: onMatch[2].replace(/^"|"$/g, '') }, // ← auto-generate action
  };
}
```

| Aspect                  | Detail                                                         |
| ----------------------- | -------------------------------------------------------------- |
| **Fixes both bugs**     | Event name normalized + action auto-generated                  |
| **Backward compatible** | Existing DSL files work without migration                      |
| **Deprecation signal**  | Emit a `ValidationDiagnostic` warning suggesting modern format |
| **No runtime changes**  | Parser output matches what runtime expects                     |
| **Effort**              | Small — ~15 lines in parser, ~20 lines of tests                |

---

**Option B — Runtime Event Aliases**

Add alias mapping in `executeRecallInstructions()`. Parser stays unchanged.

```typescript
// memory-executor.ts — before the includes() check
const EVENT_ALIASES: Record<string, string> = {
  ON_START: 'session_start',
  ON_END: 'session_end',
  // ...
};

const normalizedEvent = EVENT_ALIASES[instruction.event] || instruction.event;
if (!detectedEvents.includes(normalizedEvent)) {
  continue;
}

// Also handle missing action — auto-create prompt_llm
const action = instruction.action || { type: 'prompt_llm', instruction: instruction.instruction };
```

| Aspect               | Detail                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Fixes both bugs**  | Event alias + fallback action                                                              |
| **Parser unchanged** | Mismatch persists in IR but masked at runtime                                              |
| **Risk**             | IR still contains "ON_START" — any new runtime code checking events will have the same bug |
| **Effort**           | Small — ~15 lines in memory-executor                                                       |

---

**Option C — Deprecate and Remove Legacy Format**

Remove legacy parsing. Update all ABL files to modern format. Compile-time error for old syntax.

```abl
# Before (broken):
MEMORY:
  recall:
    - ON_START: "Check if user is returning"

# After (working):
MEMORY:
  recall:
    - ON: session_start
      ACTION: prompt_llm
      INSTRUCTION: "Check if user is returning"
```

| Aspect                 | Detail                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| **Clean break**        | No legacy baggage in parser or runtime                                |
| **Migration required** | ~7 ABL files must be updated                                          |
| **Compile-time error** | Parser rejects `ON_START:` with actionable migration message          |
| **Risk**               | Any customer-written ABL using legacy format breaks (breaking change) |
| **Effort**             | Medium — update ~7 files + parser changes + tests                     |

---

**Code references**:

- Parser stores raw `ON_START`: `packages/core/src/parser/agent-based-parser.ts:2324-2342`
- Runtime fires `session_start`: `apps/runtime/src/services/execution/memory-integration.ts:70-80`
- Matching fails: `apps/runtime/src/services/execution/memory-executor.ts:87`
- Event detector: `apps/runtime/src/services/execution/event-detector.ts:62-89`
- RecallInstruction type: `packages/compiler/src/platform/ir/schema.ts:569-580`
- Parser test (confirms bug): `packages/core/src/__tests__/parser-memory-enhanced.test.ts:148-202`

### GAP-2: RECALL Event Names are Undiscoverable from DSL

**Severity**: DSL authors cannot know what events are available for RECALL rules.

**Problem**: RECALL events (`session_start`, `search_initiated`, `booking_started`, etc.) are hardcoded in `event-detector.ts` as tool-name-prefix conventions. The DSL has no syntax to declare, discover, or list available events. A DSL author writing `ON: search_initiated` must know that:

1. The event `search_initiated` exists
2. It fires when a tool name starts with `search_`
3. Their tool must be named `search_flights`, not `find_flights`

There is no validation at parse time or compile time — an invalid event name like `ON: booking_completed` silently never fires.

**Fix options**:

1. **Document events in DSL spec**: Add a reference section listing all available events
2. **Compiler validation**: Warn when a RECALL event doesn't match any known runtime event pattern
3. **Custom events**: Allow DSL to declare custom events and emit them from tool definitions

**Code reference**: `apps/runtime/src/services/execution/event-detector.ts` (full file)

### GAP-3: FactStore Queries Over-Fetch and N+1

**Severity**: Performance — unnecessary data loaded from DB + multiple round-trips.

**Two problems in two different code paths:**

#### Problem A: `loadPersistentDefaults()` loads ALL facts, filters client-side

`loadPersistentDefaults()` calls `factStore.query({})` with an empty filter, loading **all** non-expired facts for the user (up to 100), then filters client-side by matching against declared persistent paths. If an agent declares 2 persistent paths but the user has 80 stored facts, 78 are fetched and discarded.

**Current code** (`memory-integration.ts:140`):

```typescript
const allFacts = await factStore.query({});  // loads ALL user facts
const factMap = new Map(allFacts.map(f => [f.key, f.value]));
for (const pm of persistent) {
  if (factMap.has(pm.path)) { ... }  // client-side filter
}
```

**MongoDB query generated**:

```javascript
db.facts
  .find({ tenantId, userId, projectId, $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] })
  .sort({ updatedAt: -1 })
  .limit(100);
// No key filter — returns everything
```

#### Problem B: `inject_context` RECALL does N round-trips for N paths

`executeRecallInstructions()` calls `factStore.get({ key })` once per path — N DB round-trips for N paths.

**Current code** (`memory-executor.ts:101-107`):

```typescript
for (const path of action.paths) {
  const fact = await config.factStore.get({ key: path }); // 1 DB call per path
  if (fact) injectedData[path] = fact.value;
}
```

If RECALL declares `PATHS: [user.preferred_chains, user.blacklisted_hotels, user.room_preferences]` — that's 3 sequential MongoDB queries.

#### Fix: Add `batchGet()` to FactStore

The `FactStore` interface needs a `batchGet(keys: string[])` method that uses a single `$in` query:

```typescript
// New method on MongoDBFactStore
async batchGet(keys: string[]): Promise<Map<string, Fact>> {
  const docs = await FactModel.find({
    ...this.ownerFilter(),
    key: { $in: keys },
    $or: [{ expiresAt: null }, { expiresAt: { $gte: new Date() } }],
  }).lean();
  return new Map(docs.map(d => [d.key, mapDocToFact(d)]));
}
```

Then use it in both places:

```typescript
// loadPersistentDefaults — replace query({}) with targeted batchGet
const paths = persistent.map((p) => p.path);
const factMap = await factStore.batchGet(paths);

// inject_context — replace N get() calls with single batchGet
const factMap = await factStore.batchGet(action.paths);
for (const path of action.paths) {
  if (factMap.has(path)) injectedData[path] = factMap.get(path).value;
}
```

|                                   | Current                                       | Fixed                                  |
| --------------------------------- | --------------------------------------------- | -------------------------------------- |
| `persistent:` (2 paths, 80 facts) | 1 query returning 80 docs, filter client-side | 1 query returning 2 docs via `$in`     |
| `inject_context` (3 paths)        | 3 sequential `findOne()` calls                | 1 `find({ key: { $in: [...] } })` call |
| `load_memory` (prefix)            | Already correct — `query({ prefix })`         | No change needed                       |

**Code references**:

- Over-fetch: `memory-integration.ts:140`
- N+1: `memory-executor.ts:101-107`
- FactStore interface: `packages/compiler/src/platform/stores/fact-store.ts`

### GAP-4: Session Memory Declarations Have No Validation

**Severity**: DSL authoring — silent dead declarations.

**Problem**: Variables declared in `MEMORY.session` (e.g., `selected_items`, `search_expires_at`) are never validated against any mechanism that would populate them. A DSL author can declare a session variable that is never set by GATHER, TOOLS, SET, or HANDOFF — and there is no warning at parse time, compile time, or runtime.

**Example**: Sales_Agent declares `selected_items` and `search_expires_at` in session memory, but neither is populated by any GATHER field, tool result mapping, SET assignment, or handoff context in the agent's DSL.

**Fix options**:

1. **Compiler warning**: Analyze all value-writing paths (GATHER fields, tool names → `last_<tool>_result`, SET assignments, HANDOFF CONTEXT) and warn for session vars that have no population source
2. **Runtime trace**: Emit a `memory_unused_var` trace event at session end for session vars that were never written to

### GAP-6: Preference Detection is Regex-Only and Doesn't Scale

**Severity**: Feature limitation — most natural language preference signals are missed.

**Problem**: `detectAndStorePreferences()` in `preference-detector.ts` uses 12 hardcoded regex patterns across 4 categories (refuse, avoid, desire, accept). This misses the vast majority of natural language preference expressions.

**What it catches** (12 patterns):

- "I'm allergic to...", "absolutely not...", "I refuse..." → refuse
- "I don't want...", "I'd rather avoid...", "stay away from..." → avoid
- "I prefer...", "I'd really love...", "my favorite is..." → desire
- "that works", "I'd like...", "let's do..." → accept

**What it misses**:
| User says | Expected | Detected? |
|---|---|---|
| "I hate seafood" | avoid/refuse | No — "hate" not in patterns |
| "Seafood makes me sick" | refuse | No |
| "Big fan of rooftop bars" | desire | No |
| "Anything but economy class" | avoid | No |
| "I'm vegan" | refuse (for non-vegan food) | No |
| "Meh, not really into that" | avoid | No |
| "That's a dealbreaker" | refuse | No |
| "Sure, why not" | accept | No |
| "Soy milk please, not dairy" | desire + avoid | No |

**Additional issues**:

- **No negation handling**: "I don't mind pets" would match "don't" pattern → false avoid
- **No entity normalization**: "I prefer the Marriott" extracts "the Marriott" with article
- **English only**: All regex patterns are English — no i18n support
- **Hardcoded confidence**: 0.6-0.9 values are arbitrary, not calibrated
- **No LLM fallback**: File header says "fast first pass before optional LLM-based extraction" but the LLM pass was never built

**Fix options**:

1. **LLM-based extraction**: Use a small/fast LLM call to classify preference signals — the file was designed for this ("optional LLM-based extraction") but it was never implemented
2. **Expand regex patterns**: Add synonym coverage (hate, dislike, can't stand, love, obsessed with, etc.) — improves recall but still brittle
3. **Hybrid**: Keep regex for high-confidence patterns, use LLM for ambiguous cases

**Code references**:

- Detection: `apps/runtime/src/services/execution/preference-detector.ts` (full file)
- Caller: `memory-integration.ts:470` (`detectPreferencesFromText`)
- Storage: `memory-integration.ts:494-501` (appends to `preferences.<category>` in FactStore)
- Escalation: `memory-integration.ts:504-533` (`getWeakerCategories`)

### GAP-7: Tool Event Detection is Hardcoded and Doesn't Scale

**Severity**: Feature limitation — DSL authors have zero control over RECALL event mapping.

**Problem**: `detectToolEvents()` in `event-detector.ts` maps tool names to events using 8 hardcoded prefix conventions. DSL authors cannot define custom events, cannot map tools to events, and must name tools with specific prefixes for RECALL to work.

**Entire vocabulary** (8 prefixes → 6 events):

```
search_*  → search_initiated
book_*    → booking_started
reserve_* → booking_started
pay_*     → payment_initiated
charge_*  → payment_initiated
cancel_*  → cancellation_initiated
update_*  → modification_initiated
modify_*  → modification_initiated
```

**What it misses**:

| Problem                            | Example                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| Tool name doesn't match convention | `find_hotels` → no event (not `search_`)                             |
| Domain-specific actions missing    | `verify_identity`, `authenticate_user` → no event                    |
| No custom events                   | Can't define `loyalty_check_completed` in DSL                        |
| Synonyms ignored                   | `lookup_`, `query_`, `fetch_` → no event (only `search_`)            |
| Compound actions                   | `search_and_book_hotel` → only `search_initiated` (not both)         |
| Non-English tool names             | `buscar_vuelos` (Spanish) → no event                                 |
| No success/failure distinction     | `book_hotel` fires `booking_started` whether it succeeds or fails    |
| No post-completion events          | No `booking_completed`, `payment_succeeded`, `search_returned_empty` |

**Fix options**:

1. **DSL-level event mapping on TOOLS**: Let DSL authors declare events per tool:
   ```
   TOOLS:
     - find_flights
       EVENTS: [search_initiated, flight_lookup]
     - confirm_reservation
       EVENTS: [booking_completed]
   ```
2. **Wildcard/glob patterns**: Allow configurable prefix-to-event mapping in DSL:
   ```
   EVENTS:
     - PATTERN: "find_*|search_*|lookup_*" → search_initiated
     - PATTERN: "confirm_*|finalize_*" → booking_completed
   ```
3. **Tool result-based events**: Fire different events based on tool success/failure:
   ```
   - book_hotel succeeds → booking_completed
   - book_hotel fails → booking_failed
   ```

**Code reference**: `apps/runtime/src/services/execution/event-detector.ts:22-42` (`detectToolEvents`)

### GAP-8: No Agent-Level Lifecycle Events for RECALL

**Severity**: Feature limitation — cannot trigger RECALL when an agent starts, completes, or receives a handoff.

**Problem**: The RECALL system only has **session-level** lifecycle events (`session_start`, `session_end`). There are no **agent-level** events like `agent_enter`, `agent_exit`, `delegate_complete`, or `handoff_received`. This means RECALL cannot react to agent transitions in multi-agent flows.

**Ghost definitions exist but are never emitted**:

| Event                     | Defined in                | Emitted in code?       | Fed to RECALL?             |
| ------------------------- | ------------------------- | ---------------------- | -------------------------- |
| `session_start`           | `event-detector.ts:72`    | Yes                    | Yes                        |
| `session_end`             | `event-detector.ts:75`    | Yes                    | Yes                        |
| `agent_enter`             | `trace-helpers.ts:44`     | **No** — never emitted | No                         |
| `agent_exit`              | `trace-helpers.ts:45`     | **No** — never emitted | No                         |
| `delegate_start`          | `routing-executor.ts:693` | Yes (trace only)       | **No** — not fed to RECALL |
| `delegate_complete`       | `routing-executor.ts:778` | Yes (trace only)       | **No** — not fed to RECALL |
| `handoff_condition_check` | `routing-executor.ts`     | Yes (trace only)       | **No** — not fed to RECALL |

**The routing executor never calls `executeRecallForEvents()`** — it emits trace events for observability but those never reach the RECALL system.

**What you can't do**:

```
recall:
  - ON: agent_enter           # never fires
  - ON: delegate_complete     # never fires
  - ON: handoff_received      # doesn't exist
  - ON: agent_exit            # never fires
```

**Impact**: In multi-agent flows (supervisor → specialist agents), you can't:

- Load user context when a specialist agent starts handling the conversation
- Save intermediate results when an agent finishes and hands back to supervisor
- React to delegation outcomes (success/failure) with memory operations

**Fix options**:

1. **Wire trace events to RECALL**: In `routing-executor.ts`, after emitting `delegate_start`/`delegate_complete` trace events, also call `executeRecallForEvents()` with the same event names
2. **Emit `agent_enter`/`agent_exit`**: Add trace + RECALL event emission at agent entry/exit points in the executor
3. **Agent-scoped `initializeAllMemory()`**: When a handoff/delegate switches to a new agent, re-run `initializeAllMemory()` for the target agent's MEMORY declarations (currently only runs once at session start)

**Code references**:

- Ghost definitions: `trace-helpers.ts:44-45`
- Trace-only events (not RECALL): `routing-executor.ts:693, 778`
- Missing RECALL calls: `routing-executor.ts` — no `executeRecallForEvents` import or usage
- Only lifecycle events that work: `memory-integration.ts:87-91`

### GAP-9: No Project-Scoped (Shared) Facts

**Severity**: Feature limitation — cannot share facts across all users in a project.

**Problem**: Every fact requires `userId` — it's a required field in the schema (`fact.model.ts:40`), part of the compound unique index, and baked into `ownerFilter()`. There is no way to store a fact that is readable by all users in a project.

**Use cases not supported**:

- `global_promotion = "Summer 20% off"` — marketing content all agents should surface
- `system.business_hours = "9am-5pm"` — operational data for scheduling tools
- `faq.refund_policy = "30 days"` — shared knowledge base entries
- `feature_flags.new_checkout = true` — runtime toggles for agent behavior

**Current workarounds (all inadequate)**:

| Approach                                     | Problem                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| Write the same fact for every user           | Doesn't scale, stale copies, N writes per update                    |
| Use a sentinel `userId` like `"__project__"` | Breaks `ownerFilter()` — sessions always query with the real userId |
| Put it in agent DSL as `INITIAL` values      | Not dynamic — requires recompile to change                          |
| Use environment/config variables             | Outside the memory system entirely, not per-project                 |

**Fix: Add a `scope` field to facts**

1. **Schema change** (`fact.model.ts`):

   ```typescript
   scope: { type: String, enum: ['user', 'project'], default: 'user' }
   ```

2. **DSL syntax**:

   ```
   MEMORY:
     persistent:
       - path: global_promotion
         scope: project        # shared across all users
         access: read
       - path: user.preferences
         scope: user            # default — per-user
         access: read-write
   ```

3. **Query change** (`mongodb-fact-store.ts`):

   ```typescript
   private ownerFilter(scope: 'user' | 'project' = 'user') {
     if (scope === 'project') {
       return { tenantId: this.tenantId, projectId: this.projectId };
       // no userId — shared across all users in the project
     }
     return { tenantId: this.tenantId, userId: this.userId, projectId: this.projectId };
   }
   ```

4. **Index change**: The current compound unique index `{ tenantId, userId, projectId, key }` won't work for project-scoped facts (no userId). Options:
   - Partial index: separate unique index for `scope: 'project'` on `{ tenantId, projectId, key }`
   - Sentinel value: store `userId: "__project__"` for project-scoped facts (simpler, keeps one index)

5. **Access control**: Project-scoped facts should be **write-restricted** — only admin roles or specific agents should write them. Regular user sessions get read-only access.

**Code references**:

- Required userId: `fact.model.ts:40`
- Compound unique index: `fact.model.ts:58`
- ownerFilter: `mongodb-fact-store.ts:91`

### GAP-10: IDENTITY Fields (GOAL, PERSONA, LIMITATIONS) Not Interpolated

**Severity**: Feature limitation — agent identity cannot adapt to session state.

**Problem**: `buildSystemPrompt()` uses `ir.identity.goal`, `ir.identity.persona`, and `ir.identity.limitations` as raw strings without calling `interpolateTemplate()`. Template syntax `{{variable}}` in IDENTITY fields is passed literally to the LLM instead of being resolved from `session.data.values`.

**Current code** (`prompt-builder.ts:117-131`):

```typescript
if (ir.identity?.goal) {
  parts.push(`\nYour goal: ${ir.identity.goal}`); // raw string, no interpolation
}
if (ir.identity?.persona) {
  parts.push(`\nPersona: ${ir.identity.persona}`); // raw string, no interpolation
}
for (const limitation of ir.identity.limitations) {
  parts.push(`- ${limitation}`); // raw string, no interpolation
}
```

**What breaks**: DSL like this silently passes literal `{{}}` to the LLM:

```abl
GOAL: "Help {{customer_name}} book travel. Phase: {{current_phase}}"
# LLM sees: "Help {{customer_name}} book travel. Phase: {{current_phase}}"
# Expected: "Help John book travel. Phase: discovery"
```

**Contrast**: RESPOND, PROMPT, SET, constraint messages — all already call `interpolateTemplate()` and resolve correctly.

**Use cases blocked**:

- Session-personalized identity (user name, tier, company branding)
- Multi-phase workflows with changing agent objectives
- Tier-based capabilities (VIP vs standard behavior)
- Error recovery mode (switch agent goal when tools are down)
- Conditional constraints based on conversation state
- Multi-tenancy (same DSL, different branding per project)

See **Dynamic Prompt Resolution** section above for 9 detailed patterns and examples.

**Fix**:

```typescript
// prompt-builder.ts - buildSystemPrompt()
if (ir.identity?.goal) {
  const goal = interpolateTemplate(ir.identity.goal, session.data.values);
  parts.push(`\nYour goal: ${goal}`);
}
if (ir.identity?.persona) {
  const persona = interpolateTemplate(ir.identity.persona, session.data.values);
  parts.push(`\nPersona: ${persona}`);
}
for (const limitation of ir.identity.limitations) {
  const interpolated = interpolateTemplate(limitation, session.data.values);
  parts.push(`- ${interpolated}`);
}
```

**Caching note**: If no `{{}}` is used, `interpolateTemplate()` is a no-op — zero performance impact for existing agents. Users opt into dynamic behavior (and reduced caching) by using template syntax.

**Code references**:

- Missing interpolation: `prompt-builder.ts:117-131`
- Template engine: `value-resolution.ts:11-73`
- Already interpolated elsewhere: `flow-step-executor.ts:482` (RESPOND), `constraint-checker.ts:223` (MESSAGE)

### Note: REMEMBER, RECALL, and Persistent Keys Don't Need to Match

The three mechanisms are **independent by design**:

- `persistent:` declares what **this agent** reads at session start
- `remember:` writes to FactStore for **any agent** in **any future session** to read
- `recall:` reads from FactStore on events for **this agent**

Keys being different across these sections is intentional — not a bug. Example:

- Sales_Agent REMEMBER writes `destination_preference` → Recommendations_Agent reads it via `persistent:`
- Sales_Agent persistent reads `user.preferred_destinations` → written by Profile_Agent's REMEMBER

The FactStore is a **shared database** scoped to `(tenantId, userId, projectId)`. Writers and readers don't have to be the same agent.

---

## Multi-Agent Context: Threads, Handoff, Delegate, Fan-Out

### Overview

Each agent runs in its own **thread** (`AgentThread`). Threads have independent `data.values` (context) and `conversationHistory` (messages). When the session transitions between agents, a new thread is created — context and history are **not shared by default**. You explicitly control what gets passed.

**Key type** (`types.ts:40-61`):

```typescript
export interface AgentThread {
  agentName: string;
  agentIR: AgentIR | null;
  conversationHistory: Array<{ role: string; content: string | ContentBlock[] }>; // per-thread
  data: SessionDataStore; // per-thread data.values
  state: RuntimeState; // per-thread state
  handoffFrom?: string;
  handoffContext?: Record<string, unknown>;
  returnExpected: boolean;
  status: 'active' | 'waiting' | 'completed' | 'escalated';
}
```

**Thread creation** (`types.ts:318-354`):

```typescript
const thread: AgentThread = {
  agentName,
  agentIR,
  conversationHistory: options?.initialHistory ? [...options.initialHistory] : [], // fresh or copied
  data: {
    values: options?.initialData ? { ...options.initialData } : {}, // fresh or from handoff
    gatheredKeys: new Set(), // always empty
  },
};
session.threads.push(thread);
```

### What's shared vs. per-thread

| Aspect                          | Scope                      | Details                                                                                 |
| ------------------------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `data.values` (Current Context) | **Per-thread**             | Each agent has its own context map                                                      |
| `conversationHistory`           | **Per-thread**             | Each agent has its own message history                                                  |
| `gatheredKeys`                  | **Per-thread**             | Always starts empty for new thread                                                      |
| `state.gatherProgress`          | **Per-thread**             | Always starts empty for new thread                                                      |
| `session.factStore`             | **Shared (session-level)** | Same FactStore instance — all agents read/write to same `(tenantId, userId, projectId)` |
| `session.id`                    | **Shared**                 | Same session ID throughout                                                              |
| `session.callerContext`         | **Shared**                 | Same user identity for all agents                                                       |
| `session.threads`               | **Shared**                 | Parent can access child thread results                                                  |

**FactStore is the cross-agent communication channel.** One agent's REMEMBER writes are readable by another agent's RECALL or persistent. But `session.data.values` is per-agent-thread — isolated by default, connected only by explicit context passing.

### Three Agent Transition Types

|                          | **Handoff**                                            | **Delegate**                                                     | **Fan-Out**                                               |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| **Purpose**              | Transfer conversation to another agent                 | Single-shot subtask — call agent, get result, continue           | Parallel subtasks — multiple agents at once               |
| **New thread?**          | Yes                                                    | Yes (ephemeral)                                                  | Yes (one per child)                                       |
| **Context passing**      | `CONTEXT: pass: [field1, ...]`                         | `INPUT: { key: value }`                                          | Per-task `CONTEXT: { key: value }`                        |
| **Conversation history** | Configurable: `full`, `last_n`, `none`, `summary_only` | **Always empty**                                                 | **Always empty**                                          |
| **User messages after**  | Go to **new agent**                                    | **No user messages** — single-shot                               | **No user messages** — single-shot per child              |
| **Parent thread**        | Paused (if `RETURN: true`) or completed                | Paused — blocks until delegate returns                           | Paused — blocks until all children finish                 |
| **Child return**         | `__return_to_parent__` tool (digression → parent)      | N/A — always runs to completion                                  | N/A — always runs to completion                           |
| **Thread resume**        | Yes — waiting threads reactivated on re-route          | No — ephemeral threads                                           | No — ephemeral threads                                    |
| **Result flow**          | Parent resumes with own context (if RETURN)            | Result stored in parent as `delegate_result` or `USE_RESULT` key | All results merged into parent via `mergeFanOutResults()` |
| **Code**                 | `routing-executor.ts:288`                              | `routing-executor.ts:738`                                        | `routing-executor.ts:972`                                 |

### Handoff — Transfer Conversation

Handoff transfers the active conversation to another agent. The user's subsequent messages go to the new agent.

#### DSL Syntax

```abl
SUPERVISOR: Travel_Supervisor

HANDOFF:
  # Transfer with full history and context
  - TO: Booking_Agent
    WHEN: intent == "booking"
    CONTEXT:
      pass: [user_id, destination, dates, num_guests]
      summary: "User wants to book a hotel in {{destination}} for {{num_guests}} guests"
    HISTORY: full
    RETURN: true       # control returns to supervisor after Booking_Agent completes

  # Transfer with no history (fresh start)
  - TO: Support_Agent
    WHEN: intent == "support"
    CONTEXT:
      pass: [user_id, booking_id]
      summary: "User needs help with booking {{booking_id}}"
    HISTORY: none
    RETURN: false      # permanent transfer, supervisor doesn't resume
```

#### What happens at runtime

```
Thread 0: Travel_Supervisor
  data.values = {
    user_id: "usr-123",
    destination: "Paris",
    dates: "Mar 10-15",
    num_guests: 2,
    intent: "booking",
    routing_history: ["welcome", "classify"],
    last_classify_intent_result: { category: "booking", confidence: 0.95 }
  }
  conversationHistory = [
    { user: "I want to book a hotel in Paris for 2 people" },
    { assistant: "I'll connect you with our booking specialist." }
  ]

──── HANDOFF (pass: [user_id, destination, dates, num_guests], HISTORY: full) ────

Thread 1: Booking_Agent (NEW)
  data.values = {
    handoff_from: "Travel_Supervisor",
    user_id: "usr-123",              ← passed
    destination: "Paris",             ← passed
    dates: "Mar 10-15",              ← passed
    num_guests: 2,                   ← passed
    _handoff_summary: "User wants to book a hotel in Paris for 2 guests"
    // intent: NOT passed — not in pass list
    // routing_history: NOT passed
    // last_classify_intent_result: NOT passed
  }
  conversationHistory = [             ← COPIED (HISTORY: full)
    { user: "I want to book a hotel in Paris for 2 people" },
    { assistant: "I'll connect you with our booking specialist." }
  ]

→ User's next messages go to Booking_Agent
→ Supervisor thread is PAUSED (RETURN: true), pushed to threadStack
→ When Booking_Agent completes, Supervisor resumes with its ORIGINAL context
```

#### Digression handling (return-to-parent and thread resume)

When a child agent invoked with `RETURN: true` encounters a user request it can't handle, it calls `__return_to_parent__` to return control to the supervisor. The child's thread is set to `waiting` (not `completed`), preserving all its state.

```
Thread 0: Supervisor (PAUSED, in threadStack)
Thread 1: CreditCardAgent (ACTIVE)
  data.values = { transaction_id: "TXN-123", amount: 500 }
  conversationHistory = [
    { user: "I want to pay $500" },
    { assistant: "Processing payment TXN-123 for $500. Please confirm." }
  ]

──── User says: "what's my balance?" ────
──── CreditCardAgent calls __return_to_parent__(reason: "out of scope", message: "what's my balance?") ────

Thread 0: Supervisor (ACTIVE — resumed)
  conversationHistory = [
    ...,
    { user: "what's my balance?" }   ← forwarded message injected
  ]
Thread 1: CreditCardAgent (WAITING — preserves all data and history)

──── Supervisor routes to AccountInfoAgent ────
──── AccountInfoAgent completes ────
──── Supervisor routes back to CreditCardAgent ────

Thread 1: CreditCardAgent (ACTIVE — RESUMED, not new)
  data.values = { transaction_id: "TXN-123", amount: 500 }  ← PRESERVED
  conversationHistory = [                                     ← PRESERVED
    { user: "I want to pay $500" },
    { assistant: "Processing payment TXN-123 for $500. Please confirm." }
  ]
```

**Thread resume merge rules**: When resuming a waiting thread with new context from the supervisor:

- Existing `data.values` keys are **NOT overwritten** (preserves gathered data)
- Keys starting with `_` (system keys) **are always overwritten**
- New keys that don't exist in the thread **are added**

#### History strategies

| Strategy       | DSL                     | What child gets                                  | Use case                                                     |
| -------------- | ----------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `full`         | `HISTORY: full`         | Complete copy of parent's conversation           | Agent needs full context                                     |
| `last_n`       | `HISTORY: last_n: 5`    | Last 5 messages only                             | Agent needs recent context, not full history                 |
| `none`         | `HISTORY: none`         | Empty — starts fresh                             | Agent has its own greeting/flow, doesn't need parent context |
| `summary_only` | `HISTORY: summary_only` | Empty history, but `_handoff_summary` in context | Lightweight — just a text summary                            |

#### Code references

- Thread creation: `routing-executor.ts:288`
- Context merging: `routing-executor.ts:219-230` (only `pass` fields copied)
- History strategy resolution: `routing-executor.ts:278-286`
- Parent pause/resume: `routing-executor.ts:265-271` (threadStack push)

### Delegate — Single-Shot Subtask

Delegate runs another agent as a function call — send input, get result, continue. No user interaction with the delegate agent.

#### DSL Syntax

```abl
AGENT: Booking_Agent

DELEGATE:
  - TO: Email_Verifier
    INPUT:
      email: user_email
      verification_type: "booking_confirmation"
    USE_RESULT: verification_result
    TIMEOUT: 10s

  - TO: Price_Calculator
    INPUT:
      hotel_id: selected_hotel_id
      dates: booking_dates
      guests: num_guests
    USE_RESULT: price_breakdown
    TIMEOUT: 15s
    RETURNS:
      total_price: result.total
      tax_amount: result.taxes
```

#### What happens at runtime

```
Thread 0: Booking_Agent (active, user is chatting here)
  data.values = {
    user_email: "john@example.com",
    selected_hotel_id: "htl-456",
    booking_dates: "Mar 10-15",
    num_guests: 2
  }
  │
  ├── DELEGATE TO Email_Verifier
  │     │
  │     └── Thread 1: Email_Verifier (ephemeral)
  │           data.values = {
  │             email: "john@example.com",           ← from INPUT mapping
  │             verification_type: "booking_confirmation",
  │             delegate_from: "Booking_Agent"
  │           }
  │           conversationHistory = []               ← ALWAYS EMPTY
  │           │
  │           ├── Runs single executeMessage() with input as message
  │           ├── Email_Verifier calls verify_email tool, gets result
  │           ├── Returns: { response: "Email verified successfully" }
  │           └── status: completed
  │     │
  │     ← Thread 0 resumes
  │       data.values["verification_result"] = "Email verified successfully"
  │
  ├── DELEGATE TO Price_Calculator
  │     │
  │     └── Thread 2: Price_Calculator (ephemeral)
  │           data.values = {
  │             hotel_id: "htl-456",
  │             dates: "Mar 10-15",
  │             guests: 2,
  │             delegate_from: "Booking_Agent"
  │           }
  │           conversationHistory = []
  │           │
  │           ├── Returns: { response: { total: 1500, taxes: 150, ... } }
  │           └── status: completed
  │     │
  │     ← Thread 0 resumes
  │       data.values["price_breakdown"] = { total: 1500, taxes: 150, ... }
  │       data.values["total_price"] = 1500        ← from RETURNS mapping
  │       data.values["tax_amount"] = 150          ← from RETURNS mapping
  │
  └── Booking_Agent continues conversation with user
      Can now use {{verification_result}} and {{total_price}} in RESPOND
```

#### Key differences from Handoff

- **No conversation history passed** — delegate thread always starts empty
- **No user interaction** — delegate runs a single `executeMessage()` and returns
- **Parent blocks** — waits for delegate to finish (or timeout)
- **Result flows back** — stored on parent via `USE_RESULT` key and optional `RETURNS` mapping
- **Ephemeral** — delegate thread is marked `completed` immediately after

#### Code references

- Thread creation: `routing-executor.ts:738`
- Input mapping: `routing-executor.ts:740` (`initialData: { ...delegateInput }`)
- Parent blocks: `routing-executor.ts:773-778` (`Promise.race` with timeout)
- Result stored on parent: `routing-executor.ts:793-794`
- Returns mapping: `routing-executor.ts:787-789`

### Fan-Out — Parallel Subtasks

Fan-Out dispatches multiple agents for a multi-intent user message. Each child handles one intent independently.

#### DSL Syntax

```abl
SUPERVISOR: Travel_Supervisor

# LLM detects multiple intents → automatically uses FAN_OUT tool
# Example: "Search for flights to Paris and also check my booking status"
# → Two intents: search (Flight_Agent) + status check (Booking_Agent)
```

Fan-Out is typically triggered by the LLM (via the `__fan_out` system tool) when it detects multiple intents, not declared explicitly in DSL. The LLM passes:

```json
{
  "tasks": [
    {
      "target": "Flight_Agent",
      "intent": "search flights to Paris",
      "context": { "destination": "Paris" }
    },
    {
      "target": "Booking_Agent",
      "intent": "check booking status",
      "context": { "booking_id": "BK-789" }
    }
  ]
}
```

#### What happens at runtime

```
Thread 0: Travel_Supervisor
  data.values = { user_id: "usr-123", destination: "Paris", booking_id: "BK-789" }
  │
  ├── FAN_OUT: 2 tasks
  │     │
  │     ├── Thread 1: Flight_Agent (child)
  │     │     data.values = {
  │     │       destination: "Paris",              ← from task.context
  │     │       _fan_out_intent: "search flights to Paris",
  │     │       _fan_out_child: true,
  │     │       delegate_from: "Travel_Supervisor"
  │     │     }
  │     │     conversationHistory = []             ← ALWAYS EMPTY
  │     │     Runs single executeMessage() → returns result
  │     │     status: completed
  │     │
  │     ├── Thread 2: Booking_Agent (child)
  │     │     data.values = {
  │     │       booking_id: "BK-789",              ← from task.context
  │     │       _fan_out_intent: "check booking status",
  │     │       _fan_out_child: true,
  │     │       delegate_from: "Travel_Supervisor"
  │     │     }
  │     │     conversationHistory = []
  │     │     Runs single executeMessage() → returns result
  │     │     status: completed
  │     │
  │     ← All children complete
  │       Results merged into Thread 0 via mergeFanOutResults()
  │       data.values["_stored_Flight_Agent"] = { response: "Found 5 flights..." }
  │       data.values["_stored_Booking_Agent"] = { response: "Booking BK-789 is confirmed..." }
  │
  └── Supervisor synthesizes unified response from all child results
      "Here's what I found: 5 flights to Paris available. Your booking BK-789 is confirmed."
```

#### Key differences from Delegate

- **Multiple agents** run (one per task/intent)
- **Context is per-task** — each child gets only its task's context, not the full parent context
- **Results are merged** — all child results stored under `_stored_<AgentName>` keys
- **Supervisor synthesizes** — LLM receives all results and produces a unified response

#### Code references

- Child thread creation: `routing-executor.ts:972-980`
- Per-task context: `routing-executor.ts:974-979` (`initialData: { ...task.context }`)
- Result merge: `routing-executor.ts:1441` (`mergeFanOutResults`)
- Stored results: `routing-executor.ts:1177, 1583` (`values[_stored_<key>]`)

### Thread Lifecycle Diagram

```
Session Start
  │
  └─ Thread 0: Supervisor (active)
       │
       ├── HANDOFF (RETURN: true)
       │     Thread 0 → PAUSED (pushed to threadStack)
       │     Thread 1: Agent_A → ACTIVE (user messages go here)
       │     │
       │     ├── DELEGATE
       │     │     Thread 1 → BLOCKED (waiting)
       │     │     Thread 2: Helper_Agent → runs single-shot → COMPLETED
       │     │     Thread 1 → ACTIVE (resumes with delegate result)
       │     │
       │     ├── FAN_OUT (2 tasks)
       │     │     Thread 1 → BLOCKED (waiting)
       │     │     Thread 3: Child_A → runs single-shot → COMPLETED
       │     │     Thread 4: Child_B → runs single-shot → COMPLETED
       │     │     Thread 1 → ACTIVE (resumes with merged results)
       │     │
       │     └── Agent_A completes → COMPLETED
       │
       └─ Thread 0: Supervisor → ACTIVE (resumes from threadStack)
            Has its ORIGINAL context (not Agent_A's context)
            Can access Agent_A's result if configured
```

### Context Flow Summary

| Transition   | What context child gets                            | What history child gets                                   | What parent gets back                               |
| ------------ | -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **Handoff**  | Only `CONTEXT: pass` fields + `_handoff_summary`   | Configurable: `full` / `last_n` / `none` / `summary_only` | Nothing (or resumes own context if RETURN: true)    |
| **Delegate** | Only `INPUT` fields + `delegate_from`              | Always empty                                              | `USE_RESULT` key + optional `RETURNS` mapping       |
| **Fan-Out**  | Only per-task `context` fields + `_fan_out_intent` | Always empty                                              | `_stored_<AgentName>` per child, merged into parent |

### Cross-Agent Communication Patterns

#### Pattern 1: Explicit Context Passing (Handoff)

```abl
# Supervisor passes specific fields to specialist
HANDOFF:
  - TO: Booking_Agent
    CONTEXT:
      pass: [user_id, destination, dates, num_guests, loyalty_tier]
```

Only listed fields arrive in the child's `data.values`. Everything else stays in the parent.

#### Pattern 2: Delegate Result Mapping

```abl
# Parent calls child, maps specific return fields
DELEGATE:
  - TO: Price_Calculator
    INPUT:
      hotel_id: selected_hotel_id
    USE_RESULT: price_result
    RETURNS:
      total_price: result.total
      currency: result.currency
```

Parent gets `price_result` (full response) plus `total_price` and `currency` (mapped fields).

#### Pattern 3: FactStore as Shared Memory

```abl
# Agent A writes to FactStore
MEMORY:
  remember:
    - WHEN: destination IS SET
      STORE: destination -> user.preferred_destinations
      TTL: 365d

# Agent B reads from FactStore (different agent, different session even)
MEMORY:
  persistent:
    - user.preferred_destinations
      ACCESS: read
      TYPE: array
      DEFAULT_VALUE: []
```

FactStore persists across agents and sessions. This is the only way to share data beyond the immediate handoff/delegate context.

#### Pattern 4: Fan-Out Result Synthesis

```abl
# Supervisor dispatches to multiple agents, LLM synthesizes
# After fan-out, supervisor's data.values contains:
#   _stored_Flight_Agent = { response: "Found 5 flights..." }
#   _stored_Hotel_Agent = { response: "Found 3 hotels..." }
#   _stored_Car_Agent = { response: "Found 2 rentals..." }
#
# Supervisor LLM sees all results in Current Context and produces:
# "For your Paris trip: 5 flights, 3 hotels, and 2 car rentals available."
```

---

## Tools in ABL: System Tools, Regular Tools, and LLM Integration

### Overview

The LLM receives tools as JSON schemas alongside the system prompt and conversation history. Tools are the LLM's only way to take actions — route to agents, call APIs, escalate, complete. The LLM decides which tool to call based on the conversation and system prompt instructions.

There are two categories:

| Category              | Examples                                                     | Defined by                    | Who decides to call   |
| --------------------- | ------------------------------------------------------------ | ----------------------------- | --------------------- |
| **System tools**      | `__handoff__`, `__delegate__`, `__escalate__`, `__fan_out__` | Runtime (prompt-builder.ts)   | LLM                   |
| **Regular tools**     | `search_hotels`, `create_booking`, `check_inventory`         | DSL author (TOOLS section)    | LLM                   |
| **Runtime-evaluated** | `__complete__`                                               | Runtime (routing-executor.ts) | **Runtime** (not LLM) |

### How Tools Are Built and Sent to the LLM

`buildTools()` at `prompt-builder.ts:375-582` constructs the tools array:

1. Regular tools from `ir.tools` (lines 389-418) — converted from `ToolDefinition` IR to LLM JSON schema
2. System tools added conditionally based on agent configuration (lines 420-579)

The LLM tool schema format (`compiler/src/platform/llm/types.ts:141`):

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
}
```

### Regular Tools (User-Defined)

Declared in the ABL DSL's `TOOLS` section. Compiled into `ir.tools` array. Each tool has a backend binding (HTTP, MCP, Lambda, Sandbox).

#### DSL Example

```abl
AGENT: Booking_Agent
MODE: reasoning

TOOLS:
  - search_hotels:
      TYPE: http
      URL: "https://api.example.com/hotels/search"
      METHOD: POST
      DESCRIPTION: "Search for available hotels"
      PARAMS:
        destination:
          TYPE: string
          DESCRIPTION: "City or region to search"
          REQUIRED: true
        check_in:
          TYPE: string
          DESCRIPTION: "Check-in date (YYYY-MM-DD)"
          REQUIRED: true
        check_out:
          TYPE: string
          DESCRIPTION: "Check-out date (YYYY-MM-DD)"
          REQUIRED: true
        guests:
          TYPE: number
          DESCRIPTION: "Number of guests"
          REQUIRED: false

  - create_booking:
      TYPE: http
      URL: "https://api.example.com/bookings"
      METHOD: POST
      DESCRIPTION: "Create a hotel booking"
      PARAMS:
        hotel_id:
          TYPE: string
          REQUIRED: true
        room_type:
          TYPE: string
          REQUIRED: true
        guest_name:
          TYPE: string
          REQUIRED: true
```

#### Tool Schema Sent to LLM

`prompt-builder.ts:392-416` converts each tool:

```json
{
  "name": "search_hotels",
  "description": "Search for available hotels",
  "input_schema": {
    "type": "object",
    "properties": {
      "destination": { "type": "string", "description": "City or region to search" },
      "check_in": { "type": "string", "description": "Check-in date (YYYY-MM-DD)" },
      "check_out": { "type": "string", "description": "Check-out date (YYYY-MM-DD)" },
      "guests": { "type": "number", "description": "Number of guests" }
    },
    "required": ["destination", "check_in", "check_out"]
  }
}
```

#### Execution Path

```
LLM returns: tool_use("search_hotels", { destination: "Paris", check_in: "2026-03-10", ... })
  ↓
reasoning-executor.ts:550-553 — regular tool branch
  ↓
session.toolExecutor.execute("search_hotels", params, 30000)
  ↓
ToolBindingExecutor routes by tool_type:
  ├── http    → HttpToolExecutor    (HTTP call to configured URL)
  ├── mcp     → McpToolExecutor     (MCP protocol call)
  ├── lambda  → LambdaToolExecutor  (AWS Lambda invoke)
  └── sandbox → SandboxToolExecutor (gVisor sandboxed execution)
  ↓
Result returned as unknown
  ↓
session.data.values["last_search_hotels_result"] = toolResult   (line 604)
```

#### Tool Backend Types

| Type      | DSL             | Executor              | What it does                                                                                    |
| --------- | --------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `http`    | `TYPE: http`    | `HttpToolExecutor`    | HTTP request to URL with params as body/query. SSRF protection, rate limiting, circuit breaker. |
| `mcp`     | `TYPE: mcp`     | `McpToolExecutor`     | Model Context Protocol call to an MCP server.                                                   |
| `lambda`  | `TYPE: lambda`  | `LambdaToolExecutor`  | AWS Lambda function invocation.                                                                 |
| `sandbox` | `TYPE: sandbox` | `SandboxToolExecutor` | Code execution in gVisor sandbox (isolated).                                                    |

#### Tool IR Schema (`schema.ts:297-330`)

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: ToolHints;
  system?: boolean; // true for __handoff__, etc.
  tool_type?: 'http' | 'mcp' | 'lambda' | 'sandbox';
  http_binding?: HttpBindingIR; // URL, method, headers, auth
  mcp_binding?: McpBindingIR; // server, tool name
  lambda_binding?: LambdaBindingIR; // function ARN, region
  sandbox_binding?: SandboxBindingIR; // runtime, code
}
```

#### Tool Result Storage

After a tool call, the result is stored in `session.data.values`:

- **Reasoning mode**: `session.data.values[last_<tool>_result] = toolResult` at `reasoning-executor.ts:604` — raw dump of entire result
- **Flow mode**: `session.data.values[last_<tool>_result] = toolResult` plus explicit SET mapping via `ON_SUCCESS SET` / `ON_RESULT WHEN ... SET` at `flow-step-executor.ts:2231`

See **GAP-12** for limitations of reasoning mode's raw dump approach.

### System Tool: `__handoff__` — Route to Another Agent

**Added when**: Agent has `routing.rules` or `coordination.handoffs` (`prompt-builder.ts:420-481`)

**Purpose**: Transfer the active conversation to a different agent. Used by supervisors for routing and by specialists for cross-expertise transfers.

#### DSL Example

```abl
SUPERVISOR: Travel_Supervisor

HANDOFF:
  - TO: Booking_Agent
    WHEN: intent == "booking"
    CONTEXT:
      pass: [user_id, destination, dates]
      summary: "User wants to book in {{destination}}"
    HISTORY: full
    RETURN: true

  - TO: Support_Agent
    WHEN: intent == "support"
    CONTEXT:
      pass: [user_id, booking_id]
    HISTORY: none
    RETURN: false
```

#### Tool Schema Sent to LLM

```json
{
  "name": "__handoff__",
  "description": "MANDATORY: Use this tool to route the user to the appropriate specialist. Available targets: Booking_Agent (returns), Support_Agent. You MUST call this for every user message.",
  "input_schema": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "description": "The name of the agent to hand off to. REQUIRED for every user message.",
        "enum": ["Booking_Agent", "Support_Agent"]
      },
      "context": {
        "type": "string",
        "description": "JSON context to pass to the target agent (optional)"
      }
    },
    "required": ["target"]
  }
}
```

For supervisor agents, the description is **MANDATORY** — the LLM must call `__handoff__` for every message. For regular agents with handoff capability, the description says "Only use when the request is outside your expertise."

#### System Prompt Instructions (`prompt-builder.ts:163-201`)

For supervisors:

```
## Your Role
You are a ROUTING-ONLY supervisor. You do NOT answer questions directly.
DO NOT ask users clarifying questions - pick the best matching agent and hand off immediately.

## Routing Rules (use __handoff__ tool with target parameter):
- **Booking_Agent**: When user wants to book
- **Support_Agent**: When user needs support

## MANDATORY: Always use __handoff__ tool
For EVERY user message, you MUST call the __handoff__ tool with the appropriate target.
NEVER respond without using __handoff__. You are a router, not a conversationalist.
```

#### Execution (`reasoning-executor.ts:462-478`)

```
LLM calls: __handoff__({ target: "Booking_Agent", context: "{\"destination\": \"Paris\"}" })
  ↓
routing.handleHandoff(session, "Booking_Agent", context)   (routing-executor.ts:219)
  ↓
1. Build mergedContext from CONTEXT.pass fields + LLM context
2. Resolve history strategy (full/last_n/none/summary_only)
3. createThread(session, "Booking_Agent", ir, { initialData: mergedContext, initialHistory })
4. If RETURN: true → push parent thread to threadStack
5. Switch activeThreadIndex to new thread
  ↓
User's next messages go to Booking_Agent
```

### System Tool: `__delegate__` — Single-Shot Subtask

**Added when**: Agent has `coordination.delegates` (`prompt-builder.ts:525-552`)

**Purpose**: Call another agent as a function — send input, get result, continue. No user interaction with the delegate.

#### DSL Example

```abl
AGENT: Booking_Agent

DELEGATE:
  - TO: Price_Calculator
    WHEN: needs_pricing
    PURPOSE: "Calculate total price with taxes"
    INPUT:
      hotel_id: selected_hotel_id
      dates: booking_dates
      guests: num_guests
    USE_RESULT: price_result
    RETURNS:
      total_price: result.total
      tax_amount: result.taxes
    TIMEOUT: 15s
```

#### Tool Schema Sent to LLM

```json
{
  "name": "__delegate__",
  "description": "Call a sub-agent and use their result. The sub-agent runs to completion and returns a result that you can use. Available targets: Price_Calculator: Calculate total price with taxes (when: needs_pricing)",
  "input_schema": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "description": "The name of the sub-agent to delegate to",
        "enum": ["Price_Calculator"]
      },
      "input": {
        "type": "object",
        "description": "Input data to pass to the sub-agent (will be mapped using delegate config if not provided)"
      }
    },
    "required": ["target"]
  }
}
```

#### Execution (`reasoning-executor.ts:479-485`)

```
LLM calls: __delegate__({ target: "Price_Calculator", input: { hotel_id: "htl-456" } })
  ↓
routing.handleDelegate(session, "Price_Calculator", input)   (routing-executor.ts:738)
  ↓
1. createThread(session, "Price_Calculator", ir, { initialData: { ...delegateInput, delegate_from } })
2. No conversation history passed (always empty)
3. Run single executeMessage() on delegate thread
4. Parent blocks via Promise.race with timeout
5. Result stored: session.data.values["price_result"] = result.response
6. RETURNS mapping: session.data.values["total_price"] = result.total
7. Delegate thread marked completed
  ↓
Parent agent continues with delegate result in context
```

### System Tool: `__fan_out__` — Parallel Multi-Intent Dispatch

**Added when**: Agent has handoff targets (same condition as `__handoff__`) (`prompt-builder.ts:483-522`)

**Purpose**: Handle a user message with multiple distinct requests by dispatching to multiple agents in parallel.

#### DSL Example

Fan-out is not explicitly declared in DSL — it's automatically available to any agent with handoff targets. The LLM decides to use it when it detects multiple intents:

```
User: "Search for flights to Paris and also check my booking status"
→ LLM detects 2 intents → calls __fan_out__
```

#### Tool Schema Sent to LLM

```json
{
  "name": "__fan_out__",
  "description": "Handle a message with MULTIPLE distinct requests needing different specialists. Use ONLY when the user asks 2+ unrelated things in one message. Results are returned for you to synthesize into one unified response. Available targets: Flight_Agent, Booking_Agent, Support_Agent.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tasks": {
        "type": "array",
        "description": "List of sub-tasks to dispatch to specialist agents",
        "items": {
          "type": "object",
          "properties": {
            "target": {
              "type": "string",
              "description": "The specialist agent to handle this sub-task",
              "enum": ["Flight_Agent", "Booking_Agent", "Support_Agent"]
            },
            "intent": {
              "type": "string",
              "description": "What this agent should handle (the user's sub-request)"
            },
            "context": {
              "type": "object",
              "description": "Optional context to pass to the agent"
            }
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

#### System Prompt Instructions (`prompt-builder.ts:182-187`)

```
## Multi-Intent Messages
If the user's message contains MULTIPLE distinct requests for different specialists,
use __fan_out__ to dispatch all at once.
You will receive all results and must synthesize one unified response.
Use __handoff__ for single-intent messages only.
```

#### Execution (`reasoning-executor.ts:486-508`)

```
LLM calls: __fan_out__({ tasks: [
  { target: "Flight_Agent", intent: "search flights to Paris", context: { destination: "Paris" } },
  { target: "Booking_Agent", intent: "check booking status", context: { booking_id: "BK-789" } }
]})
  ↓
routing.handleFanOut(session, tasks)   (routing-executor.ts:972)
  ↓
1. For each task: createThread(session, task.target, ir, { initialData: { ...task.context, _fan_out_intent } })
2. All children run in parallel (no conversation history, single executeMessage each)
3. All results collected via mergeFanOutResults()
4. Stored as: session.data.values["_stored_Flight_Agent"] = { response: "..." }
5. Stored as: session.data.values["_stored_Booking_Agent"] = { response: "..." }
  ↓
Supervisor LLM receives formatted results and synthesizes one response:
"For your Paris trip: 5 flights available. Your booking BK-789 is confirmed."
```

### System Tool: `__escalate__` — Transfer to Human Agent

**Added when**: Agent has `coordination.escalation` configured (`prompt-builder.ts:557-579`)

**Purpose**: Transfer the conversation to a human agent when the AI cannot help.

#### DSL Example

```abl
AGENT: Support_Agent

ESCALATE:
  TRIGGERS:
    - WHEN: "Customer requests supervisor"
      PRIORITY: high
    - WHEN: "System error persists after retry"
      PRIORITY: critical
  CONTEXT_FOR_HUMAN: [user_id, booking_id, issue_summary, conversation_summary]
```

#### Tool Schema Sent to LLM

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

#### System Prompt Instructions (`prompt-builder.ts:204-215`)

```
## Escalation
Use the __escalate__ tool ONLY if:
- Customer requests supervisor (priority: high)
- System error persists after retry (priority: critical)
- The user explicitly and repeatedly asks for a human agent

IMPORTANT: Always attempt to help the user at least once before escalating.
Do NOT escalate for normal routing - use __handoff__ instead.
```

#### Execution (`reasoning-executor.ts:522-546`)

```
LLM calls: __escalate__({ reason: "User insists on human agent", priority: "high" })
  ↓
1. Emit warning trace if escalation on first message (line 525)
2. routing.handleEscalate(session, input)
3. session.isEscalated = true
4. session.escalationReason = "User insists on human agent"
5. Break tool-use loop
  ↓
User sees: "Escalated to Human Agent. Reason: User insists on human agent. Priority: high."
```

### Runtime-Evaluated: `__complete__` — Session Completion

**NOT sent to LLM as a tool.** Removed from the tools list (`prompt-builder.ts:554-555`).

**Purpose**: Mark the session as complete when DSL-defined conditions are met. Evaluated by the runtime after each turn — the LLM does not decide this.

#### DSL Example

```abl
AGENT: Booking_Agent

COMPLETE:
  - WHEN: "booking_confirmed == true AND payment_status == 'paid'"
    RESPOND: "Your booking is confirmed! Confirmation code: {{confirmation_code}}"
    STORE: booking_result

  - WHEN: "user_cancelled == true"
    RESPOND: "Your booking has been cancelled. Let me know if you need anything else."
```

#### How It Works

After each reasoning turn, `runtime-executor.ts:1148-1158` checks:

```typescript
if (!session.isComplete && result.action?.type !== 'complete' && ...) {
    if (this.routing.checkAndMarkComplete(session, onTraceEvent)) {
        result.action = { type: 'complete', message: result.response };
        tryThreadReturn(session, result.response, onTraceEvent);
    }
}
```

`checkAndMarkComplete()` at `routing-executor.ts:1171-1206`:

```typescript
for (const condition of ir.completion.conditions) {
  const isComplete = compilerEvaluateCondition(condition.when, context);
  if (isComplete) {
    session.isComplete = true;
    session.state.conversationPhase = 'complete';
    // Store results if configured
    // Trigger thread return if in a handoff chain
  }
}
```

Evaluates each `WHEN` condition against `session.data.values`. First match wins.

#### Why Not a Tool?

Completion is a **runtime guarantee**, not an LLM decision. If the conditions are met (all required data collected, payment confirmed, etc.), the session completes deterministically. The LLM can't forget to complete or complete prematurely — the runtime evaluates conditions against actual state.

The `SYSTEM_TOOL_COMPLETE` constant still exists in code as a safety net (`reasoning-executor.ts:514-521`) — if the LLM somehow calls it (from cached tool lists or tests), it still works. But the tool is no longer sent in the tools array.

### Conversation History and Tool Calls

Tool call/result exchanges are **ephemeral** — they exist only during a single `execute()` call.

```
Persisted (session.conversationHistory):
  [user] "Find hotels in Paris for 2 guests"
  [assistant] "I found 5 hotels in Paris. The cheapest is Hotel Lumiere at $120/night."

Ephemeral (local messages array, discarded after execute()):
  [user] "Find hotels in Paris for 2 guests"
  [assistant] { tool_use: "search_hotels", input: { destination: "Paris", guests: 2 } }
  [user] { tool_result: id=xyz, content: '{"count":5,"hotels":[...]}' }
  [assistant] { tool_use: "check_availability", input: { hotel_id: "htl-1" } }
  [user] { tool_result: id=abc, content: '{"available":true,"price":120}' }
  [assistant] "I found 5 hotels in Paris. The cheapest is Hotel Lumiere at $120/night."
```

- **Lines 309-312**: Tool_use blocks pushed to local `messages` array
- **Lines 374-378**: Tool_result blocks pushed to local `messages` array
- **Line 419**: Only the final text response saved to `session.conversationHistory`

On the next user message, the LLM has no memory of which tools it called — only its final summarized response. The intermediate tool reasoning is lost.

### Summary: All Tools at a Glance

| Tool                 | Type    | Sent to LLM? | When Available                      | LLM Schema Key Fields                                         | Execution                                        |
| -------------------- | ------- | ------------ | ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `search_hotels` etc. | Regular | Yes          | Always (from TOOLS DSL)             | `name`, `description`, `input_schema` with typed params       | `ToolBindingExecutor` → HTTP/MCP/Lambda/Sandbox  |
| `__handoff__`        | System  | Yes          | Agent has routing rules or handoffs | `target` (enum of agent names), `context` (optional JSON)     | `routing.handleHandoff()` → new thread           |
| `__delegate__`       | System  | Yes          | Agent has delegates configured      | `target` (enum of delegate agents), `input` (optional object) | `routing.handleDelegate()` → ephemeral thread    |
| `__fan_out__`        | System  | Yes          | Agent has handoff targets           | `tasks` (array of {target, intent, context}, 2-5 items)       | `routing.handleFanOut()` → parallel threads      |
| `__escalate__`       | System  | Yes          | Agent has escalation configured     | `reason` (required string), `priority` (enum)                 | `routing.handleEscalate()` → session.isEscalated |
| `__complete__`       | Runtime | **No**       | Always (evaluated by runtime)       | N/A — not a tool                                              | `routing.checkAndMarkComplete()` after each turn |

### Code References

- Tool schema builder: `prompt-builder.ts:375-582`
- Regular tool conversion: `prompt-builder.ts:389-418`
- Handoff tool: `prompt-builder.ts:441-481`
- Fan-out tool: `prompt-builder.ts:483-522`
- Delegate tool: `prompt-builder.ts:525-552`
- Escalate tool: `prompt-builder.ts:557-579`
- Complete removed: `prompt-builder.ts:554-555`
- Tool execution dispatch: `reasoning-executor.ts:444-637`
- Handoff execution: `reasoning-executor.ts:462-478` → `routing-executor.ts:219`
- Delegate execution: `reasoning-executor.ts:479-485` → `routing-executor.ts:738`
- Fan-out execution: `reasoning-executor.ts:486-508` → `routing-executor.ts:972`
- Escalate execution: `reasoning-executor.ts:522-546`
- Complete safety net: `reasoning-executor.ts:514-521`
- Runtime completion check: `runtime-executor.ts:1148-1158` → `routing-executor.ts:1171`
- Tool result storage: `reasoning-executor.ts:604`
- Tool_use to local messages: `reasoning-executor.ts:309-312`
- Tool_result to local messages: `reasoning-executor.ts:374-378`
- Final response to conversationHistory: `reasoning-executor.ts:418-419`
- ToolExecutor interface: `compiler/src/platform/constructs/types.ts:535-544`
- ToolBindingExecutor: `compiler/src/platform/constructs/executors/tool-binding-executor.ts:62`
- ToolDefinition IR: `compiler/src/platform/ir/schema.ts:297-330`

---

## Brainstorming: FactStore Storage Backend

### Current: MongoDB

The FactStore currently uses MongoDB with a compound unique index:

```
{ tenantId: 1, userId: 1, projectId: 1, key: 1 }
```

**Prefix search** (`load_memory`): Uses `$regex: "^prefix"` — MongoDB can use the index for anchored `^` prefix regex after narrowing by the first 3 fields. Fine for tens of facts per user.

**TTL**: Separate `expiresAt` index with `expireAfterSeconds: 0` — background cleanup is eventually consistent, so queries still need defensive expiry checks (`get()` at line 147 deletes expired docs on read).

**Values**: Stored as `JSON.stringify()` strings — can't query/filter by value content without parsing client-side.

### Why it works today

- Small dataset per user per project (10-50 facts typical)
- Compound index covers the ownership filter efficiently
- Anchored prefix regex uses the index (not a collection scan)
- MongoDB is already in the stack — no new infrastructure

### Where it could struggle at scale

| Concern                  | Detail                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Regex on index           | Anchored `^prefix` is a range scan, not a hash lookup. Thousands of facts per user = slower                                          |
| `$or` on expiresAt       | `$or: [null, $gte: now]` can't fully use the compound index — checks both branches                                                   |
| No hierarchical keys     | Keys like `preferences.travel.airlines` are flat strings — MongoDB doesn't understand the dot hierarchy, just string prefix matching |
| JSON string values       | Can't do `find({ value.budget: { $gt: 1000 } })` — values are opaque strings                                                         |
| TTL eventual consistency | Background TTL cleanup can lag — expired facts served until next read or background sweep                                            |

### Alternative backends to consider

| Backend                 | Strengths for this use case                                                                                                                                                                          | Trade-offs                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Redis**               | Already in the stack. Native key patterns (`SCAN`), per-key TTL (`EXPIRE`), hash fields for structured values. Purpose-built for key-value with expiry. O(1) get, O(n) scan but n is small per user. | Volatile (needs persistence config). No rich querying. Memory-bound.                      |
| **Redis + Sorted Sets** | `ZRANGEBYLEX` for native prefix queries without regex. Faster than `SCAN` with patterns.                                                                                                             | More complex data model — need to encode value separately.                                |
| **DynamoDB**            | Partition key = `tenantId#userId#projectId`, sort key = `key`. `begins_with()` for prefix — no regex, O(log n). Native TTL.                                                                          | New infrastructure. AWS-specific. Cost at scale per read/write.                           |
| **PostgreSQL**          | `LIKE 'prefix%'` with B-tree index is faster than regex. `jsonb` column for values enables in-DB value queries. Mature TTL via `pg_cron` or app-level.                                               | New infrastructure if not already used. Heavier than key-value stores.                    |
| **ClickHouse**          | Already in the stack (used for traces). Column-oriented — fast prefix scans.                                                                                                                         | Optimized for append-heavy analytics, not key-value CRUD. Poor update/delete performance. |

### Recommendation

For the current scale, **MongoDB is fine — no migration needed**. If facts-per-user grows significantly (hundreds+), **Redis** is the natural next step since it's already in the infrastructure and the FactStore pattern (key-value + TTL + prefix search) is exactly what Redis is designed for. The `FactStore` abstract class already supports pluggable backends, so a `RedisFactStore` implementation would slot in without changing any callers.

---

## Session Persistence & Thread Storage

### How Sessions Are Persisted

All agent threads live inside the session. The session is persisted to Redis (or in-memory) after every message.

**Storage hierarchy:**

```
Redis HASH: sess:{tenantId}:{sessionId}  (30min TTL)
  ├── id, agentName, version, tenantId, projectId, ...     (primitive fields as strings)
  ├── state: JSON                                           (encrypted at rest)
  ├── dataValues: JSON                                      (encrypted at rest)
  ├── threads: JSON  ← AgentThreadData[]                    (all threads serialized as one field)
  ├── activeThreadIndex: number
  ├── threadStack: JSON  ← number[]
  └── callerContext: JSON                                   (encrypted at rest)

Redis LIST: sess:{tenantId}:{sessionId}:conv  (30min TTL)
  └── [msg0, msg1, msg2, ...]                               (each message JSON-stringified)

Redis STRING: ir:{irSourceHash}  (2hr TTL, tenant-agnostic, gzipped)
  └── Full AgentIR JSON (shared across all sessions using this agent)

Redis STRING: comp:{compilationHash}  (2hr TTL, tenant-agnostic, gzipped)
  └── Full CompilationOutput JSON (shared across all sessions using this compilation)
```

**Key design decisions:**

- **IR not stored per-thread** — only the 16-char hash (`irSourceHash`) is stored per thread. Full IR lives at `ir:{hash}` and is shared across all sessions using the same agent. This avoids massive duplication.
- **Threads stored as one JSON blob** — `JSON.stringify(threads)` into a single hash field. Each `AgentThreadData` carries its own `conversationHistory`, `dataValues`, `state`, and flow position.
- **Sensitive fields encrypted** — `authToken`, `state`, `dataValues`, `callerContext` are encrypted with per-tenant DEKs via `EncryptionService` before writing to Redis.
- **`env` namespace stripped** — decrypted secret values (`session.data.values.env`) are removed before persistence (`runtime-executor.ts:1302`).

### Write Path: In-Memory → Redis

```
WebSocket handler (handler.ts:486)
  └── executor.saveSessionSnapshot(session)
        │
        ├── svc.store.load(session.id)           ← load existing SessionData for version
        ├── Copy mutable fields from RuntimeSession onto SessionData
        │     ├── state, conversationHistory, dataValues
        │     ├── isComplete, isEscalated, handoffStack
        │     ├── currentFlowStep, waitingForInput, pendingResponse
        │     └── threads = serializeThreads()    ← AgentThread[] → AgentThreadData[]
        │
        └── svc.saveSession(sessionData)
              └── store.save(updated)             ← RedisSessionStore.save()
                    │
                    ├── sessionToHash(session)    ← serialize all fields to Record<string, string>
                    │     ├── Primitive fields: String(value), encrypt if sensitive
                    │     └── JSON fields: JSON.stringify(value), encrypt if sensitive
                    │
                    └── redis.eval(LUA_SAVE, ...)  ← atomic version-check-then-save
                          ├── HGET version (check == expected)
                          ├── HSET all field/value pairs
                          ├── HINCRBY version +1
                          └── EXPIRE session TTL (30min)
```

### Read Path: Redis → In-Memory

```
SessionService.loadSession(sessionId)
  └── store.load(sessionId)                       ← RedisSessionStore.load()
        │
        ├── resolveTenantId(sessionId)            ← read sess-tid:{sessionId} reverse lookup
        ├── Pipeline (1 round-trip):
        │     ├── HGETALL sess:{tenantId}:{sessionId}
        │     └── LRANGE sess:{tenantId}:{sessionId}:conv 0 -1
        │
        └── hashToSession(hashData, convData)     ← deserialize
              ├── Decrypt conversation messages
              ├── Primitive fields: parse strings to proper types
              ├── JSON fields: decrypt if encrypted, then JSON.parse()
              └── threads: JSON.parse → AgentThreadData[]
```

### Factory: Which Store Gets Used

`ensureSessionService()` is called **once** at server startup (`server.ts:677-678`). It initializes the module-level singleton with `RedisSessionStore` if Redis is available, otherwise `MemorySessionStore`.

After that, every caller uses `getSessionService()` which returns the already-initialized singleton:

```typescript
// session-service.ts:388 — sync, returns existing singleton
export function getSessionService(): SessionService {
  if (!sessionServiceInstance) {
    // Fallback to memory if ensureSessionService() never ran
    sessionServiceInstance = new SessionService(new MemorySessionStore());
  }
  return sessionServiceInstance;
}
```

**Call chain:** `server.ts:678` calls `ensureSessionService(config.session)` → creates `RedisSessionStore` → sets `sessionServiceInstance`. All subsequent `getSessionService()` calls return the same Redis-backed instance.

### TTL Behavior

| Key                                | TTL       | Refreshed by                                           |
| ---------------------------------- | --------- | ------------------------------------------------------ |
| `sess:{tenantId}:{sessionId}`      | 30 min    | `touch()` on every message, `save()` on every snapshot |
| `sess:{tenantId}:{sessionId}:conv` | 30 min    | `touch()` on every message                             |
| `ir:{hash}`                        | 2 hours   | Not refreshed — re-cached on next compilation/load     |
| `comp:{hash}`                      | 2 hours   | Not refreshed — re-cached on next compilation/load     |
| `lock:exec:{tenantId}:{sessionId}` | 5 seconds | Acquired per `processMessage`, released after          |

### Known Gaps

#### GAP-11: No Durable Session Persistence for Long-Lived Sessions

**Severity**: Architectural gap — sessions cannot survive inactivity beyond Redis TTL.

**Problem**: All session state (threads, conversation history, context, flow position) is stored in Redis with a **30-minute TTL** (`session/types.ts:169`). The TTL is refreshed on every message via `touch()`, so active sessions survive indefinitely. But any gap in user activity > 30 minutes causes Redis to expire the keys, and the session is **permanently lost**.

For use cases requiring long-lived sessions (days or weeks — e.g., multi-day booking flows, ongoing support cases, async workflows), the current architecture silently destroys the session on inactivity.

**What happens today:**

```
User sends message → session active in Redis (30min TTL refreshed)
  ↓
User goes idle for 31 minutes
  ↓
Redis keys expire → all threads, context, conversation history LOST
  ↓
User returns → session not found → new session created (no continuity)
```

**Dead code: Checkpointer** (`packages/compiler/src/platform/checkpointing/`): A `Checkpointer` abstract class with `MemoryCheckpointer` and `RedisCheckpointer` implementations exists in the compiler package. It was designed for exactly this use case (session recovery, long-running conversations, 24hr TTL). However:

1. **Never imported by the runtime** — zero references from `apps/runtime/src/`
2. **Wrong data model** — stores single-agent `Checkpoint` with compiler's `AgentState` type, not multi-agent `SessionData` with `AgentThreadData[]`, `threadStack`, `activeThreadIndex`
3. **Different message format** — `CheckpointMessage` (with `toolCalls[]`, `toolResults[]`) vs runtime's `{role, content}`

The Checkpointer was built before the thread model was introduced. It cannot represent a multi-agent session.

**Proposed fix — Tiered persistence (hot/cold):**

| Tier     | Store                                | TTL                       | Purpose                               |
| -------- | ------------------------------------ | ------------------------- | ------------------------------------- |
| **Hot**  | Redis (existing `RedisSessionStore`) | 30 min                    | Active sessions, low latency          |
| **Cold** | MongoDB (`MongoSessionStore` — new)  | Configurable (days/weeks) | Durable persistence for idle sessions |

**Implementation approach:**

1. **Add `MongoSessionStore`** implementing the existing `SessionStore` interface. Stores `SessionData` (which already has the thread model) in a MongoDB collection with configurable TTL index.

2. **Write-through on save**: When `RedisSessionStore.save()` succeeds, also write to MongoDB (async, non-blocking). This keeps MongoDB always up-to-date.

3. **Fallback on load miss**: When `RedisSessionStore.load()` returns null (TTL expired), check MongoDB before returning not-found. If found, re-hydrate into Redis and return.

```
Load path:
  Redis.load(sessionId)
    ├── Found → return (hot path, fast)
    └── Not found → MongoDB.load(sessionId)
                       ├── Found → Redis.create(session) + return (cold→hot promotion)
                       └── Not found → return null (session truly gone)
```

4. **Delete the Checkpointer** — it's dead code with a stale data model. The `SessionStore` interface is the correct abstraction.

**Code references:**

- SessionStore interface: `session/session-store.ts:11-125`
- RedisSessionStore: `session/redis-session-store.ts:144-666`
- Session TTL config: `session/types.ts:161,169` (`sessionTtlMinutes: 30`)
- saveSessionSnapshot: `runtime-executor.ts:1282-1339`
- serializeThreads: `runtime-executor.ts:1553`
- Dead Checkpointer: `packages/compiler/src/platform/checkpointing/` (checkpointer.ts, memory-checkpointer.ts, redis-checkpointer.ts)

### Compaction Policy

Session-level compaction behavior is governed by `CompactionPolicy`, cached on `session._compactionPolicy`. See `docs/plans/2026-03-09-compaction-strategies-design.md` for the full design.

#### GAP-12: No Post-Tool-Call Variable Mapping in Reasoning Mode

**Severity**: Feature gap — reasoning mode cannot extract specific fields from tool results into named variables or set hardcoded values after a tool call.

**Problem**: In flow mode, `ON_SUCCESS SET` and `ON_RESULT WHEN ... SET` let you map tool result fields to named variables:

```abl
# Flow mode — works today
search_step:
  CALL: search_hotels
  ON_SUCCESS:
    SET:
      hotel_count: "{{last_search_hotels_result.count}}"
      cheapest_price: "{{last_search_hotels_result.hotels.0.price}}"
    THEN: validate_step
```

In reasoning mode, the only write after a tool call is the raw blob (`reasoning-executor.ts:604`):

```typescript
session.data.values[`last_${toolCall.name}_result`] = toolResult;
```

There's no mechanism to:

- Extract `result.hotels[0].price` into a `selected_price` variable
- Set a hardcoded value like `booking_status = "pending"` after a specific tool completes
- Conditionally set variables based on tool result content

**What breaks**:

1. **Constraints can't evaluate nested tool results.** A constraint like `selected_price <= budget` requires `selected_price` as a flat variable in `session.data.values`. The constraint engine evaluates `evaluateConstraintCondition(condition, context)` where context is the flat values map — it can't reach into `last_search_hotels_result.hotels[0].price`.

2. **REMEMBER triggers can't match on nested fields.** `WHEN: selected_price IS SET` won't fire because only `last_search_hotels_result` is set, not `selected_price`.

3. **Context bloat.** The entire tool result (potentially large JSON) is dumped into `session.data.values` as `last_<tool>_result`, which gets serialized into the system prompt's `## Current Context` section every turn. No way to extract just the fields you need. The LLM already sees the full tool result in the conversation history as a `tool_result` message — storing it again in Current Context is **redundant**. And it accumulates: `last_search_hotels_result`, `last_check_availability_result`, `last_get_pricing_result` all sit in context simultaneously, growing the system prompt linearly with each tool call.

4. **Cross-tool data flow.** If tool B needs a specific field from tool A's result, the LLM has to carry it mentally — there's no variable to reference.

**Workarounds today (all limited)**:

| Workaround                                  | Limitation                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| LLM sees raw result in conversation history | No variable assignment, constraints can't use it                                              |
| `last_<tool>_result` in Current Context     | Nested blob, not flat variables; bloats context                                               |
| REMEMBER + RECALL chain                     | Writes to FactStore (persistent DB), async fire-and-forget, race condition with next LLM call |

**Proposed fix — Post-tool SET mapping + context control in reasoning mode DSL**:

```abl
AGENT: Booking_Agent
MODE: reasoning

TOOLS:
  - search_hotels:
      STORE_RESULT: false               # don't dump raw result into context (default: true)
      ON_RESULT:
        SET:
          hotel_count: "result.count"
          cheapest_price: "result.hotels.0.price"
          search_status: "completed"      # hardcoded

  - book_hotel:
      STORE_RESULT: false
      ON_RESULT:
        SET:
          booking_id: "result.booking_id"
          booking_status: "confirmed"
        WHEN: "result.success == true"
      ON_ERROR:
        SET:
          booking_status: "failed"

  - get_user_profile:
      STORE_RESULT: true                # small result, keep in context (explicit opt-in)
```

**`STORE_RESULT` behavior**:

| Setting                  | `last_<tool>_result` in context                                 | LLM sees result in conversation | Use case                                                                   |
| ------------------------ | --------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `true` (current default) | Yes — full blob                                                 | Yes (tool_result message)       | Small results, backward compatible                                         |
| `false`                  | No — only SET-mapped variables                                  | Yes (tool_result message)       | Large results, extract what you need                                       |
| Not specified            | `true` if no `ON_RESULT SET`, `false` if `ON_RESULT SET` exists | Yes                             | Smart default — if you're mapping fields, you probably don't want the blob |

The LLM always sees the full tool result in conversation history regardless — `STORE_RESULT` only controls whether it's **also** duplicated into `session.data.values` (and thus into the system prompt's Current Context section).

**Implementation**: After `session.data.values[last_<tool>_result] = toolResult` at `reasoning-executor.ts:604`, evaluate the tool's `ON_RESULT` SET mappings from the IR, resolve value paths against the tool result, and write flat variables to `session.data.values`. This would make the values available to constraints, REMEMBER triggers, and template interpolation immediately.

**Related gap — constraints must be re-evaluated after REMEMBER/RECALL updates**:

The current post-tool sequence is broken for constraint enforcement:

```
tool call completes
  → session.data.values[last_<tool>_result] = toolResult     // line 604
  → evaluateRememberAfterStateChange()                        // line 607, fire-and-forget async
  → executeRecallAfterToolCall()                              // line 608, fire-and-forget async
  → next LLM iteration starts                                 // NO constraint check
```

Three problems:

1. **No constraint check after tool calls.** The tool-use loop (`reasoning-executor.ts:246-380`) never calls `checkConstraints()` between iterations. A tool result that violates a constraint (e.g., `price > budget`) goes undetected.

2. **REMEMBER/RECALL are fire-and-forget.** Both calls use `.catch(() => {})` (lines 607-608), meaning they're async and may not complete before the next LLM call starts. RECALL injects data via `Object.assign(session.data.values, injectedData)` at `memory-integration.ts:237` — but this may race with the next iteration reading context.

3. **Even with a constraint check added, RECALL data may not be there yet.** The check would run against stale `session.data.values` because RECALL hasn't resolved.

**Proposed fix — await REMEMBER/RECALL, then check constraints**:

```typescript
// reasoning-executor.ts — after line 604
session.data.values[`last_${toolCall.name}_result`] = toolResult;

// 1. Evaluate ON_RESULT SET mappings (GAP-12 new feature)
applyToolResultMappings(session, toolCall.name, toolResult);

// 2. Await REMEMBER/RECALL instead of fire-and-forget
await evaluateRememberAfterStateChange(session, onTraceEvent);
await executeRecallAfterToolCall(session, toolCall.name, onTraceEvent);

// 3. Now context is fully updated — check constraints
const violation = checkConstraints(session, onTraceEvent);
if (violation) {
  return handleConstraintViolation(session, violation, onChunk, onTraceEvent);
}
```

#### Design Solutions

**Option A — Tool-Level ON_RESULT in DSL + Await Memory + Constraint Check (Recommended)** ⭐

Full solution: extends TOOLS section for reasoning mode, fixes memory race conditions, adds constraint checks.

**DSL syntax** (new):

```abl
TOOLS:
  - search_hotels:
      TYPE: http
      URL: "https://api.example.com/search"
      STORE_RESULT: false               # don't dump raw result into context
      ON_RESULT:
        SET:
          hotel_count: "result.count"
          cheapest_price: "result.hotels.0.price"
          search_status: "completed"
      ON_ERROR:
        SET:
          search_status: "failed"

  - get_user_profile:
      TYPE: http
      STORE_RESULT: true                # small result, keep in context (explicit)
```

**IR extension** (new fields on `ToolDefinition`):

```typescript
export interface ToolDefinition {
  // ... existing fields ...

  /** Whether to store raw result as last_<tool>_result (default: true if no on_result, false if on_result exists) */
  store_result?: boolean;

  /** Post-tool variable mapping — evaluated after tool execution */
  on_result?: {
    set: Record<string, string>; // Maps result paths to session variables
  };

  /** Post-tool-error variable mapping */
  on_error?: {
    set: Record<string, string>;
  };
}
```

**Executor changes** (`reasoning-executor.ts`, after line 604):

```typescript
// 1. Conditionally store raw result
const toolDef = ir.tools?.find((t) => t.name === toolCall.name);
const storeResult = toolDef?.store_result ?? (toolDef?.on_result ? false : true);
if (storeResult) {
  session.data.values[`last_${toolCall.name}_result`] = toolResult;
}

// 2. Apply ON_RESULT SET mappings (or ON_ERROR SET if tool failed)
const isError = typeof toolResult === 'object' && toolResult !== null && 'error' in toolResult;
const mapping = isError ? toolDef?.on_error?.set : toolDef?.on_result?.set;
if (mapping) {
  for (const [varName, valueExpr] of Object.entries(mapping)) {
    if (valueExpr.startsWith('result.')) {
      // Path resolution: "result.hotels.0.price" → toolResult.hotels[0].price
      session.data.values[varName] = resolveNestedPath(toolResult, valueExpr.slice(7));
    } else {
      // Hardcoded value: "completed"
      session.data.values[varName] = interpolateTemplate(valueExpr, session.data.values);
    }
  }
}

// 3. Await REMEMBER/RECALL (NOT fire-and-forget)
await evaluateRememberAfterStateChange(session, onTraceEvent);
await executeRecallAfterToolCall(session, toolCall.name, onTraceEvent);

// 4. Constraint check — context is now fully updated
const violation = checkConstraints(session, onTraceEvent);
if (violation) {
  return handleConstraintViolation(session, violation, onChunk, onTraceEvent);
}
```

**Post-tool-call sequence becomes deterministic**:

```
tool call completes
  → store raw result (if STORE_RESULT: true)
  → apply ON_RESULT SET mappings (flat variables)
  → await REMEMBER (persistent write, blocking)
  → await RECALL (FactStore read, blocking)
  → constraint check (all variables up-to-date)
  → next LLM iteration (or violation handled)
```

**STORE_RESULT smart default**:

| Setting                          | `last_<tool>_result` in context | Use case                                   |
| -------------------------------- | ------------------------------- | ------------------------------------------ |
| `true` (explicit)                | Yes — full blob                 | Small results, backward compatible         |
| `false` (explicit)               | No — only SET-mapped variables  | Large results, extract what you need       |
| Not specified + no ON_RESULT     | `true` (backward compat)        | Existing tools work unchanged              |
| Not specified + ON_RESULT exists | `false` (smart default)         | If you're mapping, you don't need the blob |

| Aspect                       | Detail                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| **Fixes all 3 sub-problems** | Result mapping + await memory + constraint check                                             |
| **Parser/compiler changes**  | Parse ON_RESULT/ON_ERROR/STORE_RESULT in TOOLS section, compile to ToolDefinition IR         |
| **Flow mode reference**      | Reuses `interpolateTemplate()` and `resolveNestedPath()` patterns from flow-step-executor.ts |
| **Backward compatible**      | Existing tools without ON_RESULT work exactly as today                                       |
| **Effort**                   | Large — parser + compiler + IR type + executor + tests                                       |

---

**Option B — Await Memory + Constraint Check Only (No DSL Changes)**

Fix correctness issues without adding new DSL syntax. No result mapping.

```typescript
// reasoning-executor.ts — after line 604
session.data.values[`last_${toolCall.name}_result`] = toolResult;

// FIX 1: Await instead of fire-and-forget
await evaluateRememberAfterStateChange(session, onTraceEvent);
await executeRecallAfterToolCall(session, toolCall.name, onTraceEvent);

// FIX 2: Constraint check after tool calls
const violation = checkConstraints(session, onTraceEvent);
if (violation) {
  return handleConstraintViolation(session, violation, onChunk, onTraceEvent);
}
```

| Aspect                         | Detail                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixes sub-problems 2 & 3**   | Await memory + constraint check                                                                                                                     |
| **Does NOT fix**               | No result-to-variable mapping. LLM must mentally carry result fields. Constraints can only check `last_<tool>_result` (nested), not flat variables. |
| **No parser/compiler changes** | Runtime-only fix                                                                                                                                    |
| **Effort**                     | Small — ~20 lines in reasoning-executor.ts + tests                                                                                                  |

---

**Option C — Config-Based Result Mapping (No DSL Changes)**

Use a configuration object (JSON, not DSL syntax) for result mapping. Also fixes await + constraint.

```typescript
// Agent execution config (JSON, not ABL DSL):
{
  "toolResultMappings": {
    "search_hotels": {
      "hotel_count": "result.count",
      "cheapest_price": "result.hotels[0].price"
    }
  }
}
```

| Aspect                         | Detail                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Fixes all 3 sub-problems**   | Mapping + await + constraint                                                                            |
| **No parser/compiler changes** | Mappings live in execution config, not DSL                                                              |
| **Trade-off**                  | Mapping config is separate from tool definition — harder to discover, not co-located with TOOLS section |
| **Effort**                     | Medium — ~50 lines in executor + config schema extension                                                |

---

**Trade-off — Await latency**: Awaiting REMEMBER/RECALL adds ~5-10ms per tool call (FactStore read/write). Negligible compared to LLM call time (~500-2000ms). The fire-and-forget pattern was a premature optimization — correctness matters more than saving 5ms when constraint violations can lead to booking a $10,000 hotel on a $500 budget.

**Code references**:

- Raw result dump: `reasoning-executor.ts:604`
- Fire-and-forget REMEMBER: `reasoning-executor.ts:607` (`.catch(() => {})`)
- Fire-and-forget RECALL: `reasoning-executor.ts:608` (`.catch(() => {})`)
- RECALL injects into context: `memory-integration.ts:230-242` (`Object.assign`)
- Tool-use while loop: `reasoning-executor.ts:246-390` (no constraint check inside)
- Post-extraction constraint check (only place it runs): `reasoning-executor.ts:230-244`
- Flow mode ON_SUCCESS SET (reference): `flow-step-executor.ts:2211-2280`
- Flow mode ON_RESULT branching (reference): `flow-step-executor.ts:2056-2114`
- ToolDefinition IR (missing fields): `compiler/ir/schema.ts:297-346`
- CallResultBlock IR (flow mode has): `compiler/ir/schema.ts:1213-1233`
- Constraint evaluation: `constraint-checker.ts:39-76`

#### GAP-13: Tools Cannot Access or Update Session Context

**Severity**: Architectural limitation — tools are stateless functions with no access to session state.

**Problem**: The `ToolExecutor` interface (`compiler/src/platform/constructs/types.ts:535`) is:

```typescript
interface ToolExecutor {
  execute(toolName: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}
```

Tools receive only the explicit `params` the LLM passes and return a result. They have no access to `session.data.values` — they can't read session context and can't write back state updates.

**What this forces today**:

1. **LLM must pass everything explicitly.** If `check_inventory` needs `user_location`, `preferred_currency`, and `loyalty_tier` from session context, the LLM must extract each one from Current Context and pass it as a tool parameter. This wastes tokens and is error-prone — the LLM may forget a parameter or hallucinate a value.

2. **No tool-driven state updates.** A `create_booking` tool can't set `booking_status = "confirmed"` and `booking_id = "BK-789"` directly. It returns `{success: true, booking_id: "BK-789"}` and the runtime dumps the entire result as `last_create_booking_result`. There's no way for the tool to express "set these specific session variables."

3. **Redundant tool parameters.** Common context like `tenant_id`, `user_id`, `auth_token`, `channel` must be declared as parameters on every tool that needs them, and the LLM must pass them every call — even though they never change within a session.

**Proposed fix — pass context as a single variable, receive updates back**:

DSL syntax:

```abl
TOOLS:
  - create_booking:
      TYPE: http
      URL: "https://api.example.com/bookings"
      CONTEXT_ACCESS:
        read: [user_id, destination, dates, num_guests, loyalty_tier]   # tool receives these
        write: [booking_id, booking_status, confirmation_code]          # tool can update these
      PARAMS:
        hotel_id:
          TYPE: string
          DESCRIPTION: "Hotel to book"
        room_type:
          TYPE: string
          DESCRIPTION: "Room category"

  - check_inventory:
      TYPE: http
      URL: "https://api.example.com/inventory"
      CONTEXT_ACCESS:
        read: [user_location, preferred_currency]    # auto-injected, LLM doesn't need to pass
        write: []                                      # read-only access
```

The tool receives two objects:

```json
{
  "params": { "hotel_id": "htl-456", "room_type": "deluxe" },
  "context": {
    "user_id": "usr-123",
    "destination": "Paris",
    "dates": "Mar 10-15",
    "num_guests": 2,
    "loyalty_tier": "gold"
  }
}
```

And returns:

```json
{
  "result": { "success": true, "booking_id": "BK-789", "total": 1500 },
  "context_updates": {
    "booking_id": "BK-789",
    "booking_status": "confirmed",
    "confirmation_code": "CONF-ABC"
  }
}
```

**Implementation**:

1. **IR compilation**: `CONTEXT_ACCESS` compiles to `ToolIR.context_read: string[]` and `ToolIR.context_write: string[]`.

2. **Before tool execution** (`reasoning-executor.ts:553` / `flow-step-executor.ts`):
   - Build `contextSnapshot` from `session.data.values` filtered to only `context_read` keys.
   - Pass `{ params, context: contextSnapshot }` to the tool.

3. **After tool execution** (`reasoning-executor.ts:604`):
   - If the tool returns `context_updates`, validate that keys are in `context_write` whitelist.
   - Apply updates: `session.data.values[key] = value` for each allowed key.
   - Reject writes to keys not in `context_write` (security — tools shouldn't set arbitrary session state).

4. **HTTP tool executor**: Merge `context` into the request body or headers (configurable per tool). Parse `context_updates` from the response body.

5. **Backward compatible**: Tools without `CONTEXT_ACCESS` work exactly as today — `params` in, `result` out.

**Security considerations**:

- `context_read` is a whitelist — the tool only sees the declared keys, not all of `session.data.values`. Prevents leaking sensitive context (e.g., `auth_token`, `callerContext`).
- `context_write` is a whitelist — the tool can only update declared keys. Prevents a compromised tool from overwriting `user_id`, `tenant_id`, or constraint-relevant variables maliciously.
- `context_updates` from the tool response are validated against `context_write` before applying. Unknown keys are logged and dropped.

**Benefits**:

| Concern                               | Current                           | With CONTEXT_ACCESS                               |
| ------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Common session fields (user_id, etc.) | LLM passes every call             | Auto-injected from context                        |
| Tool-driven state updates             | Not possible                      | Tool returns `context_updates`                    |
| LLM token usage                       | Wastes tokens on known parameters | Fewer params for LLM to manage                    |
| Security                              | Tools see nothing                 | Explicit read/write whitelist                     |
| Constraint integration                | Post-tool variables not available | `context_updates` written before constraint check |

**Code references**:

- ToolExecutor interface: `compiler/src/platform/constructs/types.ts:535-544`
- Tool execution in reasoning mode: `reasoning-executor.ts:550-608`
- Tool execution in flow mode: `flow-step-executor.ts` (CALL step handling)
- ToolBindingExecutor (routes to HTTP/MCP/Lambda/Sandbox): `compiler/src/platform/constructs/executors/tool-binding-executor.ts:62`
- HttpToolExecutor: `compiler/src/platform/constructs/executors/http-tool-executor.ts:184`
- Session stored on tool executor: not passed today — `session.toolExecutor` at `execution/types.ts:87` is opaque

#### GAP-14: Entity Extraction Should Use Structured Tool Call Instead of Raw JSON Parsing

**Severity**: CRITICAL — Reliability. Current text-based extraction is fragile and requires ~40 lines of defensive parsing.

**Root Cause — Two Problems**:

1. **Empty tools array**: `extractEntitiesWithLLM()` calls `chatWithToolUse()` with `tools: []` and relies on the LLM returning raw JSON text. The LLM frequently wraps JSON in prose, markdown code blocks, or returns mismatched field names.

2. **Separate LLM validation calls**: Fields with `validation.type === 'llm'` trigger separate per-field LLM calls after extraction, running in parallel via `Promise.all()`. With 3 LLM-validated fields, that's 4 total LLM API calls per extraction cycle.

**Current cost**: ~4 LLM calls per extraction (1 extraction + up to 3 validations). ~950-2700 input tokens total.

**LLM call** (`flow-step-executor.ts:798`):

```typescript
const response = await session.llmClient!.chatWithToolUse(
  systemPrompt,
  [{ role: 'user', content: userMessage }],
  [], // ← no tools, relies on LLM returning valid JSON text
  'extraction',
);
```

The system prompt says "Return ONLY a valid JSON object" but the LLM often returns:

- Prose wrapping: `"Here are the extracted values:\n{\"name\": \"John\"}"`
- Markdown code blocks: ` ```json\n{...}\n``` `
- Mismatched field names: `checkIn` instead of `check_in`
- Empty text or explanation when nothing to extract: `"I couldn't find any values in the message"`

This requires ~40 lines of defensive code (`flow-step-executor.ts:832-867`):

````typescript
// Step 1: Try direct JSON.parse
try {
  parsed = JSON.parse(responseText);
} catch {
  // Step 2: Try regex to extract JSON from markdown or prose
  const jsonMatch =
    responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
}

// Step 3: Case/underscore variation mapping (lines 851-867)
for (const field of llmCandidateFields) {
  if (result[field] !== undefined) continue;
  const fieldLower = field.toLowerCase();
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase().replace(/_/g, '') === fieldLower.replace(/_/g, '')) {
      result[field] = value;
    }
  }
}
````

**Proposed fix — use a structured tool call for extraction**:

Since we already know the exact fields from the GATHER definition, define an extraction tool with a schema matching those fields. The LLM uses `tool_use` to return structured data — guaranteed valid JSON, correct field names, type coercion.

```typescript
// Build extraction tool from GATHER fields (schema already known)
const extractionTool = {
  name: '_extract_entities',
  description: 'Extract the following fields from the user message',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      gatherFields.map((f) => [f.name, ablTypeToJsonSchema(f.type, f.prompt)]),
    ),
    required: [], // all optional — LLM only extracts what's present
  },
};

const response = await session.llmClient!.chatWithToolUse(
  systemPrompt,
  [{ role: 'user', content: userMessage }],
  [extractionTool], // ← structured extraction tool
  'extraction',
);

// Tool called → structured result. Not called → nothing to extract.
const extracted = response.toolCalls.length > 0 ? response.toolCalls[0].input : {};
```

**Tool choice must be `auto` (not forced)**:

- `tool_choice: "auto"` — LLM decides whether to call the tool. If user says "hmm let me think", the LLM responds with text only and no tool call → `extracted = {}`. No hallucinated values.
- `tool_choice: { type: "tool", name: "_extract_entities" }` — forces the call. Bad: LLM would hallucinate field values to fill the schema even when user said nothing extractable.

**What this eliminates**:

| Current code (removable)              | Lines   | Why no longer needed              |
| ------------------------------------- | ------- | --------------------------------- |
| `JSON.parse()` with try/catch         | 832-843 | Tool inputs are always valid JSON |
| Regex fallback for markdown/prose     | 837-842 | No prose in tool inputs           |
| Case/underscore variation mapping     | 851-867 | Schema defines exact field names  |
| "Return ONLY JSON" prompt instruction | 772-793 | Tool schema enforces structure    |
| Empty/prose response handling         | Various | No-call = `{}`, natural behavior  |

**Validation rules in the schema itself**:

GATHER field validation (range, enum, pattern) can be embedded directly in the JSON Schema:

```json
{
  "name": "_extract_entities",
  "input_schema": {
    "type": "object",
    "properties": {
      "destination": { "type": "string", "description": "Where would you like to stay?" },
      "num_guests": {
        "type": "number",
        "description": "How many guests?",
        "minimum": 1,
        "maximum": 10
      },
      "room_type": {
        "type": "string",
        "description": "Room category",
        "enum": ["single", "double", "suite"]
      },
      "check_in": {
        "type": "string",
        "description": "Check-in date (YYYY-MM-DD)",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      }
    }
  }
}
```

The LLM provider enforces these constraints at generation time — invalid values are rejected before they reach our code. This reduces or eliminates the need for the post-extraction validation pass (`flow-step-executor.ts:869-895`).

**Eliminates separate LLM validation calls**:

Currently, fields with `VALIDATION_PROCESS: LLM` trigger separate per-field LLM calls after extraction (`llm-field-validator.ts:122`). With 3 LLM-validated fields, that's 4 total LLM calls per extraction (1 extraction + 3 validations). The LLM validation rules should be embedded as descriptions in the extraction tool schema instead — the LLM enforces them at generation time:

```
Current (4 LLM calls for 5 fields, 3 with LLM validation):
  1× extraction LLM call (empty tools, raw JSON)
  1× LLM validation for destination            ┐
  1× LLM validation for travel_dates            ├ separate calls via Promise.all
  1× LLM validation for special_requests        ┘
  1× regex validation for email (sync, no LLM)

Proposed (1 LLM call):
  1× extraction tool call (LLM validation rules baked into field descriptions)
  1× regex/range/enum validation (sync, no LLM, post-extraction only)
```

The tool schema embeds LLM validation rules as field descriptions:

```json
{
  "name": "_extract_entities",
  "input_schema": {
    "type": "object",
    "properties": {
      "destination": {
        "type": "string",
        "description": "Where would you like to stay? MUST be a real city name, not a country or region."
      },
      "travel_dates": {
        "type": "string",
        "description": "Travel dates. MUST be future dates, check-out after check-in, maximum 30 days."
      },
      "email": {
        "type": "string",
        "description": "Email address"
      },
      "num_guests": {
        "type": "number",
        "description": "Number of guests",
        "minimum": 1,
        "maximum": 10
      }
    }
  }
}
```

The LLM won't return "France" for destination because the description says "MUST be a real city name, not a country." Then post-extraction, only deterministic validation (regex, range, enum) runs — sync, zero LLM calls.

**Validation split**:

| Validation type                | Where it runs                                                | LLM call?                              |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------- |
| `VALIDATION_PROCESS: LLM`      | Embedded in extraction tool schema description               | No (folded into the 1 extraction call) |
| Regex (`pattern`)              | Post-extraction sync pass                                    | No                                     |
| Range (`1-10`)                 | Post-extraction sync pass (or `minimum`/`maximum` in schema) | No                                     |
| Enum (`single\|double\|suite`) | Post-extraction sync pass (or `enum` in schema)              | No                                     |

**Backward compatible**: The `extraction` operation type already routes to a separate model config. The change is internal to `extractEntitiesWithLLM()` — callers see the same `Record<string, unknown>` output.

#### Design Solutions

**Option A — Structured Tool Call with Embedded Validation (Recommended)** ⭐

Build `_extract_entities` tool from `GatherField[]` using existing `ablTypeToJsonSchema()`. Pass to `chatWithToolUse()` with `toolChoice: 'auto'`. Extract from `response.toolCalls[0].input` — guaranteed valid JSON, correct field names. Embed LLM validation rules in schema descriptions.

```typescript
// flow-step-executor.ts — extractEntitiesWithLLM() replacement
const extractionTool: ToolDefinition = {
  name: '_extract_entities',
  description:
    'Extract the following fields from the user message based on what they explicitly stated',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      gatherFields.map((f) => {
        const schema = ablTypeToJsonSchema(f.type || 'string', f.prompt);
        // Embed validation rules in schema
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
          // Fold LLM validation into description (no separate call needed)
          schema.description = `${schema.description || f.prompt}. RULE: ${f.validation.rule}`;
        }
        return [f.name, schema];
      }),
    ),
    required: [], // all optional — LLM only extracts what's present
  },
};

const response = await session.llmClient!.chatWithToolUse(
  systemPrompt,
  [{ role: 'user', content: userMessage }],
  [extractionTool],
  'extraction',
  { toolChoice: 'auto' }, // ← LLM decides whether to call
);

const extracted = response.toolCalls.length > 0 ? response.toolCalls[0].input : {};
```

**Requires**: Adding `toolChoice` passthrough to `chatWithToolUse()` → `session-llm-client.ts:223` → Vercel AI SDK `generateText()`. The Vercel AI SDK already supports `toolChoice` parameter.

| What changes                    | Detail                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `flow-step-executor.ts:770-867` | Replace system prompt + empty tools + JSON parsing with tool schema + tool call extraction |
| `session-llm-client.ts:201`     | Add optional `options?: { toolChoice?: 'auto' \| 'required' }` parameter                   |
| `llm-field-validator.ts:31-155` | **Eliminable** — LLM validation rules folded into extraction schema descriptions           |
| `prompt-builder.ts:44-102`      | Reuse `ablTypeToJsonSchema()` unchanged                                                    |

| Metric                 | Current                          | With Option A                       |
| ---------------------- | -------------------------------- | ----------------------------------- |
| LLM API calls          | 4 (1 extraction + 3 validations) | **1**                               |
| Defensive parsing code | ~40 lines                        | **0 lines**                         |
| Field name mismatches  | Common (case/underscore)         | **Impossible** (schema-enforced)    |
| JSON wrapping issues   | Frequent (prose/markdown)        | **Impossible** (tool call)          |
| Token cost             | ~950-2700 input                  | ~800-2000 input                     |
| **Effort**             |                                  | Medium — ~80 lines new, ~40 deleted |

---

**Option B — Structured Tool Call without Validation Embedding**

Same as Option A but keep LLM validation calls separate. Only eliminates parsing fragility, not the extra LLM calls.

```typescript
// Same tool schema building, but WITHOUT folding validation rules into descriptions
// Post-extraction still runs:
//   Pass 1: sync validation (regex, range, enum)
//   Pass 2: LLM validation (separate calls via llm-field-validator.ts)
```

| Metric                 | Current   | With Option B                              |
| ---------------------- | --------- | ------------------------------------------ |
| LLM API calls          | 4         | **Still 4** (1 extraction + 3 validations) |
| Defensive parsing code | ~40 lines | **0 lines**                                |
| Field name mismatches  | Common    | **Impossible**                             |
| **Effort**             |           | Small — ~50 lines new, ~40 deleted         |

---

**Option C — Keep Raw JSON but Use Provider JSON Mode**

Add `response_format: { type: "json_object" }` to the LLM call. Some providers (OpenAI, Anthropic) enforce JSON output natively.

| Metric                 | Current                   | With Option C                       |
| ---------------------- | ------------------------- | ----------------------------------- |
| LLM API calls          | 4                         | **Still 4**                         |
| Defensive parsing code | ~40 lines                 | ~20 lines (still need case mapping) |
| JSON wrapping          | Fixed (provider-enforced) | Fixed                               |
| Field name mismatches  | Still possible            | **Still possible**                  |
| Provider dependency    | None                      | Requires provider JSON mode support |
| **Effort**             |                           | Small — ~10 lines changed           |

---

**Code references**:

- Current extraction LLM call (empty tools): `flow-step-executor.ts:798-803`
- JSON parsing + regex fallback: `flow-step-executor.ts:832-843`
- Case/underscore mapping: `flow-step-executor.ts:851-867`
- Post-extraction validation (Pass 1 — regex): `flow-step-executor.ts:869-881`
- Post-extraction validation (Pass 2 — LLM, eliminable): `flow-step-executor.ts:883-895`
- Per-field LLM validation: `llm-field-validator.ts:31-155`
- Extraction system prompt (ENTITY_EXTRACTION_PROMPT): `constants.ts:366-389`
- `ablTypeToJsonSchema` (reusable): `prompt-builder.ts:44-102`
- GatherField type: `compiler/ir/schema.ts:484-507`
- ValidationRule type: `compiler/ir/schema.ts:509-519`
- LLM client interface: `session-llm-client.ts:201-240`
- Vercel AI adapter (tool conversion): `vercel-ai-adapters.ts:85-215`
- Extraction call sites: `flow-step-executor.ts:256,1384,1447,1819` + `reasoning-executor.ts:174`

#### GAP-15: `__handoff__` Context Schema Is Unstructured — Should Use Declared PASS Fields

**Severity**: Reliability + wasted tokens — the LLM guesses at free-form context when the ABL already declares exactly which fields to pass.

**Problem**: The `__handoff__` tool schema (`prompt-builder.ts:463-481`) sends `context` as a free-form string:

```json
{
  "name": "__handoff__",
  "input_schema": {
    "properties": {
      "target": { "type": "string", "enum": ["billing_agent", "support_agent"] },
      "context": { "type": "string", "description": "JSON context to pass (optional)" }
    }
  }
}
```

But the ABL already declares exactly which variables to pass per target:

```
HANDOFF:
  TO: Billing_Agent
  CONTEXT:
    PASS [customer_id, plan_type, outstanding_balance]
    SUMMARY: "Customer {{customer_name}} needs billing help for plan {{plan_type}}"
```

At execution time (`routing-executor.ts:219-232`), the runtime **ignores the LLM's free-form context** for PASS fields and reads directly from `session.data.values`:

```typescript
// LLM-provided context — unreliable, often hallucinated
Object.assign(mergedContext, context); // ← line 222

// PASS fields OVERRIDE from actual session state
if (handoffConfig?.context?.pass) {
  for (const field of handoffConfig.context.pass) {
    mergedContext[field] = parentData[field]; // ← lines 226-231, the real source
  }
}
```

**What goes wrong**:

1. **Free-form `type: "string"`** — no schema guidance, the LLM has zero information about what fields exist or their types
2. **LLM can hallucinate** context values — if it invents `{ "customer_id": "C-999" }` and there are no PASS fields, hallucinated values flow to the child agent unchecked
3. **Runtime overrides LLM values** — PASS fields read from `session.data.values` replace whatever the LLM sent, discarding LLM's potentially richer understanding
4. **Same issue for `__delegate__` and `__fan_out__`** — they also accept unstructured context

**Why the LLM should populate context (not the runtime alone)**:

The LLM has access to **two sources of truth**:

1. **System prompt → `## Current Context`** — all `session.data.values` as JSON
2. **Conversation history** — the full chat, including details **never extracted into session variables**

The conversation history often contains information the runtime doesn't have:

```
System prompt context: { customer_id: "C-123", plan: "premium" }

History:
  User: "I've called 3 times about this already and I'm really frustrated"
  User: "My billing address changed to 123 Oak St last week"

LLM calls: __handoff__({
  target: "billing_agent",
  context: {
    customer_id: "C-123",         ← from session variable (accurate)
    plan: "premium",               ← from session variable (accurate)
    frustration_level: "high",     ← synthesized from history (NOT in any variable)
    prior_contacts: 3,             ← extracted from history (NOT a gathered field)
    new_address: "123 Oak St"      ← mentioned in passing (NOT a GATHER field)
  }
})
```

The runtime reading only `session.data.values` would miss `frustration_level`, `prior_contacts`, and `new_address` — these were never extracted into variables but are valuable context for the target agent. The LLM can synthesize this richer context by reading both the system prompt AND the conversation history.

**Proposed fix — structured schema from PASS fields, LLM populates values**:

PASS fields define the **schema** (what properties exist, their types). The LLM **populates values** by reasoning over history + current context. The runtime **uses LLM-provided values** (not overrides from session.data.values).

Step 1 — Build typed context schema from PASS fields at prompt build time:

```typescript
// In prompt-builder.ts buildTools()
const handoffConfig = findHandoffConfigForTarget(ir, targetName);
const passFields = handoffConfig?.context?.pass;

const contextSchema = passFields?.length
  ? {
      type: 'object',
      description:
        'Context to pass to the target agent. Populate from conversation history and current context.',
      properties: Object.fromEntries(
        passFields.map((field) => {
          const gatherField = ir.gather?.fields?.find((f) => f.name === field);
          return [
            field,
            {
              type: gatherField ? ablTypeToJsonSchema(gatherField.type).type : 'string',
              description: gatherField?.prompt || `Value of ${field}`,
            },
          ];
        }),
      ),
    }
  : {
      type: 'string',
      description: 'JSON context to pass to the target agent (optional)',
    };
```

Step 2 — Resulting schema the LLM sees:

```json
{
  "name": "__handoff__",
  "input_schema": {
    "properties": {
      "target": { "type": "string", "enum": ["billing_agent"] },
      "context": {
        "type": "object",
        "description": "Context to pass to the target agent. Populate from conversation history and current context.",
        "properties": {
          "customer_id": { "type": "string", "description": "Customer identifier" },
          "plan_type": { "type": "string", "description": "Current subscription plan" },
          "outstanding_balance": { "type": "number", "description": "Outstanding balance amount" }
        }
      }
    },
    "required": ["target"]
  }
}
```

Step 3 — At execution, use LLM-provided values (stop overriding with session state):

```typescript
// routing-executor.ts — CHANGE: LLM context is the primary source
let mergedContext: Record<string, unknown> = { handoff_from: currentThread.agentName };

// LLM-provided context — now structured and reliable thanks to schema
if (input.context && typeof input.context === 'object') {
  Object.assign(mergedContext, input.context);
}

// Only fall back to session.data.values for fields the LLM didn't provide
if (handoffConfig?.context?.pass) {
  for (const field of handoffConfig.context.pass) {
    if (mergedContext[field] === undefined && parentData[field] !== undefined) {
      mergedContext[field] = parentData[field]; // fallback only
    }
  }
}
```

**Flow**:

```
LLM sees:  System prompt (Current Context: { customer_id: "C-123", plan: "premium" })
           + history ("called 3 times", "address changed to 123 Oak St")

LLM calls: __handoff__({
             target: "billing_agent",
             context: {                          ← structured, schema-guided
               customer_id: "C-123",              ← from system prompt context
               plan_type: "premium",               ← from system prompt context
               outstanding_balance: 150.00         ← from history/context
             }
           })

Runtime:   Uses LLM values as primary source
           Falls back to session.data.values for any field LLM omitted
           Interpolates SUMMARY template
           Creates child thread with mergedContext
```

**Key principle**: The LLM is the **synthesizer** — it reads both structured state AND unstructured history to produce the best context for the target agent. The runtime provides the schema (from PASS fields) and fallback values (from session state), but trusts the LLM's output as primary.

**Should LLM-synthesized context be written back to parent's session state? NO.**

Analysis of thread lifecycle during handoff:

```
RETURN: false (permanent handoff — supervisor → specialist):
  routing-executor.ts:272-274
    currentThread.status = 'completed'    ← parent thread is DEAD
    currentThread.endedAt = Date.now()
    → New child thread becomes active. Parent is never read again.
    → Writing back is pointless — no one consumes the parent's data.

RETURN: true (round-trip handoff — parent waits, child returns):
  routing-executor.ts:261-271
    currentThread.status = 'waiting'      ← parent thread is SUSPENDED
    session.threadStack.push(activeThreadIndex)
    → Child runs, completes, triggers return flow.

  routing-executor.ts:377-405 (return):
    parentThread.status = 'active'        ← parent RESUMES
    ON_RETURN.MAP merges child data → parent data (lines 390-405)
    syncThreadToSession(session)          ← rebuilds ## Current Context from parent thread
    → Parent already gets enriched data via ON_RETURN.MAP.
    → Writing back at handoff time is premature — the child hasn't run yet.
```

**Conclusion**: Don't write back to parent. For permanent handoffs the parent is dead. For return handoffs, `ON_RETURN.MAP` already handles the data flow back. The LLM-synthesized context flows **forward only** — into the child thread via `mergedContext`.

---

**Same issue in `__delegate__`**:

Delegate already has **better structure** than handoff — it has explicit `INPUT` and `RETURNS` mappings in ABL:

```
DELEGATE:
  TO: Pricing_Agent
  INPUT:
    plan_id: plan_type            ← maps parent variable → child input key
    customer_tier: loyalty_tier
  RETURNS:
    monthly_cost: calculated_price   ← maps child result key → parent variable
    discount_pct: applied_discount
```

And the runtime has `mapDelegateInput()` (`routing-executor.ts:1425-1439`) and `mapDelegateReturns()` (`routing-executor.ts:1444-1467`) for these mappings.

**But the tool schema is still untyped** (`prompt-builder.ts:543-547`):

```json
{
  "name": "__delegate__",
  "input_schema": {
    "properties": {
      "target": { "type": "string", "enum": ["pricing_agent"] },
      "input": { "type": "object", "description": "Input data to pass to the sub-agent" }
    }
  }
}
```

`input` is `type: "object"` with no properties — the LLM has zero guidance on what fields to pass. But we **already know the fields** from the `INPUT` mapping in the delegate config.

**Proposed fix for `__delegate__`** — build typed schema from INPUT mapping:

```typescript
// In prompt-builder.ts buildTools()
const delegateConfig = ir.coordination.delegates.find((d) => d.agent === targetName);

const inputSchema = delegateConfig?.input
  ? {
      type: 'object',
      description: 'Input for the sub-agent. Populate from conversation and current context.',
      properties: Object.fromEntries(
        Object.entries(delegateConfig.input).map(([childKey, sourceExpr]) => {
          const gatherField = ir.gather?.fields?.find((f) => f.name === sourceExpr);
          return [
            childKey,
            {
              type: gatherField ? ablTypeToJsonSchema(gatherField.type).type : 'string',
              description: gatherField?.prompt || `Value mapped from ${sourceExpr}`,
            },
          ];
        }),
      ),
    }
  : { type: 'object', description: 'Input data for the sub-agent' };
```

Resulting schema:

```json
{
  "name": "__delegate__",
  "input_schema": {
    "properties": {
      "target": { "type": "string", "enum": ["pricing_agent"] },
      "input": {
        "type": "object",
        "properties": {
          "plan_id": { "type": "string", "description": "Current subscription plan" },
          "customer_tier": { "type": "string", "description": "Customer loyalty tier" }
        }
      }
    }
  }
}
```

**No parent write-back needed for delegate either**: Delegate already has `RETURNS` mapping — `mapDelegateReturns()` (`routing-executor.ts:1444-1467`) writes child results back to parent's `session.data.values` after the child completes. The data flows: parent → INPUT → child → RETURNS → parent. No need to write the INPUT values back to the parent since they're already in `parentThread.data.values` (they came from there via `mapDelegateInput`).

**Target enum lacks agent descriptions — LLM picks agents blindly**:

All three tools (`__handoff__`, `__fan_out__`, `__delegate__`) send `target` as a plain enum of agent names:

```json
"target": { "type": "string", "enum": ["billing_agent", "support_agent"] }
```

The LLM has to guess what each agent does based on the name alone. But we **already have descriptions** available:

| Source                                 | Field                 | Example                                           |
| -------------------------------------- | --------------------- | ------------------------------------------------- |
| `RoutingRule` (schema.ts:1260)         | `description: string` | "Handles billing inquiries and payment issues"    |
| `DelegateConfig` (schema.ts:655)       | `purpose: string`     | "Calculate pricing for customer plan"             |
| `AgentRegistryEntry.ir` (types.ts:186) | `ir.identity.goal`    | "Help customers with billing questions"           |
| `HandoffConfig` (schema.ts:681)        | _(none)_              | No description field — must fall back to registry |

JSON Schema `enum` doesn't support per-value descriptions. The fix is to embed agent descriptions in the `target` field's `description`:

```typescript
// In prompt-builder.ts buildTools() — build rich target description

// For routing-based handoffs (supervisor agents):
const targetDescription = ir.routing.rules
  .map((rule) => `- "${rule.to}": ${rule.description}`)
  .join('\n');

// For coordination-based handoffs (regular agents):
const targetDescription = handoffTargets
  .map((name) => {
    const entry = agentRegistry[name]; // need access to registry
    const goal = entry?.ir?.identity?.goal || name;
    return `- "${name}": ${goal}`;
  })
  .join('\n');

// For delegates:
const targetDescription = delegateConfigs.map((d) => `- "${d.agent}": ${d.purpose}`).join('\n');
```

Resulting schema (handoff example):

```json
{
  "name": "__handoff__",
  "input_schema": {
    "properties": {
      "target": {
        "type": "string",
        "description": "The specialist to route to:\n- \"billing_agent\": Handles billing inquiries, payment issues, and plan changes\n- \"support_agent\": Handles technical support, troubleshooting, and account issues\n- \"sales_agent\": Handles new purchases, upgrades, and promotional offers",
        "enum": ["billing_agent", "support_agent", "sales_agent"]
      }
    }
  }
}
```

Resulting schema (fan_out example — same approach per task item):

```json
{
  "name": "__fan_out__",
  "input_schema": {
    "properties": {
      "tasks": {
        "type": "array",
        "items": {
          "properties": {
            "target": {
              "type": "string",
              "description": "The specialist for this sub-task:\n- \"billing_agent\": Handles billing inquiries\n- \"support_agent\": Handles technical support",
              "enum": ["billing_agent", "support_agent"]
            }
          }
        }
      }
    }
  }
}
```

**Note**: `prompt-builder.ts` currently doesn't receive `agentRegistry` — it only gets the `session` and `ir`. For coordination-based handoffs (where `HandoffConfig` has no description), the registry lookup needs to be passed in or the description resolved at compile time and stored on the IR.

**Resolution priority for descriptions** (first available wins):

1. `RoutingRule.description` — explicitly declared per routing rule
2. `DelegateConfig.purpose` — explicitly declared per delegate
3. `agentRegistry[name].ir.identity.goal` — from the target agent's own ABL definition
4. Agent name as fallback

**Add `reason` (always) + `thought` (configurable) to ALL tool calls**:

Two distinct fields with different purposes:

| Field         | Present                                       | Purpose                                                                          | Token cost             |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| **`reason`**  | **Always** — on every tool (system + regular) | Short explanation of _why_ this tool. Traceability, analytics, routing accuracy. | Low (~10-20 tokens)    |
| **`thought`** | **Configurable** — UI toggle in test ground   | Deep chain-of-thought reasoning. Debugging, detailed trace display.              | Higher (~30-80 tokens) |

**`reason` — always on, all tools**:

Added as a required property to every tool's `input_schema` in `buildTools()`. The LLM must explain _why_ before every tool call. This is cheap (short string) and always valuable:

1. **Accuracy** — chain-of-thought at schema level. LLM reasons before acting, reducing mis-routing and wrong tool calls.
2. **Traceability** — every tool call trace event includes `reason`. Audit trail for "why was billing_agent chosen?", "why was search_hotels called?"
3. **Analytics** — aggregate reasons across sessions: "40% of handoffs cite payment disputes", "search_hotels is called with reason 'checking availability' 80% of the time"
4. **Debugging** — when a tool call goes wrong, `reason` immediately shows the LLM's (mis)understanding

Implementation — inject `reason` into every tool:

```typescript
// prompt-builder.ts buildTools() — after building all tools
for (const tool of tools) {
  tool.input_schema = {
    ...tool.input_schema,
    properties: {
      reason: {
        type: 'string',
        description: 'Brief reason for calling this tool',
      },
      ...tool.input_schema.properties, // reason first → LLM reasons before acting
    },
    required: [...(tool.input_schema.required || []), 'reason'],
  };
}
```

**`thought` — configurable from UI, deeper reasoning**:

Injected only when enabled via UI configuration. The test ground has a toggle + optional custom prompt.

Configuration:

```typescript
interface ThoughtConfig {
  /** Whether to inject thought field into tool schemas */
  enabled: boolean;
  /** Custom description for the thought field (overrides default) */
  description?: string;
}
```

Implementation — inject `thought` only when enabled:

```typescript
// prompt-builder.ts buildTools() — after reason injection
const thoughtConfig = session.thoughtConfig; // from test ground UI / project config

if (thoughtConfig?.enabled) {
  for (const tool of tools) {
    tool.input_schema = {
      ...tool.input_schema,
      properties: {
        thought: {
          type: 'string',
          description:
            thoughtConfig.description ||
            'Your detailed reasoning — explain what you understood from the conversation and why this action is the right choice',
        },
        ...tool.input_schema.properties, // thought before reason before params
      },
    };
  }
}
```

**Property order matters**: `thought` (if enabled) → `reason` → tool params. The LLM generates deep reasoning first, then a concise reason, then the actual parameters. Think → justify → act.

**Extraction at execution time** — strip both before passing to tool:

```typescript
// reasoning-executor.ts — tool call processing (around line 456)
const thought = toolCall.input.thought as string | undefined;
const reason = toolCall.input.reason as string | undefined;
delete toolCall.input.thought;
delete toolCall.input.reason;

// Emit thought as trace event for test ground UI (only when present)
if (thought && onTraceEvent) {
  onTraceEvent({
    type: 'tool_thought',
    data: {
      toolName: toolCall.name,
      thought,
      agentName: session.agentName,
    },
  });
}

// Always include reason in the tool_call trace event
if (onTraceEvent) {
  onTraceEvent({
    type: 'tool_call',
    data: {
      toolName: toolCall.name,
      reason,                    // ← always present
      input: toolCall.input,     // ← clean input without thought/reason
      ...
    },
  });
}

// Dispatch to tool executor (input has neither thought nor reason)
```

**What the test ground UI shows**:

With both enabled (test ground):

```
💭 "The user mentioned invoice #4521 and said their payment failed
    three times. Looking at context, they have premium plan and are
    frustrated. Billing agent handles payment failures."
📋 reason: "Payment failure on invoice #4521 — billing inquiry"
→  __handoff__({ target: "billing_agent", context: {...} })

💭 "User asked about delivery status for order ORD-789. I need to
    look up the order details to give them a shipping update."
📋 reason: "Looking up order ORD-789 for delivery status"
→  search_orders({ order_id: "ORD-789" })
```

Production (thought disabled, reason always present):

```
📋 reason: "Payment failure on invoice #4521 — billing inquiry"
→  __handoff__({ target: "billing_agent", context: {...} })

📋 reason: "Looking up order ORD-789 for delivery status"
→  search_orders({ order_id: "ORD-789" })
```

**Full schema example — `__handoff__` with both enabled**:

```json
{
  "name": "__handoff__",
  "input_schema": {
    "properties": {
      "thought": {
        "type": "string",
        "description": "Your detailed reasoning for this routing decision"
      },
      "reason": {
        "type": "string",
        "description": "Brief reason for this handoff"
      },
      "target": {
        "type": "string",
        "description": "The specialist to route to:\n- \"billing_agent\": Handles billing inquiries\n- \"support_agent\": Handles technical support",
        "enum": ["billing_agent", "support_agent"]
      },
      "context": { ... }
    },
    "required": ["target", "reason"]
  }
}
```

**Full schema example — regular tool `search_hotels` with both enabled**:

```json
{
  "name": "search_hotels",
  "input_schema": {
    "properties": {
      "thought": {
        "type": "string",
        "description": "Your detailed reasoning for calling this tool"
      },
      "reason": {
        "type": "string",
        "description": "Brief reason for this tool call"
      },
      "destination": { "type": "string", "description": "City to search" },
      "check_in": { "type": "string", "description": "Check-in date" },
      "check_out": { "type": "string", "description": "Check-out date" }
    },
    "required": ["destination", "check_in", "check_out", "reason"]
  }
}
```

**Modes**:

| Mode                 | `reason` | `thought`           | Token overhead per tool call |
| -------------------- | -------- | ------------------- | ---------------------------- |
| Production (default) | Always   | Disabled            | ~10-20 tokens (reason only)  |
| Test ground (debug)  | Always   | Enabled (UI toggle) | ~40-100 tokens (both)        |
| Audit mode           | Always   | Optional            | Configurable                 |

**Summary of all changes across system tools**:

| Tool           | Issue                             | Proposed change                                                                                                                                                           |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All tools**  | No LLM reasoning visible          | `reason` always present (required). `thought` configurable via UI. Both stripped before tool execution. `reason` in `tool_call` trace. `thought` in `tool_thought` trace. |
| `__handoff__`  | `context: "string"` free-form     | Structured object from PASS fields. LLM populates, runtime falls back.                                                                                                    |
| `__handoff__`  | `target` enum — names only        | Add per-agent descriptions from `RoutingRule.description` or `ir.identity.goal`                                                                                           |
| `__delegate__` | `input: "object"` — no properties | Structured object from INPUT mapping.                                                                                                                                     |
| `__delegate__` | `target` enum — names only        | Add per-agent descriptions from `DelegateConfig.purpose`                                                                                                                  |
| `__fan_out__`  | `context: "string"` per dispatch  | Same as handoff — structured per-target PASS fields.                                                                                                                      |
| `__fan_out__`  | `target` enum — names only        | Same as handoff — per-agent descriptions.                                                                                                                                 |
| `__escalate__` | Already has `reason`              | Keep existing `reason`. `thought` is additional when enabled.                                                                                                             |

**Code references**:

- `__handoff__` schema: `prompt-builder.ts:463-481`
- `__handoff__` target descriptions (names only): `prompt-builder.ts:446-451`
- `__handoff__` trace event (no reason): `routing-executor.ts:174-186`
- LLM context parsing (JSON string → object): `routing-executor.ts:121-131`
- PASS field override (should become fallback): `routing-executor.ts:225-232`
- Summary interpolation: `routing-executor.ts:235-240`
- History strategy resolution: `routing-executor.ts:1386-1398`
- `RoutingRule` type (has `description`): `compiler/ir/schema.ts:1260-1267`
- `HandoffConfig` type (no description): `compiler/ir/schema.ts:681-695`
- `AgentIdentity` type (has `goal`): `compiler/ir/schema.ts:266-278`
- `AgentRegistryEntry` type (has `ir`): `types.ts:186-202`
- `__delegate__` schema: `prompt-builder.ts:525-552`
- `__delegate__` target descriptions (has `purpose`): `prompt-builder.ts:528-530`
- `DelegateConfigIR` type: `types.ts:209-219`
- `mapDelegateInput()`: `routing-executor.ts:1425-1439`
- `mapDelegateReturns()`: `routing-executor.ts:1444-1467`
- `__fan_out__` schema: `prompt-builder.ts:483-522`
- `__fan_out__` target descriptions (names only): `prompt-builder.ts:490`
- `__escalate__` schema (already has `reason`): `prompt-builder.ts:557-579`

---

#### GAP-16: All Prompts Must Be Externalized — Prompt Catalog & Ownership Classification

**Severity**: Maintainability + Customization — all prompts are currently hardcoded in TypeScript. Customers cannot tune prompts without code changes. Platform prompt improvements require redeployment.

**Current state**: All prompts live in two places:

- `packages/compiler/src/platform/constants.ts` — named constants (`SYSTEM_PROMPT_TEMPLATES`, `SYSTEM_TOOL_DESCRIPTIONS`, `ENTITY_EXTRACTION_PROMPT`, `DEFAULT_MESSAGES`, `ESCALATION_FORMAT`)
- `apps/runtime/src/services/execution/` — inline strings in `prompt-builder.ts`, `flow-step-executor.ts`, `llm-field-validator.ts`, `routing-executor.ts`

**Complete Prompt Catalog** — every prompt in the codebase, classified as **Seed Data** (platform-owned defaults, stored in DB, overridable by admin) or **Externalize to User** (project-level, configurable per agent/project in UI):

---

**CATEGORY 1: System Prompt Sections** (built by `prompt-builder.ts:108-256`)

| #   | Prompt                             | Current location       | Text                                                                                                                                | Classification  | Why                                                                                                                                                      |
| --- | ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Identity                           | `constants.ts:236`     | `"You are {{name}}, an AI assistant."`                                                                                              | **Seed Data**   | Platform default. Agent's ABL already provides `GOAL` and `PERSONA` which override the identity section. The template wrapper is platform concern.       |
| 2   | Goal                               | `constants.ts:237`     | `"\nYour goal: {{goal}}"`                                                                                                           | **Seed Data**   | Template structure is platform. The `{{goal}}` value comes from ABL (user-defined).                                                                      |
| 3   | Persona                            | `constants.ts:238`     | `"\nPersona: {{persona}}"`                                                                                                          | **Seed Data**   | Same — template wrapper is platform, content from ABL.                                                                                                   |
| 4   | Limitations header                 | `constants.ts:239`     | `"\nLimitations:"`                                                                                                                  | **Seed Data**   | Structural.                                                                                                                                              |
| 5   | Tools available                    | `constants.ts:240`     | `"\nYou have access to tools. Use them when needed to help the user."`                                                              | **Seed Data**   | Platform instruction. Customer doesn't need to change this.                                                                                              |
| 6   | Gather header                      | `constants.ts:243`     | `"\nYou need to gather the following information from the user:"`                                                                   | **Seed Data**   | Platform instruction for entity gathering behavior.                                                                                                      |
| 7   | Gather continuation                | `constants.ts:244-245` | `"\nContinue asking for any missing required fields. The system will automatically detect when all information has been gathered."` | **Externalize** | Customers may want different gathering behavior — e.g., "Ask for all fields at once" vs "One field at a time" vs "Only ask when user doesn't volunteer." |
| 8   | Supervisor header                  | `constants.ts:248`     | `"\n## CRITICAL: You are a ROUTING-ONLY supervisor"`                                                                                | **Seed Data**   | Core routing behavior. Changing this would break the supervisor pattern.                                                                                 |
| 9   | Supervisor mandate                 | `constants.ts:249-250` | `"You MUST use the {{handoff_tool}} tool to route EVERY user request..."`                                                           | **Seed Data**   | Core behavior.                                                                                                                                           |
| 10  | Supervisor no direct response      | `constants.ts:251-252` | `"DO NOT respond to users directly with information or help..."`                                                                    | **Seed Data**   | Core behavior. But note: `supervisor_direct_response_*` variants exist for when `direct_response_allowed: true`.                                         |
| 11  | Supervisor no clarify              | `constants.ts:253-254` | `"DO NOT ask users clarifying questions..."`                                                                                        | **Externalize** | Some customers want supervisors to ask clarifying questions before routing (e.g., "Is this about an existing order or a new purchase?").                 |
| 12  | Supervisor routing header          | `constants.ts:255-256` | `"\n## Routing Rules..."`                                                                                                           | **Seed Data**   | Structural.                                                                                                                                              |
| 13  | Supervisor mandatory header        | `constants.ts:257`     | `"\n## MANDATORY: Always use {{handoff_tool}} tool"`                                                                                | **Seed Data**   | Core behavior.                                                                                                                                           |
| 14  | Supervisor mandatory body          | `constants.ts:258-259` | `"For EVERY user message, you MUST call..."`                                                                                        | **Seed Data**   | Core behavior.                                                                                                                                           |
| 15  | Supervisor never respond           | `constants.ts:260-261` | `"\nNEVER respond without using {{handoff_tool}}..."`                                                                               | **Seed Data**   | Core behavior.                                                                                                                                           |
| 16  | Supervisor multi-intent header     | `constants.ts:262`     | `"\n## Multi-Intent Messages"`                                                                                                      | **Seed Data**   | Structural.                                                                                                                                              |
| 17  | Supervisor multi-intent body       | `constants.ts:263-264` | `"If the user's message contains MULTIPLE distinct requests..."`                                                                    | **Seed Data**   | Core fan-out behavior.                                                                                                                                   |
| 18  | Supervisor multi-intent synthesize | `constants.ts:265-266` | `"You will receive all results and must synthesize one unified response."`                                                          | **Externalize** | Customer may want different synthesis behavior — "return results separately" vs "combine into one response" vs "summarize key points only."              |
| 19  | Supervisor multi-intent single     | `constants.ts:267`     | `"Use {{handoff_tool}} for single-intent messages only."`                                                                           | **Seed Data**   | Core behavior.                                                                                                                                           |
| 20  | Supervisor direct response header  | `constants.ts:270`     | `"\n## Routing Guidance"`                                                                                                           | **Seed Data**   | Structural (for direct_response_allowed mode).                                                                                                           |
| 21  | Supervisor direct response mandate | `constants.ts:271-272` | `"You SHOULD use the {{handoff_tool}} tool to route..."`                                                                            | **Seed Data**   | Softer routing mandate for direct_response_allowed.                                                                                                      |
| 22  | Supervisor direct response simple  | `constants.ts:273-274` | `"For simple greetings, farewells, or trivial queries you may respond directly..."`                                                 | **Externalize** | What counts as "trivial" varies by customer. Some want ALL messages routed, others want greetings handled by supervisor.                                 |
| 23  | Specialist header                  | `constants.ts:277`     | `"\n## Your Role"`                                                                                                                  | **Seed Data**   | Structural.                                                                                                                                              |
| 24  | Specialist body                    | `constants.ts:278`     | `"You are a specialist agent. Help the user directly with your expertise."`                                                         | **Seed Data**   | Core behavior.                                                                                                                                           |
| 25  | Specialist no immediate handoff    | `constants.ts:279`     | `"Do NOT immediately hand off - try to assist the user first."`                                                                     | **Externalize** | Some agents should handoff immediately for certain conditions. Customer may want "Always try to help first" vs "Route immediately if condition matches." |
| 26  | Specialist handoff header          | `constants.ts:280`     | `"\n## Handoff (use only when necessary)"`                                                                                          | **Seed Data**   | Structural.                                                                                                                                              |
| 27  | Specialist handoff body            | `constants.ts:281-282` | `"If the user's request matches one of the specific conditions below..."`                                                           | **Seed Data**   | Core behavior.                                                                                                                                           |
| 28  | Specialist handoff warning         | `constants.ts:283-284` | `"\nIMPORTANT: Only use {{handoff_tool}} when the specific handoff conditions above are met..."`                                    | **Seed Data**   | Safety instruction.                                                                                                                                      |
| 29  | Escalation header                  | `constants.ts:287`     | `"\n## Escalation"`                                                                                                                 | **Seed Data**   | Structural.                                                                                                                                              |
| 30  | Escalation intro                   | `constants.ts:288`     | `"Use the {{escalate_tool}} tool ONLY if:"`                                                                                         | **Seed Data**   | Core behavior.                                                                                                                                           |
| 31  | Escalation triggers                | `constants.ts:289`     | `"- The user explicitly and repeatedly asks for a human agent"`                                                                     | **Externalize** | Customer may want different escalation triggers — "escalate on first request" vs "try twice first" vs "never auto-escalate."                             |
| 32  | Escalation attempt first           | `constants.ts:290-291` | `"\nIMPORTANT: Always attempt to help the user at least once before escalating."`                                                   | **Externalize** | Same — some customers want immediate escalation on human request.                                                                                        |
| 33  | Escalation not routing             | `constants.ts:292`     | `"\nDo NOT escalate for normal routing..."`                                                                                         | **Seed Data**   | Prevents confusion between escalation and routing.                                                                                                       |
| 34  | Voice format header                | `constants.ts:295`     | `"\n## Response Format (Voice Channel)"`                                                                                            | **Seed Data**   | Structural.                                                                                                                                              |
| 35  | Voice format intro                 | `constants.ts:296-297` | `"This conversation is over a voice channel. Responses are read aloud by text-to-speech."`                                          | **Seed Data**   | Platform fact.                                                                                                                                           |
| 36  | Voice format rules                 | `constants.ts:298-299` | `"Rules: Use plain conversational text only. No markdown... Keep responses concise."`                                               | **Externalize** | Customer may want different voice style — "formal" vs "casual", "brief" vs "detailed", allow certain formatting.                                         |
| 37  | Fallback identity                  | `constants.ts:302`     | `"You are {{name}}, an AI assistant."`                                                                                              | **Seed Data**   | Used when IR has no identity.                                                                                                                            |
| 38  | Fallback instruction               | `constants.ts:303`     | `"\nHelp the user with their request in a friendly and helpful manner."`                                                            | **Seed Data**   | Last resort.                                                                                                                                             |
| 39  | Context header                     | `constants.ts:306`     | `"\n## Current Context"`                                                                                                            | **Seed Data**   | Structural.                                                                                                                                              |
| 40  | Memory header                      | `constants.ts:309`     | `"\n## Recalled Memory Instructions"`                                                                                               | **Seed Data**   | Structural.                                                                                                                                              |

---

**CATEGORY 2: System Tool Descriptions** (`constants.ts:320-355`)

| #   | Prompt                           | Current location       | Text (abbreviated)                                                                                      | Classification | Why                                                                  |
| --- | -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| 41  | Handoff — supervisor desc        | `constants.ts:322-323` | `"MANDATORY: Use this tool to route the user to the appropriate specialist..."`                         | **Seed Data**  | Core routing instruction.                                            |
| 42  | Handoff — supervisor target desc | `constants.ts:324`     | `"The name of the agent to hand off to. REQUIRED for every user message."`                              | **Seed Data**  | Parameter description.                                               |
| 43  | Handoff — agent desc             | `constants.ts:325-326` | `"Transfer the conversation to another specialist ONLY when one of the specific handoff conditions..."` | **Seed Data**  | Core specialist behavior.                                            |
| 44  | Handoff — agent target desc      | `constants.ts:327-328` | `"The name of the specialist to transfer to. Only use if you cannot help directly."`                    | **Seed Data**  | Parameter description.                                               |
| 45  | Handoff — context desc           | `constants.ts:329`     | `"JSON context to pass to the target agent (optional)"`                                                 | **Seed Data**  | Parameter description. (Will change per GAP-15 — structured schema.) |
| 46  | Delegate — desc                  | `constants.ts:332-333` | `"Call a sub-agent and use their result..."`                                                            | **Seed Data**  | Core behavior.                                                       |
| 47  | Delegate — target desc           | `constants.ts:334`     | `"The name of the sub-agent to delegate to"`                                                            | **Seed Data**  | Parameter description.                                               |
| 48  | Delegate — input desc            | `constants.ts:335-336` | `"Input data to pass to the sub-agent..."`                                                              | **Seed Data**  | Parameter description.                                               |
| 49  | Escalate — desc                  | `constants.ts:339-340` | `"Transfer the conversation to a human agent..."`                                                       | **Seed Data**  | Core behavior.                                                       |
| 50  | Escalate — reason desc           | `constants.ts:341`     | `"Reason for escalation"`                                                                               | **Seed Data**  | Parameter description.                                               |
| 51  | Escalate — priority desc         | `constants.ts:342`     | `"Priority level"`                                                                                      | **Seed Data**  | Parameter description.                                               |
| 52  | Fan-out — desc                   | `constants.ts:345-349` | `"Handle a message with MULTIPLE distinct requests..."`                                                 | **Seed Data**  | Core behavior.                                                       |
| 53  | Fan-out — tasks desc             | `constants.ts:350`     | `"List of sub-tasks to dispatch..."`                                                                    | **Seed Data**  | Parameter description.                                               |
| 54  | Fan-out — target desc            | `constants.ts:351`     | `"The specialist agent to handle this sub-task"`                                                        | **Seed Data**  | Parameter description.                                               |
| 55  | Fan-out — intent desc            | `constants.ts:352`     | `"What this agent should handle (the user's sub-request)"`                                              | **Seed Data**  | Parameter description.                                               |
| 56  | Fan-out — context desc           | `constants.ts:353`     | `"Optional context to pass to the agent"`                                                               | **Seed Data**  | Parameter description.                                               |

---

**CATEGORY 3: Entity Extraction Prompt** (`constants.ts:366-389`)

| #   | Prompt                   | Current location       | Text (abbreviated)                                                                                                                                                  | Classification  | Why                                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 57  | Extraction system prompt | `constants.ts:366-389` | `"You are an entity extraction assistant. Extract information from the user's message.\n\nReturn ONLY a valid JSON object..."` (full template with RULES, examples) | **Externalize** | This is the most impactful prompt for extraction quality. Customers need to tune: extraction rules, date formats, capitalization, inference behavior ("Only extract values the user explicitly stated" vs "Infer reasonable defaults"). Examples should be customizable per domain. |

---

**CATEGORY 4: Correction Detection Prompt** (`flow-step-executor.ts:309-321`)

| #   | Prompt               | Current location                | Text (abbreviated)                                                                                                                                | Classification  | Why                                                                                                                                                                                                                                        |
| --- | -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 58  | Correction detection | `flow-step-executor.ts:309-321` | `"You are a correction detection assistant. Determine if the user is correcting a previously provided value..."` (with RULES, correction phrases) | **Externalize** | Correction patterns vary by language and domain. "Actually", "I meant", "change to" are English-centric. Multilingual deployments need different patterns. Domain-specific corrections ("wrong room, I meant suite") need custom examples. |

---

**CATEGORY 5: LLM Field Validation Prompt** (`llm-field-validator.ts:48-55`)

| #   | Prompt           | Current location               | Text (abbreviated)                                                                                                                                                              | Classification | Why                                                                                                                                                                                                                          |
| --- | ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 59  | Field validation | `llm-field-validator.ts:48-55` | `"You are a validation assistant. Validate the given value against the rule.\nReturn ONLY a JSON object: {\"valid\": true} or {\"valid\": false, \"reason\": \"explanation\"}"` | **Seed Data**  | Structural prompt for validation. The actual validation rule comes from ABL (user-defined). The template wrapper is platform concern. If GAP-14 is implemented (fold LLM validation into extraction), this becomes obsolete. |

---

**CATEGORY 6: Default User-Facing Messages** (`constants.ts:69-119`)

| #     | Prompt                    | Key                                          | Text                                                         | Classification  | Why                                                       |
| ----- | ------------------------- | -------------------------------------------- | ------------------------------------------------------------ | --------------- | --------------------------------------------------------- |
| 60    | Error default             | `error_default`                              | `"An error occurred. Please try again."`                     | **Externalize** | Customer branding. Different tone per company.            |
| 61    | Constraint blocked        | `constraint_blocked`                         | `"I cannot proceed with that request."`                      | **Externalize** | Customer tone/policy.                                     |
| 62    | Gather prompt             | `gather_prompt`                              | `"Please provide: {{fields}}"`                               | **Externalize** | Customer may want friendlier: "Could you please share..." |
| 63    | Escalation format         | `escalation_format`                          | `"Escalating to human agent. Reason: {{reason}}"`            | **Externalize** | Brand voice.                                              |
| 64    | Conversation complete     | `conversation_complete`                      | `"This conversation has been completed."`                    | **Externalize** | Brand voice.                                              |
| 65    | Invalid handoff           | `invalid_handoff`                            | `"Unable to transfer to the requested agent."`               | **Seed Data**   | Error message. Internal concern.                          |
| 66    | Self handoff              | `self_handoff`                               | `"Cannot hand off to self."`                                 | **Seed Data**   | Error guard. Internal.                                    |
| 67    | Tool fallback desc        | `tool_fallback_desc`                         | `"Execute the requested operation."`                         | **Seed Data**   | Fallback tool description. Internal.                      |
| 68    | Empty input               | `empty_input`                                | `"Please provide a message."`                                | **Externalize** | User-facing.                                              |
| 69    | Max iterations            | `max_iterations`                             | `"I was unable to complete the response. Please try again."` | **Externalize** | User-facing error.                                        |
| 70    | Constraint respond        | `constraint_respond`                         | `"Request cannot be processed."`                             | **Externalize** | Customer policy tone.                                     |
| 71    | Constraint collect        | `constraint_collect`                         | `"Additional information needed."`                           | **Externalize** | User-facing.                                              |
| 72    | Constraint backtrack      | `constraint_backtrack`                       | `"Let me take a step back."`                                 | **Externalize** | User-facing tone.                                         |
| 73    | Constraint redact         | `constraint_redact`                          | `"That information has been redacted."`                      | **Externalize** | Customer compliance tone.                                 |
| 74    | Handoff message (digital) | `handoff_message`                            | `"\n\n📤 **Transferring to {{target}}...**\n\n"`             | **Externalize** | Brand styling. Emoji usage.                               |
| 75    | Handoff message (voice)   | `handoff_message_voice`                      | `"Transferring you to {{target}}. One moment please."`       | **Externalize** | Voice tone.                                               |
| 76    | Remote handoff message    | `remote_handoff_message`                     | `"\n\n📤 **Connecting to remote agent {{target}}...**\n\n"`  | **Externalize** | Brand styling.                                            |
| 77    | Remote handoff (voice)    | `remote_handoff_message_voice`               | `"Connecting you to {{target}}. Please hold."`               | **Externalize** | Voice tone.                                               |
| 78    | Routing message           | `routing_message`                            | `"Routing to {{target}} for assistance."`                    | **Externalize** | User-facing.                                              |
| 79-87 | Error executor messages   | `error_tool_timeout` through `error_unknown` | Various error recovery messages                              | **Externalize** | All user-facing, brand tone. See constants.ts:96-109.     |
| 88-93 | Voice messages            | `voice_repeat` through `voice_error`         | Various voice channel messages                               | **Externalize** | Voice UX, brand tone.                                     |
| 94    | Greeting                  | `greeting`                                   | `"How can I help you?"`                                      | **Externalize** | Brand voice. First impression.                            |

---

**CATEGORY 7: Escalation Format Templates** (`constants.ts:193-198`)

| #   | Prompt               | Key                         | Text                                                                                                                                 | Classification  | Why                         |
| --- | -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------- | --------------------------- |
| 95  | Escalation — digital | `ESCALATION_FORMAT.digital` | `"🔔 **Escalated to Human Agent**\nReason: {{reason}}\nPriority: {{priority}}\n\n[A human agent will respond to your next message]"` | **Externalize** | Brand styling, emoji, tone. |
| 96  | Escalation — voice   | `ESCALATION_FORMAT.voice`   | `"Escalated to human agent. Reason: {{reason}}. Priority: {{priority}}."`                                                            | **Externalize** | Voice tone.                 |
| 97  | Escalation — plain   | `ESCALATION_FORMAT.plain`   | `"Escalated to human agent. Reason: {{reason}}. Priority: {{priority}}"`                                                             | **Externalize** | API/webhook tone.           |

---

**CATEGORY 8: Fan-out Synthesis Instructions** (`routing-executor.ts:1557-1564`)

| #   | Prompt                  | Current location                | Text                                                                                                            | Classification  | Why                                                                                                                                        |
| --- | ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 98  | Fan-out — with failures | `routing-executor.ts:1559-1560` | `"Synthesize a unified response covering all successful results. For failures, explain the issue to the user."` | **Externalize** | How the LLM combines multi-agent results. Customer may want: "list each result separately", "summarize", "highlight failures prominently." |
| 99  | Fan-out — all success   | `routing-executor.ts:1563-1564` | `"Synthesize a single unified response covering all results above."`                                            | **Externalize** | Same — synthesis style varies by customer.                                                                                                 |

---

**SUMMARY — Classification Counts**:

| Classification          | Count | Description                                                                                                                                                                                                           |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Seed Data**           | ~50   | Platform-owned defaults. Stored in DB as seed data. Admin can override globally. Structural templates, core behavior, parameter descriptions, safety guards.                                                          |
| **Externalize to User** | ~49   | Project-level configurable. Editable per agent or per project in Studio UI. User-facing messages, extraction prompts, correction prompts, voice style, escalation format, synthesis instructions, gathering behavior. |

**Implementation approach**:

1. **Seed Data** → Store in a `prompt_templates` table (or MongoDB collection) with:
   - `key`: e.g., `system_prompt.identity`, `tool_desc.handoff.supervisor`
   - `template`: the prompt text with `{{variable}}` placeholders
   - `category`: `system_prompt` | `tool_description` | `extraction` | `validation` | `default_message`
   - `locale`: `en` (ready for i18n)
   - Seeded on deployment. Platform updates seed new versions. Admin can override.

2. **Externalize to User** → Store at project level with:
   - `projectId` + `key` + `locale`
   - Editable in Studio UI (Settings → Prompts)
   - Falls back to seed data if not overridden
   - Resolution: Project override → Seed data → Hardcoded constant (last resort)

3. **Resolution chain at runtime** (`prompt-builder.ts`):
   ```
   projectPrompts[key]  →  seedPrompts[key]  →  CONSTANTS[key]
   (user override)          (DB seed data)        (hardcoded fallback)
   ```

**Highest-impact prompts to externalize first** (ordered by customer value):

1. **#57 Entity extraction prompt** — directly impacts extraction quality. Different domains need different rules and examples.
2. **#58 Correction detection prompt** — language/domain specific.
3. **#60-94 All DEFAULT_MESSAGES** — brand voice, tone, emoji usage.
4. **#95-97 Escalation formats** — compliance, brand styling.
5. **#7 Gather continuation** — gathering strategy varies.
6. **#36 Voice format rules** — voice UX customization.
7. **#98-99 Fan-out synthesis** — multi-agent response style.
8. **#31-32 Escalation triggers/behavior** — escalation policy varies.
9. **#11 Supervisor no clarify** — some supervisors should ask questions.
10. **#25 Specialist no immediate handoff** — handoff eagerness varies.

---

**System prompt should be a single template, not fragmented parts.push()**:

The current `buildSystemPrompt()` (`prompt-builder.ts:107-256`) constructs the prompt by pushing ~30 fragments into a `parts[]` array with interleaved conditionals:

```typescript
// Current: 150 lines of scattered parts.push() with branching
const parts: string[] = [];
parts.push(`You are ${name}, an AI assistant.`);
if (ir.identity?.goal) parts.push(`\nYour goal: ${ir.identity.goal}`);
if (ir.identity?.persona) parts.push(`\nPersona: ${ir.identity.persona}`);
if (isSupervisor) {
  parts.push(`\n## CRITICAL: You are a ROUTING-ONLY supervisor`);
  parts.push(`You MUST use the ${SYSTEM_TOOL_HANDOFF}...`);
  parts.push(`DO NOT respond to users directly...`);
  parts.push(`DO NOT ask users clarifying questions...`);
  // ... 15 more pushes
} else if (hasHandoffs) {
  parts.push(`\n## Your Role`);
  parts.push(`You are a specialist agent...`);
  // ... 8 more pushes
}
if (ir.coordination?.escalation) {
  parts.push(`\n## Escalation`);
  // ... 5 more pushes
}
if (isVoiceChannel(session)) {
  // ... 3 more pushes
}
return parts.join('\n');
```

**Problems with fragmented approach**:

1. **Can't see the full prompt** — you have to mentally execute branching across 150 lines to know what the LLM actually sees
2. **Can't externalize as one unit** — no single template to override. You'd need 30+ separate DB rows for fragments
3. **Order is implicit** — depends on code execution order, easy to accidentally reorder
4. **Non-engineers can't review** — prompt tuning requires reading TypeScript conditionals
5. **Can't A/B test** — swapping prompt structure requires code changes and redeployment
6. **Contradicts GAP-16** — externalization needs whole templates, not fragments

**Proposed: Single template per agent type with section placeholders**:

Three base templates: `supervisor`, `specialist`, `standalone`. Each is a complete prompt with conditional sections. The runtime resolves placeholders and strips empty sections.

```
{{! Base template: supervisor }}
You are {{name}}, an AI assistant.
{{#if goal}}
Your goal: {{goal}}
{{/if}}
{{#if persona}}
Persona: {{persona}}
{{/if}}
{{#if limitations}}
Limitations:
{{#each limitations}}- {{this}}
{{/each}}
{{/if}}
{{#if tools}}
You have access to tools. Use them when needed to help the user.
{{/if}}
{{#if gather_fields}}
You need to gather the following information from the user:
{{#each gather_fields}}- {{name}}: {{prompt}} ({{required_label}})
{{/each}}
{{gather_continuation}}
{{/if}}

## CRITICAL: You are a ROUTING-ONLY supervisor
{{supervisor_mandate}}
{{supervisor_no_direct}}
{{supervisor_no_clarify}}

## Routing Rules (use {{handoff_tool}} tool with target parameter):
{{#each routing_rules}}- **{{to}}**: {{description}}
{{/each}}

## MANDATORY: Always use {{handoff_tool}} tool
{{supervisor_mandatory_body}}
{{supervisor_never_respond}}

## Multi-Intent Messages
{{supervisor_multi_intent_body}}
{{supervisor_synthesize}}
{{supervisor_single_intent}}

{{#if escalation}}
## Escalation
{{escalation_instructions}}
{{/if}}
{{#if voice_channel}}
## Response Format (Voice Channel)
{{voice_format_rules}}
{{/if}}
{{#if context}}
## Current Context
{{context_json}}
{{/if}}
{{#if recall_prompts}}
## Recalled Memory Instructions
{{#each recall_prompts}}{{this}}
{{/each}}
{{/if}}
```

**Benefits of single-template approach**:

| Aspect                   | Fragmented `parts.push()`                 | Single template                                                                         |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| **Readability**          | 150 lines of TypeScript to mental-execute | One readable template — what you see is what LLM gets                                   |
| **Externalization**      | 30+ DB rows, complex reassembly           | 1 template per agent type in DB. Override the whole thing or individual `{{sections}}`. |
| **Non-engineer editing** | Requires TypeScript knowledge             | Plain text with `{{placeholders}}` — prompt engineers can edit directly                 |
| **A/B testing**          | Code change + deploy                      | Swap template in DB, no deploy                                                          |
| **Version control**      | Git diff on code changes                  | Template versioning in DB + audit trail                                                 |
| **Section ordering**     | Implicit in code                          | Explicit in template — reorder by moving text                                           |
| **Prompt review**        | Read code, trace conditionals             | Read template, see exact output                                                         |

**Implementation**:

```typescript
// prompt-builder.ts — new approach
export function buildSystemPrompt(session: RuntimeSession): string {
  const ir = session.agentIR;
  const agentType = getAgentType(ir); // 'supervisor' | 'specialist' | 'standalone'

  // 1. Load template (project override → seed → hardcoded fallback)
  const template = resolvePromptTemplate(`system_prompt.${agentType}`, session);

  // 2. Build context object with all placeholders
  const context = {
    name: ir?.metadata?.name || session.agentName,
    goal: ir?.identity?.goal,
    persona: ir?.identity?.persona,
    limitations: ir?.identity?.limitations,
    tools: ir?.tools?.length > 0,
    gather_fields: ir?.gather?.fields?.map((f) => ({
      name: f.name,
      prompt: f.prompt || f.name,
      required_label: f.required !== false ? 'required' : 'optional',
    })),
    gather_continuation: resolvePromptTemplate('gather_continuation', session),
    routing_rules: ir?.routing?.rules,
    handoff_tool: SYSTEM_TOOL_HANDOFF,
    fan_out_tool: SYSTEM_TOOL_FAN_OUT,
    escalate_tool: SYSTEM_TOOL_ESCALATE,
    escalation: ir?.coordination?.escalation,
    voice_channel: isVoiceChannel(session),
    voice_format_rules: resolvePromptTemplate('voice_format_rules', session),
    context_json: JSON.stringify(contextValues, null, 2),
    recall_prompts: session.data.values._recallPrompts,
    // ... supervisor-specific, specialist-specific sections
  };

  // 3. Render template with context
  return renderTemplate(template, context);
}
```

The `renderTemplate()` function handles `{{variable}}`, `{{#if}}`, `{{#each}}`, and strips empty sections. This is a lightweight template engine — no need for Handlebars/Mustache as a dependency, a ~50-line implementation suffices.

**Same approach for extraction and correction prompts**:

```typescript
// Instead of inline string in flow-step-executor.ts:
const extractionTemplate = resolvePromptTemplate('extraction', session);
const correctionTemplate = resolvePromptTemplate('correction_detection', session);
const validationTemplate = resolvePromptTemplate('field_validation', session);
```

**Template resolution chain** (same as GAP-16):

```
projectPrompts[key]  →  seedPrompts[key]  →  HARDCODED_TEMPLATES[key]
(user override)          (DB seed data)        (constants.ts fallback)
```

**Code references**:

- Current fragmented prompt building: `prompt-builder.ts:107-256`
- System prompt templates (already partially extracted): `constants.ts:234-310`
- Entity extraction prompt (already a single template): `constants.ts:366-389`
- Correction detection prompt (inline): `flow-step-executor.ts:309-321`
- Validation prompt (inline): `llm-field-validator.ts:48-55`

---

## Remaining Areas to Explore

The following ABL nuances have not yet been analyzed. Each needs a deep-dive with code tracing, gap identification, and documentation — to be resumed after the current gaps (GAP-9 through GAP-16) are addressed.

### 1. Error Handling

- `ON_ERROR` declaration in ABL DSL — per-step and agent-level error handlers
- `resolveErrorHandler()` in runtime — maps error categories to handler config
- Error categories: `tool_error`, `llm_timeout`, `llm_error`, `validation_error`, `constraint_error`, `delegation_error`, `handoff_error`, `memory_error`, `unknown`
- Retry with exponential backoff: `executeWithRetry()` with configurable `retryCount`, `retryDelays`, `maxBackoffMs`
- Error executor messages in `DEFAULT_MESSAGES` (constants.ts:96-109)
- How errors propagate vs get swallowed in the tool-use loop

**Key files**: `reasoning-executor.ts` (tool error handling), `flow-step-executor.ts` (step error handling), `constants.ts` (error handler limits), `compiler/ir/schema.ts` (ErrorHandlerConfig)

### 2. Flow Mode — Step Types & Transitions

- Step types: `GATHER`, `CALL`, `BRANCH`, `RESPOND`, `TRANSFORM`, `COMPLETE`
- Step execution loop: `executeFlowStep()` — iterative, not recursive
- `ON_SUCCESS SET` — variable mapping from tool results (works in flow mode, GAP-12 for reasoning)
- `ON_FAILURE` — per-step failure handling
- `NEXT` / `GOTO` — step transitions, conditional branching
- `BRANCH WHEN` — condition-based routing between steps
- How gather steps interact with extraction (per-step entity extraction)
- Flow graph validation at compile time (`validateFlowGraph()`)

**Key files**: `flow-step-executor.ts`, `compiler/ir/schema.ts` (FlowStepIR, BranchConfig), `compiler/ir/compiler.ts` (flow compilation)

### 3. Completion Conditions

- `checkAndMarkComplete()` — runtime-evaluated after each turn, not LLM-triggered
- `COMPLETE WHEN` conditions in ABL — compiled to `CompletionCondition[]` in IR
- `ON_COMPLETE` actions — what happens when completion triggers (respond, handoff, etc.)
- How `__complete__` was removed as a tool (Option C) and why
- `tryThreadReturn()` — how completed child threads trigger parent return
- Interaction between completion and thread lifecycle

**Key files**: `routing-executor.ts` (checkAndMarkComplete, handleComplete), `compiler/ir/schema.ts` (CompletionConfig, CompletionCondition)

### 4. Escalation — Deep Dive

- `ESCALATE` declaration in ABL — triggers, routing, priority
- Automatic triggers: `WHEN` conditions that auto-escalate without LLM decision
- Escalation routing: `queue`, `skill_tags`, `priority_boost`
- `context_for_human` — which session fields are shared with the human agent
- `ON_HUMAN_COMPLETE` — what happens when the human agent resolves the issue
- `filterEscalationContext()` — how context is filtered for human handoff
- Interaction between escalation and thread model

**Key files**: `routing-executor.ts` (handleEscalate, filterEscalationContext), `compiler/ir/schema.ts` (EscalationConfig, EscalationTrigger, EscalationRouting, OnHumanComplete)

### 5. Supervisor / Routing Mode

- Intent classification: LLM-based vs rule-based
- Routing rules: priority ordering, `WHEN` conditions, `description` for each target
- `default_agent` — fallback when no rule matches
- `direct_response_allowed` — supervisor can respond directly for trivial queries
- How routing interacts with the handoff tool schema
- Multi-agent topology: supervisor → specialist chains, nested supervisors
- Compilation of routing rules from DSL to IR

**Key files**: `prompt-builder.ts` (supervisor prompt building), `routing-executor.ts` (evaluateHandoffConditions), `compiler/ir/schema.ts` (RoutingConfig, RoutingRule, IntentConfig)

### 6. Voice & Channel-Specific Behavior

- Channel detection: `isVoiceChannel()` — how channel is determined
- Voice-specific messages in `DEFAULT_MESSAGES` (voice_repeat, voice_nomatch, etc.)
- Voice latency target: `execution.voice_latency_target_ms`
- TTS constraints in system prompt (no markdown, no emoji, plain text)
- Channel-specific escalation format (digital vs voice vs plain)
- How `VoiceConfigIR` is interpolated per step/response
- Channel adapters at the edge layer

**Key files**: `prompt-builder.ts` (isVoiceChannel, voice format), `constants.ts` (voice messages, ESCALATION_FORMAT), `compiler/ir/schema.ts` (VoiceConfigIR, ExecutionConfig)

### 7. Conversation Windows & History Management

- `maxMessages` config — sliding window cap on conversation history
- How history is truncated before LLM calls
- History strategy during handoff: `none`, `full`, `summary_only`, `{ last_n: N }`
- Ephemeral tool call messages vs persisted conversation history (covered partially — GAP area)
- Token counting and context budget management
- How system prompt + history + tools compete for context window

**Key files**: `reasoning-executor.ts` (message building), `prompt-builder.ts` (system prompt size), `routing-executor.ts` (resolveHistoryStrategy)

### 8. ON_START Hooks — Session Initialization

- `ON_START` declaration in ABL — actions to run when session begins
- Initial tool calls at session start
- Greeting message generation
- Loading persistent defaults from FactStore (`loadPersistentDefaults()`)
- Recall-on-session-start events
- How `session.initialized` flag prevents re-running ON_START

**Key files**: `runtime-executor.ts` (session initialization), `memory-integration.ts` (loadPersistentDefaults), `compiler/ir/schema.ts` (OnStartConfig)

### 9. Compilation Pipeline — DSL to IR

- Parser: DSL text → AST (structured parse tree)
- Validator: AST → validation diagnostics (errors, warnings)
- Compiler: AST → AgentIR (compiled intermediate representation)
- `validateToolReferences()` — verify all tool calls reference declared tools
- `validateFlowGraph()` — verify step connectivity (no orphans, no cycles)
- `ValidationDiagnostic` — structured errors with severity, location, message
- Multi-agent compilation: project-level compilation of all agents
- Partial compilation: compile what you can, collect errors for the rest

**Key files**: `compiler/ir/compiler.ts`, `compiler/ir/schema.ts`, `compiler/ir/validator.ts` (if exists), `compiler/src/parser/` (DSL parsing)

### 10. A2A Protocol — Remote Agent Handoffs

- Agent-to-Agent protocol integration
- Remote agent registration: `registerRemoteAgent()` with endpoint, protocol, auth
- `handleRemoteHandoff()` — A2A task creation, message exchange
- Agent cards: discovery and capability declaration
- Task lifecycle: submitted → working → completed/failed
- Auth for remote agents: API key, bearer token, OAuth
- SSRF protection on remote endpoints: `validateUrlForSSRF()`

**Key files**: `routing-executor.ts` (handleRemoteHandoff, registerRemoteAgent), `packages/a2a/` (A2A client, types), `compiler/ir/schema.ts` (RemoteAgentLocation)

### 11. Multimodal — Attachments & Content Blocks

- Attachment preprocessing: how uploaded files are handled
- `ContentBlock` types: text, image, file
- `pendingContentBlocks` on session — prepended to next LLM call
- How multimodal content flows through the reasoning loop
- Image/file handling per LLM provider
- Attachment storage and lifecycle

**Key files**: `runtime-executor.ts` (attachment handling), `reasoning-executor.ts` (content block prepending), session types (ContentBlock, MessageContent)

### 12. Security — SSRF, Encryption, Sandboxing

- SSRF protection: `validateUrlForSSRF()` — blocks private IP ranges, metadata endpoints
- Tool execution sandboxing: `SandboxToolExecutor` isolation
- Redis encryption: `EncryptionService` with tenant-scoped DEKs
- Field-level encryption for PII in session data
- Secret management: `SecretsProvider` for API keys, tokens
- URL validation before HTTP tool calls

**Key files**: `routing-executor.ts` (SSRF validation), `packages/a2a/` (SsrfEndpointValidator), `session/redis-session-store.ts` (encryption), `compiler/ir/schema.ts` (tool bindings)
