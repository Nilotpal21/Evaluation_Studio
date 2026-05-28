# SDK Feature Spec — SDLC Phase 1 Log

**Feature**: Web SDK (`packages/web-sdk`)
**Phase**: 1 — Feature Spec
**Date**: 2026-03-22
**Status**: COMPLETE

## Inputs Read

- `packages/web-sdk/src/` — all 20 source files (core, chat, voice, react, ui)
- `packages/web-sdk/package.json` — dependencies, exports, build config
- `packages/web-sdk/README.md` — API documentation
- `packages/search-ai-sdk/` — related SDK package for context
- `apps/runtime/src/websocket/sdk-handler.ts` — server-side handler
- `apps/runtime/src/__tests__/ws-sdk-handler.test.ts` — existing tests
- `docs/features/guardrails.md` (from another worktree) — template reference

## Decisions

| ID  | Decision                                                        | Classification | Rationale                                               |
| --- | --------------------------------------------------------------- | -------------- | ------------------------------------------------------- |
| D1  | Classify as MAJOR FEATURE (not sub-feature)                     | DECIDED        | SDK is a standalone client-facing package               |
| D2  | Status = ALPHA (not PLANNED)                                    | DECIDED        | Code exists and is functional but lacks E2E tests       |
| D3  | Include both client (web-sdk) and server (sdk-handler) in scope | DECIDED        | They are tightly coupled; spec must cover both          |
| D4  | Exclude search-ai-sdk from this spec                            | DECIDED        | Separate package with different purpose (internal SDK)  |
| D5  | 18 FRs covering chat, voice, widgets, React, server handler     | DECIDED        | Comprehensive coverage of all implemented functionality |

## Audit Round 1 — Self-Review

| Finding | Severity | Description                                                 | Resolution                  |
| ------- | -------- | ----------------------------------------------------------- | --------------------------- |
| A1-1    | HIGH     | Missing dependency on Contact Linking in integration matrix | Added to integration matrix |
| A1-2    | MEDIUM   | Open questions did not mention session restoration          | Added as open question #1   |
| A1-3    | LOW      | Glossary missing PCM16 and Shadow DOM definitions           | Added to glossary           |

## Audit Round 2 — Cross-Reference

| Finding | Severity | Description                                                           | Resolution            |
| ------- | -------- | --------------------------------------------------------------------- | --------------------- |
| A2-1    | HIGH     | FR-16 through FR-18 (server-side) were missing — spec was client-only | Added server-side FRs |
| A2-2    | MEDIUM   | Security section did not mention CORS/CSP implications                | Added item #7         |
| A2-3    | LOW      | NFR-6 about duplicate session prevention was missing                  | Added NFR-6           |

## Output

- `docs/features/sdk.md` — 18-section feature spec, all findings resolved
