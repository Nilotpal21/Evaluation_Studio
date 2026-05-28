# HLD: CORS Configuration

**Feature Spec**: `docs/features/cors.md`
**Test Spec**: `docs/testing/cors.md`
**Status**: APPROVED
**Date**: 2026-03-23

---

## 1. Problem Statement

Browser-based clients (Studio, SDK widgets, OAuth popup flows) need a predictable, centrally managed cross-origin policy when calling the Runtime HTTP API. Without a unified CORS feature:

- Each browser-facing route would need ad hoc origin handling, leading to inconsistency and security gaps.
- Operators would have no single configuration surface for controlling which origins, methods, and headers are permitted.
- Production deployments could accidentally ship with wildcard or localhost origins, exposing the Runtime API to any browser.
- Feature-specific origin checks (SDK key `allowedOrigins`, OAuth redirect validation) would have no shared foundation to fall back on.

The implementation must align with the platform's core invariants: centralized config via `packages/config`, stateless middleware (no per-request DB calls), and production safety validation.

---

## 2. Alternatives Considered

### Option A: Per-Route Origin Handling

- **Description**: Each route that needs CORS (SDK, chat, health, OAuth) adds its own `cors()` middleware with route-specific options.
- **Pros**:
  - Fine-grained control per route.
  - No global middleware overhead for internal-only routes.
- **Cons**:
  - Origin allowlists duplicated across routes.
  - Easy to forget CORS on new routes, causing silent browser failures.
  - No central config or production validation.
  - Violates DRY -- every new browser-facing route must remember to add CORS.
- **Effort**: M (initial), L (ongoing maintenance burden)

### Option B: Global Express Middleware with Centralized Config (Chosen)

- **Description**: A single `cors()` middleware is registered early in the Express pipeline in `server.ts`. The middleware reads its configuration from the shared `packages/config` CORS schema, which is populated from environment variables. Feature-specific origin checks (SDK keys, OAuth redirects) layer on top of the global policy.
- **Pros**:
  - Single source of truth for origin/method/header policy.
  - Production validation catches unsafe settings before deployment.
  - New routes automatically inherit the global policy without code changes.
  - Feature-specific checks can further restrict (never need to widen) the global policy.
  - Config is stateless -- loaded once, no per-request DB calls.
- **Cons**:
  - Global policy cannot express per-route exceptions (all routes share the same origin list).
  - Production mode currently narrows to `server.frontendUrl` (a single string) instead of the full `cors.origins` array, limiting multi-origin production deployments.
- **Effort**: S (already implemented)

### Option C: Reverse Proxy CORS (Nginx/Envoy)

- **Description**: Delegate CORS handling entirely to the reverse proxy in front of Runtime.
- **Pros**:
  - Runtime code has zero CORS logic.
  - Proxy-level CORS is well-understood operationally.
- **Cons**:
  - Development environments (no proxy) would have no CORS support.
  - Production validation (wildcard rejection, localhost warnings) would need separate tooling.
  - Feature-specific origin checks (SDK, OAuth) still need application-level logic.
  - Loss of feature integration -- OAuth redirect validation cannot fall back to proxy-managed origins.
- **Effort**: M

### Recommendation: Option B (Global Express Middleware)

**Rationale**: Option B is already implemented and provides the best balance of simplicity, safety, and extensibility. The global middleware covers the common case, while feature-specific checks (SDK, OAuth) handle stricter requirements at the application level. The production validation in `packages/config` catches operator mistakes before deployment. The main improvement needed is closing the gap where production mode uses `server.frontendUrl` (single origin) instead of the full `cors.origins` array.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser Clients                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Studio   │  │  SDK Widget  │  │  OAuth Popup/Redirect│  │
│  └─────┬────┘  └──────┬───────┘  └──────────┬───────────┘  │
│        │               │                     │               │
└────────┼───────────────┼─────────────────────┼───────────────┘
         │               │                     │
    Origin: studio.com   Origin: widget.com    Origin: studio.com
         │               │                     │
         ▼               ▼                     ▼
┌────────────────────────────────────────────────────────────┐
│                    Runtime Express Server                    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  1. Global CORS Middleware (cors() in server.ts)     │    │
│  │     - Checks Origin against config.cors.origins      │    │
│  │     - Sets Access-Control-Allow-* headers            │    │
│  │     - Handles OPTIONS preflight                      │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│  ┌──────────────────────▼──────────────────────────────┐    │
│  │  2. Feature-Specific Origin Checks                   │    │
│  │     - SDK Auth: key.allowedOrigins                   │    │
│  │     - OAuth: redirect origin validation              │    │
│  │     (stricter than global -- never widens)           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  3. Route Handlers (chat, sessions, SDK, etc.)       │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
         ▲
         │
┌────────┴──────────────────────────────────────────────────┐
│                  packages/config                            │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐  │
│  │ cors.schema   │  │ env-mapping  │  │ production-checks│  │
│  │ (Zod)        │  │ (CORS_*)    │  │ (wildcard reject)│  │
│  └──────────────┘  └─────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
packages/config/
├── schemas/cors.schema.ts      → CORSConfigSchema (Zod), CORSConfig type
├── env-mapping.ts              → CORS_ORIGINS → cors.origins, etc.
├── constants.ts                → DEFAULT_LOCAL_ORIGINS
└── validation/production-checks.ts → validateProductionConfig()

apps/runtime/src/
├── server.ts                   → app.use(cors(corsOptions)) -- global middleware
├── middleware/sdk-auth.ts      → Per-key allowedOrigins enforcement
└── routes/channel-oauth.ts     → getAllowedRedirectOrigins() fallback to CORS
```

### Data Flow

**Request path for a browser cross-origin call:**

1. Browser sends `OPTIONS` preflight to Runtime (or `GET`/`POST` with `Origin` header).
2. Express receives request; global CORS middleware fires first (before auth, rate limiting, etc.).
3. Middleware reads `config.cors.*` values (loaded once at startup from env/schema defaults).
4. In production: `origin` is set to `config.server.frontendUrl` (single string).
   In development: `origin` is set to `config.cors.origins` (array of strings).
5. Express `cors()` package checks the `Origin` header against the configured origin(s).
6. If allowed: sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Expose-Headers`.
7. For `OPTIONS`: responds with 204 (no body).
   For actual requests: passes to next middleware (Helmet, compression, body parsing, auth, etc.).
8. Feature-specific middleware (SDK auth, OAuth) may apply additional origin restrictions.
9. Route handler processes the request normally.

### Sequence Diagram

```
Browser                 Runtime CORS MW        SDK Auth MW         Route Handler
  │                          │                      │                    │
  │──OPTIONS /api/v1/sdk/──>│                      │                    │
  │  Origin: widget.com     │                      │                    │
  │                         │──check origin──>     │                    │
  │                         │  config.cors.origins │                    │
  │                         │<─allowed─────────    │                    │
  │<─204 + CORS headers─────│                      │                    │
  │                         │                      │                    │
  │──GET /api/v1/sdk/config─>│                      │                    │
  │  Origin: widget.com     │──add CORS headers──> │                    │
  │  X-Public-Key: abc      │                      │──check key origins──>│
  │                         │                      │  key.allowedOrigins │
  │                         │                      │<─allowed────────────│
  │                         │                      │                    │──process──>
  │<─200 + response──────────────────────────────────────────────────────│
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | CORS is deployment-scoped, not tenant-scoped. The global policy applies to all tenants in a deployment. Tenant-specific origin restrictions are not supported at the CORS layer; they are handled by feature-specific checks (e.g., SDK key `allowedOrigins` is project-scoped). This is by design -- a shared Runtime instance serves multiple tenants with the same origin policy. |
| 2   | **Data Access Pattern** | Config-only -- no database access. The CORS schema is resolved once at startup from environment variables and Zod defaults. No repository layer, no caching beyond the config singleton.                                                                                                                                                                                             |
| 3   | **API Contract**        | No CORS-specific API endpoints. The feature manifests as HTTP response headers (`Access-Control-Allow-*`) on every response. Error behavior: disallowed origins receive no CORS headers, causing the browser to block the response (standard CORS spec behavior). No error body is returned for CORS failures.                                                                       |
| 4   | **Security Surface**    | Production validation rejects wildcard `*` origins (error) and warns on localhost origins. The `cors()` middleware never returns `Access-Control-Allow-Origin: *` when `credentials: true` (browser enforced). Input validation: origin values are strings; Zod schema handles type coercion. No SSRF risk (CORS is response-header-only).                                           |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | CORS failures are silent from the server's perspective -- the browser blocks the response based on missing/incorrect headers. No application-level error response is sent. Debugging relies on browser DevTools network tab and server-side request/response logging.                                                                           |
| 6   | **Failure Modes** | Primary failure: misconfigured origins cause all browser requests to fail. Mitigation: production validation catches common misconfigurations. Secondary failure: production mode narrowing to `server.frontendUrl` means multi-origin deployments break silently. This is GAP-001. No network partition or timeout concerns (config is local). |
| 7   | **Idempotency**   | N/A -- CORS is stateless. Every request is independently evaluated against the config. No side effects, no state to become inconsistent.                                                                                                                                                                                                        |
| 8   | **Observability** | Currently no dedicated CORS logging or metrics. Origin check results are not logged. Debugging requires browser inspection + adjacent SDK/OAuth logs. Improvement: log origin rejections at debug level in the CORS middleware.                                                                                                                 |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Negligible -- one string comparison per request against a small array (typically 1-10 origins). No regex, no DB lookup, no network call. Target: < 0.1ms per request overhead.                                                                                                                                                                                                                        |
| 10  | **Migration Path**     | Current state: production uses `server.frontendUrl` (single origin). Target state: production uses full `cors.origins` array. Migration: update the `origin` line in `server.ts` to always use `config.cors.origins`, then deprecate the `server.frontendUrl` fallback for CORS. This is a one-line code change gated by E2E test coverage.                                                           |
| 11  | **Rollback Plan**      | CORS config is env-driven. Rollback: revert the `CORS_ORIGINS` env var. No data migration needed. If the code change to use `cors.origins` in production causes issues, revert the one-line change in `server.ts`.                                                                                                                                                                                    |
| 12  | **Test Strategy**      | Unit: config schema parsing, env mapping, production validation (existing). Integration: Express app with `supertest` -- verify preflight handling and response headers (planned). E2E: real Runtime server on random port -- verify browser-style requests with and without valid origins (planned). No mocking of codebase components. External `cors` npm package is used as-is (no need to mock). |

---

## 5. Data Model

### New Collections/Tables

None. CORS is entirely config-driven with no database persistence.

### Modified Collections/Tables

None.

### Key Relationships

```
Environment Variables (CORS_*)
    │
    ▼ (env-mapping.ts)
Config Object (cors: { origins, credentials, methods, allowedHeaders, exposedHeaders })
    │
    ├──▶ server.ts global middleware (reads config.cors.*)
    ├──▶ production-checks.ts (validates cors.origins for safety)
    └──▶ channel-oauth.ts (falls back to cors.origins for redirect validation)

SDK Key Records (MongoDB)
    │
    └──▶ sdk-auth.ts (reads key.allowedOrigins -- separate from global CORS)
```

---

## 6. API Design

### New Endpoints

None. CORS does not introduce new REST endpoints.

### Modified Endpoints

| Endpoint                   | Change                                               | Impact                                         |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| All Runtime HTTP endpoints | CORS headers added to responses by global middleware | No API contract change -- headers are additive |

### Error Responses

CORS does not produce application-level error responses. When a browser origin is not allowed:

- The response lacks `Access-Control-Allow-Origin` header.
- The browser blocks the response client-side.
- The server returns the normal response body (which the browser discards).

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: N/A -- CORS decisions are not logged to the audit trail. Origin check results could be added as debug-level structured logs.
- **Rate Limiting**: CORS preflight (`OPTIONS`) requests count against rate limits if rate limiting is applied before CORS middleware. Current ordering: CORS middleware fires before rate limiting, so preflight is handled efficiently.
- **Caching**: No runtime caching needed. Config is loaded once at startup. Browser CORS preflight caching is controlled by the `Access-Control-Max-Age` header (not currently set -- defaults to browser-specific behavior).
- **Encryption**: N/A -- CORS headers are plaintext HTTP headers. No secrets are transmitted via CORS headers.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                              | Type             | Risk                                                |
| --------------------------------------- | ---------------- | --------------------------------------------------- |
| `cors` npm package                      | External library | Low -- well-maintained, standard Express middleware |
| `packages/config` schemas + env mapping | Internal package | Low -- stable, well-tested                          |
| `packages/config` production validation | Internal package | Low -- existing validation infrastructure           |

### Downstream (depends on this feature)

| Consumer                             | Impact                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Studio browser client                | Relies on Runtime CORS to succeed; fails visibly if CORS is misconfigured    |
| SDK widgets (`packages/web-sdk`)     | Relies on global CORS + per-key `allowedOrigins`; double-layered enforcement |
| Channel OAuth flows                  | Falls back to CORS origins for redirect validation                           |
| Any future browser-based integration | Automatically inherits the global CORS policy                                |

---

## 9. Open Questions & Decisions Needed

1. **Production multi-origin**: Should production mode use the full `cors.origins` array instead of `server.frontendUrl`? Current behavior limits production to a single origin. Recommendation: yes, with E2E test coverage first.
2. **`exposedHeaders` env mapping**: Should `CORS_EXPOSED_HEADERS` be added to `env-mapping.ts`? Currently `exposedHeaders` exists in the schema but cannot be configured via env vars.
3. **`Access-Control-Max-Age`**: Should a configurable max-age header be added to reduce preflight request frequency? This is a performance optimization with no current operator demand.
4. **Origin rejection logging**: Should the CORS middleware log origin rejections at debug level for operational visibility?

---

## 10. References

- Feature spec: `docs/features/cors.md`
- Test spec: `docs/testing/cors.md`
- Express `cors` package: https://github.com/expressjs/cors
- MDN CORS spec: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
- Related features: [SDK](../features/sdk.md), [Channels](../features/channels.md)
