import type { Questionnaire } from '../schemas/questionnaire.schema.js';
import type { Tier } from '../types/topology.types.js';

/**
 * Tier boundary thresholds from design doc Section 8.
 *
 * A questionnaire is classified into the highest tier where ANY
 * dimension exceeds the lower tier's ceiling.
 */
interface TierBoundary {
  maxAgents: number;
  maxConcurrentConversations: number;
  maxDocuments: number;
  maxMessagesPerDay: number;
  maxWorkflowExecutionsPerDay: number;
}

const TIER_BOUNDARIES: Record<Exclude<Tier, 'XL'>, TierBoundary> = {
  S: {
    maxAgents: 10,
    maxConcurrentConversations: 1000,
    maxDocuments: 10000,
    maxMessagesPerDay: 10000,
    maxWorkflowExecutionsPerDay: 1000,
  },
  M: {
    maxAgents: 100,
    maxConcurrentConversations: 50000,
    maxDocuments: 500000,
    maxMessagesPerDay: 500000,
    maxWorkflowExecutionsPerDay: 100000,
  },
  L: {
    maxAgents: 1000,
    maxConcurrentConversations: 500000,
    maxDocuments: 5000000,
    maxMessagesPerDay: 5000000,
    maxWorkflowExecutionsPerDay: 1000000,
  },
};

/** Extract the classification-relevant dimensions from a questionnaire */
export interface ClassificationInput {
  agentCount: number;
  concurrentConversations: number;
  totalDocuments: number;
  messagesPerDay: number;
  workflowExecutionsPerDay?: number;
}

function extractClassificationInput(q: Questionnaire): ClassificationInput {
  return {
    agentCount: q.agents.agentCount,
    concurrentConversations: q.agents.concurrentConversations,
    totalDocuments: q.knowledgeBase.totalDocuments,
    messagesPerDay: q.agents.messagesPerDay,
    workflowExecutionsPerDay: q.workflows.executionsPerDay,
  };
}

function fitsWithinBoundary(input: ClassificationInput, boundary: TierBoundary): boolean {
  return (
    input.agentCount <= boundary.maxAgents &&
    input.concurrentConversations <= boundary.maxConcurrentConversations &&
    input.totalDocuments <= boundary.maxDocuments &&
    input.messagesPerDay <= boundary.maxMessagesPerDay &&
    (input.workflowExecutionsPerDay ?? 0) <= boundary.maxWorkflowExecutionsPerDay
  );
}

/**
 * Classify a questionnaire (or raw dimensions) into a deployment tier.
 *
 * Uses a highest-tier-wins strategy: if ANY dimension exceeds the
 * boundary for a tier, the next tier up is selected.
 */
export function classifyTier(input: ClassificationInput | Questionnaire): Tier {
  const dims =
    'agentCount' in input
      ? (input as ClassificationInput)
      : extractClassificationInput(input as Questionnaire);

  if (fitsWithinBoundary(dims, TIER_BOUNDARIES.S)) return 'S';
  if (fitsWithinBoundary(dims, TIER_BOUNDARIES.M)) return 'M';
  if (fitsWithinBoundary(dims, TIER_BOUNDARIES.L)) return 'L';
  return 'XL';
}
