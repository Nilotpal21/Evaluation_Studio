# Patterns & Deployment

> **Estimated time**: 40 minutes | **Prerequisites**: Understanding of multi-agent concepts (supervisor, handoff, delegation); familiarity with deployment infrastructure

## Learning Objectives

After completing this module, you will be able to:

- Describe the sequential pipeline pattern and when to use it over other orchestration patterns
- Explain priority-based routing using the Jupiter Bank example and identify P0 as human escalation
- Compare Agent Platform plan tiers and identify what distinguishes the Enterprise tier
- Plan a self-hosted deployment with the minimum required infrastructure (MongoDB + Redis)
- Apply conversation sliding windows and other cost optimization techniques

## Orchestration Patterns: Basics and Routing

Orchestration is about routing work to the right agent and managing context as conversations move between agents. Agent Platform supports four core patterns, each suited to different scenarios.

### Pattern Overview

| Pattern                | When to Use                                                      | User Experience                                    |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| **Supervisor routing** | Entry point for multi-agent systems; intent-based routing        | User talks to one agent at a time, routed by topic |
| **Handoff**            | User needs a different specialist; conversation topic changes    | User is "transferred" to a new agent               |
| **Delegation**         | Agent needs a sub-task done; result feeds back into current flow | Transparent -- user does not see the delegation    |
| **Fan-out**            | Agent needs multiple things done in parallel                     | Transparent -- user sees a single combined result  |

### The Sequential Pipeline Pattern

A sequential pipeline chains agents where each completes its work and hands off to the next. Data flows in one direction with no branching.

**When to use:** Multi-stage processing -- document review, data enrichment, approval chains, or any workflow where each stage depends on the previous stage's output.

```abl
SUPERVISOR: Document_Pipeline
DESCRIPTION: "Sequential document processing pipeline"
GOAL: "Process documents through intake -> validate -> process -> confirm"

MEMORY:
  session:
    - pipeline_stage
    - document_id
    - validation_result

RETURN_HANDLERS:
  advance_to_validation:
    CONTINUE: true
  advance_to_processing:
    CONTINUE: true

ON_START:
  SET:
    pipeline_stage = "intake"

HANDOFF:
  # Stage 1: Intake
  - TO: Intake_Agent
    WHEN: pipeline_stage == "intake"
    CONTEXT:
      pass: [document_id, raw_content]
    RETURN: true
    ON_RETURN:
      handler: advance_to_validation
      map:
        extracted_data: intake_data

  # Stage 2: Validation
  - TO: Validation_Agent
    WHEN: pipeline_stage == "validation"
    CONTEXT:
      pass: [document_id, intake_data]
    RETURN: true
    ON_RETURN:
      handler: advance_to_processing
  # Stage 3: Processing (only if validation passed)
  - TO: Processing_Agent
    WHEN: pipeline_stage == "processing" AND validation_result == true
    CONTEXT:
      pass: [document_id, intake_data]
    RETURN: true

  # Validation failed -- route to error handler
  - TO: Error_Handler
    WHEN: pipeline_stage == "processing" AND validation_result == false
    RETURN: false
```

> **Key Concept**: The sequential pipeline uses `RETURN: true` on every stage so the supervisor regains control after each step. `ON_RETURN.map` extracts results from child agents into session variables. The supervisor can inspect intermediate results and short-circuit the pipeline (e.g., skip processing when validation fails).

### The Router/Dispatcher Pattern

The most common pattern for customer service: a supervisor classifies intent and routes to the appropriate specialist.

```abl
SUPERVISOR: Service_Router
GOAL: "Classify intent and route to the correct specialist"

RETURN_HANDLERS:
  check_additional_needs:
    RESPOND: "Anything else can I help with?"
    CONTINUE: true
  reclassify_intent:
    RESUME_INTENT: true

ESCALATE:
  triggers:
    - WHEN: user.wants_human == true OR user.frustration_detected == true
      REASON: "User requested human support"
      PRIORITY: high

HANDOFF:
  # Priority 1: Account operations
  - TO: Account_Agent
    WHEN: intent.category == "balance" OR intent.category == "account_details"
    RETURN: true
    ON_RETURN:
      handler: check_additional_needs
  # Priority 2: Transfers
  - TO: Transfer_Agent
    WHEN: intent.category == "transfer" OR intent.category == "payment"
    RETURN: true

  # Fallback: Unclear intent
  - TO: Fallback_Agent
    WHEN: intent.unclear == true OR intent.confidence < 0.5
    RETURN: true
    ON_RETURN:
      handler: reclassify_intent
```

Rules are evaluated **top-to-bottom**. Place high-priority routes first. The first matching rule wins.

## Delegation and Fan-Out

### Delegation: Transparent Sub-Tasks

Delegation is a call-and-return pattern. The parent agent sends a task to a child agent, waits for the result, and continues. The user does not see the delegation happening.

```abl
DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "modify"
    PURPOSE: "Calculate total fees for the requested changes"
    INPUT:
      booking_id: selected_booking
      change_type: action_type
    RETURNS:
      total_fee: quoted_fee
      breakdown: fee_breakdown
    USE_RESULT: "Present fee breakdown to customer"
    TIMEOUT: "10s"
    ON_FAILURE: RESPOND "Unable to calculate fees right now."
```

### Fan-Out: Parallel Execution

Fan-out sends tasks to multiple agents simultaneously and aggregates results. Use it when independent tasks can run in parallel -- like searching flights, hotels, and activities at the same time.

```abl
DELEGATE:
  - AGENT: Flight_Search
    WHEN: need_flights == true
    PURPOSE: "Find available flights"
    INPUT:
      origin: departure_city
      destination: arrival_city
    RETURNS:
      flights: available_flights
    TIMEOUT: "15s"
    ON_FAILURE: RESPOND "Flight search unavailable."

  - AGENT: Hotel_Search
    WHEN: need_hotels == true
    PURPOSE: "Find available hotels"
    INPUT:
      destination: arrival_city
    RETURNS:
      hotels: available_hotels
    TIMEOUT: "15s"
    ON_FAILURE: RESPOND "Hotel search unavailable."
```

Multiple `DELEGATE` entries with overlapping `WHEN` conditions execute in parallel. Each has its own `ON_FAILURE` handler, enabling partial failure tolerance -- if one supplier is down, results from others are still presented.

## Enterprise and Industry Patterns: Jupiter Bank

Jupiter Bank is the platform's reference enterprise example -- a full-service retail banking platform with 12 specialist agents orchestrated by a single supervisor.

### Jupiter's Priority Architecture

```
Jupiter_Supervisor (supervisor)
  |-- Live_Agent_Transfer (P0 -- human escalation)
  |-- Identity_Verification (P1 -- auth gate)
  |-- Fraud_Claims (P2 -- time-sensitive)
  |-- Dispute_Resolution (P3)
  |-- Complaint_Handler (P4)
  |-- Card_Management (P5)
  |-- Payment_Processing (P6)
  |-- Account_Inquiry (P7)
  |-- Account_Maintenance (P8)
  |-- Fee_Resolution (P9)
  |-- Lending_Advisory (P10)
  |-- Credit_Card_Advisory (P11)
  |-- Savings_Optimizer (P12)
  |-- Farewell_Agent (P13)
  |-- Fallback_Handler (P14)
```

> **Key Concept**: Human escalation is Priority 0 (P0) -- the **highest priority**. This means `ESCALATE` is always checked first, before any automated routing. In banking, a frustrated customer should never be stuck in an automated loop. The P0 trigger fires when `intent.category == "escalation"` OR `user.wants_human_agent == true` OR `user.frustration_detected == true`, and routes to a human/system resolution path instead of hiding escalation inside `HANDOFF`.

### Why P0 is Human Escalation

In Jupiter Bank's design, the priority ordering reflects a business-critical principle: **customer safety and satisfaction come before automation efficiency**. A customer reporting fraud (P2) is urgent, but a customer explicitly asking for a human (P0) is the highest priority because:

- It may indicate the automated system has failed them
- Ignoring it erodes trust in the entire platform
- Regulatory requirements often mandate escalation paths

### Authentication as a Gate

Notice that Identity Verification is P1 -- the first thing checked after human escalation. Unauthenticated users are routed to the verification agent before they can access any account-sensitive service. The `RETURN: true` handoff uses a named return handler such as `route_authenticated_request`, so the supervisor regains control after authentication and re-routes to the appropriate domain agent.

### VIP and Escalation Triggers

```abl
ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: "Multiple routing failures"
      PRIORITY: high

    - WHEN: handoff_count >= 5
      REASON: "Customer bounced between too many agents"
      PRIORITY: high
      TAGS: [ux_failure, retention]

    - WHEN: customer_segment == "private_banking" AND wait_time_seconds > 60
      REASON: "Private banking client experiencing delays"
      PRIORITY: critical
      TAGS: [vip, retention]
```

## Plan Tiers and Billing

Agent Platform offers three plan tiers, each designed for different organizational needs:

|                        | Starter | Professional  | Enterprise    |
| ---------------------- | ------- | ------------- | ------------- |
| **Team members**       | Up to 5 | Up to 25      | **Unlimited** |
| **Projects**           | Up to 3 | Up to 20      | **Unlimited** |
| **Monthly sessions**   | 1,000   | 50,000        | **Custom**    |
| **Monthly tokens**     | 1M      | 50M           | **Custom**    |
| **LLM providers**      | 2       | All supported | All supported |
| **Connectors**         | --      | Yes           | Yes           |
| **Advanced analytics** | --      | Yes           | Yes           |
| **Guardrails**         | --      | Yes           | Yes           |
| **SSO**                | --      | --            | **Yes**       |
| **KMS (BYOK)**         | --      | --            | **Yes**       |
| **Dedicated support**  | --      | --            | **Yes**       |
| **SLA**                | --      | 99.9%         | **99.95%**    |

> **Key Concept**: The Enterprise tier is distinguished by three exclusive features that Professional plans do not offer: **SSO** (single sign-on for enterprise identity), **KMS/BYOK** (bring your own encryption keys for regulatory compliance), and **dedicated support** with a 99.95% SLA. These are the features that large organizations with compliance requirements need.

### Cost Optimization Strategies

Managing LLM costs is critical at scale. Here are the most impactful strategies:

1. **Use the right tier for the job** -- Route simple classification to Fast-tier models (10x cheaper than Powerful).
2. **Set daily token budgets** -- A daily limit prevents a single runaway agent from consuming a month's quota in a day.
3. **Enable conversation sliding windows** -- For long-running agents, sliding windows limit conversation history sent to the LLM, reducing input token costs by 60-80%.
4. **Review agent-level usage monthly** -- Identify agents with high per-session token counts and optimize their prompts.
5. **Archive inactive projects** -- Deployed agents in inactive projects may still consume resources from webhooks.

> **Key Concept**: Conversation sliding windows are the single most impactful cost optimization for agents with long conversations. Instead of sending the entire 50-turn conversation history to the LLM on every turn, a sliding window sends only the last N turns, summarizing older context. This dramatically reduces input tokens while preserving the information the agent needs.

## Self-Hosted Deployment

For organizations that need full control over data residency, security, and scaling, Agent Platform supports self-hosted deployment.

### Minimum Infrastructure Requirements

| Component      | Required? | Purpose                                                      |
| -------------- | --------- | ------------------------------------------------------------ |
| **MongoDB**    | Yes       | Primary database for all persistent data                     |
| **Redis**      | Yes       | Session state, caching, distributed locks, BullMQ job queues |
| **ClickHouse** | Optional  | Analytics and metrics dashboards                             |
| **Kafka**      | Optional  | Event streaming for analytics pipelines                      |

> **Key Concept**: The minimum self-hosted deployment requires **MongoDB + Redis**. These two services are non-negotiable. MongoDB stores all persistent data (agents, projects, sessions, traces). Redis handles session state, caching, distributed locks, and the BullMQ job queues that power the channel adapter pipeline. ClickHouse and Kafka are optional -- they enable advanced analytics but are not required for core agent execution.

### Service Architecture

| Service              | Default Port | Description                                        |
| -------------------- | ------------ | -------------------------------------------------- |
| **Runtime**          | 3112         | Agent execution engine, chat API, channel webhooks |
| **Studio**           | 5173         | Web-based development environment                  |
| **Admin**            | 3003         | Platform administration API                        |
| **SearchAI**         | 3113         | Knowledge base ingestion and search                |
| **SearchAI Runtime** | 3114         | RAG query execution                                |

### Scaling Guidelines

The Runtime and SearchAI services are stateless and horizontally scalable behind a load balancer. Session state lives in Redis, shared state in MongoDB.

| Sessions     | Runtime Replicas | Redis              | MongoDB            |
| ------------ | ---------------- | ------------------ | ------------------ |
| < 100        | 1-2              | Single instance    | Single replica set |
| 100-1,000    | 2-4              | Sentinel (3 nodes) | 3-node replica set |
| 1,000-10,000 | 4-8              | Cluster (6 nodes)  | Sharded cluster    |
| 10,000+      | 8+               | Cluster (6+ nodes) | Sharded cluster    |

### Security Checklist

Before exposing to production traffic:

- TLS on all public endpoints
- 256-bit encryption key configured
- Strong JWT signing secret (32+ characters)
- MongoDB and Redis authentication enabled
- Rate limiting enabled
- Admin routes restricted to known IP ranges
- Audit logging enabled and exported to SIEM

## Key Takeaways

- The sequential pipeline pattern chains agents in order using `RETURN: true` so the supervisor can inspect results and short-circuit on failure
- Jupiter Bank uses P0 (highest priority) for human escalation -- frustrated or explicitly requesting customers are never stuck in automation
- Enterprise tier distinguishes itself with SSO, KMS/BYOK, dedicated support, and 99.95% SLA
- Self-hosted deployments require MongoDB + Redis at minimum; ClickHouse and Kafka are optional for analytics
- Conversation sliding windows are the most impactful cost optimization, reducing input token costs by 60-80% for long conversations

## What's Next

Explore the [Agent Patterns](../agent-patterns/content.md) module for a business-analyst perspective on when to use each agent type, or the [Modules & Scaling](../modules-scaling/content.md) module for reusable module architecture and model configuration.
