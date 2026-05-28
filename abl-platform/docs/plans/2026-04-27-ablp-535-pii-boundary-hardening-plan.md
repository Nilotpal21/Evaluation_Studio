# ABLP-535 PII Boundary Hardening Implementation Plan

**Status**: Complete for forward-looking ABLP-535 behavior; committed hardening slices cover live/history parity, exact reveal authorization, Studio/runtime PII setting safeguards, the durable reveal vault, the audited Runtime reveal endpoint, and the Studio audited reveal workflow. Legacy historical backfill is intentionally out of scope by product decision.
**Date**: 2026-04-27
**Owner**: Platform Runtime / Compliance
**Related**: `docs/features/pii-detection.md`, `docs/plans/2026-03-08-pii-phase2-plan.md`, `docs/plans/2026-03-09-pii-enhancements-design.md`

## 1. Goal

Make PII behavior consistent across live chat, session reload, history APIs, traces, channel delivery, tool/API payloads, and explicit admin reveal.

The bug class behind ABLP-535 is not "Studio rendered the wrong thing." It is that different consumers were reading different representations of the same session:

- live chat read the guarded/rendered response;
- session reload read stored messages and traces;
- historical routes did not consistently apply the same PII policy at the response boundary.

The target contract is:

1. PII settings decide which configurable PII patterns are detected and how they render.
2. Baseline secret scrubbing is always on and not configurable.
3. Live and historical views use the same effective rendering policy.
4. Raw PII is revealable only through a dedicated, permissioned, audited admin reveal path.
5. Traces, logs, and normal session APIs are never reveal paths.
6. No rollout flag. The completed implementation is the platform invariant.

## 1.1 Implemented Scope To Date

This implementation commit completes the immediate ABLP-535 leak fix and the authorization/configuration foundation:

- Runtime session detail, message pagination, trace list, and span-child read boundaries scrub PII/secrets before returning historical data.
- `pii:reveal` exists as an exact sensitive permission that is not implied by project `admin`, `*:*`, tenant/workspace `project:*`, project ownership, or API keys without explicit project scope.
- `admin` and `system` are recognized PII consumers and default to redacted rendering.
- Studio can reference `pii:reveal` with the same exact-sensitive semantics as Runtime.
- Studio PII settings now distinguish always-on baseline secret scrubbing from configurable PII patterns.
- Built-in PII patterns are documented as configurable, not hard-coded always-on.
- Studio warns before disabling high-risk `ssn` and `credit_card` patterns.
- Studio and Runtime API boundaries normalize `llm: original` to `llm: tokenized`.
- Durable token originals are stored only in `PIITokenVault` with tenant/project/session scoping, encrypted original values, revealability, erasure state, and TTL.
- Runtime exposes explicit audited reveal through `POST /api/projects/:projectId/sessions/:id/pii/reveal`, requiring exact `pii:reveal`, reason, scoped session lookup, selected token/source selectors, and synchronous audit.
- Studio exposes reveal only as an explicit, permission-gated message-scoped modal in session history/observatory views. Revealed values stay in local modal state and are cleared on close or session/message changes.
- Studio uses a dedicated exact `pii:reveal` permission probe and a reveal proxy that performs the same permission check before forwarding to Runtime.
- Message-scoped reveal now expands selected session messages into durable token ids at the Runtime boundary, so Studio does not need normal session APIs to expose token ids or raw values.

No rollout flag or legacy migration remains in scope for ABLP-535. Sessions created before the durable vault/reveal boundary may remain non-revealable and are not backfilled.

## 2. Product And Policy Decisions

| ID  | Decision                                             | Rationale                                                                                                                                                                                                          |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | No rollout flag                                      | User explicitly rejected rollout/audit mode. Implement as a hard invariant once merged.                                                                                                                            |
| D2  | Keep PII settings                                    | Admins must be able to tune detection and rendering instead of being forced into one global policy.                                                                                                                |
| D3  | Separate secrets from PII                            | Credentials, tokens, auth headers, private keys, and secret-looking field names are security secrets and remain scrubbed regardless of PII settings.                                                               |
| D4  | Allow configurable PII patterns to be disabled       | Email, phone, IP, credit card, SSN, and custom patterns can be disabled by project policy. Disabled patterns are not classified as PII by the PII policy.                                                          |
| D5  | Treat high-risk pattern disablement as privileged    | Disabling credit card or SSN should require project admin permission and explicit UI warning, but should still be possible for false-positive-heavy projects.                                                      |
| D6  | Live and history parity                              | If live chat renders a value as redacted/masked/original under the effective policy, session reload must render the same value the same way.                                                                       |
| D7  | LLM original access remains blocked                  | Even if a pattern override sets `llm: original`, runtime normalizes LLM rendering to tokenized or redacted.                                                                                                        |
| D8  | Admin reveal is separate                             | No normal session API accepts `?includeRaw=true`. Reveal requires a new endpoint, permission, reason, and audit entry.                                                                                             |
| D9  | Durable reveal needs a durable encrypted vault       | Session-local `PIIVault` serialization is not enough for post-session admin reveal, especially after terminal cleanup.                                                                                             |
| D10 | Do not backfill legacy sessions                      | User explicitly does not care about legacy sessions for this issue. Records without durable vault provenance are not migrated and should be treated as non-revealable.                                             |
| D11 | `pii:reveal` is not implied by broad admin wildcards | Current project `admin` uses `*:*`, and tenant admins often carry `project:*`. Reveal must use an explicit sensitive-permission guard so broad project administration does not accidentally become raw PII access. |

## 3. Settings Contract

### 3.1 Non-Configurable Baseline Secret Scrubbing

Always scrub from logs, traces, normal API responses, and stored observability payloads:

- `authorization`, `cookie`, API keys, bearer tokens, refresh/access tokens;
- `password`, `passwd`, `secret`, `client_secret`, `private_key`, credential fields;
- platform secret placeholders and known secret prefixes.

This is not controlled by `pii_redaction.enabled` or pattern settings.

### 3.2 Configurable PII Settings

Project settings continue to control PII behavior for configurable patterns:

```text
pii_redaction.enabled
  false: configurable PII patterns are not applied. Baseline secret scrubbing still applies.
  true: enabled project/builtin patterns are applied.

pii_redaction.redact_input
  true: enabled input PII patterns are tokenized/redacted before LLM execution according to the consumer policy.
  false: enabled input PII patterns may pass to the agent/LLM where existing product policy allows, but secrets are still scrubbed from logs/traces.

pii_redaction.redact_output
  true: enabled output PII patterns are rendered for the user according to pattern consumer rules.
  false: user-facing output may show original configurable PII where policy permits, but logs/traces remain protected.

pii_patterns[*].enabled
  false: that pattern is not classified by project PII policy.
  true: that pattern participates in tokenization/rendering.
```

### 3.3 Consumer Rendering Defaults

| Consumer | Default For Enabled PII Patterns                      | Notes                                                      |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| `llm`    | tokenized                                             | Never original. Normalize unsafe overrides.                |
| `user`   | masked or redacted based on pattern config            | Must match live and history.                               |
| `tools`  | controlled by `pii_access` and pattern config         | Default should stay redacted unless explicitly configured. |
| `logs`   | redacted                                              | Not a reveal surface.                                      |
| `admin`  | redacted by default; original only through reveal API | Normal admin screens do not imply reveal.                  |
| `system` | redacted or tokenized                                 | Lifecycle/audit events only.                               |

### 3.4 Role And Permission Contract

Current RBAC state:

- There is no existing `pii:reveal` permission.
- There is no built-in role that explicitly grants raw PII reveal.
- Project `admin` currently has `*:*`.
- Tenant/workspace admins can have broad project authority such as `project:*`.
- Project `developer` currently has `pii-pattern:read` and `pii-pattern:write`, which is configuration authority, not reveal authority.
- Project `tester` and `viewer` currently have `pii-pattern:read`.

Target RBAC state:

| Capability                                  | Permission / Role Behavior                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Read PII settings                           | Existing `pii-pattern:read` and runtime config read permissions.                                                               |
| Edit PII settings                           | Existing `pii-pattern:write` and runtime config write permissions.                                                             |
| Disable high-risk patterns                  | Project admin or explicit compliance/privacy configuration permission, plus Studio warning/confirmation.                       |
| Reveal raw token values                     | New exact sensitive permission `pii:reveal`.                                                                                   |
| Existing project `admin`                    | May configure project PII settings, but must not receive reveal through `*:*` alone.                                           |
| Existing workspace/tenant admin             | May administer workspace/project policy, but must not receive reveal through `project:*` alone.                                |
| Existing developer/tester/viewer roles      | No raw reveal.                                                                                                                 |
| Custom compliance/privacy role              | Can be granted exact `pii:reveal` intentionally.                                                                               |
| Optional future built-in privacy/admin role | If product wants it, add a new explicit project-scoped `privacy_admin` or `compliance_admin`; do not overload project `admin`. |

Implementation requirements:

1. Add `pii:reveal` to `PERMISSION_REGISTRY` / `VALID_CUSTOM_ROLE_PERMISSIONS` so custom roles can be granted it.
2. Mark `pii:reveal` as a sensitive exact permission.
3. Add a helper such as `requireSensitiveProjectPermission(req, res, 'pii:reveal')`.
4. The helper must validate tenant/project access first, then require exact permission membership.
5. The helper must not treat `*:*`, `project:*`, project ownership, or project admin role as sufficient for reveal.
6. Studio permission gating must use the same sensitive permission result as runtime, not a looser local role check.
7. Audit entries must record whether the actor was project member, custom privacy role, tenant admin with exact grant, or emergency owner path if that path is later approved.

If a pre-built role is added, it requires a separate migration/update across:

- `packages/shared-auth/src/rbac/role-permissions.ts`
- database project-member role validation/enums
- Studio project member role picker and copy
- docs for workspace/team management
- tests proving existing `admin` still does not imply reveal

## 4. Data-Flow Matrix

| Flow                            | Source                               | Target                          | Target Behavior                                                                                         |
| ------------------------------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| User input to LLM               | channel/chat request                 | model payload                   | Apply `redact_input`; LLM original blocked for enabled patterns; secrets scrubbed.                      |
| Agent output to live chat       | reasoning executor                   | WebSocket/REST/channel response | Apply `redact_output` and `user` render policy.                                                         |
| Agent output to message history | reasoning executor/message queue     | Mongo message store             | Store the same safe canonical representation needed for later user rendering; never rely on raw traces. |
| Session reload                  | runtime sessions API                 | Studio/API caller               | Re-render using the same effective policy as live chat.                                                 |
| Trace write                     | trace emitter / ClickHouse ingestion | Redis/ClickHouse                | Scrub secrets always; apply enabled PII policy for logs/traces.                                         |
| Trace read                      | sessions traces APIs                 | Studio/API caller               | Scrub again at read boundary as defense in depth.                                                       |
| Tool context injection          | session data values                  | tool/API payload                | Render using tool `pii_access` and pattern rules; audit render when tokenized PII is accessed.          |
| Admin reveal                    | encrypted token vault                | reveal response                 | Require `pii:reveal`, reason, project scope, audit entry, and selected tokens/spans.                    |
| Legacy sessions without vault   | existing messages/traces             | reveal response/UI              | No backfill. Values without durable token provenance are treated as unavailable for reveal.             |

## 5. Implementation Phases

Each phase must be independently reviewable and must not leave normal APIs capable of returning raw PII when the effective project policy would have redacted it.

### Phase 1: Policy Types And Settings Semantics

**Goal**: Make the settings contract explicit in code and tests.

**Tasks**:

1. Extend PII consumer vocabulary to include `admin` and `system`.
2. Add a policy resolver that distinguishes baseline secrets from configurable PII.
3. Make pattern enablement explicit for builtin and custom patterns.
4. Normalize unsafe LLM render overrides away from `original`.
5. Update Studio settings copy and validation for high-risk pattern disablement.

**Likely Files**:

- `packages/compiler/src/platform/security/pii-vault.ts`
- `packages/compiler/src/platform/security/pii-detector.ts`
- `packages/compiler/src/platform/constructs/executors/trace-scrubber.ts`
- `apps/runtime/src/services/pii/pattern-loader.ts`
- `apps/runtime/src/services/pii/pattern-service.ts`
- `apps/runtime/src/routes/project-runtime-config.ts`
- `apps/runtime/src/routes/pii-patterns.ts`
- `packages/database/src/models/pii-pattern.model.ts`
- `packages/database/src/models/pii-audit-log.model.ts`
- `apps/studio/src/components/settings/PIIProtectionTab.tsx`
- `apps/studio/src/components/settings/PIIPatternFormDialog.tsx`

**Exit Criteria**:

- Unit tests prove disabled patterns are not detected by project PII policy.
- Unit tests prove baseline secret scrubbing still runs when PII is disabled.
- Unit tests prove `llm: original` is normalized to tokenized/redacted.
- Studio/runtime validation covers high-risk pattern disablement warnings.
- `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime` succeeds.

### Phase 2: Central Runtime PII Boundary Service

**Goal**: Replace scattered rendering decisions with one service that all runtime surfaces call.

**Tasks**:

1. Add `RuntimePIIBoundaryService` or equivalent under `apps/runtime/src/services/pii/`.
2. Expose methods for:
   - `renderForUserSurface(session, payload)`
   - `renderForTraceWrite(session, payload)`
   - `renderForTraceRead(session, payload)`
   - `renderForTool(session, toolDef, value)`
   - `renderForLLM(session, textOrMessages)`
   - `renderForAdminDefault(session, payload)`
3. Make service accept the effective project policy, pattern configs, recognizer registry, and optional vault.
4. Keep secret scrubber as an unconditional first or last pass depending on payload type.
5. Add structured metadata to indicate whether reveal is available for tokenized values.

**Likely Files**:

- `apps/runtime/src/services/pii/runtime-pii-boundary-service.ts` (new)
- `apps/runtime/src/services/pii/policy-resolver.ts` (new)
- `apps/runtime/src/services/execution/pii-llm-redaction.ts`
- `apps/runtime/src/services/execution/output-pii-filter.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/types.ts`

**Exit Criteria**:

- Runtime code has one primary service for boundary rendering.
- No new route calls `redactPII`, `filterOutputPII`, or `renderForConsumer` directly unless it is inside the boundary service.
- Tests cover all consumers: `llm`, `user`, `tools`, `logs`, `admin`, `system`.

### Phase 3: Runtime Read/Write Boundary Consolidation

**Goal**: Ensure live chat, session reload, message pagination, traces, and channel delivery render from the same policy.

**Tasks**:

1. Route live response rendering through the boundary service.
2. Route message persistence through the boundary service so stored messages are safe canonical values.
3. Route `GET /sessions/:id`, `GET /sessions/:id/messages`, `GET /sessions/:id/traces`, and span children through the boundary service.
4. Route distributed trace buffer and ClickHouse event reads through the same trace-read policy.
5. Verify channel responses for web SDK, REST chat, voice, SMS/WhatsApp/Teams/Slack-style handlers, and agent transfer payloads.
6. Add data-flow tests that compare live response text with historical reload text for the same project policy.

**Likely Files**:

- `apps/runtime/src/routes/sessions.ts`
- `apps/runtime/src/routes/chat.ts`
- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/services/trace-emitter.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/omnichannel/live-session-service.ts`
- `apps/runtime/src/services/omnichannel/recall-service.ts`
- `apps/runtime/src/channels/**`
- `packages/agent-transfer/src/**`

**Exit Criteria**:

- Live and reloaded transcript rendering match for enabled email/card/SSN/custom patterns.
- Disabled patterns remain visible consistently in live and reload.
- Secrets are scrubbed consistently even when PII is disabled.
- Trace APIs never return raw secrets and only return PII according to trace/log policy.

### Phase 4: Durable Encrypted Reveal Vault

**Goal**: Support future admin reveal after a live session without using messages or traces as the source of truth.

**Tasks**:

1. Add a durable encrypted vault model for token originals.
2. Store token metadata:
   - tenantId, projectId, sessionId;
   - tokenId, piiType, patternName;
   - encrypted original value;
   - source surface and message/trace correlation when available;
   - createdAt, expiresAt;
   - revealable boolean and erasure state.
3. Flush session-local `PIIVault` tokens into the durable vault before terminal cleanup when project policy permits reveal.
4. Continue clearing in-memory vault on terminal actions after durable flush.
5. Register encryption fields in the encryption registry.
6. Add TTL and cascade deletion coverage.

**Likely Files**:

- `packages/database/src/models/pii-token-vault.model.ts` (new)
- `packages/database/src/models/index.ts`
- `packages/database/src/cascade/cascade-delete.ts`
- `packages/shared-encryption/src/encryption-registry.ts`
- `apps/runtime/src/services/pii/pii-token-vault-service.ts` (new)
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/session/session-state-repo.ts`
- `apps/runtime/src/services/session/redis-session-store.ts`

**Exit Criteria**:

- Token originals are encrypted at application layer.
- Normal message and trace stores cannot reconstruct raw PII.
- Terminal sessions can reveal only tokens flushed to the durable vault.
- Old sessions without vault entries report `revealAvailable=false`.
- Tenant/project erasure deletes vault records and audit logs.

### Phase 5: Admin Reveal API And Audit

**Goal**: Provide explicit, narrow, auditable admin reveal without changing normal session APIs.

**Tasks**:

1. Add a new route:
   - `POST /api/projects/:projectId/sessions/:sessionId/pii/reveal`
2. Require:
   - project membership/scope validation;
   - exact sensitive permission `pii:reveal`;
   - tenant and project scoped session lookup;
   - request body with `reason`, optional `ticketId`, and selected `tokenIds` or message span references.
3. Return only selected revealed values, not full raw transcripts by default.
4. Emit PII audit logs with consumer `admin`, renderMode `original`, actor metadata, reason, ticket, and token ids.
5. Add Studio UI affordance only where useful, gated by permission.
6. Ensure normal admin/session views remain redacted unless reveal was explicitly invoked.

**Role Association**:

- Current code has no `pii:reveal` permission and no built-in role that explicitly grants it.
- Do not add `pii:reveal` to existing `developer`, `tester`, or `viewer` roles.
- Do not let existing project `admin` get reveal only because it has `*:*`.
- Do not let tenant/workspace admins get reveal only because they have `project:*`.
- Add `pii:reveal` to the permission registry/custom-role allowlist so it can be granted intentionally to a custom compliance/privacy role.
- If product wants a pre-built role, add a new explicit project-scoped `compliance_admin` or `privacy_admin` role rather than silently expanding the existing project admin role.
- Workspace OWNER emergency access, if desired, should be an explicit product decision and still require reason + audit.

**RBAC Implementation Note**:

Do not gate reveal with plain `requireProjectPermission(req, res, 'pii:reveal')` unless RBAC is changed so `*:*` and `project:*` do not imply sensitive reveal permissions. Prefer a dedicated helper, for example `requireSensitiveProjectPermission(req, res, 'pii:reveal')`, that validates project scope first and then requires an exact sensitive grant.

**Likely Files**:

- `apps/runtime/src/routes/session-pii-reveal.ts` (new)
- `apps/runtime/src/routes/sessions.ts` or router registration site
- `apps/runtime/src/middleware/rbac.ts`
- `packages/shared-auth/src/rbac/role-permissions.ts`
- `packages/shared-auth/src/rbac/permission-resolver.ts`
- `apps/runtime/src/services/pii/pii-token-vault-service.ts`
- `apps/runtime/src/services/execution/pii-audit-singleton.ts`
- `packages/database/src/models/pii-audit-log.model.ts`
- `apps/studio/src/**/observability or session detail components`
- `packages/i18n/locales/en/studio.json`

**Exit Criteria**:

- Missing permission returns 403 or route-standard authorization failure.
- Project admin without exact `pii:reveal` cannot reveal.
- Tenant/workspace admin with only `project:*` cannot reveal.
- Custom role with exact `pii:reveal` can reveal only within scoped project access.
- Cross-tenant/project session reveal returns non-leaky 404.
- Missing reason returns 400.
- Non-revealable token returns 404 or `notRevealable` item result without raw data.
- Successful reveal writes audit entry before or atomically with response.
- Normal session APIs still do not return raw reveal values.

### Phase 5b: Studio Configuration And Reveal UX

**Status**: Implemented for configuration copy/guards and message-scoped reveal UX. Trace JSON remains a redacted observability surface; reveal is linked from message/session context rather than embedded in trace payload views.

**Goal**: Keep Studio aligned with the runtime policy so builders understand what settings do, and admins can reveal only through an explicit, audited workflow.

**Configuration UX Tasks**:

1. Update the PII Protection tab to show the distinction between:
   - baseline secret scrubbing, always on and not configurable;
   - configurable PII patterns, enable/disable per project;
   - consumer rendering for enabled patterns.
2. Make builtin pattern enablement visible and editable where policy allows.
3. Add a warning/confirmation path for disabling high-risk patterns such as `credit_card` and `ssn`.
4. Prevent unsafe consumer combinations in the UI:
   - do not allow `llm` to save `original`;
   - hide or read-only `system` unless needed for diagnostics;
   - make `admin` default to redacted unless tied to explicit reveal.
5. Update Runtime Config settings copy so `enabled`, `redact_input`, and `redact_output` are not interpreted as disabling baseline secret scrubbing.
6. Keep Tools editor/detail `pii_access` intact, but add help text that it controls tool/API context rendering only, not admin reveal.

**Reveal UX Tasks**:

1. Add reveal affordance only on session/message surfaces where tokens are revealable.
2. Gate UI display by an explicit permission check for `pii:reveal`.
3. Require a reveal modal with:
   - reason;
   - optional ticket/case ID;
   - selected token/message scope;
   - warning that the reveal is audited.
4. Do not add a global "show raw transcript" toggle.
5. Keep revealed values ephemeral in client state:
   - clear on modal close;
   - clear on session switch;
   - do not write revealed values to Zustand/local storage/URL/search params.
6. Show non-revealable historical values as redacted/masked with a clear "not available for reveal" state.
7. Avoid reveal directly inside trace JSON by default. Trace panels can link to the reveal modal for correlated message tokens, but traces remain a redacted observability surface.

**Likely Studio Files**:

- `apps/studio/src/components/settings/PIIProtectionTab.tsx`
- `apps/studio/src/components/settings/PIIPatternFormDialog.tsx`
- `apps/studio/src/components/settings/RuntimeConfigTab.tsx`
- `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`
- `apps/studio/src/components/agent-detail/ToolsSection.tsx`
- `apps/studio/src/components/ui/JsonViewer.tsx`
- `apps/studio/src/app/api/projects/[id]/pii-patterns/route.ts`
- `apps/studio/src/app/api/projects/[id]/pii-patterns/[patternId]/route.ts`
- `apps/studio/src/app/api/projects/[id]/pii-patterns/test/route.ts`
- `apps/studio/src/app/api/projects/[id]/sessions/[sessionId]/pii/reveal/route.ts` (new proxy if Studio cannot call runtime directly)
- `packages/i18n/locales/en/studio.json`

**Studio Tests**:

- `apps/studio/src/components/settings/__tests__/PIIProtectionTab.test.tsx`
- `apps/studio/src/components/settings/__tests__/PIIPatternFormDialog.test.tsx`
- `apps/studio/src/__tests__/components/tools-editor.test.tsx`
- new reveal UI test for permission gating, reason requirement, ephemeral clear, and non-revealable state
- workflow/E2E test covering pattern disablement and live/history parity from Studio

**Exit Criteria**:

- Studio settings communicate that secret scrubbing is always on.
- Disabled PII patterns are saved, reloaded, and reflected in runtime preview/test APIs.
- UI cannot save `llm: original`.
- Admin reveal button is absent without `pii:reveal`.
- Reveal modal requires reason and selected scope.
- Revealed values disappear on close/session switch and are not persisted client-side.
- Studio tests cover PII configuration and reveal workflows.

### Phase 6: Historical Backfill And Cleanup

**Status**: Intentionally not implemented for ABLP-535 by product decision on 2026-04-27.

**Decision**: The fix is forward-looking. Legacy sessions without durable token-vault provenance are not migrated, destructively scrubbed, or made revealable as part of this issue.

**Resulting Contract**:

- Normal history/session/trace read APIs still apply read-boundary scrubbing.
- Reveal can return raw values only for durable vault tokens created by the new flow.
- Legacy values without matching vault tokens return unavailable/non-revealable states.
- No migration logs, dry-run mode, or backfill script are required for ABLP-535.

**Original Deferred Goal**: Remove existing raw PII from historical stores where there is no token vault provenance.

**Deferred Tasks (Not Required For ABLP-535)**:

1. Add a bounded backfill script/job for:
   - session messages;
   - message raw content and envelopes;
   - session state cold-store payloads where feasible;
   - trace/event stores with raw payloads.
2. Apply current project policy where available.
3. Destructively redact old values when no durable token exists.
4. Mark sessions/messages with `piiScrubbedAt`, `piiRevealAvailable=false`, or equivalent metadata.
5. Produce aggregate-only migration logs: counts by tenant/project/type, no raw samples.

**Likely Files If A Separate Legacy Cleanup Is Reopened**:

- `apps/runtime/src/scripts/backfill-pii-boundaries.ts` (new)
- `packages/database/src/models/session-message.model.ts` or existing message model
- `packages/database/src/models/session-state.model.ts`
- ClickHouse maintenance/migration location if trace data is stored there
- `docs/testing/pii-detection.md`

**Exit Criteria If A Separate Legacy Cleanup Is Reopened**:

- Dry-run mode reports counts only.
- Execute mode redacts known raw PII from legacy messages/traces.
- Backfilled records are not revealable unless matching durable vault tokens exist.
- Script is idempotent.

### Phase 7: Test Matrix And Gates

**Goal**: Catch the exact ABLP-535 failure class and future omissions.

**Required Tests**:

| Test                        | Type             | Coverage                                                                                 |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| Pattern disabled parity     | unit/integration | Disabled email pattern remains visible in live and history, while secrets still scrub.   |
| Pattern enabled parity      | integration/API  | Enabled email/card patterns render the same in live and session reload.                  |
| Message pagination scrub    | API              | `GET /sessions/:id/messages` respects effective policy.                                  |
| Trace read scrub            | API              | `GET /sessions/:id/traces` and children never leak secrets and follow trace policy.      |
| LLM original override guard | unit             | `llm: original` becomes tokenized/redacted.                                              |
| Tool `pii_access` rendering | integration      | Tool context receives the configured view and emits audit event.                         |
| Durable vault encryption    | integration      | Token original is encrypted at rest and decryptable only through service.                |
| Admin reveal happy path     | API              | Permission + reason + token ids returns selected originals and writes audit.             |
| Admin reveal denial         | API              | Missing permission, wrong tenant/project, missing reason, missing token all fail closed. |
| Project admin reveal denial | API/RBAC         | Built-in project admin with only `*:*` cannot reveal without exact `pii:reveal`.         |
| Tenant admin reveal denial  | API/RBAC         | Tenant/workspace admin with only `project:*` cannot reveal without exact `pii:reveal`.   |
| Custom privacy role reveal  | API/RBAC         | Custom role with exact `pii:reveal` can reveal only within scoped project access.        |
| Legacy no-vault reveal      | API/UI           | Existing messages without durable vault tokens return unavailable/non-revealable state.  |

**Build/Test Commands**:

- `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime`
- `pnpm --filter @agent-platform/runtime test -- <focused runtime tests>`
- `pnpm --filter @agent-platform/database test -- <focused database tests>`
- For security-sensitive changes: `./tools/run-semgrep.sh`
- Before full PR: `pnpm build` before `pnpm test`

## 6. Data-Flow Audit Checklist

Before implementation is considered done, trace these fields through every layer:

| Field                     | Definition               | Persistence              | Runtime Use                | API/UI                      |
| ------------------------- | ------------------------ | ------------------------ | -------------------------- | --------------------------- |
| `pii_redaction.enabled`   | project runtime config   | project config store     | policy resolver            | Studio runtime settings     |
| `redact_input`            | project runtime config   | project config store     | LLM input boundary         | Studio runtime settings     |
| `redact_output`           | project runtime config   | project config store     | live/history user boundary | Studio runtime settings     |
| `pattern.enabled`         | PII pattern model        | PII pattern store        | recognizer registry/policy | PII protection tab          |
| `consumerAccess`          | PII pattern model        | PII pattern store        | renderer                   | PII pattern dialog          |
| `pii_access`              | tool IR                  | compiled agent IR        | tool context renderer      | Tools editor/detail         |
| `tokenId`                 | PIIVault / durable vault | token vault/audit logs   | reveal service             | admin reveal UI/API         |
| `revealAvailable`         | durable vault service    | session/message metadata | reveal route               | session detail UI           |
| `canRevealPII`            | auth/permission result   | not persisted            | reveal route guard         | Studio reveal controls      |
| `revealReason`            | reveal request schema    | audit log metadata       | reveal service             | Studio reveal modal         |
| `highRiskPatternDisabled` | pattern settings         | PII pattern store        | policy resolver            | Studio warning/confirmation |

Checklist:

- [x] Normal session and trace read routes apply a Runtime PII boundary before responding.
- [x] Studio PII pattern settings write the same consumer-access shape that Runtime routes normalize.
- [x] Runtime and Studio both prevent `llm: original` from becoming effective policy.
- [x] Studio permission checks match Runtime's exact-sensitive reveal authorization semantics.
- [x] Normal routes remain non-reveal paths; no `includeRaw` style bypass was added.
- [x] Every reveal route schema field is consumed by the route/service or scoped to audit metadata.
- [x] Durable reveal vault fields are read back only by the reveal service.
- [ ] Message, trace, and reveal paths use the same durable policy resolver once reveal exists.
- [x] Studio does not cache revealed values beyond the active reveal modal/session view.

## 7. Resolved Product Decisions And Remaining Follow-Ups

1. Should durable reveal be project-configurable as `adminReveal.enabled`, or always available to users with `pii:reveal` when a token exists? Current implementation uses permission + token availability only; no rollout flag or project reveal toggle was added.
2. What is the default vault retention period per project or tenant?
3. Should high-risk pattern disablement require only project admin permission, or a separate compliance permission?
4. Does admin reveal need two-person approval for enterprise tenants, or is audit + permission sufficient for this iteration?
5. Which Studio surface should host reveal: session detail, observability trace panel, or a dedicated compliance view?
6. Legacy session backfill is explicitly out of scope for ABLP-535. Old sessions without durable vault provenance are non-revealable.

## 8. Definition Of Done

- Live chat and post-session reload have identical rendering for the same effective policy.
- Configurable PII patterns can be turned off without disabling baseline secret scrubbing.
- LLM/log/trace surfaces cannot receive raw secrets and cannot receive raw enabled-pattern PII unless policy explicitly allows the relevant non-LLM consumer.
- Admin reveal exists only as a dedicated permissioned endpoint with reason and audit.
- Durable vault storage is encrypted and participates in retention and erasure.
- Legacy raw records are not migrated for ABLP-535; records without durable vault provenance are treated as unavailable for reveal.
- Focused API, integration, and unit tests cover the failure that triggered ABLP-535.
