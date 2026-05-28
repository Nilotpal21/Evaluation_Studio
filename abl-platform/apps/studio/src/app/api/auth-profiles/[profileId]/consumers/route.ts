/**
 * GET /api/auth-profiles/:profileId/consumers
 *
 * Returns platform entities referencing this tenant-scoped auth profile
 * (model providers, guardrails, voice services, connector configs, etc.).
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import type { IAuthProfile } from '@agent-platform/database/models';
import { ensureReadableAuthProfile } from '../../_auth-profile-route-utils';
import { parseDslProperties } from '@agent-platform/shared';

interface Consumer {
  type: string;
  id: string;
  name: string;
  label: string;
}

function parseAuthProfileRef(dslContent: unknown): string | null {
  if (typeof dslContent !== 'string' || dslContent.trim().length === 0) {
    return null;
  }
  const authProfileRef = parseDslProperties(dslContent).auth_profile;
  if (typeof authProfileRef !== 'string') {
    return null;
  }
  const trimmed = authProfileRef.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const GET = withRouteHandler(
  { permissions: StudioPermission.AUTH_PROFILE_READ },
  async ({ params, tenantId, user }) => {
    await ensureDb();
    const {
      AuthProfile,
      TenantModel,
      TenantGuardrailProviderConfig,
      TenantServiceInstance,
      ConnectorConfig,
      ArchWorkspaceConfig,
      ProjectTool,
      Workflow,
    } = await import('@agent-platform/database/models');
    const { profileId } = params;

    // Verify the profile exists and is tenant-scoped
    const profile = await AuthProfile.findOne({
      _id: profileId,
      tenantId,
      projectId: null,
      scope: 'tenant',
    }).lean();

    if (!profile) {
      return errorJson('Auth profile not found', 404, ErrorCode.NOT_FOUND);
    }

    const readError = ensureReadableAuthProfile(profile as IAuthProfile, user);
    if (readError) {
      return readError;
    }
    const profileName =
      typeof (profile as { name?: unknown }).name === 'string' ? profile.name : '';

    // Query all tenant-scoped entity types that reference this auth profile
    const [
      tenantModels,
      guardrailProviders,
      serviceInstances,
      connectorConfigs,
      archConfigs,
      tools,
      workflows,
    ] = await Promise.all([
      // TenantModel has authProfileId on embedded connections[] sub-documents
      TenantModel.find({
        tenantId,
        'connections.authProfileId': profileId,
      })
        .select('_id displayName provider')
        .lean(),
      TenantGuardrailProviderConfig.find({ authProfileId: profileId, tenantId })
        .select('_id displayName name')
        .lean(),
      TenantServiceInstance.find({ authProfileId: profileId, tenantId })
        .select('_id displayName serviceType')
        .lean(),
      ConnectorConfig.find({ authProfileId: profileId, tenantId })
        .select('_id connectorType')
        .lean(),
      ArchWorkspaceConfig.find({ authProfileId: profileId, tenantId })
        .select('_id provider modelId')
        .lean(),
      ProjectTool.find({
        tenantId,
        dslContent: { $regex: 'auth_profile\\s*:' },
      })
        .select('_id projectId name dslContent')
        .lean(),
      // Workflows in any project under this tenant whose nodes or triggers
      // reference this workspace-scoped profile (legacy IR field is
      // `connectionId`; see ABLP-913).
      Workflow.find({
        tenantId,
        $or: [
          { 'nodes.config.connectionId': profileId },
          { 'nodes.config.authProfileId': profileId },
          { 'triggers.config.connectionId': profileId },
          { 'triggers.config.authProfileId': profileId },
        ],
      })
        .select('_id projectId name')
        .lean(),
    ]);

    const toolConsumers =
      profileName.length > 0
        ? (tools as { _id: string; name?: string; dslContent?: string }[])
            .filter((tool) => parseAuthProfileRef(tool.dslContent) === profileName)
            .map((tool) => ({
              type: 'tool',
              id: String(tool._id),
              name: tool.name || String(tool._id),
              label: 'HTTP Tool',
            }))
        : [];

    const consumers: Consumer[] = [
      ...(tenantModels as { _id: string; displayName?: string; provider?: string }[]).map((m) => ({
        type: 'model',
        id: String(m._id),
        name: m.displayName || m.provider || String(m._id),
        label: 'Model Provider',
      })),
      ...(guardrailProviders as { _id: string; displayName?: string; name?: string }[]).map(
        (g) => ({
          type: 'guardrail',
          id: String(g._id),
          name: g.displayName || g.name || String(g._id),
          label: 'Guardrail',
        }),
      ),
      ...(serviceInstances as { _id: string; displayName?: string; serviceType?: string }[]).map(
        (s) => ({
          type: 'voice_service',
          id: String(s._id),
          name: s.displayName || s.serviceType || String(s._id),
          label: 'Voice Service',
        }),
      ),
      ...(connectorConfigs as { _id: string; connectorType?: string }[]).map((c) => ({
        type: 'connector_config',
        id: String(c._id),
        name: c.connectorType || String(c._id),
        label: 'Connector Config',
      })),
      ...(archConfigs as { _id: string; provider?: string; modelId?: string }[]).map((a) => ({
        type: 'arch_config',
        id: String(a._id),
        name: `${a.provider || 'AI'} Workspace (${a.modelId || 'default'})`,
        label: 'AI Workspace',
      })),
      ...toolConsumers,
      ...(workflows as { _id: string; projectId?: string; name?: string }[]).map((w) => ({
        type: 'workflow',
        id: String(w._id),
        name: w.name || String(w._id),
        label: 'Workflow',
        ...(w.projectId ? { projectId: String(w.projectId) } : {}),
      })),
    ];

    return NextResponse.json({ success: true, data: consumers });
  },
);
