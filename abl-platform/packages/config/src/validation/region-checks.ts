/**
 * Region-specific configuration validation.
 *
 * Validates data residency requirements by parsing URLs and checking
 * hostnames rather than relying on string matching.
 */

import type { BaseAppConfig } from '../schemas/base-app.schema.js';
import type { ProductionWarning } from './production-checks.js';

/**
 * Known EU region identifiers found in AWS/GCP/Azure hostnames.
 */
const EU_REGION_PATTERNS = [
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'europe-west1',
  'europe-west2',
  'europe-west3',
  'europe-west4',
  'europe-north1',
  'westeurope',
  'northeurope',
  'germanywestcentral',
  'francecentral',
];

/**
 * Extract hostname from a URL string safely.
 * Returns null if the URL is invalid.
 */
function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Check whether a hostname or URL contains an EU region identifier.
 */
function isEuEndpoint(urlOrHostname: string): boolean {
  const lower = urlOrHostname.toLowerCase();
  return EU_REGION_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Validate a service URL is in the expected region for data residency.
 */
function checkEndpointResidency(
  url: string | undefined,
  fieldName: string,
  issues: ProductionWarning[],
): void {
  if (!url) return;

  const hostname = extractHostname(url);
  if (!hostname) {
    issues.push({
      level: 'warning',
      field: fieldName,
      message: `${fieldName} is not a valid URL — cannot verify data residency`,
    });
    return;
  }

  if (!isEuEndpoint(hostname)) {
    issues.push({
      level: 'warning',
      field: fieldName,
      message: `EU data residency is enabled but ${fieldName} endpoint "${hostname}" does not appear to be in an EU region`,
    });
  }
}

/**
 * Validate region-specific configuration rules.
 */
export function validateRegionConfig(config: BaseAppConfig): ProductionWarning[] {
  const issues: ProductionWarning[] = [];

  if (config.env !== 'production') return issues;

  // EU data residency checks — validate all service endpoints
  if (config.region.current === 'eu-west-1' && config.region.dataResidency) {
    // S3 bucket check
    if (config.archive.provider === 's3' && config.archive.s3.defaultBucket) {
      const bucket = config.archive.s3.defaultBucket;
      if (!isEuEndpoint(bucket)) {
        issues.push({
          level: 'warning',
          field: 'archive.s3.defaultBucket',
          message: `EU data residency is enabled but S3 bucket "${bucket}" does not indicate EU region`,
        });
      }
    }

    // Database URL check
    checkEndpointResidency(config.database.url, 'database.url', issues);

    // Redis URL check
    if (config.redis.enabled && config.redis.url) {
      checkEndpointResidency(config.redis.url, 'redis.url', issues);
    }

    // Observability OTLP endpoint check
    if (config.observability.otlpEndpoint) {
      checkEndpointResidency(
        config.observability.otlpEndpoint,
        'observability.otlpEndpoint',
        issues,
      );
    }
  }

  // Non-primary regions should have database configured
  if (!config.region.isPrimary && !config.database.url) {
    issues.push({
      level: 'error',
      field: 'database.url',
      message: 'Non-primary region must have DATABASE_URL configured (read replica)',
    });
  }

  return issues;
}
