import type { SDKChannelAuthMode } from '@agent-platform/database/models';
import { generateSdkChannelServerSecret } from '../services/identity/sdk-channel-server-secret.js';

export interface SDKChannelAuthSettings {
  mode: SDKChannelAuthMode;
  hasServerSecret: boolean;
  serverSecretPrefix?: string;
  serverSecretLastRotatedAt?: string;
}

export interface SDKChannelAuthUpdates {
  authMode?: SDKChannelAuthMode;
  serverSecretHash?: string | null;
  serverSecretSalt?: string | null;
  serverSecretPrefix?: string | null;
  serverSecretLastRotatedAt?: Date | null;
}

export interface ResolvedSdkChannelAuthUpdates {
  updates: SDKChannelAuthUpdates;
  generatedServerSecret?: string;
}

const VALID_SDK_CHANNEL_AUTH_MODES: readonly SDKChannelAuthMode[] = [
  'anonymous',
  'hosted_exchange',
];

function hasOwnProperty(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAuthMode(value: unknown): SDKChannelAuthMode {
  return VALID_SDK_CHANNEL_AUTH_MODES.includes(value as SDKChannelAuthMode)
    ? (value as SDKChannelAuthMode)
    : 'anonymous';
}

export function parseSdkChannelAuthSettings(doc: Record<string, unknown>): SDKChannelAuthSettings {
  const hasServerSecret =
    typeof doc.serverSecretHash === 'string' &&
    doc.serverSecretHash.length > 0 &&
    typeof doc.serverSecretSalt === 'string' &&
    doc.serverSecretSalt.length > 0;
  const serverSecretPrefix =
    typeof doc.serverSecretPrefix === 'string' && doc.serverSecretPrefix.length > 0
      ? doc.serverSecretPrefix
      : undefined;
  const rotatedAt =
    doc.serverSecretLastRotatedAt instanceof Date
      ? doc.serverSecretLastRotatedAt
      : typeof doc.serverSecretLastRotatedAt === 'string'
        ? new Date(doc.serverSecretLastRotatedAt)
        : null;

  return {
    mode: normalizeAuthMode(doc.authMode),
    hasServerSecret,
    ...(serverSecretPrefix ? { serverSecretPrefix } : {}),
    ...(rotatedAt && !Number.isNaN(rotatedAt.getTime())
      ? { serverSecretLastRotatedAt: rotatedAt.toISOString() }
      : {}),
  };
}

export async function resolveSdkChannelAuthUpdates(
  body: Record<string, unknown>,
  existing?: {
    authMode?: unknown;
    serverSecretHash?: unknown;
    serverSecretSalt?: unknown;
    serverSecretPrefix?: unknown;
    serverSecretLastRotatedAt?: unknown;
  },
  options?: {
    isCreate?: boolean;
  },
): Promise<ResolvedSdkChannelAuthUpdates | { error: { code: string; message: string } }> {
  if (
    hasOwnProperty(body, 'identityVerification') ||
    hasOwnProperty(body, 'hmacEnforcement') ||
    hasOwnProperty(body, 'secretKey')
  ) {
    return {
      error: {
        code: 'INVALID_SDK_CHANNEL_AUTH_FIELDS',
        message: 'Use auth.mode and auth.rotateServerSecret for SDK channel auth configuration',
      },
    };
  }

  const isCreate = options?.isCreate === true;
  const existingMode = normalizeAuthMode(existing?.authMode);
  const existingHasServerSecret =
    typeof existing?.serverSecretHash === 'string' &&
    existing.serverSecretHash.length > 0 &&
    typeof existing?.serverSecretSalt === 'string' &&
    existing.serverSecretSalt.length > 0;

  let requestedMode: SDKChannelAuthMode | undefined;
  let rotateServerSecret = false;

  if (hasOwnProperty(body, 'auth')) {
    const auth = body.auth;
    if (!isRecord(auth)) {
      return {
        error: {
          code: 'INVALID_SDK_CHANNEL_AUTH',
          message: 'auth must be an object',
        },
      };
    }

    if (hasOwnProperty(auth, 'mode')) {
      if (
        typeof auth.mode !== 'string' ||
        !VALID_SDK_CHANNEL_AUTH_MODES.includes(auth.mode as SDKChannelAuthMode)
      ) {
        return {
          error: {
            code: 'INVALID_SDK_CHANNEL_AUTH_MODE',
            message: `auth.mode must be one of: ${VALID_SDK_CHANNEL_AUTH_MODES.join(', ')}`,
          },
        };
      }
      requestedMode = auth.mode as SDKChannelAuthMode;
    }

    if (hasOwnProperty(auth, 'rotateServerSecret')) {
      if (typeof auth.rotateServerSecret !== 'boolean') {
        return {
          error: {
            code: 'INVALID_SDK_CHANNEL_SECRET_ROTATION',
            message: 'auth.rotateServerSecret must be a boolean',
          },
        };
      }
      rotateServerSecret = auth.rotateServerSecret;
    }
  }

  if (!requestedMode && !rotateServerSecret) {
    return { updates: {} };
  }

  const nextMode = requestedMode ?? existingMode;
  if (rotateServerSecret && nextMode !== 'hosted_exchange') {
    return {
      error: {
        code: 'INVALID_SDK_CHANNEL_SECRET_ROTATION',
        message: 'auth.rotateServerSecret requires auth.mode=hosted_exchange',
      },
    };
  }

  if (nextMode === 'anonymous') {
    return {
      updates: {
        ...(requestedMode ? { authMode: 'anonymous' as const } : {}),
        ...(existingHasServerSecret || existingMode !== 'anonymous'
          ? {
              serverSecretHash: null,
              serverSecretSalt: null,
              serverSecretPrefix: null,
              serverSecretLastRotatedAt: null,
            }
          : {}),
      },
    };
  }

  const isTransitioningToHostedExchange =
    requestedMode === 'hosted_exchange' && existingMode !== 'hosted_exchange';
  const shouldGenerateServerSecret =
    rotateServerSecret || !existingHasServerSecret || isCreate || isTransitioningToHostedExchange;

  if (!shouldGenerateServerSecret) {
    return {
      updates: {
        ...(requestedMode ? { authMode: 'hosted_exchange' as const } : {}),
      },
    };
  }

  const generated = await generateSdkChannelServerSecret();

  return {
    updates: {
      authMode: 'hosted_exchange',
      serverSecretHash: generated.hash,
      serverSecretSalt: generated.salt,
      serverSecretPrefix: generated.prefix,
      serverSecretLastRotatedAt: generated.rotatedAt,
    },
    generatedServerSecret: generated.plaintext,
  };
}
