/**
 * useAvailableConnectors Hook
 *
 * Fetches available connector packages for a project.
 * Uses SWR for dedup, stale-while-revalidate, and background refresh.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';

type ConnectorOAuthParamValue = string | number | boolean;

interface ConnectorOAuthConnectionConfigField {
  type: string;
  title?: string;
  description?: string;
  format?: string;
  pattern?: string;
  example?: string;
  prefix?: string;
  optional?: boolean;
  automated?: boolean;
  docSection?: string;
  enum?: string[];
  default?: string | number | boolean;
}

/** Summary of an available connector package (from the catalog, not a connection instance). */
export interface ConnectorSummary {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  authType?:
    | 'oauth2'
    | 'oauth2_client_credentials'
    | 'azure_ad'
    | 'api_key'
    | 'bearer'
    | 'basic'
    | 'custom_header'
    | 'aws_iam'
    | 'mtls'
    | 'custom'
    | 'none';
  availableAuthTypes?: string[];
  triggers?: { name: string; displayName: string; description?: string }[];
  actions?: { name: string; displayName: string; description?: string }[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    authorizationParams?: Record<string, ConnectorOAuthParamValue>;
    tokenParams?: Record<string, ConnectorOAuthParamValue>;
    connectionConfig?: Record<string, ConnectorOAuthConnectionConfigField>;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}

interface ConnectorsResponse {
  success: boolean;
  data: ConnectorSummary[];
}

interface UseAvailableConnectorsReturn {
  connectors: ConnectorSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

const HIDDEN_CONNECTION_CONNECTORS = new Set(['http', 'postgres']);

export function useAvailableConnectors(projectId: string | null): UseAvailableConnectorsReturn {
  const key = projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : null;

  const { data, error, isLoading, mutate } = useSWR<ConnectorsResponse>(key, {
    keepPreviousData: true,
  });

  const connectors = useMemo(
    () =>
      (data?.data ?? [])
        .filter((c) => (c.availableAuthTypes?.length ?? 0) > 0)
        .filter((c) => !HIDDEN_CONNECTION_CONNECTORS.has(c.name))
        .map((c) => ({
          ...c,
          // Static catalog uses `authType`; legacy dynamic API used `auth.type`
          authType: c.authType ?? (c as unknown as Record<string, { type?: string }>).auth?.type,
        })) as ConnectorSummary[],
    [data],
  );

  return {
    connectors,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => {
      void mutate();
    },
  };
}
