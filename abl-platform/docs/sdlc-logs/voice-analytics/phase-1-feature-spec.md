# Phase 1: Feature Spec — Voice Analytics

> Date: 2026-03-22 | Phase: Feature Spec | Auditor: phase-auditor (2 rounds)

## Summary

Generated comprehensive feature spec for Voice Analytics (#34) grounded in codebase analysis.

## Key Source Files Analyzed

- `packages/eventstore/src/schema/events/voice-events.ts` — 9 voice event schemas
- `packages/web-sdk/src/voice/VoiceClient.ts` — Pipeline/realtime voice client
- `apps/runtime/src/services/voice/voice-pipeline.ts` — STT/LLM/TTS orchestration
- `apps/runtime/src/services/voice/korevg/korevg-session.ts` — KoreVG session handler
- `apps/runtime/src/services/voice/korevg/homer-client.ts` — Homer QoS integration
- `apps/runtime/src/observability/voice-metrics.ts` — OTEL voice metrics
- `apps/runtime/src/observability/voice-quality-analyzer.ts` — ASR quality scoring
- `apps/runtime/src/observability/asr-cascade-detector.ts` — Cascade detection
- `apps/runtime/src/routes/voice-analytics.ts` — API endpoints
- `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` — Dashboard
- `apps/studio/src/hooks/useVoiceAnalytics.ts` — Data fetching hook
- `docs/plans/voice-metrics-implementation-plan.md` — Existing metrics plan

## Audit Round 1 Findings

| #   | Severity | Finding                                                    | Resolution                                                                                     |
| --- | -------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | HIGH     | FR-6 (trend indicators) marked PARTIAL without explanation | Added detail: MetricCard supports trends but backend doesn't compute period-over-period change |
| 2   | MEDIUM   | Missing accessibility section                              | Added Section 11 with 5 accessibility requirements                                             |
| 3   | MEDIUM   | OQ-4 was AMBIGUOUS                                         | Resolved to INFERRED: group unknown languages with sample count note                           |
| 4   | LOW      | Section numbering broken after insertion                   | Fixed section numbers 12-19                                                                    |

## Audit Round 2 Findings

| #   | Severity | Finding                                        | Resolution |
| --- | -------- | ---------------------------------------------- | ---------- |
| 1   | LOW      | All 19 sections present and numbered correctly | Verified   |
| 2   | LOW      | 20 FRs with clear priority/status              | Verified   |
| 3   | LOW      | All code references verified against source    | Verified   |

## Outcome

- **Artifact**: `docs/features/voice-analytics.md`
- **Sections**: 19 (exceeds 18-section template requirement)
- **FRs**: 20 total (11 DONE, 1 PARTIAL, 8 PLANNED)
- **User Stories**: 8
- **NFRs**: 10
- **Open Questions**: 5 (4 DECIDED/INFERRED, 1 newly INFERRED)
