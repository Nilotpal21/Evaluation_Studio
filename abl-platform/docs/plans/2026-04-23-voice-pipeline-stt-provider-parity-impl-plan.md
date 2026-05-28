# LLD: Voice Pipeline STT Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-pipeline-stt-provider-parity.md`
**HLD**: `docs/specs/voice-pipeline-stt-provider-parity.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-pipeline-stt-provider-parity.md`
**Status**: DONE
**Date**: 2026-04-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                    | Rationale                                                                      | Alternatives Rejected               |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| D-1 | Keep provider membership and sensitive-config metadata in `packages/config` | Studio and runtime both need the same provider classification and sanitization | App-local provider maps             |
| D-2 | Keep provider form metadata in Studio                                       | JSX hints, field widgets, and card copy remain app-specific                    | Shared schema-driven form engine    |
| D-3 | Introduce a dedicated runtime speech-credential mapper                      | Route code should orchestrate CRUD and auth, not carry vendor payload mapping  | Route-local switch/case logic only  |
| D-4 | Preserve `azure` as non-runtime for this story                              | Repo scope is KoreVG-backed parity, not broader provider model redesign        | Promoting `azure` into runtime CRUD |

### Key Interfaces & Types

```ts
interface VoiceServiceCredentialSnapshot {
  apiKey: string;
  config?: Record<string, unknown>;
}

interface SpeechCredentialInput {
  vendor: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  roleArn?: string;
  region?: string;
  modelId?: string;
  sttModelId?: string;
}

interface VoiceServiceCardFieldConfig {
  key: string;
  storage: 'apiKey' | 'config';
  sensitive?: boolean;
  authProfileEligible?: boolean;
  type?: 'text' | 'password' | 'select' | 'textarea';
}
```

### Module Boundaries

| Module                                                            | Responsibility                                                           | Depends On                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts`                | Expanded STT provider set and sensitive-config metadata                  | none                                           |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`    | Studio-only provider cards and form-field metadata                       | shared registry, Studio UI components          |
| `apps/studio/src/api/speech-providers.ts`                         | Active-only STT/TTS filtering for channel config                         | shared registry                                |
| `apps/runtime/src/routes/tenant-service-instances.ts`             | CRUD, auth-profile-backed sync orchestration, config merge, sanitization | shared registry, auth profile resolver, mapper |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts`     | Normalize stored provider credentials into `SpeechCredentialInput`       | shared registry, provisioning input type       |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts` | Serialize normalized inputs into Jambonz payloads                        | Jambonz API contract                           |

---

## 2. File-Level Change Map

### New Files

| File                                                          | Purpose                                                                | LOC Estimate |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts` | Provider-specific STT credential normalization and config sanitization | 140-220      |
| `apps/runtime/src/__tests__/speech-credential-mapper.test.ts` | Mapper coverage for representative providers                           | 80-140       |

### Modified Files

| File                                                                     | Change Description                                                               | Risk   |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------ |
| `packages/config/src/constants/voice-providers.ts`                       | Expand STT provider matrix and sensitive-config metadata                         | Medium |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`           | Add STT card field definitions and metadata shape for config/auth-profile use    | Medium |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`                 | Support direct vs auth-profile primary credential flow with typed field storage  | Medium |
| `apps/studio/src/app/api/service-instances/route.ts`                     | Forward `serviceType` / `isActive` query params to runtime                       | Low    |
| `apps/studio/src/api/speech-providers.ts`                                | Filter active providers before STT/TTS partitioning                              | Low    |
| `apps/runtime/src/routes/tenant-service-instances.ts`                    | Expanded runtime allowlist, auth-profile-backed sync, config merge, sanitization | High   |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`        | Vendor-specific Jambonz STT payload support                                      | Medium |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`        | Provider payload regression coverage                                             | Low    |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts` | Runtime provider allowlist regression coverage                                   | Low    |
| `apps/studio/src/__tests__/speech-providers.test.ts`                     | Active-only filtering regression coverage                                        | Low    |
| `packages/config/src/__tests__/voice-providers.test.ts`                  | Expanded registry helper coverage                                                | Low    |

### Deleted Files (if any)

None.

---

## 3. Implementation Phases

### Phase 1: Shared Provider Matrix Expansion

**Goal**: Make the shared registry express the target STT parity set.

**Tasks**:
1.1 Add the new STT provider definitions and capability flags
1.2 Add sensitive-config key metadata for providers that need response sanitization
1.3 Update shared registry tests

**Files Touched**:

- `packages/config/src/constants/voice-providers.ts`
- `packages/config/src/__tests__/voice-providers.test.ts`

**Exit Criteria**:

- [x] Shared registry compiles
- [x] Shared registry tests pass
- [x] Runtime/admin helper lists reflect the intended STT set

**Test Strategy**:

- Unit: registry membership, runtime/admin helper outputs, `azure` exclusion

**Rollback**: Revert the new provider definitions and helper expectations.

---

### Phase 2: Studio Admin and Channel Wiring

**Goal**: Expose the expanded STT provider set in Studio without changing the overall UX.

**Tasks**:
2.1 Expand Studio provider-card field metadata for the new STT vendors
2.2 Make Voice Services honor primary-credential storage type, auth-profile eligibility, and provider-specific config fields
2.3 Forward `serviceType` / `isActive` in the Studio proxy
2.4 Filter active providers before STT/TTS partitioning
2.5 Update Studio tests

**Files Touched**:

- `apps/studio/src/components/voice/voice-provider-registry.tsx`
- `apps/studio/src/components/admin/VoiceServicesPage.tsx`
- `apps/studio/src/app/api/service-instances/route.ts`
- `apps/studio/src/api/speech-providers.ts`
- `apps/studio/src/__tests__/speech-providers.test.ts`

**Exit Criteria**:

- [ ] Studio package-wide build passes
- [x] Focused Studio speech-provider tests pass
- [x] Studio admin flow can represent provider-specific config shapes in code

**Test Strategy**:

- Unit/integration: active-only speech-provider filtering and Voice Services field handling

**Rollback**: Restore prior Studio-local behavior and remove the extra provider cards.

---

### Phase 3: Runtime Speech Provisioning Parity

**Goal**: Make runtime CRUD and speech provisioning honor the expanded STT provider set.

**Tasks**:
3.1 Add a runtime mapper that normalizes stored credentials into speech-provisioning input
3.2 Expand Jambonz payload generation for the new STT vendors
3.3 Update runtime CRUD to use auth-profile-backed sync, sanitized config, and partial-config merge
3.4 Update runtime regression tests

**Files Touched**:

- `apps/runtime/src/services/voice/speech-credential-mapper.ts`
- `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`
- `apps/runtime/src/routes/tenant-service-instances.ts`
- `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`
- `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`
- `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`

**Exit Criteria**:

- [ ] Runtime package-wide build passes
- [x] Mapper and Jambonz targeted tests pass
- [ ] Runtime authz regression suite passes
- [x] Route no longer loses omitted secret config on partial updates

**Test Strategy**:

- Unit/integration: mapper coverage, Jambonz payload coverage, route allowlist regression

**Rollback**: Restore prior runtime CRUD/sync behavior and remove the mapper indirection.

---

## 4. Wiring Checklist

- [x] Shared registry exports the expanded STT provider set
- [x] Studio provider-card metadata references the new STT providers
- [x] Voice Services reads field storage/auth-profile metadata instead of assuming API-key-only fields
- [x] Studio proxy forwards runtime filters used by speech-provider consumers
- [x] Runtime route imports shared registry helpers for validation/sanitization
- [x] Runtime route invokes the mapper before Jambonz provisioning
- [x] Mapper and Jambonz tests were added
- [ ] Runtime authz regression suite passes in this worktree

---

## 5. Cross-Phase Concerns

### Database Migrations

None.

### Feature Flags (if applicable)

None.

### Configuration Changes

None.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] ABL models the target pipeline STT provider set as first-class shared providers
- [x] Studio Admin Voice Services can represent and persist the expanded STT set
- [x] Runtime speech provisioning maps representative new STT providers into vendor-specific Jambonz payloads
- [x] Active-only filtering is enforced for Studio speech-provider consumers
- [x] `azure` remains outside runtime CRUD parity
- [ ] Package-wide builds/tests for touched packages pass cleanly in this worktree
- [x] Feature/test/design docs reflect the actual implementation and blockers

---

## 7. Open Questions

1. Should we add a dedicated route integration suite for config merge once runtime workspace imports are healthy?
2. Do we want live smoke coverage for each STT provider family before moving this story beyond `ALPHA`?

---

## 8. Post-Implementation Notes (2026-04-23)

- The story shipped in a combined branch with the voice-provider-registry story, so some verification commands covered both stories together.
- Studio and runtime code paths now support auth-profile-backed STT providers without introducing a new persistence model.
- Runtime package-wide verification is still partially blocked in this worktree by unrelated module-resolution failures; the open exit criteria are documented rather than masked.
