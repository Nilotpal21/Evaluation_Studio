# Auth Profile Lifecycle (ABLP-1123)

Single reference for how auth profiles transition between states, what
each lifecycle action does end-to-end, and where the boundary contracts
live. Companion to [`auth-profiles.md`](./auth-profiles.md) which covers
the feature surface; this doc covers the lifecycle invariants.

Status: STABLE for the slice landed under ABLP-1123. Parked extensions
are listed at the bottom.

## 1. State machine

```
        ┌────── create (preconfigured) ────────────────┐
        │                                              ▼
   pending_authorization ── authorize ─▶  active ◀── activate ── revoked
        │                                  │  ▲                    ▲
        │                                  │  │                    │
        │                              expire/                     │
        │                              validate                    │
        │                                  ▼  │                    │
        │                              expired ── re-authorize ────┤
        │                                                          │
        └── delete ────────────────────────────────────────────────┘
                       (also from revoked / pending_authorization)
```

Five statuses (`AuthProfileStatus`): `pending_authorization`, `active`,
`invalid`, `expired`, `revoked`. The runtime resolver accepts only
`active`; everything else short-circuits with a status-specific error.

Two orthogonal flags also gate resolution before secrets are decrypted:

- `enabled: boolean` — admin pause/resume. Distinct from status because
  a profile can be `active` but `enabled: false`.
- `expiresAt: Date | null` — credential expiry. Lazy transition flips
  `active → expired` at point-of-use (no background sweep).

## 2. Lifecycle actions (single-profile)

All three actions share one confirmation UX —
`AuthProfileImpactModal` — which loads the consumer list via
`/api/projects/:p/auth-profiles/:id/consumers` and renders a grouped
preview (top 5 per type + "and N more"). The reversibility banner is
color-coded per action.

| Action  | Status delta           | Token side-effect                                  | Confirm friction                           | Cache invalidation                  |
| ------- | ---------------------- | -------------------------------------------------- | ------------------------------------------ | ----------------------------------- |
| Disable | none — `enabled=false` | none                                               | impact modal only                          | profileVersion bump                 |
| Revoke  | `active → revoked`     | `revokeEndUserTokensForProfile` stamps `revokedAt` | impact modal                               | profileVersion bump + Redis publish |
| Delete  | row removed            | none (delete only allowed on revoked / pending)    | impact modal + type-to-confirm (workspace) | n/a — row gone                      |

`pending_authorization` is the create state for `oauth2_app` (until
the user completes the OAuth code flow) and `oauth2_client_credentials`
(until the platform performs the inline client-credentials grant). It
is also the only "non-revoked" state Delete is allowed on.

## 3. End-to-end wiring

### Disable

1. Toggle on `AuthProfilesPage` row.
2. If enabling → instant PATCH.
3. If disabling → `AuthProfileImpactModal action="disable"` → PATCH
   `{enabled: false}`.
4. `PUT /api/{,projects/:p/}auth-profiles/:id` updates `doc.enabled`.
5. Pre-save hook (`auth-profile.model.ts`) bumps `profileVersion`
   because `isModified('enabled')` is true.
6. Runtime resolver at `auth-profile-resolver-factory.ts` rejects with
   `AUTH_PROFILE_DISABLED` (403).

### Revoke

1. Row kebab → `AuthProfileImpactModal action="revoke"`.
2. Confirm → POST `/auth-profiles/:id/revoke`.
3. Route flips `status = 'revoked'` and `doc.save()` runs the pre-save
   hook → `profileVersion++`.
4. `revokeEndUserTokensForProfile()` stamps `revokedAt` on every
   `EndUserOAuthToken` row for the profile (per-user-token flows).
5. `profile_revoked` audit event emitted (fire-and-forget).
6. `publishAuthProfileInvalidate` fires Redis pub/sub for cross-pod
   cache invalidation (belt-and-suspenders on top of the version bump).

### Delete

1. Row kebab → `AuthProfileImpactModal action="delete"`.
2. Workspace scope adds a name-match type-to-confirm gate.
3. `summarizeDeleteBlockers` queries every consumer collection
   (workflows / agents / channels / mcp tools / webhooks / models …).
4. Internal-only blockers can auto-cascade
   (`cleanupAutoCascadeInternalDependencies`).
5. External (user-visible) blockers hard-reject with a
   `Cannot delete — referenced by …` message naming the consumer
   types and counts.

### Authorize / Re-authorize

1. Slide-over footer-left button. Label flips between `Authorize`
   (pending) and `Re-authorize` (active OAuth).
2. Opens `AuthProfileOAuthDialog` which runs the OAuth code flow.
3. On success, the callback sets `status = 'active'` and
   `lastAuthorizedAt = now()`.

### Test (non-OAuth credentials)

1. Slide-over footer-right button. Hidden for OAuth profiles (Authorize
   IS the credential test) and for `revoked`/`expired` profiles (the
   validate endpoint rejects them outright).
2. Calls `/auth-profiles/:id/validate` which dispatches by auth type:
   provider HTTP call for api_key/bearer, AWS STS for aws_iam, Azure
   AD client-credentials for azure_ad, etc.
3. Result chip rendered inline in the footer.

## 4. Slide-over save contract

The slide-over's `buildSaveConfig` projects `config` state through
`getAllowedConfigKeys(authType)` before sending. The Zod
`*ConfigSchema` for the chosen auth type is the **single source of
truth** for what can ship.

```ts
const allowed = getAllowedConfigKeys(authType);
const projected = Object.fromEntries(Object.entries(config).filter(([k]) => allowed.has(k)));
```

After projection, type-aware composition steps only write keys the
schema accepts:

1. OAuth (`oauth2_app` / `oauth2_token`): inline resolved
   `authorizationUrl` / `tokenUrl` so the saved row holds concrete
   strings, not templates.
2. `oauth2_client_credentials`: resolve `${connectionConfig.x}` inside
   `tokenUrl` against the in-memory connectionConfig template state.
3. Schemas declaring `connectionConfig` (api_key / bearer /
   oauth2_app today): forward the raw template blob.

Adding a new auth type registers automatically. As long as a Zod schema
is added to `AUTH_TYPE_CONFIG_SCHEMAS`, the slide-over needs no
changes to project its payload correctly.

`isDirty` tracks form mutation. Save is disabled until any change
handler flips it true; cleared on open and on successful save.

## 5. Lazy expiry transition

The resolver factory at
`packages/connectors/src/services/auth-profile-resolver-factory.ts`
runs an inline expiry check:

```
if (status === 'active' && expiresAt &&
    expiresAt + GRACE_MS < now) {
  CAS  filter {_id, tenantId, status: 'active'}
       set    {status: 'expired'}, inc {profileVersion: +1}
  throw AUTH_PROFILE_EXPIRED
}
```

Properties:

- **Grace window**: 60s before `expiresAt` is treated as expired so a
  token being refreshed in-flight is not rejected.
- **CAS**: the `status: 'active'` filter loses cleanly to a concurrent
  revoke or successful token refresh.
- **Best-effort persistence**: the throw still protects the current
  request even if the DB write fails.
- **No background sweep**: every workflow / agent / MCP / dropdown
  read goes through the resolver, so coverage is implicit.

## 6. Cache invariants

`profileVersion` is a monotonic integer on every profile. The runtime
credential cache key is `{tenantId, profileId, profileVersion,
scopeHash}`. The version is bumped by the pre-save hook on any of:

- `config`
- `encryptedSecrets`
- `status`
- `enabled`

Touch-only writes (`lastUsedAt`, `lastValidatedAt`) do not bump it.

Cache invalidation flows:

1. **In-process**: the cache key changes, so the next read misses and
   re-decrypts.
2. **Cross-pod**: `publishAuthProfileInvalidate` over Redis pub/sub on
   destructive operations as a belt-and-suspenders signal.

Bulk operations that bypass Mongoose middleware (`findOneAndUpdate`
without `runValidators` / hooks) will NOT bump the version. The bulk
revoke handler is one such caller today — no UI exposure, but if you
add one wire it through `doc.save()` instead.

## 7. Error codes the UI/SDK can match on

| Code                             | Status | When                                          | Recovery                                                      |
| -------------------------------- | ------ | --------------------------------------------- | ------------------------------------------------------------- |
| `AUTH_PROFILE_NOT_AUTHORIZED`    | 403    | `status === 'pending_authorization'`          | Click Authorize.                                              |
| `AUTH_PROFILE_DISABLED`          | 403    | `enabled === false`                           | Toggle Enable in list page.                                   |
| `AUTH_PROFILE_EXPIRED`           | 403    | Lazy transition fires at resolve time.        | Re-authorize (OAuth) or rotate creds.                         |
| `AUTH_PROFILE_CC_PROVIDER_ERROR` | 4xx    | Client-credentials grant rejected by the IdP. | Verify clientId / clientSecret / scopes against the provider. |

## 8. What's intentionally out of scope (parked)

| Item                                                                         | Why parked                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Provider-side revoke (call Google / Slack / GitHub revoke endpoints)         | No Nango catalog data for revoke URLs; per-provider registry deferred. Local revoke still blocks platform reuse. |
| Bulk revoke parity with single-profile revoke (audit / Redis / token stamp)  | No bulk UI exists today. Add when needed.                                                                        |
| `pending_authorization` TTL sweep                                            | Low value; orphans accumulate slowly.                                                                            |
| Activate-OAuth re-runs the OAuth flow instead of just flipping status        | Stale-token-after-reactivate edge case; deferred.                                                                |
| Rotate Secrets UX using `previousEncryptedSecrets` / `rotationGracePeriodMs` | Fields exist in the model; UX deferred.                                                                          |

## 9. Files of record

- `packages/database/src/models/auth-profile.model.ts` — schema +
  pre-save hook (the source of truth for what bumps profileVersion).
- `packages/connectors/src/services/auth-profile-resolver-factory.ts`
  — resolver gate + lazy expiry transition.
- `packages/shared/src/validation/auth-profile.schema.ts` —
  per-auth-type Zod schemas + `getAllowedConfigKeys` helper.
- `packages/shared-auth-profile/src/errors.ts` — error code catalogue.
- `apps/studio/src/components/auth-profiles/AuthProfileImpactModal.tsx`
  — unified disable/revoke/delete confirmation.
- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`
  — create/edit slide-over (footer actions, isDirty, schema
  projection).
- `apps/studio/src/app/api/auth-profiles/[profileId]/revoke/route.ts`
  — workspace revoke route (full lifecycle).
- `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts`
  — project revoke route (same shape).
