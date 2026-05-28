import { getRequiredRuntimeUrl } from '@/config/runtime.server';

export interface RuntimeSdkInitResponse {
  token: string;
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  channelId: string;
  permissions: string[];
  showActivityUpdates: boolean;
  expiresIn: number;
}

export interface RuntimeSdkExpectedScope {
  tenantId: string;
  projectId: string;
  channelId: string;
  permissions?: readonly string[];
}

export type RuntimeSdkInitResult =
  | { success: true; data: RuntimeSdkInitResponse }
  | { success: false; status: number; body: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRuntimeSdkInitResponse(value: unknown): value is RuntimeSdkInitResponse {
  return (
    isObject(value) &&
    typeof value.token === 'string' &&
    typeof value.tenantId === 'string' &&
    typeof value.projectId === 'string' &&
    (value.deploymentId === undefined || typeof value.deploymentId === 'string') &&
    typeof value.channelId === 'string' &&
    Array.isArray(value.permissions) &&
    value.permissions.every((permission) => typeof permission === 'string') &&
    typeof value.showActivityUpdates === 'boolean' &&
    typeof value.expiresIn === 'number'
  );
}

function normalizePermissionSet(permissions: readonly string[] | undefined): string[] {
  if (!permissions) {
    return [];
  }

  return Array.from(
    new Set(
      permissions.filter((permission): permission is string => typeof permission === 'string'),
    ),
  ).sort();
}

function normalizeExpectedRuntimePermissionSet(
  permissions: readonly string[] | undefined,
): string[] {
  const normalized = normalizePermissionSet(permissions);
  const hasInteractivePermission =
    normalized.includes('session:send_message') || normalized.includes('session:voice');

  if (!hasInteractivePermission) {
    return normalized;
  }

  return normalizePermissionSet([...normalized, 'session:read']);
}

function validateRuntimeSdkScope(
  response: RuntimeSdkInitResponse,
  expectedScope: RuntimeSdkExpectedScope | undefined,
): RuntimeSdkInitResult | null {
  if (!expectedScope) {
    return null;
  }

  if (
    response.tenantId !== expectedScope.tenantId ||
    response.projectId !== expectedScope.projectId ||
    response.channelId !== expectedScope.channelId
  ) {
    return {
      success: false,
      status: 502,
      body: {
        error: 'Runtime SDK session scope mismatch',
      },
    };
  }

  const expectedPermissions = normalizeExpectedRuntimePermissionSet(expectedScope.permissions);
  if (expectedPermissions.length === 0) {
    return null;
  }

  const actualPermissions = normalizePermissionSet(response.permissions);
  if (
    expectedPermissions.length !== actualPermissions.length ||
    expectedPermissions.some((permission, index) => permission !== actualPermissions[index])
  ) {
    return {
      success: false,
      status: 502,
      body: {
        error: 'Runtime SDK session permissions mismatch',
      },
    };
  }

  return null;
}

export async function exchangeSdkBootstrapArtifactWithRuntime(
  bootstrapToken: string,
  expectedScope?: RuntimeSdkExpectedScope,
  userContext?: { customAttributes?: Record<string, unknown> },
): Promise<RuntimeSdkInitResult> {
  const response = await fetch(`${getRequiredRuntimeUrl()}/api/v1/sdk/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bootstrapToken,
      ...(userContext && { userContext }),
    }),
  });

  const parsed = (await response.json().catch(() => null)) as unknown;
  const body = isObject(parsed) ? parsed : { error: 'Invalid runtime response' };

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      body,
    };
  }

  if (!isRuntimeSdkInitResponse(body)) {
    return {
      success: false,
      status: 502,
      body: { error: 'Invalid runtime response' },
    };
  }

  const scopeValidation = validateRuntimeSdkScope(body, expectedScope);
  if (scopeValidation) {
    return scopeValidation;
  }

  return {
    success: true,
    data: body,
  };
}
