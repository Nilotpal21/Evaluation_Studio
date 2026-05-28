# High-Level Design: OpenAPI Documentation

**Feature ID:** #35
**Feature Spec:** `docs/features/openapi-documentation.md`
**Test Spec:** `docs/testing/sub-features/openapi-documentation.md`
**Status:** ALPHA
**Created:** 2026-03-22
**Updated:** 2026-03-22

---

## 1. Executive Summary

The OpenAPI Documentation feature provides machine-readable API documentation for the ABL Platform's ~222 REST endpoints across Runtime (Express) and Studio (Next.js). It uses a shared `@agent-platform/openapi` package that converts Zod schemas to OpenAPI 3.0.3 specs, served via Swagger UI at `/docs` (Runtime) and `/api/openapi` (Studio).

The architecture follows a **Zod-first, schema-as-documentation** approach: the same Zod schemas that validate requests at runtime also generate the OpenAPI spec. This eliminates drift between documentation and implementation.

---

## 2. Architecture Overview

```
                    ┌──────────────────────────────┐
                    │   @agent-platform/openapi      │
                    │                                │
                    │   RouteRegistry                │
                    │     registerRoute()            │
                    │     generateSpec() → OAS 3.0   │
                    │                                │
                    │   Sub-packages:                │
                    │     /express  /nextjs           │
                    └────────┬────────┬──────────────┘
                             │        │
              ┌──────────────┘        └──────────────┐
              ▼                                      ▼
    ┌─────────────────────┐             ┌─────────────────────┐
    │   Runtime (Express)  │             │   Studio (Next.js)   │
    │                      │             │                      │
    │   44 route files     │             │   Centralized spec   │
    │   createOpenAPIRouter│             │   117 route defs     │
    │   + introspection    │             │   in spec.json route │
    │                      │             │                      │
    │   GET /docs          │             │   GET /api/openapi   │
    │   GET /docs/spec.json│             │   GET /api/openapi/  │
    │                      │             │       spec.json      │
    └─────────────────────┘             └─────────────────────┘
```

### Key Components

| Component               | Location                                             | Responsibility                                    |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| RouteRegistry           | `packages/openapi/src/registry.ts`                   | Collect route metadata, generate OpenAPI 3.0 JSON |
| createOpenAPIRouter     | `packages/openapi/src/express/create-router.ts`      | Express Router that auto-registers to registry    |
| serveOpenAPIDocs        | `packages/openapi/src/express/serve-spec.ts`         | Serve Swagger UI HTML + spec.json endpoint        |
| introspectExpressRoutes | `packages/openapi/src/express/introspect-routes.ts`  | Walk Express stack for unannotated routes         |
| withOpenAPI             | `packages/openapi/src/nextjs/with-openapi.ts`        | Decorator to attach schema metadata to handlers   |
| scanNextjsRoutes        | `packages/openapi/src/nextjs/route-scanner.ts`       | Filesystem-based Next.js route discovery          |
| runtimeRegistry         | `apps/runtime/src/openapi/registry.ts`               | Singleton registry for Runtime                    |
| Studio spec route       | `apps/studio/src/app/api/openapi/spec.json/route.ts` | Centralized Studio route definitions              |
| Studio UI route         | `apps/studio/src/app/api/openapi/route.ts`           | Swagger UI HTML page for Studio                   |

---

## 3. Architectural Concerns

### 3.1 Resource Isolation

**Not applicable.** The OpenAPI feature serves read-only, non-tenant-scoped documentation. The spec endpoint (`/docs/spec.json`) returns the same spec for all callers -- it describes the API surface, not tenant-specific data. No `tenantId` scoping is needed.

However, **the Swagger UI "Try it out" feature** does execute real API calls, which are subject to all existing auth and isolation middleware. The spec documents which routes require BearerAuth.

### 3.2 Authentication & Authorization

- **Spec endpoints are unauthenticated**: `GET /docs`, `GET /docs/spec.json`, `GET /api/openapi`, `GET /api/openapi/spec.json` require no auth. API documentation is a development resource.
- **BearerAuth security scheme**: The spec declares a `BearerAuth` security scheme (`type: http, scheme: bearer, bearerFormat: JWT`). Routes that require auth are annotated with `security: [{ BearerAuth: [] }]`.
- **Production gating**: In production, the Swagger UI endpoints can be disabled via an environment flag to prevent exposing the API surface.

### 3.3 Data Model & Storage

No persistent storage. All data is computed in-memory:

- `RouteRegistry` holds `RouteMetadata[]` (method, path, schema) and `Set<string>` (route keys for deduplication)
- `cachedSpec` is a lazily-computed `Record<string, unknown>` that persists for the process lifetime
- On server restart, the registry is rebuilt from route registrations (deterministic)

### 3.4 Performance

| Concern                   | Design Decision                                                     |
| ------------------------- | ------------------------------------------------------------------- |
| Spec generation latency   | Lazy generation on first request; cached thereafter (< 1ms repeat)  |
| Request handler overhead  | Zero -- Zod schemas exist only for spec generation, not on hot path |
| Swagger UI bundle size    | CDN-loaded from unpkg.com; no bundled assets in the application     |
| Registry memory footprint | ~222 route entries \* ~200 bytes/entry = ~44KB (negligible)         |
| Route introspection cost  | One-time walk at startup after all routes are mounted               |

### 3.5 Scalability

The feature is inherently horizontal-scale-friendly:

- Each pod generates its own spec from its own route registrations (stateless)
- No cross-pod coordination needed -- all pods serve identical specs
- Cached spec is per-process; no shared cache required
- Adding new routes only requires adding registrations (O(n) at startup)

### 3.6 Error Handling

| Error Scenario                         | Handling                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| Zod schema compilation error           | Fails at build time (TypeScript); never reaches runtime      |
| Registry `generateSpec()` throws       | Express/Next.js error handler returns 500                    |
| Swagger UI CDN unavailable             | Page loads but UI doesn't render; fallback: self-host assets |
| Route module fails to import (Next.js) | `scanNextjsRoutes` catches and skips the module silently     |
| Duplicate route registration           | Silently ignored (idempotent `Set<string>` check)            |

### 3.7 Observability

- **Spec generation timing**: Log duration of first `generateSpec()` call
- **Route count at startup**: Log `runtimeRegistry` route count after introspection
- **Health check**: `/docs` returning 200 with HTML content serves as a health signal
- **Drift detection**: Compare `routes.length` against expected count (can be automated in CI)

No TraceEvent emission is needed -- this feature has no execution path that requires tracing.

### 3.8 Security

| Threat                      | Mitigation                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| API surface exposure        | Swagger UI disabled in production via env flag                                    |
| Internal field name leakage | Response schemas are hand-written, not auto-generated from DB models              |
| XSS via Swagger HTML        | Template uses controlled values only (title, specUrl from config)                 |
| CSP violation from CDN      | `unpkg.com` added to `script-src` and `style-src` in CSP headers                  |
| "Try it out" bypasses auth  | Swagger uses "Authorize" button to set Bearer token; same auth middleware applies |

### 3.9 Compliance

- **Data minimization**: No PII stored or processed. Spec is API surface metadata only.
- **Encryption**: Not applicable -- no sensitive data at rest or in transit beyond standard HTTPS.
- **Audit logging**: Not needed -- spec access is read-only, non-sensitive documentation.
- **Right to erasure**: Not applicable -- no user data involved.

### 3.10 Extensibility

The architecture supports incremental annotation:

1. **Express routes**: Any route file can adopt `createOpenAPIRouter` without changing existing routes
2. **Next.js routes**: `withOpenAPI` decorator is transparent; adding it requires no handler changes
3. **Introspection fallback**: Unannotated routes still appear in the spec with basic metadata
4. **Custom schemas**: Developers can add `description`, `query`, `body`, `response` schemas incrementally
5. **New services**: Any new Express or Next.js service can create its own `RouteRegistry` and mount docs

### 3.11 Testing Strategy

See `docs/testing/sub-features/openapi-documentation.md` for the full test spec.

- **Unit tests**: 26 scenarios covering registry, path utils, tag derivation, withOpenAPI
- **Integration tests**: 10 scenarios with real Express servers on random ports
- **E2E tests**: 14 scenarios against live Runtime and Studio services
- **Edge cases**: 7 scenarios (empty schemas, regex paths, stress tests)

### 3.12 Deployment & Rollout

The feature is already deployed (Phase 1-2 complete, Phase 3 in progress):

- **No feature flags needed**: Swagger UI is always available in development
- **No migration**: No data model changes
- **No rollback concerns**: Feature is additive (documentation layer); removing it has no user-facing impact
- **Production disabling**: `NODE_ENV=production` can gate Swagger UI endpoints

---

## 4. Alternatives Considered

### Alternative 1: OpenAPI-first with code generation

**Approach**: Write OpenAPI spec first (YAML), then generate route stubs and validation middleware.

| Pros                               | Cons                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| Spec is the single source of truth | Requires maintaining a separate spec file            |
| Generates request validation       | Zod already handles validation; this adds redundancy |
| Common in API-first teams          | Team already uses Zod-first patterns                 |

**Decision**: REJECTED. The codebase already uses Zod extensively for validation. Generating from spec would create a parallel validation system and require maintaining a YAML file that drifts from code.

### Alternative 2: Swagger-autogen (automatic spec from JSDoc/decorators)

**Approach**: Use `swagger-autogen` or `tsoa` to generate specs from JSDoc comments or TypeScript decorators.

| Pros                  | Cons                                                      |
| --------------------- | --------------------------------------------------------- |
| Minimal code changes  | JSDoc is stringly-typed; no compile-time checking         |
| Auto-discovers routes | Misses Zod schemas already in the codebase                |
| Large community       | Requires decorators or JSDoc annotations on every handler |

**Decision**: REJECTED. This approach doesn't leverage existing Zod schemas and introduces a separate annotation system. The Zod-first approach (`@asteasolutions/zod-to-openapi`) reuses schemas that already exist for validation.

### Alternative 3: Manual OpenAPI YAML + Swagger UI standalone

**Approach**: Maintain a handwritten OpenAPI spec in `docs/api/openapi.yaml` and serve Swagger UI from a static file server.

| Pros                               | Cons                                            |
| ---------------------------------- | ----------------------------------------------- |
| Complete control over spec content | Spec drifts from code immediately               |
| No build-time dependencies         | Must be manually updated for every route change |
| Simple deployment                  | No compile-time schema validation               |

**Decision**: REJECTED. With 222 endpoints, manual spec maintenance is unsustainable. Drift between spec and implementation would be guaranteed within weeks.

---

## 5. Data Flow Diagram

```
Route Author
    │
    ▼
┌─────────────────────────────────┐
│  Route Registration              │
│                                  │
│  Express: openapi.route(         │
│    method, path, schema, handler)│
│                                  │
│  Next.js: routes[] tuple array   │
│    [method, path, schema]        │
│                                  │
│  Fallback: introspectExpressRoutes│
│    walks Express._router.stack   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  RouteRegistry                   │
│                                  │
│  routes: RouteMetadata[]         │
│  routeKeys: Set<string>          │
│                                  │
│  OpenAPIRegistry (zod-to-openapi)│
│    registerComponent()           │
│    registerPath()                │
└──────────────┬──────────────────┘
               │
               ▼ on first request
┌─────────────────────────────────┐
│  Spec Generation                 │
│                                  │
│  OpenApiGeneratorV3              │
│    generateDocument() →          │
│    OpenAPI 3.0.3 JSON            │
│                                  │
│  Cached in-memory                │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Serving Layer                   │
│                                  │
│  GET /docs        → Swagger HTML │
│  GET /docs/spec.json → JSON spec │
│                                  │
│  Swagger UI (CDN) fetches        │
│  spec.json and renders UI        │
└─────────────────────────────────┘
```

---

## 6. Component Interactions

### 6.1 Runtime Initialization Sequence

1. `server.ts` imports `runtimeRegistry` (singleton) and `serveOpenAPIDocs`/`introspectExpressRoutes`
2. Each route file (44 total) imports `runtimeRegistry` and creates an `OpenAPIRouter` with `createOpenAPIRouter(runtimeRegistry, { basePath, tags })`
3. Routes are registered via `openapi.route(method, path, schema, handler)` (201 total registrations)
4. Express mounts `openapi.router` at the appropriate base path
5. `app.use('/docs', serveOpenAPIDocs(runtimeRegistry, { title, version, ... }))` mounts Swagger UI
6. `introspectExpressRoutes(app, runtimeRegistry)` walks the middleware stack to discover unannotated routes
7. On first `GET /docs/spec.json` request, `generateSpec()` is called and the result is cached

### 6.2 Studio Initialization Sequence

1. `spec.json/route.ts` defines 117 routes as `[method, path, schema]` tuples
2. On first `GET /api/openapi/spec.json` request, a fresh `RouteRegistry` is created
3. All 117 routes are registered in a loop
4. `generateSpec()` produces the OpenAPI JSON, which is cached in a module-level variable
5. Subsequent requests return the cached spec

### 6.3 Package Dependency Graph

```
@agent-platform/openapi
  ├── zod (peer)
  ├── @asteasolutions/zod-to-openapi
  └── express (optional peer)

apps/runtime
  └── @agent-platform/openapi/express

apps/studio
  ├── @agent-platform/openapi (root)
  └── @agent-platform/config (for port constants)
```

---

## 7. Migration & Backward Compatibility

No migration needed. The feature is purely additive:

- Existing routes continue to work unchanged
- Adding `createOpenAPIRouter` to a route file does not change handler behavior
- `withOpenAPI` decorator is transparent (zero runtime overhead)
- Removing the feature (deleting `/docs` mount) has no impact on API functionality

---

## 8. Capacity Planning

| Resource             | Current            | Projected (500 routes) | Notes                      |
| -------------------- | ------------------ | ---------------------- | -------------------------- |
| Registry memory      | ~44KB (222 routes) | ~100KB                 | Negligible                 |
| Spec generation time | ~100ms (cold)      | ~200ms                 | Linear with route count    |
| Cached spec size     | ~150KB JSON        | ~350KB                 | Single JSON blob in memory |
| Swagger UI page load | ~2s (CDN)          | ~2s (CDN)              | Unaffected by route count  |

---

## 9. Open Architecture Decisions

| ID   | Decision                                         | Status  | Notes                                       |
| ---- | ------------------------------------------------ | ------- | ------------------------------------------- |
| AD-1 | CDN vs self-hosted Swagger UI assets             | DECIDED | CDN for now; self-host if CSP issues arise  |
| AD-2 | Centralized vs per-file Studio route definitions | DECIDED | Centralized (avoids dynamic import issues)  |
| AD-3 | Production Swagger UI access                     | DECIDED | Disabled via env flag in production         |
| AD-4 | Shared schema location for cross-package types   | OPEN    | Currently in `packages/openapi/src/shared/` |

---

## 10. Revision History

| Date       | Author        | Change                                  |
| ---------- | ------------- | --------------------------------------- |
| 2026-03-22 | Platform Team | Initial HLD generated via SDLC pipeline |
