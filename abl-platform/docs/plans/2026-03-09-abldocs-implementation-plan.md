# ABL Platform Documentation Generation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate 29 comprehensive documentation files in `/Users/sriharshanalluri/abldocs/` covering the ABL platform from Product, Developer, and Architect perspectives.

**Architecture:** Narrative-first documentation with modular files. Each file is self-contained but cross-references related docs. Files include generation headers with timestamps and commit hashes for regeneration tracking. All content is sourced from actual codebase exploration.

**Tech Stack:** Markdown files, ASCII art diagrams, ABL code examples from `examples/` directory.

**Design Doc:** `docs/plans/2026-03-09-abldocs-comprehensive-documentation-design.md`

**Source Commit:** `b3b49f03` (feature/aiassistedjourney)

---

## Phase 1: Scaffolding & Meta Files (2 tasks)

### Task 1: Create directory structure

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/README.md`
- Create: `/Users/sriharshanalluri/abldocs/product/` (directory)
- Create: `/Users/sriharshanalluri/abldocs/developer/` (directory)
- Create: `/Users/sriharshanalluri/abldocs/developer/cookbook/` (directory)
- Create: `/Users/sriharshanalluri/abldocs/architect/` (directory)

**Step 1: Create directories and write README.md**

```markdown
<!-- Generated: 2026-03-09 | Source: abl-platform@b3b49f03 -->

# ABL Platform Documentation

Comprehensive documentation for the Agent Blueprint Language (ABL) platform,
organized by audience.

## How to Use These Docs

| Audience               | Start Here                                      | You'll Learn                            |
| ---------------------- | ----------------------------------------------- | --------------------------------------- |
| **Product Management** | [Product Overview](product/overview.md)         | What ABL does, business value, maturity |
| **Developers**         | [Getting Started](developer/getting-started.md) | How to build and deploy agents          |
| **Architects**         | [System Overview](architect/system-overview.md) | How the system works under the hood     |

## Documentation Map

### Product Perspective

- [Platform Overview](product/overview.md) — Vision, value proposition, differentiators
- [Capabilities](product/capabilities.md) — Feature matrix with maturity ratings
- [Use Cases](product/use-cases.md) — Real-world examples (banking, healthcare, travel)
- [Maturity Matrix](product/maturity-matrix.md) — What's production-ready vs experimental
- [Integration Patterns](product/integration-patterns.md) — Enterprise integration guide

### Developer Perspective

- [Getting Started](developer/getting-started.md) — Hello World to first agent
- [ABL Language Guide](developer/abl-language-guide.md) — Complete DSL reference
- [Runtime Guide](developer/runtime-guide.md) — Execution modes, sessions, memory
- [Tools & Integrations](developer/tools-and-integrations.md) — HTTP, MCP, sandbox tools
- [SearchAI Guide](developer/search-ai-guide.md) — Knowledge base and RAG
- [Studio Guide](developer/studio-guide.md) — Agent design UI
- [Testing & Debugging](developer/testing-and-debugging.md) — Observatory, evals
- [Deployment](developer/deployment.md) — Docker, Helm, production
- **Cookbook:**
  - [Common Patterns](developer/cookbook/patterns.md)
  - [BankNexus Walkthrough](developer/cookbook/banknexus-walkthrough.md)
  - [Saludsa Walkthrough](developer/cookbook/saludsa-walkthrough.md)
  - [Multi-Agent Patterns](developer/cookbook/multi-agent-patterns.md)

### Architect Perspective

- [System Overview](architect/system-overview.md) — Architecture diagrams
- [Component Deep Dive](architect/component-deep-dive.md) — Every package and app
- [Data Architecture](architect/data-architecture.md) — MongoDB, Redis, ClickHouse
- [Execution Engine](architect/execution-engine.md) — IR compilation, executors
- [LLM Orchestration](architect/llm-orchestration.md) — Model registry, routing
- [Multi-Agent Coordination](architect/multi-agent-coordination.md) — Handoffs, delegation
- [Security & Compliance](architect/security-and-compliance.md) — Auth, PII, encryption
- [Observability](architect/observability.md) — Tracing, metrics, debugging
- [SearchAI Architecture](architect/search-ai-architecture.md) — Pipeline, workers
- [Design Decisions](architect/design-decisions.md) — Trade-offs and rationale
- [Known Limitations](architect/known-limitations.md) — Gaps and future directions

## Regeneration

See [LAST_UPDATED.md](LAST_UPDATED.md) for per-file timestamps. These docs are
periodically regenerated from the ABL platform source code using Claude Code.

## Source Repository

All documentation is generated from analysis of `abl-platform` at commit `b3b49f03`.
Cross-references point to files in the source repository's `docs/` directory.
```

**Step 2: Verify directory structure**

Run: `find /Users/sriharshanalluri/abldocs -type f -o -type d | sort`

---

### Task 2: Create LAST_UPDATED.md

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/LAST_UPDATED.md`

**Step 1: Write LAST_UPDATED.md with all 27 file entries**

This file will be updated at the end of each phase as files are generated. Initial version lists all planned files as "Pending".

---

## Phase 2: Product Perspective (5 tasks — can run in parallel)

### Task 3: Product — Platform Overview

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/product/overview.md`

**Content requirements:**

- Generation header with date and commit
- What is ABL: A declarative language + execution platform for building AI agents
- Platform vision: Enable enterprises to build, test, deploy, and manage AI agents at scale
- Key differentiators:
  - **Declarative DSL** — Not code, not drag-and-drop; a purpose-built language for agent behavior
  - **IR-First Compilation** — ABL → AST → AgentIR; single source of truth for all runtimes
  - **Dual Execution** — Reasoning (LLM-driven) and Scripted (state machine) in one language
  - **Multi-Agent Native** — Supervisor routing, handoff, delegation, fan-out built into the language
  - **Enterprise-Grade** — Multi-tenant isolation, PII protection, guardrails, audit logging
  - **Channel Agnostic** — Voice, chat, SDK, webhooks from the same agent definition
  - **Integrated Search** — Built-in RAG pipeline with 17-worker document ingestion
- Target market: Enterprise contact centers, customer service, internal operations
- Platform components summary (one paragraph each): Language, Runtime, SearchAI, Studio, Admin
- Value proposition for different stakeholders (CTO, Product Manager, Developer, Operations)

**Source files to reference:**

- `README.md` (architecture overview)
- `docs/ENTERPRISE_ROADMAP.md`
- `docs/XO_ENTERPRISE_GAP_ANALYSIS.md`

---

### Task 4: Product — Capabilities Matrix

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/product/capabilities.md`

**Content requirements:**

- Generation header
- Feature matrix tables organized by category:

**Agent Development:**
| Feature | Status | Description |
|---------|--------|-------------|
| Reasoning Mode | GA | LLM-driven agentic loop with tool calling |
| Scripted Flow Mode | GA | State machine with step transitions |
| GATHER (info collection) | GA | Multi-field LLM-based extraction |
| Multi-Agent Orchestration | GA | Supervisor, handoff, delegate, fan-out |
| Constraints & Guardrails | GA | Business rules, PII, content safety |
| Memory (session + persistent) | GA | User-scoped and project-scoped facts |
| 40+ Built-in Functions | GA | String, math, formatting, security |
| Behavior Profiles | Beta | Context-dependent agent behavior overrides |
| TRANSFORM pipeline | GA | Array: FILTER → MAP → SORT_BY → LIMIT |

**Channels:**
| Channel | Status |
|---------|--------|
| Web Chat (SDK) | GA |
| WebSocket | GA |
| REST API | GA |
| Jambonz Voice | Beta |
| Kore VG Voice | Beta |
| LiveKit WebRTC | Beta |
| Twilio Media Streams | Beta |

**Search & Knowledge:**
| Feature | Status |
|---------|--------|
| Document Ingestion (17 workers) | GA |
| Hybrid Search (BM25 + semantic) | GA |
| Knowledge Graph | Beta |
| Enterprise Connectors | Beta |
| Vocabulary Management | GA |

**Platform & Operations:**
| Feature | Status |
|---------|--------|
| Multi-Tenant Isolation | GA |
| RBAC & Permissions | GA |
| PII Detection/Redaction | GA |
| Encryption (AES-256-GCM) | GA |
| Audit Logging | GA |
| Observatory (tracing) | GA |
| ClickHouse Analytics | Beta |
| Eval Framework | Beta |
| Arch AI Assistant | Beta |

---

### Task 5: Product — Use Cases

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/product/use-cases.md`

**Content requirements:**

- Generation header
- Three detailed case studies from actual `examples/` directory:

**1. BankNexus — Banking Customer Service**

- Business problem: Customers need balance checks, fund transfers, transaction history
- ABL solution: Supervisor + 3 specialist agents
- Read and annotate: `examples/banknexus/supervisor.agent.abl`, `examples/banknexus/agents/fund_transfer.agent.abl`
- Key ABL features demonstrated: SUPERVISOR routing, GATHER for transfer details, CONSTRAINTS for transfer limits, ESCALATE for high-value transactions

**2. Saludsa — Healthcare Insurance**

- Business problem: Insurance customers need refund guidance, payment status, certificate issuance
- ABL solution: Supervisor + 8 specialist agents with WhatsApp channel
- Read and annotate: `examples/saludsa/supervisor.agent.abl`, key agent files
- Key features: Multi-agent coordination, channel-specific behavior, human escalation

**3. Travel — Booking Management**

- Business problem: Travel customers need to search, book, modify, cancel reservations
- ABL solution: Supervisor + 11 specialist agents with fee calculation and payment
- Read and annotate: `examples/travel/supervisor.agent.abl`, `examples/travel/agents/booking_manager.agent.abl`
- Key features: DELEGATE to fee calculator, HANDOFF for authentication, complex FLOW with ON_RESULT branching

Each case study format:

1. Business Context (2 paragraphs)
2. Agent Architecture (ASCII diagram of supervisor + specialists)
3. Key ABL Code (annotated snippets from actual files)
4. Features Demonstrated (bullet list)
5. Business Outcomes (what this enables)

---

### Task 6: Product — Maturity Matrix

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/product/maturity-matrix.md`

**Content requirements:**

- Generation header
- Honest assessment of every subsystem:

| Subsystem                      | Maturity | Notes                                               |
| ------------------------------ | -------- | --------------------------------------------------- |
| ABL Parser & Compiler          | GA       | Stable, 40+ constructs, comprehensive tests         |
| Reasoning Executor             | GA       | Production LLM loop with tool calling               |
| Flow Executor                  | GA       | State machine with GATHER, corrections, digressions |
| Multi-Agent (Handoff/Delegate) | GA       | Thread model, nested returns, fan-out               |
| Guardrails Pipeline            | GA       | 3-tier (policy, webhook, LLM), PII redaction        |
| Session Management             | GA       | Tiered storage (memory → Redis → MongoDB)           |
| SearchAI Ingestion             | GA       | 17-worker pipeline, Python services                 |
| SearchAI Query Runtime         | GA       | Sub-500ms hybrid search                             |
| Studio Agent Builder           | GA       | Code editor, visual canvas, project management      |
| Arch AI Assistant              | Beta     | AI-driven agent creation, topology generation       |
| Voice (Jambonz)                | Beta     | Bidirectional audio, DTMF, TTS/STT                  |
| Voice (Kore VG)                | Beta     | Production-ready voice gateway                      |
| Knowledge Graph                | Beta     | Entity extraction, taxonomy                         |
| ClickHouse Analytics           | Beta     | Dual-write, dashboard integration                   |
| Eval Framework                 | Beta     | Personas, scenarios, evaluators                     |
| Enterprise Connectors          | Beta     | Azure AD, Okta, Google, Salesforce sync             |
| Workflow Engine (Restate)      | Beta     | Durable execution, human-in-the-loop                |
| Behavior Profiles              | Beta     | Context-dependent overrides                         |
| Sandbox Execution              | Beta     | gVisor-based code execution                         |
| Admin Dashboard                | GA       | Tenant management, models, usage, audit             |

Include notes on what "GA", "Beta", "Experimental" mean in this context.

---

### Task 7: Product — Integration Patterns

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/product/integration-patterns.md`

**Content requirements:**

- Generation header
- How ABL integrates with enterprise systems:

**1. Tool Bindings (HTTP)**

- REST API integration with OAuth, API keys, bearer tokens
- Example from `examples/tool-bindings/`
- Retry policies, timeout configuration

**2. MCP (Model Context Protocol)**

- Connect to any MCP-compatible server
- Project-scoped server registration
- Connection pooling (max 20 per project)

**3. Enterprise Connectors**

- Salesforce, Azure AD, Okta, Google Workspace
- IDP sync for permission-aware search
- Scheduled sync workers

**4. Telephony Integration**

- Jambonz: Open-source VoIP
- Kore VG: Enterprise voice gateway
- LiveKit: WebRTC streaming
- Twilio: Media streams

**5. Knowledge Base (SearchAI)**

- Document upload (PDF, DOCX, HTML, images)
- Web crawler integration
- Structured data ingestion
- Enterprise connector sources

**6. Webhooks & Events**

- Kafka event streaming (abl.\* topics)
- Webhook subscriptions
- Custom HTTP guardrail providers

**7. SDK Integration**

- Web SDK (JavaScript)
- WebSocket API
- REST API

Include ASCII diagram showing ABL platform at center with integration points radiating outward.

---

## Phase 3: Developer Perspective (12 tasks — batched for parallelism)

### Task 8: Developer — Getting Started

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/getting-started.md`

**Content requirements:**

- Generation header
- Prerequisites (Node.js 20+, pnpm, Docker)
- Clone and install:
  ```bash
  git clone <repo>
  cd abl-platform
  pnpm install
  ```
- Start infrastructure:
  ```bash
  docker compose up -d mongodb redis
  ```
- Build:
  ```bash
  pnpm build
  ```
- Write your first agent (inline ABL example — simple greeting agent):
  ```
  AGENT: Greeter
  GOAL: "Greet users and ask how you can help"
  PERSONA: "Friendly and professional assistant"
  TOOLS:
    get_time() -> string
      description: "Get current time"
  COMPLETE:
    - WHEN: user says goodbye
      RESPOND: "Have a great day!"
  ```
- Run it (reference Studio or CLI)
- Progressive complexity: add GATHER, add FLOW, add CONSTRAINTS
- Links to deeper guides for each concept
- Reference: `docs/ABL_QUICK_REFERENCE.md`

---

### Task 9: Developer — ABL Language Guide

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/abl-language-guide.md`

**Content requirements (this is the longest developer doc):**

- Generation header
- ABL file structure overview
- Every construct with syntax + example:
  1. AGENT (name, VERSION, DESCRIPTION)
  2. GOAL
  3. PERSONA
  4. LIMITATIONS
  5. MODE (reasoning vs scripted — note: deprecated in favor of per-step)
  6. TOOLS (signatures, descriptions, bindings)
  7. GATHER (fields, types, prompts, activation, validation)
  8. MEMORY (READS, WRITES, REMEMBER/RECALL)
  9. CONSTRAINTS (phases, REQUIRE, ON_FAIL actions)
  10. FLOW (steps, THEN transitions, COLLECT, RESPOND, CALL)
  11. SET / CLEAR (variable assignment and reset)
  12. CALL WITH/AS (explicit tool parameters, result binding)
  13. ON_RESULT (multi-way branching)
  14. ON_INPUT (intent-based routing within flow)
  15. TRANSFORM (FILTER → MAP → SORT_BY → LIMIT)
  16. DELEGATE (parallel agent calls)
  17. HANDOFF (agent transfer with return)
  18. ESCALATE (human transfer)
  19. COMPLETE (session end conditions)
  20. ON_ERROR (error handling, retry, backoff)
  21. DIGRESSIONS (intent-based escapes)
  22. SUB_INTENTS (scoped intents within a step)
  23. PRESENT (presentation templates)
  24. CORRECTIONS (natural user corrections)
  25. VOICE_CONFIG (SSML, TTS instructions)
  26. RICH_CONTENT (markdown, HTML, Slack, Adaptive Cards)
  27. BEHAVIOR_PROFILES (context-dependent overrides)

- Built-in functions table (40+):
  | Category | Functions |
  |----------|-----------|
  | String | UPPER, LOWER, TRIM, SUBSTRING, REPLACE, SPLIT, JOIN, PAD_START, PAD_END, REPEAT |
  | Math | ADD, SUB, MUL, DIV, ROUND, ABS, MIN, MAX |
  | Formatting | MASK, FORMAT_CURRENCY, FORMAT_DATE, ORDINAL |
  | Type | IS_ARRAY, IS_NUMBER, IS_STRING, TO_NUMBER, TO_STRING |
  | Array | LENGTH, ARRAY_FIND, ARRAY_FIND_INDEX |
  | Object | OBJECT_KEYS, OBJECT_VALUES, OBJECT_MERGE |
  | Utility | COALESCE, NOW, UNIQUE_ID |
  | Text | WORD_COUNT, SENTENCE_COUNT, CONTAINS_URL, CONTAINS_EMAIL, CONTAINS_CODE |
  | Security | CONTAINS_PII, DETECT_PII, REDACT_PII |

- Expression language (CEL-based): operators, variable references, template strings
- Supervisor document format (SUPERVISOR, AGENTS, ROUTING)
- YAML format alternative (.agent.yaml)
- Reference: `docs/AGENT_ABL_DESIGN.md`, `docs/ABL_QUICK_REFERENCE.md`, `docs/DSL_EXTENSIONS.md`

**Source files to read:**

- `packages/core/src/types/agent-based.ts` (for complete type list)
- `packages/compiler/src/platform/constructs/cel-functions.ts` (for function list)
- `examples/flow-test/hotel_booking_advanced.agent.abl` (for FLOW examples)
- `examples/banknexus/agents/fund_transfer.agent.abl` (for GATHER/CONSTRAINTS)

---

### Task 10: Developer — Runtime Guide

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/runtime-guide.md`

**Content requirements:**

- Generation header
- Execution modes explained:
  - **Reasoning mode**: LLM decides what to do next (tool calls, responses)
  - **Scripted mode (FLOW)**: State machine with explicit step transitions
  - **Hybrid**: FLOW steps can invoke REASONING for complex decisions
- Session lifecycle: create → execute messages → checkpoint → resume → complete
- Conversation history: message format, role types, tool_use/tool_result
- Memory system:
  - Session variables (ephemeral, per-session)
  - Persistent facts (user-scoped, cross-session via FactStore)
  - Project facts (shared across all users)
  - REMEMBER/RECALL triggers
- Checkpointing: tiered storage (L1 pod-local → L2 Redis → L3 MongoDB)
- Conversation compaction: summarize old messages when approaching token limits
- Concurrency strategies: serial, preemptive, parallel
- Channel types: web chat, SDK WebSocket, voice, REST API
- Reference: `docs/RUNTIME_ARCHITECTURE.md`, `docs/FLOW_MODE_DESIGN.md`

---

### Task 11: Developer — Tools & Integrations

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/tools-and-integrations.md`

**Content requirements:**

- Generation header
- Tool declaration syntax in ABL
- Tool binding types:
  - **HTTP**: REST endpoints with auth (API key, bearer, OAuth)
  - **MCP**: Model Context Protocol servers
  - **Sandbox**: Inline JavaScript execution
  - **Lambda**: AWS Lambda functions
- CALL WITH/AS syntax (named parameters, result binding)
- ON_RESULT branching (multi-way conditional on tool results)
- System tools (always available in reasoning mode):
  - handoff_to_agent, delegate_to_agent, fan_out_agents
  - escalate_to_human, complete_interaction
  - set_context, return_to_parent
- Tool confirmation (guardrail-gated tool execution)
- Tool result truncation (staleness-based, ~100KB cap)
- MCP server registration (project-scoped, connection pooling)
- OAuth credential management
- Examples from `examples/tool-bindings/`
- Reference: `docs/TOOLS_AND_GATHER.md`, `docs/ARCHITECT_TOOLS.md`

---

### Task 12: Developer — SearchAI Guide

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/search-ai-guide.md`

**Content requirements:**

- Generation header
- What is SearchAI: document ingestion + semantic search + knowledge retrieval
- Creating a search index (API walkthrough)
- Uploading documents (PDF, DOCX, HTML, images — 50MB limit)
- Document processing pipeline (high-level: upload → extract → chunk → embed → index)
- Querying:
  - Semantic search (vector similarity)
  - Structured queries (field-based)
  - Hybrid search (BM25 + semantic fusion)
  - Aggregation queries
  - Similar document finding
- Vocabulary management (domain terms, synonyms)
- Enterprise connectors (Salesforce, Azure AD, Okta, Google)
- Web crawler integration
- Agent integration (how agents use SearchAI via tools)
- API endpoints summary table
- Reference: `docs/SEARCH_AI_ARCHITECTURE.md`

---

### Task 13: Developer — Studio Guide

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/studio-guide.md`

**Content requirements:**

- Generation header
- What is Studio: Next.js web application for agent design and management
- Project management (create, configure, deploy)
- Agent editor:
  - ABL code editor with syntax highlighting (Monaco)
  - Visual canvas (flow builder)
  - Agent configuration panel
- Arch AI Assistant (Beta):
  - AI-driven agent creation workflow
  - Three phases: Collect requirements → Generate topology → Create project
  - Artifact panel (topology, agents, API specs, mocks)
- Testing:
  - Preview mode (chat with your agent)
  - Eval framework (personas, scenarios, evaluators)
- Deployment pipeline
- Workspace admin:
  - Member management, RBAC
  - LLM model configuration
  - Guardrail policies
  - Enterprise connectors
  - Secret management
- Reference: `docs/PROJECT_IO_AND_STUDIO_INTEGRATION.md`

---

### Task 14: Developer — Testing & Debugging

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/testing-and-debugging.md`

**Content requirements:**

- Generation header
- Testing ABL agents:
  - Unit tests (construct-level, compiler tests)
  - Integration tests (E2E with real LLM calls)
  - Eval framework (personas, scenarios, success criteria)
- Observatory:
  - 22 trace event types
  - Real-time trace streaming (WebSocket)
  - Session explorer
  - Decision logging (why each runtime decision was made)
- MCP Debug Server:
  - Claude Code integration for agent debugging
  - SessionStore and TraceStore event buffering
  - SpanBuilder for structured spans
- Static analysis:
  - @abl/analyzer rules (conflict, coverage, security, style)
  - Run analyzer on ABL documents before deployment
- Common debugging patterns:
  - Flow step not advancing → check conditions and THEN transitions
  - Tool not called → verify tool name matches IR, check guardrails
  - Agent not handing off → verify HANDOFF conditions and target agent exists
  - Session state lost → check checkpointing config, Redis connectivity
- Reference: `docs/OBSERVABILITY_AND_TRACING.md`

---

### Task 15: Developer — Deployment

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/deployment.md`

**Content requirements:**

- Generation header
- Local development setup:
  - Docker Compose services and ports table
  - Environment variables
  - Starting individual services
- Port mapping (from `packages/config/src/constants.ts`):
  | Service | Port |
  |---------|------|
  | Runtime | 3112 |
  | SearchAI | 3113 |
  | SearchAI Runtime | 3114 |
  | Studio | 5173 |
  | Admin | 3003 |
  | MongoDB | 27018 |
  | Redis | 6380 |
  | ClickHouse | 8124 |
  | Kafka | 19092 |
  | Docling | 8080 |
  | BGE-M3 | 8000 |
  | Preprocessing | 8003 |
- Docker Compose topology (13 services)
- Production considerations:
  - Stateless runtime design (no pod-local state as truth)
  - Redis for distributed sessions
  - MongoDB replica set
  - ClickHouse for analytics
  - Kafka for event streaming
- Helm/ArgoCD references (abl-platform-deploy repo)
- Terraform references (abl-platform-infra repo)
- Reference: Docker Compose file, `docs/ENTERPRISE_CICD_PLAN.md`

---

### Task 16: Developer Cookbook — Common Patterns

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/cookbook/patterns.md`

**Content requirements:**

- Generation header
- Pattern: Simple Q&A Agent (reasoning mode, no tools)
- Pattern: Data Collection Agent (GATHER with validation)
- Pattern: API Integration Agent (HTTP tool binding with ON_RESULT)
- Pattern: Scripted Flow (step-by-step process with branching)
- Pattern: Guardrailed Agent (CONSTRAINTS for safety)
- Pattern: Memory-Enabled Agent (REMEMBER/RECALL across sessions)
- Pattern: Error-Resilient Agent (ON_ERROR with retry and backoff)
- Pattern: Voice-Ready Agent (VOICE_CONFIG, channel detection)
- Pattern: Rich Content Agent (markdown, buttons, cards)
- Each pattern: 1-paragraph description + complete ABL snippet + explanation

---

### Task 17: Developer Cookbook — BankNexus Walkthrough

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/cookbook/banknexus-walkthrough.md`

**Content requirements:**

- Generation header
- Read and annotate ALL files in `examples/banknexus/`:
  - `supervisor.agent.abl`
  - `agents/fund_transfer.agent.abl`
  - `agents/get_balance.agent.abl`
  - `agents/transaction_history.agent.abl`
- Architecture diagram (supervisor + 3 specialists)
- Line-by-line annotation of supervisor routing logic
- Deep dive into fund_transfer: GATHER fields, CONSTRAINTS (transfer limits), ESCALATE (high-value)
- How agents coordinate: HANDOFF flow, context passing
- Lessons learned: when to use HANDOFF vs DELEGATE

---

### Task 18: Developer Cookbook — Saludsa Walkthrough

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/cookbook/saludsa-walkthrough.md`

**Content requirements:**

- Generation header
- Read and annotate key files from `examples/saludsa/`:
  - `supervisor.agent.abl`
  - `agents/refund_guidance.agent.abl`
  - `agents/pending_payments.agent.abl`
  - `agents/whatsapp_user_check.agent.abl`
  - `agents/transfer_to_sac.agent.abl`
- Architecture diagram (supervisor + specialists)
- Healthcare domain: how ABL handles sensitive data, user validation
- Channel-specific behavior (WhatsApp context)
- Human escalation patterns (transfer to SAC)
- Lessons learned: multi-agent for complex domain workflows

---

### Task 19: Developer Cookbook — Multi-Agent Patterns

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/developer/cookbook/multi-agent-patterns.md`

**Content requirements:**

- Generation header
- **Supervisor Pattern**: When and how to use SUPERVISOR documents
  - Routing strategies: intent-based, condition-based
  - Example from `examples/banknexus/supervisor.agent.abl`
- **Handoff Pattern**: Transfer control to another agent with return
  - Thread model explanation
  - INPUT/RETURNS field mapping
  - Timeout handling
  - Example from `examples/travel/agents/authentication.agent.abl`
- **Delegate Pattern**: Call agent, use result in current context
  - Parallel execution semantics
  - Result mapping
  - Example from `examples/travel/agents/booking_manager.agent.abl` (delegating to fee_calculator)
- **Fan-Out Pattern**: Execute multiple agents in parallel
  - When to use vs sequential delegation
- **Escalation Pattern**: Transfer to human agent
  - Triggers: high-value transactions, repeated failures, user request
  - Priority levels
  - Context preservation
- **Multi-Intent**: Handling multiple user intents
  - Strategies: primary_queue, disambiguate, parallel, sequential
- Reference: `docs/MULTI_AGENT.md`

---

## Phase 4: Architect Perspective (11 tasks — batched for parallelism)

### Task 20: Architect — System Overview

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/system-overview.md`

**Content requirements:**

- Generation header
- High-level architecture ASCII diagram showing all services:
  ```
  Studio (5173) ──→ Runtime (3112) ──→ LLM Providers
       │                │                    │
       │                ├──→ SearchAI RT (3114)
       │                ├──→ MCP Servers
       │                ├──→ HTTP Tools
       │                └──→ Voice (Jambonz/Kore/LiveKit)
       │
  Admin (3003)    SearchAI (3113) ──→ Docling (8080)
       │                │             BGE-M3 (8000)
       │                │             Preprocessing (8003)
       │
       └──→ Data Layer: MongoDB (27018) / Redis (6380) / ClickHouse (8124) / Kafka (19092)
  ```
- Service topology with ports and responsibilities
- Package dependency graph (35 packages):
  - `packages/core` → `packages/compiler` → `packages/execution` → `apps/runtime`
  - `packages/database` ← (used by 35+ packages)
  - `packages/shared` ← (used by 30+ packages)
- Monorepo structure overview (pnpm + Turbo)
- Three repos: abl-platform (source), abl-platform-deploy (Helm/ArgoCD), abl-platform-infra (Terraform)
- Reference: `README.md`

---

### Task 21: Architect — Component Deep Dive

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/component-deep-dive.md`

**Content requirements:**

- Generation header
- For each of the 35 packages and 14 apps, document:
  - Purpose (1-2 sentences)
  - Key exports/entry points
  - Dependencies
  - LOC estimate where relevant

**Packages (35):**

- core, compiler, analyzer, execution, database, shared, observatory, mcp-debug, config
- eventstore, pipeline-engine, agent-transfer, circuit-breaker
- connectors, crawlers, llm, search-ai-sdk, web-sdk, a2a
- editor, language-service, abl-lsp-server, abl-vscode, kore-platform-cli
- nl-parser, project-io, sizing-calculator
- admin-ui, tailwind-config, i18n, openapi

**Apps (14):**

- runtime, studio, admin, search-ai, search-ai-runtime
- workflow-engine, observer-cli, crawler-go-worker, crawler-mcp-server
- multimodal-service, nlu-sidecar, telco-noc, spec-mock

---

### Task 22: Architect — Data Architecture

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/data-architecture.md`

**Content requirements:**

- Generation header
- **MongoDB** (128 models):
  - Collection categories: Search AI (13), Project Config (10), Connectors (8), Auth (8), Analytics (5), Workflows (8), Documents (12), + more
  - Key schema patterns: tenant isolation plugin, soft deletes, encryption plugin, audit trails
  - Dual-database: Platform DB (abl_platform) + Content DB (search_ai)
- **Redis**:
  - Session cache (L2 tier), distributed locks, rate limiting, MCP connection pooling, provider cache
- **ClickHouse**:
  - Analytics: traces, messages, metrics, audit events
  - Dual-write pattern (MongoDB + ClickHouse)
  - BufferedClickHouseWriter for batch ingestion
- **Kafka**:
  - Event topics: abl.session._, abl.message._, abl.tool.\*
  - Batch size: 100, linger: 500ms
  - KRaft mode (no ZooKeeper)
- **Neo4j**: Knowledge graph (entity relationships)
- **OpenSearch**: Vector store (k-NN) for SearchAI
- **Qdrant**: Alternative vector store
- Data flow diagrams: ingestion path, query path, analytics path
- Reference: `docs/DATA_ARCHITECTURE.md`, `docs/db/`

---

### Task 23: Architect — Execution Engine

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/execution-engine.md`

**Content requirements:**

- Generation header
- **ABL Compilation Pipeline**:

  ```
  ABL Text → Lexer (Chevrotain) → Parser → AST (AgentBasedDocument) → IR Compiler → AgentIR
  ```

  - IR schema (AgentIR): metadata, execution, identity, tools, gather, memory, constraints, coordination, completion, error_handling, flow, nlu, behavior_profiles
  - Validation pipeline: 6 validators (IR, cross-agent, field-refs, input-mappings, recall, tool-schema)

- **Request Lifecycle** (full flow):
  REST/WS → Auth → Tenant → Rate Limit → Session Resolve → ExecutionCoordinator (dedup, concurrency) → RuntimeExecutor → Executor Selection → [Flow|Reasoning|Routing] → Constraints → Tools → LLM → Guardrails → Memory → Persist → Response
- **Executor Architecture**:
  - FlowStepExecutor: state machine, extraction strategy resolution (JS/LLM/NLU), correction detection
  - ReasoningExecutor: LLM loop (max 10 iterations), tool dispatch, result truncation
  - RoutingExecutor: thread model, handoff stack, multi-intent strategies
  - ConstraintChecker: violation handling (collect_field, goto_step, retry_step), max backtrack guard
- **PromptBuilder**: System prompt assembly from IR, tool definition generation, voice detection
- **Construct Actions**: ContinueAction, RespondAction, EscalateAction, HandoffAction, DelegateAction, CompleteAction, BlockAction, CollectAction
- Reference: `docs/AGENTICAI_ABL_ARCHITECTURE_BLUEPRINT.md`

---

### Task 24: Architect — LLM Orchestration

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/llm-orchestration.md`

**Content requirements:**

- Generation header
- **Model Resolution Chain** (5 levels, first match wins):
  1. Agent IR override (llm_model_id in agent definition)
  2. Agent DB settings (per-agent model configuration)
  3. Tenant-scoped model config (TenantModel + LLMCredential)
  4. Platform-level model catalog
  5. Environment variable fallback (OPENAI_API_KEY, etc.)
- **SessionLLMClient**: Per-session wrapper, unified output format
- **Provider Implementations**:
  - Anthropic (Claude 3.5 Sonnet, Opus, Haiku)
  - OpenAI (GPT-4, GPT-4o, GPT-4 Turbo)
  - Google Vertex (Gemini Pro)
  - AWS Bedrock
- **Provider Cache**: Module-level Map, key=`${provider}:${keyHash}:${baseUrl}`, TTL 30min, max 500 entries
- **Real-time LLM**: OpenAI Realtime, Gemini Live, Ultravox (for voice)
- **Credential Isolation**: Per-tenant credential storage, encrypted API keys
- **Cost/Latency**: Token usage tracking, LLM call timeout (120s default)
- **Vercel AI SDK**: Integration for streaming (streamText/generateText)
- **Arch AI LLM Resolution** (Studio):
  - Tier 1a: Model Hub credential
  - Tier 1b: Tenant's own API key
  - Tier 2: Platform env key
  - Tier 3: Error
- Reference: `docs/LLM_MODEL_HUB_DESIGN.md`

---

### Task 25: Architect — Multi-Agent Coordination

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/multi-agent-coordination.md`

**Content requirements:**

- Generation header
- **Thread Model**:
  - Session contains `threads[]` (agent activations)
  - `activeThreadIndex` and `threadStack` for nested returns
  - Handoff creates new thread with `returnExpected` flag
  - Delegate creates child thread (no return wait)
- **Routing Strategies**:
  - Intent-based routing (NLU confidence thresholds)
  - Condition-based routing (CEL expressions)
  - Default/fallback routing
- **Handoff Semantics**:
  - Transfer control with INPUT field mapping
  - RETURNS field mapping for data back to caller
  - Timeout handling (configurable, escalate/respond/continue)
  - Context preservation across handoffs
- **Delegate Semantics**:
  - Parallel execution
  - Result mapping to parent context
  - No return wait (fire-and-forget option)
- **Fan-Out**:
  - Execute multiple agents in parallel
  - Aggregate results
  - Timeout per agent
- **Multi-Intent Detection**:
  - Strategies: primary_queue, disambiguate, parallel, sequential
  - Confidence threshold: 0.6
  - Max intents: 3
  - Queue alternatives for later
- **State Sharing**: Session data store, thread-local vs shared values
- Reference: `docs/MULTI_AGENT.md`

---

### Task 26: Architect — Security & Compliance

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/security-and-compliance.md`

**Content requirements:**

- Generation header
- **Authentication** (3 flows via unified-auth.ts):
  1. User JWT (Bearer token) → user + tenant + permissions
  2. SDK Session (X-SDK-Token header) → embedded auth
  3. API Key (abl\_\* prefix) → scoped programmatic access
- **Authorization (RBAC)**:
  - requirePermission(), requireAllPermissions(), requireAnyPermission()
  - Role resolution per tenant
  - Project-level permissions (requireProjectPermission)
- **Tenant Isolation**:
  - Every query scoped to tenantId
  - findOne({\_id, tenantId}) — never findById
  - Cross-scope access returns 404 (not 403)
  - TenantContext plugin at database layer
- **PII Protection**:
  - Detection: email, phone, SSN, credit card patterns
  - Redaction: MASK() function in ABL
  - PIIVault: Secure storage of detected PII
  - Output filter: Scan LLM responses before delivery
  - ABL functions: CONTAINS_PII, DETECT_PII, REDACT_PII
- **Encryption**:
  - AES-256-GCM with HKDF/PBKDF2 key derivation
  - User-scoped and tenant-scoped encryption
  - Zstd compression before encryption
  - KMS integration for external key management
- **SSRF Protection**:
  - validateUrlForSSRF(): blocks private IPs, metadata endpoints
  - Applied to all HTTP tool bindings
- **Audit Logging**:
  - AuditLog model with actor context
  - Per-operation tracking
  - ClickHouse archival for long-term retention
- **Guardrails Pipeline**:
  - Tier 1 (Policy): PII masking, category filters
  - Tier 2 (Webhook): Custom HTTP evaluators
  - Tier 3 (LLM Eval): Semantic rule evaluation
  - Per-tenant provider registries
- **Data Protection**:
  - Soft deletes for GDPR compliance
  - DeletionRequest model for cascade erasure
  - TTL-based cleanup for session data
- Reference: `docs/SSRF_PROTECTION_IMPLEMENTATION.md`

---

### Task 27: Architect — Observability

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/observability.md`

**Content requirements:**

- Generation header
- **Trace Events** (22 types):
  - Core (7): llm_call, tool_call, decision, constraint_check, handoff, escalation, error
  - Extended (10): session_start/end, agent_enter/exit, flow_step_enter/exit, flow_transition, entity_extraction, delegate_start/complete
  - Attachment (5): upload, scan, process, index, delete
- **Trace Store**:
  - Ring buffer per session (fixed size, oldest dropped)
  - Time-based expiry
  - WebSocket subscriptions for real-time streaming
  - Replay on subscribe
- **Decision Logging**:
  - Captures WHY each runtime decision was made
  - Gated by traceVerbosity (minimal/standard/verbose/debug)
  - Causal trace for debugging
- **ClickHouse Analytics**:
  - TraceStore: append-only event tracing
  - MessageStore: conversation archival
  - MetricsStore: tokens, latency, cost
  - AuditStore: compliance events
- **MCP Debug Server**:
  - Claude Code integration for live debugging
  - WebSocketClient and HttpClient transports
  - SessionStore and TraceStore event buffering
- **Observatory CLI**: Terminal-based debugger
- **Dual-Write Pattern**: MongoDB (ACID) + ClickHouse (analytics)
- Reference: `docs/OBSERVABILITY_AND_TRACING.md`, `docs/CLICKHOUSE_OBSERVABILITY.md`

---

### Task 28: Architect — SearchAI Architecture

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/search-ai-architecture.md`

**Content requirements:**

- Generation header
- **Ingestion Pipeline** (17 core workers in 4 phases):
  - Phase 1 — Extraction: ingestion-worker, extraction-worker, docling-extraction-worker, page-processing-worker
  - Phase 2 — Analysis: noise-detection-worker, canonical-mapper-worker, question-synthesis-worker (LLM-gated), scope-classification-worker (LLM-gated)
  - Phase 3 — Visual: visual-enrichment-worker, document-visual-enrichment-worker
  - Phase 4 — Parallel Post-Processing: enrichment-worker, embedding-worker (→ BGE-M3), knowledge-graph-worker, kg-enrichment-worker, multimodal-worker, tree-building-worker (LLM-gated)
  - Specialized: taxonomy-setup-worker
- **Worker Lifecycle**: BullMQ queues, adaptive concurrency scaling, graceful shutdown
- **Python Services**:
  - Docling (8080): IBM Docling for PDFs, LlamaIndex for text formats, 40+ languages, OCR
  - BGE-M3 (8000): BAAI/bge-m3 embeddings, 384-dimensional, ARM64 compatible
  - Preprocessing (8003): Spell correction (20+ languages), synonym expansion (30+), Redis caching
- **Query Runtime** (sub-500ms):
  - Multi-level caching (query, embedding, result)
  - Hybrid search: BM25 + semantic fusion
  - Lazy reranking (top-K only)
  - Permission filtering (IdP integration)
  - Connection pooling
- **Data Stores**: Dual MongoDB (platform + content), OpenSearch (vectors), Neo4j (knowledge graph)
- **Enterprise Connectors**: Azure AD, Okta, Google, Salesforce sync workers, IDP scheduler
- Pipeline diagram (ASCII)
- Reference: `docs/SEARCH_AI_ARCHITECTURE.md`

---

### Task 29: Architect — Design Decisions

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/design-decisions.md`

**Content requirements:**

- Generation header
- Each decision in format: Context → Decision → Trade-offs → Status

**Key decisions:**

1. **IR-First Compilation**: Why ABL compiles to AgentIR rather than executing AST directly
   - Enables multiple runtimes (voice, digital, workflow) from same source
   - Framework-agnostic; can target different execution environments
   - Trade-off: Extra compilation step, IR schema must be kept in sync

2. **Dual Execution Modes**: Why both Reasoning and Scripted in one language
   - Reasoning: Best for open-ended tasks, LLM decides actions
   - Scripted: Best for regulated processes, deterministic flow
   - Trade-off: Complexity in executor selection and state management

3. **Tiered Session Storage**: L1 (memory) → L2 (Redis) → L3 (MongoDB)
   - L1 for speed (pod-local), L2 for distribution, L3 for persistence
   - Trade-off: Eventual consistency between tiers, complexity in invalidation

4. **CEL Expression Migration**: Moving from custom expression language to CEL
   - CEL: Industry standard, well-tested, rich operators
   - Dual evaluator supports both during migration
   - Trade-off: Migration effort, dual-mode complexity

5. **Provider-Neutral LLM Types**: LLMToolDefinition, LLMToolCall, LLMToolResult
   - Enables swapping providers without changing agent definitions
   - Trade-off: Abstraction layer adds indirection

6. **Chevrotain Parser**: Why Chevrotain over PEG.js, ANTLR, or tree-sitter
   - TypeScript-native, no build step, good error recovery
   - Trade-off: Less ecosystem tooling than ANTLR

7. **BullMQ for SearchAI Pipeline**: Why BullMQ over raw Redis pub/sub
   - Job persistence, retry, priority, concurrency control
   - Trade-off: Redis memory pressure at scale

8. **Vercel AI SDK**: Why Vercel AI SDK for LLM integration
   - Unified streaming API across providers
   - Built-in tool calling support
   - Trade-off: Dependency on Vercel ecosystem

9. **Next.js App Router for Studio**: Why App Router over Pages Router
   - Server components, streaming, nested layouts
   - Trade-off: Still evolving API, some patterns less documented

10. **Zustand for State**: Why Zustand over Redux, Jotai, or MobX
    - Minimal boilerplate, TypeScript-first, easy debugging
    - Trade-off: Less structured than Redux for very large state

---

### Task 30: Architect — Known Limitations

**Files:**

- Create: `/Users/sriharshanalluri/abldocs/architect/known-limitations.md`

**Content requirements:**

- Generation header
- Honest assessment of current limitations:

**Runtime:**

- Pod-local session cache (L1) can go stale if session moves between pods without Redis sync
- Max 10 LLM iterations per message (configurable but affects latency)
- Tool result truncation may lose context in complex multi-tool chains
- Conversation compaction summarizes old messages — may lose nuance

**Language:**

- ABL syntax is whitespace-sensitive in some areas (YAML-like indentation)
- Expression language migration (legacy → CEL) not yet complete
- No first-class support for async/background tasks in ABL (must use workflows)

**SearchAI:**

- 17-worker pipeline requires significant Redis memory under heavy load
- Knowledge graph (Neo4j) integration is beta — limited query patterns
- Document size limit: 50MB per upload
- Embedding model (BGE-M3) produces 384-dimensional vectors — lower resolution than some alternatives

**Voice:**

- Voice channel integration is beta — limited to supported providers
- Real-time voice has higher latency than dedicated voice platforms
- SSML support varies by TTS provider

**Studio:**

- Arch AI Assistant is beta — topology generation can be inconsistent
- Visual canvas (flow builder) limited to read-only in some contexts
- Client-side routing via pushState — no SSR for most pages

**Infrastructure:**

- Docker Compose topology (13 services) is complex for local development
- ClickHouse analytics requires separate maintenance
- Kafka (KRaft mode) is single-node in development — needs cluster for production

**Scaling:**

- Single Redis instance for all caching/locking — may need cluster at scale
- MongoDB replica set required for production
- No horizontal autoscaling configuration out of the box

**Future Directions:**

- Complete CEL migration (remove legacy expression evaluator)
- Horizontal pod autoscaling for runtime
- Voice channel GA (all providers)
- Knowledge graph GA
- Workflow engine GA (Restate-backed)
- OpenTelemetry integration (replace custom tracing)

---

## Phase 5: Finalization (1 task)

### Task 31: Update LAST_UPDATED.md and Final Review

**Files:**

- Modify: `/Users/sriharshanalluri/abldocs/LAST_UPDATED.md`

**Step 1: Update LAST_UPDATED.md with all generated files**

Populate the table with all 27 files, their generation date (2026-03-09), generator (Claude Code), and notes (Initial generation).

**Step 2: Verify all files exist**

Run: `find /Users/sriharshanalluri/abldocs -name '*.md' | wc -l`
Expected: 29 (27 content files + README.md + LAST_UPDATED.md)

**Step 3: Verify no broken cross-references**

Run: `grep -r '\[.*\](.*\.md)' /Users/sriharshanalluri/abldocs/ | grep -v '#' | head -20`
Spot-check that linked files exist.

**Step 4: Verify generation headers**

Run: `grep -l 'Generated: 2026-03-09' /Users/sriharshanalluri/abldocs/**/*.md | wc -l`
Expected: 27 (all content files have headers)

---

## Execution Notes

### Parallelism Opportunities

**Phase 2** (Product): All 5 tasks (3-7) are independent — run in parallel.

**Phase 3** (Developer): Tasks can be batched:

- Batch 3A (independent): Tasks 8, 9, 10, 11, 12 (getting-started, language, runtime, tools, search-ai)
- Batch 3B (independent): Tasks 13, 14, 15 (studio, testing, deployment)
- Batch 3C (depends on language guide patterns): Tasks 16, 17, 18, 19 (cookbook files)

**Phase 4** (Architect): All 11 tasks (20-30) are independent — run in parallel (max 5 concurrent for quality).

### Source Files Each Task Should Read

Each documentation task agent should read the relevant source files listed in its requirements. Key files that multiple tasks reference:

- `README.md` — Platform overview
- `packages/core/src/types/agent-based.ts` — ABL type definitions
- `packages/compiler/src/platform/ir/schema.ts` — IR schema
- `packages/config/src/constants.ts` — Port constants
- `docker-compose.yml` — Infrastructure topology
- `examples/banknexus/` — Banking examples
- `examples/saludsa/` — Healthcare examples
- `examples/travel/` — Travel examples

### Quality Checklist Per File

Before marking any file complete:

- [ ] Generation header present (`<!-- Generated: 2026-03-09 | Source: abl-platform@b3b49f03 -->`)
- [ ] Cross-references use relative paths within `/abldocs/`
- [ ] Source repository references use `docs/` prefix
- [ ] ASCII diagrams render correctly in monospace font
- [ ] Code examples are from actual source files (not fabricated)
- [ ] No aspirational features documented as current
- [ ] File is self-contained (readable without other files)
- [ ] Links to related files for deeper exploration
