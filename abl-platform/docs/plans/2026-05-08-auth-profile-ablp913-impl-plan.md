# LLD + Implementation Plan: Auth Profile ABLP-913

**Feature Spec**: [docs/features/auth-profiles.md](../features/auth-profiles.md)
**HLD**: [docs/specs/auth-profiles.hld.md](../specs/auth-profiles.hld.md) (§9 ABLP-913 Architecture Extensions)
**Test Spec**: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)
**Status**: DONE for core implementation and 2026-05-13 review hardening (strict E2E execution depth and production soak remain follow-up)
**Date**: 2026-05-08 (revision 2026-05-09; post-implementation sync 2026-05-13)
**Driving Ticket**: [ABLP-913](https://koreteam.atlassian.net/browse/ABLP-913)
**Branch**: `KI081/feat/ablp-913-auth-profiles` (do not switch)
**Revision Note**: 2026-05-09 meeting deltas (HLD §9.0) introduce 6 design overrides + 3 deferrals. New Phase 6 below ("Meeting deltas") implements them on top of Phases 1-5.

**Post-Implementation Note (2026-05-13)**: Review hardening restored the project OAuth callback delegation to the shared finalizer, ensured project-scoped OAuth grants carry `projectId`/`profileId`, propagated `isAuthorized` through list/detail/integrations/assignment UI paths, fixed runtime Redis/session-scanner typing, and removed the dead local duplicate `packages/shared/src/services/auth-profile/token-refresh-service.ts`. Canonical OAuth token refresh lives in `packages/shared-auth-profile/src/token-refresh-service.ts`.

**Verification (2026-05-13)**: `pnpm build` passed. Focused regression suites passed across shared auth-profile authorization/refresh, Studio OAuth callback/integrations routes, and runtime session scanner/force invalidation (77 tests). Full `pnpm test` is blocked by a known `@agent-platform/shared-auth` platform-key scope registry mismatch already present on `origin/develop`; this branch did not modify `packages/shared-auth`.

---

## 1. Design Decisions

### Decision Log (carried forward from HLD)

| #    | Decision (HLD reference)                                                                                                                                                                                   | LLD Implementation Notes                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Persisted `profileType: 'integration' \| 'custom'`                                                                                                                                                         | Zod discriminator + Mongoose enum field; backfill migration sets `connector ? 'integration' : 'custom'`                                         |
| D-2  | Integrations Tab is a filtered view, not a separate model                                                                                                                                                  | New endpoint `/integrations` reads `auth_profiles` with `profileType='integration'` group-by `connector`                                        |
| D-3  | Disabled-row dropdown for unauthorized OAuth                                                                                                                                                               | API response shape adds `selectable: boolean` per row; UI honors it                                                                             |
| D-4  | `EndUserOAuthToken` adds `projectId` + `profileId`; new unique index `{tenantId, projectId, userId, provider}` as **partial** with `{ projectId: { $type: "string" } }` filter so legacy null rows survive | Mongoose schema declares both as `{ required: false }` (round-3 carryover #1). Service layer rejects new-row writes with missing fields via Zod |
| D-5  | Revoke User Tokens supports both per-profile bulk and per-user via optional `userId` query                                                                                                                 | Single endpoint `POST /:profileId/revoke-user-tokens?userId=…`                                                                                  |
| D-6  | Mid-session invalidation: TTL P1, Redis pub/sub force-invalidate P2                                                                                                                                        | Redis channel `auth-profile:invalidate`; subscriber boots with runtime; payload `{profileId, tenantId, projectId}`                              |
| D-7  | Scope errors: generic re-auth prompt to user, detailed scopes to admin audit                                                                                                                               | `ScopeInsufficientDetector` emits audit event with full scope diff; client sees sanitized `REAUTHORIZATION_REQUIRED` per CLAUDE.md              |
| D-8  | Inline-Add stored encrypted via transient tool-scoped profile                                                                                                                                              | New `inlineHostedTool: { toolId, fieldKey } \| null` field on `auth_profiles`; cascade-delete on tool delete via lifecycle hook                 |
| D-9  | "To be Authorized" is computed `isAuthorized` per user — not a status enum value                                                                                                                           | Service layer projection: list/get responses include `isAuthorized: boolean`                                                                    |
| D-10 | New `AuthProfileAssignment` coexists with existing `AuthProfilePicker`                                                                                                                                     | Add new component without removing existing 8 callers                                                                                           |
| D-11 | Activity tab uses per-profile filtered view of new `auth_profile_audit_events`; no separate `/audit-logs` page in scope                                                                                    | Pagination 50 default / 100 max, cursor-based                                                                                                   |
| D-12 | `tokenRefreshUrl` required on CREATE for `oauth2_app + preconfigured`; optional on UPDATE                                                                                                                  | Zod refinement on `CreateAuthProfileSchema`; validate endpoint emits non-blocking warning                                                       |
| D-13 | Separate `revoke-user-tokens` endpoint; existing `revoke` endpoint unchanged                                                                                                                               | New POST route under project-scoped `auth-profiles`                                                                                             |
| D-14 | Extend `/consumers` with ToolDefinition + A2A (gated)                                                                                                                                                      | A2A wrapped with feature flag `AUTH_PROFILE_A2A_CONSUMERS_ENABLED` until model lands                                                            |
| D-15 | UI shows all 17 auth types categorized: Common (the 9 in ABLP-913), Enterprise (Phase 2), Advanced (Phase 3 de-emphasized)                                                                                 | Extend existing `auth-type-metadata.ts` `AUTH_TYPE_CATEGORIES`                                                                                  |
| D-16 | Authorize CTA on profile slide-over in addition to Integration cards                                                                                                                                       | Wire `AuthProfileOAuthDialog` into `AuthProfileSlideOver`                                                                                       |

### Key Interfaces & Types

```typescript
// packages/shared/src/validation/auth-profile.schema.ts (additions)
export const PROFILE_TYPES = ['integration', 'custom'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export const AuthProfileBaseSchema = z.object({
  // ... existing fields
  profileType: z.enum(PROFILE_TYPES), // NEW (D-1)
  inlineHostedTool: z
    .object({ toolId: z.string().min(1), fieldKey: z.string().min(1) })
    .nullable()
    .optional(), // NEW (D-8)
});

// CREATE-time refinement: oauth2_app + preconfigured ⇒ refreshUrl required
export const CreateAuthProfileSchema = AuthProfileBaseSchema.superRefine((p, ctx) => {
  if (p.authType === 'oauth2_app' && p.usageMode === 'preconfigured') {
    const refreshUrl = (p.config as { refreshUrl?: string } | undefined)?.refreshUrl;
    if (!refreshUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'refreshUrl'],
        message: 'AUTH_PROFILE_REFRESH_URL_REQUIRED',
      });
    }
  }
  if (p.profileType === 'integration' && !p.connector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['connector'],
      message: 'AUTH_PROFILE_TYPE_MISMATCH',
    });
  }
});

// packages/shared/src/services/auth-profile/audit-event-emitter.ts (NEW)
//
// Naming-namespace note: the existing constant
//   `packages/database/src/auth-profile/audit-events.ts > AUTH_PROFILE_AUDIT_EVENTS`
// uses SCREAMING_SNAKE_CASE event names (e.g. 'AUTH_PROFILE_TOKEN_REFRESHED') and writes to the
// generic `audit_logs` collection via the auditTrailPlugin. The new emitter below writes to the
// NEW `auth_profile_audit_events` collection with snake_case verb names. The two namespaces are
// deliberately disjoint:
//   • AUTH_PROFILE_AUDIT_EVENTS  → audit-trail plugin → audit_logs (system-level CRUD trail)
//   • AuthProfileAuditEventType  → new emitter        → auth_profile_audit_events (domain Activity tab)
// Implementers MUST NOT cross-emit; the existing CRUD plugin captures CRUD writes automatically and
// the new emitter is reserved for ABLP-913 lifecycle events surfaced in the per-profile Activity tab.
export type AuthProfileAuditEventType =
  | 'authorized'
  | 'authorize_failed'
  | 'token_refreshed'
  | 'token_refresh_failed'
  | 'profile_revoked'
  | 'tokens_revoked'
  | 'profile_updated'
  | 'sensitive_field_changed'
  | 'profile_deleted'
  | 'scope_insufficient_detected';

export interface AuthProfileAuditEventInput {
  tenantId: string;
  projectId: string | null;
  profileId: string;
  eventType: AuthProfileAuditEventType;
  actorUserId: string | null;
  actorContext: {
    source: 'profile' | 'integration_node' | 'tool_config' | 'session_init' | 'system';
    requestId?: string;
    sessionId?: string;
  };
  eventPayload: Record<string, unknown>;
}

export async function emitAuthProfileAuditEvent(input: AuthProfileAuditEventInput): Promise<void>;

// apps/runtime/src/services/auth-profile/session-scanner.ts (NEW)
export interface SessionScanResult {
  preconfigured: Array<{
    profileId: string;
    status: 'valid' | 'refreshed' | 'failed';
    error?: string;
  }>;
  jit: Array<{ profileId: string; deferredUntilFirstUse: true }>;
  preflight: Array<{ profileId: string; requiresUpfrontConsent: true }>;
  issues: Array<{ profileId: string; code: string; message: string }>;
}

export class AuthProfileSessionScanner {
  scan(
    ir: AgentIR,
    ctx: { tenantId: string; projectId: string; userId: string },
  ): Promise<SessionScanResult>;
}

// packages/shared/src/services/auth-profile/blast-radius-aggregator.ts (NEW)
export interface BlastRadiusPayload {
  type: 'profile' | 'tokens';
  affectedConsumers: {
    tools: number;
    integrationNodes: number;
    mcpServers: number;
    a2aServers: number;
    connectorConnections: number;
    channelConnections: number;
    serviceNodes: number;
    gitIntegrations: number;
    triggerRegistrations: number;
  };
  affectedUsers: number;
  activeSessions: number;
  irreversible?: boolean;
  cascadeDeletesTokens?: number;
}
```

### Module Boundaries

| Module                                                 | Responsibility                                                                                               | Depends On                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `packages/database/src/models/`                        | New collection model + extended fields on `auth_profiles` and `end_user_oauth_tokens`                        | `tenantIsolationPlugin`, `encryptionPlugin`       |
| `packages/database/src/migrations/scripts/`            | Idempotent + reversible migration scripts (profileType backfill, EndUserOAuthToken backfill)                 | `migration-runner`, MongoDB                       |
| `packages/shared/src/validation/`                      | Zod schemas with `profileType`, refresh-URL refinement, inline-Add fields                                    | Zod                                               |
| `packages/shared/src/services/auth-profile/`           | Audit-event emitter, blast-radius aggregator, scope-insufficient detector                                    | Database models, runtime context (DI)             |
| `apps/runtime/src/services/auth-profile/`              | `AuthProfileSessionScanner`, `ForceInvalidateSubscriber`, runtime invariants                                 | shared services, AgentIR walker, AuthProfileCache |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/` | New routes (`/integrations`, `/revoke-preview`, `/revoke-user-tokens`, `/force-invalidate`, `/audit-events`) | shared services, RBAC middleware                  |
| `apps/studio/src/components/auth-profiles/`            | UI — `AuthProfileAssignment`, `AuthProfileAuthorizationBadge`, revoke modals, Activity tab                   | API client, design tokens                         |

---

## 2. File-Level Change Map

### New Files

| File                                                                                           | Purpose                                                                          | LOC  |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| `packages/database/src/models/auth-profile-audit-event.model.ts`                               | Mongoose model for `auth_profile_audit_events` (TTL 365d)                        | ~80  |
| `packages/database/src/migrations/scripts/20260508_019_auth_profile_profile_type.ts`           | Backfill `profileType` from `connector` presence                                 | ~60  |
| `packages/database/src/migrations/scripts/20260508_020_end_user_oauth_token_project_scope.ts`  | Add `projectId`+`profileId`; drop+create unique partial index                    | ~120 |
| `packages/database/src/__tests__/migrations/20260508_019_profile_type.test.ts`                 | MIG-1 idempotency + rollback                                                     | ~120 |
| `packages/database/src/__tests__/migrations/20260508_020_end_user_oauth_token_project.test.ts` | MIG-2 three backfill cases + rollback                                            | ~180 |
| `packages/shared/src/services/auth-profile/audit-event-emitter.ts`                             | Single emit point for the 10 audit event types                                   | ~120 |
| `packages/shared/src/services/auth-profile/blast-radius-aggregator.ts`                         | Aggregates consumer counts + affected users + active sessions for revoke-preview | ~180 |
| `packages/shared/src/services/auth-profile/scope-insufficient-detector.ts`                     | Detects `error: insufficient_scope` from provider responses                      | ~80  |
| `packages/shared/src/services/auth-profile/inline-host-cleanup.ts`                             | Cascade-delete transient profiles when owning tool is deleted (lifecycle hook)   | ~60  |
| `packages/shared/src/__tests__/auth-profile/audit-event-emitter.test.ts`                       | Unit tests for all 10 event types                                                | ~140 |
| `packages/shared/src/__tests__/auth-profile/blast-radius-aggregator.test.ts`                   | Unit tests for aggregation correctness                                           | ~120 |
| `packages/shared/src/__tests__/auth-profile/scope-insufficient-detector.test.ts`               | Unit tests for provider error parsing                                            | ~80  |
| `apps/runtime/src/services/auth-profile/session-scanner.ts`                                    | `AuthProfileSessionScanner` walks AgentIR upfront                                | ~160 |
| `apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts`                        | Subscribes to Redis pub/sub `auth-profile:invalidate`                            | ~80  |
| `packages/shared/src/services/auth-profile/force-invalidate-publisher.ts`                      | Publishes invalidation messages from any service                                 | ~60  |
| `apps/runtime/src/__tests__/auth/session-scanner.test.ts`                                      | INT-12 coverage                                                                  | ~180 |
| `apps/runtime/src/__tests__/auth/force-invalidate.test.ts`                                     | INT-26 coverage                                                                  | ~140 |
| `apps/runtime/src/__tests__/auth/scope-insufficient.test.ts`                                   | INT-29b runtime detection                                                        | ~120 |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/integrations/route.ts`                    | `GET /integrations` (FR-10)                                                      | ~80  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-preview/route.ts`      | `GET /revoke-preview?type=…[&userId=…]` (FR-24)                                  | ~80  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-user-tokens/route.ts`  | `POST /revoke-user-tokens[?userId=…]` (FR-23)                                    | ~100 |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/force-invalidate/route.ts`    | `POST /force-invalidate` (FR-26 P2)                                              | ~60  |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/audit-events/route.ts`        | `GET /audit-events` paginated (FR-30/FR-31)                                      | ~100 |
| `apps/studio/src/__tests__/api-routes/auth-profiles/integrations-route.test.ts`                | INT-10 coverage                                                                  | ~140 |
| `apps/studio/src/__tests__/api-routes/auth-profiles/revoke-preview-route.test.ts`              | INT-24 coverage                                                                  | ~180 |
| `apps/studio/src/__tests__/api-routes/auth-profiles/revoke-user-tokens-route.test.ts`          | INT-23a + INT-23b coverage                                                       | ~200 |
| `apps/studio/src/__tests__/api-routes/auth-profiles/audit-events-route.test.ts`                | INT-30 + INT-31 coverage                                                         | ~140 |
| `apps/studio/src/components/auth-profiles/AuthProfileAssignment.tsx`                           | Stepped, type-aware assignment component (FR-18)                                 | ~280 |
| `apps/studio/src/components/auth-profiles/AuthProfileAuthorizationBadge.tsx`                   | "To be Authorized" / "Authorized as user@x" badge (FR-14)                        | ~80  |
| `apps/studio/src/components/auth-profiles/RevokeProfileConfirm.tsx`                            | Pre-revoke blast-radius modal — Revoke Profile (FR-23/FR-24)                     | ~140 |
| `apps/studio/src/components/auth-profiles/RevokeUserTokensConfirm.tsx`                         | Pre-revoke blast-radius modal — Revoke User Tokens (FR-23/FR-24)                 | ~160 |
| `apps/studio/src/components/auth-profiles/SensitiveFieldChangeAdvisory.tsx`                    | Toast advisory after PUT changing sensitive fields (FR-25)                       | ~60  |
| `apps/studio/src/components/auth-profiles/ActivityTabPanel.tsx`                                | Activity tab panel in slide-over (FR-31)                                         | ~180 |
| `apps/studio/src/__tests__/components/auth-profiles/AuthProfileAssignment.test.tsx`            | UI unit tests (FR-15, FR-18)                                                     | ~160 |
| `apps/studio/src/__tests__/components/auth-profiles/RevokeUserTokensConfirm.test.tsx`          | UI unit tests for blast-radius modal                                             | ~120 |
| `apps/studio/e2e/auth-profiles/ablp913-integration-profile.spec.ts`                            | E2E-8 (Integration profile lifecycle + Authorize CTA)                            | ~220 |
| `apps/studio/e2e/auth-profiles/ablp913-project-scoped-consent.spec.ts`                         | E2E-9 (project-scoped consent persistence)                                       | ~200 |
| `apps/studio/e2e/auth-profiles/ablp913-type-aware-assignment.spec.ts`                          | E2E-10 (type-aware UI + saved-profile-only credential assignment)                | ~220 |
| `apps/studio/e2e/auth-profiles/ablp913-deletion-guard.spec.ts`                                 | E2E-11 (deletion guard + clear consumer errors)                                  | ~180 |
| `apps/studio/e2e/auth-profiles/ablp913-session-init-scan.spec.ts`                              | E2E-12 (session-init scan)                                                       | ~220 |
| `apps/studio/e2e/auth-profiles/ablp913-revoke-actions.spec.ts`                                 | E2E-13 (two revoke actions with blast-radius)                                    | ~240 |
| `apps/studio/e2e/auth-profiles/ablp913-mid-session-invalidation.spec.ts`                       | E2E-14 (force-invalidate + TTL)                                                  | ~200 |
| `apps/studio/e2e/auth-profiles/ablp913-insufficient-scope.spec.ts`                             | E2E-15 (insufficient_scope both paths)                                           | ~220 |

### Modified Files

| File                                                                  | Change Description                                                                                                                                                                              | Risk       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/database/src/models/auth-profile.model.ts`                  | Add `profileType` (enum), `lastAuthorizedAt`, `lastAuthorizedBy`, `inlineHostedTool` fields. Add new query index `{tenantId, projectId, profileType, connector}`.                               | LOW        |
| `packages/database/src/models/end-user-oauth-token.model.ts`          | Add `projectId` + `profileId` as `{ required: false }`. Drop old unique index, create new partial unique `{tenantId, projectId, userId, provider}` and partial `{tenantId, profileId, userId}`. | **HIGH**   |
| `packages/database/src/cascade/cascade-delete.ts`                     | Add `auth_profile_audit_events` cascade entry on profile delete (per `packages/database/agents.md` mock-sync gotcha).                                                                           | MEDIUM     |
| `packages/database/src/__tests__/cascade-delete-auth-profile.test.ts` | Update mock entries — sync with new cascade entry (per agents.md note).                                                                                                                         | MEDIUM     |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`      | Update mock entries — sync.                                                                                                                                                                     | MEDIUM     |
| `packages/database/src/__tests__/mongo-cascade.test.ts`               | Update mock entries — sync.                                                                                                                                                                     | MEDIUM     |
| `packages/database/src/migrations/registry.ts`                        | Register both new migration scripts.                                                                                                                                                            | LOW        |
| `packages/database/src/index.ts`                                      | Export `AuthProfileAuditEvent` model + `IAuthProfileAuditEvent` interface.                                                                                                                      | LOW        |
| `packages/shared/src/validation/auth-profile.schema.ts`               | Add `profileType` + `inlineHostedTool`; refinement for refreshUrl required on CREATE; refinement for `profileType==integration ⇒ connector` non-empty.                                          | MEDIUM     |
| `packages/shared/src/services/auth-profile.service.ts`                | Add `isAuthorized` computed projection; backward-compatible default `profileType` derivation when reading legacy rows; route emit calls into the new audit-event-emitter.                       | **MEDIUM** |
| `packages/shared/src/services/auth-profile/redact.ts`                 | Ensure `inlineHostedTool` is preserved in API responses (it's metadata, not a secret).                                                                                                          | LOW        |
| `packages/shared-auth-profile/src/token-refresh-service.ts`           | Canonical token refresh service; on refresh failure, emit `token_refresh_failed` audit event + signal `isAuthorized=false` for affected user (FR-17).                                           | MEDIUM     |

<!-- Removed: OAuth callback write path is in Studio (apps/studio/.../oauth/callback/route.ts). See Phase 4 modified-files table. -->

| `apps/runtime/src/services/auth-profile-resolver.ts` | Return null for cached entries that match a force-invalidate event since last access; resolve project-scoped tokens. | MEDIUM |
| `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` | Already supports `invalidate(profileId)`; add hook so `ForceInvalidateSubscriber` can call it. No behavior change to TTL. | LOW |
| `apps/runtime/src/services/session/session-bootstrap.ts` _(or equivalent)_ | Wire `AuthProfileSessionScanner.scan()` before first tool dispatch; surface failures as structured errors. Gated by env flag `AUTH_PROFILE_SESSION_SCAN_ENABLED` (default ON). | **HIGH** |
| `apps/runtime/src/server.ts` | Register `ForceInvalidateSubscriber` in startup; deregister on shutdown. | LOW |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` | Wrap provider responses with `ScopeInsufficientDetector`; emit `scope_insufficient_detected` and return sanitized `REAUTHORIZATION_REQUIRED` to caller (FR-29 path B). This is the existing HTTP-tool credential application point. | **HIGH** |
| `apps/runtime/src/routes/auth-profiles.ts` | Extend runtime delete guard to consider `auth_profile_audit_events` cascade. | LOW |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/consumers/route.ts` | Extend payload to include `tools` (ToolDefinition) + `a2aServers` (gated by `AUTH_PROFILE_A2A_CONSUMERS_ENABLED`). | MEDIUM |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` | DELETE accepts `?confirm=true&consumerCount=N`; profile route returns `inlineHostedTool` and computed `isAuthorized` per request user. | MEDIUM |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts` | Return non-blocking warning code `AUTH_PROFILE_REFRESH_URL_MISSING` for existing oauth2_app+preconfigured rows missing refreshUrl. | LOW |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` | Write `projectId` + `profileId` into `EndUserOAuthToken`. Detect insufficient grant and emit audit event (FR-29 path A). | MEDIUM |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` | Same — project-scoped token row. | MEDIUM |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx` | Pre-filter on arrival: read `?authType=…` query param and apply the existing filter state (FR-19). | LOW |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` | Add Authorize CTA (D-16) + Activity tab + new revoke modals + sensitive-field-advisory toast. | **HIGH** |
| `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx` | No change — keeps lifecycle status. New `AuthProfileAuthorizationBadge` is a sibling component. | LOW |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` | Annotate auth types with categories `'common' \| 'enterprise' \| 'advanced'` per D-15. | LOW |
| `apps/studio/src/api/auth-profiles.ts` | Add typed wrappers for the 5 new endpoints; widen response types for `consumers`, `validate`, `oauth/callback`. | LOW |

### Deleted Files

None. ABLP-913 is additive (per CLAUDE.md "Feature work must be additive").

---

## 3. Implementation Phases

> Each phase is independently deployable and testable. Phases 1 and 2 ship a backward-compatible model and service. Phase 3 ships runtime behavior behind a feature flag. Phases 4 and 5 ship API and UI. **Commit discipline**: max 40 non-doc files, max 3 packages per commit. Each phase will require multiple commits — split by package boundaries.

---

### Phase 1: Schema + Migration Foundations

**Goal**: Ship the data-layer changes (new fields, new collection, new indexes, migration scripts) so subsequent phases can rely on them.

**Tasks**:

1.1 Create `packages/database/src/models/auth-profile-audit-event.model.ts` with TTL index 365d, `tenantIsolationPlugin`, secondary indexes per HLD §9.5. Export from `packages/database/src/index.ts`.
1.2 Modify `packages/database/src/models/auth-profile.model.ts` to add `profileType` (enum + default), `lastAuthorizedAt`, `lastAuthorizedBy`, `inlineHostedTool`. Add query index `{tenantId, projectId, profileType, connector}`.
1.3 Modify `packages/database/src/models/end-user-oauth-token.model.ts` to add `projectId` + `profileId` as `{ required: false }`. Replace unique index with partial unique `{tenantId, projectId, userId, provider}` (filter `{ projectId: { $type: "string" } }`); add partial `{tenantId, profileId, userId}` (filter `{ profileId: { $type: "string" } }`).
1.4 Create migration script `20260508_019_auth_profile_profile_type.ts` — sets `profileType = connector ? 'integration' : 'custom'` for all rows where field is unset; idempotent + reversible. Register in `packages/database/src/migrations/registry.ts`.
1.5 Create migration script `20260508_020_end_user_oauth_token_project_scope.ts` — three backfill cases per HLD §9.4 #10. Drops old unique index and creates new partial unique + partial secondary. Idempotent + reversible. Register.
1.6 Update `packages/database/src/cascade/cascade-delete.ts` to:
(a) Delete matching `auth_profile_audit_events` rows when an `auth_profile` is deleted (per profile cascade).
(b) **NEW (resolves H-4)** — add `EndUserOAuthToken.deleteMany({tenantId})` to `deleteTenant()`, `EndUserOAuthToken.deleteMany({projectId})` to `deleteProject()`, and `EndUserOAuthToken.deleteMany({tenantId, userId})` to `deleteUser()`. This was missing prior to ABLP-913 and is a GDPR right-to-erasure compliance gap (Core Invariant #5).
(c) **NEW (resolves M-1)** — add `EndUserOAuthToken` to the destructured imports at the top of `cascade-delete.ts` and to the model-list type used by the cascade runner.
Per `packages/database/agents.md` gotcha, sync `cascade-delete-auth-profile.test.ts`, `cascade-delete-modules.test.ts`, `mongo-cascade.test.ts` mock entries in the **same commit** as the cascade change.
1.7 Author migration tests `20260508_001_profile_type.test.ts` and `20260508_002_end_user_oauth_token_project.test.ts` per test spec MIG-1 and MIG-2.
1.8 Run `pnpm build --filter=@agent-platform/database` and `pnpm test --filter=@agent-platform/database` to confirm green.

**Files Touched** (split into 2-3 commits within Phase 1, all in `packages/database` — keep each commit ≤ 40 files; all single-package per CLAUDE.md commit-scope guard):

- Commit 1: model changes + new model + new index (tasks 1.1, 1.2, 1.3)
- Commit 2: migration scripts + registry + migration tests (tasks 1.4, 1.5, 1.7)
- Commit 3: cascade-delete + EndUserOAuthToken erasure cascade + cascade-delete mock sync (task 1.6)

- New: `packages/database/src/models/auth-profile-audit-event.model.ts`
- New: `packages/database/src/migrations/scripts/20260508_019_auth_profile_profile_type.ts`
- New: `packages/database/src/migrations/scripts/20260508_020_end_user_oauth_token_project_scope.ts`
- New: `packages/database/src/__tests__/migrations/20260508_019_profile_type.test.ts`
- New: `packages/database/src/__tests__/migrations/20260508_020_end_user_oauth_token_project.test.ts`
- Modified: `packages/database/src/models/auth-profile.model.ts`
- Modified: `packages/database/src/models/end-user-oauth-token.model.ts`
- Modified: `packages/database/src/cascade/cascade-delete.ts`
- Modified: `packages/database/src/__tests__/cascade-delete-auth-profile.test.ts`
- Modified: `packages/database/src/__tests__/cascade-delete-modules.test.ts`
- Modified: `packages/database/src/__tests__/mongo-cascade.test.ts`
- Modified: `packages/database/src/migrations/registry.ts`
- Modified: `packages/database/src/index.ts`

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/database` passes with 0 TypeScript errors
- [ ] `pnpm test --filter=@agent-platform/database` passes with 0 failures
- [ ] MIG-1 test runs against MongoMemoryServer with 5 seeded rows: 2 integration + 3 custom backfilled correctly; idempotent re-run produces no diff; rollback unsets `profileType` cleanly
- [ ] MIG-2 test exercises three backfill cases (deterministic projectId from profile; tenant-scoped → null with warning; unresolvable → null + force re-auth note); old unique index dropped and new partial unique + partial secondary created; rollback restores old index. Also asserts INT-28 invariants — cross-project token reuse blocked, same-tenant lookups across projects return distinct rows.
- [ ] Cascade-delete mocks updated; `cascade-delete-auth-profile.test.ts`, `cascade-delete-modules.test.ts`, `mongo-cascade.test.ts` all pass with the new entry
- [ ] `npx prettier --write` run on all touched files; lint-staged commit hook passes

**Test Strategy**:

- Unit: model schema validation, migration script idempotency.
- Integration: MIG-1 + MIG-2 against MongoMemoryServer; cascade-delete with seeded audit-events.
- E2E: deferred to phase 5.

**Rollback**: Run rollback halves of both migrations (drop new fields/indexes, restore old unique index). Drop the new `auth_profile_audit_events` collection. Revert package files via git.

**Dependencies**: None — Phase 1 is the foundation.

---

### Phase 2: Service Layer + Backward-Compatible Reads

**Goal**: Service code can read/write the new fields, emit audit events, and aggregate blast-radius. No external callers wired yet — this phase is internal-only.

**Tasks**:

2.1 Update `packages/shared/src/validation/auth-profile.schema.ts` — add `profileType` + `inlineHostedTool` to base schema; `superRefine` for refresh-URL-required-on-CREATE and `profileType==integration ⇒ connector` non-empty. Export `ProfileType` and `PROFILE_TYPES`.
2.2 Update `packages/shared/src/services/auth-profile.service.ts` — when reading legacy rows missing `profileType`, derive `connector ? 'integration' : 'custom'` (defense-in-depth alongside the migration). Add `isAuthorized` computed field to list/get responses (uses `EndUserOAuthToken` lookup for JIT/Preflight; uses `encryptedSecrets` presence for Preconfigured).
2.3 Create `packages/shared/src/services/auth-profile/audit-event-emitter.ts`. Single `emitAuthProfileAuditEvent(input)` writes to `auth_profile_audit_events`. Idempotency by `(tenantId, profileId, eventType, requestId)` when `requestId` is present.
2.4 Create `packages/shared/src/services/auth-profile/blast-radius-aggregator.ts`. Reuses queries from existing `consumers/route.ts`; counts `EndUserOAuthToken` rows for the profile; counts active sessions via existing session repo. Exposes `aggregate(profileId, type: 'profile' | 'tokens', userId?)`.
2.5 Create `packages/shared/src/services/auth-profile/scope-insufficient-detector.ts`. Pure function `detectInsufficientScope(response: { status, body })` returns `{ missing: string[]; granted: string[] } | null`.
2.6 Create `packages/shared/src/services/auth-profile/inline-host-cleanup.ts`. Lifecycle hook helper `cleanupInlineHostsForTool(toolId)` deletes orphan transient profiles. Wired in Phase 4 by tool-deletion route.
2.6b Create `packages/shared/src/services/auth-profile/force-invalidate-publisher.ts` — helper used by Studio API routes (Phase 4) to publish `{ profileId, tenantId, projectId }` to Redis pub/sub channel `auth-profile:invalidate`. Lives in `packages/shared` so both Studio and runtime can import it (Studio cannot reach into `apps/runtime/`).
2.7 Update `packages/shared/src/services/auth-profile/redact.ts` — preserve `inlineHostedTool`, `profileType`, `lastAuthorizedAt`, `lastAuthorizedBy` (metadata, not secrets). Continue to strip `encryptedSecrets`, `previousEncryptedSecrets`, `encryptionKeyVersion`.
2.8 Update `packages/shared-auth-profile/src/token-refresh-service.ts` — on refresh failure, call `emitAuthProfileAuditEvent({ eventType: 'token_refresh_failed', ... })`. On success, emit `token_refreshed`. The older local `packages/shared/src/services/auth-profile/token-refresh-service.ts` duplicate was removed during the 2026-05-13 hardening sync.
2.9 Author unit tests for emitter, aggregator, detector. Author service-level tests for `isAuthorized` computation.

> **Note (resolves OQ-3 + H-5)**: The OAuth callback write point lives in the **Studio route** at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` (function `upsertOAuthGrant()` at line 78). It is **NOT** in `packages/shared/src/services/oauth-grant-service.ts` (which is a runtime read-only service at `apps/runtime/src/services/oauth-grant-service.ts` — no shared-package version exists). The `projectId` + `profileId` write happens in Phase 4 task 4.9. Phase 2 ships only shared-package code.

**Files Touched**:

- New: `packages/shared/src/services/auth-profile/audit-event-emitter.ts`
- New: `packages/shared/src/services/auth-profile/blast-radius-aggregator.ts`
- New: `packages/shared/src/services/auth-profile/scope-insufficient-detector.ts`
- New: `packages/shared/src/services/auth-profile/inline-host-cleanup.ts`
- New: `packages/shared/src/services/auth-profile/force-invalidate-publisher.ts`
- New (3 test files): `audit-event-emitter.test.ts`, `blast-radius-aggregator.test.ts`, `scope-insufficient-detector.test.ts`
- Modified: `packages/shared/src/validation/auth-profile.schema.ts`
- Modified: `packages/shared/src/services/auth-profile.service.ts`
- Modified: `packages/shared/src/services/auth-profile/redact.ts`
- Modified: `packages/shared-auth-profile/src/token-refresh-service.ts`
- _(Note: OAuth callback write path is in the Studio route, not shared services — see Phase 4 task 4.9.)_
- Modified: `packages/shared/src/services/auth-profile/index.ts` (re-export new modules)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/shared` passes
- [ ] `pnpm test --filter=@agent-platform/shared` passes (no regressions in 29 existing auth-profile suites)
- [ ] All 3 new unit test files passing with > 90% line coverage of new modules — covers INT-9 (service-level profileType validation), INT-17 (auto-refresh failure → revert isAuthorized), INT-20 (inline credential rejection + saved-profile redaction), INT-18 (assignment API contract — `selectable` flags and saved-profile-only flow); these exercise the shared service layer without HTTP boundaries
- [ ] `isAuthorized` computed correctly for all 4 cases: Preconfigured authorized (token on profile), Preconfigured not authorized (no token), JIT/Preflight authorized for user (EndUserOAuthToken exists), JIT/Preflight not authorized for user
- [ ] Audit event emitter writes to `auth_profile_audit_events` with full payload schema; verified by integration test
- [ ] Blast-radius aggregator returns counts for all 9 consumer types + affected users + active sessions
- [ ] Scope-insufficient detector parses both standard `error: insufficient_scope` and HTTP 401/403 with `WWW-Authenticate: scope=…` hints
- [ ] `npx prettier --write` run; lint-staged passes

**Test Strategy**:

- Unit: emitter, aggregator, detector, schema validation, redact preservation.
- Integration: emitter writing to MongoMemoryServer; aggregator reading seeded data; OAuth callback writing project-scoped token.
- E2E: deferred to phase 5.

**Rollback**: Revert package files via git. `auth_profile_audit_events` rows accumulated during testing can be ignored or cleaned with `db.auth_profile_audit_events.drop()`.

**Dependencies**: Phase 1 (schema + collection must exist).

---

### Phase 3: Runtime — Session Scanner, Force-Invalidate, Scope Detector

**Goal**: Runtime resolves credentials upfront, propagates revocation across pods, and surfaces scope errors. Gated by `AUTH_PROFILE_SESSION_SCAN_ENABLED` env flag (default ON post-rollout, OFF for safety during initial deploy).

**Tasks**:

3.1 Create `apps/runtime/src/services/auth-profile/session-scanner.ts`. Walks AgentIR (existing IR walker pattern), collects unique `authProfileId` references, classifies by `usageMode` (satisfies FR-11: `usageMode` applies everywhere it is referenced), drives Preconfigured token validation/refresh, returns `SessionScanResult`. Emits trace events `auth_profile.session_init.scan_completed`, `auth_profile.session_init.preconfigured_resolved`, `auth_profile.session_init.refresh_failed`.
3.2 ~~Create force-invalidate-publisher in runtime~~ — **Moved to Phase 2 (shared package)**: the publisher is created at `packages/shared/src/services/auth-profile/force-invalidate-publisher.ts` so Studio routes can import it (Studio cannot import from `apps/runtime/`). The runtime-side `ForceInvalidateSubscriber` (task 3.3 below) stays in runtime.
3.3 Create `apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts`. Boots with the runtime pod, subscribes to `auth-profile:invalidate`. Pub/sub message payload `{ profileId, tenantId, projectId }`. On message, calls `cache.invalidate(message.tenantId, message.profileId)` (matches the existing signature `invalidate(tenantId: string, profileId?: string)` at `auth-profile-cache.ts:159`). Emits trace `auth_profile.cache_invalidated` (reason='force'). Idempotent: invalidating an already-evicted entry is a no-op (closes Open Question 4).
3.4 No code change needed in `auth-profile-cache.ts` — the existing `invalidate(tenantId, profileId?)` signature is sufficient for the subscriber. (Originally listed as a task; downgraded to "verify only" after sig confirmation.)
3.5 Modify `apps/runtime/src/services/session/session-bootstrap.ts` (or equivalent runtime entry-point) to call `AuthProfileSessionScanner.scan()` before the first tool dispatch, gated by `AUTH_PROFILE_SESSION_SCAN_ENABLED`. On scan issues, surface structured error to SDK and refuse to start the session.
3.6 Wire `ScopeInsufficientDetector` into the existing tool-execution path. **Exact injection point**: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` (this is where provider credentials are applied to outbound HTTP tool calls and where 401/403 responses are first observed). Wrap the response handling so that when the detector identifies an `insufficient_scope` provider error, the runtime emits `scope_insufficient_detected` audit event and returns a sanitized `{ error: { code: 'REAUTHORIZATION_REQUIRED', message: 'This action requires additional permissions. Please re-authorize.' } }` to the caller. For non-HTTP tools (`flow-step-executor.ts`, etc.) the detector remains optional — they cannot return `insufficient_scope` since they do not call external providers.
3.7 Modify `apps/runtime/src/server.ts` to register `ForceInvalidateSubscriber` in startup; deregister on shutdown.
3.8 Author tests: `session-scanner.test.ts` (INT-12), `force-invalidate.test.ts` (INT-26), `scope-insufficient.test.ts` (INT-29b runtime detection).
3.9 Update `apps/runtime/src/health/auth-profile-health.ts` to include `auth_profile_audit_events` write-path probe and Redis pub/sub subscriber-alive probe.
3.10 Update `apps/runtime/src/health/auth-profile-alerting.ts` with two new alert dimensions: `revoke_user_tokens_per_minute`, `scope_insufficient_per_hour`.
3.11 Add env flag handling for `AUTH_PROFILE_SESSION_SCAN_ENABLED` in `apps/runtime/src/config/index.ts (FeatureFlagsSchema)` (or equivalent).

**Files Touched**:

- New: `apps/runtime/src/services/auth-profile/session-scanner.ts`
- _(Note: `packages/shared/src/services/auth-profile/force-invalidate-publisher.ts` is created in Phase 2 task 2.6b — listed here for cross-reference only.)_
- New: `apps/runtime/src/services/auth-profile/force-invalidate-subscriber.ts`
- New (3 test files): `session-scanner.test.ts`, `force-invalidate.test.ts`, `scope-insufficient.test.ts`
- Modified: `apps/runtime/src/services/session/session-bootstrap.ts` (or canonical session entry)
- Modified: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` (provider response wrap point for ScopeInsufficientDetector)
- Modified: `apps/runtime/src/server.ts`
- Modified: `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` (signature confirm only)
- Modified: `apps/runtime/src/health/auth-profile-health.ts`
- Modified: `apps/runtime/src/health/auth-profile-alerting.ts`
- Modified: `apps/runtime/src/config/index.ts (FeatureFlagsSchema)` (or equivalent)

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` passes
- [ ] `pnpm test --filter=runtime` passes (no regressions in 29 existing auth-profile suites)
- [ ] `session-scanner.test.ts` covers Preconfigured (refresh inline), JIT (deferred), Preflight (upfront), `user_token` (deferred like JIT), and refresh-failure path (covers INT-12)
- [ ] `force-invalidate.test.ts` covers publish → subscriber receive → `AuthProfileCache.invalidate()` call within < 100ms in ioredis-mock (covers INT-26)
- [ ] `scope-insufficient.test.ts` covers both standard and `WWW-Authenticate` provider error formats; verifies sanitized response and audit event emission (covers INT-29b runtime detection + INT-27 clear delete-time errors at consumer call site)
- [ ] Health probes return `OK` for both new dimensions (audit-events write-path + subscriber-alive)
- [ ] Alert evaluator reports two new dimensions
- [ ] Env flag `AUTH_PROFILE_SESSION_SCAN_ENABLED` gates session-init scan (off → falls back to lazy resolve; on → runs scanner)

**Test Strategy**:

- Unit: pure logic in scanner result classification, detector pattern matching.
- Integration: scanner against seeded MongoMemoryServer + AgentIR fixtures; force-invalidate via ioredis-mock pub/sub; tool-call runner with DI-stubbed provider returning `insufficient_scope`.
- E2E: deferred to phase 5 (E2E-12, E2E-14, E2E-15 cover this end-to-end).

**Rollback**: Set `AUTH_PROFILE_SESSION_SCAN_ENABLED=false` in env to disable the scanner. Restart pods to drop subscriber. Revert files via git.

**Dependencies**: Phase 2 (audit-event emitter, scope detector available in `@agent-platform/shared`).

---

### Phase 4: Studio API Routes

**Goal**: Ship the 5 new endpoints + 4 modified endpoints. RBAC respected, isolation enforced, error envelopes consistent.

> **Auth pattern (resolves M-6)**: All new Studio routes use the project-scope wrapper from the existing pattern: `withRouteHandler({ requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ | AUTH_PROFILE_WRITE })`. Read endpoints use `AUTH_PROFILE_READ`; write endpoints (`POST /revoke-user-tokens`, `POST /force-invalidate`) use `AUTH_PROFILE_WRITE`. The runtime-side `auth-profile:authorize` permission split is deferred per Open Question 2.

**Tasks**:

4.1 Create `apps/studio/src/app/api/projects/[id]/auth-profiles/integrations/route.ts` — `GET /integrations` returns vendor-grouped payload using `profileType: 'integration'` filter and `connector` group-by. Uses existing project-scope middleware. Permission `auth_profile:read`.
4.2 Create `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-preview/route.ts` — `GET /revoke-preview?type=profile|tokens[&userId=…]` calls `BlastRadiusAggregator.aggregate()`. Permission `auth_profile:write`. Returns `BlastRadiusPayload`.
4.3 Create `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-user-tokens/route.ts` — `POST /revoke-user-tokens[?userId=…]` deletes matching `EndUserOAuthToken` rows; emits `tokens_revoked`; publishes `auth-profile:invalidate`. Permission `auth_profile:write`.
4.4 Create `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/force-invalidate/route.ts` — `POST /force-invalidate` publishes Redis message via the `force-invalidate-publisher`. Permission `auth_profile:write`. P2.
4.5 Create `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/audit-events/route.ts` — `GET /audit-events?eventType=…&cursor=…&limit=50` returns paginated audit events. Permission `auth_profile:read`. Default limit 50, max 100.
4.6 Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/consumers/route.ts` — extend with `tools` (ToolDefinition query) and `a2aServers` (gated by `AUTH_PROFILE_A2A_CONSUMERS_ENABLED`). Returns warning + empty array when flag off.
4.7 Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts` — DELETE accepts `?confirm=true&consumerCount=N`; GET projects `isAuthorized` per request user; PUT detects sensitive-field changes and includes `sensitiveFieldsChanged: string[]` in response (used by Studio toast in Phase 5). Emit `profile_updated`, `sensitive_field_changed`, and `profile_deleted` audit events.
4.8 Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts` — return `{ warnings: [...] }` payload including `AUTH_PROFILE_REFRESH_URL_MISSING` for existing oauth2_app+preconfigured rows missing refreshUrl.
4.9 Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` and `oauth/user-consent/route.ts` — write `projectId` + `profileId` into `EndUserOAuthToken`. **(resolves M-2)** The existing `upsertOAuthGrant()` function in `oauth/callback/route.ts` (around line 78) currently uses `findOne({tenantId, userId, provider})`; this MUST be updated to `findOne({tenantId, projectId, userId, provider})` to align with the new partial unique index (D-4). The `create` payload MUST also include `projectId` and `profileId`. **Audit emit points (resolves XP-H1)**: emit `authorized` on successful OAuth token exchange/storage; emit `authorize_failed` on callback errors (provider returned `error`, PKCE state mismatch, token exchange HTTP failure, decryption failure). Detect insufficient grant (granted scopes < requested scopes from PKCE state) and emit `scope_insufficient_detected` audit event (FR-29 path A).
4.10 Modify `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts` — on success emit `profile_revoked` audit event + publish `auth-profile:invalidate` + cascade-delete EndUserOAuthToken rows for the profile (already happens via cascade-delete.ts in Phase 1).
4.11 Author API route tests: integrations, revoke-preview, revoke-user-tokens, audit-events. Update consumers test for new shape.
4.12 Update `apps/studio/src/api/auth-profiles.ts` — typed wrappers for the 5 new endpoints + widen response types.
4.13 Add env flag handling for `AUTH_PROFILE_A2A_CONSUMERS_ENABLED` (default OFF until A2AServer model lands).
4.14 **(resolves H/inline-host-cleanup wiring)** Wire `cleanupInlineHostsForTool(toolId)` into the existing HTTP-tool DELETE handler in Studio. Exact path TBD during impl — search for the route that handles tool deletion (typically `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts` or equivalent under the tools API). Add the cleanup call after successful tool deletion so the transient auth profile is cascade-deleted in the same request. This satisfies FR-22 cascade-delete on tool delete (Open Question 8).

**Files Touched** (Studio package, > 3 in count: split commits by route grouping — first commit covers routes 4.1-4.5, second covers 4.6-4.10, third covers 4.11-4.13. Stay ≤ 40 files per commit):

- New (5 route files): integrations, revoke-preview, revoke-user-tokens, force-invalidate, audit-events
- New (4 test files): integrations-route.test.ts, revoke-preview-route.test.ts, revoke-user-tokens-route.test.ts, audit-events-route.test.ts
- Modified: 7 existing route files (consumers, [profileId] route, validate, oauth/callback, oauth/user-consent, revoke, plus shared utils)
- Modified: `apps/studio/src/api/auth-profiles.ts`
- Modified: existing Studio test files for routes that changed shape (audit additions, isAuthorized, validate warnings)

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` passes
- [ ] `pnpm test --filter=studio` passes (no regressions in 10 existing auth-profile API route tests)
- [ ] All 4 new API route tests passing — INT-10, INT-24, INT-23a/b, INT-30, INT-31
- [ ] All modified-route test additions passing — INT-13 (Authorize CTA + isAuthorized in slide-over GET), INT-16 (refreshUrl required at CREATE), INT-21 (consumers extended), INT-22 (deletion guard with extended consumer list), INT-29a (insufficient_scope at OAuth callback)
- [ ] Cross-tenant + cross-project requests on each new endpoint return 404 (verified by route tests)
- [ ] RBAC: routes return 403 when caller lacks `auth_profile:write` (or `auth_profile:read` for GET endpoints)
- [ ] Modified `consumers` endpoint returns ToolDefinition counts and a2aServers warning when flag off
- [ ] OAuth callback writes `projectId` + `profileId` into `EndUserOAuthToken` (verified end-to-end via E2E-9 in Phase 5)
- [ ] `npx prettier --write` run; lint-staged passes

**Test Strategy**:

- Unit: route-handler input validation.
- Integration: routes against MongoMemoryServer + ioredis-mock + DI-stubbed OAuth providers.
- E2E: Phase 5 (E2E-8, E2E-9, E2E-11, E2E-13 cover these end-to-end).

**Rollback**: Disable new routes via guarded export in route file (`export const GET = undefined`) or remove them. The 4 modified routes have additive changes only — old request shape still accepted.

**Dependencies**: Phase 2 (services + force-invalidate publisher), Phase 3 (subscriber + session scanner). UI in Phase 5 depends on these endpoints.

---

### Phase 5: Studio UI + E2E Tests

**Goal**: All UX behaviors land — type-aware assignment, Authorize CTA on slide-over, Activity tab, blast-radius modals, sensitive-field-advisory, pre-filter on arrival. All 8 E2E scenarios pass.

> **i18n** — All new components use `useTranslations('auth_profiles.<sub>')` from `next-intl`, matching the existing `auth_profiles.batch_consent` pattern. New keys land in `packages/i18n/locales/en/studio.json` under the `auth_profiles` namespace. Suggested sub-namespaces:
>
> - `auth_profiles.assignment` — `AuthProfileAssignment` labels, dropdown empty states, type-selector text
> - `auth_profiles.authorization` — `AuthProfileAuthorizationBadge` "To be Authorized" / "Authorized as {email}"
> - `auth_profiles.revoke` — `RevokeProfileConfirm` + `RevokeUserTokensConfirm` modal copy + blast-radius strings
> - `auth_profiles.activity` — `ActivityTabPanel` event-type labels, empty state, pagination
> - `auth_profiles.advisory` — `SensitiveFieldChangeAdvisory` toast copy
>   No hardcoded English strings in labels, button text, empty states, error messages, or modals.

**Tasks**:

5.1 Create `AuthProfileAssignment.tsx` — stepped, type-aware. Step 1 selects auth type (categorized via `auth-type-metadata.ts` D-15). Step 2 type-aware: simple types → dropdown (with disabled-row D-3 rendering for unauthorized OAuth) + inline-Add + Create CTA; complex types → dropdown only + Create CTA. Empty state per FR-18. Coexists with `AuthProfilePicker` (8 callers preserved per D-10).
5.2 Create `AuthProfileAuthorizationBadge.tsx` — renders per-user `isAuthorized` badge. Used in profile cards and assignment dropdowns.
5.3 Create `RevokeProfileConfirm.tsx` — modal that calls `GET /revoke-preview?type=profile`, displays counts, requires explicit admin confirmation, then calls `POST /revoke`.
5.4 Create `RevokeUserTokensConfirm.tsx` — modal that calls `GET /revoke-preview?type=tokens[&userId=…]`, displays counts, optional per-user toggle, calls `POST /revoke-user-tokens[?userId=…]`.
5.5 Create `SensitiveFieldChangeAdvisory.tsx` — toast triggered when PUT response includes `sensitiveFieldsChanged` array.
5.6 Create `ActivityTabPanel.tsx` — paginated list (cursor + 50/page) of audit events. Render event-type-specific summaries; expandable detail panel per event.
5.7 Modify `AuthProfileSlideOver.tsx` — add Authorize CTA (D-16, wires to existing `AuthProfileOAuthDialog`); add Activity tab; render `AuthProfileAuthorizationBadge`; integrate revoke modals; show sensitive-field advisory toast on PUT.
5.8 Modify `AuthProfilesPage.tsx` — read `?authType=…` query param on mount and apply to filter (FR-19 pre-filter).
5.9 Modify `auth-type-metadata.ts` — add a NEW field `phaseTier: 'common' | 'enterprise' | 'advanced'` on each `AUTH_TYPE_METADATA` entry. **Do not** reuse the existing `category: 'basic' | 'oauth' | 'none'` field — that field stays as-is for backward compat with the 8 existing metadata entries (resolves H-2). The new `phaseTier` is what `AuthProfileAssignment` reads to render the categorized type-selector per D-15.
5.10 Migrate one or two `AuthProfilePicker` callers to `AuthProfileAssignment` as a smoke test (e.g., HTTP tool config + integration node config). Other 6 callers stay on the existing picker (D-10 incremental migration).
5.11 Author UI unit tests for `AuthProfileAssignment` (FR-15 selectable=false rendering, FR-18 inline-Add path, FR-20 encryption path) and `RevokeUserTokensConfirm`.
5.12 Author all 8 E2E spec files per test spec E2E-8..E2E-15 in `apps/studio/e2e/auth-profiles/`. Each runs against real Express + MongoMemoryServer + ioredis-mock + DI-stubbed OAuth providers.
5.13 Final integration run: full `pnpm test:report` to capture failure log; fix from `test-reports/SUMMARY.md`.

**Files Touched** (split into 2-3 commits — UI components + E2E tests + caller migration. Stay ≤ 40 files per commit, ≤ 3 packages — all in `apps/studio`):

- New: 6 components (AuthProfileAssignment, AuthProfileAuthorizationBadge, RevokeProfileConfirm, RevokeUserTokensConfirm, SensitiveFieldChangeAdvisory, ActivityTabPanel)
- New: 2 component test files (AuthProfileAssignment, RevokeUserTokensConfirm)
- New: 8 E2E spec files (E2E-8 .. E2E-15)
- Modified: AuthProfileSlideOver, AuthProfilesPage, auth-type-metadata, 1-2 AuthProfilePicker callers (HTTP tool, integration node)
- Modified: existing UI tests where they assert DOM structure that changed in slide-over

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` passes
- [ ] `pnpm test --filter=studio` passes
- [ ] All 8 ABLP-913 E2E specs pass on local stack and CI
- [ ] All 23 ABLP-913 FRs traceable to implementations + tests (cross-check against test spec coverage matrix)
- [ ] No `vi.mock` of `@agent-platform/*` or `@abl/*` in any new test file (CLAUDE.md "Test Architecture")
- [ ] Sanitization spot-check: E2E-15 asserts user-visible message contains no tenantId, profileId, scope names
- [ ] Visual regression: AuthProfileSlideOver retains existing layout; new tabs use existing tab pattern
- [ ] `npx prettier --write` run; lint-staged passes
- [ ] `pnpm test:report` produces `test-reports/SUMMARY.md` with zero failures

**Test Strategy**:

- Unit: component-level (AuthProfileAssignment dropdown shape, RevokeUserTokensConfirm preview payload rendering).
- Integration: covered in Phase 4.
- **E2E: 8 scenarios — full HTTP-only against real Express + MongoMemoryServer + ioredis-mock + DI-stubbed OAuth providers. No mocks of platform code.**

**Rollback**: Hide new UI elements behind feature flag in slide-over (`SHOW_ACTIVITY_TAB`, `SHOW_NEW_REVOKE_FLOWS`) — set to false to revert UX while server-side new endpoints still work. Migrated `AuthProfilePicker` callers can be reverted to existing picker independently.

**Dependencies**: Phase 4 (API routes available).

---

### Phase 6: 2026-05-09 Meeting Deltas

**Goal**: Apply the 6 design overrides + 3 deferrals from the 2026-05-09 review meeting on top of Phases 1-5. Also fix the 3 known test regressions surfaced at end of Phase 5.

**Tasks**:

6.1 **Preflight degrades to JIT (FR-12 update)**: in `apps/runtime/src/services/auth-profile/session-scanner.ts`, change Preflight handling — instead of `requiresUpfrontConsent: true` being a blocking condition, render Preflight prompts BUT on user decline / failure, downgrade that profile entry to `deferredUntilFirstUse: true` (JIT behavior) and continue. Only Preconfigured refresh failures remain blocking. Update `SessionScanResult` type to include a `degradedFromPreflight: profileId[]` array for observability.

6.2 **Force-invalidate to P0 (FR-26 update)**:
(a) `apps/runtime/src/config/index.ts` — flip `authProfileSessionScanEnabled` default to `true` (was OFF for safe deploy; now ON since the design is stable). Add `authProfileForceInvalidateEnabled: true` (default ON).
(b) `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-user-tokens/route.ts` — always publish `auth-profile:invalidate` (remove flag check if any).
(c) `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts` — always publish.
(d) `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/force-invalidate/route.ts` — remove flag-gated 503 path; always publish.
(e) Verify Phase 3 `ForceInvalidateSubscriber` boots unconditionally on runtime startup (already true).

6.3 **Remove inline-Add (FR-20 retraction; FR-18 update)**:
(a) `apps/studio/src/components/auth-profiles/AuthProfileAssignment.tsx` — remove the "Add value inline" / `inlineMode` UI option. Keep only the saved-profile dropdown + "Create Auth Profile" CTA. Step 2 for simple types is now identical to complex types.
(b) Add a prominent "Create Auth Profile" entry in the dropdown (always visible — not just empty state) per meeting nudge guidance.
(c) `packages/shared/src/services/auth-profile/inline-host-cleanup.ts` — function stays for legacy cleanup but emit a `log.warn` if called with new tools (deprecated path).
(d) Schema fields `inlineHostedTool` remain in the model for migration neutrality (already on disk in Phase 1) but service-layer `create()` MUST reject incoming `inlineHostedTool` payloads — return 400 `AUTH_PROFILE_INLINE_DEPRECATED`.

6.4 **Integration catalog (FR-10 update)**:
(a) NEW `packages/shared/src/services/auth-profile/integration-catalog.ts` — static array `INTEGRATION_CATALOG` of supported vendors with `{ connector, displayName, iconKey, defaultScopes, knownAuthorizationUrl, knownTokenUrl, knownRefreshUrl }`. Seed entries for Salesforce, Google, GitHub, Slack, HubSpot, Microsoft, Zendesk, Jira, ServiceNow (and any others currently in `auth-type-metadata.ts`). Export `getIntegrationCatalog()`.
(b) `apps/studio/src/app/api/projects/[id]/auth-profiles/integrations/route.ts` — left-join the static catalog with existing-profile vendor groups so vendors with `profileCount: 0` appear. Each vendor card payload: `{ connector, displayName, iconKey, profileCount, profiles: [], configureHref: "/projects/<id>/auth-profiles?connector=<connector>" }`.
(c) `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx` (or current Integrations tab component) — render zero-profile vendors with a primary "Configure" CTA. Existing-profile vendors keep "Authorize" + "Configure" CTAs.

6.5 **OAuth callback error mapping (FR-32 NEW)**:
(a) NEW `packages/shared/src/services/auth-profile/oauth-error-map.ts` — function `mapOAuthError(providerError: { code, description?, redirectUri? }): { adminMessage, code }` that maps known OAuth error codes (`redirect_uri_mismatch`, `invalid_client`, `invalid_grant`, `access_denied`, `unauthorized_client`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`) to actionable admin-visible messages.
(b) `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` — wrap provider error response handling with `mapOAuthError`. On error: emit `authorize_failed` audit event with full provider context; return mapped admin-visible message in route response (still sanitized for end-user surfaces — the message goes back to Studio admin UI, not to the SDK).
(c) Studio UI `AuthProfileOAuthDialog.tsx` — surface the mapped error message in the dialog instead of "operation failed".

6.6 **Connector-pre-filter (?connector=)**:
(a) `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx` — extend the existing `?authType=` query-param read to also honor `?connector=<vendor>`. Apply both filters when both present.
(b) Verify the Integrations tab "Configure" CTA constructs the URL with `?connector=<vendor>` — already specified in 6.4(b).

6.7 **ConnectorConnection deprecation marker (FR-33)**:
(a) `packages/database/src/models/connector-connection.model.ts` — add a docstring header: "DEPRECATED 2026-05-09: ConnectorConnection is now a binding-only artifact. Workflow integration nodes resolve credentials directly via authProfileId. Full removal tracked in follow-up ticket. DO NOT introduce new code paths that rely on this model for credential resolution."
(b) Audit existing imports of `ConnectorConnection` across `apps/studio/`, `apps/runtime/`, `packages/shared/` — flag any credential-resolution paths that still go through it. Where found, route them to `authProfileId` directly. Where the binding role is genuinely needed (legacy connector-config UI), leave the model in place but add a `// TODO(connector-deprecation):` comment with the follow-up ticket reference.

6.8 **Test regression fixes** (surfaced at end of Phase 5 implementation):
(a) `apps/studio/src/__tests__/auth-profile-oauth-callback-route.test.ts` — update mocks for the new `findOne` filter shape `{tenantId, projectId, userId, provider}` and the new `create` payload that includes `projectId` + `profileId`.
(b) `apps/studio/src/__tests__/auth-profile-consumers-routes.test.ts` (2 failing tests) — update for the extended consumers payload that now includes `tools` (ToolDefinition) + `a2aServers` (gated) + the existing 6 entity types.
(c) Investigate `api-project-io-roundtrip.test.ts` and `api-import-revert-route.test.ts` regressions — likely caused by model changes to `auth-profile.model.ts` (new fields like `profileType`, `inlineHostedTool`, `lastAuthorizedAt`, `lastAuthorizedBy`). Update fixtures or roundtrip expectations.

6.9 **Test architecture fix** (Phase 2 deviation — tests use `vi.mock('@agent-platform/database/models')`):

- For each affected test file (`audit-event-emitter.test.ts`, `blast-radius-aggregator.test.ts`, `is-authorized.test.ts`), refactor to use MongoMemoryServer + dependency-injected service constructors. Remove `vi.mock` of `@agent-platform/database/models`. Pure-function tests (`scope-insufficient-detector.test.ts`) already need no mocks.

  6.10 **Documentation deferrals**: confirm the deferral notes in feature spec gaps (GAP-22 session-init optimization, GAP-23 trigger scopes docs, GAP-24 A2A profile spec, GAP-25 shared credentials) are linked back to follow-up tickets when those tickets are filed. The follow-up ticket links are added by the user after meeting next-steps complete.

**Files Touched**:

- New: `packages/shared/src/services/auth-profile/integration-catalog.ts`
- New: `packages/shared/src/services/auth-profile/oauth-error-map.ts`
- New: `packages/shared/src/__tests__/auth-profile/integration-catalog.test.ts`
- New: `packages/shared/src/__tests__/auth-profile/oauth-error-map.test.ts`
- Modified: `apps/runtime/src/services/auth-profile/session-scanner.ts` — preflight fallback + `degradedFromPreflight[]`
- Modified: `apps/runtime/src/config/index.ts` — flag defaults
- Modified: `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts`
- Modified: `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke-user-tokens/route.ts`
- Modified: `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/force-invalidate/route.ts`
- Modified: `apps/studio/src/app/api/projects/[id]/auth-profiles/integrations/route.ts` — catalog left-join
- Modified: `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` — `mapOAuthError`
- Modified: `apps/studio/src/components/auth-profiles/AuthProfileAssignment.tsx` — remove inline-Add, add nudge
- Modified: `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx` — `?connector=` pre-filter
- Modified: `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` — show mapped error
- Modified: `apps/studio/src/components/auth-profiles/IntegrationAuthTab.tsx` — zero-profile vendor cards
- Modified: `packages/database/src/models/connector-connection.model.ts` — DEPRECATED docstring
- Modified: `packages/shared/src/services/auth-profile.service.ts` — reject `inlineHostedTool` on create
- Modified: existing tests:
  - `apps/studio/src/__tests__/auth-profile-oauth-callback-route.test.ts`
  - `apps/studio/src/__tests__/auth-profile-consumers-routes.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-project-io-roundtrip.test.ts`
  - `apps/studio/src/__tests__/api-routes/api-import-revert-route.test.ts`
  - `packages/shared/src/__tests__/auth-profile/audit-event-emitter.test.ts` — refactor to MongoMemoryServer
  - `packages/shared/src/__tests__/auth-profile/blast-radius-aggregator.test.ts` — refactor to MongoMemoryServer
  - `packages/shared/src/__tests__/auth-profile/is-authorized.test.ts` — refactor to MongoMemoryServer

**Exit Criteria**:

- [x] `pnpm build` passes for the monorepo (2026-05-13)
- [ ] Full `pnpm test` passes after the known `@agent-platform/shared-auth` scope-registry mismatch on `origin/develop` is resolved
- [ ] Preflight scenario test: declined Preflight prompt does NOT block session start; tool call later triggers JIT prompt for the same profile
- [ ] Force-invalidate test: revoke (any of the 3 endpoints) publishes `auth-profile:invalidate` and runtime pod evicts cache within < 100ms (ioredis-mock)
- [ ] Inline-Add UI option removed; `AuthProfileAssignment` test asserts only "Create Auth Profile" + dropdown
- [ ] Service test asserts `create({ inlineHostedTool: {...} })` returns 400 `AUTH_PROFILE_INLINE_DEPRECATED`
- [ ] `/integrations` payload includes vendors with `profileCount: 0`; integration test seeds 1 Salesforce profile and asserts ≥ 5 zero-profile vendors are also returned
- [ ] OAuth-error map test covers all 9 known error codes + fallback for unknown codes
- [ ] `AuthProfilesPage` honors both `?authType=` and `?connector=` query params
- [ ] Test files no longer `vi.mock` `@agent-platform/database/models`; CLAUDE.md "Test Architecture" rule complied with
- [ ] `connector-connection.model.ts` carries the DEPRECATED docstring; audit notes filed against any credential-resolution paths still using `ConnectorConnection`

**Test Strategy**:

- Unit: `oauth-error-map.test.ts` (pure function); `integration-catalog.test.ts` (catalog shape).
- Integration: `/integrations` left-join with seeded data; preflight degrade-to-JIT scenario in `session-scanner.test.ts`; force-invalidate publish on each revoke endpoint.
- E2E: existing E2E-12 (session-init), E2E-13 (revoke), E2E-14 (force-invalidate) updated to assert the new behavior.

**Rollback**: Each task is independently revertible. Most-impactful: 6.2 force-invalidate to P0 — ops can flip the env flag back to OFF if pub/sub becomes a hotspot. Preflight fallback (6.1) is a behavior change with no schema impact — reverting only requires reverting the scanner code.

**Dependencies**: Phases 1-5 complete. Phase 6 fits between Phase 5 and Phase 7 / `/post-impl-sync`.

---

## 4. Wiring Checklist

> CRITICAL: Every new component must be wired into its callers. This is the #1 agent failure mode.

- [ ] **Phase 1**: `auth_profile_audit_events` model exported from `packages/database/src/index.ts`. **ModelRegistry registration**: only required if SearchAI or other dual-DB consumers need lazy access — match the pattern used by the existing `AuthProfile` model (which does NOT use ModelRegistry). If no dual-DB consumer needs the new collection, skip registration and import the model directly. Confirm by grepping for any SearchAI or worker code that would need cross-DB lookup of audit events; default = skip registration (resolves H-3).
- [ ] **Phase 1**: Both migration scripts registered in `packages/database/src/migrations/registry.ts`.
- [ ] **Phase 1**: `cascade-delete.ts` mocks updated in **all three** test files per `packages/database/agents.md`.
- [ ] **Phase 2**: New shared services exported from `packages/shared/src/services/auth-profile/index.ts`.
- [ ] **Phase 2**: `AuthProfileService` returns `isAuthorized` field in list/get; route handlers in Phase 4 read it (downstream verification).
<!-- OAuth callback write happens in Phase 4 (Studio route), not Phase 2. See Phase 4 wiring item below. -->
- [ ] **Phase 3**: `ForceInvalidateSubscriber` boots in `apps/runtime/src/server.ts` startup; deregisters on graceful shutdown.
- [ ] **Phase 3**: `AuthProfileSessionScanner.scan()` called in session bootstrap **before** the first tool dispatch when `AUTH_PROFILE_SESSION_SCAN_ENABLED=true`.
- [ ] **Phase 3**: `ScopeInsufficientDetector` wired in `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` around provider response handling.
- [ ] **Phase 3**: Trace events `auth_profile.session_init.scan_completed`, `auth_profile.session_init.preconfigured_resolved`, `auth_profile.session_init.refresh_failed`, `auth_profile.cache_invalidated`, `auth_profile.scope_insufficient` all registered with `AUTH_PROFILE_TRACE_EVENTS` constants (5 events per HLD §9.4 #8).
- [ ] **Phase 3**: Health probes for audit-events write-path and subscriber-alive added to `checkAuthProfileHealth()`.
- [ ] **Phase 3**: Alert evaluator dimensions `revoke_user_tokens_per_minute`, `scope_insufficient_per_hour` registered.
- [ ] **Phase 4**: All 5 new route files exist at the documented paths (Next.js file-based routing auto-mounts them).
- [ ] **Phase 4**: `apps/studio/src/api/auth-profiles.ts` exports typed wrappers for the 5 new endpoints; wrappers consumed by Phase 5 components.
- [ ] **Phase 4**: New routes use existing project-scope middleware; verified by reading the route handler imports.
- [ ] **Phase 4**: `auth_profile_audit_events` queries scoped by `{tenantId, projectId, profileId}` in every read path.
- [ ] **Phase 4**: OAuth callback + user-consent both write `projectId` + `profileId` into `EndUserOAuthToken`; `upsertOAuthGrant()` lookup uses `{tenantId, projectId, userId, provider}` matching the new partial unique index.
- [ ] **Phase 4**: Revoke endpoints publish to Redis `auth-profile:invalidate` channel via `force-invalidate-publisher`.
- [ ] **Phase 5**: `AuthProfileSlideOver` imports and renders `AuthProfileAuthorizationBadge`, Activity tab, revoke modals, sensitive-field advisory toast — verified by reading the JSX tree.
- [ ] **Phase 5**: Two `AuthProfilePicker` callers migrated to `AuthProfileAssignment` (HTTP tool config + integration node config). Remaining 6 callers stay on existing picker.
- [ ] **Phase 5**: All 8 E2E spec files imported by the e2e runner config and reachable via `pnpm test:e2e`.
<!-- Removed: existing auth-profile components are imported directly by file path; no barrel export pattern in this folder. New components follow the same direct-import convention. -->
- [ ] **Phase 5**: New components imported directly by file path from their callers (no barrel export required — matches existing pattern).
- [ ] **Phase 5**: `AuthProfilesPage` reads `?authType=…` query param on mount.

---

## 5. Cross-Phase Concerns

### Database Migrations

Two migration scripts run in order via the migration runner (Redis-locked, idempotent, reversible). Execution sequence:

1. `20260508_019_auth_profile_profile_type` — backfills `profileType` from `connector` presence on every existing `auth_profiles` row. Idempotent (skips rows that already have `profileType`). Rollback unsets the field.
2. `20260508_020_end_user_oauth_token_project_scope` — adds `projectId` + `profileId` (best-effort backfill per the three cases), drops the old unique index, creates new partial unique + partial secondary indexes. Rollback restores the old index and clears the new fields.

The migration runner already enforces Redis lock and checksum per `packages/database/agents.md`. Run via the existing CLI: `pnpm migrate:up` (existing command).

### Feature Flags

| Flag                                    | Default                         | Purpose                                                        |
| --------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| `AUTH_PROFILE_SESSION_SCAN_ENABLED`     | OFF during deploy, ON post-bake | Gate for `AuthProfileSessionScanner`; rollback by toggling off |
| `AUTH_PROFILE_A2A_CONSUMERS_ENABLED`    | OFF                             | Gate for A2A consumer query (until `A2AServer` model lands)    |
| `AUTH_PROFILE_FORCE_INVALIDATE_ENABLED` | OFF (P2 phase 6)                | Gate for force-invalidate publisher; not in P0/P1 scope        |

**Flag locations (resolves M-4)**:

- Runtime flags (`AUTH_PROFILE_SESSION_SCAN_ENABLED`, `AUTH_PROFILE_FORCE_INVALIDATE_ENABLED`): defined in `apps/runtime/src/config/index.ts` `FeatureFlagsSchema`.
- Studio flags (`AUTH_PROFILE_A2A_CONSUMERS_ENABLED`): read directly from `process.env` in the affected route handler at request time, falling back to a sensible default (OFF).

`packages/config/src/constants.ts` is **port and shared-constant** territory, not feature flags — do not put feature flags there.

### Configuration Changes

- `STUDIO_OAUTH_ALLOWED_ORIGINS`: unchanged.
- `ENCRYPTION_MASTER_KEY`: unchanged.
- New flags above (env-based; documented in feature spec §11).

### Trace Event Catalog Updates

New event names added to `AUTH_PROFILE_TRACE_EVENTS` constant:

- `auth_profile.session_init.scan_completed`
- `auth_profile.session_init.preconfigured_resolved`
- `auth_profile.session_init.refresh_failed`
- `auth_profile.cache_invalidated` (with `reason: 'force' | 'ttl'`)
- `auth_profile.scope_insufficient`

---

## 6. Acceptance Criteria (Whole Feature)

- [x] Core implementation phases complete with 2026-05-13 review hardening applied
- [ ] All 8 E2E scenarios from test spec passing (E2E-8 through E2E-15)
- [ ] All 18-20 integration scenarios from test spec passing (INT-9 through INT-31, including a/b variants)
- [ ] Both migration tests passing (MIG-1, MIG-2) in the full package run
- [x] `pnpm build` passes (2026-05-13)
- [x] Focused shared, Studio, and runtime auth-profile regression suites pass (77 tests, 2026-05-13)
- [ ] Full `pnpm test` is green after the known `@agent-platform/shared-auth` platform-key scope registry mismatch on `origin/develop` is resolved
- [x] Feature spec updated with implementation file paths via post-implementation sync
- [ ] Testing matrix in test spec shows strict E2E execution evidence for all ABLP-913 FRs
- [ ] `tools/run-semgrep.sh` passes for all touched files
- [ ] Cross-tenant 404, cross-project 404, cross-user isolation all verified by integration tests
- [ ] No `vi.mock` of `@agent-platform/*` or `@abl/*` in any new test file
- [ ] `npx prettier --write` run on all touched files; pre-commit hook passes
- [ ] All commits follow `[ABLP-913] <type>(<scope>): <description>` format
- [ ] Each commit ≤ 40 non-doc files, ≤ 3 packages, < 30% deletion ratio for `feat()` commits

---

## 7. Open Questions

1. **A2A model existence** — The `A2AServer` Mongoose model does not currently exist (per gap-map and HLD OQ-7). Phase 4 task 4.6 ships the consumer query gated by `AUTH_PROFILE_A2A_CONSUMERS_ENABLED` (default OFF). When the A2A model lands in a separate ticket, flip the flag and remove the warning branch. Any blocker? Confirm with platform owners before merging Phase 4.
2. **`auth_profile:authorize` permission** — Open Question 9 in feature spec; Phase 4 reuses `auth_profile:write` for the new Authorize CTA. A follow-up RBAC ticket will introduce a finer-grained permission. Confirm with Platform Security before Phase 5 ships to a tenant with strict RBAC.
3. ~~OAuth callback exact path~~ — **RESOLVED** (round-1 review): the OAuth grant write lives in the Studio route at `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` (function `upsertOAuthGrant()` at line 78). It is NOT in shared services. See Phase 4 task 4.9.
4. ~~Force-invalidate replay protection~~ — **RESOLVED** during Phase 3 design (task 3.3 update). `cache.invalidate()` is idempotent (invalidating an already-evicted entry is a no-op), so no dedupe window is needed.
5. **Legacy inlineHostedTool cleanup** — Inline-Add creation is removed. If real legacy rows exist, decide whether to delete with owner tools, migrate, or promote them to saved profiles.

---

## 8. References

- Feature spec: [docs/features/auth-profiles.md](../features/auth-profiles.md)
- Test spec: [docs/testing/auth-profiles.md](../testing/auth-profiles.md)
- HLD: [docs/specs/auth-profiles.hld.md](../specs/auth-profiles.hld.md) (§9)
- SDLC logs: `docs/sdlc-logs/auth-profiles/{feature-spec,test-spec,hld}.log.md`
- ABLP-913: <https://koreteam.atlassian.net/browse/ABLP-913>
- Existing LLD (FR-1..FR-8 baseline): [docs/plans/auth-profiles.lld.md](auth-profiles.lld.md)
- CLAUDE.md (platform invariants, test architecture, commit discipline): repo root
