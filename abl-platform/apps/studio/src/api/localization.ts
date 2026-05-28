import { apiFetch, handleResponse } from '@/lib/api-client';

export interface LocalizationAsset {
  id: string;
  key: string;
  value: string;
  description: string | null;
  relativePath: string;
  filePath: string;
  localeCode: string;
  fileName: string;
  assetName: string;
  scope: 'shared' | 'agent';
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LocalizationAssetsResponse {
  success: boolean;
  assets: LocalizationAsset[];
  locales: string[];
  summary: {
    totalAssets: number;
    totalLocales: number;
  };
}

function projectUrl(projectId: string, path: string) {
  return `/api/projects/${projectId}${path}`;
}

export async function fetchLocalizationAssets(
  projectId: string,
): Promise<LocalizationAssetsResponse> {
  const response = await apiFetch(projectUrl(projectId, '/localization'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createLocalizationAsset(
  projectId: string,
  data: {
    relativePath: string;
    value: string;
    description?: string | null;
  },
): Promise<{ success: boolean; asset: LocalizationAsset }> {
  const response = await apiFetch(projectUrl(projectId, '/localization'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateLocalizationAsset(
  projectId: string,
  assetId: string,
  data: {
    relativePath?: string;
    value?: string;
    description?: string | null;
  },
): Promise<{ success: boolean; asset: LocalizationAsset }> {
  const response = await apiFetch(projectUrl(projectId, `/localization/${assetId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteLocalizationAsset(
  projectId: string,
  assetId: string,
): Promise<{ success: boolean; deleted: string }> {
  const response = await apiFetch(projectUrl(projectId, `/localization/${assetId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}
