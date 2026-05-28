# Feature Test Guide: SDK Channel Creation

**Feature**: Project-scoped and tenant-scoped SDK channel control-plane APIs, plus Studio proxy coverage
**Owner**: Platform team
**Related Feature Doc**: [docs/features/sub-features/sdk-channel-creation.md](../../features/sub-features/sdk-channel-creation.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-22
**Overall status**: PASSING API COVERAGE / UI HARDENING OPEN

---

## Current State (as of 2026-03-22)

The SDK channel control plane now has meaningful API-level proof across the canonical Runtime project route, the tenant-scoped Runtime admin route, and the currently shipped Studio proxy routes.

The current proof shows:

- Project-scoped Runtime CRUD works through real HTTP APIs.
- Tenant-scoped Runtime admin CRUD works through real HTTP APIs and auto-creates a default public API key when the admin flow omits `publicApiKeyId`.
- Channel-level HMAC identity policy authoring is covered through the public API contract under `identityVerification`.
- Legacy top-level identity fields (`hmacEnforcement`, `secretKey`) are rejected.
- Studio server-side proxy routes fail closed on missing Runtime configuration and preserve concealed `404` semantics for outsider/non-member access.

The remaining meaningful gap for this sub-feature is browser/admin UI proof. Current Studio coverage is API/route level, not browser automation for the Connectors/deployments UI.

### Quick Health Dashboard

| Area                                | Status     | Last Verified | Notes                                                                          |
| ----------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------------ |
| Runtime project CRUD + validation   | PASS       | 2026-03-22    | Create/list/read/update/delete plus key binding and environment validation     |
| Runtime tenant admin CRUD           | PASS       | 2026-03-22    | Auto key creation, filtered lists, concealed unauthorized mutations            |
| Identity policy lifecycle           | PASS       | 2026-03-22    | Required/optional/disabled HMAC modes, secret rotation, legacy-shape rejection |
| Studio admin proxy route guard      | PASS       | 2026-03-22    | Tenant forwarding and fail-closed Runtime URL behavior                         |
| Studio tenant-forwarded proxy authz | PASS       | 2026-03-22    | Concealed outsider/non-member denial on detail/update/delete                   |
| Browser/admin UI rendering          | NOT TESTED | —             | Requires browser automation for Connectors/deployments surfaces                |

---

## Audit Scope

This guide covers:

- Runtime project-scoped SDK-channel CRUD
- Runtime tenant-scoped SDK-channel CRUD
- Channel identity-policy configuration under `identityVerification`
- Studio admin proxy and tenant-forwarded Runtime SDK channel proxy coverage
- Validation, concealment, and default public-key auto-create behavior

---

## Coverage Goals

The sub-feature is meaningfully covered when the repo proves:

- Runtime and Studio control-plane flows work through real HTTP paths
- Default public API key creation works when the admin flow omits `publicApiKeyId`
- Project and tenant isolation/concealment hold on the SDK-channel control plane
- HMAC identity policy lifecycle is proven through the published HTTP contract
- Browser/admin UI behavior is proven, not just API behavior

---

## Test Coverage Map

### Runtime Project Route

- [x] Create/list/read/update/delete through `/api/projects/:projectId/sdk-channels`
- [x] Public API key creation plus SDK-channel binding
- [x] Legacy token route removal returns `410 LEGACY_ROUTE_REMOVED`
- [x] Project-scoped RBAC on `channel:create|read|update|delete`
- [x] API-key project-scope enforcement on project routes

### Runtime Tenant Admin Route

- [x] Create/list/read/update/delete through `/api/tenants/:tenantId/sdk-channels`
- [x] Auto-create default public API key when `publicApiKeyId` is omitted
- [x] Filter list results down to readable projects
- [x] Return concealed `404` on unauthorized mutations

### Identity Verification Settings

- [x] Reject legacy top-level `hmacEnforcement` / `secretKey`
- [x] Require nested `identityVerification.secretKey` when enforcement is `optional` or `required`
- [x] Create required-HMAC channels and enforce HMAC at `POST /api/v1/sdk/init`
- [x] Rotate HMAC secret and reject old signatures
- [x] Disable HMAC policy and allow unsigned bootstrap again
- [x] Never return `secretKey` in API responses; expose only `identityVerification.hasSecretKey`

### Studio Proxy Coverage

- [x] `/api/admin/sdk-channels` tenant forwarding
- [x] `/api/admin/sdk-channels` fail-closed Runtime URL behavior
- [x] `/api/runtime/sdk-channels/:channelId` concealed outsider/non-member denial
- [x] Preview/share suite proves outsider/non-member denial across the currently shipped Runtime SDK channel proxy routes

### Browser/UI Coverage

- [ ] Connectors/deployments create/edit/delete UI flows
- [ ] Browser proof for channel-level HMAC policy authoring

---

## Open Gaps

- **GAP-001**: Browser/admin UI rendering and edit flows are not verified via browser automation
  - **Severity**: Medium
  - **Reason**: Current proof stops at API and route levels

- **GAP-002**: `rateLimitRpm` and `allowedOrigins` are collected by some UI flows but are not fully modeled on `sdk_channels`
  - **Severity**: Low
  - **Reason**: These fields live on PublicApiKeyDoc, not SDKChannelDoc. Would need API wiring.

- **GAP-003**: Studio/browser authoring proof for HMAC identity settings is narrower than the Runtime API proof
  - **Severity**: Low
  - **Reason**: Runtime APIs are covered; Studio UI/browser flow is not yet automated

---

## Pending / Future Work

- [ ] Browser automation for Studio admin/project channel-management surfaces
- [ ] Explicit browser/admin proof for HMAC identity-policy authoring
- [ ] Decide whether `rateLimitRpm`/`allowedOrigins` should remain public-key concerns or become first-class SDK-channel API fields

---

## Enhancement Ideas

- **ENH-001**: The admin UI could expose whether a channel currently has an HMAC secret configured without exposing any secret material beyond `hasSecretKey`.
- **ENH-002**: The project picker in the create dialog could be auto-populated with the current project context if navigating from a project page.

---

## Iteration Log

### Iteration 1 — 2026-03-22

**Scope**: Runtime project/tenant CRUD, identity-policy lifecycle, Studio proxy concealment/fail-closed behavior
**Tested by**: Codex (agent)

#### Results

| #   | Test                                                      | Method                                                                                                       | Expected                                                                                               | Actual              | Status |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------- | ------ |
| 1   | Project CRUD + identity policy lifecycle                  | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`                                              | Runtime project APIs create/list/read/update/delete channels and enforce nested `identityVerification` | PASS in API harness | PASS   |
| 2   | Tenant admin CRUD + default key creation                  | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`                                              | Tenant admin APIs create/list/read/update/delete channels and auto-create a default public key         | PASS in API harness | PASS   |
| 3   | Tenant admin concealment                                  | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts`                                              | Outsider/non-member mutations return concealed `404`                                                   | PASS in API harness | PASS   |
| 4   | Project route RBAC                                        | `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`, `apps/runtime/src/__tests__/channels-authz.test.ts` | `channel:*` checks stay aligned with project roles                                                     | PASS                | PASS   |
| 5   | API-key project scoping                                   | `apps/runtime/src/__tests__/cross-project-isolation.test.ts`                                                 | Out-of-scope project access is denied on project routes                                                | PASS                | PASS   |
| 6   | Studio admin proxy fail-closed Runtime URL                | `apps/studio/src/__tests__/admin-sdk-channels-route.test.ts`                                                 | Missing Runtime base returns deterministic config error instead of forwarding                          | PASS                | PASS   |
| 7   | Studio tenant-forwarded detail/update/delete concealment  | `apps/studio/src/__tests__/sdk-runtime-channel-proxy.test.ts`                                                | Missing channel and unauthorized project access normalize to the same concealed `404`                  | PASS                | PASS   |
| 8   | Studio outsider/non-member denial on shipped proxy routes | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`                                                | List/create/detail/update/delete deny outsiders and same-tenant non-members                            | PASS                | PASS   |

#### Notes

- These tests intentionally avoid direct DB writes or direct DB assertions. All setup and verification happen through HTTP routes or browser-facing APIs.
- Current Studio coverage is route/API level, not browser-admin UI coverage.
- The removed legacy token route is covered separately by `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`.

---

## Test Environment

Runtime: local API harness (`apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`)
Studio: local route/API harness (`apps/studio/src/__tests__/helpers/studio-api-harness.ts`) plus mocked fetch only where the route under test is itself a thin proxy boundary
Persistence: harness-managed test datastore only; no direct DB interaction in assertions
