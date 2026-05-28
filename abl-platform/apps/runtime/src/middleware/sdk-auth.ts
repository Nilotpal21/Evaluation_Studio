/**
 * SDK init public-key resolver.
 *
 * Validates the X-Public-Key header (pk_* prefix) for POST /api/v1/sdk/init and
 * returns the resolved project/tenant/permission scope for the caller.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { createHash } from 'crypto';
import { isDatabaseAvailable } from '../db/index.js';
import { findPublicApiKeyForSdk, updatePublicApiKeyLastUsed } from '../repos/channel-repo.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('sdk-auth');

function normalizeOriginHeader(originHeader: string | string[] | undefined): string | undefined {
  return Array.isArray(originHeader) ? originHeader[0] : originHeader;
}

function normalizeOriginValue(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.endsWith('/') ? value.slice(0, -1) : value;
  }
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function parseAllowedOrigins(rawAllowedOrigins: unknown): string[] | null {
  if (!rawAllowedOrigins) {
    return null;
  }

  const parsedOrigins =
    typeof rawAllowedOrigins === 'string' ? JSON.parse(rawAllowedOrigins) : rawAllowedOrigins;

  if (!Array.isArray(parsedOrigins)) {
    return null;
  }

  const allowedOrigins = parsedOrigins.filter(
    (origin): origin is string => typeof origin === 'string' && origin.trim().length > 0,
  );

  return allowedOrigins.length > 0 ? allowedOrigins : [];
}

export function resolveSdkCorsOrigin(
  allowedOrigins: string[] | null | undefined,
  originHeader: string | string[] | undefined,
): string | null {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return '*';
  }

  const origin = normalizeOriginHeader(originHeader);
  if (!origin) {
    return null;
  }

  const normalizedOrigin = normalizeOriginValue(origin);
  for (const allowedOrigin of allowedOrigins) {
    const normalizedAllowedOrigin = normalizeOriginValue(allowedOrigin);
    if (normalizedAllowedOrigin.includes('*')) {
      if (wildcardPatternToRegExp(normalizedAllowedOrigin).test(normalizedOrigin)) {
        return normalizedOrigin;
      }
      continue;
    }

    if (normalizedAllowedOrigin === normalizedOrigin) {
      return normalizedAllowedOrigin;
    }
  }

  return null;
}

export function originMatchesAllowlist(
  allowedOrigins: string[] | null | undefined,
  originHeader: string | string[] | undefined,
): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return true;
  }

  return resolveSdkCorsOrigin(allowedOrigins, originHeader) !== null;
}

export interface ResolvedSdkInitContext {
  keyId: string;
  projectId: string;
  tenantId: string;
  permissions: string[];
}

export function resolveSdkPublicApiKeyPermissions(rawPermissions: unknown): string[] {
  const permissions: Record<string, boolean> =
    typeof rawPermissions === 'string' ? JSON.parse(rawPermissions) : (rawPermissions ?? {});
  const permissionStrings = new Set<string>();
  if (permissions.chat) {
    permissionStrings.add('session:send_message');
    permissionStrings.add('session:read');
    permissionStrings.add('attachment:read');
    permissionStrings.add('attachment:write');
    permissionStrings.add('attachment:delete');
  }
  if (permissions.voice) {
    permissionStrings.add('session:voice');
    permissionStrings.add('session:read');
  }

  return [...permissionStrings];
}

export type ResolveSdkInitResult =
  | { success: true; data: ResolvedSdkInitContext }
  | { success: false; status: number; body: Record<string, unknown> };

export async function resolveSdkInitFromPublicKey(
  headers: IncomingHttpHeaders,
): Promise<ResolveSdkInitResult> {
  const publicKey = headers['x-public-key'] as string | undefined;

  if (!publicKey) {
    return { success: false, status: 401, body: { error: 'Missing X-Public-Key header' } };
  }

  if (!publicKey.startsWith('pk_')) {
    return {
      success: false,
      status: 401,
      body: { error: 'Invalid key format — expected pk_* prefix' },
    };
  }

  if (!isDatabaseAvailable()) {
    return {
      success: false,
      status: 503,
      body: { error: 'Database unavailable for key validation' },
    };
  }

  try {
    const keyHash = createHash('sha256').update(publicKey).digest('hex');

    const key = await findPublicApiKeyForSdk(keyHash);

    if (!key) {
      log.warn('Invalid or expired public API key', { keyPrefix: publicKey.substring(0, 7) });
      return { success: false, status: 401, body: { error: 'Invalid or expired public API key' } };
    }

    const origin = headers.origin;
    const normalizedOrigin = normalizeOriginHeader(origin);
    const allowedOrigins = parseAllowedOrigins(key.allowedOrigins);
    if (allowedOrigins && allowedOrigins.length > 0) {
      if (!originMatchesAllowlist(allowedOrigins, origin)) {
        if (!normalizedOrigin) {
          log.warn('Origin header required for public API key', { keyId: key.id });
        } else {
          log.warn('Origin not allowed', { origin: normalizedOrigin, keyId: key.id });
        }
        return { success: false, status: 403, body: { error: 'Origin not allowed' } };
      }
    }

    await updatePublicApiKeyLastUsed(key.id);

    const tenantId = key.project?.tenantId;
    if (!tenantId) {
      log.error('Project has no associated tenant', { projectId: key.projectId });
      return {
        success: false,
        status: 500,
        body: { error: 'Project has no associated tenant' },
      };
    }

    return {
      success: true,
      data: {
        keyId: key.id,
        projectId: key.projectId,
        tenantId,
        permissions: resolveSdkPublicApiKeyPermissions(key.permissions),
      },
    };
  } catch (error) {
    log.error('Key validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, status: 500, body: { error: 'Internal server error' } };
  }
}
