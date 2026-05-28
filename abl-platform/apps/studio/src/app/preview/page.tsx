'use client';

import { Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  MessageSquare,
  X,
  Minimize2,
  AlertCircle,
  Shield,
  Mic,
  MicOff,
  Volume2,
  Square,
  LogOut,
  Plus,
  Settings2,
} from 'lucide-react';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import { isBrowserVoiceCaptureSupported } from '@agent-platform/shared/sdk-widget-capabilities';
import type { ActionSubmitOptions } from '@agent-platform/web-sdk';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { deriveDefaultSdkWsUrl } from '@/utils/derive-ws-url';
import { sanitizeError } from '@/lib/sanitize-error';
import { buildRuntimeChatNotice } from '@/lib/runtime-chat-notice';
import { PreviewChatComposer } from '@/components/preview/PreviewChatComposer';
import { PreviewMessageList } from '@/components/preview/PreviewMessageList';
import { uploadPreviewAttachment } from '@/components/preview/preview-attachment-upload';
import {
  buildPreviewAssistantMessage,
  buildPreviewAuthChallengeMessage,
  buildPreviewThoughtMessage,
  type PreviewChatMessage,
} from '@/components/preview/preview-chat-utils';
import { BatchConsentGate } from '@/components/auth-profiles/BatchConsentGate';
import { useBatchConsentStore } from '@/store/batch-consent-store';
import {
  clearPersistedShareTokenFromBrowserSession,
  consumeShareTokenFromBrowserLocation,
} from '@/lib/share-preview-link';
import { resolveStudioWidgetCapabilityState } from '@/lib/sdk-widget-capabilities';
import { shouldReconnectPreviewWebSocket } from '@/lib/preview-reconnect';

interface WidgetConfig {
  mode: string;
  position: string;
  theme: {
    primaryColor: string;
  };
  welcomeMessage: string | null;
  placeholderText: string;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  showActivityUpdates: boolean;
}

interface TokenValidation {
  valid: boolean;
  projectId: string;
  projectName: string;
  expiresAt: string;
  /** SDK session JWT for WebSocket authentication */
  sdkToken: string;
  config: WidgetConfig;
}

type Message = PreviewChatMessage;

type WidgetMode = 'chat' | 'voice';
type VoiceState = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'error';

function resolvePreviewWidgetPositionClass(position: string | null | undefined): string {
  switch (position) {
    case 'bottom-left':
      return 'bottom-6 left-6';
    case 'top-right':
      return 'top-6 right-6';
    case 'top-left':
      return 'top-6 left-6';
    default:
      return 'bottom-6 right-6';
  }
}

function PreviewContent() {
  const searchParams = useSearchParams();
  const initialMode = searchParams.get('mode') as WidgetMode | null;
  const { sdkWsUrl: configSdkWsUrl, runtimeUrl: configRuntimeUrl } = useRuntimeConfig();
  const t = useTranslations('preview');

  const [validation, setValidation] = useState<TokenValidation | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareTokenReady, setShareTokenReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<{
    code: string;
    message: string;
    recoverable: boolean;
  } | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  // Caller data state (local — not persisted to localStorage)
  const [callerDataEntries, setCallerDataEntries] = useState<Record<string, string>>({});
  const [cdNewKey, setCdNewKey] = useState('');
  const [cdNewValue, setCdNewValue] = useState('');

  // Deferred connection state
  const [activeSdkToken, setActiveSdkToken] = useState<string | null>(null);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [widgetMode, setWidgetMode] = useState<WidgetMode>(
    initialMode === 'voice' ? 'voice' : 'chat',
  );

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  // Voice state
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [voiceMode, setVoiceMode] = useState<'realtime' | null>(null);

  // Voice timing/trace state (realtime only)
  const [lastVoiceTiming, setLastVoiceTiming] = useState<{
    total: number;
    turnLatency?: number;
    toolCallOverhead?: number;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const widgetModeRef = useRef<WidgetMode>(widgetMode);
  const translationsRef = useRef(t);

  // Audio capture refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Realtime PCM16 audio playback refs
  const realtimeAudioCtxRef = useRef<AudioContext | null>(null);
  const realtimeNextPlayTimeRef = useRef<number>(0);
  const realtimePlayingRef = useRef<boolean>(false);

  // Ref to hold stopListening so WS cleanup can access it without circular dependency
  const stopListeningRef = useRef<() => void>(() => {});

  useEffect(() => {
    translationsRef.current = t;
  }, [t]);

  // Check voice support
  useEffect(() => {
    setVoiceSupported(isBrowserVoiceCaptureSupported());
  }, []);

  useEffect(() => {
    const resolved = consumeShareTokenFromBrowserLocation();
    setShareToken(resolved.token);
    setShareTokenReady(true);
  }, []);

  // Parse callerData from URL query params (?callerData=base64json)
  useEffect(() => {
    const raw = searchParams.get('callerData');
    if (!raw) return;
    try {
      const decoded = JSON.parse(atob(raw));
      if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
        const entries: Record<string, string> = {};
        for (const [key, value] of Object.entries(decoded)) {
          entries[key] = typeof value === 'string' ? value : JSON.stringify(value);
        }
        setCallerDataEntries(entries);
      }
    } catch {
      // Ignore malformed callerData param
    }
  }, [searchParams]);

  // Parse callerData entries into typed values (attempt JSON parsing)
  const parseCallerDataEntries = useCallback(
    (entries: Record<string, string>): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entries)) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = value;
        }
      }
      return result;
    },
    [],
  );

  const exchangeShareTokenForSdkSession = useCallback(
    async (customAttributes?: Record<string, unknown>): Promise<TokenValidation> => {
      if (!shareToken) {
        throw new Error(t('no_token_error'));
      }

      const body: {
        token: string;
        userContext?: { customAttributes: Record<string, unknown> };
      } = { token: shareToken };

      if (customAttributes && Object.keys(customAttributes).length > 0) {
        body.userContext = { customAttributes };
      }

      const res = await fetch('/api/sdk/share/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (res.ok && data.valid) {
        return data as TokenValidation;
      }

      throw new Error(data.error || t('invalid_share_link'));
    },
    [shareToken, t],
  );

  // Exchange the share artifact for a fresh Runtime-issued SDK session.
  useEffect(() => {
    const validateToken = async () => {
      if (!shareTokenReady) {
        return;
      }

      if (!shareToken) {
        setError(t('no_token_error'));
        setLoading(false);
        return;
      }

      const isInitialLoad = validation === null;
      if (isInitialLoad) {
        setLoading(true);
      }

      try {
        const data = await exchangeShareTokenForSdkSession();
        setValidation(data);
        setError(null);
        clearPersistedShareTokenFromBrowserSession();
      } catch (err) {
        setValidation(null);
        setError(sanitizeError(err, t('validate_failed')));
      } finally {
        if (isInitialLoad) {
          setLoading(false);
        }
      }
    };

    validateToken();
  }, [exchangeShareTokenForSdkSession, shareTokenReady, t]);

  const connectionCapabilityState = validation
    ? resolveStudioWidgetCapabilityState({
        mode: validation.config.mode,
        chatEnabled: validation.config.chatEnabled,
        voiceEnabled: validation.config.voiceEnabled,
        voiceSupported,
      })
    : null;

  const capabilityState = validation
    ? resolveStudioWidgetCapabilityState({
        mode: validation.config.mode,
        currentMode: widgetMode,
        chatEnabled: validation.config.chatEnabled,
        voiceEnabled: validation.config.voiceEnabled,
        voiceSupported,
      })
    : null;
  const activeWidgetMode = capabilityState?.effectiveMode ?? widgetMode;

  useEffect(() => {
    widgetModeRef.current = activeWidgetMode;
  }, [activeWidgetMode]);

  useEffect(() => {
    const effectiveMode = capabilityState?.effectiveMode;
    if (!effectiveMode || effectiveMode === widgetMode) {
      return;
    }

    if (widgetMode === 'voice' && effectiveMode !== 'voice') {
      stopListeningRef.current();
    }

    setWidgetMode(effectiveMode);
  }, [capabilityState?.effectiveMode, widgetMode]);

  // Handle opening the widget — exchanges with callerData if present, then connects
  const handleOpenWidget = useCallback(async () => {
    const existingReadyState = wsRef.current?.readyState ?? null;
    const shouldReconnect = shouldReconnectPreviewWebSocket({
      hasEverConnected,
      sessionEnded,
      readyState: existingReadyState,
      recoverableError: connectionError?.recoverable ?? null,
    });

    if (hasEverConnected && !shouldReconnect) {
      setIsOpen(true);
      setIsMinimized(false);
      return;
    }

    if (!validation || !shareToken) return;

    setIsConnecting(true);
    setConnectionError(null);

    try {
      const callerAttributes =
        Object.keys(callerDataEntries).length > 0
          ? parseCallerDataEntries(callerDataEntries)
          : undefined;
      const sdkSession =
        shouldReconnect || callerAttributes
          ? await exchangeShareTokenForSdkSession(callerAttributes)
          : validation;

      setValidation(sdkSession);
      setActiveSdkToken(sdkSession.sdkToken);
      setHasEverConnected(true);
      setIsOpen(true);
      setIsMinimized(false);
      setSessionEnded(false);
    } catch (err) {
      setConnectionError({
        code: 'SDK_SHARE_EXCHANGE_FAILED',
        message: sanitizeError(err, t('validate_failed')),
        recoverable: shareTokenReady && shareToken !== null,
      });
    } finally {
      setIsConnecting(false);
    }
  }, [
    callerDataEntries,
    connectionError?.recoverable,
    exchangeShareTokenForSdkSession,
    hasEverConnected,
    parseCallerDataEntries,
    sessionEnded,
    shareToken,
    shareTokenReady,
    t,
    validation,
  ]);

  useEffect(() => {
    const reconnectWhenVisible = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      if (
        shouldReconnectPreviewWebSocket({
          hasEverConnected,
          sessionEnded,
          readyState: wsRef.current?.readyState ?? null,
          recoverableError: connectionError?.recoverable ?? null,
        })
      ) {
        void handleOpenWidget();
      }
    };

    document.addEventListener('visibilitychange', reconnectWhenVisible);
    return () => document.removeEventListener('visibilitychange', reconnectWhenVisible);
  }, [connectionError?.recoverable, handleOpenWidget, hasEverConnected, sessionEnded]);

  // Connect to WebSocket
  useEffect(() => {
    if (!activeSdkToken || !validation || !connectionCapabilityState?.effectiveMode) return;

    // Use runtime config from server component, or same-origin runtime routing.
    const sdkWsUrl = deriveDefaultSdkWsUrl(configSdkWsUrl);

    const ws = new WebSocket(sdkWsUrl, buildSdkWSProtocols(activeSdkToken));
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const appendNotice = () => {
        const notice = buildRuntimeChatNotice(data);
        if (!notice) return;
        setMessages((prev) => [
          ...prev,
          {
            id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'system',
            content: notice,
            timestamp: new Date(),
          },
        ]);
      };

      switch (data.type) {
        case 'session_start':
          setIsConnected(true);
          setConnectionError(null);
          setSessionEnded(false);
          setSessionId(data.sessionId);
          useBatchConsentStore.getState().reset();
          if (validation.config.welcomeMessage) {
            setMessages([
              {
                id: 'welcome',
                role: 'assistant',
                content: validation.config.welcomeMessage,
                timestamp: new Date(),
              },
            ]);
          }
          break;

        case 'response_start':
          setIsTyping(true);
          setVoiceState('processing');
          break;

        case 'response_end':
          setIsTyping(false);
          setMessages((prev) => [...prev, buildPreviewAssistantMessage(data, new Date())]);
          if (widgetModeRef.current !== 'voice') {
            setVoiceState('idle');
          }
          break;

        case 'error':
          setIsTyping(false);
          appendNotice();
          if (!isConnected) {
            setConnectionError({
              code: 'runtime_error',
              message: (typeof data.message === 'string' && data.message) || 'Runtime error',
              recoverable: true,
            });
          }
          break;

        case 'auth_challenge':
          setMessages((prev) => [...prev, buildPreviewAuthChallengeMessage(data, new Date())]);
          break;

        case 'message_queued':
        case 'tool_warnings':
        case 'session_health':
          appendNotice();
          break;

        case 'auth_required':
          useBatchConsentStore
            .getState()
            .initFromAuthRequired(data.sessionId, data.pending, data.satisfied);
          break;

        case 'auth_gate_updated':
          useBatchConsentStore
            .getState()
            .updateFromGateUpdate(data.sessionId, data.pending, data.satisfied);
          break;

        case 'auth_gate_satisfied':
          useBatchConsentStore.getState().markAllSatisfied(data.sessionId);
          break;

        case 'session_ended':
          setSessionEnded(true);
          setIsConnected(false);
          useBatchConsentStore.getState().reset();
          break;

        // Voice messages (realtime only)
        case 'voice_started':
          setVoiceState('listening');
          setVoiceError(null);
          setVoiceMode(data.voiceMode || 'realtime');
          break;

        case 'voice_stopped':
          setVoiceState('idle');
          break;

        case 'voice_error':
          setVoiceError(data.message || 'Voice error');
          setVoiceState('error');
          break;

        case 'trace_event':
          if (
            validation.config.showActivityUpdates !== false &&
            data.event?.type === 'tool_thought'
          ) {
            const thoughtMessage = buildPreviewThoughtMessage(data.event, new Date());
            if (thoughtMessage) {
              setMessages((prev) => [...prev, thoughtMessage]);
            }
            break;
          }

          // Capture realtime turn timing
          if (data.event?.type === 'voice_realtime_turn_end' && data.event?.data) {
            const d = data.event.data;
            const timing = d.timing as
              | { turnLatency?: number; totalDuration?: number; toolCallOverhead?: number }
              | undefined;
            setLastVoiceTiming({
              total: d.durationMs || timing?.totalDuration || 0,
              turnLatency: timing?.turnLatency,
              toolCallOverhead: timing?.toolCallOverhead,
            });
            // Turn ended — ensure we go back to listening
            realtimePlayingRef.current = false;
            realtimeNextPlayTimeRef.current = 0;
            setVoiceState('listening');
          }
          break;

        case 'agent_transfer_event': {
          const evt = data.event as {
            type: string;
            data?: Record<string, unknown>;
          };
          if (evt?.type === 'agent:message') {
            const content =
              (evt.data?.message as string) ||
              (evt.data?.text as string) ||
              (evt.data?.body as string) ||
              '';
            if (content) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `agent-transfer-${Date.now()}`,
                  role: 'assistant',
                  content,
                  timestamp: new Date(),
                },
              ]);
            }
            // SmartAssist sends csatRequested:true in the agent-close message event
            if (evt.data?.csatRequested) {
              const csatMsg = evt.data.csatMessage as { value?: string } | undefined;
              const prompt = csatMsg?.value ?? t('agent_transfer_rate_experience');
              setMessages((prev) => {
                if (prev.some((m) => m.csatData)) return prev;
                return [
                  ...prev,
                  {
                    id: `agent-transfer-csat-${Date.now()}`,
                    role: 'assistant' as const,
                    content: prompt,
                    timestamp: new Date(),
                    csatData: {
                      provider: 'smartassist',
                      userId:
                        ((evt.data?.csatMessage as Record<string, unknown>)?.userId as string) ??
                        (evt.data?.userId as string) ??
                        '',
                      botId: (evt.data?.iId as string) ?? '',
                      channel: (evt.data?.source as string) ?? 'rtm',
                      surveyType: (['csat', 'nps', 'likeDislike'] as const).includes(
                        evt.data?.surveyType as 'csat' | 'nps' | 'likeDislike',
                      )
                        ? (evt.data?.surveyType as 'csat' | 'nps' | 'likeDislike')
                        : 'csat',
                      conversationId: (evt.data?.conversationId as string) ?? '',
                      orgId: (evt.data?.orgId as string) ?? '',
                    },
                  },
                ];
              });
            }
          } else if (evt?.type === 'agent:disconnected') {
            setMessages((prev) => [
              ...prev,
              {
                id: `agent-transfer-disconnect-${Date.now()}`,
                role: 'system',
                content: t('agent_transfer_disconnected'),
                timestamp: new Date(),
              },
            ]);
            // Fallback: server injects csatRequired when SmartAssist omits it from the close message
            if (evt.data?.csatRequired) {
              const prompt = t('agent_transfer_rate_experience');
              setMessages((prev) => {
                if (prev.some((m) => m.csatData)) return prev;
                return [
                  ...prev,
                  {
                    id: `agent-transfer-csat-${Date.now()}`,
                    role: 'assistant' as const,
                    content: prompt,
                    timestamp: new Date(),
                    csatData: {
                      provider: 'smartassist',
                      userId: (evt.data?.userId as string) ?? '',
                      botId: (evt.data?.iId as string) ?? '',
                      channel: (evt.data?.source as string) ?? 'rtm',
                      surveyType: (['csat', 'nps', 'likeDislike'] as const).includes(
                        evt.data?.csatSurveyType as 'csat' | 'nps' | 'likeDislike',
                      )
                        ? (evt.data?.csatSurveyType as 'csat' | 'nps' | 'likeDislike')
                        : 'csat',
                      conversationId: (evt.data?.conversationId as string) ?? '',
                      orgId: (evt.data?.orgId as string) ?? '',
                    },
                  },
                ];
              });
            }
          }
          break;
        }

        case 'voice_barge_in_ack':
          // Server acknowledged barge-in — reset realtime playback
          realtimeNextPlayTimeRef.current = 0;
          realtimePlayingRef.current = false;
          setVoiceState('listening');
          break;

        // Realtime voice messages
        case 'voice_realtime_audio': {
          // PCM16 audio from realtime voice model — stream directly to AudioContext
          if (data.audio) {
            if (!realtimePlayingRef.current) {
              realtimePlayingRef.current = true;
              setVoiceState('speaking');
            }
            const audioBytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
            playRealtimePCM16(audioBytes);
          }
          break;
        }

        case 'voice_realtime_transcript': {
          const rtText = data.text as string;
          const rtRole = data.role as 'user' | 'assistant';
          const rtFinal = data.isFinal as boolean;
          if (rtRole === 'user') {
            setTranscript(rtText || '');
            if (rtFinal && rtText) {
              setMessages((prev) => [
                ...prev,
                {
                  id: `rt_user_${Date.now()}`,
                  role: 'user',
                  content: rtText,
                  timestamp: new Date(),
                },
              ]);
              setTranscript('');
            }
          } else if (rtRole === 'assistant' && rtFinal && rtText) {
            setMessages((prev) => [
              ...prev,
              {
                id: `rt_asst_${Date.now()}`,
                role: 'assistant',
                content: rtText,
                timestamp: new Date(),
              },
            ]);
            // Turn complete — back to listening
            realtimePlayingRef.current = false;
            realtimeNextPlayTimeRef.current = 0;
            setVoiceState('listening');
          }
          break;
        }
      }
    };

    ws.onerror = (event) => {
      console.error('[WebSocket] Connection error', event);
      setConnectionError({
        code: 'WS_ERROR',
        message: translationsRef.current('ws_error'),
        recoverable: true,
      });
      setIsConnected(false);
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      useBatchConsentStore.getState().reset();
      // Only show error for abnormal closures
      if (event.code !== 1000 && event.code !== 1001) {
        const currentTranslations = translationsRef.current;
        const errorMessages: Record<number, string> = {
          1006: currentTranslations('ws_close_1006'),
          1008: currentTranslations('ws_close_1008'),
          1011: currentTranslations('ws_close_1011'),
          4010: currentTranslations('ws_close_4010'),
        };
        const nonRecoverableCodes = new Set([4010]);
        setConnectionError({
          code: `WS_CLOSE_${event.code}`,
          message:
            errorMessages[event.code] || event.reason || currentTranslations('ws_close_default'),
          recoverable:
            !nonRecoverableCodes.has(event.code) && shareTokenReady && shareToken !== null,
        });
      }
    };

    return () => {
      stopListeningRef.current();
      useBatchConsentStore.getState().reset();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      ws.close();
    };
  }, [
    activeSdkToken,
    configSdkWsUrl,
    connectionCapabilityState?.effectiveMode,
    shareToken,
    shareTokenReady,
    validation,
  ]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const sendMessage = useCallback(
    (text: string, attachmentIds?: string[]) => {
      const trimmed = text.trim();
      if (
        (!trimmed && (!attachmentIds || attachmentIds.length === 0)) ||
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const messageId = `msg_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          role: 'user',
          content: trimmed || t('attachments_only_message', { count: attachmentIds?.length ?? 0 }),
          timestamp: new Date(),
        },
      ]);

      wsRef.current.send(
        JSON.stringify({
          type: 'chat_message',
          text: trimmed,
          messageId,
          ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
        }),
      );
    },
    [t],
  );

  const handleActionSubmit = useCallback(
    (actionId: string, value?: string, options?: ActionSubmitOptions) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: 'action_submit',
          actionId,
          ...(value !== undefined ? { value } : {}),
          ...(options?.formData !== undefined ? { formData: options.formData } : {}),
          ...(options?.renderId !== undefined ? { renderId: options.renderId } : {}),
        }),
      );
    },
    [],
  );

  const handleAuthResponse = useCallback(
    (toolCallId: string, status: 'completed' | 'cancelled') => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: 'auth_response',
          toolCallId,
          status,
        }),
      );
    },
    [],
  );

  const handleUploadAttachment = useCallback(
    async (file: File) => {
      if (!activeSdkToken || !validation || !sessionId) {
        throw new Error(t('upload_session_not_ready'));
      }

      return uploadPreviewAttachment({
        file,
        projectId: validation.projectId,
        sessionId,
        sdkToken: activeSdkToken,
        runtimeUrl: configRuntimeUrl,
        sdkWsUrl: deriveDefaultSdkWsUrl(configSdkWsUrl),
      });
    },
    [activeSdkToken, configRuntimeUrl, configSdkWsUrl, sessionId, t, validation],
  );

  const handleEndSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'end_session' }));
  };

  // Play realtime PCM16 audio chunk via AudioContext (streaming, low-latency)
  const playRealtimePCM16 = useCallback((pcm16Bytes: Uint8Array) => {
    // Lazy-init AudioContext on first audio (browser requires user gesture)
    if (!realtimeAudioCtxRef.current) {
      realtimeAudioCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    const ctx = realtimeAudioCtxRef.current;

    // Convert PCM16 (Int16 LE) to Float32
    const int16 = new Int16Array(
      pcm16Bytes.buffer,
      pcm16Bytes.byteOffset,
      pcm16Bytes.byteLength / 2,
    );
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create AudioBuffer and schedule playback
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, realtimeNextPlayTimeRef.current);
    source.start(startTime);
    realtimeNextPlayTimeRef.current = startTime + buffer.duration;
  }, []);

  // Start voice listening (realtime streaming — server handles VAD)
  const startListening = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setVoiceError('Not connected');
      return;
    }

    // Reset realtime playback state
    realtimePlayingRef.current = false;
    realtimeNextPlayTimeRef.current = 0;

    try {
      setVoiceState('connecting');
      setVoiceError(null);

      // Tell server to start voice session
      wsRef.current.send(JSON.stringify({ type: 'voice_start' }));

      // Get microphone access — prefer built-in hardware mic over virtual/disconnected devices.
      // Chrome may default to a disconnected device (e.g. phone mic) that produces silence.
      let stream: MediaStream | null = null;
      const audioConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };

      // First try: default device
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

      // Quick silence check — verify the mic actually produces audio
      const silenceCheck = await (async (s: MediaStream) => {
        const checkCtx = new AudioContext({
          sampleRate: s.getAudioTracks()[0]?.getSettings()?.sampleRate || 48000,
        });
        await checkCtx.resume();
        const src = checkCtx.createMediaStreamSource(s);
        const analyser = checkCtx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        await new Promise((r) => setTimeout(r, 200));
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let maxAbs = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > maxAbs) maxAbs = a;
        }
        src.disconnect();
        checkCtx.close();
        return maxAbs > 0;
      })(stream);

      if (!silenceCheck) {
        // Default mic is silent — try to find a working built-in mic
        stream.getTracks().forEach((t) => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        const builtInMic = devices.find(
          (d) =>
            d.kind === 'audioinput' && d.label.includes('Built-in') && !d.label.includes('Virtual'),
        );
        if (builtInMic) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { ...audioConstraints, deviceId: { exact: builtInMic.deviceId } },
          });
        } else {
          // Fallback: re-acquire default and hope for the best
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        }
      }

      mediaStreamRef.current = stream;

      // Create AudioContext at the mic's hardware sample rate.
      // Chrome's MediaStreamSource produces silence when AudioContext rate
      // differs from the hardware input rate.
      const trackSettings = stream.getAudioTracks()[0]?.getSettings();
      const hwRate = trackSettings?.sampleRate || 48000;
      const audioCtx = new AudioContext({ sampleRate: hwRate });
      audioContextRef.current = audioCtx;
      await audioCtx.resume();
      const captureRate = audioCtx.sampleRate;
      const targetRate = 24000; // OpenAI Realtime expects 24kHz PCM16

      const source = audioCtx.createMediaStreamSource(stream);

      // ScriptProcessorNode to capture raw PCM, resample, and send as base64
      const processor = audioCtx.createScriptProcessor(1024, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);

        // Resample from captureRate to 24kHz using linear interpolation
        let samples: Float32Array;
        if (captureRate === targetRate) {
          samples = float32;
        } else {
          const ratio = captureRate / targetRate;
          const targetLength = Math.round(float32.length / ratio);
          samples = new Float32Array(targetLength);
          for (let i = 0; i < targetLength; i++) {
            const srcIdx = i * ratio;
            const lo = Math.floor(srcIdx);
            const hi = Math.min(lo + 1, float32.length - 1);
            const frac = srcIdx - lo;
            samples[i] = float32[lo] * (1 - frac) + float32[hi] * frac;
          }
        }

        // Convert Float32 -> Int16 (PCM16)
        const pcm16 = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Safe base64 encoding (avoids spread operator stack overflow on large buffers)
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const audioBase64 = btoa(binary);
        wsRef.current.send(JSON.stringify({ type: 'voice_audio', audio: audioBase64 }));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // Required for onaudioprocess to fire
    } catch (error) {
      console.error('Error starting voice:', error);
      setVoiceError(sanitizeError(error, 'Failed to access microphone'));
      setVoiceState('error');
    }
  }, []);

  // Stop voice listening
  const stopListening = useCallback(() => {
    // Stop audio processing
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // Close realtime playback AudioContext
    if (realtimeAudioCtxRef.current) {
      realtimeAudioCtxRef.current.close();
      realtimeAudioCtxRef.current = null;
    }
    realtimePlayingRef.current = false;
    realtimeNextPlayTimeRef.current = 0;

    // Tell server to stop voice session
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'voice_stop' }));
    }

    setVoiceState('idle');
    setVoiceMode(null);
    setTranscript('');
    setVoiceError(null);
  }, []);

  // Keep ref in sync so WS cleanup can access latest stopListening
  stopListeningRef.current = stopListening;

  // Toggle voice
  const toggleVoice = useCallback(() => {
    if (voiceState === 'idle' || voiceState === 'error') {
      startListening();
    } else {
      stopListening();
    }
  }, [voiceState, startListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto mb-4" />
          <p className="text-muted">{t('validating_access')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-error-subtle flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-error" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{t('access_denied')}</h2>
          <p className="text-muted mb-4">{error}</p>
          <p className="text-sm text-subtle">{t('share_link_hint')}</p>
        </div>
      </div>
    );
  }

  if (!validation) return null;

  if (capabilityState && !capabilityState.effectiveMode) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-error-subtle flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-error" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{t('access_denied')}</h2>
          <p className="text-muted mb-4">{t('unsupported_widget_mode')}</p>
          <p className="text-sm text-subtle">{t('share_link_hint')}</p>
        </div>
      </div>
    );
  }

  // Show connection error overlay if there's a connection issue
  if (connectionError && !isConnected) {
    return (
      <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-warning-subtle flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-warning" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{t('connection_error')}</h2>
          <p className="text-foreground mb-2">{connectionError.message}</p>
          <code className="text-xs text-muted bg-background-muted border border-default rounded-md px-2 py-1 inline-block mb-4">
            {connectionError.code}
          </code>
          {connectionError.recoverable ? (
            <button
              onClick={() => void handleOpenWidget()}
              disabled={isConnecting}
              className="px-4 py-2 bg-accent text-white rounded-lg shadow-sm hover:bg-accent/90 transition-colors disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {isConnecting ? t('connecting') : t('retry_connection')}
            </button>
          ) : (
            <p className="text-sm text-subtle">{t('request_new_link')}</p>
          )}
        </div>
      </div>
    );
  }

  const primaryColor = validation.config.theme?.primaryColor || '#2563eb';
  const showVoiceOption = capabilityState?.voiceAvailable ?? false;
  const showModeToggle = capabilityState?.showModeToggle ?? false;
  const widgetPositionClass = resolvePreviewWidgetPositionClass(validation.config.position);

  return (
    <div className="min-h-screen bg-gradient-surface-page">
      {/* Custom animations for voice UI */}
      <style jsx global>{`
        @keyframes soundWave {
          0% {
            transform: scaleY(0.3);
          }
          100% {
            transform: scaleY(1);
          }
        }
        @keyframes audioLevel {
          0%,
          100% {
            height: 20%;
          }
          50% {
            height: 100%;
          }
        }
        @keyframes ringPulse {
          0% {
            transform: scale(1);
            opacity: 0.5;
          }
          100% {
            transform: scale(1.3);
            opacity: 0;
          }
        }
      `}</style>
      {/* Header */}
      <div className="border-b border-default bg-background/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-foreground">{validation.projectName}</h1>
              <p className="text-sm text-muted flex items-center gap-2">
                <Shield className="w-3 h-3 text-success" />
                {t('secure_preview_link')}
              </p>
            </div>
            {hasEverConnected && (
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    isConnected ? 'bg-success-subtle text-success' : 'bg-error-subtle text-error'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-success' : 'bg-error'}`}
                  />
                  {isConnected ? t('connected') : t('disconnected')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Demo content */}
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="bg-background-muted rounded-2xl border border-default/50 p-8 mb-8">
          <h2 className="text-lg font-medium text-foreground mb-4">{t('try_the_agent')}</h2>
          <p className="text-muted mb-4">
            {t('try_agent_description', {
              modes: showVoiceOption ? t('modes_chat_voice') : t('modes_chat'),
            })}
          </p>
          <div className="flex items-center gap-4 text-xs text-subtle">
            <span>
              {t('expires_label', { date: new Date(validation.expiresAt).toLocaleString() })}
            </span>
            {showVoiceOption && (
              <span className="flex items-center gap-1">
                <Mic className="w-3 h-3" /> {t('voice_enabled')}
              </span>
            )}
          </div>
        </div>

        {/* Caller Data Editor — only before first connection */}
        {!hasEverConnected && (
          <div className="bg-background rounded-2xl border border-default/50 p-6 mb-8">
            <div className="flex items-center gap-2 mb-1">
              <Settings2 className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-medium text-foreground">{t('caller_data_title')}</h3>
            </div>
            <p className="text-xs text-muted mb-4">{t('caller_data_description')}</p>

            {/* Existing entries */}
            {Object.keys(callerDataEntries).length > 0 && (
              <div className="mb-3 rounded-lg border border-default overflow-hidden">
                {Object.entries(callerDataEntries).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center gap-1.5 px-3 py-1.5 border-b border-default last:border-b-0 group"
                  >
                    <span className="text-xs font-mono text-accent min-w-0 truncate flex-shrink-0 max-w-[120px]">
                      {key}
                    </span>
                    <span className="text-xs text-subtle">=</span>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) =>
                        setCallerDataEntries((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                      className="flex-1 min-w-0 text-xs font-mono bg-transparent text-foreground outline-none border-b border-transparent focus:border-accent"
                    />
                    <button
                      onClick={() =>
                        setCallerDataEntries((prev) => {
                          const next = { ...prev };
                          delete next[key];
                          return next;
                        })
                      }
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-subtle hover:text-danger transition-default cursor-pointer flex-shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new entry */}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={cdNewKey}
                onChange={(e) => setCdNewKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && cdNewKey.trim()) {
                    e.preventDefault();
                    setCallerDataEntries((prev) => ({ ...prev, [cdNewKey.trim()]: cdNewValue }));
                    setCdNewKey('');
                    setCdNewValue('');
                  }
                }}
                placeholder={t('caller_data_key_placeholder')}
                className="w-28 text-xs font-mono px-2 py-1.5 bg-background-subtle border border-default rounded text-foreground placeholder:text-subtle outline-none focus:border-accent"
              />
              <span className="text-xs text-subtle">=</span>
              <input
                type="text"
                value={cdNewValue}
                onChange={(e) => setCdNewValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && cdNewKey.trim()) {
                    e.preventDefault();
                    setCallerDataEntries((prev) => ({ ...prev, [cdNewKey.trim()]: cdNewValue }));
                    setCdNewKey('');
                    setCdNewValue('');
                  }
                }}
                placeholder={t('caller_data_value_placeholder')}
                className="flex-1 min-w-0 text-xs font-mono px-2 py-1.5 bg-background-subtle border border-default rounded text-foreground placeholder:text-subtle outline-none focus:border-accent"
              />
              <button
                onClick={() => {
                  if (!cdNewKey.trim()) return;
                  setCallerDataEntries((prev) => ({ ...prev, [cdNewKey.trim()]: cdNewValue }));
                  setCdNewKey('');
                  setCdNewValue('');
                }}
                disabled={!cdNewKey.trim()}
                className="p-1.5 rounded text-muted hover:text-foreground hover:bg-background-muted transition-default cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Widget */}
      {isOpen && !isMinimized && (
        <div
          data-testid="share-preview-widget"
          className={`fixed ${widgetPositionClass} w-96 bg-background rounded-2xl shadow-2xl border border-default/50 overflow-hidden flex flex-col`}
          style={{ height: activeWidgetMode === 'voice' ? '320px' : '500px' }}
        >
          {/* Header with mode toggle */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ backgroundColor: primaryColor }}
          >
            <div className="flex items-center gap-2">
              {activeWidgetMode === 'chat' ? (
                <MessageSquare className="w-5 h-5 text-white" />
              ) : (
                <Mic className="w-5 h-5 text-white" />
              )}
              <span className="font-medium text-white">{validation.projectName}</span>
            </div>
            <div className="flex items-center gap-1">
              {/* Mode toggle */}
              {showModeToggle && (
                <div className="flex items-center bg-white/20 rounded-lg p-0.5 mr-2">
                  <button
                    onClick={() => {
                      stopListening();
                      setWidgetMode('chat');
                    }}
                    className={`p-1.5 rounded-md transition-all ${activeWidgetMode === 'chat' ? 'bg-white/30' : 'hover:bg-white/10'}`}
                    title={t('chat_mode')}
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-white" />
                  </button>
                  <button
                    onClick={() => setWidgetMode('voice')}
                    className={`p-1.5 rounded-md transition-all ${activeWidgetMode === 'voice' ? 'bg-white/30' : 'hover:bg-white/10'}`}
                    title={t('voice_mode')}
                  >
                    <Mic className="w-3.5 h-3.5 text-white" />
                  </button>
                </div>
              )}
              {isConnected && !sessionEnded && (
                <button
                  onClick={handleEndSession}
                  className="p-1.5 hover:bg-white/20 rounded-lg"
                  title={t('end_session')}
                >
                  <LogOut className="w-4 h-4 text-white" />
                </button>
              )}
              <button
                onClick={() => setIsMinimized(true)}
                className="p-1.5 hover:bg-white/20 rounded-lg"
              >
                <Minimize2 className="w-4 h-4 text-white" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:bg-white/20 rounded-lg"
              >
                <X className="w-4 h-4 text-white" />
              </button>
            </div>
          </div>

          {/* Chat Mode */}
          {activeWidgetMode === 'chat' && (
            <>
              <BatchConsentGate
                sendMessage={(message) => {
                  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
                  wsRef.current.send(JSON.stringify(message));
                }}
                sessionId={sessionId}
                projectId={validation.projectId}
              >
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <PreviewMessageList
                    messages={messages}
                    isTyping={isTyping}
                    projectId={validation.projectId}
                    onAction={handleActionSubmit}
                    onAuthResponse={handleAuthResponse}
                  />
                  <div ref={messagesEndRef} />
                </div>

                <div className="p-3 border-t border-default">
                  {sessionEnded ? (
                    <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted">
                      <LogOut className="w-4 h-4" />
                      {t('session_ended_message')}
                    </div>
                  ) : (
                    <PreviewChatComposer
                      value={inputText}
                      onValueChange={setInputText}
                      onSend={sendMessage}
                      disabled={!isConnected || sessionEnded}
                      placeholder={validation.config.placeholderText}
                      primaryColor={primaryColor}
                      onUploadFile={
                        isConnected && !sessionEnded && sessionId && activeSdkToken
                          ? handleUploadAttachment
                          : undefined
                      }
                    />
                  )}
                </div>
              </BatchConsentGate>
            </>
          )}

          {/* Voice Mode (Realtime streaming) */}
          {activeWidgetMode === 'voice' && (
            <div className="flex-1 flex flex-col items-center justify-center p-6">
              {/* Voice button with animated rings */}
              <div className="relative">
                {/* Animated pulsing rings when listening */}
                {voiceState === 'listening' && (
                  <>
                    <div className="absolute inset-0 w-24 h-24 rounded-full bg-error/30 animate-ping" />
                    <div
                      className="absolute -inset-3 w-30 h-30 rounded-full border-2 border-error animate-pulse"
                      style={{ width: '120px', height: '120px', left: '-12px', top: '-12px' }}
                    />
                    <div
                      className="absolute -inset-6 rounded-full border border-error"
                      style={{
                        width: '144px',
                        height: '144px',
                        left: '-24px',
                        top: '-24px',
                        animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                      }}
                    />
                  </>
                )}

                {/* Processing animation */}
                {voiceState === 'processing' && (
                  <div
                    className="absolute -inset-3 rounded-full border-2 border-info border-t-info animate-spin"
                    style={{ width: '120px', height: '120px', left: '-12px', top: '-12px' }}
                  />
                )}

                {/* Speaking animation - sound waves */}
                {voiceState === 'speaking' && (
                  <>
                    <div
                      className="absolute -inset-3 rounded-full border-2 border-success"
                      style={{
                        width: '120px',
                        height: '120px',
                        left: '-12px',
                        top: '-12px',
                        animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite',
                      }}
                    />
                    <div
                      className="absolute -inset-6 rounded-full border border-success"
                      style={{
                        width: '144px',
                        height: '144px',
                        left: '-24px',
                        top: '-24px',
                        animation: 'ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite 0.5s',
                      }}
                    />
                  </>
                )}

                <button
                  onClick={toggleVoice}
                  disabled={!isConnected || voiceState === 'connecting'}
                  className={`relative w-24 h-24 rounded-full flex items-center justify-center transition-all shadow-lg ${
                    voiceState === 'listening'
                      ? 'bg-error hover:bg-error-muted'
                      : voiceState === 'connecting'
                        ? 'bg-warning'
                        : voiceState === 'processing'
                          ? 'bg-accent shadow-accent/30'
                          : voiceState === 'speaking'
                            ? 'bg-success'
                            : voiceState === 'error'
                              ? 'bg-error-muted hover:bg-error'
                              : 'bg-background-elevated hover:bg-background-muted hover:shadow-xl'
                  }`}
                  style={
                    voiceState === 'idle'
                      ? {
                          backgroundColor: primaryColor,
                          boxShadow: `0 10px 25px -5px ${primaryColor}40`,
                        }
                      : {}
                  }
                >
                  {voiceState === 'listening' ? (
                    <Mic className="w-10 h-10 text-white animate-pulse" />
                  ) : voiceState === 'connecting' ? (
                    <Loader2 className="w-10 h-10 text-white animate-spin" />
                  ) : voiceState === 'processing' ? (
                    <Loader2 className="w-10 h-10 text-white animate-spin" />
                  ) : voiceState === 'speaking' ? (
                    <Volume2 className="w-10 h-10 text-white animate-pulse" />
                  ) : voiceState === 'error' ? (
                    <AlertCircle className="w-10 h-10 text-white" />
                  ) : (
                    <Mic className="w-10 h-10 text-white" />
                  )}
                </button>
              </div>

              {/* Status text with more prominent styling */}
              <p
                className={`mt-6 text-sm text-center font-medium ${
                  voiceState === 'listening'
                    ? 'text-error'
                    : voiceState === 'processing'
                      ? 'text-accent'
                      : voiceState === 'speaking'
                        ? 'text-success'
                        : 'text-muted'
                }`}
              >
                {voiceState === 'listening' && t('voice_listening')}
                {voiceState === 'connecting' && t('voice_connecting_mic')}
                {voiceState === 'processing' && t('voice_processing')}
                {voiceState === 'speaking' && t('voice_speaking')}
                {voiceState === 'error' && (voiceError || t('voice_error_tap'))}
                {voiceState === 'idle' && t('voice_tap_start')}
              </p>

              {/* Voice info - enhanced listening indicator */}
              {voiceState === 'listening' && (
                <div className="mt-4 px-5 py-3 bg-error-subtle border border-error rounded-xl">
                  <div className="flex items-center gap-3">
                    {/* Audio level bars animation */}
                    <div className="flex items-end gap-0.5 h-4">
                      <div
                        className="w-1 bg-error rounded-full animate-pulse"
                        style={{ height: '40%', animationDelay: '0ms' }}
                      />
                      <div
                        className="w-1 bg-error rounded-full animate-pulse"
                        style={{ height: '80%', animationDelay: '150ms' }}
                      />
                      <div
                        className="w-1 bg-error rounded-full animate-pulse"
                        style={{ height: '60%', animationDelay: '300ms' }}
                      />
                      <div
                        className="w-1 bg-error rounded-full animate-pulse"
                        style={{ height: '100%', animationDelay: '450ms' }}
                      />
                      <div
                        className="w-1 bg-error rounded-full animate-pulse"
                        style={{ height: '50%', animationDelay: '600ms' }}
                      />
                    </div>
                    <span className="text-error text-sm font-medium">{t('recording_active')}</span>
                  </div>
                  <p className="text-error text-xs mt-1">{t('tap_mic_done')}</p>
                </div>
              )}

              {/* Speaking indicator - enhanced */}
              {voiceState === 'speaking' && (
                <div className="mt-4 px-5 py-3 bg-success-subtle border border-success rounded-xl">
                  <div className="flex items-center gap-3">
                    {/* Sound wave animation */}
                    <div className="flex items-center gap-0.5 h-4">
                      <div
                        className="w-1 bg-success rounded-full"
                        style={{
                          height: '30%',
                          animation: 'soundWave 0.5s ease-in-out infinite alternate',
                        }}
                      />
                      <div
                        className="w-1 bg-success rounded-full"
                        style={{
                          height: '60%',
                          animation: 'soundWave 0.5s ease-in-out infinite alternate 0.1s',
                        }}
                      />
                      <div
                        className="w-1 bg-success rounded-full"
                        style={{
                          height: '100%',
                          animation: 'soundWave 0.5s ease-in-out infinite alternate 0.2s',
                        }}
                      />
                      <div
                        className="w-1 bg-success rounded-full"
                        style={{
                          height: '60%',
                          animation: 'soundWave 0.5s ease-in-out infinite alternate 0.3s',
                        }}
                      />
                      <div
                        className="w-1 bg-success rounded-full"
                        style={{
                          height: '30%',
                          animation: 'soundWave 0.5s ease-in-out infinite alternate 0.4s',
                        }}
                      />
                    </div>
                    <span className="text-success text-sm font-medium">
                      {t('agent_responding')}
                    </span>
                  </div>
                  <p className="text-success text-xs mt-1">{t('speak_to_interrupt')}</p>
                </div>
              )}

              {/* Transcript */}
              {transcript && (
                <div className="mt-4 px-4 py-2 bg-background-subtle rounded-xl text-muted text-sm max-w-full">
                  <span className="text-subtle">{t('you_label')}</span>
                  {transcript}
                </div>
              )}

              {/* Last response */}
              {messages.length > 0 && (
                <div className="mt-4 px-4 py-3 bg-background-muted rounded-xl text-muted text-xs max-w-full overflow-hidden">
                  <p className="truncate">
                    Last: {messages[messages.length - 1].content.substring(0, 100)}
                    {messages[messages.length - 1].content.length > 100 && '...'}
                  </p>
                </div>
              )}

              {/* Timing breakdown display */}
              {lastVoiceTiming && voiceState !== 'listening' && voiceState !== 'connecting' && (
                <div className="mt-4 px-3 py-2 bg-background-muted rounded-lg text-xs w-full max-w-xs">
                  <div className="text-muted mb-1 font-medium">{t('last_turn_timing')}</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-subtle">
                    <span>{t('total_label')}</span>
                    <span className="text-muted font-mono">{lastVoiceTiming.total}ms</span>
                    {lastVoiceTiming.turnLatency !== undefined && (
                      <>
                        <span>{t('turn_latency_label')}</span>
                        <span className="text-accent font-mono">
                          {lastVoiceTiming.turnLatency}ms
                        </span>
                      </>
                    )}
                    {lastVoiceTiming.toolCallOverhead !== undefined &&
                      lastVoiceTiming.toolCallOverhead > 0 && (
                        <>
                          <span>{t('tool_calls_label')}</span>
                          <span className="text-purple font-mono">
                            {lastVoiceTiming.toolCallOverhead}ms
                          </span>
                        </>
                      )}
                    {lastVoiceTiming.toolCallOverhead !== undefined &&
                      lastVoiceTiming.toolCallOverhead > 0 && (
                        <>
                          <span>{t('tool_calls_label')}</span>
                          <span className="text-purple font-mono">
                            {lastVoiceTiming.toolCallOverhead}ms
                          </span>
                        </>
                      )}
                  </div>
                </div>
              )}

              {/* Architecture info */}
              <div className="mt-4 text-center text-subtle text-xs">
                <p>{voiceMode === 'realtime' ? t('realtime_voice') : t('voice_preview_label')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {isOpen && isMinimized && (
        <button
          onClick={() => setIsMinimized(false)}
          data-testid="share-preview-widget-minimized"
          className={`fixed ${widgetPositionClass} p-4 rounded-full shadow-2xl`}
          style={{ backgroundColor: primaryColor }}
        >
          {activeWidgetMode === 'chat' ? (
            <MessageSquare className="w-6 h-6 text-white" />
          ) : (
            <Mic className="w-6 h-6 text-white" />
          )}
        </button>
      )}

      {!isOpen && (
        <button
          onClick={handleOpenWidget}
          disabled={isConnecting}
          data-testid="share-preview-widget-launcher"
          className={`fixed ${widgetPositionClass} p-4 rounded-full shadow-2xl disabled:opacity-70`}
          style={{ backgroundColor: primaryColor }}
        >
          {isConnecting ? (
            <Loader2 className="w-6 h-6 text-white animate-spin" />
          ) : (
            <MessageSquare className="w-6 h-6 text-white" />
          )}
        </button>
      )}
    </div>
  );
}

export default function PreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
        </div>
      }
    >
      <PreviewContent />
    </Suspense>
  );
}
