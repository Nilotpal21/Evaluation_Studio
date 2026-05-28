/**
 * TwilioAdapter - Wrapper around Twilio Voice SDK
 *
 * Handles Twilio Device setup, call management, and audio streaming.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';

// Twilio types (simplified for compatibility)
interface TwilioDevice {
  register(): Promise<void>;
  unregister(): Promise<void>;
  connect(options?: { params?: Record<string, string> }): Promise<TwilioCall>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  destroy(): void;
  state: string;
}

interface TwilioCall {
  disconnect(): void;
  mute(shouldMute?: boolean): void;
  isMuted(): boolean;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  status(): string;
  parameters: Record<string, unknown>;
}

interface TwilioDeviceConstructor {
  new (token: string, options?: Record<string, unknown>): TwilioDevice;
}

// =============================================================================
// TYPES
// =============================================================================

interface TwilioAdapterEvents {
  registered: void;
  unregistered: void;
  callConnected: void;
  callDisconnected: { reason?: string };
  callError: { error: Error };
  audioLevel: { level: number };
}

// =============================================================================
// TWILIO ADAPTER
// =============================================================================

export class TwilioAdapter extends TypedEventEmitter<TwilioAdapterEvents> {
  private device: TwilioDevice | null = null;
  private call: TwilioCall | null = null;
  private readonly debug: boolean;
  private audioLevelInterval: ReturnType<typeof setInterval> | null = null;

  constructor(debug = false) {
    super();
    this.debug = debug;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Initialize Twilio Device with access token
   */
  async initialize(token: string): Promise<void> {
    // Get Twilio SDK from global scope (loaded via script tag or import)
    const Twilio = this.getTwilioSDK();
    if (!Twilio) {
      throw new Error('Twilio Voice SDK not loaded. Include @twilio/voice-sdk in your page.');
    }

    this.log('Initializing Twilio Device');

    // Create device with optimized settings for voice AI
    this.device = new Twilio.Device(token, {
      codecPreferences: ['opus', 'pcmu'],
      enableRingingState: false,
      logLevel: this.debug ? 1 : 0,
      edge: 'ashburn', // Can be made configurable
    });

    this.setupDeviceHandlers();

    // Register device
    await this.device.register();
    this.log('Twilio Device registered');
  }

  /**
   * Start a voice call
   */
  async connect(params?: Record<string, string>): Promise<void> {
    if (!this.device) {
      throw new Error('Twilio Device not initialized');
    }

    if (this.call) {
      throw new Error('Call already in progress');
    }

    this.log('Connecting call');

    this.call = await this.device.connect({
      params: params || {},
    });

    this.setupCallHandlers();
    this.startAudioLevelMonitoring();
  }

  /**
   * Disconnect current call
   */
  disconnect(): void {
    if (this.call) {
      this.call.disconnect();
      this.call = null;
    }
    this.stopAudioLevelMonitoring();
  }

  /**
   * Mute/unmute microphone
   */
  setMuted(muted: boolean): void {
    if (this.call) {
      this.call.mute(muted);
    }
  }

  /**
   * Check if currently muted
   */
  isMuted(): boolean {
    return this.call?.isMuted() ?? false;
  }

  /**
   * Check if call is active
   */
  isConnected(): boolean {
    return this.call?.status() === 'open';
  }

  /**
   * Destroy device and cleanup
   */
  destroy(): void {
    this.disconnect();
    this.stopAudioLevelMonitoring();

    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }

  // ===========================================================================
  // STATIC HELPERS
  // ===========================================================================

  /**
   * Check if browser supports WebRTC
   */
  static isSupported(): boolean {
    return !!(
      typeof window !== 'undefined' &&
      window.RTCPeerConnection &&
      navigator.mediaDevices?.getUserMedia
    );
  }

  /**
   * Get available audio input devices
   */
  static async getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /**
   * Request microphone permission
   */
  static async requestMicrophonePermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately after getting permission
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private getTwilioSDK(): { Device: TwilioDeviceConstructor } | null {
    if (typeof window !== 'undefined') {
      // Check for global Twilio object (loaded via script tag)
      const globalTwilio = (window as unknown as { Twilio?: { Device: TwilioDeviceConstructor } })
        .Twilio;
      if (globalTwilio?.Device) {
        return globalTwilio;
      }
    }

    // Try to import dynamically (ESM)
    try {
      // This will be replaced by bundler with actual import
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const twilioSdk = require('@twilio/voice-sdk');
      return twilioSdk;
    } catch {
      return null;
    }
  }

  private setupDeviceHandlers(): void {
    if (!this.device) return;

    this.device.on('registered', () => {
      this.log('Device registered');
      this.emit('registered', undefined);
    });

    this.device.on('unregistered', () => {
      this.log('Device unregistered');
      this.emit('unregistered', undefined);
    });

    this.device.on('error', (...args: unknown[]) => {
      const error = args[0] as Error;
      this.log('Device error:', error);
      this.emit('callError', { error });
    });
  }

  private setupCallHandlers(): void {
    if (!this.call) return;

    this.call.on('accept', () => {
      this.log('Call accepted');
      this.emit('callConnected', undefined);
    });

    this.call.on('disconnect', () => {
      this.log('Call disconnected');
      this.stopAudioLevelMonitoring();
      this.call = null;
      this.emit('callDisconnected', {});
    });

    this.call.on('error', (...args: unknown[]) => {
      const error = args[0] as Error;
      this.log('Call error:', error);
      this.emit('callError', { error });
    });

    this.call.on('warning', (...args: unknown[]) => {
      const [name, data] = args;
      this.log('Call warning:', name, data);
    });
  }

  private startAudioLevelMonitoring(): void {
    // Monitor audio levels every 100ms
    this.audioLevelInterval = setInterval(() => {
      if (this.call) {
        // Note: Actual implementation would use Twilio's audio stats
        // This is a placeholder for the actual audio level detection
        this.emit('audioLevel', { level: 0 });
      }
    }, 100);
  }

  private stopAudioLevelMonitoring(): void {
    if (this.audioLevelInterval) {
      clearInterval(this.audioLevelInterval);
      this.audioLevelInterval = null;
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[AgentSDK:Twilio]', ...args);
    }
  }
}
