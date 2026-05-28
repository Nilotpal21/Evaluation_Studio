# Voice Analytics — Low-Level Design & Implementation Plan

> **Feature #34** | Created: 2026-03-22 | Status: ALPHA
> Feature Spec: `docs/features/voice-analytics.md`
> Test Spec: `docs/testing/voice-analytics.md`
> HLD: `docs/specs/voice-analytics.hld.md`

## Overview

This plan covers the remaining work to advance Voice Analytics from ALPHA to BETA and then STABLE. The core infrastructure (event collection, ClickHouse storage, materialized views, hourly/summary APIs, and the 4-widget dashboard) is already implemented. This plan addresses the gaps: period-over-period trends, per-agent comparison, session drill-down, cascade summary, language segmentation, alerting, and comprehensive test coverage.

## Current State Assessment

### Already Implemented (ALPHA)

| Component                                   | Files                                                      | Status |
| ------------------------------------------- | ---------------------------------------------------------- | ------ |
| 9 voice event schemas                       | `packages/eventstore/src/schema/events/voice-events.ts`    | DONE   |
| 10 metrics collection (201-210, except 208) | `apps/runtime/src/services/voice/korevg/korevg-session.ts` | DONE   |
| ASR quality analyzer                        | `apps/runtime/src/observability/voice-quality-analyzer.ts` | DONE   |
| ASR cascade detector                        | `apps/runtime/src/observability/asr-cascade-detector.ts`   | DONE   |
| Homer client (network MOS)                  | `apps/runtime/src/services/voice/korevg/homer-client.ts`   | DONE   |
| OTEL voice metrics                          | `apps/runtime/src/observability/voice-metrics.ts`          | DONE   |
| Voice analytics API (summary + hourly)      | `apps/runtime/src/routes/voice-analytics.ts`               | DONE   |
| Hourly materialized view                    | `packages/database/src/clickhouse-schemas/init.ts`         | DONE   |
| Studio dashboard (4 widgets)                | `apps/studio/src/components/voice-analytics/`              | DONE   |
| SWR data hook                               | `apps/studio/src/hooks/useVoiceAnalytics.ts`               | DONE   |
| Session voice metrics tab                   | `apps/studio/src/components/session/VoiceMetricsTab.tsx`   | DONE   |
| Navigation registration                     | `apps/studio/src/config/navigation.ts`                     | DONE   |

### Gaps to Address

| Gap                                              | FR               | Priority | Phase |
| ------------------------------------------------ | ---------------- | -------- | ----- |
| Backend period-over-period trend computation     | FR-6             | P1       | 1     |
| Per-agent voice quality comparison API + UI      | FR-7             | P1       | 2     |
| Session drill-down from aggregate metrics        | FR-8             | P1       | 2     |
| Cascade failure summary API + widget             | FR-9 enhancement | P1       | 2     |
| Language/accent segmented analytics (metric 208) | FR-10            | P2       | 3     |
| Configurable alert thresholds                    | FR-11            | P2       | 3     |
| Export voice analytics as CSV/JSON               | FR-12            | P2       | 4     |
| Custom date range picker                         | FR-13            | P2       | 4     |
| Real-time active call count                      | FR-15            | P1       | 2     |
| Silence breakdown by phase                       | FR-17            | P1       | 2     |
| E2E test coverage                                | Test spec        | P0       | 1     |
| Integration test coverage                        | Test spec        | P0       | 1     |
| Unit test coverage for analyzers                 | Test spec        | P0       | 1     |

---

## Phase 1: Test Coverage + Trend Computation (BETA Foundation)

**Duration**: 3-5 days
**Goal**: Establish comprehensive test coverage and complete period-over-period trend computation.

### Phase 1.1: Unit Tests for Voice Quality Analyzers

**Files to create:**

- `apps/runtime/src/__tests__/voice-quality-analyzer.test.ts`
- `apps/runtime/src/__tests__/asr-cascade-detector.test.ts`
- `apps/runtime/src/__tests__/homer-client-mos.test.ts`

**Implementation:**

1. **VoiceQualityAnalyzer tests** (UNIT-1 through UNIT-5):
   - Test repetition detection with known inputs (turn pairs with 80% overlap -> high score)
   - Test hesitation detection for English, Hindi, Spanish fillers
   - Test correction pattern detection ("no, I said...", "wait, actually...")
   - Test clarity scoring (1-word transcripts score low, 10+ word transcripts score high)
   - Test empty input produces `emptyResult()` (score 100, no issues)
   - Test overall weighted scoring math

2. **ASRCascadeDetector tests** (UNIT-6 through UNIT-8):
   - Low risk scenario: MOS 4.2, confidence 0.95, no repetition -> risk 'low', score < 0.4
   - High risk scenario: MOS 2.5, confidence 0.4, repeated transcripts, agent asks clarification -> risk 'high', score > 0.7
   - Root cause attribution: poor network + good confidence -> 'network'; good network + poor confidence -> 'asr'; both poor -> 'mixed'

3. **Homer MOS computation tests** (UNIT-9, UNIT-10):
   - Known jitter + packet loss values -> expected R-factor and MOS via E-model
   - Homer API error -> null metrics returned (no throw)
   - Note: Homer is an external third-party service; mock its HTTP responses via DI

**Exit Criteria:**

- [ ] All 10 unit test scenarios pass
- [ ] `pnpm test --filter=runtime` passes without regressions
- [ ] Test files follow project conventions (no `vi.mock` of codebase components)

### Phase 1.2: E2E Tests for Voice Analytics API

**Files to create:**

- `apps/runtime/src/__tests__/voice-analytics-api.e2e.test.ts`

**Implementation:**

1. **Test setup**: Start Express server on random port with full middleware chain. Use ClickHouse test database (or mock ClickHouse client for API-level tests if ClickHouse unavailable in CI -- but prefer real ClickHouse).

2. **Seed data helper**: Create `seedVoiceAnalyticsData(client, tenantId, projectId, events)` that inserts rows directly into the hourly MV destination table for test isolation.

3. **Test scenarios** (E2E-1 through E2E-9):
   - Summary endpoint returns correct KPIs for seeded data
   - Hourly endpoint returns time-series with correct aggregation
   - Tenant isolation: T1 auth cannot see T2 data
   - Project isolation: P1 query only returns P1 data
   - Unauthenticated -> 401
   - Missing permission -> 403
   - Empty data -> zeroed KPIs
   - Date range filtering -> correct subset
   - ClickHouse unavailable -> 503

**Exit Criteria:**

- [ ] All 9 E2E scenarios pass
- [ ] Tests exercise real auth middleware (no mocking)
- [ ] Tenant/project isolation verified with cross-tenant queries returning 404

### Phase 1.3: Period-Over-Period Trend Computation

**Files to modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — Add comparison query
- `apps/studio/src/hooks/useVoiceAnalytics.ts` — Add trend data to hook
- `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` — Wire trend to MetricCards

**Implementation:**

1. **Backend**: Add a second ClickHouse query to the `/summary` endpoint that computes KPIs for the _previous_ period (e.g., if current is 7d, compare with previous 7d). Return as `previousPeriod` field.

```sql
-- Current period
WHERE hour >= now() - INTERVAL {hoursBack:UInt32} HOUR
-- Previous period
WHERE hour >= now() - INTERVAL {hoursBack:UInt32} * 2 HOUR
  AND hour < now() - INTERVAL {hoursBack:UInt32} HOUR
```

2. **Response shape change** (backward compatible -- adds fields, does not remove any):

```typescript
// Existing fields remain at the top level for backward compatibility
interface VoiceSummaryResponse {
  success: true;
  data: VoiceSummary & {
    // New fields added alongside existing ones
    trends?: {
      total_calls_change_pct: number | null;
      avg_duration_change_pct: number | null;
      asr_score_change_pct: number | null;
      inbound_mos_change_pct: number | null;
    };
  };
}
```

Note: Existing `VoiceSummary` fields remain at the root `data` level. The `trends` field is added as an optional addition. This preserves backward compatibility with existing Studio code that reads `data.total_calls` directly.

3. **Frontend**: Pass `trends.*` to MetricCard `change` prop. Direction determined by sign (+/- percentage).

**Exit Criteria:**

- [ ] `/summary` returns `trends` field with period-over-period percentages
- [ ] MetricCards show trend arrows with correct direction and percentage
- [ ] Trend is null when previous period has no data (don't show misleading 100% change)
- [ ] E2E test added for trend computation with seeded current + previous data

---

## Phase 2: Drill-Down + Agent Comparison (BETA)

**Duration**: 5-7 days
**Goal**: Enable session drill-down from aggregate metrics and per-agent comparison.

### Phase 2.1: Per-Agent Comparison API

**Files to create/modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — New `/by-agent` endpoint
- ClickHouse MV may need `agent_name` in GROUP BY (check if voice.session.ended already includes agent_name in data payload)

**Implementation:**

1. **MV status**: Confirmed that `agent_name` is in the `platform_events` table but NOT in the voice hourly MV GROUP BY. The MV must be updated to include `agent_name` in the GROUP BY and ORDER BY. This requires dropping and recreating the MV (ClickHouse does not support ALTER on MV definitions). The destination table needs `agent_name` column added via `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

2. **New endpoint**: `GET /api/projects/:projectId/voice-analytics/by-agent?hours={N}`
   - Query hourly MV grouped by `agent_name`
   - Return: `{ agent_name, session_count, avg_mos, avg_asr_score, avg_latency_ms, barge_in_rate }`

3. **UI component**: Create `AgentComparisonWidget.tsx` showing a table/chart comparing agents.

**Exit Criteria:**

- [ ] `/by-agent` endpoint returns per-agent metrics
- [ ] UI shows agent comparison table
- [ ] E2E test verifies per-agent filtering

### Phase 2.2: Session Drill-Down

**Files to create/modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — New `/sessions` endpoint
- `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` — Add drill-down links

**Implementation:**

1. **Session list endpoint**: `GET /api/projects/:projectId/voice-analytics/sessions?hours={N}&filter={cascade|low_asr|high_latency|all}`
   - Query `platform_events` for `voice.session.ended` events matching filter criteria
   - Paginated: `?limit=50&offset=0` (default limit 50, max 200)
   - Return summary per session: `{ session_id, call_duration_ms, total_turns, asr_score, mos, outcome, timestamp }`
   - Response includes `total_count` for pagination UI

2. **Filter criteria**:
   - `cascade`: `cascade_risk_turns > 0`
   - `low_asr`: `overall_asr_score < 70`
   - `high_latency`: `avg_e2e_latency_ms > 800`
   - `all`: no filter (paginated)

3. **UI integration**: MetricCard click navigates to session list filtered by that metric. Session row click navigates to session detail page.

**Exit Criteria:**

- [ ] `/sessions` endpoint returns filtered session list
- [ ] Dashboard metrics are clickable and navigate to filtered session list
- [ ] Session list rows link to session detail with voice metrics tab

### Phase 2.3: Cascade Summary Widget

**Files to create/modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — New `/cascade-summary` endpoint
- `apps/studio/src/components/voice-analytics/CascadeSummaryWidget.tsx`

**Implementation:**

1. **Endpoint**: `GET /api/projects/:projectId/voice-analytics/cascade-summary?hours={N}`
   - Query `platform_events` for `voice.asr_cascade.detected` events
   - Group by `cascade_risk` (low/medium/high) and `root_cause` (network/asr/mixed)
   - Return: `{ risk_distribution: { low, medium, high }, root_cause_distribution: { network, asr, mixed }, affected_sessions, total_cascade_turns }`

2. **Widget**: Donut chart showing risk distribution + root cause breakdown

**Exit Criteria:**

- [ ] `/cascade-summary` returns risk and root cause distributions
- [ ] Widget renders with correct data
- [ ] E2E test with seeded cascade events

### Phase 2.4: Active Call Count + Silence Phase Breakdown

**Files to modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — Add `/active-calls` endpoint
- Widget updates for silence phase breakdown

**Implementation:**

1. **Active calls**: Query Redis for active voice sessions (using existing session store). Return count.
2. **Silence by phase**: If silence data is already broken down by phase in `voice.session.ended` data payload, aggregate in new MV column. Otherwise, this requires enriching the session-end event with phase-level silence data from KorevgSession.

**Exit Criteria:**

- [ ] Active call count displayed on dashboard
- [ ] Silence breakdown shows greeting/conversation/transfer/farewell if data available

---

## Phase 3: Language Segmentation + Alerting (STABLE Foundation)

**Duration**: 5-7 days
**Goal**: Add language/accent segmented analytics and configurable alerting.

### Phase 3.1: Language Segmented Analytics (Metric 208)

**Files to create/modify:**

- `apps/runtime/src/services/voice/korevg/korevg-session.ts` — Add language tracking per turn
- `packages/eventstore/src/schema/events/voice-events.ts` — Add `language` to session.ended schema
- `apps/runtime/src/routes/voice-analytics.ts` — New `/by-language` endpoint
- `apps/studio/src/components/voice-analytics/LanguageBreakdownWidget.tsx`

**Implementation:**

1. **Data collection**: Deepgram already provides `language_code` in STT results. Track dominant language per session (most frequent language across turns). Add to `voice.session.ended` data payload.

2. **MV update**: Add `language` to hourly MV GROUP BY. Create new MV or update existing one.

3. **API endpoint**: `GET /api/projects/:projectId/voice-analytics/by-language?hours={N}`
   - Return: `{ language, session_count, avg_asr_score, avg_mos, avg_latency_ms }`

4. **UI**: Pie chart for language distribution + comparison table for quality metrics by language.

**Exit Criteria:**

- [ ] Language tracked per session in voice.session.ended events
- [ ] `/by-language` endpoint returns language-segmented metrics
- [ ] UI shows language distribution and quality comparison
- [ ] Unknown languages grouped as "unknown" per OQ-4 decision

### Phase 3.2: Configurable Alert Thresholds

**Files to create/modify:**

- `packages/eventstore/src/alerting/` — Add voice-specific alert rules
- `apps/runtime/src/routes/voice-analytics.ts` — New `/alerts` CRUD endpoints
- `apps/studio/src/components/voice-analytics/AlertConfigWidget.tsx`

**Implementation:**

1. **Alert rules**: Integrate with existing `alert-scheduler.ts` in EventStore package. Add voice-specific alert types:
   - `voice.asr_quality_low`: Trigger when avg ASR score drops below threshold
   - `voice.mos_low`: Trigger when avg MOS drops below threshold
   - `voice.latency_high`: Trigger when avg E2E latency exceeds threshold
   - `voice.cascade_spike`: Trigger when cascade risk count exceeds threshold

2. **Default thresholds** (configurable per tenant):
   - ASR score < 70 (warning), < 50 (critical)
   - MOS < 3.5 (warning), < 3.0 (critical)
   - E2E latency > 1000ms (warning), > 2000ms (critical)
   - Cascade high-risk turns > 5% of total turns (warning)

3. **API**: CRUD for alert configurations at project level.

4. **UI**: Alert configuration panel with threshold sliders and notification channel selection.

**Exit Criteria:**

- [ ] Alert rules evaluate on schedule (e.g., every 5 minutes)
- [ ] Alerts fire correctly when thresholds breached
- [ ] Alert configuration UI functional
- [ ] E2E test for alert creation and threshold evaluation

---

## Phase 4: Export + Custom Date Range (STABLE)

**Duration**: 2-3 days
**Goal**: Complete remaining P2 features for STABLE promotion.

### Phase 4.1: Data Export

**Files to create/modify:**

- `apps/runtime/src/routes/voice-analytics.ts` — New `/export` endpoint
- `apps/studio/src/components/voice-analytics/ExportButton.tsx`

**Implementation:**

1. **Endpoint**: `GET /api/projects/:projectId/voice-analytics/export?hours={N}&format={csv|json}`
   - Stream ClickHouse query results as CSV or JSON
   - Include all hourly data with column headers
   - Set Content-Disposition header for file download

2. **PII exclusion**: Export data must NOT include PII fields (caller numbers, raw transcripts). Only aggregate metrics and session IDs are exported.

3. **UI**: Export button in dashboard header. Dropdown for format selection.

**Exit Criteria:**

- [ ] CSV and JSON export work correctly
- [ ] File contains all visible metrics
- [ ] Large date ranges don't timeout (use streaming)

### Phase 4.2: Custom Date Range Picker

**Files to modify:**

- `apps/studio/src/hooks/useVoiceAnalytics.ts` — Accept custom date range
- `apps/studio/src/components/voice-analytics/VoiceAnalyticsPage.tsx` — Add date picker

**Implementation:**

1. Replace fixed [24h/7d/30d] buttons with a date range picker component
2. Convert start/end dates to hours parameter for API calls
3. Validate date range (max 90 days to prevent expensive queries)

**Exit Criteria:**

- [ ] Custom date range selectable
- [ ] API correctly filters by custom range
- [ ] Max 90-day limit enforced client-side and server-side

---

## Wiring Checklist

Every new endpoint or component must be verified in its caller:

| What                        | Wired Into                             | Verification                        |
| --------------------------- | -------------------------------------- | ----------------------------------- |
| `/by-agent` endpoint        | Router registration in `server.ts`     | Route accessible via HTTP           |
| `/sessions` endpoint        | Router registration in `server.ts`     | Route accessible via HTTP           |
| `/cascade-summary` endpoint | Router registration in `server.ts`     | Route accessible via HTTP           |
| `/by-language` endpoint     | Router registration in `server.ts`     | Route accessible via HTTP           |
| `/alerts` endpoints         | Router registration in `server.ts`     | Route accessible via HTTP           |
| `/export` endpoint          | Router registration in `server.ts`     | Route accessible via HTTP           |
| AgentComparisonWidget       | VoiceAnalyticsPage imports and renders | Widget visible on dashboard         |
| CascadeSummaryWidget        | VoiceAnalyticsPage imports and renders | Widget visible on dashboard         |
| LanguageBreakdownWidget     | VoiceAnalyticsPage imports and renders | Widget visible on dashboard         |
| AlertConfigWidget           | VoiceAnalyticsPage or settings page    | Configuration UI accessible         |
| ExportButton                | VoiceAnalyticsPage header              | Button visible and functional       |
| Date range picker           | VoiceAnalyticsPage header              | Picker visible and triggers refetch |

---

## Risk Registry

| Risk                                           | Phase | Mitigation                                                 |
| ---------------------------------------------- | ----- | ---------------------------------------------------------- |
| MV schema changes require ClickHouse migration | 2, 3  | Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`; idempotent DDL |
| Agent name not in hourly MV                    | 2     | Check existing MV; add agent_name if missing               |
| Language detection gaps (undetected languages) | 3     | Group as "unknown"; show sample count warning              |
| Alert false positives with low call volume     | 3     | Require minimum session count before firing alerts         |
| Large export causing memory pressure           | 4     | Use ClickHouse streaming; set row limit                    |

---

## Success Criteria

### ALPHA -> BETA Promotion (Phase 1 + 2 complete)

- [ ] 9 E2E tests pass
- [ ] 7 integration tests pass
- [ ] 10 unit tests pass
- [ ] Period-over-period trends displayed on KPI cards
- [ ] Per-agent comparison available
- [ ] Session drill-down functional
- [ ] Cascade summary widget live
- [ ] 50+ real voice sessions analyzed successfully

### BETA -> STABLE Promotion (Phase 3 + 4 complete)

- [ ] Language segmentation functional
- [ ] Alert thresholds configurable and firing
- [ ] CSV/JSON export working
- [ ] Custom date range picker available
- [ ] 500+ voice sessions processed
- [ ] Dashboard load time < 2 seconds (30-day range)
- [ ] 0 cross-tenant data leakage incidents
- [ ] All 31 test scenarios passing
