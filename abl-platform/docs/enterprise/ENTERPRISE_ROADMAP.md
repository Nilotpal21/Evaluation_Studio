# Agent Blueprint Language (ABL) - Enterprise Readiness Roadmap

> **Document Type**: Technical Specification & Roadmap
> **Status**: In Progress
> **Last Updated**: 2026-02-10 (Enterprise tool calling system implemented)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Assessment](#2-current-state-assessment)
3. [Enterprise Requirements](#3-enterprise-requirements)
4. [Gap Analysis by Domain](#4-gap-analysis-by-domain)
5. [Technical Specifications](#5-technical-specifications)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [Architecture Evolution](#7-architecture-evolution)
8. [Risk Assessment](#8-risk-assessment)

---

## 1. Executive Summary

### 1.1 Current State

Agent Blueprint Language (ABL) is a **development-ready** platform for building AI agents — conversational, system-driven, or hybrid — with:

- ✅ Complete ABL parser and compiler (1278+ passing tests)
- ✅ Flow-based (scripted) and reasoning modes
- ✅ Real-time debugging and visualization (Observatory UI)
- ✅ MCP debug server for Claude Code integration (15 tools, 58 tests)
- ✅ Authentication (Google OAuth, JWT, Device Auth Flow, dev-login)
- ✅ Project-based organization with dashboard
- ✅ Guardrails parsing and compilation (13 E2E tests)
- ✅ Static analysis and conflict detection (@abl/analyzer)

### 1.2 Enterprise Gap Summary

| Category                 | Readiness | Status                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**             | **95%**   | ✅ Tenant middleware, ✅ Resource guard, ✅ RBAC permissions, ✅ API key auth + scope enforcement, ✅ PII detection, ✅ Credential encryption (AES-256-GCM), ✅ Secret masking service, ✅ Key rotation service, ✅ SSRF hardening, ✅ Tool trace PII scrubbing, ✅ Tool audit logging |
| **Multi-Tenancy**        | **85%**   | ✅ Tenant context middleware, ✅ Cross-tenant prevention, ✅ Per-tenant rate limiting, ✅ Per-tenant config service (plan-based), ✅ Mongoose tenant isolation plugin, 🔲 Organization UI                                                                                              |
| **Scalability**          | 60%       | ✅ Version-time compilation (no per-session compile), ✅ IR caching via SessionService, ✅ MongoDB for metadata + control plane, ✅ ClickHouse for high-volume data, 🔲 Redis session store (production)                                                                               |
| **Reliability**          | **85%**   | ✅ Reusable circuit breaker, ✅ LLM provider resilience (fallback models), ✅ Circuit breaker registry, ✅ Rate limiting, ✅ Retry with backoff                                                                                                                                        |
| **Observability**        | 60%       | ✅ Real-time tracing, ✅ WebSocket streaming, 🔲 Metrics persistence, 🔲 Distributed tracing                                                                                                                                                                                           |
| **Tool Integration**     | **95%**   | ✅ HTTP/MCP/Lambda/Sandbox executors, ✅ SSRF hardening, ✅ Middleware chain, ✅ Secrets provider, ✅ End-user OAuth, ✅ Org proxy/gateway, ✅ Audit logging, ✅ Trace PII scrubbing, ✅ Response limits                                                                               |
| **Guardrails**           | 60%       | ✅ Parsed + compiled, 🔲 Runtime execution not wired                                                                                                                                                                                                                                   |
| **LLM Infrastructure**   | **90%**   | ✅ Model Registry, ✅ ModelRouter, ✅ UnifiedLLMProvider, ✅ EnterpriseAuth (Azure AD, OAuth2, AWS SigV4), ✅ Resilient LLM provider (circuit breaker + fallback)                                                                                                                      |
| **Auth & Authorization** | **80%**   | ✅ Google OAuth, ✅ JWT + refresh rotation, ✅ Device Auth Flow, ✅ API key scopes, ✅ Token family tracking (reuse detection), 🔲 SAML/OIDC, 🔲 MFA                                                                                                                                   |
| **Data Retention**       | **60%**   | ✅ Retention policy engine, ✅ GDPR deletion service, ✅ Compliance conflict resolution, ✅ Schema support (KeyVersion, DeletionRequest), 🔲 Scheduled enforcement, 🔲 S3 archival                                                                                                     |
| **NLU Engine**           | **75%**   | ✅ Modular pipeline, ✅ Enterprise layers (tenant, cache, circuit breaker, PII guard, audit, versioning)                                                                                                                                                                               |

### 1.3 Key Design Decisions (Resolved)

| Decision              | Choice                                           | Rationale                                                  |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Tenant naming         | **Account** (not Organization)                   | Simpler, works for all tiers                               |
| Metadata DB           | **MongoDB** (all metadata & control plane)       | Flexible schema, ~1M writes/day, team familiarity          |
| High-volume DB        | **ClickHouse** (messages, traces, logs, metrics) | Columnar compression, TTL, tiered storage, 330M writes/day |
| Trace PII             | **Redact before ClickHouse**                     | Preserve query ability, full data in MongoDB only          |
| Agent sharing         | **Project-scoped, account-visible opt-in**       | `visibility` field on ProjectAgent                         |
| Model tiers           | **fast/balanced/powerful**                       | Maps to haiku/sonnet/opus, simple mental model             |
| Credential encryption | **AES-256-GCM per-user**                         | Industry standard, user-scoped key derivation              |
| Store interface       | **Extend compiler abstractions**                 | Single source of truth, enables swappable backends         |
| Provider protocol     | **LiteLLM-compatible**                           | 100+ models via unified API                                |

> See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) for full design decisions.

### 1.3 Estimated Effort

| Phase                       | Duration    | Focus                             |
| --------------------------- | ----------- | --------------------------------- |
| Phase 1: Production Minimum | 6-8 weeks   | Database, Redis, tools, Docker    |
| Phase 2: Enterprise Core    | 8-10 weeks  | Multi-tenancy, SSO, observability |
| Phase 3: Advanced Features  | 10-12 weeks | Vector memory, marketplace, SDKs  |

---

## 2. Current State Assessment

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CURRENT ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │    Studio    │────▶│   Platform   │────▶│   SQLite     │                │
│  │  (React UI)  │ WS  │  (Express)   │     │  (dev.db)    │                │
│  └──────────────┘     └──────────────┘     └──────────────┘                │
│         │                    │                                              │
│         │              ┌─────┴─────┐                                        │
│         │              │           │                                        │
│         │         ┌────▼────┐ ┌────▼────┐                                  │
│         │         │ Runtime │ │  Auth   │                                  │
│         │         │Executor │ │Service  │                                  │
│         │         └────┬────┘ └─────────┘                                  │
│         │              │                                                    │
│         │         ┌────▼────┐                                              │
│         │         │Anthropic│                                              │
│         │         │   API   │                                              │
│         │         └─────────┘                                              │
│         │                                                                   │
│  ┌──────▼──────────────────────────────────────────────────┐               │
│  │                    IN-MEMORY STATE                       │               │
│  │  • Sessions (Map<string, RuntimeSession>)               │               │
│  │  • Traces (TraceStore)                                  │               │
│  │  • Agent Cache (none - recompiles each time)            │               │
│  └─────────────────────────────────────────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Inventory

#### Core Platform Services

| Layer             | Component                | Current State                             | Target State                            |
| ----------------- | ------------------------ | ----------------------------------------- | --------------------------------------- |
| **Database**      | Metadata & Control Plane | MongoDB (Mongoose) ✅                     | Same (production replica set)           |
|                   | High-Volume Data         | ClickHouse ✅                             | Same (tiered storage to object storage) |
|                   | Caching & Queues         | Redis ✅                                  | Redis Cluster                           |
| **Auth**          | User Auth                | JWT + Google OAuth + Device Auth ✅       | + SAML 2.0, OIDC                        |
|                   | API Keys                 | SHA-256 hash + prefix lookup ✅           | Same                                    |
|                   | RBAC                     | Tenant middleware + Resource guard ✅     | + Workspace hierarchy                   |
|                   | Rate Limiting            | Per-tenant sliding window ✅              | Redis-backed                            |
| **LLM**           | Provider                 | UnifiedLLMProvider (SSE) ✅               | Same                                    |
|                   | Routing                  | ModelRouter (tier-based) ✅               | + Cost optimization                     |
|                   | Enterprise Auth          | Azure AD, OAuth2, AWS SigV4 ✅            | + mTLS                                  |
|                   | Resilience               | ResilientLLMProvider ✅                   | Same                                    |
| **Tools**         | Executor                 | ServiceNodeExecutor ✅                    | Same                                    |
|                   | Circuit Breaker          | RedisCircuitBreaker (Lua) ✅              | Same                                    |
|                   | Health                   | Basic                                     | Full monitoring                         |
| **Security**      | Encryption               | AES-256-GCM EncryptionService ✅          | + HSM key storage                       |
|                   | Key Rotation             | KeyRotationService (DEK, API keys) ✅     | Automated rotation                      |
|                   | PII                      | PIIDetector + redaction ✅                | + ML classification                     |
|                   | Secrets                  | Secret masking ✅                         | HashiCorp Vault                         |
| **Data Mgmt**     | Retention                | RetentionService (archival, PII scrub) ✅ | + Scheduled jobs                        |
|                   | Tenant Config            | TenantConfigService (plans, limits) ✅    | Same                                    |
|                   | Agent Versions           | PrismaAgentRegistry + versioning ✅       | Same                                    |
| **NLU**           | Engine                   | Modular pipeline ✅                       | Same                                    |
|                   | Enterprise               | Tenant manager, cache, circuit breaker ✅ | Same                                    |
|                   | Safety                   | PII guard, audit hooks ✅                 | + ML guardrails                         |
| **Observability** | Tracing                  | Real-time WebSocket (Observatory) ✅      | + Persistence                           |
|                   | Metrics                  | Console logs                              | Prometheus + Grafana                    |
|                   | Distributed              | None                                      | OpenTelemetry → SigNoz                  |

#### Prisma Schema Summary (Current)

| Model                                     | Purpose                        | Status |
| ----------------------------------------- | ------------------------------ | ------ |
| `User`, `RefreshToken`                    | User authentication            | ✅     |
| `Organization`, `OrgMember`, `ApiKey`     | Multi-tenancy                  | ✅     |
| `Project`, `ProjectAgent`, `AgentVersion` | Agent management & versioning  | ✅     |
| `Session`, `Message`                      | Conversation store             | ✅     |
| `AgentSession`                            | Debug sessions                 | ✅     |
| `LLMCredential`                           | Encrypted provider credentials | ✅     |
| `ModelConfig`                             | Project-level model settings   | ✅     |
| `ServiceNode`                             | External API tool definitions  | ✅     |
| `LLMUsageMetric`                          | Usage tracking                 | ✅     |
| `AuditLog`                                | Compliance audit trail         | ✅     |
| `DebugToken`, `DeviceAuthRequest`         | CLI/MCP authentication         | ✅     |

### 2.3 Target Tech Stack

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PRODUCTION ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   METADATA (MongoDB)             HIGH-VOLUME (ClickHouse)               │
│   ┌───────────────────────┐      ┌───────────────────────────────────┐ │
│   │  • Users & Auth       │      │  • Messages (25M/day)             │ │
│   │  • Organizations      │      │  • Traces (200M/day)              │ │
│   │  • Projects & Agents  │      │  • LLM Metrics (40M/day)          │ │
│   │  • Conversations      │      │  • Logs (65M/day)                 │ │
│   │  • Contacts           │      │  • Audit Events                   │ │
│   │  • Workflows          │      │  • Tiered: NVMe → Object Storage  │ │
│   │  • Configs & RBAC     │      │  • TTL per table (automatic)      │ │
│   │  • Audit Logs         │      │  • Materialized views             │ │
│   └───────────────────────┘      └───────────────────────────────────┘ │
│                                                                          │
│   CACHE & REALTIME (Redis)       OBSERVABILITY (Planned)                │
│   ┌───────────────────────┐      ┌───────────────────────────────────┐ │
│   │  • Session state      │      │  ✅ Observatory (real-time)       │ │
│   │  • Circuit breaker    │      │  🔲 Prometheus metrics            │ │
│   │  • Rate limit counts  │      │  🔲 OpenTelemetry traces          │ │
│   │  • Pub/Sub (WebSocket)│      │  🔲 Grafana dashboards            │ │
│   │  • IR compilation     │      │  🔲 SigNoz distributed tracing    │ │
│   └───────────────────────┘      └───────────────────────────────────┘ │
│                                                                          │
│   LLM LAYER (Implemented ✅)     MESSAGING (Redis + BullMQ)             │
│   ┌───────────────────────┐      ┌───────────────────────────────────┐ │
│   │  ✅ UnifiedLLMProvider │      │  🔲 BullMQ job queues             │ │
│   │  ✅ ModelRouter        │      │  🔲 Async tool execution          │ │
│   │  ✅ EnterpriseAuth     │      │  🔲 Webhook delivery              │ │
│   │  ✅ ResilientProvider  │      │  🔲 Dead letter queue             │ │
│   │  ✅ SSE Streaming      │      │  🔲 Scheduled jobs (retention)    │ │
│   └───────────────────────┘      └───────────────────────────────────┘ │
│                                                                          │
│   SECURITY (Implemented ✅)                                              │
│   ┌───────────────────────┐                                              │
│   │  ✅ AES-256-GCM        │                                             │
│   │  ✅ Key rotation       │                                             │
│   │  ✅ PII detection      │                                             │
│   │  ✅ RBAC + guards      │                                             │
│   │  ✅ Tenant isolation   │                                             │
│   └───────────────────────┘                                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.4 Implemented Services (apps/platform/src/services/)

| Directory     | Service                        | Description                                         |
| ------------- | ------------------------------ | --------------------------------------------------- |
| `llm/`        | `unified-provider.ts`          | SSE streaming LLM provider                          |
|               | `model-router.ts`              | Tier-based model selection (fast/balanced/powerful) |
|               | `enterprise-auth.ts`           | Azure AD, OAuth2, AWS SigV4 authentication          |
|               | `provider-bridge.ts`           | Compiler ↔ Platform provider integration            |
| `adapters/`   | `service-node-executor.ts`     | HTTP tool execution with auth injection             |
|               | `llm-client-adapter.ts`        | BaseRuntime LLM client adapter                      |
|               | `agent-registry-adapter.ts`    | BaseRuntime agent registry adapter                  |
| `stores/`     | `prisma-conversation-store.ts` | Conversation persistence                            |
|               | `prisma-agent-registry.ts`     | Agent version management                            |
| `resilience/` | `circuit-breaker.ts`           | In-process circuit breaker                          |
|               | `resilient-llm-provider.ts`    | LLM provider with retry + fallback                  |
| `security/`   | `key-rotation-service.ts`      | Envelope encryption, DEK rotation                   |
|               | `secret-masking.ts`            | Secret redaction in logs                            |
| `retention/`  | `retention-service.ts`         | Data archival, PII scrubbing                        |
| `auth/`       | `token-family.ts`              | Refresh token family tracking                       |
| root          | `encryption-service.ts`        | AES-256-GCM encryption                              |
|               | `tenant-config.ts`             | Per-tenant limits and features                      |
|               | `audit-service.ts`             | Audit logging                                       |

### 2.5 What Works Well (Production-Ready)

| Feature                | Status        | Test Coverage   | Notes                               |
| ---------------------- | ------------- | --------------- | ----------------------------------- |
| **Core DSL**           |
| Parser                 | ✅ Production | 182 tests       | Full ABL syntax support             |
| Compiler               | ✅ Production | 266 tests       | Complete IR schema                  |
| Analyzer               | ✅ Production | @abl/analyzer   | Static analysis, conflict detection |
| **Runtime**            |
| Flow Execution         | ✅ Production | 65 E2E tests    | Scripted mode complete              |
| Reasoning Execution    | ✅ Production |                 | Tool calling, constraints           |
| Multi-agent            | ✅ Production |                 | Delegate, handoff, escalate         |
| **Tracing & Debug**    |
| Real-time Tracing      | ✅ Production | 22+ event types | WebSocket streaming                 |
| State Machine Viz      | ✅ Production |                 | Dagre layout, multi-agent           |
| MCP Debug Server       | ✅ Production | 58 tests        | 15 tools for Claude Code            |
| **LLM Infrastructure** |
| UnifiedLLMProvider     | ✅ Production |                 | SSE streaming                       |
| ModelRouter            | ✅ Production |                 | Tier-based (fast/balanced/powerful) |
| EnterpriseAuth         | ✅ Production |                 | Azure AD, OAuth2, AWS SigV4         |
| **Security**           |
| EncryptionService      | ✅ Production |                 | AES-256-GCM, per-user keys          |
| RBAC                   | ✅ Production |                 | Tenant middleware + Resource guard  |
| API Key Auth           | ✅ Production |                 | SHA-256, prefix lookup              |
| PII Detection          | ✅ Production |                 | Regex + Luhn validation             |
| **Resilience**         |
| Circuit Breaker        | ✅ Production |                 | Redis Lua scripts, 3 levels         |
| Rate Limiting          | ✅ Production |                 | Per-tenant sliding window           |
| Retry Logic            | ✅ Production |                 | Exponential backoff                 |
| **NLU Engine**         |
| Modular Pipeline       | ✅ Production |                 | Task-based architecture             |
| Enterprise Layer       | ✅ Production |                 | Tenant, cache, audit, PII           |

---

## 3. Enterprise Requirements

### 3.1 Security Requirements

#### 3.1.1 Authentication & Authorization

| Requirement               | Priority | Current                                   | Target            | Status |
| ------------------------- | -------- | ----------------------------------------- | ----------------- | ------ |
| SSO Integration           | P0       | Google OAuth                              | + SAML 2.0, OIDC  | 🔲     |
| API Key Authentication    | P0       | **SHA-256 hash, scopes, expiry** ✅       | + Rotation API    | ✅     |
| Service Accounts          | P1       | API keys with scopes ✅                   | + Dedicated flow  | ✅     |
| Role-Based Access Control | P0       | **RBAC (OWNER/ADMIN/MEMBER/VIEWER)** ✅   | + Workspace level | ✅     |
| Fine-grained Permissions  | P1       | **Permission strings per role** ✅        | Same              | ✅     |
| Tenant Isolation          | P0       | **Tenant middleware + Resource guard** ✅ | Same              | ✅     |
| Rate Limiting             | P0       | **Per-tenant sliding window** ✅          | Redis-backed      | ✅     |

**RBAC Model:**

```
Account (tenant boundary — billing, data isolation)
├── Owner (full access)
├── Admin (manage workspaces, billing)
└── Member (access assigned workspaces)
    │
    Workspace (collaboration boundary)
    ├── Owner (manage workspace settings)
    ├── Admin (manage members, projects)
    ├── Member (edit agents, run sessions)
    └── Viewer (read-only access)
        │
        Project
        ├── Agents (project-scoped, optional account-wide visibility)
        └── Sessions
```

> See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) for full schema design.

#### 3.1.2 Data Security

| Requirement            | Priority | Implementation                             | Status                  |
| ---------------------- | -------- | ------------------------------------------ | ----------------------- |
| Encryption at Rest     | P0       | AES-256-GCM per-user derived keys          | ✅ EncryptionService    |
| Encryption in Transit  | P0       | TLS 1.3 for all connections                | 🔲 Pending              |
| Field-level Encryption | P1       | LLM credentials, API secrets               | ✅ Encrypted columns    |
| Key Management         | P0       | ENCRYPTION_MASTER_KEY + KeyRotationService | ✅ DEK rotation         |
| PII Detection          | P1       | Regex + Luhn validation                    | ✅ PIIDetector          |
| Secret Masking         | P1       | Redact secrets in logs                     | ✅ SecretMaskingService |
| Data Retention         | P1       | Per-tenant policies, archival, PII scrub   | ✅ RetentionService     |
| Data Residency         | P1       | Region-specific deployments                | 🔲 Pending              |

#### 3.1.3 Compliance

| Standard      | Requirements                                |
| ------------- | ------------------------------------------- |
| SOC 2 Type II | Audit logs, access controls, encryption     |
| GDPR          | Data export, deletion, consent tracking     |
| HIPAA         | PHI encryption, access logging, BAA support |
| PCI DSS       | If handling payment data in agents          |

### 3.2 Scalability Requirements

#### 3.2.1 Performance Targets

| Metric                | Current              | Target            |
| --------------------- | -------------------- | ----------------- |
| Concurrent Sessions   | ~50 (memory limited) | 10,000+           |
| API Latency (p99)     | Unknown              | < 200ms (non-LLM) |
| WebSocket Connections | ~100                 | 50,000+           |
| Agent Load Time       | ~500ms (recompile)   | < 50ms (cached)   |
| Database Connections  | 1 (SQLite)           | 100+ pool         |

#### 3.2.2 Infrastructure Targets

| Component     | Current         | Target                                                     |
| ------------- | --------------- | ---------------------------------------------------------- |
| API Servers   | 1               | Auto-scaling 3-20                                          |
| Database      | SQLite (legacy) | MongoDB (3-node replica set) + ClickHouse (tiered storage) |
| Cache         | None            | Redis Cluster (3 nodes)                                    |
| Message Queue | None            | Redis + BullMQ                                             |
| CDN           | None            | CloudFront/Fastly for static assets                        |

### 3.3 Reliability Requirements

| Metric                | Target                           |
| --------------------- | -------------------------------- |
| Uptime SLA            | 99.9% (8.76 hours downtime/year) |
| RTO (Recovery Time)   | < 1 hour                         |
| RPO (Recovery Point)  | < 5 minutes                      |
| Error Rate            | < 0.1%                           |
| Mean Time to Recovery | < 15 minutes                     |

### 3.4 Production Scaling Patterns (Lessons Learned)

> **Context**: Previous platform hit Redis connection limits, data throughput issues, and network I/O bottlenecks at scale. This section documents architectural patterns to prevent these issues.

#### 3.4.1 Redis Connection Management

**Problem**: Each API server opening many Redis connections → hitting `maxclients` limit.

**Solution: Connection Pooling + Multiplexing**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    REDIS CONNECTION ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   API Server (per instance)                                             │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │                                                                   │  │
│   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│   │   │   Session    │  │    Cache     │  │   BullMQ     │          │  │
│   │   │   Pool (5)   │  │   Pool (10)  │  │  Pool (5)    │          │  │
│   │   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │  │
│   │          │                 │                 │                   │  │
│   │          └────────────┬────┴────────────────┘                   │  │
│   │                       │                                          │  │
│   │              ┌────────▼────────┐                                │  │
│   │              │   Multiplexer   │ ← Pipeline batching            │  │
│   │              │   (ioredis)     │ ← Command coalescing           │  │
│   │              └────────┬────────┘                                │  │
│   │                       │                                          │  │
│   └───────────────────────┼──────────────────────────────────────────┘  │
│                           │                                              │
│                           ▼                                              │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │                    REDIS CLUSTER (6 nodes)                       │  │
│   │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │  │
│   │  │Primary 1│ │Primary 2│ │Primary 3│ │Replica 1│ │Replica 2│   │  │
│   │  │ Slots   │ │ Slots   │ │ Slots   │ │ (reads) │ │ (reads) │   │  │
│   │  │ 0-5460  │ │5461-10922│ │10923-16383│         │          │   │  │
│   │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Implementation:**

```typescript
// Singleton connection pools per workload type
import Redis from 'ioredis';

// Separate pools for different workloads (prevents one from starving others)
const pools = {
  // Sessions: low connection count, high frequency
  sessions: new Redis.Cluster(nodes, {
    scaleReads: 'slave', // Read from replicas
    maxRedirections: 3,
    retryDelayOnClusterDown: 100,
    redisOptions: {
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      commandTimeout: 2000,
    },
  }),

  // Cache: high connection count, read-heavy
  cache: new Redis.Cluster(nodes, {
    scaleReads: 'slave',
    enableReadyCheck: true,
    redisOptions: {
      maxRetriesPerRequest: 1, // Fail fast for cache
      connectTimeout: 3000,
    },
  }),

  // BullMQ: dedicated pool (long-running connections)
  jobs: new Redis.Cluster(nodes, {
    maxRetriesPerRequest: null, // BullMQ requires this
    enableOfflineQueue: false,
  }),
};

// Connection limits per 20-server deployment:
// - Sessions: 5 × 20 = 100 connections
// - Cache: 10 × 20 = 200 connections
// - Jobs: 5 × 20 = 100 connections
// Total: ~400 connections (Redis Cluster default: 10,000)
```

**Key Patterns:**
| Pattern | Purpose |
|---------|---------|
| **Separate pools** | Isolate workloads (sessions can't starve cache) |
| **Read replicas** | `scaleReads: 'slave'` offloads reads to replicas |
| **Pipeline batching** | Group multiple commands into single round-trip |
| **Command coalescing** | Multiple identical reads → single Redis call |
| **Connection reuse** | Singleton pools, no per-request connections |

#### 3.4.2 Write-Heavy Data Architecture

**Load Pattern:**

- **95% Writes**: Voice calls, chat messages, session state, traces
- **5% Reads**: Admin history lookups, analytics dashboards

**Problem**: High write volume saturating single MongoDB primary or Redis node.

**Solution: Append-Only + Async Persistence + Write Sharding**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              WRITE-OPTIMIZED DATA FLOW (Event Sourcing)                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Voice/Chat Message                                                    │
│   ┌───────────────────┐                                                 │
│   │   API Request     │                                                 │
│   └─────────┬─────────┘                                                 │
│             │                                                            │
│             ▼                                                            │
│   ┌───────────────────┐  Sync (< 5ms)                                   │
│   │  Redis Streams    │◄──────────────── Append-only event log          │
│   │  (Write buffer)   │                  No blocking persistence        │
│   └─────────┬─────────┘                                                 │
│             │                                                            │
│             │ Immediate ACK to client                                   │
│             │                                                            │
│             ▼ Async (BullMQ consumer)                                   │
│   ┌───────────────────┐                                                 │
│   │  Write Workers    │  Batch processing (100 events / 500ms)          │
│   │  (3-5 per shard)  │                                                 │
│   └─────────┬─────────┘                                                 │
│             │                                                            │
│       ┌─────┴─────┬──────────────┐                                      │
│       ▼           ▼              ▼                                      │
│   ┌────────┐ ┌────────┐    ┌──────────┐                                │
│   │MongoDB │ │MongoDB │    │ClickHouse│                                │
│   │Shard 1 │ │Shard 2 │    │(Analytics)│                                │
│   └────────┘ └────────┘    └──────────┘                                │
│                                                                          │
│   READS (Admin/History) ─────────────────────────────────────────────── │
│   ┌───────────────────┐                                                 │
│   │   Admin Request   │                                                 │
│   └─────────┬─────────┘                                                 │
│             │                                                            │
│             ▼                                                            │
│   ┌───────────────────┐  Read from replicas (eventual consistency OK)   │
│   │ MongoDB Replicas  │  Latency tolerance: 500ms acceptable            │
│   └───────────────────┘                                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Pattern: Redis Streams as Write Buffer**

```typescript
// Redis Streams: Append-only log, consumer groups for parallel processing
// - Write: O(1) append, immediate ACK
// - Read: Consumer groups handle backpressure

import Redis from 'ioredis';

const redis = new Redis.Cluster(nodes);

// Write path: Ultra-fast append (< 1ms)
async function appendMessage(sessionId: string, message: Message): Promise<string> {
  const streamKey = `stream:messages:${sessionId.slice(0, 2)}`; // Shard by prefix

  const eventId = await redis.xadd(
    streamKey,
    'MAXLEN',
    '~',
    '100000', // Trim old entries
    '*', // Auto-generate ID
    'sessionId',
    sessionId,
    'payload',
    JSON.stringify(message),
    'timestamp',
    Date.now().toString(),
  );

  return eventId; // Immediate ACK - persistence is async
}

// Consumer: Batch persist to MongoDB
async function startMessageConsumer(shardId: string): Promise<void> {
  const streamKey = `stream:messages:${shardId}`;
  const groupName = 'message-persisters';
  const consumerId = `consumer-${process.pid}`;

  // Create consumer group if not exists
  try {
    await redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
  } catch (e) {
    /* Group exists */
  }

  while (true) {
    // Read batch of 100 messages, block for 500ms if empty
    const entries = await redis.xreadgroup(
      'GROUP',
      groupName,
      consumerId,
      'COUNT',
      100,
      'BLOCK',
      500,
      'STREAMS',
      streamKey,
      '>',
    );

    if (!entries || entries.length === 0) continue;

    const messages = entries[0][1].map(parseEntry);

    // Bulk insert to MongoDB
    await mongodb.messages.insertMany(messages, {
      ordered: false, // Continue on duplicate
      writeConcern: { w: 1 }, // Acknowledge after primary write
    });

    // ACK processed messages
    const ids = entries[0][1].map((e) => e[0]);
    await redis.xack(streamKey, groupName, ...ids);
  }
}
```

**MongoDB Write Optimization:**

```typescript
// Write concern tuning for throughput (not durability-critical)
const messageCollection = mongodb.collection('messages', {
  writeConcern: {
    w: 1, // Acknowledge after primary (not replicas)
    j: false, // Don't wait for journal
    wtimeout: 1000, // Timeout after 1s
  },
});

// Bulk writes with unordered (parallel) execution
async function persistBatch(messages: Message[]): Promise<void> {
  const ops = messages.map((m) => ({
    insertOne: { document: m },
  }));

  await messageCollection.bulkWrite(ops, {
    ordered: false, // Parallel execution, continue on error
  });
}

// Sharding: Hash by tenantId for even distribution
// Key: { tenantId: 'hashed' } - O(1) routing
db.adminCommand({
  shardCollection: 'abl.messages',
  key: { tenantId: 'hashed' },
});
```

**Write Throughput Targets:**

| Component                 | Capacity        | Notes                   |
| ------------------------- | --------------- | ----------------------- |
| Redis Streams (per shard) | 100K writes/sec | Append-only, in-memory  |
| MongoDB (per shard)       | 10K writes/sec  | Batched, w:1, unordered |
| Total (3 shards)          | 30K+ writes/sec | Linear scaling          |

**Backpressure Handling:**

```typescript
// If Redis Streams back up, apply backpressure to API
async function appendWithBackpressure(sessionId: string, message: Message): Promise<string> {
  const streamKey = `stream:messages:${sessionId.slice(0, 2)}`;

  // Check stream length
  const len = await redis.xlen(streamKey);

  if (len > 50000) {
    // Stream backing up - slow down
    throw new TooManyRequestsError('Write buffer full, retry in 100ms');
  }

  return appendMessage(sessionId, message);
}
```

// Usage: Trace events buffered, bulk inserted every 100 items or 1 second
const traceBuffer = new WriteBuffer(
async (traces) => {
await mongodb.traces.insertMany(traces, { ordered: false });
},
100, // 100 traces per batch
1000, // or every 1 second
);

```

#### 3.4.3 Network I/O Optimization

**Problem**: Excessive round-trips, large payloads, cross-AZ traffic.

**Solution: Locality + Compression + Protocol Optimization**

```

┌─────────────────────────────────────────────────────────────────────────┐
│ NETWORK TOPOLOGY (Single Region) │
├─────────────────────────────────────────────────────────────────────────┤
│ │
│ Availability Zone A Availability Zone B │
│ ┌─────────────────────────┐ ┌─────────────────────────┐ │
│ │ │ │ │ │
│ │ ┌──────┐ ┌──────┐ │ │ ┌──────┐ ┌──────┐ │ │
│ │ │API 1 │ │API 2 │ │ │ │API 3 │ │API 4 │ │ │
│ │ └──┬───┘ └──┬───┘ │ │ └──┬───┘ └──┬───┘ │ │
│ │ │ │ │ │ │ │ │ │
│ │ ▼ ▼ │ │ ▼ ▼ │ │
│ │ ┌─────────────────┐ │ │ ┌─────────────────┐ │ │
│ │ │ Redis Primary │◄───┼─────┼──│ Redis Replica │ │ │
│ │ │ (writes) │ │ │ │ (local reads) │ │ │
│ │ └─────────────────┘ │ │ └─────────────────┘ │ │
│ │ │ │ │ │
│ │ ┌─────────────────┐ │ │ ┌─────────────────┐ │ │
│ │ │ MongoDB Primary │◄───┼─────┼──│ MongoDB Secondary│ │ │
│ │ └─────────────────┘ │ │ └─────────────────┘ │ │
│ │ │ │ │ │
│ └─────────────────────────┘ └─────────────────────────┘ │
│ │
│ Key: Reads go to local replica, writes go to primary │
│ Cross-AZ traffic: writes only (~10% of operations) │
│ │
└─────────────────────────────────────────────────────────────────────────┘

````

**Optimization Techniques:**

| Technique | Reduction | Implementation |
|-----------|-----------|----------------|
| **Payload compression** | 60-80% | `zstd` for MongoDB, `lz4` for Redis |
| **Binary protocol** | 30-50% | MessagePack instead of JSON for internal |
| **Pipeline batching** | 90% RTT | Redis `pipeline()`, MongoDB `bulkWrite()` |
| **Local read replicas** | 90% latency | Same-AZ replica reads |
| **Connection keepalive** | Eliminate handshakes | HTTP/2, persistent Redis |
| **Request coalescing** | 50-90% | Dedupe identical concurrent requests |

**Implementation:**

```typescript
// 1. Compression for large payloads
import { compress, decompress } from '@mongodb-js/zstd';

async function storeSession(session: Session): Promise<void> {
  const payload = JSON.stringify(session.state);

  // Only compress if > 1KB
  if (payload.length > 1024) {
    const compressed = await compress(Buffer.from(payload));
    await redis.set(`session:${session.id}`, compressed);
    await redis.set(`session:${session.id}:compressed`, '1');
  } else {
    await redis.set(`session:${session.id}`, payload);
  }
}

// 2. Request coalescing (dedupe concurrent identical reads)
const inflightRequests = new Map<string, Promise<any>>();

async function getSessionCoalesced(sessionId: string): Promise<Session> {
  const key = `session:${sessionId}`;

  // If same request is in-flight, reuse it
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key)!;
  }

  const promise = redis.get(key).then(parse).finally(() => {
    inflightRequests.delete(key);
  });

  inflightRequests.set(key, promise);
  return promise;
}

// 3. Pipeline batching for bulk operations
async function getMultipleSessions(ids: string[]): Promise<Session[]> {
  const pipeline = redis.pipeline();
  ids.forEach(id => pipeline.get(`session:${id}`));
  const results = await pipeline.exec();
  return results.map(([err, data]) => data ? parse(data) : null);
}
````

#### 3.4.4 Architecture Summary for Scale

| Problem                     | Solution                               | Expected Improvement       |
| --------------------------- | -------------------------------------- | -------------------------- |
| **Redis connection limits** | Pooling + Cluster + Read replicas      | 10x connection capacity    |
| **Data throughput**         | Sharding + Write buffers + CQRS        | 50x write throughput       |
| **Network I/O**             | Compression + Local reads + Batching   | 80% bandwidth reduction    |
| **Single point of failure** | Multi-AZ + Replicas                    | 99.99% availability        |
| **Hot tenant**              | Tenant-level rate limiting + Isolation | Fair resource distribution |

**Target Scale:**

| Metric              | Current Architecture | With Patterns    |
| ------------------- | -------------------- | ---------------- |
| Concurrent sessions | 10,000               | 500,000+         |
| Messages/second     | 100                  | 50,000+          |
| Redis connections   | 400                  | 400 (pooled)     |
| API servers         | 20                   | 100+ (stateless) |
| p99 latency         | 200ms                | <50ms (cached)   |

---

## 4. Gap Analysis by Domain

### 4.1 Security & Access Control

#### Gap 4.1.1: Multi-Tenancy ✅ PARTIALLY IMPLEMENTED

**Current State (Updated 2026-02-07):**

- ✅ **Tenant Middleware** — extracts tenant context from JWT or API key
- ✅ **RBAC Permissions** — OWNER, ADMIN, MEMBER, VIEWER roles with permission mapping
- ✅ **Resource Guard** — prevents cross-tenant access to projects, sessions, agents, credentials
- ✅ **Per-Tenant Rate Limiting** — sliding window rate limiter scoped to tenant
- ✅ **Organization/Member Schema** — Prisma models for Organization, OrgMember
- 🔲 **Organization Management UI** — pending
- 🔲 **Workspace hierarchy** — pending (Account → Workspace → Project)

**Previous State:**

- Users own projects directly
- No organization concept
- No team workspaces
- No data isolation between users

**Required Changes:**

```prisma
// New schema additions — see PLATFORM_OBSERVABILITY_ROADMAP.md for full design

model Account {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  plan        Plan     @default(FREE)
  stripeCustomerId String?
  retentionDays    Int     @default(7)

  members     AccountMember[]
  workspaces  Workspace[]

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model Workspace {
  id          String   @id @default(cuid())
  accountId   String
  name        String
  slug        String
  account     Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)

  members     WorkspaceMember[]
  projects    Project[]

  @@unique([accountId, slug])
}

model WorkspaceMember {
  id          String   @id @default(cuid())
  workspaceId String
  userId      String
  role        Role     @default(MEMBER)  // OWNER, ADMIN, MEMBER, VIEWER

  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, userId])
}

enum Plan {
  FREE       // 1 user, 3 projects, 1000 messages/month, 7-day trace retention
  TEAM       // 10 users, unlimited projects, 50k messages/month, 30-day retention
  BUSINESS   // 100 users, SSO, 500k messages/month, 90-day retention
  ENTERPRISE // Unlimited, custom retention, CSFLE encryption
}
```

**Effort:** 3-4 weeks

#### Gap 4.1.2: API Key Authentication ✅ IMPLEMENTED

**Current State (Updated 2026-02-07):**

- ✅ API key authentication via `abl_*` prefix format
- ✅ SHA-256 hash storage (never store plain keys)
- ✅ Prefix-based lookup for performance
- ✅ Scoped permissions (parsed from JSON)
- ✅ Expiration and revocation support
- ✅ Last-used timestamp tracking
- See: `apps/platform/src/middleware/tenant.ts`

**Previous State:**

- JWT only (requires OAuth flow)
- No programmatic access
- No scoped permissions

**Required Implementation:**

```typescript
// API Key structure
interface ApiKey {
  id: string;
  keyHash: string; // SHA-256 hash (never store plain)
  prefix: string; // First 8 chars for identification
  name: string;
  organizationId: string;
  scopes: ApiScope[]; // ['agents:read', 'sessions:write', ...]
  rateLimit: number; // Requests per minute
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdBy: string;
}

// Middleware
async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return next(); // Fall through to JWT

  const prefix = key.slice(0, 8);
  const apiKey = await db.apiKey.findFirst({
    where: { prefix, revokedAt: null },
  });

  if (!apiKey || !verifyHash(key, apiKey.keyHash)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return res.status(401).json({ error: 'API key expired' });
  }

  req.apiKey = apiKey;
  req.organizationId = apiKey.organizationId;
  next();
}
```

**Effort:** 1-2 weeks

#### Gap 4.1.3: Audit Logging

**Current State:**

- Basic AuditLog schema exists
- Only auth events logged
- Not queryable

**Required Implementation:**

```typescript
// Comprehensive audit events
type AuditAction =
  // Auth
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token_refresh'
  // Organization
  | 'org.create'
  | 'org.update'
  | 'org.delete'
  | 'org.member_add'
  | 'org.member_remove'
  | 'org.member_role_change'
  // Project
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'project.member_add'
  | 'project.member_remove'
  // Agent
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.deploy'
  // Session
  | 'session.create'
  | 'session.message'
  | 'session.escalate'
  // API Key
  | 'apikey.create'
  | 'apikey.revoke'
  // Admin
  | 'admin.user_impersonate'
  | 'admin.data_export';

interface AuditEntry {
  id: string;
  timestamp: Date;
  action: AuditAction;
  actorId: string; // User or API key
  actorType: 'user' | 'apikey' | 'system';
  organizationId: string;
  resourceType: string; // 'project', 'agent', 'session'
  resourceId: string;
  metadata: Record<string, unknown>;
  ip: string;
  userAgent: string;
  // Immutability
  hash: string; // SHA-256 of previous entry (blockchain-style)
}
```

**Storage:** Consider append-only storage (S3 + Athena) for compliance.

**Effort:** 2 weeks

---

### 4.2 Scalability & Infrastructure

#### Gap 4.2.1: Database Migration (SQLite → Polyglot Persistence)

**Current State:**

- SQLite single file (`dev.db`)
- Prisma ORM
- Limited concurrent writes
- No replication

**Target Architecture — MongoDB + ClickHouse (no PostgreSQL):**

- **MongoDB** (all metadata & control plane): Accounts, workspaces, members, projects, auth, audit logs, sessions, conversation metadata, contacts, workflows, agent state, IR cache — flexible schema, ~1M writes/day
- **ClickHouse** (high-volume operational): Messages (25M/day), traces (200M/day), logs (65M/day), LLM metrics (40M/day), audit events — columnar compression, TTL, tiered storage
- **Redis**: Ephemeral cache, pub/sub for WebSocket scaling, active session message buffer

> See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) for full rationale.

**Migration Steps:**

1. **Add Mongoose for MongoDB:**

```typescript
// packages/platform/src/db/mongodb.ts

import mongoose from 'mongoose';

const connectionOptions = {
  maxPoolSize: 50,
  minPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
};

export async function connectMongoDB() {
  await mongoose.connect(process.env.MONGODB_URL!, connectionOptions);
  console.log('MongoDB connected');
}

// Schemas
const agentSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  domain: { type: String, required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  dslSource: String,
  compiledIR: mongoose.Schema.Types.Mixed, // Flexible JSON storage
  version: { type: Number, default: 1 },
  checksum: String,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound indexes for queries
agentSchema.index({ organizationId: 1, domain: 1, name: 1 });
agentSchema.index({ projectId: 1, name: 1 }, { unique: true });

export const Agent = mongoose.model('Agent', agentSchema);
```

2. **Session schema with TTL:**

```typescript
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    agentName: { type: String, required: true },
    state: mongoose.Schema.Types.Mixed, // AgentState
    context: mongoose.Schema.Types.Mixed,
    conversationHistory: [
      {
        role: String,
        content: String,
        timestamp: Date,
      },
    ],
    flowState: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
    lastActiveAt: { type: Date, default: Date.now, index: true },
  },
  {
    // Auto-expire inactive sessions after 24 hours
    expireAfterSeconds: 86400,
  },
);

sessionSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 86400 });
```

3. **Trace events with time-series optimization:**

```typescript
const traceEventSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', index: true },
    type: { type: String, required: true, index: true },
    data: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now, index: true },
    spanId: String,
    parentSpanId: String,
  },
  {
    timeseries: {
      timeField: 'timestamp',
      metaField: 'sessionId',
      granularity: 'seconds',
    },
  },
);

// Compound index for trace queries
traceEventSchema.index({ sessionId: 1, timestamp: -1 });
traceEventSchema.index({ sessionId: 1, type: 1 });
```

4. **ClickHouse for analytics (high-performance OLAP):**

```typescript
// packages/platform/src/db/clickhouse.ts

import { createClient } from '@clickhouse/client';

const client = createClient({
  host: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD,
  database: 'agent_dsl',
});

// Usage tracking table (optimized for time-series queries)
await client.exec({
  query: `
    CREATE TABLE IF NOT EXISTS usage_records (
      id UUID DEFAULT generateUUIDv4(),
      organization_id String,
      project_id String,
      user_id String,
      type LowCardinality(String),  -- 'llm_tokens', 'messages', 'tool_calls'
      quantity UInt64,
      cost_cents UInt32,
      metadata String,  -- JSON
      recorded_at DateTime64(3) DEFAULT now()
    )
    ENGINE = MergeTree()
    PARTITION BY toYYYYMM(recorded_at)
    ORDER BY (organization_id, recorded_at)
    TTL recorded_at + INTERVAL 2 YEAR
  `,
});

// Trace events for analytics (aggregate queries)
await client.exec({
  query: `
    CREATE TABLE IF NOT EXISTS trace_analytics (
      session_id String,
      organization_id String,
      agent_name LowCardinality(String),
      event_type LowCardinality(String),
      duration_ms UInt32,
      token_count UInt32,
      timestamp DateTime64(3)
    )
    ENGINE = MergeTree()
    PARTITION BY toYYYYMM(timestamp)
    ORDER BY (organization_id, timestamp)
  `,
});

// Example aggregation query
export async function getUsageByOrg(orgId: string, startDate: Date, endDate: Date) {
  const result = await client.query({
    query: `
      SELECT
        type,
        sum(quantity) as total_quantity,
        sum(cost_cents) as total_cost_cents,
        count() as event_count
      FROM usage_records
      WHERE organization_id = {orgId:String}
        AND recorded_at BETWEEN {startDate:DateTime} AND {endDate:DateTime}
      GROUP BY type
    `,
    query_params: { orgId, startDate, endDate },
    format: 'JSONEachRow',
  });
  return result.json();
}
```

**Effort:** 3 weeks (including data migration and dual-write period)

#### Gap 4.2.2: Redis for Sessions & Caching

**Current State:**

- Sessions in memory (`Map<string, RuntimeSession>`)
- Lost on server restart
- Not shared across instances

**Required Implementation:**

```typescript
// packages/platform/src/services/session-store.ts

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const SESSION_TTL = 24 * 60 * 60; // 24 hours

interface SessionStore {
  get(sessionId: string): Promise<RuntimeSession | null>;
  set(sessionId: string, session: RuntimeSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string): Promise<void>;
  listByUser(userId: string): Promise<string[]>;
}

class RedisSessionStore implements SessionStore {
  async get(sessionId: string): Promise<RuntimeSession | null> {
    const data = await redis.get(`session:${sessionId}`);
    if (!data) return null;
    return JSON.parse(data, reviver); // Handle Date objects
  }

  async set(sessionId: string, session: RuntimeSession): Promise<void> {
    await redis.setex(`session:${sessionId}`, SESSION_TTL, JSON.stringify(session));
    // Index by user for listing
    await redis.sadd(`user:${session.userId}:sessions`, sessionId);
  }

  async touch(sessionId: string): Promise<void> {
    await redis.expire(`session:${sessionId}`, SESSION_TTL);
  }
}

// IR Caching
class AgentCache {
  private prefix = 'agent:ir:';

  async get(agentPath: string, sourceHash: string): Promise<AgentIR | null> {
    const key = `${this.prefix}${agentPath}:${sourceHash}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  async set(agentPath: string, sourceHash: string, ir: AgentIR): Promise<void> {
    const key = `${this.prefix}${agentPath}:${sourceHash}`;
    await redis.setex(key, 3600, JSON.stringify(ir)); // 1 hour TTL
  }
}
```

**Effort:** 2 weeks

#### Gap 4.2.3: Horizontal Scaling

**Current State:**

- Single Node.js process
- WebSocket state in memory
- No load balancing

**Required Architecture:**

```
                    ┌─────────────────┐
                    │  Load Balancer  │
                    │ (sticky sessions)│
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
    │  Platform   │   │  Platform   │   │  Platform   │
    │  Instance 1 │   │  Instance 2 │   │  Instance 3 │
    └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
           │                 │                 │
           └────────────┬────┴────────────────┘
                        │
              ┌─────────▼─────────┐
              │   Redis Cluster   │
              │  (sessions, pub/sub)│
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │     MongoDB       │
              │   (replica set)   │
              └─────────┬─────────┘
                        │
              ┌─────────▼─────────┐
              │      Kafka        │
              │  (event streaming)│
              └───────────────────┘
```

**WebSocket Scaling with Redis Pub/Sub:**

```typescript
// Cross-instance message broadcasting
import { createAdapter } from '@socket.io/redis-adapter';

const pubClient = new Redis(process.env.REDIS_URL);
const subClient = pubClient.duplicate();

io.adapter(createAdapter(pubClient, subClient));

// Now messages broadcast to all instances
io.to(sessionId).emit('trace_event', event);
```

**Effort:** 3-4 weeks

#### Gap 4.2.4: Redis + BullMQ for Async Processing

**Current State:**

- Synchronous request/response only
- No background job processing
- No scheduled tasks

**Why BullMQ over Kafka:**

- Already using Redis for sessions, cache, circuit breakers
- Simpler operations (no Zookeeper, no broker management)
- Lower latency for job processing
- Built-in retry, backoff, rate limiting
- Sufficient throughput for agent platform scale
- Horizontal scaling via Redis Cluster

**Required Implementation:**

```typescript
// packages/platform/src/jobs/queue.ts

import { Queue, Worker, QueueScheduler } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

// Queue definitions
export const QUEUES = {
  TOOL_EXECUTION: 'tool-execution',
  WEBHOOK_DISPATCH: 'webhook-dispatch',
  RETENTION_CLEANUP: 'retention-cleanup',
  ANALYTICS_SYNC: 'analytics-sync',
  TRACE_ARCHIVAL: 'trace-archival',
} as const;

// Create queues
export const toolQueue = new Queue(QUEUES.TOOL_EXECUTION, { connection });
export const webhookQueue = new Queue(QUEUES.WEBHOOK_DISPATCH, { connection });
export const retentionQueue = new Queue(QUEUES.RETENTION_CLEANUP, { connection });

// Enqueue async tool execution
export async function enqueueToolCall(
  sessionId: string,
  toolName: string,
  params: Record<string, unknown>,
  options?: { priority?: number; delay?: number },
): Promise<string> {
  const job = await toolQueue.add(
    'execute',
    { sessionId, toolName, params },
    {
      priority: options?.priority ?? 0,
      delay: options?.delay ?? 0,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  );
  return job.id!;
}

// Enqueue webhook delivery
export async function enqueueWebhook(
  url: string,
  payload: unknown,
  options?: { maxRetries?: number },
): Promise<string> {
  const job = await webhookQueue.add(
    'deliver',
    { url, payload },
    {
      attempts: options?.maxRetries ?? 5,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
  return job.id!;
}

// Schedule recurring jobs
export async function scheduleRetentionJob(): Promise<void> {
  await retentionQueue.add(
    'daily-cleanup',
    {},
    {
      repeat: { pattern: '0 3 * * *' }, // 3 AM daily
      jobId: 'retention-daily',
    },
  );
}
```

**Worker Implementation:**

```typescript
// packages/platform/src/jobs/workers/tool-worker.ts

import { Worker, Job } from 'bullmq';
import { toolQueue } from '../queue.js';
import { ServiceNodeExecutor } from '../../services/adapters/service-node-executor.js';

const toolWorker = new Worker(
  QUEUES.TOOL_EXECUTION,
  async (job: Job) => {
    const { sessionId, toolName, params } = job.data;

    const executor = new ServiceNodeExecutor();
    const result = await executor.execute(toolName, params, 30000);

    // Emit result back to session via Redis pub/sub
    await redis.publish(
      `session:${sessionId}:tool-result`,
      JSON.stringify({
        jobId: job.id,
        toolName,
        result,
      }),
    );

    return result;
  },
  {
    connection,
    concurrency: 10,
    limiter: { max: 100, duration: 60000 }, // 100 jobs/minute
  },
);

toolWorker.on('failed', (job, err) => {
  console.error(`Tool job ${job?.id} failed:`, err.message);
});
```

**Use Cases:**

| Queue               | Purpose             | Concurrency | Notes                   |
| ------------------- | ------------------- | ----------- | ----------------------- |
| `tool-execution`    | Async tool calls    | 10          | Rate limited per tenant |
| `webhook-dispatch`  | Outbound webhooks   | 20          | Exponential backoff     |
| `retention-cleanup` | Data retention jobs | 1           | Scheduled daily         |
| `analytics-sync`    | ClickHouse sync     | 5           | Batch processing        |
| `trace-archival`    | S3 trace archival   | 2           | Large payloads          |

**Scaling:**

- Redis Cluster for horizontal scaling
- Multiple worker processes per queue
- Priority queues for tenant tiers
- Dead letter handling via `removeOnFail: false`

**Effort:** 1-2 weeks

---

### 4.3 Tool Integration

#### Gap 4.3.1: Real Tool Execution Framework ✅ IMPLEMENTED

**Current State (Updated 2026-02-07):**

- ✅ `ServiceNodeExecutor` implemented with HTTP service calls
- ✅ Auth injection (API key, Bearer, OAuth2, custom headers)
- ✅ Retry with exponential backoff
- ✅ **@agent-platform/circuit-breaker** — dedicated package with:
  - Redis-backed distributed circuit breaker
  - Lua scripts for atomic state transitions
  - Three levels: tenant, service, global
  - State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
  - Metrics: failure count, success count, failure rate
  - Manual force reset for ops
  - Event listeners for monitoring
- ✅ Rate limiting per tenant/service
- 🔲 Real external API integrations pending (framework ready)

**Previous State:**

- All tools returned mock responses
- Hardcoded in `runtime-executor.ts`
- No external API calls

**Required Implementation:**

```typescript
// packages/platform/src/tools/framework.ts

interface ToolExecutionContext {
  sessionId: string;
  userId: string;
  organizationId: string;
  agentName: string;
  timeout: number;
  retryConfig: RetryConfig;
}

interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ToolError;
  latencyMs: number;
  retryCount: number;
  cached: boolean;
}

interface ToolProvider {
  name: string;
  version: string;

  // Tool definition
  schema: z.ZodSchema;

  // Execution
  execute(params: unknown, ctx: ToolExecutionContext): Promise<ToolResult>;

  // Health check
  healthCheck(): Promise<boolean>;
}

// Tool Registry
class ToolRegistry {
  private tools = new Map<string, ToolProvider>();
  private circuitBreakers = new Map<string, CircuitBreaker>();

  register(tool: ToolProvider): void {
    this.tools.set(tool.name, tool);
    this.circuitBreakers.set(
      tool.name,
      new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 30000,
      }),
    );
  }

  async execute(toolName: string, params: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: { code: 'TOOL_NOT_FOUND' } };
    }

    const breaker = this.circuitBreakers.get(toolName)!;

    if (breaker.isOpen()) {
      return { success: false, error: { code: 'CIRCUIT_OPEN' } };
    }

    const startTime = Date.now();

    try {
      const result = await retry(() => tool.execute(params, ctx), ctx.retryConfig);

      breaker.recordSuccess();

      return {
        ...result,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      breaker.recordFailure();
      throw error;
    }
  }
}
```

**Example Tool Implementation:**

```typescript
// packages/platform/src/tools/providers/hotel-search.ts

export const hotelSearchTool: ToolProvider = {
  name: 'search_hotels',
  version: '1.0.0',

  schema: z.object({
    destination: z.string(),
    checkin: z.string().date(),
    checkout: z.string().date(),
    guests: z.number().int().positive(),
  }),

  async execute(params, ctx) {
    const validated = this.schema.parse(params);

    // Call real API
    const response = await fetch('https://api.booking.com/v1/hotels/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BOOKING_API_KEY}`,
        'X-Request-ID': ctx.sessionId,
      },
      body: JSON.stringify(validated),
      signal: AbortSignal.timeout(ctx.timeout),
    });

    if (!response.ok) {
      return {
        success: false,
        error: {
          code: 'API_ERROR',
          message: `Booking API returned ${response.status}`,
          retryable: response.status >= 500,
        },
      };
    }

    const data = await response.json();

    return {
      success: true,
      data: data.hotels,
    };
  },

  async healthCheck() {
    const response = await fetch('https://api.booking.com/v1/health');
    return response.ok;
  },
};
```

**Effort:** 4-6 weeks (framework + initial tools)

---

### 4.4 Memory & Persistence

#### Gap 4.4.1: Persistent Memory with Vector Database

**Current State:**

- MEMORY construct parsed
- REMEMBER/RECALL in IR schema
- Not executed at runtime

**Required Implementation:**

```typescript
// packages/platform/src/memory/vector-store.ts

interface MemoryEntry {
  id: string;
  sessionId: string;
  agentName: string;
  content: string;
  embedding: number[];
  metadata: {
    type: 'fact' | 'preference' | 'context';
    importance: number;
    createdAt: Date;
    expiresAt?: Date;
  };
}

interface VectorStore {
  // Store
  remember(entry: Omit<MemoryEntry, 'id' | 'embedding'>): Promise<string>;

  // Retrieve
  recall(query: string, options: RecallOptions): Promise<MemoryEntry[]>;

  // Manage
  forget(filter: MemoryFilter): Promise<number>;
}

interface RecallOptions {
  limit: number;
  minSimilarity: number;
  filter?: {
    sessionId?: string;
    agentName?: string;
    type?: string;
    after?: Date;
  };
}

// Pinecone implementation
class PineconeMemoryStore implements VectorStore {
  private index: PineconeIndex;
  private embedder: EmbeddingModel;

  async remember(entry): Promise<string> {
    const embedding = await this.embedder.embed(entry.content);
    const id = generateId();

    await this.index.upsert([
      {
        id,
        values: embedding,
        metadata: {
          sessionId: entry.sessionId,
          agentName: entry.agentName,
          content: entry.content,
          ...entry.metadata,
        },
      },
    ]);

    return id;
  }

  async recall(query: string, options: RecallOptions): Promise<MemoryEntry[]> {
    const queryEmbedding = await this.embedder.embed(query);

    const results = await this.index.query({
      vector: queryEmbedding,
      topK: options.limit,
      includeMetadata: true,
      filter: this.buildFilter(options.filter),
    });

    return results.matches
      .filter((m) => m.score >= options.minSimilarity)
      .map((m) => ({
        id: m.id,
        content: m.metadata.content,
        embedding: m.values,
        ...m.metadata,
      }));
  }
}
```

**Runtime Integration:**

```typescript
// In runtime-executor.ts

async executeRemember(instruction: RememberInstruction, state: AgentState) {
  const content = this.evaluateTemplate(instruction.template, state);

  await this.memoryStore.remember({
    sessionId: state.sessionId,
    agentName: state.agentName,
    content,
    metadata: {
      type: instruction.type || 'fact',
      importance: instruction.importance || 0.5,
      createdAt: new Date(),
      expiresAt: instruction.ttl
        ? new Date(Date.now() + instruction.ttl)
        : undefined,
    },
  });

  this.emitTrace('memory_remember', { content, type: instruction.type });
}

async executeRecall(instruction: RecallInstruction, state: AgentState) {
  const memories = await this.memoryStore.recall(instruction.query, {
    limit: instruction.limit || 5,
    minSimilarity: instruction.minSimilarity || 0.7,
    filter: {
      sessionId: instruction.scope === 'session' ? state.sessionId : undefined,
      agentName: instruction.scope === 'agent' ? state.agentName : undefined,
    },
  });

  // Inject into context
  state.context[instruction.as || 'memories'] = memories.map(m => m.content);

  this.emitTrace('memory_recall', {
    query: instruction.query,
    count: memories.length
  });
}
```

**Effort:** 3-4 weeks

---

### 4.5 Observability & Monitoring

#### Gap 4.5.1: Metrics & Alerting

**Current State:**

- Console logging only
- No metrics collection
- No alerting

**Required Implementation:**

```typescript
// packages/platform/src/observability/metrics.ts

import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const registry = new Registry();

// Request metrics
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

// Agent metrics
export const agentExecutionDuration = new Histogram({
  name: 'agent_execution_duration_seconds',
  help: 'Agent execution duration',
  labelNames: ['agent_name', 'mode', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const llmTokensUsed = new Counter({
  name: 'llm_tokens_total',
  help: 'LLM tokens used',
  labelNames: ['agent_name', 'model', 'type'], // input/output
  registers: [registry],
});

export const llmCostDollars = new Counter({
  name: 'llm_cost_dollars_total',
  help: 'LLM cost in dollars',
  labelNames: ['agent_name', 'model', 'organization_id'],
  registers: [registry],
});

export const activeSessions = new Gauge({
  name: 'active_sessions',
  help: 'Number of active sessions',
  labelNames: ['organization_id'],
  registers: [registry],
});

// Tool metrics
export const toolExecutionDuration = new Histogram({
  name: 'tool_execution_duration_seconds',
  help: 'Tool execution duration',
  labelNames: ['tool_name', 'status'],
  buckets: [0.05, 0.1, 0.5, 1, 5, 10],
  registers: [registry],
});

export const toolCircuitBreakerState = new Gauge({
  name: 'tool_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['tool_name'],
  registers: [registry],
});

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
```

**Grafana Dashboard JSON:**

```json
{
  "title": "Agent Blueprint Language (ABL) Platform",
  "panels": [
    {
      "title": "Request Rate",
      "type": "graph",
      "targets": [{ "expr": "rate(http_requests_total[5m])" }]
    },
    {
      "title": "P99 Latency",
      "type": "graph",
      "targets": [
        { "expr": "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))" }
      ]
    },
    {
      "title": "LLM Cost by Organization",
      "type": "graph",
      "targets": [{ "expr": "sum(rate(llm_cost_dollars_total[1h])) by (organization_id) * 3600" }]
    },
    {
      "title": "Active Sessions",
      "type": "stat",
      "targets": [{ "expr": "sum(active_sessions)" }]
    }
  ]
}
```

**Effort:** 2 weeks

#### Gap 4.5.2: Distributed Tracing

**Current State:**

- Session-local traces only
- No correlation across services
- No external trace export

**Required Implementation:**

```typescript
// packages/platform/src/observability/tracing.ts

import { trace, SpanKind, context } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const provider = new NodeTracerProvider();
provider.addSpanProcessor(
  new BatchSpanProcessor(new OTLPTraceExporter({ url: process.env.OTEL_ENDPOINT })),
);
provider.register();

const tracer = trace.getTracer('agent-dsl-platform');

// Wrap agent execution
async function executeAgentWithTracing(session: RuntimeSession, message: string) {
  return tracer.startActiveSpan('agent.execute', { kind: SpanKind.SERVER }, async (span) => {
    span.setAttributes({
      'agent.name': session.agentName,
      'agent.mode': session.mode,
      'session.id': session.id,
      'organization.id': session.organizationId,
    });

    try {
      const result = await this.executeMessage(session, message);

      span.setAttributes({
        'response.tokens': result.tokenCount,
        'response.tools_called': result.toolsCalled.length,
      });

      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Propagate trace context to tools
async function executeToolWithTracing(toolName: string, params: unknown) {
  return tracer.startActiveSpan(`tool.${toolName}`, { kind: SpanKind.CLIENT }, async (span) => {
    // Include trace headers in external requests
    const headers = {};
    propagation.inject(context.active(), headers);

    // ... execute tool with headers
  });
}
```

**Effort:** 2 weeks

---

### 4.6 Guardrails & Safety

#### Gap 4.6.1: Output Guardrails

**Current State:**

- GUARDRAILS parsed
- IR schema defined
- **Not executed at runtime**

**Required Implementation:**

```typescript
// packages/platform/src/guardrails/engine.ts

interface GuardrailResult {
  passed: boolean;
  action: 'allow' | 'block' | 'redact' | 'warn' | 'regenerate';
  violations: Violation[];
  modifiedContent?: string;
}

interface Violation {
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  span?: { start: number; end: number };
}

class GuardrailEngine {
  private rules: GuardrailRule[] = [];
  private providers: Map<string, GuardrailProvider> = new Map();

  async checkOutput(content: string, context: GuardrailContext): Promise<GuardrailResult> {
    const violations: Violation[] = [];
    let modifiedContent = content;

    // 1. Fast regex rules
    for (const rule of this.rules.filter((r) => r.type === 'regex')) {
      const match = rule.pattern.exec(content);
      if (match) {
        violations.push({
          rule: rule.name,
          severity: rule.severity,
          description: rule.message,
          span: { start: match.index, end: match.index + match[0].length },
        });

        if (rule.action === 'redact') {
          modifiedContent = modifiedContent.replace(rule.pattern, '[REDACTED]');
        }
      }
    }

    // 2. ML classifier rules
    for (const rule of this.rules.filter((r) => r.type === 'classifier')) {
      const provider = this.providers.get(rule.provider);
      const result = await provider.classify(content, rule.categories);

      if (result.flagged) {
        violations.push({
          rule: rule.name,
          severity: rule.severity,
          description: `Content flagged: ${result.categories.join(', ')}`,
        });
      }
    }

    // 3. LLM-based rules (expensive, run last)
    if (context.enableLLMGuardrails) {
      for (const rule of this.rules.filter((r) => r.type === 'llm')) {
        const result = await this.llmCheck(content, rule);
        if (!result.safe) {
          violations.push({
            rule: rule.name,
            severity: rule.severity,
            description: result.reason,
          });
        }
      }
    }

    // Determine action
    const maxSeverity = Math.max(...violations.map((v) => severityToNumber(v.severity)));

    return {
      passed: violations.length === 0,
      action: this.determineAction(maxSeverity, violations),
      violations,
      modifiedContent: modifiedContent !== content ? modifiedContent : undefined,
    };
  }
}

// External providers
class OpenAIModerationProvider implements GuardrailProvider {
  async classify(content: string, categories: string[]) {
    const response = await openai.moderations.create({ input: content });

    return {
      flagged: response.results[0].flagged,
      categories: Object.entries(response.results[0].categories)
        .filter(([_, flagged]) => flagged)
        .map(([category]) => category),
    };
  }
}
```

**Effort:** 3-4 weeks

---

### 4.7 NLU Engine ✅ NEW SECTION

#### Gap 4.7.1: Enterprise NLU Capabilities ✅ IMPLEMENTED

**Implemented (2026-02-07):**

The NLU engine has been fully modularized with enterprise-grade capabilities:

```
packages/compiler/src/platform/nlu/
├── pipeline.ts          # Generic NLUTaskPipeline with hooks
├── config.ts            # NLUConfig builder, env defaults
├── tasks/
│   ├── intent-detector.ts
│   ├── entity-extractor.ts
│   ├── category-classifier.ts
│   ├── correction-detector.ts
│   ├── digression-detector.ts
│   ├── sub-intent-detector.ts
│   ├── language-detector.ts
│   └── combined-analyzer.ts
└── enterprise/
    ├── tenant-manager.ts    # Per-tenant config, model overrides
    ├── nlu-cache.ts         # Semantic caching with tenant isolation
    ├── circuit-breaker.ts   # NLU-specific circuit breaker
    ├── pii-guard.ts         # PII detection/redaction hook
    ├── nlu-audit.ts         # Audit event emission
    └── version-tracker.ts   # Model/prompt version tracking
```

**Enterprise Features:**

| Feature          | Implementation                                                   | Status |
| ---------------- | ---------------------------------------------------------------- | ------ |
| Multi-tenant NLU | `NLUTenantManager` — per-tenant model selection, retry policies  | ✅     |
| Semantic Caching | `NLUResultCache` — tenant-isolated caching with TTL              | ✅     |
| Circuit Breaker  | `NLUCircuitBreaker` — protects NLU calls from cascading failures | ✅     |
| PII Protection   | `createPIIGuardHook` — pipeline hook for PII detection/redaction | ✅     |
| Audit Trail      | `createAuditHook` — emits NLU audit events for compliance        | ✅     |
| Version Tracking | `NLUVersionTracker` — tracks model/prompt versions per tenant    | ✅     |

**Usage Example:**

```typescript
import { NLUTenantManager, createPIIGuardHook, createAuditHook } from './enterprise/index.js';
import { NLUTaskPipeline } from './pipeline.js';

// Create tenant-aware pipeline
const tenantManager = new NLUTenantManager();
const pipeline = new NLUTaskPipeline()
  .addHook('before', createPIIGuardHook({ redact: true }))
  .addHook('after', createAuditHook(auditService));

// Execute with tenant context
const result = await tenantManager.withTenant(tenantId, async (config) => {
  return pipeline.execute(input, config);
});
```

---

## 5. Technical Specifications

### 5.1 Database Schema Evolution

#### MongoDB Collections (Primary)

```typescript
// MongoDB schema definitions

// organizations collection
interface Organization {
  _id: ObjectId;
  name: string;
  slug: string; // unique index
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';
  stripeCustomerId?: string;
  settings: {
    defaultLLMModel?: string;
    maxTokensPerRequest?: number;
    enabledFeatures?: string[];
  };
  createdAt: Date;
  updatedAt: Date;
}

// teams collection
interface Team {
  _id: ObjectId;
  organizationId: ObjectId; // indexed
  name: string;
  settings: Record<string, unknown>;
  createdAt: Date;
}

// users collection
interface User {
  _id: ObjectId;
  email: string; // unique index
  name?: string;
  avatarUrl?: string;
  googleId?: string; // unique sparse index
  memberships: [
    {
      organizationId: ObjectId;
      role: 'OWNER' | 'ADMIN' | 'MEMBER';
      teamIds: ObjectId[];
      joinedAt: Date;
    },
  ];
  createdAt: Date;
  lastLoginAt?: Date;
}

// projects collection
interface Project {
  _id: ObjectId;
  organizationId: ObjectId; // indexed
  teamId?: ObjectId;
  name: string;
  slug: string;
  description?: string;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
// Compound index: { organizationId: 1, slug: 1 } unique

// agents collection
interface AgentDocument {
  _id: ObjectId;
  projectId: ObjectId; // indexed
  organizationId: ObjectId; // indexed
  name: string;
  domain: string;
  dslSource: string;
  compiledIR: AgentIR; // embedded document
  version: number;
  checksum: string;
  staticGraph?: StaticGraph;
  metadata: {
    mode: 'reasoning' | 'scripted';
    toolCount: number;
    stepCount?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}
// Compound index: { projectId: 1, name: 1 } unique

// sessions collection (with TTL)
interface SessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  projectId: ObjectId;
  organizationId: ObjectId;
  agentName: string;
  state: AgentState;
  context: Record<string, unknown>;
  conversationHistory: ConversationMessage[];
  flowState?: FlowState;
  createdAt: Date;
  lastActiveAt: Date; // TTL index: expires after 24h
}

// traces collection (time-series)
interface TraceDocument {
  _id: ObjectId;
  sessionId: ObjectId;
  type: string;
  data: Record<string, unknown>;
  timestamp: Date;
  spanId?: string;
  parentSpanId?: string;
}
// Time-series collection with sessionId as metaField

// apiKeys collection
interface ApiKeyDocument {
  _id: ObjectId;
  organizationId: ObjectId;
  keyHash: string;
  keyPrefix: string; // indexed
  name: string;
  scopes: string[];
  rateLimit: number;
  expiresAt?: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdBy: ObjectId;
  createdAt: Date;
}

// auditLogs collection
interface AuditLogDocument {
  _id: ObjectId;
  timestamp: Date;
  action: string;
  actorId: ObjectId;
  actorType: 'user' | 'apikey' | 'system';
  organizationId: ObjectId;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}
// Time-series optimized, or capped collection

// subscriptions collection (billing)
interface SubscriptionDocument {
  _id: ObjectId;
  organizationId: ObjectId; // indexed
  plan: 'FREE' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  trialEnd?: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// invoices collection (billing)
interface InvoiceDocument {
  _id: ObjectId;
  organizationId: ObjectId; // indexed
  subscriptionId: ObjectId;
  stripeInvoiceId?: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  amountDue: number; // cents
  amountPaid: number;
  currency: string;
  lineItems: [
    {
      description: string;
      type: 'llm_tokens' | 'messages' | 'tool_calls' | 'storage' | 'subscription';
      quantity: number;
      unitAmount: number;
      amount: number;
    },
  ];
  periodStart: Date;
  periodEnd: Date;
  dueDate?: Date;
  paidAt?: Date;
  hostedInvoiceUrl?: string;
  invoicePdf?: string;
  createdAt: Date;
}
// Compound index: { organizationId: 1, createdAt: -1 }

// paymentMethods collection
interface PaymentMethodDocument {
  _id: ObjectId;
  organizationId: ObjectId;
  stripePaymentMethodId: string;
  type: 'card' | 'bank_account' | 'sepa_debit';
  isDefault: boolean;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
  createdAt: Date;
}

// usageRecords collection (for billing aggregation)
interface UsageRecordDocument {
  _id: ObjectId;
  organizationId: ObjectId;
  projectId: ObjectId;
  userId: ObjectId;
  type: 'llm_tokens' | 'messages' | 'tool_calls' | 'storage';
  quantity: number;
  costCents: number;
  metadata: Record<string, unknown>;
  recordedAt: Date;
}
// Compound index: { organizationId: 1, recordedAt: -1 }
// TTL index for cleanup after billing cycle
```

#### ClickHouse Tables (Analytics)

```sql
-- ClickHouse DDL for analytics

-- Usage records (high-cardinality time-series)
CREATE TABLE usage_records (
  id UUID DEFAULT generateUUIDv4(),
  organization_id String,
  project_id String,
  user_id String,
  type LowCardinality(String),
  quantity UInt64,
  cost_cents UInt32,
  metadata String,
  recorded_at DateTime64(3) DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(recorded_at)
ORDER BY (organization_id, recorded_at)
TTL recorded_at + INTERVAL 2 YEAR;

-- Trace analytics (aggregated metrics)
CREATE TABLE trace_analytics (
  session_id String,
  organization_id String,
  project_id String,
  agent_name LowCardinality(String),
  event_type LowCardinality(String),
  duration_ms UInt32,
  token_count UInt32,
  success UInt8,
  timestamp DateTime64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (organization_id, timestamp);

-- Materialized view for real-time dashboards
CREATE MATERIALIZED VIEW usage_hourly_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (organization_id, type, hour)
AS SELECT
  organization_id,
  type,
  toStartOfHour(recorded_at) as hour,
  sum(quantity) as total_quantity,
  sum(cost_cents) as total_cost_cents,
  count() as event_count
FROM usage_records
GROUP BY organization_id, type, hour;

-- Agent performance metrics
CREATE MATERIALIZED VIEW agent_performance_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (organization_id, agent_name, hour)
AS SELECT
  organization_id,
  agent_name,
  toStartOfHour(timestamp) as hour,
  avgState(duration_ms) as avg_duration,
  countState() as request_count,
  sumState(token_count) as total_tokens,
  avgState(success) as success_rate
FROM trace_analytics
GROUP BY organization_id, agent_name, hour;
```

### 5.2 API Versioning Strategy

```typescript
// Version routing
app.use('/api/v1', v1Router);
app.use('/api/v2', v2Router);

// Deprecation headers
app.use('/api/v1', (req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Sat, 01 Jan 2027 00:00:00 GMT');
  res.set('Link', '</api/v2>; rel="successor-version"');
  next();
});

// Version negotiation via header
app.use('/api', (req, res, next) => {
  const version = req.headers['api-version'] || 'v2';
  req.apiVersion = version;
  next();
});
```

### 5.3 Configuration Management

```typescript
// packages/platform/src/config/index.ts

interface PlatformConfig {
  // Server
  server: {
    port: number;
    host: string;
    corsOrigins: string[];
  };

  // Database
  database: {
    url: string;
    poolSize: number;
    ssl: boolean;
  };

  // Redis
  redis: {
    url: string;
    cluster: boolean;
    keyPrefix: string;
  };

  // Auth
  auth: {
    jwtSecret: string;
    jwtAccessExpiry: string;
    jwtRefreshExpiry: string;
    google: {
      clientId: string;
      clientSecret: string;
    };
    saml?: {
      entryPoint: string;
      cert: string;
    };
  };

  // LLM
  llm: {
    anthropic: {
      apiKey: string;
      defaultModel: string;
    };
    openai?: {
      apiKey: string;
    };
  };

  // Observability
  observability: {
    metricsEnabled: boolean;
    tracingEnabled: boolean;
    otlpEndpoint?: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };

  // Features
  features: {
    vectorMemory: boolean;
    outputGuardrails: boolean;
    multiTenancy: boolean;
  };
}

// Environment-specific loading
function loadConfig(): PlatformConfig {
  const env = process.env.NODE_ENV || 'development';

  const baseConfig = loadYaml(`config/base.yaml`);
  const envConfig = loadYaml(`config/${env}.yaml`);
  const secretsConfig = loadSecrets(); // From vault

  return deepMerge(baseConfig, envConfig, secretsConfig);
}
```

---

## 6. Implementation Roadmap

### 6.1 Phase 1: Production Minimum (6-8 weeks)

```
Week 1-2: Database & Infrastructure
├── 🔲 MongoDB + ClickHouse migration
├── 🔲 Redis setup for sessions
├── 🔲 Docker containerization
└── 🔲 Harness CI/CD pipeline

Week 3-4: Tool Integration Framework ✅ COMPLETE
├── ✅ Tool provider interface (ServiceNodeExecutor)
├── ✅ Circuit breaker implementation (RedisCircuitBreaker with Lua scripts)
├── ✅ Distributed breaker registry (tenant, service, global levels)
├── 🔲 3 real tool implementations (framework ready)
└── 🔲 Tool health monitoring

Week 5-6: Reliability ✅ MOSTLY COMPLETE
├── ✅ ON_ERROR retry logic (exponential backoff)
├── ✅ Circuit breaker state machine (CLOSED/OPEN/HALF_OPEN)
├── ✅ Per-tenant rate limiting (sliding window)
├── 🔲 Health check endpoints
└── 🔲 Structured logging

Week 7-8: Security Hardening ✅ MOSTLY COMPLETE
├── ✅ API key authentication (SHA-256 hash, prefix lookup)
├── ✅ Tenant middleware (RBAC permissions)
├── ✅ Resource guard (cross-tenant prevention)
├── ✅ Rate limiting per tenant/operation
├── ✅ PII detection & redaction
├── 🔲 Input validation (Zod schemas)
└── 🔲 Security headers (helmet.js)
```

**Deliverables:**

- Deployable Docker image
- MongoDB + Redis + ClickHouse infrastructure
- 3 working tool integrations
- Harness CI/CD pipelines
- API key management

**Completed (2026-02-07):**

- ✅ EncryptionService with AES-256-GCM
- ✅ ModelRouter with tier-based selection
- ✅ PrismaConversationStore & PrismaAgentRegistry
- ✅ UnifiedLLMProvider with LiteLLM protocol
- ✅ EnterpriseAuthProvider (Azure AD, OAuth2, AWS SigV4)
- ✅ ServiceNodeExecutor with resilience patterns
- ✅ SSE streaming endpoint design

**Completed (2026-02-07 continued):**

- ✅ **@agent-platform/circuit-breaker** — Redis-backed distributed circuit breaker with Lua scripts
  - Three-level breakers: tenant, service, global
  - State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
  - Atomic state transitions via Redis Lua scripts
  - Metrics: failure count, success count, failure rate
  - Manual force reset for ops team
  - Event listeners for monitoring
- ✅ **Tenant Middleware** (`apps/platform/src/middleware/tenant.ts`)
  - JWT-based tenant extraction
  - API key authentication (`abl_*` prefix, SHA-256 hash)
  - RBAC permission mapping (OWNER, ADMIN, MEMBER, VIEWER)
  - X-Organization-Id header support
- ✅ **Resource Guard** (`apps/platform/src/middleware/resource-guard.ts`)
  - Cross-tenant access prevention
  - Resource types: project, session, agent, credential, modelConfig, serviceNode
  - Direct ownership fallback for non-org users
- ✅ **Per-Tenant Rate Limiter** (`apps/platform/src/middleware/rate-limiter.ts`)
  - Sliding window algorithm
  - Operations: request, llm_tokens, session, tool_call
  - X-RateLimit-\* headers
  - Designed for Redis in production
- ✅ **PII Detection & Redaction** (`packages/compiler/src/platform/security/pii-detector.ts`)
  - Regex-based detection: email, phone, SSN, credit card, IP address
  - Luhn validation for credit cards
  - Redaction with type-specific labels
- ✅ **NLU Enterprise Layer** (`packages/compiler/src/platform/nlu/enterprise/`)
  - NLUTenantManager: per-tenant configuration, model overrides, retry policies
  - NLUResultCache: semantic caching with tenant isolation
  - NLUCircuitBreaker: NLU-specific circuit breaker
  - createPIIGuardHook: PII detection/redaction pipeline hook
  - createAuditHook: NLU audit event emission
  - NLUVersionTracker: model/prompt version tracking

### 6.2 Phase 2: Enterprise Core (8-10 weeks)

```
Week 1-3: Multi-Tenancy
├── Organization/Team models
├── RBAC implementation
├── Tenant isolation
└── Admin dashboard

Week 4-5: SSO Integration
├── SAML 2.0 support
├── OIDC support
├── Azure AD testing
└── Session management

Week 6-7: Observability
├── Prometheus metrics
├── OpenTelemetry tracing
├── Grafana dashboards
├── Alerting rules

Week 8-10: Guardrails
├── Output guardrail engine
├── OpenAI Moderation integration
├── Custom rule DSL
└── Guardrail monitoring
```

**Deliverables:**

- Multi-tenant architecture
- SSO for major providers
- Full observability stack
- Production guardrails

### 6.3 Phase 3: Advanced Features (10-12 weeks)

```
Week 1-4: Vector Memory
├── Pinecone/Weaviate integration
├── REMEMBER execution
├── RECALL execution
├── Memory management UI

Week 5-7: Developer Experience
├── OpenAPI specification
├── TypeScript SDK
├── Python SDK
├── Webhook system

Week 8-10: Platform Features
├── Agent versioning
├── A/B testing framework
├── Usage analytics
├── Billing integration

Week 11-12: Advanced
├── Agent marketplace
├── Collaboration features
├── Custom LLM providers
└── On-premise deployment guide
```

---

## 7. Architecture Evolution

### 7.1 Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TARGET ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Studio    │  │   Mobile    │  │    SDK      │  │  Webhooks   │        │
│  │  (React)    │  │    App      │  │ (TS/Python) │  │  (Inbound)  │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                │                │                │
│         └────────────────┴────────────────┴────────────────┘                │
│                                   │                                         │
│                          ┌────────▼────────┐                                │
│                          │  Load Balancer  │                                │
│                          │  (nginx/ALB)    │                                │
│                          └────────┬────────┘                                │
│                                   │                                         │
│         ┌─────────────────────────┼─────────────────────────┐               │
│         │                         │                         │               │
│  ┌──────▼──────┐          ┌───────▼───────┐         ┌──────▼──────┐        │
│  │  Platform   │          │   Platform    │         │  Platform   │        │
│  │  API (1)    │          │   API (2)     │         │  API (N)    │        │
│  └──────┬──────┘          └───────┬───────┘         └──────┬──────┘        │
│         │                         │                         │               │
│         └─────────────────────────┼─────────────────────────┘               │
│                                   │                                         │
│                    ┌──────────────┼──────────────┐                          │
│                    │              │              │                          │
│             ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐                    │
│             │   Redis     │ │  MongoDB  │ │  Vector   │                    │
│             │  Cluster    │ │ (replica) │ │    DB     │                    │
│             └─────────────┘ └───────────┘ └───────────┘                    │
│                                   │                                         │
│                    ┌──────────────┼──────────────┐                          │
│                    │              │              │                          │
│             ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐                    │
│             │   BullMQ    │ │ClickHouse │ │  S3/GCS/  │                    │
│             │  (jobs)     │ │(analytics)│ │Azure Blob │                    │
│             └─────────────┘ └───────────┘ └───────────┘                    │
│                                                                              │
│         ┌─────────────────────────────────────────────────┐                 │
│         │               EXTERNAL SERVICES                  │                 │
│         ├─────────────┬─────────────┬─────────────────────┤                 │
│         │  Anthropic  │   OpenAI    │   Tool APIs         │                 │
│         │    API      │ Moderation  │  (Booking, etc)     │                 │
│         └─────────────┴─────────────┴─────────────────────┘                 │
│                                                                              │
│         ┌─────────────────────────────────────────────────┐                 │
│         │              OBSERVABILITY                       │                 │
│         ├─────────────┬─────────────┬─────────────────────┤                 │
│         │ Prometheus  │   Jaeger    │    Grafana          │                 │
│         │  (metrics)  │  (tracing)  │   (dashboards)      │                 │
│         └─────────────┴─────────────┴─────────────────────┘                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Infrastructure Stack

#### Multi-Cloud Support

ABL Platform supports deployment across major cloud providers and on-premises:

| Environment     | Kubernetes    | Object Storage | Managed Services                       |
| --------------- | ------------- | -------------- | -------------------------------------- |
| **AWS**         | EKS           | S3             | ElastiCache (Redis), DocumentDB, RDS   |
| **Azure**       | AKS           | Azure Blob     | Azure Cache for Redis, Cosmos DB       |
| **GCP**         | GKE           | GCS            | Memorystore (Redis), Firestore         |
| **On-Premises** | K8s/OpenShift | MinIO          | Self-hosted Redis, MongoDB, ClickHouse |

#### CI/CD with Harness

```yaml
# .harness/pipeline.yaml

pipeline:
  name: ABL Platform Deploy
  identifier: abl_platform_deploy
  projectIdentifier: abl_platform
  orgIdentifier: default

  stages:
    - stage:
        name: Build
        identifier: build
        type: CI
        spec:
          cloneCodebase: true
          execution:
            steps:
              - step:
                  type: Run
                  name: Install Dependencies
                  identifier: install
                  spec:
                    shell: Bash
                    command: pnpm install --frozen-lockfile

              - step:
                  type: Run
                  name: Run Tests
                  identifier: test
                  spec:
                    shell: Bash
                    command: pnpm test

              - step:
                  type: BuildAndPushDockerRegistry
                  name: Build Platform Image
                  identifier: build_platform
                  spec:
                    connectorRef: docker_registry
                    repo: abl/platform
                    tags:
                      - <+pipeline.sequenceId>
                      - latest
                    dockerfile: apps/platform/Dockerfile

              - step:
                  type: BuildAndPushDockerRegistry
                  name: Build Studio Image
                  identifier: build_studio
                  spec:
                    connectorRef: docker_registry
                    repo: abl/studio
                    tags:
                      - <+pipeline.sequenceId>
                      - latest
                    dockerfile: apps/studio/Dockerfile

    - stage:
        name: Deploy Staging
        identifier: deploy_staging
        type: Deployment
        spec:
          deploymentType: Kubernetes
          service:
            serviceRef: abl_platform
          environment:
            environmentRef: staging
            infrastructureDefinitions:
              - identifier: k8s_staging
          execution:
            steps:
              - step:
                  type: K8sRollingDeploy
                  name: Rolling Deploy
                  identifier: rolling_deploy
                  spec:
                    skipDryRun: false
            rollbackSteps:
              - step:
                  type: K8sRollingRollback
                  name: Rollback
                  identifier: rollback

    - stage:
        name: Deploy Production
        identifier: deploy_production
        type: Deployment
        when:
          condition: <+pipeline.stages.deploy_staging.status> == "SUCCESS"
        spec:
          deploymentType: Kubernetes
          service:
            serviceRef: abl_platform
          environment:
            environmentRef: production
          execution:
            steps:
              - step:
                  type: HarnessApproval
                  name: Approval Gate
                  identifier: approval
                  spec:
                    approvalMessage: Approve production deployment?
                    approvers:
                      userGroups:
                        - platform_leads

              - step:
                  type: K8sCanaryDeploy
                  name: Canary 10%
                  identifier: canary_10
                  spec:
                    instanceSelection:
                      type: Percentage
                      percentage: 10

              - step:
                  type: Verify
                  name: Verify Canary
                  identifier: verify_canary
                  spec:
                    type: Canary
                    monitoredService:
                      type: Default
                    spec:
                      sensitivity: MEDIUM
                      duration: 15m

              - step:
                  type: K8sCanaryDeploy
                  name: Canary 100%
                  identifier: canary_100
                  spec:
                    instanceSelection:
                      type: Percentage
                      percentage: 100
```

#### Apache APISIX API Gateway

```yaml
# k8s/apisix/apisix-config.yaml

apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: abl-platform-routes
  namespace: abl-platform
spec:
  http:
    - name: api-routes
      match:
        hosts:
          - api.abl.example.com
        paths:
          - /api/*
      backends:
        - serviceName: platform-api
          servicePort: 3001
      plugins:
        - name: cors
          enable: true
          config:
            allow_origins: 'https://studio.abl.example.com'
            allow_methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS'
            allow_headers: 'Authorization,Content-Type,X-Request-ID'
            allow_credential: true

        - name: limit-req
          enable: true
          config:
            rate: 100
            burst: 200
            key: consumer_name
            rejected_code: 429

        - name: jwt-auth
          enable: true
          config:
            header: Authorization
            query: token

        - name: prometheus
          enable: true
          config:
            prefer_name: true

    - name: websocket-routes
      match:
        hosts:
          - api.abl.example.com
        paths:
          - /ws/*
      backends:
        - serviceName: platform-api
          servicePort: 3001
      websocket: true
      plugins:
        - name: limit-conn
          enable: true
          config:
            conn: 1000
            burst: 500
            key: remote_addr

---
apiVersion: apisix.apache.org/v2
kind: ApisixUpstream
metadata:
  name: platform-api-upstream
  namespace: abl-platform
spec:
  loadbalancer:
    type: roundrobin
  healthCheck:
    active:
      type: http
      httpPath: /health
      healthy:
        interval: 5s
        successes: 2
      unhealthy:
        interval: 2s
        httpFailures: 3
  retries: 3

---
# Rate limiting per organization
apiVersion: apisix.apache.org/v2
kind: ApisixConsumer
metadata:
  name: org-rate-limits
  namespace: abl-platform
spec:
  authParameter:
    jwtAuth:
      value:
        key: abl-jwt-secret
  plugins:
    - name: limit-count
      enable: true
      config:
        count: 10000
        time_window: 3600
        key_type: var
        key: jwt_org_id
        policy: redis
        redis_host: redis-cluster
        redis_port: 6379
```

#### Istio Service Mesh

```yaml
# k8s/istio/platform-mesh.yaml

apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: platform-api
  namespace: abl-platform
spec:
  hosts:
    - platform-api
  http:
    - match:
        - headers:
            x-canary:
              exact: 'true'
      route:
        - destination:
            host: platform-api
            subset: canary
          weight: 100
    - route:
        - destination:
            host: platform-api
            subset: stable
          weight: 100
      retries:
        attempts: 3
        perTryTimeout: 10s
        retryOn: 5xx,reset,connect-failure
      timeout: 30s

---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: platform-api
  namespace: abl-platform
spec:
  host: platform-api
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    loadBalancer:
      simple: LEAST_CONN
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
    - name: stable
      labels:
        version: stable
    - name: canary
      labels:
        version: canary

---
# mTLS for service-to-service communication
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: abl-platform
spec:
  mtls:
    mode: STRICT

---
# Authorization policy
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: platform-api-authz
  namespace: abl-platform
spec:
  selector:
    matchLabels:
      app: platform-api
  rules:
    - from:
        - source:
            principals:
              - cluster.local/ns/abl-platform/sa/apisix-gateway
              - cluster.local/ns/abl-platform/sa/studio
    - to:
        - operation:
            paths: ['/health', '/metrics']
```

#### Kubernetes Deployment

```yaml
# k8s/platform-deployment.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: platform-api
  namespace: abl-platform
  labels:
    app: platform-api
    version: stable
spec:
  replicas: 3
  selector:
    matchLabels:
      app: platform-api
  template:
    metadata:
      labels:
        app: platform-api
        version: stable
      annotations:
        sidecar.istio.io/inject: 'true'
        prometheus.io/scrape: 'true'
        prometheus.io/port: '3001'
        prometheus.io/path: '/metrics'
    spec:
      serviceAccountName: platform-api
      containers:
        - name: platform
          image: abl/platform:latest
          ports:
            - containerPort: 3001
              name: http
          env:
            - name: MONGODB_URL
              valueFrom:
                secretKeyRef:
                  name: platform-secrets
                  key: mongodb-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: platform-secrets
                  key: redis-url
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: platform-config
                  key: kafka-brokers
            - name: CLICKHOUSE_URL
              valueFrom:
                secretKeyRef:
                  name: platform-secrets
                  key: clickhouse-url
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'
            limits:
              memory: '2Gi'
              cpu: '2000m'
          readinessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 3001
            initialDelaySeconds: 15
            periodSeconds: 20
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: platform-api-hpa
  namespace: abl-platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: platform-api
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 4
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60

---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: platform-api-pdb
  namespace: abl-platform
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: platform-api
```

---

## 8. Risk Assessment

### 8.1 Technical Risks

| Risk                         | Probability | Impact   | Mitigation                               |
| ---------------------------- | ----------- | -------- | ---------------------------------------- |
| Database migration data loss | Low         | Critical | Backup before migration, staged rollout  |
| Redis cluster failure        | Medium      | High     | Redis Sentinel, fallback to DB           |
| LLM provider outage          | Medium      | High     | Multi-provider support, cached responses |
| Tool API rate limits         | High        | Medium   | Request queuing, backoff strategies      |
| Security breach              | Low         | Critical | Regular audits, penetration testing      |

### 8.2 Operational Risks

| Risk                     | Probability | Impact   | Mitigation                           |
| ------------------------ | ----------- | -------- | ------------------------------------ |
| Cost overrun (LLM usage) | High        | Medium   | Usage quotas, cost alerts            |
| Performance degradation  | Medium      | High     | Load testing, auto-scaling           |
| Compliance violation     | Low         | Critical | Regular audits, documented processes |
| Team knowledge gap       | Medium      | Medium   | Documentation, training              |

### 8.3 Business Risks

| Risk             | Probability | Impact | Mitigation                           |
| ---------------- | ----------- | ------ | ------------------------------------ |
| Feature creep    | High        | Medium | Strict phase gates, MVP focus        |
| Delayed delivery | Medium      | High   | Buffer time, scope adjustment        |
| Customer churn   | Medium      | High   | Early access program, feedback loops |

---

## Appendix A: Glossary

| Term                | Definition                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| **IR**              | Intermediate Representation - compiled form of Agent Blueprint Language (ABL) |
| **Flow Mode**       | Scripted execution with deterministic state machine                           |
| **Reasoning Mode**  | LLM-driven execution with constraints                                         |
| **RBAC**            | Role-Based Access Control                                                     |
| **Circuit Breaker** | Pattern to prevent cascading failures                                         |
| **Vector DB**       | Database optimized for similarity search                                      |

---

## Appendix B: Reference Links

- [Agent Blueprint Language (ABL) Design Doc](./AGENT_DSL_DESIGN.md)
- [Implementation Status](./STATUS.md)
- [Observability and Tracing](./OBSERVABILITY_AND_TRACING.md)
- [Guardrails Specification](./proposals/GUARDRAILS_SPEC.md)
- [Model Registry & LLM Services](./MODEL_REGISTRY_AND_LLM_SERVICES.md) ✅ NEW

---

_Document maintained by the Agent Blueprint Language (ABL) Platform Team_
