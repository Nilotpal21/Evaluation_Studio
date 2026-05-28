/**
 * AgentProvider - React Context Provider for SDK
 *
 * Supports two modes:
 * - Path A (no transport): Creates AgentSDK with apiKey/projectId/endpoint or bootstrapToken/projectId/endpoint.
 * - Path B (transport provided): Creates ChatClient directly with SDKTransport.
 *
 * Optionally wraps children in SDKThemeProvider and/or StringsProvider.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { AgentSDK } from '../core/AgentSDK.js';
import { ChatClient } from '../chat/ChatClient.js';
import type { ChatClient as ChatClientType } from '../chat/ChatClient.js';
import type { VoiceClient } from '../voice/VoiceClient.js';
import type {
  SDKConfig,
  SDKConfigBase,
  SDKPublicKeyConfig,
  SDKBootstrapTokenConfig,
  Message,
  VoiceState,
  ThoughtEventData,
  SendMessageOptions,
} from '../core/types.js';
import type {
  SDKTransport,
  TransportClientMessage,
  TransportError,
  TransportServerMessage,
} from '../transport/types.js';
import { SDKThemeProvider } from './theme/ThemeProvider.js';
import { StringsProvider } from './strings/StringsProvider.js';
import type { SDKTheme } from './theme/types.js';
import type { SDKStrings } from './strings/types.js';

export type ChatActivityState =
  | { kind: 'idle' }
  | { kind: 'typing' }
  | { kind: 'streaming' }
  | { kind: 'status'; message: string; operation: string };

interface AgentContextValue {
  sdk: AgentSDK | null;
  isConnected: boolean;
  sessionId: string | null;
  error: Error | null;
  showActivityUpdates: boolean;
  // Chat
  chat: ChatClientType | null;
  messages: Message[];
  chatActivity: ChatActivityState;
  isTyping: boolean;
  streamingContent: string;
  isStreaming: boolean;
  statusMessage: string | null;
  sendMessage: (text: string, options?: SendMessageOptions) => Promise<void>;
  // Voice
  voice: VoiceClient | null;
  voiceState: VoiceState;
  startVoice: () => Promise<void>;
  stopVoice: () => void;
  toggleMute: () => boolean;
  isMuted: boolean;
  thought: ThoughtEventData | null;
}

const AgentContext = createContext<AgentContextValue | null>(null);

const DEFAULT_IDLE_DISCONNECT_BEHAVIOR = 'disconnect';
const IDLE_ACTIVITY_EVENTS = [
  'keydown',
  'mousedown',
  'mousemove',
  'pointerdown',
  'scroll',
  'touchstart',
] as const;

class IdleActivityTransport implements SDKTransport {
  constructor(
    private readonly transport: SDKTransport,
    private readonly onClientMessageSent: () => void,
  ) {}

  get capabilities(): SDKTransport['capabilities'] {
    return this.transport.capabilities;
  }

  connect(): Promise<void> {
    return this.transport.connect();
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  isConnected(): boolean {
    return this.transport.isConnected();
  }

  send(message: TransportClientMessage): void {
    this.transport.send(message);
    this.onClientMessageSent();
  }

  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  on(
    event: 'message' | 'connected' | 'disconnected' | 'error',
    handler:
      | ((msg: TransportServerMessage) => void)
      | (() => void)
      | ((reason?: string) => void)
      | ((error: TransportError) => void),
  ): () => void {
    switch (event) {
      case 'message':
        return this.transport.on(event, handler as (msg: TransportServerMessage) => void);
      case 'connected':
        return this.transport.on(event, handler as () => void);
      case 'disconnected':
        return this.transport.on(event, handler as (reason?: string) => void);
      case 'error':
        return this.transport.on(event, handler as (error: TransportError) => void);
    }
  }

  getSessionId(): string | null {
    return this.transport.getSessionId();
  }

  getActiveLiveSessionId(): string | null {
    return this.transport.getActiveLiveSessionId?.() ?? null;
  }
}

type AgentProviderSDKProps = {
  projectId?: SDKConfigBase['projectId'];
  endpoint?: SDKConfigBase['endpoint'];
  debug?: SDKConfigBase['debug'];
  webSocketConstructor?: SDKConfigBase['webSocketConstructor'];
  voice?: SDKConfigBase['voice'];
  idleDisconnect?: SDKConfigBase['idleDisconnect'];
  apiKey?: SDKPublicKeyConfig['apiKey'];
  bootstrapToken?: SDKBootstrapTokenConfig['bootstrapToken'];
  channelId?: SDKPublicKeyConfig['channelId'];
  channelName?: SDKPublicKeyConfig['channelName'];
  deploymentSlug?: SDKPublicKeyConfig['deploymentSlug'];
  userContext?: SDKPublicKeyConfig['userContext'];
};

type AgentProviderProps = AgentProviderSDKProps & {
  children?: React.ReactNode;
  /** Provide an SDKTransport to skip AgentSDK creation (Path B) */
  transport?: SDKTransport;
  /** Theme overrides — wraps children in SDKThemeProvider */
  theme?: Partial<SDKTheme>;
  /** String overrides — wraps children in StringsProvider */
  strings?: Partial<SDKStrings>;
};

function normalizeOptionalProviderValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveAgentProviderConfig(config: AgentProviderSDKProps): SDKConfig {
  const projectId = normalizeOptionalProviderValue(config.projectId);
  if (!projectId) {
    throw new Error('AgentProvider requires projectId when transport is not provided.');
  }

  const endpoint = normalizeOptionalProviderValue(config.endpoint);
  if (!endpoint) {
    throw new Error('AgentProvider requires endpoint when transport is not provided.');
  }

  const apiKey = normalizeOptionalProviderValue(config.apiKey);
  const bootstrapToken = normalizeOptionalProviderValue(config.bootstrapToken);
  if (Boolean(apiKey) === Boolean(bootstrapToken)) {
    throw new Error(
      'AgentProvider requires exactly one bootstrap credential: apiKey or bootstrapToken.',
    );
  }

  if (bootstrapToken) {
    const bootstrapConfig: SDKBootstrapTokenConfig = {
      projectId,
      endpoint,
      debug: config.debug,
      webSocketConstructor: config.webSocketConstructor,
      voice: config.voice,
      idleDisconnect: config.idleDisconnect,
      bootstrapToken,
    };
    return bootstrapConfig;
  }

  if (!apiKey) {
    throw new Error('AgentProvider apiKey is required for public-key bootstrap.');
  }

  const publicKeyConfig: SDKPublicKeyConfig = {
    projectId,
    endpoint,
    debug: config.debug,
    webSocketConstructor: config.webSocketConstructor,
    voice: config.voice,
    idleDisconnect: config.idleDisconnect,
    apiKey,
    channelId: normalizeOptionalProviderValue(config.channelId),
    channelName: normalizeOptionalProviderValue(config.channelName),
    deploymentSlug: normalizeOptionalProviderValue(config.deploymentSlug),
    userContext: config.userContext,
  };
  return publicKeyConfig;
}

function serializeProviderUserContext(userContext: AgentProviderSDKProps['userContext']): string {
  if (!userContext) {
    return '';
  }

  const serialized: Record<string, unknown> = {};

  if (userContext.userId !== undefined) {
    serialized.userId = userContext.userId;
  }

  if (userContext.customAttributes) {
    serialized.customAttributes = Object.fromEntries(
      Object.entries(userContext.customAttributes).sort(([leftKey], [rightKey]) =>
        leftKey.localeCompare(rightKey),
      ),
    );
  }

  return JSON.stringify(serialized);
}

function serializeProviderVoiceConfig(voice: AgentProviderSDKProps['voice']): string {
  if (!voice) {
    return '';
  }

  const vadConfig = voice.vadConfig;
  return JSON.stringify({
    enableBargeIn: voice.enableBargeIn,
    sampleRate: voice.sampleRate,
    deviceId: voice.deviceId,
    vadConfig: vadConfig
      ? {
          positiveSpeechThreshold: vadConfig.positiveSpeechThreshold,
          negativeSpeechThreshold: vadConfig.negativeSpeechThreshold,
          redemptionMs: vadConfig.redemptionMs,
          minSpeechMs: vadConfig.minSpeechMs,
          preSpeechPadMs: vadConfig.preSpeechPadMs,
          baseAssetPath: vadConfig.baseAssetPath,
          onnxWASMBasePath: vadConfig.onnxWASMBasePath,
          vadScriptUrl: vadConfig.vadScriptUrl,
          onnxRuntimeScriptUrl: vadConfig.onnxRuntimeScriptUrl,
          scriptNonce: vadConfig.scriptNonce,
        }
      : undefined,
  });
}

function serializeProviderIdleDisconnect(
  idleDisconnect: AgentProviderSDKProps['idleDisconnect'],
): string {
  if (!idleDisconnect) {
    return '';
  }

  return JSON.stringify({
    timeoutMs: idleDisconnect.timeoutMs,
    behavior: idleDisconnect.behavior,
  });
}

export function AgentProvider({
  children,
  transport,
  theme,
  strings,
  ...config
}: AgentProviderProps): React.ReactElement {
  // Determine path: B (transport provided) vs A (AgentSDK)
  const isTransportPath = transport !== undefined;

  const [sdk, setSdk] = useState<AgentSDK | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showActivityUpdates, setShowActivityUpdates] = useState(false);

  // Chat state
  const [chat, setChat] = useState<ChatClientType | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatActivity, setChatActivity] = useState<ChatActivityState>({ kind: 'idle' });
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  // Voice state
  const [voice, setVoice] = useState<VoiceClient | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [thought, setThought] = useState<ThoughtEventData | null>(null);
  const resetTransportIdleTimerRef = useRef<(() => void) | null>(null);
  const isTyping = chatActivity.kind === 'typing';
  const statusMessage = chatActivity.kind === 'status' ? chatActivity.message : null;

  const clearChatActivity = useCallback(() => {
    setChatActivity({ kind: 'idle' });
  }, []);

  const setTypingActivity = useCallback((typing: boolean) => {
    setChatActivity((previous) =>
      typing
        ? previous.kind === 'status'
          ? previous
          : { kind: 'typing' }
        : previous.kind === 'typing'
          ? { kind: 'idle' }
          : previous,
    );
  }, []);

  const setStreamingActivity = useCallback(() => {
    setChatActivity((previous) => (previous.kind === 'status' ? previous : { kind: 'streaming' }));
  }, []);

  const setStatusActivity = useCallback((text: string, operation = 'general') => {
    const message = text.trim();
    setChatActivity(message ? { kind: 'status', message, operation } : { kind: 'idle' });
  }, []);

  const clearStatusActivity = useCallback(() => {
    setChatActivity((previous) => (previous.kind === 'status' ? { kind: 'idle' } : previous));
  }, []);

  const userContextKey = useMemo(
    () => serializeProviderUserContext(config.userContext),
    [config.userContext],
  );
  const voiceConfigKey = useMemo(() => serializeProviderVoiceConfig(config.voice), [config.voice]);
  const idleDisconnectKey = useMemo(
    () => serializeProviderIdleDisconnect(config.idleDisconnect),
    [config.idleDisconnect],
  );

  // ---------------------------------------------------------------------------
  // Path A: AgentSDK flow (no transport prop)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isTransportPath) return;

    // Path A requires projectId + exactly one bootstrap credential
    if (!config.projectId || !config.endpoint || (!config.apiKey && !config.bootstrapToken)) {
      return;
    }

    let isActive = true;

    setIsConnected(false);
    setSessionId(null);
    setError(null);
    setShowActivityUpdates(false);
    setChat(null);
    setMessages([]);
    clearChatActivity();
    setStreamingContent('');
    setIsStreaming(false);
    setVoice(null);
    setVoiceState('idle');
    setIsMuted(false);
    setThought(null);

    let sdkConfig: SDKConfig;
    try {
      sdkConfig = resolveAgentProviderConfig(config);
    } catch (configError) {
      setError(configError instanceof Error ? configError : new Error(String(configError)));
      return;
    }

    const instance = new AgentSDK(sdkConfig);
    setSdk(instance);

    const unsubscribeConnected = instance.on('connected', () => {
      if (isActive) {
        setIsConnected(true);
        setShowActivityUpdates(instance.getSessionScope()?.showActivityUpdates === true);
      }
    });
    const unsubscribeDisconnected = instance.on('disconnected', () => {
      if (isActive) {
        setIsConnected(false);
        setShowActivityUpdates(false);
        setMessages([]);
        clearChatActivity();
        setStreamingContent('');
        setIsStreaming(false);
      }
    });
    const unsubscribeError = instance.on('error', ({ error: sdkError }) => {
      if (isActive) {
        setError(sdkError);
      }
    });
    const unsubscribeSessionStart = instance.on('sessionStart', ({ sessionId: sid }) => {
      if (isActive) {
        setSessionId(sid);
      }
    });

    instance.connect().catch((connectError) => {
      if (isActive) {
        setError(connectError instanceof Error ? connectError : new Error(String(connectError)));
      }
    });

    return () => {
      isActive = false;
      unsubscribeConnected();
      unsubscribeDisconnected();
      unsubscribeError();
      unsubscribeSessionStart();
      instance.disconnect();
    };
  }, [
    isTransportPath,
    config.projectId,
    config.apiKey,
    config.bootstrapToken,
    config.endpoint,
    config.debug,
    config.channelId,
    config.channelName,
    config.deploymentSlug,
    config.webSocketConstructor,
    userContextKey,
    voiceConfigKey,
    idleDisconnectKey,
    clearChatActivity,
  ]);

  // Path A: Initialize chat client from SDK
  useEffect(() => {
    if (isTransportPath) return;
    if (!sdk || !isConnected) return;

    const chatClient = sdk.chat();
    setChat(chatClient);

    const unsubscribeMessage = chatClient.on('message', (msg) => {
      setMessages((prev) => [...prev, msg]);
      setStreamingContent('');
      setIsStreaming(false);
      if (msg.role !== 'user') {
        clearChatActivity();
      }
    });

    const unsubscribeMessagesReplaced = chatClient.on('messagesReplaced', ({ messages }) => {
      setMessages(messages);
      setStreamingContent('');
      setIsStreaming(false);
      clearChatActivity();
    });

    const unsubscribeTyping = chatClient.on('typing', ({ isTyping: typing }) => {
      setTypingActivity(typing);
      if (typing) {
        // New response starting — reset accumulated streaming content
        setStreamingContent('');
        setIsStreaming(true);
      }
    });

    const unsubscribeChunk = chatClient.on('messageChunk', ({ chunk }) => {
      setStreamingContent((prev) => prev + chunk);
      setIsStreaming(true);
      setStreamingActivity();
    });

    const unsubscribeStatusUpdate = chatClient.on('statusUpdate', ({ text, operation }) => {
      setStatusActivity(text, operation);
    });

    const unsubscribeStatusClear = chatClient.on('statusClear', () => {
      clearStatusActivity();
    });

    return () => {
      unsubscribeMessage();
      unsubscribeMessagesReplaced();
      unsubscribeTyping();
      unsubscribeChunk();
      unsubscribeStatusUpdate();
      unsubscribeStatusClear();
    };
  }, [
    isTransportPath,
    sdk,
    isConnected,
    clearChatActivity,
    clearStatusActivity,
    setStatusActivity,
    setStreamingActivity,
    setTypingActivity,
  ]);

  // Path A: Initialize voice client from SDK
  useEffect(() => {
    if (isTransportPath) return;
    if (!sdk || !isConnected) return;

    const voiceClient = sdk.voice();
    setVoice(voiceClient);

    voiceClient.on('stateChange', ({ state }) => {
      setVoiceState(state);
    });

    voiceClient.on('thought', (data) => {
      setThought(data);
    });

    voiceClient.on('statusUpdate', ({ text, operation }) => {
      setStatusActivity(text, operation);
    });

    voiceClient.on('statusClear', () => {
      clearStatusActivity();
    });

    return () => {
      void voiceClient.dispose();
    };
  }, [isTransportPath, sdk, isConnected, clearStatusActivity, setStatusActivity]);

  // ---------------------------------------------------------------------------
  // Path B: Transport flow (transport prop provided)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isTransportPath || !transport) return;

    // Reset state
    setSdk(null);
    setError(null);
    setShowActivityUpdates(false);
    setMessages([]);
    clearChatActivity();
    setStreamingContent('');
    setIsStreaming(false);
    setVoice(null);
    setVoiceState('idle');
    setIsMuted(false);
    setThought(null);

    // Set initial connection state
    setIsConnected(transport.isConnected());
    setSessionId(transport.getSessionId());

    const chatTransport = new IdleActivityTransport(transport, () => {
      resetTransportIdleTimerRef.current?.();
    });
    const chatClient = new ChatClient(chatTransport, undefined, config.debug);
    setChat(chatClient);

    return () => {
      chatClient.dispose();
    };
  }, [isTransportPath, transport, config.debug, clearChatActivity]);

  useEffect(() => {
    if (!isTransportPath || !transport || !chat) return;

    let isActive = true;
    setMessages(chat.getMessages());

    const unsubscribeMessage = chat.on('message', (msg) => {
      if (isActive) {
        setMessages((prev) =>
          prev.some((existing) => existing.id === msg.id) ? prev : [...prev, msg],
        );
        setStreamingContent('');
        setIsStreaming(false);
        if (msg.role !== 'user') {
          clearChatActivity();
        }
      }
    });

    const unsubscribeMessagesReplaced = chat.on('messagesReplaced', ({ messages }) => {
      if (isActive) {
        setMessages(messages);
        setStreamingContent('');
        setIsStreaming(false);
        clearChatActivity();
      }
    });

    const unsubscribeTyping = chat.on('typing', ({ isTyping: typing }) => {
      if (isActive) {
        setTypingActivity(typing);
        if (typing) {
          // New response starting — reset accumulated streaming content
          setStreamingContent('');
          setIsStreaming(true);
        }
      }
    });

    const unsubscribeChunk = chat.on('messageChunk', ({ chunk }) => {
      if (isActive) {
        setStreamingContent((prev) => prev + chunk);
        setIsStreaming(true);
        setStreamingActivity();
      }
    });

    const unsubscribeChatError = chat.on('error', ({ error: chatError }) => {
      if (isActive) {
        setError(chatError);
      }
    });

    const unsubscribeStatusUpdate = chat.on('statusUpdate', ({ text, operation }) => {
      if (isActive) {
        setStatusActivity(text, operation);
      }
    });

    const unsubscribeStatusClear = chat.on('statusClear', () => {
      if (isActive) {
        clearStatusActivity();
      }
    });

    // Subscribe to transport lifecycle events
    const unsubscribeConnected = transport.on('connected', () => {
      if (isActive) {
        setIsConnected(true);
        setSessionId(transport.getSessionId());
      }
    });

    const unsubscribeDisconnected = transport.on('disconnected', () => {
      if (isActive) {
        setIsConnected(false);
        setShowActivityUpdates(false);
        // Do NOT clear messages here — the Studio Zustand store preserves them
        // and the SessionHistoryBridge restores them via replaceTranscript() on
        // reconnect. Clearing here causes a visible flash of empty chat on any
        // transient WebSocket drop.
        clearChatActivity();
        setStreamingContent('');
        setIsStreaming(false);
      }
    });

    const unsubscribeError = transport.on('error', (transportError) => {
      if (isActive) {
        setError(new Error(transportError.message));
      }
    });

    return () => {
      isActive = false;
      unsubscribeMessage();
      unsubscribeMessagesReplaced();
      unsubscribeTyping();
      unsubscribeChunk();
      unsubscribeChatError();
      unsubscribeStatusUpdate();
      unsubscribeStatusClear();
      unsubscribeConnected();
      unsubscribeDisconnected();
      unsubscribeError();
    };
  }, [
    isTransportPath,
    transport,
    chat,
    clearChatActivity,
    clearStatusActivity,
    setStatusActivity,
    setStreamingActivity,
    setTypingActivity,
  ]);

  useEffect(() => {
    if (!isTransportPath || !transport || !config.idleDisconnect) return;

    const idleDisconnect = config.idleDisconnect;
    if (!Number.isFinite(idleDisconnect.timeoutMs) || idleDisconnect.timeoutMs <= 0) {
      setError(new Error('AgentProvider idleDisconnect.timeoutMs must be a positive number.'));
      return;
    }

    const behavior = idleDisconnect.behavior ?? DEFAULT_IDLE_DISCONNECT_BEHAVIOR;
    if (behavior !== 'disconnect' && behavior !== 'end_session') {
      setError(
        new Error('AgentProvider idleDisconnect.behavior must be "disconnect" or "end_session".'),
      );
      return;
    }

    if (typeof globalThis.addEventListener !== 'function') {
      return;
    }

    let isActive = true;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const handleIdleTimeout = () => {
      if (!isActive) {
        return;
      }

      clearIdleTimer();

      if (behavior === 'end_session') {
        try {
          const activeSessionId = transport.getSessionId() ?? undefined;
          transport.send({
            type: 'end_session',
            ...(activeSessionId ? { sessionId: activeSessionId } : {}),
          });
        } catch (sendError) {
          setError(sendError instanceof Error ? sendError : new Error(String(sendError)));
        }
      }

      transport.disconnect();
    };

    const resetIdleTimer = () => {
      clearIdleTimer();
      if (transport.isConnected()) {
        idleTimer = setTimeout(handleIdleTimeout, idleDisconnect.timeoutMs);
      }
    };

    resetTransportIdleTimerRef.current = resetIdleTimer;

    const eventOptions: AddEventListenerOptions = { capture: true, passive: true };
    IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
      globalThis.addEventListener(eventName, resetIdleTimer, eventOptions);
    });

    const unsubscribeConnected = transport.on('connected', resetIdleTimer);
    const unsubscribeDisconnected = transport.on('disconnected', clearIdleTimer);
    resetIdleTimer();

    return () => {
      isActive = false;
      if (resetTransportIdleTimerRef.current === resetIdleTimer) {
        resetTransportIdleTimerRef.current = null;
      }
      clearIdleTimer();
      IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
        globalThis.removeEventListener(eventName, resetIdleTimer, eventOptions);
      });
      unsubscribeConnected();
      unsubscribeDisconnected();
    };
  }, [isTransportPath, transport, idleDisconnectKey]);

  // Chat actions
  const sendMessage = useCallback(
    async (text: string, options?: SendMessageOptions) => {
      if (!chat) throw new Error('Chat not initialized');
      await chat.send(text, options);
    },
    [chat],
  );

  // Voice actions — Path B returns safe defaults
  const startVoice = useCallback(async () => {
    if (isTransportPath) {
      throw new Error(
        'Voice requires AgentSDK — provide projectId with apiKey or bootstrapToken instead of transport',
      );
    }
    if (!voice) throw new Error('Voice not initialized');
    await voice.start();
  }, [isTransportPath, voice]);

  const stopVoice = useCallback(() => {
    if (isTransportPath) return; // noop for Path B
    void voice?.stop();
  }, [isTransportPath, voice]);

  const toggleMute = useCallback(() => {
    if (isTransportPath) return false; // noop for Path B
    if (!voice) return false;
    const newMuted = voice.toggleMute();
    setIsMuted(newMuted);
    return newMuted;
  }, [isTransportPath, voice]);

  const value = useMemo<AgentContextValue>(
    () => ({
      sdk,
      isConnected,
      sessionId,
      error,
      showActivityUpdates,
      chat,
      messages,
      chatActivity,
      isTyping,
      streamingContent,
      isStreaming,
      sendMessage,
      voice,
      voiceState,
      startVoice,
      stopVoice,
      toggleMute,
      isMuted,
      thought,
      statusMessage,
    }),
    [
      sdk,
      isConnected,
      sessionId,
      error,
      showActivityUpdates,
      chat,
      messages,
      chatActivity,
      isTyping,
      streamingContent,
      isStreaming,
      sendMessage,
      voice,
      voiceState,
      startVoice,
      stopVoice,
      toggleMute,
      isMuted,
      thought,
      statusMessage,
    ],
  );

  // Wrap children in theme/strings providers if provided
  let wrappedChildren: React.ReactNode = children;

  if (strings !== undefined) {
    wrappedChildren = React.createElement(StringsProvider, { strings }, wrappedChildren);
  }

  if (theme !== undefined) {
    wrappedChildren = React.createElement(SDKThemeProvider, { theme }, wrappedChildren);
  }

  return React.createElement(AgentContext.Provider, { value }, wrappedChildren);
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error('useAgent must be used within an AgentProvider');
  }
  return context;
}

export function useChat() {
  const {
    chat,
    messages,
    chatActivity,
    isTyping,
    sendMessage,
    isConnected,
    streamingContent,
    isStreaming,
    showActivityUpdates,
    statusMessage,
  } = useAgent();
  return {
    chat,
    messages,
    chatActivity,
    isTyping,
    sendMessage,
    isConnected,
    streamingContent,
    isStreaming,
    showActivityUpdates,
    statusMessage,
  };
}

export function useVoice() {
  const {
    voiceState,
    startVoice,
    stopVoice,
    toggleMute,
    isMuted,
    isConnected,
    thought,
    statusMessage,
  } = useAgent();
  return {
    voiceState,
    startVoice,
    stopVoice,
    toggleMute,
    isMuted,
    isConnected,
    thought,
    statusMessage,
  };
}
