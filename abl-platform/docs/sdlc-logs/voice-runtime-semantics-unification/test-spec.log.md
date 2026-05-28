# SDLC Log: Voice Runtime Semantics Unification — Test Spec

**Phase**: TEST-SPEC
**Date**: 2026-04-22
**Author**: In-thread repository-grounded draft

## Summary

Generated the test specification with 6 E2E scenarios, 6 integration scenarios, and 5 unit-test scenario groups. The test plan treats pipeline voice as the baseline and focuses coverage on where realtime and bridge voice families can drift: provider event normalization, prompt profile selection, capability gating, canonical result shaping, and family-by-family parity.

## Key Decisions

| ID  | Decision                                                                                                   | Classification |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| D1  | Pipeline voice regression coverage is mandatory before any realtime convergence claim                      | ANSWERED       |
| D2  | Realtime providers with immutable mid-call state get explicit partial-path coverage, not hidden exclusions | DECIDED        |
| D3  | E2E scope must include SDK voice, Twilio voice, LiveKit, and at least one bridge family                    | DECIDED        |
| D4  | Provider event normalization belongs in integration tests at the provider adapter boundary                 | INFERRED       |
| D5  | Shadow/enforce divergence needs dedicated validation before rollout                                        | DECIDED        |

## Coverage Analysis

### E2E Scenarios (6)

1. SDK voice pipeline baseline parity
2. SDK voice realtime tool-call and handoff parity
3. SDK voice realtime immutable-provider capability drop
4. Twilio voice pipeline `voice_config` + outcome normalization
5. LiveKit voice semantic parity with prompt-profile diagnostics
6. Bridge-family explicit partials and canonical supported constructs

### Integration Scenarios (6)

1. OpenAI Realtime normalized-event mapping
2. Gemini/Ultravox capability profile behavior
3. Prompt profile resolution from canonical runtime inputs
4. Realtime executor canonical prompt/tool refresh
5. Voice turn coordinator canonical result shape
6. Compiler -> runtime construct parity audit

### Major Gaps Identified

- No explicit construct-by-family parity suite exists today for voice DSL semantics.
- Realtime provider tests cover mechanics but not end-to-end semantic parity.
- There is no current shadow-vs-enforce divergence validation for voice runtime behavior.

## Quality Checklist

- [x] Minimum 5 E2E scenarios (6 provided)
- [x] Minimum 5 integration scenarios (6 provided)
- [x] Security and isolation tests explicitly called out
- [x] Pipeline baseline regression coverage included
- [x] Immutable-provider partial coverage included
- [x] Rollout-mode validation included
