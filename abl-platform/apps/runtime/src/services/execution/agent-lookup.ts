/**
 * Session-scoped agent lookup.
 *
 * Every call site that needs to resolve an agent name to its compiled IR
 * MUST go through `lookupAgentForSession`. Direct reads of
 * `ctx.agentRegistry[name]` are unsafe — they bypass project + version
 * isolation and can leak IR across tenants or versions.
 *
 * Lookup order:
 *   1. AgentRegistryStore keyed on (session.tenantId, session.projectId, name, rawVersion)
 *   2. Remote agent declared inline in the active agent's HANDOFF config.
 *      Synthesized on the fly — remote agents are NEVER stored in the
 *      registry because their identity lives on the remote endpoint, not
 *      in this process. Synthesizing per-call also guarantees cross-project
 *      isolation: a remote URL on project A's HANDOFF cannot be resolved
 *      from a session on project B.
 *   3. Per-session `_sessionAgentRegistry` rebuilt from the session's own
 *      compilation output / persisted registry. This keeps legacy sessions
 *      fail-closed even when they predate `rawVersions`.
 *   4. Legacy flat `agentRegistry[name]` — compatibility fallback only,
 *      used by test harnesses and dev paths that register without a
 *      project context. Project-scoped sessions do NOT fall through here,
 *      because doing so would re-open cross-project / cross-version leaks.
 */
import type { HandoffConfig } from '@abl/compiler';
import type { AgentRegistryEntry, ExecutorContext, RuntimeSession } from './types.js';
import { getActiveThread } from './types.js';
import { resolveRawVersionAlias } from './agent-version-utils.js';

/**
 * Resolve an agent name to its registry entry using the session's
 * (projectId, version) scope. Returns `undefined` when neither the store,
 * the active agent's HANDOFF config, the session's own compatibility
 * registry, nor the legacy flat registry declares the target.
 */
export function lookupAgentForSession(
  ctx: ExecutorContext,
  session: RuntimeSession | undefined,
  agentName: string,
): AgentRegistryEntry | undefined {
  if (!agentName) return undefined;

  const projectId = session?.projectId;
  const tenantId = session?.tenantId;
  const rawVersions = session?.versionInfo?.rawVersions;
  // rawVersions is keyed by manifest names (e.g. "contract_data_assistant") but
  // handoff lookups use IR-declared names (e.g. "Contract_Data_Assistant").
  // Try the exact name first, then a case-insensitive match.
  const rawVersion = resolveRawVersionAlias(rawVersions, agentName);

  if (projectId && rawVersion) {
    const hit = ctx.agentRegistryStore.lookup(
      tenantId ? { tenantId, projectId } : projectId,
      agentName,
      rawVersion,
    );
    if (hit) return hit;
  }

  // Remote agents declared inline in the active agent's HANDOFF config are
  // synthesized per-call. They never land in any registry. Resolve them
  // before the legacy fallback so a session-scoped remote declaration cannot
  // be shadowed by a same-named flat-registry entry from another project.
  if (session) {
    const remote = resolveRemoteFromHandoff(session, agentName);
    if (remote) return remote;
  }

  const sessionScoped = session?._sessionAgentRegistry?.[agentName];
  if (sessionScoped) return sessionScoped;

  if (session?.projectId) {
    return undefined;
  }

  const legacy = ctx.agentRegistry[agentName];
  if (legacy) return legacy;

  return undefined;
}

/** Whether an agent is known for the given session. */
export function hasAgentForSession(
  ctx: ExecutorContext,
  session: RuntimeSession | undefined,
  agentName: string,
): boolean {
  return lookupAgentForSession(ctx, session, agentName) !== undefined;
}

/**
 * Synthesize a remote `AgentRegistryEntry` from the active agent's HANDOFF
 * config, or return undefined if no remote handoff to this target exists.
 * The returned entry is transient — callers MUST NOT cache it, because the
 * backing HANDOFF config is per-session and can change across deployments.
 */
export function resolveRemoteFromHandoff(
  session: RuntimeSession,
  targetAgent: string,
): AgentRegistryEntry | undefined {
  const handoffConfig = findActiveHandoffConfig(session, targetAgent);
  const remote = handoffConfig?.remote;
  if (!remote || remote.location !== 'remote') {
    return undefined;
  }
  // endpoint may be absent when the agent is registry-backed (LOCATION: REMOTE without ENDPOINT:).
  // Return an entry with empty endpoint so enrichWithRegistryAuth() can populate it from the
  // External Agent Registry. If the registry also has no entry the empty endpoint will surface
  // as a clear downstream failure rather than a silent "Agent not found".
  return {
    dsl: '',
    ir: null,
    location: 'remote',
    remote: {
      endpoint: typeof remote.endpoint === 'string' ? remote.endpoint : '',
      protocol: remote.protocol ?? 'a2a',
      auth: remote.auth
        ? {
            type: remote.auth.type,
            header: remote.auth.header,
          }
        : undefined,
      timeout: remote.timeout ? parseTimeoutString(remote.timeout) : undefined,
    },
  };
}

function findActiveHandoffConfig(
  session: RuntimeSession,
  targetAgent: string,
): HandoffConfig | undefined {
  // A partially populated session (e.g. in unit tests or during early
  // bootstrap) may have no threads yet — `getActiveThread` would then index
  // into an undefined array. Read defensively so registry lookup never blows
  // up on such sessions, and fall back to the session's top-level agentIR.
  const activeThread =
    Array.isArray(session.threads) && session.activeThreadIndex != null
      ? getActiveThread(session)
      : undefined;
  const ir = activeThread?.agentIR || session.agentIR;
  return ir?.coordination?.handoffs?.find((h: HandoffConfig) => h.to === targetAgent);
}

/** Minimal timeout parser for ABL durations like "30s", "5m", or "1500". */

function parseTimeoutString(raw: string | number | undefined): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? 'ms').toLowerCase();
  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return undefined;
  }
}
