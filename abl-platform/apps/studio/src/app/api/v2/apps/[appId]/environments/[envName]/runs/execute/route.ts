/**
 * POST /api/v2/apps/:appId/environments/:envName/runs/execute
 *
 * Public proxy: forwards Kore.ai Agent Assist execute requests to runtime.
 * Supports sync JSON, SSE streaming, and async-push (202) modes.
 *
 * No Studio user-JWT auth — uses x-api-key forwarded to runtime.
 */

import { type NextRequest } from 'next/server';
import { proxyToRuntime } from '@/lib/agent-assist-proxy';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string; envName: string }> },
): Promise<Response> {
  const { appId, envName } = await params;
  const runtimePath = `/api/v2/apps/${encodeURIComponent(appId)}/environments/${encodeURIComponent(envName)}/runs/execute`;
  return proxyToRuntime(request, runtimePath, { supportsSSE: true });
}
