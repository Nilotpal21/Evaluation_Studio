# HLD Log: Pipeline Engine

**Phase**: 3 - HLD
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What is the preferred architecture pattern?

**Classification**: ANSWERED
**Source**: Existing implementation uses Restate durable workflows for execution, Express routes for API, MongoDB for state, ClickHouse for analytics, Redis for caching.

### Q2: How does data flow?

**Classification**: ANSWERED
**Source**: Three primary flows documented: (1) Analytics pipeline via Kafka events -> Restate trigger -> workflow -> compute services -> ClickHouse. (2) Eval pipeline via API -> Restate workflow -> fan-out conversations/judging -> ClickHouse. (3) Query path via API -> Redis cache -> ClickHouse.

### Q3: What is the biggest technical risk?

**Classification**: DECIDED
**Rationale**: Cross-tenant data leakage in ClickHouse queries is the highest-severity risk (Critical). All queries use parameterized tenant_id, but no E2E test verifies this. Restate unavailability is the second-highest risk.

### Q4: What alternatives were considered?

**Classification**: INFERRED
**Basis**: BullMQ (already in platform), Temporal (industry standard), and pure function (simplest) are the natural alternatives to Restate for workflow execution. Each was evaluated against durability, crash recovery, and parallelism requirements.

### Q5: How does this interact with the compile-deploy-execute lifecycle?

**Classification**: ANSWERED
**Source**: Pipeline Engine is independent of the ABL compile-deploy-execute lifecycle. It operates on stored conversation data post-execution. Eval pipeline connects to Runtime API to execute agent turns.

## Key Design Decisions Documented

1. Restate over BullMQ/Temporal for durable workflow execution
2. ClickHouse over PostgreSQL for columnar analytics
3. Pure function graph walker for testability
4. Custom expression evaluator for security
5. Dual execution mode for backward compatibility
6. DB-backed node types for runtime extensibility
7. Trait-based field merging for reducing boilerplate
8. Batched eval concurrency for cost/rate control

## Changes Made

- Rewrote `docs/specs/pipeline-engine.hld.md` with full HLD structure
- Added 3 alternatives with detailed pros/cons and rejection rationale
- Added system context diagram
- Added 6 component architecture subsections with file references
- Added 3 data flow diagrams (analytics, eval, query)
- Addressed all 12 architectural concerns with code evidence
- Added 10-row design decisions table
- Added 7-row risk assessment
- Added 6 future considerations
