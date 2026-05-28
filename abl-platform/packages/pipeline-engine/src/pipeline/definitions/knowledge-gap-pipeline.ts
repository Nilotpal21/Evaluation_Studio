/**
 * Knowledge Gap Analysis Pipeline Definition (Batch Only)
 *
 * Triggers: abl.session.ended (batch)
 * Steps: read-conversation → conversation-analyzer (knowledge_gap) → store-results
 * Output: knowledge_gap_evaluations ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const KNOWLEDGE_GAP_PIPELINE_ID = 'builtin:knowledge-gap-analysis';

export const knowledgeGapPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'knowledge_gap',
  name: 'Knowledge Gap Analysis',
  description:
    'Identifies gaps in knowledge base coverage by analyzing retrieval precision and uncovered topics',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'flagThreshold',
        type: 'number',
        required: false,
        description: 'Score threshold for flagging a knowledge gap',
      },
      {
        name: 'systemPromptOverride',
        type: 'string',
        required: false,
        description: 'Override the system prompt for knowledge gap evaluation',
        reprocessOnChange: true,
      },
    ],
  },

  supportedTriggers: [
    {
      id: 'batch',
      type: 'kafka',
      kafkaTopic: 'abl.session.ended',
      strategy: 'batch',
      label: 'On session end',
      description: 'Analyzes full conversation for knowledge gaps',
      inputSchema: {
        required: ['tenantId', 'sessionId'],
        properties: {
          tenantId: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
    },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        {
          id: 'compute-knowledge-gap',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'knowledge_gap' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  // Keep old fields for migration compat
  trigger: {
    type: 'kafka',
    kafkaTopic: 'abl.session.ended',
  },
  inputSchema: {
    required: ['tenantId', 'sessionId'],
    properties: {
      tenantId: { type: 'string', description: 'Tenant ID from session event' },
      projectId: { type: 'string', description: 'Project ID from session event' },
      sessionId: { type: 'string', description: 'Session ID to evaluate' },
    },
  },
  steps: [
    {
      id: 'read-conversation',
      name: 'Read Conversation',
      type: 'read-conversation',
      config: { enrichWithTraces: true },
      timeout: 30_000,
      retries: 2,
    },
    {
      id: 'analyze-knowledge-gap',
      name: 'Analyze Knowledge Gap',
      type: 'conversation-analyzer',
      config: { evaluationType: 'knowledge_gap', sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
