import type { PipelinePolicy } from '@abl/compiler';
import type { RuntimeSession } from './types.js';
import type { StreamingSettings } from '../guardrails/policy-resolver.js';
import { resolveGuardrailPolicy } from '../guardrails/pipeline-factory.js';
import { getGuardrailPolicyEpoch } from '../guardrails/policy-epoch.js';

function getActiveAgentIR(session: RuntimeSession): RuntimeSession['agentIR'] {
  const activeThread = session.threads?.[session.activeThreadIndex];
  return activeThread?.agentIR ?? session.agentIR;
}

function getActiveAgentName(session: RuntimeSession): string {
  const activeThread = session.threads?.[session.activeThreadIndex];
  const activeAgentIR = getActiveAgentIR(session);
  return activeThread?.agentName ?? activeAgentIR?.metadata?.name ?? session.agentName ?? 'unknown';
}

/**
 * Build the exact-match cache scope for guardrail evaluation.
 *
 * The scope intentionally includes both an agent identity and a compiled IR/config
 * identity so same-named guardrails in the same project cannot replay outcomes
 * across agents or stale DSL revisions.
 */
export function getSessionGuardrailCacheScopeKey(session: RuntimeSession): string {
  const activeThread = session.threads?.[session.activeThreadIndex];
  const activeAgentIR = activeThread?.agentIR ?? session.agentIR;
  const agentName =
    activeThread?.agentName ??
    activeAgentIR?.metadata?.name ??
    session.agentName ??
    'unknown-agent';
  const rawVersion = session.versionInfo?.rawVersions?.[agentName];
  const numericVersion = session.versionInfo?.versions?.[agentName];
  const version =
    rawVersion ?? (numericVersion !== undefined ? String(numericVersion) : undefined) ?? 'live';
  const irHash =
    activeThread?._cachedIRHash ?? session._cachedIRHash ?? session.configHash ?? 'unhashed';

  return `${agentName}:${version}:${irHash}`;
}

/**
 * Lazily resolve and cache guardrail policy on the session.
 * Returns undefined if no policies are configured or DB is unavailable.
 *
 * Cache semantics:
 *   _guardrailPolicy === undefined → not yet resolved (will query DB)
 *   _guardrailPolicy === null      → resolved, no policy found (won't re-query)
 *   _guardrailPolicy === <policy>  → resolved with a policy
 */
export async function getSessionPolicy(
  session: RuntimeSession,
): Promise<PipelinePolicy | undefined> {
  const activeAgentIR = getActiveAgentIR(session);
  if (!session.tenantId || !session.projectId || !activeAgentIR) return undefined;

  const currentEpoch = await getGuardrailPolicyEpoch(session.tenantId, session.projectId);
  const policyScopeKey = getSessionGuardrailCacheScopeKey(session);
  if (
    session._guardrailPolicy !== undefined &&
    session._guardrailPolicyEpoch === currentEpoch &&
    session._guardrailPolicyScopeKey === policyScopeKey
  ) {
    return session._guardrailPolicy ?? undefined; // null → undefined for callers
  }

  const guardrails = activeAgentIR.constraints?.guardrails ?? [];
  // Always call resolver — DB policies may define guardrails even when DSL has none

  const result = await resolveGuardrailPolicy(
    session.tenantId,
    session.projectId,
    getActiveAgentName(session),
    guardrails,
  );
  session._guardrailPolicy = result?.policy ?? null; // store null instead of undefined
  session._streamingConfig = result?.streamingConfig ?? null;
  session._guardrailPolicyEpoch = currentEpoch;
  session._guardrailPolicyScopeKey = policyScopeKey;
  return result?.policy;
}

/**
 * Get cached streaming guardrail config from the session.
 * Must call getSessionPolicy first to trigger resolution.
 */
export function getSessionStreamingConfig(session: RuntimeSession): StreamingSettings | undefined {
  return session._streamingConfig ?? undefined;
}

/**
 * Convert DB streaming settings to the StreamingEvalConfig used by
 * StreamingGuardrailEvaluator. Returns undefined if streaming is not
 * enabled or no config is available.
 */
export function toStreamingEvalConfig(settings: StreamingSettings | undefined):
  | {
      interval: 'token' | 'sentence' | 'chunk';
      chunkSize?: number;
      maxLatencyMs?: number;
      earlyTermination?: boolean;
    }
  | undefined {
  if (!settings?.enabled) return undefined;
  return {
    interval:
      settings.defaultInterval === 'chunk_size'
        ? 'chunk'
        : (settings.defaultInterval ?? 'sentence'),
    chunkSize: settings.chunkSize,
    maxLatencyMs: settings.maxLatencyMs,
    earlyTermination: settings.earlyTermination,
  };
}
