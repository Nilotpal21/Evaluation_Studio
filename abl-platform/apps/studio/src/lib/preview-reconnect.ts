export const PREVIEW_WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export function shouldReconnectPreviewWebSocket({
  hasEverConnected,
  sessionEnded,
  readyState,
  recoverableError,
}: {
  hasEverConnected: boolean;
  sessionEnded: boolean;
  readyState: number | null | undefined;
  recoverableError?: boolean | null;
}) {
  if (!hasEverConnected || sessionEnded || recoverableError === false) {
    return false;
  }

  return (
    readyState === null ||
    readyState === undefined ||
    readyState === PREVIEW_WS_READY_STATE.CLOSING ||
    readyState === PREVIEW_WS_READY_STATE.CLOSED
  );
}
