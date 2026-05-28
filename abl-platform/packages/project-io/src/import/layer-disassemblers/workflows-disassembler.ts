/**
 * WorkflowsDisassembler — converts exported workflow files back into StagedRecords.
 *
 * Handles: workflow definitions and workflow version files.
 * All imported workflows are reset to 'draft' status.
 * Workflow versions get a temporary _workflowName field for cross-ref resolution.
 *
 * Pure function — no DB access. All ownership fields injected from server context.
 */

import type { LayerDisassembler, DisassembleContext, DisassembleResult } from './types.js';
import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import {
  safeParseJSON,
  injectOwnership,
  buildRecord,
  buildSuperseded,
  buildMatchingSuperseded,
  buildSupersededByImportedValues,
  extractNameFromPath,
} from './disassembler-utils.js';

/** Check if a record with matching field value exists in the existing record list. */
function existsInExisting(
  existing: Array<{ _id: string; [key: string]: unknown }> | undefined,
  matchField: string,
  matchValue: string,
): boolean {
  if (!existing) return false;
  return existing.some((r) => r[matchField] === matchValue);
}

function workflowPathKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

function triggerTypeFromExport(trigger: Record<string, unknown>): string {
  const triggerType = trigger.triggerType ?? trigger.type;
  return typeof triggerType === 'string' && triggerType.length > 0 ? triggerType : 'webhook';
}

function triggerNameFromExport(trigger: Record<string, unknown>, triggerType: string): string {
  const triggerName = trigger.triggerName;
  return typeof triggerName === 'string' && triggerName.length > 0 ? triggerName : triggerType;
}

function triggerConfigFromExport(trigger: Record<string, unknown>): Record<string, unknown> {
  const config = trigger.config;
  return config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function buildTriggerRegistrationData(input: {
  trigger: Record<string, unknown>;
  workflowName: string;
  workflowVersion: string;
  ctx: DisassembleContext;
  warnings: string[];
}): Record<string, unknown> | null {
  const exportedId = input.trigger.id ?? input.trigger._exportedId;
  if (typeof exportedId !== 'string' || exportedId.length === 0) {
    return null;
  }

  const triggerType = triggerTypeFromExport(input.trigger);
  const triggerName = triggerNameFromExport(input.trigger, triggerType);
  const data: Record<string, unknown> = {
    _exportedId: exportedId,
    _workflowName: input.workflowName,
    _workflowVersion: input.workflowVersion,
    triggerName,
    triggerType,
    status: typeof input.trigger.status === 'string' ? input.trigger.status : 'active',
    config: triggerConfigFromExport(input.trigger),
  };

  for (const key of [
    'webhookMode',
    'webhookDelivery',
    'cronExpression',
    'pollingIntervalMs',
    'environment',
  ]) {
    if (input.trigger[key] !== undefined) {
      data[key] = input.trigger[key];
    }
  }
  const authProfileName = input.trigger.authProfileName;
  if (typeof authProfileName === 'string' && authProfileName.length > 0) {
    const mappedId = input.ctx.authProfileMapping?.[authProfileName];
    if (mappedId) {
      data.authProfileId = mappedId;
    } else {
      input.warnings.push(
        `Workflow trigger '${triggerName}' references auth profile '${authProfileName}' but no mapping was provided`,
      );
    }
  }

  return injectOwnership(data, input.ctx);
}

export class WorkflowsDisassembler implements LayerDisassembler {
  readonly layer = 'workflows' as const;

  async disassemble(ctx: DisassembleContext): Promise<DisassembleResult> {
    const records: StagedRecord[] = [];
    const superseded: SupersededRecord[] = [];
    const warnings: string[] = [];

    const existingWorkflows = ctx.existingRecordIds?.get('workflows');
    const existingVersions = ctx.existingRecordIds?.get('workflow_versions');
    const existingTriggers = ctx.existingRecordIds?.get('trigger_registrations');

    // Separate workflow definition files from version files
    const versionFiles = new Map<string, string>();
    const workflowNameByPathKey = new Map<string, string>();
    // Track skipped workflow names so their versions are also skipped
    const skippedWorkflowNames = new Set<string>();

    // --- Phase 1: Parse workflow definitions ---
    for (const [filePath, content] of ctx.files) {
      // Skip version files — handled in Phase 2
      if (filePath.startsWith('workflows/versions/')) {
        if (filePath.endsWith('.version.json')) {
          versionFiles.set(filePath, content);
        }
        continue;
      }

      if (!filePath.match(/^workflows\/[^/]+\.workflow\.json$/)) {
        continue;
      }

      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      const name = (parsed.name as string) ?? extractNameFromPath(filePath, '.workflow.json');
      if (!name) {
        warnings.push(`Skipping ${filePath}: could not determine workflow name`);
        continue;
      }
      // Ensure name is on the record for cross-ref resolver (anchorMatchField: 'name')
      parsed.name = name;
      const exportedWorkflowId = parsed.id ?? parsed._exportedId;
      if (typeof exportedWorkflowId === 'string' && exportedWorkflowId.length > 0) {
        parsed._exportedId = exportedWorkflowId;
      }
      const workflowFileName = extractNameFromPath(filePath, '.workflow.json');
      if (workflowFileName) {
        workflowNameByPathKey.set(workflowPathKey(workflowFileName), name);
      }
      workflowNameByPathKey.set(workflowPathKey(name), name);

      // Skip if conflict strategy is 'skip' and a matching workflow already exists
      if (ctx.conflictStrategy === 'skip' && existsInExisting(existingWorkflows, 'name', name)) {
        skippedWorkflowNames.add(name);
        continue;
      }

      // Remove runtime-only fields — in the version-first model, Workflow is a
      // thin container and deployment endpoint slugs are tenant-global.
      delete parsed.status;
      delete parsed.deployment;

      // Detect old-format (fat) workflow files that contain definition fields
      const hasLegacyFields = parsed.nodes || parsed.edges || parsed.steps || parsed.triggers;

      // Strip version-owned fields from the workflow container
      const legacyNodes = parsed.nodes;
      const legacyEdges = parsed.edges;
      const legacySteps = parsed.steps;
      const legacyTriggers = parsed.triggers;
      const legacyEnvVars = parsed.envVars;
      const legacyInputSchema = parsed.inputSchema;
      const legacyOutputSchema = parsed.outputSchema;
      delete parsed.nodes;
      delete parsed.edges;
      delete parsed.steps;
      delete parsed.triggers;
      delete parsed.envVars;
      delete parsed.inputSchema;
      delete parsed.outputSchema;

      const data = injectOwnership(parsed, ctx);
      records.push(buildRecord('workflows', 'workflows', data));

      // For old-format files, synthesize a draft version from the legacy fields
      if (hasLegacyFields) {
        const draftData = injectOwnership(
          {
            _workflowName: name,
            version: 'draft',
            state: 'active',
            definition: {
              nodes: legacyNodes ?? [],
              edges: legacyEdges ?? [],
              envVars: legacyEnvVars ?? {},
              inputSchema: legacyInputSchema ?? null,
              outputSchema: legacyOutputSchema ?? null,
            },
            triggers: legacyTriggers ?? [],
            sourceHash: null,
            changelog: null,
            createdBy: ctx.userId,
          },
          ctx,
        );
        records.push(buildRecord('workflows', 'workflow_versions', draftData));
      }
    }

    // --- Phase 2: Parse workflow versions ---
    for (const [filePath, content] of versionFiles) {
      const parsed = safeParseJSON(filePath, content, warnings);
      if (!parsed) continue;

      // Extract workflow name from path: workflows/versions/{name}/{version}.version.json
      const pathParts = filePath.split('/');
      const workflowPathName = pathParts[2]; // workflows/versions/{name}/...

      if (!workflowPathName) {
        warnings.push(
          `Skipping version file ${filePath}: could not extract workflow name from path`,
        );
        continue;
      }
      const workflowName =
        workflowNameByPathKey.get(workflowPathKey(workflowPathName)) ?? workflowPathName;

      // Skip version if the parent workflow was skipped
      if (skippedWorkflowNames.has(workflowName)) {
        continue;
      }

      if (!parsed.version || !parsed.definition) {
        warnings.push(
          `Skipping version file ${filePath}: missing required fields (version, definition)`,
        );
        continue;
      }

      const isDraft = parsed.version === 'draft';
      const data = injectOwnership(
        {
          _workflowName: workflowName, // Temporary field for cross-ref resolution
          version: parsed.version,
          definition: parsed.definition,
          state: isDraft ? 'active' : 'inactive', // Draft always active; published reset to inactive
          environment: (parsed.environment as string) ?? null,
          triggers: (parsed.triggers as unknown[]) ?? [],
          sourceHash: (parsed.source_hash as string) ?? null,
          changelog: (parsed.changelog as string) ?? null,
          publishedAt: (parsed.published_at as string) ?? null,
          createdBy: (parsed.created_by as string) ?? ctx.userId,
        },
        ctx,
      );
      records.push(buildRecord('workflows', 'workflow_versions', data));

      const triggers = Array.isArray(parsed.triggers) ? parsed.triggers : [];
      for (const trigger of triggers) {
        if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
          continue;
        }
        const triggerData = buildTriggerRegistrationData({
          trigger: trigger as Record<string, unknown>,
          workflowName,
          workflowVersion: String(parsed.version),
          ctx,
          warnings,
        });
        if (!triggerData) {
          warnings.push(
            `Skipping trigger in ${filePath}: missing portable trigger id for workflow "${workflowName}"`,
          );
          continue;
        }
        records.push(buildRecord('workflows', 'trigger_registrations', triggerData));
      }
    }

    // --- Build superseded records for replacement strategies ---
    if (ctx.conflictStrategy === 'replace') {
      superseded.push(...buildSuperseded('workflows', 'workflows', existingWorkflows));
      superseded.push(...buildSuperseded('workflows', 'workflow_versions', existingVersions));
      superseded.push(...buildSuperseded('workflows', 'trigger_registrations', existingTriggers));
    } else if (ctx.conflictStrategy === 'merge') {
      const importedWorkflows = records.filter((record) => record.collection === 'workflows');
      const matchingWorkflows = buildMatchingSuperseded(
        'workflows',
        'workflows',
        existingWorkflows,
        importedWorkflows,
        'name',
      );
      superseded.push(...matchingWorkflows);
      superseded.push(
        ...buildSupersededByImportedValues(
          'workflows',
          'workflow_versions',
          existingVersions,
          'workflowId',
          matchingWorkflows.map((record) => record.recordId),
        ),
      );
      superseded.push(
        ...buildSupersededByImportedValues(
          'workflows',
          'trigger_registrations',
          existingTriggers,
          'workflowId',
          matchingWorkflows.map((record) => record.recordId),
        ),
      );
    }

    return { records, superseded, warnings };
  }
}
