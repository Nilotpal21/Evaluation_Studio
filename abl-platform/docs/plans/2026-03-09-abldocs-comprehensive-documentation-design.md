# ABL Platform Comprehensive Documentation Design

**Date:** 2026-03-09
**Status:** Approved
**Approach:** Narrative-First Architecture (Option 2)

---

## 1. Objective

Create comprehensive, living documentation for the ABL (Agent Blueprint Language) platform in `/Users/sriharshanalluri/abldocs/` that serves three audiences equally:

1. **Product Management** — What the platform can do, business value, maturity
2. **Developers** — How to build agents, API references, cookbook with annotated examples
3. **Architects** — System internals, design decisions, trade-offs, known limitations

Documentation will be periodically regenerated with date stamps to track platform evolution.

---

## 2. Requirements Summary

| Dimension                  | Decision                                                       |
| -------------------------- | -------------------------------------------------------------- |
| Goal                       | Reference + Onboarding + Living Architecture                   |
| Priority                   | Equal across all 3 perspectives                                |
| Structure                  | Modular (topic-per-file)                                       |
| Existing docs relationship | Reference linking (cross-reference `docs/` extensively)        |
| Code examples              | Comprehensive cookbook + Annotated real examples               |
| Scope                      | Full platform coverage (all subsystems)                        |
| Depth                      | Full transparency (trade-offs, limitations, future directions) |

---

## 3. Target Directory Structure

```
/Users/sriharshanalluri/abldocs/
├── README.md                          # Index + how to use these docs
├── LAST_UPDATED.md                    # Per-file regeneration timestamps
│
├── product/
│   ├── overview.md                    # Platform vision, value proposition
│   ├── capabilities.md                # Feature matrix across all subsystems
│   ├── use-cases.md                   # Banking, healthcare, travel annotated examples
│   ├── maturity-matrix.md             # Production-ready vs experimental
│   └── integration-patterns.md        # How ABL fits in enterprise stacks
│
├── developer/
│   ├── getting-started.md             # Hello World → first agent
│   ├── abl-language-guide.md          # ABL DSL reference with examples
│   ├── runtime-guide.md               # Execution modes, session lifecycle
│   ├── tools-and-integrations.md      # Tool system, MCP, HTTP, sandbox
│   ├── search-ai-guide.md             # Knowledge base, RAG pipeline
│   ├── studio-guide.md                # UI for agent design
│   ├── testing-and-debugging.md       # Observatory, test patterns
│   ├── deployment.md                  # Docker, Helm, environments
│   └── cookbook/
│       ├── patterns.md                # Common agent patterns
│       ├── banknexus-walkthrough.md   # Annotated banking example
│       ├── saludsa-walkthrough.md     # Annotated healthcare example
│       └── multi-agent-patterns.md    # Supervisor, handoff, delegation
│
├── architect/
│   ├── system-overview.md             # High-level architecture diagram
│   ├── component-deep-dive.md         # Every component, its internals
│   ├── data-architecture.md           # MongoDB, Redis, ClickHouse, data flow
│   ├── execution-engine.md            # IR compilation, executor pipeline
│   ├── llm-orchestration.md           # Model registry, routing, providers
│   ├── multi-agent-coordination.md    # Supervisor, routing, state sharing
│   ├── security-and-compliance.md     # Auth, PII, encryption, isolation
│   ├── observability.md               # Tracing, metrics, Observatory
│   ├── search-ai-architecture.md      # Ingestion pipeline, workers, retrieval
│   ├── design-decisions.md            # Key trade-offs and rationale
│   └── known-limitations.md           # Current gaps, future directions
```

**Total: 27 documentation files** across 3 perspectives + 2 meta files.

---

## 4. Platform Components to Document

### 4.1 Core Language & Compiler

| Component           | Package                                      | Key Files                                                                                                                                 |
| ------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ABL Parser          | `packages/core/`                             | Lexer, 6 parsers (agent-based, supervisor, YAML, expression, tool-file, tool-import)                                                      |
| IR Compiler         | `packages/compiler/src/platform/ir/`         | `compiler.ts`, `schema.ts`, validation pipeline                                                                                           |
| Construct Executors | `packages/compiler/src/platform/constructs/` | 8 executors (constraint, completion, handoff, delegate, gather, flow, reasoning, tool-binding)                                            |
| Static Analyzer     | `packages/analyzer/`                         | Conflict, coverage, security, style rules                                                                                                 |
| ABL Language        | 15+ constructs                               | AGENT, GATHER, MEMORY, CONSTRAINTS, DELEGATE, HANDOFF, ESCALATE, COMPLETE, ON_ERROR, FLOW, SET, CLEAR, CALL WITH/AS, ON_RESULT, TRANSFORM |
| Built-in Functions  | 40+                                          | String, math, formatting, type, array, object, utility, text analysis, security                                                           |
| Expression Engine   | CEL-based                                    | Dual evaluator (legacy + CEL), `abl.*` function namespace                                                                                 |

### 4.2 Runtime Execution Engine

| Component              | Location                                | Purpose                                                        |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------- |
| ExecutionCoordinator   | `apps/runtime/src/services/execution/`  | Message queue, concurrency (serial/preemptive/parallel), dedup |
| RuntimeExecutor        | `apps/runtime/src/services/`            | Session lifecycle orchestration                                |
| FlowStepExecutor       | `apps/runtime/src/services/execution/`  | Scripted state machine, GATHER, intent detection               |
| ReasoningExecutor      | `apps/runtime/src/services/execution/`  | LLM agentic loop (max 10 iterations), tool dispatch            |
| RoutingExecutor        | `apps/runtime/src/services/execution/`  | Handoff, delegate, fan-out, escalate, multi-intent             |
| ConstraintChecker      | `apps/runtime/src/services/execution/`  | Guardrails, business rules, severity routing                   |
| PromptBuilder          | `apps/runtime/src/services/execution/`  | System prompt assembly, tool definition building               |
| SessionLLMClient       | `apps/runtime/src/services/llm/`        | Per-session LLM wrapper, model resolution chain                |
| ModelResolutionService | `apps/runtime/src/services/llm/`        | 5-level credential resolution                                  |
| Guardrail Pipeline     | `apps/runtime/src/services/guardrails/` | Tier 1 (policy) → Tier 2 (webhook) → Tier 3 (LLM)              |
| Session Management     | `apps/runtime/src/services/session/`    | Tiered storage (L1 memory → L2 Redis → L3 MongoDB)             |
| Voice Pipeline         | `apps/runtime/src/services/voice/`      | Jambonz, Kore VG, LiveKit, Twilio                              |
| MCP Integration        | `apps/runtime/src/services/mcp/`        | Project-scoped MCP servers, connection pooling                 |

### 4.3 SearchAI

| Component          | Location                      | Purpose                                             |
| ------------------ | ----------------------------- | --------------------------------------------------- |
| Ingestion Pipeline | `apps/search-ai/src/workers/` | 17 core workers + supporting workers                |
| Worker Phases      | 4 phases                      | Extraction → Analysis → Enrichment → Indexing       |
| Query Runtime      | `apps/search-ai-runtime/`     | Sub-500ms hybrid search (BM25 + semantic)           |
| Python Services    | `services/`                   | Docling (8080), BGE-M3 (8000), Preprocessing (8003) |
| Knowledge Graph    | Workers + DB                  | Entity/relationship extraction, taxonomy            |
| Connector System   | Workers + Routes              | Salesforce, Azure AD, Okta, Google Workspace        |

### 4.4 Studio & Admin

| Component         | Location                                    | Purpose                                                |
| ----------------- | ------------------------------------------- | ------------------------------------------------------ |
| Agent Builder     | `apps/studio/src/components/`               | Visual editor, ABL code editor, canvas                 |
| Arch AI Assistant | `apps/studio/src/lib/arch-ai/`              | AI-driven agent creation (collect → generate → create) |
| Navigation        | `apps/studio/src/store/navigation-store.ts` | Client-side SPA routing via history.pushState          |
| 27 Zustand Stores | `apps/studio/src/store/`                    | State management for all features                      |
| Admin Dashboard   | `apps/admin/`                               | Tenant management, models, usage, audit, health        |

### 4.5 Infrastructure & Cross-Cutting

| Component      | Location                          | Purpose                                               |
| -------------- | --------------------------------- | ----------------------------------------------------- |
| Database Layer | `packages/database/`              | 128 MongoDB models, ClickHouse analytics              |
| Auth & RBAC    | `packages/shared/src/middleware/` | Unified auth (JWT, SDK, API key), permission guards   |
| Encryption     | `packages/shared/src/encryption/` | AES-256-GCM, user/tenant scoped, KMS                  |
| Observability  | `packages/observatory/`           | 22 trace event types, MCP debug server                |
| Event Store    | `packages/eventstore/`            | Kafka events, webhooks, retention policies            |
| Configuration  | `packages/config/`                | Port constants, environment config                    |
| Docker Compose | Root                              | 13 services (MongoDB, Redis, ClickHouse, Kafka, etc.) |

---

## 5. Content Strategy Per Perspective

### 5.1 Product Management

**Narrative:** "What is ABL and what business value does it deliver?"

- **overview.md**: Platform vision, target market, key differentiators vs competitors
- **capabilities.md**: Feature matrix organized by category (agent types, channels, search, analytics, security). Each feature rated: GA / Beta / Experimental
- **use-cases.md**: Walk through 3 real examples (banking, healthcare, travel) from business problem → ABL solution → outcomes. Annotate actual ABL files from `examples/`
- **maturity-matrix.md**: Honest assessment — what's production-ready, what's beta, what's planned. Include voice, SearchAI, workflows, connectors
- **integration-patterns.md**: How ABL fits into enterprise architectures (CRM, ERP, telephony, knowledge bases). Integration via MCP, HTTP tools, webhooks

### 5.2 Developer

**Narrative:** "How do I build and deploy an agent?"

- **getting-started.md**: Prerequisites → install → write first agent → run it → see output. Progressive complexity
- **abl-language-guide.md**: Complete ABL reference. Every construct with syntax, semantics, and real examples. Built-in functions table. Expression language
- **runtime-guide.md**: Execution modes (reasoning vs scripted vs hybrid), session lifecycle, memory, checkpointing, conversation compaction
- **tools-and-integrations.md**: Tool types (HTTP, MCP, sandbox, Lambda), binding syntax, OAuth, tool confirmation, system tools
- **search-ai-guide.md**: Creating indexes, uploading documents, querying, vocabulary management, connector setup
- **studio-guide.md**: Project creation, agent editor, visual canvas, deployment, Arch AI assistant
- **testing-and-debugging.md**: Observatory CLI, trace viewer, eval framework, MCP debug tools
- **deployment.md**: Docker Compose setup, environment variables, port mapping, Helm charts, production checklist
- **cookbook/**: Step-by-step annotated walkthroughs of real examples + common patterns

### 5.3 Architect

**Narrative:** "How does the system work under the hood and why?"

- **system-overview.md**: Complete architecture diagram, service topology, package dependency graph
- **component-deep-dive.md**: Every package and app — purpose, key files, exports, internal structure
- **data-architecture.md**: 128 MongoDB models, ClickHouse tables, Redis usage, Kafka topics, dual-write patterns
- **execution-engine.md**: Full request lifecycle (REST/WS → middleware → coordinator → executors → LLM → response), IR schema, executor chaining
- **llm-orchestration.md**: Model resolution chain (5 levels), provider implementations, credential isolation, caching strategy
- **multi-agent-coordination.md**: Thread model, handoff/delegate/fan-out semantics, multi-intent strategies, state sharing
- **security-and-compliance.md**: Unified auth (3 flows), PII detection/redaction, encryption (AES-256-GCM), SSRF protection, tenant isolation, audit logging
- **observability.md**: 22 trace event types, decision logging, ClickHouse analytics, MCP debug protocol
- **search-ai-architecture.md**: 17-worker pipeline, BullMQ orchestration, hybrid search, sub-500ms query path, Python service integration
- **design-decisions.md**: IR-first compilation, dual execution modes, tiered session storage, CEL expression migration, provider-neutral LLM types
- **known-limitations.md**: Current gaps, performance constraints, scaling considerations, planned improvements

---

## 6. Cross-References to Existing Docs

Each file will reference relevant existing documentation:

| New File                               | References                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `developer/abl-language-guide.md`      | `docs/AGENT_ABL_DESIGN.md`, `docs/ABL_QUICK_REFERENCE.md`, `docs/DSL_EXTENSIONS.md` |
| `developer/runtime-guide.md`           | `docs/RUNTIME_ARCHITECTURE.md`, `docs/FLOW_MODE_DESIGN.md`                          |
| `developer/tools-and-integrations.md`  | `docs/TOOLS_AND_GATHER.md`, `docs/ARCHITECT_TOOLS.md`                               |
| `architect/execution-engine.md`        | `docs/AGENTICAI_ABL_ARCHITECTURE_BLUEPRINT.md`                                      |
| `architect/data-architecture.md`       | `docs/DATA_ARCHITECTURE.md`, `docs/db/`                                             |
| `architect/search-ai-architecture.md`  | `docs/SEARCH_AI_ARCHITECTURE.md`                                                    |
| `architect/security-and-compliance.md` | `docs/SSRF_PROTECTION_IMPLEMENTATION.md`                                            |
| `architect/observability.md`           | `docs/OBSERVABILITY_AND_TRACING.md`, `docs/CLICKHOUSE_OBSERVABILITY.md`             |
| `product/use-cases.md`                 | `examples/banknexus/`, `examples/saludsa-sop/`, `examples/lastminute-sop/`          |

---

## 7. Regeneration & Date Stamp System

### LAST_UPDATED.md Format

```markdown
# Documentation Regeneration Log

Last full regeneration: 2026-03-09

| File                         | Last Updated | Generator   | Notes              |
| ---------------------------- | ------------ | ----------- | ------------------ |
| product/overview.md          | 2026-03-09   | Claude Code | Initial generation |
| developer/getting-started.md | 2026-03-09   | Claude Code | Initial generation |
| ...                          | ...          | ...         | ...                |
```

### Regeneration Workflow

1. Run `/superpowers:brainstorm` to identify what's changed
2. Scan recent git commits for affected subsystems
3. Update only stale files (based on changed components)
4. Update `LAST_UPDATED.md` with new timestamps
5. Each file includes header: `<!-- Generated: 2026-03-09 | Source: abl-platform@<commit-hash> -->`

---

## 8. Quality Standards

- Every claim about the system must be traceable to source code
- Architecture diagrams use ASCII art (portable, no tool dependencies)
- Code examples come from actual `examples/` directory or real source files
- No aspirational features documented as current — maturity matrix is honest
- Each doc file is self-contained but links to related files for depth
- Consistent terminology: "ABL" (language), "AgentIR" (compiled form), "Runtime" (execution), "Studio" (UI)
