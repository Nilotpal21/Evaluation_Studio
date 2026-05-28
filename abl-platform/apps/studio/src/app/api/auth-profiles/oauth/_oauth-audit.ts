import { logAuditEvent } from '@/services/audit-service';

const OAUTH_AUDIT_ACTIONS = {
  initiated: 'AUTH_PROFILE_OAUTH_INITIATED',
  completed: 'AUTH_PROFILE_OAUTH_COMPLETED',
  failed: 'AUTH_PROFILE_OAUTH_FAILED',
} as const;

const KNOWN_IDP_ERRORS = new Set([
  'access_denied',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'consent_required',
  'interaction_required',
  'temporarily_unavailable',
  'server_error',
]);

function isOAuthAuditEnabled(): boolean {
  const value = process.env.OAUTH_AUDIT_LOG_ENABLED;
  if (!value) {
    return true;
  }
  return value.toLowerCase() !== 'false';
}

function sanitizeMappedError(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, '_');
  if (normalized.length === 0) {
    return 'provider_error';
  }
  return KNOWN_IDP_ERRORS.has(normalized) ? normalized : 'provider_error';
}

export function mapIdpError(error: unknown): string {
  if (typeof error === 'string') {
    return sanitizeMappedError(error);
  }

  if (typeof error === 'object' && error !== null && 'error' in error) {
    const code = (error as Record<string, unknown>).error;
    if (typeof code === 'string') {
      return sanitizeMappedError(code);
    }
  }

  return 'provider_error';
}

export async function emitOAuthAuditEvent(params: {
  kind: keyof typeof OAUTH_AUDIT_ACTIONS;
  tenantId: string;
  userId: string;
  profileId?: string;
  scope: 'project' | 'workspace';
  projectId: string | null;
  reason?: string;
  idpErrorMapped?: string;
}): Promise<void> {
  if (!isOAuthAuditEnabled()) {
    return;
  }

  if (params.kind === 'initiated') {
    return;
  }

  const metadata: Record<string, unknown> = {
    scope: params.scope,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(params.profileId ? { authProfileId: params.profileId } : {}),
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.idpErrorMapped ? { idpErrorMapped: params.idpErrorMapped } : {}),
  };

  await logAuditEvent({
    tenantId: params.tenantId,
    userId: params.userId,
    action: OAUTH_AUDIT_ACTIONS[params.kind],
    metadata,
  });
}
