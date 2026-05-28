# Platform Observability Roadmap

> **Status**: Partially Implemented (multi-tenancy complete, observability in progress)
> **Priority**: P0
> **Dependencies**: ENTERPRISE_ROADMAP.md (Phase 2), OBSERVABILITY_AND_TRACING.md
> **Last Updated**: 2026-03-02
> **Consolidates**: TODO_MULTI_TENANT_OBSERVABILITY.md (deleted), plans/2026-02-19-platform-observability-design.md (deleted)

---

## 1. Goal

Implement a two-level observability architecture for the agent platform:

- **Within a tenant (Layer 2):** Workspace members see traces, metrics, and dashboards scoped to their account. Cross-session analytics, agent performance, and LLM cost breakdowns are tenant-isolated by design.
- **Across tenants (Layer 1 + Platform Ops):** Platform operators see global infrastructure health, usage metering, anomaly detection, and capacity planning. Coroot provides eBPF-based infrastructure monitoring with AI root cause analysis; ClickHouse-backed admin dashboards provide cross-tenant usage views.

These two layers are complementary:

| Layer                   | Scope                                     | Audience                       | Data Source                               |
| ----------------------- | ----------------------------------------- | ------------------------------ | ----------------------------------------- |
| Infrastructure (Coroot) | K8s, DBs, inter-service                   | Platform SRE/Ops               | eBPF probes, Prometheus metrics           |
| Agent Analytics         | Conversations, LLM cost, handoffs, traces | Tenant teams + Platform admins | ClickHouse trace tables, MongoDB sessions |

---

## 2. Current State

```
Organization (tenant boundary -- data isolation, RBAC)
+-- OrgMember (User + Role: OWNER, ADMIN, OPERATOR, VIEWER)
+-- ApiKey (SHA-256 hashed, scoped to org)
+-- Project (scoped to org via tenantId)
|   +-- ProjectAgent
|   |   +-- AgentVersion (compilation persistence)
|   +-- AgentSession (scoped to org)
+-- AuditLog (per-org audit trail)
+-- DebugToken / ServiceNode
```

### Already Implemented

- Multi-tenant data model (Organization, OrgMember, ApiKey, AuditLog)
- Unified auth middleware (JWT + SDK session token + API key -> TenantContextData)
- RBAC with role-based route guards (OWNER, ADMIN, OPERATOR, VIEWER)
- Tenant isolation via AsyncLocalStorage + `requireProjectScope()`
- Per-tenant rate limiting (sliding window)
- Encryption service (AES-256-GCM, tenant-scoped keys)
- Redis-backed session store with tenant isolation
- Trace PII scrubbing in tool call logging
- ClickHouse trace pipeline with 5 tables (see [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md), Section 5)
- In-memory ring buffer + Redis streams for real-time trace delivery

### Remaining (This Roadmap's Scope)

- No cross-session or aggregate views (viewer is single-session scoped)
- No workspace concept within organizations (flat org -> project hierarchy)
- No infrastructure-level monitoring (Coroot not yet deployed)
- No Prometheus `/metrics` endpoint on Runtime
- No SLO-based alerting or error budget tracking
- No tenant-facing dashboards for agent analytics
- No platform admin cross-tenant usage views

---

## 3. Target Hierarchy

```
Account (tenant boundary -- billing, data isolation)
+-- Workspace (logical grouping -- team/department)
|   +-- Member (User + Role: OWNER, ADMIN, MEMBER, VIEWER)
|   +-- Project
|   |   +-- ProjectAgent
|   |   +-- AgentSession
|   |   +-- TraceEvent (persistent)
|   +-- API Keys / Debug Tokens (scoped to workspace)
+-- Billing / Quotas / Plan
```

The Account is the billing and data isolation boundary. Workspaces provide team-level collaboration and scoping within an account. Every database query for tenant data includes `account_id`; workspace scoping is an additional filter within the account boundary.

---

## 4. Infrastructure Monitoring -- Coroot

### 4.1 Why Coroot

Evaluated against Groundcover, Datadog, Grafana Cloud, Dynatrace, and Odigos:

| Criterion           | Coroot                                                              |
| ------------------- | ------------------------------------------------------------------- |
| License             | Apache 2.0, self-hosted                                             |
| Storage             | ClickHouse-native (matches existing stack)                          |
| Instrumentation     | eBPF -- zero code changes for network/DB monitoring                 |
| AI analysis         | Built-in root cause analysis across metrics, logs, traces, profiles |
| Profiling           | Always-on continuous profiling (~1% overhead)                       |
| Alerting            | SLO-based with error budget tracking                                |
| Cost                | Free (self-hosted), Enterprise available                            |
| Database monitoring | Auto-discovers MongoDB, Redis, ClickHouse via protocol parsing      |

Key advantage: Coroot stores data in ClickHouse, which we already operate for the trace pipeline. No new storage infrastructure needed. Coroot creates its own `coroot` database with separate tables -- no schema conflicts with the existing trace tables.

### 4.2 Deployment Architecture

```
+---------------------------------------------------+
|  Kubernetes Cluster (EKS/GKE/AKS)                 |
|                                                    |
|  +--------------+   +--------------------------+   |
|  | coroot-node  |   |  Agent Platform Pods     |   |
|  | -agent       |   |                          |   |
|  | (DaemonSet)  |<--+  runtime (Express+WS)    |   |
|  | eBPF probes  |   |  studio (Next.js)        |   |
|  |              |   |  admin                    |   |
|  +------+-------+   |  compiler                |   |
|         |            +--------------------------+   |
|         v                                          |
|  +---------------+                                 |
|  | Coroot Server |<--- Web UI (port 8080)          |
|  | (Deployment)  |                                 |
|  +------+--------+                                 |
|         |                                          |
|         v                                          |
|  +-------------------+                             |
|  | ClickHouse         |<--- Shared instance        |
|  | (existing cluster) |     coroot DB + trace DB   |
|  +--------------------+                            |
+----------------------------------------------------+
```

### 4.3 Day-1 Capabilities

All auto-discovered via eBPF with zero code changes:

**Kubernetes Cluster**

- Pod/container health, restarts, OOMKills, pending pods
- Node CPU, memory, disk, network utilization
- Deployment rollout status and readiness
- Namespace resource quotas and limits

**MongoDB**

- Query latency (p50/p95/p99) via TCP protocol parsing
- Connection pool utilization
- Slow query detection
- Read/write operation breakdown

**Redis**

- Command latency distribution
- Connection count and memory usage
- Key eviction rates
- Command type breakdown

**ClickHouse**

- Query performance and latency
- Insert throughput (critical for trace pipeline)
- MergeTree merge activity
- Replication lag (if clustered)

**Inter-Service Communication**

- Auto-generated service map with live RED metrics
- Request rate, error rate, latency between every service pair
- TCP connection states and retransmissions
- DNS resolution latency

**Continuous Profiling**

- CPU flame graphs per service (always-on, ~1% overhead)
- Memory allocation profiling
- Lock contention analysis

**AI Root Cause Analysis**

- Automatic cross-signal correlation when SLOs breach
- Identifies probable root cause (e.g., "MongoDB latency spike caused by missing index")

### 4.4 SLO-Based Alerting

| SLO                             | Target   | Window |
| ------------------------------- | -------- | ------ |
| Runtime API availability        | 99.9%    | 30d    |
| Runtime API latency (p99)       | < 500ms  | 30d    |
| WebSocket connection success    | 99.5%    | 7d     |
| MongoDB query latency (p95)     | < 100ms  | 7d     |
| Redis command latency (p99)     | < 10ms   | 7d     |
| ClickHouse insert latency (p95) | < 200ms  | 7d     |
| Pod restart rate                | < 5/hour | 1h     |

Alerts fire when error budget burns too fast, with AI-generated root cause context.

### 4.5 Code Changes Required (~70 lines)

**1. Helm Chart for Coroot (config only)**

```yaml
# deploy/coroot/values.yaml
coroot:
  storage:
    clickhouse:
      address: clickhouse-service:9000
      database: coroot

node-agent:
  enabled: true

cluster-agent:
  enabled: true
```

**2. Prometheus `/metrics` Endpoint (~50 lines)**

```typescript
// apps/runtime/src/routes/metrics.ts
import { collectDefaultMetrics, Registry, Counter, Histogram, Gauge } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const llmCallDuration = new Histogram({
  name: 'agent_llm_call_duration_seconds',
  help: 'LLM call duration',
  labelNames: ['provider', 'model', 'tenant_id'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const toolExecutionDuration = new Histogram({
  name: 'agent_tool_execution_duration_seconds',
  help: 'Tool execution duration',
  labelNames: ['tool_name', 'tenant_id'],
  buckets: [0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const activeSessions = new Gauge({
  name: 'agent_active_sessions',
  help: 'Currently active sessions',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export async function metricsHandler(req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
```

**3. Wire `/metrics` Route (~2 lines)**

```typescript
// apps/runtime/src/app.ts (add to existing routes)
import { metricsHandler } from './routes/metrics';
app.get('/metrics', metricsHandler);
```

**4. Instrument Existing Code (~20 lines)**

Add histogram observations at existing LLM call and tool execution sites:

```typescript
// In LLM call wrapper
const end = llmCallDuration.startTimer({ provider, model, tenant_id });
const result = await llmClient.complete(...);
end();

// In tool executor
const end = toolExecutionDuration.startTimer({ tool_name, tenant_id });
const result = await executor.execute(...);
end();
```

**Changes Summary**

| Change                    | Effort      | Type            |
| ------------------------- | ----------- | --------------- |
| Helm chart for Coroot     | Config only | Infrastructure  |
| `/metrics` endpoint       | ~50 lines   | New file        |
| Wire metrics route        | ~2 lines    | Modify existing |
| Instrument LLM/tool calls | ~20 lines   | Modify existing |
| `prom-client` dependency  | Package add | Dependency      |
| SLO definitions           | Config only | Coroot UI       |
| Alert channel config      | Config only | Coroot UI       |

---

## 5. Phase 1: Data Model -- Account & Workspace (Week 1-2)

### 5.1 Schema Changes

- [ ] Add `Account` model
  ```
  Account { id, name, slug (unique), plan, createdAt, updatedAt }
  ```
- [ ] Add `Workspace` model
  ```
  Workspace { id, accountId, name, slug, createdAt, updatedAt }
  Unique constraint: (accountId, slug)
  ```
- [ ] Add `WorkspaceMember` model
  ```
  WorkspaceMember { id, workspaceId, userId, role (OWNER/ADMIN/MEMBER/VIEWER), joinedAt }
  Unique constraint: (workspaceId, userId)
  ```
- [ ] Add `AccountMember` model
  ```
  AccountMember { id, accountId, userId, role (OWNER/ADMIN/BILLING), joinedAt }
  Unique constraint: (accountId, userId)
  ```
- [ ] Update `Project` model: add `workspaceId` foreign key, remove direct `ownerId`
- [ ] Update `AgentSession` model: add `accountId`, `workspaceId` columns
- [ ] Update `DebugToken` model: scope to workspace instead of user
- [ ] Write migration script for existing data (create default account + workspace per existing user)
- [ ] Add `Role` enum: `OWNER | ADMIN | MEMBER | VIEWER`

### 5.2 Auth Middleware Changes

- [ ] Extend JWT payload: include `accountId`, active `workspaceId`
- [ ] Create `resolveWorkspace` middleware: extract workspace from URL param or header
- [ ] Create `requireRole(minRole)` middleware: check WorkspaceMember role
- [ ] Update all route handlers to scope queries by `accountId`/`workspaceId`
- [ ] Add workspace switcher support (user can belong to multiple workspaces)

### 5.3 API Routes

- [ ] `POST /api/accounts` -- create account (creates default workspace)
- [ ] `GET /api/accounts/:id` -- get account details
- [ ] `POST /api/accounts/:id/workspaces` -- create workspace
- [ ] `GET /api/accounts/:id/workspaces` -- list workspaces
- [ ] `POST /api/workspaces/:id/members` -- invite member
- [ ] `PATCH /api/workspaces/:id/members/:userId` -- update role
- [ ] `DELETE /api/workspaces/:id/members/:userId` -- remove member
- [ ] Update all existing project/session routes to require workspace context

---

## 6. Phase 2: Persistent Trace Storage (Week 2-4)

### 6.1 ClickHouse Setup

- [ ] Add ClickHouse to docker-compose (dev environment) -- **already done, see `docker-compose.yml`**
- [ ] Create `@agent-platform/clickhouse` package or module in platform
- [ ] Implement ClickHouse client wrapper with connection pooling

See [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md), Section 5 for complete ClickHouse table schemas.

### 6.2 Materialized Views

The following materialized views provide pre-aggregated data for dashboards and billing:

- [ ] `agent_performance_hourly` -- avg latency, error rate, token usage per agent per hour
- [ ] `workspace_usage_daily` -- session count, LLM calls, tool calls, tokens per workspace per day
- [ ] `account_usage_daily` -- rolled up per account for billing

### 6.3 Dual-Write from TraceStore

- [ ] Modify `TraceStore.addEvent()` to write to ClickHouse asynchronously
- [ ] Add event batching: buffer events, flush every 1s or 100 events (whichever first)
- [ ] Add `account_id` and `workspace_id` to all trace events at emission time
- [ ] Keep in-memory ring buffer for real-time WebSocket streaming (hot path)
- [ ] ClickHouse becomes the persistence layer (cold path / query path)

See [OBSERVABILITY_AND_TRACING.md](./OBSERVABILITY_AND_TRACING.md) for the current tracing architecture and event schema.

### 6.4 Query API

- [ ] `GET /api/workspaces/:id/traces` -- query traces with filters:
  - `projectId`, `sessionId`, `agentName`, `eventType`
  - `startTime`, `endTime`
  - `limit`, `offset`
- [ ] `GET /api/workspaces/:id/traces/aggregate` -- aggregate queries:
  - Group by: agent, project, event_type, hour/day
  - Metrics: count, avg_latency, error_rate, token_sum
- [ ] `GET /api/workspaces/:id/sessions/:id/traces` -- session-scoped trace query (replaces in-memory only)
- [ ] All queries MUST include `account_id` in WHERE clause (enforced at middleware level)

---

## 7. Phase 3: Tenant-Scoped Viewer (Week 4-6)

### 7.1 Workspace Dashboard (New)

- [ ] Create `WorkspaceDashboard` component -- landing page after workspace selection
- [ ] Panels:
  - Active sessions (live count + list)
  - Agent performance summary (error rate, avg latency by agent)
  - Recent sessions (last 24h, sortable, filterable)
  - Usage chart (sessions, LLM calls, tokens over time)
- [ ] All data fetched via workspace-scoped API endpoints
- [ ] Auto-refresh on interval (30s) or WebSocket push

### 7.2 Cross-Session Views (New)

- [ ] Session list page: filter by project, agent, date range, status
- [ ] Session comparison: select 2 sessions, side-by-side span tree + timeline
- [ ] Session search: full-text search across trace event data within workspace
- [ ] Failing sessions view: filter sessions with error events, sorted by recency

### 7.3 Aggregate Analytics (New)

- [ ] Agent leaderboard: rank agents by error rate, latency, usage
- [ ] Tool performance: success rate, avg latency per tool across workspace
- [ ] Constraint violations: most-failed constraints, frequency over time
- [ ] LLM cost breakdown: by agent, project, model -- daily/weekly/monthly

### 7.4 Existing Viewer Updates

- [ ] Add workspace context provider (workspace ID in React context)
- [ ] Update WebSocket connection: authenticate with workspace scope
- [ ] Session list: show all workspace sessions, not just current user's
- [ ] Trace panel: add "load historical" button when session traces exceed ring buffer

---

## 8. Phase 4: Platform Ops -- Cross-Tenant Views (Week 6-8)

### 8.1 Platform Admin Backend

- [ ] Create `/api/admin/*` routes (require platform admin role)
- [ ] `GET /api/admin/accounts` -- list all accounts with usage summary
- [ ] `GET /api/admin/accounts/:id/usage` -- detailed usage for account
- [ ] `GET /api/admin/health` -- global health metrics:
  - Total active sessions across all tenants
  - Error rate by tenant
  - LLM token consumption rate
  - WebSocket connection count
- [ ] `GET /api/admin/usage/top` -- top accounts by LLM spend, session count, error rate
- [ ] `GET /api/admin/alerts` -- anomaly detection (spike in errors, unusual usage patterns)

### 8.2 Platform Admin Dashboard (New)

- [ ] Account list with usage sparklines
- [ ] Global health overview: total sessions, errors, LLM calls (real-time)
- [ ] Tenant drill-down: click account -> see workspace breakdown -> session list
- [ ] Usage metering chart: daily token consumption per account (for billing)
- [ ] Capacity planning: projected storage growth, LLM cost trends

### 8.3 Cross-Tenant Queries (ClickHouse)

Queries WITHOUT `account_id` filter -- admin only, never exposed to tenants:

```sql
-- Top 10 accounts by LLM token usage (last 24h)
SELECT account_id, sum(token_count) FROM trace_events
WHERE event_type = 'llm_call' AND timestamp > now() - INTERVAL 1 DAY
GROUP BY account_id ORDER BY 2 DESC LIMIT 10

-- Error rate by account (last 7 days)
SELECT account_id,
  countIf(event_type = 'error') / count(*) as error_rate
FROM trace_events
WHERE timestamp > now() - INTERVAL 7 DAY
GROUP BY account_id

-- Agent performance across all tenants
SELECT agent_name, avg(latency_ms), count(*)
FROM trace_events WHERE event_type = 'llm_call'
GROUP BY agent_name ORDER BY 2 DESC
```

---

## 9. Phase 5: WebSocket Tenant Isolation (Week 5-6, parallel with Phase 3)

### 9.1 WebSocket Authentication

- [ ] Require JWT on WebSocket connect (pass as query param or first message)
- [ ] Validate workspace membership on connect
- [ ] Tag each WebSocket connection with `accountId` + `workspaceId`
- [ ] Reject subscription to sessions outside the user's workspace

### 9.2 Scoped Broadcasting

- [ ] Modify `TraceStore.broadcastToSubscribers()`: only send to subscribers in same workspace
- [ ] Add workspace-level broadcast channel: notify all workspace members of new sessions
- [ ] Rate limit per-workspace WebSocket message throughput

### 9.3 Redis Pub/Sub for Multi-Instance (Horizontal Scaling)

- [ ] Use Redis pub/sub channels keyed by `workspace:{id}:traces`
- [ ] Each server instance subscribes to channels for its connected clients
- [ ] Publish trace events to Redis channel on emit
- [ ] Receive and forward to local WebSocket clients

---

## 10. Phase 6: Retention & Quotas (Week 7-8)

### 10.1 Tenant-Based Retention

- [ ] Add `retentionDays` to Account model (default by plan):
  - Free: 7 days
  - Team: 30 days
  - Business: 90 days
  - Enterprise: custom (up to 365 days)
- [ ] ClickHouse TTL per partition: apply account-specific retention
- [ ] Cleanup job: run daily, remove expired traces per account policy
- [ ] Expose retention settings in workspace admin UI

### 10.2 Usage Quotas

- [ ] Add quota limits to Account model:
  - `maxSessionsPerDay`
  - `maxLLMTokensPerMonth`
  - `maxTraceEventsPerMonth`
  - `maxWorkspaces`
  - `maxMembersPerWorkspace`
- [ ] Enforce quotas at API middleware level
- [ ] Return `429 Too Many Requests` with quota details when exceeded
- [ ] Emit `quota_warning` event at 80% and `quota_exceeded` at 100%
- [ ] Quota dashboard in workspace settings

---

## 11. Data Isolation Guarantees

### Row-Level Security

Every database query touching tenant data MUST include `account_id`:

```typescript
// CORRECT
const traces = await clickhouse.query(`
  SELECT * FROM trace_events
  WHERE account_id = {accountId:String}
    AND workspace_id = {workspaceId:String}
    AND session_id = {sessionId:String}
`);

// WRONG -- never query without tenant filter (except admin routes)
const traces = await clickhouse.query(`
  SELECT * FROM trace_events
  WHERE session_id = {sessionId:String}
`);
```

### Middleware Enforcement

- [ ] Create `tenantFilter` middleware that auto-injects `accountId` into all DB queries
- [ ] Log and alert on any query that bypasses tenant filter
- [ ] Admin routes explicitly opt-out with `skipTenantFilter` flag + audit log entry

### Data Deletion

- [ ] Account deletion: cascade delete all workspaces, projects, sessions, traces
- [ ] ClickHouse: `ALTER TABLE trace_events DELETE WHERE account_id = ?`
- [ ] Must complete within 30 days (GDPR compliance)
- [ ] Confirm deletion with audit trail

---

## 12. Migration Strategy

### Existing Data

1. Create a `default` account for each existing user
2. Create a `default` workspace under each account
3. Move all existing projects into the default workspace
4. Assign existing user as OWNER of account and workspace
5. Backfill `account_id` and `workspace_id` on all AgentSession records

### Backward Compatibility

- Existing API endpoints continue to work during migration
- Add `X-Workspace-Id` header support; if missing, use user's default workspace
- Deprecate user-scoped endpoints after 1 release cycle

---

## 13. Resolved Design Decisions

### 13.1 Account vs Organization Naming

**Decision: Use `Account`.**

The enterprise roadmap uses "Organization" but "Account" is the better fit:

- Every user gets one, even on free tier -- "Organization" implies enterprise-only
- Consistent with SaaS conventions (Stripe, Vercel, GitHub use "account" at the billing boundary)
- Clearer hierarchy: "Account > Workspace" separates billing from collaboration; "Organization > Workspace" sounds like two levels of the same thing
- The existing codebase has zero references to either term, so no legacy to reconcile

**Action:** Update ENTERPRISE_ROADMAP.md references from "Organization" to "Account" for consistency.

### 13.2 Database Strategy -- Storage Architecture

**Original decision: PostgreSQL (control plane) + MongoDB (data plane) + ClickHouse (analytics).**

**Updated:** The platform consolidated on MongoDB for both control and data planes. See [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md) for the current architecture.

The three-layer storage concept still applies, but with MongoDB replacing PostgreSQL:

```
+-------------------------------------------------------------+
|                    STORAGE LAYERS                            |
+------------------+------------------+------------------------+
|  CONTROL PLANE   |   DATA PLANE     |   ANALYTICS PLANE      |
|  MongoDB         |   MongoDB        |   ClickHouse           |
|  (Mongoose)      |   (Mongoose)     |   (native client)      |
+------------------+------------------+------------------------+
|  Account         |  Sessions        |  trace_events          |
|  Workspace       |  Messages        |  usage_records         |
|  WorkspaceMember |  ConversationHx  |  agent_performance_mv  |
|  Project         |  AgentState      |  workspace_usage_mv    |
|  ProjectAgent    |  TraceEvents     |                        |
|  User            |  (hot, real-time)|                        |
|  RefreshToken    |                  |                        |
|  DebugToken      |  Sharded by      |  Partitioned by        |
|  AuditLog        |  accountId       |  (account_id, month)   |
|  ApiKey          |                  |                        |
+------------------+------------------+------------------------+
|  Low volume      |  High volume     |  Append-only           |
|  Strong relations|  High throughput |  Aggregation queries   |
|  ACID required   |  Flexible schema |  Columnar compression  |
|  ~100 writes/sec |  ~10K+ writes/sec|  ~1K+ inserts/sec      |
+------------------+------------------+------------------------+
```

**Why MongoDB for control plane** (updated rationale):

- Unified driver and ORM (Mongoose) across both planes reduces operational complexity
- MongoDB supports transactions (replica set required) for ACID-critical auth operations
- Existing codebase infrastructure already uses MongoDB with replica set on port 27018
- Eliminates the need for a separate PostgreSQL dependency and Prisma migration

**Why MongoDB for data plane** (unchanged):

- Session documents, conversation history, and agent state are natural document shapes
- Write throughput for enterprise-scale concurrent sessions
- Horizontal scaling via sharding by `accountId`
- TTL indexes for automatic session expiry
- Embedded subdocuments for single-read session loading

**Data flow between layers:**

```
Session message arrives
  |
  +---> MongoDB (immediate)
  |    +-- Insert message into session.messages[]
  |    +-- Update session.state
  |    +-- Insert trace_events (hot, 7-day TTL)
  |
  +---> ClickHouse (async, batched)
  |    +-- Batch insert redacted trace_events (1s or 100 events)
  |    +-- Long-term analytics (90-day retention)
  |
  +---> In-memory ring buffer (real-time)
       +-- WebSocket broadcast to connected clients
       +-- 15-min TTL, not persisted
```

### 13.3 ClickHouse Hosting

**Decision: Docker (self-hosted) for dev/staging, ClickHouse Cloud for production.**

- Dev/staging: Single-node ClickHouse in docker-compose (port 8124), zero config, fast iteration
- Production: ClickHouse Cloud (pay-per-query) avoids operational overhead of managing MergeTree replication and backups
- Same SQL and table engines across both, so no code differences between environments
- Start with ClickHouse Cloud free tier (10GB), scale to paid when trace volume justifies it

### 13.4 Workspace-Level Agent Sharing

**Decision: Agents are project-scoped by default, but can be made visible (read-only) across workspaces within the same account.**

Currently agents are discovered from the filesystem and registered per-project via `ProjectAgent` (unique on `projectId + name`). This model stays.

- Within an account, a workspace should be able to **reference** agents from other workspaces (e.g., a "shared-agents" workspace that publishes reusable components) but not modify them
- Cross-account agent sharing is out of scope (marketplace feature, Phase 3 of enterprise roadmap)

**Implementation:**

- Add `visibility` field to `ProjectAgent`: `PROJECT` (default) | `ACCOUNT`
- When `ACCOUNT`, any workspace in the same account can load the agent read-only
- Agent mutations (edit, delete, redeploy) always require project-level MEMBER+ role
- Agent listing API returns project-local agents + account-visible agents from other workspaces

### 13.5 Trace PII Handling

**Decision: Redact PII before ClickHouse storage. Do NOT encrypt trace payloads per-tenant in ClickHouse.**

Per-tenant encryption in ClickHouse would break columnar compression and make queries impractical (can't filter or aggregate on encrypted fields). Instead:

```
Trace event emitted
  +-- In-memory ring buffer (full data, including PII) -> real-time WebSocket debugging
  |   +-- Ephemeral, 15min TTL, not persisted
  +-- traceRedactor service -> ClickHouse (redacted data, no PII)
      +-- Persistent, queryable, long-term analytics
```

**Redaction strategy:**

1. `traceRedactor` service scrubs known PII patterns (emails, phone numbers, credit cards, names) from trace `data` fields before ClickHouse write
2. Full conversation content (with PII) stored in MongoDB sessions collection only, encrypted at rest via MongoDB's encryption-at-rest (KMIP/local keyfile) -- never written to ClickHouse
3. Trace events in ClickHouse get redacted summaries: tool names, latencies, error codes, token counts -- but not raw user messages or LLM responses
4. ClickHouse disk encryption (AES-256) provides compliance-level data-at-rest protection without per-tenant key management
5. MongoDB's Client-Side Field Level Encryption (CSFLE) available for enterprise tenants requiring per-tenant key isolation on sensitive session fields

**Enterprise override:** For tenants on Enterprise plan needing full trace retention with PII, offer MongoDB-backed trace storage with CSFLE + per-tenant encryption keys via AWS KMS / Azure Key Vault as an add-on. This is a Phase 3 feature, not needed for initial implementation.

---

## 14. Success Criteria

- [ ] A workspace member can see aggregate metrics across all projects in their workspace
- [ ] A workspace member CANNOT see any data from another account's workspace
- [ ] A platform admin can see usage across all accounts without accessing conversation content
- [ ] Traces persist beyond server restart and are queryable for the retention period
- [ ] Session comparison works across two sessions in the same workspace
- [ ] WebSocket connections are authenticated and scoped to workspace
- [ ] Quotas are enforced and visible to workspace admins
- [ ] Coroot service map shows all inter-service communication with RED metrics
- [ ] SLO dashboards track error budget burn rate for all 7 defined SLOs
- [ ] AI root cause analysis triggers automatically on SLO breaches
- [ ] `/metrics` endpoint exposes LLM call duration, tool execution duration, and active session gauges

---

_Related docs:_

- [Enterprise Roadmap](./ENTERPRISE_ROADMAP.md)
- [Observability and Tracing](./OBSERVABILITY_AND_TRACING.md)
- [Data Architecture](./DATA_ARCHITECTURE.md)
- [Runtime Architecture](./RUNTIME_ARCHITECTURE.md)
