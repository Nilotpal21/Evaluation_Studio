export const SDK_WS_AUTH_PROTOCOL = 'sdk-auth';
export const SDK_WS_TICKET_PROTOCOL = 'sdk-ticket';

/**
 * Browser SDK auth is carried in the WebSocket subprotocol header as:
 *   Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>
 *
 * @deprecated Use `buildSdkWSTicketProtocols()` with a one-time ticket from
 * `/api/v1/sdk/ws-ticket`.
 */
export function buildSdkWSProtocols(sdkToken: string): string[] {
  return [SDK_WS_AUTH_PROTOCOL, sdkToken];
}

/**
 * Preferred Browser SDK auth path. The ticket is short-lived and consumed once
 * by Runtime during WebSocket connection setup.
 */
export function buildSdkWSTicketProtocols(ticket: string): string[] {
  return [SDK_WS_TICKET_PROTOCOL, ticket];
}
