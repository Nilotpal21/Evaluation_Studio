# ABL Platform Merge Specification

## AgenticAI + Agent Blueprint Language (ABL) Unified Platform

**Version:** 1.0
**Date:** 2026-02-07
**Status:** Draft
**Authors:** Platform Engineering

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Priority Matrix](#3-priority-matrix)
4. [Phase 0 — Foundation](#4-phase-0--foundation)
5. [Phase 1 — Data Layer](#5-phase-1--data-layer)
6. [Phase 2 — Message Ingestion & Buffering](#6-phase-2--message-ingestion--buffering)
7. [Phase 3 — Circuit Breakers & Resilience](#7-phase-3--circuit-breakers--resilience)
8. [Phase 4 — Unified Observability](#8-phase-4--unified-observability)
9. [Phase 5 — Feature Porting](#9-phase-5--feature-porting)
10. [Phase 6 — Frontend Consolidation](#10-phase-6--frontend-consolidation)
11. [Migration Checklist](#11-migration-checklist)
12. [Data Migration Playbook](#12-data-migration-playbook)
13. [Risk Register](#13-risk-register)
14. [Appendix A — Schema Mappings](#appendix-a--schema-mappings)
15. [Appendix B — API Compatibility Matrix](#appendix-b--api-compatibility-matrix)
16. [Appendix C — Decision Log](#appendix-c--decision-log)

---

## 1. Executive Summary

### Goal

Merge AgenticAI (production runtime platform) and ABL (DSL-driven agent authoring platform) into a single unified platform where:

- **ABL is the primary codebase** — its DSL pipeline (parser > compiler > IR > runtime) is the core differentiator
- **AgenticAI's operational strengths are ported into ABL** — production-grade infrastructure, scale patterns, and battle-tested features
- The merged platform handles both **voice and digital interactions at enterprise scale**
- Every AgenticAI capability has an ABL construct or platform service equivalent

### What Each Project Brings

| AgenticAI (Porting FROM)          | ABL (Building ON)                               |
| --------------------------------- | ----------------------------------------------- |
| 50+ MongoDB data models           | DSL parser + compiler + IR pipeline             |
| Graph-based runtime               | 3 specialized runtimes (voice/digital/workflow) |
| RabbitMQ async processing         | BullMQ migration target                         |
| Redis caching + pub/sub           | Redis already planned                           |
| Socket.IO real-time               | WebSocket real-time (native ws)                 |
| NestJS modular backend            | Express modular backend                         |
| Angular + React UI                | React Studio + Editor                           |
| K8s + Docker deployment           | Docker (K8s to be ported)                       |
| Langfuse tracing integration      | Observatory debugging system                    |
| Multi-tenant data patterns        | Multi-tenant roadmap (planned)                  |
| LLM retry/fallback chains         | Construct executor pipeline                     |
| Voice (OpenAI RT/Ultravox/Gemini) | Voice runtime (streaming, transcript)           |

### Key Architecture Decisions (Resolved)

| Decision            | Choice                              | Rationale                                                   |
| ------------------- | ----------------------------------- | ----------------------------------------------------------- |
| Primary codebase    | ABL (agent-dsl)                     | Cleaner architecture, DSL is differentiator                 |
| Backend framework   | Express (ABL's choice)              | Lighter weight, modular routing                             |
| Frontend framework  | React (ABL Studio)                  | Modern, Vite-based, component library exists                |
| Structured data DB  | PostgreSQL via Prisma               | Type-safe, migrations, ABL already uses it                  |
| Operational data DB | MongoDB via Mongoose                | TTL, Mixed types, high-write performance                    |
| Analytics DB        | ClickHouse                          | Time-series queries, trace analytics (per existing roadmap) |
| Message queue       | BullMQ + Redis                      | Right-sized, already in stack, replaces RabbitMQ            |
| Observability       | Observatory (dev) + Langfuse (prod) | Complementary, not competing                                |
| Build system        | Turbo + pnpm                        | ABL's existing setup                                        |
| Monorepo structure  | ABL's packages/ + apps/             | Already well-organized                                      |

---

## 2. Architecture Overview

### Target System Architecture

```
                            CLIENTS
            ┌────────────────┼────────────────┐
            │                │                │
       Voice Clients    Web/Mobile       API Consumers
       (Telephony,      (Chat, WhatsApp,  (REST, SDK,
        WebRTC)          SMS, Email)       Webhooks)
            │                │                │
════════════╪════════════════╪════════════════╪══════════════
            │         INGRESS LAYER           │
            │                │                │
       ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
       │  Voice  │     │ Digital │     │   API   │
       │ Gateway │     │ Gateway │     │ Gateway │
       └────┬────┘     └────┬────┘     └────┬────┘
            │                │                │
       ┌────▼────────────────▼────────────────▼────┐
       │              TENANT GATE                   │
       │  ┌──────────┐ ┌──────────┐ ┌───────────┐ │
       │  │   Auth   │ │  Rate    │ │  Circuit  │ │
       │  │  + RBAC  │ │ Limiter  │ │  Breaker  │ │
       │  └──────────┘ └──────────┘ └───────────┘ │
       └───────────────────┬───────────────────────┘
                           │
       ┌───────────────────▼───────────────────────┐
       │           MESSAGE BUFFER                   │
       │           (BullMQ / Redis)                 │
       │                                            │
       │  ┌───────────┐ ┌──────────┐ ┌──────────┐ │
       │  │voice:high │ │digital:  │ │ api:low  │ │
       │  │ priority  │ │ normal   │ │ priority │ │
       │  └───────────┘ └──────────┘ └──────────┘ │
       │  ┌──────────────────────────────────────┐ │
       │  │ retry:deferred  │  dead-letter       │ │
       │  └──────────────────────────────────────┘ │
       └───────────────────┬───────────────────────┘
                           │
════════════════════════════╪═══════════════════════════
                           │
       ┌───────────────────▼───────────────────────┐
       │            WORKER POOL                     │
       │    (per-tenant concurrency limits)         │
       └───────────────────┬───────────────────────┘
                           │
       ┌───────────────────▼───────────────────────┐
       │          ABL RUNTIME ENGINE                │
       │                                            │
       │  ┌──────────────────────────────────────┐ │
       │  │         ConstructExecutor             │ │
       │  │  ┌────────┐ ┌────────┐ ┌──────────┐ │ │
       │  │  │Reasoning│ │Scripted│ │ Workflow │ │ │
       │  │  │Executor │ │Executor│ │ Executor │ │ │
       │  │  └────────┘ └────────┘ └──────────┘ │ │
       │  │  ┌────────┐ ┌────────┐ ┌──────────┐ │ │
       │  │  │Gather  │ │Handoff │ │Constraint│ │ │
       │  │  │Executor│ │Executor│ │ Executor │ │ │
       │  │  └────────┘ └────────┘ └──────────┘ │ │
       │  └──────────────────────────────────────┘ │
       │                                            │
       │  ┌─────────────────┐ ┌──────────────────┐ │
       │  │  LLM Provider   │ │  Tool Executor   │ │
       │  │  Abstraction    │ │  (with breakers) │ │
       │  │  ┌───────────┐  │ │  ┌────────────┐  │ │
       │  │  │ Anthropic │  │ │  │ ServiceNode│  │ │
       │  │  │ OpenAI    │  │ │  │ Lambda/    │  │ │
       │  │  │ Azure     │  │ │  │ GVisor     │  │ │
       │  │  │ LiteLLM   │  │ │  │ HTTP APIs  │  │ │
       │  │  └───────────┘  │ │  └────────────┘  │ │
       │  └─────────────────┘ └──────────────────┘ │
       └───────────────────┬───────────────────────┘
                           │
════════════════════════════╪═══════════════════════════
                           │
       ┌───────────────────▼───────────────────────┐
       │             DATA LAYER                     │
       │                                            │
       │  ┌─────────────┐  ┌────────────────────┐  │
       │  │ PostgreSQL  │  │     MongoDB         │  │
       │  │ (Prisma)    │  │   (Mongoose)        │  │
       │  │             │  │                     │  │
       │  │ accounts    │  │ sessions            │  │
       │  │ workspaces  │  │ runs                │  │
       │  │ projects    │  │ conversations       │  │
       │  │ agents      │  │ session_views (TTL) │  │
       │  │ tools       │  │ execution_traces    │  │
       │  │ envs        │  │ url_hashes (TTL)    │  │
       │  │ api_keys    │  │                     │  │
       │  │ audit_logs  │  │                     │  │
       │  │ model_cfg   │  │                     │  │
       │  │ credentials │  │                     │  │
       │  └─────────────┘  └────────────────────┘  │
       │                                            │
       │  ┌─────────────┐  ┌────────────────────┐  │
       │  │   Redis     │  │   ClickHouse       │  │
       │  │             │  │   (analytics)       │  │
       │  │ cache       │  │                     │  │
       │  │ pub/sub     │  │ trace_events        │  │
       │  │ BullMQ      │  │ usage_metrics       │  │
       │  │ sessions    │  │ cost_analytics      │  │
       │  │ breakers    │  │                     │  │
       │  └─────────────┘  └────────────────────┘  │
       └───────────────────────────────────────────┘
                           │
════════════════════════════╪═══════════════════════════
                           │
       ┌───────────────────▼───────────────────────┐
       │          OBSERVABILITY                     │
       │                                            │
       │  ┌─────────────────┐ ┌──────────────────┐ │
       │  │   Observatory   │ │    Langfuse       │ │
       │  │   (dev-time)    │ │   (production)    │ │
       │  │                 │ │                    │ │
       │  │ Breakpoints     │ │ Cost tracking     │ │
       │  │ State inspect   │ │ Prompt versioning │ │
       │  │ Step-through    │ │ Evaluations       │ │
       │  │ IDE integration │ │ User feedback     │ │
       │  │ WebSocket debug │ │ Historical traces │ │
       │  └─────────────────┘ └──────────────────┘ │
       └───────────────────────────────────────────┘
```

### Monorepo Structure (Target)

```
abl-platform/
├── packages/                         # Shared libraries
│   ├── core/                        # ABL parser, lexer, types (KEEP)
│   ├── compiler/                    # IR compiler, executors (KEEP)
│   ├── analyzer/                    # Static analysis (KEEP)
│   ├── editor/                      # React visual editor (KEEP)
│   ├── nl-parser/                   # NL → ABL conversion (KEEP)
│   ├── observatory/                 # Debug protocol + events (KEEP)
│   ├── kore-platform-cli/           # CLI tools (KEEP)
│   ├── mcp-debug/                   # MCP server (KEEP)
│   ├── queue/                       # NEW — BullMQ abstraction
│   ├── circuit-breaker/             # NEW — Redis-backed breakers
│   ├── cache/                       # NEW — Redis cache abstraction
│   ├── mongo/                       # NEW — Mongoose models (from AgenticAI)
│   ├── langfuse-adapter/            # NEW — Observatory→Langfuse bridge
│   ├── encryption/                  # NEW — AES-256 field encryption (from AgenticAI)
│   ├── tenant/                      # NEW — Multi-tenant context + RBAC
│   └── shared/                      # NEW — Common types, utils
│
├── apps/
│   ├── platform/                    # API server (EXTEND — Express + Prisma)
│   │   ├── prisma/
│   │   │   └── schema.prisma        # EXTEND — add AgenticAI models
│   │   └── src/
│   │       ├── modules/             # NEW — domain modules
│   │       │   ├── agents/          #   agent CRUD, versioning
│   │       │   ├── sessions/        #   session management
│   │       │   ├── conversations/   #   conversation history
│   │       │   ├── runs/            #   execution records
│   │       │   ├── tools/           #   tool registry
│   │       │   ├── environments/    #   deployment targets
│   │       │   ├── api-keys/        #   API auth
│   │       │   ├── files/           #   file management
│   │       │   ├── import-export/   #   data import/export
│   │       │   └── diagnostics/     #   system diagnostics
│   │       ├── middleware/
│   │       │   ├── rate-limiter.ts  # EXTEND — Redis-backed
│   │       │   ├── circuit-breaker.ts # NEW
│   │       │   └── tenant-gate.ts   # NEW
│   │       ├── gateways/
│   │       │   ├── voice.gateway.ts # NEW — voice message ingress
│   │       │   ├── digital.gateway.ts # NEW — chat message ingress
│   │       │   └── api.gateway.ts   # EXTEND — REST API ingress
│   │       ├── workers/
│   │       │   ├── voice.worker.ts  # NEW — BullMQ voice processor
│   │       │   ├── digital.worker.ts # NEW — BullMQ digital processor
│   │       │   └── api.worker.ts    # NEW — BullMQ API processor
│   │       ├── services/            # EXTEND — existing + ported
│   │       └── llm/                 # KEEP — LLM provider layer
│   │
│   ├── studio/                      # Frontend IDE (KEEP + extend)
│   │   └── src/
│   │       ├── components/          # EXTEND — port AgenticAI UI features
│   │       └── views/               # EXTEND — add ops dashboards
│   │
│   └── observatory-cli/             # Debug CLI (KEEP)
│
├── deploy/                          # NEW — from AgenticAI
│   ├── k8s/                         # Kubernetes manifests
│   ├── docker/                      # Dockerfiles per service
│   ├── docker-compose.yml           # Local dev environment
│   └── nginx/                       # Reverse proxy config
│
├── migrations/                      # NEW — data migration scripts
│   ├── mongo-to-prisma/             # PostgreSQL migration scripts
│   └── agenticai-import/            # AgenticAI data import tools
│
├── examples/                        # ABL examples (KEEP)
├── docs/                            # Documentation (EXTEND)
├── turbo.json                       # Build config (KEEP)
├── pnpm-workspace.yaml              # Workspace config (EXTEND)
└── package.json                     # Root config (KEEP)
```

---

## 3. Priority Matrix

### Phase Overview

| Phase  | Name                          | Duration   | Dependencies | Risk   |
| ------ | ----------------------------- | ---------- | ------------ | ------ |
| **P0** | Foundation                    | Week 1-2   | None         | Low    |
| **P1** | Data Layer                    | Week 2-5   | P0           | Medium |
| **P2** | Message Ingestion & Buffering | Week 4-7   | P0           | Medium |
| **P3** | Circuit Breakers & Resilience | Week 5-8   | P1, P2       | Medium |
| **P4** | Unified Observability         | Week 6-9   | P1           | Low    |
| **P5** | Feature Porting               | Week 8-14  | P1, P2, P3   | High   |
| **P6** | Frontend Consolidation        | Week 10-16 | P5           | Medium |

### Dependency Graph

```
P0: Foundation
 ├──► P1: Data Layer
 │     ├──► P3: Circuit Breakers (needs Redis + data models)
 │     ├──► P4: Observability (needs trace storage)
 │     └──► P5: Feature Porting (needs data models in place)
 │              └──► P6: Frontend (needs backend APIs)
 └──► P2: Message Ingestion
       └──► P3: Circuit Breakers (needs queue infrastructure)
```

### Priority Classification

**P0 — Must have before anything else:**

- Monorepo restructure
- Shared package scaffolding
- Docker-compose for local dev (PostgreSQL + MongoDB + Redis)
- CI/CD pipeline

**P1 — Must have for data integrity:**

- Prisma schema extensions (AgenticAI models)
- MongoDB connection + Mongoose models package
- Dual-database service layer
- Data migration scripts

**P2 — Must have for production scale:**

- BullMQ queue infrastructure
- Voice/digital message gateways
- Worker pool with concurrency control
- Backpressure signaling

**P3 — Must have for production reliability:**

- Redis-backed circuit breaker library
- Tenant-level breakers
- App-level breakers
- LLM provider breakers
- Tool/service breakers

**P4 — Must have for production operations:**

- Langfuse adapter (Observatory events → Langfuse)
- ClickHouse trace persistence
- Unified trace correlation IDs
- Cost tracking pipeline

**P5 — Required for feature parity:**

- Port AgenticAI modules to ABL platform
- Agent versioning, environments, import/export
- File management, PII configs, diagnostics
- API compatibility layer

**P6 — Required for user experience:**

- Port Angular UI features to React Studio
- Operations dashboard
- Tenant admin views

---

## 4. Phase 0 — Foundation

**Duration:** Week 1-2
**Goal:** Prepare the ABL codebase to receive AgenticAI components

### 4.1 Monorepo Restructure

**Tasks:**

- [ ] Create new package directories:
  ```
  packages/queue/
  packages/circuit-breaker/
  packages/cache/
  packages/mongo/
  packages/langfuse-adapter/
  packages/encryption/
  packages/tenant/
  packages/shared/
  ```
- [ ] Scaffold each package with:
  - `package.json` (scoped to `@abl/` namespace)
  - `tsconfig.json` (extending root)
  - `src/index.ts` (barrel export)
  - `vitest.config.ts`
- [ ] Update `turbo.json` build pipeline to include new packages
- [ ] Update `pnpm-workspace.yaml` to include new packages

**Package naming convention:**

```
@abl/core             # existing
@abl/compiler         # existing
@abl/queue            # new — BullMQ abstraction
@abl/circuit-breaker  # new — resilience
@abl/cache            # new — Redis abstraction
@abl/mongo            # new — Mongoose models
@abl/langfuse         # new — Langfuse adapter
@abl/encryption       # new — field-level encryption
@abl/tenant           # new — multi-tenancy
@abl/shared           # new — common types/utils
```

### 4.2 Docker Compose (Local Dev)

```yaml
# deploy/docker-compose.yml
services:
  postgres:
    image: postgres:16
    ports: ['5432:5432']
    environment:
      POSTGRES_DB: abl_platform
      POSTGRES_USER: abl
      POSTGRES_PASSWORD: abl_dev
    volumes:
      - pg_data:/var/lib/postgresql/data

  mongodb:
    image: mongo:7
    ports: ['27017:27017']
    environment:
      MONGO_INITDB_ROOT_USERNAME: abl
      MONGO_INITDB_ROOT_PASSWORD: abl_dev
      MONGO_INITDB_DATABASE: abl_operational
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

  clickhouse:
    image: clickhouse/clickhouse-server:24
    ports: ['8123:8123', '9000:9000']
    volumes:
      - ch_data:/var/lib/clickhouse

  # BullMQ dashboard (development only)
  bull-board:
    image: deadly0/bull-board:latest
    ports: ['3100:3000']
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379

volumes:
  pg_data:
  mongo_data:
  ch_data:
```

### 4.3 Shared Types Package (`@abl/shared`)

```typescript
// packages/shared/src/types/tenant.ts
export interface TenantContext {
  accountId: string;
  workspaceId: string;
  userId: string;
  roles: Role[];
}

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

// packages/shared/src/types/channel.ts
export type Channel = 'voice' | 'web_chat' | 'whatsapp' | 'sms' | 'email' | 'api';

export type MessagePriority = 'critical' | 'high' | 'normal' | 'low';

export interface IncomingMessage {
  id: string;
  tenantContext: TenantContext;
  channel: Channel;
  sessionId: string;
  content: string | VoiceInput;
  attachments?: Attachment[];
  metadata: Record<string, unknown>;
  receivedAt: Date;
  priority: MessagePriority;
}

// packages/shared/src/types/breaker.ts
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type BreakerLevel = 'tenant' | 'app' | 'llm_provider' | 'tool_service';

// packages/shared/src/types/queue.ts
export interface QueuedJob<T = unknown> {
  id: string;
  tenantContext: TenantContext;
  channel: Channel;
  priority: MessagePriority;
  payload: T;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: Date;
  timeout: number;
}
```

### 4.4 CI/CD Pipeline

- [ ] GitHub Actions / Bitbucket Pipelines workflow:
  - `turbo build` — all packages
  - `turbo test` — all test suites
  - `turbo lint` — code quality
  - Docker image build per app (platform, studio)
  - Prisma migration check (no pending migrations)

### 4.5 Environment Configuration

```typescript
// packages/shared/src/config/index.ts
export interface PlatformConfig {
  // PostgreSQL (Prisma)
  database: {
    url: string; // DATABASE_URL
    maxConnections: number; // default: 20
  };

  // MongoDB (Mongoose)
  mongodb: {
    uri: string; // MONGODB_URI
    database: string; // MONGODB_DATABASE
    poolSize: number; // default: 10
  };

  // Redis
  redis: {
    host: string; // REDIS_HOST
    port: number; // REDIS_PORT
    password?: string; // REDIS_PASSWORD
    tls?: boolean; // REDIS_TLS
    db: {
      cache: number; // 0 — general cache
      queue: number; // 1 — BullMQ queues
      breaker: number; // 2 — circuit breaker state
      pubsub: number; // 3 — pub/sub channels
    };
  };

  // ClickHouse
  clickhouse: {
    url: string; // CLICKHOUSE_URL
    database: string; // CLICKHOUSE_DATABASE
  };

  // Langfuse
  langfuse: {
    baseUrl: string; // LANGFUSE_BASE_URL
    publicKey: string; // LANGFUSE_PUBLIC_KEY
    secretKey: string; // LANGFUSE_SECRET_KEY
    enabled: boolean; // LANGFUSE_ENABLED
    flushInterval: number; // default: 5000ms
    batchSize: number; // default: 50
  };

  // Queue
  queue: {
    voice: {
      concurrency: number; // default: 20
      timeout: number; // default: 5000ms
      maxRetries: number; // default: 2
    };
    digital: {
      concurrency: number; // default: 50
      timeout: number; // default: 30000ms
      maxRetries: number; // default: 3
    };
    api: {
      concurrency: number; // default: 30
      timeout: number; // default: 60000ms
      maxRetries: number; // default: 3
    };
  };
}
```

---

## 5. Phase 1 — Data Layer

**Duration:** Week 2-5
**Goal:** Establish the hybrid PostgreSQL + MongoDB data layer

### 5.1 Prisma Schema Extensions

Extend ABL's existing Prisma schema to absorb AgenticAI's structured models.

**New models to add (from AgenticAI):**

```prisma
// ── Multi-Tenancy (aligns with existing ABL roadmap) ──────────

model Account {
  id            String      @id @default(cuid())
  name          String
  slug          String      @unique
  plan          PlanType    @default(FREE)
  status        AccountStatus @default(ACTIVE)
  settings      Json?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  workspaces    Workspace[]
  members       AccountMember[]
  apiKeys       ApiKey[]
  auditLogs     AuditLog[]
}

model Workspace {
  id            String      @id @default(cuid())
  accountId     String
  name          String
  slug          String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  account       Account     @relation(fields: [accountId], references: [id])
  projects      Project[]
  members       WorkspaceMember[]

  @@unique([accountId, slug])
  @@index([accountId])
}

// ── Agent Management ──────────────────────────────────────────

model Agent {
  id            String      @id @default(cuid())
  projectId     String
  name          String
  normalizedName String
  type          AgentType
  role          AgentRole?
  description   String?
  icon          Json?
  status        AgentStatus @default(DRAFT)
  isPublished   Boolean     @default(false)
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  project       Project     @relation(fields: [projectId], references: [id])
  versions      AgentVersion[]

  @@unique([projectId, normalizedName])
  @@index([projectId, status])
}

model AgentVersion {
  id            String      @id @default(cuid())
  agentId       String
  version       String
  label         String?
  ablSource     String?     // ABL DSL source code
  compiledIR    Json?       // Compiled IR (cached)
  irHash        String?     // Source hash for cache invalidation
  config        Json        // Full agent configuration
  inputs        Json?       // Input schema definitions
  outputs       Json?       // Output schema definitions
  events        Json?       // Event definitions
  llmModel      Json?       // LLM configuration
  isActive      Boolean     @default(false)
  createdBy     String
  createdAt     DateTime    @default(now())

  agent         Agent       @relation(fields: [agentId], references: [id])

  @@unique([agentId, version])
  @@index([agentId, isActive])
}

// ── Tools & Integrations ─────────────────────────────────────

model Tool {
  id            String      @id @default(cuid())
  projectId     String
  name          String
  normalizedName String
  type          ToolType
  description   String?
  icon          Json?
  isEnabled     Boolean     @default(true)
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  project       Project     @relation(fields: [projectId], references: [id])
  versions      ToolVersion[]

  @@unique([projectId, normalizedName])
  @@index([projectId, isEnabled])
}

model ToolVersion {
  id            String      @id @default(cuid())
  toolId        String
  version       String
  configuration Json        // Tool-specific config
  schema        Json?       // Input/output JSON Schema
  isActive      Boolean     @default(false)
  createdBy     String
  createdAt     DateTime    @default(now())

  tool          Tool        @relation(fields: [toolId], references: [id])

  @@unique([toolId, version])
}

// ── Environments ─────────────────────────────────────────────

model Environment {
  id            String      @id @default(cuid())
  projectId     String
  name          String
  normalizedName String
  type          EnvironmentType @default(DEVELOPMENT)
  endpoints     Json?       // Array of endpoint configurations
  agentEndpoints Json?      // Agent-specific endpoints
  variables     Json?       // Environment variables (encrypted at app layer)
  isActive      Boolean     @default(true)
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  project       Project     @relation(fields: [projectId], references: [id])

  @@unique([projectId, normalizedName])
  @@index([projectId, type])
}

// ── API Keys ─────────────────────────────────────────────────

model ApiKey {
  id            String      @id @default(cuid())
  accountId     String
  projectId     String?
  name          String
  normalizedName String
  keyHash       String      // bcrypt hash of actual key
  keyPrefix     String      // First 8 chars for identification
  scopeId       String?
  isEnabled     Boolean     @default(true)
  lastUsedAt    DateTime?
  expiresAt     DateTime?
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  account       Account     @relation(fields: [accountId], references: [id])

  @@unique([accountId, projectId, normalizedName])
  @@index([keyPrefix])
  @@index([accountId, isEnabled])
}

model ApiScope {
  id            String      @id @default(cuid())
  accountId     String
  projectId     String?
  name          String
  normalizedName String
  description   String?
  scopes        Json        // Permission definitions
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@unique([accountId, projectId, normalizedName])
}

// ── Scanners & PII ───────────────────────────────────────────

model Scanner {
  id            String      @id @default(cuid())
  projectId     String
  name          String
  type          ScannerType
  config        Json
  isEnabled     Boolean     @default(true)
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  project       Project     @relation(fields: [projectId], references: [id])

  @@index([projectId, isEnabled])
}

model PiiConfig {
  id            String      @id @default(cuid())
  projectId     String
  name          String
  normalizedName String
  redactionRules Json       // PII detection and redaction rules
  isEnabled     Boolean     @default(true)
  createdBy     String
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  project       Project     @relation(fields: [projectId], references: [id])

  @@unique([projectId, normalizedName])
}

// ── Audit ────────────────────────────────────────────────────

model AuditLog {
  id            String      @id @default(cuid())
  accountId     String
  workspaceId   String?
  userId        String
  action        String      // e.g., "agent.create", "session.delete"
  resource      String      // e.g., "agent", "session"
  resourceId    String?
  details       Json?       // Action-specific details
  ipAddress     String?
  userAgent     String?
  createdAt     DateTime    @default(now())

  account       Account     @relation(fields: [accountId], references: [id])

  @@index([accountId, createdAt])
  @@index([accountId, userId, createdAt])
  @@index([accountId, resource, createdAt])
}

// ── Component Limits ─────────────────────────────────────────

model ComponentLimit {
  id            String      @id @default(cuid())
  accountId     String?     // null = global default
  resource      String      // e.g., "agents", "tools", "environments"
  maxCount      Int
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@unique([accountId, resource])
}

// ── Enums ────────────────────────────────────────────────────

enum PlanType {
  FREE
  STARTER
  PROFESSIONAL
  ENTERPRISE
}

enum AccountStatus {
  ACTIVE
  SUSPENDED
  DEACTIVATED
}

enum AgentType {
  TASK
  PLANNER
  VALIDATOR
  COORDINATOR
  AUTONOMOUS
  SUPERVISOR
}

enum AgentRole {
  SUPERVISOR
  WORKER
}

enum AgentStatus {
  DRAFT
  ACTIVE
  ARCHIVED
  DEPRECATED
}

enum ToolType {
  BUILT_IN
  CUSTOM
  EXTERNAL
  LAMBDA
  GVISOR
}

enum EnvironmentType {
  DEVELOPMENT
  STAGING
  PRODUCTION
}

enum ScannerType {
  INPUT
  OUTPUT
  BOTH
}
```

### 5.2 MongoDB Models Package (`@abl/mongo`)

```typescript
// packages/mongo/src/connection.ts
import mongoose from 'mongoose';

export async function connectMongo(uri: string, options?: mongoose.ConnectOptions) {
  return mongoose.connect(uri, {
    maxPoolSize: options?.maxPoolSize ?? 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    ...options,
  });
}

// packages/mongo/src/models/session.model.ts
// Ported from AgenticAI — high-volume, flexible schema
const SessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    appId: { type: String, required: true },
    envId: { type: String },
    ownerUserId: { type: String, required: true },
    name: String,
    description: String,
    status: {
      type: String,
      enum: ['idle', 'busy', 'error', 'terminated', 'started'],
      default: 'idle',
    },
    channel: {
      type: String,
      enum: ['voice', 'web_chat', 'whatsapp', 'sms', 'email', 'api'],
    },
    meta: Schema.Types.Mixed, // Flexible JSON — channel-specific metadata
    value: Schema.Types.Mixed, // Runtime state snapshot
    participants: [
      {
        userId: String,
        role: { type: String, enum: ['owner', 'participant'] },
        joinedAt: Date,
        status: { type: String, enum: ['active', 'inactive'] },
      },
    ],
    isBookmarked: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    sessionStartTime: Date,
    lastActivityTime: Date,
  },
  {
    timestamps: true,
    collection: 'sessions',
  },
);

SessionSchema.index({ accountId: 1, projectId: 1, ownerUserId: 1 });
SessionSchema.index({ accountId: 1, appId: 1, status: 1, createdAt: -1 });
SessionSchema.index({ lastActivityTime: -1 });

// packages/mongo/src/models/run.model.ts
const RunSchema = new Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    agentId: String,
    agentVersionId: String,
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    },
    input: Schema.Types.Mixed, // Flexible — varies by channel
    output: Schema.Types.Mixed, // Flexible — varies by agent
    metadata: Schema.Types.Mixed, // Runtime metadata, debug info
    kwargs: Schema.Types.Mixed, // Variable input/output mappings
    tokenUsage: {
      inputTokens: Number,
      outputTokens: Number,
      totalTokens: Number,
      model: String,
      cost: Number,
    },
    duration: Number, // ms
    error: Schema.Types.Mixed, // Error details if failed
  },
  {
    timestamps: true,
    collection: 'runs',
  },
);

RunSchema.index({ accountId: 1, sessionId: 1, createdAt: -1 });
RunSchema.index({ accountId: 1, status: 1 });

// packages/mongo/src/models/conversation.model.ts
const ConversationSchema = new Schema(
  {
    _id: { type: String, required: true },
    accountId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    projectId: { type: String, required: true },
    appId: String,
    messages: [
      {
        role: { type: String, enum: ['user', 'assistant', 'system', 'tool'] },
        content: Schema.Types.Mixed,
        channel: String,
        traceId: String,
        metadata: Schema.Types.Mixed,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    flowState: Schema.Types.Mixed, // Current flow position + context
    voiceMetadata: {
      callerNumber: String,
      durationSeconds: Number,
      transcriptCount: Number,
      disposition: String,
    },
  },
  {
    timestamps: true,
    collection: 'conversations',
  },
);

ConversationSchema.index({ accountId: 1, sessionId: 1 });
ConversationSchema.index({ accountId: 1, projectId: 1, createdAt: -1 });

// packages/mongo/src/models/session-view.model.ts
// TTL collection — auto-expires
const SessionViewSchema = new Schema(
  {
    accountId: { type: String, required: true },
    sessionId: { type: String, required: true },
    userId: { type: String, required: true },
    projectId: String,
    viewedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }, // TTL trigger
  },
  {
    timestamps: false,
    collection: 'session_views',
  },
);

SessionViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB TTL
SessionViewSchema.index({ accountId: 1, sessionId: 1, userId: 1 });

// packages/mongo/src/models/execution-trace.model.ts
// Append-only trace storage for hot queries (before ClickHouse archival)
const ExecutionTraceSchema = new Schema(
  {
    accountId: { type: String, required: true },
    sessionId: { type: String, required: true },
    traceId: { type: String, required: true },
    spanId: String,
    parentSpanId: String,
    eventType: {
      type: String,
      enum: [
        'session_start',
        'session_end',
        'agent_enter',
        'agent_exit',
        'llm_call',
        'tool_call',
        'decision',
        'constraint_check',
        'handoff',
        'escalation',
        'flow_step_enter',
        'flow_step_exit',
        'flow_transition',
        'entity_extraction',
        'delegate_start',
        'delegate_complete',
        'error',
        'circuit_breaker',
      ],
    },
    data: Schema.Types.Mixed, // Event-specific payload
    severity: {
      type: String,
      enum: ['debug', 'info', 'warn', 'error'],
      default: 'info',
    },
    tags: [String],
    duration: Number, // ms (for spans)
    timestamp: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
    collection: 'execution_traces',
  },
);

ExecutionTraceSchema.index({ accountId: 1, sessionId: 1, timestamp: -1 });
ExecutionTraceSchema.index({ accountId: 1, eventType: 1, timestamp: -1 });
ExecutionTraceSchema.index({ traceId: 1, spanId: 1 });
// Auto-expire after 7 days (hot storage only; archived to ClickHouse)
ExecutionTraceSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });
```

### 5.3 Dual-Database Service Layer

```typescript
// packages/shared/src/data/data-service.ts

/**
 * DataService provides a unified interface over both databases.
 * Rule: The caller never needs to know which database a model lives in.
 */
export interface DataService {
  // PostgreSQL-backed (via Prisma)
  accounts: AccountRepository;
  workspaces: WorkspaceRepository;
  projects: ProjectRepository;
  agents: AgentRepository;
  agentVersions: AgentVersionRepository;
  tools: ToolRepository;
  environments: EnvironmentRepository;
  apiKeys: ApiKeyRepository;
  auditLogs: AuditLogRepository;
  scanners: ScannerRepository;
  modelConfigs: ModelConfigRepository;
  llmCredentials: LLMCredentialRepository;

  // MongoDB-backed (via Mongoose)
  sessions: SessionRepository;
  runs: RunRepository;
  conversations: ConversationRepository;
  sessionViews: SessionViewRepository;
  executionTraces: ExecutionTraceRepository;
}
```

### 5.4 Encryption Service (`@abl/encryption`)

Port AgenticAI's AES-256-GCM selective field encryption:

```typescript
// packages/encryption/src/index.ts
export interface EncryptionContext {
  resourceId: string;
  tenantId: string;
}

export interface EncryptionService {
  encrypt(plaintext: string, context: EncryptionContext): Promise<EncryptedField>;
  decrypt(encrypted: EncryptedField, context: EncryptionContext): Promise<string>;
  encryptFields<T>(obj: T, fields: (keyof T)[], context: EncryptionContext): Promise<T>;
  decryptFields<T>(obj: T, fields: (keyof T)[], context: EncryptionContext): Promise<T>;
}

export interface EncryptedField {
  ciphertext: string; // Base64-encoded encrypted data
  iv: string; // Initialization vector
  tag: string; // GCM authentication tag
  algorithm: 'aes-256-gcm';
}
```

---

## 6. Phase 2 — Message Ingestion & Buffering

**Duration:** Week 4-7
**Goal:** Handle high-scale incoming messages with priority queuing and backpressure

### 6.1 Queue Package (`@abl/queue`)

```typescript
// packages/queue/src/index.ts
import { Queue, Worker, QueueEvents, Job } from 'bullmq';

export interface QueueConfig {
  name: string;
  redis: { host: string; port: number; password?: string; db?: number };
  defaultJobOptions: {
    priority: number;
    attempts: number;
    backoff: { type: 'fixed' | 'exponential'; delay: number };
    timeout: number;
    removeOnComplete: boolean | { age: number; count: number };
    removeOnFail: boolean | { age: number; count: number };
  };
  workerOptions: {
    concurrency: number;
    limiter?: {
      max: number; // Max jobs per duration
      duration: number; // Duration in ms
    };
  };
}

// Pre-configured queue definitions
export const QUEUE_DEFINITIONS = {
  'runtime:voice': {
    priority: 1, // Highest — latency-critical
    attempts: 2,
    backoff: { type: 'fixed', delay: 100 },
    timeout: 5_000, // 5s hard limit
    removeOnComplete: true,
    concurrency: 20,
  },
  'runtime:digital': {
    priority: 5,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000 },
    timeout: 30_000, // 30s
    removeOnComplete: { age: 3_600 }, // Keep 1hr
    concurrency: 50,
  },
  'runtime:api': {
    priority: 10,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    timeout: 60_000, // 60s
    removeOnComplete: { age: 7_200 }, // Keep 2hr
    concurrency: 30,
  },
  'jobs:import': {
    priority: 20, // Lowest — background
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeout: 300_000, // 5min
    removeOnComplete: { age: 86_400 }, // Keep 24hr
    concurrency: 5,
  },
  'jobs:export': {
    priority: 20,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    timeout: 300_000,
    removeOnComplete: { age: 86_400 },
    concurrency: 5,
  },
} as const;
```

### 6.2 Message Gateway Design

```typescript
// apps/platform/src/gateways/voice.gateway.ts

/**
 * Voice Gateway
 *
 * Handles incoming voice messages with strict latency requirements.
 * Flow: WebSocket → Validate → Tenant Gate → Enqueue (high priority) → Ack
 *
 * Voice messages MUST be acknowledged within 200ms.
 * Actual processing happens asynchronously via the voice worker.
 */
export class VoiceGateway {
  constructor(
    private tenantGate: TenantGate,
    private queue: Queue,
    private traceManager: TraceManager,
  ) {}

  async handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    const message = this.parseVoiceMessage(raw);
    const startTime = Date.now();

    // 1. Tenant gate check (auth + rate limit + circuit breaker)
    const gateResult = await this.tenantGate.check({
      tenantId: message.tenantContext.accountId,
      appId: message.appId,
      channel: 'voice',
      operation: 'message',
    });

    if (!gateResult.allowed) {
      this.sendError(ws, gateResult.reason, gateResult.retryAfter);
      return;
    }

    // 2. Capture transcript immediately (compliance — never lose voice data)
    await this.captureTranscript(message);

    // 3. Enqueue for processing (non-blocking)
    const job = await this.queue.add(
      'voice-message',
      {
        ...message,
        gateLatency: Date.now() - startTime,
      },
      {
        priority: 1,
        jobId: message.id,
      },
    );

    // 4. Acknowledge receipt (must happen within 200ms)
    this.sendAck(ws, message.id, job.id);
  }
}
```

```typescript
// apps/platform/src/gateways/digital.gateway.ts

/**
 * Digital Gateway
 *
 * Handles web chat, WhatsApp, SMS, email.
 * Supports both WebSocket (streaming) and HTTP (request/response).
 */
export class DigitalGateway {
  // WebSocket path: /ws/chat
  async handleWebSocketMessage(ws: WebSocket, message: IncomingMessage): Promise<void> {
    const gateResult = await this.tenantGate.check({
      tenantId: message.tenantContext.accountId,
      appId: message.appId,
      channel: message.channel,
      operation: 'message',
    });

    if (!gateResult.allowed) {
      this.sendError(ws, gateResult.reason, gateResult.retryAfter);
      return;
    }

    // For WebSocket: enqueue but also subscribe for streaming results
    const job = await this.queue.add('digital-message', message, {
      priority: 5,
      jobId: message.id,
    });

    // Subscribe to job progress for streaming chunks back
    this.subscribeToJob(ws, job.id, message.sessionId);
  }

  // HTTP path: POST /api/chat/message
  async handleHttpMessage(req: Request, res: Response): Promise<void> {
    // Same gate check, enqueue, but return SSE stream or wait for completion
  }
}
```

### 6.3 Worker Pool Design

```typescript
// apps/platform/src/workers/voice.worker.ts

/**
 * Voice Worker
 *
 * Processes voice messages from the BullMQ queue.
 * Optimized for low latency — minimal overhead before hitting runtime.
 */
export function createVoiceWorker(deps: WorkerDeps): Worker {
  return new Worker(
    'runtime:voice',
    async (job: Job) => {
      const { tenantContext, sessionId, content, metadata } = job.data;
      const startTime = Date.now();

      // 1. Resolve runtime session (from cache or create)
      const session = await deps.sessionManager.getOrCreate(tenantContext, sessionId, 'voice');

      // 2. Execute through ABL runtime
      const chunks: string[] = [];
      for await (const chunk of deps.voiceRuntime.processVoiceInput(session, content)) {
        chunks.push(chunk);
        // Report progress for streaming subscribers
        await job.updateProgress({
          type: 'chunk',
          data: chunk,
          sessionId,
          elapsed: Date.now() - startTime,
        });
      }

      // 3. Return result
      return {
        response: chunks.join(''),
        sessionId,
        duration: Date.now() - startTime,
        tokenUsage: session.lastTokenUsage,
      };
    },
    {
      connection: deps.redis,
      concurrency: deps.config.queue.voice.concurrency,
      // Per-tenant concurrency limiter
      limiter: {
        max: deps.config.queue.voice.concurrency,
        duration: 1000,
        groupKey: 'tenantContext.accountId', // BullMQ group key
      },
    },
  );
}
```

### 6.4 Backpressure Design

```typescript
// apps/platform/src/middleware/backpressure.ts

export interface BackpressureConfig {
  voice: {
    warningThreshold: number; // Queue depth warning (default: 100)
    criticalThreshold: number; // Queue depth critical (default: 500)
    shedPriority: number; // Shed jobs below this priority when critical
  };
  digital: {
    warningThreshold: number; // default: 500
    criticalThreshold: number; // default: 2000
    shedPriority: number;
  };
}

export class BackpressureMonitor {
  private interval: NodeJS.Timeout;

  start(queues: Map<string, Queue>, config: BackpressureConfig): void {
    this.interval = setInterval(async () => {
      for (const [name, queue] of queues) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        const depth = counts.waiting + counts.delayed;
        const channelConfig = config[name.split(':')[1]];

        if (depth >= channelConfig.criticalThreshold) {
          // CRITICAL: Start shedding low-priority traffic
          this.emitAlert('critical', name, depth);
          // Pause accepting new jobs below shed priority
          this.shedTraffic(name, channelConfig.shedPriority);
        } else if (depth >= channelConfig.warningThreshold) {
          // WARNING: Log and emit metric
          this.emitAlert('warning', name, depth);
        }

        // Emit metrics for monitoring
        this.emitMetric('queue.depth', depth, { queue: name });
        this.emitMetric('queue.active', counts.active, { queue: name });
      }
    }, 5_000); // Check every 5s
  }
}
```

### 6.5 Per-Tenant Queue Isolation

```
Logical Isolation (same Redis, prefixed keys):

  tenant:acme:runtime:voice     → Worker pool (max 20 concurrent)
  tenant:acme:runtime:digital   → Worker pool (max 50 concurrent)
  tenant:beta:runtime:voice     → Worker pool (max 20 concurrent)
  tenant:beta:runtime:digital   → Worker pool (max 50 concurrent)

Physical Isolation (for enterprise tenants):
  Dedicated Redis instance → Dedicated worker pool
  (configured per-tenant in Account.settings)
```

**BullMQ group-based rate limiting:**

```typescript
// Per-tenant rate limiting within shared queues
const worker = new Worker('runtime:digital', processor, {
  connection: redis,
  concurrency: 200, // Total across all tenants
  limiter: {
    max: 50, // Max 50 per group per second
    duration: 1000,
    groupKey: 'tenantId',
  },
});
```

---

## 7. Phase 3 — Circuit Breakers & Resilience

**Duration:** Week 5-8
**Goal:** Protect the system from cascading failures with hierarchical circuit breakers

### 7.1 Circuit Breaker Package (`@abl/circuit-breaker`)

```typescript
// packages/circuit-breaker/src/types.ts

export interface CircuitBreakerConfig {
  /** Failures in window before opening */
  failureThreshold: number;
  /** Successes in HALF_OPEN before closing */
  successThreshold: number;
  /** Time in OPEN before transitioning to HALF_OPEN (ms) */
  resetTimeout: number;
  /** Rolling window for counting failures (ms) */
  monitorWindow: number;
  /** Max concurrent requests in HALF_OPEN */
  halfOpenMaxConcurrent: number;
  /** Failure rate % threshold (alternative to count) */
  failureRateThreshold?: number;
  /** Minimum requests before rate calculation applies */
  minimumRequestCount?: number;
}

// Default configs per level
export const BREAKER_DEFAULTS: Record<BreakerLevel, CircuitBreakerConfig> = {
  tenant: {
    failureThreshold: 50,
    successThreshold: 5,
    resetTimeout: 30_000,
    monitorWindow: 60_000,
    halfOpenMaxConcurrent: 3,
    failureRateThreshold: 50, // 50% failure rate
    minimumRequestCount: 20,
  },
  app: {
    failureThreshold: 20,
    successThreshold: 3,
    resetTimeout: 15_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 2,
    failureRateThreshold: 40,
    minimumRequestCount: 10,
  },
  llm_provider: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 60_000, // Longer — provider may be down
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 30,
    minimumRequestCount: 5,
  },
  tool_service: {
    failureThreshold: 10,
    successThreshold: 2,
    resetTimeout: 30_000,
    monitorWindow: 30_000,
    halfOpenMaxConcurrent: 1,
    failureRateThreshold: 40,
    minimumRequestCount: 5,
  },
};
```

### 7.2 Redis-Backed Implementation

```typescript
// packages/circuit-breaker/src/redis-circuit-breaker.ts

/**
 * Redis-backed circuit breaker for distributed deployments.
 *
 * State stored in Redis so all instances share breaker state.
 * Uses Lua scripts for atomic state transitions.
 *
 * Redis key layout:
 *   breaker:{level}:{key}:state       → "CLOSED" | "OPEN" | "HALF_OPEN"
 *   breaker:{level}:{key}:failures    → sorted set (timestamp → error)
 *   breaker:{level}:{key}:successes   → sorted set (timestamp → 1)
 *   breaker:{level}:{key}:opened_at   → timestamp
 *   breaker:{level}:{key}:half_open_count → counter
 */
export class RedisCircuitBreaker {
  constructor(
    private redis: Redis,
    private level: BreakerLevel,
    private config: CircuitBreakerConfig,
    private traceManager?: TraceManager,
  ) {}

  async execute<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const fullKey = `${this.level}:${key}`;
    const state = await this.getState(fullKey);

    // OPEN — reject immediately
    if (state === 'OPEN') {
      const resetAt = await this.getResetTime(fullKey);
      if (Date.now() < resetAt) {
        this.emitStateEvent(fullKey, 'OPEN', 'rejected');
        throw new CircuitOpenError(this.level, key, resetAt);
      }
      // Timeout expired — try HALF_OPEN
      await this.transition(fullKey, 'HALF_OPEN');
    }

    // HALF_OPEN — allow limited concurrent
    if (state === 'HALF_OPEN' || (await this.getState(fullKey)) === 'HALF_OPEN') {
      const concurrent = await this.redis.incr(`breaker:${fullKey}:half_open_count`);
      await this.redis.expire(`breaker:${fullKey}:half_open_count`, 60);
      if (concurrent > this.config.halfOpenMaxConcurrent) {
        await this.redis.decr(`breaker:${fullKey}:half_open_count`);
        throw new CircuitOpenError(this.level, key, Date.now() + 5000);
      }
    }

    // CLOSED or HALF_OPEN — execute
    try {
      const result = await fn();
      await this.recordSuccess(fullKey);
      return result;
    } catch (error) {
      await this.recordFailure(fullKey, error);
      throw error;
    }
  }

  private async recordFailure(fullKey: string, error: unknown): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.config.monitorWindow;

    // Atomic: add failure, trim window, check threshold
    const [failureCount, totalCount] = (await this.redis.eval(
      `
      -- Add failure
      redis.call('ZADD', KEYS[1], ARGV[1], ARGV[1] .. ':' .. ARGV[2])
      -- Trim old entries
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
      redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
      -- Count
      local failures = redis.call('ZCARD', KEYS[1])
      local successes = redis.call('ZCARD', KEYS[2])
      return {failures, failures + successes}
    `,
      2,
      `breaker:${fullKey}:failures`,
      `breaker:${fullKey}:successes`,
      now.toString(),
      this.serializeError(error),
      windowStart.toString(),
    )) as [number, number];

    // Check thresholds
    const shouldOpen =
      failureCount >= this.config.failureThreshold ||
      (totalCount >= (this.config.minimumRequestCount ?? 0) &&
        (failureCount / totalCount) * 100 >= (this.config.failureRateThreshold ?? 100));

    if (shouldOpen) {
      await this.transition(fullKey, 'OPEN');
    }
  }

  private async recordSuccess(fullKey: string): Promise<void> {
    const state = await this.getState(fullKey);
    const now = Date.now();

    await this.redis.zadd(`breaker:${fullKey}:successes`, now, `${now}`);

    if (state === 'HALF_OPEN') {
      await this.redis.decr(`breaker:${fullKey}:half_open_count`);
      const successes = await this.redis.zcard(`breaker:${fullKey}:successes`);
      if (successes >= this.config.successThreshold) {
        await this.transition(fullKey, 'CLOSED');
      }
    }
  }

  private async transition(fullKey: string, to: BreakerState): Promise<void> {
    const from = await this.getState(fullKey);
    if (from === to) return;

    await this.redis.set(`breaker:${fullKey}:state`, to);

    if (to === 'OPEN') {
      await this.redis.set(`breaker:${fullKey}:opened_at`, Date.now().toString());
    } else if (to === 'CLOSED') {
      // Reset counters
      await this.redis.del(
        `breaker:${fullKey}:failures`,
        `breaker:${fullKey}:successes`,
        `breaker:${fullKey}:half_open_count`,
        `breaker:${fullKey}:opened_at`,
      );
    }

    // Emit trace event
    this.traceManager?.emit({
      type: 'circuit_breaker',
      data: { level: this.level, key: fullKey, from, to },
      severity: to === 'OPEN' ? 'error' : 'info',
    });
  }
}
```

### 7.3 Hierarchical Breaker Middleware

```typescript
// apps/platform/src/middleware/tenant-gate.ts

/**
 * TenantGate — single entry point for all protection checks.
 *
 * Order of checks:
 * 1. Authentication (JWT validation)
 * 2. Tenant circuit breaker (is this tenant's circuit open?)
 * 3. App circuit breaker (is this specific app's circuit open?)
 * 4. Rate limiter (has this tenant exceeded their rate?)
 * 5. Concurrency check (has this tenant hit max concurrent?)
 */
export class TenantGate {
  constructor(
    private auth: AuthService,
    private tenantBreaker: RedisCircuitBreaker, // level: tenant
    private appBreaker: RedisCircuitBreaker, // level: app
    private rateLimiter: RedisRateLimiter,
    private concurrencyLimiter: ConcurrencyLimiter,
  ) {}

  async check(request: GateRequest): Promise<GateResult> {
    // 1. Auth
    const tenant = await this.auth.validateToken(request.token);
    if (!tenant) {
      return { allowed: false, reason: 'UNAUTHORIZED', statusCode: 401 };
    }

    // 2. Tenant breaker
    const tenantState = await this.tenantBreaker.getState(tenant.accountId);
    if (tenantState === 'OPEN') {
      const resetAt = await this.tenantBreaker.getResetTime(tenant.accountId);
      return {
        allowed: false,
        reason: 'TENANT_CIRCUIT_OPEN',
        statusCode: 503,
        retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
      };
    }

    // 3. App breaker
    if (request.appId) {
      const appKey = `${tenant.accountId}:${request.appId}`;
      const appState = await this.appBreaker.getState(appKey);
      if (appState === 'OPEN') {
        return {
          allowed: false,
          reason: 'APP_CIRCUIT_OPEN',
          statusCode: 503,
          retryAfter: Math.ceil(((await this.appBreaker.getResetTime(appKey)) - Date.now()) / 1000),
        };
      }
    }

    // 4. Rate limit
    const rateResult = await this.rateLimiter.check(tenant.accountId, request.channel, 'message');
    if (!rateResult.allowed) {
      return {
        allowed: false,
        reason: 'RATE_LIMITED',
        statusCode: 429,
        retryAfter: Math.ceil(rateResult.resetMs / 1000),
        headers: {
          'X-RateLimit-Limit': rateResult.limit,
          'X-RateLimit-Remaining': rateResult.remaining,
          'X-RateLimit-Reset': rateResult.resetAt,
        },
      };
    }

    // 5. Concurrency
    const concResult = await this.concurrencyLimiter.check(tenant.accountId, request.channel);
    if (!concResult.allowed) {
      return {
        allowed: false,
        reason: 'MAX_CONCURRENT_SESSIONS',
        statusCode: 429,
        retryAfter: 5,
      };
    }

    return { allowed: true, tenantContext: tenant };
  }
}
```

### 7.4 LLM Provider Breaker Integration

```typescript
// Wraps the existing LLM provider abstraction in ABL

export class ResilientLLMProvider implements LLMProvider {
  constructor(
    private provider: LLMProvider,
    private breaker: RedisCircuitBreaker, // level: llm_provider
    private fallbackProvider?: LLMProvider,
  ) {}

  async chat(messages: Message[], options: LLMOptions): Promise<LLMResponse> {
    const providerKey = `${options.tenantId}:${this.provider.name}`;

    try {
      return await this.breaker.execute(providerKey, () => this.provider.chat(messages, options));
    } catch (error) {
      if (error instanceof CircuitOpenError && this.fallbackProvider) {
        // Breaker open — try fallback provider
        return this.fallbackProvider.chat(messages, options);
      }
      throw error;
    }
  }

  async *streamChat(messages: Message[], options: LLMOptions): AsyncGenerator<string> {
    const providerKey = `${options.tenantId}:${this.provider.name}`;

    // For streaming, we check the breaker before starting
    const state = await this.breaker.getState(providerKey);
    if (state === 'OPEN') {
      if (this.fallbackProvider) {
        yield* this.fallbackProvider.streamChat(messages, options);
        return;
      }
      throw new CircuitOpenError('llm_provider', providerKey, 0);
    }

    try {
      yield* this.provider.streamChat(messages, options);
      await this.breaker.recordSuccess(providerKey);
    } catch (error) {
      await this.breaker.recordFailure(providerKey, error);
      throw error;
    }
  }
}
```

### 7.5 Tool/Service Breaker Integration

```typescript
// Wraps ServiceNode executor with circuit breaker

export class ResilientToolExecutor implements ToolExecutor {
  constructor(
    private executor: ToolExecutor,
    private breaker: RedisCircuitBreaker, // level: tool_service
  ) {}

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const serviceKey = `${context.tenantId}:${toolName}`;

    return this.breaker.execute(serviceKey, () => this.executor.execute(toolName, args, context));
  }

  async executeParallel(
    calls: ToolCall[],
    timeoutMs: number,
    context: ExecutionContext,
  ): Promise<ToolResult[]> {
    // Check breakers for all tools before executing
    const results = await Promise.allSettled(
      calls.map((call) => {
        const serviceKey = `${context.tenantId}:${call.toolName}`;
        return this.breaker.execute(serviceKey, () =>
          this.executor.execute(call.toolName, call.args, context),
        );
      }),
    );

    return results.map((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        toolName: calls[i].toolName,
        success: false,
        error:
          result.reason instanceof CircuitOpenError
            ? `Service ${calls[i].toolName} is temporarily unavailable`
            : result.reason.message,
      };
    });
  }
}
```

---

## 8. Phase 4 — Unified Observability

**Duration:** Week 6-9
**Goal:** Combine Observatory (dev) + Langfuse (prod) into a unified observability layer

### 8.1 Langfuse Adapter Package (`@abl/langfuse`)

```typescript
// packages/langfuse-adapter/src/index.ts

import { Langfuse } from 'langfuse';
import type { TraceEvent, Span } from '@abl/observatory';

/**
 * Bridges Observatory trace events to Langfuse.
 *
 * Observatory remains the real-time debug protocol.
 * Langfuse provides persistent storage, cost tracking, and analytics.
 *
 * Events are batched and flushed asynchronously to avoid
 * impacting runtime latency.
 */
export class LangfuseTraceAdapter {
  private langfuse: Langfuse;
  private traceMap: Map<string, string> = new Map(); // sessionId → langfuseTraceId
  private buffer: TraceEvent[] = [];
  private flushInterval: NodeJS.Timeout;

  constructor(config: LangfuseConfig) {
    this.langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.baseUrl,
      flushAt: config.batchSize ?? 50,
      flushInterval: config.flushInterval ?? 5000,
    });

    // Periodic flush as safety net
    this.flushInterval = setInterval(() => this.flush(), config.flushInterval ?? 5000);
  }

  /**
   * Called by TraceManager for every event.
   * Maps Observatory event types to Langfuse constructs.
   */
  onEvent(event: TraceEvent, span?: Span): void {
    switch (event.type) {
      case 'session_start':
        this.handleSessionStart(event);
        break;
      case 'session_end':
        this.handleSessionEnd(event);
        break;
      case 'llm_call':
        this.handleLLMCall(event, span);
        break;
      case 'tool_call':
        this.handleToolCall(event, span);
        break;
      case 'decision':
        this.handleDecision(event, span);
        break;
      case 'agent_enter':
      case 'agent_exit':
        this.handleAgentSpan(event, span);
        break;
      case 'flow_step_enter':
      case 'flow_step_exit':
        this.handleFlowStep(event, span);
        break;
      case 'constraint_check':
        this.handleConstraint(event, span);
        break;
      case 'handoff':
        this.handleHandoff(event, span);
        break;
      case 'escalation':
        this.handleEscalation(event, span);
        break;
      case 'error':
        this.handleError(event, span);
        break;
      case 'circuit_breaker':
        this.handleCircuitBreaker(event, span);
        break;
    }
  }

  private handleSessionStart(event: TraceEvent): void {
    const trace = this.langfuse.trace({
      id: event.data.sessionId,
      name: `session:${event.data.agentName}`,
      userId: event.data.userId,
      sessionId: event.data.sessionId,
      metadata: {
        channel: event.data.channel,
        accountId: event.data.accountId,
        workspaceId: event.data.workspaceId,
      },
      tags: [event.data.channel, event.data.agentName],
    });
    this.traceMap.set(event.data.sessionId, trace.id);
  }

  private handleLLMCall(event: TraceEvent, span?: Span): void {
    const traceId = this.resolveTraceId(event);
    this.langfuse.generation({
      traceId,
      parentObservationId: span?.parentId,
      name: event.data.model,
      model: event.data.model,
      input: event.data.prompt,
      output: event.data.response,
      usage: {
        input: event.data.inputTokens,
        output: event.data.outputTokens,
        total: event.data.totalTokens,
      },
      metadata: {
        temperature: event.data.temperature,
        maxTokens: event.data.maxTokens,
        latencyMs: event.data.duration,
      },
      level: event.severity === 'error' ? 'ERROR' : 'DEFAULT',
    });
  }

  private handleToolCall(event: TraceEvent, span?: Span): void {
    const traceId = this.resolveTraceId(event);
    this.langfuse.span({
      traceId,
      parentObservationId: span?.parentId,
      name: `tool:${event.data.toolName}`,
      input: event.data.arguments,
      output: event.data.result,
      metadata: {
        success: event.data.success,
        latencyMs: event.data.duration,
      },
      level: event.data.success ? 'DEFAULT' : 'ERROR',
    });
  }

  // ... other handlers follow same pattern

  async shutdown(): Promise<void> {
    clearInterval(this.flushInterval);
    await this.langfuse.shutdownAsync();
  }
}
```

### 8.2 Unified TraceManager

```typescript
// Extends existing Observatory TraceManager to support multiple subscribers

export class UnifiedTraceManager {
  private subscribers: TraceSubscriber[] = [];

  /** Observatory (real-time WebSocket debugging) */
  addObservatorySubscriber(observatory: ObservatoryServer): void {
    this.subscribers.push(observatory);
  }

  /** Langfuse (production analytics) */
  addLangfuseSubscriber(adapter: LangfuseTraceAdapter): void {
    this.subscribers.push(adapter);
  }

  /** MongoDB (hot trace storage, 7-day TTL) */
  addMongoSubscriber(store: MongoTraceStore): void {
    this.subscribers.push(store);
  }

  /** ClickHouse (long-term analytics, per existing roadmap) */
  addClickHouseSubscriber(store: ClickHouseTraceStore): void {
    this.subscribers.push(store);
  }

  emit(event: TraceEvent, span?: Span): void {
    // Fan out to all subscribers (non-blocking)
    for (const subscriber of this.subscribers) {
      try {
        subscriber.onEvent(event, span);
      } catch (error) {
        // Never let a subscriber failure affect the runtime
        console.error(`Trace subscriber error: ${error}`);
      }
    }
  }
}
```

### 8.3 Trace Correlation

```typescript
// Every request gets a correlation context that flows through all systems

export interface TraceCorrelation {
  traceId: string; // W3C Trace Context trace-id (32 hex chars)
  spanId: string; // W3C Trace Context span-id (16 hex chars)
  parentSpanId?: string; // Parent span for nested operations
  sessionId: string; // ABL session ID
  accountId: string; // Tenant for filtering
  baggage: {
    // W3C Baggage for cross-service context
    channel: string;
    agentName: string;
    environment: string;
  };
}

// Injected at the gateway level, propagated through:
// → BullMQ job data
// → ABL runtime context
// → LLM provider calls (as metadata)
// → Tool executor calls (as headers)
// → Observatory events
// → Langfuse traces
// → MongoDB documents
// → ClickHouse rows
```

---

## 9. Phase 5 — Feature Porting

**Duration:** Week 8-14
**Goal:** Port AgenticAI features into ABL platform modules

### 9.1 Feature Porting Priority

| Priority | Feature                 | Source (AgenticAI)                           | Target (ABL)                              | Complexity |
| -------- | ----------------------- | -------------------------------------------- | ----------------------------------------- | ---------- |
| **P1**   | Agent CRUD + versioning | `modules/agents/`, `modules/agent-versions/` | `apps/platform/src/modules/agents/`       | Medium     |
| **P1**   | Session management      | `modules/sessions/`                          | `@abl/mongo` + voice/digital runtime      | Medium     |
| **P1**   | Conversation history    | `modules/conversations/`                     | `@abl/mongo` conversations model          | Medium     |
| **P1**   | Tool registry           | `modules/tools/`                             | Extend ABL ServiceNode                    | Low        |
| **P1**   | API key management      | `modules/api-keys/`                          | Prisma ApiKey model                       | Low        |
| **P2**   | Environment management  | `modules/environments/`                      | Prisma Environment model                  | Medium     |
| **P2**   | File management         | `modules/file-manager/`                      | New module in platform                    | Medium     |
| **P2**   | Import/Export           | `modules/import-export/`                     | BullMQ job (`jobs:import`, `jobs:export`) | High       |
| **P2**   | PII configuration       | `modules/pii-configs/`                       | Map to ABL GUARDRAILS                     | Medium     |
| **P2**   | App variables           | `modules/app-variables/`                     | Prisma + encrypted storage                | Medium     |
| **P3**   | Diagnostics             | `modules/diagnostics/`                       | Extend Observatory                        | Low        |
| **P3**   | Audit logging           | `modules/audit-logs/`                        | Prisma AuditLog (already defined)         | Low        |
| **P3**   | Seed data               | `modules/seed-data/`                         | Prisma migration seeds                    | Low        |
| **P3**   | MCP servers             | `modules/mcp-servers/`                       | Extend ABL MCP debug                      | Medium     |
| **P3**   | Scanners                | `modules/scanners/`                          | Prisma Scanner model                      | Low        |

### 9.2 Porting Guidelines

**For each ported feature:**

1. **Read** the AgenticAI implementation (NestJS module: controller, service, model)
2. **Map** the data model:
   - Simple/relational → Prisma schema
   - High-volume/flexible → `@abl/mongo` model
3. **Write** the ABL module:
   - Express route handler (not NestJS decorator)
   - Service class (business logic)
   - Repository (data access via DataService)
4. **Test** with Vitest (matching ABL's test patterns)
5. **Verify** API compatibility (see Appendix B)

**What NOT to port:**

- NestJS decorators/DI container → use plain constructor injection
- Graph-engine-specific code → use ABL's ConstructExecutor pipeline
- Angular-specific APIs → port to React in Phase 6
- RabbitMQ flow manager → replaced by BullMQ in Phase 2

### 9.3 LLM Integration Merge

```
AgenticAI LLM Stack              ABL LLM Stack
─────────────────                 ──────────────
Vendor SDK wrappers               Direct provider clients
  OpenAI SDK                        Anthropic SDK
  Anthropic SDK                     OpenAI SDK (planned)
  Cohere SDK                        LiteLLM proxy
  Google SDK                        Model Router
  Graph state machine               Construct Executor

            ▼ MERGE INTO ▼

ABL Unified LLM Layer
──────────────────────
Direct provider clients (ABL's approach — no wrapper overhead)
  + Anthropic (existing)
  + OpenAI (existing)
  + Azure OpenAI (port from AgenticAI)
  + LiteLLM (existing)
  + Google Gemini (port from AgenticAI)
  + Cohere (port from AgenticAI)
Model Router (existing — tier-based selection)
Provider Breaker (new — from Phase 3)
Retry/Fallback (port from AgenticAI node-retry.utils.ts)
Cost Tracking (new — via Langfuse adapter)
```

### 9.4 Voice Integration Merge

```
AgenticAI Voice Stack             ABL Voice Stack
─────────────────────             ───────────────
OpenAI Realtime API               Voice Runtime (streaming)
Ultravox                          Transcript capture
Google Gemini Voice               Session management
VAD configuration                 Async generators
Turn detection                    Word-based chunking
Audio format negotiation          Latency monitoring

            ▼ MERGE INTO ▼

ABL Unified Voice Layer
───────────────────────
Voice Runtime (ABL — keep as base)
  + OpenAI RT API adapter (port from AgenticAI)
  + Ultravox adapter (port from AgenticAI)
  + Google Gemini adapter (port from AgenticAI)
  + VAD configuration (port — server_vad + semantic_vad)
  + Audio format negotiation (port)
Voice Gateway (new — from Phase 2)
  + BullMQ priority queue
  + Backpressure handling
Transcript capture (ABL — keep, already robust)
Voice breaker (new — from Phase 3)
```

---

## 10. Phase 6 — Frontend Consolidation

**Duration:** Week 10-16
**Goal:** Unified React-based Studio with ported AgenticAI UI features

### 10.1 Strategy

- **Keep:** ABL Studio (React + Vite + TailwindCSS)
- **Drop:** AgenticAI Angular frontend
- **Port:** Key AgenticAI UI features as React components
- **Merge:** AgenticAI React UI libs (`agentic-ui-libs`) into ABL `@abl/editor`

### 10.2 UI Features to Port

| Feature                          | Source          | Priority | Complexity |
| -------------------------------- | --------------- | -------- | ---------- |
| Agent builder/editor             | Angular → React | P1       | High       |
| Session list + viewer            | Angular → React | P1       | Medium     |
| Conversation viewer              | Angular → React | P1       | Medium     |
| Environment manager              | Angular → React | P2       | Low        |
| API key manager                  | Angular → React | P2       | Low        |
| Import/Export UI                 | Angular → React | P2       | Medium     |
| Analytics dashboard              | Angular → React | P3       | High       |
| Tenant admin panel               | New             | P3       | High       |
| Ops dashboard (queues, breakers) | New             | P3       | Medium     |

### 10.3 Component Library Merge

```
agentic-ui-libs (AgenticAI)      @abl/editor (ABL)
───────────────────────          ──────────────────
React 18 + Vite                  React 18 + Vite
TailwindCSS                      TailwindCSS
Tiptap rich text                 Monaco Editor
Recharts                         XYFlow (graph viz)
ag-Grid                          Zustand
                                 Dagre (layout)

            ▼ MERGE INTO ▼

@abl/editor (Extended)
──────────────────────
React 18 + Vite (keep)
TailwindCSS (keep)
Monaco Editor (keep — code editing)
XYFlow (keep — agent graph visualization)
Zustand (keep — state management)
Dagre (keep — graph layout)
Tiptap (port — rich text for agent descriptions)
Recharts (port — analytics charts)
ag-Grid (port — data tables for sessions, runs)
```

---

## 11. Migration Checklist

### Pre-Migration

- [ ] **Backup** all AgenticAI MongoDB data
- [ ] **Document** all active AgenticAI API consumers
- [ ] **Freeze** AgenticAI feature development (maintenance-only)
- [ ] **Set up** ABL development environment with docker-compose
- [ ] **Verify** ABL test suite passes (613 tests)
- [ ] **Create** feature branch for merge work

### Phase 0 Checklist

- [ ] Create all new package directories
- [ ] Scaffold package.json, tsconfig, vitest for each
- [ ] Update turbo.json and pnpm-workspace.yaml
- [ ] docker-compose.yml with PostgreSQL + MongoDB + Redis + ClickHouse
- [ ] `@abl/shared` types package with TenantContext, Channel, etc.
- [ ] CI/CD pipeline running build + test
- [ ] Environment config schema defined
- [ ] All packages build successfully (`turbo build`)

### Phase 1 Checklist

- [ ] Prisma schema extended with all new models
- [ ] `npx prisma migrate dev` creates clean migration
- [ ] `@abl/mongo` package with all 5 MongoDB models
- [ ] MongoDB connection + model registration working
- [ ] DataService interface implemented
- [ ] `@abl/encryption` package with AES-256-GCM
- [ ] Encryption round-trip tests passing
- [ ] Dual-database integration test (write to both, read from both)

### Phase 2 Checklist

- [ ] `@abl/queue` package with BullMQ abstraction
- [ ] 5 queue definitions configured and tested
- [ ] Voice gateway accepting WebSocket connections
- [ ] Digital gateway accepting WebSocket + HTTP
- [ ] API gateway accepting REST
- [ ] Voice worker processing jobs from queue
- [ ] Digital worker processing jobs from queue
- [ ] API worker processing jobs from queue
- [ ] Backpressure monitor running and emitting metrics
- [ ] Per-tenant queue isolation verified
- [ ] Job retry + dead-letter working
- [ ] BullBoard dashboard accessible (dev only)

### Phase 3 Checklist

- [ ] `@abl/circuit-breaker` package implemented
- [ ] Redis Lua scripts for atomic state transitions
- [ ] Tenant breaker integration tested
- [ ] App breaker integration tested
- [ ] LLM provider breaker wrapping all providers
- [ ] Tool service breaker wrapping tool executor
- [ ] TenantGate middleware assembled and tested
- [ ] Circuit breaker state visible in Observatory
- [ ] Breaker state transitions emitting trace events
- [ ] Recovery (HALF_OPEN → CLOSED) verified
- [ ] Load test: verify tenant isolation under failure

### Phase 4 Checklist

- [ ] `@abl/langfuse` adapter package implemented
- [ ] All 17 Observatory event types mapped to Langfuse
- [ ] UnifiedTraceManager with all 4 subscribers
- [ ] Trace correlation IDs flowing end-to-end
- [ ] Langfuse dashboard showing traces with cost data
- [ ] MongoDB hot trace storage with 7-day TTL
- [ ] ClickHouse trace archival pipeline
- [ ] Observatory + Langfuse both receiving events simultaneously
- [ ] No measurable latency impact from trace emission

### Phase 5 Checklist

- [ ] Agent CRUD API working (create, read, update, delete, list)
- [ ] Agent versioning (create version, activate, rollback)
- [ ] Session management (create, resume, end, list)
- [ ] Conversation history (append, query, search)
- [ ] Tool registry (register, configure, enable/disable)
- [ ] API key management (create, rotate, revoke)
- [ ] Environment management (create, configure, activate)
- [ ] File management (upload, download, delete)
- [ ] Import/Export via BullMQ jobs
- [ ] PII config mapped to ABL GUARDRAILS
- [ ] App variables with encryption
- [ ] Audit logging on all state-changing operations
- [ ] All ported features have API tests
- [ ] LLM providers: Anthropic, OpenAI, Azure, LiteLLM, Gemini, Cohere
- [ ] Voice adapters: OpenAI RT, Ultravox, Gemini Voice
- [ ] LLM retry/fallback chain working

### Phase 6 Checklist

- [ ] Agent builder/editor in React Studio
- [ ] Session list + viewer working
- [ ] Conversation viewer with real-time updates
- [ ] Environment manager UI
- [ ] API key manager UI
- [ ] Import/Export UI
- [ ] agentic-ui-libs components merged into @abl/editor
- [ ] All UI components have Storybook stories
- [ ] Responsive design verified

### Post-Migration

- [ ] Performance benchmarks (latency P50/P95/P99 per channel)
- [ ] Load test (target concurrent sessions per channel)
- [ ] Security audit (OWASP top 10)
- [ ] API compatibility verified against AgenticAI consumers
- [ ] Monitoring dashboards deployed (Grafana or equivalent)
- [ ] Runbook for circuit breaker operations
- [ ] Data migration from AgenticAI MongoDB verified
- [ ] AgenticAI decommission plan approved

---

## 12. Data Migration Playbook

### 12.1 Migration Strategy

**Approach: Incremental dual-write, then cutover**

```
Week 1-2: Shadow mode
  └─ ABL writes to both databases
  └─ AgenticAI continues as primary
  └─ Compare outputs for consistency

Week 3-4: Dual-read verification
  └─ ABL reads from both, compares
  └─ Fix any discrepancies
  └─ Build confidence in ABL data layer

Week 5: Cutover
  └─ ABL becomes primary
  └─ AgenticAI becomes read-only
  └─ Monitor for 1 week

Week 6: Decommission
  └─ Disable AgenticAI writes
  └─ Archive AgenticAI MongoDB
  └─ Redirect all traffic to ABL
```

### 12.2 Per-Collection Migration

**PostgreSQL targets (one-time migration):**

| Collection                        | Migration Script            | Estimated Records | Duration |
| --------------------------------- | --------------------------- | ----------------- | -------- |
| agents → Agent                    | `migrate-agents.ts`         | ~1000             | < 1 min  |
| agent_versions → AgentVersion     | `migrate-agent-versions.ts` | ~5000             | < 5 min  |
| tools → Tool + ToolVersion        | `migrate-tools.ts`          | ~500              | < 1 min  |
| environments → Environment        | `migrate-environments.ts`   | ~200              | < 1 min  |
| api_keys → ApiKey                 | `migrate-api-keys.ts`       | ~500              | < 1 min  |
| api_scopes → ApiScope             | `migrate-api-scopes.ts`     | ~100              | < 1 min  |
| scanners → Scanner                | `migrate-scanners.ts`       | ~100              | < 1 min  |
| pii_configs → PiiConfig           | `migrate-pii-configs.ts`    | ~100              | < 1 min  |
| audit_logs → AuditLog             | `migrate-audit-logs.ts`     | ~100K+            | ~30 min  |
| component_limits → ComponentLimit | `migrate-limits.ts`         | ~50               | < 1 min  |

**MongoDB targets (schema migration in-place):**

| Collection    | Action                              | Notes                        |
| ------------- | ----------------------------------- | ---------------------------- |
| sessions      | Add `projectId`, `channel` fields   | Backfill from appId lookup   |
| runs          | Add `agentVersionId` field          | Backfill from session lookup |
| conversations | Rename `conversation` → `flowState` | In-place update              |
| session_views | No change                           | Compatible schema            |

### 12.3 ID Mapping

AgenticAI uses custom prefixed IDs (e.g., `ag-xxx` for agents). ABL uses CUIDs.

```typescript
// migrations/shared/id-mapper.ts

/**
 * Maintains a mapping of AgenticAI IDs → ABL IDs.
 * Stored in a migration-specific MongoDB collection for reference.
 */
export class IdMapper {
  private map: Map<string, string> = new Map();

  async mapId(oldId: string, newId: string, type: string): Promise<void> {
    this.map.set(`${type}:${oldId}`, newId);
    await this.persistMapping(oldId, newId, type);
  }

  async resolveId(oldId: string, type: string): Promise<string> {
    return this.map.get(`${type}:${oldId}`) ?? oldId;
  }
}
```

### 12.4 Encryption Migration

AgenticAI encrypts fields with a custom AES-256-GCM implementation.

**Options:**

1. **Re-encrypt** (recommended): Decrypt with AgenticAI keys, re-encrypt with ABL keys
   - Requires AgenticAI encryption keys available during migration
   - Clean break from old key management

2. **Preserve**: Copy encrypted data as-is, port key management
   - No decryption needed during migration
   - Must maintain backward compatibility with AgenticAI encryption format

**Migration script:**

```typescript
// migrations/agenticai-import/migrate-encrypted-fields.ts
async function migrateEncryptedApiKeys(
  sourceDb: MongoClient,
  targetPrisma: PrismaClient,
  oldEncryption: AgenticAIEncryption,
  newEncryption: ABLEncryptionService,
) {
  const apiKeys = await sourceDb.collection('api_keys').find().toArray();

  for (const key of apiKeys) {
    // Decrypt with old system
    const plainApiKey = await oldEncryption.decrypt(key.apiKey, {
      resourceId: key._id,
      resolverId: key.accountId,
    });

    // Re-encrypt with new system
    const newApiKey = await newEncryption.encrypt(plainApiKey, {
      resourceId: key._id,
      tenantId: key.accountId,
    });

    // Store in PostgreSQL
    await targetPrisma.apiKey.create({
      data: {
        accountId: key.accountId,
        name: key.name,
        normalizedName: key.lname,
        keyHash: await bcrypt.hash(plainApiKey, 12),
        keyPrefix: plainApiKey.substring(0, 8),
        isEnabled: key.isEnabled,
        createdBy: key.createdBy,
      },
    });
  }
}
```

---

## 13. Risk Register

| Risk                                      | Impact   | Probability | Mitigation                                                             |
| ----------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------- |
| **Data loss during migration**            | Critical | Low         | Backup before migration, dual-write verification, rollback plan        |
| **API breaking changes**                  | High     | Medium      | API compatibility matrix (Appendix B), versioned endpoints             |
| **Performance regression**                | High     | Medium      | Benchmark before/after, load test each phase                           |
| **Circuit breaker false positives**       | Medium   | Medium      | Conservative thresholds, HALF_OPEN testing, manual override            |
| **Queue message loss**                    | High     | Low         | Redis persistence (AOF), BullMQ acknowledgment, dead-letter queue      |
| **Dual-database consistency**             | Medium   | Medium      | DataService abstraction, integration tests, eventual consistency model |
| **Team knowledge gap**                    | Medium   | High        | Documentation, pair programming, architecture decision records         |
| **Scope creep**                           | High     | High        | Strict phase boundaries, feature freeze during migration               |
| **Encryption key management**             | Critical | Low         | Key rotation plan, HSM for production, separate key per tenant         |
| **Voice latency increase**                | High     | Medium      | Priority queues, dedicated voice workers, latency SLO monitoring       |
| **MongoDB → PostgreSQL migration errors** | Medium   | Medium      | Per-collection validation scripts, row count verification              |
| **Langfuse availability dependency**      | Low      | Low         | Async batch flush, local fallback, Observatory works independently     |

---

## Appendix A — Schema Mappings

### AgenticAI → ABL Model Mapping

| AgenticAI Collection   | ABL Target                  | Database        | Notes                                           |
| ---------------------- | --------------------------- | --------------- | ----------------------------------------------- |
| `aaa_agents`           | `Agent` (Prisma)            | PostgreSQL      | Add ABL-specific fields (ablSource, compiledIR) |
| `aaa_agent_versions`   | `AgentVersion` (Prisma)     | PostgreSQL      | Store IR as JSON, inputs/outputs as JSON        |
| `aaa_apps`             | `Project` (Prisma)          | PostgreSQL      | Rename: app → project (ABL convention)          |
| `aaa_app_versions`     | N/A                         | —               | Merged into AgentVersion                        |
| `api_keys`             | `ApiKey` (Prisma)           | PostgreSQL      | Re-encrypt, bcrypt hash                         |
| `aaa_api_scopes`       | `ApiScope` (Prisma)         | PostgreSQL      | Direct mapping                                  |
| `aaa_tools`            | `Tool` (Prisma)             | PostgreSQL      | Direct mapping                                  |
| `aaa_tool_versions`    | `ToolVersion` (Prisma)      | PostgreSQL      | Config as JSON                                  |
| `environments`         | `Environment` (Prisma)      | PostgreSQL      | Endpoints/vars as JSON                          |
| `aaa_flows`            | Subsumed by ABL FLOW        | —               | DSL-native, no separate model needed            |
| `aaa_processors`       | Subsumed by ABL TOOLS       | —               | Processors become tools                         |
| `aaa_scanners`         | `Scanner` (Prisma)          | PostgreSQL      | Map to ABL GUARDRAILS config                    |
| `pii_configs`          | `PiiConfig` (Prisma)        | PostgreSQL      | Map to ABL GUARDRAILS                           |
| `sessions`             | `Session` (Mongoose)        | MongoDB         | Add channel, projectId                          |
| `runs`                 | `Run` (Mongoose)            | MongoDB         | Add agentVersionId                              |
| `conversations`        | `Conversation` (Mongoose)   | MongoDB         | Rename fields                                   |
| `session_views`        | `SessionView` (Mongoose)    | MongoDB         | Keep TTL                                        |
| `aaa_audit_logs`       | `AuditLog` (Prisma)         | PostgreSQL      | Normalize owner field                           |
| `aaa_files`            | New FileManager module      | PostgreSQL + S3 | Metadata in PG, content in object store         |
| `aaa_component_limits` | `ComponentLimit` (Prisma)   | PostgreSQL      | Direct mapping                                  |
| `seed_data`            | Prisma seed script          | PostgreSQL      | `prisma db seed`                                |
| `import-export-log`    | BullMQ job metadata         | Redis           | Job tracking in BullMQ                          |
| `app_variables`        | `ProjectVariable` (Prisma)  | PostgreSQL      | Encrypted values                                |
| `app_namespaces`       | `ProjectNamespace` (Prisma) | PostgreSQL      | Direct mapping                                  |
| `content_variables`    | `ContentVariable` (Prisma)  | PostgreSQL      | Direct mapping                                  |
| `mcp_servers`          | Extend ABL MCP config       | PostgreSQL      | Per-project MCP config                          |

---

## Appendix B — API Compatibility Matrix

### AgenticAI APIs That Must Be Preserved

| AgenticAI Endpoint       | ABL Equivalent            | Breaking Changes                           |
| ------------------------ | ------------------------- | ------------------------------------------ |
| `POST /api/agents`       | `POST /api/agents`        | Request body adds `ablSource` field        |
| `GET /api/agents/:id`    | `GET /api/agents/:id`     | Response includes `compiledIR`             |
| `POST /api/sessions`     | `POST /api/sessions`      | Add `channel` field                        |
| `POST /api/chat/message` | `POST /api/chat/message`  | Compatible                                 |
| `WS /chat` (Socket.IO)   | `WS /ws/chat` (native ws) | **Breaking:** Socket.IO → native WebSocket |
| `GET /api/runs`          | `GET /api/runs`           | Compatible                                 |
| `POST /api/api-keys`     | `POST /api/api-keys`      | Compatible                                 |
| `GET /api/environments`  | `GET /api/environments`   | Compatible                                 |

### Migration Path for Breaking Changes

**Socket.IO → Native WebSocket:**

- Provide a Socket.IO compatibility adapter for 3 months
- Document migration path for consumers
- Native WebSocket is the long-term target

**API versioning:**

- All new APIs under `/api/v2/`
- AgenticAI-compatible endpoints under `/api/v1/` (deprecated, 6-month sunset)

---

## Appendix C — Decision Log

| Date       | Decision                                    | Rationale                                                     | Alternatives Considered                                                                     |
| ---------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 2026-02-07 | ABL as primary codebase                     | Cleaner architecture, DSL differentiator                      | AgenticAI as base (rejected: too coupled to vendor graph framework)                         |
| 2026-02-07 | Express over NestJS                         | ABL already uses Express, lighter weight                      | NestJS (rejected: heavy DI, decorator overhead)                                             |
| 2026-02-07 | React over Angular                          | ABL Studio already React, modern ecosystem                    | Angular (rejected: legacy, slower dev velocity)                                             |
| 2026-02-07 | BullMQ over RabbitMQ                        | RabbitMQ over-provisioned for 4 flows, Redis already in stack | Kafka (rejected: overkill), RabbitMQ (rejected: ops overhead)                               |
| 2026-02-07 | BullMQ over Kafka                           | No event streaming need yet, priority queues needed           | Kafka (rejected: no native priority, complex ops)                                           |
| 2026-02-07 | Hybrid PostgreSQL + MongoDB                 | Each DB for its strengths, avoid risky full migration         | PostgreSQL only (rejected: Mixed types, TTL), MongoDB only (rejected: no relations)         |
| 2026-02-07 | Observatory + Langfuse (both)               | Complementary — dev debugging + prod analytics                | Langfuse only (rejected: no breakpoints), Observatory only (rejected: no persistence)       |
| 2026-02-07 | Redis-backed circuit breakers               | Distributed state, existing Redis infra                       | In-memory (rejected: not shared across instances), Library (rejected: no distributed state) |
| 2026-02-07 | Hierarchical breakers (tenant/app/llm/tool) | Tenant isolation, granular failure handling                   | Single-level (rejected: tenant blast radius too wide)                                       |
| 2026-02-07 | Direct LLM clients over vendor wrappers     | Less overhead, ABL's IR handles orchestration                 | Vendor wrappers (rejected: wrapper overhead, coupling)                                      |

---

_End of specification. This is a living document — update as decisions evolve._
