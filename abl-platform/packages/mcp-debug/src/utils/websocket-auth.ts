export const WEB_DEBUG_WS_AUTH_PROTOCOL = 'web-debug-auth';

/**
 * Internal Studio/runtime WebSocket auth is carried in the WebSocket
 * subprotocol header as:
 *
 * Sec-WebSocket-Protocol: web-debug-auth,<access_token>
 */
export function buildWebDebugWSProtocols(accessToken: string): string[] {
  return [WEB_DEBUG_WS_AUTH_PROTOCOL, accessToken];
}
