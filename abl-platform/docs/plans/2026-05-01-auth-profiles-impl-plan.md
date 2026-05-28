# LLD: Auth Profiles — r2 Gap-Closure Implementation Plan

**Feature Spec**: [`docs/features/auth-profiles.md`](../features/auth-profiles.md) (BETA, FR-1..FR-17)
**HLD**: [`docs/specs/auth-profiles.hld.md`](../specs/auth-profiles.hld.md) (BETA, 28-code error registry, 6 §12.0 contracts)
**Test Spec**: [`docs/testing/auth-profiles.md`](../testing/auth-profiles.md) (PARTIAL, 15 E2E + 14 INT)
**Status**: DONE (implementation phases complete through 5.7; strict whole-feature acceptance checklist remains partially deferred to broader E2E/INT lanes)
**Date**: 2026-05-01
**Last Updated**: 2026-05-07
**Supersedes (for r2 scope)**: [`docs/plans/auth-profiles.lld.md`](./auth-profiles.lld.md) (DONE; FR-1..FR-8 hardening only — kept as historical context)
**Total effort**: **~29-37 engineer-days** (revised down from feature spec §13's 36-44 days after Round 8 OSS audit found `@agent-platform/auth-enterprise` already implements 5 of 6 Phase 4 protocols — see Phase 4 header note)

**Audit summary** (8 rounds; full findings in `lld-update-2026-05-01.log.md`):

- Rounds 1-5 (lld-reviewer + phase-auditor, sequential): 1 CRITICAL + 9 HIGH + 21 MEDIUM + 6 LOW — all CRITICAL/HIGH resolved.
- Round 6 (platform audit): APPROVED with 2 MEDIUM (line-citation correction in 0.2.2; `libkrb5-dev` Docker note in 4.6).
- Round 7 (industry research, training-grounded): 1 GAP (HIGH — `signRequest` closure for SigV4 region/service/credentials), 4 IMPROVEMENTs (HIGH — SSE refresh orphan handling, CSRF cookie clear after verify), 7 lower-severity additions.
- Round 8 (OSS library audit): 3 HIGH (delegate digest/hawk/kerberos to `auth-enterprise`), 2 MEDIUM (use `@smithy/signature-v4`, `rate-limiter-flexible`), 3 LOW. Net new external dependencies: zero.

All blocking findings integrated. Remaining MEDIUM/LOW items are tracked inline.

---

## Post-Implementation Notes (2026-05-06)

- Phases 0, 1.1, 1.2, 1.2.c, 1.3.a, 1.3.b, 1.3.c, 2, 3, 4, and 5 are implemented and committed.
- Final hardening after phase closure addressed workflow OAuth runtime behavior (connection-mode propagation/fallback) and Studio UX/error messaging alignment.
- Whole-feature strict acceptance remains partially deferred to broader testing-depth work:
  - exhaustive matrix E2E permutations and long-run flake lanes,
  - remaining INT scenario family completion (`INT-9`..`INT-14`) as strict acceptance evidence.
- This plan remains the canonical implementation record; deferred strict acceptance lanes are now tracked as follow-up validation work, not implementation blockers.

## Post-Implementation Incremental Notes (2026-05-07)

- Studio auth-profile verification moved to explicit/on-demand per-row actions; list surfaces no longer trigger background verification polling.
- Chip UX/readability hardening landed with a single verification chip surface and no hover-tooltip status messaging.
- OAuth callback resilience was extended with workspace state resolution route support (`/api/auth-profiles/oauth/state`) and popup fallback handoff hardening.
- OAuth2 app additional authorization parameters in Studio now use key/value row inputs (add/remove) instead of a free-form textbox.
- HTTP tool auth config validation now treats `authProfileRef` as the source of truth and suppresses redundant inline OAuth client-credential validation requirements.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                                                          | Rationale                                                                                                                | Alternatives Rejected                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| D-1  | New LLD file `docs/plans/2026-05-01-auth-profiles-impl-plan.md`; preserve `auth-profiles.lld.md` as historical    | Canonical `<date>-<slug>-impl-plan.md` naming; old LLD covers FR-1..FR-8 only and is DONE                                | Replace existing path (would lose history)                                               |
| D-2  | Preserve feature-spec P8 phasing (0 → 1 → 2-4 parallel → 5); decompose Phase 1 into sub-phases per FR             | Phase dependency chain (Phase 0 gates FR-9/11/15); commit-scope alignment (3-package limit)                              | Single-FR phases (would oversize commits); pure parallel rollout (skips Phase 0 prereqs) |
| D-3  | 7 sub-phases for FR-15 protocol handlers                                                                          | Each protocol has independent flag (FF-1), distinct file, distinct dep                                                   | Single phase (mixes concerns; cannot ship one protocol independently)                    |
| D-4  | Unit tests inside each per-FR phase; integration + E2E tests batched into Phase 5                                 | Multi-service tests can't fit in per-FR commits without exceeding 3-package commit-scope limit                           | Per-phase E2E (would require multi-package commits each phase)                           |
| D-5  | Enumerate sub-commits for FR-11, FR-13, and Phase 0 only                                                          | These are multi-package; single-FR phases delegate granularity to the implement skill                                    | Enumerate every commit (over-specifies trivial phases)                                   |
| D-6  | Three migration scripts are order-independent and can run in any order before Phase 1 deploys                     | Each touches a different collection (`mcp_server_configs`, tool configs, `auth_profiles`) — no cross-dependency          | Strict ordering (artificial constraint)                                                  |
| D-7  | `profileVersion` pre-save hook is inline in `auth-profile.model.ts` (after plugins, before indexes), not a plugin | Auth-profile-specific (~5 lines); zero reuse case; matches existing model pattern (no `profileVersionPlugin` in repo)    | Plugin-based hook (premature abstraction)                                                |
| D-8  | Pin `signRequest` signature now as `(assembled: { method, url, headers, body? }) => Promise<Headers>`             | Prevents incompatible implementations across the 6 protocol sub-phases (FR-15.1-15.6); SigV4 needs all four input fields | Defer to implementation (risk of drift between handlers)                                 |
| D-9  | Sanitizer (TE-1) is a single pure function `sanitizeAuthProfileError(err: unknown): { code, userMessage }`        | TE-1 is a mapping table, not stateful behavior; trivially unit-testable per CLAUDE.md "Test Architecture"                | Class with per-error methods (over-engineered)                                           |
| D-10 | MCP CC token cache: Redis primary + in-memory `Map` fallback only when Redis is not configured (dev-only)         | Hot swap would break dev without Redis; Redis is mandatory in prod                                                       | Hot swap (breaks dev); Map only (fails GAP-7 / CK-1)                                     |
| D-11 | Phase 0.1 consolidation is move + re-export, not rewrite                                                          | Both `apply-auth.ts` files are 327 identical lines today (`wc -l` confirms); existing test suites verify parity pre/post | Rewrite (introduces drift risk; violates D-7's "no premature abstraction" pattern)       |
| D-12 | FR-11 deploy order: 2.3a (schema + migration) → 2.3b (resolver code) → 2.3c (transport refresh) → flag flip       | 2.3b reads `envProfileId` which 2.3a creates; code stays safe behind `MCP_AUTH_PROFILE_ENABLED=false` until flag flip    | All-at-once (cannot guarantee migration ran before code reads new field)                 |
| D-13 | OAuth init-lock keyed on UUID `authProfileId` — no name-based collision possible                                  | UUIDv7 (`auth-profile.model.ts:123`) is globally unique; `op-lock` and `oauth-init-lock` use different key prefixes      | Name-based keys (rename collisions; ambiguity)                                           |
| D-14 | `REDIS_TEST_DB_INDEX` env var (default `2`) for matrix E2E + INT tests; `FLUSHDB` only against that index         | Defense against polluting prod / dev Redis; Redis supports 16 DBs by default                                             | DB index 0 (collides with dev); per-test prefixes (slower, fragile)                      |
| D-15 | `internal-tools.ts` FR-9 wiring uses `ToolBindingExecutor` **constructor option**, NOT Express middleware         | Preserves existing `InternalServiceRequest` service-token auth; INT-9 steps 1+7 are the regression test                  | Express-level middleware (would require service-token re-design)                         |

### Key Interfaces & Types

#### NEW — `signRequest` callback (FR-15)

```typescript
// packages/shared-auth-profile/src/apply-auth.ts (canonical post-Phase-0)

/**
 * Per-request signing callback. Body-mutating protocols (digest, ws_security)
 * use separate code paths in HttpToolExecutor (retry-on-401, applySoapEnvelope).
 */
export interface AssembledRequest {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
}

export interface ApplyAuthResult {
  headers: Record<string, string>;
  query?: Record<string, string>;
  tlsOptions?: { cert: string; key: string; ca?: string };
  signRequest?: (assembled: AssembledRequest) => Promise<Headers>;
}
```

#### NEW — Reserved-principal validator (RP-1)

```typescript
// packages/shared-auth-profile/src/reserved-principals.ts

/**
 * Approved system principals — `userId` values that may begin with `__`.
 * New entries require explicit registration here (RP-1 contract).
 */
export const RESERVED_PRINCIPALS = ['__tenant__'] as const;
export type ReservedPrincipal = (typeof RESERVED_PRINCIPALS)[number];

/**
 * Throws on real user creation if userId begins with `__` and is not in the
 * approved list. Idempotent for already-approved values.
 */
export function assertNotReservedPrincipal(userId: string): void;
```

#### NEW — Sanitizer (TE-1)

```typescript
// packages/shared-auth-profile/src/sanitize-error.ts

/**
 * Maps internal errors to user-safe error envelopes. Strips tenantId,
 * clientId, provider names, and IdP response bodies. Server logs retain
 * full detail; only this output is safe for user-rendered surfaces.
 */
export interface SafeError {
  code: AuthProfileErrorCode | string;
  userMessage: string;
}

export function sanitizeAuthProfileError(err: unknown): SafeError;
```

#### NEW — `auth_profiles.profileVersion` field (CK-1)

```typescript
// packages/database/src/models/auth-profile.model.ts (modification)

interface IAuthProfile {
  // ...existing fields...
  /**
   * Monotonic integer bumped on every config/secret write. Component of
   * CK-1 cache keys. Distinct from `_v` (BaseDocument schema version).
   */
  profileVersion: number;
}
```

#### NEW — `mcp_server_configs` field split (FR-11)

```typescript
// packages/database/src/models/mcp-server-config.model.ts (modification)

interface IMcpServerConfig {
  // ...existing fields...
  authProfileId?: string; // strictly auth headers (resolved via applyAuth)
  envProfileId?: string; // NEW — strictly env vars for child-process spawn
}
```

#### NEW — Vocabulary alias map (FR-16)

```typescript
// packages/shared/src/validation/auth-type-aliases.ts

/**
 * Maps inline-tool aliases (legacy) to canonical auth-profile type names.
 * Sunset deadline: v2026.07.x — CI fails on alias use after that release.
 */
export const AUTH_TYPE_ALIASES: Readonly<Record<string, string>> = {
  oauth2_client: 'oauth2_client_credentials',
  oauth2_user: 'oauth2_token',
  custom: 'custom_header',
};

export function normalizeAuthType(input: string): string;
```

#### NEW — Workflow-compatible tool filter (FR-14)

```typescript
// apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts

/**
 * GET — Returns tools whose referenced auth profile is workflow-compatible.
 * Excludes profiles with `usageMode: 'jit'` or `connectionMode: 'per_user'`.
 */
export async function GET(req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse>;
```

### Module Boundaries

| Module                                                                                                                                            | Responsibility                                                                                        | Depends On                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/shared-auth-profile/`                                                                                                                   | Canonical `applyAuth`, `signRequest` dispatch, sanitizer, reserved principals, per-protocol handlers  | `packages/shared/src/validation/auth-profile*.schema.ts`, `packages/database` model types          |
| `packages/shared-auth-profile/protocol-handlers/`                                                                                                 | One module per protocol (azure-ad, aws-iam, digest, hawk, kerberos, saml)                             | `@aws-sdk/signature-v4`, `@aws-sdk/protocol-http`, `@hapi/hawk`, `kerberos` (env-gated)            |
| `packages/shared/src/services/auth-profile/`                                                                                                      | Service-layer logic + thin re-exports of `applyAuth` from `shared-auth-profile` for one minor release | `packages/shared-auth-profile`, `packages/database`, Redis client                                  |
| `packages/shared/src/services/mcp-auth-resolver.ts`                                                                                               | MCP unified auth resolver for 12 supported types (FR-11 rewrite)                                      | `packages/shared-auth-profile/applyAuth`, Redis client (CC cache), `mcp-server-config.model.ts`    |
| `packages/database/src/models/auth-profile.model.ts`                                                                                              | Schema + `profileVersion` pre-save hook + 14 indexes                                                  | mongoose, `tenantIsolationPlugin`, `encryptionPlugin`, `auditTrailPlugin`                          |
| `packages/database/src/models/mcp-server-config.model.ts`                                                                                         | Schema with `authProfileId` + new `envProfileId` field                                                | mongoose                                                                                           |
| `packages/database/src/auth-profile/audit-events.ts`                                                                                              | Audit event constants (adds `OAUTH_FAILED`)                                                           | none                                                                                               |
| `apps/runtime/src/routes/internal-tools.ts`                                                                                                       | Internal tools route (FR-9 wires `createAuthProfileToolMiddleware` into `ToolBindingExecutor`)        | service-token auth (preserved unchanged), `ToolBindingExecutor`, `createAuthProfileToolMiddleware` |
| `apps/runtime/src/services/auth-profile-resolver.ts`                                                                                              | Runtime credential resolution (FR-10 canonical `$or` filter)                                          | `AuthProfile` model, `CredentialCache` (CK-1 keying)                                               |
| `apps/runtime/src/services/mcp/*` (existing — `inline-mcp-provider.ts`, `runtime-mcp-provider.ts`; precise file selected by implementer per OQ-6) | MCP HTTP / SSE transport with 30s pre-expiry refresh + jitter (FR-11.c)                               | `mcp-auth-resolver.ts`, `op-lock` Redis key                                                        |
| `apps/studio/src/app/api/auth-profiles/oauth/initiate/`                                                                                           | NEW workspace OAuth initiate (FR-13.B)                                                                | `auth-profile:write` permission, OAuth state service, init-lock                                    |
| `apps/studio/src/app/api/auth-profiles/oauth/callback/`                                                                                           | NEW workspace OAuth callback (FR-13.B + ST-1)                                                         | OAuth state service, sanitizer (TE-1), audit events                                                |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/`                                                                                      | EXISTING project routes — ST-1 retrofit only (FR-13.C)                                                | OAuth state service, sanitizer (TE-1), audit events                                                |
| `apps/studio/src/lib/workspace-permission.ts`                                                                                                     | Adds `auth-profile:write` and workspace-auditor role (Phase 0.2)                                      | none                                                                                               |
| `apps/studio/src/services/tool-test-service.ts`                                                                                                   | Studio Test OAuth grant resolution (FR-12)                                                            | `EndUserOAuthToken` lookup, sanitizer, `applyAuth`                                                 |
| `apps/studio/src/components/auth-profiles/`                                                                                                       | 10 new auth-type forms + tool-picker filter (FR-14)                                                   | `auth-type-metadata.ts`, `SUPPORTED_AUTH_TYPES` constant                                           |
| `tools/migrate-mcp-auth-profile-split.ts`                                                                                                         | NEW migration (Phase 1.0a — `mcp_server_configs` field split)                                         | mongoose, `mcp-server-config.model.ts`                                                             |
| `tools/migrate-auth-aliases.ts`                                                                                                                   | NEW migration (Phase 5 — vocabulary normalization)                                                    | tool definitions storage, `normalizeAuthType()`                                                    |
| `tools/migrate-profile-version-backfill.ts`                                                                                                       | NEW migration (Phase 0.4 — backfill `profileVersion=1`)                                               | mongoose, `AuthProfile` model                                                                      |
| `.claude/hooks/auth-profile-query-shape-lint.sh`                                                                                                  | NEW PreToolUse hook (FR-10)                                                                           | shell, ripgrep                                                                                     |
| `.claude/hooks/auth-type-coverage.sh`                                                                                                             | NEW pre-commit + CI drift lint (FR-17)                                                                | shell, ripgrep                                                                                     |

---

## 2. File-Level Change Map

### New Files

| File                                                                                                                                  | Purpose                                                                                                                                                         | LOC est.  |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `packages/shared-auth-profile/src/reserved-principals.ts`                                                                             | RP-1 reserved-principal validator (Phase 0.3)                                                                                                                   | ~30       |
| `packages/shared-auth-profile/src/sanitize-error.ts`                                                                                  | TE-1 centralized error sanitizer (Phase 5.6)                                                                                                                    | ~120      |
| `packages/shared-auth-profile/src/protocol-handlers/azure-ad.ts`                                                                      | `azure_ad` plain-fetch token exchange (Phase 4.1) — only NEW protocol file; rest delegate to `@agent-platform/auth-enterprise`                                  | ~80       |
| `packages/shared-auth-profile/src/protocol-handlers/aws-iam.ts`                                                                       | `aws_iam` SigV4 via `@smithy/signature-v4` (Phase 4.2) — closure capturing region/service/credentials per IR7-6                                                 | ~120      |
| `packages/shared-auth-profile/src/__tests__/reserved-principals.test.ts`                                                              | RP-1 validator unit tests                                                                                                                                       | ~80       |
| `packages/shared-auth-profile/src/__tests__/sanitize-error.test.ts`                                                                   | TE-1 sanitizer unit tests (29 codes — adds `AUTH_REFRESH_RECONNECT` per IR7-3)                                                                                  | ~210      |
| `packages/shared-auth-profile/src/__tests__/protocol-handlers/{azure-ad,aws-iam}.test.ts`                                             | Per-protocol unit tests for the 2 protocols this package owns                                                                                                   | ~120 each |
| `packages/shared-auth-profile/src/__tests__/auth-enterprise-dispatch.test.ts`                                                         | Integration test verifying digest/hawk/saml/kerberos/ws-security correctly delegate to `@agent-platform/auth-enterprise` (no re-implementation)                 | ~150      |
| `packages/shared/src/validation/auth-type-aliases.ts`                                                                                 | FR-16 normalizer + alias map (Phase 5.1)                                                                                                                        | ~40       |
| `packages/shared/src/__tests__/validation/auth-type-aliases.test.ts`                                                                  | FR-16 unit tests                                                                                                                                                | ~80       |
| `apps/studio/src/app/api/auth-profiles/oauth/initiate/route.ts`                                                                       | FR-13 workspace OAuth initiate                                                                                                                                  | ~180      |
| `apps/studio/src/app/api/auth-profiles/oauth/callback/route.ts`                                                                       | FR-13 workspace OAuth callback (ST-1 verification)                                                                                                              | ~200      |
| `apps/studio/src/app/api/auth-profiles/oauth/_oauth-state-service.ts`                                                                 | FR-13.A shared OAuth state service (extracted from project routes)                                                                                              | ~150      |
| `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts`                                                            | FR-14 workflow-compatible tool filter                                                                                                                           | ~80       |
| `apps/studio/src/components/auth-profiles/forms/{Basic,CustomHeader,Mtls,AwsIam,SshKey,Digest,Kerberos,Saml,Hawk,WsSecurity}Form.tsx` | 10 new auth-type forms (Phase 2.2)                                                                                                                              | ~80 each  |
| `apps/studio/e2e/auth-profile-workspace-oauth-wiring.spec.ts`                                                                         | E2E-WIRE-1 wiring verification                                                                                                                                  | ~150      |
| `apps/studio/e2e/tools-workflow-compatible-wiring.spec.ts`                                                                            | E2E-WIRE-2 wiring verification                                                                                                                                  | ~120      |
| `apps/runtime/src/__tests__/auth-profile-matrix.e2e.test.ts`                                                                          | FR-17 matrix E2E (17×2×3 + 12×2 + 17×2 cells)                                                                                                                   | ~600      |
| `apps/runtime/src/__tests__/integration/internal-tools-auth.test.ts`                                                                  | FR-9 INT-9 integration test                                                                                                                                     | ~250      |
| `apps/runtime/src/__tests__/integration/mcp-auth-profile.test.ts`                                                                     | FR-11 INT-12 integration test (MCP auth resolver scope + CK-1 keying)                                                                                           | ~300      |
| `apps/runtime/src/__tests__/integration/cross-tenant-isolation.test.ts`                                                               | INT-11 cross-tenant isolation suite                                                                                                                             | ~250      |
| `apps/runtime/src/__tests__/integration/audit-events-emission.test.ts`                                                                | INT-10 audit emission test (post FR-13 Phase F)                                                                                                                 | ~180      |
| `tools/migrate-mcp-auth-profile-split.ts`                                                                                             | One-time idempotent migration with `--dry-run` and `--restore`                                                                                                  | ~200      |
| `tools/migrate-auth-aliases.ts`                                                                                                       | One-time idempotent migration with `--dry-run` and `--restore`                                                                                                  | ~150      |
| `tools/migrate-profile-version-backfill.ts`                                                                                           | One-time idempotent migration with `--dry-run`                                                                                                                  | ~80       |
| `.claude/hooks/auth-profile-query-shape-lint.sh`                                                                                      | PreToolUse hook — blocks `find/findOne/findById` on `AuthProfile` outside `packages/database` without `tenantId`                                                | ~50       |
| `.claude/hooks/auth-type-coverage.sh`                                                                                                 | Pre-commit + CI drift lint — fails if `SUPPORTED_AUTH_TYPES` (= the constant the feature spec calls `AUTH_PROFILE_AUTH_TYPES`) entry is missing UI/handler/test | ~80       |

### Modified Files

| File                                                                                                                                                 | Change Description                                                                                                                                                                                                                                                                                                                                                                                                    | Risk   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/auth-profile.model.ts`                                                                                                 | Add `profileVersion: number` field (default 1) + pre-save hook (after plugins, before indexes — around line 205); update interface `IAuthProfile`                                                                                                                                                                                                                                                                     | Medium |
| `packages/database/src/models/mcp-server-config.model.ts`                                                                                            | Add `envProfileId` field; preserve `authProfileId`. No enum change to `transport`                                                                                                                                                                                                                                                                                                                                     | Medium |
| `packages/database/src/auth-profile/audit-events.ts`                                                                                                 | Add `OAUTH_FAILED: 'AUTH_PROFILE_OAUTH_FAILED'` constant                                                                                                                                                                                                                                                                                                                                                              | Low    |
| `packages/shared-auth-profile/src/apply-auth.ts`                                                                                                     | Phase 0.1 — keep canonical implementation; FR-15 — extend dispatch table with 6 new protocol handlers + add `signRequest` to `ApplyAuthResult`                                                                                                                                                                                                                                                                        | High   |
| `packages/shared-auth-profile/src/errors.ts`                                                                                                         | Extend `AuthProfileErrorCode` with 11 new codes (per HLD §7 Error Registry)                                                                                                                                                                                                                                                                                                                                           | Low    |
| `packages/shared-auth-profile/package.json`                                                                                                          | Add workspace dep: `@agent-platform/auth-enterprise` (delegates 5 of 6 protocols); add transitive deps `@smithy/signature-v4` + `@smithy/protocol-http` (already in lockfile via AWS SDK v3). NO new external deps. **Removed from earlier draft**: `@aws-sdk/signature-v4` (deprecated → use `@smithy/*`), `@hapi/hawk` (`auth-enterprise` provides), `kerberos` (lives in `auth-enterprise/package.json` if at all) | Low    |
| `packages/auth-enterprise/package.json`                                                                                                              | If not already present: add `kerberos` as `optionalDependencies` (env-gated `ENABLE_KERBEROS=true` build); document `libkrb5-dev` system-package requirement                                                                                                                                                                                                                                                          | Low    |
| `packages/shared/src/services/auth-profile/apply-auth.ts`                                                                                            | Phase 0.1 — replace body with thin re-export from `packages/shared-auth-profile`; sunset in `v2026.07.x`                                                                                                                                                                                                                                                                                                              | Low    |
| `packages/shared/src/services/auth-profile/client-credentials-service.ts`                                                                            | Adopt CK-1 cache key `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}` (today: `auth-profile:cc-token:{tenantId}:{profileId}`)                                                                                                                                                                                                                                               | Medium |
| `packages/shared/src/services/auth-profile/credential-cache.ts`                                                                                      | Update default key composition to CK-1 format                                                                                                                                                                                                                                                                                                                                                                         | Medium |
| `packages/shared/src/services/auth-profile/token-refresh-service.ts`                                                                                 | Add 0-5s jitter on 30s pre-expiry window; add 2-3 attempt exponential-backoff retry before surfacing `AUTH_REFRESH_FAILED`                                                                                                                                                                                                                                                                                            | Medium |
| `packages/shared/src/services/mcp-auth-resolver.ts`                                                                                                  | FR-11.b rewrite — 12 supported types via `applyAuth`; Redis-backed CC cache (Map fallback dev only); CK-1 keying; SSRF blocklist (GAP-19)                                                                                                                                                                                                                                                                             | High   |
| `packages/shared/src/validation/auth-profile.schema.ts`                                                                                              | Phase 1.0 — add `profileVersion` to read schema; FR-13 — accept `oauth2_token` at workspace POST                                                                                                                                                                                                                                                                                                                      | Medium |
| `packages/shared/src/validation/index.ts`                                                                                                            | Re-export `auth-type-aliases.ts` (FR-16)                                                                                                                                                                                                                                                                                                                                                                              | Low    |
| `apps/runtime/src/routes/internal-tools.ts`                                                                                                          | FR-9 — line ~170 inject `createAuthProfileToolMiddleware` into `ToolBindingExecutor` constructor options. Service-token auth path **unchanged**                                                                                                                                                                                                                                                                       | High   |
| `apps/runtime/src/services/auth-profile-resolver.ts`                                                                                                 | FR-10 — adopt canonical `{ tenantId, $or: [{ projectId: null }, { projectId }] }` filter at every call site; preserve workspace-shadowing precedence (project shadows workspace)                                                                                                                                                                                                                                      | Medium |
| `apps/runtime/src/services/auth-profile/auth-profile-cache.ts`                                                                                       | Update key composition to CK-1; emit cache-miss metrics segmented by `tenantId`                                                                                                                                                                                                                                                                                                                                       | Medium |
| `apps/runtime/src/services/mcp/*` (existing transport providers — `inline-mcp-provider.ts`, `runtime-mcp-provider.ts`; exact paths deferred to OQ-6) | FR-11.c — 30s pre-expiry refresh under `op-lock`; HTTP transport hot-swap; SSE transport close-and-reconnect; emit `mcp.auth_resolved` / `mcp.auth_refreshed` traces                                                                                                                                                                                                                                                  | High   |
| `apps/workflow-engine/src/executors/http-executor.ts`                                                                                                | FR-16 — call `normalizeAuthType()` on read path                                                                                                                                                                                                                                                                                                                                                                       | Low    |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`                                                                          | FR-15 — invoke `result.signRequest(assembled)` when present (after request assembly); FR-16 — call `normalizeAuthType()` on read path                                                                                                                                                                                                                                                                                 | Medium |
| `apps/studio/src/lib/workspace-permission.ts`                                                                                                        | Phase 0.2 — add `'auth-profile:write'` to `WORKSPACE_PERMISSIONS`; add workspace-auditor role with `'auth-profile:read'` only                                                                                                                                                                                                                                                                                         | Low    |
| `apps/studio/src/services/auth-service.ts`                                                                                                           | Phase 0.3 — call `assertNotReservedPrincipal(userId)` at user-creation paths                                                                                                                                                                                                                                                                                                                                          | Low    |
| `apps/studio/src/services/tool-test-service.ts`                                                                                                      | FR-12 — replace 500-throw at lines 719-723 with `EndUserOAuthToken` lookup + refresh + `applyAuth` integration; structured `OAUTH_REAUTH_REQUIRED` error                                                                                                                                                                                                                                                              | High   |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`                                                                        | FR-13.C retrofit — set CSRF cookie on initiate; add `csrfNonce` and `redirectUri` to ST-1 state                                                                                                                                                                                                                                                                                                                       | High   |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts`                                                                        | FR-13.C retrofit — verify `user.tenantId === state.tenantId`, CSRF cookie match, atomic Redis `GETDEL`, `redirect_uri` match; emit audit `OAUTH_INITIATED/COMPLETED/FAILED`                                                                                                                                                                                                                                           | High   |
| `apps/studio/src/app/api/auth-profiles/route.ts:215-220`                                                                                             | FR-13 — unblock `oauth2_token` at workspace POST                                                                                                                                                                                                                                                                                                                                                                      | Low    |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`                                                                                     | FR-14 — add 10 new entries; export new `SUPPORTED_AUTH_TYPES` constant; add `'textarea'` and `'record'` to `FormFieldDef.type`                                                                                                                                                                                                                                                                                        | Medium |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`                                                                                  | FR-14 — read from `SUPPORTED_AUTH_TYPES`; render appropriate form per type                                                                                                                                                                                                                                                                                                                                            | Medium |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`                                                                                | FR-13.E — accept `scope: 'project' \| 'workspace'` prop; dispatch to project vs workspace routes                                                                                                                                                                                                                                                                                                                      | Medium |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`                                                                                       | FR-17 — add `AUTH_PROFILE_TRACE_EVENT_TYPES` array containing `mcp.auth_resolved`, `mcp.auth_refreshed`, `tool_test.auth_resolved`; extend `ExtendedTraceEventType` union                                                                                                                                                                                                                                             | Low    |
| `packages/database/package.json` / `apps/runtime/package.json` / etc.                                                                                | Wire migration scripts into npm scripts where appropriate                                                                                                                                                                                                                                                                                                                                                             | Low    |

### Deleted Files

None. Phase 0.1 retains the `packages/shared/src/services/auth-profile/apply-auth.ts` re-export for one minor release; only after `v2026.07.x` does the old path get removed (out of r2 scope — tracked in feature spec OQ-1).

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable. No phase leaves the system broken. Phases 2, 3, and 4 may run in parallel after Phase 1 lands.

### Phase 0: Refactor & Prerequisites (effort: ~2.25 days)

**Goal**: Land architectural prerequisites that unblock FR-9, FR-11, FR-13, and FR-15.

#### Sub-commit 0.1 — `apply-auth.ts` consolidation (S, ~1 day, 2 packages)

**Tasks**:

0.1.1 Verify byte-equivalence of `packages/shared-auth-profile/src/apply-auth.ts` and `packages/shared/src/services/auth-profile/apply-auth.ts` (`diff` must return empty). Document the verification in commit message.
0.1.2 Replace `packages/shared/src/services/auth-profile/apply-auth.ts` body with `export * from '@agent-platform/shared-auth-profile/apply-auth';` (thin re-export).
0.1.3 Update import audit: `rg "from '@agent-platform/shared/.*apply-auth'"` lists all consumers; leave imports unchanged for the re-export window.
0.1.4 Add a JSDoc `@deprecated — use @agent-platform/shared-auth-profile (sunset v2026.07.x)` to the re-export.
0.1.5 Run `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/shared-auth-profile`.

**Files Touched**:

- `packages/shared-auth-profile/src/apply-auth.ts` — unchanged content; canonical
- `packages/shared/src/services/auth-profile/apply-auth.ts` — replace body with re-export
- `packages/shared/src/services/auth-profile/index.ts` — confirm re-export still exists at the package barrel (no behavior change)

**Exit Criteria**:

- [ ] `diff packages/shared-auth-profile/src/apply-auth.ts packages/shared/src/services/auth-profile/apply-auth.ts.bak` produces zero output before edit (proves byte-equivalence)
- [ ] `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/shared-auth-profile` succeeds with 0 errors
- [ ] `pnpm test --filter=@agent-platform/shared` continues to pass for `apply-auth` test suite
- [ ] `rg "import.*apply-auth"` shows no consumers broke

**Test Strategy**:

- Unit: existing `apply-auth.test.ts` suites in both packages pass unchanged (parity)
- Integration: none new this sub-commit

**Rollback**: `git revert <sha>` — content unchanged in canonical path; only the re-export shim is reverted

#### Sub-commit 0.2 — RBAC: `auth-profile:write` + workspace-auditor role (S, ~0.5 day, 2 packages)

**Tasks**:

0.2.1 Add `AUTH_PROFILE_WRITE: 'auth-profile:write'` and `AUTH_PROFILE_READ: 'auth-profile:read'` properties to the `WORKSPACE_PERMISSIONS` `as const` object at `apps/studio/src/lib/workspace-permission.ts:12-17` (it is an object, not an array).
0.2.2 Add `workspace-auditor` role as a new top-level key in `TENANT_ROLE_PERMISSIONS` at `packages/shared-auth/src/rbac/role-permissions.ts` (the role-permissions object is the source of truth for RBAC enforcement; `PROJECT_PERMISSION_CATEGORIES` around line 361 is a UI display table only — implementer should locate the actual `TENANT_ROLE_PERMISSIONS` block via `rg "TENANT_ROLE_PERMISSIONS"`). Grant `['auth-profile:read']` to workspace-auditor only (NOT write, NOT initiate). Update OWNER role to include `'auth-profile:write'` if not already present. ADMIN role disposition: grant `'auth-profile:write'` (matches existing tenant-scoped admin semantics for credential management); if a customer policy requires OWNER-only, document the override in this commit's message.
0.2.3 Update permission resolver tests for new role.
0.2.4 Run `pnpm build --filter=apps/studio --filter=@agent-platform/shared-auth`.

**Files Touched**:

- `apps/studio/src/lib/workspace-permission.ts` — add permission constant
- `packages/shared-auth/src/rbac/role-permissions.ts` — add role (line 361 already has the permission string in `TENANT_ROLE_PERMISSIONS` per feature-spec C4)
- `packages/shared-auth/src/__tests__/rbac/role-permissions.test.ts` — assert auditor role's permission set

**Exit Criteria**:

- [ ] `WORKSPACE_PERMISSIONS` `as const` object contains `AUTH_PROFILE_WRITE: 'auth-profile:write'` and `AUTH_PROFILE_READ: 'auth-profile:read'`
- [ ] `workspace-auditor` role added as a key in `TENANT_ROLE_PERMISSIONS` with `['auth-profile:read']` only
- [ ] OWNER role granted `auth-profile:write`; ADMIN role disposition decided per OQ — current plan: ADMIN gains `auth-profile:write` to match existing tenant-scoped admin semantics; if OWNER-only desired, document and remove from ADMIN
- [ ] RBAC: `auth-profile:write` added to `WORKSPACE_PERMISSIONS` and `auth-profile:read` to `workspace-auditor` role; verified by unit test importing the constants and asserting their presence. Full route-level enforcement (project-OWNER without workspace `auth-profile:write` returns 403 on workspace OAuth initiate) verified in Phase 3.B as part of INT-10 (OAuth audit emission test exercises the same auth chain)
- [ ] `pnpm build --filter=apps/studio --filter=@agent-platform/shared-auth` succeeds with 0 errors

**Test Strategy**:

- Unit: new role-permissions tests
- Integration: blocked behind FR-13 (Phase 3)

**Rollback**: `git revert <sha>` — purely additive; no consumers reference the new permission yet

#### Sub-commit 0.3 — Reserved-principal validator (RP-1) (XS, ~0.25 day, 2 packages)

**Tasks**:

0.3.1 Create `packages/shared-auth-profile/src/reserved-principals.ts` with `RESERVED_PRINCIPALS = ['__tenant__'] as const` and `assertNotReservedPrincipal(userId)`.
0.3.2 Wire `assertNotReservedPrincipal()` into `apps/studio/src/services/auth-service.ts` user-creation path (single call site at user create).
0.3.3 Add unit tests at `packages/shared-auth-profile/src/__tests__/reserved-principals.test.ts` (4 cases: real userId passes, `__tenant__` real-user creation rejects, `__future_principal` rejects, empty input rejects).
0.3.4 Run `pnpm build --filter=@agent-platform/shared-auth-profile --filter=apps/studio`.

**Files Touched**:

- `packages/shared-auth-profile/src/reserved-principals.ts` — NEW
- `packages/shared-auth-profile/src/index.ts` — re-export
- `packages/shared-auth-profile/src/__tests__/reserved-principals.test.ts` — NEW
- `apps/studio/src/services/auth-service.ts` — invoke validator at user create

**Exit Criteria**:

- [ ] `assertNotReservedPrincipal('__tenant__')` throws `AUTH_RESERVED_PRINCIPAL` for real-user creation
- [ ] `assertNotReservedPrincipal('user-uuid-v7')` returns `void` (no throw)
- [ ] All 4 unit tests pass
- [ ] `pnpm build` succeeds with 0 errors

**Test Strategy**:

- Unit: pure-function tests, zero mocks
- Integration: deferred (covered by INT-11 cross-tenant isolation in Phase 5)

**Rollback**: `git revert <sha>` — purely additive

#### Sub-commit 0.4 — `profileVersion` field + pre-save hook + backfill (S, ~0.5 day, 2 packages)

**Tasks**:

0.4.1 Add `profileVersion: { type: Number, default: 1 }` to `AuthProfileSchema` at `packages/database/src/models/auth-profile.model.ts` (after existing fields, before `_v`).
0.4.2 Add inline pre-save hook via `AuthProfileSchema.pre('save', function(next) { ... })` (NOT a `.plugin()`) after the plugins block (line ~205) and before the indexes block. The hook increments `profileVersion` when `config` or `encryptedSecrets` is modified: `if (this.isModified('config') || this.isModified('encryptedSecrets')) { this.profileVersion = (this.profileVersion ?? 1) + 1; } next();`
0.4.3 Update `IAuthProfile` interface with `profileVersion: number`.
0.4.4 Create `tools/migrate-profile-version-backfill.ts` (idempotent: `updateMany({ profileVersion: { $exists: false } }, { $set: { profileVersion: 1 } })`).
0.4.5 Add `--dry-run` flag (counts affected docs without updating).
0.4.6 Add unit test verifying `profileVersion` increments on `config` mutation but NOT on `lastUsedAt` mutation.

**Files Touched**:

- `packages/database/src/models/auth-profile.model.ts` — schema field + interface + pre-save hook
- `packages/database/src/__tests__/auth-profile/auth-profile-model.test.ts` — pre-save hook test
- `tools/migrate-profile-version-backfill.ts` — NEW

**Exit Criteria**:

- [ ] `profileVersion` field exists on schema with default `1`
- [ ] Pre-save hook increments only on `config` or `encryptedSecrets` modifications (verified by 4 test cases: create / config mutate / secret mutate / lastUsedAt mutate)
- [ ] `tools/migrate-profile-version-backfill.ts --dry-run` reports backfill candidate count without writing
- [ ] `pnpm build --filter=@agent-platform/database` succeeds with 0 errors

**Test Strategy**:

- Unit: pre-save hook behavior; backfill script (in-memory mongo)
- Integration: deferred (covered by INT-12 in Phase 5)

**Rollback**: Drop `profileVersion` field — but only after Phase 1 cache-key changes are reverted (which depend on it); document this dependency in the commit message

---

### Phase 1: Workflow + Tenant Scope + MCP (effort: ~7-8 days)

**Goal**: Wire FR-9, FR-10, and FR-11 (3 sub-commits per CLAUDE.md commit-scope guard).

#### Phase 1.1 — FR-9 Workflow `tool_call` middleware wiring (S, ~1.5 days, 1 package)

**Tasks**:

1.1.1 **Confirmed location**: `ToolBindingExecutor` lives at `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` (NOT `apps/runtime/src/tools/`), exported via `@abl/compiler`. The constructor option `middleware?: ToolMiddleware[]` already exists at `ToolBindingExecutorConfig:88` — **no constructor extension needed**, just pass the middleware array.
1.1.2 At `apps/runtime/src/routes/internal-tools.ts:170-178`, build `[createAuthProfileToolMiddleware({ tenantId: req.serviceToken.tenantId, projectId: req.serviceToken.projectId, environment: req.body.environment })]` and pass it as the `middleware` option to the existing `ToolBindingExecutor` constructor invocation.
1.1.3 Behavior gates on `WORKFLOW_AUTH_PROFILE_ENABLED` env var (default `true`); when `false`, middleware is not injected (legacy unauth behavior).
1.1.4 Reject profiles with `connectionMode: 'per_user'` at runtime resolution with `AUTH_PROFILE_PER_USER_IN_WORKFLOW`.
1.1.5 Reject `usageMode: 'jit'` tools with `JIT_AUTH_NOT_SUPPORTED` (workflow has no `sendAuthChallenge` callback).
1.1.6 Studio create-time block — reject `connectionMode: 'per_user'` profile reference in workflow `tool_call` step at workflow validation. Implementer locates the workflow step validation point first (likely in `apps/studio/src/components/workflows/` form validators or an `apps/studio/src/lib/workflow-*.ts` module — confirm via `rg`); add the rejection there. If no Studio-side validation exists, fall back to the runtime middleware reject (already covered by 1.1.4).
1.1.7 Unit tests for the constructor injection: middleware called with correct context; tools without `auth_profile_ref` are no-op.
1.1.8 Run `pnpm build --filter=apps/runtime`.

**Files Touched**:

- `apps/runtime/src/routes/internal-tools.ts` — pass middleware array to existing `ToolBindingExecutor` constructor option (NOT Express middleware)
- `apps/runtime/src/__tests__/auth/internal-tools-auth-middleware.test.ts` — NEW unit test
- (no constructor extension; `ToolBindingExecutor` already accepts `middleware?: ToolMiddleware[]` at `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:88` — verified)
- (no UI change in this sub-commit)

**Exit Criteria**:

- [ ] Tools with `auth_profile_ref` invoked from workflow `tool_call` resolve auth via middleware
- [ ] Tools without `auth_profile_ref` continue to work unchanged (regression-free service-token auth)
- [ ] `WORKFLOW_AUTH_PROFILE_ENABLED=false` fully restores legacy unauth behavior (verified in INT-9 step 7 in Phase 5)
- [ ] `connectionMode: 'per_user'` profile rejected with `AUTH_PROFILE_PER_USER_IN_WORKFLOW`
- [ ] `usageMode: 'jit'` profile rejected with `JIT_AUTH_NOT_SUPPORTED`
- [ ] `pnpm build --filter=apps/runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: middleware injection, error code dispatch (in-phase)
- Integration: INT-9 (Phase 5) — full end-to-end through workflow-engine
- E2E: E2E-6 (Phase 5)

**Rollback**: Set `WORKFLOW_AUTH_PROFILE_ENABLED=false` (fully restores legacy); revert commit if needed

#### Phase 1.2 — FR-10 Tenant-scope `$or` filter + lint hook (XS, ~0.5 day, 3 packages + hooks)

**Tasks**:

1.2.1 Audit every call site of `AuthProfile.findOne|find|findById` outside `packages/database/`: `rg "AuthProfile\.(findOne|find|findById)"`.
1.2.2 Update each **name-based** runtime resolution call site to apply `{ tenantId, $or: [{ projectId: null }, { projectId }] }`. ID-based lookups (`findOne({ _id, tenantId })`) and project-scoped CRUD list/update/delete operations preserve their existing `tenantId`-only or `tenantId + projectId` filters — the `$or` rewrite is for name-based resolution only (workspace fallback semantics).
1.2.2b **Update `AuthProfileCache.key()` signature** (`apps/runtime/src/services/auth-profile/auth-profile-cache.ts`): today the key method takes `(tenantId, profileId, environment)`. CK-1 requires `(tenantId, authType, profileId, profileVersion, scopeHash, principalKind?, principalId?)`. Rewrite the signature, update every call site (resolver + cache invalidation hooks), and add a unit test for the new key format.
1.2.3 Verify project-scoped profiles shadow workspace profiles (in resolver service: prefer `projectId === req.projectId` rows over `projectId === null` rows when both have the same name).
1.2.4 Create `.claude/hooks/auth-profile-query-shape-lint.sh` — fails when grep matches `AuthProfile.(findOne|find|findById)\(` outside `packages/database/` AND the next 3 lines do not contain `tenantId`.
1.2.5 Wire the hook into `.claude/settings.json` PreToolUse for `Edit|Write` of `.ts` files.
1.2.6 Mirror the lint as a CI step (so `--no-verify` cannot bypass).

**Files Touched** (3 packages — `apps/runtime`, `apps/search-ai`, `packages/project-io` — within commit-scope guard):

- `apps/runtime/src/services/auth-profile-resolver.ts` — adopt canonical filter
- `apps/runtime/src/services/auth-profile/auth-profile-cache.ts` — rewrite `key()` to CK-1 format per task 1.2.2b
- `apps/search-ai/src/services/auth-profile-resolver.ts` — adopt canonical filter
- `packages/project-io/src/import/auth-profile-resolver.ts` — adopt canonical filter
- `.claude/hooks/auth-profile-query-shape-lint.sh` — NEW
- `.claude/settings.json` — register hook
- (CI mirror in `.github/workflows/lint.yml` or equivalent)

#### Phase 1.2.c — `resolveClientCredentialsToken` signature expansion to CK-1 (XS, ~0.25 day, 1 package; pre-req for Phase 1.3.b and Phase 4.1)

**Tasks**:

1.2.c.1 Expand `resolveClientCredentialsToken()` at `packages/shared/src/services/auth-profile/client-credentials-service.ts:111-119` to accept a `profileVersion: number` parameter (positional, after `tenantId`). Compute `scopeHash = sha256(scopes.sort().join(','))`.
1.2.c.2 Rewrite the cache key from `${CACHE_PREFIX}${tenantId}:${profileId}` to CK-1 format `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}`.
1.2.c.3 Update every call site of `resolveClientCredentialsToken()` to pass `profileVersion` from the resolved auth profile.
1.2.c.4 Unit tests: signature change; cache key match; cache invalidation on `profileVersion` bump.

**Files Touched**: `packages/shared/src/services/auth-profile/client-credentials-service.ts`, `packages/shared/src/__tests__/auth-profile/client-credentials-service.test.ts`, every call site identified by `rg "resolveClientCredentialsToken\("`.

**Exit Criteria**:

- [ ] Signature accepts `profileVersion`
- [ ] Cache key matches CK-1 format byte-for-byte
- [ ] Bumping `profileVersion` invalidates the cache (verified test)
- [ ] All call sites updated; `pnpm build` succeeds with 0 errors

**Test Strategy**: Unit tests for new signature + cache key.

**Rollback**: Revert; Phase 1.3.b and Phase 4.1 cannot land without this — they depend on the expanded signature.

**Exit Criteria**:

- [ ] `rg "AuthProfile\.(findOne|find|findById)" --files-without-match -- pattern_for_tenantId` returns zero results outside `packages/database/`
- [ ] Lint hook blocks a deliberate test edit (PRE-commit reject demonstration)
- [ ] CI step blocks a `--no-verify`-pushed change with the same shape
- [ ] Workspace profile resolves from project workflow (asserted in INT-9 step 2 + INT-2 in Phase 5)
- [ ] Project profile shadows workspace profile of same name (asserted in INT-2 in Phase 5)

**Test Strategy**:

- Unit: resolver tests for the `$or` filter + shadowing precedence
- Integration: deferred to Phase 5

**Rollback**: `git revert <sha>` — call sites revert to pre-FR-10 filter; lint hook removal is independent

#### Phase 1.3 — FR-11 MCP unified auth (M, ~4-5 days, 3 sub-commits per CLAUDE.md)

**Sub-commit 1.3.a — Database split + migration (S, ~1.5 days, 1 package)**

**Tasks**:

1.3.a.1 Add `envProfileId?: string` field to `mcp_server_configs` schema at `packages/database/src/models/mcp-server-config.model.ts`.
1.3.a.2 Update `IMcpServerConfig` interface.
1.3.a.3 Create `tools/migrate-mcp-auth-profile-split.ts`: for each row where `authProfileId` resolves to a profile of type "env-only" (heuristic: dual-read consumer of env vars only — verified by inspecting `apps/runtime/src/mcp/*` consumer logic), copy `authProfileId` → `envProfileId` and clear `authProfileId`.
1.3.a.4 Add `--dry-run`, `--restore` (re-merges `envProfileId` rows back into `authProfileId`), and a `--limit N` flag for batched runs.
1.3.a.5 Unit tests: schema field present; migration script idempotency (run twice — second run reports zero changes).
1.3.a.6 Run `pnpm build --filter=@agent-platform/database`.

**Files Touched**: `packages/database/src/models/mcp-server-config.model.ts`, `tools/migrate-mcp-auth-profile-split.ts`, `packages/database/src/__tests__/mcp-server-config-split.test.ts`

**Exit Criteria**:

- [ ] `envProfileId` field exists; backward-compat (null default)
- [ ] `tools/migrate-mcp-auth-profile-split.ts --dry-run` reports affected row count
- [ ] Idempotency test passes (second run = zero updates)
- [ ] `--restore` reverses the migration on a test fixture

**Sub-commit 1.3.b — Resolver rewrite + Redis CC cache (M, ~2 days, 2 packages)**

**Tasks**:

1.3.b.1 Rewrite `packages/shared/src/services/mcp-auth-resolver.ts` to dispatch via `applyAuth()` for 12 supported types (`none`, `api_key`, `bearer`, `basic`, `custom_header`, `oauth2_app`, `oauth2_token`, `oauth2_client_credentials`, `azure_ad`, `saml`, `kerberos`, `mtls`).
1.3.b.2 Reject 5 incompatible types at write time (`aws_iam`, `digest`, `hawk`, `ssh_key`, `ws_security`) with `AUTH_TYPE_NOT_MCP_COMPATIBLE`.
1.3.b.3 `mtls` on `transport: 'sse'` rejects with `MCP_TRANSPORT_NOT_TLS_CAPABLE`.
1.3.b.4 Replace in-memory `Map<profileId, token>` (current line 34) with Redis-backed cache. Cache key per CK-1: `auth-token:{tenantId}:oauth2_client_credentials:{profileId}:{profileVersion}:{scopeHash}`. TTL `min(token.expires_in - 60s, 3600s)`. **Change `resolveAuthHeaders` `tenantId` parameter from optional (`tenantId?: string`) to required (`tenantId: string`)** — TI-1 contract mandates `tenantId` for every cache key; the `'unknown'` fallback at line 46 of the current resolver violates TI-1 and must be removed.
1.3.b.5 Map fallback only when Redis is not configured (env var `REDIS_URL` is empty); log warning on fallback.
1.3.b.6 SSRF protection (GAP-19): call the **existing** `assertUrlSafeForSSRF()` from `@agent-platform/shared-kernel/security` (`packages/shared-kernel/src/security/ssrf-validator.ts`) before fetch. This utility already covers RFC 1918, link-local, loopback, and cloud metadata IPs and is already used by `client-credentials-service.ts:36` and Studio OAuth routes — do NOT reinvent it.
1.3.b.7 `auth_profile.updated` post-save hook invalidates the affected cache key.
1.3.b.8 Per-`{tenantId, profileId}` rate limiter on outbound token-exchange (GAP-22 mitigation). **Use `rate-limiter-flexible`** (already in lockfile per Round 8 audit; consumed by `apps/multimodal-service`) — `RateLimiterRedis` provides Redis-backed sliding window out of the box. Do NOT build a custom Redis sliding-window implementation. Key pattern: `auth-profile:rl:{tenantId}:{profileId}`. Window: 60s. Default cap: 30 requests/minute, **configurable via `AUTH_PROFILE_RATE_LIMIT_PER_MINUTE` env var** (per IR7-2 — operators can raise the limit when they have provider quota allowance). On limit reached: throw `AUTH_TOKEN_RATE_LIMITED` (HTTP 429) with sanitized message; consumer logs the throttle event but does not retry without backoff.
1.3.b.9 Unit tests: 12 type dispatches; 5 type rejections; cache hit/miss/invalidation; SSRF block; rate-limiter throttle.
1.3.b.10 Run `pnpm build --filter=@agent-platform/shared --filter=@agent-platform/shared-auth-profile`.

**Files Touched**: `packages/shared/src/services/mcp-auth-resolver.ts` (rewrite), `packages/shared-auth-profile/src/apply-auth.ts` (Phase 0.1 already done), `packages/shared/src/__tests__/services/mcp-auth-resolver.test.ts` (NEW)

**Exit Criteria**:

- [ ] 12 of 17 types resolve via `applyAuth`
- [ ] 5 types reject at write with the canonical error codes
- [ ] CC cache key matches CK-1 format byte-for-byte
- [ ] Map fallback engages only when `REDIS_URL` is empty (test by toggling env)
- [ ] SSRF blocklist rejects `http://169.254.169.254/` and `http://10.0.0.1/`
- [ ] Rate limiter caps outbound requests at threshold per `{tenantId, profileId}`

**Sub-commit 1.3.c — Transport refresh + reconnect + traces (S, ~1.5 days, 1 package)**

**Tasks**:

1.3.c.1 In MCP transport (HTTP variant): emit pre-expiry refresh request when token is within 30s of expiry + `0-5s` random jitter (GAP-24).
1.3.c.2 Acquire `auth-profile:op-lock:{tenantId}:{resourceId}` (existing key) before refresh.
1.3.c.3 Hot-swap `Authorization` header for new requests on success; in-flight requests use the previous token until they complete.
1.3.c.4 On refresh failure: close transport with `AUTH_REFRESH_FAILED`; next tool call drives reconnect.
1.3.c.5 SSE variant: cannot hot-swap mid-stream — close stream and let next tool call reconnect with new token. **In-flight tool-call handling (IR7-3 mitigation)**: when the SSE stream is closed for refresh, any tool calls awaiting a response get an error envelope with `code: AUTH_REFRESH_RECONNECT` and a deterministic `reconnectAfterMs` hint. The tool dispatcher preserves the original `sessionId` so the next reconnection picks up the conversation context; without preservation, in-flight calls become orphaned. The `AUTH_REFRESH_RECONNECT` code is distinct from `AUTH_REFRESH_FAILED` (latter = exhausted retries; former = expected refresh-cycle reconnect). Add `AUTH_REFRESH_RECONNECT` to the §7 Error Code Registry as part of this phase's commit.
1.3.c.6 Emit `mcp.auth_resolved` (per-connection on resolution) and `mcp.auth_refreshed` (on 30s pre-expiry refresh) traces via canonical TraceStore.
1.3.c.7 Concurrent waiters during refresh use the still-valid (not-yet-expired) token (no blocking).
1.3.c.8 Profile mutation cascade: `auth_profile.updated` post-save bumps `profileVersion`, invalidating the cached header for the next resolution call.
1.3.c.9 Unit tests for hot-swap mechanics (HTTP) + close-on-refresh (SSE).
1.3.c.10 Run `pnpm build --filter=apps/runtime`.

**Files Touched**: `apps/runtime/src/services/mcp/*` (existing transport providers — `inline-mcp-provider.ts`, `runtime-mcp-provider.ts`; exact paths to be confirmed by implementer per OQ-6), `packages/shared-kernel/src/constants/trace-event-registry.ts` (add `AUTH_PROFILE_TRACE_EVENT_TYPES` array with 3 new event types), `apps/runtime/src/__tests__/mcp/*-transport.test.ts`

**Exit Criteria**:

- [ ] HTTP transport hot-swaps header on refresh; in-flight requests succeed
- [ ] SSE transport closes on refresh; next tool call reconnects
- [ ] `AUTH_REFRESH_FAILED` surfaces on retries-exhausted refresh
- [ ] `mcp.auth_resolved` and `mcp.auth_refreshed` traces emit (verified by INT-12 in Phase 5)
- [ ] `pnpm build --filter=apps/runtime` succeeds with 0 errors

**Phase 1.3 Test Strategy**:

- Unit: per-sub-commit (in-phase)
- Integration: `apps/runtime/src/__tests__/integration/mcp-auth-profile.test.ts` (Phase 5 batch)
- E2E: E2E-8 (Phase 5)

**Rollback**: `MCP_AUTH_PROFILE_ENABLED=false` restores legacy 5-type resolver; revert sub-commits in reverse order (1.3.c → 1.3.b → 1.3.a + run `--restore` migration)

---

### Phase 2: Studio UX (effort: ~6-7 days; parallelizable with Phase 3 and Phase 4 after Phase 1 lands)

**Goal**: FR-12 Studio Test OAuth grant resolution + FR-14 Studio UI for 10 currently API-only auth types.

#### Phase 2.1 — FR-12 Studio Test OAuth grant resolution (S, ~2 days, 1 package)

**Tasks**:

2.1.1 Replace 500-throw at `apps/studio/src/services/tool-test-service.ts:719-723` with `EndUserOAuthToken` lookup: `findOne({ tenantId, provider: 'auth-profile:{appProfileId}', userId })`.
2.1.2 If grant expired: refresh under existing `op-lock` distributed lock; if refresh fails, return `OAUTH_REAUTH_REQUIRED` (sanitized per TE-1 — Phase 5.6 dependency, but emit raw code now and route through sanitizer when it lands).
2.1.3 If grant missing: return `OAUTH_REAUTH_REQUIRED` directly.
2.1.4 Tenant-shared (`__tenant__`) fallback only when `connectionMode === 'shared'`. Profiles with `connectionMode === 'per_user'` MUST NOT fall back.
2.1.5 Feed access token to `applyAuth` and return result.
2.1.6 Studio Test panel UI: dispatch on `OAUTH_REAUTH_REQUIRED` → render "Reconnect Profile" CTA opening `AuthProfileOAuthDialog` with appropriate `scope` prop.
2.1.7 Behavior gates on `STUDIO_TEST_OAUTH_GRANT_ENABLED` (default `true`); when `false`, restore the 500 throw.
2.1.8 No access tokens, refresh tokens, or other secret material in any log line (TE-1 contract).
2.1.9 Unit test: `tool-test-service.ts` logic across (valid grant, expired+refresh, missing grant, refresh-fails) cases.
2.1.10 Run `pnpm build --filter=apps/studio`.

**Files Touched**:

- `apps/studio/src/services/tool-test-service.ts` — replace 500 throw with grant resolution
- `apps/studio/src/components/test-panel/*` — Reconnect CTA wiring (existing component path TBD; implementer reads first)
- `apps/studio/src/__tests__/services/tool-test-service-oauth.test.ts` — NEW

**Exit Criteria**:

- [ ] Studio Test with valid `oauth2_app`/`oauth2_token` grant succeeds (no 500)
- [ ] Expired grant → refresh succeeds → tool runs
- [ ] Missing grant → `OAUTH_REAUTH_REQUIRED` returned; no 500
- [ ] `connectionMode: 'per_user'` does NOT fall back to `__tenant__` grant
- [ ] No tokens in any log line (verified by manual `rg` audit of logs in test run)
- [ ] `STUDIO_TEST_OAUTH_GRANT_ENABLED=false` restores 500 throw

**Test Strategy**:

- Unit: tool-test-service unit tests; UI dispatch tests
- E2E: E2E-7 (Phase 5)

**Rollback**: `STUDIO_TEST_OAUTH_GRANT_ENABLED=false`

#### Phase 2.2 — FR-14 Studio UI for 10 auth types + workflow-compatible filter (M, ~4-5 days, 1 package)

**Tasks**:

2.2.1 Add 10 entries to `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` (one per: `basic`, `custom_header`, `mtls`, `aws_iam`, `ssh_key`, `digest`, `kerberos`, `saml`, `hawk`, `ws_security`).
2.2.2 Export new `SUPPORTED_AUTH_TYPES` constant covering Phase 1 + Phase 2/3 types.
2.2.3 Update `AuthProfileSlideOver.tsx` dropdown to read from `SUPPORTED_AUTH_TYPES`.
2.2.4 Add `'textarea'` (cert/key paste) and `'record'` (key-value pairs) to `FormFieldDef.type`.
2.2.5 Create per-type form components in `components/auth-profiles/forms/{Basic,CustomHeader,...}Form.tsx`. Each derives field shapes from the existing Zod schema (`auth-profile-phase2.schema.ts` / `auth-profile-phase3.schema.ts`).
2.2.6 Tag `kerberos`, `saml`, `ssh_key` forms as SHOULD/deferrable per oracle decision and feature spec OQ-7. If deferred, leave dropdown entries but render an "API-only" notice; runtime FR-15 handlers still ship.
2.2.7 Create `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts` returning tools whose referenced auth profile has neither `usageMode: 'jit'` nor `connectionMode: 'per_user'`. **Scoping (per CLAUDE.md "Studio Route Handler Gotchas")**: every Mongo query in this handler MUST include `{ projectId: params.id, tenantId: user.tenantId }` explicitly — Studio Next.js routes have no AsyncLocalStorage tenant injection.
2.2.8 Wire the route into the workflow-author tool picker UI.
2.2.9 Behavior gates on `AUTH_PROFILE_PHASE_2_3_UI` (default `false → true`).
2.2.10 Unit tests: `auth-type-metadata` snapshot test; per-form validation; `tools/workflow-compatible` filter logic.
2.2.11 Studio Lint compliance: no native `<select>` (use `<Select>`); no `bg-accent text-foreground`; design-token enforcement.

**Files Touched**:

- `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` — 10 new entries + `SUPPORTED_AUTH_TYPES`
- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — dropdown source
- `apps/studio/src/components/auth-profiles/forms/*.tsx` — 10 NEW form components (or 7 if kerberos/saml/ssh_key deferred)
- `apps/studio/src/types/form-field.ts` — add `'textarea'`, `'record'` types
- `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts` — NEW
- `apps/studio/src/components/workflows/tool-picker.tsx` — call the new route
- `apps/studio/src/__tests__/components/auth-profiles/auth-type-metadata.test.ts` — NEW snapshot test
- `apps/studio/src/__tests__/api-routes/projects/tools-workflow-compatible.test.ts` — NEW

**Exit Criteria**:

- [ ] All 10 auth types creatable through Studio (or 7 if kerberos/saml/ssh_key deferred per OQ-7)
- [ ] Round-trip API GET returns persisted config matching submitted form
- [ ] `tools/workflow-compatible` filter excludes `usageMode: 'jit'` and `connectionMode: 'per_user'`
- [ ] No native `<select>` elements (verified by `.claude/hooks/native-select-lint.sh`)
- [ ] No `bg-accent text-foreground` (verified by `.claude/hooks/accent-foreground-lint.sh`)
- [ ] `AUTH_PROFILE_PHASE_2_3_UI=false` reverts dropdown to current 7 entries

**Test Strategy**:

- Unit: per-form, snapshot, filter route
- E2E: E2E-WIRE-2 (Phase 5)

**Rollback**: `AUTH_PROFILE_PHASE_2_3_UI=false`

---

### Phase 3: Workspace OAuth (effort: ~6 days; parallelizable with Phase 2 and Phase 4 after Phase 1 lands)

**Goal**: FR-13 — workspace-level OAuth flows for non-integration profiles + ST-1 retrofit on existing project routes.

#### Phase 3.A — Refactor existing project routes into shared services (S, ~1 day, 1 package, NO BEHAVIOR CHANGE)

**Tasks**:

3.A.1 Extract OAuth state logic from `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts` into `apps/studio/src/app/api/auth-profiles/oauth/_oauth-state-service.ts` as **two pure functions** (NOT a class):

```typescript
export async function createOAuthState(
  redis: RedisClient,
  payload: {
    tenantId: string;
    projectId: string | null;
    userId: string;
    authProfileId: string;
    scope: 'project' | 'workspace';
    codeVerifier?: string;
    redirectUri: string;
  },
): Promise<{ state: string; csrfNonce: string }>;

export async function consumeOAuthState(
  redis: RedisClient,
  state: string,
): Promise<OAuthStatePayload | null>; // null when GETDEL returns no value (replay or expired)
```

3.A.2 Extract callback verification logic similarly into pure helpers (e.g., `verifyTenantBinding`, `verifyCsrfNonce`, `verifyRedirectUri`) that throw structured `AuthProfileError` codes on mismatch.
3.A.3 Existing project routes consume the new shared service; behavior is unchanged.
3.A.4 Run `pnpm build --filter=apps/studio` and existing OAuth route tests.

**Exit Criteria**:

- [ ] Existing OAuth route tests pass unchanged (parity)
- [ ] `_oauth-state-service.ts` exists; project routes import from it
- [ ] No behavior change confirmed by `pnpm test --filter=apps/studio` against existing OAuth tests

#### Phase 3.B — New workspace OAuth routes + RBAC + JIT/preflight rejection + init lock (M, ~2 days, 1 package)

**Tasks**:

3.B.1 Create `apps/studio/src/app/api/auth-profiles/oauth/initiate/route.ts`: requires `auth-profile:write` workspace permission; rejects `connector` populated (Integrations tab redirect); rejects `usageMode: 'jit' | 'preflight'`.
3.B.2 Create `apps/studio/src/app/api/auth-profiles/oauth/callback/route.ts`.
3.B.3 Acquire `auth-profile:oauth-init-lock:{tenantId}:{authProfileId}` Redis lock with TTL 600s on initiate; second initiator returns `OAUTH_FLOW_IN_PROGRESS` (HTTP 409).
3.B.4 Workspace POST validator at `apps/studio/src/app/api/auth-profiles/route.ts:215-220` — accept `oauth2_token` (currently blocked).
3.B.5 Unit tests: RBAC denial (workspace-auditor 403); init-lock 409; JIT/preflight rejection.
3.B.6 Behavior gates on `WORKSPACE_OAUTH_ENABLED` (default `false → true`).

**Exit Criteria**:

- [ ] New routes exist and are reachable through full Next.js middleware chain
- [ ] RBAC: `auth-profile:write` enforced; auditor returns 403 on initiate
- [ ] Init-lock 409 on concurrent initiation within 600s window
- [ ] `oauth2_token` accepted at workspace POST (today blocked)

#### Phase 3.C — ST-1 state contract retrofit on BOTH workspace AND project routes (M, ~1.5 days, 1 package)

**Tasks**:

3.C.1 New routes (workspace) and existing project routes both populate ST-1 state payload: `{ tenantId, projectId | null, userId, authProfileId, scope, csrfNonce, codeVerifier?, redirectUri }`.
3.C.1b **Modify existing project initiate route** (`apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/initiate/route.ts`): generate `csrfNonce`, set it as `HttpOnly`/`SameSite=Lax`/`Secure` same-origin cookie, and include it in the state payload. The existing project initiate route does NOT set this cookie today — adding it is the ST-1 retrofit gap.
3.C.2 Initiate sets `csrfNonce` as same-origin cookie (HttpOnly, SameSite=Lax, Secure) on BOTH project and workspace routes.
3.C.3 Callback verification (in this exact order):

- Atomic Redis `GETDEL` retrieves the payload (replay protection)
- Verify `user.tenantId === state.tenantId` → mismatch returns **400** + audit `OAUTH_FAILED` reason `tenant_binding_mismatch` (NEVER 403, NEVER 404 — see 3.C.6 for the existing-project status code change)
- Verify `csrfNonce` matches cookie → mismatch returns 400 + audit reason `csrf_mismatch`
- Verify `redirect_uri` matches `state.redirectUri` → mismatch returns 400 + audit reason `redirect_uri_mismatch` (RFC 6749 §10.6)
  3.C.4 Both project + workspace flows now satisfy ST-1.
  3.C.5 Unit tests for each rejection path.
  3.C.6 **Existing project callback status-code change**: today `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/callback/route.ts` returns `404 NOT_FOUND` on tenant/project/user mismatch (around line 169-176). ST-1 mandates `400` with structured `OAUTH_FAILED` audit emission. Change the status code from 404 to 400 and emit the audit event with the appropriate reason; preserve any test that asserts the prior 404 by updating to 400.
  3.C.7 Replace `OAuthStateSchema.passthrough()` (around line 51 of the existing callback) with `.strict()` (or remove `.passthrough()`) to align with ST-1's bounded payload contract.
  3.C.8 **CSRF nonce cookie cleanup (IR7-5)**: after callback verification — pass OR fail — clear the same-origin CSRF cookie by setting `Set-Cookie: csrfNonce=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`. This prevents stale cookies from being accepted in a subsequent flow with a freshly-minted state token. Apply on BOTH project and workspace callback routes.

**Exit Criteria**:

- [ ] State payload contains all 7 required fields (including `redirectUri`)
- [ ] CSRF cookie set on initiate (HttpOnly, SameSite=Lax)
- [ ] All 3 callback verification rejections produce 400 (NEVER 403) + sanitized error
- [ ] State `GETDEL` is atomic (test by simulating concurrent callbacks — second returns `state_replay_or_expired`)

#### Phase 3.D — Token storage to `EndUserOAuthToken` with `__tenant__` + tenant-scoped DEK (S, ~1 day, 1 package)

**Tasks**:

3.D.1 On callback success, persist tokens to `EndUserOAuthToken` with `userId: '__tenant__'` (validated against RP-1) and `provider: 'auth-profile:{appProfileId}'`.
3.D.2 Use tenant-scoped DEK encryption (matches `oauth2_token` storage pattern).
3.D.3 **Defense-in-depth**: call `assertNotReservedPrincipal(userId)` at the `EndUserOAuthToken` upsert site BEFORE persisting (in addition to the user-creation site wired in Phase 0.3). For workspace OAuth specifically, the upsert site checks against the approved-list — `'__tenant__'` passes; any other `__`-prefixed value rejects with `AUTH_RESERVED_PRINCIPAL`.

**Exit Criteria**:

- [ ] Workspace OAuth tokens persist to `EndUserOAuthToken` with `userId: '__tenant__'`
- [ ] Tenant-scoped DEK encryption verified by reading the doc back
- [ ] RP-1 rejects unapproved principals (test asserts unknown `__foo` rejected at RP-1 layer)

#### Phase 3.E — Studio UI scope dispatch (XS, ~0.5 day, 1 package)

**Tasks**:

3.E.1 `AuthProfileOAuthDialog.tsx` accepts `scope: 'project' | 'workspace'` prop.
3.E.2 Dispatches POST to project vs workspace `/oauth/initiate` route based on scope.
3.E.3 Workspace dispatch only available to users with `auth-profile:write` workspace permission (UI-level disable; route-level enforcement is the source of truth).

**Exit Criteria**:

- [ ] `AuthProfileOAuthDialog` invokable with both scope values
- [ ] Workspace UI disabled for users without `auth-profile:write`

#### Phase 3.F — Audit emissions on both project + workspace flows (S, ~0.5-1 day, 2 packages)

**Tasks**:

3.F.1 Add `OAUTH_FAILED: 'AUTH_PROFILE_OAUTH_FAILED'` to `packages/database/src/auth-profile/audit-events.ts`.
3.F.2 Emit `OAUTH_INITIATED` on initiate success; `OAUTH_COMPLETED` on callback success; `OAUTH_FAILED` on each rejection path.
3.F.3 Payload includes `idpErrorMapped` (sanitized: `access_denied`, `invalid_client`, `consent_required`, etc.) — never raw IdP body.
3.F.4 Behavior gates on `OAUTH_AUDIT_LOG_ENABLED` (default `true`).
3.F.5 INT-10 covers emission verification (Phase 5).

**Exit Criteria**:

- [ ] All 3 audit constants emitted on the appropriate code paths
- [ ] `idpErrorMapped` payload sanitized (no raw IdP body)
- [ ] `OAUTH_AUDIT_LOG_ENABLED=false` suppresses emissions

**Phase 3 Test Strategy**: Unit per sub-phase + INT-10 (OAuth audit emission) + E2E-7 + E2E-WIRE-1 in Phase 5.

**Phase 3 Rollback**: `WORKSPACE_OAUTH_ENABLED=false` disables new routes; ST-1 retrofit on project routes is reversible by reverting Phase 3.C.

---

### Phase 4: Runtime Protocol Handlers (effort: ~5-7 days; parallelizable with Phase 2 and Phase 3 after Phase 1 lands)

**Goal**: FR-15 — runtime protocol handlers for the 6 store-only types + 1 regression-only type.

Per oracle decision D-3, each protocol gets its own sub-phase. All 6 are independently feature-flagged (FF-1).

> **Round 8 OSS audit discovery**: `@agent-platform/auth-enterprise` already implements **5 of the 6** target protocols with zero external dependencies — `applyDigestAuth`, `applyKerberosAuth`, `applySamlAuth`, `applyHawkAuth`, `applyWsSecurity` (verified at `packages/auth-enterprise/src/index.ts`; consumed by `packages/compiler/src/platform/constructs/executors/soap-envelope.ts`). The LLD now **delegates** these protocols to the existing package rather than re-implementing them. Phase 4 effort drops from ~12-13 days to ~5-7 days. Integration work per protocol becomes: (a) wire the existing `apply*Auth` function into `applyAuth()`'s dispatch table; (b) add the FF-1 feature-flag check; (c) emit the sanitized `AUTH_PROTOCOL_DISABLED` (503) when the flag is off; (d) add the dispatch test. The `auth-enterprise` functions are pure and tested — Phase 4 is glue, not new protocol logic.

> **Round 7 GAP IR7-6 — `signRequest` closure**: For per-request signing protocols (`aws_iam`, `hawk`), the `signRequest` callback must capture all signing inputs at construction time so the dispatch table can return a value-typed `ApplyAuthResult` without re-resolving credentials. Construct `signRequest` as a closure that captures `{ region, service, credentials }` (SigV4) or `{ credentials, ext? }` (HAWK) at the time `applyAuth()` runs; the callback shape stays `(assembled) => Promise<Headers>` so consumers in `HttpToolExecutor` don't need to know per-protocol parameters.

#### Phase 4.1 — `azure_ad` plain-fetch token exchange (S, ~1.5 days, 1 package)

**Tasks**:

4.1.1 Create `packages/shared-auth-profile/src/protocol-handlers/azure-ad.ts` — plain `fetch` POST to `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`.
4.1.2 No `@azure/msal-node` dep — matches SharePoint connector pattern.
4.1.3 **Cache reuse**: invoke the existing `resolveClientCredentialsToken()` from `packages/shared/src/services/auth-profile/client-credentials-service.ts` (which by Phase 1.3.b uses CK-1 Redis keying) rather than implementing a separate cache. The `azure_ad` token endpoint is just an OAuth2 client_credentials grant against a Microsoft URL — sharing the cache implementation gives one invalidation path and one rate-limiter.
4.1.4 Wire into `applyAuth` dispatch table.
4.1.5 Behavior gates on `AUTH_AZURE_AD_ENABLED` (default `false → true`); when `false`, return sanitized `AUTH_PROTOCOL_DISABLED` (HTTP 503).
4.1.6 Unit tests with DI'd `fetch` (no `vi.mock`).

**Exit Criteria**:

- [ ] `azure_ad` profile resolves a bearer token end-to-end
- [ ] Cache key matches CK-1
- [ ] `AUTH_AZURE_AD_ENABLED=false` returns `AUTH_PROTOCOL_DISABLED` (503), never silent success, never 500

#### Phase 4.2 — `aws_iam` SigV4 with `signRequest` hook (M, ~2 days, 1 package; pre-req for 4.3, 4.4)

**Tasks**:

4.2.1 Use **`@smithy/signature-v4`** + **`@smithy/protocol-http`** (already in lockfile at v5.3.12+ per Round 8 audit; transitively provided by AWS SDK v3 packages already used elsewhere in the monorepo). The deprecated `@aws-sdk/signature-v4` and `@aws-sdk/protocol-http` packages should NOT be added — they are superseded by the `@smithy/*` namespace.
4.2.2 Create `packages/shared-auth-profile/src/protocol-handlers/aws-iam.ts` — exposes `signRequest` callback. Per IR7-6, the callback must be a **closure** that captures `{ region, service, credentials }` at the time `applyAuth()` is invoked, returning a function with the pinned signature `(assembled: AssembledRequest) => Promise<Headers>`. The closure delegates to `SignatureV4` from `@smithy/signature-v4`.
4.2.3 Lazy-load `@smithy/signature-v4` inside the `aws_iam` branch (bundle-size mitigation).
4.2.4 Update `ApplyAuthResult` interface in `apply-auth.ts` to include the optional `signRequest` field.
4.2.5 `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` invokes `result.signRequest(assembled)` after request assembly.
4.2.6 Behavior gates on `AUTH_SIGV4_ENABLED`.
4.2.7 Unit tests: signature generated for a fixture request matches AWS-canonical; closure correctly captures region/service/credentials; FF-1 disabled-flag UX.

**Exit Criteria**:

- [ ] `aws_iam` profile signs an outbound request with SigV4
- [ ] `signRequest` hook signature matches D-8 pin
- [ ] AWS SDK is NOT loaded for builds without `aws_iam` profiles (verified by bundle-size diff)
- [ ] `AUTH_SIGV4_ENABLED=false` returns `AUTH_PROTOCOL_DISABLED`

#### Phase 4.3 — `digest` retry-on-401 (XS, ~0.5 day, 1 package; delegates to existing `auth-enterprise`)

**Tasks**:

4.3.1 **Reuse existing implementation**: import `applyDigestAuth` from `@agent-platform/auth-enterprise` (already exported at `packages/auth-enterprise/src/index.ts`; zero external dependencies; uses Node.js built-in `crypto`). No new file at `packages/shared-auth-profile/src/protocol-handlers/digest.ts` is needed — wire the existing function directly into `applyAuth`'s dispatch.
4.3.2 **Integration seam** in `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`: when `ApplyAuthResult.digestCredentials` is present and the response status is 401 with `WWW-Authenticate: Digest`, parse the challenge, call `applyDigestAuth(challenge, config, secrets, options)` from `auth-enterprise` to build the `Authorization: Digest ...` header, and retry the original request once. Subsequent 401s do not retry.
4.3.3 NOT via `signRequest` hook (digest is body-mutating per GAP-23 — response body's `entity` may need hashing in `qop=auth-int` mode).
4.3.4 Behavior gates on `AUTH_DIGEST_ENABLED`.
4.3.5 Add `packages/auth-enterprise` to `packages/shared-auth-profile/package.json` workspace dependencies.

**Exit Criteria**:

- [ ] `digest` profile authenticates against a fixture HTTP server expecting digest
- [ ] First request returns 401; second (with digest) returns 2xx
- [ ] `AUTH_DIGEST_ENABLED=false` returns `AUTH_PROTOCOL_DISABLED`

#### Phase 4.4 — `hawk` MAC signing via `signRequest` hook (XS, ~0.5 day, 1 package; delegates to existing `auth-enterprise`)

**Tasks**:

4.4.1 **Reuse existing implementation**: import `applyHawkAuth` from `@agent-platform/auth-enterprise` (zero external deps; supersedes the originally-planned `@hapi/hawk` dependency). Do NOT add `@hapi/hawk` — `auth-enterprise` already provides a tested, dependency-free HAWK MAC implementation.
4.4.2 In `applyAuth()`'s `hawk` dispatch branch, build a `signRequest` closure that captures the resolved `{ credentials, ext? }` and delegates to `applyHawkAuth(assembled, credentials, options)`. The closure shape stays `(assembled) => Promise<Headers>` per IR7-6.
4.4.3 Behavior gates on `AUTH_HAWK_ENABLED`.

**Exit Criteria**:

- [ ] `hawk` profile signs an outbound request; HAWK MAC verified by a fixture server
- [ ] `AUTH_HAWK_ENABLED=false` returns `AUTH_PROTOCOL_DISABLED`

#### Phase 4.5 — `saml` RFC 7522 bearer-assertion grant (S, ~1 day, 1 package; delegates to existing `auth-enterprise`)

**Tasks**:

4.5.1 **Reuse existing implementation**: import `applySamlAuth` from `@agent-platform/auth-enterprise` (zero external deps). The originally-planned `packages/shared-auth-profile/src/saml-grant.ts` is no longer needed — `auth-enterprise` already provides RFC 7522 bearer-assertion grant.
4.5.2 In `applyAuth()`'s `saml` dispatch branch, call `applySamlAuth(config, secrets)` from `auth-enterprise`; cache the resulting bearer token in Redis with CK-1 keying (delegates to the same `resolveClientCredentialsToken`-style cache pattern via the existing CC service when applicable).
4.5.3 Behavior gates on `AUTH_SAML_ENABLED`.

**Exit Criteria**:

- [ ] `saml` profile resolves a bearer token via RFC 7522 grant
- [ ] Cache key matches CK-1
- [ ] `AUTH_SAML_ENABLED=false` returns `AUTH_PROTOCOL_DISABLED`

#### Phase 4.6 — `kerberos` SPNEGO (S, ~0.75 day, 1 package; delegates to existing `auth-enterprise`)

**Tasks**:

4.6.1 **Reuse existing implementation**: import `applyKerberosAuth` from `@agent-platform/auth-enterprise`. Verify whether `auth-enterprise` already declares the `kerberos` npm dependency or provides a fallback shim; if not declared, add `kerberos` as an `optionalDependencies` entry in `packages/auth-enterprise/package.json` (NOT `packages/shared-auth-profile/`) so the dependency lives with the implementation.
4.6.2 Wire `applyKerberosAuth` into `applyAuth()`'s `kerberos` dispatch branch.
4.6.3 Build-time gate via `ENABLE_KERBEROS=true` env var; default builds reject `kerberos` profiles at write time with `AUTH_KERBEROS_NOT_BUILT`.
4.6.4 **Docker / system-package requirement (R6-M2)**: for builds with `ENABLE_KERBEROS=true`, the `kerberos` npm package's native build requires the `krb5-dev` (Debian/Ubuntu) or `libkrb5-dev` system package. Document this in:

- `packages/auth-enterprise/package.json` README
- The relevant Dockerfile(s) — `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile` — must include a conditional `RUN apt-get install -y libkrb5-dev` step gated on a `KERBEROS=true` build arg
- Build runbook: builds without `KERBEROS=true` must verify `kerberos` isn't pulled in (lockfile check)

**Exit Criteria**:

- [ ] `kerberos` profile resolves SPNEGO header in a build with `ENABLE_KERBEROS=true`
- [ ] Default build (`ENABLE_KERBEROS=false`) rejects `kerberos` profile creation with `AUTH_KERBEROS_NOT_BUILT` at write time
- [ ] CVE review documented in commit message before adoption

#### Phase 4.7 — `ws_security` regression test only (XS, ~0.5 day, 1 package)

**Tasks**:

4.7.1 Confirm `ws_security` is already wired — `applyWsSecurity` from `@agent-platform/auth-enterprise` is consumed by `packages/compiler/src/platform/constructs/executors/soap-envelope.ts` (verified by Round 8 audit). No `applyAuth` dispatch change needed for this protocol; `HttpToolExecutor`'s SOAP envelope path already invokes the existing function.
4.7.2 Add a regression integration test verifying envelope is injected for a fixture SOAP request.
4.7.3 No new code; no new flag.

**Exit Criteria**:

- [ ] Regression test passes
- [ ] No code added beyond the test file

**Phase 4 Test Strategy**: Per-protocol unit tests (in-phase) + matrix E2E (Phase 5). Mock external HTTP at the network boundary via DI (no `vi.mock` of platform components per CLAUDE.md).

**Phase 4 Rollback**: Each protocol's flag set to `false` returns `AUTH_PROTOCOL_DISABLED` (per FF-1).

---

### Phase 5: Vocabulary + Tests + Observability (effort: ~5-6 days)

**Goal**: FR-16 vocabulary alignment + FR-17 matrix coverage, sanitization, and observability.

#### Phase 5.1 — FR-16 vocabulary alignment + alias migration (S, ~1.5 days, 3 packages — `packages/shared`, `packages/compiler`, `apps/workflow-engine`; within commit-scope guard)

**Tasks**:

5.1.1 Create `packages/shared/src/validation/auth-type-aliases.ts` with `normalizeAuthType()` and `AUTH_TYPE_ALIASES` map.
5.1.2 Mark inline aliases `@deprecated` in `packages/shared/src/validation/project-tool-schemas.ts:20-27` (preserve union members for backward compat).
5.1.3 Apply normalization on the read path at `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` and `apps/workflow-engine/src/executors/http-executor.ts`.
5.1.4 Create `tools/migrate-auth-aliases.ts`: rewrites stored configs in-place; supports `--dry-run` and `--restore` (re-applies aliases — for staged rollouts).
5.1.5 Sunset deadline `v2026.07.x` — after that release, CI fails on alias use.
5.1.6 Unit tests for `normalizeAuthType`.

**Exit Criteria**:

- [ ] Both alias and canonical names resolve identically through `normalizeAuthType`
- [ ] Migration script idempotent
- [ ] CI lint warns on inline alias use; fails after `v2026.07.x`

#### Phase 5.2 — FR-17.a Matrix E2E test (M, ~2 days, 1 package)

**Tasks**:

5.2.1 Create `apps/runtime/src/__tests__/auth-profile-matrix.e2e.test.ts`.
5.2.2 Iterate all matrix cells: HTTP tools (17 × 2 scopes × 3 executors = 102), MCP servers (12 × 2 = 24), Studio Test (17 × 2 = 34) — total 161 cells.
5.2.3 No platform mocks; external providers stubbed at network boundary via DI.
5.2.4 `beforeEach`: `redis.select(REDIS_TEST_DB_INDEX)` then `FLUSHDB`.
5.2.5 Per-cell isolation: cell N's Redis state must not satisfy cell N+1's assertion.
5.2.6 Flake budget: 0% over 50 runs in CI.

**Exit Criteria**:

- [ ] All 161 cells pass (where the underlying FR has shipped — disabled cells skip cleanly via flag check)
- [ ] 50-run CI flake rate = 0%
- [ ] Per-cell `FLUSHDB` verified by inspecting Redis after each cell

#### Phase 5.3 — Connector-action non-regression test (S, ~0.5 day, 1 package, codeowner-gated)

**Tasks**:

5.3.1 Add a non-regression integration test verifying the integration auth profile path (Nango bridge) is unmodified.
5.3.2 Codeowner-gated: any change to non-touch boundary files (per feature spec §12.4) requires integration-auth-profiles owners' approval.
5.3.3 Test asserts `connector_action_executor.ts` resolves credentials through the integration path, not the unified `applyAuth` (which is auth-profile-only).

**Exit Criteria**:

- [ ] `connector_action` integration auth still resolves through `connection-resolver.ts`
- [ ] Test added to CODEOWNERS for integration-auth-profiles owners

#### Phase 5.4 — Kill-switch fidelity tests (S, ~0.5 day, 1 package)

**Tasks**:

5.4.1 For every flag in feature spec §11.2 (12 flags total), add a fidelity test asserting `flag=false` fully restores legacy behavior.
5.4.2 Failures here block the rollout PR.

**Exit Criteria**:

- [ ] 12 kill-switch fidelity tests, all passing
- [ ] PR rollout PR template requires this suite to pass

#### Phase 5.5 — Cross-tenant isolation suite (S, ~0.5 day, 1 package)

**Tasks**:

5.5.1 Create `apps/runtime/src/__tests__/integration/cross-tenant-isolation.test.ts`.
5.5.2 Assert tenant-A tokens never resolve in tenant-B's resolver, cache, OR audit log.
5.5.3 Defense-in-depth complement to E2E-10's full matrix.

**Exit Criteria**:

- [ ] Test passes; tenant-A cache key never appears in a tenant-B request
- [ ] Test runs in <2 seconds per CK-1 isolation property

#### Phase 5.6 — TraceStore wiring + sanitizer (TE-1) (S, ~1 day, 2 packages)

**Tasks**:

**Phase 5.6 splits into 5.6a + 5.6b** to satisfy CLAUDE.md commit-scope guard (max 3 packages per commit). 5.6a touches `packages/shared-kernel` + `packages/shared-auth-profile` (2 packages). 5.6b touches `apps/studio` + `apps/runtime` (2 packages). Both retain the same goal but split by package boundary.

#### Phase 5.6a — TraceStore registration + sanitizer creation (S, ~0.5 day, 2 packages)

5.6a.1 Wire token-refresh and OAuth-lifecycle events to canonical `TraceStore` (`packages/shared-kernel/src/constants/trace-event-registry.ts`). **Scope clarification**: the 3 new r2 event types (`mcp.auth_resolved`, `mcp.auth_refreshed`, `tool_test.auth_resolved`) are wired to canonical TraceStore in this phase. The 16 existing `auth_profile.*` events emitted via `emitAuthProfileTraceEvent()` continue to use structured logging (`log.info`) — their TraceStore migration is a post-r2 item (tracked as feature-spec OQ-4 follow-up). This closes GAP-6 for the new event types only.
5.6a.2 Add 3 new event types to a new `AUTH_PROFILE_TRACE_EVENT_TYPES` array in `packages/shared-kernel/src/constants/trace-event-registry.ts`. Required mechanical steps (per existing per-domain pattern):

- Define the array: `export const AUTH_PROFILE_TRACE_EVENT_TYPES = ['mcp.auth_resolved', 'mcp.auth_refreshed', 'tool_test.auth_resolved'] as const;`
- Add `auth_profile: AUTH_PROFILE_TRACE_EVENT_TYPES` to the `TRACE_EVENT_GROUPS` object (around line 257-278 of the registry)
- Add `...AUTH_PROFILE_TRACE_EVENT_TYPES` to the `ALL_TRACE_EVENT_TYPES` spread (around line 282-303)
- The `ExtendedTraceEventType` union derives from `ALL_TRACE_EVENT_TYPES` so the type extension is automatic
  5.6a.3 Create `packages/shared-auth-profile/src/sanitize-error.ts` — pure function `sanitizeAuthProfileError(err: unknown): SafeError` per D-9. Cover all 28 codes from HLD §7 Registry.
  5.6a.4 Re-export sanitizer from `packages/shared-auth-profile/src/index.ts`.

**Files Touched**: `packages/shared-kernel/src/constants/trace-event-registry.ts`, `packages/shared-auth-profile/src/sanitize-error.ts` (NEW), `packages/shared-auth-profile/src/index.ts`, plus respective unit-test files.

**Exit Criteria**:

- [ ] `AUTH_PROFILE_TRACE_EVENT_TYPES` exported and present in `TRACE_EVENT_GROUPS` + `ALL_TRACE_EVENT_TYPES`
- [ ] `sanitizeAuthProfileError()` covers all 28 HLD §7 codes
- [ ] Snapshot test asserts no `tenantId`, `clientId`, provider names, or response bodies leak in user-rendered output
- [ ] `pnpm build --filter=@agent-platform/shared-kernel --filter=@agent-platform/shared-auth-profile` succeeds with 0 errors

#### Phase 5.6b — Sanitizer + TraceStore consumer wiring (S, ~0.5 day, 2 packages)

5.6b.1 Replace ad-hoc error strings in Studio surfaces (`apps/studio/src/services/tool-test-service.ts`, OAuth callback route handlers, `resolve-tool-auth.ts` if present) with `sanitizeAuthProfileError()` output.
5.6b.2 Wire token-refresh and MCP auth events at runtime emission sites (`apps/runtime/src/services/mcp/*`, `auth-profile-resolver.ts` refresh paths) to call the canonical `TraceStore` instead of `log.info` for the 3 new event types.
5.6b.3 Add payload-shape regression test per new event type asserting TE-1 conformance — only allowed keys (`{authType, profileScope, profileId, profileVersion, principalKind, refreshOutcome, latencyMs, errorCode}`) appear in the rendered payload.

**Files Touched**: `apps/studio/src/services/tool-test-service.ts`, `apps/studio/src/app/api/projects/[id]/auth-profiles/oauth/{initiate,callback}/route.ts`, `apps/studio/src/app/api/auth-profiles/oauth/{initiate,callback}/route.ts`, `apps/runtime/src/services/mcp/*`, `apps/runtime/src/services/auth-profile-resolver.ts`, plus per-event-type snapshot test files.

**Exit Criteria**:

- [ ] User-rendered error surfaces invoke `sanitizeAuthProfileError()` (verified by `rg "sanitizeAuthProfileError\(" apps/studio/src apps/runtime/src` — at least 4 call sites)
- [ ] 3 new event types emit through canonical `TraceStore` (verified by INT-12)
- [ ] Per-event-type snapshot tests pass; no forbidden keys in rendered payloads
- [ ] `pnpm build --filter=apps/studio --filter=apps/runtime` succeeds with 0 errors

**Exit Criteria**:

- [ ] Sanitizer covers all 28 codes in HLD §7 registry
- [ ] No `tenantId`, `clientId`, provider names, or response bodies leak in user-rendered output (verified by snapshot test)
- [ ] Each trace event type has a payload-shape snapshot test

#### Phase 5.7 — Drift lint hook (XS, ~0.5 day, hooks + CI)

**Tasks**:

5.7.1 Create `.claude/hooks/auth-type-coverage.sh` — fails if any entry in `SUPPORTED_AUTH_TYPES` (the constant introduced in Phase 2.2 — same constant referenced throughout the LLD; the feature spec's `AUTH_PROFILE_AUTH_TYPES` text refers to this same source-of-truth set) is missing UI metadata, runtime handler, or matrix test row.
5.7.2 Mirror as a CI step.
5.7.3 Test by deliberately removing a UI metadata entry and asserting the lint blocks.

**Exit Criteria**:

- [ ] Lint passes against current state
- [ ] Lint blocks a deliberate breakage (UI entry removed)
- [ ] CI mirror also blocks

**Phase 5 Test Strategy**: Self-contained — this phase IS the test phase. Each sub-phase produces its own test artifacts.

**Phase 5 Rollback**: Each test addition is independently revertable (delete file). Sanitizer rollback restores ad-hoc error strings — but doing so is a security regression and should be avoided.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This section prevents the #1 agent failure mode: writing code that nothing calls.

**Backend wiring**:

- [ ] `RESERVED_PRINCIPALS` exported from `packages/shared-auth-profile/src/index.ts`
- [ ] `assertNotReservedPrincipal()` called from `apps/studio/src/services/auth-service.ts` user-creation path
- [ ] `sanitizeAuthProfileError()` exported from `packages/shared-auth-profile/src/index.ts`
- [ ] `sanitizeAuthProfileError()` consumed by `tool-test-service.ts`, OAuth callback handlers, `resolve-tool-auth.ts`
- [ ] `signRequest` invoked by `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` after request assembly
- [ ] 6 protocol handlers registered in `applyAuth` dispatch table (azure-ad, aws-iam, digest, hawk, saml, kerberos)
- [ ] `normalizeAuthType()` called on read path in `http-tool-executor.ts` and `http-executor.ts`
- [ ] `createAuthProfileToolMiddleware()` injected into `ToolBindingExecutor` constructor at `internal-tools.ts:170-178`
- [ ] `mcp-auth-resolver.ts` rewrite registered in MCP transport call sites
- [ ] `auth-profile.updated` post-save hook invalidates `CredentialCache` and `mcp-auth-resolver` Redis cache
- [ ] `OAUTH_FAILED` audit constant exported from `packages/database/src/auth-profile/audit-events.ts` and emitted from project + workspace OAuth callback handlers
- [ ] 3 new TraceStore event types registered in `packages/shared-kernel/src/constants/trace-event-registry.ts` (added to `AUTH_PROFILE_TRACE_EVENT_TYPES`, `TRACE_EVENT_GROUPS.auth_profile`, and the `ALL_TRACE_EVENT_TYPES` spread)
- [ ] CK-1 cache key composition consumed by `credential-cache.ts`, `client-credentials-service.ts`, `mcp-auth-resolver.ts`
- [ ] `profileVersion` pre-save hook is registered (mongoose pre-save handler attached to schema)
- [ ] Migration scripts wired into `tools/` and documented in package README or migration runbook

**Studio UI**:

- [ ] Each new auth-type form's `onSubmit` has try/catch displaying error to user
- [ ] Each `useMutation` call has `onError` callback OR every `mutateAsync` is in a try/catch
- [ ] Submit buttons have `disabled={isPending}` or equivalent loading guard
- [ ] `apps/studio/src/app/api/auth-profiles/oauth/initiate/route.ts` is called from `AuthProfileOAuthDialog.tsx` when `scope='workspace'`
- [ ] `apps/studio/src/app/api/auth-profiles/oauth/callback/route.ts` is the redirect target from the OAuth provider for workspace flows
- [ ] `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/route.ts` is called from the workflow-author tool picker
- [ ] 10 new auth-type forms imported and rendered by `AuthProfileSlideOver.tsx`
- [ ] `SUPPORTED_AUTH_TYPES` constant consumed by both the slide-over dropdown and `auth-type-metadata.ts`
- [ ] `AuthProfileOAuthDialog` accepts and dispatches on `scope` prop
- [ ] No native `<select>` in any new form (use `<Select>` from `components/ui/Select.tsx`)
- [ ] No `bg-accent text-foreground` in any new form (use `bg-accent text-accent-foreground`)
- [ ] No design-token violations (verified by `.claude/hooks/design-token-lint.sh`)

**Studio API surface**:

- [ ] Workspace OAuth routes proxy to runtime / call real services (no stub data)
- [ ] Every new Studio API route includes `tenantId: user.tenantId` explicitly in every Mongo query (per CLAUDE.md "Studio Route Handler Gotchas")
- [ ] `validateBody()` is used with Zod `.strict()` (no `request.clone()` then assume safe)

**RBAC + Auth**:

- [ ] `'auth-profile:write'` added to `WORKSPACE_PERMISSIONS` (apps/studio/src/lib/workspace-permission.ts:12-17)
- [ ] `workspace-auditor` role added to role-permissions table with `['auth-profile:read']` only
- [ ] No custom `jwt.verify` introduced anywhere (CLAUDE.md "Centralized auth only")

**Hooks + CI**:

- [ ] `.claude/hooks/auth-profile-query-shape-lint.sh` registered in `.claude/settings.json` PreToolUse
- [ ] `.claude/hooks/auth-type-coverage.sh` registered in pre-commit AND CI
- [ ] Both hooks tested with deliberate breakage (block successfully)

**Migration scripts**:

- [ ] `tools/migrate-mcp-auth-profile-split.ts` documented in deployment runbook with `--dry-run` instructions
- [ ] `tools/migrate-auth-aliases.ts` documented with `v2026.07.x` sunset
- [ ] `tools/migrate-profile-version-backfill.ts` documented as Phase 0.4 prerequisite

**Dependencies**:

- [ ] `@agent-platform/auth-enterprise` added as workspace dep to `packages/shared-auth-profile/package.json`
- [ ] `@smithy/signature-v4` + `@smithy/protocol-http` resolved (already in lockfile via AWS SDK v3 transitive deps; no new lockfile entries)
- [ ] No `@aws-sdk/signature-v4` / `@aws-sdk/protocol-http` (deprecated — use `@smithy/*` namespace)
- [ ] No `@hapi/hawk` (replaced by `auth-enterprise`'s zero-dep implementation)
- [ ] No `@azure/msal-node` introduced
- [ ] `rate-limiter-flexible` referenced from existing lockfile entry in `mcp-auth-resolver.ts`
- [ ] `kerberos` (if needed) lives in `packages/auth-enterprise/package.json` `optionalDependencies`, NOT `shared-auth-profile`

---

## 5. Cross-Phase Concerns

### Database Migrations

Three idempotent scripts. Each script:

- Reads `MONGODB_URI` from environment (falls back to dev default with warning).
- Supports `--dry-run` (counts affected docs without writing), `--restore` (reverses where reversible — split + aliases only; backfill is non-reversible since the field becomes load-bearing), and `--limit N` (batched run for production safety).
- Emits structured logs: `{ migration, action, count, durationMs, error? }` per batch (not free-form text). Logs go to stdout in NDJSON; consumers may pipe to a log collector.
- Runs idempotently: re-running on already-migrated data reports zero updates.

| Script                                      | Phase | Collection           | Dependency                                                                                       |
| ------------------------------------------- | ----- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `tools/migrate-profile-version-backfill.ts` | 0.4   | `auth_profiles`      | None — order-independent                                                                         |
| `tools/migrate-mcp-auth-profile-split.ts`   | 1.3.a | `mcp_server_configs` | None — but must run before 1.3.b deploys (1.3.b reads `envProfileId`)                            |
| `tools/migrate-auth-aliases.ts`             | 5.1   | tool config storage  | None — alias normalization on read makes the migration optional but recommended pre-`v2026.07.x` |

**Run-order recommendation** (despite order-independence): backfill → split → aliases. Reasoning: backfill is safest; split affects MCP code; aliases sunset deadline drives final scheduling.

### Feature Flags

Per feature spec §11.2 — 12 flags total. Default values per spec; overridden per environment for staged rollout.

| Flag                              | Default        | Phase | Rollback Behavior                                              |
| --------------------------------- | -------------- | ----- | -------------------------------------------------------------- |
| `WORKFLOW_AUTH_PROFILE_ENABLED`   | `true`         | 1.1   | `false` → restores silent unauth (legacy)                      |
| `MCP_AUTH_PROFILE_ENABLED`        | `false → true` | 1.3   | `false` → only legacy 5 hard-coded types resolve               |
| `STUDIO_TEST_OAUTH_GRANT_ENABLED` | `true`         | 2.1   | `false` → restores 500 throw on `oauth2_app`/`oauth2_token`    |
| `WORKSPACE_OAUTH_ENABLED`         | `false → true` | 3.B   | `false` → workspace OAuth routes return 404                    |
| `OAUTH_AUDIT_LOG_ENABLED`         | `true`         | 3.F   | `false` → suppresses `OAUTH_INITIATED/COMPLETED/FAILED` events |
| `AUTH_PROFILE_PHASE_2_3_UI`       | `false → true` | 2.2   | `false` → dropdown reverts to current 7 entries                |
| `AUTH_AZURE_AD_ENABLED`           | `false → true` | 4.1   | `false` → `azure_ad` profile returns `AUTH_PROTOCOL_DISABLED`  |
| `AUTH_SIGV4_ENABLED`              | `false → true` | 4.2   | `false` → `aws_iam` profile returns `AUTH_PROTOCOL_DISABLED`   |
| `AUTH_DIGEST_ENABLED`             | `false → true` | 4.3   | `false` → `digest` profile returns `AUTH_PROTOCOL_DISABLED`    |
| `AUTH_HAWK_ENABLED`               | `false → true` | 4.4   | `false` → `hawk` profile returns `AUTH_PROTOCOL_DISABLED`      |
| `AUTH_SAML_ENABLED`               | `false → true` | 4.5   | `false` → `saml` profile returns `AUTH_PROTOCOL_DISABLED`      |
| `ENABLE_KERBEROS`                 | `false`        | 4.6   | Build-time gate; default builds reject `kerberos` write        |

Kill-switch fidelity tests (Phase 5.4) verify every `flag=false` fully restores legacy behavior.

### Configuration Changes

| Variable                       | Default | Purpose                                                            |
| ------------------------------ | ------- | ------------------------------------------------------------------ |
| `REDIS_TEST_DB_INDEX`          | `2`     | Dedicated Redis DB for matrix E2E + INT tests; `FLUSHDB` only here |
| `STUDIO_OAUTH_ALLOWED_ORIGINS` | (unset) | Existing — OAuth callback origin allowlist                         |

No other configuration changes beyond the 12 feature flags above.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 6 phases complete with sub-phase exit criteria met
- [ ] All 17 FRs (FR-1..FR-17) have at least one shipping implementation task that traces to a feature-spec FR ID
- [ ] All 6 §12.0 contracts (TI-1, CK-1, RP-1, ST-1, TE-1, FF-1) have shipping enforcement in code AND a regression test
- [ ] All 12 new error codes (HLD §7 Registry's 11 codes + `AUTH_REFRESH_RECONNECT` added in Phase 1.3.c per IR7-3) are emitted from at least one site AND consumed by at least one consumer surface (Studio UI dispatch, runtime tool error envelope, MCP transport, Studio Test panel)
- [ ] All 15 E2E scenarios in test spec §2 pass against real services (Mongo + Redis + Express on random ports; no platform mocks)
- [ ] FR-14: All 10 (or 7 if `kerberos`/`saml`/`ssh_key` deferred per OQ-7) new auth-type Studio forms render, submit, persist via API, and round-trip through GET — verified in E2E-WIRE-2 + form-level component tests
- [ ] All 14 INT scenarios in test spec §3 pass at real service boundaries
- [ ] Matrix E2E flake rate = 0% over 50 CI runs
- [ ] All 12 kill-switch fidelity tests pass (every `flag=false` fully restores legacy)
- [ ] Cross-tenant isolation suite passes (defense-in-depth against CK-1 violations)
- [ ] All migration scripts pass `--dry-run` against a snapshot of staging data
- [ ] `pnpm build` and `pnpm test` succeed across the monorepo with 0 errors
- [ ] No regressions in existing tests (new test files added; existing pass rates unchanged)
- [ ] No platform components mocked (`vi.mock` of `@agent-platform/*` or `@abl/*`) in any new test
- [ ] No `console.log`, no swallowed catches, no sync I/O, no `any` where structured types exist (CLAUDE.md hooks enforce)
- [ ] Feature spec §16 GAP-7..GAP-15 status changes from "Open" to "Closed by FR-N" with verifying test
- [ ] HLD §8.2 BETA limitations (L1-L3) remain "Open" — these are accepted trade-offs, not r2 work
- [ ] Status promoted: feature spec BETA → STABLE (gated by §17 audit suite per AUTHORING_GUIDE.md)
- [ ] Post-impl-sync run: feature spec / HLD / test spec / testing matrix all updated; OQ-5 and OQ-6 staleness items resolved

---

## 7. Open Questions

1. **`oauth4webapi` adoption (HLD OQ-2 / feature-spec OQ-12)**: **RESOLVED by Round 8 OSS audit — DO NOT ADOPT**. The hand-rolled token-exchange POST in OAuth callback handlers is ~3 lines of `fetch`; `oauth4webapi` does not replace the ST-1 state-binding/CSRF chain, the audit emission, or the `EndUserOAuthToken` storage. Custom-keep is the right answer. (Source: Round 8 OSS audit log entry OSS-7.)
2. **`kerberos` / `saml` / `ssh_key` Studio UI deferral (HLD OQ-3 / feature-spec OQ-7)**: Final descope decision pending customer-roadmap input. If deferred, runtime FR-15 handlers still ship; Studio dropdown shows "API-only" notice for those three types. Decision target: before Phase 2.2 lands.
3. **`PHASE1_AUTH_TYPES` retention (feature-spec OQ-8)**: Migrate the 4 known consumers (`auth-profile.schema.ts`, `validation/index.ts`, `AuthProfileSlideOver.tsx`, `auth-type-metadata.ts`) to `SUPPORTED_AUTH_TYPES`, then `@deprecated` and remove via `exported-symbol-guard`-compliant `refactor()` commit. Subtask of Phase 2.2.
4. **OAuth callback URL strategy (HLD OQ-7 / feature-spec OQ-5)**: Resolved in the 2026-05-07 hardening pass. The browser redirect target is the single route `GET /oauth/auth-profile-callback`, which uses the shared callback finalizer and returns a popup handoff page. Project/workspace/admin POST callback routes remain as authenticated API fallbacks and delegate to the same finalizer.
5. **`usageMode='user_token'` workspace disposition (HLD OQ-8 / feature-spec OQ-10)**: FR-13 rejects `usageMode: 'jit' | 'preflight'` at workspace scope but does not address `'user_token'`. Implementer in Phase 3.B must either explicitly add it to the rejection list OR document why it is excluded by other validation paths. Decision target: Phase 3.B implementer.
6. **MCP transport file paths (LLD)**: This LLD references `apps/runtime/src/services/mcp/*` for transport refresh wiring (Phase 1.3.c). The known files are `inline-mcp-provider.ts` and `runtime-mcp-provider.ts`; the exact integration point (which provider hosts the refresh hot-swap and SSE close-and-reconnect logic) is not pinned here — implementer must read the existing MCP transport implementation first per CLAUDE.md "Type Safety — Read Before You Write". Decision target: Phase 1.3.c implementer.
7. **Per-protocol handler dispatch in `applyAuth`**: Should the dispatch table be inline in `apply-auth.ts` or extracted to a registry module (`protocol-registry.ts`)? Both viable; inline matches existing pattern for the 11 already-dispatched types. Recommend inline; reconsider if `applyAuth` exceeds ~600 LOC after Phase 4.
8. **HLD/Feature-spec staleness items (HLD OQ-5/6)**: Index count "2 partial" appears in 4 feature-spec locations (185, 388-390, 517, 907) and GAP-3 (line 936); ST-1 missing `redirectUri` (line 674). LLD does not change feature spec; flagged for the next post-impl-sync pass.
