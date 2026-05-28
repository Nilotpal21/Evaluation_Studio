/**
 * Metrics HTTP Endpoints (RFC-003 Phase 2)
 *
 * Exposes query performance metrics for monitoring:
 * - GET /metrics - Prometheus format metrics
 * - GET /metrics/summary - JSON aggregate metrics
 * - GET /metrics/queries/:correlationId - Individual query metrics
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { queryMetricsStore } from '../services/metrics/query-metrics.js';

export const metricsRouter: RouterType = Router();

/**
 * GET /metrics
 *
 * Export metrics in Prometheus format for scraping.
 * Used by Prometheus, Grafana, or K8s monitoring.
 */
metricsRouter.get('/metrics', (_req: Request, res: Response) => {
  const prometheusOutput = queryMetricsStore.exportPrometheus();

  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(prometheusOutput);
});

/**
 * GET /metrics/summary
 *
 * Get JSON aggregate metrics for the current time window.
 * Includes latency percentiles, throughput, provider stats.
 */
metricsRouter.get('/metrics/summary', (_req: Request, res: Response) => {
  const summary = queryMetricsStore.getAggregateMetrics();
  const counters = queryMetricsStore.getCounters();

  res.json({
    summary,
    counters,
    activeQueries: queryMetricsStore.getActiveQueryCount(),
  });
});

/**
 * GET /metrics/queries/recent
 *
 * Get recent query history (last 100 queries).
 * For debugging and performance analysis.
 */
metricsRouter.get('/metrics/queries/recent', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const recent = queryMetricsStore.getRecentQueries(limit);

  res.json({
    queries: recent,
    totalQueries: recent.length,
  });
});

/**
 * GET /metrics/queries/:correlationId
 *
 * Get detailed metrics for a specific query by correlation ID.
 */
metricsRouter.get('/metrics/queries/:correlationId', (req: Request, res: Response) => {
  const { correlationId } = req.params;
  const metrics = queryMetricsStore.getQueryByCorrelationId(correlationId);

  if (!metrics) {
    res.status(404).json({ error: 'Query not found' });
    return;
  }

  res.json(metrics);
});
