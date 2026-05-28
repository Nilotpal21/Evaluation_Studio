# agents.md — apps / admin

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-04-14 — SSO Enterprise Auth / Platform Auth Handoff (ABLP-346)

**Category**: architecture
**Learning**: Admin portal delegates all authentication to Studio rather than implementing its own auth. The pattern is: admin auth routes proxy requests to Studio (Google, Microsoft, SSO, email/password), Studio completes the auth flow and generates a one-time auth code, then the admin callback route (`/api/auth/studio/callback`) exchanges the code for tokens via Studio's `/api/sso/exchange` endpoint and creates an admin session cookie. Super-admin validation happens in `studio-admin-auth.ts` by decoding the JWT and checking the `isSuperAdmin` claim.
**Files**: `src/app/api/auth/` (5 route files), `src/lib/admin-auth-redirect.ts`, `src/lib/studio-admin-auth.ts`, `src/lib/with-admin-route.ts`
**Impact**: All future admin auth work should follow this delegation pattern. Do NOT add direct auth logic (password verification, OAuth token exchange, etc.) in the admin service. The admin service only validates that the Studio JWT has `isSuperAdmin: true`.

## 2026-04-14 — Admin Auth Testing

**Category**: testing
**Learning**: Admin auth route tests (`auth-routes.test.ts`, 9 tests) and `with-admin-route.test.ts` (2 tests) use `vi.mock` and mock `fetch`. They test route handler logic (request validation, error handling, session creation) but do NOT exercise the real Studio API. No E2E tests exist for the full admin-to-Studio auth roundtrip. This is a known gap (GAP-010).
**Files**: `src/__tests__/auth-routes.test.ts`, `src/__tests__/with-admin-route.test.ts`
**Impact**: When adding E2E tests, you need both Studio and Admin servers running. The admin callback depends on Studio's `/api/sso/exchange` and `/api/auth/me` endpoints being available.

## 2026-04-17 — Root TSC Compatibility for Admin Tests

**Category**: gotcha
**Learning**: The repo-root `npx tsc --noEmit` is not a reliable contract for this Next package because it ignores the package's own JSX and module-resolution settings. Do not patch the root `tsconfig.json` with repo-wide `next/server` or `next/headers` path shims. The stable contract is package-scoped validation (`pnpm --filter=@agent-platform/admin exec tsc --noEmit -p tsconfig.json` and `pnpm build --filter=@agent-platform/admin`), while test imports stay ESM-safe with explicit `.js` suffixes on relative imports and dynamic imports.
**Files**: `src/__tests__/auth-routes.test.ts`, `src/__tests__/billing-publication.test.ts`, `src/__tests__/billing-usage-proxy-routes.test.ts`, `src/__tests__/root-tsconfig-contract.test.ts`, `src/__tests__/system-health-route.test.ts`, `src/__tests__/tenant-detail-tabs.test.ts`, `src/__tests__/tenant-lifecycle.e2e.test.ts`, `src/__tests__/with-admin-route.test.ts`
**Impact**: Future admin tests should keep `.js` relative specifiers, and monorepo validation should use the admin package build/typecheck rather than broad repo-root shims that can shadow real Next types across other apps.

## 2026-04-26 — Logging Hygiene Migration (ABLP-579)

**Category**: pattern
**Learning**: Admin server modules should import `createLogger` through `src/lib/logger.ts`, which re-exports the built compiler logger. Package-scoped `tsc` in `apps/admin` does not resolve the compiler package subpath directly, but the local shim keeps the package on the shared logger contract without falling back to raw `console.*`.
**Files**: `src/lib/logger.ts`, `src/lib/with-admin-route.ts`, `src/lib/audit-logger.ts`, `src/app/api/`
**Impact**: Future admin route or lib logging changes should reuse the local logger shim and keep the package-scoped typecheck (`pnpm --filter=@agent-platform/admin exec tsc --noEmit -p tsconfig.json`) as the validation contract.

## 2026-04-26 — Admin Proxy Body Validation Hardening (ABLP-578)

**Category**: pattern
**Learning**: Admin proxy routes that forward JSON to runtime should validate the body locally with shared Zod schemas and a common JSON reader before calling `fetch`. The stable boundary contract is `readValidatedJsonBody()` / `readOptionalValidatedJsonBody()` returning a `400 VALIDATION_ERROR` response for malformed JSON, missing required fields, or unknown keys, and the proxy must forward `parsedBody.data` instead of the raw request payload.
**Files**: `src/lib/admin-proxy-schemas.ts`, `src/lib/validated-json-body.ts`, `src/app/api/`, `src/__tests__/hubspot-route.test.ts`, `src/__tests__/tenant-attachment-config-route.test.ts`
**Impact**: Future admin runtime-proxy routes should add or reuse a strict schema in `admin-proxy-schemas.ts` instead of reading `request.json()` inline, so unexpected fields are rejected at the admin boundary and never forwarded downstream.

### 2026-05-10 — Inlined `coerceValue` in admin config routes must mirror `packages/config`

**Category**: pattern
**Learning**: `apps/admin/src/app/api/config/{route,diff/route}.ts` carry an inlined copy of `coerceValue` / `mapEnvToConfig` to avoid Turbopack bundling the whole `@agent-platform/config` package. That duplication had silently drifted: when `packages/config` added a `STRING_VALUED_ENV_KEYS = {REDIS_URL, MONGODB_URI}` guard so `coerceValue` does not split a comma-separated cluster `REDIS_URL` into a `string[]`, both admin copies still split it. Fix: each copy now declares the same `STRING_VALUED_ENV_KEYS` set and threads `envKey` through `coerceValue`, with an explicit "keep in sync with `packages/config/src/env-mapping.ts`" comment. The Zod redis schema rejects arrays — config diff/inspection in admin would have failed for cluster deployments.
**Files**: `src/app/api/config/route.ts`, `src/app/api/config/diff/route.ts`
**Impact**: When adding behavior to `coerceValue` / env mapping in `packages/config`, **mirror it into both admin route copies in the same change**. Until the Turbopack bundling issue is fixed, treat these copies as a single mental unit. A regression is silent — admin config diff returns garbage for cluster URLs without error.

## 2026-05-13 — Template Store Admin Portal Proxy Pattern (Template Store Phase 3)

**Category**: pattern
**Learning**: Admin BFF proxy routes to external services (beyond runtime) follow the same pattern as `runtime-proxy.ts`. Create a dedicated `<service>-proxy.ts` file in `src/lib/` with `get<Service>Url()` and `build<Service>Headers()` helpers. The URL comes from an env var with a localhost default. All route handlers use `withAdminRoute` for auth, log errors with `createLogger`, and return structured `{ success, error: { code, message } }` on failure with 502 status for connection errors.
**Files**: `src/lib/template-store-proxy.ts`, `src/app/api/templates/route.ts`, `src/app/api/templates/[id]/route.ts`, `src/app/api/templates/upload/route.ts`
**Impact**: When adding proxy routes to new services, replicate this pattern. JWT forwarding requires matching secrets between admin and the target service. The `TEMPLATE_STORE_URL` env var defaults to `http://localhost:3115`.

## 2026-05-17 — Admin Playwright Timeout Floor

**Category**: testing
**Learning**: Admin Playwright should keep its per-test timeout explicit at 60_000ms. With the existing CI retry policy, that keeps failed tests in the 60-180s failure window instead of relying on Playwright's implicit 30s default.
**Files**: `playwright.config.ts`
**Impact**: Future Admin E2E additions should avoid spec-level `test.setTimeout(...)` values above 60_000ms while CI retries remain enabled, or use a separate no-retry long-running lane.

## ABLP-1145 — Allowed Emails Feature (2026-05-21)

### What changed

- `lib/platform-access-policy.ts`: added `addAllowedEmail`, `revokeAllowedEmail` wrappers
- `app/api/access/emails/route.ts`: new GET/POST/DELETE route mirroring `access/domains/`
- `app/(dashboard)/access/page.tsx`: new Allowed Emails panel in 2x2 grid layout
- `lib/audit-logger.ts`: new action types `platform_email_allow`, `platform_email_revoke`

### Learnings

**New API routes follow domains/ pattern exactly**: Admin API routes for new allowlist/admin resources should mirror `apps/admin/src/app/api/access/domains/route.ts` exactly — same import structure, `withAdminRoute`, `readValidatedJsonBody`, `logAdminAction`, return `listAccessPolicy()` after mutations.

**New action types need to be added to audit-logger.ts**: When creating new admin actions, add the action type string to the `AdminAction` union type AND add a case to `inferResourceType`. The compiler will catch missing cases.

**UI panels mirror existing Allowed Domains panel CSS class for class**: Copy Tailwind classes exactly from the existing domain panel into new panels. Using semantic design tokens (not raw palette values). The panel structure is: `rounded-lg border border-border bg-background-subtle p-5`.

**`normalizeEmail` must be exported from admin lib**: The DELETE handler uses `normalizeEmail` to normalize the query param before looking up. Make sure `normalizeEmail` is in the `export {}` block of `apps/admin/src/lib/platform-access-policy.ts`.
