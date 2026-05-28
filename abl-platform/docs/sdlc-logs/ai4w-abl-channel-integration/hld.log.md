# SDLC Log: AI4W-ABL Channel Integration — HLD

**Phase**: HLD
**Date**: 2026-04-16
**Status**: COMPLETE

## Oracle Decisions

### Architecture & Data Flow

| #   | Question                    | Classification | Answer Summary                                                                         |
| --- | --------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| A1  | Architecture pattern        | ANSWERED       | Dedicated route file (like http-async-channel.ts), not generic channel-webhooks.ts     |
| A2  | Data flow per mode          | ANSWERED       | Sync: same HTTP conn. SSE: held open. Async: BullMQ channel-inbound → webhook-delivery |
| A3  | Expected scale              | ANSWERED       | Shares existing 100 req/min tenant rate limit, no special elevation                    |
| A4  | Generic router vs dedicated | ANSWERED       | Dedicated route file, mounted before generic catch-all in server.ts                    |
| A5  | Deployment topology         | ANSWERED       | Same runtime process. Internal APIs optionally on separate port (:3113)                |

### Integration & Dependencies

| #   | Question                 | Classification | Answer Summary                                                              |
| --- | ------------------------ | -------------- | --------------------------------------------------------------------------- |
| I1  | Service dependencies     | INFERRED       | Sync/SSE: inline SessionResolver. Async: BullMQ channel-inbound queue       |
| I2  | New npm dependencies     | DECIDED        | None — jose already in runtime, used by msteams-adapter                     |
| I3  | API contract             | ANSWERED       | New schema at /api/v1/channels/ai4w/message, not reusing /api/v1/chat/agent |
| I4  | Breaking changes         | ANSWERED       | None — purely additive. ChannelType union derives from manifest keys        |
| I5  | Compile/deploy lifecycle | ANSWERED       | Requires deployed agent — deploymentId is required on connection config     |

### Risk & Migration

| #   | Question              | Classification | Answer Summary                                                                          |
| --- | --------------------- | -------------- | --------------------------------------------------------------------------------------- |
| R1  | Biggest risk          | DECIDED        | SSE connection management (held connections, resource pressure, novel fallback path)    |
| R2  | Data migration        | ANSWERED       | Purely additive — no migration needed                                                   |
| R3  | Rollback strategy     | INFERRED       | Feature flag AI4W_CHANNEL_ENABLED gates route mounting. Flag off → no traffic           |
| R4  | Feature flag strategy | ANSWERED       | AI4W_CHANNEL_ENABLED gates routes + manifest. AI4W_INTERNAL_API_ENABLED gates discovery |
| R5  | Blast radius          | INFERRED       | Fully isolated except shared BullMQ channel-inbound queue (async mode only)             |

## Audit Rounds

### Round 1: NEEDS_REVISION

- 1 CRITICAL: Missing architecture treatment for FR-11 (files), FR-12 (auth challenge), FR-17 (OAuth2), FR-18 (offline fallback)
- 5 HIGH: base64url encoding note missing, provisioning schema missing, audit logging for discovery/provisioning, diagram port annotation misleading, async mode selection ambiguity
- 2 MEDIUM: design-lint.sh failure, OQ-3 should be design decision
- All CRITICAL and HIGH fixed

### Round 2: APPROVED (with recommendations)

- 2 HIGH: OAuth client secret missing from data model, session key format inconsistency with feature spec
- 2 MEDIUM: SSE connection limit env var not in feature spec, provisioning schema missing jwksUri
- All HIGH fixed. Feature spec FR-4 updated to use base64url(email).

### Round 3: APPROVED

- 0 CRITICAL, 0 HIGH
- 1 MEDIUM: design-lint.sh bash bug (tooling issue, not HLD)
- HLD declared LLD-ready

## Files Created

- `docs/specs/ai4w-abl-channel-integration.hld.md` — HLD

## Files Updated

- `docs/features/ai4w-abl-channel-integration.md` — FR-4 and data model updated to use base64url(email)
- `docs/sdlc-logs/ai4w-abl-channel-integration/hld.log.md` — This log
