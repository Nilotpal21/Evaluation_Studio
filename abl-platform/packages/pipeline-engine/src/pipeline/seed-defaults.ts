import type mongoose from 'mongoose';
import { BUILTIN_DEFINITIONS } from './definitions/index.js';
import { PipelineDefinitionModel } from '../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel, type PipelineType } from '../schemas/pipeline-config.schema.js';

export interface PipelineSeedOptions {
  session?: mongoose.ClientSession | null;
}

export interface TenantPipelineSeedOptions extends PipelineSeedOptions {
  tenantId: string;
  createdBy: string;
}

const PIPELINE_TYPE_MAP: Record<string, PipelineType> = {};
for (const { id, definition } of BUILTIN_DEFINITIONS) {
  if (definition.pipelineType) {
    PIPELINE_TYPE_MAP[id] = definition.pipelineType as PipelineType;
  }
}

async function upsertSeedRecord<T>(
  model: mongoose.Model<T>,
  filter: Record<string, unknown>,
  createData: Record<string, unknown>,
  updateData?: Record<string, unknown>,
  session?: mongoose.ClientSession | null,
): Promise<T> {
  if (!updateData) {
    const result = await model.findOneAndUpdate(
      filter,
      { $set: createData },
      {
        upsert: true,
        new: true,
        lean: true,
        session: session ?? undefined,
      },
    );
    return result as T;
  }

  const setOnInsert: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(createData)) {
    if (!(key in updateData)) {
      setOnInsert[key] = value;
    }
  }

  const update: Record<string, unknown> = { $set: updateData };
  if (Object.keys(setOnInsert).length > 0) {
    update.$setOnInsert = setOnInsert;
  }

  const result = await model.findOneAndUpdate(filter, update, {
    upsert: true,
    new: true,
    lean: true,
    session: session ?? undefined,
  });

  return result as T;
}

// Configs that were created when the legacy steps used mv_daily_sentiment need
// to be patched to point at the raw tables. This runs on every startup but only
// touches documents that still carry the stale materialized-view table name.
const STALE_CONFIG_MIGRATIONS: Array<{
  pipelineType: string;
  staleTable: string;
  correctTable: string;
  correctColumn: string;
}> = [
  {
    pipelineType: 'anomaly_detection',
    staleTable: 'abl_platform.mv_daily_sentiment',
    correctTable: 'abl_platform.conversation_sentiment',
    correctColumn: 'avg_sentiment',
  },
];

async function migrateStaleConfigs(session?: mongoose.ClientSession | null): Promise<void> {
  for (const { pipelineType, staleTable, correctTable, correctColumn } of STALE_CONFIG_MIGRATIONS) {
    await PipelineConfigModel.updateMany(
      { pipelineType, 'config.metricTable': { $in: [staleTable, '', null] } },
      {
        $set: {
          'config.metricTable': correctTable,
          'config.metricColumn': correctColumn,
        },
      },
      { session: session ?? undefined },
    );
  }
}

export async function seedBuiltinPipelineDefinitions(
  options: PipelineSeedOptions = {},
): Promise<number> {
  const { session } = options;
  let count = 0;

  await migrateStaleConfigs(session);

  for (const { id, definition } of BUILTIN_DEFINITIONS) {
    await upsertSeedRecord(
      PipelineDefinitionModel,
      { _id: id },
      {
        _id: id,
        ...definition,
      },
      {
        tenantId: definition.tenantId,
        createdBy: definition.createdBy,
        name: definition.name,
        description: definition.description,
        pipelineType: definition.pipelineType,
        version: definition.version,
        status: definition.status,
        configSchema: definition.configSchema,
        supportedTriggers: definition.supportedTriggers,
        defaultTriggerIds: definition.defaultTriggerIds,
        strategies: definition.strategies,
        trigger: definition.trigger,
        inputSchema: definition.inputSchema,
        steps: definition.steps,
        updatedAt: new Date(),
      },
      session,
    );
    count++;
  }

  return count;
}

export async function seedTenantPipelineConfigs(
  options: TenantPipelineSeedOptions,
): Promise<number> {
  const { tenantId, createdBy, session } = options;
  let count = 0;

  for (const [definitionId, pipelineType] of Object.entries(PIPELINE_TYPE_MAP)) {
    const def = BUILTIN_DEFINITIONS.find((item) => item.id === definitionId);
    if (!def) continue;

    await upsertSeedRecord(
      PipelineConfigModel,
      { tenantId, pipelineType, projectId: null },
      {
        tenantId,
        projectId: null,
        pipelineType,
        version: 1,
        enabled: false,
        config: {},
        backfillStatus: 'idle',
        createdBy,
        updatedBy: createdBy,
      },
      {
        updatedBy: createdBy,
      },
      session,
    );
    count++;
  }

  return count;
}
