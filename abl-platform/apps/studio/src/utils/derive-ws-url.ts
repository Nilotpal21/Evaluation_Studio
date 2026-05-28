/**
 * Derive default WebSocket URLs when explicit browser/runtime config is absent.
 *
 * Browser clients should prefer same-origin routing over a localhost fallback.
 */

import { resolveBrowserWsUrl } from '../config/runtime.public';

/** Derive the main WebSocket URL (/ws). */
export function deriveDefaultWsUrl(configuredWsUrl?: string): string {
  return resolveBrowserWsUrl(configuredWsUrl, '/ws');
}

/** Derive the SDK WebSocket URL (/ws/sdk). */
export function deriveDefaultSdkWsUrl(configuredWsUrl?: string): string {
  return resolveBrowserWsUrl(configuredWsUrl, '/ws/sdk');
}
