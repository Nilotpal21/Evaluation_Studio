# SDLC Log: SDK Chat UI Consolidation — Feature Spec Phase

**Feature**: sdk-chat-ui-consolidation
**Phase**: FEATURE-SPEC
**Date**: 2026-03-25

---

## Oracle Decisions

All 15 questions answered autonomously. No AMBIGUOUS items escalated to user.

### Scope & Problem (Q1-Q5)

| #   | Question                                      | Classification | Key Decision                                                                                                  |
| --- | --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | What problem does dual-implementation create? | ANSWERED       | ~1,300 LOC duplication, streaming protocol parsed in two state machines, thought/handoff/error only in Studio |
| Q2  | What is out of scope?                         | ANSWERED       | Voice UI consolidation, Web Components, SessionSidebar, DebugPanel, Observatory, runtime/backend              |
| Q3  | New capability or refactoring?                | DECIDED        | Primarily refactoring, but unlocks thought cards + handoff + error for SDK consumers, pluggable transport     |
| Q4  | Priority driver?                              | INFERRED       | SDK approaching BETA→STABLE, template surface expanding, consolidation cheaper now than later                 |
| Q5  | Relationship to auth session unification?     | ANSWERED       | Builds on top of it — auth is a prerequisite, consolidation is a follow-on presentation layer                 |

### User Stories & Requirements (Q6-Q10)

| #   | Question                   | Classification | Key Decision                                                                                          |
| --- | -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Q6  | Primary personas?          | DECIDED        | Agent developer (highest risk), SDK consumer (most benefit), platform developer (maintenance)         |
| Q7  | Critical journeys?         | DECIDED        | Studio chat+debug (CRITICAL), customer embed (CRITICAL), preview/share (HIGH), voice (MEDIUM)         |
| Q8  | Must-have vs nice-to-have? | DECIDED        | Transport + shared components + cutover = must-have; theme = nice-to-have; voice refactor = follow-on |
| Q9  | Bundle size constraints?   | INFERRED       | No explicit budget; tree-shakeable via separate entry points; track delta                             |
| Q10 | Omnichannel interaction?   | ANSWERED       | Transport layer only; omnichannel methods stay on AgentSDK; ChatClient.hydrateBackfill() unchanged    |

### Technical & Architecture (Q11-Q15)

| #   | Question                              | Classification | Key Decision                                                                                                                                     |
| --- | ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q11 | Affected packages?                    | ANSWERED       | packages/web-sdk (transport, components, theme) + apps/studio (adapter, StudioChatPanel). Runtime/backend unaffected.                            |
| Q12 | WebSocket reconnection?               | ANSWERED       | Handled inside transport implementations, not in the interface                                                                                   |
| Q13 | Security of Studio importing web-sdk? | DECIDED        | Minimal — Studio already imports from web-sdk; transport keeps auth separate; 'use client' for SSR safety                                        |
| Q14 | Deployment strategy?                  | ANSWERED       | Incremental: SDK additive (steps 1-7) → Studio adapter (steps 8-9) → one-line cutover (step 10) → cleanup (steps 11-13)                          |
| Q15 | Observatory integration?              | ANSWERED       | StudioTransport wraps WebSocketContext (unchanged). Observatory pipeline continues through existing path. ThoughtCard gets onViewTrace callback. |

## Audit Log

### Round 1 — NEEDS_REVISION

| ID  | Severity | Finding                                                          | Resolution                                                      |
| --- | -------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| C1  | CRITICAL | Missing "Routes / Handlers" sub-section in §10                   | Added as N/A with explanation                                   |
| C2  | CRITICAL | AuthChallengeMessage.tsx and SessionHealthBanner.tsx unaccounted | Added as RETAIN in §10, added to non-goals, updated FR-12       |
| C3  | CRITICAL | Message.role type widening is a type-level breaking change       | Documented in FR-5 and Technical Considerations with mitigation |
| H1  | HIGH     | RichContent.tsx marked NEW but exists on develop                 | Changed to MODIFY with explanation                              |
| H2  | HIGH     | No delivery subtask for omnichannel method continuity            | Added subtask 1.8                                               |
| H3  | HIGH     | Vague E2E placeholders in §17                                    | Replaced with 5 concrete multi-step scenarios                   |
| H4  | HIGH     | MarkdownContent in Open Questions but should be scoped           | Resolved OQ-4 as DECIDED, added to §10 and delivery plan        |

### Round 2 — APPROVED

| ID  | Severity | Finding                                                 | Resolution                                             |
| --- | -------- | ------------------------------------------------------- | ------------------------------------------------------ |
| M1  | MEDIUM   | Features README missing SDK Chat UI Consolidation entry | Fixed — added to `docs/features/README.md`             |
| M2  | MEDIUM   | Testing sub-features README missing entry               | Fixed — added to `docs/testing/sub-features/README.md` |
| L3  | LOW      | OQ-1 and GAP-003 overlap                                | Added cross-reference                                  |

## Files Created / Updated

- `docs/features/sub-features/sdk-chat-ui-consolidation.md` — feature spec (15 FRs, 6 user stories)
- `docs/testing/sub-features/sdk-chat-ui-consolidation.md` — testing guide placeholder (16 scenarios)
- Updated `docs/features/sub-features/README.md` — added row
- Updated `docs/features/README.md` — added to Focused Sub-Feature Modules table
- Updated `docs/testing/README.md` — added row 79
- Updated `docs/testing/sub-features/README.md` — added row
