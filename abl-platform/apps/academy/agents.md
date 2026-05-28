# apps/academy — Agent Learnings

## Package Overview

Standalone Express service for the Learning Academy API. Depends on `@agent-platform/academy` (library package) for business logic, storage, and content services. This app is the HTTP shell: auth, routing, health checks, and server lifecycle.

## Build & Test

- `npx tsc --noEmit -p apps/academy/tsconfig.json` — typecheck
- Must build dependency packages first: `packages/config`, `packages/shared-observability`, `packages/shared-auth`, `packages/shared-kernel`, `packages/academy`
- Pre-existing TS errors in `packages/database` (shared-encryption imports) do not affect this package

## Architecture

- **Follows template-store pattern exactly**: same middleware chain (helmet, cors, compression, requestId, observability), same auth middleware (`createUnifiedAuthMiddleware`), same error handler (`errorToResponse`), same server lifecycle (graceful shutdown).
- **Academy services initialized at startup**: `initMongoBackend()` creates `MongooseAcademyStorage` and wires all services via `createAcademyServices()`. Routes access services via `getAcademyServices()` singleton.
- **Auth**: All academy routes require authentication (`requireAuth` middleware). userId extracted from `(req as any).user?.id`.
- **Routes mounted at `/api/v1/academy/`** with auth middleware applied at mount level in server.ts.

## Gotchas

1. **Router type annotation required**: In composite TS projects with `declaration: true`, Express `Router()` needs explicit `IRouter` type annotation to avoid TS2742 errors about inferred types referencing non-portable module paths.
2. **Content root**: Defaults to `packages/academy/content/` relative to the academy library package. Override via `ACADEMY_CONTENT_ROOT` env var.
3. **Studio proxy**: Studio rewrites `/api/academy/*` to `/api/v1/academy/*` on the Academy service. The proxy block must be placed BEFORE the template-store proxy in `apps/studio/src/proxy.ts`.
4. **Dockerfile sync**: When adding `apps/academy/`, must add `COPY apps/academy/package.json` to ALL other app Dockerfiles for pnpm workspace resolution.
5. **Port 3116**: Registered as `DEFAULT_ACADEMY_PORT` in `packages/config/src/constants.ts`.

## E2E Tests

- **Location**: `apps/academy/src/__tests__/e2e/academy-api.test.ts`
- **Run**: `npx vitest run --root apps/academy`
- **Config**: `apps/academy/vitest.config.ts` (fileParallelism: false, 30s timeouts)
- **DevDeps added**: `jsonwebtoken`, `@types/jsonwebtoken`, `mongodb-memory-server`

### E2E Test Architecture

- Tests use a **test-specific Express app** (not the production `server.ts` app) to avoid importing `@agent-platform/database/models` through the production auth middleware chain.
- Route handlers in the test mirror `routes/academy.ts` exactly (same Zod schemas, same service calls) but accept injected services instead of using the `getAcademyServices()` singleton.
- Auth uses `jsonwebtoken` directly to verify JWT tokens (same library as shared-auth) — this is NOT mocking, it's a lightweight app configuration.
- MongoDB uses `mongodb-memory-server` with `mongoose.createConnection()` (not `MongoConnectionManager`).
- Content is loaded from real `packages/academy/content/` files.
- `clearRateLimits()` and `clearContentCaches()` are called in `beforeEach` to reset in-memory state between tests.

### Why not use the production app directly?

The production auth middleware (`middleware/auth.ts`) calls `import('@agent-platform/database/models')` for `getUserById` and `resolveTenantMembership`. This loads the entire model chain (60+ Mongoose models, encryption, etc.) which is unnecessary for testing academy-specific business logic. The test app configuration exercises the same services, validation, and DB operations through real HTTP without this heavyweight dependency.

## 2026-04-17 — E2E Harness Env Seeding

- **Category**: testing
- **Learning**: In the current Node type definitions, `process.env.NODE_ENV` is treated as read-only in test code. Seed harness environment variables with `Object.assign(process.env, { ... })` instead of direct property assignment to keep repo-root `tsc --noEmit` clean.
- **Files**: `src/__tests__/e2e/helpers/academy-harness.ts`
- **Impact**: Future academy test harnesses should update env in one object assignment or through helper functions rather than `process.env.FOO = ...` when `FOO` has a readonly declaration.
