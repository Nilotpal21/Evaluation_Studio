import type { Request, Response } from 'express';
import type { AuthType, TenantContextData } from '../types/index.js';

export type AccessDeniedTransport = 'http' | 'websocket';
export type AccessDeniedLayer =
  | 'unified_auth'
  | 'require_auth'
  | 'require_tenant_context'
  | 'permission_guard'
  | 'project_scope'
  | 'environment_scope'
  | 'auth_type'
  | 'platform_admin'
  | 'platform_admin_ip'
  | 'runtime_rbac'
  | 'session_ownership';
export type AccessDeniedScope = 'auth' | 'tenant' | 'project' | 'user' | 'rbac';
export type AccessDeniedStatusCode = 401 | 403 | 404;

export interface AccessDeniedEvent {
  kind: 'access_denied';
  decision: 'deny';
  transport: AccessDeniedTransport;
  layer: AccessDeniedLayer;
  scope: AccessDeniedScope;
  reasonCode: string;
  reason: string;
  concealAsNotFound: boolean;
  statusCode: AccessDeniedStatusCode;
  requestId?: string;
  method?: string;
  path?: string;
  messageType?: string;
  authType?: AuthType;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  requiredPermission?: string | string[];
  metadata?: Record<string, unknown>;
}

export type AccessDeniedReporter = (
  event: Omit<
    AccessDeniedEvent,
    | 'kind'
    | 'decision'
    | 'transport'
    | 'requestId'
    | 'method'
    | 'path'
    | 'authType'
    | 'tenantId'
    | 'projectId'
    | 'userId'
  > &
    Partial<
      Pick<
        AccessDeniedEvent,
        'requestId' | 'method' | 'path' | 'authType' | 'tenantId' | 'projectId' | 'userId'
      >
    >,
) => AccessDeniedEvent;

export interface AccessDeniedLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AccessDeniedReporterConfig {
  transport: AccessDeniedTransport;
  logger?: AccessDeniedLogger;
  onAccessDenied?: (event: AccessDeniedEvent) => void;
  requestId?: string;
  method?: string;
  path?: string;
  messageType?: string;
  tenantContext?: Pick<TenantContextData, 'tenantId' | 'userId' | 'authType'>;
  getTenantContext?: () => Pick<TenantContextData, 'tenantId' | 'userId' | 'authType'> | undefined;
  projectId?: string;
  getProjectId?: () => string | undefined;
}

// @abl/compiler/platform is not a dependency of shared-auth — using console.warn as fallback.
// TODO: Add structured logger dependency or pass logger via DI.
const defaultLogger: AccessDeniedLogger = {
  warn: (message, meta) => console.warn(`[AccessDenied] ${message}`, meta ?? ''),
};

export const PLATFORM_ADMIN_TENANT_ID = '__platform_admin__';

const TENANT_CONTEXT_REQUIRED_RESPONSE = {
  success: false,
  error: {
    code: 'TENANT_CONTEXT_REQUIRED',
    message: 'Tenant context is required for this operation',
  },
} as const;

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function bodyProjectId(req: Request): string | undefined {
  if (!req.body || typeof req.body !== 'object') {
    return undefined;
  }

  const candidate = (req.body as Record<string, unknown>).projectId;
  return firstString(candidate);
}

function getRequestProjectId(req: Request): string | undefined {
  return (
    firstString(req.params?.projectId) ?? firstString(req.query?.projectId) ?? bodyProjectId(req)
  );
}

function logAccessDeniedSideEffectFailure(label: string, error: unknown): void {
  try {
    console.error(
      `[AccessDenied] ${label} failed`,
      error instanceof Error ? error.message : String(error),
    );
  } catch {
    // Denial reporting must never fail the caller's authz path.
  }
}

function runSafeAccessDeniedSideEffect(label: string, effect: () => void): void {
  try {
    effect();
  } catch (error) {
    logAccessDeniedSideEffectFailure(label, error);
  }
}

function buildRequestReporter(req: Request, config?: Partial<AccessDeniedReporterConfig>) {
  return createAccessDeniedReporter({
    transport: 'http',
    logger: config?.logger,
    onAccessDenied: config?.onAccessDenied,
    requestId:
      config?.requestId ??
      firstString(req.headers['x-request-id']) ??
      firstString((req as unknown as { id?: string }).id),
    method: config?.method ?? req.method,
    path: config?.path ?? req.originalUrl ?? req.url,
    messageType: config?.messageType,
    tenantContext: config?.tenantContext,
    getTenantContext: config?.getTenantContext ?? (() => req.tenantContext),
    projectId: config?.projectId,
    getProjectId: config?.getProjectId ?? (() => getRequestProjectId(req)),
  });
}

export function createAccessDeniedReporter(
  config: AccessDeniedReporterConfig,
): AccessDeniedReporter {
  const log = config.logger ?? defaultLogger;

  return (event) => {
    const resolvedProjectId = event.projectId ?? config.getProjectId?.() ?? config.projectId;
    const resolvedTenantContext = config.getTenantContext?.() ?? config.tenantContext;
    const denialEvent: AccessDeniedEvent = {
      kind: 'access_denied',
      decision: 'deny',
      transport: config.transport,
      layer: event.layer,
      scope: event.scope,
      reasonCode: event.reasonCode,
      reason: event.reason,
      concealAsNotFound: event.concealAsNotFound,
      statusCode: event.statusCode,
      requestId: event.requestId ?? config.requestId,
      method: event.method ?? config.method,
      path: event.path ?? config.path,
      messageType: event.messageType ?? config.messageType,
      authType: event.authType ?? resolvedTenantContext?.authType,
      tenantId: event.tenantId ?? resolvedTenantContext?.tenantId,
      projectId: resolvedProjectId,
      userId: event.userId ?? resolvedTenantContext?.userId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      requiredPermission: event.requiredPermission,
      metadata: event.metadata,
    };

    runSafeAccessDeniedSideEffect('logger.warn', () =>
      log.warn('Access denied', denialEvent as unknown as Record<string, unknown>),
    );
    runSafeAccessDeniedSideEffect('onAccessDenied', () => {
      config.onAccessDenied?.(denialEvent);
    });
    return denialEvent;
  };
}

export function attachAccessDeniedReporter(
  req: Request,
  config?: Partial<AccessDeniedReporterConfig>,
): AccessDeniedReporter {
  const reporter = buildRequestReporter(req, config);
  req.reportAccessDenied = reporter;
  return reporter;
}

export function getRequestAccessDeniedReporter(
  req: Request,
  config?: Partial<AccessDeniedReporterConfig>,
): AccessDeniedReporter {
  return req.reportAccessDenied ?? buildRequestReporter(req, config);
}

export function requireTenantContextValue(req: Request, res: Response): TenantContextData | null {
  const ctx = req.tenantContext;
  if (ctx && ctx.tenantId && ctx.tenantId !== PLATFORM_ADMIN_TENANT_ID) {
    return ctx;
  }

  getRequestAccessDeniedReporter(req)({
    layer: 'require_tenant_context',
    scope: 'tenant',
    reasonCode: 'TENANT_CONTEXT_REQUIRED',
    reason: TENANT_CONTEXT_REQUIRED_RESPONSE.error.message,
    concealAsNotFound: false,
    statusCode: 403,
  });

  res.status(403).json(TENANT_CONTEXT_REQUIRED_RESPONSE);
  return null;
}
