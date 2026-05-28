import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { DiskGrowthProjection } from '../types/topology.types.js';

const RETENTION_MONTHS: Record<string, number> = {
  '7d': 0.25,
  '30d': 1,
  '90d': 3,
  '1y': 12,
  '2y': 24,
  '3y': 36,
  '7y': 84,
  indefinite: 120,
  'until-deleted': 120,
};

const AVG_CHUNKS_PER_DOC: Record<string, number> = {
  small: 10,
  medium: 50,
  large: 150,
  xl: 400,
};

const KB_PER_BYTE = 1 / 1024;
const GB_PER_KB = 1 / (1024 * 1024);
const GB = 1;

/**
 * Calculate monthly disk growth projections for all data stores.
 *
 * Uses formulas from design doc Section 5:
 * Monthly disk = Σ (feature_volume × per_unit_size × retention_multiplier)
 */
export function calculateDiskGrowth(q: Questionnaire): DiskGrowthProjection[] {
  return [
    calculateMongoGrowth(q),
    calculateClickhouseGrowth(q),
    calculateOpensearchGrowth(q),
    calculateNeo4jGrowth(q),
    calculateQdrantGrowth(q),
    calculateRestateGrowth(q),
    calculateRedisGrowth(q),
  ];
}

/** MongoDB: conversations, messages, audit logs — ~1KB/msg, ~5KB/conv, ~2KB/audit */
export function calculateMongoGrowth(q: Questionnaire): DiskGrowthProjection {
  const daysPerMonth = 30;

  // Messages: messagesPerDay × 1KB × 30 days
  const messagesGB = q.agents.messagesPerDay * daysPerMonth * 1 * GB_PER_KB;

  // Conversations: messagesPerDay / avgConversationLength × 5KB × 30 days
  const conversationsPerDay = q.agents.messagesPerDay / Math.max(q.agents.avgConversationLength, 1);
  const conversationsGB = conversationsPerDay * daysPerMonth * 5 * GB_PER_KB;

  // Audit logs: ~10% of message volume × 2KB
  const auditGB = q.agents.messagesPerDay * 0.1 * daysPerMonth * 2 * GB_PER_KB;

  const monthlyGB = messagesGB + conversationsGB + auditGB;

  return {
    storeName: 'mongodb',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['messages', 'sessions', 'audit-logs'],
  };
}

/** ClickHouse: traces, metrics, usage — ~500B/trace, ~200B/metric */
export function calculateClickhouseGrowth(q: Questionnaire): DiskGrowthProjection {
  const daysPerMonth = 30;

  // Traces: ~2 trace events per message × 500B each
  const tracesGB = q.agents.messagesPerDay * 2 * daysPerMonth * 0.5 * GB_PER_KB;

  // Metrics: ~1 metric per message × 200B each
  const metricsGB = q.agents.messagesPerDay * daysPerMonth * 0.2 * GB_PER_KB;

  // Usage events: ~0.5 per message × 200B
  const usageGB = q.agents.messagesPerDay * 0.5 * daysPerMonth * 0.2 * GB_PER_KB;

  const monthlyGB = tracesGB + metricsGB + usageGB;

  return {
    storeName: 'clickhouse',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['trace-events', 'metrics', 'usage-events'],
  };
}

/** OpenSearch: chunks + vector embeddings — ~4KB/chunk text + ~4KB/vector (1024-dim) */
export function calculateOpensearchGrowth(q: Questionnaire): DiskGrowthProjection {
  const chunksPerDoc = AVG_CHUNKS_PER_DOC[q.knowledgeBase.avgDocumentSize] ?? 50;

  // Monthly new documents (approximate based on ingestion frequency)
  const monthlyNewDocs = estimateMonthlyNewDocs(q);

  // Each chunk: ~4KB text + ~4KB vector = ~8KB
  const chunkSizeKB = 8;
  const monthlyGB = monthlyNewDocs * chunksPerDoc * chunkSizeKB * GB_PER_KB;

  return {
    storeName: 'opensearch',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['document-chunks', 'vector-embeddings'],
  };
}

/** Neo4j: knowledge graph — ~200B/node, ~100B/relationship */
export function calculateNeo4jGrowth(q: Questionnaire): DiskGrowthProjection {
  const chunksPerDoc = AVG_CHUNKS_PER_DOC[q.knowledgeBase.avgDocumentSize] ?? 50;
  const monthlyNewDocs = estimateMonthlyNewDocs(q);

  // ~1 node per chunk, ~3 relationships per node
  const nodesPerMonth = monthlyNewDocs * chunksPerDoc;
  const relsPerMonth = nodesPerMonth * 3;

  const nodeGB = nodesPerMonth * 0.2 * GB_PER_KB;
  const relGB = relsPerMonth * 0.1 * GB_PER_KB;
  const monthlyGB = nodeGB + relGB;

  return {
    storeName: 'neo4j',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['graph-nodes', 'relationships'],
  };
}

/** Qdrant: vector points — ~4KB/point (1024-dim float32) */
export function calculateQdrantGrowth(q: Questionnaire): DiskGrowthProjection {
  const chunksPerDoc = AVG_CHUNKS_PER_DOC[q.knowledgeBase.avgDocumentSize] ?? 50;
  const monthlyNewDocs = estimateMonthlyNewDocs(q);

  // Each vector point: ~4KB (1024 dimensions × 4 bytes)
  const monthlyGB = monthlyNewDocs * chunksPerDoc * 4 * GB_PER_KB;

  return {
    storeName: 'qdrant',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['vector-points'],
  };
}

/** Restate: journal entries — ~1KB/step execution */
export function calculateRestateGrowth(q: Questionnaire): DiskGrowthProjection {
  const daysPerMonth = 30;

  // Each workflow execution: avgSteps × 1KB
  const monthlyGB =
    q.workflows.executionsPerDay * q.workflows.avgStepsPerWorkflow * daysPerMonth * 1 * GB_PER_KB;

  return {
    storeName: 'restate',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 12 * 100) / 100,
    drivers: ['journal-entries', 'workflow-state'],
  };
}

/** Redis: ephemeral — growth is bounded by TTL, negligible persistent growth */
export function calculateRedisGrowth(q: Questionnaire): DiskGrowthProjection {
  // Redis is ephemeral with TTLs — minimal persistent disk growth
  // Calculate peak memory footprint instead
  const sessionMB = (q.agents.concurrentConversations * 2) / 1024; // ~2KB per session
  const monthlyGB = sessionMB / 1024;

  return {
    storeName: 'redis',
    monthlyGB: Math.round(monthlyGB * 100) / 100,
    yearlyGB: Math.round(monthlyGB * 100) / 100, // Same — TTL-bounded
    drivers: ['session-state'],
  };
}

function estimateMonthlyNewDocs(q: Questionnaire): number {
  const monthlyMultiplier: Record<string, number> = {
    'one-time': 0, // No monthly growth after initial load
    daily: 30,
    hourly: 720,
    'real-time': 2160, // ~3x hourly
  };

  const multiplier = monthlyMultiplier[q.knowledgeBase.ingestionFrequency] ?? 1;

  if (multiplier === 0) {
    // One-time: assume 1% of total docs re-indexed per month (updates)
    return q.knowledgeBase.totalDocuments * 0.01;
  }

  // Estimate daily docs from total / initial load period (assume 30-day ramp)
  const dailyNewDocs = Math.max(q.knowledgeBase.totalDocuments / 100, 10);
  return dailyNewDocs * (multiplier / 30);
}
