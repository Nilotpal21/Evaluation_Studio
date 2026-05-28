'use client';

/**
 * StudioChatHeader — Agent info header for the chat panel.
 *
 * Renders agent name, type/mode badges, tool count, test context indicator,
 * and action buttons (export, debug toggle).
 */

import { useTranslations } from 'next-intl';
import { ArrowLeft, Bot, Download, Bug, FlaskConical } from 'lucide-react';
import type { AgentDetails } from '../../types';
import { formatAgentName } from '../../lib/format/agent-name';

interface StudioChatHeaderProps {
  agent: AgentDetails | null;
  onBackToAgent?: () => void;
  onToggleDebug?: () => void;
  debugPanelOpen?: boolean;
  onExport: () => void;
  hasTestContext: boolean;
  messagesCount: number;
}

function humanizeBadgeLabel(value: string | undefined): string {
  if (!value) return '';
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTargetName(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const target = value.to ?? value.agent ?? value.agentId;
  return typeof target === 'string' && target.trim().length > 0 ? target : null;
}

function getSupervisorRouteCount(ir: unknown): number {
  if (!isRecord(ir)) return 0;

  const targets = new Set<string>();
  const coordination = ir.coordination;
  if (isRecord(coordination) && Array.isArray(coordination.handoffs)) {
    for (const handoff of coordination.handoffs) {
      const target = getTargetName(handoff);
      if (target) targets.add(target);
    }
  }

  const routing = ir.routing;
  if (isRecord(routing)) {
    if (Array.isArray(routing.rules)) {
      for (const rule of routing.rules) {
        const target = getTargetName(rule);
        if (target) targets.add(target);
      }
    }
    if (typeof routing.default_agent === 'string' && routing.default_agent.trim().length > 0) {
      targets.add(routing.default_agent);
    }
  }

  return targets.size;
}

export function StudioChatHeader({
  agent,
  onBackToAgent,
  onToggleDebug,
  debugPanelOpen,
  onExport,
  hasTestContext,
  messagesCount,
}: StudioChatHeaderProps) {
  const t = useTranslations('chat.panel');
  type ChatPanelTranslationKey = Parameters<typeof t>[0];

  if (!agent) return null;

  const resolveBadgeLabel = (prefix: 'agent_type' | 'agent_mode', value: string): string => {
    const key = `${prefix}_${value}` as ChatPanelTranslationKey;
    return t.has(key) ? t(key) : humanizeBadgeLabel(value);
  };

  const directToolCount = agent.toolCount ?? 0;
  const supervisorRouteCount = agent.isSupervisor ? getSupervisorRouteCount(agent.ir) : 0;
  const capabilityLabels = [
    directToolCount > 0 || supervisorRouteCount === 0
      ? t('tools_count', { count: directToolCount })
      : null,
    supervisorRouteCount > 0 ? t('routes_count', { count: supervisorRouteCount }) : null,
  ].filter((label): label is string => Boolean(label));

  return (
    <header className="flex-shrink-0 px-6 py-4 border-b border-default bg-background-subtle glass animate-fade-in-down">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-subtle flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              {formatAgentName(agent.name)}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs px-2 py-0.5 rounded-full bg-background-muted text-muted">
                {resolveBadgeLabel('agent_type', agent.type)}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-background-muted text-muted">
                {resolveBadgeLabel('agent_mode', agent.mode)}
              </span>
              <span className="text-xs text-subtle">{capabilityLabels.join(' · ')}</span>
              {hasTestContext && (
                <span
                  className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent-subtle text-accent"
                  title={t('test_context_active')}
                >
                  <FlaskConical className="w-3 h-3" />
                  {t('test_context')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onBackToAgent && (
            <button
              onClick={onBackToAgent}
              className="px-3 py-2 text-sm text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default btn-press flex items-center gap-2"
              title="Back to agent editor"
            >
              <ArrowLeft className="w-4 h-4 icon-hover" />
              <span className="hidden sm:inline">Back to Agent</span>
            </button>
          )}
          <button
            onClick={onExport}
            disabled={messagesCount === 0}
            className="px-3 py-2 text-sm text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default btn-press disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            title={t('export_transcript')}
          >
            <Download className="w-4 h-4 icon-hover" />
            <span className="hidden sm:inline">{t('export')}</span>
          </button>
          {onToggleDebug && (
            <button
              onClick={onToggleDebug}
              className={`px-3 py-2 text-sm rounded-lg transition-default btn-press flex items-center gap-2 ${
                debugPanelOpen
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:text-foreground hover:bg-background-muted'
              }`}
              title={debugPanelOpen ? t('close_debug_panel') : t('open_debug_panel')}
            >
              <Bug className="w-4 h-4" />
              <span className="hidden sm:inline">{t('debug')}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
