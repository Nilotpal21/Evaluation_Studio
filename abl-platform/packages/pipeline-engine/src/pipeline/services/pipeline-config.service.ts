/**
 * PipelineConfigService
 *
 * Manages pipeline configuration with a resolution chain:
 *   project-level > tenant-level > null
 *
 * Features:
 *   - Config resolution with project/tenant fallback
 *   - Version tracking with auto-increment
 *   - Change history (last 20 entries) with diff detection
 *   - Reprocessing detection for config changes that require backfill
 *   - Active trigger resolution from definition + config
 *   - Per-trigger sampling rate resolution
 */

import { createLogger } from '@abl/compiler/platform';
import {
  PipelineConfigModel,
  type IPipelineConfig,
  type PipelineType,
} from '../../schemas/pipeline-config.schema.js';
import { parseAndValidateConfig } from '../config-schemas.js';
import { PLATFORM_DEFAULTS, getPlatformDefaults } from '../config-defaults.js';
import type { PipelineDefinition, ConfigField, TriggerEntry } from '../types.js';
import { BUILTIN_DEFINITIONS } from '../definitions/index.js';

const log = createLogger('pipeline-config');

/**
 * Resolve which triggers are active for a given config + definition.
 * Falls back to definition.defaultTriggerIds when config doesn't specify.
 * Filters out any trigger IDs not in the definition's supportedTriggers.
 */
export function resolveActiveTriggers(
  config: IPipelineConfig | null,
  definition: PipelineDefinition,
): string[] {
  // Mongoose defaults activeTriggers to [] — treat empty array same as undefined
  const configTriggers = config?.activeTriggers;
  const active =
    configTriggers && configTriggers.length > 0
      ? configTriggers
      : (definition.defaultTriggerIds ?? []);
  const supportedIds = new Set((definition.supportedTriggers ?? []).map((t) => t.id));
  const valid = active.filter((id) => supportedIds.has(id));
  const invalid = active.filter((id) => !supportedIds.has(id));
  if (invalid.length > 0) {
    log.warn('Invalid trigger IDs in config, ignoring', {
      invalid,
      pipelineType: definition.pipelineType,
    });
  }
  return valid;
}

/**
 * Resolve sampling rate for a specific trigger.
 * Priority: triggerConfigs[triggerId].samplingRate > config.samplingRate > 1.0
 */
export function resolveSamplingRate(triggerId: string, config: IPipelineConfig | null): number {
  const triggerConfig = config?.triggerConfigs?.get?.(triggerId);
  return triggerConfig?.samplingRate ?? (config?.config?.samplingRate as number) ?? 1.0;
}

export interface PipelineConfigSummary {
  pipelineType: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  activeTriggers: string[];
  configSchema: { fields: ConfigField[] } | undefined;
  supportedTriggers: TriggerEntry[] | undefined;
  lastProcessedAt: Date | null;
}

export class PipelineConfigService {
  /**
   * List all known builtin pipeline types with their resolved config status.
   * Returns a summary for each builtin pipeline including definition metadata
   * and config state (enabled, triggers, last processed).
   */
  async listAllConfigs(tenantId: string, projectId?: string): Promise<PipelineConfigSummary[]> {
    const results: PipelineConfigSummary[] = [];

    for (const { definition } of BUILTIN_DEFINITIONS) {
      const pipelineType = definition.pipelineType;
      if (!pipelineType) continue;

      try {
        const config = await this.resolveConfig(
          tenantId,
          pipelineType as PipelineType,
          projectId,
          definition as PipelineDefinition,
        );

        const activeTriggers = resolveActiveTriggers(config, definition as PipelineDefinition);

        results.push({
          pipelineType,
          name: definition.name,
          description: definition.description ?? '',
          enabled: config?.enabled ?? false,
          version: config?.version ?? 0,
          activeTriggers,
          configSchema: definition.configSchema,
          supportedTriggers: definition.supportedTriggers,
          lastProcessedAt: config?.lastProcessedAt ?? null,
        });
      } catch (error) {
        log.error('Failed to resolve config for pipeline type', {
          pipelineType,
          error: error instanceof Error ? error.message : String(error),
        });
        // Include the pipeline with defaults on error so the UI still shows it
        results.push({
          pipelineType,
          name: definition.name,
          description: definition.description ?? '',
          enabled: false,
          version: 0,
          activeTriggers: [],
          configSchema: definition.configSchema,
          supportedTriggers: definition.supportedTriggers,
          lastProcessedAt: null,
        });
      }
    }

    return results;
  }

  /**
   * Resolve effective config: project-level > tenant-level > null.
   * When a definition is provided, uses definition-driven defaults.
   */
  async resolveConfig(
    tenantId: string,
    pipelineType: PipelineType,
    projectId?: string,
    definition?: PipelineDefinition,
  ): Promise<IPipelineConfig | null> {
    // 1. Project-level config
    if (projectId) {
      const projectConfig = await PipelineConfigModel.findOne({
        tenantId,
        pipelineType,
        projectId,
      });
      if (projectConfig) return projectConfig;
    }

    // 2. Tenant-level config
    const tenantConfig = await PipelineConfigModel.findOne({
      tenantId,
      pipelineType,
      projectId: null,
    });

    if (tenantConfig) return tenantConfig;

    // 3. Platform defaults — definition-driven if available, else static
    const defaults = definition ? getPlatformDefaults(definition) : PLATFORM_DEFAULTS[pipelineType];

    if (defaults) {
      return {
        tenantId,
        pipelineType,
        projectId: null,
        version: 0,
        enabled: true,
        config: defaults,
        createdBy: 'platform',
        updatedBy: 'platform',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IPipelineConfig;
    }

    return null;
  }

  /**
   * Save or update pipeline config. Auto-increments version.
   * Optional triggerOptions for multi-trigger support.
   */
  async saveConfig(
    tenantId: string,
    pipelineType: PipelineType,
    config: Record<string, unknown>,
    updatedBy: string,
    projectId?: string,
    triggerOptions?: {
      activeTriggers?: string[];
      triggerConfigs?: Record<
        string,
        {
          samplingRate?: number;
          stepOverrides?: Record<string, Record<string, unknown>>;
        }
      >;
    },
  ): Promise<IPipelineConfig> {
    // Validate config against the Zod schema (throws ZodError if invalid)
    parseAndValidateConfig(pipelineType, config);

    const existing = await PipelineConfigModel.findOne({
      tenantId,
      pipelineType,
      projectId: projectId ?? null,
    });

    if (existing) {
      // Build diff for history
      const diff: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(config)) {
        if (JSON.stringify(existing.config[key]) !== JSON.stringify(config[key])) {
          diff[key] = { old: existing.config[key], new: config[key] };
        }
      }

      const reprocessingRequired = this.requiresReprocessing(pipelineType, diff);

      existing.config = config;
      existing.version += 1;
      existing.updatedBy = updatedBy;

      // Update trigger fields if provided
      if (triggerOptions?.activeTriggers !== undefined) {
        existing.activeTriggers = triggerOptions.activeTriggers;
      }
      if (triggerOptions?.triggerConfigs !== undefined) {
        existing.triggerConfigs = new Map(
          Object.entries(triggerOptions.triggerConfigs).map(([k, v]) => [
            k,
            {
              samplingRate: v.samplingRate,
              stepOverrides: v.stepOverrides ? new Map(Object.entries(v.stepOverrides)) : undefined,
            },
          ]),
        );
      }

      // Append to history (keep last 20)
      if (!existing.configHistory) existing.configHistory = [];
      existing.configHistory.push({
        version: existing.version,
        changedBy: updatedBy,
        changedAt: new Date(),
        diff,
        reprocessingRequired,
      });
      if (existing.configHistory.length > 20) {
        existing.configHistory = existing.configHistory.slice(-20);
      }

      await existing.save();
      log.info('Pipeline config updated', {
        tenantId,
        pipelineType,
        version: existing.version,
        reprocessingRequired,
      });
      return existing;
    }

    // Create new
    const newConfig = await PipelineConfigModel.create({
      tenantId,
      projectId: projectId ?? null,
      pipelineType,
      version: 1,
      enabled: false,
      config,
      activeTriggers: triggerOptions?.activeTriggers,
      triggerConfigs: triggerOptions?.triggerConfigs
        ? new Map(
            Object.entries(triggerOptions.triggerConfigs).map(([k, v]) => [
              k,
              {
                samplingRate: v.samplingRate,
                stepOverrides: v.stepOverrides
                  ? new Map(Object.entries(v.stepOverrides))
                  : undefined,
              },
            ]),
          )
        : undefined,
      createdBy: updatedBy,
      updatedBy,
    });

    log.info('Pipeline config created', { tenantId, pipelineType });
    return newConfig;
  }

  /**
   * Determine if a config change requires re-processing historical data.
   * When a definition is provided, uses configSchema.fields[].reprocessOnChange.
   */
  requiresReprocessing(
    _pipelineType: PipelineType | string,
    diff: Record<string, { old: unknown; new: unknown }>,
    definition?: PipelineDefinition,
  ): boolean {
    if (definition?.configSchema) {
      const reprocessFields = new Set(
        definition.configSchema.fields.filter((f) => f.reprocessOnChange).map((f) => f.name),
      );
      return Object.keys(diff).some((key) => reprocessFields.has(key));
    }

    // Fallback: hardcoded keys for backward compat
    const reprocessKeys = new Set([
      'taxonomy',
      'dimensions',
      'model',
      'classificationPrompt',
      'evaluatorSystemPrompt',
      'granularity',
      'scale',
      'multiLabel',
    ]);

    return Object.keys(diff).some((key) => reprocessKeys.has(key));
  }
}
