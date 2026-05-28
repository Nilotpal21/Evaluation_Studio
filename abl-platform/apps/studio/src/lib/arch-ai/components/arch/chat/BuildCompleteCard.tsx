'use client';

/**
 * BuildCompleteCard — interactive widget rendered when the BUILD phase finishes.
 *
 * Appears as an `ask_user` widget with widgetType === 'BuildComplete'.
 * Shows a full agent grid with quality pills and action buttons.
 * Collapses to a compact summary once the user picks an action.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import * as RadixPopover from '@radix-ui/react-popover';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { recordArchStreamLog } from '@/lib/arch-ai/stream-debug';
import { BuildLogActions } from './BuildProgressCard';
import type { BuildCompleteInput, BuildCompleteAgentInfo } from '../widgets/types';

// Info-level warning prefixes — these are informational notes that don't
// affect runtime execution (mirrored from build-completion.ts for client use).
const INFO_PREFIXES = ['W801:', 'W823:', 'W822:', 'W602:'];
const INFO_SUBSTRINGS = ['Normalized REMEMBER target', 'Declared missing persistent memory path'];

function isInfoWarning(w: string): boolean {
  return INFO_PREFIXES.some((p) => w.includes(p)) || INFO_SUBSTRINGS.some((s) => w.includes(s));
}

function splitWarnings(warnings: string[]): { actionable: string[]; info: string[] } {
  const actionable: string[] = [];
  const info: string[] = [];
  for (const w of warnings) {
    if (isInfoWarning(w)) info.push(w);
    else actionable.push(w);
  }
  return { actionable, info };
}

interface BuildCompleteCardProps {
  toolCallId: string;
  input: BuildCompleteInput;
  onSubmit: (answer: unknown) => void;
  answeredResult?: unknown;
  requestId?: string;
}

function truncateType(agentType: string, max = 12): string {
  return agentType.length > max ? agentType.slice(0, max - 1) + '\u2026' : agentType;
}

function QualityPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium',
        active ? 'bg-success/10 text-success' : 'bg-background-muted/50 text-foreground-muted/50',
      )}
    >
      {active ? '✅' : '○'} {label}
    </span>
  );
}

interface AgentDetailPopoverProps {
  agent: BuildCompleteAgentInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (name: string) => void;
  children: React.ReactNode;
}

function AgentDetailPopover({
  agent,
  open,
  onOpenChange,
  onNavigate,
  children,
}: AgentDetailPopoverProps) {
  const { actionable, info } = useMemo(() => splitWarnings(agent.warnings), [agent.warnings]);
  const allWarnings = [...actionable, ...info];
  const [warningsExpanded, setWarningsExpanded] = useState(false);
  const errorCount = agent.errors?.length ?? (agent.error ? 1 : 0);
  const errors = agent.errors ?? (agent.error ? [agent.error] : []);

  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 w-72 rounded-lg border border-border bg-background p-3 text-xs shadow-lg animate-in fade-in-0 zoom-in-95"
        >
          {/* Header */}
          <div className="mb-2">
            <div className="font-semibold text-foreground text-[13px]">{agent.name}</div>
            <div className="text-foreground-muted">{agent.agentType}</div>
          </div>

          {/* Quality badges */}
          <div className="flex flex-wrap gap-1 mb-2">
            <QualityPill label="grd" active={agent.quality.guardrails} />
            <QualityPill label="mem" active={agent.quality.memory} />
            <QualityPill label="err" active={agent.quality.errorHandlers} />
            <QualityPill label="cns" active={agent.quality.constraints} />
            <QualityPill label="hnd" active={agent.quality.catchAllHandoff} />
          </div>

          {/* Counts */}
          <div className="text-foreground-muted mb-2">
            {agent.toolCount} tool{agent.toolCount !== 1 ? 's' : ''} &middot; {agent.handoffCount}{' '}
            handoff{agent.handoffCount !== 1 ? 's' : ''}
          </div>

          {/* Errors */}
          {errorCount > 0 && (
            <div className="mb-2">
              <div className="font-medium text-error mb-1">
                {errorCount} error{errorCount !== 1 ? 's' : ''}
              </div>
              <ul className="space-y-1">
                {errors.map((e, i) => (
                  <li key={i} className="text-error/80 text-[10px] leading-tight">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Warnings — collapsed by default */}
          {allWarnings.length > 0 && (
            <div className="mb-2">
              <button
                onClick={() => setWarningsExpanded(!warningsExpanded)}
                className="text-foreground-muted hover:text-foreground transition-colors"
              >
                {warningsExpanded ? '▾' : '▸'} {allWarnings.length} warning
                {allWarnings.length !== 1 ? 's' : ''}
              </button>
              {warningsExpanded && (
                <ul className="mt-1 space-y-0.5 pl-3">
                  {allWarnings.map((w, i) => (
                    <li key={i} className="text-foreground-muted/70 text-[10px] leading-tight">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Open agent link */}
          <button
            onClick={() => {
              onNavigate(agent.name);
              onOpenChange(false);
            }}
            className="text-accent hover:underline text-[11px]"
          >
            Open {agent.name}.abl.yaml
          </button>

          <RadixPopover.Arrow className="fill-border" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

interface AgentCardProps {
  agent: BuildCompleteAgentInfo;
  isSelected: boolean;
}

function AgentCard({ agent, isSelected }: AgentCardProps) {
  const hasError = agent.status === 'error';
  const errorCount = agent.errors?.length ?? (agent.error ? 1 : 0);

  return (
    <div
      className={clsx(
        'flex flex-col gap-0.5 rounded-md border p-1.5 text-left text-[10px] transition-colors cursor-pointer',
        hasError
          ? 'border-error/30 bg-error/5 hover:bg-error/10'
          : 'border-success/30 bg-success/5 hover:bg-success/10',
        isSelected && 'ring-1 ring-accent',
      )}
    >
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span className="font-medium text-foreground truncate text-[11px]">{agent.name}</span>
        {hasError ? (
          <span className="flex-shrink-0 text-error whitespace-nowrap">
            {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="flex-shrink-0 text-success">✓</span>
        )}
      </div>
      <div className="text-foreground-muted truncate" title={agent.agentType}>
        {truncateType(agent.agentType)} · {agent.toolCount}T · {agent.handoffCount}H
      </div>
    </div>
  );
}

export function BuildCompleteCard({
  toolCallId,
  input,
  onSubmit,
  answeredResult,
  requestId,
}: BuildCompleteCardProps) {
  const { agents, stats, projectName, options, allowCustom, question } = input;
  const [submitted, setSubmitted] = useState(false);
  const [submittedLabel, setSubmittedLabel] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [customText, setCustomText] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const setActiveTab = useArchAIStore((s) => s.setActiveTab);
  const tabs = useArchAIStore((s) => s.artifactTabs);
  const didLogRenderRef = useRef(false);

  useEffect(() => {
    if (answeredResult !== undefined && answeredResult !== null) {
      return;
    }
    if (didLogRenderRef.current) {
      return;
    }
    didLogRenderRef.current = true;
    recordArchStreamLog({
      requestId: requestId ?? `build_complete:${toolCallId}`,
      sessionId: null,
      direction: 'client',
      type: 'build_complete_card_rendered',
      level: 'info',
      data: {
        toolCallId,
        projectName: projectName ?? null,
        totalAgents: stats.total,
        compiledAgents: stats.compiled,
        warningAgents: stats.warnings,
        errorAgents: stats.errors,
        buildElapsedMs: stats.elapsedMs,
      },
    });
  }, [
    answeredResult,
    projectName,
    requestId,
    stats.compiled,
    stats.elapsedMs,
    stats.errors,
    stats.total,
    stats.warnings,
    toolCallId,
  ]);

  const navigateToAgent = useCallback(
    (name: string) => {
      const tab = tabs.find((t) => t.type === 'agent_code' && t.label === name);
      if (tab) setActiveTab(tab.id);
    },
    [tabs, setActiveTab],
  );

  const handleSelect = useCallback(
    (value: string, label: string) => {
      if (submitted) return;
      setSubmitted(true);
      setSubmittedLabel(label);
      onSubmit(value);
    },
    [submitted, onSubmit],
  );

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customText.trim();
    if (trimmed && !submitted) {
      handleSelect(`Custom: ${trimmed}`, trimmed);
    }
  }, [customText, submitted, handleSelect]);

  // Answered state — show compact summary
  if (answeredResult !== undefined && answeredResult !== null) {
    const displayLabel =
      submittedLabel ||
      (typeof answeredResult === 'string'
        ? (options.find((o) => o.value === answeredResult)?.label ?? answeredResult)
        : JSON.stringify(answeredResult));

    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        {displayLabel}
      </div>
    );
  }

  // Submitted (optimistic local state before server echo)
  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        {submittedLabel}
      </div>
    );
  }

  const hasErrors = stats.errors > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={clsx(
        'group relative w-full rounded-lg border p-4',
        hasErrors ? 'border-error/30 bg-error/5' : 'border-success/30 bg-success/5',
      )}
    >
      <BuildLogActions className="absolute right-3 top-3" />
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 pr-12">
        <span
          className={clsx(
            'flex h-6 w-6 items-center justify-center rounded-full text-sm',
            hasErrors ? 'bg-error/10 text-error' : 'bg-success/10 text-success',
          )}
        >
          {hasErrors ? '✗' : '✓'}
        </span>
        <h3 className="text-sm font-semibold text-foreground">
          {hasErrors
            ? `Build Complete — ${stats.compiled} compiled, ${stats.errors} error${stats.errors !== 1 ? 's' : ''}`
            : `Build Complete${projectName ? ` — ${projectName}` : ''}`}
        </h3>
      </div>

      {/* Question */}
      {question && <p className="text-[13px] text-foreground-muted mb-3">{question}</p>}

      {/* Agent grid */}
      {agents.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-3">
          {agents.map((agent) => (
            <AgentDetailPopover
              key={agent.name}
              agent={agent}
              open={selectedAgent === agent.name}
              onOpenChange={(open) => setSelectedAgent(open ? agent.name : null)}
              onNavigate={navigateToAgent}
            >
              <AgentCard agent={agent} isSelected={selectedAgent === agent.name} />
            </AgentDetailPopover>
          ))}
        </div>
      )}

      {/* Stats footer */}
      <div className="mb-3 flex items-center gap-3 text-[11px] text-foreground-muted border-t border-border/30 pt-2">
        <span>
          {stats.total} agent{stats.total !== 1 ? 's' : ''}
        </span>
        <span>·</span>
        <span>
          {stats.toolCount} tool{stats.toolCount !== 1 ? 's' : ''}
        </span>
        <span>·</span>
        <span className={clsx(hasErrors ? 'text-error' : 'text-success')}>
          {hasErrors
            ? `${stats.errors} error${stats.errors !== 1 ? 's' : ''}`
            : 'All agents compiled'}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col gap-2">
        {options.map((option, i) => (
          <button
            key={option.value}
            onClick={() => handleSelect(option.value, option.label)}
            className={clsx(
              'rounded-lg border px-4 py-2.5 text-left text-sm font-medium transition-colors',
              i === 0
                ? 'border-accent bg-accent text-accent-foreground hover:bg-accent-muted'
                : 'border-border hover:border-accent/50 text-foreground/80 hover:bg-background-muted/20',
            )}
          >
            {option.label}
          </button>
        ))}

        {allowCustom && !showCustom && (
          <button
            onClick={() => setShowCustom(true)}
            className="rounded-lg border border-dashed border-border px-4 py-2.5 text-left text-sm text-foreground-muted transition-colors hover:border-accent/50"
          >
            Other...
          </button>
        )}

        {showCustom && (
          <div className="flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCustomSubmit();
                } else if (e.key === 'Escape') {
                  setShowCustom(false);
                }
              }}
              placeholder="Type what you'd like to change..."
              autoFocus
              className="flex-1 rounded-lg border border-accent bg-background px-3 py-2 text-sm outline-none"
            />
            <button
              onClick={handleCustomSubmit}
              disabled={!customText.trim()}
              className="btn-press rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:opacity-50"
            >
              Submit
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
