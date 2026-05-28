'use client';

/**
 * AgentEditorBanners Component
 *
 * Renders 0-N contextual banners stacked vertically between the editor header
 * and body.  All banners share the same neutral base (background-muted) with a
 * 3px semantic left-border accent — no colored backgrounds that impair legibility.
 *
 * Banner types (in render order):
 * 1. DSL issues  — single unified banner for compile errors/warnings AND
 *                  gather/flow visual-editor compatibility notices. All three
 *                  relate to the current DSL and share the "Open DSL" action.
 * 2. Stale / deleted tools  — tools changed since last compile, actionable
 * 3. New tools available    — new project tools, informational
 * 4. Lock status            — another user is editing
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  Eye,
  Lock,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { springs } from '../../lib/animation';
import { useStaleToolCheck } from '../../hooks/useStaleToolCheck';

// ---------------------------------------------------------------------------
// Design tokens — shared across every banner
// ---------------------------------------------------------------------------

/** Structural base — border, padding. Background is set per-severity below. */
const BANNER_BASE = 'border-b border-default px-3 py-2';

/** 3px left accent border */
const ACCENT = {
  error: 'border-l-[3px] border-l-[hsl(var(--color-destructive,0_84%_60%))]',
  warning: 'border-l-[3px] border-l-[hsl(var(--color-warning,38_92%_50%))]',
  muted: 'border-l-[3px] border-l-[hsl(var(--border-default))]',
  none: '',
} as const;

/**
 * Tinted backgrounds — very low opacity (6–8%) so text contrast stays well
 * above WCAG AA.  All text tokens remain neutral; only the canvas gets colour.
 */
const BG = {
  error: 'bg-[hsl(var(--color-destructive,0_84%_60%)/0.07)]',
  warning: 'bg-[hsl(var(--color-warning,38_92%_50%)/0.07)]',
  muted: 'bg-[hsl(var(--background-muted))]',
  none: 'bg-[hsl(var(--background-muted))]',
} as const;

/** Icon colours — isolated from background so contrast is guaranteed */
const ICON_COLOR = {
  error: 'text-[hsl(var(--color-destructive,0_84%_60%))]',
  warning: 'text-[hsl(var(--color-warning,38_92%_50%))]',
  subtle: 'text-subtle',
} as const;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function CountBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-full bg-[hsl(var(--background-elevated))] border border-default px-1.5 min-w-[18px] h-[18px] text-[10px] font-medium text-foreground-secondary tabular-nums leading-none shrink-0">
      {n}
    </span>
  );
}

function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs text-subtle hover:text-foreground-secondary transition-fast"
    >
      {expanded ? 'Hide' : 'Show'}
      <ChevronDown
        className={clsx('w-3 h-3 transition-transform duration-150', expanded && 'rotate-180')}
      />
    </button>
  );
}

function ActionButton({
  onClick,
  icon: Icon,
  label,
  spinning,
  disabled,
}: {
  onClick: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  spinning?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled ?? spinning}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-foreground-secondary bg-[hsl(var(--background-elevated))] border border-default hover:text-foreground transition-fast disabled:opacity-50"
    >
      {Icon && <Icon className={clsx('w-3 h-3', spinning && 'animate-spin')} />}
      {label}
    </button>
  );
}

function DismissButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="p-0.5 rounded text-subtle/60 hover:text-subtle transition-fast"
      aria-label={label}
    >
      <X className="w-3.5 h-3.5" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Compile message grouping
// ---------------------------------------------------------------------------

interface MessageGroup {
  prefix: string;
  messages: string[];
}

function groupCompileMessages(messages: string[]): MessageGroup[] {
  const map = new Map<string, string[]>();
  for (const msg of messages) {
    const colonIdx = msg.indexOf(':');
    const rawPrefix = colonIdx !== -1 ? msg.slice(0, colonIdx).trim() : 'General';
    // Normalise "Line 0", "Line 4", "Line 12" → single "Line" group
    const prefix = /^Line\s+\d+$/i.test(rawPrefix) ? 'Line' : rawPrefix;
    if (!map.has(prefix)) map.set(prefix, []);
    map.get(prefix)!.push(msg);
  }
  return Array.from(map.entries()).map(([prefix, msgs]) => ({ prefix, messages: msgs }));
}

function groupLabel(prefix: string): string {
  if (prefix === 'General') return 'General';
  if (prefix === 'Line') return 'Line warnings';
  if (/^E\d+$/.test(prefix)) return `Code ${prefix}`;
  return prefix;
}

function isProjectConfigurationMessage(message: string): boolean {
  return (
    message.startsWith('Project configuration is not execution-ready:') ||
    message.startsWith('Project runtime config readiness warning:')
  );
}

function allCompileMessagesAreProjectConfigurationWarnings(
  compileMode: 'error' | 'warning' | null,
  messages: string[],
): boolean {
  return (
    compileMode === 'warning' &&
    messages.length > 0 &&
    messages.every(isProjectConfigurationMessage)
  );
}

// ---------------------------------------------------------------------------
// Compatibility warning grouping
// ---------------------------------------------------------------------------

function groupCompatibilityWarnings(
  warnings: string[],
): Array<{ step: string; constructs: string[] }> {
  const map = new Map<string, string[]>();
  for (const w of warnings) {
    const colonIdx = w.indexOf(':');
    const step = colonIdx !== -1 ? w.slice(0, colonIdx).trim() : 'general';
    const rest = colonIdx !== -1 ? w.slice(colonIdx + 1).trim() : w;
    const construct = rest.replace(/\s*is not preserved by the visual editor yet\.?/i, '').trim();
    if (!map.has(step)) map.set(step, []);
    map.get(step)!.push(construct || rest);
  }
  return Array.from(map.entries()).map(([step, constructs]) => ({ step, constructs }));
}

// ---------------------------------------------------------------------------
// CompatDetail — shared step → construct-pills layout
// ---------------------------------------------------------------------------

function CompatDetail({ groups }: { groups: Array<{ step: string; constructs: string[] }> }) {
  return (
    <div className="space-y-1.5">
      {groups.map((g) => (
        <div key={g.step} className="flex items-start gap-2">
          <span className="text-xs font-medium text-foreground-secondary shrink-0 pt-0.5 min-w-[80px] truncate">
            {g.step}
          </span>
          <div className="flex flex-wrap gap-1">
            {g.constructs.map((c, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-full bg-[hsl(var(--background-elevated))] border border-default px-1.5 py-0.5 text-[10px] text-subtle leading-none"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DslIssuesBanner — unified banner for compile messages + compatibility notices
//
// All three categories (compile errors/warnings, gather compat, flow compat)
// relate to the same DSL content and share the same "Open DSL" action.
// Showing them as separate horizontal strips creates visual confusion; instead
// they appear as one banner with collapsible sections inside.
// ---------------------------------------------------------------------------

interface DslIssuesBannerProps {
  /** 'error' | 'warning' | null (null = no compile issues) */
  compileMode: 'error' | 'warning' | null;
  compileMessages: string[];
  gatherWarnings: string[];
  flowWarnings: string[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onDismiss: () => void;
  onOpenDsl?: () => void;
}

function DslIssuesBanner({
  compileMode,
  compileMessages,
  gatherWarnings,
  flowWarnings,
  expanded,
  onToggleExpanded,
  onDismiss,
  onOpenDsl,
}: DslIssuesBannerProps) {
  // Each section is open by default; user can collapse them individually
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  // Sub-groups within the compile section
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const hasCompile = compileMessages.length > 0;
  const hasGather = gatherWarnings.length > 0;
  const hasFlow = flowWarnings.length > 0;
  const sectionCount = [hasCompile, hasGather, hasFlow].filter(Boolean).length;
  const isMultiSection = sectionCount > 1;
  const hasOnlyProjectConfigurationWarnings = allCompileMessagesAreProjectConfigurationWarnings(
    compileMode,
    compileMessages,
  );

  const compileGroups = hasCompile ? groupCompileMessages(compileMessages) : [];
  const gatherGroups = hasGather ? groupCompatibilityWarnings(gatherWarnings) : [];
  const flowGroups = hasFlow ? groupCompatibilityWarnings(flowWarnings) : [];

  // Overall severity drives the left-border accent
  const accentKey: keyof typeof ACCENT =
    compileMode === 'error' ? 'error' : compileMode === 'warning' ? 'warning' : 'muted';

  const LeadIcon =
    compileMode === 'error' ? AlertCircle : compileMode === 'warning' ? AlertTriangle : Eye;
  const leadIconColor =
    compileMode === 'error'
      ? ICON_COLOR.error
      : compileMode === 'warning'
        ? ICON_COLOR.warning
        : ICON_COLOR.subtle;

  // Summary label shown in the header
  const headerLabel = (() => {
    if (!isMultiSection) {
      if (hasCompile) {
        if (hasOnlyProjectConfigurationWarnings) {
          return `Project configuration ${compileMessages.length} warning${compileMessages.length !== 1 ? 's' : ''}`;
        }
        const noun = compileMode === 'error' ? 'error' : 'warning';
        return `ABL ${compileMessages.length} compilation ${noun}${compileMessages.length !== 1 ? 's' : ''}`;
      }
      if (hasGather) {
        return `${gatherGroups.length} gather field${gatherGroups.length !== 1 ? 's' : ''} are view-only`;
      }
      return `${flowGroups.length} flow step${flowGroups.length !== 1 ? 's' : ''} are view-only`;
    }
    return 'ABL issues';
  })();

  function toggleSection(key: string) {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <motion.div
      key="dsl-issues"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={springs.snappy}
      className={clsx(BANNER_BASE, BG[accentKey], ACCENT[accentKey])}
    >
      {/* ── Header row ── */}
      <div className="flex items-center gap-2">
        <LeadIcon className={clsx('w-3.5 h-3.5 shrink-0', leadIconColor)} />

        <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">
          {headerLabel}
        </span>

        {/* Multi-section: compact category pills so you can scan at a glance */}
        {isMultiSection && (
          <div className="flex items-center gap-1.5 shrink-0">
            {hasCompile && (
              <span className="inline-flex items-center gap-0.5">
                <LeadIcon className={clsx('w-3 h-3', leadIconColor)} />
                <CountBadge n={compileMessages.length} />
              </span>
            )}
            {(hasGather || hasFlow) && (
              <span className="inline-flex items-center gap-0.5">
                <Eye className="w-3 h-3 text-subtle" />
                <CountBadge n={gatherGroups.length + flowGroups.length} />
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 shrink-0">
          {onOpenDsl && <ActionButton onClick={onOpenDsl} label="Open ABL" />}
          <ExpandButton expanded={expanded} onToggle={onToggleExpanded} />
          <DismissButton onClick={onDismiss} label="Dismiss ABL issues" />
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="mt-2 border-t border-default pt-2 space-y-0.5">
          {/* ── Compile section ── */}
          {hasCompile && (
            <div>
              <button
                onClick={() => toggleSection('compile')}
                className="flex items-center gap-1.5 w-full text-left py-1"
              >
                <ChevronDown
                  className={clsx(
                    'w-3 h-3 text-subtle/60 transition-transform duration-100 shrink-0',
                    !closedSections.has('compile') && 'rotate-180',
                  )}
                />
                <LeadIcon className={clsx('w-3 h-3 shrink-0', leadIconColor)} />
                <span className="text-xs text-foreground-secondary">
                  {compileMessages.length}{' '}
                  {hasOnlyProjectConfigurationWarnings ? 'project configuration' : 'compilation'}{' '}
                  {compileMode === 'error' ? 'error' : 'warning'}
                  {compileMessages.length !== 1 ? 's' : ''}
                </span>
                <CountBadge n={compileMessages.length} />
              </button>

              {!closedSections.has('compile') && (
                <div className="ml-5 mt-0.5 max-h-[180px] overflow-y-auto space-y-1 pb-1">
                  {compileGroups.length > 1
                    ? compileGroups.map((group) => (
                        <div key={group.prefix}>
                          <button
                            onClick={() => toggleGroup(group.prefix)}
                            className="flex items-center gap-1.5 w-full text-left py-0.5"
                          >
                            <ChevronDown
                              className={clsx(
                                'w-3 h-3 text-subtle/60 transition-transform duration-100 shrink-0',
                                openGroups.has(group.prefix) && 'rotate-180',
                              )}
                            />
                            <span className="text-xs text-foreground-secondary">
                              {groupLabel(group.prefix)}
                            </span>
                            <CountBadge n={group.messages.length} />
                          </button>
                          {openGroups.has(group.prefix) && (
                            <ul className="ml-4 mt-0.5 space-y-0.5">
                              {group.messages.map((msg, i) => (
                                <li
                                  key={i}
                                  className="text-xs text-foreground-secondary break-words leading-relaxed"
                                >
                                  {msg}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))
                    : compileMessages.map((msg, i) => (
                        <p
                          key={i}
                          className="text-xs text-foreground-secondary break-words leading-relaxed"
                        >
                          {msg}
                        </p>
                      ))}
                </div>
              )}
            </div>
          )}

          {/* ── Gather compatibility section ── */}
          {hasGather && (
            <div>
              <button
                onClick={() => toggleSection('gather')}
                className="flex items-center gap-1.5 w-full text-left py-1"
              >
                <ChevronDown
                  className={clsx(
                    'w-3 h-3 text-subtle/60 transition-transform duration-100 shrink-0',
                    !closedSections.has('gather') && 'rotate-180',
                  )}
                />
                <Eye className="w-3 h-3 shrink-0 text-subtle" />
                <span className="text-xs text-foreground-secondary">
                  {gatherGroups.length} gather field{gatherGroups.length !== 1 ? 's' : ''} are
                  view-only
                </span>
                <CountBadge n={gatherGroups.length} />
              </button>

              {!closedSections.has('gather') && (
                <div className="ml-5 mt-0.5 max-h-[160px] overflow-y-auto pb-1">
                  <CompatDetail groups={gatherGroups} />
                </div>
              )}
            </div>
          )}

          {/* ── Flow compatibility section ── */}
          {hasFlow && (
            <div>
              <button
                onClick={() => toggleSection('flow')}
                className="flex items-center gap-1.5 w-full text-left py-1"
              >
                <ChevronDown
                  className={clsx(
                    'w-3 h-3 text-subtle/60 transition-transform duration-100 shrink-0',
                    !closedSections.has('flow') && 'rotate-180',
                  )}
                />
                <Eye className="w-3 h-3 shrink-0 text-subtle" />
                <span className="text-xs text-foreground-secondary">
                  {flowGroups.length} flow step{flowGroups.length !== 1 ? 's' : ''} are view-only
                </span>
                <CountBadge n={flowGroups.length} />
              </button>

              {!closedSections.has('flow') && (
                <div className="ml-5 mt-0.5 max-h-[160px] overflow-y-auto pb-1">
                  <CompatDetail groups={flowGroups} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

// =============================================================================
// PROPS
// =============================================================================

interface AgentEditorBannersProps {
  compileErrors: string[];
  compileWarnings?: string[];
  gatherCompatibilityWarnings?: string[];
  flowCompatibilityWarnings?: string[];
  agentName: string;
  projectId: string;
  onRecompile?: () => void;
  onOpenDsl?: () => void;
  lockedBy?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentEditorBanners({
  compileErrors,
  compileWarnings = [],
  gatherCompatibilityWarnings = [],
  flowCompatibilityWarnings = [],
  agentName,
  projectId,
  onRecompile,
  onOpenDsl,
  lockedBy,
}: AgentEditorBannersProps) {
  // ---------------------------------------------------------------------------
  // Stale tool detection
  // ---------------------------------------------------------------------------
  const { staleTools, deletedTools, newTools } = useStaleToolCheck(projectId, agentName);
  const hasStaleTools = staleTools.length > 0 || deletedTools.length > 0;
  const hasNewTools = newTools.length > 0;

  // ---------------------------------------------------------------------------
  // Derived compile state
  // ---------------------------------------------------------------------------
  const hasCompileErrors = compileErrors.length > 0;
  const compileMessages = hasCompileErrors ? compileErrors : compileWarnings;
  const compileMode: 'error' | 'warning' | null = hasCompileErrors
    ? 'error'
    : compileWarnings.length > 0
      ? 'warning'
      : null;

  // ---------------------------------------------------------------------------
  // DSL banner — unified dismiss + expand state
  // ---------------------------------------------------------------------------
  const [dslDismissed, setDslDismissed] = useState(false);
  const [dslExpanded, setDslExpanded] = useState(false);

  // Reset dismissal whenever any DSL content changes
  const dslKey = [
    compileMode ?? '',
    compileMessages.join('|'),
    gatherCompatibilityWarnings.join('|'),
    flowCompatibilityWarnings.join('|'),
  ].join('::');
  const prevDslKeyRef = useRef(dslKey);
  useEffect(() => {
    if (dslKey !== prevDslKeyRef.current) {
      prevDslKeyRef.current = dslKey;
      setDslDismissed(false);
      setDslExpanded(false);
    }
  }, [dslKey]);

  const hasDslContent =
    compileMessages.length > 0 ||
    gatherCompatibilityWarnings.length > 0 ||
    flowCompatibilityWarnings.length > 0;
  const showDslBanner = hasDslContent && !dslDismissed;

  // ---------------------------------------------------------------------------
  // Tool / lock banner state
  // ---------------------------------------------------------------------------
  const [staleToolsDismissed, setStaleToolsDismissed] = useState(false);
  const [newToolsDismissed, setNewToolsDismissed] = useState(false);

  const showStaleTools = hasStaleTools && !staleToolsDismissed;
  const showNewTools = hasNewTools && !newToolsDismissed;
  const showLock = !!lockedBy;

  // ---------------------------------------------------------------------------
  // Recompile handler
  // ---------------------------------------------------------------------------
  const [isRecompiling, setIsRecompiling] = useState(false);
  const handleRecompile = useCallback(async () => {
    if (!onRecompile || isRecompiling) return;
    setIsRecompiling(true);
    try {
      await Promise.resolve(onRecompile());
    } finally {
      setIsRecompiling(false);
    }
  }, [onRecompile, isRecompiling]);

  // ---------------------------------------------------------------------------
  // Nothing to show
  // ---------------------------------------------------------------------------
  if (!showDslBanner && !showStaleTools && !showNewTools && !showLock) {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="shrink-0">
      <AnimatePresence>
        {/* Banner 1: DSL issues — compile + gather/flow compatibility, unified */}
        {showDslBanner && (
          <DslIssuesBanner
            compileMode={compileMode}
            compileMessages={compileMessages}
            gatherWarnings={gatherCompatibilityWarnings}
            flowWarnings={flowCompatibilityWarnings}
            expanded={dslExpanded}
            onToggleExpanded={() => setDslExpanded((v) => !v)}
            onDismiss={() => setDslDismissed(true)}
            onOpenDsl={onOpenDsl}
          />
        )}

        {/* Banner 2: Stale / deleted tools */}
        {showStaleTools && (
          <motion.div
            key="stale-tools"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={springs.snappy}
            className={clsx(BANNER_BASE, BG.warning, ACCENT.warning)}
          >
            <div className="flex items-center gap-2">
              <Wrench className={clsx('w-3.5 h-3.5 shrink-0', ICON_COLOR.warning)} />
              <span className="text-xs font-medium text-foreground flex-1 min-w-0 truncate">
                Tools may be outdated
              </span>
              <CountBadge n={staleTools.length + deletedTools.length} />
              <span className="text-xs text-subtle hidden sm:block">
                changed since last compile
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {onRecompile && (
                  <ActionButton
                    onClick={handleRecompile}
                    icon={RefreshCw}
                    label={isRecompiling ? 'Recompiling…' : 'Recompile'}
                    spinning={isRecompiling}
                  />
                )}
                <DismissButton
                  onClick={() => setStaleToolsDismissed(true)}
                  label="Dismiss stale tool warning"
                />
              </div>
            </div>
          </motion.div>
        )}

        {/* Banner 3: New tools available */}
        {showNewTools && (
          <motion.div
            key="new-tools"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={springs.snappy}
            className={clsx(BANNER_BASE, BG.none, ACCENT.none)}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 shrink-0 text-subtle" />
              <span className="text-xs text-foreground-secondary flex-1 min-w-0 truncate">
                {newTools.length} new tool{newTools.length !== 1 ? 's' : ''} available in this
                project
                <span className="text-subtle ml-1">— attach to this agent to include</span>
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <DismissButton
                  onClick={() => setNewToolsDismissed(true)}
                  label="Dismiss new tools notice"
                />
              </div>
            </div>
          </motion.div>
        )}

        {/* Banner 4: Lock status */}
        {showLock && (
          <motion.div
            key="lock-status"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={springs.snappy}
            className={clsx(BANNER_BASE, BG.muted, ACCENT.muted)}
          >
            <div className="flex items-center gap-2">
              <Lock className="w-3.5 h-3.5 shrink-0 text-subtle" />
              <span className="text-xs text-foreground-secondary">
                Being edited by <span className="font-medium text-foreground">{lockedBy}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
