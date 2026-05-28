# HLD: Voice Pipeline STT Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-pipeline-stt-provider-parity.md`
**Test Spec**: `docs/testing/sub-features/voice-pipeline-stt-provider-parity.md`
**Status**: APPROVED
**Author**: Platform Engineering
**Date**: 2026-04-23

---

## 1. Problem Statement

ABL had enough generic voice-service infrastructure to carry more pipeline STT providers, but the control plane still behaved as if Deepgram were the main first-class path. Provider membership, admin forms, runtime provisioning, auth-profile use, and active-only filtering were not aligned for the broader KoreVG-backed STT set.

The goal is to make pipeline STT parity explicit and repo-backed without broadening into TTS or S2S work.

---

## 2. Alternatives Considered

### Option A: Add each provider ad hoc in Studio and runtime

- **Description**: Wire each provider directly where needed without adding a dedicated mapping layer.
- **Pros**: Lowest up-front code organization effort.
- **Cons**: Recreates the drift problem this Epic is trying to remove; route logic becomes brittle.
- **Effort**: M

### Option B: Shared registry expansion + Studio field metadata + runtime credential mapper (Recommended)

- **Description**: Keep provider membership and secret-key metadata in `packages/config`, keep provider form metadata in Studio, and add one runtime mapper that converts stored credentials into Jambonz speech payloads.
- **Pros**: Clear ownership boundaries, extensible for later TTS work, safer runtime route behavior.
- **Cons**: Touches multiple layers in one story.
- **Effort**: M

### Option C: Full schema-driven voice-service form engine

- **Description**: Replace the current provider-card model with a generic schema renderer shared across Studio and runtime.
- **Pros**: Maximum theoretical centralization.
- **Cons**: Too large for this story and would redesign working admin UX.
- **Effort**: L

### Recommendation: Option B

**Rationale**: The shared registry plus runtime mapper gives the right amount of structure for parity work while preserving the current admin UX and existing runtime CRUD boundaries.

---

## 3. Architecture

### System Context Diagram

```mermaid
flowchart LR
  A["packages/config voice provider registry"] --> B["apps/studio voice provider registry wrapper"]
  B --> C["VoiceServicesPage"]
  C --> D["Studio service-instances proxy"]
  D --> E["runtime tenant-service-instances route"]
  E --> F["speech-credential-mapper"]
  F --> G["Jambonz provisioning service"]
```

### Component Diagram

```mermaid
flowchart TD
  Registry["Shared Voice Provider Registry\npackages/config"]
  StudioWrapper["Studio Voice Provider Registry Wrapper"]
  StudioPage["VoiceServicesPage"]
  StudioSpeech["speech-providers.ts"]
  StudioProxy["service-instances API proxy"]
  RuntimeRoute["tenant-service-instances route"]
  Mapper["speech-credential-mapper.ts"]
  Jambonz["jambonz-provisioning.service.ts"]
  AuthProfiles["auth-profile-resolver"]

  Registry --> StudioWrapper
  Registry --> StudioSpeech
  Registry --> RuntimeRoute
  StudioWrapper --> StudioPage
  StudioProxy --> RuntimeRoute
  RuntimeRoute --> Mapper
  RuntimeRoute --> AuthProfiles
  Mapper --> Jambonz
```

### Data Flow

1. `packages/config` defines the expanded STT provider set and sensitive config keys.
2. Studio uses its wrapper file to render provider-specific admin forms for the new STT vendors.
3. Studio proxies service-instance reads to runtime with `serviceType` / `isActive` filters intact.
4. Runtime stores provider credentials in the existing service-instance model, either via direct encrypted primary credential or `authProfileId`.
5. Runtime resolves the current primary credential plus config into a normalized `SpeechCredentialInput`.
6. `jambonz-provisioning.service.ts` serializes that input into provider-specific Jambonz payloads.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Existing tenant-scoped runtime CRUD and auth-profile resolution remain the only data access path.              |
| 2   | **Data Access Pattern** | Reuse `TenantServiceInstance` plus existing encrypted fields; no schema migration.                             |
| 3   | **API Contract**        | Existing CRUD endpoints stay in place but now accept the expanded runtime STT set and return sanitized config. |
| 4   | **Security Surface**    | Secrets remain encrypted or auth-profile-backed; runtime strips sensitive config keys on read responses.       |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                        |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | Unsupported provider types still fail closed; invalid `azure` remains rejected from runtime CRUD.      |
| 6   | **Failure Modes** | The biggest risk is malformed vendor payload mapping; mitigate with targeted mapper and Jambonz tests. |
| 7   | **Idempotency**   | Create/update semantics stay the same; provisioning re-sync is deterministic from stored config.       |
| 8   | **Observability** | Existing audit/logging remains; no new trace contract is required for this story.                      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                            |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Static metadata lookups and small payload mapping only; negligible request overhead.                       |
| 10  | **Migration Path**     | Pure code-path expansion; existing service instances remain compatible.                                    |
| 11  | **Rollback Plan**      | Revert the registry entries, Studio cards, and runtime mapping helper for the new vendors only.            |
| 12  | **Test Strategy**      | Shared registry tests, mapper tests, Jambonz payload tests, Studio filtering tests, route auth regression. |

---

## 5. Data Model

### New Collections/Tables

None.

### Modified Collections/Tables

None.

### Key Relationships

- `TenantServiceInstance.serviceType` now covers the expanded pipeline STT provider set
- `TenantServiceInstance.authProfileId` may supply the primary credential for supported STT vendors
- `TenantServiceInstance.encryptedConfig` stores vendor-specific config that is merged on partial updates

---

## 6. API Design

### New Endpoints

None.

### Modified Endpoints

| Method                  | Path                                       | Purpose                                                                               | Auth                     |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------ |
| `GET/POST/PATCH/DELETE` | `/api/tenants/:tenantId/service-instances` | Expanded STT provider acceptance, sanitized config responses, auth-profile-aware sync | Existing credential auth |
| `GET`                   | `/api/service-instances`                   | Preserve `serviceType` / `isActive` forwarding from Studio to runtime                 | Existing Studio auth     |

### Error Responses

- Unsupported runtime provider types still return `400`
- Clearing an auth-profile-backed provider without replacing the primary credential still returns `400`
- Cross-tenant access rules remain unchanged

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Existing create/update/delete audit log writes remain unchanged.
- **Rate Limiting**: Existing tenant route rate limiting remains unchanged.
- **Caching**: Voice-service cache invalidation still happens after service-instance updates/deletes.
- **Encryption**: Direct primary credentials still flow through encrypted storage; auth-profile-backed providers resolve the primary credential at sync time.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                             | Type           | Risk   |
| -------------------------------------- | -------------- | ------ |
| `@agent-platform/config`               | shared package | Low    |
| existing `TenantServiceInstance` model | internal       | Low    |
| existing auth-profile resolver         | internal       | Medium |
| existing Jambonz provisioning client   | internal       | Medium |

### Downstream (depends on this feature)

| Consumer                      | Impact                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| Future pipeline TTS parity    | Can mirror the STT control-plane and runtime mapping split             |
| Future voice-provider stories | Can extend provider metadata without reworking the current scaffolding |

---

## 9. Open Questions & Decisions Needed

1. Should `azure` eventually become a first-class runtime/admin provider, or stay outside the current ABL pipeline model?
2. Which STT vendors need live credential smoke tests before this story can be promoted beyond `ALPHA`?
3. Do we want a dedicated route integration suite for config merge once the workspace import blockers are fixed?

---

## 10. References

- Feature spec: `docs/features/sub-features/voice-pipeline-stt-provider-parity.md`
- Test spec: `docs/testing/sub-features/voice-pipeline-stt-provider-parity.md`
- Shared provider registry: `packages/config/src/constants/voice-providers.ts`
- Runtime CRUD route: `apps/runtime/src/routes/tenant-service-instances.ts`
- Runtime credential mapper: `apps/runtime/src/services/voice/speech-credential-mapper.ts`

---

## Post-Implementation Notes (2026-04-23)

- The story shipped using the recommended layered split: shared provider registry in `packages/config`, Studio-only field metadata in the Studio wrapper, and a dedicated runtime mapper for Jambonz provisioning.
- Runtime now preserves existing encrypted secondary config during partial updates, which was necessary for providers such as AWS and Houndify.
- Auth-profile-backed STT providers resolve their primary credential during create/update sync without changing the underlying persistence model.
- Workspace-wide runtime and Studio build verification remains partially blocked in this worktree by unrelated module-resolution issues, so the story remains `ALPHA`.
