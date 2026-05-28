# Platform Concepts

> **Estimated time**: 25 minutes | **Prerequisites**: None -- this module is written for a non-technical or semi-technical audience

## Learning Objectives

After completing this module, you will be able to:

- Explain multi-agent orchestration concepts: supervisor routing, delegation, and fan-out
- Describe what knowledge bases do and why hybrid search is the default strategy
- Understand deployment options including self-hosted
- Articulate when and why a supervisor is justified for multi-domain routing
- Discuss the business value of each orchestration pattern

## What Is Multi-Agent Orchestration?

Real-world customer interactions rarely fit neatly into a single category. A bank customer might start with a balance check, then ask about a suspicious transaction, then want to dispute a charge. Each of these needs different expertise, different data access, and potentially different compliance rules.

Multi-agent orchestration is how Agent Platform handles this complexity. Instead of one giant agent that tries to do everything, you build specialized agents -- each expert in one area -- and coordinate them through clear patterns.

### The Supervisor: Your Virtual Receptionist

Think of a supervisor agent like a receptionist at a large office. When someone walks in, the receptionist does not try to solve their problem directly. Instead, they listen, understand what the person needs, and route them to the right department.

A supervisor agent works the same way:

1. It receives every incoming message from the customer
2. It understands what the customer is asking for
3. It routes the conversation to the right specialist agent
4. It preserves context so the customer does not repeat themselves

The supervisor never handles domain-specific work itself. It does not look up account balances or process refunds. Its entire job is classification and routing -- and it does that one job very well.

### When Is a Supervisor Justified?

A supervisor adds complexity, so it is not always the right choice. You need a supervisor when:

- **Multiple distinct domains exist.** A bank with credit cards, loans, savings, and fraud needs specialists for each area. One agent cannot master all these domains.
- **Different business rules apply to different areas.** Fraud handling has different compliance requirements than savings advice. Separate agents enforce these boundaries cleanly.
- **Teams want to iterate independently.** The fraud team can update their agent without affecting the payments agent. Each specialist evolves at its own pace.
- **Routing logic is important enough to be explicit.** Priority-based routing (escalation first, security second, service third) is a business decision that should be clearly expressed, not buried in a single agent's instructions.

> **Key Concept**: A supervisor is justified for **multi-domain routing** -- when your organization serves customers across multiple areas that each require specialized knowledge, tools, or compliance rules. The supervisor provides a unified entry point while keeping each specialist focused and independently maintainable.

If you only have one service area (like a product recommendation agent or a simple FAQ bot), you do not need a supervisor. Use a single reasoning or scripted agent instead.

## Orchestration Patterns Explained

Agent Platform supports four orchestration patterns. Each serves a different purpose. Understanding when to use each one is more important than understanding how they work technically.

### Handoff: Transferring the Conversation

A handoff transfers the customer from one agent to another. The customer is aware of the transfer -- they might see a message like "Let me connect you with our billing specialist."

**When to use:** The customer's topic has changed, or they need a different specialist. The original agent stops handling the conversation, and the new agent takes over.

**Business example:** A customer calls about their internet service. They start by asking about their bill (billing agent), then mention they are moving to a new address (account changes agent). The billing agent hands off to the account changes agent with the customer's context.

### Delegation: Behind-the-Scenes Sub-Tasks

Delegation is a call-and-return pattern. The current agent sends a sub-task to another agent, waits for the result, and continues the conversation. The customer does not see the delegation -- it happens behind the scenes.

**When to use:** The agent needs information or a calculation from another system, but the customer should not be transferred. The agent maintains the conversation while getting help in the background.

**Business example:** A travel agent is helping a customer modify their booking. The agent needs to calculate change fees, so it delegates to a fee calculator agent. The fee calculator returns the breakdown, and the travel agent presents it to the customer -- all within the same conversation.

> **Key Concept**: Delegation is for **transparent sub-tasks**. The customer never knows another agent was involved. Use it when you need specialized processing (risk scoring, fee calculation, compliance checks) that should happen behind the scenes while the primary agent maintains the conversation.

### Fan-Out: Parallel Searches

Fan-out sends the same request to multiple agents simultaneously and combines their results. The customer sees a single, merged response.

**When to use:** You need information from multiple independent sources, and getting them one at a time would be too slow.

**Business example:** A customer asks a travel planner to "plan a trip to Tokyo next month." The planner fans out to three agents simultaneously: one searches flights, one searches hotels, one searches activities. All three run at the same time. When all results are back, the planner presents a combined trip plan.

> **Key Concept**: Fan-out is for **parallel searches** where multiple independent lookups need to happen simultaneously. It reduces the customer's wait time by running tasks concurrently instead of sequentially.

### How the Patterns Compare

| Pattern        | Customer Sees It?             | Use Case                                  |
| -------------- | ----------------------------- | ----------------------------------------- |
| **Handoff**    | Yes -- "Connecting you to..." | Topic changed, need different specialist  |
| **Delegation** | No -- transparent             | Background calculation, lookup, or check  |
| **Fan-out**    | No -- sees combined result    | Parallel searches across multiple sources |

## Knowledge Bases: Grounding Agents in Your Data

Without a knowledge base, your agent can only use what the LLM learned during training -- which may be outdated, incomplete, or wrong for your specific domain. Knowledge bases give agents access to your organization's actual documents, policies, and data.

### How It Works (Simplified)

1. **You upload documents** -- PDFs, Word documents, web pages, or connect a data source like SharePoint
2. **The platform processes them** -- Documents are broken into meaningful chunks, analyzed, and converted into a searchable format
3. **Your agent searches at runtime** -- When a customer asks a question, the agent searches the knowledge base for relevant information and uses it to generate an accurate response

This is called Retrieval-Augmented Generation (RAG). The agent retrieves relevant information and uses it to augment its response -- grounding the answer in your actual data instead of relying on the LLM's general knowledge.

### Why Hybrid Search Is the Default

Agent Platform uses **hybrid search** as the default strategy, combining two complementary approaches:

**Semantic search** finds content that is conceptually related to the question, even when the exact words are different. If a customer asks "How do I get my money back?", semantic search finds your document about "Refund Policy and Procedures" -- even though the words do not match.

**Keyword search** finds content containing the exact terms in the question. This catches specific product names, policy numbers, and technical terms that semantic search might miss. If a customer asks about "Policy XR-2847", keyword search finds the exact document.

> **Key Concept**: Hybrid search is the default because neither semantic nor keyword search alone is sufficient. Semantic search catches conceptual matches; keyword search catches exact terms. Together, they cover the full range of how customers ask questions -- from vague ("how do I return this?") to specific ("order #12345 refund status").

### What Affects Answer Quality

Three factors determine how well your knowledge base performs:

1. **Document quality** -- Clean, well-structured documents with clear headings produce better results than scanned images without OCR or documents with inconsistent formatting.

2. **Chunking configuration** -- How documents are split into searchable pieces. Smaller chunks (100-200 tokens) give precise answers for FAQ-style content. Larger chunks (500-1000 tokens) provide more context for narrative content.

3. **Query quality** -- How the agent formulates its search. Agents using reasoning can reformulate queries when initial results are not relevant. Scripted agents search with the exact query defined in their flow.

## Deployment Options

Agent Platform offers two deployment models to accommodate different organizational needs.

### Cloud-Hosted (Default)

The simplest option. Agent Platform manages all infrastructure -- servers, databases, scaling, security updates. You focus on building agents.

**Best for:** Teams that want to get started quickly, do not have strict data residency requirements, and prefer not to manage infrastructure.

### Self-Hosted

Deploy the entire platform on your own infrastructure for full control over data residency, security, and scaling.

**Best for:** Organizations with regulatory requirements (data must stay in a specific region), strict security policies (no external cloud access), or enterprise-scale deployments that need custom infrastructure.

> **Key Concept**: Self-hosted deployment is a real option -- Agent Platform is designed to run on your infrastructure. The platform requires MongoDB (for persistent data) and Redis (for session state and job queues). These are the only mandatory infrastructure dependencies. ClickHouse (analytics) and Kafka (event streaming) are optional.

### What Self-Hosted Gives You

- **Data residency control** -- All data stays on your infrastructure, in your chosen region
- **Network isolation** -- No outbound connections except to LLM providers
- **Custom scaling** -- Scale Runtime and SearchAI independently based on load
- **Security policy compliance** -- Apply your organization's security standards directly
- **Encryption key ownership** -- Enterprise plans support bring-your-own-key (BYOK) encryption

## Putting It All Together: Choosing Your Architecture

Here is a decision framework for choosing your agent architecture:

**Start simple.** If you have one service area and straightforward conversations, a single reasoning agent is all you need.

**Add structure when needed.** If you have regulated processes with specific steps (returns, claims, bookings), add scripted flows to those agents.

**Add a supervisor when you have multiple domains.** Once you have 3+ specialist areas with different tools, knowledge bases, or compliance rules, a supervisor provides clean routing and keeps each specialist focused.

**Add delegation and fan-out as optimization.** Once your multi-agent system is working, delegation and fan-out improve the experience by handling background tasks and parallel searches efficiently.

### A Practical Example

An insurance company might evolve their agent architecture like this:

1. **Month 1:** Single reasoning agent for general Q&A about policies
2. **Month 2:** Add a scripted agent for claims intake (regulated process)
3. **Month 3:** Add a supervisor to route between Q&A, claims, billing, and account changes
4. **Month 4:** Add delegation so the claims agent can run background risk assessment
5. **Month 5:** Add fan-out so the policy agent can search multiple knowledge bases in parallel

Each step adds capability without disrupting what already works.

## Key Takeaways

- Delegation handles transparent sub-tasks (the customer never sees it) -- use it for behind-the-scenes calculations, lookups, and compliance checks
- Fan-out runs parallel searches across multiple agents simultaneously -- use it when independent lookups would be too slow sequentially
- Hybrid search (semantic + keyword) is the default knowledge base strategy because it covers both conceptual and exact-match queries
- Self-hosted deployment is fully supported, requiring MongoDB and Redis as the minimum infrastructure
- Supervisors are justified for multi-domain routing where different areas need specialized agents with different tools and compliance rules

## What's Next

Explore the [Agent Patterns](../agent-patterns/content.md) module for a detailed look at when to use scripted vs. reasoning vs. supervisor agents, or the [Channel Architecture](../channel-architecture/content.md) module to understand how agents connect to messaging platforms.
