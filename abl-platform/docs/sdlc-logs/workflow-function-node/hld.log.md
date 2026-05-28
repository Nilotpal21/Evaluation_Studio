# SDLC Log: Workflow Function Node -- HLD

**Phase**: HLD
**Date**: 2026-04-07
**Feature**: Workflow Function Node with Context Injection

---

## Oracle Decisions

All 15 clarifying questions answered. No AMBIGUOUS items.

### Key Decisions

| #   | Classification | Decision                                                                 |
| --- | -------------- | ------------------------------------------------------------------------ |
| Q1  | ANSWERED       | Module within workflow-engine (executor pattern), not standalone service |
| Q2  | ANSWERED       | Synchronous within Restate handler, no Redis/BullMQ                      |
| Q7  | ANSWERED       | Alpine/Debian mismatch is blocking -- builder must switch to Debian      |
| Q9  | INFERRED       | Not a breaking API change -- mapping is runtime, not persisted           |
| Q11 | DECIDED        | Docker build compatibility is biggest risk                               |
| Q13 | DECIDED        | Rollback via one-line revert in canvas-to-steps.ts                       |
| Q15 | INFERRED       | Isolate crash should not take down process; Restate replays if it does   |

## Architecture Summary

- 3 alternatives evaluated: expression extension, isolated-vm, vm2
- Chosen: isolated-vm (Option B) for real V8 isolation and multi-tenant safety
- No new endpoints, no data model changes, no new collections
- Executor follows established pattern (12 existing executors)
- Biggest risk: Docker Alpine/Debian native module mismatch (blocking)

## Files Created

- `docs/specs/workflow-function-node.hld.md` -- HLD document
- `docs/sdlc-logs/workflow-function-node/hld.log.md` -- This log
