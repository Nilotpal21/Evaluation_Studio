# Phase 3: HLD — voice-capabilities

**Phase:** High-Level Design
**Date:** 2026-03-22
**Status:** COMPLETE

## Inputs

- Feature spec: `docs/features/voice-capabilities.md`
- Test spec: `docs/testing/voice-capabilities.md`
- RFC: `docs/rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md`
- Codebase: `apps/runtime/src/services/voice/`, `packages/web-sdk/src/voice/`, `packages/compiler/src/platform/`

## Architectural Concerns Addressed

All 12 concerns from the design-quality-gate skill:

1. Resource Isolation (tenant/project/user scoping)
2. Authentication & Authorization (4 auth mechanisms)
3. Stateless Distributed (connection-scoped with Redis/MongoDB backing)
4. Traceability (voice turn traces with phase breakdown)
5. Compliance (always-capture transcripts, configurable retention)
6. Performance (latency budgets, streaming, parallel tools)
7. Error Recovery (reconnect, fallback, graceful degradation)
8. Scalability (horizontal pod scaling, bounded caches)
9. Extensibility (provider interfaces, adapter patterns)
10. Observability Infrastructure (traces, metrics, logging)
11. Configuration Management (env vars, deployment config, IR hints)
12. Deployment & Operations (LiveKit SIP, feature flags, credential rotation)

## Key Decisions

| ID  | Decision                                                         | Classification         |
| --- | ---------------------------------------------------------------- | ---------------------- |
| D1  | Unified voice gateway (Alternative A) over separate microservice | DECIDED                |
| D2  | Connection-scoped voice sessions (not checkpointed)              | DECIDED                |
| D3  | Audio not persisted by default (text transcripts only)           | DECIDED                |
| D4  | Redis-backed credential cache (not in-memory)                    | ANSWERED (code exists) |
| D5  | Provider abstraction via RealtimeVoiceSession interface          | ANSWERED (code exists) |

## Alternatives Evaluated

| Alternative                    | Decision | Reason                                                       |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| A: Unified Voice Gateway       | SELECTED | Code reuse, consistent behavior, centralized mode resolution |
| B: Separate Voice Microservice | REJECTED | Unacceptable latency increase for voice                      |
| C: Client-Side Only Voice      | REJECTED | No compliance support, no telephony                          |

## Audit Round 1 Findings

| #   | Severity | Finding                                           | Resolution                                          |
| --- | -------- | ------------------------------------------------- | --------------------------------------------------- |
| 1   | HIGH     | Missing capacity planning section                 | Added Section 7 with per-session resource estimates |
| 2   | HIGH     | Threat model should include SSRF via voice config | Added to threat model                               |
| 3   | MEDIUM   | Risk assessment missing probability/impact matrix | Added Section 8 with risk matrix                    |

## Audit Round 2 Findings

| #   | Severity | Finding                                       | Resolution                      |
| --- | -------- | --------------------------------------------- | ------------------------------- |
| 1   | MEDIUM   | Open issues should mention multi-language STT | Added as issue #5               |
| 2   | LOW      | Data flow diagrams should show KoreVG path    | Added KoreVG voice turn diagram |

## Audit Round 3 Findings

| #   | Severity | Finding                                                | Resolution                  |
| --- | -------- | ------------------------------------------------------ | --------------------------- |
| 1   | LOW      | Dependencies table could split internal/external       | Split into two tables       |
| 2   | LOW      | Encryption section could mention DTLS-SRTP for LiveKit | Added to encryption section |

## Artifacts Produced

- `docs/specs/voice-capabilities.hld.md` — HLD with 10 sections, 12 concerns, 3 alternatives
- `docs/sdlc-logs/voice-capabilities/phase-3-hld.md` — This log

## Metrics

- Architectural Concerns Addressed: 12/12
- Alternatives Evaluated: 3
- Data Flow Diagrams: 3
- Risks Identified: 6
- Open Issues: 5
