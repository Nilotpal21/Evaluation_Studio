# ABL Spec Review (Part 2) — Point-by-Point Response with Examples

This document addresses each question/concern from Bruce's second ABL spec review (`ABL_SPEC_2.doc`), with concrete ABL examples and clarifications.

---

## 1. Condition Comparator Redundancy

**Bruce's concern:** The condition syntax lists `comparator` (presumably `>`, `<`, `>=`, `<=`, `==`) but then also lists `==` separately, which seems redundant.

**Answer:** Bruce is correct — the EBNF grammar in the spec is redundant. The condition syntax should be:

```ebnf
condition = expression comparator expression
          | "NOT" condition
          | condition "AND" condition
          | condition "OR" condition

comparator = "==" | "!=" | ">" | ">=" | "<" | "<="
```

The separate `tool_result "." field "==" value` line was an artifact of an earlier draft that only supported equality checks. It should be removed.

**Working example (all operators):**

```dsl
CONSTRAINTS:
  pre_booking:
    # Equality
    - REQUIRE check_availability.status == "available"
      ON_FAIL: "Room is not available."

    # Inequality
    - REQUIRE selected_hotel.rating != 0
      ON_FAIL: "Hotel has no rating data."

    # Greater than
    - REQUIRE selected_hotel.rooms_available > 0
      ON_FAIL: "No rooms left."

    # Greater than or equal
    - REQUIRE user.age >= 18
      ON_FAIL: "You must be 18 or older to make a reservation."

    # Less than
    - REQUIRE booking.total < 10000
      ON_FAIL: "Bookings over $10,000 require manager approval."

    # Less than or equal
    - REQUIRE guests <= selected_room.max_occupancy
      ON_FAIL: "This room has a maximum occupancy of {selected_room.max_occupancy}."
```

---

## 2. AND/OR Condition Grouping (Parentheses)

**Bruce's concern:** There are AND and OR operators, but no way to prioritize `(x AND y) OR z`.

**Answer:** Parenthetical grouping IS supported in our expression evaluator, but the spec failed to show examples. The parser handles full nesting.

**Working example:**

```dsl
CONSTRAINTS:
  pre_search:
    # Grouped conditions — parens control evaluation order
    - REQUIRE (destination IS SET AND checkin IS SET) OR override_search == true
      ON_FAIL: "Please provide a destination and check-in date, or enable override."

    # Complex nesting
    - REQUIRE (user.loyalty_tier == "Gold" OR user.loyalty_tier == "Platinum") AND booking.total > 1000
      ON_FAIL: "This discount requires Gold or Platinum loyalty status on bookings over $1,000."

    # Three-way grouping
    - REQUIRE (room_type == "suite" AND guests <= 4) OR (room_type == "standard" AND guests <= 2) OR (room_type == "family" AND guests <= 6)
      ON_FAIL: "Guest count exceeds the maximum for the selected room type."
```

**Precedence (without parens):** `NOT` binds tightest, then `AND`, then `OR`. So `A OR B AND C` means `A OR (B AND C)`. Use parens to override.

---

## 3. Pre-Search Constraints — Timing and User Reply Handling

**Bruce's concern (two parts):**

1. If the user replies YES to "Would you like to extend your stay?", how does the agent know what to do? Does the stay duration get nulled out?
2. What does `pre_search` mean — if we haven't searched yet, how do we know about minimum stay?

### Part A: What happens after ON_FAIL response

**Answer:** The ON_FAIL message is sent to the user, and the conversation continues. The agent (in reasoning mode) will interpret the user's YES/NO reply using LLM reasoning. In scripted mode, you'd need an explicit ON_INPUT branch. Here's how both modes handle it:

**Reasoning mode (implicit):**

```dsl
AGENT: Hotel_Search

CONSTRAINTS:
  pre_search:
    - REQUIRE validate_minimum_stay.valid == true
      ON_FAIL: |
        {destination} requires a minimum stay of {validate_minimum_stay.minimum} nights.
        Your current booking is only {calculated_nights} nights.
        Would you like to extend your stay?

# In reasoning mode, the LLM sees the ON_FAIL message was sent,
# sees the user's "yes" reply, and decides to:
# 1. Keep the destination
# 2. Ask "How many nights would you like instead?"
# 3. Re-gather checkout date
# 4. Re-evaluate the constraint
#
# The gathered values (checkin, checkout) are NOT automatically nulled.
# The LLM decides which fields to re-collect based on conversation context.
```

**Scripted mode (explicit control flow) — this is the NEW syntax Bruce's review prompted:**

```dsl
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
          You've selected {stayResult.nights}. Would you like to extend?
        THEN: handle_extend

  handle_extend:
    ON_INPUT:
      - IF: input == "yes" OR yes
        # Clear checkout so GATHER re-asks it
        CLEAR: checkout
        RESPOND: "What would you like your new check-out date to be?"
        THEN: recollect_checkout
      - IF: input == "no" OR no
        RESPOND: "No problem. Would you like to try a different destination?"
        CLEAR: destination, checkin, checkout
        THEN: collect_details
      - ELSE:
        RESPOND: "Please say yes or no."
        THEN: handle_extend

  recollect_checkout:
    GATHER:
      - checkout:
          TYPE: date
          REQUIRED: true
    THEN: validate_stay    # Re-run the constraint check
```

### Part B: What does `pre_search` mean?

**Answer:** `pre_search` is a phase label — it means "evaluate these constraints BEFORE calling `search_hotels()`." The constraints reference tool calls that happen before the search:

```
Timeline:
1. User says: "I want a hotel in Maui, Dec 24-26"
2. Agent gathers: destination=Maui, checkin=Dec 24, checkout=Dec 26
3. BEFORE searching, agent calls: check_blackout_dates("Maui", Dec 24, Dec 26)
4. check_blackout_dates returns: { allowed: false, reason: "Holiday blackout" }
5. pre_search constraint fires: "Those dates fall within a blackout period..."
6. Search never happens — constraint blocked it
```

The constraint tools (`check_blackout_dates`, `validate_minimum_stay`) are lightweight validation calls, not the actual hotel search. They check business rules (policies, date restrictions) using just the gathered inputs — no hotel database query needed.

---

## 4. HANDOFF — Permanent vs Transient

**Bruce's concern:** How do you know if a handoff is permanent or transient? If you wait for the 2nd agent to return and it doesn't, that's a problem.

**Answer:** The `RETURN` field (which we're renaming to `EXPECT_RETURN` based on Bruce's earlier feedback) explicitly controls this:

```dsl
HANDOFF:
  # Permanent handoff — Hotel_Search terminates, Payment_Agent owns the conversation
  - TO: Payment_Agent
    WHEN: reservation.ready_for_payment == true
    CONTEXT:
      pass: [reservation, selected_hotel, user.email]
      summary: "Booking {selected_hotel.name}, ${reservation.total}"
    EXPECT_RETURN: false
    # What happens: Hotel_Search's thread is marked "completed"
    # Payment_Agent takes full control
    # If Payment_Agent fails, it escalates — Hotel_Search is NOT resumed

  # Temporary handoff — Hotel_Search pauses, Flight_Search runs, then control returns
  - TO: Flight_Search
    WHEN: user.intent == "also_need_flight"
    CONTEXT:
      pass: [destination, checkin, checkout]
      summary: "User also needs flights to {destination}"
    EXPECT_RETURN: true
    TIMEOUT: 300    # 5 minutes — if Flight_Search hasn't returned, escalate
    ON_TIMEOUT: ESCALATE with REASON: "Flight search took too long"
    # What happens: Hotel_Search is pushed onto a stack and paused
    # Flight_Search runs to completion
    # Control returns to Hotel_Search with Flight_Search's result
```

**Key clarification for Bruce:**

- `EXPECT_RETURN: false` = "I'm done, the other agent takes over permanently"
- `EXPECT_RETURN: true` = "I'm pausing, the other agent should return to me"
- For `EXPECT_RETURN: true`, a `TIMEOUT` with `ON_TIMEOUT` handles the case where the target agent never returns

---

## 5. Currency in Escalation Triggers

**Bruce's concern:** `booking.total > 5000` — shouldn't currency be part of the number? A booking in Tokyo for 5000 yen is only ~$32.

**Answer:** Bruce is absolutely right. The spec example is naive. There are two proper ways to handle this:

**Option A: Normalize currency at the tool level (recommended)**

```dsl
TOOLS:
  # Tool returns amounts in a normalized currency
  create_reservation(hotel_id: string, room_type: string, dates: DateRange, guest: GuestInfo) -> {
    confirmation_number: string,
    total: number,           # Always in USD (normalized by the tool)
    original_total: number,  # In booking currency
    currency: string,        # Original currency code
    exchange_rate: number    # Rate used for conversion
  }

ESCALATE:
  triggers:
    # Now this comparison is always in USD
    - WHEN: reservation.total > 5000
      REASON: "High-value booking (${reservation.total} USD) requires human approval"
      PRIORITY: low
```

**Option B: Include currency in the condition**

```dsl
TOOLS:
  convert_to_usd(amount: number, currency: string) -> { usd_amount: number, rate: number }

ESCALATE:
  triggers:
    # Use a tool to convert before comparing
    - WHEN: convert_to_usd(booking.total, booking.currency).usd_amount > 5000
      REASON: "High-value booking ({booking.total} {booking.currency} = ${convert_to_usd.usd_amount} USD)"
      PRIORITY: low
```

**Option C: Currency-aware comparison (future spec enhancement)**

```dsl
ESCALATE:
  triggers:
    - WHEN: booking.total > 5000 USD    # Currency-aware literal
      REASON: "High-value booking requires human approval"
      PRIORITY: low
    # Runtime would auto-convert booking.total from its currency to USD for comparison
```

**Recommendation:** Option A is the cleanest — normalize at the data layer, not in the DSL. The spec example should be updated to show this pattern.

---

## 6. Human Handed-Back Continuation

**Bruce's concern:** When `human.handed_back == true`, the agent continues with `human.instructions`. Are the human instructions like an additional script? When done, is there an implicit `COMPLETE: true`?

**Answer:** No implicit COMPLETE. Here's the full lifecycle:

```dsl
ESCALATE:
  on_human_complete:
    # Case 1: Human resolved it entirely
    - IF human.resolved == true:
        STORE: {resolution_type, resolution_details} -> user.support_history
        RESPOND: "Thanks for your patience! {human.resolution_summary}"
        COMPLETE: true    # <-- Explicit completion

    # Case 2: Human gives instructions and hands back to the agent
    - IF human.handed_back == true:
        CONTINUE: with human.instructions
        CONTEXT: human.additional_context
        # What "CONTINUE" means:
        #   1. The agent resumes its normal execution
        #   2. human.instructions are injected into the LLM system prompt
        #      e.g., "Override the blackout restriction for this customer"
        #   3. human.additional_context is added to conversation context
        #      e.g., "Manager approved exception, ref #MGR-1234"
        #   4. The agent continues its goal-driven behavior
        #   5. The agent will eventually hit a COMPLETE condition naturally
        #      (e.g., booking confirmed, user cancels, etc.)
        #   NO implicit COMPLETE — the agent keeps running until its own
        #   COMPLETE conditions are met

    # Case 3: Human escalated further
    - IF human.escalated_further == true:
        RESPOND: "Your case has been escalated to our specialist team. Reference: {case_id}"
        COMPLETE: true    # <-- Explicit completion
```

**Concrete example of human.instructions flow:**

```
1. Agent can't book due to blackout constraint
2. Agent escalates to human
3. Human reviews, approves override, sends back:
   instructions: "Allow booking despite blackout. Apply 10% discount as courtesy."
   additional_context: "Manager approval ref MGR-1234"
4. Agent resumes with these instructions in its system prompt
5. Agent re-runs search (now ignoring blackout per human override)
6. Agent finds hotels, user selects one
7. Agent applies 10% discount
8. Agent hands off to Payment_Agent → COMPLETE fires
```

---

## 7. COMPLETE — Two Different Uses (Redundancy)

**Bruce's concern:** In post-human actions there's `COMPLETE: true`, and separately `COMPLETE:` has `WHEN/RESPOND/STORE`. One seems like a subroutine call, the other like a definition. Which is which?

**Answer:** Bruce has identified genuine syntactic overloading. Here's the distinction:

```dsl
# ─── FORM 1: COMPLETE section (top-level declaration) ───
# This DEFINES the completion conditions for the agent.
# These are evaluated continuously by the runtime.
COMPLETE:
  - WHEN: reservation.confirmed == true
    RESPOND: |
      Your reservation is confirmed!
      Confirmation #: {reservation.confirmation_number}
    STORE: {hotel, dates, price} -> user.past_bookings

  - WHEN: user.intent == "cancel"
    RESPOND: "No problem! Come back anytime."


# ─── FORM 2: COMPLETE: true (inline directive) ───
# This TRIGGERS immediate completion from within a specific handler.
# It's a shorthand that says "we're done right now."
ESCALATE:
  on_human_complete:
    - IF human.resolved == true:
        RESPOND: "Issue resolved! {human.resolution_summary}"
        COMPLETE: true   # ← "Stop the agent NOW. We're done."

    - IF human.escalated_further == true:
        RESPOND: "Escalated to specialists. Ref: {case_id}"
        COMPLETE: true   # ← "Stop the agent NOW."
```

**Analogy for Bruce:**

- `COMPLETE:` section = a set of exit conditions (like return conditions in a function)
- `COMPLETE: true` inline = an immediate return statement (like `return;` in the middle of a function)

The `RESPOND` in `COMPLETE: true` blocks is NOT redundant with the `COMPLETE:` section's `RESPOND`. They serve different purposes:

| Usage                   | When it fires                                              | RESPOND                                                  |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `COMPLETE:` section     | When a WHEN condition becomes true during normal execution | Defined in the COMPLETE block                            |
| `COMPLETE: true` inline | Immediately, when reached in an IF/THEN handler            | Defined in the handler, BEFORE the `COMPLETE: true` line |

If `COMPLETE: true` is reached, the `COMPLETE:` section's `WHEN` conditions are NOT evaluated — it's an immediate exit.

---

## 8. Scripted Mode — Why Disallow CORRECTIONS?

**Bruce's concern:** For SCRIPTED mode, why would you disallow CORRECTIONS?

**Answer:** Actually, we DON'T disallow them. CORRECTIONS is available in scripted GATHER steps:

```dsl
FLOW:
  collect_details:
    PRESENT: "Let me get your booking details."
    GATHER:
      - destination: required
      - checkin:
          TYPE: date
          REQUIRED: true
      - checkout:
          TYPE: date
          REQUIRED: true
      - guests:
          TYPE: number
          DEFAULT: 2
      STRATEGY: hybrid
    CORRECTIONS: true         # ← Allowed in scripted mode
    COMPLETE_WHEN: destination AND checkin AND checkout
    THEN: search
```

**What CORRECTIONS: true does in practice:**

```
Agent: "Please provide destination, dates, and number of guests."
User: "Paris, June 10-15, 3 guests"
Agent extracts: destination=Paris, checkin=June 10, checkout=June 15, guests=3
Agent: "Got it! Paris, June 10-15, 3 guests. Shall I search?"
User: "Actually, make it 4 guests"          ← CORRECTION
Agent updates: guests=4 (re-extracts from context)
Agent: "Updated to 4 guests. Shall I search?"
```

**Without CORRECTIONS: true**, the agent would not re-evaluate the "actually 4 guests" message against already-collected fields — it would treat it as a new input for the next step.

**Note:** CORRECTIONS is parsed by the compiler but the runtime doesn't execute the re-extraction logic yet. This is a known implementation gap.

---

## 9. Hybrid Extraction — What's the Syntax?

**Bruce's concern:** How does hybrid extraction work? What is the syntax?

**Answer:** The `STRATEGY` field controls extraction method:

```dsl
GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
    # No strategy override — uses parent strategy

  checkin:
    prompt: "Check-in date?"
    type: date
    required: true

  phone:
    prompt: "Your phone number?"
    type: phone
    required: true

  STRATEGY: hybrid    # ← Applies to all fields in this GATHER block
```

**The three strategies:**

| Strategy  | How it extracts                                      | Best for                                   |
| --------- | ---------------------------------------------------- | ------------------------------------------ |
| `llm`     | LLM reads conversation, fills fields using reasoning | Complex natural language, ambiguous inputs |
| `pattern` | Regex/pattern matching (dates, phones, emails)       | Structured formats with known patterns     |
| `hybrid`  | Try pattern first; fall back to LLM for failures     | Mix of structured and natural language     |

**Hybrid in action:**

```
User: "I want to visit Paris from June 10th to the 15th, call me at 555-0123"

STRATEGY: hybrid processing:
1. destination "Paris"
   → Pattern match: no date/phone pattern → falls through
   → LLM extraction: "Paris" → destination ✓

2. checkin "June 10th"
   → Pattern match: date pattern found → June 10 ✓

3. checkout "the 15th"
   → Pattern match: relative date → needs context
   → LLM extraction: "the 15th" in context of June → June 15 ✓

4. phone "555-0123"
   → Pattern match: phone pattern found → 555-0123 ✓
```

**Per-field strategy override:**

```dsl
GATHER:
  destination:
    prompt: "Where would you like to stay?"
    type: string
    required: true
    extraction_strategy: llm         # ← Override for this field only

  confirmation_code:
    prompt: "What's your confirmation code?"
    type: string
    required: true
    extraction_strategy: pattern     # ← Pure pattern match
    extraction_hints:
      - "Format: ABC-12345"
      - "Alphanumeric with hyphen"

  STRATEGY: hybrid    # ← Default for fields without override
```

---

## 10. global_digressions — System Keyword or User-Defined?

**Bruce's concern:** Is `global_digressions:` a system keyword or merely a user-defined thing? Should it be in UPPER-CASE if it's system-defined?

**Answer:** `global_digressions` IS a system keyword (reserved name in the FLOW section). Bruce is right that it should follow the UPPER-CASE convention for system keywords:

```dsl
FLOW:
  # ─── CORRECT (system keyword, uppercase) ───
  GLOBAL_DIGRESSIONS:
    - INTENT: "cancel"
      RESPOND: "Canceling your request."
      GOTO: cancelled
    - INTENT: "speak_to_agent"
      DELEGATE: Human_Support

  # ─── Step names are user-defined (lowercase) ───
  collect_info:
    GATHER: destination, checkin, checkout
    THEN: search

  search:
    CALL: search_hotels(destination, checkin, checkout)
    THEN: display_results

  cancelled:
    RESPOND: "Your request has been cancelled."
    THEN: COMPLETE
```

**Convention clarification for the spec:**

| Casing                 | Meaning                                       | Examples                                                                                  |
| ---------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| UPPER_CASE             | System keywords / DSL reserved words          | `FLOW`, `GATHER`, `RESPOND`, `THEN`, `CALL`, `GLOBAL_DIGRESSIONS`, `ON_INPUT`, `COMPLETE` |
| lowercase / snake_case | User-defined names (steps, variables, fields) | `collect_info`, `search`, `destination`, `selected_hotel`                                 |
| PascalCase             | Agent names, type names                       | `Hotel_Search`, `Payment_Agent`, `HotelDetails`                                           |

The spec has been updated to use `GLOBAL_DIGRESSIONS` (uppercase). The old `global_digressions` form is accepted by the parser for backward compatibility but emits a deprecation warning.

---

## 11. Regex Match — Where Does `extracted_room_id` Come From?

**Bruce's concern:** In the pattern `IF: input matches /room\s*\d+/` followed by `SET: selected_room = extracted_room_id`, how do we know the regex match data is in `extracted_room_id`?

**Answer:** Bruce found a genuine spec error. The variable `extracted_room_id` is not magically populated. Here's how it should actually work:

**Option A: Named capture groups (recommended)**

```dsl
FLOW:
  select_room:
    RESPOND: "Select a room type (e.g., 'room 3')."
    ON_INPUT:
      - IF: input matches /room\s*(?<room_id>\d+)/
        SET: selected_room = match.room_id       # ← Named capture group
        THEN: confirm
      - ELSE:
        RESPOND: "Please specify a room number, like 'room 3'."
        THEN: select_room
```

**Option B: Positional capture groups**

```dsl
    ON_INPUT:
      - IF: input matches /room\s*(\d+)/
        SET: selected_room = match.1              # ← First capture group
        THEN: confirm
```

**Option C: LLM extraction (no regex needed)**

```dsl
    ON_INPUT:
      - IF: input contains "room"
        SET: selected_room = EXTRACT_NUMBER(input)  # ← Built-in function
        THEN: confirm
```

**How `matches` works at runtime:**

```
User says: "I'll take room 7"

1. Pattern: /room\s*(?<room_id>\d+)/
2. Match result: { 0: "room 7", room_id: "7" }
3. `match.room_id` → "7"
4. SET: selected_room = "7"
```

The spec example was misleading — `extracted_room_id` was a phantom variable. The correct approach uses `match.<group_name>` to reference capture groups.

---

## 12. TRANSFORM SORT_BY — Brevity Concern

**Bruce's concern:** `SORT_BY: date DESC` — why be so sparing? Use `ASCEND`/`DESCEND` to be clearer while still frugal.

**Answer:** Fair point on readability. However, `ASC`/`DESC` is an industry-standard convention (SQL, MongoDB, most query languages). We'll accept both forms:

```dsl
TRANSFORM: transactions AS txn INTO sorted_transactions
  SORT_BY: date DESC              # ← Short form (SQL-standard, currently supported)

TRANSFORM: transactions AS txn INTO sorted_transactions
  SORT_BY: date DESCENDING        # ← Long form (accepted alias)

TRANSFORM: transactions AS txn INTO sorted_transactions
  SORT_BY: date ASCENDING         # ← Long form (accepted alias)
```

**Full TRANSFORM example for clarity:**

```dsl
FLOW:
  apply_filters:
    TRANSFORM: txnResult.transactions AS txn INTO filtered_transactions
      FILTER: filter_type == "all" OR txn.type == filter_type
      MAP:
        id: txn.id
        date: FORMAT_DATE(txn.date, "MMM DD")
        description: COALESCE(txn.merchant, txn.description)
        display_amount: FORMAT_CURRENCY(ABS(txn.amount), "USD")
        direction: UPPER(SUBSTRING(txn.type, 0, 1))
        category: UPPER(txn.category)
      SORT_BY: date DESCENDING        # ← Most recent first
      LIMIT: page_size
    THEN: display_transactions

  display_transactions:
    RESPOND: |
      Here are your transactions:
      {{#each filtered_transactions}}
      {{direction}} {{date}} - {{description}}: {{display_amount}} ({{category}})
      {{/each}}
```

---

## 13. MASK Function — Semantics and Flexibility

**Bruce's concern:** Is `last4` in `MASK(acct, "last4")` predefined or user-created? Would it be easier to use `MASK(s, pattern, start, end)` like SUBSTRING?

**Answer:** `"last4"` is a predefined pattern name. But Bruce's point about a more uniform positional API is valid. We support both:

**Named patterns (predefined convenience):**

```dsl
SET:
  # Show only last 4 digits
  masked_card = MASK(card_number, "last4")
  # Input:  "4111222233334444"
  # Output: "************4444"

  # Show only first 6 (BIN) and last 4
  masked_card_bin = MASK(card_number, "bin4")
  # Output: "411122******4444"

  # Mask email
  masked_email = MASK(user_email, "email")
  # Input:  "john.doe@example.com"
  # Output: "j*******@example.com"

  # Show first/last initial
  masked_name = MASK(user_name, "initials")
  # Input:  "John Doe"
  # Output: "J*** D**"
```

**Available named patterns:**

| Pattern      | Behavior                          | Example            |
| ------------ | --------------------------------- | ------------------ |
| `"last4"`    | Show last 4 chars                 | `****4444`         |
| `"first4"`   | Show first 4 chars                | `4111****`         |
| `"bin4"`     | Show first 6 + last 4             | `411122**4444`     |
| `"email"`    | Mask local part except first char | `j***@example.com` |
| `"initials"` | Keep first letter of each word    | `J*** D**`         |
| `"full"`     | Mask everything                   | `****************` |

**Positional API (Bruce's suggestion — also supported):**

```dsl
SET:
  # MASK(string, mask_char, visible_start, visible_end)
  # visible_start/end: positive = from start, negative = from end

  # Show last 4 (equivalent to "last4")
  masked = MASK(card_number, "*", 0, -4)
  # Masks positions 0 through length-4, shows last 4
  # "4111222233334444" → "************4444"

  # Show first 6 and last 4
  masked = MASK(card_number, "*", 6, -4)
  # Shows 0-5 and last 4, masks the middle
  # "4111222233334444" → "411122******4444"

  # Mask only the middle
  masked = MASK(ssn, "X", 3, -4)
  # "123456789" → "123XX6789"
```

---

## 14. COALESCE — Null vs Undefined

**Bruce's concern:** Is null the same as undefined? Why does COALESCE return "non-null/undefined"?

**Answer:** In ABL's runtime, `null` and `undefined` are treated as equivalent for most operations. COALESCE returns the first value that is neither null nor undefined.

```dsl
SET:
  # If user hasn't set a currency, use their profile default, else "USD"
  currency = COALESCE(selected_currency, user.default_currency, "USD")

  # COALESCE evaluation:
  # selected_currency = undefined (not set yet)  → skip
  # user.default_currency = null (no profile)    → skip
  # "USD" = "USD" (string literal)               → return this

  # Result: currency = "USD"
```

**More examples:**

```dsl
SET:
  # First non-empty name
  display_name = COALESCE(user.nickname, user.first_name, "Guest")

  # First available contact method
  contact = COALESCE(user.email, user.phone, user.social_handle)

  # Zero IS a valid value (not null/undefined)
  balance = COALESCE(account.balance, 0)
  # If account.balance is 0, COALESCE returns 0 (it's not null)
  # If account.balance is null, COALESCE returns 0 (the fallback)
```

**Key rule:** `null == undefined` in ABL. Both mean "no value." The number `0`, empty string `""`, and boolean `false` are NOT null — they are valid values.

---

## 15. TOOLS — Where Is the Code?

**Bruce's concern:** TOOLS lists function headers. Where are tools actually coded?

**Answer:** TOOLS in ABL are declarations (interfaces), not implementations. The actual code lives outside the DSL, connected via tool bindings at deployment time.

```dsl
# ─── In the ABL file: declaration only ───
TOOLS:
  search_hotels(destination: string, checkin: date, checkout: date, guests: number = 2) -> Hotel[]
  create_reservation(hotel_id: string, guest: GuestInfo) -> Reservation
```

```
# ─── Tool implementations live in one of these places: ───

┌─────────────────────────────────────────────────────────────┐
│ 1. HTTP API endpoint (most common)                          │
│    Configured in deployment:                                │
│    tools:                                                   │
│      search_hotels:                                         │
│        type: http                                           │
│        url: https://api.hotels.com/v2/search                │
│        method: POST                                         │
│        auth: { type: bearer, secret: HOTEL_API_KEY }        │
│        timeout: 10000                                       │
├─────────────────────────────────────────────────────────────┤
│ 2. AWS Lambda function                                      │
│    tools:                                                   │
│      create_reservation:                                    │
│        type: lambda                                         │
│        function: arn:aws:lambda:us-east-1:123:hotel-booking  │
│        timeout: 30000                                       │
├─────────────────────────────────────────────────────────────┤
│ 3. MCP server (Model Context Protocol)                      │
│    tools:                                                   │
│      search_hotels:                                         │
│        type: mcp                                            │
│        server: hotel-tools                                  │
│        tool_name: search                                    │
├─────────────────────────────────────────────────────────────┤
│ 4. JavaScript sandbox (for simple computed tools)           │
│    tools:                                                   │
│      calculate_nights:                                      │
│        type: sandbox                                        │
│        code: |                                              │
│          const diff = new Date(checkout) - new Date(checkin)│
│          return { nights: Math.ceil(diff / 86400000) }      │
└─────────────────────────────────────────────────────────────┘
```

**Why this separation matters:**

- The ABL author defines WHAT tools exist and their signatures
- The platform admin/deployer defines WHERE tools run and HOW they're authenticated
- The same ABL agent can be deployed against different tool backends (dev/staging/prod)
- Tool implementations can be swapped without changing the agent's ABL code

---

## 16. SUPERVISOR Routing — Keyword Matching Effectiveness

**Bruce's concern:** Is the routing keyword list just added to an LLM prompt? Will it handle "I'd like to overnite at the Hilton" or "book a place in SF for Thursday"?

**Answer:** Yes, the routing keywords become part of the LLM's system prompt, but they're hints — not rigid keyword matching. The LLM uses semantic understanding.

```dsl
SUPERVISOR: Travel_Assistant

ROUTING:
  - INTENT(hotel, stay, room, accommodation) -> hotel
  - INTENT(flight, fly, plane, airline) -> flight
  - INTENT(pay, checkout, purchase) -> payment
  - DEFAULT -> hotel
```

**How this compiles and executes:**

```
System prompt (generated by compiler):
"You are a routing supervisor. Route user messages to the appropriate agent.

Available agents:
- hotel: Handles hotel-related requests. Keywords: hotel, stay, room, accommodation
- flight: Handles flight-related requests. Keywords: flight, fly, plane, airline
- payment: Handles payment-related requests. Keywords: pay, checkout, purchase

If no clear match, route to: hotel

You MUST respond by calling the 'route_to_agent' tool with the selected agent."
```

**Bruce's test cases — how they'd be routed:**

```
User: "I'd like to overnite at the Hilton in San Francisco on June 16."
LLM reasoning: "overnite" → stay overnight → hotel intent.
              "Hilton" → hotel name. Clearly hotel-related.
Route: → hotel ✓

User: "I'd like to book a place in SF for Thursday."
LLM reasoning: "book a place" → accommodation. "SF" → location.
              No flight/payment signals.
Route: → hotel ✓

User: "I need to get to New York by Tuesday."
LLM reasoning: "get to" could be travel. No hotel signals.
              "get to [city] by [date]" → transportation → flight.
Route: → flight ✓

User: "I want to finalize my reservation."
LLM reasoning: "finalize" → could be payment or confirmation.
              No clear hotel/flight signal. Closest is "checkout/purchase."
Route: → payment (or hotel via DEFAULT, depending on context)
```

**The keywords are NOT regex/keyword-matching.** The LLM uses them as semantic hints combined with its own language understanding. The programmer doesn't need exhaustive synonyms — the LLM handles that. However, providing good representative keywords helps the LLM route edge cases correctly.

**For higher accuracy, use natural language routing:**

```dsl
ROUTING:
  - DESCRIPTION: "User wants to find, compare, or book hotels/lodging" -> hotel
  - DESCRIPTION: "User wants to search for or book flights" -> flight
  - DESCRIPTION: "User wants to pay for or finalize a booking" -> payment
  - DEFAULT -> hotel
```

---

## 17. HANDOFF_PROTOCOL — Add Directionality

**Bruce's concern:** `HANDOFF_PROTOCOL` should clarify direction — e.g., "from flight to payment."

**Answer:** Agreed. The spec now requires explicit `FROM ... TO ...`:

```dsl
SUPERVISOR: Travel_Assistant

HANDOFF_PROTOCOL:
  # Explicit direction: FROM source_agent TO target_agent
  - FROM hotel TO payment:
      CONTEXT: [reservation, user.loyalty_programs]
      TRIGGER: reservation.ready_for_payment

  - FROM flight TO payment:
      CONTEXT: [flight_booking, user.frequent_flyer]
      TRIGGER: flight_booking.ready_for_payment

  - FROM hotel TO flight:
      CONTEXT: [destination, checkin, checkout]
      TRIGGER: user.also_needs_flight

  # Wildcard source — any agent can hand off to support
  - FROM any TO support:
      CONTEXT: [conversation_history, active_agent, current_state]
      TRIGGER: user.requests_human OR user.sentiment == "frustrated"
```

---

## 18. DELEGATE Timing — Before or After Hotel Selection?

**Bruce's concern (Section 5.2):** When the user asks about loyalty points, is this executed AFTER the hotel is selected? Otherwise we might not choose a hotel with that loyalty. Or if asked before search, will this bias the search?

**Answer:** The `WHEN` clause controls timing precisely:

```dsl
DELEGATE:
  # Case 1: Loyalty lookup AFTER hotel selection (the spec example)
  - AGENT: Loyalty_Lookup
    WHEN: booking.ready AND user.loyalty_programs IS SET
    PURPOSE: "Check for applicable rewards at the selected hotel"
    INPUT: {user_id, hotel_chain: selected_hotel.chain}
    RETURNS: {points: number, rewards: Reward[]}
    USE_RESULT: "Offer to apply rewards"
    # This fires AFTER the user has selected a hotel (booking.ready).
    # It checks loyalty at THAT specific hotel's chain.
    # It does NOT bias the search — the search already happened.

  # Case 2: Loyalty lookup BEFORE search (to bias results)
  - AGENT: Loyalty_Lookup
    WHEN: user.loyalty_programs IS SET AND destination IS SET AND search_results IS NOT SET
    PURPOSE: "Get loyalty chains to prioritize in search"
    INPUT: {user_id}
    RETURNS: {preferred_chains: string[], tier_benefits: object}
    USE_RESULT: "Pass preferred_chains to search_hotels for ranking"
    # This fires BEFORE search (search_results IS NOT SET).
    # The result biases which hotels appear first.

  # Case 3: Loyalty lookup when user explicitly asks
  - AGENT: Loyalty_Lookup
    WHEN: user.mentions_loyalty
    PURPOSE: "Answer user's loyalty question"
    INPUT: {user_id, hotel_chain: selected_hotel.chain}
    RETURNS: {points: number, rewards: Reward[]}
    USE_RESULT: "Tell user their points balance and available rewards"
    # This fires whenever the user asks, regardless of booking state.
    # If no hotel is selected yet, hotel_chain would be null and the
    # Loyalty_Lookup agent should handle that gracefully.
```

**The spec example (`booking.ready AND user.loyalty_programs IS SET`) means:**

- `booking.ready` = the user has selected a hotel and confirmed details
- This is a POST-selection delegation
- It does NOT bias search — that would require a different WHEN condition

---

## 19. Persistent Data and RECALL — How Is It Injected?

**Bruce's concern:** We have persistent data (past bookings, average budget, etc.) and RECALL says to prioritize matching preferences. Do you insert ALL of this into the LLM prompt?

**Answer:** No, not all at once. RECALL instructions control WHEN and WHAT gets injected:

```dsl
MEMORY:
  persistent:
    - user.preferred_chains        # ["Marriott", "Hilton"]
    - user.preferred_room_type     # "king bed, non-smoking"
    - user.loyalty_programs        # {"marriott": "Gold", "hilton": "Silver"}
    - user.past_bookings           # [{hotel, dates, price}, ...]
    - user.average_budget          # 250

  recall:
    - ON_START: "Check if user has preferred chains and room types"
    - ON_SEARCH: "Consider user's average budget when ranking results"
    - ON_RECOMMENDATION: "Prioritize hotels matching user's past preferences"
    - ON_DESTINATION_MENTION: "Check if user has visited this destination before"
```

**How this works at runtime:**

```
Event: ON_START (conversation begins)
Injected into system prompt:
  "User preferences loaded:
   - Preferred chains: Marriott, Hilton
   - Preferred room: king bed, non-smoking
   - Loyalty: Marriott Gold, Hilton Silver"
NOT injected: past_bookings (too large), average_budget (not relevant yet)

Event: ON_SEARCH (search_hotels is about to be called)
Injected into LLM context:
  "When ranking results, consider:
   - User's average budget: $250/night
   - Preferred chains: Marriott, Hilton"
NOT injected: full past_bookings array (just the summary)

Event: ON_RECOMMENDATION (presenting results to user)
Injected into LLM context:
  "Personalization: User previously stayed at Marriott Paris (4.5 stars, $230/night)
   and Hilton Tokyo ($180/night). Prioritize similar properties."
Injected: relevant subset of past_bookings (same destination or chain)

Event: ON_DESTINATION_MENTION (user says "Paris")
Injected: "User has visited Paris before. Last stay: Marriott Paris, June 2025."
```

**Key design principle:** RECALL events are selective injections, NOT "dump everything into the prompt." Each event triggers loading of SPECIFIC persistent fields relevant to that moment. This keeps the LLM context small and focused.

**What Bruce should know:**

- The runtime loads persistent memory from the store lazily (on event triggers)
- Only fields relevant to the current recall instruction are loaded
- The instruction text tells the LLM HOW to use the data, not just that it exists
- Large collections (past_bookings) are summarized or filtered before injection

---

## 20. Pre-Search Constraints — Tool Execution Timing

**Bruce's concern:** How do pre_search constraints work if we haven't searched yet? Blackout dates and minimum stay — these sound like they'd be part of the search unless the user named a specific hotel.

**Answer:** Pre-search constraints use lightweight validation tools, not the hotel search itself:

```
┌─────────────────────────────────────────────────────────────────┐
│ User: "I want a hotel in Hawaii, Dec 24-26"                     │
│                                                                 │
│ Step 1: GATHER extracts destination=Hawaii, checkin=Dec 24,     │
│         checkout=Dec 26                                         │
│                                                                 │
│ Step 2: pre_search CONSTRAINTS fire:                            │
│                                                                 │
│   ┌─────────────────────────────────────────────────────┐       │
│   │ check_blackout_dates("Hawaii", Dec 24, Dec 26)      │       │
│   │ This is a POLICY lookup, not a hotel search:        │       │
│   │ → Checks a calendar of blackout dates               │       │
│   │ → No hotel database involved                        │       │
│   │ → Returns: { allowed: false, reason: "Holiday" }    │       │
│   └─────────────────────────────────────────────────────┘       │
│                                                                 │
│   ┌─────────────────────────────────────────────────────┐       │
│   │ validate_minimum_stay("Hawaii", Dec 24, Dec 26)     │       │
│   │ This checks DESTINATION-LEVEL policies:             │       │
│   │ → Hawaii has a 3-night minimum (destination rule)   │       │
│   │ → Dec 24-26 = 2 nights                              │       │
│   │ → Returns: { valid: false, minimum: 3, nights: 2 }  │       │
│   └─────────────────────────────────────────────────────┘       │
│                                                                 │
│ Step 3: Constraint fails → ON_FAIL message sent                 │
│         "Those dates fall within a blackout period..."           │
│                                                                 │
│ Step 4: search_hotels() is NEVER called                         │
│         (pre_search means "gate BEFORE the expensive search")   │
└─────────────────────────────────────────────────────────────────┘
```

**Why this matters:**

- `search_hotels()` might be slow (calls external APIs, costs money)
- Pre-search constraints are cheap, fast policy checks
- They prevent wasting an API call when the dates are impossible anyway
- The tools are different: `check_blackout_dates` checks a policy calendar; `search_hotels` queries hotel inventory

**Bruce's scenario — "unless the user named the hotel":**

If the user says "I want the Ritz in Paris, Dec 24-26":

1. `check_blackout_dates("Paris", Dec 24, Dec 26)` → checks if Paris has blackout dates
2. If allowed, `search_hotels()` runs (might filter to just the Ritz)
3. `validate_minimum_stay("Paris", Dec 24, Dec 26)` could also be pre_search or it could be a per-hotel check at the `pre_booking` phase

The phase names (`pre_search`, `pre_booking`) are conventions — the agent author decides which checks go where.

---

## 21. DELEGATE WHEN Clause — When Is It Evaluated?

**Bruce's concern:** `WHEN: booking.ready AND user.loyalty_programs IS SET` — is this checked on every variable change? On every sub-agent return? What triggers it?

**Answer:** DELEGATE WHEN clauses are evaluated at specific checkpoints, not on every variable change:

```
Evaluation points:
1. After each user message is processed
2. After a tool call returns
3. After a delegated agent returns
4. After a GATHER field is completed

NOT evaluated:
- On every SET operation (too expensive)
- Continuously in a loop (not reactive)
```

**Concrete execution trace:**

```
Turn 1: User says "Book me a hotel in Paris, June 10-15"
  → GATHER extracts: destination, checkin, checkout
  → Evaluate DELEGATE WHENs:
    booking.ready = false → skip Loyalty_Lookup
    search_results IS NOT SET → skip Price_Optimizer

Turn 2: Agent calls search_hotels() → returns results
  → Evaluate DELEGATE WHENs:
    booking.ready = false → skip
    search_results.count > 0 AND user.flexible_dates == true → skip (flexible_dates not set)

Turn 3: User says "I'll take the Marriott"
  → selected_hotel = Marriott, booking.ready = true
  → Evaluate DELEGATE WHENs:
    booking.ready = true AND user.loyalty_programs IS SET = true
    → DELEGATE fires: Loyalty_Lookup starts
    → Hotel_Search pauses
    → Loyalty_Lookup runs, returns { points: 5000, rewards: [...] }
    → Hotel_Search resumes with result
    → LLM says: "You have 5,000 Marriott points! Apply for $50 off?"
```

**USE_RESULT semantics:**

```dsl
DELEGATE:
  - AGENT: Loyalty_Lookup
    WHEN: booking.ready AND user.loyalty_programs IS SET
    PURPOSE: "Check for applicable rewards"
    INPUT: {user_id, hotel_chain: selected_hotel.chain}
    RETURNS: {points: number, rewards: Reward[]}
    USE_RESULT: "Offer to apply rewards if available and beneficial"
```

`USE_RESULT` is an LLM instruction — it's injected into the system prompt so the LLM knows what to DO with the returned data. It's not executable code. The LLM reads the result and the instruction, then decides how to present it to the user.

**If the user agrees to apply rewards:** The LLM would call a tool (like `apply_rewards(reward_id, reservation_id)`) — but that tool must be declared in the TOOLS section. If it's not listed, the agent can't apply rewards automatically. Bruce is correct that the spec example is incomplete — it should also show:

```dsl
TOOLS:
  # ... other tools ...
  apply_rewards(reward_id: string, reservation_id: string) -> { discount: number, new_total: number }
```

---

## Summary of Spec Changes Prompted by Bruce's Review (Part 2)

| #   | Issue                         | Resolution                                               |
| --- | ----------------------------- | -------------------------------------------------------- |
| 1   | Comparator redundancy in EBNF | Remove duplicate `==` line                               |
| 2   | AND/OR grouping               | Already works — add paren examples to spec               |
| 3   | ON_FAIL continuation          | Document reasoning vs scripted behavior                  |
| 4   | HANDOFF permanence            | Rename RETURN → EXPECT_RETURN, add TIMEOUT               |
| 5   | Currency in comparisons       | Recommend normalize-at-tool-level pattern                |
| 6   | CONTINUE semantics            | Document full lifecycle with examples                    |
| 7   | COMPLETE overloading          | Document two forms clearly                               |
| 8   | CORRECTIONS in scripted       | It IS allowed — clarify in spec                          |
| 9   | Hybrid extraction             | Document STRATEGY and per-field overrides                |
| 10  | global_digressions casing     | Rename to GLOBAL_DIGRESSIONS                             |
| 11  | Regex match variables         | Fix to use `match.<group>` syntax                        |
| 12  | SORT_BY naming                | Accept ASCENDING/DESCENDING aliases                      |
| 13  | MASK function                 | Document both named patterns and positional API          |
| 14  | COALESCE null/undefined       | Document: null == undefined in ABL                       |
| 15  | Tool implementation           | Document tool binding types (HTTP, Lambda, MCP, sandbox) |
| 16  | Routing keyword matching      | Clarify LLM-based semantic routing, not keyword matching |
| 17  | HANDOFF_PROTOCOL direction    | Require explicit FROM...TO syntax                        |
| 18  | DELEGATE timing               | Show WHEN clause controls pre/post selection             |
| 19  | RECALL injection              | Document selective, event-driven injection               |
| 20  | Pre-search constraint timing  | Clarify these are policy checks, not search              |
| 21  | WHEN evaluation timing        | Document evaluation checkpoints                          |
