# Feature: Agent Assist V1 Compatibility Facade

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `customer experience`, `agent lifecycle`, `observability`, `enterprise`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/shared-auth`, `packages/shared-kernel`, `packages/i18n`
**Owner(s)**: Platform team (runtime + integrations)
**Testing Guide**: [../testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)
**Public API Reference**: [../guides/agent-assist-api.md](../guides/agent-assist-api.md)
**JIRA**: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
**Last Updated**: 2026-04-25

---

## 1. Introduction / Overview

### Problem Statement

Kore.ai Agent Assist — the contact-center widget embedded in XO / SmartAssist Agent Desktop — currently integrates with the legacy **Agentic Platform V1** service at `agent-platform.kore.ai`. That integration is a stored **Agentic Configuration** (App Name, Domain URL, Environment, App ID `aa-<uuid>`, API key `kg-<uuid>.<uuid>`) plus three V1 HTTP endpoints:

- `POST /api/v2/apps/:appId/environments/:envName/runs/execute`
- `POST /api/v2/apps/:appId/environments/:envName/sessions`
- `POST /api/v2/apps/:appId/environments/:envName/sessions/terminate`

As SmartAssist migrates from XO to **ABL V2 (Agents V2)**, that Kore.ai Agent Assist integration must keep working unchanged — every live Agent Desktop session would otherwise break for customers on the migrated tenants.

ABL V2 already has the primitives this integration needs: a project-scoped HTTP "execute a turn" endpoint (`POST /api/v1/chat/agent`) backed by `RuntimeExecutor.executeMessage`, plus full session lifecycle through `SessionService` and `RuntimeExecutor.createSessionFromResolved` / `endSession`. What it does **not** have is the V1 URL shape, the V1 request/response envelopes, the V1 SSE frame format, or the `aa-<uuid>` → `(tenantId, projectId, deploymentId)` indirection that Kore.ai Agent Assist relies on.

### Goal Statement

Ship one **thin, isolated V1 compatibility facade** on ABL Runtime that accepts the exact Agent Assist V1 request/response/SSE contract and translates it, in-process, onto ABL's **existing** session + execute primitives (`DeploymentResolver`, `RuntimeExecutor.createSessionFromResolved`, `RuntimeExecutor.executeMessage`, `RuntimeExecutor.endSession`). Adding this single facade is enough to let the existing Kore.ai Agent Assist deployment be repointed at ABL by changing only the Domain URL in the operator's Agentic Configuration.

### Summary

The feature ships one new public surface — the V1 facade at `/api/v2/apps/:appId/environments/:envName/...` — plus one new persisted data model, `AgentAssistBinding`, that maps the Kore.ai-facing `(appId, envName)` pair to ABL's `(tenantId, projectId, deploymentId?)`. Everything else reuses what ABL already has:

- Auth: `createUnifiedAuthMiddleware` → `req.tenantContext` + `session:send_message` permission (the same permission `POST /api/v1/chat/agent` enforces at `apps/runtime/src/routes/chat.ts:1444`). **No new permission scope is introduced.**
- Sessions: `RuntimeExecutor.createSessionFromResolved` on first turn (auto-creates a `HydratedSession` via `SessionService`), deterministic session ID per `(binding, sessionReference)` so V1 `sessions/terminate` can release the same id through `RuntimeExecutor.endSession`.
- Execution: `RuntimeExecutor.executeMessage(sessionId, userMessage, onChunk)` — identical call shape used by `POST /api/v1/chat/agent`. Streaming reuses the `onChunk` callback; no double-SSE loopback.
- Observability: `TraceStore` + a single `agent_assist.*` trace-event family registered in `packages/shared-kernel/src/constants/trace-event-registry.ts`.
- Rate limiting, PII redaction, feature gating, payload guards: reuse `tenantRateLimit`, the executor's existing `scrubPII` + `PIIVault` pipeline (resolved per tenant at `runtime-executor.ts:108` `resolveScrubPII`, applied at `runtime-executor.ts:2187` event-scrubber hook, backed by `PIIVault` from `@abl/compiler/platform`), `feature-gate.ts`, and the standard size caps.

Delivery is phased as:

- **Phase POC (committed, retired).** Single env-seeded `AgentAssistBinding`, placeholder responder OR real executor, sync + SSE, fire-and-forget async callback, session envelopes synthesized in-process, `sessions/terminate` was a 400 stub. Proven end-to-end against a real Kore.ai Agent Assist widget via ngrok. The POC code paths (env-seeded resolver, kill-switch env var, placeholder responder) were retired during Phase Actual implementation — see §16 GAP-006/009 and the `[ABLP-390] refactor(runtime): retire agentic-compat POC path` commit.
- **Phase Actual (this spec — shipped 2026-04-25 on branch `KI081/feat/ABLP-390-agent-assist-runtime-compat`, ALPHA).** Persisted `AgentAssistBinding` to MongoDB; binding CRUD shipped on two surfaces — Studio project-scoped (`/api/projects/:projectId/agent-assist-bindings`) and runtime platform-admin (`/api/platform/admin/agent-assist`); replaced POC fire-and-forget async with BullMQ + HMAC + retry + DLQ; wired the real `sessions/terminate` onto `RuntimeExecutor.endSession`; registered the `agent_assist.*` trace event family; added the `agent_assist` per-tenant feature gate + per-project enable toggle.

### What this spec does NOT add

These were considered and deferred deliberately. Each is listed again in §2.2 (Non-Goals) with the rationale:

1. **No new "Agent Suggestions" public API.** The prior draft of this spec proposed a canonical, provider-neutral service at `/api/v1/projects/:projectId/agent-suggestions/...`. That is not in scope. Other agent-assist vendors (Google CCAI, Amazon Q in Connect, Cresta) either integrate directly against the existing `POST /api/v1/chat/agent` or ship as a peer facade module following exactly the pattern this spec establishes.
2. **No new permission scope.** No `agent_suggestions:execute`. The facade reuses `session:send_message`.
3. **No new typed contract in `shared-kernel` for suggestion types.** `AgentSuggestion` discriminated union does not exist — the facade works in V1 envelope shapes only.
4. **No Studio UI for binding CRUD in Phase Actual.** Admin CRUD only; project-scoped Studio panel is a follow-up behind its own spec.

---

## 2. Scope

### 2.1 Goals

- Expose the three V1 endpoints (`runs/execute`, `sessions`, `sessions/terminate`) at `/api/v2/apps/:appId/environments/:envName/...` with behaviour byte-compatible with what Kore.ai Agent Assist sends/receives today (documented in `docs/poc/agent-assist-runtime-compat-poc-reference.md` §5–§7).
- Persist `AgentAssistBinding` in MongoDB with tenant isolation, audit logging, and Admin CRUD — this is the only net-new data model.
- Reuse ABL's existing session + execute primitives in-process: `DeploymentResolver`, `RuntimeExecutor.createSessionFromResolved`, `RuntimeExecutor.executeMessage`, `RuntimeExecutor.endSession`. No HTTP loopback to `POST /api/v1/chat/agent`.
- Reuse ABL's existing auth pipeline (`createUnifiedAuthMiddleware`, `resolveApiKey`, `req.tenantContext`) and enforce the existing `session:send_message` permission.
- Support all three V1 transport modes that Kore.ai Agent Assist actually uses: sync JSON, async-push via `isAsync:true + callbackUrl` (primary mode in production), and SSE via `stream.enable:true`.
- Gate the facade behind a single per-tenant `agent_assist` feature flag resolved through `apps/runtime/src/middleware/feature-gate.ts`.
- Emit one new trace-event family `agent_assist.*` for facade-boundary concerns; underlying execution continues to emit its existing trace events unchanged.
- Document the pattern clearly enough that a second vendor-specific facade (Google CCAI, Amazon Q in Connect) can be added later as a peer module under `apps/runtime/src/services/<vendor>-compat/` without forking this one.

### 2.2 Non-Goals (Out of Scope)

- **New public API surface for agent-assist workloads.** No `/api/v1/projects/:projectId/agent-suggestions/...`, no `AgentSuggestion` discriminated-union contract, no `POST /suggest` one-shot endpoint. Other vendors either use `POST /api/v1/chat/agent` directly or ship as a peer facade. Rationale: the only driving use case is Kore.ai Agent Assist; any broader surface would be designing for hypothetical future requirements.
- **New permission scope.** No `agent_suggestions:execute`. The facade enforces `session:send_message` — the same permission `POST /api/v1/chat/agent` already enforces for the same underlying operation.
- **Typed suggestion contracts in `shared-kernel`.** No `AgentSuggestion`, `AgentSuggestionsTurnRequest`, or `AgentSuggestionsSession` types. The facade's internal translators operate on V1 envelope shapes and the existing `ExecutionResult` produced by `RuntimeExecutor`.
- **Studio UI for binding CRUD.** Phase Actual ships Admin-only binding management. A project-scoped Studio panel is a follow-up feature.
- **Additional vendor facades.** Google CCAI, Amazon Q in Connect, Cresta, Twilio Flex Agent Assist, Observe.AI, bespoke widgets — all out of scope. This spec sets the pattern; future specs ship peer modules.
- **Modifying Kore.ai Agent Assist's widget, design-time UI, or stored Agentic Configuration shape.** ABL server-side only.
- **Imitating V1 API-key format.** ABL's unified-auth accepts any `x-api-key` prefix. Operators may re-register the original `kg-<uuid>.<uuid>` key directly in `api_keys` (as done in POC — see `docs/poc/agent-assist-runtime-compat-poc-reference.md` §3.2) or mint a fresh ABL key; either works.
- **Registering a new runtime Channel.** Both this facade and `POST /api/v1/chat/agent` are HTTP services with `channelType: "api"`. The analogue is `workflows-execute.ts`, not `a2a-integration.md`.
- **Rebuilding native chat, SDK, A2A, or workflow-execute.** The facade is peer to those surfaces, not a replacement.
- **V1 features Kore.ai Agent Assist does not consume.** `streamMode:"messages"`, `invoke.tasks`, `attachments`, `additionalArgs` — accepted in the schema for forward-compat but not wired beyond schema acceptance.

---

## 3. User Stories

1. **As a Kore.ai Agent Assist platform operator**, I want to repoint an existing Agentic Configuration from `agent-platform.kore.ai` to an ABL tenant by changing only the Domain URL (and optionally the API key) in the configuration form, so I can migrate SmartAssist from XO to ABL V2 without any Agent Assist code change or widget re-release.
2. **As a Contact Center human agent**, I want the V1 suggestion stream in my Agent Desktop widget to keep working unchanged after my tenant is migrated to ABL, so my workflow, latency, and UI controls remain identical.
3. **As an ABL tenant admin**, I want to create an `AgentAssistBinding` mapping a Kore.ai `appId` + environment to one of my ABL projects and deployments via the Admin API, with audit logging of who created, updated, or disabled each binding, so I can onboard multiple SmartAssist tenants and prove the configuration trail for compliance review.
4. **As an ABL runtime operator**, I want every facade request to emit `agent_assist.*` trace events, write the same session/message records as native chat, and tag `session.data.values._metadata._agentAssist = { facade:"agent_assist_v1", appId, environment, bindingId, apiKeyId }`, so I can debug, audit, and bill V1-facade traffic through the same Observatory + trace + billing pipelines as `POST /api/v1/chat/agent`.
5. **As a security engineer**, I want any cross-tenant, cross-project, or kill-switch-off request to return `404 APP_NOT_FOUND` with a sanitized message — never 403 — so the facade cannot be used to enumerate other tenants' `appId` bindings or leak tenant existence.
6. **As an ABL platform engineer adding a second vendor integration later (e.g., Google CCAI)**, I want this facade to be structured as an isolated module (`apps/runtime/src/services/agent-assist/*` + `apps/runtime/src/routes/agent-assist.ts`) with no Kore.ai-specific bleed into the core runtime, so I can copy the pattern into `apps/runtime/src/services/<vendor>-compat/` and ship a peer facade without refactoring shared code.

---

## 4. Functional Requirements

Requirements are grouped by area. Every FR is testable. Phase annotations (POC / Actual) appear in §13 Delivery Plan.

### 4.1 HTTP surface & envelopes

1. **FR-1**: The system must mount a router at `/api/v2/apps/:appId/environments/:envName` on `apps/runtime/src/server.ts` implementing three endpoints: `POST /sessions`, `POST /runs/execute`, `POST /sessions/terminate`.
2. **FR-2**: The system must validate every request body with a Zod `.strict()` schema matching the payload Kore.ai Agent Assist sends today (see `docs/poc/agent-assist-runtime-compat-poc-reference.md` §6 and `apps/runtime/src/routes/agent-assist.schemas.ts`), and reject malformed bodies with `HTTP 400 { error: { code: "INVALID_INPUT", message } }`.
3. **FR-3**: The system must enforce payload size caps before invoking any executor: total body ≤ `AGENT_ASSIST_MAX_BODY_BYTES` (default 512 KiB), per-input text ≤ `AGENT_ASSIST_MAX_INPUT_CHARS` (default 16 000), parsed `metadata.aa_uamsgs` ≤ `AGENT_ASSIST_MAX_AA_HISTORY_MSGS` (default 50). Violations return `HTTP 413 { error: { code: "PAYLOAD_TOO_LARGE", message } }`.
4. **FR-4**: `POST /runs/execute` must return the V1 sync envelope on success:
   ```json
   { "messageId": "msg_<uuid>", "output": [{"type":"text","content":"<reply>"}],
     "sessionInfo": {"sessionId","runId","status":"completed","appId","sessionReference","userReference","userId","source"},
     "metadata": <echoed body.metadata> }
   ```
5. **FR-5**: `POST /runs/execute` with `stream.enable:true` must respond with `Content-Type: text/event-stream` and emit V1 SSE frames `data: {eventIndex, isLastEvent, messageId?, output?, sessionInfo?, metadata?}\n\n`. Frame 0 carries `sessionInfo.status:"processing"` and `isLastEvent:false`; delta frames carry `output[{type:"text",content:"<partial>"}]`; the final frame carries `sessionInfo.status:"completed"` and `isLastEvent:true`. A heartbeat `: heartbeat\n\n` must be written every `AGENT_ASSIST_SSE_HEARTBEAT_MS` (default 15 s).
6. **FR-6**: `POST /runs/execute` with `isAsync:true` + a usable absolute `callbackUrl` must synchronously return `HTTP 202 { messageId, output:[{type:"text",content:""}], sessionInfo:{status:"processing",...}, metadata }` and schedule an out-of-band delivery of the full sync envelope to `callbackUrl` (see §4.6 async-push).
7. **FR-7**: `POST /sessions` must return the V1 session envelope `{ session, events, output, allowedMimeTypes, fileUploadConfig }`. The envelope is synthesized locally from the binding + request body; the underlying `HydratedSession` is NOT pre-created (that happens lazily on the first `runs/execute` turn via `RuntimeExecutor.createSessionFromResolved`). The `session.sessionId` returned here is the deterministic id (see FR-14) that subsequent turns will address. Deployment resolution is touched only when the caller requests a welcome (FR-8); it is a pure read of the resolved `AgentIR` and does not materialize a session.
8. **FR-8**: `POST /sessions` must emit a single `Welcome_Event` in the response `events[]` when `metadata.isSendWelcomeMessage === true`. The `content.messageToUser` is resolved from the binding's active deployment by the priority chain `AgentIR.on_start.respond` → `AgentIR.messages.greeting` → `DEFAULT_MESSAGES.greeting` (see `apps/runtime/src/services/agent-assist/welcome-resolver.ts`). Entries whose text contains unresolved `{{placeholder}}` templates are skipped because no session variables exist at sessions-create time. Welcome resolution is best-effort: on `DeploymentResolver` failure the facade logs and emits an empty `Welcome_Event` rather than returning 5xx. When `isSendWelcomeMessage !== true`, `events` is an empty array and `output` is an empty array.
9. **FR-9**: `POST /sessions/terminate` must resolve the target session id from `sessionIdentity[]` (priority: `sessionId` > `sessionReference` > `userReference`), call `RuntimeExecutor.endSession(sessionId)` (see `apps/runtime/src/services/runtime-executor.ts:3968`), and return the V1 terminate envelope `{ status:"terminated", userReference, sessionReference, userId, sessionId, appId, attachments:[] }`. Terminating an unknown session must still return the same success shape — the V1 contract is idempotent on terminate.

### 4.2 Authentication, authorization, isolation

10. **FR-10**: The system must authenticate every facade request via `createUnifiedAuthMiddleware` (shared-auth) resolving `req.headers['x-api-key']` to a `req.tenantContext` carrying `{ tenantId, apiKeyId, scopes, projectScope, environments, authType:'api_key' }`. Requests missing a key or whose key cannot be resolved receive `HTTP 401 { error: "Authentication required" }` or `HTTP 401 { error: "Invalid or expired API key" }`.
11. **FR-11**: The system must enforce the existing `session:send_message` permission on the authenticated principal — the same permission `POST /api/v1/chat/agent` enforces at `apps/runtime/src/routes/chat.ts:1444`. No new permission scope is introduced.
12. **FR-12**: The system must resolve the requested `(appId, envName)` to an `AgentAssistBinding` and enforce isolation: if the binding does not exist, is `status:"disabled"`, has a `tenantId` that does not match `req.tenantContext.tenantId`, or has a `projectId` not included in the API key's `projectScope` when that scope is set, the request must respond `HTTP 404 { error: { code: "APP_NOT_FOUND", message } }` (never 403), per CLAUDE.md's existence-disclosure invariant.
13. **FR-13**: Env-name match must be case-insensitive (Kore.ai Agent Assist sends `"Dev"` and `"dev"` interchangeably; see `binding-resolver.ts` current POC behaviour). The binding is stored lower-cased.

### 4.3 Binding resolution & session keying

14. **FR-14**: The system must materialize a stable `externalReference` per `(binding, sessionReference)` — formed as `<apiKeyId ?? tenantId:appId:environment>:<sessionReference>` — and deterministically derive the ABL `sessionId` from it via UUIDv5 (or SHA-1 fallback) against a fixed namespace, so two different bindings within the same project never share a session even when the caller re-uses the same `sessionReference` string, and re-calls from the same binding + `sessionReference` always address the same session.
15. **FR-15**: The system must persist `AgentAssistBinding` documents in a new MongoDB collection `agent_assist_bindings` (§9 Data Model) with unique index on `(tenantId, appId, environment)` and tenant isolation enforced via `tenantIsolationPlugin`.
16. **FR-16**: The system must resolve bindings via a project-level repo (`apps/runtime/src/repos/agent-assist-binding-repo.ts`) with a short-TTL in-process read cache (e.g. 60 s) that is never authoritative — any Admin CRUD mutation invalidates the cache entry on the mutating pod and relies on cache TTL on other pods.

### 4.4 Execution delegation (reusing existing primitives)

17. **FR-17**: The system must delegate every turn to ABL's existing in-process execution pipeline — **no HTTP loopback**, no new execution engine. Specifically:
    - Resolve the target agent via `new DeploymentResolver(getSessionService()).resolve({ projectId, tenantId, deploymentId?, environment })` (see `apps/runtime/src/services/deployment-resolver.ts`).
    - Create or re-use the `HydratedSession` via `getRuntimeExecutor().getSession(sessionId)` then `createSessionFromResolved(resolved, { sessionId, tenantId, projectId, userId, channelType:"api", deploymentId, callerContext, metadata })` (see `runtime-executor.ts:1142`).
    - Run the turn via `executor.executeMessage(session.id, userMessage, onChunk, undefined, { channelMetadata: { channel:"agent-assist-v1", contentLength } })` (see `runtime-executor.ts:2460`).
18. **FR-18**: The facade must stamp session `callerContext` as `{ tenantId, channel:"api", initiatedById: userId, identityTier: 0, verificationMethod: "none" }` on creation. Facade-specific context (source, facade tag, appId, environment, bindingId, apiKeyId, externalReference) must live under `session.data.values._metadata._agentAssist` — NOT inside `callerContext` — to conform to shared-auth's strict `CallerContext` shape.
19. **FR-19**: SSE streaming must reuse `executor.executeMessage`'s `onChunk` callback to write V1 delta frames as they arrive. The facade must not call `POST /api/v1/chat/stream` (HTTP loopback) or introduce a parallel streaming path.
20. **FR-20**: The facade must NOT forward arbitrary V1 `metadata` into `executeMessage`'s `messageMetadata` parameter. V1 metadata may contain shapes (`aa_uamsgs` history, arbitrary operator objects) that are not valid `SdkMessageMetadata`. Phase Actual must validate a sanitized subset (conversationId, botId, language, source) against `SdkMessageMetadata` and forward only that; everything else must be stamped on `session.data.values._metadata._agentAssist` only.
21. **FR-21**: The facade must strip these reserved keys from incoming V1 `metadata` before any forwarding or internal stamping: `history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId` (existing `AGENT_ASSIST_RESERVED_METADATA_KEYS` set).

### 4.5 Runtime error rendering

22. **FR-22** (split for traceability into two independently testable rules):
    - **FR-22a** — Pre-execution failures (validation, auth, payload-size, feature-gate, kill-switch) must use standard HTTP status codes (`400`, `401`, `404`, `413`, `429`) with a structured `{ error: { code, message } }` body. These short-circuit before `RuntimeExecutor` is invoked.
    - **FR-22b** — Execution-time failures raised inside `RuntimeExecutor.executeMessage` (LLM errors, tool errors, deployment-resolve failures, handoff errors) must be rendered as `HTTP 200` with `sessionInfo.status:"error"` and `output[0].content` populated with a sanitized operator message (e.g. `"Agent is unable to process your request. Please try again in a moment."`). HTTP-200-for-runtime-error is intentional — the Kore.ai Agent Assist widget classifies errors by `sessionInfo.status`, not HTTP code.
23. **FR-23**: User-visible error strings must never include tenant IDs, project IDs, model IDs, credential hints, or deployment internals — these stay in logs and traces per CLAUDE.md's User-Facing Runtime Error Sanitization invariant.

### 4.6 Async-push callback delivery

24. **FR-24**: The system must enqueue a BullMQ job (queue: `agent-assist-callback`, job name: `deliver-v1-envelope`) for every `isAsync:true` request. The job handler runs the same in-process execution pipeline (FR-17), builds the V1 envelope, and POSTs it to `callbackUrl` with headers `Content-Type: application/json`, `User-Agent: abl-agent-assist/<version>`, `X-ABL-Source: agent-assist-v1`, plus HMAC-SHA256 signature header `X-ABL-Signature: t=<unix-ts>,v1=<hex>` keyed on `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF`.
25. **FR-25**: Callback delivery must retry with exponential backoff (defaults: max 5 attempts, base 1 s, cap 30 s) on non-2xx responses or transport errors; after the final failed attempt the job must move to a dead-letter queue (`agent-assist-callback-dlq`) with the full request/response trail for operator inspection. Absolute URLs only — relative `callbackUrl` values must be refused by the HTTP sender and logged.
26. **FR-26**: `isAsync:true` requests without a usable absolute `callbackUrl` must return `HTTP 400 { error: { code: "CALLBACK_URL_REQUIRED", message } }`. Simultaneous `stream.enable:true + isAsync:true` must treat streaming as the authoritative delivery channel and skip the callback (see POC §7.4).

### 4.7 Feature gating, rate limiting, observability

27. **FR-27 (revised 2026-05-04)**: The Agent Assist facade is universally available — there is no tenant-level feature gate. Operators control rollout per project via `ProjectAgentAssistSettings.enabled` (Studio toggle, FR-12-style enforcement inside `resolveAndAuthorize`). When that project toggle is `false` the facade returns `HTTP 404 { error: { code:"APP_NOT_FOUND" } }` — same envelope as a missing binding, preserving the existence-disclosure invariant. Rationale: the facade is a compatibility shim for repointing existing Kore.ai Agent Assist Configurations at ABL, so a paid-tier or Deal-level gate would block the very migration path it exists to enable. The pattern matches Agent Transfer (no plan/Deal gate). Superseded behaviour (Phase Actual ALPHA): a `requireFacadeFeature` middleware checked `PLAN_FEATURES['agent_assist']` and Deal grants — that middleware is no longer wired into the router. The standalone export remains for now to keep its unit tests green and to reserve the option of re-introducing tenant-level gating without a re-implementation.
28. **FR-28**: The system must apply the existing `tenantRateLimit('request')` middleware to facade routes, matching the envelope used by `POST /api/v1/chat/agent` and `workflows-execute.ts`.
29. **FR-29**: The system must emit these trace events on every facade request through `TraceStore`: `agent_assist.received`, `agent_assist.binding_resolved`, `agent_assist.delegated`, `agent_assist.translated_response`, `agent_assist.error`, `agent_assist.callback_scheduled`, `agent_assist.callback_delivered`, `agent_assist.callback_failed`. No `agent_suggestions.*` trace family is introduced — underlying `RuntimeExecutor.executeMessage` continues to emit its existing execution events unchanged.
30. **FR-30**: Session metadata must stamp `session.data.values._metadata._agentAssist.source = "agent_assist_v1"`. The `facade` tag stays `"agent_assist_v1"`. Observatory / billing / cleanup scripts filter on that `source` value.

### 4.8 Admin surface

31. **FR-31**: The system must expose binding CRUD on **two surfaces**, both wired to the same Mongo-backed repo:
    - **Project-scoped (Studio)**: `/api/projects/:projectId/agent-assist-bindings` — `GET` (list), `POST` (create), `GET /:bindingId`, `PATCH /:bindingId`, `DELETE /:bindingId`, `POST /:bindingId/disable`, `POST /:bindingId/enable`, `POST /:bindingId/generate-api-key` (mints/rotates the `abl_<token>` and persists `apiKeyId` + `apiKeyPrefix`), `GET /settings`, `PUT /settings` (per-project enable toggle). Studio Next.js routes under `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/...` proxy to the runtime express router `apps/runtime/src/routes/project-agent-assist-bindings.ts`.
    - **Platform-admin tenant-scoped**: `/api/platform/admin/agent-assist/tenants/:tenantId/bindings` (and `/:bindingId`, `/:bindingId/enable`, `/:bindingId/disable`) — runtime express router `apps/runtime/src/routes/platform-admin-agent-assist.ts`.
      Mutating calls write audit entries via the runtime's standard `writeAuditLog` (with `action: 'project:compat-binding-*'` for project surface and `action: 'platform_admin:compat-binding-*'` for platform-admin surface). The Next.js admin app (`apps/admin`) does **not** ship a binding-CRUD surface — the previously planned `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/...` tree was removed before merge as redundant with Studio's project-scoped routes.

---

## 5. Feature Classification & Integration Matrix

### 5.1 Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                                                          |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Bindings are project-scoped; project archive/delete must cascade to `agent_assist_bindings` rows and terminate active sessions.                |
| Agent lifecycle            | PRIMARY      | Every turn invokes the deployed agent for the binding's project/environment via the same `RuntimeExecutor.executeMessage` call as native chat. |
| Customer experience        | PRIMARY      | Contact-center human agents see the suggestions; latency + parity with the legacy XO path is directly user-visible.                            |
| Integrations / channels    | PRIMARY      | New HTTP integration surface tagged `channelType:"api"`; establishes the pattern for any future peer vendor facade.                            |
| Observability / tracing    | SECONDARY    | One new trace-event family `agent_assist.*`; underlying execution events unchanged.                                                            |
| Governance / controls      | SECONDARY    | One new feature flag `agent_assist`; Admin CRUD is audit-logged; no new RBAC scopes.                                                           |
| Enterprise / compliance    | SECONDARY    | PII, encryption, retention all inherited from the existing runtime pipeline — no new data-at-rest concerns beyond the binding collection.      |
| Admin / operator workflows | PRIMARY      | Admin API for binding CRUD is the primary operator surface shipped in Phase Actual.                                                            |

### 5.2 Related Feature Integration Matrix

| Related Feature                                                 | Relationship Type | Why It Matters                                                                                                                                         | Key Touchpoints                                                                                             | Current State |
| --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------- |
| [Native Chat Agent](native-agents.md)                           | depends on        | Facade delegates to the same `RuntimeExecutor.executeMessage` call that `POST /api/v1/chat/agent` uses; FR-11 reuses `session:send_message`            | `apps/runtime/src/routes/chat.ts:1358`, `runtime-executor.ts:2460`                                          | BETA          |
| [Deployments & Versioning](deployments-versioning.md)           | depends on        | Bindings resolve through `DeploymentResolver.resolve` to select the environment-active or pinned deployment                                            | `apps/runtime/src/services/deployment-resolver.ts`                                                          | BETA          |
| [A2A Integration](a2a-integration.md)                           | extends           | Reuses the boundary-metadata normalization pattern; async-push (FR-24/25) follows A2A's BullMQ + HMAC + retry + DLQ pattern                            | Boundary metadata normalization, BullMQ delivery jobs                                                       | BETA          |
| [SDK](sdk.md)                                                   | shares data with  | Session ownership, `callerContext` / `tenantContext` resolution, and rate limiting all go through the same middleware + `SessionService` stack         | `SessionService.createSession`, `tenantRateLimit('request')`                                                | BETA          |
| [Rate Limiting](rate-limiting.md)                               | depends on        | Facade reuses `tenantRateLimit('request')` without per-endpoint overrides                                                                              | `apps/runtime/src/middleware/rate-limiter.ts`                                                               | BETA          |
| [Tracing & Observability](tracing-observability.md)             | emits into        | Introduces `agent_assist.*` trace-event family; underlying events unchanged                                                                            | `TraceStore`, `packages/shared-kernel/src/constants/trace-event-registry.ts`                                | BETA          |
| [PII Detection](pii-detection.md)                               | depends on        | Incoming turns inherit the executor's existing `scrubPII` + `PIIVault` pipeline (same path as `chat/agent`)                                            | `runtime-executor.ts:108,2187`, `PIIVault` from `@abl/compiler/platform`                                    | BETA          |
| [Channels](channels.md)                                         | tested with       | Tagged `channelType:"api"` for billing/rate-limit consistency; does not create a `channel_connections` row                                             | `channelType:"api"`                                                                                         | STABLE        |
| [Tenant LLM Policy](tenant-llm-policy.md)                       | depends on        | Execution respects the same tenant model/budget policy as native chat                                                                                  | `ModelResolutionService.resolve`, budget reservation                                                        | ALPHA         |
| [Audit Logging](audit-logging.md)                               | emits into        | Binding CRUD writes audit entries for who/what/when on every mutation                                                                                  | `writeAuditLog` (runtime), action prefixes `project:compat-binding-*` and `platform_admin:compat-binding-*` | BETA          |
| [Unified Deployment Endpoints](unified-deployment-endpoints.md) | configured by     | Future migration target: `AgentAssistBinding` can graduate to a `DeploymentEndpoint` record with `targetType:"agent_assist_v1"` when that ships        | `DeploymentEndpoint`, `/api/v1/deployments/{slug}/endpoints/{path}`                                         | PLANNED       |
| [External Agent Host](external-agent-host.md)                   | peer              | Both expose ABL agents to external systems via a purpose-built HTTP surface; this feature is vendor-contract-shaped, External Agent Host is A2A-shaped | Project-scoped execution, permission-scoped keys                                                            | PLANNED       |

---

## 6. Design Considerations

- **One layer, no canonical surface.** This spec deliberately does not introduce a new "Agent Suggestions" public API. The only consumer driving the work is Kore.ai Agent Assist, and it already speaks the V1 contract. Any other agent-assist vendor has a choice: (a) integrate against the existing `POST /api/v1/chat/agent`, or (b) ship a peer facade under `apps/runtime/src/services/<vendor>-compat/` mirroring this one's structure. Building a canonical surface today would be designing for hypothetical future consumers — deferred until a second real consumer appears.
- **Binding indirection, not path hacking.** `AgentAssistBinding` is a genuinely new concept — nothing else in ABL maps `(appId, envName)` → `(tenantId, projectId, deploymentId)`. Without it, the facade would have to strip `aa-` off `appId` and assume it equals a `projectId`, which conflates namespaces, makes key rotation impossible, and leaks ABL internals into Kore.ai's stored config. The binding model migrates cleanly to `DeploymentEndpoint` when that feature ships.
- **In-process delegation, not HTTP loopback.** The facade and `RuntimeExecutor` live in the same Node process. Looping back through `POST /api/v1/chat/agent` would add JSON (de)serialization, a second auth pass (or a synthesized internal bearer), and — for streaming — double-SSE (consume one format, re-emit another). In-process delegation is the same pattern `workflows-execute.ts` uses.
- **Pure-function translators at the boundary.** `envelope-builder`, `metadata-normalizer`, `v1-sse-emitter`, `session-envelope`, `placeholder-responder`, `binding-resolver` are all pure functions and carry the bulk of the facade's testable logic. They are testable with zero platform mocks — exactly the architecture CLAUDE.md's "Test Architecture" rule demands.
- **Runtime errors as HTTP 200.** This is the one intentional deviation from ABL's `{success,error}` envelope convention, kept because the Kore.ai Agent Assist widget parses errors from `sessionInfo.status`, not HTTP status codes. The deviation is bounded to this facade's route handlers; nothing downstream changes.
- **POC parity.** The POC at `docs/poc/agent-assist-runtime-compat-poc*.md` emits the same logs, the same deterministic session ids, the same V1 envelopes, and the same isolation behaviour as Phase Actual. Phase Actual replaces the env-seeded binding resolver with a Mongo-backed repo, upgrades fire-and-forget async to BullMQ + HMAC + retry + DLQ, wires terminate onto `RuntimeExecutor.endSession`, and registers the trace events — the facade's external shape is unchanged.

---

## 7. Technical Considerations

- **Reuse, don't rebuild.** Every cross-cutting concern has a first-class implementation elsewhere in the runtime. Map them deliberately:
  - Auth: `createUnifiedAuthMiddleware` + `resolveApiKey` — do not hand-roll `x-api-key` parsing. CLAUDE.md's centralized-auth hook (`custom-auth-lint.sh`) blocks custom `jsonwebtoken` outside `packages/shared-auth/`.
  - Session: `SessionService.createSession` / `loadSession` / `deleteSession` via `RuntimeExecutor.createSessionFromResolved` / `endSession`. Do not write a session store.
  - Execution: `RuntimeExecutor.executeMessage`. Do not call LLM APIs from the facade.
  - PII: flows through the executor's existing `scrubPII`/`PIIVault` pipeline (`runtime-executor.ts:108,2187`). Do not add a facade-level PII pass.
  - Feature gating: `apps/runtime/src/middleware/feature-gate.ts`. Do not roll a bespoke flag check.
  - Audit logging: the runtime's `writeAuditLog` for binding CRUD (action prefixes `project:compat-binding-*` for the Studio path, `platform_admin:compat-binding-*` for the platform-admin path). Do not emit ad-hoc log lines as a substitute.
  - Async delivery: BullMQ + HMAC + retry + DLQ, same envelope as A2A async-push. Do not invent a new queue or signing scheme.
- **Closest peer is `workflows-execute.ts`.** Same auth shape (external API-key), same tenant/project scope enforcement, same executor reuse, same Zod-strict body validation, same structured error codes. Any architectural tension should be resolved by mirroring `workflows-execute.ts`, not `chat.ts` or `a2a-integration.ts`.
- **SSE heartbeat convention differs from `chat.ts`.** `chat.ts` uses SSE comment lines (`:\n\n`) as heartbeats. V1 clients reject named SSE events but accept comment lines, so the facade retains this heartbeat pattern (`AGENT_ASSIST_SSE_HEARTBEAT_MS = 15_000`).
- **Statelessness.** Neither the route handler nor the binding resolver holds request-scoped state beyond the request lifetime. The binding resolver's short-TTL read cache is never authoritative; any pod can serve any binding lookup after cache miss.
- **Extension point hygiene.** If/when a second vendor facade ships, it lives under `apps/runtime/src/services/<vendor>-compat/` with its own trace-event family, its own binding collection (or a polymorphic `integration_bindings` table, deferred), and its own feature flag. Nothing in `apps/runtime/src/services/agent-assist/` should grow Kore.ai-and-CCAI conditional branches — a new vendor means a new peer module.

---

## 8. How to Consume

### 8.1 Studio UI

A top-level **Settings → Agent Assist** page (`apps/studio/src/components/settings/AgentAssistSettingsPage.tsx`, sibling of Agent Transfer in the sidebar). Operators use it to:

- Toggle Agent Assist on/off for the current project (`PUT /settings`, persisted in `project_agent_assist_settings`).
- View, add, enable/disable, and delete bindings (one row per `(appId, environment)`).
- Mint or rotate the `abl_<token>` API key on a binding via the **Configuration** modal — the plaintext key is shown exactly once; the table afterwards displays only the recognizable plaintext **prefix** (e.g. `abl_f931…`) backed by `binding.apiKeyPrefix`.
- Copy the four values an external Agent Assist runtime needs (Domain URL, App ID, Environment, API Key) directly from the Configuration modal.

The page consumes Studio-side Next.js API routes that proxy to the runtime project-scoped router (see §8.5).

### 8.2 Surface Semantics Matrix

| Asset / Entity Type                        | Source of Truth / Ownership            | Design-Time Surface(s)                                                                                                                                                      | Editable or Read-Only?                                                       | Consumer Reference / Binding Model                                                               | Runtime Materialization / Resolution                                                      | Notes / Unsupported State                                                                                                           |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `AgentAssistBinding`                       | `agent_assist_bindings` MongoDB        | Studio **Settings → Agent Assist** page (project-scoped CRUD) + runtime platform-admin tenant-scoped router (`/api/platform/admin/agent-assist/tenants/:tenantId/bindings`) | Editable (create / update / enable / disable / delete / mint+rotate API key) | Caller references by `(appId, envName)` in URL path; resolver returns a canonical binding or 404 | Looked up per request with a short-TTL read cache; never authoritative in memory          | `status:"disabled"` is functionally equivalent to "not present" — 404 `APP_NOT_FOUND` is returned (existence-disclosure invariant). |
| Kore.ai Agent Assist `appId` (`aa-<uuid>`) | Kore.ai stored Agentic Configuration   | N/A on ABL side — it's a value held in Kore.ai's UI                                                                                                                         | Read-only from ABL's perspective                                             | Binding record stores `appId` verbatim; `(tenantId, appId, environment)` is the unique key       | Used only for binding lookup in the facade route handler; never reaches `RuntimeExecutor` | Format is not validated — ABL accepts any non-empty string so operators can re-use existing configurations.                         |
| V1 envelope shapes                         | Defined by Kore.ai Agent Platform docs | Implemented inside `apps/runtime/src/services/agent-assist/envelope-builder.ts` et al.                                                                                      | Read-only (internal translator types)                                        | Not consumer-visible — external callers see them as HTTP bodies                                  | Translators run inside the facade only; the canonical runtime path never sees V1 types    | Types `AgentSuggestion` / `AgentSuggestionsTurnRequest` etc. from the deferred canonical surface are NOT present.                   |

### 8.3 Design-Time vs Runtime Behavior

- **Design-time** (control plane): a project owner creates a binding from the Studio **Settings → Agent Assist** page (or a platform admin via the runtime platform-admin router). The binding record names a project, optionally a pinned deployment, a Kore.ai-facing `appId`, and an environment name.
- **Runtime** (data plane): Kore.ai Agent Assist's widget POSTs to `/api/v2/apps/:appId/environments/:envName/...`. The facade resolves the binding, delegates to the runtime's existing `RuntimeExecutor.executeMessage` pipeline against the bound project's active deployment, translates the response, and returns it.
- **Deterministic vs stored session ids**: the V1 `sessionId` visible to the caller is `s-<deterministic>` derived from `(binding, sessionReference)`. That same id is what ABL's `HydratedSession` uses, so `SessionService` / Observatory / traces all see one id per V1 conversation.
- **Aliases**: `callerContext.channel` is always `"api"`; `session.data.values._metadata._agentAssist.source` is `"agent_assist_v1"`; `session.data.values._metadata._agentAssist.facade` is `"agent_assist_v1"`.

### 8.4 API (Runtime)

| Method | Path                                                           | Purpose                                                                                                           |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v2/apps/:appId/environments/:envName/sessions`           | Create a V1 session envelope (synthesized locally; underlying ABL session lazily created on first `runs/execute`) |
| POST   | `/api/v2/apps/:appId/environments/:envName/runs/execute`       | Submit a turn — sync, SSE (`stream.enable:true`), or async-push (`isAsync:true`+`callbackUrl`)                    |
| POST   | `/api/v2/apps/:appId/environments/:envName/sessions/terminate` | End the deterministic session via `RuntimeExecutor.endSession` and return the V1 terminate envelope               |

### 8.5 API (Studio)

Project-scoped binding management. Studio Next.js routes under `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/...` proxy to the runtime express router (`apps/runtime/src/routes/project-agent-assist-bindings.ts`). Authorization: caller must hold `project:read` for `GET` and `project:manage` for mutations on the route's `:projectId`.

| Method | Path                                                                         | Purpose                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:projectId/agent-assist-bindings`                             | List bindings for this project (paginated)                                                                                                   |
| POST   | `/api/projects/:projectId/agent-assist-bindings`                             | Create a new binding (`appId` defaults to `projectId`)                                                                                       |
| GET    | `/api/projects/:projectId/agent-assist-bindings/:bindingId`                  | Get a single binding                                                                                                                         |
| PATCH  | `/api/projects/:projectId/agent-assist-bindings/:bindingId`                  | Update `displayName`, `deploymentId`, `runtimeBaseUrl`                                                                                       |
| DELETE | `/api/projects/:projectId/agent-assist-bindings/:bindingId`                  | Hard-delete a binding (also revokes any associated `apiKeyId`)                                                                               |
| POST   | `/api/projects/:projectId/agent-assist-bindings/:bindingId/disable`          | Set `status:"disabled"` — runtime returns 404 to facade callers                                                                              |
| POST   | `/api/projects/:projectId/agent-assist-bindings/:bindingId/enable`           | Set `status:"active"`                                                                                                                        |
| POST   | `/api/projects/:projectId/agent-assist-bindings/:bindingId/generate-api-key` | Mint or rotate the `abl_<token>`; revokes any previous key; returns plaintext **once** + persists `apiKeyId` + `apiKeyPrefix` on the binding |
| GET    | `/api/projects/:projectId/agent-assist-bindings/settings`                    | Get per-project Agent Assist enable toggle (`{ enabled: boolean }`)                                                                          |
| PUT    | `/api/projects/:projectId/agent-assist-bindings/settings`                    | Update the per-project enable toggle (persisted in `project_agent_assist_settings`)                                                          |

### 8.6 Admin / Platform-Admin Surface

There is **no `apps/admin`-side binding CRUD** — the previously planned Next.js admin tree was removed before merge as redundant with Studio's project-scoped routes (see §13 Task 3 deviation note).

Tenant-scoped binding management is exposed at the **runtime** layer for platform-admin tooling (RBAC enforced by the runtime's existing platform-admin guard, not by Studio):

| Method | Path                                                                             | Purpose                                                                         |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings`                    | Create a binding for any project in the named tenant                            |
| GET    | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings`                    | List bindings for the tenant (paginated)                                        |
| GET    | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/:bindingId`         | Get a single binding                                                            |
| PATCH  | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/:bindingId`         | Update `projectId`, `deploymentId`, `displayName`, `apiKeyId`, `runtimeBaseUrl` |
| POST   | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/:bindingId/disable` | Set `status:"disabled"`                                                         |
| POST   | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/:bindingId/enable`  | Set `status:"active"`                                                           |
| DELETE | `/api/platform/admin/agent-assist/tenants/:tenantId/bindings/:bindingId`         | Hard-delete a binding                                                           |

Both surfaces write audit entries via the runtime's standard `writeAuditLog` with action prefixes `project:compat-binding-*` (Studio path) and `platform_admin:compat-binding-*` (platform-admin path).

### 8.7 Channel / SDK / Voice / A2A / MCP Integration

Not a Channel, not an SDK transport. This facade is an HTTP-only integration peer to `workflows-execute` and `chat/agent`. No `channel_connections` row, no Channel Manifest, no voice surface. A2A and MCP are unaffected.

---

## 9. Data Model

### 9.1 New Collection: `agent_assist_bindings`

```text
Collection: agent_assist_bindings
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed, enforced by tenantIsolationPlugin)
  - projectId: string (required, indexed)
  - appId: string (required)                    // Kore.ai-facing, e.g. "aa-<uuid>"
  - environment: string (required, lowercased)  // e.g. "dev", "prod"
  - status: "active" | "disabled"               // binding enablement
  - deploymentId: string | null                 // null => resolve env-active at request time
  - apiKeyId: string | null                     // optional opaque label for session callerContext
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
```

**HMAC secret + callbackUrl are NOT stored on the binding.** The HMAC signing secret is a single global value resolved from `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` (KMS-backed). The per-call `callbackUrl` is provided by the caller in the `/runs/execute` body on every async-push request. Neither field is persisted in `agent_assist_bindings`.

### 9.2 Existing Surfaces Reused (no schema changes)

- `api_keys` — unchanged. Operators may register the original `kg-<uuid>.<uuid>` Kore.ai API key directly in this collection (POC pattern) or mint a fresh ABL key; both resolve identically through `resolveApiKey`.
- `sessions` — unchanged. Facade-produced sessions carry `data.values._metadata._agentAssist = { source:"agent_assist_v1", facade:"agent_assist_v1", appId, environment, bindingId, apiKeyId, externalReference }` in their existing `data.values._metadata` free-form namespace.
- `traces` / `TraceStore` — unchanged. New `agent_assist.*` event names registered in the existing `packages/shared-kernel/src/constants/trace-event-registry.ts`.
- `audit_log` — unchanged. Binding CRUD writes via the existing write path.

### 9.3 Key Relationships

- **Binding → Project**: one-to-many from project to bindings (same project can own multiple `(appId, envName)` pairs). Cascade: deleting a project must cascade-delete (or disable) its bindings.
- **Binding → Deployment**: optional — when `deploymentId` is set, the binding pins a specific deployment version. When null, each request resolves the environment-active deployment fresh.
- **Binding → ApiKey**: the Admin surface does not materialize a foreign-key to a specific `api_keys` row; the key presented at runtime must only satisfy tenant+projectScope isolation against the binding. `binding.apiKeyId` is an opaque label for `session.callerContext` traceability, not a FK.
- **Session → Binding**: every facade-produced session stamps `session.data.values._metadata._agentAssist.bindingId` with the resolved binding's id so Observatory filters can group by binding.

---

## 10. Key Implementation Files

### 10.1 Domain / Core Logic

| File                                                                  | Purpose                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/agent-assist/types.ts`                     | V1 shapes + `AgentAssistBinding` TS interface + execution-input type                    |
| `apps/runtime/src/services/agent-assist/constants.ts`                 | Env var names, size caps, reserved-key set, heartbeat/SSE constants, source/facade tags |
| `apps/runtime/src/services/agent-assist/binding-resolver.ts`          | Binding lookup — Mongo-backed repo + short-TTL cache                                    |
| `apps/runtime/src/services/agent-assist/metadata-normalizer.ts`       | Strip reserved keys, bound `aa_uamsgs`, coerce misc shapes                              |
| `apps/runtime/src/services/agent-assist/envelope-builder.ts`          | Build V1 sync + error envelopes                                                         |
| `apps/runtime/src/services/agent-assist/v1-sse-emitter.ts`            | Write V1 `data:`-only SSE frames with heartbeats                                        |
| `apps/runtime/src/services/agent-assist/execution-bridge.ts`          | Delegate to `DeploymentResolver` + `RuntimeExecutor.executeMessage` for every turn      |
| `apps/runtime/src/services/agent-assist/welcome-resolver.ts`          | Resolve Welcome_Event text from the binding's deployment IR (`on_start.respond` chain)  |
| `apps/runtime/src/services/agent-assist/session-envelope.ts`          | Synthesize V1 `sessions` create + terminate envelopes                                   |
| `apps/runtime/src/services/agent-assist/callback-sender.ts`           | Async-push delivery — thin wrapper around the BullMQ callback worker                    |
| `apps/runtime/src/services/agent-assist/debug-recorder.ts`            | Per-request JSON-lines capture (toggleable; dev-only)                                   |
| `apps/runtime/src/workers/agent-assist-callback-worker.ts`            | BullMQ worker running the execution pipeline + HMAC-signed POST                         |
| `apps/runtime/src/repos/agent-assist-binding-repo.ts`                 | Mongo repo with tenant-isolation plugin + LRU+TTL read cache                            |
| `apps/runtime/scripts/agent-assist-dlq-inspect.ts`                    | DLQ inspection CLI for the callback worker                                              |
| `packages/database/src/models/agent-assist-binding.model.ts`          | Mongoose model + schema (`agent_assist_bindings` collection)                            |
| `packages/database/src/models/project-agent-assist-settings.model.ts` | Per-project enable/disable settings model                                               |

### 10.2 Routes / Handlers

The runtime uses Express routers. Project-scoped binding management is exposed in **Studio** (Next.js App Router); there is no admin-app surface (the previously planned `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/...` tree was removed before merge — Studio's project-scoped routes are the canonical management surface).

| File                                                                                                | Purpose                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/agent-assist.ts`                                                           | Express router for the three V1 endpoints (mount `/api/v2/apps`)                                  |
| `apps/runtime/src/routes/agent-assist.schemas.ts`                                                   | Zod-strict request body schemas                                                                   |
| `apps/runtime/src/routes/project-agent-assist-bindings.ts`                                          | Express router for project-scoped binding CRUD (`/api/projects/:projectId/agent-assist-bindings`) |
| `apps/runtime/src/routes/platform-admin-agent-assist.ts`                                            | Express router for platform-admin tenant-scoped binding CRUD (`/api/platform/admin/agent-assist`) |
| `apps/runtime/src/server.ts`                                                                        | Mounts the V1 facade unconditionally + project-scoped + platform-admin routers                    |
| `apps/studio/src/lib/agent-assist-proxy.ts`                                                         | Studio → runtime proxy helper (auth-pass-through, SSE streaming with `no-transform`)              |
| `apps/studio/src/app/api/v2/apps/[appId]/environments/[envName]/runs/execute/route.ts`              | Public V1 facade proxy (sync / SSE / async-push)                                                  |
| `apps/studio/src/app/api/v2/apps/[appId]/environments/[envName]/sessions/route.ts`                  | Public V1 sessions proxy (welcome event served from binding's deployment IR)                      |
| `apps/studio/src/app/api/v2/apps/[appId]/environments/[envName]/sessions/terminate/route.ts`        | Public V1 sessions/terminate proxy                                                                |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/route.ts`                              | Studio binding CRUD: `GET` (list) + `POST` (create)                                               |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/[bindingId]/route.ts`                  | `GET` (detail), `PATCH` (update), `DELETE`                                                        |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/[bindingId]/enable/route.ts`           | `POST` to set `status:"active"`                                                                   |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/[bindingId]/disable/route.ts`          | `POST` to set `status:"disabled"`                                                                 |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/[bindingId]/generate-api-key/route.ts` | `POST` mints/rotates the `abl_<token>` key bound to a connection (returns plaintext once)         |
| `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/settings/route.ts`                     | `GET`/`PUT` per-project Agent Assist enable/disable settings                                      |

### 10.3 UI Components

| File                                                                               | Purpose                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/settings/AgentAssistSettingsPage.tsx`                  | Top-level Agent Assist settings page (sibling of Agent Transfer): enable toggle, connections table, add/regenerate/delete, Configuration modal with one-time plaintext key + key fingerprint |
| `apps/studio/src/api/agent-assist-bindings.ts` + `hooks/useAgentAssistBindings.ts` | API client + SWR hooks consumed by the settings page                                                                                                                                         |
| `apps/studio/src/config/navigation.ts` + `store/navigation-store.ts`               | Sidebar entry `settings-agent-assist` and `/settings/agent-assist` route segment                                                                                                             |
| `packages/i18n/locales/en/studio.json`                                             | `settings.agent_assist` namespace (separated from `settings.agent_transfer`)                                                                                                                 |

### 10.4 Jobs / Workers / Background Processes

| File                                                       | Purpose                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/workers/agent-assist-callback-worker.ts` | BullMQ worker on queue `agent-assist-callback`; reruns execution pipeline + HMAC POSTs to callbackUrl |
| BullMQ DLQ topology                                        | `agent-assist-callback-dlq` for terminal failures; observability hooks emit DLQ depth gauge           |
| `apps/runtime/scripts/agent-assist-dlq-inspect.ts`         | One-off DLQ inspection CLI for operators                                                              |

### 10.5 Tests

| File                                                                               | Type        | Coverage Focus                                                                               |
| ---------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/services/agent-assist/envelope-builder.test.ts`        | unit        | V1 sync + error envelope generation                                                          |
| `apps/runtime/src/__tests__/services/agent-assist/metadata-normalizer.test.ts`     | unit        | Reserved-key stripping, `aa_uamsgs` bounding, shape coercion                                 |
| `apps/runtime/src/__tests__/services/agent-assist/feature-gate.test.ts`            | unit        | `agent_assist` feature resolution via Deal / plan, project-level enable check                |
| `apps/runtime/src/__tests__/services/agent-assist/welcome-resolver.test.ts`        | unit        | `on_start.respond` → `messages.greeting` → default chain; `{{placeholder}}` skip rule        |
| `apps/runtime/src/__tests__/services/agent-assist/trace-events.test.ts`            | unit        | Trace-event emitters route through `setAgentAssistTraceEmitter`                              |
| `apps/runtime/src/__tests__/services/agent-assist/callback-signer.test.ts`         | unit        | HMAC SHA-256 sign + parse for `X-ABL-Signature: t=…,v1=…`                                    |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validator.test.ts`  | unit        | https-only, loopback / RFC1918 / link-local rejection                                        |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validation.test.ts` | unit        | Combined URL validation scenarios                                                            |
| `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts`               | unit        | Repo CRUD + LRU+TTL cache invalidation paths                                                 |
| `apps/runtime/src/__tests__/workers/agent-assist-callback-worker.test.ts`          | unit        | Worker job logic: retry, HMAC, DLQ on terminal failure                                       |
| `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts`                     | e2e         | Supertest against full Express app: auth, isolation 404, sync / stream / async, validation   |
| `apps/runtime/src/__tests__/routes/project-agent-assist-bindings.test.ts`          | e2e         | Project-scoped binding CRUD routes                                                           |
| `apps/runtime/src/__tests__/routes/platform-admin-agent-assist.test.ts`            | e2e         | Platform-admin tenant-scoped binding CRUD routes                                             |
| `apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts`     | integration | Real Mongo: tenant isolation, unique-index enforcement                                       |
| `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts`  | integration | Real BullMQ worker against an HTTP callback sink                                             |
| `apps/runtime/src/__tests__/integration/project-agent-assist-bindings.int.test.ts` | integration | Project-scoped binding CRUD against real Mongo                                               |
| `apps/runtime/src/__tests__/integration/platform-admin-agent-assist.int.test.ts`   | integration | Platform-admin binding CRUD against real Mongo                                               |
| `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts`                  | unit        | Studio → runtime proxy: header forwarding, body cap, SSE passthrough                         |
| `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`                | unit        | Registry contract: every `agent_assist.*` event in registry, RUNTIME_EVENT_TYPES, label sets |

---

## 11. Configuration

### 11.1 Environment Variables

| Variable                                   | Default                                 | Description                                         |
| ------------------------------------------ | --------------------------------------- | --------------------------------------------------- |
| `AGENT_ASSIST_MAX_BODY_BYTES`              | `524288` (512 KiB)                      | Max request body size; over → HTTP 413.             |
| `AGENT_ASSIST_MAX_INPUT_CHARS`             | `16000`                                 | Max per-input text length.                          |
| `AGENT_ASSIST_MAX_AA_HISTORY_MSGS`         | `50`                                    | Max messages accepted in `metadata.aa_uamsgs`.      |
| `AGENT_ASSIST_SSE_HEARTBEAT_MS`            | `15000`                                 | SSE heartbeat cadence (comment line `:\n\n`).       |
| `AGENT_ASSIST_CALLBACK_TIMEOUT_MS`         | `10000`                                 | Per-attempt HTTP timeout for async-push delivery.   |
| `AGENT_ASSIST_CALLBACK_MAX_ATTEMPTS`       | `5`                                     | Max BullMQ attempts before DLQ.                     |
| `AGENT_ASSIST_CALLBACK_SIGNING_SECRET`     | (required)                              | Secret used to sign `X-ABL-Signature` on callbacks. |
| `AGENT_ASSIST_DEBUG_RECORD` / `_DEBUG_LOG` | `false` / `/tmp/agent-assist-debug.log` | Optional per-request debug capture (dev only).      |

### 11.2 Runtime Configuration

- **Per-tenant feature gate**: `agent_assist` added to the appropriate entries in `PLAN_FEATURES` in `packages/shared-kernel/src/constants/plan-features.ts`; resolved per request via `apps/runtime/src/middleware/feature-gate.ts` (existing `requireFeature('agent_assist')`).
- **Rate limiting**: uses the existing `tenantRateLimit('request')` envelope — no facade-specific overrides.
- **Size caps**: all caps configurable via the env vars in §11.1; documented default values are safe for current Kore.ai Agent Assist traffic patterns.

### 11.3 DSL / Agent IR / Schema

No DSL / Agent IR changes. Agents are invoked through the standard `RuntimeExecutor` path; nothing new appears in the compiled IR.

---

## 12. Non-Functional Concerns

### 12.1 Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every facade request resolves a binding whose `projectId` must be in the API key's `projectScope` when that scope is set; mismatches return 404. Every underlying `RuntimeExecutor` call is scoped to `binding.projectId`. `agent_assist_bindings` queries always include `{ tenantId, projectId }` where applicable.                                                               |
| Tenant isolation  | Every facade request resolves a binding whose `tenantId` must match `req.tenantContext.tenantId`; mismatches return 404. `agent_assist_bindings` queries always include `tenantId`; the collection uses `tenantIsolationPlugin` so there is no ALS-free access path. Cross-tenant resolver hits are logged at warn level.                                                           |
| User isolation    | API-key principals are machine principals — no per-end-user ownership is enforced beyond tenant+project scope. Sessions are addressable by the deterministic id; a second caller holding the same API key could in principle address the same session via the same `sessionReference`. That matches native `POST /api/v1/chat/agent` behaviour; no new isolation gap is introduced. |

### 12.2 Security & Compliance

- **Authn**: `x-api-key` → `createUnifiedAuthMiddleware` → `resolveApiKey`. No custom token parsing. CLAUDE.md's `custom-auth-lint.sh` PreToolUse hook blocks `jsonwebtoken` outside shared-auth.
- **Authz**: `session:send_message` only — reuses the existing permission boundary for the underlying operation.
- **Transport**: HTTPS terminated at the ingress; the facade never issues its own cert or handshakes.
- **Secrets**: `AGENT_ASSIST_CALLBACK_SIGNING_SECRET` (env-resolved; KMS-backed in production); raw values never logged. Per-binding `abl_<token>` API keys are minted from the Studio Configuration modal — the plaintext is shown exactly once and only the hash + prefix are persisted.
- **Audit**: binding CRUD writes audit entries via the runtime's `writeAuditLog` — Studio project-scoped path uses `action: 'project:compat-binding-{create|update|enable|disable|delete|api-key-generate|api-key-revoke}'`; platform-admin path uses `action: 'platform_admin:compat-binding-*'`. Execution audit (per-turn) inherits the existing runtime execution audit trail.
- **PII**: incoming turns flow through the executor's existing `scrubPII` + `PIIVault` hook (`runtime-executor.ts:108,2187`) — no facade-level PII surface.
- **Error sanitization**: user-visible error strings never carry tenant IDs, project IDs, model IDs, or credential hints (CLAUDE.md invariant). Logs and traces retain the full context.

### 12.3 Performance & Scalability

- **Latency budget**: p50 ≤ 50 ms facade-side overhead (route handler + binding lookup + envelope translation) — dominated by the underlying `executeMessage` call. The binding lookup hits the 60 s read cache on steady-state traffic.
- **Throughput**: must match the existing `POST /api/v1/chat/agent` ceiling — the facade adds one translator pass and one binding lookup per request.
- **SSE**: single-writer per connection; emitter writes are non-blocking; heartbeat loop never synchronizes with content flushes.
- **Async-push**: BullMQ worker runs in the standard runtime worker pool; delivery attempts run in parallel across pods; per-binding delivery order is NOT preserved (Kore.ai Agent Assist's widget does not require ordered callback delivery within a conversation because each `runId` is independent).
- **Binding collection size**: expected ≪ 10k rows cluster-wide; reads are fully covered by the `(tenantId, appId, environment)` unique index.

### 12.4 Reliability & Failure Modes

- **Feature gate off**: returns 404 APP_NOT_FOUND — indistinguishable from "no binding" so tenant-level rollout state is not observable externally. (The previously planned `AGENT_ASSIST_ENABLED` global kill switch was retired during implementation: the `agent_assist` per-tenant feature flag + project-level enable toggle in Studio cover the same operational need without a global env-var foot-gun.)
- **Binding lookup miss**: 404 APP_NOT_FOUND; no executor call.
- **Deployment resolution failure**: bubbled as HTTP 200 `sessionInfo.status:"error"` with a sanitized message (FR-22); original error logged at warn level.
- **`executeMessage` failure**: sanitized error → HTTP 200 with `sessionInfo.status:"error"`; the session remains created so subsequent turns can retry.
- **Async-push**: up to 5 attempts with exponential backoff; terminal failure moves to `agent-assist-callback-dlq` with the full request/response trail. Operators alert on DLQ depth > 10 over 15 min.
- **Idempotency**: `sessions/terminate` on an unknown sessionId is a no-op success; `runs/execute` is NOT idempotent on repeated calls (matches V1 contract — each turn is independent).

### 12.5 Observability

- **Traces**: `agent_assist.*` family registered in `packages/shared-kernel/src/constants/trace-event-registry.ts`; every request emits at minimum `agent_assist.received` and one terminal event (`translated_response` or `error`).
- **Metrics**: counters per outcome (`agent_assist_requests_total{route,status,tenantId,outcome}`), p50/p95/p99 facade latency histograms, async-push delivery duration histogram, DLQ depth gauge. Emitted through the existing metrics store.
- **Logs**: structured logs via `createLogger('agent-assist:*')` — no `console.log` (CLAUDE.md `console-log-lint.sh`). Debug recorder retained behind `AGENT_ASSIST_DEBUG_RECORD=true` for dev-only per-request capture.
- **Observatory filters**: key on `callerContext.channel:"api"` + `data.values._metadata._agentAssist.facade:"agent_assist_v1"` + `data.values._metadata._agentAssist.appId` for per-binding views.
- **Alerts**: DLQ depth > 10 in 15 min → page on-call; `agent_assist.error` rate > 5% of traffic in 10 min → page on-call.

### 12.6 Data Lifecycle

- **Bindings**: created/updated/disabled via Admin API with audit trail. Hard-delete is allowed but discouraged; disabled bindings are preferred for rollback. Retention: bindings persist for the tenant's lifetime.
- **Sessions**: follow the existing `SessionService` retention policy (per-tenant session max age + idle timeout). `RuntimeExecutor.endSession` cleans up on explicit terminate.
- **Trace events**: follow the existing `TraceStore` retention policy — no new retention tier.
- **Audit log**: follows existing audit-log retention; binding CRUD entries are tagged `subject: "agent_assist_binding"` for filtering.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase POC (complete, committed on branch `KI081/feat/ABLP-390-agent-assist-runtime-compat`; superseded by Phase Actual)**
   1.1 Zod-strict V1 schemas (`agent-assist.schemas.ts`) — done
   1.2 Env-seeded `BindingResolver` — done
   1.3 Pure-function translators (envelope-builder, metadata-normalizer, v1-sse-emitter, session-envelope, placeholder-responder) — done
   1.4 `execution-bridge.ts` delegating to `RuntimeExecutor` — done
   1.5 Fire-and-forget async-push (`callback-sender.ts`) — done
   1.6 End-to-end ngrok smoke test against the real Kore.ai Agent Assist widget — done, recorded in POC reference doc §5
   1.7 22+ unit tests + 10 supertest scenarios — done

2. **Phase Actual — Data Model & Repo**
   2.1 Mongoose model `packages/database/src/models/agent-assist-binding.model.ts` with tenant-isolation plugin and audit-log hooks (collection `agent_assist_bindings`)
   2.2 Repo `apps/runtime/src/repos/agent-assist-binding-repo.ts` with short-TTL read cache
   2.3 Swap `BindingResolver` to use the repo when the collection is available; keep env-seed as a test-only fallback behind a feature flag
   2.4 Integration test: Mongo tenant isolation, unique index, audit-log emission
   **Exit criterion**: `binding-repo.test.ts` passes; facade end-to-end runs against a Mongo-backed binding with no reference to `AGENT_ASSIST_POC_SEED_BINDING` in the default code path.

3. **Phase Actual — Binding Management API ✅ shipped (deviation from original plan — see post-impl-sync log)**
   3.1 The Next.js admin tree under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/...` was **not** built; the previously committed scaffold was deleted before merge as redundant. Two surfaces shipped instead:
   - **Project-scoped (Studio)**: `apps/runtime/src/routes/project-agent-assist-bindings.ts` (express) + `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/...` (Next.js proxy). Includes `generate-api-key` and per-project `settings` endpoints not in the original plan.
   - **Platform-admin tenant-scoped**: `apps/runtime/src/routes/platform-admin-agent-assist.ts` (express).
     3.2 Audit logged via the runtime's `writeAuditLog` (action prefixes `project:compat-binding-*` and `platform_admin:compat-binding-*`).
     3.3 RBAC enforced by `requireProjectPermission(req, res, 'project:read' | 'project:manage')` (Studio) and the platform-admin guard (runtime).
     3.4 Coverage: `routes/project-agent-assist-bindings.test.ts`, `routes/platform-admin-agent-assist.test.ts`, `integration/project-agent-assist-bindings.int.test.ts`, `integration/platform-admin-agent-assist.int.test.ts`.

4. **Phase Actual — Session Lifecycle Completion**
   4.1 Wire `POST /sessions/terminate` to `RuntimeExecutor.endSession`; remove the POC 400 stub
   4.2 Ensure deterministic session id is resolved identically across create → execute → terminate
   4.3 E2E test: full session create → execute → execute → terminate lifecycle with recorded-traffic parity
   **Exit criterion**: the terminate route releases the underlying session (verified by subsequent `SessionService.loadSession` returning not-found); deterministic id parity asserted.

5. **Phase Actual — Async-push Upgrade**
   5.1 BullMQ queue topology (`agent-assist-callback`, `agent-assist-callback-dlq`)
   5.2 Worker `apps/runtime/src/jobs/agent-assist-callback-worker.ts` that imports the execution pipeline and `deliverAsyncCallback`
   5.3 HMAC-SHA256 signing of callback body using the single global secret at `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF`
   5.4 Retry policy (5 attempts, exponential 1 s → 30 s cap); DLQ on terminal failure
   5.5 Integration test: retry behaviour, HMAC verification, DLQ landing
   **Exit criterion**: `callback-worker.test.ts` passes retry + HMAC + DLQ scenarios; DLQ depth gauge observable in metrics.

6. **Phase Actual — Feature Gate & Trace Events**
   6.1 Register `agent_assist` in `PLAN_FEATURES` + feature-gate middleware on all facade routes
   6.2 Register `agent_assist.*` trace-event family in `packages/shared-kernel/src/constants/trace-event-registry.ts`
   6.3 Wire trace emission at route boundaries (received / binding_resolved / delegated / translated_response / error / callback_scheduled / callback_delivered / callback_failed)
   6.4 Update `session.data.values._metadata._agentAssist.source` from `"agent_suggestions"` (POC) to `"agent_assist_v1"`
   **Exit criterion**: every `agent_assist.*` event appears in the registry file; a request made against a tenant with the gate off yields 404 `APP_NOT_FOUND`; per-tenant rollout is observable only via admin tooling.

7. **Phase Actual — Hardening & Wiring Verification**
   7.1 Payload guards wired BEFORE the schema validator (HTTP 413 short-circuit)
   7.2 Error sanitization check: every HTTP-200 error path renders only sanitized content
   7.3 `tenantRateLimit('request')` middleware applied at the router level
   7.4 Post-impl-sync: verify `server.ts` mount line is present, verify all trace events appear in the registry, verify the feature gate is enforced
   **Exit criterion**: an end-to-end sanity run passes the Production Wiring Verification checks in the testing guide §4.

8. **Phase Actual — Test Matrix & Promotion**
   8.1 Complete the E2E recorded-traffic parity test against the captured widget exchange (POC ref §5.2)
   8.2 Integration tests for all §10.5 rows
   8.3 Load test at the expected Kore.ai Agent Assist traffic pattern (sustained sync + async mix)
   8.4 ALPHA → BETA gate (per AUTHORING_GUIDE.md) once §8.1–§8.3 pass
   8.5 `/post-impl-sync` run; feature spec + test spec + testing README updated
   **Exit criterion**: testing guide coverage matrix shows ≥ 5 passing E2E and ≥ 5 passing integration scenarios, the recorded-traffic contract test passes, and the feature status in `docs/features/README.md` moves to BETA.

---

## 14. Success Metrics

| Metric                                                         | Baseline                                                | Target                                                     | How Measured                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Kore.ai Agent Assist integration repointed without code change | Kore.ai config today points to `agent-platform.kore.ai` | SmartAssist tenant migrated by changing Domain URL only    | Manual verification against a migrated tenant; no Agent Assist commits required |
| Facade p50 added overhead (route + translation)                | N/A (new surface)                                       | ≤ 50 ms                                                    | `agent_assist_request_duration_ms` minus upstream `executeMessage` duration     |
| Facade success rate vs native `POST /api/v1/chat/agent`        | Native chat baseline                                    | Within 0.5 pp                                              | `agent_assist.error` rate vs `chat.agent.error` rate over 7-day windows         |
| Async-push delivery success rate                               | N/A                                                     | ≥ 99.5% within 5 attempts                                  | BullMQ job outcome metric                                                       |
| DLQ depth                                                      | 0                                                       | < 10 sustained over any 15-min window                      | `agent_assist_callback_dlq_depth` gauge                                         |
| Time-to-onboard a new SmartAssist tenant                       | Manual provisioning, multi-step, hours                  | ≤ 15 min: one Admin binding create + Kore.ai config update | Operator runbook timing                                                         |
| Byte-level envelope parity with captured widget traffic        | N/A                                                     | 100% on the §17 recorded-traffic parity test               | `agent-assist.contract.test.ts`                                                 |

---

## 15. Open Questions

1. **Binding deletion cascade.** When a `projectId` is deleted, should `agent_assist_bindings` rows be hard-deleted or auto-disabled? Disabling is safer (audit trail, recoverable) but leaves orphans when a project is permanently gone. Decision needed before Phase Actual task 2.
2. **HMAC key rotation cadence.** How often must `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` rotate? Kore.ai Agent Assist does not verify our signatures today — the signature is for ABL-side callback-forgery defense. Align with the platform's standard rotation policy.
3. **Re-using Kore.ai API key vs minting a fresh ABL key.** POC allowed either. Phase Actual Admin API should make the mint-fresh path the default and add a documented "register existing key" flow. Which UX do operators want?
4. **Binding ↔ Deployment coupling.** If `binding.deploymentId` is set and that deployment is later archived, should the binding transition to `status:"disabled"` automatically, or keep failing at resolve time with a sanitized error? Auto-disable is friendlier; fail-closed is safer.
5. **DLQ operator experience.** Is there a dashboard today that surfaces BullMQ DLQ contents operator-side, or does Phase Actual need to add a minimal Admin "callback failures" viewer? A2A has the same question — can we share a surface?
6. **Recorded-traffic parity test fixtures.** The captured widget exchange in POC ref §5.2 is one conversation. Do we need more variety (multiple intents, error cases, SSE flows) before promoting to BETA, or is one deterministic parity test sufficient against the E2E matrix?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                        | Severity | Status   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| GAP-001 | `metadata.aa_uamsgs` history is normalized + bounded (max 50 messages) but not yet forwarded into the executor's prompt context. Forwarding is deferred behind a sanitizer.                                        | High     | Open     |
| GAP-002 | POC fire-and-forget callback replaced with BullMQ worker — retry (5 attempts, exponential backoff), `X-ABL-Signature` HMAC SHA-256, dead-letter queue (`agent-assist-callback-dlq`).                               | High     | Resolved |
| GAP-003 | Session metadata source tag migrated from POC `"agent_suggestions"` to `"agent_assist_v1"`; facade tag is `agent_assist_v1`.                                                                                       | Medium   | Resolved |
| GAP-004 | Studio binding CRUD + per-project enable toggle shipped as a top-level **Settings → Agent Assist** page (sibling of Agent Transfer). Configuration modal exposes one-time plaintext key + key prefix fingerprint.  | Medium   | Resolved |
| GAP-005 | `agent_assist.*` trace event family registered in `packages/shared-kernel/src/constants/trace-event-registry.ts` and wired into the runtime TraceStore.                                                            | Medium   | Resolved |
| GAP-006 | Single-binding env-seed retired. All bindings are Mongo-backed via `agent_assist_bindings` with tenant isolation + LRU+TTL read cache.                                                                             | High     | Resolved |
| GAP-007 | `binding.deploymentId = null` + deployment archival race: resolver may fail mid-request. Behaviour is sanitized-error HTTP 200; no auto-disable yet (see §15 Q4).                                                  | Low      | Open     |
| GAP-008 | No cross-pod cache invalidation on binding updates — a disabled binding may still resolve on another pod for up to 60 s (LRU+TTL window).                                                                          | Low      | Accepted |
| GAP-009 | Placeholder responder branch removed. `BindingStatus` is `"active" \| "disabled"` only; every turn runs through the real executor.                                                                                 | Low      | Resolved |
| GAP-010 | V1 `Welcome_Event` content is wired to `AgentIR.on_start.respond` → `AgentIR.messages.greeting` → `DEFAULT_MESSAGES.greeting` (see `welcome-resolver.ts`). Templates containing `{{placeholders}}` fall through.   | Low      | Resolved |
| GAP-011 | Streaming branch precedence: `stream.enable: true` wins over `isAsync: true` so Kore.ai's "Agentic Response Streaming" widget mode (which sends both flags + no `callbackUrl`) routes to SSE instead of rejecting. | Medium   | Resolved |
| GAP-012 | SSE responses set `Cache-Control: no-cache, no-transform` and call `res.flush()` after every frame so the global gzip middleware + ngrok do not buffer token deltas.                                               | Medium   | Resolved |
| GAP-013 | Binding row stores `apiKeyPrefix` (e.g. `abl_f931`) so the Studio table + Configuration modal show the recognizable plaintext-key prefix instead of the opaque ApiKey doc-id last-4.                               | Low      | Resolved |
| GAP-014 | Public API reference for third-party Agent Assist integrators published at `docs/guides/agent-assist-api.md` (§4 endpoints, §5 callback contract, §4.2.1–§4.2.3 welcome resolution + DSL configuration).           | Low      | Resolved |

---

## 17. Testing & Validation

### 17.1 Required Test Coverage

| #   | Scenario                                                                                                                                                      | Coverage Type | Status       | Test File / Note                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | V1 sync envelope shape (success + runtime error HTTP-200)                                                                                                     | e2e           | ✅           | `routes/agent-assist.route.test.ts`                                                                                                                                                                          |
| 2   | V1 SSE frame ordering + stream-precedence over `isAsync` (no `callbackUrl` required)                                                                          | e2e           | ✅           | `routes/agent-assist.route.test.ts`                                                                                                                                                                          |
| 3   | Async-push: HTTP 202 sync response + BullMQ job delivers full envelope to `callbackUrl` with valid HMAC; retry on 5xx; DLQ on terminal failure                | integration   | ✅           | `integration/agent-assist-callback-worker.int.test.ts` + `workers/agent-assist-callback-worker.test.ts`                                                                                                      |
| 4   | Auth: missing `x-api-key` → 401; invalid key → 401; cross-tenant key → 404 `APP_NOT_FOUND` (not 403)                                                          | e2e           | ✅           | `routes/agent-assist.route.test.ts`                                                                                                                                                                          |
| 5   | Isolation: binding disabled → 404 `APP_NOT_FOUND` (existence-disclosure parity with missing binding); binding `projectId` not in API-key `projectScope` → 404 | e2e           | ✅           | `routes/agent-assist.route.test.ts`                                                                                                                                                                          |
| 6   | Payload guards: body > `AGENT_ASSIST_MAX_BODY_BYTES` → 413; input > `AGENT_ASSIST_MAX_INPUT_CHARS` → 413; `aa_uamsgs` > 50 dropped                            | unit          | ✅ (partial) | `services/agent-assist/metadata-normalizer.test.ts` covers normalize+bound; route-level 413 covered by Express body limit, no explicit assertion                                                             |
| 7   | Metadata normalization: reserved keys stripped; `aa_uamsgs` parsed + bounded; stamped only under `_agentAssist`, not forwarded into `messageMetadata`         | unit          | ✅           | `services/agent-assist/metadata-normalizer.test.ts`                                                                                                                                                          |
| 8   | Deterministic session id: same `(binding, sessionReference)` → same id across sync → async → SSE → terminate                                                  | integration   | ⚠️ partial   | Asserted at unit level via `welcome-resolver.test.ts` + `metadata-normalizer.test.ts`; no dedicated integration round-trip yet                                                                               |
| 9   | `sessions/terminate` → `RuntimeExecutor.endSession` → session absent in subsequent `loadSession`                                                              | e2e           | ✅           | `routes/agent-assist.route.test.ts` (terminate envelope shape + idempotent unknown-session); RuntimeExecutor wiring asserted via mock at route level                                                         |
| 10  | Full lifecycle parity against recorded Kore.ai widget traffic                                                                                                 | e2e           | ❌ planned   | Manual ngrok parity walkthrough captured in `docs/guides/agent-assist-runtime-compat-ngrok-testing.md`; automated contract test deferred                                                                     |
| 11  | Feature gate: tenant without `agent_assist` → 404 `APP_NOT_FOUND`; project-level disable → 404                                                                | unit          | ✅           | `services/agent-assist/feature-gate.test.ts`                                                                                                                                                                 |
| 12  | Project + platform-admin binding CRUD: create → list → update → disable → enable → delete; tenant isolation                                                   | e2e + int     | ✅           | `routes/project-agent-assist-bindings.test.ts`, `routes/platform-admin-agent-assist.test.ts`, `integration/project-agent-assist-bindings.int.test.ts`, `integration/platform-admin-agent-assist.int.test.ts` |
| 13  | Binding repo unique index: creating a second binding with same `(tenantId, appId, environment)` → Mongo duplicate-key error                                   | integration   | ✅           | `integration/agent-assist-binding-repo.int.test.ts` + `repos/agent-assist-binding-repo.test.ts`                                                                                                              |
| 14  | Trace event registry contract: every `agent_assist.*` event in registry, RUNTIME_EVENT_TYPES, label sets                                                      | unit          | ✅           | `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` + `services/agent-assist/trace-events.test.ts`                                                                                           |
| 15  | Callback URL validator: https-only, loopback / RFC1918 / link-local rejection                                                                                 | unit          | ✅           | `services/agent-assist/callback-url-validator.test.ts` + `callback-url-validation.test.ts`                                                                                                                   |
| 16  | HMAC signing + verification of `X-ABL-Signature: t=…,v1=…` (timing-safe compare, replay window)                                                               | unit          | ✅           | `services/agent-assist/callback-signer.test.ts`                                                                                                                                                              |
| 17  | Welcome message resolution: `on_start.respond` → `messages.greeting` → default; `{{placeholder}}` skip rule                                                   | unit          | ✅           | `services/agent-assist/welcome-resolver.test.ts`                                                                                                                                                             |
| 18  | Studio → runtime SSE proxy: header forwarding, body cap, SSE passthrough with `no-transform`                                                                  | unit          | ⚠️ partial   | `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts` (4 SSE/proxy tests are pre-existing flakes — known issue, see §16)                                                                         |
| 19  | Load test at target concurrency (sustained sync + async mix) — p50 overhead ≤ 50 ms, p95 error rate ≤ 0.5%                                                    | load (k6)     | ❌ planned   | Not yet run; track via `load-test-analysis` skill                                                                                                                                                            |

### 17.2 Testing Notes

- **No mocking platform components.** Per CLAUDE.md's Test Architecture rule, `vi.mock` of `@agent-platform/*`, `@abl/*`, or relative imports is forbidden. The facade's integration tests instantiate real `DeploymentResolver`, `SessionService`, `RuntimeExecutor`; the only test double is a DI-injected LLM provider returning canned responses.
- **No direct DB access in E2E.** E2E tests seed bindings via the Admin API, not by inserting rows into Mongo.
- **Real servers.** E2E tests start Express on a random port (`{ port: 0 }`) with the full middleware chain — auth, feature gate, rate limit, payload validation.
- **Pure-function suites run standalone.** Unit tests for translators have no workspace-build dependency — they import only from `./constants.js` and `./types.js`.
- **Recorded-traffic fixtures** live under `apps/runtime/src/__tests__/fixtures/agent-assist/` and capture the real widget payloads from POC ref §5.2. Byte-level parity is asserted in `agent-assist.contract.test.ts`.

> Full testing details: [../testing/agent-assist-runtime-compat.md](../testing/agent-assist-runtime-compat.md)

---

## 18. References

- Testing guide: [`../testing/agent-assist-runtime-compat.md`](../testing/agent-assist-runtime-compat.md)
- SDLC log: [`../sdlc-logs/agent-assist-runtime-compat/`](../sdlc-logs/agent-assist-runtime-compat/)
- Related features: [`native-agents.md`](native-agents.md), [`deployments-versioning.md`](deployments-versioning.md), [`a2a-integration.md`](a2a-integration.md), [`audit-logging.md`](audit-logging.md), [`tracing-observability.md`](tracing-observability.md), [`unified-deployment-endpoints.md`](unified-deployment-endpoints.md)
- Authoring & pipeline references: [`AUTHORING_GUIDE.md`](AUTHORING_GUIDE.md), [`../sdlc/pipeline.md`](../sdlc/pipeline.md)
- External systems studied (not part of this repo): Kore.ai Agent Assist backend + the legacy Agentic V1 server (see prior draft of this spec for file paths).
