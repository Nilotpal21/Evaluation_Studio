import { createLogger } from '@abl/compiler/platform';
import type { TransferPayload, TransferResult } from '../types.js';

const log = createLogger('fallback-executor');

export interface FallbackAdapter {
  execute(payload: TransferPayload): Promise<TransferResult>;
}

interface FallbackMetrics {
  primaryAttempts: number;
  fallbackAttempts: number;
  primaryFailures: number;
  fallbackFailures: number;
}

let metrics: FallbackMetrics = {
  primaryAttempts: 0,
  fallbackAttempts: 0,
  primaryFailures: 0,
  fallbackFailures: 0,
};

export async function executeWithFallback(
  primary: FallbackAdapter,
  fallback: FallbackAdapter | undefined,
  payload: TransferPayload,
): Promise<TransferResult> {
  metrics.primaryAttempts++;
  const primaryResult = await primary.execute(payload);
  if (primaryResult.success) return primaryResult;

  metrics.primaryFailures++;
  if (!fallback) return primaryResult;

  log.warn('Primary adapter failed, falling back', {
    tenantId: payload.tenantId,
    status: primaryResult.status,
    error: primaryResult.error?.code,
  });

  metrics.fallbackAttempts++;
  const fallbackResult = await fallback.execute(payload);
  if (!fallbackResult.success) {
    metrics.fallbackFailures++;
  }
  return fallbackResult;
}

export function getFallbackMetrics(): Readonly<FallbackMetrics> {
  return { ...metrics };
}

export function resetFallbackMetrics(): void {
  metrics = {
    primaryAttempts: 0,
    fallbackAttempts: 0,
    primaryFailures: 0,
    fallbackFailures: 0,
  };
}
