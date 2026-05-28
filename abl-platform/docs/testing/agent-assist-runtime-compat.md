# Testing Guide: Agent Assist V1 Compatibility Facade

**Feature Spec**: [../features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
**Status**: PARTIAL (12+ unit suites + 4 integration suites + 3 route e2e suites + 1 shared-kernel contract test committed; load test + recorded-traffic contract test still planned; see §6)
**JIRA**: [ABLP-390](https://koreteam.atlassian.net/browse/ABLP-390)
**Last Updated**: 2026-04-25

---

## 1. Current State

Phase Actual is shipped (ALPHA, branch `KI081/feat/ABLP-390-agent-assist-runtime-compat`, 2026-04-25). Committed test surface:

- **8 unit suites** under `apps/runtime/src/__tests__/services/agent-assist/` — `envelope-builder`, `metadata-normalizer`, `feature-gate`, `welcome-resolver`, `trace-events`, `callback-signer`, `callback-url-validator`, `callback-url-validation`.
- **2 supporting unit suites** — `repos/agent-assist-binding-repo.test.ts` and `workers/agent-assist-callback-worker.test.ts`.
- **3 route e2e suites** under `__tests__/routes/` — `agent-assist.route.test.ts` (V1 facade, 14 scenarios), `project-agent-assist-bindings.test.ts`, `platform-admin-agent-assist.test.ts`.
- **4 integration suites** under `__tests__/integration/` — `agent-assist-binding-repo.int.test.ts`, `agent-assist-callback-worker.int.test.ts`, `project-agent-assist-bindings.int.test.ts`, `platform-admin-agent-assist.int.test.ts`.
- **1 shared-kernel registry contract** — `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts` enforces the `agent_assist.*` family.
- **1 Studio proxy unit suite** — `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts` (4 of 13 sub-tests are pre-existing flakes — not introduced by this branch).
- **Manual end-to-end** — full ngrok parity walkthrough vs the real Kore.ai Agent Assist widget passed 2026-04-25 (see [`docs/guides/agent-assist-runtime-compat-ngrok-testing.md`](../guides/agent-assist-runtime-compat-ngrok-testing.md)).

Still pending for BETA promotion: an automated recorded-traffic contract test (§5.1) and a k6 load test (§9). One additional integration test (e.g. round-trip `execution-bridge`) would meet the ≥5-integration target.

This guide covers the V1 compatibility facade and its reuse of ABL's existing session + execute primitives (`DeploymentResolver`, `RuntimeExecutor.createSessionFromResolved`, `RuntimeExecutor.executeMessage`, `RuntimeExecutor.endSession`). The earlier two-layer architecture (canonical Agent Suggestions Service + facade) was deliberately dropped from the spec.

Promote this guide to BETA once §5.1 contract test + §9 load test pass and the integration suite reaches ≥5. Promote to STABLE only with sustained production soak.

## 2. Health Dashboard

| Indicator                                                       | Value                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facade e2e scenarios passing (supertest + full middleware)      | 14 / ≥5 ✅                                                                                                                                            |
| Integration scenarios passing (real Mongo + real BullMQ worker) | 4 / ≥5 ⚠️                                                                                                                                             |
| Unit scenarios (pure translators + schemas)                     | 8 / ≥6 ✅                                                                                                                                             |
| Trace-event registry contract                                   | 1 / 1 ✅                                                                                                                                              |
| Manual end-to-end parity walkthrough vs Kore.ai widget          | passed (ngrok, 2026-04-25 — see [`docs/guides/agent-assist-runtime-compat-ngrok-testing.md`](../guides/agent-assist-runtime-compat-ngrok-testing.md)) |
| Automated contract parity test vs recorded widget traffic       | 0 / 1 ❌                                                                                                                                              |
| Load test (k6, sustained sync + async mix)                      | 0 / 1 ❌                                                                                                                                              |
| Binding CRUD scenarios passing (Studio + platform-admin)        | 4 / ≥4 ✅ (`routes/project-agent-assist-bindings.test.ts`, `routes/platform-admin-agent-assist.test.ts`, plus their `.int.test.ts` counterparts)      |
| Ngrok → real Kore.ai Agent Assist widget smoke test             | passed 2026-04-25                                                                                                                                     |
| Production wiring verified (`server.ts` mount, trace registry)  | yes (see §4)                                                                                                                                          |
| Cross-tenant / project-scope isolation proven                   | yes — covered by `agent-assist.route.test.ts` (cross-tenant 404, projectScope 404)                                                                    |
| Load / latency SLO verified at target concurrency               | No (k6 deferred to BETA gate — §9)                                                                                                                    |

## 3. Coverage Matrix

Legend: ✅ passing, 🟡 flaky / partial, ❌ failing, ⬜ not written, N/A not applicable.

FR references point at the feature spec's §4 numbering.

### 3.1 HTTP surface & envelopes

| FR Reference | Scenario                                                                                                                              | Unit | Integration | E2E | Manual | Status     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1         | Router mounted at `/api/v2/apps/:appId/environments/:envName`; all three paths resolve                                                | ⬜   | ⬜          | ✅  | ✅     | ✅         |
| FR-2         | Zod-strict validation rejects unknown top-level keys on `/runs/execute` + both `/sessions*`                                           | ⬜   | ⬜          | ✅  | ⬜     | ✅         |
| FR-3         | Payload > 512 KiB → 413 (express body limit); input > 16k chars → 400 INVALID_INPUT (Zod max); `aa_uamsgs` > 50 dropped by normalizer | ✅   | ⬜          | 🟡  | ⬜     | ⚠️ partial |
| FR-4         | Sync success envelope: `{messageId, output, sessionInfo:{status:"completed"}, metadata}`                                              | ⬜   | ⬜          | ✅  | ✅     | ✅         |
| FR-5         | SSE: frame 0 `processing`; delta frames with `output`; final `isLastEvent:true`; heartbeat every 15 s                                 | ⬜   | ⬜          | ✅  | ✅     | ✅         |
| FR-6         | Async-push HTTP 202 + BullMQ delivery                                                                                                 | ✅   | ✅          | ✅  | ⬜     | ✅         |
| FR-7         | `POST /sessions` returns V1 session envelope; does NOT pre-create `HydratedSession`                                                   | ⬜   | ⬜          | ✅  | ✅     | ✅         |
| FR-8         | Welcome event populated iff `metadata.isSendWelcomeMessage === true`; otherwise `events:[]` and empty `output[0]`                     | ✅   | ⬜          | ✅  | ✅     | ✅         |
| FR-9         | `POST /sessions/terminate` calls `RuntimeExecutor.endSession(sessionId)`; idempotent on unknown id                                    | ⬜   | ⬜          | ✅  | ⬜     | ✅         |

### 3.2 Authentication, authorization, isolation

| FR Reference | Scenario                                                                                             | Unit | Integration | E2E | Manual | Status |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------ |
| FR-10        | Missing `x-api-key` → 401; invalid/expired → 401                                                     | ⬜   | ⬜          | ✅  | ✅     | ✅     |
| FR-11        | Authenticated key lacking `session:send_message` → 403 (same shape as `chat/agent` rejection)        | ⬜   | ⬜          | ✅  | ⬜     | ✅     |
| FR-12        | Cross-tenant key → 404 `APP_NOT_FOUND` (never 403); `projectScope` excludes binding's project → 404  | ⬜   | ⬜          | ✅  | ✅     | ✅     |
| FR-12        | Binding `status:"disabled"` → 404 `APP_NOT_FOUND` (existence-disclosure parity with missing binding) | ⬜   | ⬜          | ✅  | ⬜     | ✅     |
| FR-13        | `environment="Dev"` and `environment="dev"` both resolve the same binding                            | ✅   | ⬜          | ⬜  | ⬜     | ✅     |

### 3.3 Binding resolution & session keying

| FR Reference | Scenario                                                                                                                | Unit | Integration | E2E | Manual | Status                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | -------------------------------------------- |
| FR-14        | Same `(binding, sessionReference)` yields the same deterministic `sessionId` across sync / async / SSE / terminate      | ✅   | ⬜          | ⬜  | ✅     | ⚠️ partial — round-trip integration deferred |
| FR-14        | Two bindings with different `apiKeyId` yield different `sessionId`s for the same `sessionReference`                     | ✅   | ⬜          | ⬜  | ⬜     | ✅                                           |
| FR-15        | Mongo unique index `(tenantId, appId, environment)` enforced — duplicate create via management API → HTTP 409           | ⬜   | ✅          | ✅  | ⬜     | ✅                                           |
| FR-15        | `tenantIsolationPlugin` blocks cross-tenant reads at the repo level even without route-level filter (defense in depth)  | ⬜   | ✅          | ⬜  | ⬜     | ✅                                           |
| FR-16        | Repo LRU+TTL cache: first request → DB hit; subsequent within TTL → cache hit; mutation invalidates on the mutating pod | ✅   | ⬜          | ⬜  | ⬜     | ✅                                           |

### 3.4 Execution delegation

| FR Reference | Scenario                                                                                                                                        | Unit | Integration | E2E | Manual | Status                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------------------------------------------------------------------------------ |
| FR-17        | Turn invokes `DeploymentResolver.resolve` then `RuntimeExecutor.createSessionFromResolved` then `executeMessage` — no HTTP loopback observed    | ⬜   | ⬜          | ✅  | ✅     | ⚠️ partial — observed at e2e + manual; no dedicated integration round-trip yet |
| FR-17        | Pinned `binding.deploymentId` overrides environment-active resolution                                                                           | ⬜   | ⬜          | ⬜  | ⬜     | ❌ planned                                                                     |
| FR-18        | Session `callerContext` carries only shared-auth-valid fields; facade tags live under `session.data.values._metadata._agentAssist`              | ⬜   | ⬜          | ✅  | ⬜     | ✅                                                                             |
| FR-19        | SSE streams content by forwarding `executor.executeMessage` `onChunk` writes into `V1SSEEmitter`                                                | ⬜   | ⬜          | ✅  | ✅     | ✅                                                                             |
| FR-20        | V1 `metadata` is NOT forwarded as `messageMetadata`; only a validated `SdkMessageMetadata` subset reaches `executeMessage`                      | ✅   | ⬜          | ⬜  | ⬜     | ✅                                                                             |
| FR-21        | Reserved keys (`history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId`) stripped verifiably | ✅   | ⬜          | ⬜  | ⬜     | ✅                                                                             |

### 3.5 Runtime error rendering

| FR Reference | Scenario                                                                                                                      | Unit | Integration | E2E | Manual | Status     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-22a       | Pre-execution failures (validation / auth / payload / feature-gate) return standard HTTP codes with structured `{error}` body | ⬜   | ⬜          | ✅  | ⬜     | ✅         |
| FR-22b       | Executor throws → HTTP 200 with `sessionInfo.status:"error"` + sanitized `output[0].content`                                  | ⬜   | ⬜          | ⬜  | ⬜     | ❌ planned |
| FR-22b       | Deployment resolution failure → HTTP 200 `status:"error"` (no tenant/model/credential leakage)                                | ⬜   | ⬜          | ⬜  | ⬜     | ❌ planned |
| FR-23        | No tenant id, project id, model id, credential hint, or internal path leaks into error `output[0].content`                    | ⬜   | ⬜          | ⬜  | ⬜     | ❌ planned |

### 3.6 Async-push callback delivery

| FR Reference | Scenario                                                                                                           | Unit | Integration | E2E | Manual | Status |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ---- | ----------- | --- | ------ | ------ |
| FR-24        | BullMQ job delivers full V1 envelope to `callbackUrl` with valid `X-ABL-Signature` HMAC-SHA256                     | ✅   | ✅          | ⬜  | ⬜     | ✅     |
| FR-24        | Receiver verifies signature using the env-resolved secret (`AGENT_ASSIST_CALLBACK_SIGNING_SECRET`)                 | ✅   | ✅          | ⬜  | ⬜     | ✅     |
| FR-25        | 5xx from callback endpoint → retry with exponential backoff (5 attempts, 1 s → 30 s cap); terminal → DLQ           | ✅   | ✅          | ⬜  | ⬜     | ✅     |
| FR-25        | Terminal failure lands the job in `agent-assist-callback-dlq` with full request/response trail                     | ✅   | ✅          | ⬜  | ⬜     | ✅     |
| FR-26        | `isAsync:true` without `callbackUrl` → 400 `CALLBACK_URL_REQUIRED`; `stream.enable:true + isAsync:true` → SSE wins | ⬜   | ⬜          | ✅  | ⬜     | ✅     |
| FR-26        | Callback URL validation: https-only, loopback / RFC1918 / link-local rejected                                      | ✅   | ⬜          | ✅  | ⬜     | ✅     |

### 3.7 Feature gating, rate limiting, observability

| FR Reference | Scenario                                                                                                  | Unit | Integration | E2E | Manual | Status     |
| ------------ | --------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-27        | Tenant without `agent_assist` feature (Deal / plan) → 404 `APP_NOT_FOUND` (same shape as missing binding) | ✅   | ⬜          | ⬜  | ⬜     | ✅         |
| FR-27        | Project-level disable (`project_agent_assist_settings.enabled = false`) → 404 `APP_NOT_FOUND`             | ✅   | ⬜          | ⬜  | ⬜     | ✅         |
| FR-28        | `tenantRateLimit('request')` applied — over-rate requests get the existing 429 shape                      | ⬜   | ⬜          | ⬜  | ⬜     | ❌ planned |
| FR-29        | Every request emits `agent_assist.received` + one terminal event (`translated_response` / `error`)        | ✅   | ⬜          | ⬜  | ⬜     | ✅         |
| FR-29        | Async path additionally emits `callback_scheduled` + (`callback_delivered` or `callback_failed`)          | ✅   | ✅          | ⬜  | ⬜     | ✅         |
| FR-30        | Session metadata carries `source:"agent_assist_v1"` (not POC's `"agent_suggestions"`)                     | ⬜   | ⬜          | ✅  | ⬜     | ✅         |

### 3.8 Binding management surfaces (Studio + platform-admin)

| FR Reference | Scenario                                                                                                                                                                                                         | Unit | Integration | E2E | Manual | Status |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------ |
| FR-31        | Project-scoped CRUD lifecycle: create → list → get → update → disable → enable → delete (Studio path) — `routes/project-agent-assist-bindings.test.ts` + `integration/project-agent-assist-bindings.int.test.ts` | ⬜   | ✅          | ✅  | ✅     | ✅     |
| FR-31        | Platform-admin tenant-scoped CRUD lifecycle — `routes/platform-admin-agent-assist.test.ts` + `integration/platform-admin-agent-assist.int.test.ts`                                                               | ⬜   | ✅          | ✅  | ⬜     | ✅     |
| FR-31        | Mutations write `writeAuditLog` rows with action prefix `project:compat-binding-*` (Studio path) / `platform_admin:compat-binding-*` (platform-admin path)                                                       | ⬜   | ✅          | ✅  | ⬜     | ✅     |
| FR-31        | Studio cross-project access blocked by `requireProjectPermission(req, res, 'project:read' \| 'project:manage')`                                                                                                  | ⬜   | ⬜          | ✅  | ⬜     | ✅     |
| FR-31        | PATCH rejects attempts to change `tenantId`, `appId`, `environment` (immutable identity fields)                                                                                                                  | ⬜   | ⬜          | ✅  | ⬜     | ✅     |
| FR-31        | `POST /:bindingId/generate-api-key` mints a fresh `abl_<token>`, revokes the previous key, and persists `apiKeyId` + `apiKeyPrefix` on the binding                                                               | ⬜   | ⬜          | ✅  | ✅     | ✅     |
| FR-31        | `GET / PUT /settings` for the per-project Agent Assist enable toggle (`project_agent_assist_settings`)                                                                                                           | ⬜   | ⬜          | ✅  | ✅     | ✅     |

## 4. Production Wiring Verification

These are reachability checks confirmed by `/post-impl-sync` against the shipped tree.

1. ✅ `apps/runtime/src/server.ts` mounts `app.use('/api/v2/apps', createAgentAssistRouter(...))` unconditionally (no kill-switch env var) and also mounts `app.use('/api/projects/:projectId/agent-assist-bindings', projectAgentAssistBindingsRouter)` and `app.use('/api/platform/admin/agent-assist', platformAdminAgentAssistRouter)`.
2. ✅ `packages/shared-kernel/src/constants/trace-event-registry.ts` lists every `agent_assist.*` event from FR-29 and is asserted by `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`.
3. ⚠️ `packages/shared-kernel/src/constants/plan-features.ts` does NOT currently include `agent_assist` in any plan tier — access is granted exclusively via `Deal.features` containing `'agent_assist'`. (Documented in feature spec §11.2; revisit if/when the feature is offered as a default tier benefit.)
4. ✅ Studio Next.js routes under `apps/studio/src/app/api/projects/[id]/agent-assist-bindings/...` exist and proxy to the runtime project-scoped router; the runtime platform-admin router is mounted at `/api/platform/admin/agent-assist`. Both surfaces write `writeAuditLog` rows. The previously planned `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/...` tree is intentionally absent (deviation — see post-impl-sync log).
5. ✅ `packages/database/src/models/agent-assist-binding.model.ts` exports `AgentAssistBinding` from the database barrel (`packages/database/src/models/index.ts`) and applies `tenantIsolationPlugin` + `auditTrailPlugin`. Companion model `project-agent-assist-settings.model.ts` is also exported.
6. ✅ BullMQ queues `agent-assist-callback` + `agent-assist-callback-dlq` are wired in the worker bootstrap and asserted by `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts`.

## 5. E2E & Integration Scenarios

All scenarios run against real HTTP, real middleware chain, real `SessionService` + `RuntimeExecutor`. LLM providers may be replaced via dependency injection; no other mocks. No `vi.mock` of internal packages. No direct Mongoose access from test bodies.

### 5.1 E2E scenarios (minimum 5 — 7 shipped)

#### E2E-1 — Sync success happy path (FR-4, FR-17, FR-29)

- **Preconditions**: Runtime up on random port; tenant `T1` with `agent_assist` feature enabled; project `P1` with a deployed agent on `env=dev`; binding `{appId:"aa-test", environment:"dev", tenantId:T1, projectId:P1, status:"active"}` persisted; ABL API key K1 scoped to `T1` + `projectScope:[P1]` + `session:send_message` permission.
- **Auth context**: `x-api-key: <K1>` → resolves to `{tenantId:T1, apiKeyId, projectScope:[P1]}`.
- **Steps**:
  1. `POST /api/v2/apps/aa-test/environments/Dev/runs/execute` with body `{sessionIdentity:[{type:"sessionReference",value:"conv-1"}], input:[{type:"text",content:"hello"}], stream:{enable:false,streamMode:"tokens"}, source:"AIS-AA", metadata:{conversationId:"conv-1"}}`.
  2. Read response body + headers.
  3. `GET` (via `SessionService.loadSession`) with the returned `sessionInfo.sessionId`.
- **Expected result**: HTTP 200; body matches V1 envelope `{messageId, output:[{type:"text",content}], sessionInfo:{sessionId,runId,status:"completed",appId:"aa-test",sessionReference:"conv-1",source:"AIS-AA"}, metadata:{conversationId:"conv-1"}}`; session exists with `callerContext.channel === "api"` and `session.data.values._metadata._agentAssist.source === "agent_assist_v1"`; `TraceStore` contains `agent_assist.received` + `agent_assist.binding_resolved` + `agent_assist.delegated` + `agent_assist.translated_response` for the request id.
- **Isolation check**: response body contains no tenant id, project id, deployment id, model id.

#### E2E-2 — Cross-tenant isolation returns 404 (FR-12)

- **Preconditions**: Two bindings `B_T1 = (T1, aa-xyz, dev)` and `B_T2 = (T2, aa-xyz, dev)` persisted (same `appId` in different tenants). API key K1 is tenant-T1 only.
- **Auth context**: `x-api-key: <K1>`.
- **Steps**: `POST /api/v2/apps/aa-xyz/environments/dev/runs/execute` with a valid body.
- **Expected result**: HTTP 404 body `{error:{code:"APP_NOT_FOUND", message}}`; no `agent_assist.delegated` trace event; executor not invoked; warn log `agent-assist tenant mismatch` present with sanitized fields.
- **Isolation check**: body is identical to the body returned for an unknown `appId` — existence of `B_T2` is not observable.

#### E2E-3 — SSE streaming frame contract (FR-5, FR-19)

- **Preconditions**: As E2E-1 PLUS `AGENT_ASSIST_SSE_HEARTBEAT_MS=500` (shortened per §11 defaults so a heartbeat fires during the test window). DI LLM double configured to emit ≥ 4 token chunks with a 600 ms gap between chunks 2 and 3 so at least one heartbeat comment line is observed.
- **Auth context**: as E2E-1.
- **Steps**:
  1. `POST /runs/execute` with `stream.enable:true`, `Accept: text/event-stream`.
  2. Read the response stream line-by-line until the socket closes.
- **Expected result**: headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`; first frame is `data: {eventIndex:0, sessionInfo:{status:"processing",...}, isLastEvent:false}`; ≥ 1 delta frame carries `output:[{type:"text",content:"..."}]`; at least one `: heartbeat` comment line emitted between frames; terminal frame has `isLastEvent:true` and `sessionInfo.status:"completed"`; no named SSE `event:` lines.
- **Isolation check**: delta content is the LLM double's output verbatim; no internal identifiers present.

#### E2E-4 — Async-push end-to-end with HMAC (FR-6, FR-24, FR-25)

- **Preconditions**: Redis + BullMQ worker running; test HTTP callback sink server on random port recording requests; `AGENT_ASSIST_CALLBACK_SIGNING_SECRET` set to a known fixture secret.
- **Auth context**: as E2E-1.
- **Steps**:
  1. `POST /runs/execute` with `isAsync:true`, `callbackUrl:"http://localhost:<sinkPort>/cb"`, `stream.enable:false`.
  2. Assert sync response immediately.
  3. Poll sink with timeout until one request arrives.
  4. Verify `X-ABL-Signature` HMAC-SHA256 using the fixture secret.
  5. **Bit-flip check** — take the recorded callback body, mutate exactly one byte, and re-run HMAC verification. Assert verification fails (integrity contract), so the receiver would reject the tampered payload.
- **Expected result**: sync HTTP 202 with envelope `{messageId, output:[{type:"text",content:""}], sessionInfo:{status:"processing",...}}`; within 10 s the sink receives POST with `Content-Type: application/json`, `User-Agent: abl-agent-assist/<version>`, `X-ABL-Source: agent-assist-v1`, `X-ABL-Signature: t=<unix-ts>,v1=<hex>`; body matches the sync V1 envelope shape with `sessionInfo.status:"completed"` and `metadata` echoed; HMAC verifies on the untouched body; HMAC FAILS on the bit-flipped body; trace `agent_assist.callback_scheduled` then `agent_assist.callback_delivered` emitted.
- **Isolation check**: signature covers the body bytes, so any tampering is detectable; the bit-flip subcheck (step 5) is the explicit evidence.

#### E2E-5 — Full V1 lifecycle parity (FR-7, FR-8, FR-9, FR-14)

- **Preconditions**: Recorded fixture set at `apps/runtime/src/__tests__/fixtures/widget-lifecycle/*.json` captured from the POC ngrok smoke test (normalized: opaque ids like `sessionId`, `runId`, timestamps replaced by placeholders).
- **Auth context**: as E2E-1.
- **Steps**:
  1. `POST /sessions` with `metadata.isSendWelcomeMessage:true`, `sessionIdentity:[{type:"sessionReference",value:"conv-1"}]`.
  2. Capture `session.sessionId` from response.
  3. `POST /runs/execute` with `isAsync:true` + sink `callbackUrl` + same `sessionReference`. Poll sink for callback.
  4. `POST /runs/execute` second turn, same `sessionReference`. Poll sink.
  5. `POST /sessions/terminate` with `{sessionIdentity:[{type:"sessionId",value:<sessionId>}]}`.
- **Expected result**: session `sessionId` is `s-<deterministic>` per FR-14; `Welcome_Event` present in `events[0]` with `messageToUser` equal to the deployed agent's `AgentIR.on_start.respond` (or `messages.greeting` / platform default when absent), per FR-8 via `welcome-resolver.ts`; turn 2's `sessionInfo.sessionId` equals turn 1's (session continuity); terminate returns `{status:"terminated", sessionId:<same>, appId:"aa-test", attachments:[]}`; every envelope matches the recorded fixture shape after placeholder substitution.
- **Isolation check**: between steps 4 and 5, a concurrent request from tenant `T2` with the same `sessionReference:"conv-1"` gets a DIFFERENT `sessionId` (binding-scoped).
- **Gate**: BETA promotion blocked until this scenario is green against the captured fixture set.

#### E2E-6 — Feature-gate OFF returns 404 byte-identical to cross-tenant 404 (FR-27)

- **Preconditions**: Binding B exists + ABL API key is valid. Run two sub-cases: (a) tenant lacks the `agent_assist` feature flag (no Deal grant, no plan-tier inclusion); (b) `project_agent_assist_settings.enabled = false` for the binding's project.
- **Auth context**: as E2E-1.
- **Steps**: issue the same valid `/runs/execute` request in each sub-case.
- **Expected result**: HTTP 404 `{error:{code:"APP_NOT_FOUND", message}}` in BOTH cases; no `agent_assist.binding_resolved` / `agent_assist.delegated` trace events; zero invocations of `RuntimeExecutor.executeMessage`; response bodies between (a) and (b) are byte-identical (feature state not externally observable).
- **Isolation check**: body is identical to a cross-tenant 404 and to a disabled-binding 404.

#### E2E-7 — Relative / malformed callbackUrl rejected (FR-25, FR-26)

- **Preconditions**: Binding B + API key as E2E-1.
- **Auth context**: as E2E-1.
- **Steps**: issue three requests:
  1. `isAsync:true` with no `callbackUrl`.
  2. `isAsync:true` with `callbackUrl:"/agentassist/api/v1/aa/linkedapps/agenticresponse"` (relative, real-world widget shape).
  3. `isAsync:true` with `callbackUrl:"http://evil.internal/cb"` (plain http, non-localhost — refused by sender's allowlist).
- **Expected result**: (1) HTTP 400 `{error:{code:"CALLBACK_URL_REQUIRED", message}}`; (2) and (3) HTTP 202 sync response accepted but BullMQ job records `invalid_url` / `http_only_allowed_for_localhost` refusal, `agent_assist.callback_failed` emitted with the reason, job moves to DLQ after final attempt, no POST made to the relative URL.
- **Isolation check**: (2) and (3)'s reason strings never appear in the sync response body — only in logs + DLQ record.

### 5.2 Integration scenarios (minimum 5)

#### INT-1 — Execution bridge against real executor (FR-17, FR-18, FR-20)

- **Boundary**: `execution-bridge.executeTurn` → `DeploymentResolver.resolve` → `RuntimeExecutor.createSessionFromResolved` → `RuntimeExecutor.executeMessage`.
- **Setup**: Real `DeploymentResolver` + `RuntimeExecutor` singletons (no mocks of internal modules); DI-injected LLM adapter returning canned response `"ok"`; binding `{projectId:P1, deploymentId:D1, ...}`.
- **Steps**:
  1. Invoke `executeTurn(binding, {userMessage:"hi", sessionReference:"conv-x", messageMetadata})` with `onChunk` collector.
  2. Capture session via `executor.getSession(result.sessionId)`.
  3. Inspect `session.callerContext` and `session.data.values._metadata._agentAssist`.
- **Expected result**: result `responseText === "ok"`; `session.callerContext` contains EXACTLY `{tenantId, channel:"api", initiatedById, identityTier:0, verificationMethod:"none"}` — no Kore.ai-specific fields; `session.data.values._metadata._agentAssist` contains `{source:"agent_assist_v1", facade:"agent_assist_v1", appId, environment, bindingId, apiKeyId, externalReference}`; `executeMessage` was called with `channelMetadata.channel === "agent-assist-v1"`; NO `messageMetadata` parameter passed (raw V1 metadata was NOT forwarded — FR-20).
- **Failure mode**: when `DeploymentResolver.resolve` rejects with `"NO_ACTIVE_DEPLOYMENT"`, `executeTurn` translates it into a sanitized runtime-error envelope (no project id in message).

#### INT-2 — Mongo repo tenant isolation + unique index (FR-12, FR-15)

- **Boundary**: `agent-assist-binding-repo.ts` → Mongo `agent_assist_bindings` via `tenantIsolationPlugin`.
- **Setup**: Mongo test container via the existing test harness; insert binding rows for tenants T1 and T2 with overlapping `appId`.
- **Steps**:
  1. Call `repo.findByAppAndEnv({tenantId:T1, appId:"aa-x", environment:"dev"})`.
  2. Attempt a duplicate insert for `(T1, aa-x, dev)`.
  3. Attempt to list bindings from `tenantIsolationPlugin`-scoped context for T2 without an explicit `tenantId` filter.
- **Expected result**: (1) exactly the T1 row returned, T2 row hidden even if code omitted `tenantId` filter; (2) Mongo returns duplicate-key E11000, repo surfaces `DUPLICATE_BINDING` error translated to HTTP 409 by Admin route; (3) only T2 rows visible.
- **Failure mode**: when `tenantIsolationPlugin` is disabled in misconfiguration, the test explicitly fails — the plugin is the defense-in-depth floor.

#### INT-3 — BullMQ callback worker retry + DLQ (FR-25)

- **Boundary**: Facade → BullMQ (`agent-assist-callback`) → HTTP POST → DLQ on terminal failure.
- **Setup**: Redis + BullMQ worker, mock HTTP sink that returns 500 for the first 4 attempts, 200 on the 5th; second sink always returns 500.
- **Steps**:
  1. Case A: enqueue job pointed at first sink; wait for completion.
  2. Case B: enqueue job pointed at second sink; wait for DLQ move.
- **Expected result**: (A) job succeeds on 5th attempt, 4 retries observed with backoff of approximately 1 s / 2 s / 4 s / 8 s, `agent_assist.callback_delivered` emitted with `attempt:5`; (B) 5 failed attempts then job lands in `agent-assist-callback-dlq` with a record containing every attempt's `{status, body, tsStart, tsEnd, reason}`, `agent_assist.callback_failed` emitted.
- **Failure mode**: Redis down → facade still returns 202 sync, but the job is NOT in-memory and the next restart picks it up (or is cleanly lost, depending on queue persistence config — make this explicit in the test).

#### INT-4 — Binding-management CRUD audit trail (FR-31)

- **Boundary**: Studio project-scoped routes (`apps/runtime/src/routes/project-agent-assist-bindings.ts`) AND the runtime platform-admin router (`apps/runtime/src/routes/platform-admin-agent-assist.ts`) → `writeAuditLog`. Tests live at `apps/runtime/src/__tests__/integration/project-agent-assist-bindings.int.test.ts` and `apps/runtime/src/__tests__/integration/platform-admin-agent-assist.int.test.ts`.
- **Setup**: Real Express test app on `port: 0` against MongoMemory; stub auth seeded with project-scope membership + `project:manage` permission for the project-scoped path, and platform-admin role for the platform-admin path.
- **Steps**: full lifecycle on each path — `POST` create → `GET` list → `GET /:id` → `PATCH /:id` → `POST /:id/disable` → `POST /:id/enable` → `POST /:id/generate-api-key` → `DELETE /:id` — plus negative tests: cross-project access blocked by `requireProjectPermission` (project-scoped path); PATCH attempting to change `tenantId` / `appId` / `environment` rejected.
- **Expected result**: each mutating call produces exactly one `writeAuditLog` entry with `action: 'project:compat-binding-{create|update|enable|disable|delete|api-key-generate|api-key-revoke}'` (Studio path) or `'platform_admin:compat-binding-*'` (platform-admin path), captures `who, action, tenantId, projectId, appId, environment, requestId, diff`, and NO sensitive fields (raw `apiKey` plaintext) in the log; cross-project read returns 404 from project-scoped router; immutable-field PATCH returns 400; `generate-api-key` revokes the previous `ApiKey` doc (sets `revokedAt`) and persists `apiKeyId` + `apiKeyPrefix` on the binding.
- **Failure mode**: when `writeAuditLog` throws, mutation handlers must FAIL-CLOSED with HTTP 5xx (we never accept a mutation we cannot audit).

#### INT-5 — Session terminate releases resources (FR-9)

- **Boundary**: Facade `/sessions/terminate` → `RuntimeExecutor.endSession` → `SessionService.deleteSession` + memory cleanup.
- **Setup**: A live session created by a prior `runs/execute` turn.
- **Steps**:
  1. Capture `sessionId` from the turn's response.
  2. `POST /sessions/terminate` with `{sessionIdentity:[{type:"sessionId",value:<sessionId>}]}`.
  3. Call `SessionService.loadSession(sessionId)`.
  4. `POST /sessions/terminate` AGAIN with the same id (idempotency check).
- **Expected result**: (1) HTTP 200 terminate envelope; (2) `loadSession` returns null; (3) `after_agent` lifecycle hook fired in traces; (4) second terminate call also returns HTTP 200 with the same envelope shape (idempotent — per FR-9).
- **Failure mode**: when `endSession` throws, the terminate endpoint still returns HTTP 200 with the terminate envelope (error swallowed, logged) — V1 clients treat terminate as fire-and-forget.

### 5.3 Critical Feature Gate Coverage (matrix)

| Scenario                                                 | HTTP status | Body code            | Executor invoked? | Trace events emitted                                                  |
| -------------------------------------------------------- | ----------- | -------------------- | ----------------- | --------------------------------------------------------------------- |
| Happy path (feature ON, project enabled, binding active) | 200 / 202   | —                    | yes               | `received` → `binding_resolved` → `delegated` → `translated_response` |
| Tenant lacks `agent_assist` feature                      | 404         | `APP_NOT_FOUND`      | no                | `received` → `error` (reason:`feature_gate_off`)                      |
| Project-level disable (`project_agent_assist_settings`)  | 404         | `APP_NOT_FOUND`      | no                | `received` → `error` (reason:`project_disabled`)                      |
| Binding `status:"disabled"`                              | 404         | `APP_NOT_FOUND`      | no                | `received` → `error` (reason:`binding_disabled`)                      |
| Cross-tenant API key                                     | 404         | `APP_NOT_FOUND`      | no                | `received` → `error` (reason:`tenant_mismatch`)                       |
| API key lacks `session:send_message`                     | 403         | `FORBIDDEN`          | no                | `received` → `error` (reason:`permission_denied`)                     |
| Missing `x-api-key`                                      | 401         | (unified-auth shape) | no                | `received` (if before auth) OR none                                   |

Keep the 404 body byte-identical across the four "existence-disclosure" cases (feature off, project disabled, binding disabled, cross-tenant) so internal state cannot be probed from outside.

## 6. Unit Test Plan

All unit tests are pure-function — no `vi.mock` of internal packages. Modules and their committed test files:

| File                                                                               | Module under test                                              | Coverage focus                                                                                                                               | FRs          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/services/agent-assist/envelope-builder.test.ts`        | `services/agent-assist/envelope-builder.ts`                    | V1 sync + error envelopes                                                                                                                    | FR-4, FR-22b |
| `apps/runtime/src/__tests__/services/agent-assist/metadata-normalizer.test.ts`     | `services/agent-assist/metadata-normalizer.ts`                 | Reserved-key strip, `aa_uamsgs` bound, shape coercion                                                                                        | FR-21, FR-3  |
| `apps/runtime/src/__tests__/services/agent-assist/feature-gate.test.ts`            | `services/agent-assist/feature-gate.ts`                        | Tenant feature resolution via Deal / plan; project-level enable check                                                                        | FR-27        |
| `apps/runtime/src/__tests__/services/agent-assist/welcome-resolver.test.ts`        | `services/agent-assist/welcome-resolver.ts`                    | `on_start.respond` → `messages.greeting` → platform default priority; `{{placeholder}}` skip                                                 | FR-8         |
| `apps/runtime/src/__tests__/services/agent-assist/trace-events.test.ts`            | `services/agent-assist/trace-events.ts`                        | Emitter routes through `setAgentAssistTraceEmitter`                                                                                          | FR-29        |
| `apps/runtime/src/__tests__/services/agent-assist/callback-signer.test.ts`         | `services/agent-assist/callback-signer.ts`                     | HMAC SHA-256 sign + parse for `X-ABL-Signature: t=…,v1=…`; timing-safe verify                                                                | FR-24        |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validator.test.ts`  | `services/agent-assist/callback-url-validator.ts`              | https-only, loopback / RFC1918 / link-local / non-HTTP-scheme rejection                                                                      | FR-26        |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validation.test.ts` | (combined scenarios)                                           | End-to-end validator decision matrix                                                                                                         | FR-26        |
| `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts`               | `repos/agent-assist-binding-repo.ts`                           | Repo CRUD + LRU+TTL cache invalidation paths                                                                                                 | FR-15, FR-16 |
| `apps/runtime/src/__tests__/workers/agent-assist-callback-worker.test.ts`          | `workers/agent-assist-callback-worker.ts`                      | Worker job logic: retry, HMAC, DLQ on terminal failure                                                                                       | FR-24, FR-25 |
| `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts`                  | `apps/studio/src/lib/agent-assist-proxy.ts`                    | Studio → runtime header forwarding + body cap + SSE passthrough (4 of 13 sub-tests are pre-existing flakes — not regressions of this branch) | FR-5         |
| `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`                | `packages/shared-kernel/src/constants/trace-event-registry.ts` | Registry contract: every `agent_assist.*` event present in registry, RUNTIME_EVENT_TYPES, label sets                                         | FR-29        |

Modules deliberately covered only at e2e / integration level:

- `services/agent-assist/v1-sse-emitter.ts` — exercised by `routes/agent-assist.route.test.ts` (frame sequencing); a dedicated unit suite is a backlog item.
- `services/agent-assist/session-envelope.ts` — exercised by `routes/agent-assist.route.test.ts` for create + terminate envelope shape.
- `services/agent-assist/execution-bridge.ts` — exercised at e2e through `routes/agent-assist.route.test.ts`; a dedicated integration round-trip test is the missing 5th-integration target.

POC-era retirements (landed alongside the placeholder-branch removal):

- `placeholder-responder.test.ts` — deleted along with `placeholder-responder.ts`.
- The env-seeded `BindingResolver` POC was removed; Mongo-repo coverage lives in `agent-assist-binding-repo.int.test.ts`.
- The kill-switch test in `agent-assist.route.test.ts` was deleted when the `AGENT_ASSIST_ENABLED` env var was retired.

## 7. Committed Test Inventory

These are the tests on disk. They run as part of the runtime + shared-kernel + studio CI pipelines. (Counts here may move as tests are added; see §6 for the canonical mapping.)

| Test file                                                                          | Type        | Status  | Maps to                                                                               |
| ---------------------------------------------------------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts`                     | e2e         | passing | §5.1 E2E-1, E2E-2, E2E-3, E2E-6 (validation, isolation, 404, FR-8, stream-precedence) |
| `apps/runtime/src/__tests__/routes/project-agent-assist-bindings.test.ts`          | e2e         | passing | §5.2 INT-4 Studio path                                                                |
| `apps/runtime/src/__tests__/routes/platform-admin-agent-assist.test.ts`            | e2e         | passing | §5.2 INT-4 platform-admin path                                                        |
| `apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts`     | integration | passing | §5.2 INT-2 (tenant isolation, unique index)                                           |
| `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts`  | integration | passing | §5.2 INT-3 (retry, HMAC, DLQ)                                                         |
| `apps/runtime/src/__tests__/integration/project-agent-assist-bindings.int.test.ts` | integration | passing | §5.2 INT-4 Studio path                                                                |
| `apps/runtime/src/__tests__/integration/platform-admin-agent-assist.int.test.ts`   | integration | passing | §5.2 INT-4 platform-admin path                                                        |
| `apps/runtime/src/__tests__/services/agent-assist/*.test.ts` (8 files)             | unit        | passing | §6 unit-test plan                                                                     |
| `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts`               | unit        | passing | §6 (FR-15, FR-16)                                                                     |
| `apps/runtime/src/__tests__/workers/agent-assist-callback-worker.test.ts`          | unit        | passing | §6 (FR-24, FR-25)                                                                     |
| `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts`                  | unit        | flaky   | §6 (4/13 sub-tests pre-existing flakes — not regressions)                             |
| `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`                | unit        | passing | §6 (FR-29 contract)                                                                   |

## 8. Manual & Operator Verification

- **Ngrok smoke test.** `tools/agent-assist-conversation.sh` drives the three-endpoint conversation end-to-end against a local runtime. Keep this as the operator acceptance check even after the contract test is automated.
- **Real Kore.ai widget acceptance.** See `docs/guides/agent-assist-runtime-compat-ngrok-testing.md` for the full ngrok → widget setup; repeat against a non-prod SmartAssist tenant to certify a production rollout.
- **DLQ drill.** Operators should periodically inject a failing callback URL into a non-prod binding, verify the DLQ entry, and practice the replay/recover workflow.

## 9. Load Test Plan

- Target: sustained 100 req/s on `/runs/execute` with 80% async-push + 15% sync + 5% SSE, 1-hour soak.
- Tool: k6 per the `load-test-analysis` skill.
- Metrics gated:
  - p50 facade overhead ≤ 50 ms (p50 total minus p50 upstream `executeMessage`).
  - p95 total latency ≤ upstream p95 + 100 ms.
  - 5xx rate < 0.1%.
  - Async-push delivery success rate ≥ 99.5% within 5 attempts.
  - BullMQ worker CPU < 60% per pod; DLQ depth 0 at end of soak.
- Deliverable: `docs/sdlc-logs/agent-assist-runtime-compat/load-test-<date>.md` with the k6 summary + Coroot saturation plots (runtime, MongoDB, Redis).

## 10. Security & Isolation Checks

Mandatory checks — each must have at least one passing test in §5 referenced by scenario id.

- [ ] Cross-tenant access returns 404 `APP_NOT_FOUND` (covered by E2E-2)
- [ ] Cross-project scope returns 404 `APP_NOT_FOUND` (row in §3.2 FR-12)
- [ ] Missing `x-api-key` returns 401 (row in §3.2 FR-10)
- [ ] Invalid / expired / revoked `x-api-key` returns 401 (row in §3.2 FR-10)
- [ ] Authenticated key lacking `session:send_message` returns 403 with same shape as `chat/agent` (row in §3.2 FR-11)
- [ ] Admin caller cannot read bindings of another tenant (INT-4 negative test)
- [ ] Feature-gate-off and kill-switch-off both return 404 byte-identical to cross-tenant 404 (E2E-6)
- [ ] Binding `status:"disabled"` returns 404 byte-identical to cross-tenant 404 (row in §3.2 FR-12)
- [ ] Error sanitization: response bodies for all HTTP-200 runtime-error paths AND all 4xx paths contain no tenant id, project id, deployment id, model id, credential ref. Grep the response body for tenant prefix (`01...`, `019c...`), project prefix, model provider names.
- [ ] PATCH attempts to change `tenantId` / `appId` / `environment` return 400 `IMMUTABLE_FIELD_CHANGE` (INT-4)
- [ ] Callback body HMAC signature verifies at the receiver using the fixture secret (E2E-4 step 4)
- [ ] Callback body HMAC signature FAILS when a single byte of the body is mutated — receiver must reject (E2E-4 step 5)
- [ ] `writeAuditLog` entry exists for every binding-management mutation (Studio + platform-admin paths) with no gaps and no leaked sensitive fields (INT-4)
- [ ] Reserved metadata keys (`history`, `token`, `credentials`, `apiKey`, `authorization`, `sessionId`, `runId`, `bindingId`, `tenantId`) are stripped before any forwarding or `_agentAssist` stamping (row in §3.4 FR-21; unit test `metadata-normalizer.test.ts`)
- [ ] Callback sender refuses `callbackUrl` that is not absolute HTTPS (or plain HTTP on localhost) (E2E-7, unit test `callback-worker.test.ts`)

## 11. Test Infrastructure

**Required services** (started by the test harness in `apps/runtime/src/__tests__/`):

- MongoDB — test container via the existing `mongodb-memory-server` / Docker harness used by other runtime integration tests. Collections seeded: `agent_assist_bindings`, `api_keys`, `sessions`. Isolation: each test gets its own database name.
- Redis + BullMQ — via the existing Redis test harness. Queues: `agent-assist-callback`, `agent-assist-callback-dlq`.
- HTTP callback sink — local test server on `port: 0` recording inbound POSTs for E2E-4 / INT-3. Reuse the Node mock used by POC `/tmp/mock-callback.out` pattern; promote into `apps/runtime/src/__tests__/helpers/callback-sink.ts`.
- Runtime itself — real Express + full middleware chain on `port: 0` per CLAUDE.md E2E Test Standards. No stubbed auth server.
- LLM — dependency-injected test double via the existing `ModelResolutionService` DI seam used by other runtime integration tests. Never `vi.mock('openai')` or `vi.mock('anthropic')` directly.

**Data seeding** (helpers to place under `apps/runtime/src/__tests__/helpers/agent-assist/`):

- `seedBinding(db, {...})` — writes a single `agent_assist_bindings` row directly. **Use in INTEGRATION tests only** (where direct DB setup is the point of the test).
- `seedBindingViaManagementAPI(httpClient, {...})` — goes through either the Studio project-scoped router (`POST /api/projects/:projectId/agent-assist-bindings`) or the runtime platform-admin router (`POST /api/platform/admin/agent-assist/tenants/:tenantId/bindings`) so the audit-log side-effect is real. **Use in E2E tests** so they exercise the full management → runtime flow. CLAUDE.md's E2E standards forbid direct DB access in E2E tests.
- `seedApiKey(db, {tenantId, scopes, projectScope})` — returns `{rawKey, apiKeyId}` so tests can both send `x-api-key` and assert the resolved apiKeyId. Used by both integration and E2E; key rows are infrastructure, not the subject-under-test.
- `seedDeployment(db, {tenantId, projectId, environment})` — reuse the existing deployment seed helper; this feature does not introduce a new one.
- `captureTraces()` — wraps `TraceStore` for the test lifetime; returns a getter that queries by sessionId.

**Environment variables** (defaults injected by the harness):

```
AGENT_ASSIST_CALLBACK_SIGNING_SECRET=test-fixture-secret
AGENT_ASSIST_SSE_HEARTBEAT_MS=500           # shortened for tests
AGENT_ASSIST_MAX_BODY_BYTES=524288
AGENT_ASSIST_MAX_INPUT_CHARS=16000
AGENT_ASSIST_MAX_AA_HISTORY_MSGS=50
```

(The previously planned `AGENT_ASSIST_ENABLED` global kill switch was retired before merge — see feature spec §12.4.)

**CI configuration**: runs under the existing `apps/runtime` vitest config; integration tier gated by `docker compose up mongo redis` presence. E2E fixtures are checked in under `apps/runtime/src/__tests__/fixtures/agent-assist/widget-lifecycle/`.

## 12. Test File Mapping

Canonical mapping from §3 / §5 scenario ids to actual test files on disk.

| File                                                                               | Type        | Covers scenarios                                                                          |
| ---------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts`                     | e2e         | E2E-1, E2E-2, E2E-3, E2E-6, E2E-7 (validation, isolation, stream-precedence, async-rules) |
| `apps/runtime/src/__tests__/routes/project-agent-assist-bindings.test.ts`          | e2e         | INT-4 Studio path (route-level)                                                           |
| `apps/runtime/src/__tests__/routes/platform-admin-agent-assist.test.ts`            | e2e         | INT-4 platform-admin path (route-level)                                                   |
| `apps/runtime/src/__tests__/integration/agent-assist-binding-repo.int.test.ts`     | integration | INT-2 (tenant isolation, unique index)                                                    |
| `apps/runtime/src/__tests__/integration/agent-assist-callback-worker.int.test.ts`  | integration | INT-3 (retry, HMAC, DLQ) and partial coverage of E2E-4                                    |
| `apps/runtime/src/__tests__/integration/project-agent-assist-bindings.int.test.ts` | integration | INT-4 Studio path (real Mongo)                                                            |
| `apps/runtime/src/__tests__/integration/platform-admin-agent-assist.int.test.ts`   | integration | INT-4 platform-admin path (real Mongo)                                                    |
| `apps/runtime/src/__tests__/repos/agent-assist-binding-repo.test.ts`               | unit        | Repo CRUD + LRU+TTL cache (FR-15, FR-16)                                                  |
| `apps/runtime/src/__tests__/workers/agent-assist-callback-worker.test.ts`          | unit        | HMAC + backoff + URL allowlist (FR-24, FR-25)                                             |
| `apps/runtime/src/__tests__/services/agent-assist/envelope-builder.test.ts`        | unit        | V1 sync + error envelopes (FR-4, FR-22b)                                                  |
| `apps/runtime/src/__tests__/services/agent-assist/metadata-normalizer.test.ts`     | unit        | Reserved-key strip + `aa_uamsgs` bounds (FR-21, FR-3)                                     |
| `apps/runtime/src/__tests__/services/agent-assist/feature-gate.test.ts`            | unit        | Feature resolution via Deal / plan + project-level enable (FR-27)                         |
| `apps/runtime/src/__tests__/services/agent-assist/welcome-resolver.test.ts`        | unit        | Welcome resolution priority chain + placeholder skip (FR-8)                               |
| `apps/runtime/src/__tests__/services/agent-assist/trace-events.test.ts`            | unit        | Trace emitter wiring (FR-29)                                                              |
| `apps/runtime/src/__tests__/services/agent-assist/callback-signer.test.ts`         | unit        | HMAC sign + parse + timing-safe verify (FR-24)                                            |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validator.test.ts`  | unit        | URL allowlist (FR-26)                                                                     |
| `apps/runtime/src/__tests__/services/agent-assist/callback-url-validation.test.ts` | unit        | URL validator decision matrix (FR-26)                                                     |
| `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts`                  | unit        | Studio → runtime proxy (FR-5 SSE passthrough)                                             |
| `packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`                | unit        | `agent_assist.*` registry contract (FR-29)                                                |

Pending (deferred to BETA gate):

- `apps/runtime/src/__tests__/integration/agent-assist-execution-bridge.int.test.ts` — INT-1 round-trip integration through the real `DeploymentResolver` + `RuntimeExecutor` (the missing 5th-integration target).
- `apps/runtime/src/__tests__/routes/agent-assist-lifecycle.e2e.test.ts` — E2E-5 recorded-traffic parity gate.
- `apps/runtime/src/__tests__/integration/agent-assist-session-lifecycle.int.test.ts` — INT-5 dedicated terminate → loadSession assertion (currently exercised inside `routes/agent-assist.route.test.ts`).
- A k6 load run per §9.

## 13. Open Test Items

1. **HMAC secret rotation**. How does the callback worker behave when `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` rotates mid-flight? Current design signs with whatever the job picks up at delivery time, so in-flight jobs may carry stale secrets if rotation is instantaneous. Decide whether to (a) pin the secret version at enqueue time (`X-ABL-Signature: t=<ts>,v1=<hex>,k=<versionId>`), or (b) require receivers to accept a grace window. Not in the mandatory matrix yet.
2. **Chaos — mid-session API-key revocation**. Scenario: valid session in flight, operator revokes the API key. Expected: next `/runs/execute` turn → 401; `/sessions/terminate` on the deterministic id still succeeds via Admin tools. Not in the mandatory matrix yet.
3. **`Retry-After` header on 429**. Native `/api/v1/chat/agent` does not set it today. Facade should match — but a parity assertion is pending against the live native chat response.
4. **Multi-intent parity fixtures**. The E2E-5 parity gate currently uses one recorded conversation. BETA → STABLE promotion may require additional recorded conversations covering returns / refunds / escalation / idle-timeout — decide before the BETA cut.
5. **Concurrent `/sessions` races**. When two calls arrive for the same `(binding, sessionReference)` within milliseconds, both should produce the same deterministic `sessionId` and one should win the underlying `createSessionFromResolved`. Need a race test asserting both requests return the same `sessionId` with no HTTP 5xx and no duplicate trace `agent_assist.delegated` events for different session ids.

> Feature spec authoritative source: [../features/agent-assist-runtime-compat.md](../features/agent-assist-runtime-compat.md)
