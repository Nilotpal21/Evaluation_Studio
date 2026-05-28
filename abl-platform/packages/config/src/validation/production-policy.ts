/**
 * Production operational policy enforcement.
 * Validates that production environment defaults stay within safe operational boundaries.
 * These checks prevent accidental debug logging, excessive trace sampling, etc. in production.
 */

export interface PolicyIssue {
  level: 'error' | 'warning';
  field: string;
  message: string;
  actual: unknown;
  allowed: unknown;
}

export interface ProductionPolicyConfig {
  observability?: {
    loggingLevel?: string;
    traceSamplingRate?: number;
    enabled?: boolean;
  };
  features?: {
    debugTracesEnabled?: boolean;
  };
  env?: string;
}

const ALLOWED_PROD_LOG_LEVELS = ['warn', 'error', 'fatal'];
const MAX_PROD_TRACE_SAMPLING_RATE = 0.2;

/**
 * Enforce operational boundaries on production config defaults.
 * Call this in CI when validating production.json.
 */
export function validateProductionPolicy(config: ProductionPolicyConfig): PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  // Only enforce for production
  if (config.env && config.env !== 'production') return issues;

  // Log level
  const logLevel = config.observability?.loggingLevel;
  if (logLevel && !ALLOWED_PROD_LOG_LEVELS.includes(logLevel)) {
    issues.push({
      level: 'error',
      field: 'observability.loggingLevel',
      message: `Production log level must be one of [${ALLOWED_PROD_LOG_LEVELS.join(', ')}], got "${logLevel}". Debug/info logging in production causes performance issues and cost increases.`,
      actual: logLevel,
      allowed: ALLOWED_PROD_LOG_LEVELS,
    });
  }

  // Trace sampling rate
  const samplingRate = config.observability?.traceSamplingRate;
  if (samplingRate !== undefined && samplingRate > MAX_PROD_TRACE_SAMPLING_RATE) {
    issues.push({
      level: 'error',
      field: 'observability.traceSamplingRate',
      message: `Production trace sampling rate must be <= ${MAX_PROD_TRACE_SAMPLING_RATE}, got ${samplingRate}. High sampling rates cause excessive trace storage costs.`,
      actual: samplingRate,
      allowed: `<= ${MAX_PROD_TRACE_SAMPLING_RATE}`,
    });
  }

  // Debug traces
  if (config.features?.debugTracesEnabled === true) {
    issues.push({
      level: 'error',
      field: 'features.debugTracesEnabled',
      message:
        'Debug traces must be disabled in production. They expose internal execution details.',
      actual: true,
      allowed: false,
    });
  }

  return issues;
}
