# Feature: Voice S2S Provider Parity

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: ALPHA
**Feature Area(s)**: `admin operations`, `integrations`, `runtime`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/config`
**Owner(s)**: Platform Engineering
**Testing Guide**: [`../../testing/sub-features/voice-s2s-provider-parity.md`](../../testing/sub-features/voice-s2s-provider-parity.md)
**Last Updated**: 2026-04-23

---

## 1. Introduction / Overview

### Problem Statement

ABL already modeled six S2S providers in its shared types and Studio surfaces:

- `s2s:openai`
- `s2s:elevenlabs`
- `s2s:google`
- `s2s:deepgram`
- `s2s:ultravox`
- `s2s:grok`

But the KoreVG telephony runtime still treated too much of that surface as OpenAI-shaped. Provider-specific realtime payloads, tool result envelopes, event translation, and Studio config fields were incomplete for the non-OpenAI providers, especially Deepgram Voice Agent and Ultravox. That meant ABL could claim support in config surfaces before the KoreVG runtime path actually knew how to speak each provider’s contract.

### Goal Statement

Make the currently modeled ABL S2S provider set use provider-aware KoreVG telephony wiring, while keeping capability messaging honest for the remaining non-OpenAI inline handoff limitations.

### Summary

This story keeps the modeled ABL S2S set unchanged, but upgrades runtime behavior so the non-OpenAI providers are no longer routed through an OpenAI-only assumption set.

Shipped provider-aware runtime work includes:

- ElevenLabs conversational payload building
- Deepgram Voice Agent payload building, including separate think/listen/speak settings
- Ultravox payload building, including selected tools and optional agent id
- provider-native tool result and tool error envelopes
- provider-native event translation into internal realtime transcript/barge-in/turn traces
- provider-specific Deepgram and Ultravox config surfaces in Studio/admin

Capability messaging remains intentionally honest:

- `s2s:openai`, `s2s:google`, and `s2s:grok` stay `full`
- `s2s:elevenlabs`, `s2s:deepgram`, and `s2s:ultravox` stay `partial`

Those three now have baseline provider-aware telephony support, but inline agent handoff and prompt-swap flows are still limited for them in ABL.

---

## 2. Scope

### Goals

- Keep the shared registry as the source of truth for the current ABL S2S provider set
- Add provider-aware KoreVG llm-verb payload builders for the modeled non-OpenAI providers
- Add provider-specific Studio/admin config fields for Deepgram and Ultravox
- Normalize provider-native tool result and error messages
- Translate provider-native events into the internal realtime trace/event shape
- Keep capability messaging aligned with the actual remaining runtime limitations

### Non-Goals (Out of Scope)

- Adding net-new S2S providers not already modeled in ABL
- Replacing Google or Grok’s existing specialized router paths
- Delivering full inline handoff parity for every non-OpenAI S2S provider
- Broadening the story into pipeline STT/TTS parity
- Redesigning the Studio S2S UX

---

## 3. User Stories

1. As a tenant admin, I want the currently modeled S2S providers to expose the config fields they actually need so saved credentials match runtime expectations.
2. As a runtime engineer, I want KoreVG to build provider-native payloads and tool messages instead of assuming every provider behaves like OpenAI Realtime.
3. As an operator, I want provider-native transcript and barge-in events to show up in the internal voice tracing path consistently.
4. As a deployment author, I want Studio capability messaging to reflect the actual remaining S2S limitations instead of overstating or understating support.

---

## 4. Functional Requirements

1. **FR-1**: The shared voice-provider registry must remain the source of truth for the modeled ABL S2S provider set and telephony capability messaging.
2. **FR-2**: Admin Voice Services and channel S2S configuration must expose provider-specific config fields for the modeled providers that need them.
3. **FR-3**: KoreVG runtime must build provider-native llm-verb payloads for the modeled non-OpenAI providers.
4. **FR-4**: KoreVG runtime must send provider-native tool result and tool error envelopes for those providers.
5. **FR-5**: Provider-native events must translate into ABL’s internal realtime trace/event shape for transcripts, barge-ins, and turn completion.
6. **FR-6**: Runtime tracing and persisted voice metadata must use the correct provider label/voice context for those providers.
7. **FR-7**: Non-OpenAI providers must no longer receive invalid OpenAI inline `session.update` handoff behavior.
8. **FR-8**: Capability guards must stay honest: providers that still lack inline prompt-swap parity must remain marked `partial`, but the user-facing message must describe the real remaining limitation.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                               |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project lifecycle changes                                        |
| Agent lifecycle            | NONE         | No compiler or deployment model changes                             |
| Customer experience        | SECONDARY    | More S2S providers behave correctly once configured                 |
| Integrations / channels    | PRIMARY      | KoreVG telephony wiring becomes provider-aware for the modeled set  |
| Observability / tracing    | PRIMARY      | Provider-native events are normalized into internal voice traces    |
| Governance / controls      | SECONDARY    | Shared capability messaging remains an explicit support contract    |
| Enterprise / compliance    | NONE         | No new persistence model or compliance surface                      |
| Admin / operator workflows | PRIMARY      | Studio/admin S2S field definitions now match runtime provider needs |

### Related Feature Integration Matrix

| Related Feature                                        | Relationship Type | Why It Matters                                                                                            | Key Touchpoints                               | Current State |
| ------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------- |
| [Voice Capabilities](../voice-capabilities.md)         | extends           | This story expands modeled S2S providers from UI-only/partial wiring into provider-aware runtime behavior | Studio S2S config, KoreVG router, traces      | ALPHA         |
| [Channels](../channels.md)                             | configured by     | Channel S2S deployment surfaces depend on the provider set and config fields                              | channel S2S config fields, provider selector  | ALPHA         |
| [Tracing & Observability](../tracing-observability.md) | emits into        | Provider-native realtime events must normalize into shared trace events                                   | `voice_stt`, `voice_tts`, `voice_turn` traces | BETA          |

---

## 6. Design Considerations (Optional)

This story keeps the existing Studio S2S selection and Voice Services flow intact. The main design change is in runtime behavior: provider-specific payload and event translation now live in an adapter layer instead of being implicitly treated as OpenAI-compatible.

---

## 7. Technical Considerations (Optional)

- The provider-aware adapter belongs in runtime because it is a KoreVG transport concern, not a shared config concern.
- Shared provider capabilities still belong in `packages/config` because Studio and runtime both need the same provider matrix and support messaging.
- Google and Grok keep their specialized router branches because they already had distinct working flows before this story.
- Non-OpenAI providers that lack inline session update semantics stay marked `partial` so the UI does not imply handoff parity that the runtime still does not deliver.

---

## 8. How to Consume

### Studio UI

- **Admin → Voice Services** exposes provider-specific S2S config fields for the currently modeled providers.
- **Channels → S2S configuration** uses the same modeled provider set and provider-specific field components.
- **Capability messaging** warns only when the provider is still `partial`, and the warning now names the remaining inline handoff/prompt-swap limitation instead of implying the whole telephony path is missing.

### Design-Time vs Runtime Behavior

Design-time configuration still happens through `TenantServiceInstance` CRUD. Runtime uses the stored S2S provider credentials/config to build KoreVG llm-verb payloads, translate provider-native events, and serialize tool outputs in the format each provider expects.

### Provider Notes

- `s2s:openai`, `s2s:google`, and `s2s:grok` remain the strongest end-to-end telephony paths
- `s2s:elevenlabs` now uses provider-native conversational payload and tool-result envelopes
- `s2s:deepgram` now models separate think/listen/speak settings plus provider-native tool and event translation
- `s2s:ultravox` now supports provider-native selected tools, event translation, and optional `agentId`
- `s2s:elevenlabs`, `s2s:deepgram`, and `s2s:ultravox` still remain `partial` because inline agent handoff/prompt swap is not yet first-class for them

---

## 9. Data Model

### Collections / Tables

No schema changes. The story reuses existing `TenantServiceInstance` and runtime session state.

### Key Relationships

- `TenantServiceInstance.serviceType` must match one of the modeled S2S provider types
- `encryptedApiKey` and `encryptedConfig` feed the runtime S2S session config
- Runtime session traces now depend on provider-native event translation for non-OpenAI providers

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                             | Purpose                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/config/src/constants/voice-providers.ts`               | Shared S2S provider matrix and telephony-capability messaging             |
| `apps/runtime/src/services/voice/korevg/s2s-provider-adapter.ts` | Provider-aware llm payload builders, tool messages, and event translation |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts`        | KoreVG telephony runtime path that invokes provider-aware S2S handling    |

### Routes / Handlers

| File                                                  | Purpose                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/runtime/src/routes/tenant-service-instances.ts` | Persists modeled S2S service instances through the shared registry |

### UI Components

| File                                                                      | Purpose                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`            | Admin card metadata for modeled S2S providers              |
| `apps/studio/src/components/deployments/channels/DeepgramS2SFields.tsx`   | Deepgram Voice Agent-specific channel config fields        |
| `apps/studio/src/components/deployments/channels/UltravoxS2SFields.tsx`   | Ultravox-specific channel config fields                    |
| `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`     | Provider-specific S2S config rendering                     |
| `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` | Shared provider/capability selection and support messaging |

### Tests

| File                                                        | Type             | Coverage Focus                                                      |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| `packages/config/src/__tests__/voice-providers.test.ts`     | unit             | S2S provider set, telephony support messaging, capability alignment |
| `apps/runtime/src/__tests__/s2s-provider-adapter.test.ts`   | unit             | Provider-aware payload builders, tool envelopes, event translation  |
| `apps/runtime/src/__tests__/channels/korevg-router.test.ts` | integration      | KoreVG router provider-aware event/tool behavior                    |
| `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`  | unit/integration | Modeled S2S provider selection and configured-provider filtering    |
| `apps/studio/src/__tests__/voice-services.test.ts`          | unit/integration | Forward-compatible S2S provider handling in the Studio proxy layer  |

---

## 11. Configuration

### Environment Variables

| Variable | Default | Description                  |
| -------- | ------- | ---------------------------- |
| N/A      | N/A     | No new environment variables |

### Runtime Configuration

No new runtime config knobs. The story extends existing S2S config fields stored in provider config and consumed by the KoreVG router.

### DSL / Agent IR / Schema

No DSL or Agent IR changes.

---

## 12. Risks & Mitigations

| Risk                                                        | Impact | Mitigation                                                                                        |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| Treating non-OpenAI providers like OpenAI at runtime        | High   | Move provider-specific payload and tool/event behavior into a dedicated adapter                   |
| Overstating S2S support after partial runtime work          | High   | Keep `partial` support flags and update the warning message to name the real remaining limitation |
| Provider-native events not reaching internal trace shape    | Medium | Add explicit translation tests and router integration coverage where possible                     |
| Router integration verification blocked by workspace issues | Medium | Keep story status `ALPHA` and mark blocked integration lanes explicitly                           |

---

## 13. Validation Notes (2026-04-23)

- `packages/config`: `pnpm --filter @agent-platform/config build` passed.
- `packages/config`: `pnpm --filter @agent-platform/config test -- src/__tests__/voice-providers.test.ts` passed.
- `apps/studio`: `pnpm --dir apps/studio exec vitest run src/__tests__/speech-providers.test.ts src/__tests__/voice-services.test.ts src/__tests__/s2s-provider-selector.test.tsx` passed as the combined-branch Studio verification lane.
- `apps/runtime`: `pnpm --dir apps/runtime exec vitest run src/__tests__/s2s-provider-adapter.test.ts` passed.
- `apps/runtime`: `src/__tests__/channels/korevg-router.test.ts` exists, but the correct integration-config lane in this worktree is currently blocked before execution by a pre-existing package-resolution failure for `@agent-platform/shared-observability`.
- `apps/runtime`: the authz regression suite is still blocked in this worktree by an existing `@agent-platform/shared/rbac` resolution failure from shared test helpers.
- `apps/studio` and `apps/runtime` package-wide builds still report pre-existing workspace/module-resolution failures outside this story, so package-wide verification remains partial.
