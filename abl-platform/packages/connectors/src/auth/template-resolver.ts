import { validateUrlForSSRF } from '@agent-platform/shared/security';

import type {
  ProviderConnectionConfig,
  ProviderConnectionConfigField,
  ProviderParamValue,
} from '../adapters/nango/provider-mapper.js';

export type ConnectionConfigValues = Record<string, string>;
export type ConnectionTemplateParamValue = ProviderParamValue;

export interface TemplateResolverSource {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  proxyBaseUrl?: string;
  authorizationParams?: Record<string, ConnectionTemplateParamValue>;
  tokenParams?: Record<string, ConnectionTemplateParamValue>;
  connectionConfig?: ProviderConnectionConfig;
}

export interface ResolvedUrlCheck {
  safe: boolean;
  reason?: string;
}

export type ResolvedUrlValidator = (url: string) => ResolvedUrlCheck;

const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;
const DISALLOWED_CONNECTION_CONFIG_CHARS_RE = /[/?#@\\:%]/;
const MAX_CONNECTION_CONFIG_KEYS = 10;
const MAX_CONNECTION_CONFIG_VALUE_LENGTH = 256;

function getConnectionTemplateRegex(): RegExp {
  return /\$\{connectionConfig\.([A-Za-z0-9_.-]+)\}|\{([A-Za-z0-9_.-]+)\}/g;
}

function mergeConnectionConfig(
  ...configs: Array<ProviderConnectionConfig | undefined>
): ProviderConnectionConfig | undefined {
  const merged: ProviderConnectionConfig = {};

  for (const config of configs) {
    if (!config) {
      continue;
    }

    for (const [key, field] of Object.entries(config)) {
      merged[key] = {
        ...(merged[key] ?? {}),
        ...field,
      };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function collectTemplateKeys(value?: string): string[] {
  if (!value) {
    return [];
  }

  const matches = value.matchAll(getConnectionTemplateRegex());
  const keys = new Set<string>();
  for (const match of matches) {
    const key = match[1] ?? match[2];
    if (key) {
      keys.add(key);
    }
  }

  return [...keys];
}

function inferConnectionConfigFromSource(value?: string): ProviderConnectionConfig | undefined {
  if (!value) {
    return undefined;
  }

  const branches = value
    .split('||')
    .map((branch) => branch.trim())
    .filter(Boolean);
  const branchKeys = branches.map((branch) => new Set(collectTemplateKeys(branch)));
  const allKeys = new Set(branchKeys.flatMap((keys) => [...keys]));

  if (allKeys.size === 0) {
    return undefined;
  }

  const inferredConfig: ProviderConnectionConfig = {};
  for (const key of allKeys) {
    const appearsInEveryBranch = branchKeys.every((keys) => keys.has(key));
    const field: ProviderConnectionConfigField = {
      type: 'string',
      title: key,
      optional: branches.length > 1 && !appearsInEveryBranch,
    };

    if (key.includes('hostname')) {
      field.format = 'hostname';
    }
    if (key.endsWith('url') || key.includes('_url')) {
      field.format = 'uri';
    }
    if (
      value.includes(`https://\${connectionConfig.${key}}`) ||
      value.includes(`https://{${key}}`)
    ) {
      field.prefix = 'https://';
    }

    inferredConfig[key] = field;
  }

  return inferredConfig;
}

function inferConnectionConfigFromParamValues(
  params?: Record<string, ConnectionTemplateParamValue>,
): ProviderConnectionConfig | undefined {
  if (!params) {
    return undefined;
  }

  return mergeConnectionConfig(
    ...Object.values(params)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => inferConnectionConfigFromSource(value)),
  );
}

function buildConnectionConfigSchema(
  source: TemplateResolverSource,
): ProviderConnectionConfig | undefined {
  return mergeConnectionConfig(
    inferConnectionConfigFromSource(source.authorizationUrl),
    inferConnectionConfigFromSource(source.tokenUrl),
    inferConnectionConfigFromSource(source.refreshUrl),
    inferConnectionConfigFromSource(source.proxyBaseUrl),
    inferConnectionConfigFromParamValues(source.authorizationParams),
    inferConnectionConfigFromParamValues(source.tokenParams),
    source.connectionConfig,
  );
}

function validateConnectionConfigValue(
  key: string,
  value: string,
  field?: ProviderConnectionConfigField,
): void {
  if (field?.enum && field.enum.length > 0 && !field.enum.includes(value)) {
    throw new Error(`connectionConfig.${key} must be one of: ${field.enum.map(String).join(', ')}`);
  }

  if (field?.pattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(field.pattern);
    } catch {
      throw new Error(`Invalid pattern configured for connectionConfig.${key}`);
    }
    if (!pattern.test(value)) {
      throw new Error(`connectionConfig.${key} must match pattern ${field.pattern}`);
    }
  }

  if (field?.format === 'hostname') {
    if (!HOSTNAME_RE.test(value)) {
      throw new Error(`connectionConfig.${key} must be a valid hostname`);
    }
    return;
  }

  if (field?.format === 'uri') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`connectionConfig.${key} must be a valid http(s) URI`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`connectionConfig.${key} must be a valid http(s) URI`);
    }
    return;
  }

  if (DISALLOWED_CONNECTION_CONFIG_CHARS_RE.test(value)) {
    throw new Error(`connectionConfig.${key} contains forbidden characters`);
  }
}

export function normalizeConnectionConfig(
  connectionConfig?: Record<string, unknown>,
  source?: TemplateResolverSource,
): ConnectionConfigValues | undefined {
  if (connectionConfig === undefined) {
    return undefined;
  }

  if (
    connectionConfig === null ||
    typeof connectionConfig !== 'object' ||
    Array.isArray(connectionConfig)
  ) {
    throw new Error('connectionConfig must be an object of string values');
  }

  const entries = Object.entries(connectionConfig);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > MAX_CONNECTION_CONFIG_KEYS) {
    throw new Error(`connectionConfig supports at most ${MAX_CONNECTION_CONFIG_KEYS} keys`);
  }

  const schema = source ? buildConnectionConfigSchema(source) : undefined;
  const allowedKeys = new Set(Object.keys(schema ?? {}));
  if (allowedKeys.size === 0) {
    throw new Error('This connector does not accept connectionConfig values');
  }

  const normalizedEntries: Array<[string, string]> = [];
  for (const [key, rawValue] of entries) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unsupported connection configuration key: ${key}`);
    }
    if (typeof rawValue !== 'string') {
      throw new Error('connectionConfig values must be strings');
    }

    const trimmedValue = rawValue.trim();
    if (trimmedValue.length === 0) {
      continue;
    }
    if (trimmedValue.length > MAX_CONNECTION_CONFIG_VALUE_LENGTH) {
      throw new Error(
        `connectionConfig.${key} exceeds ${MAX_CONNECTION_CONFIG_VALUE_LENGTH} characters`,
      );
    }

    validateConnectionConfigValue(key, trimmedValue, schema?.[key]);
    normalizedEntries.push([key, trimmedValue]);
  }

  return normalizedEntries.length > 0 ? Object.fromEntries(normalizedEntries) : undefined;
}

export function resolveConnectionConfigTemplate(
  template: string,
  connectionConfig?: ConnectionConfigValues,
): { resolved: string; missingKeys: string[] } {
  const missingKeys = new Set<string>();
  const resolved = template.replace(getConnectionTemplateRegex(), (_, modernKey, legacyKey) => {
    const key = (modernKey ?? legacyKey) as string;
    const value = connectionConfig?.[key]?.trim();
    if (!value) {
      missingKeys.add(key);
      return `__missing__${key}__`;
    }
    return value;
  });

  return { resolved, missingKeys: [...missingKeys] };
}

export function resolveTemplatedUrl(
  template: string,
  opts?: {
    connectionConfig?: ConnectionConfigValues;
    validateResolvedUrl?: ResolvedUrlValidator;
  },
): string {
  const candidates = template
    .split('||')
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  const missingKeys = new Set<string>();
  for (const candidate of candidates) {
    const { resolved, missingKeys: candidateMissingKeys } = resolveConnectionConfigTemplate(
      candidate,
      opts?.connectionConfig,
    );
    if (candidateMissingKeys.length > 0) {
      candidateMissingKeys.forEach((key) => missingKeys.add(key));
      continue;
    }

    const validate = opts?.validateResolvedUrl ?? validateUrlForSSRF;
    const check = validate(resolved);
    if (!check.safe) {
      throw new Error(check.reason ?? 'Resolved OAuth URL blocked by SSRF protection');
    }

    return resolved;
  }

  if (missingKeys.size > 0) {
    throw new Error(
      `Missing required connection configuration: ${[...missingKeys].sort().join(', ')}`,
    );
  }

  throw new Error('Unable to resolve OAuth URL template');
}

export function resolveTemplatedParams(
  params?: Record<string, ConnectionTemplateParamValue>,
  opts?: { connectionConfig?: ConnectionConfigValues },
): Record<string, string> {
  if (!params) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value !== 'string') {
        return [key, String(value)];
      }

      const { resolved, missingKeys } = resolveConnectionConfigTemplate(
        value,
        opts?.connectionConfig,
      );
      if (missingKeys.length > 0) {
        throw new Error(
          `Missing required connection configuration: ${missingKeys.sort().join(', ')}`,
        );
      }

      return [key, resolved];
    }),
  );
}
