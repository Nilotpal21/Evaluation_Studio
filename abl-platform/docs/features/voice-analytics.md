# Voice Analytics

> **Feature #34** | Status: **ALPHA** | Owner: Platform Team
> Last updated: 2026-03-22

## 1. Problem Statement

Voice interactions on the ABL platform generate rich telemetry data (STT transcriptions, TTS synthesis metrics, network QoS, call timing, user behavior signals) but operators lack a unified analytics surface to monitor voice channel health, detect quality degradation, and drive optimization decisions. Without aggregated voice analytics, teams cannot answer critical operational questions: What is our ASR accuracy? How natural does our TTS sound? Are callers experiencing latency or poor audio quality? Are there cascade failures from bad network to wrong responses?

## 2. Background & Context

The ABL platform supports voice interactions through multiple pathways:

- **Pipeline mode**: Client-side VAD + PCM16 audio capture via WebSocket, with server-side STT (Deepgram) + LLM + TTS (ElevenLabs) orchestration
- **Realtime mode**: Native audio I/O via realtime LLM providers (OpenAI, Google Gemini) with PCM16 streaming
- **KoreVG/Jambonz integration**: SIP-based telephony with drachtio, rtpengine, and Homer HEP protocol for QoS monitoring

The platform already captures per-session voice metrics through trace events (`voice.session.started`, `voice.session.ended`, `voice.turn.completed`, `voice.stt.completed`, `voice.tts.completed`, `voice.barge_in.detected`, `voice.asr_quality.analyzed`, `voice.tts_quality.measured`, `voice.asr_cascade.detected`) stored in ClickHouse via the EventStore. Ten voice metrics (IDs 201-210) have been implemented at the collection layer. However, the analytics aggregation, dashboard visualization, and alerting layers need completion.

### Existing Infrastructure

| Layer                | What Exists                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Trace Events         | 9 voice event types registered in EventStore (`packages/eventstore/src/schema/events/voice-events.ts`) |
| Metrics Collection   | 10 metrics (201-210) collected in `korevg-session.ts` with specialized analyzers                       |
| OTEL Instrumentation | Voice pipeline spans (`voice_turn` > `stt` > `llm` > `tts`) in `voice-metrics.ts`                      |
| Homer Integration    | RTCP QoS queries via `homer-client.ts` for network MOS, jitter, packet loss                            |
| ClickHouse Storage   | Trace events stored in `abl_platform.platform_events` with buffered writes                             |
| Materialized Views   | Hourly aggregation MV `platform_events_voice_hourly_dest` for dashboard queries                        |
| API Routes           | `GET /api/projects/:projectId/voice-analytics/hourly` and `/summary` endpoints                         |
| Studio Dashboard     | `VoiceAnalyticsPage` with 4 widget sections (Network, Speech, Response, UX)                            |
| Session Detail       | `VoiceMetricsTab` showing per-session voice quality breakdown                                          |
| Web SDK              | `VoiceClient` with pipeline/realtime mode, VAD, barge-in support                                       |

## 3. Goals

1. **G1**: Provide operators with aggregated voice quality KPIs (ASR score, TTS MOS, E2E latency, barge-in rate, silence %, DTMF fallback rate, containment rate) over configurable time ranges (24h, 7d, 30d)
2. **G2**: Enable drill-down from aggregate metrics to individual sessions to identify root causes of quality degradation
3. **G3**: Support comparison of voice quality metrics across agents, time periods, and voice providers
4. **G4**: Detect and surface ASR cascade failures (bad network -> wrong transcription -> wrong response) with root cause attribution
5. **G5**: Provide real-time alerting when voice quality metrics cross configurable thresholds
6. **G6**: Support language/accent-segmented ASR quality analysis (metric 208, currently pending)

## 4. Non-Goals

- **NG1**: Real-time audio stream inspection or live call monitoring (that is a separate "live agent assist" feature)
- **NG2**: Voice biometrics or speaker identification analytics
- **NG3**: Custom STT/TTS model training based on analytics data
- **NG4**: Call recording storage or playback (handled by channel infrastructure)
- **NG5**: Voice bot builder or dialog flow analytics (separate from voice channel quality)

## 5. User Stories

### US-1: Voice Quality Dashboard

**As a** contact center supervisor, **I want to** see aggregated voice quality KPIs on a dashboard **so that** I can monitor overall voice channel health at a glance.

**Acceptance Criteria:**

- Dashboard shows total calls, avg call duration, ASR quality score, TTS MOS, E2E latency, barge-in rate, silence %, DTMF fallback rate
- Time range selector (24h, 7d, 30d) refreshes all metrics
- Trend indicators show % change vs previous period
- Hourly breakdown charts for each metric category

### US-2: Network Quality Monitoring

**As a** platform engineer, **I want to** see network MOS, jitter, and packet loss trends **so that** I can detect infrastructure issues affecting voice quality.

**Acceptance Criteria:**

- Inbound and outbound MOS displayed separately
- Jitter and packet loss visualized as time-series charts
- Color-coded thresholds (green >= 4.0, amber 3.0-3.9, red < 3.0)

### US-3: ASR Quality Analysis

**As a** voice bot designer, **I want to** see ASR quality scores segmented by signal type (repetition, hesitation, correction, clarity, confidence) **so that** I can identify specific recognition issues.

**Acceptance Criteria:**

- Overall ASR score (0-100) with signal breakdown
- Trend chart showing ASR quality over time
- Top issues list with severity badges
- Drill-down to sessions with low ASR scores

### US-4: Response Performance Monitoring

**As a** product manager, **I want to** see E2E response latency distribution **so that** I can ensure voice interactions meet our SLA of < 800ms.

**Acceptance Criteria:**

- Average and P95 E2E latency displayed
- Latency distribution histogram
- Per-agent latency comparison
- Threshold violation count and trend

### US-5: Cascade Failure Detection

**As a** platform engineer, **I want to** be alerted when ASR cascade failures are detected **so that** I can investigate root causes (network vs ASR model).

**Acceptance Criteria:**

- Cascade risk summary (low/medium/high counts)
- Root cause attribution (network, ASR, mixed)
- Problematic turns with contributing factors
- Drill-down to session detail with cascade timeline

### US-6: User Experience Metrics

**As a** contact center supervisor, **I want to** see barge-in rates, DTMF fallback rates, silence percentages, and containment rates **so that** I can evaluate the conversational quality of voice agents.

**Acceptance Criteria:**

- Barge-in rate trend with count
- DTMF fallback rate indicating speech recognition issues
- Silence % breakdown (user/agent/processing/dead air)
- Containment rate (completed vs escalated vs abandoned)

### US-7: Session Drill-Down

**As a** voice bot designer, **I want to** drill down from aggregate metrics to individual session voice quality details **so that** I can investigate specific problematic calls.

**Acceptance Criteria:**

- Click any metric to filter sessions by that quality dimension
- Session list shows voice-specific summary (duration, turns, ASR score, outcome)
- Session detail shows Voice Metrics tab with full breakdown
- Per-turn timing visualization (STT -> LLM -> TTS)

### US-8: Language Segmented Analytics

**As a** internationalization lead, **I want to** see ASR quality metrics segmented by language/accent **so that** I can identify recognition gaps for specific populations.

**Acceptance Criteria:**

- Language distribution pie chart
- ASR quality comparison by language
- Accent-specific issue detection
- Recommendations for language-specific tuning

## 6. Functional Requirements

| ID    | Requirement                                                                                                                                                                      | Priority | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------- |
| FR-1  | Aggregate voice metrics from ClickHouse materialized views with tenant+project isolation                                                                                         | P0       | DONE    |
| FR-2  | Expose `/summary` API returning KPIs for configurable time range (24h/7d/30d)                                                                                                    | P0       | DONE    |
| FR-3  | Expose `/hourly` API returning time-series data for chart rendering                                                                                                              | P0       | DONE    |
| FR-4  | Display 4 dashboard widget sections: Network, Speech, Response, User Experience                                                                                                  | P0       | DONE    |
| FR-5  | Support date range switching (24h/7d/30d) with real-time data refresh                                                                                                            | P0       | DONE    |
| FR-6  | Show trend indicators (% change vs previous period) on KPI cards. Currently: MetricCard component supports trend display but backend does not compute period-over-period change. | P1       | PARTIAL |
| FR-7  | Per-agent voice quality comparison view                                                                                                                                          | P1       | PLANNED |
| FR-8  | Session drill-down from aggregate metrics to session detail                                                                                                                      | P1       | PLANNED |
| FR-9  | ASR cascade failure summary widget with root cause breakdown                                                                                                                     | P0       | DONE    |
| FR-10 | Language/accent segmented ASR quality (metric 208)                                                                                                                               | P2       | PLANNED |
| FR-11 | Configurable alert thresholds for voice quality metrics                                                                                                                          | P2       | PLANNED |
| FR-12 | Export voice analytics data as CSV/JSON                                                                                                                                          | P2       | PLANNED |
| FR-13 | Custom date range picker (beyond preset 24h/7d/30d)                                                                                                                              | P2       | PLANNED |
| FR-14 | Per-turn latency breakdown visualization in session detail                                                                                                                       | P1       | DONE    |
| FR-15 | Real-time voice session count (active calls) display                                                                                                                             | P1       | PLANNED |
| FR-16 | Voice provider comparison (Deepgram vs other STT, ElevenLabs vs other TTS)                                                                                                       | P2       | PLANNED |
| FR-17 | Silence breakdown by phase (greeting/conversation/transfer/farewell)                                                                                                             | P1       | PLANNED |
| FR-18 | Call abandonment phase analysis (where in conversation users drop)                                                                                                               | P1       | DONE    |
| FR-19 | Containment rate tracking with escalation reason classification                                                                                                                  | P0       | DONE    |
| FR-20 | TTS quality proxy MOS with combined network+application score                                                                                                                    | P0       | DONE    |

## 7. Non-Functional Requirements

| ID     | Requirement                                | Target                                  |
| ------ | ------------------------------------------ | --------------------------------------- |
| NFR-1  | Dashboard load time for 30-day aggregation | < 2 seconds                             |
| NFR-2  | API response time for hourly data (7d)     | < 500ms                                 |
| NFR-3  | API response time for summary KPIs         | < 300ms                                 |
| NFR-4  | ClickHouse query execution timeout         | 15 seconds max                          |
| NFR-5  | Data retention for voice analytics         | 730 days (2 years)                      |
| NFR-6  | Concurrent dashboard viewers per tenant    | 50+ without degradation                 |
| NFR-7  | Metric collection overhead per voice turn  | < 5ms                                   |
| NFR-8  | EventStore write throughput                | 10K events per 5s batch                 |
| NFR-9  | Tenant isolation in all analytics queries  | 100% - no cross-tenant data leakage     |
| NFR-10 | Project isolation in all analytics queries | 100% - queries must filter by projectId |

## 8. API Design

### Existing Endpoints (Runtime)

```
GET /api/projects/:projectId/voice-analytics/summary?hours={24|168|720}
Response: { success: true, data: VoiceSummary }

GET /api/projects/:projectId/voice-analytics/hourly?hours={24|168|720}
Response: { success: true, data: VoiceHourlyData[] }
```

### Planned Endpoints

```
GET /api/projects/:projectId/voice-analytics/by-agent?hours={N}&agentName={name}
Response: { success: true, data: VoiceAgentComparison[] }

GET /api/projects/:projectId/voice-analytics/sessions?hours={N}&filter={cascade|low_asr|high_latency}
Response: { success: true, data: VoiceSessionSummary[] }

GET /api/projects/:projectId/voice-analytics/by-language?hours={N}
Response: { success: true, data: VoiceLanguageBreakdown[] }

GET /api/projects/:projectId/voice-analytics/cascade-summary?hours={N}
Response: { success: true, data: CascadeSummary }

GET /api/projects/:projectId/voice-analytics/alerts
Response: { success: true, data: VoiceAlert[] }
```

All endpoints require `session:read` project permission and filter by `tenantId` + `projectId`.

## 9. Data Model

### EventStore Voice Events

| Event Type                   | Schema                          | PII                  | Description                                                |
| ---------------------------- | ------------------------------- | -------------------- | ---------------------------------------------------------- |
| `voice.session.started`      | `VoiceSessionStartedDataSchema` | Yes (caller, called) | Voice session initiated with provider, direction, call SID |
| `voice.session.ended`        | `VoiceSessionEndedDataSchema`   | No                   | Session end with comprehensive metrics summary             |
| `voice.turn.completed`       | `VoiceTurnDataSchema`           | No                   | Per-turn timing, input method, barge-in flag               |
| `voice.stt.completed`        | `VoiceSTTDataSchema`            | No                   | STT result with confidence, provider, language             |
| `voice.tts.completed`        | `VoiceTTSDataSchema`            | No                   | TTS synthesis metrics per turn                             |
| `voice.barge_in.detected`    | `VoiceBargeInDataSchema`        | No                   | User interruption event                                    |
| `voice.asr_quality.analyzed` | `VoiceASRQualityDataSchema`     | No                   | Session-level ASR quality analysis                         |
| `voice.tts_quality.measured` | `VoiceTTSQualityDataSchema`     | No                   | Per-turn TTS quality measurement                           |
| `voice.asr_cascade.detected` | `VoiceASRCascadeDataSchema`     | Yes (transcript)     | Cascade risk detection per turn                            |

### ClickHouse Materialized View

The `platform_events_voice_hourly_dest` materialized view pre-aggregates voice session end events into hourly buckets with the following columns: `session_count`, `error_count`, `sum_call_duration_ms`, MOS sums (inbound/outbound), jitter sums, latency sums, barge-in/DTMF/ASR score sums, turn totals, and sample counts for weighted averaging.

### Key Metrics (IDs 201-210)

| ID  | Metric                       | Implementation                                                                  | Source                                    |
| --- | ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| 201 | ASR Quality Score (0-100)    | Multi-signal analysis (repetition, hesitation, correction, clarity, confidence) | `voice-quality-analyzer.ts`               |
| 202 | TTS MOS (1.0-4.5)            | Proxy MOS (app signals) + Network MOS (RTCP via Homer)                          | `korevg-session.ts` + `homer-client.ts`   |
| 203 | E2E Response Latency         | Speech end to agent speech start timing                                         | Per-turn in `korevg-session.ts`           |
| 204 | Barge-in Rate                | Speech/DTMF interruptions during agent speech                                   | Per-turn detection                        |
| 205 | Silence %                    | Dead air as percentage of total call duration                                   | Phase-based accumulation                  |
| 206 | Containment Rate             | Completed vs escalated vs abandoned sessions                                    | Session outcome tracking                  |
| 207 | Abandonment Phase            | Where in call flow users disconnect                                             | Call phase detection + Homer SIP analysis |
| 208 | Language/Accent Segmentation | ASR quality by language code                                                    | PLANNED                                   |
| 209 | DTMF Fallback Rate           | Button presses vs speech input ratio                                            | Input method tracking                     |
| 210 | ASR Cascade Detection        | Network -> ASR -> intent -> response failure chain                              | `asr-cascade-detector.ts`                 |

## 10. UI Design

### Dashboard Layout (VoiceAnalyticsPage)

```
+-----------------------------------------------------------+
| Voice Analytics                     [24h] [7d] [30d]      |
+-----------------------------------------------------------+
| Total Calls | Avg Duration | ASR Score | TTS MOS          |
| [1,234]     | [3:42]       | [87/100]  | [4.2]            |
| +5.2%       | -2.1%        | +1.3%     | -0.1             |
+-----------------------------------------------------------+
| Network Quality Widget    | Speech Quality Widget          |
| - Inbound MOS chart       | - ASR score trend              |
| - Outbound MOS chart      | - Signal breakdown             |
| - Jitter trend            | - Top issues                   |
| - Packet loss trend       | - Cascade risk summary         |
+-----------------------------------------------------------+
| Response Performance      | User Experience Widget         |
| - E2E latency trend       | - Barge-in rate trend          |
| - Latency distribution    | - DTMF fallback trend          |
| - Per-agent comparison    | - Silence % breakdown          |
|                           | - Containment rate              |
+-----------------------------------------------------------+
```

### Session Detail (VoiceMetricsTab)

Per-session voice quality breakdown with:

- ASR Quality card (score + 5 signal bars)
- TTS Quality card (proxy MOS + network MOS + combined)
- E2E Latency per-turn chart
- Barge-in events timeline
- Call activity breakdown (agent/user/silence stacked bar)
- Containment status badge
- DTMF events list
- Cascade risk indicators per turn

## 11. Accessibility

- All dashboard charts include screen-reader-friendly summary text via `aria-label` attributes
- Color-coded thresholds use both color and icon indicators (checkmark, warning, error icons) to avoid reliance on color alone
- KPI cards are keyboard-navigable with proper focus indicators
- Trend indicators include text labels ("up 5.2%") in addition to directional arrows
- Chart tooltips accessible via keyboard focus, not just hover

## 12. Security & Compliance

- **Tenant Isolation**: All ClickHouse queries include `tenant_id` filter. No cross-tenant data access.
- **Project Isolation**: All queries include `project_id` filter via `requireProjectScope` middleware.
- **Auth**: `authMiddleware` + `requireProjectPermission(req, res, 'session:read')` on all routes.
- **PII**: Voice event data containing PII (caller numbers, transcripts) marked with `containsPII: true` in EventStore schema. PII fields excluded from aggregate analytics queries.
- **Data Retention**: 730-day TTL on ClickHouse tables via `TTL` clause. Compliant with right-to-erasure via tenant-level data deletion.
- **Encryption**: All trace event `data` payloads compressed (gzip) then encrypted at rest in ClickHouse.

## 13. Observability

- **OTEL Spans**: Voice pipeline instrumented with spans: `voice_turn` (parent) > `stt` > `llm` > `tts`
- **Metrics**: 15+ OTEL histogram/counter metrics exported from `voice-metrics.ts` (turn duration, STT/LLM/TTS latency, confidence, barge-in count, etc.)
- **Logging**: Structured logging via `createLogger('voice-analytics-route')` with context (projectId, tenantId, rowCount)
- **Error Tracking**: Query failures logged with stack traces; 503 returned when ClickHouse unavailable
- **Dashboard Health**: API response time tracked; query execution limited to 15s via `SETTINGS max_execution_time = 15`

## 14. Performance Considerations

- **Materialized Views**: Pre-aggregated hourly data avoids full table scans on raw events
- **SummingMergeTree**: Efficient incremental rollups for daily aggregation MVs
- **ReplacingMergeTree**: Idempotent reprocessing support for analytics output tables
- **Query Limits**: 500 row limit on hourly queries; 15s execution timeout
- **Buffered Writes**: 10K events per batch or 5s flush interval for ClickHouse insertion
- **Partition Pruning**: Queries filter by `tenant_id` + `toYYYYMM(timestamp)` for efficient partition selection
- **Sample Count Weighting**: Averages computed from sum/count pairs to handle sparse data correctly

## 15. Testing Strategy

- **E2E Tests**: API-level tests hitting real Runtime + ClickHouse with seeded voice events, verifying tenant isolation, project isolation, and correct aggregation math
- **Integration Tests**: Voice event emission from `KorevgSession` through EventStore to ClickHouse, verifying materialized view population
- **Unit Tests**: `VoiceQualityAnalyzer` signal scoring, `ASRCascadeDetector` risk calculation, `homer-client` MOS computation
- **UI Tests**: Component rendering tests for `VoiceAnalyticsPage`, `NetworkQualityWidget`, `SpeechQualityWidget`, `ResponsePerformanceWidget`, `UserExperienceWidget`
- **Load Tests**: Dashboard query performance under concurrent tenant access

## 16. Rollout Plan

| Phase           | Scope                                                                              | Gate                                                         |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Alpha (current) | Core dashboard with 4 widgets, hourly/summary APIs, 9/10 metrics collected         | Internal testing, seed data verification                     |
| Beta            | Session drill-down, per-agent comparison, cascade summary widget, trend indicators | 50+ real voice sessions analyzed successfully                |
| Stable          | Language segmentation, alerting, export, custom date ranges                        | 500+ sessions, < 2s dashboard load, 0 data leakage incidents |

## 17. Open Questions

| #    | Question                                                                                       | Status   | Decision                                                                                                                                                       |
| ---- | ---------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Should voice analytics be a separate page or embedded in the Observatory?                      | DECIDED  | Separate page under INSIGHTS nav section at `/projects/:projectId/voice-analytics`                                                                             |
| OQ-2 | What is the minimum call volume needed for statistically meaningful aggregates?                | DECIDED  | Show data with any volume; add "low sample" warning when < 30 sessions                                                                                         |
| OQ-3 | Should we support custom metric thresholds per tenant?                                         | INFERRED | Yes, via tenant settings. Default thresholds: MOS >= 4.0, ASR >= 85, latency < 800ms                                                                           |
| OQ-4 | How should metric 208 (language segmentation) handle undetected languages?                     | INFERRED | Group as "unknown" with a note indicating sample count. Do not exclude -- operators need to see total volume including undetected languages to gauge coverage. |
| OQ-5 | Should cascade detection alerts be integrated with the platform alerting system or standalone? | INFERRED | Integrated with `packages/eventstore/src/alerting/` alert scheduler                                                                                            |

## 18. Dependencies

| Dependency                         | Type             | Status                                       |
| ---------------------------------- | ---------------- | -------------------------------------------- |
| ClickHouse                         | Infrastructure   | Available                                    |
| EventStore (`packages/eventstore`) | Package          | Available - voice events registered          |
| Homer API                          | External Service | Available for KoreVG deployments             |
| Deepgram STT                       | External Service | Available - provides confidence scores       |
| ElevenLabs TTS                     | External Service | Available - provides streaming metrics       |
| Pipeline Engine MVs                | Package          | Available - hourly aggregation MV exists     |
| Studio Navigation                  | UI               | Available - voice analytics route registered |
| Runtime auth middleware            | Package          | Available - `authMiddleware` + RBAC          |

## 19. Future Enhancements

- **FE-1**: Real-time streaming voice analytics via WebSocket subscriptions (live call quality dashboard)
- **FE-2**: Anomaly detection on voice quality metrics using statistical models
- **FE-3**: A/B testing framework for voice configurations (different STT/TTS providers, voice IDs)
- **FE-4**: Voice quality regression detection across agent deployments
- **FE-5**: Custom voice quality scorecards per agent/project with configurable weights
- **FE-6**: Integration with call recording playback for issue investigation
- **FE-7**: Predictive analytics for voice infrastructure capacity planning
