/**
 * Auth Preflight Service
 *
 * Orchestrates preflight consent checking on session start:
 * 1. Extracts auth requirements from compiled IR
 * 2. Checks existing tokens via ConsentStateResolver
 * 3. Manages auth gate state (pending → satisfied)
 * 4. Queues messages while auth gate is pending
 */

import {
  collectAuthRequirements,
  mergeAuthRequirement,
  type AuthRequirementIR,
  type AuthRequirementSource,
} from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { AuthRequirement } from '../../types/index.js';
import {
  resolveConsentState,
  type ConsentCheckResult,
  type TokenLookupFunctions,
} from './consent-state-resolver.js';
import { resolveByName } from '../auth-profile-resolver.js';
import { hasOAuthGrantAccessToken } from '../oauth-grant-service.js';
import { resolveAuthProfileRef, type ConfigVarStoreLike } from './resolve-tool-auth.js';
import {
  cloneSdkMessageMetadata,
  type SdkMessageMetadata,
} from '../identity/sdk-message-metadata.js';
import type { InteractionContextInput } from '@agent-platform/shared-kernel';

const log = createLogger('auth-preflight');

interface AuthProfileTokenLookupContext {
  tenantId: string;
  projectId?: string;
  environment?: string;
  authProfileRef: string;
  /**
   * Effective auth principal:
   * - verified end-user ID for user-scoped SDK callers
   * - SDK session principal for anonymous/session-scoped SDK callers
   */
  userId?: string;
  scope: 'session' | 'user' | 'tenant';
  requiredScopes?: string[];
}

export interface AuthPreflightEvaluation {
  pending: AuthRequirement[];
  satisfied: AuthRequirement[];
}

interface MaterializedAuthRequirement extends AuthRequirementIR {
  profileId?: string;
  environment?: string | null;
}

interface AuthRequirementSelection {
  agentNames?: readonly string[];
}

interface AuthGateRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

export interface QueuedAuthGateMessage {
  text: string;
  attachmentIds?: string[];
  messageMetadata?: SdkMessageMetadata;
  interactionContext?: InteractionContextInput;
}

/** Auth gate state for a session */
export interface AuthGateState {
  /** Whether the auth gate is active (blocking messages) */
  active: boolean;
  /** Auth requirements that are pending */
  pending: AuthRequirement[];
  /** Auth requirements that are satisfied */
  satisfied: AuthRequirement[];
  /** Messages queued while auth gate is active */
  queuedMessages: QueuedAuthGateMessage[];
  /** Timestamp when this gate was created (for TTL expiry) */
  createdAt: number;
}

/** In-memory store of auth gate states per session */
const authGateStates = new Map<string, AuthGateState>();
const authGateMutationQueues = new Map<string, Promise<void>>();

// Max sessions to track (prevent memory leak)
const MAX_AUTH_GATE_ENTRIES = 10000;

/** TTL for abandoned auth gates (30 minutes) */
const AUTH_GATE_TTL_MS = 30 * 60 * 1000;

/** Max messages that can be queued behind an auth gate per session */
const MAX_QUEUED_MESSAGES = 100;

/** Cleanup interval for expired auth gates (5 minutes) */
const AUTH_GATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Redis key prefix for persisted auth gate state */
const AUTH_GATE_REDIS_PREFIX = 'auth-gate:';

/**
 * Periodically clean up expired auth gates (abandoned sessions).
 * Uses check-on-access + interval pattern similar to AuthProfileCache.
 */
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, state] of authGateStates) {
    if (now - state.createdAt > AUTH_GATE_TTL_MS) {
      authGateStates.delete(sessionId);
      log.info('Expired auth gate cleaned up', { sessionId });
    }
  }
}, AUTH_GATE_CLEANUP_INTERVAL_MS);
// Allow process to exit without waiting for cleanup
if (_cleanupTimer && typeof _cleanupTimer === 'object' && 'unref' in _cleanupTimer) {
  (_cleanupTimer as NodeJS.Timeout).unref();
}

function cloneAuthRequirement(requirement: AuthRequirement): AuthRequirement {
  return {
    ...requirement,
    ...(requirement.scopes ? { scopes: [...requirement.scopes] } : {}),
  };
}

function cloneQueuedAuthGateMessage(message: QueuedAuthGateMessage): QueuedAuthGateMessage {
  return {
    text: message.text,
    ...(message.attachmentIds ? { attachmentIds: [...message.attachmentIds] } : {}),
    ...(message.messageMetadata
      ? { messageMetadata: cloneSdkMessageMetadata(message.messageMetadata) }
      : {}),
    ...(message.interactionContext
      ? { interactionContext: { ...message.interactionContext } }
      : {}),
  };
}

function cloneAuthGateState(state: AuthGateState): AuthGateState {
  return {
    active: state.active,
    pending: state.pending.map(cloneAuthRequirement),
    satisfied: state.satisfied.map(cloneAuthRequirement),
    queuedMessages: state.queuedMessages.map(cloneQueuedAuthGateMessage),
    createdAt: state.createdAt,
  };
}

function isAuthGateExpired(state: Pick<AuthGateState, 'createdAt'>): boolean {
  return Date.now() - state.createdAt > AUTH_GATE_TTL_MS;
}

function storeAuthGateStateLocally(sessionId: string, state: AuthGateState): void {
  if (authGateStates.size >= MAX_AUTH_GATE_ENTRIES && !authGateStates.has(sessionId)) {
    const firstKey = authGateStates.keys().next().value;
    if (firstKey) {
      authGateStates.delete(firstKey);
    }
  }

  authGateStates.set(sessionId, cloneAuthGateState(state));
}

function getAuthGateRedisKey(sessionId: string): string {
  return `${AUTH_GATE_REDIS_PREFIX}${sessionId}`;
}

function createAuthGatePersistenceError(action: 'persist' | 'delete' | 'load'): Error {
  return new Error(
    action === 'persist'
      ? 'Authentication state could not be persisted. Please retry.'
      : action === 'delete'
        ? 'Authentication state cleanup could not be completed. Please retry.'
        : 'Authentication state could not be read. Please retry.',
  );
}

function allowInMemoryAuthGateStateStore(): boolean {
  return (
    process.env.NODE_ENV === 'test' || process.env.ALLOW_INMEMORY_AUTH_GATE_STATE_STORE === 'true'
  );
}

async function runSerializedAuthGateMutation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = authGateMutationQueues.get(sessionId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  authGateMutationQueues.set(sessionId, tail);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent();
    if (authGateMutationQueues.get(sessionId) === tail) {
      authGateMutationQueues.delete(sessionId);
    }
  }
}

async function getAuthGateRedisClient(): Promise<AuthGateRedisClient | null> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const client = getRedisClient() as AuthGateRedisClient | null;
    // Use the client if it exists — do not require `status === 'ready'`.
    // ioredis queues commands until connect; requiring `ready` caused auth-gate
    // failures when strict persistence ran during the brief connecting window.
    if (!client) {
      return null;
    }
    return client;
  } catch (err) {
    log.debug('Auth gate Redis client unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function deletePersistedAuthGateState(
  sessionId: string,
  options?: { strict?: boolean },
): Promise<void> {
  const redis = await getAuthGateRedisClient();
  if (!redis) {
    if (options?.strict && !allowInMemoryAuthGateStateStore()) {
      throw createAuthGatePersistenceError('delete');
    }
    return;
  }

  try {
    await redis.del(getAuthGateRedisKey(sessionId));
  } catch (err) {
    log.warn('Failed to delete persisted auth gate state', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (options?.strict) {
      throw createAuthGatePersistenceError('delete');
    }
  }
}

async function persistAuthGateState(
  sessionId: string,
  state: AuthGateState,
  options?: { strict?: boolean },
): Promise<void> {
  const redis = await getAuthGateRedisClient();
  if (!redis) {
    if (options?.strict && !allowInMemoryAuthGateStateStore()) {
      throw createAuthGatePersistenceError('persist');
    }
    return;
  }

  const ageMs = Date.now() - state.createdAt;
  const ttlSeconds = Math.ceil((AUTH_GATE_TTL_MS - ageMs) / 1000);
  if (ttlSeconds <= 0) {
    await deletePersistedAuthGateState(sessionId, options);
    return;
  }

  try {
    await redis.set(
      getAuthGateRedisKey(sessionId),
      JSON.stringify(cloneAuthGateState(state)),
      'EX',
      ttlSeconds,
    );
  } catch (err) {
    log.warn('Failed to persist auth gate state', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (options?.strict) {
      throw createAuthGatePersistenceError('persist');
    }
  }
}

function parsePersistedAuthGateState(raw: string): AuthGateState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuthGateState>;
    if (
      typeof parsed !== 'object' ||
      parsed == null ||
      !Array.isArray(parsed.pending) ||
      !Array.isArray(parsed.satisfied) ||
      !Array.isArray(parsed.queuedMessages) ||
      typeof parsed.active !== 'boolean' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }

    return {
      active: parsed.active,
      pending: parsed.pending.map((requirement) => cloneAuthRequirement(requirement)),
      satisfied: parsed.satisfied.map((requirement) => cloneAuthRequirement(requirement)),
      queuedMessages: parsed.queuedMessages.map((message) => ({
        text: message.text,
        ...(message.attachmentIds ? { attachmentIds: [...message.attachmentIds] } : {}),
        ...(message.messageMetadata &&
        typeof message.messageMetadata === 'object' &&
        !Array.isArray(message.messageMetadata)
          ? {
              messageMetadata: cloneSdkMessageMetadata(
                message.messageMetadata as SdkMessageMetadata,
              ),
            }
          : {}),
        ...(message.interactionContext &&
        typeof message.interactionContext === 'object' &&
        !Array.isArray(message.interactionContext)
          ? {
              interactionContext: {
                ...(typeof message.interactionContext.language === 'string'
                  ? { language: message.interactionContext.language }
                  : {}),
                ...(typeof message.interactionContext.locale === 'string'
                  ? { locale: message.interactionContext.locale }
                  : {}),
                ...(typeof message.interactionContext.timezone === 'string'
                  ? { timezone: message.interactionContext.timezone }
                  : {}),
              },
            }
          : {}),
      })),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

async function loadPersistedAuthGateState(
  sessionId: string,
  options?: { strict?: boolean },
): Promise<AuthGateState | null> {
  const redis = await getAuthGateRedisClient();
  if (!redis) {
    if (options?.strict && !allowInMemoryAuthGateStateStore()) {
      throw createAuthGatePersistenceError('load');
    }
    return null;
  }

  let raw: string | null = null;
  try {
    raw = await redis.get(getAuthGateRedisKey(sessionId));
  } catch (err) {
    log.warn('Failed to read persisted auth gate state', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (options?.strict) {
      throw createAuthGatePersistenceError('load');
    }
    return null;
  }

  if (!raw) {
    return null;
  }

  const parsed = parsePersistedAuthGateState(raw);
  if (!parsed) {
    await deletePersistedAuthGateState(sessionId);
    return null;
  }

  if (isAuthGateExpired(parsed)) {
    await deletePersistedAuthGateState(sessionId);
    return null;
  }

  return parsed;
}

/**
 * Convert IR auth requirements to client-facing AuthRequirement format
 */
function toClientRequirement(ir: MaterializedAuthRequirement): AuthRequirement {
  return {
    requirementKey: buildAuthRequirementKey(ir),
    connector: ir.connector,
    authProfileRef: ir.auth_profile_ref,
    ...(ir.profileId ? { profileId: ir.profileId } : {}),
    ...(ir.environment !== undefined ? { environment: ir.environment } : {}),
    scopes: ir.scopes,
    connectionMode: ir.connection_mode,
  };
}

function normalizeScopes(scopes?: string[] | null): string[] {
  if (!scopes || scopes.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === 'string')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

function normalizeRequirementNamespaceIds(variableNamespaceIds?: readonly string[]): string[] {
  if (!variableNamespaceIds || variableNamespaceIds.length === 0) {
    return [];
  }

  return Array.from(
    new Set(variableNamespaceIds.filter((namespaceId): namespaceId is string => !!namespaceId)),
  ).sort((a, b) => a.localeCompare(b));
}

function buildAuthRequirementKey(
  requirement: Pick<
    MaterializedAuthRequirement,
    'auth_profile_ref' | 'connection_mode' | 'profileId' | 'environment' | 'variable_namespace_ids'
  >,
): string {
  const modePart = `mode:${requirement.connection_mode}`;
  if (requirement.profileId) {
    return `profile:${requirement.profileId}|${modePart}`;
  }

  const environmentPart =
    requirement.environment === undefined
      ? '__unknown__'
      : requirement.environment === null
        ? '__default__'
        : requirement.environment;

  if (!requirement.auth_profile_ref.includes('{{')) {
    return `ref:${requirement.auth_profile_ref}|env:${environmentPart}|${modePart}`;
  }

  const normalizedNamespaces = normalizeRequirementNamespaceIds(requirement.variable_namespace_ids);
  const namespacePart =
    normalizedNamespaces.length > 0 ? normalizedNamespaces.join(',') : '__unscoped__';
  return `ref:${requirement.auth_profile_ref}|env:${environmentPart}|ns:${namespacePart}|${modePart}`;
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes?: string[]): boolean {
  const normalizedRequiredScopes = normalizeScopes(requiredScopes);
  if (normalizedRequiredScopes.length === 0) {
    return true;
  }

  const grantedScopeSet = new Set(grantedScopes);
  if (grantedScopeSet.size === 0) {
    return false;
  }

  return normalizedRequiredScopes.every((scope) => grantedScopeSet.has(scope));
}

function getGrantedScopesFromProfileConfig(config: Record<string, unknown>): string[] {
  const arrayValues = [config.grantedScopes, config.scopes]
    .filter((value): value is string[] => Array.isArray(value))
    .flatMap((value) => value);

  return normalizeScopes(arrayValues);
}

let preflightConfigVarStore: ConfigVarStoreLike | null | undefined;

async function getPreflightConfigVarStore(): Promise<ConfigVarStoreLike | undefined> {
  if (preflightConfigVarStore !== undefined) {
    return preflightConfigVarStore ?? undefined;
  }

  try {
    preflightConfigVarStore = {
      async findConfigVar(params) {
        const { ProjectConfigVariable, VariableNamespaceMembership } =
          await import('@agent-platform/database/models');

        if (params.variableNamespaceIds && params.variableNamespaceIds.length > 0) {
          const configVar = await ProjectConfigVariable.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            key: params.key,
          })
            .select('_id value')
            .lean();

          if (!configVar) {
            return null;
          }

          const membership = await VariableNamespaceMembership.findOne({
            tenantId: params.tenantId,
            projectId: params.projectId,
            variableId: configVar._id,
            variableType: 'config',
            namespaceId: { $in: params.variableNamespaceIds },
          }).lean();

          if (!membership) {
            return null;
          }

          return { value: configVar.value };
        }

        const record = await ProjectConfigVariable.findOne({
          tenantId: params.tenantId,
          projectId: params.projectId,
          key: params.key,
        })
          .select('value')
          .lean();

        return record ?? null;
      },
    };
  } catch (err) {
    log.warn('Preflight config variable store unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    preflightConfigVarStore = null;
  }

  return preflightConfigVarStore ?? undefined;
}

async function resolvePreflightAuthProfileRef(params: {
  tenantId?: string;
  projectId?: string;
  authProfileRef: string;
  variableNamespaceIds?: string[];
}): Promise<string | null> {
  if (!params.authProfileRef.includes('{{')) {
    return params.authProfileRef;
  }

  if (!params.tenantId || !params.projectId) {
    return null;
  }

  return resolveAuthProfileRef(
    params.authProfileRef,
    params.tenantId,
    params.projectId,
    await getPreflightConfigVarStore(),
    params.variableNamespaceIds,
  );
}

async function materializeAuthRequirement(
  requirement: AuthRequirementIR,
  context: {
    tenantId?: string;
    projectId?: string;
    environment?: string;
    userId?: string;
  },
): Promise<MaterializedAuthRequirement> {
  const resolvedAuthProfileRef =
    (await resolvePreflightAuthProfileRef({
      tenantId: context.tenantId,
      projectId: context.projectId,
      authProfileRef: requirement.auth_profile_ref,
      variableNamespaceIds: requirement.variable_namespace_ids,
    })) ?? requirement.auth_profile_ref;

  const materialized: MaterializedAuthRequirement = {
    ...requirement,
    auth_profile_ref: resolvedAuthProfileRef,
  };

  if (!context.tenantId) {
    return materialized;
  }

  try {
    const profile = await resolveByName(
      resolvedAuthProfileRef,
      context.tenantId,
      context.environment,
      context.projectId,
      requirement.connection_mode === 'shared' ? undefined : context.userId,
    );

    if (profile) {
      materialized.profileId = profile.profileId;
      materialized.environment = profile.environment ?? null;
    }
  } catch (err) {
    log.warn('Failed to materialize auth requirement profile metadata', {
      authProfileRef: resolvedAuthProfileRef,
      tenantId: context.tenantId,
      projectId: context.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return materialized;
}

async function materializeAuthRequirements(
  requirements: AuthRequirementIR[],
  context: {
    tenantId?: string;
    projectId?: string;
    environment?: string;
    userId?: string;
  },
): Promise<MaterializedAuthRequirement[]> {
  const materialized = await Promise.all(
    requirements.map((requirement) => materializeAuthRequirement(requirement, context)),
  );
  const deduped = new Map<string, MaterializedAuthRequirement>();

  for (const requirement of materialized) {
    const dedupeKey = buildAuthRequirementKey(requirement);
    const existing = deduped.get(dedupeKey);
    if (!existing) {
      deduped.set(dedupeKey, requirement);
      continue;
    }

    const merged = mergeAuthRequirement(
      {
        connector: existing.connector,
        auth_profile_ref: existing.auth_profile_ref,
        variable_namespace_ids: new Set(existing.variable_namespace_ids ?? []),
        scopes: new Set(existing.scopes ?? []),
        connection_mode: existing.connection_mode,
        consent_mode: existing.consent_mode,
      },
      {
        connector: requirement.connector,
        auth_profile_ref: requirement.auth_profile_ref,
        variable_namespace_ids: new Set(requirement.variable_namespace_ids ?? []),
        scopes: new Set(requirement.scopes ?? []),
        connection_mode: requirement.connection_mode,
        consent_mode: requirement.consent_mode,
      },
    );

    if (
      existing.profileId &&
      requirement.profileId &&
      existing.profileId !== requirement.profileId
    ) {
      log.warn('Auth requirements resolved to the same reference but different profiles', {
        authProfileRef: requirement.auth_profile_ref,
        existingProfileId: existing.profileId,
        incomingProfileId: requirement.profileId,
      });
    }

    deduped.set(dedupeKey, {
      ...requirement,
      connector: merged.connector,
      variable_namespace_ids:
        merged.variable_namespace_ids && merged.variable_namespace_ids.size > 0
          ? Array.from(merged.variable_namespace_ids).sort()
          : undefined,
      scopes: merged.scopes.size > 0 ? Array.from(merged.scopes).sort() : undefined,
      connection_mode: merged.connection_mode,
      consent_mode: merged.consent_mode,
      profileId: existing.profileId ?? requirement.profileId,
      environment:
        existing.environment !== undefined ? existing.environment : requirement.environment,
    });
  }

  return Array.from(deduped.values()).sort((a, b) =>
    a.auth_profile_ref.localeCompare(b.auth_profile_ref),
  );
}

function collectRuntimeAuthRequirements(
  compilationOutput: AuthRequirementSource,
  selection?: AuthRequirementSelection,
): AuthRequirementIR[] {
  return collectAuthRequirements(compilationOutput, selection);
}

async function hasAuthProfileToken(context: AuthProfileTokenLookupContext): Promise<boolean> {
  const resolvedAuthProfileRef = await resolvePreflightAuthProfileRef({
    tenantId: context.tenantId,
    projectId: context.projectId,
    authProfileRef: context.authProfileRef,
  });

  if (!resolvedAuthProfileRef) {
    return false;
  }

  if ((context.scope === 'user' || context.scope === 'session') && !context.userId) {
    return false;
  }

  try {
    return hasOAuthGrantAccessToken({
      tenantId: context.tenantId,
      authProfileRef: resolvedAuthProfileRef,
      projectId: context.projectId,
      environment: context.environment,
      userId: context.scope === 'tenant' ? undefined : context.userId,
      lookupScope: context.scope === 'tenant' ? 'tenant' : 'user',
      authScope: context.scope,
      scopes: context.requiredScopes,
    });
  } catch (err) {
    log.warn('Failed to inspect auth profile token during preflight lookup', {
      authProfileRef: context.authProfileRef,
      scope: context.scope,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function evaluateAuthPreflight(
  authRequirements: AuthRequirementIR[] | undefined,
  context: {
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    projectId?: string;
    environment?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
): Promise<AuthPreflightEvaluation | null> {
  if (!authRequirements || authRequirements.length === 0) {
    return null;
  }

  const preflightReqs = authRequirements.filter((r) => r.consent_mode === 'preflight');
  if (preflightReqs.length === 0) {
    return null;
  }

  const materializedReqs = await materializeAuthRequirements(preflightReqs, context);
  const results = await resolveConsentState(materializedReqs, context, lookups);

  const pending: AuthRequirement[] = [];
  const satisfied: AuthRequirement[] = [];

  for (const [index, result] of results.entries()) {
    const matchedReq = materializedReqs[index];
    if (!matchedReq) {
      log.warn('Materialized auth requirement missing during preflight evaluation', {
        authProfileRef: result.authProfileRef,
      });
      continue;
    }
    const clientReq = toClientRequirement(matchedReq);
    if (result.satisfied) {
      satisfied.push(clientReq);
    } else {
      pending.push(clientReq);
    }
  }

  if (pending.length === 0) {
    return null;
  }

  return { pending, satisfied };
}

/**
 * Check auth requirements for a session and return the auth gate state.
 * Returns null if no preflight requirements exist (session can proceed immediately).
 */
export async function checkAuthPreflight(
  sessionId: string,
  authRequirements: AuthRequirementIR[] | undefined,
  context: {
    userId?: string;
    tenantId?: string;
    projectId?: string;
    environment?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
): Promise<AuthGateState | null> {
  return runSerializedAuthGateMutation(sessionId, async () => {
    const evaluation = await evaluateAuthPreflight(
      authRequirements,
      { ...context, sessionId },
      lookups,
    );
    if (!evaluation) {
      return null;
    }

    const state: AuthGateState = {
      active: true,
      pending: evaluation.pending,
      satisfied: evaluation.satisfied,
      queuedMessages: [],
      createdAt: Date.now(),
    };

    await persistAuthGateState(sessionId, state, { strict: true });
    storeAuthGateStateLocally(sessionId, state);
    log.info('Auth gate activated', {
      sessionId,
      pendingCount: evaluation.pending.length,
      satisfiedCount: evaluation.satisfied.length,
    });

    return state;
  });
}

/**
 * Check if a session has an active auth gate.
 * Expired gates are cleaned up on access.
 */
export function hasActiveAuthGate(sessionId: string): boolean {
  const state = authGateStates.get(sessionId);
  if (!state) return false;
  if (isAuthGateExpired(state)) {
    authGateStates.delete(sessionId);
    log.info('Auth gate expired on access', { sessionId });
    return false;
  }
  return state.active;
}

/**
 * Get the auth gate state for a session.
 * Expired gates are cleaned up on access.
 */
export function getAuthGateState(sessionId: string): AuthGateState | undefined {
  const state = authGateStates.get(sessionId);
  if (!state) return undefined;
  if (isAuthGateExpired(state)) {
    authGateStates.delete(sessionId);
    log.info('Auth gate expired on access', { sessionId });
    return undefined;
  }
  return state;
}

export async function getAuthGateStateAsync(sessionId: string): Promise<AuthGateState | undefined> {
  const state = getAuthGateState(sessionId);
  if (state) {
    return state;
  }

  const persisted = await loadPersistedAuthGateState(sessionId, { strict: true });
  if (!persisted) {
    return undefined;
  }

  storeAuthGateStateLocally(sessionId, persisted);
  return getAuthGateState(sessionId);
}

export async function hasActiveAuthGateAsync(sessionId: string): Promise<boolean> {
  const state = await getAuthGateStateAsync(sessionId);
  return state?.active === true;
}

/**
 * Queue a message while the auth gate is active.
 * Returns true if the message was queued, false if no gate is active.
 * Throws if the queue is full (MAX_QUEUED_MESSAGES).
 */
export function queueMessageBehindAuthGate(
  sessionId: string,
  text: string,
  attachmentIds?: string[],
  messageMetadata?: SdkMessageMetadata,
  interactionContext?: InteractionContextInput,
): boolean {
  const state = authGateStates.get(sessionId);
  if (!state || !state.active) {
    return false;
  }
  if (state.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
    log.warn('Auth gate message queue full', {
      sessionId,
      queueDepth: state.queuedMessages.length,
      maxQueueSize: MAX_QUEUED_MESSAGES,
    });
    throw new Error('Too many queued messages, please complete authentication first');
  }
  state.queuedMessages.push(
    cloneQueuedAuthGateMessage({
      text,
      attachmentIds,
      messageMetadata,
      interactionContext,
    }),
  );
  log.info('Message queued behind auth gate', {
    sessionId,
    queueDepth: state.queuedMessages.length,
  });
  return true;
}

export async function queueMessageBehindAuthGateAsync(
  sessionId: string,
  text: string,
  attachmentIds?: string[],
  messageMetadata?: SdkMessageMetadata,
  interactionContext?: InteractionContextInput,
): Promise<boolean> {
  return runSerializedAuthGateMutation(sessionId, async () => {
    const state = await getAuthGateStateAsync(sessionId);
    if (!state || !state.active) {
      return false;
    }
    if (state.queuedMessages.length >= MAX_QUEUED_MESSAGES) {
      log.warn('Auth gate message queue full', {
        sessionId,
        queueDepth: state.queuedMessages.length,
        maxQueueSize: MAX_QUEUED_MESSAGES,
      });
      throw new Error('Too many queued messages, please complete authentication first');
    }

    const nextState = cloneAuthGateState(state);
    nextState.queuedMessages.push(
      cloneQueuedAuthGateMessage({
        text,
        attachmentIds,
        messageMetadata,
        interactionContext,
      }),
    );
    await persistAuthGateState(sessionId, nextState, { strict: true });
    storeAuthGateStateLocally(sessionId, nextState);

    log.info('Message queued behind auth gate', {
      sessionId,
      queueDepth: nextState.queuedMessages.length,
    });
    return true;
  });
}

/**
 * Mark a connector as satisfied. Returns the updated state.
 * When all connectors are satisfied, deactivates the gate and returns queued messages.
 */
export function satisfyConnector(
  sessionId: string,
  requirementKeyOrAuthProfileRef: string,
): {
  state: AuthGateState;
  allSatisfied: boolean;
  queuedMessages: QueuedAuthGateMessage[];
} | null {
  const state = authGateStates.get(sessionId);
  if (!state) {
    return null;
  }

  // Find the pending requirement and move to satisfied
  const idx = state.pending.findIndex(
    (pendingRequirement) =>
      pendingRequirement.requirementKey === requirementKeyOrAuthProfileRef ||
      pendingRequirement.authProfileRef === requirementKeyOrAuthProfileRef,
  );
  if (idx === -1) {
    log.warn('Connector not found in pending list', {
      sessionId,
      requirementKeyOrAuthProfileRef,
    });
    return { state, allSatisfied: !state.active, queuedMessages: [] };
  }

  const [moved] = state.pending.splice(idx, 1);
  state.satisfied.push(moved);

  const allSatisfied = state.pending.length === 0;
  let queuedMessages: QueuedAuthGateMessage[] = [];

  if (allSatisfied) {
    state.active = false;
    queuedMessages = state.queuedMessages.map(cloneQueuedAuthGateMessage);
    state.queuedMessages = [];
    log.info('Auth gate satisfied, releasing queued messages', {
      sessionId,
      messageCount: queuedMessages.length,
    });
  }

  return { state, allSatisfied, queuedMessages };
}

/**
 * Replace the auth gate state with a fresh preflight evaluation.
 * Used when the client reports consent completion so the server can
 * re-check token state instead of trusting the signal blindly.
 */
export function reconcileAuthGateWithEvaluation(
  sessionId: string,
  evaluation: AuthPreflightEvaluation | null,
): {
  state: AuthGateState;
  allSatisfied: boolean;
  queuedMessages: QueuedAuthGateMessage[];
} | null {
  const state = authGateStates.get(sessionId);
  if (!state) {
    return null;
  }

  if (!evaluation) {
    const previouslyKnown = new Map<string, AuthRequirement>();
    for (const requirement of [...state.satisfied, ...state.pending]) {
      previouslyKnown.set(requirement.requirementKey ?? requirement.authProfileRef, requirement);
    }

    state.pending = [];
    state.satisfied = Array.from(previouslyKnown.values());
    state.active = false;

    const queuedMessages = state.queuedMessages.map(cloneQueuedAuthGateMessage);
    state.queuedMessages = [];
    return { state, allSatisfied: true, queuedMessages };
  }

  state.pending = [...evaluation.pending];
  state.satisfied = [...evaluation.satisfied];
  state.active = evaluation.pending.length > 0;

  return {
    state,
    allSatisfied: evaluation.pending.length === 0,
    queuedMessages: [],
  };
}

export async function reconcileAuthGateWithEvaluationAsync(
  sessionId: string,
  evaluation: AuthPreflightEvaluation | null,
): Promise<{
  state: AuthGateState;
  allSatisfied: boolean;
  queuedMessages: QueuedAuthGateMessage[];
} | null> {
  return runSerializedAuthGateMutation(sessionId, async () => {
    const state = await getAuthGateStateAsync(sessionId);
    if (!state) {
      return null;
    }

    const nextState = cloneAuthGateState(state);
    let result: {
      state: AuthGateState;
      allSatisfied: boolean;
      queuedMessages: QueuedAuthGateMessage[];
    } | null = null;

    if (!evaluation) {
      const previouslyKnown = new Map<string, AuthRequirement>();
      for (const requirement of [...nextState.satisfied, ...nextState.pending]) {
        previouslyKnown.set(requirement.requirementKey ?? requirement.authProfileRef, requirement);
      }

      nextState.pending = [];
      nextState.satisfied = Array.from(previouslyKnown.values());
      nextState.active = false;

      const queuedMessages = nextState.queuedMessages.map(cloneQueuedAuthGateMessage);
      nextState.queuedMessages = [];
      result = { state: nextState, allSatisfied: true, queuedMessages };
    } else {
      nextState.pending = [...evaluation.pending];
      nextState.satisfied = [...evaluation.satisfied];
      nextState.active = evaluation.pending.length > 0;
      result = {
        state: nextState,
        allSatisfied: evaluation.pending.length === 0,
        queuedMessages: [],
      };
    }

    if (nextState.active) {
      await persistAuthGateState(sessionId, nextState, { strict: true });
    } else {
      await deletePersistedAuthGateState(sessionId, { strict: true });
    }
    storeAuthGateStateLocally(sessionId, nextState);

    return result;
  });
}

/**
 * Clean up auth gate state for a session (on disconnect/reset).
 */
export function cleanupAuthGate(sessionId: string): void {
  authGateStates.delete(sessionId);
}

export async function cleanupAuthGateAsync(sessionId: string): Promise<void> {
  await runSerializedAuthGateMutation(sessionId, async () => {
    await deletePersistedAuthGateState(sessionId, { strict: true });
    cleanupAuthGate(sessionId);
  });
}

/**
 * Get all active auth gate session IDs (for monitoring).
 */
export function getActiveAuthGateCount(): number {
  let count = 0;
  for (const state of authGateStates.values()) {
    if (state.active) count++;
  }
  return count;
}

/**
 * Convenience wrapper: extract auth requirements from a CompilationOutput
 * and run preflight check. Avoids callers needing to import collectAuthRequirements.
 *
 * Returns null if no preflight requirements exist or all are satisfied.
 */
export async function checkAuthPreflightFromIR(
  sessionId: string,
  compilationOutput: AuthRequirementSource | null,
  context: {
    userId?: string;
    tenantId?: string;
    projectId?: string;
    environment?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
  selection?: AuthRequirementSelection,
): Promise<AuthGateState | null> {
  if (!compilationOutput) return null;

  const requirements = collectRuntimeAuthRequirements(compilationOutput, selection);
  if (requirements.length === 0) return null;

  return checkAuthPreflight(sessionId, requirements, context, lookups);
}

export async function evaluateAuthPreflightFromIR(
  compilationOutput: AuthRequirementSource | null,
  context: {
    sessionId?: string;
    userId?: string;
    tenantId?: string;
    projectId?: string;
    environment?: string;
    authScope?: 'session' | 'user';
    allowTenantTokenReuse?: boolean;
  },
  lookups: TokenLookupFunctions,
  selection?: AuthRequirementSelection,
): Promise<AuthPreflightEvaluation | null> {
  if (!compilationOutput) {
    return null;
  }

  const requirements = collectRuntimeAuthRequirements(compilationOutput, selection);
  if (requirements.length === 0) {
    return null;
  }

  return evaluateAuthPreflight(requirements, context, lookups);
}

/**
 * Create real token lookup functions using ToolOAuthService.
 * Falls back to always-false if the service is not initialized.
 *
 * H-1 fix: Previously hardcoded to () => false, making cross-session reuse dead code.
 */
export function createTokenLookups(
  tenantId?: string,
  projectId?: string,
  environment?: string,
  options?: {
    authScope?: 'session' | 'user';
    sessionPrincipal?: string;
  },
): TokenLookupFunctions {
  return {
    hasSessionToken: async (requirement: AuthRequirementIR): Promise<boolean> => {
      if (
        !tenantId ||
        !projectId ||
        options?.authScope !== 'session' ||
        !options.sessionPrincipal
      ) {
        return false;
      }

      const resolvedAuthProfileRef = await resolvePreflightAuthProfileRef({
        tenantId,
        projectId,
        authProfileRef: requirement.auth_profile_ref,
        variableNamespaceIds: requirement.variable_namespace_ids,
      });
      if (!resolvedAuthProfileRef) {
        return false;
      }

      try {
        return await hasAuthProfileToken({
          tenantId,
          projectId,
          environment,
          authProfileRef: resolvedAuthProfileRef,
          userId: options.sessionPrincipal,
          scope: 'session',
          requiredScopes: requirement.scopes,
        });
      } catch (err) {
        log.warn('Session token lookup failed', {
          authProfileRef: requirement.auth_profile_ref,
          sessionPrincipal: options.sessionPrincipal,
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    hasUserToken: async (requirement: AuthRequirementIR, userId: string): Promise<boolean> => {
      if (options?.authScope === 'session') {
        return false;
      }

      const resolvedAuthProfileRef = await resolvePreflightAuthProfileRef({
        tenantId,
        projectId,
        authProfileRef: requirement.auth_profile_ref,
        variableNamespaceIds: requirement.variable_namespace_ids,
      });
      if (!resolvedAuthProfileRef) {
        return false;
      }

      if (!tenantId) {
        return false;
      }

      try {
        return await hasAuthProfileToken({
          tenantId,
          projectId,
          environment,
          authProfileRef: resolvedAuthProfileRef,
          userId,
          scope: 'user',
          requiredScopes: requirement.scopes,
        });
      } catch (err) {
        log.warn('User token lookup failed', {
          authProfileRef: requirement.auth_profile_ref,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    hasTenantToken: async (requirement: AuthRequirementIR, tid: string): Promise<boolean> => {
      const resolvedAuthProfileRef = await resolvePreflightAuthProfileRef({
        tenantId: tid,
        projectId,
        authProfileRef: requirement.auth_profile_ref,
        variableNamespaceIds: requirement.variable_namespace_ids,
      });
      if (!resolvedAuthProfileRef) {
        return false;
      }

      try {
        return await hasAuthProfileToken({
          tenantId: tid,
          projectId,
          environment,
          authProfileRef: resolvedAuthProfileRef,
          scope: 'tenant',
          requiredScopes: requirement.scopes,
        });
      } catch (err) {
        log.warn('Tenant token lookup failed', {
          authProfileRef: requirement.auth_profile_ref,
          tenantId: tid,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}
