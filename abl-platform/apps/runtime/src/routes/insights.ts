/**
 * Insights API Routes
 *
 * Mounted at /api/projects/:projectId/insights
 *
 * Cross-pipeline composite queries for the At a Glance dashboard.
 * Queries raw ClickHouse tables directly (not MVs) to avoid the
 * known date/day column inconsistency in materialized views.
 *
 * GET /timeseries   Daily metrics (sentiment, quality, containment, conversations)
 * GET /outcomes     Outcome distribution (resolved/escalated/abandoned) by date
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectWideAnalyticsAccess } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('insights-route');

async function getClickHouse() {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

const latestConversationSentimentSource = `
  (
    SELECT
      session_id,
      argMax(session_started_at, processed_at) AS _started_at,
      argMax(avg_sentiment, processed_at) AS avg_sentiment
    FROM abl_platform.conversation_sentiment
    WHERE tenant_id = {tenantId:String}
      AND project_id = {projectId:String}
      AND session_started_at >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY session_id
  )
`;

const latestQualityEvaluationSource = `
  (
    SELECT
      session_id,
      argMax(session_started_at, processed_at) AS _started_at,
      argMax(overall_score, processed_at) AS overall_score,
      argMax(flagged, processed_at) AS flagged
    FROM abl_platform.quality_evaluations
    WHERE tenant_id = {tenantId:String}
      AND project_id = {projectId:String}
      AND session_started_at >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY session_id
  )
`;

const latestConversationOutcomeSource = `
  (
    SELECT
      session_id,
      argMax(session_started_at, processed_at) AS _started_at,
      argMax(outcome, processed_at) AS outcome
    FROM abl_platform.conversation_outcomes
    WHERE tenant_id = {tenantId:String}
      AND project_id = {projectId:String}
      AND session_started_at >= now() - INTERVAL {days:UInt32} DAY
    GROUP BY session_id
  )
`;

const router: ReturnType<typeof Router> = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

// ── GET /timeseries ─────────────────────────────────────────────────────────
// Returns daily aggregates from raw tables for the last N days.

router.get('/timeseries', async (req, res) => {
  try {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as { projectId: string }).projectId;
    const days = Math.min(Number(req.query.days) || 30, 90);

    const client = await getClickHouse();

    // Query all metrics in parallel from raw tables
    const [sentimentResult, qualityResult, outcomeResult, eventResult] = await Promise.all([
      // Daily sentiment
      client.query({
        query: `
          SELECT toDate(_started_at) AS day,
                 count() AS conversations,
                 avg(avg_sentiment) AS avg_sentiment
          FROM ${latestConversationSentimentSource}
          GROUP BY day ORDER BY day ASC
        `,
        query_params: { tenantId, projectId, days },
        format: 'JSONEachRow',
      }),
      // Daily quality
      client.query({
        query: `
          SELECT toDate(_started_at) AS day,
                 count() AS conversations,
                 avg(overall_score) AS avg_quality,
                 countIf(flagged = 1) AS flagged_count
          FROM ${latestQualityEvaluationSource}
          GROUP BY day ORDER BY day ASC
        `,
        query_params: { tenantId, projectId, days },
        format: 'JSONEachRow',
      }),
      // Daily outcomes
      client.query({
        query: `
          SELECT toDate(_started_at) AS day,
                 outcome,
                 count() AS cnt
          FROM ${latestConversationOutcomeSource}
          GROUP BY day, outcome ORDER BY day ASC
        `,
        query_params: { tenantId, projectId, days },
        format: 'JSONEachRow',
      }),
      // Daily session volume from platform_events
      client.query({
        query: `
          SELECT toDate(timestamp) AS day,
                 count(DISTINCT session_id) AS sessions
          FROM abl_platform.platform_events
          WHERE tenant_id = {tenantId:String}
            AND project_id = {projectId:String}
            AND category = 'session'
            AND event_type = 'session.started'
            AND timestamp >= now() - INTERVAL {days:UInt32} DAY
          GROUP BY day ORDER BY day ASC
        `,
        query_params: { tenantId, projectId, days },
        format: 'JSONEachRow',
      }),
    ]);

    const sentiment = await sentimentResult.json();
    const quality = await qualityResult.json();
    const outcomes = await outcomeResult.json();
    const events = await eventResult.json();

    // Merge all into a single daily array
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dayMap = new Map<string, Record<string, any>>();

    for (const row of events as { day: string; sessions: string }[]) {
      const d = dayMap.get(row.day) || { day: row.day };
      d.conversations = Number(row.sessions);
      dayMap.set(row.day, d);
    }
    for (const row of sentiment as { day: string; avg_sentiment: number }[]) {
      const d = dayMap.get(row.day) || { day: row.day };
      d.sentiment = Number(row.avg_sentiment);
      dayMap.set(row.day, d);
    }
    for (const row of quality as { day: string; avg_quality: number; flagged_count: string }[]) {
      const d = dayMap.get(row.day) || { day: row.day };
      d.quality = Number(row.avg_quality);
      d.flagged = Number(row.flagged_count);
      dayMap.set(row.day, d);
    }
    for (const row of outcomes as { day: string; outcome: string; cnt: string }[]) {
      const d = dayMap.get(row.day) || { day: row.day };
      const outcome = row.outcome.toLowerCase();
      if (outcome === 'contained_resolved') {
        d.resolved = (d.resolved || 0) + Number(row.cnt);
      } else if (outcome.includes('escalat')) {
        d.escalated = (d.escalated || 0) + Number(row.cnt);
      } else {
        // contained_unresolved, contained_partial, contained, abandoned, etc.
        d.other = (d.other || 0) + Number(row.cnt);
      }
      dayMap.set(row.day, d);
    }

    const daily = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    // Compute containment rate per day
    for (const d of daily) {
      const total = (d.resolved || 0) + (d.escalated || 0) + (d.other || 0);
      d.containment = total > 0 ? ((d.resolved || 0) / total) * 100 : 0;
      d.escalation = total > 0 ? ((d.escalated || 0) / total) * 100 : 0;
    }

    res.json({ success: true, data: { daily } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to query insights timeseries', { error: message });
    res.status(500).json({ success: false, error: 'Failed to query insights timeseries' });
  }
});

// ── GET /outcomes ───────────────────────────────────────────────────────────
// Returns outcome totals for the date range.

router.get('/outcomes', async (req, res) => {
  try {
    if (!(await requireProjectWideAnalyticsAccess(req, res))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as { projectId: string }).projectId;
    const days = Math.min(Number(req.query.days) || 30, 90);

    const client = await getClickHouse();

    const result = await client.query({
      query: `
        SELECT outcome, count() AS cnt
        FROM ${latestConversationOutcomeSource}
        GROUP BY outcome ORDER BY cnt DESC
      `,
      query_params: { tenantId, projectId, days },
      format: 'JSONEachRow',
    });

    const rows = await result.json();

    res.json({ success: true, data: { outcomes: rows } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to query outcomes', { error: message });
    res.status(500).json({ success: false, error: 'Failed to query outcomes' });
  }
});

export default router;
