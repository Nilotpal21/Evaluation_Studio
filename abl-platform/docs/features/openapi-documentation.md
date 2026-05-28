# Feature Spec: OpenAPI Documentation

**Feature ID:** #35
**Status:** ALPHA
**Owner:** Platform Team
**Created:** 2026-03-22
**Updated:** 2026-03-22

---

## 1. Problem Statement

The ABL Platform exposes approximately **222 REST endpoints** across two services: Runtime (Express, ~105 endpoints) and Studio (Next.js, ~117 endpoints). These APIs currently lack comprehensive machine-readable documentation, which creates friction for:

- **Developers** discovering and testing available endpoints
- **SDK consumers** understanding request/response contracts
- **QA teams** generating test cases from contracts
- **External integrations** (A2A, webhooks, third-party systems) validating payloads
- **New team members** onboarding to the platform API surface

Without a unified, auto-generated spec, API contracts drift from implementation, breaking consumers silently.

---

## 2. Goals

| ID  | Goal                                                                                                  | Priority |
| --- | ----------------------------------------------------------------------------------------------------- | -------- |
| G1  | Every public endpoint has an OpenAPI 3.0 spec entry with summary, request schema, and response schema | P0       |
| G2  | Swagger UI is served at `/docs` (Runtime) and `/api/openapi` (Studio) for interactive exploration     | P0       |
| G3  | Schemas are Zod-first -- the same Zod objects that validate at runtime also generate the spec         | P0       |
| G4  | Adding OpenAPI metadata to a new route requires fewer than 5 lines of code                            | P1       |
| G5  | Zero impact on request/response performance -- schemas are only used at spec-generation time          | P0       |
| G6  | Runtime route introspection provides automatic fallback coverage for unannotated routes               | P1       |
| G7  | Studio route scanning discovers all App Router `route.ts` files automatically                         | P1       |

---

## 3. Non-Goals

- **Runtime request validation from OpenAPI spec**: Zod schemas validate at the handler level already; the OpenAPI spec is documentation-only.
- **API versioning**: OpenAPI docs describe the current API surface, not versioned snapshots.
- **Client SDK code generation**: While the spec could power codegen, that is a separate feature.
- **API gateway integration**: Spec is for developer consumption, not gateway routing.
- **Production Swagger UI**: Swagger UI is a development aid; production deployments may disable it via environment flag.

---

## 4. User Stories

| ID   | As a...               | I want to...                                                                      | So that...                                                    |
| ---- | --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| US-1 | Platform developer    | View all available Runtime API endpoints in Swagger UI at `/docs`                 | I can discover and test endpoints without reading source code |
| US-2 | Platform developer    | View all available Studio API endpoints at `/api/openapi`                         | I can understand Studio's API surface                         |
| US-3 | SDK consumer          | Download the OpenAPI JSON spec from `/docs/spec.json` or `/api/openapi/spec.json` | I can generate typed clients or validate payloads             |
| US-4 | Route author          | Annotate a new Express route with Zod schemas in < 5 lines                        | My route automatically appears in the spec with full contract |
| US-5 | Route author          | Wrap a Next.js route handler with `withOpenAPI()` decorator                       | My Studio route appears in the spec without additional wiring |
| US-6 | QA engineer           | See request body, query params, and response schemas in the spec                  | I can generate test cases from contracts                      |
| US-7 | New team member       | Browse grouped/tagged endpoints in Swagger UI                                     | I can understand the API surface during onboarding            |
| US-8 | Integration developer | Verify that an endpoint requires Bearer auth by checking the spec                 | I configure my integration client correctly                   |

---

## 5. Scope

### 5.1 In Scope

- **Shared package** (`packages/openapi`): `createRouteRegistry`, `RouteSchema`, `SpecOptions`, path conversion utilities
- **Express integration** (`packages/openapi/express`): `createOpenAPIRouter`, `serveOpenAPIDocs`, `introspectExpressRoutes`
- **Next.js integration** (`packages/openapi/nextjs`): `withOpenAPI`, `scanNextjsRoutes`, `getOpenAPIMetadata`
- **Runtime wiring** (`apps/runtime`): Singleton registry, `/docs` mount, route introspection, per-route Zod annotations
- **Studio wiring** (`apps/studio`): `/api/openapi` page, `/api/openapi/spec.json` route, centralized route definitions
- **Swagger UI serving**: CDN-loaded Swagger UI at both endpoints

### 5.2 Out of Scope

- Runtime request/response validation from spec (Zod handles this already)
- API versioning or version-pinned specs
- Client SDK code generation from spec
- Swagger UI in production (development-only)

---

## 6. Architecture Overview

### 6.1 Package Structure

```
@agent-platform/openapi
  ├── src/
  │   ├── index.ts              # createRouteRegistry, types
  │   ├── types.ts              # RouteSchema, RouteMetadata, SpecOptions, HttpMethod
  │   ├── registry.ts           # OpenAPIRegistry wrapper using @asteasolutions/zod-to-openapi
  │   ├── shared/
  │   │   └── schema-utils.ts   # expressPathToOpenAPI, nextjsPathToOpenAPI, pathParamsSchema
  │   ├── express/
  │   │   ├── index.ts          # Express sub-package exports
  │   │   ├── create-router.ts  # createOpenAPIRouter (OpenAPI-aware Express Router)
  │   │   ├── serve-spec.ts     # serveOpenAPIDocs (Swagger UI + spec.json)
  │   │   └── introspect-routes.ts  # introspectExpressRoutes (auto-discover unannotated routes)
  │   └── nextjs/
  │       ├── index.ts          # Next.js sub-package exports
  │       ├── with-openapi.ts   # withOpenAPI decorator + getOpenAPIMetadata
  │       └── route-scanner.ts  # scanNextjsRoutes (filesystem-based route discovery)
  └── package.json
```

### 6.2 Data Flow

1. **Developer** writes Zod schemas for body, response, params, query alongside route handlers
2. **Express routes** use `createOpenAPIRouter(registry, { basePath, tags })` then `openapi.route(method, path, schema, handler)`
3. **Next.js routes** use `export const POST = withOpenAPI(schema, handler)` decorator
4. **RouteRegistry** collects all registrations and generates OpenAPI 3.0 JSON via `@asteasolutions/zod-to-openapi`
5. **Swagger UI** loads at `/docs` (Runtime) or `/api/openapi` (Studio) using CDN assets
6. **Fallback**: `introspectExpressRoutes()` walks Express router stack to register unannotated routes with basic metadata

### 6.3 Integration Points

| Component           | Integration                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime server.ts   | `app.use('/docs', serveOpenAPIDocs(runtimeRegistry, {...}))` + `introspectExpressRoutes(app, runtimeRegistry)` |
| Runtime routes (44) | Each route file imports `runtimeRegistry` and uses `createOpenAPIRouter`                                       |
| Studio spec.json    | Creates registry, registers centralized route definitions, generates spec                                      |
| Studio openapi page | Serves Swagger UI HTML pointing to `./openapi/spec.json`                                                       |

---

## 7. Functional Requirements

| ID    | Requirement                                                                                                                 | Priority |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-1  | The `@agent-platform/openapi` package provides a `createRouteRegistry()` factory                                            | P0       |
| FR-2  | The registry generates valid OpenAPI 3.0.3 JSON via `generateSpec(options)`                                                 | P0       |
| FR-3  | `RouteSchema` supports: summary, description, tags, params, query, body, response, successStatus, auth, responseContentType | P0       |
| FR-4  | `createOpenAPIRouter` creates an Express Router that auto-registers routes in the registry                                  | P0       |
| FR-5  | `serveOpenAPIDocs` returns an Express Router serving Swagger UI HTML at `/` and spec JSON at `/spec.json`                   | P0       |
| FR-6  | `introspectExpressRoutes` walks the Express middleware stack and registers undiscovered routes                              | P1       |
| FR-7  | `withOpenAPI` decorates Next.js route handlers with schema metadata (zero runtime overhead)                                 | P0       |
| FR-8  | `scanNextjsRoutes` recursively discovers `route.ts` files and registers their HTTP method exports                           | P1       |
| FR-9  | Path parameters are auto-derived from Express `:param` and Next.js `[param]` syntax                                         | P1       |
| FR-10 | Tags are auto-derived from the first meaningful path segment when not specified                                             | P1       |
| FR-11 | BearerAuth (JWT) security scheme is registered and applied by default; `auth: false` overrides                              | P0       |
| FR-12 | 401 and 500 error responses are automatically added to every route                                                          | P1       |
| FR-13 | Duplicate route registrations (same method + path) are silently deduplicated                                                | P1       |
| FR-14 | Runtime serves Swagger UI at `GET /docs` with spec at `GET /docs/spec.json`                                                 | P0       |
| FR-15 | Studio serves Swagger UI at `GET /api/openapi` with spec at `GET /api/openapi/spec.json`                                    | P0       |
| FR-16 | Spec generation is lazy/cached -- computed once on first request                                                            | P1       |
| FR-17 | SSE endpoints can specify `responseContentType: 'text/event-stream'`                                                        | P1       |
| FR-18 | The spec includes server URLs derived from port constants                                                                   | P2       |

---

## 8. Non-Functional Requirements

| ID    | Requirement                                                                            | Target          |
| ----- | -------------------------------------------------------------------------------------- | --------------- |
| NFR-1 | Spec generation latency (cold): under 200ms for 222 routes                             | < 200ms         |
| NFR-2 | Spec generation latency (cached): under 1ms (return cached JSON)                       | < 1ms           |
| NFR-3 | Zero runtime overhead on request handlers -- schemas used only at spec-generation time | 0ms per request |
| NFR-4 | Package size: no bundled Swagger UI assets (CDN-loaded)                                | < 50KB dist     |
| NFR-5 | Route annotation requires fewer than 5 lines of schema code per route                  | < 5 LOC         |
| NFR-6 | Type-safe: all schemas are Zod types, providing compile-time checking                  | TypeScript safe |
| NFR-7 | The feature does not add any new runtime dependencies to production request paths      | No perf impact  |

---

## 9. Technical Design

### 9.1 Core Registry

The `RouteRegistry` wraps `@asteasolutions/zod-to-openapi`'s `OpenAPIRegistry` and `OpenApiGeneratorV3`. Each registered route is converted to a `RouteConfig` with:

- Request body (`application/json` for POST/PUT/PATCH)
- Path parameters (auto-derived or explicit Zod schema)
- Query parameters (optional Zod schema)
- Response schemas (success + 401 + 500 error envelope)
- Security requirements (BearerAuth by default)
- Tags (auto-derived from path or explicit)

### 9.2 Express Integration

`createOpenAPIRouter(registry, options)` returns `{ router, route }`:

- `route(method, path, schema, ...handlers)` registers in both Express and OpenAPI
- The Express Router is mounted with `app.use(basePath, openapi.router)`
- `introspectExpressRoutes(app, registry)` provides fallback for routes not using `createOpenAPIRouter`

### 9.3 Next.js Integration

`withOpenAPI(schema, handler)` attaches metadata via a symbol property. `scanNextjsRoutes({ apiDir })` walks the filesystem, dynamically imports each `route.ts`, checks for exported HTTP method handlers, and extracts metadata via `getOpenAPIMetadata()`.

### 9.4 Studio Centralized Route Definitions

Instead of per-file `withOpenAPI` wrappers, Studio uses a centralized approach in `/api/openapi/spec.json/route.ts` where all 117 routes are defined as `[method, path, schema]` tuples and registered in a loop. This avoids the complexity of dynamic imports in the Next.js build environment.

---

## 10. Security Considerations

| Concern                              | Mitigation                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Spec exposes internal API surface    | Swagger UI is for development; disable in production via env flag                  |
| Schema leaks DB field names          | Response schemas are hand-written, not auto-generated from Mongoose models         |
| CSP blocks Swagger UI CDN assets     | CDN domain added to script-src and style-src in middleware                         |
| CORS on spec endpoint                | Spec endpoints follow same CORS rules as other API routes                          |
| Auth bypass via Swagger "Try it out" | Swagger sends Bearer token via "Authorize" button; no special bypass               |
| XSS in Swagger HTML                  | HTML template uses string interpolation for title/specUrl only (controlled values) |

---

## 11. Data Model

No persistent data model. The feature operates entirely in-memory:

- `RouteRegistry` holds an in-memory array of `RouteMetadata[]` and a `Set<string>` of route keys
- `cachedSpec` stores the generated OpenAPI JSON (regenerated on server restart)
- No database collections, no Redis keys, no filesystem state

---

## 12. API Contract

### Runtime

| Method | Path            | Auth | Response          |
| ------ | --------------- | ---- | ----------------- |
| GET    | /docs           | No   | HTML (Swagger UI) |
| GET    | /docs/spec.json | No   | OpenAPI 3.0 JSON  |

### Studio

| Method | Path                   | Auth | Response          |
| ------ | ---------------------- | ---- | ----------------- |
| GET    | /api/openapi           | No   | HTML (Swagger UI) |
| GET    | /api/openapi/spec.json | No   | OpenAPI 3.0 JSON  |

---

## 13. Dependencies

| Dependency                       | Type     | Purpose                                        |
| -------------------------------- | -------- | ---------------------------------------------- |
| `@asteasolutions/zod-to-openapi` | NPM      | Converts Zod schemas to OpenAPI 3.0 spec       |
| `zod`                            | NPM      | Schema definition (already used platform-wide) |
| `swagger-ui-dist@5` (CDN)        | External | Swagger UI frontend (loaded from unpkg.com)    |
| `@agent-platform/config`         | Internal | Port constants for server URLs                 |
| Express (peer dependency)        | NPM      | Express Router for runtime integration         |

---

## 14. Rollout Plan

| Phase   | Description                                                   | Scope                          | Status      |
| ------- | ------------------------------------------------------------- | ------------------------------ | ----------- |
| Phase 1 | Immediate coverage via introspection                          | 222 endpoints with basic info  | DONE        |
| Phase 2 | Runtime route annotation (44 route files, ~201 registrations) | Full Zod schemas for runtime   | DONE        |
| Phase 3 | Studio centralized route definitions                          | 117 endpoints with schemas     | IN PROGRESS |
| Phase 4 | Shared schemas + polish                                       | Reusable schemas, descriptions | NOT STARTED |

### Current Progress

- **Runtime**: 44 route files annotated, 201 `openapi.route()` calls, introspection fallback active
- **Studio**: 65/117 routes annotated in centralized spec.json route (55% complete)
- **Package**: Fully built and exported (root, /express, /nextjs sub-packages)
- **Swagger UI**: Live at `/docs` (Runtime) and `/api/openapi` (Studio)

---

## 15. Observability

| Signal | What                     | How                                                           |
| ------ | ------------------------ | ------------------------------------------------------------- |
| Metric | Spec generation duration | Timer around `generateSpec()` call                            |
| Log    | Route count at startup   | Log `runtimeRegistry` route count after introspection         |
| Health | Swagger UI accessibility | `/docs` returns 200 with HTML content                         |
| Drift  | Route count vs. expected | Compare `registry.routes.length` against known endpoint count |

---

## 16. Testing Strategy

| Level       | What                                                         | How                                                |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Unit        | Registry generates valid OpenAPI 3.0 from Zod schemas        | Call `generateSpec()`, validate output structure   |
| Unit        | Path conversion (Express `:id` and Next.js `[id]` to `{id}`) | Test `expressPathToOpenAPI`, `nextjsPathToOpenAPI` |
| Unit        | Tag derivation from path segments                            | Test `deriveTag()` with various paths              |
| Integration | Runtime `/docs/spec.json` returns valid spec                 | HTTP GET, validate response is OpenAPI 3.0         |
| Integration | Studio `/api/openapi/spec.json` returns valid spec           | HTTP GET, validate response is OpenAPI 3.0         |
| E2E         | Swagger UI loads without errors                              | Browser test: load `/docs`, verify no JS errors    |
| E2E         | Spec contains expected route count                           | Fetch spec.json, count paths, compare to expected  |
| E2E         | Auth routes marked correctly                                 | Verify security field presence/absence             |

---

## 17. Open Questions

| ID   | Question                                                             | Status  | Resolution                                                    |
| ---- | -------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| OQ-1 | Should Swagger UI be disabled in production?                         | DECIDED | Environment flag; development-only by default                 |
| OQ-2 | Should we self-host swagger-ui assets instead of CDN?                | DECIDED | CDN for now (simplicity); self-host if CSP issues arise       |
| OQ-3 | Should Studio use per-file `withOpenAPI` or centralized definitions? | DECIDED | Centralized in spec.json route (avoids dynamic import issues) |
| OQ-4 | What is the target for remaining 52 Studio routes (Phase 3)?         | OPEN    | TBD -- depends on team bandwidth                              |

---

## 18. Revision History

| Date       | Author        | Change                                           |
| ---------- | ------------- | ------------------------------------------------ |
| 2026-03-22 | Platform Team | Initial feature spec generated via SDLC pipeline |
