# LLD: ABLP-619 — Authorize at Creation for OAuth Profiles + Integration Consume-Only Contract

**Feature Spec**: [`docs/features/auth-profiles.md`](../features/auth-profiles.md) (FR-9, FR-10, P8, GAP-7, GAP-8)
**HLD**: [`docs/specs/auth-profiles.hld.md`](../specs/auth-profiles.hld.md)
**Test Spec**: [`docs/testing/auth-profiles.md`](../testing/auth-profiles.md)
**Jira**: ABLP-619
**Status**: DONE (all 5 phases implemented and committed; 5 audit rounds passed during plan review; per-feature acceptance verified 2026-04-28)
**Date**: 2026-04-27
**Date Completed**: 2026-04-28
**Branch**: `ABLP-619-auth-feedback`
**Final commits**: `97be6581a9` (P1A), `f7fcaca88c` (P1B), `302bd296f9` (P2), `cb4701aa8d` (P3), `b8e00443ce` (P4), `23c221c54a` (P5)

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                       | Alternatives Rejected                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | **Two-phase create with new `pending_authorization` status.** POST creates the OAuth profile with `status: 'pending_authorization'`; the OAuth callback (or client-credentials grant success) is the sole writer that flips it to `active`. Failure to authorize leaves the profile in `pending_authorization` for a deliberate retry or explicit delete. | Atomic single-shot create requires running the OAuth flow before a profile ID exists, which would either (a) leak a transient state machine into Redis with no DB anchor, or (b) require restructuring `oauth/initiate` to accept inline config. Two-phase keeps the existing initiate/callback contract untouched and reuses the existing PKCE state in Redis. | (a) Keep `status: 'active'` on create + retroactively validate (today's behavior, the bug). (b) Single-shot atomic create via session-scoped state machine — large refactor of oauth/initiate signature. (c) Reuse `'invalid'` as the pending state — overloads existing semantics for revoked/expired/invalid profiles. |
| D-2 | **Add `pending_authorization` to the `status` enum** in the Mongoose model and the Zod schema. Update redaction, validation, and runtime resolver to treat `pending_authorization` as not resolvable (returns structured `AUTH_PROFILE_NOT_AUTHORIZED` error).                                                                                            | Reuses the existing status field; queries that filter on `status: 'active'` continue to exclude these profiles. Existing rows are unaffected (no migration). All four current values stay valid.                                                                                                                                                                | Adding a separate boolean `authorized: false` doubles the truth source; reusing `'invalid'` conflates user-fixable misconfiguration with the post-authorize-failure state.                                                                                                                                               |
| D-3 | **Workspace OAuth routes are added under `/api/admin/auth-profiles/oauth/{initiate,callback,user-consent}`**, mirroring the project routes structurally but scoped to tenant-only resources (no `projectId` validation, no project permission). The `projectId="_workspace"` sentinel passed to the dialog is removed.                                    | Today the workspace dialog posts to `/api/projects/_workspace/auth-profiles/oauth/initiate`, which fails project-permission and project-not-found validation. The routes must exist as first-class workspace endpoints with admin permission gating.                                                                                                            | Keeping the sentinel + adding a special-case branch in the project handler — leaks workspace concerns into project code, breaks tenant rate limit scoping, and continues to fail isolation lint hooks.                                                                                                                   |
| D-4 | **Client-credentials grant runs inline from the create route**, not from the dialog. The create handler calls `resolveClientCredentialsToken()` after persisting `pending_authorization`, then flips to `active` on success or returns a 400 with a structured error code (`AUTH_PROFILE_AUTHORIZE_FAILED`) and deletes the pending row.                  | Client credentials has no user interaction — it is a single round-trip token exchange. Modeling it as a UI dialog adds latency without value. The token is cached in Redis under the existing `auth-profile:cc-token:{tenantId}:{profileId}` prefix, populated by the same call.                                                                                | Mirror the OAuth dialog path with a fake "Authorize" button that just calls validate — adds UX friction; routing through `oauth/initiate` makes no sense for non-interactive grants.                                                                                                                                     |
| D-5 | **`AuthProfilePicker` and integration-node bind path stay untouched (FR-10 is already satisfied as code).** Add a dedicated regression test asserting `oauth/initiate` is never called from the integration-node config or connection-create flows. Doc the integration consume-only contract in `workflow-integration-node.md` (separate commit).        | The explorer audit confirmed no consumer of `AuthProfilePicker` opens `AuthProfileOAuthDialog` today. FR-10 is therefore a lock-in / regression-prevention concern, not a feature change. A test that fails on regression is the right artifact.                                                                                                                | Adding new code to "prevent" a thing that does not exist creates dead branches. A negative-assertion test is the right tool.                                                                                                                                                                                             |
| D-6 | **No feature flag.** Roll forward in one PR. The change affects only the create path of two auth types; existing profiles are unaffected; rollback is `git revert`.                                                                                                                                                                                       | Behind-flag rollout would force every consumer of the new status to branch on the flag. The blast radius is bounded to Studio create + OAuth callback + status enum; no traffic-shaping benefit.                                                                                                                                                                | Feature flag gating — adds permanent flag debt to a hardening change.                                                                                                                                                                                                                                                    |

### Key Interfaces & Types

```typescript
// packages/database/src/models/auth-profile.model.ts
// EXTEND the existing AUTH_PROFILE_STATUSES const (line 45) — this is the single source of truth:
export const AUTH_PROFILE_STATUSES = [
  'active',
  'expired',
  'revoked',
  'invalid',
  'pending_authorization', // NEW
] as const;
export type AuthProfileStatus = (typeof AUTH_PROFILE_STATUSES)[number];

// packages/shared/src/validation/auth-profile.schema.ts
// CREATE a new exported schema sourced from the model const, used by all status-bearing schemas:
import { AUTH_PROFILE_STATUSES } from '@agent-platform/database/models';
export const AuthProfileStatusSchema = z.enum(AUTH_PROFILE_STATUSES);

// EXISTING UpdateAuthProfileSchema at line 579 currently uses the inline 4-value enum;
// REPLACE with the new shared schema:
//   status: AuthProfileStatusSchema.optional(), // was z.enum(['active','expired','revoked','invalid']).optional()
// This admits 'pending_authorization' on the update path. Internal code paths are the only writers, but
// there is no policy reason to forbid it on the update API — only the create path should default-elevate
// to 'pending_authorization' for OAuth types.

// apps/studio/src/api/auth-profiles.ts
// EXTEND the client-side AuthProfileStatus type at line 34:
export type AuthProfileStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'invalid'
  | 'pending_authorization';

// packages/shared-auth-profile/src/errors.ts
// ADD two new error codes to AuthProfileErrorCode and to the HTTP-status map:
//   AUTH_PROFILE_NOT_AUTHORIZED   → 403 → "Auth profile has not completed authorization"
//   AUTH_PROFILE_AUTHORIZE_FAILED → 400 → "Auth profile authorization failed"

// packages/shared/src/services/auth-profile/trace-events.ts
// EXTEND AUTH_PROFILE_TRACE_EVENTS with two new event names:
//   AUTHORIZED:        'auth_profile.authorized'
//   AUTHORIZE_FAILED:  'auth_profile.authorize_failed'

// apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx
// EXTEND props to support post-create dismissal flow without changing the existing API:
interface AuthProfileOAuthDialogProps {
  open: boolean;
  projectId: string | null; // null => workspace scope (was: '_workspace' string sentinel)
  authProfileId: string;
  connectorName: string;
  displayName?: string;
  connectionConfigFields?: string[];
  onSuccess: (tokenProfileId: string) => void;
  onClose: () => void;
  onCancelDeletePending?: boolean; // NEW: when set, calling onClose without success deletes the pending profile
}

// apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx
// handleSave for oauth2_app: POST returns 201 with status='pending_authorization';
// the slide-over then opens AuthProfileOAuthDialog with the new profile id;
// onSuccess closes both, onClose with onCancelDeletePending=true deletes the pending row.
```

### Module Boundaries

| Module                                                                                        | Responsibility                                                                                                               | Depends On                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/database/src/models/auth-profile.model.ts`                                          | Adds `'pending_authorization'` to the status enum                                                                            | none                                                   |
| `packages/shared/src/validation/auth-profile.schema.ts`                                       | Validates new status enum, exposes `AuthProfileStatusSchema`                                                                 | model                                                  |
| `packages/shared-auth-profile/src/errors.ts`                                                  | Adds `AUTH_PROFILE_NOT_AUTHORIZED` and `AUTH_PROFILE_AUTHORIZE_FAILED` error codes with HTTP mapping                         | none                                                   |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                                | Project-scoped create: writes `pending_authorization` for `oauth2_app`; runs client-credentials grant inline for cc profiles | shared schema, client-credentials-service, error codes |
| `apps/studio/src/app/api/auth-profiles/route.ts`                                              | Workspace-scoped create: same logic, scope-only differences                                                                  | shared schema, client-credentials-service, error codes |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`                 | After token persist: flips parent profile `status` from `pending_authorization` to `active`                                  | model                                                  |
| `apps/studio/src/app/api/admin/auth-profiles/oauth/{initiate,callback,user-consent}/route.ts` | NEW. Workspace-scoped OAuth flow handlers                                                                                    | model, redis-client, shared encryption                 |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`                           | Inline Authorize CTA on create for `oauth2_app`; result-aware close                                                          | OAuth dialog, API client                               |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`                         | Accepts `projectId: string \| null` (drops `_workspace` sentinel); deletes pending profile on cancel when flagged            | API client                                             |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` and friends                     | Treats `status === 'pending_authorization'` as not resolvable; throws `AUTH_PROFILE_NOT_AUTHORIZED`                          | error codes                                            |
| `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts`                            | NEW. Regression test asserting integration-node bind never calls `oauth/initiate`                                            | studio test harness                                    |

---

## 2. File-Level Change Map

### New Files

| File                                                                          | Purpose                                                                        | LOC Estimate |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| `apps/studio/src/app/api/admin/auth-profiles/oauth/initiate/route.ts`         | Workspace OAuth initiate; mirrors project initiate sans projectId              | ~150         |
| `apps/studio/src/app/api/admin/auth-profiles/oauth/callback/route.ts`         | Workspace OAuth callback; flips profile status to `active`                     | ~180         |
| `apps/studio/src/app/api/admin/auth-profiles/oauth/user-consent/route.ts`     | Workspace OAuth per-user consent capture                                       | ~80          |
| `apps/studio/e2e/auth-profiles/authorize-at-creation.e2e.ts`                  | E2E for FR-9: oauth2_app and oauth2_client_credentials at both scopes          | ~250         |
| `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts`            | E2E for FR-10: bind workflow integration node, assert no `oauth/initiate` call | ~120         |
| `apps/studio/src/__tests__/auth-profile-pending-authorization-status.test.ts` | Unit: status enum coverage + redaction + Zod                                   | ~80          |
| `apps/runtime/src/__tests__/auth/auth-profile-pending-authorization.test.ts`  | Unit: runtime resolver returns `AUTH_PROFILE_NOT_AUTHORIZED`                   | ~60          |

### Modified Files

| File                                                                                                                                           | Change Description                                                                                                                                                                                                               | Risk   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/auth-profile.model.ts`                                                                                           | Add `pending_authorization` to status enum                                                                                                                                                                                       | LOW    |
| `packages/shared/src/validation/auth-profile.schema.ts`                                                                                        | Add `pending_authorization` to `AuthProfileStatusSchema`                                                                                                                                                                         | LOW    |
| `packages/shared-auth-profile/src/errors.ts`                                                                                                   | Add `AUTH_PROFILE_NOT_AUTHORIZED` (403) and `AUTH_PROFILE_AUTHORIZE_FAILED` (400) codes                                                                                                                                          | LOW    |
| `packages/shared/src/services/auth-profile/redact.ts`                                                                                          | Status enum extension is transparent to redaction but add coverage in test                                                                                                                                                       | LOW    |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                                                                                 | Conditionally set `status: 'pending_authorization'` for `oauth2_app`; for `oauth2_client_credentials`, call `resolveClientCredentialsToken` and only flip to `active` on success; on failure return 400 + delete the pending row | MEDIUM |
| `apps/studio/src/app/api/auth-profiles/route.ts`                                                                                               | Same logic as project create route, workspace-scoped                                                                                                                                                                             | MEDIUM |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`                                                                  | After successful token persist, update parent profile `status: pending_authorization → active`                                                                                                                                   | MEDIUM |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`                                                                          | Accept `projectId: string \| null`; route to admin OAuth endpoints when null; support `onCancelDeletePending` prop                                                                                                               | MEDIUM |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`                                                                            | After create POST returns 201 with `pending_authorization`, immediately open OAuth dialog inline; on cancel without success, delete the pending profile                                                                          | HIGH   |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`                                                                                | Drop `projectId="_workspace"` sentinel pass-through (no-op for project page); render status badge for `pending_authorization`                                                                                                    | LOW    |
| `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx`                                                                       | Pass `projectId={null}` to dialog (not `"_workspace"`)                                                                                                                                                                           | LOW    |
| `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`                                                                          | Render `pending_authorization` with a distinct visual state                                                                                                                                                                      | LOW    |
| `apps/studio/src/api/auth-profiles.ts`                                                                                                         | Add typed clients for workspace OAuth endpoints; remove `_workspace` URL templating                                                                                                                                              | LOW    |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                                                                                  | Reject `pending_authorization` profiles with `AUTH_PROFILE_NOT_AUTHORIZED`                                                                                                                                                       | MEDIUM |
| `apps/runtime/src/services/auth-profile-resolver.ts`                                                                                           | Same — runtime resolver layer                                                                                                                                                                                                    | MEDIUM |
| `packages/shared/src/services/auth-profile.service.ts`                                                                                         | Same — service-layer resolve                                                                                                                                                                                                     | MEDIUM |
| `packages/connectors/src/services/auth-profile-resolver-factory.ts`                                                                            | Same — connector resolver                                                                                                                                                                                                        | LOW    |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`                                                                               | Authorize CTA label/icon mapping for the two OAuth types                                                                                                                                                                         | LOW    |
| `docs/testing/auth-profiles.md`                                                                                                                | Add E2E rows for FR-9 and FR-10; add coverage matrix entries; add Production Wiring Verification section                                                                                                                         | LOW    |
| `apps/studio/agents.md`, `apps/runtime/agents.md`, `packages/database/agents.md`, `packages/shared/agents.md`, `packages/connectors/agents.md` | Append learnings (status enum extension, two-phase create, workspace OAuth routes, integration-bind contract)                                                                                                                    | LOW    |

### Deleted Files

None.

---

## 3. Implementation Phases

> Each phase is independently deployable and testable. No phase leaves the system in a broken state.

### Phase 1: Status Enum + Resolver Plumbing (Data Layer)

**Goal:** Extend the `status` enum to `'pending_authorization'` and teach every resolver to treat it as not-yet-usable. No UX changes yet; no profile is ever written with this status by Phase 1's code.

**Tasks:**

1.1. Add `'pending_authorization'` to the `AUTH_PROFILE_STATUSES` const in `packages/database/src/models/auth-profile.model.ts:45` (the existing `as const` tuple is the single source of truth). Verify with `pnpm build --filter=@agent-platform/database`.

1.2. Validation schema work in `packages/shared/src/validation/auth-profile.schema.ts`:

- Add `import { AUTH_PROFILE_STATUSES } from '@agent-platform/database/models'`.
- Add new export: `export const AuthProfileStatusSchema = z.enum(AUTH_PROFILE_STATUSES)`.
- Replace the inline 4-value enum at line 579 (`UpdateAuthProfileSchema.status`) with `AuthProfileStatusSchema.optional()` — the update API admits all 5 values; only the create path branches on auth type to default-elevate to `pending_authorization`.

  1.3. Add error codes to `packages/shared-auth-profile/src/errors.ts`:

- `AUTH_PROFILE_NOT_AUTHORIZED` → HTTP 403 → message `"Auth profile has not completed authorization"`
- `AUTH_PROFILE_AUTHORIZE_FAILED` → HTTP 400 → message `"Auth profile authorization failed"`
- Update the `AuthProfileErrorCode` union and the HTTP-status map (`ERROR_CODE_HTTP_STATUS` or equivalent) in the same file.

  1.4. Trace events in `packages/shared/src/services/auth-profile/trace-events.ts`:

- Add `AUTHORIZED: 'auth_profile.authorized'` and `AUTHORIZE_FAILED: 'auth_profile.authorize_failed'` to `AUTH_PROFILE_TRACE_EVENTS`.
- Add typed payload shapes if the file uses a discriminated event union.

  1.5. Resolver guards — IMPORTANT: the runtime resolvers already filter `status: 'active'` at the **query level**, so `pending_authorization` profiles are silently invisible there. The fix is per-file:

- `apps/runtime/src/services/auth-profile-resolver.ts:88-93` — already filters `status: 'active'` in `findOne()`; `buildActiveProfileFilter()` at line 179-183 also filters. **No change needed.** Document this in the LLD log.
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — relies on the resolver above. **No change needed.**
- `packages/connectors/src/services/auth-profile-resolver-factory.ts:83-84` — loads without status filter then checks `if (profile.status !== 'active')` and throws `Auth profile is ${status} - reactivate it before testing`. The error message is misleading for `pending_authorization` ("reactivate" implies revoked/expired). Update: branch on `status === 'pending_authorization'` first and throw `new AuthProfileError('AUTH_PROFILE_NOT_AUTHORIZED', 'This profile has not completed authorization. Open the profile and click Authorize to complete setup.', 403)`. Add `import { AuthProfileError } from '@agent-platform/shared-auth-profile/errors'` (currently absent — connector factory uses plain `Error` today). The `AuthProfileError` constructor signature is `(code: AuthProfileErrorCode, message: string, statusCode = 400)`; the third arg is the HTTP status, not a metadata bag — pass `403` to match the new code's HTTP mapping. If `profileId` context is needed, include it in the message string.
- `packages/shared/src/services/auth-profile.service.ts` — verify whether the resolve method filters `status` at query time. If yes, no change. If no, add the explicit `pending_authorization` branch before the generic non-active rejection. Decide during implementation by reading the actual resolve methods; document the chosen path in the impl commit.

  1.6. Update lookup helpers in `apps/studio/src/app/api/auth-profiles/_auth-profile-route-utils.ts`:

- **`ensureUsableOAuthAppProfile`** (line ~160): today rejects all non-active profiles. Change the predicate to accept `status === 'active' || status === 'pending_authorization'`. Reason: the OAuth `initiate` route is the only legitimate caller, and it must work on a profile that is mid-creation (Phase 4 flow).
- **`buildProjectOAuthAppLookupFilter`** (line ~203): replace `status: 'active'` with `status: { $in: ['active', 'pending_authorization'] }` so the callback can find the parent profile during the two-phase create.
- **Reuse existing `buildTenantOAuthAppLookupFilter`** at `_auth-profile-route-utils.ts:226` for workspace OAuth callback lookups. Widen its `status: 'active'` filter to `status: { $in: ['active', 'pending_authorization'] }` (same treatment as `buildProjectOAuthAppLookupFilter`). Do NOT create a new helper — the existing one already has the correct tenant-only / `projectId: null` semantics.

  1.7. Add unit tests:

- `packages/shared/src/__tests__/auth-profile/pending-authorization.test.ts` — `AuthProfileStatusSchema` round-trips all 5 values; new error codes map to correct HTTP statuses; trace events expose `AUTHORIZED` / `AUTHORIZE_FAILED`.
- `apps/runtime/src/__tests__/auth/auth-profile-pending-authorization.test.ts` — runtime resolver throws `AUTH_PROFILE_NOT_AUTHORIZED` (403) for `pending_authorization`; throws generic for `expired/revoked/invalid`.
- `apps/studio/src/__tests__/auth-profile-route-utils-pending-status.test.ts` — `ensureUsableOAuthAppProfile` accepts pending; `buildProjectOAuthAppLookupFilter` includes both statuses in `$in`; `buildTenantOAuthAppLookupFilter` omits `projectId`.

  1.8. Run `pnpm build && pnpm test --filter=@agent-platform/database --filter=@agent-platform/shared --filter=@agent-platform/connectors --filter=runtime --filter=studio`.

**Files Touched:**

- `packages/database/src/models/auth-profile.model.ts` — extend `AUTH_PROFILE_STATUSES`
- `packages/shared/src/validation/auth-profile.schema.ts` — new `AuthProfileStatusSchema` export; update `UpdateAuthProfileSchema.status`
- `packages/shared-auth-profile/src/errors.ts` — 2 new error codes + HTTP status map
- `packages/shared/src/services/auth-profile/trace-events.ts` — 2 new event names
- `packages/shared/src/services/auth-profile.service.ts` — resolver guard (AUTH_PROFILE_NOT_AUTHORIZED branch)
- `apps/runtime/src/services/auth-profile-resolver.ts` — verified no change needed (already query-filters `status: 'active'` at line 88-93 and via `buildActiveProfileFilter()` at line 179-183)
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — verified no change needed (relies on resolver above)
- `packages/connectors/src/services/auth-profile-resolver-factory.ts:83` — resolver guard + new `AuthProfileError` import
- `apps/studio/src/app/api/auth-profiles/_auth-profile-route-utils.ts` — relax `ensureUsableOAuthAppProfile`; widen `buildProjectOAuthAppLookupFilter` AND existing `buildTenantOAuthAppLookupFilter:226` to `$in: ['active', 'pending_authorization']`
- `apps/studio/src/api/auth-profiles.ts` — extend `AuthProfileStatus` type to 5 values
- new: `packages/shared/src/__tests__/auth-profile/pending-authorization.test.ts`
- new: `apps/runtime/src/__tests__/auth/auth-profile-pending-authorization.test.ts`
- new: `apps/studio/src/__tests__/auth-profile-route-utils-pending-status.test.ts`

**Exit Criteria:**

- [ ] `pnpm build` succeeds across the monorepo with 0 errors.
- [ ] New unit tests in `packages/shared` and `apps/runtime` pass; total of ≥4 new test cases covering enum-parse, error-code mapping, runtime-resolver throw, service-resolver throw.
- [ ] `pnpm test --filter=@agent-platform/database` reports 0 regressions vs `develop`.
- [ ] No production code path writes `status: 'pending_authorization'` yet (verified by grep — only the new test fixtures should mention it).
- [ ] Phase 1 lands as **at least two commits** to honor the 3-package-per-commit guard:
  - Commit A: `packages/database` + `packages/shared` + `packages/shared-auth-profile` (status enum, schema, error codes, trace events).
  - Commit B: `apps/runtime` + `packages/connectors` + `apps/studio` (resolver guard, route-utils widening, client-side type, tests).

**Test Strategy:**

- Unit: enum parsing, error-code HTTP mapping, resolver dispatch on the new status.
- Integration: none (data-layer only; no route changes).

**Rollback:** `git revert` — feature flag not required because no code path emits the new status yet.

---

### Phase 2: Workspace OAuth Routes (API Surface)

**Goal:** Stand up first-class workspace OAuth endpoints so the workspace dialog can stop relying on the `projectId="_workspace"` sentinel.

**Tasks:**

2.1. Create `apps/studio/src/app/api/admin/auth-profiles/oauth/initiate/route.ts` modeled on `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts:50` but with:

- `requireProject: false`, scope: `'tenant'`
- Drop `params.id` validation; use `tenantId` only when constructing the Redis state key (`auth-profile:oauth-state:${tenantId}:${state}`).
- State payload omits `projectId`; callback validates absence, not presence.
- **Permission**: `StudioPermission.AUTH_PROFILE_WRITE` — same permission used by the existing workspace CRUD route at `apps/studio/src/app/api/auth-profiles/route.ts:203`. No new permission added; consistency with the existing pattern (see resolved Open Question 2 below).
- **Rate limit**: `{ limit: 20, windowMs: 60_000, scope: 'user' }` matching the existing project initiate route at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts:55`.
  2.2. Create `apps/studio/src/app/api/admin/auth-profiles/oauth/callback/route.ts` modeled on the project callback. Differences:
- Profile lookup filter uses the existing `buildTenantOAuthAppLookupFilter` (Phase 1.6 widens it).
- On token persist success, flip parent profile `status: 'pending_authorization' → 'active'` via `findOneAndUpdate({_id, tenantId, status: 'pending_authorization'}, {$set: {status: 'active'}})`.
- **Rate limit**: `{ limit: 10, windowMs: 60_000, scope: 'user' }` matching the existing project callback rate limit.
- Emit `AUTH_PROFILE_TRACE_EVENTS.AUTHORIZED` trace event on successful flip.
- On callback failure (token exchange error, state validation failure, provider error): increment the `auth_profile_authorize_failed_total` metric (label: `authType=oauth2_app`) and emit `AUTH_PROFILE_TRACE_EVENTS.AUTHORIZE_FAILED`. The pending profile is left in place for retry — the user can re-trigger Authorize from the list view.
  2.3. Create `apps/studio/src/app/api/admin/auth-profiles/oauth/user-consent/route.ts` mirroring the project user-consent route, tenant-scoped only.
  2.4. Update `apps/studio/src/api/auth-profiles.ts` to add typed clients: `initiateWorkspaceOAuth`, `completeWorkspaceOAuthCallback`, `recordWorkspaceUserConsent`. Internal URL templating: `/api/admin/auth-profiles/oauth/${endpoint}`.
  2.5. Update the project-scope callback at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts:133` to also flip status from `pending_authorization → active` on success (so Phase 4's project-scope flow works once we land it).
  2.6. Add unit tests:
- `apps/studio/src/__tests__/auth-profile-oauth-initiate-route.test.ts` — extend with workspace scope cases
- `apps/studio/src/__tests__/auth-profile-oauth-callback-route.test.ts` — assert status flips to `active` only when previous status was `pending_authorization`
- new: `apps/studio/src/__tests__/auth-profile-workspace-oauth-routes.test.ts`

**Files Touched:**

- new: `apps/studio/src/app/api/admin/auth-profiles/oauth/initiate/route.ts`
- new: `apps/studio/src/app/api/admin/auth-profiles/oauth/callback/route.ts`
- new: `apps/studio/src/app/api/admin/auth-profiles/oauth/user-consent/route.ts`
- `apps/studio/src/api/auth-profiles.ts` — typed clients
- `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` — status flip
- new: `apps/studio/src/__tests__/auth-profile-workspace-oauth-routes.test.ts`
- existing test extensions

**Exit Criteria:**

- [ ] `curl -X POST /api/admin/auth-profiles/oauth/initiate` (with workspace permission token) returns 200 + auth URL.
- [ ] Workspace callback test: profile in `pending_authorization` → callback succeeds → profile is `active` and an `EndUserOAuthToken` row exists.
- [ ] Project callback test: profile in `pending_authorization` → callback succeeds → profile is `active`. Profile in `active` → callback succeeds → profile remains `active` (no double-write race).
- [ ] All existing OAuth route tests pass (no regressions).

**Test Strategy:**

- Unit: route handler input/output, state validation, status-flip predicate.
- Integration: none new (Phase 4 will add E2E once UI lands).

**Rollback:** delete the three new route files and revert the project callback change. No data shape change — safe.

---

### Phase 3: Inline Authorize for `oauth2_client_credentials` (Backend-only path)

**Goal:** Make the create routes for `oauth2_client_credentials` perform the grant inline before returning 201. Extract the persist-grant-flip logic into a testable pure function (Next.js route handlers cannot be tested via DI alone — see F-5).

**Tasks:**

3.0. **Extract testable function** before modifying the routes. Create `apps/studio/src/app/api/auth-profiles/_create-cc-flow.ts`:

```typescript
// Pure function — takes injectable deps, returns either the activated profile or a structured error.
export interface CreateCCFlowDeps {
  resolveClientCredentialsToken: typeof resolveClientCredentialsToken;
  AuthProfile: typeof AuthProfileModel;
  redis: RedisLike;
  emitTrace: (event: string, payload: object) => void;
  now: () => Date;
}
export type CreateCCFlowResult =
  | { ok: true; profile: IAuthProfile }
  | { ok: false; code: 'AUTH_PROFILE_AUTHORIZE_FAILED'; sanitizedMessage: string };
export async function executeClientCredentialsCreateFlow(
  input: CreateCCFlowInput,
  deps: CreateCCFlowDeps,
): Promise<CreateCCFlowResult>;
```

The route handler becomes a thin wrapper that imports default deps and calls this function. Tests call the function directly with stub deps — no `vi.mock` of platform modules.

> **Workspace create route note:** `apps/studio/src/app/api/admin/auth-profiles/route.ts` is a one-line re-export of `apps/studio/src/app/api/auth-profiles/route.ts` (`export { GET, POST } from '@/app/api/auth-profiles/route'`). The workspace create-route changes in Phase 3 and Phase 4 modify the source file, not the re-export. The admin path automatically gets the new behavior.

3.1. In `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts:280` (the POST create handler), branch on `body.authType === 'oauth2_client_credentials'`:

- Persist with `status: 'pending_authorization'`.
- Call `resolveClientCredentialsToken(profile._id, tenantId, body.config.tokenUrl, body.secrets.clientId, body.secrets.clientSecret, body.config.scopes ?? [], deps)` from `packages/shared/src/services/auth-profile/client-credentials-service.ts`.
- On success: `findOneAndUpdate({_id, tenantId}, {$set: {status: 'active', lastValidatedAt: new Date()}})`. Return 201 with `status: 'active'`.
- On failure: delete the pending row in the same transaction. Return 400 with `error.code = 'AUTH_PROFILE_AUTHORIZE_FAILED'` and a sanitized message (no tenantId / clientSecret leak). Increment the `auth_profile_authorize_failed_total` metric (label: `authType=oauth2_client_credentials`) and emit `AUTH_PROFILE_TRACE_EVENTS.AUTHORIZE_FAILED` via `emitAuthProfileTraceEvent`.
  3.2. The `apps/studio/src/app/api/auth-profiles/route.ts` source file is the same workspace create handler covered by 3.1's edits. The admin re-export is unchanged.
  3.3. Reuse the existing tenant-scoped session/transaction wrapper to keep the create + grant + status-flip atomic.
  3.4. Sanitize error messages via the existing user-facing sanitizer helper (per CLAUDE.md "User-Facing Runtime Error Sanitization").
  3.5. Tests:
- new: `apps/studio/src/__tests__/auth-profile-create-cc-flow.test.ts` — assert `resolveClientCredentialsToken` is called; on success status is `active`; on failure status remains briefly `pending_authorization` then row is deleted, response is 400 with structured error.
- Integration: extend `apps/runtime/src/__tests__/integration/auth-profile-token-refresh.test.ts` to cover the create-then-resolve happy path through the new flow.

**Files Touched:**

- new: `apps/studio/src/app/api/auth-profiles/_create-cc-flow.ts` — extracted pure function (Phase 3.0); imports `resolveClientCredentialsToken` from shared and accepts injectable deps
- `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` — invoke extracted flow on `oauth2_client_credentials`
- `apps/studio/src/app/api/auth-profiles/route.ts` — invoke extracted flow on `oauth2_client_credentials`
- new: `apps/studio/src/__tests__/auth-profile-create-cc-flow.test.ts`
- existing integration test extension

**Exit Criteria:**

- [ ] Create `oauth2_client_credentials` profile via API with valid creds → 201, status `active`, Redis cache populated.
- [ ] Create with bad creds (e.g., wrong tokenUrl) → 400 with `error.code === 'AUTH_PROFILE_AUTHORIZE_FAILED'`, profile row absent (verified via list endpoint).
- [ ] Workspace and project scopes both pass.
- [ ] User-facing error message contains no tenant ID, profile ID, or secret material (regex sanitizer test).

**Test Strategy:**

- Unit: route handler with mocked `resolveClientCredentialsToken` (DI — function passed via deps to the route module per CLAUDE.md "no vi.mock of platform components").
- Integration: real Redis + real client-credentials-service against a stub OAuth server.

**Rollback:** revert the create-route diffs; the model change in Phase 1 is harmless.

---

### Phase 4: Inline Authorize for `oauth2_app` (UI + Two-Phase Create)

**Goal:** Studio create form for `oauth2_app` profiles runs the OAuth flow inline before the user can leave the create dialog. On cancel without success, the pending row is deleted.

**Tasks:**

4.1. In `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts` and `apps/studio/src/app/api/auth-profiles/route.ts`, branch on `body.authType === 'oauth2_app'`:

- Persist with `status: 'pending_authorization'`. Return 201 immediately (no inline grant — the UI runs it).
  4.2. In `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`:
- The existing `handleSave` (lines 672-802, ~130 lines) discards the create-API return value and calls `onSaved()` unconditionally on success. The create branch (lines 742-772) needs to be split:
  - Capture `result.data.id` from `createAuthProfile`/`createWorkspaceAuthProfile` for the `oauth2_app` case.
  - Suppress the immediate `onSaved()` call for `oauth2_app`; instead set local state to open `AuthProfileOAuthDialog` with the captured `profileId` and `onCancelDeletePending: true`.
  - Defer `setSaving(false)` until the OAuth dialog closes (success or cancel) — otherwise the slide-over UI thinks the operation finished while the user is still authorizing.
  - For all other auth types (including `oauth2_client_credentials`, which completes inline server-side), preserve existing behavior — call `onSaved()` immediately on 201.
- On dialog `onSuccess(tokenProfileId)`: close both, refresh list, profile is `active`.
- On dialog `onClose` without success: call `DELETE /api/(projects/:id|admin)/auth-profiles/:profileId` to clean up the pending row, surface a toast "Authorization cancelled — profile not created."
  4.3. In `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`:
- Change props: `projectId: string | null`. When `null`, route to admin endpoints. Drop the `_workspace` string sentinel.
- Add `onCancelDeletePending?: boolean`. When set and the dialog closes without success, call the appropriate `DELETE` endpoint before invoking `onClose()`.
  4.4. **Sentinel removal — surgical, not signature-changing.** `buildProvidersKey` lives at `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx:55-64` (the file `apps/studio/src/lib/swr-keys.ts` does NOT exist). Its current signature is `buildProvidersKey(scope: 'project' | 'workspace', projectId: string)` and it ignores the second argument when `scope === 'workspace'` (line 59-61: returns `'/api/auth-profiles/providers'`). The `'_workspace'` string is therefore already dead at this call site — no `buildProvidersKey` signature change is needed. Only the `AuthProfileOAuthDialog` prop needs to change:
  - `AuthProfileOAuthDialog.tsx` — change `projectId: string` to `projectId: string | null`. When `null`, route to `/api/admin/auth-profiles/oauth/...`. When non-null, route to `/api/projects/${projectId}/auth-profiles/oauth/...`.
  - `WorkspaceAuthProfilesPage.tsx` — pass `projectId={null}` to the dialog instead of `"_workspace"`.
  - `AuthProfilesPage.tsx` — pass `projectId={projectId}` (already correct for project scope; verify no `_workspace` leakage).
  - `IntegrationAuthTab.tsx` — accepts a `projectId: string` prop today; the workspace path passes `'_workspace'` (line 199, 270 of `WorkspaceAuthProfilesPage.tsx`). The implementor's choice: (a) keep accepting `string` and pick a non-sentinel constant such as `''` (empty string ignored by `buildProvidersKey` for workspace scope), or (b) refactor the prop to `scope: 'project' | 'workspace'` plus optional `projectId`. Either is acceptable as long as `git grep -n "'_workspace'" apps/studio/src/` returns zero matches post-change.
  - Run `git grep -n "'_workspace'" apps/studio/src/` as the verification step.

    4.5. **Status badge + filter dropdowns + client-side type**:

  - `apps/studio/src/api/auth-profiles.ts:34` — extend the client-side `AuthProfileStatus` type to include `'pending_authorization'`.
  - `auth-type-metadata.ts` — extend `AUTH_STATUS_COLORS` (line ~428) with a `pending_authorization` entry. Use the semantic info-tone tokens from `@agent-platform/design-tokens` (e.g., `'bg-info-subtle text-info border-info-muted'`) — confirm exact tokens during implementation by reading the design-tokens package; do not hardcode Tailwind palette colors.
  - `AuthProfileStatusBadge.tsx` — today renders raw `{status}` text with `capitalize`. With `pending_authorization` this produces "Pending*authorization" with a visible underscore. Refactor to read from a status→i18n-key map (or call `t('auth_profiles.status*' + status)` via the existing translation hook) so all 5 statuses render proper labels. This is a small i18n-debt repayment that the new status forces; without it, the i18n key from this LLD is never actually used.
  - i18n: add `auth_profiles.status_pending_authorization = "Awaiting authorization"` in `packages/i18n/locales/en/studio.json`. Also add the four existing status keys (`status_active`, `status_expired`, `status_revoked`, `status_invalid`) if they do not already exist as standalone keys (they are referenced by `WorkspaceAuthProfilesPage.tsx:411-414` via `t('status_active')`, so the dropdown labels exist; verify the badge can use the same keys).
  - Status filter dropdowns in both `AuthProfilesPage.tsx` and `WorkspaceAuthProfilesPage.tsx:410-414` — add the new option so users can filter for pending profiles.
    4.6. Tests:

- new: `apps/studio/src/__tests__/components/auth-profile-slide-over-authorize-flow.test.tsx` — RTL test: type config → submit → OAuth dialog opens → on success, list refreshes; on cancel, DELETE fires.
- new E2E: `apps/studio/e2e/auth-profiles/authorize-at-creation.e2e.ts` — drive the full flow against a stub OAuth provider for both project and workspace scopes.

**Files Touched:**

- `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`
- `apps/studio/src/app/api/auth-profiles/route.ts`
- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`
- `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`
- `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`
- `apps/studio/src/components/auth-profiles/WorkspaceAuthProfilesPage.tsx`
- `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx` — sentinel removal
- `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`
- `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` — extend `AUTH_STATUS_COLORS`
- `apps/studio/src/api/auth-profiles.ts` — `AuthProfileStatus` type extension
- (no `swr-keys.ts` change — `buildProvidersKey` lives in `IntegrationAuthTab.tsx:55-64` and its workspace branch already ignores `projectId`; no signature change needed)
- `packages/i18n/locales/en/studio.json` — `auth_profiles.status_pending_authorization` key (+ peer locales)
- new test files (RTL + E2E)

**Exit Criteria:**

- [ ] Create `oauth2_app` profile in Studio (project scope) → OAuth dialog opens automatically → admin authorizes → profile lands `status: 'active'` with an `EndUserOAuthToken` row.
- [ ] Same flow at workspace scope passes.
- [ ] User cancels OAuth dialog → pending profile row is deleted, list does not show ghost entry.
- [ ] User closes browser before OAuth completes → pending profile remains in `pending_authorization` and is visible with the "Awaiting authorization" badge; user can re-open and click "Authorize" to retry (Phase 4.5 retry CTA).
- [ ] No "Test credentials" button appears on the create form for `oauth2_app` or `oauth2_client_credentials`.
- [ ] E2E test passes against the in-repo stub OAuth provider (or a mocked provider injected via DI per CLAUDE.md).

**Test Strategy:**

- Unit: RTL on the slide-over create-then-authorize flow; mock the `fetch` boundary, not platform components.
- E2E: start real Studio Next.js server with random port, real Mongo + Redis (test containers), real OAuth callback with a stub provider service. No `vi.mock`.

**Rollback:** revert the UI changes only; backend already accepts pending_authorization profiles, so no data is corrupted.

---

### Phase 5: FR-10 Lock-In + Doc Sync

**Goal:** Add the regression test that asserts integration-node bind never triggers OAuth, and sync the test spec / package learnings.

**Tasks:**

5.1. Create `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts`:

- Seed: create an `oauth2_app` profile via Phase 4's flow, assert it's `active`.
- Drive the workflow editor to bind an integration node to that profile via the existing `IntegrationNodeConfig`.
- Assert via network observation (real HTTP listener) that no `POST /auth-profiles/oauth/initiate` is made during bind.
- Trigger workflow execution (smoke); assert the runtime resolves credentials via `oauth-grant-service.ts` (verified through trace events / structured log capture).
  5.2. Update `docs/testing/auth-profiles.md` with two new E2E scenarios (numbered E2E-8 and E2E-9, continuing the existing E2E-1..E2E-7 sequence):

```
### E2E-8: Authorize at Creation (FR-9)

Purpose: Verify the two-phase create flow for both OAuth auth types at both scopes lands the profile in `active` only after the grant succeeds, and that cancel deletes the pending row.

Scenarios (drive a real Studio Next.js server with random port + real Mongo + real Redis + a stub OAuth provider injected via DI):

  Scenario A — oauth2_app, project scope, happy path:
  1. POST /api/projects/:projectId/auth-profiles with authType=oauth2_app, valid config -> 201, status='pending_authorization'.
  2. UI clicks Authorize. POST /api/projects/:projectId/auth-profiles/oauth/initiate -> 200 with auth URL + state.
  3. Redirect to stub provider, stub returns code + state.
  4. POST /api/projects/:projectId/auth-profiles/oauth/callback -> 200; profile status flips to 'active'; EndUserOAuthToken row exists for the real user.

  Scenario B — oauth2_app, workspace scope, happy path:
  Same as A but POST /api/auth-profiles (admin re-export), oauth/initiate hits /api/admin/auth-profiles/oauth/initiate, callback at /api/admin/auth-profiles/oauth/callback.

  Scenario C — oauth2_client_credentials, project scope, happy path:
  1. POST /api/projects/:projectId/auth-profiles with authType=oauth2_client_credentials, valid creds.
  2. Handler runs client_credentials grant against stub token URL inline -> 201 with status='active' AND Redis cache key auth-profile:cc-token:{tenantId}:{profileId} populated.

  Scenario D — oauth2_client_credentials, workspace scope, happy path:
  Same as C via workspace route.

  Scenario E — oauth2_client_credentials, bad creds:
  POST with invalid clientSecret -> 400, error.code='AUTH_PROFILE_AUTHORIZE_FAILED', sanitized message contains no tenantId/profileId/clientSecret/tokenUrl host. Profile row absent (verified via list endpoint).

  Scenario F — oauth2_app, user-cancel:
  POST creates pending profile (201). UI closes the dialog without completing OAuth -> DELETE /api/(projects/:id|admin)/auth-profiles/:profileId -> 200; profile is gone from list.

  Scenario G — oauth2_app, browser-close mid-flow:
  POST creates pending profile. No callback fires. Profile remains in list with status='pending_authorization' badge. User retries via Authorize action -> happy path completes.

### E2E-9: Integration Bind No Consent (FR-10)

Purpose: Assert that binding a workflow integration node to an existing OAuth profile triggers ZERO calls to /auth-profiles/oauth/initiate at bind or run time. Re-consent only on missing/expired token under preflight/jit semantics — never as a side effect of binding.

Setup: Run E2E-8 Scenario A first to produce an active oauth2_app profile.

Steps:
  1. In the workflow editor, add an Integration node and select a Connection that references the active profile.
  2. Save the workflow.
  3. Trigger workflow execution against a stub external service.
  4. Assert via network observation (real HTTP listener counting requests by path) that /auth-profiles/oauth/initiate has zero calls during bind and run.
  5. Assert via runtime trace events that the credential resolved through oauth-grant-service.ts (not via the OAuth dialog code path).
  6. Negative regression: if a developer re-introduces an oauth/initiate call from IntegrationNodeConfig.tsx, this test must fail. Verify by intentionally re-introducing the call locally.
```

- Add a "Production Wiring Verification" subsection listing: new admin OAuth route paths, the pending_authorization status emission points (project + admin create routes), the status-flip points (project + admin OAuth callback handlers), and the AUTHORIZED / AUTHORIZE_FAILED trace event emit sites.
- Add FR-9 and FR-10 rows to the test spec's Coverage Matrix mirroring the entries already added to the feature spec.
  5.3. Append learnings to `agents.md` files for each touched package:
- `apps/studio/agents.md` — two-phase create pattern, workspace OAuth routes path, `_workspace` sentinel removal.
- `apps/runtime/agents.md` — `pending_authorization` resolver semantics.
- `packages/database/agents.md` — status enum extension is additive (no migration).
- `packages/shared/agents.md` — new error codes.
- `packages/connectors/agents.md` — resolver guard for `pending_authorization`.
  5.4. Run `/post-impl-sync auth-profiles` after the implementation lands, in a separate session, to bring the feature spec, test spec, and HLD status fields fully into alignment with the shipped surface.

**Files Touched:**

- new: `apps/studio/e2e/auth-profiles/integration-bind-no-consent.e2e.ts`
- `docs/testing/auth-profiles.md`
- 5 × `agents.md`

**Exit Criteria:**

- [ ] FR-10 regression test passes; intentional regression (re-introducing an `oauth/initiate` call from `IntegrationNodeConfig.tsx`) makes it fail.
- [ ] `docs/testing/auth-profiles.md` has explicit FR-9 and FR-10 rows in the coverage matrix and Production Wiring Verification section listing the new files.
- [ ] All five `agents.md` files have new entries dated 2026-04-27 referencing ABLP-619.
- [ ] `docs/features/auth-profiles.md` GAP-7 and GAP-8 status changed from `Open` to `Resolved`. (May be done by `/post-impl-sync` in task 5.4, but verify before closing the ticket.)
- [ ] `workflow-integration-node.md` and `oauth-tooling.md` have cross-references to FR-10 added (covered by `/post-impl-sync` in task 5.4 or as a follow-up commit).

**Test Strategy:**

- E2E: real Studio + Runtime servers, real Mongo + Redis. Network observation via the test harness's HTTP listener (no mocking of consumed services).

**Rollback:** revert the test addition. Doc updates do not need rollback.

---

## 4. Wiring Checklist

> Every new component must be wired into its callers. This is the #1 agent failure mode.

- [ ] **Workspace OAuth routes** registered in Next.js app router (file-system route exists at `apps/studio/src/app/api/admin/auth-profiles/oauth/{initiate,callback,user-consent}/route.ts`)
- [ ] **Typed API clients** for workspace OAuth added to `apps/studio/src/api/auth-profiles.ts` and consumed by `AuthProfileOAuthDialog`
- [ ] **`pending_authorization` status enum** value referenced from:
  - [ ] Mongoose model definition
  - [ ] Zod schema (`AuthProfileStatusSchema`)
  - [ ] Resolver guards in `auth-profile.service.ts`, `auth-profile-resolver.ts`, `resolve-tool-auth.ts`, `auth-profile-resolver-factory.ts`
  - [ ] Status badge component
  - [ ] Auth-type metadata
- [ ] **Error codes** `AUTH_PROFILE_NOT_AUTHORIZED` and `AUTH_PROFILE_AUTHORIZE_FAILED` exported from `packages/shared-auth-profile/src/errors.ts` and mapped to HTTP statuses
- [ ] **Status flip on callback success** wired in BOTH project and admin OAuth callback handlers
- [ ] **Pending-profile cleanup on cancel** wired through `AuthProfileOAuthDialog.onClose` → DELETE call
- [ ] **`_workspace` sentinel string** removed from `WorkspaceAuthProfilesPage.tsx`, replaced with `projectId={null}`
- [ ] **Studio Permission**: workspace OAuth routes use the existing `StudioPermission.AUTH_PROFILE_WRITE` (no new permission added — see Open Question 2 resolution)
- [ ] **`ensureUsableOAuthAppProfile`** widened to accept `pending_authorization` (`_auth-profile-route-utils.ts`)
- [ ] **`buildProjectOAuthAppLookupFilter`** widened to `status: { $in: ['active', 'pending_authorization'] }`
- [ ] **`buildTenantOAuthAppLookupFilter`** (existing at `_auth-profile-route-utils.ts:226`) widened to `$in: ['active', 'pending_authorization']` and used by the admin OAuth callback route
- [ ] **`UpdateAuthProfileSchema.status`** at `auth-profile.schema.ts:579` switched to `AuthProfileStatusSchema.optional()` (admits the new value)
- [ ] **`AuthProfileStatus` client type** at `apps/studio/src/api/auth-profiles.ts:34` extended to 5 values
- [ ] **`AUTH_STATUS_COLORS`** in `auth-type-metadata.ts` includes `pending_authorization` using design tokens (no hardcoded palette colors)
- [ ] **i18n key** `auth_profiles.status_pending_authorization` added in all locale files that already key on status
- [ ] **`buildProvidersKey`** at `IntegrationAuthTab.tsx:55-64` — workspace branch already ignores projectId, no signature change needed; zero `'_workspace'` string occurrences remain in `apps/studio/src/` (verify with `git grep`)
- [ ] **`AUTH_PROFILE_TRACE_EVENTS`** has `AUTHORIZED` and `AUTHORIZE_FAILED`; emitted at status flip and authorize failure respectively
- [ ] **E2E test files** placed under `apps/studio/e2e/auth-profiles/` (not under `__tests__/e2e/` — matches existing path convention)
- [ ] **`agents.md` updates** in all five touched packages
- [ ] **Audit trail plugin** picks up the status flip on callback (verify by reading existing audit test)

---

## 5. Cross-Phase Concerns

### Database Migrations

**No migration required.** Adding a value to a Mongoose enum is non-breaking; existing documents with the four prior values continue to validate. New value rolls forward only when Phase 4 lands.

### Feature Flags

**None.** Per D-6, this is a hardening change with bounded blast radius. Rollback is `git revert`.

### Configuration Changes

**No new env vars.** Existing `STUDIO_OAUTH_ALLOWED_ORIGINS` and `ENCRYPTION_MASTER_KEY` cover the new workspace routes.

### Permissions

Workspace OAuth routes reuse the existing `StudioPermission.AUTH_PROFILE_WRITE` permission (matching the existing workspace CRUD route at `apps/studio/src/app/api/auth-profiles/route.ts:203`). No new permission is added. See Open Question 2 resolution.

### Audit & Observability

The status flip from `pending_authorization → active` MUST emit:

- An `auth_profile.authorized` trace event via `emitAuthProfileTraceEvent()` (Phase 2 task)
- An audit-trail row via the existing `auditTrailPlugin`

Add a metric increment for `auth_profile_authorize_failed_total` (Phase 3 task) so the AlertEvaluator can monitor stuck-pending rates.

### Test Isolation

E2E tests use random ports (`{ port: 0 }`), real Mongo (test container), real Redis (test container). Stub OAuth provider runs as a separate Express server on a random port and is configured via DI from the test harness — no `vi.mock` of platform components.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with phase exit criteria met
- [ ] FR-9 and FR-10 E2E tests passing in CI
- [ ] No regressions in existing 84 auth-profile/OAuth-focused tests (`pnpm build && pnpm test`)
- [ ] `docs/features/auth-profiles.md` updated by `/post-impl-sync` with status flip from PLANNED→IMPLEMENTED for P8 deliverables; GAP-7 and GAP-8 marked Resolved (GAP-9 stays Open as a deferred follow-up)
- [ ] `docs/testing/auth-profiles.md` coverage matrix shows FR-9 and FR-10 with HIGH coverage; new E2E scenarios E2E-8 (Authorize at creation, project + workspace, both auth types) and E2E-9 (integration bind no consent) added with full scenario steps
- [ ] `docs/specs/auth-profiles.hld.md` updated by `/post-impl-sync` to reflect: (a) `pending_authorization` status value in §5 Data Model, (b) admin OAuth routes in §6 API Design, (c) `AUTHORIZED` / `AUTHORIZE_FAILED` trace events in §3.5 Observability, (d) stuck-pending alert dimension in §3.11 Monitoring
- [ ] No "Test credentials" button visible on the create form for `oauth2_app` or `oauth2_client_credentials` (manual smoke verified at both scopes)
- [ ] Profile created via the Studio create form is never visible with `status: 'active'` and a missing `EndUserOAuthToken` (verified by E2E)
- [ ] Integration-node bind path generates zero OAuth-initiate HTTP traffic (FR-10 regression test passing)
- [ ] All five `agents.md` files have entries documenting the change
- [ ] Pre-commit hooks pass (prettier, typecheck, isolation lint, mock lint, etc.)
- [ ] Commit history follows commit discipline: max 40 files, max 3 packages per commit, additive feat() commits

## 7. Open Questions

1. ~~**Should `pending_authorization` profiles be GC'd automatically?**~~ **RESOLVED** (LLD round 4): logged as GAP-9 (LOW) in `docs/features/auth-profiles.md` §16 — deferred to a follow-up ticket. For ABLP-619 we rely on user-driven cleanup (cancel deletes; browser-close leaves the row visible in the list with the `pending_authorization` badge so the user can retry or delete).
2. ~~**Permission name for workspace OAuth.**~~ **RESOLVED** (LLD round 1): use the existing `StudioPermission.AUTH_PROFILE_WRITE`, matching the existing workspace CRUD route at `apps/studio/src/app/api/auth-profiles/route.ts:203`. No new permission added.
3. **Should the FR-10 regression test live under `apps/studio/e2e/` or `apps/studio/e2e/workflows/`?** The latter has its own `agents.md` with strict conventions; this test is auth-profile-centric, not workflow-centric. Default: `apps/studio/e2e/auth-profiles/`. Re-evaluate during code review.
