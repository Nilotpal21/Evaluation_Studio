# SDLC Log: Filler Messages -- Phase 3 (HLD)

**Date**: 2026-03-23
**Phase**: High-Level Design
**Artifact**: `docs/specs/filler-messages.hld.md`

## Summary

Generated HLD covering architecture, 12 concerns, alternatives analysis, data model, and API changes. Documents the implemented Phase 1 architecture and planned Phase 2-3 extensions.

## 12 Concerns Coverage

| Concern                | Status    | Notes                                                  |
| ---------------------- | --------- | ------------------------------------------------------ |
| Resource Isolation     | Addressed | Per-session service, session ID in every event         |
| Authentication         | Addressed | Piggybacks on existing auth middleware                 |
| Stateless/Distributed  | Addressed | In-memory per-session OK (sticky WebSocket)            |
| Traceability           | Partially | Phase 1 uses trace events; Phase 2 adds TraceStore     |
| Compliance             | Addressed | Transient, never persisted, no PII in static pools     |
| Performance            | Addressed | O(1) selection, timer-based, 2s timeout on pipeline    |
| Error Handling         | Addressed | Silent fallback chain, fire-and-forget                 |
| Backward Compatibility | Addressed | Additive events, no breaking changes                   |
| Scalability            | Addressed | Linear per-session, ~200 bytes each                    |
| Configuration          | Partially | Phase 1 hardcoded; Phase 2 adds three-level resolution |
| Monitoring             | Partially | Phase 1 debug-level; Phase 2 adds metrics              |
| Testing                | Addressed | 34 tests + 7 E2E + 6 integration scenarios             |

## Alternatives Evaluated

1. Separate small model for dynamic fillers -- rejected (latency, cost)
2. Client-side timer approach -- rejected (no server visibility)
3. LangGraph-based system -- rejected (heavyweight, needs Redis)
4. WebSocket-only (no voice) -- rejected (voice is highest impact)
