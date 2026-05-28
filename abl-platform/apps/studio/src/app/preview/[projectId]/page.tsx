'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, MessageSquare, X, Minimize2, LogOut } from 'lucide-react';
import { buildSdkWSProtocols } from '@agent-platform/shared/websocket-auth';
import type { ActionSubmitOptions } from '@agent-platform/web-sdk';
import { apiFetch } from '@/lib/api-client';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { deriveDefaultSdkWsUrl } from '@/utils/derive-ws-url';
import { resolveStudioProjectPreviewCapabilityState } from '@/lib/sdk-widget-capabilities';
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

interface WidgetConfig {
  projectId: string;
  projectName: string;
  mode: string;
  position: string;
  theme: {
    primaryColor: string;
    fontFamily: string;
  };
  welcomeMessage: string | null;
  placeholderText: string;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  showActivityUpdates: boolean;
}

type Message = PreviewChatMessage;

interface ProjectDetailsResponse {
  success: boolean;
  project?: {
    name: string;
  };
  errors?: Array<{
    msg?: string;
  }>;
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as
      | { error?: string; errors?: Array<{ msg?: string }> }
      | undefined;

    if (typeof body?.error === 'string' && body.error.trim().length > 0) {
      return body.error;
    }

    const firstError = body?.errors?.[0]?.msg;
    if (typeof firstError === 'string' && firstError.trim().length > 0) {
      return firstError;
    }
  } catch {
    // Fall back to the caller-provided message if the response body is not JSON.
  }

  return fallback;
}

export default function PreviewPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const channelId = searchParams.get('channelId')?.trim() || undefined;
  const { sdkWsUrl: configSdkWsUrl, runtimeUrl: configRuntimeUrl } = useRuntimeConfig();
  const t = useTranslations('preview.project');
  const tPreview = useTranslations('preview');

  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sdkToken, setSdkToken] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const currentResponseRef = useRef<string>('');

  const capabilityState = config ? resolveStudioProjectPreviewCapabilityState(config) : null;

  // Fetch widget config
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const widgetConfigPath = channelId
          ? `/api/sdk/widget/${projectId}?channelId=${encodeURIComponent(channelId)}`
          : `/api/sdk/widget/${projectId}`;
        const [projectResponse, widgetResponse] = await Promise.all([
          apiFetch(`/api/projects/${projectId}`),
          apiFetch(widgetConfigPath),
        ]);

        if (!projectResponse.ok) {
          setError(await readApiErrorMessage(projectResponse, t('widget_not_configured')));
          return;
        }

        if (!widgetResponse.ok) {
          setError(await readApiErrorMessage(widgetResponse, t('widget_not_configured')));
          return;
        }

        const projectBody = (await projectResponse.json()) as ProjectDetailsResponse;
        const widgetBody = (await widgetResponse.json()) as Omit<
          WidgetConfig,
          'projectId' | 'projectName'
        >;
        const resolvedProjectName =
          typeof projectBody.project?.name === 'string' &&
          projectBody.project.name.trim().length > 0
            ? projectBody.project.name
            : t('agent_preview');

        setConfig({
          projectId,
          projectName: resolvedProjectName,
          ...widgetBody,
        });
      } catch {
        setError(t('widget_not_configured'));
      } finally {
        setLoading(false);
      }
    };

    if (projectId) {
      fetchConfig();
    }
  }, [channelId, projectId, t]);

  // Obtain SDK session token and connect to WebSocket
  useEffect(() => {
    if (!config || capabilityState?.effectiveMode !== 'chat') return;

    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      try {
        const res = await apiFetch(`/api/sdk/preview-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(channelId ? { projectId, channelId } : { projectId }),
        });

        if (!res.ok || cancelled) {
          if (!cancelled) {
            setError(await readApiErrorMessage(res, t('failed_sdk_token')));
          }
          return;
        }

        const { sdkToken } = await res.json();
        if (cancelled) return;

        const runtimeWs = deriveDefaultSdkWsUrl(configSdkWsUrl);

        setSdkToken(sdkToken);
        ws = new WebSocket(runtimeWs, buildSdkWSProtocols(sdkToken));
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
              setSessionEnded(false);
              setSessionId(data.sessionId);
              useBatchConsentStore.getState().reset();
              if (config.welcomeMessage) {
                setMessages([
                  {
                    id: 'welcome',
                    role: 'assistant',
                    content: config.welcomeMessage,
                    timestamp: new Date(),
                  },
                ]);
              }
              break;

            case 'response_start':
              setIsTyping(true);
              currentResponseRef.current = '';
              break;

            case 'response_chunk':
              currentResponseRef.current += data.chunk;
              break;

            case 'response_end':
              setIsTyping(false);
              setMessages((prev) => [...prev, buildPreviewAssistantMessage(data, new Date())]);
              currentResponseRef.current = '';
              break;

            case 'error':
              setIsTyping(false);
              appendNotice();
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

            case 'trace_event': {
              if (data.event?.type === 'tool_thought') {
                const thoughtMessage = buildPreviewThoughtMessage(data.event, new Date());
                if (thoughtMessage) {
                  setMessages((prev) => [...prev, thoughtMessage]);
                }
              }
              break;
            }

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
                  const prompt = csatMsg?.value ?? tPreview('agent_transfer_rate_experience');
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
                            ((evt.data?.csatMessage as Record<string, unknown>)
                              ?.userId as string) ??
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
                    content: tPreview('agent_transfer_disconnected'),
                    timestamp: new Date(),
                  },
                ]);
                // Fallback: server injects csatRequired when SmartAssist omits it from the close message
                if (evt.data?.csatRequired) {
                  const prompt = tPreview('agent_transfer_rate_experience');
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
          }
        };

        ws.onerror = () => {
          setIsConnected(false);
          useBatchConsentStore.getState().reset();
        };

        ws.onclose = () => {
          setIsConnected(false);
          useBatchConsentStore.getState().reset();
        };
      } catch {
        if (!cancelled) setError(t('failed_to_connect'));
      }
    };

    connect();

    return () => {
      cancelled = true;
      useBatchConsentStore.getState().reset();
      ws?.close();
    };
  }, [capabilityState?.effectiveMode, channelId, config, projectId, t, configSdkWsUrl]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const sendMessage = (text: string, attachmentIds?: string[]) => {
    const trimmed = text.trim();
    if (
      (!trimmed && (!attachmentIds || attachmentIds.length === 0)) ||
      !wsRef.current ||
      wsRef.current.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    const messageId = `msg_${Date.now()}`;

    // Add user message
    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        role: 'user',
        content:
          trimmed || tPreview('attachments_only_message', { count: attachmentIds?.length ?? 0 }),
        timestamp: new Date(),
      },
    ]);

    // Send to WebSocket
    wsRef.current.send(
      JSON.stringify({
        type: 'chat_message',
        text: trimmed,
        messageId,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      }),
    );
  };

  const submitAction = (actionId: string, value?: string, options?: ActionSubmitOptions) => {
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
  };

  const sendAuthResponse = (toolCallId: string, status: 'completed' | 'cancelled') => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(
      JSON.stringify({
        type: 'auth_response',
        toolCallId,
        status,
      }),
    );
  };

  const handleEndSession = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({ type: 'end_session' }));
  };

  const uploadAttachment = async (file: File) => {
    if (!sdkToken || !sessionId) {
      throw new Error(tPreview('upload_session_not_ready'));
    }

    return uploadPreviewAttachment({
      file,
      projectId,
      sessionId,
      sdkToken,
      runtimeUrl: configRuntimeUrl,
      sdkWsUrl: deriveDefaultSdkWsUrl(configSdkWsUrl),
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="min-h-screen bg-gradient-surface-page flex items-center justify-center">
        <div className="text-center">
          <p className="text-error mb-4">{error}</p>
          <p className="text-subtle text-sm">
            {t('project_id_label')} {projectId}
          </p>
        </div>
      </div>
    );
  }

  if (config && capabilityState?.effectiveMode !== 'chat') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-error mb-4">{t('chat_preview_unavailable')}</p>
          <p className="text-subtle text-sm">
            {t('project_id_label')} {projectId}
          </p>
        </div>
      </div>
    );
  }

  const primaryColor = config?.theme.primaryColor || '#2563eb';

  return (
    <div className="min-h-screen bg-gradient-surface-page">
      {/* Header */}
      <div className="border-b border-default bg-background/50 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                {config?.projectName || t('agent_preview')}
              </h1>
              <p className="text-sm text-muted">{t('live_preview')}</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                  isConnected ? 'bg-success-subtle text-success' : 'bg-error-subtle text-error'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-success' : 'bg-error'}`}
                />
                {isConnected ? tPreview('connected') : tPreview('disconnected')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Demo content area */}
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="bg-background-muted rounded-2xl border border-default/50 p-8 mb-8">
          <h2 className="text-lg font-medium text-foreground mb-4">{t('your_website_content')}</h2>
          <p className="text-muted mb-4">{t('website_preview_description')}</p>
          <p className="text-subtle text-sm">{t('share_url_hint')}</p>
          <code className="block mt-2 p-3 bg-background-subtle rounded-lg text-accent text-sm break-all">
            {typeof window !== 'undefined' ? window.location.href : ''}
          </code>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="bg-background-muted rounded-xl p-4 border border-default/50">
            <span className="text-subtle">{t('project_id_label')}</span>
            <p className="text-foreground font-mono">{projectId}</p>
          </div>
          <div className="bg-background-muted rounded-xl p-4 border border-default/50">
            <span className="text-subtle">{t('session_id_label')}</span>
            <p className="text-foreground font-mono text-xs">{sessionId || t('not_connected')}</p>
          </div>
        </div>
      </div>

      {/* Chat Widget */}
      {isOpen && !isMinimized && (
        <div
          className="fixed bottom-6 right-6 w-96 bg-background rounded-2xl shadow-2xl border border-default/50 overflow-hidden flex flex-col"
          style={{ height: '500px' }}
        >
          {/* Widget Header */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ backgroundColor: primaryColor }}
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-white" />
              <span className="font-medium text-white">
                {config?.projectName || t('chat_label')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isConnected && !sessionEnded ? (
                <button
                  onClick={handleEndSession}
                  className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
                  title={tPreview('end_session')}
                >
                  <LogOut className="w-4 h-4 text-white" />
                </button>
              ) : null}
              <button
                onClick={() => setIsMinimized(true)}
                className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
              >
                <Minimize2 className="w-4 h-4 text-white" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1.5 hover:bg-white/20 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-white" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <BatchConsentGate
            sendMessage={(message) => {
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
              wsRef.current.send(JSON.stringify(message));
            }}
            sessionId={sessionId}
            projectId={projectId}
          >
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <PreviewMessageList
                messages={messages}
                isTyping={isTyping}
                projectId={projectId}
                onAction={submitAction}
                onAuthResponse={sendAuthResponse}
              />
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-3 border-t border-default">
              {sessionEnded ? (
                <div className="flex items-center justify-center gap-2 py-2 text-sm text-muted">
                  <LogOut className="w-4 h-4" />
                  {tPreview('session_ended_message')}
                </div>
              ) : (
                <PreviewChatComposer
                  value={inputText}
                  onValueChange={setInputText}
                  onSend={(text, attachmentIds) => {
                    sendMessage(text, attachmentIds);
                    setInputText('');
                  }}
                  disabled={!isConnected || sessionEnded}
                  placeholder={config?.placeholderText || 'Type a message...'}
                  primaryColor={primaryColor}
                  onUploadFile={
                    isConnected && !sessionEnded && sessionId && sdkToken
                      ? uploadAttachment
                      : undefined
                  }
                />
              )}
            </div>
          </BatchConsentGate>
        </div>
      )}

      {/* Minimized Widget */}
      {isOpen && isMinimized && (
        <button
          onClick={() => setIsMinimized(false)}
          className="fixed bottom-6 right-6 p-4 rounded-full shadow-2xl transition-transform hover:scale-110"
          style={{ backgroundColor: primaryColor }}
        >
          <MessageSquare className="w-6 h-6 text-white" />
        </button>
      )}

      {/* Closed Widget Button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 p-4 rounded-full shadow-2xl transition-transform hover:scale-110"
          style={{ backgroundColor: primaryColor }}
        >
          <MessageSquare className="w-6 h-6 text-white" />
        </button>
      )}
    </div>
  );
}
