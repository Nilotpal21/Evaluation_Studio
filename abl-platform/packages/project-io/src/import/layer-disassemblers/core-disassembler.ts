/**
 * CoreDisassembler — converts exported core layer files back into StagedRecords.
 *
 * Handles: agents, tools, project settings, runtime config, LLM config,
 * agent model configs, environment variables, config variables, MCP servers,
 * behavior profiles, and locale files.
 *
 * Pure function — no DB access. All ownership fields injected from server context.
 */

import { validateAgentName } from '@agent-platform/shared';
import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import { extractAgentName } from '../folder-reader.js';
import { extractToolsFromFiles } from '../tool-extractor.js';
import {
  behaviorProfileNameToConfigKey,
  extractBehaviorProfileNameFromDsl,
} from '../../behavior-profile-files.js';
import {
  safeParseJSON,
  safeParseJSONArray,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildImportedSingletonSuperseded,
  buildMatchingSuperseded,
  extractNameFromPath,
  stripImportedConfigContextFields,
} from './disassembler-utils.js';
import { isMcpServerConfigFilePath, parseMcpServerConfigData } from '../../mcp-server-config-io.js';

const PROJECT_MODEL_CONFIG_PATTERN = /^config\/project-model-configs\/[^/]+\.model-config\.json$/;
const BEHAVIOR_PROFILE_PATH_PATTERN = /^behavior_profiles\/[^/]+\.abl$/;

function behaviorProfileNameFromPath(filePath: string): string {
  return filePath
    .replace(/^behavior_profiles\//, '')
    .replace(/\.behavior_profile\.abl$/, '')
    .replace(/\.profile\.abl$/, '')
    .replace(/\.abl$/, '');
}

/** Check if a record with matching field value exists in the existing record list. */
function existsInExisting(
  existing: Array<{ _id: string; [key: string]: unknown }> | undefined,
  matchField: string,
  matchValue: string,
): boolean {
  if (!existing) return false;
  return existing.some((r) => r[matchField] === matchValue);
}

export class CoreDisassembler implements LayerDisassembler {
  readonly layer = 'core' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    const existingAgents = ctx.existingRecordIds?.get('project_agents');
    const existingTools = ctx.existingRecordIds?.get('project_tools');
    const existingSettings = ctx.existingRecordIds?.get('project_settings');
    const existingRuntimeConfigs = ctx.existingRecordIds?.get('project_runtime_configs');
    const existingLlmConfigs = ctx.existingRecordIds?.get('project_llm_configs');
    const existingProjectModelConfigs = ctx.existingRecordIds?.get('model_configs');
    const existingAgentModelConfigs = ctx.existingRecordIds?.get('agent_model_configs');
    const existingEnvVars = ctx.existingRecordIds?.get('environment_variables');
    const existingConfigVars = ctx.existingRecordIds?.get('project_config_variables');
    const existingMcpServers = ctx.existingRecordIds?.get('mcp_server_configs');

    const toolFiles = new Map(
      Array.from(ctx.files.entries()).filter(([filePath]) =>
        filePath.match(/^tools\/[^/]+\.tools\.abl$/),
      ),
    );
    const extractedTools = extractToolsFromFiles(toolFiles);
    for (const error of extractedTools.errors) {
      warnings.push(`Skipping ${error.sourceFile}: ${error.message}`);
    }
    for (const warning of extractedTools.warnings) {
      warnings.push(`${warning.sourceFile}: ${warning.message}`);
    }
    for (const tool of extractedTools.tools) {
      if (
        ctx.conflictStrategy === 'skip' &&
        (existsInExisting(existingTools, 'slug', tool.name) ||
          existsInExisting(existingTools, 'name', tool.name))
      ) {
        continue;
      }

      const data = injectOwnership(
        {
          name: tool.name,
          slug: tool.name,
          toolType: tool.toolType,
          description: tool.description,
          dslContent: tool.dslContent,
          sourceHash: tool.sourceHash,
          sourceFile: tool.sourceFile,
        },
        ctx,
      );
      records.push(buildRecord('core', 'project_tools', data));
    }

    for (const [filePath, content] of ctx.files) {
      // --- Agents ---
      if (
        filePath.match(/^agents\/[^/]+\.agent\.abl$/) ||
        filePath.match(/^agents\/[^/]+\.agent\.yaml$/)
      ) {
        const fileBaseName =
          extractNameFromPath(filePath, '.agent.abl') ??
          extractNameFromPath(filePath, '.agent.yaml');
        const agentName = extractAgentName(content) ?? fileBaseName;

        if (!agentName) {
          warnings.push(`Skipping ${filePath}: could not determine agent name`);
          continue;
        }

        const nameError = validateAgentName(agentName);
        if (nameError) {
          warnings.push(`Invalid agent name "${agentName}" in ${filePath}: ${nameError}`);
          continue;
        }

        if (
          ctx.conflictStrategy === 'skip' &&
          existsInExisting(existingAgents, 'name', agentName)
        ) {
          continue;
        }

        const manifestAgent =
          ctx.manifestAgents?.[agentName] ??
          Object.values(ctx.manifestAgents ?? {}).find((agent) => agent.path === filePath) ??
          null;

        const data = injectOwnership(
          {
            name: agentName,
            description: manifestAgent?.description ?? null,
            dslContent: content,
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
            systemPromptLibraryRef: manifestAgent?.systemPromptLibraryRef ?? null,
          },
          ctx,
        );
        records.push(buildRecord('core', 'project_agents', data));
        continue;
      }

      // --- Tools ---
      if (filePath.match(/^tools\/[^/]+\.tools\.abl$/)) {
        continue;
      }

      // --- Project Settings (singleton) ---
      if (filePath === 'config/project-settings.json') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const data = injectOwnership(stripImportedConfigContextFields(parsed), ctx);
        records.push(buildRecord('core', 'project_settings', data));
        continue;
      }

      // --- Runtime Config (singleton) ---
      if (filePath === 'config/runtime-config.json') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const data = injectOwnership(stripImportedConfigContextFields(parsed), ctx);
        records.push(buildRecord('core', 'project_runtime_configs', data));
        continue;
      }

      // --- LLM Config (singleton, keys stripped on export) ---
      if (filePath === 'config/llm-config.json') {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const data = injectOwnership(stripImportedConfigContextFields(parsed), ctx);
        records.push(buildRecord('core', 'project_llm_configs', data));
        continue;
      }

      // --- Project Model Configs ---
      if (filePath.match(PROJECT_MODEL_CONFIG_PATTERN)) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const name = typeof parsed.name === 'string' ? parsed.name : null;
        if (!name) {
          warnings.push(`Skipping ${filePath}: project model config is missing name`);
          continue;
        }
        if (
          ctx.conflictStrategy === 'skip' &&
          existsInExisting(existingProjectModelConfigs, 'name', name)
        ) {
          continue;
        }
        const data = injectOwnership(stripImportedConfigContextFields(parsed), ctx);
        records.push(buildRecord('core', 'model_configs', data));
        continue;
      }

      // --- Agent Model Configs ---
      if (filePath.match(/^config\/agent-model-configs\/[^/]+\.model-config\.json$/)) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;
        const data = injectOwnership(stripImportedConfigContextFields(parsed), ctx);
        records.push(buildRecord('core', 'agent_model_configs', data));
        continue;
      }

      // --- Environment Variables (array file, reference-only) ---
      if (filePath === 'environment/env-vars.json') {
        const entries = safeParseJSONArray(filePath, content, warnings);
        for (const entry of entries) {
          const cleanEntry = stripImportedConfigContextFields(entry);
          const environment =
            typeof cleanEntry.environment === 'string' && cleanEntry.environment.trim().length > 0
              ? cleanEntry.environment
              : 'global';
          const data = injectOwnership(
            {
              key: cleanEntry.key,
              description: cleanEntry.description ?? null,
              isSecret: cleanEntry.isSecret ?? false,
              environment,
            },
            ctx,
          );
          records.push(buildRecord('core', 'environment_variables', data));
        }
        continue;
      }

      // --- Config Variables (array file) ---
      if (filePath === 'environment/config-vars.json') {
        const entries = safeParseJSONArray(filePath, content, warnings);
        for (const entry of entries) {
          const data = injectOwnership(stripImportedConfigContextFields(entry), ctx);
          records.push(buildRecord('core', 'project_config_variables', data));
        }
        continue;
      }

      // --- MCP Server Configs ---
      if (isMcpServerConfigFilePath(filePath)) {
        const parsed = safeParseJSON(filePath, content, warnings);
        if (!parsed) continue;

        const validated = parseMcpServerConfigData(parsed);
        if (!validated.success) {
          warnings.push(`Skipping ${filePath}: ${validated.error}`);
          continue;
        }

        const data = injectOwnership(validated.data, ctx);
        records.push(buildRecord('core', 'mcp_server_configs', data));
        continue;
      }

      // --- Behavior Profiles (stored as config variables with profile: prefix) ---
      if (BEHAVIOR_PROFILE_PATH_PATTERN.test(filePath)) {
        const profileName =
          extractBehaviorProfileNameFromDsl(content) ?? behaviorProfileNameFromPath(filePath);
        if (!profileName) {
          warnings.push(`Skipping ${filePath}: could not extract profile name`);
          continue;
        }

        const data = injectOwnership(
          {
            key: behaviorProfileNameToConfigKey(profileName),
            value: content,
            description: `Behavior profile: ${profileName}`,
          },
          ctx,
        );
        records.push(buildRecord('core', 'project_config_variables', data));
        continue;
      }

      // --- Locale Files (stored as config variables with locale: prefix) ---
      if (filePath.match(/^locales\/.+\.json$/)) {
        const localePath = filePath.replace(/^locales\//, '');
        const data = injectOwnership(
          {
            key: `locale:${localePath}`,
            value: content,
            description: `Locale file: ${localePath}`,
          },
          ctx,
        );
        records.push(buildRecord('core', 'project_config_variables', data));
        continue;
      }
    }

    const recordsForCollection = (collection: string) =>
      records.filter((record) => record.collection === collection);
    const projectLlmConfigRecords = recordsForCollection('project_llm_configs');
    const projectModelConfigRecords = recordsForCollection('model_configs');

    // --- Build superseded records for replacement strategies ---
    if (ctx.conflictStrategy === 'replace') {
      superseded.push(...buildSuperseded('core', 'project_agents', existingAgents));
      superseded.push(...buildSuperseded('core', 'project_tools', existingTools));
      superseded.push(...buildSuperseded('core', 'project_settings', existingSettings));
      superseded.push(
        ...buildSuperseded('core', 'project_runtime_configs', existingRuntimeConfigs),
      );
      superseded.push(...buildSuperseded('core', 'project_llm_configs', existingLlmConfigs));
      superseded.push(...buildSuperseded('core', 'model_configs', existingProjectModelConfigs));
      superseded.push(...buildSuperseded('core', 'agent_model_configs', existingAgentModelConfigs));
      superseded.push(...buildSuperseded('core', 'environment_variables', existingEnvVars));
      superseded.push(...buildSuperseded('core', 'project_config_variables', existingConfigVars));
      superseded.push(...buildSuperseded('core', 'mcp_server_configs', existingMcpServers));
    } else if (ctx.conflictStrategy === 'merge') {
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'project_agents',
          existingAgents,
          recordsForCollection('project_agents'),
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'project_tools',
          existingTools,
          recordsForCollection('project_tools'),
          'slug',
        ),
      );
      superseded.push(
        ...buildImportedSingletonSuperseded(
          'core',
          'project_settings',
          existingSettings,
          recordsForCollection('project_settings'),
        ),
      );
      superseded.push(
        ...buildImportedSingletonSuperseded(
          'core',
          'project_runtime_configs',
          existingRuntimeConfigs,
          recordsForCollection('project_runtime_configs'),
        ),
      );
      superseded.push(
        ...buildImportedSingletonSuperseded(
          'core',
          'project_llm_configs',
          existingLlmConfigs,
          projectLlmConfigRecords,
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'model_configs',
          existingProjectModelConfigs,
          projectModelConfigRecords,
          'name',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'agent_model_configs',
          existingAgentModelConfigs,
          recordsForCollection('agent_model_configs'),
          'agentName',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'environment_variables',
          existingEnvVars,
          recordsForCollection('environment_variables'),
          ['key', 'environment'],
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'project_config_variables',
          existingConfigVars,
          recordsForCollection('project_config_variables'),
          'key',
        ),
      );
      superseded.push(
        ...buildMatchingSuperseded(
          'core',
          'mcp_server_configs',
          existingMcpServers,
          recordsForCollection('mcp_server_configs'),
          'name',
        ),
      );
    }

    return { records, superseded, warnings };
  }
}
