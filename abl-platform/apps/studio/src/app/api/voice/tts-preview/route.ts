/**
 * POST /api/voice/tts-preview — Proxy to runtime TTS preview endpoint
 *
 * Authenticates via user JWT, then forwards the synthesis request to
 * the runtime. Returns the binary audio response with original headers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { getRequiredRuntimeUrl } from '@/config/runtime.server';

const log = createLogger('studio-tts-preview-proxy');

export async function POST(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  let runtimeUrl: string;
  try {
    runtimeUrl = getRequiredRuntimeUrl();
  } catch (error) {
    log.error('TTS preview proxy missing runtime configuration', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'RUNTIME_CONFIG_REQUIRED',
          message:
            error instanceof Error ? error.message : 'Runtime URL must be configured explicitly',
        },
      },
      { status: 500 },
    );
  }

  try {
    const body = await request.json();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    const response = await fetch(`${runtimeUrl}/api/v1/voice/tts-preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        success: false,
        error: { code: 'PROXY_ERROR', message: `Runtime returned ${response.status}` },
      }));
      return NextResponse.json(errorData, { status: response.status });
    }

    const audioBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') || 'audio/mpeg';
    const latencyHeader = response.headers.get('X-Synthesis-Latency-Ms');

    const responseHeaders = new Headers({
      'Content-Type': contentType,
      'Content-Length': String(audioBuffer.byteLength),
    });
    if (latencyHeader) {
      responseHeaders.set('X-Synthesis-Latency-Ms', latencyHeader);
    }

    return new NextResponse(audioBuffer, { status: 200, headers: responseHeaders });
  } catch (error) {
    log.error('TTS preview proxy error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        success: false,
        error: { code: 'PROXY_ERROR', message: 'Failed to proxy TTS preview request' },
      },
      { status: 502 },
    );
  }
}
