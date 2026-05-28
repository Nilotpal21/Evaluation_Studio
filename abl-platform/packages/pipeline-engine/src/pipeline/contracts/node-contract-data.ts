/**
 * Per-node enrichment data.
 *
 * The `activity-metadata.ts` file provides label/description/configSchema/outputSchema/
 * defaultTimeout/defaultRetries for each node type. This file adds the new contract
 * fields that were not previously captured:
 *   - inputRequirements (what the node reads from trigger vs upstream steps)
 *   - compatibleTriggers (trigger allowlist)
 *   - sideEffectClass (read / write / external / pure)
 *   - contractVersion
 *
 * Together, activityMetadata + NODE_ENRICHMENT produce a full NodeContract. The
 * ContractRegistry does that merge.
 *
 * Adding a new node type requires:
 *   1. An entry in activity-metadata.ts (existing pattern).
 *   2. An entry here with enrichment fields.
 *   An integration test in registry.integration.test.ts enforces coverage.
 */

import type { SideEffectClass } from './node-contract.js';

export interface NodeEnrichment {
  inputRequirements: {
    fromTrigger: string[];
    fromPreviousSteps?: Record<string, string[]>;
  };
  compatibleTriggers: string[] | '*';
  sideEffectClass: SideEffectClass;
  contractVersion: number;
}

/**
 * Initial enrichment values (contractVersion 1).
 *
 * Guidelines used when authoring these entries:
 *   - fromTrigger lists only keys the node *requires* from pipelineInput.
 *   - compatibleTriggers is '*' unless the node genuinely cannot work with a trigger
 *     (e.g. read-message-window needs a message-level trigger).
 *   - sideEffectClass: 'read' for DB/HTTP reads, 'write' for persistence, 'external'
 *     for outbound calls (LLM, email, slack, http-request), 'pure' otherwise.
 */
export const NODE_ENRICHMENT: Record<string, NodeEnrichment> = {
  // ── Data (read) ──────────────────────────────────────────────────────
  'read-conversation': {
    inputRequirements: { fromTrigger: ['sessionId'] },
    compatibleTriggers: ['session-ended', 'user-message', 'agent-message', 'manual'],
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'read-message-window': {
    inputRequirements: { fromTrigger: ['sessionId', 'payload'] },
    compatibleTriggers: ['user-message', 'agent-message'],
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'db-query': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'wait-for-event': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },

  // ── Compute (read) ───────────────────────────────────────────────────
  'compute-quality': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-sentiment': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-intent': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'evaluate-resolution': {
    // Reads the classificationRow from compute-intent's previousSteps output
    // plus the conversation transcript. Writes a unified row to
    // intent_classifications (treated as a write side effect).
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['classificationRow', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'write',
    contractVersion: 1,
  },
  'compute-mentions': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-toxicity': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-goal-completion': {
    inputRequirements: { fromTrigger: [], fromPreviousSteps: { upstream: ['messages'] } },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-statistical': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-predictive-features': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'compute-tool-effectiveness': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'evaluate-metrics': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'evaluate-policy': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },
  'aggregate-eval-run': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'read',
    contractVersion: 1,
  },

  // ── External calls ───────────────────────────────────────────────────
  'llm-evaluate': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'conversation-analyzer': {
    inputRequirements: {
      fromTrigger: [],
      fromPreviousSteps: { upstream: ['transcript', 'messages'] },
    },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'http-request': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-notification': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-email': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'send-slack': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'publish-kafka': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'run-legacy-workflow': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'sub-pipeline': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'simulate-persona': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'execute-agent-turn': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'run-eval-conversation': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },
  'judge-conversation': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'external',
    contractVersion: 1,
  },

  // ── Write ────────────────────────────────────────────────────────────
  'store-results': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'write',
    contractVersion: 1,
  },
  'store-insight': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'write',
    contractVersion: 1,
  },

  // ── Pure control flow / data transformation ─────────────────────────
  'node-group': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
  transform: {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
  'inspect-output': {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
  filter: {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
  aggregate: {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
  delay: {
    inputRequirements: { fromTrigger: [] },
    compatibleTriggers: '*',
    sideEffectClass: 'pure',
    contractVersion: 1,
  },
};
