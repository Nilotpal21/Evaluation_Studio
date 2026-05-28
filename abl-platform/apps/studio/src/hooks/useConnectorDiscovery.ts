/**
 * useConnectorDiscovery Hook
 *
 * SWR hook for connector discovery data (sites, file types, metadata fields).
 * Discovery endpoint is mounted at /api/search-ai/connectors/:connectorId/discovery
 * (NOT under /api/search-ai/indexes), per server.ts connector discovery router mount.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import {
  getConnectorDiscovery,
  type ConnectorDiscovery,
  type DiscoveredResource,
  type ContentProfile,
} from '../api/search-ai';

export interface DiscoverySite {
  siteId: string;
  name: string;
  activityScore: number;
  fileCount: number;
  libraryCount: number;
  sizeBytes: number;
  lastModified: string;
  recommended: boolean;
  excludeReason?: string;
}

export interface DiscoveryFileType {
  mimeType: string;
  extension: string;
  displayName: string;
  count: number;
  indexable: boolean;
}

export interface DiscoveryMetadataField {
  fieldName: string;
  type: string;
  sampleValues?: string[];
}

export interface DiscoveryData {
  sites: DiscoverySite[];
  fileTypeProfile: DiscoveryFileType[];
  metadataFields: DiscoveryMetadataField[];
}

export interface UseConnectorDiscoveryReturn {
  discovery: DiscoveryData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
}

function mapResourcesToSites(resources: DiscoveredResource[]): DiscoverySite[] {
  return resources.map((r) => ({
    siteId: r.id,
    name: r.displayName || r.name,
    activityScore: 0,
    fileCount: 0,
    libraryCount: 0,
    sizeBytes: 0,
    lastModified: '',
    recommended: false,
    ...((r.metadata ?? {}) as Partial<DiscoverySite>),
  }));
}

function mapProfilesToFileTypes(profiles: ContentProfile[]): DiscoveryFileType[] {
  // ContentProfile has fileTypeDistribution: Record<string, number>
  // Flatten all profiles' distributions into a deduplicated list
  const typeCounts = new Map<string, number>();
  for (const p of profiles) {
    if (p.fileTypeDistribution) {
      for (const [ext, count] of Object.entries(p.fileTypeDistribution)) {
        typeCounts.set(ext, (typeCounts.get(ext) ?? 0) + count);
      }
    }
  }
  return Array.from(typeCounts.entries()).map(([ext, count]) => ({
    mimeType: '',
    extension: ext,
    displayName: ext,
    count,
    indexable: true,
  }));
}

export function useConnectorDiscovery(connectorId: string | null): UseConnectorDiscoveryReturn {
  const key = connectorId ? `/api/search-ai/connectors/${connectorId}/discovery` : null;

  const fetcher = async (): Promise<ConnectorDiscovery> => {
    if (!connectorId) throw new Error('No connector ID');
    const result = await getConnectorDiscovery(connectorId);
    return result.data;
  };

  const { data, error, isLoading, mutate } = useSWR<ConnectorDiscovery>(key, fetcher);

  const discovery = useMemo((): DiscoveryData | null => {
    if (!data) return null;
    return {
      sites: mapResourcesToSites(data.resources ?? []),
      fileTypeProfile: mapProfilesToFileTypes(data.profiles ?? []),
      metadataFields: [],
    };
  }, [data]);

  return {
    discovery,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
  };
}
