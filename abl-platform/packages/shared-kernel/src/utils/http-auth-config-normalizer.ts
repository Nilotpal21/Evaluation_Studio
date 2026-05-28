import type { HttpAuthConfig, HttpAuthType } from '../types/project-tool-form.js';

export type HttpAuthConfigInput = Partial<Omit<HttpAuthConfig, 'customHeaders'>> & {
  customHeaders?: HttpAuthConfig['customHeaders'] | string | null;
};

export interface NormalizeHttpAuthConfigOptions {
  authProfileRef?: string | null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readCustomHeaders(value: unknown): Record<string, string> | undefined {
  if (!value) return undefined;

  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return readCustomHeaders(parsed);
    } catch {
      return undefined;
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) return undefined;

  const entries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
    key,
    String(entryValue),
  ]);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeHttpAuthConfig(
  auth: HttpAuthType | undefined,
  authConfig: HttpAuthConfigInput | null | undefined,
  options: NormalizeHttpAuthConfigOptions = {},
): HttpAuthConfig | undefined {
  if (!authConfig) return undefined;

  const authType = auth ?? 'none';
  const normalized: HttpAuthConfig = {};
  // When a profile is set, the profile provides secrets at runtime — don't persist inline literals.
  const hasAuthProfileRef = (options.authProfileRef?.trim().length ?? 0) > 0;
  const scopes = readString(authConfig.scopes);

  if (hasAuthProfileRef && scopes) {
    normalized.scopes = scopes;
  }

  switch (authType) {
    case 'api_key': {
      const headerName = readString(authConfig.headerName);
      if (headerName) normalized.headerName = headerName;
      if (!hasAuthProfileRef) {
        const apiKey = readString(authConfig.apiKey);
        if (apiKey) normalized.apiKey = apiKey;
      }
      break;
    }
    case 'bearer': {
      const token = readString(authConfig.token);
      if (!hasAuthProfileRef && token) normalized.token = token;
      break;
    }
    case 'oauth2_client': {
      const clientId = readString(authConfig.clientId);
      const clientSecret = readString(authConfig.clientSecret);
      const tokenUrl = readString(authConfig.tokenUrl);
      if (clientId) normalized.clientId = clientId;
      if (clientSecret) normalized.clientSecret = clientSecret;
      if (tokenUrl) normalized.tokenUrl = tokenUrl;
      if (scopes) normalized.scopes = scopes;
      break;
    }
    case 'oauth2_user': {
      const provider = readString(authConfig.provider);
      const clientId = readString(authConfig.clientId);
      const clientSecret = readString(authConfig.clientSecret);
      const tokenUrl = readString(authConfig.tokenUrl);
      if (provider) normalized.provider = provider;
      if (clientId) normalized.clientId = clientId;
      if (clientSecret) normalized.clientSecret = clientSecret;
      if (tokenUrl) normalized.tokenUrl = tokenUrl;
      if (scopes) normalized.scopes = scopes;
      break;
    }
    case 'custom': {
      const customHeaders = readCustomHeaders(authConfig.customHeaders);
      if (customHeaders) normalized.customHeaders = customHeaders;
      break;
    }
    case 'none':
      break;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
