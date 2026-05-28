/**
 * VoiceClient — Voice interaction via WebSocket audio pipeline + optional Twilio WebRTC.
 *
 * Supports two voice modes:
 * - Pipeline: Client-side VAD + PCM16 audio capture → WebSocket → server STT/LLM/TTS → MP3 playback
 * - Realtime: Native audio I/O via realtime LLM providers (PCM16 streaming)
 *
 * Pipeline mode uses AudioCapture + VADAdapter for mic input and speech detection,
 * with barge-in support when the user speaks while audio is playing.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';
import type { SessionManager } from '../core/SessionManager.js';
import type {
  VoiceState,
  VoiceInfo,
  VoiceEvents,
  VoiceMode,
  VoiceSessionCapabilities,
  VoiceClientOptions,
  WSServerMessage,
  ThoughtEventData,
  TranscriptItem,
} from '../core/types.js';
import { getTraceEventData, getTraceEventPayload } from '../transport/trace-event-utils.js';
import { RealtimeAudioPlayer } from './RealtimeAudioPlayer.js';
import { AudioCapture } from './AudioCapture.js';
import type { VADEvents } from './VADAdapter.js';
import { isVoiceBrowserSupported } from './browser-support.js';

type PipelineVADAdapter = {
  initialize?: () => Promise<boolean>;
  start?: () => void;
  pause?: () => void;
  destroy: () => void;
  on: <K extends keyof VADEvents>(event: K, handler: (payload: VADEvents[K]) => void) => () => void;
};

function getVoiceMessageError(message: WSServerMessage): string {
  const msg = message as Record<string, unknown>;
  return ((msg.message ?? msg.error) as string) || 'Voice error';
}

function getRuntimeMessageError(message: WSServerMessage): string {
  const msg = message as Record<string, unknown>;
  return ((msg.message ?? msg.error) as string) || 'Runtime error';
}

export class VoiceClient extends TypedEventEmitter<VoiceEvents> {
  private readonly sessionManager: SessionManager;
  private readonly debug: boolean;
  private readonly options: VoiceClientOptions;
  private sessionMessageUnsubscribe: (() => void) | null = null;
  private state: VoiceState = 'idle';
  private isMuted = false;
  private currentTranscript = '';
  private hasMicPermission: boolean | null = null;
  private twilioDevice: unknown = null;
  private twilioCall: unknown = null;

  // Voice mode
  private voiceMode: VoiceMode = 'pipeline';
  private voiceCapabilities: VoiceSessionCapabilities | undefined;

  // Realtime voice support
  private realtimePlayer: RealtimeAudioPlayer | null = null;

  // Pipeline voice support: AudioCapture + VAD + audio playback
  private audioCapture: AudioCapture | null = null;
  private vadAdapter: PipelineVADAdapter | null = null;
  private isBargeInEnabled: boolean;

  // Trace event state (thoughts, status)
  private lastThoughtData: ThoughtEventData | null = null;
  private statusMessageText: string | null = null;

  // Pipeline audio playback state
  private pipelineAudioChunks: Uint8Array[] = [];
  private pipelineAudioElement: HTMLAudioElement | null = null;
  private pipelineAudioUrl: string | null = null;
  private isPipelinePlaying = false;

  // Live sync: publish voice transcripts to the shared session model
  private liveSyncEnabled = false;
  private transcriptPublishHandler: ((item: TranscriptItem) => void) | null = null;

  constructor(sessionManager: SessionManager, debug = false, options?: VoiceClientOptions) {
    super();
    this.sessionManager = sessionManager;
    this.debug = debug;
    this.options = options || {};
    this.isBargeInEnabled = this.options.enableBargeIn !== false; // enabled by default
  }

  /**
   * Start voice interaction.
   *
   * In pipeline mode: initializes AudioCapture + VAD, sends voice_start,
   * and begins listening for speech.
   *
   * In realtime mode (when server responds with voiceMode='realtime'):
   * initializes RealtimeAudioPlayer for PCM16 streaming.
   */
  async start(): Promise<void> {
    if (!this.sessionManager.isConnected()) {
      throw new Error('Not connected to the platform');
    }

    if (this.state !== 'idle') {
      throw new Error('Cannot start voice from state: ' + this.state);
    }

    if (!VoiceClient.isSupported()) {
      throw new Error('Voice is not supported in this browser');
    }

    this.setupMessageHandlers();
    this.setState('connecting');

    try {
      // Request microphone permission
      this.log('Requesting microphone permission');
      const hasPermission = await this.requestMicPermission();

      if (!hasPermission) {
        this.hasMicPermission = false;
        this.emit('micPermissionDenied', undefined);
        throw new Error('Microphone permission denied');
      }

      this.hasMicPermission = true;

      // Send voice_start to server — server responds with voice_started (includes voiceMode)
      const sessionId = this.sessionManager.getSessionId();
      this.sessionManager.send({ type: 'voice_start', sessionId });

      // Wait for voice_started response to determine mode
      await this.waitForVoiceStarted();

      if (this.voiceMode === 'realtime') {
        // Realtime mode: server handles audio I/O, we just play PCM16 back
        this.initRealtimePlayer();
      } else {
        // Pipeline mode: client-side AudioCapture + VAD
        await this.initPipelineVoice();
      }

      this.setState('ready');
      this.emit('ready', undefined);
      this.log('Voice started successfully', { mode: this.voiceMode });
    } catch (error) {
      this.destroyPipelineVoice();
      this.teardownMessageHandlers();
      this.realtimePlayer = null;
      this.voiceMode = 'pipeline';
      this.voiceCapabilities = undefined;
      this.currentTranscript = '';
      this.setState('error');
      this.emit('error', { error: error as Error });
      throw error;
    }
  }

  /**
   * Stop voice interaction and release all resources.
   */
  async stop(): Promise<void> {
    this.log('Stopping voice');
    const shouldNotifyPlatform = this.state !== 'idle';
    const realtimePlayer = this.realtimePlayer;

    this.teardownMessageHandlers();

    // Clean up pipeline voice
    this.destroyPipelineVoice();

    // Disconnect Twilio
    if (this.twilioCall) {
      (this.twilioCall as { disconnect: () => void }).disconnect();
      this.twilioCall = null;
    }

    if (this.twilioDevice) {
      (this.twilioDevice as { destroy: () => void }).destroy();
      this.twilioDevice = null;
    }

    // Notify platform
    const sessionId = this.sessionManager.getSessionId();
    if (shouldNotifyPlatform && sessionId && this.sessionManager.isConnected()) {
      this.sessionManager.send({ type: 'voice_stop', sessionId });
    }

    this.realtimePlayer = null;
    this.voiceMode = 'pipeline';
    this.voiceCapabilities = undefined;
    this.currentTranscript = '';
    this.setState('idle');

    if (realtimePlayer) {
      try {
        await realtimePlayer.destroy();
      } catch (error) {
        const resolvedError = error instanceof Error ? error : new Error(String(error));
        this.log('Failed to destroy realtime audio player', resolvedError);
        this.emit('error', { error: resolvedError });
      }
    }
  }

  /**
   * Fully tear down VoiceClient resources and listeners.
   */
  async dispose(): Promise<void> {
    await this.stop();
    this.disableLiveSync();
    this.removeAllListeners();
  }

  /**
   * Mute microphone — toggles audio tracks and pauses VAD.
   */
  mute(): void {
    this.isMuted = true;

    // Mute Twilio call if active
    if (this.twilioCall) {
      (this.twilioCall as { mute: (m: boolean) => void }).mute(true);
    }

    // Mute pipeline media stream tracks
    const stream = this.audioCapture?.getMediaStream();
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }

    // Pause VAD
    this.vadAdapter?.pause?.();

    this.log('Muted');
  }

  /**
   * Unmute microphone — re-enables audio tracks and resumes VAD.
   */
  unmute(): void {
    this.isMuted = false;

    // Unmute Twilio call if active
    if (this.twilioCall) {
      (this.twilioCall as { mute: (m: boolean) => void }).mute(false);
    }

    // Unmute pipeline media stream tracks
    const stream = this.audioCapture?.getMediaStream();
    if (stream) {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    }

    // Resume VAD
    this.vadAdapter?.start?.();

    this.log('Unmuted');
  }

  toggleMute(): boolean {
    if (this.isMuted) {
      this.unmute();
    } else {
      this.mute();
    }
    return this.isMuted;
  }

  /**
   * Get current state
   */
  getState(): VoiceState {
    return this.state;
  }

  getInfo(): VoiceInfo {
    return {
      state: this.state,
      voiceMode: this.voiceMode,
      isMuted: this.isMuted,
      currentTranscript: this.currentTranscript,
      hasMicPermission: this.hasMicPermission ?? undefined,
      capabilities: this.voiceCapabilities,
    };
  }

  isActive(): boolean {
    return this.state !== 'idle' && this.state !== 'error';
  }

  isListening(): boolean {
    return this.state === 'listening';
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }

  /**
   * Check browser support.
   * Requires getUserMedia + AudioContext. RTCPeerConnection is NOT required
   * since pipeline mode uses WebSocket audio transport.
   */
  static isSupported(): boolean {
    return isVoiceBrowserSupported();
  }

  /**
   * Get the current voice mode (pipeline or realtime).
   */
  getVoiceMode(): VoiceMode {
    return this.voiceMode;
  }

  /**
   * Get the last thought event data (from trace_event with tool_thought).
   */
  getLastThought(): ThoughtEventData | null {
    return this.lastThoughtData;
  }

  /**
   * Get the current status message (from trace_event with status_update).
   * Returns null if no status or after status_clear.
   */
  getStatusMessage(): string | null {
    return this.statusMessageText;
  }

  // ===========================================================================
  // LIVE SYNC — Voice transcript publishing into shared session model
  // ===========================================================================

  /**
   * Enable live sync mode. When enabled, final voice transcripts are published
   * through the shared delivery path so that attached text participants see them.
   *
   * @param handler — callback that receives TranscriptItem for each final voice transcript
   */
  enableLiveSync(handler: (item: TranscriptItem) => void): void {
    this.liveSyncEnabled = true;
    this.transcriptPublishHandler = handler;
    this.log('Live sync enabled');
  }

  /**
   * Disable live sync mode. Stops publishing voice transcripts to the shared session.
   */
  disableLiveSync(): void {
    this.liveSyncEnabled = false;
    this.transcriptPublishHandler = null;
    this.log('Live sync disabled');
  }

  /**
   * Whether live sync is currently enabled.
   */
  isLiveSyncEnabled(): boolean {
    return this.liveSyncEnabled;
  }

  /**
   * Publish a final voice transcript as a TranscriptItem to the shared session.
   * Called internally when a final transcription is received and live sync is active.
   */
  private publishVoiceTranscript(text: string, isFinal: boolean): void {
    if (!this.liveSyncEnabled || !this.transcriptPublishHandler || !isFinal) return;

    const sessionId = this.sessionManager.getSessionId() || '';
    const item: TranscriptItem = {
      id: 'vt_' + Math.random().toString(36).substring(2, 15),
      sessionId,
      role: 'user',
      content: text,
      channel: 'voice',
      sourceChannel: 'voice',
      inputMode: 'speech',
      sequence: Date.now(),
      timestamp: new Date(),
      final: true,
    };

    try {
      this.transcriptPublishHandler(item);
    } catch (error) {
      this.log('Error publishing voice transcript:', error);
    }
  }

  // ===========================================================================
  // MESSAGE HANDLERS
  // ===========================================================================

  private setupMessageHandlers(): void {
    if (this.sessionMessageUnsubscribe) {
      return;
    }

    this.sessionMessageUnsubscribe = this.sessionManager.on('message', (message) => {
      this.handleServerMessage(message);
    });
  }

  private teardownMessageHandlers(): void {
    if (this.sessionMessageUnsubscribe) {
      this.sessionMessageUnsubscribe();
      this.sessionMessageUnsubscribe = null;
    }
  }

  private handleServerMessage(message: WSServerMessage): void {
    const msg = message as Record<string, unknown>;

    switch (message.type) {
      case 'transcription':
        this.handleTranscription({
          text: msg.text as string,
          isFinal: msg.isFinal as boolean,
          confidence: msg.confidence as number | undefined,
        });
        break;

      case 'voice_response_start':
        this.setState('speaking');
        this.emit('responseStart', { messageId: msg.messageId as string });
        break;

      case 'voice_response_chunk':
        this.emit('responseChunk', {
          messageId: msg.messageId as string,
          text: msg.text as string,
        });
        break;

      case 'voice_response_end':
        this.setState('ready');
        this.emit('responseEnd', {
          messageId: msg.messageId as string,
          text: msg.text as string,
        });
        break;

      case 'voice_speaking':
        if (msg.isSpeaking) {
          this.setState('speaking');
        } else {
          this.setState('ready');
        }
        this.emit('speaking', { isSpeaking: msg.isSpeaking as boolean });
        break;

      case 'voice_error':
        this.emit('error', { error: new Error(getVoiceMessageError(message)) });
        break;

      // Pipeline audio playback messages
      case 'voice_audio_chunk':
        this.handlePipelineAudioChunk(msg.audio as string);
        break;

      case 'voice_speaking_end':
        this.handlePipelineSpeakingEnd();
        break;

      case 'voice_barge_in_ack':
        this.log('Barge-in acknowledged by server');
        this.handleServerBargeInAck();
        break;

      case 'voice_processing':
        this.setState('processing');
        break;

      // Realtime voice messages
      case 'voice_realtime_audio':
        if (this.voiceMode === 'realtime' && this.realtimePlayer) {
          const audioBase64 = msg.audio as string;
          const audioBytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
          this.realtimePlayer.enqueue(audioBytes.buffer);
          this.emit('realtimeAudio', { audio: audioBytes.buffer });
        }
        break;

      case 'voice_realtime_transcript':
        if (this.voiceMode === 'realtime') {
          const text = msg.text as string;
          const role = msg.role as 'user' | 'assistant';
          const isFinal = msg.isFinal as boolean;
          this.emit('realtimeTranscript', { text, role, isFinal });
          // Also emit standard transcription events for compatibility
          if (role === 'user') {
            this.emit('transcription', { text, isFinal, confidence: 1 });
            if (isFinal) {
              this.emit('transcriptionFinal', { text, confidence: 1 });
              // Publish to shared session if live sync is active
              this.publishVoiceTranscript(text, true);
            }
          }
        }
        break;

      case 'trace_event':
        this.handleTraceEvent(msg);
        break;
    }
  }

  private handleTraceEvent(msg: Record<string, unknown>): void {
    const event = getTraceEventPayload(msg);
    const eventData = event ? getTraceEventData(event) : null;
    if (!event || typeof event.type !== 'string' || !eventData) return;
    const showActivityUpdates = this.sessionManager.getScope()?.showActivityUpdates === true;

    switch (event.type) {
      case 'tool_thought': {
        if (!showActivityUpdates) {
          return;
        }
        const thoughtData: ThoughtEventData = {
          toolName: ((eventData.toolName ?? event.toolName) as string) || '',
          thought: ((eventData.thought ?? event.thought) as string) || '',
          reasoning: ((eventData.reasoning ?? event.reasoning) as string) || '',
          agent:
            ((eventData.agentName ??
              eventData.agent ??
              event.agentName ??
              event.agent) as string) || '',
        };
        this.lastThoughtData = thoughtData;
        this.emit('thought', thoughtData);
        break;
      }

      case 'status_update': {
        if (!showActivityUpdates) {
          return;
        }
        const text = ((eventData.text ?? event.text) as string) || '';
        this.statusMessageText = text;
        this.emit('statusUpdate', {
          text,
          operation: ((eventData.operation ?? event.operation) as string) || 'general',
        });
        break;
      }

      case 'status_clear':
        if (!showActivityUpdates) {
          return;
        }
        this.statusMessageText = null;
        this.emit('statusClear', undefined);
        break;

      default:
        // Unknown trace event type — silently ignore
        break;
    }
  }

  private handleTranscription(data: { text: string; isFinal: boolean; confidence?: number }): void {
    this.currentTranscript = data.text;

    if (data.isFinal) {
      this.setState('processing');
      this.emit('transcriptionFinal', {
        text: data.text,
        confidence: data.confidence ?? 1,
      });

      // Publish to shared session if live sync is active
      this.publishVoiceTranscript(data.text, true);
    } else {
      this.setState('listening');
      this.emit('transcription', {
        text: data.text,
        isFinal: false,
        confidence: data.confidence,
      });
    }
  }

  // ===========================================================================
  // PIPELINE VOICE (AudioCapture + VAD + barge-in)
  // ===========================================================================

  /**
   * Initialize pipeline voice: AudioCapture + VAD.
   * VAD is optional — if @ricky0123/vad-web is not installed, falls back to
   * manual push-to-talk mode.
   */
  private async initPipelineVoice(): Promise<void> {
    // Initialize AudioCapture
    this.audioCapture = new AudioCapture();
    await this.audioCapture.start({
      sampleRate: this.options.sampleRate ?? 16000,
      deviceId: this.options.deviceId,
    });

    // Initialize VAD lazily so importing the SDK does not pull ONNX/VAD into
    // chat-only bundles.
    const { VADAdapter, ManualVADAdapter } = await import('./VADAdapter.js');
    const vadAdapter = new VADAdapter(this.options.vadConfig);
    const vadAvailable = await vadAdapter.initialize();

    if (vadAvailable) {
      this.vadAdapter = vadAdapter;
      this.log('VAD initialized (automatic speech detection)');
    } else {
      // Clean up failed VAD adapter and use manual fallback
      vadAdapter.destroy();
      this.vadAdapter = new ManualVADAdapter();
      this.log('VAD not available, using manual push-to-talk');
    }

    this.emit('vadAvailable', { available: vadAvailable });

    // Wire VAD events
    this.wireVADEvents(this.vadAdapter);

    // Start VAD if automatic
    this.vadAdapter.start?.();

    this.setState('listening');
  }

  /**
   * Wire VAD speech events to the voice pipeline.
   */
  private wireVADEvents(vad: PipelineVADAdapter): void {
    // On speech start: handle barge-in if audio is playing
    vad.on('speechStart', () => {
      if (this.isPipelinePlaying && this.isBargeInEnabled) {
        this.log('Barge-in detected');
        this.performBargeIn();
      }

      this.setState('listening');
    });

    // On speech end: encode audio and send to server
    vad.on('speechEnd', ({ audio }: VADEvents['speechEnd']) => {
      const pcm16 = AudioCapture.float32ToPCM16(audio);
      const audioBase64 = AudioCapture.pcm16ToBase64(pcm16);

      const sessionId = this.sessionManager.getSessionId();
      if (sessionId && this.sessionManager.isConnected()) {
        // Send the complete audio utterance
        this.sessionManager.send({
          type: 'voice_audio',
          sessionId,
          audio: audioBase64,
        });

        // Signal speech end
        this.sessionManager.send({
          type: 'speech_end',
          sessionId,
        });
      }

      this.setState('processing');
    });
  }

  /**
   * Perform barge-in: stop audio playback and notify server.
   */
  private performBargeIn(): void {
    this.stopPipelineAudio();

    const sessionId = this.sessionManager.getSessionId();
    if (sessionId && this.sessionManager.isConnected()) {
      this.sessionManager.send({ type: 'barge_in', sessionId });
    }

    this.emit('bargeIn', undefined);
  }

  /**
   * Handle incoming pipeline audio chunk (base64-encoded MP3).
   * Accumulates chunks until voice_speaking_end triggers playback.
   */
  private handlePipelineAudioChunk(audioBase64: string): void {
    if (!audioBase64) return;

    const audioBytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    this.pipelineAudioChunks.push(audioBytes);

    this.setState('speaking');
  }

  /**
   * Handle voice_speaking_end — play accumulated audio chunks.
   */
  private handlePipelineSpeakingEnd(): void {
    this.playPipelineAudio();
  }

  private handleServerBargeInAck(): void {
    this.stopPipelineAudio();
    this.realtimePlayer?.interrupt();
    if (this.state === 'speaking' || this.state === 'processing') {
      this.setState(this.voiceMode === 'realtime' ? 'ready' : 'listening');
    }
    this.emit('speaking', { isSpeaking: false });
  }

  /**
   * Combine accumulated MP3 chunks and play them.
   */
  private playPipelineAudio(): void {
    if (this.pipelineAudioChunks.length === 0) return;

    // Combine all chunks
    const totalLength = this.pipelineAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.pipelineAudioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.pipelineAudioChunks = [];

    // Create audio element and play
    const blob = new Blob([combined], { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);
    this.pipelineAudioUrl = url;
    const audio = new Audio(url);
    this.pipelineAudioElement = audio;
    this.isPipelinePlaying = true;

    audio.onended = () => {
      this.revokePipelineAudioUrl();
      this.pipelineAudioElement = null;
      this.isPipelinePlaying = false;
      this.setState('listening');
      this.emit('speaking', { isSpeaking: false });
    };

    audio.onerror = () => {
      this.revokePipelineAudioUrl();
      this.pipelineAudioElement = null;
      this.isPipelinePlaying = false;
      this.setState('listening');
    };

    this.emit('speaking', { isSpeaking: true });
    audio.play().catch((err) => {
      this.log('Failed to play pipeline audio', err);
      this.revokePipelineAudioUrl();
      this.pipelineAudioElement = null;
      this.isPipelinePlaying = false;
      this.setState('listening');
    });
  }

  /**
   * Stop pipeline audio playback (used for barge-in).
   */
  private stopPipelineAudio(): void {
    const audioElement = this.pipelineAudioElement;
    this.pipelineAudioElement = null;

    if (audioElement) {
      audioElement.onended = null;
      audioElement.onerror = null;
      audioElement.pause();
      audioElement.src = '';
    }

    this.revokePipelineAudioUrl();
    this.pipelineAudioChunks = [];
    this.isPipelinePlaying = false;
  }

  private revokePipelineAudioUrl(): void {
    if (this.pipelineAudioUrl) {
      URL.revokeObjectURL(this.pipelineAudioUrl);
      this.pipelineAudioUrl = null;
    }
  }

  /**
   * Destroy all pipeline voice resources.
   */
  private destroyPipelineVoice(): void {
    this.stopPipelineAudio();

    if (this.vadAdapter) {
      this.vadAdapter.destroy();
      this.vadAdapter = null;
    }

    if (this.audioCapture) {
      this.audioCapture.stop();
      this.audioCapture = null;
    }
  }

  // ===========================================================================
  // REALTIME VOICE
  // ===========================================================================

  private initRealtimePlayer(): void {
    if (this.realtimePlayer) return;
    this.realtimePlayer = new RealtimeAudioPlayer({
      sampleRate: 24000,
      onSpeakingChange: (isSpeaking) => {
        this.emit('speaking', { isSpeaking });
        if (isSpeaking) {
          this.setState('speaking');
        } else {
          this.setState('ready');
        }
      },
    });
    this.realtimePlayer.init().catch((err) => {
      this.log('Failed to init realtime audio player', err);
    });
  }

  // ===========================================================================
  // MIC PERMISSION + TWILIO
  // ===========================================================================

  private async requestMicPermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for voice_started message from server (determines voiceMode).
   */
  private waitForVoiceStarted(): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};

      const timeout = setTimeout(() => {
        cleanup();
        // Default to pipeline mode if server doesn't respond
        this.voiceMode = 'pipeline';
        this.voiceCapabilities = undefined;
        resolve();
      }, 5000);

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
      };

      const onMessage = (message: WSServerMessage) => {
        if (message.type === 'voice_started') {
          cleanup();
          const msg = message as Record<string, unknown>;
          this.voiceMode = (msg.voiceMode as VoiceMode) || 'pipeline';
          this.voiceCapabilities = msg.capabilities as VoiceSessionCapabilities | undefined;
          resolve();
        } else if (message.type === 'voice_error') {
          cleanup();
          reject(new Error(getVoiceMessageError(message)));
        }
      };

      unsubscribe = this.sessionManager.on('message', onMessage);
    });
  }

  private async requestVoiceToken(): Promise<string> {
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Voice token request timeout'));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
      };

      const onMessage = (message: WSServerMessage) => {
        const msg = message as Record<string, unknown>;
        if (message.type === 'voice_token') {
          cleanup();
          resolve(msg.token as string);
        } else if (message.type === 'error') {
          cleanup();
          reject(new Error(getRuntimeMessageError(message)));
        }
      };

      unsubscribe = this.sessionManager.on('message', onMessage);

      this.sessionManager.send({
        type: 'voice_token_request',
        sessionId: this.sessionManager.getSessionId(),
      });
    });
  }

  private async initializeTwilio(token: string): Promise<void> {
    // Check for Twilio SDK
    const TwilioDevice = this.getTwilioDevice();
    if (!TwilioDevice) {
      this.log('Twilio SDK not loaded, using WebSocket audio fallback');
      return;
    }

    this.twilioDevice = new TwilioDevice(token, {
      codecPreferences: ['opus', 'pcmu'],
      enableRingingState: false,
    });

    await (this.twilioDevice as { register: () => Promise<void> }).register();

    const sessionId = this.sessionManager.getSessionId();
    this.twilioCall = await (
      this.twilioDevice as {
        connect: (opts: { params: Record<string, string> }) => Promise<unknown>;
      }
    ).connect({ params: { sessionId: sessionId || '' } });

    this.setupTwilioCallHandlers();
    this.log('Twilio connected');
  }

  private setupTwilioCallHandlers(): void {
    if (!this.twilioCall) return;

    const call = this.twilioCall as {
      on: (event: string, handler: (...args: unknown[]) => void) => void;
    };

    call.on('accept', () => {
      this.log('Twilio call accepted');
      this.setState('ready');
    });

    call.on('disconnect', () => {
      this.log('Twilio call disconnected');
      this.setState('idle');
    });

    call.on('error', (...args: unknown[]) => {
      const error = args[0] as Error;
      this.log('Twilio call error:', error);
      this.setState('error');
      this.emit('error', { error });
    });
  }

  private getTwilioDevice(): (new (token: string, opts: unknown) => unknown) | null {
    if (typeof window !== 'undefined') {
      const w = window as unknown as { Twilio?: { Device: unknown } };
      if (w.Twilio?.Device) {
        return w.Twilio.Device as new (token: string, opts: unknown) => unknown;
      }
    }
    return null;
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private setState(newState: VoiceState): void {
    if (this.state !== newState) {
      const previousState = this.state;
      this.state = newState;
      this.emit('stateChange', { state: newState, previousState });
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[AgentSDK:Voice]', ...args);
    }
  }
}
