# SDLC Log: Multimodal Processing - Phase 2 (Test Spec)

> **Date:** 2026-03-22
> **Phase:** Test Specification
> **Feature ID:** #40

## Summary

Generated comprehensive test specification covering all multimodal processing components with 7 E2E scenarios, 7 integration scenarios, 5 unit test suites, and 4 security test scenarios.

## Key Decisions

1. **External service mocking via HTTP stubs**: Docling, BGE-M3, Vision LLM, and S3 are mocked via HTTP stubs (not `vi.mock()`) to test real HTTP client code paths.
2. **MongoMemoryServer for DB**: Both E2E and integration tests use MongoMemoryServer for isolation and speed.
3. **Real BullMQ queues**: Integration and E2E tests use real Redis + BullMQ to verify queue behavior, backpressure, and job transitions.
4. **Random port Express**: E2E tests start real Express on port 0 for parallel test execution safety.

## Coverage Summary

| Category              | Count | Details                                                                                                                     |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| E2E Scenarios         | 7     | Full pipeline, image analysis, MIME blocking, attachment bridge, size limits, cross-tenant, dedup                           |
| Integration Scenarios | 7     | Docling worker, visual enrichment chain, multimodal enricher, attachment bridge, backpressure, tenant config, cost tracking |
| Unit Test Suites      | 5     | MIME validation, content hash, file size, visual context, extraction options                                                |
| Security Scenarios    | 4     | MIME bypass, path traversal, oversized payload, cross-tenant S3                                                             |
| Performance Scenarios | 2     | Concurrent processing, large document                                                                                       |

## FR Coverage Mapping

| FR                         | E2E          | Integration  | Unit |
| -------------------------- | ------------ | ------------ | ---- |
| FR-01 (Route to Docling)   | E2E-1        | INT-1        | -    |
| FR-02 (Extract pages)      | E2E-1        | INT-1        | UT-5 |
| FR-03 (S3 upload)          | E2E-1        | INT-1        | -    |
| FR-04 (Vision analysis)    | E2E-2        | INT-3        | -    |
| FR-05 (Image descriptions) | E2E-2        | INT-3        | -    |
| FR-06 (Visual metadata)    | E2E-2        | INT-2        | -    |
| FR-13 (Attachment bridge)  | E2E-4        | INT-4        | -    |
| FR-15 (Deduplication)      | E2E-7        | INT-4        | UT-2 |
| FR-16 (Tenant config)      | E2E-3, E2E-5 | INT-6        | -    |
| FR-17 (MIME validation)    | E2E-3        | -            | UT-1 |
| FR-18 (File size)          | E2E-5        | -            | UT-3 |
| FR-20 (Visual context)     | E2E-2        | INT-2        | UT-4 |
| FR-22 (TraceEvents)        | E2E-1        | INT-1, INT-2 | -    |
| FR-24 (Retry)              | -            | INT-1        | -    |

## Artifact

- **Location:** `docs/testing/multimodal-processing.md`
- **E2E scenarios:** 7 (exceeds minimum 5)
- **Integration scenarios:** 7 (exceeds minimum 5)
- **Zero mocking of codebase components**
