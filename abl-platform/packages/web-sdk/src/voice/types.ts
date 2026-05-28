/**
 * Voice-specific types
 */

export interface VoiceStartOptions {
  /** Mute microphone immediately after starting */
  muted?: boolean;
  /** Preferred audio input device ID */
  deviceId?: string;
}

export interface VoiceDeviceInfo {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

export interface AudioLevelEvent {
  /** Input (microphone) audio level 0-1 */
  inputLevel: number;
  /** Output (speaker) audio level 0-1 */
  outputLevel: number;
}
