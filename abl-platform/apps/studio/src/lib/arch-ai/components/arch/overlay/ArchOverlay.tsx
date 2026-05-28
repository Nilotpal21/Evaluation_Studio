'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Plus, RotateCcw, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { useArchChat } from '@/lib/arch-ai/ui/hook';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { authHeaders } from '@/lib/api-client';
import { normalizeGateRequestAnswer } from '@/lib/arch-ai/gate-request';
import { recordArchStreamLog } from '@/lib/arch-ai/stream-debug';
import { SkeletonChat } from '@/components/ui/Skeleton';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useArchAIStore, ensureJournalFirst } from '@/lib/arch-ai/store/arch-ai-store';
import { ChatInputBar } from '@/components/chat/ChatInputBar';
import { ArchAssistantResponse } from '../chat/ArchAssistantResponse';
import { BuildProgressCard } from '../chat/BuildProgressCard';
import { ScrollToBottomButton } from '../chat/ScrollToBottomButton';
import { WidgetRenderer } from '../widgets';
import { UserFileChips } from '../chat/UserFileChips';
import { SmartWelcome } from './SmartWelcome';
import { InProjectArtifactPanel } from '../panels/InProjectArtifactPanel';
import { ArchSuggestionChips } from '@/components/arch-shared/ArchSuggestionChips';
import { ArchIcon } from '@/components/arch-shared/ArchIcon';
import { KB_CARD_MAP } from '../cards';
import { useComposerAttachments } from '@/lib/arch-ai/hooks/use-composer-attachments';
import {
  archiveSession,
  createSession,
  fetchCurrentSession,
  type InProjectSessionScopeOptions,
} from '@/lib/arch-ai/ui/session-api';
import { useArchUIStore } from '@/lib/arch-ai/ui/store';
import { hasInProjectResumeContent } from './session-resume';
import { shouldRenderToolCallMessage } from '@/lib/arch-ai/ui/widget-visibility';
import { markDiffResolutionInFlight } from '@/lib/arch-ai/ui/proposal-artifacts';
import { buildPageContext } from '@/lib/arch-ai/build-page-context';
import type { WidgetInput } from '../widgets';
import type { ProjectHealthData } from './ProjectHealthBar';
import type { ArchSession } from '@/lib/arch-ai/ui/types';
import type { ArchSuggestion, OverlayState, ProjectSummary } from '@/lib/arch-ai/types/arch';
import type { ResumeSnapshot } from '@agent-platform/arch-ai/types';
import { isBuildExecutionActive } from '@/lib/arch-ai/ui/build-state';

interface ArchOverlayProps {
  projectId: string;
}

const OVERLAY_WIDTHS: Record<Exclude<OverlayState, 'closed'>, string> = {
  chat: 'w-[540px]',
  artifacts: 'w-[85vw]',
  ide: 'w-[90vw]',
};

function resolveArchOverlaySessionScope(): InProjectSessionScopeOptions | undefined {
  const pageContext = buildPageContext();
  if (pageContext?.surface === 'agent-editor' && pageContext.entity?.type === 'agent') {
    const agentName = pageContext.entity.name ?? pageContext.entity.id;
    if (agentName) {
      return { surface: 'agent-editor', agentName };
    }
  }

  return undefined;
}

function withThreadScope(
  scope: InProjectSessionScopeOptions | undefined,
  threadId: string | null | undefined,
): InProjectSessionScopeOptions | undefined {
  if (!threadId) {
    return scope;
  }

  return { ...(scope ?? {}), threadId };
}

function hasActiveProjectSession(projectId: string): boolean {
  const activeSession = useArchUIStore.getState().session;
  return (
    activeSession?.metadata.mode === 'IN_PROJECT' &&
    activeSession.metadata.projectId === projectId &&
    activeSession.state !== 'ARCHIVED' &&
    activeSession.state !== 'COMPLETE'
  );
}

/**
 * ArchOverlay — in-project Arch panel with expandable layout.
 *
 * 3 states:
 * - chat: 540px right panel (default on open)
 * - artifacts: artifact panel + 540px chat (expands to 85vw)
 * - ide: artifact panel + 540px chat (expands to 90vw, no toggle UI)
 *
 * No background dimming — project page stays fully interactive.
 */
export function ArchOverlay({ projectId }: ArchOverlayProps) {
  const t = useTranslations('arch_in_project');
  const {
    messages,
    state: chatState,
    phase,
    error,
    suggestions,
    send,
    sendToolAnswer,
    sendGateResponse,
    session,
    resume,
    loadSession,
    refreshSession,
    clearSession,
    stop,
    retry,
  } = useArchChat();

  const overlayState = useArchAIStore((s) => s.overlayState);
  const closeOverlay = useArchAIStore((s) => s.closeOverlay);
  const setOverlayState = useArchAIStore((s) => s.setOverlayState);
  const addTab = useArchAIStore((s) => s.addTab);
  const artifactTabs = useArchAIStore((s) => s.artifactTabs);
  const prefillMetadata = useArchAIStore((s) => s.prefillMetadata);
  const setPrefillMetadata = useArchAIStore((s) => s.setPrefillMetadata);

  const [initialized, setInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [resumeCandidate, setResumeCandidate] = useState<{
    session: ArchSession;
    resume: ResumeSnapshot | null;
  } | null>(null);
  const [sessionTransitioning, setSessionTransitioning] = useState(false);
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [healthData, setHealthData] = useState<ProjectHealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const currentProjectRef = useRef<string | null>(null);
  const clearComposerAttachmentsRef = useRef<(() => void) | null>(null);
  const { scrollRef, showScrollButton, scrollToBottom, onUserSent } = useAutoScroll(
    messages.length,
    chatState,
  );
  // B05v2: Index of first message with thinkingText (for expanded-first-time behavior)
  const firstThinkingIdx = useMemo(() => messages.findIndex((m) => m.thinkingText), [messages]);

  // BUILD phase: extract topology agent names for BuildProgressCard
  const topologyAgentNames = useMemo(() => {
    const topology = session?.metadata?.topology as
      | { agents?: Array<{ name: string }> }
      | undefined;
    return topology?.agents?.map((a) => a.name) ?? [];
  }, [session?.metadata?.topology]);
  const isBuildPhase = phase === 'BUILD' && topologyAgentNames.length > 0;

  // BUILD phase: derive build progress from store
  const buildStages = useArchAIStore((s) => s.buildStages);
  const isBuildInProgress =
    isBuildPhase &&
    Object.values(buildStages).some((stages) => Object.values(stages).some((s) => s === 'active'));

  const buildPhaseState = useArchAIStore((s) => s.buildState.phase);
  const buildLockActive = isBuildPhase && isBuildExecutionActive(buildPhaseState);
  const resumeGateVisible = !!resumeCandidate;
  const canStartNewSession =
    resumeGateVisible || hasInProjectResumeContent(session, resume ?? null);
  const startNewSessionDisabled =
    !initialized ||
    sessionTransitioning ||
    chatState === 'streaming' ||
    isBuildInProgress ||
    buildLockActive;

  const ensureJournalTab = useCallback(() => {
    const store = useArchAIStore.getState();
    if (!store.artifactTabs.find((tab) => tab.type === 'journal')) {
      store.addTab({ type: 'journal', data: null, label: 'Journal', toolCallId: '' });
    } else {
      useArchAIStore.setState((state) => ({
        artifactTabs: ensureJournalFirst(state.artifactTabs),
      }));
    }
  }, []);

  const handleCloseOverlay = useCallback(() => {
    setShowNewSessionConfirm(false);
    clearComposerAttachmentsRef.current?.();
    closeOverlay();
  }, [closeOverlay]);

  // Load or prepare the IN_PROJECT session — meaningful sessions stay gated until
  // the user explicitly resumes them; blank sessions can be loaded immediately.
  //
  // ABLP-1182 fix: only react to the closed→open transition, not chat↔artifacts
  // panel changes. Streaming events and proposal/diff restores can open the
  // artifact panel automatically; treating that layout change as a lifecycle
  // event re-ran init (clearSession + re-fetch), which turned the active chat
  // into a resume gate.
  const isOverlayOpen = overlayState !== 'closed';

  useEffect(() => {
    let active = true;

    // Detect project change: clear stale state from previous project
    if (currentProjectRef.current && currentProjectRef.current !== projectId) {
      clearSession();
      useArchAIStore.getState().resetProjectState();
      clearComposerAttachmentsRef.current?.();
      setInitialized(false);
      setInitError(null);
      setUploadError(null);
      setSessionError(null);
      setResumeCandidate(null);
      setProjectSummary(null);
      setHealthData(null);
    }
    currentProjectRef.current = projectId;

    if (!isOverlayOpen) {
      return () => {
        active = false;
      };
    }

    if (hasActiveProjectSession(projectId)) {
      setResumeCandidate(null);
      ensureJournalTab();
      setInitialized(true);
      return () => {
        active = false;
      };
    }

    (async () => {
      clearSession();
      useArchAIStore.getState().clearProjectWorkspace();
      const sessionScope = resolveArchOverlaySessionScope();

      let { session: existingSession, resume: existingResume } = await fetchCurrentSession(
        'IN_PROJECT',
        projectId,
        sessionScope,
      );

      if (!active) return;

      const isLegacyStuck =
        existingSession?.state === 'GATE_PENDING' || existingSession?.state === 'COMPLETE';
      if (isLegacyStuck && existingSession?.id) {
        await archiveSession(existingSession.id);
        existingSession = null;
        existingResume = null;
      }

      if (!active) return;

      if (hasInProjectResumeContent(existingSession, existingResume)) {
        setResumeCandidate({
          session: existingSession as ArchSession,
          resume: existingResume,
        });
        setInitialized(true);
      } else {
        setResumeCandidate(null);

        if (!existingSession) {
          await createSession({ mode: 'IN_PROJECT', projectId, ...(sessionScope ?? {}) });
        }

        if (!active) return;

        const loaded = await loadSession('IN_PROJECT', projectId, sessionScope);
        if (loaded) {
          ensureJournalTab();
        }
        setInitialized(true);
      }

      // Fetch project summary for Smart Welcome (non-blocking)
      fetch(`/api/arch-ai/project-summary?projectId=${encodeURIComponent(projectId)}`, {
        headers: authHeaders(),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (active && data?.summary) setProjectSummary(data.summary);
        })
        .catch((err: unknown) => {
          // Advisory — SmartWelcome shows zeros on failure
          const msg = err instanceof Error ? err.message : String(err);
          recordArchStreamLog({
            requestId: crypto.randomUUID(),
            sessionId: session?.id ?? null,
            direction: 'client',
            type: 'overlay_project_summary_failed',
            level: 'warn',
            data: {
              projectId,
              message: msg,
            },
          });
        });
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      recordArchStreamLog({
        requestId: crypto.randomUUID(),
        sessionId: session?.id ?? null,
        direction: 'client',
        type: 'overlay_init_failed',
        level: 'warn',
        data: {
          projectId,
          message,
        },
      });
      if (active) {
        setInitError(message);
        setInitialized(true);
      }
    });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isOverlayOpen]);

  // Fetch proactive health on overlay open
  useEffect(() => {
    if (overlayState === 'closed' || !projectId) return;
    setHealthLoading(true);
    fetch(`/api/arch-ai/project-health?projectId=${encodeURIComponent(projectId)}`, {
      headers: authHeaders(),
    })
      .then((r) => r.json())
      .then((data: ProjectHealthData) => setHealthData(data))
      .catch(() => setHealthData(null))
      .finally(() => setHealthLoading(false));
  }, [overlayState, projectId]);

  useEffect(() => {
    if (overlayState === 'closed') {
      setShowNewSessionConfirm(false);
    }
  }, [overlayState]);

  // Integration tab init: fetch drafts on overlay open and surface a tab if any exist.
  useEffect(() => {
    if (overlayState === 'closed' || !projectId) return;
    if (artifactTabs.some((t) => t.type === 'integration')) return;
    let active = true;
    fetch(`/api/arch-ai/projects/${encodeURIComponent(projectId)}/integration-drafts`, {
      headers: authHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!active || !body) return;
        const drafts = Array.isArray(body.drafts) ? body.drafts : [];
        if (drafts.length > 0) {
          addTab({
            type: 'integration',
            label: 'Integrations',
            data: { count: drafts.length },
            toolCallId: '',
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        recordArchStreamLog({
          requestId: crypto.randomUUID(),
          sessionId: session?.id ?? null,
          direction: 'client',
          type: 'overlay_integration_drafts_fetch_failed',
          level: 'warn',
          data: { projectId, message: msg },
        });
      });
    return () => {
      active = false;
    };
  }, [overlayState, projectId, artifactTabs, addTab, session?.id]);

  // prefillMetadata watcher: handle structured cross-page handoffs.
  useEffect(() => {
    if (!prefillMetadata) return;

    if (prefillMetadata.kind === 'resume_integration' && session?.id) {
      fetch(
        `/api/arch-ai/integration-drafts/${encodeURIComponent(prefillMetadata.draftId)}/resume`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.id }),
        },
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        recordArchStreamLog({
          requestId: crypto.randomUUID(),
          sessionId: session?.id ?? null,
          direction: 'client',
          type: 'overlay_resume_integration_failed',
          level: 'warn',
          data: { draftId: prefillMetadata.draftId, message: msg },
        });
      });
    } else if (prefillMetadata.kind === 'start_integration') {
      const text = prefillMetadata.providerKey
        ? `Set up ${prefillMetadata.providerKey} integration${
            prefillMetadata.targetAgentNames?.length
              ? ` for ${prefillMetadata.targetAgentNames.join(', ')}`
              : ''
          }`
        : 'Help me set up a new integration';
      void send(text);
    }
    // Other kinds (manage_integration, manage_tool, diagnose) — not yet handled.

    setPrefillMetadata(null);
  }, [prefillMetadata, send, setPrefillMetadata, session?.id]);

  const startNewProjectSession = useCallback(async (): Promise<ArchSession | null> => {
    setSessionTransitioning(true);
    setSessionError(null);
    setUploadError(null);

    try {
      clearSession();
      useArchAIStore.getState().clearProjectWorkspace();
      clearComposerAttachmentsRef.current?.();
      setResumeCandidate(null);

      const baseSessionScope = resolveArchOverlaySessionScope();
      const createdSession = await createSession({
        mode: 'IN_PROJECT',
        projectId,
        force: true,
        ...(baseSessionScope ?? {}),
      });
      const sessionScope = withThreadScope(baseSessionScope, createdSession.metadata.threadId);
      const loaded = await loadSession('IN_PROJECT', projectId, sessionScope);
      if (!loaded) {
        throw new Error('Failed to start a new project session.');
      }

      ensureJournalTab();
      return loaded;
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSessionTransitioning(false);
    }
  }, [clearSession, ensureJournalTab, loadSession, projectId]);

  const resumeProjectSession = useCallback(async () => {
    if (!resumeCandidate) {
      return;
    }

    setSessionTransitioning(true);
    setSessionError(null);

    try {
      clearSession();
      useArchAIStore.getState().clearProjectWorkspace();
      const sessionScope = withThreadScope(
        resolveArchOverlaySessionScope(),
        resumeCandidate.session.metadata.threadId,
      );
      const loaded = await loadSession('IN_PROJECT', projectId, sessionScope);
      if (!loaded) {
        throw new Error('This session is no longer available to resume.');
      }

      ensureJournalTab();
      setResumeCandidate(null);
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionTransitioning(false);
    }
  }, [clearSession, ensureJournalTab, loadSession, projectId, resumeCandidate]);

  const ensureWritableProjectSession = useCallback(async (): Promise<ArchSession | null> => {
    if (resumeGateVisible) {
      return startNewProjectSession();
    }

    if (session?.id) {
      return session;
    }

    setSessionTransitioning(true);
    setSessionError(null);

    try {
      const sessionScope = resolveArchOverlaySessionScope();
      const loaded = await loadSession('IN_PROJECT', projectId, sessionScope);
      if (loaded) {
        ensureJournalTab();
        return loaded;
      }

      await createSession({ mode: 'IN_PROJECT', projectId, ...(sessionScope ?? {}) });
      const fresh = await loadSession('IN_PROJECT', projectId, sessionScope);
      if (!fresh) {
        throw new Error('Failed to create a project session.');
      }

      ensureJournalTab();
      return fresh;
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSessionTransitioning(false);
    }
  }, [
    ensureJournalTab,
    loadSession,
    projectId,
    resumeGateVisible,
    session,
    startNewProjectSession,
  ]);

  const requestStartNewSession = useCallback(() => {
    if (canStartNewSession) {
      setShowNewSessionConfirm(true);
      return;
    }

    void startNewProjectSession();
  }, [canStartNewSession, startNewProjectSession]);

  const ensureWritableProjectSessionRef = useRef(ensureWritableProjectSession);
  ensureWritableProjectSessionRef.current = ensureWritableProjectSession;

  const getComposerSessionId = useCallback(async (): Promise<string | null> => {
    const active = await ensureWritableProjectSessionRef.current();
    return active?.id ?? null;
  }, []);

  const {
    composerAttachments,
    handleComposerAttachFiles,
    removeComposerAttachment,
    clearComposerAttachments,
    readyBlobRefs,
  } = useComposerAttachments({ getSessionId: getComposerSessionId });
  clearComposerAttachmentsRef.current = clearComposerAttachments;

  const handleSendWithFiles = useCallback(
    async (text: string, _files: File[]) => {
      const trimmedText = text.trim();
      const hasReadyAttachments = readyBlobRefs.length > 0;
      const hasPendingAttachments = composerAttachments.some(
        (a) => a.status === 'uploading' || a.status === 'processing',
      );
      const hasFailedAttachments = composerAttachments.some((a) => a.status === 'failed');

      if (
        (!trimmedText && !hasReadyAttachments) ||
        hasPendingAttachments ||
        hasFailedAttachments ||
        sessionTransitioning ||
        (chatState !== 'idle' && chatState !== 'widget_pending')
      ) {
        return;
      }

      onUserSent();
      setUploadError(null);
      setSessionError(null);

      try {
        const activeSession = await ensureWritableProjectSession();
        if (!activeSession?.id) {
          return;
        }

        if (hasReadyAttachments) {
          await send(trimmedText, undefined, readyBlobRefs);
          clearComposerAttachments();
        } else {
          await send(trimmedText);
        }
      } catch (err: unknown) {
        setUploadError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      chatState,
      clearComposerAttachments,
      composerAttachments,
      ensureWritableProjectSession,
      onUserSent,
      readyBlobRefs,
      send,
      sessionTransitioning,
    ],
  );

  const handleChipSelect = useCallback(
    (suggestion: ArchSuggestion) => {
      handleSendWithFiles(suggestion.prompt, []);
    },
    [handleSendWithFiles],
  );

  const handleWorkflowSelect = useCallback(
    (prompt: string) => {
      handleSendWithFiles(prompt, []);
    },
    [handleSendWithFiles],
  );

  // Keyboard: Escape to close — only register when overlay is open
  useEffect(() => {
    if (overlayState === 'closed') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleCloseOverlay();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCloseOverlay, overlayState]);

  // Early return for closed state — avoid computing chatPanel JSX
  const isOpen = overlayState !== 'closed';
  const visibleOverlayState =
    resumeGateVisible && overlayState !== 'closed' ? ('chat' as const) : overlayState;
  const showArtifacts =
    !resumeGateVisible && (visibleOverlayState === 'artifacts' || visibleOverlayState === 'ide');
  const panelWidth =
    visibleOverlayState === 'closed' ? OVERLAY_WIDTHS.chat : OVERLAY_WIDTHS[visibleOverlayState];

  // Chat panel (always 480px, always right) — only compute when open
  const chatPanel = !isOpen ? null : (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-4">
          {!initialized ? (
            <SkeletonChat />
          ) : messages.length === 0 ? (
            <SmartWelcome
              projectId={projectId}
              summary={projectSummary}
              onChipSelect={handleChipSelect}
              healthData={healthData}
              healthLoading={healthLoading}
              onWorkflowSelect={handleWorkflowSelect}
              resumeSession={resumeCandidate?.session ?? null}
              resume={resumeCandidate?.resume ?? null}
              onResumeSession={resumeGateVisible ? () => void resumeProjectSession() : undefined}
              onStartNewSession={resumeGateVisible ? requestStartNewSession : undefined}
              resumeActionPending={sessionTransitioning}
              resumeError={resumeGateVisible ? sessionError : null}
            />
          ) : null}

          {/* B05v2: Compute first thinking message index for expanded-first-time behavior */}
          {messages.map((msg, msgIdx) => (
            <div key={msg.id} className="mb-5">
              {msg.role === 'user' ? (
                <div className="flex flex-col items-end gap-1">
                  {msg.rawContent && <UserFileChips blocks={msg.rawContent} />}
                  {msg.content ? (
                    <div className="max-w-[88%] rounded-2xl rounded-tr-md border border-border bg-accent-subtle px-4 py-3 text-[15px] leading-relaxed text-foreground shadow-sm">
                      {msg.content}
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {(msg.content ||
                    msg.activityGroups ||
                    msg.thinkingText ||
                    (msg.isStreaming && !!msg.specialist)) && (
                    <ArchAssistantResponse
                      message={msg}
                      activityGroups={
                        isBuildPhase
                          ? msg.activityGroups?.filter((g) => !/^build[-:]/.test(g.id))
                          : msg.activityGroups
                      }
                      defaultExpanded={msgIdx === firstThinkingIdx}
                      beforeContent={
                        msg.kbCards && msg.kbCards.length > 0 ? (
                          <div className="space-y-2">
                            {msg.kbCards.map((card, ci) => {
                              const CardComponent = KB_CARD_MAP[card.type];
                              if (!CardComponent) return null;
                              return <CardComponent key={`${card.type}-${ci}`} event={card} />;
                            })}
                          </div>
                        ) : null
                      }
                      bodyClassName="max-w-none"
                    />
                  )}
                  {msg.toolCall && shouldRenderToolCallMessage(msg.toolCall, session) && (
                    <WidgetRenderer
                      toolCallId={msg.toolCall.toolCallId}
                      toolName={msg.toolCall.toolName}
                      input={msg.toolCall.input as unknown as WidgetInput}
                      requestId={msg.toolCall.requestId}
                      onSubmit={async (toolCallId, answer, secrets) => {
                        if (msg.toolCall?.toolName === 'gate_request') {
                          const gateAnswer = normalizeGateRequestAnswer(answer);
                          if (gateAnswer) {
                            await sendGateResponse(gateAnswer.action, gateAnswer.feedback);
                            await refreshSession('IN_PROJECT', projectId);
                            return;
                          }
                        }
                        markDiffResolutionInFlight(toolCallId);
                        await sendToolAnswer(toolCallId, answer, secrets);
                      }}
                      answeredResult={msg.toolCall.result}
                    />
                  )}
                </>
              )}
            </div>
          ))}

          {/* BUILD phase: live progress card — visible throughout BUILD, not just while streaming */}
          {isBuildPhase && (
            <div className="my-2">
              <BuildProgressCard topologyAgents={topologyAgentNames} />
            </div>
          )}

          {/* Streaming indicator — visible throughout entire streaming state */}
          {chatState === 'streaming' && (
            <div className="flex items-center gap-2 py-3">
              <span className="font-mono text-xs tracking-widest text-foreground-subtle animate-pulse">
                · · ·
              </span>
              <span className="font-mono text-xs uppercase tracking-wider text-foreground-subtle/60">
                thinking
              </span>
            </div>
          )}

          {/* Suggestion chips — shown after messages when idle */}
          {suggestions.length > 0 && chatState === 'idle' && (
            <div className="py-3">
              <ArchSuggestionChips suggestions={suggestions} onSelect={handleChipSelect} />
            </div>
          )}
        </div>
        <ScrollToBottomButton visible={showScrollButton} onClick={scrollToBottom} />
      </div>

      {/* Error */}
      {(error || initError || uploadError || (!resumeGateVisible && sessionError)) && (
        <div className="mx-4 mb-2 flex items-start gap-2.5 rounded-md border border-error/20 bg-error-subtle/70 px-3 py-2.5 text-xs shadow-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words leading-5 text-error">
            {uploadError ??
              (!resumeGateVisible ? sessionError : null) ??
              error?.message ??
              initError}
          </span>
          {!uploadError && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {error?.recoverable ? (
                <button
                  onClick={retry}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Retry
                </button>
              ) : null}
              <button
                onClick={requestStartNewSession}
                disabled={startNewSessionDisabled}
                className={clsx(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground-muted transition-colors',
                  startNewSessionDisabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-background-muted hover:text-foreground',
                )}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('resume_card_start_new')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 px-6 pb-6 pt-3">
        <ChatInputBar
          showModelLabel={false}
          onSend={handleSendWithFiles}
          attachments={composerAttachments}
          onAttachFiles={(files) => void handleComposerAttachFiles(files)}
          onRemoveAttachment={removeComposerAttachment}
          disabled={
            !initialized ||
            sessionTransitioning ||
            chatState === 'streaming' ||
            isBuildInProgress ||
            buildLockActive ||
            !['idle', 'widget_pending'].includes(chatState)
          }
          disabledReason={
            !initialized
              ? 'connecting'
              : buildLockActive
                ? 'generating'
                : isBuildInProgress
                  ? 'generating'
                  : chatState === 'streaming'
                    ? 'streaming'
                    : undefined
          }
          isStreaming={chatState === 'streaming' || isBuildInProgress || buildLockActive}
          onStop={stop}
          placeholder={
            chatState === 'widget_pending'
              ? 'Or type something else...'
              : resumeGateVisible
                ? t('resume_input_placeholder')
                : chatState === 'idle'
                  ? 'Ask about this project...'
                  : undefined
          }
          ariaLabel="Ask about this project"
          inputTestId="arch-input"
          sendButtonTestId="arch-send"
          footer={
            resumeGateVisible ? (
              <p className="px-1 pt-2 text-[11px] leading-relaxed text-foreground-subtle">
                {t('resume_input_hint')}
              </p>
            ) : null
          }
        />
      </div>
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ x: '100%', opacity: 0.8 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className={clsx(
            'bg-gradient-surface-panel fixed right-0 top-0 z-50 flex h-screen flex-col border-l border-border shadow-xl',
            'transition-[width] duration-200 ease-out',
            panelWidth,
          )}
          // B03: Prevent file-drop browser navigation — without this, dropping a file
          // on the overlay navigates the browser to the file, destroying the page.
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {/* Header */}
          <div className="relative flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-subtle">
                <ArchIcon size={16} />
              </div>
              <span className="text-sm font-semibold tracking-tight text-foreground">Arch</span>
            </div>
            <div className="flex items-center gap-1">
              {canStartNewSession && (
                <button
                  onClick={requestStartNewSession}
                  disabled={startNewSessionDisabled}
                  className={clsx(
                    'mr-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    'border-border text-foreground/70',
                    startNewSessionDisabled
                      ? 'cursor-not-allowed opacity-50'
                      : 'hover:bg-background-muted hover:text-foreground',
                  )}
                >
                  {t('resume_card_start_new')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOverlayState(showArtifacts ? 'chat' : 'artifacts')}
                aria-pressed={showArtifacts}
                data-testid="arch-artifacts-toggle"
                className={clsx(
                  'inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
                  showArtifacts
                    ? 'border-accent/40 bg-accent-subtle text-accent-foreground'
                    : 'border-border bg-background-muted text-foreground-muted hover:bg-background-elevated hover:text-foreground',
                )}
              >
                {showArtifacts ? (
                  <PanelLeftClose className="h-3.5 w-3.5" />
                ) : (
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                )}
                <span>{showArtifacts ? t('hide_artifacts') : t('show_artifacts')}</span>
              </button>
              <button
                data-testid="arch-close"
                onClick={handleCloseOverlay}
                className="rounded-lg p-1.5 text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
                aria-label={t('close')}
                title={t('close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Hairline accent separator */}
            <div className="absolute bottom-0 left-4 right-4 h-px bg-border" />
          </div>

          {/* Content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Artifact panel (visible in artifacts/ide states) */}
            <AnimatePresence>
              {showArtifacts && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 'auto', opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="flex-1 overflow-hidden border-r border-border"
                >
                  <ErrorBoundary>
                    <InProjectArtifactPanel sessionId={session?.id ?? null} projectId={projectId} />
                  </ErrorBoundary>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Chat panel (always 540px on the right) */}
            <div className="w-[540px] flex-shrink-0 overflow-hidden">{chatPanel}</div>
          </div>

          {showNewSessionConfirm && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 px-4">
              <div className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-xl">
                <h3 className="text-base font-semibold text-foreground">
                  {t('resume_start_new_title')}
                </h3>
                <p className="mt-2 text-sm text-foreground/60">{t('resume_start_new_body')}</p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => setShowNewSessionConfirm(false)}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setShowNewSessionConfirm(false);
                      await startNewProjectSession();
                    }}
                    className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-error-foreground transition-opacity hover:opacity-90"
                  >
                    {t('resume_start_new_confirm')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
