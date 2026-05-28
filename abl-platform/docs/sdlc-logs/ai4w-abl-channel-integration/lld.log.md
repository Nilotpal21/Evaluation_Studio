# SDLC Log: AI4W-ABL Channel Integration — LLD

**Phase**: LLD
**Date**: 2026-04-18
**Status**: COMPLETE

## Oracle Decisions

### Implementation Strategy

| #   | Question                           | Classification | Answer Summary                                                                   |
| --- | ---------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| IS1 | Implementation order               | DECIDED        | Follow P0-P6 phasing, reorganize within each phase data-layer-first              |
| IS2 | Reference pattern                  | ANSWERED       | msteams-adapter.ts — only existing adapter with JWT/JWKS auth                    |
| IS3 | Feature flag placement             | INFERRED       | server.ts (route mount), registry.ts (adapter registration)                      |
| IS4 | LLD scope                          | DECIDED        | Fully detail P0+P1, skeleton P2-P3, interface-only P4-P6                         |
| IS5 | /message vs /message/async phasing | ANSWERED       | /message in P0 (sync), extended with SSE+async in P1, /message/async added in P1 |

### Technical Details

| #   | Question                          | Classification | Answer Summary                                                          |
| --- | --------------------------------- | -------------- | ----------------------------------------------------------------------- |
| TD1 | Adapter methods for async path    | INFERRED       | Yes — verifyRequest at route level, parseIncoming by queue worker       |
| TD2 | ChannelType conditional inclusion | DECIDED        | Always include unconditionally — compile-time type                      |
| TD3 | Session resolution pipeline       | ANSWERED       | resolveEnvironmentLabel → createRuntimeSession → createAndLinkDBSession |
| TD4 | SSE implementation                | ANSWERED       | Reuse writeSSE pattern from chat.ts, inline (no shared module)          |
| TD5 | Dispatcher tier for proactive     | INFERRED       | Direct HTTP POST, not ChannelDispatcher — different abstraction         |

### Risk & Dependencies

| #   | Question                     | Classification | Answer Summary                                                                                           |
| --- | ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| RD1 | Conflicting changes          | ANSWERED       | ABLP-329 (session metadata) and ABLP-2 (session lifecycle) touch session-resolver — merge-safe additions |
| RD2 | Per-connection JWKS pattern  | ANSWERED       | No existing pattern — new LRU cache keyed by jwksUri (max 50, 5-min TTL)                                 |
| RD3 | Monitoring needs             | INFERRED       | Existing infra covers new channels automatically via trace events; custom events need explicit emission  |
| RD4 | Studio catalog pattern       | ANSWERED       | CHANNEL_REGISTRY entry with icon, credentialFields, setupInstructions                                    |
| RD5 | Delivery worker modification | INFERRED       | No modification needed — adapter pre-signs payloads                                                      |

## Audit Rounds

### Round 1: NEEDS_CHANGES (lld-reviewer)

- 2 CRITICAL: Tenant isolation gap (connection resolution didn't derive tenantId), tenantRateLimit requires tenantContext
- 6 HIGH: Studio ChannelTypeId missing, CredentialFieldDef type mismatch, connection-resolver.ts not in modified files, missing safeParse, missing ChannelTypeDef required fields, rate limiter API
- 4 MEDIUM: Schema not inlined, writeSSE private, JWKS TTL unclear, SSE error format
- All CRITICAL and HIGH fixed

### Round 2: NEEDS_CHANGES (lld-reviewer)

- 3 HIGH: Rate limiter API mismatch (checkTenantLimit doesn't exist), verifyRequest can't attach claims (returns boolean), connection resolution reinvention (should use externalIdentifier)
- 4 MEDIUM: Missing CHANNEL_CATALOG_ORDER, responseMode should be config not credential, new helper duplicates credential pipeline, redundant connection resolver
- All HIGH and MEDIUM fixed. Switched to `resolveChannelConnection` + `externalIdentifier`, `getHybridRateLimiter().check()` directly, route handler extracts JWT claims separately

### Round 3: NEEDS_CHANGES (lld-reviewer — completeness)

- 3 HIGH: tenantRateLimit returns RequestHandler (can't call inline), Studio capabilities object missing, resolveChannelConnection query description inaccurate
- 5 MEDIUM: Line reference off, buildSignatureHeaders import path, BullMQ job config missing, SSE counter TTL missing, P2-P4 acceptance criteria note
- All HIGH and MEDIUM fixed. Rate limiter → `getHybridRateLimiter().check()` directly. Studio `capabilities` added. BullMQ job opts specified. SSE counter TTL (180s) added.

### Round 4: APPROVED (phase-auditor — cross-phase consistency)

- 3 HIGH: FR-15 traceability label stale, per-tenant flag missing from LLD, ai4w-content-transformer.ts missing from file map
- 2 MEDIUM: buildSignatureHeaders static vs dynamic import, deferred test scenario acceptance criteria
- All HIGH fixed. Per-tenant flag documented as deferred (no existing pattern). Content transformer added to file map.

### Round 5: APPROVED (lld-reviewer — final sweep)

- 3 LOW: FR-15 label (already fixed in round 4), req.tenantContext divergence note, conditional adapter registration comment
- All verified: architecture compliance, pattern consistency, wiring checklist, domain rules, task independence, rollback strategies, exit criteria

## Files Created

- `docs/plans/2026-04-18-ai4w-abl-channel-integration-impl-plan.md` — LLD + implementation plan
