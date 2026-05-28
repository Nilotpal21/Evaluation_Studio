# Test Specification: Voice Pipeline TTS Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-pipeline-tts-provider-parity.md`
**HLD**: `docs/specs/voice-pipeline-tts-provider-parity.hld.md`
**LLD**: `docs/plans/2026-04-23-voice-pipeline-tts-provider-parity-impl-plan.md`
**Status**: PARTIAL (ALPHA)
**Last Updated**: 2026-05-05

---

## 1. Coverage Matrix

| FR   | Description                                                      | Unit | Integration | E2E | Manual | Status  |
| ---- | ---------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1 | Shared registry includes expanded TTS provider set               | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-2 | Admin Voice Services exposes provider-specific TTS forms         | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-3 | Runtime CRUD accepts the expanded TTS provider set               | ❌   | ❌          | ✅  | ✅     | PARTIAL |
| FR-4 | Runtime returns only non-sensitive TTS config                    | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-5 | Jambonz payload mapping covers representative TTS vendors        | ✅   | ✅          | ❌  | ❌     | PASS    |
| FR-6 | Studio filtering exposes the expanded TTS provider set           | ✅   | ✅          | ❌  | ❌     | PASS    |
| FR-7 | Preview capability stays limited to actually supported providers | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-8 | Existing isolation and encrypted credential handling stay intact | ❌   | ❌          | ✅  | ✅     | PARTIAL |
| FR-9 | `azure` remains outside runtime/admin TTS parity                 | ✅   | ❌          | ✅  | ❌     | PASS    |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through HTTP or full browser interaction. No mocks, no direct DB access, no stubbed internal servers.

### E2E-1: Tenant admin creates a direct-credential TTS provider

- **Preconditions**: Studio and runtime running; authenticated tenant admin
- **Steps**:
  1. Open Admin → Voice Services
  2. Create a TTS provider such as RimeLabs, PlayHT, or ElevenLabs with direct credentials
  3. Reload the page and reopen the saved provider
- **Expected Result**: The provider persists successfully and non-sensitive config fields reappear while secret fields stay redacted
- **Auth Context**: Tenant admin
- **Isolation Check**: Only tenant-scoped service instances are visible

### E2E-2: Tenant admin creates an auth-profile-backed TTS provider

- **Preconditions**: Tenant has a reusable auth profile with an API key or bearer token
- **Steps**:
  1. Open Admin → Voice Services
  2. Create a supported TTS provider using the auth-profile toggle
  3. Save and reload the instance
- **Expected Result**: The instance persists with `authProfileId` backing the primary credential
- **Auth Context**: Tenant admin
- **Isolation Check**: Only auth profiles from the same tenant are selectable

### E2E-3: Expanded TTS providers appear in channel configuration

- **Preconditions**: Tenant has one active configured TTS provider from the expanded set
- **Steps**:
  1. Open a voice channel configuration surface
  2. Load the TTS provider selector
  3. Compare the visible providers against the configured instances
- **Expected Result**: Active configured providers from the expanded TTS set appear consistently
- **Auth Context**: Project member with channel edit access
- **Isolation Check**: Cross-tenant providers never appear

### E2E-4: Preview-capable providers remain limited

- **Preconditions**: Tenant has multiple TTS providers configured
- **Steps**:
  1. Open a preview-capable voice configuration surface
  2. Compare preview availability across providers
- **Expected Result**: Only `elevenlabs` and `custom:orpheus` show preview support
- **Auth Context**: Tenant admin
- **Isolation Check**: Not applicable beyond normal tenant scoping

### E2E-5: Invalid TTS runtime provider type still fails closed

- **Preconditions**: Runtime running; authenticated tenant admin
- **Steps**:
  1. POST a service instance with `serviceType: "azure"`
  2. POST a valid runtime-managed TTS provider in the same session
- **Expected Result**: `azure` is rejected while supported runtime TTS providers are accepted
- **Auth Context**: Tenant admin
- **Isolation Check**: Validation failure reveals only the runtime allowlist

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Shared registry helper outputs include the expanded TTS set

- **Boundary**: `packages/config` registry constants → helper exports
- **Setup**: Import the registry helper functions directly
- **Steps**:
  1. Assert the expected pipeline TTS service types are present
  2. Assert preview-capable providers remain limited
  3. Assert `azure` stays out of runtime CRUD/admin parity
- **Expected Result**: Shared helper outputs match the intended ABL parity set
- **Failure Mode**: Studio/runtime drift or accidental `azure` promotion

### INT-2: Runtime speech-credential mapper normalizes representative TTS vendors

- **Boundary**: `speech-credential-mapper.ts` → `SpeechCredentialInput`
- **Setup**: Provide representative stored credential snapshots
- **Steps**:
  1. Map PlayHT credentials with `userId` and `voiceEngine`
  2. Map Verbio credentials with `clientSecret`
  3. Map Cartesia dual-role config with both STT and TTS model fields
- **Expected Result**: Runtime builds the expected provider-specific credential shapes
- **Failure Mode**: Jambonz provisioning receives malformed payloads

### INT-3: Jambonz provisioning uses vendor-specific TTS payload fields

- **Boundary**: `jambonz-provisioning.service.ts` payload generation
- **Setup**: Exercise `createSpeechCredential()` with representative inputs
- **Steps**:
  1. Submit Orpheus, AWS, and PlayHT provider inputs
  2. Inspect the serialized payload
- **Expected Result**: Vendor-specific fields are emitted correctly
- **Failure Mode**: Providers degrade to a generic payload and fail downstream

### INT-4: Studio speech-provider helper returns the expanded active TTS set

- **Boundary**: `speech-providers.ts` → Studio service-instance proxy response
- **Setup**: Mock runtime proxy response with mixed STT/TTS provider instances
- **Steps**:
  1. Call `fetchConfiguredSpeechProviders()`
  2. Assert the returned `tts` list includes the expanded TTS set and excludes unrelated providers
- **Expected Result**: Channel config receives the intended TTS provider set
- **Failure Mode**: Providers are missing or the filter regresses to the older narrow list

---

## 4. Unit Test Scenarios

### UT-1: Registry helper lists remain internally consistent

- **Module**: `voice-providers.ts`
- **Input**: Shared registry metadata
- **Expected Output**: Runtime/admin/channel/preview helper lists stay aligned

### UT-2: Sensitive config keys are stripped from public config

- **Module**: `speech-credential-mapper.ts`
- **Input**: Provider config containing secret and non-secret fields
- **Expected Output**: Only non-sensitive fields remain

### UT-3: Dual-role providers stay aligned for TTS

- **Module**: `voice-providers.ts`
- **Input**: Shared registry metadata
- **Expected Output**: No runtime-managed channel TTS provider exposes `useForTts: false`

---

## 5. Security & Isolation Tests

- Cross-tenant service-instance access remains blocked for list/update/delete
- Runtime validation still rejects unsupported TTS `serviceType` values
- Auth-profile-backed providers only resolve credentials from the authenticated tenant
- Public runtime responses never include sensitive config values such as `secretAccessKey`, `clientSecret`, or equivalent secret fields
- Preview support is not inferred from runtime CRUD alone

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

| Test File                                                                                   | Type             | Covers           |
| ------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| `packages/config/src/__tests__/voice-providers.test.ts`                                     | unit             | FR-1, FR-7, FR-9 |
| `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`                               | unit             | FR-4, FR-5       |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`                           | unit/integration | FR-5             |
| `apps/studio/src/__tests__/speech-providers.test.ts`                                        | unit/integration | FR-6             |
| `apps/runtime/src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` | E2E              | FR-3, FR-8, FR-9 |

---

## 9. Open Testing Questions

1. Do we want a dedicated runtime route integration suite for TTS CRUD acceptance once workspace import blockers are fixed?
2. Which TTS vendors need live credential smoke testing before this story can move beyond `ALPHA`?
3. Should preview-specific UI tests be added once the preview surfaces stabilize?

## 10. Validation Notes (2026-05-05)

- Added runtime HTTP E2E coverage that creates an existing ElevenLabs TTS service instance, verifies non-sensitive config persistence, rejects unsupported `azure`, and preserves cross-tenant denial behavior.
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts src/__tests__/channels/voice-service-factory.test.ts` passed (`32/32` tests).
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` passed (`1/1` test).
- Expanded TTS browser flows and live credential smokes remain open, so the feature status stays `PARTIAL (ALPHA)`.
