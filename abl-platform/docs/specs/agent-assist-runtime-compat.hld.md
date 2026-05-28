# HLD: Agent Assist V1 Compatibility Facade

**Feature Spec**: [docs/features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
**Test Spec**: [docs/testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)
**JIRA**: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
**Status**: APPROVED (implementation shipped — see feature spec §13 for delivery breakdown and §16 for resolved gaps)
**Last Updated**: 2026-04-25

---

## 1. Problem Statement

Kore.ai Agent Assist — the contact-center widget embedded in XO / SmartAssist Agent Desktop — talks to the legacy **Agentic Platform V1** at `agent-platform.kore.ai` through a stored Agentic Configuration (App Name, Domain URL, Environment, App ID `aa-<uuid>`, API key `kg-<uuid>.<uuid>`) and three HTTP endpoints:

- `POST /api/v2/apps/:appId/environments/:envName/runs/execute` (sync / SSE / async-push)
- `POST /api/v2/apps/:appId/environments/:envName/sessions`
- `POST /api/v2/apps/:appId/environments/:envName/sessions/terminate`

As SmartAssist migrates to **ABL V2**, this integration must keep working without any widget, design-time UI, or stored-config change — otherwise every live Agent Desktop session breaks for migrated tenants. ABL V2 already has the underlying primitives (`DeploymentResolver`, `RuntimeExecutor.createSessionFromResolved`, `RuntimeExecutor.executeMessage`, `RuntimeExecutor.endSession`, `SessionService`). What it lacks is the V1 URL shape, envelope format, SSE frame contract, and the `aa-<uuid>` → `(tenantId, projectId, deploymentId)` indirection.

The design must preserve ABL's core invariants: tenant isolation at the query level (cross-tenant → 404, never 403), centralized auth (no custom `x-api-key` parsing), stateless distributed execution, `TraceStore`-based observability, error-message sanitization, and encryption / data-minimization compliance.

---

## 2. Alternatives Considered

### Alternative A: Canonical provider-neutral "Agent Suggestions Service" + V1 facade delegating to it

**Description**: Introduce a new ABL-native surface (`/api/v1/projects/:projectId/agent-suggestions/...`) with a typed `AgentSuggestion` discriminated union (`reply | article | next_action | summary`). The V1 facade translates to/from that canonical surface; future vendor facades (Google CCAI, Amazon Q in Connect, Cresta) target the canonical surface only.

**Pros**:

- Vendor-agnostic: future vendor facades gain a single integration target.
- Pressure toward a clean typed contract visible to all callers.
- Matches how `a2a-integration.md` and `sdk.md` stratify protocol-translator vs execution-core.

**Cons**:

- Designing for hypothetical consumers — there is only ONE real consumer today (Kore.ai Agent Assist) already speaking V1.
- Adds a new permission scope (`agent_suggestions:execute`) and a typed contract in `shared-kernel` — both net-new surface area requiring maintenance, documentation, and version management.
- Compat facade becomes "translate V1 → canonical → ExecutionResult → canonical → V1" — two translation hops and two envelopes for zero current-day benefit.
- The feature spec earlier drafts kept this alternative; the user explicitly removed Layer A before this HLD.

**Effort**: L (additional service + typed contract + new permission + doc surface).

### Alternative B: In-process V1 facade delegating directly to `RuntimeExecutor` (CHOSEN)

**Description**: Mount a thin Express router at `/api/v2/apps/:appId/environments/:envName/...` that translates V1 request/response/SSE in-process onto ABL's existing primitives. No new public API other than the V1 URL shape. A new `agent_assist_bindings` MongoDB collection persists the `(appId, envName) → (tenantId, projectId, deploymentId?)` mapping. Async-push is a BullMQ worker with HMAC signing, retry, and DLQ.

**Pros**:

- Single layer to maintain and audit. No typed-contract surface in `shared-kernel`.
- Reuses 100% of the execution pipeline (auth, session, PII scrub, model resolution, budget, tools, tracing).
- Same SSE path as native chat — `onChunk` callback writes V1 frames at the route boundary; no SSE loopback or double-parse.
- Closest peer in the codebase is `workflows-execute.ts` (same auth + executor-reuse pattern) — architectural consistency.
- The POC has validated the full contract end-to-end against the real Kore.ai Agent Assist widget via ngrok — see POC reference §5.

**Cons**:

- If a second vendor facade ships later (Google CCAI, Amazon Q), that team must re-learn the integration pattern by copying this facade's structure rather than targeting a shared canonical surface. Mitigation: `apps/runtime/src/services/agent-assist/` is a self-contained module template to copy.
- Runtime errors return HTTP 200 with `sessionInfo.status:"error"` (intentional V1-compat deviation from ABL's `{success,error}` convention). Documented explicitly; bounded to this facade only.
- Session IDs must be deterministic from `(binding, sessionReference)` so V1 `sessions/terminate` can release the same underlying `HydratedSession` — adds a stable UUIDv5 derivation step in the bridge.

**Effort**: M (leveraging POC code as starting point).

### Alternative C: HTTP loopback — facade POSTs to `/api/v1/chat/agent`

**Description**: Instead of in-process `RuntimeExecutor.executeMessage`, the facade issues an internal HTTP `POST /api/v1/chat/agent` call and translates the response.

**Pros**:

- Zero direct coupling to `runtime-executor.ts` internals; any change to the executor propagates for free.
- Facade code becomes purely a translation layer with no platform-auth concerns inside execution.

**Cons**:

- Double serialization on every turn (request and response).
- Two auth passes per turn (facade resolves `x-api-key`, then the loopback must synthesize a trusted internal bearer — new attack surface).
- Streaming is catastrophic: consume ABL's `event:/data:` SSE frames, re-emit as V1 `data:` frames — extra latency, extra failure mode, 2x socket cost.
- Runtime pod → self HTTP requires loopback DNS / service mesh awareness we do not need.

**Effort**: S implementation, but large operational + security cost.

### Recommendation: Alternative B (in-process V1 facade)

**Rationale**: Only real-world consumer is Kore.ai Agent Assist. In-process delegation is what `workflows-execute.ts` already does — it is the established pattern for external HTTP integrations that need the full execution pipeline. The POC has proven the contract end-to-end; promoting it to Phase Actual is a matter of persistence, worker, audit log, and feature gate — not architectural redesign. Alternative A is deferred to a follow-up only when a second real non-V1-shaped consumer emerges.

---

## 3. Architecture

### 3.1 System context

```
 ┌──────────────────────────────────┐          ┌──────────────────────────────┐
 │ Kore.ai Agent Assist widget      │          │ Kore.ai SmartAssist server   │
 │ (inside XO / SmartAssist         │◀── WS ──▶│ /agentassist/api/v1/aa/      │
 │  Agent Desktop; stored           │          │   linkedapps/agenticresponse │
 │  Agentic Configuration)          │          └──────────────▲───────────────┘
 └──────────────┬───────────────────┘                         │ HTTPS POST
                │                                             │ (async callback)
                │ HTTPS: x-api-key, V1 bodies                 │
                ▼                                             │
 ┌─────────────────────────────────────────────────────────────┴────────────────┐
 │  ABL Runtime  (apps/runtime)                                                 │
 │                                                                              │
 │   [createUnifiedAuthMiddleware] → req.tenantContext (authType:"api_key")    │
 │   [feature-gate: agent_assist] → 404 if off                                │
 │   [tenantRateLimit('request')]                                                │
 │        │                                                                     │
 │        ▼                                                                     │
 │   Router: /api/v2/apps/:appId/environments/:envName                          │
 │     POST /sessions              ─┐                                           │
 │     POST /runs/execute          ─┼──▶ binding-resolver (Mongo + TTL cache)   │
 │     POST /sessions/terminate    ─┘                                           │
 │        │                                                                     │
 │        ├─── sync / SSE ─────▶ execution-bridge                               │
 │        │                       ├── DeploymentResolver.resolve                │
 │        │                       ├── RuntimeExecutor.createSessionFromResolved │
 │        │                       ├── RuntimeExecutor.executeMessage(onChunk)   │
 │        │                       └── envelope-builder / v1-sse-emitter         │
 │        │                                                                     │
 │        └─── async-push ─────▶ BullMQ enqueue ─▶ callback-worker              │
 │                                                   ├── same execution path    │
 │                                                   ├── HMAC-sign envelope     │
 │                                                   ├── POST callbackUrl       │
 │                                                   └── retry + DLQ            │
 │                                                                              │
 │   Admin (Next.js: apps/admin)                                                │
 │     /api/tenants/:tenantId/agent-assist/bindings/*                         │
 │     → agent-assist-binding-repo → Mongo + logAdminAction                   │
 └──────────────────────────────────────────────────────────────────────────────┘
                │                                             ▲
                │                                             │ BullMQ worker pod
                ▼                                             │ consumes queue,
        MongoDB (agent_assist_bindings,                     │ signs + POSTs
                 sessions, messages, audit_log)               │
                                                              │
                                      Redis / BullMQ ─────────┘
```

### 3.2 Component breakdown

Modules under `apps/runtime/src/services/agent-assist/`:

| Module                   | Responsibility                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`               | V1 shapes + `AgentAssistBinding` TS interface + internal execution-input types                                                   |
| `constants.ts`           | Env var names, size caps, reserved-key set, heartbeat, source/facade tags                                                        |
| `binding-resolver.ts`    | Mongo-backed resolver wrapping `AgentAssistBindingResolver` + short-TTL read cache                                               |
| `metadata-normalizer.ts` | Strip reserved transport/credential keys; bound `aa_uamsgs` history; coerce misc shapes                                          |
| `envelope-builder.ts`    | Build V1 sync + error envelopes (pure function)                                                                                  |
| `v1-sse-emitter.ts`      | V1 `data:`-only SSE writer with heartbeat comments                                                                               |
| `execution-bridge.ts`    | Resolve deployment via `DeploymentResolver`, then `RuntimeExecutor.createSessionFromResolved` + `RuntimeExecutor.executeMessage` |
| `session-envelope.ts`    | Synthesize V1 session + terminate envelopes; deterministic `sessionId`/`userId` via UUIDv5                                       |
| `callback-sender.ts`     | Thin wrapper around BullMQ enqueue for async-push delivery                                                                       |
| `debug-recorder.ts`      | Per-request JSON-lines capture (toggleable via `AGENT_ASSIST_DEBUG_RECORD=true`; dev-only)                                       |

Modules under `apps/runtime/src/` (NEW in Phase Actual):

| New file                                            | Responsibility                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `repos/agent-assist-binding-repo.ts`                | Mongo repo with `tenantIsolationPlugin`; CRUD + cache invalidation events                                                               |
| `jobs/agent-assist-callback-worker.ts`              | BullMQ worker for `agent-assist-callback` + DLQ `agent-assist-callback-dlq`                                                             |
| `routes/agent-assist.ts` (**Phase Actual rewrite**) | Express router mounted at `/api/v2/apps`. POC version already exists; Phase Actual adds async-push enqueue path + real terminate wiring |

Modules under `packages/database/src/models/`:

| New file                | Responsibility                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `agentAssistBinding.ts` | Mongoose schema + `tenantIsolationPlugin` + audit-trail plugin |

Modules under `apps/admin/src/`:

| New Next.js App Router route file                                               | Responsibility                           |
| ------------------------------------------------------------------------------- | ---------------------------------------- |
| `app/api/tenants/[tenantId]/agent-assist/bindings/route.ts`                     | `POST` create + `GET` list               |
| `app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/route.ts`         | `GET` detail + `PATCH` update + `DELETE` |
| `app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/disable/route.ts` | `POST` set `status:"disabled"`           |
| `app/api/tenants/[tenantId]/agent-assist/bindings/[bindingId]/enable/route.ts`  | `POST` set `status:"active"`             |

Each admin route imports `logAdminAction` from `apps/admin/src/lib/audit-logger.ts`.

### 3.3 Data flow — sync turn

```
Widget --(POST /runs/execute, x-api-key, stream.enable=false, isAsync=false)--> Runtime
   1. createUnifiedAuthMiddleware → req.tenantContext = { tenantId, apiKeyId, projectScope, authType:"api_key" }
   2. feature-gate middleware: tenant has agent_assist? else 404
   3. tenantRateLimit('request')
   4. Router: resolveAndAuthorize
        - binding = bindingResolver.get(appId, envName)
        - if missing | disabled | tenantId mismatch | projectScope mismatch → 404 APP_NOT_FOUND
   5. Permission check: req.tenantContext has session:send_message? else 403 FORBIDDEN
   6. v1ExecuteBodySchema.strict().parse(req.body); payload-size guards → 413
   7. metadata-normalizer: strip reserved keys, bound aa_uamsgs
   8. execution-bridge.executeTurn(binding, input, onChunk=null, apiKeyId, userId)
        - DeploymentResolver.resolve({ projectId, tenantId, deploymentId?, environment })
        - sessionId = deterministicSessionId(binding, sessionReference)
        - executor.getSession(sessionId) ?? executor.createSessionFromResolved(resolved, { sessionId, ... })
        - executor.executeMessage(sessionId, userMessage, undefined, undefined, { channelMetadata })
   9. envelope-builder.buildV1Envelope(executionResult, sessionInfo, metadata-echo)
  10. res.status(200).json(envelope); emit agent_assist.translated_response
```

### 3.4 Data flow — SSE streaming turn

Same steps 1–7. Then:

```
   8. V1SSEEmitter.open(res)  // writes headers + heartbeat timer
   9. execution-bridge.executeTurn(binding, input, onChunk: (delta)=>emitter.writeDelta(delta), ...)
        - same DeploymentResolver/createSessionFromResolved path
        - executor.executeMessage(sessionId, userMessage, onChunk, ...)
  10. On executor resolution: emitter.writeFinal(sessionInfo, output, isLastEvent:true)
  11. emitter.close()
```

### 3.5 Data flow — async-push turn

```
   1-7. Same as sync path.
   8. If body.isAsync && validAbsolute(body.callbackUrl):
        - Build intermediate sessionInfo (sessionId deterministic)
        - Enqueue BullMQ job { tenantId, projectId, binding, input, callbackUrl, messageId, sessionInfo }
        - Respond 202 with processing envelope
   9. Later, on worker pod:
        - Replay steps 8 of sync path (executeTurn)
        - Build final envelope
        - HMAC-sign body (X-ABL-Signature: t=<unix>,v1=<hex>)
        - POST callbackUrl with timeout
        - On 2xx → complete; emit agent_assist.callback_delivered
        - On non-2xx / timeout → retry with exp. backoff (1s, 2s, 4s, 8s, 16s cap 30s; max 5 attempts)
        - After final failure → move to DLQ; emit agent_assist.callback_failed
```

### 3.6 Sequence — full widget lifecycle

```
Widget                  Runtime (facade)          Executor                 Widget server
  │                          │                        │                          │
  │ POST /sessions           │                        │                          │
  ├─────────────────────────▶│                        │                          │
  │                          │ build V1 envelope      │                          │
  │                          │ (deterministic sessId) │                          │
  │ ◀── 200 {session, welcome│                        │                          │
  │       (conditional)}     │                        │                          │
  │                          │                        │                          │
  │ POST /runs/execute       │                        │                          │
  │   isAsync:true,          │                        │                          │
  │   callbackUrl:https://…  │                        │                          │
  ├─────────────────────────▶│                        │                          │
  │                          │ enqueue BullMQ         │                          │
  │ ◀── 202 {processing}     │                        │                          │
  │                          │                        │                          │
  │                          │ (worker pod)           │                          │
  │                          │   createSessionFromResolved                       │
  │                          │   executeMessage ────▶ │                          │
  │                          │   ◀────────────────── result                      │
  │                          │   HMAC-sign envelope                              │
  │                          │   POST callbackUrl ──────────────────────────────▶│
  │                          │                                            ◀ 200  │
  │                          │ emit callback_delivered                           │
  │                          │                        │                          │
  │ POST /sessions/terminate │                        │                          │
  ├─────────────────────────▶│                        │                          │
  │                          │ executor.endSession(sessionId)                    │
  │                          │                        ├──▶ SessionService.delete │
  │ ◀── 200 {terminated}     │                        │                          │
```

---

## 4. The 12 Architectural Concerns

### Structural

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every Mongo query on `agent_assist_bindings` scoped by `tenantId` via `tenantIsolationPlugin` (defense in depth) + explicit filter in repo. Runtime cross-tenant access returns 404 `APP_NOT_FOUND` (never 403). Session lookup composite keyed on `(tenantId, projectId, apiKeyId, externalReference)` so two vendors on the same project cannot collide on identical `sessionReference`.                                                                                                                                                                                                                      |
| 2   | **Data Access Pattern** | `agent-assist-binding-repo.ts` is the single access path. Short-TTL (60 s) in-process read cache keyed on `(tenantId, appId, environment)`; never authoritative. Mutations invalidate on the mutating pod; other pods rely on cache TTL. No session store — `SessionService` is untouched.                                                                                                                                                                                                                                                                                                                      |
| 3   | **API Contract**        | Public: V1 URL shape exactly as Kore.ai Agent Assist sends today (sync / SSE / async-push documented in §6). Internal: `executeTurn(binding, input, onChunk?, apiKeyId?, userId?)` is the single seam between route handler and execution bridge. Versioning: facade is v2 in URL (`/api/v2/apps/...`); no breaking changes to V1 shape — forward-compat unknown body fields pass through `.strict()` via the explicit passthrough list (`invoke`, `attachments`, `additionalArgs`, `metrics`).                                                                                                                 |
| 4   | **Security Surface**    | Auth: `createUnifiedAuthMiddleware` resolves `x-api-key`; no custom parsing. Permission: existing `session:send_message` enforced via `requirePermission` (same as native chat). Callback URL: absolute HTTPS (or plain HTTP on localhost only) — sender refuses relative / unsupported-protocol URLs with a logged warning. HMAC-SHA256 signing via KMS-resolved secret (`AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF`) — signature includes body hash to prevent tampering. Bit-flip test in §E2E-4 step 5 validates receiver behaviour. SSRF: callback sender has host allowlist gate (localhost → loopback only). |

### Behavioral

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Two distinct paths: **Pre-execution** failures use standard HTTP 4xx/5xx codes + `{error:{code,message}}` body (FR-22a). **Execution-time** failures return HTTP 200 with `sessionInfo.status:"error"` + sanitized `output[0].content` — matches V1 widget-side error detection (FR-22b). Intentional deviation from ABL's `{success,error}` convention; bounded to this facade.                                                                                                                                                                                                                                                             |
| 6   | **Failure Modes** | Pod crash during async delivery → BullMQ `attemptsMade` counter increments on redelivery. Callback endpoint 5xx → exp. backoff retry (5 attempts max, 1s→30s cap). Terminal failure → DLQ with full request/response trail. Redis down → facade still returns 202 sync; enqueue error surfaces in logs; operator playbook in §8 Manual Verification of test spec. Deployment resolution failure → sanitized HTTP 200 error envelope. Heartbeat timer on long SSE prevents CDN idle-timeout drop.                                                                                                                                             |
| 7   | **Idempotency**   | `/sessions` create: same `(binding, sessionReference)` → same deterministic `sessionId`. `/sessions/terminate` same id: idempotent (second call returns success envelope). Callback delivery: consumer MUST be idempotent on `messageId` — widget side already is. Concurrent `/sessions` races on same id → both requests return the same `sessionId`, one wins `createSessionFromResolved` (atomic inside executor).                                                                                                                                                                                                                       |
| 8   | **Observability** | Trace-event family `agent_assist.*`: `received`, `binding_resolved`, `delegated`, `translated_response`, `error`, `callback_scheduled`, `callback_delivered`, `callback_failed`. Registered in `packages/shared-kernel/src/constants/trace-event-registry.ts`. Session stamped with `callerContext.channel:"api"` + `session.data.values._metadata._agentAssist = {source:"agent_assist_v1", facade:"agent_assist_v1", appId, environment, bindingId, apiKeyId, externalReference}`. All logs structured via `createLogger('agent-assist:<module>')`. Debug recorder (opt-in) captures per-request body/response to JSONL for dev debugging. |

### Operational

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Sync latency: facade overhead ≤ 50 ms p50 over upstream `executeMessage` p50. SSE TTFT: ≤ 100 ms p95. Async-push enqueue latency: ≤ 30 ms p50. Async-push delivery: ≤ 5 s p50 end-to-end; ≥ 99.5% success within 5 attempts. Body size cap: 512 KiB (`AGENT_ASSIST_MAX_BODY_BYTES`). Input cap: 16 000 chars (`AGENT_ASSIST_MAX_INPUT_CHARS`). `aa_uamsgs` cap: 50 messages. Target throughput: 100 req/s sustained per pod, 80/15/5 async/sync/SSE mix.                                                                                                                                                                                                             |
| 10  | **Migration Path**     | POC already validated end-to-end (docs/poc/...). Phase Actual migrates (in order): (a) ship `agent_assist_bindings` model + repo + admin routes; (b) replace env-seeded resolver with Mongo repo; (c) enable `agent_assist` feature flag per-tenant; (d) wire BullMQ + HMAC callback worker; (e) wire real `/sessions/terminate` to `endSession`; (f) register trace events. Each stage ships behind the `agent_assist` feature flag (fails-closed). No data migration from an older collection — this is a net-new feature.                                                                                                                                         |
| 11  | **Rollback Plan**      | Immediate rollback: disable `agent_assist` feature flag per-tenant — facade returns 404 `APP_NOT_FOUND` for those tenants (existing Kore.ai widget sessions will fail-safe retry, ABL returns no traffic). Global kill-switch: `AGENT_ASSIST_ENABLED=false` — facade returns 404 for ALL tenants. Code rollback: revert the feature's commits; no schema changes needed to roll back if the `agent_assist_bindings` collection is left in place (orphaned data). BullMQ queues drain on their own; in-flight jobs complete or DLQ. No state in `sessions` or `messages` collections is breaking — those records remain usable for Observatory even after a rollback. |
| 12  | **Test Strategy**      | Unit: 17 pure-function test files (8 retained from POC + 4 net-new — `agent-assist-binding-repo`, `agent-assist-callback-worker`, `v1-sse-emitter`, admin route unit tests). Integration (5 scenarios): real MongoDB + Redis via the existing test harness; DI-injected LLM test double only; NO `vi.mock` of internal packages. E2E (7 scenarios): real HTTP + real middleware chain on `port:0`; admin route tests run against real Next.js test server (supertest incompatible with App Router); recorded-traffic parity test gates BETA promotion. Load: k6, 100 req/s sustained, 1-hour soak, per-pod CPU + DLQ depth gated (§9 of test spec).                  |

---

## 5. Data Model

### 5.1 New collection: `agent_assist_bindings`

```text
Collection: agent_assist_bindings
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed, enforced by tenantIsolationPlugin)
  - projectId: string (required, indexed)
  - appId: string (required)                    // Kore.ai-facing, e.g. "aa-<uuid>"
  - environment: string (required, lowercased)  // e.g. "dev", "prod"
  - status: "active" | "disabled"
  - deploymentId: string | null                 // null → env-active at request time
  - apiKeyId: string | null                     // opaque label for session.callerContext
  - displayName: string | null                  // operator label for Admin UI / logs
  - createdBy: string (required)                // admin subject id
  - createdAt: Date
  - updatedBy: string | null
  - updatedAt: Date | null
  - disabledAt: Date | null
  - disabledBy: string | null

Indexes:
  - { tenantId: 1, appId: 1, environment: 1 } (UNIQUE)
  - { tenantId: 1, projectId: 1 }
  - { tenantId: 1, status: 1 }

Plugins:
  - tenantIsolationPlugin
  - audit-trail (emits logAdminAction entries on mutation)
```

**Not stored on the binding**: `callbackUrl` (per-request, sent in `/runs/execute` body) and HMAC secret (single global value resolved from `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF`).

### 5.2 Reused without schema changes

| Collection                    | Read?                        | Write?                                                               |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `api_keys`                    | yes                          | no (operators may pre-insert for the Kore.ai-shaped keys — POC path) |
| `sessions`                    | yes                          | yes (via `RuntimeExecutor.createSessionFromResolved` / `endSession`) |
| `messages`                    | read-only via SessionService | yes (via `executor.executeMessage`)                                  |
| `trace_events` (`TraceStore`) | no                           | yes (new `agent_assist.*` event names only)                          |
| `audit_log`                   | no                           | yes (via `logAdminAction` from `apps/admin/src/lib/audit-logger.ts`) |

### 5.3 Session record extensions

`HydratedSession.callerContext` carries strict shared-auth fields only:

```ts
{ tenantId, channel: "api", initiatedById: userId, identityTier: 0, verificationMethod: "none" }
```

Facade-specific context lives under `session.data.values._metadata._agentAssist` — a free-form namespace within the existing `_metadata` structure:

```ts
{
  source: "agent_assist_v1",
  facade: "agent_assist_v1",
  appId: "aa-<uuid>",
  environment: "dev",
  bindingId: "<uuid>",
  apiKeyId: "<opaque>",
  externalReference: "<apiKeyId>:<sessionReference>"
}
```

Observatory / billing / cleanup scripts filter on `session.data.values._metadata._agentAssist.source === "agent_assist_v1"`.

---

## 6. API Design

### 6.1 Runtime endpoints (public, `/api/v2/apps`)

All three endpoints require `x-api-key` header and a body validated with Zod `.strict()`. No changes to existing `/api/v1/chat/*` or any other runtime surface.

#### 6.1.1 `POST /api/v2/apps/:appId/environments/:envName/sessions`

**Headers**: `x-api-key: <any-non-empty-string>`, `Content-Type: application/json`

**Request body**:

```jsonc
{
  "sessionIdentity": [                                  // required, non-empty
    { "type": "sessionReference" | "sessionId" | "sessionIdentity" | "userReference",
      "value": "<string>" }
  ],
  "source": "<optional ≤128 char string>",              // e.g. "AIS-AA"; echoed back
  "metadata": { "isSendWelcomeMessage": true, ... }     // arbitrary object; passthrough
}
```

**Response 200**:

```jsonc
{
  "session": {
    "sessionId": "s-<deterministic>", // UUIDv5 (binding, sessionReference)
    "sessionReference": "<echo or null>",
    "userReference": "<echo>",
    "status": "idle",
    "userId": "u-<deterministic>",
    "createdAt": "<ISO 8601>",
    "source": "<echo>",
  },
  "events": [
    // exactly one Welcome_Event only if metadata.isSendWelcomeMessage===true
    { "type": "Welcome_Event", "content": { "messageToUser": "<text>" } },
  ],
  "output": [{ "type": "text", "content": "<welcome text or empty string>" }],
  "allowedMimeTypes": ["pdf", "docx", "doc", "txt", "json", "csv", "png", "jpg"],
  "fileUploadConfig": {
    "maxFileCount": 0,
    "maxFileSize": 0,
    "maxTokens": 0,
    "isAttachmentsEnabled": false,
  },
}
```

**Error responses**:

| HTTP | Code                | Cause                                                                                                      |
| ---- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| 401  | `UNAUTHORIZED`      | Missing or unresolvable `x-api-key`                                                                        |
| 403  | `FORBIDDEN`         | Key resolved but lacks `session:send_message` permission                                                   |
| 404  | `APP_NOT_FOUND`     | Binding missing / disabled / tenant mismatch / project-scope mismatch / feature-gate off / kill-switch off |
| 400  | `INVALID_INPUT`     | Zod strict validation failure                                                                              |
| 413  | `PAYLOAD_TOO_LARGE` | Body > 512 KiB                                                                                             |
| 429  | (rate-limit shape)  | `tenantRateLimit('request')` hit                                                                           |

#### 6.1.2 `POST /api/v2/apps/:appId/environments/:envName/runs/execute`

Three transport modes selected by body flags:

**Mode A — Sync (default)**: `stream.enable` false-or-absent, `isAsync` false-or-absent.

**Mode B — SSE streaming**: `stream.enable: true`.

**Mode C — Async-push**: `isAsync: true`, requires valid absolute `callbackUrl`.

**Request body**:

```jsonc
{
  "sessionIdentity":  [ { "type": "sessionReference", "value": "conv-1" } ], // required
  "input": [                                                                  // required, non-empty
    { "type": "text" | "object" | "tool_input",
      "content": "<string or object>" }
  ],
  "stream":    { "enable": false, "streamMode": "tokens" | "messages" },      // optional
  "debug":     { "enable": false, "debugMode":  "full" | "thoughts" },        // optional; accepted + ignored
  "source":    "<≤128 char string>",                                          // optional
  "metadata":  { "conversationId": "...", "aa_uamsgs": [...], ... },          // optional passthrough
  "isAsync":   false,                                                         // optional
  "callbackUrl": "<absolute URL>",                                             // required if isAsync:true
  "invoke":        { ... },    // forward-compat, ignored in Phase Actual
  "attachments":   [ ... ],    // forward-compat, ignored
  "additionalArgs": { ... },   // forward-compat, ignored
  "metrics":       { ... }     // forward-compat, ignored
}
```

**Response — Mode A (sync)** → HTTP 200:

```jsonc
{
  "messageId": "msg_<uuid>",
  "output":    [ { "type": "text", "content": "<agent reply>" } ],
  "sessionInfo": {
    "sessionId":        "<s-deterministic>",
    "runId":             "<uuid>",
    "status":            "completed",       // or "error" per FR-22b
    "appId":             "<binding.appId>",
    "sessionReference":  "<echo>",
    "userReference":     "<echo>",
    "userId":            "<u-deterministic>",
    "source":            "<echo>"
  },
  "metadata":  <echoed body.metadata>
}
```

**Response — Mode B (SSE)** → HTTP 200, `Content-Type: text/event-stream`:

```
data: {"eventIndex":0,"sessionInfo":{"sessionId":"s-…","runId":"…","status":"processing",...},"isLastEvent":false}\n\n

: heartbeat\n\n        (every AGENT_ASSIST_SSE_HEARTBEAT_MS = 15000 ms default)

data: {"eventIndex":1,"messageId":"msg_…","output":[{"type":"text","content":"partial 1"}],"isLastEvent":false}\n\n

data: {"eventIndex":2,"messageId":"msg_…","output":[{"type":"text","content":"partial 2"}],"isLastEvent":false}\n\n

data: {"eventIndex":3,"messageId":"msg_…","output":[{"type":"text","content":"final full"}],"sessionInfo":{"status":"completed",...},"isLastEvent":true}\n\n
```

Every frame is `data: <json>\n\n`. No named SSE `event:` lines (V1 clients reject them). Heartbeat is an SSE comment line, ignored by spec-compliant parsers.

**Response — Mode C (async-push)** → HTTP 202:

```jsonc
{
  "messageId": "msg_<uuid>",
  "output":    [ { "type": "text", "content": "" } ],          // empty on the sync response
  "sessionInfo": { "...": "...", "status": "processing" },
  "metadata":  <echoed body.metadata>
}
```

Then within retry budget, worker POSTs to `callbackUrl`:

```
POST <callbackUrl>
Content-Type: application/json
User-Agent: abl-agent-assist/<version>
X-ABL-Source: agent-assist-v1
X-ABL-Signature: t=<unix-ts>,v1=<hex-sha256>

<full sync-shape envelope with status:"completed" or "error">
```

HMAC signature: `HMAC-SHA256(body_bytes, KMS-resolved(AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF))`. Signed-payload string includes body; timestamp `t` is in seconds; receiver MUST reject if `|now - t| > 300`.

**Error responses** — same as §6.1.1 plus:

| HTTP | Code                    | Cause                                             |
| ---- | ----------------------- | ------------------------------------------------- |
| 400  | `CALLBACK_URL_REQUIRED` | `isAsync:true` without `callbackUrl`              |
| 400  | `INVALID_INPUT`         | Any Zod violation (includes invalid callback URL) |

Simultaneous `stream.enable:true` + `isAsync:true`: streaming wins, callback skipped. Documented in request-shape validation.

#### 6.1.3 `POST /api/v2/apps/:appId/environments/:envName/sessions/terminate`

**Request body**:

```jsonc
{ "sessionIdentity": [{ "type": "sessionId", "value": "<s-deterministic>" }] }
```

Priority for resolving target session when multiple identities present: `sessionId` > `sessionReference` > `userReference`.

**Response 200**:

```jsonc
{
  "status": "terminated",
  "userReference": "<echo or empty>",
  "sessionReference": "<echo or empty>",
  "userId": "<u-deterministic or empty>",
  "sessionId": "<s-deterministic>",
  "appId": "<binding.appId>",
  "attachments": [], // no attachment cleanup yet — Phase Actual follow-up
}
```

Idempotent: terminating an unknown or already-terminated session returns the same success envelope. Internally, `RuntimeExecutor.endSession(sessionId)` is called; errors are logged but swallowed (V1 contract treats terminate as fire-and-forget).

### 6.2 Admin endpoints (Next.js, `apps/admin/src/app/api/...`)

Mount parent: `/api/` (the admin host is behind an ingress-level `/admin/` boundary; routes here do NOT include an extra `/admin/` path segment).

| Method | Path                                                              | Purpose                                                                                                                                     | Audit-logged |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| POST   | `/api/tenants/:tenantId/agent-assist/bindings`                    | Create binding                                                                                                                              | yes          |
| GET    | `/api/tenants/:tenantId/agent-assist/bindings`                    | List tenant's bindings (pagination)                                                                                                         | no           |
| GET    | `/api/tenants/:tenantId/agent-assist/bindings/:bindingId`         | Get one                                                                                                                                     | no           |
| PATCH  | `/api/tenants/:tenantId/agent-assist/bindings/:bindingId`         | Update `projectId`, `deploymentId`, `displayName`, `apiKeyId`. Immutable: `tenantId`, `appId`, `environment` → 400 `IMMUTABLE_FIELD_CHANGE` | yes          |
| POST   | `/api/tenants/:tenantId/agent-assist/bindings/:bindingId/disable` | Set `status:"disabled"`                                                                                                                     | yes          |
| POST   | `/api/tenants/:tenantId/agent-assist/bindings/:bindingId/enable`  | Set `status:"active"`                                                                                                                       | yes          |
| DELETE | `/api/tenants/:tenantId/agent-assist/bindings/:bindingId`         | Hard-delete                                                                                                                                 | yes          |

Every mutating call calls `logAdminAction(...)` from `apps/admin/src/lib/audit-logger.ts` with `subject:"agent_assist_binding"`, `action:<op>`, before/after diff. If `logAdminAction` throws, the mutation FAILS CLOSED with HTTP 5xx — we never accept a mutation we cannot audit.

### 6.3 No changes to existing APIs

No new scope, no modified endpoint shape, no breaking change elsewhere.

---

## 7. Cross-Cutting Concerns

- **Audit logging**: Admin binding CRUD writes audit entries via `logAdminAction` (from `apps/admin/src/lib/audit-logger.ts`). Runtime facade writes no audit entries (the underlying chat operation is the auditable event; it emits its own `session:send_message` audit via the existing native-chat path).
- **Rate limiting**: `tenantRateLimit('request')` middleware on facade routes — same envelope used by `POST /api/v1/chat/agent` + `workflows-execute.ts`. No per-endpoint overrides.
- **Caching**: `binding-resolver.ts` in-process 60-second read cache keyed on `(tenantId, appId, environment)`; never authoritative — mutations invalidate on the mutating pod, stale reads self-heal within TTL. No response caching.
- **Encryption**: At-rest for `agent_assist_bindings` — existing Mongo encryption per tenant. In-transit — TLS enforced via ingress; callback POSTs use TLS (HTTPS only, except plain-HTTP localhost for dev). Secrets: `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` resolved via existing KMS flow (not stored in plain env vars — that env var names a KMS key reference).
- **PII**: Inherited from `RuntimeExecutor.executeMessage` pipeline — `scrubPII` + `PIIVault` fire as part of `resolveScrubPII` resolution and the per-event scrubber hook inside `runtime-executor.ts` (pinned to exact lines at LLD time). Facade does NOT add its own PII scrub. FR-20 specifies that V1 `metadata` is not forwarded raw into `messageMetadata`; only a sanitized subset (conversationId, botId, language, source) validated against `SdkMessageMetadata` reaches `executeMessage`.
- **Data retention**: `agent_assist_bindings` is long-lived; cleanup triggered by project-deletion cascade. Sessions follow the existing retention TTL unchanged. DLQ entries retained 30 days via BullMQ config.
- **i18n**: Out of scope — facade is English-only operator tooling + passthrough of agent output.

---

## 8. Dependencies

### 8.1 Upstream (this feature depends on)

| Dependency                                                                    | Type        | Risk                                                                                       |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `createUnifiedAuthMiddleware` (`packages/shared-auth`)                        | runtime     | low — stable, widely used                                                                  |
| `resolveApiKey` (`apps/runtime/src/repos/auth-repo.ts`)                       | runtime     | low                                                                                        |
| `DeploymentResolver` (`apps/runtime/src/services/deployment-resolver.ts`)     | runtime     | medium — signature stable but is under active evolution for `unified-deployment-endpoints` |
| `RuntimeExecutor.createSessionFromResolved` / `executeMessage` / `endSession` | runtime     | medium — the only path we delegate to; any signature change is a coordinated update        |
| `SessionService` (indirect via executor)                                      | runtime     | low                                                                                        |
| `tenantRateLimit` (`apps/runtime/src/middleware/rate-limiter.ts`)             | runtime     | low                                                                                        |
| `feature-gate.ts` + `PLAN_FEATURES` (`packages/shared-kernel`)                | runtime     | low                                                                                        |
| `TraceStore`                                                                  | runtime     | low                                                                                        |
| `logAdminAction` (`apps/admin/src/lib/audit-logger.ts`)                       | admin       | low                                                                                        |
| MongoDB + Mongoose schema plugins (`tenantIsolationPlugin`, audit plugin)     | persistence | low                                                                                        |
| Redis + BullMQ (`@agent-platform/async-infra`)                                | persistence | low — shared Redis already deployed                                                        |
| `scrubPII` / `PIIVault` (inherited via executor)                              | runtime     | low                                                                                        |
| KMS for HMAC secret resolution                                                | infra       | low                                                                                        |

### 8.2 Downstream (depends on this feature)

| Consumer                                | Impact                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Kore.ai Agent Assist widget (external)  | Primary consumer; contract parity is the hard constraint                          |
| SmartAssist tenant operators (Admin)    | New admin surface for binding CRUD                                                |
| Observatory                             | New `agent_assist.*` trace events; no breaking change                             |
| Billing / usage pipelines               | Sessions tagged `source:"agent_assist_v1"` provide attribution; no schema change  |
| Future vendor facades (follow-up specs) | Reference implementation for `apps/runtime/src/services/<vendor>-compat/` pattern |

---

## 9. Open Questions & Decisions Needed

1. **HMAC secret rotation semantics.** Current design signs with whatever version `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` resolves to at delivery time. In-flight BullMQ jobs enqueued with an older secret are still signed with the new secret at delivery — breaking receiver verification until the receiver picks up the new key. Decision needed: (a) pin secret version at enqueue time and emit it in the signature header (`X-ABL-Signature: t=<ts>,v1=<hex>,k=<versionId>`), or (b) require receivers to accept a grace window with overlapping keys. Leaning toward (a). Tracked in test spec §13 item 1.
2. **Admin RBAC beyond tenant scope.** Current design relies on the admin app's existing tenant-scoped RBAC — no new permission. If a sub-tenant admin needs to manage only their bindings (not the whole tenant), a per-project permission layer will be needed in a future spec. Not blocking Phase Actual.
3. **`GET /api/v2/apps/:appId/environments/:envName/sessions/:sessionId` public endpoint.** Kore.ai Agent Assist does not call it today. We do not implement it in Phase Actual. Open: will follow-up consumers need it? If yes, spec later as additive.
4. **DLQ UI / replay workflow.** Operators need a way to inspect + replay DLQ entries. Phase Actual ships the DLQ queue + records; the replay UI is a follow-up spec. Interim: operators use BullMQ CLI / existing queue dashboards.
5. **Placeholder mode.** RESOLVED — the POC keyword-matched placeholder responder and the `status:"placeholder"` binding mode have been removed. `BindingStatus` is `"active" | "disabled"` only; every turn runs through the real executor.

---

## 10. References

- Feature spec: [docs/features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
- Test spec: [docs/testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)
- Peer feature HLDs:
  - [a2a-integration.hld.md](a2a-integration.hld.md) (async-push + HMAC + DLQ pattern)
  - [sdk.md](../features/sdk.md) (`SessionService` + auth model)
  - [workflows-execute pattern](../../apps/runtime/src/routes/workflows-execute.ts) (closest peer architecturally)
- Runtime code references:
  - `apps/runtime/src/routes/chat.ts` — native chat `/api/v1/chat/agent` entrypoint + existing `session:send_message` permission enforcement (search `requirePermission('session:send_message')`)
  - `apps/runtime/src/services/runtime-executor.ts` — `createSessionFromResolved`, `executeMessage`, `endSession`, `resolveScrubPII` (PII pipeline)
  - `apps/runtime/src/services/deployment-resolver.ts` — `DeploymentResolver.resolve`

> Note on line numbers: method names are stable; line numbers drift with every commit to `runtime-executor.ts` / `chat.ts`. The HLD deliberately references by method name only — the LLD pins concrete call sites at implementation time against the then-current HEAD.

- External contract reference: [https://docs.kore.ai/agent-platform/apis/agentic-apps/sessions](https://docs.kore.ai/agent-platform/apis/agentic-apps/sessions)
- JIRA: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
