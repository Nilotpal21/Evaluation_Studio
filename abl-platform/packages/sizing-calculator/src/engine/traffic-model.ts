import type { Questionnaire } from '../schemas/questionnaire.schema.js';

/**
 * Enterprise traffic distribution model.
 * Assumes business-hours traffic with a concentrated peak window.
 */
const ENTERPRISE_TRAFFIC = {
  businessDayHours: 8,
  peakWindowHours: 2,
  peakTrafficPercent: 0.4,
  normalWindowHours: 6,
  normalTrafficPercent: 0.6,
} as const;

/**
 * Convert a daily volume into estimated peak requests-per-second.
 *
 * Model: 40% of daily traffic lands in a 2-hour peak window.
 * Peak RPS = (dailyVolume * 0.4 / 2) / 3600
 */
export function peakRps(dailyVolume: number): number {
  if (dailyVolume <= 0) return 0;
  const peakHourVolume =
    (dailyVolume * ENTERPRISE_TRAFFIC.peakTrafficPercent) / ENTERPRISE_TRAFFIC.peakWindowHours;
  return peakHourVolume / 3600;
}

/**
 * Estimate expected peak RPS for a given ABL Platform service
 * based on questionnaire workload inputs.
 */
export function expectedRps(service: string, q: Questionnaire): number {
  switch (service) {
    case 'runtime': {
      // When concurrentConversations is provided, use it directly as the
      // concurrency ceiling (each conversation holds one open connection).
      if (q.agents.concurrentConversations > 0) {
        return q.agents.concurrentConversations;
      }
      // Fallback: derive from daily message volume scaled by tool calls.
      return peakRps(q.agents.messagesPerDay) * q.agents.toolCallsPerConversation;
    }

    case 'search-ai-runtime':
      return peakRps(q.knowledgeBase.vectorSearchQueriesPerDay);

    case 'search-ai': {
      // Real-time ingestion treats every document as a potential burst.
      if (q.knowledgeBase.ingestionFrequency === 'real-time') {
        return peakRps(q.knowledgeBase.totalDocuments);
      }
      // Batch ingestion spreads documents over a 16-hour processing window.
      return q.knowledgeBase.totalDocuments / (16 * 3600);
    }

    case 'bge-m3':
      // Embedding model serves both ingestion (chunked) and query embedding.
      return expectedRps('search-ai', q) * 10 + expectedRps('search-ai-runtime', q);

    case 'workflow-engine':
      return peakRps(q.workflows.executionsPerDay) * q.workflows.avgStepsPerWorkflow;

    case 'studio':
      return q.observability.adminUsers * 0.5;

    case 'admin':
      return q.observability.adminUsers * 0.1;

    case 'preprocessing':
      return expectedRps('search-ai', q) * 5;

    case 'docling': {
      const heavyDocTypes = ['pdf', 'image', 'video'];
      const heavyDocFraction =
        q.knowledgeBase.documentTypes.filter((t) => heavyDocTypes.includes(t)).length /
        Math.max(q.knowledgeBase.documentTypes.length, 1);
      return expectedRps('search-ai', q) * heavyDocFraction;
    }

    default:
      return 0;
  }
}
