# Feature: Auth Profile Phase 2 Core Auth Types

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Auth Profiles](../auth-profiles.md)
**Status**: ALPHA
**Feature Area(s)**: `integrations`, `enterprise`, `governance`, `admin operations`
**Package(s)**: `packages/shared`, `packages/database`, `apps/runtime`, `packages/compiler`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [../../testing/sub-features/auth-profile-phase2-core-auth-types.md](../../testing/sub-features/auth-profile-phase2-core-auth-types.md)
**Last Updated**: 2026-04-24

---

## 1. Introduction / Overview

### Problem Statement

Auth Profiles Phase 2 was originally defined as a broad enterprise-auth expansion covering `basic`, `custom_header`, `aws_iam`, `azure_ad`, `mtls`, and `ssh_key`, along with addon activation and consumer migration. The current codebase already contains partial backend support for all of these Phase 2 types, but the end-to-end platform experience is uneven. In particular, the backend can validate and persist `basic`, `custom_header`, `aws_iam`, and `mtls`, while Studio still exposes only the older Phase 1-oriented auth-type selector and lacks field metadata for most of the Phase 2 types. Runtime support is also asymmetric: `mtls` is materially honored on the HTTP tool path, while `aws_iam` currently stops at credential shaping rather than proven end-to-end SigV4 request signing.

Without a scoped feature, operators can create or expect auth types whose actual runtime support is ambiguous. That creates a high risk of silent misconfiguration, especially for transport-bound or request-signing auth such as `mtls` and `aws_iam`.

### Goal Statement

Deliver a narrow, repository-grounded Auth Profiles Phase 2 slice for `basic`, `custom_header`, `aws_iam`, and `mtls` that defines the product boundary, supported runtime surfaces, Studio authoring requirements, and fail-closed behavior. The result should be a spec that is explicit about what is already present in backend code, what must be added to Studio, what runtime paths are truly supported, and what remains out of scope until later Phase 2 or Phase 3 follow-on work.

### Summary

This feature narrows Phase 2 to four auth types:

- `basic`
- `custom_header`
- `aws_iam`
- `mtls`

The slice intentionally focuses on the highest-value, lowest-ambiguity subset:

- `basic` and `custom_header` are application-layer auth types that map to resolved headers.
- `aws_iam` is treated as request-signing auth, scoped to supported HTTP tool execution once SigV4 is fully wired.
- `mtls` is treated as transport-layer client authentication, scoped to HTTPS consumers that explicitly consume TLS client options.

This feature does not claim broad Phase 2 completion. It is a compatibility-hardening and support-clarification effort for the core four types.

---

## 2. Scope

### Goals

- Define a scoped Phase 2 feature boundary around `basic`, `custom_header`, `aws_iam`, and `mtls`.
- Make Studio authoring explicit for these four auth types, including selectable type metadata and field definitions.
- Define the supported consumer matrix for these four types so operators know where each auth type is actually honored.
- Require fail-closed behavior for unsupported or partially wired consumers, especially for `aws_iam` and `mtls`.
- Preserve inherited Auth Profiles guarantees: tenant isolation, project isolation, user visibility, redaction, and encryption.

### Non-Goals (Out of Scope)

- `azure_ad`, `ssh_key`, and all Phase 3 auth types are deferred from this feature, even though some backend support already exists.
- This feature does not add generic `aws_iam` support to every auth-profile consumer or connector transport.
- This feature does not claim STS `AssumeRole` support for `aws_iam`; `roleArn` and `externalId` may remain schema-compatible but are not executed in this scope.
- This feature does not make `mtls` universally available to every `authProfileId` consumer; only consumers that propagate TLS options are in scope.
- This feature does not introduce new collections, feature flags, or a separate credential store.

---

## 3. User Stories

1. As a project admin, I want to create `basic` and `custom_header` auth profiles in Studio so that I can reuse non-OAuth credentials across supported HTTP consumers.
2. As an integration engineer, I want `aws_iam` to have a clearly defined supported runtime path so that AWS requests are either signed correctly or fail before being sent.
3. As an enterprise operator, I want `mtls` to be clearly modeled as transport auth so that I know it only works on consumers that honor TLS client-cert options.
4. As a platform maintainer, I want the Studio selector and backend support matrix to agree so that users are not promised auth types the UI cannot author or the runtime cannot honor.
5. As a security reviewer, I want unsupported combinations to fail closed with sanitized errors so that misconfiguration is visible without leaking secrets or internal details.

---

## 4. Functional Requirements

1. **FR-1**: The system must scope this feature to exactly four auth types: `basic`, `custom_header`, `aws_iam`, and `mtls`. The spec, testing guide, and UI support messaging for this feature must not imply completion of the rest of Phase 2.
2. **FR-2**: The system must allow backend create, update, list, and validate flows for these four auth types through the shared `CreateAuthProfileSchema` / type-specific config and secret schemas used by Studio and Runtime.
3. **FR-3**: Studio must expose all four auth types in the Auth Profiles create flow with auth-type metadata and field definitions that match the shared backend schemas.
4. **FR-4**: The system must apply `basic` auth profiles by emitting a correctly encoded `Authorization: Basic ...` header on supported HTTP execution paths.
5. **FR-5**: The system must apply `custom_header` auth profiles by materializing the configured headers on supported HTTP execution paths. If config header keys and secret header-value keys drift, validation must fail with a `400` response rather than silently dropping or inventing headers.
6. **FR-6**: The system must support `aws_iam` on a defined HTTP tool execution path by producing AWS Signature Version 4 request signing for supported requests. Signing must have access to the final method, URL, query string, body hash, timestamp, region, service, and AWS credentials.
7. **FR-7**: The system must not silently downgrade `aws_iam`. If the selected consumer path cannot build a canonical SigV4 request, lacks required signing inputs, or has no signing hook, validation, preflight, or execution must fail with a structured unsupported-configuration error.
8. **FR-8**: The system must support `mtls` only on HTTPS consumers that explicitly consume TLS client options. On the supported HTTP tool path, the runtime must materialize `clientCert`, `clientKey`, and optional `caCert` into transport-level TLS options before dispatch.
9. **FR-9**: The system must not silently downgrade `mtls`. If an `mtls` profile is attached to a consumer that does not propagate TLS options, or to a plain `http://` endpoint, validation, preflight, or execution must fail closed with a sanitized unsupported-configuration error.
10. **FR-10**: The system must preserve Auth Profiles isolation semantics for all four auth types. Project-scoped queries must include `projectId`, tenant-scoped queries must include `tenantId`, and user-owned personal profiles must remain filtered by `createdBy` / `ownerId`, with cross-scope access returning `404` where required by platform invariants.
11. **FR-11**: The system must keep secrets for these four auth types encrypted at rest, redacted from API responses, and excluded from user-visible runtime errors. Logs and traces may keep internal context but must not expose secret material.
12. **FR-12**: The system must document the supported-consumer matrix anywhere `authProfileId` attachment could be misread as equivalent to runtime support. Attaching a profile to a raw connection record alone must not be represented as proof that `aws_iam` signing or `mtls` transport auth will be honored.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                         |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Profiles are project- or workspace-scoped configuration assets attached to project consumers. |
| Agent lifecycle            | SECONDARY    | HTTP tool execution is the main runtime path for `aws_iam` and `mtls`.                        |
| Customer experience        | NONE         | This is an operator/platform feature, not a direct end-user feature.                          |
| Integrations / channels    | PRIMARY      | These auth types are used to reach external systems through tools and connections.            |
| Observability / tracing    | SECONDARY    | Unsupported combinations and runtime failures must be visible in logs/tests.                  |
| Governance / controls      | PRIMARY      | Scope isolation, visibility filtering, and fail-closed semantics are core.                    |
| Enterprise / compliance    | PRIMARY      | `aws_iam` and `mtls` are enterprise-facing auth mechanisms.                                   |
| Admin / operator workflows | PRIMARY      | Studio authoring and auth-profile selection are the main operator surfaces.                   |

### Related Feature Integration Matrix

| Related Feature                                           | Relationship Type | Why It Matters                                                                                                                  | Key Touchpoints                                                           | Current State           |
| --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| [Auth Profiles](../auth-profiles.md)                      | extends           | Parent feature owns the encrypted profile model, visibility rules, redaction, and lifecycle                                     | `auth_profiles`, shared validation, shared auth-profile services          | Active                  |
| [Tool Invocations](../tool-invocations.md)                | configured by     | HTTP tool execution is the main supported runtime consumer for `basic`, `custom_header`, `aws_iam`, and `mtls`                  | runtime auth resolution, middleware, HTTP executor                        | Partial today           |
| [Connectors](../connectors.md)                            | shares data with  | Raw connections and connector consumers can store `authProfileId`, but not every auth semantic is honored uniformly             | `ConnectorConnection`, connection resolver, consumer compatibility matrix | Partial today           |
| [Integration Auth Profiles](integration-auth-profiles.md) | adjacent to       | Studio auth-profile authoring surfaces are shared, so Phase 2 core types must align with integration-profile authoring patterns | Auth Profiles pages, slide-over form, picker                              | Active adjacent feature |

---

## 6. Design Considerations (Optional)

- Studio should present `mtls` as transport/client-certificate auth, not as OAuth or generic header auth.
- Studio should present `aws_iam` as request-signing auth, not as a static header template.
- `custom_header` should use explicit header-name/value editing rather than raw JSON when possible to reduce config/secret key drift.
- The supported-consumer matrix should be visible near selection or validation flows so operators can distinguish "attachable" from "honored at runtime."
- Workspace and project surfaces should continue to inherit the parent Auth Profiles visibility and sharing model instead of introducing per-type exceptions.

---

## 7. Technical Considerations (Optional)

- Shared validation already defines all four auth types in `packages/shared/src/validation/auth-profile.schema.ts` and `packages/shared/src/validation/auth-profile-phase2.schema.ts`.
- The Studio and Runtime create routes both use `CreateAuthProfileSchema`, so backend CRUD support already exists for these types in `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`, `apps/studio/src/app/api/auth-profiles/route.ts`, and `apps/runtime/src/routes/auth-profiles.ts`.
- Shared auth application already materializes:
  - `basic` -> `Authorization: Basic ...`
  - `custom_header` -> arbitrary header map
  - `aws_iam` -> typed `awsCredentials`
  - `mtls` -> typed `tlsOptions`
- The main implementation gaps are surface and honoring gaps rather than schema gaps:
  - Studio selector still uses `PHASE1_AUTH_TYPES`
  - `AUTH_TYPE_METADATA` lacks `basic`, `custom_header`, `aws_iam`, `mtls`, and `ssh_key` entries
  - `mtls` is materially honored on the HTTP tool path
  - `aws_iam` currently stops at credential shaping and lacks proven end-to-end SigV4 execution
- This feature is additive. No backfill or collection migration is required; rollout should be controlled by Studio exposure and runtime support completeness.

---

## 8. How to Consume

### Studio UI

Operators manage these auth profiles through the existing Auth Profiles surfaces:

- Project-level Auth Profiles page
- Workspace-level Auth Profiles page
- Auth Profile slide-over create/edit flow
- Auth Profile picker surfaces where `authProfileId` is selected

For this feature, Studio now:

- exposes the four scoped auth types in the create/edit flow via `AUTH_PROFILE_EDITOR_AUTH_TYPES`
- renders shared-schema-aligned config and secret fields for all four types
- uses the shared support matrix to keep authoring and picker messaging aligned
- surfaces attach-only warnings in raw-connection flows for `aws_iam` and `mtls`

### Surface Semantics Matrix

| Asset / Entity Type          | Source of Truth / Ownership | Design-Time Surface(s)                   | Editable or Read-Only? | Consumer Reference / Binding Model     | Runtime Materialization / Resolution                      | Notes / Unsupported State                                                        |
| ---------------------------- | --------------------------- | ---------------------------------------- | ---------------------- | -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `basic` auth profile         | `auth_profiles`             | Studio auth-profile pages and slide-over | Editable               | `authProfileId` on supported consumers | Header injection: `Authorization: Basic ...`              | Supported where resolved headers are honored                                     |
| `custom_header` auth profile | `auth_profiles`             | Studio auth-profile pages and slide-over | Editable               | `authProfileId` on supported consumers | Header injection from resolved header map                 | Requires config/secret key parity                                                |
| `aws_iam` auth profile       | `auth_profiles`             | Studio auth-profile pages and slide-over | Editable               | `authProfileId` on supported consumers | SigV4 signing on supported HTTP tool path                 | Unsupported for generic consumers without signing hook                           |
| `mtls` auth profile          | `auth_profiles`             | Studio auth-profile pages and slide-over | Editable               | `authProfileId` on supported consumers | TLS client cert options on supported HTTPS HTTP tool path | Unsupported for consumers without TLS propagation; not meaningful for plain HTTP |

### Design-Time vs Runtime Behavior

- At design time, these four auth types are ordinary auth profiles created via the shared CRUD surfaces.
- At runtime, each type has different honoring semantics:
  - `basic` and `custom_header` act at the request-header layer.
  - `aws_iam` acts at the request-signing layer and needs the final request shape.
  - `mtls` acts at the transport/TLS layer and needs a consumer that propagates client-cert options.
- A consumer that can store `authProfileId` but cannot apply the auth semantics is only partially integrated for that auth type.
- In the shipped slice, the supported honored runtime path for all four types is the HTTP tool execution path; raw connections remain binding surfaces only, with attach-only messaging for `aws_iam` and `mtls`.

### API (Runtime)

This feature relies on existing runtime auth-profile routes and HTTP tool execution plumbing.

| Method | Path                               | Purpose                                                        |
| ------ | ---------------------------------- | -------------------------------------------------------------- |
| POST   | `/api/auth-profiles`               | Create workspace/shared auth profiles in runtime-managed flows |
| GET    | `/api/auth-profiles/by-name/:name` | Resolve workspace/shared auth profiles by name                 |
| GET    | `/api/auth-profiles/:id`           | Fetch a single auth profile                                    |
| DELETE | `/api/auth-profiles/:id`           | Delete a profile after dependency checks                       |

### API (Studio)

This feature relies on the existing Studio auth-profile CRUD routes.

| Method | Path                                     | Purpose                                                    |
| ------ | ---------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/projects/:projectId/auth-profiles` | List project and inherited workspace profiles              |
| POST   | `/api/projects/:projectId/auth-profiles` | Create a project or tenant-scoped auth profile from Studio |
| GET    | `/api/auth-profiles`                     | List workspace-scoped auth profiles                        |
| POST   | `/api/auth-profiles`                     | Create a workspace-scoped auth profile                     |

### Admin Portal

N/A. This feature uses Studio’s workspace auth-profile management surfaces rather than a dedicated Admin portal workflow.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is not channel-specific. Consumers in these areas may reference auth profiles through `authProfileId`, but only runtime paths that actually honor the auth semantics should advertise support.

---

## 9. Data Model

### Collections / Tables

No new collections are introduced. This feature reuses `auth_profiles` and existing consumer-side `authProfileId` references.

```text
Collection: auth_profiles
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string | null (indexed)
  - createdBy: string (required)
  - visibility: 'shared' | 'personal'
  - scope: 'tenant' | 'project'
  - authType: 'basic' | 'custom_header' | 'aws_iam' | 'mtls'
  - config: auth-type-specific config (unencrypted)
  - encryptedSecrets: string (encrypted at rest)
  - encryptionKeyVersion: number
Indexes:
  - inherited from Auth Profiles model indexes on tenant/project/name/scope visibility
```

### Runtime-Only Contract Fields

| Contract / Field                | Purpose                                                                              | Persistence  |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| `HttpBindingIR.sigv4_auth`      | Carries transient AWS SigV4 signing context from runtime auth resolution to executor | Runtime only |
| `HttpBindingIR.tls_options`     | Carries client cert/key/CA material for supported HTTPS tool dispatch                | Runtime only |
| Shared support matrix decisions | Keep Studio and Runtime aligned on supported vs attach-only semantics                | Code only    |

### Key Relationships

- `auth_profiles` -> consumers via `authProfileId`
- `auth_profiles` -> `resolve-tool-auth.ts` -> `auth-profile-tool-middleware.ts` -> `http-tool-executor.ts`
- `mtls` -> runtime HTTP binding `tls_options` -> HTTPS dispatcher / transport agent
- `aws_iam` -> runtime auth resolution -> transient `sigv4_auth` -> final-request SigV4 signing hook

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/shared/src/validation/auth-profile.schema.ts`         | Main discriminated union and usage-mode validation for auth profiles                   |
| `packages/shared/src/validation/auth-profile-phase2.schema.ts`  | Config/secret schemas for Phase 2 auth types                                           |
| `packages/shared/src/validation/auth-profile-support-matrix.ts` | Shared support matrix used by Studio and Runtime                                       |
| `packages/shared/src/services/auth-profile/apply-auth.ts`       | Shared auth dispatcher for header auth, AWS credential shaping, and TLS option shaping |
| `packages/database/src/models/auth-profile.model.ts`            | Mongoose auth profile model enum and persistence                                       |

### Routes / Handlers

| File                                                                        | Purpose                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`              | Studio project-scoped create/list using shared schema                |
| `apps/studio/src/app/api/auth-profiles/route.ts`                            | Studio workspace-scoped create/list using shared schema              |
| `apps/runtime/src/routes/auth-profiles.ts`                                  | Runtime auth-profile CRUD validation and route allowlist             |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`               | Resolves auth profiles into header, TLS, and SigV4 tool-auth context |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | Fail-closed enforcement and HTTP binding patching                    |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Final HTTP execution, mTLS handling, and SigV4 application           |
| `packages/compiler/src/platform/constructs/executors/http-tool-sigv4.ts`    | Canonical SigV4 signing helper at the final request boundary         |

### UI Components

| File                                                                | Purpose                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`    | Studio auth-type metadata, editor-selectable list, and field definitions for the four shipped types |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` | Studio create/edit flow wired to the shared selectable list and dynamic field rendering             |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`    | Auth-profile selection with attach-only support messaging for raw connections                       |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx`  | Passes `raw_connection` context into the picker so attach-only warnings are visible                 |

### Jobs / Workers / Background Processes

| File                                                                        | Purpose                                                                |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`               | Resolves auth profiles for HTTP tool execution                         |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | Fail-closed enforcement before patching supported HTTP bindings        |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Final HTTP execution, plain-HTTP mTLS rejection, and SigV4 application |

### Tests

| File                                                                           | Type        | Coverage Focus                                                            |
| ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------- |
| `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts`            | unit        | Shared support-matrix decisions used by Studio and Runtime                |
| `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`         | unit        | Shared dispatcher behavior for Phase 2 auth types                         |
| `packages/shared/src/__tests__/auth-profile/phase2-schema.test.ts`             | unit        | Schema acceptance for the scoped Phase 2 payloads                         |
| `packages/shared/src/__tests__/auth-profile/phase2-service.test.ts`            | unit        | Validation and service-layer create/materialization behavior              |
| `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts` | integration | Runtime route validation including `custom_header` drift checks           |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`    | integration | Propagation of mTLS TLS options and fail-closed HTTP rejection            |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts` | integration | SigV4 context propagation and incomplete-config fail-closed behavior      |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`        | integration | HTTP executor honors TLS options and applies SigV4 at dispatch            |
| `apps/studio/src/__tests__/auth-type-metadata.test.ts`                         | unit        | Metadata exposure for the four scoped auth types                          |
| `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`        | integration | Create/edit flow renders the new field definitions                        |
| `apps/studio/src/__tests__/components/auth-profile-picker.test.tsx`            | integration | Raw-connection attach-only warnings                                       |
| `apps/studio/src/__tests__/components/create-connection-modal.test.tsx`        | integration | Picker wiring in raw-connection flows                                     |
| `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`               | e2e         | Real runtime execution of `basic`, `custom_header`, `aws_iam`, and `mtls` |
| `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts`                          | browser e2e | UI smoke coverage for create and picker flows (not rerun in this pass)    |

---

## 11. Configuration

### Environment Variables

| Variable                | Default | Description                                                   |
| ----------------------- | ------- | ------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY` | N/A     | Parent Auth Profiles encryption dependency for secret storage |

### Runtime Configuration

- No new feature flag is introduced for this scoped feature.
- Rollout should be controlled by Studio surface completeness and runtime support, not by hidden backend toggles.
- The current verification pass used affected-package builds before targeted tests; a full repo-wide `pnpm build` / `pnpm test` pass is still a follow-up item for broader closure.

### DSL / Agent IR / Schema

- No new DSL construct is introduced.
- Existing `authProfileId` references continue to be the consumer binding model.
- Shared schema branches for the four auth types already exist in the auth-profile validation layer.
- `HttpBindingIR` now carries transient runtime-only `sigv4_auth` for AWS signing support on the HTTP tool path.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Every project-scoped auth-profile read/write must include `projectId`, and cross-project access must return `404`. |
| Tenant isolation  | Every tenant-scoped auth-profile read/write must include `tenantId`, and cross-tenant access must return `404`.    |
| User isolation    | Personal profiles must be filtered by `createdBy` / `ownerId`, and cross-user access must return `404`.            |

### Security & Compliance

- Secrets remain encrypted at rest and redacted from API responses.
- `aws_iam` and `mtls` must fail closed when their runtime semantics cannot be honored.
- User-visible error surfaces must stay sanitized and must not leak secret material, tenant IDs, or internal remediation text.
- Existing audit and isolation behavior from the parent Auth Profiles feature remains in force.

### Performance & Scalability

- `basic` and `custom_header` add negligible overhead on supported HTTP paths.
- `aws_iam` adds request canonicalization and hashing overhead once SigV4 signing is wired; this is acceptable because it is bounded to supported execution paths.
- `mtls` may require custom transport agents/dispatchers; the supported HTTP executor path should reuse transport primitives rather than inventing new per-request frameworks.

### Reliability & Failure Modes

- Unsupported consumer combinations must fail deterministically before or during dispatch.
- `mtls` must never degrade to a certificate-less request on a path that claims mTLS support.
- `aws_iam` must never degrade to an unsigned request once a profile is selected on a supposedly supported path.

### Observability

- Current evidence comes primarily from unit and integration tests rather than dedicated observability surfaces.
- Runtime logs should continue to distinguish auth-type failures without exposing secrets.
- Future implementation should add explicit failure categories for unsupported `aws_iam` and `mtls` consumer combinations.

### Data Lifecycle

- No new retention or TTL behavior is introduced.
- This feature is additive and does not require migration of persisted records.
- Existing inline credentials may later be moved to auth profiles, but that migration is outside this feature’s scope.

---

## 13. Delivery Plan / Work Breakdown

1. Complete the scoped feature contract
   1.1 Finalize the support boundary for `basic`, `custom_header`, `aws_iam`, and `mtls`
   1.2 Document which Phase 2 types remain deferred
   1.3 Align feature/testing docs and index entries
2. Expose the four auth types in Studio
   2.1 Add `basic`, `custom_header`, `aws_iam`, and `mtls` metadata entries in `auth-type-metadata.ts`
   2.2 Replace the Phase 1-only selector list with the scoped Phase 2 core list
   2.3 Add form fields and help text that reflect the shared backend schemas
3. Harden backend/runtime support
   3.1 Preserve shared validation and CRUD behavior for all four types
   3.2 Keep `custom_header` key-parity validation fail-closed
   3.3 Add or verify supported-consumer guardrails for `mtls`
   3.4 Implement and validate an end-to-end SigV4 signing path for `aws_iam`
4. Validate support matrix and failure behavior
   4.1 Add integration coverage for Studio metadata exposure
   4.2 Add end-to-end coverage for `basic` and `custom_header`
   4.3 Add supported-path and fail-closed-path tests for `mtls`
   4.4 Add supported-path and fail-closed-path tests for `aws_iam`

---

## 14. Success Metrics

| Metric                                           | Baseline                                                                 | Target                                                                          | How Measured                           |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------- |
| Phase 2 core types visible in Studio create flow | `basic`, `custom_header`, `aws_iam`, and `mtls` are not selectable today | All four are selectable and render the correct fields                           | Studio integration/manual validation   |
| `mtls` runtime support clarity                   | Supported only implicitly through code/tests                             | Explicit supported-consumer matrix documented and tested                        | Feature doc + integration/E2E coverage |
| `aws_iam` end-to-end support                     | Credential shaping only, no proven SigV4 execution path                  | One supported HTTP tool path signs requests correctly                           | Integration/E2E test coverage          |
| Misconfiguration safety                          | Unsupported combinations are under-documented                            | Unsupported `aws_iam` and `mtls` combinations fail closed with sanitized errors | Runtime integration/E2E tests          |

---

## 15. Resolved Implementation Decisions

1. Studio hides `roleArn` and `externalId` in this slice; the shipped AWS IAM authoring surface exposes `region`, `service`, `accessKeyId`, `secretAccessKey`, and optional `sessionToken` only.
2. Generic raw-connection pickers keep `aws_iam` and `mtls` visible, but they now show shared attach-only warnings instead of implying runtime honoring.
3. The first supported `aws_iam` rollout is the HTTP tool execution path only; raw connection attachment is explicitly not treated as proof of signing support.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                     | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Studio selector exposure for the four scoped auth types is now wired through `AUTH_PROFILE_EDITOR_AUTH_TYPES` and shared support-matrix decisions.                              | High     | Mitigated |
| GAP-002 | Metadata and dynamic field rendering for `basic`, `custom_header`, `aws_iam`, and `mtls` are now present in Studio create/edit flows.                                           | High     | Mitigated |
| GAP-003 | `aws_iam` now has verified SigV4 signing coverage on the supported HTTP tool path, including fail-closed behavior for incomplete signing context.                               | High     | Mitigated |
| GAP-004 | Raw-connection flows now surface attach-only messaging for `aws_iam` and `mtls`; they no longer imply these types are broadly honored everywhere `authProfileId` is attachable. | Medium   | Mitigated |
| GAP-005 | The wider Phase 2 set (`azure_ad`, `ssh_key`) and the rest of deferred enterprise auth types remain outside this feature’s implementation boundary.                             | Low      | Accepted  |
| GAP-006 | This pass verified affected-package builds before targeted tests, but did not rerun a repo-wide `pnpm build` followed by full affected-package `pnpm test`.                     | Medium   | Open      |
| GAP-007 | Browser-level UI smoke coverage exists in `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts`, but that Playwright spec was not rerun in this pass.                           | Medium   | Open      |
| GAP-008 | The five structured review rounds / equivalent PR review required for BETA promotion are still pending.                                                                         | Medium   | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                          | Coverage Type      | Status  | Test File / Note                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create and execute `basic` auth on supported HTTP tool path                                       | e2e                | PASS    | `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`                                                                                                                                                          |
| 2   | Reject `custom_header` config/secret key drift                                                    | integration        | PASS    | `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts`                                                                                                                                            |
| 3   | Create and execute `custom_header` auth on supported HTTP tool path                               | e2e                | PASS    | `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`                                                                                                                                                          |
| 4   | Studio exposes the four types and attach-only raw-connection messaging                            | unit / integration | PASS    | `apps/studio/src/__tests__/auth-type-metadata.test.ts`, component tests                                                                                                                                                   |
| 5   | Resolve `mtls` and propagate TLS options into HTTP bindings                                       | integration        | PASS    | `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`, `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`                                                                      |
| 6   | Execute `mtls` against supported HTTPS path and fail closed on plain HTTP                         | e2e                | PASS    | `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`                                                                                                                                                          |
| 7   | Sign supported HTTP request with `aws_iam` and fail closed when signing inputs are incomplete     | integration / e2e  | PASS    | `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts`, `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`, `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts` |
| 8   | Cross-project / cross-tenant access returns `404` for scoped profiles and failures stay sanitized | integration / e2e  | PARTIAL | Inherited auth-profile API/route coverage plus sanitized failure assertions exist; a feature-specific public-API isolation regression is still pending                                                                    |

### Testing Notes

- Core happy paths are now verified end to end for `basic`, `custom_header`, `aws_iam`, and `mtls` through the real Studio -> runtime tool invocation path.
- Remaining maturity work is about promotion readiness rather than core implementation: repo-wide validation, browser-level UI smoke rerun, and the structured review pass are still open.
- The feature is now at `ALPHA`: implementation is complete in this worktree and core E2E paths pass, but broader closure work still blocks `BETA`.

> Full testing details: [../../testing/sub-features/auth-profile-phase2-core-auth-types.md](../../testing/sub-features/auth-profile-phase2-core-auth-types.md)

---

## 18. References

- Parent feature doc: [Auth Profiles](../auth-profiles.md)
- Related sub-feature: [Integration Auth Profiles](integration-auth-profiles.md)
- Design / plan references:
  - `docs/plans/2026-03-11-auth-profile-phase2-consolidation.md`
  - `docs/plans/2026-03-11-auth-profile-phase2-implementation-plan.md`
  - `docs/plans/2026-03-11-auth-profile-studio-ui-analysis.md`
  - `docs/specs/auth-profiles.hld.md`
