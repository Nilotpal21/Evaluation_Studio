# Feature: Voice Pipeline TTS Provider Parity

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `integrations`, `customer experience`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/config`
**Owner(s)**: Platform Engineering
**Testing Guide**: [`../../testing/sub-features/voice-pipeline-tts-provider-parity.md`](../../testing/sub-features/voice-pipeline-tts-provider-parity.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

ABL already had enough speech-service infrastructure to carry more pipeline TTS vendors, but the control plane still behaved like a much smaller set were first-class. Shared registry membership, Admin Voice Services forms, runtime credential mapping, and Jambonz provisioning did not consistently model the broader KoreVG-backed TTS surface.

That left the platform with partial support in theory but uneven support in practice: some providers could appear in channel or admin flows, but not all of them had first-class runtime CRUD, provider-specific config handling, or consistent provisioning behavior.

### Goal Statement

Make `abl-platform` treat the intended KoreVG-backed pipeline TTS provider set as first-class ABL providers across the shared registry, Studio admin configuration, runtime service-instance CRUD, and Jambonz speech provisioning.

### Summary

This story expands ABL pipeline TTS support to the following first-class provider set:

- `deepgram`
- `google`
- `aws`
- `microsoft`
- `nuance`
- `cartesia`
- `verbio`
- `rimelabs`
- `playht`
- `inworld`
- `elevenlabs`
- `custom:orpheus`

The work also preserves the dual-role speech providers that support both STT and TTS (`deepgram`, `google`, `aws`, `microsoft`, `nuance`, `cartesia`, `verbio`) and keeps TTS preview intentionally limited to the providers already wired for preview (`elevenlabs` and `custom:orpheus`). `azure` remains outside runtime/admin parity in this story.

---

## 2. Scope

### Goals

- Expand the shared voice-provider registry to cover the target pipeline TTS provider set
- Add Admin Voice Services field metadata for the new first-class TTS providers
- Support auth-profile-backed primary credentials for eligible TTS vendors
- Map provider-specific TTS credentials into Jambonz speech-credential payloads
- Keep channel TTS filtering aligned with the expanded runtime-managed provider set
- Preserve the current preview-capability boundary instead of over-claiming preview support

### Non-Goals (Out of Scope)

- Pipeline STT parity work beyond the dual-role provider updates needed for TTS
- S2S / realtime provider parity work
- Redesigning the Voice Services UI or replacing it with a schema-driven form engine
- Broadening TTS preview support beyond the currently preview-capable providers
- Promoting `azure` into runtime CRUD parity
- Live telephony certification for every TTS vendor

---

## 3. User Stories

1. As a tenant admin, I want to configure more TTS providers directly in Admin Voice Services so I do not need repo-only wiring to use them.
2. As a deployment author, I want the configured TTS providers in channel configuration to reflect the same provider matrix the admin UI manages.
3. As a platform engineer, I want one runtime mapping layer for TTS credential normalization so vendor-specific Jambonz payloads do not live directly inside the CRUD route.
4. As an operator, I want the preview matrix to remain honest so only providers with preview support are shown as preview-capable.

---

## 4. Functional Requirements

1. **FR-1**: The shared voice-provider registry must define the target pipeline TTS provider set and their capability flags.
2. **FR-2**: Admin Voice Services must render create/edit cards for the supported pipeline TTS providers with provider-specific primary credential and config fields.
3. **FR-3**: Runtime tenant service-instance CRUD must accept the expanded TTS provider set as valid runtime service types.
4. **FR-4**: Runtime tenant service-instance responses must continue to expose only non-sensitive provider config.
5. **FR-5**: Runtime speech-credential sync must map the supported TTS providers into vendor-specific Jambonz payloads.
6. **FR-6**: Studio speech-provider filtering must surface the expanded TTS provider set consistently for channel configuration.
7. **FR-7**: The shared preview-capability matrix must remain limited to the providers actually wired for preview.
8. **FR-8**: Existing tenant isolation, encrypted credential handling, and audit behavior must remain intact.
9. **FR-9**: `azure` must remain outside runtime/admin TTS parity for this story.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                      |
| -------------------------- | ------------ | -------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                               |
| Agent lifecycle            | NONE         | No compiler or model-routing changes                                       |
| Customer experience        | SECONDARY    | More TTS providers are configurable and selectable                         |
| Integrations / channels    | PRIMARY      | Channel TTS provider selection reflects the broader runtime-managed set    |
| Observability / tracing    | NONE         | No new trace contracts                                                     |
| Governance / controls      | SECONDARY    | Shared provider metadata and preview capability boundaries are centralized |
| Enterprise / compliance    | SECONDARY    | More provider secrets flow through existing encrypted service-instance UX  |
| Admin / operator workflows | PRIMARY      | Voice Services becomes the entry point for the expanded TTS set            |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                                    | Key Touchpoints                          | Current State |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------------------------------- | ---------------------------------------- | ------------- |
| [Voice Capabilities](../voice-capabilities.md) | extends           | This story expands pipeline TTS control-plane parity within the existing voice UX | Voice Services, channel TTS selectors    | ALPHA         |
| [Auth Profiles](../auth-profiles.md)           | configured by     | Eligible TTS providers can resolve primary credentials from auth profiles         | Voice Services admin flow, runtime sync  | BETA          |
| [Channels](../channels.md)                     | configured by     | Channel TTS dropdowns consume the configured active provider set                  | speech provider filtering, TTS selection | ALPHA         |

---

## 6. Design Considerations (Optional)

This story preserves the existing voice setup flow. Tenant admins still configure providers in Admin Voice Services, and deployment authors still pick from configured providers in channel setup. The work widens provider coverage without adding a new surface or changing the overall interaction sequence.

---

## 7. Technical Considerations (Optional)

- Shared provider membership and preview-capability metadata belong in `packages/config` because Studio and runtime both depend on the same classification logic.
- Provider-specific field definitions still belong in Studio because they carry JSX hints, selects, and display copy.
- Runtime speech provisioning needs a dedicated mapping layer so the CRUD route stays focused on isolation, persistence, and orchestration.
- Preview capability remains a separate shared flag because not every TTS provider with runtime CRUD is preview-capable in ABL.

---

## 8. How to Consume

### Studio UI

- **Admin → Voice Services** exposes the expanded pipeline TTS providers as first-class cards.
- **Channels → Voice Pipeline** reads only active configured providers and partitions them through the shared registry.
- **TTS preview** stays available only for providers whose shared capability metadata marks them preview-capable.

### Design-Time vs Runtime Behavior

Design-time configuration still happens through `TenantServiceInstance` CRUD. Runtime uses those stored service instances to provision or re-provision Jambonz speech credentials whenever a TTS provider is created or materially updated.

### Provider Notes

- `deepgram`, `google`, `aws`, `microsoft`, `nuance`, `cartesia`, and `verbio` are modeled as dual-role speech providers
- `rimelabs`, `playht`, `inworld`, `elevenlabs`, and `custom:orpheus` are TTS-only in the ABL registry
- `custom:orpheus` stays on the custom streaming adapter path and remains preview-capable
- `azure` remains intentionally outside runtime/admin parity here even though it stays in the channel-level allowlist

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

- `TenantServiceInstance.serviceType` must match one of the registry-backed runtime TTS service types
- `authProfileId` can supply the primary credential for eligible TTS providers
- `encryptedConfig` stores provider-specific config and is sanitized on read

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts`                | Shared pipeline TTS provider matrix, preview flags, speech roles |
| `apps/runtime/src/services/voice/speech-credential-mapper.ts`     | Maps stored TTS credentials/config into Jambonz speech inputs    |
| `apps/runtime/src/services/voice/jambonz-provisioning.service.ts` | Vendor-specific Jambonz speech-credential payload shapes         |

### Routes / Handlers

| File                                                  | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Registry-backed TTS CRUD, config sanitization, auth-profile-aware sync |
| `apps/studio/src/app/api/service-instances/route.ts`  | Forwards query filters so active-only TTS fetching works               |

### UI Components

| File                                                           | Purpose                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/studio/src/components/voice/voice-provider-registry.tsx` | Provider-specific TTS field metadata for Admin UI                     |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`       | Create/edit flow for direct-credential and auth-profile TTS providers |
| `apps/studio/src/api/speech-providers.ts`                      | Active-only STT/TTS provider filtering for channel UI                 |

### Tests

| File                                                              | Type             | Coverage Focus                                                |
| ----------------------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| `packages/config/src/__tests__/voice-providers.test.ts`           | unit             | Expanded TTS registry membership, speech roles, preview flags |
| `apps/runtime/src/__tests__/speech-credential-mapper.test.ts`     | unit             | Provider-specific credential mapping for TTS vendors          |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts` | unit/integration | Jambonz payload mapping for representative TTS vendors        |
| `apps/studio/src/__tests__/speech-providers.test.ts`              | unit/integration | Channel TTS filtering and provider partitioning               |

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

| Risk                                                      | Impact | Mitigation                                                           |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| Provider-matrix drift between Studio and runtime          | Medium | Keep provider membership and capability flags in the shared registry |
| Over-claiming preview support                             | Medium | Preserve a dedicated shared preview-capability matrix                |
| Vendor-specific payload mapping errors                    | Medium | Cover representative TTS providers in mapper/Jambonz tests           |
| Channel selectors showing a larger set than admin/runtime | Medium | Keep filtering aligned to the runtime-managed provider set           |
| Runtime verification blocked by workspace issues          | Medium | Keep story status `ALPHA` and document blocked lanes explicitly      |

---

## 13. Validation Notes (2026-04-23)

- `packages/config`: `pnpm --filter @agent-platform/config build` passed.
- `packages/config`: `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts` passed.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/speech-credential-mapper.test.ts src/__tests__/jambonz-provisioning.service.test.ts` passed.
- `apps/studio`: `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts` passed as part of the combined-branch verification lane.
- `apps/runtime`: the focused authz regression suite is still blocked in this worktree by an existing workspace import failure for `@agent-platform/shared/rbac`.
- `apps/studio` and `apps/runtime` package-wide builds still report pre-existing workspace/module-resolution failures outside this story, so package-wide verification remains partial.
