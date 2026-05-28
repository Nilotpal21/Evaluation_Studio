/**
 * Auth Profile Phase 2 Zod Schemas
 *
 * Validation schemas for 6 new auth types:
 * basic, custom_header, aws_iam, azure_ad, mtls, ssh_key.
 */

import { z } from 'zod';

// ── basic ──────────────────────────────────────────────────────────────
export const BasicConfigSchema = z.object({}).strict();

export const BasicSecretsSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

// ── custom_header ──────────────────────────────────────────────────────
export const CustomHeaderConfigSchema = z
  .object({
    headers: z.record(z.string(), z.string()).refine((h) => Object.keys(h).length > 0, {
      message: 'At least one header name is required',
    }),
  })
  .strict();

export const CustomHeaderSecretsSchema = z
  .object({
    headerValues: z.record(z.string(), z.string()).refine((h) => Object.keys(h).length > 0, {
      message: 'At least one header value is required',
    }),
  })
  .strict();

/**
 * Cross-field validation: headerValues keys must match config.headers keys.
 * Enforce in the CreateAuthProfile discriminated union branch via .superRefine().
 */
export const CustomHeaderCrossFieldValidator = (
  config: { headers: Record<string, string> },
  secrets: { headerValues: Record<string, string> },
) => {
  const configKeys = new Set(Object.keys(config.headers));
  const secretKeys = new Set(Object.keys(secrets.headerValues));
  const missing = [...configKeys].filter((k) => !secretKeys.has(k));
  const extra = [...secretKeys].filter((k) => !configKeys.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return { valid: false, missing, extra };
  }
  return { valid: true };
};

// ── aws_iam ────────────────────────────────────────────────────────────
export const AwsIamConfigSchema = z
  .object({
    region: z.string().min(1),
    service: z.string().min(1),
    // Connector-specific extras consumed by AP pieces:
    //   - S3: bucket (required for piece actions), endpoint (optional, custom S3-compatible URL)
    // Stored as top-level config and surfaced as auth.bucket / auth.endpoint by the bridge.
    bucket: z.string().optional(),
    endpoint: z.string().optional(),
  })
  .strict();

export const AwsIamSecretsSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
  })
  .strict();

// ── azure_ad ───────────────────────────────────────────────────────────
export const AzureAdConfigSchema = z
  .object({
    tenantId: z.string().min(1),
    resource: z.string().url(),
    endpoint: z.string().url().default('https://login.microsoftonline.com'),
    // Optional explicit scopes. When omitted, the runtime falls back to
    // `${resource}/.default` for the client-credentials grant. Useful when
    // the app needs delegated/granular scopes (e.g. graph offline_access +
    // Files.ReadWrite.All for OneDrive).
    scopes: z.array(z.string().min(1)).optional(),
    // OIDC Identity Provider fields (used by end-user public API auth).
    // For Azure AD, issuer is derivable from tenantId + endpoint but can be
    // explicitly set for strict validation of IdP tokens.
    issuer: z.string().url().optional(),
    audience: z.string().min(1).optional(),
    jwksUri: z.string().url().optional(),
  })
  .strict();

export const AzureAdSecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

// ── mtls ───────────────────────────────────────────────────────────────
export const MtlsConfigSchema = z.object({}).strict();

export const MtlsSecretsSchema = z
  .object({
    clientCert: z.string().min(1),
    clientKey: z.string().min(1),
    caCert: z.string().optional(),
  })
  .strict();

// ── ssh_key ────────────────────────────────────────────────────────────
export const SshKeyConfigSchema = z
  .object({
    keyType: z.enum(['ed25519', 'rsa']).default('rsa'),
  })
  .strict();

export const SshKeySecretsSchema = z
  .object({
    privateKey: z.string().min(1),
    passphrase: z.string().optional(),
  })
  .strict();
export const PHASE2_CORE_AUTH_TYPES = ['basic', 'custom_header', 'aws_iam', 'mtls'] as const;

export type Phase2CoreAuthType = (typeof PHASE2_CORE_AUTH_TYPES)[number];

export const AUTH_PROFILE_CONSUMER_KINDS = [
  'auth_profile_editor',
  'http_tool',
  'raw_connection',
] as const;

export type AuthProfileConsumerKind = (typeof AUTH_PROFILE_CONSUMER_KINDS)[number];

export const AUTH_PROFILE_SUPPORT_LEVELS = ['supported', 'attach_only', 'unsupported'] as const;

export type AuthProfileSupportLevel = (typeof AUTH_PROFILE_SUPPORT_LEVELS)[number];

export type AuthProfileSupportReasonCode =
  | 'SUPPORTED_EDITOR_AUTHORING'
  | 'SUPPORTED_HTTP_HEADERS'
  | 'SUPPORTED_HTTP_MTLS'
  | 'SUPPORTED_HTTP_SIGV4'
  | 'SUPPORTED_CONNECTION_HEADERS'
  | 'ATTACH_ONLY_NO_SIGNING_HOOK'
  | 'ATTACH_ONLY_NO_TLS_PROPAGATION';

export interface AuthProfileSupportDecision {
  authType: Phase2CoreAuthType;
  consumerKind: AuthProfileConsumerKind;
  level: AuthProfileSupportLevel;
  runtimeHonored: boolean;
  designTimeSelectable: boolean;
  message: string;
  reasonCode: AuthProfileSupportReasonCode;
}

const SUPPORT_MATRIX: Record<
  Phase2CoreAuthType,
  Record<AuthProfileConsumerKind, Omit<AuthProfileSupportDecision, 'authType' | 'consumerKind'>>
> = {
  basic: {
    auth_profile_editor: {
      level: 'supported',
      runtimeHonored: false,
      designTimeSelectable: true,
      message: 'Basic auth can be authored in Studio for the Phase 2 core slice.',
      reasonCode: 'SUPPORTED_EDITOR_AUTHORING',
    },
    http_tool: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message: 'Basic auth is honored on the supported HTTP tool path.',
      reasonCode: 'SUPPORTED_HTTP_HEADERS',
    },
    raw_connection: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message:
        'Basic auth can be attached to raw connections that resolve reusable header-style credentials.',
      reasonCode: 'SUPPORTED_CONNECTION_HEADERS',
    },
  },
  custom_header: {
    auth_profile_editor: {
      level: 'supported',
      runtimeHonored: false,
      designTimeSelectable: true,
      message: 'Custom header auth can be authored in Studio for the Phase 2 core slice.',
      reasonCode: 'SUPPORTED_EDITOR_AUTHORING',
    },
    http_tool: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message: 'Custom header auth is honored on the supported HTTP tool path.',
      reasonCode: 'SUPPORTED_HTTP_HEADERS',
    },
    raw_connection: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message:
        'Custom header auth can be attached to raw connections that resolve reusable header-style credentials.',
      reasonCode: 'SUPPORTED_CONNECTION_HEADERS',
    },
  },
  aws_iam: {
    auth_profile_editor: {
      level: 'supported',
      runtimeHonored: false,
      designTimeSelectable: true,
      message: 'AWS IAM auth can be authored in Studio for the supported HTTP signing path.',
      reasonCode: 'SUPPORTED_EDITOR_AUTHORING',
    },
    http_tool: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message:
        'AWS IAM auth is supported only where the final HTTP request can be signed with SigV4.',
      reasonCode: 'SUPPORTED_HTTP_SIGV4',
    },
    raw_connection: {
      level: 'attach_only',
      runtimeHonored: false,
      designTimeSelectable: true,
      message:
        'Attaching AWS IAM auth to a raw connection does not guarantee request signing. A downstream signing hook is required.',
      reasonCode: 'ATTACH_ONLY_NO_SIGNING_HOOK',
    },
  },
  mtls: {
    auth_profile_editor: {
      level: 'supported',
      runtimeHonored: false,
      designTimeSelectable: true,
      message: 'mTLS auth can be authored in Studio for supported HTTPS transport paths.',
      reasonCode: 'SUPPORTED_EDITOR_AUTHORING',
    },
    http_tool: {
      level: 'supported',
      runtimeHonored: true,
      designTimeSelectable: true,
      message: 'mTLS is supported only on HTTPS HTTP tools that propagate TLS client options.',
      reasonCode: 'SUPPORTED_HTTP_MTLS',
    },
    raw_connection: {
      level: 'attach_only',
      runtimeHonored: false,
      designTimeSelectable: true,
      message:
        'Attaching mTLS to a raw connection does not guarantee TLS client-certificate propagation. A transport-aware consumer is required.',
      reasonCode: 'ATTACH_ONLY_NO_TLS_PROPAGATION',
    },
  },
};

export function isPhase2CoreAuthType(value: string): value is Phase2CoreAuthType {
  return (PHASE2_CORE_AUTH_TYPES as readonly string[]).includes(value);
}

export function getAuthProfileSupportDecision(
  authType: Phase2CoreAuthType,
  consumerKind: AuthProfileConsumerKind,
): AuthProfileSupportDecision {
  const decision = SUPPORT_MATRIX[authType][consumerKind];
  return {
    authType,
    consumerKind,
    ...decision,
  };
}

export function listAuthProfileSupportDecisions(
  consumerKind: AuthProfileConsumerKind,
): AuthProfileSupportDecision[] {
  return PHASE2_CORE_AUTH_TYPES.map((authType) =>
    getAuthProfileSupportDecision(authType, consumerKind),
  );
}

export function listSelectablePhase2CoreAuthTypes(
  consumerKind: AuthProfileConsumerKind,
): Phase2CoreAuthType[] {
  return listAuthProfileSupportDecisions(consumerKind)
    .filter((decision) => decision.designTimeSelectable)
    .map((decision) => decision.authType);
}
