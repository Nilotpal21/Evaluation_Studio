import { NextRequest, NextResponse } from 'next/server';
import { getRequiredRuntimeUrl } from '@/config/runtime.server';
import { requireAuth, requireTenantAuth, isAuthError } from '@/lib/auth';
import { findSdkChannelByIdForTenant } from '@/repos/sdk-repo';
import {
  requireSdkProjectAccess,
  isSdkProjectAccessError,
  type SdkProjectAccessOperation,
} from '@/lib/sdk-project-access';

const RUNTIME_CONFIG_ERROR_CODE = 'RUNTIME_CONFIG_REQUIRED';

function createMissingProjectResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code: 'MISSING_PROJECT', message: 'projectId query parameter is required' },
    },
    { status: 400 },
  );
}

export interface SdkRuntimeChannelProxyContext {
  projectId: string;
  tenantId: string;
  runtimeUrl: string;
}

export interface SdkRuntimeTenantProxyContext {
  tenantId: string;
  projectId?: string;
  runtimeUrl: string;
}

function createConcealedSdkChannelNotFoundResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code: 'NOT_FOUND', message: 'SDK channel not found' },
    },
    { status: 404 },
  );
}

export async function resolveSdkRuntimeChannelProxyContext(
  request: NextRequest,
  operation: SdkProjectAccessOperation,
): Promise<SdkRuntimeChannelProxyContext | NextResponse> {
  const user = await requireAuth(request);
  if (isAuthError(user)) {
    return user;
  }

  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return createMissingProjectResponse();
  }

  const projectAccess = await requireSdkProjectAccess(projectId, user, operation);
  if (isSdkProjectAccessError(projectAccess)) {
    return projectAccess;
  }

  try {
    return {
      projectId,
      tenantId: projectAccess.project.tenantId,
      runtimeUrl: getRequiredRuntimeUrl(),
    };
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: RUNTIME_CONFIG_ERROR_CODE,
          message:
            error instanceof Error ? error.message : 'Runtime URL must be configured explicitly',
        },
      },
      { status: 500 },
    );
  }
}

export async function resolveSdkRuntimeTenantProxyContext(
  request: NextRequest,
): Promise<SdkRuntimeTenantProxyContext | NextResponse> {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) {
    return user;
  }

  try {
    return {
      tenantId: user.tenantId,
      runtimeUrl: getRequiredRuntimeUrl(),
    };
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: RUNTIME_CONFIG_ERROR_CODE,
          message:
            error instanceof Error ? error.message : 'Runtime URL must be configured explicitly',
        },
      },
      { status: 500 },
    );
  }
}

export async function resolveSdkRuntimeTenantChannelProxyContext(
  request: NextRequest,
  channelId: string,
  operation: SdkProjectAccessOperation,
): Promise<SdkRuntimeTenantProxyContext | NextResponse> {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) {
    return user;
  }

  const channel = await findSdkChannelByIdForTenant(channelId, user.tenantId);
  if (!channel || typeof channel.projectId !== 'string' || channel.projectId.trim().length === 0) {
    return createConcealedSdkChannelNotFoundResponse();
  }

  const projectAccess = await requireSdkProjectAccess(channel.projectId, user, operation);
  if (isSdkProjectAccessError(projectAccess)) {
    return createConcealedSdkChannelNotFoundResponse();
  }

  try {
    return {
      tenantId: user.tenantId,
      projectId: channel.projectId,
      runtimeUrl: getRequiredRuntimeUrl(),
    };
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: RUNTIME_CONFIG_ERROR_CODE,
          message:
            error instanceof Error ? error.message : 'Runtime URL must be configured explicitly',
        },
      },
      { status: 500 },
    );
  }
}

export function isSdkRuntimeChannelProxyError(
  result: SdkRuntimeChannelProxyContext | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
