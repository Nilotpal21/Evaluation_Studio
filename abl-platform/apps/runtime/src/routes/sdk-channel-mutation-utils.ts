import { VALID_ENVIRONMENTS } from '@agent-platform/config';
import {
  normalizePublicApiKeyAllowedOrigins,
  normalizePublicApiKeyPermissions,
} from '@agent-platform/database/models';
import { createHash, randomBytes } from 'crypto';
import {
  createPublicApiKey,
  deletePublicApiKey,
  deleteSDKChannel,
  findPublicApiKey,
  findPublicApiKeys,
  findPublicApiKeysByIds,
  findSDKChannelsByPublicApiKeyId,
  SDKChannelProjectScopeError,
  SDKChannelPublicApiKeyScopeError,
  updateSDKChannel,
  updatePublicApiKey,
  type PublicApiKeyDoc,
  type SDKChannelDoc,
} from '../repos/channel-repo.js';
import { findActiveDeployment, findDeploymentById } from '../repos/deployment-repo.js';
import {
  parseSdkChannelAuthSettings,
  resolveSdkChannelAuthUpdates,
  type SDKChannelAuthUpdates,
} from './sdk-channel-identity-utils.js';

export const VALID_SDK_CHANNEL_TYPES = [
  'web',
  'mobile_ios',
  'mobile_android',
  'voice',
  'api',
] as const;
const VALID_SDK_ENVIRONMENTS = new Set<string>(VALID_ENVIRONMENTS);
const MAX_ALLOWED_ORIGINS = 50;
const SDK_TOKEN_ENVELOPE_POLICY_CONFIG_KEY = 'sdkTokenEnvelopePolicy';
const VALID_SDK_TOKEN_ENVELOPE_POLICIES = new Set([
  'inherit',
  'signed',
  'jwe_preferred',
  'jwe_required',
]);

type SDKChannelType = (typeof VALID_SDK_CHANNEL_TYPES)[number];
type EffectiveSdkChannelAuthMode = 'anonymous' | 'hosted_exchange';
type PublicApiKeyLookup = Record<string, PublicApiKeyDoc>;

export interface SdkChannelRouteError {
  statusCode: 400 | 404;
  code: string;
  message: string;
}

type SdkChannelResult<T> = { ok: true; value: T } | { ok: false; error: SdkChannelRouteError };

export interface PreparedSdkChannelCreateInput extends SDKChannelAuthUpdates {
  tenantId: string;
  projectId: string;
  name: string;
  channelType: SDKChannelType;
  publicApiKeyId: string;
  deploymentId: string | null;
  config: string;
  environment: string | null;
  followEnvironment: boolean;
  isActive: boolean;
}

export interface PreparedSdkChannelCreateMutation {
  channel: PreparedSdkChannelCreateInput;
  createdPublicApiKeyId?: string;
  generatedServerSecret?: string;
}

export interface PreparedSdkChannelUpdateInput extends SDKChannelAuthUpdates {
  [key: string]: unknown;
  name?: string;
  publicApiKeyId?: string;
  deploymentId?: string | null;
  config?: string | Record<string, unknown>;
  isActive?: boolean;
  environment?: string | null;
  followEnvironment?: boolean;
}

export interface PreparedSdkChannelUpdateMutation {
  updates: PreparedSdkChannelUpdateInput;
  generatedServerSecret?: string;
}

interface PrepareSdkChannelCreateOptions {
  tenantId: string;
  projectId: string;
  body: Record<string, unknown>;
  defaultChannelType?: SDKChannelType;
  allowImplicitDefaultPublicKey: boolean;
}

interface PrepareSdkChannelUpdateOptions {
  tenantId: string;
  projectId: string;
  body: Record<string, unknown>;
  existing: Pick<
    SDKChannelDoc,
    'config' | 'authMode' | 'serverSecretHash' | 'serverSecretSalt' | 'serverSecretPrefix'
  >;
}

function hasOwnProperty(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function success<T>(value: T): SdkChannelResult<T> {
  return { ok: true, value };
}

function failure<T>(
  statusCode: SdkChannelRouteError['statusCode'],
  code: string,
  message: string,
): SdkChannelResult<T> {
  return {
    ok: false,
    error: { statusCode, code, message },
  };
}

function parseRequiredName(body: Record<string, unknown>): SdkChannelResult<string> {
  const value = body.name;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure(400, 'INVALID_NAME', 'Missing or empty required field: name');
  }
  return success(value.trim());
}

function parseOptionalName(body: Record<string, unknown>): SdkChannelResult<string | undefined> {
  if (!hasOwnProperty(body, 'name')) {
    return success(undefined);
  }
  const value = body.name;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure(400, 'INVALID_NAME', 'Name must be a non-empty string');
  }
  return success(value.trim());
}

function parseNullableStringField(
  body: Record<string, unknown>,
  field: string,
  invalidCode: string,
  invalidMessage: string,
): SdkChannelResult<string | null | undefined> {
  if (!hasOwnProperty(body, field)) {
    return success(undefined);
  }

  const value = body[field];
  if (value === null) {
    return success(null);
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return failure(400, invalidCode, invalidMessage);
  }

  return success(value.trim());
}

function parseOptionalBooleanField(
  body: Record<string, unknown>,
  field: string,
  invalidCode: string,
  invalidMessage: string,
): SdkChannelResult<boolean | undefined> {
  if (!hasOwnProperty(body, field)) {
    return success(undefined);
  }

  const value = body[field];
  if (typeof value !== 'boolean') {
    return failure(400, invalidCode, invalidMessage);
  }

  return success(value);
}

function resolveIsActive(
  body: Record<string, unknown>,
  defaultValue?: boolean,
): SdkChannelResult<boolean | undefined> {
  const enabled = parseOptionalBooleanField(
    body,
    'enabled',
    'INVALID_STATUS',
    'enabled must be a boolean',
  );
  if (!enabled.ok) {
    return enabled;
  }

  const isActive = parseOptionalBooleanField(
    body,
    'isActive',
    'INVALID_STATUS',
    'isActive must be a boolean',
  );
  if (!isActive.ok) {
    return isActive;
  }

  if (
    enabled.value !== undefined &&
    isActive.value !== undefined &&
    enabled.value !== isActive.value
  ) {
    return failure(
      400,
      'CONFLICTING_STATUS_FIELDS',
      'enabled and isActive must match when both are provided',
    );
  }

  if (enabled.value !== undefined) {
    return success(enabled.value);
  }

  if (isActive.value !== undefined) {
    return success(isActive.value);
  }

  return success(defaultValue);
}

function serializeChannelConfig(
  body: Record<string, unknown>,
  fallbackConfig: Record<string, unknown>,
  defaultToFallback = false,
  effectiveAuthMode: EffectiveSdkChannelAuthMode = 'anonymous',
): SdkChannelResult<string | undefined> {
  const rateLimitRpm = parseOptionalRateLimitRpm(body);
  if (!rateLimitRpm.ok) {
    return rateLimitRpm as SdkChannelResult<string | undefined>;
  }

  const hasConfigUpdate = hasOwnProperty(body, 'config');
  const hasRateLimitUpdate = rateLimitRpm.value !== undefined;
  const shouldScrubPolicy =
    effectiveAuthMode === 'anonymous' &&
    !hasConfigUpdate &&
    hasOwnProperty(fallbackConfig, SDK_TOKEN_ENVELOPE_POLICY_CONFIG_KEY);
  if (!defaultToFallback && !hasConfigUpdate && !hasRateLimitUpdate && !shouldScrubPolicy) {
    return success(undefined);
  }

  const config = parseConfigObject(body.config, fallbackConfig);
  if (!config.ok) {
    return config as SdkChannelResult<string | undefined>;
  }

  const shouldValidatePolicy = hasConfigUpdate || defaultToFallback;
  if (shouldValidatePolicy) {
    const validatedConfig = validateSdkTokenEnvelopePolicyConfig(config.value, effectiveAuthMode);
    if (!validatedConfig.ok) {
      return validatedConfig as SdkChannelResult<string | undefined>;
    }
    config.value = validatedConfig.value;
  }
  if (shouldScrubPolicy) {
    delete config.value[SDK_TOKEN_ENVELOPE_POLICY_CONFIG_KEY];
  }

  return success(JSON.stringify(applyRateLimitRpm(config.value, rateLimitRpm.value)));
}

function parseConfigObject(
  value: unknown,
  fallbackConfig: Record<string, unknown>,
): SdkChannelResult<Record<string, unknown>> {
  if (value === undefined) {
    return success({ ...fallbackConfig });
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!isRecord(parsed)) {
        return failure(400, 'INVALID_CONFIG', 'config must be a JSON object');
      }
      return success({ ...parsed });
    } catch {
      return failure(400, 'INVALID_CONFIG', 'config must be valid JSON');
    }
  }

  if (!isRecord(value)) {
    return failure(400, 'INVALID_CONFIG', 'config must be an object');
  }

  return success({ ...value });
}

function validateSdkTokenEnvelopePolicyConfig(
  config: Record<string, unknown>,
  effectiveAuthMode: EffectiveSdkChannelAuthMode,
): SdkChannelResult<Record<string, unknown>> {
  if (!hasOwnProperty(config, SDK_TOKEN_ENVELOPE_POLICY_CONFIG_KEY)) {
    return success(config);
  }

  if (effectiveAuthMode !== 'hosted_exchange') {
    return failure(
      400,
      'INVALID_SDK_TOKEN_ENVELOPE_POLICY_AUTH_MODE',
      'config.sdkTokenEnvelopePolicy requires auth.mode=hosted_exchange',
    );
  }

  const value = config[SDK_TOKEN_ENVELOPE_POLICY_CONFIG_KEY];
  if (typeof value === 'string' && VALID_SDK_TOKEN_ENVELOPE_POLICIES.has(value)) {
    return success(config);
  }

  return failure(
    400,
    'INVALID_SDK_TOKEN_ENVELOPE_POLICY',
    'config.sdkTokenEnvelopePolicy must be one of: inherit, signed, jwe_preferred, jwe_required',
  );
}

function parseOptionalRateLimitRpm(
  body: Record<string, unknown>,
): SdkChannelResult<number | null | undefined> {
  if (!hasOwnProperty(body, 'rateLimitRpm')) {
    return success(undefined);
  }

  const value = body.rateLimitRpm;
  if (value === null) {
    return success(null);
  }

  if (!Number.isInteger(value) || (value as number) < 1) {
    return failure(400, 'INVALID_RATE_LIMIT', 'rateLimitRpm must be a positive integer or null');
  }

  return success(value as number);
}

function applyRateLimitRpm(
  config: Record<string, unknown>,
  rateLimitRpm: number | null | undefined,
): Record<string, unknown> {
  if (rateLimitRpm === undefined) {
    return config;
  }

  if (rateLimitRpm === null) {
    delete config.rateLimitRpm;
    return config;
  }

  config.rateLimitRpm = rateLimitRpm;
  return config;
}

function getConfigObject(config: unknown): Record<string, unknown> {
  return isRecord(config) ? { ...config } : {};
}

function getRateLimitRpm(config: Record<string, unknown>): number | undefined {
  const value = config.rateLimitRpm;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeDeploymentId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : null;
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const stringValue = String(value);
    return stringValue.trim().length > 0 ? stringValue : null;
  }

  return null;
}

export function getDeploymentRecordId(deployment: { _id?: unknown; id?: unknown }): string | null {
  return normalizeDeploymentId(deployment.id) ?? normalizeDeploymentId(deployment._id);
}

export async function resolveActiveDeploymentIdForEnvironment(options: {
  projectId: string;
  tenantId: string;
  environment: string;
}): Promise<string | null> {
  const activeDeployment = await findActiveDeployment(
    options.projectId,
    options.tenantId,
    options.environment,
  );

  return activeDeployment ? getDeploymentRecordId(activeDeployment) : null;
}

function parseChannelType(
  body: Record<string, unknown>,
  defaultChannelType?: SDKChannelType,
): SdkChannelResult<SDKChannelType> {
  const rawChannelType = body.channelType;
  const resolved =
    typeof rawChannelType === 'string' && rawChannelType.trim().length > 0
      ? rawChannelType.trim()
      : defaultChannelType;

  if (!resolved || !VALID_SDK_CHANNEL_TYPES.includes(resolved as SDKChannelType)) {
    return failure(
      400,
      'INVALID_CHANNEL_TYPE',
      `Invalid channelType. Must be one of: ${VALID_SDK_CHANNEL_TYPES.join(', ')}`,
    );
  }

  return success(resolved as SDKChannelType);
}

async function resolvePublicApiKeyId(
  body: Record<string, unknown>,
  tenantId: string,
  projectId: string,
  allowImplicitDefaultPublicKey: boolean,
  implicitKeyName: string,
): Promise<SdkChannelResult<{ publicApiKeyId: string; createdPublicApiKeyId?: string }>> {
  const publicApiKeyId = body.publicApiKeyId;

  if (publicApiKeyId === undefined || publicApiKeyId === null) {
    if (!allowImplicitDefaultPublicKey) {
      return failure(400, 'INVALID_API_KEY', 'Missing required field: publicApiKeyId');
    }

    const templateKey = (
      await findPublicApiKeys({
        projectId,
        tenantId,
        isActive: true,
      })
    )[0];
    const createdKey = await createManagedPublicApiKey({
      projectId,
      tenantId,
      name: implicitKeyName,
      allowedOrigins: null,
      permissions: toPublicApiKeyPermissionsRecord(templateKey?.permissions),
      expiresAt: templateKey?.expiresAt ?? null,
      isActive: true,
    });
    return success({
      publicApiKeyId: createdKey.id,
      createdPublicApiKeyId: createdKey.id,
    });
  }

  if (typeof publicApiKeyId !== 'string' || publicApiKeyId.trim().length === 0) {
    return failure(400, 'INVALID_API_KEY', 'publicApiKeyId must be a non-empty string');
  }

  const apiKey = await findPublicApiKey({
    id: publicApiKeyId.trim(),
    projectId,
    tenantId,
  });
  if (!apiKey) {
    return failure(400, 'API_KEY_NOT_FOUND', 'Public API key not found for this project');
  }

  return success({ publicApiKeyId: publicApiKeyId.trim() });
}

async function resolveOptionalPublicApiKeyId(
  body: Record<string, unknown>,
  tenantId: string,
  projectId: string,
): Promise<SdkChannelResult<string | undefined>> {
  if (!hasOwnProperty(body, 'publicApiKeyId')) {
    return success(undefined);
  }

  const publicApiKeyId = body.publicApiKeyId;
  if (typeof publicApiKeyId !== 'string' || publicApiKeyId.trim().length === 0) {
    return failure(400, 'INVALID_API_KEY', 'publicApiKeyId must be a non-empty string');
  }

  const apiKey = await findPublicApiKey({
    id: publicApiKeyId.trim(),
    projectId,
    tenantId,
  });
  if (!apiKey) {
    return failure(400, 'API_KEY_NOT_FOUND', 'Public API key not found for this project');
  }

  return success(publicApiKeyId.trim());
}

async function resolveDeploymentAndEnvironment(
  body: Record<string, unknown>,
  tenantId: string,
  projectId: string,
): Promise<
  SdkChannelResult<{
    deploymentId: string | null | undefined;
    environment: string | null | undefined;
  }>
> {
  const deploymentIdResult = parseNullableStringField(
    body,
    'deploymentId',
    'INVALID_DEPLOYMENT',
    'deploymentId must be a non-empty string or null',
  );
  if (!deploymentIdResult.ok) {
    return deploymentIdResult;
  }

  const environmentResult = parseNullableStringField(
    body,
    'environment',
    'INVALID_ENVIRONMENT',
    `environment must be one of: ${VALID_ENVIRONMENTS.join(', ')} or null`,
  );
  if (!environmentResult.ok) {
    return environmentResult;
  }

  const deploymentId = deploymentIdResult.value;
  const environment = environmentResult.value;

  if (deploymentId && environment) {
    return failure(
      400,
      'CONFLICTING_PARAMS',
      'Cannot set both deploymentId and environment. Use one or the other.',
    );
  }

  if (environment && !VALID_SDK_ENVIRONMENTS.has(environment)) {
    return failure(
      400,
      'INVALID_ENVIRONMENT',
      `Invalid environment. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
    );
  }

  if (deploymentId) {
    const deployment = await findDeploymentById(deploymentId, projectId, tenantId);
    if (!deployment) {
      return failure(400, 'DEPLOYMENT_NOT_FOUND', 'Deployment not found');
    }
  }

  return success({ deploymentId, environment });
}

function buildManagedPublicApiKeyName(channelName: string): string {
  return `${channelName} SDK Key`;
}

function generateManagedPublicApiKeyMaterial(): {
  keyPrefix: string;
  keyHash: string;
} {
  const rawKey = `pk_${randomBytes(24).toString('hex')}`;
  return {
    keyPrefix: rawKey.slice(0, 11),
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
  };
}

async function createManagedPublicApiKey(options: {
  projectId: string;
  tenantId: string;
  name: string;
  allowedOrigins?: string[] | null;
  permissions?: Record<string, boolean> | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}): Promise<PublicApiKeyDoc> {
  const { keyPrefix, keyHash } = generateManagedPublicApiKeyMaterial();
  return createPublicApiKey({
    projectId: options.projectId,
    tenantId: options.tenantId,
    keyPrefix,
    keyHash,
    name: buildManagedPublicApiKeyName(options.name),
    allowedOrigins: options.allowedOrigins ?? null,
    permissions: options.permissions ?? null,
    expiresAt: options.expiresAt ?? null,
    isActive: options.isActive ?? true,
  });
}

function replaceWildcardForUrlValidation(value: string): string {
  return value.includes('*') ? value.replace(/\*/g, 'wildcard') : value;
}

function isValidAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(replaceWildcardForUrlValidation(origin));
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== 'null'
    );
  } catch {
    return false;
  }
}

function toPublicApiKeyPermissionsRecord(
  value: unknown,
): Record<string, boolean> | null | undefined {
  const normalized = normalizePublicApiKeyPermissions(value);
  return normalized
    ? {
        chat: normalized.chat,
        voice: normalized.voice,
      }
    : normalized;
}

export function coerceSdkChannelBody(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

export function parseAllowedOriginsUpdate(
  body: Record<string, unknown>,
): SdkChannelResult<string[] | null | undefined> {
  if (!hasOwnProperty(body, 'allowedOrigins')) {
    return success(undefined);
  }

  if (body.allowedOrigins === null) {
    return success(null);
  }

  const allowedOrigins = normalizePublicApiKeyAllowedOrigins(body.allowedOrigins);
  if (allowedOrigins === null) {
    return failure(
      400,
      'INVALID_ALLOWED_ORIGINS',
      'allowedOrigins must be an array of valid URLs or null',
    );
  }

  if (allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
    return failure(
      400,
      'INVALID_ALLOWED_ORIGINS',
      `allowedOrigins must include at most ${MAX_ALLOWED_ORIGINS} URLs`,
    );
  }

  for (const origin of allowedOrigins) {
    if (!isValidAllowedOrigin(origin)) {
      return failure(
        400,
        'INVALID_ALLOWED_ORIGINS',
        'allowedOrigins must be an array of valid URLs or null',
      );
    }
  }

  return success(allowedOrigins);
}

export async function loadPublicApiKeyLookup(
  channels: Array<Pick<SDKChannelDoc, 'publicApiKeyId'>>,
  tenantId: string,
  projectId?: string,
): Promise<PublicApiKeyLookup> {
  const publicApiKeyIds: string[] = [];
  for (const channel of channels) {
    const publicApiKeyId = channel.publicApiKeyId.trim();
    if (publicApiKeyId.length > 0 && !publicApiKeyIds.includes(publicApiKeyId)) {
      publicApiKeyIds.push(publicApiKeyId);
    }
  }

  if (publicApiKeyIds.length === 0) {
    return {};
  }

  const keys = await findPublicApiKeysByIds({ ids: publicApiKeyIds, tenantId, projectId });
  const lookup: PublicApiKeyLookup = {};
  for (const key of keys) {
    lookup[key.id] = key;
  }
  return lookup;
}

export function formatChannelWithApiKey(
  doc: SDKChannelDoc,
  publicApiKeyLookup: PublicApiKeyLookup,
): Record<string, unknown> {
  const auth = parseSdkChannelAuthSettings(doc as unknown as Record<string, unknown>);
  const config = getConfigObject(doc.config);
  const publicApiKey = publicApiKeyLookup[doc.publicApiKeyId];
  const keyPrefix =
    typeof publicApiKey?.keyPrefix === 'string' && publicApiKey.keyPrefix.trim().length > 0
      ? publicApiKey.keyPrefix
      : null;

  return {
    id: doc.id,
    tenantId: doc.tenantId,
    projectId: doc.projectId,
    name: doc.name,
    channelType: doc.channelType,
    deploymentId: doc.deploymentId || null,
    publicApiKeyId: doc.publicApiKeyId,
    apiKey: keyPrefix,
    config,
    rateLimitRpm: getRateLimitRpm(config),
    allowedOrigins: normalizePublicApiKeyAllowedOrigins(publicApiKey?.allowedOrigins),
    isActive: doc.isActive ?? true,
    enabled: doc.isActive ?? true,
    environment: doc.environment || null,
    followEnvironment: doc.followEnvironment ?? true,
    auth,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function formatSingleChannel(
  channel: SDKChannelDoc,
  tenantId: string,
  projectId?: string,
): Promise<Record<string, unknown>> {
  const publicApiKeyLookup = await loadPublicApiKeyLookup(
    [channel],
    tenantId,
    projectId ?? channel.projectId,
  );
  return formatChannelWithApiKey(channel, publicApiKeyLookup);
}

export async function syncAllowedOriginsForChannel(
  channel: Pick<SDKChannelDoc, 'projectId' | 'publicApiKeyId'>,
  tenantId: string,
  allowedOrigins: string[] | null | undefined,
): Promise<void> {
  if (allowedOrigins === undefined) {
    return;
  }

  const updatedKey = await updatePublicApiKey(
    channel.publicApiKeyId,
    channel.projectId,
    { allowedOrigins },
    tenantId,
  );

  if (!updatedKey) {
    throw new Error('Failed to update SDK channel allowed origins');
  }
}

export async function ensureDedicatedPublicApiKeyForAllowedOrigins(
  channel: Pick<SDKChannelDoc, 'id' | 'name' | 'projectId' | 'publicApiKeyId'>,
  tenantId: string,
): Promise<{ publicApiKeyId: string; createdPublicApiKeyId?: string }> {
  const linkedChannels = await findSDKChannelsByPublicApiKeyId(
    tenantId,
    channel.projectId,
    channel.publicApiKeyId,
  );
  const hasSiblingChannel = linkedChannels.some((candidate) => candidate.id !== channel.id);
  if (!hasSiblingChannel) {
    return { publicApiKeyId: channel.publicApiKeyId };
  }

  const existingKey = await findPublicApiKey({
    id: channel.publicApiKeyId,
    projectId: channel.projectId,
    tenantId,
  });
  if (!existingKey) {
    throw new Error('Failed to load SDK channel public API key');
  }

  const clonedKey = await createManagedPublicApiKey({
    projectId: channel.projectId,
    tenantId,
    name: channel.name,
    allowedOrigins: normalizePublicApiKeyAllowedOrigins(existingKey.allowedOrigins),
    permissions: toPublicApiKeyPermissionsRecord(existingKey.permissions),
    expiresAt: existingKey.expiresAt ?? null,
    isActive: existingKey.isActive,
  });

  return {
    publicApiKeyId: clonedKey.id,
    createdPublicApiKeyId: clonedKey.id,
  };
}

export function buildSdkChannelRollbackInput(
  channel: Pick<
    SDKChannelDoc,
    | 'name'
    | 'publicApiKeyId'
    | 'deploymentId'
    | 'config'
    | 'isActive'
    | 'environment'
    | 'followEnvironment'
    | 'authMode'
    | 'serverSecretHash'
    | 'serverSecretSalt'
    | 'serverSecretPrefix'
    | 'serverSecretLastRotatedAt'
  >,
): PreparedSdkChannelUpdateInput {
  return {
    name: channel.name,
    publicApiKeyId: channel.publicApiKeyId,
    deploymentId: channel.deploymentId,
    config: channel.config,
    isActive: channel.isActive,
    environment: channel.environment,
    followEnvironment: channel.followEnvironment,
    ...(channel.authMode !== undefined ? { authMode: channel.authMode } : {}),
    ...(channel.serverSecretHash !== undefined
      ? { serverSecretHash: channel.serverSecretHash }
      : {}),
    ...(channel.serverSecretSalt !== undefined
      ? { serverSecretSalt: channel.serverSecretSalt }
      : {}),
    ...(channel.serverSecretPrefix !== undefined
      ? { serverSecretPrefix: channel.serverSecretPrefix }
      : {}),
    ...(channel.serverSecretLastRotatedAt !== undefined
      ? { serverSecretLastRotatedAt: channel.serverSecretLastRotatedAt }
      : {}),
  };
}

export async function cleanupFailedSdkChannelCreate(options: {
  projectId: string;
  tenantId: string;
  channelId?: string;
  createdPublicApiKeyId?: string;
}): Promise<void> {
  if (options.channelId) {
    await deleteSDKChannel(options.channelId, options.projectId, options.tenantId);
  }

  if (options.createdPublicApiKeyId) {
    await deletePublicApiKey(options.createdPublicApiKeyId, options.projectId, options.tenantId);
  }
}

export async function rollbackFailedSdkChannelUpdate(options: {
  existing: Pick<
    SDKChannelDoc,
    | 'id'
    | 'projectId'
    | 'name'
    | 'publicApiKeyId'
    | 'deploymentId'
    | 'config'
    | 'isActive'
    | 'environment'
    | 'followEnvironment'
    | 'authMode'
    | 'serverSecretHash'
    | 'serverSecretSalt'
    | 'serverSecretPrefix'
    | 'serverSecretLastRotatedAt'
  >;
  tenantId: string;
  updatePersisted: boolean;
  createdPublicApiKeyId?: string;
}): Promise<void> {
  if (options.updatePersisted) {
    await updateSDKChannel(
      options.existing.id,
      options.existing.projectId,
      options.tenantId,
      buildSdkChannelRollbackInput(options.existing),
    );
  }

  if (options.createdPublicApiKeyId) {
    await deletePublicApiKey(
      options.createdPublicApiKeyId,
      options.existing.projectId,
      options.tenantId,
    );
  }
}

export async function prepareSdkChannelCreateInput(
  options: PrepareSdkChannelCreateOptions,
): Promise<SdkChannelResult<PreparedSdkChannelCreateMutation>> {
  const name = parseRequiredName(options.body);
  if (!name.ok) {
    return name;
  }

  const channelType = parseChannelType(options.body, options.defaultChannelType);
  if (!channelType.ok) {
    return channelType;
  }

  const publicApiKeyId = await resolvePublicApiKeyId(
    options.body,
    options.tenantId,
    options.projectId,
    options.allowImplicitDefaultPublicKey,
    name.value,
  );
  if (!publicApiKeyId.ok) {
    return publicApiKeyId;
  }

  const deploymentAndEnvironment = await resolveDeploymentAndEnvironment(
    options.body,
    options.tenantId,
    options.projectId,
  );
  if (!deploymentAndEnvironment.ok) {
    return deploymentAndEnvironment;
  }

  const followEnvironment = parseOptionalBooleanField(
    options.body,
    'followEnvironment',
    'INVALID_FOLLOW_ENV',
    'followEnvironment must be a boolean',
  );
  if (!followEnvironment.ok) {
    return followEnvironment;
  }

  const isActive = resolveIsActive(options.body, true);
  if (!isActive.ok || isActive.value === undefined) {
    return isActive as SdkChannelResult<PreparedSdkChannelCreateMutation>;
  }

  const auth = await resolveSdkChannelAuthUpdates(options.body, undefined, { isCreate: true });
  if ('error' in auth) {
    return {
      ok: false,
      error: { statusCode: 400, ...auth.error },
    };
  }
  const effectiveAuthMode: EffectiveSdkChannelAuthMode = auth.updates.authMode ?? 'anonymous';

  const config = serializeChannelConfig(options.body, {}, true, effectiveAuthMode);
  if (!config.ok || config.value === undefined) {
    return config as SdkChannelResult<PreparedSdkChannelCreateMutation>;
  }

  return success({
    channel: {
      tenantId: options.tenantId,
      projectId: options.projectId,
      name: name.value,
      channelType: channelType.value,
      publicApiKeyId: publicApiKeyId.value.publicApiKeyId,
      deploymentId: deploymentAndEnvironment.value.deploymentId ?? null,
      config: config.value,
      environment: deploymentAndEnvironment.value.environment ?? null,
      followEnvironment: followEnvironment.value ?? true,
      isActive: isActive.value,
      ...auth.updates,
    },
    createdPublicApiKeyId: publicApiKeyId.value.createdPublicApiKeyId,
    ...(auth.generatedServerSecret ? { generatedServerSecret: auth.generatedServerSecret } : {}),
  });
}

export async function prepareSdkChannelUpdateInput(
  options: PrepareSdkChannelUpdateOptions,
): Promise<SdkChannelResult<PreparedSdkChannelUpdateMutation>> {
  const updates: PreparedSdkChannelUpdateInput = {};

  const name = parseOptionalName(options.body);
  if (!name.ok) {
    return name;
  }
  if (name.value !== undefined) {
    updates.name = name.value;
  }

  const publicApiKeyId = await resolveOptionalPublicApiKeyId(
    options.body,
    options.tenantId,
    options.projectId,
  );
  if (!publicApiKeyId.ok) {
    return publicApiKeyId;
  }
  if (publicApiKeyId.value !== undefined) {
    updates.publicApiKeyId = publicApiKeyId.value;
  }

  const deploymentAndEnvironment = await resolveDeploymentAndEnvironment(
    options.body,
    options.tenantId,
    options.projectId,
  );
  if (!deploymentAndEnvironment.ok) {
    return deploymentAndEnvironment;
  }

  const deploymentId = deploymentAndEnvironment.value.deploymentId;
  const environment = deploymentAndEnvironment.value.environment;

  if (deploymentId !== undefined) {
    updates.deploymentId = deploymentId;
    if (deploymentId !== null) {
      updates.environment = null;
    }
  }

  if (environment !== undefined) {
    updates.environment = environment;
    if (environment !== null) {
      updates.deploymentId = null;
    }
  }

  const isActive = resolveIsActive(options.body);
  if (!isActive.ok) {
    return isActive;
  }
  if (isActive.value !== undefined) {
    updates.isActive = isActive.value;
  }

  const followEnvironment = parseOptionalBooleanField(
    options.body,
    'followEnvironment',
    'INVALID_FOLLOW_ENV',
    'followEnvironment must be a boolean',
  );
  if (!followEnvironment.ok) {
    return followEnvironment;
  }
  if (followEnvironment.value !== undefined) {
    updates.followEnvironment = followEnvironment.value;
  }

  const auth = await resolveSdkChannelAuthUpdates(options.body, options.existing);
  if ('error' in auth) {
    return {
      ok: false,
      error: { statusCode: 400, ...auth.error },
    };
  }
  const effectiveAuthMode: EffectiveSdkChannelAuthMode =
    auth.updates.authMode ??
    (options.existing.authMode === 'hosted_exchange' ? 'hosted_exchange' : 'anonymous');

  const config = serializeChannelConfig(
    options.body,
    getConfigObject(options.existing.config),
    false,
    effectiveAuthMode,
  );
  if (!config.ok) {
    return config;
  }
  if (config.value !== undefined) {
    updates.config = config.value;
  }

  return success({
    updates: {
      ...updates,
      ...auth.updates,
    },
    ...(auth.generatedServerSecret ? { generatedServerSecret: auth.generatedServerSecret } : {}),
  });
}

export function resolveSdkChannelMutationError(error: unknown): SdkChannelRouteError | null {
  if (error instanceof SDKChannelProjectScopeError) {
    return {
      statusCode: 404,
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found',
    };
  }

  if (error instanceof SDKChannelPublicApiKeyScopeError) {
    return {
      statusCode: 400,
      code: 'API_KEY_NOT_FOUND',
      message: 'Public API key not found for this project',
    };
  }

  return null;
}
