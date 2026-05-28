/**
 * Default configuration values per channel and provider.
 */
export const CHANNEL_TTL_DEFAULTS = {
  chat: 1800,
  email: 14400,
  voice: 0,
  messaging: 1800,
  campaign: 3600,
  default: 1800,
};

export const SMARTASSIST_DEFAULTS = {
  timeoutMs: 5000,
  initTransferPath: '/api/v1/conversations',
  eventHandlePath: '/api/v1/internal/events/handle/',
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenMax: 3,
  },
  retry: {
    maxAttempts: 2,
    backoffMs: 500,
    backoffMultiplier: 2,
  },
};

export const PROVIDER_DEFAULTS = {
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
  },
  timeoutMs: 30000,
};

export const REDIS_KEY_PREFIXES = {
  session: 'agent_transfer',
  providerIndex: 'at_by_provider',
};
