# Feature Test Guide: OpenAPI Documentation

**Feature**: Shared OpenAPI registry/helpers, Runtime docs publishing, Studio docs publishing, and adjacent design-time OpenAPI generation
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/openapi-documentation.md](../features/openapi-documentation.md)
**First audited**: 2026-03-21
**Last updated**: 2026-03-21
**Overall status**: PARTIAL

---

## Current State (as of 2026-03-21)

The platform has a real OpenAPI documentation stack, but its test coverage is still much thinner than the feature surface. Runtime publishes Swagger UI and spec JSON, Studio publishes its own Swagger UI and spec JSON, and the shared `@agent-platform/openapi` package provides the registration/plumbing layer. The checked-in tests do not directly verify those published docs endpoints, so the current confidence mostly comes from source inspection and indirect route tests rather than black-box validation.

The only explicit OpenAPI-focused test file in the repo today is `apps/studio/src/__tests__/arch-generate-openapi.test.ts`, which validates the onboarding/spec-generation path that emits OpenAPI artifacts. That is useful, but it is not proof that Runtime `/docs`, Runtime `/docs/spec.json`, Studio `/api/openapi`, or Studio `/api/openapi/spec.json` are correct. Many route tests also mock `@agent-platform/openapi` wrappers, which means they validate route business logic without exercising spec registration.

This guide is an audit-derived coverage map from the checked-in test inventory and implementation state. No fresh live E2E run was executed as part of this docs pass.

### Quick Health Dashboard

| Area                                              | Status     | Last Verified     | Notes                                                                  |
| ------------------------------------------------- | ---------- | ----------------- | ---------------------------------------------------------------------- |
| Runtime docs HTML endpoint                        | NOT TESTED | —                 | No direct test for `GET /docs`                                         |
| Runtime spec JSON endpoint                        | NOT TESTED | —                 | No direct test for `GET /docs/spec.json`                               |
| Studio docs HTML endpoint                         | NOT TESTED | —                 | No direct test for `GET /api/openapi`                                  |
| Studio spec JSON endpoint                         | NOT TESTED | —                 | No direct test for `GET /api/openapi/spec.json`                        |
| Arch-generated OpenAPI artifacts                  | PASS       | checked-in tests  | `arch-generate-openapi.test.ts` covers the design-time generation path |
| Route business logic with OpenAPI wrappers mocked | SUPPORTING | checked-in tests  | Helpful for app behavior, but not proof of docs publication            |
| Manual Studio spec inventory drift detection      | PARTIAL    | source inspection | Manual route list exists, but no automated parity test                 |

---

## Audit Scope

This guide covers four layers of confidence:

- Published Runtime docs endpoints
- Published Studio docs endpoints
- Shared `packages/openapi` primitives
- Design-time OpenAPI generation in Studio onboarding/spec-generation flows

The current audit shows strong evidence for the design-time generation path and only indirect evidence for the published docs surfaces and shared registry/router/scanner internals.

---

## Test File Catalog

### Direct OpenAPI Coverage

| File                                                      | Type        | Focus                                                                         |
| --------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/arch-generate-openapi.test.ts` | integration | Design-time OpenAPI artifact generation for Studio onboarding/spec generation |

### Supporting Coverage

| File                                      | Type             | Focus                                                                  |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-*.test.ts` | unit/integration | Studio route behavior while `withOpenAPI()` is typically mocked        |
| `apps/runtime/src/__tests__/*`            | unit/integration | Runtime route behavior while OpenAPI helpers/registry are often mocked |

---

## Coverage Goals

The feature will be meaningfully covered when the repo proves all of the following from the outside:

- Runtime Swagger UI is published at `/docs`
- Runtime OpenAPI JSON is published at `/docs/spec.json`
- Studio Swagger UI is published at `/api/openapi`
- Studio OpenAPI JSON is published at `/api/openapi/spec.json`
- Shared `packages/openapi` primitives are directly regression-tested
- Studio's manual route inventory is parity-checked against actual route handlers

---

## Test Coverage Map

### What Is Explicitly Covered

- [x] `POST /api/arch/generate` returns an OpenAPI artifact when `type: "openapi"`
- [x] `POST /api/arch/generate` rejects missing generation context for OpenAPI output

### What Is Not Yet Proved End-to-End

- [ ] `GET /docs` returns Runtime Swagger UI
- [ ] `GET /docs/spec.json` returns Runtime OpenAPI JSON with expected registered routes
- [ ] `GET /api/openapi` returns Studio Swagger UI
- [ ] `GET /api/openapi/spec.json` returns Studio OpenAPI JSON
- [ ] `packages/openapi/src/registry.ts` behavior is directly unit-tested
- [ ] `packages/openapi/src/express/create-router.ts` behavior is directly unit-tested
- [ ] `packages/openapi/src/express/introspect-routes.ts` behavior is directly unit-tested
- [ ] `packages/openapi/src/nextjs/with-openapi.ts` metadata extraction is directly unit-tested
- [ ] Studio's manual `routes[]` list is parity-checked against actual Studio route handlers

### What the Current Coverage Actually Proves

- [x] Studio can emit a design-time OpenAPI artifact in the Arch/spec-generation flow
- [x] Route handlers wrapped with OpenAPI helpers generally still behave correctly in app tests
- [ ] Published Runtime and Studio API docs are verified from the outside
- [ ] Shared OpenAPI registry/router/scanner primitives are directly regression-tested

---

## Open Gaps

- **GAP-001**: No black-box test coverage exists for Runtime `/docs` or `/docs/spec.json`
  - **Severity**: High
  - **Reason**: A bad mount path, stale cache, or registry regression could break docs publishing without current tests catching it

- **GAP-002**: No black-box test coverage exists for Studio `/api/openapi` or `/api/openapi/spec.json`
  - **Severity**: High
  - **Reason**: Studio docs are currently served through a separate manual publisher path

- **GAP-003**: `packages/openapi` has no direct unit test suite
  - **Severity**: High
  - **Reason**: Core registry/router/scanner behavior is currently protected only indirectly

- **GAP-004**: No automated parity check protects the manual Studio `routes[]` inventory from drift
  - **Severity**: Medium
  - **Reason**: Route handlers can gain or change metadata without the published Studio spec staying in sync

---

## Pending / Future Work

- [ ] Add direct package tests for `createRouteRegistry`, `createOpenAPIRouter`, `serveOpenAPIDocs`, `withOpenAPI`, and `scanNextjsRoutes`
- [ ] Add Runtime integration tests for `GET /docs` and `GET /docs/spec.json`
- [ ] Add Studio integration tests for `GET /api/openapi` and `GET /api/openapi/spec.json`
- [ ] Add a parity test between Studio route handlers and the manual `routes[]` publisher inventory
- [ ] Decide whether Studio should switch from the manual publisher to a true `withOpenAPI()` / scanner-driven spec build

---

## References

- Related feature doc: [docs/features/openapi-documentation.md](../features/openapi-documentation.md)
- Design/status tracking: `docs/design/openapi-studio-implementation-status.md`
