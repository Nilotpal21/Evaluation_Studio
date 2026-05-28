/**
 * Auth Profile Zod Validation Schemas
 *
 * Discriminated union on `authType` for the 12 Phase 1+2 types.
 * All config schemas use .strict() to prevent unknown field injection.
 */

import { z } from 'zod';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import {
  BasicConfigSchema as BasicConfig,
  BasicSecretsSchema as BasicSecrets,
  CustomHeaderConfigSchema as CustomHeaderConfig,
  CustomHeaderSecretsSchema as CustomHeaderSecrets,
  CustomHeaderCrossFieldValidator,
  AwsIamConfigSchema as AwsIamConfig,
  AwsIamSecretsSchema as AwsIamSecrets,
  AzureAdConfigSchema as AzureAdConfig,
  AzureAdSecretsSchema as AzureAdSecrets,
  MtlsConfigSchema as MtlsConfig,
  MtlsSecretsSchema as MtlsSecrets,
  SshKeyConfigSchema as SshKeyConfig,
  SshKeySecretsSchema as SshKeySecrets,
} from './auth-profile-phase2.schema.js';
import {
  DigestConfigSchema as DigestConfig,
  DigestSecretsSchema as DigestSecrets,
  KerberosConfigSchema as KerberosConfig,
  KerberosSecretsSchema as KerberosSecrets,
  SamlConfigSchema as SamlConfig,
  SamlSecretsSchema as SamlSecrets,
  HawkConfigSchema as HawkConfig,
  HawkSecretsSchema as HawkSecrets,
  WsSecurityConfigSchema as WsSecurityConfig,
  WsSecuritySecretsSchema as WsSecuritySecrets,
} from './auth-profile-phase3.schema.js';

/**
 * Auth profile status enum used by the update schema and any other status-bearing
 * validation. Kept inline (not imported from `@agent-platform/database/models`) so
 * the validation barrel does not pull a Mongoose-bearing module into test paths
 * where consumers `vi.mock('@agent-platform/database/models')`. The Mongoose model
 * has its own `AUTH_PROFILE_STATUSES` const that must stay in sync — see the unit
 * test in `__tests__/auth-profile/auth-profile-status-sync.test.ts` for the guard.
 */
export const AUTH_PROFILE_STATUS_VALUES = [
  'active',
  'expired',
  'revoked',
  'invalid',
  'pending_authorization',
] as const;
export const AuthProfileStatusSchema = z.enum(AUTH_PROFILE_STATUS_VALUES);

// ─── Profile Types ────────────────────────────────────────────────────

export const PROFILE_TYPES = ['integration', 'custom'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

// ─── Phase 1 Auth Types ────────────────────────────────────────────────

export const PHASE1_SCHEMA_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
] as const;

/** @deprecated Use PHASE1_SCHEMA_AUTH_TYPES. Kept for external package compatibility. */
export const PHASE1_AUTH_TYPES = PHASE1_SCHEMA_AUTH_TYPES;

export const AUTH_PROFILE_USAGE_MODES = [
  'preconfigured',
  'user_token',
  'jit',
  'preflight',
] as const;

export type AuthProfileUsageMode = (typeof AUTH_PROFILE_USAGE_MODES)[number];

const AUTH_TYPE_USAGE_MODE_MAP = {
  none: ['preconfigured'],
  api_key: ['preconfigured'],
  bearer: ['preconfigured'],
  oauth2_app: ['preconfigured', 'jit', 'preflight'],
  oauth2_token: ['user_token'],
  oauth2_client_credentials: ['preconfigured'],
  basic: ['preconfigured'],
  custom_header: ['preconfigured'],
  aws_iam: ['preconfigured'],
  azure_ad: ['preconfigured'],
  mtls: ['preconfigured'],
  ssh_key: ['preconfigured'],
  digest: ['preconfigured'],
  kerberos: ['preconfigured'],
  saml: ['preconfigured'],
  hawk: ['preconfigured'],
  ws_security: ['preconfigured'],
} as const satisfies Record<string, readonly AuthProfileUsageMode[]>;

export function getAllowedAuthProfileUsageModes(authType: string): readonly AuthProfileUsageMode[] {
  return (
    AUTH_TYPE_USAGE_MODE_MAP[authType as keyof typeof AUTH_TYPE_USAGE_MODE_MAP] ?? ['preconfigured']
  );
}

export function resolveAuthProfileUsageMode(
  authType: string,
  usageMode?: AuthProfileUsageMode | null,
): AuthProfileUsageMode {
  if (usageMode) {
    return usageMode;
  }

  const [defaultMode] = getAllowedAuthProfileUsageModes(authType);
  return defaultMode ?? 'preconfigured';
}

export function getAuthProfileUsageModeValidationError(
  authType: string,
  usageMode?: AuthProfileUsageMode | null,
): string | null {
  const effectiveUsageMode = resolveAuthProfileUsageMode(authType, usageMode);
  const allowedUsageModes = getAllowedAuthProfileUsageModes(authType);

  if (allowedUsageModes.includes(effectiveUsageMode)) {
    return null;
  }

  return `usageMode '${effectiveUsageMode}' is not valid for authType '${authType}'. Allowed modes: ${allowedUsageModes.join(', ')}.`;
}

// ─── Config Schemas (per auth type) ────────────────────────────────────

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const OAuthEndpointUrlSchema = z
  .string()
  .url()
  .superRefine((urlValue, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(urlValue);
    } catch {
      // z.string().url() handles syntax validation
      return;
    }

    if (parsed.protocol !== 'https:' && !isLocalhost(parsed.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OAuth endpoint URLs must use HTTPS.',
      });
      return;
    }

    try {
      assertUrlSafeForSSRF(urlValue, isLocalhost(parsed.hostname) ? { allowLocalhost: true } : {});
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'OAuth endpoint URL blocked by SSRF policy.',
      });
    }
  });

export const NoneConfigSchema = z.object({}).strict();

export const ApiKeyConfigSchema = z
  .object({
    headerName: z.string().min(1).max(255),
    prefix: z.string().max(64).optional(),
    placement: z.enum(['header', 'query']).default('header'),
    connectionConfig: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Optional prefix for the credential (e.g. `Bearer` for `Authorization: Bearer <token>`). */
export const BearerConfigSchema = z
  .object({
    prefix: z.string().max(64).optional(),
    connectionConfig: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const OAuthScopesSchema = z.array(z.string().min(1));

export const OAuth2AppConfigSchema = z
  .object({
    authorizationUrl: OAuthEndpointUrlSchema,
    tokenUrl: OAuthEndpointUrlSchema,
    refreshUrl: OAuthEndpointUrlSchema.optional(),
    revocationUrl: OAuthEndpointUrlSchema.optional(),
    deviceAuthorizationUrl: OAuthEndpointUrlSchema.optional(),
    tokenIntrospectionUrl: OAuthEndpointUrlSchema.optional(),
    defaultScopes: OAuthScopesSchema.optional(),
    // Backwards-compatible alias used by older Studio payloads.
    scopes: OAuthScopesSchema.optional(),
    scopeSeparator: z.string().max(8).optional(),
    pkceRequired: z.boolean().optional(),
    pkceMethod: z.enum(['S256', 'plain']).optional(),
    supportedGrantTypes: z.array(z.string().min(1)).optional(),
    setupGuideUrl: z.string().url().optional(),
    docsUrl: z.string().url().optional(),
    authorizationParams: z.record(z.string(), z.string()).optional(),
    tokenParams: z.record(z.string(), z.string()).optional(),
    connectionConfig: z.record(z.string(), z.string()).optional(),
    // OIDC Identity Provider fields (used by end-user public API auth).
    // When present, IdP token validation uses these for strict issuer/audience checks.
    // When absent, the validator auto-detects provider from the token's iss claim.
    issuer: z.string().url().optional(),
    audience: z.string().min(1).optional(),
    jwksUri: z.string().url().optional(),
    discoveryUrl: z.string().url().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.defaultScopes || !data.scopes) {
      return;
    }

    const scopesMatch =
      data.defaultScopes.length === data.scopes.length &&
      data.defaultScopes.every((scope, index) => scope === data.scopes?.[index]);

    if (!scopesMatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'defaultScopes and legacy scopes must match when both are provided.',
        path: ['defaultScopes'],
      });
    }
  })
  .transform(({ scopes, defaultScopes, ...rest }) => ({
    ...rest,
    ...(defaultScopes !== undefined
      ? { defaultScopes }
      : scopes !== undefined
        ? { defaultScopes: scopes }
        : {}),
  }));

export const OAuth2TokenConfigSchema = z
  .object({
    provider: z.string().min(1).max(255),
    scopes: z.array(z.string().min(1)).optional(),
    grantedScopes: z.array(z.string().min(1)).optional(),
    tokenType: z.enum(['bearer', 'mac']).optional(),
    issuedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    refreshTokenExpiresAt: z.string().datetime().nullable().optional(),
    refreshTokenRotation: z.boolean().optional(),
  })
  .strict();

export const OAuth2ClientCredentialsConfigSchema = z
  .object({
    tokenUrl: OAuthEndpointUrlSchema,
    scopes: z.array(z.string().min(1)).optional(),
    audience: z.string().min(1).optional(),
  })
  .strict();

// ─── Secrets Schemas (per auth type) ───────────────────────────────────

export const NoneSecretsSchema = z.object({}).strict();

export const ApiKeySecretsSchema = z
  .object({
    apiKey: z.string().min(1),
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

export const BearerSecretsSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export const OAuth2AppSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

export const OAuth2TokenSecretsSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
  })
  .strict();

export const OAuth2ClientCredentialsSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

// ─── Shared Base Fields ─────────────────────────────────────────────────

const BaseProfileFields = {
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  projectId: z.string().nullable(),
  scope: z.enum(['tenant', 'project']),
  usageMode: z.enum(AUTH_PROFILE_USAGE_MODES).optional(),
  environment: z.string().max(64).nullable().optional(),
  visibility: z.enum(['shared', 'personal']).default('shared'),
  connectionMode: z.enum(['shared', 'per_user']).default('shared'),
  linkedAppProfileId: z.string().min(1).optional(),
  connector: z.string().max(255).optional(),
  category: z.string().max(255).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  profileType: z.enum(PROFILE_TYPES).optional(),
  inlineHostedTool: z
    .object({ toolId: z.string().min(1), fieldKey: z.string().min(1) })
    .nullable()
    .optional(),
  lastAuthorizedAt: z.string().datetime().nullable().optional(),
  lastAuthorizedBy: z.string().nullable().optional(),
};

// ─── Create Schema (Discriminated Union on authType) ────────────────────

const CreateNoneProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('none'),
    config: NoneConfigSchema,
    secrets: NoneSecretsSchema,
  })
  .strict();

const CreateApiKeyProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('api_key'),
    config: ApiKeyConfigSchema,
    secrets: ApiKeySecretsSchema,
  })
  .strict();

const CreateBearerProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('bearer'),
    config: BearerConfigSchema,
    secrets: BearerSecretsSchema,
  })
  .strict();

const CreateOAuth2AppProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_app'),
    config: OAuth2AppConfigSchema,
    secrets: OAuth2AppSecretsSchema,
  })
  .strict();

const CreateOAuth2TokenProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_token'),
    config: OAuth2TokenConfigSchema,
    secrets: OAuth2TokenSecretsSchema,
  })
  .strict();

const CreateOAuth2ClientCredentialsProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('oauth2_client_credentials'),
    config: OAuth2ClientCredentialsConfigSchema,
    secrets: OAuth2ClientCredentialsSecretsSchema,
  })
  .strict();

// ─── Phase 2 Create Profiles ──────────────────────────────────────────

const CreateBasicProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('basic'),
    config: BasicConfig,
    secrets: BasicSecrets,
  })
  .strict();

const CreateCustomHeaderProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('custom_header'),
    config: CustomHeaderConfig,
    secrets: CustomHeaderSecrets,
  })
  .strict();

const CreateAwsIamProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('aws_iam'),
    config: AwsIamConfig,
    secrets: AwsIamSecrets,
  })
  .strict();

const CreateAzureAdProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('azure_ad'),
    config: AzureAdConfig,
    secrets: AzureAdSecrets,
  })
  .strict();

const CreateMtlsProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('mtls'),
    config: MtlsConfig,
    secrets: MtlsSecrets,
  })
  .strict();

const CreateSshKeyProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('ssh_key'),
    config: SshKeyConfig,
    secrets: SshKeySecrets,
  })
  .strict();

// ─── Phase 3 Create Profiles ──────────────────────────────────────────

const CreateDigestProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('digest'),
    config: DigestConfig,
    secrets: DigestSecrets,
  })
  .strict();

const CreateKerberosProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('kerberos'),
    config: KerberosConfig,
    secrets: KerberosSecrets,
  })
  .strict();

const CreateSamlProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('saml'),
    config: SamlConfig,
    secrets: SamlSecrets,
  })
  .strict();

const CreateHawkProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('hawk'),
    config: HawkConfig,
    secrets: HawkSecrets,
  })
  .strict();

const CreateWsSecurityProfile = z
  .object({
    ...BaseProfileFields,
    authType: z.literal('ws_security'),
    config: WsSecurityConfig,
    secrets: WsSecuritySecrets,
  })
  .strict();

const CreateAuthProfileBase = z.discriminatedUnion('authType', [
  // Phase 1
  CreateNoneProfile,
  CreateApiKeyProfile,
  CreateBearerProfile,
  CreateOAuth2AppProfile,
  CreateOAuth2TokenProfile,
  CreateOAuth2ClientCredentialsProfile,
  // Phase 2
  CreateBasicProfile,
  CreateCustomHeaderProfile,
  CreateAwsIamProfile,
  CreateAzureAdProfile,
  CreateMtlsProfile,
  CreateSshKeyProfile,
  // Phase 3
  CreateDigestProfile,
  CreateKerberosProfile,
  CreateSamlProfile,
  CreateHawkProfile,
  CreateWsSecurityProfile,
]);

/**
 * Full Create schema with cross-field refinements:
 * - scope/projectId consistency
 * - visibility restrictions
 */
export const CreateAuthProfileSchema = CreateAuthProfileBase.pipe(
  z.any().superRefine((data, ctx) => {
    // scope/projectId consistency
    if (data.scope === 'tenant' && data.projectId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tenant-scoped profiles must have projectId: null',
        path: ['projectId'],
      });
    }
    if (data.scope === 'project' && !data.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project-scoped profiles must have a non-null projectId',
        path: ['projectId'],
      });
    }
    // Tenant-level profiles cannot be personal
    if (data.scope === 'tenant' && data.visibility === 'personal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tenant-scoped profiles cannot have personal visibility',
        path: ['visibility'],
      });
    }

    if (data.authType === 'custom_header') {
      const keyValidation = CustomHeaderCrossFieldValidator(data.config, data.secrets);
      if (!keyValidation.valid) {
        const missing = keyValidation.missing ?? [];
        const extra = keyValidation.extra ?? [];
        if (missing.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Header values must include configured headers: ${missing.join(', ')}`,
            path: ['secrets', 'headerValues'],
          });
        }
        if (extra.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Header values include headers not present in config: ${extra.join(', ')}`,
            path: ['secrets', 'headerValues'],
          });
        }
      }
    }

    if (data.authType === 'oauth2_token' && !data.linkedAppProfileId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oauth2_token profiles must reference linkedAppProfileId',
        path: ['linkedAppProfileId'],
      });
    }

    if (data.authType !== 'oauth2_token' && data.linkedAppProfileId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'linkedAppProfileId is only valid for oauth2_token profiles.',
        path: ['linkedAppProfileId'],
      });
    }

    const usageModeError = getAuthProfileUsageModeValidationError(data.authType, data.usageMode);
    if (usageModeError) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: usageModeError,
        path: ['usageMode'],
      });
    }

    // oauth2_app + preconfigured requires a refresh URL
    if (data.authType === 'oauth2_app') {
      const effectiveUsageMode = data.usageMode ?? 'preconfigured';
      if (effectiveUsageMode === 'preconfigured') {
        const refreshUrl = (data.config as { refreshUrl?: string } | undefined)?.refreshUrl;
        if (!refreshUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'refreshUrl'],
            message: 'AUTH_PROFILE_REFRESH_URL_REQUIRED',
          });
        }
      }
    }

    // integration profileType requires a connector value
    if (data.profileType === 'integration' && !data.connector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['connector'],
        message: 'AUTH_PROFILE_TYPE_MISMATCH',
      });
    }
  }),
);

export type CreateAuthProfileInput = z.infer<typeof CreateAuthProfileBase>;

// ─── Update Schema ─────────────────────────────────────────────────────

export const UpdateAuthProfileSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    environment: z.string().max(64).nullable().optional(),
    visibility: z.enum(['shared', 'personal']).optional(),
    connectionMode: z.enum(['shared', 'per_user']).optional(),
    usageMode: z.enum(AUTH_PROFILE_USAGE_MODES).optional(),
    config: z.record(z.unknown()).optional(),
    secrets: z.record(z.unknown()).optional(),
    connector: z.string().max(255).optional(),
    category: z.string().max(255).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
    linkedAppProfileId: z.string().nullable().optional(),
    status: AuthProfileStatusSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type UpdateAuthProfileInput = z.infer<typeof UpdateAuthProfileSchema>;

// ─── Per-Type Schema Maps ──────────────────────────────────────────────

export const AUTH_TYPE_CONFIG_SCHEMAS: Record<string, z.ZodType> = {
  none: NoneConfigSchema,
  api_key: ApiKeyConfigSchema,
  bearer: BearerConfigSchema,
  oauth2_app: OAuth2AppConfigSchema,
  oauth2_token: OAuth2TokenConfigSchema,
  oauth2_client_credentials: OAuth2ClientCredentialsConfigSchema,
  // Phase 2
  basic: BasicConfig,
  custom_header: CustomHeaderConfig,
  aws_iam: AwsIamConfig,
  azure_ad: AzureAdConfig,
  mtls: MtlsConfig,
  ssh_key: SshKeyConfig,
  // Phase 3
  digest: DigestConfig,
  kerberos: KerberosConfig,
  saml: SamlConfig,
  hawk: HawkConfig,
  ws_security: WsSecurityConfig,
};

/**
 * Returns the set of config keys the Zod schema for `authType` accepts.
 *
 * Single source of truth for client-side payload projection — the auth-profile
 * slide-over uses this to filter `config` state down to schema-valid keys
 * before sending to the API. Without this, stale keys from prior auth-type
 * selections, OAuth URL prefill, or connection-config helpers leak into the
 * payload and cause VALIDATION_ERROR on strict schemas.
 *
 * Returns an empty set for unknown auth types (caller should still send config
 * unchanged in that case — handled by the empty-set check in callers).
 */
export function getAllowedConfigKeys(authType: string): ReadonlySet<string> {
  const schema = AUTH_TYPE_CONFIG_SCHEMAS[authType];
  if (!schema) return new Set();
  // ZodObject exposes `.shape`. `.strict()` returns a ZodObject too.
  // `.superRefine()` / `.transform()` wrap the object in a ZodEffects whose
  // underlying schema sits at `_def.schema`. Walk through effects layers to
  // reach the object so the projection works for OAuth2 schemas which use
  // refine+transform for scopes normalisation.
  let current: unknown = schema;
  for (let i = 0; i < 6; i += 1) {
    const shape = (current as { shape?: Record<string, unknown> }).shape;
    if (shape && typeof shape === 'object') return new Set(Object.keys(shape));
    const inner = (current as { _def?: { schema?: unknown } })._def?.schema;
    if (!inner) break;
    current = inner;
  }
  return new Set();
}

export const AUTH_TYPE_SECRETS_SCHEMAS: Record<string, z.ZodType> = {
  none: NoneSecretsSchema,
  api_key: ApiKeySecretsSchema,
  bearer: BearerSecretsSchema,
  oauth2_app: OAuth2AppSecretsSchema,
  oauth2_token: OAuth2TokenSecretsSchema,
  oauth2_client_credentials: OAuth2ClientCredentialsSecretsSchema,
  // Phase 2
  basic: BasicSecrets,
  custom_header: CustomHeaderSecrets,
  aws_iam: AwsIamSecrets,
  azure_ad: AzureAdSecrets,
  mtls: MtlsSecrets,
  ssh_key: SshKeySecrets,
  // Phase 3
  digest: DigestSecrets,
  kerberos: KerberosSecrets,
  saml: SamlSecrets,
  hawk: HawkSecrets,
  ws_security: WsSecuritySecrets,
};

/**
 * Canonicalize oauth2_app config so older `scopes` payloads are stored as
 * `defaultScopes`. Invalid payloads are returned unchanged so callers can
 * surface the original validation failure.
 */
export function normalizeOAuth2AppConfig(config: unknown): Record<string, unknown> {
  const result = OAuth2AppConfigSchema.safeParse(config ?? {});
  if (!result.success) {
    return (config ?? {}) as Record<string, unknown>;
  }

  return result.data as Record<string, unknown>;
}

/**
 * Merge oauth2_app config updates while treating legacy `scopes` as an alias
 * for `defaultScopes`. This prevents partial updates from retaining an older
 * canonical field alongside the legacy alias.
 */
export function mergeOAuth2AppConfig(
  existingConfig: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...existingConfig,
    ...updates,
  };

  if (Object.prototype.hasOwnProperty.call(updates, 'scopes')) {
    if (updates.scopes === undefined) {
      delete merged.scopes;
    } else {
      merged.defaultScopes = updates.scopes;
      delete merged.scopes;
    }
    return merged;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'defaultScopes')) {
    delete merged.scopes;
  }

  return merged;
}

function formatIssueMessage(prefix: string, issue: z.ZodIssue): string {
  if (issue.path.length === 0) {
    return `${prefix}: ${issue.message}`;
  }
  return `${prefix}.${issue.path.join('.')}: ${issue.message}`;
}

/**
 * Validate a fully materialized auth profile payload after config and secrets
 * have been merged with any existing persisted values.
 */
export function getMaterializedAuthProfileValidationErrors(
  authType: string,
  config: unknown,
  secrets: unknown,
): string[] {
  const errors: string[] = [];
  const configSchema = AUTH_TYPE_CONFIG_SCHEMAS[authType];
  const secretsSchema = AUTH_TYPE_SECRETS_SCHEMAS[authType];

  const configResult = configSchema?.safeParse(config ?? {});
  if (configResult && !configResult.success) {
    errors.push(...configResult.error.issues.map((issue) => formatIssueMessage('config', issue)));
  }

  const secretsResult = secretsSchema?.safeParse(secrets ?? {});
  if (secretsResult && !secretsResult.success) {
    errors.push(...secretsResult.error.issues.map((issue) => formatIssueMessage('secrets', issue)));
  }

  if (
    errors.length === 0 &&
    authType === 'custom_header' &&
    configResult?.success &&
    secretsResult?.success
  ) {
    const keyValidation = CustomHeaderCrossFieldValidator(
      configResult.data as { headers: Record<string, string> },
      secretsResult.data as { headerValues: Record<string, string> },
    );
    const missing = keyValidation.missing ?? [];
    const extra = keyValidation.extra ?? [];

    if (!keyValidation.valid) {
      if (missing.length > 0) {
        errors.push(
          `secrets.headerValues: missing values for configured headers: ${missing.join(', ')}`,
        );
      }
      if (extra.length > 0) {
        errors.push(`secrets.headerValues: contains unexpected headers: ${extra.join(', ')}`);
      }
    }
  }

  return errors;
}
