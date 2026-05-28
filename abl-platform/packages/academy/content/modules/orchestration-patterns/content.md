# Orchestration Patterns

> **Estimated time**: 45 minutes | **Prerequisites**: Multi-Agent Fundamentals module (supervisor, HANDOFF, ESCALATE basics)

## Learning Objectives

After completing this module, you will be able to:

- Use DELEGATE for transparent call-and-return sub-agent tasks
- Understand the session hierarchy and thread concept
- Implement fan-out patterns with overlapping HANDOFF WHEN conditions
- Configure human escalation with on_human_complete branching
- Understand CCaaS adapter integration for live agent transfers

## Beyond Basic Handoffs: The Four Orchestration Patterns

The Multi-Agent Fundamentals module covered supervisors and handoffs. This module goes deeper into the four orchestration patterns and when to use each:

| Pattern                | When to Use                                    | User Experience                       |
| ---------------------- | ---------------------------------------------- | ------------------------------------- |
| **Supervisor routing** | Entry point; intent-based routing              | User talks to one agent at a time     |
| **Handoff**            | User needs a different specialist              | User is "transferred" to a new agent  |
| **Delegation**         | Agent needs a sub-task done; result feeds back | Transparent -- user does not see it   |
| **Fan-out**            | Agent needs multiple things done in parallel   | Transparent -- single combined result |

The key distinction: **handoffs** change which agent the user is talking to. **Delegations** and **fan-outs** are invisible to the user -- they happen behind the scenes.

## DELEGATE: Transparent Call-and-Return

Delegation is a synchronous call-and-return pattern. The parent agent sends a task to a child agent, waits for the result, and continues with the returned data. The user may never know another agent was involved.

### Defining a Delegate

```abl
DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "modify" OR action_type == "upgrade"
    PURPOSE: "Calculate total fees and price differences for the requested changes"
    INPUT:
      booking_id: selected_booking
      change_type: action_type
      changes: change_details
    RETURNS:
      total_fee: quoted_fee
      breakdown: fee_breakdown
    USE_RESULT: "Present fee breakdown to customer before asking for confirmation"
    TIMEOUT: "10s"
    ON_FAILURE: RESPOND "Unable to calculate fees right now. Let me try again."
```

> **Key Concept**: **DELEGATE** is a transparent call-and-return pattern. Unlike HANDOFF (where the user is transferred to a new agent), DELEGATE calls a sub-agent behind the scenes, waits for it to complete, and maps the returned values back to the calling agent's session variables. The user continues talking to the original agent and may never know a delegation occurred. Use DELEGATE for background calculations, data lookups, and sub-tasks where the user does not need to interact with the sub-agent directly.

### The DELEGATE Properties

| Property     | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| `AGENT`      | Name of the sub-agent to call                                |
| `WHEN`       | Condition that triggers the delegation                       |
| `PURPOSE`    | Description for the sub-agent's context                      |
| `INPUT`      | Maps parent variables (right) to delegate parameters (left)  |
| `RETURNS`    | Maps delegate output (left) back to parent variables (right) |
| `USE_RESULT` | Instructions for how the parent should use the returned data |
| `TIMEOUT`    | Maximum time to wait for the delegate to complete            |
| `ON_FAILURE` | What to do if the delegate fails or times out                |

### The Data Flow

The `INPUT` block maps parent session variables to delegate input: the right side is the parent's variable name, the left side is the delegate's parameter name. `RETURNS` reverses this: the left side is the delegate's output variable, the right side is the parent's session variable that receives the value.

```abl
INPUT:
  booking_id: selected_booking    # delegate sees "booking_id", parent has "selected_booking"
RETURNS:
  total_fee: quoted_fee           # delegate produces "total_fee", parent gets "quoted_fee"
```

### Delegation vs. Handoff

| Aspect         | DELEGATE                         | HANDOFF                          |
| -------------- | -------------------------------- | -------------------------------- |
| Control flow   | Synchronous call-and-return      | Transfer (may or may not return) |
| User awareness | User does not see the sub-agent  | User interacts with a new agent  |
| Data flow      | Structured INPUT/RETURNS mapping | CONTEXT pass list                |
| Use case       | Background calculations, lookups | Full conversation transfers      |

Ask yourself: "Does the user need to know they are talking to a different agent?" If yes, use HANDOFF. If no, use DELEGATE.

### Creating the Delegate Agent

The delegate agent is a standard agent. Its COMPLETE response is what gets returned to the caller:

```abl
AGENT: Fee_Calculator
GOAL: "Calculate all applicable fees for booking changes"

TOOLS:
  get_modification_fee(booking_id: string, change_type: string) -> {base_fee: number, currency: string}
    description: "Get the base modification fee"

  calculate_price_difference(booking_id: string, original: object, new_item: object) -> {price_diff: number}
    description: "Calculate price difference"

COMPLETE:
  - WHEN: fee_calculated == true
    RESPOND: |
      Fee breakdown:
      {{#each fee_breakdown}}
      - {{this.description}}: {{this.amount}} {{this.currency}}
      {{/each}}
      Total: {{total_fee}} {{currency}}
```

### Always Set a TIMEOUT

Without a `TIMEOUT`, the calling agent waits indefinitely if the sub-agent stalls. Always set one:

```abl
DELEGATE:
  - AGENT: Fee_Calculator
    TIMEOUT: "10s"
    ON_FAILURE: RESPOND "Unable to calculate fees right now."
```

`ON_FAILURE` options: `RESPOND "message"` (show message and continue), `ESCALATE` (trigger human escalation), or `RETRY count` (retry the delegation).

## The Session Hierarchy: Sessions and Threads

Understanding the session hierarchy is essential for debugging multi-agent conversations and designing context flow.

### Sessions and Threads

> **Key Concept**: All multi-agent patterns operate within a **session hierarchy**. A **session** is the top-level container spanning the entire interaction -- even across multiple agents. Each agent activation within a session creates a **thread**. Handoffs create new threads; delegations create nested threads that return to the parent. At any given time, one thread is **active** and processing messages. Data flows forward through threads via handoff context and session metadata.

Visualized:

```
Session
  |-- Thread 1: Supervisor (routes to billing)
  |     |-- Thread 2: Billing Agent (handles query)
  |           |-- Thread 3: Fee Calculator (delegated, returns to Thread 2)
  |     |-- Thread 4: Satisfaction Survey (handoff from Thread 2)
```

### Context Flow Between Threads

| Data Type              | Handoff                          | Delegation                   | Fan-out                      |
| ---------------------- | -------------------------------- | ---------------------------- | ---------------------------- |
| Session metadata       | Forwarded (non-internal)         | Available via parent context | Available via parent context |
| Conversation history   | Configurable (none/summary/full) | Not shared                   | Not shared                   |
| Gather progress        | Not transferred                  | Not transferred              | Not transferred              |
| Custom variables (SET) | Transferred as metadata          | Passed explicitly via INPUT  | Passed explicitly via INPUT  |

Key insight: delegated agents do not get conversation history by default. They receive only what you explicitly pass through `INPUT`.

## Fan-Out: Parallel Agent Execution

Fan-out sends tasks to multiple agents simultaneously and aggregates results. This is how you search flights, hotels, and activities in parallel rather than sequentially.

### Fan-Out via Overlapping HANDOFF WHEN Conditions

```abl
SUPERVISOR: Travel_Planner

RETURN_HANDLERS:
  merge_flight_results:
    CONTINUE: true
  merge_hotel_results:
    CONTINUE: true
  merge_activity_results:
    CONTINUE: true

HANDOFF:
  - TO: Flight_Search
    WHEN: intent.category == "plan_trip" OR intent.category == "search_flights"
    CONTEXT:
      pass: [origin, destination, travel_dates]
    RETURN: true
    ON_RETURN:
      handler: merge_flight_results
  - TO: Hotel_Search
    WHEN: intent.category == "plan_trip" OR intent.category == "search_hotels"
    CONTEXT:
      pass: [destination, checkin_date, checkout_date]
    RETURN: true
    ON_RETURN:
      handler: merge_hotel_results
  - TO: Activity_Search
    WHEN: intent.category == "plan_trip" OR intent.category == "search_activities"
    CONTEXT:
      pass: [destination, travel_dates, interests]
    RETURN: true
    ON_RETURN:
      handler: merge_activity_results
```

> **Key Concept**: **Fan-out** is achieved by having **multiple HANDOFF rules with overlapping WHEN conditions**. When `intent.category == "plan_trip"` matches, all three rules trigger simultaneously. Each agent runs independently and returns results via `RETURN: true`. The `ON_RETURN` handler on each specifies how to merge results back into the supervisor's context. This is different from normal top-to-bottom rule evaluation -- when multiple conditions match the same message, the runtime dispatches to all matching agents in parallel.

### Fan-Out via DELEGATE

For sub-task parallelism within a single agent:

```abl
AGENT: Trip_Planner

DELEGATE:
  - AGENT: Flight_Search
    WHEN: need_flights == true
    PURPOSE: "Find available flights"
    INPUT:
      origin: departure_city
      destination: arrival_city
    RETURNS:
      flights: available_flights
      best_price: cheapest_flight_price
    TIMEOUT: "15s"
    ON_FAILURE: RESPOND "Flight search unavailable."

  - AGENT: Hotel_Search
    WHEN: need_hotels == true
    PURPOSE: "Find available hotels"
    INPUT:
      destination: arrival_city
      checkin: checkin_date
    RETURNS:
      hotels: available_hotels
      best_price: cheapest_hotel_price
    TIMEOUT: "15s"
    ON_FAILURE: RESPOND "Hotel search unavailable."
```

Multiple `DELEGATE` entries with overlapping `WHEN` conditions execute in parallel. Each has its own `ON_FAILURE` handler, so partial failures do not block the entire result.

### Partial Failure Tolerance

Each delegate in a fan-out should handle failure independently. If Supplier A is down, the agent still presents results from Supplier B:

```abl
DELEGATE:
  - AGENT: Price_Checker_A
    WHEN: comparison_mode == true
    RETURNS:
      price_a: supplier_a_price
    TIMEOUT: "5s"
    ON_FAILURE: RESPOND "Supplier A unavailable."

  - AGENT: Price_Checker_B
    WHEN: comparison_mode == true
    RETURNS:
      price_b: supplier_b_price
    TIMEOUT: "5s"
    ON_FAILURE: RESPOND "Supplier B unavailable."
```

Use distinct variable names in `RETURNS` for each delegate to prevent one agent's results from overwriting another's.

## Human Escalation: on_human_complete Branching

When an agent escalates to a human, the conversation does not necessarily end. The `on_human_complete` block defines what happens after the human finishes their work:

```abl
ESCALATE:
  triggers:
    - WHEN: user.requests_human == true
      REASON: "Customer requesting human agent"
      PRIORITY: medium

  context_for_human:
    - order_id
    - customer_name
    - cancellation_reason
    - items

  on_human_complete:
    - IF human.resolved == true: COMPLETE
    - IF human.needs_agent == true: HANDOFF to specified_agent
    - IF human.approved_refund == true: CONTINUE
```

> **Key Concept**: The **`on_human_complete`** block defines three branching paths after human intervention: **COMPLETE** (end the session -- the human resolved everything), **HANDOFF** (transfer to a specific agent for further automated handling), or **CONTINUE** (resume the current agent's flow with the human's decision available in context). The human's action determines the branch -- for example, if a manager approves a refund (`human.approved_refund == true`), the agent continues with CONTINUE to process the approved refund automatically.

This is critical for workflows like:

- **High-value refunds**: Agent gathers details, escalates for manager approval, then processes the approved refund automatically (CONTINUE)
- **Complex complaints**: Human resolves the immediate issue and routes remaining questions back to an agent (HANDOFF)
- **Full resolution**: Human handles everything and ends the session (COMPLETE)

### Priority Levels for Escalation

| Priority   | Use Case                                           |
| ---------- | -------------------------------------------------- |
| `low`      | Non-urgent feedback, general inquiries             |
| `medium`   | Standard requests requiring human judgment         |
| `high`     | Frustrated users, repeated failures, policy limits |
| `critical` | Complaints, VIP issues, safety concerns            |

### Escalation via ON_ERROR

Error handlers can trigger escalation after retry exhaustion:

```abl
ON_ERROR:
  tool_error:
    RESPOND: "I encountered an issue."
    RETRY: 1
    THEN: ESCALATE

  routing_failure:
    RESPOND: "I'm having trouble routing your request."
    RETRY: 1
    THEN: HANDOFF Live_Agent_Transfer
```

`THEN: ESCALATE` triggers the escalation flow. `THEN: HANDOFF` goes directly to a specific transfer agent.

## CCaaS Adapter: Five9 Integration

The platform includes a built-in agent transfer framework with adapters for Contact Center as a Service (CCaaS) platforms.

### The Five9 Adapter

> **Key Concept**: The **Five9 CCaaS adapter** manages the full transfer lifecycle when `ESCALATE` fires and agent-transfer routing is configured. The adapter handles authenticating with Five9, checking agent availability, creating a conversation with full context (conversation history, customer metadata), and routing inbound agent messages back to the platform session. This means your `ESCALATE` block is not just a conceptual handoff -- it triggers a real integration with Five9's Virtual Contact Center.

Currently supported adapters:

| Adapter   | Provider                     | Transport          |
| --------- | ---------------------------- | ------------------ |
| **Five9** | Five9 Virtual Contact Center | Webhook (REST API) |

### Building a Live Agent Transfer Agent

For a complete transfer experience, create a dedicated transfer agent:

```abl
AGENT: Live_Agent_Transfer
GOAL: "Connect customers with human agents smoothly"

TOOLS:
  check_agent_availability(department: string, priority: string) -> {available: boolean, estimated_wait: number}
    description: "Check if human agents are available"

  create_transfer_ticket(user_id: string, reason: string, context: object) -> {ticket_id: string}
    description: "Create a transfer ticket with conversation context"

  schedule_callback(user_id: string, phone: string, preferred_time: datetime) -> {callback_id: string}
    description: "Schedule a callback when agents are unavailable"

FLOW:
  entry_point: check_availability

  steps:
    - check_availability
    - create_ticket
    - do_transfer
    - offer_callback

  check_availability:
    REASONING: false
    CALL: check_agent_availability("support", "medium")
    ON_SUCCESS:
      - IF: result.available == true
        RESPOND: "An agent is available. Estimated wait: ~{{result.estimated_wait}} minutes."
        THEN: create_ticket
      - ELSE:
        RESPOND: "All agents are currently busy."
        THEN: offer_callback

  offer_callback:
    REASONING: false
    GATHER:
      - wants_callback: required
    ON_INPUT:
      - IF: input contains "yes"
        GATHER:
          - callback_number: required
          - callback_time: required
        CALL: schedule_callback(user_id, callback_number, callback_time)
        RESPOND: "Callback scheduled for {{callback_time}}."
        THEN: COMPLETE
      - ELSE:
        RESPOND: "You can reach us at support@example.com."
        THEN: COMPLETE
```

## Routing Rules Deep Dive

### Rule Evaluation Order

1. Rules are evaluated **top-to-bottom** in the HANDOFF block
2. The **first rule** whose WHEN condition matches is selected
3. If no rule matches, the supervisor handles the message directly (if enabled) or returns an error
4. ON_ERROR handlers catch routing failures

### Priority-Ordered Routing

```abl
RETURN_HANDLERS:
  route_to_booking_manager:
    CONTINUE: true
  reclassify_intent:
    RESUME_INTENT: true

ESCALATE:
  triggers:
    - WHEN: intent.category == "escalation" OR user.frustration_detected == true
      REASON: "User requested human support"
      PRIORITY: high

HANDOFF:
  # P2 -- Authentication required
  - TO: Authentication_Agent
    WHEN: user.is_authenticated == false AND intent.category == "manage_booking"
    RETURN: true
    ON_RETURN:
      handler: route_to_booking_manager
  # P3 -- Standard routing
  - TO: Booking_Manager
    WHEN: user.is_authenticated == true AND intent.category == "manage_booking"

  # P4 -- Fallback
  - TO: Fallback_Handler
    WHEN: intent.unclear == true OR intent.confidence < 0.5
    RETURN: true
    ON_RETURN:
      handler: reclassify_intent
```

Place more specific conditions before general ones. Use `RETURN: true` with `ON_RETURN` for agents that perform a task and should return control (like authentication).

### Natural Language Conditions

For semantic routing, classify first and author WHEN conditions as expressions over the resulting state:

```abl
HANDOFF:
  - TO: Flight_Search
    WHEN: intent.category == "flight_search"
    PASS: query

  - TO: Policy_Advisor
    WHEN: intent.category == "policy"
    PASS: query
```

The platform evaluates these `WHEN` expressions against session state. For deterministic routing, use direct checks such as `input contains "lookup"`.

### Loop Detection

Track handoff count and escalate when it gets too high:

```abl
MEMORY:
  session:
    - handoff_count
    - routing_history

ESCALATE:
  triggers:
    - WHEN: handoff_count >= 4
      REASON: "Customer bounced between too many agents"
      PRIORITY: high
      TAGS: [ux_failure]
```

## Context Passing Patterns

### Pass Variables in Handoff

```abl
CONTEXT:
  pass: [user_id, booking_context, auth_token]
  summary: "Authenticated user managing reservation"
  history: full
  memory_grants:
    - path: user.last_verified_at
      access: read
```

### Pass Context in Delegation

```abl
DELEGATE:
  - AGENT: Fee_Calculator
    INPUT:
      booking_id: selected_booking      # delegate parameter: parent variable
    RETURNS:
      total_fee: quoted_fee             # delegate output: parent variable
```

### Context for Human Escalation

```abl
ESCALATE:
  context_for_human:
    - booking_id
    - user_id
    - action_type
    - refund_amount
    - conversation_history
```

Include everything the human needs to continue without the user repeating information.

## Key Takeaways

- **DELEGATE** provides transparent call-and-return for sub-tasks -- the user never sees the sub-agent, and structured INPUT/RETURNS mapping controls data flow
- The **session hierarchy** consists of sessions (top-level containers) and **threads** (one per agent activation); handoffs create new threads, delegations create nested threads
- **Fan-out** is achieved via **overlapping HANDOFF WHEN conditions** -- when multiple rules match the same message, all matching agents execute in parallel
- The **Five9 CCaaS adapter** manages full transfer lifecycle including authentication, conversation creation, and message bridging with Five9 Virtual Contact Center
- **`on_human_complete`** supports three branches: **COMPLETE** (end session), **HANDOFF** (transfer to agent), or **CONTINUE** (resume current flow with the human's decision)

## What's Next

Explore the **Advanced Language** module for lifecycle hooks, NLU configuration, and error handling strategies. See the **Production Deployment** module for deploying your multi-agent system to channels with environment management.
