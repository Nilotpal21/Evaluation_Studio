/**
 * Drift Detection Pipeline Definition (Schedule Only)
 *
 * Triggers: daily schedule
 * Steps: compute-statistical (drift_detection) → store-results
 * Output: drift_detections ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const DRIFT_PIPELINE_ID = 'builtin:drift-detection';

export const driftPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'drift_detection',
  name: 'Drift Detection',
  description:
    'Monitors analytics metrics for gradual performance drift by comparing baseline and current windows',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'metricTable',
        label: 'Metric Source',
        type: 'enum',
        required: false,
        default: 'abl_platform.quality_evaluations',
        description: 'Which analytics table to compare baseline vs current windows on.',
        dynamicOptions: 'metric-tables',
        resetFields: ['metricColumn'],
      },
      {
        name: 'metricColumn',
        label: 'Metric',
        type: 'enum',
        required: false,
        default: 'overall_score',
        description: 'Which metric inside the selected source to track for drift.',
        dynamicOptions: 'metric-columns',
      },
      {
        name: 'lookbackDays',
        type: 'number',
        required: false,
        default: 60,
        validation: { min: 6 },
        description:
          'Number of days to look back — split at midpoint for baseline vs current window',
      },
    ],
  },

  supportedTriggers: [
    {
      id: 'daily',
      type: 'schedule',
      schedule: '0 0 * * *',
      strategy: 'scheduled',
      label: 'Daily',
      description: 'Daily drift analysis comparing baseline vs current windows',
    },
  ],
  defaultTriggerIds: ['daily'],

  strategies: {
    scheduled: {
      executionMode: 'batch',
      steps: [
        {
          id: 'detect-drift',
          activity: 'compute-statistical',
          config: { analysisType: 'drift_detection' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  // Keep old fields for migration compat
  trigger: {
    type: 'schedule',
    schedule: '0 0 * * *',
  },
  inputSchema: {
    required: ['tenantId', 'projectId'],
    properties: {
      tenantId: { type: 'string', description: 'Tenant ID' },
      projectId: { type: 'string', description: 'Project ID' },
      sessionId: { type: 'string', description: 'Placeholder session ID for pipeline run' },
    },
  },
  steps: [
    {
      id: 'detect-drift',
      name: 'Detect Drift',
      type: 'compute-statistical',
      config: {
        analysisType: 'drift_detection',
        metricTable: 'abl_platform.quality_evaluations',
        metricColumn: 'overall_score',
      },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
