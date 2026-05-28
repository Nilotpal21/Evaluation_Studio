/**
 * Realtime Voice Provider Registry
 *
 * Registration and factory for realtime voice LLM providers.
 * Mirrors the pattern in ../provider.ts for standard LLM providers.
 */

import type { RealtimeProviderType, RealtimeVoiceSession } from './types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('realtime-provider');

// =============================================================================
// REGISTRY
// =============================================================================

type RealtimeProviderFactory = () => RealtimeVoiceSession;

const realtimeFactories: Map<RealtimeProviderType, RealtimeProviderFactory> = new Map();

export function registerRealtimeProvider(
  type: RealtimeProviderType,
  factory: RealtimeProviderFactory,
): void {
  realtimeFactories.set(type, factory);
  log.debug('Registered realtime provider', { type });
}

export function getRealtimeProviderFactory(
  type: RealtimeProviderType,
): RealtimeProviderFactory | undefined {
  return realtimeFactories.get(type);
}

export function createRealtimeSession(type: RealtimeProviderType): RealtimeVoiceSession {
  const factory = realtimeFactories.get(type);
  if (!factory) {
    throw new Error(
      `Unknown realtime provider: ${type}. ` +
        `Available providers: ${Array.from(realtimeFactories.keys()).join(', ')}`,
    );
  }
  return factory();
}

export function getRegisteredRealtimeProviders(): RealtimeProviderType[] {
  return Array.from(realtimeFactories.keys());
}
