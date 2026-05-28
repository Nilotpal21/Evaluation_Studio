/**
 * URL Utilities
 *
 * Derives HTTP and WebSocket URLs from a single server URL.
 */

export interface DerivedUrls {
  httpUrl: string;
  wsUrl: string;
}

/**
 * Derive both HTTP and WebSocket URLs from a single server URL.
 *
 * Examples:
 *   http://localhost:3112  → { httpUrl: 'http://localhost:3112', wsUrl: 'ws://localhost:3112/ws' }
 *   https://api.example.com → { httpUrl: 'https://api.example.com', wsUrl: 'wss://api.example.com/ws' }
 *   ws://localhost:3112/ws → { httpUrl: 'http://localhost:3112', wsUrl: 'ws://localhost:3112/ws' }
 */
export function deriveUrls(serverUrl: string): DerivedUrls {
  // Strip trailing slash
  const url = serverUrl.replace(/\/+$/, '');

  // If given a ws:// or wss:// URL, derive HTTP from it
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    const httpUrl = url
      .replace(/^wss:\/\//, 'https://')
      .replace(/^ws:\/\//, 'http://')
      .replace(/\/ws$/, '');
    const wsUrl = url.endsWith('/ws') ? url : `${url}/ws`;
    return { httpUrl, wsUrl };
  }

  // Given an http:// or https:// URL, derive WS from it
  const httpUrl = url;
  const wsUrl = url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/ws';

  return { httpUrl, wsUrl };
}

/** Hostnames that are considered local (not remote) */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Returns true if the URL points to a remote server (not localhost).
 * Used to decide whether to skip the health check before connecting.
 */
export function isRemoteUrl(url: string): boolean {
  try {
    // Normalize ws/wss to http/https so URL can parse it
    const normalized = url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const parsed = new URL(normalized);
    // URL wraps IPv6 in brackets (e.g. "[::1]") — strip them for comparison
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    return !LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}
