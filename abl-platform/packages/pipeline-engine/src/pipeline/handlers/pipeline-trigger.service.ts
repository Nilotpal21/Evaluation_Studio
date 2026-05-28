/**
 * PipelineTrigger -- Restate service for starting pipeline runs.
 *
 * Two entry points:
 *   - handleEvent: receives Kafka events routed by Restate subscription config,
 *     finds matching active pipelines, and starts a PipelineRun workflow for each.
 *   - triggerManual: called programmatically (from Studio API or another service)
 *     to start a specific pipeline on demand.
 *
 * Supports multi-trigger definitions: queries by supportedTriggers.kafkaTopic,
 * resolves active triggers from config, matches specific TriggerEntry, resolves
 * strategy, and passes executionMode + steps to the workflow.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { pipelineRun } from './pipeline-run.workflow.js';
import { PipelineDefinitionModel } from '../../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel, type IPipelineConfig } from '../../schemas/pipeline-config.schema.js';
import { PipelineRunRecordModel } from '../../schemas/pipeline-run-record.schema.js';
import type { PipelineDefinition, TriggerEntry, PipelineStep } from '../types.js';
import {
  PipelineConfigService,
  resolveActiveTriggers,
  resolveSamplingRate,
} from '../services/pipeline-config.service.js';
import {
  getCachedDefinitions as getFromCache,
  setCachedDefinitions,
} from '../services/definition-cache.js';

const log = createLogger('pipeline-trigger');

// ─── Definition Lookup (Redis-backed, fail-open to MongoDB) ──────────────

async function fetchDefinitions(kafkaTopic: string): Promise<PipelineDefinition[]> {
  // Try Redis cache first
  const cached = await getFromCache<PipelineDefinition>(kafkaTopic);
  if (cached) return cached;

  // Cache miss or Redis unavailable — query MongoDB
  const docs = await PipelineDefinitionModel.find({
    status: 'active',
    $or: [{ 'supportedTriggers.kafkaTopic': kafkaTopic }, { 'trigger.kafkaTopic': kafkaTopic }],
  }).lean();
  const definitions = docs as unknown as PipelineDefinition[];

  // Store in Redis for subsequent requests
  await setCachedDefinitions(kafkaTopic, definitions);

  return definitions;
}

/**
 * Resolve the Kafka topic name from a PlatformEvent.
 */
function resolveKafkaTopic(eventType: string): string {
  if (eventType.includes('.') && !eventType.startsWith('abl.')) {
    return `abl.${eventType}`;
  }
  return eventType;
}

// ─── Pipeline Match Types ────────────────────────────────────────────────

interface PipelineMatch {
  definition: PipelineDefinition;
  matchedTrigger: TriggerEntry | null;
  samplingRate: number;
  config: IPipelineConfig | null;
}

export const pipelineTrigger = restate.service({
  name: 'PipelineTrigger',
  handlers: {
    handleEvent: async (ctx: restate.Context, event: Record<string, unknown>): Promise<void> => {
      const tenantId = event.tenantId as string;
      const eventType = event.type as string;
      const sessionId = event.sessionId as string | undefined;

      if (!tenantId || !eventType) {
        ctx.console.log(`[PipelineTrigger] Skipping event: missing tenantId or type`);
        return;
      }

      const kafkaTopic = resolveKafkaTopic(eventType);

      log.debug('Received event', { tenantId, sessionId, eventType, kafkaTopic });

      const matchingPipelines = await ctx.run('find-pipelines', async () =>
        findActivePipelinesForEvent(tenantId, kafkaTopic),
      );

      log.debug('Pipelines matched', {
        tenantId,
        kafkaTopic,
        matchCount: matchingPipelines.length,
      });

      ctx.console.log(
        `[PipelineTrigger] tenant=${tenantId} topic=${kafkaTopic} matches=${matchingPipelines.length}`,
      );

      for (const {
        definition: pipeline,
        matchedTrigger,
        samplingRate,
        config,
      } of matchingPipelines) {
        // Apply event filter — from matched trigger (new format) or definition trigger (old format)
        const eventFilter = matchedTrigger?.eventFilter ?? pipeline.trigger?.eventFilter;
        if (eventFilter) {
          const fieldValue = getNestedField(event, eventFilter.field);
          if (String(fieldValue) !== eventFilter.equals) {
            ctx.console.log(
              `[PipelineTrigger] Skipping pipeline=${pipeline._id}: eventFilter ${eventFilter.field}=${String(fieldValue)} !== ${eventFilter.equals}`,
            );
            continue;
          }
        }

        // Validate input against inputSchema
        const inputSchema = matchedTrigger?.inputSchema ?? pipeline.inputSchema;
        if (inputSchema) {
          const valid = validateInput(event, inputSchema);
          if (!valid) {
            ctx.console.log(
              `[PipelineTrigger] Skipping pipeline=${pipeline._id}: inputSchema validation failed (required: ${inputSchema.required.join(', ')})`,
            );
            continue;
          }
        }

        // Sampling
        if (samplingRate < 1.0) {
          const roll = ctx.rand.random();
          if (roll >= samplingRate) {
            continue;
          }
        }

        // Resolve strategy and steps for the matched trigger
        const triggerId = matchedTrigger?.id ?? 'default';
        const strategyKey = matchedTrigger?.strategy;
        const strategy = strategyKey ? pipeline.strategies?.[strategyKey] : undefined;
        const executionMode = strategy?.executionMode ?? 'batch';
        const steps: PipelineStep[] = strategy?.steps ?? pipeline.steps ?? [];

        const runId = `${pipeline._id}-${ctx.rand.uuidv4()}`;

        log.debug('Starting pipeline run', {
          runId,
          sessionId,
          pipelineId: pipeline._id,
          triggerId,
          executionMode,
          tenantId,
        });

        ctx.workflowSendClient(pipelineRun, runId).run({
          pipelineDefinition: pipeline,
          matchedTriggerId: triggerId,
          executionMode,
          steps,
          pipelineInput: {
            tenantId,
            projectId: config?.projectId,
            pipelineId: pipeline._id,
            runId,
            ...event,
          },
        });

        const eventSerialized = JSON.stringify(event);
        const eventTruncated = eventSerialized.length > 256 * 1024;

        await ctx.run('create-run-record', async () => {
          await createRunRecord({
            runId,
            pipelineId: pipeline._id,
            pipelineVersion: pipeline.version,
            tenantId,
            projectId: (event.projectId as string | undefined) || config?.projectId,
            status: 'running',
            trigger: {
              type: 'kafka',
              kafkaTopic,
              triggerId,
              executionMode,
            },
            input: event,
            triggerInput: eventTruncated ? { note: 'truncated' } : event,
            triggerInputTruncated: eventTruncated,
            steps: buildRunRecordSteps(pipeline, steps),
            startedAt: new Date(),
          });
        });
        ctx.console.log(
          `[PipelineTrigger] Started run=${runId} pipeline=${pipeline._id} trigger=${triggerId} mode=${executionMode}`,
        );
      }
    },

    triggerManual: async (
      ctx: restate.Context,
      input: {
        pipelineId: string;
        tenantId: string;
        projectId: string;
        triggeredBy: string;
        triggerId: string;
        data: Record<string, unknown>;
      },
    ): Promise<{ runId: string }> => {
      const sessionId = input.data.sessionId as string | undefined;
      log.debug('Manual trigger received', {
        pipelineId: input.pipelineId,
        tenantId: input.tenantId,
        sessionId,
        triggeredBy: input.triggeredBy,
        triggerId: input.triggerId,
      });

      const { pipeline, trigger } = await ctx.run('validate-manual-trigger', async () => {
        try {
          return await validateManualTriggerInput(input);
        } catch (err) {
          if (err instanceof ManualTriggerValidationError) {
            throw new restate.TerminalError(err.code, { errorCode: 400 });
          }
          throw err;
        }
      });

      const strategyKey = trigger.strategy ?? 'default';
      const strategy = pipeline.strategies?.[strategyKey];
      const executionMode = strategy?.executionMode ?? 'batch';
      const steps: PipelineStep[] = strategy?.steps ?? pipeline.steps ?? [];

      const runId = `${pipeline._id}-${ctx.rand.uuidv4()}`;

      log.debug('Starting manual pipeline run', {
        runId,
        sessionId,
        pipelineId: pipeline._id,
        triggerId: trigger.id,
        executionMode,
        tenantId: input.tenantId,
      });

      ctx.workflowSendClient(pipelineRun, runId).run({
        pipelineDefinition: pipeline,
        matchedTriggerId: trigger.id,
        executionMode,
        steps,
        pipelineInput: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          pipelineId: pipeline._id,
          runId,
          ...input.data,
        },
      });

      const serialized = JSON.stringify(input.data);
      const truncated = serialized.length > 256 * 1024;

      await ctx.run('create-run-record', async () => {
        await createRunRecord({
          runId,
          pipelineId: pipeline._id,
          pipelineVersion: pipeline.version,
          tenantId: input.tenantId,
          projectId: input.projectId,
          status: 'running',
          trigger: {
            type: 'manual',
            triggeredBy: input.triggeredBy,
            triggerId: trigger.id,
            executionMode,
          },
          input: input.data,
          triggerInput: truncated ? { note: 'truncated' } : input.data,
          triggerInputTruncated: truncated,
          steps: buildRunRecordSteps(pipeline, steps),
          startedAt: new Date(),
        });
      });

      return { runId };
    },
  },
});

export type PipelineTriggerService = typeof pipelineTrigger;

// ─── Internal helpers ─────────────────────────────────────────────────────

async function findActivePipelinesForEvent(
  tenantId: string,
  kafkaTopic: string,
): Promise<PipelineMatch[]> {
  log.debug('Finding pipelines for event', { tenantId, kafkaTopic });

  const allDefinitions = await fetchDefinitions(kafkaTopic);

  // Filter: platform definitions available to all tenants, plus tenant's own
  const applicable = allDefinitions.filter(
    (d) => d.tenantId === '__platform__' || d.tenantId === tenantId,
  );

  if (applicable.length === 0) return [];

  // Batch query: fetch all enabled configs
  const pipelineTypes = applicable
    .map((d) => d.pipelineType)
    .filter((pt): pt is string => pt !== undefined);

  const enabledConfigs =
    pipelineTypes.length > 0
      ? await PipelineConfigModel.find({
          tenantId,
          enabled: true,
          pipelineType: { $in: pipelineTypes },
        }).lean()
      : [];

  const configByType = new Map<string, IPipelineConfig>();
  for (const c of enabledConfigs) {
    configByType.set(c.pipelineType, c as unknown as IPipelineConfig);
  }

  const results: PipelineMatch[] = [];

  for (const definition of applicable) {
    // Check if config is enabled for this pipeline type
    if (definition.pipelineType && !configByType.has(definition.pipelineType)) {
      continue;
    }

    const config = definition.pipelineType
      ? (configByType.get(definition.pipelineType) ?? null)
      : null;

    // ── New format: supportedTriggers ──
    if (definition.supportedTriggers && definition.supportedTriggers.length > 0) {
      // Find all triggers matching this kafkaTopic
      const topicTriggers = definition.supportedTriggers.filter(
        (t) => t.type === 'kafka' && t.kafkaTopic === kafkaTopic,
      );

      // Resolve which triggers are active
      const activeIds = resolveActiveTriggers(config, definition);
      const activeSet = new Set(activeIds);

      for (const trigger of topicTriggers) {
        if (!activeSet.has(trigger.id)) continue;

        const samplingRate = resolveSamplingRate(trigger.id, config);
        results.push({ definition, matchedTrigger: trigger, samplingRate, config });
      }
      continue;
    }

    // ── Old format: single trigger ──
    const rate = (config?.config as Record<string, unknown>)?.samplingRate;
    results.push({
      definition,
      matchedTrigger: null,
      samplingRate: typeof rate === 'number' ? rate : 1.0,
      config,
    });
  }

  if (results.length === 0) {
    log.debug('No active pipelines for topic', { tenantId, kafkaTopic });
  }

  return results;
}

async function loadActivePipeline(
  pipelineId: string,
  tenantId: string,
): Promise<PipelineDefinition | null> {
  log.debug('Loading pipeline', { pipelineId, tenantId });
  let doc = await PipelineDefinitionModel.findOne({
    _id: pipelineId,
    tenantId: { $in: ['__platform__', tenantId] },
    status: 'active',
  }).lean();

  if (!doc) {
    doc = await PipelineDefinitionModel.findOne({
      pipelineType: pipelineId,
      tenantId: { $in: ['__platform__', tenantId] },
      status: 'active',
    }).lean();
  }

  return doc as unknown as PipelineDefinition | null;
}

async function createRunRecord(data: Record<string, unknown>): Promise<void> {
  log.debug('Creating run record', {
    runId: data.runId,
    pipelineId: data.pipelineId,
    tenantId: data.tenantId,
  });
  await PipelineRunRecordModel.updateOne(
    { _id: data.runId },
    { $setOnInsert: { _id: data.runId, ...data } },
    { upsert: true },
  );
}

function validateInput(
  data: Record<string, unknown>,
  schema: { required: string[]; properties: Record<string, unknown> },
): boolean {
  for (const field of schema.required) {
    if (data[field] === undefined) return false;
  }
  return true;
}

/**
 * Build the `steps` array for a PipelineRunRecord.
 * For graph pipelines, maps nodes[] to step entries.
 * For linear pipelines, maps the resolved steps array.
 */
export function buildRunRecordSteps(
  pipeline: PipelineDefinition,
  resolvedSteps: PipelineStep[],
): Array<{ id: string; name: string; type: string; status: string }> {
  const isGraph = pipeline.nodes && pipeline.nodes.length > 0 && pipeline.entryNodeId;

  if (isGraph) {
    return pipeline.nodes!.map((n) => ({
      id: n.id,
      name: n.label ?? n.id,
      type: n.type,
      status: 'pending',
    }));
  }

  return resolvedSteps.map((s) => ({
    id: s.id,
    name: s.name ?? s.id,
    type: s.activity ?? s.type ?? 'unknown',
    status: 'pending',
  }));
}

function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce(
      (current, key) =>
        current !== null && current !== undefined
          ? (current as Record<string, unknown>)[key]
          : undefined,
      obj as unknown,
    );
}

// ─── Public validator (extracted for testability) ────────────────────────

export class ManualTriggerValidationError extends Error {
  constructor(
    public code:
      | 'PIPELINE_NOT_FOUND'
      | 'PROJECT_MISMATCH'
      | 'TRIGGER_NOT_FOUND'
      | 'TRIGGER_NOT_ACTIVE'
      | 'INPUT_VALIDATION_FAILED',
    public details?: unknown,
  ) {
    super(code);
    this.name = 'ManualTriggerValidationError';
  }
}

export async function validateManualTriggerInput(args: {
  pipelineId: string;
  tenantId: string;
  projectId: string;
  triggerId: string;
  data: Record<string, unknown>;
}): Promise<{
  pipeline: PipelineDefinition;
  config: IPipelineConfig | null;
  trigger: TriggerEntry;
}> {
  const pipeline = await loadActivePipeline(args.pipelineId, args.tenantId);
  if (!pipeline) {
    throw new ManualTriggerValidationError('PIPELINE_NOT_FOUND');
  }

  let config: IPipelineConfig | null = null;
  if (pipeline.pipelineType) {
    const configService = new PipelineConfigService();
    config = await configService.resolveConfig(
      args.tenantId,
      pipeline.pipelineType as Parameters<PipelineConfigService['resolveConfig']>[1],
      args.projectId,
      pipeline,
    );

    if (!config) {
      throw new ManualTriggerValidationError('PIPELINE_NOT_FOUND');
    }
  } else if (pipeline.projectId && pipeline.projectId !== args.projectId) {
    throw new ManualTriggerValidationError('PROJECT_MISMATCH');
  }

  if (config?.projectId && config.projectId !== args.projectId) {
    throw new ManualTriggerValidationError('PROJECT_MISMATCH');
  }

  const trigger = (pipeline.supportedTriggers ?? []).find((t) => t.id === args.triggerId);
  if (!trigger) {
    throw new ManualTriggerValidationError('TRIGGER_NOT_FOUND');
  }

  const activeIds = resolveActiveTriggers(config, pipeline);
  if (!activeIds.includes(args.triggerId)) {
    throw new ManualTriggerValidationError('TRIGGER_NOT_ACTIVE');
  }

  if (trigger.inputSchema) {
    const effectiveInput = {
      tenantId: args.tenantId,
      projectId: args.projectId,
      ...args.data,
    };
    const ok = validateInput(effectiveInput, trigger.inputSchema);
    if (!ok) {
      throw new ManualTriggerValidationError('INPUT_VALIDATION_FAILED', {
        required: trigger.inputSchema.required,
      });
    }
  }

  return { pipeline, config, trigger };
}
