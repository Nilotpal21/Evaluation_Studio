# LLD: Voice S2S Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-s2s-provider-parity.md`
**HLD**: `docs/specs/voice-s2s-provider-parity.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-s2s-provider-parity.md`
**Status**: DONE
**Date**: 2026-04-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                   | Rationale                                                                   | Alternatives Rejected                  |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| D-1 | Keep the modeled S2S provider set in `packages/config`                     | Studio and runtime both depend on the same provider/support matrix          | App-local S2S provider maps            |
| D-2 | Add a dedicated runtime S2S adapter                                        | Provider-native payload/tool/event translation should not bloat the router  | Router-local switch/case only          |
| D-3 | Preserve Google and Grok specialized router branches                       | Those providers already had working specialized flows                       | Rewriting them into one generic branch |
| D-4 | Keep partial support flags for providers lacking inline prompt-swap parity | Baseline telephony support and inline handoff parity are different concerns | Marking all modeled providers `full`   |
| D-5 | Tighten the partial-provider warning copy                                  | The old message understated new runtime support after provider-aware wiring | Leaving the old “support pending” copy |

### Key Interfaces & Types

```ts
interface ProviderAdapterBuildParams {
  provider: S2SProviderType;
  apiKey: string;
  instructions: string;
  s2sConfig: S2SSessionConfig;
  promptTools: PromptToolDefinition[];
}

interface GenericRealtimeLlmVerbPayload {
  verb: 'llm';
  vendor: string;
  model: string;
  auth: Record<string, unknown>;
  llmOptions: Record<string, unknown>;
}

type S2SProviderFamily = 'openai' | 'google' | 'grok' | 'elevenlabs' | 'ultravox' | 'voiceagent';
```

### Module Boundaries

| Module                                                           | Responsibility                                                        | Depends On                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `packages/config/src/constants/voice-providers.ts`               | Modeled S2S provider set and telephony support messaging              | none                               |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`   | Admin card metadata for modeled S2S providers                         | shared registry                    |
| `apps/studio/src/components/deployments/channels/*S2SFields.tsx` | Provider-specific S2S config widgets                                  | Studio UI components               |
| `apps/runtime/src/services/voice/korevg/s2s-provider-adapter.ts` | Provider-aware payload builders, tool messages, and event translation | shared types                       |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts`        | KoreVG runtime orchestration and trace emission                       | adapter, session execution runtime |

---

## 2. File-Level Change Map

### New Files

| File                                                             | Purpose                                                                | LOC Estimate |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------ |
| `apps/runtime/src/services/voice/korevg/s2s-provider-adapter.ts` | Provider-aware S2S payload builders, tool envelopes, event translation | 220-360      |
| `apps/runtime/src/__tests__/s2s-provider-adapter.test.ts`        | Unit coverage for provider-aware adapter behavior                      | 120-220      |

### Modified Files

| File                                                                    | Change Description                                                                    | Risk   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| `packages/config/src/constants/voice-providers.ts`                      | Keep modeled S2S provider matrix and refine partial-provider warning copy             | Low    |
| `packages/config/src/__tests__/voice-providers.test.ts`                 | S2S support messaging regression coverage                                             | Low    |
| `apps/runtime/src/services/voice/korevg/korevg-router.ts`               | Use provider-aware adapter payloads, tool messages, event translation, and guardrails | High   |
| `apps/runtime/src/__tests__/channels/korevg-router.test.ts`             | Router behavior regression coverage for provider-aware S2S paths                      | Medium |
| `apps/studio/src/components/deployments/channels/DeepgramS2SFields.tsx` | Add provider-specific think/listen/voice fields                                       | Medium |
| `apps/studio/src/components/deployments/channels/UltravoxS2SFields.tsx` | Add optional agent id field                                                           | Low    |
| `apps/studio/src/components/voice/voice-provider-registry.tsx`          | Align admin card metadata with modeled Deepgram and Ultravox config                   | Medium |

### Deleted Files (if any)

None.

---

## 3. Implementation Phases

### Phase 1: Shared Support Contract and Studio Field Alignment

**Goal**: Keep the modeled S2S provider contract explicit in shared config and Studio.

**Tasks**:
1.1 Preserve the modeled S2S provider set in the shared registry
1.2 Refine partial-provider capability messaging so it names the real remaining limitation
1.3 Add Studio/admin/channel field metadata for Deepgram and Ultravox

**Files Touched**:

- `packages/config/src/constants/voice-providers.ts`
- `packages/config/src/__tests__/voice-providers.test.ts`
- `apps/studio/src/components/voice/voice-provider-registry.tsx`
- `apps/studio/src/components/deployments/channels/DeepgramS2SFields.tsx`
- `apps/studio/src/components/deployments/channels/UltravoxS2SFields.tsx`

**Exit Criteria**:

- [x] Shared registry compiles
- [x] Shared registry tests pass
- [x] Studio/admin config surfaces reflect the new Deepgram and Ultravox fields

**Test Strategy**:

- Unit: modeled S2S set and partial-provider messaging
- Manual: provider-specific Studio/admin field rendering

**Rollback**: Restore prior warning copy and field definitions.

---

### Phase 2: Runtime Provider-Aware S2S Adapter

**Goal**: Move provider-specific S2S bootstrap/tool/event behavior out of the OpenAI-only assumption path.

**Tasks**:
2.1 Add provider-family resolution and trace-provider mapping
2.2 Build provider-native llm payloads for ElevenLabs, Deepgram, and Ultravox
2.3 Build provider-native tool result/error messages
2.4 Translate provider-native realtime events into internal event shapes
2.5 Add focused adapter tests

**Files Touched**:

- `apps/runtime/src/services/voice/korevg/s2s-provider-adapter.ts`
- `apps/runtime/src/__tests__/s2s-provider-adapter.test.ts`

**Exit Criteria**:

- [x] Adapter unit tests pass
- [x] Provider-aware payload builders cover the modeled non-OpenAI providers
- [x] Tool result/error serialization is provider-native for those providers
- [x] Event translation covers transcript and barge-in behavior

**Test Strategy**:

- Unit: provider-aware payloads, tool envelopes, event translation, transcript accumulation

**Rollback**: Remove the adapter and restore the previous router-local provider handling.

---

### Phase 3: KoreVG Router Wiring and Runtime Guardrails

**Goal**: Route S2S telephony through provider-aware behavior without breaking existing Google/Grok/OpenAI flows.

**Tasks**:
3.1 Make `korevg-router.ts` delegate provider-aware payload creation to the adapter
3.2 Use provider-aware tool result/error serialization
3.3 Use translated provider-native events for non-OpenAI providers
3.4 Prevent invalid inline OpenAI `session.update` behavior for providers that do not support it
3.5 Update router regression coverage where possible

**Files Touched**:

- `apps/runtime/src/services/voice/korevg/korevg-router.ts`
- `apps/runtime/src/__tests__/channels/korevg-router.test.ts`

**Exit Criteria**:

- [x] Focused adapter tests pass
- [x] Router code no longer assumes OpenAI-style bootstrap/logging for every modeled provider
- [ ] Router integration suite runs clean in this worktree
- [x] Partial-provider warning copy matches the remaining runtime limitation

**Test Strategy**:

- Integration: `korevg-router.test.ts` under the integration Vitest config

**Rollback**: Restore the previous router path and keep the shared S2S provider matrix unchanged.

---

## 4. Wiring Checklist

- [x] Shared registry exports the modeled S2S provider set and support messaging
- [x] Studio/admin uses provider-specific field metadata for Deepgram and Ultravox
- [x] KoreVG router imports the provider-aware adapter
- [x] Router uses provider-aware tool result and error messages
- [x] Router uses translated provider-native realtime events
- [x] Partial-provider warning copy reflects the remaining inline handoff limitation
- [ ] Router integration suite passes in this worktree

---

## 5. Cross-Phase Concerns

### Database Migrations

None.

### Feature Flags (if applicable)

None.

### Configuration Changes

No new environment variables. The story only widens the provider-specific config fields already persisted in service-instance config.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] ABL keeps the modeled S2S provider set centralized in the shared registry
- [x] Studio/admin/provider config surfaces reflect the modeled S2S providers that need special fields
- [x] Runtime builds provider-native payloads, tool outputs, and event translations for the modeled non-OpenAI providers
- [x] Partial-provider support messaging is accurate after the runtime upgrade
- [ ] Router integration coverage passes cleanly in this worktree
- [ ] Package-wide builds/tests for touched packages pass cleanly in this worktree
- [x] Feature/test/design docs reflect the actual implementation and blockers

---

## 7. Open Questions

1. Should a follow-up story add full inline handoff/prompt-swap parity for ElevenLabs, Deepgram, and Ultravox?
2. Can the runtime integration-config lane be stabilized in this worktree so router integration coverage counts as executed?
3. Which modeled partial providers need live telephony smoke testing before promotion beyond `ALPHA`?

---

## 8. Post-Implementation Notes (2026-04-23)

- The story shipped in the combined voice-provider branch, so some shared registry and Studio verification overlapped with earlier stories.
- The partial-provider support message was corrected to reflect the real remaining gap after the provider-aware runtime work landed.
- Router integration verification is still partially blocked in this worktree by unrelated package-resolution failures, so the open exit criteria are documented rather than hidden.
