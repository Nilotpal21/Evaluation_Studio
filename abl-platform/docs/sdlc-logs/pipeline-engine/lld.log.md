# LLD Log: Pipeline Engine

**Phase**: 4 - LLD
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What is the preferred implementation order?

**Classification**: ANSWERED
**Source**: Existing implementation follows logical dependency order: Core Engine -> Configuration -> Execution -> Compute Services -> Analytics -> Eval -> Routes -> UI. Each phase builds on the previous.

### Q2: Which specific files were created?

**Classification**: ANSWERED
**Source**: Full inventory compiled from glob of `packages/pipeline-engine/src/` and `apps/*/src/`. 80+ source files and 50+ test files across 8 implementation phases.

### Q3: What is the biggest implementation risk for future changes?

**Classification**: DECIDED
**Rationale**: E2E test coverage gap is the biggest risk. Without E2E tests, changes to auth middleware, config resolution, or ClickHouse query logic could introduce regressions that unit tests would not catch.

### Q4: What is the definition of done for the whole feature?

**Classification**: DECIDED
**Rationale**: Feature is STABLE. Definition of done for future changes: (1) unit tests pass, (2) integration tests pass, (3) E2E tests pass (when written), (4) `pnpm build` passes, (5) no new CRITICAL/HIGH gaps introduced.

### Q5: What rollback strategy exists?

**Classification**: DECIDED
**Rationale**: Five rollback strategies documented: config schema backward compatibility via Zod defaults, ClickHouse additive-only DDL, idempotent definition seeding, node type versioning, and additive API changes.

## Key Findings

1. **8 implementation phases** completed with clear dependency order
2. **80+ source files** across pipeline-engine package, runtime routes, and Studio UI
3. **50+ test files** with 450+ tests, but NO E2E coverage
4. **All wiring verified**: every component is connected to its consumers
5. **5 open gaps** identified for future phases, prioritized by severity

## Changes Made

- Rewrote `docs/plans/pipeline-engine.lld.md` with full LLD structure
- Added 8-row design decision log with alternatives
- Added key interfaces and types summary
- Added 9-row module boundary table
- Added 8-phase file-level change map with 80+ files
- Added 8-phase exit criteria (all checked)
- Added 18-row wiring checklist (all verified)
- Added 5 open gaps with priority and plans
- Added 5-point rollback strategy
