import { createHmac, timingSafeEqual } from 'node:crypto';

export const SDK_BOOTSTRAP_ARTIFACT_TYPE_VALUES = ['preview', 'share', 'customer'] as const;
export type SDKBootstrapArtifactType = (typeof SDK_BOOTSTRAP_ARTIFACT_TYPE_VALUES)[number];

export const SDK_BOOTSTRAP_PERMISSION_VALUES = [
  'session:send_message',
  'session:voice',
  'session:read',
] as const;
export type SDKBootstrapPermission = (typeof SDK_BOOTSTRAP_PERMISSION_VALUES)[number];

export interface SDKBootstrapArtifactBase {
  tenantId: string;
  projectId: string;
  channelId: string;
  permissions?: SDKBootstrapPermission[];
  exp: number;
}

export interface SDKPreviewBootstrapArtifact extends SDKBootstrapArtifactBase {
  type: 'preview';
}

export interface SDKShareBootstrapArtifact extends SDKBootstrapArtifactBase {
  type: 'share';
}

export interface SDKCustomerBootstrapArtifact extends SDKBootstrapArtifactBase {
  type: 'customer';
  verifiedUserId: string;
  channelArtifact: string;
  jti: string;
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
}

export type SDKBootstrapArtifactPayload =
  | SDKPreviewBootstrapArtifact
  | SDKShareBootstrapArtifact
  | SDKCustomerBootstrapArtifact;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSdkBootstrapPermission(value: unknown): value is SDKBootstrapPermission {
  return (
    typeof value === 'string' &&
    SDK_BOOTSTRAP_PERMISSION_VALUES.includes(value as SDKBootstrapPermission)
  );
}

function isValidPermissions(value: unknown): value is SDKBootstrapPermission[] {
  return Array.isArray(value) && value.every((permission) => isSdkBootstrapPermission(permission));
}

function isValidBasePayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & SDKBootstrapArtifactBase {
  if (typeof payload.tenantId !== 'string' || payload.tenantId.trim().length === 0) {
    return false;
  }

  if (typeof payload.projectId !== 'string' || payload.projectId.trim().length === 0) {
    return false;
  }

  if (typeof payload.channelId !== 'string' || payload.channelId.trim().length === 0) {
    return false;
  }

  if (payload.permissions !== undefined && !isValidPermissions(payload.permissions)) {
    return false;
  }

  return typeof payload.exp === 'number' && Number.isFinite(payload.exp);
}

export function isSdkBootstrapArtifactPayload(
  payload: unknown,
): payload is SDKBootstrapArtifactPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  if (!isValidBasePayload(candidate)) {
    return false;
  }

  if (candidate.type === 'preview' || candidate.type === 'share') {
    return true;
  }

  if (candidate.type !== 'customer') {
    return false;
  }

  if (
    typeof candidate.verifiedUserId !== 'string' ||
    candidate.verifiedUserId.trim().length === 0
  ) {
    return false;
  }

  if (
    typeof candidate.channelArtifact !== 'string' ||
    candidate.channelArtifact.trim().length === 0
  ) {
    return false;
  }

  if (typeof candidate.jti !== 'string' || candidate.jti.trim().length === 0) {
    return false;
  }

  return candidate.userContext === undefined || isPlainObject(candidate.userContext);
}

export function signSdkBootstrapArtifact(
  payload: SDKBootstrapArtifactPayload,
  secret: string,
): string {
  const data = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  const encodedPayload = Buffer.from(data).toString('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySdkBootstrapArtifact(
  token: string,
  secret: string,
): SDKBootstrapArtifactPayload | null {
  try {
    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) {
      return null;
    }

    const data = Buffer.from(encodedPayload, 'base64url').toString();
    const expectedSignature = createHmac('sha256', secret).update(data).digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return null;
    }

    const payload = JSON.parse(data) as unknown;
    if (!isSdkBootstrapArtifactPayload(payload)) {
      return null;
    }

    if (Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
