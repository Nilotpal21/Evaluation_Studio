# Audit Round 1: OAuth Tooling (All Phases)

**Date:** 2026-03-23
**Auditor:** Phase Auditor (self-review)
**Artifacts Reviewed:** Feature Spec, Test Spec, HLD, LLD

---

## Findings

| #    | Artifact          | Finding                                                                                                                                                                                                                                                                                                     | Severity | Status                                                                                                                       |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A1-1 | HLD Section 2.4   | Auth Profile resolution described a secret key pattern `oauth2.<connector>.access_token` that does not exist in the codebase. The `RuntimeSecretsProvider` resolves by `secretKey` which is a simple key string. Resolution should use `authProfileId` directly from ProjectTool, not a namespaced pattern. | CRITICAL | **FIXED** -- Updated HLD Section 2.4 to load `authProfileId` from ProjectTool document                                       |
| A1-2 | Feature Spec US-5 | Runtime WebSocket consent flow (session pause/resume) described in US-5 is not covered in any LLD phase. This is a complex feature requiring runtime session lifecycle changes.                                                                                                                             | HIGH     | **FIXED** -- Deferred US-5 to follow-up iteration with explicit note; initial release requires Studio-based token connection |
| A1-3 | LLD Phase 1.5     | Assumed `authProfileId` can be propagated through compiler IR, but the compiler compiles from DSL, not from the ProjectTool API model. `authProfileId` is a Studio API concern not present in DSL.                                                                                                          | CRITICAL | **FIXED** -- Replaced Phase 1.5 with loading from ProjectTool documents at session init in `llm-wiring.ts`                   |
| A1-4 | LLD Wiring W-3    | Referenced `compiler.ts` for `authProfileId` propagation, but compiler doesn't handle this field.                                                                                                                                                                                                           | HIGH     | **FIXED** -- Updated W-3 to reference `llm-wiring.ts` -> `RuntimeSecretsProvider` config                                     |
| A1-5 | Test Spec E2E-4   | E2E test describes "Send a message that triggers the HTTP tool" without specifying how to mock the external API that the tool calls.                                                                                                                                                                        | MEDIUM   | Deferred -- test infrastructure section mentions mock Express server, sufficient for planning                                |
| A1-6 | HLD               | Missing explicit mention of rate limiting on OAuth initiate endpoint                                                                                                                                                                                                                                        | LOW      | Deferred -- existing rate limiting middleware applies to all Studio API routes                                               |
| A1-7 | Feature Spec      | FR-10 connector migration is P1 but depends on Phase 5 which has no hard deadline                                                                                                                                                                                                                           | LOW      | Acceptable -- P1 items are tracked but not blocking                                                                          |

## Summary

- **CRITICAL findings:** 2 found, 2 fixed
- **HIGH findings:** 2 found, 2 fixed
- **MEDIUM findings:** 1 found, deferred (acceptable at planning stage)
- **LOW findings:** 2 found, deferred

All CRITICAL and HIGH findings have been resolved. Artifacts are ready for implementation.
