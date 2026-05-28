/**
 * Type declarations for AudioCodes WebRTC Client SDK v1.13.0
 *
 * The SDK is loaded as a global script from /js/ac_webrtc.min.js.
 * It exposes AudioCodesUA on the global window object.
 */

declare class AudioCodesUA {
  /** Audio-only call mode constant */
  AUDIO: number;
  /** Video call mode constant */
  VIDEO: number;
  /** Receive-only video mode constant */
  RECVONLY_VIDEO: number;

  /** Set the SBC server configuration */
  setServerConfig(addresses: string[], domain: string, iceServers?: RTCIceServer[]): void;

  /** Set SIP account credentials */
  setAccount(user: string, displayName: string, password: string, authUser?: string): void;

  /** Set event listeners */
  setListeners(listeners: AudioCodesListeners): void;

  /** Set DTMF transport options */
  setDtmfOptions(useWebRTC: boolean, duration?: number | null, interToneGap?: number | null): void;

  /** Set WebSocket keep-alive parameters */
  setWebSocketKeepAlive(ping: number, pong: number, stats: number, dist: boolean): void;

  /** Set reconnection interval range (seconds) */
  setReconnectIntervals(min: number, max: number): void;

  /** Set SIP REGISTER expiry (seconds) */
  setRegisterExpires(seconds: number): void;

  /** Set browser getUserMedia constraints per browser type */
  setBrowsersConstraints(constraints: Record<string, MediaStreamConstraints>): void;

  /** Set SDK modes (ICE timeout fix, RTP timeout, etc.) */
  setModes(modes: Record<string, unknown>): void;

  /** Set custom User-Agent string */
  setUserAgent(userAgent: string): void;

  /** Enable or disable adding video mid-call */
  setEnableAddVideo(enable: boolean): void;

  /** Set the AudioCodes logger function */
  setAcLogger(fn: (...args: unknown[]) => void): void;

  /** Set the JsSIP logger function */
  setJsSipLogger(fn: (...args: unknown[]) => void): void;

  /** Check available audio/video devices. Resolves with hasCamera boolean. */
  checkAvailableDevices(): Promise<boolean>;

  /** Initialize the SDK — connect WebSocket and optionally auto-register */
  init(autoLogin?: boolean): void;

  /** Initiate an outbound call */
  call(mode: number, target: string, extraHeaders?: string[]): AudioCodesCall;

  /** Send SIP un-REGISTER and disconnect */
  logout(): void;

  /** Check if the SDK is initialized */
  isInitialized(): boolean;

  /** Get the current SIP account */
  getAccount(): { user: string; displayName: string };

  /** Switch to the next SBC in the addresses list */
  switchSBC(): void;

  /** Set extra headers for SIP REGISTER */
  setRegisterExtraHeaders(headers: string[]): void;

  /** Use session timer (RFC 4028) */
  setUseSessionTimer(enable: boolean): void;
}

declare interface AudioCodesCall {
  /** Terminate the call (send BYE or CANCEL) */
  terminate(): void;

  /** Answer an incoming call */
  answer(mode: number, extraHeaders?: string[]): void;

  /** Reject an incoming call */
  reject(): void;

  /** Send a DTMF digit */
  sendDTMF(key: string): void;

  /** Put on hold or resume */
  hold(hold: boolean): void;

  /** Mute or unmute local audio */
  muteAudio(mute: boolean): void;

  /** Check if local audio is muted */
  isAudioMuted(): boolean;

  /** Check if local hold is active */
  isLocalHold(): boolean;

  /** Check if remote hold is active */
  isRemoteHold(): boolean;

  /** Check if call has video */
  hasVideo(): boolean;

  /** Get the local media stream */
  getRTCLocalStream(): MediaStream | null;

  /** Get the remote media stream */
  getRTCRemoteStream(): MediaStream | null;

  /** Get the RTCPeerConnection */
  getRTCPeerConnection(): RTCPeerConnection | null;

  /** Send SIP REFER for blind transfer */
  sendRefer(target: string, targetCall?: AudioCodesCall): void;

  /** Send SIP re-INVITE */
  sendReInvite(extraHeaders?: string[]): void;

  /** Send SIP INFO */
  sendInfo(contentType: string, body: string): void;

  /** Redirect an incoming call */
  redirect(target: string): void;

  /** Arbitrary data storage on the call object */
  data: Record<string, unknown>;
}

declare interface AudioCodesListeners {
  /** Login/registration state changed */
  loginStateChanged: (isLogin: boolean, cause: string, response?: unknown) => void;

  /** Outgoing call progress (180 Ringing) */
  outgoingCallProgress: (call: AudioCodesCall, response: unknown) => void;

  /** Call terminated (BYE, CANCEL, error) */
  callTerminated: (
    call: AudioCodesCall,
    message: unknown,
    cause: string,
    redirectTo?: string,
  ) => void;

  /** Call confirmed (200 OK + ACK, established) */
  callConfirmed: (call: AudioCodesCall, message: unknown, cause: string) => void;

  /** Media streams available */
  callShowStreams: (
    call: AudioCodesCall,
    localStream: MediaStream,
    remoteStream: MediaStream,
  ) => void;

  /** Incoming call received */
  incomingCall: (
    call: AudioCodesCall,
    invite: unknown,
    replacedCall: AudioCodesCall | null,
    hasSDP: boolean,
  ) => void;

  /** Hold state changed */
  callHoldStateChanged?: (call: AudioCodesCall, isHold: boolean, isRemote: boolean) => void;

  /** Incoming NOTIFY */
  incomingNotify?: (
    call: AudioCodesCall | null,
    eventName: string,
    from: string,
    contentType: string,
    body: string,
    request: unknown,
  ) => void;
}
