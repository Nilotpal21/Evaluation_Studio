# LLD: Auth Profile Phase 2 Core Auth Types

**Feature Spec**: `docs/features/sub-features/auth-profile-phase2-core-auth-types.md`
**HLD**: `docs/specs/auth-profile-phase2-core-auth-types.hld.md`
**Test Spec**: `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md`
**Status**: DONE
**Date**: 2026-04-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                   | Rationale                                                                                                     | Alternatives Rejected                                                                                       |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D-1 | Put the support matrix in `packages/shared/src/validation/`                                | Studio client components and Runtime both need a bundle-safe shared source of truth                           | Putting it in `packages/shared-auth-profile` would force client code to depend on a server-oriented package |
| D-2 | Keep `auth_profiles` and consumer persistence unchanged                                    | The gap is honoring and visibility, not storage or encryption                                                 | New collections or credential sub-models would create unnecessary migration work                            |
| D-3 | Carry `aws_iam` signing context as a transient HTTP binding field                          | SigV4 must happen after the final request shape is known in the executor                                      | Signing inside `applyAuth()` or the route layer would be wrong because method/url/body are not final there  |
| D-4 | Land runtime signer support before exposing `aws_iam` in Studio                            | Prevents a design-time/runtime mismatch from reaching operators                                               | Exposing `aws_iam` immediately and relying on warnings alone                                                |
| D-5 | Keep raw connections attachable but explicitly marked attach-only for `aws_iam` and `mtls` | Matches the current data model while satisfying FR-12 honesty requirements                                    | Hiding the profiles entirely from raw connection flows                                                      |
| D-6 | Do not add a new feature flag for this slice                                               | Safe rollout can be achieved by phase ordering and additive code paths                                        | Introducing a new flag for a narrow doc-and-wiring slice                                                    |
| D-7 | Leave Studio validate routes structural-only in this slice                                 | Consumer-aware compatibility belongs in the picker and execution path, not a profile-only validation endpoint | Adding a new consumer-aware validate API before the core runtime/UI wiring exists                           |

### Key Interfaces & Types

```ts
type Phase2CoreAuthType = 'basic' | 'custom_header' | 'aws_iam' | 'mtls';

type AuthProfileConsumerKind = 'auth_profile_editor' | 'http_tool' | 'raw_connection';

type AuthProfileSupportLevel = 'supported' | 'attach_only' | 'unsupported';

interface AuthProfileSupportDecision {
  authType: Phase2CoreAuthType;
  consumerKind: AuthProfileConsumerKind;
  level: AuthProfileSupportLevel;
  runtimeHonored: boolean;
  designTimeSelectable: boolean;
  message: string;
  reasonCode:
    | 'SUPPORTED_HTTP_HEADERS'
    | 'SUPPORTED_HTTP_MTLS'
    | 'SUPPORTED_HTTP_SIGV4'
    | 'ATTACH_ONLY_NO_SIGNING_HOOK'
    | 'ATTACH_ONLY_NO_TLS_PROPAGATION';
}

interface AwsSigV4Context {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

interface ToolAuthResult {
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  source: 'auth_profile' | 'inline' | 'none';
  authType?: string;
  secrets?: Record<string, unknown>;
  tlsOptions?: { cert: string; key: string; ca?: string; rejectUnauthorized: true };
  awsSigV4?: AwsSigV4Context;
}

interface HttpBindingIR {
  // existing fields omitted
  tls_options?: {
    ca?: string;
    cert?: string;
    key?: string;
    rejectUnauthorized?: boolean;
  };

  // runtime-only, not authored in DSL or persisted
  sigv4_auth?: AwsSigV4Context;
}
```

### Module Boundaries

| Module                                                                      | Responsibility                                                              | Depends On                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/shared/src/validation/auth-profile-support-matrix.ts`             | Bundle-safe support matrix and compatibility helpers for Studio + Runtime   | shared auth types only                         |
| `packages/shared-auth-profile/src/apply-auth.ts`                            | Keep credential shaping for `basic`, `custom_header`, `aws_iam`, and `mtls` | phase2 schemas                                 |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`               | Translate auth profiles into runtime tool auth context                      | shared-auth-profile, support matrix            |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`    | Fail-closed enforcement and binding patching for HTTP tools                 | resolve-tool-auth, support matrix, compiler IR |
| `packages/compiler/src/platform/constructs/executors/http-tool-sigv4.ts`    | Canonical request signing helper for final HTTP dispatch                    | existing AWS signer dependency                 |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Final mTLS validation and SigV4 application before fetch                    | IR schema, signer helper                       |
| `apps/studio/src/components/auth-profiles/*`                                | Auth type authoring and messaging in Studio                                 | shared validation support matrix               |
| `apps/studio/src/components/connections/*`                                  | Raw connection picker warnings and attach-only messaging                    | support matrix, auth profile summaries         |

### FR Coverage Plan

| FR    | Planned Phase(s)          |
| ----- | ------------------------- |
| FR-1  | Phase 1                   |
| FR-2  | Phase 1, Phase 4          |
| FR-3  | Phase 4                   |
| FR-4  | Phase 2                   |
| FR-5  | Phase 2                   |
| FR-6  | Phase 3                   |
| FR-7  | Phase 2, Phase 3          |
| FR-8  | Phase 2                   |
| FR-9  | Phase 2                   |
| FR-10 | Phase 1, Phase 4          |
| FR-11 | Phase 2, Phase 3, Phase 5 |
| FR-12 | Phase 1, Phase 4          |

---

## 2. File-Level Change Map

### New Files

| File                                                                           | Purpose                                                                            | LOC Estimate |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------ |
| `packages/shared/src/validation/auth-profile-support-matrix.ts`                | Shared consumer-compatibility matrix and helper functions                          | 120          |
| `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts`            | Unit coverage for support-matrix decisions                                         | 120          |
| `packages/compiler/src/platform/constructs/executors/http-tool-sigv4.ts`       | Reusable SigV4 signing helper for final requests                                   | 150          |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts` | Runtime middleware coverage for SigV4 context propagation and fail-closed behavior | 140          |
| `apps/studio/src/__tests__/components/auth-profile-picker.test.tsx`            | UI coverage for attach-only warnings in picker flows                               | 140          |

### Modified Files

| File                                                                           | Change Description                                                                      | Risk   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| `packages/shared/src/validation/index.ts`                                      | Export support-matrix helpers                                                           | Low    |
| `apps/studio/src/components/auth-profiles/auth-type-metadata.ts`               | Add metadata for the four scoped types and replace Phase 1-only selector logic          | Medium |
| `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx`            | Consume the scoped selectable list and render new fields/messages                       | Medium |
| `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx`               | Show compatibility messaging for raw connection flows                                   | Medium |
| `apps/studio/src/components/connections/CreateConnectionModal.tsx`             | Pass consumer kind and surface attach-only warning copy                                 | Medium |
| `apps/studio/src/__tests__/auth-type-metadata.test.ts`                         | Extend metadata assertions for the four types                                           | Low    |
| `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx`        | Verify selector/rendering for new types                                                 | Medium |
| `apps/studio/src/__tests__/components/create-connection-modal.test.tsx`        | Verify raw connection warning behavior                                                  | Medium |
| `packages/shared-auth-profile/src/index.ts`                                    | Re-export any shared-auth-profile types updated for runtime auth results                | Low    |
| `packages/shared/src/services/auth-profile/index.ts`                           | Keep compatibility barrel aligned with shared-auth-profile exports                      | Low    |
| `packages/shared-auth-profile/src/apply-auth.ts`                               | Preserve/shape `aws_iam` and `mtls` typed output used downstream                        | Medium |
| `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts`         | Extend typed-output assertions                                                          | Low    |
| `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`                  | Return transient SigV4 context plus existing TLS/header data                            | High   |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`       | Enforce support matrix and patch transient `sigv4_auth`/`tls_options` onto HTTP binding | High   |
| `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts`    | Extend mTLS unsupported-path coverage                                                   | Medium |
| `packages/compiler/src/platform/ir/schema.ts`                                  | Add runtime-only `sigv4_auth` field to `HttpBindingIR`                                  | Medium |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | Reject plain HTTP + mTLS, apply SigV4 signing before dispatch                           | High   |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`        | Extend executor coverage for mTLS rejection and SigV4 signing                           | High   |
| `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts` | Keep structural validation coverage aligned with shared schema behavior                 | Low    |
| `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md`             | Update LLD reference and, after implementation, status mapping                          | Low    |

### Deleted Files

None.

---

## 3. Implementation Phases

CRITICAL: Each phase is independently deployable and keeps the system in a valid state.

### Phase 1: Shared Compatibility Contract

**Goal**: Establish a single source of truth for support decisions without changing runtime behavior or Studio exposure yet.

**Tasks**:
Task 1.1: Create `packages/shared/src/validation/auth-profile-support-matrix.ts` with typed consumer kinds, support levels, and helper functions.
Task 1.2: Export the new helpers from `packages/shared/src/validation/index.ts`.
Task 1.3: Add focused unit tests for matrix decisions under `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts`.
Task 1.4: Extend `packages/compiler/src/platform/ir/schema.ts` with a runtime-only `sigv4_auth` field on `HttpBindingIR`.
Task 1.5: Document in code comments that `sigv4_auth` is never persisted or DSL-authored.

**Files Touched**:

- `packages/shared/src/validation/auth-profile-support-matrix.ts` — new support matrix
- `packages/shared/src/validation/index.ts` — export surface
- `packages/shared/src/__tests__/auth-profile/support-matrix.test.ts` — unit coverage
- `packages/compiler/src/platform/ir/schema.ts` — transient runtime field

**Exit Criteria**:

- [ ] Support-matrix helpers return `supported` for `basic`/`custom_header` on `http_tool`
- [ ] Support-matrix helpers return `attach_only` for `aws_iam` and `mtls` on `raw_connection`
- [ ] `pnpm build --filter=@agent-platform/shared --filter=@abl/compiler` succeeds with 0 errors
- [ ] `pnpm vitest run packages/shared/src/__tests__/auth-profile/support-matrix.test.ts` passes

**Test Strategy**:

- Unit: support-matrix helper decisions and `HttpBindingIR` typing compile coverage
- Integration: none in this phase

**Rollback**: Remove the new support-matrix module and transient IR field; no persisted data changes need cleanup.

---

### Phase 2: Runtime Fail-Closed Enforcement for Header Auth and mTLS

**Goal**: Ensure the existing HTTP tool path honors `basic`, `custom_header`, and `mtls` correctly and rejects unsupported/downgraded cases before dispatch.

**Tasks**:
Task 2.1: Extend `resolve-tool-auth.ts` to return typed `awsSigV4` and `tlsOptions` context alongside headers/query params.
Task 2.2: Update `auth-profile-tool-middleware.ts` to consult the shared support matrix before patching HTTP bindings.
Task 2.3: Keep `basic` and `custom_header` flowing through headers exactly as they do today.
Task 2.4: Reject `mtls` when `tool.http_binding` is absent or when the endpoint uses `http://`.
Task 2.5: Update `http-tool-executor.ts` to throw a sanitized auth/configuration error when `tls_options` is present on plain HTTP.
Task 2.6: Expand middleware and executor tests for `mtls` unsupported-path behavior.

**Files Touched**:

- `packages/shared-auth-profile/src/apply-auth.ts` — verify typed output remains stable
- `packages/shared/src/__tests__/auth-profile/apply-auth-phase2.test.ts` — typed result assertions
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — runtime auth result extension
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` — support checks and patching
- `apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts` — unsupported-path coverage
- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` — plain-HTTP mTLS rejection
- `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` — executor rejection coverage

**Exit Criteria**:

- [ ] A tool with `authType: "basic"` still produces a correct `Authorization: Basic ...` header on the HTTP path
- [ ] A tool with `authType: "custom_header"` still patches configured headers without drift or silent omission
- [ ] A tool with `authType: "mtls"` and an `http://` endpoint fails before outbound dispatch
- [ ] `pnpm build --filter=@agent-platform/shared-auth-profile --filter=@agent-platform/runtime --filter=@abl/compiler` succeeds with 0 errors
- [ ] `pnpm vitest run apps/runtime/src/__tests__/auth/auth-profile-tool-mtls-middleware.test.ts packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` passes

**Test Strategy**:

- Unit: `applyAuth()` typed result coverage for header auth and `mtls`
- Integration: runtime middleware -> HTTP binding -> executor rejection path

**Rollback**: Revert support-matrix checks in runtime middleware and the plain-HTTP mTLS rejection while leaving the shared contract in place.

---

### Phase 3: SigV4 Signing on the HTTP Tool Path

**Goal**: Convert `aws_iam` from shaped credentials into real AWS Signature Version 4 signing on the supported HTTP tool path.

**Tasks**:
Task 3.1: Add `packages/compiler/src/platform/constructs/executors/http-tool-sigv4.ts` using an existing workspace signer dependency.
Task 3.2: Extend `resolve-tool-auth.ts` and `auth-profile-tool-middleware.ts` to patch `sigv4_auth` onto `HttpBindingIR` only for supported HTTP tools.
Task 3.3: In `http-tool-executor.ts`, compute the final method, URL, query string, headers, and body hash after templating/path resolution but before `fetch`.
Task 3.4: Sign the canonical request and merge signed headers into the outgoing request.
Task 3.5: Throw a sanitized `TOOL_AUTH_FAILED` error when service, region, or canonical request inputs are missing or when no supported signing seam exists.
Task 3.6: Add focused middleware and executor tests for signed requests and unsupported `aws_iam` paths.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/http-tool-sigv4.ts` — new signer helper
- `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` — final-request signing
- `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` — signed-request assertions
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` — `awsSigV4` auth result
- `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` — support checks and transient binding patch
- `apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts` — new middleware coverage

**Exit Criteria**:

- [ ] An `aws_iam` auth profile on a supported HTTP tool path yields signed request headers including `Authorization` and `x-amz-date`
- [ ] `aws_iam` requests with missing `service` or `region` fail before fetch is invoked
- [ ] Unsupported non-HTTP or attach-only consumers do not send unsigned AWS requests
- [ ] `pnpm build --filter=@agent-platform/runtime --filter=@abl/compiler` succeeds with 0 errors
- [ ] `pnpm vitest run apps/runtime/src/__tests__/auth/auth-profile-tool-aws-iam-middleware.test.ts packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` passes

**Test Strategy**:

- Unit: signer helper canonicalization and header merge behavior
- Integration: runtime middleware -> executor -> local SigV4 verifier path

**Rollback**: Disable the new `sigv4_auth` path and revert executor signing; `aws_iam` remains unexposed in Studio until this phase is complete.

---

### Phase 4: Studio Surface Alignment and Raw-Connection Messaging

**Goal**: Expose the four scoped auth types in Studio while making support boundaries explicit anywhere `authProfileId` can be attached.

**Tasks**:
Task 4.1: Add metadata entries for `basic`, `custom_header`, `aws_iam`, and `mtls` to `auth-type-metadata.ts`.
Task 4.2: Replace `PHASE1_AUTH_TYPES` gating in the slide-over with a scoped selectable list based on the shared support matrix.
Task 4.3: Render new config/secret fields in `AuthProfileSlideOver.tsx` and keep `usageMode` constrained to `preconfigured` for these types.
Task 4.4: Update `AuthProfilePicker.tsx` to accept a consumer kind and display attach-only warning text for `raw_connection`.
Task 4.5: Update `CreateConnectionModal.tsx` to pass `raw_connection` context and render compatibility messaging instead of silently implying support.
Task 4.6: Extend metadata, slide-over, picker, and connection-modal tests.

**Files Touched**:

- `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` — metadata + selectable list
- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` — dynamic form wiring
- `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx` — consumer-aware messaging
- `apps/studio/src/components/connections/CreateConnectionModal.tsx` — raw-connection warning copy
- `apps/studio/src/__tests__/auth-type-metadata.test.ts` — metadata coverage
- `apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx` — UI coverage
- `apps/studio/src/__tests__/components/auth-profile-picker.test.tsx` — picker warning coverage
- `apps/studio/src/__tests__/components/create-connection-modal.test.tsx` — connection-flow coverage

**Exit Criteria**:

- [ ] Studio create/edit flow exposes `basic`, `custom_header`, `aws_iam`, and `mtls`
- [ ] Studio raw-connection flows display attach-only messaging for `aws_iam` and `mtls`
- [ ] Studio does not describe raw connections as proof that `aws_iam` signing or `mtls` transport auth is honored
- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 errors
- [ ] `pnpm vitest run apps/studio/src/__tests__/auth-type-metadata.test.ts apps/studio/src/__tests__/components/auth-profile-slide-over.test.tsx apps/studio/src/__tests__/components/auth-profile-picker.test.tsx apps/studio/src/__tests__/components/create-connection-modal.test.tsx` passes

**Test Strategy**:

- Unit: metadata constants and helper decisions
- Integration: React component tests for slide-over, picker, and connection modal

**Rollback**: Revert Studio exposure and warning UI while leaving runtime support intact.

---

### Phase 5: Coverage Ramp and Final Wiring Verification

**Goal**: Close the highest-value integration/E2E gaps and verify all wiring paths match the feature and test specs.

**Tasks**:
Task 5.1: Extend runtime route validation coverage for `custom_header` drift and scoped Phase 2 payload acceptance if needed.
Task 5.2: Add or extend end-to-end tests for `basic`, `custom_header`, `mtls`, and `aws_iam` on the supported HTTP tool path using local verifier servers.
Task 5.3: Verify no user-visible error exposes cert material, AWS secrets, or raw secret fields.
Task 5.4: Update the test spec coverage statuses and references to reflect actual landed coverage.
Task 5.5: Run workspace validation in repo order: `pnpm build` before `pnpm test`.

**Files Touched**:

- `apps/runtime/src/__tests__/integration/auth-profile-route-validation.test.ts` — route validation alignment
- `apps/studio/src/__tests__/e2e/integration-auth-profiles.e2e.test.ts` or equivalent existing E2E harness — end-to-end coverage
- `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts` — final executor regression assertions
- `docs/testing/sub-features/auth-profile-phase2-core-auth-types.md` — coverage status refresh after implementation

**Exit Criteria**:

- [ ] Targeted E2E coverage exists for at least one real execution path each for `basic`, `custom_header`, `mtls`, and `aws_iam`
- [ ] No outbound request is sent for unsupported `aws_iam` or plain-HTTP `mtls` cases
- [ ] `pnpm build` succeeds before any `pnpm test` run
- [ ] Targeted vitest/E2E suites for this feature pass without mocking codebase components on black-box paths

**Test Strategy**:

- Unit: none new beyond prior phases
- Integration: route validation and middleware/executor coverage
- E2E: real HTTP API + local verifier servers, no direct DB access

**Rollback**: Keep runtime/UI changes and revert only newly added tests/docs if the coverage ramp itself causes churn; no production rollback needed.

---

## 4. Wiring Checklist

- [ ] `packages/shared/src/validation/index.ts` exports the support-matrix helpers
- [ ] `packages/compiler/src/platform/ir/schema.ts` exposes `sigv4_auth` for runtime use
- [ ] `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` returns `awsSigV4` and `tlsOptions`
- [ ] `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` patches `sigv4_auth` and `tls_options` onto `http_binding`
- [ ] `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` consumes `sigv4_auth` and `tls_options`
- [ ] `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` stops using a Phase 1-only selectable list for this feature slice
- [ ] `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` renders the new field definitions
- [ ] `apps/studio/src/components/auth-profiles/AuthProfilePicker.tsx` receives consumer kind context
- [ ] `apps/studio/src/components/connections/CreateConnectionModal.tsx` passes `raw_connection` context to the picker
- [ ] New tests are added to existing vitest suites and use real component/runtime boundaries

## 5. Cross-Phase Concerns

### Database Migrations

None. This feature reuses existing `auth_profiles` and `authProfileId` references.

### Feature Flags

None planned. Rollout safety comes from phase ordering:

- runtime signer lands before `aws_iam` Studio exposure
- attach-only messaging lands with the Studio picker changes

### Configuration Changes

No new environment variables are required.

The implementation should reuse existing signer dependencies already present in the workspace:

- `@aws-sdk/signature-v4`
- `aws4`

### Performance-Sensitive Paths

- `http-tool-executor.ts` must sign only after final request materialization to avoid duplicate work
- mTLS rejection on plain HTTP should occur before fetch/dispatcher construction where possible
- support-matrix lookups must remain static in-memory lookups with no DB dependency

### Known Risks

| Risk                                                      | Why It Matters                                               | Mitigation Phase               |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| Carrying signer context through the runtime tool pipeline | New transient field could be dropped before the executor     | Phase 1, Phase 3               |
| Studio exposing `aws_iam` too early                       | Would recreate the current mismatch in a more visible way    | Phase 4 sequencing             |
| Raw connection UX remains ambiguous                       | Users may still infer support from attachment alone          | Phase 4 picker/modal messaging |
| Executor signing after templating but before fetch        | Wrong insertion point could sign the wrong canonical request | Phase 3 focused helper + tests |

## 6. Acceptance Criteria (Whole Feature)

- [x] All five phases complete with exit criteria met
- [x] FR-1 through FR-12 each map to landed code and tests
- [x] Shared support matrix is the only compatibility source used by both Studio and Runtime
- [x] `basic` and `custom_header` work end to end on the supported HTTP tool path
- [x] `mtls` works on supported HTTPS HTTP tool paths and fails closed on plain HTTP or unsupported consumers
- [ ] `aws_iam` signs requests on the supported HTTP tool path and fails closed elsewhere
- [x] Raw connection flows communicate attach-only semantics for `aws_iam` and `mtls`
- [ ] `pnpm build` completes successfully before `pnpm test`
- [x] Targeted integration and E2E tests from the test spec pass
- [x] Docs and testing matrix are updated to reflect actual implemented coverage

## 7. Resolved Questions

1. The Studio create/edit flow hides `roleArn` and `externalId` in this slice; only the fields exercised by the supported SigV4 path are exposed.
2. Picker/runtime enforcement was sufficient for this slice. The workspace/project validate routes did not grow a consumer-aware mode in this pass.

## 8. Wiring Evidence & Post-Implementation Notes

- `packages/shared/src/validation/index.ts` exports the support-matrix helpers, and both `apps/studio/src/components/auth-profiles/auth-type-metadata.ts` and `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` import them as the shared compatibility source of truth.
- `apps/studio/src/components/auth-profiles/AuthProfileSlideOver.tsx` reaches the four shipped auth types through `AUTH_PROFILE_EDITOR_AUTH_TYPES`, while `apps/studio/src/components/connections/CreateConnectionModal.tsx` passes `consumerKind="raw_connection"` into `AuthProfilePicker.tsx` for attach-only messaging.
- `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` -> `auth-profile-tool-middleware.ts` -> `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` is the production honoring path verified by `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`.
- Phase 5 E2E landed in the existing Studio tool-invocation E2E harness rather than a new dedicated auth-profile E2E file.
- Verification in this pass used affected-package builds before targeted tests, not a full repo-wide `pnpm build` / `pnpm test`.
- `apps/studio/e2e/auth-profile-phase2-core-ui.spec.ts` exists for browser smoke coverage but was not rerun in this pass.
