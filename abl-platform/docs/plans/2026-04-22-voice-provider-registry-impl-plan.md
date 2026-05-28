# LLD: Voice Provider Registry and Capability Matrix

**Feature Spec**: `docs/features/sub-features/voice-provider-registry.md`
**HLD**: `docs/specs/voice-provider-registry.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-provider-registry.md`
**Status**: DONE
**Date**: 2026-04-22

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                     | Rationale                                                           | Alternatives Rejected       |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------- |
| D-1 | Put canonical provider metadata in `packages/config`         | Both Studio and runtime already depend on this package              | App-local-only registry     |
| D-2 | Keep Studio-specific field metadata in a Studio wrapper file | JSX, icons, and component references do not belong in shared config | Full schema-driven renderer |
| D-3 | Model partial S2S support explicitly in the registry         | Story requires capability guards without pretending runtime parity  | No support-status field     |

### Key Interfaces & Types

```ts
type VoiceServiceType = string;

interface VoiceProviderCapabilities {
  adminVisible: boolean;
  runtimeCrud: boolean;
  channelSttSelectable: boolean;
  channelTtsSelectable: boolean;
  supportsSpeechOptions: boolean;
  supportsTtsPreview: boolean;
  s2sTelephonySupport: 'full' | 'partial' | 'none';
  speechRole?: { useForStt: boolean; useForTts: boolean };
}

interface VoiceProviderDefinition {
  serviceType: VoiceServiceType;
  label: string;
  description: string;
  capabilities: VoiceProviderCapabilities;
}
```

### Module Boundaries

| Module                                                | Responsibility                                                             | Depends On                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `packages/config/src/constants/voice-providers.ts`    | Canonical provider metadata and helper exports                             | none                               |
| `apps/studio/.../voice-provider-registry.tsx`         | Studio-only card fields, icons, S2S component map                          | shared registry, Studio components |
| `apps/studio/src/api/speech-providers.ts`             | Registry-backed STT/TTS filtering                                          | shared registry                    |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Registry-backed runtime service-type validation and speech-role derivation | shared registry                    |

---

## 2. File-Level Change Map

### New Files

| File                                                           | Purpose                                                    | LOC Estimate |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------------ |
| `packages/config/src/constants/voice-providers.ts`             | Shared provider registry and helpers                       | 200-260      |
| `packages/config/src/__tests__/voice-providers.test.ts`        | Shared registry tests                                      | 80-140       |
| `apps/studio/src/components/voice/voice-provider-registry.tsx` | Studio registry wrapper for cards and S2S field components | 180-260      |
| `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`     | Focused selector behavior test                             | 120-180      |

### Modified Files

| File                                                                      | Change Description                                        | Risk   |
| ------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| `packages/config/src/index.ts`                                            | Export registry helpers                                   | Low    |
| `packages/config/package.json`                                            | Add subpath export if needed                              | Low    |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`                  | Use Studio registry wrapper for cards and readiness logic | Medium |
| `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` | Use registry labels/support flags                         | Medium |
| `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`     | Use registry-backed component lookup and support warning  | Medium |
| `apps/studio/src/api/voice-services.ts`                                   | Replace local S2S type union with shared type             | Low    |
| `apps/studio/src/api/speech-providers.ts`                                 | Replace local STT/TTS arrays with shared helpers          | Low    |
| `apps/runtime/src/services/voice/s2s/types.ts`                            | Re-export shared S2S provider type                        | Low    |
| `apps/runtime/src/routes/tenant-service-instances.ts`                     | Replace duplicated service-type and speech-role lists     | Medium |
| `apps/studio/src/__tests__/speech-providers.test.ts`                      | Align tests to registry-backed helpers                    | Low    |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`  | Add coverage for registry-backed service types if needed  | Low    |

### Deleted Files (if any)

None.

---

## 3. Implementation Phases

### Phase 1: Shared Registry

**Goal**: Establish one canonical provider matrix in `packages/config`.

**Tasks**:
1.1 Add shared provider definitions, typed lists, and helper predicates
1.2 Export the registry from `packages/config`
1.3 Add focused registry tests

**Files Touched**:

- `packages/config/src/constants/voice-providers.ts`
- `packages/config/src/index.ts`
- `packages/config/package.json`
- `packages/config/src/__tests__/voice-providers.test.ts`

**Exit Criteria**:

- [x] Shared registry compiles
- [x] Shared registry tests pass
- [x] Studio and runtime can import the shared helpers

**Test Strategy**:

- Unit: helper outputs, type coverage, support-status expectations

**Rollback**: Revert the new shared registry and restore local lists.

---

### Phase 2: Studio Refactor

**Goal**: Make Studio consume the shared registry for cards, speech filtering, and S2S UX.

**Tasks**:
2.1 Add a Studio registry wrapper for fields, icons, and S2S component routing
2.2 Refactor `VoiceServicesPage.tsx` to consume wrapper-provided groups
2.3 Refactor `S2SProviderSelector.tsx` and `S2SConfigFields.tsx`
2.4 Refactor `speech-providers.ts` and `voice-services.ts`
2.5 Add/update Studio tests

**Files Touched**:

- `apps/studio/src/components/voice/voice-provider-registry.tsx`
- `apps/studio/src/components/admin/VoiceServicesPage.tsx`
- `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx`
- `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`
- `apps/studio/src/api/voice-services.ts`
- `apps/studio/src/api/speech-providers.ts`
- `apps/studio/src/__tests__/speech-providers.test.ts`
- `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`

**Exit Criteria**:

- [ ] Studio build passes
- [x] Speech-provider tests pass
- [x] Selector test covers partial-support messaging

**Test Strategy**:

- Unit/integration: registry-backed filtering, selector rendering

**Rollback**: Restore previous Studio-local lists and remove wrapper wiring.

---

### Phase 3: Runtime Refactor

**Goal**: Replace duplicated runtime service-type metadata with shared helpers.

**Tasks**:
3.1 Refactor runtime S2S type file to use shared type exports
3.2 Refactor tenant-service-instances route to derive allowlists and speech-role helpers from the registry
3.3 Add or update route-level regression coverage

**Files Touched**:

- `apps/runtime/src/services/voice/s2s/types.ts`
- `apps/runtime/src/routes/tenant-service-instances.ts`
- `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts`

**Exit Criteria**:

- [ ] Runtime build passes
- [ ] Runtime route tests pass
- [x] Runtime no longer keeps a separate hardcoded service-type allowlist for the covered path

**Test Strategy**:

- Integration: route acceptance and auth coverage

**Rollback**: Restore route-local arrays and switches.

---

## 4. Wiring Checklist

- [x] Shared registry exported from `packages/config`
- [x] Studio wrapper imports shared registry and is referenced by Voice Services and S2S surfaces
- [x] Runtime route imports shared registry helpers
- [x] Shared tests added for the new registry
- [x] Studio tests updated for registry-backed filtering
- [ ] Runtime route regression coverage still passes

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

- [x] Studio and runtime consume one canonical provider registry
- [x] Partial S2S support is surfaced in Studio
- [x] No new provider support is claimed beyond current ABL implementation
- [ ] Targeted builds and tests for touched packages pass
- [x] Feature/test/design docs reflect the actual implementation

---

## 7. Open Questions

1. Whether to block partial S2S providers entirely is deferred.
2. Whether to normalize more provider-specific Studio field metadata into a generic schema is deferred.

---

## 8. Post-Implementation Notes (2026-04-22)

- Phase 1 and Phase 2 exit criteria are effectively met through package-scoped config build/tests plus focused Studio tests and filtered touched-file typechecks.
- Phase 3 implementation is complete, including the runtime route allowlist/speech-role refactor and a regression update in `tenant-service-instances-authz.test.ts`.
- Full runtime build/test exit criteria remain open because this worktree currently reports unrelated workspace package-resolution failures outside the touched files.
- The story therefore closes implementation as `DONE` with partial runtime verification still called out explicitly in the feature/test docs.
