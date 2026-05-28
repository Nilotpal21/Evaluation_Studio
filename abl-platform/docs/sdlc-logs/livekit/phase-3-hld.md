# SDLC Log: LiveKit — Phase 3 (HLD)

**Date:** 2026-03-23
**Phase:** High-Level Design
**Artifact:** `docs/specs/livekit.hld.md`

## Summary

Generated HLD covering all 12 architectural concerns. The design validates that the existing WebRTC pipeline is architecturally sound and extends it for SIP telephony.

## Key Architectural Decisions

1. **Unified pipeline**: Both WebRTC and SIP participants are LiveKit room participants — the agent pipeline is identical regardless of audio transport.
2. **In-process model**: Agents run embedded in the runtime server (no forked processes) for adapter registry simplicity and dev-mode compatibility.
3. **Streaming-first response**: ReadableStream returned to TTS immediately, enabling concurrent synthesis from first LLM chunk.
4. **Dual initialization paths**: Deployment-aware (pre-compiled IR) for production, legacy DSL cache for development.

## 12 Concerns Coverage

All 12 concerns addressed:

- Tenant isolation (room name scoping, server-authoritative tenantId)
- Auth (unified middleware, room-scoped tokens)
- Performance (streaming, caching, deferred DB session)
- Scalability (horizontal, concurrency guards, external API bottleneck awareness)
- Reliability (graceful degradation, error isolation, shutdown)
- Observability (per-turn trace hooks, EventStore events)
- Data model (existing + 3 new models for telephony)
- API surface (2 existing + 14 new telephony endpoints)
- Security (DTLS-SRTP, encrypted credentials, input validation)
- Compliance (recording consent, retention, PII detection)
- Error handling (comprehensive error table)
- Migration (feature flags, backward compatible, incremental rollout)
