# SDLC Log: Rate Limiting — HLD (Phase 3)

**Date**: 2026-03-22
**Phase**: HLD
**Artifact**: `docs/specs/rate-limiting.hld.md`

## Decision Log

| #   | Question                                              | Classification | Resolution                                                                                                                                        |
| --- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What architecture pattern should we recommend?        | DECIDED        | Continue with purpose-built limiter per surface (Alternative B). The diverse workload patterns justify different algorithms.                      |
| 2   | Should we extract a shared core package?              | DECIDED        | Not now. Documented as Alternative C for future evaluation. Current duplication is manageable.                                                    |
| 3   | What is the biggest technical risk?                   | ANSWERED       | Unproven Redis Lua correctness under concurrent multi-pod traffic. Unit tests mock Redis; no real-Redis E2E exists.                               |
| 4   | Is data migration needed?                             | ANSWERED       | No. All rate-limit state is ephemeral Redis/in-memory. No MongoDB collections to migrate.                                                         |
| 5   | What's the rollback strategy?                         | DECIDED        | Set plan limits to -1 (unlimited) or remove middleware from routes. Each surface is independent.                                                  |
| 6   | Should all services use the same 429 response format? | DECIDED        | Yes for Runtime and SearchAI (already consistent). Studio helpers return different shapes but are internal. Agent-transfer returns its own shape. |
| 7   | What performance targets are reasonable?              | INFERRED       | Redis Lua < 1ms p99 (single round-trip). In-memory < 0.1ms. Based on Redis benchmarks and observed latencies.                                     |
| 8   | Should agent-transfer get an in-memory fallback?      | AMBIGUOUS      | Left as open question. Transfer security may justify hard Redis requirement. Documented as GAP-006.                                               |

## Files Created/Modified

- `docs/specs/rate-limiting.hld.md` — New HLD with all 12 architectural concerns
- `docs/sdlc-logs/rate-limiting/hld.log.md` — This file

## Review Summary

**Round 1 — Full Audit**: All 12 architectural concerns addressed. 3 alternatives considered with trade-offs. System context and component diagrams present. Data model complete (all Redis key patterns). API design covers existing and planned endpoints. 4 open questions listed.

**Round 2 — Deep Dive**: Data model covers all 6 services' Redis key patterns. API contract specifies both Runtime and SearchAI 429 formats. Error model covers 5 failure scenarios with user experience impact. Performance budget has specific latency targets per operation.

**Round 3 — Cross-Phase Consistency**: HLD implements all 8 FRs from feature spec. Test strategy aligns with test spec scenarios (12 unit, 7 integration, 7 E2E, 4 load). No contradictions between feature spec and HLD. Dependency table matches feature spec's package list.
