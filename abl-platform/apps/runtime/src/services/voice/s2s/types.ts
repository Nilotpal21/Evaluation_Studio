import type { S2SProviderType } from '@agent-platform/config/constants/voice-providers';

export type { S2SProviderType } from '@agent-platform/config/constants/voice-providers';

/**
 * S2S Types (Minimal stubs - actual S2S is handled by Jambonz llm verb)
 *
 * These types are kept for backwards compatibility with existing code
 * that references them, but the actual S2S integration is done via
 * Jambonz's native llm verb support, not through these providers.
 */

export interface S2SCredentials {
  apiKey: string;
  [key: string]: unknown;
}

export interface S2SSessionConfig {
  provider?: S2SProviderType;
  sessionId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

export interface IS2SProvider {
  // Stub - not used with Jambonz llm verb
}

export interface S2SSessionBridgeConfig {
  // Stub - not used with Jambonz llm verb
  [key: string]: unknown;
}
