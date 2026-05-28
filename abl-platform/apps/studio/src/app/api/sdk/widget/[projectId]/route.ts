/**
 * GET  /api/sdk/widget/:projectId - Get widget configuration
 * PUT  /api/sdk/widget/:projectId - Update widget configuration
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateBody, withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import { readSdkChannelShowActivityUpdates } from '@/lib/sdk-channel-display-config';
import { normalizeSdkWidgetTheme } from '@/lib/sdk-widget-theme';
import {
  findActiveSdkChannelById,
  findActiveSdkChannelsByProject,
  findWidgetConfig,
  upsertWidgetConfig,
} from '@/repos/sdk-repo';

const pathParamsSchema = z.object({
  projectId: z.string().min(1),
});

const querySchema = z.object({
  channelId: z.string().trim().min(1, 'channelId must not be empty').optional(),
});

const widgetConfigResponseSchema = z.object({
  channelId: z.string().nullable(),
  mode: z.enum(['chat', 'voice', 'unified']),
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']),
  welcomeMessage: z.string().nullable(),
  placeholderText: z.string().nullable(),
  voiceEnabled: z.boolean(),
  chatEnabled: z.boolean(),
  showActivityUpdates: z.boolean(),
  theme: z.record(z.string()),
});

const updateWidgetSchema = z.object({
  channelId: z.string().trim().min(1, 'channelId must not be empty').nullable().optional(),
  mode: z.enum(['chat', 'voice', 'unified']).optional(),
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
  welcomeMessage: z.string().max(500).nullable().optional(),
  placeholderText: z.string().max(200).nullable().optional(),
  voiceEnabled: z.boolean().optional(),
  chatEnabled: z.boolean().optional(),
  theme: z.record(z.string()).optional(),
});

type RouteParams = { params: Promise<{ projectId: string }> };

const log = createLogger('sdk-widget-config');

async function resolveWidgetShowActivityUpdates(options: {
  tenantId: string;
  projectId: string;
  requestedChannelId?: string;
  configuredChannelId?: string;
}): Promise<{ success: true; value: boolean } | { success: false; response: NextResponse }> {
  const { tenantId, projectId, requestedChannelId, configuredChannelId } = options;

  if (requestedChannelId) {
    const requestedChannel = await findActiveSdkChannelById(
      requestedChannelId,
      projectId,
      tenantId,
    );
    if (!requestedChannel) {
      return {
        success: false,
        response: NextResponse.json({ error: 'Channel not found' }, { status: 404 }),
      };
    }

    return {
      success: true,
      value: readSdkChannelShowActivityUpdates(requestedChannel.config),
    };
  }

  if (configuredChannelId) {
    const configuredChannel = await findActiveSdkChannelById(
      configuredChannelId,
      projectId,
      tenantId,
    );
    if (configuredChannel) {
      return {
        success: true,
        value: readSdkChannelShowActivityUpdates(configuredChannel.config),
      };
    }
  }

  const activeChannels = await findActiveSdkChannelsByProject(projectId, tenantId);
  if (activeChannels.length === 1) {
    return {
      success: true,
      value: readSdkChannelShowActivityUpdates(activeChannels[0].config),
    };
  }

  return { success: true, value: false };
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

    const widget = await findWidgetConfig(projectId, project.tenantId);
    const activityUpdates = await resolveWidgetShowActivityUpdates({
      tenantId: project.tenantId,
      projectId,
      requestedChannelId: parsedQuery.data.channelId,
      configuredChannelId: typeof widget?.channelId === 'string' ? widget.channelId : undefined,
    });
    if (!activityUpdates.success) {
      return activityUpdates.response;
    }

    return NextResponse.json({
      channelId: typeof widget?.channelId === 'string' ? widget.channelId : null,
      mode: widget?.mode || 'chat',
      position: widget?.position || 'bottom-right',
      welcomeMessage: widget?.welcomeMessage || null,
      placeholderText: widget?.placeholderText || null,
      voiceEnabled: widget?.voiceEnabled || false,
      chatEnabled: widget?.chatEnabled !== false,
      showActivityUpdates: activityUpdates.value,
      theme: normalizeSdkWidgetTheme(widget?.theme),
    });
  } catch (error) {
    log.error('Failed to load SDK widget config', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function putHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { projectId } = await params;
  const parsed = await validateBody(request, updateWidgetSchema);
  if (!parsed.success) {
    return parsed.response as NextResponse;
  }

  try {
    const projectAccess = await requireSdkProjectAccess(projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) return projectAccess;
    const { project } = projectAccess;

    const data = parsed.data;
    const updateData: Record<string, unknown> = {};

    if (data.channelId !== undefined) {
      if (data.channelId === null) {
        updateData.channelId = null;
      } else {
        const channel = await findActiveSdkChannelById(data.channelId, projectId, project.tenantId);
        if (!channel) {
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
        }
        updateData.channelId = channel.id;
      }
    }
    if (data.mode !== undefined) updateData.mode = data.mode;
    if (data.position !== undefined) updateData.position = data.position;
    if (data.welcomeMessage !== undefined) updateData.welcomeMessage = data.welcomeMessage;
    if (data.placeholderText !== undefined) updateData.placeholderText = data.placeholderText;
    if (data.voiceEnabled !== undefined) updateData.voiceEnabled = data.voiceEnabled;
    if (data.chatEnabled !== undefined) updateData.chatEnabled = data.chatEnabled;
    if (data.theme !== undefined) updateData.theme = normalizeSdkWidgetTheme(data.theme);

    // Use repo function
    const widget = await upsertWidgetConfig(projectId, project.tenantId, {
      update: updateData,
      create: {
        channelId: data.channelId ?? null,
        mode: data.mode || 'chat',
        position: data.position || 'bottom-right',
        welcomeMessage: data.welcomeMessage || null,
        placeholderText: data.placeholderText || null,
        voiceEnabled: data.voiceEnabled || false,
        chatEnabled: data.chatEnabled !== false,
        theme: data.theme === undefined ? {} : normalizeSdkWidgetTheme(data.theme),
      },
    });
    const activityUpdates = await resolveWidgetShowActivityUpdates({
      tenantId: project.tenantId,
      projectId,
      configuredChannelId: typeof widget.channelId === 'string' ? widget.channelId : undefined,
    });
    if (!activityUpdates.success) {
      return activityUpdates.response;
    }

    return NextResponse.json({
      channelId: typeof widget.channelId === 'string' ? widget.channelId : null,
      mode: widget.mode,
      position: widget.position,
      welcomeMessage: widget.welcomeMessage,
      placeholderText: widget.placeholderText,
      voiceEnabled: widget.voiceEnabled,
      chatEnabled: widget.chatEnabled,
      showActivityUpdates: activityUpdates.value,
      theme: normalizeSdkWidgetTheme(widget.theme),
    });
  } catch (error) {
    log.error('Failed to update SDK widget config', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withOpenAPI(
  {
    summary: 'Get widget configuration',
    description: 'Retrieve widget configuration for a project.',
    params: pathParamsSchema,
    query: querySchema,
    response: widgetConfigResponseSchema,
    successStatus: 200,
    auth: true,
  },
  getHandler as any,
);

export const PUT = withOpenAPI(
  {
    summary: 'Update widget configuration',
    description: 'Update widget configuration for a project.',
    params: pathParamsSchema,
    body: updateWidgetSchema,
    response: widgetConfigResponseSchema,
    successStatus: 200,
    auth: true,
  },
  putHandler as any,
);
