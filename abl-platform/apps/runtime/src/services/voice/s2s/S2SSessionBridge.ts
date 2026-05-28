/**
 * S2S Session Bridge Stub
 *
 * This is a minimal stub kept for backwards compatibility with existing type references.
 * Actual S2S integration is done via Jambonz llm verb, which handles all WebSocket
 * communication with the S2S provider (OpenAI Realtime API).
 *
 * The Jambonz llm verb approach eliminates the need for manual audio routing and
 * provider connection management that this bridge was originally designed for.
 */

import type { S2SSessionBridgeConfig } from './types.js';

export class S2SSessionBridge {
  // Stub - not used with Jambonz llm verb approach
  constructor(config: S2SSessionBridgeConfig) {
    // No-op
  }

  close(code?: number, reason?: string): void {
    // No-op
  }
}

export type { S2SSessionBridgeConfig };
