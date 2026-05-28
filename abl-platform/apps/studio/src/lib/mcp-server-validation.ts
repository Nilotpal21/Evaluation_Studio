import { MCP_AUTH_TYPES, validateUrlForSSRF } from '@agent-platform/shared';
import type { McpAuthType } from '@agent-platform/shared';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

export const MAX_CUSTOM_HEADERS = 20;

interface StringRecordValidationOptions {
  maxEntriesError: string;
  objectError: string;
  valueError: (key: string) => string;
}

function validateStringRecord(
  value: unknown,
  options: StringRecordValidationOptions,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return options.objectError;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return options.maxEntriesError;
  }

  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== 'string') {
      return options.valueError(key);
    }
  }

  return null;
}

export function validateMcpHeaders(headers: unknown): string | null {
  return validateStringRecord(headers, {
    objectError: 'headers must be an object',
    maxEntriesError: `headers cannot exceed ${MAX_CUSTOM_HEADERS} entries`,
    valueError: (key) => `header values must be strings (key: ${key})`,
  });
}

export function validateMcpAuthConfig(authType: string, authConfig: unknown): string | null {
  if (!MCP_AUTH_TYPES.includes(authType as McpAuthType)) {
    return `authType must be one of: ${MCP_AUTH_TYPES.join(', ')}`;
  }
  if (authType === 'none') return null;
  if (!authConfig || typeof authConfig !== 'object') {
    return 'authConfig is required for non-none authType';
  }

  const cfg = authConfig as Record<string, unknown>;
  switch (authType) {
    case 'bearer':
      if (!cfg.token || typeof cfg.token !== 'string') {
        return 'bearer auth requires a non-empty token';
      }
      break;
    case 'api_key':
      if (!cfg.headerName || typeof cfg.headerName !== 'string') {
        return 'api_key auth requires headerName';
      }
      if (!cfg.value || typeof cfg.value !== 'string') {
        return 'api_key auth requires value';
      }
      break;
    case 'custom_headers': {
      return validateStringRecord(cfg.headers, {
        objectError: 'custom_headers auth requires a headers object',
        maxEntriesError: `custom_headers cannot exceed ${MAX_CUSTOM_HEADERS} entries`,
        valueError: (key) => `custom_headers auth header values must be strings (key: ${key})`,
      });
    }
    case 'oauth2_client_credentials':
      if (!cfg.clientId || typeof cfg.clientId !== 'string') {
        return 'oauth2 auth requires clientId';
      }
      if (!cfg.clientSecret || typeof cfg.clientSecret !== 'string') {
        return 'oauth2 auth requires clientSecret';
      }
      if (!cfg.tokenEndpoint || typeof cfg.tokenEndpoint !== 'string') {
        return 'oauth2 auth requires tokenEndpoint';
      }
      if (!String(cfg.tokenEndpoint).startsWith('https://')) {
        return 'oauth2 tokenEndpoint must use HTTPS';
      }
      {
        const ssrfResult = validateUrlForSSRF(String(cfg.tokenEndpoint), getDevSSRFOptions());
        if (!ssrfResult.safe) {
          return `tokenEndpoint blocked by SSRF protection: ${ssrfResult.reason}`;
        }
      }
      break;
  }

  return null;
}
