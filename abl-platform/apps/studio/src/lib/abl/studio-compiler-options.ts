import type { CompilerOptions } from '@abl/compiler';
import { mapProjectRuntimeConfigDocumentToIR } from '@abl/compiler/platform/ir/project-runtime-config.js';
import type { AgentBasedDocument } from '@abl/core';
import {
  getProjectExportReadinessIssues,
  type ProjectAgentExportReadinessDiagnostic,
  type ProjectExportReadinessIssue,
} from '@agent-platform/project-io';

interface BuildStudioCompilerOptionsInput {
  configVariables?: Record<string, string>;
  documents: AgentBasedDocument[];
  projectId: string;
  tenantId: string;
  runtimeConfigReadinessMode?: 'blocking' | 'warning';
  toolResolutionMode?: 'blocking' | 'warning';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function describeRuntimeConfigUsage(projectRuntimeConfig: unknown): string[] {
  const config = asRecord(projectRuntimeConfig);
  if (!config) return [];

  const usages: string[] = [];
  const pipeline = asRecord(config.pipeline);
  if (pipeline?.modelSource === 'tenant') {
    const tenantModelId = stringValue(pipeline.tenantModelId) ?? '<missing>';
    usages.push(
      `Project Settings > Runtime Config > Reasoning pipeline model uses tenantModelId "${tenantModelId}"`,
    );
  }

  const filler = asRecord(config.filler);
  if (filler?.modelSource === 'tenant') {
    const tenantModelId = stringValue(filler.tenantModelId) ?? '<missing>';
    usages.push(
      `Project Settings > Runtime Config > Contextual filler model uses tenantModelId "${tenantModelId}"`,
    );
  }
  if (filler?.modelSource === 'project') {
    const modelId = stringValue(filler.modelId) ?? '<missing>';
    usages.push(
      `Project Settings > Runtime Config > Contextual filler model uses project model "${modelId}"`,
    );
  }

  return usages;
}

function describeAdvancedNluUsage(projectRuntimeConfig: unknown): string[] {
  const extraction = asRecord(asRecord(projectRuntimeConfig)?.extraction);
  if (extraction?.nlu_provider !== 'advanced') {
    return [];
  }
  return ['Project Settings > Runtime Config > Extraction uses advanced NLU provider'];
}

function describeReadinessNextStep(diagnostic: ProjectAgentExportReadinessDiagnostic): string {
  const message = diagnostic.message.toLowerCase();
  if (message.includes('tenant model')) {
    return 'Choose an active tenant model in Runtime Config, switch the affected model source back to default, or recreate/enable the tenant model in Admin > Models.';
  }
  if (message.includes('advanced_sidecar_url')) {
    return 'Set the advanced sidecar URL in Runtime Config or switch the extraction provider back to standard.';
  }
  if (message.includes('operation-tier') || message.includes('operation tier')) {
    return 'Review the project model policy operation-tier overrides and choose supported tiers.';
  }
  if (message.includes('prompt')) {
    return 'Choose an active prompt version or remove the stale prompt override.';
  }
  return 'Update the referenced project runtime/model setting, then recompile.';
}

function describeReadinessUsage(
  issue: ProjectExportReadinessIssue,
  diagnostic: ProjectAgentExportReadinessDiagnostic,
  projectRuntimeConfig: unknown,
): string {
  if (issue.kind === 'runtime_config') {
    const message = diagnostic.message.toLowerCase();
    const runtimeModelUsages = describeRuntimeConfigUsage(projectRuntimeConfig);
    if (message.includes('tenant model') && runtimeModelUsages.length > 0) {
      return runtimeModelUsages.join('; ');
    }
    const advancedNluUsage = describeAdvancedNluUsage(projectRuntimeConfig);
    if (message.includes('advanced_sidecar_url') && advancedNluUsage.length > 0) {
      return advancedNluUsage.join('; ');
    }
    return 'Project Settings > Runtime Config';
  }

  if (issue.kind === 'model_policy') {
    return 'Project Settings > Runtime Config > Model policy';
  }

  return 'Project agent configuration';
}

function formatRuntimeConfigReadinessErrors(
  issues: ProjectExportReadinessIssue[],
  projectRuntimeConfig: unknown,
): string[] {
  return issues.flatMap((issue) =>
    issue.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => {
        const usage = describeReadinessUsage(issue, diagnostic, projectRuntimeConfig);
        const nextStep = describeReadinessNextStep(diagnostic);
        return [
          `Project configuration is not execution-ready: ${diagnostic.message}`,
          `Used by: ${usage}`,
          `Next: ${nextStep}`,
          'Visual editing is still available; chat/test/publish may fail until this is fixed.',
        ].join(' ');
      }),
  );
}

export async function buildStudioCompilerOptions({
  configVariables,
  documents,
  projectId,
  runtimeConfigReadinessMode = 'warning',
  tenantId,
  toolResolutionMode = 'warning',
}: BuildStudioCompilerOptionsInput): Promise<{
  compilerOptions: CompilerOptions;
  errors: string[];
  warnings: string[];
}> {
  const compilerOptions: CompilerOptions = {};
  const errors: string[] = [];
  const warnings: string[] = [];

  if (configVariables && Object.keys(configVariables).length > 0) {
    compilerOptions.config_variables = configVariables;
  }

  try {
    const { ProjectRuntimeConfig, ProjectLLMConfig } =
      await import('@agent-platform/database/models');
    const [projectRuntimeConfig, projectLLMConfig] = await Promise.all([
      ProjectRuntimeConfig.findOne({ tenantId, projectId }).lean(),
      ProjectLLMConfig.findOne({ tenantId, projectId }).lean(),
    ]);
    if (projectRuntimeConfig || projectLLMConfig) {
      const readinessIssues = await getProjectExportReadinessIssues({
        agents: [],
        tenantId,
        projectId,
        runtimeConfig: (projectRuntimeConfig as Record<string, unknown> | null) ?? null,
        llmConfig: (projectLLMConfig as Record<string, unknown> | null) ?? null,
      });
      const runtimeConfigErrors = formatRuntimeConfigReadinessErrors(
        readinessIssues,
        projectRuntimeConfig,
      );
      if (runtimeConfigErrors.length > 0) {
        if (runtimeConfigReadinessMode === 'blocking') {
          errors.push(...runtimeConfigErrors);
        } else {
          warnings.push(...runtimeConfigErrors);
        }
      }
      warnings.push(
        ...readinessIssues.flatMap((issue) =>
          issue.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'warning')
            .map((diagnostic) => `Project runtime config readiness warning: ${diagnostic.message}`),
        ),
      );
    }
    if (projectRuntimeConfig) {
      compilerOptions.project_runtime_config =
        mapProjectRuntimeConfigDocumentToIR(projectRuntimeConfig);
    }
  } catch (err) {
    warnings.push(
      `Project runtime config resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const toolsByAgent = new Map<string, string[]>();
  for (const document of documents) {
    const toolNames = (document.tools ?? []).map((tool) => tool.name).filter(Boolean);
    if (toolNames.length > 0) {
      toolsByAgent.set(document.name, toolNames);
    }
  }

  if (toolsByAgent.size === 0) {
    return { compilerOptions, errors, warnings };
  }

  try {
    const { resolveToolImplementations } = await import('@agent-platform/shared/tools/resolve');
    const { buildModuleToolResolver } =
      await import('@agent-platform/shared/tools/resolve-module-tool');
    const { findMcpServerConfigsRaw } = await import('@agent-platform/shared/repos');
    const { buildStudioConnectorToolResolver } = await import('@/lib/connection-service');
    const resolved = await resolveToolImplementations(
      {
        tenantId,
        projectId,
        toolsByAgent,
      },
      {
        mcpServerConfigRawLoader: (tid: string, pid: string) => findMcpServerConfigsRaw(tid, pid),
        connectorToolResolver: await buildStudioConnectorToolResolver(),
        moduleToolResolver: buildModuleToolResolver(tenantId, projectId),
      },
    );

    compilerOptions.resolvedToolImplementations = resolved.resolvedByAgent as NonNullable<
      CompilerOptions['resolvedToolImplementations']
    >;
    const toolResolutionErrors = resolved.errors.map(
      (entry: { code: string; message: string }) => `${entry.code}: ${entry.message}`,
    );
    if (toolResolutionMode === 'blocking') {
      errors.push(...toolResolutionErrors);
    } else {
      warnings.push(...toolResolutionErrors);
    }
    warnings.push(
      ...resolved.warnings.map(
        (entry: { code: string; message: string }) => `${entry.code}: ${entry.message}`,
      ),
    );
  } catch (err) {
    const message = `Tool resolution failed: ${err instanceof Error ? err.message : String(err)}`;
    if (toolResolutionMode === 'blocking') {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }

  return { compilerOptions, errors, warnings };
}
