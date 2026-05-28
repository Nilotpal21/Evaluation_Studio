# Test Specification: Voice S2S Provider Parity

**Feature Spec**: `docs/features/sub-features/voice-s2s-provider-parity.md`
**HLD**: `docs/specs/voice-s2s-provider-parity.hld.md`
**LLD**: `docs/plans/2026-04-23-voice-s2s-provider-parity-impl-plan.md`
**Status**: PARTIAL (ALPHA)
**Last Updated**: 2026-04-23

---

## 1. Coverage Matrix

| FR   | Description                                                                            | Unit | Integration | E2E | Manual | Status  |
| ---- | -------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1 | Shared registry stays authoritative for modeled S2S providers and capability messaging | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-2 | Studio/admin exposes provider-specific S2S config fields                               | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-3 | Runtime builds provider-native llm-verb payloads                                       | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-4 | Runtime sends provider-native tool result and error envelopes                          | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-5 | Provider-native events translate into internal realtime events                         | ✅   | ❌          | ❌  | ❌     | PASS    |
| FR-6 | Runtime trace/provider metadata uses provider-specific context                         | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-7 | Non-OpenAI providers avoid invalid inline OpenAI handoff behavior                      | ❌   | ❌          | ❌  | ✅     | PARTIAL |
| FR-8 | Partial-provider capability messaging stays accurate                                   | ✅   | ❌          | ❌  | ❌     | PASS    |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through HTTP or full browser interaction. No mocks, no direct DB access, no stubbed internal servers.

### E2E-1: Tenant admin configures a modeled non-OpenAI S2S provider

- **Preconditions**: Studio and runtime running; authenticated tenant admin
- **Steps**:
  1. Open Admin → Voice Services
  2. Create a provider such as Deepgram Voice Agent or Ultravox
  3. Reload the page and reopen the saved provider
- **Expected Result**: Provider-specific config fields persist and rehydrate correctly
- **Auth Context**: Tenant admin
- **Isolation Check**: Only tenant-scoped service instances are visible

### E2E-2: Channel S2S config renders provider-specific fields

- **Preconditions**: Tenant has an active S2S provider
- **Steps**:
  1. Open a voice deployment/channel config surface
  2. Select Deepgram or Ultravox
  3. Inspect the rendered config fields
- **Expected Result**: Deepgram shows think/listen/voice fields and Ultravox shows model/temperature/optional agent id
- **Auth Context**: Project member with channel edit access
- **Isolation Check**: Only active tenant providers appear

### E2E-3: Runtime telephony session with a partial provider completes the baseline provider-aware path

- **Preconditions**: Runtime/KoreVG path running; valid modeled provider credentials
- **Steps**:
  1. Start a telephony session with `s2s:deepgram`, `s2s:elevenlabs`, or `s2s:ultravox`
  2. Speak a user utterance and trigger at least one tool
  3. Observe traces and speech output
- **Expected Result**: Provider-native payload/tool/event handling works for the baseline conversation path
- **Auth Context**: Telephony/runtime session
- **Isolation Check**: Session remains scoped to the configured tenant/project

### E2E-4: Partial-provider warning remains visible and accurate

- **Preconditions**: Studio running with the updated shared registry
- **Steps**:
  1. Open the S2S provider selection surface
  2. Select `s2s:deepgram`, `s2s:elevenlabs`, or `s2s:ultravox`
- **Expected Result**: The warning references the remaining inline handoff/prompt-swap limitation rather than claiming the whole telephony path is unavailable
- **Auth Context**: Tenant admin or project editor
- **Isolation Check**: Not applicable beyond normal provider scoping

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Shared registry helper outputs include the modeled S2S set and capability messaging

- **Boundary**: `packages/config` registry constants → helper exports
- **Setup**: Import the registry helper functions directly
- **Steps**:
  1. Assert the modeled S2S provider set
  2. Assert `full` vs `partial` capability flags
  3. Assert the partial-support message references inline handoff/prompt-swap limitations
- **Expected Result**: Shared helper outputs match the intended ABL support contract
- **Failure Mode**: UI/runtime capability drift

### INT-2: Provider-aware adapter normalizes representative modeled providers

- **Boundary**: `s2s-provider-adapter.ts`
- **Setup**: Provide representative S2S config snapshots and prompt tools
- **Steps**:
  1. Build an ElevenLabs payload
  2. Build a Deepgram Voice Agent payload
  3. Build an Ultravox payload
- **Expected Result**: Runtime emits provider-native llm payloads rather than an OpenAI-only shape
- **Failure Mode**: KoreVG sends malformed provider bootstraps

### INT-3: Provider-aware tool result envelopes serialize correctly

- **Boundary**: `s2s-provider-adapter.ts`
- **Setup**: Provide representative tool call ids/results
- **Steps**:
  1. Build tool result payloads for ElevenLabs, Ultravox, and Deepgram
  2. Build error payloads for the same providers
- **Expected Result**: Provider-native tool envelopes are emitted correctly
- **Failure Mode**: Providers fail to complete tool-call cycles

### INT-4: Provider-native events translate to internal realtime events

- **Boundary**: `s2s-provider-adapter.ts`
- **Setup**: Provide representative ElevenLabs, Deepgram, and Ultravox event payloads
- **Steps**:
  1. Translate user transcript events
  2. Translate assistant transcript events
  3. Translate barge-in / playback-clear events
- **Expected Result**: Internal realtime transcript/barge-in/turn event shapes are produced
- **Failure Mode**: Voice traces or persisted transcripts go missing

### INT-5: KoreVG router uses provider-aware runtime behavior

- **Boundary**: `korevg-router.ts` integration suite
- **Setup**: Run `src/__tests__/channels/korevg-router.test.ts` under the integration Vitest config
- **Steps**:
  1. Exercise Deepgram conversation text event translation
  2. Exercise ElevenLabs tool-result handling and non-OpenAI handoff behavior
- **Expected Result**: Router uses provider-aware behavior end-to-end
- **Failure Mode**: Provider-aware runtime logic exists on disk but is not actually wired

**Current Status**: Test file exists, but the correct integration-config lane is currently blocked in this worktree by pre-existing package-resolution failures.

---

## 4. Unit Test Scenarios

### UT-1: S2S provider family mapping is deterministic

- **Module**: `s2s-provider-adapter.ts`
- **Input**: Modeled S2S provider ids
- **Expected Output**: Providers map to the correct runtime family and trace provider label

### UT-2: Partial-provider support messaging stays accurate

- **Module**: `voice-providers.ts`
- **Input**: Shared registry metadata
- **Expected Output**: Partial providers remain partial and the warning names the real remaining limitation

### UT-3: Ultravox transcript accumulation handles multi-event turn assembly

- **Module**: `s2s-provider-adapter.ts`
- **Input**: Multiple Ultravox transcript fragments and playback-clear events
- **Expected Output**: Accumulated transcripts and barge-in signals normalize correctly

---

## 5. Security & Isolation Tests

- Cross-tenant service-instance access remains blocked for modeled S2S providers
- Runtime validation still rejects unsupported `serviceType` values
- Provider-native event translation does not bypass existing trace-store or persistence boundaries
- Partial-support messaging remains honest about unsupported inline handoff behavior

---

## 6. Performance & Load Tests (if applicable)

Not applicable for this story. The work changes provider-specific payload shaping and event normalization, not a new load profile or scaling path.

---

## 7. Test Infrastructure

- **Required services**: Runtime and Studio for manual/E2E checks; Vitest for unit/integration checks
- **Data seeding**: Prefer existing service-instance API flows for manual setup
- **Environment variables**: Existing S2S/KoreVG voice test env only
- **CI configuration**: Unit tests run in the regular package lane; `korevg-router` requires the integration Vitest config

---

## 8. Test File Mapping

| Test File                                                   | Type             | Covers           |
| ----------------------------------------------------------- | ---------------- | ---------------- |
| `packages/config/src/__tests__/voice-providers.test.ts`     | unit             | FR-1, FR-8       |
| `apps/runtime/src/__tests__/s2s-provider-adapter.test.ts`   | unit             | FR-3, FR-4, FR-5 |
| `apps/runtime/src/__tests__/channels/korevg-router.test.ts` | integration      | FR-6, FR-7       |
| `apps/studio/src/__tests__/s2s-provider-selector.test.tsx`  | unit/integration | FR-1, FR-8       |
| `apps/studio/src/__tests__/voice-services.test.ts`          | unit/integration | FR-1             |

---

## 9. Open Testing Questions

1. Can we stabilize the runtime integration-config lane in this worktree so `korevg-router.test.ts` counts as executed coverage instead of blocked coverage?
2. Which modeled partial providers need live telephony smoke validation before the story can move beyond `ALPHA`?
3. Do we want dedicated Studio tests for provider-specific Deepgram and Ultravox field rendering?
