/**
 * GET /api/runtime/sdk-channels/:channelId — Proxy to runtime SDK channel detail
 * PATCH /api/runtime/sdk-channels/:channelId — Proxy to runtime SDK channel update
 * DELETE /api/runtime/sdk-channels/:channelId — Proxy to runtime SDK channel delete
 *
 * Forwards to the tenant-scoped runtime admin path:
 * /api/tenants/:tenantId/sdk-channels/:channelId
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { safeJsonParse } from '@/lib/safe-proxy';
import { buildRuntimeProxyHeaders } from '@/lib/runtime-proxy';
import { resolveSdkRuntimeTenantChannelProxyContext } from '@/lib/sdk-runtime-channel-proxy';
import { normalizeSdkWidgetTheme } from '@/lib/sdk-widget-theme';
import { upsertWidgetConfig } from '@/repos/sdk-repo';

const log = createLogger('studio-sdk-channel-detail-proxy');

function buildRuntimeUrl(runtimeUrl: string, tenantId: string, channelId: string): string {
  return `${runtimeUrl}/api/tenants/${encodeURIComponent(tenantId)}/sdk-channels/${encodeURIComponent(channelId)}`;
}

function buildConcealedNotFoundResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code: 'NOT_FOUND', message: 'SDK channel not found' },
    },
    { status: 404 },
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readWidgetMode(value: unknown): 'chat' | 'voice' | 'unified' | undefined {
  return value === 'chat' || value === 'voice' || value === 'unified' ? value : undefined;
}

function readWidgetPosition(
  value: unknown,
): 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | undefined {
  return value === 'bottom-right' ||
    value === 'bottom-left' ||
    value === 'top-right' ||
    value === 'top-left'
    ? value
    : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

async function syncWidgetConfigFromSdkChannelUpdate(options: {
  channelId: string;
  projectId: string;
  tenantId: string;
  config: Record<string, unknown>;
}): Promise<void> {
  const { channelId, projectId, tenantId, config } = options;
  const update: Record<string, unknown> = { channelId };

  const mode = readWidgetMode(config.mode);
  if (mode !== undefined) update.mode = mode;

  const position = readWidgetPosition(config.position);
  if (position !== undefined) update.position = position;

  const welcomeMessage = readNullableString(config.welcomeMessage);
  if (welcomeMessage !== undefined) update.welcomeMessage = welcomeMessage;

  const placeholderText = readNullableString(config.placeholderText);
  if (placeholderText !== undefined) update.placeholderText = placeholderText;

  if (typeof config.voiceEnabled === 'boolean') update.voiceEnabled = config.voiceEnabled;
  if (typeof config.chatEnabled === 'boolean') update.chatEnabled = config.chatEnabled;
  if (readRecord(config.theme)) update.theme = normalizeSdkWidgetTheme(config.theme);

  await upsertWidgetConfig(projectId, tenantId, {
    update,
    create: {
      channelId,
      mode: mode ?? 'chat',
      position: position ?? 'bottom-right',
      welcomeMessage: welcomeMessage ?? null,
      placeholderText: placeholderText ?? null,
      voiceEnabled: typeof config.voiceEnabled === 'boolean' ? config.voiceEnabled : false,
      chatEnabled: typeof config.chatEnabled === 'boolean' ? config.chatEnabled : true,
      theme: readRecord(config.theme) ? normalizeSdkWidgetTheme(config.theme) : {},
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const { channelId } = await params;
  const proxyContext = await resolveSdkRuntimeTenantChannelProxyContext(request, channelId, 'read');
  if (proxyContext instanceof NextResponse) return proxyContext;

  try {
    const response = await fetch(
      buildRuntimeUrl(proxyContext.runtimeUrl, proxyContext.tenantId, channelId),
      {
        headers: buildRuntimeProxyHeaders(request, proxyContext.tenantId),
      },
    );

    const { data } = await safeJsonParse(response);
    if (response.status === 404) {
      return buildConcealedNotFoundResponse();
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK channel detail', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: proxyContext.tenantId,
      channelId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to fetch SDK channel from runtime' },
      },
      { status: 502 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const { channelId } = await params;
  const proxyContext = await resolveSdkRuntimeTenantChannelProxyContext(
    request,
    channelId,
    'write',
  );
  if (proxyContext instanceof NextResponse) return proxyContext;

  try {
    const body = await request.json();
    const headers = buildRuntimeProxyHeaders(request, proxyContext.tenantId);

    const response = await fetch(
      buildRuntimeUrl(proxyContext.runtimeUrl, proxyContext.tenantId, channelId),
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      },
    );

    const { data } = await safeJsonParse(response);
    if (response.status === 404) {
      return buildConcealedNotFoundResponse();
    }
    const config = readRecord(body.config);
    if (response.ok && config) {
      if (!proxyContext.projectId) {
        throw new Error('Missing project context for SDK channel widget sync');
      }
      await syncWidgetConfigFromSdkChannelUpdate({
        channelId,
        projectId: proxyContext.projectId,
        tenantId: proxyContext.tenantId,
        config,
      });
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK channel update', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: proxyContext.tenantId,
      channelId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to update SDK channel via runtime' },
      },
      { status: 502 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> },
) {
  const { channelId } = await params;
  const proxyContext = await resolveSdkRuntimeTenantChannelProxyContext(
    request,
    channelId,
    'write',
  );
  if (proxyContext instanceof NextResponse) return proxyContext;

  try {
    const response = await fetch(
      buildRuntimeUrl(proxyContext.runtimeUrl, proxyContext.tenantId, channelId),
      {
        method: 'DELETE',
        headers: buildRuntimeProxyHeaders(request, proxyContext.tenantId),
      },
    );

    const { data } = await safeJsonParse(response);
    if (response.status === 404) {
      return buildConcealedNotFoundResponse();
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    log.error('Failed to proxy SDK channel delete', {
      error: error instanceof Error ? error.message : String(error),
      tenantId: proxyContext.tenantId,
      channelId,
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to delete SDK channel via runtime' },
      },
      { status: 502 },
    );
  }
}
