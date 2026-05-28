/**
 * Security utilities
 *
 * @deprecated Import from @agent-platform/shared-kernel/security instead.
 * This re-export will be removed once all consumers migrate.
 */

export {
  validateUrlForSSRF,
  assertUrlSafeForSSRF,
  getDevSSRFOptions,
  isPrivateIP,
  isMetadataEndpoint,
  isLocalhost,
  decimalToIp,
  decodeOctalIp,
  type SSRFValidationOptions,
  type SSRFValidationResult,
} from '@agent-platform/shared-kernel/security';
