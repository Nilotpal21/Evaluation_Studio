# SDLC Log: Workflows Test Spec (Phase 2)

**Date**: 2026-03-23
**Phase**: Test Spec
**Feature**: Workflows & Human Tasks (#48)

## Summary

Generated test spec with 10 E2E scenarios, 8 integration scenarios, and unit test gap analysis.

## Key Decisions

- **DECIDED**: Use MongoMemoryServer for E2E tests (no external MongoDB dependency)
- **DECIDED**: Mock Restate via RestateWorkflowCtx interface (DI, not vi.mock) since Restate server is not available in test
- **DECIDED**: Generate real JWT tokens with test secret for auth tests
- **DECIDED**: Use random port Express servers for E2E (platform pattern)
- **INFERRED**: ioredis-mock acceptable for Redis Pub/Sub tests since the feature uses standard pub/sub operations

## Coverage Summary

- **10 E2E scenarios**: Execution lifecycle, human task lifecycle, approval rejection, tenant isolation, cancellation, async webhook, condition branching, parallel execution, step retry, human task timeout
- **8 integration scenarios**: Handler sequencing, dispatcher routing, expression resolver, execution store, human task store, task resolution route, notification rules, Restate promises
- **36 existing unit tests** + 6 gap areas identified

## Artifact

- `docs/testing/workflows.md`
