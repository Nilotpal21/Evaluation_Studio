# ABL Platform

A full-stack platform for building, deploying, and operating AI agents using the **Agent Blueprint Language (ABL)** — a declarative language for conversational, system-driven, and hybrid agents with multi-agent orchestration.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                   Clients                                        │
│                Studio (5173)  ·  Admin (3003)  ·  Web SDK  ·  A2A               │
└──────────────┬──────────────────────┬──────────────────────┬─────────────────────┘
               │                      │                      │
               ▼                      ▼                      ▼
┌──────────────────────┐ ┌───────────────────────┐ ┌────────────────────────────┐
│   Runtime (3112)     │ │   SearchAI (3113)     │ │  SearchAI Runtime (3114)   │
│   Express + WS       │ │   Ingestion pipeline  │ │  Query-time retrieval      │
│                      │ │   BullMQ workers      │ │  RAG + reranking           │
│  ┌────────────────┐  │ └───────────┬───────────┘ └──────────┬─────────────────┘
│  │ ABL Compiler   │  │             │                        │
│  │ AST → IR       │  │             ▼                        ▼
│  └────────────────┘  │ ┌───────────────────────────────────────────────────────┐
│  ┌────────────────┐  │ │              Python Services (Docker)                 │
│  │ Executors      │  │ │  Docling (8080) · BGE-M3 (8000) · Preprocessing (8003)│
│  │ Reasoning      │  │ └───────────────────────────────────────────────────────┘
│  │ Flow · Routing │  │
│  │ Gather         │  │
│  └────────────────┘  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           Infrastructure (Docker)                                │
│  MongoDB (27018) · Redis (6380) · ClickHouse (8124) · Kafka (19092)             │
│  Restate (9070) · Neo4j (7687) · OpenSearch (9200)                              │
│  Workflow Engine (9080) · Pipeline Engine (9082)                                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
abl-platform/
├── apps/
│   ├── runtime/              # Express + WebSocket execution engine (:3112)
│   ├── studio/               # Next.js agent design IDE (:5173)
│   ├── admin/                # Next.js admin dashboard (:3003)
│   ├── search-ai/            # Document ingestion pipeline (:3113)
│   ├── search-ai-runtime/    # Query-time retrieval service (:3114)
│   ├── workflow-engine/      # Restate-based workflow execution
│   ├── observatory-cli/      # Terminal debugger for agent traces
│   ├── crawler-go-worker/    # Go-based web crawler worker
│   ├── crawler-mcp-server/   # MCP server for crawler integration
│   ├── nlu-sidecar/          # NLU sidecar service
│   ├── multimodal-service/   # Multimodal processing service
│   └── telco-noc/            # Telecom NOC demo app
│
├── packages/                  # ~38 workspace packages
│   ├── core/                 # ABL parser — lexer, AST, agent/supervisor parsing
│   ├── compiler/             # IR compiler — ABL AST → AgentIR, shared types
│   ├── database/             # MongoDB + Mongoose models
│   ├── config/               # Centralized config and port constants
│   ├── shared-kernel/        # Shared domain primitives
│   ├── shared-auth/          # Authentication middleware
│   ├── shared-observability/ # Distributed tracing, metrics
│   ├── redis/                # Redis client, distributed locks, pub/sub
│   ├── llm/                  # LLM provider abstraction (OpenAI, Anthropic, etc.)
│   ├── execution/            # Execution engine core
│   ├── eventstore/           # Event sourcing store
│   ├── pipeline-engine/      # Pipeline orchestration engine
│   ├── project-io/           # V2 import/export pipeline with cross-ref resolution
│   ├── connectors/           # External data source connectors
│   ├── agent-transfer/       # Agent transfer protocol
│   ├── circuit-breaker/      # Circuit breaker pattern
│   ├── observatory/          # Trace events, spans, debug server
│   ├── mcp-debug/            # MCP tools for runtime debugging
│   ├── i18n/                 # Internationalization
│   ├── a2a/                  # Agent-to-Agent protocol
│   ├── abl-lsp-server/       # ABL Language Server (LSP)
│   ├── abl-vscode/           # VS Code extension for ABL
│   ├── sizing-calculator/    # Infrastructure sizing calculator
│   ├── admin-ui/             # Shared admin UI components
│   ├── analyzer/             # Static analysis rules
│   ├── web-sdk/              # Client-side SDK
│   ├── openapi/              # OpenAPI spec generation
│   └── ...                   # crawler, editor, nl-parser, search-ai-sdk, etc.
│
├── services/                  # Python microservices (Docker)
│   ├── docling-service/      # PDF/document extraction (FastAPI, :8080)
│   ├── bge-m3-service/       # BGE-M3 embedding service (Flask, :8000)
│   ├── preprocessing-service/# Text preprocessing (Flask, :8003)
│   └── codetool-sandbox/     # Sandboxed code execution
│
├── examples/                  # ABL example projects
│   ├── banknexus/            # Banking agents
│   ├── travel/               # Travel booking agents
│   ├── saludsa/              # Healthcare agents
│   ├── telco/                # Telecom agents
│   ├── retail/               # Retail agents
│   └── ...                   # airlines, guardrails, agent-transfer, a2a-demo
│
├── docs/                      # Documentation
│   ├── reference/            # ABL spec, quick reference, cookbook
│   ├── design/               # Feature design docs
│   ├── architecture/         # Architecture docs, runtime, data, encryption
│   ├── searchai/             # SearchAI platform docs
│   ├── rfcs/                 # RFCs
│   └── plans/                # Implementation plans
│
├── docker-compose.yml         # All infrastructure services
└── apx                        # CLI tool for service management and releases
```

## Key Concepts

### ABL Constructs

| Construct      | Purpose                                                     |
| -------------- | ----------------------------------------------------------- |
| `AGENT`        | Define an agent with identity, tools, and behaviors         |
| `GATHER`       | Collect information from users (LLM-based extraction)       |
| `MEMORY`       | Session and persistent state management                     |
| `CONSTRAINTS`  | Guardrails and business rules                               |
| `DELEGATE`     | Invoke sub-agents                                           |
| `HANDOFF`      | Transfer control to another agent                           |
| `ESCALATE`     | Transfer to human agents                                    |
| `COMPLETE`     | Session completion conditions                               |
| `ON_ERROR`     | Error handling strategies                                   |
| `FLOW`         | Scripted interaction flows (enhanced)                       |
| `SET`          | Variable assignment with expressions and built-in functions |
| `CLEAR`        | Delete session variables (reset state for loops)            |
| `CALL WITH/AS` | Explicit tool parameters and result variable binding        |
| `ON_RESULT`    | Multi-way branching on tool call results                    |
| `TRANSFORM`    | Array data pipeline (FILTER, MAP, SORT_BY, LIMIT)           |

### Enhanced FLOW Mode (Scripted)

FLOW mode supports advanced interaction control:

| Feature                 | Description                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GATHER` within FLOW    | Multi-field collection with LLM extraction                                                                 |
| `DIGRESSIONS`           | Intent-based escapes (global or step-level)                                                                |
| `SUB_INTENTS`           | Scoped intents within a step                                                                               |
| `ON_SUCCESS/ON_FAILURE` | Call result branches                                                                                       |
| `PRESENT`               | Presentation templates before collection                                                                   |
| `CORRECTIONS`           | Allow natural corrections ("actually 4 not 3")                                                             |
| `SET` / `CLEAR`         | Computed variable assignments and session state reset                                                      |
| `CALL WITH/AS`          | Named parameters for tool calls with result binding                                                        |
| `ON_RESULT`             | Multi-way conditional branching on tool results (replaces simple ON_SUCCESS/ON_FAIL)                       |
| `TRANSFORM`             | Declarative array pipeline: `FILTER` -> `MAP` -> `SORT_BY` -> `LIMIT`                                      |
| Built-in Functions (35) | Math, string, formatting, type, array, object, utility functions for use in SET/TRANSFORM/WITH expressions |

### Runtime Execution

The runtime (`apps/runtime/`) executes compiled AgentIR through specialized executors:

- **ReasoningExecutor**: LLM-driven agentic loop with tool use and per-step reasoning zones
- **FlowStepExecutor**: Scripted state-machine execution (FLOW mode)
- **RoutingExecutor**: Supervisor routing, handoffs, delegation
- **ConstraintChecker**: Guardrails and business rule enforcement
- **GatherExecutor**: Multi-field information collection with LLM extraction

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** (package manager)
- **Docker** and **Docker Compose** (for infrastructure services)

### Setup

```bash
# Clone the repository
git clone <repo-url> && cd abl-platform

# Install dependencies
pnpm install

# Start infrastructure (MongoDB, Redis, ClickHouse, Kafka, etc.)
docker compose up -d

# Build all packages (required before running tests or apps)
pnpm build

# For systems with 8GB RAM or less, use low-memory build mode
pnpm build:low-mem

# Start the runtime
pnpm --filter @agent-platform/runtime dev

# Start Studio
pnpm --filter @agent-platform/studio dev

# Run tests (build first — Turbo enforces build order)
pnpm build && pnpm test
```

### Service Management

The `apx` CLI tool manages services, builds, and releases:

```bash
./apx start          # Start services
./apx build          # Build packages
./apx release        # Manage releases
```

## Example ABL

```
AGENT: Customer_Service

GOAL: "Help customers with account inquiries"

PERSONA: |
  You are a helpful customer service agent.
  Be polite and professional.

TOOLS:
  verify_identity(document_type: string, id: string) -> VerificationResult
  get_account(user_id: string) -> AccountInfo

GATHER:
  name:
    prompt: "What is your name?"
    type: string
    required: true
  email:
    prompt: "What is your email?"
    type: string
    required: true

CONSTRAINTS:
  guardrails:
    - rule: "Cannot share other customer data"
      on_fail: respond("I cannot share other customers' information")

COMPLETE:
  when: issue_resolved == true
  message: "Thank you for contacting us!"
```

## Testing

```bash
# Run all tests (build first)
pnpm build && pnpm test

# For memory-constrained environments (8GB RAM or less)
pnpm build:low-mem && pnpm test:low-mem

# Run tests for a specific package
pnpm --filter @abl/compiler test

# Run tests with coverage
pnpm --filter @abl/compiler test -- --coverage

# Run specific test suites
pnpm --filter @abl/compiler test -- constructs    # Unit tests
pnpm --filter @abl/compiler test -- e2e           # End-to-end tests
```

### Low-Memory Mode

For Docker containers or systems with limited RAM (8GB or less):

```bash
# Low-memory build (concurrency=1, 7GB Node heap)
pnpm build:low-mem

# Low-memory tests (concurrency=1, 6GB Node heap)
pnpm test:low-mem

# Use in pre-push hook (15-minute timeouts)
LOW_MEM=1 git push origin develop
```

## Documentation

Comprehensive documentation is organized in the `docs/` directory:

| Directory                                  | Description                                            |
| ------------------------------------------ | ------------------------------------------------------ |
| [docs/reference/](./docs/reference/)       | ABL spec, quick reference, cookbook, DSL extensions    |
| [docs/design/](./docs/design/)             | Feature design docs (import/export, sessions, OpenAPI) |
| [docs/architecture/](./docs/architecture/) | Runtime, data, encryption, observability architecture  |
| [docs/searchai/](./docs/searchai/)         | SearchAI platform documentation                        |
| [docs/rfcs/](./docs/rfcs/)                 | RFCs for proposed changes                              |
| [docs/plans/](./docs/plans/)               | Implementation plans                                   |

## Architecture Notes

1. **IR-First Compilation**: ABL source compiles to an Intermediate Representation (AgentIR) — the single source of truth for runtime execution. The compiler produces IR and exports shared types/pure functions; all execution lives in the runtime.
2. **Dual Execution Modes**: Reasoning (LLM-driven agentic loop) and Scripted (FLOW state machine). Agents infer their mode from the presence of GOAL + FLOW constructs.
3. **Multi-Agent Coordination**: Supervisor routing, HANDOFF, DELEGATE, ESCALATE, fan-out, and the Agent Transfer Protocol for cross-system handoffs.
4. **V2 Import/Export**: Layered import pipeline with cross-reference resolution for project portability across environments.
5. **SearchAI Pipeline**: Document ingestion (chunking, embedding, indexing) via BullMQ workers, with query-time retrieval and RAG in a separate runtime.
6. **Agent Observatory**: Remote debugging via WebSocket for execution tracing, plus MCP debug tools for self-service diagnosis.
7. **ABL Tooling**: Language Server (LSP) for IDE support, VS Code extension, and the `apx` CLI for service management.
8. **Encryption Hardening**: AES-256-GCM encryption at rest with per-tenant KMS key management.
9. **Variable Namespaces**: Scoped variable isolation across agent contexts.
10. **Per-Step Reasoning Zones**: Fine-grained control over LLM reasoning within flow steps.

## Repository Ecosystem

| Repository              | Purpose                          |
| ----------------------- | -------------------------------- |
| **abl-platform**        | Source code (this repo)          |
| **abl-platform-deploy** | Helm charts, ArgoCD manifests    |
| **abl-platform-infra**  | Terraform infrastructure-as-code |
