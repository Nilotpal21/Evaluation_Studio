/**
 * GET /api/projects/:pid/auth-profiles/:profileId/consumers
 *
 * Returns platform entities referencing this auth profile (integrations,
 * channels, MCP servers, models, services, tools, etc.) with meaningful names.
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureReadableAuthProfile } from '@/app/api/auth-profiles/_auth-profile-route-utils';

interface Consumer {
  type: string;
  id: string;
  name: string;
  label: string;
}

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const {
      AuthProfile,
      ChannelConnection,
      MCPServerConfig,
      ServiceNode,
      GitIntegration,
      TriggerRegistration,
      ProjectTool,
      Workflow,
    } = await import('@agent-platform/database/models');
    const { id: projectId, profileId } = params;

    // Verify profile exists and is accessible
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      $or: [{ projectId }, { projectId: null, scope: 'tenant' }],
    }).lean();

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const readError = ensureReadableAuthProfile(profile as IAuthProfile, user);
    if (readError) {
      return readError;
    }

    // Query all entity types that reference this auth profile.
    // ConnectorConnection is intentionally excluded (ABLP-913): workflow nodes
    // resolve auth-profile ids directly, and ConnectorConnection rows only
    // exist as legacy auto-bridges that don't represent a real consumer.
    const [channels, mcpServers, serviceNodes, gitIntegrations, triggers, tools, workflows] =
      await Promise.all([
        ChannelConnection.find({ authProfileId: profileId, tenantId, projectId })
          .select('_id displayName channelType')
          .lean(),
        MCPServerConfig.find({ authProfileId: profileId, tenantId, projectId })
          .select('_id name')
          .lean(),
        ServiceNode.find({ authProfileId: profileId, tenantId, projectId })
          .select('_id displayName name')
          .lean(),
        GitIntegration.find({ authProfileId: profileId, tenantId, projectId })
          .select('_id provider repositoryUrl')
          .lean(),
        TriggerRegistration.find({ authProfileId: profileId, tenantId, projectId })
          .select('_id triggerName connectorName')
          .lean(),
        // Tools that reference this auth profile. Match the *count* logic in
        // `apps/studio/src/app/api/projects/[id]/auth-profiles/route.ts`, which
        // uses the denormalized `authProfileId` field that the tool save
        // handler maintains (see
        // `packages/shared/src/repos/project-tool-repo.ts`).
        //
        // Previously this query did `dslContent: { $regex: profileId }`. That
        // never matched because the DSL stores `auth_profile: <name>`, not the
        // profile id — so the consumer count could report N > 0 while the
        // expanded list rendered empty. `$or` keeps a fallback for legacy
        // tools that may still carry the id in their DSL but never got the
        // denormalized field set.
        ProjectTool.find({
          tenantId,
          projectId,
          $or: [{ authProfileId: profileId }, { dslContent: { $regex: profileId } }],
        })
          .select('_id name toolType')
          .lean(),
        // Workflows whose canvas nodes or triggers reference this profile.
        // Node/trigger config holds the auth-profile id as `connectionId`
        // (legacy IR field; see ABLP-913).
        Workflow.find({
          tenantId,
          projectId,
          $or: [
            { 'nodes.config.connectionId': profileId },
            { 'nodes.config.authProfileId': profileId },
            { 'triggers.config.connectionId': profileId },
            { 'triggers.config.authProfileId': profileId },
          ],
        })
          .select('_id name')
          .lean(),
      ]);

    const consumers: Consumer[] = [
      ...(channels as { _id: string; displayName?: string; channelType?: string }[]).map((c) => ({
        type: 'channel',
        id: String(c._id),
        name: c.displayName || c.channelType || String(c._id),
        label: 'Channel',
      })),
      ...(mcpServers as { _id: string; name?: string }[]).map((m) => ({
        type: 'mcp_server',
        id: String(m._id),
        name: m.name || String(m._id),
        label: 'MCP Server',
      })),
      ...(serviceNodes as { _id: string; displayName?: string; name?: string }[]).map((s) => ({
        type: 'service',
        id: String(s._id),
        name: s.displayName || s.name || String(s._id),
        label: 'Service',
      })),
      ...(gitIntegrations as { _id: string; provider?: string; repositoryUrl?: string }[]).map(
        (g) => ({
          type: 'git_integration',
          id: String(g._id),
          name: g.repositoryUrl
            ? `${g.provider || 'git'}: ${g.repositoryUrl}`
            : g.provider || String(g._id),
          label: 'Git Integration',
        }),
      ),
      ...(triggers as { _id: string; triggerName?: string; connectorName?: string }[]).map((t) => ({
        type: 'trigger',
        id: String(t._id),
        name: t.triggerName || t.connectorName || String(t._id),
        label: 'Trigger',
      })),
      ...(tools as { _id: string; name?: string; toolType?: string }[]).map((t) => ({
        type: 'tool',
        id: String(t._id),
        name: t.name || String(t._id),
        label: 'Tool',
      })),
      ...(workflows as { _id: string; name?: string }[]).map((w) => ({
        type: 'workflow',
        id: String(w._id),
        name: w.name || String(w._id),
        label: 'Workflow',
      })),
    ];

    // A2A servers — gated by feature flag
    const a2aEnabled = process.env.AUTH_PROFILE_A2A_CONSUMERS_ENABLED === 'true';
    const a2aServers: Consumer[] = [];
    const a2aWarning = a2aEnabled ? undefined : 'a2a_model_not_yet_available';

    return NextResponse.json({
      success: true,
      data: consumers,
      tools: tools.length,
      a2aServers,
      ...(a2aWarning ? { a2aWarning } : {}),
    });
  },
);
