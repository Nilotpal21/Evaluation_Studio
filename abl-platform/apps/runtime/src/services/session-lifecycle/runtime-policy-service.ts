import { createLogger } from '@abl/compiler/platform';
import type {
  AgentSessionLifecycleConfig,
  CanonicalSessionDisposition,
  Channel,
  ProjectSessionLifecycleConfig,
  SessionDisconnectBehavior,
  SessionEndHookConfig,
} from '@abl/compiler/platform/core/types';
import { CHANNEL_TTL_DEFAULTS, type TransferChannel } from '@agent-platform/agent-transfer';
import { getConfig, isConfigLoaded } from '../../config/loader.js';
import { findProjectSettings } from '../../repos/project-settings-repo.js';
import { findProjectAgentForProject } from '../../repos/project-repo.js';
import { getTenantConfigService } from '../tenant-config.js';
import { SessionLifecyclePolicyService } from './policy-service.js';

const log = createLogger('session-runtime-policy-service');
const TRANSFER_TTL_FALLBACK_SOURCE = 'legacy.default';

interface RuntimePolicySettingsDocument {
  sessionLifecycle?: ProjectSessionLifecycleConfig | null;
  agentTransfer?: {
    session?: {
      ttl?: Partial<Record<TransferChannel, number>>;
    };
  } | null;
}

export interface ResolveRuntimeSessionTimeoutsInput {
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  agentLifecycle?: AgentSessionLifecycleConfig;
}

export interface ResolveRuntimeSessionTimeoutsResult {
  sessionIdleSeconds?: number;
  sessionMaxAgeSeconds?: number;
  sources: {
    idleSeconds?: string;
    maxAgeSeconds?: string;
  };
  agentFound?: boolean;
}

export interface ResolveAgentLifecycleOverrideResult {
  found: boolean;
  lifecycle?: AgentSessionLifecycleConfig;
}

export interface ResolveDisconnectPolicyInput {
  channel?: Channel;
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  agentLifecycle?: AgentSessionLifecycleConfig;
}

export interface ResolveDisconnectPolicyResult {
  disposition?: CanonicalSessionDisposition;
  disconnectBehavior?: SessionDisconnectBehavior;
  sources: {
    disposition?: string;
    disconnectBehavior?: string;
  };
  agentFound?: boolean;
}

export interface ResolveEndHookPolicyInput {
  channel?: Channel;
  tenantId?: string;
  projectId?: string;
}

export interface ResolveEndHookPolicyResult {
  config?: SessionEndHookConfig;
  source?: string;
}

export interface ResolveTransferSessionTtlInput {
  channel: TransferChannel;
  tenantId?: string;
  projectId?: string;
}

export interface ResolveTransferSessionTtlResult {
  ttlSeconds: number;
  source: string;
}

interface RuntimePolicyServiceDeps {
  findProjectSettings?: (
    projectId: string,
    tenantId: string,
  ) => Promise<RuntimePolicySettingsDocument | null>;
  getTenantConfigAsync?: (tenantId: string) => Promise<{
    security: {
      sessionIdleSeconds: number;
      sessionMaxAgeSeconds: number;
    };
  }>;
  findProjectAgentForProject?: (
    projectId: string,
    agentName: string,
    tenantId: string,
  ) => Promise<{ dslContent?: string | null } | null>;
  parseAgentDsl?: (
    dslContent: string,
    agentName: string,
  ) => Promise<AgentSessionLifecycleConfig | undefined>;
  getChannelLifecycle?: (channel: Channel) =>
    | {
        defaultDisposition?: CanonicalSessionDisposition;
        disconnectBehavior?: SessionDisconnectBehavior;
      }
    | undefined;
  getLegacyTransferTtl?: (channel: TransferChannel) => number;
}

async function parseAgentLifecycleFromDsl(
  dslContent: string,
  agentName: string,
): Promise<AgentSessionLifecycleConfig | undefined> {
  const [{ parseAgentBasedABL }, { compileABLtoIR }] = await Promise.all([
    import('@abl/core'),
    import('@abl/compiler'),
  ]);
  const parseResult = parseAgentBasedABL(dslContent);

  if (!parseResult.document) {
    log.warn('Agent lifecycle override unavailable because DSL parsing failed', {
      agentName,
      errorCount: parseResult.errors?.length ?? 0,
    });
    return undefined;
  }

  const output = compileABLtoIR([parseResult.document]);
  const compiledAgent = output.agents[agentName] ?? Object.values(output.agents)[0];
  return compiledAgent?.execution?.sessionLifecycle;
}

export class SessionRuntimePolicyService {
  private readonly policyService = new SessionLifecyclePolicyService();

  private readonly deps: Required<RuntimePolicyServiceDeps>;

  constructor(deps: RuntimePolicyServiceDeps = {}) {
    this.deps = {
      findProjectSettings: deps.findProjectSettings ?? findProjectSettings,
      getTenantConfigAsync:
        deps.getTenantConfigAsync ??
        ((tenantId) => getTenantConfigService().getConfigAsync(tenantId)),
      findProjectAgentForProject: deps.findProjectAgentForProject ?? findProjectAgentForProject,
      parseAgentDsl: deps.parseAgentDsl ?? parseAgentLifecycleFromDsl,
      getChannelLifecycle:
        deps.getChannelLifecycle ??
        ((channel) => {
          if (!isConfigLoaded()) {
            return undefined;
          }

          const channelLifecycle = getConfig().channelLifecycle as Partial<
            Record<
              Channel,
              {
                defaultDisposition?: CanonicalSessionDisposition;
                disconnectBehavior?: SessionDisconnectBehavior;
              }
            >
          >;

          return channelLifecycle[channel];
        }),
      getLegacyTransferTtl:
        deps.getLegacyTransferTtl ??
        ((channel) => CHANNEL_TTL_DEFAULTS[channel] ?? CHANNEL_TTL_DEFAULTS.default),
    };
  }

  async resolveAgentLifecycleOverride(
    tenantId: string,
    projectId: string,
    agentName: string,
  ): Promise<ResolveAgentLifecycleOverrideResult> {
    const agent = await this.deps.findProjectAgentForProject(projectId, agentName, tenantId);

    if (!agent) {
      return { found: false };
    }

    if (!agent.dslContent) {
      return { found: true };
    }

    try {
      return {
        found: true,
        lifecycle: await this.deps.parseAgentDsl(agent.dslContent, agentName),
      };
    } catch (error) {
      log.warn('Agent lifecycle override unavailable because compilation failed', {
        tenantId,
        projectId,
        agentName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { found: true };
    }
  }

  async resolveRuntimeSessionTimeouts(
    input: ResolveRuntimeSessionTimeoutsInput,
  ): Promise<ResolveRuntimeSessionTimeoutsResult> {
    if (!input.tenantId) {
      return {
        sources: {},
      };
    }

    try {
      const tenantConfig = await this.deps.getTenantConfigAsync(input.tenantId);
      const projectSettings =
        input.projectId !== undefined
          ? await this.deps.findProjectSettings(input.projectId, input.tenantId)
          : null;

      let agentOverride = input.agentLifecycle;
      let agentFound: boolean | undefined;

      if (!agentOverride && input.projectId && input.agentName) {
        const resolvedAgent = await this.resolveAgentLifecycleOverride(
          input.tenantId,
          input.projectId,
          input.agentName,
        );
        agentFound = resolvedAgent.found;
        agentOverride = resolvedAgent.lifecycle;
      }

      const resolved = this.policyService.resolve({
        tenant: {
          runtime: {
            idleSeconds: tenantConfig.security.sessionIdleSeconds,
            maxAgeSeconds: tenantConfig.security.sessionMaxAgeSeconds,
          },
        },
        project: projectSettings?.sessionLifecycle ?? null,
        agent: agentOverride,
      });

      return {
        sessionIdleSeconds: resolved.runtime.idleSeconds.value,
        sessionMaxAgeSeconds: resolved.runtime.maxAgeSeconds.value,
        sources: {
          idleSeconds: resolved.runtime.idleSeconds.source,
          maxAgeSeconds: resolved.runtime.maxAgeSeconds.source,
        },
        ...(agentFound !== undefined ? { agentFound } : {}),
      };
    } catch (error) {
      log.warn('Failed to resolve runtime session timeouts, using existing defaults', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentName: input.agentName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sources: {},
      };
    }
  }

  async resolveDisconnectPolicy(
    input: ResolveDisconnectPolicyInput,
  ): Promise<ResolveDisconnectPolicyResult> {
    if (!input.channel) {
      return {
        sources: {},
      };
    }

    try {
      const projectSettings =
        input.tenantId && input.projectId
          ? await this.deps.findProjectSettings(input.projectId, input.tenantId)
          : null;

      let agentOverride = input.agentLifecycle;
      let agentFound: boolean | undefined;

      if (!agentOverride && input.tenantId && input.projectId && input.agentName) {
        const resolvedAgent = await this.resolveAgentLifecycleOverride(
          input.tenantId,
          input.projectId,
          input.agentName,
        );
        agentFound = resolvedAgent.found;
        agentOverride = resolvedAgent.lifecycle;
      }

      const tenantDisconnect = this.deps.getChannelLifecycle(input.channel);
      const resolved = this.policyService.resolve({
        channel: input.channel,
        ...(tenantDisconnect
          ? {
              tenant: {
                disconnect: {
                  defaultDisposition: tenantDisconnect.defaultDisposition,
                  disconnectBehavior: tenantDisconnect.disconnectBehavior,
                },
              },
            }
          : {}),
        project: projectSettings?.sessionLifecycle ?? null,
        agent: agentOverride,
      });

      return {
        disposition: resolved.disconnect.defaultDisposition.value,
        disconnectBehavior: resolved.disconnect.disconnectBehavior.value,
        sources: {
          disposition: resolved.disconnect.defaultDisposition.source,
          disconnectBehavior: resolved.disconnect.disconnectBehavior.source,
        },
        ...(agentFound !== undefined ? { agentFound } : {}),
      };
    } catch (error) {
      log.warn('Failed to resolve disconnect lifecycle, using existing defaults', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        channel: input.channel,
        agentName: input.agentName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sources: {},
      };
    }
  }

  async resolveEndHookPolicy(
    input: ResolveEndHookPolicyInput,
  ): Promise<ResolveEndHookPolicyResult> {
    if (!input.tenantId || !input.projectId) {
      return {};
    }

    try {
      const projectSettings = await this.deps.findProjectSettings(input.projectId, input.tenantId);
      const resolved = this.policyService.resolve({
        channel: input.channel,
        project: projectSettings?.sessionLifecycle ?? null,
      });

      return {
        config: resolved.endHook.config,
        source: resolved.endHook.source,
      };
    } catch (error) {
      log.warn('Failed to resolve end-hook lifecycle, using default ignore behavior', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        channel: input.channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  async resolveTransferSessionTtl(
    input: ResolveTransferSessionTtlInput,
  ): Promise<ResolveTransferSessionTtlResult> {
    const fallback = {
      ttlSeconds: this.deps.getLegacyTransferTtl(input.channel),
      source: TRANSFER_TTL_FALLBACK_SOURCE,
    };

    if (!input.tenantId || !input.projectId) {
      return fallback;
    }

    try {
      const projectSettings = await this.deps.findProjectSettings(input.projectId, input.tenantId);
      const ttl = projectSettings?.agentTransfer?.session?.ttl?.[input.channel];

      if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
        return {
          ttlSeconds: ttl,
          source: `project.agentTransfer.ttl.${input.channel}`,
        };
      }

      return fallback;
    } catch (error) {
      log.warn('Failed to resolve transfer-session TTL, using legacy default', {
        tenantId: input.tenantId,
        projectId: input.projectId,
        channel: input.channel,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }
}
