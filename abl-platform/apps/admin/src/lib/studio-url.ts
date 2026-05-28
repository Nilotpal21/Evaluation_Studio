const DEFAULT_STUDIO_BASE_URL = 'http://localhost:5173';

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, '');
}

export function resolveStudioApiBaseUrl(): string {
  return normalizeBaseUrl(process.env.STUDIO_API_URL) || DEFAULT_STUDIO_BASE_URL;
}

export function resolveStudioBrowserBaseUrl(): string {
  return (
    normalizeBaseUrl(process.env.FRONTEND_URL) ||
    normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL) ||
    normalizeBaseUrl(process.env.NEXT_PUBLIC_STUDIO_URL) ||
    normalizeBaseUrl(process.env.STUDIO_URL) ||
    resolveStudioApiBaseUrl()
  );
}

export function buildStudioApiUrl(pathname: string): string {
  return new URL(pathname, resolveStudioApiBaseUrl()).toString();
}

export function buildStudioBrowserUrl(pathname: string): URL {
  return new URL(pathname, resolveStudioBrowserBaseUrl());
}
