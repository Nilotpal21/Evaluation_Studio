/**
 * Sentiment Analysis Pipeline Definition
 *
 * Triggers: abl.session.ended (batch), abl.message.user (realtime)
 * Batch: read-conversation → compute-sentiment → store-results
 * Realtime: read-message-window → compute-sentiment (single-message) → store-results
 * Output: message_sentiment + conversation_sentiment ClickHouse tables
 */
import type { PipelineDefinition } from '../types.js';

export const SENTIMENT_PIPELINE_ID = 'builtin:sentiment-analysis';

export const sentimentPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'sentiment_analysis',
  name: 'Sentiment Analysis',
  description: 'Per-message sentiment scoring with conversation-level trajectory analysis',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'shiftThreshold',
        type: 'number',
        required: false,
        default: 0.3,
        validation: { min: 0, max: 1 },
        description: 'Score delta to count as a sentiment shift between consecutive messages',
      },
      {
        name: 'frustrationThreshold',
        type: 'number',
        required: false,
        default: -0.3,
        validation: { min: -1, max: 0 },
        description: 'Score at or below which a message is considered frustrated',
      },
      {
        name: 'defaultConfidence',
        type: 'number',
        required: false,
        default: 0.85,
        validation: { min: 0, max: 1 },
        description: 'Default confidence assigned to LLM sentiment results',
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
      description: 'Scores full conversation with trajectory analysis',
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
      description: 'Live frustration detection and per-message sentiment',
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
        { id: 'compute-sentiment', activity: 'compute-sentiment' },
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
          id: 'compute-sentiment-rt',
          activity: 'compute-sentiment',
          config: { mode: 'single-message', sourceStep: 'read-window' },
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
      sessionId: { type: 'string', description: 'Session ID to analyze' },
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
      id: 'compute-sentiment',
      name: 'Compute Sentiment',
      type: 'compute-sentiment',
      config: { sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
