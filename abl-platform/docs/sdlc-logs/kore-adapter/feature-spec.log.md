# SDLC Log: Kore Adapter — Feature Spec Phase

**Date**: 2026-03-30
**Phase**: Feature Spec (Phase 1 of SDLC pipeline)
**Skill**: `/feature-spec kore-adapter`

---

## Oracle Decisions

All 15 clarifying questions were answered by the product-oracle agent. Zero AMBIGUOUS items — no user escalation needed.

### Scope & Problem (5 questions)

- ANSWERED: Kore SmartAssist is the primary contact center integration for enterprise customers
- ANSWERED: Out of scope includes OAuth auth, polling transport, voice gateway, multi-region failover
- ANSWERED: Enhancement to existing implementation (BETA status)
- INFERRED: Priority driven by enterprise customer requirements
- ANSWERED: No competing approaches — follows established AgentDesktopAdapter pattern

### User Stories & Requirements (5 questions)

- ANSWERED: Primary personas are Studio admin, AI agent (system), end user, SmartAssist agent
- ANSWERED: Critical journeys are connection setup, escalation flow, message relay, session cleanup
- ANSWERED: Must-have: all 22 FRs; nice-to-have: file upload, typing indicators
- INFERRED: Performance targets based on existing SmartAssist timeouts (5s API, 2s message delivery)
- ANSWERED: Interacts with Agent Transfer, Five9 (shared session store), Session Management, Encryption

### Technical & Architecture (5 questions)

- ANSWERED: Packages affected: agent-transfer, runtime, studio
- ANSWERED: No new MongoDB collections; extends ConnectorConnection and Redis session store
- ANSWERED: Security: credential encryption, HMAC verification, SSRF guard, tenant isolation
- ANSWERED: No migration needed — uses existing ConnectorConnection model
- ANSWERED: External dependency on Kore SmartAssist/AgentAssist APIs and KoreServer APIs

## Files Created

| File                                              | Purpose                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `docs/features/sub-features/kore-adapter.md`      | Feature specification (18 sections, 22 FRs)                          |
| `docs/testing/sub-features/kore-adapter.md`       | Testing guide placeholder (coverage matrix, 5 E2E + 5 INT scenarios) |
| `docs/sdlc-logs/kore-adapter/feature-spec.log.md` | This log file                                                        |

## Index Updates

- Added "Kore SmartAssist Agent Transfer Adapter" to `docs/features/sub-features/README.md`
- Added "Kore SmartAssist Agent Transfer Adapter" to `docs/testing/sub-features/README.md`

## Open Questions (carried forward)

1. Webhook secret rotation without downtime
2. check-hours / set-queue tool discoverability in Studio tool catalog
3. Health check endpoint for SmartAssist connectivity validation
4. Multi-region SmartAssist deployment support
5. Conversation history forwarding configurability

## Audit Rounds

### Round 1: APPROVED (2 HIGH, 2 MEDIUM)

- HIGH: XO event count was 17, should be 22 — fixed in 3 locations
- HIGH: Missing Jobs/Workers subsection in Section 10 — added session-recovery-service.ts
- MEDIUM: Test row 14 description clarified for integration classification
- MEDIUM: BETA criteria note added to Testing Notes

### Round 2: APPROVED (2 HIGH)

- HIGH: FR-13 had incorrect mapping example (agent_accepted→agent:joined should be agent:connected) — fixed
- HIGH: Test row 12 still said "17 XO type mappings" — fixed to 22
- Also fixed matching references in testing guide (4 occurrences of "17 XO" → "22 XO")

## Next Phase

Run `/test-spec kore-adapter` to generate the full test specification.
