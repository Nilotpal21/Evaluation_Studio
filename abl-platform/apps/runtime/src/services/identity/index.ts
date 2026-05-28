/**
 * Session Identity Module
 *
 * Re-exports artifact hashing, HMAC verification, CallerContext building,
 * and session resolution logic.
 */

export {
  hashArtifact,
  verifyHMAC,
  buildCallerContext,
  buildCallerContextFromTenantContext,
  HMAC_MAX_AGE_SECONDS,
  DEFAULT_RESUME_WINDOW_SECONDS,
  type HMACVerifyInput,
  type HMACVerifyResult,
  type CallerContextInput,
} from './artifact-hasher.js';

export {
  resolveSession,
  registerResolutionKey,
  type SessionResolutionOutcome,
  type SessionResolutionResult,
  type ResolveSessionInput,
} from './session-resolver.js';

export {
  resolveSdkTokenEnvelopePolicy,
  type RuntimeSdkJweCapability,
  type RuntimeSdkJweCapabilityBlockReason,
  type SDKTokenEnvelopeBootstrapType,
  type SDKTokenEnvelopeChannelAuthMode,
  type SDKTokenEnvelopeConfiguredPolicyMode,
  type SDKTokenEnvelopeMode,
  type SDKTokenEnvelopePolicy,
  type SDKTokenEnvelopePolicyInput,
  type SDKTokenEnvelopePolicyReason,
  type SDKTokenEnvelopeResolvedPolicyMode,
} from './sdk-token-envelope-policy.js';

export {
  createDisabledSdkJweKeyProvider,
  createStaticSdkJweKeyProvider,
  type RuntimeSdkJweKeyInput,
  type RuntimeSdkJweKeyProvider,
  type RuntimeSdkJweKeyStatus,
  type RuntimeSdkJweSafeKeyMetadata,
  type RuntimeSdkJweSafetyGates,
} from './sdk-jwe-keyring.js';

export {
  verifyRuntimeSdkBootstrapToken,
  verifyRuntimeSdkSessionToken,
  wrapRuntimeSdkBootstrapToken,
  wrapRuntimeSdkSessionToken,
  type RuntimeEnvelopeResult,
  type RuntimeSdkTokenEnvelopeDeps,
} from './sdk-token-envelope-runtime.js';

export {
  getRuntimeSdkJweKeyProvider,
  getRuntimeSdkTokenEnvelopeDeps,
} from './sdk-jwe-runtime-config.js';

export { resolveRuntimeSdkTokenEnvelopePolicy } from './sdk-token-envelope-runtime-policy.js';
export {
  verifyRuntimeSdkSessionForAuth,
  type RuntimeSdkSessionAuthResult,
} from './sdk-session-token-auth.js';
