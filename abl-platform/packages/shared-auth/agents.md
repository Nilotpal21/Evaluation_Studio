# shared-auth — package learnings

Append-only log. Read before modifying. Write after completing changes that surface a non-obvious contract.

## 2026-04-27 — Platform JWTs require explicit audience + issuer

**Category**: contract
**Learning**: `verifyPlatformAccessToken()` (in `purpose-jwt.ts`) strictly enforces `issuer: 'abl-platform'` (`PLATFORM_JWT_ISSUER`) and `audience: 'platform-access'` (`PLATFORM_ACCESS_TOKEN_AUDIENCE`) on every token it accepts. Tokens signed with `jwt.sign(payload, secret)` and no options will fail with `WRONG_AUDIENCE` or `WRONG_ISSUER`. The whole purpose-jwt module exists so different token classes (platform access, SDK session, Studio session, feedback, Gupshup webhook) each have a distinct audience and a `verifyPurposeJwt(...)` chokepoint that refuses cross-purpose reuse. Do NOT bypass this with raw `jwt.sign` / `jwt.verify`.
**Files**: `src/purpose-jwt.ts`, `src/middleware/jwt-verify.ts`, `src/__tests__/jwt-verify.test.ts`, `src/__tests__/unified-auth.test.ts`
**Impact**: Any new helper that mints platform access tokens must call `signPlatformAccessToken(payload, secret, opts)` (or pass the options object explicitly to `jwt.sign`). Test fixtures across the monorepo (`packages/shared/src/__tests__/jwt-verify.test.ts`, `apps/academy/src/__tests__/e2e/helpers/academy-harness.ts` `mintToken()`, `apps/studio` integration helpers, `apps/runtime/src/__tests__/auth/...`) must import `PLATFORM_JWT_ISSUER` and `PLATFORM_ACCESS_TOKEN_AUDIENCE` from `@agent-platform/shared-auth` and pass them as `jwt.sign` options. The shared-auth's own `unified-auth.test.ts` `makeJwt` helper is the canonical example. Bare `jwt.sign(payload, secret)` returning 401 in an integration test = audience/issuer missing.

## 2026-04-27 — Token-class verifiers are NOT interchangeable

**Category**: contract
**Learning**: `verifyPlatformAccessToken`, `verifySDKSessionToken`, `verifyStudioSessionToken`, `verifyFeedbackToken`, `verifyGupshupWebhookToken` each enforce a distinct `audience` AND a `type`/`source`/`purpose` discriminator. Cross-feeding (e.g. an SDK session token to `verifyPlatformAccessToken`) throws `WRONG_AUDIENCE`. The `signXxx` helpers must produce tokens in the matching audience or downstream verify fails closed. This is intentional separation of token purposes so a leaked/stolen token from one surface (e.g. a feedback CSAT link) cannot be replayed against another (e.g. the platform API).
**Files**: `src/purpose-jwt.ts`, `src/__tests__/jwt-verify.test.ts`
**Impact**: When introducing a new token class, define a new `XYZ_TOKEN_AUDIENCE` constant, a `signXyzToken` helper that sets it, and a `verifyXyzToken` helper that requires it. Never reuse an existing audience for a new purpose — and never accept multiple audiences in a single verify call.

## 2026-04-28 — Prompt Library: PERMISSION_REGISTRY + Auto-Derived Allowlist

**Category**: pattern
**Learning**: New `prompt:*` permissions (6 entries) were registered in `PERMISSION_REGISTRY` and assigned to built-in project roles in `role-permissions.ts`. The `STUDIO_PROJECT_PERMISSION_ALIASES` map was also extended to wire `PROMPT_*` Studio permission constants to the runtime `prompt:*` strings. Both must be updated together — the PERMISSION_REGISTRY determines valid permissions, while the aliases map determines Studio-to-runtime mapping.
**Files**: `src/rbac/role-permissions.ts`, `src/__tests__/role-permissions-prompt-library.test.ts`
**Impact**: When adding new resource permissions, always update BOTH the PERMISSION_REGISTRY and the STUDIO_PROJECT_PERMISSION_ALIASES. UT-6 verifies role map completeness; run it after adding permissions.

## 2026-04-28 — External Agent Registry: Permission Registration

**Category**: pattern
**Learning**: Added `external_agent:create/read/update/delete` to PERMISSION_REGISTRY and `external_agent:*` to developer role, `external_agent:read` to tester and viewer in PROJECT_ROLE_PERMISSIONS. No STUDIO_PROJECT_PERMISSION_ALIASES update was needed for this feature — that map does not exist in shared-auth. The pattern is: PERMISSION_REGISTRY for the custom-role allowlist validation, PROJECT_ROLE_PERMISSIONS for built-in role grants.
**Files**: `src/rbac/role-permissions.ts`
**Impact**: Follow the same 2-site pattern (PERMISSION_REGISTRY + PROJECT_ROLE_PERMISSIONS) for new resource permissions.
