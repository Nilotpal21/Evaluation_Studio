# Test Specification: CORS Configuration

**Feature Spec**: `docs/features/cors.md`
**HLD**: `docs/specs/cors.hld.md`
**LLD**: `docs/plans/2026-03-23-cors-impl-plan.md`
**Status**: PARTIAL
**Last Updated**: 2026-03-23

---

## 1. Coverage Matrix

| FR   | Description                                                         | Unit | Integration | E2E | Manual | Status     |
| ---- | ------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1 | Central CORS config schema (origins, methods, credentials, headers) | ✅   | ❌          | ❌  | ❌     | PARTIAL    |
| FR-2 | Runtime-wide Express CORS middleware applied early in pipeline      | ❌   | ❌          | ❌  | ❌     | NOT TESTED |
| FR-3 | Production validation rejects wildcard/localhost origins            | ✅   | ❌          | ❌  | ❌     | PARTIAL    |
| FR-4 | Default allowed headers include SDK/bootstrap headers               | ✅   | ❌          | ❌  | ❌     | PARTIAL    |
| FR-5 | Channel OAuth falls back to CORS origins for redirect allowlists    | ❌   | ❌          | ❌  | ❌     | NOT TESTED |
| FR-6 | Feature-specific origin checks layer on top of global CORS          | ✅   | ✅          | ❌  | ❌     | PARTIAL    |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API.
No mocks, no direct DB access, no stubbed servers.

### E2E-1: Preflight OPTIONS Request Returns Correct Headers for Allowed Origin

- **Preconditions**: Runtime server started with `CORS_ORIGINS=http://allowed.example.com` in config
- **Steps**:
  1. Send `OPTIONS /api/v1/health` with headers:
     - `Origin: http://allowed.example.com`
     - `Access-Control-Request-Method: POST`
     - `Access-Control-Request-Headers: Content-Type,Authorization`
  2. Assert response status is 204
  3. Assert `Access-Control-Allow-Origin: http://allowed.example.com`
  4. Assert `Access-Control-Allow-Methods` includes `POST`
  5. Assert `Access-Control-Allow-Headers` includes `Content-Type` and `Authorization`
  6. Assert `Access-Control-Allow-Credentials: true`
- **Expected Result**: Preflight succeeds with all required CORS headers present
- **Auth Context**: No auth required for OPTIONS preflight
- **Isolation Check**: N/A -- CORS is deployment-scoped, not tenant-scoped

### E2E-2: Preflight OPTIONS Request Rejects Disallowed Origin

- **Preconditions**: Runtime server started with `CORS_ORIGINS=http://allowed.example.com`
- **Steps**:
  1. Send `OPTIONS /api/v1/health` with headers:
     - `Origin: http://evil.example.com`
     - `Access-Control-Request-Method: POST`
  2. Assert response does NOT include `Access-Control-Allow-Origin` header (or origin mismatch)
- **Expected Result**: Preflight fails -- browser will block the actual request
- **Auth Context**: No auth required
- **Isolation Check**: N/A

### E2E-3: Actual Cross-Origin GET Returns CORS Headers for Allowed Origin

- **Preconditions**: Runtime server started with `CORS_ORIGINS=http://allowed.example.com`
- **Steps**:
  1. Send `GET /api/v1/health` with header `Origin: http://allowed.example.com`
  2. Assert response status is 200
  3. Assert `Access-Control-Allow-Origin: http://allowed.example.com`
  4. Assert `Access-Control-Allow-Credentials: true`
- **Expected Result**: Response includes correct CORS headers
- **Auth Context**: Health endpoint does not require auth
- **Isolation Check**: N/A

### E2E-4: SDK Bootstrap Rejects Disallowed Origin When Key Has allowedOrigins

- **Preconditions**: Runtime server started; SDK public key created with `allowedOrigins: ["http://widget.example.com"]`
- **Steps**:
  1. Send `GET /api/v1/sdk/config/:projectId` with headers:
     - `Origin: http://evil-widget.example.com`
     - `X-Public-Key: <sdk-key>`
  2. Assert response status is 403
  3. Assert response body contains origin rejection error
- **Expected Result**: SDK-level origin enforcement rejects the request even though global CORS may allow it
- **Auth Context**: SDK public key auth
- **Isolation Check**: Verify a different project's SDK key cannot access this project's config

### E2E-5: Multi-Origin Config Allows Multiple Distinct Origins

- **Preconditions**: Runtime server started with `CORS_ORIGINS=http://app1.example.com,http://app2.example.com`
- **Steps**:
  1. Send `GET /api/v1/health` with `Origin: http://app1.example.com` -- assert `Access-Control-Allow-Origin: http://app1.example.com`
  2. Send `GET /api/v1/health` with `Origin: http://app2.example.com` -- assert `Access-Control-Allow-Origin: http://app2.example.com`
  3. Send `GET /api/v1/health` with `Origin: http://app3.example.com` -- assert no CORS allow header for this origin
- **Expected Result**: Both configured origins are allowed; unconfigured origin is rejected
- **Auth Context**: No auth required for health endpoint
- **Isolation Check**: N/A

### E2E-6: Exposed Headers Appear in Response

- **Preconditions**: Runtime server started with default config (exposedHeaders includes `X-Request-Id`, `X-Trace-Id`)
- **Steps**:
  1. Send `GET /api/v1/health` with `Origin: <allowed-origin>`
  2. Assert `Access-Control-Expose-Headers` includes `X-Request-Id` and `X-Trace-Id`
- **Expected Result**: Exposed headers are present so browser JS can read them
- **Auth Context**: No auth required
- **Isolation Check**: N/A

### E2E-7: Credentials Flag Controls Cookie/Auth Header Forwarding

- **Preconditions**: Runtime server started with `CORS_CREDENTIALS=true`
- **Steps**:
  1. Send `OPTIONS /api/v1/health` with `Origin: <allowed-origin>`
  2. Assert `Access-Control-Allow-Credentials: true`
- **Expected Result**: Credentials flag is reflected in preflight response
- **Auth Context**: No auth for preflight
- **Isolation Check**: N/A

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: CORS Config Schema Parses Comma-Separated Origins from Env

- **Boundary**: `packages/config` schema parsing -> Zod validation
- **Setup**: Set `CORS_ORIGINS=http://a.com,http://b.com` in env
- **Steps**:
  1. Call `mapEnvToConfig({ CORS_ORIGINS: 'http://a.com,http://b.com' })`
  2. Parse result through `CORSConfigSchema`
  3. Assert `origins` is `['http://a.com', 'http://b.com']`
- **Expected Result**: Comma-separated string is split into array
- **Failure Mode**: If comma splitting fails, origins becomes a single string containing commas

### INT-2: Production Validation Rejects Wildcard Origins

- **Boundary**: `packages/config` validation -> production-checks
- **Setup**: Create config with `env: 'production'` and `cors.origins: ['*']`
- **Steps**:
  1. Call `validateProductionConfig(config)`
  2. Assert result contains error with field `cors.origins`
  3. Assert error message mentions wildcard
- **Expected Result**: Wildcard origin blocked in production
- **Failure Mode**: If validation is skipped, wildcard allows any browser to call the API

### INT-3: Production Validation Warns on Localhost Origins

- **Boundary**: `packages/config` validation -> production-checks
- **Setup**: Create config with `env: 'production'` and `cors.origins: ['http://localhost:3000']`
- **Steps**:
  1. Call `validateProductionConfig(config)`
  2. Assert result contains warning with field `cors.origins`
  3. Assert warning message mentions localhost
- **Expected Result**: Localhost origin generates warning (not error) in production
- **Failure Mode**: Localhost silently allowed in production without operator awareness

### INT-4: Runtime CORS Middleware Uses Config-Driven Origin List

- **Boundary**: `apps/runtime` server.ts -> `packages/config` cors schema
- **Setup**: Start Runtime Express app with test config `cors.origins: ['http://test.example.com']`
- **Steps**:
  1. Use `supertest` against the Express app
  2. Send `OPTIONS /api/v1/health` with `Origin: http://test.example.com`
  3. Assert response includes `Access-Control-Allow-Origin: http://test.example.com`
- **Expected Result**: Middleware correctly reads from shared config
- **Failure Mode**: Middleware ignores config or uses hardcoded values

### INT-5: SDK Auth Middleware Enforces Per-Key allowedOrigins

- **Boundary**: `apps/runtime` SDK middleware -> SDK key record
- **Setup**: SDK key with `allowedOrigins: ['http://widget.example.com']`
- **Steps**:
  1. Send request with `Origin: http://other.example.com` and valid SDK key
  2. Assert 403 response with origin error
  3. Send request with `Origin: http://widget.example.com` and valid SDK key
  4. Assert 200 response
- **Expected Result**: Per-key origin enforcement works independently of global CORS
- **Failure Mode**: Missing origin check allows any browser to use the SDK key

### INT-6: Channel OAuth Falls Back to CORS Origins for Redirect Validation

- **Boundary**: `apps/runtime` channel-oauth.ts -> `packages/config` cors.origins
- **Setup**: No explicit `oauthAllowedRedirectOrigins` configured; CORS origins set to `['http://studio.example.com']`
- **Steps**:
  1. Call `getAllowedRedirectOrigins()` (or test via OAuth redirect endpoint)
  2. Assert returned origins include `http://studio.example.com`
- **Expected Result**: CORS origins serve as fallback for OAuth redirect validation
- **Failure Mode**: OAuth redirect validation has no origins and blocks all redirects

### INT-7: Production Mode Uses frontendUrl Instead of cors.origins Array

- **Boundary**: `apps/runtime` server.ts -> config resolution
- **Setup**: Config with `env: 'production'`, `server.frontendUrl: 'https://studio.prod.com'`, `cors.origins: ['http://a.com', 'http://b.com']`
- **Steps**:
  1. Start Runtime in production mode
  2. Send request with `Origin: http://a.com` -- should NOT get CORS allow header
  3. Send request with `Origin: https://studio.prod.com` -- should get CORS allow header
- **Expected Result**: Production mode uses `server.frontendUrl` not `cors.origins`
- **Failure Mode**: Production accidentally allows all configured development origins

---

## 4. Unit Test Scenarios

### UT-1: CORSConfigSchema Defaults

- **Module**: `packages/config/src/schemas/cors.schema.ts`
- **Input**: Empty object `{}`
- **Expected Output**: Schema defaults applied -- origins include localhost variants, credentials true, methods include all standard HTTP methods, allowedHeaders include SDK headers

### UT-2: CORSConfigSchema String-to-Array Transform

- **Module**: `packages/config/src/schemas/cors.schema.ts`
- **Input**: `{ origins: "http://a.com, http://b.com" }`
- **Expected Output**: `origins` becomes `["http://a.com", "http://b.com"]` (trimmed)

### UT-3: Env Mapping Includes All CORS Variables

- **Module**: `packages/config/src/env-mapping.ts`
- **Input**: Verify `BASE_ENV_MAPPING` contains `CORS_ORIGINS`, `CORS_CREDENTIALS`, `CORS_METHODS`, `CORS_ALLOWED_HEADERS`
- **Expected Output**: All four env vars are mapped to correct config paths

### UT-4: coerceValue Splits Comma-Separated Values

- **Module**: `packages/config/src/env-mapping.ts`
- **Input**: `"http://a.com,http://b.com"`
- **Expected Output**: `["http://a.com", "http://b.com"]`

### UT-5: SDK Auth Origin Matching Supports Wildcards

- **Module**: `apps/runtime/src/middleware/sdk-auth.ts`
- **Input**: Origin `http://sub.example.com`, allowedOrigins `["*.example.com"]`
- **Expected Output**: Origin is allowed (wildcard match)

---

## 5. Security & Isolation Tests

- [x] Production config rejects wildcard `*` origins (unit test exists)
- [x] Production config warns on localhost origins (unit test exists)
- [x] SDK key `allowedOrigins` enforcement rejects disallowed origins (unit + integration tests exist)
- [ ] Cross-project SDK key cannot access another project's config (E2E needed)
- [ ] Missing SDK key returns 401 (E2E needed)
- [ ] CORS does not leak tenant information through headers
- [ ] `Access-Control-Allow-Origin` never returns `*` when `credentials: true` (browser security constraint)

---

## 6. Performance & Load Tests (if applicable)

CORS middleware is lightweight (config lookup + header comparison). Performance testing is low priority but should verify:

- Preflight overhead < 1ms per request on loaded Runtime
- No per-request config re-parsing (config is loaded once at startup)

---

## 7. Test Infrastructure

- **Required services**: Runtime Express server (started on random port via `{ port: 0 }`)
- **Data seeding**: SDK keys with `allowedOrigins` created via API before test
- **Environment variables**: `CORS_ORIGINS`, `CORS_CREDENTIALS`, `CORS_METHODS`, `CORS_ALLOWED_HEADERS` set per test scenario
- **CI configuration**: Standard `pnpm test` -- no additional infrastructure needed

---

## 8. Test File Mapping

| Test File                                                            | Type        | Covers               |
| -------------------------------------------------------------------- | ----------- | -------------------- |
| `packages/config/src/__tests__/env-mapping.test.ts`                  | unit        | FR-1, INT-1          |
| `packages/config/src/__tests__/validation/production-checks.test.ts` | unit        | FR-3, INT-2, INT-3   |
| `apps/runtime/src/__tests__/middleware/sdk-auth.test.ts`             | unit        | FR-6, INT-5          |
| `apps/runtime/src/__tests__/middleware-sdk-auth.test.ts`             | unit        | FR-6                 |
| `apps/runtime/src/__tests__/sdk-bootstrap-auth.integration.test.ts`  | integration | FR-6, INT-5          |
| `apps/runtime/src/__tests__/cors.e2e.test.ts` (planned)              | e2e         | FR-2, E2E-1 to E2E-7 |
| `apps/runtime/src/__tests__/cors-integration.test.ts` (planned)      | integration | FR-2, INT-4, INT-7   |

---

## 9. Open Testing Questions

1. Should E2E tests for production-mode CORS behavior (INT-7) use a separate Runtime config or a runtime-level feature flag to switch between dev and prod CORS logic?
2. Is there a way to test browser-driven CORS behavior in CI without a real browser (Playwright/headless Chrome)?
3. Should the `exposedHeaders` gap (GAP-002 in feature spec) be tested now, or deferred until the env mapping is implemented?
