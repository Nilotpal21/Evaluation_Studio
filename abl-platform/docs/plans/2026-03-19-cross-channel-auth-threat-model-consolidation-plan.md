# Cross-Channel Auth, Threat Model, and E2E Consolidation Plan

**Status:** In progress  
**Date:** 2026-03-19  
**Last updated:** 2026-03-19  
**Completed so far:** SDK/browser auth convergence, durable SDK session materialization for session-scoped HTTP APIs, SDK threat-model/doc refresh, SDK runtime/package black-box coverage, internal `/ws` migration to subprotocol auth, share/preview URL hardening via fragment plus exchange flow, and the explicit query-token allowlist for legacy provider transports.
**Still open:** manifest-derived channel matrix, REST/API, `http_async` and webhook delivery, A2A, voice/provider-channel deep passes, package-side parity coverage, and drift-prevention tooling.

## 1. Objective

Consolidate channel security across the runtime so that:

1. `apps/runtime/src/channels/manifest.ts` is the source of truth for channel inventory and auth mode.
2. Threat-model docs describe the live runtime paths, not stale package assumptions or outdated design notes.
3. Feature docs and test guides agree on what is actually enforced for SDK, HTTP Async, REST/API, A2A, voice, and webhook-backed channels.
4. Black-box E2E coverage exists for the shared security contracts that matter across channels:
   - authn/authz
   - tenant/project/user isolation
   - session ownership
   - replay/idempotency
   - attachment/media ownership
   - streaming and async delivery behavior

## 2. Why This Plan Exists

The repo already has strong building blocks, but they are not yet consolidated into one security story.

| Evidence                                                                                                                            | What it means                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/manifest.ts` defines ingress/auth/delivery for all runtime channels                                      | We already have a canonical inventory, but docs and tests are not fully derived from it                    |
| `docs/testing/channels.md` contains a broad scenario matrix with `CH-*` coverage IDs                                                | We have a good test taxonomy, but threat docs and feature docs are still fragmented                        |
| `docs/security/abl-platform-threat-model.md` currently documents the SDK/browser surface only                                       | The file name suggests platform-wide coverage, but the content is narrower than the actual runtime surface |
| `docs/features/sdk.md` and `docs/testing/sdk.md` explicitly call out package/runtime auth drift                                     | SDK is the clearest example of live-path versus stale-path divergence                                      |
| `docs/testing/webhook-system.md` records missing delivery-worker and full callback round-trip coverage                              | `http_async` and webhook delivery are still missing the strongest black-box checks                         |
| `docs/testing/a2a-integration.md` still lists cross-tenant isolation and restart persistence as gaps                                | A2A is well covered, but not yet aligned with the shared cross-channel threat story                        |
| `docs/testing/voice-capabilities.md` shows many unit/integration tests but no true end-to-end security pass                         | Voice still needs the same auth/isolation treatment as other channels                                      |
| `docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md` contains outdated assumptions (for example, that `packages/web-sdk` does not exist) | Some design docs are now misleading and need either correction or explicit supersession                    |

## 3. Scope

### In scope

- Realtime SDK/web channels:
  - `sdk_websocket`
  - `web_chat`
  - `ag_ui`
  - `web_debug`
- Sync/API/protocol channels:
  - `api`
  - `http`
  - `a2a`
  - `/api/v1/chat/agent`
  - `/api/v1/chat/stream`
- Async/webhook channels:
  - `http_async`
  - `slack`
  - `line`
  - `msteams`
  - `whatsapp`
  - `messenger`
  - `instagram`
  - `twilio_sms`
  - `zendesk`
  - `telegram`
  - `genesys`
  - `email`
- Voice channels:
  - `voice_vxml`
  - `audiocodes`
  - `korevg`
  - `voice_pipeline`
  - `voice`
  - `voice_twilio`
  - `voice_livekit`
- Shared primitives:
  - unified auth
  - session ownership
  - attachment ownership
  - callback URL policy
  - delivery worker
  - connection/session resolution

### Out of scope for the first execution pass

- SearchAI/connector webhook receivers outside the main runtime channel surface
- Full production voice-provider infra bring-up in CI if the repo cannot support it reliably yet
- New auth models beyond what the current runtime already intends to support

Those items should still be linked from the final docs as follow-on work where relevant.

## 4. Source-of-Truth Decisions

1. **Channel inventory and auth mode come from** `apps/runtime/src/channels/manifest.ts`.
2. **Live runtime behavior beats package assumptions and old design docs.**
3. **Threat-model coverage should map to `CH-*` scenario IDs** in `docs/testing/channels.md` instead of inventing a second parallel matrix.
4. **The shared cross-channel contracts must be tested once and reused**, rather than re-describing isolation and ownership from scratch in every feature doc.
5. **Feature docs should document only live behavior.** Historical or aspirational paths should either move to plans or be clearly marked as open gaps.

## 5. Target End State

### Documentation

- `docs/security/SECURITY.md` explains the shared security architecture and links to the canonical channel threat model.
- `docs/security/abl-platform-threat-model.md` becomes the umbrella channel/runtime threat model instead of an SDK-only note.
- Feature docs describe live auth and trust boundaries for each channel family.
- Test guides map threats and gaps to concrete E2E files and scenario IDs.
- Stale or misleading plan docs are either corrected or explicitly marked as superseded.

### Runtime/package behavior

- The browser SDK no longer relies on removed runtime paths such as `?apiKey=` on `/ws/sdk` or `x-api-key` for SDK attachment upload.
- Shared route families document and enforce a single clear auth contract per surface.
- Attachments, sessions, and messages use the same ownership rules across SDK, REST/API, async, and channel ingress paths.

### Test coverage

- A manifest-driven harness can bootstrap tenants, projects, channels, API keys, SDK keys, and callback receivers without DB shortcuts.
- Shared auth/isolation scenarios run across all channel families.
- Family-specific transport quirks are covered in dedicated suites.

## 6. Workstreams

### Phase 0: Build the channel security matrix

**Status:** Not started. The repo still does not have a maintained manifest-derived channel security matrix embedded into the docs.

Create one working matrix derived from `apps/runtime/src/channels/manifest.ts` with these columns:

- channel type
- ingress mode
- auth mode
- delivery mode
- session key / ownership model
- attachment/media behavior
- streaming behavior
- current feature doc
- current test guide
- live runtime entrypoint
- E2E file
- threat IDs
- known gap or drift

Primary files to inspect and align:

- `apps/runtime/src/channels/manifest.ts`
- `apps/runtime/src/routes/chat.ts`
- `apps/runtime/src/routes/sdk-init.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/routes/http-async-channel.ts`
- `apps/runtime/src/routes/channel-webhooks.ts`
- `apps/runtime/src/routes/channel-vxml.ts`
- `apps/runtime/src/routes/channel-genesys.ts`
- `apps/runtime/src/routes/channel-audiocodes.ts`
- `apps/runtime/src/routes/voice.ts`
- `apps/runtime/src/routes/attachments.ts`
- `apps/runtime/src/server.ts`
- `packages/a2a/src/infrastructure/express-handlers.ts`

Deliverable:

- A maintained implementation matrix embedded into the umbrella threat model and reflected in `docs/features/channels.md`.

### Phase 1: Consolidate the threat model

**Status:** In progress. The umbrella threat model, SDK-family docs, internal `/ws` auth docs, share/preview docs, and query-token allowlist doc were updated, but the REST/API, `http_async`/webhook, A2A, and voice family docs are not yet fully converged on the same threat model.

Restructure the security docs so they reflect channel families rather than one-off slices.

Primary doc targets:

- `docs/security/SECURITY.md`
- `docs/security/abl-platform-threat-model.md`
- `docs/features/channels.md`
- `docs/features/sdk.md`
- `docs/features/webhook-system.md`
- `docs/features/a2a-integration.md`
- `docs/features/voice-capabilities.md`

Required changes:

1. Convert `docs/security/abl-platform-threat-model.md` from the current SDK-focused note into the umbrella runtime/channel threat model.
2. Keep SDK as the first detailed annex inside that umbrella model because it currently has the largest live-versus-stale drift.
3. Add family sections for:
   - SDK/web
   - REST/API
   - HTTP Async and webhook delivery
   - provider webhooks
   - A2A
   - voice
4. For each family, document:
   - entrypoints
   - trust boundaries
   - bearer or shared-secret risks
   - isolation model
   - replay/idempotency story
   - attachment/media risks
   - known stale paths
5. Add direct traceability from threat IDs to `CH-*` test scenarios.

Minimum threat categories to standardize:

- bearer-token replay and session cloning
- bootstrap credential misuse
- cross-tenant/project/user data access
- webhook signature bypass and callback forgery
- callback SSRF and secret leakage
- attachment/media ownership bypass
- live-path versus stale-path protocol drift
- async delivery duplication, retry, and race conditions
- voice ingress/session leakage
- A2A context and task isolation

### Phase 2: Fix live-path versus stale-path drift

This phase is about implementation convergence before broadening docs claims.

#### 2A. SDK/package convergence

**Status:** Completed for the live browser SDK/runtime transport path. The checked-in browser SDK now bootstraps through `/api/v1/sdk/init`, Studio preview/share clients now use the same `Sec-WebSocket-Protocol: sdk-auth,<token>` transport with runtime-compatible `sdk_session` tokens, SDK attachments use `X-SDK-Token`, and the stale `/ws/sdk?apiKey=...` and query-token SDK path are removed/rejected. Preview/share token issuance is still Studio-mediated and remains an explicit follow-up for issuer-boundary consolidation.

Primary code targets:

- `packages/web-sdk/src/core/SessionManager.ts`
- `packages/web-sdk/src/chat/ChatClient.ts`
- `packages/web-sdk/src/core/AgentSDK.ts`
- `apps/runtime/src/routes/sdk-init.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`
- `apps/runtime/src/routes/attachments.ts`
- `apps/runtime/src/routes/sdk.ts`

Required outcomes:

1. Browser SDK bootstraps through `/api/v1/sdk/init` and authenticates to `/ws/sdk` using the live runtime contract.
2. SDK attachment upload uses session-authenticated routes instead of `x-api-key`.
3. Runtime/package docs stop describing the removed `?apiKey=` path as if it were live.
4. If URL-token transport remains temporarily necessary, docs and tests call it out consistently as a bearer-token replay surface.

#### 2B. Cross-family auth reconciliation

**Status:** In progress. Internal `/ws`, Studio share/preview URLs, and the shared query-token guardrail are now reconciled. `/ws` rejects invalid bearer tokens during upgrade, share links are fragment-only with no legacy query fallback, and the runtime now has a source guard test for query-token exceptions. The REST/API, `http_async`, provider-webhook, and broader voice family route passes are still open.

Primary code and route targets:

- `apps/runtime/src/routes/chat.ts`
- `apps/runtime/src/routes/http-async-channel.ts`
- `apps/runtime/src/routes/channel-webhooks.ts`
- `apps/runtime/src/routes/channel-vxml.ts`
- `apps/runtime/src/routes/channel-genesys.ts`
- `apps/runtime/src/routes/channel-audiocodes.ts`
- `apps/runtime/src/routes/voice.ts`
- `apps/runtime/src/middleware/auth.ts`
- `packages/shared-auth/src/middleware/session-ownership.ts`

Required outcomes:

1. Every route family named in docs has one clear auth contract that matches the manifest.
2. Every session-resume or attachment path uses tenant/project/user ownership checks consistently.
3. Every cross-scope denial returns the intended concealment response (`404` where existence should be hidden).
4. Replay/idempotency expectations are explicit for webhook and async delivery surfaces.

### Phase 3: Build the shared black-box harness

**Status:** Not started as a shared workstream. Existing runtime harnesses were sufficient for the SDK/browser slice, but the broader cross-family helper expansion in this phase has not been done yet.

Extend the existing helpers so channel-security tests can share bootstrap and assertion logic.

Primary helper targets:

- `apps/runtime/src/__tests__/helpers/channel-e2e-bootstrap.ts`
- `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`
- `apps/runtime/src/__tests__/helpers/redis-server-harness.ts`
- `apps/runtime/src/__tests__/helpers/slack-api-harness.ts`
- `apps/runtime/src/__tests__/helpers/telegram-bot-api-harness.ts`
- `apps/runtime/src/__tests__/helpers/twilio-api-harness.ts`
- `apps/runtime/src/__tests__/helpers/multimodal-service-harness.ts`

New helper targets to add:

- `apps/runtime/src/__tests__/helpers/callback-capture-server.ts`
- `apps/runtime/src/__tests__/helpers/ws-client-harness.ts`
- `apps/runtime/src/__tests__/helpers/email-capture-harness.ts`

Harness capabilities to add:

- bootstrap second tenant and second project through APIs only
- create SDK public keys and API keys through public control-plane routes
- create webhook subscriptions and inspect delivery callbacks
- run real WebSocket clients for SDK and voice surfaces
- capture async callback deliveries for `http_async`
- assert 404 concealment and ownership boundaries without direct DB reads

### Phase 4: Add shared cross-channel E2E suites

**Status:** In progress. The SDK runtime E2E suite was expanded substantially and a new internal `/ws` runtime E2E now covers subprotocol auth enforcement, but the shared REST/API, `http_async`, webhook-security, delivery-worker, and package-side suites listed here are still open.

These suites should cover the contracts that apply to more than one family.

Primary targets to extend:

- `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts`
- `apps/runtime/src/__tests__/message-ownership-authz.test.ts`
- `apps/runtime/src/__tests__/chat-session-ownership.test.ts`
- `apps/runtime/src/__tests__/session-ownership-authz.test.ts`

New suites to add:

- `apps/runtime/src/__tests__/channels-api-http-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-http-async-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/delivery-worker.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-webhook-security.e2e.test.ts`
- `packages/web-sdk/src/__tests__/package-runtime.e2e.test.ts`

Scenario groups to implement from `docs/testing/channels.md`:

- `CH-CONN-*`
- `CH-SDK-*`
- `CH-ISO-*`
- `CH-MSG-*`
- `CH-SEC-*`
- `CH-HTTPA-*`
- `CH-WEB-*`
- `CH-API-*`
- `CH-HTTP-*`

### Phase 5: Execute family-specific deep passes

#### 5A. SDK/web family

**Status:** In progress and largely complete on the runtime side. The runtime suite now proves `sdk/init -> ws/sdk -> attachment route`, token transport enforcement, ownership, scope boundaries, and Studio preview/share exchange parity on the Studio/runtime side, but a dedicated `packages/web-sdk/src/__tests__/package-runtime.e2e.test.ts` file is still open.

Primary tests:

- `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/sdk-session-token.test.ts`
- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`
- `packages/web-sdk/src/__tests__/package-runtime.e2e.test.ts`

Must prove:

- `/api/v1/sdk/init` to live WebSocket bootstrap
- refresh behavior
- attachment upload/download ownership
- preview/share parity with runtime-issued sessions
- stale package path removed or fails fast with clear messaging

#### 5B. HTTP Async and webhook family

**Status:** Not started.

Primary tests:

- `apps/runtime/src/__tests__/http-async-channel-authz.test.ts`
- `apps/runtime/src/__tests__/http-async-regenerate-secret.test.ts`
- `apps/runtime/src/__tests__/http-async-session-key.test.ts`
- `apps/runtime/src/__tests__/http-async-events.test.ts`
- `apps/runtime/src/__tests__/delivery-worker.e2e.test.ts`
- `apps/runtime/src/__tests__/webhooks/channel-webhooks-route.test.ts`
- `apps/runtime/src/__tests__/webhooks/channel-webhooks-twilio-route.test.ts`
- `apps/runtime/src/__tests__/webhooks/infobip-webhook-route.test.ts`
- `apps/runtime/src/__tests__/webhooks/gupshup-webhook-route.test.ts`

Must prove:

- callback URL SSRF policy
- signature verification
- delivery-worker correctness
- callback retry/idempotency
- message-to-callback full round trip
- provider webhook auth consistency

#### 5C. REST/API family

**Status:** Not started.

Primary tests:

- `apps/runtime/src/__tests__/chat-routes.test.ts`
- `apps/runtime/src/__tests__/channels-api-http-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/stress/runtime-channel-stress.test.ts`

Must prove:

- API-key auth for `api` and `http` channels
- `/api/v1/chat/agent` and `/api/v1/chat/stream` enforce ownership on resumed sessions
- foreign `sessionId` cannot be used as an oracle
- sync and stream responses preserve the same isolation rules

#### 5D. A2A family

**Status:** Not started.

Primary tests:

- `packages/a2a/src/__tests__/cross-tenant-e2e.test.ts`
- `packages/a2a/src/__tests__/tenant-isolation-integration.test.ts`
- `packages/a2a/src/__tests__/task-lifecycle-integration.test.ts`
- `packages/a2a/src/__tests__/streaming-integration.test.ts`

Must prove:

- API-key auth on agent card and JSON-RPC
- cross-tenant isolation with separate credentials
- `tasks/cancel`
- structured payload fidelity
- restart/session persistence expectations

#### 5E. Voice family

**Status:** Not started.

Primary tests:

- `apps/runtime/src/__tests__/channels-voice-ingress.e2e.test.ts`
- `apps/runtime/src/__tests__/channel-voice-ingress-auth.test.ts`
- `apps/runtime/src/__tests__/livekit-voice-e2e.test.ts`
- `apps/runtime/src/__tests__/voice-twilio-sig.test.ts`

New suites to add:

- `apps/runtime/src/__tests__/channels-voice-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-audiocodes-runtime.e2e.test.ts`

Must prove:

- token/HMAC auth on live ingress routes
- sync-webhook session continuity for VXML and Genesys
- websocket voice session isolation for AudioCodes and realtime voice
- no transcript/session leakage across concurrent calls

#### 5F. Remaining provider channels

**Status:** Not started.

Primary tests to extend or add:

- `apps/runtime/src/__tests__/channels-slack-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-telegram-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/channels-twilio-runtime.e2e.test.ts`
- `apps/runtime/src/__tests__/email-channel-e2e.test.ts`
- new `apps/runtime/src/__tests__/channels-line-runtime.e2e.test.ts`
- new `apps/runtime/src/__tests__/channels-msteams-runtime.e2e.test.ts`
- new `apps/runtime/src/__tests__/channels-whatsapp-runtime.e2e.test.ts`
- new `apps/runtime/src/__tests__/channels-meta-runtime.e2e.test.ts`
- new `apps/runtime/src/__tests__/channels-zendesk-runtime.e2e.test.ts`

Goal:

- bring every manifest channel to the same minimum auth/isolation baseline
- keep provider-specific quirks in family tests instead of duplicating the generic security cases

### Phase 6: Converge and clean up docs

**Status:** In progress. SDK docs, internal SDK auth docs, setup notes, the umbrella threat-model file, the query-token allowlist doc, and the stale SDK auth plan note were updated, but the broader channel-family doc convergence in this phase remains open.

After the implementation and tests are in place, update all security-adjacent docs in one pass.

Primary targets:

- `docs/security/SECURITY.md`
- `docs/security/abl-platform-threat-model.md`
- `docs/features/channels.md`
- `docs/features/sdk.md`
- `docs/features/webhook-system.md`
- `docs/features/a2a-integration.md`
- `docs/features/voice-capabilities.md`
- `docs/testing/channels.md`
- `docs/testing/sdk.md`
- `docs/testing/webhook-system.md`
- `docs/testing/a2a-integration.md`
- `docs/testing/voice-capabilities.md`
- `docs/setup/DEV_ENVIRONMENT_SETUP.md`

Stale-doc cleanup targets:

- `docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md`

Cleanup rules:

1. Remove or clearly mark stale paths and outdated assumptions.
2. Do not duplicate the same auth story in five places; link back to the umbrella threat model and the channel manifest-driven feature doc.
3. Record residual gaps only when they are real and still open after the test pass.
4. Every open gap in a test guide should point at a concrete file or scenario ID.

### Phase 7: Add drift-prevention checks

**Status:** Not started.

Add lightweight checks so docs, manifest, and tests do not diverge again.

Suggested targets:

- `tools/validate-channel-doc-parity.ts`
- `tools/validate-channel-test-matrix.ts`

Suggested checks:

- every manifest channel appears in `docs/features/channels.md`
- every manifest channel maps to at least one E2E file in `docs/testing/channels.md`
- SDK docs do not mention removed auth transports
- threat-model matrix links only to live routes or clearly marked planned changes

## 7. Family-to-File Execution Matrix

| Family              | Primary runtime/package files                                                                                                                                                                                          | Primary doc files                                                                                       | Primary test files                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK/web             | `apps/runtime/src/routes/sdk-init.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/routes/attachments.ts`, `packages/web-sdk/src/core/SessionManager.ts`, `packages/web-sdk/src/chat/ChatClient.ts` | `docs/security/abl-platform-threat-model.md`, `docs/features/sdk.md`, `docs/testing/sdk.md`             | `apps/runtime/src/__tests__/channels-sdk-runtime.e2e.test.ts`, `packages/web-sdk/src/__tests__/package-runtime.e2e.test.ts`                                                                                              |
| REST/API            | `apps/runtime/src/routes/chat.ts`, `apps/runtime/src/middleware/auth.ts`                                                                                                                                               | `docs/features/channels.md`, `docs/testing/channels.md`                                                 | `apps/runtime/src/__tests__/channels-api-http-runtime.e2e.test.ts`, `apps/runtime/src/__tests__/chat-routes.test.ts`                                                                                                     |
| HTTP Async/webhooks | `apps/runtime/src/routes/http-async-channel.ts`, `apps/runtime/src/routes/channel-webhooks.ts`, `apps/runtime/src/services/queues/delivery-worker.ts`                                                                  | `docs/features/webhook-system.md`, `docs/testing/webhook-system.md`, `docs/testing/channels.md`         | `apps/runtime/src/__tests__/channels-http-async-runtime.e2e.test.ts`, `apps/runtime/src/__tests__/delivery-worker.e2e.test.ts`                                                                                           |
| A2A                 | `apps/runtime/src/server.ts`, `apps/runtime/src/services/a2a/agent-card-builder.ts`, `packages/a2a/src/infrastructure/express-handlers.ts`                                                                             | `docs/features/a2a-integration.md`, `docs/testing/a2a-integration.md`                                   | `packages/a2a/src/__tests__/cross-tenant-e2e.test.ts`, `packages/a2a/src/__tests__/task-lifecycle-integration.test.ts`                                                                                                   |
| Voice               | `apps/runtime/src/routes/channel-vxml.ts`, `apps/runtime/src/routes/channel-genesys.ts`, `apps/runtime/src/routes/channel-audiocodes.ts`, `apps/runtime/src/routes/voice.ts`                                           | `docs/features/voice-capabilities.md`, `docs/testing/voice-capabilities.md`, `docs/testing/channels.md` | `apps/runtime/src/__tests__/channels-voice-ingress.e2e.test.ts`, `apps/runtime/src/__tests__/channels-voice-runtime.e2e.test.ts`                                                                                         |
| Provider channels   | `apps/runtime/src/routes/channel-webhooks.ts`, `apps/runtime/src/channels/adapters/*`                                                                                                                                  | `docs/features/channels.md`, `docs/testing/channels.md`, `docs/features/webhook-system.md`              | `apps/runtime/src/__tests__/channels-slack-runtime.e2e.test.ts`, `apps/runtime/src/__tests__/channels-telegram-runtime.e2e.test.ts`, `apps/runtime/src/__tests__/channels-twilio-runtime.e2e.test.ts`, new family suites |

## 8. Sequencing

Recommended implementation order:

1. Build the matrix from the manifest and live route inventory.
2. Fix the SDK live-path drift first because it currently creates the largest docs/runtime mismatch.
3. Add the shared black-box harness and the missing `http_async` delivery-worker tests.
4. Add REST/API and shared ownership E2E coverage.
5. Extend A2A coverage using the existing package-level E2E foundation.
6. Add the voice-family black-box pass.
7. Finish the remaining provider channels.
8. Update docs in one convergence pass.
9. Add drift-prevention checks.

## 9. Acceptance Criteria

This plan is complete when all of the following are true:

1. `docs/security/abl-platform-threat-model.md` is a true umbrella runtime/channel threat model, not just an SDK note.
2. `docs/features/channels.md` and `docs/testing/channels.md` align with `apps/runtime/src/channels/manifest.ts`.
3. SDK package/runtime docs no longer imply that removed auth paths are live.
4. `http_async` has both direct delivery-worker coverage and a full message-to-callback black-box E2E.
5. REST/API routes have black-box coverage for auth, ownership, and foreign-session denial.
6. A2A has explicit cross-tenant, cancellation, and persistence expectations covered or clearly documented as open.
7. Voice routes have route-level auth and session-isolation E2E coverage, even if full external-media infra remains staged.
8. Every manifest channel family has at least one concrete E2E file linked from `docs/testing/channels.md`.
9. Stale or inaccurate design docs are corrected or marked as superseded.

## 10. Risks and Mitigations

| Risk                                                     | Impact | Mitigation                                                                             |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| SDK convergence changes break existing package consumers | High   | Ship package/runtime E2E before removing fallback behavior; document migration clearly |
| Voice true E2E is hard to run in CI                      | Medium | Split route-auth/session-isolation E2E from full external-media validation             |
| Doc cleanup gets ahead of implementation                 | Medium | Update docs only after live-path confirmation or clearly label gaps as open            |
| Manifest and tests drift again after this pass           | Medium | Add parity checks and require docs/test updates when manifest auth mode changes        |

## 11. Verification Strategy

For each implementation slice:

1. `pnpm build` before running targeted tests.
2. Run the family-specific test suites touched by the change.
3. Update the matching `docs/testing/*.md` guide in the same slice.
4. Keep the umbrella threat model current as slices land, not only at the end.
