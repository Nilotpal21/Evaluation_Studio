/**
 * POST /api/sdk/share - Generate a secure share token for preview
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { findWidgetConfig } from '@/repos/sdk-repo';
import { buildSharePreviewUrl } from '@/lib/share-preview-link';
import { signShareToken } from '@/lib/sdk-share-token';
import { resolveFrontendUrl } from '@/lib/auth-helpers';
import { checkRateLimit } from '@/lib/rate-limit';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import { resolveStudioSdkSessionPermissions } from '@/lib/studio-sdk-session';
import { resolveSdkBootstrapChannel } from '@/lib/sdk-bootstrap-channel';
import { resolveStudioSdkWidgetConfigValues } from '@/lib/sdk-widget-config-values';

const log = createLogger('sdk-share');

const createShareRequestSchema = z
  .object({
    projectId: z.string().trim().min(1, 'projectId is required'),
    channelId: z.string().trim().min(1, 'channelId must not be empty').optional(),
    expiresIn: z.number().int().positive().finite().optional(),
  })
  .strict();

const createShareResponseSchema = z.object({
  token: z.string(),
  shareUrl: z.string(),
  expiresAt: z.string().datetime(),
  projectId: z.string(),
  projectName: z.string(),
});

// POST - Generate a new share token
async function postHandler(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const rateLimit = await checkRateLimit(`sdk-share-create:${user.id}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } },
    );
  }

  try {
    const parsed = await validateBody(request, createShareRequestSchema);
    if (!parsed.success) {
      return parsed.response;
    }
    const { projectId, channelId, expiresIn = 7 * 24 * 60 * 60 * 1000 } = parsed.data;

    // Cap expiry to 30 days max
    const maxExpiry = 30 * 24 * 60 * 60 * 1000;
    const safeExpiry = Math.min(expiresIn, maxExpiry);

    const projectAccess = await requireSdkProjectAccess(projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }
    const { project } = projectAccess;

    const widget = await findWidgetConfig(projectId, project.tenantId);
    const resolvedChannel = await resolveSdkBootstrapChannel({
      tenantId: user.tenantId,
      projectId,
      channelId: channelId ?? undefined,
      fallbackChannelId: widget?.channelId ?? undefined,
      surface: 'share',
    });
    if (!resolvedChannel.success) {
      return resolvedChannel.response;
    }
    const resolvedWidgetConfig = resolveStudioSdkWidgetConfigValues(resolvedChannel.channel.config);
    const permissions = resolveStudioSdkSessionPermissions({
      chatEnabled: resolvedWidgetConfig.chatEnabled,
      voiceEnabled: resolvedWidgetConfig.voiceEnabled,
    });

    if (permissions.length === 0) {
      return NextResponse.json(
        { error: 'Preview is not enabled for this project' },
        { status: 422 },
      );
    }

    // Generate signed token
    const exp = Date.now() + safeExpiry;
    const token = signShareToken({
      projectId,
      tenantId: user.tenantId,
      channelId: resolvedChannel.channel.id,
      permissions,
      exp,
    });

    const shareUrl = buildSharePreviewUrl(resolveFrontendUrl(request.nextUrl.origin), token);

    return NextResponse.json({
      token,
      shareUrl,
      expiresAt: new Date(exp).toISOString(),
      projectId,
      projectName: project.name,
    });
  } catch (error) {
    log.error('Share token generate error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Generate share token',
    description:
      'Generate a secure preview share URL. The token is carried in the URL fragment so it is not sent to the server in the initial request.',
    body: createShareRequestSchema,
    response: createShareResponseSchema,
    successStatus: 200,
    auth: true,
  },
  postHandler as any,
);
