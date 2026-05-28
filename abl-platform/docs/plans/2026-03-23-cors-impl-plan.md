# LLD: CORS Configuration

**Feature Spec**: `docs/features/cors.md`
**HLD**: `docs/specs/cors.hld.md`
**Test Spec**: `docs/testing/cors.md`
**Status**: DRAFT
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                    | Rationale                                                                                     | Alternatives Rejected                                        |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D-1 | Use `config.cors.origins` in production (not `frontendUrl`) | Multi-origin production deployments need the full list; `frontendUrl` limits to single origin | Keep `frontendUrl` behavior (limits multi-origin production) |
| D-2 | Add `CORS_EXPOSED_HEADERS` to env mapping                   | Schema has `exposedHeaders` but no env var to configure it -- operator surface gap            | Leave unmapped (operators cannot configure exposed headers)  |
| D-3 | Add `maxAge` to CORS schema                                 | Reduces preflight frequency; configurable via `CORS_MAX_AGE` env var                          | Hardcode max-age (limits operator control)                   |
| D-4 | Test with `supertest` against real Express app              | Follows existing runtime test patterns (see `sdk-bootstrap-auth.integration.test.ts`)         | Browser-level tests (Playwright -- too heavy for CI)         |
| D-5 | Add debug-level origin rejection logging                    | Operational visibility for CORS debugging without noise in normal operation                   | No logging (current state -- hard to debug in production)    |

### Key Interfaces & Types

The existing `CORSConfig` type from `packages/config/src/schemas/cors.schema.ts` will be extended:

```typescript
// Current (unchanged fields)
export const CORSConfigSchema = z.object({
  origins: z
    .union([z.array(z.string()), z.string().transform((s) => s.split(',').map((o) => o.trim()))])
    .default([...DEFAULT_LOCAL_ORIGINS, 'http://127.0.0.1:5173']),
  credentials: z.boolean().default(true),
  methods: z.array(z.string()).default(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  allowedHeaders: z
    .array(z.string())
    .default([
      'Content-Type',
      'Authorization',
      'X-SDK-Token',
      'X-Public-Key',
      'X-Tenant-Id',
      'X-Request-Id',
    ]),
  exposedHeaders: z.array(z.string()).default(['X-Request-Id', 'X-Trace-Id']),
  // NEW: maxAge for Access-Control-Max-Age header (seconds)
  maxAge: z.number().int().min(0).default(86400), // 24 hours
});
```

### Module Boundaries

| Module                                                | Responsibility                              | Depends On                        |
| ----------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| `packages/config/src/schemas/cors.schema.ts`          | CORS config schema definition and defaults  | Zod, `constants.ts`               |
| `packages/config/src/env-mapping.ts`                  | Maps `CORS_*` env vars to config paths      | None                              |
| `packages/config/src/validation/production-checks.ts` | Validates CORS config for production safety | `cors.schema.ts` (via config obj) |
| `apps/runtime/src/server.ts`                          | Applies global CORS middleware              | `packages/config`, `cors` npm     |

---

## 2. File-Level Change Map

### New Files

| File                                                             | Purpose                                               | LOC Estimate |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| `apps/runtime/src/__tests__/cors-middleware.integration.test.ts` | Integration tests for global CORS middleware behavior | ~200         |
| `apps/runtime/src/__tests__/cors-preflight.e2e.test.ts`          | E2E tests for preflight and response header behavior  | ~250         |

### Modified Files

| File                                                                 | Change Description                                                           | Risk |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| `packages/config/src/schemas/cors.schema.ts`                         | Add `maxAge` field to schema                                                 | Low  |
| `packages/config/src/env-mapping.ts`                                 | Add `CORS_EXPOSED_HEADERS` and `CORS_MAX_AGE` mappings                       | Low  |
| `apps/runtime/src/server.ts`                                         | Fix production origin to use `cors.origins`, add `maxAge`, add debug logging | Med  |
| `packages/config/src/__tests__/env-mapping.test.ts`                  | Add tests for new env var mappings                                           | Low  |
| `packages/config/src/__tests__/validation/production-checks.test.ts` | Verify existing tests still pass after schema changes                        | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable.
No phase should leave the system in a broken state.

### Phase 1: Config Schema & Env Mapping Enhancements

**Goal**: Close the configuration gaps (exposedHeaders env mapping, maxAge field) without changing runtime behavior.

**Tasks**:

1.1. Add `maxAge` field to `CORSConfigSchema` in `packages/config/src/schemas/cors.schema.ts` with default `86400` (24 hours).

1.2. Add `CORS_EXPOSED_HEADERS` mapping in `packages/config/src/env-mapping.ts` pointing to `cors.exposedHeaders`.

1.3. Add `CORS_MAX_AGE` mapping in `packages/config/src/env-mapping.ts` pointing to `cors.maxAge`.

1.4. Add unit tests in `packages/config/src/__tests__/env-mapping.test.ts`:

- Test `CORS_EXPOSED_HEADERS` comma-separated parsing.
- Test `CORS_MAX_AGE` numeric coercion.

  1.5. Verify existing production-checks tests still pass: `pnpm test --filter=@agent-platform/config`.

**Files Touched**:

- `packages/config/src/schemas/cors.schema.ts` -- add `maxAge` field
- `packages/config/src/env-mapping.ts` -- add two new mappings
- `packages/config/src/__tests__/env-mapping.test.ts` -- add tests for new mappings

**Exit Criteria**:

- [ ] `CORSConfigSchema` parses with `maxAge` field (default 86400)
- [ ] `CORS_EXPOSED_HEADERS=X-Custom` maps to `cors.exposedHeaders: ['X-Custom']`
- [ ] `CORS_MAX_AGE=3600` maps to `cors.maxAge: 3600`
- [ ] All existing `packages/config` tests pass
- [ ] `pnpm build --filter=@agent-platform/config` succeeds with 0 errors

**Test Strategy**:

- Unit: Env mapping for new vars, schema parsing for new field
- Integration: N/A for this phase (config-only)

**Rollback**: Remove the new schema field and env mappings. No data migration needed.

---

### Phase 2: Runtime Middleware Fix (Production Multi-Origin)

**Goal**: Fix GAP-001 -- production mode should use the full `cors.origins` array instead of `server.frontendUrl`. Add `maxAge` to the middleware config. Add debug-level logging for origin rejections.

**Tasks**:

2.1. In `apps/runtime/src/server.ts`, update the CORS middleware to always use `config.cors.origins` instead of branching on `config.env`:

```typescript
// Before (current):
origin: config.env === 'production' ? config.server.frontendUrl : config.cors.origins,

// After:
origin: config.cors.origins,
```

2.2. Add `maxAge` to the `corsOptions` object:

```typescript
const corsOptions = {
  origin: config.cors.origins,
  credentials: config.cors.credentials,
  methods: config.cors.methods,
  allowedHeaders: config.cors.allowedHeaders,
  exposedHeaders: config.cors.exposedHeaders,
  maxAge: config.cors.maxAge,
};
```

2.3. Add debug-level logging when an origin is rejected. Wrap the `cors()` call with a custom origin function that logs rejections:

```typescript
const corsOptions = {
  origin: (
    requestOrigin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (!requestOrigin || config.cors.origins.includes(requestOrigin)) {
      callback(null, true);
    } else {
      log.debug('CORS origin rejected', { requestOrigin, allowedOrigins: config.cors.origins });
      callback(null, false);
    }
  },
  // ... rest of options
};
```

2.4. Verify the Runtime builds: `pnpm build --filter=@agent-platform/runtime`.

**Files Touched**:

- `apps/runtime/src/server.ts` -- update CORS middleware block (~10 lines changed)

**Exit Criteria**:

- [ ] Production mode uses `config.cors.origins` array (not `server.frontendUrl`)
- [ ] `maxAge` header is included in CORS responses
- [ ] Origin rejections are logged at debug level
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] Existing runtime tests pass: `pnpm test --filter=@agent-platform/runtime`

**Test Strategy**:

- Unit: Verified via existing test suite (no direct CORS middleware unit tests yet -- covered in Phase 3)
- Integration: Runtime builds and starts without errors

**Rollback**: Revert the single file change in `server.ts`. Env-driven config rollback: set `CORS_ORIGINS` to match `FRONTEND_URL`.

---

### Phase 3: Integration Tests

**Goal**: Add black-box integration tests that verify the global CORS middleware behavior through real HTTP requests.

**Tasks**:

3.1. Create `apps/runtime/src/__tests__/cors-middleware.integration.test.ts` with the following test cases:

- Allowed origin receives `Access-Control-Allow-Origin` header.
- Disallowed origin does NOT receive `Access-Control-Allow-Origin` header.
- `OPTIONS` preflight for allowed origin returns 204 with all CORS headers.
- `Access-Control-Allow-Credentials: true` is present.
- `Access-Control-Allow-Methods` matches configured methods.
- `Access-Control-Allow-Headers` matches configured headers.
- `Access-Control-Expose-Headers` includes configured exposed headers.
- Multi-origin config correctly allows multiple distinct origins.

  3.2. Use the existing `startRuntimeServerHarness` pattern from `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` (or a lightweight Express test helper that starts the real middleware chain).

  3.3. Tests must NOT mock the `cors` npm package or the config system -- they must use real config values and real Express middleware.

**Files Touched**:

- `apps/runtime/src/__tests__/cors-middleware.integration.test.ts` -- new file (~200 LOC)

**Exit Criteria**:

- [ ] 8+ integration test cases covering INT-1 through INT-7 from the test spec
- [ ] All tests pass with `pnpm test --filter=@agent-platform/runtime`
- [ ] No `vi.mock()` or `jest.mock()` in the test file
- [ ] Tests use real HTTP requests (supertest or fetch against live Express)

**Test Strategy**:

- Integration: Real Express app with test config, `supertest` for HTTP requests

**Rollback**: Delete the test file. No production code changes.

---

### Phase 4: E2E Tests

**Goal**: Add E2E tests that verify CORS behavior from a browser-client perspective against a fully running Runtime server.

**Tasks**:

4.1. Create `apps/runtime/src/__tests__/cors-preflight.e2e.test.ts` with the following scenarios:

- E2E-1: Preflight OPTIONS for allowed origin returns correct headers.
- E2E-2: Preflight OPTIONS for disallowed origin is rejected.
- E2E-3: Actual cross-origin GET includes CORS headers.
- E2E-5: Multi-origin config allows multiple distinct origins.
- E2E-6: Exposed headers appear in response.
- E2E-7: Credentials flag is reflected in preflight.

  4.2. Use `startRuntimeServerHarness` to start a full Runtime instance (same pattern as `sdk-bootstrap-auth.integration.test.ts`).

  4.3. Tests must start real servers with full middleware chain -- no mocking, no stubbing.

**Files Touched**:

- `apps/runtime/src/__tests__/cors-preflight.e2e.test.ts` -- new file (~250 LOC)

**Exit Criteria**:

- [ ] 6+ E2E test cases covering E2E-1 through E2E-7 from the test spec
- [ ] All tests pass with `pnpm test --filter=@agent-platform/runtime`
- [ ] Tests use `startRuntimeServerHarness` (full middleware chain)
- [ ] No `vi.mock()` or `jest.mock()` in the test file

**Test Strategy**:

- E2E: Full Runtime server on random port, HTTP requests via fetch/supertest

**Rollback**: Delete the test file. No production code changes.

---

### Phase 5: Documentation & Feature Spec Updates

**Goal**: Update all documentation to reflect the implemented changes.

**Tasks**:

5.1. Update `docs/features/cors.md`:

- Close GAP-001 (production multi-origin) -- mark as Resolved.
- Close GAP-002 (exposedHeaders env mapping) -- mark as Resolved.
- Close GAP-003 (no black-box tests) -- mark as Resolved.
- Update Configuration section with new env vars (`CORS_EXPOSED_HEADERS`, `CORS_MAX_AGE`).
- Update status from BETA toward STABLE criteria check.

  5.2. Update `docs/testing/cors.md`:

- Update coverage matrix with implemented test coverage.
- Update test file mapping with actual file paths.

  5.3. Update `docs/specs/cors.hld.md`:

- Mark open questions as resolved.

**Files Touched**:

- `docs/features/cors.md`
- `docs/testing/cors.md`
- `docs/specs/cors.hld.md`

**Exit Criteria**:

- [ ] All GAP entries in feature spec updated with correct status
- [ ] Coverage matrix in test spec reflects actual test coverage
- [ ] No stale information in any documentation file

**Test Strategy**:

- Manual: Review all documentation for accuracy

**Rollback**: Revert documentation changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [ ] New `maxAge` schema field is consumed by `server.ts` CORS middleware options
- [ ] New `CORS_EXPOSED_HEADERS` env mapping is consumed by Zod schema (via env-mapping -> config resolution)
- [ ] New `CORS_MAX_AGE` env mapping is consumed by Zod schema (via env-mapping -> config resolution)
- [ ] New integration test file is discovered by vitest (matches `**/*.test.ts` pattern in `apps/runtime`)
- [ ] New E2E test file is discovered by vitest (matches `**/*.test.ts` pattern in `apps/runtime`)
- [x] No new services to register (CORS is middleware, not a service)
- [x] No new routes to register (CORS applies globally, not per-route)
- [x] No new models to register (config-driven, no MongoDB)
- [x] No new UI components (no Studio CORS management page)
- [x] No new workers (CORS is synchronous middleware)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. CORS is entirely config-driven.

### Feature Flags (if applicable)

None needed. The production multi-origin change (Phase 2) is safe because:

- If `CORS_ORIGINS` is already set correctly for production, behavior is unchanged.
- If `CORS_ORIGINS` is not set, the schema defaults apply (localhost origins -- same as before for non-production).
- The only behavioral change is that production mode now uses the full `cors.origins` array instead of `server.frontendUrl`. Operators who set `CORS_ORIGINS` to their production origins will get multi-origin support immediately.

### Configuration Changes

| Env Var                | Type   | Default                                   | Phase |
| ---------------------- | ------ | ----------------------------------------- | ----- |
| `CORS_EXPOSED_HEADERS` | string | Schema default: `X-Request-Id,X-Trace-Id` | 1     |
| `CORS_MAX_AGE`         | number | `86400` (24 hours)                        | 1     |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] GAP-001 (production multi-origin) resolved -- `server.ts` uses `config.cors.origins`
- [ ] GAP-002 (exposedHeaders env mapping) resolved -- `CORS_EXPOSED_HEADERS` mapped
- [ ] GAP-003 (no black-box tests) resolved -- integration + E2E tests passing
- [ ] 8+ integration tests passing (Phase 3)
- [ ] 6+ E2E tests passing (Phase 4)
- [ ] No regressions in existing tests (`pnpm build && pnpm test` for affected packages)
- [ ] Feature spec updated with implementation details
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. Should the custom origin function (D-5, debug logging) be extracted into a shared utility for reuse by other origin-checking middleware (SDK auth, OAuth)?
2. Should `Access-Control-Max-Age` have a minimum value enforced in production validation (e.g., warn if < 300 seconds)?
3. Should the `server.frontendUrl` config key be deprecated for CORS purposes, or retained as a fallback when `cors.origins` is empty?
