import type { ExtendedTraceEvent } from '../types';

export interface ConfigurationTraceDiagnostic {
  category: string;
  severity: 'warning' | 'error';
  code: string;
  message: string;
  bannerEligible: boolean;
}

export function getConfigurationTraceDiagnostic(
  event: ExtendedTraceEvent,
): ConfigurationTraceDiagnostic | undefined {
  const diagnostic = event.data?.diagnostic;

  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    return undefined;
  }

  const diagnosticRecord = diagnostic as Record<string, unknown>;
  const category = diagnosticRecord.category;
  const severity = diagnosticRecord.severity;
  const code = diagnosticRecord.code;
  const message = diagnosticRecord.message;
  const bannerEligible = diagnosticRecord.bannerEligible;

  if (
    typeof category !== 'string' ||
    (severity !== 'warning' && severity !== 'error') ||
    typeof code !== 'string' ||
    typeof message !== 'string' ||
    typeof bannerEligible !== 'boolean'
  ) {
    return undefined;
  }

  return {
    category,
    severity,
    code,
    message,
    bannerEligible,
  };
}

/**
 * Banner-eligible runtime configuration diagnostics are derived from the
 * original runtime trace event instead of being projected into a second
 * Observatory event. That keeps the trace timeline faithful while still
 * letting Studio banner/error surfaces reuse the structured diagnostic.
 */
export function getBannerEligibleConfigurationDiagnostic(
  event: ExtendedTraceEvent,
): ConfigurationTraceDiagnostic | undefined {
  const diagnostic = getConfigurationTraceDiagnostic(event);
  return diagnostic?.bannerEligible ? diagnostic : undefined;
}
