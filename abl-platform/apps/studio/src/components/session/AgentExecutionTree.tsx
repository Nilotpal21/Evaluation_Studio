/**
 * AgentExecutionTree
 *
 * Agent-centric tree view for the left panel of the session detail page.
 * Groups events by agent instead of by conversation turn, collapses
 * consecutive same-type events, and renders user/assistant messages
 * as full-width dividers between agent blocks.
 */

'use client';

import { useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Bot,
  Cpu,
  Wrench,
  Lightbulb,
  Shield,
  ShieldAlert,
  ArrowRight,
  Users,
  Workflow,
  AlertTriangle,
  MessageSquare,
  XCircle,
  FileSearch,
  PenLine,
  Download,
  Upload,
  Paperclip,
  Phone,
  PhoneOff,
  Mic,
  Volume2,
} from 'lucide-react';
import { useObservatoryStore } from '../../store/observatory-store';
import type { TreeNode } from '../../hooks/useSessionDetail';
import { EmptyState } from '../ui/EmptyState';

interface AgentExecutionTreeProps {
  tree: TreeNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

export function AgentExecutionTree({
  tree,
  selectedNodeId,
  onSelectNode,
}: AgentExecutionTreeProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (tree.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<Bot className="h-6 w-6" />} title="No execution data" className="py-8" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background p-3">
      <div className="space-y-1">
        {tree.map((node, i) => (
          <ExecutionNodeView
            key={node.id || `tree-${i}`}
            node={node}
            depth={0}
            selectedId={selectedNodeId}
            onSelectNode={onSelectNode}
            expandedGroups={expandedGroups}
            setExpandedGroups={setExpandedGroups}
          />
        ))}
      </div>
    </div>
  );
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens: { input: number; output: number } | undefined): string {
  if (!tokens) return '';
  const total = tokens.input + tokens.output;
  return total > 0 ? `${total}tk` : '';
}

// ── Node presentation ──────────────────────────────────────────────────────

function getNodePresentation(node: TreeNode) {
  switch (node.type) {
    case 'agent':
      return {
        icon: <Bot className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'sub_agent':
    case 'delegate_action':
      return {
        icon: <Users className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: '',
      };

    case 'llm_call': {
      const tkStr = formatTokens(node.tokens);
      const durStr = formatDuration(node.latencyMs);
      const parts = [tkStr, durStr].filter(Boolean);
      return {
        icon: <Cpu className="w-3 h-3 text-success" />,
        bgColor: 'bg-success-subtle',
        info: parts.join('  '),
      };
    }

    case 'tool_call':
      return {
        icon: <Wrench className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'attachment_process':
      return {
        icon: <Download className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'attachment_upload':
      return {
        icon: <Upload className="w-3 h-3 text-success" />,
        bgColor: 'bg-success-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'attachment_preprocess':
      return {
        icon: <Paperclip className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'decision':
      return {
        icon: <Lightbulb className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'constraint_check':
      return {
        icon: <Shield className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: node.data?.collapsed ? formatDuration(node.latencyMs) : '',
      };

    case 'guardrail_check':
      return {
        icon: <ShieldAlert className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: node.data?.collapsed ? formatDuration(node.latencyMs) : '',
      };

    case 'handoff':
      return {
        icon: <ArrowRight className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: '',
      };

    case 'flow_step':
      return {
        icon: <Workflow className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'flow_transition':
      return {
        icon: <ArrowRight className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: '',
      };

    case 'escalate':
      return {
        icon: <AlertTriangle className="w-3 h-3 text-error" />,
        bgColor: 'bg-error-subtle',
        info: '',
      };

    case 'error':
      return {
        icon: <XCircle className="w-3 h-3 text-error" />,
        bgColor: 'bg-error-subtle',
        info: '',
      };

    case 'gather_extraction':
      return {
        icon: <FileSearch className="w-3 h-3 text-success" />,
        bgColor: 'bg-success-subtle',
        info: '',
      };

    case 'correction':
      return {
        icon: <PenLine className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: '',
      };

    case 'user_input':
      return {
        icon: <MessageSquare className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: '',
      };

    case 'agent_response':
      return {
        icon: <Bot className="w-3 h-3 text-muted" />,
        bgColor: 'bg-background-muted',
        info: '',
      };

    case 'voice_session_start':
      return {
        icon: <Phone className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_session_end':
      return {
        icon: <PhoneOff className="w-3 h-3 text-muted" />,
        bgColor: 'bg-background-muted',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_turn':
      return {
        icon: <Phone className="w-3 h-3 text-accent" />,
        bgColor: 'bg-accent-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_stt':
      return {
        icon: <Mic className="w-3 h-3 text-info" />,
        bgColor: 'bg-info-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_tts':
      return {
        icon: <Volume2 className="w-3 h-3 text-success" />,
        bgColor: 'bg-success-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_realtime_tool_call':
      return {
        icon: <Wrench className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: formatDuration(node.latencyMs),
      };

    case 'voice_barge_in':
      return {
        icon: <AlertTriangle className="w-3 h-3 text-warning" />,
        bgColor: 'bg-warning-subtle',
        info: formatDuration(node.latencyMs),
      };

    default:
      return {
        icon: <Cpu className="w-3 h-3 text-muted" />,
        bgColor: 'bg-background-muted',
        info: '',
      };
  }
}

// ── Tree node renderer ─────────────────────────────────────────────────────

function ExecutionNodeView({
  node,
  depth,
  selectedId,
  onSelectNode,
  expandedGroups,
  setExpandedGroups,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const [expanded, setExpanded] = useState(depth > 0 && depth < 2);
  const selectSpan = useObservatoryStore((s) => s.selectSpan);
  const setDebugPanelTab = useObservatoryStore((s) => s.setDebugPanelTab);

  const isSelected = selectedId === node.id;
  const isCollapsedGroup = !!node.data?.collapsed;
  const isGroupExpanded = expandedGroups.has(node.id);

  const handleClick = useCallback(() => {
    onSelectNode(node.id);
    if (node.children.length > 0 && !expanded) {
      setExpanded(true);
    }
    // Auto-switch to Overview tab so the selection detail is visible
    if (node.type === 'user_input' || node.type === 'agent_response') {
      setDebugPanelTab('overview');
    }
  }, [expanded, node.children.length, node.id, node.type, onSelectNode, setDebugPanelTab]);

  const handleDoubleClick = useCallback(() => {
    setDebugPanelTab('traces');
    selectSpan(node.spanId ?? null);
  }, [node.spanId, setDebugPanelTab, selectSpan]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  const toggleGroup = useCallback(() => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    onSelectNode(node.id);
  }, [node.id, setExpandedGroups, onSelectNode]);

  // User/assistant message separators — full-width dividers, not indented
  if (node.type === 'user_input') {
    return (
      <div className="my-2 px-2">
        <button
          type="button"
          onClick={handleClick}
          className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-default ${
            isSelected
              ? 'border-accent/30 bg-accent-subtle text-foreground'
              : 'border-transparent bg-background-subtle text-muted hover:border-default hover:text-foreground'
          }`}
        >
          <MessageSquare className="w-3 h-3 text-accent shrink-0" />
          <span className="truncate">{node.label}</span>
        </button>
      </div>
    );
  }

  if (node.type === 'agent_response') {
    return (
      <div className="my-1 px-2">
        <button
          type="button"
          onClick={handleClick}
          className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-default ${
            isSelected
              ? 'border-accent/30 bg-accent-subtle text-foreground'
              : 'border-transparent bg-background-subtle text-subtle hover:border-default hover:text-foreground'
          }`}
        >
          <Bot className="w-3 h-3 text-muted shrink-0" />
          <span className="truncate">{node.label}</span>
        </button>
      </div>
    );
  }

  const { icon, bgColor, info } = getNodePresentation(node);

  // Collapsed group node
  if (isCollapsedGroup && !isGroupExpanded) {
    return (
      <div
        onClick={toggleGroup}
        className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-default ${
          isSelected
            ? 'border-accent/30 bg-accent-subtle text-foreground'
            : 'border-transparent text-muted hover:border-default hover:bg-background-subtle hover:text-foreground'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <button className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-background-muted hover:text-foreground">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className={`rounded-md p-1.5 shrink-0 ${bgColor}`}>{icon}</span>
        <span className="truncate font-medium text-foreground">{node.label}</span>
        {info && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{info}</span>}
      </div>
    );
  }

  // Collapsed group expanded — header + children
  if (isCollapsedGroup && isGroupExpanded) {
    return (
      <div>
        <div
          onClick={toggleGroup}
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-default ${
            isSelected
              ? 'border-accent/30 bg-accent-subtle text-foreground'
              : 'border-transparent text-muted hover:border-default hover:bg-background-subtle hover:text-foreground'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <button className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-background-muted hover:text-foreground">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <span className={`rounded-md p-1.5 shrink-0 ${bgColor}`}>{icon}</span>
          <span className="truncate font-medium text-foreground">{node.label}</span>
          {info && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{info}</span>}
        </div>
        <div>
          {node.children.map((child, i) => (
            <ExecutionNodeView
              key={child.id || `${node.id}-child-${i}`}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelectNode={onSelectNode}
              expandedGroups={expandedGroups}
              setExpandedGroups={setExpandedGroups}
            />
          ))}
        </div>
      </div>
    );
  }

  // Regular node
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        onClick={handleClick}
        onDoubleClick={node.spanId ? handleDoubleClick : undefined}
        className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-sm transition-default ${
          isSelected
            ? 'border-accent/30 bg-accent-subtle text-foreground'
            : 'border-transparent text-muted hover:border-default hover:bg-background-subtle hover:text-foreground'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-background-muted hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <span className="w-4.5 shrink-0" />
        )}

        {/* Icon */}
        <span className={`rounded-md p-1.5 shrink-0 ${bgColor}`}>{icon}</span>

        {/* Label */}
        <span
          className={`truncate font-medium ${
            node.type === 'agent' ? 'text-foreground' : 'text-foreground-muted'
          }`}
        >
          {node.label}
        </span>

        {/* Right-side info */}
        {info && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted">{info}</span>}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child, i) => (
            <ExecutionNodeView
              key={child.id || `${node.id}-child-${i}`}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelectNode={onSelectNode}
              expandedGroups={expandedGroups}
              setExpandedGroups={setExpandedGroups}
            />
          ))}
        </div>
      )}
    </div>
  );
}
