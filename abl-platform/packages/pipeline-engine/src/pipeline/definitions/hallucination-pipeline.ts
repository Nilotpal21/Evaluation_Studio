/**
 * Hallucination Detection Pipeline Definition
 *
 * Triggers: abl.session.ended (batch), abl.message.agent (realtime)
 * Batch: read-conversation → conversation-analyzer (hallucination) → store-results
 * Realtime: read-message-window → conversation-analyzer (hallucination, single-message) → store-results
 * Output: hallucination_evaluations ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const HALLUCINATION_PIPELINE_ID = 'builtin:hallucination-detection';

export const hallucinationPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'hallucination_detection',
  name: 'Hallucination Detection',
  description:
    'Detects unsupported claims, self-contradictions, and factual accuracy issues in agent responses',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'flagThreshold',
        type: 'number',
        required: false,
        description: 'Score threshold for flagging a response as hallucinated',
      },
      {
        name: 'systemPromptOverride',
        type: 'string',
        required: false,
        description: 'Override the system prompt for hallucination evaluation',
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
      description: 'Full conversation hallucination audit',
      inputSchema: {
        required: ['tenantId', 'sessionId'],
        properties: {
          tenantId: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
    },
    {
      id: 'realtime-agent',
      type: 'kafka',
      kafkaTopic: 'abl.message.agent',
      strategy: 'realtime',
      label: 'On each agent response',
      description: 'Per-response hallucination detection with tool call context',
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
          id: 'compute-hallucination',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'hallucination' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        {
          id: 'read-window',
          activity: 'read-message-window',
          config: { windowSize: 5, includeToolCalls: true },
        },
        {
          id: 'compute-hallucination-rt',
          activity: 'conversation-analyzer',
          config: {
            evaluationType: 'hallucination',
            mode: 'single-message',
            sourceStep: 'read-window',
          },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
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
      id: 'detect-hallucination',
      name: 'Detect Hallucination',
      type: 'conversation-analyzer',
      config: { evaluationType: 'hallucination', sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
