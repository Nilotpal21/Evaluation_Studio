# Test Specification: Auth Profile Phase 2 Core Auth Types

**Feature Spec**: [../../features/sub-features/auth-profile-phase2-core-auth-types.md](../../features/sub-features/auth-profile-phase2-core-auth-types.md)
**HLD**: [../../specs/auth-profile-phase2-core-auth-types.hld.md](../../specs/auth-profile-phase2-core-auth-types.hld.md). Parent reference: [../../specs/auth-profiles.hld.md](../../specs/auth-profiles.hld.md)
**LLD**: [../../plans/2026-04-23-auth-profile-phase2-core-auth-types-impl-plan.md](../../plans/2026-04-23-auth-profile-phase2-core-auth-types-impl-plan.md). Parent Phase 2 reference: `docs/plans/2026-03-11-auth-profile-phase2-implementation-plan.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-04-24

---

## 1. Coverage Matrix

| FR    | Description                                                                  | Unit | Integration | E2E | Manual | Status   |
| ----- | ---------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | -------- |
| FR-1  | Scope the feature to `basic`, `custom_header`, `aws_iam`, and `mtls` only    | ✅   | ✅          | ✅  | ✅     | COMPLETE |
| FR-2  | Backend create/update/list/validate flows support the four auth types        | ✅   | ✅          | ✅  | -      | PARTIAL  |
| FR-3  | Studio exposes the four auth types with matching metadata and fields         | ✅   | ✅          | ❌  | ❌     | PARTIAL  |
| FR-4  | `basic` emits a correctly encoded Basic auth header                          | ✅   | ✅          | ✅  | -      | COMPLETE |
| FR-5  | `custom_header` materializes headers and rejects config/secret key drift     | ✅   | ✅          | ✅  | -      | COMPLETE |
| FR-6  | `aws_iam` performs SigV4 signing on a supported HTTP tool path               | ❌   | ✅          | ✅  | -      | COMPLETE |
| FR-7  | `aws_iam` unsupported combinations fail closed                               | ❌   | ✅          | ✅  | -      | PARTIAL  |
| FR-8  | `mtls` propagates TLS options on the supported HTTPS HTTP tool path          | ✅   | ✅          | ✅  | -      | COMPLETE |
| FR-9  | `mtls` unsupported consumers and plain HTTP fail closed                      | ❌   | ✅          | ✅  | -      | COMPLETE |
| FR-10 | Tenant/project/user isolation semantics remain intact                        | ❌   | ✅          | ❌  | -      | PARTIAL  |
| FR-11 | Secrets stay encrypted, redacted, and sanitized in user-visible failures     | ❌   | ✅          | ✅  | -      | PARTIAL  |
| FR-12 | Supported-consumer matrix is documented in product surfaces and picker flows | ✅   | ✅          | ❌  | ❌     | PARTIAL  |

Current evidence summary:

- Shared, runtime, and compiler suites now verify the support matrix, middleware fail-closed behavior, mTLS transport wiring, and SigV4 signing seams.
- `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts` now executes real runtime paths for `basic`, `custom_header`, `aws_iam`, and `mtls` against local verifier servers, including a real HTTPS mTLS handshake.
- The same Studio E2E harness now proves fail-closed behavior for incomplete AWS IAM signing context and plain-HTTP `mtls` before any outbound request is sent.
- Studio metadata and component tests cover selector exposure, field rendering, and raw-connection attach-only messaging, but the new Playwright UI smoke spec for these types has not yet been re-run in this pass.
- Because review rounds and broader repo-wide validation are still pending, this guide stays `IN PROGRESS` to match the feature’s current `ALPHA` state.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks of codebase components, no direct DB access, and no stubbed internal services. External third-party dependencies may be replaced only through DI-friendly local test servers.

### E2E-1: Create `basic` auth profile through Studio API and execute a real HTTP tool

- **Current Coverage**: PASS — covered in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

- **Preconditions**:
  - MongoMemoryServer-backed Studio E2E harness
  - Dev-login enabled
  - Project created through `POST /api/projects`
  - Local verifier endpoint that echoes request headers
- **Steps**:
  1. `POST /api/auth/dev-login` to obtain a bearer token for Tenant A / Project Admin A.
  2. `POST /api/projects` to create Project A.
  3. `POST /api/projects/:projectId/auth-profiles` with `authType: "basic"` and valid username/password secrets.
  4. Create or configure an HTTP tool that references the returned `authProfileId`.
  5. Execute the tool through the existing Studio tool-test/runtime path against the verifier endpoint.
  6. Assert the verifier receives `Authorization: Basic <base64(username:password)>`.
- **Expected Result**: The real execution path resolves the auth profile and injects the correct Basic auth header.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: The created profile must not be readable from another project or another tenant’s auth-profile route.

### E2E-2: Create `custom_header` auth profile and verify multiple headers arrive end to end

- **Current Coverage**: PASS — covered in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

- **Preconditions**:
  - Same harness pattern as E2E-1
  - Verifier endpoint captures all incoming headers
- **Steps**:
  1. Dev-login and create Project A.
  2. `POST /api/projects/:projectId/auth-profiles` with `authType: "custom_header"`, two configured headers, and matching secret values.
  3. Configure an HTTP tool to reference the profile.
  4. Execute the tool.
  5. Assert the verifier sees both headers with the expected values.
- **Expected Result**: Header materialization works end to end on the supported HTTP tool path.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: A second user from another tenant calling the same project route receives `404`.

### E2E-3: Reject `custom_header` key drift via real Studio API

- **Current Coverage**: PARTIAL — the fail-closed behavior is covered today by `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`; a black-box Studio API regression for this exact scenario is still pending

- **Preconditions**:
  - Same harness as above
- **Steps**:
  1. Dev-login and create Project A.
  2. `POST /api/projects/:projectId/auth-profiles` with `authType: "custom_header"` where `config.headers` and `secrets.headerValues` use different keys.
  3. Assert the route returns `400`.
  4. Assert the error response references validation drift without echoing secret values.
- **Expected Result**: Create flow fails closed and does not persist an invalid profile.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: N/A for the primary assertion; malformed payload never creates a visible cross-tenant artifact.

### E2E-4: `mtls` executes successfully on a supported HTTPS HTTP tool path

- **Current Coverage**: PASS — covered in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts` using `apps/studio/src/__tests__/e2e/mtls-test-fixtures.ts`

- **Preconditions**:
  - Local HTTPS test server that requires client certificates
  - Studio + runtime tool execution harness
  - Valid test client cert, key, and optional CA cert material
- **Steps**:
  1. Dev-login and create Project A.
  2. `POST /api/projects/:projectId/auth-profiles` with `authType: "mtls"` and the TLS secret material.
  3. Configure an HTTPS HTTP tool that references the profile.
  4. Execute the tool against the mTLS-requiring test server.
  5. Assert the request succeeds only when the client cert is presented.
- **Expected Result**: The supported HTTPS tool path honors the auth profile as transport-layer client auth.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: Response and logs exposed to the user do not include raw cert/key material.

### E2E-5: `mtls` on unsupported/plain HTTP path fails closed

- **Current Coverage**: PASS — covered in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

- **Preconditions**:
  - Plain `http://` endpoint or consumer route that lacks TLS propagation
  - Same Studio/runtime harness
- **Steps**:
  1. Create an `mtls` auth profile through Studio.
  2. Attach it to a plain HTTP tool endpoint or unsupported consumer path.
  3. Trigger validation or execution.
  4. Assert the system returns a sanitized unsupported-configuration error.
  5. Assert no successful request reaches the downstream server.
- **Expected Result**: The system does not silently downgrade to unauthenticated/plain transport behavior.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: Error remains local to the caller and does not disclose other tenant/project resources.

### E2E-6: `aws_iam` signs a real supported request on the HTTP tool path

- **Current Coverage**: PASS — covered in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

- **Preconditions**:
  - Local SigV4 verifier endpoint or deterministic signature assertion server
  - Runtime path that can consume final request shape and apply signing
- **Steps**:
  1. Dev-login and create Project A.
  2. `POST /api/projects/:projectId/auth-profiles` with `authType: "aws_iam"`, `region`, `service`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken`.
  3. Configure a supported HTTP tool to reference the profile.
  4. Execute the tool against the verifier endpoint.
  5. Assert the outgoing request includes valid SigV4-derived headers such as `Authorization`, `x-amz-date`, and `x-amz-security-token` when applicable.
- **Expected Result**: The supported runtime path signs the request rather than only shaping credentials.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: User-visible failures do not reveal AWS secret material.

### E2E-7: Unsupported `aws_iam` consumer fails before sending an unsigned request

- **Current Coverage**: PARTIAL — incomplete signing context is fail-closed in `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`, and raw-connection attach-only semantics are covered in Studio component tests; a dedicated unsupported-consumer black-box E2E remains pending

- **Preconditions**:
  - Consumer path that can store `authProfileId` but does not expose a signing hook
- **Steps**:
  1. Create an `aws_iam` auth profile through Studio.
  2. Attach it to the unsupported consumer.
  3. Trigger validation, preflight, or execution.
  4. Assert the system returns a structured unsupported-configuration error.
  5. Assert the downstream endpoint receives no unsigned request.
- **Expected Result**: The system fails closed instead of silently issuing an unsigned AWS request.
- **Auth Context**: Tenant A, Project A, authenticated project admin user.
- **Isolation Check**: Error path remains scoped to the active tenant/project and does not leak internal signer details.

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Shared schema accepts all four scoped auth types and rejects malformed payloads

- **Current Coverage**: PASS — covered by `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts` and `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts`

- **Boundary**: `packages/shared` validation schema -> auth-profile config/secrets discriminated union
- **Setup**: Vitest unit/integration style schema tests using real shared schemas
- **Steps**:
  1. Parse valid `basic`, `custom_header`, `aws_iam`, and `mtls` payloads.
  2. Parse malformed variants for each type.
  3. Assert only the valid payloads succeed.
- **Expected Result**: Shared validation enforces the exact config/secret shapes.
- **Failure Mode**: Invalid payloads return schema errors instead of being normalized into unexpected shapes.

### INT-2: Studio project/workspace auth-profile routes accept the four scoped types through shared schema

- **Current Coverage**: PASS — covered by `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts`

- **Boundary**: Studio route handler -> shared validation -> model create/list/update path
- **Setup**: Existing `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts` style route tests
- **Steps**:
  1. Exercise project-scoped and workspace-scoped create routes with each auth type.
  2. Assert successful creates for well-formed payloads.
  3. Assert redacted response shaping and derived `usageMode`.
- **Expected Result**: Studio backend already accepts these types even before the selector exposes them.
- **Failure Mode**: Malformed payloads return `400` and do not persist.

### INT-3: `custom_header` key drift is rejected on the runtime route

- **Current Coverage**: PASS — covered by `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`

- **Boundary**: Runtime route handler -> shared validation -> persistence
- **Setup**: Existing `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`
- **Steps**:
  1. POST a `custom_header` payload with mismatched config/secret keys.
  2. Assert `400`.
  3. POST a matching-key payload.
  4. Assert `201`.
- **Expected Result**: Drift is rejected deterministically.
- **Failure Mode**: No profile is created for mismatched payloads.

### INT-4: `mtls` propagation from auth-profile resolution into HTTP binding

- **Current Coverage**: PASS — covered by `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`

- **Boundary**: Runtime auth resolution -> auth-profile tool middleware
- **Setup**: Existing `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`
- **Steps**:
  1. Mock resolved auth-profile result at the boundary input only.
  2. Run the real middleware.
  3. Assert `tls_options` and normal headers/query params are patched into the tool binding.
- **Expected Result**: The supported HTTP tool path receives the TLS client options needed for transport auth.
- **Failure Mode**: Missing cert/key must not produce a false-positive “supported” binding.

### INT-5: HTTP executor honors `mtls` TLS options on supported HTTPS path

- **Current Coverage**: PASS — covered by `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

- **Boundary**: HTTP executor -> transport agent / dispatcher
- **Setup**: Existing `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`
- **Steps**:
  1. Invoke the executor with `tls_options`.
  2. Assert a TLS-aware dispatcher/agent is used.
  3. Assert invalid TLS option shapes fail deterministically.
- **Expected Result**: `mtls` is materially honored at the transport layer on the supported path.
- **Failure Mode**: Invalid or unsupported TLS settings fail before a misleading success.

### INT-6: Studio auth-type metadata exposes the four scoped auth types

- **Current Coverage**: PASS — covered by `apps/studio/src/__tests__/auth-type-metadata.test.ts`, `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`, `apps/studio/src/__tests__/components/auth-profile-picker.test.tsx`, and `apps/studio/src/__tests__/components/create-connection-modal.test.tsx`

- **Boundary**: Studio metadata constants -> slide-over field rendering contract
- **Setup**: Extend `apps/studio/src/__tests__/auth-type-metadata.test.ts`
- **Steps**:
  1. Assert `AUTH_TYPE_METADATA` contains entries for `basic`, `custom_header`, `aws_iam`, and `mtls`.
  2. Assert each entry has the expected config/secret field keys.
  3. Assert the selectable type list is no longer Phase-1-only for this feature scope.
- **Expected Result**: Studio authoring contract matches the backend schema.
- **Failure Mode**: Missing metadata entries block the create flow and should fail the test.

### INT-7: `aws_iam` signer builds a canonical SigV4 request on the supported boundary

- **Current Coverage**: PASS — covered by `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts` and `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

- **Boundary**: Runtime auth resolution -> HTTP executor signing hook
- **Setup**: New integration suite in runtime/compiler that uses a local verifier and real signing code
- **Steps**:
  1. Resolve an `aws_iam` profile into the supported request path.
  2. Execute the signer with final method, URL, query, body, region, and service.
  3. Assert SigV4 headers are produced deterministically.
- **Expected Result**: `aws_iam` is honored as request-signing auth, not just typed credential shaping.
- **Failure Mode**: Missing service/region or unsupported consumer should fail before sending.

---

## 4. Unit Test Scenarios

### UT-1: `basic` auth application encodes username/password correctly

- **Module**: `packages/shared/src/services/auth-profile/apply-auth.ts`
- **Input**: `authType: "basic"`, username/password secrets
- **Expected Output**: `Authorization: Basic <base64(username:password)>`

### UT-2: `custom_header` auth application emits every configured header

- **Module**: `packages/shared/src/services/auth-profile/apply-auth.ts`
- **Input**: `authType: "custom_header"` with multiple header values
- **Expected Output**: All header/value pairs appear in the result headers map

### UT-3: `aws_iam` auth application shapes credentials without losing optional fields

- **Module**: `packages/shared/src/services/auth-profile/apply-auth.ts`
- **Input**: `region`, `service`, `accessKeyId`, `secretAccessKey`, optional `sessionToken`
- **Expected Output**: `awsCredentials` object contains the expected fields

### UT-4: `mtls` auth application shapes TLS options correctly

- **Module**: `packages/shared/src/services/auth-profile/apply-auth.ts`
- **Input**: `clientCert`, `clientKey`, optional `caCert`
- **Expected Output**: `tlsOptions` contains `cert`, `key`, and optional `ca`

### UT-5: Studio metadata defines the correct field contract for the four types

- **Module**: `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`
- **Input**: metadata constant lookup
- **Expected Output**: field keys match the shared schema and usage modes remain `preconfigured`

### UT-6: Route validation rejects unsupported `usageMode` combinations

- **Module**: shared auth-profile usage-mode resolution/validation
- **Input**: invalid authType/usageMode combinations
- **Expected Output**: deterministic validation error

---

## 5. Security & Isolation Tests

Required security and isolation coverage for this feature:

- **Cross-tenant access returns `404`**
  - Attempt to fetch, update, delete, or attach a Phase 2 core auth profile from a different tenant.
  - Expected: `404`, not `403`, with no existence leakage.
- **Cross-project access returns `404`**
  - Project-scoped profile created in Project A must not be visible or mutable from Project B.
- **Cross-user access returns `404` for personal profiles**
  - If the auth profile visibility is personal, another user in the same tenant/project must not see or mutate it.
- **Missing auth returns `401`**
  - Studio and Runtime auth-profile routes reject unauthenticated access before touching data.
- **Insufficient permissions returns `403`**
  - Authenticated user without auth-profile write permissions cannot create/update/delete.
- **Input validation rejects malformed data**
  - Invalid `custom_header` drift, malformed `mtls` secret set, unsupported `usageMode`, malformed URLs, and invalid enum values all fail with `400`.
- **Sanitized failure surfaces**
  - User-visible errors must not expose client certs, private keys, AWS secrets, or raw encrypted payloads.

---

## 6. Performance & Load Tests (if applicable)

This feature does not need a dedicated large-scale load test before implementation, but two lightweight performance checks are recommended once the supported runtime paths exist:

- verify `aws_iam` signing overhead remains bounded on a representative HTTP tool request path
- verify `mtls` does not create unbounded transport-agent churn under repeated tool execution

If runtime support expands beyond the current scoped paths, revisit with a focused performance plan.

---

## 7. Test Infrastructure

- **Required services**:
  - MongoMemoryServer for Studio E2E and route-level tests
  - Local Redis where existing auth-profile E2E harnesses require it
  - Local HTTPS test server for `mtls`
  - Local SigV4 verifier server for `aws_iam`
- **Data seeding**:
  - Use `POST /api/auth/dev-login` for authenticated test users
  - Use `POST /api/projects` to create test projects
  - Seed auth profiles through Studio/Runtime HTTP routes, not direct DB writes, for E2E coverage
- **Environment variables**:
  - `ENABLE_DEV_LOGIN=true`
  - `ENCRYPTION_MASTER_KEY`
  - MongoDB and Redis test URLs
  - Any harness-specific auth SDK signing secrets already used by Studio E2E tests
- **CI configuration**:
  - Reuse existing Studio E2E harness pattern from `tool-invocations-api.e2e.test.ts` and `integration-auth-profiles.e2e.test.ts`
  - Keep external verifier services local to the test process to avoid network flakiness

---

## 8. Surface Semantics

- **Auth profile editor**: `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` defines `AUTH_PROFILE_EDITOR_AUTH_TYPES` by combining Phase 1 types with `listSelectablePhase2CoreAuthTypes('auth_profile_editor')`, so the four shipped types are visible in Studio create/edit flows.
- **Raw connection picker**: `apps/studio/src/components/connections/CreateConnectionModal.tsx` passes `consumerKind="raw_connection"` into `AuthProfilePicker.tsx`, which uses the shared support matrix to show attach-only warnings for `aws_iam` and `mtls`.
- **Honored runtime path**: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` and `auth-profile-tool-middleware.ts` only treat the HTTP tool path as the supported honored runtime surface for `aws_iam` and `mtls`; raw connection attachment alone is not treated as proof of runtime support.

## 9. Production Wiring Verification

- **Studio authoring wiring**: `AuthProfileSlideOver.tsx` imports `AUTH_PROFILE_EDITOR_AUTH_TYPES` from `auth-type-metadata.ts`, so the four auth types are reachable from the production create/edit slide-over rather than existing only as dormant metadata.
- **Connection modal wiring**: `CreateConnectionModal.tsx` passes `consumerKind="raw_connection"` into `AuthProfilePicker.tsx`, which is the production path that surfaces attach-only warnings instead of implying raw connections honor SigV4 or mTLS automatically.
- **Runtime execution wiring**: `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts` executes the real Studio tool-invocation API path through runtime auth resolution, middleware, and `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`, proving the shipped execution seam is reachable end to end.
- **Remaining wiring follow-up**: `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts` exists for browser smoke coverage, but that Playwright path was not rerun in this verification pass.

## 10. Test File Mapping

| Test File                                                                      | Type                        | Covers                                           |
| ------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------ |
| `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts`            | unit                        | FR-1, FR-12                                      |
| `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`             | unit                        | FR-1, FR-2                                       |
| `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`         | unit                        | FR-4, FR-5, FR-8                                 |
| `packages/shared/src/__tests__/auth-profile/phase2-service.test.ts`            | unit                        | FR-2, FR-10, FR-11                               |
| `apps/studio/src/__tests__/api-routes/auth-profiles/auth-profile-api.test.ts`  | integration                 | FR-2, FR-10, FR-11                               |
| `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts` | integration                 | FR-2, FR-5, FR-10, FR-11                         |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`    | integration                 | FR-8, FR-9                                       |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts` | integration                 | FR-6, FR-7                                       |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`        | integration                 | FR-4, FR-6, FR-8, FR-9, FR-11                    |
| `apps/studio/src/__tests__/auth-type-metadata.test.ts`                         | unit / integration          | FR-3, FR-12                                      |
| `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`        | integration                 | FR-3                                             |
| `apps/studio/src/__tests__/components/auth-profile-picker.test.tsx`            | integration                 | FR-12                                            |
| `apps/studio/src/__tests__/components/create-connection-modal.test.tsx`        | integration                 | FR-12                                            |
| `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`               | e2e                         | FR-2, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, FR-11  |
| `apps/studio/src/__tests__/e2e/mtls-test-fixtures.ts`                          | e2e fixture                 | Local PEM material for FR-8, FR-9 runtime E2E    |
| `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts`                          | browser e2e (pending rerun) | Planned browser smoke validation for FR-3, FR-12 |

---

## 11. Open Testing Questions

1. A dedicated public-API isolation regression for this exact feature slice is still missing; should that land in the Studio E2E harness or a runtime HTTP harness first?
2. Should the browser-level Playwright smoke spec become part of the required post-impl sync verification set for auth-profile UI features?
3. Do we want a future consumer-aware validate route, or is picker/runtime enforcement sufficient until broader Phase 2 follow-on work?
