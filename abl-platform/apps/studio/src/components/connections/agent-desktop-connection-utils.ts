import type { AuthType } from '../../api/auth-profiles';
import type { AgentDesktopProviderDef } from './agent-desktop-registry';

export interface AgentDesktopConnectionSetup {
  authType: AuthType;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface BuildAgentDesktopConnectionSetupOptions {
  existingSecretKeys?: ReadonlySet<string>;
}

const EMPTY_SECRET_KEY_SET = new Set<string>();

export function trimFieldValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getAgentDesktopAuthProfileName(connectionName: string): string {
  return `${connectionName} Credentials`;
}

function requireField(credentials: Record<string, string>, key: string, label: string): string {
  const value = trimFieldValue(credentials[key]);
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function getOptionalSecret(credentials: Record<string, string>, key: string): string | undefined {
  const value = trimFieldValue(credentials[key]);
  return value || undefined;
}

function requireSecretOrExisting(
  credentials: Record<string, string>,
  existingSecretKeys: ReadonlySet<string>,
  key: string,
  label: string,
): string | undefined {
  const providedValue = getOptionalSecret(credentials, key);
  if (providedValue) {
    return providedValue;
  }
  if (existingSecretKeys.has(key)) {
    return undefined;
  }
  throw new Error(`${label} is required`);
}

export function getAgentDesktopCredentialDefaults(
  provider: AgentDesktopProviderDef,
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  const safeMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};

  for (const field of provider.fields) {
    if (field.type === 'password') {
      defaults[field.key] = '';
      continue;
    }

    const value = safeMetadata[field.key];
    defaults[field.key] = value == null ? '' : String(value);
  }

  return defaults;
}

export function buildAgentDesktopConnectionSetup(
  provider: AgentDesktopProviderDef,
  credentials: Record<string, string>,
  options: BuildAgentDesktopConnectionSetupOptions = {},
): AgentDesktopConnectionSetup {
  const existingSecretKeys = options.existingSecretKeys ?? EMPTY_SECRET_KEY_SET;

  switch (provider.id) {
    case 'smartassist': {
      const baseUrl = requireField(credentials, 'baseUrl', 'Base URL');
      const appId = requireField(credentials, 'appId', 'App ID');
      const apiKey = getOptionalSecret(credentials, 'apiKey');
      const webhookSecret = getOptionalSecret(credentials, 'webhookSecret');
      const orgId = trimFieldValue(credentials.orgId);
      const hasEffectiveApiKey = Boolean(apiKey) || existingSecretKeys.has('apiKey');

      if (webhookSecret && !hasEffectiveApiKey) {
        throw new Error('Webhook Secret requires an API Key for SmartAssist connections');
      }

      return {
        authType: hasEffectiveApiKey ? 'api_key' : 'none',
        config: hasEffectiveApiKey
          ? {
              headerName: 'X-API-Key',
              placement: 'header',
            }
          : {},
        secrets: {
          ...(apiKey ? { apiKey } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        },
        metadata: {
          baseUrl,
          appId,
          ...(orgId ? { orgId } : {}),
        },
      };
    }

    case 'five9': {
      const tenantName = requireField(credentials, 'tenantName', 'Tenant Name');
      const campaignName = requireField(credentials, 'campaignName', 'Campaign Name');
      const authModeRaw = requireField(credentials, 'authMode', 'Auth Mode').toLowerCase();
      const host = trimFieldValue(credentials.host);
      const callbackUrl = trimFieldValue(credentials.callbackUrl);

      if (authModeRaw !== 'anonymous' && authModeRaw !== 'supervisor') {
        throw new Error('Auth Mode must be either anonymous or supervisor');
      }

      if (authModeRaw === 'supervisor') {
        const username = requireSecretOrExisting(
          credentials,
          existingSecretKeys,
          'username',
          'Username',
        );
        const password = requireSecretOrExisting(
          credentials,
          existingSecretKeys,
          'password',
          'Password',
        );

        return {
          authType: 'basic',
          config: {},
          secrets: {
            ...(username ? { username } : {}),
            ...(password ? { password } : {}),
          },
          metadata: {
            tenantName,
            campaignName,
            authMode: authModeRaw,
            ...(host ? { host } : {}),
            ...(callbackUrl ? { callbackUrl } : {}),
          },
        };
      }

      return {
        authType: 'none',
        config: {},
        secrets: {},
        metadata: {
          tenantName,
          campaignName,
          authMode: authModeRaw,
          ...(host ? { host } : {}),
          ...(callbackUrl ? { callbackUrl } : {}),
        },
      };
    }

    default:
      throw new Error(`${provider.label} is not supported in the shared Connections flow yet`);
  }
}
