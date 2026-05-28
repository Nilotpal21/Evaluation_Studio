# LLD + Implementation Plan: OpenAPI Documentation

**Feature ID:** #35
**Feature Spec:** `docs/features/openapi-documentation.md`
**Test Spec:** `docs/testing/sub-features/openapi-documentation.md`
**HLD:** `docs/specs/openapi-documentation.hld.md`
**Created:** 2026-03-22
**Updated:** 2026-03-22

---

## 1. Current State Analysis

### 1.1 What Exists

The `@agent-platform/openapi` package and its integrations are **substantially implemented**:

| Component                  | Status   | Details                                            |
| -------------------------- | -------- | -------------------------------------------------- |
| `packages/openapi` package | COMPLETE | All 3 sub-packages (root, /express, /nextjs) built |
| Runtime registry singleton | COMPLETE | `apps/runtime/src/openapi/registry.ts`             |
| Runtime /docs mount        | COMPLETE | `server.ts:848-856` mounts `serveOpenAPIDocs`      |
| Runtime introspection      | COMPLETE | `server.ts:861` calls `introspectExpressRoutes`    |
| Runtime route annotations  | COMPLETE | 44 route files, 201 `openapi.route()` calls        |
| Studio /api/openapi page   | COMPLETE | Swagger UI HTML served                             |
| Studio spec.json route     | PARTIAL  | 65/117 routes annotated (55%)                      |
| Unit tests                 | MISSING  | `packages/openapi/` has no tests                   |
| Integration tests          | MISSING  | No Express integration tests                       |
| E2E tests                  | MISSING  | No E2E spec validation tests                       |
| Production env gating      | MISSING  | Swagger UI always served (no NODE_ENV check)       |
| Spec validation in CI      | MISSING  | No automated OpenAPI spec validation               |

### 1.2 What Remains

1. **Studio Phase 3 completion**: 52 remaining Studio route annotations
2. **Test suite**: Unit, integration, and E2E tests per test spec
3. **Production gating**: Environment-based Swagger UI disable
4. **Shared schemas**: Extract reusable schemas (pagination, error, entity IDs)
5. **CI validation**: Automated spec generation + validation in pipeline

---

## 2. Implementation Phases

### Phase 1: Package Test Suite (Unit + Integration)

**Goal**: Achieve test coverage for `packages/openapi` (26 unit + 10 integration tests).

**Scope**:

- Unit tests for `createRouteRegistry`, `generateSpec`, path utils, tag derivation, `withOpenAPI`
- Integration tests with real Express servers on random ports

**Files to Create/Modify**:

| File                                                                | Action | Description                                    |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------- |
| `packages/openapi/src/__tests__/registry.test.ts`                   | CREATE | UT-1 through UT-10: Registry core tests        |
| `packages/openapi/src/__tests__/schema-utils.test.ts`               | CREATE | UT-11 through UT-18: Path conversion utilities |
| `packages/openapi/src/__tests__/tag-derivation.test.ts`             | CREATE | UT-19 through UT-22: Tag auto-derivation       |
| `packages/openapi/src/__tests__/with-openapi.test.ts`               | CREATE | UT-23 through UT-26: Decorator tests           |
| `packages/openapi/src/__tests__/integration/express-router.test.ts` | CREATE | IT-1 through IT-7: Express integration         |
| `packages/openapi/src/__tests__/integration/spec-serving.test.ts`   | CREATE | IT-8 through IT-10: Spec serving               |
| `packages/openapi/vitest.config.ts`                                 | CREATE | Vitest configuration (if not inherited)        |

**Implementation Details**:

#### Unit Test: registry.test.ts

```typescript
// Test pattern for UT-1:
const registry = createRouteRegistry();
registry.registerRoute('get', '/api/users', { summary: 'List users' });
const spec = registry.generateSpec({ title: 'Test', version: '1.0.0' });
expect(spec.paths['/api/users'].get.summary).toBe('List users');

// Test pattern for UT-4 (auth: false):
registry.registerRoute('post', '/api/auth/login', { auth: false });
const spec = registry.generateSpec({ title: 'Test', version: '1.0.0' });
expect(spec.paths['/api/auth/login'].post.security).toBeUndefined();

// Test pattern for UT-5 (deduplication):
registry.registerRoute('get', '/api/users', { summary: 'V1' });
registry.registerRoute('get', '/api/users', { summary: 'V2' });
// Second registration ignored; summary remains 'V1'
```

#### Integration Test: express-router.test.ts

```typescript
// Test pattern for IT-1:
import express from 'express';
import { createRouteRegistry } from '@agent-platform/openapi';
import { createOpenAPIRouter, serveOpenAPIDocs } from '@agent-platform/openapi/express';

const app = express();
const registry = createRouteRegistry();
const openapi = createOpenAPIRouter(registry, { basePath: '/api/items', tags: ['Items'] });

openapi.route('get', '/', { summary: 'List items' }, (_req, res) => res.json([]));
openapi.route('post', '/', { summary: 'Create item' }, (_req, res) => res.status(201).json({}));
openapi.route('get', '/:id', { summary: 'Get item' }, (_req, res) => res.json({}));

app.use('/api/items', openapi.router);
app.use('/docs', serveOpenAPIDocs(registry, { title: 'Test', version: '1.0.0' }));

const server = app.listen(0); // Random port
const port = (server.address() as AddressInfo).port;
// Fetch http://localhost:${port}/docs/spec.json and validate
```

**Exit Criteria**:

- [ ] All 26 unit tests pass
- [ ] All 10 integration tests pass
- [ ] `pnpm test --filter=@agent-platform/openapi` passes
- [ ] `pnpm build --filter=@agent-platform/openapi` passes
- [ ] No TypeScript errors (`tsc --noEmit`)

---

### Phase 2: Studio Route Completion (52 remaining routes)

**Goal**: Complete Studio OpenAPI annotation from 55% to 100% (117/117 routes).

**Scope**: Add the remaining 52 route definitions to `apps/studio/src/app/api/openapi/spec.json/route.ts`.

**Files to Modify**:

| File                                                  | Action | Description                         |
| ----------------------------------------------------- | ------ | ----------------------------------- |
| `apps/studio/src/app/api/openapi/spec.json/route.ts`  | MODIFY | Add 52 remaining route definitions  |
| `docs/design/openapi-studio-implementation-status.md` | MODIFY | Update status to reflect completion |

**Route Groups to Add** (from `openapi-studio-implementation-status.md`):

| Group                             | Endpoints | Priority |
| --------------------------------- | --------- | -------- |
| Remaining Auth (SSO, Device Auth) | 11        | MEDIUM   |
| Project Agents                    | 6         | HIGH     |
| MFA                               | 7         | MEDIUM   |
| Workspaces/Invitations            | 8         | MEDIUM   |
| Service Nodes                     | 5         | MEDIUM   |
| Models                            | 5         | MEDIUM   |
| Tenant Model Extensions           | 5         | MEDIUM   |
| ABL Compilation                   | 2         | LOW      |
| Admin/Monitoring                  | 3         | LOW      |

**Implementation Pattern**:
Each route follows the existing centralized tuple pattern:

```typescript
['method', '/api/path/{param}', {
  summary: 'Brief description',
  tags: ['TagGroup'],
  params: z.object({ param: z.string() }),
  body: z.object({ ... }),  // for POST/PUT/PATCH
  response: z.object({ ... }),
  auth: boolean,  // default true
  successStatus: number,  // default 200
}]
```

**Exit Criteria**:

- [ ] All 117 Studio routes defined in spec.json route
- [ ] `GET /api/openapi/spec.json` returns spec with 117+ paths
- [ ] No TypeScript errors in studio build
- [ ] Status tracker updated to 117/117

---

### Phase 3: E2E Tests

**Goal**: Create E2E test suites for Runtime and Studio OpenAPI endpoints (14 scenarios).

**Scope**: HTTP-only tests against live services verifying spec content and structure.

**Files to Create**:

| File                                                       | Action | Description                             |
| ---------------------------------------------------------- | ------ | --------------------------------------- |
| `apps/runtime/src/__tests__/openapi-e2e.test.ts`           | CREATE | E2E-1 through E2E-7: Runtime spec tests |
| `apps/studio/src/__tests__/openapi-e2e.test.ts`            | CREATE | E2E-8 through E2E-12: Studio spec tests |
| `apps/runtime/src/__tests__/openapi-cross-service.test.ts` | CREATE | E2E-13, E2E-14: Cross-service tests     |

**Implementation Details**:

```typescript
// E2E test pattern (Runtime):
describe('Runtime OpenAPI E2E', () => {
  const RUNTIME_URL = process.env.RUNTIME_URL ?? 'http://localhost:3112';

  test('GET /docs returns Swagger UI HTML', async () => {
    const res = await fetch(`${RUNTIME_URL}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('swagger-ui');
  });

  test('GET /docs/spec.json returns valid OpenAPI 3.0', async () => {
    const res = await fetch(`${RUNTIME_URL}/docs/spec.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('ABL Runtime API');
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(100);
  });
});
```

**Prerequisites**: Runtime and Studio must be running for E2E tests to pass.

**Exit Criteria**:

- [ ] All 14 E2E tests pass with live services
- [ ] Tests are HTTP-only (no mocks, no DB access)
- [ ] Tests validate spec structure, route counts, auth annotations
- [ ] Tests can be skipped via `SKIP_E2E=true` env var

---

### Phase 4: Production Hardening

**Goal**: Add production environment gating and CI validation.

**Scope**:

1. **Production gating**: Disable Swagger UI endpoints when `NODE_ENV=production` (configurable)
2. **CI spec validation**: Generate spec in CI and validate it's valid OpenAPI 3.0
3. **Shared schemas**: Extract reusable schemas (pagination, error envelope, entity IDs)

**Files to Create/Modify**:

| File                                                 | Action | Description                           |
| ---------------------------------------------------- | ------ | ------------------------------------- |
| `packages/openapi/src/shared/common-schemas.ts`      | CREATE | Shared pagination, error, ID schemas  |
| `apps/runtime/src/server.ts`                         | MODIFY | Gate `/docs` mount behind env check   |
| `apps/studio/src/app/api/openapi/route.ts`           | MODIFY | Gate Swagger UI behind env check      |
| `apps/studio/src/app/api/openapi/spec.json/route.ts` | MODIFY | Always serve spec (for health checks) |

**Implementation for Production Gating**:

```typescript
// Runtime server.ts:
const config = getConfig();
if (config.env !== 'production' || config.enableSwaggerUI) {
  app.use('/docs', serveOpenAPIDocs(runtimeRegistry, { ... }));
}
// introspectExpressRoutes always runs (spec.json may be used for health checks)
```

**Exit Criteria**:

- [ ] Swagger UI returns 404 when `NODE_ENV=production` and `ENABLE_SWAGGER_UI` is not set
- [ ] `GET /docs/spec.json` still works in production (for health/monitoring)
- [ ] Shared schemas extracted and used in both Runtime and Studio route definitions
- [ ] CI pipeline validates generated spec is valid OpenAPI 3.0

---

## 3. Wiring Checklist

| #   | Wiring Point                                    | File                                                 | Status  |
| --- | ----------------------------------------------- | ---------------------------------------------------- | ------- |
| 1   | Registry singleton created                      | `apps/runtime/src/openapi/registry.ts`               | DONE    |
| 2   | serveOpenAPIDocs mounted at /docs               | `apps/runtime/src/server.ts:848-856`                 | DONE    |
| 3   | introspectExpressRoutes called after all routes | `apps/runtime/src/server.ts:861`                     | DONE    |
| 4   | 44 route files use createOpenAPIRouter          | `apps/runtime/src/routes/*.ts`                       | DONE    |
| 5   | Studio spec.json route creates registry         | `apps/studio/src/app/api/openapi/spec.json/route.ts` | DONE    |
| 6   | Studio openapi page serves Swagger UI           | `apps/studio/src/app/api/openapi/route.ts`           | DONE    |
| 7   | Package exports: root, /express, /nextjs        | `packages/openapi/package.json`                      | DONE    |
| 8   | Unit tests in packages/openapi                  | `packages/openapi/src/__tests__/`                    | PHASE 1 |
| 9   | Integration tests in packages/openapi           | `packages/openapi/src/__tests__/integration/`        | PHASE 1 |
| 10  | E2E tests in apps/runtime and apps/studio       | `apps/*/src/__tests__/openapi-e2e.test.ts`           | PHASE 3 |
| 11  | Studio remaining 52 route definitions           | spec.json route                                      | PHASE 2 |
| 12  | Production env gating                           | server.ts + openapi route.ts                         | PHASE 4 |
| 13  | CI spec validation                              | Pipeline config                                      | PHASE 4 |

---

## 4. Risk Mitigation

| Risk                                        | Phase | Mitigation                                               |
| ------------------------------------------- | ----- | -------------------------------------------------------- |
| Tests fail due to zod-to-openapi updates    | 1     | Pin `@asteasolutions/zod-to-openapi` version in lockfile |
| Studio route definitions have schema errors | 2     | Build + typecheck after each batch of route additions    |
| E2E tests flaky due to service startup      | 3     | Add retry logic and configurable service URLs            |
| Production gating breaks health checks      | 4     | Keep spec.json endpoint always available                 |

---

## 5. Estimated Effort

| Phase | Description             | Effort      | Parallelizable                  |
| ----- | ----------------------- | ----------- | ------------------------------- |
| 1     | Package test suite      | 4-6 hours   | No (sequential)                 |
| 2     | Studio route completion | 3-4 hours   | Yes (batch by group)            |
| 3     | E2E tests               | 2-3 hours   | Yes (Runtime + Studio parallel) |
| 4     | Production hardening    | 2-3 hours   | Yes (gating + CI parallel)      |
| Total |                         | 11-16 hours |                                 |

---

## 6. Dependencies Between Phases

```
Phase 1 (Package Tests)
    ↓
Phase 2 (Studio Completion) ←──── can start in parallel with Phase 1
    ↓
Phase 3 (E2E Tests) ←──── requires Phase 2 for Studio route count assertions
    ↓
Phase 4 (Production Hardening) ←──── requires Phase 1 + 3 for test validation
```

Phase 1 and Phase 2 can be executed in parallel since they touch different packages. Phase 3 depends on Phase 2 for Studio route count assertions. Phase 4 depends on Phase 1 and 3 for test coverage validation.

---

## 7. Definition of Done

The feature is considered BETA when all of the following are true:

- [ ] All 26 unit tests pass in packages/openapi
- [ ] All 10 integration tests pass in packages/openapi
- [ ] All 14 E2E tests pass against live services
- [ ] Studio has 117/117 routes annotated
- [ ] Production environment gating is implemented and tested
- [ ] CI pipeline validates generated spec
- [ ] All TypeScript builds pass (`pnpm build`)
- [ ] All files formatted with prettier
- [ ] Feature spec, test spec, HLD, and LLD are up to date

The feature transitions to STABLE when:

- [ ] 2+ weeks in production without Swagger UI issues
- [ ] External SDK consumers have used the spec for client generation
- [ ] Route count drift detection is automated in CI

---

## 8. Revision History

| Date       | Author        | Change                                              |
| ---------- | ------------- | --------------------------------------------------- |
| 2026-03-22 | Platform Team | Initial LLD + impl plan generated via SDLC pipeline |
