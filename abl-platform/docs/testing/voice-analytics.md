# Voice Analytics — Test Specification

> **Feature #34** | Created: 2026-03-22 | Status: ALPHA
> Linked Feature Spec: `docs/features/voice-analytics.md`

## Current State

| Dimension                           | Status                                              |
| ----------------------------------- | --------------------------------------------------- |
| E2E API tests                       | NOT STARTED                                         |
| Integration tests                   | NOT STARTED                                         |
| Unit tests (voice-quality-analyzer) | EXISTS but no dedicated file                        |
| Unit tests (asr-cascade-detector)   | EXISTS but no dedicated file                        |
| UI component tests                  | EXISTS (SessionSummaryPanel-voice-metrics.test.tsx) |
| Voice mode resolver tests           | EXISTS (voice-mode-resolver.test.ts)                |
| Voice credential cache tests        | EXISTS (voice-credential-cache.test.ts)             |

## Health Dashboard

| Category                           | Tests       | Passing | Gaps               |
| ---------------------------------- | ----------- | ------- | ------------------ |
| Voice Analytics API (E2E)          | 0           | 0       | 9 scenarios needed |
| Voice Event Pipeline (Integration) | 0           | 0       | 6 scenarios needed |
| Voice Quality Analyzers (Unit)     | 0 dedicated | N/A     | 5 scenarios needed |
| Dashboard UI (Component)           | 1 file      | Unknown | 3 scenarios needed |
| Cascade Detection (Unit)           | 0 dedicated | N/A     | 3 scenarios needed |

## Test Coverage Map

### E2E Test Scenarios (API-level, real servers, no mocks)

| ID    | Scenario                                                                     | Priority | Status  | Notes                                                            |
| ----- | ---------------------------------------------------------------------------- | -------- | ------- | ---------------------------------------------------------------- |
| E2E-1 | Voice analytics summary endpoint returns correct KPIs for seeded data        | P0       | PLANNED | Seed voice session end events in ClickHouse, verify summary math |
| E2E-2 | Voice analytics hourly endpoint returns time-series with correct aggregation | P0       | PLANNED | Verify hourly bucket math, MOS weighted averages                 |
| E2E-3 | Tenant isolation: tenant A cannot see tenant B's voice analytics             | P0       | PLANNED | Seed data for 2 tenants, verify strict isolation                 |
| E2E-4 | Project isolation: project A data does not leak into project B queries       | P0       | PLANNED | Seed data for 2 projects under same tenant                       |
| E2E-5 | Auth required: unauthenticated requests return 401                           | P0       | PLANNED | No auth token, verify rejection                                  |
| E2E-6 | Permission required: user without session:read gets 403                      | P0       | PLANNED | Auth token without session:read permission                       |
| E2E-7 | Empty data: summary returns zeroed KPIs when no voice sessions exist         | P1       | PLANNED | Clean project, verify graceful zero response                     |
| E2E-8 | Date range filtering: 24h/7d/30d return different result sets                | P1       | PLANNED | Seed events at different timestamps, verify filtering            |
| E2E-9 | ClickHouse unavailable: returns 503 gracefully                               | P1       | PLANNED | Test error path when analytics service down                      |

### Integration Test Scenarios (real service boundaries, no codebase mocks)

| ID    | Scenario                                                                             | Priority | Status  | Notes                                                                                                         |
| ----- | ------------------------------------------------------------------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| INT-1 | Voice event emission: KorevgSession emits voice.session.ended with all metric fields | P0       | PLANNED | Verify EventStore receives complete event with correct schema                                                 |
| INT-2 | Materialized view population: voice session end events aggregate into hourly MV      | P0       | PLANNED | Insert raw events, query MV, verify sums                                                                      |
| INT-3 | Homer QoS integration: homer-client fetches RTCP data and computes network MOS       | P1       | PLANNED | Mock Homer API via DI (external third-party service, mocking permitted per E2E rules), verify MOS computation |
| INT-4 | Voice quality analyzer: multi-signal ASR scoring produces correct 0-100 score        | P0       | PLANNED | Feed known transcripts, verify signal weights and scoring                                                     |
| INT-5 | ASR cascade detector: risk scoring with known signals produces expected risk levels  | P0       | PLANNED | Feed turns with known cascade patterns, verify detection                                                      |
| INT-6 | EventStore schema validation: voice events with invalid data are rejected            | P1       | PLANNED | Send malformed events, verify Zod validation catches them                                                     |
| INT-7 | Weighted average computation: MOS averages use sample counts correctly               | P0       | PLANNED | Verify sum/count weighted average math matches manual calculation                                             |

### Unit Test Scenarios

| ID      | Scenario                                                                     | Priority | Status  | Notes |
| ------- | ---------------------------------------------------------------------------- | -------- | ------- | ----- |
| UNIT-1  | VoiceQualityAnalyzer: repetition detection scores known inputs correctly     | P0       | PLANNED |       |
| UNIT-2  | VoiceQualityAnalyzer: hesitation pattern detection across languages          | P1       | PLANNED |       |
| UNIT-3  | VoiceQualityAnalyzer: correction pattern detection                           | P1       | PLANNED |       |
| UNIT-4  | VoiceQualityAnalyzer: clarity scoring for short transcripts                  | P1       | PLANNED |       |
| UNIT-5  | VoiceQualityAnalyzer: empty turns produce correct empty result               | P0       | PLANNED |       |
| UNIT-6  | ASRCascadeDetector: low risk for good network + high confidence              | P0       | PLANNED |       |
| UNIT-7  | ASRCascadeDetector: high risk for poor network + low confidence + repetition | P0       | PLANNED |       |
| UNIT-8  | ASRCascadeDetector: root cause attribution (network vs ASR vs mixed)         | P1       | PLANNED |       |
| UNIT-9  | Homer client: MOS computation from jitter + packet loss via E-model          | P0       | PLANNED |       |
| UNIT-10 | Homer client: graceful degradation when Homer unreachable                    | P1       | PLANNED |       |

### UI Component Test Scenarios

| ID   | Scenario                                                      | Priority | Status  | Notes |
| ---- | ------------------------------------------------------------- | -------- | ------- | ----- |
| UI-1 | VoiceAnalyticsPage renders loading skeleton during data fetch | P1       | PLANNED |       |
| UI-2 | VoiceAnalyticsPage renders all 4 widget sections with data    | P0       | PLANNED |       |
| UI-3 | MetricCard displays value, unit, and trend correctly          | P1       | PLANNED |       |
| UI-4 | Date range selector triggers data refetch                     | P1       | PLANNED |       |
| UI-5 | Error state displays user-friendly message when API fails     | P1       | PLANNED |       |

## E2E Test Architecture

### Test Infrastructure Requirements

1. **Real Express server**: Start Runtime on random port (`{ port: 0 }`) with full middleware chain (auth, RBAC, tenant scope)
2. **Real ClickHouse**: Use test ClickHouse instance with isolated test database
3. **Auth context**: Use test JWT tokens with known tenant/project/permissions
4. **Data seeding**: Insert voice events directly into ClickHouse `platform_events` table via ClickHouse client (not via Mongoose -- this is ClickHouse, not MongoDB)
5. **Cleanup**: Drop test data after each test suite

### E2E-1: Voice Analytics Summary Endpoint

```
GIVEN: 10 voice.session.ended events seeded in ClickHouse for tenant T1, project P1
  - 5 sessions with avg MOS 4.2, avg latency 650ms, avg ASR score 88
  - 5 sessions with avg MOS 3.8, avg latency 900ms, avg ASR score 72
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168
  with auth token for tenant T1, session:read permission
THEN: Response is { success: true, data: { total_calls: 10, overall_avg_inbound_mos: ~4.0, overall_avg_latency_ms: ~775, overall_asr_score: ~80 } }
AND: HTTP status 200
AND: Response time < 500ms
```

### E2E-2: Voice Analytics Hourly Endpoint

```
GIVEN: Voice session end events at different hours for tenant T1, project P1
  - 3 events at hour H1, 2 events at hour H2, 5 events at hour H3
WHEN: GET /api/projects/P1/voice-analytics/hourly?hours=168
  with auth token for tenant T1
THEN: Response contains 3 hourly buckets
AND: Each bucket has correct session_count (3, 2, 5)
AND: Weighted averages computed correctly from sum/count pairs
AND: Rows ordered by hour DESC
```

### E2E-3: Tenant Isolation

```
GIVEN: 5 voice events for tenant T1/project P1 and 3 voice events for tenant T2/project P2
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168 with T1 auth
THEN: total_calls = 5 (not 8)
WHEN: GET /api/projects/P2/voice-analytics/summary?hours=168 with T2 auth
THEN: total_calls = 3 (not 8)
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168 with T2 auth
THEN: Returns 404 (cross-tenant access returns 404, not 403)
```

### E2E-4: Project Isolation

```
GIVEN: Tenant T1 with project P1 (5 events) and project P2 (3 events)
WHEN: GET /api/projects/P1/voice-analytics/summary with T1 auth
THEN: total_calls = 5
WHEN: GET /api/projects/P2/voice-analytics/summary with T1 auth
THEN: total_calls = 3
AND: No data leakage between projects
```

### E2E-5: Auth Required

```
GIVEN: Voice events exist
WHEN: GET /api/projects/P1/voice-analytics/summary without auth header
THEN: HTTP 401
AND: Response body contains error message
```

### E2E-6: Permission Required

```
GIVEN: Auth token for tenant T1 with NO session:read permission
WHEN: GET /api/projects/P1/voice-analytics/summary
THEN: HTTP 403
```

### E2E-7: Empty Data

```
GIVEN: No voice events for tenant T1, project P1
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168
THEN: { success: true, data: { total_calls: 0, overall_avg_inbound_mos: null, ... } }
AND: No error, graceful zero state
```

### E2E-8: Date Range Filtering

```
GIVEN: Voice events seeded at:
  - 6 hours ago (within 24h window)
  - 3 days ago (within 7d window, outside 24h)
  - 15 days ago (within 30d window, outside 7d)
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=24
THEN: total_calls includes only the 6-hours-ago events
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168
THEN: total_calls includes 6h + 3d events
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=720
THEN: total_calls includes all three
```

### E2E-9: ClickHouse Unavailable

```
GIVEN: ClickHouse client returns null (service unavailable)
WHEN: GET /api/projects/P1/voice-analytics/summary?hours=168
THEN: HTTP 503
AND: { success: false, error: 'Analytics service unavailable' }
AND: Error logged with context
```

## Integration Test Architecture

### INT-1: Voice Event Emission

```
GIVEN: A simulated voice session with 5 turns
WHEN: KorevgSession completes and emits voice.session.ended
THEN: EventStore receives event with:
  - call_duration_ms > 0
  - total_turns = 5
  - reason in ['user_hangup', 'agent_hangup', 'timeout', 'error']
  - voice_provider in ['twilio', 'korevg', 'livekit']
  - Optional: homer QoS fields present when Homer available
```

### INT-2: Materialized View Population

```
GIVEN: 5 raw voice.session.ended events inserted into platform_events for tenant T1, project P1
  - Events at hours H1 (2 events), H2 (3 events) with known metric values
WHEN: ClickHouse processes the materialized view
THEN: platform_events_voice_hourly_dest contains 2 rows (H1, H2)
AND: H1 row has session_count = 2, sum_call_duration_ms = sum of 2 events
AND: H2 row has session_count = 3, sum_call_duration_ms = sum of 3 events
AND: mos_sample_count only counts events where MOS data was present
AND: Weighted averages recomputed from sums match expected values
```

### INT-3: Homer QoS Integration

```
GIVEN: A mock Homer API server (external third-party service, DI-mocked) returning:
  - RTCP QoS data: inbound jitter 15ms, packet loss 0.02, outbound jitter 20ms, packet loss 0.05
WHEN: homer-client.getQosMetrics(callId) is called
THEN: Returns RtcpQosMetrics with correct directional data
AND: Network MOS computed via E-model: R = 93.2 - jitter_impact - loss_impact
AND: Inbound MOS ~ 4.2 (low jitter + low loss)
AND: Outbound MOS ~ 3.8 (higher jitter + higher loss)
WHEN: Homer API returns 500 error
THEN: Returns null metrics gracefully (no throw)
AND: Log warning emitted
```

### INT-4: Voice Quality Analyzer

```
GIVEN: 5 turns with known transcripts:
  - Turn 1: "Hello, I need help with my bill" (clear, high confidence)
  - Turn 2: "Um, uh, can you, like, check my account" (hesitation)
  - Turn 3: "No, I said BILLING not building" (correction)
  - Turn 4: "yes" (short/unclear)
  - Turn 5: "I need help with my bill" (repetition of turn 1)
WHEN: VoiceQualityAnalyzer.analyzeQuality(turns)
THEN: Overall score < 70 (multiple quality issues)
AND: signals.hesitation > 0.3 (turn 2 has fillers)
AND: signals.correction > 0.3 (turn 3 has correction)
AND: signals.clarity > 0 (turn 4 is very short)
AND: signals.repetition > 0 (turn 5 repeats turn 1)
AND: issues array contains items with type 'hesitation', 'correction'
```

### INT-5: ASR Cascade Detector

```
GIVEN: A turn with:
  - inboundNetworkMos = 2.5 (poor network)
  - confidence = 0.4 (low ASR confidence)
  - short transcript "yes" (2 words)
  - agent asked for clarification
WHEN: ASRCascadeDetector.detectCascadeRisk(turn)
THEN: risk = 'high' (multiple converging signals)
AND: rootCause = 'network' (primary driver is poor MOS)
AND: factors includes 'poor_network', 'low_confidence'
AND: score > 0.7
```

## Iteration Log

### Iteration 1 — 2026-03-22 (Spec Creation)

- **Goal**: Generate test spec grounded in feature spec and codebase analysis
- **Findings**: No dedicated E2E or integration tests exist for voice analytics APIs. Unit tests for voice quality analyzer and cascade detector exist inline within larger test files but have no dedicated test files.
- **Existing tests found**: 9 voice-related test files in runtime (mode resolver, credential cache, realtime executor, twilio sig, livekit E2E, etc.) and 1 in studio (SessionSummaryPanel-voice-metrics). None test the analytics aggregation pipeline.
- **Gap Assessment**: Critical gap in E2E testing of analytics API endpoints (tenant isolation, project isolation, aggregation math). This is the highest-priority gap.
