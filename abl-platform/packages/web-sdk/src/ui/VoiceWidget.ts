/**
 * VoiceWidget - Web Component for voice interface
 *
 * Usage:
 * <agent-voice
 *   project-id="xxx"
 *   api-key="pk_xxx"
 *   endpoint="https://runtime.example.com"
 *   position="bottom-left"
 * ></agent-voice>
 */

import { AgentSDK } from '../core/AgentSDK.js';
import type { VoiceClient } from '../voice/VoiceClient.js';
import type { VoiceState, WidgetTheme, WidgetPosition, ThoughtEventData } from '../core/types.js';
import { isVoiceBrowserSupported } from '../voice/browser-support.js';
import { getVoiceWidgetStyles, icons } from './styles.js';
import { escapeHtml, sanitizeHtml } from './rich-renderer.js';
import {
  WIDGET_CAPABILITY_ATTRIBUTES,
  WIDGET_CAPABILITY_ATTRIBUTE_NAMES,
  WIDGET_DISPLAY_ATTRIBUTE_NAMES,
  WIDGET_SDK_CONFIG_ATTRIBUTES,
  WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES,
  readWidgetSdkConfig,
} from './widget-sdk-config.js';
import { resolveElementWidgetCapabilityState } from './widget-capability-state.js';

// =============================================================================
// VOICE WIDGET
// =============================================================================

export class VoiceWidget extends HTMLElement {
  private sdk: AgentSDK | null = null;
  private initializingSdk: AgentSDK | null = null;
  private sdkInitialization: Promise<void> | null = null;
  private sdkGeneration = 0;
  private voice: VoiceClient | null = null;
  private shadow: ShadowRoot;
  private isInitialized = false;
  private currentState: VoiceState = 'idle';
  private currentTranscript = '';
  private lastResponse = '';

  // Companion panel state
  private lastThought: ThoughtEventData | null = null;
  private statusMessage: string | null = null;

  // DOM references
  private voiceBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private transcriptEl: HTMLElement | null = null;
  private muteBtn: HTMLButtonElement | null = null;

  static get observedAttributes(): string[] {
    return [
      ...WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES,
      ...WIDGET_CAPABILITY_ATTRIBUTE_NAMES,
      ...WIDGET_DISPLAY_ATTRIBUTE_NAMES,
      'position',
      'theme',
      'show-panel',
    ];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.setupEventListeners();
    if (this.resolveCapabilityState().effectiveMode === 'voice') {
      void this.ensureSDKInitialized();
    }
  }

  disconnectedCallback(): void {
    this.invalidateSdkState();
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (oldValue === newValue || !this.isInitialized) {
      return;
    }

    const shouldReconnect =
      WIDGET_SDK_CONFIG_ATTRIBUTES.has(name) || WIDGET_CAPABILITY_ATTRIBUTES.has(name);
    const reconnectNow = shouldReconnect && this.isConnected;

    if (shouldReconnect) {
      this.invalidateSdkState();
    }

    this.render();

    if (reconnectNow) {
      void this.ensureSDKInitialized();
    }
  }

  // ===========================================================================
  // RENDERING
  // ===========================================================================

  private render(): void {
    const capabilityState = this.resolveCapabilityState();
    const configErrorMessage =
      capabilityState.effectiveMode === 'voice' ? this.getConfigErrorMessage() : null;
    const position = (this.getAttribute('position') || 'bottom-right') as WidgetPosition;
    const theme = this.parseTheme();
    const styles = getVoiceWidgetStyles(theme, position);
    const showPanel =
      this.getAttribute('show-panel') === 'true' && this.shouldShowActivityUpdates();

    this.shadow.innerHTML = `
      <style>${styles}</style>

      <div class="voice-container">
        ${this.renderVoiceButton(capabilityState.effectiveMode === 'voice', configErrorMessage)}
        ${this.renderStatus(capabilityState.effectiveMode === 'voice', configErrorMessage)}
        ${this.renderTranscript()}
        ${this.renderControls()}
        ${showPanel ? this.renderCompanionPanel() : ''}
      </div>
    `;

    this.bindElements();
    this.isInitialized = true;
  }

  private renderCompanionPanel(): string {
    const statusMessageHtml = this.statusMessage ? escapeHtml(this.statusMessage) : null;
    const thoughtHtml = this.lastThought ? sanitizeHtml(this.lastThought.thought) : null;

    return `
      <div class="companion-panel">
        ${statusMessageHtml ? `<div class="status-message">${statusMessageHtml}</div>` : ''}
        ${thoughtHtml ? `<div class="thought-display">${thoughtHtml}</div>` : ''}
      </div>
    `;
  }

  private renderVoiceButton(isVoiceAvailable: boolean, configErrorMessage: string | null): string {
    const stateClass = this.currentState;
    const icon = this.currentState === 'idle' ? icons.phone : icons.phoneOff;
    const label = this.getStateLabel();
    const isDisabled = !isVoiceAvailable || !!configErrorMessage;

    return `
      <button
        class="voice-btn ${stateClass}"
        aria-label="${label}"
        ${isDisabled ? 'disabled' : ''}
      >
        ${icon}
      </button>
    `;
  }

  private renderStatus(isVoiceAvailable: boolean, configErrorMessage: string | null): string {
    if (configErrorMessage) {
      return `
        <div class="status-text" role="status">
          Voice widget is unavailable: ${configErrorMessage}
        </div>
      `;
    }

    if (!isVoiceAvailable) {
      return `
        <div class="status-text" role="status">
          Voice is not available for this widget in this browser.
        </div>
      `;
    }

    if (this.currentState === 'idle') {
      return '';
    }

    return `
      <div class="status-text" role="status">
        ${this.getStateLabel()}
      </div>
    `;
  }

  private renderTranscript(): string {
    const transcriptHtml = escapeHtml(this.currentTranscript);
    const responseHtml = escapeHtml(this.lastResponse);

    if (this.currentState === 'idle') {
      return '';
    }

    if (this.currentTranscript) {
      return `
        <div class="transcript user">
          "${transcriptHtml}"
        </div>
      `;
    }

    if (this.lastResponse) {
      return `
        <div class="transcript">
          "${responseHtml}"
        </div>
      `;
    }

    return '';
  }

  private renderControls(): string {
    if (this.currentState === 'idle') {
      return '';
    }

    const isMuted = this.voice?.getInfo().isMuted ?? false;
    const muteIcon = isMuted ? icons.micOff : icons.mic;
    const muteClass = isMuted ? 'muted' : '';

    return `
      <div class="controls">
        <button class="control-btn mute-btn ${muteClass}" aria-label="${isMuted ? 'Unmute' : 'Mute'}">
          ${muteIcon}
        </button>
      </div>
    `;
  }

  private bindElements(): void {
    this.voiceBtn = this.shadow.querySelector('.voice-btn');
    this.statusEl = this.shadow.querySelector('.status-text');
    this.transcriptEl = this.shadow.querySelector('.transcript');
    this.muteBtn = this.shadow.querySelector('.mute-btn');
  }

  private setupEventListeners(): void {
    this.shadow.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('.voice-btn')) {
        this.toggleVoice();
      } else if (target.closest('.mute-btn')) {
        this.toggleMute();
      }
    });
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Start voice interaction
   */
  async start(): Promise<void> {
    if (this.resolveCapabilityState().effectiveMode !== 'voice') {
      return;
    }

    if (this.getConfigErrorMessage()) {
      return;
    }

    if (!this.voice) {
      await this.ensureSDKInitialized();
    }
    if (!this.voice) return;

    try {
      await this.voice.start();
    } catch (error) {
      console.error('[VoiceWidget] Start error:', error);
    }
  }

  /**
   * Stop voice interaction
   */
  stop(): void {
    if (this.voice) {
      this.voice.stop();
    }
  }

  /**
   * Toggle voice on/off
   */
  async toggleVoice(): Promise<void> {
    if (this.currentState === 'idle') {
      await this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Toggle mute
   */
  toggleMute(): void {
    if (this.voice) {
      this.voice.toggleMute();
      this.render();
    }
  }

  /**
   * Check if voice is supported.
   * Requires getUserMedia + AudioContext. RTCPeerConnection is NOT required
   * since pipeline mode uses WebSocket audio transport.
   */
  static isSupported(): boolean {
    return isVoiceBrowserSupported();
  }

  /**
   * Get the underlying SDK instance
   */
  getSDK(): AgentSDK | null {
    return this.sdk;
  }

  // ===========================================================================
  // INTERNAL
  // ===========================================================================

  private async initializeSDK(): Promise<void> {
    const sdkGeneration = this.sdkGeneration;
    let sdkConfig;
    try {
      sdkConfig = readWidgetSdkConfig(this);
    } catch (error) {
      console.error('[VoiceWidget] Invalid SDK config:', error);
      this.render();
      return;
    }

    const candidateSdk = new AgentSDK(sdkConfig);
    this.initializingSdk = candidateSdk;

    try {
      await candidateSdk.connect();
      if (sdkGeneration !== this.sdkGeneration) {
        candidateSdk.disconnect();
        return;
      }
      const voiceClient = candidateSdk.voice();
      this.sdk = candidateSdk;
      this.voice = voiceClient;
      this.setupVoiceHandlers();
    } catch (error) {
      candidateSdk.disconnect();
      if (sdkGeneration !== this.sdkGeneration) {
        return;
      }
      this.sdk = null;
      this.voice = null;
      console.error('[VoiceWidget] SDK init error:', error);
    } finally {
      if (this.initializingSdk === candidateSdk) {
        this.initializingSdk = null;
      }
    }
  }

  private async ensureSDKInitialized(): Promise<void> {
    if (this.resolveCapabilityState().effectiveMode !== 'voice') {
      return;
    }

    if (this.getConfigErrorMessage()) {
      return;
    }

    if (this.sdk) {
      return;
    }

    if (this.sdkInitialization) {
      await this.sdkInitialization;
      return;
    }

    this.sdkInitialization = this.initializeSDK().finally(() => {
      this.sdkInitialization = null;
    });
    await this.sdkInitialization;
  }

  private invalidateSdkState(): void {
    this.sdkGeneration += 1;
    this.sdkInitialization = null;

    if (this.voice) {
      this.voice.stop();
    }

    if (this.initializingSdk) {
      this.initializingSdk.disconnect();
      this.initializingSdk = null;
    }

    if (this.sdk) {
      this.sdk.disconnect();
      this.sdk = null;
    }

    this.voice = null;
    this.currentState = 'idle';
    this.currentTranscript = '';
    this.lastResponse = '';
    this.lastThought = null;
    this.statusMessage = null;
  }

  private setupVoiceHandlers(): void {
    if (!this.voice) return;

    this.voice.on('stateChange', ({ state }) => {
      this.currentState = state;
      this.render();
    });

    this.voice.on('transcription', ({ text }) => {
      this.currentTranscript = text;
      this.render();
    });

    this.voice.on('transcriptionFinal', ({ text }) => {
      this.currentTranscript = text;
      this.render();
    });

    this.voice.on('responseStart', () => {
      this.currentTranscript = '';
      this.render();
    });

    this.voice.on('responseEnd', ({ text }) => {
      this.lastResponse = text;
      this.render();
    });

    this.voice.on('error', ({ error }) => {
      console.error('[VoiceWidget] Voice error:', error);
      this.currentState = 'error';
      this.render();
    });

    this.voice.on('micPermissionDenied', () => {
      console.error('[VoiceWidget] Microphone permission denied');
      this.currentState = 'error';
      this.render();
    });

    this.voice.on('thought', (thought) => {
      this.lastThought = thought;
      this.render();
    });

    this.voice.on('statusUpdate', ({ text }) => {
      this.statusMessage = text;
      this.render();
    });

    this.voice.on('statusClear', () => {
      this.statusMessage = null;
      this.render();
    });

    this.voice.on('bargeIn', () => {
      this.currentState = 'listening';
      this.render();
    });

    this.voice.on('vadAvailable', ({ available }) => {
      if (!available) {
        console.warn('[VoiceWidget] VAD not available — using manual push-to-talk mode');
      }
    });
  }

  private getConfigErrorMessage(): string | null {
    try {
      readWidgetSdkConfig(this);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private getStateLabel(): string {
    switch (this.currentState) {
      case 'idle':
        return 'Start voice';
      case 'connecting':
        return 'Connecting...';
      case 'ready':
        return 'Listening...';
      case 'listening':
        return 'Listening...';
      case 'processing':
        return 'Processing...';
      case 'speaking':
        return 'Speaking...';
      case 'error':
        return 'Error occurred';
      default:
        return '';
    }
  }

  private parseTheme(): WidgetTheme {
    const themeAttr = this.getAttribute('theme');
    if (themeAttr) {
      try {
        return JSON.parse(themeAttr);
      } catch {
        console.warn('[VoiceWidget] Invalid theme attribute, using default');
      }
    }
    return {};
  }

  private shouldShowActivityUpdates(): boolean {
    return this.sdk?.getSessionScope()?.showActivityUpdates === true;
  }

  private resolveCapabilityState() {
    return resolveElementWidgetCapabilityState(this, 'voice');
  }
}

// Register custom element
if (typeof customElements !== 'undefined' && !customElements.get('agent-voice')) {
  customElements.define('agent-voice', VoiceWidget);
}

export { VoiceWidget as default };
