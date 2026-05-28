import { apiFetch } from './api-client';

export const SDK_EMBED_FETCH_ERROR = 'Failed to load embed code';

interface SdkEmbedResponse {
  snippet?: string;
  error?: string;
}

export async function fetchSdkEmbedCode(projectId: string, channelId?: string): Promise<string> {
  const suffix = channelId ? `?channelId=${encodeURIComponent(channelId)}` : '';
  const response = await apiFetch(`/api/sdk/embed/${projectId}${suffix}`);
  const payload = (await response.json().catch(() => null)) as SdkEmbedResponse | null;

  if (!response.ok) {
    const errorMessage =
      typeof payload?.error === 'string' && payload.error.trim().length > 0
        ? payload.error
        : SDK_EMBED_FETCH_ERROR;
    throw new Error(errorMessage);
  }

  return typeof payload?.snippet === 'string' ? payload.snippet : '';
}
