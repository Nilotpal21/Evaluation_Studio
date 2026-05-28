# Test Specification: Voice Pipeline STT Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-pipeline-stt-provider-parity.md`
**HLD**: `docs/specs/voice-pipeline-stt-provider-parity.hld.md`
**LLD**: `docs/plans/2026-04-23-voice-pipeline-stt-provider-parity-impl-plan.md`
**Status**: PARTIAL (ALPHA)
**Last Updated**: 2026-05-05

---

## 1. Coverage Matrix

| FR    | Description                                                       | Unit | Integration | E2E | Manual | Status  |
| ----- | ----------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Shared registry includes expanded STT provider set                | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-2  | Admin Voice Services exposes provider-specific STT forms          | ✅   | ✅          | ❌  | ✅     | PARTIAL |
| FR-3  | Auth-profile-backed primary credentials work for eligible vendors | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-4  | Runtime CRUD accepts expanded STT provider set                    | ❌   | ✅          | ✅  | ❌     | PARTIAL |
| FR-5  | Runtime returns only non-sensitive config                         | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-6  | Partial config updates preserve omitted secrets                   | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-7  | Jambonz payload mapping covers expanded STT providers             | ✅   | ✅          | ❌  | ❌     | PASS    |
| FR-8  | Auth-profile-backed sync resolves primary credential before sync  | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-9  | Studio speech-provider filtering only returns active providers    | ✅   | ✅          | ❌  | ✅     | PASS    |
| FR-10 | Existing isolation and encrypted credential handling stay intact  | ❌   | ✅          | ✅  | ❌     | PARTIAL |
| FR-11 | `azure` remains excluded from runtime CRUD parity                 | ❌   | ✅          | ✅  | ❌     | PARTIAL |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through HTTP or full browser interaction. No mocks, no direct DB access, no stubbed internal servers.

### E2E-1: Tenant admin creates a direct-credential STT provider

- **Preconditions**: Studio and runtime running; authenticated tenant admin
- **Steps**:
  1. Open Admin → Voice Services
  2. Create a provider such as AWS, Microsoft, or Speechmatics using direct credentials
  3. Reload the page and reopen the saved provider
- **Expected Result**: The provider persists successfully and non-sensitive config fields reappear while secret fields stay redacted
- **Auth Context**: Tenant admin
- **Isolation Check**: Only tenant-scoped service instances are visible

### E2E-2: Tenant admin creates an auth-profile-backed STT provider

- **Preconditions**: Tenant has a reusable auth profile with an API key or bearer token
- **Steps**:
  1. Open Admin → Voice Services
  2. Create a supported STT provider using the auth-profile toggle
  3. Save and reload the instance
- **Expected Result**: The instance persists with `authProfileId` backing the primary credential instead of storing a new direct key
- **Auth Context**: Tenant admin
- **Isolation Check**: Only auth profiles from the same tenant are selectable

### E2E-3: Inactive STT providers do not appear in channel configuration

- **Preconditions**: Tenant has one active and one inactive STT service instance
- **Steps**:
  1. Open a voice channel configuration surface
  2. Load the STT provider selector
  3. Compare the visible providers against the configured instances
- **Expected Result**: Only active configured STT providers appear
- **Auth Context**: Project member with channel edit access
- **Isolation Check**: Cross-tenant providers never appear

### E2E-4: Runtime create/update preserves secret config for dual-secret providers

- **Preconditions**: Runtime running; authenticated tenant admin; provider that requires multiple credential fields such as AWS or Houndify
- **Steps**:
  1. POST a new provider with full config
  2. PATCH only a non-secret field
  3. Retrieve the instance and verify it still functions through speech-credential provisioning
- **Expected Result**: Omitted secret fields are preserved rather than cleared
- **Auth Context**: Tenant admin
- **Isolation Check**: Only the authenticated tenant can mutate the instance

### E2E-5: Invalid runtime provider type still fails closed

- **Preconditions**: Runtime running; authenticated tenant admin
- **Steps**:
  1. POST a service instance with `serviceType: "azure"`
  2. POST a valid provider type in the same session
- **Expected Result**: `azure` is rejected while supported STT providers are accepted
- **Auth Context**: Tenant admin
- **Isolation Check**: Validation failure reveals only the runtime allowlist

### E2E-6: Cross-tenant service-instance access still fails closed

- **Preconditions**: Two tenants with separate STT providers
- **Steps**:
  1. Authenticate as Tenant B
  2. Attempt to list or mutate Tenant A service instances
- **Expected Result**: Cross-tenant access remains blocked and non-leaky
- **Auth Context**: Tenant B admin
- **Isolation Check**: Required by scenario

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Shared registry helper outputs include the expanded STT set

- **Boundary**: `packages/config` registry constants → helper exports
- **Setup**: Import the registry helper functions directly
- **Steps**:
  1. Assert the expected pipeline STT service types are present
  2. Assert `azure` remains excluded from runtime CRUD
- **Expected Result**: Shared helper outputs match the intended ABL parity set
- **Failure Mode**: Studio/runtime drift or accidental `azure` promotion

### INT-2: Runtime speech-credential mapper normalizes representative vendors

- **Boundary**: `speech-credential-mapper.ts` → `SpeechCredentialInput`
- **Setup**: Provide representative stored credential snapshots
- **Steps**:
  1. Map AWS credentials with access key, secret, and region
  2. Map Microsoft custom endpoint config
  3. Map Cartesia/OpenAI default model behavior
- **Expected Result**: Runtime builds the expected provider-specific credential shapes
- **Failure Mode**: Jambonz provisioning receives malformed payloads

### INT-3: Jambonz provisioning uses vendor-specific payload fields

- **Boundary**: `jambonz-provisioning.service.ts` payload generation
- **Setup**: Exercise `createSpeechCredential()` with representative inputs
- **Steps**:
  1. Submit AWS, Microsoft, and Speechmatics provider inputs
  2. Inspect the serialized payload
- **Expected Result**: Vendor-specific fields are emitted correctly
- **Failure Mode**: Providers degrade to a generic API-key payload and fail at runtime

### INT-4: Studio speech-provider helper only returns active configured providers

- **Boundary**: `speech-providers.ts` → Studio service-instance proxy response
- **Setup**: Mock runtime proxy response with active and inactive instances
- **Steps**:
  1. Call `fetchConfiguredSpeechProviders()`
  2. Assert inactive providers are filtered out before STT/TTS partitioning
- **Expected Result**: Channel config only receives active instances
- **Failure Mode**: Inactive providers appear selectable

### INT-5: Runtime route allowlist excludes `azure` but includes new STT providers

- **Boundary**: `tenant-service-instances.ts` validation → runtime authz regression suite
- **Setup**: Exercise the route validation/auth layer through the existing route test harness
- **Steps**:
  1. Submit `serviceType: "azure"`
  2. Submit a new valid provider such as `microsoft`
- **Expected Result**: `azure` fails validation and the new STT provider passes
- **Failure Mode**: Runtime allowlist drifts from the shared registry

---

## 4. Unit Test Scenarios

### UT-1: Sensitive config keys are stripped from public config

- **Module**: `speech-credential-mapper.ts`
- **Input**: Provider config containing secret and non-secret fields
- **Expected Output**: Only non-sensitive fields remain

### UT-2: Default STT model behavior is deterministic

- **Module**: `speech-credential-mapper.ts`
- **Input**: Cartesia/OpenAI/Deepgram config without explicit model override
- **Expected Output**: Provider-specific defaults are applied

### UT-3: Registry helper lists remain internally consistent

- **Module**: `voice-providers.ts`
- **Input**: Shared registry metadata
- **Expected Output**: Runtime/admin/channel helper lists stay aligned

---

## 5. Security & Isolation Tests

- Cross-tenant service-instance access remains blocked for list/update/delete
- Runtime validation still rejects unsupported `serviceType` values
- Auth-profile-backed providers only resolve credentials from the authenticated tenant
- Public runtime responses never include sensitive config values such as `secretAccessKey`, `clientSecret`, or `clientKey`
- Clearing `authProfileId` without a replacement `apiKey` still fails with `400`

---

## 6. Performance & Load Tests (if applicable)

Not applicable. The story changes static metadata, CRUD wiring, and provisioning payload construction, not a hot-path runtime loop.

---

## 7. Test Infrastructure

- **Required services**: Runtime and Studio for manual/E2E checks; Vitest for unit/integration checks
- **Data seeding**: Prefer HTTP API seeding for runtime CRUD scenarios
- **Environment variables**: Existing Studio/runtime voice test env only
- **CI configuration**: Covered by package-scoped build and test commands where workspace resolution allows

---

## 8. Test File Mapping

| Test File                                                                                   | Type             | Covers             |
| ------------------------------------------------------------------------------------------- | ---------------- | ------------------ |
| `packages/config/src/__tests__/voice-providers.test.ts`                                     | unit             | FR-1, FR-11        |
| `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`                               | unit/integration | FR-5, FR-7         |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`                           | unit/integration | FR-7               |
| `apps/studio/src/__tests__/speech-providers.test.ts`                                        | unit/integration | FR-9               |
| `apps/studio/src/__tests__/voice-provider-registry.test.tsx`                                | unit/integration | FR-2               |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`                    | integration      | FR-4, FR-10, FR-11 |
| `apps/runtime/src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` | E2E              | FR-4, FR-10, FR-11 |

---

## 9. Open Testing Questions

1. Do we want broader runtime E2E coverage for dual-secret providers and auth-profile-backed sync?
2. Should every STT vendor get a provisioning payload assertion, or is representative-family coverage enough for this story?
3. Which providers need live credential smoke testing before we treat this story as production-ready instead of `ALPHA`?

## 10. Validation Notes (2026-05-05)

- Added UI coverage for Google STT service-account JSON plus model ID fields in `apps/studio/src/__tests__/voice-provider-registry.test.tsx`.
- Added runtime HTTP E2E coverage for Microsoft STT and Google STT service-instance creation, Google `modelId` persistence/update, unsupported `azure` rejection, and cross-tenant denial in `apps/runtime/src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts`.
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts src/__tests__/channels/voice-service-factory.test.ts` passed (`32/32` tests).
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/verb-builder-flux.test.ts` passed (`10/10` tests).
- Validation: `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/voice-provider-registry.test.tsx` passed (`1/1` test).
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` passed (`1/1` test).
- Full browser E2Es and live credential smokes remain open, so the feature status stays `PARTIAL (ALPHA)`.

---

## 10. Validation Notes (2026-04-23)

- `packages/config`: `pnpm --filter @agent-platform/config build` passed.
- `packages/config`: `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts` passed.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts` passed (`19` tests total).
- `apps/studio`: `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/voice-services.test.ts src/__tests__/s2s-provider-selector.test.tsx` passed; the STT story directly depends on `speech-providers.test.ts`, while the additional combined-branch suites remained green.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/auth/tenant-service-instances-authz.test.ts` remains blocked here by a pre-existing import error for `@agent-platform/shared/rbac`.
- `apps/studio` and `apps/runtime` package-wide builds remain partially blocked by unrelated workspace package-resolution failures in this worktree, so overall test status stays `PARTIAL (ALPHA)`.
