/**
 * Auth Config Builder (AST → IR)
 *
 * Builds HTTP binding auth.config from parsed AST auth fields.
 * Builds auth.config IR from AST shape (camelCase fields from parser).
 *
 * This module is used by compileHttpBinding() in the compiler pipeline.
 */

import type { ToolAuthTypeIR } from './schema.js';

interface AuthConfigAST {
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  headerName?: string;
  apiKey?: string;
  token?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  botId?: string;
}

interface AuthConfigIR {
  headerName?: string;
  headerPrefix?: string;
  queryParam?: string;
  apiKey?: string;
  token?: string;
  oauth?: { tokenUrl: string; clientId: string; scopes: string[] };
  provider?: string;
  customHeaders?: Record<string, string>;
  searchai?: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    botId?: string;
    headerName?: string;
  };
}

/**
 * Build IR auth config from AST auth fields.
 *
 * @param authType - The resolved auth type (from AST `auth` field)
 * @param authConfig - The parsed auth_config block from AST
 * @returns IR-compatible auth config, or undefined if no config needed
 */
export function buildAuthConfigFromAST(
  authType: string | undefined,
  authConfig?: AuthConfigAST,
): AuthConfigIR | undefined {
  if (!authType || authType === 'none') return undefined;
  const cfg = authConfig || {};

  switch (authType as ToolAuthTypeIR) {
    case 'oauth2_client': {
      if (!cfg.tokenUrl) {
        throw new Error('oauth2_client auth requires a non-empty "tokenUrl" in auth_config');
      }
      if (!cfg.clientId) {
        throw new Error('oauth2_client auth requires a non-empty "clientId" in auth_config');
      }
      return {
        oauth: {
          tokenUrl: cfg.tokenUrl,
          clientId: cfg.clientId,
          scopes: cfg.scopes ? cfg.scopes.split(/[\s,]+/).filter(Boolean) : [],
        },
      };
    }
    case 'oauth2_user': {
      if (!cfg.provider) {
        throw new Error('oauth2_user auth requires a non-empty "provider" in auth_config');
      }
      return { provider: cfg.provider };
    }
    case 'api_key':
      return {
        headerName: cfg.headerName || 'X-API-Key',
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.customHeaders ? { customHeaders: cfg.customHeaders } : {}),
      };
    case 'bearer':
      return {
        headerName: cfg.headerName || 'Authorization',
        headerPrefix: 'Bearer',
        ...(cfg.token ? { token: cfg.token } : {}),
        ...(cfg.customHeaders ? { customHeaders: cfg.customHeaders } : {}),
      };
    case 'custom':
      if (!cfg.customHeaders || Object.keys(cfg.customHeaders).length === 0) {
        throw new Error('custom auth requires non-empty "customHeaders" in auth_config');
      }
      return { customHeaders: cfg.customHeaders };
    case 'searchai': {
      // SearchAI auth supports two modes:
      // 1. Full token lifecycle: tokenUrl + clientId + clientSecret (auto-refresh JWT)
      // 2. Env-backed token: no tokenUrl — reads token from env/secrets with 401 retry
      return {
        headerName: cfg.headerName || 'Auth',
        ...(cfg.tokenUrl
          ? {
              searchai: {
                tokenUrl: cfg.tokenUrl,
                clientId: cfg.clientId || '',
                clientSecret: cfg.clientSecret,
                botId: cfg.botId,
                headerName: cfg.headerName || 'Auth',
              },
            }
          : {}),
      };
    }
    default:
      return undefined;
  }
}
