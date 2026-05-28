/**
 * ChatWithDebugPanel
 *
 * Three-pane layout: SessionSidebar on the left, ChatPanel in the center,
 * collapsible Observatory DebugTabs on the right with a draggable resize divider.
 */

import { useCallback, useEffect, useRef } from 'react';
import { StudioChatPanel } from './StudioChatPanel';
import { SessionSidebar } from './SessionSidebar';
import { DebugTabs } from '../observatory/DebugTabs';
import { FloatingDebugPanel } from '../observatory/FloatingDebugPanel';
import { useObservatoryStore } from '../../store/observatory-store';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useNavigationStore } from '../../store/navigation-store';
import { useSessionStore } from '../../store/session-store';
import { useTestContextStore } from '../../store/test-context-store';
import { useCallerDataStore } from '../../store/caller-data-store';
import { IsolatedErrorBoundary } from '../ui/IsolatedErrorBoundary';

export function ChatWithDebugPanel() {
  const debugPanelOpen = useObservatoryStore((s) => s.debugPanelOpen);
  const debugPanelWidth = useObservatoryStore((s) => s.debugPanelWidth);
  const debugPanelMode = useObservatoryStore((s) => s.debugPanelMode);
  const toggleDebugPanel = useObservatoryStore((s) => s.toggleDebugPanel);
  const setDebugPanelWidth = useObservatoryStore((s) => s.setDebugPanelWidth);
  const clearObservatoryEvents = useObservatoryStore((s) => s.clearEvents);
  const clearFlow = useObservatoryStore((s) => s.clearFlow);
  const resetMetrics = useObservatoryStore((s) => s.resetMetrics);
  const setStaticGraph = useObservatoryStore((s) => s.setStaticGraph);
  const setAppStaticGraph = useObservatoryStore((s) => s.setAppStaticGraph);
  const { startProjectAgentSession } = useWebSocketContext();
  const projectId = useNavigationStore((s) => s.projectId);
  const agentName = useNavigationStore((s) => s.subPage);
  const chatBoundaryKey = `${projectId ?? ''}:${agentName ?? ''}`;
  const previousScopeRef = useRef<{ projectId: string | null; agentName: string | null } | null>(
    null,
  );

  // Clear stale debug state when navigating to another project or agent. The
  // session and observatory stores are global singletons, so a route transition
  // must reset both transcript and trace panes before the next test starts.
  useEffect(() => {
    const nextScope = {
      projectId: projectId ?? null,
      agentName: agentName ?? null,
    };
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = nextScope;

    if (!previousScope) {
      return;
    }

    const scopeChanged =
      previousScope.projectId !== nextScope.projectId ||
      previousScope.agentName !== nextScope.agentName;
    if (!scopeChanged) {
      return;
    }

    useSessionStore.getState().clearSession();
    clearObservatoryEvents();
    clearFlow();
    resetMetrics();
    setStaticGraph(null);
    setAppStaticGraph(null);
  }, [
    agentName,
    projectId,
    clearFlow,
    clearObservatoryEvents,
    resetMetrics,
    setAppStaticGraph,
    setStaticGraph,
  ]);

  // "New Chat" handler: load agent via WS (creates a fresh session)
  // If test context is configured, uses loadAgentWithContext instead
  const handleNewChat = useCallback(() => {
    const testContextStore = useTestContextStore.getState();
    const context = testContextStore.hasContext()
      ? testContextStore.getContextPayload()
      : undefined;
    const callerDataStore = useCallerDataStore.getState();
    const callerData = callerDataStore.hasEntries() ? callerDataStore.getCallerData() : undefined;
    void startProjectAgentSession(agentName, projectId, context, callerData);
  }, [agentName, projectId, startProjectAgentSession]);

  const dragging = useRef(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;

      const startX = e.clientX;
      const startWidth = debugPanelWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        // Moving left increases width, moving right decreases
        const delta = startX - ev.clientX;
        setDebugPanelWidth(startWidth + delta);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [debugPanelWidth, setDebugPanelWidth],
  );

  return (
    <div className="h-full flex">
      {/* Session sidebar — previous sessions, search */}
      <IsolatedErrorBoundary
        name="Session sidebar"
        resetKey={`session-sidebar:${chatBoundaryKey}`}
        fallbackClassName="h-full w-72 shrink-0 rounded-none border-0 border-r border-default"
      >
        <SessionSidebar onNewChat={handleNewChat} />
      </IsolatedErrorBoundary>

      {/* Chat panel — fills remaining space */}
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <IsolatedErrorBoundary
          name="Chat panel"
          resetKey={`chat-panel:${chatBoundaryKey}`}
          fallbackClassName="h-full rounded-none border-0 bg-background"
        >
          <StudioChatPanel
            onToggleDebug={toggleDebugPanel}
            debugPanelOpen={debugPanelOpen}
            onNewChat={handleNewChat}
          />
        </IsolatedErrorBoundary>
      </div>

      {/* Docked: Resize divider + debug panel */}
      {debugPanelOpen && debugPanelMode === 'docked' && (
        <>
          {/* Divider */}
          <div
            onMouseDown={onMouseDown}
            className="w-1 cursor-col-resize bg-border-default hover:bg-accent transition-colors shrink-0"
          />

          {/* Debug panel */}
          <div
            className="shrink-0 h-full overflow-hidden border-l border-default"
            style={{ width: debugPanelWidth }}
          >
            <IsolatedErrorBoundary
              name="Debug panel"
              resetKey={`debug-panel:${chatBoundaryKey}:${debugPanelMode}`}
              fallbackClassName="h-full rounded-none border-0 bg-background"
            >
              <DebugTabs className="h-full" />
            </IsolatedErrorBoundary>
          </div>
        </>
      )}

      {/* Floating panel */}
      {debugPanelOpen && debugPanelMode === 'floating' && (
        <IsolatedErrorBoundary
          name="Floating debug panel"
          resetKey={`floating-debug:${chatBoundaryKey}`}
          fallbackClassName="fixed bottom-4 right-4 z-50 w-80 rounded-lg shadow-lg"
        >
          <FloatingDebugPanel />
        </IsolatedErrorBoundary>
      )}
    </div>
  );
}
