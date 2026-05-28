/**
 * Intent Classification Pipeline Definition
 *
 * Triggers: abl.session.ended (batch), abl.message.user (realtime)
 * Batch: read-conversation → compute-intent → evaluate-resolution → store-results
 * Realtime: read-message-window → compute-intent (early-detection) → store-results
 * Output: intent_classifications ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const INTENT_PIPELINE_ID = 'builtin:intent-classification';

export const intentPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'intent_classification',
  name: 'Intent Classification',
  description:
    'Classifies conversation intent using LLM analysis with customer-defined taxonomy or auto-discovery',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'taxonomy',
        type: 'array',
        required: false,
        default: [],
        description: 'Customer-defined intent taxonomy. Empty for auto-discovery mode.',
        reprocessOnChange: true,
        items: {
          type: 'object',
          properties: {
            name: {
              name: 'name',
              type: 'string',
              required: true,
              description: 'Intent identifier',
            },
            description: {
              name: 'description',
              type: 'string',
              required: true,
              description: 'When this intent applies',
            },
            displayName: {
              name: 'displayName',
              type: 'string',
              required: false,
              description: 'UI display label',
            },
            examples: {
              name: 'examples',
              type: 'array',
              required: false,
              description: 'Example phrases',
              items: {
                name: 'item',
                type: 'string',
                required: true,
                description: 'Example phrase',
              },
            },
            subCategories: {
              name: 'subCategories',
              type: 'array',
              required: false,
              description: 'Sub-intents',
              items: {
                type: 'object',
                properties: {
                  name: {
                    name: 'name',
                    type: 'string',
                    required: true,
                    description: 'Sub-intent identifier',
                  },
                  description: {
                    name: 'description',
                    type: 'string',
                    required: true,
                    description: 'When this sub-intent applies',
                  },
                  displayName: {
                    name: 'displayName',
                    type: 'string',
                    required: false,
                    description: 'UI label',
                  },
                },
              },
            },
          },
        },
      },
      {
        name: 'confidenceThreshold',
        type: 'number',
        required: false,
        default: 0.6,
        validation: { min: 0, max: 1 },
        description: 'Minimum confidence for a classification to be accepted',
      },
      {
        name: 'inputMessageStrategy',
        type: 'enum',
        required: false,
        default: 'first_n_user',
        values: ['first_n_user', 'last_n_user', 'all_user', 'all'],
        description: 'Which messages to send to the LLM for classification',
      },
      {
        name: 'inputMessageCount',
        type: 'number',
        required: false,
        default: 3,
        validation: { min: 1 },
        description: 'Number of messages when using first_n/last_n strategies',
      },
      {
        name: 'unknownIntentLabel',
        type: 'string',
        required: false,
        default: 'unknown',
        description: 'Label assigned when no intent matches the threshold',
      },
      {
        name: 'classificationPrompt',
        type: 'string',
        required: false,
        description: 'Custom system prompt override for intent classification',
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
      description: 'Final classification with full conversation context',
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
      description: 'Early intent detection for smart routing after first messages',
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
        // skipDirectWrite: evaluate-resolution writes the unified intent_classifications row
        { id: 'compute-intent', activity: 'compute-intent', config: { skipDirectWrite: true } },
        { id: 'evaluate-resolution', activity: 'evaluate-resolution' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        {
          id: 'read-window',
          activity: 'read-message-window',
          config: { windowSize: 3 },
        },
        {
          id: 'compute-intent-rt',
          activity: 'compute-intent',
          config: { mode: 'early-detection', sourceStep: 'read-window' },
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
      sessionId: { type: 'string', description: 'Session ID to classify' },
    },
  },
  steps: [
    {
      id: 'read-conversation',
      name: 'Read Conversation',
      type: 'read-conversation',
      config: { enrichWithTraces: false },
      timeout: 30_000,
      retries: 2,
    },
    {
      id: 'compute-intent',
      name: 'Compute Intent',
      type: 'compute-intent',
      config: { sourceStep: 'read-conversation' },
      timeout: 60_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
