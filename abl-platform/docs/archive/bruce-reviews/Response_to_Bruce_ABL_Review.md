# ABL Spec Review — Consolidated Response

This document consolidates all issues raised across both rounds of review, with explanations, working ABL examples, and current implementation status.

---

## 1. Condition Comparator Redundancy

> _"You use comparator but also have a separate entry for '==', which seems redundant."_

The EBNF grammar was redundant — an artifact from an earlier draft that only supported equality. Fixed to:

```ebnf
condition = expression comparator expression
          | "NOT" condition
          | condition "AND" condition
          | condition "OR" condition

comparator = "==" | "!=" | ">" | ">=" | "<" | "<="
```

All six operators work in the evaluator:

```
CONSTRAINTS:
  pre_booking:
    - REQUIRE check_availability.status == "available"
      ON_FAIL: "Room is not available."
    - REQUIRE selected_hotel.rating != 0
      ON_FAIL: "Hotel has no rating data."
    - REQUIRE selected_hotel.rooms_available > 0
      ON_FAIL: "No rooms left."
    - REQUIRE user.age >= 18
      ON_FAIL: "You must be 18 or older to reserve."
    - REQUIRE booking.total < 10000
      ON_FAIL: "Bookings over $10,000 require manager approval."
    - REQUIRE guests <= selected_room.max_occupancy
      ON_FAIL: "Max occupancy for this room is {selected_room.max_occupancy}."
```

**Status:** Spec fixed. Evaluator complete.

---

## 2. AND/OR Condition Grouping — No Parenthetical Priority

> _"There are AND and OR, but no way to prioritize (x AND y) OR z."_

Parenthetical grouping IS supported — the spec just didn't show examples:

```
CONSTRAINTS:
  pre_search:
    - REQUIRE (destination IS SET AND checkin IS SET) OR override_search == true
      ON_FAIL: "Please provide destination and check-in date."

    - REQUIRE (user.loyalty_tier == "Gold" OR user.loyalty_tier == "Platinum") AND booking.total > 1000
      ON_FAIL: "This discount requires Gold/Platinum loyalty on bookings over $1,000."

    - REQUIRE (room_type == "suite" AND guests <= 4) OR (room_type == "standard" AND guests <= 2)
      ON_FAIL: "Guest count exceeds maximum for the selected room type."
```

Precedence without parens: `NOT` binds tightest, then `AND`, then `OR`. So `A OR B AND C` = `A OR (B AND C)`.

**Status:** Working. Examples added to spec.

---

## 3. Pre-Search Constraints — User Reply Handling and Phase Timing

> _"If the user replies YES, how does agent know what to do? What does pre_search even mean — we won't know about minimum stay until a search has happened."_

### What happens when the user replies YES to an ON_FAIL message?

In **reasoning mode**, the LLM interprets the user's reply and decides which fields to re-collect. In **scripted mode**, explicit branching handles it:

```
FLOW:
  validate_stay:
    CALL: validate_minimum_stay(destination, checkin, checkout)
      AS: stayResult
    ON_RESULT:
      - IF: stayResult.valid == true
        THEN: search
      - ELSE:
        RESPOND: |
          {destination} requires a minimum of {stayResult.minimum} nights.
          You've selected {stayResult.nights}. Extend your stay?
        THEN: handle_extend

  handle_extend:
    ON_INPUT:
      - IF: input == "yes" OR yes
        CLEAR: checkout
        RESPOND: "What would you like your new check-out date to be?"
        THEN: recollect_checkout
      - IF: input == "no" OR no
        CLEAR: destination, checkin, checkout
        RESPOND: "Would you like to try a different destination?"
        THEN: collect_details
      - ELSE:
        RESPOND: "Please say yes or no."
        THEN: handle_extend
```

### How Constraint Phases Actually Work

Phase labels like `pre_search` are **authoring conventions, not runtime dispatch.** Here's the full lifecycle:

**Layer 1 — ABL Declaration:** Constraints are grouped under named phase labels. Phase labels are arbitrary strings — `pre_search`, `pre_booking`, `always`, `my_custom_phase` are all valid. They are not system keywords.

```
CONSTRAINTS:
  pre_search:
    - REQUIRE destination IS SET
      ON_FAIL: "Where would you like to stay?"
    - REQUIRE check_blackout_dates.allowed == true
      ON_FAIL: "Those dates are blacked out."

  pre_booking:
    - REQUIRE user.email IS SET
      ON_FAIL: "I need your email to confirm."

  always:
    - REQUIRE clarification_count < 5
      ON_FAIL: ESCALATE
```

**Layer 2 — Parser:** Produces `ConstraintPhase[]` preserving the phase names and grouping requirements under each.

**Layer 3 — Compiler (phase flattening):** The compiler **discards phase names** and flattens everything into a single array. The IR schema has no phase field.

The `autoGuardConstraint()` function prepends `VAR IS NOT SET OR` to every variable reference:

```
Input:  "check_blackout_dates.allowed == true"
Output: "check_blackout_dates.allowed IS NOT SET OR check_blackout_dates.allowed == true"

Input:  "destination IS SET"
Output: "destination IS SET"  (unchanged — already contains IS SET)
```

This means:

| Constraint                             | Auto-Guarded?           | When It Activates                              |
| -------------------------------------- | ----------------------- | ---------------------------------------------- |
| `destination IS SET`                   | No (already has IS SET) | Every turn — prompts user immediately          |
| `check_blackout_dates.allowed == true` | Yes                     | Only after `check_blackout_dates` tool returns |
| `user.email IS SET`                    | No                      | Every turn — prompts user immediately          |
| `selected_hotel.rooms_available > 0`   | Yes                     | Only after `selected_hotel` exists in session  |

**Layer 4 — Runtime:** Checks ALL constraints as a flat list at specific checkpoints (after extraction in reasoning mode, before/after each step in scripted mode). Short-circuits on first failure.

```
ABL Source              Parser                 Compiler                Runtime
----------              ------                 --------                -------
CONSTRAINTS:            ConstraintPhase[]      ConstraintConfig        checkConstraintsCore()
  pre_search:    --->   [{name:"pre_search",   {constraints: [    --> for each constraint:
    - REQUIRE A           requirements:[A,B]}    {cond: guard(A)},      evaluate against
    - REQUIRE B         {name:"pre_booking",     {cond: guard(B)},      session context
  pre_booking:           requirements:[C,D]}     {cond: guard(C)},      first failure -> return
    - REQUIRE C         {name:"always",          {cond: guard(D)},      all pass -> null
    - REQUIRE D          requirements:[E]}]      {cond: guard(E)}]}
  always:
    - REQUIRE E         phase names ---------> DISCARDED
                        auto-guards ---------> ADDED
```

**Why `pre_search` works:** These constraints reference lightweight policy validation tools (`check_blackout_dates`, `validate_minimum_stay`) that check business rules using just the gathered inputs — they don't query hotel inventory. The auto-guard ensures they only fire after those tools return.

**Status:** Fully implemented across parser, compiler, and runtime.

---

## 4. HANDOFF — Permanent vs Transient

> _"How would you know if handoff is permanent or transient? If you have to wait for the 2nd agent to return that doesn't help."_

The `EXPECT_RETURN` field (renamed from `RETURN` for clarity) controls this explicitly:

```
HANDOFF:
  # Permanent — Hotel_Search terminates, Payment_Agent takes over
  - TO: Payment_Agent
    WHEN: reservation.ready_for_payment == true
    CONTEXT:
      pass: [reservation, selected_hotel, user.email]
      summary: "Booking {selected_hotel.name}, ${reservation.total}"
    EXPECT_RETURN: false

  # Temporary — Hotel_Search pauses, Flight_Search runs, then returns
  - TO: Flight_Search
    WHEN: user.intent == "also_need_flight"
    CONTEXT:
      pass: [destination, checkin, checkout]
      summary: "User also needs flights to {destination}"
    EXPECT_RETURN: true
    TIMEOUT: 300
    ON_TIMEOUT: ESCALATE with REASON: "Flight search took too long"
```

- `EXPECT_RETURN: false` = permanent. Parent thread completes.
- `EXPECT_RETURN: true` = temporary. Parent pushed onto thread stack. TIMEOUT handles the case where the target agent never returns.

**Status:** EXPECT_RETURN working. TIMEOUT/ON_TIMEOUT fields — see [Open Items](#open-items).

---

## 5. Currency in Escalation Triggers

> _"5000 yen is only $32. Wouldn't it be better to have currency as part of number?"_

The correct approach is currency normalization at the tool level:

```
TOOLS:
  create_reservation(hotel_id: string, room_type: string, dates: DateRange, guest: GuestInfo) -> {
    confirmation_number: string,
    total: number,           # Always in USD (normalized by the tool)
    original_total: number,  # In booking currency
    currency: string,        # Original currency code
    exchange_rate: number
  }

ESCALATE:
  triggers:
    - WHEN: reservation.total > 5000
      REASON: "High-value booking (${reservation.total} USD) requires human approval"
      PRIORITY: low
```

The ABL author compares against a single known currency. No language change needed — this is a tool design pattern.

**Status:** Spec example updated.

---

## 6. Human Handed-Back Continuation

> _"Is it the case that the human instructions are like an additional script added and then implicit when done we have COMPLETE: true?"_

No implicit COMPLETE. The full lifecycle:

```
ESCALATE:
  on_human_complete:
    # Human resolved it — explicit completion
    - IF human.resolved == true:
        STORE: {resolution_type, resolution_details} -> user.support_history
        RESPOND: "Thanks for your patience! {human.resolution_summary}"
        COMPLETE: true

    # Human sends instructions and hands back to the agent
    - IF human.handed_back == true:
        CONTINUE: with human.instructions
        CONTEXT: human.additional_context
        # Agent resumes normal flow.
        # human.instructions injected into LLM system prompt.
        # Agent continues until its OWN COMPLETE conditions fire.
        # NO implicit COMPLETE.

    # Human escalated further — explicit completion
    - IF human.escalated_further == true:
        RESPOND: "Escalated to specialists. Reference: {case_id}"
        COMPLETE: true
```

**Status:** Spec clarified.

---

## 7. COMPLETE — Two Different Uses

> _"COMPLETE: true seems like a subroutine call... COMPLETE: later seems like a subroutine definition."_

There are two forms:

```
# FORM 1: COMPLETE section — defines EXIT CONDITIONS (evaluated continuously)
COMPLETE:
  - WHEN: reservation.confirmed == true
    RESPOND: "Your reservation is confirmed! Confirmation #: {reservation.confirmation_number}"
    STORE: {hotel, dates, price} -> user.past_bookings

  - WHEN: user.intent == "cancel"
    RESPOND: "No problem! Come back anytime."


# FORM 2: COMPLETE: true — IMMEDIATE EXIT from within a handler
ESCALATE:
  on_human_complete:
    - IF human.resolved == true:
        RESPOND: "Issue resolved! {human.resolution_summary}"
        COMPLETE: true    # Stop the agent RIGHT NOW
```

- `COMPLETE:` section = exit postconditions on the agent
- `COMPLETE: true` = immediate `return` statement

The RESPOND in each is NOT redundant. `COMPLETE: true` fires immediately and skips the COMPLETE section entirely.

**Status:** Spec clarified.

---

## 8. CORRECTIONS in Scripted Mode

> _"For SCRIPTED mode, why would you disallow CORRECTIONS?"_

CORRECTIONS is not disallowed. It works in scripted GATHER steps:

```
FLOW:
  collect_details:
    GATHER:
      - destination: required
      - checkin: { TYPE: date, REQUIRED: true }
      - checkout: { TYPE: date, REQUIRED: true }
      - guests: { TYPE: number, DEFAULT: 2 }
      STRATEGY: hybrid
    CORRECTIONS: true
    COMPLETE_WHEN: destination AND checkin AND checkout
    THEN: search
```

Runtime pipeline: regex-based detection first (`detectCorrection()`), LLM fallback (`detectCorrectionWithLLM()`), then dependent field invalidation via BFS walk on the `depends_on` graph, with trace events and user acknowledgement.

**Status:** Fully implemented — parser, compiler, and runtime.

---

## 9. Hybrid Extraction Syntax

> _"How does something using hybrid extraction work, what is the syntax?"_

```
GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
  checkin:
    prompt: "Check-in date?"
    type: date
    required: true
  phone:
    prompt: "Your phone number?"
    type: phone
    required: true
  STRATEGY: hybrid
```

| Strategy  | How It Extracts                                    | Best For                                   |
| --------- | -------------------------------------------------- | ------------------------------------------ |
| `llm`     | LLM reads conversation, fills fields via reasoning | Complex natural language, ambiguous inputs |
| `pattern` | Regex/pattern matching                             | Structured formats (dates, phones, emails) |
| `hybrid`  | Pattern first, LLM fallback for failures           | Mix of structured and natural language     |

Per-field override is also supported:

```
GATHER:
  destination:
    type: string
    extraction_strategy: llm           # LLM only for this field
  confirmation_code:
    type: string
    extraction_strategy: pattern       # Pure regex for this field
    extraction_hints:
      - "Format: ABC-12345"
  STRATEGY: hybrid                     # Default for fields without override
```

**Status:** Implemented.

---

## 10. global_digressions — System Keyword or User-Defined?

> _"Is global_digressions a system keyword? Should it be in upper-case?"_

It IS a system keyword. Renamed to `GLOBAL_DIGRESSIONS`:

```
FLOW:
  GLOBAL_DIGRESSIONS:                  # System keyword, uppercase
    - INTENT: "cancel"
      RESPOND: "Canceling your request."
      GOTO: cancelled
    - INTENT: "speak_to_agent"
      DELEGATE: Human_Support

  collect_info:                        # User-defined step name, lowercase
    GATHER: destination, checkin, checkout
    THEN: search
```

Convention:

| Casing               | Meaning            | Examples                                                  |
| -------------------- | ------------------ | --------------------------------------------------------- |
| UPPER_CASE           | System keywords    | `FLOW`, `GATHER`, `RESPOND`, `THEN`, `GLOBAL_DIGRESSIONS` |
| lowercase/snake_case | User-defined names | `collect_info`, `destination`, `selected_hotel`           |
| PascalCase           | Agent names        | `Hotel_Search`, `Payment_Agent`                           |

**Status:** Renamed. Old lowercase form accepted with deprecation warning.

---

## 11. Regex Match — Where Does `extracted_room_id` Come From?

> _"How do we know the regex match data is sitting in a variable extracted_room_id?"_

This was a spec error. `extracted_room_id` was a phantom variable. The correct syntax uses named capture groups:

```
FLOW:
  select_room:
    RESPOND: "Select a room type (e.g., 'room 3')."
    ON_INPUT:
      - IF: input matches /room\s*(?<room_id>\d+)/
        SET: selected_room = match.room_id
        THEN: confirm
      - ELSE:
        RESPOND: "Please specify a room number, like 'room 3'."
        THEN: select_room
```

`match.room_id` resolves to the named capture group value.

**Status:** Spec fixed. Runtime `match.group_name` — see [Open Items](#open-items).

---

## 12. SORT_BY Naming

> _"Why be so sparing of characters. You could use ASCEND and DESCEND."_

Both forms now accepted:

```
TRANSFORM: transactions AS txn INTO sorted
  SORT_BY: date DESC                   # Short form (SQL standard)

TRANSFORM: transactions AS txn INTO sorted
  SORT_BY: date DESCENDING             # Long form (accepted alias)
```

**Status:** Both forms accepted.

---

## 13. MASK Function Semantics

> _"Is last4 predefined? Would MASK(s, pattern, start, end) be easier?"_

Both named patterns and positional API are supported:

**Named patterns:**

| Pattern    | Behavior              | Example            |
| ---------- | --------------------- | ------------------ |
| `"last4"`  | Show last 4           | `****4444`         |
| `"first4"` | Show first 4          | `4111****`         |
| `"bin4"`   | Show first 6 + last 4 | `411122**4444`     |
| `"email"`  | Mask local part       | `j***@example.com` |
| `"full"`   | Mask everything       | `****`             |

**Positional API:**

```
SET:
  # MASK(string, mask_char, visible_start, visible_end)
  # Negative indices count from end
  masked = MASK(card_number, "*", 0, -4)      # ************4444
  masked = MASK(card_number, "*", 6, -4)      # 411122******4444
```

**Status:** Spec updated with both forms.

---

## 14. COALESCE — Null vs Undefined

> _"Is null the same thing as undefined?"_

In ABL, `null` and `undefined` are treated as equivalent — both mean "no value." COALESCE returns the first argument that is neither:

```
SET:
  currency = COALESCE(selected_currency, user.default_currency, "USD")
  # selected_currency = undefined -> skip
  # user.default_currency = null  -> skip
  # "USD"                         -> return this
```

`0`, `""`, and `false` are valid values — COALESCE will return them.

**Status:** Spec clarified.

---

## 15. TOOLS — Where Is the Code?

> _"TOOLS lists function headers. Where are tools actually coded?"_

TOOLS in ABL are **declarations** (interfaces). Tool code lives outside the ABL file, bound at deployment:

```
# ABL file — declaration only:
TOOLS:
  search_hotels(destination: string, checkin: date, checkout: date) -> Hotel[]
  create_reservation(hotel_id: string, guest: GuestInfo) -> Reservation
```

Tool implementations are bound via:

| Binding            | Use Case                                      |
| ------------------ | --------------------------------------------- |
| HTTP API endpoint  | Most common — REST calls to external services |
| AWS Lambda         | Serverless function invocation                |
| MCP server         | Model Context Protocol tool servers           |
| JavaScript sandbox | Simple computed tools (date math, formatting) |

Same ABL agent deploys against different backends (dev/staging/prod). Tool implementations swap without changing ABL code.

**Status:** Spec documented.

---

## 16. SUPERVISOR Routing — Keyword Effectiveness

> _"Is this list just added to a prompt? Will it handle 'I'd like to overnite at the Hilton'?"_

Keywords are **semantic hints, not keyword matching.** They become part of the LLM's system prompt. The LLM uses language understanding:

| User Message                                          | LLM Reasoning                                 | Route  |
| ----------------------------------------------------- | --------------------------------------------- | ------ |
| "I'd like to overnite at the Hilton in San Francisco" | "overnite" = stay overnight, "Hilton" = hotel | hotel  |
| "I'd like to book a place in SF for Thursday"         | "book a place" = accommodation                | hotel  |
| "I need to get to New York by Tuesday"                | "get to [city]" = travel/transport            | flight |

The programmer doesn't need exhaustive synonyms. For higher accuracy, natural language descriptions can replace keyword lists:

```
ROUTING:
  - DESCRIPTION: "User wants to find, compare, or book hotels/lodging" -> hotel
  - DESCRIPTION: "User wants to search for or book flights" -> flight
```

**Status:** Working.

---

## 17. HANDOFF_PROTOCOL — Add Directionality

> _"You should add from flight to payment."_

Updated to require explicit `FROM ... TO ...`:

```
HANDOFF_PROTOCOL:
  - FROM hotel TO payment:
      CONTEXT: [reservation, user.loyalty_programs]
      TRIGGER: reservation.ready_for_payment
  - FROM flight TO payment:
      CONTEXT: [flight_booking, user.frequent_flyer]
      TRIGGER: flight_booking.ready_for_payment
  - FROM any TO support:
      CONTEXT: [conversation_history, active_agent, current_state]
      TRIGGER: user.requests_human OR user.sentiment == "frustrated"
```

**Status:** Spec updated.

---

## 18. DELEGATE Timing — Before or After Hotel Selection?

> _"When user asks about loyalty points, is this after hotel has been selected?"_

The `WHEN` clause controls timing precisely:

```
DELEGATE:
  # After hotel selection — does NOT bias search
  - AGENT: Loyalty_Lookup
    WHEN: booking.ready AND user.loyalty_programs IS SET
    PURPOSE: "Check rewards at the selected hotel's chain"
    INPUT: {user_id, hotel_chain: selected_hotel.chain}
    RETURNS: {points: number, rewards: Reward[]}
    USE_RESULT: "Offer to apply rewards"

  # Before search — biases results
  - AGENT: Loyalty_Lookup
    WHEN: user.loyalty_programs IS SET AND destination IS SET AND search_results IS NOT SET
    PURPOSE: "Get loyalty chains to prioritize in search"
    INPUT: {user_id}
    RETURNS: {preferred_chains: string[]}
    USE_RESULT: "Pass preferred_chains to search_hotels for ranking"
```

WHEN evaluation timing: after each user message, after tool returns, after delegated agents return — not on every variable change.

**Status:** Working.

---

## 19. Persistent Data and RECALL Injection

> _"Do you insert into LLM prompt all of this including average budget and past bookings?"_

No. RECALL instructions control WHEN and WHAT gets injected:

```
MEMORY:
  persistent:
    - user.preferred_chains
    - user.preferred_room_type
    - user.loyalty_programs
    - user.past_bookings
    - user.average_budget

  recall:
    - ON_START: "Check if user has preferred chains and room types"
    - ON_SEARCH: "Consider user's average budget when ranking results"
    - ON_RECOMMENDATION: "Prioritize hotels matching user's past preferences"
```

Each RECALL event triggers loading of specific persistent fields relevant to that moment. Large collections are summarized or filtered before injection.

**Status:** IR design complete. Runtime recall trigger invocation — see [Open Items](#open-items).

---

## 20. DELEGATE WHEN Evaluation and USE_RESULT

> _"Is this WHEN clause run on every variable change? What does USE_RESULT do? No tool is listed to apply the rewards."_

**WHEN:** Evaluated at checkpoints (after user message, tool return, delegate return, GATHER completion) — not on every variable change.

**USE_RESULT:** An LLM instruction injected into the system prompt so the LLM knows what to do with the returned data. Not runnable code.

**Missing tool:** The spec example was incomplete. If the user agrees to apply rewards, the agent needs:

```
TOOLS:
  search_hotels(...) -> Hotel[]
  create_reservation(...) -> Reservation
  apply_rewards(reward_id: string, reservation_id: string) -> { discount: number, new_total: number }
```

**Status:** Spec example updated with missing tool.

---

## Spec Changes Completed

| #   | Change                                                                  |
| --- | ----------------------------------------------------------------------- |
| 1   | Remove duplicate `==` from EBNF                                         |
| 2   | Add parenthetical condition examples                                    |
| 3   | Rename `RETURN` to `EXPECT_RETURN` on HANDOFF                           |
| 4   | Rename `global_digressions` to `GLOBAL_DIGRESSIONS`                     |
| 5   | Fix `extracted_room_id` to `match.group_name`                           |
| 6   | Accept `ASCENDING`/`DESCENDING` aliases for SORT_BY                     |
| 7   | Document both MASK forms (named + positional)                           |
| 8   | Clarify COALESCE: null == undefined in ABL                              |
| 9   | Document tool binding types (HTTP, Lambda, MCP, sandbox)                |
| 10  | Require `FROM...TO` in HANDOFF_PROTOCOL                                 |
| 11  | Add currency normalization pattern to ESCALATE examples                 |
| 12  | Document COMPLETE section vs COMPLETE: true distinction                 |
| 13  | Document constraint phase lifecycle (authoring convention, auto-guards) |
| 14  | Add missing `apply_rewards` tool to spec example                        |

---

## Implementation Completed

| #   | Feature                                | What Was Built                                                                                                                       |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ON_FAIL control flow                   | `ConstraintOnFailBlock` with `collect`, `goto`, `retry`, `then`. Supports `collect_field`, `goto_step`, `retry_step`.                |
| 2   | Entity type expansion (25+ Kore types) | `GatherFieldSemantics` with `format`, `components`, `unit`, `lookup`, `convertTo`, `locale`, `koreEntityType`. Full Kore entity map. |
| 3   | REMEMBER/RECALL IR design              | `RememberTrigger`, `RecallAction` (inject_context, load_memory, prompt_llm), `RecallInstruction` in types + IR.                      |
| 4   | RANGE attribute on GATHER              | `range?: boolean` on GatherField. `RangeValue<T>` with `low?`, `high?` bounds.                                                       |
| 5   | LIST/preference modeling               | `list?: boolean` + `preferences?: boolean`. `PreferenceValue<T>` with accept/desire/avoid/refuse.                                    |
| 6   | PROMPT dual role                       | `promptMode: 'ask' / 'extract_only'`. Auto-set to `extract_only` when `default` is present.                                          |
| 7   | Phase-aware constraints                | `ConstraintPhase` preserves phase name. Auto-guard mechanism provides implicit activation timing.                                    |
| 8   | Progressive GATHER + WHEN              | `GatherActivation` with modes: `required`, `optional`, `progressive`, `{ when: string }`. `dependsOn` for field chains.              |
| 9   | CORRECTIONS runtime                    | Full pipeline: regex detection, LLM fallback, dependent field invalidation via BFS walk, trace events, acknowledgement.              |
| 10  | Persistent memory metadata             | `PersistentMemory` with `type`, `unit`, `default_value`, and `access: 'read' / 'write' / 'readwrite'`.                               |
| 11  | EXPECT_RETURN on HANDOFF               | `return: boolean` + `on_return` on `HandoffConfig`.                                                                                  |
| 12  | All comparison operators               | `==`, `!=`, `>`, `>=`, `<`, `<=` with type coercion.                                                                                 |
| 13  | Parenthetical AND/OR                   | Full nesting: `(A AND B) OR C`. Correct operator precedence.                                                                         |
| 14  | STRATEGY field on GATHER               | `llm`, `pattern`, `hybrid` on top-level and flow GATHER. Per-field override.                                                         |
| 15  | DELEGATE semantics                     | Synchronous sub-agent call, returns result, parent continues.                                                                        |
| 16  | HANDOFF with EXPECT_RETURN             | Thread stack for temporary handoffs, thread completion for permanent.                                                                |
| 17  | Context SUMMARY on handoff             | Interpolated and passed before handoff is performed.                                                                                 |
| 18  | Error handler schema                   | `ErrorHandler` with types: `tool_timeout`, `tool_failure`, `validation_error`, `network_error`.                                      |
| 19  | Validation types                       | `pattern` (regex), `range`, `enum`, `custom` (LLM).                                                                                  |

---

## Open Items

| #   | Item                                | Impact                                                                                                                                                      | What Exists                                                                             | What's Remaining                                                                                              |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **HANDOFF TIMEOUT/ON_TIMEOUT**      | Without timeout, `EXPECT_RETURN: true` handoffs wait indefinitely if the target agent never returns. Delegates already have timeout enforcement.            | EXPECT_RETURN semantics working. Delegates use `Promise.race` + timer pattern.          | Add `timeout` and `on_timeout` fields to HandoffConfig across parser, compiler, IR, and runtime.              |
| 2   | **match.group_name regex captures** | ON_INPUT regex conditions work for boolean matching but cannot extract values. Spec shows `SET: selected_room = match.room_id` syntax that doesn't run yet. | `MATCHES` operator recognized by parser. Evaluator uses `regex.test()` (boolean only).  | Change evaluator to use `regex` with capture groups, store groups in context, wire through to SET resolution. |
| 3   | **RECALL runtime triggers**         | RECALL instructions are designed in the IR but don't fire at runtime. Memory injection is manual, not event-driven.                                         | Full IR design: triggers, recall instructions, persistent memory with type/unit/access. | Wire trigger evaluation at runtime checkpoints. Inject recalled fields into LLM prompts.                      |
| 4   | **Data-driven dynamic GATHER**      | Fields that appear based on runtime data (e.g., show loyalty_number field only if hotel has loyalty program).                                               | `GatherActivation` with `{ when: string }` covers conditional activation.               | Fully dynamic fields from runtime data. Reasoning mode handles this naturally for most cases.                 |
