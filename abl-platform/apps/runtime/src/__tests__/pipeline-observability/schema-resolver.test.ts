import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  resolveOutputSchema,
  clearSchemaCache,
  OutputSchemaError,
} from '../../services/pipeline-observability/schema-resolver.js';
import { CUSTOM_PIPELINE_RESULTS_TABLE } from '@agent-platform/pipeline-engine/contracts';

// Runtime doesn't call ensureDb() — tests manage their own Mongoose connection.

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  clearSchemaCache();
  await mongoose.connection.dropDatabase();
});

async function seedPipeline(overrides: Record<string, unknown> = {}) {
  const { PipelineDefinitionModel } = await import('@agent-platform/pipeline-engine/schemas');
  return PipelineDefinitionModel.create({
    _id: 'pipe-1',
    tenantId: 'tenant-A',
    name: 'Sentiment Pipeline',
    version: 1,
    status: 'active',
    createdBy: 'user-1',
    configSchema: { fields: [] },
    supportedTriggers: [],
    defaultTriggerIds: [],
    nodes: [
      {
        id: 'n1',
        type: 'store-results',
        config: {
          table: 'abl_platform.sentiment_scores',
          outputSchema: {
            columns: [
              { name: 'score', type: 'Float64', filterable: true, exportable: true },
              { name: 'label', type: 'String', filterable: true, exportable: true },
              { name: 'raw', type: 'String', filterable: false, exportable: false },
            ],
          },
        },
      },
    ],
    ...overrides,
  });
}

describe('resolveOutputSchema', () => {
  it('resolves a builtin pipeline from the hardcoded table map', async () => {
    const schema = await resolveOutputSchema('builtin:sentiment-analysis', 'tenant-A');
    expect(schema.table).toBe('abl_platform.conversation_sentiment');
    const names = schema.columns.map((c) => c.name);
    expect(names).toContain('tenant_id');
    expect(names).toContain('project_id');
    expect(names).toContain('avg_sentiment');
    expect(names).toContain('sentiment_trajectory');
  });

  it('resolves a custom pipeline from its store-results node', async () => {
    await seedPipeline();
    const schema = await resolveOutputSchema('pipe-1', 'tenant-A');

    expect(schema.table).toBe('abl_platform.sentiment_scores');
    const names = schema.columns.map((c) => c.name);
    expect(names).toContain('score');
    expect(names).toContain('label');
    expect(names).toContain('run_id');
    expect(names).toContain('session_id');
    expect(names).toContain('pipeline_id');
    expect(names).toContain('created_at');
    expect(names).not.toContain('processed_at');
  });

  it('defaults ClickHouse custom pipelines without an explicit table to shared results table', async () => {
    await seedPipeline({
      name: 'Quality Evaluator',
      nodes: [
        {
          id: 'store',
          type: 'store-results',
          config: {
            destination: 'clickhouse',
            sourceStep: 'compute-quality',
          },
        },
      ],
    });

    const schema = await resolveOutputSchema('pipe-1', 'tenant-A');

    expect(schema.table).toBe(CUSTOM_PIPELINE_RESULTS_TABLE);
    const names = schema.columns.map((c) => c.name);
    expect(names).toContain('pipeline_name');
    expect(names).toContain('score_name');
    expect(names).toContain('score_path');
    expect(names).toContain('score_value');
    expect(names).toContain('output_json');
    expect(schema.columns.find((c) => c.name === 'pipeline_name')?.filterable).toBe(true);
    expect(schema.columns.find((c) => c.name === 'score_value')?.filterable).toBe(true);
  });

  it('caches the result within TTL', async () => {
    await seedPipeline();
    const first = await resolveOutputSchema('pipe-1', 'tenant-A');
    const second = await resolveOutputSchema('pipe-1', 'tenant-A');
    expect(first).toBe(second);
  });

  it('declared columns override base metadata', async () => {
    await seedPipeline({
      nodes: [
        {
          id: 'n1',
          type: 'store-results',
          config: {
            table: 'abl_platform.test_table',
            outputSchema: {
              columns: [
                {
                  name: 'run_id',
                  type: 'String',
                  filterable: false,
                  exportable: false,
                  description: 'custom override',
                },
              ],
            },
          },
        },
      ],
    });

    const schema = await resolveOutputSchema('pipe-1', 'tenant-A');
    const runIdCol = schema.columns.find((c) => c.name === 'run_id');
    expect(runIdCol?.filterable).toBe(false);
    expect(runIdCol?.exportable).toBe(false);
    expect(runIdCol?.description).toBe('custom override');
  });

  it('throws NOT_FOUND for unknown pipelineId', async () => {
    try {
      await resolveOutputSchema('nonexistent', 'tenant-A');
      expect.fail('Expected OutputSchemaError');
    } catch (err) {
      expect(err).toBeInstanceOf(OutputSchemaError);
      expect((err as OutputSchemaError).code).toBe('NOT_FOUND');
    }
  });

  it('throws NO_OUTPUT_TABLE when graph lacks store-results node', async () => {
    await seedPipeline({ nodes: [{ id: 'n1', type: 'llm-call', config: {} }] });

    try {
      await resolveOutputSchema('pipe-1', 'tenant-A');
      expect.fail('Expected OutputSchemaError');
    } catch (err) {
      expect(err).toBeInstanceOf(OutputSchemaError);
      expect((err as OutputSchemaError).code).toBe('NO_OUTPUT_TABLE');
    }
  });

  it('throws NOT_FOUND when the pipeline belongs to a different tenant', async () => {
    await seedPipeline({ tenantId: 'tenant-B' });
    await expect(resolveOutputSchema('pipe-1', 'tenant-A')).rejects.toThrow(OutputSchemaError);
  });

  it('resolves platform-level pipelines (tenantId=__platform__)', async () => {
    await seedPipeline({ _id: 'platform-pipe', tenantId: '__platform__' });
    const schema = await resolveOutputSchema('platform-pipe', 'tenant-A');
    expect(schema.table).toBe('abl_platform.sentiment_scores');
  });

  it('also resolves store-insight node type', async () => {
    await seedPipeline({
      nodes: [
        {
          id: 'n1',
          type: 'store-insight',
          config: {
            table: 'abl_platform.insights',
            outputSchema: {
              columns: [
                { name: 'insight_text', type: 'String', filterable: true, exportable: true },
              ],
            },
          },
        },
      ],
    });

    const schema = await resolveOutputSchema('pipe-1', 'tenant-A');
    expect(schema.table).toBe('abl_platform.insights');
    expect(schema.columns.find((c) => c.name === 'insight_text')).toBeTruthy();
  });

  it('prefers the richer strategy store-results schema over legacy step metadata', async () => {
    await seedPipeline({
      nodes: [],
      steps: [
        {
          id: 'legacy-store',
          type: 'store-results',
          config: {
            table: 'abl_platform.custom_metrics',
          },
        },
      ],
      strategies: {
        default: {
          executionMode: 'batch',
          steps: [
            {
              id: 'strategy-store',
              activity: 'store-results',
              config: {
                table: 'abl_platform.custom_metrics',
                outputSchema: {
                  columns: [
                    {
                      name: 'friction_score',
                      type: 'Float64',
                      filterable: true,
                      exportable: true,
                    },
                    {
                      name: 'flagged',
                      type: 'UInt8',
                      filterable: true,
                      exportable: true,
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    });

    const schema = await resolveOutputSchema('pipe-1', 'tenant-A');
    expect(schema.table).toBe('abl_platform.custom_metrics');
    expect(schema.columns.find((c) => c.name === 'friction_score')).toBeTruthy();
    expect(schema.columns.find((c) => c.name === 'flagged')).toBeTruthy();
  });
});
