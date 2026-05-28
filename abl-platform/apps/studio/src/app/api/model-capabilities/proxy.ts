import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('api:model-capabilities');

export async function proxyModelCapabilities(request: NextRequest, modelId: string | null) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId) {
    return NextResponse.json(
      { success: false, error: 'modelId query parameter is required' },
      { status: 400 },
    );
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    const response = await fetch(
      `${getRuntimeUrl()}/api/model-capabilities?modelId=${encodeURIComponent(normalizedModelId)}`,
      { headers },
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error: unknown) {
    log.error('Proxy GET error', {
      err: error instanceof Error ? error.message : String(error),
      modelId: normalizedModelId,
    });
    return NextResponse.json(
      { success: false, error: 'Failed to fetch model capabilities from runtime' },
      { status: 502 },
    );
  }
}
