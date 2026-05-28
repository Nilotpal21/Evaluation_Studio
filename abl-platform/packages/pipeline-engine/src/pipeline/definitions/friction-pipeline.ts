/**
 * Friction Detection Pipeline Definition
 *
 * Triggers: abl.session.ended (batch), abl.message.user (realtime)
 * Batch: read-conversation → compute-statistical (friction_detection) → store-results
 * Realtime: read-message-window → compute-statistical (friction_detection, single-message) → store-results
 * Output: friction_detections ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const FRICTION_PIPELINE_ID = 'builtin:friction-detection';

export const frictionPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'friction_detection',
  name: 'Friction Detection',
  description:
    'Detects user frustration signals — rephrased questions, message escalation, caps, exclamation patterns',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'metricTable',
        type: 'string',
        required: false,
        description: 'ClickHouse table to read metrics from',
      },
      {
        name: 'metricColumn',
        type: 'string',
        required: false,
        description: 'Column name containing the metric value',
      },
      {
        name: 'lookbackDays',
        type: 'number',
        required: false,
        default: 30,
        validation: { min: 1 },
        description: 'Number of days to look back for baseline calculation',
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
      description: 'Full trajectory friction analysis',
      inputSchema: {
        required: ['tenantId', 'sessionId'],
        properties: {
          tenantId: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
    },
    {
      id: 'realtime-user',
      type: 'kafka',
      kafkaTopic: 'abl.message.user',
      strategy: 'realtime',
      label: 'On each user message',
      description: 'Live frustration signal detection (rephrasing, caps, escalation keywords)',
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
          id: 'compute-friction',
          activity: 'compute-statistical',
          config: { analysisType: 'friction_detection' },
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
          config: { windowSize: 5 },
        },
        {
          id: 'compute-friction-rt',
          activity: 'compute-statistical',
          config: {
            analysisType: 'friction_detection',
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
      id: 'detect-friction',
      name: 'Detect Friction',
      type: 'compute-statistical',
      config: { analysisType: 'friction_detection', sourceStep: 'read-conversation' },
      timeout: 60_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
