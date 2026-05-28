import { getConfig, isConfigLoaded } from '@/config';

export const STUDIO_SDK_BOOTSTRAP_TTL_SECONDS = 4 * 60 * 60;
export const MISSING_STUDIO_SDK_BOOTSTRAP_SECRET_ERROR =
  'AUTH_SDK_BOOTSTRAP_SIGNING_SECRET must be configured for Studio preview/share bootstrap.';
export const STUDIO_SDK_SESSION_PERMISSION_VALUES = [
  'session:send_message',
  'session:voice',
  'session:read',
] as const;

export type StudioSdkSessionPermission = (typeof STUDIO_SDK_SESSION_PERMISSION_VALUES)[number];

export interface StudioWidgetPermissionSource {
  chatEnabled?: boolean | null;
  voiceEnabled?: boolean | null;
}

export function isStudioSdkSessionPermission(value: unknown): value is StudioSdkSessionPermission {
  return (
    typeof value === 'string' &&
    STUDIO_SDK_SESSION_PERMISSION_VALUES.includes(value as StudioSdkSessionPermission)
  );
}

export function normalizeStudioSdkSessionPermissions(
  permissions: Iterable<unknown>,
): StudioSdkSessionPermission[] {
  const normalized = new Set<StudioSdkSessionPermission>();
  let hasInteractivePermission = false;

  for (const permission of permissions) {
    if (isStudioSdkSessionPermission(permission)) {
      normalized.add(permission);
      if (permission === 'session:send_message' || permission === 'session:voice') {
        hasInteractivePermission = true;
      }
    }
  }

  if (hasInteractivePermission) {
    normalized.add('session:read');
  }

  return Array.from(normalized);
}

export function resolveStudioSdkSessionPermissions(
  widget: StudioWidgetPermissionSource | null | undefined,
): StudioSdkSessionPermission[] {
  return normalizeStudioSdkSessionPermissions([
    widget?.chatEnabled !== false ? 'session:send_message' : null,
    widget?.voiceEnabled === true ? 'session:voice' : null,
  ]);
}

export function getStudioSdkBootstrapSecret(): string | null {
  if (isConfigLoaded()) {
    const config = getConfig() as {
      env: string;
      jwt: { secret?: string };
      auth?: { sdk?: { bootstrapSigningSecret?: string } };
    };
    const configured = config.auth?.sdk?.bootstrapSigningSecret?.trim();
    if (configured) {
      return configured;
    }

    if (config.env === 'test') {
      return config.jwt.secret || null;
    }

    return null;
  }

  const configured = process.env.AUTH_SDK_BOOTSTRAP_SIGNING_SECRET?.trim();
  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === 'test') {
    return process.env.JWT_SECRET ?? null;
  }

  return null;
}
