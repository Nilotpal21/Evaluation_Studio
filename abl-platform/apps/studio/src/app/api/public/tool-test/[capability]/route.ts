import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { ErrorCode, errorJson } from '@/lib/api-response';
import { getClientIp } from '@/lib/get-client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  ToolTestEndpointInputError,
  resolveToolTestInvoke,
} from '@/lib/tool-test-endpoint-service';

const log = createLogger('public-tool-test-invoke-route');

const PUBLIC_TOOL_TEST_RATE_LIMIT_MAX = 30;
const PUBLIC_TOOL_TEST_RATE_LIMIT_WINDOW_MS = 60_000;

export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRateLimitedResponse(retryAfter: number | undefined): NextResponse {
  const response = errorJson(
    'Too many requests. Please try again later.',
    429,
    ErrorCode.RATE_LIMITED,
  );
  response.headers.set('Retry-After', String(retryAfter ?? 0));
  return response;
}

async function readInputBody(request: NextRequest): Promise<Record<string, unknown>> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ToolTestEndpointInputError(['Request body must be valid JSON']);
  }

  if (!isRecord(parsed)) {
    throw new ToolTestEndpointInputError(['Request body must be a JSON object']);
  }

  return parsed;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ capability: string }> },
): Promise<NextResponse> {
  const rateLimit = await checkRateLimit(
    `public-tool-test:${getClientIp(request)}`,
    PUBLIC_TOOL_TEST_RATE_LIMIT_MAX,
    PUBLIC_TOOL_TEST_RATE_LIMIT_WINDOW_MS,
  );

  if (!rateLimit.allowed) {
    return buildRateLimitedResponse(rateLimit.retryAfter);
  }

  const { capability } = await context.params;

  try {
    const input = await readInputBody(request);
    const resolved = await resolveToolTestInvoke({ capability, input });

    if (!resolved) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json(resolved.body, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ToolTestEndpointInputError) {
      return errorJson(error.messages, 400, ErrorCode.VALIDATION_ERROR);
    }

    log.error('Public tool test invoke failed', {
      capability,
      err: error instanceof Error ? error.message : String(error),
    });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
