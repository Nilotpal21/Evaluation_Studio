# Feature: Voice Pipeline STT Provider Parity

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `integrations`, `customer experience`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/config`
**Owner(s)**: Platform Engineering
**Testing Guide**: [`../../testing/sub-features/voice-pipeline-stt-provider-parity.md`](../../testing/sub-features/voice-pipeline-stt-provider-parity.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

ABL had enough voice-service infrastructure to carry more pipeline STT providers, but the control plane still behaved as if Deepgram was the main first-class path. The gaps showed up in several places:

- the shared provider registry did not model the full KoreVG-backed pipeline STT set
- Admin Voice Services did not expose provider-specific credential forms for most STT vendors
- runtime speech-credential sync lacked one typed mapping layer for provider-specific Jambonz payloads
- partial updates could drop omitted secret config for vendors that require both a primary credential and secondary secret material
- Studio speech-provider fetches could still surface inactive instances because the proxy/filter path was incomplete

That left `abl-platform` in a state where adding STT providers was possible in theory but not cleanly supported end-to-end in the existing control plane.

### Goal Statement

Make `abl-platform` treat KoreVG-backed pipeline STT providers as first-class ABL providers across the shared registry, Studio admin credential flows, runtime service-instance CRUD, and Jambonz speech-credential provisioning.

### Summary

This story expands ABL pipeline STT support from the prior narrow set to the following first-class provider set:

- `deepgram`
- `google`
- `aws`
- `microsoft`
- `nuance`
- `gladia`
- `soniox`
- `cobalt`
- `ibm`
- `nvidia`
- `assemblyai`
- `houndify`
- `voxist`
- `cartesia`
- `speechmatics`
- `openai`
- `verbio`

The implementation adds shared metadata, Studio field definitions, runtime credential mapping, auth-profile-aware speech credential sync, and active-provider filtering. `azure` remains outside this parity story because it is still modeled as non-runtime and non-admin in the current ABL registry.

---

## 2. Scope

### Goals

- Expand the shared voice-provider registry to cover the KoreVG-backed pipeline STT providers ABL intends to expose
- Add Admin Voice Services card metadata and config fields for the new STT providers
- Support auth-profile-backed primary credentials where the provider shape allows it
- Map provider-specific STT credentials into Jambonz speech-credential payloads
- Preserve non-sensitive provider config in runtime read responses while stripping secrets
- Preserve secret config fields during partial updates
- Ensure Studio channel STT pickers only see active configured providers

### Non-Goals (Out of Scope)

- Pipeline TTS parity work
- S2S / realtime provider parity work
- Redesigning the Voice Services UX
- Converting the Voice Services page to a fully schema-driven renderer
- Making `azure` a runtime CRUD voice provider in this story
- Live telephony certification for every STT vendor

---

## 3. User Stories

1. As a tenant admin, I want to configure non-Deepgram STT providers directly in Admin Voice Services so I do not need repo-only wiring to use them.
2. As a deployment author, I want active STT providers to appear consistently in channel configuration so inactive or stale instances do not look selectable.
3. As a platform engineer, I want runtime speech provisioning to derive vendor-specific Jambonz payloads from one helper layer so adding STT vendors does not require route-local ad hoc mapping.
4. As an operator, I want partial updates to STT credentials to preserve existing secrets when the UI intentionally omits them so saved providers do not silently break.

---

## 4. Functional Requirements

1. **FR-1**: The shared voice-provider registry must define the target pipeline STT provider set and their capability flags.
2. **FR-2**: Admin Voice Services must render create/edit cards for the supported pipeline STT providers with provider-specific primary credential and config fields.
3. **FR-3**: Admin Voice Services must allow auth-profile-backed primary credentials for providers whose primary credential is API-key-like.
4. **FR-4**: Runtime tenant service-instance CRUD must accept the expanded STT provider set as valid runtime service types.
5. **FR-5**: Runtime tenant service-instance responses must expose non-sensitive config fields for the supported STT providers while stripping secret config keys.
6. **FR-6**: Runtime updates must merge existing stored STT config with partial config patches so omitted secrets are not lost.
7. **FR-7**: Runtime speech-credential sync must map the supported STT providers into vendor-specific Jambonz payloads.
8. **FR-8**: Auth-profile-backed STT instances must resolve the primary credential before Jambonz provisioning or re-provisioning.
9. **FR-9**: Studio service-instance proxying and speech-provider filtering must only expose active configured providers to channel STT pickers.
10. **FR-10**: Existing tenant isolation, audit behavior, and encrypted credential handling must remain intact.
11. **FR-11**: `azure` must remain excluded from the runtime CRUD parity set for this story.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                         |
| -------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                                  |
| Agent lifecycle            | NONE         | No agent compilation or model routing changes                                 |
| Customer experience        | SECONDARY    | More STT providers are configurable and appear consistently in Studio         |
| Integrations / channels    | PRIMARY      | Channel STT provider selection reflects the expanded active provider surface  |
| Observability / tracing    | NONE         | No new trace contracts                                                        |
| Governance / controls      | SECONDARY    | Secret config sanitization and auth-profile use are made more explicit        |
| Enterprise / compliance    | SECONDARY    | More provider secrets flow through existing encrypted service-instance paths  |
| Admin / operator workflows | PRIMARY      | Voice Services becomes the control-plane entry point for the expanded STT set |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                                            | Key Touchpoints                                    | Current State |
| ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------- |
| [Voice Capabilities](../voice-capabilities.md) | extends           | This story expands pipeline STT control-plane parity within the existing voice capability | Voice Services, channel speech selectors           | ALPHA         |
| [Auth Profiles](../auth-profiles.md)           | configured by     | STT providers can optionally resolve their primary credential from auth profiles          | Voice Services admin flow, runtime auth resolution | BETA          |
| [Channels](../channels.md)                     | configured by     | Channel STT dropdowns consume the configured active provider set                          | speech provider filtering                          | ALPHA         |

---

## 6. Design Considerations (Optional)

The user-facing workflow should stay familiar: tenant admins still configure providers in Admin Voice Services, and deployment authors still pick from configured providers in channel setup. This story expands provider coverage without introducing a new settings surface or changing the overall voice-setup sequence.

---

## 7. Technical Considerations (Optional)

- Shared provider membership and secret-key metadata belong in `packages/config` because both Studio and runtime need the same classification logic.
- Provider-specific Studio field definitions still belong in Studio because they include JSX hints, selects, and display-only metadata.
- Runtime speech provisioning needs a separate mapping helper so the route stays focused on CRUD, isolation, and orchestration.
- The runtime route must keep sanitizing returned config because the same provider configs mix safe display fields and secret fields.

---

## 8. How to Consume

### Studio UI

- **Admin → Voice Services** exposes the expanded pipeline STT providers as first-class cards.
- **Channels → Voice Pipeline** reads only active configured providers and partitions them through the shared registry.

### Design-Time vs Runtime Behavior

Design-time configuration still happens through `TenantServiceInstance` CRUD. Runtime uses those stored service instances to provision or re-provision Jambonz speech credentials whenever an STT provider is created or materially updated.

### API (Runtime)

| Method   | Path                                           | Purpose                                                                                      |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET`    | `/api/tenants/:tenantId/service-instances`     | Lists configured STT service instances and returns sanitized non-sensitive config            |
| `POST`   | `/api/tenants/:tenantId/service-instances`     | Creates STT service instances and provisions Jambonz speech credentials where applicable     |
| `PATCH`  | `/api/tenants/:tenantId/service-instances/:id` | Updates STT service instances, merges config, and re-provisions Jambonz speech credentials   |
| `DELETE` | `/api/tenants/:tenantId/service-instances/:id` | Deletes STT service instances and removes associated Jambonz speech credentials when present |

### API (Studio)

| Method | Path                     | Purpose                                                                  |
| ------ | ------------------------ | ------------------------------------------------------------------------ |
| `GET`  | `/api/service-instances` | Studio proxy used by Voice Services and channel speech-provider fetches  |
| `GET`  | `/api/speech-options`    | Existing speech-options proxy for supported vendor voice/language lookup |

### Provider Notes

- `google` uses the primary credential field for service-account JSON
- `aws`, `nuance`, `houndify`, and `verbio` combine a primary credential with one or more secret config fields
- `microsoft`, `ibm`, `assemblyai`, `cartesia`, `speechmatics`, and `openai` add vendor-specific non-secret config such as region, endpoint, version, or model
- `azure` remains intentionally outside the runtime/admin parity set here

---

## 9. Data Model

### Collections / Tables

No schema changes. The story reuses existing `TenantServiceInstance` fields:

- `serviceType`
- `encryptedApiKey`
- `authProfileId`
- `encryptedConfig`
- `jambonzSpeechCredentialSid`

### Key Relationships

- `TenantServiceInstance.serviceType` must match one of the registry-backed runtime voice service types
- `authProfileId` can supply the primary credential for eligible STT providers
- `encryptedConfig` stores provider-specific config and is sanitized on read

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts`                | Shared pipeline STT provider matrix and sensitive-config metadata |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts`     | Maps stored STT credentials/config into Jambonz speech inputs     |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts` | Vendor-specific Jambonz speech-credential payload shapes          |

### Routes / Handlers

| File                                                  | Purpose                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Registry-backed STT CRUD, auth-profile resolution, config merge, sync   |
| `apps/studio/src/app/api/service-instances/route.ts`  | Forwards query filters to runtime so active/serviceType filtering works |

### UI Components

| File                                                           | Purpose                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/components/voice/voice-provider-registry.tsx` | Provider-specific STT field metadata for Admin UI                     |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`       | Create/edit flow for direct-credential and auth-profile STT providers |
| `apps/studio/src/api/speech-providers.ts`                      | Active-only STT/TTS provider filtering for channel UI                 |

### Tests

| File                                                                     | Type        | Coverage Focus                                               |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------ |
| `packages/config/src/__tests__/voice-providers.test.ts`                  | unit        | Expanded STT registry membership and helper outputs          |
| `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`            | unit        | Provider-specific credential mapping and secret sanitization |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`        | unit        | Jambonz payload mapping for representative STT vendors       |
| `apps/studio/src/__tests__/speech-providers.test.ts`                     | unit        | Active-only speech-provider filtering                        |
| `apps/runtime/src/__tests__/auth/tenant-service-instances-authz.test.ts` | integration | Runtime provider allowlist and auth boundary regression      |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                  |
| -------- | ------- | ---------------------------- |
| N/A      | N/A     | No new environment variables |

### Runtime Configuration

No new runtime config knobs. Provider support is committed source metadata plus existing Jambonz/runtime configuration.

### DSL / Agent IR / Schema

No DSL or Agent IR changes.

---

## 12. Risks & Mitigations

| Risk                                             | Impact | Mitigation                                                                 |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------- |
| Provider-specific config drift                   | Medium | Keep provider membership and sensitive-key metadata in the shared registry |
| Secret loss on partial updates                   | High   | Merge stored config with patch payloads before re-encryption               |
| Studio showing inactive providers                | Medium | Forward `isActive` filter and re-filter active instances client-side       |
| Over-claiming unsupported `azure` parity         | Medium | Keep `azure` marked `runtimeCrud: false` and `adminSurface: null`          |
| Runtime verification blocked by workspace issues | Medium | Keep story status `ALPHA` and document verification gaps honestly          |

---

## 13. Validation Notes (2026-04-23)

- `packages/config`: `pnpm --filter @agent-platform/config build` passed.
- `packages/config`: `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts` passed.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts` passed (`19` tests total).
- `apps/studio`: `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/voice-services.test.ts src/__tests__/s2s-provider-selector.test.tsx` passed (`15` tests total); only `speech-providers.test.ts` is story-specific, the others remained green in the combined branch verification.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/auth/tenant-service-instances-authz.test.ts` is still blocked in this worktree by an existing workspace import failure for `@agent-platform/shared/rbac`.
- `apps/studio` and `apps/runtime` package-wide builds still report pre-existing workspace/module-resolution failures outside this story, so package-wide verification remains partial.
