/**
 * Security utilities
 */

// Unified SSRF validator — canonical implementation for all outbound HTTP
export {
  validateUrlForSSRF,
  validateHostnameForSSRF,
  assertUrlSafeForSSRF,
  getDevSSRFOptions,
  isPrivateIP,
  isMetadataEndpoint,
  isLocalhost,
  decimalToIp,
  decodeOctalIp,
  decodeHexIp,
  decodeIpv4AddressLiteral,
  type SSRFValidationOptions,
  type SSRFValidationResult,
} from './ssrf-validator.js';

// DNS-pinning outbound fetch lives at the dedicated subpath
// `@agent-platform/shared-kernel/security/safe-fetch` because it imports
// `node:dns/promises`, `node:http`, and `node:https` at module top level —
// pulling those into client bundles (Studio, web-sdk) breaks Turbopack
// codegen. Server-side callers must import directly from that subpath.

// Inbound internal-network guards
export {
  extractTrustedClientIp,
  normalizeHostHeader,
  isInternalNetworkAddress,
  isInternalNetworkRequest,
  type InternalNetworkRequestMetadata,
  type InternalNetworkRequestOptions,
} from './internal-network.js';

// IPv4 CIDR matching
export {
  ipv4ToNumber,
  parseIpv4Cidr,
  ipMatchesCidrEntry,
  ipMatchesAnyCidr,
  type ParsedCidr,
} from './cidr.js';

// Inbound channel authentication
export {
  QUERY_TOKEN_TRANSPORT_ALLOWLIST,
  extractIngressToken,
  tokensMatch,
  type ExtractIngressTokenOptions,
  type QueryTokenTransport,
} from './inbound-auth.js';

// Outbound webhook signing
export {
  generateWebhookSecret,
  computeWebhookSignature,
  buildSignatureHeaders,
  verifyWebhookSignature,
} from './webhook-signature.js';
