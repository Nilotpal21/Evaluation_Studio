# SDLC Log: Workflows HLD (Phase 3)

**Date**: 2026-03-23
**Phase**: HLD
**Feature**: Workflows & Human Tasks (#48)

## Summary

Generated High-Level Design document addressing all 12 architectural concerns with 3 alternatives evaluated.

## Key Architecture Decisions

1. **Restate over BullMQ Flows**: Durable promises, exactly-once execution, and durable sleep make Restate the right fit for HITL workflows
2. **Separate service (port 9080)**: Workflow execution scales independently from real-time chat runtime
3. **Unified HumanTask collection**: Single inbox with discriminated union source field over fragmented per-type collections
4. **Step dispatcher pattern**: Central routing with type-specific executors for single-responsibility and testability
5. **MongoDB as queryable snapshot**: Restate is source of truth for in-flight; MongoDB provides query access and audit trail

## 12 Concerns Coverage

| Concern          | Status      | Key Gap                                                           |
| ---------------- | ----------- | ----------------------------------------------------------------- |
| Tenant Isolation | Implemented | No project-level RBAC on task operations                          |
| Auth & Authz     | Implemented | No requireProjectPermission() in routes                           |
| Data Model       | Implemented | Step type mismatch: shared-kernel (9) vs database (12) vs Zod (9) |
| API Design       | Implemented | Workflow CRUD routes not found                                    |
| Observability    | Partial     | OTel present but no TraceStore integration                        |
| Performance      | Adequate    | No rate limiting at API level                                     |
| Error Handling   | Implemented | Good discrimination (cancel, timeout, reject)                     |
| Scalability      | Good        | Stateless with Restate + MongoDB + Redis                          |
| Security         | Partial     | Expression resolver lacks prototype pollution guard               |
| Durability       | Strong      | Restate exactly-once with durable promises                        |
| Compliance       | Partial     | No dedicated audit logging, no erasure cascade                    |
| Extensibility    | Good        | Dispatcher pattern with exhaustive switch                         |

## Alternatives Evaluated

1. BullMQ Flows instead of Restate -> Rejected (no durable promises)
2. Embedded in runtime -> Rejected (cannot scale independently)
3. Per-type task collections -> Rejected (fragmented inbox)

## Artifact

- `docs/specs/workflows.hld.md`
