import type { ResolvedConnection } from '../types.js';

interface ResolveProviderApiBaseOptions {
  config?: Record<string, unknown> | null;
  envVar: string;
  defaultBaseUrl: string;
  providerConfigKey: string;
}

const PROVIDER_API_BASE_OVERRIDE_KEYS = [
  'apiBaseUrl',
  'lineApiBaseUrl',
  'lineDataApiBaseUrl',
  'slackApiBaseUrl',
  'telegramApiBaseUrl',
  'twilioApiBaseUrl',
] as const;

function normalizeApiBaseUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function areProviderApiBaseOverridesAllowed(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.ALLOW_CHANNEL_PROVIDER_API_BASE_OVERRIDE === 'true'
  );
}

export function getDisallowedProviderApiBaseOverrides(
  config: Record<string, unknown> | null | undefined,
): string[] {
  if (!config || areProviderApiBaseOverridesAllowed()) {
    return [];
  }

  return PROVIDER_API_BASE_OVERRIDE_KEYS.filter((key) =>
    normalizeApiBaseUrl(config[key] as string | undefined),
  );
}

export function resolveProviderApiBase(options: ResolveProviderApiBaseOptions): string {
  if (areProviderApiBaseOverridesAllowed()) {
    const fromConfig = normalizeApiBaseUrl(options.config?.[options.providerConfigKey] as string);
    if (fromConfig) {
      return fromConfig;
    }

    const fromSharedConfig = normalizeApiBaseUrl(options.config?.apiBaseUrl as string);
    if (fromSharedConfig) {
      return fromSharedConfig;
    }
  }

  const fromEnv = normalizeApiBaseUrl(process.env[options.envVar]);
  if (fromEnv) {
    return fromEnv;
  }

  return options.defaultBaseUrl;
}

export function resolveConnectionProviderApiBase(
  connection: ResolvedConnection | null | undefined,
  envVar: string,
  defaultBaseUrl: string,
  providerConfigKey: string,
): string {
  return resolveProviderApiBase({
    config: (connection?.config as Record<string, unknown> | null | undefined) ?? null,
    envVar,
    defaultBaseUrl,
    providerConfigKey,
  });
}
