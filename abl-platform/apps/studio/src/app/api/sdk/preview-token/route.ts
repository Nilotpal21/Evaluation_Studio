/**
 * POST /api/sdk/preview-token
 *
 * Exchanges an authenticated preview bootstrap artifact for a Runtime-issued SDK session token.
 * Requires authenticated project-scoped SDK control access.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { signSdkBootstrapArtifact } from '@agent-platform/shared';
import { requireAuth, isAuthError } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { findWidgetConfig } from '@/repos/sdk-repo';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import {
  getStudioSdkBootstrapSecret,
  resolveStudioSdkSessionPermissions,
  STUDIO_SDK_BOOTSTRAP_TTL_SECONDS,
} from '@/lib/studio-sdk-session';
import { exchangeSdkBootstrapArtifactWithRuntime } from '@/lib/runtime-sdk-session';
import { resolveSdkBootstrapChannel } from '@/lib/sdk-bootstrap-channel';

const log = createLogger('sdk-preview-token');

const previewTokenRequestSchema = z
  .object({
    projectId: z.string().trim().min(1, 'projectId is required'),
    channelId: z.string().trim().min(1, 'channelId must not be empty').optional(),
  })
  .strict();

const previewTokenResponseSchema = z.object({
  sdkToken: z.string(),
});

async function postHandler(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (isAuthError(authResult)) return authResult;

  const rl = await checkRateLimit(`preview-token:${authResult.id}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const parsed = await validateBody(request, previewTokenRequestSchema);
    if (!parsed.success) {
      return parsed.response as NextResponse;
    }
    const { projectId, channelId } = parsed.data;
    const projectAccess = await requireSdkProjectAccess(projectId, authResult, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return projectAccess;
    }
    const { project } = projectAccess;

    if (typeof project.tenantId !== 'string' || project.tenantId.length === 0) {
      log.error('Preview token project missing tenant scope', {
        projectId: project.id,
        userId: authResult.id,
      });
      return NextResponse.json({ error: 'Project is not available for preview' }, { status: 500 });
    }

    const widget = await findWidgetConfig(project.id, project.tenantId);
    const permissions = resolveStudioSdkSessionPermissions({
      chatEnabled: widget?.chatEnabled,
      voiceEnabled: widget?.voiceEnabled,
    });

    if (permissions.length === 0) {
      return NextResponse.json(
        { error: 'Preview is not enabled for this project' },
        { status: 422 },
      );
    }

    const resolvedChannel = await resolveSdkBootstrapChannel({
      tenantId: project.tenantId,
      projectId: project.id,
      channelId: channelId ?? undefined,
      fallbackChannelId: widget?.channelId ?? undefined,
      surface: 'preview',
    });
    if (!resolvedChannel.success) {
      return resolvedChannel.response;
    }

    const secret = getStudioSdkBootstrapSecret();
    if (!secret) {
      log.error('Bootstrap secret not configured for preview bootstrap issuance');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const bootstrapToken = signSdkBootstrapArtifact(
      {
        type: 'preview',
        tenantId: project.tenantId,
        projectId: project.id,
        channelId: resolvedChannel.channel.id,
        permissions,
        exp: Date.now() + STUDIO_SDK_BOOTSTRAP_TTL_SECONDS * 1000,
      },
      secret,
    );

    const runtimeExchange = await exchangeSdkBootstrapArtifactWithRuntime(bootstrapToken, {
      tenantId: project.tenantId,
      projectId: project.id,
      channelId: resolvedChannel.channel.id,
      permissions,
    });
    if (!runtimeExchange.success) {
      log.warn('Runtime preview bootstrap exchange failed', {
        projectId: project.id,
        channelId: resolvedChannel.channel.id,
        status: runtimeExchange.status,
      });
      return NextResponse.json(runtimeExchange.body, { status: runtimeExchange.status });
    }

    return NextResponse.json({ sdkToken: runtimeExchange.data.token });
  } catch (error) {
    log.error('Preview token issuance failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Issue preview token',
    description:
      'Exchange an authenticated Studio preview bootstrap artifact for a Runtime-issued SDK session token.',
    body: previewTokenRequestSchema,
    response: previewTokenResponseSchema,
    successStatus: 200,
    auth: true,
  },
  postHandler as any,
);
