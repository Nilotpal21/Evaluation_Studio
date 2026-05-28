# Test Spec Log: Pipeline Engine

**Phase**: 2 - Test Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

### Q1: What are the highest-risk functional requirements?

**Classification**: INFERRED
**Basis**: FR-4 (config resolution) and FR-7 (event-driven triggering) are highest risk because they involve multi-layer resolution logic and distributed event handling. FR-10 (eval pipeline) is high risk due to complex fan-out orchestration.

### Q2: What is the current test coverage baseline?

**Classification**: ANSWERED
**Source**: 50+ test files, 450+ tests passing. No E2E tests. 4 integration tests. All unit tests cover core logic paths.

### Q3: What external dependencies need mocking vs real integration?

**Classification**: DECIDED
**Rationale**: ClickHouse and Restate require real instances for true E2E. Redis can use ioredis-mock. MongoDB can use MongoMemoryServer. LLM providers should be mocked via DI for unit/integration tests.

### Q4: What are the critical user journeys that must work E2E?

**Classification**: DECIDED
**Rationale**: Seven E2E scenarios identified: (1) config CRUD lifecycle, (2) config isolation, (3) analytics query, (4) config validation, (5) backfill lifecycle, (6) trigger states, (7) RBAC permission enforcement.

### Q5: What isolation scenarios need testing?

**Classification**: DECIDED
**Rationale**: Cross-project 404 and cross-tenant 404 for pipeline configs are critical security gaps. No existing tests verify this. Added as E2E-2 and as coverage gaps.

## Changes Made

- Rewrote `docs/testing/pipeline-engine.md` with complete test inventory
- Added functional requirements coverage matrix (FR-1 through FR-13)
- Added isolation and security coverage matrix
- Defined 7 E2E test scenarios (E2E-1 through E2E-7) with detailed steps and assertions
- Defined 8 integration test scenarios (INT-1 through INT-8) with status tracking
- Added 11 coverage gaps (up from 6)
- Added cross-project and cross-tenant isolation gaps
- Added RBAC permission boundary gap
