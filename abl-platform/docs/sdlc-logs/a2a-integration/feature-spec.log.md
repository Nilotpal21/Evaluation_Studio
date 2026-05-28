# Feature Spec Log: A2A Integration

**Date**: 2026-03-22
**Phase**: 1 - Feature Spec
**Feature**: a2a-integration

## Clarifying Questions & Decision Protocol

### Scope & Problem

| Question                              | Classification | Answer                                                                                                                                                                  |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What specific problem does A2A solve? | ANSWERED       | Found in `docs/architecture/A2A_PROTOCOL_SUPPORT.md` and existing feature spec -- enables ABL agents to participate in Google A2A ecosystem as both servers and clients |
| What is the boundary?                 | ANSWERED       | Inbound (server) + outbound (client) A2A protocol. Excludes user-scoped credentials, DSL-based connection config, admin audit controls                                  |
| Is this new or enhancement?           | ANSWERED       | Enhancement of existing implementation -- `packages/a2a/` is fully implemented with hexagonal architecture                                                              |
| Which SDK version?                    | ANSWERED       | `@a2a-js/sdk` v0.2.5+ (package.json), protocol spec v0.3.0 per architecture doc                                                                                         |

### Technical & Architecture

| Question                     | Classification | Answer                                                                                                                           |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Which packages are affected? | ANSWERED       | `packages/a2a/`, `packages/execution/`, `apps/runtime/`, `apps/studio/` -- verified via grep                                     |
| What data models exist?      | ANSWERED       | `channel_connections` (MongoDB), Redis keys for sessions/tasks/callbacks, `suspended_executions` (MongoDB)                       |
| How does async work?         | ANSWERED       | Suspension/resumption via `packages/execution/src/suspension.ts`, Redis callback registry, BullMQ resume queue                   |
| What SDK constraints exist?  | ANSWERED       | Relative card URLs, `getTask` clears history, async generator cleanup hang -- documented in feature spec and test iteration logs |

## Files Created

- `docs/features/a2a-integration.md` -- Re-generated with all 18 sections, 10 FRs, 5 user stories, code-grounded

## Review Summary

### Round 1 -- Completeness

- All 18 TEMPLATE.md sections addressed
- 5 user stories (minimum 3 required)
- 10 functional requirements (minimum 4 required)
- Integration matrix references 5 related features
- Non-functional concerns address tenant, project, and user isolation
- Delivery plan has 4 parent tasks with numbered subtasks
- 5 open questions

### Round 2 -- Cross-Phase Consistency

- FR numbering is consistent and mapped to test coverage in section 17
- Scope boundaries match non-goals
- User stories align with functional requirements
- Implementation files verified at stated paths via filesystem inspection
- All claims grounded in source code evidence from `packages/a2a/src/` and `apps/runtime/src/`
