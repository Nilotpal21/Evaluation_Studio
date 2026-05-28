import { NextResponse } from 'next/server';
import { ErrorCode } from '@/lib/api-response';
import { checkRateLimit } from '@/lib/rate-limit';
import type { ArchAuditScope } from '@/lib/arch-audit-scope';

const ARCH_AUDIT_RATE_LIMIT_MAX_ATTEMPTS = 60;
const ARCH_AUDIT_RATE_LIMIT_WINDOW_MS = 60_000;

export async function enforceArchAuditRateLimit(
  scope: ArchAuditScope,
  operation: string,
): Promise<NextResponse | null> {
  const result = await checkRateLimit(
    `arch-audit:${scope.tenantId}:${scope.userId}:${operation}`,
    ARCH_AUDIT_RATE_LIMIT_MAX_ATTEMPTS,
    ARCH_AUDIT_RATE_LIMIT_WINDOW_MS,
  );

  if (result.allowed) {
    return null;
  }

  return NextResponse.json(
    {
      success: false,
      errors: [
        {
          msg: 'Too many audit log requests. Please try again later.',
          code: ErrorCode.RATE_LIMITED,
        },
      ],
    },
    {
      status: 429,
      headers: { 'Retry-After': String(result.retryAfter ?? 60) },
    },
  );
}
