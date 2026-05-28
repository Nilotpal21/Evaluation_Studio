import type { IncomingHttpHeaders } from 'http';

export const WEB_DEBUG_WS_AUTH_PROTOCOL = 'web-debug-auth';
export const SDK_WS_AUTH_PROTOCOL = 'sdk-auth';
export const SDK_WS_TICKET_PROTOCOL = 'sdk-ticket';

function parseProtocolHeader(protocolHeader: string | string[] | undefined): string[] {
  const protocolValue = Array.isArray(protocolHeader) ? protocolHeader.join(',') : protocolHeader;

  if (typeof protocolValue !== 'string' || protocolValue.trim().length === 0) {
    return [];
  }

  return protocolValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Internal Studio/runtime WebSocket auth is carried in the WebSocket subprotocol header as:
 *   Sec-WebSocket-Protocol: web-debug-auth,<access_token>
 */
export function buildWebDebugWSProtocols(accessToken: string): string[] {
  return [WEB_DEBUG_WS_AUTH_PROTOCOL, accessToken];
}

export function extractWebDebugTokenFromProtocolHeader(
  headers: IncomingHttpHeaders,
): string | null {
  return extractAuthTokenFromProtocolHeader(headers, WEB_DEBUG_WS_AUTH_PROTOCOL);
}

/**
 * Browser SDK auth is carried in the WebSocket subprotocol header as:
 *   Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>
 *
 * @deprecated Use `buildSdkWSTicketProtocols()` with a short-lived ticket from
 * `/api/v1/sdk/ws-ticket`. This legacy path carries the reusable SDK session
 * token during the WebSocket handshake and is kept only for published SDK
 * compatibility.
 */
export function buildSdkWSProtocols(sdkToken: string): string[] {
  return [SDK_WS_AUTH_PROTOCOL, sdkToken];
}

export function extractSdkTokenFromProtocolHeader(headers: IncomingHttpHeaders): string | null {
  return extractAuthTokenFromProtocolHeader(headers, SDK_WS_AUTH_PROTOCOL);
}

/**
 * Preferred Browser SDK WebSocket auth path. The ticket is a short-lived,
 * one-time credential minted from an SDK session token immediately before
 * connecting.
 */
export function buildSdkWSTicketProtocols(ticket: string): string[] {
  return [SDK_WS_TICKET_PROTOCOL, ticket];
}

export function extractSdkTicketFromProtocolHeader(headers: IncomingHttpHeaders): string | null {
  return extractAuthTokenFromProtocolHeader(headers, SDK_WS_TICKET_PROTOCOL);
}

function extractAuthTokenFromProtocolHeader(
  headers: IncomingHttpHeaders,
  authProtocol: string,
): string | null {
  const protocols = parseProtocolHeader(headers['sec-websocket-protocol']);

  if (protocols[0] !== authProtocol || !protocols[1]) {
    return null;
  }

  return protocols[1];
}
