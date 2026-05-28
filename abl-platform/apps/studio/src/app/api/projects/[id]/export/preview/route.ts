/**
 * POST /api/projects/:id/export/preview
 *
 * Preview what will be exported without generating the archive (JWT auth only).
 * Returns per-layer entity counts and required provisioning info for v2.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import {
  ConnectorConfig,
  MCPServerConfig,
  ProjectAgent,
  ProjectTool,
  ProjectConfigVariable,
  ProjectRuntimeConfig,
  ProjectLLMConfig,
  type IProjectAgent,
  type IProjectTool,
} from '@agent-platform/database/models';
import { behaviorProfileConfigKeyToName } from '@agent-platform/project-io';
import {
  buildDependencyGraph,
  validateDependencies,
} from '@agent-platform/project-io/dependencies';
import {
  buildExportProvisioningRequirements,
  buildLayerPreview,
  resolveLayers,
} from '@agent-platform/project-io/export';
import {
  buildInvalidProjectExportPayload,
  getProjectExportReadinessIssues,
} from '@/lib/project-agent-export-readiness';

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
    rateLimit: { limit: 20, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { project, tenantId } = ctx;
    const projectId = ctx.params.id;

    const [agents, tools, profileDocs, connectorConfigs, mcpServers, runtimeConfig, llmConfig] =
      await Promise.all([
        ProjectAgent.find({ projectId, tenantId }).lean(),
        ProjectTool.find({ projectId, tenantId }).lean(),
        ProjectConfigVariable.find({ projectId, tenantId, key: /^profile:/ })
          .select('key value')
          .lean(),
        ConnectorConfig.find({ projectId, tenantId }).lean(),
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
      return NextResponse.json(buildInvalidProjectExportPayload(readinessIssues), {
        status: 409,
      });
    }

    const profileEntries = (profileDocs as Array<{ key: string; value?: string }>)
      .map((doc) => {
        const name = behaviorProfileConfigKeyToName(doc.key);
        return name ? { name, dslContent: doc.value ?? '' } : null;
      })
      .filter((profile): profile is { name: string; dslContent: string } => profile !== null);
    const profiles = profileEntries.map((profile) => profile.name);

    const agentEntries = agents
      .filter((a: IProjectAgent) => a.dslContent)
      .map((a: IProjectAgent) => ({ name: a.name, dslContent: a.dslContent! }));

    const toolEntries = tools.map((t: IProjectTool) => ({
      name: t.name,
      path: `tools/${t.slug}.tools.abl`,
      content: t.dslContent,
    }));

    const graph = buildDependencyGraph(agentEntries, toolEntries, profiles);
    const validation = validateDependencies(graph);
    const layers = await buildLayerPreview({ projectId, tenantId });
    const provisioning = buildExportProvisioningRequirements({
      agents: agentEntries,
      tools: toolEntries,
      profiles: profileEntries,
      connectorConfigs,
      mcpServers,
    });

    return NextResponse.json({
      project: { name: project!.name, slug: project!.slug },
      agents: agents.map((a: IProjectAgent) => ({
        name: a.name,
        hasDslContent: !!a.dslContent,
      })),
      tools: tools.map((t: IProjectTool) => ({
        name: t.name,
        toolType: t.toolType,
      })),
      profiles,
      dependencies: {
        edges: graph.edges,
        validation,
      },
      provisioning,
      // v2 additions
      layers,
      defaultLayers: resolveLayers(),
    });
  },
);
