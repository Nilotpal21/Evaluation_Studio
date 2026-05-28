/**
 * Export Job Processor -- runs the actual export logic for async jobs.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  ensureConnected,
  Project,
  ProjectAgent,
  ProjectConfigVariable,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  ProjectTool,
  Deployment,
  type IProjectAgent,
  type IProjectTool,
} from '@agent-platform/database/models';
import {
  buildExportProvisioningRequirements,
  extractProfileManifestEntries,
  exportProjectV2,
  resolveLayers,
  resolveLayersForToolDependencies,
} from '@agent-platform/project-io/export';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import type { ExportV2Deps } from '@agent-platform/project-io/export';
import type { LayerName } from '@agent-platform/project-io';
import type { ExportJobData, ExportJobResult } from './export-queue';
import {
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
} from '@/lib/project-agent-export-readiness';

const log = createLogger('export-job-processor');

export async function processExportJob(
  data: ExportJobData,
  onProgress: (progress: number) => void,
): Promise<ExportJobResult> {
  const { projectId, tenantId, userId, format, dslFormat, includeDeployments } = data;

  await ensureConnected();
  onProgress(10);

  // Fetch real project metadata (tenant-scoped, never findById)
  const project = await Project.findOne({ _id: projectId, tenantId }).lean();
  const projectName = project?.name ?? 'unknown-project';
  const projectSlug = project?.slug ?? projectName;
  const projectDescription =
    ((project as Record<string, unknown> | null)?.description as string | null) ?? null;

  onProgress(20);

  const { ConnectorConfig, MCPServerConfig } = await import('@agent-platform/database/models');

  const [
    agents,
    tools,
    profileDocs,
    deployments,
    connectors,
    mcpServers,
    runtimeConfig,
    llmConfig,
  ] = await Promise.all([
    ProjectAgent.find({ projectId, tenantId }).lean(),
    ProjectTool.find({ projectId, tenantId }).lean(),
    ProjectConfigVariable.find({ projectId, tenantId, key: /^profile:/ })
      .select('key value')
      .lean(),
    includeDeployments ? Deployment.find({ projectId, tenantId }).lean() : Promise.resolve([]),
    ConnectorConfig.find({ projectId, tenantId }).select('connectorType').lean(),
    MCPServerConfig.find({ projectId, tenantId }).select('name').lean(),
    ProjectRuntimeConfig.findOne({ projectId, tenantId }).lean(),
    ProjectLLMConfig.findOne({ projectId, tenantId }).lean(),
  ]);

  const readinessIssues = await getProjectExportReadinessIssues({
    agents,
    projectId,
    tenantId,
    runtimeConfig: (runtimeConfig as Record<string, unknown> | null) ?? null,
    llmConfig: (llmConfig as Record<string, unknown> | null) ?? null,
  });
  if (readinessIssues.length > 0) {
    return buildInvalidProjectExportPayload(readinessIssues);
  }

  const profiles = new Map<string, string>();
  for (const doc of profileDocs as Array<{ key: string; value: string }>) {
    const profileName = behaviorProfileConfigKeyToName(doc.key);
    if (profileName) {
      profiles.set(profileName, doc.value);
    }
  }

  const profileManifestEntries = extractProfileManifestEntries(
    profiles,
    agents.map((a: IProjectAgent) => ({
      name: a.name,
      dslContent: a.dslContent ?? '',
    })),
  );
  const profileEntries = [...profiles.entries()].map(([name, dslContent]) => ({
    name,
    dslContent,
  }));

  onProgress(40);

  {
    const requestedLayers = data.layers as LayerName[] | undefined;
    const layers = resolveLayersForToolDependencies(
      requestedLayers ?? resolveLayers(requestedLayers),
      tools.map((tool: IProjectTool) => ({
        name: tool.name,
        dslContent: tool.dslContent,
        toolType: tool.toolType,
      })),
    );

    // Import assemblers
    const { buildAssemblerMap } = await import('@/lib/export-assemblers');
    const assemblers = buildAssemblerMap(layers);
    const provisioning = buildExportProvisioningRequirements({
      agents: agents.map((a: IProjectAgent) => ({ name: a.name, dslContent: a.dslContent ?? '' })),
      tools: tools.map((t: IProjectTool) => ({ name: t.name, dslContent: t.dslContent ?? '' })),
      profiles: profileEntries,
      connectorConfigs: connectors,
      mcpServers,
    });

    const result = await exportProjectV2(
      {
        projectId,
        userId,
        tenantId,
        format: format as 'folder' | 'zip' | 'tar.gz',
        layers,
        dslFormat,
        includeDeployments,
      },
      {
        assemblers,
        agentData: agents.map((a: IProjectAgent) => ({
          name: a.name,
          version: '1.0',
          dslContent: a.dslContent ?? '',
          status: 'active',
          systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
        })),
        toolData: tools.map((t: IProjectTool) => ({
          name: t.name,
          dslContent: t.dslContent,
          toolType: t.toolType,
        })),
      } satisfies ExportV2Deps,
      {
        projectName,
        projectSlug,
        projectDescription,
        exportedBy: userId,
        entryAgent: project?.entryAgentName ?? null,
        agents: agents.map((a: IProjectAgent) => ({
          name: a.name,
          description: a.description ?? null,
          ownerId: a.ownerId ?? null,
          ownerTeamId: a.ownerTeamId ?? null,
          version: null,
          systemPromptLibraryRef: a.systemPromptLibraryRef ?? null,
        })),
        tools: tools.map((t: IProjectTool) => ({ name: t.name, ownerId: null })),
        profiles: profileManifestEntries,
        entityCounts: {
          agents: agents.length,
          tools: tools.length,
          behavior_profiles: profileManifestEntries.length,
        },
        requiredEnvVars: provisioning.requiredEnvVars,
        requiredAuthProfiles: provisioning.requiredAuthProfiles,
        requiredConnectors: provisioning.requiredConnectors,
        requiredMcpServers: provisioning.requiredMcpServers,
      },
    );

    onProgress(90);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const filesObj: Record<string, string> = {};
    for (const [path, content] of result.files) {
      filesObj[path] = content;
    }

    return {
      success: true,
      files: filesObj,
      manifest: result.manifest,
      lockfile: result.lockfile,
      warnings: result.warnings,
    };
  }
}
