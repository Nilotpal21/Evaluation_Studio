import type { CallerContext } from '@agent-platform/shared-auth';
import type { ExecutionScope } from './execution-scope.js';

export type ExecutionOwner =
  | { kind: 'contact'; id: string }
  | { kind: 'customer'; id: string }
  | { kind: 'session_principal'; id: string }
  | { kind: 'actor'; id: string };

export interface RuntimeExecutionOwners {
  compatibilityUserId?: string;
  contactOwner?: Extract<ExecutionOwner, { kind: 'contact' }>;
  customerOwner?: Extract<ExecutionOwner, { kind: 'customer' }>;
  sessionPrincipalOwner?: Extract<ExecutionOwner, { kind: 'session_principal' }>;
  actorOwner?: Extract<ExecutionOwner, { kind: 'actor' }>;
  durableMemoryOwner?: Extract<ExecutionOwner, { kind: 'contact' | 'customer' | 'actor' }>;
}

export interface ResolveRuntimeExecutionOwnersInput {
  userId?: string;
  callerContext?: CallerContext;
  executionScopeKind?: ExecutionScope['kind'];
}

export interface ResolveAuthOwnerInput {
  userId?: string;
  sessionPrincipalId?: string;
  authScope?: 'session' | 'user';
}

export interface AuthOwnerResolution {
  userScopedOwnerId?: string;
  sessionPrincipalId?: string;
  tokenOwnerId?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function resolveCallerContextSessionPrincipalId(
  callerContext?: Pick<CallerContext, 'sessionPrincipalId' | 'anonymousId'>,
): string | undefined {
  return (
    normalizeOptionalString(callerContext?.sessionPrincipalId) ??
    normalizeOptionalString(callerContext?.anonymousId)
  );
}

export function resolveRuntimeExecutionOwners(
  input: ResolveRuntimeExecutionOwnersInput,
): RuntimeExecutionOwners {
  const explicitUserId = normalizeOptionalString(input.userId);
  const contactId = normalizeOptionalString(input.callerContext?.contactId);
  const customerId = normalizeOptionalString(input.callerContext?.customerId);
  const sessionPrincipalId = resolveCallerContextSessionPrincipalId(input.callerContext);

  const actorOwnerId =
    explicitUserId &&
    explicitUserId !== contactId &&
    explicitUserId !== customerId &&
    explicitUserId !== sessionPrincipalId &&
    (input.executionScopeKind === 'debug' ||
      input.executionScopeKind === 'system' ||
      input.callerContext?.channel === 'api')
      ? explicitUserId
      : undefined;

  const contactOwner = contactId ? ({ kind: 'contact', id: contactId } as const) : undefined;
  const sessionPrincipalOwner = sessionPrincipalId
    ? ({ kind: 'session_principal', id: sessionPrincipalId } as const)
    : undefined;
  const actorOwner = actorOwnerId ? ({ kind: 'actor', id: actorOwnerId } as const) : undefined;
  const customerOwner = customerId ? ({ kind: 'customer', id: customerId } as const) : undefined;

  return {
    compatibilityUserId:
      contactId ?? customerId ?? actorOwnerId ?? explicitUserId ?? sessionPrincipalId,
    ...(contactOwner ? { contactOwner } : {}),
    ...(customerOwner ? { customerOwner } : {}),
    ...(sessionPrincipalOwner ? { sessionPrincipalOwner } : {}),
    ...(actorOwner ? { actorOwner } : {}),
    ...(contactOwner || customerOwner || actorOwner
      ? {
          durableMemoryOwner: contactOwner ?? customerOwner ?? actorOwner,
        }
      : {}),
  };
}

export function resolveAuthOwners(input: ResolveAuthOwnerInput): AuthOwnerResolution {
  const userScopedOwnerId = normalizeOptionalString(input.userId);
  const sessionPrincipalId = normalizeOptionalString(input.sessionPrincipalId);
  const tokenOwnerId =
    input.authScope === 'session' ? (sessionPrincipalId ?? userScopedOwnerId) : userScopedOwnerId;

  return {
    ...(userScopedOwnerId ? { userScopedOwnerId } : {}),
    ...(sessionPrincipalId ? { sessionPrincipalId } : {}),
    ...(tokenOwnerId ? { tokenOwnerId } : {}),
  };
}
