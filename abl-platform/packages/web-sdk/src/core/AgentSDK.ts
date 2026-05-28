/**
 * AgentSDK - Main SDK entry point
 */

import { TypedEventEmitter } from './EventEmitter.js';
import { SessionManager } from './SessionManager.js';
import { TokenManager } from './TokenManager.js';
import { ChatClient } from '../chat/ChatClient.js';
import { VoiceClient } from '../voice/VoiceClient.js';
import { DefaultTransport } from '../transport/DefaultTransport.js';
import type {
  SDKConfig,
  SDKBootstrapTokenConfig,
  SDKEvents,
  LiveSessionDiscoveryResult,
  JoinResult,
  SDKPublicKeyConfig,
  SDKSessionScope,
  SDKIdleDisconnectBehavior,
  SDKIdleDisconnectConfig,
} from './types.js';

const DEFAULT_IDLE_DISCONNECT_BEHAVIOR: SDKIdleDisconnectBehavior = 'disconnect';
const IDLE_ACTIVITY_EVENTS = [
  'keydown',
  'mousedown',
  'mousemove',
  'pointerdown',
  'scroll',
  'touchstart',
] as const;

function requireConfigValue(value: string, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`SDK config ${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalConfigValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeIdleDisconnectConfig(
  config: SDKIdleDisconnectConfig | undefined,
): SDKIdleDisconnectConfig | undefined {
  if (config === undefined) {
    return undefined;
  }

  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error('SDK config idleDisconnect.timeoutMs must be a positive number.');
  }

  const behavior = config.behavior ?? DEFAULT_IDLE_DISCONNECT_BEHAVIOR;
  if (behavior !== 'disconnect' && behavior !== 'end_session') {
    throw new Error('SDK config idleDisconnect.behavior must be disconnect or end_session.');
  }

  return {
    timeoutMs: config.timeoutMs,
    behavior,
  };
}

function normalizeSdkConfig(config: SDKConfig): SDKConfig {
  const projectId = requireConfigValue(config.projectId, 'projectId');
  const endpoint = requireConfigValue(config.endpoint, 'endpoint');
  const apiKey = normalizeOptionalConfigValue(config.apiKey);
  const bootstrapToken = normalizeOptionalConfigValue(config.bootstrapToken);
  const idleDisconnect = normalizeIdleDisconnectConfig(config.idleDisconnect);

  if (Boolean(apiKey) === Boolean(bootstrapToken)) {
    throw new Error(
      'SDK config must provide exactly one bootstrap credential: apiKey or bootstrapToken.',
    );
  }

  if (bootstrapToken) {
    const bootstrapConfig: SDKBootstrapTokenConfig = {
      projectId,
      endpoint,
      debug: config.debug,
      webSocketConstructor: config.webSocketConstructor,
      voice: config.voice,
      ...(idleDisconnect ? { idleDisconnect } : {}),
      bootstrapToken,
    };
    return bootstrapConfig;
  }

  if (!apiKey) {
    throw new Error('SDK config apiKey is required.');
  }

  const publicKeyConfig: SDKPublicKeyConfig = {
    projectId,
    endpoint,
    debug: config.debug,
    webSocketConstructor: config.webSocketConstructor,
    voice: config.voice,
    ...(idleDisconnect ? { idleDisconnect } : {}),
    apiKey,
    channelId: normalizeOptionalConfigValue(config.channelId),
    channelName: normalizeOptionalConfigValue(config.channelName),
    deploymentSlug: normalizeOptionalConfigValue(config.deploymentSlug),
    userContext: config.userContext,
  };
  return publicKeyConfig;
}

export class AgentSDK extends TypedEventEmitter<SDKEvents> {
  private readonly config: SDKConfig;
  private readonly tokenManager: TokenManager;
  private readonly sessionManager: SessionManager;
  private readonly defaultTransport: DefaultTransport;
  private chatClient: ChatClient | null = null;
  private voiceClient: VoiceClient | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTrackingActive = false;

  constructor(config: SDKConfig) {
    super();
    this.config = normalizeSdkConfig(config);
    this.tokenManager = new TokenManager(this.config);
    this.sessionManager = new SessionManager(this.config, this.tokenManager);
    this.defaultTransport = new DefaultTransport(this.sessionManager);
    this.setupEventForwarding();
  }

  /**
   * Connect to the platform and wait until the runtime session is ready.
   */
  async connect(): Promise<void> {
    await this.sessionManager.connect();
    this.startIdleTracking();
    if (this.chatClient) {
      await this.chatClient.hydratePersistedHistory();
    }
  }

  /**
   * Disconnect from the platform
   */
  disconnect(): void {
    this.stopIdleTracking();
    if (this.voiceClient) {
      this.voiceClient.stop();
    }
    this.sessionManager.disconnect();
  }

  /**
   * Explicitly end the current Runtime session and close the socket.
   */
  endSession(): void {
    this.stopIdleTracking();
    if (this.voiceClient) {
      this.voiceClient.stop();
    }
    this.sessionManager.endSession();
  }

  /**
   * Get the SDK-owned chat client instance.
   * The client is cached for the lifetime of this AgentSDK so it can stay
   * wired to the shared transport across disconnect/reconnect cycles. UI
   * integrations should unsubscribe their own listeners for transient cleanup
   * instead of disposing this cached instance.
   */
  chat(): ChatClient {
    if (!this.chatClient) {
      const sm = this.sessionManager;
      this.chatClient = new ChatClient(
        this.defaultTransport,
        {
          getAuthToken: () => sm.getAuthToken(),
          getProjectId: () => sm.getProjectId(),
          getSessionId: () => sm.getSessionId(),
          getEndpoint: () => sm.getEndpoint(),
        },
        this.config.debug,
        this.sessionManager,
      );
    }
    if (this.sessionManager.isConnected()) {
      void this.chatClient.hydratePersistedHistory();
    }
    return this.chatClient;
  }

  /**
   * Get voice client instance
   */
  voice(): VoiceClient {
    if (!this.voiceClient) {
      this.voiceClient = new VoiceClient(this.sessionManager, this.config.debug, this.config.voice);
    }
    return this.voiceClient;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.sessionManager.isConnected();
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionManager.getSessionId();
  }

  getSessionScope(): SDKSessionScope | null {
    return this.sessionManager.getScope();
  }

  // ===========================================================================
  // Omnichannel Methods
  // ===========================================================================

  /**
   * Discover if a live session exists for the current SDK session.
   * Retained as a public API for advanced integrations even when the default
   * widgets do not auto-discover or auto-join live sessions.
   */
  async discoverLiveSession(): Promise<LiveSessionDiscoveryResult | null> {
    return this.sessionManager.discoverLiveSession();
  }

  /**
   * Join a live session by ID for advanced omnichannel integrations.
   */
  async joinLiveSession(sessionId: string, joinToken?: string): Promise<JoinResult> {
    return this.sessionManager.joinLiveSession(sessionId, joinToken);
  }

  /**
   * Get the currently joined live session ID, if any.
   */
  getActiveLiveSessionId(): string | null {
    return this.sessionManager.getActiveLiveSessionId();
  }

  /**
   * Get the internal session manager for advanced omnichannel operations.
   * Used by widgets and components that need direct access to session-level APIs.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  private setupEventForwarding(): void {
    this.sessionManager.on('connected', () => {
      this.startIdleTracking();
      this.emit('connected', undefined);
    });

    this.sessionManager.on('disconnected', () => {
      this.stopIdleTracking();
      this.emit('disconnected', undefined);
    });

    this.sessionManager.on('error', ({ error }) => {
      this.emit('error', { error });
    });

    this.sessionManager.on('clientMessageSent', () => {
      this.resetIdleTimer();
    });

    this.sessionManager.on('message', (message) => {
      if (message.type === 'session_start') {
        this.emit('sessionStart', {
          sessionId: message.sessionId as string,
          projectId: typeof message.projectId === 'string' ? message.projectId : undefined,
          channelId: typeof message.channelId === 'string' ? message.channelId : undefined,
        });
      } else if (message.type === 'session_end' || message.type === 'session_ended') {
        this.emit('sessionEnd', undefined);
      }
    });
  }

  private startIdleTracking(): void {
    if (!this.config.idleDisconnect || this.idleTrackingActive) {
      return;
    }

    const target = this.getIdleEventTarget();
    if (!target) {
      return;
    }

    this.idleTrackingActive = true;
    for (const eventName of IDLE_ACTIVITY_EVENTS) {
      target.addEventListener(eventName, this.handleIdleActivity, {
        passive: true,
        capture: true,
      });
    }
    this.resetIdleTimer();
  }

  private stopIdleTracking(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (!this.idleTrackingActive) {
      return;
    }

    const target = this.getIdleEventTarget();
    if (target) {
      for (const eventName of IDLE_ACTIVITY_EVENTS) {
        target.removeEventListener(eventName, this.handleIdleActivity, {
          capture: true,
        });
      }
    }

    this.idleTrackingActive = false;
  }

  private readonly handleIdleActivity = (): void => {
    this.resetIdleTimer();
  };

  private resetIdleTimer(): void {
    if (!this.config.idleDisconnect || !this.idleTrackingActive) {
      return;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.handleIdleTimeout();
    }, this.config.idleDisconnect.timeoutMs);
  }

  private handleIdleTimeout(): void {
    const idleDisconnect = this.config.idleDisconnect;
    if (!idleDisconnect) {
      return;
    }

    const behavior = idleDisconnect.behavior ?? DEFAULT_IDLE_DISCONNECT_BEHAVIOR;
    this.emit('idleTimeout', {
      timeoutMs: idleDisconnect.timeoutMs,
      behavior,
    });

    if (behavior === 'end_session') {
      this.endSession();
      return;
    }

    this.disconnect();
  }

  private getIdleEventTarget(): EventTarget | null {
    if (typeof globalThis.addEventListener === 'function') {
      return globalThis;
    }

    return null;
  }

  /**
   * Static init method for global usage
   */
  static init(config: SDKConfig): AgentSDK {
    const sdk = new AgentSDK(config);

    // Store globally for web components
    if (typeof window !== 'undefined') {
      (window as unknown as { __agentSDK: AgentSDK }).__agentSDK = sdk;
    }

    return sdk;
  }
}

export { SessionManager } from './SessionManager.js';
export { TypedEventEmitter } from './EventEmitter.js';
export * from './types.js';
