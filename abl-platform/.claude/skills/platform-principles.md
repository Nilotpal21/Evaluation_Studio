---
name: platform-principles
description: Use when planning features, reviewing code, making architecture decisions, or implementing anything that touches data access, authentication, distributed state, tracing, compliance, or performance.
---

# Platform Principles

These are non-negotiable architectural invariants. Every feature, every PR, every line of code must satisfy all six.

## 1. Resource Isolation

Resource isolation is the highest-priority security concern. Every data path — read, write, query, cache, event — must be scoped to the appropriate ownership level.

### Tenant Scope

Every database query must include a `tenantId` filter. No cross-tenant data leakage is acceptable — even in error paths, logs, or cache keys.

- **DB-level tenant filtering, not application-level**: Use `Model.findOne({ _id: id, tenantId })` — never `Model.findById(id)` followed by a post-hoc `if (doc.tenantId !== tenantId)` check. The post-hoc pattern is a timing side-channel: an attacker can distinguish "exists but wrong tenant" from "doesn't exist" via response timing. Apply this to all CRUD operations: `findOneAndUpdate({ _id, tenantId })`, `findOneAndDelete({ _id, tenantId })`, `deleteMany({ tenantId })`.
- Redis keys, ClickHouse queries, MongoDB filters, and in-memory caches must be tenant-prefixed. A cache hit for tenant A must never be served to tenant B.
- API responses must never include data from other tenants — even partial fields, counts, or metadata.

### Project Scope

Project-scoped resources (sessions, workflows, channel-connections, deployments) must enforce project membership.

- Routes mount under `/api/projects/:projectId/...` — never use query params like `/api/sessions?projectId=`.
- Use `requireProjectPermission(req, res, 'object:operation')` — not tenant-wide `requireWriteAccess()`.
- After looking up a resource by ID, always verify `resource.projectId === req.params.projectId` to prevent cross-project access.
- Cache keys for project-scoped resources include `tenantId:projectId` prefix.

### User Scope

User-owned resources (preferences, drafts, personal API keys, saved queries) must filter by ownership.

- Filter by `createdBy` / `ownerId` — users must not access other users' resources even within the same tenant/project.
- User-scoped cache keys include `tenantId:userId` prefix.
- User preferences and personal settings are never shared across users.

### Cross-Scope Rules

- Cross-scope access returns **404** (not 403) to avoid leaking resource existence.
- Session resolution, artifact lookups, and resolution keys must verify scope matches before returning results. Never trust an ID alone — always confirm ownership at the appropriate level.
- Test every data access path with a multi-scope scenario: two tenants, two projects, two users — same resource names, verify zero cross-contamination.
- **Authorization test coverage**: Every route handler that accepts an ID parameter must have an authz test verifying: (1) correct permission is required, (2) cross-tenant access returns 404, (3) cross-project access returns 404, (4) cross-user access returns 404 (where applicable), (5) missing auth returns 401. See `apps/runtime/src/__tests__/*-authz.test.ts` for examples.

## 2. Centralized Authentication

Auth is handled once, at the edge, and propagated — never re-implemented per route or per feature.

- All authentication flows (user JWT, SDK session token, API key) converge to `TenantContextData` via shared middleware in `@agent-platform/shared`. No route or handler should parse tokens, validate keys, or check permissions independently.
- New endpoints use `createUnifiedAuthMiddleware` or `requireAuth` — never custom token verification. If an existing endpoint has bespoke auth logic, refactor it to use the central middleware.
- Session tokens carry identity claims (`identityTier`, `verificationMethod`, `callerContext`). Downstream code reads these — it never re-verifies.
- Permission checks use `requirePermission()` / `requireAnyPermission()`. No inline `if (role === 'admin')` checks.

## 3. Stateless Distributed Architecture

The platform runs on multiple pods behind a load balancer. Any request in a session can land on any pod.

- **No pod-local state as source of truth.** Sessions, conversations, agent registries, and resolution keys live in Redis (cluster) or MongoDB. In-memory Maps are caches only — always backed by a durable store, always rebuildable from the store on cache miss.
- **Session rehydration must work across pods.** A session created on pod A must be fully resumable on pod B. No in-memory-only fields, no pod-local references (open file handles, WebSocket refs) stored as session state, no singleton instances holding session data.
- **Local caches must be safe for distributed use.** Use content-addressed keys (IR source hash, compilation hash) so any pod builds the same cache entry for the same input. Include TTL and max-size eviction. Never cache tenant-specific data under a tenant-agnostic key.
- **Locks must be distributed.** Use Redis `SET NX PX` for execution locks, not in-memory `Set`. Lua scripts for atomic check-and-set operations.
- **Idempotent operations.** Message processing, session creation, and state transitions should be safe to retry. Use optimistic concurrency (version checks) to detect conflicts.

## 4. Full Traceability

Every runtime execution path must produce a complete, machine-readable trace. If it happened, there must be a trace event.

- Every LLM call, tool execution, handoff, constraint check, decision, escalation, and error must emit a `TraceEvent` with: session ID, agent name, caller identity (`tenantId`, `identityTier`, `channel`), timestamp, duration, and structured event data.
- Trace events flow through one shared `TraceStore` interface with pluggable backends (memory, ClickHouse). No ad-hoc logging as a substitute for structured tracing.
- Tool calls must be traceable end-to-end: caller context → parameters sent → response received → duration → success/failure. Non-negotiable for audit trails.
- Session resolution outcomes (new vs. resumed, resolution method, artifact match) must be traced.
- Errors must include enough context to reproduce: session ID, agent name, step name, input that caused the error. Never log just "error occurred".

## 5. Compliance (PCI, GDPR, SOC 2)

Every feature must be designed for regulatory compliance from day one.

- **Encryption at rest**: All PII (caller identity, conversation content, tool parameters/results, session context) must be encrypted in storage. Redis fields use `EncryptionService` with tenant-scoped DEKs. MongoDB sensitive fields use field-level encryption. ClickHouse trace data uses compress-then-encrypt. Secrets (HMAC keys, API keys, tokens) are never stored in plaintext — use KMS or `SecretsProvider`.
- **Encryption in transit**: All inter-service communication over TLS. WebSocket connections require authentication before any data exchange.
- **Data minimization**: Don't store data you don't need. PII has TTLs (messages: 90 days, sessions: TTL-based expiry, traces: configurable retention). Conversation history uses sliding windows, not unbounded growth.
- **Right to erasure**: Session deletion must cascade to all associated data: messages, traces, resolution keys, cached state. No orphaned PII.
- **Audit logging**: Authentication events, permission changes, data access, and administrative actions must be logged with actor identity, timestamp, and action. Use the shared audit store.
- **Access control**: Every API endpoint has explicit permission requirements. No endpoint is publicly accessible without authentication (except health checks and SDK init with public key).

## 6. Performance, Compression & Payload Optimization

Performance is a first-class concern, not an afterthought.

- **Compress before storing**: AgentIR and CompilationOutput are gzipped before Redis/ClickHouse writes. Use async compression (`promisify(gzip)`) — never sync.
- **Validate payload size before processing**: Check input size before compression, decompression, JSON parsing, and LLM calls. Reject oversized payloads at the boundary with a structured error.
- **Minimize serialization overhead**: Store references (hashes, IDs) on sessions — not full object copies. Use `irSourceHash` to look up AgentIR from cache, not embed it per session.
- **Batch operations**: Use Redis pipelines for multi-key operations. Use ClickHouse `BufferedWriter` for batched inserts. Avoid N+1 query patterns — batch-fetch with `$in` or `IN()`.
- **Conversation windows**: Cap conversation history with sliding windows (`maxMessages` config). Don't let LLM context grow unbounded.
- **Connection pooling and warmup**: Pre-warm LLM connections on session creation. Pool database connections. Use keep-alive for HTTP tool calls.
- **Measure what matters**: Every store operation, LLM call, and tool execution records duration. Trace events include `durationMs`.
