---
name: abl-architect
description: Use when the user asks to "design", "architect", "plan", or "build" agents, workflows, tools, or multi-agent systems. Also use when they ask "how do I integrate", "should I use", "when to use", "best practices", "how do components work together", or mention ABL concepts like AGENT, SUPERVISOR, FLOW, TOOLS, GATHER, HANDOFF, DELEGATE, reasoning mode, scripted mode, knowledge base integration, memory management, constraints, or guardrails. Provides comprehensive architectural guidance across all ABL platform components.
---

# ABL Architect

Comprehensive architectural guidance for building agents, integrating components, and making design decisions in the Agent Blueprint Language (ABL) platform.

> **Quick references:**
>
> - Core design: `/docs/AGENT_ABL_DESIGN.md`
> - IR Schema: `/packages/compiler/src/platform/ir/schema.ts` (1,813 lines, source of truth)
> - Flow mode: `/docs/FLOW_MODE_DESIGN.md`
> - SearchAI: Use `search-ai-architect` and `search-ai-development` skills

---

## Product Overview

### What is the ABL Platform?

**The ABL Platform** is an enterprise platform for building, deploying, and managing AI agents using the **Agent Blueprint Language (ABL)** - a declarative DSL for creating conversational AI agents with deterministic, auditable behavior.

**Domain:** Conversational AI + Business Process Automation

**Core Value:** Bridge the gap between rigid rule engines (too inflexible) and pure LLM systems (too unpredictable) by combining DSL-based specification with LLM reasoning where needed.

### What Problems Does This Platform Solve?

**Problem Domain:** Enterprises need AI agents that are:

- **Predictable** (not random LLM behavior)
- **Auditable** (traceable for compliance)
- **Scalable** (multi-agent orchestration)
- **Integrated** (connect to existing systems)
- **Maintainable** (declarative, not spaghetti code)

#### Problem 1: Unpredictable LLM Behavior

**Challenge:** Pure LLM-based chatbots are non-deterministic, making them unsuitable for compliance-critical workflows (banking, healthcare, insurance).

**ABL Solution:**

- DSL-based specification (explicit flow definitions)
- Constraints (pre-execution validation)
- Guardrails (post-execution output validation)
- Dual execution modes (reasoning for flexibility, scripted for determinism)

**Result:** Developers control exactly when LLM makes decisions vs. when logic is deterministic.

#### Problem 2: Lack of Auditability

**Challenge:** Black-box LLM systems can't explain why they took actions, failing SOC2/PCI/GDPR audits.

**ABL Solution:**

- IR-first architecture (compiled AgentIR is human-readable)
- Trace events for every action (ClickHouse analytics)
- Span trees showing execution flow
- Decision explanations (why agent chose X over Y)

**Result:** Full audit trail from user input → agent decision → tool call → response.

#### Problem 3: Complex Multi-Agent Systems

**Challenge:** Single monolithic agents become unmaintainable at scale (100+ steps, multiple domains).

**ABL Solution:**

- SUPERVISOR pattern (route to specialized agents)
- HANDOFF with context passing (share state across agents)
- DELEGATE for reusable sub-agents
- Composition over nesting (small focused agents)

**Result:** Banking app routes to balance, transfer, support agents - each independently deployable.

#### Problem 4: Tool Integration Complexity

**Challenge:** Each external API requires custom code (OAuth, retries, error handling, caching).

**ABL Solution:**

- 6 unified tool types (HTTP, MCP, Connector, Workflow, Sandbox, Search)
- Context auto-injection (session vars → tool params)
- Circuit breakers & caching (built-in)
- Result binding (tool output → session vars)

**Result:** Declare tool in DSL, runtime handles invocation, error handling, retries.

#### Problem 5: Knowledge Management at Scale

**Challenge:** Ingesting 1M+ documents, keeping them updated, retrieving relevant context <500ms.

**ABL Solution:**

- SearchAI with ATLAS-KG chunking (zero-overlap, tree-based)
- 17 parallel workers for ingestion
- Hybrid retrieval (vector + BM25 + RRF)
- Permission filtering (user-mode access control)

**Result:** Agents query knowledge base as a tool (`search_kb`), integrated like any other tool.

#### Problem 6: Compliance Requirements

**Challenge:** PCI-DSS, GDPR, HIPAA require tenant isolation, encryption, right to erasure, audit logs.

**ABL Solution:**

- Tenant isolation (every query scoped to `tenantId`)
- Encryption at rest (AES-256) and in transit (TLS 1.3)
- Right to erasure (cascade deletes)
- Audit logging (ClickHouse for all actions)

**Result:** Platform is SOC2/PCI/GDPR/HIPAA ready out of the box.

### Who Uses This Platform?

| User Type                  | What They Build                | Components Used                      |
| -------------------------- | ------------------------------ | ------------------------------------ |
| **Conversation Designers** | Multi-turn conversations, FAQs | FLOW, GATHER, RESPOND                |
| **Agent Developers**       | Business logic, integrations   | AGENT, TOOLS, CONSTRAINTS            |
| **System Architects**      | Multi-agent orchestration      | SUPERVISOR, HANDOFF, DELEGATE        |
| **Integration Engineers**  | External system connections    | HTTP tools, Connectors, Workflows    |
| **Knowledge Managers**     | Document ingestion, retrieval  | SearchAI, Connectors                 |
| **Compliance Officers**    | Audit trails, guardrails       | CONSTRAINTS, GUARDRAILS, Observatory |

### What Does the Platform Offer?

The platform provides **7 major functional components** that solve these problems:

| Component                     | What It Offers                             | Problem It Solves                       |
| ----------------------------- | ------------------------------------------ | --------------------------------------- |
| **Agent Language & Compiler** | DSL for defining agents, compilation to IR | Unpredictable behavior (explicit specs) |
| **Runtime Execution**         | Dual-mode execution (reasoning + scripted) | Flexibility vs. determinism trade-off   |
| **Knowledge Base (SearchAI)** | Document ingestion, hybrid retrieval       | Knowledge management at scale           |
| **Tools & Integrations**      | 6 tool types with unified interface        | Tool integration complexity             |
| **Memory & State**            | Session, persistent, lookup tables         | State management across conversations   |
| **Multi-Agent Coordination**  | SUPERVISOR, HANDOFF, DELEGATE              | Complex multi-agent systems             |
| **Studio & Observability**    | Visual IDE, trace events, analytics        | Auditability, debugging, monitoring     |

### Platform Components & Responsibilities

The platform has **7 major components** that work together:

#### 1. **Agent Language & Compiler**

**What it does:** Defines and compiles agent behavior

- **ABL DSL** (`packages/core`): Declarative language for agents, flows, tools
- **Compiler** (`packages/compiler`): Transforms DSL → AgentIR (intermediate representation)
- **AgentIR** (`schema.ts`, 1,813 lines): Framework-agnostic specification (source of truth)

**Builds:** Agent definitions (AGENT, SUPERVISOR), flows (FLOW), tools, constraints

#### 2. **Runtime Execution**

**What it does:** Executes compiled agents in production

- **Runtime Executor** (`apps/runtime`): Session orchestration, LLM calls, tool invocation
- **Reasoning Executor**: LLM-driven agentic loop (observe → think → act)
- **Flow Executor**: Scripted state machine (deterministic transitions)
- **Constraint Checker**: Pre/post-execution validation

**Integrates with:** Agents (executes them), Tools (invokes them), Memory (reads/writes), Knowledge (queries)

#### 3. **Knowledge Base (SearchAI)**

**What it does:** Stores and retrieves documents to augment agent responses

- **Ingestion** (`apps/search-ai`): 17 workers for document processing, chunking (ATLAS-KG), embedding
- **Query Runtime** (`apps/search-ai-runtime`): Hybrid retrieval (vector + BM25), <500ms latency
- **Storage**: OpenSearch (vectors), MongoDB (metadata), Redis (cache)

**Integrates with:** Agents (via search_kb tool), Tools (as a tool type), Connectors (document sources)

#### 4. **Tools & Integrations**

**What it does:** Enables agents to call external systems

- **Tool Types**: HTTP (REST), MCP (Model Context Protocol), Connector (Kore platform), Workflow (Restate), Sandbox (code execution), Search (knowledge retrieval)
- **Tool Framework** (`packages/compiler/ir/schema.ts`): Unified ToolDefinition interface
- **Context Injection**: Auto-pass session vars to tools

**Integrates with:** Agents (declares tools), Runtime (executes tools), Connectors (provides APIs)

#### 5. **Memory & State Management**

**What it does:** Maintains conversation context and persistent data

- **Session Memory** (Redis): Current conversation state (gathered fields, tool results, variables)
- **Persistent Memory** (MongoDB): Cross-session data (user preferences, account info)
- **Lookup Tables** (MongoDB): Reference data (product catalog, rates)
- **Context Memory**: LLM context window (conversation history)

**Integrates with:** Agents (reads/writes memory), Tools (reads context for auto-injection), Flows (SET/CLEAR operations)

#### 6. **Multi-Agent Coordination**

**What it does:** Orchestrates multiple agents for complex workflows

- **SUPERVISOR**: Routes requests to specialized agents
- **HANDOFF**: Transfers control with context passing
- **DELEGATE**: Invokes sub-agents synchronously
- **Context Passing**: Pass variables, summaries between agents

**Integrates with:** Agents (routes between them), Runtime (manages handoffs), Memory (shares context)

#### 7. **Studio & Observability**

**What it does:** Development environment and debugging

- **Studio** (`apps/studio`): Web IDE (Monaco editor, flow visualization, test runner)
- **Observatory** (`packages/observatory`): Real-time trace events, span trees, decision explanations
- **Admin** (`apps/admin`): User management, billing, analytics

**Integrates with:** Compiler (validates DSL), Runtime (receives traces), Agents (visualizes flows)

### Key Integration Questions Answered

**Q: How do we integrate knowledge base with agents?**
**A:** Knowledge base (SearchAI) is integrated **as a tool** (`search_kb`). Agents declare it in TOOLS, runtime invokes it like any other tool.

**Q: Does knowledge become a tool?**
**A:** Yes. This provides:

- Uniform interface with other tools
- Circuit breaker protection
- Trace events for debugging
- Consistent error handling
- Result binding to session vars

**Q: How do agents use workflows?**
**A:** Workflows (Restate/Temporal) are integrated **as a tool type** (`workflow_binding`). Agents call long-running workflows like any tool, with result binding.

**Q: How do tools access session context?**
**A:** Tools declare **context access** in their definition:

```typescript
tool_context: {
  read: [customer_id, account_tier]; // Auto-injected into tool params
  write: [booking_id]; // Tool can update session vars
}
```

**Q: How do multiple agents share state?**
**A:** SUPERVISOR passes context via HANDOFF:

```abl
HANDOFF:
  TO: Sub_Agent
  CONTEXT:
    pass: [customer_id, order_id]  # Sent to sub-agent
  RETURN: true                     # Wait for result
  ON_RETURN: resume_step           # Continue with result
```

**Q: How do flows integrate with reasoning?**
**A:** Per-step zones let FLOW steps delegate to reasoning:

```abl
FLOW: booking_flow
  search_step:
    REASONING: true   # LLM decides tools, iterates
  confirm_step:
    REASONING: false  # Scripted, deterministic
```

### Component Integration Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ABL Platform Stack                    │
└─────────────────────────────────────────────────────────┘

DSL Source (.abl)
    ↓
Parser → AST → Compiler → AgentIR
    ↓
┌───────────────────────────────────────────────────┐
│                Runtime Execution                  │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────┐ │
│  │  Reasoning  │  │    Flow     │  │  Super-  │ │
│  │  Executor   │  │  Executor   │  │  visor   │ │
│  └──────┬──────┘  └──────┬──────┘  └────┬─────┘ │
│         │                │                │       │
│         └────────────────┴────────────────┘       │
│                        ↓                          │
│         ┌──────────────────────────────┐          │
│         │    Tool Invocation Layer    │          │
│         └──────────────────────────────┘          │
│                        ↓                          │
│  ┌──────┬─────┬─────┬─────────┬────────┬──────┐ │
│  │ HTTP │ MCP │ Con │ Work-   │ Sand-  │Search│ │
│  │      │     │nect │ flow    │ box    │  KB  │ │
│  └──────┴─────┴─────┴─────────┴────────┴──────┘ │
└───────────────────────────────────────────────────┘
         ↓              ↓                ↓
    External APIs   Connectors     SearchAI
                                       ↓
                                   OpenSearch
                                   (Vectors)

Memory Layer (Redis + MongoDB)
- Session state (current conversation)
- Persistent memory (cross-session)
- Lookup tables (reference data)

Observability (Observatory + ClickHouse)
- Trace events (every action)
- Span trees (execution flow)
- Analytics (usage, cost, performance)
```

### How Components Work Together - Example Flows

**Example 1: Support Agent with Knowledge Fallback**

```
1. User: "How do I reset my password?"
   ↓
2. Runtime → Agent (Support_Agent)
   ↓
3. Agent Flow Step: search_knowledge
   ↓
4. Runtime → Tool Invocation Layer → SearchAI
   ↓
5. SearchAI → Query Engine → OpenSearch (vector search)
   ↓
6. Result → Runtime → Agent (result binding: kb_results)
   ↓
7. Agent Flow: ON_RESULT branch
   - IF kb_results.confidence > 0.7 → RESPOND with summary
   - ELSE → CALL create_ticket tool
   ↓
8. Runtime → User: Response
```

**Example 2: Multi-Agent Order Processing**

```
1. User: "I want to check my order status"
   ↓
2. Runtime → Supervisor (Order_Management)
   ↓
3. Supervisor: HANDOFF routing
   - Intent: "check_order" → TO: Order_Status_Agent
   ↓
4. Runtime → Create new agent thread
   - Context passed: {customer_id, order_id}
   ↓
5. Order_Status_Agent → CALL get_order_status tool
   ↓
6. Tool Invocation → HTTP binding → External API
   ↓
7. Result → Order_Status_Agent → RESPOND
   ↓
8. Agent completes → RETURN to Supervisor (if RETURN: true)
   ↓
9. Supervisor → ON_RETURN: update_session_state
   ↓
10. Supervisor → User: Aggregate response
```

---

## Core Architecture Principles

### 1. IR-First Design

```
ABL Source (.abl)
    ↓ Parser (@abl/core)
AST (Abstract Syntax Tree)
    ↓ Compiler (@abl/compiler)
AgentIR (Intermediate Representation)
    ↓ Runtime (@agent-platform/runtime)
Execution (Reasoning/Flow/Supervisor)
```

**Key Rules:**

- AgentIR is the single source of truth
- All runtimes consume IR (framework-agnostic)
- No runtime-specific logic in DSL
- IR is versioned, backward-compatible
- Compiled IR can be cached, deployed independently

### 2. Dual Execution Model

**Reasoning Mode** (LLM-Driven):

- Agent decides which tools to call
- Iterative loop: observe → think → act → reflect
- Constraints checked at runtime
- Use when: flexibility, natural conversation, complex decision-making

**Scripted Mode** (State Machine):

- Deterministic FLOW with explicit steps
- Developer controls transition logic (THEN, ON_RESULT, ON_INPUT)
- Use when: compliance-critical, cost-sensitive, predictable paths

**Modern Approach: Per-Step Zones**

```abl
FLOW: booking_flow
  search_step:
    REASONING: true    # LLM decides tools, iterates
    THEN: confirm_step

  confirm_step:
    REASONING: false   # Scripted, deterministic
    GATHER: confirmation
    THEN: complete
```

### 3. Composition Over Nesting

**Don't:** Create monolithic agents with deeply nested flows

**Do:** Compose small agents via SUPERVISOR routing

```abl
AGENT: CustomerService_Supervisor
  HANDOFF:
    - TO: Account_Balance WHEN: "intent == 'balance'"
    - TO: Fund_Transfer WHEN: "intent == 'transfer'"
    - TO: Support_Escalation WHEN: "intent == 'speak_to_agent'"
```

**Benefits:**

- Each agent is independently testable
- Clear separation of concerns
- Parallel development
- Incremental deployment

### 4. Knowledge as a Tool

SearchAI knowledge base is invoked as a tool, not a special construct:

```abl
AGENT: Support_Agent
  TOOLS:
    - search_kb    # SearchAI retrieval
    - create_ticket
    - send_email

  FLOW: support_flow
    search_step:
      CALL: search_kb(query=user_input)
      AS: search_results
      ON_RESULT:
        - IF: "search_results.count > 0"
          RESPOND: "{{search_results.summary}}"
          THEN: complete
        - ELSE:
          THEN: escalate
```

**Benefits:**

- Uniform tool interface (HTTP, MCP, Knowledge, Workflow)
- Circuit breakers apply to all tools equally
- Trace events capture all tool calls consistently

---

## Component Responsibilities

### 1. AGENTS

**Responsibility:** Execute a single goal or conversation

**Types:**

- `AGENT`: Single-purpose agent (reasoning or flow)
- `SUPERVISOR`: Routes to sub-agents, handles delegation

**Key Capabilities:**

- Gather information (multi-field extraction)
- Call tools (HTTP, MCP, Workflow, Connector)
- Maintain session memory (gathered fields, variables)
- Apply constraints and guardrails
- Handle errors and digressions

**When to create an agent:**

- Single domain/use case (account balance, booking, support)
- Clear entry/exit conditions
- 3-10 FLOW steps (not 50+ steps)
- Independently testable

**File location:** `packages/compiler/src/platform/ir/schema.ts` (AgentIR interface)

---

### 2. TOOLS

**Responsibility:** Execute external actions or retrieve data

**Tool Types:**

| Type          | Use Case                         | Example                                |
| ------------- | -------------------------------- | -------------------------------------- |
| **http**      | REST endpoints                   | Stripe payment, Salesforce API         |
| **mcp**       | Model Context Protocol servers   | Claude Code tools, custom integrations |
| **sandbox**   | JavaScript/Python execution      | Data transformation, calculation       |
| **connector** | Kore platform integrations       | SAP, Salesforce, ServiceNow            |
| **workflow**  | Long-running processes (Restate) | Order fulfillment, approval chains     |
| **search**    | Knowledge retrieval (SearchAI)   | Document search, FAQ lookup            |

**Tool Definition:**

```typescript
interface ToolDefinition {
  name: string;
  description: string; // LLM uses this to decide when to call
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: {
    cacheable: boolean;
    latency: 'low' | 'medium' | 'high';
    parallelizable: boolean;
    side_effects: boolean;
    requires_auth: boolean;
  };
  http_binding?: HttpBindingIR; // REST endpoint
  mcp_binding?: McpBindingIR; // MCP server
  connector_binding?: ConnectorBindingIR;
  workflow_binding?: WorkflowBindingIR;
}
```

**Context Auto-Injection:**
Tools can access session variables automatically:

```abl
TOOL: book_hotel
  PARAMETERS:
    - hotel_id: string
    - customer_id: string FROM CONTEXT  # Auto-injected
  CONTEXT:
    read: [customer_id, account_tier]
    write: [booking_id]
```

**When to use each type:**

- **http:** External APIs you don't control
- **mcp:** Custom tools with credential management
- **sandbox:** Pure computation (no external calls)
- **connector:** Kore-certified integrations (OAuth built-in)
- **workflow:** Multi-step processes that outlive session
- **search:** Document retrieval, FAQ, knowledge lookup

**File location:** `packages/compiler/src/platform/ir/schema.ts` (ToolDefinition)

### Tool Compaction Configuration

When designing tools that return large result sets (product search, CRM lookup, etc.), configure compaction hints:

```yaml
TOOLS:
  product_search:
    compaction:
      essential_fields: [id, title, brand, price, color, size, description, product_image]
      max_description_length: 200
```

This tells the runtime which fields to preserve during structured compression. Without this, the runtime keeps all fields and only applies character-cap truncation.

Available at agent level: `EXECUTION.compaction.tool_results.strategy` (none/truncate/structured/summarize)

---

### 3. WORKFLOWS/FLOWS

**Responsibility:** Orchestrate steps, tools, and transitions

**FLOW Structure:**

```abl
FLOW: booking_flow
  entry_point: collect_destination
  steps:
    - collect_destination
    - search_hotels
    - select_hotel
    - confirm_booking

  definitions:
    collect_destination:
      GATHER:
        - destination: string
        - checkin: date
        - checkout: date
      THEN: search_hotels

    search_hotels:
      CALL: search_hotels
      CALL_WITH:
        destination: "{{destination}}"
      AS: hotel_results
      ON_RESULT:
        - IF: "hotel_results.length > 0"
          THEN: select_hotel
        - ELSE:
          RESPOND: "No availability"
          THEN: complete
```

**Flow Capabilities:**

| Feature               | Use Case                                       |
| --------------------- | ---------------------------------------------- |
| **GATHER**            | Multi-field LLM extraction with validation     |
| **CALL/CALL_WITH/AS** | Explicit tool invocation + result binding      |
| **SET/CLEAR**         | Variable manipulation (35+ built-in functions) |
| **TRANSFORM**         | Array pipeline (FILTER→MAP→SORT→LIMIT)         |
| **ON_RESULT**         | Multi-way conditional branching                |
| **ON_INPUT**          | User intent-based routing                      |
| **Digressions**       | Global escape paths (e.g., "cancel anytime")   |
| **ON_ERROR**          | Error recovery strategies                      |
| **REASONING**         | Per-step LLM delegation                        |

**When to use FLOW:**

- Compliance-critical paths (must be deterministic)
- Cost-sensitive (minimize LLM calls)
- Predictable user journey (booking, onboarding)
- Need explicit control over transitions

**When to use REASONING:**

- Open-ended conversation
- Complex decision-making
- User behavior unpredictable
- Flexibility more important than cost

**File location:** `/docs/FLOW_MODE_DESIGN.md`

---

### 4. KNOWLEDGE BASE (SearchAI)

**Responsibility:** Store, retrieve, and surface relevant documents

**Architecture:**

```
Documents (source)
    ↓ Ingestion Pipeline (17 workers)
Chunks (semantic units)
    ↓ ATLAS-KG algorithm
Vector Embeddings (BGE-M3, Anthropic, Gemini)
    ↓ Indexing
OpenSearch (vector + BM25)
    ↓ Query Pipeline (<500ms)
Retrieved Context (to agent)
```

**Integration with Agents:**

**Pattern 1: Knowledge as First-Class Tool**

```abl
AGENT: FAQ_Agent
  TOOLS:
    - search_kb

  FLOW: faq_flow
    search:
      CALL: search_kb(query=user_input)
      AS: results
      ON_RESULT:
        - IF: "results.count > 0"
          RESPOND: "{{results.summary}}"
          THEN: complete
        - ELSE:
          RESPOND: "I don't have that information."
          THEN: complete
```

**Pattern 2: Hybrid (Knowledge + Action)**

```abl
AGENT: Support_Agent
  TOOLS:
    - search_kb
    - create_ticket
    - escalate_to_human

  REASONING: true  # LLM decides: search first or create ticket?
```

**Pattern 3: Fallback Chain**

```abl
FLOW: smart_support
  search_step:
    CALL: search_kb(query=user_input)
    AS: kb_results
    ON_RESULT:
      - IF: "kb_results.confidence > 0.8"
        RESPOND: "{{kb_results.summary}}"
        THEN: complete
      - ELSE:
        THEN: api_search

  api_search:
    CALL: external_api(query=user_input)
    AS: api_results
    ON_RESULT:
      - IF: "api_results.found"
        RESPOND: "{{api_results.answer}}"
        THEN: complete
      - ELSE:
        THEN: escalate
```

**SearchAI Features:**

- **Tenant isolation:** Each tenant has scoped index
- **Permission filtering:** User-mode applies row-level security
- **Hybrid search:** Dense vectors + BM25 + RRF reranking
- **Caching:** Redis-backed, 1-hour TTL
- **Real-time:** <500ms p95 latency

**When to use SearchAI:**

- FAQ/documentation retrieval
- Policy/compliance document lookup
- Historical context (past conversations, tickets)
- Product catalog search
- Internal knowledge bases

**File location:** `/docs/searchai/00-START-HERE.md`

---

### 5. MEMORY

**Responsibility:** Maintain state across messages and sessions

**Memory Types:**

| Type                  | Scope               | Persistence      | Use Case                                 |
| --------------------- | ------------------- | ---------------- | ---------------------------------------- |
| **Session Memory**    | Single conversation | Redis + MongoDB  | Gathered fields, tool results, variables |
| **Persistent Memory** | Cross-session       | MongoDB with TTL | User preferences, account data           |
| **Context Memory**    | Per-step            | Ephemeral        | LLM context window                       |
| **Lookup Tables**     | Global              | MongoDB          | Reference data (product catalog, rates)  |

**Session Memory:**

```abl
FLOW: booking_flow
  collect:
    GATHER:
      - destination: string
      - checkin: date
    SET:
      nights = DAYS_BETWEEN(checkin, checkout)
      total_cost = nights * room_rate
    # destination, checkin, nights, total_cost stored in session memory
```

**Persistent Memory:**

```abl
AGENT: Personalized_Agent
  MEMORY:
    PERSISTENT:
      - user.name
      - user.preferences.language
      - account.tier

    RECALL:
      ON_START:
        WHEN: "true"
        VARS: [user.name, account.tier]
        SOURCE: lookup_table

  # On agent start, fetch persistent vars from storage
```

**Lookup Tables:**

```abl
LOOKUP_TABLE: product_catalog
  KEY: product_id
  FIELDS:
    - name
    - price
    - stock
  SOURCE: mongodb://products

FLOW: purchase_flow
  lookup_step:
    SET:
      product = LOOKUP("product_catalog", product_id)
      price = product.price
```

**Memory Best Practices:**

- Use session memory for transient data (current conversation)
- Use persistent memory for user profile, preferences
- Set TTLs on persistent memory (30/60/90 days)
- Don't store sensitive data long-term (PII, credentials)
- Clear memory on COMPLETE (explicit cleanup)

**File location:** `/packages/compiler/src/platform/ir/schema.ts` (MemoryConfig)

---

### 6. CONSTRAINTS & GUARDRAILS

**Responsibility:** Enforce safety, compliance, and business rules

**Three-Layer Protection:**

| Layer           | When           | Action                                          |
| --------------- | -------------- | ----------------------------------------------- |
| **LIMITATIONS** | Always         | Embedded in LLM system prompt (hard boundaries) |
| **CONSTRAINTS** | Pre-execution  | Block/escalate/respond before LLM/tool call     |
| **GUARDRAILS**  | Post-execution | Validate LLM output, prevent unsafe responses   |

**Limitations (System Prompt):**

```abl
AGENT: Bank_Agent
  LIMITATIONS:
    - "Never access other customers' account data"
    - "Cannot override fraud detection policies"
    - "Must comply with PCI-DSS requirements"
```

**Constraints (Pre-Execution):**

```abl
CONSTRAINTS:
  pre_gather:
    - rule: "account.balance >= 0"
      on_fail:
        action: respond
        message: "Account overdrawn. Cannot proceed."

  pre_tool:
    - rule: "transfer_amount <= account.balance"
      on_fail:
        action: block
        message: "Insufficient funds"
```

**Guardrails (Post-Execution):**

```abl
GUARDRAILS:
  output:
    - rule: "NOT CONTAINS(response, 'credit_card_number')"
      on_fail:
        action: block
        message: "Response blocked: contains PII"

    - rule: "response.length <= 500"
      on_fail:
        action: warn
        message: "Response exceeds length limit"
```

**When to use each:**

- **Limitations:** Immutable policies (regulatory, security)
- **Constraints:** Business rules (balance check, permissions)
- **Guardrails:** Output safety (PII detection, toxic content)

**File location:** `/docs/CONSTRAINTS.md`

---

### 7. MULTI-AGENT COORDINATION

**Responsibility:** Route requests, delegate tasks, aggregate results

**Patterns:**

**Pattern 1: SUPERVISOR (Routing)**

```abl
AGENT: BankNexus_Supervisor
  HANDOFF:
    - TO: Get_Balance
      WHEN: "intent == 'check_balance'"
      CONTEXT:
        pass: [customer_id, account_number]
      RETURN: true
      ON_RETURN: resume_conversation

    - TO: Fund_Transfer
      WHEN: "intent == 'transfer'"
      CONTEXT:
        pass: [customer_id, account_number]
      RETURN: true

    - TO: Human_Agent
      WHEN: "intent == 'escalate'"
      CONTEXT:
        summary: "Customer needs assistance"
      RETURN: false  # Transfer control permanently
```

**Pattern 2: DELEGATE (Sub-Agent)**

```abl
FLOW: complex_booking
  validate_user:
    DELEGATE: User_Validation_Agent
    WITH:
      user_id: "{{user_id}}"
    AS: validation_result
    ON_RETURN:
      - IF: "validation_result.valid"
        THEN: search_hotels
      - ELSE:
        RESPOND: "Validation failed"
        THEN: complete
```

**Pattern 3: PARALLEL DELEGATION**

```abl
FLOW: multi_search
  parallel_search:
    PARALLEL:
      - DELEGATE: Search_Hotels WITH: {destination}
      - DELEGATE: Search_Flights WITH: {destination}
      - DELEGATE: Search_Cars WITH: {destination}
    AGGREGATE: search_results
    THEN: present_options
```

**Handoff Context Passing:**

```abl
HANDOFF:
  TO: Agent_B
  CONTEXT:
    pass: [customer_id, session_id, intent]
    summary: "User wants to transfer $500"
  RETURN: true
  ON_RETURN: resume_step
```

**When to use:**

- **SUPERVISOR:** Multiple distinct use cases (routing hub)
- **DELEGATE:** Reusable sub-tasks (validation, calculation)
- **PARALLEL:** Independent operations (search, enrichment)

**File location:** `/docs/AGENT_ABL_DESIGN.md` (Multi-Agent section)

---

## Integration Patterns

### Pattern 1: Agent + Tools + Knowledge

**Use Case:** Support agent with knowledge base fallback

```abl
AGENT: Smart_Support_Agent
  TOOLS:
    - search_kb
    - create_ticket
    - escalate_to_human

  FLOW: support_flow
    understand:
      GATHER:
        - issue_description: string
      THEN: search_knowledge

    search_knowledge:
      CALL: search_kb
      CALL_WITH:
        query: "{{issue_description}}"
      AS: kb_results
      ON_RESULT:
        - IF: "kb_results.confidence > 0.7"
          RESPOND: "{{kb_results.summary}}"
          THEN: ask_satisfaction
        - ELSE:
          THEN: create_ticket_step

    create_ticket_step:
      CALL: create_ticket
      CALL_WITH:
        description: "{{issue_description}}"
      AS: ticket
      RESPOND: "Ticket created: {{ticket.id}}"
      THEN: complete
```

**Key Points:**

- Knowledge base queried first (cheaper, faster)
- Fallback to action tools (create ticket)
- Clear branching logic

---

### Pattern 2: Flow + Reasoning Zones

**Use Case:** Booking flow with flexible negotiation step

```abl
FLOW: travel_booking
  collect_requirements:
    REASONING: false  # Scripted
    GATHER:
      - destination: string
      - budget: number
    THEN: search_options

  search_options:
    REASONING: true   # LLM decides which tools to call
    INSTRUCTIONS: "Search for hotels and flights within budget. Negotiate if needed."
    THEN: confirm_booking

  confirm_booking:
    REASONING: false  # Scripted
    GATHER:
      - confirmation: boolean
    ON_INPUT:
      - IF: "confirmation == true"
        THEN: book
      - ELSE:
        THEN: cancel
```

**Key Points:**

- Critical steps (collect, confirm) are scripted
- Flexible step (search, negotiate) uses reasoning
- Best of both worlds: control + flexibility

---

### Pattern 3: Supervisor + Context Aggregation

**Use Case:** Multi-agent system with shared context

```abl
AGENT: Order_Management_Supervisor
  MEMORY:
    SESSION:
      - order_id
      - customer_id
      - order_status

  HANDOFF:
    - TO: Check_Inventory
      WHEN: "intent == 'check_stock'"
      CONTEXT:
        pass: [order_id, customer_id]
      RETURN: true
      ON_RETURN: update_order_status

    - TO: Process_Payment
      WHEN: "intent == 'pay'"
      CONTEXT:
        pass: [order_id, customer_id]
      RETURN: true
      ON_RETURN: update_order_status

  FLOW: supervisor_flow
    route:
      ON_INPUT:
        - default handoffs apply

    update_order_status:
      SET:
        order_status = COALESCE(handoff_result.status, "unknown")
      THEN: route
```

**Key Points:**

- Supervisor maintains shared context (order_id, customer_id)
- Sub-agents return results to supervisor
- Supervisor aggregates and updates state

---

### Pattern 4: Knowledge + Behavior Profiles

**Use Case:** VIP vs standard customer experience

```abl
AGENT: Customer_Service_Agent
  TOOLS:
    - search_kb
    - book_appointment

  BEHAVIOR_PROFILES:
    - name: vip_mode
      when: "account.tier == 'VIP'"
      instructions: "Offer premium options and expedited service"
      response_rules:
        max_buttons: 10
        tone: "formal"

    - name: standard_mode
      when: "account.tier == 'standard'"
      instructions: "Offer standard options"
      response_rules:
        max_buttons: 3
        tone: "friendly"

  FLOW: service_flow
    search:
      CALL: search_kb(query=user_input)
      AS: results
      RESPOND: "{{results.summary}}"
      # Response style automatically adapted based on active profile
```

**Key Points:**

- Knowledge base is shared
- Presentation varies by customer tier
- Single agent, multiple behaviors

---

## Design Decision Guide

### When to Use Reasoning vs Flow?

| Criteria                    | Reasoning                           | Flow |
| --------------------------- | ----------------------------------- | ---- |
| **Compliance-critical**     | ❌                                  | ✅   |
| **Cost-sensitive**          | ❌                                  | ✅   |
| **Open-ended conversation** | ✅                                  | ❌   |
| **Complex decision-making** | ✅                                  | ❌   |
| **Predictable path**        | ❌                                  | ✅   |
| **Auditability**            | ⚠️ (requires careful prompt design) | ✅   |
| **Flexibility**             | ✅                                  | ❌   |

**Best Practice:** Use per-step reasoning zones in FLOW for hybrid approach

---

### When to Create a New Agent vs Extend Existing?

| Scenario                      | New Agent     | Extend Existing       |
| ----------------------------- | ------------- | --------------------- |
| **Different domain**          | ✅            | ❌                    |
| **Different goal**            | ✅            | ❌                    |
| **Reusable sub-task**         | ✅ (delegate) | ❌                    |
| **Minor variation**           | ❌            | ✅ (behavior profile) |
| **Same flow, different data** | ❌            | ✅ (parameters)       |
| **Agent >20 steps**           | ✅ (split)    | ❌                    |

---

### When to Use Which Tool Type?

| Need                           | Tool Type | Reason                                    |
| ------------------------------ | --------- | ----------------------------------------- |
| **External REST API**          | http      | Direct integration, no abstraction needed |
| **Kore-certified integration** | connector | OAuth built-in, tested, supported         |
| **Custom tools with creds**    | mcp       | Encrypted credential management           |
| **Pure computation**           | sandbox   | No external dependencies, sandboxed       |
| **Long-running process**       | workflow  | Survives session, durable execution       |
| **Document retrieval**         | search_kb | Optimized for SearchAI                    |

---

### How to Structure Multi-Agent Systems?

**Anti-Pattern: Monolithic Agent**

```abl
AGENT: Everything_Agent  ❌
  FLOW: massive_flow
    # 50+ steps handling everything
```

**Pattern: Supervisor + Specialized Agents**

```abl
AGENT: Main_Supervisor  ✅
  HANDOFF:
    - TO: Agent_A WHEN: "intent == 'a'"
    - TO: Agent_B WHEN: "intent == 'b'"
    - TO: Agent_C WHEN: "intent == 'c'"

AGENT: Agent_A
  FLOW: focused_flow
    # 5-10 steps for single use case

AGENT: Agent_B
  FLOW: another_focused_flow
    # 5-10 steps for different use case
```

**Benefits:**

- Independent testing
- Parallel development
- Clear ownership
- Incremental deployment

---

## Common Questions

### Q: Should knowledge base be a tool or a special construct?

**A:** Knowledge base is a tool (`search_kb`). This provides:

- Uniform interface with other tools
- Circuit breaker protection
- Trace events for debugging
- Consistent error handling

### Q: How do I integrate knowledge base with agents?

**A:** Three patterns:

1. **Knowledge-First:** Search KB, fallback to action tools
2. **Hybrid Reasoning:** LLM decides when to search KB vs call other tools
3. **Fallback Chain:** Try KB → external API → escalate

See **Pattern 1: Agent + Tools + Knowledge** above.

### Q: When should I use SUPERVISOR vs single agent with many steps?

**A:** Use SUPERVISOR when:

- Multiple distinct use cases (balance, transfer, support)
- Each use case is independently valuable
- Different teams own different agents
- Need incremental deployment

Use single agent when:

- Linear flow (booking: search → select → confirm)
- Steps tightly coupled
- Single use case

### Q: How do I pass context between agents?

**A:** Use HANDOFF context:

```abl
HANDOFF:
  TO: Agent_B
  CONTEXT:
    pass: [customer_id, order_id, session_context]
    summary: "User wants to modify order"
  RETURN: true
  ON_RETURN: resume_step
```

Agent_B receives these variables in its session memory.

### Q: Can agents call other agents recursively?

**A:** Yes, but limit depth to 3-4 levels to avoid:

- Excessive LLM costs
- Debugging complexity
- Session timeout

Use DELEGATE for reusable sub-tasks, not deep recursion.

### Q: How do I handle errors in multi-agent systems?

**A:** Three levels:

1. **Agent-level:** ON_ERROR handlers in FLOW
2. **Supervisor-level:** Catch handoff failures
3. **Platform-level:** Circuit breakers, retry logic

```abl
AGENT: Supervisor
  HANDOFF:
    - TO: Agent_A
      CONTEXT: {customer_id}
      RETURN: true
      ON_ERROR:
        action: handoff
        to: Fallback_Agent
```

### Q: What's the difference between DELEGATE and HANDOFF?

**A:**

| Feature            | DELEGATE            | HANDOFF                       |
| ------------------ | ------------------- | ----------------------------- |
| **Return control** | Always              | Optional (RETURN: true/false) |
| **Use case**       | Reusable sub-task   | Routing to specialist         |
| **Context**        | Explicit parameters | Context passing               |
| **Caller waits**   | Yes                 | Only if RETURN: true          |

### Q: How do I optimize costs in reasoning mode?

**A:** Five strategies:

1. **Use FLOW for predictable steps**
2. **Cache tool results** (hints.cacheable: true)
3. **Use cheap models** (Haiku for simple tasks)
4. **Limit conversation history** (sliding window)
5. **Use constraints to skip unnecessary LLM calls**

### Q: How do I ensure agents are compliant (PCI, GDPR, SOC2)?

**A:** Six requirements:

1. **Tenant isolation:** Every query includes `tenantId`
2. **Encryption at rest:** Session memory encrypted
3. **Audit logging:** Every tool call traced
4. **Right to erasure:** Cascade delete on session cleanup
5. **Guardrails:** PII detection on output
6. **Limitations:** Hard boundaries in system prompt

See `platform-principles` skill for full details.

---

## Reference Checklist

When designing an agent system, verify:

**Architecture:**

- [ ] Agents are small (3-10 steps per FLOW)
- [ ] Supervisor used for routing (not monolithic agent)
- [ ] Knowledge base integrated as tool
- [ ] Tools have proper bindings (http, mcp, etc.)
- [ ] Memory strategy defined (session vs persistent)

**Execution:**

- [ ] Critical paths use FLOW (deterministic)
- [ ] Flexible steps use REASONING zones
- [ ] Constraints applied at right phases (pre-gather, pre-tool, post-response)
- [ ] Guardrails prevent unsafe output

**Integration:**

- [ ] Handoff context clearly defined
- [ ] Error handling at all levels (agent, supervisor, platform)
- [ ] Trace events emitted for all actions
- [ ] Circuit breakers on external calls

**Compliance:**

- [ ] Tenant isolation enforced (all queries scoped)
- [ ] Sensitive data encrypted (session memory, tool params)
- [ ] Audit logs for all tool calls
- [ ] TTLs on persistent memory

**Performance:**

- [ ] Conversation history bounded (sliding window)
- [ ] Tool results cached where possible
- [ ] Batch operations used (no N+1)
- [ ] Timeouts on all external calls

---

## Key Files Reference

| Component              | File Path                                                               |
| ---------------------- | ----------------------------------------------------------------------- |
| **AgentIR Schema**     | `/packages/compiler/src/platform/ir/schema.ts`                          |
| **Parser**             | `/packages/core/src/parser/agent-based-parser.ts`                       |
| **Compiler**           | `/packages/compiler/src/platform/ir/compiler.ts`                        |
| **Runtime Executor**   | `/apps/runtime/src/services/execution/runtime-executor.ts`              |
| **Reasoning Executor** | `/apps/runtime/src/services/execution/reasoning-executor.ts`            |
| **Flow Executor**      | `/packages/compiler/src/platform/constructs/executors/flow-executor.ts` |
| **Constraint Checker** | `/apps/runtime/src/services/execution/constraint-checker.ts`            |
| **SearchAI Docs**      | `/docs/searchai/00-START-HERE.md`                                       |
| **ABL Design**         | `/docs/AGENT_ABL_DESIGN.md`                                             |
| **Flow Design**        | `/docs/FLOW_MODE_DESIGN.md`                                             |
| **Constraints**        | `/docs/CONSTRAINTS.md`                                                  |

---

## Further Reading

- **Platform principles:** Use `platform-principles` skill
- **Code standards:** Use `code-standards` skill
- **SearchAI architecture:** Use `search-ai-architect` skill
- **SearchAI development:** Use `search-ai-development` skill
- **BullMQ workflows:** Use `bullmq-flows-guide` skill
- **Infrastructure:** Use `infrastructure-guide` skill
