/**
 * GET /api/sdk/embed/:projectId - Get embed code snippet for project widget
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { resolveSdkWidgetCapabilityState } from '@agent-platform/shared/sdk-widget-capabilities';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import { INVALID_RUNTIME_URL_ERROR, resolveSdkEmbedRuntimeUrl } from '@/config/runtime.server';
import { normalizeSdkWidgetTheme } from '@/lib/sdk-widget-theme';
import { normalizeStudioWidgetCapabilityConfig } from '@/lib/sdk-widget-capabilities';
import { findPublicApiKeyById, findWidgetConfig } from '@/repos/sdk-repo';
import { resolveSdkBootstrapChannel } from '@/lib/sdk-bootstrap-channel';

const pathParamsSchema = z.object({
  projectId: z.string().min(1),
});

const querySchema = z.object({
  channelId: z.string().trim().min(1, 'channelId must not be empty').optional(),
});

const embedResponseSchema = z.object({
  snippet: z.string(),
  config: z.object({
    projectId: z.string(),
    channelId: z.string().nullable(),
    channelName: z.string().nullable(),
    mode: z.enum(['chat', 'voice', 'unified']),
    position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
    theme: z.record(z.string()),
    welcomeMessage: z.string().optional(),
    placeholderText: z.string().optional(),
    voiceEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    showActivityUpdates: z.boolean(),
  }),
  keyPrefix: z.string(),
  keyName: z.string(),
  sdkUrl: z.string(),
  runtimeEndpoint: z.string(),
});

type RouteParams = { params: Promise<{ projectId: string }> };
const log = createLogger('sdk-embed');

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function firstHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const [first] = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return first ?? null;
}

function resolveRequestOrigin(request: NextRequest): string {
  const protocol =
    firstHeaderValue(request.headers.get('x-forwarded-proto')) ??
    request.nextUrl.protocol.replace(/:$/, '');
  const host =
    firstHeaderValue(request.headers.get('x-forwarded-host')) ??
    firstHeaderValue(request.headers.get('host'));

  return host ? `${protocol}://${host}` : request.nextUrl.origin;
}

function resolveSdkScriptUrl(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SDK_SCRIPT_URL?.trim();
  if (configured && configured.length > 0) {
    return configured.replace(/\/+$/, '');
  }

  return `${resolveRequestOrigin(request)}/api/sdk/embed/script`;
}

async function getHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { projectId } = await params;
  const parsedQuery = querySchema.safeParse({
    channelId: request.nextUrl.searchParams.get('channelId') ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json(
      {
        success: false,
        errors: parsedQuery.error.issues.map((issue) => ({
          code: 'VALIDATION_ERROR',
          msg: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  try {
    const projectAccess = await requireSdkProjectAccess(projectId, user, 'read');
    if (isSdkProjectAccessError(projectAccess)) return projectAccess;
    const { project } = projectAccess;

    // Use repo functions
    const widget = await findWidgetConfig(projectId, project.tenantId);
    const capabilityConfig = normalizeStudioWidgetCapabilityConfig({
      mode: widget?.mode,
      chatEnabled: widget?.chatEnabled,
      voiceEnabled: widget?.voiceEnabled,
    });
    const capabilityState = resolveSdkWidgetCapabilityState({
      configuredMode: capabilityConfig.configuredMode,
      chatEnabled: capabilityConfig.chatEnabled,
      voiceEnabled: capabilityConfig.voiceEnabled,
      voiceSupported: true,
    });

    if (!capabilityState.effectiveMode) {
      return NextResponse.json({ error: 'Embed is not enabled for this project' }, { status: 422 });
    }

    const resolvedChannel = await resolveSdkBootstrapChannel({
      tenantId: project.tenantId,
      projectId,
      channelId: parsedQuery.data.channelId ?? undefined,
      fallbackChannelId: widget?.channelId ?? undefined,
      surface: 'embed',
    });
    if (!resolvedChannel.success) {
      return resolvedChannel.response;
    }

    const channelKey = await findPublicApiKeyById(
      resolvedChannel.channel.publicApiKeyId,
      projectId,
      project.tenantId,
    );
    if (!channelKey || channelKey.isActive !== true) {
      return NextResponse.json(
        {
          error:
            'The selected SDK channel is not bound to an active public API key. Rebind the channel or reactivate its key.',
        },
        { status: 422 },
      );
    }

    let runtimeEndpoint: string;
    try {
      runtimeEndpoint = resolveSdkEmbedRuntimeUrl(resolveRequestOrigin(request));
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_RUNTIME_URL_ERROR) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }
    const sdkUrl = resolveSdkScriptUrl(request);

    const config = {
      projectId,
      channelId: resolvedChannel.channel.id,
      channelName: resolvedChannel.channel.name || null,
      mode: capabilityConfig.configuredMode,
      position: widget?.position || 'bottom-right',
      theme: normalizeSdkWidgetTheme(widget?.theme),
      welcomeMessage: widget?.welcomeMessage || undefined,
      placeholderText: widget?.placeholderText || undefined,
      voiceEnabled: capabilityConfig.voiceEnabled,
      chatEnabled: capabilityConfig.chatEnabled,
      showActivityUpdates: resolvedChannel.channel.showActivityUpdates,
    };

    const welcomeAttr = config.welcomeMessage
      ? `\n  welcome-message="${escapeHtmlAttribute(config.welcomeMessage)}"`
      : '';
    const placeholderAttr = config.placeholderText
      ? `\n  placeholder="${escapeHtmlAttribute(config.placeholderText)}"`
      : '';
    const channelAttr = config.channelId
      ? `\n  channel-id="${escapeHtmlAttribute(config.channelId)}"`
      : '';
    const snippet = `<!-- Agent SDK Widget -->
<!-- Replace YOUR_PUBLIC_API_KEY with a full key that starts with ${channelKey.keyPrefix} -->
<script src="${sdkUrl}" defer></script>
<agent-widget
  project-id="${projectId}"
  api-key="YOUR_PUBLIC_API_KEY"
  endpoint="${runtimeEndpoint}"${channelAttr}
  chat-enabled="${config.chatEnabled}"
  voice-enabled="${config.voiceEnabled}"
  mode="${config.mode}"
  position="${config.position}"${welcomeAttr}${placeholderAttr}
></agent-widget>`;

    return NextResponse.json({
      snippet,
      config,
      keyPrefix: channelKey.keyPrefix,
      keyName: channelKey.name,
      sdkUrl,
      runtimeEndpoint,
    });
  } catch (error) {
    log.error('Failed to render SDK embed snippet', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get embed code',
    description: 'Retrieve HTML embed code snippet for project widget.',
    params: pathParamsSchema,
    query: querySchema,
    response: embedResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);
