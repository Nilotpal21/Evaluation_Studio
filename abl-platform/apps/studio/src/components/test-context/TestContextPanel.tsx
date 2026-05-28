/**
 * TestContextPanel — Main container for the "Test" debug tab.
 *
 * Collapsible sections for gather fields, session variables, tool mocks,
 * caller context, options, and scenarios.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Eraser, Play } from 'lucide-react';
import clsx from 'clsx';
import { useTranslations } from 'next-intl';

import { Toggle } from '../ui/Toggle';
import { useTestContextStore } from '../../store/test-context-store';
import { useSessionStore } from '../../store/session-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useOptionalWebSocketContext } from '../../contexts/WebSocketContext';

import { GatherFieldEditor } from './GatherFieldEditor';
import { VariableEditor } from './VariableEditor';
import { ToolMockEditor } from './ToolMockEditor';
import { CallerContextEditor } from './CallerContextEditor';
import { ScenarioSelector } from './ScenarioSelector';

export function TestContextPanel() {
  const t = useTranslations('test_context');
  const tPanel = useTranslations('test_context.panel');
  const wsContext = useOptionalWebSocketContext();
  const hasContext = useTestContextStore((s) => s.hasContext);
  const clearContext = useTestContextStore((s) => s.clearContext);
  const getContextPayload = useTestContextStore((s) => s.getContextPayload);
  const skipOnStart = useTestContextStore((s) => s.skipOnStart);
  const setSkipOnStart = useTestContextStore((s) => s.setSkipOnStart);
  const startAtStep = useTestContextStore((s) => s.startAtStep);
  const setStartAtStep = useTestContextStore((s) => s.setStartAtStep);
  const sessionVariables = useTestContextStore((s) => s.sessionVariables);
  const updateSessionVariable = useTestContextStore((s) => s.updateSessionVariable);
  const removeSessionVariable = useTestContextStore((s) => s.removeSessionVariable);
  const agent = useSessionStore((s) => s.agent);
  const sessionAgentName = useSessionStore((s) => s.agent?.name ?? null);
  const projectId = useNavigationStore((s) => s.projectId);
  const routeSubPage = useNavigationStore((s) => s.subPage);
  const agentName = sessionAgentName || routeSubPage;
  const startProjectAgentSession = wsContext?.startProjectAgentSession;
  const isConnected = wsContext?.isConnected ?? false;

  const hasCtx = hasContext();
  const canStartSession = Boolean(
    startProjectAgentSession && isConnected && agentName && projectId,
  );

  // Extract flow steps from IR for "Start at step" dropdown
  const flowSteps = extractFlowSteps(agent?.ir);

  const handleStartWithContext = () => {
    if (!startProjectAgentSession || !agentName || !projectId) {
      return;
    }

    void startProjectAgentSession(agentName, projectId, getContextPayload());
  };

  return (
    <div className="h-full flex flex-col">
      {/* Scenario bar */}
      <div className="px-3 pt-3 pb-1">
        <ScenarioSelector agentPath={agentName || ''} projectId={projectId ?? undefined} />
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {/* Gather Fields */}
        <CollapsibleSection title={t('gather_fields')} defaultOpen>
          <GatherFieldEditor />
        </CollapsibleSection>

        {/* Session Variables */}
        <CollapsibleSection title={t('session_variables')}>
          <VariableEditor
            values={sessionVariables}
            onUpdate={updateSessionVariable}
            onRemove={removeSessionVariable}
            placeholder={t('value_placeholder')}
          />
        </CollapsibleSection>

        {/* Tool Mocks */}
        <CollapsibleSection title={t('tool_mocks')}>
          <ToolMockEditor />
        </CollapsibleSection>

        {/* Caller Context */}
        <CollapsibleSection title={t('caller_context')}>
          <CallerContextEditor />
        </CollapsibleSection>

        {/* Options */}
        <CollapsibleSection title={t('options')}>
          <div className="space-y-2">
            {/* Skip ON_START */}
            <Toggle
              checked={skipOnStart}
              onChange={(checked) => setSkipOnStart(checked)}
              label={tPanel('skip_on_start')}
            />

            {/* Start at step (scripted only) */}
            {flowSteps.length > 0 && (
              <div>
                <label className="text-xs text-subtle">{tPanel('start_at_step')}</label>
                <select
                  value={startAtStep}
                  onChange={(e) => setStartAtStep(e.target.value)}
                  className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground"
                >
                  <option value="">{tPanel('default_entry_point')}</option>
                  {flowSteps.map((step) => (
                    <option key={step} value={step}>
                      {step}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>

      {/* Action buttons (sticky bottom) */}
      <div className="px-3 py-2 border-t border-default bg-background">
        {!wsContext && (
          <p className="mb-2 text-[11px] leading-4 text-muted">{tPanel('live_chat_required')}</p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={handleStartWithContext}
            disabled={!canStartSession}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors',
              hasCtx
                ? 'bg-accent text-accent-foreground hover:opacity-90'
                : 'bg-background-elevated text-muted hover:bg-background-muted',
              !canStartSession && 'opacity-30 cursor-not-allowed',
            )}
          >
            {hasCtx ? <FlaskConical className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {hasCtx ? tPanel('start_with_context') : tPanel('start_chat')}
          </button>
          {hasCtx && (
            <button
              onClick={clearContext}
              className="p-1.5 text-muted hover:text-foreground transition-colors"
              title={tPanel('clear_all_context')}
              aria-label={tPanel('clear_all_context')}
            >
              <Eraser className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function extractFlowSteps(ir: unknown): string[] {
  if (!ir || typeof ir !== 'object') return [];
  const agentIR = ir as Record<string, unknown>;
  const flow = agentIR.flow as Record<string, unknown> | undefined;
  if (!flow?.steps) return [];

  if (Array.isArray(flow.steps)) return flow.steps as string[];

  // steps may be a Record<string, unknown>
  if (typeof flow.steps === 'object') {
    return Object.keys(flow.steps);
  }

  return [];
}

// =============================================================================
// COLLAPSIBLE SECTION
// =============================================================================

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-default rounded">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}
