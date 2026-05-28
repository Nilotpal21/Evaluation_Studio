/**
 * UnifiedWidget - Web Component for combined chat + voice interface
 *
 * Usage:
 * <agent-widget
 *   project-id="xxx"
 *   api-key="pk_xxx"
 *   endpoint="https://runtime.example.com"
 *   mode="unified"
 * ></agent-widget>
 */

import { AgentSDK } from '../core/AgentSDK.js';
import type { ChatClient } from '../chat/ChatClient.js';
import type { VoiceClient } from '../voice/VoiceClient.js';
import type {
  Message,
  VoiceState,
  WidgetTheme,
  WidgetPosition,
  WidgetMode,
  ThoughtEventData,
  LiveSessionDiscoveryResult,
  SourceChannel,
} from '../core/types.js';
import { getUnifiedWidgetStyles, icons } from './styles.js';
import {
  escapeHtml,
  hasRichContent,
  renderMarkdown,
  renderRichMessage,
  sanitizeHtml,
} from './rich-renderer.js';
import { createActionHandler } from './action-handler.js';
import { isActivityMessage } from './activity-messages.js';
import {
  appendMessageFeedbackControls,
  isMessageFeedbackEnabled,
  shouldRenderMessageFeedback,
} from './message-feedback-controls.js';
import {
  WIDGET_DISPLAY_ATTRIBUTE_NAMES,
  readWidgetSdkConfig,
  WIDGET_CAPABILITY_ATTRIBUTE_NAMES,
  WIDGET_SDK_CONFIG_ATTRIBUTES,
  WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES,
} from './widget-sdk-config.js';
import { resolveSdkWidgetCapabilityState } from '../internal/sdk-widget-capabilities.js';
import { resolveElementWidgetCapabilityState } from './widget-capability-state.js';

export class UnifiedWidget extends HTMLElement {
  private sdk: AgentSDK | null = null;
  private initializingSdk: AgentSDK | null = null;
  private sdkInitialization: Promise<void> | null = null;
  private sdkGeneration = 0;
  private sdkLifecycleDisposers: Array<() => void> = [];
  private chatHandlerDisposers: Array<() => void> = [];
  private chat: ChatClient | null = null;
  private voice: VoiceClient | null = null;
  private shadow: ShadowRoot;
  private isMinimized = true;
  private isInitialized = false;
  private eventListenersBound = false;
  private currentMode: 'chat' | 'voice' = 'chat';
  private voiceState: VoiceState = 'idle';
  private currentTranscript = '';

  // Companion panel state (for unified voice mode)
  private lastThought: ThoughtEventData | null = null;
  private statusMessage: string | null = null;

  // Live session state
  private discoveredSession: LiveSessionDiscoveryResult | null = null;
  private isInLiveSession = false;
  private isJoiningLiveSession = false;
  private liveSyncUnsubscribe: (() => void) | null = null;

  // DOM references
  private container: HTMLElement | null = null;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;

  static get observedAttributes(): string[] {
    return [
      ...WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES,
      ...WIDGET_CAPABILITY_ATTRIBUTE_NAMES,
      ...WIDGET_DISPLAY_ATTRIBUTE_NAMES,
      'position',
      'theme',
      'mode',
      'welcome-message',
      'placeholder',
      'enable-feedback',
    ];
  }

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.reconcileModeWithCapabilities();
    this.render();
    this.setupEventListeners();
  }

  disconnectedCallback(): void {
    this.invalidateSdkState();
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (oldValue === newValue || !this.isInitialized) {
      return;
    }

    const shouldReconnect = WIDGET_SDK_CONFIG_ATTRIBUTES.has(name);
    const reconnectNow = shouldReconnect && !this.isMinimized && this.isConnected;

    if (shouldReconnect) {
      this.invalidateSdkState();
    }

    this.render();

    if (reconnectNow) {
      void (async () => {
        await this.ensureSDKInitialized();
        await this.refreshLiveSessionDiscovery();
      })();
    }
  }

  private render(): void {
    const capabilityState = this.reconcileModeWithCapabilities();
    const position = (this.getAttribute('position') || 'bottom-right') as WidgetPosition;
    const theme = this.parseTheme();
    const welcomeMessageAttr = this.getAttribute('welcome-message');
    const welcomeMessage =
      welcomeMessageAttr === null ? 'Hello! How can I help you today?' : welcomeMessageAttr;
    const placeholder = this.getAttribute('placeholder') || 'Type a message...';
    const safeWelcomeMessage = welcomeMessage ? sanitizeHtml(welcomeMessage) : '';
    const safePlaceholder = escapeHtml(placeholder);
    const showBranding = this.getAttribute('show-branding') !== 'false';
    const modeAttr = this.getAttribute('mode') as WidgetMode;

    const styles = getUnifiedWidgetStyles(theme, position);

    this.shadow.innerHTML = `
      <style>${styles}</style>
      ${
        this.isMinimized
          ? this.renderLauncher()
          : this.renderWidget(
              safeWelcomeMessage,
              safePlaceholder,
              showBranding,
              modeAttr,
              capabilityState,
            )
      }
    `;

    this.bindElements();
    if (
      !this.isMinimized &&
      capabilityState.effectiveMode &&
      (capabilityState.effectiveMode === 'chat' || (modeAttr === 'unified' && this.isInLiveSession))
    ) {
      this.restoreRenderedMessages();
    }
    this.isInitialized = true;
  }

  private renderLauncher(): string {
    return `
      <button class="launcher" aria-label="Open assistant">
        ${icons.chat}
      </button>
    `;
  }

  private renderWidget(
    welcomeMessageHtml: string,
    placeholderText: string,
    showBranding: boolean,
    mode: WidgetMode,
    capabilityState: ReturnType<typeof resolveSdkWidgetCapabilityState>,
  ): string {
    const effectiveMode = capabilityState.effectiveMode;
    const isLiveMode = mode === 'unified' && this.isInLiveSession;

    if (!effectiveMode) {
      return `
        <div class="widget-container">
          <div class="header">
            <span class="header-title">Agent Assistant</span>
            <div class="header-actions">
              <button class="header-btn minimize-btn" aria-label="Minimize">
                ${icons.minimize}
              </button>
            </div>
          </div>

          <div class="messages" role="status" aria-live="polite">
            <div class="message system">
              This widget is not configured for a supported chat or voice mode in this browser.
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="widget-container">
        <div class="header">
          <span class="header-title">Agent Assistant</span>
          ${isLiveMode ? '<span class="live-badge">LIVE</span>' : ''}
          <div class="header-actions">
            <button class="header-btn minimize-btn" aria-label="Minimize">
              ${icons.minimize}
            </button>
          </div>
        </div>

        ${this.discoveredSession && !this.isInLiveSession ? this.renderJoinPrompt() : ''}

        ${capabilityState.showModeToggle && !this.isInLiveSession ? this.renderModeToggle() : ''}

        ${
          isLiveMode
            ? this.renderLiveSessionLayout(welcomeMessageHtml, placeholderText)
            : effectiveMode === 'chat'
              ? this.renderChatPanel(welcomeMessageHtml, placeholderText)
              : this.renderVoicePanel()
        }

        ${
          showBranding
            ? `
          <div class="branding">
            Powered by <a href="https://agentplatform.com" target="_blank" rel="noopener">Agent Platform</a>
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  private renderModeToggle(): string {
    return `
      <div class="mode-toggle">
        <button class="mode-btn ${this.currentMode === 'chat' ? 'active' : ''}" data-mode="chat">
          ${icons.chat} Chat
        </button>
        <button class="mode-btn ${this.currentMode === 'voice' ? 'active' : ''}" data-mode="voice">
          ${icons.mic} Voice
        </button>
      </div>
    `;
  }

  private renderChatPanel(welcomeMessageHtml: string, placeholderText: string): string {
    const isComposerReady = this.isChatComposerReady();
    const welcomePlaceholder = welcomeMessageHtml
      ? `<div class="message assistant welcome-placeholder">${welcomeMessageHtml}</div>`
      : '';
    return `
      <div class="messages" role="log" aria-live="polite">
        ${welcomePlaceholder}
      </div>

      <div class="input-area">
        <textarea
          class="input-field"
          placeholder="${placeholderText}"
          aria-label="Type a message"
          rows="1"
          ${isComposerReady ? '' : 'disabled'}
        ></textarea>
        <button class="send-btn" aria-label="Send message" disabled>
          ${icons.send}
        </button>
      </div>
    `;
  }

  private renderVoicePanel(): string {
    const stateClass = this.voiceState;
    const icon = this.voiceState === 'idle' ? icons.phone : icons.phoneOff;
    const label = this.getVoiceStateLabel();
    const isMuted = this.voice?.getInfo().isMuted ?? false;
    const modeAttr = this.getAttribute('mode') as WidgetMode;
    const showContentPanel = modeAttr === 'unified' && this.shouldShowActivityUpdates();
    const transcriptHtml = escapeHtml(this.currentTranscript);

    return `
      <div class="voice-panel">
        <button class="voice-btn ${stateClass}" aria-label="${label}">
          ${icon}
        </button>

        <div class="status-text">${label}</div>

        ${
          this.currentTranscript
            ? `
          <div class="transcript user">"${transcriptHtml}"</div>
        `
            : ''
        }

        ${
          this.voiceState !== 'idle'
            ? `
          <div class="controls">
            <button class="control-btn mute-btn ${isMuted ? 'muted' : ''}" aria-label="${isMuted ? 'Unmute' : 'Mute'}">
              ${isMuted ? icons.micOff : icons.mic}
            </button>
          </div>
        `
            : ''
        }
      </div>

      ${showContentPanel ? this.renderContentPanel() : ''}
    `;
  }

  private renderContentPanel(): string {
    const statusMessageHtml = this.statusMessage ? escapeHtml(this.statusMessage) : null;
    const thoughtHtml = this.lastThought ? sanitizeHtml(this.lastThought.thought) : null;

    return `
      <div class="content-panel">
        ${statusMessageHtml ? `<div class="status-message">${statusMessageHtml}</div>` : ''}
        ${thoughtHtml ? `<div class="thought-display">${thoughtHtml}</div>` : ''}
      </div>
    `;
  }

  private renderJoinPrompt(): string {
    if (!this.discoveredSession) return '';

    const participantCount = this.discoveredSession.participants.length;
    return `
      <div class="join-prompt">
        <div class="join-prompt-text">
          A live session is available${participantCount > 0 ? ` with ${participantCount} participant${participantCount > 1 ? 's' : ''}` : ''}.
        </div>
        <button class="join-btn" aria-label="Join live session" ${this.isJoiningLiveSession ? 'disabled' : ''}>
          ${this.isJoiningLiveSession ? 'Joining...' : 'Join Session'}
        </button>
        <button class="dismiss-join-btn" aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    `;
  }

  private renderLiveSessionLayout(welcomeMessageHtml: string, placeholderText: string): string {
    const stateClass = this.voiceState;
    const icon = this.voiceState === 'idle' ? icons.phone : icons.phoneOff;
    const label = this.getVoiceStateLabel();
    const isMuted = this.voice?.getInfo().isMuted ?? false;
    const transcriptHtml = escapeHtml(this.currentTranscript);
    const welcomePlaceholder = welcomeMessageHtml
      ? `<div class="message assistant welcome-placeholder">${welcomeMessageHtml}</div>`
      : '';

    return `
      <div class="live-session-layout">
        <div class="voice-controls-bar">
          <button class="voice-btn-compact ${stateClass}" aria-label="${label}">
            ${icon}
          </button>
          <div class="voice-status-compact">${label}</div>
          ${
            this.voiceState !== 'idle'
              ? `
            <button class="control-btn mute-btn-compact ${isMuted ? 'muted' : ''}" aria-label="${isMuted ? 'Unmute' : 'Mute'}">
              ${isMuted ? icons.micOff : icons.mic}
            </button>
          `
              : ''
          }
        </div>

        ${
          this.currentTranscript
            ? `
          <div class="live-transcript-preview">"${transcriptHtml}"</div>
        `
            : ''
        }

        <div class="messages" role="log" aria-live="polite">
          ${welcomePlaceholder}
        </div>

        <div class="input-area">
          <textarea
            class="input-field"
            placeholder="${placeholderText}"
            aria-label="Type a message"
            rows="1"
          ></textarea>
          <button class="send-btn" aria-label="Send message" disabled>
            ${icons.send}
          </button>
        </div>
      </div>
    `;
  }

  private getSourceChannelBadge(sourceChannel?: SourceChannel): string {
    if (!sourceChannel || !this.isInLiveSession) return '';

    const badgeClass = `channel-badge channel-badge-${sourceChannel}`;
    const icon = sourceChannel === 'voice' ? icons.mic : icons.chat;
    return `<span class="${badgeClass}">${icon} ${sourceChannel}</span>`;
  }

  private bindElements(): void {
    this.container = this.shadow.querySelector('.widget-container');
    this.messagesEl = this.shadow.querySelector('.messages');
    this.inputEl = this.shadow.querySelector('.input-field');
    this.sendBtn = this.shadow.querySelector('.send-btn');
    this.updateSendButton();
  }

  private restoreRenderedMessages(): void {
    const getMessages = this.chat?.getMessages;
    const messages = typeof getMessages === 'function' ? getMessages.call(this.chat) : [];
    if (messages.length === 0) {
      return;
    }

    for (const message of messages) {
      this.addMessage(message);
    }
  }

  private setupEventListeners(): void {
    if (this.eventListenersBound) {
      return;
    }
    this.eventListenersBound = true;

    this.shadow.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('.launcher')) {
        this.open();
      } else if (target.closest('.minimize-btn')) {
        this.minimize();
      } else if (target.closest('.send-btn')) {
        this.handleSendAction();
      } else if (target.closest('.mode-btn')) {
        const mode = (target.closest('.mode-btn') as HTMLElement).dataset.mode as 'chat' | 'voice';
        this.setMode(mode);
      } else if (target.closest('.voice-btn') || target.closest('.voice-btn-compact')) {
        this.toggleVoice();
      } else if (target.closest('.mute-btn') || target.closest('.mute-btn-compact')) {
        this.toggleMute();
      } else if (target.closest('.join-btn')) {
        this.joinDiscoveredSession();
      } else if (target.closest('.dismiss-join-btn')) {
        this.discoveredSession = null;
        this.render();
      }
    });

    this.shadow.addEventListener('input', (e) => {
      const target = e.target as HTMLTextAreaElement;
      if (target.classList.contains('input-field')) {
        this.updateSendButton();
      }
    });

    this.shadow.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const keyEvent = e as KeyboardEvent;
      if (
        target.classList.contains('input-field') &&
        keyEvent.key === 'Enter' &&
        !keyEvent.shiftKey
      ) {
        e.preventDefault();
        this.handleSendAction();
      }
    });
  }

  // Public API
  async open(): Promise<void> {
    this.isMinimized = false;
    this.render();

    if (!this.reconcileModeWithCapabilities().effectiveMode) {
      return;
    }

    await this.ensureSDKInitialized();
    await this.refreshLiveSessionDiscovery();
  }

  minimize(): void {
    if (this.voice && this.voiceState !== 'idle') {
      this.voice.stop();
    }
    this.isMinimized = true;
    this.render();
  }

  toggle(): void {
    if (this.isMinimized) {
      this.open();
    } else {
      this.minimize();
    }
  }

  setMode(mode: 'chat' | 'voice'): void {
    const capabilityState = this.reconcileModeWithCapabilities();
    if (!capabilityState.allowedModes.includes(mode)) {
      return;
    }

    if (this.currentMode !== mode) {
      if (this.currentMode === 'voice' && this.voice && this.voiceState !== 'idle') {
        this.voice.stop();
      }
      this.currentMode = mode;
      this.render();
    }
  }

  getSDK(): AgentSDK | null {
    return this.sdk;
  }

  async refreshLiveSessionDiscovery(): Promise<LiveSessionDiscoveryResult | null> {
    const configuredMode = (this.getAttribute('mode') as WidgetMode) || 'unified';
    if (configuredMode !== 'unified' || this.isInLiveSession) {
      return this.discoveredSession;
    }

    const sdk = this.sdk;
    const activeLiveSessionId = sdk?.getActiveLiveSessionId?.();
    if (!sdk || !sdk.isConnected() || activeLiveSessionId) {
      return null;
    }

    const discoverLiveSession = sdk.discoverLiveSession?.bind(sdk);
    if (!discoverLiveSession) {
      return null;
    }

    try {
      const discovery = await discoverLiveSession();
      if (sdk !== this.sdk || this.isInLiveSession) {
        return discovery;
      }

      this.discoveredSession = discovery;
      this.render();
      return discovery;
    } catch {
      if (sdk === this.sdk) {
        this.discoveredSession = null;
        this.render();
      }
      return null;
    }
  }

  // Internal methods
  private async initializeSDK(): Promise<void> {
    const sdkGeneration = this.sdkGeneration;
    let sdkConfig;
    try {
      sdkConfig = readWidgetSdkConfig(this);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
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
      const chatClient = candidateSdk.chat();
      const voiceClient = candidateSdk.voice();

      this.sdk = candidateSdk;
      this.chat = chatClient;
      this.voice = voiceClient;

      this.bindSdkLifecycle(candidateSdk);
      this.setupChatHandlers();
      this.setupVoiceHandlers();
      this.updateSendButton();
    } catch (error) {
      candidateSdk.disconnect();
      if (sdkGeneration !== this.sdkGeneration) {
        return;
      }
      this.sdk = null;
      this.chat = null;
      this.voice = null;
      this.showError(
        'Failed to connect: ' + (error instanceof Error ? error.message : String(error)),
      );
      this.updateSendButton();
    } finally {
      if (this.initializingSdk === candidateSdk) {
        this.initializingSdk = null;
      }
    }
  }

  private async ensureSDKInitialized(): Promise<void> {
    if (!this.reconcileModeWithCapabilities().effectiveMode) {
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
    this.clearSdkLifecycle();
    this.clearChatHandlers();
    this.clearTypingIndicator();
    this.clearStatusIndicator();

    if (this.liveSyncUnsubscribe) {
      this.liveSyncUnsubscribe();
      this.liveSyncUnsubscribe = null;
    }

    if (this.voice) {
      if (typeof this.voice.disableLiveSync === 'function') {
        this.voice.disableLiveSync();
      }
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

    this.chat = null;
    this.voice = null;
    this.voiceState = 'idle';
    this.currentTranscript = '';
    this.lastThought = null;
    this.statusMessage = null;
    this.discoveredSession = null;
    this.isInLiveSession = false;
    this.isJoiningLiveSession = false;
  }

  private reconcileModeWithCapabilities(): ReturnType<typeof resolveSdkWidgetCapabilityState> {
    const modeAttr = this.getAttribute('mode') as WidgetMode;
    const configuredMode =
      modeAttr === 'chat' || modeAttr === 'voice' ? modeAttr : ('unified' as const);
    const nextState = resolveElementWidgetCapabilityState(this, configuredMode, this.currentMode);

    if (this.currentMode === 'voice' && nextState.effectiveMode !== 'voice' && this.voice) {
      this.voice.stop();
    }

    if (nextState.effectiveMode) {
      this.currentMode = nextState.effectiveMode;
    }

    return nextState;
  }

  private isChatComposerReady(): boolean {
    return this.sdk?.isConnected() === true;
  }

  private bindSdkLifecycle(sdk: AgentSDK): void {
    this.clearSdkLifecycle();
    this.sdkLifecycleDisposers = [
      sdk.on('connected', () => {
        this.updateSendButton();
      }),
      sdk.on('disconnected', () => {
        this.clearTypingIndicator();
        this.clearStatusIndicator();
        this.updateSendButton();
      }),
      sdk.on('sessionEnd', () => {
        this.clearTypingIndicator();
        this.clearStatusIndicator();
        this.updateSendButton();
      }),
    ];
  }

  private clearSdkLifecycle(): void {
    for (const dispose of this.sdkLifecycleDisposers) {
      dispose();
    }
    this.sdkLifecycleDisposers = [];
  }

  private setupChatHandlers(): void {
    if (!this.chat) return;
    this.clearChatHandlers();

    const addDisposer = (dispose: unknown) => {
      if (typeof dispose === 'function') {
        this.chatHandlerDisposers.push(dispose as () => void);
      }
    };

    addDisposer(
      this.chat.on('message', (message) => {
        this.addMessage(message);
      }),
    );
    addDisposer(
      this.chat.on('messagesReplaced', () => {
        this.render();
      }),
    );
    addDisposer(
      this.chat.on('messageChunk', ({ messageId, chunk }) => {
        this.appendToLastMessage(messageId, chunk);
      }),
    );
    addDisposer(
      this.chat.on('typing', ({ isTyping }) => {
        this.setTypingIndicator(isTyping);
      }),
    );
    addDisposer(
      this.chat.on('statusUpdate', ({ text }) => {
        this.setStatusIndicator(text);
      }),
    );
    addDisposer(
      this.chat.on('statusClear', () => {
        this.setStatusIndicator(null);
      }),
    );
    addDisposer(
      this.chat.on('error', ({ error }) => {
        this.showError(error.message);
      }),
    );
  }

  private clearChatHandlers(): void {
    for (const dispose of this.chatHandlerDisposers) {
      dispose();
    }
    this.chatHandlerDisposers = [];
  }

  private setupVoiceHandlers(): void {
    if (!this.voice) return;

    this.voice.on('stateChange', ({ state, previousState }) => {
      this.voiceState = state;

      if (state === 'idle' && previousState !== 'idle' && this.isInLiveSession) {
        this.render();
        return;
      }

      if (this.currentMode === 'voice' || this.isInLiveSession) {
        this.render();
      }
    });

    this.voice.on('transcription', ({ text }) => {
      this.currentTranscript = text;
      if (this.currentMode === 'voice' || this.isInLiveSession) {
        this.render();
      }
    });

    this.voice.on('thought', (thought) => {
      this.lastThought = thought;
      if (this.currentMode === 'voice') {
        this.render();
      }
    });

    this.voice.on('statusUpdate', ({ text }) => {
      this.statusMessage = text;
      if (this.currentMode === 'voice') {
        this.render();
      }
    });

    this.voice.on('statusClear', () => {
      this.statusMessage = null;
      if (this.currentMode === 'voice') {
        this.render();
      }
    });

    this.voice.on('responseEnd', ({ text }) => {
      const lastMsg = this.voice?.getLastThought();
      if (lastMsg) {
        this.lastThought = null;
      }
      this.statusMessage = null;
      if (this.currentMode === 'voice') {
        this.render();
      }
    });

    this.voice.on('error', ({ error }) => {
      console.error('[UnifiedWidget] Voice error:', error);
    });
  }

  /**
   * Route the send action to the appropriate method based on the current mode.
   */
  private handleSendAction(): void {
    if (this.isInLiveSession && this.voiceState !== 'idle') {
      this.sendTypedInterrupt();
    } else {
      this.sendMessage();
    }
  }

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || !this.chat) return;

    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this.updateSendButton();

    try {
      await this.chat.send(text);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private sendTypedInterrupt(): void {
    if (!this.inputEl || !this.chat) return;

    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this.updateSendButton();

    try {
      this.chat.sendTypedInterrupt(text);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private async joinDiscoveredSession(): Promise<void> {
    if (
      !this.discoveredSession ||
      !this.sdk ||
      !this.chat ||
      this.isInLiveSession ||
      this.isJoiningLiveSession
    ) {
      return;
    }

    this.isJoiningLiveSession = true;
    this.render();
    try {
      const result = await this.sdk.joinLiveSession(this.discoveredSession.sessionId);

      if (result.success) {
        this.chat.hydrateBackfill(result.backfill);

        if (this.liveSyncUnsubscribe) {
          this.liveSyncUnsubscribe();
        }
        this.liveSyncUnsubscribe = this.chat.subscribeLiveTranscript();

        if (this.voice) {
          this.voice.enableLiveSync((item) => {
            this.sdk?.getSessionManager().publishTranscriptItem(item);
          });
        }

        this.isInLiveSession = true;
        this.discoveredSession = null;
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.isJoiningLiveSession = false;
      this.render();
    }
  }

  private async toggleVoice(): Promise<void> {
    if (!this.voice) return;

    if (this.voiceState === 'idle') {
      try {
        await this.voice.start();
      } catch (error) {
        console.error('[UnifiedWidget] Voice start error:', error);
      }
    } else {
      this.voice.stop();
    }
  }

  private toggleMute(): void {
    if (this.voice) {
      this.voice.toggleMute();
      this.render();
    }
  }

  private addMessage(message: Message): void {
    if (!this.messagesEl) return;
    if (!this.shouldShowActivityUpdates() && isActivityMessage(message)) {
      return;
    }

    this.clearWelcomePlaceholder();

    this.clearTypingIndicator();
    this.clearStatusIndicator();

    // Remove the matching streaming element — the final assistant message replaces it
    const streamingEl = this.messagesEl.querySelector(
      `.message.streaming[data-id="${message.id}"]`,
    );
    if (streamingEl) {
      streamingEl.remove();
    }

    const messageEl = document.createElement('div');
    messageEl.setAttribute('data-id', message.id);

    if (message.role === 'assistant' && hasRichContent(message)) {
      messageEl.className = `message ${message.role} rich`;
      const renderId = message.actions?.renderId;
      const chat = this.chat;
      renderRichMessage(messageEl, message, {
        onAction: createActionHandler(chat),
        // ABLP-1068: see ChatWidget for the same closure pattern.
        submitFeedback: (input) =>
          chat
            ? chat.submitFeedback({
                messageId: message.id,
                ...input,
                ...(renderId ? { actionRenderId: renderId } : {}),
              })
            : Promise.reject(
                Object.assign(new Error('Chat client not initialized'), {
                  code: 'NOT_CONNECTED',
                }),
              ),
      });
    } else if (message.role === 'assistant' && message.content) {
      // ABLP-1189: parity with ChatWidget — render markdown so links, lists,
      // and paragraph breaks aren't dropped to raw text.
      messageEl.className = `message ${message.role}`;
      messageEl.innerHTML = sanitizeHtml(renderMarkdown(message.content));
    } else {
      messageEl.className = 'message ' + message.role;
      messageEl.textContent = message.content;
    }

    const badge = this.getSourceChannelBadge(message.sourceChannel);
    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.innerHTML = badge;
      messageEl.prepend(badgeEl.firstElementChild as Element);
    }

    if (isMessageFeedbackEnabled(this) && shouldRenderMessageFeedback(message)) {
      appendMessageFeedbackControls(messageEl, message, this.chat);
    }

    this.messagesEl.appendChild(messageEl);
    this.scrollToBottom();
  }

  private appendToLastMessage(messageId: string, chunk: string): void {
    if (!this.messagesEl) return;

    this.clearWelcomePlaceholder();
    this.clearStatusIndicator();

    let streamingEl = this.messagesEl.querySelector(
      `.message.streaming[data-id="${messageId}"]`,
    ) as HTMLElement | null;

    if (!streamingEl) {
      streamingEl = document.createElement('div');
      streamingEl.className = 'message assistant streaming';
      streamingEl.setAttribute('data-id', messageId);
      this.messagesEl.appendChild(streamingEl);
    }

    // ABLP-1189: accumulate raw chunks and re-render markdown each tick so
    // the streaming bubble shows formatted output, matching ChatWidget.
    const accumulated = (streamingEl.dataset.raw ?? '') + chunk;
    streamingEl.dataset.raw = accumulated;
    streamingEl.innerHTML = sanitizeHtml(renderMarkdown(accumulated));
    this.scrollToBottom();
  }

  private setTypingIndicator(isTyping: boolean): void {
    if (!this.messagesEl) return;

    this.clearTypingIndicator();

    if (isTyping) {
      this.clearStatusIndicator();
      const indicator = document.createElement('div');
      indicator.className = 'typing-indicator';
      indicator.innerHTML = `
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      `;
      this.messagesEl.appendChild(indicator);
      this.scrollToBottom();
    }
  }

  private setStatusIndicator(text: string | null): void {
    if (!this.messagesEl) return;

    this.clearStatusIndicator();

    if (text) {
      this.clearWelcomePlaceholder();
      this.clearTypingIndicator();
      const indicator = document.createElement('div');
      indicator.className = 'status-indicator';
      indicator.textContent = text;
      this.messagesEl.appendChild(indicator);
      this.scrollToBottom();
    }
  }

  private clearTypingIndicator(): void {
    if (!this.messagesEl) return;

    this.messagesEl.querySelector('.typing-indicator')?.remove();
  }

  private clearStatusIndicator(): void {
    if (!this.messagesEl) return;

    this.messagesEl.querySelector('.status-indicator')?.remove();
  }

  private showError(message: string): void {
    console.error('[UnifiedWidget]', message);

    if (this.messagesEl) {
      this.clearWelcomePlaceholder();
      this.clearStatusIndicator();
      const errorEl = document.createElement('div');
      errorEl.className = 'message system';
      errorEl.style.color = '#ef4444';
      errorEl.textContent = message;
      this.messagesEl.appendChild(errorEl);
      this.scrollToBottom();
    }
  }

  private syncComposerHeight(): void {
    if (!this.inputEl) {
      return;
    }

    this.inputEl.style.height = 'auto';
    const nextHeight = Math.min(Math.max(this.inputEl.scrollHeight, 44), 120);
    this.inputEl.style.height = `${nextHeight}px`;
    this.inputEl.style.overflowY = this.inputEl.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  private updateSendButton(): void {
    if (this.sendBtn && this.inputEl) {
      this.syncComposerHeight();
      const isComposerReady = this.isChatComposerReady();
      this.inputEl.disabled = !isComposerReady;
      this.sendBtn.disabled = !isComposerReady || !this.inputEl.value.trim();
    }
  }

  private clearWelcomePlaceholder(): void {
    if (!this.messagesEl) {
      return;
    }

    for (const placeholder of this.messagesEl.querySelectorAll('.welcome-placeholder')) {
      placeholder.remove();
    }
  }

  private scrollToBottom(): void {
    if (this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  private getVoiceStateLabel(): string {
    switch (this.voiceState) {
      case 'idle':
        return 'Tap to start voice';
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
        console.warn('[UnifiedWidget] Invalid theme attribute, using default');
      }
    }
    return {};
  }

  private shouldShowActivityUpdates(): boolean {
    return this.sdk?.getSessionScope()?.showActivityUpdates === true;
  }
}

// Register custom element
if (typeof customElements !== 'undefined' && !customElements.get('agent-widget')) {
  customElements.define('agent-widget', UnifiedWidget);
}

export { UnifiedWidget as default };
