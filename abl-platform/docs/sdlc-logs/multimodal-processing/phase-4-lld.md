# SDLC Log: Multimodal Processing - Phase 4 (LLD)

> **Date:** 2026-03-22
> **Phase:** Low-Level Design + Implementation Plan
> **Feature ID:** #40

## Summary

Generated phased implementation plan with 5 phases, 14 new files, 8 modified files, and 12-item wiring checklist. Each phase has explicit exit criteria and is independently deployable.

## Phase Summary

| Phase | Name                              | Priority | Duration | New Files  | Modified Files |
| ----- | --------------------------------- | -------- | -------- | ---------- | -------------- |
| 1     | Upload Validation + Tenant Config | P0       | 1-2 days | 2 + 1 test | 1              |
| 2     | Attachment-to-Search Bridge       | P0       | 2-3 days | 2 + 1 test | 5              |
| 3     | Audio Transcription Worker        | P1       | 2-3 days | 4 + 1 test | 3              |
| 4     | Video Processing Worker           | P1       | 2-3 days | 2 + 1 test | 2              |
| 5     | Observability + Cost Tracking     | P0       | 1-2 days | 3 + 1 test | 1              |

**Total estimated effort:** 8-12 developer days

## Key Implementation Decisions

1. **Upload validation via middleware** -- Single middleware function applied to all upload routes. Uses `file-type` package for magic-byte MIME detection.
2. **Platform defaults pattern** -- When `TenantAttachmentConfig` is absent, fall back to hardcoded defaults (20MB, all enabled, 90-day retention).
3. **TranscriptionProvider interface** -- Two implementations: `WhisperAPIProvider` (OpenAI) and `WhisperLocalProvider` (self-hosted). Same interface, selectable via config.
4. **FFmpeg via child process** -- `child_process.execFile()` with timeout. Temp files in `/tmp` with cleanup on success/failure.
5. **Cost tracking in chunk metadata** -- Reuses existing `SearchChunkMetadata.totalCost` and `totalTokens` fields.
6. **Wiring checklist** -- 12-item checklist to prevent the "built but never called" failure mode.

## Execution Order

Recommended: Phase 1 -> Phase 2 -> Phase 5 -> Phase 3 -> Phase 4

Phase 5 (Observability) done before Phase 3/4 because it defines TraceEvent types and metrics infrastructure that audio/video workers consume.

## Wiring Risks Identified

1. **Queue constants must be in `search-ai-sdk`** -- Workers in `search-ai` import from SDK. Missing constant = build failure.
2. **Worker registration in `workers/index.ts`** -- Unregistered worker = queue jobs accumulate forever.
3. **MAX_QUEUE_DEPTH for new queues** -- Missing entry = no backpressure = potential Redis OOM.
4. **FFmpeg in Docker image** -- Missing package = video worker silently fails.

## Artifact

- **Location:** `docs/plans/2026-03-22-multimodal-processing-impl-plan.md`
- **Phases:** 5
- **New files:** 14
- **Modified files:** 8
- **Wiring items:** 12
- **Exit criteria per phase:** Yes
- **Risk mitigations:** 5
