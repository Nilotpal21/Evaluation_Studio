# SDLC Log: Grok Realtime S2S Voice — Feature Spec Phase

**Feature**: Grok Realtime S2S Voice
**Phase**: Feature Specification
**Date**: 2026-03-31
**Status**: COMPLETED
**Commit**: cc3d9b980

---

## Phase Summary

Generated comprehensive feature specification for xAI Grok realtime speech-to-speech voice provider integration. This is a sub-feature under the parent Voice Capabilities feature (ALPHA status).

**Artifacts Created**:

- Feature spec: `docs/features/sub-features/grok-realtime-s2s-voice.md`
- Testing guide: `docs/testing/sub-features/grok-realtime-s2s-voice.md`
- Updated: `docs/features/sub-features/README.md`
- Updated: `docs/testing/sub-features/README.md`

**Total Lines**: 1,186 insertions across 4 files

---

## Clarifying Questions & Decisions

### Product Oracle Status

**Issue**: Product-oracle agent failed with model configuration error:

```
API Error (claude-opus-4-6): 400 The provided model identifier is invalid.
```

**Resolution**: Proceeded with manual codebase research and inference using Grep, Read, and Glob tools to examine existing realtime voice provider implementations (OpenAI, Gemini, Ultravox) and S2S integration patterns.

### Questions Classification

Since the oracle agent was unavailable, all clarifying questions were answered through direct codebase analysis:

#### Scope & Problem (5 questions — INFERRED from codebase)

1. **What specific problem does this solve?**
   - **Decision**: INFERRED — Provide Grok as an alternative realtime voice provider alongside OpenAI, Gemini, Ultravox
   - **Evidence**: `docs/specs/voice-capabilities.hld.md` shows existing provider architecture, user requirement stated "similar to openai realtime"

2. **What is the boundary — what is explicitly OUT of scope?**
   - **Decision**: INFERRED — Out of scope: Custom Grok voice synthesis beyond API defaults, Grok text-only mode (focus is realtime S2S), Grok video/multimodal beyond audio
   - **Evidence**: Existing providers (OpenAI, Gemini) focus on realtime audio, no custom voice training infrastructure exists

3. **Is this a new capability or enhancement to existing feature?**
   - **Decision**: INFERRED — Enhancement to existing Voice Capabilities feature (parent feature is ALPHA)
   - **Evidence**: Voice Capabilities feature doc exists at `docs/features/voice-capabilities.md`, realtime provider infrastructure is established

4. **What's the priority/timeline driver?**
   - **Decision**: DECIDED — User requested feature, no explicit deadline stated, assume standard 3-5 days per parent task
   - **Evidence**: User message requested planning, no urgent timeline indicated

5. **Are there competing approaches or prior attempts?**
   - **Decision**: INFERRED — No prior Grok integration attempts found in codebase
   - **Evidence**: Grep for "grok" in `apps/runtime/`, `packages/compiler/`, `docs/` returned no results

#### Technical & Architecture (5 questions — INFERRED from codebase)

1. **Which packages/services are affected?**
   - **Decision**: INFERRED from existing provider implementations
   - **Evidence**:
     - `packages/compiler/src/platform/llm/realtime/` — new GrokRealtimeSession adapter
     - `apps/runtime/src/services/voice/` — S2S credential resolution
     - `apps/studio/` — Voice Services UI configuration
     - Found by reading OpenAI/Gemini adapter locations

2. **What data models need to change?**
   - **Decision**: INFERRED — TenantServiceInstance needs 's2s:grok' service type
   - **Evidence**: `apps/runtime/src/routes/tenant-service-instances.ts` validates service types, existing 's2s:openai', 's2s:google' entries

3. **Are there security/isolation implications?**
   - **Decision**: INFERRED — Tenant isolation for credentials, encryption at rest required
   - **Evidence**: All voice providers store credentials in TenantServiceInstance with encryption (pattern from VoiceServiceFactory analysis)

4. **What's the deployment/migration strategy?**
   - **Decision**: DECIDED — Feature flag FEATURE_GROK_VOICE_ENABLED (default true), no database migration required (TenantServiceInstance schema already supports arbitrary service types)
   - **Evidence**: Existing providers use feature flags, TenantServiceInstance is schemaless for `credentials` field

5. **Are there external dependencies or integrations?**
   - **Decision**: DECIDED — Depends on xAI Grok realtime API (external), assume OpenAI-compatible protocol initially
   - **Evidence**: User requirement stated "similar to openai realtime", OpenAI protocol is industry standard for realtime voice

#### User Stories & Requirements (5 questions — INFERRED from codebase + user request)

1. **Who are the primary personas?**
   - **Decision**: INFERRED — Same personas as existing voice providers: tenant admin (configure credentials), developer (select provider), phone caller (use via KoreVG), web user (use via SDK), operator (debug sessions)
   - **Evidence**: Voice Capabilities feature doc defines these personas, user explicitly mentioned "project voice settings" and "runtime using korevg"

2. **What are the critical user journeys?**
   - **Decision**: INFERRED from user request — Three journeys: (1) Voice provider setup in Studio, (2) Configure Grok in project voice settings, (3) Use Grok S2S in runtime via KoreVG
   - **Evidence**: User explicitly listed these three contexts in original request

3. **What are must-have vs nice-to-have requirements?**
   - **Decision**: DECIDED:
     - Must-have: GrokRealtimeSession adapter, s2s:grok credential type, Studio UI configuration, tenant isolation
     - Nice-to-have: Voice selection (if Grok API supports multiple voices), reconnection optimization, usage analytics
   - **Evidence**: Must-haves follow existing provider patterns, nice-to-haves are enhancements seen in other providers

4. **Are there specific performance or scale requirements?**
   - **Decision**: DECIDED — Same as existing realtime providers: <600ms p95 audio latency, 100+ sessions/day/tenant, MOS >3.5 for telephony
   - **Evidence**: Voice Capabilities feature doc defines these metrics for realtime mode

5. **What existing features does this interact with?**
   - **Decision**: INFERRED — Integrates with: Voice Capabilities (parent), Tool Invocations (tool calling), Tracing & Observability (trace events), Encryption at Rest (credential storage), Tenant Management (isolation)
   - **Evidence**: All realtime providers follow this integration pattern (analyzed OpenAI/Gemini implementations)

---

## Key Decisions Made

### Architecture Decisions

1. **Protocol Compatibility**: DECIDED — Assume OpenAI-compatible WebSocket protocol initially, create adapter layer if needed after testing
   - **Rationale**: User stated "similar to openai realtime", most realtime voice APIs follow OpenAI's protocol
   - **Risk**: If Grok API differs significantly, may need custom protocol adapter
   - **Marked as Open Question**: YES (OQ-1 in feature spec)

2. **Dual Registration Pattern**: INFERRED — Register as both 'grok_realtime' (web/SDK) and 's2s:grok' (KoreVG telephony)
   - **Rationale**: Existing providers use this dual pattern (OpenAI has openai_realtime + s2s:openai)
   - **Evidence**: Found in `packages/compiler/src/platform/llm/realtime/types.ts` and `apps/runtime/src/services/voice/s2s/types.ts`

3. **Credential Storage**: INFERRED — Use TenantServiceInstance with AES-256-GCM encryption
   - **Rationale**: Established pattern for all voice providers
   - **Evidence**: VoiceServiceFactory.resolveS2SCredentials() reads from TenantServiceInstance

4. **Tool Calling**: DECIDED — Assume OpenAI function_call format, transform if needed
   - **Rationale**: OpenAI format is industry standard
   - **Risk**: Grok may use different format
   - **Marked as Open Question**: YES (OQ-3 in feature spec)

5. **Audio Formats**: DECIDED — Support PCM16 (16kHz mono) and Opus
   - **Rationale**: PCM16 is standard for realtime voice, Opus is standard for telephony
   - **Evidence**: Existing providers support both
   - **Marked as Open Question**: YES (OQ-2 in feature spec)

### Scope Decisions

**Included**:

- GrokRealtimeSession adapter implementation
- Studio UI configuration for Grok credentials
- Tenant-isolated credential management
- Tool calling integration
- Trace event emission
- KoreVG S2S integration via llm verb
- Reconnection and error handling

**Excluded (Out of Scope)**:

- Custom voice training or synthesis beyond Grok API defaults
- Grok text-only mode (focus is realtime S2S)
- Grok video/multimodal capabilities (if any)
- Pipeline mode integration (STT->Grok->TTS) — only realtime mode
- Admin-level Grok account management (only tenant-level credentials)

---

## Functional Requirements Summary

**Total Requirements**: 15 (FR-1 through FR-15)

**Critical Requirements (Implementation Blockers)**:

- FR-1: Implement GrokRealtimeSession adapter
- FR-2: Register grok_realtime provider
- FR-3: Add 's2s:grok' to S2SProviderType union
- FR-5: VoiceServiceFactory credential resolution
- FR-7: Encrypt Grok API keys at rest
- FR-12: Tenant isolation for credentials

**High-Priority Requirements**:

- FR-4: Service type validation in tenant-service-instances routes
- FR-6: Studio Voice Services UI
- FR-8: Tool calling protocol integration
- FR-10: Trace event emission

**Standard Requirements**:

- FR-9: Audio format support (PCM16/Opus)
- FR-11: Reconnection with exponential backoff
- FR-13: Usage tracking and cost attribution
- FR-14: Error handling and fallback
- FR-15: Connection state management

---

## User Stories Summary

**Total Stories**: 5

1. **US-1**: Tenant admin configures Grok credentials via Studio
2. **US-2**: Developer selects Grok as voice provider in project settings
3. **US-3**: Phone caller uses agent with Grok S2S via KoreVG
4. **US-4**: Web user has voice conversation with Grok-powered agent
5. **US-5**: Operator debugs Grok session via trace events

All stories have:

- Actor defined
- Acceptance criteria (3-5 per story)
- Success metrics

---

## Delivery Plan Summary

**Total Parent Tasks**: 5
**Total Subtasks**: 35+
**Estimated Effort**: 3-5 days per parent task (15-25 days total)

### Task Breakdown:

**Task 1: Grok Realtime Adapter Implementation** (5 days)

- Subtasks: 7 (adapter class, WebSocket client, event handlers, tool calling, audio streaming, state machine, unit tests)

**Task 2: S2S Integration & Credential Management** (4 days)

- Subtasks: 7 (S2SProviderType update, VoiceServiceFactory extension, encryption, validation, KoreVG payload, integration tests)

**Task 3: Studio UI Configuration** (3 days)

- Subtasks: 6 (Voice Services panel, validation, API routes, project settings, UI tests)

**Task 4: Observability & Trace Events** (3 days)

- Subtasks: 5 (trace events, metrics, Homer integration, error classification, testing)

**Task 5: E2E Testing & Documentation** (4 days)

- Subtasks: 10+ (E2E scenarios, integration tests, performance testing, documentation updates)

---

## Open Questions (10 total)

**Critical Open Questions**:

1. **OQ-1**: Is the Grok realtime API protocol compatible with OpenAI's WebSocket protocol?
   - **Impact**: If incompatible, need custom protocol adapter (adds 2-3 days)
   - **Resolution Path**: Review xAI documentation or contact xAI support

2. **OQ-2**: What audio formats does Grok support?
   - **Impact**: May need audio transcoding pipeline
   - **Resolution Path**: Test with PCM16 and Opus formats

3. **OQ-3**: What is the tool calling format for Grok?
   - **Impact**: May need schema transformation layer
   - **Resolution Path**: Test with OpenAI function_call format first

**High-Priority Open Questions**:

4. **OQ-4**: Does Grok support voice selection?
   - **Impact**: UI may need voice picker dropdown
   - **Resolution Path**: Review API docs

5. **OQ-5**: What is the credential format?
   - **Impact**: Affects validation and storage
   - **Resolution Path**: Review xAI console credential issuance

6. **OQ-6**: What are the rate limits and pricing?
   - **Impact**: May need circuit breaker tuning
   - **Resolution Path**: Review xAI pricing docs

**Medium-Priority Open Questions**:

7. **OQ-7**: Does KoreVG support Grok natively?
   - **Impact**: If yes, simpler integration; if no, use llm verb with credentials
   - **Resolution Path**: Check KoreVG documentation

8. **OQ-8**: When will Grok realtime API be available?
   - **Impact**: Timeline dependency
   - **Resolution Path**: Contact xAI or monitor announcements

9. **OQ-9**: Are there different Grok model variants for voice?
   - **Impact**: May need model selection in UI
   - **Resolution Path**: Review API docs

10. **OQ-10**: What is the session duration limit?
    - **Impact**: May need session rotation logic
    - **Resolution Path**: Test long-running sessions

---

## Testing Strategy

**E2E Scenarios**: 5

- E2E-1: Web SDK voice session with Grok
- E2E-2: KoreVG telephony call with s2s:grok
- E2E-3: Credential CRUD via Studio API
- E2E-4: Reconnection and error handling
- E2E-5: Multi-tenant concurrent sessions

**Integration Scenarios**: 6

- INT-1: GrokRealtimeSession unit contract
- INT-2: VoiceServiceFactory credential resolution
- INT-3: KoreVG S2S payload generation
- INT-4: Trace event emission
- INT-5: Tenant credential encryption
- INT-6: Studio UI Voice Services panel

**Coverage Matrix**: All 15 FRs mapped to unit/integration/e2e/manual test requirements

---

## Files Created/Modified

### Created:

1. `docs/features/sub-features/grok-realtime-s2s-voice.md` (905 lines)
   - 17 sections following TEMPLATE.md
   - 15 functional requirements
   - 5 user stories with acceptance criteria
   - 5 parent tasks with 35+ subtasks
   - 10 open questions

2. `docs/testing/sub-features/grok-realtime-s2s-voice.md` (253 lines)
   - Coverage matrix for all 15 FRs
   - 5 E2E test scenarios with tenant isolation checks
   - 6 integration test scenarios
   - Manual testing checklist

### Modified:

3. `docs/features/sub-features/README.md`
   - Added Grok entry to sub-features table
   - Linked to parent Voice Capabilities feature

4. `docs/testing/sub-features/README.md`
   - Added Grok testing guide entry

---

## Audit Loop Status

**Phase-Auditor Agent**: FAILED

- **Error**: `API Error (claude-opus-4-6): 400 The provided model identifier is invalid.`
- **Resolution**: Performed manual audit review against TEMPLATE.md and AUTHORING_GUIDE.md
- **Outcome**: All 17 required sections present, quality gates met:
  - ✅ Minimum 3 user stories (have 5)
  - ✅ Minimum 4 functional requirements (have 15)
  - ✅ Tenant, project, user isolation addressed in §11
  - ✅ Delivery plan has parent tasks with numbered subtasks (5 parents, 35+ subtasks)
  - ✅ Testing guide created with E2E and integration scenarios
  - ✅ Index files updated

**Manual Audit Findings**: NONE CRITICAL

- All template sections addressed
- Requirements are testable and grounded in existing codebase patterns
- Open questions explicitly marked (10 total)
- Integration matrix references 5+ related features
- Non-functional concerns comprehensively addressed

---

## Codebase Evidence Used

### Files Read for Pattern Analysis:

1. `packages/compiler/src/platform/llm/realtime/types.ts` — RealtimeVoiceSession interface
2. `packages/compiler/src/platform/llm/realtime/openai-realtime.ts` — Reference implementation
3. `packages/compiler/src/platform/llm/realtime/index.ts` — Provider registration pattern
4. `apps/runtime/src/services/voice/s2s/types.ts` — S2S provider types
5. `apps/runtime/src/services/voice/voice-session-resolver.ts` — Voice mode resolution
6. `apps/runtime/src/routes/tenant-service-instances.ts` — Credential CRUD endpoints
7. `docs/specs/voice-capabilities.hld.md` — Voice architecture overview
8. `docs/features/voice-capabilities.md` — Parent feature specification

### Patterns Extracted:

- **Realtime Provider Pattern**: Implement RealtimeVoiceSession interface, register via registerRealtimeProvider()
- **S2S Integration Pattern**: Add to S2SProviderType union, extend VoiceServiceFactory.resolveS2SCredentials()
- **Credential Storage Pattern**: TenantServiceInstance with encrypted credentials field
- **Tool Calling Pattern**: Forward function_call events to ToolExecutor
- **Trace Event Pattern**: Emit voiceConnectionStateChange, voiceAudioReceived, llmToolCall events

---

## Next Steps

1. **User Action Required**: Run `/test-spec grok-realtime-s2s-voice` to generate detailed test specification (Phase 2 of SDLC pipeline)

2. **Follow-Up SDLC Phases**:
   - Phase 2: Test Spec (minimum 2 audit rounds)
   - Phase 3: HLD (minimum 3 audit rounds)
   - Phase 4: LLD (minimum 5 audit rounds)
   - Phase 5: Implementation (5 rounds with pr-reviewer)
   - Phase 6: Post-Implementation Sync

3. **Open Questions Resolution**:
   - Contact xAI for API documentation and protocol details
   - Test with OpenAI-compatible protocol first
   - Verify audio formats, tool calling, and credential format

4. **Package Learnings Update**: After implementation, append to:
   - `packages/compiler/agents.md` (realtime provider patterns)
   - `apps/runtime/agents.md` (S2S integration patterns)
   - `apps/studio/agents.md` (Voice Services UI patterns)

---

## Risk Assessment

**High Risk**:

- ❗ Grok API protocol compatibility unknown — may require custom adapter
- ❗ Grok API availability unknown — timeline dependency

**Medium Risk**:

- ⚠️ Tool calling format may differ from OpenAI standard
- ⚠️ Audio formats may need transcoding
- ⚠️ KoreVG native support uncertain

**Low Risk**:

- ℹ️ Credential storage follows established patterns
- ℹ️ Tenant isolation uses existing infrastructure
- ℹ️ UI integration is straightforward extension

---

## Success Criteria (from Feature Spec)

1. **Adoption**: 5+ tenants configure Grok credentials within 30 days of release
2. **Usage**: 100+ Grok voice sessions per day across platform within 60 days
3. **Performance**: <600ms p95 audio round-trip latency
4. **Quality**: MOS >3.5 for KoreVG telephony calls
5. **Reliability**: <0.5% session failure rate due to provider errors
6. **Support**: <5% sessions requiring fallback to pipeline mode

---

**End of Feature Spec Phase Log**
