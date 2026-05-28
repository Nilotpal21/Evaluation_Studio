/**
 * POST /api/v2/apps/:appId/environments/:envName/sessions/terminate
 *
 * Public proxy: forwards Kore.ai Agent Assist session-terminate requests to runtime.
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
  const runtimePath = `/api/v2/apps/${encodeURIComponent(appId)}/environments/${encodeURIComponent(envName)}/sessions/terminate`;
  return proxyToRuntime(request, runtimePath);
}
