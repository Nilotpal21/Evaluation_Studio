/**
 * Channel Connections CRUD Route (Project-Scoped)
 *
 * Manages channel connection configurations (Slack, MS Teams, Email, etc.)
 * with encrypted credential storage. Each connection links a channel type
 * to a project and optionally to a specific deployment.
 *
 * POST   /api/projects/:projectId/channel-connections          Create connection
 * GET    /api/projects/:projectId/channel-connections           List connections
 * GET    /api/projects/:projectId/channel-connections/:id       Get connection
 * PATCH  /api/projects/:projectId/channel-connections/:id       Update connection
 * DELETE /api/projects/:projectId/channel-connections/:id       Deactivate connection
 */

import { createHash, randomBytes } from 'node:crypto';
import { Router, type Router as RouterType } from 'express';
import { requireProjectScope } from '@agent-platform/shared-auth';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import {
  encryptForTenantAuto,
  isTenantEncryptionReady,
  decryptForTenantAuto,
} from '@agent-platform/shared/encryption';
import { findActiveDeployment, findDeploymentById } from '../repos/deployment-repo.js';
import { createLogger } from '@abl/compiler/platform';
import { VALID_ENVIRONMENTS } from '@agent-platform/config';
import {
  CONNECTION_CAPABLE_TYPES,
  VOICE_TYPES,
  buildWebhookUrl,
  getRequiredCredentials,
} from '../channels/manifest.js';
import {
  getDisallowedProviderApiBaseOverrides,
  resolveProviderApiBase,
} from '../channels/adapters/provider-api-base.js';
import {
  normalizeInfobipPhoneIdentifier,
  validateInfobipBaseUrl,
} from '../channels/adapters/whatsapp-providers/infobip-utils.js';
import { invalidateCard } from '../services/a2a/agent-card-builder.js';
import {
  normalizeChannelConnectionIdentityVerificationConfig,
  parseChannelConnectionIdentityVerification,
} from './channel-connection-identity-utils.js';
import { generateConnectionId, generateConnectionSecret } from '../channels/adapters/ai4w-types.js';

const log = createLogger('channel-connections-route');

/** SHA-256 hash of a verify_token for indexed lookup during Meta webhook verification. */
function hashVerifyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const router: RouterType = Router({ mergeParams: true });

router.use(authMiddleware);
router.use(requireProjectScope('projectId'));
router.use(tenantRateLimit('request'));

// =============================================================================
// HELPERS
// =============================================================================

/** Valid channel types for connection management — derived from channel manifest. */
const VALID_CHANNEL_TYPES = CONNECTION_CAPABLE_TYPES;
type ChannelType = string;

/** Voice channel types for voice-specific routing — derived from channel manifest. */
const VOICE_CHANNEL_TYPES = VOICE_TYPES;

/** Voice channels that manage their own gateway and skip Jambonz provisioning. */
const EXTERNAL_VOICE_GATEWAYS = new Set(['audiocodes', 'voice_vxml']);

/**
 * Voice config fields provisioned by the platform that must survive PATCH requests.
 * The PATCH API accepts a full config object, but callers usually edit only the
 * user-facing speech/number settings and should not need to round-trip these
 * internal gateway identifiers.
 */
const PRESERVED_VOICE_CONFIG_FIELDS = [
  'encryptedInboundAuthToken',
  'jambonzApplicationSid',
  'jambonzPhoneNumberSid',
  'jambonzVoipCarrierSid',
  'jambonzSipGatewaySid',
  'twilioPhoneNumberSid',
  'phoneNumberSid',
  'orpheusSpeechCredentialSid',
  'humeSpeechCredentialSid',
] as const;

const OPENAI_REALTIME_TEMPERATURE_MIN = 0.6;
const OPENAI_REALTIME_TEMPERATURE_MAX = 1.2;
const SUPPORTED_REALTIME_S2S_PROVIDERS = new Set([
  's2s:openai',
  's2s:microsoft',
  's2s:google',
  's2s:grok',
]);
const OPENAI_REALTIME_VOICES = new Set([
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
]);
const GOOGLE_REALTIME_VOICES = new Set([
  'Puck',
  'Kore',
  'Charon',
  'Aoede',
  'Fenrir',
  'Achernar',
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Autonoe',
  'Callirrhoe',
  'Despina',
  'Enceladus',
  'Erinome',
  'Gacrux',
  'Iapetus',
  'Laomedeia',
  'Leda',
  'Orus',
  'Pulcherrima',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Sulafat',
  'Umbriel',
  'Vindemiatrix',
  'Zephyr',
  'Zubenelgenubi',
]);
const GOOGLE_START_SENSITIVITIES = new Set([
  'START_SENSITIVITY_UNSPECIFIED',
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH',
]);
const GOOGLE_END_SENSITIVITIES = new Set([
  'END_SENSITIVITY_UNSPECIFIED',
  'END_SENSITIVITY_LOW',
  'END_SENSITIVITY_HIGH',
]);
const GROK_REALTIME_VOICES = new Set(['ara', 'eve', 'leo', 'rex', 'sal']);

function isByocSip(config: Record<string, unknown>): boolean {
  return config?.provider === 'byoc_sip';
}

/** Parse "192.168.1.100:5080" → { ip: "192.168.1.100", port: 5080 }. Port defaults to 5060. */
function parseSipAddress(raw: string): { ip: string; port: number } {
  const parts = raw.trim().split(':');
  return {
    ip: parts[0],
    port: parts.length > 1 ? parseInt(parts[1], 10) || 5060 : 5060,
  };
}

function getJambonzWebhookUrl(connectionId: string, token: string): string {
  const base =
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL || 'http://localhost:3112';
  const parsed = new URL(base);
  const wsProto = parsed.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${wsProto}://${parsed.host}/ws/korevg/${connectionId}`;
  // TODO(auth-consolidation): Stop provisioning query-token WS URLs once Korevg/Jambonz
  // supports a non-URL auth/bootstrap transport across all supported environments.
  return `${url}?token=${token}`;
}

function getRuntimePublicBaseUrl(): string {
  return (
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL || 'http://localhost:3112'
  );
}

function getOrpheusCustomTtsUrl(tenantId: string, serviceInstanceId?: string): string {
  const parsed = new URL(`${getRuntimePublicBaseUrl()}/api/v1/voice/custom-tts/orpheus`);
  parsed.searchParams.set('tenantId', tenantId);
  if (serviceInstanceId) {
    parsed.searchParams.set('serviceInstanceId', serviceInstanceId);
  }
  return parsed.toString();
}

function getOrpheusCustomTtsStreamingUrl(tenantId: string, serviceInstanceId?: string): string {
  const parsed = new URL(getRuntimePublicBaseUrl());
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws/custom-tts/orpheus';
  parsed.hash = '';
  parsed.searchParams.set('tenantId', tenantId);
  if (serviceInstanceId) {
    parsed.searchParams.set('serviceInstanceId', serviceInstanceId);
  }
  return parsed.toString();
}

function getOrpheusCustomTtsAuthToken(): string {
  const token = process.env.ORPHEUS_TTS_AUTH_TOKEN?.trim();
  if (!token) {
    throw new Error('ORPHEUS_TTS_AUTH_TOKEN is required for custom Orpheus TTS');
  }
  return token;
}

/**
 * Best-effort rollback of Jambonz resources in reverse FK order.
 * Each deletion is independent — if one fails, the rest still attempt.
 */
async function rollbackJambonzResources(
  jambonz: {
    deletePhoneNumber(s: string): Promise<void>;
    deleteSipGateway(s: string): Promise<void>;
    deleteVoipCarrier(s: string): Promise<void>;
    deleteApplication(s: string): Promise<void>;
    deleteSpeechCredential(s: string): Promise<void>;
  },
  sids: {
    phoneNumberSid?: string;
    gatewaySid?: string;
    carrierSid?: string;
    applicationSid?: string;
    speechCredentialSid?: string;
  },
  logger: typeof log,
): Promise<void> {
  if (sids.speechCredentialSid) {
    try {
      await jambonz.deleteSpeechCredential(sids.speechCredentialSid);
    } catch (e: any) {
      logger.warn('Rollback: failed to delete speech credential', {
        sid: sids.speechCredentialSid,
        error: e?.message,
      });
    }
  }
  if (sids.phoneNumberSid) {
    try {
      await jambonz.deletePhoneNumber(sids.phoneNumberSid);
    } catch (e: any) {
      logger.warn('Rollback: failed to delete phone number', {
        sid: sids.phoneNumberSid,
        error: e?.message,
      });
    }
  }
  if (sids.gatewaySid) {
    try {
      await jambonz.deleteSipGateway(sids.gatewaySid);
    } catch (e: any) {
      logger.warn('Rollback: failed to delete SIP gateway', {
        sid: sids.gatewaySid,
        error: e?.message,
      });
    }
  }
  if (sids.carrierSid) {
    try {
      await jambonz.deleteVoipCarrier(sids.carrierSid);
    } catch (e: any) {
      logger.warn('Rollback: failed to delete VoIP carrier', {
        sid: sids.carrierSid,
        error: e?.message,
      });
    }
  }
  if (sids.applicationSid) {
    try {
      await jambonz.deleteApplication(sids.applicationSid);
    } catch (e: any) {
      logger.warn('Rollback: failed to delete application', {
        sid: sids.applicationSid,
        error: e?.message,
      });
    }
  }
}

async function createOrpheusSpeechCredential(params: {
  tenantId: string;
  serviceInstanceId?: string;
  jambonz: {
    createSpeechCredential(input: {
      vendor: string;
      apiKey?: string;
      label: string;
      useForStt: boolean;
      useForTts: boolean;
      authToken?: string;
      customTtsUrl?: string;
      customTtsStreamingUrl?: string;
    }): Promise<string>;
    findSpeechCredentialByVendorAndLabel?(vendor: string, label: string): Promise<string | null>;
  };
}): Promise<string> {
  const label = `t:${params.tenantId}`;
  try {
    return await params.jambonz.createSpeechCredential({
      vendor: 'custom:orpheus',
      label,
      useForStt: false,
      useForTts: true,
      authToken: getOrpheusCustomTtsAuthToken(),
      customTtsUrl: getOrpheusCustomTtsUrl(params.tenantId, params.serviceInstanceId),
      customTtsStreamingUrl: getOrpheusCustomTtsStreamingUrl(
        params.tenantId,
        params.serviceInstanceId,
      ),
    });
  } catch (err: any) {
    const duplicateLabel =
      typeof err?.message === 'string' &&
      err.message.includes('Label') &&
      err.message.includes('already in use');
    if (!duplicateLabel || !params.jambonz.findSpeechCredentialByVendorAndLabel) {
      throw err;
    }

    const existingSid = await params.jambonz.findSpeechCredentialByVendorAndLabel(
      'custom:orpheus',
      label,
    );
    if (!existingSid) {
      throw err;
    }
    return existingSid;
  }
}

function getWebhookUrl(
  channelType: string,
  externalIdentifier?: string,
  provider?: string,
): string | null {
  const baseUrl =
    process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL || 'http://localhost:3112';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  // AI4W uses connectionId-based routing (not webhook path pattern)
  if (channelType === 'ai4w' && externalIdentifier) {
    return `${normalizedBase}/api/v1/channels/ai4w/${externalIdentifier}/message`;
  }

  return buildWebhookUrl(channelType, baseUrl, externalIdentifier, provider);
}

function validateProviderApiBaseOverrides(
  config: Record<string, unknown> | undefined,
): string | null {
  const disallowedKeys = getDisallowedProviderApiBaseOverrides(config);
  if (disallowedKeys.length === 0) {
    return null;
  }

  return (
    'Provider API base URL overrides are only allowed in test mode or when ' +
    `ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE=true (${disallowedKeys.join(', ')})`
  );
}

function validateRealtimeVoiceConfig(
  channelType: string,
  config: Record<string, unknown> | undefined,
): string | null {
  if (channelType !== 'voice_realtime' || !config?.s2sProvider) {
    return null;
  }

  if (
    typeof config.s2sProvider !== 'string' ||
    !SUPPORTED_REALTIME_S2S_PROVIDERS.has(config.s2sProvider)
  ) {
    return 'Realtime voice S2S provider must be one of: s2s:openai, s2s:microsoft, s2s:google, s2s:grok';
  }

  if (typeof config.s2sModel === 'string') {
    const model = config.s2sModel.toLowerCase();
    if (config.s2sProvider === 's2s:openai' && !model.includes('realtime')) {
      return 'OpenAI Realtime model must be a realtime-capable model';
    }
    if (config.s2sProvider === 's2s:google' && !model.includes('gemini')) {
      return 'Google realtime model must be a Gemini model';
    }
    if (config.s2sProvider === 's2s:grok' && !model.includes('grok')) {
      return 'Grok realtime model must be a Grok model';
    }
  }

  if (typeof config.s2sVoice === 'string') {
    if (
      (config.s2sProvider === 's2s:openai' || config.s2sProvider === 's2s:microsoft') &&
      !OPENAI_REALTIME_VOICES.has(config.s2sVoice)
    ) {
      return 'OpenAI Realtime voice is not supported';
    }
    if (config.s2sProvider === 's2s:google' && !GOOGLE_REALTIME_VOICES.has(config.s2sVoice)) {
      return 'Google realtime voice is not supported';
    }
    if (config.s2sProvider === 's2s:grok' && !GROK_REALTIME_VOICES.has(config.s2sVoice)) {
      return 'Grok realtime voice is not supported';
    }
  }

  if (config.s2sTemperature !== undefined && config.s2sTemperature !== null) {
    const usesOpenAITemperatureRange =
      config.s2sProvider === 's2s:openai' || config.s2sProvider === 's2s:microsoft';
    const maxTemperature = usesOpenAITemperatureRange ? 1.2 : 2;
    const minTemperature = usesOpenAITemperatureRange ? 0.6 : 0;

    if (
      typeof config.s2sTemperature !== 'number' ||
      Number.isNaN(config.s2sTemperature) ||
      config.s2sTemperature < minTemperature ||
      config.s2sTemperature > maxTemperature
    ) {
      return `${config.s2sProvider} temperature must be between ${minTemperature} and ${maxTemperature}`;
    }
  }

  if (config.s2sProvider === 's2s:google') {
    if (
      config.s2sStartSensitivity !== undefined &&
      (typeof config.s2sStartSensitivity !== 'string' ||
        !GOOGLE_START_SENSITIVITIES.has(config.s2sStartSensitivity))
    ) {
      return 'Google realtime start sensitivity is not supported';
    }
    if (
      config.s2sEndSensitivity !== undefined &&
      (typeof config.s2sEndSensitivity !== 'string' ||
        !GOOGLE_END_SENSITIVITIES.has(config.s2sEndSensitivity))
    ) {
      return 'Google realtime end sensitivity is not supported';
    }
  }

  return null;
}

/**
 * Validate that required credential fields are present for a channel type.
 *
 * Uses the channel manifest's `requiredCredentials` list as the source of truth.
 * Channel-specific format validations (e.g., Slack bot_token prefix) are applied
 * on top of the generic presence check.
 */
function validateCredentials(
  channelType: ChannelType,
  credentials: Record<string, unknown>,
  config?: Record<string, unknown>,
): string | null {
  // For whatsapp with Infobip provider, validate provider-specific credentials
  if (channelType === 'whatsapp' && config?.provider === 'infobip') {
    const authType = config.authType as string;
    const baseUrlError = validateInfobipBaseUrl(credentials.base_url);
    if (baseUrlError) return baseUrlError;
    if (authType === 'basic') {
      if (!credentials.username || typeof credentials.username !== 'string') {
        return 'Missing required credential: username';
      }
      if (!credentials.password || typeof credentials.password !== 'string') {
        return 'Missing required credential: password';
      }
    } else {
      // Default to API key auth
      if (!credentials.api_key || typeof credentials.api_key !== 'string') {
        return 'Missing required credential: api_key';
      }
    }
    return null;
  }

  // For whatsapp with Netcore provider, validate provider-specific credentials
  if (channelType === 'whatsapp' && config?.provider === 'netcore') {
    if (!credentials.api_key || typeof credentials.api_key !== 'string') {
      return 'Missing required credential: api_key';
    }
    return null;
  }

  // Default: use manifest-based validation (existing logic unchanged)
  const required = getRequiredCredentials(channelType);
  for (const field of required) {
    if (!credentials[field] || typeof credentials[field] !== 'string') {
      return `Missing required credential: ${field}`;
    }
  }

  // Channel-specific format validations
  if (channelType === 'slack') {
    const botToken = credentials.bot_token;
    if (typeof botToken === 'string' && !botToken.startsWith('xoxb-')) {
      return 'bot_token must start with xoxb-';
    }
  }

  return null;
}

function isInfobipWhatsAppConfig(config?: Record<string, unknown>): boolean {
  return config?.provider === 'infobip';
}

function normalizeExternalIdentifierForChannel(
  channelType: ChannelType,
  externalIdentifier: unknown,
  config?: Record<string, unknown>,
): { value?: string; error?: string } {
  if (typeof externalIdentifier !== 'string') {
    return { error: 'external_identifier must be a string' };
  }

  const trimmed = externalIdentifier.trim();
  if (channelType === 'whatsapp' && isInfobipWhatsAppConfig(config)) {
    const normalized = normalizeInfobipPhoneIdentifier(trimmed);
    if (!normalized) {
      return {
        error:
          'Infobip external_identifier must be the WhatsApp sender number in digits only, without +',
      };
    }
    return { value: normalized };
  }

  return { value: trimmed };
}

/** Format a connection document for API response (strip encrypted fields) */
function formatConnection(doc: any, channelType?: string) {
  const type = channelType || doc.channelType;
  const rawConfig = doc.config || {};
  const identityVerification = parseChannelConnectionIdentityVerification(rawConfig);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    inboundAuthToken: _plain,
    encryptedInboundAuthToken: _enc,
    encryptedA2aApiKey: _encA2a,
    ...safeConfig
  } = rawConfig;
  return {
    id: doc._id || doc.id,
    projectId: doc.projectId,
    channelType: type,
    displayName: doc.displayName || null,
    externalIdentifier: doc.externalIdentifier,
    hasCredentials: !!doc.encryptedCredentials,
    config: safeConfig,
    identityVerification,
    status: doc.status || 'active',
    deploymentId: doc.deploymentId || null,
    environment: doc.environment || null,
    webhookUrl: getWebhookUrl(type, doc.externalIdentifier, rawConfig.provider),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// =============================================================================
// ENDPOINTS
// =============================================================================

/**
 * POST /api/projects/:projectId/channel-connections
 * Create a new channel connection with encrypted credentials.
 */
router.post('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel_connection:create'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const {
      channel_type,
      display_name,
      external_identifier,
      credentials,
      config: rawConfig,
      deployment_id,
      environment,
    } = req.body;
    const provisionalConfig =
      rawConfig && typeof rawConfig === 'object'
        ? (rawConfig as Record<string, unknown>)
        : undefined;

    // Validate required fields
    if (!channel_type || !VALID_CHANNEL_TYPES.includes(channel_type)) {
      res.status(400).json({
        success: false,
        error: `Invalid channel_type. Must be one of: ${VALID_CHANNEL_TYPES.join(', ')}`,
      });
      return;
    }
    // For email, auto-generate the inbound address; for other channels, require it
    let resolvedIdentifier =
      typeof external_identifier === 'string' ? external_identifier.trim() : external_identifier;
    if (channel_type === 'email') {
      const domain = process.env.EMAIL_INBOUND_DOMAIN || 'inbound.localhost';
      const shortCode = crypto.randomUUID().split('-')[0];
      resolvedIdentifier = `${shortCode}@${domain}`.toLowerCase();
    } else if (channel_type === 'ai4w') {
      resolvedIdentifier = generateConnectionId();
    } else if (!external_identifier) {
      res
        .status(400)
        .json({ success: false, error: 'Missing required field: external_identifier' });
      return;
    } else {
      const normalizedIdentifier = normalizeExternalIdentifierForChannel(
        channel_type,
        external_identifier,
        provisionalConfig,
      );
      if (normalizedIdentifier.error) {
        res.status(400).json({ success: false, error: normalizedIdentifier.error });
        return;
      }
      if (!normalizedIdentifier.value) {
        res
          .status(400)
          .json({ success: false, error: 'Missing required field: external_identifier' });
        return;
      }
      resolvedIdentifier = normalizedIdentifier.value;
    }

    // Validate Slack external_identifier format: must be "team_id:app_id"
    if (channel_type === 'slack' && !/^T[A-Z0-9]+:A[A-Z0-9]+$/.test(resolvedIdentifier)) {
      res.status(400).json({
        success: false,
        error:
          'Slack external_identifier must be in format "team_id:app_id" (e.g. T12345ABC:A67890XYZ)',
      });
      return;
    }

    // Validate deployment if provided
    if (deployment_id) {
      const deployment = await findDeploymentById(deployment_id, projectId, tenantId);
      if (!deployment) {
        res.status(400).json({ success: false, error: 'Deployment not found' });
        return;
      }
    }

    // Validate environment
    if (environment && !VALID_ENVIRONMENTS.includes(environment)) {
      res.status(400).json({
        success: false,
        error: `Invalid environment. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      });
      return;
    }
    if (deployment_id && environment) {
      res.status(400).json({
        success: false,
        error: 'Cannot set both deployment_id and environment. Use one or the other.',
      });
      return;
    }

    // Auto-resolve deploymentId and agentId from environment/deployment
    let resolvedDeploymentId: string | null = deployment_id || null;
    let resolvedAgentId: string | null = null;

    const resolveAgentId = async (entryAgentName: string | undefined): Promise<string | null> => {
      if (!entryAgentName) return null;
      const { ProjectAgent } = await import('@agent-platform/database/models');
      const agent = await ProjectAgent.findOne({
        tenantId,
        projectId,
        name: entryAgentName,
      }).lean();
      return agent ? ((agent as any)._id as string) : null;
    };

    if (deployment_id) {
      // deployment_id explicitly provided — resolve agentId from it
      const deployment = await findDeploymentById(deployment_id, projectId, tenantId);
      resolvedAgentId = await resolveAgentId(deployment?.entryAgentName);
    } else if (environment) {
      // environment provided — look up active deployment for this environment
      const activeDeployment = await findActiveDeployment(projectId, tenantId, environment);
      if (activeDeployment) {
        resolvedDeploymentId = (activeDeployment._id ?? activeDeployment.id) as string;
        resolvedAgentId = await resolveAgentId(activeDeployment.entryAgentName);
        log.info('Auto-resolved deployment for channel connection', {
          environment,
          deploymentId: resolvedDeploymentId,
          agentId: resolvedAgentId,
        });
      }
    }

    // Validate credentials — plugin encrypts encryptedCredentials in pre-save hook
    const identityVerificationConfig = normalizeChannelConnectionIdentityVerificationConfig({
      body: req.body as Record<string, unknown>,
      config: rawConfig,
    });
    if ('error' in identityVerificationConfig) {
      res.status(400).json({ success: false, error: identityVerificationConfig.error.message });
      return;
    }

    let encryptedCredentials: string | undefined;
    const normalizedConfig = identityVerificationConfig.config;
    const providerApiBaseError = validateProviderApiBaseOverrides(normalizedConfig);
    if (providerApiBaseError) {
      res.status(400).json({ success: false, error: providerApiBaseError });
      return;
    }
    const realtimeConfigError = validateRealtimeVoiceConfig(channel_type, normalizedConfig);
    if (realtimeConfigError) {
      res.status(400).json({ success: false, error: realtimeConfigError });
      return;
    }
    if (credentials && Object.keys(credentials).length > 0) {
      const credError = validateCredentials(channel_type, credentials, normalizedConfig);
      if (credError) {
        res.status(400).json({ success: false, error: credError });
        return;
      }

      encryptedCredentials = JSON.stringify(credentials);
    }

    const { ChannelConnection } = await import('@agent-platform/database/models');

    // Compute verify_token hash for indexed webhook verification lookup
    const verifyTokenHash = credentials?.verify_token
      ? hashVerifyToken(credentials.verify_token)
      : null;

    // For AI4W connections: auto-generate connectionSecret and encrypt it
    let ai4wConnectionSecret: string | null = null;
    const safeConfig = normalizedConfig || {};
    if (channel_type === 'ai4w') {
      ai4wConnectionSecret = generateConnectionSecret();
      // Store as raw JSON — the encryptionPlugin on ChannelConnectionSchema
      // auto-encrypts the encryptedCredentials field on save
      encryptedCredentials = JSON.stringify({ connectionSecret: ai4wConnectionSecret });
      // Store a non-secret prefix so the UI can show a masked reference
      safeConfig.secretPrefix = ai4wConnectionSecret.slice(0, 10);
      // Mark provenance explicitly. Auto-provisioned connections from the
      // internal discovery API set this to 'api'; Studio-driven creation is
      // 'manual' — the lifecycle guard on /api/internal/v1 relies on this
      // field to decide whether to allow rotate/deactivate/unlink.
      safeConfig.provisionedBy = 'manual';
    }

    // For A2A connections: encrypt the inbound API key before storing in config
    if (channel_type === 'a2a' && safeConfig.a2aApiKey !== undefined) {
      const rawKey = safeConfig.a2aApiKey;
      delete safeConfig.a2aApiKey;
      if (rawKey && typeof rawKey === 'string' && rawKey.length > 0) {
        if (!isTenantEncryptionReady()) {
          res.status(503).json({
            success: false,
            error: 'Tenant DEK encryption is not initialized. Cannot store A2A API keys.',
          });
          return;
        }
        safeConfig.encryptedA2aApiKey = await encryptForTenantAuto(rawKey, tenantId, projectId);
      }
    }

    const doc = await ChannelConnection.create({
      tenantId,
      projectId,
      channelType: channel_type,
      displayName: display_name || null,
      externalIdentifier: resolvedIdentifier,
      encryptedCredentials: encryptedCredentials || null,
      verifyTokenHash,
      config: safeConfig,
      status: 'active',
      deploymentId: resolvedDeploymentId,
      agentId: resolvedAgentId,
      environment: environment || null,
      // AI4W connections use connectionId for routing (stored as indexed field)
      ...(channel_type === 'ai4w' ? { connectionId: resolvedIdentifier } : {}),
    });

    log.info('Channel connection created', {
      channelType: channel_type,
      tenantId,
      projectId,
    });

    // Telegram webhook auto-registration
    if (channel_type === 'telegram' && credentials?.bot_token) {
      try {
        const secretToken = randomBytes(32).toString('hex');
        const baseUrl =
          process.env.RUNTIME_PUBLIC_BASE_URL ||
          process.env.RUNTIME_BASE_URL ||
          'http://localhost:3112';
        const webhookUrl = buildWebhookUrl('telegram', baseUrl, resolvedIdentifier);

        if (webhookUrl) {
          const telegramApiBase = resolveProviderApiBase({
            config: normalizedConfig as Record<string, unknown> | undefined,
            envVar: 'TELEGRAM_API_BASE_URL',
            defaultBaseUrl: 'https://api.telegram.org',
            providerConfigKey: 'telegramApiBaseUrl',
          });

          const setWebhookResp = await fetch(
            `${telegramApiBase}/bot${credentials.bot_token}/setWebhook`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: webhookUrl,
                secret_token: secretToken,
                allowed_updates: ['message', 'callback_query'],
              }),
              signal: AbortSignal.timeout(15_000),
            },
          );

          if (!setWebhookResp.ok) {
            const errText = await setWebhookResp.text();
            log.error('Telegram setWebhook failed', { error: errText });
            await ChannelConnection.findOneAndDelete({ _id: doc._id }).catch((e: unknown) => {
              log.error('Failed to clean up connection after setWebhook failure', { err: e });
            });
            res.status(400).json({
              success: false,
              error: `Telegram webhook registration failed: ${errText}`,
            });
            return;
          }

          // Store secret_token in encrypted credentials — use save() so encryption plugin fires
          const updatedCreds = { ...(credentials || {}), secret_token: secretToken };
          const connDoc = await ChannelConnection.findOne({ _id: doc._id, tenantId });
          if (connDoc) {
            connDoc.encryptedCredentials = JSON.stringify(updatedCreds);
            await connDoc.save();
          }

          log.info('Telegram webhook registered', {
            connectionId: doc._id,
            webhookUrl,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Telegram webhook registration error', { error: errMsg });
        // Non-fatal — connection is created, user can set webhook manually
      }
    }

    // Jambonz provisioning for voice channels (skip external gateways like AudioCodes)
    if (VOICE_CHANNEL_TYPES.has(channel_type) && !EXTERNAL_VOICE_GATEWAYS.has(channel_type)) {
      // Track created Jambonz resources outside try so catch can roll them back
      const created: {
        applicationSid?: string;
        carrierSid?: string;
        gatewaySid?: string;
        phoneNumberSid?: string;
        speechCredentialSid?: string;
      } = {};
      let jambonz: Awaited<
        ReturnType<
          (typeof import('../services/voice/jambonz-provisioning.service.js'))['getJambonzProvisioningService']
        >
      > | null = null;

      try {
        const { getJambonzProvisioningService } =
          await import('../services/voice/jambonz-provisioning.service.js');
        jambonz = getJambonzProvisioningService();
        const { randomBytes } = await import('crypto');
        const inboundAuthToken = randomBytes(32).toString('hex');
        const webhookUrl = getJambonzWebhookUrl(doc._id as string, inboundAuthToken);
        const voiceCfg = (normalizedConfig || {}) as Record<string, unknown>;
        if (voiceCfg.ttsVendor === 'custom:orpheus') {
          created.speechCredentialSid = await createOrpheusSpeechCredential({
            tenantId,
            serviceInstanceId: voiceCfg.ttsServiceInstanceId as string | undefined,
            jambonz,
          });
        }

        // Use tenant-scoped label so Jambonz resolves the correct speech credentials
        const tenantSpeechLabel = `t:${tenantId}`;
        const connectionId = doc._id as string;
        const jambonzAppName = `${display_name || resolvedIdentifier} [${connectionId.slice(0, 8)}]`;
        created.applicationSid = await jambonz.createApplication({
          name: jambonzAppName,
          webhookUrl,
          asrVendor: voiceCfg.asrVendor as string | undefined,
          asrLanguage: voiceCfg.asrLanguage as string | undefined,
          asrRegion: tenantSpeechLabel,
          ttsVendor: voiceCfg.ttsVendor as string | undefined,
          ttsLanguage: voiceCfg.ttsLanguage as string | undefined,
          ttsVoice: voiceCfg.ttsVoice as string | undefined,
          ttsRegion: tenantSpeechLabel,
        });

        const encryptedInboundAuthToken = await encryptForTenantAuto(
          inboundAuthToken,
          tenantId,
          projectId,
        );
        const configUpdate: Record<string, unknown> = {
          'config.jambonzApplicationSid': created.applicationSid,
          'config.encryptedInboundAuthToken': encryptedInboundAuthToken,
        };
        if (created.speechCredentialSid) {
          configUpdate['config.orpheusSpeechCredentialSid'] = created.speechCredentialSid;
        }

        // BYOC SIP: create per-connection VoIP carrier + SIP gateway
        if (isByocSip(voiceCfg)) {
          const rawSipAddress = voiceCfg.sipGatewayIp as string;

          if (!rawSipAddress) {
            await rollbackJambonzResources(jambonz, created, log);
            await ChannelConnection.deleteOne({ _id: doc._id });
            res
              .status(400)
              .json({ success: false, error: 'sipGatewayIp is required for BYOC SIP' });
            return;
          }

          const { ip: sipIp, port: sipPort } = parseSipAddress(rawSipAddress);
          const carrierName = `byoc-${jambonzAppName}`;
          created.carrierSid = await jambonz.createVoipCarrier({ name: carrierName });

          created.gatewaySid = await jambonz.addSipGateway({
            voipCarrierSid: created.carrierSid,
            ipv4: sipIp,
            port: sipPort,
            inbound: true,
            outbound: false,
          });

          configUpdate['config.jambonzVoipCarrierSid'] = created.carrierSid;
          configUpdate['config.jambonzSipGatewaySid'] = created.gatewaySid;
          configUpdate['config.sipGatewayIp'] = rawSipAddress;

          // Register customer's DID under the BYOC carrier
          const did = voiceCfg.phoneNumber as string;
          if (did && created.applicationSid) {
            try {
              created.phoneNumberSid = await jambonz.addPhoneNumber({
                phoneNumber: did,
                applicationSid: created.applicationSid,
                voipCarrierSid: created.carrierSid,
              });
              configUpdate['config.jambonzPhoneNumberSid'] = created.phoneNumberSid;
              configUpdate['config.phoneNumber'] = did;
            } catch (err: any) {
              log.warn('Failed to register BYOC DID in Jambonz', { did, error: err?.message });
            }
          }
        } else {
          // Non-BYOC: register phone number with shared Twilio carrier (if provided)
          const did = voiceCfg.phoneNumber as string;
          if (did && created.applicationSid) {
            const { getConfig } = await import('../config/index.js');
            const jambonzCfg = getConfig().voice?.jambonz ?? {};
            if (jambonzCfg.voipCarrierSid) {
              try {
                created.phoneNumberSid = await jambonz.addPhoneNumber({
                  phoneNumber: did,
                  applicationSid: created.applicationSid,
                });
                configUpdate['config.jambonzPhoneNumberSid'] = created.phoneNumberSid;
                configUpdate['config.phoneNumber'] = did;
              } catch (err: any) {
                log.warn('Failed to register DID in Jambonz', { did, error: err?.message });
              }
            }
          }
        }

        await ChannelConnection.findOneAndUpdate(
          { _id: doc._id, tenantId, projectId },
          { $set: configUpdate },
        );
        // Rebuild in-memory doc.config from the flat dot-key update
        const configPatch: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(configUpdate)) {
          const field = key.startsWith('config.') ? key.slice('config.'.length) : key;
          configPatch[field] = val;
        }
        (doc as any).config = {
          ...(doc as any).config,
          ...configPatch,
        };
        log.info('Jambonz provisioning complete on create', {
          applicationSid: created.applicationSid,
          speechCredentialSid: created.speechCredentialSid,
        });
      } catch (err: any) {
        // Provisioning failed — roll back Jambonz resources and DB record
        if (jambonz) {
          await rollbackJambonzResources(jambonz, created, log);
        }
        await ChannelConnection.findOneAndDelete({ _id: doc._id }).catch((e: unknown) => {
          log.error('Failed to clean up connection after provisioning failure', { err: e });
        });
        log.error('Jambonz provisioning failed on create', { error: err?.message });
        res.status(502).json({
          success: false,
          error: `Voice gateway provisioning failed: ${err?.message}`,
        });
        return;
      }
    }

    const response: Record<string, unknown> = {
      success: true,
      connection: formatConnection(doc, channel_type),
    };

    // AI4W: include one-time connectionSecret reveal (cannot be retrieved again)
    if (channel_type === 'ai4w' && ai4wConnectionSecret) {
      response.ai4w = {
        connectionId: resolvedIdentifier,
        connectionSecret: ai4wConnectionSecret,
        note: 'Store the connectionSecret securely — it is shown only once and cannot be retrieved again.',
      };
    }

    res.status(201).json(response);
  } catch (err: any) {
    if (err?.code === 11000) {
      res.status(409).json({
        success: false,
        error: 'A connection with this channel type and identifier already exists',
      });
      return;
    }
    log.error('Failed to create channel connection', { error: err?.message });
    res.status(500).json({ success: false, error: 'Failed to create channel connection' });
  }
});

/**
 * GET /api/projects/:projectId/channel-connections
 * List connections for a project, optionally filtered by channel_type.
 */
router.get('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel_connection:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;

    const filter: Record<string, unknown> = { tenantId, projectId };
    const channelType = req.query.channel_type as string;
    if (channelType) filter.channelType = channelType;

    const { ChannelConnection } = await import('@agent-platform/database/models');
    const docs = await ChannelConnection.find(filter).sort({ createdAt: -1 }).lean();

    res.json({
      success: true,
      connections: docs.map((d: any) => formatConnection(d)),
    });
  } catch (err: any) {
    log.error('Failed to list channel connections', { error: err?.message });
    res.status(500).json({ success: false, error: 'Failed to list channel connections' });
  }
});

/**
 * GET /sbc-address
 * Returns the Jambonz SBC address(es) for BYOC SIP configuration.
 * Supports comma-separated list: JAMBONZ_SBC_ADDRESS=sbc1.example.com:5060,sbc2.example.com:5060
 */
router.get('/sbc-address', async (req, res) => {
  try {
    const { getConfig } = await import('../config/index.js');
    const jambonzCfg = getConfig().voice?.jambonz ?? {};
    const sbcAddress = jambonzCfg.sbcAddress;
    if (!sbcAddress) {
      res.status(404).json({ success: false, error: 'SBC address not configured' });
      return;
    }
    const addresses = sbcAddress
      .split(',')
      .map((a: string) => a.trim())
      .filter(Boolean);
    res.json({ success: true, sbcAddresses: addresses });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to get SBC address' });
  }
});

/**
 * GET /api/projects/:projectId/channel-connections/:id
 * Get a single connection.
 */
router.get('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel_connection:read'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { ChannelConnection } = await import('@agent-platform/database/models');
    const projectId = (req.params as Record<string, string>).projectId;
    const doc = await ChannelConnection.findOne({ _id: req.params.id, tenantId, projectId }).lean();

    if (!doc) {
      res.status(404).json({ success: false, error: 'Channel connection not found' });
      return;
    }

    res.json({
      success: true,
      connection: formatConnection(doc),
    });
  } catch (err: any) {
    log.error('Failed to get channel connection', { error: err?.message });
    res.status(500).json({ success: false, error: 'Failed to get channel connection' });
  }
});

/**
 * PATCH /api/projects/:projectId/channel-connections/:id
 * Update connection (display name, credentials, config, status, deployment_id).
 */
router.patch('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel_connection:update'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const { ChannelConnection } = await import('@agent-platform/database/models');
    const projectId = (req.params as Record<string, string>).projectId;
    const existing = await ChannelConnection.findOne({
      _id: req.params.id,
      tenantId,
      projectId,
    }).lean();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Channel connection not found' });
      return;
    }

    const {
      display_name,
      credentials,
      config: rawConfig,
      status,
      external_identifier,
      deployment_id,
      environment,
      rotate_secret,
    } = req.body;
    const updates: Record<string, unknown> = {};
    let rotatedConnectionSecret: string | null = null;
    const existingConfig =
      existing && typeof (existing as any).config === 'object' && (existing as any).config
        ? ((existing as any).config as Record<string, unknown>)
        : {};

    const identityVerificationConfig = normalizeChannelConnectionIdentityVerificationConfig({
      body: req.body as Record<string, unknown>,
      config: rawConfig,
      existingConfig,
    });
    if ('error' in identityVerificationConfig) {
      res.status(400).json({ success: false, error: identityVerificationConfig.error.message });
      return;
    }

    let normalizedConfig = identityVerificationConfig.config;

    if (display_name !== undefined) updates.displayName = display_name;
    if (external_identifier !== undefined) {
      const effectiveConfigForIdentifier = normalizedConfig ?? existingConfig;
      const normalizedIdentifier = normalizeExternalIdentifierForChannel(
        (existing as any).channelType,
        external_identifier,
        effectiveConfigForIdentifier,
      );
      if (normalizedIdentifier.error) {
        res.status(400).json({ success: false, error: normalizedIdentifier.error });
        return;
      }
      if (!normalizedIdentifier.value) {
        res
          .status(400)
          .json({ success: false, error: 'Missing required field: external_identifier' });
        return;
      }
      updates.externalIdentifier = normalizedIdentifier.value;
    }
    if (normalizedConfig !== undefined) {
      const providerApiBaseError = validateProviderApiBaseOverrides(normalizedConfig);
      if (providerApiBaseError) {
        res.status(400).json({ success: false, error: providerApiBaseError });
        return;
      }

      // Preserve hidden voice gateway auth token across config edits. The PATCH
      // API replaces the whole config object, but voice channels carry several
      // provisioned gateway identifiers that callers should not need to resubmit.
      if (VOICE_CHANNEL_TYPES.has((existing as any).channelType)) {
        for (const field of PRESERVED_VOICE_CONFIG_FIELDS) {
          if (existingConfig[field] !== undefined && normalizedConfig[field] === undefined) {
            normalizedConfig[field] = existingConfig[field];
          }
        }

        const realtimeConfigFieldsToPreserve = [
          'mode',
          's2sProvider',
          's2sModel',
          's2sVoice',
          's2sTemperature',
          's2sThreshold',
          's2sStartSensitivity',
          's2sEndSensitivity',
          's2sTurnDetection',
          's2sSilenceDuration',
          's2sPrefixPadding',
          's2sAgentId',
          's2sConversationId',
        ] as const;
        for (const field of realtimeConfigFieldsToPreserve) {
          if (existingConfig[field] !== undefined && normalizedConfig[field] === undefined) {
            normalizedConfig[field] = existingConfig[field];
          }
        }

        if (normalizedConfig.inboundAuthToken === undefined) {
          delete normalizedConfig.inboundAuthToken;
        }
      }

      const realtimeConfigError = validateRealtimeVoiceConfig(
        (existing as any).channelType,
        normalizedConfig,
      );
      if (realtimeConfigError) {
        res.status(400).json({ success: false, error: realtimeConfigError });
        return;
      }

      // For A2A connections: encrypt the inbound API key before storing in config
      if ((existing as any).channelType === 'a2a' && normalizedConfig.a2aApiKey !== undefined) {
        const rawKey = normalizedConfig.a2aApiKey;
        delete normalizedConfig.a2aApiKey; // Remove plaintext from config
        if (rawKey && typeof rawKey === 'string' && rawKey.length > 0) {
          if (!isTenantEncryptionReady()) {
            res.status(503).json({
              success: false,
              error: 'Tenant DEK encryption is not initialized. Cannot store A2A API keys.',
            });
            return;
          }
          normalizedConfig.encryptedA2aApiKey = await encryptForTenantAuto(
            rawKey,
            tenantId,
            (req.params as Record<string, string>).projectId,
          );
        } else {
          // Null or empty string → remove the API key (disable auth)
          delete normalizedConfig.encryptedA2aApiKey;
        }
      }
      updates.config = normalizedConfig;
    }
    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        res.status(400).json({ success: false, error: 'Status must be active or inactive' });
        return;
      }
      updates.status = status;
    }

    // Validate and encrypt credentials
    if (credentials !== undefined) {
      if (credentials && Object.keys(credentials).length > 0) {
        const effectiveConfig = normalizedConfig ?? (existing as any).config;
        const credError = validateCredentials(
          (existing as any).channelType,
          credentials,
          effectiveConfig,
        );
        if (credError) {
          res.status(400).json({ success: false, error: credError });
          return;
        }
        // Plugin encrypts encryptedCredentials transparently in pre-save hook
        updates.encryptedCredentials = JSON.stringify(credentials);
        // Recompute verify_token hash when credentials change
        updates.verifyTokenHash = credentials.verify_token
          ? hashVerifyToken(credentials.verify_token)
          : null;
      } else {
        updates.encryptedCredentials = null;
        updates.verifyTokenHash = null;
      }
    }

    // Validate deployment if provided
    if (deployment_id !== undefined) {
      if (deployment_id !== null) {
        const deployment = await findDeploymentById(
          deployment_id,
          (existing as any).projectId,
          tenantId,
        );
        if (!deployment) {
          res.status(400).json({ success: false, error: 'Deployment not found' });
          return;
        }
      }
      updates.deploymentId = deployment_id;
    }

    // Validate environment
    if (environment !== undefined) {
      if (environment !== null && !VALID_ENVIRONMENTS.includes(environment)) {
        res.status(400).json({
          success: false,
          error: `Invalid environment. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
        });
        return;
      }
      updates.environment = environment;
      // Clear deploymentId when setting environment
      if (environment !== null) {
        updates.deploymentId = null;
      }
    }
    // Clear environment when setting deploymentId
    if (deployment_id !== undefined && deployment_id !== null) {
      updates.environment = null;
    }

    // AI4W: rotate connectionSecret when requested
    if (rotate_secret === true && (existing as any).channelType === 'ai4w') {
      const newSecret = generateConnectionSecret();
      rotatedConnectionSecret = newSecret;
      updates.encryptedCredentials = JSON.stringify({ connectionSecret: newSecret });
      // Update the non-secret prefix stored in config for masked UI display
      const configObj =
        typeof updates.config === 'object' && updates.config
          ? (updates.config as Record<string, unknown>)
          : { ...existingConfig };
      configObj.secretPrefix = newSecret.slice(0, 10);
      updates.config = configObj;
    }

    // Use findOne + save() so the encryption plugin's pre-save hook fires
    const updateDoc = await ChannelConnection.findOne({ _id: req.params.id, tenantId, projectId });
    if (!updateDoc) {
      res.status(404).json({ success: false, error: 'Connection not found' });
      return;
    }
    for (const [key, value] of Object.entries(updates)) {
      updateDoc.set(key, value);
    }
    // Schema.Types.Mixed fields (config, encryptedCredentials) need markModified
    // so Mongoose detects changes and persists them on save().
    if (updates.config !== undefined) updateDoc.markModified('config');
    if (updates.encryptedCredentials !== undefined) updateDoc.markModified('encryptedCredentials');
    await updateDoc.save();
    const updated = updateDoc.toObject();

    log.info('Channel connection updated', { id: req.params.id, tenantId });

    // Jambonz sync for voice channels when config changes (skip external gateways)
    const warnings: string[] = [];
    if (
      VOICE_CHANNEL_TYPES.has((existing as any).channelType) &&
      !EXTERNAL_VOICE_GATEWAYS.has((existing as any).channelType) &&
      normalizedConfig !== undefined
    ) {
      try {
        const { getJambonzProvisioningService } =
          await import('../services/voice/jambonz-provisioning.service.js');
        const jambonz = getJambonzProvisioningService();
        const existingVoiceConfig = ((existing as any).config || {}) as Record<string, unknown>;
        const newConfig = (normalizedConfig || {}) as Record<string, unknown>;
        let applicationSid =
          (newConfig.jambonzApplicationSid as string | undefined) ||
          (existingVoiceConfig.jambonzApplicationSid as string | undefined);

        if (applicationSid) {
          // Try to decrypt auth token for webhook URL reconstruction.
          // If decryption fails, we still update speech settings — updateApplication
          // fetches the existing call_hook from Jambonz and preserves it when no
          // webhookUrl is provided.
          let inboundAuthTokenForWebhook: string | undefined;
          if (existingVoiceConfig.encryptedInboundAuthToken) {
            try {
              inboundAuthTokenForWebhook = await decryptForTenantAuto(
                existingVoiceConfig.encryptedInboundAuthToken as string,
                tenantId,
              );
            } catch (decryptErr: any) {
              log.warn('Could not decrypt inboundAuthToken; webhook URL will not be updated', {
                id: req.params.id,
                error: decryptErr?.message,
              });
            }
          }

          // Use tenant-scoped label so Jambonz resolves the correct speech credentials
          const tenantSpeechLabel = `t:${tenantId}`;
          const webhookUrl = inboundAuthTokenForWebhook
            ? getJambonzWebhookUrl(req.params.id, inboundAuthTokenForWebhook)
            : undefined;
          const displayLabel =
            display_name || (existing as any).displayName || (existing as any).externalIdentifier;
          const jambonzAppName = `${displayLabel} [${req.params.id.slice(0, 8)}]`;

          const appConfig = {
            name: jambonzAppName,
            webhookUrl: webhookUrl || '', // empty string signals updateApplication to keep existing hooks
            asrVendor: (newConfig.asrVendor ?? existingVoiceConfig.asrVendor) as string | undefined,
            asrLanguage: (newConfig.asrLanguage ?? existingVoiceConfig.asrLanguage) as
              | string
              | undefined,
            asrRegion: tenantSpeechLabel,
            ttsVendor: (newConfig.ttsVendor ?? existingVoiceConfig.ttsVendor) as string | undefined,
            ttsLanguage: (newConfig.ttsLanguage ?? existingVoiceConfig.ttsLanguage) as
              | string
              | undefined,
            ttsVoice: (newConfig.ttsVoice ?? existingVoiceConfig.ttsVoice) as string | undefined,
            ttsRegion: tenantSpeechLabel,
          };

          try {
            await jambonz.updateApplication(applicationSid, appConfig);
            log.info('Jambonz application updated on patch', { applicationSid });
          } catch (updateErr: any) {
            // If application not found (404), create a new one
            const is404 = updateErr?.message?.includes('404') || updateErr?.statusCode === 404;
            if (is404) {
              log.warn('Jambonz application not found, creating new one', {
                oldApplicationSid: applicationSid,
                error: updateErr?.message,
              });
              try {
                // Generate new token and webhook URL for creation (required for new apps)
                const { randomBytes } = await import('crypto');
                const newInboundAuthToken = randomBytes(32).toString('hex');
                const newWebhookUrl = getJambonzWebhookUrl(req.params.id, newInboundAuthToken);

                const createAppConfig = {
                  ...appConfig,
                  webhookUrl: newWebhookUrl, // Valid URL required for creation
                };

                const newApplicationSid = await jambonz.createApplication(createAppConfig);

                // Store new token and application SID in DB, clear old phone number SID
                const encryptedToken = await encryptForTenantAuto(
                  newInboundAuthToken,
                  tenantId,
                  projectId,
                );
                await ChannelConnection.findOneAndUpdate(
                  { _id: req.params.id, tenantId, projectId },
                  {
                    $set: {
                      'config.jambonzApplicationSid': newApplicationSid,
                      'config.encryptedInboundAuthToken': encryptedToken,
                    },
                    $unset: {
                      'config.jambonzPhoneNumberSid': '',
                    },
                  },
                );
                // Update in-memory config for subsequent logic
                const oldAppSid = applicationSid;
                newConfig.jambonzApplicationSid = newApplicationSid;
                applicationSid = newApplicationSid; // Update for phone number registration

                // Delete old phone number registration (tied to deleted application)
                const oldPhoneSid = existingVoiceConfig.jambonzPhoneNumberSid as string | undefined;
                if (oldPhoneSid) {
                  try {
                    await jambonz.deletePhoneNumber(oldPhoneSid);
                    log.info('Deleted old phone number registration after app recreation', {
                      phoneNumberSid: oldPhoneSid,
                    });
                  } catch (delErr: any) {
                    // Ignore errors - phone number may already be gone
                    log.debug('Could not delete old phone number (may already be gone)', {
                      phoneNumberSid: oldPhoneSid,
                      error: delErr?.message,
                    });
                  }
                }

                // Clear old phone number SID to force re-registration with new application
                delete existingVoiceConfig.jambonzPhoneNumberSid;

                log.info('Jambonz application recreated on patch', {
                  oldApplicationSid: oldAppSid,
                  newApplicationSid,
                });
              } catch (createErr: any) {
                log.error('Failed to recreate Jambonz application after 404', {
                  error: createErr?.message,
                });
                throw createErr;
              }
            } else {
              // Non-404 error, rethrow
              throw updateErr;
            }
          }
        }

        // Collect config updates to write back after all Jambonz operations
        const configUpdate: Record<string, unknown> = {};
        const effectiveTtsVendor = (newConfig.ttsVendor ?? existingVoiceConfig.ttsVendor) as
          | string
          | undefined;
        const effectiveOrpheusServiceInstanceId = (newConfig.ttsServiceInstanceId ??
          existingVoiceConfig.ttsServiceInstanceId) as string | undefined;
        const existingOrpheusSpeechCredentialSid =
          existingVoiceConfig.orpheusSpeechCredentialSid as string | undefined;
        const existingOrpheusServiceInstanceId = existingVoiceConfig.ttsServiceInstanceId as
          | string
          | undefined;
        const shouldRecreateOrpheusSpeechCredential =
          effectiveTtsVendor === 'custom:orpheus' &&
          effectiveOrpheusServiceInstanceId !== existingOrpheusServiceInstanceId;

        try {
          if (
            effectiveTtsVendor === 'custom:orpheus' &&
            (!existingOrpheusSpeechCredentialSid || shouldRecreateOrpheusSpeechCredential)
          ) {
            if (existingOrpheusSpeechCredentialSid && shouldRecreateOrpheusSpeechCredential) {
              await jambonz.deleteSpeechCredential(existingOrpheusSpeechCredentialSid);
            }
            const speechCredentialSid = await createOrpheusSpeechCredential({
              tenantId,
              serviceInstanceId: effectiveOrpheusServiceInstanceId,
              jambonz,
            });
            configUpdate['config.orpheusSpeechCredentialSid'] = speechCredentialSid;
            newConfig.orpheusSpeechCredentialSid = speechCredentialSid;
            log.info('Created Orpheus speech credential on patch', {
              id: req.params.id,
              speechCredentialSid,
            });
          } else if (
            effectiveTtsVendor !== 'custom:orpheus' &&
            typeof existingOrpheusSpeechCredentialSid === 'string' &&
            existingOrpheusSpeechCredentialSid.length > 0
          ) {
            await jambonz.deleteSpeechCredential(existingOrpheusSpeechCredentialSid);
            configUpdate['config.orpheusSpeechCredentialSid'] = null;
            delete newConfig.orpheusSpeechCredentialSid;
            log.info('Deleted Orpheus speech credential on patch', {
              id: req.params.id,
              speechCredentialSid: existingOrpheusSpeechCredentialSid,
            });
          }
        } catch (speechCredentialErr: any) {
          warnings.push('Failed to sync Orpheus speech credential with voice gateway');
          log.warn('Failed to sync Orpheus speech credential on patch', {
            id: req.params.id,
            error: speechCredentialErr?.message,
          });
        }

        // BYOC SIP: create carrier if switching from non-BYOC to BYOC
        if (isByocSip(newConfig) && !isByocSip(existingVoiceConfig)) {
          const existingCarrierSid = existingVoiceConfig.jambonzVoipCarrierSid as
            | string
            | undefined;
          if (!existingCarrierSid) {
            try {
              const displayLabel =
                display_name ||
                (existing as any).displayName ||
                (existing as any).externalIdentifier;
              const jambonzAppName = `${displayLabel} [${req.params.id.slice(0, 8)}]`;
              const carrierName = `byoc-${jambonzAppName}`;
              const newCarrierSid = await jambonz.createVoipCarrier({ name: carrierName });
              configUpdate['config.jambonzVoipCarrierSid'] = newCarrierSid;
              newConfig.jambonzVoipCarrierSid = newCarrierSid; // Update in-memory for subsequent logic
              log.info('Created BYOC VoIP carrier on PATCH', {
                carrierSid: newCarrierSid,
                id: req.params.id,
              });
            } catch (e: any) {
              log.error('Failed to create BYOC carrier on PATCH', { error: e?.message });
              warnings.push('Failed to create VoIP carrier in voice gateway');
            }
          }
        }

        // BYOC SIP: update SIP gateway IP if changed
        if (isByocSip(newConfig) || isByocSip(existingVoiceConfig)) {
          const newSipRaw = newConfig.sipGatewayIp as string | undefined;
          const existingSipRaw = existingVoiceConfig.sipGatewayIp as string | undefined;

          if (newSipRaw && newSipRaw !== existingSipRaw) {
            const { ip: newSipIp, port: newSipPort } = parseSipAddress(newSipRaw);
            const carrierSid = (newConfig.jambonzVoipCarrierSid ||
              existingVoiceConfig.jambonzVoipCarrierSid) as string;
            const oldGatewaySid = existingVoiceConfig.jambonzSipGatewaySid as string;

            if (carrierSid) {
              if (oldGatewaySid) {
                try {
                  await jambonz.deleteSipGateway(oldGatewaySid);
                } catch (e: any) {
                  log.warn('Failed to delete old SIP gateway', { error: e?.message });
                }
              }
              try {
                const newGatewaySid = await jambonz.addSipGateway({
                  voipCarrierSid: carrierSid,
                  ipv4: newSipIp,
                  port: newSipPort,
                  inbound: true,
                  outbound: false,
                });
                configUpdate['config.jambonzSipGatewaySid'] = newGatewaySid;
                configUpdate['config.sipGatewayIp'] = newSipRaw;
              } catch (e: any) {
                log.error('Failed to add new SIP gateway', { error: e?.message });
                warnings.push('Failed to update SIP gateway IP in voice gateway');
              }
            }
          }

          // BYOC phone number change OR missing registration — use BYOC carrier
          const newDid = newConfig.phoneNumber as string | undefined;
          const existingDid = existingVoiceConfig.phoneNumber as string | undefined;
          let existingPhoneSid = existingVoiceConfig.jambonzPhoneNumberSid as string | undefined;

          // Always attempt registration if DID exists (handles stale SID in DB)
          // Duplicate errors are handled gracefully below
          const needsRegistration = newDid && applicationSid;

          log.debug('BYOC phone number registration check', {
            newDid,
            existingDid,
            existingPhoneSid,
            needsRegistration,
            carrierSid:
              newConfig.jambonzVoipCarrierSid || existingVoiceConfig.jambonzVoipCarrierSid,
            applicationSid,
          });

          if (needsRegistration) {
            let carrierSid = (newConfig.jambonzVoipCarrierSid ||
              existingVoiceConfig.jambonzVoipCarrierSid) as string | undefined;

            // If no per-connection carrier, use shared carrier from global config
            if (!carrierSid) {
              const { getConfig } = await import('../config/index.js');
              const jambonzCfg = getConfig().voice?.jambonz ?? {};
              carrierSid = jambonzCfg.voipCarrierSid as string | undefined;
              log.debug('Using shared BYOC carrier from config', { carrierSid });
            }

            const oldPhoneSid = existingVoiceConfig.jambonzPhoneNumberSid as string;

            // Delete old registration if number changed
            if (oldPhoneSid && newDid !== existingDid) {
              try {
                await jambonz.deletePhoneNumber(oldPhoneSid);
              } catch (e: any) {
                const is404 = e?.message?.includes('404') || e?.statusCode === 404;
                if (is404) {
                  log.info(
                    'Old BYOC phone number already deleted (404), proceeding with new registration',
                    {
                      oldPhoneNumberSid: oldPhoneSid,
                    },
                  );
                } else {
                  log.warn('Failed to delete old BYOC phone number', { error: e?.message });
                }
              }
            }

            if (carrierSid && applicationSid) {
              try {
                const phoneNumberSid = await jambonz.addPhoneNumber({
                  phoneNumber: newDid,
                  applicationSid,
                  voipCarrierSid: carrierSid,
                });
                configUpdate['config.jambonzPhoneNumberSid'] = phoneNumberSid;
                log.info('Jambonz BYOC phone number registered on patch', {
                  phoneNumber: newDid,
                  sid: phoneNumberSid,
                });
              } catch (e: any) {
                const isDuplicate = e?.message?.includes('Duplicate entry');
                if (isDuplicate) {
                  log.info('Phone number already registered in Jambonz (duplicate), skipping', {
                    phoneNumber: newDid,
                  });
                  // Phone number exists - this is expected when SID was stale in DB
                } else {
                  warnings.push(`Failed to register phone number ${newDid} with voice gateway`);
                  log.warn('Failed to register BYOC phone number', {
                    phoneNumber: newDid,
                    error: e?.message,
                  });
                }
              }
            }
          }
        }

        // Phone number provisioning (non-BYOC) — runs when phoneNumber is set/changed or missing registration
        if (!isByocSip(existingVoiceConfig) && !isByocSip(newConfig)) {
          const existingPhoneNumber = existingVoiceConfig.phoneNumber as string | undefined;
          const newPhoneNumber = newConfig.phoneNumber as string | undefined;
          const existingJambonzPhoneSid = existingVoiceConfig.jambonzPhoneNumberSid as
            | string
            | undefined;
          const phoneChanged = newPhoneNumber !== existingPhoneNumber;
          const needsRegistration = newPhoneNumber && (phoneChanged || !existingJambonzPhoneSid);

          if (needsRegistration) {
            // Clean up old registrations only if phone number actually changed
            if (phoneChanged) {
              if (existingVoiceConfig.jambonzPhoneNumberSid) {
                try {
                  await jambonz.deletePhoneNumber(
                    existingVoiceConfig.jambonzPhoneNumberSid as string,
                  );
                  log.info('Old Jambonz phone number removed on patch', {
                    sid: existingVoiceConfig.jambonzPhoneNumberSid,
                  });
                } catch (e: any) {
                  const is404 = e?.message?.includes('404') || e?.statusCode === 404;
                  if (is404) {
                    log.info(
                      'Old Jambonz phone number already deleted (404), proceeding with new registration',
                      {
                        oldPhoneNumberSid: existingVoiceConfig.jambonzPhoneNumberSid,
                      },
                    );
                  } else {
                    log.warn('Failed to clean up old Jambonz phone number on patch (non-fatal)', {
                      error: e?.message,
                    });
                  }
                }
              }

              if (existingVoiceConfig.twilioPhoneNumberSid) {
                try {
                  const { getTwilioService } = await import('../services/voice/twilio-service.js');
                  await getTwilioService().unassignNumberFromTrunk(
                    existingVoiceConfig.twilioPhoneNumberSid as string,
                  );
                  log.info('Old Twilio trunk assignment removed on patch', {
                    sid: existingVoiceConfig.twilioPhoneNumberSid,
                  });
                } catch (e: any) {
                  const is404 = e?.message?.includes('404') || e?.statusCode === 404;
                  if (is404) {
                    log.info(
                      'Old Twilio trunk assignment already removed (404), proceeding with new registration',
                      {
                        oldTwilioPhoneNumberSid: existingVoiceConfig.twilioPhoneNumberSid,
                      },
                    );
                  } else {
                    log.warn('Failed to unassign old Twilio trunk on patch (non-fatal)', {
                      error: e?.message,
                    });
                  }
                }
              }
            }

            if (newPhoneNumber && applicationSid) {
              // Register new phone number in Jambonz
              const { getConfig } = await import('../config/index.js');
              const jambonzCfg = getConfig().voice?.jambonz ?? {};
              if (jambonzCfg.voipCarrierSid) {
                try {
                  const jambonzPhoneNumberSid = await jambonz.addPhoneNumber({
                    phoneNumber: newPhoneNumber,
                    applicationSid,
                  });
                  await ChannelConnection.findOneAndUpdate(
                    { _id: req.params.id, tenantId, projectId },
                    { $set: { 'config.jambonzPhoneNumberSid': jambonzPhoneNumberSid } },
                  );
                  log.info('Jambonz phone number registered on patch', {
                    phoneNumber: newPhoneNumber,
                    sid: jambonzPhoneNumberSid,
                  });
                } catch (e: any) {
                  const isDuplicate = e?.message?.includes('Duplicate entry');
                  const warnMsg = isDuplicate
                    ? `Phone number ${newPhoneNumber} is already registered to another channel`
                    : `Failed to register phone number ${newPhoneNumber} with voice gateway`;
                  warnings.push(warnMsg);
                  log.warn('Jambonz phone number registration failed on patch', {
                    phoneNumber: newPhoneNumber,
                    error: e?.message,
                  });
                }
              }

              // Trunk assignment — only for pre-existing numbers (purchased ones handled by purchasePhoneNumber)
              const isPurchased = !!newConfig.phoneNumberSid;
              if (!isPurchased) {
                try {
                  const { getTwilioService } = await import('../services/voice/twilio-service.js');
                  const twilio = getTwilioService();
                  if (twilio.isConfigured()) {
                    const result = await twilio.assignNumberToTrunk(newPhoneNumber);
                    if (result) {
                      await ChannelConnection.findOneAndUpdate(
                        { _id: req.params.id, tenantId, projectId },
                        { $set: { 'config.twilioPhoneNumberSid': result.sid } },
                      );
                      log.info('Twilio phone number assigned to trunk on patch', {
                        phoneNumber: newPhoneNumber,
                        sid: result.sid,
                      });
                    }
                  }
                } catch (e: any) {
                  log.warn('Twilio trunk assignment failed on patch (non-fatal)', {
                    phoneNumber: newPhoneNumber,
                    id: req.params.id,
                    error: e?.message,
                  });
                }
              }
            }
          }
        }

        if (Object.keys(configUpdate).length > 0) {
          await ChannelConnection.findOneAndUpdate(
            { _id: req.params.id, tenantId, projectId },
            { $set: configUpdate },
          );
        }
      } catch (err: any) {
        log.error('Jambonz sync failed on update (non-fatal)', {
          id: req.params.id,
          error: err?.message,
        });
        // Non-fatal — DB is already updated. Log and continue.
      }
    }

    // Invalidate A2A agent card cache when an A2A connection is updated
    if ((existing as any).channelType === 'a2a') {
      invalidateCard(req.params.id);
    }

    const response: Record<string, unknown> = {
      success: true,
      connection: formatConnection(updated),
    };
    if (warnings.length > 0) response.warnings = warnings;
    if (rotatedConnectionSecret) {
      response.ai4w = {
        connectionSecret: rotatedConnectionSecret,
        note: 'Store the new connectionSecret securely — it is shown only once and cannot be retrieved again.',
      };
    }
    res.json(response);
  } catch (err: any) {
    log.error('Failed to update channel connection', { error: err?.message });
    res.status(500).json({ success: false, error: 'Failed to update channel connection' });
  }
});

/**
 * DELETE /api/projects/:projectId/channel-connections/:id
 * Soft-delete (deactivate) an active connection, or hard-delete an already inactive one.
 */
router.delete('/:id', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'channel_connection:delete'))) return;

    const tenantId = req.tenantContext!.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    const { ChannelConnection } = await import('@agent-platform/database/models');
    const connectionFilter = { _id: req.params.id, tenantId, projectId };
    const existing = await ChannelConnection.findOne(connectionFilter).lean();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Channel connection not found' });
      return;
    }

    if ((existing as any).status === 'inactive') {
      const deleted = await ChannelConnection.deleteOne(connectionFilter);

      if (deleted.deletedCount === 0) {
        res.status(404).json({ success: false, error: 'Channel connection not found' });
        return;
      }

      log.info('Channel connection hard-deleted', { id: req.params.id, tenantId, projectId });

      res.json({ success: true, outcome: 'deleted' });
      return;
    }

    // Voice channel deprovisioning (skip external gateways)
    if (
      VOICE_CHANNEL_TYPES.has((existing as any).channelType) &&
      !EXTERNAL_VOICE_GATEWAYS.has((existing as any).channelType)
    ) {
      const cfg = ((existing as any).config || {}) as Record<string, unknown>;

      // Release or unassign Twilio phone number
      if (cfg.phoneNumberSid) {
        // Purchased via ABL — release entirely
        try {
          const { getTwilioService } = await import('../services/voice/twilio-service.js');
          await getTwilioService().releasePhoneNumber(cfg.phoneNumberSid as string);
          log.info('Twilio phone number released on delete', {
            id: req.params.id,
            sid: cfg.phoneNumberSid,
          });
        } catch (err: any) {
          log.error('Twilio phone number release failed on delete (non-fatal)', {
            id: req.params.id,
            error: err?.message,
          });
        }
      } else if (cfg.twilioPhoneNumberSid) {
        // Pre-existing number — unassign from trunk only (don't release/delete it)
        try {
          const { getTwilioService } = await import('../services/voice/twilio-service.js');
          await getTwilioService().unassignNumberFromTrunk(cfg.twilioPhoneNumberSid as string);
          log.info('Twilio phone number unassigned from trunk on delete', {
            id: req.params.id,
            sid: cfg.twilioPhoneNumberSid,
          });
        } catch (err: any) {
          log.error('Twilio trunk unassignment failed on delete (non-fatal)', {
            id: req.params.id,
            error: err?.message,
          });
        }
      }

      // Jambonz deprovisioning (reverse FK order: phone → gateway → carrier → application)
      try {
        const { getJambonzProvisioningService } =
          await import('../services/voice/jambonz-provisioning.service.js');
        const jambonz = getJambonzProvisioningService();
        await rollbackJambonzResources(
          jambonz,
          {
            phoneNumberSid: cfg.jambonzPhoneNumberSid as string | undefined,
            gatewaySid: cfg.jambonzSipGatewaySid as string | undefined,
            carrierSid: cfg.jambonzVoipCarrierSid as string | undefined,
            applicationSid: cfg.jambonzApplicationSid as string | undefined,
            speechCredentialSid: cfg.orpheusSpeechCredentialSid as string | undefined,
          },
          log,
        );
        log.info('Jambonz deprovisioning complete on delete', { id: req.params.id });
      } catch (err: any) {
        log.error('Jambonz cleanup failed on delete (non-fatal)', {
          id: req.params.id,
          error: err?.message,
        });
        // Non-fatal — deactivate DB record regardless
      }
    }

    // Telegram webhook cleanup
    if ((existing as any).channelType === 'telegram') {
      try {
        {
          // Plugin decrypts encryptedCredentials transparently in post-find hook
          const creds = (existing as any).encryptedCredentials
            ? JSON.parse((existing as any).encryptedCredentials)
            : null;
          const botToken = (creds as any)?.bot_token;
          if (botToken) {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
              method: 'POST',
              signal: AbortSignal.timeout(10_000),
            });
            log.info('Telegram webhook deleted', { id: req.params.id });
          }
        }
      } catch (err) {
        log.warn('Telegram deleteWebhook failed (non-fatal)', {
          id: req.params.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const updated = await ChannelConnection.findOneAndUpdate(
      connectionFilter,
      { $set: { status: 'inactive' } },
      { new: true },
    );

    if (!updated) {
      res.status(404).json({ success: false, error: 'Channel connection not found' });
      return;
    }

    log.info('Channel connection deactivated', { id: req.params.id, tenantId, projectId });

    res.json({ success: true, outcome: 'deactivated' });
  } catch (err: any) {
    log.error('Failed to delete channel connection', { error: err?.message });
    res.status(500).json({ success: false, error: 'Failed to delete channel connection' });
  }
});

export default router;
