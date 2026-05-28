# Runtime Channel Contract Rollout Plan

**Date:** 2026-03-29  
**Status:** Near Complete — phases 1-7a are landed; remaining work is final parity close-out and compatibility quarantine  
**Scope:** Runtime channel contracts, Studio debug config surfacing, trace correlation, auth semantics, payload degradation, timeout normalization, and session/identity parity.

---

## Goals

1. Keep Studio debug as the only surface that shows configuration banners.
2. Preserve normalized end-user output for all non-debug channels.
3. Make traceability and channel-specific behavior explicit.
4. Roll out changes incrementally with parity tests at each boundary.

## Architecture Alignment

This rollout now sits alongside the upstream lifecycle architecture introduced on 2026-03-30:

- [docs/features/sub-features/session-timeout-disposition-unification.md](/Users/prasannaarikala/projects/f-1/abl-platform/docs/features/sub-features/session-timeout-disposition-unification.md)
- [docs/specs/session-timeout-disposition-unification.hld.md](/Users/prasannaarikala/projects/f-1/abl-platform/docs/specs/session-timeout-disposition-unification.hld.md)
- [docs/plans/session-timeout-disposition-unification.lld.md](/Users/prasannaarikala/projects/f-1/abl-platform/docs/plans/session-timeout-disposition-unification.lld.md)

Alignment rules for this channel-contract rollout:

1. Session/identity continuity work may extend bootstrap and caller-context propagation, but it must not introduce new timeout or disposition policy forks.
2. Voice and messaging handlers should continue to converge on shared session creation and DB-session linking helpers so they can adopt the future lifecycle policy service with minimal churn.
3. Any new disconnect, cleanup, or explicit-close behavior must defer to the shared lifecycle/disposition services once those land upstream.
4. Phase 7 work is considered structurally complete only when its session bootstrap changes compose cleanly with the lifecycle-unification plan, rather than competing with it.
5. The rollout should converge on one canonical external/stored `sessionId`; `runtimeSessionId` must be treated as internal transitional state only and should not be expanded as a new continuity contract.

---

## Landed Phases

### Phase 1: Explicit Channel Contract

- Added a typed per-channel behavior contract covering trace delivery, banner policy, auth modes, payload modes, timeout handling, session lifecycle, and identity linking.
- Added contract conformance coverage so manifest and contract rows cannot silently drift.

### Phase 2: Studio Debug Configuration Diagnostics

- Execution-time configuration failures can now project into Studio debug banner/error surfaces.
- Chat output remains normalized, and the underlying trace still preserves the original handled error.
- `session_health` remains limited to session setup and infrastructure health.

### Phase 3: Trace Envelope and Correlation Alignment

- Added explicit trace context on HTTP sync and async outcomes.
- Tightened SDK websocket trace parsing and correlation behavior.
- Added public outcome sanitization and channel-aware payload renderability checks.

### Phase 4: Explicit Auth Semantics by Channel Family

- Added canonical auth codes and aligned websocket auth lifecycle traces with those codes.
- Preserved the existing UX split:
  - websocket channels remain interactive
  - non-interactive channels remain outcome-only
- Added parity coverage so auth traces/payloads no longer depend on transport-specific wording alone.

### Phase 5: Payload Degradation Contract

- Made payload/renderability behavior more explicit by channel family.
- Preserved `voiceConfig` through runtime → SDK transport → Studio bridges.
- Kept degradation explicit where a channel is text-only or action-limited rather than silently dropping payload parts.

### Phase 6: Timeout Normalization

- Moved more HTTP, async, and voice paths onto shared outcome/timeout handling.
- Added synthetic outcome traces for previously trace-blind shortcut branches.
- Normalized AudioCodes and tightened parity on non-`ok` outcomes.

### Phase 7: Session Lifecycle and Identity Linking

- Landed the messaging-first continuity slice:
  - normalized caller identity persistence
  - artifact-based same-channel resume
  - deployment mismatch fallback
  - provider-verified contact-linking bootstrap
- Added policy-driven provider verification strength:
  - weak by default
  - strong when explicitly configured
- Exposed provider verification strength through the project-scoped control plane and Studio deployment UI.
- Added targeted messaging E2E coverage for `http_async` continuity and control-plane configuration.

### Phase 7a: Canonical Session ID and `runtimeSessionId` Cleanup

- Converged active/public runtime flows on one canonical `sessionId`.
- Cleaned stored/public lookup paths and websocket handlers so `runtimeSessionId` is no longer the active continuity contract.
- Preserved legacy compatibility aliases only where needed:
  - SDK/browser alias compatibility
  - OAuth/session-artifact storage compatibility
  - a small number of older DB-row fallback paths
- Added CI-safe behavior for Redis-backed E2E suites so missing Redis infrastructure skips those suites instead of failing the whole worker.

---

## New Follow-Up Added From Live Validation

### Phase 3a: Configuration Taxonomy and Projection Cleanup

**Why this was added**

Live Studio validation confirmed the intended behavior is working:

- Studio debug banner shows configuration-class failures.
- Chat shows normalized fallback text.
- Traces preserve the real configuration cause.

But the current trace model is noisier than desired:

- `agent_error_handled` still reports `unknown_error` even when the runtime can classify the underlying configuration issue.
- Studio projects a second derived `configuration_trace` event from that same handled error for banner/error surfaces.
- This makes a single failure appear as two errors in the trace UI.

There is also taxonomy duplication across the live runtime path and the diagnostics engine:

- Live/runtime examples:
  - `LLM_CREDENTIAL_MISSING`
  - `LLM_MODEL_NOT_CONFIGURED`
  - `LLM_WIRING_FAILED`
- Diagnostics-engine examples:
  - `NO_CREDENTIAL`
  - `NO_ACTIVE_CREDENTIAL`
  - `NO_MODEL_RESOLVED`
  - `PROVIDER_NOT_ALLOWED`
  - `CREDENTIAL_STALE`

**Planned cleanup**

1. Make handled runtime configuration failures use a specific error family instead of defaulting to `unknown_error` when classification is available.
2. Keep `configuration_trace` as the Studio banner/errors-tab projection, but collapse or de-emphasize the duplicate raw/derived pair in trace presentation.
3. Define a canonical configuration error taxonomy shared by:
   - live runtime/session health
   - handled execution traces
   - diagnostics engine findings
4. Map diagnostics-engine findings onto canonical families instead of maintaining overlapping code sets with different names.

**Boundary decision**

- `tool_warnings` remain a separate non-banner path.
- They should continue to surface as notices/logs and normalized outcome diagnostics.
- They are configuration-adjacent, but not the same as Studio debug banner-eligible LLM/session configuration failures.

---

## Current Focus

### Final Parity Audit and Close-Out

**Goal**

Close the rollout with an explicit final parity proof across active channel families, while keeping the remaining `runtimeSessionId` references quarantined to documented compatibility/storage boundaries only.

**Current next slices**

1. Run the final cross-channel parity proof pass:
   - auth semantics
   - async OAuth
   - session lifecycle/history
   - identity/contact support
   - payload normalization
   - streaming / presence / thought semantics
   - proactive delivery
   - session closure and outcome evidence
2. Tighten the remaining compatibility-only `runtimeSessionId` boundaries:
   - keep `sessionId` canonical in services and active runtime flows
   - leave legacy storage/wire compatibility only where explicitly documented
3. Finish the final documentation sync:
   - rollout plan
   - parity matrix
   - any remaining feature/test wording that still overstates or understates parity

### Final Cross-Channel Parity Audit Scope

The final audit pass should explicitly score every active channel family against
the following dimensions, not just the original contract axes:

1. Auth semantics
   - auth profile support
   - preflight auth
   - JIT auth
   - async OAuth / pending OAuth callback handling
2. Session lifecycle
   - create / resume / join
   - canonical `sessionId`
   - explicit session closure / cleanup support
   - omnichannel history continuity
3. Identity
   - caller identity propagation
   - identity management
   - identity verification strength
   - contact linking / `contactId` support
4. Payload contract
   - rich content support
   - attachment upload / attachment echo support
   - form submission support
   - channel-specific payload transforms
   - data normalization across channels
   - channel-level action support
5. Streaming and presence
   - response streaming
   - typing indicators
   - thoughts / thought streaming
   - proactive notifications / outbound-initiated messages
6. Traceability and observability
   - trace delivery model
   - outcome normalization
   - timeout/error causality
   - configuration / health diagnostics
7. Protocol families
   - unify `sdk_chat`, `sdk_websocket`, and `web_chat` as one logical conversational surface
   - treat protocol differences, form submission capability, and attachment support as explicit sub-dimensions
   - include `a2a` as an audited channel family rather than leaving it implicit, and classify it as a supported partial parity family when the remaining differences are protocol-semantic rather than missing runtime support

Audit outputs must include:

- a per-channel-family parity matrix
- explicit `working` / `partial` / `gap` calls per dimension
- links to the supporting runtime / SDK / Studio files
- the next smallest implementation slice for each remaining `gap`

### Current Final-Audit Readout

- **Closed enough to treat as contract-complete:** Studio debug, SDK conversational family, HTTP sync, HTTP async, A2A semantics, canonical session identity convergence.
- **Explicitly partial by protocol/design:** messaging adapters, SDK voice family, sync webhook / telephony bridge, LiveKit voice.
- **AG-UI is now explicitly scoped as a separate stack:** parity discussions should treat it as SSE/UI-event specific rather than assuming chat/voice contract equivalence.
- **Voice-family partials are now explicitly classified:** Twilio and KoreVG carry stronger provider-derived outcome evidence, while LiveKit/VXML/AudioCodes remain transport-lifecycle-evidence members with different closure semantics.
- **Still compatibility-only:** the documented `runtimeSessionId` storage/wire remnants.

### Phase 4: Explicit Auth Semantics by Channel Family

**Goal**

Make preflight auth and JIT auth behavior explicit and consistent across channel families without forcing all channels into the same UX.

**Deliverables**

1. Add canonical auth outcome/trace codes for:
   - `AUTH_PREFLIGHT_REQUIRED`
   - `AUTH_PREFLIGHT_SATISFIED`
   - `AUTH_JIT_REQUIRED`
   - `AUTH_JIT_UNSUPPORTED`
2. Align channel contracts with the actual behavior of:
   - Studio debug websocket
   - SDK websocket / web chat
   - Preview
   - HTTP sync
   - HTTP async / messaging
   - voice channels
3. Preserve current interaction model:
   - websocket channels stay interactive
   - non-interactive channels remain outcome-only
4. Add parity tests so working auth paths do not regress while behavior becomes explicit.

**Delivered**

Phase 4a focuses on making the interactive auth contract explicit without changing UX:

- add canonical auth `code` fields to websocket auth messages:
  - `auth_required`
  - `auth_gate_updated`
  - `auth_gate_satisfied`
  - `auth_challenge`
  - `message_queued`
- keep existing human-readable `reason`/message payloads unchanged
- add `authCode` to non-interactive JIT-unsupported tool results so HTTP and async callers can distinguish canonical auth semantics from legacy transport-specific codes

---

## Remaining Planned Phases

### Phase 5: Payload Degradation Contract

- Make `richContent` and `voiceConfig` degradation explicit per channel family.
- Decide whether the public SDK fully carries `voiceConfig` or intentionally degrades it.
- **Current status:** largely landed; final parity audit still pending.

### Phase 6: Timeout Normalization

- Bring remaining direct-handler and websocket outliers onto the shared timeout/outcome model where appropriate.
- Keep UX differences explicit in the contract.
- **Current status:** mostly landed; one last voice/direct-handler parity sweep still pending.

### Phase 7: Session Lifecycle and Identity Linking

- Make `new`, `resume`, and `join` support explicit by channel family.
- Move messaging first, then voice, toward the more complete session/identity initialization path.
- Keep timeout/disposition policy out of the continuity slices; those concerns move to the shared lifecycle services defined by the upstream unification architecture.
- Prefer shared bootstrap primitives (`createRuntimeSession`, `createAndLinkDBSession`, caller-context propagation) over channel-local lifecycle behavior so voice and messaging can adopt the later policy-service phases without another large refactor.
- **Current status:** messaging-first slice landed; voice parity remains the main open implementation area.

### Phase 7a: Canonical Session ID and `runtimeSessionId` Cleanup

**Goal**

Converge the platform on one canonical external/stored `sessionId` for channel continuity, APIs, persistence, and observability, while shrinking `runtimeSessionId` into an internal compatibility detail and then removing it from public/runtime-adjacent contracts where possible.

**Why this needs its own phase**

- Current code still mixes:
  - canonical DB/public session IDs
  - runtime executor in-memory session IDs
  - fallback lookup paths that treat the two as partially interchangeable
- That ambiguity leaks into:
  - session routes and observability lookup flows
  - voice bootstrap handlers
  - OAuth / auth-session artifact linkage
  - trace correlation and session cleanup paths
- Continuing Phase 7 without an explicit cleanup plan risks hardening the wrong identifier into more channel contracts.

**Deliverables**

1. Define the canonical identifier contract:
   - public APIs, channel continuity, persistence, and trace correlation use one `sessionId`
   - `runtimeSessionId` is internal-only and not a new public continuity key
2. Inventory all remaining `runtimeSessionId` references and classify them:
   - compatibility shim
   - internal runtime lifecycle usage
   - accidental/public leakage
3. Stop introducing new `runtimeSessionId` dependencies in:
   - channel bootstrap
   - session resume/join
   - voice continuity
   - observability/session export surfaces
4. Add compatibility-preserving migrations for legacy lookup paths:
   - keep old lookups working while canonical `sessionId` becomes authoritative
   - add explicit TODO/remove gates so compatibility code does not become permanent
5. Clean up documentation and tests so they describe one canonical session identifier model.

**Suggested slice order**

1. Stored/public lookup cleanup:
   - canonicalize stored/public session lookup surfaces on one `sessionId`
   - remove dead stored-session fallback paths that still pretend DB/public session ids differ from runtime ids
2. Remaining-reference inventory:
   - document every remaining `runtimeSessionId` read/write path
   - mark which ones are internal-only vs public-facing
3. Voice/bootstrap parity:
   - LiveKit, KoreVG, Twilio should bind continuity to canonical `sessionId`
   - runtime session linkage stays internal after bootstrap
4. Public/API cleanup:
   - remove or de-emphasize `runtimeSessionId` from public DTOs, traces, export payloads, and Studio-facing contracts where not strictly required
5. Removal pass:
   - once compatibility usage is near-zero and parity tests are green, remove dead references and compatibility shims

**Current snapshot (2026-03-30)**

- Completed in this phase:
  - stored/public session repo helpers are canonical-id-first
  - session-access and platform-admin session summary lookups no longer harden a separate stored `runtimeSessionId` path
  - `sessions` routes now resolve stored trace/export/cleanup paths against canonical stored `sessionId`
  - internal debug websocket and HTTP chat routes no longer rely on `runtimeSessionId`
  - SDK websocket `session_start` now emits only canonical `sessionId`
  - browser SDK session management and public events now use canonical `sessionId` only; the deprecated raw alias has been removed
  - Twilio, KoreVG, and LiveKit runtime voice paths are now confirmed to operate on canonical `sessionId`
  - the LiveKit integration suite now resolves the real TravelDesk example DSLs again and uses `getSessionId()` terminology instead of the stale `getRuntimeSessionId()` wording
  - pending OAuth state now exposes only canonical `sessionId` in typed service contracts; legacy `runtimeSessionId` state is normalized at the Redis boundary on read
- Remaining `runtimeSessionId` reference hotspots (inventory snapshot):
  - repo/storage compatibility:
    - `apps/runtime/src/repos/session-repo.ts` (`4`) — canonical-id-first helper still falls back to legacy `runtimeSessionId` on older persisted rows
  - session-scoped OAuth/storage compatibility:
    - `apps/runtime/src/services/tool-oauth-service.ts` (`3`) — legacy Redis pending-state fallback only
    - `apps/runtime/src/services/oauth-token-store.ts` (`9`) — Mongo storage shim for legacy `runtimeSessionId` field
    - `packages/database/src/models/session-oauth-artifact.model.ts` (`3`) — persisted legacy field and index
  - no remaining active runtime-path references in:
    - `apps/runtime/src/websocket/handler.ts`
    - `apps/runtime/src/routes/chat.ts`
    - `apps/runtime/src/routes/sessions.ts`
    - `apps/runtime/src/websocket/twilio-media-handler.ts`
    - `apps/runtime/src/services/voice/korevg/korevg-router.ts`
    - `apps/runtime/src/services/voice/korevg/korevg-session.ts`
    - `packages/web-sdk/src/core/SessionManager.ts`

**Interpretation**

- The dominant remaining work is now **compatibility cleanup**, not active runtime lifecycle divergence.
- The only production-code references left are compatibility helpers and persisted legacy storage fields; there is no remaining active transport/session-lifecycle feature work depending on `runtimeSessionId`.
- Next slices should focus on:
  - collapsing the last deprecated SDK/browser event alias once downstream consumers are ready
  - encapsulating or migrating the session-scoped OAuth legacy storage field
  - removing the last stale docs/test references that still imply a second runtime-session identifier
- Do **not** reintroduce stored/public fallback logic while addressing those areas; the canonical stored/public contract is already converging correctly.

**Review gates**

- No new feature may use `runtimeSessionId` as its external continuity key.
- All migrations must preserve existing successful session lookup behavior during the transition.
- Session/trace/auth tests must verify both canonical-path behavior and legacy fallback behavior until removal is complete.
- Voice and messaging parity work should build on the canonical-session contract, not create channel-specific exceptions.

---

## Review Gates

Before each phase lands:

1. Add or update parity tests for the affected channel family.
2. Preserve existing successful user-visible behavior.
3. Keep Studio debug as the only banner surface for configuration failures.
4. Avoid introducing overlapping trace/error taxonomies unless they are explicitly mapped.
