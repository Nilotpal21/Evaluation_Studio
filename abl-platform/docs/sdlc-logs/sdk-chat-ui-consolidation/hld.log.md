# SDLC Log: SDK Chat UI Consolidation — HLD Phase

**Feature**: sdk-chat-ui-consolidation
**Phase**: HLD
**Date**: 2026-03-25

---

## Oracle Decisions

All 15 questions answered autonomously. No AMBIGUOUS items escalated.

### Architecture & Data Flow (Q1-Q5)

| #   | Question              | Classification | Key Decision                                                                   |
| --- | --------------------- | -------------- | ------------------------------------------------------------------------------ |
| Q1  | Architecture pattern? | ANSWERED       | Transport abstraction (SDKTransport interface) with 4-layer architecture       |
| Q2  | Data flow?            | ANSWERED       | Event-driven: transport emits events, ChatClient accumulates, React re-renders |
| Q3  | Expected scale?       | INFERRED       | Client-side only; bounded by ChatClient max messages; <40KB gzipped            |
| Q4  | Existing patterns?    | ANSWERED       | TypedEventEmitter, SessionManager wrap, WebSocketContext subscribe pattern     |
| Q5  | Deployment topology?  | ANSWERED       | No server changes. npm package + Studio build                                  |

### Integration & Dependencies (Q6-Q10)

| #   | Question                | Classification | Key Decision                                                                                 |
| --- | ----------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| Q6  | Existing dependencies?  | ANSWERED       | SessionManager (web-sdk), WebSocketContext (studio), observatory-store, session-store        |
| Q7  | New external deps?      | ANSWERED       | None. Pure internal refactor                                                                 |
| Q8  | API contract?           | ANSWERED       | SDKTransport interface with 7 methods + capabilities. No new HTTP endpoints                  |
| Q9  | Breaking changes?       | INFERRED       | Message.role type widening (additive). MessageMetadata type narrowing (compat via index sig) |
| Q10 | Compile-deploy-execute? | ANSWERED       | Build-time only. pnpm build → tree-shake → bundle                                            |

### Risk & Migration (Q11-Q15)

| #   | Question                | Classification | Key Decision                                                                                  |
| --- | ----------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| Q11 | Biggest technical risk? | INFERRED       | StudioTransport dual delivery (GAP-004) — subscribe-not-intercept pattern resolves it         |
| Q12 | Data migration?         | ANSWERED       | None. No database, no server-side state                                                       |
| Q13 | Rollback strategy?      | ANSWERED       | One-line swap in ChatWithDebugPanel.tsx; old files deleted in separate commit                 |
| Q14 | Feature flags?          | INFERRED       | No flags needed. 6-phase incremental delivery; phases 1-3 are additive, phase 5 is swap       |
| Q15 | Blast radius?           | INFERRED       | Studio chat panel + SDK React consumers. Observatory, session sidebar, debug panel unaffected |

## Audit Log

### Round 1 — NEEDS_REVISION

| ID   | Severity | Finding                                          | Resolution                                                     |
| ---- | -------- | ------------------------------------------------ | -------------------------------------------------------------- |
| HD-6 | CRITICAL | No explicit FR traceability                      | Added §5 Requirement Traceability table mapping FR-1–FR-15     |
| HD-9 | HIGH     | Missing Overview/Goal heading                    | Renamed §1 to "Problem Statement & Goal" with goal paragraph   |
| HD-5 | HIGH     | Test strategy mock boundaries ambiguous          | Expanded Concern #12 with explicit mock boundaries per surface |
| HD-4 | HIGH     | MessageMetadata type narrowing not in Concern #6 | Added as failure mode with mitigation in Concern #6            |
| HD-3 | MEDIUM   | Sequence diagram uses non-standard notation      | Noted, non-blocking (ASCII is accurate)                        |

### Round 2 — APPROVED

| ID   | Severity | Finding                                        | Resolution                                                     |
| ---- | -------- | ---------------------------------------------- | -------------------------------------------------------------- |
| HD-4 | HIGH     | uploadFile on SDKTransport doesn't match code  | Removed from interface; stays on ChatClient.uploadAttachment() |
| HD-5 | HIGH     | status_update/status_clear not in feature spec | Removed from TransportServerMessage; added as open question #5 |
| XP-4 | MEDIUM   | user_message vs chat_message terminology drift | Flagged for test spec correction                               |

### Round 3 — APPROVED (Final)

| ID   | Severity | Finding                                 | Status                                                                   |
| ---- | -------- | --------------------------------------- | ------------------------------------------------------------------------ |
| XP-4 | WARNING  | Cross-phase drift in feature/test specs | Fixed: uploadFile removed from FR-1, chat_message corrected in test spec |

## HLD Summary

| Section | Content                                                                |
| ------- | ---------------------------------------------------------------------- |
| §1      | Problem Statement & Goal                                               |
| §2      | 3 alternatives (shared pkg, transport abstraction, direct SDK)         |
| §3      | Architecture diagrams (system context, component, data flow, sequence) |
| §4      | 12 architectural concerns                                              |
| §5      | FR-1–FR-15 traceability table                                          |
| §6      | Data model (Message, SDKTransport, TransportServerMessage types)       |
| §7      | API design (new + modified exports)                                    |
| §8      | Cross-cutting concerns                                                 |
| §9      | Dependencies (upstream + downstream)                                   |
| §10     | 5 open questions                                                       |
| §11     | References                                                             |

## Files Created / Updated

- `docs/specs/sdk-chat-ui-consolidation.hld.md` — full HLD (11 sections)
- `docs/features/sub-features/sdk-chat-ui-consolidation.md` — FR-1 updated (uploadFile removed), section 12 updated
- `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — INT-1/INT-2 fixed (chat_message), UT-1 fixed (uploadFile removed)
