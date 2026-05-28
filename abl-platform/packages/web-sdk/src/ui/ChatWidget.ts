/**
 * ChatWidget - Web Component for chat interface
 *
 * Usage:
 * <agent-chat
 *   project-id="xxx"
 *   api-key="pk_xxx"
 *   endpoint="https://runtime.example.com"
 *   position="bottom-right"
 * ></agent-chat>
 */

import { AgentSDK } from '../core/AgentSDK.js';
import type { ChatClient } from '../chat/ChatClient.js';
import type { Message, WidgetTheme, WidgetPosition } from '../core/types.js';
import { getChatWidgetStyles, icons } from './styles.js';
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
  WIDGET_CAPABILITY_ATTRIBUTES,
  WIDGET_CAPABILITY_ATTRIBUTE_NAMES,
  WIDGET_SDK_CONFIG_ATTRIBUTES,
  WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES,
} from './widget-sdk-config.js';
import { resolveElementWidgetCapabilityState } from './widget-capability-state.js';

// =============================================================================
// CHAT WIDGET
// =============================================================================

export class ChatWidget extends HTMLElement {
  private sdk: AgentSDK | null = null;
  private initializingSdk: AgentSDK | null = null;
  private sdkInitialization: Promise<void> | null = null;
  private sdkGeneration = 0;
  private sdkLifecycleDisposers: Array<() => void> = [];
  private chatHandlerDisposers: Array<() => void> = [];
  private chat: ChatClient | null = null;
  private shadow: ShadowRoot;
  private isMinimized = true;
  private isInitialized = false;
  private eventListenersBound = false;

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

    const shouldReconnect =
      WIDGET_SDK_CONFIG_ATTRIBUTES.has(name) || WIDGET_CAPABILITY_ATTRIBUTES.has(name);
    const reconnectNow = shouldReconnect && !this.isMinimized && this.isConnected;

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
    const position = (this.getAttribute('position') || 'bottom-right') as WidgetPosition;
    const theme = this.parseTheme();
    const welcomeMessageAttr = this.getAttribute('welcome-message');
    const welcomeMessage =
      welcomeMessageAttr === null ? 'Hello! How can I help you today?' : welcomeMessageAttr;
    const placeholder = this.getAttribute('placeholder') || 'Type a message...';
    const safeWelcomeMessage = welcomeMessage ? sanitizeHtml(welcomeMessage) : '';
    const safePlaceholder = escapeHtml(placeholder);
    const showBranding = this.getAttribute('show-branding') !== 'false';
    const styles = getChatWidgetStyles(theme, position);

    this.shadow.innerHTML = `
      <style>${styles}</style>

      ${
        this.isMinimized
          ? this.renderLauncher()
          : capabilityState.effectiveMode === 'chat'
            ? this.renderWidget(safeWelcomeMessage, safePlaceholder, showBranding)
            : this.renderUnavailableState()
      }
    `;

    this.bindElements();
    if (!this.isMinimized && capabilityState.effectiveMode === 'chat') {
      this.restoreRenderedMessages();
    }
    this.isInitialized = true;
  }

  private renderLauncher(): string {
    return `
      <button class="launcher" aria-label="Open chat">
        ${icons.chat}
      </button>
    `;
  }

  private renderWidget(
    welcomeMessageHtml: string,
    placeholderText: string,
    showBranding: boolean,
  ): string {
    const isComposerReady = this.isComposerReady();
    const welcomePlaceholder = welcomeMessageHtml
      ? `<div class="message assistant welcome-placeholder">${welcomeMessageHtml}</div>`
      : '';
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

  private renderUnavailableState(): string {
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
            This widget is not configured for chat in this browser.
          </div>
        </div>
      </div>
    `;
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

    // Launcher click
    this.shadow.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target.closest('.launcher')) {
        this.open();
      } else if (target.closest('.minimize-btn')) {
        this.minimize();
      } else if (target.closest('.send-btn')) {
        this.sendMessage();
      }
    });

    // Input events
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
        this.sendMessage();
      }
    });
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Open the chat widget
   */
  async open(): Promise<void> {
    this.isMinimized = false;
    this.render();

    if (this.resolveCapabilityState().effectiveMode !== 'chat') {
      return;
    }

    // Initialize SDK if needed
    await this.ensureSDKInitialized();
  }

  /**
   * Minimize the chat widget
   */
  minimize(): void {
    this.isMinimized = true;
    this.render();
  }

  /**
   * Toggle widget open/closed
   */
  toggle(): void {
    if (this.isMinimized) {
      this.open();
    } else {
      this.minimize();
    }
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

      this.sdk = candidateSdk;
      this.chat = chatClient;
      this.bindSdkLifecycle(candidateSdk);
      this.setupChatHandlers();

      this.updateSendButton();
    } catch (error) {
      candidateSdk.disconnect();
      if (sdkGeneration !== this.sdkGeneration) {
        return;
      }
      this.sdk = null;
      this.chat = null;
      this.showError(
        `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.updateSendButton();
    } finally {
      if (this.initializingSdk === candidateSdk) {
        this.initializingSdk = null;
      }
    }
  }

  private async ensureSDKInitialized(): Promise<void> {
    if (this.resolveCapabilityState().effectiveMode !== 'chat') {
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

    if (this.initializingSdk) {
      this.initializingSdk.disconnect();
      this.initializingSdk = null;
    }

    if (this.sdk) {
      this.sdk.disconnect();
      this.sdk = null;
    }

    this.chat = null;
  }

  private resolveCapabilityState() {
    return resolveElementWidgetCapabilityState(this, 'chat');
  }

  private isComposerReady(): boolean {
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

  private async sendMessage(): Promise<void> {
    if (!this.inputEl || !this.chat) return;

    const text = this.inputEl.value.trim();
    if (!text) return;

    // Clear input
    this.inputEl.value = '';
    this.updateSendButton();

    try {
      await this.chat.send(text);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
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
        // ABLP-1068: bind messageId + actionRenderId in the closure so the
        // rich-feedback renderer can submit rating-data only. Falls back to
        // a rejected promise when the chat client is unavailable so the
        // renderer surfaces an error without crashing.
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
      messageEl.className = `message ${message.role}`;
      messageEl.innerHTML = sanitizeHtml(renderMarkdown(message.content));
    } else {
      messageEl.className = `message ${message.role}`;
      messageEl.textContent = message.content;
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

    // Find or create the streaming message element for this response id.
    let streamingEl = this.messagesEl.querySelector(
      `.message.streaming[data-id="${messageId}"]`,
    ) as HTMLElement | null;

    if (!streamingEl) {
      streamingEl = document.createElement('div');
      streamingEl.className = 'message assistant streaming';
      streamingEl.setAttribute('data-id', messageId);
      this.messagesEl.appendChild(streamingEl);
    }

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
    console.error('[ChatWidget]', message);

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
      const isComposerReady = this.isComposerReady();
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

  private parseTheme(): WidgetTheme {
    const themeAttr = this.getAttribute('theme');
    if (themeAttr) {
      try {
        return JSON.parse(themeAttr);
      } catch {
        console.warn('[ChatWidget] Invalid theme attribute, using default');
      }
    }
    return {};
  }

  private shouldShowActivityUpdates(): boolean {
    return this.sdk?.getSessionScope()?.showActivityUpdates === true;
  }
}

// Register custom element
if (typeof customElements !== 'undefined' && !customElements.get('agent-chat')) {
  customElements.define('agent-chat', ChatWidget);
}

export { ChatWidget as default };
