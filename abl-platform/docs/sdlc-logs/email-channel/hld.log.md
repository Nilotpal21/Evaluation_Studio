# Email Channel -- HLD Log

## Phase: HLD

**Date**: 2026-03-23
**Artifact**: `docs/specs/email-channel.hld.md`
**Feature Spec**: `docs/features/email-channel.md`
**Test Spec**: `docs/testing/email-channel.md`

---

## Discovery

### Existing Artifacts Read

- Feature spec: 12 FRs, 7 user stories, 9 gaps
- Test spec: 12 FR coverage matrix, 7 E2E scenarios, 7 integration scenarios
- Existing HLD on develop: 113 lines (basic, missing 12 concerns, alternatives, diagrams)
- All 10 implementation source files read
- Graph API design doc read for transport abstraction details

### Oracle Decisions

| #   | Question                        | Classification | Answer                                                                                                 |
| --- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Preferred architecture pattern? | ANSWERED       | Channel adapter pattern (existing in codebase) with embedded SMTP + pluggable transports               |
| 2   | Data flow model?                | ANSWERED       | Event-driven: SMTP -> parse -> BullMQ -> agent engine -> adapter -> transport                          |
| 3   | Expected scale?                 | INFERRED       | Low-to-medium volume (enterprise email, not bulk marketing); single-instance SMTP sufficient initially |
| 4   | Existing patterns to follow?    | ANSWERED       | ChannelAdapter interface, BullMQ inbound queue, connection resolver                                    |
| 5   | Biggest technical risk?         | DECIDED        | Multi-instance SMTP distribution and pendingConnections Map as process-local state                     |
| 6   | Rollback strategy?              | ANSWERED       | Opt-in per project; disable by removing channel connections; no data migration                         |
| 7   | Feature flags needed?           | DECIDED        | No; channel is activated by creating a connection, deactivated by removing it                          |

---

## Generation Summary

- Expanded from 113 lines (basic HLD) to comprehensive design document
- Added 3 alternatives considered with real trade-off analysis
- Added system context diagram, component diagram, and data flow diagrams (ASCII)
- Addressed all 12 architectural concerns with code-grounded decisions
- Added dependency analysis (10 upstream, 3 downstream)
- Added 7 open questions (up from basic scope notes)
- Cross-referenced all FRs to architectural decisions

---

## Audit Round 1 (Self-audit)

| Severity | Finding                                          | Resolution                                                                                                 |
| -------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| HIGH     | Missing data loss risk when Redis/BullMQ is down | Added to Failure Modes (concern #6): "Redis/BullMQ down: email accepted but not enqueued (data loss risk)" |
| MEDIUM   | Multi-instance SMTP not addressed                | Added Open Question #6 about SMTP distribution across pods                                                 |
| MEDIUM   | No rate limiting for email channel               | Added Open Question #7 and Cross-Cutting Concerns entry                                                    |

## Audit Round 2

| Severity | Finding                                        | Resolution                                                            |
| -------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| LOW      | Diagram could include multimodal service path  | Multimodal service included in system context diagram                 |
| LOW      | No sequence diagram for complex Graph API flow | Added detailed outbound data flow steps covering transport resolution |

## Audit Round 3

All CRITICAL and HIGH findings resolved. Remaining items are LOW/informational.

---

## Files Created

- `docs/specs/email-channel.hld.md` -- High-Level Design document
- `docs/sdlc-logs/email-channel/hld.log.md` -- This log
