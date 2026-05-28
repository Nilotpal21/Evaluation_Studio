# Getting Started with Agent Platform

> **Estimated time**: 20 minutes | **Prerequisites**: None

## Learning Objectives

After completing this module, you will be able to:

- Describe what Agent Platform is and the problems it solves
- Identify the three core platform components (Studio, Runtime, SearchAI) and their roles
- Explain why a declarative DSL approach differs from imperative agent frameworks
- Understand the compilation pipeline from ABL source to executable Intermediate Representation
- Create a basic agent and supervisor definition in ABL

## What Is Agent Platform?

Agent Platform is an enterprise agent platform that lets you define, orchestrate, and deploy AI agents using a purpose-built domain-specific language called ABL (Agent Behavior Language). Instead of writing hundreds of lines of imperative Python or JavaScript code to wire up LLM calls, tool integrations, and session management, you describe _what_ your agents should do in a structured, human-readable format -- and the platform handles execution, routing, channels, and observability.

Three value propositions define the platform:

- **DSL-driven agent development** -- Define agents in ABL, a declarative language designed for agent behavior. No framework boilerplate.
- **Multi-agent orchestration** -- Supervisors route conversations to specialist agents with handoff, delegation, escalation, and fan-out patterns built in.
- **Enterprise-grade by default** -- Multi-tenant isolation, encryption at rest and in transit, audit logging, and guardrails are platform primitives, not afterthoughts.

## The Three Platform Components

Agent Platform is made up of three cooperating services. You interact directly with one of them (Studio), and the other two work behind the scenes.

### Studio: Where You Build

Studio is the **browser-based IDE** where you build, test, and manage your agents. There is no local installation required -- you open a web browser, sign in, and start working. Studio provides:

- A **code editor** with syntax highlighting and real-time validation for ABL definitions
- A **visual editor** with a full-page configuration panel for all agents and a canvas-based flow editor for agents with steps
- A built-in **chat playground** for testing agents interactively
- A **trace viewer** that shows every LLM call, tool invocation, and reasoning step

> **Key Concept**: Studio is a design-time tool. Everything you create in Studio -- agent definitions, tool configurations, knowledge base uploads -- produces artifacts that the Runtime uses to execute your agents. You never need to install anything locally.

### Runtime: The Execution Engine

Runtime is the **agent execution engine**. When an end user sends a message through any channel (web chat, WhatsApp, voice, API), the Runtime:

1. Loads the compiled agent definition (the IR)
2. Executes reasoning loops or step-based flows depending on the agent's structure
3. Calls LLM providers (Anthropic, OpenAI, etc.) to generate responses
4. Invokes tools when the agent needs external data or actions
5. Enforces guardrails and constraints
6. Manages conversation sessions and context
7. Coordinates multi-agent handoffs and delegations
8. Delivers the response through the appropriate channel adapter

You do not interact with the Runtime directly during development. Your end users interact with it through the channels you configure.

### SearchAI: Knowledge and Retrieval

SearchAI powers the knowledge base and RAG (Retrieval-Augmented Generation) pipeline. When you upload documents, SearchAI processes them into a searchable format. When an agent needs to answer questions using your organization's knowledge, the Runtime queries SearchAI.

SearchAI handles document ingestion, chunking, embedding generation, indexing, and query processing -- all automatically.

## Why Declarative? DSL vs. Imperative Code

This is one of the most important design decisions in Agent Platform, and understanding it helps you think about agent development differently.

### The Imperative Approach

In frameworks like LangGraph or CrewAI, you write procedural code that explicitly manages every aspect of agent behavior:

```python
# Pseudocode -- imperative agent framework
def handle_message(message, session):
    context = load_session(session.id)
    tools = initialize_tools([search_api, booking_api])
    llm = get_model("claude-sonnet")

    response = llm.chat(
        system_prompt=build_prompt(context),
        messages=context.history + [message],
        tools=tools
    )

    if response.has_tool_calls:
        results = execute_tools(response.tool_calls)
        response = llm.chat(messages=[...results])

    save_session(session.id, context)
    return response
```

You control the "how" -- session loading, tool initialization, LLM calls, result handling, session saving. This gives maximum flexibility but also means you own every line of infrastructure code.

### The Declarative Approach

In ABL, you describe the "what" -- the agent's goal, tools, and behavior -- and the platform handles the "how":

```abl
AGENT: Support_Assistant

EXECUTION:
  model: claude-sonnet-4-5-20250929

GOAL: |
  Help customers with product questions. Be concise
  and friendly. If you do not know the answer, say so.

TOOLS:
  search_knowledge(query: string) -> {results: object[], totalCount: number}
    description: "Search the product knowledge base"

INSTRUCTIONS: |
  1. Understand the customer's question
  2. Search the knowledge base for relevant information
  3. Provide a clear, sourced answer
```

This 15-line definition replaces hundreds of lines of framework setup code.

> **Key Concept**: Declarative definitions separate the "what" from the "how." Your agent logic lives in `.abl` files (the what), and execution logic lives in the platform (the how). This gives you portability (same definition runs on voice, chat, or API channels), testability (evaluate behavior without deploying infrastructure), and composability (agents combine like building blocks).

### Advantages of the Declarative DSL

| Advantage               | Description                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Readability**         | ABL definitions are readable by non-engineers -- product managers, QA teams, and domain experts can review agent behavior |
| **Version control**     | `.abl` files are plain text, so they work with git diffs, pull requests, and code review workflows                        |
| **Portability**         | The same agent definition works across 20+ channels without modification                                                  |
| **Reduced boilerplate** | No session management, tool wiring, or LLM orchestration code to write                                                    |
| **Built-in safety**     | Guardrails, tenant isolation, and encryption are platform primitives, not custom code                                     |

## The Compilation Pipeline: ABL to IR

When you write an agent definition in Studio, something important happens behind the scenes: the ABL compiler transforms your human-readable definition into an **Intermediate Representation (IR)** that the Runtime can execute.

```
ABL Source (.abl) --> Parser --> AST --> Compiler --> IR (JSON) --> Runtime
```

Here is what each stage does:

1. **Parser** -- Reads your `.abl` file and validates the syntax. If you have a missing colon or an unrecognized keyword, the parser catches it here.
2. **AST (Abstract Syntax Tree)** -- A structured, in-memory representation of your definition. The parser produces this from valid ABL source.
3. **Compiler** -- Transforms the AST into an executable agent configuration. It checks cross-agent references (do handoff targets exist?), validates type consistency, and optimizes the output.
4. **IR (Intermediate Representation)** -- The compiled JSON output that the Runtime loads and executes. You never need to work with the IR directly.

> **Key Concept**: The ABL compiler produces an Intermediate Representation (IR) -- a framework-agnostic JSON structure. The Runtime executes the IR, not the raw ABL text. This separation means the same agent definition can run on digital channels, voice channels, or workflow engines from a single ABL source. Studio compiles automatically as you edit, flagging errors in real time.

## Supervisors and HANDOFF: Multi-Agent Routing

Real-world applications rarely use a single agent. A customer service system might need specialists for billing, shipping, returns, and escalation to human agents. Agent Platform handles this with **supervisors** and **HANDOFF** rules.

A supervisor is a special agent that routes conversations to the right specialist. It does not handle domain tasks directly -- it analyzes each incoming message and decides which agent should take over.

```abl
SUPERVISOR: Product_Supervisor

EXECUTION:
  model: claude-sonnet-4-5-20250929

GOAL: |
  Route customer queries to the right specialist agent.

HANDOFF:
  - TO: Support_Assistant
    WHEN: intent.category == "support"
    PASS: query

  - TO: Billing_Agent
    WHEN: intent.category == "billing"
    PASS: query
```

> **Key Concept**: The SUPERVISOR declaration with HANDOFF rules is how ABL implements multi-agent orchestration. The platform evaluates each `WHEN` as an expression over session state. For semantic routing, classify into a field like `intent.category` and hand off on that value. You can add new specialists by adding new HANDOFF rules without changing existing agents.

## Your First Agent in 5 Minutes

Here is a complete agent definition you can paste into Studio:

```abl
AGENT: Customer_Greeter

EXECUTION:
  model: claude-sonnet-4-5-20250929

GOAL: |
  Welcome visitors to Bean & Brew coffee shop. Answer questions about
  the menu, store hours, and location. Keep responses friendly, concise,
  and on-topic.

PERSONA: |
  Warm, friendly barista who loves coffee. Uses casual but professional
  language. Keeps answers short and helpful.

LIMITATIONS:
  - "Cannot process orders or payments"
  - "Cannot access real-time inventory"

INSTRUCTIONS: |
  1. Greet the customer warmly when they first message
  2. Answer questions about the menu, hours, or location
  3. If asked about placing an order, explain that online ordering
     is coming soon and suggest visiting the store
  4. Keep responses under 3 sentences when possible
```

This agent operates in **reasoning mode** -- the LLM decides how to respond to each message based on the GOAL, PERSONA, and INSTRUCTIONS you provided. There is no predefined conversation flow; the agent handles whatever the user asks.

## The Developer Workflow

Building an agent follows a natural progression:

| Stage          | What You Do                                           | Platform Component   |
| -------------- | ----------------------------------------------------- | -------------------- |
| **1. Define**  | Write ABL definitions or use the visual editor        | Studio               |
| **2. Build**   | Save to trigger parsing, validation, and compilation  | Studio (compiler)    |
| **3. Test**    | Chat with your agent in the playground, review traces | Studio (playground)  |
| **4. Deploy**  | Publish to Runtime and connect channels               | Studio + Runtime     |
| **5. Monitor** | Review traces, analytics, and session logs            | Studio (observatory) |
| **6. Iterate** | Refine definitions based on real usage data           | Back to step 1       |

## Key Takeaways

- Agent Platform uses a **declarative DSL** where you describe what agents should do, not how to implement execution logic -- this reduces boilerplate and improves readability
- The platform has three components: **Studio** (browser-based IDE), **Runtime** (execution engine), and **SearchAI** (knowledge and retrieval)
- The **ABL compiler** transforms your `.abl` definitions into an **Intermediate Representation (IR)** that the Runtime executes
- **Supervisors** with **HANDOFF** rules provide intelligent multi-agent routing based on user intent
- The same agent definition works across 20+ channels without modification

## What's Next

Now that you understand the platform architecture, move to the **Core Concepts** module to learn about agents, execution modes, per-step reasoning control, and sessions in depth.
