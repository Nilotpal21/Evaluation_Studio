# Core Concepts

> **Estimated time**: 25 minutes | **Prerequisites**: Getting Started module

## Learning Objectives

After completing this module, you will be able to:

- Explain the difference between agents that reason by default and agents with structured FLOW steps
- Describe how supervisors route conversations using HANDOFF rules
- Use the REASONING toggle to control LLM involvement at the step level
- Understand how the platform infers execution mode from an agent's definition structure
- Explain what sessions are and how they maintain conversation state

## The ABL Mental Model

The Agent Platform is built on four interconnected concepts: **agents**, **supervisors**, **tools**, and **sessions**. Understanding how they relate gives you a foundation for everything else in the platform.

| Concept        | Analogy                   | Responsibility                              |
| -------------- | ------------------------- | ------------------------------------------- |
| **Supervisor** | Reception desk            | Routes conversations to the right team      |
| **Agent**      | Domain specialist         | Handles a specific task with deep knowledge |
| **Tool**       | Phone, computer, database | Gives agents real-world capabilities        |
| **Session**    | Conversation thread       | Tracks state across messages                |
| **Flow**       | Step-by-step checklist    | Guides agents through a structured process  |

A user sends a message, which arrives at the supervisor. The supervisor evaluates the message against its HANDOFF rules and routes it to the appropriate specialist agent. The agent processes the message using its goal, persona, tools, and constraints. Tools execute API calls or other actions. The session persists all state for the next message.

## Agents: The Unit of Intelligence

An agent is a self-contained unit that knows how to handle a specific domain. It has a goal, a persona, tools it can use, and rules it must follow. Think of an agent like a specialist on a support team -- one person handles billing, another handles shipping, and each brings their own expertise.

```abl
AGENT: Billing_Support
GOAL: "Help customers resolve billing inquiries"

PERSONA: |
  Friendly billing specialist who explains charges clearly.
  Always shows itemized breakdowns before totals.

TOOLS:
  get_invoice(customer_id: string) -> {invoice: object}
  process_refund(invoice_id: string, amount: number) -> {success: boolean}
```

Every agent is defined in ABL, a declarative language purpose-built for describing agent behavior. You declare _what_ the agent should do, not _how_ the runtime should execute it. The platform compiles your ABL into an intermediate representation (IR) and the Runtime handles execution.

### Agents Reason by Default

By default, every agent uses an LLM to make decisions autonomously. You give it a goal, tools, and constraints, and it figures out the best path to accomplish the task. It can handle ambiguous requests, follow up with clarifying questions, and chain multiple tool calls together without explicit instructions for every scenario.

```abl
AGENT: Flight_Search
GOAL: |
  Help users find flights by translating queries into structured
  metadata filters. Resolve airline terms via vocabulary before searching.

TOOLS:
  search_flights(origin: string, destination: string, date: date) -> {flights: array}
  check_availability(flight_id: string) -> {seats: number, price: number}

INSTRUCTIONS: |
  1. Identify filterable terms (cabin class, route type, etc.)
  2. Execute search with resolved filters
  3. Present matching flights clearly with route, class, and fare info
```

This agent has no FLOW section, so it operates in reasoning mode. The LLM decides when to call tools, what to ask the user, and how to compose responses. A customer might say "I need a cheap flight to Tokyo next week but I'm flexible on dates" -- the agent interprets "cheap," decides whether to search multiple dates, and presents options intelligently.

> **Key Concept**: Agents reason by default. Without a FLOW section, the LLM drives the entire conversation, deciding autonomously which tools to call, what questions to ask, and how to respond. This is ideal for open-ended conversations where the path is unpredictable.

## Adding Structured Steps with FLOW

When you need a defined sequence of steps -- data collection, tool calls, and responses in a specific order -- you add a `FLOW` section to your agent. This does not create a different type of agent; it gives the same agent a defined sequence of steps to follow.

```abl
AGENT: Hotel_Booking
GOAL: "Guide users through a complete hotel booking process"

FLOW:
  steps:
    - get_destination
    - get_dates
    - search_hotels
    - confirm_booking

  get_destination:
    REASONING: false
    GATHER:
      - destination: required
    THEN: get_dates

  get_dates:
    REASONING: false
    GATHER:
      - checkin_date: required
        type: date
      - checkout_date: required
        type: date
    THEN: search_hotels

  search_hotels:
    REASONING: false
    CALL: search_hotels(destination, checkin_date, checkout_date)
    THEN: confirm_booking

  confirm_booking:
    REASONING: false
    CALL: create_booking(selected_hotel_id, guest_name, guest_email)
    RESPOND: "Booking confirmed! Confirmation: {{booking_id}}"
    THEN: COMPLETE
```

Each step in this flow sets `REASONING: false`, meaning the step runs deterministically -- the Runtime handles GATHER, CALL, and RESPOND directly without involving the LLM for step logic. The conversation progresses predictably from step to step.

> **Key Concept**: Scripted agents use FLOW with GATHER for strict sequences. The FLOW section defines named steps with explicit transitions (THEN), and GATHER collects typed data from users with prompts and validation. This is ideal for regulated processes, compliance workflows, and structured data collection.

### GATHER: Collecting Data from Users

The GATHER construct is how agents collect structured information during a conversation. Each field specifies a name, type, prompt, and whether it is required:

```abl
get_guest_details:
  REASONING: false
  GATHER:
    - guest_name: required
      prompt: "What is the primary guest name (as on ID)?"
    - guest_email: required
      type: email
      prompt: "What is your email address?"
    - guest_phone: required
      prompt: "What is your phone number?"
  THEN: confirm_booking
```

When a step has multiple GATHER fields, the Runtime collects them in a natural conversational flow. The `type: email` declaration validates input format automatically, re-prompting if invalid.

## Per-Step Reasoning Control

This is where ABL's design really shines. Within a single FLOW, you can combine deterministic steps (`REASONING: false`) with reasoning steps (`REASONING: true`). Most agent frameworks force a binary choice: full LLM reasoning or no reasoning at all. ABL lets you control reasoning at the individual step level.

```abl
AGENT: Insurance_Claim
GOAL: "Process insurance claims with data collection and intelligent assessment"

FLOW:
  steps:
    - collect_policy_info
    - collect_incident_details
    - assess_claim
    - present_decision

  collect_policy_info:
    REASONING: false
    GATHER:
      - policy_number: required
      - incident_date: required
        type: date
    THEN: collect_incident_details

  collect_incident_details:
    REASONING: false
    GATHER:
      - description: required
      - damage_estimate: required
        type: number
    THEN: assess_claim

  assess_claim:
    REASONING: true
    INSTRUCTIONS: |
      Review the claim details and assess coverage eligibility.
      Check policy terms, evaluate the incident description,
      and determine the recommended payout amount.
    THEN: present_decision

  present_decision:
    REASONING: false
    RESPOND: "Based on my assessment: {{assessment_result}}"
    THEN: COMPLETE
```

In this example:

- Steps 1 and 2 (`REASONING: false`) use deterministic data collection -- no LLM calls, predictable behavior, low cost
- Step 3 (`REASONING: true`) gives the LLM full autonomy to evaluate the claim using all available context -- the LLM calls tools, reasons about results, and makes a judgment
- Step 4 (`REASONING: false`) returns to deterministic mode to present the result

> **Key Concept**: The REASONING toggle on each step controls whether that step uses LLM reasoning or runs deterministically. `REASONING: false` means the Runtime handles the step directly (GATHER, CALL, RESPOND) without LLM involvement. `REASONING: true` gives the LLM full autonomy for that step. This lets you optimize cost, latency, and predictability per step within a single agent.

### Why Per-Step Reasoning Matters

| Step Type          | LLM Calls | Token Cost    | Predictability | Best For                                           |
| ------------------ | --------- | ------------- | -------------- | -------------------------------------------------- |
| `REASONING: false` | None      | Zero          | High           | Data collection, confirmations, template responses |
| `REASONING: true`  | Yes       | Per-turn cost | Variable       | Analysis, research, open-ended conversation        |

By defaulting to `REASONING: false` and selectively enabling it only where you need LLM intelligence, you keep token costs low while still leveraging AI where it matters.

## Supervisors: Routing with HANDOFF

A supervisor routes conversations to the right specialist agent. It evaluates the user's intent against a set of HANDOFF rules and transfers control to the matching agent. Supervisors do not handle domain tasks directly -- they are the control plane for your multi-agent system.

```abl
SUPERVISOR: Retail_Supervisor
GOAL: "Route customers to the right specialist"

HANDOFF:
  - TO: Order_Tracking
    WHEN: intent.category == "order_tracking"

  - TO: Returns_And_Refunds
    WHEN: intent.category == "returns"

  - TO: Product_Advisor
    WHEN: intent.category == "product_advice"

  - TO: Live_Agent
    WHEN: human_requested == true OR intent.confidence < 0.5
```

> **Key Concept**: Supervisors route conversations using HANDOFF rules. The platform evaluates each `WHEN` as an expression over session state. For semantic routing, classify into fields such as `intent.category` first and then route on those fields. Deterministic rules like `input contains "lookup"` work the same way.

### HANDOFF vs. DELEGATE

ABL supports two multi-agent patterns:

| Pattern      | Direction                  | Context                                                | Use When                                              |
| ------------ | -------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **HANDOFF**  | Transfers the conversation | Full conversational context passes to the target agent | The target agent takes over the conversation entirely |
| **DELEGATE** | Dispatches a subtask       | Input/output mapping with a specific purpose           | The current agent needs a result back and continues   |

A HANDOFF is like transferring a phone call -- the new agent takes over. A DELEGATE is like asking a colleague to look something up -- you wait for the answer and continue your work.

## How Execution Mode Is Determined

ABL does not have an explicit `MODE` keyword. The platform **infers** the execution mode from the structure of your agent definition:

| Definition Structure              | Inferred Execution Mode                        |
| --------------------------------- | ---------------------------------------------- |
| No `FLOW` section                 | Agent reasons by default (LLM agentic loop)    |
| Has `FLOW` section                | Agent follows defined steps sequentially       |
| Has `SUPERVISOR` declaration      | Agent runs as a router with handoff evaluation |
| `REASONING: true` on a flow step  | That step uses the LLM reasoning loop          |
| `REASONING: false` on a flow step | That step runs deterministically               |

> **Key Concept**: Execution mode is inferred from the definition structure, not declared explicitly. If your agent has no FLOW section, it reasons. If it has a FLOW section, it follows steps. If it starts with SUPERVISOR instead of AGENT, it routes. The deprecated MODE keyword produces a parser error if used.

This means you never have to declare a mode explicitly -- the platform figures it out from what you wrote.

### Decision Matrix: Choosing the Right Approach

| Factor                      | Agent (default)         | Agent with FLOW        | Supervisor          |
| --------------------------- | ----------------------- | ---------------------- | ------------------- |
| **Conversation path**       | Unpredictable           | Defined sequence       | N/A (routing)       |
| **Decision complexity**     | High (judgment needed)  | Low (rules suffice)    | Medium (intent)     |
| **Compliance requirements** | Flexible                | Strict, auditable      | N/A                 |
| **Data collection**         | Organic, conversational | Structured, sequential | None                |
| **Tool usage**              | Agent decides when      | Explicit in each step  | None                |
| **Predictability**          | Lower                   | Higher                 | Medium              |
| **Token cost**              | Higher (LLM per turn)   | Lower (LLM optional)   | Low                 |
| **Best for**                | Support, advisory       | Forms, workflows       | Multi-agent systems |

## Sessions: Stateful Conversations

A session represents a single conversation between a user and your agent system. When a user sends a message, the platform creates a session that tracks the full conversation state: messages exchanged, data gathered, which agent is active, and where the flow has progressed to.

Sessions persist across messages. When the user returns after a pause, the session remembers where they left off. If the supervisor hands off to a specialist, the session maintains the full history so the specialist has context.

> **Key Concept**: Sessions are stateful conversations that persist across messages. They track conversation history, collected data (from GATHER), active agent, flow position, and variable state. Sessions are scoped to a single user within a single project -- data from one session never leaks to another, even within the same tenant.

### Session Lifecycle

1. **Created** when a user sends their first message
2. **Active** as long as the user is interacting (with configurable idle timeouts)
3. **Persisted** to durable storage with encryption at rest
4. **Expired** automatically via configurable TTLs when the conversation is idle too long
5. **Compressed** -- conversation history is compressed before storage to reduce footprint

## Putting It All Together

Here is how all the concepts work together in a real-world system:

```
User sends: "I need to rebook my flight"
       |
  [Supervisor] evaluates HANDOFF rules
       |
  Routes to Booking_Agent (WHEN: intent.category == "booking")
       |
  [Booking_Agent] with FLOW:
    Step 1 (REASONING: false): GATHER booking reference
    Step 2 (REASONING: false): CALL get_booking(reference)
    Step 3 (REASONING: true):  Analyze options, suggest alternatives
    Step 4 (REASONING: false): RESPOND with confirmation
       |
  [Session] persists all state for next message
```

The supervisor handles routing. The agent with steps handles the structured booking process. Reasoning is enabled only for the step that needs LLM judgment. The session tracks everything.

## Key Takeaways

- Every agent **reasons by default** -- the LLM drives the conversation unless you add a FLOW section for structured steps
- **Supervisors** route conversations to specialist agents using HANDOFF rules with intelligent intent matching
- The **REASONING toggle** (`true`/`false`) on each flow step controls whether that step uses LLM reasoning or runs deterministically
- **Execution mode is inferred** from the definition structure -- no explicit MODE declaration needed
- **Sessions** are stateful conversations that persist across messages, tracking history, collected data, and flow position

## What's Next

Move to the **ABL Basics** module to learn the ABL language syntax, file structure, and how to write your first complete agent definition from scratch.
