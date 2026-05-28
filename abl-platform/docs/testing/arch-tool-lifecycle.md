# Test Specification: Arch Tool Lifecycle

**Feature Spec**: `docs/features/arch-tool-lifecycle.md`
**HLD**: `docs/specs/arch-tool-lifecycle.hld.md`
**LLD**: `docs/plans/2026-04-21-arch-tool-lifecycle-impl-plan.md`
**Status**: PLANNED
**Last Updated**: 2026-04-21

---

## 1. Coverage Matrix

Current automated coverage for the old Arch tool-lifecycle shape exists, but it does not validate
the new Studio Test API bootstrap contract, `auth_profile_ref` authoring parity, variable
operations, or durable integration drafts. The matrix below is the **target coverage plan** for the
new design.

| FR    | Description                                                                                   | Unit             | Integration         | E2E                        | Manual | Status  |
| ----- | --------------------------------------------------------------------------------------------- | ---------------- | ------------------- | -------------------------- | ------ | ------- |
| FR-1  | Onboarding persists same-named HTTP `ProjectTool` records from agent tool contracts           | UT-4             | INT-1               | E2E-1                      | MAN-1  | PLANNED |
| FR-2  | Bootstrapped tools point to runnable Studio-hosted Test API endpoints                         | UT-2             | INT-2               | E2E-1, E2E-2               | MAN-1  | PLANNED |
| FR-3  | Agent DSL stays contract-only and runtime resolves tools by name                              | UT-4             | INT-1, INT-5        | E2E-5                      | MAN-2  | PLANNED |
| FR-4  | Same `ProjectTool` is repointed later; no second tool identity or relink step                 | UT-5             | INT-1, INT-7        | E2E-5                      | MAN-2  | PLANNED |
| FR-5  | Studio exposes public Test API invoke route and tool-scoped public OpenAPI docs               | UT-1, UT-2, UT-6 | INT-2, INT-3        | E2E-2                      | MAN-3  | PLANNED |
| FR-6  | Arch can orchestrate tool/auth/env/config CRUD and testing in-project                         | UT-3, UT-5       | INT-5, INT-6, INT-7 | E2E-3, E2E-4               | MAN-4  | PLANNED |
| FR-7  | Durable project-scoped integration drafts survive multi-step conversational pivots            | UT-5             | INT-7               | E2E-4                      | MAN-4  | PLANNED |
| FR-8  | Integration drafts support bundles of tools, auth, variables, and agent targets               | UT-5             | INT-7               | E2E-4                      | MAN-4  | PLANNED |
| FR-9  | HTTP tool authoring supports `auth_profile_ref` and related metadata with test/runtime parity | UT-4             | INT-4, INT-5        | E2E-4, E2E-5               | MAN-2  | PLANNED |
| FR-10 | Arch creates/updates env+config vars and namespace memberships for placeholder dependencies   | UT-3             | INT-5, INT-6        | E2E-3, E2E-4               | MAN-4  | PLANNED |
| FR-11 | Studio and Arch tool tests execute current endpoint and surface actionable failures           | UT-2, UT-6       | INT-5, INT-6        | E2E-3, E2E-4, E2E-5        | MAN-5  | PLANNED |
| FR-12 | Onboarding remains HTTP-only and surfaces non-HTTP gaps explicitly                            | UT-4             | INT-1               | E2E-6                      | MAN-1  | PLANNED |
| FR-13 | Public Test API uses opaque capabilities and fail-closed 404 semantics                        | UT-1, UT-6       | INT-2               | E2E-2                      | MAN-3  | PLANNED |
| FR-14 | CREATE does not silently claim success when required tool bootstrap fails                     | UT-5             | INT-1               | E2E-1, E2E-6               | MAN-1  | PLANNED |
| FR-15 | All mutations remain tenant/project scoped and auditable                                      | UT-6             | INT-2, INT-5, INT-7 | E2E-1, E2E-3, E2E-4, E2E-5 | MAN-6  | PLANNED |

---

## 2. E2E Test Scenarios

E2E tests must use real HTTP APIs, real Studio/Runtime servers on random ports, real Mongo/Redis,
and real middleware. External dependencies such as a sample customer API may be replaced with a
test server started inside the test process, but platform components must not be mocked.

### E2E-1: Onboarding Create-Project Lands Runnable HTTP Tools

- **Preconditions**: Studio, Runtime, MongoDB, and Redis are running. A valid onboarding user is
  authenticated. The test LLM provider is wired through the same public Arch session/message APIs.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with onboarding mode and record the new `sessionId`.
  2. Drive the INTERVIEW and BLUEPRINT phases through the public Arch message/gate APIs until the
     topology is approved.
  3. Drive the BUILD phase until generated agents include at least two HTTP-capable tool
     declarations.
  4. Trigger project creation through the same Arch create-project flow the UI uses.
  5. `GET /api/projects/:projectId/tools` and assert exactly one `ProjectTool` exists per unique
     tool name referenced by the generated agents.
  6. Assert each created tool is `toolType: 'http'`, its `name` matches the agent tool contract,
     and its configured endpoint points to the Studio-hosted Test API origin rather than a dead
     placeholder URL.
  7. For one created tool, call `POST /api/projects/:projectId/tools/:toolId/test` with valid
     inputs and assert the test succeeds with deterministic JSON.
  8. Re-run the same create-project request or retry path and assert no duplicate tools or
     duplicate bootstrap endpoint records are created.
- **Expected Result**: The created project lands with real runnable HTTP project tools that can be
  tested immediately. Retries are idempotent.
- **Auth Context**: `tenantId` + authenticated onboarding user with project create permissions.
- **Isolation Check**: A second tenant requesting `GET /api/projects/:projectId/tools` for the new
  project receives 404.

### E2E-2: Public Studio Test API Invoke and Tool-Scoped OpenAPI Spec

- **Preconditions**: A bootstrapped HTTP tool exists from E2E-1, and its endpoint points at the
  Studio Test API.
- **Steps**:
  1. Read the tool detail from `GET /api/projects/:projectId/tools/:toolId` and capture the
     public invoke URL and public spec URL surfaced by the tool.
  2. `POST` the invoke URL directly over HTTPS without authentication, using a request body that
     matches the tool parameter schema.
  3. Assert a `200` response with deterministic JSON and no tenant IDs, project IDs, or internal
     collection IDs in the body.
  4. `GET` the public spec URL and assert the response is valid OpenAPI JSON that contains the
     tool name, parameter schema, and response schema.
  5. `POST` to the invoke route with an invalid capability and `GET` the spec route with an
     invalid capability.
  6. Assert both invalid requests return the same sanitized 404 envelope and do not reveal whether
     a project or tool exists.
- **Expected Result**: Public invocation and public documentation both work for a valid tool
  capability and both fail closed for invalid capabilities.
- **Auth Context**: Public route; no Studio auth headers should be required.
- **Isolation Check**: The invalid-capability 404 must be indistinguishable from a capability that
  belongs to another project or tenant.

### E2E-3: Arch Creates a Live HTTP Tool With Env/Config Dependencies and Tests It

- **Preconditions**: An existing project is available. A real test HTTP server is started on a
  random port and exposes `GET /shipments/:id?region=...`.
- **Steps**:
  1. Create an IN_PROJECT Arch session for the target project.
  2. Send a natural-language request asking Arch to create a `lookup_shipment` HTTP tool that
     calls the external test server and uses `{{env.SHIPPING_BASE_URL}}` plus
     `{{config.DEFAULT_REGION}}`.
  3. Answer any short blocking prompts or confirmation widgets through the normal Arch interaction
     route.
  4. Assert `GET /api/projects/:projectId/tools` includes `lookup_shipment` with the expected
     placeholder-bearing endpoint or query template.
  5. Assert the required environment variable and config variable now exist through
     `GET /api/projects/:projectId/env-vars` and
     `GET /api/projects/:projectId/config-variables`.
  6. Assert namespace memberships were created for the tool and the new variables.
  7. Ask Arch to test the tool and assert the result matches the external test server response.
- **Expected Result**: Arch completes the tool + env/config + test loop without forcing the user to
  leave the conversation or hand-create variables.
- **Auth Context**: Authenticated project user with tool/config/env permissions.
- **Isolation Check**: A different project in the same tenant cannot read or test the created tool
  or variables.

### E2E-4: Arch Pivots From Tool Creation to Auth Setup and Resumes the Same Draft

- **Preconditions**: An existing project is available. A real test HTTP server is started on a
  random port and requires `Authorization: Bearer test-token`.
- **Steps**:
  1. Create an IN_PROJECT Arch session for the project.
  2. Ask Arch to create a secure `get_customer` tool for the external server.
  3. Let Arch reach the point where it surfaces missing auth or a blocked test result.
  4. Change the conversation and ask Arch to create the shared auth profile needed for the same
     integration.
  5. Complete the secure secret-entry interaction using the existing Arch secret collection flow.
  6. Send a follow-up message such as “continue the tool setup.”
  7. Assert Arch resumes the same integration draft, attaches the auth profile, and completes a
     successful tool test.
  8. `GET` the project auth profiles and assert the new profile exists and is linked by reference
     from the tool definition.
- **Expected Result**: The conversation can pivot from tool definition to auth creation and back
  again without losing progress or creating duplicate tools.
- **Auth Context**: Authenticated project user with tool + auth profile permissions.
- **Isolation Check**: A different user in the same tenant cannot resume or mutate the first
  user’s in-progress integration draft unless they already have project-level access and the draft
  is intentionally shared.

### E2E-5: Repoint the Same Project Tool From Studio Test API to a Real API Without Agent Edits

- **Preconditions**: A project created from onboarding already contains a bootstrapped `get_customer`
  tool and at least one agent whose `TOOLS` contract references `get_customer`. A real external
  test HTTP server is available.
- **Steps**:
  1. Read the current agent definition or agent detail and capture the original `TOOLS`
     declaration for `get_customer`.
  2. Create or update the environment variables and auth profile required for the real external
     server.
  3. Update the existing project tool through the normal tool update route or through Arch so its
     endpoint now points at the external API instead of the Studio Test API.
  4. `POST /api/projects/:projectId/tools/:toolId/test` and assert the response now comes from the
     external test server.
  5. Read the agent definition again and assert the `TOOLS` contract is unchanged.
  6. Assert the project still contains the same tool record, not a duplicate “live” tool.
- **Expected Result**: The same `ProjectTool` identity is reused when moving from Studio bootstrap
  behavior to the real API. Agents remain unchanged.
- **Auth Context**: Authenticated project user with tool update and test permissions.
- **Isolation Check**: Cross-project update or test attempts on the tool return 404.

### E2E-6: Non-HTTP Onboarding Tool Contracts Fail Closed

- **Preconditions**: An onboarding run generates or imports at least one non-HTTP tool contract
  such as an MCP- or sandbox-style declaration.
- **Steps**:
  1. Create an onboarding Arch session and drive it through BUILD with the non-HTTP tool contract
     present in the generated agent set.
  2. Trigger project creation.
  3. Assert the response surfaces an explicit unsupported-tool or incomplete-bootstrap state.
  4. `GET /api/projects/:projectId/tools` and assert no sandbox or MCP `ProjectTool` was silently
     auto-created by the onboarding fallback.
  5. If the product chooses to allow project creation with warnings, assert the unsupported tool is
     visible as a clear unresolved gap.
- **Expected Result**: Onboarding never silently converts non-HTTP contracts into sandbox or other
  tool types.
- **Auth Context**: Authenticated onboarding user with project create permissions.
- **Isolation Check**: Cross-tenant access to the incomplete project or its warnings returns 404.

---

## 3. Integration Test Scenarios

### INT-1: Finalize-Project HTTP Bootstrap Is Idempotent and HTTP-Only

- **Boundary**: `finalize-project.ts` -> tool bootstrap synthesizer -> `tool-creation-service.ts`
  -> `project_tools` + `tool_test_endpoints`.
- **Setup**: Real Mongo models with the normal Studio create-project path. BUILD outputs contain a
  mix of HTTP-capable and non-HTTP-capable tool declarations.
- **Steps**:
  1. Invoke the finalize-project path once with two unique HTTP-capable contracts and one
     unsupported contract.
  2. Assert two HTTP project tools and two bootstrap endpoint records are created.
  3. Assert the unsupported contract is returned as an explicit gap or incomplete state.
  4. Invoke the same finalize-project path again with the same input.
  5. Assert no duplicate tools or endpoint records are created and existing records are updated in
     place when appropriate.
- **Expected Result**: Finalize-project is safe to retry and enforces HTTP-only onboarding.
- **Failure Mode**: If endpoint or metadata creation fails for a required tool, finalize-project
  returns an incomplete/error result instead of claiming success.

### INT-2: Public Capability Routing, Rate Limiting, and Sanitized Errors

- **Boundary**: `POST /api/public/tool-test/[capability]` and
  `GET /api/public/tool-test/specs/[capability]/openapi.json` ->
  tool-test-endpoint lookup/service -> response renderer / OpenAPI builder.
- **Setup**: Real Studio route handlers with one active capability, one disabled capability, and
  one random invalid capability.
- **Steps**:
  1. Request the invoke and spec routes with a valid capability and assert `200`.
  2. Request both routes with a disabled capability and assert sanitized `404`.
  3. Request both routes with a random invalid capability and assert the same sanitized `404`.
  4. Burst valid requests above the configured public limit and assert `429` without leaking
     internal metadata.
  5. Verify all responses use the standard `{ success, error }` envelope on failure.
- **Expected Result**: Public routes resolve only valid active capabilities, are rate limited, and
  fail closed for all invalid states.
- **Failure Mode**: Corrupt endpoint metadata results in a server trace/log and a sanitized
  `500` response, never raw model details.

### INT-3: Tool-Scoped OpenAPI Generation Matches the Project Tool Contract

- **Boundary**: Tool-test OpenAPI builder service -> public spec route.
- **Setup**: A bootstrapped HTTP tool with parameters, descriptions, and a static JSON response.
- **Steps**:
  1. Generate the public OpenAPI document for the tool.
  2. Assert the `operationId`, summary, parameter schema, request body shape, and response schema
     match the `ProjectTool` contract.
  3. Assert the spec references the public invoke URL for the same capability.
  4. Update the tool signature and regenerate the spec.
  5. Assert the spec changes accordingly and stale schema content is not served.
- **Expected Result**: The public OpenAPI document is derived from the actual tool contract and
  stays aligned after edits.
- **Failure Mode**: Missing or corrupted tool metadata returns sanitized `404`/`500` without
  exposing internal IDs.

### INT-4: HTTP Authoring Round-Trip Preserves `auth_profile_ref` Metadata

- **Boundary**: `project-tool-form.ts` ->
  `project-tool-schemas.ts` -> `serialize-tool-form-to-dsl.ts` ->
  `parse-dsl-to-tool-form.ts` -> Studio create/update routes.
- **Setup**: HTTP tool form data containing `authProfileRef`, `jitAuth`, `consentMode`, and
  `connectionMode`.
- **Steps**:
  1. Validate the form payload against the Studio create/update schema.
  2. Serialize it to DSL and assert the auth-profile metadata is present.
  3. Parse the DSL back into form data and assert the same values are preserved.
  4. Send the payload through the Studio tool create route and read the stored tool back.
  5. Assert the create/update path round-trips the same metadata without downgrading to inline-only
     auth.
- **Expected Result**: Studio authoring, storage, and parsing all preserve auth-profile-backed HTTP
  tool metadata.
- **Failure Mode**: Invalid combinations are rejected with `400` and a structured validation error.

### INT-5: Studio Tool-Test Service Matches Runtime Auth and Env Resolution

- **Boundary**: `tool-test-service.ts` -> shared auth/env resolution helpers ->
  auth profiles, env vars, config vars, namespace memberships.
- **Setup**: A project tool that uses `auth_profile_ref`, `{{env.BASE_URL}}`, and
  `{{config.REGION}}`, plus matching auth profile and variable records in a project namespace.
- **Steps**:
  1. Execute the Studio tool-test route for the tool in `global`, `dev`, and `production`
     environments.
  2. Assert the service resolves auth headers from the referenced auth profile using the same
     precedence rules as runtime.
  3. Assert environment lookup uses `global` and `production`, not `null` and `prod`.
  4. Compare the resolved request configuration with the runtime loader/test helper for the same
     tool.
- **Expected Result**: Studio tool tests and runtime execution agree on auth-profile and
  namespace-scoped env/config resolution.
- **Failure Mode**: Missing profiles or variables return actionable configuration errors, not
  misleading transport failures.

### INT-6: `variable_ops` Creates Variables and Namespace Memberships Correctly

- **Boundary**: Arch `variable_ops` -> env var/config var services -> namespace membership writes.
- **Setup**: An IN_PROJECT Arch session with project access and at least one variable namespace.
- **Steps**:
  1. Create an environment variable through `variable_ops`.
  2. Create a config variable through `variable_ops`.
  3. Create both with explicit namespace IDs and assert memberships are present.
  4. Create one without explicit namespaces and assert the default namespace is linked.
  5. Update both variables and assert the changes are visible via the normal project routes.
  6. Delete them and assert memberships are cleaned up.
- **Expected Result**: Arch variable operations behave like first-class project mutations and keep
  namespace memberships aligned.
- **Failure Mode**: Cross-project or unknown namespace IDs return 404/400 in the same safe shape as
  the existing project-scoped APIs.

### INT-7: Integration Draft Persistence Supports Multi-Tool Bundles and Resume

- **Boundary**: Integration draft service/model -> Arch session metadata pointer ->
  `tools_ops`, `auth_ops`, `variable_ops`, resume snapshot logic.
- **Setup**: One project, one Arch session, two related tools, one auth profile, and a shared
  namespace.
- **Steps**:
  1. Start a new integration draft and attach two tool intents plus one shared auth requirement.
  2. Persist partial progress after only one tool is created.
  3. Interrupt the flow and rebuild the resume snapshot.
  4. Assert the snapshot still points to the active draft and exposes the remaining steps.
  5. Resume the flow, add the missing variables and auth profile, and mark the draft complete.
  6. Assert the draft is archived or completed cleanly and the session pointer is cleared or moved.
- **Expected Result**: Arch can keep durable state for 1..N tools plus shared dependencies across
  conversation turns.
- **Failure Mode**: Partially applied drafts remain queryable and recoverable rather than becoming
  orphaned silent failures.

---

## 4. Unit Test Scenarios

### UT-1: Public Capability Generation and Matching

- **Module**: `tool-test-endpoint-service` capability helpers.
- **Input**: New tool-test endpoint records, rotated capabilities, invalid tokens.
- **Expected Output**: Generated capabilities are opaque, stored hashed, and only exact matches
  resolve.

### UT-2: Static JSON Response Rendering

- **Module**: Studio Test API response renderer.
- **Input**: Tool parameter schema, sample input, static JSON payload.
- **Expected Output**: Renderer returns deterministic JSON, validates input shape, and strips
  internal metadata from output.

### UT-3: Placeholder Requirement Extraction

- **Module**: Placeholder extraction helper used by `tools_ops` / `variable_ops`.
- **Input**: Tool endpoint templates, headers, and auth metadata containing `{{env.*}}` and
  `{{config.*}}`.
- **Expected Output**: Returns deduplicated env/config requirements plus namespace linkage hints.

### UT-4: HTTP Tool Schema Round-Trip With Auth Profile Metadata

- **Module**: Shared HTTP tool validation/serialization/parsing pipeline.
- **Input**: HTTP tool form data including `authProfileRef`, `jitAuth`, `consentMode`,
  `connectionMode`.
- **Expected Output**: Exact round-trip without dropping or mutating auth-profile fields.

### UT-5: Integration Draft Step Evaluation

- **Module**: Integration draft state reducer/service.
- **Input**: Drafts with partial tool/auth/variable/test completion states.
- **Expected Output**: Correct `status`, `pendingSteps`, and “ready to test/apply” transitions.

### UT-6: Public Error Sanitization

- **Module**: Public Test API error-envelope builder.
- **Input**: Invalid capability, disabled capability, malformed input, internal exception.
- **Expected Output**: Sanitized 404/400/500 envelopes with no tenant IDs, project IDs, or secret
  details.

---

## 5. Security & Isolation Tests

- [ ] Missing auth on project-scoped routes returns `401`.
- [ ] Insufficient project permissions on tool/auth/config/env/draft routes return `403`.
- [ ] Cross-tenant access to project tools, auth profiles, variables, drafts, and tool tests returns
      `404`.
- [ ] Cross-project access to project-scoped resources returns `404`.
- [ ] Public invoke and public spec routes return identical sanitized `404` responses for invalid,
      revoked, disabled, or foreign capabilities.
- [ ] Public invoke responses never leak tenant IDs, project IDs, raw capability hashes, auth
      profile IDs, or secret values.
- [ ] SSRF protections still reject unsafe external endpoints when repointing a tool from the
      Studio Test API to a real endpoint.
- [ ] Secret-entry flows keep credentials out of chat transcripts and persisted session messages.
- [ ] Audit events are emitted for tool bootstrap, tool repoint, auth-profile creation, variable
      creation, draft state changes, and capability rotation/revocation.

---

## 6. Performance & Load Tests

- Public Studio Test API invoke route should stay comfortably below normal external API latency for
  static JSON responses; target p95 under 150 ms in local/service benchmarks.
- Public OpenAPI generation should be cacheable or memoized per tool so repeat reads do not rebuild
  the document unnecessarily.
- Create-project bootstrap should scale linearly with tool count and remain idempotent under retry.
- Arch integration-draft queries must stay project-scoped and bounded to active/recent drafts to
  avoid large-session regressions.

---

## 7. Test Infrastructure

- **Required services**:
  - Studio
  - Runtime
  - MongoDB
  - Redis
  - Test LLM provider or scripted external-model adapter wired through the same public Arch APIs
  - Real external HTTP test servers for live-tool scenarios
- **Data seeding**:
  - Tenant + user fixtures
  - Project fixtures with at least one agent and one tool contract
  - Variable namespaces, including a default namespace
  - Auth profiles with encrypted secrets for shared-auth scenarios
  - Public tool-test endpoint records for invoke/spec route tests
- **Environment variables**:
  - `NEXT_PUBLIC_APP_URL`
  - `NEXTAUTH_URL`
  - Runtime base URL / Studio base URL values used by server-side fetches
  - Auth/profile crypto keys already required by existing auth-profile tests
  - Any feature flag used to gate the new lifecycle path
- **CI configuration**:
  - Studio and Runtime integration suites must run against real Mongo/Redis containers
  - E2E jobs should start real Studio and Runtime servers on random ports
  - Public-route tests should use real HTTP requests, not direct function invocation

---

## 8. Test File Mapping

| Test File                                                                      | Type        | Covers                          |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------- |
| `apps/studio/e2e/arch-tool-lifecycle/onboarding-bootstrap.e2e.test.ts`         | e2e         | E2E-1, FR-1, FR-2, FR-12, FR-14 |
| `apps/studio/e2e/arch-tool-lifecycle/public-tool-test-api.e2e.test.ts`         | e2e         | E2E-2, FR-5, FR-13, FR-15       |
| `apps/studio/e2e/arch-tool-lifecycle/in-project-tool-and-vars.e2e.test.ts`     | e2e         | E2E-3, FR-6, FR-10, FR-11       |
| `apps/studio/e2e/arch-tool-lifecycle/integration-draft-resume.e2e.test.ts`     | e2e         | E2E-4, FR-6, FR-7, FR-8, FR-9   |
| `apps/studio/e2e/arch-tool-lifecycle/repoint-same-tool.e2e.test.ts`            | e2e         | E2E-5, FR-3, FR-4, FR-9, FR-11  |
| `apps/studio/e2e/arch-tool-lifecycle/non-http-onboarding-gap.e2e.test.ts`      | e2e         | E2E-6, FR-12, FR-14             |
| `apps/studio/src/__tests__/arch-ai/finalize-project-tool-bootstrap.test.ts`    | integration | INT-1, FR-1, FR-2, FR-12, FR-14 |
| `apps/studio/src/__tests__/api-routes/public-tool-test-api.test.ts`            | integration | INT-2, FR-5, FR-13, FR-15       |
| `apps/studio/src/__tests__/tool-test-openapi-builder.test.ts`                  | integration | INT-3, FR-5                     |
| `packages/shared/src/tools/__tests__/http-tool-auth-profile-roundtrip.test.ts` | integration | INT-4, FR-9                     |
| `apps/studio/src/__tests__/tool-test-service.test.ts`                          | integration | INT-5, FR-9, FR-11              |
| `apps/studio/src/__tests__/arch-ai/variable-ops.test.ts`                       | integration | INT-6, FR-6, FR-10, FR-15       |
| `apps/studio/src/__tests__/arch-ai/integration-draft-service.test.ts`          | integration | INT-7, FR-7, FR-8, FR-15        |
| `apps/studio/src/__tests__/tool-test-endpoint-service.test.ts`                 | unit        | UT-1, UT-2, UT-6                |
| `packages/shared/src/tools/__tests__/placeholder-requirements.test.ts`         | unit        | UT-3, FR-10                     |
| `packages/shared/src/tools/__tests__/http-tool-form-roundtrip.test.ts`         | unit        | UT-4, FR-9                      |
| `apps/studio/src/__tests__/arch-ai/integration-draft-state.test.ts`            | unit        | UT-5, FR-7, FR-8                |

---

## 9. Open Testing Questions

1. No blocking test-design questions remain for the v1 contract.
2. Per-user OAuth consent coverage should be added only after the shared-auth `auth_profile_ref`
   path is stable; it is not a release blocker for the initial rollout.
