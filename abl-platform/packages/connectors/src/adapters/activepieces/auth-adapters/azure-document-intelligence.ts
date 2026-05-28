/**
 * Azure Document Intelligence Auth Adapter (LLD §3 Phase 3 Task 3.7).
 *
 * Pure data-mapping function (NOT a require.cache patch like jira-cloud /
 * servicenow). Bridges the auth profile resolver's flattened `auth` bundle
 * into the Azure DI piece's PieceAuth.CustomAuth shape.
 *
 * Input shape (produced by the auth profile resolver):
 *   { apiKey: string, connectionConfig: { endpoint, apiVersion? }, ... }
 *
 * Output shape (consumed by the Azure DI piece's `extract_document` action
 * as `ctx.auth`):
 *   { endpoint, apiKey, apiVersion }
 *
 * Model selection is per-action — `extract_document.props.model` (StaticDropdown,
 * defaults to `prebuilt-layout`). It is intentionally NOT part of the auth bundle.
 *
 * Throws ConnectorConfigError on missing required fields so DropdownOptionsService
 * + the workflow step dispatcher surface a 400 VALIDATION_ERROR rather than a
 * 502 RESOLVE_FAILED at the call site.
 */

import { ConnectorConfigError } from '../context-translator-errors.js';

const DEFAULT_API_VERSION = '2024-11-30';

export interface AzureDIAuth extends Record<string, unknown> {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
}

export function bridgeAzureDIAuth(auth: Record<string, unknown>): AzureDIAuth {
  const connectionConfig =
    (auth.connectionConfig as Record<string, unknown> | undefined) ??
    ((auth.connection as Record<string, unknown> | undefined)?.connectionConfig as
      | Record<string, unknown>
      | undefined) ??
    {};

  const endpoint =
    typeof connectionConfig.endpoint === 'string' && connectionConfig.endpoint.length > 0
      ? connectionConfig.endpoint
      : typeof auth.endpoint === 'string'
        ? auth.endpoint
        : '';
  const apiKey =
    typeof auth.apiKey === 'string'
      ? auth.apiKey
      : typeof auth.access_token === 'string'
        ? auth.access_token
        : '';
  const apiVersion =
    typeof connectionConfig.apiVersion === 'string' && connectionConfig.apiVersion.length > 0
      ? connectionConfig.apiVersion
      : typeof auth.apiVersion === 'string' && auth.apiVersion.length > 0
        ? auth.apiVersion
        : DEFAULT_API_VERSION;

  if (!endpoint) {
    throw new ConnectorConfigError(
      'Azure Document Intelligence requires connectionConfig.endpoint (e.g. https://<resource>.cognitiveservices.azure.com) — set this during auth profile creation',
    );
  }
  if (!apiKey) {
    throw new ConnectorConfigError(
      'Azure Document Intelligence requires apiKey in auth credentials',
    );
  }

  return { endpoint, apiKey, apiVersion };
}
