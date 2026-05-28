import { createLogger } from '@abl/compiler/platform';
import type { CallerContext } from '@agent-platform/shared-auth';
import type { RuntimeSession } from '../execution/types.js';
import {
  createOwnedFactStore,
  createProjectFactStore,
  PROJECT_SCOPE_USER_ID,
} from '../stores/mongodb-fact-store.js';
import {
  resolveCallerContextSessionPrincipalId,
  resolveRuntimeExecutionOwners,
} from './execution-owners.js';

const log = createLogger('runtime-session-identity');

function mergeDefinedCallerContextValues(callerContext: CallerContext): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(callerContext).filter(([, value]) => value !== undefined),
  );
}

function normalizeSessionPrincipalCallerContext(callerContext: CallerContext): CallerContext {
  const sessionPrincipalId = resolveCallerContextSessionPrincipalId(callerContext);
  if (!sessionPrincipalId) {
    return callerContext;
  }

  if (!callerContext.sessionPrincipalId && callerContext.anonymousId) {
    log.warn('Using legacy anonymousId as sessionPrincipalId compatibility alias', {
      tenantId: callerContext.tenantId,
      channel: callerContext.channel,
    });
  }

  return {
    ...callerContext,
    sessionPrincipalId,
    ...(callerContext.anonymousId ? {} : { anonymousId: sessionPrincipalId }),
  };
}

export function resolveRuntimeSessionUserId(
  callerContext: CallerContext | undefined,
): string | undefined {
  return resolveRuntimeExecutionOwners({ callerContext }).compatibilityUserId;
}

export function rewireRuntimeSessionFactStores(
  runtimeSession: Pick<
    RuntimeSession,
    | 'id'
    | 'tenantId'
    | 'projectId'
    | 'userId'
    | 'callerContext'
    | 'executionScopeKind'
    | 'factStore'
    | 'projectFactStore'
  >,
): void {
  if (!runtimeSession.tenantId || !runtimeSession.projectId) {
    runtimeSession.factStore = undefined;
    runtimeSession.projectFactStore = undefined;
    return;
  }

  try {
    runtimeSession.projectFactStore = createProjectFactStore(
      runtimeSession.tenantId,
      runtimeSession.projectId,
    );
  } catch {
    runtimeSession.projectFactStore = undefined;
    log.warn('Project FactStore creation failed — project-scoped memory disabled', {
      sessionId: runtimeSession.id,
    });
  }

  const durableMemoryOwner = resolveRuntimeExecutionOwners({
    userId: runtimeSession.userId,
    callerContext: runtimeSession.callerContext,
    executionScopeKind: runtimeSession.executionScopeKind,
  }).durableMemoryOwner;

  if (!durableMemoryOwner) {
    runtimeSession.factStore = undefined;
    return;
  }

  if (durableMemoryOwner.id === PROJECT_SCOPE_USER_ID) {
    runtimeSession.factStore = undefined;
    log.warn('Rejected reserved userId value', {
      userId: durableMemoryOwner.id,
      sessionId: runtimeSession.id,
    });
    return;
  }

  try {
    runtimeSession.factStore = createOwnedFactStore(
      runtimeSession.tenantId,
      durableMemoryOwner.id,
      runtimeSession.projectId,
    );
  } catch {
    runtimeSession.factStore = undefined;
    log.warn('FactStore creation failed — persistent memory disabled', {
      sessionId: runtimeSession.id,
    });
  }
}

export function applyCallerContextToRuntimeSession(
  runtimeSession: RuntimeSession,
  callerContext: CallerContext,
): void {
  const normalizedCallerContext = normalizeSessionPrincipalCallerContext(callerContext);
  const mergedCallerContext = {
    ...(runtimeSession.callerContext ?? {}),
    ...normalizedCallerContext,
  };
  runtimeSession.callerContext = mergedCallerContext;

  const sessionNamespace = runtimeSession.data?.values?.session;
  if (sessionNamespace && typeof sessionNamespace === 'object' && sessionNamespace !== null) {
    Object.assign(sessionNamespace, mergeDefinedCallerContextValues(mergedCallerContext));
  }

  const nextUserId = resolveRuntimeExecutionOwners({
    userId: runtimeSession.userId,
    callerContext: runtimeSession.callerContext,
    executionScopeKind: runtimeSession.executionScopeKind,
  }).compatibilityUserId;

  if (nextUserId) {
    // Keep the legacy session.userId lane for model resolution and compatibility
    // while durable memory ownership is resolved explicitly in rewireFactStores().
    runtimeSession.userId = nextUserId;

    if (runtimeSession.data?.values) {
      runtimeSession.data.values.user_id = nextUserId;
    }

    if (sessionNamespace && typeof sessionNamespace === 'object' && sessionNamespace !== null) {
      (sessionNamespace as Record<string, unknown>).userId = nextUserId;
    }
  }

  rewireRuntimeSessionFactStores(runtimeSession);
}
