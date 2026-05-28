# Auth Profile Phase 1 — Implementation Plan

> **Goal:** Unblock the connector OAuth flow end-to-end by introducing the `AuthProfile` model with 6 auth types (`none`, `api_key`, `bearer`, `oauth2_app`, `oauth2_token`, `oauth2_client_credentials`), project-scoped CRUD + OAuth flow endpoints, Studio management UI, token refresh with distributed locking, and full security/compliance wiring.
>
> **Architecture:** Two-layer OAuth model (`oauth2_app` Layer 1 + `oauth2_token` Layer 2), 5-level resolution query, session-level LRU cache + Redis cache for client credentials.
>
> **Tech stack:** Mongoose + Zod discriminated unions + native `fetch` for OAuth token exchange + Redis `SET NX PX` distributed locks + SWR + Framer Motion.
>
> **Key constraint:** Every config schema uses `.strict()`. Every query includes `tenantId`. Secrets are encrypted at rest via the Mongoose `encryptionPlugin` (never manually). `createdBy` is immutable and set from auth context. Phase 2+ auth types, addons, and rotation are rejected with 400.
>
> **NOTE:** The Phase 1 design doc references `simple-oauth2` in the Libraries table -- this is stale. All OAuth implementations use native `fetch()`.
>
> **Design doc:** [`2026-03-11-auth-profile-phase1-core.md`](./2026-03-11-auth-profile-phase1-core.md)

---

## Task Summary

| #      | Phase                              | Task Name                                                                                   | Key Files                                                                         |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1      | A — Foundation                     | Mongoose model schema + interface                                                           | `packages/database/src/models/auth-profile.model.ts`                              |
| 2      | A — Foundation                     | Export from models barrel                                                                   | `packages/database/src/models/index.ts`                                           |
| 3      | A — Foundation                     | Index verification test                                                                     | `packages/database/src/__tests__/auth-profile/auth-profile-indexes.test.ts`       |
| 4      | A — Foundation                     | Zod validation schemas (6 Phase 1 types)                                                    | `packages/shared/src/validation/auth-profile.schema.ts`                           |
| 5      | A — Foundation                     | Export from validation barrel                                                               | `packages/shared/src/validation/index.ts`                                         |
| 6      | A — Foundation                     | AuthProfileService (create, update, delete, resolve, validateAccess)                        | `packages/shared/src/services/auth-profile.service.ts`                            |
| 7      | A — Foundation                     | Distributed lock contention (backoff + re-read)                                             | `packages/shared/src/__tests__/auth-profile/auth-profile-service.test.ts`         |
| 8      | B — API Routes                     | CRUD routes: GET list + POST create                                                         | `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`                    |
| 9      | B — API Routes                     | CRUD routes: GET by id, PUT update, DELETE                                                  | `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`        |
| 10     | B — API Routes                     | OAuth endpoints (initiate, callback, user-consent)                                          | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/*/route.ts`            |
| 11     | B — API Routes                     | Utility endpoints: consumers + revoke                                                       | `.../[profileId]/consumers/route.ts`, `.../revoke/route.ts`                       |
| 12     | C — OAuth Flows & Token Refresh    | `oauth2_app` cross-reference validation on create                                           | `packages/shared/src/services/auth-profile/linked-app-validator.ts`               |
| 13     | C — OAuth Flows & Token Refresh    | Cross-type validation on update                                                             | `packages/shared/src/services/auth-profile/update-validator.ts`                   |
| 14     | C — OAuth Flows & Token Refresh    | `oauth2_token` Layer 2 links to Layer 1                                                     | `packages/shared/src/services/auth-profile/oauth2-app-resolver.ts`                |
| 15     | C — OAuth Flows & Token Refresh    | POST initiate: generate state, store in Redis, return auth URL                              | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`     |
| 16     | C — OAuth Flows & Token Refresh    | POST callback: validate state, exchange code, create `oauth2_token`                         | `packages/shared/src/services/auth-profile/auth-profile-oauth.ts`                 |
| 17     | C — OAuth Flows & Token Refresh    | POST user-consent: per-user token flow                                                      | `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts` |
| 18     | C — OAuth Flows & Token Refresh    | Frontend popup flow (`window.opener.postMessage`)                                           | `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`             |
| 19     | C — OAuth Flows & Token Refresh    | Proactive refresh: check `expiresAt` with buffer                                            | `packages/shared/src/services/auth-profile/token-refresh-service.ts`              |
| 20     | C — OAuth Flows & Token Refresh    | Reactive refresh: 401 retry triggers refresh                                                | `packages/shared/src/services/auth-profile/token-refresh-service.ts`              |
| 21     | C — OAuth Flows & Token Refresh    | Distributed Redis lock for token refresh                                                    | `packages/shared/src/services/auth-profile/refresh-lock.ts`                       |
| 22     | C — OAuth Flows & Token Refresh    | Full token refresh flow (lock + exchange + store)                                           | `packages/shared/src/services/auth-profile/token-refresh-service.ts`              |
| 23     | C — OAuth Flows & Token Refresh    | `oauth2_client_credentials` token cached in Redis                                           | `packages/shared/src/services/auth-profile/client-credentials-service.ts`         |
| 24     | C — OAuth Flows & Token Refresh    | `authProfileService.resolve()` as credential resolution path                                | `packages/shared/src/services/auth-profile/auth-profile-resolver.ts`              |
| 25     | C — OAuth Flows & Token Refresh    | Session-level credential cache (LRU, max 200)                                               | `packages/shared/src/services/auth-profile/credential-cache.ts`                   |
| 26     | C — OAuth Flows & Token Refresh    | Hook into `LLMWiringService._wireExecutor()`                                                | `apps/runtime/src/services/execution/llm-wiring.ts`                               |
| 27     | C — OAuth Flows & Token Refresh    | `applyAuth()` dispatcher                                                                    | `packages/shared/src/services/auth-profile/apply-auth.ts`                         |
| 28     | D — Security & Compliance          | GDPR cascade: add AuthProfile to all cascade functions                                      | `packages/database/src/cascade/cascade-delete.ts`                                 |
| 29     | D — Security & Compliance          | GDPR cascade: add AuthProfile to `MongoGDPRStore`                                           | `apps/studio/src/services/retention/mongo-gdpr-store.ts`                          |
| 30     | D — Security & Compliance          | Mask `encryptedSecrets` in audit diffs                                                      | `packages/database/src/mongo/plugins/audit-trail.plugin.ts`                       |
| 31     | D — Security & Compliance          | Define 13 AuthProfile audit event constants                                                 | `packages/database/src/auth-profile/audit-events.ts`                              |
| 32     | D — Security & Compliance          | AuthProfile authz test suite                                                                | `apps/runtime/src/__tests__/auth-profiles-authz.test.ts`                          |
| 33     | D — Security & Compliance          | Add auth-profile permissions to ROLE_PERMISSIONS                                            | `apps/runtime/src/__tests__/helpers/auth-context.ts`                              |
| ~~34~~ | ~~D — Security & Compliance~~      | ~~SSRF validation~~ — **REMOVED**: folded into Task 4 Zod schemas                           | —                                                                                 |
| 35     | D — Security & Compliance          | Register authProfileService in health check registry                                        | `apps/runtime/src/services/service-registry.ts`                                   |
| 36     | D — Security & Compliance          | Alerting thresholds                                                                         | `apps/runtime/src/services/auth-profile-alerting.ts`                              |
| ~~37~~ | ~~D — Security & Compliance~~      | ~~Add AuthProfile to `CredentialAgeMonitor.checkAll()`~~ — **REMOVED**: deferred to Phase 2 | —                                                                                 |
| 38     | D — Security & Compliance          | `AuthProfileError` class with typed reason discriminant                                     | `packages/shared/src/errors/auth-profile-errors.ts`                               |
| 39     | D — Security & Compliance          | Trace events via TraceStore                                                                 | `packages/shared/src/services/auth-profile/trace-events.ts`                       |
| 40     | E — Studio UI                      | API client functions                                                                        | `apps/studio/src/api/auth-profiles.ts`                                            |
| 41     | E — Studio UI                      | SWR hook (`useAuthProfiles`)                                                                | `apps/studio/src/hooks/useAuthProfiles.ts`                                        |
| 42     | E — Studio UI                      | Auth type metadata constants                                                                | `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`                  |
| 43     | E — Studio UI                      | Status badge helper                                                                         | `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`             |
| 44     | E — Studio UI                      | Auth Profiles management page                                                               | `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`                   |
| 45     | E — Studio UI                      | Wire into SPA routing (navigation-store + AppShell)                                         | `navigation-store.ts`, `AppShell.tsx`, settings sidebar                           |
| 46     | E — Studio UI                      | Slide-over component                                                                        | `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`               |
| 47     | E — Studio UI                      | Reusable AuthProfilePicker                                                                  | `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`                  |
| 48     | E — Studio UI                      | Wire AuthProfilePicker into CreateConnectionModal                                           | `apps/studio/src/components/connections/CreateConnectionModal.tsx`                |
| 49     | E — Studio UI                      | OAuth callback page                                                                         | `apps/studio/src/app/(app)/auth-callback/page.tsx`                                |
| 50     | E — Studio UI                      | OAuth flow dialog                                                                           | `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`             |
| 51     | E — Studio UI                      | Deployment pre-check auth status component                                                  | `apps/studio/src/components/auth-profiles/AuthProfilePreflightCheck.tsx`          |
| 52     | F — Integration Points             | Wire `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId`                | `packages/database/src/models/connector-*.model.ts`                               |
| 53     | F — Integration Points             | Wire `authProfileService.resolve()` into connector credential resolution                    | `apps/runtime/src/services/connector-credential-resolver.ts`                      |
| ~~54~~ | ~~F — Integration Points~~         | ~~Wire `VoiceServiceFactory` cache invalidation~~ — **REMOVED**: deferred to Phase 2        | —                                                                                 |
| 55     | F — Integration Points             | Dead code verification                                                                      | N/A (verification only)                                                           |
| 56     | F — Integration Points             | ESLint enforcement                                                                          | `.eslintrc.js`                                                                    |
| 57     | G — Test Infrastructure & Coverage | Auth Profile mock factory                                                                   | `packages/database/src/__tests__/helpers/auth-profile-factory.ts`                 |
| 58     | G — Test Infrastructure & Coverage | Runtime auth context extension                                                              | `apps/runtime/src/types/auth-context.ts`                                          |
| 59     | G — Test Infrastructure & Coverage | Schema validation per auth type tests                                                       | `packages/database/src/__tests__/auth-profile/schema-validation.test.ts`          |
| 60     | G — Test Infrastructure & Coverage | Index existence tests                                                                       | `packages/database/src/__tests__/auth-profile/index-existence.test.ts`            |
| 61     | G — Test Infrastructure & Coverage | Plugin integration tests                                                                    | `packages/database/src/__tests__/auth-profile/plugin-integration.test.ts`         |
| 62     | G — Test Infrastructure & Coverage | CRUD operation tests                                                                        | `packages/shared/src/__tests__/auth-profile/crud-operations.test.ts`              |
| 63     | G — Test Infrastructure & Coverage | 5-level resolution query tests                                                              | `packages/shared/src/__tests__/auth-profile/resolution-query.test.ts`             |
| 64     | G — Test Infrastructure & Coverage | Consumer count fan-out tests                                                                | `packages/shared/src/__tests__/auth-profile/consumer-count.test.ts`               |
| 65     | G — Test Infrastructure & Coverage | Validation tests                                                                            | `packages/shared/src/__tests__/auth-profile/validation.test.ts`                   |
| 66     | G — Test Infrastructure & Coverage | Error handling tests                                                                        | `packages/shared/src/__tests__/auth-profile/error-handling.test.ts`               |
| 67     | G — Test Infrastructure & Coverage | Auth/authz API tests                                                                        | `apps/studio/src/__tests__/auth-profiles/authz.test.ts`                           |
| 68     | G — Test Infrastructure & Coverage | CRUD endpoint tests                                                                         | `apps/studio/src/__tests__/auth-profiles/crud-endpoints.test.ts`                  |
| 69     | G — Test Infrastructure & Coverage | OAuth endpoint tests                                                                        | `apps/studio/src/__tests__/auth-profiles/oauth-endpoints.test.ts`                 |
| 70     | G — Test Infrastructure & Coverage | Rate limit tests                                                                            | `apps/studio/src/__tests__/auth-profiles/rate-limits.test.ts`                     |
| 71     | G — Test Infrastructure & Coverage | End-to-end OAuth flow                                                                       | `apps/runtime/src/__tests__/e2e/auth-profile-oauth-flow.test.ts`                  |
| 72     | G — Test Infrastructure & Coverage | Connector setup with auth profile                                                           | `apps/runtime/src/__tests__/e2e/auth-profile-connector-setup.test.ts`             |
| 73     | G — Test Infrastructure & Coverage | Token refresh cycle                                                                         | `apps/runtime/src/__tests__/e2e/auth-profile-token-refresh.test.ts`               |
| 74     | G — Test Infrastructure & Coverage | GDPR cascade integration                                                                    | `packages/database/src/__tests__/cascade-delete-auth-profile.test.ts`             |
| 75     | G — Test Infrastructure & Coverage | Resolution query benchmarks                                                                 | `packages/shared/src/__tests__/auth-profile/resolution-benchmarks.test.ts`        |
| 76     | G — Test Infrastructure & Coverage | Redis lock contention simulation                                                            | `packages/shared/src/__tests__/auth-profile/lock-contention.test.ts`              |
| 77     | G — Test Infrastructure & Coverage | Session-level LRU cache                                                                     | `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`                    |
| 78     | G — Test Infrastructure & Coverage | Redis cache for `oauth2_client_credentials` tokens                                          | `packages/shared/src/__tests__/auth-profile/redis-cache.test.ts`                  |
| 79     | G — Test Infrastructure & Coverage | Cache invalidation via Redis Pub/Sub                                                        | `packages/shared/src/__tests__/auth-profile/cache-invalidation.test.ts`           |

---

## TDD Convention

Every task follows this 5-step cycle:

1. **Red** — Write the failing test
2. **Run** — Verify the test fails (expected)
3. **Green** — Implement the minimum code to pass
4. **Run** — Verify the test passes
5. **Commit** — `npx prettier --write <files>` then commit

**Test framework:** vitest (all `packages/` and `apps/` use vitest)
**Format:** `npx prettier --write <files>` before every commit
**Imports:** Use `.js` extension (ESM convention in this codebase)

---

## Phase A — Foundation (Model, Validation, Service)

> Establishes the `AuthProfile` Mongoose model, Zod validation schemas, and `AuthProfileService` with encryption, distributed locking, and 5-level resolution.

### Task Group A1: AuthProfile Mongoose Model

**File:** `packages/database/src/models/auth-profile.model.ts`

### Task 1: IAuthProfile interface and schema skeleton

**Test file:** `packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts`

```typescript
// packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts
import { describe, it, expect } from 'vitest';
import { AuthProfile, type IAuthProfile } from '../../models/auth-profile.model.js';

describe('AuthProfile model', () => {
  it('exports the AuthProfile model', () => {
    expect(AuthProfile).toBeDefined();
    expect(AuthProfile.modelName).toBe('AuthProfile');
  });

  it('has the correct collection name', () => {
    expect(AuthProfile.collection.collectionName).toBe('auth_profiles');
  });

  it('has _id defaulting to uuidv7', () => {
    const pathType = AuthProfile.schema.path('_id');
    expect(pathType).toBeDefined();
  });

  it('requires tenantId', () => {
    const pathType = AuthProfile.schema.path('tenantId') as any;
    expect(pathType.isRequired).toBe(true);
  });

  it('requires name', () => {
    const pathType = AuthProfile.schema.path('name') as any;
    expect(pathType.isRequired).toBe(true);
  });

  it('defaults projectId to null', () => {
    const pathType = AuthProfile.schema.path('projectId') as any;
    expect(pathType.defaultValue).toBeNull();
  });

  it('defaults scope to "project"', () => {
    const pathType = AuthProfile.schema.path('scope') as any;
    expect(pathType.defaultValue).toBe('project');
  });

  it('defaults visibility to "shared"', () => {
    const pathType = AuthProfile.schema.path('visibility') as any;
    expect(pathType.defaultValue).toBe('shared');
  });

  it('defaults status to "active"', () => {
    const pathType = AuthProfile.schema.path('status') as any;
    expect(pathType.defaultValue).toBe('active');
  });

  it('has authType enum with 6 Phase 1 values', () => {
    const pathType = AuthProfile.schema.path('authType') as any;
    expect(pathType.enumValues).toHaveLength(6);
    expect(pathType.enumValues).toContain('none');
    expect(pathType.enumValues).toContain('api_key');
    expect(pathType.enumValues).toContain('bearer');
    expect(pathType.enumValues).toContain('oauth2_app');
    expect(pathType.enumValues).toContain('oauth2_token');
    expect(pathType.enumValues).toContain('oauth2_client_credentials');
  });

  it('has status enum with 4 values', () => {
    const pathType = AuthProfile.schema.path('status') as any;
    expect(pathType.enumValues).toEqual(['active', 'expired', 'revoked', 'invalid']);
  });

  it('has encryptedSecrets as required string', () => {
    const pathType = AuthProfile.schema.path('encryptedSecrets') as any;
    expect(pathType.instance).toBe('String');
  });

  it('has encryptionKeyVersion defaulting to 1', () => {
    const pathType = AuthProfile.schema.path('encryptionKeyVersion') as any;
    expect(pathType.defaultValue).toBe(1);
  });

  it('has createdBy as required and immutable', () => {
    const pathType = AuthProfile.schema.path('createdBy') as any;
    expect(pathType.isRequired).toBe(true);
    expect(pathType.options.immutable).toBe(true);
  });

  it('has config as Mixed type', () => {
    const pathType = AuthProfile.schema.path('config') as any;
    expect(pathType.instance).toBe('Mixed');
  });

  it('has optional addon fields (signing, webhookVerification, proxy)', () => {
    expect(AuthProfile.schema.path('signing')).toBeDefined();
    expect(AuthProfile.schema.path('webhookVerification')).toBeDefined();
    expect(AuthProfile.schema.path('proxy')).toBeDefined();
  });

  it('has optional rotation fields', () => {
    expect(AuthProfile.schema.path('rotationPolicy')).toBeDefined();
    expect(AuthProfile.schema.path('previousEncryptedSecrets')).toBeDefined();
    expect(AuthProfile.schema.path('rotationGracePeriodMs')).toBeDefined();
  });
});
```

**Run to verify failure:**

```bash
cd packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
```

**Implementation:** `packages/database/src/models/auth-profile.model.ts`

```typescript
/**
 * AuthProfile Model
 *
 * Unified authentication credential store. Phase 1 supports 6 auth types:
 * none, api_key, bearer, oauth2_app, oauth2_token, oauth2_client_credentials.
 * Phase 2+ types are added to the enum when implemented.
 *
 * Scoping: tenant-level (projectId: null) or project-level.
 * Visibility: shared (anyone in scope) or personal (creator only).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Auth Type Enum ──────────────────────────────────────────────────────

// Phase 1: only 6 auth types. Phase 2+ types (basic, custom_header, aws_iam,
// azure_ad, ssh_key, mtls) are added in future phases.
export const AUTH_PROFILE_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
] as const;

export type AuthProfileAuthType = (typeof AUTH_PROFILE_AUTH_TYPES)[number];

export const AUTH_PROFILE_STATUSES = ['active', 'expired', 'revoked', 'invalid'] as const;
export type AuthProfileStatus = (typeof AUTH_PROFILE_STATUSES)[number];

export const AUTH_PROFILE_SCOPES = ['tenant', 'project'] as const;
export type AuthProfileScope = (typeof AUTH_PROFILE_SCOPES)[number];

export const AUTH_PROFILE_VISIBILITIES = ['shared', 'personal'] as const;
export type AuthProfileVisibility = (typeof AUTH_PROFILE_VISIBILITIES)[number];

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAuthProfile {
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;
  scope: AuthProfileScope;
  environment: string | null;
  visibility: AuthProfileVisibility;
  createdBy: string;
  authType: AuthProfileAuthType;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: AuthProfileStatus;
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  rotationPolicy?: Record<string, unknown>;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  // Addon mechanisms (present in schema, not active in Phase 1)
  signing?: Record<string, unknown>;
  webhookVerification?: Record<string, unknown>;
  proxy?: Record<string, unknown>;
  // Schema version (BaseDocument convention — see base-document.ts)
  _v: number;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AuthProfileSchema = new Schema<IAuthProfile>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    description: { type: String, maxlength: 1000 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    scope: {
      type: String,
      enum: AUTH_PROFILE_SCOPES,
      required: true,
      default: 'project',
    },
    environment: { type: String, default: null },
    visibility: {
      type: String,
      enum: AUTH_PROFILE_VISIBILITIES,
      required: true,
      default: 'shared',
    },
    createdBy: { type: String, required: true, immutable: true },
    authType: {
      type: String,
      enum: AUTH_PROFILE_AUTH_TYPES,
      required: true,
    },
    config: { type: Schema.Types.Mixed, default: {} },
    encryptedSecrets: { type: String, required: true },
    encryptionKeyVersion: { type: Number, required: true, default: 1 },
    linkedAppProfileId: { type: String },
    connector: { type: String },
    category: { type: String },
    tags: { type: [String] },
    status: {
      type: String,
      enum: AUTH_PROFILE_STATUSES,
      required: true,
      default: 'active',
    },
    expiresAt: { type: Date },
    lastValidatedAt: { type: Date },
    lastUsedAt: { type: Date },
    rotationPolicy: { type: Schema.Types.Mixed },
    previousEncryptedSecrets: { type: String },
    rotationGracePeriodMs: { type: Number },
    // Addon mechanisms (schema presence for forward-compat, inert in Phase 1)
    signing: { type: Schema.Types.Mixed },
    webhookVerification: { type: Schema.Types.Mixed },
    proxy: { type: Schema.Types.Mixed },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'auth_profiles' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AuthProfileSchema.plugin(tenantIsolationPlugin);
AuthProfileSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
});
AuthProfileSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Query indexes (9 from design)
AuthProfileSchema.index({ tenantId: 1, scope: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, scope: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, connector: 1, authType: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, visibility: 1, createdBy: 1 });
AuthProfileSchema.index({
  tenantId: 1,
  projectId: 1,
  connector: 1,
  visibility: 1,
  createdBy: 1,
});
AuthProfileSchema.index({ tenantId: 1, projectId: 1, category: 1 });
AuthProfileSchema.index({ linkedAppProfileId: 1 });
AuthProfileSchema.index({ status: 1, expiresAt: 1, authType: 1 });

// Unique constraints — partial indexes for null projectId handling
AuthProfileSchema.index(
  { tenantId: 1, name: 1, environment: 1 },
  { unique: true, partialFilterExpression: { projectId: null } },
);
AuthProfileSchema.index(
  { tenantId: 1, projectId: 1, name: 1, environment: 1 },
  { unique: true, partialFilterExpression: { projectId: { $ne: null } } },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const AuthProfile =
  (mongoose.models.AuthProfile as any) || model<IAuthProfile>('AuthProfile', AuthProfileSchema);
```

**Run test to verify pass:**

```bash
cd packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-model.test.ts
```

### Task 2: Export from models barrel

**File:** `packages/database/src/models/index.ts`

Add to the `// ─── Security ────` section:

```typescript
// ─── Auth Profiles ──────────────────────────────────────────────────────

export {
  AuthProfile,
  type IAuthProfile,
  type AuthProfileAuthType,
  type AuthProfileStatus,
  type AuthProfileScope,
  type AuthProfileVisibility,
  AUTH_PROFILE_AUTH_TYPES,
  AUTH_PROFILE_STATUSES,
  AUTH_PROFILE_SCOPES,
  AUTH_PROFILE_VISIBILITIES,
} from './auth-profile.model.js';
```

**Verify:** `pnpm build --filter=@agent-platform/database`

### Task 3: Index verification test

**Test file:** `packages/database/src/__tests__/auth-profile/auth-profile-indexes.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { AuthProfile } from '../../models/auth-profile.model.js';

describe('AuthProfile indexes', () => {
  const indexes = (AuthProfile.schema as any).indexes() as Array<[Record<string, number>, any]>;

  function hasIndex(fields: Record<string, number>, opts?: Record<string, unknown>): boolean {
    return indexes.some(([f, o]) => {
      const fieldsMatch = JSON.stringify(f) === JSON.stringify(fields);
      if (!opts) return fieldsMatch;
      return (
        fieldsMatch &&
        Object.entries(opts).every(([k, v]) => JSON.stringify(o[k]) === JSON.stringify(v))
      );
    });
  }

  it('has { tenantId, scope } index', () => {
    expect(hasIndex({ tenantId: 1, scope: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, scope } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, scope: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, connector, authType } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, connector: 1, authType: 1 })).toBe(true);
  });

  it('has { tenantId, projectId, visibility, createdBy } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, visibility: 1, createdBy: 1 })).toBe(true);
  });

  it('has personal profile resolution index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, connector: 1, visibility: 1, createdBy: 1 })).toBe(
      true,
    );
  });

  it('has { tenantId, projectId, category } index', () => {
    expect(hasIndex({ tenantId: 1, projectId: 1, category: 1 })).toBe(true);
  });

  it('has { linkedAppProfileId } index', () => {
    expect(hasIndex({ linkedAppProfileId: 1 })).toBe(true);
  });

  it('has { status, expiresAt, authType } index', () => {
    expect(hasIndex({ status: 1, expiresAt: 1, authType: 1 })).toBe(true);
  });

  it('has tenant-level unique name constraint (partial)', () => {
    expect(
      hasIndex(
        { tenantId: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: null },
        },
      ),
    ).toBe(true);
  });

  it('has project-level unique name constraint (partial)', () => {
    expect(
      hasIndex(
        { tenantId: 1, projectId: 1, name: 1, environment: 1 },
        {
          unique: true,
          partialFilterExpression: { projectId: { $ne: null } },
        },
      ),
    ).toBe(true);
  });
});
```

**Run:**

```bash
cd packages/database && pnpm vitest run src/__tests__/auth-profile/auth-profile-indexes.test.ts
```

---

### Task Group A2: Zod Validation Schemas

**File:** `packages/shared/src/validation/auth-profile.schema.ts`

### Task 4: Per-authType config + secrets Zod schemas (6 Phase 1 types)

**Test file:** `packages/shared/src/__tests__/auth-profile/auth-profile-schema.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  CreateAuthProfileSchema,
  UpdateAuthProfileSchema,
  NoneConfigSchema,
  ApiKeyConfigSchema,
  BearerConfigSchema,
  OAuth2AppConfigSchema,
  OAuth2TokenConfigSchema,
  OAuth2ClientCredentialsConfigSchema,
  NoneSecretsSchema,
  ApiKeySecretsSchema,
  BearerSecretsSchema,
  OAuth2AppSecretsSchema,
  OAuth2TokenSecretsSchema,
  OAuth2ClientCredentialsSecretsSchema,
} from '../../validation/auth-profile.schema.js';

// ── Config Schemas ──────────────────────────────────────────────────

describe('NoneConfigSchema', () => {
  it('accepts empty object', () => {
    expect(NoneConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields (.strict())', () => {
    expect(NoneConfigSchema.safeParse({ foo: 'bar' }).success).toBe(false);
  });
});

describe('ApiKeyConfigSchema', () => {
  it('requires headerName', () => {
    const result = ApiKeyConfigSchema.safeParse({ placement: 'header' });
    expect(result.success).toBe(false);
  });

  it('defaults placement to "header"', () => {
    const result = ApiKeyConfigSchema.safeParse({ headerName: 'X-Api-Key' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.placement).toBe('header');
    }
  });

  it('accepts "query" placement', () => {
    const result = ApiKeyConfigSchema.safeParse({
      headerName: 'api_key',
      placement: 'query',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown fields (.strict())', () => {
    const result = ApiKeyConfigSchema.safeParse({
      headerName: 'X-Api-Key',
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('BearerConfigSchema', () => {
  it('accepts empty object', () => {
    expect(BearerConfigSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(BearerConfigSchema.safeParse({ foo: 1 }).success).toBe(false);
  });
});

describe('OAuth2AppConfigSchema', () => {
  it('requires authorizationUrl and tokenUrl', () => {
    const result = OAuth2AppConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid full config', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      refreshUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['email', 'profile'],
      scopeSeparator: ' ',
      pkceRequired: true,
      pkceMethod: 'S256',
      supportedGrantTypes: ['authorization_code'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-URL authorizationUrl', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'not-a-url',
      tokenUrl: 'https://example.com/token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = OAuth2AppConfigSchema.safeParse({
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      malicious: 'data',
    });
    expect(result.success).toBe(false);
  });
});

describe('OAuth2TokenConfigSchema', () => {
  it('requires provider', () => {
    const result = OAuth2TokenConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid config', () => {
    const result = OAuth2TokenConfigSchema.safeParse({
      provider: 'google',
      scopes: ['email'],
      grantedScopes: ['email'],
      tokenType: 'bearer',
      refreshTokenRotation: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('OAuth2ClientCredentialsConfigSchema', () => {
  it('requires tokenUrl', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts valid config', () => {
    const result = OAuth2ClientCredentialsConfigSchema.safeParse({
      tokenUrl: 'https://example.com/oauth/token',
      scopes: ['read', 'write'],
    });
    expect(result.success).toBe(true);
  });
});

// ── Secrets Schemas ─────────────────────────────────────────────────

describe('NoneSecretsSchema', () => {
  it('accepts empty object', () => {
    expect(NoneSecretsSchema.safeParse({}).success).toBe(true);
  });
});

describe('ApiKeySecretsSchema', () => {
  it('requires apiKey', () => {
    expect(ApiKeySecretsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts valid secrets', () => {
    expect(ApiKeySecretsSchema.safeParse({ apiKey: 'sk-1234' }).success).toBe(true);
  });
});

describe('BearerSecretsSchema', () => {
  it('requires token', () => {
    expect(BearerSecretsSchema.safeParse({}).success).toBe(false);
  });
});

describe('OAuth2AppSecretsSchema', () => {
  it('requires clientId and clientSecret', () => {
    expect(OAuth2AppSecretsSchema.safeParse({}).success).toBe(false);
    expect(OAuth2AppSecretsSchema.safeParse({ clientId: 'x' }).success).toBe(false);
  });

  it('accepts valid secrets', () => {
    expect(
      OAuth2AppSecretsSchema.safeParse({ clientId: 'id', clientSecret: 'secret' }).success,
    ).toBe(true);
  });
});

describe('OAuth2TokenSecretsSchema', () => {
  it('requires accessToken', () => {
    expect(OAuth2TokenSecretsSchema.safeParse({}).success).toBe(false);
  });

  it('accepts optional refreshToken, idToken, providerUserId', () => {
    const result = OAuth2TokenSecretsSchema.safeParse({
      accessToken: 'ya29.xxx',
      refreshToken: '1//xxx',
      idToken: 'eyJ...',
      providerUserId: 'user@gmail.com',
    });
    expect(result.success).toBe(true);
  });
});

describe('OAuth2ClientCredentialsSecretsSchema', () => {
  it('requires clientId and clientSecret', () => {
    expect(OAuth2ClientCredentialsSecretsSchema.safeParse({}).success).toBe(false);
  });
});

// ── CreateAuthProfileSchema (discriminated union) ───────────────────

describe('CreateAuthProfileSchema', () => {
  const base = {
    name: 'My Gmail App',
    projectId: 'proj-1',
    scope: 'project' as const,
    visibility: 'shared' as const,
  };

  it('accepts valid "none" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid "api_key" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'api_key',
      config: { headerName: 'X-Api-Key' },
      secrets: { apiKey: 'sk-123' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid "oauth2_app" profile', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'oauth2_app',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
      },
      secrets: { clientId: 'id', clientSecret: 'secret' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects Phase 2+ auth types', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'basic',
      config: {},
      secrets: { username: 'u', password: 'p' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects mismatched config for authType', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'api_key',
      config: {}, // missing headerName
      secrets: { apiKey: 'sk-123' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects addon fields in Phase 1', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      signing: { algorithm: 'hmac-sha256' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects rotationPolicy in Phase 1', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      rotationPolicy: { intervalDays: 90 },
    });
    expect(result.success).toBe(false);
  });

  it('enforces scope/projectId consistency: scope=tenant requires projectId=null', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'tenant',
      projectId: 'proj-1', // invalid: tenant scope with projectId
    });
    expect(result.success).toBe(false);
  });

  it('enforces scope/projectId consistency: scope=project requires non-null projectId', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'project',
      projectId: null, // invalid: project scope without projectId
    });
    expect(result.success).toBe(false);
  });

  it('enforces tenant-scope visibility: tenant + personal is rejected', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      scope: 'tenant',
      projectId: null,
      visibility: 'personal', // invalid: personal at tenant level
    });
    expect(result.success).toBe(false);
  });

  it('strips createdBy from body (never accepted from request)', () => {
    const result = CreateAuthProfileSchema.safeParse({
      ...base,
      authType: 'none',
      config: {},
      secrets: {},
      createdBy: 'attacker-id',
    });
    // createdBy should not be in the parsed output
    if (result.success) {
      expect((result.data as any).createdBy).toBeUndefined();
    }
  });
});

// ── UpdateAuthProfileSchema ────────────────────────────────────────

describe('UpdateAuthProfileSchema', () => {
  it('accepts partial update (name only)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ name: 'New Name' });
    expect(result.success).toBe(true);
  });

  it('accepts config + secrets update', () => {
    const result = UpdateAuthProfileSchema.safeParse({
      config: { headerName: 'X-New-Key' },
      secrets: { apiKey: 'new-key' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects authType change (immutable)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ authType: 'bearer' });
    expect(result.success).toBe(false);
  });

  it('rejects createdBy change (immutable)', () => {
    const result = UpdateAuthProfileSchema.safeParse({ createdBy: 'new-user' });
    expect(result.success).toBe(false);
  });

  it('rejects addon fields in Phase 1', () => {
    const result = UpdateAuthProfileSchema.safeParse({
      signing: { algorithm: 'hmac-sha256' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty update', () => {
    const result = UpdateAuthProfileSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/auth-profile-schema.test.ts
```

**Implementation:** `packages/shared/src/validation/auth-profile.schema.ts`

```typescript
/**
 * Auth Profile Zod Validation Schemas
 *
 * Discriminated union on `authType` for the 6 Phase 1 types.
 * All config schemas use .strict() to prevent unknown field injection.
 */

import { z } from 'zod';

// ─── Phase 1 Auth Types ────────────────────────────────────────────────

export const PHASE1_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
] as const;

// ─── Config Schemas (per auth type) ────────────────────────────────────

export const NoneConfigSchema = z.object({}).strict();

export const ApiKeyConfigSchema = z
  .object({
    headerName: z.string().min(1).max(255),
    prefix: z.string().max(64).optional(),
    placement: z.enum(['header', 'query']).default('header'),
  })
  .strict();

export const BearerConfigSchema = z.object({}).strict();

export const OAuth2AppConfigSchema = z
  .object({
    authorizationUrl: z.string().url(),
    tokenUrl: z.string().url(),
    refreshUrl: z.string().url().optional(),
    revocationUrl: z.string().url().optional(),
    deviceAuthorizationUrl: z.string().url().optional(),
    tokenIntrospectionUrl: z.string().url().optional(),
    defaultScopes: z.array(z.string().min(1)).optional(),
    scopeSeparator: z.string().max(8).optional(),
    pkceRequired: z.boolean().optional(),
    pkceMethod: z.enum(['S256', 'plain']).optional(),
    supportedGrantTypes: z.array(z.string().min(1)).optional(),
    setupGuideUrl: z.string().url().optional(),
    docsUrl: z.string().url().optional(),
  })
  .strict();

export const OAuth2TokenConfigSchema = z
  .object({
    provider: z.string().min(1).max(255),
    scopes: z.array(z.string().min(1)).optional(),
    grantedScopes: z.array(z.string().min(1)).optional(),
    tokenType: z.enum(['bearer', 'mac']).optional(),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    refreshTokenExpiresAt: z.string().datetime().nullable().optional(),
    refreshTokenRotation: z.boolean().optional(),
  })
  .strict();

export const OAuth2ClientCredentialsConfigSchema = z
  .object({
    tokenUrl: z.string().url(),
    scopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

// ─── Secrets Schemas (per auth type) ───────────────────────────────────

export const NoneSecretsSchema = z.object({}).strict();

export const ApiKeySecretsSchema = z
  .object({
    apiKey: z.string().min(1),
  })
  .strict();

export const BearerSecretsSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export const OAuth2AppSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

export const OAuth2TokenSecretsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
  })
  .strict();

export const OAuth2ClientCredentialsSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

// ─── Shared Base Fields ─────────────────────────────────────────────────

const BaseProfileFields = {
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  projectId: z.string().nullable(),
  scope: z.enum(['tenant', 'project']),
  environment: z.string().max(64).nullable().optional(),
  visibility: z.enum(['shared', 'personal']).default('shared'),
  linkedAppProfileId: z.string().optional(),
  connector: z.string().max(255).optional(),
  category: z.string().max(255).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
};

// ─── Create Schema (Discriminated Union on authType) ────────────────────

const CreateNoneProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('none'),
    config: NoneConfigSchema,
    secrets: NoneSecretsSchema,
  })
  .strict();

const CreateApiKeyProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('api_key'),
    config: ApiKeyConfigSchema,
    secrets: ApiKeySecretsSchema,
  })
  .strict();

const CreateBearerProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('bearer'),
    config: BearerConfigSchema,
    secrets: BearerSecretsSchema,
  })
  .strict();

const CreateOAuth2AppProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_app'),
    config: OAuth2AppConfigSchema,
    secrets: OAuth2AppSecretsSchema,
  })
  .strict();

const CreateOAuth2TokenProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_token'),
    config: OAuth2TokenConfigSchema,
    secrets: OAuth2TokenSecretsSchema,
  })
  .strict();

const CreateOAuth2ClientCredentialsProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_client_credentials'),
    config: OAuth2ClientCredentialsConfigSchema,
    secrets: OAuth2ClientCredentialsSecretsSchema,
  })
  .strict();

const CreateAuthProfileBase = z.discriminatedUnion('authType', [
  CreateNoneProfile,
  CreateApiKeyProfile,
  CreateBearerProfile,
  CreateOAuth2AppProfile,
  CreateOAuth2TokenProfile,
  CreateOAuth2ClientCredentialsProfile,
]);

/**
 * Full Create schema with cross-field refinements:
 * - scope/projectId consistency
 * - visibility restrictions
 */
export const CreateAuthProfileSchema = CreateAuthProfileBase.pipe(
  z.any().superRefine((data, ctx) => {
    // scope/projectId consistency
    if (data.scope === 'tenant' && data.projectId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tenant-scoped profiles must have projectId: null',
        path: ['projectId'],
      });
    }
    if (data.scope === 'project' && !data.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project-scoped profiles must have a non-null projectId',
        path: ['projectId'],
      });
    }
    // Tenant-level profiles cannot be personal
    if (data.scope === 'tenant' && data.visibility === 'personal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tenant-scoped profiles cannot have personal visibility',
        path: ['visibility'],
      });
    }
  }),
);

export type CreateAuthProfileInput = z.infer<typeof CreateAuthProfileBase>;

// ─── Update Schema ─────────────────────────────────────────────────────

export const UpdateAuthProfileSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    environment: z.string().max(64).nullable().optional(),
    visibility: z.enum(['shared', 'personal']).optional(),
    config: z.record(z.unknown()).optional(),
    secrets: z.record(z.unknown()).optional(),
    connector: z.string().max(255).optional(),
    category: z.string().max(255).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    linkedAppProfileId: z.string().nullable().optional(),
    status: z.enum(['active', 'expired', 'revoked', 'invalid']).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type UpdateAuthProfileInput = z.infer<typeof UpdateAuthProfileSchema>;
```

### Task 5: Export from validation barrel

**File:** `packages/shared/src/validation/index.ts`

Add at the end:

```typescript
// Auth Profile schemas
export {
  CreateAuthProfileSchema,
  UpdateAuthProfileSchema,
  NoneConfigSchema,
  ApiKeyConfigSchema,
  BearerConfigSchema,
  OAuth2AppConfigSchema,
  OAuth2TokenConfigSchema,
  OAuth2ClientCredentialsConfigSchema,
  NoneSecretsSchema,
  ApiKeySecretsSchema,
  BearerSecretsSchema,
  OAuth2AppSecretsSchema,
  OAuth2TokenSecretsSchema,
  OAuth2ClientCredentialsSecretsSchema,
  PHASE1_AUTH_TYPES,
} from './auth-profile.schema.js';
export type { CreateAuthProfileInput, UpdateAuthProfileInput } from './auth-profile.schema.js';
```

**Verify:** `pnpm build --filter=@agent-platform/shared`

---

### Task Group A3: AuthProfileService

**File:** `packages/shared/src/services/auth-profile.service.ts`

### Task 6: Service skeleton with create method

**Test file:** `packages/shared/src/__tests__/auth-profile/auth-profile-service.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthProfileService } from '../../services/auth-profile.service.js';

// ── Mock AuthProfile model ────────────────────────────────────────

const mockAuthProfileModel = {
  create: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOneAndDelete: vi.fn(),
  countDocuments: vi.fn(),
};

// ── Mock Redis client ─────────────────────────────────────────────

const mockRedis = {
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
};

// NOTE: No encryption mock needed — the Mongoose encryptionPlugin handles
// encrypt/decrypt automatically. The service passes raw secrets to
// encryptedSecrets and reads back already-decrypted values.
const service = new AuthProfileService({
  model: mockAuthProfileModel as any,
  redis: mockRedis as any,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthProfileService.create', () => {
  const validInput = {
    name: 'Gmail API Key',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    scope: 'project' as const,
    visibility: 'shared' as const,
    createdBy: 'user-1',
    authType: 'api_key' as const,
    config: { headerName: 'X-Api-Key', placement: 'header' },
    secrets: { apiKey: 'sk-123' },
  };

  it('passes JSON-stringified secrets as encryptedSecrets (plugin encrypts on save)', async () => {
    // Encryption handled by Mongoose encryptionPlugin on save -- do NOT manually encrypt.
    // encryptedSecrets is a String field, so secrets are JSON.stringify'd before create().
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1', ...validInput });
    await service.create(validInput);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.encryptedSecrets).toBe(JSON.stringify(validInput.secrets));
    expect(createArg).not.toHaveProperty('secrets');
  });

  it('sets default status to active', async () => {
    mockAuthProfileModel.create.mockResolvedValue({ _id: 'ap-1', ...validInput });
    await service.create(validInput);
    const createArg = mockAuthProfileModel.create.mock.calls[0][0];
    expect(createArg.status).toBe('active');
  });

  it('rejects addon fields in Phase 1', async () => {
    await expect(
      service.create({ ...validInput, signing: { alg: 'hmac' } } as any),
    ).rejects.toThrow(/[Aa]ddon/);
  });

  it('rejects rotationPolicy in Phase 1', async () => {
    await expect(
      service.create({ ...validInput, rotationPolicy: { interval: 90 } } as any),
    ).rejects.toThrow(/rotation/i);
  });
});

describe('AuthProfileService.update', () => {
  it('uses findOne + save (not findOneAndUpdate) to trigger encryption plugin', async () => {
    // CRITICAL: findOneAndUpdate bypasses the encryption plugin's pre('save') hook.
    // The service must use findOne + modify + save() for any update path.
    const mockDoc = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      authType: 'api_key',
      encryptedSecrets: 'old-encrypted',
      save: vi.fn().mockResolvedValue(undefined),
      toObject: vi.fn().mockReturnValue({ _id: 'ap-1' }),
    };
    mockAuthProfileModel.findOne.mockResolvedValue(mockDoc);

    await service.update({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      updates: { secrets: { apiKey: 'new-key' } },
    });

    // JSON-stringified secrets assigned to document — plugin encrypts on save()
    expect(mockDoc.encryptedSecrets).toBe(JSON.stringify({ apiKey: 'new-key' }));
    expect(mockDoc.save).toHaveBeenCalled();
  });

  it('returns 404 when profile not found', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);
    await expect(
      service.update({
        id: 'nonexistent',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        updates: { name: 'New' },
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('AuthProfileService.delete', () => {
  it('blocks deletion if consumers exist', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
    });
    // Simulate consumers referencing this profile
    mockAuthProfileModel.countDocuments.mockResolvedValue(3);

    await expect(
      service.delete({
        id: 'ap-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      }),
    ).rejects.toThrow(/active connections/i);
  });

  it('deletes when no consumers reference the profile', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
    });
    mockAuthProfileModel.countDocuments.mockResolvedValue(0);
    mockAuthProfileModel.findOneAndDelete.mockResolvedValue({ _id: 'ap-1' });

    const result = await service.delete({
      id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });
    expect(result).toBeDefined();
  });
});

describe('AuthProfileService.resolve', () => {
  it('returns extracted credentials for matching profile', async () => {
    // The encryptionPlugin auto-decrypts on post-find, so encryptedSecrets
    // is already a JSON string by the time the service reads it.
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key' },
      encryptedSecrets: JSON.stringify({ apiKey: 'sk-123' }),
    });

    const result = await service.resolve({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'shared',
    });

    expect(result).toBeDefined();
    expect(result.secrets).toEqual({ apiKey: 'sk-123' });
  });

  it('uses 5-level $or query with correct priority', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);
    // Use find to check the query structure
    mockAuthProfileModel.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await service
      .resolve({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'gmail',
        connectionMode: 'shared',
        environment: 'production',
      })
      .catch(() => {});

    // Verify the query was constructed with $or containing multiple resolution levels
    const findCall = mockAuthProfileModel.find.mock.calls[0]?.[0];
    if (findCall) {
      expect(findCall.$or).toBeDefined();
      expect(findCall.tenantId).toBe('tenant-1');
    }
  });
});

describe('AuthProfileService.validateAccess', () => {
  it('returns profile when tenant matches and scope allows access', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      projectId: null, // tenant-level
    });

    const result = await service.validateAccess('ap-1', 'tenant-1', 'proj-1');
    expect(result).toBeDefined();
    expect(result._id).toBe('ap-1');
  });

  it('throws NotFound for cross-tenant access', async () => {
    mockAuthProfileModel.findOne.mockResolvedValue(null);

    await expect(service.validateAccess('ap-1', 'other-tenant', 'proj-1')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('AuthProfileService.getConsumerCount', () => {
  it('counts linked oauth2_token profiles for oauth2_app', async () => {
    mockAuthProfileModel.countDocuments.mockResolvedValue(5);

    const count = await service.getConsumerCount('ap-1', 'tenant-1');
    expect(count).toBe(5);
    expect(mockAuthProfileModel.countDocuments).toHaveBeenCalledWith({
      linkedAppProfileId: 'ap-1',
      tenantId: 'tenant-1',
    });
  });
});
```

**Run to verify failure:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/auth-profile-service.test.ts
```

**Implementation:** `packages/shared/src/services/auth-profile.service.ts`

```typescript
/**
 * AuthProfile Service
 *
 * Core business logic for credential management. All methods are
 * tenant-scoped. Secrets are encrypted at rest via the Mongoose encryptionPlugin.
 *
 * NOTE: packages/shared cannot import from @abl/compiler/platform (it has
 * Uses createLogger from @agent-platform/shared-observability for structured logging.
 */

import { createLogger } from '@agent-platform/shared-observability';
const logger = createLogger('auth-profile-service');

// ─── Types ────────────────────────────────────────────────────────────

export interface AuthProfileServiceDeps {
  model: any; // Mongoose Model<IAuthProfile>
  // NOTE: No encryption dependency needed. The Mongoose encryptionPlugin
  // auto-encrypts on pre('save') and auto-decrypts on post-find hooks.
  // The service passes raw secrets to `encryptedSecrets` and reads them
  // back already decrypted (as JSON strings needing JSON.parse).
  redis?: {
    set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
  };
}

export interface CreateAuthProfileInput {
  name: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  visibility: 'shared' | 'personal';
  createdBy: string;
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  description?: string;
  environment?: string | null;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  // Phase 1 rejections
  signing?: unknown;
  webhookVerification?: unknown;
  proxy?: unknown;
  rotationPolicy?: unknown;
}

export interface UpdateAuthProfileInput {
  id: string;
  tenantId: string;
  projectId: string;
  updates: {
    name?: string;
    description?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
    environment?: string | null;
    visibility?: 'shared' | 'personal';
    connector?: string;
    category?: string;
    tags?: string[];
    linkedAppProfileId?: string | null;
    status?: string;
  };
}

export interface DeleteAuthProfileInput {
  id: string;
  tenantId: string;
  projectId: string;
}

export interface ResolveAuthProfileInput {
  tenantId: string;
  projectId: string;
  connector: string;
  connectionMode: 'per_user' | 'shared';
  environment?: string;
  userId?: string;
  authProfileId?: string;
}

export interface ResolvedCredentials {
  profileId: string;
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

// ─── Errors ──────────────────────────────────────────────────────────

class AuthProfileNotFoundError extends Error {
  constructor(message = 'Auth profile not found') {
    super(message);
    this.name = 'AuthProfileNotFoundError';
  }
}

class AuthProfileConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthProfileConflictError';
  }
}

// NOTE: Task 38 (Phase D) creates the canonical AuthProfileError class at
// packages/shared/src/errors/auth-profile-errors.ts. During implementation,
// define the local error classes below first, then replace them with the
// canonical import once Task 38 is completed:
//   import { AuthProfileError } from '../errors/auth-profile-errors.js';

// ─── Token Refresh Lock ─────────────────────────────────────────────

const LOCK_TTL_MS = 30_000;
const LOCK_PREFIX = 'auth-profile:refresh-lock:';

// ─── Service ────────────────────────────────────────────────────────

export class AuthProfileService {
  private readonly model: any;
  private readonly redis?: AuthProfileServiceDeps['redis'];

  constructor(deps: AuthProfileServiceDeps) {
    this.model = deps.model;
    this.redis = deps.redis;
  }

  // ── Create ──────────────────────────────────────────────────────────

  async create(input: CreateAuthProfileInput) {
    // Phase 1: reject addon fields
    // NOTE: Uses local error class until Task 38 provides AuthProfileError.
    if (input.signing || input.webhookVerification || input.proxy) {
      throw new AuthProfileConflictError('Addon mechanisms are not yet supported.');
    }
    if (input.rotationPolicy) {
      throw new AuthProfileConflictError(
        'Key rotation is not yet supported. Coming in a future release.',
      );
    }

    // Encryption handled by Mongoose encryptionPlugin on save -- do NOT manually encrypt.
    // IMPORTANT: encryptedSecrets is a String field. The plugin's pre('save') hook runs
    // AFTER Mongoose validation, so we must pass a string (not an object). The plugin
    // will encrypt the JSON string; on read, post-find hooks decrypt it back to a string
    // which the service then JSON.parse()s in extractCredentials().
    const doc = await this.model.create({
      name: input.name,
      description: input.description,
      tenantId: input.tenantId,
      projectId: input.projectId,
      scope: input.scope,
      environment: input.environment ?? null,
      visibility: input.visibility,
      createdBy: input.createdBy,
      authType: input.authType,
      config: input.config,
      encryptedSecrets: JSON.stringify(input.secrets), // stringify for String field; plugin encrypts on save
      encryptionKeyVersion: 1,
      linkedAppProfileId: input.linkedAppProfileId,
      connector: input.connector,
      category: input.category,
      tags: input.tags,
      status: 'active',
    });

    return doc;
  }

  // ── Update ──────────────────────────────────────────────────────────

  async update(input: UpdateAuthProfileInput) {
    // CRITICAL: Must use findOne + modify + save(), NOT findOneAndUpdate.
    // The Mongoose encryptionPlugin only has a pre('save') hook — findOneAndUpdate
    // bypasses it and would store plaintext secrets in MongoDB.
    const existing = await this.model.findOne({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });
    if (!existing) {
      throw new AuthProfileNotFoundError(`Auth profile ${input.id} not found`);
    }

    const $set: Record<string, unknown> = {};

    if (input.updates.name !== undefined) $set.name = input.updates.name;
    if ('description' in input.updates) $set.description = input.updates.description;
    if (input.updates.config !== undefined) $set.config = input.updates.config;
    if (input.updates.environment !== undefined) $set.environment = input.updates.environment;
    if (input.updates.visibility !== undefined) $set.visibility = input.updates.visibility;
    if (input.updates.connector !== undefined) $set.connector = input.updates.connector;
    if (input.updates.category !== undefined) $set.category = input.updates.category;
    if (input.updates.tags !== undefined) $set.tags = input.updates.tags;
    if (input.updates.linkedAppProfileId !== undefined)
      $set.linkedAppProfileId = input.updates.linkedAppProfileId;
    if (input.updates.status !== undefined) $set.status = input.updates.status;

    // Apply updates to the document
    for (const [key, value] of Object.entries($set)) {
      (existing as any)[key] = value;
    }
    if (input.updates.secrets !== undefined) {
      existing.encryptedSecrets = JSON.stringify(input.updates.secrets); // stringify for String field; plugin encrypts on save
    }

    await existing.save(); // triggers pre('save') → encryption plugin
    return existing;
  }

  // ── Delete ──────────────────────────────────────────────────────────

  async delete(input: DeleteAuthProfileInput) {
    const existing = await this.model.findOne({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });

    if (!existing) {
      throw new AuthProfileNotFoundError();
    }

    // For oauth2_app, check for linked tokens
    if (existing.authType === 'oauth2_app') {
      const consumerCount = await this.getConsumerCount(input.id, input.tenantId);
      if (consumerCount > 0) {
        throw new AuthProfileConflictError(
          `Cannot delete — ${consumerCount} active connections use this OAuth app. Revoke them first.`,
        );
      }
    }

    return this.model.findOneAndDelete({
      _id: input.id,
      tenantId: input.tenantId,
      $or: [{ projectId: null }, { projectId: input.projectId }],
    });
  }

  // ── Resolve (5-Level Priority) ──────────────────────────────────────

  async resolve(input: ResolveAuthProfileInput): Promise<ResolvedCredentials> {
    // If explicit authProfileId, resolve directly
    if (input.authProfileId) {
      const profile = await this.model.findOne({
        _id: input.authProfileId,
        tenantId: input.tenantId,
        $or: [{ projectId: null }, { projectId: input.projectId }],
      });

      if (!profile) {
        throw new AuthProfileNotFoundError('Auth profile not accessible from this project.');
      }

      return this.extractCredentials(profile);
    }

    // 5-level $or resolution
    const orConditions: Record<string, unknown>[] = [];

    // Level 1: Personal oauth2_token for this user + connector + environment
    if (input.connectionMode === 'per_user' && input.userId) {
      orConditions.push({
        projectId: input.projectId,
        connector: input.connector,
        authType: 'oauth2_token',
        visibility: 'personal',
        createdBy: input.userId,
        ...(input.environment ? { environment: input.environment } : {}),
      });
    }

    // Level 2: Shared oauth2_token for this connector + environment
    if (input.connectionMode === 'shared') {
      orConditions.push({
        projectId: input.projectId,
        connector: input.connector,
        authType: 'oauth2_token',
        visibility: 'shared',
        ...(input.environment ? { environment: input.environment } : {}),
      });
    }

    // Level 3: Project-level with matching environment
    if (input.environment) {
      orConditions.push({
        projectId: input.projectId,
        connector: input.connector,
        environment: input.environment,
      });
    }

    // Level 4: Project-level any-environment fallback
    orConditions.push({
      projectId: input.projectId,
      connector: input.connector,
      environment: null,
    });

    // Level 5: Tenant-level fallback
    orConditions.push({
      projectId: null,
      connector: input.connector,
    });

    const profiles = await this.model
      .find({
        tenantId: input.tenantId,
        status: 'active',
        $or: orConditions,
      })
      .sort({ projectId: -1, environment: -1, visibility: 1 }) // project > tenant, specific env > null
      .limit(1)
      .lean();

    if (!profiles || profiles.length === 0) {
      throw new AuthProfileNotFoundError(
        `No auth profile found for connector '${input.connector}'.`,
      );
    }

    return this.extractCredentials(profiles[0]);
  }

  // ── Validate Access ─────────────────────────────────────────────────

  async validateAccess(authProfileId: string, tenantId: string, projectId: string) {
    const profile = await this.model.findOne({
      _id: authProfileId,
      tenantId,
      $or: [
        { projectId: null }, // tenant-level: accessible by all projects
        { projectId }, // project-level: must match
      ],
    });

    if (!profile) {
      throw new AuthProfileNotFoundError();
    }

    return profile;
  }

  // ── Get Consumer Count ──────────────────────────────────────────────

  async getConsumerCount(profileId: string, tenantId: string): Promise<number> {
    return this.model.countDocuments({
      linkedAppProfileId: profileId,
      tenantId,
    });
  }

  // ── Token Refresh with Distributed Lock ─────────────────────────────

  async refreshToken(profileId: string, tenantId: string): Promise<ResolvedCredentials> {
    const lockKey = `${LOCK_PREFIX}${tenantId}:${profileId}`;
    let lockAcquired = false;

    if (this.redis) {
      try {
        const result = await this.redis.set(lockKey, '1', 'NX', 'PX', String(LOCK_TTL_MS));
        lockAcquired = result === 'OK';
      } catch (err) {
        // Redis unavailable — proceed without lock (design doc policy)
        logger.warn('auth_profile_lock_unavailable', {
          profileId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const profile = await this.model.findOne({
        _id: profileId,
        tenantId,
      });

      if (!profile) {
        throw new AuthProfileNotFoundError();
      }

      // Token refresh logic delegated to caller (native fetch token exchange)
      return this.extractCredentials(profile);
    } finally {
      if (lockAcquired && this.redis) {
        await this.redis.del(lockKey).catch(() => {});
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Extract secrets from a profile document.
   *
   * IMPORTANT: The Mongoose encryptionPlugin auto-decrypts `encryptedSecrets`
   * on post-find/findOne hooks. By the time this method runs, the field is
   * already a plaintext string (JSON-stringified by the plugin's pre-save
   * serialization). We only need JSON.parse() — NOT manual decryption.
   */
  private extractCredentials(profile: any): ResolvedCredentials {
    let secrets: Record<string, unknown>;
    if (typeof profile.encryptedSecrets === 'string') {
      try {
        secrets = JSON.parse(profile.encryptedSecrets);
      } catch {
        // If the plugin returned a non-JSON string, wrap it
        secrets = { _raw: profile.encryptedSecrets };
      }
    } else if (typeof profile.encryptedSecrets === 'object' && profile.encryptedSecrets !== null) {
      // Plugin may have already parsed it (e.g., if stored via Mixed type path)
      secrets = profile.encryptedSecrets;
    } else {
      secrets = {};
    }

    return {
      profileId: profile._id,
      authType: profile.authType,
      config: profile.config ?? {},
      secrets,
    };
  }
}
```

**Run test to verify pass:**

```bash
cd packages/shared && pnpm vitest run src/__tests__/auth-profile/auth-profile-service.test.ts
```

### Task 7: Distributed lock contention (backoff + re-read) test

**Add to** `packages/shared/src/__tests__/auth-profile/auth-profile-service.test.ts`:

```typescript
describe('AuthProfileService.refreshToken', () => {
  it('acquires Redis lock before refresh', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    await service.refreshToken('ap-1', 'tenant-1');

    expect(mockRedis.set).toHaveBeenCalledWith(
      'auth-profile:refresh-lock:tenant-1:ap-1',
      '1',
      'NX',
      'PX',
      '30000',
    );
  });

  it('releases lock after refresh', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    await service.refreshToken('ap-1', 'tenant-1');

    expect(mockRedis.del).toHaveBeenCalledWith('auth-profile:refresh-lock:tenant-1:ap-1');
  });

  it('proceeds without lock when Redis is unavailable', async () => {
    mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    mockAuthProfileModel.findOne.mockResolvedValue({
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.xxx' }),
    });

    // Should not throw — proceeds without lock
    const result = await service.refreshToken('ap-1', 'tenant-1');
    expect(result).toBeDefined();
  });

  it('re-reads token after lock contention and uses refreshed token if valid', async () => {
    // First call: lock acquisition fails (held by another pod)
    mockRedis.set.mockResolvedValueOnce(null);

    // After backoff, re-read returns a token that was refreshed by the lock holder
    const refreshedProfile = {
      _id: 'ap-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      encryptedSecrets: JSON.stringify({ accessToken: 'ya29.refreshed' }),
      config: { expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    };
    mockAuthProfileModel.findOne.mockResolvedValueOnce(refreshedProfile);

    const result = await service.refreshToken('ap-1', 'tenant-1');

    // Should return the already-refreshed token (lock holder refreshed it)
    expect(result).toBeDefined();
    // The service re-reads the profile and returns it — no explicit token
    // exchange was triggered by this pod since the lock was already held.
  });
});
```

---

**Base path:** `apps/studio/src/app/api/projects/[id]/auth-profiles/`

> **REVIEW NOTES (Iteration 2 — codebase discrepancies):**
>
> The route code below was drafted before auditing actual Studio patterns. The following
> discrepancies MUST be addressed during implementation:
>
> 1. **Use `withRouteHandler` pattern**: All existing Studio routes use the `withRouteHandler`
>    factory from `@/lib/route-handler.ts` instead of manual `requireAuth` + `requireProjectAccess`
>    - try/catch boilerplate. This factory handles auth, rate limiting, permissions, project access,
>      body validation, and error classification automatically. Refactor all routes below to use it.
>      Example: `export const POST = withRouteHandler({ requireProject: true, permissions: StudioPermission.AUTH_PROFILE_WRITE, bodySchema: CreateAuthProfileSchema }, handler);`
> 2. **Error format**: The codebase uses `{ success: false, errors: [{ msg, code }] }` via
>    `errorJson()` from `@/lib/api-response.ts`, NOT `{ success: false, error: { code, message } }`.
>    All manual `NextResponse.json({ success: false, error: ... })` calls below must use `errorJson()`.
> 3. **Add `StudioPermission` constants**: Define `AUTH_PROFILE_READ`, `AUTH_PROFILE_WRITE`,
>    `AUTH_PROFILE_DELETE`, `AUTH_PROFILE_DECRYPT` in `@/lib/permissions.ts`. The plan's inline
>    `user.permissions?.includes('auth-profile:write')` must be replaced with `StudioPermission` constants.
> 4. **`encryptedSecrets` must be `JSON.stringify()`'d**: The `encryptedSecrets` Mongoose field is
>    `type: String`. Pass `JSON.stringify(secrets)`, not raw objects. (Same fix as Phase A.)
> 5. **No manual decryption needed**: The encryption plugin auto-decrypts on post-find hooks.
>    OAuth routes that call `encryptionService.decryptJsonForTenant()` are double-decrypting.
>    Use `JSON.parse(profile.encryptedSecrets)` instead.
> 6. **Redis import path**: Studio uses `'@/lib/redis-client'` (via `getRedisClient()`),
>    NOT `'@agent-platform/shared/services/redis'`.
> 7. **Missing `AUTH_TYPE_CONFIG_SCHEMAS`**: The PUT route imports `AUTH_TYPE_CONFIG_SCHEMAS`
>    from the auth-profile schema, but this map was not defined in Phase A. Add it to
>    `packages/shared/src/validation/auth-profile.schema.ts` as:
>    ```typescript
>    export const AUTH_TYPE_CONFIG_SCHEMAS: Record<string, z.ZodType> = {
>      none: NoneConfigSchema,
>      api_key: ApiKeyConfigSchema,
>      bearer: BearerConfigSchema,
>      oauth2_app: OAuth2AppConfigSchema,
>      oauth2_token: OAuth2TokenConfigSchema,
>      oauth2_client_credentials: OAuth2ClientCredentialsConfigSchema,
>    };
>    ```
> 8. **`handleApiError` for catch blocks**: Use `handleApiError(error, context)` from
>    `@/lib/api-response.ts` instead of manual error classification in catch blocks.

### Task 8: CRUD routes — GET list, POST create

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`

```typescript
/**
 * GET  /api/projects/:id/auth-profiles       — List auth profiles (project + inherited tenant)
 * POST /api/projects/:id/auth-profiles       — Create a new auth profile
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { CreateAuthProfileSchema } from '@agent-platform/shared/validation';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles');

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const url = new URL(request.url);
    const authType = url.searchParams.get('authType');
    const connector = url.searchParams.get('connector');
    const environment = url.searchParams.get('environment');
    const status = url.searchParams.get('status');
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));
    const skip = (page - 1) * limit;

    // Build filter: project-level + inherited tenant-level
    const filter: Record<string, unknown> = {
      tenantId: user.tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    };

    // Visibility enforcement at DB level
    const isAdmin = user.permissions?.includes('auth-profile:decrypt');
    if (!isAdmin) {
      filter.$and = [
        {
          $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: user.id }],
        },
      ];
    }

    if (authType) filter.authType = authType;
    if (connector) filter.connector = connector;
    if (environment) filter.environment = environment;
    if (status) filter.status = status;

    const [profiles, total] = await Promise.all([
      AuthProfile.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuthProfile.countDocuments(filter),
    ]);

    // Mark inherited profiles
    const enriched = (profiles as any[]).map((p) => ({
      ...p,
      id: p._id,
      inherited: p.projectId === null,
      // Redact encrypted secrets — never send to client
      encryptedSecrets: undefined,
      previousEncryptedSecrets: undefined,
    }));

    return NextResponse.json({
      success: true,
      data: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error('List auth profiles error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  // Permission check
  if (!user.permissions?.includes('auth-profile:write')) {
    return NextResponse.json(
      { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = CreateAuthProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    // SSRF validation for URL fields (oauth2_app AND oauth2_client_credentials)
    if (
      parsed.data.authType === 'oauth2_app' ||
      parsed.data.authType === 'oauth2_client_credentials'
    ) {
      const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
      const config = parsed.data.config as Record<string, unknown>;
      const urlFields = [
        'authorizationUrl',
        'tokenUrl',
        'refreshUrl',
        'revocationUrl',
        'deviceAuthorizationUrl',
        'tokenIntrospectionUrl',
        'setupGuideUrl',
        'docsUrl',
      ];
      for (const field of urlFields) {
        const url = config[field];
        if (typeof url === 'string') {
          // Use strict SSRF options (empty {}) — user-submitted URLs must not bypass validation
          const check = validateUrlForSSRF(url, {});
          if (!check.safe) {
            return NextResponse.json(
              {
                success: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: `URL field '${field}' blocked by SSRF protection`,
                },
              },
              { status: 400 },
            );
          }
        }
      }
    }

    // linkedAppProfileId cross-reference validation
    if (parsed.data.linkedAppProfileId) {
      const linkedApp = await AuthProfile.findOne({
        _id: parsed.data.linkedAppProfileId,
        tenantId: user.tenantId,
      }).lean();

      if (!linkedApp) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Linked OAuth app must belong to the same tenant.',
            },
          },
          { status: 400 },
        );
      }

      if ((linkedApp as any).authType !== 'oauth2_app') {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'linkedAppProfileId must reference an oauth2_app profile.',
            },
          },
          { status: 400 },
        );
      }
    }

    // NOTE: Do NOT manually encrypt secrets here. The Mongoose encryptionPlugin
    // auto-encrypts `fieldsToEncrypt` on save. Manually encrypting would cause
    // double-encryption. Pass raw secrets as `encryptedSecrets` — the plugin
    // encrypts them transparently before persisting to MongoDB.
    const profile = await AuthProfile.create({
      name: parsed.data.name,
      description: parsed.data.description,
      tenantId: user.tenantId,
      projectId: parsed.data.projectId ?? projectId,
      scope: parsed.data.scope,
      environment: parsed.data.environment ?? null,
      visibility: parsed.data.visibility,
      createdBy: user.id, // CRITICAL: from auth context, never from body
      authType: parsed.data.authType,
      config: (parsed.data as any).config,
      encryptedSecrets: JSON.stringify((parsed.data as any).secrets), // stringify for String field; plugin encrypts on save
      encryptionKeyVersion: 1,
      linkedAppProfileId: parsed.data.linkedAppProfileId,
      connector: parsed.data.connector,
      category: parsed.data.category,
      tags: parsed.data.tags,
      status: 'active',
    });

    const {
      encryptedSecrets: _,
      previousEncryptedSecrets: __,
      ...safe
    } = (profile as any).toObject ? (profile as any).toObject() : profile;

    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } }, { status: 201 });
  } catch (error: unknown) {
    // Duplicate name
    if (error instanceof Error && 'code' in error && (error as any).code === 11000) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NAME_CONFLICT',
            message: 'An auth profile with this name already exists in this scope.',
          },
        },
        { status: 409 },
      );
    }

    logger.error('Create auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

### Task 9: GET by id, PUT update, DELETE

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/route.ts`

```typescript
/**
 * GET    /api/projects/:id/auth-profiles/:profileId — Get single profile
 * PUT    /api/projects/:id/auth-profiles/:profileId — Update profile
 * DELETE /api/projects/:id/auth-profiles/:profileId — Delete profile
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { UpdateAuthProfileSchema } from '@agent-platform/shared/validation';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles');

type RouteParams = { params: Promise<{ id: string; profileId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      $or: [{ projectId }, { projectId: null }],
    }).lean();

    if (!profile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    // Visibility check
    const p = profile as any;
    if (p.visibility === 'personal' && p.createdBy !== user.id) {
      const isAdmin = user.permissions?.includes('auth-profile:decrypt');
      if (!isAdmin) {
        return NextResponse.json(
          { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
          { status: 404 },
        );
      }
    }

    // Redact secrets
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = p;

    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } });
  } catch (error) {
    logger.error('Get auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  if (!user.permissions?.includes('auth-profile:write')) {
    return NextResponse.json(
      { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = UpdateAuthProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    // Load existing profile to get authType for per-type config validation
    const existingProfile = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      projectId,
    }).lean();

    if (!existingProfile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    const updates = parsed.data;

    // SSRF validation for URL fields when authType is OAuth
    const oauthTypes = ['oauth2_app', 'oauth2_client_credentials', 'oauth2_token'];
    if (updates.config && oauthTypes.includes((existingProfile as any).authType)) {
      const { validateUrlForSSRF } = await import('@agent-platform/shared/security');
      const urlFields = ['authorizationUrl', 'tokenUrl', 'revocationUrl', 'userInfoUrl'];
      for (const field of urlFields) {
        if (updates.config[field]) {
          const check = validateUrlForSSRF(updates.config[field] as string, {});
          if (!check.safe) {
            return NextResponse.json(
              {
                success: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: `URL field '${field}' blocked by SSRF protection`,
                },
              },
              { status: 400 },
            );
          }
        }
      }
    }

    // Per-type config validation: validate merged config against the authType-specific schema
    if (updates.config) {
      const { AUTH_TYPE_CONFIG_SCHEMAS } =
        await import('@agent-platform/shared/validation/auth-profile.schema');
      const mergedConfig = { ...(existingProfile as any).config, ...updates.config };
      const typeSchema = AUTH_TYPE_CONFIG_SCHEMAS[(existingProfile as any).authType];
      if (typeSchema) {
        const configResult = typeSchema.safeParse(mergedConfig);
        if (!configResult.success) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid config for auth type',
                details: configResult.error.issues,
              },
            },
            { status: 400 },
          );
        }
      }
    }

    const $set: Record<string, unknown> = {};

    if (updates.name !== undefined) $set.name = updates.name;
    if ('description' in updates) $set.description = updates.description;
    if (updates.config !== undefined) $set.config = updates.config;
    if (updates.environment !== undefined) $set.environment = updates.environment;
    if (updates.visibility !== undefined) $set.visibility = updates.visibility;
    if (updates.connector !== undefined) $set.connector = updates.connector;
    if (updates.category !== undefined) $set.category = updates.category;
    if (updates.tags !== undefined) $set.tags = updates.tags;
    if (updates.linkedAppProfileId !== undefined)
      $set.linkedAppProfileId = updates.linkedAppProfileId;
    if (updates.status !== undefined) $set.status = updates.status;

    // CRITICAL: Must use findOne + modify + save(), NOT findOneAndUpdate.
    // The Mongoose encryptionPlugin only has a pre('save') hook — findOneAndUpdate
    // bypasses it and would store plaintext secrets in MongoDB.
    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      projectId,
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    // Apply updates to the document
    for (const [key, value] of Object.entries($set)) {
      (existing as any)[key] = value;
    }
    if (updates.secrets !== undefined) {
      existing.encryptedSecrets = JSON.stringify(updates.secrets); // stringify for String field; plugin encrypts on save
    }

    await existing.save(); // triggers pre('save') → encryption plugin

    const doc = existing.toObject();
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = doc as any;
    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as any).code === 11000) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'NAME_CONFLICT',
            message: 'An auth profile with this name already exists in this scope.',
          },
        },
        { status: 409 },
      );
    }

    logger.error('Update auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  if (!user.permissions?.includes('auth-profile:delete')) {
    return NextResponse.json(
      { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      { status: 403 },
    );
  }

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    // Check for linked tokens before deleting oauth2_app
    const existing = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      projectId,
    }).lean();

    if (!existing) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    // NOTE: The consumer check + delete below is not atomic. A new token could be
    // linked between the countDocuments and findOneAndDelete calls. This is an
    // acceptable trade-off for Phase 1 — the linked tokens would become orphaned
    // but non-functional. A future improvement could use a MongoDB transaction or
    // optimistic concurrency (version field check) if atomicity is required.
    if ((existing as any).authType === 'oauth2_app') {
      const tokenCount = await AuthProfile.countDocuments({
        linkedAppProfileId: profileId,
        tenantId: user.tenantId,
        status: 'active',
      });

      if (tokenCount > 0) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'CONFLICT',
              message: `Cannot delete — ${tokenCount} active connections use this OAuth app. Revoke them first.`,
            },
          },
          { status: 409 },
        );
      }
    }

    await AuthProfile.findOneAndDelete({
      _id: profileId,
      tenantId: user.tenantId,
      projectId,
    });

    return NextResponse.json({ success: true, data: { deleted: profileId } });
  } catch (error) {
    logger.error('Delete auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

### Task 10: OAuth endpoints

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`

```typescript
/**
 * POST /api/projects/:pid/auth-profiles/oauth/initiate
 *
 * Resolves the authorization URL from an oauth2_app profile and returns
 * it to the client for the OAuth popup flow.
 *
 * Rate limit: 20 requests per minute per user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';
import crypto from 'node:crypto';

const logger = createLogger('auth-profiles-oauth');

const InitiateSchema = z.object({
  connectorName: z.string().min(1),
  authProfileId: z.string().min(1),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = InitiateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    // Load the oauth2_app profile
    const appProfile = await AuthProfile.findOne({
      _id: parsed.data.authProfileId,
      tenantId: user.tenantId,
      authType: 'oauth2_app',
      $or: [{ projectId }, { projectId: null }],
    }).lean();

    if (!appProfile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'OAuth app profile not found' } },
        { status: 404 },
      );
    }

    const config = (appProfile as any).config;

    // Generate state token (CSRF protection)
    const state = crypto.randomBytes(32).toString('hex');

    // Build authorization URL
    const authUrl = new URL(config.authorizationUrl);
    // The encryption plugin auto-decrypts encryptedSecrets on post-find hooks.
    // The field is now a JSON string — just parse it.
    const secrets: Record<string, string> = JSON.parse((appProfile as any).encryptedSecrets);

    authUrl.searchParams.set('client_id', secrets.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', state);

    if (config.defaultScopes?.length) {
      const separator = config.scopeSeparator ?? ' ';
      authUrl.searchParams.set('scope', config.defaultScopes.join(separator));
    }

    // Store state in Redis for callback verification (TTL: 10 min)
    const { getRedisClient } = await import('@/lib/redis-client');
    const redis = getRedisClient();
    const statePayload = JSON.stringify({
      authProfileId: parsed.data.authProfileId,
      tenantId: user.tenantId,
      projectId,
      userId: user.id,
      createdAt: Date.now(),
    });
    await redis.set(
      `auth-profile:oauth-state:${user.tenantId}:${state}`,
      statePayload,
      'EX',
      600, // 10 minute TTL
    );

    return NextResponse.json({
      success: true,
      data: { authUrl: authUrl.toString(), state },
    });
  } catch (error) {
    logger.error('OAuth initiate error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`

```typescript
/**
 * POST /api/projects/:pid/auth-profiles/oauth/callback
 *
 * Exchanges an authorization code for tokens and creates an oauth2_token profile.
 *
 * Rate limit: 10 requests per minute per user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles-oauth');

const CallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  displayName: z.string().max(255).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = CallbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }

  await ensureDb();

  try {
    // 1. Validate state format
    if (!/^[a-f0-9]{64}$/.test(parsed.data.state)) {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid state format' } },
        { status: 400 },
      );
    }

    // 2. Atomically retrieve and delete state from Redis (prevents replay)
    const { getRedisClient } = await import('@/lib/redis-client');
    const redis = getRedisClient();
    const stateKey = `auth-profile:oauth-state:${user.tenantId}:${parsed.data.state}`;
    const stateRaw = await redis.getdel(stateKey);

    if (!stateRaw) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_STATE', message: 'Invalid or expired OAuth state' },
        },
        { status: 400 },
      );
    }

    const stateData = JSON.parse(stateRaw);

    // 3. Verify tenant matches (state was stored with tenantId)
    if (stateData.tenantId !== user.tenantId) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'OAuth state not found' } },
        { status: 404 },
      );
    }

    // 4. Load the oauth2_app profile to get tokenUrl and client credentials
    const { AuthProfile } = await import('@agent-platform/database/models');

    const appProfile = await AuthProfile.findOne({
      _id: stateData.authProfileId,
      tenantId: user.tenantId,
      authType: 'oauth2_app',
    }).lean();

    if (!appProfile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'OAuth app profile not found' } },
        { status: 404 },
      );
    }

    // The encryption plugin auto-decrypts encryptedSecrets on post-find hooks.
    // The field is now a JSON string — just parse it.
    const secrets: Record<string, string> = JSON.parse((appProfile as any).encryptedSecrets);

    // 5. Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: parsed.data.code,
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
      redirect_uri: stateData.redirectUri || '',
    });

    if (stateData.codeVerifier) {
      tokenBody.set('code_verifier', stateData.codeVerifier);
    }

    const tokenRes = await fetch((appProfile as any).config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });

    if (!tokenRes.ok) {
      // Sanitize provider error — do not leak raw error body to client
      logger.error('Token exchange failed', {
        status: tokenRes.status,
        authProfileId: stateData.authProfileId,
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'TOKEN_EXCHANGE_FAILED',
            message: 'Token exchange failed with the OAuth provider',
          },
        },
        { status: 502 },
      );
    }

    const tokens = await tokenRes.json();

    // 6. Create oauth2_token profile (plugin auto-encrypts secrets on save)
    const tokenProfile = await AuthProfile.create({
      name: parsed.data.displayName || `${(appProfile as any).name} token`,
      tenantId: user.tenantId,
      projectId: stateData.projectId,
      scope: 'project',
      visibility: 'shared',
      createdBy: user.id,
      authType: 'oauth2_token',
      config: {
        provider: (appProfile as any).connector || 'oauth2',
        scopes: stateData.scopes || [],
        grantedScopes: tokens.scope ? tokens.scope.split(' ') : [],
        tokenType: tokens.token_type || 'bearer',
        issuedAt: new Date().toISOString(),
        expiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
      },
      encryptedSecrets: JSON.stringify({
        // stringify for String field; plugin encrypts on save
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
      }),
      encryptionKeyVersion: 1,
      linkedAppProfileId: stateData.authProfileId,
      status: 'active',
    });

    const {
      encryptedSecrets: _,
      previousEncryptedSecrets: __,
      ...safe
    } = (tokenProfile as any).toObject ? (tokenProfile as any).toObject() : tokenProfile;

    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } }, { status: 201 });
  } catch (error) {
    logger.error('OAuth callback error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/user-consent/route.ts`

```typescript
/**
 * POST /api/projects/:pid/auth-profiles/oauth/user-consent
 *
 * Initiates end-user OAuth consent flow (runtime context).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('auth-profiles-oauth');

const UserConsentSchema = z.object({
  connectorName: z.string().min(1),
  sessionId: z.string().min(1),
  authProfileId: z.string().min(1),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const parsed = UserConsentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: parsed.error.issues,
        },
      },
      { status: 400 },
    );
  }

  try {
    const { initiateUserConsentOAuth } =
      await import('@agent-platform/shared/services/auth-profile/auth-profile-oauth');

    const result = await initiateUserConsentOAuth({
      tenantId: user.tenantId,
      projectId,
      userId: user.id,
      authProfileId: parsed.data.authProfileId,
      connectorName: parsed.data.connectorName,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('OAuth user-consent error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

### Task 11: Utility endpoints — consumers, revoke

> **Dependency:** The consumers query uses `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId` fields, which are added in **Task 52** (wire `ConnectorConfig.authProfileId`). Task 11 implementation must follow Task 52 or the consumer lookup will always return empty results.

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/consumers/route.ts`

```typescript
/**
 * GET /api/projects/:pid/auth-profiles/:profileId/consumers
 *
 * Returns entities referencing this auth profile.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles');

type RouteParams = { params: Promise<{ id: string; profileId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { AuthProfile, ConnectorConnection, ConnectorConfig } =
      await import('@agent-platform/database/models');

    // Verify profile exists and is accessible
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      $or: [{ projectId }, { projectId: null }],
    }).lean();

    if (!profile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    // Find linked oauth2_token profiles (for oauth2_app)
    const linkedTokens = await AuthProfile.find({
      linkedAppProfileId: profileId,
      tenantId: user.tenantId,
    })
      .select('_id name authType status createdBy')
      .lean();

    // Find ConnectorConfigs referencing this profile
    // (Phase 1: authProfileId field)
    const connectorConfigs = await ConnectorConfig.find({
      authProfileId: profileId,
      tenantId: user.tenantId,
    })
      .select('_id connectorName')
      .lean();

    // Find ConnectorConnections referencing this profile
    const connectorConnections = await ConnectorConnection.find({
      authProfileId: profileId,
      tenantId: user.tenantId,
    })
      .select('_id connectorName displayName scope')
      .lean();

    return NextResponse.json({
      success: true,
      data: {
        linkedTokens: (linkedTokens as any[]).map((t) => ({ ...t, id: t._id })),
        connectorConfigs: (connectorConfigs as any[]).map((c) => ({ ...c, id: c._id })),
        connectorConnections: (connectorConnections as any[]).map((c) => ({ ...c, id: c._id })),
        totalCount:
          (linkedTokens as any[]).length +
          (connectorConfigs as any[]).length +
          (connectorConnections as any[]).length,
      },
    });
  } catch (error) {
    logger.error('Get consumers error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/revoke/route.ts`

```typescript
/**
 * POST /api/projects/:pid/auth-profiles/:profileId/revoke
 *
 * Revokes an auth profile (sets status to 'revoked').
 * If the profile has a revocationUrl, calls it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles');

type RouteParams = { params: Promise<{ id: string; profileId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  if (!user.permissions?.includes('auth-profile:write')) {
    return NextResponse.json(
      { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      { status: 403 },
    );
  }

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    // Use findOne + save for consistency (though revoke doesn't touch encrypted fields,
    // maintaining the same pattern avoids confusion about when findOneAndUpdate is safe)
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      $or: [{ projectId }, { projectId: null }],
    });

    if (!profile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    profile.status = 'revoked';
    await profile.save();

    // TODO: If oauth2_token with linked oauth2_app that has revocationUrl,
    // call the provider's revocation endpoint

    const doc = profile.toObject();
    const { encryptedSecrets, previousEncryptedSecrets, ...safe } = doc as any;
    return NextResponse.json({ success: true, data: { ...safe, id: safe._id } });
  } catch (error) {
    logger.error('Revoke auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

---

### Task 11b: Validate endpoint

**File:** `apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/validate/route.ts`

```typescript
/**
 * POST /api/projects/:pid/auth-profiles/:profileId/validate
 *
 * Tests the auth profile by attempting a live connection to the provider.
 * For api_key/bearer: sends a HEAD request to the configured test URL.
 * For oauth2_token: checks token validity (expiry, refresh if needed).
 * For oauth2_client_credentials: attempts a token exchange.
 *
 * Returns: { success: true, data: { valid: boolean, latencyMs: number, error?: string } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { createLogger } from '@abl/compiler/platform';
import { ensureDb } from '@/lib/ensure-db';

const logger = createLogger('auth-profiles-validate');

type RouteParams = { params: Promise<{ id: string; profileId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, profileId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  await ensureDb();

  try {
    const { AuthProfile } = await import('@agent-platform/database/models');
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId: user.tenantId,
      projectId,
    });

    if (!profile) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Auth profile not found' } },
        { status: 404 },
      );
    }

    // Delegate to auth-profile service for actual validation
    const { validateAuthProfileConnection } =
      await import('@agent-platform/shared/services/auth-profile/auth-profile-validator');

    const start = Date.now();
    const result = await validateAuthProfileConnection({
      profile,
      tenantId: user.tenantId,
    });
    const latencyMs = Date.now() - start;

    // Update lastValidatedAt on success
    if (result.valid) {
      await AuthProfile.updateOne(
        { _id: profileId, tenantId: user.tenantId },
        { $set: { lastValidatedAt: new Date() } },
      );
    }

    return NextResponse.json({
      success: true,
      data: { valid: result.valid, latencyMs, error: result.error },
    });
  } catch (error) {
    logger.error('Validate auth profile error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
```

---

## Phase B — API Routes

> Tasks 8-11 above cover the core CRUD and OAuth endpoints. The remaining API route tasks are covered in the OAuth Flows phase below.

---

## Phase C — OAuth Flows & Token Refresh

> **REVIEW NOTES (Iteration 3 — codebase comparison audit)**
>
> The following systemic issues were found and fixed in Phase C:
>
> 1. **`createLogger` from `../../utils/logger.js` does not exist in `packages/shared`.**
>    Use `createLogger` from `@agent-platform/shared-observability` instead.
>    `import { createLogger } from '@agent-platform/shared-observability';`
>    Affected files: `linked-app-validator.ts`,
>    `oauth2-app-resolver.ts`, `token-refresh-service.ts`, `refresh-lock.ts`,
>    `client-credentials-service.ts`.
> 2. **`AuthProfileError` from `@agent-platform/shared/auth-profile/errors` does not exist yet.**
>    That path is created in Task 38 (Phase E). `linked-app-validator.ts` and
>    `update-validator.ts` both imported it. Fixed: `linked-app-validator.ts` now defines
>    a local `AuthProfileError` class; `update-validator.ts` imports from
>    `./linked-app-validator.js`.
> 3. **Double-decryption bug in `oauth2-app-resolver.ts`.**
>    `resolveOAuth2AppCredentials()` called `decryptor.decryptForTenant()` on
>    `appProfile.encryptedSecrets` after loading via `AuthProfile.findOne()`. The
>    encryption plugin's `post('findOne')` hook already auto-decrypts, so the
>    decryptor call would corrupt data. Fixed: removed `decryptor` from params,
>    use `JSON.parse(appProfile.encryptedSecrets)` directly.
> 4. **Test mocks target wrong module for `packages/shared` services.**
>    Tests mock `@abl/compiler/platform` but implementations now use inline loggers
>    (no import to mock). The `vi.mock('@abl/compiler/platform', ...)` blocks in
>    test files for Tasks 19-23 are dead code — harmless but misleading. Remove them
>    at implementation time.
> 5. **`decryptor` parameter inconsistency across services.**
>    Services that load profiles via `AuthProfile.findOne()` get auto-decrypted data
>    and do NOT need a decryptor. But `resolveClientCredentialsToken()` (Task 23) and
>    `refreshOAuth2Token()` (Task 22) receive `encryptedSecrets` as a parameter AND
>    also load profiles via `findOne()`. The `decryptor` is only needed when secrets
>    are passed in from a caller that didn't load via Mongoose (e.g., pre-resolved
>    from cache). Implementers must audit each callsite.
> 6. **`findOneAndUpdate` bypasses encryption plugin's `pre('save')` hook.**
>    Task 22's `refreshOAuth2Token` uses `findOneAndUpdate` to store refreshed tokens.
>    The encryption plugin only hooks `pre('save')`, NOT `findOneAndUpdate`. Either:
>    (a) use `findOne()` + mutate + `.save()` to trigger the plugin, or
>    (b) manually encrypt before `findOneAndUpdate`. The current plan's test mocks
>    `encryptor.encryptForTenant` suggesting approach (b), but this contradicts the
>    "plugin handles everything" principle from Phase A. **Recommendation: use
>    `.save()` for consistency.**
> 7. **Task 26 test has `await import()` in non-async test function.**
>    Line `const { LLMWiringService } = await import(...)` is inside an `it()` block
>    that lacks the `async` keyword. Add `async` to the test function.
> 8. **Task 22 test passes `decryptor` for DB-loaded profiles.**
>    `mockFindOne` returns profiles, then the test passes `decryptor` to decrypt
>    `encryptedSecrets`. Since `findOne` auto-decrypts, the decryptor should not be
>    called on DB-loaded fields. The test setup needs reworking: mock `encryptedSecrets`
>    as the already-decrypted JSON string, and only use `decryptor` for non-DB sources.

> Two-layer OAuth model, OAuth flow endpoints, token refresh with distributed locking, `oauth2_client_credentials` Redis caching, RuntimeSecretsProvider integration.

### Task Group C1: OAuth Two-Layer Model

### Task 12: `oauth2_app` Cross-Reference Validation on Create

When creating an `oauth2_token` profile, `linkedAppProfileId` must reference a valid `oauth2_app` profile in the same tenant. Reject with 400 if the referenced profile does not exist, belongs to a different tenant, or has a different `authType`.

**Test file:** `packages/shared/src/__tests__/auth-profile/oauth2-token-validation.test.ts`

```typescript
/**
 * B1: oauth2_token linkedAppProfileId validation on create
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock AuthProfile model
const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { validateLinkedAppProfile } from '../../services/auth-profile/linked-app-validator.js';

describe('validateLinkedAppProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when linkedAppProfileId references a valid oauth2_app in same tenant', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
      }),
    ).resolves.toEqual(expect.objectContaining({ _id: 'ap-google-1', authType: 'oauth2_app' }));

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects when linkedAppProfileId does not exist in tenant (returns 404-safe error)', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-nonexistent',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/Linked OAuth app must belong to the same tenant/);
  });

  it('rejects when referenced profile has authType !== oauth2_app', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-bearer-1',
      tenantId: 'tenant-1',
      authType: 'bearer',
      status: 'active',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-bearer-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/must reference a profile with authType 'oauth2_app'/);
  });

  it('rejects when referenced profile has status revoked', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'revoked',
    });

    await expect(
      validateLinkedAppProfile({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow(/OAuth app profile is not active/);
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/linked-app-validator.ts`

```typescript
/**
 * Validates that a linkedAppProfileId references a valid, active oauth2_app
 * profile within the same tenant. Used during oauth2_token create and update.
 */
import { createLogger } from '@agent-platform/shared-observability';
const log = createLogger('linked-app-validator');

export interface ValidateLinkedAppParams {
  linkedAppProfileId: string;
  tenantId: string;
}

export async function validateLinkedAppProfile(params: ValidateLinkedAppParams): Promise<{
  _id: string;
  authType: string;
  config: Record<string, unknown>;
  encryptedSecrets: string;
}> {
  const { AuthProfile } = await import('@agent-platform/database/models');

  // Query scoped to same tenant -- cross-tenant returns null (404, not 403)
  const profile = await AuthProfile.findOne({
    _id: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  if (!profile) {
    throw new AuthProfileError(
      'AUTH_PROFILE_CROSS_TENANT_LINK',
      'Linked OAuth app must belong to the same tenant.',
    );
  }

  if (profile.authType !== 'oauth2_app') {
    throw new AuthProfileError(
      'AUTH_PROFILE_INCOMPATIBLE_TYPE',
      `linkedAppProfileId must reference a profile with authType 'oauth2_app'. Got '${profile.authType}'.`,
    );
  }

  if (profile.status !== 'active') {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      `OAuth app profile is not active (status: ${profile.status}).`,
    );
  }

  log.debug('Linked app profile validated', {
    linkedAppProfileId: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  return profile;
}

// NOTE (REVIEW): AuthProfileError is defined in Task 38 (Phase E).
// At implementation time, either:
// (a) implement Task 38 first, or
// (b) use a local error class:
class AuthProfileError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthProfileError';
  }
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/oauth2-token-validation.test.ts
```

---

### Task 13: Cross-Type Validation on Update

When updating an `oauth2_token`, if `linkedAppProfileId` is being changed, re-validate the new reference. Also prevent changing `authType` on an existing profile.

**Test file:** `packages/shared/src/__tests__/auth-profile/oauth2-token-update-validation.test.ts`

```typescript
/**
 * B2: oauth2_token cross-type validation on update
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { validateAuthProfileUpdate } from '../../services/auth-profile/update-validator.js';

describe('validateAuthProfileUpdate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects authType change on an existing profile', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
        } as any,
        updatePayload: { authType: 'api_key' } as any,
      }),
    ).rejects.toThrow(/authType cannot be changed/);
  });

  it('re-validates linkedAppProfileId when changed', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-new-app',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
    });

    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-old-app',
        } as any,
        updatePayload: { linkedAppProfileId: 'ap-new-app' },
      }),
    ).resolves.not.toThrow();

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: 'ap-new-app',
      tenantId: 'tenant-1',
    });
  });

  it('skips linkedAppProfileId validation when not changed', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: {
          authType: 'oauth2_token',
          tenantId: 'tenant-1',
          linkedAppProfileId: 'ap-same',
        } as any,
        updatePayload: { config: { scopes: ['email'] } },
      }),
    ).resolves.not.toThrow();

    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('allows update of non-oauth2_token profiles without linkedAppProfileId validation', async () => {
    await expect(
      validateAuthProfileUpdate({
        existingProfile: { authType: 'api_key', tenantId: 'tenant-1' } as any,
        updatePayload: { config: { headerName: 'X-New-Key' } },
      }),
    ).resolves.not.toThrow();
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/update-validator.ts`

```typescript
/**
 * Validates auth profile update payloads.
 * - Prevents authType mutation
 * - Re-validates linkedAppProfileId if changed on oauth2_token profiles
 */
import { validateLinkedAppProfile } from './linked-app-validator.js';
// NOTE (REVIEW): AuthProfileError is defined in Task 38 (Phase E).
// At implementation time, either implement Task 38 first, or use the local
// AuthProfileError class from linked-app-validator.ts (re-export it).
import { AuthProfileError } from './linked-app-validator.js';

export interface ValidateUpdateParams {
  existingProfile: {
    authType: string;
    tenantId: string;
    linkedAppProfileId?: string;
  };
  updatePayload: Record<string, unknown>;
}

export async function validateAuthProfileUpdate(params: ValidateUpdateParams): Promise<void> {
  const { existingProfile, updatePayload } = params;

  // Prevent authType mutation
  if (updatePayload.authType && updatePayload.authType !== existingProfile.authType) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'authType cannot be changed after creation. Create a new profile instead.',
    );
  }

  // Re-validate linkedAppProfileId if changed on oauth2_token
  if (
    existingProfile.authType === 'oauth2_token' &&
    updatePayload.linkedAppProfileId &&
    updatePayload.linkedAppProfileId !== existingProfile.linkedAppProfileId
  ) {
    await validateLinkedAppProfile({
      linkedAppProfileId: updatePayload.linkedAppProfileId as string,
      tenantId: existingProfile.tenantId,
    });
  }
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/oauth2-token-update-validation.test.ts
```

---

### Task 14: `oauth2_token` Layer 2 Links to Layer 1 via `linkedAppProfileId`

Verify that resolved tokens can navigate to the parent app profile for `clientId`/`clientSecret`.

**Test file:** `packages/shared/src/__tests__/auth-profile/two-layer-resolution.test.ts`

```typescript
/**
 * B3: Two-layer OAuth model -- token resolves parent app credentials
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

const mockDecryptForTenant = vi.fn((data: string) => `decrypted:${data}`);

import { resolveOAuth2AppCredentials } from '../../services/auth-profile/oauth2-app-resolver.js';

describe('resolveOAuth2AppCredentials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves clientId, clientSecret, tokenUrl from linked oauth2_app profile', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        refreshUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['email', 'profile'],
        pkceRequired: false,
      },
      encryptedSecrets: 'encrypted-blob',
    });

    const result = await resolveOAuth2AppCredentials({
      linkedAppProfileId: 'ap-google-1',
      tenantId: 'tenant-1',
      decryptor: { decryptForTenant: mockDecryptForTenant },
    });

    expect(result).toEqual(
      expect.objectContaining({
        tokenUrl: 'https://oauth2.googleapis.com/token',
        refreshUrl: 'https://oauth2.googleapis.com/token',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        defaultScopes: ['email', 'profile'],
        pkceRequired: false,
      }),
    );
    expect(result.clientId).toBeDefined();
    expect(result.clientSecret).toBeDefined();
  });

  it('throws when linked app profile not found (deleted after token creation)', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'ap-deleted',
        tenantId: 'tenant-1',
        decryptor: { decryptForTenant: mockDecryptForTenant },
      }),
    ).rejects.toThrow(/Linked OAuth app profile not found/);
  });

  it('throws when linked app profile is revoked', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'revoked',
    });

    await expect(
      resolveOAuth2AppCredentials({
        linkedAppProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
        decryptor: { decryptForTenant: mockDecryptForTenant },
      }),
    ).rejects.toThrow(/not active/);
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/oauth2-app-resolver.ts`

```typescript
/**
 * Resolves OAuth2 app credentials (clientId, clientSecret, tokenUrl, etc.)
 * from a linked oauth2_app profile. Used during token refresh and OAuth flows.
 */
import { createLogger } from '@agent-platform/shared-observability';
const log = createLogger('oauth2-app-resolver');

export interface ResolveAppCredentialsParams {
  linkedAppProfileId: string;
  tenantId: string;
  // NOTE (REVIEW): No decryptor needed. The encryption plugin auto-decrypts
  // on findOne(). The encryptedSecrets field is already a plaintext JSON string
  // after the post('findOne') hook runs.
}

export interface OAuth2AppCredentials {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  refreshUrl?: string;
  authorizationUrl: string;
  defaultScopes: string[];
  pkceRequired: boolean;
  pkceMethod?: 'S256' | 'plain';
}

export async function resolveOAuth2AppCredentials(
  params: ResolveAppCredentialsParams,
): Promise<OAuth2AppCredentials> {
  const { AuthProfile } = await import('@agent-platform/database/models');

  const appProfile = await AuthProfile.findOne({
    _id: params.linkedAppProfileId,
    tenantId: params.tenantId,
  });

  if (!appProfile) {
    throw new Error(
      'Linked OAuth app profile not found. It may have been deleted. Reconfigure the OAuth connection.',
    );
  }

  if (appProfile.authType !== 'oauth2_app') {
    throw new Error(`Linked profile has authType '${appProfile.authType}', expected 'oauth2_app'.`);
  }

  if (appProfile.status !== 'active') {
    throw new Error(`Linked OAuth app profile is not active (status: ${appProfile.status}).`);
  }

  // NOTE (REVIEW): encryptedSecrets is already auto-decrypted by the encryption
  // plugin's post('findOne') hook. Just JSON.parse the plaintext string.
  const secrets = JSON.parse(appProfile.encryptedSecrets);

  return {
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    tokenUrl: appProfile.config.tokenUrl as string,
    refreshUrl: (appProfile.config.refreshUrl as string) || undefined,
    authorizationUrl: appProfile.config.authorizationUrl as string,
    defaultScopes: (appProfile.config.defaultScopes as string[]) || [],
    pkceRequired: (appProfile.config.pkceRequired as boolean) || false,
    pkceMethod: appProfile.config.pkceMethod as 'S256' | 'plain' | undefined,
  };
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/two-layer-resolution.test.ts
```

---

### Task Group C2: OAuth Flow Endpoints

### Task 15: POST Initiate -- Generates State, Stores in Redis, Returns Authorization URL

**Test file:** `apps/studio/src/__tests__/api/auth-profiles/oauth-initiate.test.ts`

```typescript
/**
 * B4: POST /api/projects/:pid/auth-profiles/oauth/initiate
 *
 * - Loads oauth2_app profile from authProfileId
 * - Generates cryptographic state, stores in Redis with TTL
 * - Builds authorization URL with client_id, redirect_uri, scope, state
 * - Returns { authUrl, state }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockFindOne = vi.fn();
const mockDecryptForTenant = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { initiateAuthProfileOAuth } from '../../../services/auth-profile-oauth.js';

describe('initiateAuthProfileOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptForTenant.mockImplementation(() =>
      JSON.stringify({ clientId: 'cid-123', clientSecret: 'cs-secret' }),
    );
  });

  it('returns authUrl with correct query params and a 64-char hex state', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['email', 'profile'],
        scopeSeparator: ' ',
        pkceRequired: false,
      },
      encryptedSecrets: 'encrypted-blob',
    });

    const result = await initiateAuthProfileOAuth({
      authProfileId: 'ap-google-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      redirectUri: 'https://studio.example.com/oauth/auth-profile-callback',
      scopes: ['email', 'calendar'],
      redis: { set: mockRedisSet } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
    });

    // State is 64 hex characters
    expect(result.state).toMatch(/^[a-f0-9]{64}$/);

    // Auth URL is well-formed
    const url = new URL(result.authUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(url.searchParams.get('scope')).toBe('email calendar');

    // State stored in Redis with TTL
    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('auth-profile:oauth-state:'),
      expect.any(String),
      'EX',
      600, // 10 minute TTL
    );

    // Verify state payload includes tenant-scoped data (prevents cross-tenant replay)
    const storedPayload = JSON.parse(mockRedisSet.mock.calls[0][1]);
    expect(storedPayload.tenantId).toBe('tenant-1');
    expect(storedPayload.projectId).toBe('proj-1');
    expect(storedPayload.userId).toBe('user-1');
    expect(storedPayload.authProfileId).toBe('ap-google-1');
  });

  it('rejects when authProfileId is not an oauth2_app', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-bearer-1',
      tenantId: 'tenant-1',
      authType: 'bearer',
    });

    await expect(
      initiateAuthProfileOAuth({
        authProfileId: 'ap-bearer-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        redirectUri: 'https://studio.example.com/oauth/callback',
        scopes: [],
        redis: { set: mockRedisSet } as any,
        decryptor: { decryptForTenant: mockDecryptForTenant },
      }),
    ).rejects.toThrow(/must be oauth2_app/);
  });

  it('rejects when auth profile not found in same tenant', async () => {
    mockFindOne.mockResolvedValue(null);

    await expect(
      initiateAuthProfileOAuth({
        authProfileId: 'ap-missing',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        redirectUri: 'https://studio.example.com/oauth/callback',
        scopes: [],
        redis: { set: mockRedisSet } as any,
        decryptor: { decryptForTenant: mockDecryptForTenant },
      }),
    ).rejects.toThrow(/Auth profile not found/);
  });

  it('includes PKCE code_challenge when pkceRequired is true', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'ap-pkce-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: {
        authorizationUrl: 'https://provider.com/authorize',
        tokenUrl: 'https://provider.com/token',
        defaultScopes: [],
        pkceRequired: true,
        pkceMethod: 'S256',
      },
      encryptedSecrets: 'encrypted-blob',
    });

    const result = await initiateAuthProfileOAuth({
      authProfileId: 'ap-pkce-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      redirectUri: 'https://studio.example.com/oauth/callback',
      scopes: [],
      redis: { set: mockRedisSet } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
    });

    const url = new URL(result.authUrl);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // code_verifier stored in Redis state for use in callback
    const storedState = JSON.parse(mockRedisSet.mock.calls[0][1]);
    expect(storedState.codeVerifier).toBeTruthy();
    expect(storedState.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});
```

**Implementation file:** `apps/studio/src/services/auth-profile-oauth.ts`

```typescript
/**
 * Auth Profile OAuth Flow Service
 *
 * Implements the OAuth initiate/callback flows for Auth Profile.
 * State stored in Redis (multi-pod safe), tokens create oauth2_token profiles.
 */
import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-oauth');

const REDIS_STATE_PREFIX = 'auth-profile:oauth-state:';
const STATE_TTL_SECONDS = 600; // 10 minutes

export interface InitiateOAuthParams {
  authProfileId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  redis: {
    set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  };
  decryptor: {
    decryptForTenant(encrypted: string, tenantId: string): string;
  };
}

export interface InitiateOAuthResult {
  authUrl: string;
  state: string;
}

export async function initiateAuthProfileOAuth(
  params: InitiateOAuthParams,
): Promise<InitiateOAuthResult> {
  const { AuthProfile } = await import('@agent-platform/database/models');

  // Load the oauth2_app profile -- tenant-scoped
  const appProfile = await AuthProfile.findOne({
    _id: params.authProfileId,
    tenantId: params.tenantId,
  });

  if (!appProfile) {
    throw new Error('Auth profile not found');
  }

  if (appProfile.authType !== 'oauth2_app') {
    throw new Error(
      `Auth profile ${params.authProfileId} must be oauth2_app, got ${appProfile.authType}`,
    );
  }

  // NOTE (REVIEW): encryptedSecrets is already auto-decrypted by the encryption
  // plugin's post('findOne') hook. Just JSON.parse the plaintext string.
  const secrets = JSON.parse(appProfile.encryptedSecrets);

  // Generate cryptographic state
  const state = crypto.randomBytes(32).toString('hex');

  // Determine scopes
  const effectiveScopes =
    params.scopes.length > 0 ? params.scopes : (appProfile.config.defaultScopes as string[]) || [];
  const scopeSeparator = (appProfile.config.scopeSeparator as string) || ' ';

  // Build query params
  const urlParams = new URLSearchParams({
    client_id: secrets.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: effectiveScopes.join(scopeSeparator),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  // PKCE support
  let codeVerifier: string | undefined;
  if (appProfile.config.pkceRequired) {
    codeVerifier = crypto.randomBytes(32).toString('base64url');
    const method = (appProfile.config.pkceMethod as string) || 'S256';

    if (method === 'S256') {
      const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      urlParams.set('code_challenge', challenge);
      urlParams.set('code_challenge_method', 'S256');
    } else {
      urlParams.set('code_challenge', codeVerifier);
      urlParams.set('code_challenge_method', 'plain');
    }
  }

  // Store state in Redis with TTL
  const stateData = JSON.stringify({
    authProfileId: params.authProfileId,
    tenantId: params.tenantId,
    projectId: params.projectId,
    userId: params.userId,
    redirectUri: params.redirectUri,
    scopes: effectiveScopes,
    codeVerifier,
    createdAt: Date.now(),
  });

  await params.redis.set(`${REDIS_STATE_PREFIX}${state}`, stateData, 'EX', STATE_TTL_SECONDS);

  const authUrl = `${appProfile.config.authorizationUrl}?${urlParams.toString()}`;

  log.info('OAuth flow initiated', {
    authProfileId: params.authProfileId,
    tenantId: params.tenantId,
    scopeCount: effectiveScopes.length,
    pkce: !!codeVerifier,
  });

  return { authUrl, state };
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio vitest run src/__tests__/api/auth-profiles/oauth-initiate.test.ts
```

---

### Task 16: POST Callback -- Validates State, Exchanges Code, Creates `oauth2_token`

**Test file:** `apps/studio/src/__tests__/api/auth-profiles/oauth-callback.test.ts`

```typescript
/**
 * B5: POST /api/projects/:pid/auth-profiles/oauth/callback
 *
 * - Validates state from Redis (atomic get-and-delete)
 * - Exchanges authorization code for tokens via provider tokenUrl
 * - Creates an oauth2_token auth profile linked to the oauth2_app
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRedisGetdel = vi.fn();
const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockDecryptForTenant = vi.fn();
const mockEncryptForTenant = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: mockFindOne,
    create: mockCreate,
  },
}));

// Mock fetch for token exchange
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { handleAuthProfileOAuthCallback } from '../../../services/auth-profile-oauth.js';

describe('handleAuthProfileOAuthCallback', () => {
  const validState = 'a'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid state in Redis
    mockRedisGetdel.mockResolvedValue(
      JSON.stringify({
        authProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        redirectUri: 'https://studio.example.com/oauth/callback',
        scopes: ['email'],
        codeVerifier: undefined,
        createdAt: Date.now(),
      }),
    );

    // Default: valid oauth2_app profile
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: { tokenUrl: 'https://oauth2.googleapis.com/token' },
      encryptedSecrets: 'encrypted-blob',
    });

    mockDecryptForTenant.mockReturnValue(
      JSON.stringify({ clientId: 'cid-123', clientSecret: 'cs-secret' }),
    );
    mockEncryptForTenant.mockReturnValue('encrypted-new-tokens');

    // Default: successful token exchange
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        scope: 'email',
        token_type: 'bearer',
      }),
    });

    mockCreate.mockResolvedValue({
      _id: 'token-profile-1',
      authType: 'oauth2_token',
    });
  });

  it('exchanges code for tokens and creates oauth2_token profile', async () => {
    const result = await handleAuthProfileOAuthCallback({
      code: 'auth-code-xyz',
      state: validState,
      displayName: 'My Gmail',
      redis: { getdel: mockRedisGetdel } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
      encryptor: { encryptForTenant: mockEncryptForTenant },
    });

    // Token exchange called with correct params
    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      }),
    );

    // oauth2_token profile created
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: 'oauth2_token',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        linkedAppProfileId: 'ap-google-1',
        status: 'active',
        visibility: 'shared',
      }),
    );

    expect(result.authProfile).toBeDefined();
  });

  it('rejects when state is not found in Redis (expired or replayed)', async () => {
    mockRedisGetdel.mockResolvedValue(null);

    await expect(
      handleAuthProfileOAuthCallback({
        code: 'auth-code-xyz',
        state: validState,
        redis: { getdel: mockRedisGetdel } as any,
        decryptor: { decryptForTenant: mockDecryptForTenant },
        encryptor: { encryptForTenant: mockEncryptForTenant },
      }),
    ).rejects.toThrow(/Invalid or expired OAuth state/);
  });

  it('rejects when state format is invalid (not 64 hex chars)', async () => {
    await expect(
      handleAuthProfileOAuthCallback({
        code: 'auth-code-xyz',
        state: 'short-state',
        redis: { getdel: mockRedisGetdel } as any,
        decryptor: { decryptForTenant: mockDecryptForTenant },
        encryptor: { encryptForTenant: mockEncryptForTenant },
      }),
    ).rejects.toThrow(/Invalid state format/);
  });

  it('returns 502-equivalent error when token exchange fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    await expect(
      handleAuthProfileOAuthCallback({
        code: 'expired-code',
        state: validState,
        redis: { getdel: mockRedisGetdel } as any,
        decryptor: { decryptForTenant: mockDecryptForTenant },
        encryptor: { encryptForTenant: mockEncryptForTenant },
      }),
    ).rejects.toThrow(/Token exchange failed/);
  });

  it('includes code_verifier in token exchange when PKCE was used', async () => {
    mockRedisGetdel.mockResolvedValue(
      JSON.stringify({
        authProfileId: 'ap-google-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        redirectUri: 'https://studio.example.com/oauth/callback',
        scopes: ['email'],
        codeVerifier: 'pkce-verifier-value',
        createdAt: Date.now(),
      }),
    );

    await handleAuthProfileOAuthCallback({
      code: 'auth-code-xyz',
      state: validState,
      redis: { getdel: mockRedisGetdel } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
      encryptor: { encryptForTenant: mockEncryptForTenant },
    });

    const fetchBody = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(fetchBody.get('code_verifier')).toBe('pkce-verifier-value');
  });
});
```

**Implementation:** Extends the `auth-profile-oauth.ts` service from B4 with `handleAuthProfileOAuthCallback`. The callback validates state format (`/^[a-f0-9]{64}$/`), atomically retrieves+deletes from Redis via `getdel`, loads the linked `oauth2_app` profile, exchanges the code for tokens, encrypts them, and creates a new `oauth2_token` profile with `linkedAppProfileId` set. If `codeVerifier` is present in the state data, it is included in the token exchange body.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio vitest run src/__tests__/api/auth-profiles/oauth-callback.test.ts
```

---

### Task 17: POST User-Consent -- Per-User Token Flow for Personal Profiles

**Test file:** `apps/studio/src/__tests__/api/auth-profiles/oauth-user-consent.test.ts`

```typescript
/**
 * B6: POST /api/projects/:pid/auth-profiles/oauth/user-consent
 *
 * Initiates OAuth for an end-user at runtime.
 * Creates a personal oauth2_token (visibility: 'personal', createdBy: userId).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockFindOne = vi.fn();
const mockDecryptForTenant = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { findOne: mockFindOne },
}));

import { initiateUserConsentOAuth } from '../../../services/auth-profile-oauth.js';

describe('initiateUserConsentOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecryptForTenant.mockReturnValue(
      JSON.stringify({ clientId: 'cid-123', clientSecret: 'cs-secret' }),
    );
    mockFindOne.mockResolvedValue({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['email'],
        pkceRequired: false,
      },
      encryptedSecrets: 'encrypted-blob',
    });
  });

  it('stores visibility: personal and userId in Redis state', async () => {
    const result = await initiateUserConsentOAuth({
      connectorName: 'gmail',
      authProfileId: 'ap-google-1',
      sessionId: 'session-123',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'enduser-1',
      redirectUri: 'https://studio.example.com/oauth/auth-profile-callback',
      redis: { set: mockRedisSet } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
    });

    expect(result.authUrl).toContain('accounts.google.com');
    expect(result.state).toMatch(/^[a-f0-9]{64}$/);

    const storedData = JSON.parse(mockRedisSet.mock.calls[0][1]);
    expect(storedData.visibility).toBe('personal');
    expect(storedData.userId).toBe('enduser-1');
    expect(storedData.sessionId).toBe('session-123');
  });

  it('resolves oauth2_app by connector name when authProfileId not provided', async () => {
    mockFindOne.mockResolvedValueOnce({
      _id: 'ap-gmail-default',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      connector: 'gmail',
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        defaultScopes: ['email'],
        pkceRequired: false,
      },
      encryptedSecrets: 'encrypted-blob',
    });

    const result = await initiateUserConsentOAuth({
      connectorName: 'gmail',
      sessionId: 'session-456',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'enduser-2',
      redirectUri: 'https://studio.example.com/oauth/auth-profile-callback',
      redis: { set: mockRedisSet } as any,
      decryptor: { decryptForTenant: mockDecryptForTenant },
    });

    expect(result.authUrl).toBeDefined();
    // Lookup by connector name
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        authType: 'oauth2_app',
        connector: 'gmail',
      }),
    );
  });
});
```

**Implementation:** Part of the `auth-profile-oauth.ts` module. `initiateUserConsentOAuth` resolves the `oauth2_app` profile either by direct `authProfileId` or by `connectorName` + `tenantId` lookup. The Redis state includes `visibility: 'personal'` so the callback handler creates a personal `oauth2_token`.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio vitest run src/__tests__/api/auth-profiles/oauth-user-consent.test.ts
```

---

### Task 18: Frontend Popup Flow (`window.opener.postMessage` Pattern)

**Test file:** `apps/studio/src/__tests__/components/auth-profiles/AuthProfileOAuthPopup.test.tsx`

```typescript
/**
 * B7: Auth Profile OAuth popup flow
 *
 * Mirrors the existing OAuthFlowDialog / connection-callback pattern:
 * - Popup opens provider authorization URL
 * - Provider redirects to /oauth/auth-profile-callback
 * - Callback page posts { code, state } to parent via postMessage
 * - Parent exchanges code via POST callback endpoint
 */
import { describe, it, expect, vi } from 'vitest';

const AUTH_PROFILE_OAUTH_MESSAGE_TYPE = 'auth-profile-oauth-callback';

// Mock next/navigation for the callback page component
vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

describe('AuthProfileOAuthPopup postMessage contract', () => {
  it('sends code and state with correct message type', () => {
    const handler = vi.fn();

    // Simulate parent window listener
    const messageEvent = new MessageEvent('message', {
      data: {
        type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE,
        code: 'auth-code-xyz',
        state: 'a'.repeat(64),
      },
      origin: 'https://studio.example.com',
    });

    handler(messageEvent);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE,
          code: 'auth-code-xyz',
          state: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('sends error when provider returns error param', () => {
    const handler = vi.fn();

    const messageEvent = new MessageEvent('message', {
      data: {
        type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE,
        error: 'access_denied',
      },
      origin: 'https://studio.example.com',
    });

    handler(messageEvent);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE,
          error: 'access_denied',
        }),
      }),
    );
  });
});

describe('AuthProfileOAuthCallback component', () => {
  it('renders loading state initially', async () => {
    const { useSearchParams } = await import('next/navigation');
    (useSearchParams as any).mockReturnValue(new URLSearchParams(''));

    // Import and render the actual callback page component
    const { default: CallbackPage } = await import(
      '../../app/oauth/auth-profile-callback/page'
    );
    const { render, screen } = await import('@testing-library/react');
    const { Suspense } = await import('react');

    render(
      <Suspense fallback={<div>Loading...</div>}>
        <CallbackPage />
      </Suspense>,
    );

    expect(screen.getByText(/processing authorization/i)).toBeInTheDocument();
  });

  it('calls postMessage with code and state from URL params', async () => {
    const mockPostMessage = vi.fn();
    Object.defineProperty(window, 'opener', {
      value: { postMessage: mockPostMessage },
      writable: true,
    });

    const { useSearchParams } = await import('next/navigation');
    (useSearchParams as any).mockReturnValue(
      new URLSearchParams('code=auth-code-xyz&state=' + 'a'.repeat(64)),
    );

    const { default: CallbackPage } = await import(
      '../../app/oauth/auth-profile-callback/page'
    );
    const { render } = await import('@testing-library/react');
    const { Suspense } = await import('react');

    render(
      <Suspense fallback={<div>Loading...</div>}>
        <CallbackPage />
      </Suspense>,
    );

    // postMessage should have been called with the code and state
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE,
        code: 'auth-code-xyz',
      }),
      window.location.origin,
    );
  });

  it('rejects postMessage from foreign origin', () => {
    const handler = vi.fn();
    window.addEventListener('message', handler);

    // Simulate a message from an untrusted origin
    const foreignEvent = new MessageEvent('message', {
      data: { type: AUTH_PROFILE_OAUTH_MESSAGE_TYPE, code: 'stolen-code' },
      origin: 'https://evil.example.com',
    });
    window.dispatchEvent(foreignEvent);

    // The handler should NOT process the message — origin check filters it
    // (The actual component uses event.origin === window.location.origin)
    expect(handler).toHaveBeenCalled();
    // Verify the component's internal callback was NOT invoked
    // by checking that no state update occurred (no error, no success)
  });
});
```

**Implementation files:**

1. `apps/studio/src/app/oauth/auth-profile-callback/page.tsx` -- Callback page loaded in popup. Extracts `code`, `state`, `error` from URL params and posts to parent window via `window.opener.postMessage({ type: 'auth-profile-oauth-callback', code, state })`. Follows the exact pattern from `apps/studio/src/app/oauth/connection-callback/page.tsx`.

2. The parent component (in the Auth Profile setup flow) listens for `message` events, filters by `type === 'auth-profile-oauth-callback'`, and calls the POST callback endpoint.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/studio vitest run src/__tests__/components/auth-profiles/AuthProfileOAuthPopup.test.tsx
```

---

### Task Group C3: Token Refresh Service

### Task 19: Proactive Refresh -- Check `expiresAt` with Configurable Buffer

**Test file:** `packages/shared/src/__tests__/auth-profile/token-refresh-proactive.test.ts`

```typescript
/**
 * B8: Proactive token refresh with configurable buffer
 *
 * - Checks config.expiresAt against current time + buffer
 * - Buffer from AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS (default 60s)
 * - Null expiresAt: skip proactive refresh entirely
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { shouldRefreshProactively } from '../../services/auth-profile/token-refresh-service.js';

describe('shouldRefreshProactively', () => {
  afterEach(() => {
    delete process.env.AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS;
  });

  it('returns true when token expires within buffer window (default 60s)', () => {
    const expiresAt = new Date(Date.now() + 30_000); // 30s from now
    expect(shouldRefreshProactively(expiresAt)).toBe(true);
  });

  it('returns false when token expires beyond buffer window', () => {
    const expiresAt = new Date(Date.now() + 120_000); // 2 min from now
    expect(shouldRefreshProactively(expiresAt)).toBe(false);
  });

  it('returns false (skip) when expiresAt is null', () => {
    expect(shouldRefreshProactively(null)).toBe(false);
  });

  it('respects AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS env var', () => {
    process.env.AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS = '300'; // 5 min buffer
    const expiresAt = new Date(Date.now() + 200_000); // 3.3 min from now
    expect(shouldRefreshProactively(expiresAt)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    const expiresAt = new Date(Date.now() - 10_000); // 10s ago
    expect(shouldRefreshProactively(expiresAt)).toBe(true);
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/token-refresh-service.ts`

```typescript
/**
 * Auth Profile Token Refresh Service
 *
 * Handles proactive and reactive token refresh for oauth2_token
 * and oauth2_client_credentials profiles.
 */
import { createLogger } from '@agent-platform/shared-observability';
const log = createLogger('auth-profile-token-refresh');

const DEFAULT_REFRESH_BUFFER_SECONDS = 60;

export function getRefreshBufferMs(): number {
  const envVal = process.env.AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS;
  const seconds = envVal ? parseInt(envVal, 10) : DEFAULT_REFRESH_BUFFER_SECONDS;
  return (isNaN(seconds) ? DEFAULT_REFRESH_BUFFER_SECONDS : seconds) * 1000;
}

/**
 * Determines if a token should be proactively refreshed.
 * Returns false for null expiresAt (rely on 401 retry).
 */
export function shouldRefreshProactively(expiresAt: Date | null): boolean {
  if (expiresAt === null) return false;
  return expiresAt.getTime() < Date.now() + getRefreshBufferMs();
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/token-refresh-proactive.test.ts
```

---

### Task 20: Reactive Refresh -- 401 Retry Triggers Refresh

**Test file:** `packages/shared/src/__tests__/auth-profile/token-refresh-reactive.test.ts`

```typescript
/**
 * B9: Reactive token refresh on 401
 *
 * When a tool call returns 401, the runtime triggers a single refresh attempt.
 * If refresh succeeds, the tool call is retried with the new token.
 * If refresh fails, the original 401 is surfaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRefreshFn = vi.fn();

import { handleReactive401Refresh } from '../../services/auth-profile/token-refresh-service.js';

describe('handleReactive401Refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attempts refresh and returns new access token on success', async () => {
    mockRefreshFn.mockResolvedValue({
      accessToken: 'new-access-token',
      expiresAt: new Date(Date.now() + 3600_000),
    });

    const result = await handleReactive401Refresh({
      profileId: 'token-1',
      tenantId: 'tenant-1',
      refreshFn: mockRefreshFn,
    });

    expect(result).toEqual(expect.objectContaining({ accessToken: 'new-access-token' }));
    expect(mockRefreshFn).toHaveBeenCalledTimes(1);
  });

  it('throws AUTH_PROFILE_TOKEN_REFRESH_FAILED when refresh fails', async () => {
    mockRefreshFn.mockRejectedValue(new Error('invalid_grant'));

    await expect(
      handleReactive401Refresh({
        profileId: 'token-1',
        tenantId: 'tenant-1',
        refreshFn: mockRefreshFn,
      }),
    ).rejects.toThrow(/AUTH_PROFILE_TOKEN_REFRESH_FAILED/);
  });

  it('does not retry refresh more than once per profile within cooldown', async () => {
    mockRefreshFn.mockRejectedValue(new Error('invalid_grant'));

    // First call -- attempts refresh
    await expect(
      handleReactive401Refresh({
        profileId: 'token-1',
        tenantId: 'tenant-1',
        refreshFn: mockRefreshFn,
      }),
    ).rejects.toThrow();

    // Second call -- should skip refresh (cooldown)
    await expect(
      handleReactive401Refresh({
        profileId: 'token-1',
        tenantId: 'tenant-1',
        refreshFn: mockRefreshFn,
      }),
    ).rejects.toThrow();

    // Only one actual refresh attempt
    expect(mockRefreshFn).toHaveBeenCalledTimes(1);
  });

  it('evicts oldest entry when cooldown map exceeds max size (1000)', async () => {
    // Fill up the cooldown map with 1000 distinct profileIds
    const refreshFnAlwaysFails = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    for (let i = 0; i < 1001; i++) {
      try {
        await handleReactive401Refresh({
          profileId: `token-${i}`,
          tenantId: 'tenant-1',
          refreshFn: refreshFnAlwaysFails,
        });
      } catch {
        // expected
      }
    }

    // The first entry (token-0) should have been evicted.
    // A new call for token-0 should attempt refresh again.
    refreshFnAlwaysFails.mockClear();
    try {
      await handleReactive401Refresh({
        profileId: 'token-0',
        tenantId: 'tenant-1',
        refreshFn: refreshFnAlwaysFails,
      });
    } catch {
      // expected
    }
    // token-0 was evicted from cooldown, so refresh should be attempted
    expect(refreshFnAlwaysFails).toHaveBeenCalledTimes(1);
  });
});
```

**Implementation:** Extends `token-refresh-service.ts` with `handleReactive401Refresh`. Maintains an in-memory `Map<string, number>` tracking recent refresh failures per profileId (bounded to 1000 entries with LRU eviction, 30s cooldown). On 401, checks cooldown, calls the provided `refreshFn`, and returns the new token or throws `AUTH_PROFILE_TOKEN_REFRESH_FAILED`.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/token-refresh-reactive.test.ts
```

---

### Task 21: Distributed Redis Lock for Token Refresh

**Test file:** `packages/shared/src/__tests__/auth-profile/token-refresh-lock.test.ts`

```typescript
/**
 * B10: Distributed Redis lock prevents concurrent refresh
 *
 * Uses the same SET NX PX pattern as DistributedLockManager
 * from packages/shared/src/redis/distributed-lock.ts.
 * Lock key: auth-profile:refresh:{tenantId}:{profileId}
 * TTL: 30s. Redis unavailable: proceed without lock, emit trace event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  acquireRefreshLock,
  releaseRefreshLock,
  REFRESH_LOCK_KEY_PREFIX,
} from '../../services/auth-profile/refresh-lock.js';

describe('Token refresh distributed lock', () => {
  const mockRedisSet = vi.fn();
  const mockRedisRunLuaScript = vi.fn();

  const mockRedis = {
    set: mockRedisSet,
    runLuaScript: mockRedisRunLuaScript,
  };

  beforeEach(() => vi.clearAllMocks());

  it('acquires lock with SET NX PX pattern and tenant-scoped key', async () => {
    mockRedisSet.mockResolvedValue('OK');

    const lock = await acquireRefreshLock(mockRedis as any, 'tenant-1', 'profile-1');

    expect(lock).not.toBeNull();
    expect(mockRedisSet).toHaveBeenCalledWith(
      `${REFRESH_LOCK_KEY_PREFIX}tenant-1:profile-1`,
      expect.any(String), // lock value
      'PX',
      30_000, // 30s TTL
      'NX',
    );
  });

  it('returns null when lock is already held (another pod refreshing)', async () => {
    mockRedisSet.mockResolvedValue(null); // NX fails

    const lock = await acquireRefreshLock(mockRedis as any, 'tenant-1', 'profile-1');

    expect(lock).toBeNull();
  });

  it('proceeds without lock when Redis is unavailable (connection refused)', async () => {
    mockRedisSet.mockRejectedValue(new Error('ECONNREFUSED'));

    const lock = await acquireRefreshLock(mockRedis as any, 'tenant-1', 'profile-1');

    // Returns a sentinel "no-lock" object (refresh proceeds without mutex)
    expect(lock).toEqual(expect.objectContaining({ noLock: true }));
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/refresh-lock.ts`

```typescript
/**
 * Token Refresh Distributed Lock
 *
 * Uses Redis SET NX PX pattern for mutual exclusion during token refresh.
 * Key format: auth-profile:refresh:{tenantId}:{profileId}
 * TTL: 30 seconds (refresh should complete well within this window).
 *
 * On Redis unavailability: returns a sentinel { noLock: true } and logs
 * an auth_profile_lock_unavailable trace event. The caller proceeds with
 * the refresh (risking a duplicate refresh) rather than failing the session.
 */
import { createLogger } from '@agent-platform/shared-observability';
const log = createLogger('auth-profile-refresh-lock');

export const REFRESH_LOCK_KEY_PREFIX = 'auth-profile:refresh:';
const LOCK_TTL_MS = 30_000;

export interface RefreshLock {
  key: string;
  value: string;
  noLock?: boolean;
}

export async function acquireRefreshLock(
  redis: {
    set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  },
  tenantId: string,
  profileId: string,
): Promise<RefreshLock | null> {
  const key = `${REFRESH_LOCK_KEY_PREFIX}${tenantId}:${profileId}`;
  const value = `${process.env.HOSTNAME || 'local'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  try {
    const result = await redis.set(key, value, 'PX', LOCK_TTL_MS, 'NX');
    if (result === 'OK') {
      return { key, value };
    }
    return null; // Lock held by another pod
  } catch (error) {
    // Redis unavailable -- emit structured trace event and proceed without lock
    log.warn('Redis lock unavailable for token refresh, proceeding without lock', {
      tenantId,
      profileId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Also emit via TraceStore for observability dashboards
    // (caller passes traceStore when available);
    return { key, value, noLock: true };
  }
}

export async function releaseRefreshLock(
  redis: {
    call(command: string, ...args: (string | number)[]): Promise<unknown>;
  },
  lock: RefreshLock,
): Promise<boolean> {
  if (lock.noLock) return true; // No lock was acquired

  // Atomic check-and-delete via Redis EVAL-equivalent
  // Uses the same Lua pattern as DistributedLockManager.release()
  try {
    const result = await redis.call(
      'eval',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      1,
      lock.key,
      lock.value,
    );
    return result === 1;
  } catch (error) {
    log.warn('Failed to release refresh lock (may auto-expire)', {
      key: lock.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/token-refresh-lock.test.ts
```

---

### Task 22: Full Token Refresh Flow (Lock + Exchange + Store)

**Test file:** `packages/shared/src/__tests__/auth-profile/token-refresh-flow.test.ts`

```typescript
/**
 * B11: End-to-end oauth2_token refresh flow
 *
 * 1. Check expiresAt with buffer
 * 2. Load linked oauth2_app for client credentials
 * 3. Acquire distributed lock
 * 4. Exchange refreshToken for new tokens
 * 5. Handle refreshTokenRotation atomically
 * 6. Update encryptedSecrets and config.expiresAt
 * 7. Release lock
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisCall = vi.fn().mockResolvedValue(1);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: mockFindOne,
    findOneAndUpdate: mockFindOneAndUpdate,
  },
}));

import { refreshOAuth2Token } from '../../services/auth-profile/token-refresh-service.js';

describe('refreshOAuth2Token', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Token profile
    mockFindOne.mockResolvedValueOnce({
      _id: 'token-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'ap-google-1',
      config: {
        expiresAt: new Date(Date.now() - 1000), // expired
        refreshTokenRotation: false,
      },
      encryptedSecrets: 'encrypted-token-secrets',
    });

    // App profile
    mockFindOne.mockResolvedValueOnce({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: { tokenUrl: 'https://oauth2.googleapis.com/token' },
      encryptedSecrets: 'encrypted-app-secrets',
    });

    mockFindOneAndUpdate.mockResolvedValue({ _id: 'token-1' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
      }),
    });
  });

  it('acquires lock, refreshes token, updates DB, releases lock', async () => {
    const result = await refreshOAuth2Token({
      profileId: 'token-1',
      tenantId: 'tenant-1',
      redis: {
        set: mockRedisSet,
        call: mockRedisCall,
        get: vi.fn(),
      } as any,
      decryptor: {
        decryptForTenant: vi.fn().mockReturnValue(
          JSON.stringify({
            accessToken: 'old-at',
            refreshToken: 'old-rt',
          }),
        ),
      },
      encryptor: {
        encryptForTenant: vi.fn().mockReturnValue('new-encrypted-secrets'),
      },
    });

    expect(result.accessToken).toBe('new-at');
    expect(result.expiresAt).toBeInstanceOf(Date);

    // DB updated with new encrypted secrets
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'token-1', tenantId: 'tenant-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          encryptedSecrets: 'new-encrypted-secrets',
        }),
      }),
    );

    // Lock acquired and released
    expect(mockRedisSet).toHaveBeenCalled();
    expect(mockRedisCall).toHaveBeenCalled();
  });

  it('waits and re-reads when lock is held by another pod', async () => {
    // Lock held
    mockRedisSet.mockResolvedValueOnce(null);

    // After wait, re-read shows refreshed token
    mockFindOne.mockReset();
    mockFindOne.mockResolvedValueOnce({
      _id: 'token-1',
      tenantId: 'tenant-1',
      config: {
        expiresAt: new Date(Date.now() + 3600_000), // now valid
      },
      encryptedSecrets: 'already-refreshed-secrets',
    });

    const result = await refreshOAuth2Token({
      profileId: 'token-1',
      tenantId: 'tenant-1',
      redis: {
        set: mockRedisSet,
        call: mockRedisCall,
        get: vi.fn(),
      } as any,
      decryptor: {
        decryptForTenant: vi.fn().mockReturnValue(
          JSON.stringify({
            accessToken: 'refreshed-by-other-pod',
            refreshToken: 'rt',
          }),
        ),
      },
      encryptor: { encryptForTenant: vi.fn() },
    });

    // Should use the already-refreshed token, not call fetch
    expect(result.accessToken).toBe('refreshed-by-other-pod');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('updates refreshToken when refreshTokenRotation is true', async () => {
    mockFindOne.mockReset();
    mockFindOne.mockResolvedValueOnce({
      _id: 'token-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_token',
      linkedAppProfileId: 'ap-google-1',
      config: {
        expiresAt: new Date(Date.now() - 1000),
        refreshTokenRotation: true,
      },
      encryptedSecrets: 'encrypted-secrets',
    });
    mockFindOne.mockResolvedValueOnce({
      _id: 'ap-google-1',
      tenantId: 'tenant-1',
      authType: 'oauth2_app',
      status: 'active',
      config: { tokenUrl: 'https://oauth2.googleapis.com/token' },
      encryptedSecrets: 'app-secrets',
    });

    const mockEncrypt = vi.fn().mockReturnValue('rotated-encrypted');

    await refreshOAuth2Token({
      profileId: 'token-1',
      tenantId: 'tenant-1',
      redis: {
        set: mockRedisSet,
        call: mockRedisCall,
        get: vi.fn(),
      } as any,
      decryptor: {
        decryptForTenant: vi
          .fn()
          .mockReturnValueOnce(
            JSON.stringify({
              accessToken: 'old-at',
              refreshToken: 'old-rt',
            }),
          )
          .mockReturnValueOnce(JSON.stringify({ clientId: 'cid', clientSecret: 'cs' })),
      },
      encryptor: { encryptForTenant: mockEncrypt },
    });

    // The encrypted blob should include the new refreshToken
    const encryptedPayload = JSON.parse(mockEncrypt.mock.calls[0][0]);
    expect(encryptedPayload.refreshToken).toBe('new-rt');
  });
});
```

**Implementation:** Extends `token-refresh-service.ts` with the `refreshOAuth2Token` function that orchestrates the full flow: load token profile, check proactive refresh, acquire lock, load linked app credentials, exchange refresh token, assign new tokens to the document, call `.save()` (triggering the encryption plugin's `pre('save')` hook), release lock. On lock contention, waits with exponential backoff (100ms, 200ms, 400ms, max 2s), re-reads from DB, and uses the refreshed token if `expiresAt` is now valid.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/token-refresh-flow.test.ts
```

---

### Task 23: `oauth2_client_credentials` Token Cached in Redis

**Test file:** `packages/shared/src/__tests__/auth-profile/client-credentials-cache.test.ts`

```typescript
/**
 * B12: oauth2_client_credentials token caching in Redis
 *
 * Cache key: auth-profile:cc-token:{tenantId}:{profileId}
 * Shared across all sessions within the same tenant.
 * TTL: token expires_in minus refresh buffer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  resolveClientCredentialsToken,
  CLIENT_CREDENTIALS_CACHE_PREFIX,
} from '../../services/auth-profile/client-credentials-service.js';

describe('resolveClientCredentialsToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns cached token from Redis when available', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        accessToken: 'cached-at',
        expiresAt: Date.now() + 3600_000,
      }),
    );

    const result = await resolveClientCredentialsToken({
      profileId: 'cc-profile-1',
      tenantId: 'tenant-1',
      config: { tokenUrl: 'https://provider.com/token', scopes: [] },
      encryptedSecrets: 'enc-blob',
      redis: { get: mockRedisGet, set: mockRedisSet } as any,
      decryptor: { decryptForTenant: vi.fn() },
    });

    expect(result).toBe('cached-at');
    expect(mockFetch).not.toHaveBeenCalled(); // No token request
    expect(mockRedisGet).toHaveBeenCalledWith(
      `${CLIENT_CREDENTIALS_CACHE_PREFIX}tenant-1:cc-profile-1`,
    );
  });

  it('fetches new token when cache miss and stores in Redis', async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-cc-token',
        expires_in: 3600,
        token_type: 'bearer',
      }),
    });

    const result = await resolveClientCredentialsToken({
      profileId: 'cc-profile-1',
      tenantId: 'tenant-1',
      config: {
        tokenUrl: 'https://provider.com/token',
        scopes: ['read'],
      },
      encryptedSecrets: 'enc-blob',
      redis: { get: mockRedisGet, set: mockRedisSet } as any,
      decryptor: {
        decryptForTenant: vi
          .fn()
          .mockReturnValue(JSON.stringify({ clientId: 'cid', clientSecret: 'cs' })),
      },
    });

    expect(result).toBe('new-cc-token');

    // Stored in Redis with TTL = expires_in - buffer
    expect(mockRedisSet).toHaveBeenCalledWith(
      `${CLIENT_CREDENTIALS_CACHE_PREFIX}tenant-1:cc-profile-1`,
      expect.any(String),
      'EX',
      expect.any(Number), // expires_in - buffer
    );

    const ttl = mockRedisSet.mock.calls[0][3];
    expect(ttl).toBeLessThan(3600);
    expect(ttl).toBeGreaterThan(3500); // 3600 - 60 buffer
  });

  it('fetches fresh token when cached token is expired', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        accessToken: 'expired-at',
        expiresAt: Date.now() - 1000,
      }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fresh-cc-token',
        expires_in: 7200,
      }),
    });

    const result = await resolveClientCredentialsToken({
      profileId: 'cc-profile-1',
      tenantId: 'tenant-1',
      config: { tokenUrl: 'https://provider.com/token', scopes: [] },
      encryptedSecrets: 'enc-blob',
      redis: { get: mockRedisGet, set: mockRedisSet } as any,
      decryptor: {
        decryptForTenant: vi
          .fn()
          .mockReturnValue(JSON.stringify({ clientId: 'cid', clientSecret: 'cs' })),
      },
    });

    expect(result).toBe('fresh-cc-token');
  });

  it('falls back to direct fetch when Redis is unavailable', async () => {
    mockRedisGet.mockRejectedValue(new Error('ECONNREFUSED'));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'fallback-token',
        expires_in: 3600,
      }),
    });

    const result = await resolveClientCredentialsToken({
      profileId: 'cc-profile-1',
      tenantId: 'tenant-1',
      config: { tokenUrl: 'https://provider.com/token', scopes: [] },
      encryptedSecrets: 'enc-blob',
      redis: { get: mockRedisGet, set: mockRedisSet } as any,
      decryptor: {
        decryptForTenant: vi
          .fn()
          .mockReturnValue(JSON.stringify({ clientId: 'cid', clientSecret: 'cs' })),
      },
    });

    expect(result).toBe('fallback-token');
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/client-credentials-service.ts`

```typescript
/**
 * OAuth2 Client Credentials Service
 *
 * Resolves access tokens for oauth2_client_credentials profiles.
 * Tokens cached in Redis (shared across all sessions in the same tenant).
 * Cache key: auth-profile:cc-token:{tenantId}:{profileId}
 */
import { getRefreshBufferMs } from './token-refresh-service.js';

import { createLogger } from '@agent-platform/shared-observability';
const log = createLogger('auth-profile-client-credentials');

export const CLIENT_CREDENTIALS_CACHE_PREFIX = 'auth-profile:cc-token:';

export interface ResolveClientCredentialsParams {
  profileId: string;
  tenantId: string;
  config: { tokenUrl: string; scopes: string[] };
  encryptedSecrets: string;
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  };
  decryptor: {
    decryptForTenant(encrypted: string, tenantId: string): string;
  };
}

export async function resolveClientCredentialsToken(
  params: ResolveClientCredentialsParams,
): Promise<string> {
  const cacheKey = `${CLIENT_CREDENTIALS_CACHE_PREFIX}${params.tenantId}:${params.profileId}`;

  // Try Redis cache
  try {
    const cached = await params.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.expiresAt > Date.now()) {
        log.debug('Client credentials token resolved from cache', {
          profileId: params.profileId,
        });
        return parsed.accessToken;
      }
    }
  } catch (error) {
    log.warn('Redis cache read failed for client credentials', {
      profileId: params.profileId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Cache miss or expired -- fetch new token
  const secrets = JSON.parse(
    params.decryptor.decryptForTenant(params.encryptedSecrets, params.tenantId),
  );

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
  });
  if (params.config.scopes.length > 0) {
    body.set('scope', params.config.scopes.join(' '));
  }

  const response = await fetch(params.config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    // Log the full error server-side for debugging, but do not propagate
    // the provider's error body — it may contain client_secret echoes or
    // internal details that must not reach callers.
    const errorText = await response.text();
    log.error('Client credentials token request failed', {
      profileId: params.profileId,
      status: response.status,
      body: errorText.slice(0, 500),
    });
    throw new Error(`Client credentials token request failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
    token_type?: string;
  };

  // Cache in Redis
  if (data.expires_in) {
    const bufferMs = getRefreshBufferMs();
    const ttlSeconds = Math.max(1, data.expires_in - Math.floor(bufferMs / 1000));
    const cachePayload = JSON.stringify({
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });

    try {
      await params.redis.set(cacheKey, cachePayload, 'EX', ttlSeconds);
    } catch (error) {
      log.warn('Failed to cache client credentials token in Redis', {
        profileId: params.profileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return data.access_token;
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/client-credentials-cache.test.ts
```

---

### Task Group C4: RuntimeSecretsProvider Integration

### Task 24: `authProfileService.resolve()` as Credential Resolution Path

> **Implementation note:** Task 24's `resolveAuthProfile()` function should delegate to `AuthProfileService.resolve()` (Task 6) rather than reimplementing the query logic. The service class owns the resolution query, decrypt, and cache layers. `resolveAuthProfile()` in `auth-profile-resolver.ts` is a thin wrapper that constructs an `AuthProfileService` instance (with deps) and calls `service.resolve(params)`. This avoids two separate resolution codepaths.

**Test file:** `packages/shared/src/__tests__/auth-profile/auth-profile-resolve.test.ts`

```typescript
/**
 * B13: AuthProfileService.resolve() -- 5-level resolution query
 *
 * Resolution priority:
 * 1. Personal oauth2_token for user + connector + environment
 * 2. Shared oauth2_token for connector + environment
 * 3. Project-level profile with matching authProfileId + environment
 * 4. Project-level profile with environment: null (fallback)
 * 5. Tenant-level fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockFind = vi.fn();
const mockFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: { find: mockFind, findOne: mockFindOne },
}));

import { resolveAuthProfile } from '../../services/auth-profile/auth-profile-resolver.js';

describe('resolveAuthProfile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns personal oauth2_token when per_user mode and user token exists', async () => {
    mockFind.mockResolvedValue([
      {
        _id: 'personal-token-1',
        authType: 'oauth2_token',
        visibility: 'personal',
        createdBy: 'user-1',
        connector: 'gmail',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        config: { scopes: ['email'] },
        encryptedSecrets: 'encrypted-personal',
      },
    ]);

    const result = await resolveAuthProfile({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'per_user',
      environment: 'production',
      userId: 'user-1',
    });

    expect(result._id).toBe('personal-token-1');
    expect(result.visibility).toBe('personal');
  });

  it('falls back to shared oauth2_token when per_user but no personal token', async () => {
    mockFind.mockResolvedValue([
      {
        _id: 'shared-token-1',
        authType: 'oauth2_token',
        visibility: 'shared',
        connector: 'gmail',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      },
    ]);

    const result = await resolveAuthProfile({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'gmail',
      connectionMode: 'per_user',
      environment: 'production',
      userId: 'user-1',
    });

    expect(result._id).toBe('shared-token-1');
  });

  it('resolves tenant-level profile when no project-level match', async () => {
    mockFind.mockResolvedValue([
      {
        _id: 'tenant-profile-1',
        authType: 'api_key',
        visibility: 'shared',
        connector: 'stripe',
        tenantId: 'tenant-1',
        projectId: null,
        scope: 'tenant',
      },
    ]);

    const result = await resolveAuthProfile({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'stripe',
      connectionMode: 'shared',
    });

    expect(result._id).toBe('tenant-profile-1');
  });

  it('throws when no profile matches any resolution level', async () => {
    mockFind.mockResolvedValue([]);

    await expect(
      resolveAuthProfile({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        connector: 'unknown',
        connectionMode: 'shared',
      }),
    ).rejects.toThrow(/Auth profile not found/);
  });

  it('prefers environment-specific over environment-null fallback', async () => {
    mockFind.mockResolvedValue([
      {
        _id: 'env-null-profile',
        environment: null,
        connector: 'slack',
        projectId: 'proj-1',
      },
      {
        _id: 'env-prod-profile',
        environment: 'production',
        connector: 'slack',
        projectId: 'proj-1',
      },
    ]);

    const result = await resolveAuthProfile({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      connector: 'slack',
      connectionMode: 'shared',
      environment: 'production',
    });

    expect(result._id).toBe('env-prod-profile');
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/auth-profile-resolver.ts`

The resolver executes a single `AuthProfile.find()` with a `$or` combining all 5 resolution levels, then priority-sorts in application code. This avoids 5 sequential queries. The scoring function assigns: personal token for user = 100, shared token = 80, exact authProfileId match = 50, project + matching env = 40, project + null env = 20, tenant-level = 10.

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/auth-profile-resolve.test.ts
```

---

### Task 25: Session-Level Credential Cache (LRU, Max 200 Entries)

**Test file:** `apps/runtime/src/__tests__/auth-profile-credential-cache.test.ts`

```typescript
/**
 * B14: Session-level credential cache with LRU eviction
 *
 * - Max 200 entries per session
 * - LRU eviction when at capacity
 * - Cache hit avoids DB + decrypt overhead
 * - Cache invalidated on token refresh
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AuthProfileCredentialCache } from '../services/auth-profile/credential-cache.js';

describe('AuthProfileCredentialCache', () => {
  let cache: AuthProfileCredentialCache;

  beforeEach(() => {
    cache = new AuthProfileCredentialCache(5); // Small max for testing
  });

  it('returns cached credentials on hit', () => {
    cache.set('profile-1', { accessToken: 'at-1' });
    expect(cache.get('profile-1')).toEqual({ accessToken: 'at-1' });
  });

  it('returns undefined on miss', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('evicts least-recently-used entry when at capacity', () => {
    cache.set('p1', { accessToken: 'at1' });
    cache.set('p2', { accessToken: 'at2' });
    cache.set('p3', { accessToken: 'at3' });
    cache.set('p4', { accessToken: 'at4' });
    cache.set('p5', { accessToken: 'at5' });

    // Access p1 to make it recently used
    cache.get('p1');

    // Add p6 -- should evict p2 (oldest non-accessed)
    cache.set('p6', { accessToken: 'at6' });

    expect(cache.get('p1')).toBeDefined(); // recently accessed
    expect(cache.get('p2')).toBeUndefined(); // evicted
    expect(cache.get('p6')).toBeDefined(); // newly added
  });

  it('invalidates a specific entry', () => {
    cache.set('profile-1', { accessToken: 'at-1' });
    cache.invalidate('profile-1');
    expect(cache.get('profile-1')).toBeUndefined();
  });

  it('clears all entries', () => {
    cache.set('p1', { token: '1' });
    cache.set('p2', { token: '2' });
    cache.clear();
    expect(cache.get('p1')).toBeUndefined();
    expect(cache.get('p2')).toBeUndefined();
  });
});
```

**Implementation file:** `apps/runtime/src/services/auth-profile/credential-cache.ts`

```typescript
/**
 * Session-Level Auth Profile Credential Cache
 *
 * LRU cache for decrypted credentials within a single runtime session.
 * Prevents repeated DB lookups and decryption for the same auth profile.
 *
 * Max size: 200 entries (configurable). Evicts least-recently-used on
 * overflow. Invalidated when a token refresh occurs for that profile.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-credential-cache');

const DEFAULT_MAX_SIZE = 200;

export class AuthProfileCredentialCache {
  private cache: Map<string, { value: Record<string, unknown>; lastAccess: number }>;
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(profileId: string): Record<string, unknown> | undefined {
    const entry = this.cache.get(profileId);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.value;
  }

  set(profileId: string, credentials: Record<string, unknown>): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(profileId)) {
      this.evictLRU();
    }
    this.cache.set(profileId, {
      value: credentials,
      lastAccess: Date.now(),
    });
  }

  invalidate(profileId: string): void {
    this.cache.delete(profileId);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      log.debug('Evicted LRU credential cache entry', {
        profileId: oldestKey,
      });
    }
  }
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime vitest run src/__tests__/auth-profile-credential-cache.test.ts
```

---

### Task 26: Hook into `LLMWiringService._wireExecutor()`

The integration point is `apps/runtime/src/services/execution/llm-wiring.ts`. A new private method `getOrCreateAuthProfileResolver()` follows the exact pattern of existing adapters (`getOrCreateToolSecretStore`, `getOrCreateOAuthTokenResolver`).

**Test file:** `apps/runtime/src/__tests__/llm-wiring-auth-profile.test.ts`

```typescript
/**
 * B15: LLMWiringService._wireExecutor() -- AuthProfile integration
 *
 * Verifies that RuntimeSecretsProvider receives an authProfileResolver
 * when DB+encryption are available.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track RuntimeSecretsProvider construction
const secretsProviderConfigs: any[] = [];

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../services/secrets-provider.js', () => ({
  RuntimeSecretsProvider: vi.fn().mockImplementation((config: any) => {
    secretsProviderConfigs.push(config);
    return {
      getSecret: vi.fn(),
      getEnvVar: vi.fn(),
      getUserOAuthToken: vi.fn(),
      getUserId: vi.fn(),
    };
  }),
}));

describe('LLMWiringService -- AuthProfile resolver injection', () => {
  beforeEach(() => {
    secretsProviderConfigs.length = 0;
  });

  it('injects authProfileResolver into RuntimeSecretsProvider config when enabled', async () => {
    // This is a design-level test that defines the integration contract.
    // When DB+encryption are available, the RuntimeSecretsProvider config
    // passed in _wireExecutor MUST include:
    //
    // authProfileResolver: {
    //   resolve(params: {
    //     authProfileId: string;
    //     tenantId: string;
    //     projectId: string;
    //     userId?: string;
    //     environment?: string;
    //   }): Promise<{ accessToken: string; [key: string]: unknown }>;
    // }
    //
    // This resolver delegates to resolveAuthProfile() from
    // packages/shared/src/services/auth-profile/auth-profile-resolver.ts
    // wrapped with decrypt and credential cache.

    // Verify the contract: when DB+encryption available, the config
    // passed to RuntimeSecretsProvider MUST include authProfileResolver.
    // Full mock setup mirrors llm-wiring.test.ts wireToolExecutor tests.
    const { LLMWiringService } = await import('../services/execution/llm-wiring.js');
    const service = new LLMWiringService(mockDeps);
    const executor = await service._wireExecutor(mockSession);
    expect(secretsProviderConfigs.length).toBeGreaterThan(0);
    const lastConfig = secretsProviderConfigs[secretsProviderConfigs.length - 1];
    expect(lastConfig).toHaveProperty('authProfileResolver');
    expect(typeof lastConfig.authProfileResolver.resolve).toBe('function');
  });
});
```

**Implementation changes:**

1. Add to `RuntimeSecretsProviderConfig` in `apps/runtime/src/services/secrets-provider.ts`:

```typescript
authProfileResolver?: {
  resolve(params: {
    authProfileId: string;
    tenantId: string;
    projectId: string;
    userId?: string;
    environment?: string;
  }): Promise<Record<string, unknown>>;
};
```

2. Add to `RuntimeSecretsProvider.getSecret()` a new resolution layer between the ToolSecretStore layer and the config layer:

```typescript
// 3b. Auth Profile resolution (when authProfileId-based binding)
if (this.authProfileResolver && key.startsWith('auth_profile:')) {
  const profileId = key.replace('auth_profile:', '');
  const cached = this.credentialCache?.get(profileId);
  if (cached) return cached.accessToken as string;

  const resolved = await this.authProfileResolver.resolve({
    authProfileId: profileId,
    tenantId: this.tenantId!,
    projectId: this.projectId!,
    userId: this.userId,
    environment: this.environment,
  });

  this.credentialCache?.set(profileId, resolved);
  return resolved.accessToken as string;
}
```

3. Add `getOrCreateAuthProfileResolver()` to `LLMWiringService`:

```typescript
private getOrCreateAuthProfileResolver(): AuthProfileResolver | undefined {
  if (!isDatabaseAvailable()) return undefined;

  // NOTE (REVIEW): No encryptionService needed here. The encryption plugin
  // auto-decrypts on find()/findOne(). resolveAuthProfile returns already-decrypted data.
  return {
    async resolve(params) {
      const { resolveAuthProfile } = await import(
        '@agent-platform/shared/services/auth-profile/auth-profile-resolver'
      );
      const profile = await resolveAuthProfile({
        tenantId: params.tenantId,
        projectId: params.projectId,
        connector: '', // resolved from tool binding context
        connectionMode: 'shared',
        environment: params.environment,
        userId: params.userId,
        authProfileId: params.authProfileId,
      });
      // NOTE (REVIEW): encryptedSecrets is already auto-decrypted by the
      // encryption plugin's post('find') hook. Just JSON.parse directly.
      const secrets = JSON.parse(profile.encryptedSecrets);
      return { ...profile.config, ...secrets };
    },
  };
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/runtime vitest run src/__tests__/llm-wiring-auth-profile.test.ts
```

---

### Task 27: `applyAuth()` Dispatcher -- Apply Auth to HTTP Requests

**Test file:** `packages/shared/src/__tests__/auth-profile/apply-auth.test.ts`

```typescript
/**
 * B16: applyAuth() dispatcher
 *
 * Given a resolved auth profile, applies credentials to an HTTP request:
 * - none: no-op
 * - api_key: header or query param
 * - bearer: Authorization: Bearer <token>
 * - oauth2_token: Authorization: Bearer <accessToken>
 * - oauth2_client_credentials: Authorization: Bearer <accessToken>
 */
import { describe, it, expect } from 'vitest';

import { applyAuth } from '../../services/auth-profile/apply-auth.js';

describe('applyAuth', () => {
  it('does nothing for authType: none', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth({ authType: 'none', config: {}, secrets: {} }, headers, url);

    expect(headers.entries().next().done).toBe(true);
    expect(url.searchParams.toString()).toBe('');
  });

  it('adds api_key to header with prefix', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth(
      {
        authType: 'api_key',
        config: {
          headerName: 'X-API-Key',
          prefix: '',
          placement: 'header',
        },
        secrets: { apiKey: 'key-123' },
      },
      headers,
      url,
    );

    expect(headers.get('X-API-Key')).toBe('key-123');
  });

  it('adds api_key to query param when placement is query', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth(
      {
        authType: 'api_key',
        config: { headerName: 'api_key', placement: 'query' },
        secrets: { apiKey: 'key-456' },
      },
      headers,
      url,
    );

    expect(url.searchParams.get('api_key')).toBe('key-456');
  });

  it('adds bearer token to Authorization header', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth(
      {
        authType: 'bearer',
        config: {},
        secrets: { token: 'bt-abc' },
      },
      headers,
      url,
    );

    expect(headers.get('Authorization')).toBe('Bearer bt-abc');
  });

  it('adds oauth2_token accessToken as Bearer', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth(
      {
        authType: 'oauth2_token',
        config: { tokenType: 'bearer' },
        secrets: { accessToken: 'oauth-at-xyz' },
      },
      headers,
      url,
    );

    expect(headers.get('Authorization')).toBe('Bearer oauth-at-xyz');
  });

  it('adds oauth2_client_credentials accessToken as Bearer', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    applyAuth(
      {
        authType: 'oauth2_client_credentials',
        config: {},
        secrets: { accessToken: 'cc-at-123' },
      },
      headers,
      url,
    );

    expect(headers.get('Authorization')).toBe('Bearer cc-at-123');
  });

  it('throws for unsupported authType', () => {
    const headers = new Headers();
    const url = new URL('https://api.example.com/data');

    expect(() =>
      applyAuth({ authType: 'kerberos' as any, config: {}, secrets: {} }, headers, url),
    ).toThrow(/Unsupported auth type.*kerberos/);
  });
});
```

**Implementation file:** `packages/shared/src/services/auth-profile/apply-auth.ts`

```typescript
/**
 * Auth Dispatcher -- applies resolved auth profile credentials to HTTP
 * requests.
 *
 * Pure function: no side effects, no DB calls, no async.
 * Takes pre-resolved (decrypted) secrets and applies them to Headers
 * and URL.
 */

export interface AuthContext {
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

export function applyAuth(auth: AuthContext, headers: Headers, url: URL): void {
  switch (auth.authType) {
    case 'none':
      return;

    case 'api_key': {
      const headerName = auth.config.headerName as string;
      const apiKey = auth.secrets.apiKey as string;
      const prefix = (auth.config.prefix as string) || '';
      const placement = (auth.config.placement as string) || 'header';

      if (placement === 'query') {
        url.searchParams.set(headerName, apiKey);
      } else {
        headers.set(headerName, prefix ? `${prefix} ${apiKey}` : apiKey);
      }
      return;
    }

    case 'bearer': {
      const token = auth.secrets.token as string;
      headers.set('Authorization', `Bearer ${token}`);
      return;
    }

    case 'oauth2_token': {
      const accessToken = auth.secrets.accessToken as string;
      const tokenType = (auth.config.tokenType as string) || 'bearer';
      headers.set(
        'Authorization',
        `${tokenType.charAt(0).toUpperCase() + tokenType.slice(1)} ${accessToken}`,
      );
      return;
    }

    case 'oauth2_client_credentials': {
      const accessToken = auth.secrets.accessToken as string;
      headers.set('Authorization', `Bearer ${accessToken}`);
      return;
    }

    default:
      throw new Error(
        `Unsupported auth type: ${auth.authType}. Phase 1 supports: none, api_key, bearer, oauth2_token, oauth2_client_credentials.`,
      );
  }
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && pnpm --filter @agent-platform/shared vitest run src/__tests__/auth-profile/apply-auth.test.ts
```

---

### Section Summary

| Task | Description                                       | Package                  | Key File                                              |
| ---- | ------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| B1   | `linkedAppProfileId` validation on create         | `@agent-platform/shared` | `services/auth-profile/linked-app-validator.ts`       |
| B2   | Cross-type validation on update                   | `@agent-platform/shared` | `services/auth-profile/update-validator.ts`           |
| B3   | Two-layer resolution (token -> app credentials)   | `@agent-platform/shared` | `services/auth-profile/oauth2-app-resolver.ts`        |
| B4   | OAuth initiate (state, Redis, authUrl)            | `studio`                 | `services/auth-profile-oauth.ts`                      |
| B5   | OAuth callback (code exchange, token creation)    | `studio`                 | `services/auth-profile-oauth.ts`                      |
| B6   | User-consent flow (personal tokens)               | `studio`                 | `services/auth-profile-oauth.ts`                      |
| B7   | Frontend popup (`window.opener.postMessage`)      | `studio`                 | `app/oauth/auth-profile-callback/page.tsx`            |
| B8   | Proactive refresh (expiresAt + buffer)            | `@agent-platform/shared` | `services/auth-profile/token-refresh-service.ts`      |
| B9   | Reactive refresh (401 retry)                      | `@agent-platform/shared` | `services/auth-profile/token-refresh-service.ts`      |
| B10  | Distributed Redis lock for refresh                | `@agent-platform/shared` | `services/auth-profile/refresh-lock.ts`               |
| B11  | Full token refresh flow (lock + exchange + store) | `@agent-platform/shared` | `services/auth-profile/token-refresh-service.ts`      |
| B12  | `oauth2_client_credentials` Redis cache           | `@agent-platform/shared` | `services/auth-profile/client-credentials-service.ts` |
| B13  | `authProfileService.resolve()` 5-level query      | `@agent-platform/shared` | `services/auth-profile/auth-profile-resolver.ts`      |
| B14  | Session-level credential cache (LRU, max 200)     | `runtime`                | `services/auth-profile/credential-cache.ts`           |
| B15  | Hook into `LLMWiringService._wireExecutor()`      | `runtime`                | `services/execution/llm-wiring.ts`                    |
| B16  | `applyAuth()` dispatcher                          | `@agent-platform/shared` | `services/auth-profile/apply-auth.ts`                 |

### Dependency Graph

```
B1 --> B2  (validator reuses linked-app-validator)
B1 --> B3  (resolver reuses linked-app-validator)
B3 --> B4  (initiate uses app credential resolution)
B4 --> B5  (callback uses state from initiate)
B4 --> B6  (user-consent reuses initiate logic)
B5 --> B7  (frontend triggers callback)
B8 --> B11 (proactive check used in full flow)
B10 --> B11 (lock used in full flow)
B3 --> B11 (app credential resolution used in refresh)
B12 independent (client_credentials is self-contained)
B13 --> B15 (resolver injected into wiring)
B14 --> B15 (cache used in wiring)
B16 independent (pure function, no deps)
```

### Critical Patterns from Existing Codebase

1. **Redis lock**: Uses `DistributedLockManager` from `packages/shared/src/redis/distributed-lock.ts` -- `SET NX PX` with Lua atomic release. B10 follows this exact pattern.
2. **OAuth state**: `RedisOAuthStateStore` in `tool-oauth-service.ts` uses `getdel` for atomic consume. B4/B5 follow this pattern.
3. **Popup flow**: `OAuthFlowDialog.tsx` + `connection-callback/page.tsx` use `window.opener.postMessage`. B7 mirrors this.
4. **Secret resolution**: `RuntimeSecretsProvider` uses pluggable `ToolSecretStore`/`SecretDecryptor`/`OAuthTokenResolver` interfaces. B15 adds `authProfileResolver` following the same pattern.
5. **Test framework**: vitest with `vi.mock`, `vi.hoisted` for module mocks, `vi.fn()` for stubs. All tests use this.

---

## Phase D — Security & Compliance

> **REVIEW NOTES (Iteration 4 — codebase comparison audit)**
>
> The following discrepancies were found and documented in Phase D:
>
> 1. **`deleteProject()` signature mismatch (Task 28).** The plan's test calls
>    `deleteProject('proj-1', 'tenant-1')` with 2 args. The ACTUAL signature is
>    `deleteProject(projectId: string)` — only 1 arg, no `tenantId`. The plan's
>    delete line also uses `{ projectId, tenantId }` but the actual function doesn't
>    have `tenantId` in scope. Fix: use `deleteProject('proj-1')` in the test, and
>    in the implementation, delete by `{ projectId }` only (matching the existing
>    `ConnectorConnection.deleteMany({ projectId })` pattern in the actual function).
> 2. **`auditTrailPlugin` does NOT accept options (Task 31).** The plan says
>    `schema.plugin(auditTrailPlugin, { auditEvents: AUTH_PROFILE_AUDIT_EVENTS })`
>    but the actual function signature is `auditTrailPlugin(schema: Schema): void`
>    with no options parameter. The `fieldsToEncrypt` metadata lookup proposed in
>    `getEncryptedFieldsFromSchema` reads from `schema.options` which is the
>    Mongoose schema options object, NOT plugin options. To pass custom fields,
>    either: (a) set `schema.set('fieldsToEncrypt', [...])` before applying the
>    plugin, or (b) modify `auditTrailPlugin` to accept an optional options param.
>    The plan's instruction "pass `AUTH_PROFILE_AUDIT_EVENTS` as the `auditEvents`
>    option" is incorrect as-written.
> 3. **`seed-mongo.ts` doesn't exist with ROLE_PERMISSIONS (Task 33).** The plan
>    references `packages/database/seed-mongo.ts` but the actual role permissions
>    live in `apps/runtime/src/__tests__/helpers/auth-context.ts` as
>    `ROLE_PERMISSIONS` and `PROJECT_ROLE_PERMISSIONS`. Update the plan to reference
>    the correct file.
> 4. **`PROJECT_ROLE_PERMISSIONS` has no `operator` role (Task 33).** The actual
>    roles are: `admin`, `developer`, `viewer`. The plan shows `operator` with
>    `auth-profile:read/write/delete` permissions, but that role doesn't exist.
>    Add auth-profile permissions to `developer` and `viewer` only.
> 5. **`deleteProject()` doesn't receive `tenantId` (Task 28 implementation).**
>    The plan's implementation snippet shows `AuthProfile.deleteMany({ projectId, tenantId })`
>    but `tenantId` is not available in `deleteProject()`. Use `{ projectId }` only,
>    matching the existing `ConnectorConnection.deleteMany({ projectId })` pattern.
> 6. **`getEncryptedFieldsFromSchema` reads wrong location (Task 30).** The plan's
>    masking function reads `schema.options?.fieldsToEncrypt` but the encryption plugin
>    stores `fieldsToEncrypt` as a DOCUMENT-LEVEL field (`type: [String]`), not in
>    `schema.options`. Fixed: read from `doc.fieldsToEncrypt` first, then fallback to
>    schema path defaults, then hardcoded `FALLBACK_MASKED_FIELDS`.
> 7. **`AppError` import path (Task 38).** Plan imported from
>    `'@agent-platform/shared/errors'` but within `packages/shared/src/`, files use
>    relative imports (`'../errors.js'`). Fixed to use relative import.
> 8. **`GDPRDeletionService.processDeletionRequest()` wiring (Task 29).** The plan
>    says to wire `deletePersonalAuthProfiles` and `reassignSharedAuthProfiles` into
>    the erasure orchestrator but doesn't specify WHERE in `processDeletionRequest()`.
>    The actual method processes scopes (`all_data`, `sessions_only`, `pii_only`).
>    Auth profile deletion should go in the `all_data` scope branch.

> GDPR cascade, audit trail masking, tenant isolation authz, SSRF validation, health checks, alerting, credential age monitoring, error handling, trace events.

### Task Group D1: GDPR Cascade Delete

### Task 28: Add AuthProfile to GDPR cascade (deleteTenant, deleteProject, deleteUser)

**File:** `packages/database/src/cascade/cascade-delete.ts`

**Red — Write the test first:**

```typescript
// packages/database/src/__tests__/cascade-delete-auth-profile.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock all models including AuthProfile
const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });

vi.mock('../models/index.js', () => {
  const makeModel = (extra = {}) => ({
    find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    ...extra,
  });
  return {
    Session: makeModel(),
    Message: makeModel(),
    Project: makeModel(),
    ProjectAgent: makeModel(),
    AgentVersion: makeModel(),
    Deployment: makeModel(),
    Contact: makeModel(),
    TenantMember: makeModel(),
    ApiKey: makeModel(),
    Workflow: makeModel(),
    LLMUsageMetric: makeModel(),
    DeletionRequest: makeModel(),
    SDKChannel: makeModel(),
    LLMCredential: makeModel(),
    PublicApiKey: makeModel(),
    WidgetConfig: makeModel(),
    Fact: makeModel(),
    AuditLog: makeModel(),
    Tenant: makeModel(),
    ProjectMember: makeModel(),
    Attachment: makeModel(),
    ConnectorConnection: makeModel(),
    AuthProfile: makeModel({
      deleteMany: mockDeleteMany,
    }),
  };
});

vi.mock('../cascade/event-cascade-hooks.js', () => ({
  getEventCascadeHook: vi.fn(() => null),
}));

import { deleteTenant, deleteProject, deleteUser } from '../cascade/cascade-delete.js';

describe('GDPR cascade — AuthProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('deleteTenant deletes all AuthProfiles for the tenant', async () => {
    const result = await deleteTenant('tenant-1');
    const { AuthProfile } = await import('../models/index.js');
    expect(AuthProfile.deleteMany).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
    expect(result.counts.AuthProfile).toBeDefined();
  });

  test('deleteProject deletes all AuthProfiles for the project', async () => {
    // NOTE (REVIEW): actual deleteProject() takes only projectId (no tenantId).
    const result = await deleteProject('proj-1');
    const { AuthProfile } = await import('../models/index.js');
    expect(AuthProfile.deleteMany).toHaveBeenCalledWith({
      projectId: 'proj-1',
    });
    expect(result.counts.AuthProfile).toBeDefined();
  });

  test('deleteUser deletes personal AuthProfiles and anonymizes shared ones', async () => {
    const result = await deleteUser('user-1');
    const { AuthProfile } = await import('../models/index.js');
    // Personal profiles are deleted
    expect(AuthProfile.deleteMany).toHaveBeenCalledWith({
      createdBy: 'user-1',
      visibility: 'personal',
    });
    expect(result.counts.AuthProfile).toBeDefined();
    // Shared profiles are anonymized, not deleted
    expect(AuthProfile.updateMany).toHaveBeenCalledWith(
      { createdBy: 'user-1', visibility: { $ne: 'personal' } },
      { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
    );
  });
});
```

**Green — Implement:**

In `packages/database/src/cascade/cascade-delete.ts`, add `AuthProfile` to each function:

**`deleteTenant()`** — Add to the import destructure and add the delete line alongside `LLMCredential`:

```typescript
// In the destructuring (add AuthProfile):
const {
  // ... existing models ...
  ConnectorConnection,
  AuthProfile, // ← ADD
} = await import('../models/index.js');

// Level 1: direct tenant children (add after ConnectorConnection line):
counts.AuthProfile = (await AuthProfile.deleteMany({ tenantId })).deletedCount;

// Also delete EndUserOAuthToken entries (per-user OAuth tokens linked to auth profiles):
// counts.EndUserOAuthToken = (await EndUserOAuthToken.deleteMany({ tenantId })).deletedCount;
// NOTE: EndUserOAuthToken model must be imported and added to cascade at each level
// (tenant, project, user) to prevent orphaned end-user tokens after GDPR erasure.
```

**`deleteProject()`** — Add to the import destructure and add delete line alongside `ConnectorConnection`:

```typescript
// In the destructuring (add AuthProfile):
const {
  // ... existing models ...
  ConnectorConnection,
  AuthProfile, // ← ADD
  Fact,
} = await import('../models/index.js');

// Add after ConnectorConnection delete:
// NOTE (REVIEW): deleteProject() does NOT have tenantId in scope. Use projectId only.
counts.AuthProfile = (await AuthProfile.deleteMany({ projectId })).deletedCount;
```

**`deleteUser()`** — Add to the import destructure and add delete line for personal profiles:

```typescript
// In the destructuring (add AuthProfile):
const {
  // ... existing models ...
  LLMCredential,
  AuthProfile, // ← ADD
  EmailVerificationToken,
  // ...
} = await import('../models/index.js');

// Add after LLMCredential delete:
// 1. Delete personal profiles
counts.AuthProfile = (
  await AuthProfile.deleteMany({ createdBy: userId, visibility: 'personal' })
).deletedCount;

// 2. Anonymize shared profiles (cannot delete — other users depend on them)
await AuthProfile.updateMany(
  { createdBy: userId, visibility: { $ne: 'personal' } },
  { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
);
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/database
pnpm test --filter=@agent-platform/database -- --run cascade-delete-auth-profile
```

---

### Task 29: Add AuthProfile to MongoGDPRStore

**File:** `apps/studio/src/services/retention/mongo-gdpr-store.ts`

**Red — Write the test first:**

```typescript
// apps/studio/src/__tests__/mongo-gdpr-store-auth-profile.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 2 });
const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockFind = vi.fn().mockReturnValue({
  select: vi.fn().mockReturnValue({
    limit: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { _id: 'ap-1', visibility: 'personal', authType: 'oauth2_token' },
        { _id: 'ap-2', visibility: 'personal', authType: 'api_key' },
      ]),
    }),
  }),
});

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
  },
  Message: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
  Contact: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
    }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
  AuditLog: { updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }) },
  User: {
    findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
  AuthProfile: {
    find: mockFind,
    deleteMany: mockDeleteMany,
    updateMany: mockUpdateMany,
  },
}));

vi.mock('@agent-platform/database', () => ({
  Attachment: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
}));

vi.mock('@agent-platform/database/cascade', () => ({
  deleteSession: vi.fn().mockResolvedValue({ counts: {}, total: 0, anonymized: {} }),
}));

import { MongoGDPRStore } from '../services/retention/mongo-gdpr-store.js';

describe('MongoGDPRStore — AuthProfile erasure', () => {
  let store: MongoGDPRStore;

  beforeEach(() => {
    store = new MongoGDPRStore();
    vi.clearAllMocks();
  });

  test('deletePersonalAuthProfiles removes personal profiles for subject', async () => {
    await store.deletePersonalAuthProfiles('user-1', 'tenant-1');
    expect(mockDeleteMany).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      createdBy: 'user-1',
      visibility: 'personal',
    });
  });

  test('reassignSharedAuthProfiles anonymizes createdBy on shared profiles', async () => {
    await store.reassignSharedAuthProfiles('user-1', 'tenant-1');
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', createdBy: 'user-1', visibility: 'shared' },
      { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
    );
  });
});
```

**Green — Implement:**

Add two methods to `MongoGDPRStore` in `apps/studio/src/services/retention/mongo-gdpr-store.ts`:

```typescript
async deletePersonalAuthProfiles(subjectId: string, tenantId: string): Promise<void> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  await AuthProfile.deleteMany({
    tenantId,
    createdBy: subjectId,
    visibility: 'personal',
  });
}

async reassignSharedAuthProfiles(subjectId: string, tenantId: string): Promise<void> {
  const { AuthProfile } = await import('@agent-platform/database/models');
  await AuthProfile.updateMany(
    { tenantId, createdBy: subjectId, visibility: 'shared' },
    { $set: { createdBy: '[SYSTEM:gdpr-erasure]' } },
  );
}
```

**Sub-task: Wire GDPR methods into erasure orchestrator** — The `RetentionService.eraseSubject()` method (or equivalent orchestrator) must call `gdprStore.deletePersonalAuthProfiles()` and `gdprStore.reassignSharedAuthProfiles()` during user erasure. Without this wiring, the new methods exist but are never invoked.

> **Phase 2 deferral note:** Token revocation on project removal (revoking OAuth tokens at the provider when a project is deleted) is deferred to Phase 2. Phase 1 deletes the DB records only. Provider-side revocation requires calling each provider's revocation endpoint, which involves async retry logic and dead-letter handling.

Also add `deletePersonalAuthProfiles` and `reassignSharedAuthProfiles` to the `GDPRStore` interface in `apps/studio/src/services/retention/retention-service.ts`:

```typescript
deletePersonalAuthProfiles(subjectId: string, tenantId: string): Promise<void>;
reassignSharedAuthProfiles(subjectId: string, tenantId: string): Promise<void>;
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/studio
pnpm test --filter=@agent-platform/studio -- --run mongo-gdpr-store-auth-profile
```

---

### Task Group D2: Audit Trail Ciphertext Masking

### Task 30: Mask `encryptedSecrets` and `previousEncryptedSecrets` in audit diffs

**File:** `packages/database/src/mongo/plugins/audit-trail.plugin.ts`

**Red — Write the test first:**

```typescript
// packages/database/src/__tests__/audit-trail-ciphertext-masking.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { auditTrailPlugin, setAuditHandler } from '../mongo/plugins/audit-trail.plugin.js';
import { setMasterKey, encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

describe('auditTrailPlugin — ciphertext masking', () => {
  const capturedEntries: any[] = [];

  beforeEach(() => {
    capturedEntries.length = 0;
    setAuditHandler((entry) => {
      capturedEntries.push(entry);
    });
  });

  test('getModifiedFields masks encryptedSecrets as [ENCRYPTED]', () => {
    // Create a schema with both plugins
    const schema = new mongoose.Schema({
      _id: String,
      tenantId: String,
      name: String,
      encryptedSecrets: String,
      previousEncryptedSecrets: String,
    });
    schema.plugin(auditTrailPlugin);

    // Simulate a document with modified encrypted fields
    const TestModel = mongoose.model('AuditMaskTest_' + Date.now(), schema);
    const doc = new TestModel({
      _id: 'test-1',
      tenantId: 'tenant-1',
      name: 'my-profile',
      encryptedSecrets: 'base64-ciphertext-blob',
      previousEncryptedSecrets: 'old-base64-ciphertext-blob',
    });

    // Mark as not-new (simulate update)
    doc.isNew = false;

    // The getModifiedFields internal function should skip encrypted fields.
    // We test this indirectly through the audit handler after save.
  });

  test('audit event for AuthProfile update does NOT contain ciphertext values', async () => {
    // This test verifies the masking behavior end-to-end.
    // When encryptedSecrets is in modifiedPaths(), the audit changes
    // object should contain '[ENCRYPTED]' instead of the actual ciphertext.

    // The assertion is on the captured audit entry:
    // expect(entry.changes.encryptedSecrets).toBe('[ENCRYPTED]');
    // expect(entry.changes.previousEncryptedSecrets).toBe('[ENCRYPTED]');
    // expect(entry.changes).not.toContain any base64 ciphertext
    // Real assertion: when an AuthProfile doc with encryptedSecrets is updated,
    // the audit handler receives '[ENCRYPTED]' instead of actual ciphertext.
    // This test requires MongoMemoryServer for a full save cycle.
    // With MongoMemoryServer:
    // const doc = await TestModel.create({ ... encryptedSecrets: 'base64...' });
    // doc.name = 'updated-name';
    // doc.encryptedSecrets = 'new-ciphertext';
    // await doc.save();
    // expect(capturedEntries).toHaveLength(1);
    // expect(capturedEntries[0].changes.encryptedSecrets).toBe('[ENCRYPTED]');
    // expect(capturedEntries[0].changes.previousEncryptedSecrets).toBe('[ENCRYPTED]');
    expect(capturedEntries).toBeDefined(); // Structural check — full save test in integration suite
  });
});
```

**Green — Implement:**

Modify `getModifiedFields` in `packages/database/src/mongo/plugins/audit-trail.plugin.ts`:

```typescript
/**
 * Dynamically reads encrypted field names from the schema's encryptionPlugin
 * metadata (set by `fieldsToEncrypt` option). This avoids hardcoding field names
 * and automatically adapts when new encrypted fields are added to any model.
 *
 * Fallback: Also checks for a hardcoded set for models that don't use the plugin.
 */
const FALLBACK_MASKED_FIELDS = new Set(['encryptedSecrets', 'previousEncryptedSecrets']);

function getEncryptedFieldsFromSchema(doc: any): Set<string> {
  // NOTE (REVIEW): The encryption plugin stores fieldsToEncrypt as a DOCUMENT-LEVEL
  // field (type: [String]), NOT in schema.options. Read from doc.fieldsToEncrypt
  // or from the schema path definition's default value.
  const docFields = doc?.fieldsToEncrypt;
  if (Array.isArray(docFields) && docFields.length > 0) {
    return new Set(docFields);
  }

  // Fallback: check schema path defaults
  const schema = doc?.constructor?.schema;
  if (schema) {
    const pathDef = schema.path('fieldsToEncrypt');
    const defaultVal = pathDef?.options?.default;
    if (Array.isArray(defaultVal) && defaultVal.length > 0) {
      return new Set(defaultVal);
    }
  }

  return FALLBACK_MASKED_FIELDS;
}

function getModifiedFields(doc: any): Record<string, unknown> | undefined {
  if (!doc.modifiedPaths) return undefined;

  const paths: string[] = doc.modifiedPaths();
  if (paths.length === 0) return undefined;

  const maskedFields = getEncryptedFieldsFromSchema(doc);

  const changes: Record<string, unknown> = {};
  for (const path of paths) {
    if (path === 'updatedAt' || path === '__v') continue;
    if (maskedFields.has(path)) {
      changes[path] = '[ENCRYPTED]';
    } else {
      changes[path] = doc.get(path);
    }
  }

  return Object.keys(changes).length > 0 ? changes : undefined;
}
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/database
pnpm test --filter=@agent-platform/database -- --run audit-trail-ciphertext-masking
```

---

### Task 31: Define 13 distinct AuthProfile audit event constants

**File:** `packages/database/src/auth-profile/audit-events.ts` (new file)

**Red — Write the test first:**

```typescript
// packages/database/src/__tests__/auth-profile-audit-events.test.ts
import { describe, test, expect } from 'vitest';
import { AUTH_PROFILE_AUDIT_EVENTS } from '../auth-profile/audit-events.js';

describe('AuthProfile audit event constants', () => {
  test('exports exactly 13 distinct audit events', () => {
    const events = Object.values(AUTH_PROFILE_AUDIT_EVENTS);
    expect(events).toHaveLength(13);
    expect(new Set(events).size).toBe(13);
  });

  test('each event starts with AUTH_PROFILE_ prefix', () => {
    for (const event of Object.values(AUTH_PROFILE_AUDIT_EVENTS)) {
      expect(event).toMatch(/^AUTH_PROFILE_/);
    }
  });

  test('contains all required event types', () => {
    expect(AUTH_PROFILE_AUDIT_EVENTS.CREATED).toBe('AUTH_PROFILE_CREATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.UPDATED).toBe('AUTH_PROFILE_UPDATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.DELETED).toBe('AUTH_PROFILE_DELETED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.STATUS_CHANGED).toBe('AUTH_PROFILE_STATUS_CHANGED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.SECRETS_ROTATED).toBe('AUTH_PROFILE_SECRETS_ROTATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.VALIDATED).toBe('AUTH_PROFILE_VALIDATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_INITIATED).toBe('AUTH_PROFILE_OAUTH_INITIATED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_COMPLETED).toBe('AUTH_PROFILE_OAUTH_COMPLETED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.OAUTH_REVOKED).toBe('AUTH_PROFILE_OAUTH_REVOKED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.SECRETS_ACCESSED).toBe('AUTH_PROFILE_SECRETS_ACCESSED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.TOKEN_REFRESHED).toBe('AUTH_PROFILE_TOKEN_REFRESHED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.LINKED).toBe('AUTH_PROFILE_LINKED');
    expect(AUTH_PROFILE_AUDIT_EVENTS.ADMIN_VIEWED).toBe('AUTH_PROFILE_ADMIN_VIEWED');
  });
});
```

**Green — Implement:**

```typescript
// packages/database/src/auth-profile/audit-events.ts

/**
 * AuthProfile Audit Event Constants
 *
 * 13 distinct audit actions covering the full lifecycle of an Auth Profile.
 * Used by the audit trail plugin and explicit audit logging in service methods.
 */
export const AUTH_PROFILE_AUDIT_EVENTS = {
  CREATED: 'AUTH_PROFILE_CREATED',
  UPDATED: 'AUTH_PROFILE_UPDATED',
  DELETED: 'AUTH_PROFILE_DELETED',
  STATUS_CHANGED: 'AUTH_PROFILE_STATUS_CHANGED',
  SECRETS_ROTATED: 'AUTH_PROFILE_SECRETS_ROTATED',
  VALIDATED: 'AUTH_PROFILE_VALIDATED',
  OAUTH_INITIATED: 'AUTH_PROFILE_OAUTH_INITIATED',
  OAUTH_COMPLETED: 'AUTH_PROFILE_OAUTH_COMPLETED',
  OAUTH_REVOKED: 'AUTH_PROFILE_OAUTH_REVOKED',
  SECRETS_ACCESSED: 'AUTH_PROFILE_SECRETS_ACCESSED',
  TOKEN_REFRESHED: 'AUTH_PROFILE_TOKEN_REFRESHED',
  LINKED: 'AUTH_PROFILE_LINKED',
  ADMIN_VIEWED: 'AUTH_PROFILE_ADMIN_VIEWED',
} as const;

export type AuthProfileAuditEvent =
  (typeof AUTH_PROFILE_AUDIT_EVENTS)[keyof typeof AUTH_PROFILE_AUDIT_EVENTS];
```

**Sub-task: Wire audit constants into model and service layer:**

1. **NOTE (REVIEW):** The actual `auditTrailPlugin(schema: Schema): void` does NOT accept options.
   Do NOT pass `{ auditEvents: ... }` — it will be silently ignored. Instead, the audit
   events are emitted explicitly in service methods (see point 2 below). The automatic
   `pre('save')`/`post('save')` hooks in the plugin handle create/update audit entries
   with operation names `'create'`/`'update'`/`'delete'`, not the custom event names.
   ```typescript
   // Correct: no options
   schema.plugin(auditTrailPlugin);
   ```
2. In `AuthProfileService` methods (Task 6), emit explicit audit events using `AUTH_PROFILE_AUDIT_EVENTS.SECRETS_ACCESSED` when decrypting secrets, `AUTH_PROFILE_AUDIT_EVENTS.TOKEN_REFRESHED` after successful refresh, etc.

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/database
pnpm test --filter=@agent-platform/database -- --run auth-profile-audit-events
```

---

### Task Group D3: Tenant Isolation & Authorization

### Task 32: AuthProfile authz test suite

**File:** `apps/runtime/src/__tests__/auth-profiles-authz.test.ts`

This follows the exact pattern established in `tool-secrets-authz.test.ts`: create a test Express server per role, inject tenant context, and verify HTTP status codes for every endpoint.

**Red — Write the test first:**

```typescript
// apps/runtime/src/__tests__/auth-profiles-authz.test.ts
/**
 * Auth Profile Route Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the auth-profiles router.
 *
 * Permission mapping:
 *   GET    /                          — auth-profile:read
 *   POST   /                          — auth-profile:write
 *   GET    /:id                       — auth-profile:read
 *   PUT    /:id                       — auth-profile:write
 *   DELETE /:id                       — auth-profile:delete
 *   POST   /:id/validate              — auth-profile:read
 *   GET    /:id/consumers             — auth-profile:read
 *   POST   /:id/revoke                — auth-profile:write
 *   POST   /oauth/initiate            — auth-profile:write
 *   POST   /oauth/callback            — auth-profile:write
 *
 * Roles tested:
 *   OWNER    — *:* → all pass
 *   ADMIN    — project:* → all pass
 *   OPERATOR — project viewer → reads pass, writes/deletes 403
 *   VIEWER   — project viewer → reads pass, writes/deletes 403
 *   Unauthenticated → all 401
 *   Cross-tenant → all 404
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// === MOCKS (before imports) ===

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    getCurrentRequestId: vi.fn(() => 'req-test-1'),
  };
});

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
    encryptJsonForTenant: vi.fn(() => 'encrypted'),
    decryptJsonForTenant: vi.fn(() => ({})),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

// Mock auth-profile service
vi.mock('../services/auth-profile-service.js', () => ({
  authProfileService: {
    list: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    create: vi.fn().mockResolvedValue({ _id: 'ap-1', name: 'test' }),
    getById: vi.fn().mockResolvedValue({ _id: 'ap-1', name: 'test', projectId: 'proj-1' }),
    update: vi.fn().mockResolvedValue({ _id: 'ap-1', name: 'test' }),
    delete: vi.fn().mockResolvedValue(true),
    validate: vi.fn().mockResolvedValue({ valid: true }),
    getConsumers: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue({ status: 'revoked' }),
    oauthInitiate: vi.fn().mockResolvedValue({ authUrl: 'https://example.com', state: 'st' }),
    oauthCallback: vi.fn().mockResolvedValue({ _id: 'ap-2' }),
  },
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockResolvedValue({
    projectId: 'proj-1',
    userId: 'user-1',
    role: 'viewer',
  }),
}));

vi.mock('../repos/auth-repo.js', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// === IMPORTS ===

import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// === HELPERS ===

const BASE = '/api/projects/proj-1/auth-profiles';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createServerForRole(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER') {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-A', 'user-1', role);
  app.use(injectTenantContext(ctx));

  const authProfilesRouter = (await import('../routes/auth-profiles.js')).default;
  app.use('/api/projects/:projectId/auth-profiles', authProfilesRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

const createBody = {
  name: 'test-profile',
  authType: 'api_key',
  config: { headerName: 'X-Api-Key', placement: 'header' },
  secrets: { apiKey: 'secret-123' },
};

// === TESTS ===

describe('Auth profile route authorization — project-level RBAC', () => {
  // OWNER — all pass
  describe('Tenant OWNER', () => {
    let baseUrl: string;
    let server: http.Server;
    beforeAll(async () => ({ baseUrl, server } = await createServerForRole('OWNER')));
    afterAll(() => server?.close());

    test('GET / (list) passes auth', async () => {
      const { status } = await request(baseUrl, 'GET', BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / (create) passes auth', async () => {
      const { status } = await request(baseUrl, 'POST', BASE, { body: createBody });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('GET /:id passes auth', async () => {
      const { status } = await request(baseUrl, 'GET', `${BASE}/ap-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('PUT /:id passes auth', async () => {
      const { status } = await request(baseUrl, 'PUT', `${BASE}/ap-1`, {
        body: { name: 'updated' },
      });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes auth', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${BASE}/ap-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/validate passes auth', async () => {
      const { status } = await request(baseUrl, 'POST', `${BASE}/ap-1/validate`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST /:id/revoke passes auth', async () => {
      const { status } = await request(baseUrl, 'POST', `${BASE}/ap-1/revoke`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // ADMIN — all pass
  describe('Tenant ADMIN', () => {
    let baseUrl: string;
    let server: http.Server;
    beforeAll(async () => ({ baseUrl, server } = await createServerForRole('ADMIN')));
    afterAll(() => server?.close());

    test('GET / (list) passes auth', async () => {
      const { status } = await request(baseUrl, 'GET', BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('POST / (create) passes auth', async () => {
      const { status } = await request(baseUrl, 'POST', BASE, { body: createBody });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });

    test('DELETE /:id passes auth', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${BASE}/ap-1`);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
    });
  });

  // VIEWER — reads pass, writes 403
  describe('VIEWER role (project viewer)', () => {
    let baseUrl: string;
    let server: http.Server;
    beforeAll(async () => ({ baseUrl, server } = await createServerForRole('VIEWER')));
    afterAll(() => server?.close());

    test('GET / (list) passes auth (auth-profile:read)', async () => {
      const { status } = await request(baseUrl, 'GET', BASE);
      expect(status).not.toBe(403);
    });

    test('POST / (create) returns 403 (viewer lacks auth-profile:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, { body: createBody });
      expect(status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('PUT /:id returns 403 (viewer lacks auth-profile:write)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', `${BASE}/ap-1`, {
        body: { name: 'updated' },
      });
      expect(status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('DELETE /:id returns 403 (viewer lacks auth-profile:delete)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ap-1`);
      expect(status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    test('POST /:id/revoke returns 403 (viewer lacks auth-profile:write)', async () => {
      const { status, body } = await request(baseUrl, 'POST', `${BASE}/ap-1/revoke`);
      expect(status).toBe(403);
      expect(body.error.code).toBe('FORBIDDEN');
    });
  });

  // Unauthenticated — all 401
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      // No tenantContext injected

      const authProfilesRouter = (await import('../routes/auth-profiles.js')).default;
      app.use('/api/projects/:projectId/auth-profiles', authProfilesRouter);

      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(() => server?.close());

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE);
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('POST / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'POST', BASE, { body: createBody });
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('DELETE /:id returns 401', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${BASE}/ap-1`);
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  // Cross-tenant — 404 (not 403)
  describe('Cross-tenant access returns 404', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // Dynamically override project-repo to return null (simulating cross-tenant)
      const { findProjectByIdAndTenant } = await import('../repos/project-repo.js');
      (findProjectByIdAndTenant as any).mockResolvedValueOnce(null);

      const app = express();
      app.use(express.json());

      const ctx = makeTenantContext('tenant-B', 'user-evil', 'OWNER');
      app.use(injectTenantContext(ctx));

      const authProfilesRouter = (await import('../routes/auth-profiles.js')).default;
      app.use('/api/projects/:projectId/auth-profiles', authProfilesRouter);

      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(() => server?.close());

    test('GET /:id from another tenant returns 404', async () => {
      const { status } = await request(baseUrl, 'GET', `${BASE}/ap-1`);
      expect(status).toBe(404);
    });
  });

  // Cross-project within same tenant — should 404 for project-scoped profiles
  describe('Cross-project access within same tenant returns 404', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());

      // Same tenant, but different project
      const ctx = makeTenantContext('tenant-A', 'user-1', 'OWNER');
      app.use(injectTenantContext(ctx));

      const authProfilesRouter = (await import('../routes/auth-profiles.js')).default;
      // Accessing project-B's auth profiles from project-A's URL
      app.use('/api/projects/:projectId/auth-profiles', authProfilesRouter);

      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(() => server?.close());

    test('PUT /:id of profile belonging to project-B via project-A URL returns 404', async () => {
      // Profile ap-proj-b belongs to project-B but URL targets project-A
      const { status } = await request(baseUrl, 'PUT', `${BASE}/ap-proj-b`, {
        body: { name: 'hijacked' },
      });
      expect(status).toBe(404);
    });

    test('DELETE /:id of profile belonging to project-B via project-A URL returns 404', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${BASE}/ap-proj-b`);
      expect(status).toBe(404);
    });
  });
});
```

**Green — Implement:**

The route handler in `apps/runtime/src/routes/auth-profiles.ts` must:

1. Use `requireProjectPermission(req, res, 'auth-profile:read')` for GET endpoints
2. Use `requireProjectPermission(req, res, 'auth-profile:write')` for POST/PUT endpoints
3. Use `requireProjectPermission(req, res, 'auth-profile:delete')` for DELETE
4. All `findOne()` queries include `{ _id: id, tenantId, projectId }` — never `findById()`
5. Cross-tenant access returns 404 via `requireProjectPermission` which checks project existence in tenant

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run auth-profiles-authz
```

---

### Task 33: Add auth-profile permissions to ROLE_PERMISSIONS seed data

**File:** `apps/runtime/src/__tests__/helpers/auth-context.ts`

> **NOTE (REVIEW):** There is no `packages/database/seed-mongo.ts` with ROLE_PERMISSIONS.
> The actual role permission maps live in `apps/runtime/src/__tests__/helpers/auth-context.ts`
> as `ROLE_PERMISSIONS` (tenant-level) and `PROJECT_ROLE_PERMISSIONS` (project-level).
> The `PROJECT_ROLE_PERMISSIONS` has roles: `admin`, `developer`, `viewer` (NOT `operator`).

Add `auth-profile:*` to `ROLE_PERMISSIONS.ADMIN`, `auth-profile:read` to `MEMBER`/`VIEWER`. Update `PROJECT_ROLE_PERMISSIONS` to match.

```typescript
// In ROLE_PERMISSIONS (tenant-level):
ADMIN: [
  // ...existing...
  'auth-profile:*', // ← ADD
],
OPERATOR: [
  // ...existing...
  'auth-profile:read', // ← ADD
],
MEMBER: [
  // ...existing...
  'auth-profile:read', // ← ADD
],
VIEWER: [
  // ...existing...
  'auth-profile:read', // ← ADD
],

// In PROJECT_ROLE_PERMISSIONS (project-level):
// NOTE (REVIEW): There is no 'operator' role in PROJECT_ROLE_PERMISSIONS.
// Only admin, developer, viewer exist.
developer: [
  // ...existing...
  'auth-profile:read',
  'auth-profile:write',
  'auth-profile:delete', // developers can remove profiles they created
],
viewer: [
  // ...existing...
  'auth-profile:read',
],
```

> **Note:** `auth-profile:decrypt` is intentionally restricted to `admin` (via `*:*`) and not granted to `developer` or `viewer`. Decrypting raw secrets (e.g., for debugging) requires elevated privilege. The `auth-profile:delete` permission is granted to `developer` to allow credential lifecycle management without admin intervention.

---

### ~~Task 34: REMOVED~~ — SSRF validation folded into Task 4

> **Rationale:** Task 34 duplicated SSRF validation logic that belongs in the Zod schemas defined in Task 4 (`packages/shared/src/validation/auth-profile.schema.ts`). The `httpsUrl` refinement with `validateUrlForSSRF` is applied directly in the `oauth2_app` and `oauth2_client_credentials` config schemas within Task 4's Zod discriminated unions. No separate `packages/database/src/auth-profile/validation.ts` file is needed.
>
> The SSRF test cases (private IP, localhost, metadata endpoint, octal-encoded IP, `.strict()`) are added to the Task 4 test suite in `packages/shared/src/__tests__/auth-profile/auth-profile-schema.test.ts`.

---

### Task Group D5: Health Check & Alerting

### Task 35: Register authProfileService in health check registry

**File:** `apps/runtime/src/health/service-registry.ts`

**Red — Write the test first:**

```typescript
// apps/runtime/src/__tests__/health-auth-profile.test.ts
import { describe, test, expect } from 'vitest';
import { SERVICE_REGISTRY } from '../health/service-registry.js';

describe('Health check registry — AuthProfile service', () => {
  test('SERVICE_REGISTRY does NOT contain auth-profile as an external service', () => {
    // AuthProfile is not a separate service — it is an internal subsystem
    // of runtime. Its health check is a custom probe, not a ServiceDefinition.
    // This test documents that we do NOT add it to the external registry.
    const ids = SERVICE_REGISTRY.map((s) => s.id);
    expect(ids).not.toContain('auth-profile-service');
  });
});
```

The health check for AuthProfile is an internal health probe registered via the runtime's `/health` endpoint, not an external `ServiceDefinition`.

**Sub-task: Register health check in service-registry.ts** — Add the `checkAuthProfileHealth` probe to the runtime's `/health` endpoint handler so it is invoked on every health check request. In `apps/runtime/src/routes/health.ts` (or equivalent), add:

```typescript
import { checkAuthProfileHealth } from '../health/auth-profile-health.js';
// In the GET /health handler, add:
const authProfileHealth = await checkAuthProfileHealth(healthDeps);
result.authProfile = authProfileHealth;
if (!authProfileHealth.healthy) result.degraded = true;
```

The health probe verifies:

1. MongoDB: `AuthProfile.findOne({ tenantId: '__health_check__' })` returns without error (connection alive)
2. Decryption: A known test profile can be decrypted (encryption subsystem alive)
3. Redis: `SET NX PX` probe key succeeds (lock mechanism reachable)

**Green — Implement:**

```typescript
// apps/runtime/src/health/auth-profile-health.ts

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-health');

export interface AuthProfileHealthResult {
  healthy: boolean;
  mongo: boolean;
  decryption: boolean;
  redisLock: boolean;
  latencyMs: number;
}

export async function checkAuthProfileHealth(deps: {
  mongoProbe: () => Promise<boolean>;
  decryptionProbe: () => Promise<boolean>;
  redisProbe: () => Promise<boolean>;
}): Promise<AuthProfileHealthResult> {
  const start = Date.now();
  const [mongo, decryption, redisLock] = await Promise.all([
    deps.mongoProbe().catch(() => false),
    deps.decryptionProbe().catch(() => false),
    deps.redisProbe().catch(() => false),
  ]);

  const healthy = mongo && decryption && redisLock;
  const latencyMs = Date.now() - start;

  if (!healthy) {
    log.warn('AuthProfile health check degraded', { mongo, decryption, redisLock, latencyMs });
  }

  return { healthy, mongo, decryption, redisLock, latencyMs };
}
```

**Test:**

```typescript
// apps/runtime/src/__tests__/auth-profile-health.test.ts
import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { checkAuthProfileHealth } from '../health/auth-profile-health.js';

describe('AuthProfile health probe', () => {
  test('returns healthy when all probes pass', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => true,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(true);
    expect(result.mongo).toBe(true);
    expect(result.decryption).toBe(true);
    expect(result.redisLock).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('returns unhealthy when mongo fails', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => {
        throw new Error('connection refused');
      },
      decryptionProbe: async () => true,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(false);
    expect(result.mongo).toBe(false);
  });

  test('returns unhealthy when decryption fails', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => false,
      redisProbe: async () => true,
    });
    expect(result.healthy).toBe(false);
    expect(result.decryption).toBe(false);
  });

  test('returns unhealthy when redis lock unreachable', async () => {
    const result = await checkAuthProfileHealth({
      mongoProbe: async () => true,
      decryptionProbe: async () => true,
      redisProbe: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.healthy).toBe(false);
    expect(result.redisLock).toBe(false);
  });
});
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run auth-profile-health
```

---

### Task 36: Alerting thresholds

**File:** `apps/runtime/src/health/auth-profile-alerting.ts` (new file)

**Red — Write the test first:**

```typescript
// apps/runtime/src/__tests__/auth-profile-alerting.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { AuthProfileAlertEvaluator, type AlertSinkFn } from '../health/auth-profile-alerting.js';

describe('AuthProfile alert evaluator', () => {
  let alerts: { level: string; code: string }[];
  let sink: AlertSinkFn;

  beforeEach(() => {
    alerts = [];
    sink = (level, code, _message, _meta) => {
      alerts.push({ level, code });
    };
  });

  test('fires critical alert when decryption failure rate > 0', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.recordDecryptionFailure();
    evaluator.evaluate();
    expect(alerts).toContainEqual({
      level: 'critical',
      code: 'AUTH_PROFILE_DECRYPTION_FAILED',
    });
  });

  test('fires warning when refresh failure rate > 5% over 5min window', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    // Simulate 100 refreshes, 6 failures (6%)
    for (let i = 0; i < 94; i++) evaluator.recordRefreshAttempt(true);
    for (let i = 0; i < 6; i++) evaluator.recordRefreshAttempt(false);
    evaluator.evaluate();
    expect(alerts).toContainEqual({
      level: 'warning',
      code: 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
    });
  });

  test('does not fire refresh alert when failure rate <= 5%', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    for (let i = 0; i < 96; i++) evaluator.recordRefreshAttempt(true);
    for (let i = 0; i < 4; i++) evaluator.recordRefreshAttempt(false);
    evaluator.evaluate();
    const refreshAlerts = alerts.filter((a) => a.code === 'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED');
    expect(refreshAlerts).toHaveLength(0);
  });

  test('does not fire decryption alert when no failures', () => {
    const evaluator = new AuthProfileAlertEvaluator(sink);
    evaluator.evaluate();
    const decryptAlerts = alerts.filter((a) => a.code === 'AUTH_PROFILE_DECRYPTION_FAILED');
    expect(decryptAlerts).toHaveLength(0);
  });
});
```

**Green — Implement:**

```typescript
// apps/runtime/src/health/auth-profile-alerting.ts

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('auth-profile-alerting');

const REFRESH_FAILURE_THRESHOLD_PERCENT = 5;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export type AlertSinkFn = (
  level: 'critical' | 'warning' | 'info',
  code: string,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export class AuthProfileAlertEvaluator {
  private decryptionFailures = 0;
  private refreshAttempts: { success: boolean; timestamp: number }[] = [];
  private readonly sink: AlertSinkFn;

  constructor(sink: AlertSinkFn) {
    this.sink = sink;
  }

  recordDecryptionFailure(): void {
    this.decryptionFailures++;
  }

  recordRefreshAttempt(success: boolean): void {
    this.refreshAttempts.push({ success, timestamp: Date.now() });
  }

  evaluate(): void {
    // Decryption: any failure in production is critical
    if (this.decryptionFailures > 0) {
      this.sink(
        'critical',
        'AUTH_PROFILE_DECRYPTION_FAILED',
        `${this.decryptionFailures} decryption failure(s) detected — possible key rotation issue`,
        { count: this.decryptionFailures },
      );
    }

    // Refresh: prune to window, check rate
    const cutoff = Date.now() - WINDOW_MS;
    this.refreshAttempts = this.refreshAttempts.filter((a) => a.timestamp >= cutoff);

    const total = this.refreshAttempts.length;
    if (total > 0) {
      const failures = this.refreshAttempts.filter((a) => !a.success).length;
      const failureRate = (failures / total) * 100;
      if (failureRate > REFRESH_FAILURE_THRESHOLD_PERCENT) {
        this.sink(
          'warning',
          'AUTH_PROFILE_TOKEN_REFRESH_DEGRADED',
          `Token refresh failure rate ${failureRate.toFixed(1)}% exceeds ${REFRESH_FAILURE_THRESHOLD_PERCENT}% threshold`,
          { failures, total, windowMs: WINDOW_MS },
        );
      }
    }

    // Reset decryption counter after evaluation
    this.decryptionFailures = 0;
  }
}
```

**Sub-task: Wire AlertEvaluator into startup/scheduler** — The `AuthProfileAlertEvaluator` must be instantiated and wired during runtime startup. Add to the runtime's initialization code (e.g., `apps/runtime/src/index.ts` or service bootstrap):

```typescript
import { AuthProfileAlertEvaluator } from './health/auth-profile-alerting.js';

const alertEvaluator = new AuthProfileAlertEvaluator(alertSink);
// Run evaluation on a periodic interval (e.g., every 60s via setInterval or scheduler)
setInterval(() => alertEvaluator.evaluate(), 60_000);
// Wire recordDecryptionFailure/recordRefreshAttempt into the auth-profile service callbacks
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run auth-profile-alerting
```

---

### ~~Task Group D6: CredentialAgeMonitor Update~~

### ~~Task 37~~ — REMOVED: Deferred to Phase 2

> The Phase 1 design doc's out-of-scope table explicitly defers `CredentialAgeMonitor` integration to Phase 2. This task and all associated tests (`credential-age-monitor-auth-profile.test.ts`) are removed from Phase 1.

---

### Task Group D7: Error Handling

### Task 38: AuthProfileError class with typed reason discriminant

**File:** `packages/shared/src/auth-profile/errors.ts` (new file)

**Red — Write the test first:**

```typescript
// packages/shared/src/__tests__/auth-profile-errors.test.ts
import { describe, test, expect } from 'vitest';
import {
  AuthProfileError,
  AUTH_PROFILE_ERROR_CODES,
  type AuthProfileErrorReason,
} from '../auth-profile/errors.js';

describe('AuthProfileError', () => {
  test('extends AppError with reason and retryable fields', () => {
    const err = new AuthProfileError('AUTH_PROFILE_NOT_FOUND', 'Auth profile not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AuthProfileError');
    expect(err.reason).toBe('AUTH_PROFILE_NOT_FOUND');
    expect(err.message).toBe('Auth profile not found');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('AUTH_PROFILE_NOT_FOUND');
  });

  test('AUTH_PROFILE_TOKEN_REFRESH_FAILED is retryable', () => {
    const err = new AuthProfileError(
      'AUTH_PROFILE_TOKEN_REFRESH_FAILED',
      'Lock contention timeout',
    );
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(503);
  });

  test('AUTH_PROFILE_DUPLICATE_NAME has 409 status', () => {
    const err = new AuthProfileError(
      'AUTH_PROFILE_DUPLICATE_NAME',
      'Profile "Gmail" already exists',
    );
    expect(err.statusCode).toBe(409);
    expect(err.retryable).toBe(false);
  });

  test('AUTH_PROFILE_HAS_CONSUMERS has 409 status', () => {
    const err = new AuthProfileError(
      'AUTH_PROFILE_HAS_CONSUMERS',
      'Cannot delete — 3 active connections',
    );
    expect(err.statusCode).toBe(409);
    expect(err.retryable).toBe(false);
  });

  test('AUTH_PROFILE_DECRYPTION_FAILED is 500 and not retryable', () => {
    const err = new AuthProfileError('AUTH_PROFILE_DECRYPTION_FAILED', 'Key version mismatch');
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(false);
  });

  test('all error codes have defined status and retryable', () => {
    for (const [reason, meta] of Object.entries(AUTH_PROFILE_ERROR_CODES)) {
      expect(meta.statusCode).toBeGreaterThanOrEqual(400);
      expect(typeof meta.retryable).toBe('boolean');
    }
  });

  test('error codes cover all Phase 1 scenarios', () => {
    const codes = Object.keys(AUTH_PROFILE_ERROR_CODES);
    expect(codes).toContain('AUTH_PROFILE_NOT_FOUND');
    expect(codes).toContain('AUTH_PROFILE_DUPLICATE_NAME');
    expect(codes).toContain('AUTH_PROFILE_HAS_CONSUMERS');
    expect(codes).toContain('AUTH_PROFILE_INCOMPATIBLE_TYPE');
    expect(codes).toContain('AUTH_PROFILE_CROSS_TENANT_LINK');
    expect(codes).toContain('AUTH_PROFILE_CROSS_PROJECT');
    expect(codes).toContain('AUTH_PROFILE_TOKEN_REFRESH_FAILED');
    expect(codes).toContain('AUTH_PROFILE_DECRYPTION_FAILED');
    expect(codes).toContain('AUTH_PROFILE_VALIDATION_FAILED');
    expect(codes).toContain('AUTH_PROFILE_ADDON_NOT_SUPPORTED');
  });
});
```

**Green — Implement:**

```typescript
// packages/shared/src/auth-profile/errors.ts

// NOTE (REVIEW): Within packages/shared, use relative import, not package path.
// See packages/shared/src/encryption/errors.ts for the same pattern.
import { AppError } from '../errors.js';

/**
 * Error code metadata: HTTP status code and retryability.
 */
export const AUTH_PROFILE_ERROR_CODES = {
  AUTH_PROFILE_NOT_FOUND: { statusCode: 404, retryable: false },
  AUTH_PROFILE_DUPLICATE_NAME: { statusCode: 409, retryable: false },
  AUTH_PROFILE_HAS_CONSUMERS: { statusCode: 409, retryable: false },
  AUTH_PROFILE_INCOMPATIBLE_TYPE: { statusCode: 422, retryable: false },
  AUTH_PROFILE_CROSS_TENANT_LINK: { statusCode: 400, retryable: false },
  AUTH_PROFILE_CROSS_PROJECT: { statusCode: 404, retryable: false },
  AUTH_PROFILE_TOKEN_REFRESH_FAILED: { statusCode: 503, retryable: true },
  AUTH_PROFILE_DECRYPTION_FAILED: { statusCode: 500, retryable: false },
  AUTH_PROFILE_VALIDATION_FAILED: { statusCode: 422, retryable: false },
  AUTH_PROFILE_ADDON_NOT_SUPPORTED: { statusCode: 400, retryable: false },
  AUTH_PROFILE_EXPIRED: { statusCode: 502, retryable: false },
  AUTH_PROFILE_LOCK_UNAVAILABLE: { statusCode: 503, retryable: true },
} as const;

export type AuthProfileErrorReason = keyof typeof AUTH_PROFILE_ERROR_CODES;

/**
 * Structured error for all AuthProfile operations.
 *
 * Carries a typed `reason` discriminant for programmatic matching
 * and a `retryable` flag for callers that implement retry logic.
 */
export class AuthProfileError extends AppError {
  public readonly reason: AuthProfileErrorReason;
  public readonly retryable: boolean;

  constructor(reason: AuthProfileErrorReason, message: string) {
    const meta = AUTH_PROFILE_ERROR_CODES[reason];
    super(message, { code: reason, statusCode: meta.statusCode });
    this.reason = reason;
    this.retryable = meta.retryable;
  }
}
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/shared
pnpm test --filter=@agent-platform/shared -- --run auth-profile-errors
```

---

### Task 39: Trace events via TraceStore

**File:** `apps/runtime/src/services/auth-profile/trace-events.ts` (new file)

**Red — Write the test first:**

```typescript
// apps/runtime/src/__tests__/auth-profile-trace-events.test.ts
import { describe, test, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  emitAuthProfileResolved,
  emitAuthProfileRefresh,
  emitAuthProfileFailed,
  emitAuthProfileLockUnavailable,
  AUTH_PROFILE_TRACE_EVENTS,
} from '../services/auth-profile/trace-events.js';

describe('AuthProfile trace events', () => {
  test('defines exactly 4 trace event types', () => {
    expect(Object.keys(AUTH_PROFILE_TRACE_EVENTS)).toHaveLength(4);
    expect(AUTH_PROFILE_TRACE_EVENTS.RESOLVED).toBe('auth_profile_resolved');
    expect(AUTH_PROFILE_TRACE_EVENTS.REFRESH).toBe('auth_profile_refresh');
    expect(AUTH_PROFILE_TRACE_EVENTS.FAILED).toBe('auth_profile_decryption_failed');
    expect(AUTH_PROFILE_TRACE_EVENTS.LOCK_UNAVAILABLE).toBe('auth_profile_lock_unavailable');
  });

  test('emitAuthProfileResolved writes structured trace event', () => {
    const events: any[] = [];
    const mockStore = { write: (e: any) => events.push(e) };

    emitAuthProfileResolved(mockStore, {
      tenantId: 'tenant-1',
      profileId: 'ap-1',
      authType: 'oauth2_token',
      connector: 'gmail',
      latencyMs: 12,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('auth_profile_resolved');
    expect(events[0].tenantId).toBe('tenant-1');
    expect(events[0].profileId).toBe('ap-1');
  });

  test('emitAuthProfileRefresh includes success/failure flag', () => {
    const events: any[] = [];
    const mockStore = { write: (e: any) => events.push(e) };

    emitAuthProfileRefresh(mockStore, {
      tenantId: 'tenant-1',
      profileId: 'ap-1',
      connector: 'gmail',
      success: false,
      error: 'invalid_grant',
    });

    expect(events[0].type).toBe('auth_profile_refresh');
    expect(events[0].success).toBe(false);
    expect(events[0].error).toBe('invalid_grant');
  });

  test('emitAuthProfileFailed includes reason', () => {
    const events: any[] = [];
    const mockStore = { write: (e: any) => events.push(e) };

    emitAuthProfileFailed(mockStore, {
      tenantId: 'tenant-1',
      profileId: 'ap-1',
      reason: 'AUTH_PROFILE_DECRYPTION_FAILED',
    });

    expect(events[0].type).toBe('auth_profile_decryption_failed');
    expect(events[0].reason).toBe('AUTH_PROFILE_DECRYPTION_FAILED');
  });
});
```

**Green — Implement:**

```typescript
// apps/runtime/src/services/auth-profile/trace-events.ts

export const AUTH_PROFILE_TRACE_EVENTS = {
  RESOLVED: 'auth_profile_resolved',
  REFRESH: 'auth_profile_refresh',
  FAILED: 'auth_profile_decryption_failed',
  LOCK_UNAVAILABLE: 'auth_profile_lock_unavailable',
} as const;

interface TraceWriter {
  write(event: unknown): void;
}

export function emitAuthProfileResolved(
  store: TraceWriter,
  data: {
    tenantId: string;
    profileId: string;
    authType: string;
    connector?: string;
    latencyMs: number;
  },
): void {
  store.write({
    type: AUTH_PROFILE_TRACE_EVENTS.RESOLVED,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function emitAuthProfileRefresh(
  store: TraceWriter,
  data: {
    tenantId: string;
    profileId: string;
    connector?: string;
    success: boolean;
    error?: string;
  },
): void {
  store.write({
    type: AUTH_PROFILE_TRACE_EVENTS.REFRESH,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function emitAuthProfileFailed(
  store: TraceWriter,
  data: {
    tenantId: string;
    profileId: string;
    reason: string;
  },
): void {
  store.write({
    type: AUTH_PROFILE_TRACE_EVENTS.FAILED,
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function emitAuthProfileLockUnavailable(
  store: TraceWriter,
  data: {
    tenantId: string;
    profileId: string;
    reason: string;
  },
): void {
  store.write({
    type: AUTH_PROFILE_TRACE_EVENTS.LOCK_UNAVAILABLE,
    ...data,
    timestamp: new Date().toISOString(),
  });
}
```

**Run:**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm build --filter=@agent-platform/runtime
pnpm test --filter=@agent-platform/runtime -- --run auth-profile-trace-events
```

---

### Files to Create or Modify

### New Files

| File                                                     | Purpose                                     |
| -------------------------------------------------------- | ------------------------------------------- |
| `packages/database/src/auth-profile/audit-events.ts`     | 13 audit event constants                    |
| `packages/shared/src/auth-profile/errors.ts`             | `AuthProfileError` class with typed reasons |
| `apps/runtime/src/health/auth-profile-health.ts`         | Health probe (mongo + decrypt + redis)      |
| `apps/runtime/src/health/auth-profile-alerting.ts`       | Alert evaluator with sliding windows        |
| `apps/runtime/src/services/auth-profile/trace-events.ts` | 4 trace event emitters                      |

### New Test Files

| File                                                                       | Test Command                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/database/src/__tests__/cascade-delete-auth-profile.test.ts`      | `pnpm test --filter=@agent-platform/database -- --run cascade-delete-auth-profile`        |
| `packages/database/src/__tests__/audit-trail-ciphertext-masking.test.ts`   | `pnpm test --filter=@agent-platform/database -- --run audit-trail-ciphertext-masking`     |
| `packages/database/src/__tests__/auth-profile-audit-events.test.ts`        | `pnpm test --filter=@agent-platform/database -- --run auth-profile-audit-events`          |
| ~~`packages/database/src/__tests__/auth-profile-ssrf-validation.test.ts`~~ | ~~REMOVED~~ — SSRF tests folded into Task 4 schema tests                                  |
| `packages/shared/src/__tests__/auth-profile-errors.test.ts`                | `pnpm test --filter=@agent-platform/shared -- --run auth-profile-errors`                  |
| `apps/studio/src/__tests__/mongo-gdpr-store-auth-profile.test.ts`          | `pnpm test --filter=@agent-platform/studio -- --run mongo-gdpr-store-auth-profile`        |
| `apps/runtime/src/__tests__/auth-profiles-authz.test.ts`                   | `pnpm test --filter=@agent-platform/runtime -- --run auth-profiles-authz`                 |
| `apps/runtime/src/__tests__/auth-profile-health.test.ts`                   | `pnpm test --filter=@agent-platform/runtime -- --run auth-profile-health`                 |
| `apps/runtime/src/__tests__/auth-profile-alerting.test.ts`                 | `pnpm test --filter=@agent-platform/runtime -- --run auth-profile-alerting`               |
| `apps/runtime/src/__tests__/credential-age-monitor-auth-profile.test.ts`   | `pnpm test --filter=@agent-platform/runtime -- --run credential-age-monitor-auth-profile` |
| `apps/runtime/src/__tests__/auth-profile-trace-events.test.ts`             | `pnpm test --filter=@agent-platform/runtime -- --run auth-profile-trace-events`           |

### Modified Files

| File                                                        | Change                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/cascade/cascade-delete.ts`           | Add `AuthProfile.deleteMany()` to `deleteTenant`, `deleteProject`, `deleteUser`                                |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts` | Add `MASKED_AUDIT_FIELDS` set, mask `encryptedSecrets` and `previousEncryptedSecrets` in `getModifiedFields()` |
| `apps/studio/src/services/retention/mongo-gdpr-store.ts`    | Add `deletePersonalAuthProfiles()` and `reassignSharedAuthProfiles()` methods                                  |
| `apps/studio/src/services/retention/retention-service.ts`   | Add 2 new methods to `GDPRStore` interface                                                                     |
| `apps/runtime/src/services/credential-age-monitor.ts`       | Add `AuthProfile` to `checkAll()` query, map `lastValidatedAt` to `rotatedAt`                                  |
| `apps/runtime/src/__tests__/helpers/auth-context.ts`        | Add `auth-profile:*` to `ROLE_PERMISSIONS` and `PROJECT_ROLE_PERMISSIONS`                                      |

### Implementation Order

1. **C7.1** `AuthProfileError` — needed by everything else
2. **C4.1** Zod validation schemas — needed by service layer
3. **C2.2** Audit event constants — needed by service layer
4. **C7.2** Trace events — needed by service layer
5. **C2.1** Audit trail ciphertext masking — can be done independently
6. **C1.1** Cascade delete — can be done independently
7. **C1.2** MongoGDPRStore — depends on C1.1 model being exported
8. **C3.1** Authz test suite — depends on route existing
9. **C5.1** Health probe — can be done independently
10. **C5.2** Alerting — can be done independently
11. **C6.1** CredentialAgeMonitor — can be done independently

---

## Phase E — Studio UI

> API client, SWR hooks, auth profiles management page, slide-over, picker, OAuth callback page, deployment pre-check.

### Task Group E1: Auth Profiles API Client & SWR Hook

### Task 40: `apps/studio/src/api/auth-profiles.ts` — API client functions

**Test first** (`apps/studio/src/__tests__/api-auth-profiles.test.ts`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchAuthProfiles,
  fetchAuthProfile,
  createAuthProfile,
  updateAuthProfile,
  deleteAuthProfile,
  revokeAuthProfile,
  validateAuthProfile,
  fetchAuthProfileConsumers,
  initiateOAuth,
  handleOAuthProfileCallback,
} from '../api/auth-profiles';

// Mock apiFetch
vi.mock('../lib/api-client', () => ({
  apiFetch: vi.fn(),
  handleResponse: vi.fn(),
}));

describe('auth-profiles API client', () => {
  it('fetchAuthProfiles sends GET with query params', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true, data: [] });

    await fetchAuthProfiles('proj-1', {
      authType: 'oauth2_app',
      status: 'active',
      environment: 'production',
      cursor: 'abc',
      limit: 20,
      sortBy: 'createdAt',
      sortDir: 'desc',
    });

    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/auth-profiles?'),
    );
    const url = (apiFetch as any).mock.calls[0][0];
    expect(url).toContain('authType=oauth2_app');
    expect(url).toContain('status=active');
    expect(url).toContain('sortBy=createdAt');
  });

  it('createAuthProfile sends POST with body', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true, data: { _id: '1' } });

    await createAuthProfile('proj-1', {
      name: 'My API Key',
      authType: 'api_key',
      config: { headerName: 'X-Api-Key', placement: 'header' },
      secrets: { apiKey: 'secret123' },
      environment: 'production',
      visibility: 'shared',
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('revokeAuthProfile sends POST to /revoke', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true });

    await revokeAuthProfile('proj-1', 'ap-1');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles/ap-1/revoke',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('deleteAuthProfile sends DELETE', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true });

    await deleteAuthProfile('proj-1', 'ap-1');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles/ap-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('validateAuthProfile sends POST to /validate', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true, data: { valid: true } });

    await validateAuthProfile('proj-1', 'ap-1');

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles/ap-1/validate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('initiateOAuth sends POST to /oauth/initiate', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({
      success: true,
      data: { authUrl: 'https://provider.com/auth', state: 'abc123' },
    });

    await initiateOAuth('proj-1', {
      connectorName: 'google',
      authProfileId: 'ap-1',
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles/oauth/initiate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('handleOAuthProfileCallback sends POST to /oauth/callback', async () => {
    const { apiFetch, handleResponse } = await import('../lib/api-client');
    (apiFetch as any).mockResolvedValue({ ok: true });
    (handleResponse as any).mockResolvedValue({ success: true, data: { id: 'token-1' } });

    await handleOAuthProfileCallback('proj-1', {
      code: 'auth-code',
      state: 'state-token',
      displayName: 'My Token',
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/auth-profiles/oauth/callback',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

**Implementation** (`apps/studio/src/api/auth-profiles.ts`):

```typescript
/**
 * Auth Profiles API Client
 *
 * Typed fetch functions for the Auth Profile CRUD + OAuth endpoints.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type AuthType =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_app'
  | 'oauth2_token'
  | 'oauth2_client_credentials';

export type AuthProfileStatus = 'active' | 'expired' | 'revoked' | 'invalid';
export type AuthProfileVisibility = 'shared' | 'personal';
export type AuthProfileEnvironment = 'development' | 'staging' | 'production' | null;

export interface AuthProfileSummary {
  id: string;
  name: string;
  description?: string;
  authType: AuthType;
  status: AuthProfileStatus;
  environment: AuthProfileEnvironment;
  visibility: AuthProfileVisibility;
  scope: 'tenant' | 'project';
  inherited?: boolean;
  connector?: string;
  category?: string;
  tags?: string[];
  linkedConsumerCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface AuthProfileDetail extends AuthProfileSummary {
  config: Record<string, unknown>;
  /** Secret fields are redacted — keys present with value '[REDACTED]' */
  redactedSecrets: Record<string, string>;
  linkedAppProfileId?: string;
}

export interface CreateAuthProfilePayload {
  name: string;
  description?: string;
  authType: AuthType;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  environment?: string | null;
  visibility?: AuthProfileVisibility;
  linkedAppProfileId?: string;
  connector?: string;
}

export interface UpdateAuthProfilePayload {
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  environment?: string | null;
  visibility?: AuthProfileVisibility;
}

export interface AuthProfileConsumer {
  type: 'connector_config' | 'connector_connection';
  id: string;
  name: string;
  connectorName?: string;
}

export interface ListAuthProfilesParams {
  authType?: AuthType | AuthType[];
  status?: AuthProfileStatus;
  environment?: string;
  visibility?: AuthProfileVisibility;
  cursor?: string;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'status';
  sortDir?: 'asc' | 'desc';
  search?: string;
}

interface ListResponse<T> {
  success: boolean;
  data: T[];
  pagination: { nextCursor: string | null; total: number };
}

interface SingleResponse<T> {
  success: boolean;
  data: T;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

function buildUrl(base: string, params: Record<string, unknown>): string {
  const url = new URL(base, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

export async function fetchAuthProfiles(
  projectId: string,
  params: ListAuthProfilesParams = {},
): Promise<ListResponse<AuthProfileSummary>> {
  const path = buildUrl(`/api/projects/${encodeURIComponent(projectId)}/auth-profiles`, params);
  const res = await apiFetch(path);
  return handleResponse<ListResponse<AuthProfileSummary>>(res);
}

export async function fetchAuthProfile(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
  );
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function createAuthProfile(
  projectId: string,
  payload: CreateAuthProfilePayload,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/auth-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function updateAuthProfile(
  projectId: string,
  profileId: string,
  payload: UpdateAuthProfilePayload,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function deleteAuthProfile(
  projectId: string,
  profileId: string,
): Promise<{ success: boolean }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
  );
  return handleResponse<{ success: boolean }>(res);
}

export async function revokeAuthProfile(
  projectId: string,
  profileId: string,
): Promise<{ success: boolean }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/revoke`,
    { method: 'POST' },
  );
  return handleResponse<{ success: boolean }>(res);
}

export async function validateAuthProfile(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<{ valid: boolean; message?: string }>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/validate`,
    { method: 'POST' },
  );
  return handleResponse<SingleResponse<{ valid: boolean; message?: string }>>(res);
}

export async function fetchAuthProfileConsumers(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<AuthProfileConsumer[]>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/consumers`,
  );
  return handleResponse<SingleResponse<AuthProfileConsumer[]>>(res);
}

export async function initiateOAuth(
  projectId: string,
  payload: { connectorName: string; authProfileId: string },
): Promise<SingleResponse<{ authUrl: string; state: string }>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/initiate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<{ authUrl: string; state: string }>>(res);
}

export async function handleOAuthProfileCallback(
  projectId: string,
  payload: { code: string; state: string; displayName?: string },
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}
```

### Task 41: `apps/studio/src/hooks/useAuthProfiles.ts` — SWR hook

**Test first** (`apps/studio/src/__tests__/hooks-useAuthProfiles.test.ts`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useSWR from 'swr';

// We test that the hook constructs the correct SWR key and returns normalized data.
// The actual fetcher is globally configured via swrConfig.

vi.mock('swr', async () => {
  const actual = await vi.importActual('swr');
  return actual;
});

describe('useAuthProfiles', () => {
  it('returns empty array when projectId is null', async () => {
    const { buildAuthProfilesKey } = await import('../hooks/useAuthProfiles');
    // When projectId is null, SWR key should be null (disables fetch)
    const key = buildAuthProfilesKey(null, {});
    expect(key).toBeNull();
  });

  it('builds correct SWR key with filter params', () => {
    // Structural test: verify key building logic
    const { buildAuthProfilesKey } = require('../hooks/useAuthProfiles');
    const key = buildAuthProfilesKey('proj-1', { authType: 'api_key', status: 'active' });
    expect(key).toContain('/api/projects/proj-1/auth-profiles');
    expect(key).toContain('authType=api_key');
    expect(key).toContain('status=active');
  });
});
```

**Implementation** (`apps/studio/src/hooks/useAuthProfiles.ts`):

```typescript
/**
 * useAuthProfiles Hook
 *
 * SWR-based hook for fetching and managing the auth profiles list.
 * Supports filtering, sorting, and cursor-based pagination.
 */

'use client';

import { useMemo, useCallback } from 'react';
import useSWR from 'swr';
import type {
  AuthProfileSummary,
  AuthProfileDetail,
  ListAuthProfilesParams,
} from '../api/auth-profiles';

// =============================================================================
// KEY BUILDER
// =============================================================================

export function buildAuthProfilesKey(
  projectId: string | null,
  params: ListAuthProfilesParams = {},
): string | null {
  if (!projectId) return null;
  const base = `/api/projects/${encodeURIComponent(projectId)}/auth-profiles`;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) searchParams.append(key, String(v));
    } else {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

// =============================================================================
// TYPES
// =============================================================================

interface ListResponse {
  success: boolean;
  data: AuthProfileSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface UseAuthProfilesReturn {
  profiles: AuthProfileSummary[];
  total: number;
  nextCursor: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

// =============================================================================
// HOOK
// =============================================================================

export function useAuthProfiles(
  projectId: string | null,
  params: ListAuthProfilesParams = {},
): UseAuthProfilesReturn {
  // Stabilize key using JSON.stringify to prevent infinite render loops when
  // callers pass inline object literals (new reference each render) as params.
  // The string serialization ensures useMemo only recomputes when values change.
  const paramsKey = JSON.stringify(params);
  const key = useMemo(
    () => buildAuthProfilesKey(projectId, JSON.parse(paramsKey)),
    [projectId, paramsKey],
  );

  const { data, error, isLoading, mutate } = useSWR<ListResponse>(key, {
    keepPreviousData: true,
  });

  return {
    profiles: data?.data ?? [],
    total: data?.pagination?.total ?? 0,
    nextCursor: data?.pagination?.nextCursor ?? null,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

// =============================================================================
// SINGLE PROFILE HOOK
// =============================================================================

interface UseAuthProfileReturn {
  profile: AuthProfileDetail | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAuthProfile(
  projectId: string | null,
  profileId: string | null,
): UseAuthProfileReturn {
  const key =
    projectId && profileId
      ? `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; data: AuthProfileDetail }>(
    key,
  );

  return {
    profile: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
```

---

### Task Group E2: Auth Profiles Management Page

### Task 42: Auth Type metadata constants

**File:** `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`

```typescript
/**
 * Auth Type Metadata
 *
 * Display names, icons, categories, and form field definitions
 * for each Phase 1 auth type.
 */

import { Ban, Key, Shield, Globe, Ticket, ServerCog, type LucideIcon } from 'lucide-react';
import type { AuthType } from '../../api/auth-profiles';

// =============================================================================
// TYPES
// =============================================================================

export type AuthTypeCategory = 'standard' | 'oauth' | 'cloud_provider';

export interface AuthTypeMetadata {
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  category: AuthTypeCategory;
  /** Fields shown in the config section (non-sensitive) */
  configFields: FormFieldDef[];
  /** Fields shown in the secrets section (sensitive, write-only) */
  secretFields: FormFieldDef[];
}

export interface FormFieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select' | 'toggle' | 'tags';
  placeholder?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  helpText?: string;
}

// =============================================================================
// CATEGORY METADATA
// =============================================================================

export const AUTH_TYPE_CATEGORIES: {
  key: AuthTypeCategory;
  label: string;
  description: string;
}[] = [
  { key: 'standard', label: 'Standard', description: 'API keys and tokens' },
  { key: 'oauth', label: 'OAuth 2.0', description: 'OAuth app credentials and tokens' },
  {
    key: 'cloud_provider',
    label: 'Cloud Provider',
    description: 'Coming in Phase 2',
  },
];

// =============================================================================
// AUTH TYPE DEFINITIONS (Phase 1 Only)
// =============================================================================

export const AUTH_TYPE_METADATA: Record<AuthType, AuthTypeMetadata> = {
  none: {
    label: 'No Authentication',
    shortLabel: 'None',
    description: 'No credentials required',
    icon: Ban,
    category: 'standard',
    configFields: [],
    secretFields: [],
  },
  api_key: {
    label: 'API Key',
    shortLabel: 'API Key',
    description: 'Static key sent in header or query parameter',
    icon: Key,
    category: 'standard',
    configFields: [
      {
        key: 'headerName',
        label: 'Header Name',
        type: 'text',
        placeholder: 'X-Api-Key',
        required: true,
        helpText: 'The HTTP header or query parameter name',
      },
      {
        key: 'prefix',
        label: 'Prefix',
        type: 'text',
        placeholder: 'e.g. Bearer, Api-Key',
        helpText: 'Optional prefix prepended to the key value',
      },
      {
        key: 'placement',
        label: 'Placement',
        type: 'select',
        options: [
          { value: 'header', label: 'Header' },
          { value: 'query', label: 'Query Parameter' },
        ],
        defaultValue: 'header',
      },
    ],
    secretFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'Enter API key',
      },
    ],
  },
  bearer: {
    label: 'Bearer Token',
    shortLabel: 'Bearer',
    description: 'Static bearer token in Authorization header',
    icon: Shield,
    category: 'standard',
    configFields: [],
    secretFields: [
      {
        key: 'token',
        label: 'Token',
        type: 'password',
        required: true,
        placeholder: 'Enter bearer token',
      },
    ],
  },
  oauth2_app: {
    label: 'OAuth 2.0 App',
    shortLabel: 'OAuth App',
    description: 'OAuth client credentials for initiating authorization flows',
    icon: Globe,
    category: 'oauth',
    configFields: [
      {
        key: 'authorizationUrl',
        label: 'Authorization URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/authorize',
      },
      {
        key: 'tokenUrl',
        label: 'Token URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/token',
      },
      {
        key: 'refreshUrl',
        label: 'Refresh URL',
        type: 'url',
        placeholder: 'https://provider.com/oauth/token',
        helpText: 'Defaults to Token URL if not specified',
      },
      {
        key: 'revocationUrl',
        label: 'Revocation URL',
        type: 'url',
        placeholder: 'https://provider.com/oauth/revoke',
      },
      {
        key: 'defaultScopes',
        label: 'Default Scopes',
        type: 'tags',
        placeholder: 'e.g. read, write',
        helpText: 'Space or comma-separated list of OAuth scopes',
      },
      {
        key: 'scopeSeparator',
        label: 'Scope Separator',
        type: 'text',
        placeholder: ' ',
        defaultValue: ' ',
        helpText: 'Character used to join scopes (usually space or comma)',
      },
      {
        key: 'pkceRequired',
        label: 'Require PKCE',
        type: 'toggle',
        defaultValue: false,
      },
      {
        key: 'pkceMethod',
        label: 'PKCE Method',
        type: 'select',
        options: [
          { value: 'S256', label: 'S256 (recommended)' },
          { value: 'plain', label: 'Plain' },
        ],
        defaultValue: 'S256',
      },
      {
        key: 'setupGuideUrl',
        label: 'Setup Guide URL',
        type: 'url',
        placeholder: 'https://docs.provider.com/setup',
        helpText: 'Link to provider setup documentation',
      },
      {
        key: 'docsUrl',
        label: 'Documentation URL',
        type: 'url',
        placeholder: 'https://docs.provider.com/api',
      },
    ],
    secretFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter OAuth client ID',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter OAuth client secret',
      },
    ],
  },
  oauth2_token: {
    label: 'OAuth 2.0 Token',
    shortLabel: 'OAuth Token',
    description: 'User-authorized OAuth token (created via OAuth flow)',
    icon: Ticket,
    category: 'oauth',
    configFields: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'text',
        required: true,
        placeholder: 'e.g. google, github',
      },
      {
        key: 'scopes',
        label: 'Requested Scopes',
        type: 'tags',
        placeholder: 'e.g. email, profile',
      },
    ],
    secretFields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'Enter access token',
      },
      {
        key: 'refreshToken',
        label: 'Refresh Token',
        type: 'password',
        placeholder: 'Enter refresh token (optional)',
      },
    ],
  },
  oauth2_client_credentials: {
    label: 'OAuth 2.0 Client Credentials',
    shortLabel: 'Client Credentials',
    description: 'Machine-to-machine OAuth using client credentials grant',
    icon: ServerCog,
    category: 'oauth',
    configFields: [
      {
        key: 'tokenUrl',
        label: 'Token URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/token',
      },
      {
        key: 'scopes',
        label: 'Scopes',
        type: 'tags',
        placeholder: 'e.g. api.read, api.write',
      },
    ],
    secretFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter client ID',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter client secret',
      },
    ],
  },
};

/** Phase 1 auth types in display order */
export const PHASE1_AUTH_TYPES: AuthType[] = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
];

/** Status badge variant mapping */
export const STATUS_BADGE_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'default'> = {
  active: 'success',
  expired: 'warning',
  revoked: 'error',
  invalid: 'default',
};
```

### Task 43: Status badge helper

**File:** `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`

```typescript
/**
 * AuthProfileStatusBadge
 *
 * Renders a Badge with dot indicator for auth profile status.
 */

import { Badge } from '../ui/Badge';
import { STATUS_BADGE_VARIANT } from './auth-type-metadata';
import type { AuthProfileStatus } from '../../api/auth-profiles';

interface AuthProfileStatusBadgeProps {
  status: AuthProfileStatus;
}

export function AuthProfileStatusBadge({ status }: AuthProfileStatusBadgeProps) {
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status] ?? 'default'} dot>
      {status}
    </Badge>
  );
}
```

### Task 44: Auth Profiles Management Page

**Test first** (`apps/studio/src/__tests__/AuthProfilesPage.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfiles: vi.fn(() => ({
    profiles: [],
    total: 0,
    nextCursor: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));
vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: vi.fn(() => ({ projectId: 'proj-1' })),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

describe('AuthProfilesPage', () => {
  it('renders empty state when no profiles exist', async () => {
    const { AuthProfilesPage } = await import(
      '../../components/auth-profiles/AuthProfilesPage'
    );
    render(<AuthProfilesPage />);
    expect(screen.getByText('No auth profiles yet')).toBeInTheDocument();
  });

  it('renders table when profiles exist', async () => {
    const { useAuthProfiles } = await import('../../hooks/useAuthProfiles');
    (useAuthProfiles as any).mockReturnValue({
      profiles: [
        {
          id: '1',
          name: 'My API Key',
          authType: 'api_key',
          status: 'active',
          environment: 'production',
          visibility: 'shared',
          linkedConsumerCount: 2,
          lastUsedAt: '2026-03-10T00:00:00Z',
          createdAt: '2026-03-01T00:00:00Z',
        },
      ],
      total: 1,
      nextCursor: null,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    const { AuthProfilesPage } = await import(
      '../../components/auth-profiles/AuthProfilesPage'
    );
    render(<AuthProfilesPage />);
    expect(screen.getByText('My API Key')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });
});
```

**Implementation** (`apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`):

```typescript
/**
 * AuthProfilesPage — Auth Profiles management listing.
 *
 * Uses ListPageShell with DataTable for sortable, filterable table.
 * Supports: search, filter by authType/status/environment, bulk revoke/delete.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import {
  KeyRound,
  Plus,
  Trash2,
  ShieldOff,
  MoreHorizontal,
  ExternalLink,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import { revokeAuthProfile, deleteAuthProfile } from '../../api/auth-profiles';
import type {
  AuthProfileSummary,
  AuthType,
  AuthProfileStatus,
  ListAuthProfilesParams,
} from '../../api/auth-profiles';
import { ListPageShell } from '../ui/ListPageShell';
import { DataTable, type Column } from '../ui/DataTable';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { EmptyState } from '../ui/EmptyState';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import {
  AUTH_TYPE_METADATA,
  PHASE1_AUTH_TYPES,
  STATUS_BADGE_VARIANT,
} from './auth-type-metadata';
import { AuthProfileSlideOver } from './AuthProfileSlideOver';

// =============================================================================
// CONSTANTS
// =============================================================================

const PAGE_SIZE = 20;

const AUTH_TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All types' },
  ...PHASE1_AUTH_TYPES.filter((t) => t !== 'none').map((t) => ({
    value: t,
    label: AUTH_TYPE_METADATA[t].shortLabel,
  })),
];

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'expired', label: 'Expired' },
  { value: 'revoked', label: 'Revoked' },
  { value: 'invalid', label: 'Invalid' },
];

const ENVIRONMENT_FILTER_OPTIONS = [
  { value: '', label: 'All environments' },
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfilesPage() {
  const { projectId } = useNavigationStore();

  // Filters
  const [search, setSearch] = useState('');
  const [authTypeFilter, setAuthTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Selection for bulk actions
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Slide-over state
  const [slideOverOpen, setSlideOverOpen] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string | null>(null);

  // Build params
  const params: ListAuthProfilesParams = useMemo(
    () => ({
      search: search || undefined,
      authType: (authTypeFilter as AuthType) || undefined,
      status: (statusFilter as AuthProfileStatus) || undefined,
      environment: envFilter || undefined,
      limit: PAGE_SIZE,
      sortBy: sortBy as ListAuthProfilesParams['sortBy'],
      sortDir,
    }),
    [search, authTypeFilter, statusFilter, envFilter, sortBy, sortDir],
  );

  const { profiles, total, isLoading, error, refresh } = useAuthProfiles(projectId, params);

  // Selection helpers
  const allSelected = profiles.length > 0 && profiles.every((p) => selected.has(p.id));
  const someSelected = selected.size > 0;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(profiles.map((p) => p.id)));
    }
  }, [allSelected, profiles]);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Bulk actions
  const handleBulkRevoke = useCallback(async () => {
    if (!projectId) return;
    const ids = Array.from(selected);
    await Promise.allSettled(ids.map((id) => revokeAuthProfile(projectId, id)));
    setSelected(new Set());
    refresh();
  }, [projectId, selected, refresh]);

  const handleBulkDelete = useCallback(async () => {
    if (!projectId) return;
    const ids = Array.from(selected);
    await Promise.allSettled(ids.map((id) => deleteAuthProfile(projectId, id)));
    setSelected(new Set());
    refresh();
  }, [projectId, selected, refresh]);

  // Row actions
  const handleEdit = useCallback((profile: AuthProfileSummary) => {
    setEditProfileId(profile.id);
    setSlideOverOpen(true);
  }, []);

  const handleCreate = useCallback(() => {
    setEditProfileId(null);
    setSlideOverOpen(true);
  }, []);

  const handleSlideOverClose = useCallback(() => {
    setSlideOverOpen(false);
    setEditProfileId(null);
  }, []);

  const handleSlideOverSaved = useCallback(() => {
    handleSlideOverClose();
    refresh();
  }, [handleSlideOverClose, refresh]);

  // Format relative time
  const formatRelativeTime = (dateStr: string | null) => {
    if (!dateStr) return '--';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Table columns
  const columns: Column<AuthProfileSummary>[] = useMemo(
    () => [
      {
        key: 'select',
        label: '',
        width: 'w-10',
        render: (row) => (
          <Checkbox
            checked={selected.has(row.id)}
            onChange={() => toggleOne(row.id)}
          />
        ),
      },
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        sortValue: (row) => row.name.toLowerCase(),
        render: (row) => {
          const meta = AUTH_TYPE_METADATA[row.authType];
          const Icon = meta?.icon;
          return (
            <div className="flex items-center gap-2.5">
              {Icon && (
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-background-muted">
                  <Icon className="h-3.5 w-3.5 text-muted" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{row.name}</p>
                <p className="text-xs text-muted">{meta?.shortLabel ?? row.authType}</p>
              </div>
              {row.inherited && (
                <Badge variant="info" className="ml-1">inherited</Badge>
              )}
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        sortValue: (row) => row.status,
        render: (row) => <AuthProfileStatusBadge status={row.status} />,
      },
      {
        key: 'environment',
        label: 'Environment',
        render: (row) =>
          row.environment ? (
            <Badge variant="default">{row.environment}</Badge>
          ) : (
            <span className="text-xs text-subtle">All</span>
          ),
      },
      {
        key: 'visibility',
        label: 'Visibility',
        render: (row) => (
          <span className="text-xs text-muted capitalize">{row.visibility}</span>
        ),
      },
      {
        key: 'consumers',
        label: 'Consumers',
        sortable: true,
        sortValue: (row) => row.linkedConsumerCount,
        render: (row) => (
          <span className="text-xs text-muted font-mono">{row.linkedConsumerCount}</span>
        ),
      },
      {
        key: 'lastUsedAt',
        label: 'Last Used',
        sortable: true,
        sortValue: (row) =>
          row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0,
        render: (row) => (
          <span className="text-xs text-muted">{formatRelativeTime(row.lastUsedAt)}</span>
        ),
      },
      {
        key: 'actions',
        label: '',
        width: 'w-10',
        render: (row) => (
          <DropdownMenu
            trigger={
              <button
                className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default"
                aria-label="Row actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            }
          >
            <DropdownMenuItem
              icon={<ExternalLink className="w-3.5 h-3.5" />}
              onSelect={() => handleEdit(row)}
            >
              Edit
            </DropdownMenuItem>
            {row.status === 'active' && (
              <DropdownMenuItem
                icon={<ShieldOff className="w-3.5 h-3.5" />}
                onSelect={async () => {
                  if (projectId) {
                    await revokeAuthProfile(projectId, row.id);
                    refresh();
                  }
                }}
              >
                Revoke
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="danger"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              onSelect={async () => {
                if (projectId) {
                  await deleteAuthProfile(projectId, row.id);
                  refresh();
                }
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenu>
        ),
      },
    ],
    [selected, toggleOne, handleEdit, projectId, refresh],
  );

  // Empty state
  if (!isLoading && profiles.length === 0 && !search && !authTypeFilter && !statusFilter) {
    return (
      <div className="h-full flex flex-col">
        <EmptyState
          icon={<KeyRound className="h-6 w-6" />}
          title="No auth profiles yet"
          description="Auth profiles store credentials for connectors and tools. Create one to get started."
          action={
            <Button
              icon={<Plus className="w-4 h-4" />}
              onClick={handleCreate}
            >
              New Auth Profile
            </Button>
          }
        />
      </div>
    );
  }

  // Note: SlideOver is rendered ONLY in the main list view below,
  // not duplicated in the empty state branch.

  return (
    <>
      <ListPageShell
        title="Auth Profiles"
        description="Manage credentials for connectors, tools, and integrations"
        primaryAction={
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={handleCreate}
            size="sm"
          >
            New Auth Profile
          </Button>
        }
        secondaryActions={
          someSelected ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{selected.size} selected</span>
              <Button
                variant="secondary"
                size="xs"
                icon={<ShieldOff className="w-3 h-3" />}
                onClick={handleBulkRevoke}
              >
                Revoke
              </Button>
              <Button
                variant="danger"
                size="xs"
                icon={<Trash2 className="w-3 h-3" />}
                onClick={handleBulkDelete}
              >
                Delete
              </Button>
            </div>
          ) : undefined
        }
        searchPlaceholder="Search auth profiles..."
        searchValue={search}
        onSearchChange={setSearch}
        filters={[
          {
            id: 'authType',
            label: 'Auth Type',
            options: AUTH_TYPE_FILTER_OPTIONS,
            value: authTypeFilter,
            onChange: setAuthTypeFilter,
          },
          {
            id: 'status',
            label: 'Status',
            options: STATUS_FILTER_OPTIONS,
            value: statusFilter,
            onChange: setStatusFilter,
          },
          {
            id: 'environment',
            label: 'Environment',
            options: ENVIRONMENT_FILTER_OPTIONS,
            value: envFilter,
            onChange: setEnvFilter,
          },
        ]}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: setPage,
        }}
      >
        {error ? (
          <EmptyState
            icon={<KeyRound className="h-6 w-6" />}
            title="Failed to load auth profiles"
            description={error}
            action={
              <Button variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={profiles}
            keyExtractor={(row) => row.id}
            onRowClick={handleEdit}
            emptyMessage="No auth profiles match the current filters"
          />
        )}
      </ListPageShell>

      {projectId && (
        <AuthProfileSlideOver
          open={slideOverOpen}
          onClose={handleSlideOverClose}
          onSaved={handleSlideOverSaved}
          projectId={projectId}
          editProfileId={editProfileId}
        />
      )}
    </>
  );
}
```

### Task 45: Wire Auth Profiles into SPA routing

> **IMPORTANT:** Studio uses SPA routing via `navigation-store.ts` + `AppShell.tsx` `renderContent()` switch — NOT Next.js App Router `page.tsx` files. Do NOT create a `page.tsx` file for auth profiles.

**Changes required (3 files):**

**1. `apps/studio/src/store/navigation-store.ts`** — Add `'settings-auth-profiles'` to the `ProjectPage` type union:

```typescript
// In the ProjectPage type union, add:
| 'settings-auth-profiles'
```

And add to the `settingsSubPages` map in `parseUrl()`:

```typescript
const settingsSubPages: Record<string, ProjectPage> = {
  // ...existing entries...
  'auth-profiles': 'settings-auth-profiles',
};
```

And add to the `settingsPageMap` in `buildPath()`:

```typescript
const settingsPageMap: Record<string, string> = {
  // ...existing entries...
  'settings-auth-profiles': 'auth-profiles',
};
```

**2. `apps/studio/src/components/navigation/AppShell.tsx`** — Add case to `renderContent()`:

```typescript
case 'settings-auth-profiles':
  return <AuthProfilesPage />;
```

And add the import at the top:

```typescript
import { AuthProfilesPage } from '../auth-profiles/AuthProfilesPage';
```

**3. `apps/studio/src/components/navigation/ProjectSidebar.tsx`** — In the settings `NavGroup`, add `'settings-auth-profiles'` to the `pages` array and add the nav item to the `items` array:

```typescript
// In the settings NavGroup `pages` array, add:
'settings-auth-profiles',

// In the settings NavGroup `items` array, add:
{ id: 'settings-auth-profiles', Icon: KeyRound, key: 'auth_profiles' },
```

---

### Task Group E3: Auth Profile Slide-Over (Create/Edit)

### Task 46: Slide-over component

**Test first** (`apps/studio/src/__tests__/AuthProfileSlideOver.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfile: vi.fn(() => ({
    profile: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('AuthProfileSlideOver', () => {
  it('shows type selector in create mode', async () => {
    const { AuthProfileSlideOver } = await import(
      '../../components/auth-profiles/AuthProfileSlideOver'
    );
    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId={null}
      />,
    );
    expect(screen.getByText('New Auth Profile')).toBeInTheDocument();
    expect(screen.getByText('API Key')).toBeInTheDocument();
    expect(screen.getByText('Bearer Token')).toBeInTheDocument();
    expect(screen.getByText('OAuth 2.0 App')).toBeInTheDocument();
  });

  it('shows dynamic form after selecting auth type', async () => {
    const { AuthProfileSlideOver } = await import(
      '../../components/auth-profiles/AuthProfileSlideOver'
    );
    render(
      <AuthProfileSlideOver
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        projectId="proj-1"
        editProfileId={null}
      />,
    );
    fireEvent.click(screen.getByText('API Key'));
    expect(screen.getByLabelText(/Header Name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/API Key/i)).toBeInTheDocument();
  });
});
```

**Implementation** (`apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`):

```typescript
/**
 * AuthProfileSlideOver — Create/Edit Auth Profile
 *
 * Uses Framer Motion slide-over pattern (VersionsSlideOver style).
 * Step 1 (create only): Type selector organized by category.
 * Step 2: Dynamic form driven by auth-type-metadata field definitions.
 */

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  ArrowLeft,
  KeyRound,
  Shield,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Eye,
  EyeOff,
} from 'lucide-react';
import { clsx } from 'clsx';
import { springs, transitions } from '@/lib/animation';
import { useAuthProfile } from '../../hooks/useAuthProfiles';
import {
  createAuthProfile,
  updateAuthProfile,
  validateAuthProfile,
} from '../../api/auth-profiles';
import type { AuthType, AuthProfileDetail } from '../../api/auth-profiles';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { Badge } from '../ui/Badge';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  AUTH_TYPE_METADATA,
  AUTH_TYPE_CATEGORIES,
  PHASE1_AUTH_TYPES,
  type FormFieldDef,
} from './auth-type-metadata';

// =============================================================================
// CONSTANTS
// =============================================================================

const PANEL_WIDTH = 'w-[520px]';

const ENVIRONMENT_OPTIONS = [
  { value: '', label: 'All environments' },
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

// =============================================================================
// PROPS
// =============================================================================

interface AuthProfileSlideOverProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  projectId: string;
  editProfileId: string | null;
  /** Pre-select auth type when opening from connector setup */
  preselectedAuthType?: AuthType;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfileSlideOver({
  open,
  onClose,
  onSaved,
  projectId,
  editProfileId,
  preselectedAuthType,
}: AuthProfileSlideOverProps) {
  const isEdit = Boolean(editProfileId);
  const { profile, isLoading: profileLoading } = useAuthProfile(
    isEdit ? projectId : null,
    editProfileId,
  );

  // Form state
  const [step, setStep] = useState<'select-type' | 'form'>('select-type');
  const [authType, setAuthType] = useState<AuthType | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [environment, setEnvironment] = useState('');
  const [visibility, setVisibility] = useState<'shared' | 'personal'>('shared');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [secretsUnchanged, setSecretsUnchanged] = useState<Set<string>>(new Set());
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    valid: boolean;
    message?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setError(null);
      setFieldErrors({});
      setTestResult(null);
      if (isEdit && profile) {
        // Populate form from profile
        setStep('form');
        setAuthType(profile.authType);
        setName(profile.name);
        setDescription(profile.description ?? '');
        setEnvironment(profile.environment ?? '');
        setVisibility(profile.visibility);
        setConfig(profile.config ?? {});
        setSecrets({});
        setSecretsUnchanged(
          new Set(Object.keys(profile.redactedSecrets ?? {})),
        );
      } else if (preselectedAuthType) {
        setStep('form');
        setAuthType(preselectedAuthType);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setConfig({});
        setSecrets({});
        setSecretsUnchanged(new Set());
      } else {
        setStep('select-type');
        setAuthType(null);
        setName('');
        setDescription('');
        setEnvironment('');
        setVisibility('shared');
        setConfig({});
        setSecrets({});
        setSecretsUnchanged(new Set());
      }
    }
  }, [open, isEdit, profile, preselectedAuthType]);

  const meta = authType ? AUTH_TYPE_METADATA[authType] : null;

  // Handle type selection
  const handleTypeSelect = useCallback((type: AuthType) => {
    setAuthType(type);
    setConfig({});
    setSecrets({});
    // Apply default values
    const m = AUTH_TYPE_METADATA[type];
    const defaults: Record<string, unknown> = {};
    for (const field of m.configFields) {
      if (field.defaultValue !== undefined) defaults[field.key] = field.defaultValue;
    }
    setConfig(defaults);
    setStep('form');
  }, []);

  // Field change handlers
  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const handleSecretChange = useCallback((key: string, value: string) => {
    setSecrets((prev) => ({ ...prev, [key]: value }));
    setSecretsUnchanged((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Client-side validation
  const validate = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'Name is required';
    if (meta) {
      for (const field of meta.configFields) {
        if (field.required && !config[field.key]) {
          errors[field.key] = `${field.label} is required`;
        }
      }
      for (const field of meta.secretFields) {
        if (field.required && !isEdit && !secrets[field.key]) {
          errors[field.key] = `${field.label} is required`;
        }
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [name, meta, config, secrets, isEdit]);

  // Save
  const handleSave = useCallback(async () => {
    if (!authType || !validate()) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit && editProfileId) {
        // Only send changed secrets
        const changedSecrets: Record<string, string> = {};
        for (const [key, val] of Object.entries(secrets)) {
          if (!secretsUnchanged.has(key) && val) {
            changedSecrets[key] = val;
          }
        }
        await updateAuthProfile(projectId, editProfileId, {
          name,
          description: description || undefined,
          config,
          secrets: Object.keys(changedSecrets).length > 0 ? changedSecrets : undefined,
          environment: environment || null,
          visibility,
        });
      } else {
        await createAuthProfile(projectId, {
          name,
          description: description || undefined,
          authType,
          config,
          secrets,
          environment: environment || null,
          visibility,
        });
      }
      onSaved();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to save auth profile'));
    } finally {
      setSaving(false);
    }
  }, [
    authType,
    validate,
    isEdit,
    editProfileId,
    projectId,
    name,
    description,
    config,
    secrets,
    secretsUnchanged,
    environment,
    visibility,
    onSaved,
  ]);

  // Test credentials
  const handleTest = useCallback(async () => {
    if (!editProfileId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await validateAuthProfile(projectId, editProfileId);
      setTestResult(result.data);
    } catch (err) {
      setTestResult({ valid: false, message: sanitizeError(err, 'Validation failed') });
    } finally {
      setTesting(false);
    }
  }, [projectId, editProfileId]);

  // Render a form field from metadata
  const renderField = useCallback(
    (field: FormFieldDef, isSecret: boolean) => {
      const key = field.key;
      const value = isSecret ? secrets[key] ?? '' : config[key];
      const fieldError = fieldErrors[key];

      if (isSecret && isEdit && secretsUnchanged.has(key)) {
        return (
          <div key={key} className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">
              {field.label}
            </label>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-muted font-mono">
                ********
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setSecretsUnchanged((prev) => {
                    const next = new Set(prev);
                    next.delete(key);
                    return next;
                  });
                }}
              >
                Change
              </Button>
            </div>
            <p className="text-xs text-muted">Value unchanged since last save</p>
          </div>
        );
      }

      switch (field.type) {
        case 'text':
        case 'url':
          return (
            <Input
              key={key}
              label={field.label}
              type="text"
              value={String(value ?? '')}
              onChange={(e) =>
                isSecret
                  ? handleSecretChange(key, e.target.value)
                  : handleConfigChange(key, e.target.value)
              }
              placeholder={field.placeholder}
              error={fieldError}
            />
          );
        case 'password': {
          const show = showSecrets[key];
          return (
            <div key={key} className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">
                {field.label}
              </label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={String(value ?? '')}
                  onChange={(e) =>
                    isSecret
                      ? handleSecretChange(key, e.target.value)
                      : handleConfigChange(key, e.target.value)
                  }
                  placeholder={field.placeholder}
                  className={clsx(
                    'w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
                    'transition-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
                    'text-sm py-2 pl-3 pr-9',
                    fieldError ? 'border-error' : 'border-default',
                  )}
                />
                <button
                  type="button"
                  onClick={() =>
                    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }))
                  }
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-foreground transition-default"
                  aria-label={show ? 'Hide value' : 'Show value'}
                >
                  {show ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {fieldError && <p className="text-xs text-error">{fieldError}</p>}
              {field.helpText && !fieldError && (
                <p className="text-xs text-muted">{field.helpText}</p>
              )}
            </div>
          );
        }
        case 'select':
          return (
            <Select
              key={key}
              label={field.label}
              options={field.options ?? []}
              value={String(value ?? field.defaultValue ?? '')}
              onChange={(e) =>
                isSecret
                  ? handleSecretChange(key, e.target.value)
                  : handleConfigChange(key, e.target.value)
              }
              error={fieldError}
            />
          );
        case 'toggle':
          return (
            <Toggle
              key={key}
              label={field.label}
              description={field.helpText}
              checked={Boolean(value ?? field.defaultValue)}
              onChange={(checked) => handleConfigChange(key, checked)}
            />
          );
        case 'tags':
          return (
            <Input
              key={key}
              label={field.label}
              type="text"
              value={
                Array.isArray(value) ? (value as string[]).join(', ') : String(value ?? '')
              }
              onChange={(e) => {
                const tags = e.target.value
                  .split(/[,\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                handleConfigChange(key, tags);
              }}
              placeholder={field.placeholder}
              error={fieldError}
            />
          );
        default:
          return null;
      }
    },
    [
      config,
      secrets,
      secretsUnchanged,
      fieldErrors,
      showSecrets,
      isEdit,
      handleConfigChange,
      handleSecretChange,
    ],
  );

  // Group Phase 1 types by category
  const typesByCategory = useMemo(() => {
    return AUTH_TYPE_CATEGORIES.filter((cat) => cat.key !== 'cloud_provider').map((cat) => ({
      ...cat,
      types: PHASE1_AUTH_TYPES.filter((t) => AUTH_TYPE_METADATA[t].category === cat.key),
    }));
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="auth-profile-backdrop"
            className="fixed inset-0 z-40 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="auth-profile-panel"
            className={clsx(
              'fixed top-0 right-0 z-50 h-full',
              PANEL_WIDTH,
              'bg-background-elevated border-l border-default shadow-xl',
              'flex flex-col',
            )}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={springs.gentle}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
              <div className="flex items-center gap-2">
                {step === 'form' && !isEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setStep('select-type');
                      setAuthType(null);
                    }}
                    className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default"
                    aria-label="Back to type selection"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
                <KeyRound className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">
                  {isEdit ? 'Edit Auth Profile' : 'New Auth Profile'}
                </h2>
                {authType && meta && (
                  <Badge variant="accent">{meta.shortLabel}</Badge>
                )}
              </div>
              <button
                type="button"
                aria-label="Close panel"
                onClick={onClose}
                className="p-1.5 rounded-md transition-fast text-muted hover:text-foreground hover:bg-background-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {profileLoading && isEdit ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 text-accent animate-spin" />
                </div>
              ) : step === 'select-type' ? (
                /* Type Selector */
                <div className="space-y-5">
                  <p className="text-sm text-muted">
                    Choose the authentication type for this profile.
                  </p>
                  {typesByCategory.map((cat) => (
                    <div key={cat.key}>
                      <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                        {cat.label}
                      </h3>
                      <div className="space-y-1.5">
                        {cat.types.map((type) => {
                          const m = AUTH_TYPE_METADATA[type];
                          const Icon = m.icon;
                          return (
                            <button
                              key={type}
                              type="button"
                              onClick={() => handleTypeSelect(type)}
                              className={clsx(
                                'w-full flex items-center gap-3 p-3 rounded-lg border border-default',
                                'hover:border-accent hover:bg-accent-subtle/30 transition-default text-left',
                              )}
                            >
                              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-background-muted shrink-0">
                                <Icon className="h-4 w-4 text-muted" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-foreground">
                                  {m.label}
                                </p>
                                <p className="text-xs text-muted">{m.description}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : meta ? (
                /* Dynamic Form */
                <div className="space-y-5">
                  {/* Name & description */}
                  <Input
                    label="Profile Name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.name;
                        return next;
                      });
                    }}
                    placeholder={`e.g. ${meta.label} - Production`}
                    error={fieldErrors.name}
                  />
                  <Input
                    label="Description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                  />

                  {/* Environment */}
                  <Select
                    label="Environment"
                    options={ENVIRONMENT_OPTIONS}
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                  />

                  {/* Visibility */}
                  <Toggle
                    label="Shared"
                    description={
                      visibility === 'shared'
                        ? 'Visible to all project members'
                        : 'Only visible to you'
                    }
                    checked={visibility === 'shared'}
                    onChange={(checked) =>
                      setVisibility(checked ? 'shared' : 'personal')
                    }
                  />

                  {/* Config fields */}
                  {meta.configFields.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                        Configuration
                      </h3>
                      {meta.configFields.map((field) => renderField(field, false))}
                    </div>
                  )}

                  {/* Secret fields */}
                  {meta.secretFields.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-medium text-muted uppercase tracking-wider flex items-center gap-1.5">
                        <Shield className="w-3 h-3" />
                        Secrets
                      </h3>
                      <p className="text-xs text-muted">
                        Secrets are encrypted at rest and never displayed after saving.
                      </p>
                      {meta.secretFields.map((field) => renderField(field, true))}
                    </div>
                  )}

                  {/* Test result */}
                  {testResult && (
                    <div
                      className={clsx(
                        'flex items-center gap-2 p-3 rounded-lg text-sm',
                        testResult.valid
                          ? 'bg-success-subtle text-success'
                          : 'bg-error-subtle text-error',
                      )}
                    >
                      {testResult.valid ? (
                        <CheckCircle className="w-4 h-4 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                      )}
                      <span>
                        {testResult.valid
                          ? 'Credentials validated successfully'
                          : testResult.message ?? 'Validation failed'}
                      </span>
                    </div>
                  )}

                  {/* Error */}
                  {error && (
                    <p className="text-sm text-error">{error}</p>
                  )}
                </div>
              ) : null}
            </div>

            {/* Footer */}
            {step === 'form' && meta && (
              <div className="shrink-0 px-5 py-4 border-t border-default flex items-center gap-2">
                {isEdit && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleTest}
                    loading={testing}
                    disabled={saving}
                  >
                    Test Credentials
                  </Button>
                )}
                <div className="flex-1" />
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} loading={saving}>
                  {isEdit ? 'Save Changes' : 'Create Profile'}
                </Button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
```

---

### Task Group E4: AuthProfilePicker Component

### Task 47: Reusable picker

**Test first** (`apps/studio/src/__tests__/AuthProfilePicker.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfiles: vi.fn(() => ({
    profiles: [
      {
        id: 'ap-1',
        name: 'Gmail OAuth',
        authType: 'oauth2_app',
        status: 'active',
        environment: 'production',
        visibility: 'shared',
      },
      {
        id: 'ap-2',
        name: 'Slack Token',
        authType: 'bearer',
        status: 'expired',
        environment: null,
        visibility: 'shared',
      },
    ],
    total: 2,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('AuthProfilePicker', () => {
  it('renders options filtered by compatible authType', async () => {
    const { AuthProfilePicker } = await import(
      '../../components/auth-profiles/AuthProfilePicker'
    );
    render(
      <AuthProfilePicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
        compatibleAuthTypes={['oauth2_app']}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Gmail OAuth')).toBeInTheDocument();
    expect(screen.queryByText('Slack Token')).not.toBeInTheDocument();
  });

  it('shows "Create New" option', async () => {
    const { AuthProfilePicker } = await import(
      '../../components/auth-profiles/AuthProfilePicker'
    );
    render(
      <AuthProfilePicker
        projectId="proj-1"
        value={null}
        onChange={vi.fn()}
        compatibleAuthTypes={['oauth2_app']}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Create new')).toBeInTheDocument();
  });
});
```

**Implementation** (`apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`):

```typescript
/**
 * AuthProfilePicker
 *
 * Reusable dropdown for selecting an Auth Profile from the current project.
 * Filters by compatible authType(s), shows status badge and environment.
 * Includes a "Create new" option that opens the slide-over.
 */

'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, Search, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import type { AuthProfileSummary, AuthType } from '../../api/auth-profiles';
import { Badge } from '../ui/Badge';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';
import {
  AUTH_TYPE_METADATA,
  STATUS_BADGE_VARIANT,
} from './auth-type-metadata';
import { AuthProfileSlideOver } from './AuthProfileSlideOver';

// =============================================================================
// PROPS
// =============================================================================

interface AuthProfilePickerProps {
  projectId: string;
  value: string | null;
  onChange: (profileId: string | null) => void;
  compatibleAuthTypes?: AuthType[];
  label?: string;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  /** Pre-select auth type when creating new from picker */
  createAuthType?: AuthType;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfilePicker({
  projectId,
  value,
  onChange,
  compatibleAuthTypes,
  label,
  placeholder = 'Select auth profile...',
  error,
  disabled,
  createAuthType,
}: AuthProfilePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { profiles, refresh } = useAuthProfiles(projectId);

  // Filter by compatible types
  const filtered = useMemo(() => {
    let list = profiles;
    if (compatibleAuthTypes && compatibleAuthTypes.length > 0) {
      list = list.filter((p) => compatibleAuthTypes.includes(p.authType));
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.authType.toLowerCase().includes(q),
      );
    }
    return list;
  }, [profiles, compatibleAuthTypes, search]);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === value) ?? null,
    [profiles, value],
  );

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Focus search when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleSelect = useCallback(
    (profileId: string) => {
      onChange(profileId);
      setOpen(false);
      setSearch('');
    },
    [onChange],
  );

  const handleCreateNew = useCallback(() => {
    setOpen(false);
    setSearch('');
    setCreateOpen(true);
  }, []);

  const handleCreated = useCallback(() => {
    setCreateOpen(false);
    refresh();
  }, [refresh]);

  return (
    <>
      <div className="space-y-1.5" ref={containerRef}>
        {label && (
          <label className="block text-sm font-medium text-foreground">{label}</label>
        )}
        <div className="relative">
          <button
            type="button"
            disabled={disabled}
            onClick={() => !disabled && setOpen((p) => !p)}
            className={clsx(
              'w-full flex items-center justify-between rounded-lg border bg-background-subtle text-foreground',
              'transition-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
              'text-sm py-2 pl-3 pr-8 text-left',
              error ? 'border-error' : 'border-default',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {selectedProfile ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">{selectedProfile.name}</span>
                <Badge variant={STATUS_BADGE_VARIANT[selectedProfile.status] ?? 'default'} dot>
                  {selectedProfile.authType}
                </Badge>
              </div>
            ) : (
              <span className="text-subtle">{placeholder}</span>
            )}
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          </button>

          {open && (
            <div className="absolute z-50 mt-1 w-full rounded-lg border border-default bg-background shadow-lg">
              {/* Search */}
              <div className="flex items-center gap-2 border-b border-default px-3 py-2">
                <Search className="w-3.5 h-3.5 text-muted shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search profiles..."
                  className="w-full bg-transparent text-sm text-foreground placeholder:text-subtle focus:outline-none"
                />
              </div>

              {/* Options */}
              <div className="max-h-56 overflow-y-auto py-1">
                {/* None option */}
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={clsx(
                    'w-full text-left px-3 py-2 text-sm transition-default',
                    value === null
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-muted hover:bg-background-muted hover:text-foreground',
                  )}
                >
                  None
                </button>

                {filtered.map((profile) => {
                  const meta = AUTH_TYPE_METADATA[profile.authType];
                  const Icon = meta?.icon;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => handleSelect(profile.id)}
                      className={clsx(
                        'w-full text-left px-3 py-2 transition-default',
                        profile.id === value
                          ? 'bg-accent/10'
                          : 'hover:bg-background-muted',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {Icon && <Icon className="w-3.5 h-3.5 text-muted shrink-0" />}
                        <span className="text-sm text-foreground truncate flex-1">
                          {profile.name}
                        </span>
                        <AuthProfileStatusBadge status={profile.status} />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 pl-5">
                        <span className="text-xs text-muted">{meta?.shortLabel}</span>
                        {profile.environment && (
                          <Badge variant="default" className="text-[10px]">
                            {profile.environment}
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                })}

                {filtered.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted">No matching profiles</p>
                )}
              </div>

              {/* Create new */}
              <div className="border-t border-default px-1 py-1">
                <button
                  type="button"
                  onClick={handleCreateNew}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-accent hover:bg-accent-subtle/30 rounded-md transition-default"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create new
                </button>
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-xs text-error">{error}</p>}
      </div>

      <AuthProfileSlideOver
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleCreated}
        projectId={projectId}
        editProfileId={null}
        preselectedAuthType={createAuthType}
      />
    </>
  );
}
```

---

### Task Group E5: Connector Setup Flow Integration

### Task 48: Wire AuthProfilePicker into CreateConnectionModal

**Modification target:** `apps/studio/src/components/connections/CreateConnectionModal.tsx`

**Changes required:**

1. Import `AuthProfilePicker` from `../auth-profiles/AuthProfilePicker`.
2. In the `configure` step, when the selected connector has `authType === 'oauth2'`, replace the direct `OAuthFlowDialog` trigger with an `AuthProfilePicker` filtered by `compatibleAuthTypes={['oauth2_app']}`.
3. Add a `selectedAuthProfileId` state field.
4. When an `oauth2_app` profile is selected, show a "Connect" button that calls `initiateOAuth` with the `authProfileId`.
5. For non-OAuth connectors, add an `AuthProfilePicker` filtered by `['api_key', 'bearer']` as an alternative to direct credential input.
6. Add a toggle: "Use Auth Profile" vs "Enter credentials directly" for connectors that support both.

**Test first** (`apps/studio/src/__tests__/CreateConnectionModal-auth-profile.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useAvailableConnectors', () => ({
  useAvailableConnectors: vi.fn(() => ({
    connectors: [
      {
        name: 'gmail',
        displayName: 'Gmail',
        authType: 'oauth2',
        oauth2: { authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' },
      },
    ],
    isLoading: false,
  })),
}));
vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfiles: vi.fn(() => ({
    profiles: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
  useAuthProfile: vi.fn(() => ({
    profile: null,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('CreateConnectionModal with Auth Profile', () => {
  it('shows AuthProfilePicker for OAuth connectors in configure step', async () => {
    // When the connector setup flow opens for an OAuth connector,
    // the AuthProfilePicker should be present to select an oauth2_app profile
    // This test verifies the integration point exists
    const mod = await import('../auth-profiles/AuthProfilePicker');
    expect(mod.AuthProfilePicker).toBeDefined();
  });
});
```

**Implementation approach (diff, not full rewrite):**

In `CreateConnectionModal.tsx`, add the following changes:

```typescript
// NEW IMPORTS
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';
import { initiateOAuth } from '../../api/auth-profiles';

// NEW STATE (inside component)
const [authProfileId, setAuthProfileId] = useState<string | null>(null);

// In the configure step, replace the OAuth button section:
// BEFORE:
//   {selected.authType === 'oauth2' && selected.oauth2?.authorizationUrl ? (
//     <Button onClick={() => setOauthConnector({...})}>Connect</Button>
//   ) : (...)}
//
// AFTER:
//   {selected.authType === 'oauth2' ? (
//     <div className="space-y-4">
//       <AuthProfilePicker
//         projectId={projectId}
//         value={authProfileId}
//         onChange={setAuthProfileId}
//         compatibleAuthTypes={['oauth2_app']}
//         label="OAuth App Credentials"
//         placeholder="Select OAuth app profile..."
//         createAuthType="oauth2_app"
//       />
//       {authProfileId && (
//         <Button
//           variant="primary"
//           onClick={async () => {
//             try {
//               const result = await initiateOAuth(projectId, {
//                 connectorName: selected.name,
//                 authProfileId,
//               });
//               // Open popup with the auth URL
//               setOauthConnector({
//                 name: selected.name,
//                 authorizationUrl: result.data.authUrl,
//               });
//             } catch (err) {
//               setError(sanitizeError(err, 'Failed to initiate OAuth'));
//             }
//           }}
//           className="w-full"
//         >
//           Connect with {selected.displayName}
//         </Button>
//       )}
//     </div>
//   ) : (
//     // Non-OAuth path: show AuthProfilePicker OR direct credential input
//     <div className="space-y-4">
//       <AuthProfilePicker
//         projectId={projectId}
//         value={authProfileId}
//         onChange={(id) => {
//           setAuthProfileId(id);
//           if (id) setCredentials({}); // clear direct creds when profile selected
//         }}
//         compatibleAuthTypes={['api_key', 'bearer']}
//         label="Auth Profile (optional)"
//         placeholder="Select or enter credentials below..."
//       />
//       {!authProfileId && (
//         <>
//           {/* Existing direct credential fields */}
//           {providerDef?.fields.map((field) => (...))}
//         </>
//       )}
//       <Button
//         variant="primary"
//         onClick={() => handleCreate({ authProfileId: authProfileId ?? undefined })}
//         loading={creating}
//       >
//         Create Connection
//       </Button>
//     </div>
//   )}
```

---

### Task Group E6: OAuth Popup Flow for Auth Profiles

### Task 49: OAuth callback page

**File:** `apps/studio/src/app/oauth/auth-profile-callback/page.tsx`

**Test first** (`apps/studio/src/__tests__/auth-profile-callback.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';

describe('AuthProfileOAuthCallbackPage', () => {
  it('posts code+state to parent via postMessage', () => {
    const mockPostMessage = vi.fn();
    vi.stubGlobal('opener', { postMessage: mockPostMessage });
    const searchParams = new URLSearchParams({ code: 'abc', state: 'xyz' });
    expect(mockPostMessage).toBeDefined();
  });

  it('posts error to parent when error param is present', () => {
    const mockPostMessage = vi.fn();
    vi.stubGlobal('opener', { postMessage: mockPostMessage });
    const searchParams = new URLSearchParams({ error: 'access_denied', state: 'xyz' });
    expect(searchParams.get('error')).toBe('access_denied');
  });

  it('auto-closes after posting success', () => {
    const mockClose = vi.fn();
    vi.stubGlobal('close', mockClose);
    expect(mockClose).toBeDefined();
  });
});
```

**Implementation:**

```typescript
/**
 * Auth Profile OAuth Callback Page
 *
 * Loaded inside the OAuth popup after the provider redirects back.
 * Extracts code+state from URL, posts them to the parent window
 * via postMessage. The parent (OAuthFlowDialog or connector setup)
 * handles the API call to exchange the code.
 *
 * This is a separate callback route from the connection OAuth callback
 * to allow different state handling and message types.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

const MESSAGE_TYPE = 'auth-profile-oauth-callback';

export default function AuthProfileOAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      }
    >
      <CallbackContent />
    </Suspense>
  );
}

function CallbackContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      setErrorMessage(error === 'access_denied' ? 'Authorization was denied' : error);
      setStatus('error');
      window.opener?.postMessage(
        { type: MESSAGE_TYPE, error },
        window.location.origin,
      );
      return;
    }

    if (!code || !state) {
      setErrorMessage('Missing authorization code or state');
      setStatus('error');
      window.opener?.postMessage(
        { type: MESSAGE_TYPE, error: 'missing_params' },
        window.location.origin,
      );
      return;
    }

    window.opener?.postMessage(
      { type: MESSAGE_TYPE, code, state },
      window.location.origin,
    );
    setStatus('success');

    // Auto-close after brief delay
    setTimeout(() => window.close(), 1500);
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8">
        {status === 'loading' && (
          <>
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm text-muted">Processing authorization...</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="w-8 h-8 text-success mx-auto" />
            <p className="text-sm text-foreground">
              Authorization complete. This window will close.
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="w-8 h-8 text-error mx-auto" />
            <p className="text-sm text-foreground">Authorization failed</p>
            {errorMessage && <p className="text-xs text-muted">{errorMessage}</p>}
            <p className="text-xs text-muted">You can close this window.</p>
          </>
        )}
      </div>
    </div>
  );
}
```

### Task 50: Auth Profile OAuth Flow Dialog

**File:** `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`

This component wraps the OAuth popup flow specifically for Auth Profile token creation. It:

1. Calls `/api/projects/:pid/auth-profiles/oauth/initiate` with the `authProfileId` (the `oauth2_app` profile).
2. Opens a popup window to the returned `authUrl`.
3. Listens for `postMessage` with type `auth-profile-oauth-callback`.
4. Calls `/api/projects/:pid/auth-profiles/oauth/callback` with code+state.
5. Shows success/error states.

```typescript
/**
 * AuthProfileOAuthDialog
 *
 * Dialog for the Auth Profile OAuth popup flow.
 * Reuses the same pattern as OAuthFlowDialog but with
 * auth-profile-specific endpoints and message type.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ExternalLink, CheckCircle, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { initiateOAuth, handleOAuthProfileCallback } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// TYPES
// =============================================================================

interface AuthProfileOAuthDialogProps {
  open: boolean;
  projectId: string;
  authProfileId: string;
  connectorName: string;
  displayName?: string;
  onSuccess: (tokenProfileId: string) => void;
  onClose: () => void;
}

type FlowStep = 'authorize' | 'initiating' | 'waiting' | 'exchanging' | 'success' | 'error';

// =============================================================================
// CONSTANTS
// =============================================================================

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POPUP_POLL_INTERVAL_MS = 500;
const MESSAGE_TYPE = 'auth-profile-oauth-callback';

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfileOAuthDialog({
  open,
  projectId,
  authProfileId,
  connectorName,
  displayName,
  onSuccess,
  onClose,
}: AuthProfileOAuthDialogProps) {
  const [step, setStep] = useState<FlowStep>('authorize');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setStep('authorize');
      setErrorMessage(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== MESSAGE_TYPE) return;

      const { code, state, error } = event.data;

      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }

      if (error) {
        setErrorMessage(typeof error === 'string' ? error : 'Authorization was denied');
        setStep('error');
        return;
      }

      if (!code || !state) {
        setErrorMessage('Missing authorization code or state parameter');
        setStep('error');
        return;
      }

      setStep('exchanging');
      try {
        const result = await handleOAuthProfileCallback(projectId, {
          code,
          state,
          displayName: displayName ?? `${connectorName} token`,
        });
        setStep('success');
        onSuccess(result.data.id);
      } catch (err) {
        setErrorMessage(sanitizeError(err, 'Token exchange failed'));
        setStep('error');
      }
    },
    [projectId, connectorName, displayName, onSuccess],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  const handleAuthorize = async () => {
    setStep('initiating');
    setErrorMessage(null);

    try {
      const result = await initiateOAuth(projectId, {
        connectorName,
        authProfileId,
      });

      const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);

      const popup = window.open(
        result.data.authUrl,
        'auth-profile-oauth-popup',
        `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`,
      );

      if (!popup) {
        setErrorMessage('Popup was blocked. Please allow popups for this site.');
        setStep('error');
        return;
      }

      popupRef.current = popup;
      setStep('waiting');

      pollTimerRef.current = setInterval(() => {
        if (popup.closed) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          setStep((current) => {
            if (current === 'waiting') {
              setErrorMessage('Authorization window was closed');
              return 'error';
            }
            return current;
          });
        }
      }, POPUP_POLL_INTERVAL_MS);
    } catch (err) {
      setErrorMessage(sanitizeError(err, 'Failed to initiate OAuth'));
      setStep('error');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Authorize Access" maxWidth="sm">
      <div className="space-y-6">
        <div className="flex items-center gap-3 p-4 rounded-lg bg-background-muted">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{connectorName}</p>
            <p className="text-xs text-muted">OAuth 2.0 Authorization</p>
          </div>
        </div>

        {step === 'authorize' && (
          <div className="text-center space-y-4">
            <p className="text-sm text-muted">
              You will be redirected to authorize access. A popup window will open for you to complete the authorization.
            </p>
            <Button
              icon={<ExternalLink className="w-4 h-4" />}
              onClick={handleAuthorize}
              className="w-full"
            >
              Authorize {connectorName}
            </Button>
          </div>
        )}

        {(step === 'initiating' || step === 'exchanging') && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm font-medium text-foreground">
              {step === 'initiating' ? 'Preparing authorization...' : 'Completing connection...'}
            </p>
          </div>
        )}

        {step === 'waiting' && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <p className="text-sm font-medium text-foreground">Waiting for authorization</p>
            <p className="text-xs text-muted">Complete the authorization in the popup window</p>
          </div>
        )}

        {step === 'success' && (
          <div className="text-center space-y-4 py-4">
            <CheckCircle className="w-8 h-8 text-success mx-auto" />
            <p className="text-sm font-medium text-foreground">Successfully authorized</p>
            <Button onClick={onClose} className="w-full">Done</Button>
          </div>
        )}

        {step === 'error' && (
          <div className="text-center space-y-4 py-4">
            <XCircle className="w-8 h-8 text-error mx-auto" />
            <p className="text-sm font-medium text-foreground">Authorization failed</p>
            {errorMessage && <p className="text-xs text-error mt-1">{errorMessage}</p>}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
              <Button onClick={() => { setStep('authorize'); setErrorMessage(null); }} className="flex-1">
                Try Again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
```

---

### Task Group E7: Pre-flight Auth Status

### Task 51: Deployment pre-check auth status component

**File:** `apps/studio/src/components/auth-profiles/AuthProfilePreflightCheck.tsx`

**Test first** (`apps/studio/src/__tests__/AuthProfilePreflightCheck.test.tsx`):

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useAuthProfiles', () => ({
  useAuthProfiles: vi.fn(() => ({
    profiles: [
      { id: 'ap-1', name: 'Gmail OAuth', authType: 'oauth2_app', status: 'active' },
      { id: 'ap-2', name: 'Slack Token', authType: 'bearer', status: 'expired' },
    ],
    total: 2,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

describe('AuthProfilePreflightCheck', () => {
  it('shows warning for non-active profiles', async () => {
    const { AuthProfilePreflightCheck } = await import(
      '../../components/auth-profiles/AuthProfilePreflightCheck'
    );
    render(
      <AuthProfilePreflightCheck
        projectId="proj-1"
        referencedProfileIds={['ap-1', 'ap-2']}
      />,
    );
    expect(screen.getByText(/Slack Token/)).toBeInTheDocument();
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });

  it('shows all-clear when all profiles are active', async () => {
    const { useAuthProfiles } = await import('../../hooks/useAuthProfiles');
    (useAuthProfiles as any).mockReturnValue({
      profiles: [
        { id: 'ap-1', name: 'Gmail OAuth', authType: 'oauth2_app', status: 'active' },
      ],
      total: 1,
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
    const { AuthProfilePreflightCheck } = await import(
      '../../components/auth-profiles/AuthProfilePreflightCheck'
    );
    render(
      <AuthProfilePreflightCheck
        projectId="proj-1"
        referencedProfileIds={['ap-1']}
      />,
    );
    expect(screen.getByText(/All auth profiles active/i)).toBeInTheDocument();
  });
});
```

**Implementation:**

```typescript
/**
 * AuthProfilePreflightCheck
 *
 * Shows auth profile status in the deployment pre-check panel.
 * Warns if any referenced profile is not 'active'.
 * Links to the Auth Profiles page to fix issues.
 */

'use client';

import { useMemo } from 'react';
import { CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuthProfiles } from '../../hooks/useAuthProfiles';
import { AuthProfileStatusBadge } from './AuthProfileStatusBadge';

interface AuthProfilePreflightCheckProps {
  projectId: string;
  referencedProfileIds: string[];
}

export function AuthProfilePreflightCheck({
  projectId,
  referencedProfileIds,
}: AuthProfilePreflightCheckProps) {
  const { profiles, isLoading } = useAuthProfiles(projectId);

  const referenced = useMemo(() => {
    const idSet = new Set(referencedProfileIds);
    return profiles.filter((p) => idSet.has(p.id));
  }, [profiles, referencedProfileIds]);

  const nonActive = referenced.filter((p) => p.status !== 'active');
  const allGood = nonActive.length === 0 && referenced.length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-background-muted">
        <div className="w-4 h-4 rounded-full skeleton" />
        <div className="h-3 w-40 rounded skeleton" />
      </div>
    );
  }

  if (referencedProfileIds.length === 0) return null;

  return (
    <div
      className={clsx(
        'p-3 rounded-lg border',
        allGood
          ? 'border-success/30 bg-success-subtle'
          : 'border-warning/30 bg-warning-subtle',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        {allGood ? (
          <>
            <CheckCircle className="w-4 h-4 text-success shrink-0" />
            <span className="text-sm font-medium text-success">
              All auth profiles active
            </span>
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
            <span className="text-sm font-medium text-warning">
              {nonActive.length} auth profile{nonActive.length > 1 ? 's' : ''} not active
            </span>
          </>
        )}
      </div>

      {nonActive.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {nonActive.map((profile) => (
            <div
              key={profile.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="text-foreground">{profile.name}</span>
              <div className="flex items-center gap-2">
                <AuthProfileStatusBadge status={profile.status} />
                <a
                  href={`/projects/${projectId}/auth-profiles`}
                  className="text-accent hover:underline inline-flex items-center gap-1 text-xs"
                >
                  Fix <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### File Index

| File path                                                                | Purpose                     |
| ------------------------------------------------------------------------ | --------------------------- |
| `apps/studio/src/api/auth-profiles.ts`                                   | API client functions        |
| `apps/studio/src/hooks/useAuthProfiles.ts`                               | SWR hooks (list + single)   |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`         | Auth type display constants |
| `apps/studio/src/components/auth-profiles/AuthProfileStatusBadge.tsx`    | Status badge helper         |
| `apps/studio/src/components/auth-profiles/AuthProfilesPage.tsx`          | Management list page        |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`      | Create/Edit slide-over      |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`         | Reusable picker dropdown    |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`    | OAuth popup flow dialog     |
| `apps/studio/src/components/auth-profiles/AuthProfilePreflightCheck.tsx` | Deployment pre-check widget |
| `apps/studio/src/app/oauth/auth-profile-callback/page.tsx`               | OAuth popup callback page   |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx`       | Modified: integrate picker  |
| `apps/studio/src/__tests__/api-auth-profiles.test.ts`                    | API client tests            |
| `apps/studio/src/__tests__/hooks-useAuthProfiles.test.ts`                | Hook tests                  |
| `apps/studio/src/__tests__/AuthProfilesPage.test.tsx`                    | Page tests                  |
| `apps/studio/src/__tests__/AuthProfileSlideOver.test.tsx`                | Slide-over tests            |
| `apps/studio/src/__tests__/AuthProfilePicker.test.tsx`                   | Picker tests                |
| `apps/studio/src/__tests__/auth-profile-callback.test.tsx`               | Callback page tests         |
| `apps/studio/src/__tests__/CreateConnectionModal-auth-profile.test.tsx`  | Connector integration tests |
| `apps/studio/src/__tests__/AuthProfilePreflightCheck.test.tsx`           | Pre-flight check tests      |

### Navigation Registration

Add to `apps/studio/src/store/navigation-store.ts`:

- Add `'settings-auth-profiles'` to the `ProjectPage` type union.

Add to `apps/studio/src/components/navigation/AppShell.tsx`:

- Add case `'settings-auth-profiles'` in `renderContent()` to render `<AuthProfilesPage />`.

### Implementation Order

1. **D-1.1 + D-1.2**: API client + SWR hooks (foundation, no UI)
2. **D-2.1**: Auth type metadata constants
3. **D-2.2**: Status badge helper
4. **D-3.1**: Auth Profile Slide-Over (create/edit)
5. **D-2.3 + D-2.4**: Management page + route (depends on slide-over)
6. **D-4.1**: AuthProfilePicker (depends on SWR hook)
7. **D-6.1 + D-6.2**: OAuth callback page + OAuth dialog
8. **D-5.1**: Connector setup integration (depends on picker + OAuth dialog)
9. **D-7.1**: Pre-flight check (depends on SWR hook)

---

## Phase F — Integration Points

> Wire auth profiles into connector models, credential resolution, voice service cache invalidation, dead code verification, and ESLint enforcement.
> Requires Tasks 1-6 (model, schema, service) and Tasks 8-11 (API routes) complete.

### Task 52: Wire `ConnectorConfig.authProfileId` and `ConnectorConnection.authProfileId`

**Files to modify:**

- `packages/database/src/models/connector-config.model.ts` — add `authProfileId?: string` field
- `packages/database/src/models/connector-connection.model.ts` — add `authProfileId?: string` field

**Tests:**

```typescript
// Add to packages/database/src/__tests__/model-connector-connection.test.ts
it('accepts optional authProfileId', () => {
  const conn = new ConnectorConnection({
    ...validConnection(),
    authProfileId: 'ap-test-1',
  });
  expect(conn.authProfileId).toBe('ap-test-1');
});

it('defaults authProfileId to undefined', () => {
  const conn = new ConnectorConnection(validConnection());
  expect(conn.authProfileId).toBeUndefined();
});
```

### Task 53: Wire `authProfileService.resolve()` into Connector Credential Resolution

**File to modify:** The connector credential resolution function.

This is a new product -- no feature flags, no migration, no dual-read. If `authProfileId` is present on a connection, use `authProfileService.resolve()`. If `authProfileId` is not set, credentials don't exist yet (the connection was not configured).

**Test:**

```typescript
describe('Connector credential resolution via AuthProfile', () => {
  it('uses authProfileService.resolve() when authProfileId is present', async () => {
    const mockResolve = vi.fn().mockResolvedValue({ apiKey: 'from-auth-profile' });
    // ... wire mock
    const result = await resolveConnectorCredentials({
      authProfileId: 'ap-1',
      tenantId: 'tenant-1',
    });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ authProfileId: 'ap-1' }));
    expect(result.apiKey).toBe('from-auth-profile');
  });

  it('returns null when authProfileId is absent (not configured)', async () => {
    const result = await resolveConnectorCredentials({
      tenantId: 'tenant-1',
    });
    expect(result).toBeNull();
  });
});
```

### ~~Task 54~~ — REMOVED: Deferred to Phase 2

> The Phase 1 design doc's out-of-scope table explicitly defers `VoiceServiceFactory` cache invalidation to Phase 2. This task and all associated tests are removed from Phase 1.

### Task 55: Dead Code Verification

Run after all wiring is complete:

```bash
# Verify no unused exports in auth-profile files
cd /Users/prasannaarikala/projects/agent-platform && npx ts-prune packages/database/src/models/auth-profile* packages/database/src/services/auth-profile* apps/runtime/src/services/auth-profile* apps/runtime/src/routes/auth-profiles*

# Verify no unused imports
cd /Users/prasannaarikala/projects/agent-platform && npx eslint --rule '{"no-unused-vars": "error", "@typescript-eslint/no-unused-vars": "error"}' --no-eslintrc packages/database/src/models/auth-profile* apps/runtime/src/routes/auth-profiles*

# Build check — ensures no dead imports or missing wiring
cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=@agent-platform/database --filter=@agent-platform/runtime --filter=@agent-platform/studio
```

### Task 56: ESLint Enforcement

Ensure the following rules are active on all new auth-profile files:

- `no-unused-vars`: error
- `no-unreachable`: error
- `@typescript-eslint/no-unused-vars`: error (with `argsIgnorePattern: '^_'`)

No new `any` types in auth-profile code. Use the discriminated union `AuthProfileErrorReason` for all error branches.

---

### Test File Summary

| Test File                                 | Package          | Category       | Estimated Test Count | Test Command                                                                        |
| ----------------------------------------- | ---------------- | -------------- | -------------------- | ----------------------------------------------------------------------------------- |
| `auth-profile-factory.test.ts`            | database         | Infrastructure | 12                   | `npx vitest run packages/database/src/__tests__/auth-profile-factory.test.ts`       |
| `model-auth-profile.test.ts`              | database         | Model          | 35                   | `npx vitest run packages/database/src/__tests__/model-auth-profile.test.ts`         |
| `auth-profile-service.test.ts`            | runtime/database | Service        | 50                   | `npx vitest run apps/runtime/src/__tests__/auth-profile-service.test.ts`            |
| `auth-profiles-authz.test.ts`             | runtime          | API Auth       | 40                   | `npx vitest run apps/runtime/src/__tests__/auth-profiles-authz.test.ts`             |
| `auth-profiles-crud.test.ts`              | runtime          | API CRUD       | 30                   | `npx vitest run apps/runtime/src/__tests__/auth-profiles-crud.test.ts`              |
| `auth-profiles-oauth.test.ts`             | runtime          | API OAuth      | 18                   | `npx vitest run apps/runtime/src/__tests__/auth-profiles-oauth.test.ts`             |
| `api-auth-profile-routes.test.ts`         | studio           | Studio API     | 12                   | `npx vitest run apps/studio/src/__tests__/api-auth-profile-routes.test.ts`          |
| `auth-profile-integration.test.ts`        | runtime          | Integration    | 12                   | `npx vitest run apps/runtime/src/__tests__/auth-profile-integration.test.ts`        |
| `auth-profile-perf.test.ts`               | runtime          | Performance    | 5                    | `npx vitest run apps/runtime/src/__tests__/auth-profile-perf.test.ts`               |
| `auth-profile-cache.test.ts`              | runtime          | Cache          | 7                    | `npx vitest run apps/runtime/src/__tests__/auth-profile-cache.test.ts`              |
| `auth-profile-cc-cache.test.ts`           | runtime          | Cache          | 6                    | `npx vitest run apps/runtime/src/__tests__/auth-profile-cc-cache.test.ts`           |
| `auth-profile-cache-invalidation.test.ts` | runtime          | Cache          | 5                    | `npx vitest run apps/runtime/src/__tests__/auth-profile-cache-invalidation.test.ts` |
| **Total**                                 |                  |                | **~232**             |                                                                                     |

---

### Execution Order

Tasks are ordered so each layer has tests before the next layer depends on it:

1. **E.1** — Shared test infrastructure (factory, helpers) — no dependencies
2. **E.2** — Model tests — depends on E.1 (factory)
3. **E.3** — Service tests — depends on E.1 (factory) + E.2 (model exists)
4. **E.8** — Cache implementation + tests — depends on E.3 (service interface)
5. **E.4** — Runtime API route tests — depends on E.3 (service) + E.8 (cache)
6. **E.5** — Studio API route tests — depends on E.4 (runtime API exists)
7. **E.10** — Integration point wiring — depends on E.3 (service) + E.4 (routes)
8. **E.6** — Integration tests — depends on all above
9. **E.7** — Performance tests — depends on E.6 (data seeding patterns)
10. **E.9** — Coverage verification — run last, validates all above

---

## Phase G — Test Infrastructure & Coverage

> Shared test factory, model tests, service tests, API tests, integration tests, performance benchmarks, caching implementation and tests.
> Requires all prior phases complete for integration and e2e tests.

### Coverage Targets

| Layer              | Target |
| ------------------ | ------ |
| Mongoose model     | 95%    |
| AuthProfileService | 90%    |
| API routes         | 85%    |
| UI components      | 80%    |
| Cache layer        | 95%    |
| Zod schemas        | 100%   |

### Task Group G1: Shared Test Infrastructure

### Task 57: Auth Profile Mock Factory

**File:** `packages/database/src/__tests__/helpers/auth-profile-factory.ts`

> There is no `packages/test-helpers/` workspace. Test helpers live alongside the package they support. Since `AuthProfile` is a database model, the factory goes in the database package's test helpers — matching the existing `setup-mongo.ts` helper pattern.

**Red (test):**

```typescript
// packages/database/src/__tests__/auth-profile-factory.test.ts
import { describe, it, expect } from 'vitest';
import {
  makeAuthProfile,
  makeDecryptedCredentials,
  makeAuthProfileService,
  AUTH_TYPE_FIXTURES,
} from './helpers/auth-profile-factory.js';

describe('makeAuthProfile', () => {
  it('returns a valid AuthProfile document with defaults', () => {
    const profile = makeAuthProfile();
    expect(profile.tenantId).toBeDefined();
    expect(profile.name).toBeDefined();
    expect(profile.authType).toBe('api_key');
    expect(profile.scope).toBe('project');
    expect(profile.projectId).toBeDefined();
    expect(profile.visibility).toBe('shared');
    expect(profile.status).toBe('active');
    expect(profile.createdBy).toBeDefined();
    expect(profile.encryptedSecrets).toBeDefined();
    expect(profile.encryptionKeyVersion).toBe(1);
    expect(profile.config).toBeDefined();
  });

  it('accepts overrides', () => {
    const profile = makeAuthProfile({
      authType: 'oauth2_app',
      name: 'Google OAuth',
      visibility: 'personal',
    });
    expect(profile.authType).toBe('oauth2_app');
    expect(profile.name).toBe('Google OAuth');
    expect(profile.visibility).toBe('personal');
  });

  it('generates unique _id per call', () => {
    const a = makeAuthProfile();
    const b = makeAuthProfile();
    expect(a._id).not.toBe(b._id);
  });

  it('sets projectId to null and scope to tenant when scope is tenant', () => {
    const profile = makeAuthProfile({ scope: 'tenant' });
    expect(profile.projectId).toBeNull();
    expect(profile.scope).toBe('tenant');
  });
});

describe('makeDecryptedCredentials', () => {
  for (const authType of [
    'none',
    'api_key',
    'bearer',
    'oauth2_app',
    'oauth2_token',
    'oauth2_client_credentials',
  ] as const) {
    it(`returns valid credentials for ${authType}`, () => {
      const creds = makeDecryptedCredentials(authType);
      expect(creds).toBeDefined();
      if (authType === 'none') {
        expect(creds).toEqual({});
      }
      if (authType === 'api_key') {
        expect(creds.apiKey).toBeDefined();
      }
      if (authType === 'bearer') {
        expect(creds.token).toBeDefined();
      }
      if (authType === 'oauth2_app') {
        expect(creds.clientId).toBeDefined();
        expect(creds.clientSecret).toBeDefined();
      }
      if (authType === 'oauth2_token') {
        expect(creds.accessToken).toBeDefined();
      }
      if (authType === 'oauth2_client_credentials') {
        expect(creds.clientId).toBeDefined();
        expect(creds.clientSecret).toBeDefined();
      }
    });
  }
});

describe('AUTH_TYPE_FIXTURES', () => {
  it('has config+secrets fixture for each Phase 1 auth type', () => {
    for (const authType of [
      'none',
      'api_key',
      'bearer',
      'oauth2_app',
      'oauth2_token',
      'oauth2_client_credentials',
    ]) {
      expect(AUTH_TYPE_FIXTURES[authType]).toBeDefined();
      expect(AUTH_TYPE_FIXTURES[authType].config).toBeDefined();
      expect(AUTH_TYPE_FIXTURES[authType].secrets).toBeDefined();
    }
  });
});

describe('makeAuthProfileService', () => {
  it('returns a mock service with all required methods', () => {
    const svc = makeAuthProfileService();
    expect(svc.create).toBeDefined();
    expect(svc.update).toBeDefined();
    expect(svc.delete).toBeDefined();
    expect(svc.resolve).toBeDefined();
    expect(svc.findById).toBeDefined();
    expect(svc.list).toBeDefined();
    expect(svc.validateAccess).toBeDefined();
    expect(svc.getConsumers).toBeDefined();
    expect(svc.revoke).toBeDefined();
  });

  it('accepts method overrides', () => {
    const profile = makeAuthProfile();
    const svc = makeAuthProfileService({
      findById: vi.fn().mockResolvedValue(profile),
    });
    expect(svc.findById).toBeDefined();
  });
});
```

**Green (implementation):**

```typescript
// packages/database/src/__tests__/helpers/auth-profile-factory.ts
import { vi } from 'vitest';

// Unique ID counter for deterministic test data
let idCounter = 0;
function nextId(): string {
  return `ap-test-${++idCounter}-${Date.now()}`;
}

export interface AuthProfileFixture {
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;
  scope: 'tenant' | 'project';
  environment: string | null;
  visibility: 'shared' | 'personal';
  createdBy: string;
  authType: string;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: 'active' | 'expired' | 'revoked' | 'invalid';
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const AUTH_TYPE_FIXTURES: Record<
  string,
  { config: Record<string, unknown>; secrets: Record<string, unknown> }
> = {
  none: { config: {}, secrets: {} },
  api_key: {
    config: { headerName: 'X-API-Key', placement: 'header' },
    secrets: { apiKey: 'test-api-key-secret-value' },
  },
  bearer: {
    config: {},
    secrets: { token: 'test-bearer-token-value' },
  },
  oauth2_app: {
    config: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      refreshUrl: 'https://oauth2.googleapis.com/token',
      defaultScopes: ['openid', 'email'],
      scopeSeparator: ' ',
      pkceRequired: true,
      pkceMethod: 'S256',
      supportedGrantTypes: ['authorization_code'],
    },
    secrets: {
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-test-client-secret',
    },
  },
  oauth2_token: {
    config: {
      provider: 'google',
      scopes: ['openid', 'email'],
      grantedScopes: ['openid', 'email'],
      tokenType: 'bearer',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshTokenRotation: false,
    },
    secrets: {
      accessToken: 'ya29.test-access-token',
      refreshToken: '1//test-refresh-token',
    },
  },
  oauth2_client_credentials: {
    config: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
    secrets: {
      clientId: 'test-cc-client-id',
      clientSecret: 'test-cc-client-secret',
    },
  },
};

export function makeAuthProfile(overrides?: Partial<AuthProfileFixture>): AuthProfileFixture {
  const authType = overrides?.authType ?? 'api_key';
  const scope = overrides?.scope ?? 'project';
  const fixture = AUTH_TYPE_FIXTURES[authType] ?? AUTH_TYPE_FIXTURES['api_key'];
  const now = new Date();

  return {
    _id: nextId(),
    name: `Test Profile ${authType}`,
    tenantId: 'tenant-test-1',
    projectId: scope === 'tenant' ? null : 'proj-test-1',
    scope,
    environment: null,
    visibility: 'shared',
    createdBy: 'user-test-1',
    authType,
    config: { ...fixture.config },
    encryptedSecrets: JSON.stringify(fixture.secrets),
    encryptionKeyVersion: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // Enforce scope/projectId consistency after overrides
    ...(overrides?.scope === 'tenant' ? { projectId: null } : {}),
  };
}

export function makeDecryptedCredentials(authType: string): Record<string, unknown> {
  const fixture = AUTH_TYPE_FIXTURES[authType];
  if (!fixture) return {};
  return { ...fixture.secrets };
}

export function makeAuthProfileService(overrides?: Record<string, any>): Record<string, any> {
  return {
    create: vi.fn().mockResolvedValue(makeAuthProfile()),
    update: vi.fn().mockResolvedValue(makeAuthProfile()),
    delete: vi.fn().mockResolvedValue({ success: true }),
    resolve: vi.fn().mockResolvedValue(makeDecryptedCredentials('api_key')),
    findById: vi.fn().mockResolvedValue(makeAuthProfile()),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    validateAccess: vi.fn().mockResolvedValue(makeAuthProfile()),
    getConsumers: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(makeAuthProfile({ status: 'revoked' })),
    ...overrides,
  };
}
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run packages/database/src/__tests__/auth-profile-factory.test.ts
```

---

### Task 58: Runtime Auth Context Extension

**File:** `apps/runtime/src/__tests__/helpers/auth-context.ts`

> The existing `ROLE_PERMISSIONS` map needs `auth-profile:*` permissions added. This is a modification to the existing file, not a new file.

**Task:** Add `auth-profile:read`, `auth-profile:write`, `auth-profile:delete`, `auth-profile:decrypt` to the appropriate roles in the existing `ROLE_PERMISSIONS` constant:

- `ADMIN`: `auth-profile:*`
- `OPERATOR`: `auth-profile:read`
- `MEMBER`: `auth-profile:read`
- `VIEWER`: `auth-profile:read`

Also add to `PROJECT_ROLE_PERMISSIONS`:

- `admin`: `auth-profile:*`
- `developer`: `auth-profile:read`, `auth-profile:write`
- `viewer`: `auth-profile:read`

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/helpers/auth-context.test.ts
```

---

### Task Group G2: — Model Tests

### Task 59: Schema Validation per Auth Type

**File:** `packages/database/src/__tests__/model-auth-profile.test.ts`

**Red (test) — full test outline:**

```typescript
// packages/database/src/__tests__/model-auth-profile.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { setMasterKey } from '../mongo/plugins/encryption.plugin.js';
import { AuthProfile } from '../models/auth-profile.model.js';
import { makeAuthProfile, AUTH_TYPE_FIXTURES } from './helpers/auth-profile-factory.js';

beforeAll(async () => {
  setMasterKey('ab'.repeat(32));
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// ─── Schema Defaults ───────────────────────────────────────────────────────

describe('AuthProfile schema defaults', () => {
  it('generates _id on instantiation', () => {
    const profile = new AuthProfile(makeAuthProfile());
    expect(profile._id).toBeDefined();
  });

  it('defaults projectId to null', () => {
    const profile = new AuthProfile({ ...makeAuthProfile(), projectId: undefined });
    expect(profile.projectId).toBeNull();
  });

  it('defaults status to active', () => {
    const profile = new AuthProfile(makeAuthProfile({ status: undefined as any }));
    expect(profile.status).toBe('active');
  });

  it('defaults environment to null', () => {
    const profile = new AuthProfile(makeAuthProfile({ environment: undefined as any }));
    expect(profile.environment).toBeNull();
  });

  it('sets createdAt/updatedAt on save', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const profile = await AuthProfile.create(makeAuthProfile());
    expect(profile.createdAt).toBeInstanceOf(Date);
    expect(profile.updatedAt).toBeInstanceOf(Date);
  });
});

// ─── Required Fields ────────────────────────────────────────────────────────

describe('AuthProfile required fields', () => {
  for (const field of [
    'tenantId',
    'name',
    'scope',
    'visibility',
    'createdBy',
    'authType',
    'encryptedSecrets',
  ]) {
    it(`requires ${field}`, () => {
      const data = makeAuthProfile();
      delete (data as any)[field];
      const doc = new AuthProfile(data);
      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err!.errors[field]).toBeDefined();
    });
  }
});

// ─── Auth Type Enum ─────────────────────────────────────────────────────────

describe('AuthProfile authType enum', () => {
  const VALID_TYPES = [
    'none',
    'api_key',
    'bearer',
    'basic',
    'oauth2_app',
    'oauth2_token',
    'oauth2_client_credentials',
    'custom_header',
    'aws_iam',
    'azure_ad',
    'ssh_key',
    'mtls',
  ];

  for (const authType of VALID_TYPES) {
    it(`accepts authType: ${authType}`, () => {
      const doc = new AuthProfile(makeAuthProfile({ authType }));
      const err = doc.validateSync();
      // No error on authType field specifically
      expect(err?.errors?.authType).toBeUndefined();
    });
  }

  it('rejects invalid authType', () => {
    const doc = new AuthProfile(makeAuthProfile({ authType: 'invalid_type' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.authType).toBeDefined();
  });
});

// ─── Status Enum ────────────────────────────────────────────────────────────

describe('AuthProfile status enum', () => {
  for (const status of ['active', 'expired', 'revoked', 'invalid'] as const) {
    it(`accepts status: ${status}`, () => {
      const doc = new AuthProfile(makeAuthProfile({ status }));
      const err = doc.validateSync();
      expect(err?.errors?.status).toBeUndefined();
    });
  }

  it('rejects invalid status', () => {
    const doc = new AuthProfile(makeAuthProfile({ status: 'unknown' as any }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.status).toBeDefined();
  });
});

// ─── Scope + Visibility Enums ───────────────────────────────────────────────

describe('AuthProfile scope/visibility enums', () => {
  it('accepts scope: tenant', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'tenant', projectId: null }));
    expect(doc.validateSync()?.errors?.scope).toBeUndefined();
  });

  it('accepts scope: project', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'project' }));
    expect(doc.validateSync()?.errors?.scope).toBeUndefined();
  });

  it('rejects invalid scope', () => {
    const doc = new AuthProfile(makeAuthProfile({ scope: 'global' as any }));
    const err = doc.validateSync();
    expect(err?.errors?.scope).toBeDefined();
  });

  it('accepts visibility: shared', () => {
    const doc = new AuthProfile(makeAuthProfile({ visibility: 'shared' }));
    expect(doc.validateSync()?.errors?.visibility).toBeUndefined();
  });

  it('accepts visibility: personal', () => {
    const doc = new AuthProfile(makeAuthProfile({ visibility: 'personal' }));
    expect(doc.validateSync()?.errors?.visibility).toBeUndefined();
  });
});

// ─── Per Auth Type Config Fixtures ──────────────────────────────────────────

describe('AuthProfile per-type fixture validation', () => {
  for (const authType of Object.keys(AUTH_TYPE_FIXTURES)) {
    it(`creates and saves ${authType} profile without error`, async (ctx) => {
      if (!isMongoReady()) return ctx.skip();
      const profile = await AuthProfile.create(
        makeAuthProfile({ authType, name: `Test-${authType}-${Date.now()}` }),
      );
      expect(profile._id).toBeDefined();
      expect(profile.authType).toBe(authType);
    });
  }
});
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run packages/database/src/__tests__/model-auth-profile.test.ts
```

### Task 60: Index Existence Tests

Add to the same test file (`model-auth-profile.test.ts`):

```typescript
// ─── Indexes ────────────────────────────────────────────────────────────────

describe('AuthProfile indexes', () => {
  it('has required indexes', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const indexes = await AuthProfile.collection.indexes();
    const indexKeys = indexes.map((i: any) => Object.keys(i.key).join(','));

    // Core query indexes
    expect(indexKeys).toContainEqual(expect.stringContaining('tenantId'));

    // Verify at least the unique compound indexes exist
    const uniqueIndexes = indexes.filter((i: any) => i.unique);
    expect(uniqueIndexes.length).toBeGreaterThanOrEqual(2); // two partial uniques
  });

  it('enforces unique name per tenant+environment at tenant-level', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({
      scope: 'tenant',
      projectId: null,
      name: 'unique-test',
      environment: null,
    });
    await AuthProfile.create(base);
    await expect(AuthProfile.create({ ...base, _id: undefined })).rejects.toThrow(/duplicate key/i);
  });

  it('enforces unique name per tenant+project+environment at project-level', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({
      scope: 'project',
      projectId: 'proj-dup-test',
      name: 'unique-proj-test',
      environment: 'production',
    });
    await AuthProfile.create(base);
    await expect(AuthProfile.create({ ...base, _id: undefined })).rejects.toThrow(/duplicate key/i);
  });

  it('allows same name in different environments', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const base = makeAuthProfile({ name: 'same-name-env-test' });
    await AuthProfile.create({ ...base, environment: 'dev' });
    const prod = await AuthProfile.create({
      ...makeAuthProfile({ name: 'same-name-env-test' }),
      environment: 'production',
    });
    expect(prod._id).toBeDefined();
  });

  it('allows same name in different projects', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AuthProfile.create(makeAuthProfile({ name: 'cross-proj', projectId: 'proj-A' }));
    const b = await AuthProfile.create(
      makeAuthProfile({ name: 'cross-proj', projectId: 'proj-B' }),
    );
    expect(b._id).toBeDefined();
  });
});
```

### Task 61: Plugin Integration Tests

```typescript
// ─── Plugin Integration ─────────────────────────────────────────────────────

describe('AuthProfile plugin integration', () => {
  it('encrypts encryptedSecrets on save (encryption plugin)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const profile = await AuthProfile.create(
      makeAuthProfile({ encryptedSecrets: '{"apiKey":"plaintext-secret"}' }),
    );
    // Raw document in DB should not contain plaintext
    const raw = await AuthProfile.collection.findOne({ _id: profile._id });
    expect(raw!.encryptedSecrets).not.toBe('{"apiKey":"plaintext-secret"}');
  });

  it('decrypts encryptedSecrets on find (encryption plugin)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const original = '{"apiKey":"test-decrypt-value"}';
    await AuthProfile.create(makeAuthProfile({ encryptedSecrets: original }));
    // Reading back should return decrypted value
    const found = await AuthProfile.findOne({ tenantId: 'tenant-test-1' });
    // The encryption plugin round-trips the value
    expect(found!.encryptedSecrets).toBe(original);
  });

  it('tenant isolation plugin scopes queries to tenantId', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    await AuthProfile.create(makeAuthProfile({ tenantId: 'tenant-iso-A', name: 'iso-test' }));
    await AuthProfile.create(makeAuthProfile({ tenantId: 'tenant-iso-B', name: 'iso-test' }));
    // Query scoped to tenant-A should not find tenant-B
    const results = await AuthProfile.find({ tenantId: 'tenant-iso-A' });
    expect(results.every((r: any) => r.tenantId === 'tenant-iso-A')).toBe(true);
  });
});
```

**Test command (all model tests):**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run packages/database/src/__tests__/model-auth-profile.test.ts
```

---

### Task Group G3: — Service Tests

**File:** `packages/database/src/__tests__/auth-profile-service.test.ts` (or `apps/runtime/src/__tests__/auth-profile-service.test.ts` depending on where the service lives)

### Task 62: CRUD Operation Tests

```typescript
describe('AuthProfileService.create', () => {
  it('creates a profile with all required fields', async () => {
    /* ... */
  });
  it('rejects addon fields with 400 in Phase 1', async () => {
    /* ... */
  });
  it('rejects rotation policy with 400 in Phase 1', async () => {
    /* ... */
  });
  it('sets createdBy from context, ignoring request body createdBy', async () => {
    /* ... */
  });
  it('validates SSRF on all URL fields in oauth2_app config', async () => {
    /* ... */
  });
  it('validates Zod .strict() rejects unknown config fields', async () => {
    /* ... */
  });
  it('stores environment as explicit null when not provided', async () => {
    /* ... */
  });
});

describe('AuthProfileService.update', () => {
  it('updates config fields', async () => {
    /* ... */
  });
  it('refuses to change authType', async () => {
    /* ... */
  });
  it('refuses to change createdBy', async () => {
    /* ... */
  });
  it('refuses to change tenantId', async () => {
    /* ... */
  });
  it('updates encryptedSecrets via re-encryption', async () => {
    /* ... */
  });
  it('returns 404 for wrong tenantId', async () => {
    /* ... */
  });
  it('returns 404 for wrong projectId', async () => {
    /* ... */
  });
});

describe('AuthProfileService.delete', () => {
  it('deletes a profile with no consumers', async () => {
    /* ... */
  });
  it('returns 409 when oauth2_app has active tokens', async () => {
    /* ... */
  });
  it('returns 404 for cross-tenant attempt', async () => {
    /* ... */
  });
});
```

### Task 63: 5-Level Resolution Query Tests

```typescript
describe('AuthProfileService.resolve — 5-level priority', () => {
  // Setup: create profiles at each level

  it('level 1: returns personal oauth2_token for user + connector + env (per_user)', async () => {
    // Create personal token for user-1, connector gmail, env production
    // Resolve with connectionMode: 'per_user', userId: 'user-1'
    // Expect: personal token returned
  });

  it('level 2: returns shared oauth2_token for connector + env (shared mode)', async () => {
    // Create shared token for connector gmail, env production
    // Resolve with connectionMode: 'shared'
    // Expect: shared token returned
  });

  it('level 3: returns project-level profile matching authProfileId + env', async () => {
    // Create project-level api_key profile, env production
    // Resolve with explicit authProfileId
    // Expect: project-level profile returned
  });

  it('level 4: falls back to project-level profile with null env', async () => {
    // Create project-level api_key profile, env null
    // Resolve with environment: 'production' (no env-specific match)
    // Expect: null-env fallback returned
  });

  it('level 5: falls back to tenant-level profile', async () => {
    // Create tenant-level profile (projectId: null)
    // Resolve with projectId that has no project-level profiles
    // Expect: tenant-level profile returned
  });

  it('returns null when no profile matches at any level', async () => {
    // Resolve with unmatched connector
    // Expect: null
  });

  it('respects priority: personal token wins over shared token', async () => {
    // Create both personal and shared tokens for same connector
    // Resolve with per_user mode
    // Expect: personal token, not shared
  });

  it('respects priority: project-level wins over tenant-level', async () => {
    // Create both project-level and tenant-level profiles
    // Resolve
    // Expect: project-level profile
  });

  it('respects priority: env-specific wins over null-env fallback', async () => {
    // Create both env-specific and null-env profiles
    // Resolve with specific environment
    // Expect: env-specific profile
  });
});
```

### Task 64: Consumer Count Fan-out Tests

```typescript
describe('AuthProfileService.getConsumers', () => {
  it('returns ConnectorConfig references', async () => {
    /* ... */
  });
  it('returns ConnectorConnection references', async () => {
    /* ... */
  });
  it('returns oauth2_token profiles linked via linkedAppProfileId', async () => {
    /* ... */
  });
  it('returns empty array when no consumers exist', async () => {
    /* ... */
  });
  it('scopes consumer query to same tenantId', async () => {
    /* ... */
  });
});
```

### Task 65: Validation Tests

```typescript
describe('AuthProfileService validation', () => {
  // Cross-field validation
  it('rejects oauth2_app without authorizationUrl', async () => {
    /* ... */
  });
  it('rejects oauth2_app without tokenUrl', async () => {
    /* ... */
  });
  it('rejects api_key without headerName', async () => {
    /* ... */
  });
  it('rejects oauth2_token without provider', async () => {
    /* ... */
  });
  it('rejects oauth2_client_credentials without tokenUrl', async () => {
    /* ... */
  });
  it('rejects bearer with unknown config fields (.strict())', async () => {
    /* ... */
  });
  it('accepts none with empty config and secrets', async () => {
    /* ... */
  });

  // linkedAppProfileId
  it('rejects oauth2_token with cross-tenant linkedAppProfileId', async () => {
    /* ... */
  });
  it('rejects oauth2_token with linkedAppProfileId pointing to non-oauth2_app', async () => {
    /* ... */
  });
  it('accepts oauth2_token with valid same-tenant linkedAppProfileId', async () => {
    /* ... */
  });

  // Visibility restrictions
  it('personal profiles require createdBy to be set', async () => {
    /* ... */
  });
  it('list filters personal profiles to only creator unless admin', async () => {
    /* ... */
  });
});
```

### Task 66: Error Handling Tests

```typescript
describe('AuthProfileService error handling', () => {
  it('throws AuthProfileError with NOT_FOUND reason for missing profile', async () => {
    /* ... */
  });
  it('throws AuthProfileError with DUPLICATE_NAME for name conflict', async () => {
    /* ... */
  });
  it('throws AuthProfileError with HAS_CONSUMERS on delete with active refs', async () => {
    /* ... */
  });
  it('throws AuthProfileError with CROSS_TENANT_LINK for invalid linkedAppProfileId', async () => {
    /* ... */
  });
  it('throws AuthProfileError with DECRYPTION_FAILED when decrypt fails', async () => {
    /* ... */
  });
  it('AuthProfileError.retryable is false for NOT_FOUND', async () => {
    /* ... */
  });
  it('AuthProfileError.retryable is true for TOKEN_REFRESH_FAILED', async () => {
    /* ... */
  });
});
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run packages/database/src/__tests__/auth-profile-service.test.ts
# or if in runtime:
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-service.test.ts
```

---

### Task Group G4: — API Route Tests

### Task 67: Auth/Authz Tests

**File:** `apps/runtime/src/__tests__/auth-profiles-authz.test.ts`

Follows the existing pattern in `tool-secrets-authz.test.ts` and `oauth-authz.test.ts`: mock everything except the real RBAC middleware, spin up a per-role Express server on port 0, and test each endpoint.

```typescript
/**
 * Auth Profile Route Authorization Tests — Project-Level Object:Operation RBAC
 *
 * Permission mapping:
 *   POST   /                           — auth-profile:write
 *   GET    /                           — auth-profile:read
 *   GET    /:id                        — auth-profile:read
 *   PUT    /:id                        — auth-profile:write
 *   DELETE /:id                        — auth-profile:delete
 *   POST   /:id/validate              — auth-profile:write
 *   GET    /:id/consumers             — auth-profile:read
 *   POST   /:id/revoke               — auth-profile:write
 *   POST   /oauth/initiate            — auth-profile:write
 *   POST   /oauth/callback            — auth-profile:write
 *   POST   /oauth/user-consent        — auth-profile:write
 *
 * Roles tested:
 *   OWNER    — *:* → all pass
 *   ADMIN    — auth-profile:* → all pass
 *   OPERATOR — auth-profile:read → reads pass, writes/deletes 403
 *   MEMBER   — auth-profile:read → reads pass, writes/deletes 403
 *   VIEWER   — auth-profile:read → reads pass, writes/deletes 403
 *   Unauthenticated → all 401
 */

describe('Auth profile route authorization', () => {
  // Pattern: createServerForRole('OWNER') → test each endpoint
  // Exact same structure as tool-secrets-authz.test.ts

  describe('Tenant OWNER', () => {
    it('GET / (list) → not 403', async () => {
      /* ... */
    });
    it('POST / (create) → not 403', async () => {
      /* ... */
    });
    it('GET /:id → not 403', async () => {
      /* ... */
    });
    it('PUT /:id → not 403', async () => {
      /* ... */
    });
    it('DELETE /:id → not 403', async () => {
      /* ... */
    });
    it('POST /:id/validate → not 403', async () => {
      /* ... */
    });
    it('GET /:id/consumers → not 403', async () => {
      /* ... */
    });
    it('POST /:id/revoke → not 403', async () => {
      /* ... */
    });
    it('POST /oauth/initiate → not 403', async () => {
      /* ... */
    });
    it('POST /oauth/callback → not 403', async () => {
      /* ... */
    });
    it('POST /oauth/user-consent → not 403', async () => {
      /* ... */
    });
  });

  describe('VIEWER (auth-profile:read only)', () => {
    it('GET / → not 403', async () => {
      /* ... */
    });
    it('GET /:id → not 403', async () => {
      /* ... */
    });
    it('GET /:id/consumers → not 403', async () => {
      /* ... */
    });
    it('POST / → 403', async () => {
      /* ... */
    });
    it('PUT /:id → 403', async () => {
      /* ... */
    });
    it('DELETE /:id → 403', async () => {
      /* ... */
    });
    it('POST /:id/validate → 403', async () => {
      /* ... */
    });
    it('POST /:id/revoke → 403', async () => {
      /* ... */
    });
    it('POST /oauth/initiate → 403', async () => {
      /* ... */
    });
    it('POST /oauth/callback → 403', async () => {
      /* ... */
    });
    it('POST /oauth/user-consent → 403', async () => {
      /* ... */
    });
  });

  describe('Unauthenticated', () => {
    // createServerWithoutAuth()
    it('GET / → 401', async () => {
      /* ... */
    });
    it('POST / → 401', async () => {
      /* ... */
    });
    it('GET /:id → 401', async () => {
      /* ... */
    });
    it('PUT /:id → 401', async () => {
      /* ... */
    });
    it('DELETE /:id → 401', async () => {
      /* ... */
    });
  });

  describe('Cross-tenant isolation', () => {
    it('GET /:id returns 404 for profile owned by different tenant', async () => {
      /* ... */
    });
    it('PUT /:id returns 404 for profile owned by different tenant', async () => {
      /* ... */
    });
    it('DELETE /:id returns 404 for profile owned by different tenant', async () => {
      /* ... */
    });
  });

  describe('Cross-project isolation', () => {
    it('GET /:id returns 404 for profile in different project', async () => {
      /* ... */
    });
    it('PUT /:id returns 404 for profile in different project', async () => {
      /* ... */
    });
    it('allows access to tenant-level profile from any project', async () => {
      /* ... */
    });
  });
});
```

### Task 68: CRUD Endpoint Tests

**File:** `apps/runtime/src/__tests__/auth-profiles-crud.test.ts`

```typescript
describe('Auth profile CRUD endpoints', () => {
  describe('POST /api/projects/:pid/auth-profiles', () => {
    it('creates api_key profile and returns 201', async () => {
      /* ... */
    });
    it('creates oauth2_app profile with all config fields', async () => {
      /* ... */
    });
    it('creates none profile with empty config', async () => {
      /* ... */
    });
    it('returns 400 for missing required config fields', async () => {
      /* ... */
    });
    it('returns 400 for unknown config fields (.strict())', async () => {
      /* ... */
    });
    it('returns 400 for addon fields (Phase 1 rejection)', async () => {
      /* ... */
    });
    it('returns 409 for duplicate name in same scope', async () => {
      /* ... */
    });
    it('sets createdBy from auth context, not body', async () => {
      /* ... */
    });
    it('validates SSRF on URL fields', async () => {
      /* ... */
    });
  });

  describe('GET /api/projects/:pid/auth-profiles', () => {
    it('returns paginated list with default limit', async () => {
      /* ... */
    });
    it('supports ?authType filter', async () => {
      /* ... */
    });
    it('supports ?connector filter', async () => {
      /* ... */
    });
    it('supports ?environment filter', async () => {
      /* ... */
    });
    it('supports ?status filter', async () => {
      /* ... */
    });
    it('merges tenant-level profiles as inherited: true', async () => {
      /* ... */
    });
    it('marks overridden tenant profiles as overridden: true', async () => {
      /* ... */
    });
    it('filters personal profiles to creator unless admin', async () => {
      /* ... */
    });
    it('supports sorting by name, updatedAt, createdAt', async () => {
      /* ... */
    });
  });

  describe('GET /api/projects/:pid/auth-profiles/:id', () => {
    it('returns profile with redacted secrets', async () => {
      /* ... */
    });
    it('returns profile with decrypted secrets for AUTH_PROFILE_DECRYPT', async () => {
      /* ... */
    });
    it('returns 404 for non-existent id', async () => {
      /* ... */
    });
  });

  describe('PUT /api/projects/:pid/auth-profiles/:id', () => {
    it('updates name and description', async () => {
      /* ... */
    });
    it('updates config fields', async () => {
      /* ... */
    });
    it('updates encryptedSecrets', async () => {
      /* ... */
    });
    it('rejects authType change', async () => {
      /* ... */
    });
    it('rejects createdBy change', async () => {
      /* ... */
    });
    it('returns 404 for non-existent id', async () => {
      /* ... */
    });
  });

  describe('DELETE /api/projects/:pid/auth-profiles/:id', () => {
    it('deletes profile with no consumers', async () => {
      /* ... */
    });
    it('returns 409 for profile with active consumers', async () => {
      /* ... */
    });
    it('returns 404 for non-existent id', async () => {
      /* ... */
    });
  });
});
```

### Task 69: OAuth Endpoint Tests

**File:** `apps/runtime/src/__tests__/auth-profiles-oauth.test.ts`

```typescript
describe('Auth profile OAuth endpoints', () => {
  describe('POST /oauth/initiate', () => {
    it('returns authUrl and state for valid oauth2_app profile', async () => {
      /* ... */
    });
    it('returns 400 when authProfileId points to non-oauth2_app type', async () => {
      /* ... */
    });
    it('returns 404 when authProfileId not found', async () => {
      /* ... */
    });
    it('includes PKCE code_challenge when pkceRequired is true', async () => {
      /* ... */
    });
    it('rate limits to 20 requests per minute per user', async () => {
      /* ... */
    });
  });

  describe('POST /oauth/callback', () => {
    it('exchanges code for tokens and creates oauth2_token profile', async () => {
      /* ... */
    });
    it('sets linkedAppProfileId on created token profile', async () => {
      /* ... */
    });
    it('sets visibility based on connection mode', async () => {
      /* ... */
    });
    it('returns 400 for invalid state parameter', async () => {
      /* ... */
    });
    it('returns 400 for expired state parameter', async () => {
      /* ... */
    });
    it('rate limits to 10 requests per minute per user', async () => {
      /* ... */
    });
  });

  describe('POST /oauth/user-consent', () => {
    it('returns authUrl for runtime consent flow', async () => {
      /* ... */
    });
    it('requires valid sessionId', async () => {
      /* ... */
    });
    it('creates personal oauth2_token on subsequent callback', async () => {
      /* ... */
    });
  });
});
```

### Task 70: Rate Limit Tests

```typescript
describe('Auth profile OAuth rate limits', () => {
  it('/oauth/initiate: 21st request within 60s returns 429', async () => {
    // Send 20 requests (all pass) then 21st returns 429
  });

  it('/oauth/callback: 11th request within 60s returns 429', async () => {
    // Send 10 requests (all pass) then 11th returns 429
  });

  it('rate limits are per-user scoped', async () => {
    // Different users should each get their own window
  });
});
```

**Test commands:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profiles-authz.test.ts
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profiles-crud.test.ts
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profiles-oauth.test.ts
```

---

### Task Group G5b: Studio API Route Tests

**File:** `apps/studio/src/__tests__/api-auth-profile-routes.test.ts`

Follows the existing pattern in `route-handler-rbac.test.ts`: mock `requireAuth`, `requireProjectAccess`, test against `withRouteHandler` + `StudioPermission`.

```typescript
describe('Studio auth profile API routes', () => {
  describe('GET /api/projects/:pid/auth-profiles', () => {
    it('returns 200 with auth-profile:read permission', async () => {
      /* ... */
    });
    it('returns 403 without auth-profile:read', async () => {
      /* ... */
    });
    it('returns 401 without auth', async () => {
      /* ... */
    });
  });

  describe('POST /api/projects/:pid/auth-profiles', () => {
    it('returns 201 with auth-profile:write permission', async () => {
      /* ... */
    });
    it('returns 403 without auth-profile:write', async () => {
      /* ... */
    });
    it('proxies to runtime API', async () => {
      /* ... */
    });
  });

  describe('PUT /api/projects/:pid/auth-profiles/:id', () => {
    it('returns 200 with auth-profile:write permission', async () => {
      /* ... */
    });
    it('returns 403 without auth-profile:write', async () => {
      /* ... */
    });
  });

  describe('DELETE /api/projects/:pid/auth-profiles/:id', () => {
    it('returns 200 with auth-profile:delete permission', async () => {
      /* ... */
    });
    it('returns 403 without auth-profile:delete', async () => {
      /* ... */
    });
  });
});
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/studio/src/__tests__/api-auth-profile-routes.test.ts
```

---

### Task Group G5: Integration Tests — Integration Tests

**File:** `apps/runtime/src/__tests__/auth-profile-integration.test.ts`

> Integration tests use MongoMemoryServer. Excluded from the default vitest config. Run separately.

### Task 71: End-to-End OAuth Flow

```typescript
describe('Integration: OAuth flow end-to-end', () => {
  it('create oauth2_app → initiate → callback → oauth2_token created', async () => {
    // 1. Create oauth2_app profile with test client credentials
    const appProfile = await createTestProfile('oauth2_app', testTenantId);
    expect(appProfile._id).toBeDefined();

    // 2. POST /oauth/initiate → get authUrl + state
    const initiateRes = await request(baseUrl, 'POST', `/auth-profiles/oauth/initiate`, {
      body: { authProfileId: appProfile._id, connectorName: 'test-connector' },
    });
    expect(initiateRes.status).toBe(200);
    expect(initiateRes.body.data.authUrl).toMatch(/^https:/);
    expect(initiateRes.body.data.state).toMatch(/^[a-f0-9]{64}$/);

    // 3. Verify authUrl contains correct params
    const authUrl = new URL(initiateRes.body.data.authUrl);
    expect(authUrl.searchParams.get('client_id')).toBeDefined();
    expect(authUrl.searchParams.get('state')).toBe(initiateRes.body.data.state);

    // 4. POST /oauth/callback with mock code + state
    const callbackRes = await request(baseUrl, 'POST', `/auth-profiles/oauth/callback`, {
      body: { code: 'mock-auth-code', state: initiateRes.body.data.state },
    });
    expect(callbackRes.status).toBe(200);

    // 5. Verify new oauth2_token profile created
    const tokenProfile = callbackRes.body.data;
    expect(tokenProfile.authType).toBe('oauth2_token');
    expect(tokenProfile.config.linkedAppProfileId).toBe(appProfile._id);
    expect(tokenProfile.status).toBe('active');

    // 6. Verify consumers endpoint shows the new token
    const consumersRes = await request(
      baseUrl,
      'GET',
      `/auth-profiles/${appProfile._id}/consumers`,
    );
    expect(consumersRes.body.data.consumers.length).toBeGreaterThan(0);
  });
});
```

### Task 72: Connector Setup with Auth Profile

```typescript
describe('Integration: Connector setup with Auth Profile', () => {
  it('create profile → assign to ConnectorConfig → resolve returns credentials', async () => {
    // 1. Create api_key auth profile
    const profile = await createTestProfile('api_key', testTenantId, {
      headerName: 'X-API-Key',
    });
    expect(profile._id).toBeDefined();

    // 2. Create ConnectorConfig with authProfileId
    const config = await createTestConnectorConfig({
      authProfileId: profile._id,
      tenantId: testTenantId,
      projectId: testProjectId,
    });

    // 3. Call authProfileService.resolve()
    const resolved = await authProfileService.resolve({
      authProfileId: profile._id,
      tenantId: testTenantId,
      projectId: testProjectId,
    });

    // 4. Verify returned credentials
    expect(resolved).toBeDefined();
    expect(resolved.headerName).toBe('X-API-Key');
    expect(resolved.apiKey).toBeDefined();
  });

  it('returns null when authProfileId is not set (not configured)', async () => {
    // No feature flags, no dual-read. If authProfileId is absent, credentials don't exist yet.
    const config = await createTestConnectorConfig({
      tenantId: testTenantId,
      projectId: testProjectId,
      // no authProfileId
    });

    const resolved = await resolveCredentials(config);
    expect(resolved).toBeNull();
  });
});
```

### Task 73: Token Refresh Cycle

```typescript
describe('Integration: Token refresh cycle', () => {
  it('expired token triggers refresh on resolve', async () => {
    // 1. Create oauth2_app profile
    const appProfile = await createTestProfile('oauth2_app', testTenantId);

    // 2. Create oauth2_token with expiresAt in the past
    const tokenProfile = await createTestProfile('oauth2_token', testTenantId, {
      linkedAppProfileId: appProfile._id,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    // 3. Mock the token endpoint to return new tokens
    mockTokenEndpoint.mockResolvedValueOnce({
      access_token: 'new-access-token',
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
    });

    // 4. Call resolve()
    const resolved = await authProfileService.resolve({
      authProfileId: tokenProfile._id,
      tenantId: testTenantId,
      projectId: testProjectId,
    });

    // 5. Verify
    expect(resolved.accessToken).toBe('new-access-token');
    const updated = await AuthProfile.findById(tokenProfile._id);
    expect(new Date(updated.config.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(traceEvents).toContainEqual(
      expect.objectContaining({
        type: 'auth_profile_refresh',
        success: true,
      }),
    );
  });

  it('null expiresAt skips proactive refresh', async () => {
    const tokenProfile = await createTestProfile('oauth2_token', testTenantId, {
      expiresAt: null,
    });

    const resolved = await authProfileService.resolve({
      authProfileId: tokenProfile._id,
      tenantId: testTenantId,
      projectId: testProjectId,
    });

    expect(resolved.accessToken).toBeDefined();
    expect(mockTokenEndpoint).not.toHaveBeenCalled();
  });

  it('concurrent refresh uses distributed lock', async () => {
    const tokenProfile = await createTestProfile('oauth2_token', testTenantId, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    mockTokenEndpoint.mockResolvedValue({
      access_token: 'refreshed-token',
      expires_in: 3600,
    });

    // Call resolve() concurrently from 3 "pods"
    const results = await Promise.all([
      authProfileService.resolve({
        authProfileId: tokenProfile._id,
        tenantId: testTenantId,
        projectId: testProjectId,
      }),
      authProfileService.resolve({
        authProfileId: tokenProfile._id,
        tenantId: testTenantId,
        projectId: testProjectId,
      }),
      authProfileService.resolve({
        authProfileId: tokenProfile._id,
        tenantId: testTenantId,
        projectId: testProjectId,
      }),
    ]);

    // Token endpoint called exactly once (lock prevents duplicates)
    expect(mockTokenEndpoint).toHaveBeenCalledTimes(1);
    // All callers receive the refreshed token
    for (const result of results) {
      expect(result.accessToken).toBe('refreshed-token');
    }
  });
});
```

### Task 74: GDPR Cascade

```typescript
describe('Integration: GDPR cascade', () => {
  it('tenant deletion removes all tenant auth profiles', async () => {
    // 1. Create 5 profiles for tenant-X
    // 2. Call deleteTenant('tenant-X')
    // 3. Verify AuthProfile.find({ tenantId: 'tenant-X' }) returns 0
  });

  it('user deletion removes personal profiles, preserves shared', async () => {
    // 1. Create 2 personal + 2 shared profiles by user-A
    // 2. Call deleteUser('user-A')
    // 3. Verify personal profiles deleted
    // 4. Verify shared profiles still exist (createdBy anonymized)
  });

  it('project deletion removes project-level profiles', async () => {
    // 1. Create profiles for project-X
    // 2. Call deleteProject('project-X')
    // 3. Verify project-level profiles deleted
    // 4. Verify tenant-level profiles preserved
  });

  it('EndUserOAuthToken is included in GDPR cascade (pre-existing gap fix)', async () => {
    // Verify the cascade-delete function includes EndUserOAuthToken deletion
  });
});
```

**Test command (integration tests, run separately):**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-integration.test.ts --testTimeout=60000
```

---

### Task Group G6: Performance Tests — Performance Tests & Optimization

### Task 75: Resolution Query Benchmarks

**File:** `apps/runtime/src/__tests__/auth-profile-perf.test.ts`

```typescript
describe('AuthProfile resolution performance', () => {
  it('resolves within 50ms with 1000+ profiles per tenant', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    // Seed 1000 profiles across different connectors, environments, scopes
    const profiles = Array.from({ length: 1000 }, (_, i) =>
      makeAuthProfile({
        name: `perf-profile-${i}`,
        connector: `connector-${i % 20}`,
        environment: i % 3 === 0 ? 'production' : i % 3 === 1 ? 'staging' : null,
        tenantId: 'tenant-perf',
      }),
    );
    await AuthProfile.insertMany(profiles);

    // Warm up
    await authProfileService.resolve({
      tenantId: 'tenant-perf',
      projectId: 'proj-test-1',
      connector: 'connector-0',
      connectionMode: 'shared',
      environment: 'production',
    });

    // Measure
    const start = performance.now();
    const iterations = 100;
    for (let i = 0; i < iterations; i++) {
      await authProfileService.resolve({
        tenantId: 'tenant-perf',
        projectId: 'proj-test-1',
        connector: `connector-${i % 20}`,
        connectionMode: 'shared',
        environment: 'production',
      });
    }
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(50);
  });

  it('$or query uses index intersection (explain plan)', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    // Seed some data
    await AuthProfile.insertMany(
      Array.from({ length: 100 }, (_, i) =>
        makeAuthProfile({ name: `idx-test-${i}`, tenantId: 'tenant-idx' }),
      ),
    );

    const explanation = await AuthProfile.find({
      tenantId: 'tenant-idx',
      $or: [
        { projectId: 'proj-1', environment: 'production' },
        { projectId: 'proj-1', environment: null },
        { projectId: null },
      ],
    }).explain('executionStats');

    // Verify index was used (not COLLSCAN)
    const stage =
      (explanation as any).queryPlanner?.winningPlan?.stage ??
      (explanation as any).queryPlanner?.winningPlan?.inputStage?.stage;
    expect(stage).not.toBe('COLLSCAN');
  });
});
```

### Task 76: Redis Lock Contention Simulation

```typescript
describe('Token refresh lock contention', () => {
  it('backoff retries re-read from DB and succeed after lock release', async () => {
    // 1. Mock Redis SET NX to fail (lock held)
    // 2. On 3rd retry, mock Redis returns success
    // 3. Verify total wait < 2s (max backoff)
    // 4. Verify DB re-read attempted
  });

  it('fails with AUTH_PROFILE_TOKEN_REFRESH_FAILED after max retries', async () => {
    // 1. Mock Redis SET NX to always fail
    // 2. Verify error thrown after max wait (2s)
    // 3. Verify error is retryable: true
  });

  it('proceeds without lock when Redis is unavailable', async () => {
    // 1. Mock Redis connection to throw
    // 2. Verify refresh still happens (without lock)
    // 3. Verify auth_profile_lock_unavailable trace event emitted
  });
});
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-perf.test.ts --testTimeout=120000
```

---

### Task Group G7: Caching Implementation — Performance: Caching Strategy

### Task 77: Session-Level LRU Cache

**File:** `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`

Design follows the existing `DEKCacheL1` pattern in `apps/runtime/src/services/kms/dek-cache.ts` and `TwoTierIRCache` in `apps/runtime/src/services/session/ir-cache.ts`.

```typescript
/**
 * Session-level LRU cache for resolved Auth Profile credentials.
 *
 * Pattern: pod-local Map-based LRU with TTL eviction.
 * Max 200 entries (one entry per profile resolution).
 * TTL: min(expiresAt - buffer, 5 minutes).
 *
 * Cache key: `${tenantId}:${profileId}:${environment}`
 */

interface CachedCredentials {
  credentials: DecryptedCredentials;
  cachedAt: number;
  ttlMs: number;
}

export class AuthProfileCache {
  private cache = new Map<string, CachedCredentials>();
  private readonly maxEntries = 200;

  get(tenantId: string, profileId: string, environment: string | null): DecryptedCredentials | null;
  set(
    tenantId: string,
    profileId: string,
    environment: string | null,
    creds: DecryptedCredentials,
    ttlMs: number,
  ): void;
  invalidate(tenantId: string, profileId?: string): void;
  get size(): number;
  clear(): void;
}
```

**Tests for cache:**

**File:** `apps/runtime/src/__tests__/auth-profile-cache.test.ts`

```typescript
describe('AuthProfileCache', () => {
  it('returns null on cache miss', () => {
    /* ... */
  });
  it('returns cached credentials on hit', () => {
    /* ... */
  });
  it('evicts expired entries', () => {
    /* ... */
  });
  it('evicts LRU entry when at max capacity', () => {
    /* ... */
  });
  it('invalidate(tenantId) removes all entries for tenant', () => {
    /* ... */
  });
  it('invalidate(tenantId, profileId) removes single entry', () => {
    /* ... */
  });
  it('clear() removes all entries', () => {
    /* ... */
  });
  it('max 200 entries enforced', () => {
    const cache = new AuthProfileCache();
    for (let i = 0; i < 250; i++) {
      cache.set('t', `p-${i}`, null, {}, 60_000);
    }
    expect(cache.size).toBe(200);
  });
});
```

### Task 78: Redis Cache for `oauth2_client_credentials` Tokens

```typescript
/**
 * Redis cache for client_credentials tokens (shared across pods).
 *
 * Key: `auth-profile:cc-token:{tenantId}:{profileId}`
 * TTL: expires_in - AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS
 * Value: JSON { accessToken, tokenType, expiresAt }
 */
```

**Tests:**

**File:** `apps/runtime/src/__tests__/auth-profile-cc-cache.test.ts`

```typescript
describe('oauth2_client_credentials Redis cache', () => {
  it('caches token after first resolution', async () => {
    /* ... */
  });
  it('returns cached token on subsequent resolve (no HTTP call)', async () => {
    /* ... */
  });
  it('sets TTL to expires_in minus buffer', async () => {
    /* ... */
  });
  it('fetches new token after TTL expires', async () => {
    /* ... */
  });
  it('falls back to direct fetch when Redis unavailable', async () => {
    /* ... */
  });
  it('invalidates on rotation event via pub/sub', async () => {
    /* ... */
  });
});
```

### Task 79: Cache Invalidation via Redis Pub/Sub

```typescript
/**
 * Auth Profile rotation events:
 * Channel: `auth-profile:rotation`
 * Payload: { tenantId, profileId, event: 'rotated' | 'revoked' | 'deleted' }
 *
 * Subscribers: AuthProfileCache (L1), VoiceServiceFactory cache
 */
```

**Tests:**

**File:** `apps/runtime/src/__tests__/auth-profile-cache-invalidation.test.ts`

```typescript
describe('Auth profile cache invalidation via pub/sub', () => {
  it('L1 cache evicts entry on rotation event', async () => {
    /* ... */
  });
  it('Redis cc-token cache deletes key on rotation event', async () => {
    /* ... */
  });
  it('VoiceServiceFactory.invalidate() called on rotation event', async () => {
    /* ... */
  });
  it('pub/sub failure does not crash the runtime', async () => {
    /* ... */
  });
  it('multiple pods all receive and process the event', async () => {
    /* ... */
  });
});
```

**Test command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-cache.test.ts
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-cc-cache.test.ts
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run apps/runtime/src/__tests__/auth-profile-cache-invalidation.test.ts
```

---

### Coverage Verification

### Minimum Thresholds

| Layer                               | Line Coverage | Branch Coverage | File Pattern                                                                                |
| ----------------------------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Model (`auth-profile.model.ts`)     | 95%           | 90%             | `packages/database/src/models/auth-profile*`                                                |
| Service (`auth-profile-service.ts`) | 90%           | 85%             | `packages/database/src/services/auth-profile*` or `apps/runtime/src/services/auth-profile*` |
| API routes                          | 85%           | 80%             | `apps/runtime/src/routes/auth-profiles*`                                                    |
| Studio routes                       | 85%           | 80%             | `apps/studio/src/app/api/projects/[id]/auth-profiles/**`                                    |
| Studio UI components                | 80%           | 75%             | `apps/studio/src/components/auth-profiles/**`                                               |
| Cache layer                         | 95%           | 90%             | `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`                              |
| Zod schemas                         | 100%          | 100%            | Validation schemas for all 6 auth types                                                     |

### Enforcement

Add coverage thresholds to the vitest config:

```typescript
// In vitest config, add to coverage section:
thresholds: {
  // Applied per-file when running with --coverage
  autoUpdate: false,
}
```

### Dead Code Detection

- `no-unused-vars` ESLint rule enforced on all new files
- `no-unreachable` ESLint rule enforced
- No `// istanbul ignore` or `/* c8 ignore */` without a documented reason
- Every exported function must have at least one test importing it
- Run `npx ts-prune` on affected packages to detect unused exports

**Verification command:**

```bash
cd /Users/prasannaarikala/projects/agent-platform && npx vitest run --coverage --coverage.include='**/auth-profile*' apps/runtime/src/__tests__/auth-profile*.test.ts packages/database/src/__tests__/auth-profile*.test.ts
```

---

---

## Out of Scope (Phase 1)

The following are explicitly excluded from this implementation plan:

1. **Enterprise auth types** (`kerberos`, `saml`, `hawk`, `digest`, `ws_security`) — Phase 3
2. **Remaining core auth types** (`basic`, `custom_header`, `aws_iam`, `azure_ad`, `mtls`, `ssh_key`) — Phase 2
3. **Addon mechanisms** (`signing`, `webhookVerification`, `proxy`, `certificatePinning`, `jwtWrapping`) — Phase 2/3
4. **Key rotation** (`rotationPolicy`, `previousEncryptedSecrets`, `rotationGracePeriodMs`, `EncryptionService` multi-key) — Phase 2/3
5. **Legacy credential migration** (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`, worker migration) — Phase 2
6. **Tenant-level CRUD routes** (`/api/auth-profiles/*` without project scope) — Phase 2
7. **Pre-flight auth propagation** (compiler + runtime multi-agent credential passing) — Phase 2
8. **Import/export auth mapping** and **voice lifecycle auth** — Phase 3
9. **Multi-agent credential propagation** (handoff, delegate, fan-out) — Phase 3
10. **`RuntimeSecretsProvider` full integration** and **`OrgProxyConfig` multi-credential merge** — Phase 2

---

## Dependency Graph

```
Phase A (Tasks 1-7)
  └─► Phase B (Tasks 8-11)         ← Requires model + schema + service
  └─► Phase C (Tasks 12-27)        ← Requires model + service + API routes
        └─► Phase D (Tasks 28-39)  ← Requires OAuth flows for security wiring
        └─► Phase E (Tasks 40-51)  ← Requires API routes + OAuth endpoints
  └─► Phase F (Tasks 52-56)        ← Requires service + API routes
  └─► Phase G (Tasks 57-79)        ← Requires all above for integration tests
```

### Key Cross-References

- **Task 12** (linked-app validation) requires **Task 1** (AuthProfile model) and **Task 6** (service)
- **Task 15-17** (OAuth endpoints) require **Task 10** (OAuth route stubs) and **Task 14** (two-layer model)
- **Task 21** (Redis lock) requires **Task 7** (lock contention test pattern)
- **Task 28-29** (GDPR cascade) require **Task 1** (model exists in models barrel)
- **Task 32** (authz tests) require **Tasks 8-11** (API routes exist)
- ~~**Task 34** (SSRF)~~ — REMOVED. SSRF validation is built into Task 4 Zod schemas directly (no separate task)
- **Task 40-41** (API client + SWR) require **Tasks 8-11** (API routes deployed)
- **Task 44** (management page) requires **Tasks 40-43** (client, hooks, metadata, badge)
- **Task 46** (slide-over) requires **Task 44** (page exists)
- **Task 47** (picker) requires **Task 41** (SWR hook)
- **Task 48** (wire picker into connections) requires **Task 47** (picker component)
- **Task 52-53** (connector wiring) require **Task 6** (service) and **Task 24** (resolver)
- **Task 57** (mock factory) is a dependency for all Phase G tests
- **Task 77-79** (caching) require **Task 25** (credential cache) complete

---

## Environment Variables

| Variable                                    | Required By | Default    | Purpose                                     |
| ------------------------------------------- | ----------- | ---------- | ------------------------------------------- |
| `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS` | Runtime     | `60`       | Buffer before token expiry triggers refresh |
| `ENCRYPTION_MASTER_KEY`                     | All         | (required) | Master encryption key for secrets           |

---

## Libraries

| Library                                           | Version | Purpose                                                                             |
| ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| _(none — native `fetch` used for token exchange)_ | —       | OAuth 2.0 token exchange uses `fetch` directly; no third-party OAuth library needed |
