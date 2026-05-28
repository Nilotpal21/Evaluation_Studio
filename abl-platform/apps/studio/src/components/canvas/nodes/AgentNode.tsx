'use client';

import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import {
  Star,
  Wrench,
  ClipboardList,
  AlertTriangle,
  ShieldAlert,
  Network,
  Bot,
  Brain,
  GitBranch,
  Cpu,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useCanvasViewportStore } from '../../../store/canvas-store';
import { NODE_DIMENSIONS_BY_ZOOM } from '../types';
import type { AgentNodeData } from '../types';

const MODEL_PATTERNS: [RegExp, string][] = [
  [/^claude-opus-4[.-]7/, 'Opus 4.7'],
  [/^claude-opus-4[.-]6/, 'Opus 4.6'],
  [/^claude-sonnet-4[.-]6/, 'Sonnet 4.6'],
  [/^claude-haiku-4[.-]5/, 'Haiku 4.5'],
  [/^claude-3[.-]5-sonnet/, 'Sonnet 3.5'],
  [/^claude-3[.-]5-haiku/, 'Haiku 3.5'],
  [/^claude-3-opus/, 'Opus 3'],
  [/^claude-3-sonnet/, 'Sonnet 3'],
  [/^claude-3-haiku/, 'Haiku 3'],
  [/^gpt-4o-mini/, 'GPT-4o Mini'],
  [/^gpt-4o/, 'GPT-4o'],
  [/^gpt-4-turbo/, 'GPT-4 Turbo'],
  [/^gpt-4/, 'GPT-4'],
  [/^o3-mini/, 'o3-mini'],
  [/^o3/, 'o3'],
  [/^o1-mini/, 'o1-mini'],
  [/^o1/, 'o1'],
  [/^gemini-2/, 'Gemini 2'],
  [/^gemini-1\.5-pro/, 'Gemini 1.5 Pro'],
  [/^gemini-1\.5-flash/, 'Gemini 1.5 Flash'],
  [/^gemini-pro/, 'Gemini Pro'],
];

const MAX_MODEL_DISPLAY_LENGTH = 20;

function formatModel(model: string): string {
  for (const [pattern, label] of MODEL_PATTERNS) {
    if (pattern.test(model)) return label;
  }
  return model.length > MAX_MODEL_DISPLAY_LENGTH
    ? model.slice(0, MAX_MODEL_DISPLAY_LENGTH - 1) + '\u2026'
    : model;
}

export type { AgentNodeData };

type AgentNodeType = Node<AgentNodeData, 'agent-node'>;

/**
 * Zoom-level badge visibility:
 *
 *   Zoom >= 0.6 (full):    All badges, goal, model, tool/step counts
 *   Zoom 0.3–0.6 (summary): Name + type/mode badges + entry badge. Goal dimmed. No tools/model/footer.
 *   Zoom < 0.3 (compact):  Only name visible. All badges hidden. Card is a simplified pill.
 *
 * Fixed card dimensions (280x180) at all zoom levels. Content fades with
 * 300ms CSS transitions — no layout shifts.
 */
function AgentNodeComponent({ data, selected }: NodeProps<AgentNodeType>) {
  const semanticLevel = useCanvasViewportStore((s) => s.semanticZoomLevel);
  const isSupervisor = data.agentType === 'supervisor';
  const hasFlow = data.executionMode === 'scripted' || data.executionMode === 'hybrid';
  const isHybrid = data.executionMode === 'hybrid';

  const isCompact = semanticLevel === 'compact';
  const isSummary = semanticLevel === 'summary';
  const isFull = semanticLevel === 'full';
  const dims = NODE_DIMENSIONS_BY_ZOOM[semanticLevel]['agent-node'];

  return (
    <div
      className={clsx(
        'bg-background-elevated border shadow-sm',
        'flex overflow-hidden',
        'transition-shadow duration-300 ease-out',
        'hover:shadow-md hover:-translate-y-0.5 hover:duration-150',
        isCompact ? 'rounded-full items-center' : 'rounded-xl flex-col',
        data.hasErrors && !selected && 'border-error/60',
        !data.hasErrors && !selected && (isSupervisor ? 'border-accent/60' : 'border-default'),
      )}
      style={{
        width: dims.width,
        height: dims.height,
        transition: 'width 300ms ease-out, height 300ms ease-out, box-shadow 300ms ease-out',
        ...(selected
          ? {
              boxShadow:
                '0 0 20px hsl(var(--color-brand-primary) / 0.12), 0 10px 15px -3px rgb(0 0 0 / 0.1)',
            }
          : data.isEntry && !data.hasErrors
            ? {
                boxShadow: '0 0 0 3px hsl(var(--success) / 0.15)',
              }
            : undefined),
        animationDelay: `${(data.rank ?? 0) * 80}ms`,
      }}
      data-entering="true"
      role="button"
      aria-label={`${data.agentType === 'supervisor' ? 'Supervisor' : 'Agent'}: ${data.name}`}
    >
      {selected && (
        <div className="absolute inset-0 rounded-xl ring-2 ring-accent/25 border border-accent pointer-events-none" />
      )}

      {isSupervisor && (
        <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-xl bg-accent" />
      )}

      {data.isEntry && (
        <div
          className="absolute top-2.5 left-2.5 w-[6px] h-[6px] rounded-full bg-success z-10"
          style={{ animation: 'entry-pulse 2s ease-in-out infinite' }}
        />
      )}

      <Handle
        type="target"
        position={Position.Top}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3"
      />

      {/* ── Header: name + entry star ── */}
      {/* Always visible. At compact zoom name is larger to fill the space. */}
      <div
        className={clsx(
          'px-4 shrink-0 flex items-center gap-1.5',
          'transition-all duration-300 ease-out',
          isCompact ? 'pt-0 pb-0 justify-center' : 'pt-3.5 pb-2 border-b border-default/60',
        )}
      >
        {data.isEntry && (
          <Star
            className={clsx(
              'text-warning shrink-0 transition-all duration-300',
              isCompact ? 'w-5 h-5' : 'w-3.5 h-3.5',
            )}
            fill="currentColor"
          />
        )}
        <span
          className={clsx(
            'font-semibold text-foreground truncate transition-all duration-300 ease-out',
            isCompact ? 'text-lg' : 'text-[15px]',
          )}
          title={data.name}
        >
          {data.name}
        </span>
      </div>

      {/* ── Body ── */}
      <div
        className={clsx(
          'px-4 flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden',
          'transition-all duration-300 ease-out',
          isCompact ? 'py-0 opacity-0 max-h-0' : 'py-2',
        )}
      >
        {/* Type + Mode badges: visible at summary + full, hidden at compact */}
        <div
          className={clsx(
            'flex items-center gap-1.5 flex-wrap shrink-0',
            'transition-all duration-300 ease-out',
            isCompact ? 'opacity-0 max-h-0 py-0' : 'opacity-100 max-h-8',
          )}
        >
          <span
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
              isSupervisor
                ? 'bg-accent-subtle text-accent'
                : 'bg-background-muted text-foreground-muted border border-default',
            )}
          >
            {isSupervisor ? <Network className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
            {isSupervisor ? 'Supervisor' : 'Agent'}
          </span>
          <span
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium',
              isHybrid
                ? 'bg-accent-subtle text-accent'
                : hasFlow
                  ? 'bg-success-subtle text-success'
                  : 'bg-purple-subtle text-purple',
            )}
          >
            {isHybrid ? (
              <>
                <Brain className="w-3 h-3" />
                Mixed
              </>
            ) : hasFlow ? (
              <>
                <GitBranch className="w-3 h-3" />
                Flow
              </>
            ) : (
              <>
                <Brain className="w-3 h-3" />
                Reasoning
              </>
            )}
          </span>
          {data.isEntry && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-medium bg-success-subtle text-success">
              Entry
            </span>
          )}
          {data.hasEscalation && (
            <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-medium bg-warning-subtle text-warning">
              <ShieldAlert className="w-3 h-3" />
            </span>
          )}
        </div>

        {/* Goal text: visible at full, hidden at summary + compact */}
        <p
          className={clsx(
            'text-[13px] text-foreground line-clamp-2 leading-relaxed',
            'transition-all duration-300 ease-out',
            isFull ? 'opacity-100 max-h-10' : 'opacity-0 max-h-0',
          )}
          title={data.goal}
        >
          {data.goal || '\u00A0'}
        </p>

        {/* Error indicator — always visible when present */}
        {data.hasErrors && (
          <div className="flex items-center gap-1 text-xs text-error font-medium shrink-0">
            <AlertTriangle className="w-3 h-3" />
            {data.errorCount} error{data.errorCount !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* ── Footer: model + tool/step counts ── */}
      {/* Only visible at full zoom (>= 0.7). Hidden at summary and compact. */}
      <div
        className={clsx(
          'px-4 pb-2.5 pt-2 border-t border-default/50 bg-background-muted/30 shrink-0',
          'transition-all duration-300 ease-out',
          isFull ? 'opacity-100' : 'opacity-0',
        )}
      >
        <div className="flex items-center gap-3 text-xs text-foreground-muted">
          {data.model && (
            <span className="flex items-center gap-1 text-purple">
              <Cpu className="w-3 h-3" />
              <span className="truncate">{formatModel(data.model)}</span>
            </span>
          )}
          {data.toolCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Wrench className="w-3 h-3" />
              {data.toolCount} tool{data.toolCount !== 1 ? 's' : ''}
            </span>
          )}
          {data.gatherFieldsCount > 0 && (
            <span className="flex items-center gap-0.5">
              <ClipboardList className="w-3 h-3" />
              {data.gatherFieldsCount} field{data.gatherFieldsCount !== 1 ? 's' : ''}
            </span>
          )}
          {data.stepCount > 0 && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="w-3 h-3" />
              {data.stepCount} step{data.stepCount !== 1 ? 's' : ''}
            </span>
          )}
          {!data.model &&
            data.toolCount === 0 &&
            data.gatherFieldsCount === 0 &&
            data.stepCount === 0 && (
              <span className="text-foreground-subtle">No tools or fields</span>
            )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3"
      />
    </div>
  );
}

export const AgentNodeMemo = memo(AgentNodeComponent);
