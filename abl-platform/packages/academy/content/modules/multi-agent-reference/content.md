# Multi-Agent Orchestration Reference

> **Estimated time**: 35 minutes | **Prerequisites**: Agent Configuration, Conversation Flows

## Learning Objectives

After completing this module, you will be able to:

- Describe the four multi-agent constructs (ESCALATE, HANDOFF, DELEGATE, COMPLETE) and their evaluation order
- Configure SUPERVISOR routing rules with correct priority semantics
- Design DELEGATE blocks with failure strategies including ON_FAILURE: escalate
- Control context passing between agents using history strategies
- Configure Supervisor behavior with canRespondDirectly and allowedDirectActions

## The Multi-Agent Model

The Agent Platform supports multi-agent orchestration where specialized agents collaborate to handle complex user requests. Rather than building one monolithic agent that handles everything, you compose a system of focused agents that each excel at a specific domain.

There are two layers to multi-agent systems in ABL:

1. **The Supervisor** -- A top-level orchestrator that routes messages to the right agent based on intent and context. It does not execute tools or gather information; it classifies and routes.
2. **Agent-level constructs** -- Individual agents use HANDOFF, DELEGATE, ESCALATE, and COMPLETE to coordinate with other agents or exit the conversation.

## Supervisor Declaration

A Supervisor uses the `SUPERVISOR:` keyword instead of `AGENT:` and defines which agents are available, how to route between them, and what behavioral constraints apply.

```abl
SUPERVISOR: Customer_Service_Hub
VERSION: "2.0"
DESCRIPTION: "Routes customers to the right specialist"
GOAL: "Route requests to the right specialist with full context preservation"

PERSONA: |
  Professional customer service coordinator. Routes requests
  efficiently and preserves context across agent transfers.
```

### Agent References

The Supervisor declares its available agents with capabilities that inform routing decisions:

```abl
AGENTS:
  - REF: ./agents/flight_search.agent.abl
    ALIAS: Flight_Search
    CAPABILITIES: [flight_booking, fare_search, seat_selection]
    CHANNELS: [web, mobile, voice]
    REQUIRES_VALIDATION: false

  - REF: ./agents/support.agent.abl
    ALIAS: Support_Agent
    CAPABILITIES: [booking_management, cancellation, refund]
    REQUIRES_VALIDATION: true
```

Each reference includes a file path (`REF`), a local alias used in routing rules, and a list of capability tags. The optional `REQUIRES_VALIDATION` flag (default `false`) indicates whether the user must be authenticated before routing to that agent.

## Routing Rules and Priority

Routing rules define how the Supervisor directs messages to agents. They are evaluated in **priority order**, where **lower values are evaluated first** (higher precedence).

```abl
ROUTING:
  - NAME: escalation_route
    DESCRIPTION: "Route frustrated or explicitly requesting human"
    PRIORITY: 1
    WHEN: intent.category == "escalation" OR user.frustration_detected == true
    THEN: ROUTE_TO Live_Agent_Transfer
    FLAGS: [set_active]

  - NAME: booking_route
    PRIORITY: 5
    WHEN: intent.category == "new_booking"
    THEN: ROUTE_TO Sales_Agent

  - NAME: intent_router
    PRIORITY: 10
    WHEN: true
    THEN:
      INTENT_MATCH:
        - INTENTS: [flight_search, hotel_search]
          ACTION: ROUTE_TO Sales_Agent
        - INTENTS: [manage_booking, cancel_booking]
          ACTION: ROUTE_TO Support_Agent
        FALLBACK: ROUTE_TO Fallback_Handler
```

> **Key Concept**: ROUTING PRIORITY uses a "lower number = higher precedence" model. A rule with `PRIORITY: 1` is evaluated before a rule with `PRIORITY: 5`. This means your most critical routes (like escalation) should have the lowest priority numbers.

In the example above, the escalation route (priority 1) is checked first. If a frustrated user sends a message, they are routed to a live agent even if their intent matches a booking pattern. The booking route (priority 5) is only evaluated if the escalation route did not match. The catch-all intent router (priority 10) handles everything else.

### Routing Actions

| Action            | Syntax                       | Description                                  |
| ----------------- | ---------------------------- | -------------------------------------------- |
| Route to agent    | `ROUTE_TO Agent_Name`        | Send the message to a specific agent         |
| Route to user     | `ROUTE_TO_USER "message"`    | Send a message and wait for user input       |
| Route by variable | `ROUTE_TO_VARIABLE var_name` | Route to the agent named in a variable       |
| Intent-based      | `INTENT_MATCH`               | Route based on detected intent with mappings |
| End conversation  | `END_CONVERSATION`           | End the session                              |

### Routing Flags

Flags modify routing behavior:

| Flag             | Effect                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `set_active`     | Mark the target agent as the active agent for subsequent messages |
| `silent`         | Route without sending a user-visible message                      |
| `no_log`         | Do not log this routing decision in the trace store               |
| `priority_boost` | Apply a priority boost in the target agent's queue                |

## Supervisor Behavior Settings

The `BEHAVIOR` block controls whether the Supervisor can respond directly to users or must always route to an agent.

```abl
BEHAVIOR:
  canRespondDirectly: false
  allowedDirectActions: [greet, clarify_intent]
  forbiddenActions: [make_booking, process_payment, access_account]
```

> **Key Concept**: When `canRespondDirectly` is set to `false`, the Supervisor cannot generate its own responses to users -- it must always route to a child agent. However, `allowedDirectActions` provides exceptions: the Supervisor can still perform actions like greeting the user or clarifying their intent without routing. This creates a clean separation where the Supervisor handles meta-conversation (greetings, disambiguation) while agents handle domain work.

This is a common pattern: let the Supervisor handle greetings and intent clarification directly, but route all substantive work to specialized agents. The `forbiddenActions` list adds guardrails ensuring the Supervisor never attempts domain-specific actions like processing payments.

## Evaluation Order Across Constructs

When multiple multi-agent constructs could apply on the same turn, the runtime evaluates them in a strict priority order:

1. **ESCALATE triggers** -- checked first (safety and compliance)
2. **HANDOFF rules** -- evaluated by priority (lower values first)
3. **DELEGATE conditions** -- evaluated in declaration order
4. **COMPLETE conditions** -- checked last

> **Key Concept**: The evaluation order ESCALATE > HANDOFF > DELEGATE > COMPLETE is fundamental to the safety model. ESCALATE always wins because human-escalation scenarios (fraud detection, compliance violations, user distress) must never be bypassed by agent-to-agent routing. COMPLETE is checked last because the agent should only finish when no other construct needs to fire.

This means if a fraud score exceeds 90 AND a handoff condition is true AND a delegate condition is satisfied, only the ESCALATE fires. The other constructs are not evaluated.

## HANDOFF

HANDOFF transfers conversational control from the current agent to another agent, optionally passing context and expecting a return.

```abl
RETURN_HANDLERS:
  resume_if_cleared:
    CONTINUE: true

HANDOFF:
  - TO: Compliance_Officer
    WHEN: sanctions_clear == false
    PRIORITY: 0
    CONTEXT:
      pass: [customer_id, beneficiary_name, amount, sanctions_match_score]
      summary: "Wire flagged during sanctions screening (score: {{sanctions_match_score}})."
      history: full
      memory_grants:
        - path: user.compliance_notes
          access: read
    RETURN: true
    ON_RETURN:
      handler: resume_if_cleared
      map:
        compliance_decision: sanctions_clear
        review_notes: compliance_review_notes
```

### Key HANDOFF Properties

- **TO** -- The target agent name
- **WHEN** -- Condition triggering the handoff
- **PRIORITY** -- Evaluation priority (lower = first, same as routing)
- **CONTEXT** -- What information the target receives
- **RETURN** -- Whether control returns to the calling agent (`true`) or the handoff is one-way (`false`)
- **ON_RETURN** -- Built-in actions or named handlers that control how the parent resumes; structured `ON_RETURN` can also include `map`

### Context and History Strategies

The `CONTEXT` block controls what the target agent sees:

```abl
CONTEXT:
  pass: [customer_id, amount]
  summary: "Customer needs fraud review."
  history: auto
  # Or explicitly narrow history:
  # history:
  #   mode: last_n
  #   count: 10
```

> **Key Concept**: The `history` property controls conversation history transfer. Use `auto` as the default because it keeps the authored summary when that is enough and falls back to bounded raw history when strict summary-only transfer would be lossy. Use the typed bounded-history form (`mode: last_n` plus `count`) when you explicitly want only recent raw messages. Other options include `full`, `summary_only`, and `none`.

| History Value                  | Behavior                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `auto`                         | Default. Prefer summary, fall back to bounded raw history when needed |
| `none`                         | No conversation history is passed                                     |
| `summary_only`                 | Only the summary text, no raw messages                                |
| `full`                         | Complete conversation history                                         |
| `{ mode: last_n, count: <n> }` | The last N messages only                                              |

### Return vs. One-Way Handoff

When `RETURN: true`, the calling agent pauses and waits. Upon return, `ON_RETURN.map` writes results into the parent's variables, and the handler or built-in `ON_RETURN` action guides what happens next.

When `RETURN: false`, the handoff is permanent. The calling agent's session ends and the target agent takes over completely.

## DELEGATE

DELEGATE invokes a sub-agent synchronously, waits for completion, and maps the result back. Unlike HANDOFF, the calling agent retains conversational control throughout.

```abl
DELEGATE:
  - AGENT: Sanctions_Screening
    WHEN: beneficiary_name IS SET AND beneficiary_country IS SET
    PURPOSE: "Screen beneficiary against OFAC SDN and EU sanctions lists"
    INPUT:
      name: beneficiary_name
      account: beneficiary_account
      country: beneficiary_country
    RETURNS:
      cleared: sanctions_clear
      match_score: sanctions_match_score
    USE_RESULT: "Block if match_score > 85. Proceed only if cleared."
    TIMEOUT: "15s"
    ON_FAILURE: escalate
```

### DELEGATE Failure Strategies

The `ON_FAILURE` property determines what happens when a sub-agent fails or times out:

| Value      | Behavior                                                 |
| ---------- | -------------------------------------------------------- |
| `respond`  | Send a message and continue (requires `FAILURE_MESSAGE`) |
| `continue` | Silently continue without the sub-agent's result         |
| `escalate` | Trigger human escalation                                 |
| `retry`    | Retry the delegation (accepts a `count` for max retries) |

> **Key Concept**: `ON_FAILURE: escalate` creates a safety net where a failed sub-agent automatically triggers the ESCALATE flow. This is critical for compliance-sensitive operations. If the Sanctions_Screening agent fails or times out, the system escalates to a human rather than proceeding without the compliance check. The escalation follows the same flow as a top-level ESCALATE trigger -- creating a HumanTask, initiating transfer, and suspending the session.

For structured retries:

```abl
ON_FAILURE:
  type: retry
  count: 2
```

### Fan-Out (Parallel Delegation)

When multiple DELEGATE entries have their conditions satisfied simultaneously, the runtime can execute them in parallel:

```abl
DELEGATE:
  - AGENT: Sanctions_Screening
    WHEN: beneficiary_name IS SET
    PURPOSE: "Screen beneficiary"
    INPUT:
      name: beneficiary_name
    RETURNS:
      cleared: sanctions_clear

  - AGENT: Fraud_Detection
    WHEN: amount IS SET
    PURPOSE: "Score fraud risk"
    INPUT:
      amount: amount
      account: source_account
    RETURNS:
      score: fraud_score
```

Both agents run independently and their results are mapped back as each completes.

## ESCALATE

ESCALATE transfers the conversation to a human operator. It exits the AI agent system entirely and is designed for situations where the agent cannot or should not continue autonomously.

```abl
ESCALATE:
  triggers:
    - WHEN: fraud_score > 90
      REASON: "High fraud risk detected (score: {{fraud_score}})"
      PRIORITY: critical
      TAGS: [fraud, urgent]

    - WHEN: user.requests_human == true AND retry_count >= 1
      REASON: "Customer requesting human after failed resolution attempt"
      PRIORITY: medium

  context_for_human:
    - customer_id
    - payment_amount
    - fraud_score
    - conversation_history

  routing:
    connection: five9
    queue: "payments_l2"
    skills: [payments, fraud_review]
```

When an ESCALATE trigger fires, the runtime executes a multi-step flow: it creates a HumanTask record, initiates transfer to the configured CCaaS provider, optionally creates an ITSM ticket, and suspends the session until human resolution.

## COMPLETE

COMPLETE defines when the agent considers its task finished:

```abl
COMPLETE:
  - WHEN: confirmation_number IS SET AND transfer_status == "released"
    RESPOND: |
      Your wire transfer has been executed successfully.
      **Confirmation:** {{confirmation_number}}
      **Amount:** {{amount}} {{currency}}
    STORE: "wire_transfers"
```

Completion conditions are evaluated after every turn, in declaration order. The first matching condition triggers completion.

## Practical Example: Multi-Tier Coordination

Here is how ESCALATE, DELEGATE, and HANDOFF work together in a payment support agent:

```abl
AGENT: Payment_Support
VERSION: "2.0"
GOAL: "Help customers with payment issues"

ESCALATE:
  triggers:
    - WHEN: fraud_score > 90
      REASON: "High fraud risk detected"
      PRIORITY: critical

DELEGATE:
  - AGENT: Fraud_Screening
    WHEN: payment_amount > 1000
    PURPOSE: "Screen high-value payments for fraud"
    INPUT:
      amount: payment_amount
      account: customer_account
    RETURNS:
      score: fraud_score
    USE_RESULT: "Block if score > 90"
    ON_FAILURE: escalate

HANDOFF:
  - TO: Senior_Support
    WHEN: resolution_attempts >= 3
    CONTEXT:
      pass: [customer_id, issue_summary, resolution_attempts]
      summary: "Customer needs senior assistance after multiple attempts"
      history:
        mode: last_n
        count: 5
    RETURN: false
```

In this example:

1. ESCALATE triggers are checked first every turn. If `fraud_score > 90`, a human takes over.
2. DELEGATE to Fraud_Screening runs when a high-value payment is detected. If the screening agent fails, `ON_FAILURE: escalate` automatically escalates to a human.
3. HANDOFF to Senior_Support fires when resolution attempts are exhausted, passing only the last 5 messages as explicitly bounded context.

## Key Takeaways

- ROUTING PRIORITY follows "lower number = higher precedence" -- put critical routes at priority 1
- The evaluation order is always ESCALATE > HANDOFF > DELEGATE > COMPLETE, ensuring safety-critical checks happen first
- `ON_FAILURE: escalate` on DELEGATE creates a safety net for compliance-critical sub-agent calls
- Use typed bounded history in CONTEXT when you want a manageable window of recent conversation context
- Set `canRespondDirectly: false` with specific `allowedDirectActions` to keep the Supervisor focused on routing while still handling greetings and clarification

## What's Next

Explore the [Orchestration Patterns](../orchestration-patterns/content.md) module for advanced supervisor design strategies, or see [Safety & Compliance](../safety-compliance/content.md) for how ESCALATE integrates with guardrails and compliance requirements.
