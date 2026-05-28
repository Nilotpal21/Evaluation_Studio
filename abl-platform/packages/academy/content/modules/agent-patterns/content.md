# Agent Patterns

> **Estimated time**: 30 minutes | **Prerequisites**: None -- this module is designed for business analysts, product managers, and anyone evaluating agent design patterns

## Learning Objectives

After completing this module, you will be able to:

- Identify when to use scripted agents, reasoning agents, and supervisors based on the business problem
- Explain how priority-based routing works in the Jupiter Bank example
- Describe why supervisors are the right choice for multi-team, multi-domain organizations
- Recommend appropriate agent patterns for common industry scenarios
- Define key ROI metrics: containment rate and session duration

## Three Types of Agents

Agent Platform offers three fundamental agent types. Choosing the right type is the most important design decision you will make -- it determines how flexible, predictable, and maintainable your agent will be.

### Reasoning Agents (Open-Ended Conversations)

A reasoning agent uses LLM intelligence to decide what to do at each turn. It does not follow a fixed script. Instead, the model interprets the user's intent, selects appropriate tools, gathers information, and formulates responses dynamically.

**Best for:** Open-ended conversations where the user's path cannot be predicted in advance -- advisory, research, Q&A, creative problem-solving, and exploratory interactions.

**Real-world examples:**

- A product advisor that helps customers find the right product through a natural conversation
- A research assistant that searches knowledge bases and synthesizes information
- A technical support agent that diagnoses problems through iterative questioning

**Why reasoning agents work here:** These conversations are inherently unpredictable. A customer might ask about pricing, then switch to compatibility questions, then compare two products. A rigid script would feel frustrating. The reasoning agent adapts naturally to wherever the conversation goes.

> **Key Concept**: Reasoning agents are the right choice for **open-ended conversations** where the path depends on user intent that cannot be predicted upfront. They provide the most natural experience but require clear instructions, limitations, and guardrails to stay on track.

### Scripted Agents (Multi-Step Processes)

A scripted agent follows a defined flow graph with explicit steps, transitions, and data collection points. Each step specifies what to say, what data to gather, what tool to call, and which step comes next.

**Best for:** Regulated processes, data collection workflows, step-by-step wizards, and any scenario where the order of operations matters and must be auditable.

**Real-world examples:**

- A hotel booking flow: search -> select -> guest details -> payment -> confirmation
- An insurance claims intake: incident details -> documentation -> assessment -> resolution
- A product return process: order lookup -> reason selection -> shipping label -> refund confirmation

**Why scripted agents work here:** A product return has specific steps that must happen in a specific order. You need the order number before you can look up the return policy. You need the return reason before you can generate a shipping label. The agent must collect specific information at each stage and validate it before proceeding.

> **Key Concept**: Scripted agents are the right choice for **multi-step processes** like returns, bookings, and claims where the sequence matters and data must be collected in order. They provide predictability, auditability, and compliance -- critical for regulated industries.

### Supervisors (Multi-Domain Routing)

A supervisor is a special agent that acts as a router. It receives every incoming message and decides which specialist agent should handle it. It does not handle domain logic itself -- it classifies intent and routes with context.

**Best for:** Organizations with multiple departments, product lines, or service categories where a single entry point needs to direct users to the right specialist.

**Why supervisors matter for multi-team domains:** Consider a bank that offers credit cards, loans, savings, transfers, and fraud resolution. Each area has different business rules, different tools, different compliance requirements. One agent cannot handle all of this well. A supervisor routes customers to the right specialist quickly, preserving context so the customer does not repeat themselves.

> **Key Concept**: Supervisors are justified when you have **multiple distinct domains** that require specialized knowledge, tools, or compliance rules. They keep each specialist agent focused and maintainable, while providing a unified entry point for users.

## Priority-Based Routing: The Jupiter Bank Example

Jupiter Bank is the platform's reference enterprise deployment -- 12 specialist agents orchestrated by a single supervisor. Its priority system illustrates best practices for routing design.

### The Priority Stack

| Priority | Agent                 | Why This Priority                            |
| -------- | --------------------- | -------------------------------------------- |
| **P0**   | Live_Agent_Transfer   | Human escalation -- highest priority, always |
| P1       | Identity_Verification | Authentication gate before account access    |
| P2       | Fraud_Claims          | Time-sensitive security concern              |
| P3       | Dispute_Resolution    | Financial dispute requiring investigation    |
| P4       | Complaint_Handler     | Customer dissatisfaction                     |
| P5       | Card_Management       | Card services (lock, replace, activate)      |
| P6       | Payment_Processing    | Transfers and payments                       |
| P7       | Account_Inquiry       | Balance checks and statements                |
| P8       | Account_Maintenance   | Address changes, preferences                 |
| P9       | Fee_Resolution        | Fee disputes and waivers                     |
| P10      | Lending_Advisory      | Loan inquiries                               |
| P11      | Credit_Card_Advisory  | Credit card recommendations                  |
| P12      | Savings_Optimizer     | Savings advice                               |
| P13      | Farewell_Agent        | Session end                                  |
| P14      | Fallback_Handler      | Unclear intent                               |

### Why P0 is Human Escalation

The most important design decision in Jupiter Bank is making `Live_Agent_Transfer` the absolute highest priority (P0). This fires when:

- The customer explicitly requests a human agent
- The system detects frustration in the conversation
- The conversation has bounced between too many agents

This is not just a convenience feature -- it is a trust mechanism. A customer who says "I want to speak to a human" should never be overridden by intent classification. The P0 rule ensures that no matter what else the system thinks it should do, human escalation wins.

### How Priority Rules Work

Rules are evaluated **top-to-bottom**. The first matching rule wins. This means:

1. If a customer is frustrated AND asking about their balance, P0 fires (human escalation), not P7 (account inquiry)
2. If a customer is not authenticated AND wants to transfer money, P1 fires (identity verification), not P6 (payment processing)
3. If intent is unclear, P14 fires (fallback) only because no higher-priority rule matched

This ordering reflects real business priorities: safety first (P0), security second (P1-P2), then service complexity in descending order.

## Choosing the Right Pattern by Scenario

### When to Use a Scripted Agent

| Scenario                | Why Scripted                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| Product returns         | Fixed steps: find order, select reason, generate label, confirm refund |
| Insurance claims intake | Regulated process with mandatory data collection                       |
| Loan application        | Sequential verification with compliance requirements                   |
| Onboarding wizard       | Step-by-step setup that must complete in order                         |
| Appointment scheduling  | Date/time selection, confirmation, reminder setup                      |

The common thread: **the process has steps that must happen in order**, data must be validated at each stage, and the workflow needs to be auditable.

### When to Use a Reasoning Agent

| Scenario                  | Why Reasoning                                       |
| ------------------------- | --------------------------------------------------- |
| Product recommendations   | Conversational exploration of needs and preferences |
| Research assistance       | Dynamic search, synthesis, follow-up questions      |
| Technical troubleshooting | Iterative diagnosis based on symptoms               |
| General Q&A               | Unpredictable questions across a knowledge base     |
| Creative brainstorming    | Open-ended idea generation                          |

The common thread: **the conversation path depends on user responses** and cannot be scripted in advance.

### When to Use a Supervisor

| Scenario                                                  | Why Supervisor                                      |
| --------------------------------------------------------- | --------------------------------------------------- |
| Enterprise customer service (banking, telecom)            | Multiple departments with different specialties     |
| Multi-product support portal                              | Each product has different tools and knowledge      |
| Internal help desk (IT, HR, Facilities)                   | Different teams handle different request types      |
| Healthcare triage                                         | Route by symptom category to appropriate specialist |
| E-commerce with separate order, return, and loyalty teams | Each team has different business rules              |

The common thread: **multiple distinct domains** that are too complex for a single agent and require specialized handling.

## Industry Applications

### Banking: Multi-Agent with Priority Routing

Banks need multiple specialists (fraud, payments, accounts, loans) with strict security gates. The supervisor pattern with priority-based routing and authentication gates is the standard architecture.

Key design elements:

- Authentication as a gate (P1) before any account access
- Fraud and security as high-priority routes (P2)
- Human escalation as the absolute highest priority (P0)
- VIP detection for private banking clients

### Healthcare: Triage and Specialist Routing

Healthcare agents route patients by symptom category, urgency level, and care type. A supervisor classifies the patient's needs and routes to the appropriate specialist (scheduling, pharmacy, billing, clinical advice).

Key design elements:

- Urgency classification drives routing priority
- Scripted flows for appointment scheduling and medication refills
- Reasoning agents for symptom assessment and clinical Q&A
- Strict compliance with healthcare data regulations

### Retail and E-commerce: Mixed Pattern

E-commerce typically combines all three patterns:

- **Supervisor** routes between order management, returns, product advice, and loyalty
- **Scripted agents** handle returns (fixed process) and checkout
- **Reasoning agents** handle product recommendations and general Q&A

### Travel: Sequential Pipelines and Parallel Search

Travel agents often use fan-out for parallel search (flights + hotels + activities simultaneously) and sequential pipelines for booking flows (search -> select -> guest details -> payment -> confirmation).

## Measuring ROI: Containment Rate and Session Duration

When evaluating agent effectiveness, two metrics matter most:

### Containment Rate

**Definition:** The percentage of customer interactions fully resolved by the agent without human escalation.

**Why it matters:** Every contained interaction saves the cost of a human agent handling it. A containment rate of 70% means 7 out of 10 customers get their issue resolved without human intervention.

**How to improve it:**

- Expand the agent's tool access so it can resolve more issue types
- Improve routing accuracy to send customers to the right specialist on the first try
- Add reasoning steps for edge cases that previously caused escalation
- Analyze escalation reasons to identify patterns

### Session Duration

**Definition:** The time from session start to resolution (or escalation).

**Why it matters:** Shorter sessions mean happier customers and lower LLM costs. A session that resolves in 3 turns costs less (in tokens and time) than one that takes 15 turns.

**How to improve it:**

- Use scripted flows for known processes (eliminates unnecessary back-and-forth)
- Pre-populate context from CRM data (customer does not need to repeat their identity)
- Optimize routing so customers reach the right agent on the first handoff
- Use delegation for background tasks (parallel execution reduces wall-clock time)

> **Key Concept**: Containment rate and session duration are the two primary ROI metrics for agent deployments. Together, they capture both effectiveness (did the agent solve the problem?) and efficiency (how quickly and cheaply?). Track both to demonstrate agent value to stakeholders.

### Benchmarking

| Metric                       | Good        | Excellent       |
| ---------------------------- | ----------- | --------------- |
| Containment rate             | 60-70%      | 80%+            |
| Avg. session duration        | 3-5 minutes | Under 2 minutes |
| First-contact resolution     | 70%+        | 85%+            |
| Customer satisfaction (CSAT) | 4.0/5.0     | 4.5/5.0         |

## Key Takeaways

- Scripted agents are best for multi-step processes (returns, bookings, claims) where order and auditability matter
- Reasoning agents are best for open-ended conversations (advisory, Q&A, troubleshooting) where the path is unpredictable
- Supervisors are justified for multi-domain organizations where specialized agents handle different departments or product lines
- In Jupiter Bank, P0 (human escalation) is the highest priority -- frustrated or requesting customers always reach a human first
- Containment rate (% resolved without humans) and session duration (time to resolution) are the primary ROI metrics

## What's Next

Explore the [Platform Concepts](../platform-concepts/content.md) module for a non-technical overview of orchestration and knowledge base concepts, or the [Patterns & Deployment](../patterns-deployment/content.md) module for technical orchestration patterns and deployment infrastructure.
