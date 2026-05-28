# Voice Analytics -- Low-Level Design

## Implementation Structure

### Runtime Route (apps/runtime/src/routes/voice-analytics.ts) -- 217 lines

Mounted at `/api/projects/:projectId/voice-analytics`.

**Middleware chain**: `authMiddleware` -> `requireProjectScope('projectId')`

**GET /hourly** -- Hourly aggregated voice metrics

- Input: `hours` query param (default 168)
- Query: CTE that aggregates sum columns from `platform_events_voice_hourly_dest`, then computes weighted averages
- Output: Array of hourly rows with session_count, error_count, avg MOS, avg jitter, avg latency, avg barge-in rate, avg ASR score, etc.
- Limits: 500 rows, 15s timeout

**GET /summary** -- Summary KPIs

- Input: `hours` query param (default 168)
- Query: Single aggregate across full time range with weighted averages
- Output: Single object with total_calls, total_errors, avg_call_duration_ms, overall MOS scores, latency, barge-in rate, ASR score, etc.
- Limits: 15s timeout

### Weighted Average Computation

The MV stores pre-aggregated sums and sample counts:

```sql
-- For MOS metrics (from SIP quality reports):
if(sum(mos_sample_count) > 0, sum(sum_inbound_mos) / sum(mos_sample_count), NULL)

-- For general metrics:
if(sum(metric_sample_count) > 0, sum(sum_e2e_latency_ms) / sum(metric_sample_count), NULL)
```

### Studio UI

**VoiceAnalyticsPage.tsx** -- Main page component

- Date range selector (24h, 7d, 30d)
- MetricCard components for top-level KPIs with trend indicators
- Four quality widget slots

**useVoiceAnalytics.ts** -- SWR data hook

- Maps DateRange to hours: `{ '24h': 24, '7d': 168, '30d': 720 }`
- Fetches `/summary` and `/hourly` in parallel via SWR
- Returns `{ summary, hourlyData, isLoading, error }`

**Quality Widgets**:

| Widget                      | Metrics                                       |
| --------------------------- | --------------------------------------------- |
| `NetworkQualityWidget`      | Inbound/outbound MOS, inbound/outbound jitter |
| `SpeechQualityWidget`       | ASR score, TTS proxy MOS, silence percentage  |
| `ResponsePerformanceWidget` | End-to-end latency                            |
| `UserExperienceWidget`      | Barge-in rate, DTMF fallback rate             |

### Key Files

| File                                                                | Purpose                 |
| ------------------------------------------------------------------- | ----------------------- |
| `apps/runtime/src/routes/voice-analytics.ts`                        | API route (2 endpoints) |
| `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` | Dashboard page          |
| `apps/studio/src/hooks/useVoiceAnalytics.ts`                        | SWR data hook           |
| `apps/runtime/src/server.ts`                                        | Route mounting          |

### Known Gaps

| ID    | Description                                                                               | Severity |
| ----- | ----------------------------------------------------------------------------------------- | -------- |
| GAP-1 | Debug logging in production code (`log.info('[DEBUG]...')`)                               | Low      |
| GAP-2 | Zero test coverage                                                                        | High     |
| GAP-3 | Uses `(req as any).projectId` instead of typed request                                    | Low      |
| GAP-4 | Inconsistent import: `requireProjectScope` from `@agent-platform/shared` vs `shared-auth` | Low      |
