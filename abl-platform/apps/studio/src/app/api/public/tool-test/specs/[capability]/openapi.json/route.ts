import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { ErrorCode, errorJson } from '@/lib/api-response';
import { getClientIp } from '@/lib/get-client-ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveToolTestOpenApi } from '@/lib/tool-test-endpoint-service';

const log = createLogger('public-tool-test-openapi-route');

const PUBLIC_TOOL_SPEC_RATE_LIMIT_MAX = 30;
const PUBLIC_TOOL_SPEC_RATE_LIMIT_WINDOW_MS = 60_000;

export const dynamic = 'force-dynamic';

function buildRateLimitedResponse(retryAfter: number | undefined): NextResponse {
  const response = errorJson(
    'Too many requests. Please try again later.',
    429,
    ErrorCode.RATE_LIMITED,
  );
  response.headers.set('Retry-After', String(retryAfter ?? 0));
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ capability: string }> },
): Promise<NextResponse> {
  const rateLimit = await checkRateLimit(
    `public-tool-test-spec:${getClientIp(request)}`,
    PUBLIC_TOOL_SPEC_RATE_LIMIT_MAX,
    PUBLIC_TOOL_SPEC_RATE_LIMIT_WINDOW_MS,
  );

  if (!rateLimit.allowed) {
    return buildRateLimitedResponse(rateLimit.retryAfter);
  }

  const { capability } = await context.params;

  try {
    const document = await resolveToolTestOpenApi(capability);
    if (!document) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json(document, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    log.error('Public tool test OpenAPI generation failed', {
      capability,
      err: error instanceof Error ? error.message : String(error),
    });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
