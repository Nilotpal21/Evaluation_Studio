# SDLC Log: AI4W-ABL Channel Integration — Feature Spec

**Phase**: Feature Spec
**Date**: 2026-04-16
**Status**: COMPLETE

## Oracle Decisions

### Scope & Problem

| #   | Question                      | Classification | Answer Summary                                                        |
| --- | ----------------------------- | -------------- | --------------------------------------------------------------------- |
| S1  | What problem does this solve? | INFERRED       | AI4W can't invoke ABL agents; users duplicate logic between platforms |
| S2  | Scope boundary                | DECIDED        | P0 = sync + auth + sessions. P1-P6 progressively add capabilities     |
| S3  | New or enhancement?           | ANSWERED       | New capability — no existing `ai4w` or `ablAgent` in either codebase  |
| S4  | Timeline                      | AMBIGUOUS      | No timeline stated — captured as Open Question #1                     |
| S5  | A2A vs custom HTTP            | DECIDED        | Hybrid: custom HTTP REST for P0, A2A optional for later               |

### User Stories & Requirements

| #   | Question                  | Classification | Answer Summary                                                                 |
| --- | ------------------------- | -------------- | ------------------------------------------------------------------------------ |
| U1  | Personas                  | INFERRED       | 4 personas: AI4W admin, AI4W user, ABL admin, ABL agent designer               |
| U2  | User journeys             | INFERRED       | 5 critical: provisioning, discovery, sync chat, agent transfer, human approval |
| U3  | Must-have vs nice-to-have | DECIDED        | P0-P6 priority ordering confirmed                                              |
| U4  | Performance/scale         | INFERRED       | ABL's 100 req/min tenant limit applies naturally                               |
| U5  | Feature interactions      | ANSWERED       | Channels, A2A, Auth Profiles, Circuit Breaker, Webhook, Rate Limiting          |

### Technical & Architecture

| #   | Question              | Classification | Answer Summary                                                               |
| --- | --------------------- | -------------- | ---------------------------------------------------------------------------- |
| T1  | Packages affected     | INFERRED       | ABL: runtime, database, studio. AI4W: AgentsService, new ABLGatewayService   |
| T2  | Data model changes    | INFERRED       | ABL: new channel_connections docs. AI4W: new ablAgent type + abl_connections |
| T3  | Security/isolation    | INFERRED       | JWT/JWKS trust, composite session key, SSRF allowlist, encrypted credentials |
| T4  | Deployment strategy   | DECIDED        | Zero-migration, additive. ABL first (passive), AI4W second (active)          |
| T5  | External dependencies | INFERRED       | Same-VPC connectivity, JWKS endpoints, no new npm deps needed                |

## Audit Rounds

### Round 1: NEEDS_REVISION

- 2 CRITICAL: Invented `MultimodalServiceClient.uploadFromUrl()`, `PendingDeliveryStore` (auditor error — it exists)
- 5 HIGH: Status mismatches (Auth Profiles, Rate Limiting), FR-4 key inconsistency, FR-9 RBAC, AI4W isolation missing, no exit criteria
- 3 MEDIUM: WebSocket non-goal, RichContentIR grounding, coverage expectations
- All fixed

### Round 2: APPROVED

- 2 HIGH: Auth middleware clarification, email delimiter collision — both fixed
- 3 MEDIUM: Phase annotations on tests, KoraNotificationService clarification, subtask 1.6 shorthand — captured for HLD

## Files Created

- `docs/features/ai4w-abl-channel-integration.md` — Feature spec
- `docs/testing/ai4w-abl-channel-integration.md` — Testing guide placeholder
- `docs/sdlc-logs/ai4w-abl-channel-integration/feature-spec.log.md` — This log

## Files Updated

- `docs/features/README.md` — Added to P2 table (#93)
- `docs/testing/README.md` — Added to P2 table (#93)

## Expert Architect Review (2026-04-17)

### Resolved Concerns

| #   | Concern                                                     | Resolution                                                                                                                                                                                    |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Why not use existing aaAgent + ABL chat API (zero changes)? | Custom channel justified: simplified UX, protocol abstraction, user-identity trust, platform convergence path, proactive delivery. Added to §7.                                               |
| 2   | Dual-session / history duplication                          | Intentional. AI4W = orchestration source of truth (cross-platform). ABL = execution source of truth (agent context). AI4W sends history on each request. Added Session Ownership Model to §7. |
| 3   | Internal-only API security                                  | Deferred to P4 scope. Options documented: separate port (preferred) + service token for provisioning. Added to §7.                                                                            |
| 4   | Circuit breaker too coarse                                  | Fixed: scoped per `connectionId` not per channel type. Updated FR-14.                                                                                                                         |
| 5   | Response mode fallback                                      | Added fallback order (stream→sync, async→sync) + `X-Response-Mode-Used` header. Added to §7.                                                                                                  |
| 6   | Signed URL expiry in async                                  | Download at ingestion time, not execution time. AI4W sets expiry to ABL session timeout. Added to §7.                                                                                         |
| 7   | Proactive notification error contract                       | Defined: 200/404/409/410/429 with fallback to email channel. Added to §7.                                                                                                                     |
| 8   | Cross-env is different architecture                         | Noted: P6 may warrant separate mini-spec. Added to Open Question #3.                                                                                                                          |

## Open Questions (for next phase)

1. Target delivery date for P0
2. `ablAgent` vs `ablPlatformAgent` naming
3. Cross-env trust establishment mechanism — P6 may warrant separate mini-spec
4. AI4W notification payload exact structure (KoraNotificationService)
5. ABL tenant ↔ AI4W account 1:1 or 1:N mapping
6. SSE vs chunked transfer encoding for streaming
7. Internal API port strategy (separate port vs middleware)
8. Platform convergence roadmap — thin shim vs durable surface
