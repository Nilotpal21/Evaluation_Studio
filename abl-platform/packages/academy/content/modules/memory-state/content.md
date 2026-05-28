# Memory & State

> **Estimated time**: 30 minutes | **Prerequisites**: Basic ABL agent structure, flow steps fundamentals

## Learning Objectives

After completing this module, you will be able to:

- Declare and manage session variables with types, initial values, and reset behavior
- Configure persistent variables with `SCOPE: user` and `SCOPE: project` for cross-session data
- Use `RESET: per_step` to create step-scoped accumulators and counters
- Set up `BEHAVIOR_PROFILES` for dynamic behavior modification based on runtime context
- Understand the difference between `REQUIRE` and `RESTRICT` constraint keywords
- Configure TTL on persistent variables for automatic expiration

## Why Memory Matters

Without memory, every conversation starts from zero. The agent cannot recall who the user is, what they prefer, or what happened in previous sessions. ABL provides two kinds of memory: **session variables** that track data within a single conversation, and **persistent memory** that survives across sessions. Together with constraints and behavior profiles, these constructs give your agent awareness of state, rules, and context.

## Session Variables

Session variables hold data relevant to the current conversation -- collected values, running totals, flags, tool results, and intermediate state. They are created when the session starts and discarded when it ends.

### Declaring Session Variables

```abl
MEMORY:
  session:
    - selected_booking
      TYPE: string
      DESCRIPTION: "The booking ID the customer is managing"
    - action_type
      TYPE: string
      DESCRIPTION: "What the customer wants to do"
    - quoted_fee
      TYPE: number
      DESCRIPTION: "Fee quoted for the pending modification"
    - attempt_count
      TYPE: number
      INITIAL: 0
      RESET: per_step
```

A minimal declaration needs only the variable name:

```abl
MEMORY:
  session:
    - customer_id
    - order_total
```

Adding `TYPE`, `DESCRIPTION`, `INITIAL`, and `RESET` provides runtime validation, documentation, default values, and lifecycle control.

### RESET: per_step for Step-Scoped Variables

> **Key Concept**: The `RESET` property controls when session variables are reset. The default `per_session` means the variable lives for the entire conversation. `RESET: per_step` resets the variable to its initial value at the start of each flow step -- making it ideal for step-scoped accumulators, error counters, or retry trackers that should not carry state from one step to another.

```abl
MEMORY:
  session:
    - step_error_count
      TYPE: number
      INITIAL: 0
      RESET: per_step

    - conversation_summary
      TYPE: string
      RESET: per_session

    - global_counter
      TYPE: number
      INITIAL: 0
      RESET: never
```

| Reset Value   | Behavior                                                       | Use Case                                              |
| ------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `per_session` | Initialized at session start, cleared at session end (default) | Most variables                                        |
| `per_step`    | Reset to initial value at each flow step transition            | Error counters, retry trackers, per-step accumulators |
| `never`       | Persists for the lifetime of the runtime process               | Use sparingly -- prefer persistent memory             |

### Using Session Variables

Reference variables by name in templates and expressions:

```abl
FLOW:
  confirm_booking:
    REASONING: false
    RESPOND: |
      Booking summary:
      Hotel: {{selected_hotel.name}}
      Guest: {{guest_name}}
      Total: ${{quoted_fee}}
    THEN: COMPLETE
```

Use them in conditions and checks:

```abl
check_eligibility:
  REASONING: false
  CHECK: attempt_count < 3
  ON_FAIL: too_many_attempts
  THEN: process_request
```

## Persistent Memory

Persistent variables survive across sessions. When the same user starts a new conversation, their stored facts are available for recall. This enables personalization, history tracking, and continuity.

### Declaring Persistent Variables

```abl
MEMORY:
  persistent:
    - user.preferred_language
    - user.loyalty_tier
      SCOPE: user
    - user.booking_history
      SCOPE: user
      TYPE: array
      DESCRIPTION: "Recent booking history"
```

Persistent variable paths use dot notation. The first segment typically indicates the scope (`user.*` or `project.*`), but you can override with the `SCOPE` property.

### User-Scoped vs. Project-Scoped Persistent Variables

> **Key Concept**: Persistent variables have two scopes. `SCOPE: user` stores values unique per authenticated user -- two users in the same project see different values. `SCOPE: project` shares values across all users within the project, useful for reference data, feature flags, or global configuration like exchange rates.

```abl
MEMORY:
  persistent:
    - user.preferred_chains
      SCOPE: user
      DESCRIPTION: "User's preferred hotel chains"

    - user.wire_history_30d
      SCOPE: user
      TYPE: array
      ACCESS: readwrite
      DEFAULT: []

    - project.exchange_rates
      SCOPE: project
      ACCESS: read
      DESCRIPTION: "Current exchange rates (shared across all users)"
```

| Property  | Default     | Purpose                                             |
| --------- | ----------- | --------------------------------------------------- |
| `SCOPE`   | `user`      | `user` for per-user data, `project` for shared data |
| `ACCESS`  | `readwrite` | `read`, `write`, or `readwrite`                     |
| `TYPE`    | --          | Value type for runtime validation                   |
| `DEFAULT` | `null`      | Fallback when no stored value exists                |

### TTL on Persistent Variables

Persistent data should not live forever. Use TTL (time-to-live) on remember triggers to automatically expire stored facts:

```abl
MEMORY:
  remember:
    - WHEN: user_name IS SET
      STORE: user_name -> user.name
      TTL: "90d"
    - WHEN: preferred_language IS SET
      STORE: preferred_language -> user.language
      TTL: "365d"
```

> **Key Concept**: The `TTL` property on a remember trigger sets an expiration on the stored fact. After the TTL elapses, the value is automatically deleted from persistent storage. Use shorter TTLs for volatile data (30 days for session preferences) and longer TTLs for stable data (365 days for language preference). TTL uses duration strings: `s` for seconds, `m` for minutes, `h` for hours, `d` for days.

### Auto-Recall: Remember and Recall

The memory system has two mechanisms for bridging sessions:

**Remember triggers** automatically write values to persistent memory when conditions are met:

```abl
MEMORY:
  remember:
    - WHEN: user_name IS SET
      STORE: user_name -> user.name
      TTL: "90d"
    - WHEN: action_completed == true
      STORE: {booking_id: selected_booking, action: action_type, date: now} -> user.booking_history
```

**Recall instructions** load persistent facts back at specific lifecycle events:

```abl
MEMORY:
  recall:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user.name, user.language, user.preferred_agent]
    - ON: session:start
      ACTION: prompt_llm
      INSTRUCTION: "Greet the user by name if known"
```

| Recall Event    | When It Fires                                         |
| --------------- | ----------------------------------------------------- |
| `session:start` | When a new session initializes, before any user input |
| `search:before` | Before a search or retrieval operation                |

| Recall Action    | Behavior                                                 |
| ---------------- | -------------------------------------------------------- |
| `inject_context` | Loads specified paths directly into session variables    |
| `load_memory`    | Loads all facts in a specified domain                    |
| `prompt_llm`     | Passes instruction text to the LLM as additional context |

### Complete Remember/Recall Pattern

```abl
MEMORY:
  session:
    - selected_booking
      TYPE: string
    - action_type
      TYPE: string

  persistent:
    - user.booking_history
    - user.preferences

  remember:
    - WHEN: action_completed == true
      STORE: {booking_id: selected_booking, action: action_type, date: now} -> user.booking_history
    - WHEN: user_preference IS SET
      STORE: user_preference -> user.preferences

  recall:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user.booking_history, user.preferences]
```

## Conversation History Management

As conversations grow longer, the accumulated message history sent to the LLM increases token consumption significantly. Agent Platform provides mechanisms to manage conversation history efficiently.

### Conversation Sliding Windows

A sliding window limits how many recent turns are sent to the LLM as conversation context. Older messages are dropped from the context window, reducing input tokens while keeping the most relevant recent context.

```abl
EXECUTION:
  model: gpt-4o
  conversation_window:
    max_turns: 20
    strategy: sliding
```

> **Key Concept**: **Conversation sliding windows** are one of the most effective cost optimization tools. Without a window, a 50-turn conversation sends all 50 turns as context on every LLM call -- multiplying input token costs. A sliding window of 20 turns keeps costs bounded regardless of conversation length, while preserving enough context for coherent responses. The optimal window size depends on your use case: simple FAQ agents work well with 5-10 turns, while complex transactional agents may need 20-30.

### History Summarization

For conversations where older context is still relevant but sending full history is too expensive, configure history summarization:

```abl
EXECUTION:
  model: gpt-4o
  conversation_window:
    max_turns: 15
    strategy: summarize
    summary_model: gpt-4o-mini
```

With the `summarize` strategy, when the conversation exceeds `max_turns`, the platform uses a lightweight model to generate a summary of older messages. This summary is prepended to the recent turns, preserving important context while dramatically reducing token count.

### Interaction with Session Variables

Conversation history management interacts with session variables in an important way: even when older messages are dropped from the LLM context, session variable values are preserved. This means data collected in early turns (names, booking IDs, preferences) remains available through variables, even if the original messages collecting that data are no longer in the context window.

This is why using session variables for important data is critical -- they provide a reliable state mechanism that survives context window trimming.

## SET, CLEAR, and TRANSFORM

These flow directives manipulate state during agent execution.

**SET** assigns values using expressions, arithmetic, and function calls:

```abl
calculate_total:
  REASONING: false
  SET:
    - total_price = nights * price_per_night
    - tax_amount = total_price * 0.12
    - final_total = total_price + tax_amount
  RESPOND: "Your total is ${{final_total}}."
  THEN: confirm
```

**CLEAR** removes variables from the session:

```abl
restart:
  REASONING: false
  CLEAR: [destination, checkin_date, checkout_date, search_results]
  RESPOND: "Let's start fresh."
  THEN: collect_trip_info
```

**TRANSFORM** filters, maps, sorts, and limits array data:

```abl
filter_hotels:
  REASONING: false
  TRANSFORM:
    SOURCE: search_results AS hotel
    INTO: affordable_hotels
    FILTER: hotel.price <= budget
    MAP:
      name: hotel.name
      price: hotel.price
      rating: hotel.rating
    SORT_BY: price asc
    LIMIT: 5
  THEN: show_results
```

## CONSTRAINTS: REQUIRE vs RESTRICT

Constraints are deterministic business rules evaluated by the runtime -- not suggestions to the LLM. They enforce guardrails on agent behavior that cannot be bypassed.

### REQUIRE: Assert a Condition Must Be True

`REQUIRE` states that a condition must hold. If the condition evaluates to false, the `ON_FAIL` action triggers:

```abl
CONSTRAINTS:
  always:
    - REQUIRE customer_verified == true
      ON_FAIL: "Please verify your identity first."

  pre_booking:
    - REQUIRE amount <= available_balance
      ON_FAIL: "Insufficient funds. Available: {{available_balance}}."
```

### RESTRICT: Assert Something Is Forbidden

`RESTRICT` expresses a prohibition. The condition describes what is forbidden -- when it evaluates to true, the constraint fails:

```abl
CONSTRAINTS:
  pre_booking:
    - RESTRICT beneficiary_country IN ["CU", "IR", "KP", "SY"]
      ON_FAIL: "Transfers to that destination are prohibited under sanctions."
```

> **Key Concept**: `REQUIRE` and `RESTRICT` express opposite logic. `REQUIRE condition` fails when the condition is **false** (asserting something must be true). `RESTRICT condition` fails when the condition is **true** (asserting something must not happen). There is also `LIMIT` for numeric boundaries, which is semantically equivalent to `REQUIRE` with a comparison but communicates intent more clearly.

### Constraint Phases and ON_FAIL Actions

Constraints are grouped into named phases that determine when they are evaluated:

| Phase         | When Evaluated                                             |
| ------------- | ---------------------------------------------------------- |
| `always`      | Every turn, before any step logic                          |
| `pre_search`  | Before a search or retrieval tool call                     |
| `pre_action`  | Before action tool calls (tools with `side_effects: true`) |
| `pre_booking` | Before booking/transaction operations (convention)         |
| Custom names  | When a flow step references them via `CHECK`               |

ON_FAIL actions include simple messages, `HANDOFF` to another agent, `ESCALATE` for human review, `BLOCK` for silent blocking, and structured blocks that combine `RESPOND`, `COLLECT`, and `GOTO`:

```abl
CONSTRAINTS:
  pre_booking:
    - REQUIRE departure_date IS SET AND return_date IS SET
      ON_FAIL:
        RESPOND: "I need your travel dates."
        COLLECT: [departure_date, return_date]
        THEN: retry
```

## BEHAVIOR_PROFILES for Dynamic Behavior

Behavior profiles are composable overlays that dynamically modify an agent's behavior based on runtime context. They are evaluated per-turn, so the agent's tools, instructions, and constraints can change as the conversation progresses.

```abl
BEHAVIOR_PROFILE: Voice_Channel_Profile
PRIORITY: 10
WHEN: channel.name == "voice"

INSTRUCTIONS: |
  Keep responses concise and conversational.
  Use natural spoken language rather than written formatting.

VOICE:
  instructions: "Speak clearly and at a moderate pace."

TOOLS:
  HIDE: [render_chart, export_pdf]
  ADD:
    - NAME: transfer_call
      DESCRIPTION: "Transfer the call to a specialist"
      PARAMETERS:
        - NAME: department
          TYPE: string
          REQUIRED: true

RESPONSE:
  max_response_length: 200
  fallback_format: plain_text
```

> **Key Concept**: Behavior profiles use `WHEN` expressions (CEL syntax) evaluated against a runtime context that includes channel type, caller identity, session metadata (including `turn_count`), and environment variables. The runtime re-evaluates all profile conditions at the start of every turn. This means tools, voice overrides, instructions, and constraints can change dynamically as the conversation progresses.

### Profile Context

The `WHEN` expression evaluates against these context paths:

| Path                      | Type    | Example                     |
| ------------------------- | ------- | --------------------------- |
| `channel.name`            | string  | `"web"`, `"voice"`, `"sms"` |
| `caller.is_authenticated` | boolean | `true` / `false`            |
| `session.turn_count`      | number  | `1`, `5`, `10`              |
| `session.is_new`          | boolean | `true` on first turn        |
| `env.deployment_region`   | string  | `"us-east-1"`               |

### Practical Examples

**Turn-count-based tool gating** -- add advanced tools only after initial engagement:

```abl
BEHAVIOR_PROFILE: Advanced_Tools
PRIORITY: 20
WHEN: session.turn_count > 3

TOOLS:
  ADD:
    - NAME: schedule_callback
      DESCRIPTION: "Schedule a callback"
      PARAMETERS:
        - NAME: datetime
          TYPE: string
          REQUIRED: true
```

**Authentication-gated tools** -- restrict sensitive tools to authenticated users:

```abl
BEHAVIOR_PROFILE: Authenticated_User
PRIORITY: 15
WHEN: caller.is_authenticated == true

TOOLS:
  ADD:
    - NAME: view_account_balance
      DESCRIPTION: "Show account balance"
    - NAME: transfer_funds
      DESCRIPTION: "Transfer funds between accounts"
```

**Channel-adaptive behavior** -- adjust response format for SMS:

```abl
BEHAVIOR_PROFILE: SMS_Constraints
PRIORITY: 10
WHEN: channel.name == "sms"

INSTRUCTIONS: |
  Keep all responses under 160 characters. No markdown.

RESPONSE:
  max_response_length: 160
  fallback_format: plain_text

TOOLS:
  HIDE: [render_chart, show_image, interactive_form]
```

### Profile Merge Semantics

When multiple profiles are active, they merge in priority order (lowest first, highest wins):

| Section        | Merge Rule                             |
| -------------- | -------------------------------------- |
| `INSTRUCTIONS` | Append all (ordered by priority)       |
| `CONSTRAINTS`  | Append all                             |
| `TOOLS_HIDE`   | Cumulative union                       |
| `TOOLS_ADD`    | Cumulative union                       |
| `VOICE`        | Last (highest priority) wins per field |
| `RESPONSE`     | Last (highest priority) wins per field |

## Key Takeaways

- Session variables track conversation state; use `RESET: per_step` for step-scoped counters that should not carry between steps
- Persistent variables with `SCOPE: user` store per-user data across sessions; `SCOPE: project` shares data globally; TTL prevents stale data from accumulating
- `REQUIRE` asserts something must be true (fails when false); `RESTRICT` asserts something is forbidden (fails when true) -- both are deterministic runtime checks, not LLM suggestions
- `BEHAVIOR_PROFILES` dynamically modify tools, instructions, and constraints per-turn based on channel, authentication, turn count, and other runtime context
- Remember triggers and recall instructions bridge sessions by automatically storing and loading persistent facts

## What's Next

With memory and state management mastered, explore the **Safety & Guardrails** module to learn how constraints work alongside guardrails to protect your agent, or the **Flow Control** module to see how SET, CLEAR, and TRANSFORM manipulate state within flows.
