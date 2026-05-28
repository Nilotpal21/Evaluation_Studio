/**
 * Quality Evaluation Pipeline Definition (Batch Only)
 *
 * Triggers: abl.session.ended (batch)
 * Steps: read-conversation → compute-quality → store-results
 * Output: quality_evaluations ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const QUALITY_PIPELINE_ID = 'builtin:quality-evaluation';

export const qualityPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'quality_evaluation',
  name: 'Quality Evaluation',
  description: 'LLM-as-judge quality evaluation with configurable rubric dimensions',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'dimensions',
        type: 'array',
        required: false,
        description: 'Custom evaluation dimensions. Empty uses platform defaults.',
        reprocessOnChange: true,
        items: {
          type: 'object',
          properties: {
            name: {
              name: 'name',
              type: 'string',
              required: true,
              description: 'Dimension identifier',
            },
            displayName: {
              name: 'displayName',
              type: 'string',
              required: true,
              description: 'UI label',
            },
            description: {
              name: 'description',
              type: 'string',
              required: true,
              description: 'What this dimension measures',
            },
            scale: {
              name: 'scale',
              type: 'object',
              required: true,
              description: 'Score range',
              items: {
                type: 'object',
                properties: {
                  min: {
                    name: 'min',
                    type: 'number',
                    required: true,
                    description: 'Minimum score',
                  },
                  max: {
                    name: 'max',
                    type: 'number',
                    required: true,
                    description: 'Maximum score',
                  },
                },
              },
            },
            weight: {
              name: 'weight',
              type: 'number',
              required: true,
              description: 'Relative weight in aggregate score',
            },
            criteria: {
              name: 'criteria',
              type: 'array',
              required: false,
              description: 'Scoring criteria',
              items: {
                name: 'criterion',
                type: 'string',
                required: true,
                description: 'A criterion',
              },
            },
          },
        },
      },
      {
        name: 'domainContext',
        type: 'string',
        required: false,
        description: 'Additional domain context injected into the quality evaluation prompt',
      },
      {
        name: 'flagThreshold',
        type: 'number',
        required: false,
        default: 2.5,
        validation: { min: 0, max: 5 },
        description: 'Average score at or below which a conversation is flagged',
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
      description: 'Evaluates full conversation quality after session completes',
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
        { id: 'compute-quality', activity: 'compute-quality' },
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
      id: 'compute-quality',
      name: 'Compute Quality',
      type: 'compute-quality',
      config: { sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
