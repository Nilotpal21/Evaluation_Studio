/**
 * useConnectorTemplates Hook
 *
 * SWR hook for available connector configuration templates.
 */

import { useMemo } from 'react';
import useSWR from 'swr';

export interface ConnectorTemplate {
  templateId: string;
  name: string;
  description?: string;
  permissionMode: 'enabled' | 'disabled';
  createdAt: string;
  usageCount?: number;
}

interface TemplateListResponse {
  data: {
    templates: Array<{
      _id: string;
      name: string;
      description: string;
      permissionMode: 'enabled' | 'disabled';
      createdAt: string;
      usageCount: number;
    }>;
    total: number;
  };
}

export function useConnectorTemplates(indexId: string): {
  templates: ConnectorTemplate[];
  isLoading: boolean;
  error: string | null;
} {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/connector-templates` : null;

  const { data, error, isLoading } = useSWR<TemplateListResponse>(key);

  const templates: ConnectorTemplate[] = useMemo(
    () =>
      (data?.data?.templates ?? []).map((t) => ({
        templateId: t._id,
        name: t.name,
        description: t.description || undefined,
        permissionMode: t.permissionMode,
        createdAt: t.createdAt,
        usageCount: t.usageCount,
      })),
    [data],
  );

  return {
    templates,
    isLoading,
    error: error ? String(error) : null,
  };
}
