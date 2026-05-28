import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, handleResponse } from '@/lib/api-client';
import { formatModelOptionLabel } from '@/lib/model-display';

export interface ProjectModel {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  isDefault: boolean;
  credentialId?: string | null;
  authProfileId?: string | null;
  tenantModelId?: string | null;
  temperature?: number;
  maxTokens?: number;
}

interface ListProjectModelsResponse {
  models?: ProjectModel[];
}

export interface TenantModelSummary {
  id: string;
  modelId?: string | null;
  provider?: string | null;
  isActive?: boolean;
  inferenceEnabled?: boolean;
  _count?: { connections?: number };
}

interface ListTenantModelsResponse {
  models?: TenantModelSummary[];
}

export interface ProjectModelOption {
  value: string;
  label: string;
  modelId: string;
  name: string;
  isDefault: boolean;
  isCredentialReady: boolean;
}

const READY_PROJECT_MODEL_STATUSES = new Set(['ready']);

function normalizeProvider(provider?: string | null) {
  return provider?.trim().toLowerCase() ?? '';
}

function hasActiveTenantConnection(model?: TenantModelSummary) {
  if (!model) return false;
  if (model.isActive === false || model.inferenceEnabled === false) return false;
  return (model._count?.connections ?? 0) > 0;
}

export function getProjectModelCredentialStatus(
  model: ProjectModel,
  tenantModels: TenantModelSummary[],
): 'ready' | 'no_credentials' | 'tenant_model_missing' {
  if (model.authProfileId || model.credentialId) {
    return 'ready';
  }

  if (model.tenantModelId) {
    const tenantModel = tenantModels.find((candidate) => candidate.id === model.tenantModelId);
    if (!tenantModel) return 'tenant_model_missing';
    return hasActiveTenantConnection(tenantModel) ? 'ready' : 'no_credentials';
  }

  const provider = normalizeProvider(model.provider);
  const modelId = model.modelId.trim();
  const providerMatches = tenantModels.filter((candidate) => {
    if (provider) {
      return normalizeProvider(candidate.provider) === provider;
    }
    return candidate.modelId === modelId;
  });

  if (providerMatches.some(hasActiveTenantConnection)) {
    return 'ready';
  }

  return 'no_credentials';
}

export function buildProjectModelOptions(
  models: ProjectModel[],
  tenantModels: TenantModelSummary[],
  canEvaluateCredentials = true,
) {
  return [...models]
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .map((model) => {
      const credentialStatus = getProjectModelCredentialStatus(model, tenantModels);
      return {
        value: model.modelId,
        label: formatModelOptionLabel(model),
        modelId: model.modelId,
        name: model.name,
        isDefault: model.isDefault,
        isCredentialReady:
          !canEvaluateCredentials || READY_PROJECT_MODEL_STATUSES.has(credentialStatus),
      };
    });
}

export function useProjectModelOptions(projectId?: string | null) {
  const [models, setModels] = useState<ProjectModel[]>([]);
  const [tenantModels, setTenantModels] = useState<TenantModelSummary[]>([]);
  const [canEvaluateCredentials, setCanEvaluateCredentials] = useState(true);
  const [isLoading, setIsLoading] = useState(Boolean(projectId));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setModels([]);
      setTenantModels([]);
      setCanEvaluateCredentials(true);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await apiFetch(`/api/models?projectId=${encodeURIComponent(projectId)}`);
      const data = await handleResponse<ListProjectModelsResponse>(response);
      let tenantModelsData: ListTenantModelsResponse = {};
      let credentialError: string | null = null;

      try {
        const tenantModelsResponse = await apiFetch('/api/tenant-models?isActive=true&limit=100');
        tenantModelsData = await handleResponse<ListTenantModelsResponse>(tenantModelsResponse);
      } catch (err) {
        credentialError =
          err instanceof Error ? err.message : 'Failed to load model credential readiness';
      }

      setModels(Array.isArray(data.models) ? data.models : []);
      setTenantModels(Array.isArray(tenantModelsData.models) ? tenantModelsData.models : []);
      setCanEvaluateCredentials(!credentialError);
      setError(credentialError);
    } catch (err) {
      setModels([]);
      setTenantModels([]);
      setCanEvaluateCredentials(true);
      setError(err instanceof Error ? err.message : 'Failed to load project models');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allOptions = useMemo<ProjectModelOption[]>(() => {
    return buildProjectModelOptions(models, tenantModels, canEvaluateCredentials);
  }, [canEvaluateCredentials, models, tenantModels]);

  const options = useMemo(() => {
    return allOptions.filter((option) => option.isCredentialReady);
  }, [allOptions]);

  const unavailableOptions = useMemo(() => {
    return allOptions.filter((option) => !option.isCredentialReady);
  }, [allOptions]);

  return { models, options, allOptions, unavailableOptions, isLoading, error, reload: load };
}
