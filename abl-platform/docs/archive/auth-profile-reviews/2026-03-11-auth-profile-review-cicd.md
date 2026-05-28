# Auth Profile — CI/CD, Build System & Deployment Review

**Reviewer:** CI/CD & Build Systems
**Date:** 2026-03-11
**Documents Reviewed:** `auth-profile-design.md`, `auth-profile-code-changes.md`, `auth-profile-test-analysis.md`

---

## 1. Package Placement Decision

### Recommendation: NO new package — use `packages/shared`

The code changes document proposes placing new Auth Profile code in `packages/shared`:

- `packages/shared/src/types/auth-profile.ts`
- `packages/shared/src/validation/auth-profile-schemas.ts`
- `packages/shared/src/repos/auth-profile-repo.ts`
- `packages/shared/src/services/auth-profile-service.ts`

The model goes in `packages/database/src/models/auth-profile.model.ts`.

**This is the correct approach.** Creating a new `packages/auth-profile` would require:

- Updating `pnpm-workspace.yaml`
- Adding COPY lines to 7+ Dockerfiles
- Configuring `tsconfig.json`, `vitest.config.ts`, build scripts
- Wiring Turbo dependency graph

Since `packages/shared` already depends on `packages/database` (where the model lives) and is consumed by all apps (runtime, studio, search-ai, search-ai-runtime, workflow-engine, pipeline-engine), no new dependency edges are needed.

**Verdict: APPROVED** — no Dockerfile changes required for package placement.

### Caveat: `packages/shared` is becoming a kitchen sink

`packages/shared` already exports 17 subpath modules (middleware, types, repos, validation, tools, encryption, security, services, prompts, etc.). Adding 4 more auth-profile modules is acceptable for this change, but the package should be a candidate for decomposition in the next architecture simplification sprint. The `auth-profile-service.ts` alone is estimated at XL effort, suggesting it will become a significant fraction of `packages/shared`.

---

## 2. Dockerfile Impact Assessment

### Current State

All Dockerfiles already COPY `packages/shared/package.json` and `packages/database/package.json`. All Dockerfiles use `COPY packages/ packages/` for the full source copy, so no source-level COPY changes are needed.

### No Dockerfile Changes Required

Since the design places code in existing packages (`packages/shared` and `packages/database`), no new COPY lines are needed. Confirmed across all 7 Dockerfiles:

| Dockerfile                            | `shared` COPY        | `database` COPY      | Status |
| ------------------------------------- | -------------------- | -------------------- | ------ |
| `apps/runtime/Dockerfile`             | Yes (line 24)        | Yes (line 23)        | OK     |
| `apps/search-ai/Dockerfile`           | Yes (line 48)        | Yes (line 34)        | OK     |
| `apps/search-ai-runtime/Dockerfile`   | Yes (line 24)        | Yes (line 23)        | OK     |
| `apps/admin/Dockerfile`               | Yes (line 28)        | Yes (line 27)        | OK     |
| `apps/studio/Dockerfile`              | Yes (line 28)        | Yes (line 27)        | OK     |
| `apps/workflow-engine/Dockerfile`     | Via `COPY packages/` | Via `COPY packages/` | OK     |
| `packages/pipeline-engine/Dockerfile` | Yes (line 25)        | Yes (line 24)        | OK     |

**Verdict: APPROVED** — zero Dockerfile changes.

---

## 3. New npm Dependencies — CRITICAL FINDINGS

The design lists 8 new libraries. This is the highest-risk area of the proposal.

### 3.1 Dependency Audit

| Library                 | Install Size | Native Bindings | Already in Monorepo          | Target Package    |
| ----------------------- | ------------ | --------------- | ---------------------------- | ----------------- |
| `simple-oauth2`         | ~50KB        | No              | No                           | `packages/shared` |
| `@node-saml/node-saml`  | ~2MB         | No              | **Yes** (`apps/studio`)      | `packages/shared` |
| `digest-fetch`          | ~15KB        | No              | No                           | `packages/shared` |
| `@hapi/hawk`            | ~100KB       | No              | No                           | `packages/shared` |
| `soap`                  | **~8MB**     | No              | No                           | `packages/shared` |
| `kerberos`              | ~2MB         | **YES** (C++)   | No                           | `packages/shared` |
| `@aws-sdk/signature-v4` | ~500KB       | No              | No (but `@aws-sdk/*` exists) | `packages/shared` |
| `@azure/identity`       | ~3MB         | No              | No                           | `packages/shared` |

### 3.2 BLOCKER: `kerberos` Has Native Bindings

The `kerberos` npm package (maintained by MongoDB team) requires:

- **C/C++ compiler toolchain** (`gcc`/`g++`, `make`, `python3`)
- **libkrb5-dev** system package (Kerberos development headers)

**Current build images:**

- Builder stage: `node:22-slim` — does NOT include build-essential or libkrb5-dev
- Production stage: `gcr.io/distroless/nodejs22-debian12` — no shared libraries for native modules

**Impact:**

1. Every Dockerfile's builder stage needs: `RUN apt-get update && apt-get install -y build-essential libkrb5-dev python3`
2. The production distroless image may be missing `libgssapi_krb5.so.2` and other Kerberos shared libraries
3. This adds ~200MB to the builder image and slows builds by 30-60 seconds per Dockerfile

**Recommendation: Defer `kerberos` auth type to a future sprint.** Kerberos is an enterprise-only use case. The design already has 16 other auth types that cover 99%+ of real usage. If Kerberos must ship, isolate it in a separate optional package with its own Dockerfile stage, or use a Kerberos-capable sidecar pattern.

### 3.3 WARNING: `soap` Is Large

The `soap` package pulls in ~8MB of dependencies including `xml-crypto`, `xmldom`, `xmlbuilder`, and `xpath`. This is only needed for `ws_security` auth type (SOAP/XML services).

**Recommendation:** Make `soap` a peer dependency or lazy-load it. Most deployments will never use WS-Security. Consider:

```typescript
// Lazy load to avoid bundling soap in every deployment
async function getWsSecurityHandler() {
  const { createClient } = await import('soap');
  // ...
}
```

### 3.4 `@node-saml/node-saml` Already in Monorepo

`apps/studio/package.json` already declares `"@node-saml/node-saml": "^5.1.0"`. If this moves to `packages/shared`, it becomes a dependency of every consumer of `packages/shared`. Verify that SAML is needed at runtime (in `apps/runtime`) and not just in Studio.

### 3.5 `@aws-sdk/signature-v4` — Version Alignment

The monorepo already uses `@aws-sdk/*` packages at `^3.500.0` and `^3.998.0` (in `packages/shared`). Ensure `@aws-sdk/signature-v4` is pinned to a compatible version. AWS SDK v3 uses a modular architecture, so this should align naturally, but verify it does not force a lockfile-wide version bump.

### 3.6 Total Dependency Footprint

Adding all 8 libraries to `packages/shared` increases its transitive dependency count significantly. Since `packages/shared` is a dependency of every app, this bloats ALL Docker images:

- **Current:** `packages/shared` has ~15 direct dependencies
- **After:** ~23 direct dependencies (53% increase)
- **Estimated image size increase:** +15-25MB per production image (excluding kerberos)

**Recommendation:** Consider an `@agent-platform/auth-protocols` optional package for the heavy protocol libraries (`soap`, `kerberos`, `@node-saml/node-saml`, `@hapi/hawk`). Only apps that need enterprise auth types would depend on it. The core `AuthProfileService` (CRUD, resolve, encrypt/decrypt) stays in `packages/shared` with zero new deps.

---

## 4. Database Migrations

### 4.1 Migration Framework — Solid

The project has a well-structured migration system:

- **Runner:** `packages/database/src/migrations/runner.ts` — distributed locking, transaction support, history tracking
- **CLI:** `packages/database/src/migrations/cli.ts` — migrate/status/rollback commands
- **Docker stage:** `apps/runtime/Dockerfile` Stage 4 (`migrate`) and Stage 6 (`init`) run migrations as K8s init-containers
- **12 existing migrations** — the pattern is proven

### 4.2 Migration Script Requirements

The Auth Profile migration is estimated as **XL effort** with 3 phases:

1. **Create `auth_profiles` collection + 7 indexes + unique constraint**
2. **Data migration:** Transform `llm_credentials`, `end_user_oauth_tokens`, `tool_secrets` into `auth_profiles` documents
3. **Consumer reference update:** Replace `credentialId`/inline fields with `authProfileId` across 9 collections

### 4.3 CRITICAL: Unique Constraint Deployment

The unique constraint `{ tenantId, projectId, name }` is dangerous during migration:

- If migration generates duplicate names (e.g., two credentials with auto-generated name "Production OpenAI" in the same tenant/project), the unique index creation will fail
- **Mitigation:** The migration script MUST either:
  - a) Generate guaranteed-unique names (append suffix if collision: "Production OpenAI", "Production OpenAI (2)")
  - b) Create the unique index AFTER data migration with `{ background: true }` and handle conflicts
  - c) Use a partial unique index that only enforces for non-null projectId

### 4.4 Index Creation: 7 Indexes + 1 Unique

```
{ tenantId, scope }                           // list tenant-level
{ tenantId, projectId, scope }                // list project-level
{ tenantId, projectId, connector, authType }  // find connector auth
{ tenantId, projectId, visibility, createdBy } // find personal profiles
{ tenantId, projectId, category }             // filter by category
{ linkedAppProfileId }                        // find all tokens for an app
{ status, expiresAt }                         // cleanup expired
{ tenantId, projectId, name } UNIQUE          // name uniqueness
```

**Concern:** 8 indexes on a single collection is on the high side. Each index adds write amplification. For a collection that will store auth profiles (relatively low-write), this is acceptable. But monitor write latency after deployment.

**Recommendation:** Build indexes with `{ background: true }` to avoid blocking production reads during creation. The migration runner already supports this (see existing migration `20260219_001`).

### 4.5 Migration Rollback

The migration must have a working `down()` function because:

- The K8s init-container runs migrations on every deploy
- A failed deployment followed by rollback must not leave the database in an inconsistent state
- The `down()` should: drop the `auth_profiles` collection and its indexes, restore `credentialId` fields on consumer collections (requires storing the mapping during `up()`)

**Recommendation:** Store a mapping document `{ authProfileId -> originalCredentialId/originalInlineFields }` in a temporary collection during migration. The `down()` function uses this to restore original state.

---

## 5. CI Pipeline

### 5.1 Current CI Setup

There is **no CI configuration file** in the repository (no `.github/workflows/`, no `.gitlab-ci.yml`, no `Jenkinsfile`). CI likely runs externally (possibly in the `abl-platform-deploy` repo or a managed CI service). This means:

- Build/test commands are inferred from `turbo.json` tasks: `build`, `test`, `lint`, `typecheck`, `format:check`
- Test execution: `pnpm turbo test` runs all workspace test suites in dependency order

### 5.2 Test Impact on CI Time

Current test counts (from memory):

| Package   | Current Tests | Impact                            |
| --------- | ------------- | --------------------------------- |
| Compiler  | 3,947         | Moderate — ~10 tests updated      |
| Runtime   | 8,861         | Heavy — ~130 tests modified/added |
| Search-AI | 1,430         | Moderate — ~50 tests modified     |
| Database  | ~500 (est.)   | Heavy — model tests rewritten     |
| Shared    | ~200 (est.)   | Heavy — new service/repo tests    |

The design estimates **~374 new tests + ~130 updated tests**. At approximately 10ms per unit test, this adds ~5 seconds of raw execution time — negligible. However:

- **MongoDB-dependent tests** (model tests, repo tests, integration tests) use `mongodb-memory-server`, which is already a devDependency of `packages/database`. These tests are slower (~50-100ms each)
- **Estimated CI time increase:** +30-60 seconds total

### 5.3 Integration Test Provisioning

Integration tests that need MongoDB use `mongodb-memory-server` (confirmed in `packages/database/package.json` devDependencies). This is an in-process MongoDB instance — no external provisioning needed. Auth Profile tests can follow the same pattern.

---

## 6. Feature Flags and Rollout

### 6.1 Current Feature Flag Usage

The codebase has **minimal feature flag infrastructure**. Only 2 files reference feature flags:

- `packages/pipeline-engine/src/pipeline/services/compute-predictive-features.service.ts`
- `packages/database/seed-mongo.ts`

There is no centralized feature flag service (no LaunchDarkly, no Unleash, no custom toggle system).

### 6.2 Should Auth Profile Be Behind a Feature Flag?

**Yes, strongly recommended.** Here is why:

1. **Breaking change scope:** 3 models deleted, 9 collections altered, 65+ files changed, 130+ tests updated
2. **Multi-service deployment:** Changes span runtime, studio, search-ai, search-ai-runtime, workflow-engine, pipeline-engine
3. **Data migration risk:** Moving credential data to a new collection — any bug corrupts auth for all tenants

**Recommended approach — API-level toggle:**

```typescript
// In packages/shared/src/services/auth-profile-service.ts
const USE_AUTH_PROFILES = process.env.AUTH_PROFILE_ENABLED === 'true';

export function resolveCredentials(params: ResolveParams) {
  if (USE_AUTH_PROFILES) {
    return authProfileService.resolve(params);
  }
  return legacyCredentialService.resolve(params); // existing code
}
```

This allows:

- Deploy migration (creates `auth_profiles` collection alongside existing collections)
- Enable per-environment with `AUTH_PROFILE_ENABLED=true`
- Instant rollback by setting env var to `false` — no redeployment needed
- Old models remain until toggle is fully enabled and verified

### 6.3 Database Backward Compatibility During Rolling Deployment

During a rolling deployment, some pods run old code, others new. The migration must be **additive-only in phase 1:**

1. **Phase 1 (non-breaking):** Create `auth_profiles` collection. Add `authProfileId` field to consumer collections (nullable). Keep old fields. New code reads from AuthProfile, falls back to legacy.
2. **Phase 2 (after full rollout + soak period):** Remove old models and fields. Drop legacy collections.

This two-phase approach prevents the "half-old, half-new" problem during rolling updates.

---

## 7. Deployment Order

### 7.1 Service Dependency Graph for Auth Profile

```
packages/database  (model)
    ↓
packages/shared    (service, repo, types, validation)
    ↓
┌───────────┬──────────────┬──────────────┬────────────────┬─────────────────┐
│ runtime   │ studio       │ search-ai    │ search-ai-rt   │ workflow-engine  │
│ (routes,  │ (API routes, │ (LLM config, │ (query model   │ (DB init,       │
│  resolve) │  UI, OAuth)  │  workers)    │  resolver)     │  connections)   │
└───────────┴──────────────┴──────────────┴────────────────┴─────────────────┘
```

### 7.2 Safe Deployment Order

1. **Database migration** (K8s init-container / ArgoCD PreSync hook)
   - Creates `auth_profiles` collection + indexes
   - Migrates data from legacy collections
   - Adds `authProfileId` to consumer collections
   - **Does NOT delete old collections yet**

2. **Deploy packages** (automatic — they are bundled into apps)
   - `packages/database` + `packages/shared` changes are compiled into each app's build

3. **Deploy apps in any order** (because feature flag starts disabled)
   - runtime, studio, search-ai, search-ai-runtime, workflow-engine, pipeline-engine
   - All deployments are safe because `AUTH_PROFILE_ENABLED=false` means old code paths

4. **Enable feature flag** per environment
   - Start with staging/dev
   - Roll to production after validation

5. **Phase 2 cleanup** (separate PR, weeks later)
   - Remove legacy models
   - Drop old collections
   - Remove feature flag

### 7.3 Rollback Plan

| Scenario                            | Action                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Migration fails                     | Init-container exits non-zero, K8s does not start the pod. Fix migration, redeploy.                               |
| App deployment fails (crash loop)   | K8s rolls back to previous ReplicaSet automatically. Feature flag is off, so old code paths work.                 |
| Auth Profile has bugs in production | Set `AUTH_PROFILE_ENABLED=false`. No redeployment needed. All services fall back to legacy credential resolution. |
| Need full database rollback         | Run `pnpm db:migrate:mongo:rollback` — migration `down()` restores state. Then redeploy old app versions.         |

---

## 8. Lockfile Impact

### 8.1 Current Lockfile

`pnpm-lock.yaml` is 22,010 lines. Adding 8 new dependencies (and their transitive deps) will add an estimated 2,000-4,000 lines, bringing it to ~25,000 lines.

### 8.2 Native Dependencies

If `kerberos` is included:

- `pnpm-lock.yaml` will contain platform-specific entries (`os`, `cpu` fields)
- CI must run on Linux x64 to produce a lockfile compatible with Docker builds (which use `node:22-slim` — Debian x64)
- macOS developers will get a different binary — this is handled by pnpm's platform-specific resolution, but increases lockfile complexity

### 8.3 Recommendation

- Add dependencies incrementally (one PR per batch) to make lockfile diffs reviewable
- Run `pnpm install` then `pnpm build` to verify lockfile integrity before committing
- If kerberos is deferred (recommended), the lockfile impact is manageable (~1,500-2,500 lines)

---

## 9. Summary of Findings

### Blockers (must resolve before implementation)

| #   | Finding                                                                                                     | Severity | Recommendation                                                 |
| --- | ----------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| B1  | `kerberos` native bindings require build tools in Docker builder + shared libraries in production image     | BLOCKER  | Defer `kerberos` auth type to future sprint                    |
| B2  | No feature flag strategy for a change touching 65+ files across 6 services                                  | BLOCKER  | Add `AUTH_PROFILE_ENABLED` env-based toggle                    |
| B3  | Unique constraint `{ tenantId, projectId, name }` may fail during data migration if generated names collide | BLOCKER  | Migration must de-duplicate names before creating unique index |

### Warnings (should resolve, not blocking)

| #   | Finding                                                                                                  | Severity | Recommendation                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| W1  | `soap` adds ~8MB to every production image for a rarely-used auth type                                   | WARNING  | Lazy-load `soap` or isolate in optional package                   |
| W2  | Adding 8 deps to `packages/shared` bloats all Docker images by 15-25MB                                   | WARNING  | Consider `@agent-platform/auth-protocols` for heavy protocol libs |
| W3  | Migration rollback (`down()`) is non-trivial — must restore `credentialId` mappings                      | WARNING  | Store forward/reverse mapping in temp collection                  |
| W4  | 8 indexes on `auth_profiles` collection — monitor write latency                                          | WARNING  | Build all indexes with `{ background: true }`                     |
| W5  | `@node-saml/node-saml` currently in Studio only — moving to `packages/shared` forces it on all consumers | WARNING  | Verify SAML is needed at runtime, not just Studio                 |
| W6  | No CI configuration in repo — cannot assess pipeline timing impact precisely                             | WARNING  | Document expected CI time increase for external CI team           |

### Approved (no issues)

| #   | Area                                                                | Status   |
| --- | ------------------------------------------------------------------- | -------- |
| A1  | Package placement in `packages/shared` + `packages/database`        | APPROVED |
| A2  | No Dockerfile COPY changes needed                                   | APPROVED |
| A3  | Migration framework is mature and proven (12 existing migrations)   | APPROVED |
| A4  | `mongodb-memory-server` for integration tests — no CI infra changes | APPROVED |
| A5  | Turbo build graph unaffected — no new packages                      | APPROVED |
| A6  | Two-phase deployment strategy (additive migration, then cleanup)    | APPROVED |

---

## 10. Recommended Implementation Phases

### Phase 1: Foundation (non-breaking, feature-flagged)

- Auth Profile model in `packages/database`
- Auth Profile service/repo/types/validation in `packages/shared`
- Core dependencies only: `simple-oauth2`, `digest-fetch`, `@aws-sdk/signature-v4`
- Migration: create `auth_profiles`, migrate data, add `authProfileId` to consumers
- Feature flag: `AUTH_PROFILE_ENABLED=false` by default
- **No enterprise auth types** (kerberos, SAML, Hawk, WS-Security deferred)

### Phase 2: Enable and Validate

- Enable feature flag in staging
- Run parallel resolution (new + old) for 1 week, compare results
- Enable in production
- Monitor: credential resolution latency, token refresh success rate, OAuth flow completion rate

### Phase 3: Enterprise Auth Types

- Add `@node-saml/node-saml`, `@hapi/hawk`, `soap` — ideally in optional package
- `kerberos` only if Docker build pipeline supports native bindings (requires Dockerfile changes)

### Phase 4: Cleanup

- Remove legacy models (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`)
- Drop old collections
- Remove feature flag
- Remove fallback code paths
