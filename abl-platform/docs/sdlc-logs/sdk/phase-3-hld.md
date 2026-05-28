# SDK HLD — SDLC Phase 3 Log

**Feature**: Web SDK (`packages/web-sdk`)
**Phase**: 3 — High-Level Design
**Date**: 2026-03-22
**Status**: COMPLETE

## Inputs Read

- `docs/features/sdk.md` — Feature spec (18 FRs, 8 NFRs)
- `docs/testing/sdk.md` — Test spec (10 E2E, 12 integration)
- `packages/web-sdk/src/` — All source files for architecture analysis
- `apps/runtime/src/websocket/sdk-handler.ts` — Server-side handler
- `docs/specs/` — Existing HLD examples for template reference

## Decisions

| ID  | Decision                                                           | Classification | Rationale                                        |
| --- | ------------------------------------------------------------------ | -------------- | ------------------------------------------------ |
| D1  | 3 alternatives analyzed (REST, SSE, WebSocket)                     | DECIDED        | WebSocket is only option supporting voice + chat |
| D2  | All 12 architectural concerns addressed                            | DECIDED        | Per HLD template requirements                    |
| D3  | Security threat model with 8 threats + 3 missing controls          | DECIDED        | Identifies gaps for BETA remediation             |
| D4  | Migration path defined: ALPHA -> BETA -> STABLE with gate criteria | DECIDED        | Aligned with feature spec rollout plan           |

## Audit Round 1 — Architectural Review

| Finding | Severity | Description                                                   | Resolution                              |
| ------- | -------- | ------------------------------------------------------------- | --------------------------------------- |
| A1-1    | CRITICAL | Missing origin validation on WebSocket upgrade (security gap) | Documented as missing control, BETA req |
| A1-2    | HIGH     | No message size limits on WebSocket handler                   | Documented as missing control, BETA req |
| A1-3    | HIGH     | `.catch(() => {})` in reconnect violates code standards       | Documented in error handling section    |
| A1-4    | MEDIUM   | TypedEventEmitter has no max listener cap                     | Documented in tech considerations       |

## Audit Round 2 — Completeness

| Finding | Severity | Description                                     | Resolution                        |
| ------- | -------- | ----------------------------------------------- | --------------------------------- |
| A2-1    | HIGH     | Deployment topology missing CDN distribution    | Added CDN to deployment diagram   |
| A2-2    | MEDIUM   | Data flow missing realtime voice sequence       | Added realtime voice flow diagram |
| A2-3    | LOW      | Decision log did not capture pre-SDLC decisions | Added 6 pre-SDLC decisions        |

## Audit Round 3 — Cross-Reference with Feature Spec

| Finding | Severity | Description                                                      | Resolution                       |
| ------- | -------- | ---------------------------------------------------------------- | -------------------------------- |
| A3-1    | HIGH     | Contact linking not reflected in data flow                       | Addressed in server architecture |
| A3-2    | MEDIUM   | Voice trace timing module not mentioned in observability section | Added to observability section   |
| A3-3    | LOW      | React 19 compatibility not mentioned in backward compatibility   | Added to backward compat         |

## Output

- `docs/specs/sdk.hld.md` — HLD addressing all 12 architectural concerns
  - 3 alternatives analyzed with pros/cons
  - 8 security threats + 3 missing controls identified
  - 3 data flow diagrams (chat, voice pipeline, voice realtime)
  - Migration path: ALPHA -> BETA -> STABLE with gate criteria
