import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { AgentRegistry, AgentRegistryEntry, RuntimeSession } from './types.js';
import { resolveVersionString } from './agent-version-utils.js';

interface CompilationOutputLike {
  agents: Record<string, AgentIR>;
  entry_agent?: string;
  remote_agents?: CompilationOutput['remote_agents'];
  deployment?: CompilationOutput['deployment'];
}

function isCompilationOutputLike(value: unknown): value is CompilationOutputLike {
  return (
    typeof value === 'object' && value !== null && 'agents' in value && !('execution' in value)
  );
}

function isCompilationOutputRoot(value: unknown): value is CompilationOutputLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'agents' in value &&
    'deployment' in value &&
    !('execution' in value)
  );
}

function buildLocalEntry(ir: AgentIR, version: string | undefined): AgentRegistryEntry {
  return {
    dsl: '',
    ir,
    location: 'local',
    version,
  };
}

function registerAliases(
  registry: AgentRegistry,
  registrationName: string,
  ir: AgentIR,
  versionInfo: RuntimeSession['versionInfo'] | undefined,
  versionKey: string,
): void {
  const version =
    resolveVersionString(versionInfo, versionKey) ??
    resolveVersionString(versionInfo, registrationName) ??
    resolveVersionString(versionInfo, ir.metadata?.name ?? '');
  const entry = buildLocalEntry(ir, version);

  registry[registrationName] = entry;

  const irName = ir.metadata?.name;
  if (irName && irName !== registrationName) {
    registry[irName] = entry;
  }
}

function parseRemoteTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(raw.trim());
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;

  switch ((match[2] ?? 'ms').toLowerCase()) {
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

function registerRemoteAliases(
  registry: AgentRegistry,
  remoteAgents: CompilationOutput['remote_agents'],
): void {
  if (!remoteAgents) return;

  for (const [name, remote] of Object.entries(remoteAgents)) {
    if (!remote || remote.location !== 'remote' || typeof remote.endpoint !== 'string') {
      continue;
    }

    registry[name] = {
      dsl: '',
      ir: null,
      location: 'remote',
      remote: {
        endpoint: remote.endpoint,
        protocol: remote.protocol ?? 'a2a',
        auth: remote.auth
          ? {
              type: remote.auth.type,
              header: remote.auth.header,
            }
          : undefined,
        timeout: parseRemoteTimeout(remote.timeout),
      },
    };
  }
}

export function buildSessionScopedAgentRegistry(
  agentsOrCompilation:
    | CompilationOutputLike
    | Record<string, AgentIR | CompilationOutputLike>
    | null
    | undefined,
  versionInfo?: RuntimeSession['versionInfo'],
): AgentRegistry {
  const registry: AgentRegistry = {};

  if (!agentsOrCompilation) {
    return registry;
  }

  if (isCompilationOutputRoot(agentsOrCompilation)) {
    for (const [name, candidate] of Object.entries(agentsOrCompilation.agents)) {
      registerAliases(registry, name, candidate, versionInfo, name);
    }
    registerRemoteAliases(registry, agentsOrCompilation.remote_agents);
    return registry;
  }

  for (const [name, candidate] of Object.entries(agentsOrCompilation)) {
    if (isCompilationOutputLike(candidate)) {
      for (const [innerName, innerIR] of Object.entries(candidate.agents)) {
        registerAliases(registry, innerName, innerIR, versionInfo, name);
      }
      registerRemoteAliases(registry, candidate.remote_agents);
      continue;
    }

    registerAliases(registry, name, candidate, versionInfo, name);
  }

  return registry;
}
