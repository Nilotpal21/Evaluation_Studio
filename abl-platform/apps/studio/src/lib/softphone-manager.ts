/**
 * SoftphoneManager — Singleton wrapper around the AudioCodes WebRTC SDK.
 *
 * Manages the WebRTC phone lifecycle: connect → register → call → hangup → logout.
 * Fires callbacks that the Zustand store subscribes to for UI updates.
 */

/* global AudioCodesUA AudioCodesCall */

export type RegistrationStatus = 'idle' | 'connecting' | 'registered' | 'failed' | 'disconnected';
export type CallState = 'idle' | 'dialing' | 'ringing' | 'connected' | 'on-hold';

export interface SoftphoneConfig {
  sipDomain: string;
  wsServers: string[];
  sipUser: string;
  sipPassword: string;
  displayName: string;
}

export interface SoftphoneCallbacks {
  onRegistrationStatusChange: (status: RegistrationStatus, cause?: string) => void;
  onCallStateChange: (state: CallState) => void;
  onCallTerminated: (cause: string) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onError: (message: string) => void;
}

let instance: SoftphoneManager | null = null;

export class SoftphoneManager {
  private phone: AudioCodesUA | null = null;
  private activeCall: AudioCodesCall | null = null;
  private callbacks: SoftphoneCallbacks | null = null;
  private initialized = false;

  static getInstance(): SoftphoneManager {
    if (!instance) {
      instance = new SoftphoneManager();
    }
    return instance;
  }

  setCallbacks(callbacks: SoftphoneCallbacks): void {
    this.callbacks = callbacks;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasActiveCall(): boolean {
    return this.activeCall !== null;
  }

  /**
   * Wait for the AudioCodes SDK global to be available (script loaded).
   * Polls every 200ms for up to 10 seconds.
   */
  private waitForSdk(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof AudioCodesUA !== 'undefined') {
        resolve();
        return;
      }
      const start = Date.now();
      const interval = setInterval(() => {
        if (typeof AudioCodesUA !== 'undefined') {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error('AudioCodes SDK failed to load within timeout'));
        }
      }, 200);
    });
  }

  /**
   * Initialize the AudioCodes SDK, connect to SBC, and register.
   * Waits for the ac_webrtc.min.js script to load before proceeding.
   */
  async register(config: SoftphoneConfig): Promise<void> {
    // Wait for the SDK script to actually load (it's loaded via Next.js <Script> tag)
    await this.waitForSdk();

    // Reuse existing phone if already initialized with same config
    if (this.phone && this.initialized) {
      return;
    }

    this.phone = new AudioCodesUA();

    // Suppress verbose SDK logging (JsSIP + AudioCodes internals)
    this.phone.setAcLogger(() => {});
    this.phone.setJsSipLogger(() => {});
    this.phone.setServerConfig(config.wsServers, config.sipDomain, []);
    this.phone.setAccount(config.sipUser, config.displayName, config.sipPassword);

    // WebSocket keep-alive: ping every 10s, pong timeout 10s, stats every 60s
    this.phone.setWebSocketKeepAlive(10, 10, 60, false);
    this.phone.setReconnectIntervals(2, 30);
    this.phone.setRegisterExpires(600);

    // Use WebRTC (RFC 2833) for DTMF transport
    this.phone.setDtmfOptions(true, null, null);

    this.phone.setUserAgent('ABL-Studio-Softphone');

    this.phone.setListeners({
      loginStateChanged: (isLogin: boolean, cause: string) => {
        if (cause === 'connected') {
          this.callbacks?.onRegistrationStatusChange('connecting');
        } else if (cause === 'login') {
          this.initialized = true;
          this.callbacks?.onRegistrationStatusChange('registered');
        } else if (cause === 'login failed') {
          this.callbacks?.onRegistrationStatusChange('failed', cause);
        } else if (cause === 'disconnected') {
          this.initialized = false;
          this.callbacks?.onRegistrationStatusChange('disconnected');
        } else if (cause === 'logout') {
          this.initialized = false;
          this.callbacks?.onRegistrationStatusChange('idle');
        }
      },

      outgoingCallProgress: (_call: AudioCodesCall, _response: unknown) => {
        this.callbacks?.onCallStateChange('ringing');
      },

      callConfirmed: (_call: AudioCodesCall, _message: unknown, _cause: string) => {
        this.callbacks?.onCallStateChange('connected');
      },

      callTerminated: (_call: AudioCodesCall, _message: unknown, cause: string) => {
        this.activeCall = null;
        this.callbacks?.onCallStateChange('idle');
        this.callbacks?.onCallTerminated(cause);
      },

      callShowStreams: (
        _call: AudioCodesCall,
        _localStream: MediaStream,
        remoteStream: MediaStream,
      ) => {
        this.callbacks?.onRemoteStream(remoteStream);
      },

      incomingCall: (
        call: AudioCodesCall,
        _invite: unknown,
        _replacedCall: AudioCodesCall | null,
        _hasSDP: boolean,
      ) => {
        // Auto-reject incoming calls — softphone is outbound-only for now
        call.reject();
      },

      callHoldStateChanged: (_call: AudioCodesCall, isHold: boolean, _isRemote: boolean) => {
        if (isHold) {
          this.callbacks?.onCallStateChange('on-hold');
        } else {
          this.callbacks?.onCallStateChange('connected');
        }
      },
    });

    this.callbacks?.onRegistrationStatusChange('connecting');

    this.phone.init(true);

    // Non-blocking device check — warn if no microphone but don't block registration
    this.phone
      .checkAvailableDevices()
      .then((hasDevices: boolean) => {
        if (!hasDevices) {
          this.callbacks?.onError('No audio devices available');
        }
      })
      .catch(() => {
        // Not critical — registration continues regardless
      });
  }

  /**
   * Make an outbound call to the specified SIP URI or phone number.
   * The number is dialed as sip:<number>@<sipDomain>.
   */
  makeCall(target: string): void {
    if (!this.phone || !this.initialized) {
      this.callbacks?.onError('Phone not registered');
      return;
    }
    if (this.activeCall) {
      this.callbacks?.onError('A call is already in progress');
      return;
    }

    this.callbacks?.onCallStateChange('dialing');
    this.activeCall = this.phone.call(this.phone.AUDIO, target);
  }

  /** Terminate the active call */
  hangup(): void {
    if (this.activeCall) {
      this.activeCall.terminate();
      this.activeCall = null;
    }
  }

  /** Send a DTMF digit on the active call */
  sendDTMF(key: string): void {
    if (this.activeCall) {
      this.activeCall.sendDTMF(key);
    }
  }

  /** Toggle mute on the active call. Returns the new mute state. */
  toggleMute(): boolean {
    if (!this.activeCall) return false;
    const currentlyMuted = this.activeCall.isAudioMuted();
    this.activeCall.muteAudio(!currentlyMuted);
    return !currentlyMuted;
  }

  /** Toggle hold on the active call. Returns the new hold state. */
  toggleHold(): boolean {
    if (!this.activeCall) return false;
    const currentlyHeld = this.activeCall.isLocalHold();
    this.activeCall.hold(!currentlyHeld);
    return !currentlyHeld;
  }

  /** Un-register from the SBC and disconnect WebSocket */
  logout(): void {
    if (this.activeCall) {
      this.activeCall.terminate();
      this.activeCall = null;
    }
    if (this.phone) {
      if (this.initialized) {
        try {
          this.phone.logout();
        } catch {
          // SDK throws if internal SIP session is null (e.g. WS never connected)
        }
      }
      this.phone = null;
    }
    this.initialized = false;
    this.callbacks?.onRegistrationStatusChange('idle');
  }
}
