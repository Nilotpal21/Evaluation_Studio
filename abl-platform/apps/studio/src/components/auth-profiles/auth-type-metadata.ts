/**
 * Auth Type Metadata Constants
 *
 * Display labels, descriptions, icons, color tokens, and form field
 * definitions for each auth type. Used by auth profile UI components
 * for consistent rendering and dynamic form generation.
 */

import type { LucideIcon } from 'lucide-react';
import { Shield, Key, KeyRound, Building2, UserCheck, Server } from 'lucide-react';
import type { AuthProfileUsageMode, AuthType } from '../../api/auth-profiles';

// =============================================================================
// FORM FIELD DEFINITION
// =============================================================================

export interface FormFieldDef {
  key: string;
  label: string;
  type: 'text' | 'url' | 'password' | 'select' | 'toggle' | 'tags' | 'textarea' | 'record';
  target?: 'config' | 'profile';
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
}

// =============================================================================
// AUTH TYPE METADATA (extended with form fields + icon components)
// =============================================================================

export type PhaseTier = 'common' | 'enterprise' | 'advanced';

export interface AuthTypeMetadata {
  label: string;
  shortLabel: string;
  description: string;
  icon: LucideIcon;
  color: string;
  category: 'basic' | 'oauth' | 'none' | 'enterprise';
  /** ABLP-913: categorization for stepped assignment UI (D-15). Separate from `category`. */
  phaseTier: PhaseTier;
  configFields: FormFieldDef[];
  secretFields: FormFieldDef[];
}

export const AUTH_PROFILE_USAGE_MODE_OPTIONS: Record<
  AuthProfileUsageMode,
  { label: string; description: string }
> = {
  preconfigured: {
    label: 'Preconfigured',
    description: 'Admin provides credentials at setup time. Users do not need to authorize.',
  },
  user_token: {
    label: 'User Token',
    description: 'Each user provides their own OAuth token, stored for reuse.',
  },
  jit: {
    label: 'JIT (Just-in-Time)',
    description: 'User is prompted to authorize mid-conversation when a tool needs credentials.',
  },
  preflight: {
    label: 'Preflight',
    description: 'User authorizes upfront before the session starts.',
  },
};

export const AUTH_TYPE_USAGE_MODES: Record<AuthType, AuthProfileUsageMode[]> = {
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
};

export function getDefaultUsageMode(type: AuthType): AuthProfileUsageMode {
  const [usageMode] = AUTH_TYPE_USAGE_MODES[type];
  return usageMode ?? 'preconfigured';
}

/** Metadata for all 17 auth types. Phase 1 types have full form fields; Phase 2/3 types have empty fields (UI de-emphasized). */
export const AUTH_TYPE_METADATA: Record<string, AuthTypeMetadata> = {
  none: {
    label: 'No Auth',
    shortLabel: 'No auth',
    description: 'No authentication required',
    icon: Shield,
    color: 'text-subtle',
    category: 'none',
    phaseTier: 'common',
    configFields: [],
    secretFields: [],
  },
  api_key: {
    label: 'API Key',
    shortLabel: 'API Key',
    description: 'Static API key sent via header or query parameter',
    icon: Key,
    color: 'text-warning',
    category: 'basic',
    phaseTier: 'common',
    configFields: [
      {
        key: 'headerName',
        label: 'Header Name',
        type: 'text',
        required: true,
        placeholder: 'X-API-Key',
        defaultValue: 'X-API-Key',
        helpText: 'HTTP header name to send the API key in',
      },
      {
        key: 'placement',
        label: 'Placement',
        type: 'select',
        defaultValue: 'header',
        options: [
          { value: 'header', label: 'Header' },
          { value: 'query', label: 'Query Parameter' },
        ],
      },
      {
        key: 'prefix',
        label: 'Prefix',
        type: 'text',
        placeholder: 'Token ',
        helpText: 'Optional text prepended to the API key. Include any required trailing space.',
      },
    ],
    secretFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'Enter your API key',
      },
    ],
  },
  bearer: {
    label: 'Bearer Token',
    shortLabel: 'Bearer',
    description: 'Static bearer token in Authorization header',
    icon: KeyRound,
    color: 'text-info',
    category: 'basic',
    phaseTier: 'common',
    configFields: [
      {
        key: 'prefix',
        label: 'Authorization Prefix',
        type: 'text',
        defaultValue: 'Bearer',
        placeholder: 'Bearer',
        helpText: 'Prefix before the token in the Authorization header',
      },
    ],
    secretFields: [
      {
        key: 'token',
        label: 'Token',
        type: 'password',
        required: true,
        placeholder: 'Enter your token',
      },
    ],
  },
  basic: {
    label: 'Basic Auth',
    shortLabel: 'Basic',
    description: 'HTTP Basic authentication with username and password',
    icon: Key,
    color: 'text-warning',
    category: 'basic',
    phaseTier: 'common',
    configFields: [],
    secretFields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: true,
        placeholder: 'Enter username',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        required: true,
        placeholder: 'Enter password',
      },
    ],
  },
  custom_header: {
    label: 'Custom Header',
    shortLabel: 'Header',
    description: 'Send one or more custom auth headers',
    icon: Key,
    color: 'text-warning',
    category: 'basic',
    phaseTier: 'common',
    configFields: [
      {
        key: 'headers',
        label: 'Header Names (key: label)',
        type: 'record',
        required: true,
        placeholder: 'X-API-Key: API Key',
        helpText:
          'Map header keys to display labels. Example: X-API-Key: API Key, X-Org-Id: Organization',
      },
    ],
    secretFields: [
      {
        key: 'headerValues',
        label: 'Header Values (key: value)',
        type: 'record',
        required: true,
        placeholder: 'X-API-Key: secret-value',
        helpText:
          'Provide values for the same keys defined above. Keys must match exactly (case-sensitive).',
      },
    ],
  },
  oauth2_app: {
    label: 'OAuth 2.0 App',
    shortLabel: 'OAuth App',
    description: 'OAuth application credentials (client ID + secret)',
    icon: Building2,
    color: 'text-info',
    category: 'oauth',
    phaseTier: 'common',
    configFields: [
      {
        key: 'authorizationUrl',
        label: 'Authorization URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/authorize',
      },
      {
        key: 'tokenUrl',
        label: 'Token URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/token',
      },
      {
        key: 'refreshUrl',
        label: 'Refresh URL',
        type: 'url',
        placeholder: 'https://provider.com/oauth/token',
        helpText:
          'Endpoint used to refresh access tokens. Required for preconfigured usage mode; many providers reuse the token URL.',
      },
      {
        key: 'defaultScopes',
        label: 'Scopes',
        type: 'tags',
        placeholder: 'read:users write:tasks offline_access',
        helpText:
          'Scopes should be space-separated. Example: read:users write:tasks offline_access',
      },
      {
        key: 'authorizationParams',
        label: 'Additional Authorization Parameters',
        type: 'record',
        helpText:
          'Extra key=value pairs appended to the authorization URL. For Google OAuth offline access (refresh tokens), set access_type=offline and prompt=consent. For Microsoft, include offline_access in the scopes field instead. Reserved OAuth params (client_id, redirect_uri, state, response_type, code_challenge, code_challenge_method, scope) are ignored.',
      },
    ],
    secretFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter client ID',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter client secret',
      },
    ],
  },
  oauth2_token: {
    label: 'OAuth 2.0 Token',
    shortLabel: 'OAuth Token',
    description: 'User-authorized OAuth token (linked to an OAuth app)',
    icon: UserCheck,
    color: 'text-success',
    category: 'enterprise',
    phaseTier: 'enterprise',
    configFields: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'text',
        required: true,
        placeholder: 'github',
        helpText: 'Provider or connector name associated with this token.',
      },
      {
        key: 'linkedAppProfileId',
        label: 'OAuth App Profile',
        type: 'text',
        target: 'profile',
        required: true,
        placeholder: 'app-profile-123',
        helpText: 'The OAuth 2.0 App profile this token is linked to',
      },
    ],
    secretFields: [
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'Access token',
      },
      {
        key: 'refreshToken',
        label: 'Refresh Token',
        type: 'password',
        placeholder: 'Refresh token (optional)',
      },
    ],
  },
  oauth2_client_credentials: {
    label: 'Client Credentials',
    shortLabel: 'Client Creds',
    description: 'Machine-to-machine OAuth via client credentials grant',
    icon: Server,
    color: 'text-info',
    category: 'oauth',
    phaseTier: 'common',
    configFields: [
      {
        key: 'tokenUrl',
        label: 'Token URL',
        type: 'url',
        required: true,
        placeholder: 'https://provider.com/oauth/token',
      },
      {
        key: 'scopes',
        label: 'Scopes',
        type: 'tags',
        placeholder: 'read:users write:tasks offline_access',
        helpText:
          'Scopes should be space-separated. Example: read:users write:tasks offline_access',
      },
      {
        key: 'audience',
        label: 'Audience',
        type: 'text',
        placeholder: 'https://api.example.com/',
        helpText: 'Optional OAuth audience/resource identifier required by providers like Auth0.',
      },
    ],
    secretFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter client ID',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter client secret',
      },
    ],
  },
  azure_ad: {
    label: 'Azure AD',
    shortLabel: 'Azure AD',
    description: 'Microsoft Entra ID (Azure Active Directory) for enterprise SSO',
    icon: Building2,
    color: 'text-info',
    category: 'enterprise',
    phaseTier: 'common',
    configFields: [
      {
        key: 'tenantId',
        label: 'Azure Tenant ID',
        type: 'text',
        required: true,
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      {
        key: 'scopes',
        label: 'Scopes',
        type: 'tags',
        placeholder: 'https://graph.microsoft.com/.default offline_access',
        helpText:
          'Scopes should be space-separated. Example: https://graph.microsoft.com/.default offline_access',
      },
    ],
    secretFields: [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'Enter client ID',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'Enter client secret',
      },
    ],
  },
  aws_iam: {
    label: 'AWS IAM (SigV4)',
    shortLabel: 'AWS IAM',
    description: 'Sign requests with AWS Signature Version 4',
    icon: KeyRound,
    color: 'text-warning',
    category: 'enterprise',
    phaseTier: 'common',
    configFields: [
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        placeholder: 'us-east-1',
      },
      {
        key: 'service',
        label: 'Service',
        type: 'text',
        required: true,
        placeholder: 'execute-api',
      },
      {
        key: 'bucket',
        label: 'Bucket (S3 only)',
        type: 'text',
        placeholder: 'my-bucket',
      },
      {
        key: 'endpoint',
        label: 'Endpoint (optional, S3-compatible)',
        type: 'text',
        placeholder: 'https://s3.us-east-1.amazonaws.com',
      },
    ],
    secretFields: [
      {
        key: 'accessKeyId',
        label: 'Access Key ID',
        type: 'text',
        required: true,
        placeholder: 'AKIA...',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret Access Key',
        type: 'password',
        required: true,
        placeholder: 'Enter secret access key',
      },
      {
        key: 'sessionToken',
        label: 'Session Token',
        type: 'password',
        placeholder: 'Optional session token',
      },
    ],
  },
  mtls: {
    label: 'mTLS',
    shortLabel: 'mTLS',
    description: 'Mutual TLS with client certificate and private key',
    icon: Shield,
    color: 'text-success',
    category: 'enterprise',
    phaseTier: 'common',
    configFields: [],
    secretFields: [
      {
        key: 'clientCert',
        label: 'Client Certificate (PEM)',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN CERTIFICATE-----',
      },
      {
        key: 'clientKey',
        label: 'Client Private Key (PEM)',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----',
      },
      {
        key: 'caCert',
        label: 'CA Certificate (PEM)',
        type: 'textarea',
        placeholder: 'Optional CA certificate',
      },
    ],
  },
  ssh_key: {
    label: 'SSH Key',
    shortLabel: 'SSH',
    description: 'Authenticate with SSH private key credentials',
    icon: Key,
    color: 'text-warning',
    category: 'enterprise',
    phaseTier: 'enterprise',
    configFields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        placeholder: 'git',
        helpText: 'SSH username',
      },
    ],
    secretFields: [
      {
        key: 'privateKey',
        label: 'Private Key',
        type: 'password',
        required: true,
        placeholder: 'Paste SSH private key',
      },
    ],
  },
  digest: {
    label: 'Digest Auth',
    shortLabel: 'Digest',
    description: 'HTTP Digest authentication with challenge-response',
    icon: Shield,
    color: 'text-subtle',
    category: 'enterprise',
    phaseTier: 'advanced',
    configFields: [],
    secretFields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: true,
        placeholder: 'Enter username',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        required: true,
        placeholder: 'Enter password',
      },
    ],
  },
  kerberos: {
    label: 'Kerberos',
    shortLabel: 'Kerberos',
    description: 'SPNEGO/Kerberos authentication for enterprise systems',
    icon: Shield,
    color: 'text-subtle',
    category: 'enterprise',
    phaseTier: 'advanced',
    configFields: [
      {
        key: 'realm',
        label: 'Realm',
        type: 'text',
        required: true,
        placeholder: 'EXAMPLE.COM',
      },
    ],
    secretFields: [
      {
        key: 'keytab',
        label: 'Keytab',
        type: 'password',
        required: true,
        placeholder: 'Base64-encoded keytab',
      },
    ],
  },
  saml: {
    label: 'SAML',
    shortLabel: 'SAML',
    description: 'SAML assertion-based authentication flow',
    icon: Building2,
    color: 'text-info',
    category: 'enterprise',
    phaseTier: 'advanced',
    configFields: [
      {
        key: 'idpMetadataUrl',
        label: 'IdP Metadata URL',
        type: 'url',
        required: true,
        placeholder: 'https://idp.example.com/metadata',
      },
      {
        key: 'entityId',
        label: 'Entity ID',
        type: 'text',
        required: true,
        placeholder: 'urn:my-service',
      },
      {
        key: 'assertionConsumerServiceUrl',
        label: 'ACS URL',
        type: 'url',
        required: true,
        placeholder: 'https://api.example.com/saml/acs',
      },
    ],
    secretFields: [
      {
        key: 'privateKey',
        label: 'Private Key',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----',
      },
      {
        key: 'certificate',
        label: 'Certificate',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN CERTIFICATE-----',
      },
    ],
  },
  hawk: {
    label: 'HAWK',
    shortLabel: 'HAWK',
    description: 'HAWK MAC request signing',
    icon: KeyRound,
    color: 'text-warning',
    category: 'enterprise',
    phaseTier: 'advanced',
    configFields: [
      {
        key: 'algorithm',
        label: 'Algorithm',
        type: 'select',
        defaultValue: 'sha256',
        options: [
          { value: 'sha256', label: 'SHA-256' },
          { value: 'sha1', label: 'SHA-1' },
        ],
      },
    ],
    secretFields: [
      {
        key: 'id',
        label: 'Credential ID',
        type: 'text',
        required: true,
        placeholder: 'hawk-credential-id',
      },
      {
        key: 'key',
        label: 'Credential Key',
        type: 'password',
        required: true,
        placeholder: 'Enter shared secret key',
      },
    ],
  },
  ws_security: {
    label: 'WS-Security',
    shortLabel: 'WS-Sec',
    description: 'SOAP WS-Security UsernameToken / certificate auth',
    icon: Shield,
    color: 'text-info',
    category: 'enterprise',
    phaseTier: 'advanced',
    configFields: [
      {
        key: 'mustUnderstand',
        label: 'mustUnderstand',
        type: 'toggle',
        defaultValue: true,
        helpText: 'Set SOAP mustUnderstand on WS-Security header.',
      },
    ],
    secretFields: [
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: true,
        placeholder: 'Enter username',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        required: true,
        placeholder: 'Enter password',
      },
      {
        key: 'certificate',
        label: 'Certificate (optional)',
        type: 'textarea',
        placeholder: '-----BEGIN CERTIFICATE-----',
      },
    ],
  },
};

// =============================================================================
// AUTH TYPE CATEGORIES (for type selector grouping)
// =============================================================================

export const AUTH_TYPE_CATEGORIES = [
  { key: 'basic' as const, label: 'Basic Authentication' },
  { key: 'oauth' as const, label: 'OAuth 2.0' },
  { key: 'enterprise' as const, label: 'Enterprise' },
] as const;

/** ABLP-913 D-15: Phase tier categories for stepped AuthProfileAssignment */
export const PHASE_TIER_CATEGORIES: { key: PhaseTier; label: string }[] = [
  { key: 'common', label: 'Common' },
  { key: 'enterprise', label: 'Enterprise' },
  { key: 'advanced', label: 'Advanced' },
];

/** All auth types that support inline-add (simple credential types where admin can add value inline) */
export const INLINE_ADD_AUTH_TYPES: Set<string> = new Set([
  'api_key',
  'bearer',
  'basic',
  'custom_header',
]);

/** Complex auth types that only support profile dropdown + Create CTA (no inline-add) */
export const COMPLEX_AUTH_TYPES: Set<string> = new Set([
  'oauth2_app',
  'oauth2_client_credentials',
  'azure_ad',
  'aws_iam',
  'mtls',
]);

/**
 * Phase 1 selectable auth types (excludes 'none' and 'oauth2_token' which are system-managed).
 * `azure_ad` intentionally hidden — its UI/Zod shapes do not yet match on this branch.
 */
export const PHASE1_AUTH_TYPES: AuthType[] = [
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_client_credentials',
];

/**
 * Phase 2/3 selectable auth types.
 * `ssh_key`, `digest`, `kerberos` intentionally hidden — their UI/Zod shapes do not yet match on this branch.
 */
const PHASE_2_3_AUTH_TYPES: AuthType[] = [
  'basic',
  'custom_header',
  'mtls',
  'aws_iam',
  'saml',
  'hawk',
  'ws_security',
];

function isAuthProfilePhase23UiEnabled(): boolean {
  const rawFlagValue =
    process.env.NEXT_PUBLIC_AUTH_PROFILE_PHASE_2_3_UI ?? process.env.AUTH_PROFILE_PHASE_2_3_UI;
  return rawFlagValue !== 'false';
}

export const SUPPORTED_AUTH_TYPES: AuthType[] = isAuthProfilePhase23UiEnabled()
  ? [...PHASE1_AUTH_TYPES, ...PHASE_2_3_AUTH_TYPES]
  : [...PHASE1_AUTH_TYPES];

// =============================================================================
// STATUS COLORS
// =============================================================================

// =============================================================================
// INTEGRATION TYPE METADATA HELPER
// =============================================================================

/**
 * Maps a connector's available auth types from provider data to their display
 * metadata. Used by IntegrationCard for type badge rendering.
 */
export function getIntegrationTypeMetadata(
  availableAuthTypes: string[],
): Pick<AuthTypeMetadata, 'label' | 'shortLabel' | 'icon' | 'color'>[] {
  return availableAuthTypes
    .map((authType) => {
      const meta = AUTH_TYPE_METADATA[authType];
      if (!meta) return null;
      return {
        label: meta.label,
        shortLabel: meta.shortLabel,
        icon: meta.icon,
        color: meta.color,
      };
    })
    .filter(
      (m): m is Pick<AuthTypeMetadata, 'label' | 'shortLabel' | 'icon' | 'color'> => m !== null,
    );
}

// =============================================================================
// STATUS COLORS
// =============================================================================

export const AUTH_STATUS_COLORS: Record<string, string> = {
  active: 'bg-success-subtle text-success border-success-muted',
  expired: 'bg-warning-subtle text-warning border-warning',
  revoked: 'bg-error-subtle text-error border-error-muted',
  invalid: 'bg-background-muted text-subtle border-default',
};

export function getAuthTypeShortLabel(authType: string): string {
  return AUTH_TYPE_METADATA[authType]?.shortLabel ?? authType;
}
