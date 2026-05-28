/**
 * Session Resolver
 *
 * Maps external session keys to runtime sessions.
 * Creates new runtime sessions via the shared pipeline (session-factory).
 * Uses the same deployment-aware path as /api/v1/chat/agent.
 *
 * Email-specific: resolves sessions via RFC 5322 Message-ID threading
 * (In-Reply-To / References headers) with subject-based fallback.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  buildChannelSessionMetadataForPersistence,
  coerceSessionMetadata,
  mergeDurableSessionMetadata,
  mergeReloadedSessionMetadata,
  readDurableSessionMetadataFromChannelSessionMetadata,
  updateSessionMetadata,
} from '../services/session-metadata.js';
import { isDatabaseAvailable } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import {
  createRuntimeSession as pipelineCreateSession,
  createAndLinkDBSession,
  resolveEnvironmentLabel,
} from './pipeline/index.js';
import type { ResolvedConnection, NormalizedIncomingMessage } from './types.js';
import {
  buildCallerContext,
  type CallerContextInput,
} from '../services/identity/artifact-hasher.js';
import { resolveProviderVerification } from '../services/identity/provider-verification-policy.js';
import {
  resolveSession as resolveIdentitySession,
  registerResolutionKey,
} from '../services/identity/session-resolver.js';
import { linkResolvedContactToSession } from '../services/identity/channel-contact-linking.js';
import {
  extractInteractionContextFromMetadata,
  extractLegacyClientInfoInteractionContext,
  mergeInteractionContextInputs,
  normalizeInteractionContextInput,
} from '../services/execution/interaction-context.js';
import { getSessionService } from '../services/session/session-service.js';
import { buildProductionSessionLocator } from '../services/session/execution-scope.js';
import { resolveRequiredContactProductionScope } from '../services/session/production-contact-scope.js';
import { resolvePersistedAgentVersion } from '../services/execution/agent-version-utils.js';
import type {
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
} from '@agent-platform/shared-auth';
import { computeToolRuntimeMetadataHash } from '@agent-platform/shared/tools';
import type { Channel } from '@abl/compiler/platform/core/types.js';

const log = createLogger('session-resolver');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapChannelTypeToConversationChannel(
  channelType: ResolvedConnection['channelType'],
): Channel {
  switch (channelType) {
    case 'voice_vxml':
    case 'voice_pipeline':
    case 'voice_twilio':
    case 'korevg':
    case 'audiocodes':
      return 'voice';
    case 'twilio_sms':
      return 'sms';
    case 'whatsapp':
      return 'whatsapp';
    case 'email':
      return 'email';
    case 'http_async':
      return 'http_async';
    case 'ag_ui':
    case 'a2a':
    case 'genesys':
    case 'instagram':
    case 'line':
    case 'messenger':
    case 'msteams':
    case 'slack':
    case 'telegram':
    case 'zendesk':
    case 'ai4w': // AI4W maps to web_chat (text-based messaging channel)
    default:
      return 'web_chat';
  }
}

/**
 * Normalize a voice caller identifier into a consistent channelArtifact + type pair.
 * Handles phone numbers (E.164), SIP URIs, and raw caller IDs.
 */
function normalizeVoiceArtifact(
  raw: string | undefined,
): { channelArtifact: string; channelArtifactType: ChannelArtifactType } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // SIP URI: sip:user@domain or sips:user@domain
  if (/^sips?:/i.test(trimmed)) {
    return { channelArtifact: trimmed.toLowerCase(), channelArtifactType: 'sip_uri' };
  }

  // Phone number: starts with + or is all digits (possibly with dashes/spaces)
  const digitsOnly = trimmed.replace(/[\s\-().]/g, '');
  if (/^\+?\d{7,15}$/.test(digitsOnly)) {
    // Normalize to E.164 format (ensure leading +)
    const normalized = digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`;
    return { channelArtifact: normalized, channelArtifactType: 'caller_id' };
  }

  // Fallback: use as-is with generic caller_id type
  return { channelArtifact: trimmed, channelArtifactType: 'caller_id' };
}

const HTTP_ASYNC_ARTIFACT_TYPES: ReadonlySet<ChannelArtifactType> = new Set([
  'caller_id',
  'cookie',
  'device_id',
  'psid',
  'aad_id',
  'phone',
  'email_thread',
  'api_client',
  'sip_uri',
]);

function isChannelArtifactType(value: unknown): value is ChannelArtifactType {
  return typeof value === 'string' && HTTP_ASYNC_ARTIFACT_TYPES.has(value as ChannelArtifactType);
}

function normalizeHttpAsyncArtifact(
  raw: string | undefined,
  artifactType: ChannelArtifactType,
): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  switch (artifactType) {
    case 'email_thread':
      return trimmed.toLowerCase();
    case 'sip_uri':
      return trimmed.toLowerCase();
    default:
      return trimmed;
  }
}

/**
 * Extract CallerContext from channel-specific message metadata.
 * Maps channel-specific user identifiers to the unified CallerContext.
 * For voice channels, also normalizes caller artifacts for cross-channel identity resolution.
 */
export function extractCallerContextFromChannel(
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): {
  anonymousId?: string;
  channel: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
} {
  const metadata = message.metadata || {};
  let anonymousId: string | undefined;
  let channelArtifact: string | undefined;
  let channelArtifactType: ChannelArtifactType | undefined;

  switch (connection.channelType) {
    case 'whatsapp':
      anonymousId = metadata.whatsappFrom as string;
      if (anonymousId) {
        channelArtifact = anonymousId;
        channelArtifactType = 'phone';
      }
      break;
    case 'slack':
      anonymousId = metadata.slackUserId as string;
      break;
    case 'line':
      anonymousId = (metadata.lineUserId as string) || message.externalSessionKey;
      break;
    case 'msteams':
      anonymousId = metadata.fromId as string;
      if (anonymousId) {
        channelArtifact = anonymousId;
        channelArtifactType = 'aad_id';
      }
      break;
    case 'messenger':
      anonymousId = metadata.messengerSenderId as string;
      if (anonymousId) {
        channelArtifact = anonymousId;
        channelArtifactType = 'psid';
      }
      break;
    case 'telegram':
      anonymousId = metadata.telegramUserId ? String(metadata.telegramUserId) : undefined;
      break;
    case 'email':
      anonymousId = metadata.from as string;
      if (anonymousId) {
        channelArtifact = anonymousId.toLowerCase().trim();
        channelArtifactType = 'email_thread';
      }
      break;
    case 'http_async': {
      anonymousId =
        typeof metadata.anonymousId === 'string' && metadata.anonymousId.trim().length > 0
          ? metadata.anonymousId.trim()
          : message.externalSessionKey;

      if (isChannelArtifactType(metadata.channelArtifactType)) {
        const normalizedArtifact = normalizeHttpAsyncArtifact(
          typeof metadata.channelArtifact === 'string' ? metadata.channelArtifact : undefined,
          metadata.channelArtifactType,
        );

        if (normalizedArtifact) {
          channelArtifact = normalizedArtifact;
          channelArtifactType = metadata.channelArtifactType;
        }
      }
      break;
    }
    case 'audiocodes': {
      const caller = (metadata.caller as string) || message.externalSessionKey;
      anonymousId = caller;
      const normalized = normalizeVoiceArtifact(caller);
      if (normalized) {
        channelArtifact = normalized.channelArtifact;
        channelArtifactType = normalized.channelArtifactType;
      }
      break;
    }
    case 'voice_vxml': {
      // VXML adapters may provide caller info as metadata.from or metadata.callerId
      const vxmlCaller =
        (metadata.from as string) || (metadata.callerId as string) || (metadata.caller as string);
      anonymousId = vxmlCaller || message.externalSessionKey;
      const vxmlNormalized = normalizeVoiceArtifact(vxmlCaller);
      if (vxmlNormalized) {
        channelArtifact = vxmlNormalized.channelArtifact;
        channelArtifactType = vxmlNormalized.channelArtifactType;
      }
      break;
    }
    case 'korevg': {
      const korevgCaller = (metadata.caller as string) || (metadata.callerNumber as string);
      anonymousId = korevgCaller || message.externalSessionKey;
      const korevgNormalized = normalizeVoiceArtifact(korevgCaller);
      if (korevgNormalized) {
        channelArtifact = korevgNormalized.channelArtifact;
        channelArtifactType = korevgNormalized.channelArtifactType;
      }
      break;
    }
    case 'genesys':
      anonymousId = metadata.genesysConversationId as string;
      break;
    default:
      anonymousId = message.externalSessionKey;
      break;
  }

  return { anonymousId, channel: connection.channelType, channelArtifact, channelArtifactType };
}

function resolveChannelVerification(
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): {
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  providerVerified: boolean;
} {
  const providerVerification = resolveProviderVerification({
    providerVerified: message.metadata?.providerVerified === true,
    connectionConfig: connection.config,
    metadata: message.metadata,
  });

  return providerVerification.providerVerified
    ? {
        identityTier: providerVerification.identityTier,
        verificationMethod: 'provider',
        providerVerified: true,
      }
    : {
        identityTier: 0,
        verificationMethod: 'none',
        providerVerified: false,
      };
}

interface ChannelIdentityState {
  callerContext: CallerContext;
  rawArtifact?: string;
  artifactType?: ChannelArtifactType;
  providerVerified: boolean;
}

function buildChannelIdentityState(
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): ChannelIdentityState {
  const callerInfo = extractCallerContextFromChannel(connection, message);
  const verification = resolveChannelVerification(connection, message);

  const input: CallerContextInput = {
    tenantId: connection.tenantId,
    channel: callerInfo.channel,
    channelId: connection.id,
    anonymousId: callerInfo.anonymousId,
    identityTier: verification.identityTier,
    verificationMethod: verification.verificationMethod,
    rawArtifact: callerInfo.channelArtifact,
    channelArtifactType: callerInfo.channelArtifactType,
  };

  return {
    callerContext: buildCallerContext(input),
    rawArtifact: callerInfo.channelArtifact,
    artifactType: callerInfo.channelArtifactType,
    providerVerified: verification.providerVerified,
  };
}

async function registerChannelResolutionKey(
  connection: ResolvedConnection,
  callerContext: CallerContext,
  sessionId: string,
): Promise<void> {
  if (!callerContext.channelArtifact) {
    return;
  }

  try {
    const sessionService = getSessionService();
    if (!sessionService.isDistributed()) {
      return;
    }

    await registerResolutionKey(sessionService.store, {
      tenantId: connection.tenantId,
      channelId: connection.id,
      artifactHash: callerContext.channelArtifact,
      sessionId,
    });
  } catch (err) {
    log.warn('Failed to register channel session resolution key', {
      tenantId: connection.tenantId,
      channelId: connection.id,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function linkChannelSessionToContact(
  connection: ResolvedConnection,
  sessionId: string,
  contactId: string,
): Promise<void> {
  await linkResolvedContactToSession({
    tenantId: connection.tenantId,
    channelType: connection.channelType,
    channelId: connection.id,
    sessionId,
    contactId,
  });
}

export interface ResolvedSession {
  channelSessionId: string;
  sessionId: string;
  isNew: boolean;
}

function getSessionLookupKeys(message: NormalizedIncomingMessage): string[] {
  const metadata = message.metadata || {};
  const configuredKeys = Array.isArray(metadata.sessionLookupKeys)
    ? metadata.sessionLookupKeys.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : [];

  if (
    typeof message.externalSessionKey === 'string' &&
    message.externalSessionKey.trim().length > 0 &&
    !configuredKeys.includes(message.externalSessionKey)
  ) {
    configuredKeys.push(message.externalSessionKey);
  }

  return configuredKeys;
}

async function findExistingChannelSession(
  ChannelSession: any,
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): Promise<any | null> {
  const lookupKeys = getSessionLookupKeys(message);

  for (const externalSessionKey of lookupKeys) {
    const existing = await ChannelSession.findOne({
      tenantId: connection.tenantId,
      channelConnectionId: connection.id,
      externalSessionKey,
    }).lean();

    if (existing) {
      return existing;
    }
  }

  return null;
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePromptLibraryRef(ref: unknown): { promptId: string; versionId: string } | null {
  if (!ref || typeof ref !== 'object') {
    return null;
  }

  const promptId = 'promptId' in ref ? ref.promptId : undefined;
  const versionId = 'versionId' in ref ? ref.versionId : undefined;

  return typeof promptId === 'string' && typeof versionId === 'string'
    ? { promptId, versionId }
    : null;
}

function hashConfigVariableValue(value: unknown): string | null {
  return typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
}

function normalizeStructuredValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeStructuredValue(entryValue)]),
    );
  }

  return value;
}

function normalizeRuntimeConfigForHash(
  runtimeConfig: { [key: string]: unknown; updatedAt?: unknown } | null,
): { value: unknown; updatedAt: string | null } | null {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') {
    return null;
  }

  const {
    _id: _ignoredId,
    tenantId: _ignoredTenantId,
    projectId: _ignoredProjectId,
    __v: _ignoredVersion,
    _v: _ignoredCompatVersion,
    createdAt: _ignoredCreatedAt,
    updatedAt,
    ...rest
  } = runtimeConfig;

  return {
    value: normalizeStructuredValue(rest),
    updatedAt: toIsoDate(updatedAt),
  };
}

function normalizeRuntimeConfigPromptRef(
  runtimeConfig: { filler?: unknown } | null,
): { promptId: string; versionId: string } | null {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') {
    return null;
  }

  const filler = runtimeConfig.filler;
  if (!filler || typeof filler !== 'object') {
    return null;
  }

  return normalizePromptLibraryRef((filler as { promptRef?: unknown }).promptRef);
}

function computeWorkingCopyCompilationHash(input: {
  tenantId: string;
  projectId: string;
  agentId: string | null;
  project: { entryAgentName?: unknown; updatedAt?: unknown } | null;
  agents: Array<{
    name?: unknown;
    sourceHash?: unknown;
    updatedAt?: unknown;
    systemPromptLibraryRef?: unknown;
  }>;
  tools: Array<{
    name?: unknown;
    sourceHash?: unknown;
    updatedAt?: unknown;
    variableNamespaceIds?: unknown;
  }>;
  configVariables: Array<{ key?: unknown; value?: unknown; updatedAt?: unknown }>;
  promptVersions: Array<{
    _id?: unknown;
    promptId?: unknown;
    sourceHash?: unknown;
    status?: unknown;
    updatedAt?: unknown;
  }>;
  runtimeConfig: { [key: string]: unknown; updatedAt?: unknown } | null;
  mcpServers: Array<{
    id?: unknown;
    name?: unknown;
    transport?: unknown;
    url?: unknown;
    encryptedEnv?: unknown;
    encryptedAuthConfig?: unknown;
    authType?: unknown;
    authProfileId?: unknown;
    headers?: unknown;
    connectionTimeoutMs?: unknown;
    requestTimeoutMs?: unknown;
  }>;
}): string {
  const normalizeNamedItems = (
    items: Array<{
      name?: unknown;
      sourceHash?: unknown;
      updatedAt?: unknown;
      variableNamespaceIds?: unknown;
    }>,
  ) =>
    items
      .map((item) => {
        if (typeof item.name !== 'string') {
          return null;
        }

        return {
          name: item.name,
          sourceHash: typeof item.sourceHash === 'string' ? item.sourceHash : null,
          updatedAt: toIsoDate(item.updatedAt),
          runtimeMetadataHash: computeToolRuntimeMetadataHash({
            variableNamespaceIds: Array.isArray(item.variableNamespaceIds)
              ? item.variableNamespaceIds.filter((id): id is string => typeof id === 'string')
              : [],
          }),
        };
      })
      .filter(
        (
          item,
        ): item is {
          name: string;
          sourceHash: string | null;
          updatedAt: string | null;
          runtimeMetadataHash: string;
        } => item !== null,
      )
      .sort((left, right) => left.name.localeCompare(right.name));

  const normalizeAgentItems = (
    items: Array<{
      name?: unknown;
      sourceHash?: unknown;
      updatedAt?: unknown;
      systemPromptLibraryRef?: unknown;
    }>,
  ) =>
    items
      .map((item) => {
        if (typeof item.name !== 'string') {
          return null;
        }

        return {
          name: item.name,
          sourceHash: typeof item.sourceHash === 'string' ? item.sourceHash : null,
          updatedAt: toIsoDate(item.updatedAt),
          systemPromptLibraryRef: normalizePromptLibraryRef(item.systemPromptLibraryRef),
        };
      })
      .filter(
        (
          item,
        ): item is {
          name: string;
          sourceHash: string | null;
          updatedAt: string | null;
          systemPromptLibraryRef: { promptId: string; versionId: string } | null;
        } => item !== null,
      )
      .sort((left, right) => left.name.localeCompare(right.name));

  const normalizeConfigVariables = (
    items: Array<{ key?: unknown; value?: unknown; updatedAt?: unknown }>,
  ) =>
    items
      .map((item) => {
        if (typeof item.key !== 'string') {
          return null;
        }

        return {
          key: item.key,
          valueHash: hashConfigVariableValue(item.value),
          updatedAt: toIsoDate(item.updatedAt),
        };
      })
      .filter(
        (item): item is { key: string; valueHash: string | null; updatedAt: string | null } =>
          item !== null,
      )
      .sort((left, right) => left.key.localeCompare(right.key));

  const normalizePromptVersions = (
    items: Array<{
      _id?: unknown;
      promptId?: unknown;
      sourceHash?: unknown;
      status?: unknown;
      updatedAt?: unknown;
    }>,
  ) =>
    items
      .map((item) => {
        if (typeof item._id !== 'string' || typeof item.promptId !== 'string') {
          return null;
        }

        return {
          versionId: item._id,
          promptId: item.promptId,
          sourceHash: typeof item.sourceHash === 'string' ? item.sourceHash : null,
          status: typeof item.status === 'string' ? item.status : null,
          updatedAt: toIsoDate(item.updatedAt),
        };
      })
      .filter(
        (
          item,
        ): item is {
          versionId: string;
          promptId: string;
          sourceHash: string | null;
          status: string | null;
          updatedAt: string | null;
        } => item !== null,
      )
      .sort(
        (left, right) =>
          left.promptId.localeCompare(right.promptId) ||
          left.versionId.localeCompare(right.versionId),
      );

  const normalizeMcpServers = (
    items: Array<{
      id?: unknown;
      name?: unknown;
      transport?: unknown;
      url?: unknown;
      encryptedEnv?: unknown;
      encryptedAuthConfig?: unknown;
      authType?: unknown;
      authProfileId?: unknown;
      headers?: unknown;
      connectionTimeoutMs?: unknown;
      requestTimeoutMs?: unknown;
    }>,
  ) =>
    items
      .map((item) => {
        if (typeof item.id !== 'string' || typeof item.name !== 'string') {
          return null;
        }

        return {
          id: item.id,
          name: item.name,
          transport: typeof item.transport === 'string' ? item.transport : null,
          url: typeof item.url === 'string' ? item.url : null,
          encryptedEnv: typeof item.encryptedEnv === 'string' ? item.encryptedEnv : null,
          encryptedAuthConfig:
            typeof item.encryptedAuthConfig === 'string' ? item.encryptedAuthConfig : null,
          authType: typeof item.authType === 'string' ? item.authType : null,
          authProfileId: typeof item.authProfileId === 'string' ? item.authProfileId : null,
          headers: typeof item.headers === 'string' ? item.headers : null,
          connectionTimeoutMs:
            typeof item.connectionTimeoutMs === 'number' ? item.connectionTimeoutMs : null,
          requestTimeoutMs:
            typeof item.requestTimeoutMs === 'number' ? item.requestTimeoutMs : null,
        };
      })
      .filter(
        (
          item,
        ): item is {
          id: string;
          name: string;
          transport: string | null;
          url: string | null;
          encryptedEnv: string | null;
          encryptedAuthConfig: string | null;
          authType: string | null;
          authProfileId: string | null;
          headers: string | null;
          connectionTimeoutMs: number | null;
          requestTimeoutMs: number | null;
        } => item !== null,
      )
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );

  const payload = {
    tenantId: input.tenantId,
    projectId: input.projectId,
    agentId: input.agentId,
    entryAgentName:
      input.project && typeof input.project.entryAgentName === 'string'
        ? input.project.entryAgentName
        : null,
    projectUpdatedAt: toIsoDate(input.project?.updatedAt),
    agents: normalizeAgentItems(input.agents),
    tools: normalizeNamedItems(input.tools),
    configVariables: normalizeConfigVariables(input.configVariables),
    promptVersions: normalizePromptVersions(input.promptVersions),
    runtimeConfig: normalizeRuntimeConfigForHash(input.runtimeConfig),
    mcpServers: normalizeMcpServers(input.mcpServers),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

async function resolveWorkingCopyCompilationHash(
  connection: ResolvedConnection,
): Promise<string | null> {
  if (connection.deploymentId || connection.environment) {
    return null;
  }

  const [
    {
      Project,
      ProjectAgent,
      ProjectTool,
      ProjectConfigVariable,
      ProjectRuntimeConfig,
      PromptLibraryVersion,
    },
    { findMcpServerConfigsRaw },
  ] = await Promise.all([
    import('@agent-platform/database/models'),
    import('@agent-platform/shared/repos'),
  ]);
  const [project, agents, tools, configVariables, runtimeConfig, mcpServers] = await Promise.all([
    Project.findOne(
      { _id: connection.projectId, tenantId: connection.tenantId },
      { entryAgentName: 1, updatedAt: 1 },
    ).lean(),
    ProjectAgent.find(
      { projectId: connection.projectId, tenantId: connection.tenantId },
      { name: 1, sourceHash: 1, updatedAt: 1, systemPromptLibraryRef: 1 },
    ).lean(),
    ProjectTool.find(
      { projectId: connection.projectId, tenantId: connection.tenantId },
      { name: 1, sourceHash: 1, updatedAt: 1, variableNamespaceIds: 1 },
    ).lean(),
    ProjectConfigVariable.find(
      { projectId: connection.projectId, tenantId: connection.tenantId },
      { key: 1, value: 1, updatedAt: 1 },
    ).lean(),
    ProjectRuntimeConfig.findOne({
      projectId: connection.projectId,
      tenantId: connection.tenantId,
    }).lean(),
    findMcpServerConfigsRaw(connection.tenantId, connection.projectId),
  ]);

  const agentPromptRefs =
    Array.isArray(agents) && agents.every((agent) => typeof agent === 'object' && agent !== null)
      ? (agents as Array<{ systemPromptLibraryRef?: unknown }>)
          .map((agent) => normalizePromptLibraryRef(agent.systemPromptLibraryRef))
          .filter((ref): ref is { promptId: string; versionId: string } => ref !== null)
      : [];
  const runtimeConfigPromptRef = normalizeRuntimeConfigPromptRef(
    runtimeConfig && typeof runtimeConfig === 'object'
      ? (runtimeConfig as { filler?: unknown })
      : null,
  );
  const promptLibraryRefs = [
    ...new Map(
      [...agentPromptRefs, ...(runtimeConfigPromptRef ? [runtimeConfigPromptRef] : [])].map(
        (ref) => [ref.versionId, ref],
      ),
    ).values(),
  ];

  const promptVersions =
    promptLibraryRefs.length > 0
      ? await PromptLibraryVersion.find(
          {
            tenantId: connection.tenantId,
            projectId: connection.projectId,
            _id: { $in: promptLibraryRefs.map((ref) => ref.versionId) },
          },
          { _id: 1, promptId: 1, sourceHash: 1, status: 1, updatedAt: 1 },
        ).lean()
      : [];

  return computeWorkingCopyCompilationHash({
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    agentId: connection.agentId ?? null,
    project:
      project && typeof project === 'object'
        ? (project as { entryAgentName?: unknown; updatedAt?: unknown })
        : null,
    agents:
      Array.isArray(agents) && agents.every((agent) => typeof agent === 'object' && agent !== null)
        ? (agents as Array<{
            name?: unknown;
            sourceHash?: unknown;
            updatedAt?: unknown;
            systemPromptLibraryRef?: unknown;
          }>)
        : [],
    tools:
      Array.isArray(tools) && tools.every((tool) => typeof tool === 'object' && tool !== null)
        ? (tools as Array<{ name?: unknown; sourceHash?: unknown; updatedAt?: unknown }>)
        : [],
    configVariables:
      Array.isArray(configVariables) &&
      configVariables.every((variable) => typeof variable === 'object' && variable !== null)
        ? (configVariables as Array<{ key?: unknown; value?: unknown; updatedAt?: unknown }>)
        : [],
    promptVersions:
      Array.isArray(promptVersions) &&
      promptVersions.every((version) => typeof version === 'object' && version !== null)
        ? (promptVersions as Array<{
            _id?: unknown;
            promptId?: unknown;
            sourceHash?: unknown;
            status?: unknown;
            updatedAt?: unknown;
          }>)
        : [],
    runtimeConfig:
      runtimeConfig && typeof runtimeConfig === 'object'
        ? (runtimeConfig as { [key: string]: unknown; updatedAt?: unknown })
        : null,
    mcpServers:
      Array.isArray(mcpServers) &&
      mcpServers.every((server) => typeof server === 'object' && server !== null)
        ? (mcpServers as Array<{
            id?: unknown;
            name?: unknown;
            transport?: unknown;
            url?: unknown;
            encryptedEnv?: unknown;
            encryptedAuthConfig?: unknown;
            authType?: unknown;
            authProfileId?: unknown;
            headers?: unknown;
            connectionTimeoutMs?: unknown;
            requestTimeoutMs?: unknown;
          }>)
        : [],
  });
}

/**
 * Extract sessionMetadata from message.metadata, leaving remaining fields for channel use.
 */
function extractSessionMetadataFromMessage(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return coerceSessionMetadata(metadata.sessionMetadata);
}

function extractInteractionContextFromMessage(
  message: NormalizedIncomingMessage,
): NormalizedIncomingMessage['interactionContext'] {
  const explicitResult = normalizeInteractionContextInput(message.interactionContext, 'sanitize');
  const metadataResult = extractInteractionContextFromMetadata(message.metadata);
  const sessionMetadata = extractSessionMetadataFromMessage(message.metadata);
  const legacyClientInfoResult = extractLegacyClientInfoInteractionContext(sessionMetadata);

  return mergeInteractionContextInputs(
    legacyClientInfoResult.success ? legacyClientInfoResult.data : undefined,
    metadataResult.success ? metadataResult.data : undefined,
    explicitResult.success ? explicitResult.data : undefined,
  );
}

/**
 * Strip sessionMetadata from message metadata before persisting to conversation sessions.
 * Durable channel sessions use a separate hybrid persistence path with an allowlisted subset.
 */
export function stripSessionMetadataForPersistence(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const { sessionMetadata: _stripped, ...channelMetadata } = metadata;
  return channelMetadata;
}

function mergeChannelSessionMetadataForPersistence(
  existingChannelMetadata: unknown,
  incomingMessageMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const nextMetadata = isRecord(existingChannelMetadata) ? { ...existingChannelMetadata } : {};
  const mergedDurableSessionMetadata = mergeDurableSessionMetadata(
    readDurableSessionMetadataFromChannelSessionMetadata(existingChannelMetadata),
    extractSessionMetadataFromMessage(incomingMessageMetadata),
  );

  if (mergedDurableSessionMetadata) {
    nextMetadata.sessionMetadata = mergedDurableSessionMetadata;
  } else {
    delete nextMetadata.sessionMetadata;
  }

  return nextMetadata;
}

async function createChannelSessionMapping(
  ChannelSession: any,
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
  sessionId: string,
): Promise<string> {
  const currentMessageId = (message.metadata?.messageId as string) || undefined;
  const compilationHash = await resolveWorkingCopyCompilationHash(connection);
  const channelSession = await ChannelSession.create({
    tenantId: connection.tenantId,
    channelConnectionId: connection.id,
    externalSessionKey: message.externalSessionKey,
    sessionId,
    compilationHash,
    projectId: connection.projectId,
    agentId: connection.agentId,
    metadata: buildChannelSessionMetadataForPersistence(message.metadata),
    status: 'active',
    ...(connection.channelType === 'email' && currentMessageId
      ? { emailMessageIds: [currentMessageId] }
      : {}),
  });

  log.info('Created new channel session', {
    channelSessionId: channelSession._id,
    sessionId,
    externalSessionKey: message.externalSessionKey,
  });

  return channelSession._id as string;
}

async function resolveSessionViaIdentityArtifact(
  ChannelSession: any,
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): Promise<ResolvedSession | null> {
  const identityState = buildChannelIdentityState(connection, message);
  if (!identityState.callerContext.channelArtifact) {
    return null;
  }

  const sessionService = getSessionService();
  if (!sessionService.isDistributed()) {
    return null;
  }

  const resolution = await resolveIdentitySession(sessionService.store, {
    tenantId: connection.tenantId,
    channelId: connection.id,
    callerContext: identityState.callerContext,
  });

  if (resolution.outcome !== 'existing' || !resolution.sessionId) {
    return null;
  }

  const resolvedSession = await sessionService.store.load(resolution.sessionId);
  const deploymentChanged =
    resolvedSession != null &&
    (connection.deploymentId || undefined) !== resolvedSession.deploymentId;
  if (deploymentChanged) {
    log.info('Identity-resolved session deployment mismatch — creating new session', {
      sessionId: resolution.sessionId,
      oldDeployment: resolvedSession.deploymentId,
      newDeployment: connection.deploymentId,
      channelId: connection.id,
    });
    return null;
  }

  const channelSessionId = await createChannelSessionMapping(
    ChannelSession,
    connection,
    message,
    resolution.sessionId,
  );

  return {
    channelSessionId,
    sessionId: resolution.sessionId,
    isNew: false,
  };
}

/**
 * Resolve an external session key to a runtime session.
 * Creates a new runtime session and channel session mapping if none exists.
 */
export async function resolveSession(
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
): Promise<ResolvedSession> {
  if (!isDatabaseAvailable()) {
    throw new Error('Database not available for session resolution');
  }

  const { ChannelSession } = await import('@agent-platform/database/models');

  // ── Email-specific: Message-ID-based thread resolution ──────────────
  if (connection.channelType === 'email') {
    const emailResult = await resolveEmailSession(connection, message, ChannelSession);
    if (emailResult) return emailResult;
    // No email thread match — fall through to create a new session
  } else {
    // ── Non-email channels: existing externalSessionKey lookup ──────────
    const existing = await findExistingChannelSession(ChannelSession, connection, message);

    if (existing && existing.status === 'active') {
      return await reuseOrRefreshSession(existing, connection, message, ChannelSession);
    }

    const identityResolved = await resolveSessionViaIdentityArtifact(
      ChannelSession,
      connection,
      message,
    );
    if (identityResolved) {
      return identityResolved;
    }
  }

  // Create a new runtime session via pipeline
  // allowWorkingCopy is true only when NEITHER deploymentId NOR environment is set.
  // Channels with an environment (even without an active deployment) must not
  // fall back to the working copy — consistent with reuseOrRefreshSession().
  const typedSessionMetadata = extractSessionMetadataFromMessage(message.metadata);
  const interactionContext = extractInteractionContextFromMessage(message);
  const identityState = buildChannelIdentityState(connection, message);
  const runtimeSessionId = randomUUID();
  const scopeInput = await resolveRequiredContactProductionScope({
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    sessionId: runtimeSessionId,
    channelId: connection.id,
    environment: connection.environment ?? (connection.deploymentId ? 'unknown' : 'dev'),
    source: `channel_${connection.channelType}`,
    authType: 'channel_ingress',
    callerContext: identityState.callerContext,
    channelType: connection.channelType,
    fallbackAnonymousId: message.externalSessionKey,
  });
  const callerContext = scopeInput.callerContext;
  const { runtimeSession: newSession } = await pipelineCreateSession({
    projectId: connection.projectId,
    tenantId: connection.tenantId,
    deploymentId: connection.deploymentId ?? undefined,
    environment: !connection.deploymentId ? (connection.environment ?? undefined) : undefined,
    allowWorkingCopy: !connection.deploymentId && !connection.environment,
    sessionId: runtimeSessionId,
    channelType: connection.channelType,
    ensureLLMReady: true,
    callerContext,
    ...(interactionContext ? { interactionContext } : {}),
    metadata: typedSessionMetadata,
    scope: scopeInput.scope,
  });
  const sessionId = newSession.id;
  const contactId = callerContext.contactId;

  try {
    await createAndLinkDBSession({
      sessionId,
      channel: mapChannelTypeToConversationChannel(connection.channelType),
      agentName: newSession.agentName,
      agentVersion: resolvePersistedAgentVersion(newSession.versionInfo, newSession.agentName),
      environment: resolveEnvironmentLabel(connection.environment ?? undefined),
      projectId: connection.projectId,
      tenantId: connection.tenantId,
      deploymentId: connection.deploymentId ?? undefined,
      customerId: callerContext.customerId,
      anonymousId: callerContext.anonymousId,
      contactId,
      channelArtifact: callerContext.channelArtifact,
      channelArtifactType: callerContext.channelArtifactType,
      identityTier: callerContext.identityTier,
      verificationMethod: callerContext.verificationMethod,
      channelId: callerContext.channelId,
      callerNumber:
        typeof message.metadata?.caller === 'string'
          ? (message.metadata.caller as string)
          : undefined,
      experimentId: newSession.experimentId,
      experimentGroup: newSession.experimentGroup,
      metadata: {
        ...stripSessionMetadataForPersistence(message.metadata),
        channelConnectionId: connection.id,
        channelType: connection.channelType,
        externalSessionKey: message.externalSessionKey,
      },
    });
  } catch (error) {
    const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
    getRuntimeExecutor().endSession(sessionId);
    throw error;
  }

  await registerChannelResolutionKey(connection, callerContext, sessionId);
  if (contactId) {
    await linkChannelSessionToContact(connection, sessionId, contactId);
  }

  const channelSessionId = await createChannelSessionMapping(
    ChannelSession,
    connection,
    message,
    sessionId,
  );

  return {
    channelSessionId,
    sessionId,
    isNew: true,
  };
}

// ── Email-specific session resolution ──────────────────────────────────────

/**
 * Resolve an email session using RFC 5322 Message-ID threading.
 *
 * Strategy:
 * 1. If In-Reply-To/References headers present → search emailMessageIds array
 * 2. If found → reuse session, append current messageId
 * 3. If not found but has subject-based fallback → try subject match
 * 4. If still not found → return null (caller creates new session)
 */
async function resolveEmailSession(
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
  ChannelSession: any,
): Promise<ResolvedSession | null> {
  const metadata = message.metadata || {};
  const inReplyTo = metadata.inReplyTo as string | undefined;
  const references = metadata.references as string | undefined;
  const currentMessageId = metadata.messageId as string | undefined;
  const hasThreadingHeaders = metadata.hasThreadingHeaders as boolean | undefined;
  const subjectBasedKey = metadata.subjectBasedKey as string | undefined;

  // If threading headers are present, search by message ID chain
  if (hasThreadingHeaders && (inReplyTo || references)) {
    const searchIds: string[] = [];
    if (inReplyTo) searchIds.push(inReplyTo);
    if (references) {
      searchIds.push(...references.split(/\s+/).filter(Boolean));
    }
    const uniqueIds = [...new Set(searchIds)];

    if (uniqueIds.length > 0) {
      const existing = await ChannelSession.findOne({
        tenantId: connection.tenantId,
        channelConnectionId: connection.id,
        emailMessageIds: { $in: uniqueIds },
        status: 'active',
      }).lean();

      if (existing) {
        log.info('Email session resolved via message ID threading', {
          channelSessionId: existing._id,
          matchedVia: 'emailMessageIds',
        });
        if (currentMessageId) {
          await ChannelSession.updateOne(
            { _id: existing._id },
            { $addToSet: { emailMessageIds: currentMessageId } },
          );
        }
        return await reuseOrRefreshSession(existing, connection, message, ChannelSession);
      }
    }

    // Threading headers present but no message ID match.
    // Fall back to subject-based key (handles backward compatibility
    // with sessions created before this change).
    if (subjectBasedKey) {
      const subjectMatch = await ChannelSession.findOne({
        tenantId: connection.tenantId,
        channelConnectionId: connection.id,
        externalSessionKey: subjectBasedKey,
        status: 'active',
      }).lean();

      if (subjectMatch) {
        log.info('Email session resolved via subject fallback (threading headers unmatched)', {
          channelSessionId: subjectMatch._id,
          matchedVia: 'subjectBasedKey',
        });
        if (currentMessageId) {
          await ChannelSession.updateOne(
            { _id: subjectMatch._id },
            { $addToSet: { emailMessageIds: currentMessageId } },
          );
        }
        return await reuseOrRefreshSession(subjectMatch, connection, message, ChannelSession);
      }
    }

    // No match at all — return null to create a new session
    return null;
  }

  // No threading headers — check if subject-based fallback applies.
  // This happens when the email has Re:/Fwd: prefix but no In-Reply-To/References
  // (unusual client behavior). The smtp-server already set externalSessionKey to
  // the subject-based key in this case, so the standard lookup will work.
  if (!hasThreadingHeaders && subjectBasedKey) {
    const subjectMatch = await ChannelSession.findOne({
      tenantId: connection.tenantId,
      channelConnectionId: connection.id,
      externalSessionKey: message.externalSessionKey,
      status: 'active',
    }).lean();

    if (subjectMatch) {
      if (currentMessageId) {
        await ChannelSession.updateOne(
          { _id: subjectMatch._id },
          { $addToSet: { emailMessageIds: currentMessageId } },
        );
      }
      return await reuseOrRefreshSession(subjectMatch, connection, message, ChannelSession);
    }
  }

  // No match — return null to create a new session
  return null;
}

// ── Shared session reuse logic ──────────────────────────────────────────────

/**
 * Reuse an existing channel session, refreshing the runtime session if stale.
 *
 * TEMP FIX: Verify the runtime session still exists in Redis before reusing.
 * Root cause: Redis sessions expire after 30 min (sessionTtlMinutes) but
 * MongoDB channel_sessions have no TTL, so they outlive the runtime session.
 */
async function reuseOrRefreshSession(
  existing: any,
  connection: ResolvedConnection,
  message: NormalizedIncomingMessage,
  ChannelSession: any,
): Promise<ResolvedSession> {
  const { getRuntimeExecutor } = await import('../services/runtime-executor.js');
  const executor = getRuntimeExecutor();
  const sessionLocator = buildProductionSessionLocator({
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    sessionId: existing.sessionId,
  });
  const runtimeSession =
    executor.getSession(existing.sessionId) ??
    (await executor.rehydrateSession(
      existing.sessionId,
      sessionLocator ? { locator: sessionLocator } : undefined,
    ));

  // Detect deployment mismatch: connection now points to a different deployment
  // than the one the runtime session was created with
  const deploymentChanged =
    runtimeSession &&
    (connection.deploymentId || undefined) !== runtimeSession.versionInfo?.deploymentId;
  const environmentChanged =
    runtimeSession &&
    !connection.deploymentId &&
    !!connection.environment &&
    connection.environment !== runtimeSession.versionInfo?.environment;
  let currentCompilationHash: string | null | undefined;
  let workingCopyChanged = false;

  if (runtimeSession && !connection.deploymentId && !connection.environment) {
    currentCompilationHash = await resolveWorkingCopyCompilationHash(connection);
    workingCopyChanged = currentCompilationHash !== (existing.compilationHash ?? null);
  }

  if (!runtimeSession || deploymentChanged || environmentChanged || workingCopyChanged) {
    if (deploymentChanged) {
      log.info('Deployment changed on connection — creating new session', {
        channelSessionId: existing._id,
        staleSessionId: existing.sessionId,
        externalSessionKey: existing.externalSessionKey,
        oldDeployment: runtimeSession?.versionInfo?.deploymentId,
        newDeployment: connection.deploymentId,
      });
    } else if (environmentChanged) {
      log.info('Environment changed on connection — creating new session', {
        channelSessionId: existing._id,
        staleSessionId: existing.sessionId,
        externalSessionKey: existing.externalSessionKey,
        oldEnvironment: runtimeSession?.versionInfo?.environment,
        newEnvironment: connection.environment,
      });
    } else if (workingCopyChanged) {
      log.info('Working-copy compilation changed on connection — creating new session', {
        channelSessionId: existing._id,
        staleSessionId: existing.sessionId,
        externalSessionKey: existing.externalSessionKey,
        oldCompilationHash: existing.compilationHash ?? null,
        newCompilationHash: currentCompilationHash ?? null,
      });
    } else {
      log.warn(
        'Stale channel session detected — runtime session expired in Redis, creating new one',
        {
          channelSessionId: existing._id,
          staleSessionId: existing.sessionId,
          externalSessionKey: existing.externalSessionKey,
        },
      );
    }

    const typedSessionMetadata = mergeReloadedSessionMetadata(
      readDurableSessionMetadataFromChannelSessionMetadata(existing.metadata),
      extractSessionMetadataFromMessage(message.metadata),
    );
    const scopeInput = await resolveRequiredContactProductionScope({
      tenantId: connection.tenantId,
      projectId: connection.projectId,
      sessionId: existing.sessionId,
      channelId: connection.id,
      environment: connection.environment ?? (connection.deploymentId ? 'unknown' : 'dev'),
      source: `channel_${connection.channelType}`,
      authType: 'channel_ingress',
      callerContext: buildChannelIdentityState(connection, message).callerContext,
      channelType: connection.channelType,
      fallbackAnonymousId: message.externalSessionKey,
    });
    const { runtimeSession: newSession } = await pipelineCreateSession({
      projectId: connection.projectId,
      tenantId: connection.tenantId,
      deploymentId: connection.deploymentId ?? undefined,
      environment: !connection.deploymentId ? (connection.environment ?? undefined) : undefined,
      allowWorkingCopy: !connection.deploymentId && !connection.environment,
      sessionId: existing.sessionId,
      channelType: connection.channelType,
      ensureLLMReady: true,
      callerContext: scopeInput.callerContext,
      metadata: typedSessionMetadata,
      scope: scopeInput.scope,
    });
    const newSessionId = existing.sessionId;

    if (currentCompilationHash === undefined) {
      currentCompilationHash = await resolveWorkingCopyCompilationHash(connection);
    }

    await registerChannelResolutionKey(connection, scopeInput.callerContext, newSessionId);

    await ChannelSession.updateOne(
      { _id: existing._id },
      {
        $set: {
          sessionId: newSessionId,
          compilationHash: currentCompilationHash ?? null,
          agentId: connection.agentId ?? null,
          metadata: mergeChannelSessionMetadataForPersistence(existing.metadata, message.metadata),
          lastMessageAt: new Date(),
        },
      },
    );

    return {
      channelSessionId: existing._id,
      sessionId: newSessionId,
      isNew: false,
    };
  }

  // Merge follow-up sessionMetadata into existing session _metadata namespace
  const msgSessionMeta = extractSessionMetadataFromMessage(message.metadata);
  if (runtimeSession && msgSessionMeta && Object.keys(msgSessionMeta).length > 0) {
    updateSessionMetadata(runtimeSession.data, msgSessionMeta);
  }

  // Update last message timestamp
  await ChannelSession.updateOne(
    { _id: existing._id },
    {
      $set: {
        metadata: mergeChannelSessionMetadataForPersistence(existing.metadata, message.metadata),
        lastMessageAt: new Date(),
      },
    },
  );

  return {
    channelSessionId: existing._id,
    sessionId: existing.sessionId,
    isNew: false,
  };
}
