# LLD: Voice Pipeline TTS Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-pipeline-tts-provider-parity.md`
**HLD**: `docs/specs/voice-pipeline-tts-provider-parity.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-pipeline-tts-provider-parity.md`
**Status**: DONE
**Date**: 2026-04-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                      | Rationale                                                                  | Alternatives Rejected            |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| D-1 | Keep provider membership and preview-capability metadata in `packages/config` | Studio and runtime both need the same TTS classification and support flags | App-local provider maps          |
| D-2 | Keep provider form metadata in Studio                                         | JSX hints, field widgets, and card copy remain app-specific                | Shared schema-driven form engine |
| D-3 | Reuse the runtime speech-credential mapper for TTS normalization              | Route code should orchestrate CRUD and auth, not encode provider payloads  | Route-local switch/case logic    |
| D-4 | Preserve `azure` as non-runtime for this story                                | Repo scope is KoreVG-backed parity, not a broader provider model redesign  | Promoting `azure` into runtime   |
| D-5 | Preserve the current preview matrix                                           | Preview support is a separate product capability, not implied by CRUD      | Auto-enabling preview everywhere |

### Key Interfaces & Types

```ts
interface SpeechProviderRole {
  useForStt: boolean;
  useForTts: boolean;
}

interface SpeechCredentialInput {
  vendor: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  userId?: string;
  voiceEngine?: string;
  modelId?: string;
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

| Module                                                            | Responsibility                                                     | Depends On                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts`                | Expanded TTS provider set, speech roles, preview flags             | none                                           |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`    | Studio-only provider cards and TTS field metadata                  | shared registry, Studio UI components          |
| `apps/studio/src/api/speech-providers.ts`                         | Active-only STT/TTS filtering for channel config                   | shared registry                                |
| `apps/runtime/src/routes/tenant-service-instances.ts`             | CRUD, auth-profile-backed sync orchestration, sanitization         | shared registry, auth profile resolver, mapper |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts`     | Normalize stored provider credentials into `SpeechCredentialInput` | shared registry, provisioning input type       |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts` | Serialize normalized inputs into Jambonz payloads                  | Jambonz API contract                           |

---

## 2. File-Level Change Map

### New Files

None for the runtime/Studio implementation itself. The story extends the shared registry, Studio wrapper metadata, existing mapper, and existing Jambonz provisioning coverage.

### Modified Files

| File                                                              | Change Description                                                              | Risk   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| `packages/config/src/constants/voice-providers.ts`                | Expand TTS provider matrix, dual-role speech metadata, preview-capability flags | Medium |
| `packages/config/src/__tests__/voice-providers.test.ts`           | TTS registry, speech-role, and preview-capability coverage                      | Low    |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`    | Add TTS card field definitions and metadata for the new providers               | Medium |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`          | Support direct vs auth-profile TTS credential flow through shared card metadata | Medium |
| `apps/studio/src/api/speech-providers.ts`                         | Filter and partition the expanded TTS provider set                              | Low    |
| `apps/studio/src/__tests__/speech-providers.test.ts`              | Expanded TTS filtering regression coverage                                      | Low    |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts`     | Normalize representative TTS providers into provisioning input                  | Medium |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts` | Support representative TTS provider payload fields                              | Medium |

### Deleted Files (if any)

None.

---

## 3. Implementation Phases

### Phase 1: Shared TTS Matrix Expansion

**Goal**: Make the shared registry express the target pipeline TTS parity set.

**Tasks**:
1.1 Add the TTS provider definitions and capability flags
1.2 Preserve preview-capability metadata as a distinct shared concern
1.3 Update shared registry tests

**Files Touched**:

- `packages/config/src/constants/voice-providers.ts`
- `packages/config/src/__tests__/voice-providers.test.ts`

**Exit Criteria**:

- [x] Shared registry compiles
- [x] Shared registry tests pass
- [x] Runtime/admin/channel helper lists reflect the intended TTS set

**Test Strategy**:

- Unit: registry membership, speech roles, preview-capability outputs, `azure` exclusion

**Rollback**: Revert the new provider definitions and helper expectations.

---

### Phase 2: Studio Admin and Channel Wiring

**Goal**: Expose the expanded TTS provider set in Studio without changing the overall UX.

**Tasks**:
2.1 Expand Studio provider-card field metadata for the new TTS vendors
2.2 Make Voice Services honor primary-credential storage type and auth-profile eligibility for TTS
2.3 Keep TTS filtering aligned with the expanded runtime-managed provider set
2.4 Preserve preview-capability boundaries
2.5 Update Studio tests

**Files Touched**:

- `apps/studio/src/components/voice/voice-provider-registry.tsx`
- `apps/studio/src/components/admin/VoiceServicesPage.tsx`
- `apps/studio/src/api/speech-providers.ts`
- `apps/studio/src/__tests__/speech-providers.test.ts`

**Exit Criteria**:

- [ ] Studio package-wide build passes
- [x] Focused Studio speech-provider tests pass
- [x] Studio admin flow can represent provider-specific TTS config shapes in code
- [x] Preview-capability matrix remains limited to the intended providers

**Test Strategy**:

- Unit/integration: active-only speech-provider filtering and shared preview-capability checks

**Rollback**: Restore prior Studio-local behavior and remove the extra provider cards.

---

### Phase 3: Runtime Speech Provisioning Parity

**Goal**: Make runtime CRUD and speech provisioning honor the expanded TTS provider set.

**Tasks**:
3.1 Expand runtime credential mapping for representative TTS providers
3.2 Expand Jambonz payload generation for representative TTS providers
3.3 Keep runtime CRUD aligned with the expanded shared provider set
3.4 Update runtime regression tests

**Files Touched**:

- `apps/runtime/src/services/voice/speech-credential-mapper.ts`
- `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`
- `apps/runtime/src/routes/tenant-service-instances.ts`
- `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`

**Exit Criteria**:

- [ ] Runtime package-wide build passes
- [x] Mapper and Jambonz targeted tests pass
- [x] Dual-role providers remain aligned for TTS in the shared registry

**Test Strategy**:

- Unit/integration: mapper coverage, Jambonz payload coverage, shared registry assertions

**Rollback**: Restore prior runtime CRUD/sync behavior for the expanded TTS providers.

---

## 4. Wiring Checklist

- [x] Shared registry exports the expanded TTS provider set
- [x] Preview-capability metadata is shared instead of hardcoded in multiple places
- [x] Studio provider-card metadata references the new TTS providers
- [x] Voice Services reads field storage/auth-profile metadata instead of assuming API-key-only fields
- [x] Studio speech-provider filtering uses the shared registry for TTS partitioning
- [x] Runtime mapper/Jambonz provisioning cover representative TTS providers
- [ ] Runtime package-wide verification passes in this worktree

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

- [x] ABL models the target pipeline TTS provider set as first-class shared providers
- [x] Studio Admin Voice Services can represent and persist the expanded TTS set
- [x] Runtime speech provisioning maps representative new TTS providers into vendor-specific Jambonz payloads
- [x] Channel filtering and preview-capability metadata remain aligned with the shared registry
- [x] `azure` remains outside runtime/admin parity
- [ ] Package-wide builds/tests for touched packages pass cleanly in this worktree
- [x] Feature/test/design docs reflect the actual implementation and blockers

---

## 7. Open Questions

1. Which TTS vendors need live smoke coverage before moving this story beyond `ALPHA`?
2. Do we want a dedicated runtime route integration suite for expanded TTS CRUD acceptance once workspace imports are healthy?
3. Should preview-specific UI tests be added when the preview surfaces stabilize further?

---

## 8. Post-Implementation Notes (2026-04-23)

- The story shipped in the combined voice-provider branch, so some verification commands covered shared voice infrastructure across multiple stories.
- Preview capability intentionally remained separate from runtime/admin parity; the story widened support without widening preview promises.
- Runtime package-wide verification is still partially blocked in this worktree by unrelated module-resolution failures; the open exit criteria are documented rather than masked.
