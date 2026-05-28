# LLD: Agent Assist V1 Compatibility Facade — Phase Actual Implementation Plan

**Feature Spec**: [docs/features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
**HLD**: [docs/specs/agent-assist-runtime-compat.hld.md](../specs/agent-assist-runtime-compat.hld.md)
**Test Spec**: [docs/testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)
**POC Reference**: [docs/poc/agent-assist-runtime-compat-poc-reference.md](../poc/agent-assist-runtime-compat-poc-reference.md)
**JIRA**: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
**Status**: DONE
**Date**: 2026-04-22 (last revised 2026-04-25 — see post-impl-sync log)

---

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Alternatives Rejected                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Keep existing POC service module structure at `apps/runtime/src/services/agent-assist/*.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 13 files proven in production smoke tests against real widget; zero-change where possible                                                                                                                                                                                                                                                                                                                                                                                                                      | Full rewrite; renaming `agent-assist` → `kore-adapter` or similar                                                                                                                                                                                                                                                                                                                                                                  |
| D-2  | Binding persistence via Mongoose model + repo with `tenantIsolationPlugin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Matches existing collection patterns (`auth-profile`, `channel-connections`); plugin gives defense-in-depth even if code forgets `tenantId` filter                                                                                                                                                                                                                                                                                                                                                             | Kept env-seeded POC resolver as production path; used SQL-backed store; used generic `integration_bindings` polymorphic collection (deferred)                                                                                                                                                                                                                                                                                      |
| D-3  | Admin CRUD via Next.js App Router handlers under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/...`; wrap every handler with `withAdminRoute({ role: 'ADMIN' }, handler)`; extend the `AdminAction` union with 5 new members (`compat_binding_create`/`_update`/`_disable`/`_enable`/`_delete`) and log via `logAdminAction({ actor, actorRole, action, target, metadata: { before, after } })` (the canonical audit signature — no ad-hoc `{ subject, before, after }` shape)                                                                                                                                                                     | Admin app uses App Router for all tenant-scoped APIs; `withAdminRoute` is the canonical tenant-scoped handler wrapper (same pattern as `feature-toggle`, `secrets` routes); `logAdminAction` has a fixed shape and a closed `AdminAction` union — new actions must be declared at the type level so audit queries can filter on them                                                                                                                                                                           | Express-style admin (incompatible with admin app); nested under a new top-level admin surface; reusing an existing `AdminAction` (e.g. `config_view`) for binding mutations — muddies audit filtering and loses semantic fidelity                                                                                                                                                                                                  |
| D-4  | BullMQ queue `agent-assist-callback` + DLQ `agent-assist-callback-dlq` for async-push                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Same pattern as A2A async callbacks; reuses existing Redis + BullMQ infra; retries + DLQ come for free                                                                                                                                                                                                                                                                                                                                                                                                         | Fire-and-forget with background `Promise.all` (POC mode — no retries, in-memory loss on pod crash); native cron replay (unnecessary overhead)                                                                                                                                                                                                                                                                                      |
| D-5  | HMAC signing format `X-ABL-Signature: t=<unix-seconds>,v1=<hex-sha256>` with KMS-resolved secret + 5-minute validity window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Stripe-webhook convention; receiver side is well-understood                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Unsigned callbacks (security regression); JWT signing (heavier than necessary); rolling-key secret rotation (open question §9 item 1 — deferred)                                                                                                                                                                                                                                                                                   |
| D-6  | Permission: reuse existing `session:send_message` (same as native chat)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | FR-11 + HLD concern #4 explicitly rule out a new permission scope; `POST /api/v1/chat/agent` already enforces this permission for the same underlying operation                                                                                                                                                                                                                                                                                                                                                | `agent_suggestions:execute` (rejected when Layer A dropped); `agent_assist:execute` (net-new scope with no separate authorization decision to make)                                                                                                                                                                                                                                                                                |
| D-7  | Feature gate: new `agent_assist` slug resolved via existing `requireFeature` (reads `Deal.features[]` first, then `PLAN_FEATURES[planTier]` fallback), wrapped by a facade-specific `requireFacadeFeature('agent_assist')` that flips 403 → 404 `APP_NOT_FOUND` and fail-open DB error → fail-closed 404. Initial rollout uses **Deal-grant only** (no `PLAN_FEATURES` change needed — the resolver checks Deals before plan tier)                                                                                                                                                                                                                                    | Per-tenant control with zero plan-tier pollution. `requireFeature` verbatim behaviour is 403 + fail-open (confirmed at `apps/runtime/src/middleware/feature-gate.ts:119,126-132`) — both wrong for this facade (existence disclosure + DoS posture). Wrapping preserves the existing resolution logic while correcting the failure semantics. Deal-grant only for pilot keeps the feature invisible to non-pilot tenants without touching `PLAN_FEATURES`                                                      | Env-var-only (POC pattern — too blunt for tenant rollout); adding to `PLAN_FEATURES` on day one (leaks feature onto entire plan tiers instead of a curated pilot list); using `requireFeature` raw (wrong status code + wrong failure mode); using `createFailClosedFeatureGate` raw (returns 503 not 404)                                                                                                                         |
| D-11 | Phase-1 binding cache is a bounded LRU+TTL (`maxEntries=AGENT_ASSIST_BINDING_CACHE_MAX`, default 500; `ttlMs=AGENT_ASSIST_BINDING_CACHE_TTL_MS`, default 60 000 ms). Since no shared `LRU+TTL` helper exists in the repo (existing `LRUCache` at `apps/runtime/src/services/session/session-service.ts:32-74` has max-size but no TTL; `TTLCache` at `packages/search-ai-internal/src/embedding/resolver.ts` is private) we add a new `LRUTTLCache<V>` helper at `packages/shared-kernel/src/cache/lru-ttl-cache.ts` with unit tests, and the binding repo consumes it.                                                                                               | CLAUDE.md Core Invariant "Every in-memory `Map` needs max size, TTL, and eviction". A reusable helper in `shared-kernel` pays forward to the next feature that needs this shape (future: API-key cache, deployment resolver cache). Preempts memory-pressure incidents on long-running pods and makes cache-hit tests deterministic.                                                                                                                                                                           | Unbounded `Map` (violates invariant); external Redis cache (overkill for sub-millisecond lookup); adding `lru-cache` npm (new top-level dep for 80 LOC of functionality the repo already has multiple rough drafts of); inlining a one-off bounded cache in the repo (violates "fix the code, not the test" — third duplicate of the same pattern is a smell)                                                                      |
| D-12 | Project/tenant delete cascades to `agent_assist_bindings` via the existing project-cleanup pipeline + a new hook at cascade registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Right-to-erasure compliance (CLAUDE.md Core Invariant #5). Binding records reference `projectId` and `tenantId`; when those parents are erased, the binding must be erased too.                                                                                                                                                                                                                                                                                                                                | Leave orphaned rows (violates compliance); manual admin cleanup (error-prone)                                                                                                                                                                                                                                                                                                                                                      |
| D-8  | Trace events registered in `packages/shared-kernel/src/constants/trace-event-registry.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | HLD §4 concern #8; existing pattern; Observatory / Trace UI picks up new events automatically                                                                                                                                                                                                                                                                                                                                                                                                                  | Per-feature registry (fragments registry); ad-hoc logging (violates CLAUDE.md invariant #4 Traceability)                                                                                                                                                                                                                                                                                                                           |
| D-9  | SSE heartbeat via comment line `: heartbeat\n\n` every `AGENT_ASSIST_SSE_HEARTBEAT_MS` (default 15 000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Matches chat.ts's heartbeat convention; V1 clients reject named events but accept SSE comments                                                                                                                                                                                                                                                                                                                                                                                                                 | `data: {"heartbeat":true}\n\n` (leaks protocol detail in widget body); no heartbeat (CDN/proxy idle-timeout drops)                                                                                                                                                                                                                                                                                                                 |
| D-10 | Runtime errors return HTTP 200 with `sessionInfo.status:"error"` (intentional V1-compat deviation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Kore.ai widget parses errors via `sessionInfo.status`, not HTTP code; bounded to this facade only                                                                                                                                                                                                                                                                                                                                                                                                              | HTTP 5xx with `{error}` envelope (breaks widget error rendering); new V1.1 error shape (no existing consumer)                                                                                                                                                                                                                                                                                                                      |
| D-13 | Admin tenant-scope posture: `withAdminRoute({ role: 'ADMIN' }, handler)` enforces super-admin-only (existing repo posture — every super-admin can access any tenant). Handlers pass `params.tenantId` through to the repo, which enforces `tenantIsolationPlugin` at the DB floor. We do NOT add per-admin tenant-scope RBAC in Phase Actual — that is tracked as open question §7-2.                                                                                                                                                                                                                                                                                 | Matches existing admin surface (`apps/admin/src/app/api/tenants/[tenantId]/secrets/**`, `feature-toggle/route.ts`); scope narrower than the whole admin app is not currently expressible in `AdminRouteOptions`; audit log captures the actor for every mutation so attribution is preserved; repo-layer isolation prevents admin-scope errors from leaking cross-tenant data.                                                                                                                                 | Invent a new scope-matching helper (`assertTenantAccess(req, params.tenantId)` — rejected as it has no principal-scope source of truth to check against); block super-admins entirely (breaks existing admin workflows); wait for tenant-scoped RBAC (blocks Phase Actual on an unscoped backlog item).                                                                                                                            |
| D-14 | Trace events registered via the full 6-step domain-group pattern in `packages/shared-kernel/src/constants/trace-event-registry.ts`: (1) `AGENT_ASSIST_TRACE_EVENT_TYPES` const array, (2) `AgentAssistTraceEventType` union, (3) `TRACE_EVENT_GROUPS.agent_assist` key, (4) spread into `ALL_TRACE_EVENT_TYPES`, (5) entries in `RUNTIME_EVENT_TYPES`, (6) `registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES)` spread into `TRACE_EVENT_REGISTRY`.                                                                                                                                                                                             | Existing 20-domain pattern (e.g. `a2a`, lines 228-229 of the registry); skipping any step would make events silently unrecognized by Observatory / Trace UI because the registry drives their enumeration.                                                                                                                                                                                                                                                                                                     | Single-file "append event name" (the registry rejects unregistered types at the `TraceEventType` compile-time check); per-feature registry module (fragments the registry — explicitly rejected by existing pattern).                                                                                                                                                                                                              |
| D-15 | **Admin CRUD uses the proxy pattern (not direct DB access).** Admin Next.js handlers under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/...` are THIN proxies that (a) run `withAdminRoute({ role: 'ADMIN' }, ...)`, (b) call `logAdminAction` for audit, (c) `fetch(${getRuntimeBaseUrl()}/api/platform/admin/agent-assist/tenants/<tenantId>/bindings/...)` with `buildRuntimeHeaders(ctx)`, (d) relay the runtime response. The actual CRUD executes on the runtime side in a NEW route module `apps/runtime/src/routes/platform-admin-agent-assist.ts`, mounted under `/api/platform/admin/agent-assist` using `platformAdminAuthMiddleware`. | Matches every existing admin tenant-scoped route (confirmed at `apps/admin/src/app/api/tenants/[tenantId]/feature-toggle/route.ts` and all `platform-admin-*.ts` runtime routes at `apps/runtime/src/routes/`); keeps MongoDB access consolidated in the runtime (connection lifecycle already solved there — Next.js App Router has no stable connection-pooling story without bespoke singletons); keeps the repo (`AgentAssistBindingResolver`) inside the runtime package boundary — no cross-app imports. | Direct DB from the admin app (first admin route with CRUD against Mongo — bespoke connection lifecycle, duplicates repo, cross-app import of `apps/runtime/src/repos/...`); skipping runtime-side admin routes entirely (blocks the admin surface from being audit-logged server-side via traces).                                                                                                                                 |
| D-16 | **Async callback URL validation is layered**: (a) Zod schema at the route handler rejects obvious violations (missing `callbackUrl` with `isAsync:true` → 400 `CALLBACK_URL_REQUIRED`; malformed URL → 400 `INVALID_CALLBACK_URL`). (b) Allowlist policy (absolute HTTPS, or `http://localhost`) is enforced at enqueue time in the worker — rejected at this stage moves the job to DLQ and emits `agent_assist.callback_failed`. The sync 202 response is still returned to the caller even if the URL ultimately fails at the worker.                                                                                                                              | Matches the "validate at boundaries" principle: cheap syntactic checks run inline; semantic allowlist runs in the worker where the retry/DLQ/trace machinery lives. Returning 202 then DLQ-ing on bad URL is intentional — it preserves the async-contract semantics (caller can't tell at sync-time whether the callback will succeed) and keeps the callback worker as the single source of truth for delivery policy.                                                                                       | Syntactic + allowlist both at route (rejected: duplicates policy, makes worker-only config changes require a route redeploy); worker-only validation (rejected: missing `callbackUrl` with `isAsync:true` is a sync-time contract error and should 400 fast, not silently DLQ); strict sync-mode rejection with HTTP 4xx for bad URLs (rejected: async-contract callers generally expect 202 + out-of-band failure, not sync 4xx). |

### 1.2 Key Interfaces and Types

These are the only NEW public types. Everything else is private to the service module.

```typescript
// packages/database/src/models/agentAssistBinding.ts
export interface IAgentAssistBinding extends IBaseDocument {
  _id: string; // UUID v7
  tenantId: string; // required, indexed via tenantIsolationPlugin
  projectId: string; // required
  appId: string; // Kore.ai-facing "aa-<uuid>"
  environment: string; // lowercased at write time
  status: 'active' | 'disabled'; // "placeholder" is runtime-only (env-seeded), never persisted
  deploymentId: string | null; // null → env-active deployment resolution
  apiKeyId: string | null; // opaque label stamped on session.callerContext
  displayName: string | null;
  createdBy: string;
  updatedBy: string | null;
  disabledAt: Date | null;
  disabledBy: string | null;
}

// apps/runtime/src/repos/agent-assist-binding-repo.ts
export interface AgentAssistBindingResolver {
  get(
    ctx: { tenantId: string },
    key: { appId: string; environment: string },
  ): Promise<IAgentAssistBinding | null>;
  invalidate(tenantId: string, appId: string, environment: string): void;
  // Admin-only operations (no cache side-effects other than invalidation):
  list(
    ctx: { tenantId: string },
    page: { offset: number; limit: number },
  ): Promise<{
    items: IAgentAssistBinding[];
    total: number;
  }>;
  findById(ctx: { tenantId: string }, id: string): Promise<IAgentAssistBinding | null>;
  create(
    ctx: { tenantId: string; actor: string },
    input: CreateBindingInput,
  ): Promise<IAgentAssistBinding>;
  update(
    ctx: { tenantId: string; actor: string },
    id: string,
    patch: UpdateBindingInput,
  ): Promise<IAgentAssistBinding>;
  setStatus(
    ctx: { tenantId: string; actor: string },
    id: string,
    status: 'active' | 'disabled',
  ): Promise<IAgentAssistBinding>;
  remove(ctx: { tenantId: string; actor: string }, id: string): Promise<void>;
}

export interface CreateBindingInput {
  projectId: string;
  appId: string;
  environment: string; // normalized lowercase
  deploymentId?: string | null;
  apiKeyId?: string | null;
  displayName?: string | null;
}

export type UpdateBindingInput = Partial<
  Pick<IAgentAssistBinding, 'projectId' | 'deploymentId' | 'apiKeyId' | 'displayName'>
  // tenantId / appId / environment are immutable
>;

// apps/runtime/src/jobs/agent-assist-callback-worker.ts
// The worker REPLAYS execution (HLD concern 6 — idempotency). Job payload carries
// the V1 request, not a pre-built envelope, so a pod crash between sync 202 and
// worker pickup does not lose the response. The session's deterministic keying
// (UUIDv5 over binding + sessionReference) ensures replay reuses the same
// session row.
export interface AgentAssistCallbackJob {
  tenantId: string;
  projectId: string;
  bindingId: string;
  sessionId: string; // s-<deterministic>; sessionService.createSessionFromResolved replays idempotently on this id
  messageId: string; // msg_<uuid>; regenerated on each attempt OK — envelope carries its own messageId on completion
  runId: string; // stable across retries; supplied to trace events
  callbackUrl: string; // absolute URL validated at route Zod; allowlist policy (HTTPS-only / localhost) enforced in worker (D-16)
  input: {
    v1RequestBody: V1ExecuteRequest; // whole V1 /runs/execute body as received (minus `callbackUrl`, `isAsync` — those are job-level)
    callerUserId: string; // from auth context; worker impersonates for executor call
    authScopes: string[]; // snapshot of principal scopes at enqueue time
  };
  enqueuedAt: string; // ISO
}

// packages/shared-kernel/src/cache/lru-ttl-cache.ts (NEW shared utility, D-11)
export interface LRUTTLCacheOptions {
  maxEntries: number; // required; entries evicted in insertion order past this
  ttlMs: number; // required; entries expire on read after this age
  now?: () => number; // DI for deterministic tests
}

export class LRUTTLCache<V> {
  constructor(opts: LRUTTLCacheOptions);
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

// packages/admin/src/lib/audit-logger.ts — EXTENSION (D-3)
// Current union (line 9-15 of audit-logger.ts) extended with 5 new members:
export type AdminAction =
  | 'config_view'
  | 'secret_list'
  | 'secret_create'
  | 'secret_update'
  | 'secret_delete'
  | 'secret_rotate'
  | 'compat_binding_create' // NEW
  | 'compat_binding_update' // NEW
  | 'compat_binding_disable' // NEW
  | 'compat_binding_enable' // NEW
  | 'compat_binding_delete'; // NEW
// AuditEntry stays unchanged; use `metadata` for before/after diffs.
```

No new types exported from `apps/runtime`'s public barrel (facade is internal to the runtime). `LRUTTLCache<V>` is exported from `@agent-platform/shared-kernel`. `AdminAction` additions live in the admin app's existing audit-logger module.

### 1.3 Module Boundaries

| Module / file                                                                                                         | Responsibility                                                                                                                                                                                                  | Depends on                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/models/agentAssistBinding.ts`                                                                  | Mongoose model + schema + plugins                                                                                                                                                                               | `mongoose`, `tenantIsolationPlugin`, `audit-trail.plugin`                                                                                                                                                                                     |
| `apps/runtime/src/repos/agent-assist-binding-repo.ts`                                                                 | CRUD + read cache + cache invalidation event; enforces tenant scope in repo layer                                                                                                                               | `AgentAssistBinding` model                                                                                                                                                                                                                    |
| `apps/runtime/src/services/agent-assist/binding-resolver.ts` (rewrite)                                                | POC env-seeded resolver retained behind `AGENT_ASSIST_SEED_MODE=env`; Mongo repo is default                                                                                                                     | `AgentAssistBindingResolver` (Mongo-backed)                                                                                                                                                                                                   |
| `apps/runtime/src/services/agent-assist/execution-bridge.ts` (minor edits)                                            | Dispatch to placeholder OR `RuntimeExecutor`; stamp `_agentAssist` metadata                                                                                                                                     | `DeploymentResolver`, `RuntimeExecutor`, `SessionService`                                                                                                                                                                                     |
| `apps/runtime/src/services/agent-assist/metadata-normalizer.ts` (tighten)                                             | Strip reserved keys; bound `aa_uamsgs`; return `SdkMessageMetadata`-safe subset ONLY (FR-20 new)                                                                                                                | `SdkMessageMetadata` type                                                                                                                                                                                                                     |
| `apps/runtime/src/services/agent-assist/callback-sender.ts` (rewrite to queue-wrapper)                                | Enqueue job onto BullMQ `agent-assist-callback`; dev-only sync fallback behind env flag                                                                                                                         | `@agent-platform/async-infra` BullMQ helpers                                                                                                                                                                                                  |
| `apps/runtime/src/jobs/agent-assist-callback-worker.ts` (new)                                                         | BullMQ worker: replay execution, HMAC sign, POST, retry, DLQ                                                                                                                                                    | `RuntimeExecutor`, HMAC helpers, KMS for secret resolution                                                                                                                                                                                    |
| `apps/runtime/src/routes/agent-assist.ts` (rewrite)                                                                   | Mount + route handlers; feature-gate + rate-limit middleware chain                                                                                                                                              | `authMiddleware` (wrapper in `apps/runtime/src/middleware/auth.ts` that composes `unifiedAuth` + `requireAuthenticatedRequest` + `requireTenantContextMiddleware`), `requirePermission`, `requireFacadeFeature` (new, wraps `requireFeature`) |
| `apps/runtime/src/routes/platform-admin-agent-assist.ts` (new)                                                        | Runtime-side admin CRUD handlers under `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/...`; authoritative store-of-record for bindings; `platformAdminAuthMiddleware` enforces super-admin (D-15) | `platformAdminAuthMiddleware` (from `apps/runtime/src/middleware/auth.ts:214`), `AgentAssistBindingResolver`                                                                                                                                  |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/**/route.ts` (new, 4 files — THIN PROXIES, D-15)     | Admin Next.js thin proxies: `withAdminRoute({ role: 'ADMIN' }, handler)` → `fetch(runtime admin endpoint)` → `logAdminAction` on 2xx. Runtime is the ONLY surface that touches Mongo for bindings.              | `withAdminRoute` (from `apps/admin/src/lib/with-admin-route.ts`), `logAdminAction` (from `apps/admin/src/lib/audit-logger.ts`), `getRuntimeBaseUrl`/`buildRuntimeHeaders` (from `apps/admin/src/lib/runtime-proxy.ts`)                        |
| `packages/shared-kernel/src/cache/lru-ttl-cache.ts` (new)                                                             | Reusable bounded LRU+TTL cache utility (D-11)                                                                                                                                                                   | N/A                                                                                                                                                                                                                                           |
| `packages/shared-kernel/src/constants/trace-event-registry.ts` (extend via full 6-step domain-group pattern per D-14) | Register `agent_assist.*` domain: const array, union, `TRACE_EVENT_GROUPS` key, `ALL_TRACE_EVENT_TYPES` spread, `RUNTIME_EVENT_TYPES` entries, `TRACE_EVENT_REGISTRY` spread                                    | N/A                                                                                                                                                                                                                                           |
| `apps/admin/src/lib/audit-logger.ts` (extend)                                                                         | Add 5 new `AdminAction` union members (`compat_binding_create`/`_update`/`_disable`/`_enable`/`_delete`) — no other changes                                                                                     | N/A                                                                                                                                                                                                                                           |

---

## 2. File-Level Change Map

### 2.1 New Files

| File                                                                                                   | Purpose                                                                         | LOC est. |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------- |
| `packages/shared-kernel/src/cache/lru-ttl-cache.ts`                                                    | Reusable bounded LRU+TTL cache utility (D-11); zero deps                        | ~80      |
| `packages/shared-kernel/src/cache/__tests__/lru-ttl-cache.test.ts`                                     | Unit tests — eviction order, TTL expiry, clock-injection determinism            | ~150     |
| `packages/shared-kernel/src/cache/index.ts`                                                            | Barrel re-export of `LRUTTLCache`                                               | ~5       |
| `packages/database/src/models/agentAssistBinding.ts`                                                   | Mongoose model, schema, plugins, indexes                                        | ~110     |
| `apps/runtime/src/repos/agent-assist-binding-repo.ts`                                                  | Repo class + `LRUTTLCache`-backed read cache                                    | ~220     |
| `apps/runtime/src/routes/platform-admin-agent-assist.ts`                                               | Runtime-side admin CRUD routes; super-admin auth; the DB store of record (D-15) | ~280     |
| `apps/runtime/src/routes/platform-admin-agent-assist.schemas.ts`                                       | Zod strict schemas for the runtime admin surface                                | ~80      |
| `apps/runtime/src/__tests__/routes/platform-admin-agent-assist.int.test.ts`                            | Integration — real Express + Mongo + super-admin JWT, CRUD lifecycle            | ~300     |
| `apps/admin/src/__tests__/agent-assist-bindings-proxy.int.test.ts`                                     | Integration — Next.js handler + runtime test-double + audit write               | ~220     |
| `apps/admin/src/__tests__/agent-assist-bindings-proxy.unit.test.ts`                                    | Unit — audit fail-closed + schema pre-flight (DI, no vi.mock)                   | ~110     |
| `apps/runtime/src/services/agent-assist/feature-gate.ts`                                               | `requireFacadeFeature(feature)` wrapper: flips 403 → 404 + fail-closed          | ~90      |
| `apps/runtime/src/__tests__/services/agent-assist/feature-gate.test.ts`                                | Unit tests — 4 scenarios (on/off/DB-error/kill-switch)                          | ~130     |
| `apps/runtime/src/jobs/agent-assist-callback-worker.ts`                                                | BullMQ worker: replay + HMAC + POST + retry + DLQ                               | ~280     |
| `apps/runtime/src/services/agent-assist/hmac.ts`                                                       | Pure HMAC sign + verify helpers (Stripe-style `t=,v1=`)                         | ~70      |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/route.ts`                             | Next.js route — `POST` create + `GET` list                                      | ~180     |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/route.ts`                 | Next.js route — `GET` detail + `PATCH` update + `DELETE`                        | ~180     |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/disable/route.ts`         | Next.js route — `POST` disable                                                  | ~70      |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/enable/route.ts`          | Next.js route — `POST` enable                                                   | ~70      |
| `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/schemas.ts`                           | Zod strict schemas for admin create/update                                      | ~80      |
| `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts`                                   | Unit tests — repo helpers + cache                                               | ~220     |
| `apps/runtime/src/__tests__/jobs/agent-assist-callback-worker.test.ts`                                 | Unit tests — HMAC, backoff, URL allowlist                                       | ~250     |
| `apps/runtime/src/__tests__/services/agent-assist/v1-sse-emitter.test.ts`                              | Unit tests — SSE frame bytes                                                    | ~150     |
| `apps/runtime/src/__tests__/services/agent-assist/session-envelope.test.ts`                            | Unit tests — session / terminate envelope shape                                 | ~130     |
| `apps/runtime/src/__tests__/services/agent-assist/hmac.test.ts`                                        | Unit tests — HMAC sign + verify round-trip + bit-flip                           | ~90      |
| `apps/runtime/src/__tests__/integration/agent-assist-execution-bridge.int.test.ts`                     | Integration — real executor, DI LLM double, callerContext shape                 | ~200     |
| `apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts`                         | Integration — real Mongo, tenantIsolationPlugin, unique index                   | ~220     |
| `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts`                      | Integration — Redis + BullMQ, retry + DLQ                                       | ~260     |
| `apps/runtime/src/__tests__/integration/agent-assist-session-lifecycle.int.test.ts`                    | Integration — `endSession` path                                                 | ~150     |
| `apps/runtime/src/__tests__/routes/agent-assist.e2e.test.ts`                                           | E2E — sync, SSE, cross-tenant 404, kill-switch, callback-URL rejection          | ~400     |
| `apps/runtime/src/__tests__/routes/agent-assist-async.e2e.test.ts`                                     | E2E — async-push end-to-end with HMAC verification                              | ~200     |
| `apps/runtime/src/__tests__/routes/agent-assist-lifecycle.e2e.test.ts`                                 | E2E — full V1 lifecycle parity (gate for BETA)                                  | ~260     |
| _admin CRUD integration + unit tests — superseded by the `-proxy` variants above (D-15 proxy pattern)_ |                                                                                 |          |
| `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/sessions-request.json`              | Recorded widget `/sessions` body                                                | fixture  |
| `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/sessions-response.json`             | Expected `/sessions` response shape                                             | fixture  |
| `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/execute-request.json`               | Recorded widget `/runs/execute` body                                            | fixture  |
| `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/callback-response.json`             | Expected async callback envelope                                                | fixture  |
| `apps/runtime/src/__tests__/helpers/agent-assist/seed.ts`                                              | `seedBinding`, `seedBindingViaAdminAPI`, `seedApiKey`                           | ~120     |
| `apps/runtime/src/__tests__/helpers/agent-assist/callback-sink.ts`                                     | Local HTTP sink server for async-push E2E                                       | ~80      |

### 2.2 Modified Files

| File                                                                             | Change description                                                                                                                                                                                                                                                                                                 | Risk                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `apps/runtime/src/server.ts`                                                     | Mount line already exists from POC (`app.use('/api/v2/apps', createAgentAssistRouter())`). NO CHANGE.                                                                                                                                                                                                              | None                                                                                                                                                                                 |
| `apps/runtime/src/routes/agent-assist.ts`                                        | Replace POC env-seeded resolver wiring with repo-backed binding; add `requirePermission('session:send_message')` middleware; add `feature-gate` middleware; add `tenantRateLimit('request')`; tighten `/sessions/terminate` to call `RuntimeExecutor.endSession`; emit `agent_assist.*` trace events at each step. | Low                                                                                                                                                                                  |
| `apps/runtime/src/routes/agent-assist.schemas.ts`                                | Widen accepted `sessionIdentity.type` enum if needed (kore.ai doc already covered); tighten `callbackUrl` to absolute URL validation; validate `aa_uamsgs` element shape.                                                                                                                                          | Low                                                                                                                                                                                  |
| `apps/runtime/src/services/agent-assist/binding-resolver.ts`                     | Split into two implementations: `EnvSeededResolver` (POC, behind `AGENT_ASSIST_SEED_MODE=env`) and `MongoBindingResolver` (default). Factory picks at boot.                                                                                                                                                        | Medium                                                                                                                                                                               |
| `apps/runtime/src/services/agent-assist/metadata-normalizer.ts`                  | Change return type from `{ forward: Record<string,unknown>, history: any[] }` to `{ messageMetadata: SdkMessageMetadata                                                                                                                                                                                            | undefined, history: Array<{role,text}> }`. Filter forward keys to the allowlist (`conversationId`, `botId`, `language`, `source`) + validate against `SdkMessageMetadata` sanitizer. | Medium |
| `apps/runtime/src/services/agent-assist/callback-sender.ts`                      | Rewrite into thin wrapper around BullMQ enqueue. Retain dev-only sync fallback gated on `AGENT_ASSIST_CALLBACK_SYNC=true`.                                                                                                                                                                                         | Medium                                                                                                                                                                               |
| `apps/runtime/src/services/agent-assist/execution-bridge.ts`                     | Read binding via the resolver abstraction (not env var directly). Update `_agentAssist.source` tag to `"agent_assist_v1"` (FR-30).                                                                                                                                                                                 | Low                                                                                                                                                                                  |
| `apps/runtime/src/services/agent-assist/placeholder-responder.ts`                | Guard so that placeholder path is only reachable when `binding.status === "placeholder"` (env-seeded resolver only) OR `AGENT_ASSIST_FORCE_PLACEHOLDER=true`.                                                                                                                                                      | Low                                                                                                                                                                                  |
| `apps/runtime/src/services/agent-assist/constants.ts`                            | Add BullMQ queue names, HMAC env var name, `AGENT_ASSIST_SEED_MODE`, remove stale POC-only constants.                                                                                                                                                                                                              | Low                                                                                                                                                                                  |
| `apps/runtime/src/services/agent-assist/trace-events.ts` (new helper)            | Small wrapper around `TraceStore.addEvent` typed to the `agent_assist.*` family.                                                                                                                                                                                                                                   | Low                                                                                                                                                                                  |
| `packages/database/src/models/index.ts`                                          | Export `AgentAssistBinding` from the barrel.                                                                                                                                                                                                                                                                       | Low                                                                                                                                                                                  |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`                   | Extend with new `agent_assist` domain group per D-14 (6-step pattern). Events: `.received`, `.binding_resolved`, `.delegated`, `.translated_response`, `.error`, `.callback_scheduled`, `.callback_delivered`, `.callback_failed`. All 8 added to `RUNTIME_EVENT_TYPES` (runtime-emitted).                         | Low                                                                                                                                                                                  |
| `packages/shared-kernel/src/index.ts`                                            | Re-export `LRUTTLCache` from new `cache/` subpath.                                                                                                                                                                                                                                                                 | Low                                                                                                                                                                                  |
| `apps/admin/src/lib/audit-logger.ts`                                             | Extend `AdminAction` union with 5 new members (`compat_binding_create`/`_update`/`_disable`/`_enable`/`_delete`). No shape or function-signature change.                                                                                                                                                           | Low                                                                                                                                                                                  |
| `apps/runtime/src/services/agent-assist/types.ts`                                | Update `AgentAssistBinding` TS interface to match `IAgentAssistBinding` model. Remove `"placeholder"` status from persisted type, keep a separate `EnvSeededBinding` type for POC path.                                                                                                                            | Low                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/services/agent-assist/placeholder-responder.test.ts` | Update test names + JSDoc to describe canary role (no longer the default behaviour).                                                                                                                                                                                                                               | Low                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/services/agent-assist/metadata-normalizer.test.ts`   | Update tests for the new return shape (`messageMetadata` sanitized subset).                                                                                                                                                                                                                                        | Low                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/services/agent-assist/envelope-builder.test.ts`      | Extend cases to cover error envelope with `sessionInfo.status:"error"`.                                                                                                                                                                                                                                            | Low                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/services/agent-assist/binding-resolver.test.ts`      | Split: keep env-seeded cases; add Mongo-backed cases (moves to integration test).                                                                                                                                                                                                                                  | Low                                                                                                                                                                                  |
| `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts`                   | Change stub auth to assert `session:send_message` permission (was `agent_suggestions:execute` placeholder). Update expected `_agentAssist.source` to `"agent_assist_v1"`.                                                                                                                                          | Low                                                                                                                                                                                  |
| `apps/runtime/src/server.ts`                                                     | Register `agent-assist-callback-worker` inside `wireAsyncInfra()` Redis branch (alongside `startResumptionWorker` at ~line 1522 and `startSuspensionTimeoutWorker` at ~line 1534). Also append one mount line at lines 987-1001 for `/api/platform/admin/agent-assist` (D-15).                                     | Low                                                                                                                                                                                  |

### 2.3 Deleted Files

None. All POC files either stay unchanged, receive additive edits, or are renamed inline. No exported symbol removal.

---

## 3. Implementation Phases

Each phase is independently deployable (the `agent_assist` feature flag stays off until all phases ship; per-phase tests must pass before the next phase starts). The feature is rollable-back at any point by disabling the flag.

### Phase 1: Data layer — `AgentAssistBinding` model + repo

**Goal**: Persist bindings in MongoDB, behind the same `tenantIsolationPlugin` pattern every other tenant-scoped collection uses, with an in-process read cache that is never authoritative.

**Tasks**:

1.1. Create Mongoose model `packages/database/src/models/agentAssistBinding.ts` (fields, indexes, `tenantIsolationPlugin`, audit-trail plugin). Export from `packages/database/src/models/index.ts` barrel.

1.2. **Prerequisite for 1.2** — create `packages/shared-kernel/src/cache/lru-ttl-cache.ts` first (D-11):

- `LRUTTLCache<V>` class implementing `Map<string, V>`-style `get/set/has/delete/clear/size`.
- Options: `{ maxEntries: number; ttlMs: number; now?: () => number }`. `now` is DI for deterministic tests.
- `get(key)` returns `undefined` if entry is expired (lazy eviction) AND when the entry is physically evicted by max-size.
- `set(key, value)` evicts least-recently-used entry when size would exceed `maxEntries`. Insertion-order `Map` semantics for LRU tracking.
- Export via new `packages/shared-kernel/src/cache/index.ts` barrel and re-export from `packages/shared-kernel/src/index.ts`.
- Unit tests at `packages/shared-kernel/src/cache/__tests__/lru-ttl-cache.test.ts`: size eviction in insertion order, TTL expiry via injected clock, no double-eviction on re-`set`, `clear()` empties, `delete()` returns bool.

  1.2b. Create repo `apps/runtime/src/repos/agent-assist-binding-repo.ts` implementing `AgentAssistBindingResolver`. Include:

- CRUD methods with explicit `tenantId` filters (belt-and-braces with plugin).
- **Bounded LRU+TTL read cache** via `new LRUTTLCache<IAgentAssistBinding>({ maxEntries: AGENT_ASSIST_BINDING_CACHE_MAX, ttlMs: AGENT_ASSIST_BINDING_CACHE_TTL_MS })`. Keys are `${tenantId}:${appId}:${environment.toLowerCase()}`. Named constants: `AGENT_ASSIST_BINDING_CACHE_MAX=500`, `AGENT_ASSIST_BINDING_CACHE_TTL_MS=60_000`. CLAUDE.md Core Invariant: every in-memory `Map` needs max size, TTL, and eviction.
- Cache invalidation on `create / update / setStatus / remove`.
- `remove` is hard-delete (disable via `setStatus("disabled")` when operators want to keep the record).
- Surface duplicate-key E11000 as a typed error `AgentAssistBindingDuplicateError`.
- Export a `cascadeOnProjectDelete(tenantId, projectId)` method — wired into the project-delete pipeline in Phase 5 task 5.7b.

  1.3. Unit tests: `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts` (cache TTL / invalidation / duplicate handling).

  1.4. Integration tests: `apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts` — real Mongo via `mongodb-memory-server`, verify `tenantIsolationPlugin` floor, unique index, audit-trail-plugin entries.

**Files touched**:

- `packages/shared-kernel/src/cache/lru-ttl-cache.ts` (new)
- `packages/shared-kernel/src/cache/index.ts` (new barrel)
- `packages/shared-kernel/src/cache/__tests__/lru-ttl-cache.test.ts` (new)
- `packages/shared-kernel/src/index.ts` (append re-export of `LRUTTLCache`)
- `packages/database/src/models/agentAssistBinding.ts` (new)
- `packages/database/src/models/index.ts` (append export)
- `apps/runtime/src/repos/agent-assist-binding-repo.ts` (new)
- Unit + integration test files.

**Exit criteria**:

- [ ] `pnpm build --filter @agent-platform/shared-kernel` succeeds with 0 errors.
- [ ] `pnpm build --filter @agent-platform/database` succeeds with 0 errors.
- [ ] `pnpm build --filter @agent-platform/runtime` succeeds with 0 errors.
- [ ] `npx vitest run packages/shared-kernel/src/cache/__tests__/lru-ttl-cache.test.ts` — all tests pass (eviction order, TTL expiry, clock injection).
- [ ] `npx vitest run apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts` — all tests pass.
- [ ] `npx vitest run apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts` — all tests pass.
- [ ] Unique index `(tenantId, appId, environment)` present in the deployed collection (verified by integration test inspecting `collection.indexes()`).
- [ ] Repo never returns a row whose `tenantId` does not match the caller's `ctx.tenantId` (covered by the `tenantIsolationPlugin` floor test).
- [ ] Cache respects `AGENT_ASSIST_BINDING_CACHE_MAX` (eviction verified) AND `AGENT_ASSIST_BINDING_CACHE_TTL_MS` (expiry verified) — asserted via the binding-repo unit test using the `LRUTTLCache` clock-injection hook.

**Test strategy**:

- Unit: repo cache + duplicate-key translation (pure functions against a mock Mongoose collection injected via DI).
- Integration: real Mongo; verify plugin-level tenant isolation and index enforcement.

**Rollback**: delete the new files. Collection is orphaned but does not affect any existing code path (nothing references it yet).

---

### Phase 2: Admin CRUD surface — PROXY pattern (runtime-backed + Next.js admin proxy)

**Goal**: Operators create, list, update, disable, enable, and delete bindings through a super-admin-authenticated surface that proxies to runtime. Per D-15 this matches every existing admin tenant-scoped route.

**Architecture** (D-15):

```
[Admin Next.js App Router]  ──withAdminRoute──▶  [logAdminAction]  ──fetch──▶  [Runtime /api/platform/admin/agent-assist/...]
                                                                                       │
                                                                                       ▼
                                                               [platformAdminAuthMiddleware]
                                                                                       │
                                                                                       ▼
                                                                [AgentAssistBindingResolver (Phase 1)]
                                                                                       │
                                                                                       ▼
                                                                                    [Mongo]
```

**Tasks**:

2.0. **Runtime-side admin route** — create `apps/runtime/src/routes/platform-admin-agent-assist.ts` following the `platform-admin-*.ts` convention (12 existing siblings at `apps/runtime/src/routes/`, each mounted under `/api/platform/admin/...`). Structure:

```ts
const router = Router();
router.use(platformAdminAuthMiddleware); // enforces super-admin, populates req.user
router.get('/tenants/:tenantId/bindings', listBindingsHandler);
router.post('/tenants/:tenantId/bindings', createBindingHandler);
router.get('/tenants/:tenantId/bindings/:bindingId', getBindingHandler);
router.patch('/tenants/:tenantId/bindings/:bindingId', updateBindingHandler);
router.post('/tenants/:tenantId/bindings/:bindingId/disable', disableBindingHandler);
router.post('/tenants/:tenantId/bindings/:bindingId/enable', enableBindingHandler);
router.delete('/tenants/:tenantId/bindings/:bindingId', deleteBindingHandler);
```

Handlers call `AgentAssistBindingResolver` (the Phase-1 repo) and return `{ success: true, data }` or `{ success: false, error: { code, message } }`. No cache side-effects beyond the repo's own invalidation.

Mount in `server.ts` alongside the other `/api/platform/admin/...` routes (between lines 987-1001 per existing convention — add `app.use('/api/platform/admin/agent-assist', createPlatformAdminAgentAssistRouter())`).

2.0b. **Admin Next.js thin-proxy routes** — each route file is a proxy handler:

```ts
// apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/route.ts
export const POST = withAdminRoute({ role: 'ADMIN' }, async (ctx: AdminRouteContext) => {
  const { tenantId } = ctx.params;
  const body = await ctx.request.json();
  const res = await fetch(
    `${getRuntimeBaseUrl()}/api/platform/admin/agent-assist/tenants/${encodeURIComponent(tenantId)}/bindings`,
    { method: 'POST', headers: buildRuntimeHeaders(ctx), body: JSON.stringify(body) },
  );
  const data = await res.json();
  if (res.ok) {
    // Audit only on successful runtime response. Fail-closed on audit error.
    await logAdminAction({
      actor: ctx.user.userId,
      actorRole: ctx.user.role,
      action: 'compat_binding_create',
      target: `tenants/${tenantId}/agent-assist/bindings/${data?.data?._id ?? 'unknown'}`,
      ipAddress: ctx.user.ipAddress,
      metadata: { response: data },
    });
  }
  return NextResponse.json(data, { status: res.status });
});
```

Helper imports: `getRuntimeBaseUrl` and `buildRuntimeHeaders` from `apps/admin/src/lib/runtime-proxy.ts` (exact pattern in `feature-toggle/route.ts`). `logAdminAction` from `apps/admin/src/lib/audit-logger.ts`. `withAdminRoute` from `apps/admin/src/lib/with-admin-route.ts`.

2.0c. **Extend the `AdminAction` union at `apps/admin/src/lib/audit-logger.ts:9-15`** — append 5 members (`compat_binding_create`, `compat_binding_update`, `compat_binding_disable`, `compat_binding_enable`, `compat_binding_delete`). One-line-per-member additive change. Rationale: `AdminAction` is a closed union and the Next.js proxies will not type-check if they attempt unregistered strings.

2.1. Create Zod strict schemas at two locations (both `.strict()`, both use `z.string().min(1)` for ID fields per CLAUDE.md convention):

- `apps/runtime/src/routes/platform-admin-agent-assist.schemas.ts` — `CreateBindingBody`, `UpdateBindingBody`. `UpdateBindingBody` rejects `tenantId`, `appId`, `environment`.
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/schemas.ts` — optional mirror for pre-flight syntax validation at the admin surface (keeps error responses symmetrical); handler still relays runtime's authoritative validation result.

  2.2. Admin proxy: `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/route.ts` (POST = create, GET = list). Both use `withAdminRoute({ role: 'ADMIN' }, ...)`. POST audits with `action: 'compat_binding_create'`. GET does NOT audit (reads aren't auditable mutations).

  2.3. Admin proxy: `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/route.ts` — GET (detail), PATCH (update), DELETE. PATCH audits `action: 'compat_binding_update'` with `metadata: { response: data }`. DELETE audits `action: 'compat_binding_delete'`. Runtime computes `before`/`after` and returns both in the response `data` so the audit log captures the diff server-side.

  2.4. Admin proxies: `[bindingId]/disable/route.ts` and `[bindingId]/enable/route.ts` as single-verb `POST` handlers. Each calls the runtime `disable`/`enable` endpoint and audits with the matching `AdminAction`.

  2.5. Runtime-side integration tests `apps/runtime/src/__tests__/routes/platform-admin-agent-assist.int.test.ts` — real Express server on `port:0`, real Mongo via `mongodb-memory-server`, real `platformAdminAuthMiddleware`. Cases: full CRUD; super-admin can cross-tenant read (matches D-13 posture); immutable PATCH rejected; duplicate-key E11000 → 409; non-admin JWT → 403.

  2.6. Admin proxy integration tests `apps/admin/src/__tests__/agent-assist-bindings-proxy.int.test.ts` — mount the Next.js route handlers against a runtime test-double HTTP server (`http.createServer` returning canned JSON). Cases: super-admin → audit entry written + response relayed; non-admin → `withAdminRoute` rejects with 401/403; runtime 5xx → relayed with status + NO audit entry; audit-logger throws → HTTP 500 + runtime response not silently dropped.

  2.7. Unit tests `apps/admin/src/__tests__/agent-assist-bindings-proxy.unit.test.ts` — audit-failure fail-closed logic tested against an injected logger stub (DI, not `vi.mock`); schema pre-flight rejection tests.

**Files touched**:

- `apps/runtime/src/routes/platform-admin-agent-assist.ts` (new)
- `apps/runtime/src/routes/platform-admin-agent-assist.schemas.ts` (new)
- `apps/runtime/src/server.ts` (append mount alongside the other `/api/platform/admin/*` mounts at lines 987-1001)
- `apps/admin/src/lib/audit-logger.ts` (append 5 members to `AdminAction` union)
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/schemas.ts` (new)
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/route.ts` (new — proxy)
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/route.ts` (new — proxy)
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/disable/route.ts` (new — proxy)
- `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/enable/route.ts` (new — proxy)
- Integration + unit test files at both runtime and admin.

**Exit criteria**:

- [ ] `pnpm build --filter @agent-platform/runtime` and `pnpm build --filter @agent-platform/admin` both succeed with 0 errors.
- [ ] Runtime mount: `grep -n "/api/platform/admin/agent-assist" apps/runtime/src/server.ts` shows exactly one mount line.
- [ ] `AdminAction` union at `apps/admin/src/lib/audit-logger.ts` contains the 5 new members, and `tsc --noEmit` on the admin app passes.
- [ ] All four mutating proxy handlers emit exactly one `logAdminAction` entry on the 2xx path, zero on the 4xx/5xx path (integration test asserts against the `audit_log` collection).
- [ ] Every admin route export is `withAdminRoute({ role: 'ADMIN' }, handler)` — verified by grep + tsc.
- [ ] Runtime handlers enforce tenant isolation: a query for a binding belonging to `tenantA` via path `/tenants/tenantB/bindings/...` returns HTTP 404 (the repo filter includes `tenantId`, so the DB returns null) — integration-test assertion.
- [ ] Duplicate-key E11000 surfaces as HTTP 409 `{ success: false, error: { code: 'BINDING_DUPLICATE' } }` at the runtime, relayed by the admin proxy.
- [ ] Audit-failure fail-closed: if `logAdminAction` throws AFTER the runtime already mutated state, the proxy returns HTTP 500 `{ success: false, error: { code: 'AUDIT_FAILURE' } }` — documented as "audit lag with already-persisted binding" per D-13. Alerting task is logged as follow-up.
- [ ] Non-admin JWT at the runtime endpoint: `platformAdminAuthMiddleware` returns HTTP 403 `INSUFFICIENT_PRIVILEGES` — integration-test assertion.

**Test strategy**:

- Unit: schema validation + audit-fail fail-closed logic via DI stubs (not `vi.mock`).
- Integration (runtime side): real Express + real Mongo + real `platformAdminAuthMiddleware`.
- Integration (admin side): real Next.js route handler + runtime test-double HTTP server + real `audit_log` Mongo collection.

**Rollback**: delete the new `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/` directory and the runtime route module + its mount line. Existing admin and runtime routes are unaffected. The `AdminAction` union revert is also safe (no external consumer).

---

### Phase 3: Runtime facade upgrade — feature gate, permission, trace events, metadata tightening, terminate wiring

**Goal**: The facade route handler uses production-grade middleware, the real permission scope, the Mongo-backed resolver, real `RuntimeExecutor.endSession` for terminate, emits registered trace events, and enforces FR-20 metadata sanitization.

**Tasks**:

3.1. **DO NOT modify `packages/shared-kernel/src/constants/plan-features.ts`** for initial rollout. Per D-7, `requireFeature` resolves `Deal.features[]` first; the pilot tenant is granted `agent_assist` via a Deal record. Once the feature is GA and should flow to a plan tier, a follow-up change appends `'agent_assist'` to `PLAN_FEATURES.ENTERPRISE` (or the appropriate tier). This task is intentionally a no-op for Phase Actual — documented to prevent a reviewer from asking why the plan-features file is untouched.

3.2. **Register the `agent_assist` trace-event domain group** per D-14 (the full 6-step pattern, verified against the 20 existing domain groups in the registry). In `packages/shared-kernel/src/constants/trace-event-registry.ts`:

1. Add const array (near the other domain constants):
   ```ts
   export const AGENT_ASSIST_TRACE_EVENT_TYPES = [
     'agent_assist.received',
     'agent_assist.binding_resolved',
     'agent_assist.delegated',
     'agent_assist.translated_response',
     'agent_assist.error',
     'agent_assist.callback_scheduled',
     'agent_assist.callback_delivered',
     'agent_assist.callback_failed',
   ] as const;
   export type AgentAssistTraceEventType = (typeof AGENT_ASSIST_TRACE_EVENT_TYPES)[number];
   ```
2. Add `agent_assist: AGENT_ASSIST_TRACE_EVENT_TYPES` to `TRACE_EVENT_GROUPS` (keeps `keyof typeof TRACE_EVENT_GROUPS` up-to-date).
3. Spread `...AGENT_ASSIST_TRACE_EVENT_TYPES` into `ALL_TRACE_EVENT_TYPES` so `TraceEventType` union includes them.
4. Spread the same into `RUNTIME_EVENT_TYPES` — all 8 are runtime-emitted (the callback worker runs inside the runtime process).
5. Spread `...registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES)` into `TRACE_EVENT_REGISTRY` so Observatory + Trace UI enumerate them.
6. Unit test (optional but recommended): a snapshot test on `TRACE_EVENT_REGISTRY['agent_assist.received']` to prevent registry drift.

3.3. Create `apps/runtime/src/services/agent-assist/trace-events.ts` — typed helper around `TraceStore.addEvent` for the family. Call sites in `routes/agent-assist.ts` use the helper.

3.4. Rewrite `apps/runtime/src/services/agent-assist/binding-resolver.ts`: - Export `createBindingResolver({ mode, env })` factory — reads `AGENT_ASSIST_SEED_MODE`. - `"env"` → existing `EnvSeededResolver` (keep current class, rename for clarity). - default → `MongoBindingResolver` wrapping the Phase-1 repo.

3.5. Rewrite `apps/runtime/src/services/agent-assist/metadata-normalizer.ts` to return `SdkMessageMetadata`-safe subset. Allowlist: `conversationId`, `botId`, `language`, `source`. All other keys land in `_agentAssist.opaqueMetadata` (stored on session metadata, NOT forwarded to `executeMessage`). Update unit tests for new shape (FR-20).

3.6. Rewrite `apps/runtime/src/services/agent-assist/execution-bridge.ts`: - Update `_agentAssist.source` from `"agent_suggestions"` → `"agent_assist_v1"` (FR-30). - Forward ONLY the sanitized `messageMetadata` returned from the normalizer to `executor.executeMessage`.

3.7. Rewrite `apps/runtime/src/routes/agent-assist.ts`:

- Router middleware chain: `json(size_cap)` → `authMiddleware` (the facade-level wrapper at `apps/runtime/src/middleware/auth.ts:194-202` that composes `unifiedAuth` + `requireAuthenticatedRequest` + `requireTenantContextMiddleware` — this is the chain the POC already uses and what `channel-connections.ts:54` uses) → kill-switch (`AGENT_ASSIST_ENABLED` env check, short-circuits to 404) → `requireFacadeFeature('agent_assist')` (see task 3.7b) → `tenantRateLimit('request')` → `requirePermission('session:send_message')` → `resolveAndAuthorizeBinding` → handler.
- Kill-switch `AGENT_ASSIST_ENABLED` retained as a belt-and-braces guard above the feature gate (short-circuits to 404 before the feature-gate middleware even runs).
- Sync handler: emit `agent_assist.received` at entry; `agent_assist.binding_resolved` after resolution; `agent_assist.delegated` before executor call; `agent_assist.translated_response` on success OR `agent_assist.error` on failure.
- SSE handler: same sequence with delta frames; emit heartbeat per `AGENT_ASSIST_SSE_HEARTBEAT_MS`.
- Terminate handler: call `getRuntimeExecutor().endSession(sessionId)`, swallow + log any error (fire-and-forget per V1 contract), always return the terminate envelope.

  3.7b. Create `apps/runtime/src/services/agent-assist/feature-gate.ts` — `requireFacadeFeature(featureName)` wrapper. Uses the same resolution primitives as `apps/runtime/src/middleware/feature-gate.ts` (reads `Deal.features[]` then `PLAN_FEATURES[planTier]` via the existing Deal + Subscription queries), but with facade-specific response semantics:

- **Status code**: on feature-not-granted, return `404 { success: false, error: { code: 'APP_NOT_FOUND' }}` (matches the cross-tenant 404 and binding-not-found 404 — existence-disclosure invariant). `requireFeature` returns 403 `FEATURE_NOT_AVAILABLE` (line 119 of the existing middleware); this wrapper does NOT call `requireFeature` but re-uses the resolver's Deal + Subscription read helpers (factor them into `apps/runtime/src/middleware/feature-gate.ts` if they are inlined today) to avoid double-response via middleware chaining.
- **Failure mode**: on DB error (Deal/Subscription query throws), fail CLOSED with `404 APP_NOT_FOUND`. Existing `requireFeature` fails open (line 126-132); our wrapper catches, logs at `warn`, and short-circuits to 404. Alternative `createFailClosedFeatureGate` returns 503 — too loud for a facade that must impersonate "app does not exist".

Unit test: `apps/runtime/src/__tests__/services/agent-assist/feature-gate.test.ts` — 4 scenarios: (1) feature on via Deal → `next()`, (2) feature on via plan tier → `next()`, (3) feature off → 404 `APP_NOT_FOUND`, (4) DB error in Deal.find → 404 `APP_NOT_FOUND`. Belt-and-braces: even though binding-resolver returns 404 on missing binding, the feature-gate wrapper closes the gap where feature is off for a tenant but the binding exists.

3.8. Retire the placeholder default: update `execution-bridge.ts` to invoke the placeholder responder ONLY when `binding.status === "placeholder"` (env-seeded) OR `AGENT_ASSIST_FORCE_PLACEHOLDER=true`. Mongo-backed bindings with `status:"active"` always go through `DeploymentResolver` + `executeMessage`.

3.9. Unit tests: `apps/runtime/src/__tests__/services/agent-assist/v1-sse-emitter.test.ts` (new), `session-envelope.test.ts` (new), and updates to `metadata-normalizer.test.ts`, `envelope-builder.test.ts`, `placeholder-responder.test.ts`, `route.test.ts`.

3.10. Integration tests: `agent-assist-execution-bridge.int.test.ts` (FR-17/18/20), `agent-assist-session-lifecycle.int.test.ts` (FR-9 terminate wiring).

3.11. E2E tests: `agent-assist.e2e.test.ts` (E2E-1 / E2E-2 / E2E-3 / E2E-6 / E2E-7). `agent-assist-lifecycle.e2e.test.ts` (E2E-5 parity fixture — gate for BETA promotion, stubs allowed for the recorded fixture set).

**Files touched**:

- `packages/shared-kernel/src/constants/trace-event-registry.ts` (extend per D-14, 6-step pattern)
- `apps/runtime/src/services/agent-assist/trace-events.ts` (new typed helper)
- `apps/runtime/src/services/agent-assist/feature-gate.ts` (new — 403→404, fail-closed wrapper)
- `apps/runtime/src/services/agent-assist/binding-resolver.ts` (rewrite to factory)
- `apps/runtime/src/services/agent-assist/metadata-normalizer.ts` (rewrite return shape)
- `apps/runtime/src/services/agent-assist/execution-bridge.ts` (metadata + tag update)
- `apps/runtime/src/services/agent-assist/placeholder-responder.ts` (canary-only guard)
- `apps/runtime/src/services/agent-assist/constants.ts` (new env vars)
- `apps/runtime/src/services/agent-assist/types.ts` (interface sync)
- `apps/runtime/src/routes/agent-assist.ts` (rewrite chain)
- `apps/runtime/src/routes/agent-assist.schemas.ts` (tighten)
- `apps/runtime/src/middleware/feature-gate.ts` (factor out Deal + Subscription read helpers so the facade wrapper can reuse them without double-response — additive export of `resolveFeatureForTenant(tenantId, featureName)`)
- POC tests updated + 3 new unit test files (feature-gate, v1-sse-emitter, session-envelope) + 2 new integration test files + 2 new E2E test files.

**Invariant — no `PLAN_FEATURES` change.** Per D-7 and task 3.1, the `agent_assist` slug is resolved via Deal grants for pilot rollout. `packages/shared-kernel/src/constants/plan-features.ts` is not modified in Phase Actual.

**Exit criteria**:

- [ ] `pnpm build --filter @agent-platform/runtime` succeeds with 0 errors.
- [ ] With `agent_assist` feature flag OFF for the test tenant, all facade requests return `404 APP_NOT_FOUND` byte-identical to cross-tenant 404 (E2E-6 passing).
- [ ] With flag ON and valid binding, sync `/runs/execute` returns HTTP 200 V1 envelope (E2E-1 passing).
- [ ] SSE streaming emits frame sequence with heartbeat and terminal `isLastEvent:true` (E2E-3 passing).
- [ ] `/sessions/terminate` invokes `RuntimeExecutor.endSession` exactly once per request AND returns success envelope even on unknown sessionId (INT-5 passing).
- [ ] `TraceStore` records every `agent_assist.*` event from FR-29 for a happy-path request.
- [ ] `callerContext` carries ONLY `{tenantId, channel:"api", initiatedById, identityTier:0, verificationMethod:"none"}` — facade-specific data lives under `session.data.values._metadata._agentAssist` (INT-1 passing).
- [ ] `metadata-normalizer` returns `SdkMessageMetadata`-safe shape; raw V1 `metadata` is NOT reachable from `executor.executeMessage`'s `messageMetadata` parameter (INT-1 assertion).

**Test strategy**:

- Unit: pure-function tests for each translator + emitter + normalizer (no mocks of internal packages).
- Integration: real executor + DI-injected LLM double; real Mongo; `TraceStore` capture helper asserts event sequence.
- E2E: real HTTP on `port:0`, real middleware chain, real trace store; DI LLM double used only for deterministic turns.

**Rollback**: disable `agent_assist` feature flag for all tenants. Route still returns 404 globally; any in-flight sessions will fail on next turn (fail-safe). Code rollback: revert Phase 3 commits; Phase 1 + 2 remain deployable.

---

### Phase 4: Async-push BullMQ worker + HMAC signing + DLQ

**Goal**: Replace POC fire-and-forget async-push with a durable BullMQ worker that retries on failure, signs bodies with HMAC, and moves terminal failures to a DLQ.

**Tasks**:

4.1. Create `apps/runtime/src/services/agent-assist/hmac.ts` — pure `sign(body, secret, now)` and `verify(body, header, secret, now, grace)` functions; `t=,v1=` format; 5-minute validity window.

4.2. Unit tests: `apps/runtime/src/__tests__/services/agent-assist/hmac.test.ts` — round-trip, bit-flip, clock-skew grace window.

4.3. Rewrite `apps/runtime/src/services/agent-assist/callback-sender.ts` into a thin enqueue wrapper. Retain a dev-only sync fallback gated behind `AGENT_ASSIST_CALLBACK_SYNC=true`.

4.4. Create `apps/runtime/src/jobs/agent-assist-callback-worker.ts`:

- Consumes `agent-assist-callback` queue.
- Replays `executeTurn(binding, input, ...)` to produce the full envelope (same in-process path as sync).
- Signs envelope body with HMAC via `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` (KMS-resolved).
- POSTs `callbackUrl` with headers `Content-Type`, `User-Agent: abl-agent-assist/<version>`, `X-ABL-Source: agent-assist-v1`, `X-ABL-Signature: t=<ts>,v1=<hex>`.
- URL allowlist: absolute HTTPS, or `http://localhost` only. Non-matches → refused + logged + DLQ.
- Retry: exponential backoff 1 s → 30 s cap, max 5 attempts.
- On final failure: move job to `agent-assist-callback-dlq` with full request/response trail (all attempts).
- Emit `agent_assist.callback_scheduled` on enqueue, `agent_assist.callback_delivered` on success, `agent_assist.callback_failed` on terminal failure.

**BullMQ worker / queue options (explicit)**:

```ts
// Queue options (producer side):
new Queue('agent-assist-callback', {
  connection,
  defaultJobOptions: {
    attempts: 5, // HLD §6 + test-spec INT-3: "max 5 attempts" = 1 initial + 4 retries
    backoff: { type: 'exponential', delay: 1000 }, // delays between attempts: 1 → 2 → 4 → 8 s (max observed 8 s before attempt 5; no 30-s clamp reached)
    removeOnComplete: { count: 100, age: 86400 }, // keep 100 OR 1 day, whichever is smaller
    removeOnFail: false, // retained for DLQ visibility; DLQ sweeper moves to separate queue
  },
});

// Worker options (consumer side):
new Worker('agent-assist-callback', handler, {
  connection,
  concurrency: AGENT_ASSIST_CALLBACK_WORKER_CONCURRENCY, // default 4 per pod
  lockDuration: 30_000, // must exceed callback POST timeout (10 s) + envelope build time
  maxStalledCount: 2, // BullMQ default; ok
});
```

`lockDuration` of 30 s is deliberate: the callback HTTP POST has a 10 s AbortController timeout, and envelope build (executor replay) can take up to ~15 s under load; 30 s gives headroom without risking phantom duplicate execution. Concurrency of 4 per pod keeps worker CPU under 60% per the test-spec load budget. With 5 attempts (1 initial + 4 retries) and exponential delays 1/2/4/8 s, worst-case total wallclock before DLQ ≈ 15 s of backoff + up to 50 s of POST+replay per attempt = ~4 minutes if every attempt times out — INT-3 asserts this envelope.

4.5. Register worker in the runtime's BullMQ bootstrap — add the call inside `apps/runtime/src/server.ts::wireAsyncInfra()` (function signature at server.ts:1313, Redis branch at ~lines 1394-1555). `apps/runtime/src/index.ts` only calls `startServer()` and has no worker startup code; workers are started inside `wireAsyncInfra` alongside `startResumptionWorker` (~line 1522-1525) and `startSuspensionTimeoutWorker` (~line 1534-1541). Wrap in the same try/catch + `asyncInfraLog.warn` pattern used by those calls. Skipping this step means the worker never consumes jobs even though they enqueue — async callbacks stall silently. Gate behind the Redis availability check at lines 1319-1321 so in-memory deployments fall back to the POC sync path (`AGENT_ASSIST_CALLBACK_SYNC=true`).

4.6. Update route handler (Phase 3 output): `/runs/execute` with `isAsync:true` now calls the enqueue wrapper. Sync HTTP 202 response is built from the already-resolved binding + `sessionInfo.status:"processing"`.

4.7. Unit tests: `apps/runtime/src/__tests__/jobs/agent-assist-callback-worker.test.ts` — retry backoff math, URL allowlist, HMAC header build, DLQ migration logic.

4.8. Integration tests: `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts` — real Redis + BullMQ, HTTP sink server, 2xx-happy path + 5xx-retries-then-DLQ path.

4.9. E2E test: `agent-assist-async.e2e.test.ts` (E2E-4) — full sync 202 + HMAC-verified callback delivery with bit-flip subcheck (step 5).

**Files touched**:

- `apps/runtime/src/services/agent-assist/hmac.ts` (new)
- `apps/runtime/src/services/agent-assist/callback-sender.ts` (rewrite)
- `apps/runtime/src/jobs/agent-assist-callback-worker.ts` (new)
- `apps/runtime/src/server.ts` (register worker inside `wireAsyncInfra()` Redis branch; NOT `index.ts`)
- `apps/runtime/src/routes/agent-assist.ts` (route branches on `isAsync`)
- Unit + integration + E2E test files.

**Exit criteria**:

- [ ] `pnpm build --filter @agent-platform/runtime` succeeds with 0 errors.
- [ ] Async-push sync response is HTTP 202 with minimal `processing` envelope (FR-6 / E2E-4).
- [ ] Callback POST to test sink within 10 s carries valid HMAC verifiable against fixture secret (E2E-4 step 4).
- [ ] Bit-flipped body fails HMAC verification at the sink (E2E-4 step 5).
- [ ] 5xx from sink → 5 attempts with exp. backoff observed (INT-3 case A).
- [ ] Terminal failure → job lands in `agent-assist-callback-dlq` with full trail (INT-3 case B); `agent_assist.callback_failed` trace emitted.
- [ ] Relative `callbackUrl` is refused at enqueue time with `invalid_url` logged; non-localhost plain HTTP refused with `http_only_allowed_for_localhost` logged (E2E-7 passing).
- [ ] Missing `callbackUrl` with `isAsync:true` → HTTP 400 `CALLBACK_URL_REQUIRED` before enqueue (E2E-7 subcheck 1).

**Test strategy**:

- Unit: HMAC pure functions + URL allowlist + retry-backoff math (no mocks).
- Integration: real Redis + BullMQ + local HTTP sink; verifies worker pod can restart mid-flight and continue.
- E2E: sync + async + signature verification via shared fixture secret.

**Rollback**: disable `agent_assist` feature flag. In-flight jobs drain (worker keeps consuming). If catastrophic, set `AGENT_ASSIST_CALLBACK_SYNC=false` to stop all enqueues; existing DLQ entries can be replayed after fix.

---

### Phase 5: Parity fixtures + E2E parity gate + operational hardening

**Goal**: The recorded-widget-traffic parity suite gates BETA promotion. Operational dashboards + DLQ replay runbook land alongside.

**Tasks**:

5.1. Capture recorded widget traffic (sessions + runs/execute async + callback) via the POC ngrok setup. Normalize opaque fields (`sessionId`, `runId`, timestamps) to placeholders. Commit as fixtures under `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/`.

5.2. Implement `agent-assist-lifecycle.e2e.test.ts` (E2E-5) — replay the fixture set end-to-end, assert byte-level parity on all envelopes after placeholder substitution.

5.3. Create operator runbook entry at `docs/sdlc-logs/agent-assist-runtime-compat/runbook.md` covering: - DLQ inspection + replay (using BullMQ CLI). - HMAC secret rotation procedure (placeholder — full solution is in Phase Actual follow-up per open question §9-1). - Kill-switch + feature-flag toggle. - Observatory query for `source:"agent_assist_v1"`.

5.4. Load test profile: append `docs/sdlc-logs/agent-assist-runtime-compat/load-test-profile.md` with the k6 script and expected Coroot saturation plots per test spec §9.

5.5. Run the full test matrix + `pnpm build` at the repo root; fix any regressions.

5.6. Update `packages/database/src/models/index.ts` barrel (re-check Phase 1 did this — re-assert).

5.7. Update the `docs/poc/agent-assist-runtime-compat-poc-reference.md` to note Phase Actual has landed and to cite the new parity fixture set.

5.7b. **Right-to-erasure cascade** — wire `agent_assist_bindings` cleanup into the existing cascade module at `packages/database/src/cascade/cascade-delete.ts` (verified: this is the centralized cascade module with BOTH `deleteProject(projectId, tenantId?)` at line 199 and `deleteTenant(tenantId)` at line 49; cascades to ~31 collections in `deleteProject` and ~30 in `deleteTenant`).

Precise edits:

- Inside `deleteProject` (lines 199-384), add a `deleteMany` entry near line 348 (the "Standard cascade" section — where `AuthProfile`, `ConnectorConnection` etc. are deleted): `counts.AgentAssistBinding = (await AgentAssistBinding.deleteMany({ projectId })).deletedCount;`. The function already scopes by `projectId` (tenant scoping is enforced at the callers — runtime's `cascade-repo.ts::cascadeDeleteProject` at lines 83-127 wraps the cascade with audit logging).
- Inside `deleteTenant` (lines 49-183), add the same pattern scoped to tenantId: `counts.AgentAssistBinding = (await AgentAssistBinding.deleteMany({ tenantId })).deletedCount;`. The runtime wrapper at `cascade-repo.ts::cascadeDeleteTenant` (line 22) also fires ClickHouse cleanup — no change needed there since bindings are Mongo-only.
- Ensure `AgentAssistBinding` is imported from `@agent-platform/database/models` at the top of `cascade-delete.ts` (matches the pattern of the other models imported there).

Integration tests at `packages/database/src/__tests__/cascade/agent-assist-binding-cascade.int.test.ts`:

- Project cascade: seed 1 tenant + 1 project + 3 bindings in that project + 2 bindings in a DIFFERENT project (same tenant). Call `deleteProject(projectId, tenantId)`. Assert: first-project bindings = 0, other-project bindings = 2 (untouched).
- Tenant cascade: seed 2 tenants + 2 bindings each. Call `deleteTenant(tenantIdA)`. Assert: tenantA bindings = 0, tenantB bindings = 2.
- CascadeDeleteResult: assert `result.counts.AgentAssistBinding === 3` (project case) and `=== 2` (tenant case).

Drop open question §7 item 8 once this is wired — tenant-delete cascade does exist and is covered by this task. CLAUDE.md Core Invariant #5 (right-to-erasure).

**Files touched**:

- `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/*.json` (4-6 fixtures)
- `apps/runtime/src/__tests__/routes/agent-assist-lifecycle.e2e.test.ts` (new)
- `packages/database/src/cascade/cascade-delete.ts` (add `AgentAssistBinding.deleteMany` calls inside both `deleteProject` ~line 348 and `deleteTenant` ~line 180, + import the model)
- `packages/database/src/__tests__/cascade/agent-assist-binding-cascade.int.test.ts` (new integration test)
- `docs/sdlc-logs/agent-assist-runtime-compat/runbook.md` (new)
- `docs/sdlc-logs/agent-assist-runtime-compat/load-test-profile.md` (new)
- `docs/poc/agent-assist-runtime-compat-poc-reference.md` (POC → Phase Actual note)

**Exit criteria**:

- [ ] Full lifecycle parity E2E (E2E-5) green.
- [ ] `pnpm build && pnpm test` at repo root — no regressions anywhere else.
- [ ] Operator runbook contains a copy-paste DLQ replay example.
- [ ] Feature spec and test spec updated (`status: IN PROGRESS` → `PARTIAL` at minimum).
- [ ] Cascade integration test green for both `deleteProject` and `deleteTenant` — assert `counts.AgentAssistBinding` matches seeded count AND other-project / other-tenant bindings are untouched.
- [ ] `grep -n "AgentAssistBinding" packages/database/src/cascade/cascade-delete.ts` shows ≥3 lines: the import, the `deleteProject` cascade entry, and the `deleteTenant` cascade entry.

**Test strategy**:

- E2E parity test is the headline deliverable — BETA promotion blocker.
- Cross-feature regression sweep: run the entire runtime + admin test suite and confirm zero flakes introduced.

**Rollback**: this phase is additive documentation + tests. Nothing to roll back.

---

## 4. Wiring Checklist

Critical — this is where Phase Actual most risks becoming dead code. Explicit wire-up confirmation required before claiming each phase done.

- [ ] **Model**: `AgentAssistBinding` exported from `packages/database/src/models/index.ts`.
- [ ] **Repo**: `getAgentAssistBindingResolver()` exported from `apps/runtime/src/repos/agent-assist-binding-repo.ts` and imported by (a) route handler, (b) admin route handlers (via cross-package import or shared helper).
- [ ] **Router**: `app.use('/api/v2/apps', createAgentAssistRouter())` at `apps/runtime/src/server.ts` (already present from POC — no change).
- [ ] **Router middleware chain** (inside `agent-assist.ts`): `authMiddleware` (the wrapper at `apps/runtime/src/middleware/auth.ts:194-202` — composed of `unifiedAuth` + `requireAuthenticatedRequest` + `requireTenantContextMiddleware`) → kill-switch env check → `requireFacadeFeature('agent_assist')` → `tenantRateLimit('request')` → `requirePermission('session:send_message')` → `resolveAndAuthorizeBinding` → handler. Grep evidence required at review time (mount/import/caller trace), not just "the file exists".
- [ ] **Feature gate**: `requireFacadeFeature` exported from `apps/runtime/src/services/agent-assist/feature-gate.ts` and imported in the route. `agent_assist` is NOT in `PLAN_FEATURES` (Deal-grant only per D-7); pilot tenant has `agent_assist` in an active `Deal.features[]` entry — verify with a DB query during rollout.
- [ ] **Trace events (D-14, 6-step)**: `packages/shared-kernel/src/constants/trace-event-registry.ts` contains (1) `AGENT_ASSIST_TRACE_EVENT_TYPES` const array, (2) `AgentAssistTraceEventType` type alias, (3) `agent_assist:` key in `TRACE_EVENT_GROUPS`, (4) spread into `ALL_TRACE_EVENT_TYPES`, (5) all 8 types present in `RUNTIME_EVENT_TYPES`, (6) `registryEntriesForDomain('agent_assist', AGENT_ASSIST_TRACE_EVENT_TYPES)` spread into `TRACE_EVENT_REGISTRY`. Missing any step means events silently fail Observatory indexing — grep each of the 6 insertion points during review.
- [ ] **Worker**: `startAgentAssistCallbackWorker()` call present inside `apps/runtime/src/server.ts::wireAsyncInfra()` (Redis branch, alongside `startResumptionWorker` and `startSuspensionTimeoutWorker` — not in `index.ts`). Grep evidence required: `grep -n "startAgentAssistCallbackWorker" apps/runtime/src/server.ts`.
- [ ] **Shared-kernel LRU helper**: `LRUTTLCache` exported from `packages/shared-kernel/src/cache/lru-ttl-cache.ts` AND re-exported from `packages/shared-kernel/src/index.ts`. Binding repo imports via `@agent-platform/shared-kernel`.
- [ ] **Admin routes**: all four route files under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/bindings/**` present, each verb-export wrapped with `withAdminRoute({ role: 'ADMIN' }, handler)`. `AdminAction` union at `apps/admin/src/lib/audit-logger.ts` contains the 5 new members.
- [ ] **Audit hook**: every admin mutation calls `logAdminAction` from `apps/admin/src/lib/audit-logger.ts` with the canonical shape `{ actor, actorRole, action: '<compat_binding_*>', target, ipAddress, metadata: { before, after } }`.
- [ ] **Test helpers**: `apps/runtime/src/__tests__/helpers/agent-assist/{seed,callback-sink}.ts` exported + imported by integration + E2E tests.
- [ ] **HMAC secret**: `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` env var documented in the runbook and present in dev + staging + production deployments' secret-ref manifests.
- [ ] **OpenAPI spec (if present for v2)**: optional — no documented OpenAPI surface for `/api/v2/apps/*` today; skip unless a peer surface exists.
- [ ] **Admin UI link**: not in scope for Phase Actual (Studio panel deferred to follow-up per feature-spec §5.3).

---

## 5. Cross-Phase Concerns

### 5.1 Database migrations

None. The `agent_assist_bindings` collection is net-new; the `tenantIsolationPlugin` + unique index are created at first write. No data migration from a prior collection.

### 5.2 Feature flags

- `agent_assist` (new feature slug, Phase 3): resolved by `requireFacadeFeature` via `Deal.features[]` then `PLAN_FEATURES[planTier]` (per D-7). Default OFF everywhere — not added to any plan-tier initially. Pilot rollout is via a `Deal` record granting the slug to the pilot tenant only. Once ready for broader rollout, a follow-up change appends `'agent_assist'` to the appropriate `PLAN_FEATURES` tier.
- `AGENT_ASSIST_ENABLED` (env, retained from POC): global kill-switch. Deployed with value `true` in prod once Phase 3 lands, but the Deal-granted feature slug keeps the surface fenced off per-tenant.

### 5.3 Configuration / env vars

| Env var                                 | Default / requirement                                    | Phase            |
| --------------------------------------- | -------------------------------------------------------- | ---------------- |
| `AGENT_ASSIST_ENABLED`                  | `true` in prod; `false` by default in dev stacks         | 3                |
| `AGENT_ASSIST_SEED_MODE`                | unset (Mongo mode) in prod; `env` in POC / local dev     | 3                |
| `AGENT_ASSIST_POC_SEED_BINDING`         | unset in prod; JSON in POC / local dev                   | 3                |
| `AGENT_ASSIST_FORCE_PLACEHOLDER`        | unset in prod; operator-toggled for canary runs          | 3                |
| `AGENT_ASSIST_MAX_BODY_BYTES`           | 524288 (512 KiB)                                         | 3                |
| `AGENT_ASSIST_MAX_INPUT_CHARS`          | 16000                                                    | 3                |
| `AGENT_ASSIST_MAX_AA_HISTORY_MSGS`      | 50                                                       | 3                |
| `AGENT_ASSIST_SSE_HEARTBEAT_MS`         | 15000 (prod); 500 in test harness                        | 3                |
| `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` | KMS reference required in prod; a fixture secret in test | 4                |
| `AGENT_ASSIST_CALLBACK_SYNC`            | unset in prod; `true` in local dev to bypass BullMQ      | 4                |
| `AGENT_ASSIST_DEBUG_RECORD`             | unset in prod; `true` for dev capture                    | carried from POC |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All five phases complete with every exit-criterion checkbox ticked.
- [ ] All 7 E2E scenarios (E2E-1..E2E-7) green on CI.
- [ ] All 5 integration scenarios (INT-1..INT-5) green on CI.
- [ ] Unit test coverage added for every new module (13 new / updated unit test files).
- [ ] `pnpm build && pnpm test` at repo root passes, zero regressions in unrelated suites.
- [ ] Feature-spec §17 Testing matrix rows flip from PLANNED → IN PROGRESS / PARTIAL with scenario references.
- [ ] Testing-guide Coverage Matrix §3 and File Mapping §12 reflect passing scenarios.
- [ ] The widget parity fixture set in `__tests__/fixtures/agent-assist/widget-lifecycle/` is checked in and referenced by E2E-5.
- [ ] `agent_assist` feature flag is OFF for every tenant on the first production deploy; pilot tenant enabled post-sanity check.
- [ ] Observer can filter Observatory by `source:"agent_assist_v1"` and see both sync and async callback traces for the pilot tenant.
- [ ] Runbook contains DLQ inspection + replay procedure and is linked from `docs/sdlc-logs/agent-assist-runtime-compat/`.
- [ ] Feature spec status moves from `PLANNED` → `ALPHA` (first production tenant using the flag) per the SDLC lifecycle criteria.
- [ ] **HLD back-sync at `/post-impl-sync`**: the HLD does not currently list D-11 `LRUTTLCache` at `packages/shared-kernel/src/cache/` or D-15 proxy-admin architecture. After Phase 5, run `/post-impl-sync agent-assist-runtime-compat` to append these to the HLD data-model + component-diagram sections so future features see them as first-class shared-kernel utilities and the established admin pattern. Tracked in round-4 audit log.

---

## 7. Open Questions

1. **HMAC secret rotation** — HLD §9 open question #1. Do we pin signature version inside `X-ABL-Signature` at enqueue time (`k=<versionId>`) or require receivers to accept a grace window? Not blocking Phase Actual — decision is trackable as a separate short spec.
2. **Admin sub-tenant RBAC** — HLD §9 open question #2. Not blocking.
3. **`GET /sessions/:sessionId` public endpoint** — HLD §9 open question #3. Deferred.
4. **DLQ replay UI** — HLD §9 open question #4. Interim is BullMQ CLI + runbook. No blocker.
5. **Placeholder mode disposition** — HLD §9 open question #5. Kept indefinitely as a canary.
6. **Worker concurrency** — how many workers per pod? POC default of 1 is fine; load-test phase 5 will confirm or ask for a bump.
7. **Cache invalidation across pods** — Phase 1's in-process cache invalidates only on the mutating pod; other pods wait for TTL (60 s). Is this acceptable, or do we need a Redis pub/sub invalidation broadcast? Recommend acceptable for Phase Actual; revisit if operators report stale bindings after updates.
8. ~~Tenant-delete cascade~~ — RESOLVED. `packages/database/src/cascade/cascade-delete.ts::deleteTenant(tenantId)` at line 49 is the entry point; Phase 5 task 5.7b adds the cascade hook there. No follow-up needed.

---

## 8. References

- Feature spec: [docs/features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
- HLD: [docs/specs/agent-assist-runtime-compat.hld.md](../specs/agent-assist-runtime-compat.hld.md)
- Test spec: [docs/testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)
- POC reference: [docs/poc/agent-assist-runtime-compat-poc-reference.md](../poc/agent-assist-runtime-compat-poc-reference.md)
- JIRA: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
