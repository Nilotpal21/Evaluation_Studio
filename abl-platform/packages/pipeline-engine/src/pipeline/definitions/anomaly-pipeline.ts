/**
 * Anomaly Detection Pipeline Definition (Schedule Only)
 *
 * Triggers: hourly schedule
 * Steps: compute-statistical (anomaly_detection) → store-results
 * Output: anomaly_detections ClickHouse table
 */
import type { PipelineDefinition } from '../types.js';

export const ANOMALY_PIPELINE_ID = 'builtin:anomaly-detection';

export const anomalyPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  pipelineType: 'anomaly_detection',
  name: 'Anomaly Detection',
  description:
    'Monitors analytics metrics for statistical anomalies using z-score and SPC control charts',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      {
        name: 'metricTable',
        label: 'Metric Source',
        type: 'enum',
        required: false,
        default: 'abl_platform.conversation_sentiment',
        description: 'Which analytics table to scan for anomalies.',
        dynamicOptions: 'metric-tables',
        resetFields: ['metricColumn'],
      },
      {
        name: 'metricColumn',
        label: 'Metric',
        type: 'enum',
        required: false,
        default: 'avg_sentiment',
        description: 'Which metric inside the selected source to track.',
        dynamicOptions: 'metric-columns',
      },
      {
        name: 'lookbackDays',
        type: 'number',
        required: false,
        default: 30,
        validation: { min: 1 },
        description: 'Number of days to look back for z-score baseline calculation',
      },
    ],
  },

  supportedTriggers: [
    {
      id: 'hourly',
      type: 'schedule',
      schedule: '0 * * * *',
      strategy: 'scheduled',
      label: 'Hourly',
      description: 'Hourly anomaly scan over aggregated metrics',
    },
  ],
  defaultTriggerIds: ['hourly'],

  strategies: {
    scheduled: {
      executionMode: 'batch',
      steps: [
        {
          id: 'detect-anomalies',
          activity: 'compute-statistical',
          config: { analysisType: 'anomaly_detection' },
        },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  // Keep old fields for migration compat
  trigger: {
    type: 'schedule',
    schedule: '0 * * * *',
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
      id: 'detect-anomalies',
      name: 'Detect Anomalies',
      type: 'compute-statistical',
      config: {
        analysisType: 'anomaly_detection',
        metricTable: 'abl_platform.conversation_sentiment',
        metricColumn: 'avg_sentiment',
      },
      timeout: 120_000,
      retries: 2,
    },
  ],

  createdBy: 'system',
  createdAt: new Date('2026-03-03'),
  updatedAt: new Date('2026-03-03'),
};
