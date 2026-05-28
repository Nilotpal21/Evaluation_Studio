# Template Store - Package Learnings

## Build Quirks

- **Mongoose `.lean()` type args**: In this project's tsconfig (NodeNext module resolution), `lean<ITemplate>()` causes TS2347. Use `lean().exec() as Promise<ITemplate[]>` instead.
- **Express Router type annotation**: `const router = Router()` causes TS2742 (inferred type not portable). Fix: `const router: RouterType = Router()` with `import { Router, type Router as RouterType } from 'express'`.
- **Turbo lockfile warning**: `WARNING Unable to calculate transitive closures: Workspace 'apps/template-store' not found in lockfile` -- this is benign and resolves after `pnpm install`.

## Patterns

- **Dynamic model imports**: All repo functions use `const { Template } = await import('@agent-platform/database/models')` to avoid loading models before DB is ready.
- **Base filter enforcement**: All browse queries include `{ status: 'published', visibility: 'public' }` -- this is the security boundary for Phase 1.
- **Fire-and-forget analytics**: `trackEvent()` catches errors internally. Callers should still `.catch()` the promise.
- **Middleware ordering on marketplace routes**: `optionalAuth` -> `rateLimiter` -> `marketplaceRouter`. Auth must run first so rate limiter sees the real IP (trust proxy).
- **Trust proxy**: `app.set('trust proxy', 1)` must be set before rate limiter middleware so `req.ip` resolves correctly from `X-Forwarded-For`.

## Configuration

- Port 3115 (from `@agent-platform/config/constants`).
- All config in `src/config.ts`, loaded from env vars with development defaults.
- Rate limiting: 100 req/60s per IP, in-memory (not shared across pods).

## Seed Script

- Run with: `pnpm tsx apps/template-store/src/scripts/seed-templates.ts`
- Uses `ensureConnected()` from database barrel (not MongoConnectionManager) since it's a standalone script.
- Idempotent via upsert by slug.
- Must have `.env` loaded (or MONGODB_URL set) for DB connection.

## Testing (Phase 3)

- Integration tests should start real Express server on random port.
- Seed test data via Mongoose in beforeAll (infrastructure setup).
- Assert via HTTP only -- no direct DB queries in test assertions.

### Testing Learnings (Implemented)

- **MongoMemoryServer**: Requires `pool: 'forks'` in vitest config because mongoose uses module-level singletons.
- **Index sync ordering**: Must `import('@agent-platform/database/models')` BEFORE `syncIndexes()` — otherwise text indexes aren't registered and `$text` queries fail with "text index required for $text query".
- **Per-describe cleanup**: Top-level `afterEach(clearCollections)` will wipe `beforeAll` seed data mid-describe. Use per-describe lifecycle management instead.
- **Rate limiting tests**: Create a separate Express app instance with tight limits (5 req/10s) to avoid interfering with other test suites.
- **View count verification**: Verify via second GET to detail endpoint (`/api/v1/marketplace/templates/:slug`), not direct DB query (per CLAUDE.md E2E standards).
- **TemplateVersion seeding**: Requires `createdBy` field — easy to miss, causes validation error.
- **Config singleton**: `getConfig()` is a lazy singleton — can't easily reset between tests. For integration tests, build Express app inline with `marketplaceRouter` rather than importing the full `app` from server.ts.

### Studio Component Test Learnings

- Global `setup.tsx` mocks `next-intl` and `next/navigation`. Marketplace locale (`marketplace.json`) must be added to `allMessages` in setup.tsx.
- Store tests mock `@/lib/api-client` (external API boundary) — this is allowed since it's the fetch wrapper, not a codebase component.
- E2E Playwright specs test against running services — they use `env.baseUrl` from `e2e/helpers/env.ts`.

## Phase 2 Learnings (2026-05-13)

- **BASE_FILTER expanded**: Now includes `reviewStatus: 'approved'` in addition to `status: 'published'` and `visibility: 'public'`. All existing browse queries automatically filter by review status.
- **`.select('-files')` on version queries**: `findLatestPublishedVersion()` now excludes the `files` field (potentially 4MB). Only `findBundleBySlugAndVersion()` returns files. The TypeScript type still shows `files` on `ITemplateVersion` but the value will be `undefined` when loaded via browse/detail.
- **Bundle route ordering**: `GET /templates/:slug/versions/:version/bundle` MUST be registered before `GET /templates/:slug` in Express or the `:slug` param will capture the full path.
- **Static asset serving**: Uses `fileURLToPath(import.meta.url)` for ESM-safe `__dirname`. Path `../public/assets/templates` is relative to compiled `dist/server.js`.
- **Database dist/ staleness**: Template-store reads from `@agent-platform/database/models` which resolves to `packages/database/dist/`. After schema changes, must rebuild the database package (`tsc` or `pnpm build`) before template-store will see the new types. Running `npx tsc --noEmit` in template-store will fail with stale dist/ even if the source is correct.

## Phase 3 Learnings (2026-05-14)

### CRITICAL: Cross-Service Auth — Do NOT Forward JWTs to Public Endpoints

**Problem**: Studio's install flow fetches bundles from template-store via server-to-server HTTP. The initial implementation forwarded Studio's `Authorization: Bearer <jwt>` header. Template-store's `optionalAuth` middleware received a JWT it couldn't verify (different JWT secret) and returned 401 — even though the bundle endpoint is public and doesn't require auth.

**Root cause**: In a multi-service architecture, each service has its own JWT secret. `optionalAuth` using `createUnifiedAuthMiddleware` rejects unrecognized tokens instead of silently ignoring them. This is a middleware behavior issue — "optional" should mean "use if valid, skip if not" but the implementation treats invalid tokens as errors.

**Fix applied**: Removed `Authorization` header from all Studio→template-store server-to-server HTTP calls (`fetchTemplateBundle`, `fetchTemplatePrerequisites`, `notifyInstallEvent`) since all template-store public endpoints work without auth.

**Rule**: When making server-to-server calls to public endpoints in another service, do NOT forward user credentials. Only forward auth when: (a) the target endpoint requires it, AND (b) both services share the same auth infrastructure (same JWT secret / same auth provider).

**Tests added**: Three integration tests in `marketplace.test.ts` verify that browse, bundle, and detail endpoints return 200 (not 401) when a foreign/unverifiable JWT is present in the Authorization header.

### CRITICAL: Seed Content Must Be Import-Pipeline Compatible (Bug 2)

**Problem**: Seed templates used `AGENT supervisor` (no colon) in ABL files. The `@abl/core` parser accepts both formats, but the import pipeline's `validateAgentSyntax()` in `import-validator.ts` requires the colon format (`AGENT: supervisor`). Seed data was stored correctly in MongoDB but failed when consumed by the import pipeline during install.

**Root cause**: The seed script author tested against the parser (which is lenient) instead of the import pipeline (which is strict). Tests validated seed structure in MongoDB but never validated that the stored content would survive import validation.

**Fix applied**: Changed `buildAgentDsl()` in the seed script to emit `AGENT: ${agentName}` (with colon).

**Rule**: Every seed template's `files` bundle MUST pass a round-trip test: seed -> extract bundle -> feed through `validateAgentSyntax()` for each agent file -> feed through `importProjectV2(dryRun: true)` -> assert zero blocking issues. The seed content's consumer is the import pipeline, not the parser.

### CRITICAL: Import Pipeline Requires Acknowledgement for Non-Blocking Issues (Bugs 3 & 4)

**Problem**: `applyStudioLayeredImportV2` requires `previewDigest` + `acknowledgedIssueIds` when the preview contains non-blocking issues. A fresh template import typically produces ~24 non-blocking warnings. The initial install routes called apply directly without running preview first, causing the import to fail.

**Root cause**: The import pipeline's acknowledgement mechanism was designed for interactive imports (user reviews warnings in Studio UI). Template installs are non-interactive — the user already chose to install.

**Fix applied**: Both project and agent install routes now:

1. Run `previewStudioLayeredImportV2` first
2. Check for blocking issues (fail with `IMPORT_BLOCKED` if found)
3. Auto-acknowledge all non-blocking issues
4. Call `applyStudioLayeredImportV2` with the preview digest and acknowledged issue IDs

**Rule**: Install route tests MUST use real `previewStudioLayeredImportV2` and `applyStudioLayeredImportV2` functions (not mocked). The acknowledgement mechanism, preview digest validation, and conflict strategy logic are inside these functions — mocking them hides their requirements.

### Other Phase 3 Learnings

- **Install routes live in Studio, not template-store**: The import pipeline (`importProjectV2`) requires direct MongoDB access, cross-reference resolution, and project-scoped lifecycle management that only Studio has. Template-store just provides the bundle.
- **Agent install route paths need `[id]`**: `withRouteHandler({ requireProject: true })` resolves projectId from `params.id` (URL segment), NOT from the request body. Routes must be `/api/template-install/agent/[id]/preview` and `/api/template-install/agent/[id]/apply`.
- **Fire-and-forget install-event**: After successful install, Studio notifies template-store to increment `installCount`. This is fire-and-forget (`.catch()` with log.warn) — install success is NOT dependent on the analytics call succeeding.
- **Status code 201 for project install**: Creating a project from a template returns 201 (resource created), consistent with `POST /api/projects` which also returns 201.

### Testing Anti-Patterns Discovered (Phase 3 Regression — 2026-05-13)

These patterns allowed 5 bugs to ship undetected. Avoid them in all future template-store tests:

1. **Test server missing middleware**: The main integration test server skipped `optionalAuth` middleware. Bug 1 (foreign JWT 401) only manifests WITH the middleware. Rule: if production has middleware, the test server must have it too.
2. **Seed validation at wrong layer**: Tests checked seeds at the MongoDB layer (correct structure) but not at the consumer layer (import pipeline compatibility). Rule: validate seed content at the consumer's interface, not the producer's.
3. **Mocked import pipeline in route tests**: Tests mocked `applyStudioLayeredImportV2`, hiding its `previewDigest` + `acknowledgedIssueIds` requirements. Rule: integration tests for install routes must use real import pipeline functions.
4. **No cross-service call testing**: Studio -> template-store HTTP calls were never tested. Rule: when Service A calls Service B, test with Service B's actual middleware stack.

### Regression Test Patterns (Phase 3 — 2026-05-14)

- **Seed validation against import pipeline**: Use `validateAgentSyntax` and `validateImport` from `@agent-platform/project-io/import` to validate seed template ABL content. This catches format mismatches (e.g., `AGENT name` vs `AGENT: name`) that the parser accepts but the import pipeline rejects.
- **Exporting seed helpers for tests**: `buildSeedTemplates()` in `seed-templates.ts` was made `export` so tests can import the seed data directly without needing a database. The seed script's `main()` function still runs as a side effect on import, but fails harmlessly without MONGODB_URL.
- **POST request helper**: The `request()` helper in marketplace.test.ts now accepts an optional `body` parameter for testing POST endpoints.
- **Fire-and-forget verification**: Install-event operations (incrementInstallCount, trackEvent) are fire-and-forget. Tests need a `setTimeout(500)` wait before asserting side effects.
- **Install-event 200 for nonexistent slugs**: The install-event endpoint returns 200 regardless of slug existence because it's designed for fire-and-forget use from Studio. MongoDB `$inc` on nonexistent documents is a no-op.

## Template Manager UI Learnings (Phase 3 — 2026-05-13)

- **TemplateEditDialog re-creates state from props**: The edit dialog initializes form state from the `template` prop on mount. If the dialog is opened for a different template, it must be unmounted and re-mounted (achieved via the `{editTarget && <TemplateEditDialog ...>}` pattern — React unmounts when `editTarget` becomes null).
- **`publisherTenantId` override for superadmin**: Superadmin portal passes `publisherTenantId` as a query param because the superadmin JWT has the platform tenantId, not the workspace tenantId. The BFF route in `apps/admin` translates this.
- **Superadmin BFF pattern**: Admin portal uses BFF (Backend For Frontend) routes at `/api/template-admin/templates` that proxy to template-store's admin API. This avoids exposing the template-store admin API directly to the browser.
- **`tenantId` query param workaround**: When superadmin needs to manage workspace-scoped templates, the `tenantId` is passed as a query parameter to the admin API, overriding the JWT's `tenantId`. This is a necessary workaround because the superadmin JWT represents the platform tenant, not the workspace tenant.
- **Table columns already present**: The TemplateManagerPage table was built with all columns (Name, Type, Category, Status with colored badges, Downloads, Created date) from initial implementation — no additional column work needed.
- **Archive confirmation via ConfirmDialog**: Uses the design-system `ConfirmDialog` component with `variant="danger"` for destructive actions.

## Admin API Learnings (Phase 1 — 2026-05-13)

- **Express Request type augmentation**: The global augmentation from `@agent-platform/shared-auth/types/express.d.ts` (`req.user`, `req.tenantContext`) is NOT picked up by `tsc --noEmit` in this package's tsconfig. Must define a local `AuthenticatedRequest` interface (extending `Request` with `user?: AuthUser` and `tenantContext?: TenantContextData`) and cast `req as AuthenticatedRequest`. Same pattern as `marketplace.ts`.
- **`@agent-platform/project-io` is a runtime dependency**: The admin upload route uses `readFolderV2` and `validateAgentSyntax` at request time. It must be in `dependencies` (not `devDependencies`) and in `tsconfig.json` references.
- **`readFolderV2()` requires `Map<string, string>`**: The request body has a JSON object (`Record<string, string>`), but `readFolderV2` takes a `Map`. Convert with `new Map(Object.entries(files))`.
- **Admin repo functions skip BASE_FILTER**: Unlike marketplace browse functions, admin CRUD functions do NOT apply `{ status: 'published', visibility: 'public', reviewStatus: 'approved' }`. Ownership is enforced via `publisherTenantId` filter instead.
- **Slug uniqueness**: `generateUniqueSlug()` checks for existing slugs and appends a random hex suffix on collision. This is a simple approach; for high-volume concurrent uploads, a retry loop with a different suffix would be safer.
- **Upload creates draft templates**: Templates created via upload start as `status: 'draft'` with `reviewStatus: 'pending'`. They must be explicitly published via `PATCH /templates/:id` with `{ status: 'published', reviewStatus: 'approved' }` before they appear in the public marketplace.
- **Route mount ordering**: Admin routes are mounted AFTER marketplace routes, BEFORE the 404 handler. Since they're on different prefixes (`/api/v1/admin` vs `/api/v1/marketplace`), order between them doesn't matter for Express route matching — but both must be before the 404 catch-all.
