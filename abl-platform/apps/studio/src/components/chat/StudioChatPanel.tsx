'use client';

/**
 * StudioChatPanel — Composes SDK ChatWidget with Studio-specific features.
 *
 * Uses useStudioTransport() to bridge WebSocketContext to SDKTransport,
 * then wraps SDK components in AgentProvider transport mode (Path B).
 *
 * Studio-specific features layered on top of SDK ChatWidget:
 * - StudioChatHeader (agent info, debug toggle, export, reset)
 * - BatchConsentGate (auth preflight consent)
 * - SessionHealthBanner (error/warning counts)
 * - AuthChallengeMessage (JIT auth popup)
 * - i18n bridge (next-intl → SDKStrings)
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertCircle, MessageSquare, Plus } from 'lucide-react';
import { AgentProvider, ChatWidget, useAgent } from '@agent-platform/web-sdk/react';
import type { SDKStrings, SDKTheme } from '@agent-platform/web-sdk/react';
import type {
  ActionSet,
  MessageContentEnvelope,
  MessageMetadata,
  RichContent,
  VoiceConfig,
} from '@agent-platform/web-sdk';

import { useStudioTransport } from '../../adapters/useStudioTransport';
import { useSession } from '../../hooks/useSession';
import { useSessionStore } from '../../store/session-store';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useNavigationStore } from '../../store/navigation-store';
import { useTestContextStore } from '../../store/test-context-store';
import { useObservatoryStore } from '../../store/observatory-store';
import { apiFetch } from '../../lib/api-client';

/**
 * SDK theme that maps to Studio's CSS custom properties.
 * Values use hsl(var(--*)) so they resolve at runtime and respect
 * Studio's dark/light theme toggle.
 */
const studioSDKTheme: Partial<SDKTheme> = {
  primaryColor: 'hsl(var(--accent))',
  primaryHoverColor: 'hsl(var(--accent-muted))',
  backgroundColor: 'hsl(var(--background))',
  surfaceColor: 'hsl(var(--background-elevated))',
  textColor: 'hsl(var(--foreground))',
  textMutedColor: 'hsl(var(--foreground-muted))',
  borderColor: 'hsl(var(--border))',
  userBubbleColor: 'hsl(var(--accent))',
  userBubbleTextColor: 'hsl(var(--accent-foreground))',
  assistantBubbleColor: 'hsl(var(--background-muted))',
  assistantBubbleTextColor: 'hsl(var(--foreground))',
  errorColor: 'hsl(var(--error))',
  warningColor: 'hsl(var(--warning))',
  fontFamily: 'var(--font-sans), system-ui, -apple-system, sans-serif',
  fontSize: '14px',
};

import { StudioChatHeader } from './StudioChatHeader';
import { BatchConsentGate } from '../auth-profiles/BatchConsentGate';
import { SessionHealthBanner } from './SessionHealthBanner';
import { AuthChallengeMessage, parseAuthChallengeData } from './AuthChallengeMessage';
import { CsatRatingCard } from '../preview/CsatRatingCard';
import { Button } from '../ui/Button';

interface StudioChatPanelProps {
  onToggleDebug?: () => void;
  debugPanelOpen?: boolean;
  onNewChat?: () => void;
}

/**
 * Maps Studio's next-intl translation keys to SDKStrings shape.
 */
function useStudioChatStrings(): Partial<SDKStrings> {
  const tInput = useTranslations('chat.input');
  const tMessages = useTranslations('chat.messages');
  const tStreaming = useTranslations('chat.streaming');

  return useMemo(
    (): Partial<SDKStrings> => ({
      sendButton: tInput('send_message'),
      inputPlaceholder: tInput('placeholder_default'),
      typingIndicator: tStreaming('responding'),
      expandThought: tMessages('thought_label'),
      collapseThought: tMessages('thought_label'),
      viewTrace: tMessages('view_trace'),
      errorTitle: tMessages('role_system'),
      warningTitle: tMessages('role_system'),
      attachFile: tInput('attach_file'),
      thinking: tInput('thinking'),
      agentLabel: tMessages('role_agent'),
    }),
    [tInput, tMessages, tStreaming],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionSet(value: unknown): value is ActionSet {
  return isRecord(value) && Array.isArray(value.elements);
}

/**
 * SessionHistoryBridge — renders nothing, but replaces the SDK ChatClient
 * transcript with the authoritative Studio snapshot when the user switches
 * sessions or resume hydration finishes.
 * Must be rendered inside <AgentProvider>.
 *
 * Applies immediately when the SDK ChatClient becomes available for a session
 * and whenever the store replaces its authoritative message snapshot (for
 * example after reconnect resume or historical session restore). Live message
 * updates are intentionally not replayed because the SDK ChatClient already
 * receives them directly from the transport and optimistic local state.
 */
function SessionHistoryBridge() {
  const { chat } = useAgent();
  const sessionId = useSessionStore((s) => s.sessionId);
  const messages = useSessionStore((s) => s.messages);
  const messageSnapshotVersion = useSessionStore((s) => s.messageSnapshotVersion);

  const transcriptItems = useMemo(() => {
    if (!sessionId || messages.length === 0) {
      return [];
    }

    return messages.map((message, idx) => {
      const isSystemMessage = message.role === 'system' || message.role === 'thought';
      const contentEnvelope: MessageContentEnvelope | undefined = message.contentEnvelope
        ? {
            ...(typeof message.contentEnvelope.text === 'string'
              ? { text: message.contentEnvelope.text }
              : {}),
            ...(isRecord(message.contentEnvelope.richContent)
              ? { richContent: message.contentEnvelope.richContent as RichContent }
              : {}),
            ...(isActionSet(message.contentEnvelope.actions)
              ? { actions: message.contentEnvelope.actions }
              : {}),
            ...(isRecord(message.contentEnvelope.voiceConfig)
              ? { voiceConfig: message.contentEnvelope.voiceConfig as VoiceConfig }
              : {}),
            ...(isRecord(message.contentEnvelope.localization)
              ? { localization: message.contentEnvelope.localization }
              : {}),
          }
        : undefined;
      return {
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content,
        ...(contentEnvelope ? { contentEnvelope } : {}),
        channel: isSystemMessage ? ('system' as const) : ('text' as const),
        sourceChannel: isSystemMessage ? ('system' as const) : ('text' as const),
        inputMode: message.role === 'user' ? ('typed' as const) : ('system' as const),
        sequence: idx,
        timestamp:
          message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
        final: true,
      };
    });
  }, [messages, sessionId]);
  const transcriptItemsRef = useRef(transcriptItems);
  transcriptItemsRef.current = transcriptItems;

  useEffect(() => {
    if (!chat) {
      return;
    }

    chat.replaceTranscript(transcriptItemsRef.current);
  }, [chat, messageSnapshotVersion, sessionId]);

  return null;
}

export function StudioChatPanel({
  onToggleDebug,
  debugPanelOpen,
  onNewChat,
}: StudioChatPanelProps) {
  const t = useTranslations('chat.panel');
  const transport = useStudioTransport();
  const strings = useStudioChatStrings();

  const { hasAgent, agent, messages, error, isLoading } = useSession();

  const { send, ensureSessionPersisted, isConnected, isReconnecting, reconnect } =
    useWebSocketContext();
  const agentName = useNavigationStore((s) => s.subPage);
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const sessionId = useSessionStore((s) => s.sessionId);
  const hasTestContext = useTestContextStore((s) => s.hasContext());
  const setDebugPanelOpen = useObservatoryStore((s) => s.setDebugPanelOpen);
  const setDebugPanelTab = useObservatoryStore((s) => s.setDebugPanelTab);

  const handleExport = useCallback(() => {
    const state = useSessionStore.getState();
    if (!state.sessionId || state.messages.length === 0) return;

    const data = {
      sessionId: state.sessionId,
      agent: agent?.name,
      messages: state.messages,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agent?.name || 'session'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [agent?.name]);

  const handleBackToAgent = useCallback(() => {
    if (!projectId || !agentName) return;
    navigate(`/projects/${projectId}/agents/${agentName}`);
  }, [agentName, navigate, projectId]);

  const handleViewTrace = useCallback(
    (metadata: MessageMetadata) => {
      // Open debug panel and switch to traces tab
      setDebugPanelOpen(true);
      setDebugPanelTab('traces');
    },
    [setDebugPanelOpen, setDebugPanelTab],
  );

  const handleUploadFile = useCallback(
    async (file: File): Promise<string> => {
      const currentProjectId = useNavigationStore.getState().projectId;
      const currentSessionId = useSessionStore.getState().sessionId;
      if (!currentProjectId || !currentSessionId) {
        throw new Error('No active project or session for file upload');
      }

      await ensureSessionPersisted(currentSessionId);

      const formData = new FormData();
      formData.append('file', file);

      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(currentProjectId)}/sessions/${encodeURIComponent(currentSessionId)}/attachments`,
        {
          method: 'POST',
          body: formData,
        },
      );

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result = await response.json();
      const attachmentId = result.attachmentId ?? result.id;
      if (!attachmentId) {
        throw new Error('Upload succeeded but server returned no attachment ID');
      }
      return attachmentId;
    },
    [ensureSessionPersisted],
  );

  // --- Detect active auth challenge from messages ---

  const activeAuthChallenge = useMemo(() => {
    // Walk backwards to find the most recent auth challenge
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'system') {
        const challenge = parseAuthChallengeData(msg.content);
        if (challenge) return challenge;
      }
    }
    return null;
  }, [messages]);

  // --- Detect pending CSAT survey from messages ---

  const activeCsatMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].csatData) return messages[i];
    }
    return null;
  }, [messages]);

  const chatWidgetResetKey = useMemo(() => `${sessionId ?? 'no-session'}`, [sessionId]);

  // --- Loading/Error/Empty states (same as ChatPanel) ---

  if (!hasAgent) {
    if (isLoading) {
      return (
        <div
          className="h-full flex flex-col items-center justify-center bg-background p-8"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
          <h2 className="text-lg font-medium text-foreground mb-1">{t('loading_agent')}</h2>
          <p className="text-muted text-sm">{agentName || t('connecting_to_runtime')}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div
          className="h-full flex flex-col items-center justify-center bg-background p-8"
          style={{ fontFamily: 'var(--font-sans)' }}
        >
          <div className="w-16 h-16 rounded-2xl bg-error-subtle flex items-center justify-center mb-6">
            <AlertCircle className="w-8 h-8 text-error" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            {t('failed_to_load_agent')}
          </h2>
          <p className="text-muted text-center max-w-md text-sm leading-relaxed mb-4">
            {typeof error === 'string' ? error : t('failed_to_load_agent')}
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            {!isConnected && (
              <Button
                size="sm"
                onClick={() => {
                  useSessionStore.getState().setError(null);
                  reconnect();
                }}
                disabled={isReconnecting}
              >
                {isReconnecting ? t('reconnecting') : t('retry_connection')}
              </Button>
            )}
            {onNewChat && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  useSessionStore.getState().setError(null);
                  onNewChat();
                }}
                disabled={!isConnected}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                {t('new_chat')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                useSessionStore.getState().setError(null);
              }}
            >
              {t('dismiss')}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="h-full flex flex-col items-center justify-center bg-background p-8"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <div className="w-16 h-16 rounded-2xl bg-accent-subtle flex items-center justify-center mb-6">
          <MessageSquare className="w-8 h-8 text-accent" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">
          {agentName ? t('chat_with_agent', { agentName }) : t('start_conversation')}
        </h2>
        <p className="text-muted text-center max-w-md text-sm leading-relaxed mb-6">
          {t.rich('empty_hint', {
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        {onNewChat && (
          <button
            onClick={onNewChat}
            className="flex items-center gap-2 px-6 py-3 text-sm font-medium bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default btn-press"
          >
            <Plus className="w-4 h-4" />
            {t('new_chat')}
          </button>
        )}
      </div>
    );
  }

  // --- Main chat panel ---

  return (
    <div className="h-full flex flex-col bg-background bg-noise animate-fade-in">
      <StudioChatHeader
        agent={agent}
        onBackToAgent={projectId && agentName ? handleBackToAgent : undefined}
        onToggleDebug={onToggleDebug}
        debugPanelOpen={debugPanelOpen}
        onExport={handleExport}
        hasTestContext={hasTestContext}
        messagesCount={messages.length}
      />

      {/* Error Banner */}
      {error && (
        <div className="flex-shrink-0 px-6 py-3 bg-error-subtle border-b border-error text-error text-sm flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-error animate-pulse" />
          {typeof error === 'string' ? error : t('failed_to_load_agent')}
        </div>
      )}

      <BatchConsentGate sendMessage={send} sessionId={sessionId} projectId={projectId}>
        <>
          <SessionHealthBanner />

          {/* Auth Challenge (inline, above chat) */}
          {activeAuthChallenge && <AuthChallengeMessage data={activeAuthChallenge} />}

          {/* SDK ChatWidget wrapped in AgentProvider (Path B: transport) */}
          <div className="flex-1 min-h-0 flex flex-col">
            <AgentProvider key={chatWidgetResetKey} transport={transport} strings={strings}>
              <SessionHistoryBridge />
              <ChatWidget
                theme={studioSDKTheme}
                onUploadFile={handleUploadFile}
                onViewTrace={handleViewTrace}
              />
            </AgentProvider>
          </div>

          {/* CSAT Survey Card — rendered below ChatWidget when agent requests survey */}
          {activeCsatMessage?.csatData && projectId && (
            <div className="flex-shrink-0 border-t border-default px-4 py-3">
              <CsatRatingCard
                prompt={activeCsatMessage.content}
                csatData={activeCsatMessage.csatData}
                projectId={projectId}
              />
            </div>
          )}
        </>
      </BatchConsentGate>
    </div>
  );
}
