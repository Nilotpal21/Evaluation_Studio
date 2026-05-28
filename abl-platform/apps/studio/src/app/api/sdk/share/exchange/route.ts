/**
 * POST /api/sdk/share/exchange - Validate a share token and exchange it for a Runtime-issued SDK session token
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { readSdkChannelShowActivityUpdates } from '@/lib/sdk-channel-display-config';
import { findActiveSdkChannelById, findWidgetConfig } from '@/repos/sdk-repo';
import { findProjectByIdAndTenant } from '@/repos/project-repo';
import { getClientIp } from '@/lib/get-client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { signShareToken, verifyShareToken } from '@/lib/sdk-share-token';
import {
  normalizeStudioSdkSessionPermissions,
  resolveStudioSdkSessionPermissions,
  STUDIO_SDK_SESSION_PERMISSION_VALUES,
} from '@/lib/studio-sdk-session';
import { exchangeSdkBootstrapArtifactWithRuntime } from '@/lib/runtime-sdk-session';
import { resolveStudioSdkWidgetConfigValues } from '@/lib/sdk-widget-config-values';

const log = createLogger('sdk-share-exchange');
const sdkPermissionSchema = z.enum(STUDIO_SDK_SESSION_PERMISSION_VALUES);
const SHARE_EXCHANGE_RATE_LIMIT_MAX = 30;
const SHARE_EXCHANGE_RATE_LIMIT_WINDOW_MS = 60_000;

const exchangeShareRequestSchema = z.object({
  token: z.string().trim().min(1, 'token is required'),
  requiredPermission: sdkPermissionSchema.optional(),
  userContext: z
    .object({
      customAttributes: z.record(z.unknown()).optional(),
    })
    .optional(),
});

const exchangeShareResponseSchema = z.object({
  valid: z.boolean(),
  projectId: z.string(),
  projectName: z.string(),
  expiresAt: z.string().datetime(),
  sdkToken: z.string(),
  permissions: z.array(sdkPermissionSchema),
  config: z.object({
    mode: z.enum(['chat', 'voice', 'unified']),
    position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
    theme: z.record(z.string()),
    welcomeMessage: z.string().nullable(),
    placeholderText: z.string(),
    voiceEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    showActivityUpdates: z.boolean(),
  }),
});

async function postHandler(request: NextRequest) {
  const parsed = await validateBody(request, exchangeShareRequestSchema);
  if (!parsed.success) {
    return parsed.response;
  }
  const { token, requiredPermission, userContext } = parsed.data;

  const rateLimit = await checkRateLimit(
    `sdk-share-exchange:${getClientIp(request)}`,
    SHARE_EXCHANGE_RATE_LIMIT_MAX,
    SHARE_EXCHANGE_RATE_LIMIT_WINDOW_MS,
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } },
    );
  }

  const payload = verifyShareToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  try {
    const project = await findProjectByIdAndTenant(payload.projectId, payload.tenantId);
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const widget = await findWidgetConfig(payload.projectId, payload.tenantId);
    const resolvedChannel = payload.channelId
      ? await findActiveSdkChannelById(payload.channelId, payload.projectId, payload.tenantId)
      : null;
    if (payload.channelId && !resolvedChannel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    const resolvedWidgetConfig = resolveStudioSdkWidgetConfigValues(
      resolvedChannel?.config ?? widget,
      {
        themeFallback: { primaryColor: '#2563eb' },
      },
    );
    const currentPermissions = resolveStudioSdkSessionPermissions({
      chatEnabled: resolvedWidgetConfig.chatEnabled,
      voiceEnabled: resolvedWidgetConfig.voiceEnabled,
    });
    const sharePermissions = payload.permissions
      ? normalizeStudioSdkSessionPermissions(payload.permissions)
      : normalizeStudioSdkSessionPermissions(['session:send_message']);
    const effectivePermissions = normalizeStudioSdkSessionPermissions(
      sharePermissions.filter((permission) => currentPermissions.includes(permission)),
    );
    const issuedPermissions = requiredPermission
      ? normalizeStudioSdkSessionPermissions(
          effectivePermissions.includes(requiredPermission) ? [requiredPermission] : [],
        )
      : effectivePermissions;

    if (issuedPermissions.length === 0) {
      return NextResponse.json(
        {
          error: requiredPermission
            ? 'Share link does not grant the required permission'
            : 'Share link is no longer allowed for this preview',
        },
        { status: 403 },
      );
    }

    const runtimeBootstrapToken = signShareToken({
      tenantId: payload.tenantId,
      projectId: project.id,
      channelId: payload.channelId,
      permissions: issuedPermissions,
      exp: payload.exp,
    });

    const runtimeExchange = await exchangeSdkBootstrapArtifactWithRuntime(
      runtimeBootstrapToken,
      {
        tenantId: payload.tenantId,
        projectId: project.id,
        channelId: payload.channelId,
        permissions: issuedPermissions,
      },
      userContext,
    );
    if (!runtimeExchange.success) {
      log.warn('Runtime share bootstrap exchange failed', {
        projectId: project.id,
        status: runtimeExchange.status,
      });
      return NextResponse.json(runtimeExchange.body, { status: runtimeExchange.status });
    }

    return NextResponse.json({
      valid: true,
      projectId: project.id,
      projectName: project.name,
      expiresAt: new Date(payload.exp).toISOString(),
      sdkToken: runtimeExchange.data.token,
      permissions: runtimeExchange.data.permissions,
      config: {
        mode: resolvedWidgetConfig.mode,
        position: resolvedWidgetConfig.position,
        theme: resolvedWidgetConfig.theme,
        welcomeMessage: resolvedWidgetConfig.welcomeMessage,
        placeholderText: resolvedWidgetConfig.placeholderText,
        voiceEnabled: resolvedWidgetConfig.voiceEnabled,
        chatEnabled: resolvedWidgetConfig.chatEnabled,
        showActivityUpdates: readSdkChannelShowActivityUpdates(resolvedChannel?.config),
      },
    });
  } catch (error) {
    log.error('Share token exchange error', {
      err: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withOpenAPI(
  {
    summary: 'Exchange share token',
    description:
      'Validate a share token and exchange it for a Runtime-issued scoped SDK session token without sending the share token in a URL query string.',
    body: exchangeShareRequestSchema,
    response: exchangeShareResponseSchema,
    successStatus: 200,
    auth: false,
  },
  postHandler as any,
);
