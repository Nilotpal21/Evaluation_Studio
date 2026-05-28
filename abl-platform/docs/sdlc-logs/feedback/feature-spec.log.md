# Feature Spec Log: Feedback System

**Date**: 2026-03-23
**Phase**: FEATURE-SPEC
**Feature**: Feedback System (comprehensive feedback collection across channels)

---

## Oracle Decisions

15 questions asked across 3 categories (Scope & Problem, User Stories & Requirements, Technical & Architecture). All answered.

| #   | Category  | Question Summary                        | Classification | Decision                                                                                                                                                      |
| --- | --------- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Scope     | What problem does this solve?           | ANSWERED       | Operators lack unified feedback collection across channels. Email CSAT exists but no in-chat thumbs up/down, no text feedback, no analytics dashboard.        |
| Q2  | Scope     | What is out of scope?                   | DECIDED        | NPS surveys, multi-question surveys, A/B testing, feedback-driven agent retraining, SearchAI feedback (separate `feedback_score` in search_queries).          |
| Q3  | Scope     | New capability or enhancement?          | ANSWERED       | Enhancement. Email CSAT exists (ALPHA). Expanding to in-chat thumbs/text, dedicated storage, analytics, Studio UI.                                            |
| Q4  | Scope     | Priority/timeline driver?               | INFERRED       | Production quality gap -- operators cannot measure agent quality without structured feedback. Competitors (Decagon, Sierra) all have feedback dashboards.     |
| Q5  | Scope     | Competing approaches or prior attempts? | ANSWERED       | Existing: email CSAT route, CSAT handler in agent-transfer, eventstore schema supports thumbs/star/text. No prior attempt at unified feedback system.         |
| Q6  | Users     | Primary personas?                       | DECIDED        | End-users (submit feedback), operators/project admins (view analytics), platform admins (configure retention).                                                |
| Q7  | Users     | Critical user journeys?                 | DECIDED        | 5 journeys: in-chat thumbs up/down, in-chat text feedback, email star rating, feedback dashboard in Studio, feedback export for analysis.                     |
| Q8  | Users     | Must-have vs nice-to-have?              | DECIDED        | Must-have: thumbs up/down API, feedback storage, Studio dashboard. Nice-to-have: text feedback, feedback export, per-agent breakdown.                         |
| Q9  | Users     | Performance/scale requirements?         | INFERRED       | Feedback is low-volume relative to messages. Sub-100ms write latency. ClickHouse aggregation for analytics. No real-time requirements.                        |
| Q10 | Users     | Existing feature interactions?          | ANSWERED       | TraceStore (feedback.submitted events), EventStore/ClickHouse (analytics), email adapter (CSAT links), agent-transfer (post-agent CSAT), analytics dashboard. |
| Q11 | Technical | Packages/services affected?             | ANSWERED       | `apps/runtime` (API), `packages/eventstore` (events), `packages/database` (ClickHouse schema), `apps/studio` (UI), `packages/shared-kernel` (types).          |
| Q12 | Technical | Data model changes?                     | DECIDED        | New ClickHouse `feedback` table (not MongoDB -- feedback is append-only analytical data). Reuse eventstore `feedback.submitted` event.                        |
| Q13 | Technical | Security/isolation implications?        | ANSWERED       | Feedback scoped to tenantId + projectId. Public endpoint (email) uses JWT. Authenticated endpoint (in-chat) uses session auth. PII in feedback_text.          |
| Q14 | Technical | Deployment/migration strategy?          | DECIDED        | Additive -- new table, new routes, new UI. No migration of existing data. Email CSAT continues to work unchanged.                                             |
| Q15 | Technical | External dependencies?                  | ANSWERED       | None. All infrastructure (ClickHouse, Redis, MongoDB) already deployed. Eventstore schema already has feedback category.                                      |

## Escalations

None -- all questions resolved without user input.

## Audit Rounds

| Round | Auditor       | Verdict       | Findings                                                                                   |
| ----- | ------------- | ------------- | ------------------------------------------------------------------------------------------ |
| 1     | phase-auditor | NEEDS_CHANGES | 0 CRITICAL, 2 HIGH (missing WebSocket protocol detail, missing retention policy), 3 MEDIUM |
| 2     | phase-auditor | APPROVED      | 0 CRITICAL, 0 HIGH. All findings resolved. Ready for test-spec.                            |

## Audit Round 1 Findings & Resolutions

- **HIGH-1**: WebSocket protocol for in-chat feedback not specified -- Added FR-8 specifying WebSocket message type `feedback.submit` with session-scoped auth
- **HIGH-2**: No retention/TTL policy for feedback data -- Added data lifecycle section with 730-day ClickHouse TTL matching platform_events
- **MEDIUM-1**: Missing error response format for API -- Added error envelope format `{ success: false, error: { code, message } }`
- **MEDIUM-2**: No rate limiting on feedback endpoint -- Added FR-10 for rate limiting
- **MEDIUM-3**: Feedback text PII handling not addressed -- Added PII concern in security section, feedback_text marked as containsPII in eventstore schema

## Files Created

- `docs/features/feedback.md` -- Major feature spec (comprehensive, replacing narrow email-only version)
- `docs/testing/feedback.md` -- Testing guide placeholder
- `docs/sdlc-logs/feedback/feature-spec.log.md` -- This log
