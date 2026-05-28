/**
 * Guardrail Analysis Pipeline Definition
 *
 * Triggers: abl.session.ended (batch), abl.message.user (realtime-input), abl.message.agent (realtime-output)
 * Batch: read-conversation → conversation-analyzer (guardrail) → store-results
 * Realtime-input: read-message-window → conversation-analyzer (guardrail, input-check) → store-results
 * Realtime-output: read-message-window → conversation-analyzer (guardrail, output-check) → store-results
 * Output: guardrail_evaluations ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const GUARDRAIL_PIPELINE_ID = 'builtin:guardrail-analysis';

export const guardrailPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'guardrail_analysis',
  name: 'Guardrail Analysis',
  description:
    'Evaluates guardrail effectiveness — detects false positives, false negatives, and bypass attempts',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'flagThreshold',
        type: 'number',
        required: false,
        description: 'Score threshold for flagging a guardrail violation',
      },
      {
        name: 'systemPromptOverride',
        type: 'string',
        required: false,
        description: 'Override the system prompt for guardrail evaluation',
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
      description: 'Full session guardrail effectiveness analysis',
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
      strategy: 'realtime-input',
      label: 'On each user message',
      description: 'Detect jailbreak attempts and adversarial inputs',
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
      strategy: 'realtime-output',
      label: 'On each agent response',
      description: 'Detect guardrail bypass in agent outputs',
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
          id: 'compute-guardrail',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    'realtime-input': {
      executionMode: 'realtime',
      steps: [
        {
          id: 'read-window',
          activity: 'read-message-window',
          config: { windowSize: 3 },
        },
        {
          id: 'compute-guardrail-input',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail', mode: 'input-check', sourceStep: 'read-window' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
    'realtime-output': {
      executionMode: 'realtime',
      steps: [
        {
          id: 'read-window',
          activity: 'read-message-window',
          config: { windowSize: 3 },
        },
        {
          id: 'compute-guardrail-output',
          activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail', mode: 'output-check', sourceStep: 'read-window' },
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
      id: 'analyze-guardrails',
      name: 'Analyze Guardrails',
      type: 'conversation-analyzer',
      config: { evaluationType: 'guardrail', sourceStep: 'read-conversation' },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
