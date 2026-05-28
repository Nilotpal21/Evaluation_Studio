# Test Spec: OpenAPI Documentation

**Feature ID:** #35
**Feature Spec:** `docs/features/openapi-documentation.md`
**Created:** 2026-03-22
**Updated:** 2026-03-22

---

## 1. Test Coverage Matrix

| Component                           | Unit | Integration | E2E | Status  |
| ----------------------------------- | ---- | ----------- | --- | ------- |
| RouteRegistry (createRouteRegistry) | YES  | -           | -   | PLANNED |
| generateSpec() output validity      | YES  | -           | -   | PLANNED |
| expressPathToOpenAPI                | YES  | -           | -   | PLANNED |
| nextjsPathToOpenAPI                 | YES  | -           | -   | PLANNED |
| pathParamsSchema                    | YES  | -           | -   | PLANNED |
| deriveTag                           | YES  | -           | -   | PLANNED |
| createOpenAPIRouter                 | -    | YES         | -   | PLANNED |
| serveOpenAPIDocs                    | -    | YES         | -   | PLANNED |
| introspectExpressRoutes             | -    | YES         | -   | PLANNED |
| withOpenAPI decorator               | YES  | -           | -   | PLANNED |
| scanNextjsRoutes                    | -    | YES         | -   | PLANNED |
| Runtime /docs endpoint              | -    | YES         | YES | PLANNED |
| Runtime /docs/spec.json             | -    | YES         | YES | PLANNED |
| Studio /api/openapi                 | -    | -           | YES | PLANNED |
| Studio /api/openapi/spec.json       | -    | -           | YES | PLANNED |
| Route count drift detection         | -    | -           | YES | PLANNED |
| Auth annotation correctness         | -    | -           | YES | PLANNED |
| BearerAuth security scheme          | YES  | -           | YES | PLANNED |

---

## 2. Unit Test Scenarios

### 2.1 Registry Core (packages/openapi)

| ID    | Scenario                                                              | Expected Result                                    |
| ----- | --------------------------------------------------------------------- | -------------------------------------------------- |
| UT-1  | Create registry and register a simple GET route with summary          | Route appears in generated spec under correct path |
| UT-2  | Register POST route with body and response Zod schemas                | Spec contains request body and response schemas    |
| UT-3  | Register route with explicit tags override                            | Tags in spec match provided tags, not auto-derived |
| UT-4  | Register route with `auth: false`                                     | Route has no security requirement in spec          |
| UT-5  | Register duplicate route (same method + path)                         | Second registration is silently ignored            |
| UT-6  | Generate spec with SpecOptions (title, version, description, servers) | Info and servers fields match options              |
| UT-7  | Register route with `successStatus: 201`                              | Response uses 201 status code, not 200             |
| UT-8  | Register route with `responseContentType: 'text/event-stream'`        | Response content type is text/event-stream         |
| UT-9  | Auto-derived path params from OpenAPI path `{id}`                     | Params schema contains `id: z.string()`            |
| UT-10 | Generated spec is valid OpenAPI 3.0.3                                 | `openapi` field is `3.0.3`, info/paths present     |

### 2.2 Path Conversion Utilities

| ID    | Scenario                              | Input                                 | Expected Output                          |
| ----- | ------------------------------------- | ------------------------------------- | ---------------------------------------- |
| UT-11 | Express single param                  | `/api/users/:id`                      | `/api/users/{id}`                        |
| UT-12 | Express multiple params               | `/api/users/:id/posts/:postId`        | `/api/users/{id}/posts/{postId}`         |
| UT-13 | Express no params                     | `/api/users`                          | `/api/users`                             |
| UT-14 | Next.js single dynamic segment        | `/api/projects/[id]`                  | `/api/projects/{id}`                     |
| UT-15 | Next.js multiple dynamic segments     | `/api/projects/[id]/agents/[agentId]` | `/api/projects/{id}/agents/{agentId}`    |
| UT-16 | pathParamsSchema with one param       | `/api/users/{id}`                     | `z.object({ id: z.string() })`           |
| UT-17 | pathParamsSchema with no params       | `/api/users`                          | `undefined`                              |
| UT-18 | pathParamsSchema with multiple params | `/api/{tenantId}/users/{id}`          | `z.object({ tenantId, id: z.string() })` |

### 2.3 Tag Derivation

| ID    | Scenario            | Input                      | Expected Tag |
| ----- | ------------------- | -------------------------- | ------------ |
| UT-19 | Standard api prefix | `/api/v1/chat/stream`      | `V1`         |
| UT-20 | No api prefix       | `/chat/stream`             | `Chat`       |
| UT-21 | Deep path           | `/api/projects/:id/agents` | `Projects`   |
| UT-22 | Root path           | `/api`                     | `default`    |

### 2.4 withOpenAPI Decorator

| ID    | Scenario                           | Expected Result                                 |
| ----- | ---------------------------------- | ----------------------------------------------- |
| UT-23 | Wrap handler with schema metadata  | `getOpenAPIMetadata(handler)` returns schema    |
| UT-24 | Wrapped handler remains callable   | Handler executes with same behavior             |
| UT-25 | Unwrapped handler has no metadata  | `getOpenAPIMetadata(handler)` returns undefined |
| UT-26 | Metadata survives module re-export | Symbol property is preserved across imports     |

---

## 3. Integration Test Scenarios

All integration tests start a real Express server on a random port and make HTTP requests. No mocks of codebase components.

### 3.1 Express createOpenAPIRouter Integration

| ID   | Scenario                                                                 | Expected Result                                                 |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| IT-1 | Create Express app with createOpenAPIRouter, register 3 routes, GET spec | Spec JSON contains all 3 registered routes with correct methods |
| IT-2 | serveOpenAPIDocs returns HTML at `/` with Swagger UI script tag          | Response Content-Type is text/html, contains swagger-ui-bundle  |
| IT-3 | serveOpenAPIDocs returns JSON at `/spec.json`                            | Response Content-Type is application/json, valid OpenAPI 3.0    |
| IT-4 | introspectExpressRoutes discovers routes added with plain Express Router | Spec includes plain routes with auto-derived tags               |
| IT-5 | Mixed mode: openapi.route() + plain router.get() coexist                 | Both route types appear in spec                                 |
| IT-6 | Route with body schema appears with correct request body in spec         | `requestBody.content.application/json.schema` is present        |
| IT-7 | Route with `auth: false` has no security requirement                     | No `security` field on that operation                           |

### 3.2 Spec Serving Integration

| ID    | Scenario                                                  | Expected Result                                    |
| ----- | --------------------------------------------------------- | -------------------------------------------------- |
| IT-8  | GET /docs returns Swagger UI HTML with correct spec URL   | HTML contains `url: '/docs/spec.json'`             |
| IT-9  | GET /docs/spec.json returns cached spec on second request | Second response is identical and fast (< 5ms)      |
| IT-10 | Spec includes BearerAuth security scheme under components | `components.securitySchemes.BearerAuth` is present |

---

## 4. E2E Test Scenarios

E2E tests exercise the real running service through HTTP API only. No mocks, no direct DB access, no stubbed infrastructure.

### 4.1 Runtime OpenAPI E2E

| ID    | Scenario                                                       | Expected Result                                                           |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| E2E-1 | GET http://localhost:3112/docs returns Swagger UI HTML         | Status 200, Content-Type text/html, contains `swagger-ui`                 |
| E2E-2 | GET http://localhost:3112/docs/spec.json returns valid OpenAPI | Status 200, `openapi: 3.0.3`, `info.title: ABL Runtime API`               |
| E2E-3 | Runtime spec contains at least 100 path entries                | `Object.keys(spec.paths).length >= 100`                                   |
| E2E-4 | Runtime spec auth routes have no security requirement          | `/api/auth/dev-login` POST has no `security` field                        |
| E2E-5 | Runtime spec authenticated routes have BearerAuth              | `/api/projects/{projectId}/sessions` has `security: [{ BearerAuth: [] }]` |
| E2E-6 | Runtime spec sessions route has request/response schemas       | POST body schema and 200 response schema are present                      |
| E2E-7 | Runtime spec components include BearerAuth scheme              | `components.securitySchemes.BearerAuth` with type `http`                  |

### 4.2 Studio OpenAPI E2E

| ID     | Scenario                                                           | Expected Result                                              |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| E2E-8  | GET http://localhost:5173/api/openapi returns Swagger UI HTML      | Status 200, Content-Type text/html, contains `swagger-ui`    |
| E2E-9  | GET http://localhost:5173/api/openapi/spec.json returns valid spec | Status 200, `openapi: 3.0.3`, `info.title: Agent Studio API` |
| E2E-10 | Studio spec contains at least 60 path entries                      | `Object.keys(spec.paths).length >= 60` (65/117 annotated)    |
| E2E-11 | Studio spec login route has correct body schema                    | POST /api/auth/login body has `email` and `password` fields  |
| E2E-12 | Studio spec public routes have no auth                             | GET /api/auth/google has no `security` field                 |

### 4.3 Cross-Service E2E

| ID     | Scenario                                      | Expected Result                                          |
| ------ | --------------------------------------------- | -------------------------------------------------------- |
| E2E-13 | Both specs use consistent error schema format | Both specs have 401 and 500 responses with `error` field |
| E2E-14 | Both specs have BearerAuth security scheme    | Both define `BearerAuth` in `components.securitySchemes` |

---

## 5. Edge Cases

| ID   | Scenario                                       | Expected Behavior                               |
| ---- | ---------------------------------------------- | ----------------------------------------------- |
| EC-1 | Register route with empty schema `{}`          | Route appears with auto-derived metadata        |
| EC-2 | Register route with undefined schema           | Route appears with method + path only           |
| EC-3 | Express path with regex characters             | Path is converted correctly                     |
| EC-4 | Next.js catch-all route `[...slug]`            | Handled gracefully (may not convert to OpenAPI) |
| EC-5 | Very long path with 5+ segments                | Tag derived from first meaningful segment       |
| EC-6 | Route path with trailing slash                 | Normalized correctly                            |
| EC-7 | Spec generation with 500+ routes (stress test) | Completes in < 500ms                            |

---

## 6. Test Infrastructure

### 6.1 Unit Tests

- **Location**: `packages/openapi/src/__tests__/`
- **Framework**: Vitest
- **Dependencies**: `zod`, `@asteasolutions/zod-to-openapi` (both already in package.json)
- **No external services required**

### 6.2 Integration Tests

- **Location**: `packages/openapi/src/__tests__/integration/`
- **Framework**: Vitest + real Express server on random port
- **Pattern**: Start Express app with `{ port: 0 }`, make HTTP requests, assert responses
- **No mocks of codebase components**

### 6.3 E2E Tests

- **Location**: `apps/runtime/src/__tests__/openapi-e2e.test.ts` and `apps/studio/src/__tests__/openapi-e2e.test.ts`
- **Prerequisites**: Runtime running on port 3112, Studio running on port 5173
- **Pattern**: HTTP fetch to live endpoints, validate OpenAPI spec structure
- **No mocks, no direct DB access**

---

## 7. Coverage Targets

| Level       | Target | Rationale                                                 |
| ----------- | ------ | --------------------------------------------------------- |
| Unit        | 90%    | Core registry and utility functions are pure and testable |
| Integration | 80%    | Express integration paths are critical                    |
| E2E         | 100%   | All 4 spec/UI endpoints must be verified                  |

---

## 8. Risk Matrix

| Risk                                          | Impact | Probability | Mitigation                               |
| --------------------------------------------- | ------ | ----------- | ---------------------------------------- |
| Swagger UI CDN unavailable                    | LOW    | LOW         | Self-host assets as fallback             |
| Spec drift from actual routes                 | MEDIUM | MEDIUM      | Route count drift detection in E2E tests |
| Zod-to-OpenAPI library breaking changes       | MEDIUM | LOW         | Pin version, test spec output structure  |
| CSP blocks Swagger UI in certain environments | LOW    | MEDIUM      | CSP rules tested in integration          |
| Performance regression on large route sets    | LOW    | LOW         | Stress test with 500+ routes             |
