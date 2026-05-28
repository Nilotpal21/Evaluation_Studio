/**
 * Bundle Export Route
 *
 * GET /api/projects/:id/bundle?format=zip
 * Streams a ZIP archive of the complete ABL project.
 */

import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import {
  ConnectorConfig,
  MCPServerConfig,
  ProjectAgent,
  ProjectConfigVariable,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  ProjectTool,
  type IProjectAgent,
  type IProjectTool,
} from '@agent-platform/database/models';
import {
  buildExportProvisioningRequirements,
  exportProjectV2,
  extractProfileManifestEntries,
  resolveLayers,
  resolveLayersForToolDependencies,
  type ExportV2Deps,
} from '@agent-platform/project-io/export';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import {
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
} from '@/lib/project-agent-export-readiness';

const log = createLogger('bundle-route');

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await context.params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const [agents, tools, profileDocs, connectorConfigs, mcpServers, runtimeConfig, llmConfig] =
      await Promise.all([
        ProjectAgent.find({ projectId, tenantId: access.project.tenantId })
          .select(
            'name description dslContent ownerId ownerTeamId version status systemPromptLibraryRef dslValidationStatus dslDiagnostics',
          )
          .lean(),
        ProjectTool.find({ projectId, tenantId: access.project.tenantId })
          .select('name slug toolType dslContent')
          .lean(),
        ProjectConfigVariable.find({
          projectId,
          tenantId: access.project.tenantId,
          key: /^profile:/,
        })
          .select('key value')
          .lean(),
        ConnectorConfig.find({ projectId, tenantId: access.project.tenantId })
          .select('connectorType')
          .lean(),
        MCPServerConfig.find({ projectId, tenantId: access.project.tenantId })
          .select('name')
          .lean(),
        ProjectRuntimeConfig.findOne({
          projectId,
          tenantId: access.project.tenantId,
        }).lean(),
        ProjectLLMConfig.findOne({
          projectId,
          tenantId: access.project.tenantId,
        }).lean(),
      ]);
    const readinessIssues = await getProjectExportReadinessIssues({
      agents,
      projectId,
      tenantId: access.project.tenantId,
      runtimeConfig: (runtimeConfig as Record<string, unknown> | null) ?? null,
      llmConfig: (llmConfig as Record<string, unknown> | null) ?? null,
    });
    if (readinessIssues.length > 0) {
      return NextResponse.json(buildInvalidProjectExportPayload(readinessIssues), {
        status: 409,
      });
    }

    const layers = resolveLayersForToolDependencies(
      resolveLayers(),
      tools.map((tool: IProjectTool) => ({
        name: tool.name,
        dslContent: tool.dslContent,
        toolType: tool.toolType,
      })),
    );
    const { buildAssemblerMap } = await import('@/lib/export-assemblers');
    const assemblers = buildAssemblerMap(layers);

    const profiles = new Map<string, string>();
    for (const doc of profileDocs as Array<{ key: string; value: string }>) {
      const profileName = behaviorProfileConfigKeyToName(doc.key);
      if (profileName) {
        profiles.set(profileName, doc.value);
      }
    }

    const profileManifestEntries = extractProfileManifestEntries(
      profiles,
      agents.map((agent: IProjectAgent) => ({
        name: agent.name,
        dslContent: agent.dslContent ?? '',
      })),
    );
    const profileEntries = [...profiles.entries()].map(([name, dslContent]) => ({
      name,
      dslContent,
    }));
    const provisioning = buildExportProvisioningRequirements({
      agents: agents.map((agent: IProjectAgent) => ({
        name: agent.name,
        dslContent: agent.dslContent ?? '',
      })),
      tools: tools.map((tool: IProjectTool) => ({ name: tool.name, dslContent: tool.dslContent })),
      profiles: profileEntries,
      connectorConfigs,
      mcpServers,
    });

    const exportResult = await exportProjectV2(
      {
        projectId,
        userId: user.id,
        tenantId: access.project.tenantId,
        format: 'zip',
        layers,
        dslFormat: 'yaml',
        includeDeployments: false,
      },
      {
        assemblers,
        agentData: agents.map((agent: IProjectAgent) => ({
          name: agent.name,
          version: '1.0',
          dslContent: agent.dslContent ?? '',
          status: 'active',
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        })),
        toolData: tools.map((tool: IProjectTool) => ({
          name: tool.name,
          dslContent: tool.dslContent,
          toolType: tool.toolType,
        })),
      } satisfies ExportV2Deps,
      {
        projectName: access.project.name,
        projectSlug: access.project.slug,
        projectDescription: (access.project.description as string | null) ?? null,
        exportedBy: user.id,
        entryAgent: (access.project.entryAgentName as string | null) ?? null,
        agents: agents.map((agent: IProjectAgent) => ({
          name: agent.name,
          description: agent.description ?? null,
          ownerId: agent.ownerId ?? null,
          ownerTeamId: agent.ownerTeamId ?? null,
          version: null,
          systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
        })),
        tools: tools.map((tool: IProjectTool) => ({ name: tool.name, ownerId: null })),
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

    if (!exportResult.success) {
      return NextResponse.json(
        { success: false, error: exportResult.error?.message ?? 'Bundle export failed' },
        { status: 400 },
      );
    }

    const slug = access.project.slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    // Build ZIP archive
    const zip = new JSZip();
    for (const [path, content] of exportResult.files) {
      zip.file(path, content);
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slug}.abl.zip"`,
        'Content-Length': String(zipBuffer.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Bundle export failed', { projectId, error: message });
    return NextResponse.json({ success: false, error: 'Bundle export failed' }, { status: 500 });
  }
}
