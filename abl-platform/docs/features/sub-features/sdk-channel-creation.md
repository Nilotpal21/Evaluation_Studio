# Feature: SDK Channel Creation

**Doc Type**: SUB-FEATURE
**Parent Feature**: [SDK](../sdk.md) / [Channels](../channels.md)
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `admin operations`, `integrations`, `governance`
**Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/config`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/sdk-channel-creation.md](../../testing/sub-features/sdk-channel-creation.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

SDK-backed experiences need a control-plane resource that is distinct from generic webhook or voice connections. A web widget, mobile client, voice SDK client, or direct API integration needs a stable channel record, public key binding, deployment/environment context, and channel-level identity policy controls without forcing each integrator to build that management layer manually.

### Goal Statement

The goal of SDK Channel Creation is to provide the CRUD and identity-policy configuration layer that provisions `sdk_channels`, binds them to public API keys, and makes those records available to the broader SDK and Channels runtime paths.

### Summary

SDK Channel Creation is the focused feature that provisions and manages SDK-facing channel records for a project or tenant. It sits underneath the broader [Channels](../channels.md) feature and covers the CRUD paths that create `sdk_channels` records, link them to `public_api_keys`, and optionally pin them to a deployment or environment.

The implementation has two entry points: a canonical project-scoped Runtime API under `/api/projects/:projectId/sdk-channels`, and a tenant-scoped admin convenience layer under `/api/tenants/:tenantId/sdk-channels` that lets the Studio admin UI manage SDK channels across projects. The tenant route auto-creates a default public API key when the caller does not provide one.

---

## 2. Scope

### Goals

- Provide project-scoped and tenant-admin CRUD for `sdk_channels`.
- Bind SDK channels to public API keys, optional deployment pins, and environment-follow behavior.
- Support channel-level identity policy configuration (for example HMAC enforcement/secret material) without introducing a second persistence system.

### Non-Goals (Out of Scope)

- This feature does not cover the full embedded client runtime; that belongs to the parent [SDK](../sdk.md) feature.
- This feature does not make `rateLimitRpm` or `allowedOrigins` fully first-class on the `sdk_channels` model today.
- This feature does not yet provide browser-driven UI coverage for create/edit/delete flows.

---

## 3. User Stories

1. As a project operator, I want to create and manage SDK channel records so embeds and SDK clients can bootstrap against the right deployment and permissions.
2. As a tenant admin, I want a convenience route that can manage SDK channels across projects without manually navigating every project-scoped endpoint.
3. As a platform engineer, I want SDK channel creation to reuse the same Runtime repo, auth, and validation layers as the broader Channels control plane.

---

## 4. Functional Requirements

1. **FR-1**: The system must support project-scoped CRUD for `sdk_channels`.
2. **FR-2**: The system must support tenant-scoped admin CRUD for `sdk_channels` through a Runtime admin convenience layer.
3. **FR-3**: The system must auto-create a default public API key when the tenant-admin flow omits `publicApiKeyId`.
4. **FR-4**: The system must validate supported SDK channel types, environments, and optional deployment pins.
5. **FR-5**: The system must keep canonical SDK bootstrap on `POST /api/v1/sdk/init` (public key or Studio bootstrap artifact exchange) and treat legacy SDK channel token issuance routes as removed compatibility stubs.
6. **FR-6**: The system must encrypt per-channel HMAC secret material at rest.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                         |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | SDK channels are project-owned deployment resources                           |
| Agent lifecycle            | SECONDARY    | Deployment/environment selection shapes which agent version SDK clients reach |
| Customer experience        | SECONDARY    | End-user behavior depends on which SDK channel/deployment an embed resolves   |
| Integrations / channels    | PRIMARY      | This is the control-plane resource for SDK-backed channel integrations        |
| Observability / tracing    | NONE         | The feature is mostly metadata CRUD; broader runtime tracing lives elsewhere  |
| Governance / controls      | SECONDARY    | RBAC, environment validation, and tenant-admin boundaries are enforced here   |
| Enterprise / compliance    | SECONDARY    | Encrypted secret storage and cross-scope isolation matter materially          |
| Admin / operator workflows | PRIMARY      | Studio admin and project flows both depend on this feature                    |

### Related Feature Integration Matrix

| Related Feature                                          | Relationship Type | Why It Matters                                                                                     | Key Touchpoints                                       | Current State |
| -------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| [Channels](../channels.md)                               | belongs to        | SDK channels are one branch of the broader channel control plane.                                  | `sdk_channels`, shared repos, RBAC, CRUD patterns     | Active        |
| [SDK](../sdk.md)                                         | configured by     | The SDK runtime consumes the records created here for bootstrap and channel-level identity policy. | `publicApiKeyId`, deployment context, identity policy | Active        |
| [Deployments & Versioning](../deployments-versioning.md) | depends on        | Deployment pinning and environment-follow behavior determine which agent version the SDK targets.  | `deploymentId`, `environment`, `followEnvironment`    | Active        |

---

## 6. Design Considerations (Optional)

- The feature intentionally exposes both a canonical project route and a tenant-admin convenience layer rather than duplicating persistence logic.
- SDK channel creation is a sub-feature because it is narrower than the full SDK runtime/client surface and narrower than the full Channels manifest/runtime surface.
- Studio uses both a project deployment UI and an admin proxy flow, so the docs need to keep those two operator paths explicit.

---

## 7. Technical Considerations (Optional)

- The tenant-admin route resolves or auto-creates a default public API key when one is not supplied.
- `VALID_ENVIRONMENTS` is the shared source of truth for environment validation.
- Legacy SDK channel token issuance routes are removed from the canonical Studio/browser flow; canonical SDK browser/session bootstrap uses `POST /api/v1/sdk/init`.

---

## 8. How to Consume

### Studio UI

SDK channels appear in two Studio surfaces:

- **Project deployment flow** via the Channels UI (`ChannelsTab`, `ChannelCatalog`, `ChannelInstanceConfig`)
- **Tenant admin flow** via `ConnectorsPage`, which talks to the admin proxy and can create or update SDK channels without first navigating into a specific project

Studio also provides Runtime proxy routes under `/api/runtime/sdk-channels` so the project UI can talk to the canonical Runtime API without embedding Runtime URLs in the browser.

### API (Runtime)

| Method | Path                                               | Purpose                                      |
| ------ | -------------------------------------------------- | -------------------------------------------- |
| GET    | `/api/projects/:projectId/sdk-channels`            | List SDK channels for a project              |
| POST   | `/api/projects/:projectId/sdk-channels`            | Create a project-scoped SDK channel          |
| GET    | `/api/projects/:projectId/sdk-channels/:channelId` | Get one SDK channel                          |
| PATCH  | `/api/projects/:projectId/sdk-channels/:channelId` | Update one SDK channel                       |
| DELETE | `/api/projects/:projectId/sdk-channels/:channelId` | Delete one SDK channel                       |
| GET    | `/api/tenants/:tenantId/sdk-channels`              | List tenant-wide SDK channels (admin layer)  |
| POST   | `/api/tenants/:tenantId/sdk-channels`              | Create tenant-wide SDK channel (admin layer) |
| GET    | `/api/tenants/:tenantId/sdk-channels/:channelId`   | Get one tenant-wide SDK channel              |
| PATCH  | `/api/tenants/:tenantId/sdk-channels/:channelId`   | Patch one tenant-wide SDK channel            |
| PUT    | `/api/tenants/:tenantId/sdk-channels/:channelId`   | Update tenant-wide SDK channel               |
| DELETE | `/api/tenants/:tenantId/sdk-channels/:channelId`   | Delete tenant-wide SDK channel               |

### API (Studio)

| Method | Path                                      | Purpose                                         |
| ------ | ----------------------------------------- | ----------------------------------------------- |
| GET    | `/api/admin/sdk-channels`                 | Tenant-admin proxy to Runtime tenant route      |
| POST   | `/api/admin/sdk-channels`                 | Create SDK channel via admin proxy              |
| PUT    | `/api/admin/sdk-channels?channelId=...`   | Update SDK channel via admin proxy              |
| DELETE | `/api/admin/sdk-channels?channelId=...`   | Delete SDK channel via admin proxy              |
| GET    | `/api/runtime/sdk-channels?projectId=...` | Project UI proxy to Runtime project-scoped list |
| POST   | `/api/runtime/sdk-channels?projectId=...` | Project UI proxy to Runtime create route        |
| GET    | `/api/runtime/sdk-channels/:channelId`    | Project UI proxy to detail route                |
| PATCH  | `/api/runtime/sdk-channels/:channelId`    | Project UI proxy to update route                |
| DELETE | `/api/runtime/sdk-channels/:channelId`    | Project UI proxy to delete route                |

Current Studio proxy contract note: list/create require `projectId` in the query string because they remain project-scoped. Detail/update/delete now resolve the tenant-scoped Runtime admin path under Studio tenant auth and normalize concealed `404` responses.

Legacy compatibility path (removed and non-canonical for SDK session bootstrap):

- `POST /api/projects/:projectId/sdk-channels/:channelId/token`
- current Runtime route returns `410 LEGACY_ROUTE_REMOVED`
- there is no current Studio proxy token route for this path

### Admin Portal

The Studio admin proxy requires tenant auth plus `requireAdminRole()`. It is intentionally thin: it forwards headers and tenant context to the Runtime tenant route and leaves validation and persistence to Runtime.

### Channel / SDK / Voice / A2A / MCP Integration

Accepted SDK channel types are:

- `web`
- `mobile_ios`
- `mobile_android`
- `voice`
- `api`

Each record can either follow the active environment deployment or pin to a specific deployment. Canonical SDK initialization then resolves `tenantId`, `projectId`, `channelId`, and permissions through Runtime `POST /api/v1/sdk/init` (public key or Studio bootstrap-artifact exchange).

---

## 9. Data Model

### Collections / Tables

```text
Collection: sdk_channels
Fields:
  - _id: string
  - tenantId: string
  - projectId: string
  - deploymentId: string | null
  - name: string
  - channelType: string
  - publicApiKeyId: string
  - config: Mixed
  - isActive: boolean
  - environment: 'dev' | 'staging' | 'production' | null
  - followEnvironment: boolean
  - secretKey: string | null (encrypted)
  - authProfileId: string | null
  - hmacEnforcement: 'disabled' | 'optional' | 'required'
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } unique
  - { tenantId: 1, projectId: 1 }
  - { publicApiKeyId: 1 }
  - { projectId: 1, environment: 1, followEnvironment: 1 }
Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin on `secretKey`
```

```text
Collection: public_api_keys
Fields:
  - _id: string
  - projectId: string
  - keyPrefix: string
  - keyHash: string
  - name: string
  - allowedOrigins: string[] | null
  - permissions: Mixed
  - expiresAt: Date | null
  - isActive: boolean
Indexes:
  - { keyHash: 1 } unique
  - { projectId: 1 }
```

### Key Relationships

- `sdk_channels.publicApiKeyId` -> `public_api_keys._id`
- `sdk_channels.deploymentId` -> deployment record for pinned rollout behavior
- Canonical SDK bootstrap does not persist extra token documents; Runtime issues short-lived `sdk_session` tokens from validated bootstrap inputs.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                   | Purpose                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/runtime/src/repos/channel-repo.ts`               | CRUD persistence, default public API key helper, formatting |
| `packages/database/src/models/sdk-channel.model.ts`    | SDK channel schema, indexes, encryption                     |
| `packages/database/src/models/public-api-key.model.ts` | Public key schema and project binding                       |
| `packages/config/src/environment.ts`                   | `VALID_ENVIRONMENTS` constant used by both routes           |

### Routes / Handlers

| File                                                                | Purpose                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/sdk-channels.ts`                           | Canonical project-scoped SDK channel CRUD                                           |
| `apps/runtime/src/routes/tenant-sdk-channels.ts`                    | Tenant-scoped admin CRUD wrapper                                                    |
| `apps/studio/src/app/api/admin/sdk-channels/route.ts`               | Studio admin proxy to tenant route                                                  |
| `apps/studio/src/app/api/runtime/sdk-channels/route.ts`             | Studio proxy to project-scoped list/create (`projectId` query param required)       |
| `apps/studio/src/app/api/runtime/sdk-channels/[channelId]/route.ts` | Studio proxy to tenant-forwarded detail/update/delete with concealed `404` behavior |

There is no current Studio proxy route for the removed legacy token path. The canonical Runtime compatibility endpoint returns `410 LEGACY_ROUTE_REMOVED`.

### UI Components

| File                                                                        | Purpose                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/studio/src/components/admin/ConnectorsPage.tsx`                       | Tenant-admin management surface for SDK channels |
| `apps/studio/src/components/deployments/ChannelsTab.tsx`                    | Project-level channel navigation                 |
| `apps/studio/src/components/deployments/channels/ChannelCatalog.tsx`        | Channel-type selection                           |
| `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx` | Edit/config view for one channel                 |
| `apps/studio/src/components/deployments/channels/CreateInstanceDialog.tsx`  | Create dialog for channel instances              |

### Jobs / Workers / Background Processes

This sub-feature does not rely on background workers. All current behavior is synchronous Runtime or Studio control-plane API handling backed by Mongo persistence and shared auth/RBAC helpers.

### Tests

| File                                                            | Type        | Coverage Focus                                                                                                                                     |
| --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts` | integration | Project-scoped SDK public-key + channel CRUD, origin allowlists, revocation, identity-policy lifecycle, tenant-admin CRUD, and concealed mutations |
| `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`         | integration | Project-scoped SDK channel RBAC plus explicit `410 LEGACY_ROUTE_REMOVED` assertions for the removed token route                                    |
| `apps/runtime/src/__tests__/channels-authz.test.ts`             | integration | Consolidated project-scoped `channel:*` permission behavior on the SDK channel router                                                              |
| `apps/runtime/src/__tests__/cross-project-isolation.test.ts`    | integration | API-key project-scope enforcement on `/api/projects/:projectId/sdk-channels`                                                                       |
| `apps/studio/src/__tests__/admin-sdk-channels-route.test.ts`    | route/unit  | Studio admin proxy tenant forwarding plus fail-closed Runtime URL behavior                                                                         |
| `apps/studio/src/__tests__/sdk-runtime-channel-proxy.test.ts`   | route/unit  | Studio tenant-forwarded detail/update/delete concealment and project-access recovery                                                               |
| `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts`   | integration | Outsider/non-member denial for the currently shipped Studio Runtime SDK channel proxy routes                                                       |

---

## 11. Configuration

### Environment Variables

| Variable                  | Default | Description                                                                                                                  |
| ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_URL`             | —       | Studio server-side Runtime proxy base. Required for Studio SDK channel proxy routes and other server-side Runtime exchanges. |
| `NEXT_PUBLIC_RUNTIME_URL` | —       | Browser-visible Runtime base used when Studio intentionally fronts Runtime for browser consumers.                            |

### Runtime Configuration

- `VALID_ENVIRONMENTS` is fixed to `dev`, `staging`, and `production`.
- Canonical SDK sessions use Runtime `sdk_session` TTL rules under `POST /api/v1/sdk/init` and `POST /api/v1/sdk/refresh`.
- The tenant route accepts either `enabled` or `isActive` from the admin UI and normalizes them to the stored `isActive` field.
- Identity policy authoring is nested under `identityVerification` and currently supports:
  - `identityVerification.hmacEnforcement`: `disabled | optional | required`
  - `identityVerification.secretKey`: non-empty string or `null`
- Top-level legacy identity fields (`hmacEnforcement`, `secretKey`) are intentionally rejected.

### DSL / Agent IR / Schema

SDK channels are not authored in ABL DSL. They are deployment/channel resources that downstream SDK bootstrap flows consume.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Project isolation | Project-scoped CRUD must include `projectId`, and cross-project get/update/delete must return `404`.             |
| Tenant isolation  | Tenant-admin CRUD must stay bounded to the supplied `tenantId`, and guessed IDs must not expose foreign records. |
| User isolation    | Admin and project UI flows should not leak raw API keys or foreign project metadata to unauthorized users.       |

### Security & Compliance

Project-scoped CRUD enforces project permission checks and cross-project isolation. Tenant-admin CRUD stays tenant-bounded and applies concealed project-permission checks before exposing mutations. Optional HMAC secret material is encrypted at rest, responses expose only `identityVerification.hasSecretKey` instead of returning the secret, and canonical SDK session issuance remains Runtime-scoped via `sdk/init`.

### Performance & Scalability

- Channel CRUD is lightweight Mongo-backed metadata management.
- SDK channels are small bounded collections per project, and the admin route reuses the canonical Runtime repo layer rather than a parallel control plane.
- Studio detail/update/delete proxy calls are stateless tenant-forwarding requests; Studio does not keep its own channel shadow state as a source of truth.

### Reliability & Failure Modes

- The tenant-admin route auto-creates a default public API key when required, reducing control-plane bootstrap failures from missing key material.
- Validation fails early on unsupported environments and channel types.
- Legacy top-level identity fields fail early with `INVALID_IDENTITY_VERIFICATION_FIELDS`, which prevents drift back to the removed shape.
- Studio server-side Runtime SDK channel proxy routes fail closed when the Runtime base URL is missing instead of silently targeting a fallback origin.
- The feature is dependent on deployment lookup and key management paths staying consistent with the broader Channels and SDK systems.

### Observability

The feature emits structured Runtime logs for create, update, delete, and validation failures. Broader tracing and widget execution remain covered by the Channels and Tracing features.

### Data Lifecycle

- SDK channel records and public API keys are persisted metadata resources.
- Identity-policy secrets are stored on the channel model and encrypted at rest.
- Deleting or deactivating SDK channels removes their control-plane availability without changing the separate browser SDK package itself.

---

## 13. Delivery Plan / Work Breakdown

1. Close the remaining proof gaps
   1.1 Add browser-driven Studio admin UI coverage for create/edit/delete flows.
   1.2 Add broader black-box proof for the HMAC identity-policy authoring lifecycle through Studio-owned flows if those surfaces remain product requirements.
2. Tighten data-model and API alignment
   2.1 Decide whether `rateLimitRpm` and `allowedOrigins` should be fully wired through the SDK channel create/update path or remain modeled through public API keys.
   2.2 Keep the removed legacy token route documented as intentionally unsupported and prevent proxy reintroduction.

---

## 14. Success Metrics

| Metric                       | Baseline                                                                                   | Target                                                                  | How Measured                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------- |
| SDK channel CRUD reliability | Current Runtime and Studio proxy flows are API-verified                                    | High success with low operator retries                                  | Runtime/admin API status codes and error rates |
| Bootstrap readiness          | Default public-key auto-create path exists                                                 | Operators can create a working SDK channel without hidden prerequisites | E2E/admin test coverage and issue rate         |
| Isolation correctness        | Project and tenant concealment are covered in API tests; browser admin proof is still open | No cross-scope leaks across project or tenant CRUD                      | Authz/integration/E2E coverage                 |

---

## 15. Open Questions

1. Should the tenant-admin route gain explicit live-tested cross-tenant guarantees before it is treated as fully hardened?
2. Should `rateLimitRpm` and `allowedOrigins` become first-class SDK channel API fields, or remain modeled through public API keys and related resources?
3. Do we want a dedicated Studio/browser authoring surface for channel-level HMAC identity policy, or is API-first configuration sufficient for the current phase?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                         | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Browser-driven Studio admin UI coverage for create/edit/delete flows is still missing                               | Medium   | Open   |
| GAP-002 | `rateLimitRpm` and `allowedOrigins` collected in some UI flows are not fully wired into the SDK channel create path | Low      | Open   |
| GAP-003 | Stable Studio/browser proof for HMAC identity-policy authoring is narrower than the Runtime API proof today         | Low      | Open   |

---

## 17. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] Runtime project-scoped and tenant-scoped CRUD, validation, identity-policy lifecycle, and concealment are covered through HTTP APIs.
- [x] Studio admin proxy list behavior and fail-closed Runtime URL handling are covered.
- [x] Shared SDK-channel RBAC, project membership checks, and API-key project scoping are covered.
- [x] Studio tenant-forwarded detail/update/delete concealment is covered.

#### E2E

- [x] Runtime control-plane APIs are exercised through a real HTTP harness.
- [x] Studio preview/share integration proves outsider/non-member denial across the currently shipped Runtime SDK channel proxy routes.
- [ ] Studio browser/admin UI flows are not yet covered.

### E2E Test Scenarios

| #   | Scenario                                                                        | Status     | Test File                                                       |
| --- | ------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| 1   | Project-scoped Runtime CRUD plus HMAC identity-policy lifecycle                 | PASS       | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts` |
| 2   | Tenant-scoped Runtime admin CRUD, default key creation, and concealed mutations | PASS       | `apps/runtime/src/__tests__/channels-control-plane.e2e.test.ts` |
| 3   | Studio admin proxy tenant forwarding and fail-closed Runtime URL handling       | PASS       | `apps/studio/src/__tests__/admin-sdk-channels-route.test.ts`    |
| 4   | Studio tenant-forwarded detail/update/delete concealment                        | PASS       | `apps/studio/src/__tests__/sdk-runtime-channel-proxy.test.ts`   |
| 5   | Browser/UI rendering and editing flow                                           | NOT TESTED | `docs/testing/sub-features/sdk-channel-creation.md`             |

### Integration Test Scenarios

| #   | Scenario                                                   | Status | Test File                                                     |
| --- | ---------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| 1   | Project-scoped SDK channel RBAC                            | PASS   | `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`       |
| 2   | Consolidated `channel:*` permission behavior on SDK routes | PASS   | `apps/runtime/src/__tests__/channels-authz.test.ts`           |
| 3   | API-key project scoping on SDK channel routes              | PASS   | `apps/runtime/src/__tests__/cross-project-isolation.test.ts`  |
| 4   | Studio proxy outsider/non-member denial on shipped routes  | PASS   | `apps/studio/src/__tests__/sdk-preview-share-api.e2e.test.ts` |

### Unit Test Coverage

| Package             | Tests                                                                   | Passing                      |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `apps/studio`       | `admin-sdk-channels-route.test.ts`, `sdk-runtime-channel-proxy.test.ts` | Proxy/route coverage passing |
| `packages/database` | Channel model encryption and related model tests                        | Model coverage passing       |

### Testing Notes

Current proof is strongest around Runtime API correctness, identity-policy authoring through HTTP APIs, concealed tenant/project boundaries, and Studio proxy fail-closed behavior. The remaining meaningful gap is browser/admin UI proof.

> Full testing details: [docs/testing/sub-features/sdk-channel-creation.md](../../testing/sub-features/sdk-channel-creation.md)

---

## 18. References

- Testing docs: [docs/testing/sub-features/sdk-channel-creation.md](../../testing/sub-features/sdk-channel-creation.md)
- Related features: [Channels](../channels.md), [SDK](../sdk.md), [Deployments & Versioning](../deployments-versioning.md)
- Runtime route: `apps/runtime/src/routes/sdk-channels.ts`
- Admin route: `apps/runtime/src/routes/tenant-sdk-channels.ts`
