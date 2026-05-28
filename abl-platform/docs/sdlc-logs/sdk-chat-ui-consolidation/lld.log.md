# SDLC Log: SDK Chat UI Consolidation — LLD Phase

**Feature**: sdk-chat-ui-consolidation
**Phase**: LLD
**Date**: 2026-03-25

---

## Oracle Decisions

All 15 questions answered autonomously. No AMBIGUOUS items escalated.

### Implementation Strategy (Q1-Q5)

| #   | Question                    | Classification | Key Decision                                                                                   |
| --- | --------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Q1  | Implementation order?       | ANSWERED       | Bottom-up: L1 transport → L2 ChatClient → L3 components → L4 composition (matches HLD/spec)    |
| Q2  | Phase mapping?              | DECIDED        | 4 phases + 1 follow-on. Merge feature spec phases 2+3 (components + theme/strings are coupled) |
| Q3  | status_update/status_clear? | ANSWERED       | Forward via secondary channel; not in TransportServerMessage but ChatClient still handles them |
| Q4  | ChatInput file upload?      | DECIDED        | Abstract `onUploadFile` callback prop — composition layer provides the implementation          |
| Q5  | Styling approach?           | DECIDED        | CSS custom properties for theming + JS style objects in sdk-styles.ts for component styles     |

### Technical Details (Q6-Q10)

| #   | Question                      | Classification | Key Decision                                                                            |
| --- | ----------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| Q6  | SessionManager import path?   | DECIDED        | Import from `../core/SessionManager.ts`, do NOT move. Re-export from transport/index.ts |
| Q7  | ChatClient upload access?     | DECIDED        | Separate UploadConfig object alongside SDKTransport — keeps transport interface clean   |
| Q8  | AgentProvider with transport? | DECIDED        | Create ChatClient directly when transport prop provided, bypass AgentSDK                |
| Q9  | SDK ChatInput upload pattern? | DECIDED        | Same as Q4: `onUploadFile` callback prop, composition layer provides implementation     |
| Q10 | Backwards compat re-exports?  | DECIDED        | Keep re-exports from old paths for RichContent and RichMessage (deprecated wrapper)     |

### Risk & Dependencies (Q11-Q15)

| #   | Question                 | Classification | Key Decision                                                                                     |
| --- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------ |
| Q11 | Cherry-pick vs clean?    | DECIDED        | Clean implementation; reference commits `06a0c16e5`, `6180e0229` as prior art only               |
| Q12 | WSServerMessage mapping? | ANSWERED       | DefaultTransport translates WSServerMessage → TransportServerMessage (7 mapped types)            |
| Q13 | ThoughtCard sufficiency? | INFERRED       | StudioChatPanel wraps SDK ThoughtCard with Studio-specific props (stores, observatory, variants) |
| Q14 | Test-per-phase mapping?  | DECIDED        | Tests co-located with implementation phase; E2E tests in Phase 4 (cutover)                       |
| Q15 | MessageMetadata risk?    | ANSWERED       | Low for web-sdk/external consumers. Medium for Studio (needs type assertions for extra fields)   |

## Audit Log

### Round 1 — NEEDS_CHANGES (lld-reviewer)

| ID  | Severity | Finding                                                      | Resolution                                            |
| --- | -------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| C-1 | CRITICAL | Phase 4 missing 8 test file consumers of deleted files       | Added exhaustive consumer list in task 4.4            |
| H-1 | HIGH     | i18n bridge missing — Studio regresses to English            | Added useStudioChatStrings() in task 3.3              |
| H-2 | HIGH     | AgentProvider Path B useVoice/useAgent undefined contracts   | Specified exact return shapes for Path B              |
| H-3 | HIGH     | status_update/status_clear via rawMessage breaks abstraction | Added to TransportServerMessage union (D-9 updated)   |
| M-1 | MEDIUM   | React ChatWidget name collides with Web Component            | Documented in D-10, accepted (different entry points) |
| M-2 | MEDIUM   | StudioTransport reads messages for backfill (double-feed)    | Clarified: reads sessionId only, not messages         |
| M-3 | MEDIUM   | E2E test files not specified in Phase 4 tasks                | Added task 4.5 with file paths                        |

### Round 2 — NEEDS_CHANGES (lld-reviewer)

| ID  | Severity | Finding                                                    | Resolution                                              |
| --- | -------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| H-1 | HIGH     | response_end missing content/fullText field                | Added content: string + sourceChannel to response_end   |
| H-2 | HIGH     | auth_response shape wrong (token vs toolCallId+status)     | Fixed to { toolCallId, status } matching wire format    |
| H-3 | HIGH     | Missing action_submit + typed_interrupt in TransportClient | Added both; renamed action_response to action_submit    |
| H-4 | HIGH     | subscribeLiveTranscript needs SessionManager               | Added optional sessionManager 4th param to ChatClient   |
| H-5 | HIGH     | WebSocketContext has no subscription mechanism             | Added task 3.0 — chatMessageEmitter prerequisite        |
| M-1 | MEDIUM   | useVoice Path B wrong field names                          | Fixed to match existing return shape (voiceState, etc.) |
| M-2 | MEDIUM   | HLD OQ-5 inconsistent with D-9                             | Updated HLD OQ-5 to DECIDED                             |
| M-3 | MEDIUM   | ESM .js extension convention not documented                | Added Import Convention section to Cross-Phase Concerns |
| M-4 | MEDIUM   | response_chunk.content → messageChunk.chunk mapping        | Documented in task 1.5                                  |
| M-5 | MEDIUM   | WebSocketContext not in Phase 3 files touched              | Added to Files Touched + Modified Files table           |

### Round 3 — APPROVED (lld-reviewer)

| ID  | Severity | Finding                                              | Resolution                                    |
| --- | -------- | ---------------------------------------------------- | --------------------------------------------- |
| M-1 | MEDIUM   | parseAuthChallengeData not in StudioChatPanel wiring | Added import to task 3.3                      |
| M-2 | MEDIUM   | SDK vs Studio MarkdownContent relationship unclear   | Added note to task 2.9 clarifying coexistence |

All 15 FRs mapped to specific tasks. All file paths verified. All function signatures confirmed.

### Round 4 — NEEDS_REVISION (phase-auditor)

| ID  | Severity | Finding                                                     | Resolution                         |
| --- | -------- | ----------------------------------------------------------- | ---------------------------------- |
| C-1 | CRITICAL | HLD TransportClientMessage diverges from LLD in 3/4 members | Updated HLD Section 6 to match LLD |
| C-2 | CRITICAL | HLD auth_challenge has 2 fields, LLD has 8                  | Updated HLD to full wire format    |
| H-3 | HIGH     | HLD response_end missing content + sourceChannel            | Updated HLD to match LLD           |
| H-5 | HIGH     | WebSocketContext.tsx not in feature spec Section 10         | Added to feature spec              |
| H-7 | HIGH     | Test spec UT-1.4 missing status_update/status_clear         | Added to test spec                 |

### Round 5 — APPROVED (lld-reviewer, final)

| ID  | Severity | Finding                                                      | Resolution                             |
| --- | -------- | ------------------------------------------------------------ | -------------------------------------- |
| M-1 | MEDIUM   | HLD OQ-5 still had old text                                  | Updated to DECIDED with D-9 reference  |
| M-2 | MEDIUM   | Feature spec RichMessage.tsx marked DELETE, should be MODIFY | Changed to MODIFY (deprecated wrapper) |
| L-1 | LOW      | Phase 3 rollback missing WebSocketContext revert             | Updated rollback statement             |

All Round 1-4 fixes verified. Type definitions consistent across all 4 documents. Implementation readiness confirmed.

## Files Created / Updated

- `docs/plans/2026-03-25-sdk-chat-ui-consolidation-impl-plan.md` — full LLD (7 sections, 4 phases + 1 follow-on)
- `docs/specs/sdk-chat-ui-consolidation.hld.md` — type definitions updated for cross-phase consistency
- `docs/features/sub-features/sdk-chat-ui-consolidation.md` — WebSocketContext added, RichMessage status corrected
- `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — UT-1.4 union list updated
