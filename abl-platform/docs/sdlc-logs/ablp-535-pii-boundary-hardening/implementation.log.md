# SDLC Log: ABLP-535 PII Boundary Hardening - Implementation Phase

**Feature**: `ablp-535-pii-boundary-hardening`
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-27-ablp-535-pii-boundary-hardening-plan.md`
**Date Started**: 2026-04-27
**Date Completed**: 2026-04-27 for forward-looking ABLP-535 behavior; historical backfill intentionally excluded by product decision

---

## Preflight

- [x] Plan file exists and captures no-rollout, configurable PII settings, live/history parity, reveal, RBAC, Studio, and audit requirements.
- [x] Existing Runtime session route signatures verified before editing.
- [x] Existing RBAC helper signatures verified before adding sensitive permission guard.
- [x] Existing Studio project permission and route-handler signatures verified before adding exact reveal gating.
- [x] Working tree reviewed; unrelated `packages/helix/**` changes are left untouched.

## Product Decision - Legacy Sessions

On 2026-04-27, product explicitly decided that legacy sessions do not need a migration/backfill for ABLP-535. The completed contract is forward-looking:

- New session/history/reveal behavior is hardened.
- Normal historical read APIs still apply read-boundary scrubbing.
- Raw reveal is available only when a durable vault token exists.
- Legacy records without durable token-vault provenance return unavailable/non-revealable reveal results.
- No destructive legacy cleanup script, dry-run report, or backfill job is required for this issue.

## Slice 1 - Historical Read Boundary

**Goal**: Fix the ABLP-535 reported regression where live chat showed redacted content but session reload/history returned raw PII.

**Completed**:

- Added read-boundary scrubbing for Runtime session detail, paginated messages, trace lists, and span children.
- Added focused Runtime tests proving historical session and trace responses do not expose raw email/card values.
- Extended PII audit log consumer vocabulary with `admin` and `system`.

**Exit Evidence**:

- `pnpm build --filter=@agent-platform/database --filter=@agent-platform/runtime` passed.
- `pnpm --filter @agent-platform/database test -- src/__tests__/pii-audit-log.test.ts` passed.
- `pnpm --dir apps/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/sessions/session-routes.test.ts` passed: 90 tests.

## Slice 2 - Exact Sensitive Reveal Permission

**Goal**: Prepare admin reveal safely by ensuring raw PII reveal is never inherited from broad project/workspace admin permissions.

**Completed**:

- Added shared `pii:reveal` exact-sensitive permission helpers.
- Added `pii:reveal` to the custom-role permission registry without adding it to existing built-in roles.
- Added Runtime `requireSensitiveProjectPermission(req, res, 'pii:reveal')`.
- Added Studio permission constant and project permission gating for `pii:reveal`.
- Updated Studio route-handler permission checks so project ownership and `project:*` do not bypass exact-sensitive permissions.

**Exit Evidence**:

- `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio` passed.
- `pnpm --filter @agent-platform/shared-auth test -- src/__tests__/permission-resolver.test.ts` passed: 35 tests.
- `pnpm --filter @agent-platform/shared test -- src/__tests__/rbac/role-permissions.test.ts` passed: 12 tests.
- `pnpm --filter @abl/compiler test -- src/__tests__/security/pii-vault.test.ts` passed: 40 tests.
- `pnpm --filter @agent-platform/runtime test -- src/__tests__/pii/runtime-pii-boundary-service.test.ts src/__tests__/auth/middleware/rbac.test.ts src/__tests__/pii-pattern-preview-modes.test.ts src/__tests__/pii-pattern-routes.test.ts` passed: 63 tests.
- `pnpm --filter @agent-platform/studio test -- src/__tests__/project-permission.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts src/__tests__/api-routes/api-custom-roles.test.ts src/components/settings/__tests__/PIIProtectionTab.test.tsx src/components/settings/__tests__/PIIPatternFormDialog.test.tsx` passed: 72 tests.

## Slice 3 - Studio PII Settings And Runtime Pattern API Hardening

**Goal**: Align Studio configuration with the policy decisions and prevent unsafe LLM render configuration from entering through either Studio or direct Runtime API calls.

**Completed**:

- Updated Studio PII Protection copy to distinguish always-on credential/secret scrubbing from configurable PII pattern detection.
- Updated built-in pattern copy to show built-ins are configurable rather than always active.
- Added Studio high-risk disablement warning for `ssn` and `credit_card`.
- Normalized Studio saves and previews so `llm: original` becomes `llm: tokenized`.
- Added explicit `llm: tokenized` override when a pattern default render mode is `original`.
- Added Runtime API-boundary normalization so direct PII pattern create/update/preview calls cannot persist or preview `llm: original`.
- Updated Runtime Config and Agent Transfer copy to clarify that PII toggles do not disable baseline secret scrubbing and that de-tokenized transfer is reveal-class access.

**Exit Evidence**:

- `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio` passed.
- Runtime PII pattern API tests passed in the focused Runtime test command above.
- Studio PII Protection and PIIPatternFormDialog tests passed in the focused Studio test command above.
- `pnpm --filter @agent-platform/runtime test -- src/__tests__/reported-pii-masking-gaps.test.ts` passed: 6 tests.

## Slice 4 - Durable Encrypted Reveal Vault

**Goal**: Support future audited admin reveal after terminal/live sessions without using normal message, trace, or Redis session state as the raw PII source of truth.

**Completed**:

- Added `PIITokenVault` Mongo model with tenant/project/session scoping, unique token identity, source correlation fields, revealability, erasure fields, 90-day TTL, and encrypted original-value storage via the database encryption plugin.
- Registered the durable token-original encryption path in the shared encryption registry.
- Added cascade deletion for tenant, project, and session erasure so durable token originals are removed with their owning scope.
- Added `PIIVault.listTokens()` as a defensive snapshot API for durable persistence without exposing mutable in-memory vault entries.
- Added Runtime `flushAndClearSessionPIIVault()` and wired terminal reasoning actions to flush revealable tokens before clearing the session-local vault.
- Honored project PII settings by skipping durable reveal persistence when session redaction policy is disabled; disabled patterns still produce no tokens and therefore no durable vault rows.

**Exit Evidence**:

- `pnpm build --filter=@abl/compiler --filter=@agent-platform/database --filter=@agent-platform/runtime` passed.
- `pnpm --filter @abl/compiler test -- src/__tests__/security/pii-vault.test.ts` passed: 41 tests.
- `pnpm --filter @agent-platform/database test -- src/__tests__/pii-token-vault-model.test.ts src/__tests__/mongo-cascade.test.ts src/__tests__/cascade-delete-modules.test.ts src/__tests__/cascade-delete-auth-profile.test.ts` passed: 35 tests.
- `pnpm --filter @agent-platform/runtime test -- src/__tests__/pii/pii-token-vault-service.test.ts` passed: 6 tests.
- `./tools/run-semgrep.sh apps/runtime/src/services/pii/pii-token-vault-service.ts apps/runtime/src/services/execution/reasoning-executor.ts packages/compiler/src/platform/security/pii-vault.ts packages/database/src/models/pii-token-vault.model.ts packages/database/src/cascade/cascade-delete.ts packages/shared-encryption/src/encryption-registry.ts` passed with 0 findings.

## Slice 5 - Admin Reveal API And Audit

**Goal**: Provide explicit, narrow, auditable admin reveal without changing normal session APIs.

**Completed**:

- Added `POST /api/projects/:projectId/sessions/:id/pii/reveal` on the Runtime sessions router.
- Gated reveal with `requireSensitiveProjectPermission(req, res, 'pii:reveal')`, preserving the exact-sensitive contract where project admin, project ownership, `*:*`, and tenant `project:*` are not enough by themselves.
- Added strict request validation requiring `reason` and selected `tokenIds` or `sourceRefs`, with selector count limits and no `includeRaw` style session-wide bypass.
- Added `revealPIITokens()` as the only durable vault read path; it scopes reads by tenant/project/session, reveals only matching token rows, classifies missing/non-revealable/erased/expired token requests without raw data, and supports source-reference selectors for Studio.
- Wrote admin PII audit rows synchronously before returning raw values, with `consumer: admin`, `renderMode: original`, `action: detokenize`, actor metadata, reason, ticket, token id, and source metadata.
- Kept audit metadata free of original raw values; audit failure now fails closed with a 500 and no raw reveal response.
- Avoided `.lean()` on encrypted token-vault reads so `encryptedOriginalValue` passes through the model encryption plugin's post-find decryption path before reveal.

**Exit Evidence**:

- `pnpm build --filter=@agent-platform/runtime` passed.
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/pii/pii-token-vault-service.test.ts src/__tests__/sessions/session-routes.test.ts src/__tests__/reported-channel-attachment-trace-wiring.test.ts` passed: 49 tests.
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/auth/middleware/rbac.test.ts` passed: 34 tests.
- `./tools/run-semgrep.sh apps/runtime/src/services/pii/pii-token-vault-service.ts apps/runtime/src/routes/sessions.ts` passed with 0 findings.

## Slice 5b - Studio Configuration And Reveal UX

**Goal**: Make Studio use the same exact-sensitive reveal contract as Runtime and expose reveal only through an explicit, audited, ephemeral workflow.

**Completed**:

- Added a Studio exact-permission probe at `GET /api/projects/:id/permissions/pii-reveal` using `requireProjectPermission(projectId, user, 'pii:reveal')`.
- Added a Studio reveal proxy at `POST /api/runtime/sessions/:id/pii/reveal?projectId=...` that performs the same permission check before forwarding to Runtime and never inspects reveal values.
- Added `PIIRevealControls` for message-scoped reveal in the Observatory conversation/history tab. The control is hidden without exact reveal permission or without redaction markers.
- Required reason and optional ticket/case ID in the reveal modal, sent only selected message scope, and surfaced unavailable tokens without raw values.
- Kept raw revealed values ephemeral: local component state only, cleared on modal close and on session/message changes, with no Zustand, local storage, or URL persistence.
- Added Runtime message-scope selector expansion so Studio can send `{ sourceMessageId }` while Runtime resolves durable token ids from scoped encrypted message content without exposing token ids through normal session APIs.

**Exit Evidence**:

- `pnpm build --filter=@agent-platform/runtime` passed.
- `pnpm build --filter=@agent-platform/studio` passed.
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/sessions/session-routes.test.ts` passed: 95 tests.
- `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/pii/pii-token-vault-service.test.ts src/__tests__/auth/middleware/rbac.test.ts` passed: 44 tests.
- `pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/api-routes/api-proxy-routes.test.ts src/__tests__/project-permission.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts` passed: 67 tests.
- `pnpm --filter @agent-platform/studio exec vitest run --config vitest.config.ts src/__tests__/components/pii-reveal-controls.test.tsx` passed: 6 tests.
- `./tools/run-semgrep.sh apps/runtime/src/routes/sessions.ts apps/runtime/src/repos/session-repo.ts apps/studio/src/app/api/runtime/sessions/[id]/pii/reveal/route.ts apps/studio/src/app/api/projects/[id]/permissions/pii-reveal/route.ts apps/studio/src/components/session/PIIRevealControls.tsx` passed with 0 findings.

## Audit Notes

### Audit Pass 1

- Finding: Runtime sensitive API-key path allowed an exact `pii:reveal` grant without an explicit project scope.
- Fix: `requireSensitiveProjectPermission` now requires API-key `projectScope` to include the target project for sensitive reveal.
- Lock: Runtime RBAC test now proves API keys with exact reveal but no project scope are denied.

### Audit Pass 2

- Session history/read boundary: covered by `RuntimePIIBoundaryService`, `GET /sessions/:id`, message pagination, trace list, and span child tests.
- Trace read boundary: covered by route tests and read-boundary service tests.
- Exact reveal authorization: covered in shared permission resolver, Runtime RBAC, Studio project-permission, and Studio route-handler tests.
- PII settings: covered in Studio PII Protection/FormDialog tests and Runtime PII pattern route/service tests.
- LLM original guard: covered in compiler vault tests, runtime LLM masking regression tests, PII pattern API normalization tests, and Studio save normalization tests.
- Admin reveal API/UI: implemented in Slice 5 and Slice 5b. Historical backfill is intentionally excluded from ABLP-535 by product decision.

### Audit Pass 3

- Durable vault data flow: tokenized values now flow from session-local `PIIVault` to `PIITokenVault` through a single Runtime service before terminal cleanup; normal messages/traces do not gain a raw-value field.
- Encryption coverage: `encryptedOriginalValue` is registered in the database encryption plugin and the shared encryption registry; source/correlation metadata intentionally excludes raw PII.
- Lifecycle coverage: tenant, project, and session erasure now include `PIITokenVault` alongside PII audit logs.
- Settings coverage: durable reveal persistence is skipped when session PII redaction is disabled, and per-pattern disablement remains upstream in recognizer loading/token creation.
- Reveal coverage boundary: this slice stores revealable values but does not expose them; Phase 5 must read vault rows only through a new exact `pii:reveal` route with reason and audit.

### Audit Pass 4

- Reveal schema/data flow: every accepted reveal request field is consumed by the route and service; `reason` and `ticketId` go only to audit metadata, while `tokenIds`/`sourceRefs` constrain the vault query.
- Authorization coverage: Runtime route uses exact-sensitive `pii:reveal`; existing RBAC tests still prove project admin and tenant project admin do not inherit reveal without the exact grant.
- Storage boundary: normal session/message/trace APIs still use scrubbed read-boundary helpers and do not read `PIITokenVault`; durable originals are read only by `revealPIITokens()`.
- Encryption coverage: reveal vault reads avoid `.lean()` so encrypted originals are decrypted by the model plugin before audit-gated return.
- Failure coverage: missing reason fails 400 before lookup, cross-project sessions fail with non-leaky 404, non-revealable tokens produce unavailable item results without raw values, and audit failure fails closed before raw return.

### Audit Pass 5

- Studio permission parity: reveal affordance and reveal proxy both use exact `pii:reveal` checks, so Studio does not fall back to project admin, project owner, or workspace admin assumptions.
- Studio state containment: raw reveal values live only in `PIIRevealControls` component state and are cleared on modal close plus session/message changes; no store, URL, or local persistence path was added.
- Message-scope data flow: Studio submits selected message ids; Runtime resolves token ids from scoped message content using tenant/project/session filters and forwards only token/source selectors to `revealPIITokens()`.
- Normal API boundary: no normal Studio or Runtime session route exposes token ids or raw original values; the reveal proxy is the only Studio path that can receive originals.
- Test lock: component, proxy, project-permission, Runtime RBAC, Runtime vault, and Runtime session-route tests cover permission gating, reason requirement, ephemeral clearing, unavailable values, message-scope expansion, and exact-sensitive denial behavior.

### Security Scan

- `./tools/run-semgrep.sh` completed with exit code 0.
- Semgrep reported 14 existing blocking findings outside the ABLP-535 touched files:
  - SearchAI route/send and TLS findings.
  - Monaco public bundle timeout/wildcard postMessage finding.
  - Existing `dangerouslySetInnerHTML` findings in template/web SDK files.
  - Workflow-engine binary response finding.
- OpenSearch TLS verification finding.
- Targeted Semgrep on the Slice 4 changed source files completed with 0 findings.
- Targeted Semgrep on the Slice 5b Runtime/Studio reveal files completed with 0 findings.

## Final Scope Decision

ABLP-535 is complete without Phase 6 historical backfill. A separate legacy cleanup feature may be opened later if product wants to scrub or migrate old sessions, but it is not a prerequisite for closing this issue.
