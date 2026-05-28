import { z } from 'zod';
import type {
  AgentSessionLifecycleConfig,
  CanonicalSessionDisposition,
  Channel,
  ProjectSessionLifecycleConfig,
  SessionDisconnectBehavior,
  SessionDisconnectConfig,
  SessionEndHookConfig,
  SessionLifecycleRuntimeConfig,
} from '@abl/compiler/platform/core/types';

export type SessionLifecyclePolicySource =
  | 'tenant'
  | 'project'
  | `project.channel.${string}`
  | 'agent'
  | 'explicit';

export interface SessionLifecycleBasePolicy {
  runtime?: SessionLifecycleRuntimeConfig;
  disconnect?: SessionDisconnectConfig;
  endHook?: SessionEndHookConfig;
}

export interface SessionLifecycleExplicitOverrides {
  runtime?: SessionLifecycleRuntimeConfig;
  disconnect?: SessionDisconnectConfig;
}

export interface ResolveSessionLifecyclePolicyInput {
  channel?: Channel;
  tenant?: SessionLifecycleBasePolicy;
  project?: ProjectSessionLifecycleConfig | null;
  agent?: AgentSessionLifecycleConfig;
  explicit?: SessionLifecycleExplicitOverrides;
}

export interface ResolvedSessionLifecycleField<T> {
  value?: T;
  source?: SessionLifecyclePolicySource;
}

export interface ResolvedSessionLifecyclePolicy {
  runtime: {
    idleSeconds: ResolvedSessionLifecycleField<number>;
    maxAgeSeconds: ResolvedSessionLifecycleField<number>;
  };
  disconnect: {
    defaultDisposition: ResolvedSessionLifecycleField<CanonicalSessionDisposition>;
    disconnectBehavior: ResolvedSessionLifecycleField<SessionDisconnectBehavior>;
  };
  endHook: {
    config?: SessionEndHookConfig;
    source?: SessionLifecyclePolicySource;
  };
}

export const sessionEndHookConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('ignore'),
  }),
  z.object({
    mode: z.literal('respond'),
    message: z.string().min(1),
  }),
]);

function resolveField<T>(
  candidates: Array<{ value: T | undefined; source: SessionLifecyclePolicySource }>,
): ResolvedSessionLifecycleField<T> {
  let resolved: ResolvedSessionLifecycleField<T> = {};

  for (const candidate of candidates) {
    if (candidate.value !== undefined) {
      resolved = {
        value: candidate.value,
        source: candidate.source,
      };
    }
  }

  return resolved;
}

function getProjectChannelSource(channel?: Channel): SessionLifecyclePolicySource | undefined {
  if (!channel) {
    return undefined;
  }

  return `project.channel.${channel}`;
}

function getProjectChannelConfig(
  project: ProjectSessionLifecycleConfig | null | undefined,
  channel?: Channel,
) {
  if (!project?.channels || !channel) {
    return undefined;
  }

  return project.channels[channel];
}

export function validateSessionEndHookConfig(config: unknown) {
  return sessionEndHookConfigSchema.safeParse(config);
}

export function resolveSessionLifecyclePolicy(
  input: ResolveSessionLifecyclePolicyInput,
): ResolvedSessionLifecyclePolicy {
  const projectChannelConfig = getProjectChannelConfig(input.project, input.channel);
  const projectChannelSource = getProjectChannelSource(input.channel);

  const runtime = {
    idleSeconds: resolveField<number>([
      { value: input.tenant?.runtime?.idleSeconds, source: 'tenant' },
      { value: input.project?.runtime?.idleSeconds, source: 'project' },
      { value: input.agent?.idleSeconds, source: 'agent' },
      { value: input.explicit?.runtime?.idleSeconds, source: 'explicit' },
    ]),
    maxAgeSeconds: resolveField<number>([
      { value: input.tenant?.runtime?.maxAgeSeconds, source: 'tenant' },
      { value: input.project?.runtime?.maxAgeSeconds, source: 'project' },
      { value: input.agent?.maxAgeSeconds, source: 'agent' },
      { value: input.explicit?.runtime?.maxAgeSeconds, source: 'explicit' },
    ]),
  };

  const disconnect = {
    defaultDisposition: resolveField<CanonicalSessionDisposition>([
      { value: input.tenant?.disconnect?.defaultDisposition, source: 'tenant' },
      {
        value: projectChannelConfig?.defaultDisposition,
        source: projectChannelSource ?? 'project',
      },
      { value: input.agent?.disconnect?.defaultDisposition, source: 'agent' },
      { value: input.explicit?.disconnect?.defaultDisposition, source: 'explicit' },
    ]),
    disconnectBehavior: resolveField<SessionDisconnectBehavior>([
      { value: input.tenant?.disconnect?.disconnectBehavior, source: 'tenant' },
      {
        value: projectChannelConfig?.disconnectBehavior,
        source: projectChannelSource ?? 'project',
      },
      { value: input.agent?.disconnect?.disconnectBehavior, source: 'agent' },
      { value: input.explicit?.disconnect?.disconnectBehavior, source: 'explicit' },
    ]),
  };

  const endHook =
    projectChannelConfig?.endHook !== undefined
      ? {
          config: projectChannelConfig.endHook,
          source: projectChannelSource,
        }
      : input.project?.endHook !== undefined
        ? {
            config: input.project.endHook,
            source: 'project' as const,
          }
        : {
            config: undefined,
            source: undefined,
          };

  return {
    runtime,
    disconnect,
    endHook,
  };
}

export class SessionLifecyclePolicyService {
  resolve(input: ResolveSessionLifecyclePolicyInput): ResolvedSessionLifecyclePolicy {
    return resolveSessionLifecyclePolicy(input);
  }

  validateEndHookConfig(config: unknown) {
    return validateSessionEndHookConfig(config);
  }
}
