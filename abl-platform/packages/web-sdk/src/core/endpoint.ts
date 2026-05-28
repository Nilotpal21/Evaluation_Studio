/**
 * Shared endpoint normalization helpers for browser SDK HTTP and WebSocket calls.
 */

const MISSING_ENDPOINT_ERROR =
  'SDK config endpoint is required (for example: https://runtime.example.com).';
const INVALID_ENDPOINT_PROTOCOL_ERROR =
  'SDK config endpoint must start with http://, https://, ws://, or wss://.';

function requireEndpoint(endpoint?: string): string {
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0) {
    throw new Error(MISSING_ENDPOINT_ERROR);
  }

  return endpoint.trim().replace(/\/+$/, '');
}

export function normalizeHttpEndpoint(endpoint?: string): string {
  const candidate = requireEndpoint(endpoint);
  const hasValidProtocol = /^(https?|wss?):\/\//i.test(candidate);

  if (!hasValidProtocol) {
    throw new Error(INVALID_ENDPOINT_PROTOCOL_ERROR);
  }

  return candidate.replace(/^ws/i, 'http');
}

export function normalizeWebSocketEndpoint(endpoint?: string): string {
  return normalizeHttpEndpoint(endpoint).replace(/^http/i, 'ws');
}
