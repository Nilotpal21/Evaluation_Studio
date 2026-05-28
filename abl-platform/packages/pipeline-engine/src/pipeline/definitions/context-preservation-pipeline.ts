/**
 * Context Preservation Pipeline Definition (Batch Only)
 *
 * Triggers: abl.session.ended (batch)
 * Steps: read-conversation -> conversation-analyzer (context_preservation) -> store-results
 * Output: context_evaluations ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const CONTEXT_PRESERVATION_PIPELINE_ID = 'builtin:context-preservation';

export const contextPreservationPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'context_preservation',
  name: 'Context Preservation',
  description:
    'Evaluates whether agents preserve relevant user and workflow context through the conversation',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'flagThreshold',
        type: 'number',
        required: false,
        default: 0.6,
        validation: { min: 0, max: 1 },
        description: 'Context score below which the conversation is flagged',
      },
      {
        name: 'systemPromptOverride',
        type: 'string',
        required: false,
        description: 'Override the system prompt for context preservation evaluation',
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
      description: 'Analyzes full conversation context preservation after session completes',
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
          id: 'compute-context-preservation',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'context_preservation' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

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
      id: 'analyze-context-preservation',
      name: 'Analyze Context Preservation',
      type: 'conversation-analyzer',
      config: { evaluationType: 'context_preservation', sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
