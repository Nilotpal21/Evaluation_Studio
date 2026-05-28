import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:kb-api-client');

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;

export function validatePathSegment(id: string, label: string): void {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: must be alphanumeric with hyphens/underscores`);
  }
}

function rewritePath(path: string): string {
  const searchAiUrl = process.env.NEXT_PUBLIC_SEARCH_AI_URL ?? '';
  const searchAiRuntimeUrl = process.env.NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL ?? '';

  if (path.startsWith('/api/search-ai-runtime/')) {
    if (searchAiRuntimeUrl) {
      return `${searchAiRuntimeUrl}/api/${path.slice('/api/search-ai-runtime/'.length)}`;
    }
    return path;
  }
  if (path.startsWith('/api/search-ai/')) {
    if (searchAiUrl) {
      return `${searchAiUrl}/api/${path.slice('/api/search-ai/'.length)}`;
    }
    return path;
  }
  return path;
}

interface KBApiClientConfig {
  authToken: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
}

interface KBApiClient {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  postFormData<T = unknown>(path: string, formData: FormData): Promise<T>;
}

const KB_API_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KB_API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`SearchAI request timed out after ${KB_API_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.error ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function createKBApiClient(config: KBApiClientConfig): KBApiClient {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.authToken}`,
    'X-Tenant-Id': config.tenantId,
  };
  if (config.projectId) {
    headers['X-Project-Id'] = config.projectId;
  }
  if (config.userId) {
    headers['X-User-Id'] = config.userId;
  }

  return {
    async get<T = unknown>(path: string): Promise<T> {
      const url = rewritePath(path);
      log.debug('KB API GET', { url });
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      return handleResponse<T>(response);
    },

    async post<T = unknown>(path: string, body?: unknown): Promise<T> {
      const url = rewritePath(path);
      log.debug('KB API POST', { url });
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return handleResponse<T>(response);
    },

    async patch<T = unknown>(path: string, body: unknown): Promise<T> {
      const url = rewritePath(path);
      log.debug('KB API PATCH', { url });
      const response = await fetchWithTimeout(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return handleResponse<T>(response);
    },

    async del<T = unknown>(path: string): Promise<T> {
      const url = rewritePath(path);
      log.debug('KB API DELETE', { url });
      const response = await fetchWithTimeout(url, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      return handleResponse<T>(response);
    },

    async postFormData<T = unknown>(path: string, formData: FormData): Promise<T> {
      const url = rewritePath(path);
      log.debug('KB API POST FormData', { url });
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          ...headers,
        },
        body: formData,
      });
      return handleResponse<T>(response);
    },
  };
}
