# SDLC Log: Multimodal Processing - Phase 3 (HLD)

> **Date:** 2026-03-22
> **Phase:** High-Level Design
> **Feature ID:** #40

## Summary

Generated comprehensive High-Level Design covering the multimodal processing subsystem architecture. All 12 architectural concerns addressed. 3 design alternatives evaluated and rejected with rationale.

## Architectural Decisions

### Component Architecture (6 components)

1. **Upload Validator** -- Middleware enforcing tenant config at API boundary.
2. **Content Router** -- Routes uploads to appropriate pipeline by content category.
3. **Document Processing Pipeline** -- Existing (Docling + page processing + visual enrichment).
4. **Audio Transcription Worker** -- New BullMQ worker for Whisper-based transcription.
5. **Video Processing Worker** -- New BullMQ worker with FFmpeg + vision analysis.
6. **Attachment-to-Search Bridge** -- New component bridging processed attachments to ingestion pipeline.

### 12 Architectural Concerns Coverage

| #   | Concern               | Key Decision                                                                                     |
| --- | --------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Tenant Isolation      | `tenantIsolationPlugin` on all models, tenant-prefixed S3 keys, `withTenantContext()` in workers |
| 2   | Auth & AuthZ          | `createUnifiedAuthMiddleware`, `requireProjectPermission`, per-index LLM credential resolution   |
| 3   | Stateless Distributed | All state in MongoDB + Redis, BullMQ for job distribution, no pod-local state                    |
| 4   | Traceability          | `TraceEvent`s per stage, `workerLog()`/`workerError()`, `JobExecution` tracking                  |
| 5   | Compliance            | S3 SSE, TTL retention, erasure cascades, PII flag, EXIF stripping, audit logging                 |
| 6   | Performance           | Batch embedding, rate limiting, queue backpressure, bounded context, S3 parallelism              |
| 7   | Error Handling        | 3x retry with exponential backoff, error recording, graceful degradation, dead letter            |
| 8   | Observability         | Prometheus metrics, BullMQ dashboard, SSE progress, cost tracking, health checks                 |
| 9   | Scalability           | Horizontal worker scaling, GPU-enabled embedding, independent service scaling                    |
| 10  | Backward Compat       | Optional schema additions, additive APIs/queues, feature flags                                   |
| 11  | Security              | Magic-byte MIME detection, virus scanning, credential isolation, S3 key scoping                  |
| 12  | Testing               | 7 E2E + 7 integration + 5 unit + 4 security scenarios, no codebase mocking                       |

### Design Alternatives Evaluated

1. **Unified Multimodal Worker** -- Rejected (different resource profiles, no independent scaling, large blast radius).
2. **Synchronous Attachment Bridge** -- Rejected (blocking, tight coupling, retry complexity).
3. **Direct LLM API Calls** -- Rejected (no cost tracking, no rate limiting, no provider abstraction).

## Risk Highlights

- **Vision API rate limiting** (High probability) -- Mitigated by BullMQ limiter + backoff.
- **Cross-tenant S3 leak** (Low probability, Critical impact) -- Mitigated by tenant-prefixed keys.
- **Redis OOM** (Medium probability) -- Mitigated by `MAX_QUEUE_DEPTH` + TTL cleanup.

## Artifact

- **Location:** `docs/specs/multimodal-processing.hld.md`
- **Architectural concerns:** 12/12 addressed
- **Alternatives evaluated:** 3 (all rejected with rationale)
- **Components designed:** 6
- **Data flows documented:** 3 (document, audio, video)
