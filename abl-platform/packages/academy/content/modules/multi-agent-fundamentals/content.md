# Multi-Agent Fundamentals

> **Estimated time**: 40 minutes | **Prerequisites**: Basic agent building (identity, tools, FLOW steps), familiarity with Studio

## Learning Objectives

After completing this module, you will be able to:

- Build a supervisor that routes conversations to specialist agents
- Configure HANDOFF rules with context passing and RETURN behavior
- Define ESCALATE triggers for human handoff with context
- Combine catalog tools with knowledge base tools in a single agent
- Add FAQ handling to a supervisor using knowledge base search

## Why Multi-Agent?

Single agents work well for focused tasks, but real-world customer support requires different expertise for different problems. A customer tracking an order needs different tools and instructions than one requesting a refund. Multi-agent systems solve this by routing each request to a specialist that excels at that task.

The fundamental building blocks:

- **Supervisor** -- the entry point that receives all messages and routes to the right specialist
- **Specialist agents** -- focused agents with specific goals, tools, and flows
- **Handoff rules** -- conditions that determine when and where to transfer conversations
- **Escalation** -- triggers that route to human agents when automation is insufficient

## The SUPERVISOR Keyword

A supervisor is declared with the `SUPERVISOR` keyword instead of `AGENT`. This is not just a label -- it tells the runtime that this agent acts as a router:

```abl
SUPERVISOR: Retail_Supervisor
GOAL: "Route customers to the right specialist for order tracking, returns, or product questions"

PERSONA: |
  Professional and helpful retail assistant.
  Friendly, efficient, and knowledgeable.
  Routes requests to the right specialist quickly.
```

> **Key Concept**: The `SUPERVISOR` keyword designates an agent as the orchestration entry point. A supervisor receives every incoming message for the session and decides which child agent should handle it. While a supervisor can have tools and instructions of its own, its primary job is routing -- it evaluates HANDOFF rules against each message and transfers the conversation to the matched specialist. There can only be one supervisor per deployment as the entry agent.

## Building Specialist Agents

Specialists are standard agents with focused goals. Here is an order tracking specialist:

```abl
AGENT: Order_Tracker
GOAL: "Help customers track their orders and get shipping updates"

PERSONA: |
  Efficient and reassuring customer service specialist.
  Provides clear, specific information about order status.

TOOLS:
  lookup_order(order_id: string) -> {status: string, tracking_number: string, estimated_delivery: string}
    description: "Look up order details by order ID"

  get_tracking(tracking_number: string) -> {carrier: string, status: string, location: string}
    description: "Get real-time tracking information"

GATHER:
  order_id:
    prompt: "What is your order number?"
    type: string
    required: true
```

And a returns specialist with a structured flow:

```abl
AGENT: Returns_Agent
GOAL: "Process return and refund requests efficiently and fairly"

TOOLS:
  check_return_eligibility(order_id: string, item_id: string) -> {eligible: boolean, reason: string}
    description: "Check if an item is eligible for return"

  initiate_return(order_id: string, item_id: string, reason: string) -> {return_id: string, label_url: string}
    description: "Create a return request and generate shipping label"

FLOW:
  steps:
    - identify_item
    - check_eligibility
    - process_return

  identify_item:
    REASONING: false
    GATHER:
      - order_id: required
      - item_description: required
    THEN: check_eligibility

  check_eligibility:
    REASONING: false
    CALL: check_return_eligibility(order_id, item_id)
    ON_SUCCESS:
      RESPOND: "Your item is eligible for return."
      THEN: process_return
    ON_FAIL:
      RESPOND: "This item is not eligible for return. Reason: {{reason}}"
      THEN: COMPLETE
```

## Configuring HANDOFF Rules

The supervisor uses HANDOFF rules to route conversations based on intent:

```abl
SUPERVISOR: Retail_Supervisor

HANDOFF:
  - TO: Order_Tracker
    WHEN: intent.category == "order_inquiry" OR intent.category == "shipping"
    CONTEXT:
      pass: [customer_id, order_id, session_context]
      summary: "Customer wants to track or check on an order"
    RETURN: false

  - TO: Returns_Agent
    WHEN: intent.category == "return" OR intent.category == "refund"
    CONTEXT:
      pass: [customer_id, order_id, session_context]
      summary: "Customer wants to return an item or check refund status"
    RETURN: false

  - TO: Product_Advisor
    WHEN: intent.category == "browse" OR intent.category == "search"
    CONTEXT:
      pass: [customer_id, search_context]
      summary: "Customer looking for products or recommendations"
    RETURN: false
```

Rules are evaluated **top-to-bottom** -- the first match wins. Place high-priority routes first.

### The CONTEXT Block

The `CONTEXT` block controls what information flows to the target agent:

- **`pass`** -- list of session variable names to transfer
- **`summary`** -- a human-readable description of why the handoff occurred
- **`history`** -- controls conversation history transfer (`auto`, `none`, `summary_only`, `full`, or typed bounded history with `mode: last_n` + `count`)
- **`memory_grants`** -- grants explicit access to specific persistent memory paths

### RETURN: false -- One-Way Handoff

> **Key Concept**: Setting `RETURN: false` on a HANDOFF rule creates a **one-way transfer**. The conversation permanently moves to the target agent -- the supervisor does not regain control. This is the right choice when the specialist will handle the entire remainder of the conversation. Contrast with `RETURN: true`, where the target agent completes its task and returns control to the caller, useful for tasks like authentication where the original flow should resume.

When to use each:

- `RETURN: false` -- Order tracking, returns processing, product browsing (the specialist handles the rest)
- `RETURN: true` -- Authentication checks, fee calculations, quick lookups (the calling agent needs the result)

### Agent-to-Agent Handoff

Specialists can also define their own HANDOFF rules for peer-to-peer routing:

```abl
AGENT: Order_Tracker

HANDOFF:
  - TO: Returns_Agent
    WHEN: intent.category == "refund" OR intent.category == "return"
    CONTEXT:
      pass: [order_id, order_status, customer_id]
      summary: "Customer wants to return or get a refund"
    RETURN: false
```

If a customer starts tracking an order but then asks about a return, the Order_Tracker hands off directly to the Returns_Agent without routing back through the supervisor. This provides a more natural conversation flow.

## Adding ON_START and Templates

Give the supervisor a welcoming greeting using templates:

```abl
SUPERVISOR: Retail_Supervisor

TEMPLATES:
  welcome:
    DEFAULT: |
      Welcome to our store! I can help you with:
      - Track an order or check shipping status
      - Process a return or check refund status
      - Find products or get recommendations
      What can I help you with today?

ON_START:
  RESPOND: TEMPLATE(welcome)
```

The `ON_START` handler fires once at session start, before any user input.

## Configuring ESCALATE Triggers

When automation is not enough -- frustrated users, too many agent bounces, system failures -- the supervisor escalates to a human:

```abl
ESCALATE:
  triggers:
    - WHEN: handoff_count >= 3
      REASON: "Customer bounced between too many agents"
      PRIORITY: high
      TAGS: [ux_failure]

    - WHEN: user.frustration_detected == true
      REASON: "Customer showing signs of frustration"
      PRIORITY: high
      TAGS: [sentiment, retention]

  context_for_human:
    - customer_id
    - conversation_history
    - routing_history
    - last_intent
```

> **Key Concept**: The **`ESCALATE` trigger on `handoff_count`** is a critical safety net. Track `handoff_count` in session memory and escalate when it exceeds a threshold (typically 3-4). This catches scenarios where a customer bounces between agents without resolution -- a strong signal that the automated system is failing. Tag it with `[ux_failure]` for analytics. The `context_for_human` block ensures the human agent receives everything they need to continue without asking the user to repeat information.

The `context_for_human` block passes session variables to the human agent's interface, including the full conversation history and routing trail.

### ESCALATE via ON_ERROR

Error handlers can also trigger escalation:

```abl
ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble understanding your request. Let me connect you with someone who can help."
    RETRY: 1
    THEN: ESCALATE
```

After one retry, if routing still fails, the system escalates to a human.

## Session Memory for Multi-Agent

Track routing state across handoffs:

```abl
MEMORY:
  session:
    - current_intent
    - customer_id
    - routing_history
    - handoff_count
```

Session memory persists across handoffs within the same session. The supervisor uses `handoff_count` for escalation triggers and `routing_history` for debugging.

## Combining Catalog Tools with Knowledge Base Tools

A powerful pattern is giving a specialist both structured API tools and knowledge base search:

```abl
AGENT: Product_Advisor
GOAL: "Help customers find products and make informed decisions"

TOOLS:
  search_products(query: string, category: string) -> {products: array}
    description: "Search the product catalog"

  get_product_details(product_id: string) -> {name: string, price: number, specs: object}
    description: "Get detailed product information"

  compare_products(product_ids: array) -> {comparison: object}
    description: "Compare products side by side"

  search_hybrid(index_id: string, query: string, top_k: number) -> {results: object[]}
    description: "Search product documentation and guides"

INSTRUCTIONS: |
  1. Search for matching products in the catalog
  2. If the customer has technical questions, search the knowledge base
  3. Combine catalog data and documentation to give complete answers
  4. Offer to compare products if the customer is undecided
```

> **Key Concept**: By combining **catalog tools** (`search_products`, `get_product_details`) with a **knowledge base tool** (`search_hybrid`), a single agent can answer both "What laptops do you have under $1000?" (structured catalog search) and "Does the ProBook support USB-C charging?" (documentation search) in the same conversation. The agent's instructions guide it to use the right tool for each type of question.

## Supervisor FAQ Handling with Knowledge Base

Here is a pattern that reduces handoffs and improves response time: give the supervisor a knowledge base tool for quick FAQ-style answers:

```abl
SUPERVISOR: Retail_Supervisor

TOOLS:
  search_hybrid(index_id: string, query: string, top_k: number) -> {results: object[]}
    description: "Search the FAQ knowledge base for quick answers"

HANDOFF:
  - TO: Order_Tracker
    WHEN: intent.category == "order_inquiry" OR intent.category == "shipping"
    CONTEXT:
      pass: [customer_id, order_id]
      summary: "Customer wants to track an order"
    RETURN: false

  - TO: Returns_Agent
    WHEN: intent.category == "return" OR intent.category == "refund"
    CONTEXT:
      pass: [customer_id, order_id]
      summary: "Customer wants a return or refund"
    RETURN: false

INSTRUCTIONS: |
  1. For simple FAQ questions (store hours, policies, general info),
     search the knowledge base and answer directly
  2. For domain-specific requests, route to the appropriate specialist
  3. If the knowledge base returns a clear answer, respond without
     routing -- this reduces handoffs and improves response time
```

> **Key Concept**: A **supervisor can answer FAQs directly** from a knowledge base without routing to a specialist. When a customer asks "What are your store hours?" or "What is your return policy?", the supervisor searches the knowledge base and responds immediately. This keeps simple questions at the supervisor level, reducing handoff count and response latency. Only domain-specific requests that require tools or structured flows get routed to specialists.

This pattern is especially valuable for high-volume deployments where most queries are simple questions answered in documentation.

## Testing the Multi-Agent System

### Conversation Flow Testing

Open the **Chat** panel in Studio and test routing:

1. "Hi, I'd like to check on my order" -- should route to Order_Tracker
2. "Actually, I want to return one of the items" -- Order_Tracker should hand off to Returns_Agent
3. Start a new session: "I'm looking for a good laptop" -- should route directly to Product_Advisor

### Reviewing Traces

The **Traces** panel shows the multi-agent flow as nested spans:

- Supervisor span (top level)
  - Intent classification
  - Handoff decision
  - Agent execution span (nested)

This visualization helps debug routing decisions and context transfer issues.

## The Complete Project Structure

```
my-retail-project/
  supervisor.agent.abl
  agents/
    order_tracker.agent.abl
    returns_agent.agent.abl
    product_advisor.agent.abl
```

## Key Takeaways

- `RETURN: false` creates a **one-way handoff** where the conversation permanently moves to the target agent; use `RETURN: true` for tasks that should return control to the caller
- A **supervisor can answer FAQs directly** from a knowledge base, reducing handoffs for simple questions while routing complex requests to specialists
- The **`SUPERVISOR` keyword** designates an agent as the orchestration entry point that evaluates HANDOFF rules against each message
- **Combine catalog tools with knowledge base tools** in a single agent for comprehensive answers that span structured data and documentation
- **ESCALATE on `handoff_count`** is a critical safety net that catches routing loops and triggers human intervention

## What's Next

Explore the **Orchestration Patterns** module for advanced patterns including DELEGATE (transparent call-and-return), fan-out, thread hierarchy, and CCaaS adapter integration. See the **Advanced Language** module for error handling strategies and lifecycle hooks.
