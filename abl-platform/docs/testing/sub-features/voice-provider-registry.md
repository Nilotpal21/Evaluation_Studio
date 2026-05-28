# Test Specification: Voice Provider Registry and Capability Matrix

**Feature Spec**: `docs/features/sub-features/voice-provider-registry.md`
**HLD**: `docs/specs/voice-provider-registry.hld.md`
**LLD**: `docs/plans/2026-04-22-voice-provider-registry-impl-plan.md`
**Status**: PARTIAL (ALPHA)
**Last Updated**: 2026-05-05

---

## 1. Coverage Matrix

| FR   | Description                                            | Unit | Integration | E2E | Manual | Status  |
| ---- | ------------------------------------------------------ | ---- | ----------- | --- | ------ | ------- |
| FR-1 | Canonical provider registry exists                     | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-2 | Typed helper lists exposed from registry               | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-3 | Studio S2S labels derive from registry                 | ✅   | ✅          | ❌  | ✅     | PASS    |
| FR-4 | Studio STT/TTS filtering derives from registry         | ✅   | ✅          | ❌  | ✅     | PASS    |
| FR-5 | Runtime CRUD allowlist derives from registry           | ✅   | ✅          | ✅  | ❌     | PASS    |
| FR-6 | Runtime speech-role helpers derive from registry       | ✅   | ✅          | ❌  | ❌     | PARTIAL |
| FR-7 | Capability matrix models admin/channel/realtime status | ✅   | ❌          | ❌  | ✅     | PASS    |
| FR-8 | Partial-support messaging appears for S2S gaps         | ✅   | ✅          | ❌  | ✅     | PASS    |
| FR-9 | Existing isolation behavior preserved                  | ❌   | ✅          | ✅  | ❌     | PARTIAL |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through HTTP or full browser interaction. No mocks, no direct DB access, no stubbed internal servers.

### E2E-1: Admin Voice Services renders registry-backed provider cards

- **Preconditions**: Studio and runtime running; authenticated tenant admin; no voice service instances configured
- **Steps**:
  1. Open Studio Admin → Voice Services
  2. Assert the page renders the registry-backed provider cards for Deepgram, ElevenLabs, Orpheus, and the current S2S providers
  3. Confirm providers not meant for admin configuration do not appear as cards
- **Expected Result**: Card inventory matches the registry, not stale local arrays
- **Auth Context**: Tenant admin
- **Isolation Check**: Only tenant-scoped data loads for the logged-in admin

### E2E-2: Configured speech providers are filtered consistently in channel config

- **Preconditions**: Tenant has active service instances for a registry-supported STT provider and TTS provider
- **Steps**:
  1. Open a voice channel configuration surface
  2. Load STT and TTS provider selectors
  3. Verify only providers enabled by the registry for each selector appear
- **Expected Result**: STT/TTS dropdowns reflect the canonical registry-backed capabilities
- **Auth Context**: Project member with channel edit access
- **Isolation Check**: Cross-tenant service instances never appear

### E2E-3: Partial S2S provider shows a runtime-support warning

- **Preconditions**: Tenant has an active service instance for an S2S provider marked partial in the registry
- **Steps**:
  1. Open voice realtime / S2S channel configuration
  2. Select the partial provider
  3. Verify a partial-support warning is shown
- **Expected Result**: Studio does not imply full telephony parity for that provider
- **Auth Context**: Project member with channel edit access
- **Isolation Check**: Warning is based on provider metadata, not cross-tenant data

### E2E-4: Runtime tenant-service-instance CRUD accepts registry-backed provider types

- **Preconditions**: Runtime running; authenticated tenant admin
- **Steps**:
  1. POST a valid registry-backed provider type to `/api/tenants/:tenantId/service-instances`
  2. PATCH and DELETE the resulting instance
  3. Repeat with another registry-backed type from a different capability class
- **Expected Result**: Runtime CRUD accepts the canonical runtime provider set
- **Auth Context**: Tenant admin
- **Isolation Check**: Cross-tenant CRUD returns non-success and remains non-leaky

### E2E-5: Cross-tenant service-instance access still fails closed

- **Preconditions**: Two tenants, each with separate voice service instances
- **Steps**:
  1. Authenticate as Tenant B
  2. Attempt to list or mutate Tenant A service instances
  3. Attempt to load channel/provider surfaces that would indirectly expose Tenant A data
- **Expected Result**: Cross-tenant access returns the existing deny behavior and no provider data leaks
- **Auth Context**: Tenant B admin or editor
- **Isolation Check**: Cross-tenant access remains blocked

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Config registry helper outputs are internally consistent

- **Boundary**: `packages/config` registry constants → helper functions
- **Setup**: Import registry helpers in a unit/integration-style config test
- **Steps**:
  1. Assert every exported provider type exists in the metadata map
  2. Assert helper arrays line up with capability flags
- **Expected Result**: No orphaned provider types or inconsistent helper outputs
- **Failure Mode**: Adding a provider in one list but not another recreates the current drift

### INT-2: Studio speech-provider API filtering uses registry helpers

- **Boundary**: `apps/studio/src/api/speech-providers.ts` → provider registry
- **Setup**: Mock `/api/service-instances` response with mixed provider types
- **Steps**:
  1. Call `fetchConfiguredSpeechProviders()`
  2. Assert STT and TTS results match registry-defined channel capabilities
- **Expected Result**: Filtering is driven by registry metadata instead of local arrays
- **Failure Mode**: Local arrays diverge from runtime or Studio S2S definitions

### INT-3: Studio S2S selector uses registry labels and support status

- **Boundary**: `S2SProviderSelector.tsx` → registry metadata
- **Setup**: Mock configured S2S providers including one full and one partial provider
- **Steps**:
  1. Render selector
  2. Assert label text matches registry labels
  3. Assert partial-support message appears only for partial providers
- **Expected Result**: Selector behavior follows registry metadata
- **Failure Mode**: Component-local maps drift from shared metadata

### INT-4: Runtime tenant-service-instance route validates service types from registry

- **Boundary**: `tenant-service-instances.ts` route → registry-driven validation schema
- **Setup**: Start real Express app with the route mounted
- **Steps**:
  1. Submit valid create requests for allowed runtime provider types
  2. Submit an unsupported provider type
  3. Assert only registry-backed runtime types are accepted
- **Expected Result**: Route validation stays aligned with the shared runtime allowlist
- **Failure Mode**: Route-local allowlists diverge from Studio or config package

### INT-5: Runtime speech-role helpers derive from registry capabilities

- **Boundary**: `tenant-service-instances.ts` helper usage → registry speech-role metadata
- **Setup**: Exercise helper-driven code paths or exported helper tests
- **Steps**:
  1. For each registry-backed speech provider, assert the derived STT/TTS role matches expected behavior
  2. Verify non-speech or S2S-only providers do not get speech sync roles
- **Expected Result**: Runtime role derivation is centralized and test-locked
- **Failure Mode**: Speech-role logic forks from the registry again

---

## 4. Unit Test Scenarios

### UT-1: Capability helpers return correct S2S provider unions

- **Module**: `packages/config/src/constants/voice-providers.ts`
- **Input**: Registry metadata
- **Expected Output**: Exported S2S helper list matches metadata and types

### UT-2: Admin grouping helpers return only admin-visible providers

- **Module**: Shared registry helpers or Studio registry wrapper
- **Input**: Provider metadata with mixed capabilities
- **Expected Output**: Admin-visible cards exclude hidden/non-admin providers

### UT-3: Partial-support copy only appears for providers marked partial

- **Module**: Studio S2S selector or Studio registry wrapper
- **Input**: One full provider, one partial provider
- **Expected Output**: Only the partial provider gets the partial-support indicator

---

## 5. Security & Isolation Tests

- Cross-tenant service-instance access still returns the existing non-leaky response
- Project-scoped channel configuration only loads providers for the authenticated tenant context
- Missing auth on runtime service-instance CRUD still returns `401`
- Invalid provider types still fail validation
- Registry refactor does not change credential payload sanitization or secret exposure

---

## 6. Performance & Load Tests (if applicable)

Not applicable. The registry is static in-memory metadata and should not materially change request latency.

---

## 7. Test Infrastructure

- **Required services**: Runtime and Studio for manual/E2E checks; Vitest for unit/integration checks
- **Data seeding**: Seed tenant service instances through existing HTTP APIs where end-to-end verification is needed
- **Environment variables**: Existing Studio/runtime test env only
- **CI configuration**: Covered by targeted package builds and test suites

---

## 8. Test File Mapping

| Test File                                                                                   | Type             | Covers           |
| ------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| `packages/config/src/__tests__/voice-providers.test.ts`                                     | unit             | FR-1, FR-2, FR-7 |
| `apps/studio/src/__tests__/speech-providers.test.ts`                                        | unit             | FR-4             |
| `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`                                  | unit/integration | FR-3, FR-8       |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`                    | integration      | FR-5, FR-9       |
| `apps/runtime/src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` | E2E              | FR-5, FR-9       |

---

## 9. Open Testing Questions

1. Should partial S2S providers stay selectable in E2E flows, or should a future story disable them entirely?
2. Do we want a future runtime route unit test that asserts the exact registry-derived Zod enum contents, or is route-level acceptance coverage sufficient for this story?

---

## 10. Validation Notes (2026-04-22)

- `packages/config`: `pnpm --filter @agent-platform/config build` and `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts` passed.
- `apps/studio`: `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/s2s-provider-selector.test.tsx` passed (`12/12` tests).
- `apps/studio`: filtered `tsc --noEmit` output reported no errors for the touched Studio files after the `VoiceServiceCardConfig` fix.
- `apps/runtime`: the story-specific `S2SProviderType` export/import issue in `src/services/voice/s2s/types.ts` was fixed, and filtered runtime typecheck output no longer reports that file.
- `apps/runtime`: full runtime route test execution remains blocked in this worktree by unrelated workspace package-resolution failures (for example `@agent-platform/shared/rbac` from existing test helpers), so runtime status is kept `PARTIAL`.

## 11. Validation Notes (2026-05-05)

- Added `apps/runtime/src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` to cover real HTTP CRUD for registry-backed providers (`microsoft`, `google`, `deepgram`, `elevenlabs`), rejection of unsupported `azure`, sanitized public config, update/delete, and cross-tenant list/update denial.
- Validation: `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/channels/voice-provider-registry-service-instances.e2e.test.ts` passed (`1/1` test).
- Browser-level Studio/channel E2E scenarios remain open; this pass adds the runtime API E2E needed to protect merge safety for provider persistence and isolation.
