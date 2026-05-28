import { describe, expect, it } from 'vitest';
import { PREVIEW_WS_READY_STATE, shouldReconnectPreviewWebSocket } from '../lib/preview-reconnect';

describe('shouldReconnectPreviewWebSocket', () => {
  it('reconnects only previously opened sessions with closed or closing sockets', () => {
    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.CLOSED,
      }),
    ).toBe(true);

    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.CLOSING,
      }),
    ).toBe(true);

    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.OPEN,
      }),
    ).toBe(false);

    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.CONNECTING,
      }),
    ).toBe(false);
  });

  it('does not reconnect before the first open, after terminal sessions, or non-recoverable errors', () => {
    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: false,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.CLOSED,
      }),
    ).toBe(false);

    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: true,
        readyState: PREVIEW_WS_READY_STATE.CLOSED,
      }),
    ).toBe(false);

    expect(
      shouldReconnectPreviewWebSocket({
        hasEverConnected: true,
        sessionEnded: false,
        readyState: PREVIEW_WS_READY_STATE.CLOSED,
        recoverableError: false,
      }),
    ).toBe(false);
  });
});
