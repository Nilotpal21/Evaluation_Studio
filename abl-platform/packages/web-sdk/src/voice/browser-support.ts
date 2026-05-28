import { isBrowserVoiceCaptureSupported } from '../internal/sdk-widget-capabilities.js';

/**
 * Browser voice support for pipeline mode requires microphone capture and an audio context.
 * WebRTC primitives are optional because the SDK can stream audio over the websocket transport.
 */
export function isVoiceBrowserSupported(): boolean {
  return isBrowserVoiceCaptureSupported();
}
