import { describe, expect, it } from 'vitest';
import {
  SDK_WS_AUTH_PROTOCOL,
  SDK_WS_TICKET_PROTOCOL,
  buildSdkWSProtocols,
  buildSdkWSTicketProtocols,
  extractSdkTicketFromProtocolHeader,
  extractSdkTokenFromProtocolHeader,
  WEB_DEBUG_WS_AUTH_PROTOCOL,
  buildWebDebugWSProtocols,
  extractWebDebugTokenFromProtocolHeader,
} from '../websocket-auth.js';

describe('websocket-auth', () => {
  it('builds the internal web debug subprotocol list', () => {
    expect(buildWebDebugWSProtocols('token-123')).toEqual([
      WEB_DEBUG_WS_AUTH_PROTOCOL,
      'token-123',
    ]);
  });

  it('builds the SDK subprotocol list', () => {
    expect(buildSdkWSProtocols('sdk-token-123')).toEqual([SDK_WS_AUTH_PROTOCOL, 'sdk-token-123']);
  });

  it('builds the SDK ticket subprotocol list', () => {
    expect(buildSdkWSTicketProtocols('ticket-123')).toEqual([SDK_WS_TICKET_PROTOCOL, 'ticket-123']);
  });

  it('extracts the internal web debug token from the protocol header', () => {
    expect(
      extractWebDebugTokenFromProtocolHeader({
        'sec-websocket-protocol': `${WEB_DEBUG_WS_AUTH_PROTOCOL}, token-123`,
      }),
    ).toBe('token-123');
  });

  it('rejects protocol headers missing the auth protocol prefix', () => {
    expect(
      extractWebDebugTokenFromProtocolHeader({ 'sec-websocket-protocol': 'token-123' }),
    ).toBeNull();
  });

  it('extracts the SDK token from the protocol header', () => {
    expect(
      extractSdkTokenFromProtocolHeader({
        'sec-websocket-protocol': `${SDK_WS_AUTH_PROTOCOL}, sdk-token-123`,
      }),
    ).toBe('sdk-token-123');
  });

  it('rejects SDK protocol headers missing the auth protocol prefix', () => {
    expect(extractSdkTokenFromProtocolHeader({ 'sec-websocket-protocol': 'sdk-token-123' })).toBe(
      null,
    );
  });

  it('extracts the SDK ticket from the protocol header', () => {
    expect(
      extractSdkTicketFromProtocolHeader({
        'sec-websocket-protocol': `${SDK_WS_TICKET_PROTOCOL}, ticket-123`,
      }),
    ).toBe('ticket-123');
  });
});
