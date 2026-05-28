# ABL Platform — Implementation Summary

> **Last Updated**: 2026-03-16

## Platform Components

### Applications

| App                    | Port | Status     | Description                                                         |
| ---------------------- | ---- | ---------- | ------------------------------------------------------------------- |
| **runtime**            | 3112 | Production | Express + WebSocket execution engine, agent runtime, chat API       |
| **studio**             | 5173 | Production | Next.js agent design IDE, project management, Observatory UI        |
| **admin**              | 3003 | Production | Next.js admin dashboard — config, secrets, audit, tenant management |
| **search-ai**          | 3113 | Production | Document ingestion pipeline — BullMQ workers, chunking, embedding   |
| **search-ai-runtime**  | 3114 | Production | Query-time retrieval — RAG, reranking, hybrid search                |
| **workflow-engine**    | 9080 | Production | Restate-backed durable workflow execution                           |
| **observatory-cli**    | —    | Production | Terminal debugger for agent execution traces                        |
| **nlu-sidecar**        | 8092 | Production | NLU intent/entity recognition service                               |
| **multimodal-service** | —    | Active     | Multimodal processing (image, audio)                                |

### Infrastructure (Docker)

| Service    | Port  | Purpose                                   |
| ---------- | ----- | ----------------------------------------- |
| MongoDB    | 27018 | Primary document store                    |
| Redis      | 6380  | Session cache, distributed locks, pub/sub |
| ClickHouse | 8124  | Analytics, event store, trace storage     |
| Kafka      | 19092 | Event streaming                           |
| Restate    | 9070  | Durable execution orchestrator            |
| Neo4j      | 7687  | Knowledge graph                           |
| OpenSearch | 9200  | Vector search (SearchAI)                  |

### Python Services (Docker)

| Service          | Port | Purpose                                 |
| ---------------- | ---- | --------------------------------------- |
| Docling          | 8080 | PDF/document extraction                 |
| BGE-M3           | 8000 | Embedding service (GPU/CPU auto-detect) |
| Preprocessing    | 8003 | Text preprocessing                      |
| Codetool Sandbox | 8001 | gVisor sandboxed code execution         |

### Workspace Packages (~38)

| Category     | Packages                                                              |
| ------------ | --------------------------------------------------------------------- |
| **Language** | core (parser), compiler (IR), analyzer, abl-lsp-server, abl-vscode    |
| **Data**     | database (Mongoose), config, eventstore, redis                        |
| **Shared**   | shared-kernel, shared-auth, shared-observability, i18n                |
| **Runtime**  | execution, llm, pipeline-engine, circuit-breaker, agent-transfer, a2a |
| **Platform** | project-io, connectors, observatory, mcp-debug, sizing-calculator     |
| **UI**       | admin-ui, web-sdk, openapi                                            |

## Recent Major Features (Feb–Mar 2026)

### V2 Import/Export Pipeline

- Layered import with cross-reference resolution across agents, tools, workflows, and config
- V2-only export format (V1 removed)
- Rollback safety, locale routing, temp-field whitelist

### Variable Namespaces

- Scoped environment variable isolation
- Namespace membership management (env vars, config vars, tools)
- Deployment variable snapshots

### Per-Step Reasoning Zones

- Fine-grained control over LLM reasoning within flow steps
- Replaced agent-level MODE with per-step REASONING: true/false

### Agent Transfer Protocol

- Cross-system agent handoffs with A2A protocol support
- Runtime wiring, security hardening, observability hooks

### Self-Service Debugging

- MCP debug tools (connect, diagnose, inspect, get_errors, analyze_session)
- Observatory UI for real-time trace inspection
- Diagnostic engine with P1–P5 priority classification

### Encryption Hardening

- AES-256-GCM encryption at rest with per-tenant KMS key management
- Key rotation, DEK/KEK lifecycle, AWS KMS BYOK support

### ABL Language Tooling

- Language Server Protocol (LSP) implementation
- VS Code extension with syntax highlighting and diagnostics
- Sizing calculator for infrastructure capacity planning

### Package Architecture Refactor

- Decomposed monolithic `shared` package into kernel, auth, observability
- Extracted `redis` package from shared utilities
- API verticalization with `/api/v1/` convention

### Next.js 16 + React 19 Upgrade

- Turbopack for Studio dev server, webpack for Admin dev server
- React Compiler (auto-memoization)
- Proxy middleware (renamed from middleware.ts)

## Release Management

- **Versioning**: CalVer `YYYY.MM.patch` (e.g., `2026.03.0`)
- **Three Repos**: abl-platform (source), abl-platform-deploy (Helm/ArgoCD), abl-platform-infra (Terraform)
- **Flow**: `develop` → `release/YYYY.MM.patch` → `main`
- **CLI**: `./apx release cut`, `./apx release finalize`, `./apx hotfix create/finalize`
