import { type Request, type Response, type Router as RouterType } from 'express';
import { createOpenAPIRouter } from '@agent-platform/openapi/express';
import { runtimeRegistry } from '../openapi/registry.js';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { CHANNEL_TTL_DEFAULTS } from '@agent-platform/agent-transfer';
import type {
  AgentSessionLifecycleConfig,
  Channel,
  ProjectSessionLifecycleConfig,
  SessionEndHookConfig,
} from '@abl/compiler/platform/core/types';
import {
  findProjectSettings,
  type ProjectTransferTtlChannel,
  upsertProjectSessionLifecycle,
} from '../repos/project-settings-repo.js';
import { findProjectAgentForProject } from '../repos/project-repo.js';
import { getTenantConfigService } from '../services/tenant-config.js';
import { getConfig } from '../config/index.js';
import { SessionLifecyclePolicyService } from '../services/session-lifecycle/policy-service.js';

const log = createLogger('project-session-lifecycle');

const CHANNEL_VALUES = [
  'voice',
  'web_chat',
  'web_debug',
  'whatsapp',
  'sms',
  'email',
  'api',
  'http_async',
] as const;
const DISPOSITION_VALUES = [
  'completed',
  'abandoned',
  'agent_hangup',
  'transferred',
  'failed',
  'timeout',
  'unengaged',
] as const;
const DISCONNECT_BEHAVIOR_VALUES = ['end', 'detach'] as const;
const END_HOOK_MODE_VALUES = ['ignore', 'respond'] as const;
const TRANSFER_TTL_CHANNELS = ['chat', 'email', 'voice', 'messaging', 'campaign'] as const;

type TransferTtlChannel = (typeof TRANSFER_TTL_CHANNELS)[number];

interface ProjectLifecycleSettingsDocument {
  sessionLifecycle?: ProjectSessionLifecycleConfig | null;
  agentTransfer?: {
    session?: {
      ttl?: Partial<Record<TransferTtlChannel, number>>;
    };
  } | null;
}

const openapi = createOpenAPIRouter(runtimeRegistry, {
  basePath: '/api/projects/:projectId/session-lifecycle',
  tags: ['Project Session Lifecycle'],
});
const router: RouterType = openapi.router;
const policyService = new SessionLifecyclePolicyService();

router.use(authMiddleware);
router.use(requireProjectScope('projectId', { concealOutOfScope: true }));
router.use(tenantRateLimit('request'));

const endHookConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('ignore'),
  }),
  z.object({
    mode: z.literal('respond'),
    message: z.string().min(1),
  }),
]);

const channelSettingsSchema = z.object({
  defaultDisposition: z.enum(DISPOSITION_VALUES).optional(),
  disconnectBehavior: z.enum(DISCONNECT_BEHAVIOR_VALUES).optional(),
  endHook: endHookConfigSchema.optional(),
});

const transferTtlSchema = z.object({
  chat: z.number().int().min(0).optional(),
  email: z.number().int().min(0).optional(),
  voice: z.number().int().min(0).optional(),
  messaging: z.number().int().min(0).optional(),
  campaign: z.number().int().min(0).optional(),
});

const lifecycleReadResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    runtime: z.object({
      idleSeconds: z.number().int().positive().optional(),
      maxAgeSeconds: z.number().int().positive().optional(),
    }),
    endHook: endHookConfigSchema,
    channels: z.record(z.string(), channelSettingsSchema),
    agentTransfer: z.object({
      ttl: transferTtlSchema,
    }),
  }),
});

const lifecycleWriteRequestSchema = z
  .object({
    runtime: z
      .object({
        idleSeconds: z.number().int().positive().optional(),
        maxAgeSeconds: z.number().int().positive().optional(),
      })
      .optional(),
    endHook: endHookConfigSchema.optional(),
    channels: z.record(z.string(), channelSettingsSchema).optional(),
    agentTransfer: z
      .object({
        ttl: transferTtlSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.channels) {
      return;
    }

    for (const key of Object.keys(value.channels)) {
      if (!CHANNEL_VALUES.includes(key as (typeof CHANNEL_VALUES)[number])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported lifecycle channel override: ${key}`,
          path: ['channels', key],
        });
      }
    }
  });

const effectiveQuerySchema = z.object({
  channel: z.enum(CHANNEL_VALUES).optional(),
  agentName: z.string().min(1).optional(),
});

const resolvedNumberFieldSchema = z.object({
  value: z.number().int().min(0).optional(),
  source: z.string().optional(),
});

const resolvedDispositionFieldSchema = z.object({
  value: z.enum(DISPOSITION_VALUES).optional(),
  source: z.string().optional(),
});

const resolvedDisconnectBehaviorFieldSchema = z.object({
  value: z.enum(DISCONNECT_BEHAVIOR_VALUES).optional(),
  source: z.string().optional(),
});

const resolvedEndHookModeFieldSchema = z.object({
  value: z.enum(END_HOOK_MODE_VALUES),
  source: z.string().optional(),
});

const effectiveLifecycleResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    runtime: z.object({
      idleSeconds: resolvedNumberFieldSchema,
      maxAgeSeconds: resolvedNumberFieldSchema,
    }),
    disconnect: z.object({
      defaultDisposition: resolvedDispositionFieldSchema,
      disconnectBehavior: resolvedDisconnectBehaviorFieldSchema,
    }),
    endHook: z.object({
      mode: resolvedEndHookModeFieldSchema,
      message: z.object({
        value: z.string().optional(),
        source: z.string().optional(),
      }),
    }),
    agentTransfer: z.object({
      ttl: z.object({
        chat: resolvedNumberFieldSchema,
        email: resolvedNumberFieldSchema,
        voice: resolvedNumberFieldSchema,
        messaging: resolvedNumberFieldSchema,
        campaign: resolvedNumberFieldSchema,
      }),
    }),
  }),
});

function getTransferTtlOverrides(
  settings: ProjectLifecycleSettingsDocument | null,
): Partial<Record<TransferTtlChannel, number>> {
  const ttl = settings?.agentTransfer?.session?.ttl;
  const normalized: Partial<Record<TransferTtlChannel, number>> = {};

  if (!ttl) {
    return normalized;
  }

  for (const channel of TRANSFER_TTL_CHANNELS) {
    const value = ttl[channel];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      normalized[channel] = value;
    }
  }

  return normalized;
}

function normalizeStoredLifecycle(
  settings: ProjectLifecycleSettingsDocument | null,
): z.infer<typeof lifecycleReadResponseSchema>['data'] {
  const sessionLifecycle = settings?.sessionLifecycle ?? null;

  return {
    runtime: {
      ...(sessionLifecycle?.runtime?.idleSeconds !== undefined
        ? { idleSeconds: sessionLifecycle.runtime.idleSeconds }
        : {}),
      ...(sessionLifecycle?.runtime?.maxAgeSeconds !== undefined
        ? { maxAgeSeconds: sessionLifecycle.runtime.maxAgeSeconds }
        : {}),
    },
    endHook: sessionLifecycle?.endHook ?? { mode: 'ignore' },
    channels: sessionLifecycle?.channels ?? {},
    agentTransfer: {
      ttl: getTransferTtlOverrides(settings),
    },
  };
}

function normalizeLifecycleWriteBody(
  input: z.infer<typeof lifecycleWriteRequestSchema>,
): ProjectSessionLifecycleConfig | null {
  const runtime =
    input.runtime?.idleSeconds !== undefined || input.runtime?.maxAgeSeconds !== undefined
      ? input.runtime
      : undefined;

  const normalizedChannels =
    input.channels !== undefined
      ? Object.fromEntries(
          Object.entries(input.channels).filter(([, value]) => {
            return (
              value.defaultDisposition !== undefined ||
              value.disconnectBehavior !== undefined ||
              value.endHook !== undefined
            );
          }),
        )
      : undefined;

  const normalized: ProjectSessionLifecycleConfig = {
    ...(runtime !== undefined ? { runtime } : {}),
    ...(input.endHook !== undefined ? { endHook: input.endHook } : {}),
    ...(normalizedChannels !== undefined && Object.keys(normalizedChannels).length > 0
      ? { channels: normalizedChannels as ProjectSessionLifecycleConfig['channels'] }
      : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeTransferTtlWriteBody(
  input: z.infer<typeof lifecycleWriteRequestSchema>,
): Partial<Record<ProjectTransferTtlChannel, number>> | undefined {
  if (input.agentTransfer === undefined) {
    return undefined;
  }

  const ttl = input.agentTransfer.ttl;
  if (!ttl) {
    return {};
  }

  const normalized: Partial<Record<ProjectTransferTtlChannel, number>> = {};

  for (const channel of TRANSFER_TTL_CHANNELS) {
    const value = ttl[channel];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      normalized[channel] = value;
    }
  }

  return normalized;
}

function mergeSessionLifecycle(
  current: ProjectSessionLifecycleConfig | null | undefined,
  patch: ProjectSessionLifecycleConfig | null,
): ProjectSessionLifecycleConfig | null {
  if (!patch) {
    return current ?? null;
  }

  const mergedChannels: NonNullable<ProjectSessionLifecycleConfig['channels']> = {
    ...(current?.channels ?? {}),
  };

  for (const [channel, channelPatch] of Object.entries(patch.channels ?? {})) {
    const existingChannel = mergedChannels[channel as Channel];
    mergedChannels[channel as Channel] = {
      ...(existingChannel ?? {}),
      ...(channelPatch ?? {}),
    };
  }

  const merged: ProjectSessionLifecycleConfig = {
    ...(current?.runtime !== undefined ? { runtime: current.runtime } : {}),
    ...(patch.runtime !== undefined ? { runtime: patch.runtime } : {}),
    ...(current?.endHook !== undefined ? { endHook: current.endHook } : {}),
    ...(patch.endHook !== undefined ? { endHook: patch.endHook } : {}),
    ...(Object.keys(mergedChannels).length > 0
      ? { channels: mergedChannels as ProjectSessionLifecycleConfig['channels'] }
      : {}),
  };

  return Object.keys(merged).length > 0 ? merged : null;
}

function mergeTransferTtlOverrides(
  current: Partial<Record<ProjectTransferTtlChannel, number>>,
  patch: Partial<Record<ProjectTransferTtlChannel, number>> | undefined,
): Partial<Record<ProjectTransferTtlChannel, number>> {
  if (patch === undefined) {
    return current;
  }

  if (Object.keys(patch).length === 0) {
    return {};
  }

  return {
    ...current,
    ...patch,
  };
}

function resolveTransferTtlInspection(settings: ProjectLifecycleSettingsDocument | null) {
  const overrides = getTransferTtlOverrides(settings);

  return {
    ttl: {
      chat:
        overrides.chat !== undefined
          ? { value: overrides.chat, source: 'project.agentTransfer.ttl.chat' }
          : { value: CHANNEL_TTL_DEFAULTS.chat, source: 'legacy.default' },
      email:
        overrides.email !== undefined
          ? { value: overrides.email, source: 'project.agentTransfer.ttl.email' }
          : { value: CHANNEL_TTL_DEFAULTS.email, source: 'legacy.default' },
      voice:
        overrides.voice !== undefined
          ? { value: overrides.voice, source: 'project.agentTransfer.ttl.voice' }
          : { value: CHANNEL_TTL_DEFAULTS.voice, source: 'legacy.default' },
      messaging:
        overrides.messaging !== undefined
          ? { value: overrides.messaging, source: 'project.agentTransfer.ttl.messaging' }
          : { value: CHANNEL_TTL_DEFAULTS.messaging, source: 'legacy.default' },
      campaign:
        overrides.campaign !== undefined
          ? { value: overrides.campaign, source: 'project.agentTransfer.ttl.campaign' }
          : { value: CHANNEL_TTL_DEFAULTS.campaign, source: 'legacy.default' },
    },
  };
}

async function resolveAgentLifecycleOverride(
  tenantId: string,
  projectId: string,
  agentName: string,
): Promise<{ found: boolean; lifecycle?: AgentSessionLifecycleConfig }> {
  const agent = await findProjectAgentForProject(projectId, agentName, tenantId);

  if (!agent) {
    return { found: false };
  }

  if (!agent.dslContent) {
    return { found: true };
  }

  try {
    const [{ parseAgentBasedABL }, { compileABLtoIR }] = await Promise.all([
      import('@abl/core'),
      import('@abl/compiler'),
    ]);
    const parseResult = parseAgentBasedABL(agent.dslContent);

    if (!parseResult.document) {
      log.warn('Agent lifecycle override unavailable because DSL parsing failed', {
        tenantId,
        projectId,
        agentName,
        errorCount: parseResult.errors?.length ?? 0,
      });
      return { found: true };
    }

    const output = compileABLtoIR([parseResult.document]);
    const compiledAgent = output.agents[agentName] ?? Object.values(output.agents)[0];

    return {
      found: true,
      lifecycle: compiledAgent?.execution?.sessionLifecycle,
    };
  } catch (error: unknown) {
    log.warn('Agent lifecycle override unavailable because compilation failed', {
      tenantId,
      projectId,
      agentName,
      error: error instanceof Error ? error.message : String(error),
    });
    return { found: true };
  }
}

async function handleLifecycleWrite(
  req: Request,
  res: Response,
  mode: 'merge' | 'replace',
): Promise<void> {
  try {
    if (!(await requireProjectPermission(req, res, 'runtime_config:write'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext?.tenantId;

    if (!tenantId) {
      res.status(403).json({
        success: false,
        error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
      });
      return;
    }

    const parsedBody = lifecycleWriteRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_BODY',
          message: 'Invalid project session lifecycle update payload',
        },
        issues: parsedBody.error.issues,
      });
      return;
    }

    const normalized = normalizeLifecycleWriteBody(parsedBody.data);
    const normalizedTransferTtl = normalizeTransferTtlWriteBody(parsedBody.data);
    const shouldWriteTransferTtl =
      mode === 'replace' || parsedBody.data.agentTransfer !== undefined;
    const existingSettings =
      mode === 'merge'
        ? ((await findProjectSettings(
            projectId,
            tenantId,
          )) as ProjectLifecycleSettingsDocument | null)
        : null;
    const nextLifecycle =
      mode === 'merge'
        ? mergeSessionLifecycle(existingSettings?.sessionLifecycle ?? null, normalized)
        : normalized;
    const nextTransferTtl = shouldWriteTransferTtl
      ? mode === 'merge'
        ? mergeTransferTtlOverrides(
            getTransferTtlOverrides(existingSettings),
            normalizedTransferTtl,
          )
        : (normalizedTransferTtl ?? {})
      : undefined;

    const updated = (await upsertProjectSessionLifecycle(
      projectId,
      tenantId,
      nextLifecycle,
      shouldWriteTransferTtl ? { transferTtl: nextTransferTtl } : undefined,
    )) as ProjectLifecycleSettingsDocument | null;

    log.info('Project session lifecycle settings updated', {
      projectId,
      tenantId,
      mode,
    });

    res.json({
      success: true,
      data: normalizeStoredLifecycle(updated),
    });
  } catch (error: unknown) {
    log.error('Failed to update project session lifecycle settings', {
      error: error instanceof Error ? error.message : String(error),
      mode,
    });
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update project session lifecycle settings',
      },
    });
  }
}

openapi.route(
  'patch',
  '/',
  {
    summary: 'Merge project session lifecycle settings',
    description:
      'Patch project session lifecycle settings with merge semantics, including runtime timeouts and end-hook overrides.',
    body: lifecycleWriteRequestSchema,
    response: lifecycleReadResponseSchema,
  },
  async (req, res) => handleLifecycleWrite(req, res, 'merge'),
);

openapi.route(
  'put',
  '/',
  {
    summary: 'Replace project session lifecycle settings',
    description:
      'Replace project session lifecycle settings, including runtime timeouts and end-hook overrides.',
    body: lifecycleWriteRequestSchema,
    response: lifecycleReadResponseSchema,
  },
  async (req, res) => handleLifecycleWrite(req, res, 'replace'),
);

openapi.route(
  'get',
  '/',
  {
    summary: 'Get project session lifecycle settings',
    description:
      'Fetch the saved project session lifecycle settings, including transfer TTL overrides.',
    response: lifecycleReadResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'runtime_config:read'))) return;

      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
        });
        return;
      }

      const settings = (await findProjectSettings(
        projectId,
        tenantId,
      )) as ProjectLifecycleSettingsDocument | null;

      res.json({
        success: true,
        data: normalizeStoredLifecycle(settings),
      });
    } catch (error: unknown) {
      log.error('Failed to get project session lifecycle settings', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get project session lifecycle settings',
        },
      });
    }
  },
);

openapi.route(
  'get',
  '/effective',
  {
    summary: 'Get effective session lifecycle policy',
    description:
      'Inspect the resolved session lifecycle policy, including source provenance for each field.',
    query: effectiveQuerySchema,
    response: effectiveLifecycleResponseSchema,
  },
  async (req, res) => {
    try {
      if (!(await requireProjectPermission(req, res, 'runtime_config:read'))) return;

      const tenantId = req.tenantContext?.tenantId;
      const { projectId } = req.params;

      if (!tenantId) {
        res.status(403).json({
          success: false,
          error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
        });
        return;
      }

      const queryResult = effectiveQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_QUERY', message: 'Invalid lifecycle inspection query' },
          issues: queryResult.error.issues,
        });
        return;
      }

      const { channel, agentName } = queryResult.data;
      const settings = (await findProjectSettings(
        projectId,
        tenantId,
      )) as ProjectLifecycleSettingsDocument | null;
      const tenantConfig = await getTenantConfigService().getConfigAsync(tenantId);
      const channelLifecycleEntry =
        channel !== undefined
          ? (
              getConfig().channelLifecycle as Partial<
                Record<Channel, { defaultDisposition?: string; disconnectBehavior?: string }>
              >
            )[channel]
          : undefined;

      let agentOverride: AgentSessionLifecycleConfig | undefined;
      if (agentName) {
        const resolvedAgent = await resolveAgentLifecycleOverride(tenantId, projectId, agentName);
        if (!resolvedAgent.found) {
          res.status(404).json({
            success: false,
            error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' },
          });
          return;
        }
        agentOverride = resolvedAgent.lifecycle;
      }

      const resolved = policyService.resolve({
        channel,
        tenant: {
          runtime: {
            idleSeconds: tenantConfig.security.sessionIdleSeconds,
            maxAgeSeconds: tenantConfig.security.sessionMaxAgeSeconds,
          },
          disconnect: channelLifecycleEntry
            ? {
                defaultDisposition: channelLifecycleEntry.defaultDisposition as
                  | z.infer<typeof resolvedDispositionFieldSchema>['value']
                  | undefined,
                disconnectBehavior: channelLifecycleEntry.disconnectBehavior as
                  | z.infer<typeof resolvedDisconnectBehaviorFieldSchema>['value']
                  | undefined,
              }
            : undefined,
        },
        project: settings?.sessionLifecycle ?? null,
        agent: agentOverride,
      });

      const effectiveEndHook =
        resolved.endHook.config ?? ({ mode: 'ignore' } as SessionEndHookConfig);

      res.json({
        success: true,
        data: {
          runtime: resolved.runtime,
          disconnect: resolved.disconnect,
          endHook: {
            mode: {
              value: effectiveEndHook.mode,
              source: resolved.endHook.source,
            },
            message:
              effectiveEndHook.mode === 'respond'
                ? {
                    value: effectiveEndHook.message,
                    source: resolved.endHook.source,
                  }
                : {},
          },
          agentTransfer: resolveTransferTtlInspection(settings),
        },
      });
    } catch (error: unknown) {
      log.error('Failed to resolve effective session lifecycle policy', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to resolve effective session lifecycle policy',
        },
      });
    }
  },
);

export default router;
