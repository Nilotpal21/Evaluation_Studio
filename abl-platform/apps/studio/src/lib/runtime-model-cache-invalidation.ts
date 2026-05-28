import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('runtime-model-cache-invalidation');

interface RuntimeModelConfigChangedOptions {
  tenantId: string;
  authorization?: string | null;
}

export async function notifyRuntimeModelConfigChanged({
  tenantId,
  authorization,
}: RuntimeModelConfigChangedOptions): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': tenantId,
  };
  if (authorization) {
    headers.Authorization = authorization;
  }

  try {
    const response = await fetch(
      `${getRuntimeUrl()}/api/tenants/${encodeURIComponent(tenantId)}/model-resolution-cache/invalidate`,
      {
        method: 'POST',
        headers,
      },
    );

    if (!response.ok) {
      log.warn('Runtime model-resolution cache invalidation returned non-OK status', {
        tenantId,
        status: response.status,
      });
    }
  } catch (error: unknown) {
    log.warn('Failed to notify runtime model-resolution cache invalidation', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
